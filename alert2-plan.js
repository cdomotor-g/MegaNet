// MegaNet — alert2-plan.js
//
//   Alert2Plan   the ALERT2 Transition Plan tab, listed to the people the owner
//                nominates and nobody else: a draft for management of what
//                moving the network from ALERT to ALERT2 takes — the equipment
//                and how much of it, where the work is by region and catchment,
//                the network reviews, the backbone repeaters to acquire, audit,
//                retrofit or rebuild first, the cut-over of each catchment
//                onto an ALERT2 backbone in concentration mode, the timeline,
//                the effort in FTE and the cost — every figure worked from the
//                station register as it is loaded, under a scenario card whose
//                sliders and switches re-run the whole plan as they move.
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
// The owner asked for this tab to be seen only by the people they nominate —
// themselves alone, to begin with — so the database keeps a list (0076), and
// TABS marks the tab `who: 'a2plan'`: the nav, the find box, Ctrl+K, the views
// and the Site Map all leave it out for anybody not on it, administrators
// included (tabShown, core.js; Auth.a2plan(), whoami()'s answer). A database
// before 0076 has no list, and there it is still every administrator's.
// Opened by its address it says who it is for and shows nothing more. Like
// Network Review, everything it reads is readable without signing in — the
// register, the SLS, the basins — so this is about who the page is for, not
// the security of any datum. The plan's own words are in this file, and this
// repository is public: anything that must stay private (a negotiated price,
// a name) belongs in the database behind meganet.is_a2plan_member(), not here.
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
//                acquisition; then, catchment by catchment, condition audits,
//                retrofits, structural rebuilds and the ALERT2 fit-out of the
//                repeaters each catchment needs; the pilot, the bases, field
//                crews catchment by catchment, close-out), each consuming its
//                own capacity, the field lanes slowed in the wet season. Out
//                of it come the dates, the person-days by role and the costs
//                by month, which the FTE profile and the financial-year cash
//                flow are sums of. Pure: inventory and scenario in, plan out.
//
// ── The backbone, catchment by catchment ─────────────────────────────────────
// A catchment comes onto ALERT2 in one step on the backbone, before any of its
// field stations is touched: every repeater that hears one of its stations is
// fitted with an ERT-A2 as a concentrator (it hears legacy ALERT and sends it
// on in its own ALERT2 slot), every repeater from there to a base is fitted to
// repeat ALERT2 — an ALERT1 repeater cannot carry it — and the base receives
// ALERT2. Those repeaters are what the catchment "needs"; one already done for
// an earlier catchment is not done again. Each site is first audited unless
// the card says what it needs: a fit-out only, a retrofit (power, antenna,
// enclosure, earthing, access), or the structure itself rebuilt (mast or
// tower, footings, shelter), which needs a design and approvals first and a
// temporary repeater while it is down. An unassessed site is costed at the
// card's mix, allotted catchment by catchment so the totals are whole sites.
//   the page     the plan as a document for management, every number read
//                off the model, with the scenario card above it.
//
// The model is an estimate and says so on every page it draws. Its defaults
// are a proposal to argue with, not measurements; the card is there so the
// argument can be had with the numbers moving.
//
// ── What is kept, and where ──────────────────────────────────────────────────
// The card as it stands is kept on the device (localStorage), so a slider
// moved yesterday is still there. Two things are kept in the database instead
// (0065), read once when the tab opens through a2plan_read() and written one
// change at a time:
//
//   site conditions  what each repeater site needs, as somebody knows it — one
//                    answer per site, the same for everybody who sees the plan.
//   scenarios        the card saved under a name: private to whoever saved it
//                    until they share it, then everybody who sees the plan may
//                    load it; only its author changes, shares or removes it.
//   people           who sees the plan (0076): everybody on the list sees who
//                    else is, and a nominator adds people, lets them nominate
//                    and takes them off.

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
    backboneFirst: true, backboneKm: 100, allBackbone: false, fieldStage: true,
    acquireOther: true, unknownAcqPct: 50, acqLeadMonths: 9, acqParallel: 6,
    auditDays: 1, retrofitPct: 45, remediateDays: 4, remedCrews: 2, fitDays: 1.5, backboneCrews: 1,
    rebuildPct: 15, rebuildDays: 20, rebuildCrews: 2, rebuildLeadMonths: 6,
    reviews: true, reviewTeams: 1, addRepPct: 10, removeRepPct: 5,
    basesN: 0, dupBases: true, baseDays: 4,
    fieldCrews: 4, staffPerCrew: 2, crewDays: 14,
    rainDays: 1.0, levelDays: 1.5, remoteMult: 1.5,
    wet: true, wetFactor: 50, fwinPct: 20, fwinDays: 0.25,
    closeMonths: 3, pmFte: 1, benchHours: 2,
    spares: 5, contingency: 25, powerPct: 25,
    cErtA2: 6500, cErtRep: 7500, cErtBase: 6500, c115e: 3500, cKit: 1500, cPower: 3000, cTestKit: 25000,
    cAcq: 30000, cAudit: 4000, cRemed: 45000, cRebuild: 140000, cTemp: 8000, cNewRep: 180000, cRemove: 5000, cLicence: 1500,
    rateField: 150000, rateEng: 185000, ratePm: 200000, rateSupport: 140000, travelDay: 700,
  };

  // Ways to ask "what if" with one press. Each is the proposal with a few
  // things changed, so the comparison against the proposal stays meaningful.
  const PRESETS = [
    { id: 'proposed', label: 'The proposal', set: {} },
    { id: 'faster', label: 'Faster — more crews', set: { fieldCrews: 6, backboneCrews: 2, remedCrews: 3, reviewTeams: 2, acqParallel: 10 } },
    { id: 'lean', label: 'Leaner — fewer crews', set: { fieldCrews: 2, backboneCrews: 1, remedCrews: 1, rebuildCrews: 1 } },
    { id: 'backbone', label: 'Backbone only — field stations stay ALERT1', set: { fieldStage: false } },
    { id: 'rebuilds', label: 'More structures rebuilt', set: { retrofitPct: 45, rebuildPct: 35 } },
    { id: 'together', label: 'Backbone with each catchment', set: { backboneFirst: false } },
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
      { k: 'backboneFirst', kind: 'switch', label: 'Backbone first — each catchment cut over to an ALERT2 backbone in concentration mode, ahead of its field work' },
      { k: 'fieldStage', kind: 'switch', label: 'Convert the field stations too — otherwise they stay ALERT1, concentrated at their first repeater' },
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
      { k: 'remedCrews', kind: 'range', label: 'Contract crews retrofitting backbone sites', min: 1, max: 6, step: 1, unit: '' },
      { k: 'rebuildCrews', kind: 'range', label: 'Contract crews rebuilding repeater structures', min: 1, max: 6, step: 1, unit: '' },
      { k: 'reviewTeams', kind: 'range', label: 'Network review teams', min: 1, max: 4, step: 1, unit: '' },
    ] },
    { group: 'Backbone and network changes', items: [
      { k: 'acquireOther', kind: 'switch', label: 'Acquire backbone sites owned by councils and others' },
      { k: 'unknownAcqPct', kind: 'range', label: 'Of sites with no owner on record, share that turn out to need acquiring', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'acqLeadMonths', kind: 'range', label: 'Months to settle one owner\'s sites', min: 2, max: 24, step: 1, unit: ' mo' },
      { k: 'acqParallel', kind: 'range', label: 'Owners negotiated with at once', min: 1, max: 15, step: 1, unit: '' },
      { k: 'retrofitPct', kind: 'range', label: 'Unassessed backbone sites that need a retrofit — power, antenna, enclosure, earthing', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'rebuildPct', kind: 'range', label: 'Unassessed backbone sites whose structure must be rebuilt — mast or tower, footings, shelter', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'rebuildLeadMonths', kind: 'range', label: 'Months from a site\'s audit to its rebuild starting — design, approvals, fabrication', min: 1, max: 18, step: 1, unit: ' mo' },
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
    { k: 'cAudit', label: 'Condition audit of one backbone site (a rigger\'s climb and a structural report)' },
    { k: 'cRemed', label: 'Retrofitting one backbone site — power, antenna, enclosure, earthing (materials and contract works)' },
    { k: 'cRebuild', label: 'Rebuilding one repeater structure — mast or tower, footings, shelter (design and contract works)' },
    { k: 'cTemp', label: 'Temporary repeater while a structure is rebuilt, per site' },
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
  const LONG_LINK_KM = 150;         // a pass-range link longer than this is an address collision

  // What a repeater site needs before it carries ALERT2, least to most.
  const WORKS = ['fit', 'retrofit', 'rebuild'];
  const WORKS_LABEL = { fit: 'Fit-out only', retrofit: 'Retrofit', rebuild: 'Rebuild the structure' };

  // ── state ──
  // Site conditions set before they were kept in the database (one revision
  // kept them on the device, inside the card): carried over once the shared
  // store answers, then forgotten.
  let legacySites = null;
  let sc = loadScenario();
  let cat = null, catKey = null;     // the scope, before the catchment ticks
  const cuts = new Map();            // …and after them, by selection: what a plan is worked from
  let catsOpen = false;              // the catchment picker, folded or not
  let slsWanted = false, slsReady = false;
  let basins = null;               // parsed basin polygons, once

  // ── the shared store (0065) ──
  // What a2plan_read() answered, and where the card came from. `store` says
  // whether it has: 'idle' until the tab is opened by somebody on the list,
  // 'loading', 'ready', or 'failed' with the reason in storeError.
  const LS_LOADED = 'meganet.a2plan.loaded';
  let conditions = {};               // station id → 'fit' | 'retrofit' | 'rebuild'
  const condBy = new Map();          // station id → { by, at }: who set it, and when
  let condStamp = 0;                 // moves whenever a condition does, so the plan is worked again
  let scenarios = [];                // every saved scenario this person may see
  let people = null;                 // who sees the plan (0076); null from a database before it
  let peopleOpen = false;            // the list, folded or not
  let store = 'idle', storeError = '';
  let scenFormOpen = false;          // "Save as a new scenario" unfolded
  let busy = false;                  // a write on its way: the buttons wait for it
  // The scenario the card was last loaded from or saved as: its id, and the
  // card as it was then, so "changed since" can be said.
  let loaded = loadLoaded();
  function loadLoaded() {
    try {
      const v = JSON.parse(localStorage.getItem(LS_LOADED) || 'null');
      return v && typeof v.id === 'string' && typeof v.snap === 'string' ? { id: v.id, snap: v.snap } : null;
    } catch (_) { return null; }
  }
  function saveLoaded() {
    try {
      if (loaded) localStorage.setItem(LS_LOADED, JSON.stringify(loaded));
      else localStorage.removeItem(LS_LOADED);
    } catch (_) { /* unremembered, as the card is in a private window */ }
  }

  // On the plan's list, as whoami() says (0076) — and whether this person may
  // change it. The doors ask the database again whatever these say.
  function mayPlan() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && !!(Auth.a2plan && Auth.a2plan());
  }
  function mayNominate() {
    return mayPlan() && !!(Auth.a2planNominates && Auth.a2planNominates());
  }

  // ── the scenario, kept on this device ──
  function loadScenario() {
    let got = null;
    try { got = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { got = null; }
    const out = sanitize(got);
    if (out.sites && Object.keys(out.sites).length) legacySites = out.sites;
    delete out.sites;
    return out;
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
      // The catchments' order within their regions, by key.
      if (Array.isArray(raw.catOrder)) out.catOrder = [...new Set(raw.catOrder.filter(x => typeof x === 'string' && x.length <= 120))].slice(0, 500);
      // Site conditions handed to model() in place of the shared ones — the
      // tests' way of asking "what if every site were known" — and, from the
      // one revision that kept them inside the card, the conditions to carry
      // over. By station id: a fit-out, a retrofit or the structure rebuilt.
      if (raw.sites && typeof raw.sites === 'object' && !Array.isArray(raw.sites)) {
        const sites = {};
        for (const [id, v] of Object.entries(raw.sites).slice(0, 1000)) {
          if (id.length <= 80 && WORKS.includes(v)) sites[id] = v;
        }
        out.sites = sites;
      }
      // The catchments left out — kept as what is left out, so a catchment
      // the register gains later is in the plan until somebody unticks it.
      if (Array.isArray(raw.excluded)) {
        out.excluded = [...new Set(raw.excluded.filter(x => typeof x === 'string' && x.length <= 120))].sort().slice(0, 500);
      }
    }
    return out;
  }
  function saveScenario() {
    const keep = { ...sc };
    delete keep.sites;
    try { localStorage.setItem(LS_KEY, JSON.stringify(keep)); } catch (_) { /* a private window: it still works, unremembered */ }
  }
  // Whether a scenario is not the proposal. A catchment unticked under
  // another scope is remembered for when that scope comes back, but makes no
  // difference to this one, so only the scope's own catchments are compared.
  // A site condition is not a lever but what is known of the site, so the
  // proposal is worked with them too and they are no difference.
  function differs(a, b) {
    if (Object.keys(DEFAULTS).some(k => a[k] !== b[k]) || JSON.stringify(a.order || []) !== JSON.stringify(b.order || [])
        || JSON.stringify(a.catOrder || []) !== JSON.stringify(b.catOrder || [])) return true;
    const C = catalogue();
    const ea = new Set(a.excluded || []), eb = new Set(b.excluded || []);
    return C ? C.flat.some(c => ea.has(c.key) !== eb.has(c.key)) : ea.size !== eb.size;
  }

  // ── reading and writing the shared store ──
  function setCondition(row) {
    if (!row || typeof row.station_id !== 'string') return;
    if (WORKS.includes(row.condition)) {
      conditions[row.station_id] = row.condition;
      condBy.set(row.station_id, { by: row.by || '', at: row.updated_at || '' });
    } else {
      delete conditions[row.station_id];
      condBy.delete(row.station_id);
    }
  }
  async function loadStore() {
    if (!mayPlan() || typeof dbRpc !== 'function' || store === 'loading') return;
    store = 'loading'; storeError = '';
    refreshStore();
    try {
      const got = await dbRpc('a2plan_read', {});
      conditions = {}; condBy.clear();
      for (const r of (got && Array.isArray(got.sites) ? got.sites : [])) setCondition(r);
      scenarios = (got && Array.isArray(got.scenarios) ? got.scenarios : []).filter(x => x && typeof x.id === 'string');
      people = got && Array.isArray(got.people) ? got.people.filter(x => x && typeof x.id === 'string') : null;
      if (loaded && !scenarios.some(x => x.id === loaded.id)) { loaded = null; saveLoaded(); }
      await carryLegacySites();
      store = 'ready';
    } catch (e) {
      store = 'failed';
      storeError = e && e.message ? e.message : String(e);
    }
    condStamp++;
    memo = null;
    repaint();
  }
  // Conditions set when they were kept inside the card, on this device:
  // saved for everybody who sees the plan, except where somebody has already said.
  async function carryLegacySites() {
    const old = legacySites;
    legacySites = null;
    if (!old) return;
    let n = 0;
    for (const [id, v] of Object.entries(old)) {
      if (!WORKS.includes(v) || conditions[id]) continue;
      try { setCondition(await dbRpc('a2plan_site_set', { p_station_id: id, p_condition: v })); n++; } catch (_) { /* a station gone from the register */ }
    }
    // The card is written again without them, so they are carried once.
    saveScenario();
    if (n) announce(`${n} site condition${n === 1 ? '' : 's'} kept on this device ${n === 1 ? 'is' : 'are'} now saved for everybody who sees the plan.`);
  }

  // The card as a scenario keeps it: every setting, the regions' and
  // catchments' order and the catchments left out — not the site conditions,
  // which are the sites', not the scenario's.
  function cardSettings(s = sc) {
    const out = { v: 1 };
    for (const k of Object.keys(DEFAULTS)) out[k] = s[k];
    for (const k of ['order', 'catOrder', 'excluded']) if (Array.isArray(s[k]) && s[k].length) out[k] = s[k].slice();
    return out;
  }
  const snapOf = s => JSON.stringify(cardSettings(s));
  const loadedScenario = () => (loaded ? scenarios.find(x => x.id === loaded.id) || null : null);
  const changedSinceLoad = () => !!loaded && snapOf(sc) !== loaded.snap;
  function putScenario(row) {
    const i = scenarios.findIndex(x => x.id === row.id);
    if (i >= 0) scenarios[i] = row; else scenarios.unshift(row);
    scenarios.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }
  // A write to the store: the buttons wait, the panel says what happened, and
  // a refusal is said in the database's own words. `refresh` draws the panel
  // the write was made from: the scenarios', or the list's.
  async function write(what, fn, focusKey, refresh = refreshStore) {
    if (busy) return null;
    busy = true;
    refresh(focusKey);
    try {
      const out = await fn();
      return out;
    } catch (e) {
      announce(`${what} did not work: ${e && e.message ? e.message : e}`);
      return null;
    } finally {
      busy = false;
      refresh(focusKey);
    }
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

  // Everything in the scope, before the card's catchment ticks: what the
  // picker lists and counts, and what a selection is cut from.
  function catalogue() {
    if (!state.data) return null;
    const key = [sc.scope, sc.backboneKm, sc.allBackbone, slsReady].join('|');
    if (cat && catKey === key && cat.data === state.data) return cat;
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
    const field = [], reps = [], bases = [];
    for (const s of stations) {
      if (!inScope(s)) continue;
      const roles = s.roles || [];
      const p = placeOf.get(s.id);
      // A catchment's key: its id for a Queensland basin; outside one, the
      // region and the council area together (marked, so it cannot meet a
      // basin id) — one council area, or none ("—"), turns up under several
      // hubs, and each is a box of its own.
      const key = p.cid || `x:${p.region}|${p.catchment}`;
      const hi = priorityOf(s) === 'High';
      if (roles.includes('base')) bases.push({ s, p, key });
      if (roles.includes('repeater')) {
        // The stations it carries, as the pass ranges say — a "link" past
        // LONG_LINK_KM is an address that happens to fall in a window, not a
        // station this repeater hears (Network Review's rule).
        const near = (carried.get(s.id) || []).filter(f => f.lat != null && acmaHaversineKm(s.lat, s.lon, f.lat, f.lon) <= LONG_LINK_KM);
        reps.push({ s, p, key, backbone: sc.allBackbone || backbone.has(s.id), owner: ownerOf(s), carries: near.length,
                    carriedIds: new Set(near.map(f => f.id)) });
      } else if (!roles.includes('base') && roles.includes('field') && hasAlert(s)) {
        field.push({ s, p, key, level: !!(s.alert_ids && s.alert_ids.water_level != null), high: hi });
      }
    }
    // The picker's list: every catchment in the scope, under its region, with
    // what is in it.
    const groups = new Map();
    const entry = (p, key) => {
      if (!groups.has(p.region)) groups.set(p.region, new Map());
      const g = groups.get(p.region);
      if (!g.has(key)) g.set(key, { key, name: p.catchment, region: p.region, field: 0, repeaters: 0, bases: 0 });
      return g.get(key);
    };
    for (const f of field) entry(f.p, f.key).field++;
    for (const r of reps) entry(r.p, r.key).repeaters++;
    for (const b of bases) entry(b.p, b.key).bases++;
    const list = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([region, m]) => ({ region, cats: [...m.values()].sort((a, b) => a.name.localeCompare(b.name)) }));
    const scoped = links.filter(p => inScope(p.a) && inScope(p.b));
    const route = routesToBase(reps, bases, scoped);
    cat = {
      data: state.data, field, reps, bases, links: scoped, pathOf: route.pathOf, baseOf: route.baseOf,
      groups: list, flat: list.flatMap(g => g.cats),
      radioNetworks: (state.data.radio_networks || []).length,
      asAt: (state.data.meta && state.data.meta.updated) || '',
    };
    catKey = key;
    return cat;
  }

  // The way each repeater's traffic reaches a base: the fewest backbone hops,
  // over the links the card counts (a repeater sharing an open pass-range
  // window with another, or within the hop distance of a base). A breadth-
  // first walk out from every base at once; each repeater's next hop is the
  // nearest neighbour one hop closer, so the answer is the same every time.
  // pathOf maps a repeater to the repeaters after it on the way (the base, if
  // it is a repeater too, included); baseOf to the base it ends at. A repeater
  // with no way to a base on record is in neither.
  function routesToBase(reps, bases, links) {
    const adj = new Map();
    const add = (a, b, km) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ id: b, km }); };
    for (const p of links) { add(p.a.id, p.b.id, p.km); add(p.b.id, p.a.id, p.km); }
    const name = new Map(reps.map(r => [r.s.id, r.s.name || '']).concat(bases.map(b => [b.s.id, b.s.name || ''])));
    const order = (x, y) => (x.km - y.km) || String(name.get(x.id) || '').localeCompare(String(name.get(y.id) || '')) || String(x.id).localeCompare(String(y.id));
    for (const l of adj.values()) l.sort(order);
    const dist = new Map(), next = new Map();
    const queue = [];
    for (const b of bases.slice().sort((x, y) => String(x.s.name).localeCompare(String(y.s.name)))) {
      if (dist.has(b.s.id)) continue;
      dist.set(b.s.id, 0); queue.push(b.s.id);
    }
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i];
      for (const { id } of adj.get(x) || []) {
        if (dist.has(id)) continue;
        dist.set(id, dist.get(x) + 1); next.set(id, x); queue.push(id);
      }
    }
    // The next hop as the nearest neighbour one hop closer, not merely the
    // first one the walk happened to reach it from.
    for (const [id, d] of dist) {
      if (!d) continue;
      const best = (adj.get(id) || []).find(n => dist.get(n.id) === d - 1);
      if (best) { next.set(id, best.id); }
    }
    const repIds = new Set(reps.map(r => r.s.id));
    const pathOf = new Map(), baseOf = new Map();
    for (const r of reps) {
      const id = r.s.id;
      if (!dist.has(id)) continue;
      const path = [];
      let x = id, guard = 0;
      while (dist.get(x) > 0 && guard++ < 64) { x = next.get(x); if (repIds.has(x)) path.push(x); }
      pathOf.set(id, path);
      baseOf.set(id, x);
    }
    return { pathOf, baseOf };
  }

  // The plan's inventory: the catalogue cut to the catchments ticked on the
  // card. A field station or base is in when its catchment is. A repeater is
  // in when its catchment is — or when it carries a station that is, because
  // that station's readings reach a base through it whichever catchment its
  // hill is in, or when it is on the way from one of those to a base, because
  // an ALERT1 repeater cannot carry ALERT2; those are marked, and the plan
  // says how many.
  function inventory() { return inventoryFor(sc.excluded || []); }
  function inventoryFor(excluded) {
    const C = catalogue();
    if (!C) return null;
    const ex = new Set(excluded);
    const key = catKey + '|' + [...ex].sort().join('\u0001');
    if (cuts.has(key) && cuts.get(key).data === state.data) return cuts.get(key);
    const field = C.field.filter(f => !ex.has(f.key));
    const keyOf = new Map(field.map(f => [f.s.id, f.key]));
    // What each ticked catchment needs on the backbone: the repeaters on its
    // own ground, the ones that hear its stations (its concentrators), and
    // every repeater on the way from those to a base.
    const needs = new Map();
    const need = (k, id) => { if (!needs.has(k)) needs.set(k, new Set()); needs.get(k).add(id); };
    const carries = new Map(), relays = new Set();
    for (const r of C.reps) {
      const ks = new Set();
      for (const id of r.carriedIds) { const k = keyOf.get(id); if (k != null) ks.add(k); }
      carries.set(r.s.id, ks);
      if (!ex.has(r.key)) need(r.key, r.s.id);
      for (const k of ks) {
        need(k, r.s.id);
        for (const p of C.pathOf.get(r.s.id) || []) { need(k, p); relays.add(p); }
      }
    }
    const neededBy = new Map();
    for (const [k, set] of needs) for (const id of set) { if (!neededBy.has(id)) neededBy.set(id, new Set()); neededBy.get(id).add(k); }
    const reps = [];
    for (const r of C.reps) {
      if (!neededBy.has(r.s.id)) continue;
      reps.push({ ...r, outside: ex.has(r.key), conc: carries.get(r.s.id).size > 0, relay: relays.has(r.s.id),
                  routed: C.pathOf.has(r.s.id), cats: neededBy.get(r.s.id) });
    }
    const bases = C.bases.filter(b => !ex.has(b.key));
    const regions = new Map();
    const region = name => {
      if (!regions.has(name)) {
        regions.set(name, { name, cats: new Map(), rain: 0, level: 0, field: 0, repeaters: 0, backbone: 0, bases: 0, high: 0,
                            remote: REMOTE.has(name), owners: { bureau: 0, joint: 0, other: 0, unknown: 0 } });
      }
      return regions.get(name);
    };
    const catOf = (r, x) => {
      if (!r.cats.has(x.key)) r.cats.set(x.key, { name: x.p.catchment, rain: 0, level: 0, repeaters: 0, backbone: 0, bases: 0, high: 0, outside: ex.has(x.key) });
      return r.cats.get(x.key);
    };
    for (const f of field) {
      const r = region(f.p.region), c = catOf(r, f);
      r.field++; if (f.level) { r.level++; c.level++; } else { r.rain++; c.rain++; }
      if (f.high) { r.high++; c.high++; }
    }
    for (const x of reps) {
      const r = region(x.p.region), c = catOf(r, x);
      r.repeaters++; c.repeaters++;
      if (x.backbone) { r.backbone++; c.backbone++; r.owners[x.owner.cls]++; }
    }
    for (const b of bases) { const r = region(b.p.region); r.bases++; catOf(r, b).bases++; }
    const inPlan = new Set(reps.map(r => r.s.id).concat(bases.map(b => b.s.id)));
    const ticked = C.flat.filter(c => !ex.has(c.key)).length;
    // The ticked catchments, each with what it holds and what it needs: the
    // unit the backbone is cut over in.
    const byKey = new Map(reps.map(r => [r.s.id, r]));
    const heard = new Set();
    for (const r of reps) for (const id of r.carriedIds) heard.add(id);
    const catList = C.flat.filter(c => !ex.has(c.key)).map(c => {
      const mine = field.filter(f => f.key === c.key);
      const ids = [...(needs.get(c.key) || [])].filter(id => byKey.has(id));
      const conc = ids.filter(id => carries.get(id).has(c.key));
      return { key: c.key, name: c.name, region: c.region, remote: REMOTE.has(c.region),
               field: mine.length, level: mine.filter(f => f.level).length, rain: mine.filter(f => !f.level).length,
               high: mine.filter(f => f.high).length, needs: ids, conc: conc.length,
               // Its stations a repeater on record carries: the ones the
               // backbone can concentrate. The rest are heard by a base
               // directly, or their path is not on record.
               carried: mine.filter(f => heard.has(f.s.id)).length,
               noPath: conc.filter(id => !C.pathOf.has(id)).length };
    });
    const inv = {
      data: state.data, field, reps, bases,
      links: C.links.filter(p => inPlan.has(p.a.id) && inPlan.has(p.b.id)),
      regions: [...regions.values()],
      catchmentCount: ticked, catchmentsInScope: C.flat.length, partial: ticked < C.flat.length,
      outsideReps: reps.filter(r => r.outside).length,
      relayOnly: reps.filter(r => r.outside && !r.conc).length,
      catList,
      share: C.field.length ? field.length / C.field.length : 0,
      radioNetworks: C.radioNetworks,
      registerBases: bases.length,
      asAt: C.asAt,
    };
    // Two are wanted at a time — the card's selection and the whole scope,
    // which the figures at the top compare against — so a few are kept.
    if (cuts.size > 6) cuts.clear();
    cuts.set(key, inv);
    return inv;
  }

  // The bases a plan equips when the card does not say: one a radio network
  // for the whole scope; for part of it, the networks in proportion to the
  // stations ticked — at least the register's bases in it, and none for none.
  function basesDefault(I) {
    if (!I.field.length && !I.reps.length) return 0;
    if (!I.partial) return Math.max(I.radioNetworks, I.registerBases);
    return Math.max(1, I.registerBases, Math.ceil(I.radioNetworks * I.share));
  }

  // The order the regions are converted in: the card's, then any region it
  // does not mention by most High-priority sites, then most stations.
  function regionOrder(I, s) {
    const names = I.regions.map(r => r.name);
    const byWeight = I.regions.slice().sort((a, b) => (b.high - a.high) || (b.field - a.field) || a.name.localeCompare(b.name)).map(r => r.name);
    const given = (s.order || []).filter(n => names.includes(n));
    return given.concat(byWeight.filter(n => !given.includes(n)));
  }

  // The order the catchments are cut over in: region by region in the
  // regions' order, and within a region the card's order, then the most
  // High-priority sites, then the most stations.
  function catOrder(I, s, regions) {
    const given = new Map((s.catOrder || []).map((k, i) => [k, i]));
    const weight = (a, b) => (b.high - a.high) || (b.field - a.field) || a.name.localeCompare(b.name);
    const out = [];
    for (const reg of regions) {
      const mine = I.catList.filter(c => c.region === reg);
      out.push(...mine.filter(c => given.has(c.key)).sort((a, b) => given.get(a.key) - given.get(b.key)),
               ...mine.filter(c => !given.has(c.key)).sort(weight));
    }
    return out;
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

  // What each catchment's backbone takes: the repeaters it needs that no
  // catchment before it has, and what each of those sites needs. A site with a
  // condition set is taken at its word and not audited; a backbone site with
  // none is audited first, and costed at the card's mix —
  // allotted catchment by catchment in the order they go, so the totals are
  // whole sites and the first catchments are not all luck. A repeater that
  // is not backbone is fitted out as it stands.
  function siteWorks(I, s, cats) {
    const pRebuild = Math.min(100, s.rebuildPct) / 100;
    const pAny = Math.min(100, s.rebuildPct + s.retrofitPct) / 100;
    const known = s.sites || conditions;
    const repById = new Map(I.reps.map(r => [r.s.id, r]));
    const doneBy = new Map();
    let U = 0, gotR = 0, gotS = 0;
    return cats.map((c, ci) => {
      const fresh = c.needs.filter(id => !doneBy.has(id));
      fresh.forEach(id => doneBy.set(id, ci));
      const w = { fit: 0, retrofit: 0, rebuild: 0, audit: 0, known: 0, assumed: { fit: 0, retrofit: 0, rebuild: 0 } };
      for (const id of fresh) {
        const m = known[id];
        if (WORKS.includes(m)) { w[m]++; w.known++; } else if (repById.get(id).backbone) w.audit++; else w.fit++;
      }
      const u = w.audit;
      U += u;
      const dR = Math.max(0, Math.min(u, Math.round(U * pRebuild) - gotR));
      const dS = Math.max(dR, Math.min(u, Math.round(U * pAny) - gotS));
      gotR += dR; gotS += dS;
      w.assumed = { rebuild: dR, retrofit: dS - dR, fit: u - dS };
      w.rebuild += dR; w.retrofit += dS - dR; w.fit += u - dS;
      return { c, fresh, w };
    });
  }

  function model(I, s) {
    const wetOf = m => {
      if (!s.wet) return 1;
      const c = calOf(s, m).m;
      return c === 11 || c <= 2 ? s.wetFactor / 100 : 1;
    };
    const order = regionOrder(I, s);
    const R = new Map(I.regions.map(r => [r.name, r]));
    const cats = catOrder(I, s, order);
    const spare = 1 + s.spares / 100;
    const dayRate = { field: s.rateField / WORK_DAYS_YEAR, eng: s.rateEng / WORK_DAYS_YEAR, pm: s.ratePm / WORK_DAYS_YEAR, support: s.rateSupport / WORK_DAYS_YEAR };
    // The field stations are converted in this program, or left on ALERT1 for
    // their concentrators to carry. Without field crews nobody fits the
    // repeaters but the backbone stream, so it runs whatever the switch says.
    const fieldOn = !!s.fieldStage;
    const bf = s.backboneFirst || !fieldOn;

    // Quantities.
    const nField = I.field.length;
    const nLevel = I.field.filter(f => f.level).length;
    const nRep0 = I.reps.length;
    // What the reviews change, region by region — in a region with a
    // catchment ticked; the totals are their sum.
    const withCats = new Set(cats.map(c => c.region));
    const addOf = r => (s.reviews && withCats.has(r.name) ? Math.round(r.repeaters * s.addRepPct / 100) : 0);
    const remOf = r => (s.reviews && withCats.has(r.name) ? Math.round(r.repeaters * s.removeRepPct / 100) : 0);
    const added = I.regions.reduce((a, r) => a + addOf(r), 0);
    const removed = I.regions.reduce((a, r) => a + remOf(r), 0);
    const nRep = Math.max(0, nRep0 + added - removed);
    const nBases = s.basesN > 0 ? s.basesN : basesDefault(I);
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
    const works = siteWorks(I, s, cats);
    const tally = k => works.reduce((a, x) => a + x.w[k], 0);
    const nAudit = tally('audit'), nRetro = tally('retrofit'), nRebuild = tally('rebuild'), nFitOnly = tally('fit'), nKnown = tally('known');
    const nRemed = nRetro + nRebuild;

    // What is bought, in whole units — the equipment table and the spend are
    // both read off these, so they cannot disagree.
    const qField = fieldOn ? Math.ceil(nField * spare) : 0;
    const qRep = Math.ceil(nRep * spare);
    const baseRx = nBases * chains;
    const qPower = fieldOn ? Math.round(nField * s.powerPct / 100) : 0;
    const qTest = (fieldOn ? Math.max(1, s.fieldCrews) : 0) + Math.max(1, s.backboneCrews);
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
    // teams; each fixes its network before its field work may start, and
    // before any structure in it is rebuilt.
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

    // The backbone's acquisitions: a property and legal lane, many at once.
    const bbStart = bf ? 0 : P;
    const acqEnd = nOwners ? bbStart + s.acqLeadMonths * Math.max(1, nOwners / Math.max(1, s.acqParallel)) : bbStart;
    if (nAcq) {
      acts.push({ row: 'acquire', label: 'Backbone sites acquired', start: bbStart, end: acqEnd });
      spread(cost.backbone, bbStart, acqEnd, nAcq * s.cAcq);
      spread(fte.support, bbStart, acqEnd, 0.5 * WORK_DAYS_MONTH * (acqEnd - bbStart));
      spread(cost.labour, bbStart, acqEnd, 0.5 * WORK_DAYS_MONTH * (acqEnd - bbStart) * dayRate.support);
    }

    // Bases: an ALERT2 receive chain beside the legacy one, so both run while
    // the network moves over. They are equipped in the order the catchments
    // need them, so a catchment waits for its share of the bases — the share
    // of the plan's stations cut over by the time it is.
    const Lb = lane(nBases * chains * s.baseDays, DESK_DAYS_MONTH, P);
    acts.push({ row: 'bases', label: 'Base stations receive ALERT2', start: Lb.start, end: Lb.end });
    pd('eng', Lb.by);
    Lb.by.forEach((v, m) => addInto(cost.travel, m, v * s.travelDay * 0.5));
    const fieldTicked = cats.reduce((a, c) => a + c.field, 0);
    let cum = 0;
    const baseReady = cats.map((c, i) => {
      cum += c.field;
      if (!nBases) return P;
      const share = fieldTicked ? cum / fieldTicked : (i + 1) / cats.length;
      return Lb.start + (Lb.end - Lb.start) * Math.min(1, Math.ceil(nBases * share - 1e-9) / nBases);
    });

    // The pilot: the first catchment's backbone in concentration mode, proved
    // end to end, and — when the field is in the plan — some of its stations.
    const pilotEnd = s.pilot ? P + s.pilotMonths : P;
    if (s.pilot) {
      acts.push({ row: 'pilot', label: 'Pilot network', start: P, end: pilotEnd });
      spread(fte.eng, P, pilotEnd, WORK_DAYS_MONTH * s.pilotMonths);
      spread(cost.labour, P, pilotEnd, WORK_DAYS_MONTH * s.pilotMonths * dayRate.eng);
      if (fieldOn) {
        // Its stations are converted by one crew, at the network's average pace.
        const avg = nField ? ((nField - nLevel) * s.rainDays + nLevel * s.levelDays) / nField : s.rainDays;
        const crewDays = Math.min(s.pilotSites, nField) * avg;
        spread(fte.field, P, pilotEnd, crewDays * s.staffPerCrew);
        spread(cost.labour, P, pilotEnd, crewDays * s.staffPerCrew * dayRate.field);
        spread(cost.travel, P, pilotEnd, crewDays * s.travelDay);
      }
      ms.push({ at: pilotEnd, label: 'Pilot accepted' });
    }

    // The backbone, catchment by catchment. Four lanes, each taking the
    // catchments in order: the condition audits (one contract team, from day
    // one — none of it needs ALERT2 equipment), the retrofits (contract crews,
    // once a catchment's sites are audited), the rebuilds (structural
    // contractors, once a site's design and approvals are through and its
    // network's review has kept it), and the ALERT2 fit-out on the Bureau's
    // tower crews — concentrators and relays, once the equipment is in, the
    // pilot has proved it, the catchment's site works are done and its bases
    // receive ALERT2. When the last of its repeaters is fitted, the catchment
    // is cut over: its stations' readings travel as ALERT2 from their first
    // repeater on, without a visit to one of them.
    const auditPerMonth = s.crewDays;
    const remPerMonth = Math.max(1, s.remedCrews) * s.crewDays;
    const rebPerMonth = Math.max(1, s.rebuildCrews) * s.crewDays;
    const towerPerMonth = Math.max(1, s.backboneCrews) * s.crewDays;
    const fitFrom = s.pilot ? pilotEnd : P;
    const towerLabour = (L) => {
      const arr = [];
      L.by.forEach((v, m) => { if (v) arr[m] = v * s.staffPerCrew; });
      pd('field', arr);
      L.by.forEach((v, m) => { if (v) addInto(cost.travel, m, v * s.travelDay); });
    };
    let ta = bbStart, tr = bbStart, tb = bbStart, tf = fitFrom, worksEnd = bbStart;
    const fitAt = new Map();
    const seenRegion = new Set();
    const rows = works.map(({ c, fresh, w }, ci) => {
      const mult = c.remote ? s.remoteMult : 1;
      // The repeaters the region's review adds, and retires, go with its first catchment.
      let netAdd = 0, netRem = 0;
      if (!seenRegion.has(c.region)) { seenRegion.add(c.region); const r = R.get(c.region); if (r) { netAdd = addOf(r); netRem = remOf(r); } }
      const nFit = Math.max(0, fresh.length + netAdd - netRem);
      const worksCost = w.audit * s.cAudit + w.retrofit * s.cRemed + w.rebuild * (s.cRebuild + s.cTemp);
      const row = { ...c, fresh: fresh.length, shared: c.needs.length - fresh.length, w, nFit, added: netAdd, removed: netRem,
                    worksCost, baseReady: baseReady[ci], audited: null, retroEnd: null, rebuildEnd: null, cutStart: null, cutover: null };
      if (!bf) return row;
      const La = lane(w.audit * s.auditDays * mult, auditPerMonth, ta, wetOf);
      if (w.audit) {
        acts.push({ row: 'audit', region: c.region, label: `Condition audits — ${c.name}`, start: La.start, end: La.end });
        spread(cost.backbone, La.start, Math.max(La.end, La.start + 0.25), w.audit * s.cAudit);
        ta = La.end;
      }
      const audited = w.audit ? La.end : bbStart;
      row.audited = audited;
      const Lr = lane(w.retrofit * s.remediateDays * mult, remPerMonth, Math.max(tr, audited), wetOf);
      if (w.retrofit) {
        acts.push({ row: 'remediate', region: c.region, label: `Retrofits — ${c.name}`, start: Lr.start, end: Lr.end });
        spread(cost.backbone, Lr.start, Math.max(Lr.end, Lr.start + 0.5), w.retrofit * s.cRemed);
        tr = Lr.end;
        row.retroEnd = Lr.end;
      }
      if (!c.needs.length) { row.cutGate = 'no repeater carries its stations on record'; return row; }
      const rev = s.reviews && review.has(c.region) ? review.get(c.region).end : 0;
      const Lx = lane(w.rebuild * s.rebuildDays * mult, rebPerMonth, Math.max(tb, audited + s.rebuildLeadMonths, rev), wetOf);
      if (w.rebuild) {
        acts.push({ row: 'rebuild', region: c.region, label: `Structures rebuilt — ${c.name}`, start: Lx.start, end: Lx.end });
        spread(cost.backbone, Lx.start, Math.max(Lx.end, Lx.start + 0.5), w.rebuild * s.cRebuild);
        addInto(cost.backbone, Math.floor(Lx.start), w.rebuild * s.cTemp);
        tb = Lx.end;
        row.rebuildStart = Lx.start;
        row.rebuildEnd = Lx.end;
      }
      worksEnd = Math.max(worksEnd, ta, tr, tb);
      const ready = Math.max(audited, row.retroEnd || 0, row.rebuildEnd || 0);
      const gates = [[s.pilot ? 'the pilot' : 'the equipment', fitFrom], ['its site works', ready], ['its bases receiving ALERT2', baseReady[ci]]];
      if (nFit) gates.push(['the tower crews', tf]);
      const gate = gates.reduce((a, b) => (b[1] > a[1] + 1e-9 ? b : a));
      const Lf = lane(nFit * s.fitDays * mult, towerPerMonth, gate[1], wetOf);
      if (nFit) {
        acts.push({ row: 'fit', region: c.region, label: `Backbone cut-over — ${c.name}`, start: Lf.start, end: Lf.end });
        towerLabour(Lf);
        tf = Lf.end;
      }
      // A catchment whose repeaters were fitted for others before it is on
      // the backbone when they are, and its bases.
      fresh.forEach(id => fitAt.set(id, Lf.end));
      const prior = Math.max(0, ...c.needs.map(id => fitAt.get(id) || 0));
      row.cutStart = Lf.start;
      row.cutGate = prior > Lf.end + 1e-9 ? 'its repeaters, fitted for a catchment before it' : gate[0];
      row.cutover = Math.max(Lf.end, prior);
      addInto(cost.network, Math.floor(Math.max(0, Lf.start - 1)), netAdd * s.cNewRep + netRem * s.cRemove + nFit * s.cLicence);
      return row;
    });
    if (bf) {
      // A contract manager looks after the audit, retrofit and rebuild contracts while they run.
      spread(fte.support, bbStart, worksEnd, 0.3 * WORK_DAYS_MONTH * (worksEnd - bbStart));
      spread(cost.labour, bbStart, worksEnd, 0.3 * WORK_DAYS_MONTH * (worksEnd - bbStart) * dayRate.support);
    }

    // Field conversion, catchment by catchment, on every field crew, each
    // once its backbone is ALERT2 — an ALERT1 repeater cannot carry an ALERT2
    // station. Without the backbone first, the field crews fit a catchment's
    // repeaters themselves, its site works are contracted as it starts, and
    // none starts before the acquisitions are done.
    const fieldPerMonth = Math.max(1, s.fieldCrews) * s.crewDays;
    let prev = pilotEnd;
    let pilotLeft = s.pilot && fieldOn ? Math.min(s.pilotSites, nField) : 0;
    const why = [];
    rows.forEach((row, ci) => {
      if (!fieldOn) { row.start = row.end = null; row.work = 0; row.by = []; row.pilotHere = 0; row.gate = ''; return; }
      const mult = row.remote ? s.remoteMult : 1;
      const pilotHere = Math.min(pilotLeft, row.field);
      pilotLeft -= pilotHere;
      const share = row.field ? (row.field - pilotHere) / row.field : 0;
      // A station the FWIN program is already visiting to upgrade gets its
      // ERT-A2 on that visit: the crew-days of fitting it, not of getting there.
      const f = s.fwinPct / 100;
      let work = ((row.rain * s.rainDays + row.level * s.levelDays) * mult * (1 - f) + row.field * f * s.fwinDays) * share;
      if (!bf) work += row.nFit * s.fitDays * mult;
      const gates = [[ci ? 'the catchment before' : (s.pilot ? 'the pilot' : 'the equipment'), prev]];
      if (s.reviews && review.has(row.region)) gates.push(['its network review', review.get(row.region).end]);
      if (bf && row.cutover != null) gates.push(['its backbone on ALERT2', row.cutover]);
      else {
        if (!bf && nAcq) gates.push(['the backbone acquisitions', acqEnd]);
        gates.push(['its bases receiving ALERT2', row.baseReady]);
      }
      const gate = gates.reduce((a, b) => (b[1] > a[1] + 1e-9 ? b : a));
      const st = gate[1];
      if (!bf) {
        addInto(cost.backbone, Math.floor(st), row.worksCost);
        addInto(cost.network, Math.floor(Math.max(0, st - 1)), row.added * s.cNewRep + row.removed * s.cRemove + row.nFit * s.cLicence);
      }
      const L = lane(work, fieldPerMonth, st, wetOf);
      // Field units are bought as the crews use them — in tranches over the
      // catchment's work, so the spend follows the field.
      const kit = nField ? fieldKit * row.field / nField : 0;
      const arr = [];
      L.by.forEach((v, m) => {
        if (!v) return;
        arr[m] = v * s.staffPerCrew;
        addInto(cost.travel, m, v * s.travelDay);
        addInto(cost.equip, Math.max(0, m - 1), work ? kit * v / work : 0);
      });
      if (!work) addInto(cost.equip, Math.floor(st), kit);
      pd('field', arr);
      if (L.end > L.start || work > 0) {
        acts.push({ row: 'field', region: row.region, label: `Field stations — ${row.name}`, start: L.start, end: L.end });
      }
      if (gate !== gates[0] && st > prev + 0.05) why.push({ region: row.region, name: row.name, gate: gate[0], wait: st - prev });
      Object.assign(row, { start: L.start, end: L.end, work, by: L.by, pilotHere, gate: gate[0] });
      if (!bf && row.needs.length) { row.cutover = L.end; row.cutStart = L.start; }
      prev = Math.max(prev, L.end);
    });
    const cutovers = rows.map(r => r.cutover).filter(v => v != null);
    const bbReady = cutovers.length ? Math.max(...cutovers) : bbStart;
    const firstCut = cutovers.length ? Math.min(...cutovers) : bbStart;
    if (bf && rows.length) {
      ms.push({ at: firstCut, label: 'First catchment on the ALERT2 backbone' });
      ms.push({ at: bbReady, label: 'Every catchment on the ALERT2 backbone' });
    }
    const fieldEnd = fieldOn ? prev : bbReady;
    if (fieldOn) ms.push({ at: fieldEnd, label: 'Last field station on ALERT2' });

    // Each region's own timeline: its catchments', taken together.
    const regionRows = order.map(name => {
      const r = R.get(name);
      const mine = rows.filter(x => x.region === name);
      const cut = mine.map(x => x.cutover).filter(v => v != null);
      const go = mine.filter(x => x.start != null);
      return {
        name, r, cats: mine.length, review: review.get(name) || null,
        fit: bf && cut.length ? { end: Math.max(...cut) } : null,
        cutFirst: cut.length ? Math.min(...cut) : null, cutLast: cut.length ? Math.max(...cut) : null,
        start: go.length ? Math.min(...go.map(x => x.start)) : null, end: go.length ? Math.max(...go.map(x => x.end)) : null,
        work: mine.reduce((a, x) => a + (x.work || 0), 0), gate: mine.length ? mine[0].gate || mine[0].cutGate || '' : '',
        units: Math.ceil(r.field * spare), added: addOf(r), removed: remOf(r),
      };
    });

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
    const streams = [['the backbone acquisitions', acqEnd], ['the last catchment cut over to the ALERT2 backbone', bbReady], ['the base stations', Lb.end]];
    if (fieldOn) streams.unshift(['the field crews reaching the last station', fieldEnd]);
    const critical = streams.reduce((a, b) => (b[1] > a[1] + 1e-9 ? b : a))[0];
    const end = lastWork + s.closeMonths;
    acts.push({ row: 'close', label: fieldOn ? 'Legacy ALERT retired, close-out' : 'Legacy repeaters retired, close-out', start: lastWork, end });
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
    const costCats = Object.keys(cost);
    const base = costCats.reduce((a, k) => a + sum(cost[k]), 0);
    const contingency = base * s.contingency / 100;
    cost.contingency = [];
    for (let m = 0; m < N; m++) {
      const here = costCats.reduce((a, k) => a + (cost[k][m] || 0), 0);
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
    const stay = `none — the ${nf(nField)} stations stay ALERT1, carried by their concentrators`;
    const equipment = [
      { item: 'ELPRO ERT-A2 — field station transmitter', qty: qField, unit: s.cErtA2, note: fieldOn ? `${nf(nField)} stations${s.spares ? ` and ${pct(s.spares)} spares` : ''}` : stay },
      { item: 'ELPRO ERT-A2 — repeater (concentrator: ALERT1 in, ALERT2 on)', qty: qRep, unit: s.cErtRep, note: `${nf(nRep0)} repeaters${added || removed ? ` ${added ? `+ ${added} added` : ''}${removed ? ` − ${removed} retired` : ''} by the reviews` : ''}${s.spares ? `, ${pct(s.spares)} spares` : ''}` },
      { item: 'ELPRO ERT-A2 — base station receiver', qty: baseRx, unit: s.cErtBase, note: `${nBases} bases × ${chains}` },
      { item: 'ELPRO 115E-2 gateway with ALERT2 licence key', qty: baseRx, unit: s.c115e, note: `${nBases} bases × ${chains}` },
      { item: 'Antenna, coax, surge protection and GPS kit', qty: qField + qRep + nBases, unit: s.cKit, note: fieldOn ? 'every site, and the spares' : 'every repeater and base, and the spares' },
      { item: 'Solar panel, regulator and battery upgrade', qty: qPower, unit: s.cPower, note: fieldOn ? `${pct(s.powerPct)} of field stations` : 'none — no field station is visited' },
      { item: 'Test set and bench equipment', qty: qTest, unit: s.cTestKit, note: fieldOn ? 'one per field and fit-out crew' : 'one per fit-out crew' },
    ];
    equipment.forEach(e => { e.total = e.qty * e.unit; });
    const units2 = { ertA2: equipment.slice(0, 3).reduce((a, e) => a + e.qty, 0), e115: baseRx };
    const breakdown = [
      { k: 'equip', label: 'Equipment', v: sum(cost.equip) },
      { k: 'labour', label: 'Staff time', v: sum(cost.labour) },
      { k: 'travel', label: 'Travel and vehicles', v: sum(cost.travel) },
      { k: 'backbone', label: 'Backbone sites — acquired, audited, retrofitted, rebuilt', v: sum(cost.backbone) },
      { k: 'network', label: 'Network changes and licensing', v: sum(cost.network) },
      { k: 'contingency', label: `Contingency (${pct(s.contingency)})`, v: contingency },
    ];

    // What set the pace: the lane whose end is the field's end, said plainly.
    const fieldMonths = rows.reduce((a, r) => a + ((r.end || 0) - (r.start || 0)), 0);
    const waits = why.reduce((a, w) => a + w.wait, 0);
    const shared = I.reps.filter(r => r.cats.size > 1).length;
    return {
      s, order, nField, nLevel, nRain: nField - nLevel, nRep0, nRep, added, removed, nBases, chains, baseRx,
      bbCount: bb.length, own, nAcq, nOwners, nRemed, nAudit, nRetro, nRebuild, nFitOnly, nKnown, shared,
      acqEnd, bbStart, bbReady, firstCut, pilotEnd, P, fieldEnd, end, months: N, bf, fieldOn,
      acts, ms, regionRows, cats: rows, review, why, waits, fieldMonths, critical,
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
      ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? '<p class="small">This is only for the people nominated to see it.</p>'
        : '<div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>'}
    </div>`;
  }

  function render() {
    let body;
    if (!mayPlan()) body = outsideHtml();
    else if (!state.data) body = '<div class="panel"><p class="small">The station register is still loading — the plan is worked from it.</p></div>';
    else body = headHtml() + `<div id="a2p-kpis">${kpisHtml()}</div>` + controlsHtml() + `<div id="a2p-out" class="stack">${outHtml()}</div>`;
    return `<div class="page a2p-page" style="--page-max:1200px"><h2 class="sr-only">ALERT2 Transition Plan</h2><div class="stack" id="a2p-page">${body}</div></div>`;
  }

  function current() {
    const I = inventory();
    if (!I) return null;
    const M = model(I, sc);
    // The proposal, over every catchment in the scope and with the site
    // conditions as they are: what the figures say a scenario is more or less
    // than.
    const D = differs(sc, DEFAULTS) ? model(inventoryFor([]), sanitize({ ...DEFAULTS })) : null;
    return { I, M, D };
  }
  // Worked once per scenario: a repaint reads the plan a dozen times.
  let memo = null, memoKey = '';
  function cur() {
    const k = JSON.stringify(sc) + '|' + slsReady + '|' + condStamp;
    if (!memo || memoKey !== k || !cat || cat.data !== state.data) { memo = current(); memoKey = k; }
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
      <div id="a2p-scen-line">${scenLineHtml()}</div>
      <div id="a2p-people-box">${peopleHtml()}</div>
      ${slsReady ? '' : '<p class="small txt-muted">Owners and SLS priorities are still loading — the backbone ownership figures fill in when they arrive.</p>'}
    </div>`;
  }

  // The scenario this document is, said where it is printed.
  function scenLineHtml() {
    const L = loadedScenario();
    if (!L) return '';
    return `<p class="small a2p-scen-line">Scenario: <strong>${esc(L.name)}</strong>${L.mine ? '' : ` by ${esc(L.by || 'somebody else')}`}${
      changedSinceLoad() ? ' — changed since it was saved' : ''}${L.notes ? ` · ${esc(L.notes)}` : ''}</p>`;
  }

  function delta(now, was, kind) {
    if (was == null) return '';
    const d = now - was;
    const tiny = kind === 'money' ? Math.abs(d) < 5000 : kind === 'int' ? Math.abs(d) < 0.5 : Math.abs(d) < 0.05;
    if (tiny) return '<span class="a2p-delta">same as the proposal</span>';
    const up = d > 0;
    const txt = kind === 'money' ? money(Math.abs(d)) : kind === 'months' ? mo(Math.abs(d)) : kind === 'int' ? nf(Math.abs(d)) : nf1(Math.abs(d));
    return `<span class="a2p-delta ${up ? 'a2p-up' : 'a2p-down'}">${up ? '▲' : '▼'} ${txt} ${up ? 'more' : 'less'} than the proposal</span>`;
  }

  // Nothing ticked: nothing to convert, and the page says so rather than
  // drawing a plan of zeros.
  const emptyPlan = I => !I.field.length && !I.reps.length && !I.bases.length;

  function kpisHtml() {
    const C = cur();
    if (!C) return '';
    if (emptyPlan(C.I)) return '';
    const { M, D } = C;
    const s = sc;
    const tile = (label, value, sub, d, cls = '') => `<div class="adm-kpi a2p-kpi ${cls}">
        <div class="adm-kpi-label">${label}</div><div class="adm-kpi-value">${value}</div>
        <div class="adm-kpi-sub">${sub}</div>${d ? `<div class="adm-kpi-sub">${d}</div>` : ''}</div>`;
    return `<div class="adm-kpis a2p-kpis" role="group" aria-label="The plan in six figures">
      ${tile('Estimated cost', money(M.total), `including ${pct(s.contingency)} contingency`, D && delta(M.total, D.total, 'money'))}
      ${tile('Duration', mo(M.end), `${monthLabel(s, 0)} to ${endLabel(s, M.end)}`, D && delta(M.end, D.end, 'months'))}
      ${M.cats.length ? tile('Backbone on ALERT2', endLabel(s, M.bbReady), `every catchment · the first ${endLabel(s, M.firstCut)}`, D && delta(M.bbReady, D.bbReady, 'months')) : ''}
      ${tile('Effort', `${nf1(M.fteTotal)} <small>FTE-years</small>`, `peak ${nf1(M.peak)} FTE`, D && delta(M.fteTotal, D.fteTotal, 'n'))}
      ${tile('Equipment', `${nf(M.units.ertA2)} <small>ERT-A2</small>`, `${nf(M.units.e115)} ELPRO 115E-2 gateways`, D && delta(M.units.ertA2, D.units.ertA2, 'int'))}
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
    // Retrofits are what is left after the rebuilds: the two cannot pass 100%.
    if (c.k === 'retrofitPct' && Number(v) + Math.min(100, sc.rebuildPct) > 100) return `${nf(v)}% — ${nf(100 - Math.min(100, sc.rebuildPct))}% after the rebuilds`;
    if (c.zero && Number(v) === 0) {
      const I = inventory();
      return I ? `${basesDefault(I)}, ${I.partial ? 'scaled to the catchments ticked' : c.zero}` : c.zero;
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
        ${changed ? '<strong>This is not the proposal</strong>: the figures above say how far it moved from the proposal over every catchment.' : 'This is the proposal as drafted.'}
        The card is kept on this device; save it as a scenario to keep it for you, and share it when it is ready.</p>
      <section class="a2p-scen" id="a2p-scen" aria-labelledby="a2p-scen-h"><h4 id="a2p-scen-h">📁 Scenarios</h4>${scenHtml()}</section>
      <div class="a2p-ctl-grid">
        ${CONTROLS.map(g => `<fieldset class="a2p-fs"><legend>${esc(g.group)}</legend>${g.items.map(ctlHtml).join('')}</fieldset>`).join('')}
      </div>
      <details class="a2p-cats" id="a2p-cats"${catsOpen ? ' open' : ''} ontoggle="Alert2Plan.catsToggled(this.open)">
        <summary>Catchments in the plan — <span id="a2p-cats-n">${esc(catsCountText())}</span></summary>
        <div id="a2p-cats-body">${catsBodyHtml()}</div>
      </details>
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

  // ── saved scenarios ──
  // Where the card came from, the buttons to save it, and every scenario this
  // person may load: their own, private or shared, and the ones the
  // others have shared. Rows are numbered off `scenarios`, so no name has to
  // survive a trip through an onclick attribute.
  let scenListOpen = true;
  function scenHtml() {
    if (store === 'idle' || store === 'loading') return '<p class="small txt-muted">Loading the saved scenarios and site conditions…</p>';
    if (store === 'failed') {
      return `<p class="small"><span class="txt-warn">The saved scenarios and site conditions could not be loaded</span> — ${esc(storeError)}.
        <button type="button" class="link-btn" data-k="scen:retry" onclick="Alert2Plan.retryStore()">Try again</button></p>`;
    }
    const L = loadedScenario();
    const changed = changedSinceLoad();
    const dis = busy ? ' disabled' : '';
    const now = L
      ? `Working from <strong>${esc(L.name)}</strong> — ${L.mine ? 'yours' : `by ${esc(L.by || 'somebody else')}`}, ${L.shared ? 'shared with everybody who sees the plan' : 'private to you'}${
        changed ? '; <strong>changed since it was loaded</strong>' : ''}.${L.mine ? '' : ' Only its author can change it: save your own copy to keep your changes.'}`
      : 'The card is not saved as a scenario.';
    const mineN = scenarios.filter(x => x.mine).length, theirsN = scenarios.length - mineN;
    const row = (x, i) => `<tr${L && L.id === x.id ? ' class="a2p-scen-on"' : ''}>
        <th scope="row">${esc(x.name)}${x.notes ? `<span class="small txt-muted a2p-scen-notes">${esc(x.notes)}</span>` : ''}</th>
        <td>${x.mine ? 'You' : esc(x.by || '—')}</td>
        <td>${x.shared ? '<span class="badge a2p-shared">Shared</span>' : '<span class="badge a2p-private">Private</span>'}</td>
        <td class="small col-optional">${esc(whenText(x.updated_at))}</td>
        <td><span class="button-group a2p-scen-acts">
          <button type="button" class="exp-btn-sm" data-k="sload:${esc(x.id)}" onclick="Alert2Plan.scen('load', ${i})"${dis} aria-label="Load ${escAttr(x.name)}">Load</button>
          ${x.mine ? `<button type="button" class="exp-btn-sm" data-k="sshare:${esc(x.id)}" onclick="Alert2Plan.scen('share', ${i})"${dis}
              aria-label="${x.shared ? 'Make' : 'Share'} ${escAttr(x.name)}${x.shared ? ' private' : ' with everybody who sees the plan'}">${x.shared ? 'Make private' : 'Share'}</button>
            <button type="button" class="exp-btn-sm" data-k="sdel:${esc(x.id)}" onclick="Alert2Plan.scen('delete', ${i})"${dis} aria-label="Remove ${escAttr(x.name)}">Remove…</button>` : ''}
        </span></td></tr>`;
    const form = scenFormOpen ? `<form class="a2p-scen-form" id="a2p-scen-form" onsubmit="event.preventDefault(); Alert2Plan.scen('save')">
        <label class="a2p-ctl" for="a2p-scen-name"><span>Name</span>
          <input type="text" id="a2p-scen-name" maxlength="80" autocomplete="off" value="${escAttr(L && !changed ? '' : (L ? `${L.name} (changed)` : ''))}"></label>
        <label class="a2p-ctl" for="a2p-scen-notes"><span>Notes <span class="txt-muted">(optional)</span></span>
          <textarea id="a2p-scen-notes" maxlength="2000" rows="2"></textarea></label>
        <label class="check-label a2p-switch"><input type="checkbox" id="a2p-scen-share"><span>Share it with everybody who sees the plan now — otherwise only you see it until you share it</span></label>
        <div class="button-group">
          <button type="submit" class="primary exp-btn-sm" data-k="scen:save"${dis}>Save the scenario</button>
          <button type="button" class="exp-btn-sm" data-k="scen:cancel" onclick="Alert2Plan.scen('cancel')">Cancel</button>
        </div></form>` : '';
    return `<p class="small" id="a2p-scen-now">${now}</p>
      <div class="button-group">
        ${L && L.mine ? `<button type="button" class="primary exp-btn-sm" data-k="scen:update" onclick="Alert2Plan.scen('update')"${changed && !busy ? '' : ' disabled'}>Save changes to “${esc(L.name)}”</button>` : ''}
        <button type="button" class="exp-btn-sm" data-k="scen:new" aria-expanded="${scenFormOpen}" onclick="Alert2Plan.scen('form')"${dis}>Save as a new scenario…</button>
      </div>
      ${form}
      ${scenarios.length ? `<details class="a2p-scen-list" id="a2p-scen-list"${scenListOpen ? ' open' : ''} ontoggle="Alert2Plan.scenListToggled(this.open)">
        <summary>Saved scenarios — ${mineN} yours, ${theirsN} shared by others</summary>
        <div class="table-wrap"><table class="a2p-table a2p-scen-table">
          <caption class="sr-only">Saved scenarios you may load: your own, and the ones others who see the plan have shared</caption>
          <thead><tr><th scope="col">Scenario</th><th scope="col">By</th><th scope="col">Who sees it</th><th scope="col" class="col-optional">Saved</th><th scope="col">Actions</th></tr></thead>
          <tbody>${scenarios.map(row).join('')}</tbody></table></div></details>`
        : '<p class="small txt-muted">No scenario is saved yet. A private one is seen by nobody but you; a shared one by everybody who sees the plan.</p>'}`;
  }
  // The panel drawn again in place — after a load, a save or a change of
  // what is on its way — with what was typed in its form kept, and the
  // control pressed (or the one standing in for it) given focus back.
  function refreshStore(focusKey) {
    if (typeof document === 'undefined' || state.activeTab !== 'a2plan') return;
    const el = document.getElementById('a2p-scen');
    if (!el) return;
    const typed = {};
    for (const id of ['a2p-scen-name', 'a2p-scen-notes']) { const f = document.getElementById(id); if (f) typed[id] = f.value; }
    // Drawn again under somebody's hand: the control they are on stays theirs.
    const on = document.activeElement;
    if (!focusKey && on && el.contains(on)) focusKey = on.dataset && on.dataset.k ? on.dataset.k : (on.id ? `#${on.id}` : '');
    const box = document.getElementById('a2p-scen-share');
    const shareTicked = box ? box.checked : null;
    const h = el.querySelector('h4');
    el.innerHTML = (h ? h.outerHTML : '') + scenHtml();
    for (const [id, v] of Object.entries(typed)) { const f = document.getElementById(id); if (f) f.value = v; }
    const line = document.getElementById('a2p-scen-line');
    if (line) line.innerHTML = scenLineHtml();
    if (shareTicked != null) { const b = document.getElementById('a2p-scen-share'); if (b) b.checked = shareTicked; }
    if (focusKey) {
      const f = (focusKey[0] === '#' ? document.getElementById(focusKey.slice(1)) : el.querySelector(`[data-k="${CSS.escape(focusKey)}"]`))
        || el.querySelector('[data-k="scen:new"]');
      if (f && !f.disabled) f.focus();
    }
  }

  // ── who sees the plan (0076) ──
  // Under the heading: who the plan is shown to, folded. Everybody on the list
  // sees who else is — they are who a shared scenario is shared with — and a
  // nominator adds people by the address they sign in with, lets them
  // nominate too, and takes them off. Rows are numbered off `people`.
  function peopleHtml() {
    if (people === null) {
      return store === 'ready' ? '<p class="small txt-muted">Listed to administrators only.</p>'
        : '<p class="small txt-muted">Seen only by the people nominated to it.</p>';
    }
    const nom = mayNominate();
    const dis = busy ? ' disabled' : '';
    const n = people.length;
    const names = people.map(x => (x.you ? 'you' : x.who || x.email || '—'));
    const said = n === 1 && people[0].you ? 'you alone' : `${n} ${n === 1 ? 'person' : 'people'} — ${names.slice(0, 4).join(', ')}${n > 4 ? ` and ${n - 4} more` : ''}`;
    const row = (x, i) => `<tr>
        <th scope="row">${esc(x.who || x.email || '—')}${x.you ? ' <span class="badge">you</span>' : ''}${
          x.email && x.email !== x.who ? `<span class="small txt-muted a2p-people-mail">${esc(x.email)}</span>` : ''}</th>
        <td>${nom ? `<label class="check-label"><input type="checkbox" data-k="pnom:${esc(x.id)}"${x.nominates ? ' checked' : ''}${dis}
              onchange="Alert2Plan.person('nominates', ${i}, this.checked)"><span class="sr-only">${escAttr(x.who || x.email || '')} may nominate</span></label>`
          : x.nominates ? 'Yes' : 'No'}</td>
        <td class="small col-optional">${esc(whenText(x.added_at))}${x.added_by ? ` by ${esc(x.added_by)}` : ''}</td>
        ${nom ? `<td><button type="button" class="exp-btn-sm" data-k="pdel:${esc(x.id)}" onclick="Alert2Plan.person('remove', ${i})"${dis}
              aria-label="Take ${escAttr(x.who || x.email || '')} off the list">Take off…</button></td>` : ''}
      </tr>`;
    const form = nom ? `<form class="a2p-scen-form a2p-people-form" onsubmit="event.preventDefault(); Alert2Plan.person('add')">
        <label class="a2p-ctl" for="a2p-people-email"><span>Add somebody, by the address they sign in with</span>
          <input type="email" id="a2p-people-email" maxlength="254" autocomplete="off" spellcheck="false"></label>
        <label class="check-label a2p-switch"><input type="checkbox" id="a2p-people-nom"><span>They may nominate others too</span></label>
        <div class="button-group"><button type="submit" class="primary exp-btn-sm" data-k="ppl:add"${dis}>Add to the list</button></div>
        <p class="small txt-muted">They need an approved account first. An administrator sees the plan only from this list, like anybody else.</p>
      </form>` : '<p class="small txt-muted">Only somebody who may nominate changes who sees it.</p>';
    return `<details class="a2p-people" id="a2p-people"${peopleOpen ? ' open' : ''} ontoggle="Alert2Plan.peopleToggled(this.open)">
        <summary>Seen by ${esc(said)}</summary>
        <div class="table-wrap"><table class="a2p-table a2p-people-table">
          <caption class="sr-only">Who sees the ALERT2 Transition Plan, and who may change that</caption>
          <thead><tr><th scope="col">Person</th><th scope="col">May nominate</th><th scope="col" class="col-optional">Added</th>${
            nom ? '<th scope="col"><span class="sr-only">Actions</span></th>' : ''}</tr></thead>
          <tbody>${people.map(row).join('')}</tbody></table></div>
        ${form}
      </details>`;
  }
  // The list drawn again in place, keeping what was typed and the control
  // pressed (or the add button, standing in for one that has gone).
  function refreshPeople(focusKey) {
    if (typeof document === 'undefined' || state.activeTab !== 'a2plan') return;
    const el = document.getElementById('a2p-people-box');
    if (!el) return;
    const mail = document.getElementById('a2p-people-email'), nomBox = document.getElementById('a2p-people-nom');
    const typed = mail ? mail.value : null, ticked = nomBox ? nomBox.checked : null;
    const on = document.activeElement;
    if (!focusKey && on && el.contains(on)) focusKey = on.dataset && on.dataset.k ? on.dataset.k : (on.id ? `#${on.id}` : '');
    el.innerHTML = peopleHtml();
    if (typed != null) { const f = document.getElementById('a2p-people-email'); if (f) f.value = typed; }
    if (ticked != null) { const b = document.getElementById('a2p-people-nom'); if (b) b.checked = ticked; }
    if (focusKey) {
      const f = (focusKey[0] === '#' ? document.getElementById(focusKey.slice(1)) : el.querySelector(`[data-k="${CSS.escape(focusKey)}"]`))
        || el.querySelector('[data-k="ppl:add"]');
      if (f && !f.disabled) f.focus();
    }
  }

  // ── the catchment picker ──
  // Every catchment in the scope, under its region: a box for each, and a box
  // for the region that ticks or clears all of its catchments at once (and
  // shows a dash when only some are ticked). The boxes are numbered off the
  // catalogue's flat list, so no name has to survive a trip through an
  // onclick attribute.
  function catsCountText() {
    const C = catalogue();
    if (!C) return '';
    const ex = new Set(sc.excluded || []);
    const n = C.flat.filter(c => !ex.has(c.key)).length;
    return n === C.flat.length ? `all ${n}` : `${n} of ${C.flat.length}`;
  }
  function catsBodyHtml() {
    const C = catalogue();
    if (!C) return '';
    const ex = new Set(sc.excluded || []);
    let i = 0;
    const regs = C.groups.map((g, gi) => {
      const on = g.cats.filter(c => !ex.has(c.key)).length;
      const stations = g.cats.reduce((a, c) => a + c.field + c.repeaters, 0);
      const boxes = g.cats.map(c => {
        const k = i++;
        return `<label class="check-label a2p-cat"><input type="checkbox" data-k="cat:${k}" ${ex.has(c.key) ? '' : 'checked'}
            onchange="Alert2Plan.catchment(${k}, this.checked)"><span>${esc(c.name)} <span class="txt-muted">${nf(c.field + c.repeaters)}</span></span></label>`;
      }).join('');
      return `<fieldset class="a2p-cat-reg">
        <legend><label class="check-label a2p-cat-all"><input type="checkbox" data-k="reg:${gi}" ${on ? 'checked' : ''}
            data-partial="${on && on < g.cats.length ? '1' : ''}" onchange="Alert2Plan.region(${gi}, this.checked)"
            aria-describedby="a2p-reg-${gi}-n"><span><span class="a2p-swatch" style="--c:${regionVar(g.region)}" aria-hidden="true"></span><strong>${esc(g.region)}</strong></span></label>
          <span class="small txt-muted" id="a2p-reg-${gi}-n">${on} of ${g.cats.length} catchment${g.cats.length === 1 ? '' : 's'} · ${nf(stations)} sites</span></legend>
        <div class="a2p-cat-grid">${boxes}</div>
      </fieldset>`;
    }).join('');
    return `<p class="small">Untick a catchment to leave it out: its field stations, repeaters and bases leave the plan, and every figure
        follows. A repeater outside the ticked catchments stays in if it carries a station inside them, and the plan says so. The number
        beside each catchment is its field stations and repeaters.</p>
      <div class="button-group a2p-cat-acts">
        <button type="button" class="exp-btn-sm" data-k="cats:all" onclick="Alert2Plan.catchments('all')">Tick every catchment</button>
        <button type="button" class="exp-btn-sm" data-k="cats:none" onclick="Alert2Plan.catchments('none')">Clear every catchment</button>
        <button type="button" class="exp-btn-sm" data-k="cats:high" onclick="Alert2Plan.catchments('high')"${slsReady ? '' : ' disabled'}>Only those with High-priority SLS sites</button>
      </div>
      <div class="a2p-cat-regs">${regs}</div>`;
  }
  // A box shows a dash for "some": a property, not an attribute, so it is set
  // after every paint of the picker.
  function syncPartial() {
    for (const el of document.querySelectorAll('#a2p-cats-body input[data-partial]')) el.indeterminate = el.dataset.partial === '1';
  }
  // The ticks changed: the picker and the card's few words that depend on
  // them are rewritten in place, the box that was pressed keeps its focus,
  // and the figures and the document are worked again.
  // The picker and the words that depend on what it lists, rewritten in
  // place. Also after the scope changes: the boxes are numbered off the
  // catalogue, so a list drawn for another scope must not stay clickable.
  function refreshCats() {
    const body = document.getElementById('a2p-cats-body');
    if (body) { body.innerHTML = catsBodyHtml(); syncPartial(); }
    const n = document.getElementById('a2p-cats-n');
    if (n) n.textContent = catsCountText();
    const c = CONTROLS.flatMap(g => g.items).find(x => x.k === 'basesN');
    const out = document.getElementById('a2p-c-basesN-o');
    if (c && out) { out.textContent = ctlValue(c, sc.basesN); document.getElementById('a2p-c-basesN').setAttribute('aria-valuetext', out.textContent); }
  }
  function catsChanged(focusKey, said) {
    saveScenario();
    refreshCats();
    repaintLive();
    if (focusKey) {
      // The box pressed, or — when the press came from outside a folded
      // picker (the empty plan's own button) — the picker's summary, so focus
      // is never left on the page itself.
      const el = document.querySelector(`#a2p-cats-body [data-k="${CSS.escape(focusKey)}"]`);
      const open = document.getElementById('a2p-cats');
      if (el && !el.disabled && open && open.open) el.focus();
      else if (open) open.querySelector('summary').focus();
    }
    if (said) announce(said);
  }
  function setExcluded(keys) {
    sc.excluded = [...new Set(keys)].sort();
    sc = sanitize(sc);
  }

  // ── the document ──
  function outHtml() {
    const C = cur();
    if (!C) return '';
    if (emptyPlan(C.I)) {
      return `<div class="panel a2p-empty"><h3>No catchment is ticked</h3>
        <p class="small">With nothing ticked under <strong>Catchments in the plan</strong> there is nothing to convert. Tick a catchment, a region,
          or <button type="button" class="link-btn" onclick="Alert2Plan.catchments('all')">every catchment</button>, and the plan is worked again.</p></div>`;
    }
    return [summaryHtml(C), whyHtml(), whereHtml(C), equipmentHtml(C), backboneHtml(C), cutoverHtml(C), reviewsHtml(C),
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
    const pace = !M.fieldOn ? ''
      : slow && M.waits > 1
      ? `The field crews wait about ${mo(M.waits)} in all for other work to be ready — longest before ${esc(slow.name)}, for ${esc(slow.gate)} — so ${
          slow.gate.includes('review') ? 'another review team' : slow.gate.includes('backbone') || slow.gate.includes('bases') ? 'more crews on the backbone' : 'faster acquisition'} would shorten it.`
      : `The field crews set the pace: ${s.fieldCrews} crew${s.fieldCrews === 1 ? '' : 's'} take about ${mo(M.fieldMonths)} to reach every station, and nothing else holds them up.`;
    const ncat = M.cats.filter(c => c.cutover != null).length;
    return sec('sum', '1. Summary', `
      <p>${I.partial ? `The ${nf(I.catchmentCount)} catchments ticked hold` : 'The register lists'} <strong>${nf(M.nField)} ALERT field stations</strong> (${nf(M.nRain)} rainfall, ${nf(M.nLevel)} river height),
        <strong>${nf(M.nRep0)} repeaters</strong> — ${nf(M.bbCount)} of them carrying the backbone — and the network is received at
        <strong>${nf(M.nBases)} base stations</strong>, across ${regions} region${regions === 1 ? '' : 's'} and ${nf(I.catchmentCount)} catchments.
        This draft moves the backbone to ALERT2 first, one catchment at a time, ${M.fieldOn ? 'and then the field stations behind it' : 'and leaves the field stations on ALERT1, carried by ALERT2 concentrators'}.${I.partial
          ? ` <strong>It covers ${nf(I.catchmentCount)} of the ${nf(I.catchmentsInScope)} catchments in scope</strong> — the ones ticked on the card${
            I.outsideReps ? `, and ${nf(I.outsideReps)} repeater${I.outsideReps === 1 ? '' : 's'} outside them that carr${I.outsideReps === 1 ? 'ies' : 'y'} their stations or relay${I.outsideReps === 1 ? 's' : ''} them to a base` : ''}.` : ''}</p>
      <ul class="a2p-points">
        <li><strong>Cost:</strong> about <strong>${money(M.total)}</strong>, including ${pct(s.contingency)} contingency — ${money(M.breakdown[0].v)} of it equipment, ${money(M.breakdown[3].v)} the backbone sites.</li>
        <li><strong>Time:</strong> about <strong>${mo(M.end)}</strong>, from approval in ${monthLabel(s, 0)} to close-out in ${endLabel(s, M.end)}.</li>
        <li><strong>Effort:</strong> <strong>${nf1(M.fteTotal)} FTE-years</strong>, peaking at ${nf1(M.peak)} FTE — ${nf1(M.fteYears.field)} of them in the field.</li>
        <li><strong>Equipment:</strong> ${nf(M.units.ertA2)} ELPRO ERT-A2 units (${M.fieldOn ? 'field, repeater and base' : 'repeater and base'}) and ${nf(M.units.e115)} ELPRO 115E-2 gateways.</li>
        <li><strong>The backbone first, catchment by catchment:</strong> ${M.nAcq ? `acquire about ${nf(M.nAcq)} backbone repeater site${M.nAcq === 1 ? '' : 's'} the Bureau does not own, from about ${nf(M.nOwners)} owner${M.nOwners === 1 ? '' : 's'}; ` : ''}audit
          ${nf(M.nAudit)} site${M.nAudit === 1 ? '' : 's'} not yet assessed, retrofit about ${nf(M.nRetro)} and rebuild the structure of about ${nf(M.nRebuild)}, starting
          ${M.bf ? 'now — none of it needs ALERT2 equipment' : `with the equipment in ${monthLabel(s, M.P)}`}. ${M.bf && ncat
            ? `The first catchment is on the ALERT2 backbone in <strong>${endLabel(s, M.firstCut)}</strong> and ${ncat === M.cats.length ? `all ${nf(ncat)}` : `all ${nf(ncat)} a repeater on record carries`} by <strong>${endLabel(s, M.bbReady)}</strong> —
               their stations' readings travel as ALERT2 from the first repeater on, before a field station is touched.` : ''}</li>
        ${M.fieldOn ? `<li><strong>Then the field:</strong> each catchment's field stations take an ERT-A2 once its backbone is ALERT2, the last in ${endLabel(s, M.fieldEnd)}.</li>`
          : `<li><strong>The field stations stay ALERT1</strong> in this scenario, concentrated at their first repeater; they take an ERT-A2 on an FWIN visit or at renewal, outside this plan.</li>`}
        ${s.reviews ? `<li><strong>Network reviews:</strong> each region's network is reviewed before its field work, and before any structure in it is rebuilt — expected to add about ${M.added} repeater${M.added === 1 ? '' : 's'} and retire about ${M.removed}.</li>` : ''}
        ${s.fwinPct && M.fieldOn ? `<li><strong>With FWIN:</strong> about ${nf(M.nField * s.fwinPct / 100)} field stations (${pct(s.fwinPct)}) take their ERT-A2 on a visit the Bureau's FWIN upgrade program is already making, rather than one of their own.</li>` : ''}
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
        already decodes ALERT2 — the concentration records an ERT-A2 sends on for an ALERT1 station among it — has taken readings from a
        115E-2 trial and the workshop's ERT-A2, and stores them: the data side is proven before the radio side starts.</p>
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
      .map(c => `<tr><td>${esc(x.name)}</td><th scope="row">${esc(c.name)}${c.outside ? ' <span class="small txt-muted">— unticked; its repeaters carry ticked stations</span>' : ''}</th><td class="a2p-num">${nf(c.rain)}</td><td class="a2p-num">${nf(c.level)}</td>
        <td class="a2p-num">${nf(c.repeaters)}</td><td class="a2p-num">${nf(c.backbone)}</td><td class="a2p-num">${nf(c.bases)}</td></tr>`));
    return sec('where', '3. Where the work is', `
      <p>${nf(M.nField)} field stations and ${nf(M.nRep0)} repeaters in ${I.regions.length} regions and ${nf(I.catchmentCount)} catchments, taken a region at a time in the order below
        (▲ ▼ change it — the timeline follows), and within a region a catchment at a time (section 6). The order proposed puts the regions with the most High-priority SLS sites first;
        ${s.pilot ? `the pilot network is the first catchment's backbone${M.fieldOn ? ` and the first ${nf(Math.min(s.pilotSites, M.nField))} of its stations` : ''}.` : 'there is no pilot in this scenario.'}
        Base stations are counted from the register's ${I.radioNetworks} radio networks${sc.basesN ? ` — overridden on the card to ${sc.basesN}`
          : I.partial ? `, scaled to the stations ticked (${nf(M.nBases)})` : ''};
        the register marks ${I.registerBases} site${I.registerBases === 1 ? '' : 's'} with the base role${I.partial ? ' in the catchments ticked' : ''}.${I.partial
          ? ` ${nf(I.catchmentsInScope - I.catchmentCount)} catchment${I.catchmentsInScope - I.catchmentCount === 1 ? ' is' : 's are'} unticked on the card${
            sc.scope === 'qld' ? ', and grey on the map' : ' — the Queensland basins among them grey on the map'}.` : ''}</p>
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
    const basinOf = new Map((state.data.catchments || []).map(c => [c.name.toLowerCase(), c]));
    const active = new Set(I.regions.map(r => r.name));
    const ex = new Set(sc.excluded || []);
    const polys = B.list.map(b => {
      const c = basinOf.get(b.name.toLowerCase());
      const reg = c && c.region;
      const on = reg && active.has(reg) && !ex.has(c.id);
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
      <p>One ELPRO ERT-A2 goes to every repeater — configured as a concentrator where it hears ALERT1 stations, to repeat ALERT2 where it
        relays — and to every base receive chain${M.fieldOn ? ', and then to every field station' : '; the field stations keep their ALERT1 encoders in this scenario'}. One ELPRO 115E-2 sits
        behind each base receiver as its gateway to the data network (its ALERT2 gateway needs a licence key and firmware 2.33 or later).
        ${M.fieldOn ? 'River stations keep their level sensors, which the ERT-A2 reads. ' : ''}The quantities follow the card; the site works at the repeaters are in section 5.</p>
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
  // Every repeater in the plan in the order the site table lists them — by
  // region, then name — so a site's select is numbered off this list and no
  // id has to survive a trip through an onchange attribute.
  function sitesOf(I) {
    return I.reps.slice().sort((a, b) => a.p.region.localeCompare(b.p.region) || String(a.s.name).localeCompare(String(b.s.name)) || String(a.s.id).localeCompare(String(b.s.id)));
  }
  function worksText(r) {
    const m = conditions[r.s.id];
    if (m) return WORKS_LABEL[m];
    return r.backbone ? 'Not assessed — audited first' : 'Fit-out (not backbone)';
  }
  function whenText(at) {
    const d = at ? new Date(at) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }
  // Who set a site's condition, and when — or that it is on its way.
  function setByText(id) {
    const b = condBy.get(id);
    if (!b) return '';
    if (b.pending) return 'saving…';
    const when = whenText(b.at);
    return `set by ${b.by || 'somebody who sees the plan'}${when ? `, ${when}` : ''}`;
  }
  function roleText(r) {
    return r.conc && r.relay ? 'Concentrator and relay' : r.conc ? 'Concentrator' : r.relay ? 'Relay to a base' : 'On a ticked catchment\'s ground';
  }
  function mixOf(s) {
    const reb = Math.min(100, s.rebuildPct), ret = Math.min(s.retrofitPct, 100 - reb);
    return { reb, ret, fit: 100 - reb - ret };
  }
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
    const catName = new Map(I.catList.map(c => [c.key, c.name]));
    const row = r => `<tr><th scope="row">${esc(r.s.name)}${r.outside ? ' <span class="small txt-muted">— outside the catchments ticked</span>' : ''}</th><td>${esc(r.p.region)}</td><td class="a2p-num">${nf(r.carries)}</td>
      <td class="a2p-num">${nf(r.cats.size)}</td><td>${esc(worksText(r))}</td>
      <td>${esc(r.owner.name || OWN[r.owner.cls])}</td><td class="col-optional">${r.s.repeater && r.s.repeater.acma_licence ? esc(r.s.repeater.acma_licence) : '<span class="txt-warn">none on file</span>'}</td></tr>`;
    const head = `<thead><tr><th scope="col">Repeater</th><th scope="col">Region</th><th scope="col" class="a2p-num">Stations carried</th>
      <th scope="col" class="a2p-num">Catchments</th><th scope="col">Site condition</th>
      <th scope="col">Owner</th><th scope="col" class="col-optional">ACMA licence</th></tr></thead>`;
    const noLicence = bb.filter(r => !(r.s.repeater && r.s.repeater.acma_licence)).length;
    const mix = mixOf(s);
    const list = sitesOf(I);
    const ready = store === 'ready';
    const siteRow = (r, i) => {
      const m = conditions[r.s.id] || '';
      const id = `a2p-site-${i}`;
      const needs = [...r.cats].map(k => catName.get(k)).filter(Boolean);
      return `<tr><th scope="row">${esc(r.s.name)}${r.outside ? ' <span class="small txt-muted">— outside the ticks</span>' : ''}</th>
        <td>${esc(r.p.region)}</td><td>${esc(roleText(r))}${r.backbone ? '' : ' <span class="small txt-muted">· not backbone</span>'}${r.routed || !r.conc ? '' : ' <span class="small txt-warn">· no path to a base on record</span>'}</td>
        <td class="small">${esc(needs.length > 4 ? `${needs.slice(0, 4).join(', ')} and ${needs.length - 4} more` : needs.join(', '))}</td>
        <td><select id="${id}" data-k="site:${i}" aria-label="Site condition of ${escAttr(r.s.name)}" aria-describedby="${id}-by" onchange="Alert2Plan.site(${i}, this.value)"${ready ? '' : ' disabled'}>
          <option value=""${m ? '' : ' selected'}>Not assessed</option>
          ${WORKS.map(k => `<option value="${k}"${m === k ? ' selected' : ''}>${esc(WORKS_LABEL[k])}</option>`).join('')}
        </select><span class="small txt-muted a2p-site-by" id="${id}-by">${esc(setByText(r.s.id))}</span></td>
        <td>${esc(r.owner.name || OWN[r.owner.cls])}</td></tr>`;
    };
    return sec('bb', '5. The backbone — remediated and moved to ALERT2 first, catchment by catchment', `
      <p>The backbone is the chain of hilltop repeaters every reading travels along to reach a base — by the register,
        <strong>${nf(M.bbCount)} of the ${nf(M.nRep0)} repeaters</strong> share a pass-range window with another repeater or a base
        within ${s.backboneKm} km${I.partial ? ` — counting only the repeaters in the plan: those in the catchments ticked, and ${nf(I.outsideReps)} outside them that carry their stations or relay them to a base` : ''}.
        Whatever happens in the field, these sites carry it, legacy and ALERT2 alike. The plan treats them as a stream of work of its
        own that starts ahead of everything else, and moves the network over on it one catchment at a time.</p>
      <h4>Concentration: ALERT1 in, ALERT2 on</h4>
      <p>The field stations are left as they are. Every repeater that hears one of a catchment's stations is fitted with an ERT-A2
        configured as a <strong>concentrator</strong>: it hears the station's legacy ALERT burst and sends the reading on in its own
        GPS-timed ALERT2 slot. Every repeater from there to a base is fitted to repeat ALERT2 — an ALERT1 repeater cannot carry it, so
        the whole way has to be done — and the base receives ALERT2 through a 115E-2. When the last of them is done the catchment is
        <strong>cut over</strong>: its readings travel as ALERT2 from their first repeater on, without a visit to one of its stations.
        Section 6 sets out each catchment's.${M.fieldOn ? ' Its field stations then take their own ERT-A2s, to finish the job.' : ''}</p>
      <h4>What each site needs</h4>
      <ul class="a2p-points">
        <li><strong>Fit-out only</strong> — the site is sound: the ERT-A2 in place of the ALERT1 repeater, a GPS antenna for its slot,
          the antenna and coax checked. Bureau tower crews, ${nf1(s.fitDays)} crew-days a site. <em>${nf(M.nFitOnly)} site${M.nFitOnly === 1 ? '' : 's'} in this scenario.</em></li>
        <li><strong>Retrofit</strong> — the structure stands but the site needs work before it carries the network on: solar and batteries
          sized for the ERT-A2's draw, antenna and coax, the enclosure, earthing and surge protection, access. Contract crews,
          ${nf1(s.remediateDays)} crew-days and about ${money(s.cRemed)} a site. <em>${nf(M.nRetro)} site${M.nRetro === 1 ? '' : 's'}.</em></li>
        <li><strong>Rebuild the structure</strong> — the mast or tower, its footings or guys, or the shelter is not fit to carry the network
          another twenty years, and is remediated or replaced. A structural design, approvals and fabrication first (${s.rebuildLeadMonths}
          months from its audit${s.reviews ? ', and not before its network\'s review has kept the site' : ''}), then ${nf(s.rebuildDays)} crew-days of
          structural contract works and about ${money(s.cRebuild)}, with a temporary repeater on a trailer mast (${money(s.cTemp)}) so the
          catchment is never without one. <em>${nf(M.nRebuild)} site${M.nRebuild === 1 ? '' : 's'}.</em></li>
      </ul>
      <p>A site nobody has assessed is <strong>audited first</strong> — a rigger's climb and a structural report, about ${money(s.cAudit)} — and
        until then is costed at the card's mix: ${pct(mix.fit)} fit-out only, ${pct(mix.ret)} retrofit, ${pct(mix.reb)} rebuilt, allotted
        catchment by catchment. ${M.nKnown
          ? `<strong>${nf(M.nKnown)} site${M.nKnown === 1 ? ' has its' : 's have their'} site condition set</strong> below from what is known, and ${M.nKnown === 1 ? 'is' : 'are'} costed at that.`
          : 'When you know what a site needs, set its site condition in the table below: it is costed at that rather than the mix, it skips the audit, and the plan follows.'}</p>
      <h4>Why the backbone goes first</h4>
      <ol class="a2p-points">
        <li><strong>Most of it needs no ALERT2 equipment.</strong> Acquisition is property and legal work; audits, retrofits and
          rebuilds are power, structures, enclosures, earthing and access. All of it can start on approval — or before it, from existing budgets.</li>
        <li><strong>The Bureau cannot upgrade, licence or maintain a site it does not control.</strong> ${slsReady
          ? `By the SLS and the register, ${M.own.bureau} backbone site${M.own.bureau === 1 ? ' is' : 's are'} the Bureau's, ${M.own.joint} shared,
             ${M.own.other} another owner's — mostly councils — and ${M.own.unknown} ha${M.own.unknown === 1 ? 's' : 've'} no owner on record.`
          : 'Ownership is still loading from the SLS.'}
          Acquisition has the longest lead time of anything in the plan — an owner's agreement is assumed to take ${s.acqLeadMonths} months — so it has to start first,
          and FWIN is already negotiating with most of the same councils for their gauges.</li>
        <li><strong>Concentration moves a whole catchment at once.</strong> Once its repeaters are ERT-A2s, its legacy stations reach the base
          over ALERT2 — the backbone can move before a single field station does, and the field work can go at its own pace.</li>
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
        ${M.nAcq ? `from about ${nf(M.nOwners)} owner${M.nOwners === 1 ? '' : 's'} — one agreement an owner, ${s.acqParallel} negotiated at once, ${s.acqLeadMonths} months each — finishing ${endLabel(s, M.acqEnd)}` : ''};
        <strong>${nf(M.nAudit)} audited</strong>, <strong>${nf(M.nRetro)} retrofitted</strong> and <strong>${nf(M.nRebuild)} rebuilt</strong>${M.bf && M.cats.length
          ? `, and every catchment on the ALERT2 backbone by ${endLabel(s, M.bbReady)}` : ''}.
        ${noLicence ? `${noLicence} backbone repeater${noLicence === 1 ? ' has' : 's have'} no ACMA licence on file in the register — each needs one confirmed, or applied for, before it transmits ALERT2.` : ''}</p>
      <div class="table-wrap"><table class="a2p-table">
        <caption>The backbone repeaters carrying the most stations${bb.length > top.length ? ` — ${top.length} of ${bb.length}` : ''}</caption>
        ${head}<tbody>${top.map(row).join('')}</tbody></table></div>
      <details class="a2p-more" id="a2p-sites"><summary>Site conditions — what each of the ${nf(list.length)} repeaters in the plan needs, as known</summary>
        <p class="small">A site with its condition set is costed at that, and not audited. A backbone site left <em>Not assessed</em> is audited and costed at the card's mix;
          a repeater that is not backbone is fitted out as it stands.
          ${ready ? 'Site conditions are kept in the database — one answer per site, the same for everybody who sees the plan — whatever scenario is loaded.'
            : store === 'failed' ? `<span class="txt-warn">The site conditions could not be loaded (${esc(storeError)}), so none can be set.</span>`
            : 'The site conditions are loading.'}</p>
        <div class="table-wrap medium" role="region" tabindex="0" aria-label="What each repeater site needs"><table class="a2p-table">
          <caption class="sr-only">Every repeater in the plan: its role, the catchments that need it, and its site condition</caption>
          <thead><tr><th scope="col">Repeater</th><th scope="col">Region</th><th scope="col">Role</th><th scope="col">Catchments that need it</th>
            <th scope="col">Site condition</th><th scope="col">Owner</th></tr></thead>
          <tbody>${list.map(siteRow).join('')}</tbody></table></div></details>`);
  }

  // ── the cut-over, catchment by catchment ──
  // How many of the plan's field stations ride an ALERT2 backbone, and how
  // many are ALERT2 themselves, at each month boundary.
  function stationsOverTime(M, N) {
    const on = [], conv = [];
    for (let m = 0; m <= N; m++) {
      let a = 0, b = 0;
      for (const r of M.cats) {
        if (r.cutover != null && r.cutover <= m + 1e-9) a += r.carried;
        if (!M.fieldOn) continue;
        if (r.pilotHere && M.pilotEnd <= m + 1e-9) b += r.pilotHere;
        const rest = r.field - (r.pilotHere || 0);
        if (!rest) continue;
        if (r.work > 0) {
          let done = 0;
          r.by.forEach((v, j) => { if (j < m && v) done += v; });
          b += rest * Math.min(1, done / r.work);
        } else if (r.end <= m + 1e-9) b += rest;
      }
      on.push(a); conv.push(b);
    }
    return { on, conv };
  }
  function cutoverSvg(M) {
    const s = sc;
    const rows = M.cats.filter(r => r.cutover != null);
    if (!rows.length || !M.nField) return '';
    const N = Math.max(12, Math.ceil(M.end));
    const W = 980, H = 250, L = 48, RM = 170, T = 14, B = 28;
    const x = m => L + (m / N) * (W - L - RM);
    const y = v => T + (1 - v / M.nField) * (H - T - B);
    const steps = rows.slice().sort((a, b) => a.cutover - b.cutover);
    const carried = steps.reduce((a, r) => a + r.carried, 0);
    if (!carried) return '';
    let d = `M${x(0).toFixed(1)} ${y(0).toFixed(1)}`, n = 0, half = null;
    const dots = [];
    for (const r of steps) {
      if (!r.carried) continue;
      d += ` H${x(r.cutover).toFixed(1)}`;
      n += r.carried;
      d += ` V${y(n).toFixed(1)}`;
      if (half == null && n >= carried / 2) half = r.cutover;
      dots.push(`<circle class="a2p-cut" cx="${x(r.cutover).toFixed(1)}" cy="${y(n).toFixed(1)}" r="4"><title>${esc(r.name)}: on the ALERT2 backbone ${endLabel(s, r.cutover)}, ${nf(r.carried)} station${r.carried === 1 ? '' : 's'} (${nf(n)} in all)</title></circle>`);
    }
    d += ` H${x(N).toFixed(1)}`;
    const T2 = stationsOverTime(M, N);
    let conv = '';
    if (M.fieldOn) conv = `<path class="a2p-l2" d="${T2.conv.map((v, m) => `${m ? 'L' : 'M'}${x(m).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')}"/>`;
    let axis = '';
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const v = Math.round(M.nField * f);
      axis += `<line class="a2p-grid" x1="${L}" y1="${y(v).toFixed(1)}" x2="${(W - RM).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="a2p-axis" x="${L - 6}" y="${y(v).toFixed(1)}" text-anchor="end">${nf(v)}</text>`;
    }
    for (let m = 0; m < N; m++) if (calOf(s, m).m === 0) axis += `<text class="a2p-axis" x="${x(m).toFixed(1)}" y="${H - 8}">${calOf(s, m).y}</text>`;
    const lastConv = T2.conv[T2.conv.length - 1];
    // Direct labels at the right, held apart when the two lines end close.
    let ya = y(carried), yb = y(lastConv);
    if (M.fieldOn && Math.abs(ya - yb) < 16) { if (ya <= yb) { yb = ya + 16; } else { ya = yb + 16; } }
    const labA = `<text class="a2p-lab" x="${(W - RM + 8).toFixed(1)}" y="${ya.toFixed(1)}">On the backbone · ${nf(carried)}</text>`;
    const labB = M.fieldOn ? `<text class="a2p-lab" x="${(W - RM + 8).toFixed(1)}" y="${yb.toFixed(1)}">ALERT2 themselves · ${nf(lastConv)}</text>` : '';
    const title = `Field stations on the ALERT2 backbone: half of the ${nf(carried)} a repeater carries by ${endLabel(s, half == null ? M.bbReady : half)}, all by ${endLabel(s, M.bbReady)}${
      M.fieldOn ? `; all ${nf(M.nField)} converted themselves by ${endLabel(s, M.fieldEnd)}` : ''}`;
    return `<svg class="a2p-cutover" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="a2p-cut-t a2p-cut-d">
      <title id="a2p-cut-t">${esc(title)}</title>
      <desc id="a2p-cut-d">A step for each catchment as it is cut over to the ALERT2 backbone, rising to every field station in the plan${M.fieldOn ? '; a dashed line for the stations converted to ALERT2 themselves, which follows behind' : ''}. The table below lists each catchment's date.</desc>
      ${axis}${conv}<path class="a2p-l1" d="${d}"/>${dots.join('')}${labA}${labB}</svg>`;
  }
  function cutoverHtml({ I, M }) {
    const s = sc;
    const rows = M.cats;
    const noPath = rows.filter(r => r.noPath > 0);
    const worksCell = r => {
      const bits = [];
      if (r.w.retrofit) bits.push(`${r.w.retrofit} retrofit`);
      if (r.w.rebuild) bits.push(`${r.w.rebuild} rebuilt`);
      if (r.w.fit) bits.push(`${r.w.fit} fit-out`);
      const guessed = r.w.audit ? ` <span class="small txt-muted">· ${r.w.audit} to audit</span>` : '';
      return (bits.length ? `${r.w.audit ? '≈ ' : ''}${bits.join(' · ')}` : '—') + guessed;
    };
    const tr = (r, i) => {
      const prevSame = i > 0 && rows[i - 1].region === r.region;
      const nextSame = i < rows.length - 1 && rows[i + 1].region === r.region;
      return `<tr><td class="col-optional">${i + 1}</td>
        <th scope="row"><span class="a2p-swatch" style="--c:${regionVar(r.region)}" aria-hidden="true"></span>${esc(r.name)} <span class="small txt-muted">${esc(r.region)}</span></th>
        <td class="a2p-num">${nf(r.field)}</td>
        <td class="a2p-num">${nf(r.needs.length)}${r.shared ? ` <span class="small txt-muted">(${nf(r.fresh)} new)</span>` : ''}</td>
        <td>${worksCell(r)}</td>
        <td class="a2p-num">${money(r.worksCost)}</td>
        <td>${r.cutover != null ? endLabel(s, r.cutover) : '<span class="txt-muted">— no repeater on record</span>'}</td>
        <td class="col-optional small">${esc(M.bf ? r.cutGate || '' : 'with its field work')}</td>
        ${M.fieldOn ? `<td class="col-optional">${r.work > 0 || r.end > r.start ? `${monthLabel(s, r.start)} – ${endLabel(s, r.end)}` : '—'}</td>` : ''}
        <td><span class="button-group a2p-move">
          <button type="button" class="exp-btn-sm" data-k="cup:${escAttr(r.key)}" onclick="Alert2Plan.moveCat(${i}, -1)" ${prevSame ? '' : 'disabled'} aria-label="Cut ${escAttr(r.name)} over earlier">▲</button>
          <button type="button" class="exp-btn-sm" data-k="cdown:${escAttr(r.key)}" onclick="Alert2Plan.moveCat(${i}, 1)" ${nextSame ? '' : 'disabled'} aria-label="Cut ${escAttr(r.name)} over later">▼</button>
        </span></td></tr>`;
    };
    const worksTotal = rows.reduce((a, r) => a + r.worksCost, 0);
    const unheard = rows.reduce((a, r) => a + r.field - r.carried, 0);
    return sec('cut', '6. The cut-over, catchment by catchment', `
      <p>A catchment comes onto ALERT2 on the backbone in one step: once the repeaters that hear its stations, and every repeater from them
        to a base, are sound and fitted, and its base receives ALERT2. Until then nothing changes for it — its repeaters keep repeating ALERT1.
        <strong>${nf(M.shared)} of the ${nf(M.nRep0)} repeaters</strong> are needed by more than one catchment, so the first catchments in a
        region carry most of its backbone work and the later ones find much of theirs done: the table says how many of each catchment's are
        new to it. Within a region the catchments go in the order below — the most High-priority SLS sites first, then the most stations;
        ▲ ▼ change it.${M.bf ? '' : ' <strong>In this scenario the backbone is not first</strong>: each catchment\'s repeaters are fitted by the field crews with its stations, so its cut-over is the end of its field work.'}</p>
      <figure class="a2p-fig a2p-wide">${cutoverSvg(M)}
        <figcaption><ul class="a2p-legend"><li><span class="a2p-swatch a2p-s1" aria-hidden="true"></span>Field stations whose readings ride the ALERT2 backbone — a step, and a dot to hover, for each catchment</li>${
          M.fieldOn ? '<li><span class="a2p-swatch a2p-s3" aria-hidden="true"></span>Field stations converted to ALERT2 themselves (dashed)</li>' : ''}</ul></figcaption></figure>
      <div class="table-wrap medium" role="region" tabindex="0" aria-label="The cut-over, catchment by catchment"><table class="a2p-table a2p-cut-table">
        <caption class="sr-only">Each catchment in the order it is cut over: its stations, the repeaters it needs, their site works and cost, and its dates</caption>
        <thead><tr><th scope="col" class="col-optional">Order</th><th scope="col">Catchment</th><th scope="col" class="a2p-num">Stations</th>
          <th scope="col" class="a2p-num">Repeaters</th><th scope="col">Site works new to it</th><th scope="col" class="a2p-num">Cost</th>
          <th scope="col">On the ALERT2 backbone</th><th scope="col" class="col-optional">Waits for</th>
          ${M.fieldOn ? '<th scope="col" class="col-optional">Field stations</th>' : ''}<th scope="col">Move</th></tr></thead>
        <tbody>${rows.map(tr).join('')}
          <tr class="a2p-total"><td class="col-optional"></td><th scope="row">All</th><td class="a2p-num">${nf(rows.reduce((a, r) => a + r.field, 0))}</td><td class="a2p-num">${nf(M.nRep0)}</td>
            <td>${nf(M.nRetro)} retrofit · ${nf(M.nRebuild)} rebuilt · ${nf(M.nFitOnly)} fit-out</td><td class="a2p-num">${money(worksTotal)}</td>
            <td>${M.cats.length ? endLabel(s, M.bbReady) : '—'}</td><td class="col-optional"></td>${M.fieldOn ? `<td class="col-optional">${endLabel(s, M.fieldEnd)}</td>` : ''}<td></td></tr>
        </tbody></table></div>
      <p class="small txt-muted"><em>Stations</em> are the catchment's field stations; <em>Repeaters</em> the ones it needs, and how many no catchment before it needed.
        <em>Cost</em> is the audits, retrofits and rebuilds (with their temporary repeaters) of the sites new to it, before contingency — ≈ where some are unassessed and
        allotted at the card's mix; acquisition is in section 5. A catchment's bases are counted as its share of the plan's stations: the bases are equipped in the order the catchments need them.</p>
      <ul class="a2p-points small">
        ${unheard ? `<li><strong>${nf(unheard)} field station${unheard === 1 ? '' : 's'} no repeater on record carries</strong> — by their pass ranges — are heard by a base directly,
          or their path is not on record. The chart leaves them off the backbone line; ${M.fieldOn ? 'they are converted with their catchment\'s field stations once its bases receive ALERT2' : 'they stay ALERT1, received as they are now'}.</li>` : ''}
        ${noPath.length ? `<li><strong>No path to a base on record</strong> from some of the concentrators of ${nf(noPath.length)} catchment${noPath.length === 1 ? '' : 's'} — the register marks
          ${I.registerBases} base${I.registerBases === 1 ? '' : 's'} for ${I.radioNetworks} radio networks — so the relays between them and their base are not counted. Their networks' reviews must find the way.</li>` : ''}
        <li><strong>Anyone else listening.</strong> A council, a dam operator or another agency that receives a catchment's ALERT1 off the air today stops hearing
          it at the cut-over, unless it receives ALERT2 too or takes the readings from the Bureau. Each catchment's listeners need finding, and telling, before it goes.</li>
        <li><strong>The first hop is still ALERT1</strong> until a station takes its own ERT-A2: its burst can still collide on the way to the concentrator, and its reading
          is time-stamped at the repeater, not the gauge. The backbone hops — where a lost burst loses every station behind it — are where concentration helps first.</li>
      </ul>`);
  }

  // ── reviews ──
  function reviewsHtml({ M }) {
    const s = sc;
    const rows = M.regionRows.filter(x => x.review);
    return sec('rev', '7. Network reviews', `
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
             takes ${nf(M.reviewDays)} engineer-days on ${s.reviewTeams} team${s.reviewTeams === 1 ? '' : 's'}, and runs each region's review ahead of its field work —
             and ahead of any structure in it being rebuilt, so no tower is replaced on a hill the review would leave. Audits and retrofits go ahead of it: they keep today's network running whatever the review decides.`
          : '<strong>This scenario skips the reviews</strong>: the network is converted as it stands, which is quicker and cheaper and carries today\'s weaknesses into ALERT2.'}</p>
      ${rows.length ? `<div class="table-wrap"><table class="a2p-table">
        <caption class="sr-only">Network review schedule by region</caption>
        <thead><tr><th scope="col">Region</th><th scope="col">Review</th><th scope="col" class="a2p-num">Engineer-days</th>
          <th scope="col" class="a2p-num">Repeaters added</th><th scope="col" class="a2p-num">Retired</th><th scope="col">${M.fieldOn ? 'Field work starts' : 'On the ALERT2 backbone'}</th></tr></thead>
        <tbody>${rows.map(x => `<tr><th scope="row">${esc(x.name)}</th><td>${monthLabel(s, x.review.start)} – ${endLabel(s, x.review.end)}</td>
          <td class="a2p-num">${nf(x.review.by.reduce((a, v) => a + (v || 0), 0))}</td><td class="a2p-num">${x.added}</td><td class="a2p-num">${x.removed}</td>
          <td>${x.start == null ? '<span class="txt-muted">no catchment ticked in it</span>' : M.fieldOn ? monthLabel(s, x.start) : endLabel(s, x.end)}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
  }

  // ── timeline ──
  const ROWS = [
    ['procure', 'Procurement and supply'], ['review', 'Network reviews'], ['acquire', 'Backbone sites acquired'],
    ['audit', 'Condition audits'], ['remediate', 'Backbone retrofits'], ['rebuild', 'Structures rebuilt'],
    ['pilot', 'Pilot network'], ['bases', 'Bases receive ALERT2'], ['fit', 'Backbone cut-over'],
    ['field', 'Field stations to ALERT2'], ['close', 'Legacy retired, close-out'],
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
    const span = (a, b) => (a == null ? '—' : `${endLabel(s, a)}${endLabel(s, b) === endLabel(s, a) ? '' : ` – ${endLabel(s, b)}`}`);
    return sec('time', '8. Timeline', `
      <p>About <strong>${mo(M.end)}</strong> from approval to close-out. ${M.bf
        ? `The backbone stream starts on day one beside procurement and the reviews: the condition audits, then the retrofits and — once each is designed, approved and its network reviewed — the rebuilds, catchment by catchment.
           The pilot proves the equipment and concentration on the first catchment${s.pilot ? '' : ' (not in this scenario)'}; then the tower crews cut the catchments over one by one, each once its site works are done and its bases receive ALERT2.${
           M.fieldOn ? ' The field crews follow catchment by catchment, each starting once its backbone is ALERT2 and its network has been reviewed.' : ' The field stations are not converted in this scenario.'}`
        : `In this scenario the backbone waits for the equipment and is done catchment by catchment by the field crews, and none starts before the acquisitions are complete — compare it with “The proposal” to see what starting the backbone first is worth.`}
        ${s.wet ? `Field work slows to ${pct(s.wetFactor)} from December to March (shaded): crews are pulled to flood response and roads close.` : ''}</p>
      <figure class="a2p-fig a2p-wide">${ganttSvg(M)}
        <figcaption class="small txt-muted">Thin lines mark each 1 July (the financial year). The backbone and field rows are a bar a catchment, coloured by its region. Hover a bar for its dates.</figcaption></figure>
      <div class="a2p-two">
        <div><h4>Milestones</h4><ul class="a2p-ms-list">${ms.map(m => `<li><strong>${endLabel(s, m.at + 1e-6)}</strong> — ${esc(m.label)}</li>`).join('')}</ul></div>
        <div><h4>Each network's own timeline</h4>
          <div class="table-wrap"><table class="a2p-table">
            <caption class="sr-only">Timeline by region</caption>
            <thead><tr><th scope="col">Region</th><th scope="col">On the ALERT2 backbone</th>${M.fieldOn ? '<th scope="col">Field stations</th><th scope="col" class="a2p-num">Months</th>' : ''}</tr></thead>
            <tbody>${M.regionRows.map(x => `<tr><th scope="row"><span class="a2p-swatch" style="--c:${regionVar(x.name)}" aria-hidden="true"></span>${esc(x.name)}</th>
              <td>${x.cutFirst == null ? '<span class="txt-muted">no catchment ticked in it</span>' : span(x.cutFirst, x.cutLast)}</td>
              ${M.fieldOn ? `<td>${x.start == null ? '—' : `${monthLabel(s, x.start)} – ${endLabel(s, x.end)}`}</td><td class="a2p-num">${x.start == null ? '—' : nf1(x.end - x.start)}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>
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
    return sec('fte', '9. Effort', `
      <p><strong>${nf1(M.fteTotal)} FTE-years</strong> over the program, peaking at <strong>${nf1(M.peak)} FTE</strong>. The Bureau's crews are
        ${M.fieldOn ? `${s.fieldCrews} of ${s.staffPerCrew} for the stations and ` : ''}${s.backboneCrews} of ${s.staffPerCrew} fitting the backbone; each works
        ${s.crewDays} field days a month, the rest going to leave, training, bench preparation and travel days.${M.fieldOn ? ` A rainfall station takes
        ${nf1(s.rainDays)} crew-days and a river station ${nf1(s.levelDays)}, travel included, ${nf1(s.remoteMult)}× that in the remote regions.` : ''}
        The audits, retrofits and rebuilds are contract works (section 5) — their cost is in the backbone sites, and a contract manager looks after them.
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
      <p class="small txt-muted">FTE-years at ${WORK_DAYS_YEAR} working days. Whether these are existing staff, new positions or contractors is a decision for management (section 12).</p>`);
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
    return sec('cost', '10. Cost', `
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
    return sec('risk', '11. Assumptions, risks and open questions', `
      <h4>Risks</h4>
      <ul class="a2p-points">
        <li><strong>One supplier.</strong> The ERT-A2 and 115E-2 come from one Brisbane manufacturer, and the 2015 review noted a single
          Bureau-approved ALERT supplier then too. Lead times, firmware maturity and support for ${nf(M.units.ertA2)} units need confirming
          before the field work is scheduled — the ${s.procureMonths}-month procurement window and the pilot are where that shows. A second
          source exists: Campbell Scientific Australia makes an ALERT2 canister wired to the same pinouts.<sup><a href="#a2p-ref-csa">[10]</a></sup></li>
        <li><strong>Repeater power.</strong> An ERT-A2 repeating draws about 50 mA idle against a field station's 200 µA, so the
          retrofit must size each repeater's solar and battery for it.<sup><a href="#a2p-ref-ert">[5]</a></sup></li>
        <li><strong>Structures worse than assumed.</strong> How many sites need their structure rebuilt is the largest swing in the cost — each is about
          ${money(s.cRebuild + s.cTemp)} against ${money(s.cRemed)} for a retrofit — and nobody knows it until the sites are audited. ${M.nAudit
            ? `${nf(M.nAudit)} backbone site${M.nAudit === 1 ? ' is' : 's are'} unassessed and costed at the card's mix; the audits come first so the figure firms up early.`
            : 'Every site in the plan has its site condition set, so the figure is as good as they are.'}
          A rebuild needs a structural design, landholder consent and approvals (and on some hills cultural heritage and vegetation clearance) before it starts, and
          takes the site off the air while it is done: a temporary repeater carries the catchment, and no structure comes down in the wet season.</li>
        <li><strong>Anyone else listening.</strong> Councils, dam operators and other agencies that hear a catchment's ALERT1 off the air lose it at the cut-over
          unless they receive ALERT2 or take the readings from the Bureau — they need finding before each catchment goes.</li>
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
          <tr><th scope="row">Catchments in the plan</th><td>${esc(unticked(I))}</td></tr>
          <tr><th scope="row">Procurement and supply</th><td>${s.procureMonths} months</td></tr>
          <tr><th scope="row">Pilot</th><td>${s.pilot ? `${s.pilotMonths} months, ${s.pilotSites} stations` : 'none'}</td></tr>
          <tr><th scope="row">Scenario</th><td>${esc(scenarioText())}</td></tr>
          <tr><th scope="row">Site conditions set</th><td>${esc(conditionsText(M))}</td></tr>
          <tr><th scope="row">Works on a site another owner holds</th><td>go ahead under an access agreement while its acquisition is negotiated</td></tr>
          <tr><th scope="row">Condition audit, per unassessed backbone site</th><td>${s.auditDays} contract crew-day${s.auditDays === 1 ? '' : 's'}, one team</td></tr>
          <tr><th scope="row">Retrofit, per backbone site</th><td>${s.remediateDays} crew-days</td></tr>
          <tr><th scope="row">Rebuilding a structure</th><td>${s.rebuildDays} crew-days</td></tr>
          <tr><th scope="row">Fitting an ERT-A2 at a repeater</th><td>${s.fitDays} crew-days</td></tr>
          <tr><th scope="row">Equipping a base, per receive chain</th><td>${s.baseDays} engineer-days</td></tr>
          <tr><th scope="row">Close-out</th><td>${s.closeMonths} months</td></tr>
        </tbody></table></div>
      <h4>Open questions</h4>
      <ul class="a2p-points">
        <li>Which base stations receive which networks today, and which will receive ALERT2 — the register counts ${I.radioNetworks} radio networks and marks ${I.registerBases} bases${I.partial ? ' in the catchments ticked' : ''},
          so the way from many repeaters to a base is not on record.</li>
        <li>Whether each concentrator hears legacy ALERT on the frequency it sends ALERT2 on, or needs a second receiver — the frequency and slot plan decides it, site by site.</li>
        <li>What each repeater site needs: a condition record for every backbone site, so the mix on the card gives way to what is known.</li>
        <li>Who owns each backbone site with no owner on record, and on what terms the Bureau could take it.</li>
        <li>Whether the stations the Bureau does not own convert at the owner's cost, the Bureau's, or shared.</li>
        <li>Supplier pricing at volume, lead time, and the support and warranty terms.</li>
        <li>Whether the conversion is done by Bureau crews, contractors, or both.</li>
      </ul>`);
  }

  function decisionsHtml({ M }) {
    const s = sc;
    return sec('dec', '12. Decisions sought', `
      <ol class="a2p-points">
        <li><strong>Start the backbone now</strong> — approve the condition audits of ${nf(M.nAudit)} backbone site${M.nAudit === 1 ? '' : 's'}, the acquisition of about ${nf(M.nAcq)},
          the retrofit of about ${nf(M.nRetro)} and the structural design and rebuild of about ${nf(M.nRebuild)}, ahead of and independent of the rest of the program.</li>
        <li><strong>Approve the network reviews</strong>, region by region, before each region's field work and before any structure in it is rebuilt.</li>
        <li><strong>Endorse the approach</strong>: ${s.pilot ? 'a pilot on the first catchment, then ' : ''}each catchment cut over to an ALERT2 backbone in concentration mode, in the order in section 6,
          ${M.fieldOn ? 'its field stations converted after it' : 'its field stations left on ALERT1 for FWIN visits and renewals to convert'}, and legacy ALERT kept running until each catchment is done.</li>
        <li><strong>Agree the funding envelope</strong> of about ${money(M.total)} over ${mo(M.end)}, phased by financial year as in section 10.</li>
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
    syncPartial();
  }
  // Only what the scenario moves is rewritten: the figures at the top and the
  // document. The card stays as it is, so the slider being dragged keeps
  // its focus and its place.
  function repaintLive(focusKey) {
    if (state.activeTab !== 'a2plan') return;
    const k = document.getElementById('a2p-kpis'), o = document.getElementById('a2p-out');
    if (!k || !o) { repaint(); return; }
    // A folded table somebody has opened stays open: the site table's
    // selects live in one, and a choice made there must not fold it away.
    const open = new Set([...o.querySelectorAll('details[id][open]')].map(d => d.id));
    k.innerHTML = kpisHtml();
    o.innerHTML = outHtml();
    for (const id of open) { const d = document.getElementById(id); if (d && o.contains(d)) d.open = true; }
    // "Changed since it was loaded" moves with the card.
    if (!busy) refreshStore();
    const note = document.querySelector('.a2p-controls > p.small');
    if (note) {
      const fresh = document.createElement('div');
      fresh.innerHTML = controlsHtml();
      const p = fresh.querySelector('.a2p-controls > p.small');
      if (p) note.innerHTML = p.innerHTML;
    }
    if (focusKey) {
      const find = key => document.querySelector(`#a2p-out [data-k="${CSS.escape(key)}"]`);
      const other = focusKey.replace(/^(c?)(up|down):/, (m, c, d) => `${c}${d === 'up' ? 'down' : 'up'}:`);
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
    if (k === 'scope') refreshCats();
    // Every slider's value is said again: one can depend on another (the
    // retrofits on the rebuilds, the bases on the scope).
    for (const c of CONTROLS.flatMap(g => g.items)) {
      if (c.kind !== 'range') continue;
      const out = document.getElementById(`a2p-c-${c.k}-o`);
      const txt = ctlValue(c, sc[c.k]);
      if (out && out.textContent !== txt) out.textContent = txt;
      const inp = document.getElementById(`a2p-c-${c.k}`);
      if (inp) inp.setAttribute('aria-valuetext', txt);
    }
    repaintLive();
  }

  function init() {
    if (!mayPlan()) return;
    syncPartial();
    // The site conditions and the saved scenarios, once a visit (0065).
    if (store === 'idle') loadStore();
    // The owners and priorities come from the SLS, fetched once on first ask.
    if (!slsReady && !slsWanted && typeof SLS !== 'undefined' && SLS.ensureData) {
      slsWanted = true;
      SLS.ensureData().then(() => { slsReady = true; cat = null; cuts.clear(); memo = null; repaint(); }, () => { slsWanted = false; });
    } else if (typeof SLS !== 'undefined' && SLS.loaded && SLS.loaded() && !slsReady) {
      slsReady = true; cat = null; cuts.clear(); memo = null; repaint();
    }
  }

  // ── exports ──
  // The catchments left out, in words: for the assumptions table and the
  // workbook, where the card's ticks are not there to read.
  function unticked(I) {
    const C = catalogue();
    if (!I.partial || !C) return `all ${I.catchmentsInScope}`;
    const ex = new Set(sc.excluded || []);
    const out = C.flat.filter(c => ex.has(c.key)).map(c => c.name);
    return `${I.catchmentCount} of ${I.catchmentsInScope} — left out: ${out.length > 15 ? `${out.slice(0, 15).join(', ')} and ${out.length - 15} more` : out.join(', ')}`;
  }

  // The scenario the card is, in words: for the assumptions and the workbook.
  function scenarioText() {
    const L = loadedScenario();
    if (!L) return 'not saved as a scenario';
    return `${L.name}${L.mine ? '' : ` (by ${L.by || 'somebody else'})`}, ${L.shared ? 'shared with everybody who sees the plan' : 'private'}${changedSinceLoad() ? ' — changed since it was saved' : ''}`;
  }

  // The site conditions set, in words.
  function conditionsText(M) {
    const all = Object.values(conditions);
    if (!all.length) return 'none — every backbone site is audited, and costed at the mix';
    const n = k => all.filter(v => v === k).length;
    return `${all.length}: ${WORKS.map(k => `${n(k)} ${WORKS_LABEL[k].toLowerCase()}`).join(', ')}${M.nKnown < all.length ? ` (${M.nKnown} of them in this plan)` : ''}`;
  }

  function csvRows(M) {
    const head = ['Order', 'Region', 'Catchment', 'Rainfall stations', 'River stations', 'Repeaters', 'Backbone repeaters', 'Bases', 'Ticked', 'On the ALERT2 backbone'];
    const rows = [head];
    const cut = new Map(M.cats.map(c => [c.key, c]));
    M.regionRows.forEach((x, i) => {
      for (const [key, c] of x.r.cats) {
        const k = cut.get(key);
        rows.push([i + 1, x.name, c.name, c.rain, c.level, c.repeaters, c.backbone, c.bases,
          c.outside ? 'no — its repeaters carry or relay ticked stations' : 'yes', k && k.cutover != null ? endLabel(sc, k.cutover) : '']);
      }
    });
    return rows;
  }
  function exportWhy() {
    const C = cur();
    if (!C) return 'Somebody who sees the plan, with the station register loaded, first.';
    if (emptyPlan(C.I)) return 'No catchment is ticked under Catchments in the plan.';
    return '';
  }
  function exportCsv() {
    const C = cur();
    const why = exportWhy();
    if (why) { announce(why); return; }
    dlText('alert2-plan-quantities.csv', csvRows(C.M).map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n');
    announce('Saved the quantities by catchment as CSV.');
  }
  function exportXlsx() {
    const C = cur();
    const why = exportWhy();
    if (why || typeof XlsxWrite === 'undefined') { announce(why || 'The workbook cannot be made yet.'); return; }
    const { M } = C, s = sc;
    const t = (v, st) => ({ v, s: st });
    const sheets = [
      { name: 'Summary', cols: [46, 22], rows: [
        [t('Flood-Net — ALERT2 Transition Plan (draft)', 'title')],
        [t(`Worked from the station register; an estimate for planning, not a quote.`, 'sub')], [],
        [t('Scenario', 'label'), scenarioText()],
        [t('Estimated cost, with contingency', 'label'), Math.round(M.total)],
        [t('Contingency', 'label'), `${s.contingency}%`],
        [t('Duration (months)', 'label'), Math.round(M.end * 10) / 10],
        [t('From', 'label'), monthLabel(s, 0)], [t('To', 'label'), endLabel(s, M.end)],
        [t('Effort (FTE-years)', 'label'), Math.round(M.fteTotal * 10) / 10], [t('Peak FTE', 'label'), Math.round(M.peak * 10) / 10],
        [t('Field stations', 'label'), M.nField], [t('Repeaters (after reviews)', 'label'), M.nRep], [t('Base stations', 'label'), M.nBases],
        [t('ERT-A2 units', 'label'), M.units.ertA2], [t('115E-2 gateways', 'label'), M.units.e115],
        [t('Backbone sites to acquire', 'label'), M.nAcq], [t('Backbone sites to audit', 'label'), M.nAudit],
        [t('Backbone sites to retrofit', 'label'), M.nRetro], [t('Repeater structures to rebuild', 'label'), M.nRebuild],
        [t('First catchment on the ALERT2 backbone', 'label'), M.cats.length ? endLabel(s, M.firstCut) : ''],
        [t('Every catchment on the ALERT2 backbone', 'label'), M.cats.length ? endLabel(s, M.bbReady) : ''],
        [t('Field stations converted', 'label'), M.fieldOn ? 'yes' : 'no — they stay ALERT1, concentrated'],
      ] },
      { name: 'Equipment', cols: [52, 10, 12, 14, 40], freeze: 1, rows: [
        ['Item', 'Quantity', 'Each', 'Total', 'Basis'].map(h => t(h, 'head')),
        ...M.equipment.map(e => [e.item, e.qty, e.unit, e.total, e.note]),
      ] },
      { name: 'Regions', cols: [8, 26, 30, 10, 10, 10, 10, 10, 14, 14], freeze: 1, rows: csvRows(M).map((r, i) => i ? r : r.map(h => t(h, 'head'))) },
      { name: 'Cut-over', cols: [8, 30, 24, 10, 10, 8, 10, 10, 10, 10, 14, 16, 16, 16], freeze: 1, rows: [
        ['Order', 'Catchment', 'Region', 'Field stations', 'Repeaters it needs', 'New to it', 'Fit-out', 'Retrofit', 'Rebuilt', 'To audit',
         'Site works cost', 'On the ALERT2 backbone', 'Field from', 'Field to'].map(h => t(h, 'head')),
        ...M.cats.map((c, i) => [i + 1, c.name, c.region, c.field, c.needs.length, c.fresh, c.w.fit, c.w.retrofit, c.w.rebuild, c.w.audit,
          Math.round(c.worksCost), c.cutover != null ? endLabel(s, c.cutover) : '',
          M.fieldOn && c.start != null ? monthLabel(s, c.start) : '', M.fieldOn && c.end != null ? endLabel(s, c.end) : '']),
      ] },
      { name: 'Repeaters', cols: [34, 24, 24, 10, 26, 30, 30], freeze: 1, rows: [
        ['Repeater', 'Region', 'Role', 'Backbone', 'Site works', 'Catchments that need it', 'Owner'].map(h => t(h, 'head')),
        ...sitesOf(C.I).map(r => [r.s.name, r.p.region, roleText(r), r.backbone ? 'yes' : 'no', worksText(r),
          [...r.cats].map(k => (C.I.catList.find(c => c.key === k) || {}).name).filter(Boolean).join(', '), r.owner.name || OWN[r.owner.cls]]),
      ] },
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
        ['catchments', unticked(C.I)],
        ['site conditions set', conditionsText(M)],
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
    authChanged() {
      cat = null; cuts.clear(); memo = null;
      // Another person, or nobody: what the last one could see goes with them.
      store = 'idle'; storeError = ''; conditions = {}; condBy.clear(); scenarios = []; people = null; condStamp++; scenFormOpen = false;
      if (mayPlan()) init();
      repaint();
    },
    retryStore() { if (store === 'failed') { store = 'idle'; return loadStore(); } return null; },
    // For the tests: read the shared store again, and say where it stands.
    reloadStore() { store = 'idle'; return loadStore(); },
    storeState: () => ({ store, error: storeError, conditions: { ...conditions }, scenarios: scenarios.map(x => ({ ...x })),
                         people: people ? people.map(x => ({ ...x })) : null, loaded: loaded ? { ...loaded } : null }),
    scenListToggled(open) { scenListOpen = !!open; },
    peopleToggled(open) { peopleOpen = !!open; },
    // The list's controls (0076), a nominator's: add by address, let nominate
    // or not, take off. `i` numbers a row of `people`; the database answers
    // the whole list each time, and that is what is drawn.
    async person(action, i, on) {
      if (store !== 'ready' || !people || !mayNominate()) return;
      const x = typeof i === 'number' ? people[i] : null;
      const named = p => p.who || p.email || 'them';
      if (action === 'add') {
        const f = document.getElementById('a2p-people-email');
        const email = f ? f.value.trim() : '';
        if (!email) { announce('Whose address?'); if (f) f.focus(); return; }
        const nom = !!(document.getElementById('a2p-people-nom') || {}).checked;
        const got = await write(`Adding ${email}`, () => dbRpc('a2plan_member_save', { p_email: email, p_nominates: nom }), 'ppl:add', refreshPeople);
        if (!Array.isArray(got)) return;
        people = got;
        const g = document.getElementById('a2p-people-email'); if (g) g.value = '';
        const b = document.getElementById('a2p-people-nom'); if (b) b.checked = false;
        refreshPeople('ppl:add');
        announce(`${email} sees the plan now${nom ? ', and may nominate' : ''}.`);
        return;
      }
      if (!x) return;
      if (action === 'nominates') {
        const got = await write(`Changing what ${named(x)} may do`,
          () => dbRpc('a2plan_member_save', { p_email: x.email, p_nominates: !!on }), `pnom:${x.id}`, refreshPeople);
        if (!Array.isArray(got)) return;
        people = got;
        // Their own: whoami() is asked again, so the controls follow.
        if (x.you && typeof Auth !== 'undefined' && Auth.recheck) await Auth.recheck();
        refreshPeople(`pnom:${x.id}`);
        announce(`${x.you ? 'You' : named(x)} ${on ? 'may' : 'may not'} nominate now.`);
        return;
      }
      if (action === 'remove') {
        const ok = await confirmDialog({
          title: x.you ? 'Take yourself off the list?' : `Take ${named(x)} off the list?`,
          message: (x.you ? 'The plan closes for you at once, and only somebody still on the list can put you back.'
                          : `The plan closes for ${named(x)} at once.`)
            + (x.you ? ' Scenarios you shared stay; your private ones wait, unseen, until you are back.'
                     : ' Scenarios they shared stay; their private ones wait, unseen, until they are back.'),
          confirm: 'Take off the list', danger: true,
        });
        if (!ok) { refreshPeople(`pdel:${x.id}`); return; }
        const got = await write(`Taking ${named(x)} off`, () => dbRpc('a2plan_member_remove', { p_user_id: x.id }), 'ppl:add', refreshPeople);
        if (!Array.isArray(got)) return;
        people = got;
        announce(`${named(x)} no longer sees the plan.`);
        if (x.you && typeof Auth !== 'undefined' && Auth.recheck) {
          // Gone from the list: whoami() says so, the nav drops the tab, and
          // the page says who it is for.
          await Auth.recheck();
          this.authChanged();
        } else refreshPeople('ppl:add');
      }
    },
    set,
    preset(id) {
      const p = PRESETS.find(x => x.id === id);
      if (!p) return;
      sc = sanitize({ ...DEFAULTS, ...p.set, order: sc.order, catOrder: sc.catOrder, excluded: sc.excluded });
      saveScenario();
      repaint();
      announce(`${p.label}: the plan is worked again.`);
    },
    move(i, dir) {
      const C = cur();
      if (!C) return;
      const order = C.M.order;
      const j = i + dir;
      if (j < 0 || j >= order.length) return;
      // The two swap places in the order of every region in the scope, so a
      // region the ticks have taken out keeps its place for when it is back.
      const full = regionOrder(inventoryFor([]), sc).slice();
      const a = full.indexOf(order[i]), b = full.indexOf(order[j]);
      if (a < 0 || b < 0) return;
      [full[a], full[b]] = [full[b], full[a]];
      sc.order = full.concat((sc.order || []).filter(n => !full.includes(n)));
      saveScenario();
      const name = order[i];
      repaintLive(`${dir < 0 ? 'up' : 'down'}:${name}`);
      announce(`${name} is now number ${j + 1} in the order.`);
    },
    // ▲ ▼ on the cut-over table: a catchment swaps with its neighbour in the
    // same region, in the order of every catchment in the scope, so one the
    // ticks have taken out keeps its place for when it is back.
    moveCat(i, dir) {
      const C = cur();
      if (!C) return;
      const rows = C.M.cats;
      const j = i + dir;
      if (j < 0 || j >= rows.length || rows[i].region !== rows[j].region) return;
      const I0 = inventoryFor([]);
      const full = catOrder(I0, sc, regionOrder(I0, sc)).map(c => c.key);
      const a = full.indexOf(rows[i].key), b = full.indexOf(rows[j].key);
      if (a < 0 || b < 0) return;
      [full[a], full[b]] = [full[b], full[a]];
      sc.catOrder = full.concat((sc.catOrder || []).filter(k => !full.includes(k)));
      sc = sanitize(sc);
      saveScenario();
      repaintLive(`${dir < 0 ? 'cup' : 'cdown'}:${rows[i].key}`);
      announce(`${rows[i].name} is now number ${j + 1} in the cut-over order.`);
    },
    // What a repeater site needs, as somebody who knows it says: '' for not
    // assessed, or one of the works. Numbered off sitesOf().
    // A site's condition, set from its select: the plan follows at once, and
    // the database is told — everybody's plan follows it. Refused,
    // it goes back to what it was and says why.
    site(i, v) {
      const I = inventory();
      const r = I && sitesOf(I)[i];
      if (!r || store !== 'ready') return;
      const id = r.s.id, want = WORKS.includes(v) ? v : '';
      const was = conditions[id] || '', wasBy = condBy.get(id);
      if (want === was) return;
      if (want) { conditions[id] = want; condBy.set(id, { pending: true }); } else { delete conditions[id]; condBy.delete(id); }
      condStamp++;
      repaintLive(`site:${i}`);
      const said = `${r.s.name}: ${want ? WORKS_LABEL[want].toLowerCase() : 'not assessed — audited first'}`;
      return dbRpc('a2plan_site_set', { p_station_id: id, p_condition: want || null }).then(row => {
        setCondition(row);
        const by = document.getElementById(`a2p-site-${i}-by`);
        if (by) by.textContent = setByText(id);
        announce(`${said}. Saved for everybody who sees the plan.`);
      }, e => {
        if (was) { conditions[id] = was; if (wasBy) condBy.set(id, wasBy); } else { delete conditions[id]; condBy.delete(id); }
        condStamp++;
        const f = document.activeElement;
        repaintLive(f && f.dataset ? f.dataset.k : undefined);
        announce(`${r.s.name}'s site condition was not saved: ${e && e.message ? e.message : e}`);
      });
    },
    // The scenarios panel's buttons. `i` numbers a row of `scenarios`.
    async scen(action, i) {
      if (store !== 'ready') return;
      const x = typeof i === 'number' ? scenarios[i] : null;
      if (action === 'form' || action === 'cancel') {
        scenFormOpen = action === 'form' ? !scenFormOpen : false;
        refreshStore(scenFormOpen ? 'scen:new' : 'scen:new');
        if (scenFormOpen) { const f = document.getElementById('a2p-scen-name'); if (f) f.focus(); }
        return;
      }
      if (action === 'save') {
        const nameEl = document.getElementById('a2p-scen-name');
        const name = nameEl ? nameEl.value.trim() : '';
        if (!name) { announce('A scenario needs a name.'); if (nameEl) nameEl.focus(); return; }
        const notes = (document.getElementById('a2p-scen-notes') || {}).value || '';
        const share = !!(document.getElementById('a2p-scen-share') || {}).checked;
        await write('Saving the scenario', async () => {
          const row = await dbRpc('a2plan_scenario_save', { p_id: null, p_name: name, p_notes: notes, p_shared: share, p_settings: cardSettings() });
          putScenario(row);
          loaded = { id: row.id, snap: snapOf(sc) };
          saveLoaded();
          scenFormOpen = false;
          announce(`Saved “${row.name}”, ${row.shared ? 'shared with everybody who sees the plan' : 'private to you'}.`);
        }, 'scen:new');
        repaintLive();
        return;
      }
      if (action === 'update') {
        const L = loadedScenario();
        if (!L || !L.mine) return;
        await write(`Saving “${L.name}”`, async () => {
          const row = await dbRpc('a2plan_scenario_save', { p_id: L.id, p_name: null, p_notes: null, p_shared: null, p_settings: cardSettings() });
          putScenario(row);
          loaded = { id: row.id, snap: snapOf(sc) };
          saveLoaded();
          announce(`Saved the changes to “${row.name}”.`);
        }, 'scen:new');
        repaintLive();
        return;
      }
      if (!x) return;
      if (action === 'share') {
        await write(`Sharing “${x.name}”`, async () => {
          const row = await dbRpc('a2plan_scenario_save', { p_id: x.id, p_name: null, p_notes: null, p_shared: !x.shared, p_settings: null });
          putScenario(row);
          announce(row.shared ? `“${row.name}” is shared: everybody who sees the plan can load it.` : `“${row.name}” is private: only you can see it.`);
        }, `sshare:${x.id}`);
        repaintLive();
        return;
      }
      if (action === 'delete') {
        const ok = await confirmDialog({
          title: `Remove “${x.name}”?`,
          message: x.shared ? 'It is shared, so everybody who sees the plan loses it too. This cannot be undone.' : 'Only you can see it. This cannot be undone.',
          confirm: 'Remove scenario', danger: true,
        });
        if (!ok) { refreshStore(`sdel:${x.id}`); return; }
        await write(`Removing “${x.name}”`, async () => {
          await dbRpc('a2plan_scenario_delete', { p_id: x.id });
          scenarios = scenarios.filter(y => y.id !== x.id);
          if (loaded && loaded.id === x.id) { loaded = null; saveLoaded(); }
          announce(`Removed “${x.name}”.`);
        }, 'scen:new');
        repaintLive();
        return;
      }
      if (action === 'load') {
        // The card as it is would be lost: ask first, unless it is exactly
        // the scenario it came from or the proposal.
        const unsaved = loaded ? changedSinceLoad() : differs(sc, DEFAULTS);
        if (unsaved && !(await confirmDialog({
          title: `Load “${x.name}”?`,
          message: 'It replaces every setting on the card, the catchments ticked and their order. The card as it is now is not saved as a scenario, so it will be lost.',
          confirm: 'Load scenario',
        }))) { refreshStore(`sload:${x.id}`); return; }
        sc = sanitize({ ...x.settings });
        delete sc.sites;
        loaded = { id: x.id, snap: snapOf(sc) };
        saveScenario();
        saveLoaded();
        repaint();
        refreshStore(`sload:${x.id}`);
        announce(`Loaded “${x.name}”${x.mine ? '' : ` by ${x.by || 'somebody else'}`}: the plan is worked again.`);
      }
    },
    // The folded tables go on paper too: opened for the print and folded
    // again after, so the screen is left as it was.
    // The catchment picker: one box, a region's boxes, or all of them.
    catchment(i, on) {
      const C = catalogue();
      const c = C && C.flat[i];
      if (!c) return;
      const ex = new Set(sc.excluded || []);
      if (on) ex.delete(c.key); else ex.add(c.key);
      setExcluded(ex);
      catsChanged(`cat:${i}`, `${c.name} ${on ? 'is in' : 'is out of'} the plan.`);
    },
    region(gi, on) {
      const C = catalogue();
      const g = C && C.groups[gi];
      if (!g) return;
      const ex = new Set(sc.excluded || []);
      for (const c of g.cats) { if (on) ex.delete(c.key); else ex.add(c.key); }
      setExcluded(ex);
      catsChanged(`reg:${gi}`, `${g.region}: ${on ? `all ${g.cats.length} catchments in` : 'every catchment out of'} the plan.`);
    },
    catchments(which) {
      const C = catalogue();
      if (!C) return;
      if (which === 'all') setExcluded([]);
      else if (which === 'none') setExcluded(C.flat.map(c => c.key));
      else if (which === 'high') {
        const hot = new Set(C.field.filter(f => f.high).map(f => f.key));
        setExcluded(C.flat.filter(c => !hot.has(c.key)).map(c => c.key));
      } else return;
      const ex = new Set(sc.excluded || []);
      const n = C.flat.filter(c => !ex.has(c.key)).length;
      catsChanged(`cats:${which}`, `${n} of ${C.flat.length} catchments in the plan.`);
    },
    catsToggled(open) { catsOpen = !!open; if (open) syncPartial(); },
    // For the tests: the picker's list.
    catalogue,
    print() {
      if (typeof window === 'undefined' || !window.print) return;
      const shut = [...document.querySelectorAll('#a2p-out details.a2p-more:not([open])')];
      shut.forEach(d => { d.open = true; });
      try { window.print(); } finally { shut.forEach(d => { d.open = false; }); }
    },
    exportCsv,
    exportXlsx,
    exportWhy,
    // For the tests: the scenario, the inventory and the plan as they stand.
    scenario: () => ({ ...sc }),
    defaults: () => ({ ...DEFAULTS }),
    inventory,
    plan: () => { const C = cur(); return C ? C.M : null; },
    model: (scenario) => { const I = inventory(); return I ? model(I, sanitize(scenario || {})) : null; },
    reset() { sc = sanitize({}); loaded = null; saveLoaded(); saveScenario(); repaint(); syncPartial(); },
  };
})();
if (typeof window !== 'undefined') window.Alert2Plan = Alert2Plan;
