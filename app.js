// MegaNet — app.js
//
// The middle of the app.js lineage (#129): what has not been lifted out yet.
// Loads after core.js and before the module files and init.js — see the header
// of index.html, where the order is the contract.
//
// What is left here, and why each of it is:
//
//   the theme and file-loading helpers, the side nav, the help panel and
//   renderMain()   the app shell. #109 (U0) is the issue that owns it.
//
//   the Stations map core, the station table and its repeater list, and the
//   search machinery all three share   frozen for the whole of #129: 25 of its
//   own names are consumed by 20 other sections, and it is the hub the rest of
//   the app hangs off. #136 (U1) owns the tab.
//
//   the filter helpers, the ACMA RRL layer and RF Environment   #138 (U3).
//
//   RF Changes and the Interference Workbench   111 flat top-level functions
//   between them and no IIFE, so they need wrapping before they can move.
//   That is M4, #135, and it is the last of this epic.
//
// It is down from 22,458 lines before M1 (#132) to 21,536 after it, 16,160
// after M2 (#133) and 6,221 now — M3 (#134) took fourteen modules out in one
// go. Still the largest file in the app and still the one most likely to be
// edited by two agents at once, but 72% of the monolith now lives somewhere
// with an owner.
//
// Two things to know before editing it:
//
//   Nothing here runs at load. Every top-level binding is a declaration or an
//   IIFE that only defines — init.js is the single thing that executes, and it
//   loads last. So functions in this file may call each other in any direction,
//   forwards included, and a module may be moved out to its own file without
//   its position in the load order mattering. That property is the whole point
//   of M1; do not spend it by adding top-level code that runs on sight.
//
//   It no longer carries a NUL byte. All 3 of the ones that made grep call this
//   file binary went with NetworkView in M3 and are now network-view.js:504 and
//   568×2; the fourth left with Alert2 in M2 and is alert2.js:857. They are
//   U+0000 inside string literals, used as compound-key separators (#129), and
//   any tool that round-trips one of those two files as text and normalises
//   control characters destroys the keys silently. `npm run concat` in test/ is
//   what catches that, over the whole concatenation rather than per file.

// Header buttons are icon + label, so the label is a span inside the button and
// not the button's own text. Writing textContent would throw the icon away.
function setHeaderLabel(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const label = btn.querySelector('.hdr-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

// ── Theme ──────────────────────────────────────────────────────────────────────

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('mn-theme', state.theme);
  setHeaderLabel('btn-theme', state.theme === 'dark' ? 'Light' : 'Dark');
  if (state.map) { refreshMapLayers(); MapDraw.render(); MapRivers.repaint(); }
  // The ARRO chart writes real colour values into its SVG rather than `var(…)`,
  // so that the PNG export has something to resolve. That is the trade: the
  // chart has to be told the palette moved.
  if (state.activeTab === 'arrodata' || state.activeTab === 'field') ArroData.repaint();
}

// ── File loading ───────────────────────────────────────────────────────────────

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/stations.json';

// Where a station list can come from, worst-to-best-understood. The label is
// what the operator reads in the header and on the Export tab; being able to
// answer "is this the database or a file?" at a glance is the whole point.
const SOURCE_LABELS = {
  api:     'the datastore',
  bundled: 'stations.json (this site)',
  github:  'stations.json (GitHub)',
  file:    'a file on this device',
};

function onFileLoad(input) {
  const f = input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      loadJson(e.target.result, { kind: 'file', detail: f.name });
    } catch (err) {
      alert(`Failed to load stations.json: ${err.message}`);
    }
  };
  reader.readAsText(f);
  input.value = '';
}

// Returns true when the load succeeded. `announce` is what separates a button
// press — where silence would be baffling — from a step in the automatic
// fallback chain, where an alert for each source that did not answer would be
// three dialogs before the app has drawn anything.
async function loadFromUrl(url, { kind = 'github', announce = true } = {}) {
  const btn = document.getElementById('btn-load-gh');
  if (announce && btn) btn.disabled = true;
  if (announce) setHeaderLabel('btn-load-gh', 'Loading…');
  const t0 = _dbClock();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    applyStationDoc(text, { kind, ms: Math.round(_dbClock() - t0) });
  } catch (err) {
    if (announce) alert(`Failed to load from URL: ${err.message}`);
    state.loadError = `${SOURCE_LABELS[kind] || url}: ${err && err.message || err}`;
    return false;
  } finally {
    if (announce && btn) btn.disabled = false;
    if (announce) setHeaderLabel('btn-load-gh', 'Load from GitHub');
  }
  // Outside the catch on purpose: the data has landed, so this call succeeded.
  // A failure in here is a rendering bug and belongs in the console as one.
  renderAfterLoad();
  return true;
}

function loadFromGitHub() {
  loadFromUrl(GITHUB_RAW_URL, { kind: 'github' });
}

// The station list out of Postgres, assembled by meganet.stations_doc() into the
// exact document this app has always parsed — see db/migrations/0002_stations.sql
// and tools/check_stations_doc.py, which is what makes "exact" a checked claim
// rather than a hopeful one. Nothing downstream of loadJson() knows the
// difference, which is the design: the API returns the file's shape, so the
// other ~17,000 lines never had to care.
//
// It is an RPC rather than a select on the view because PostgREST returns a
// scalar function's result as the response body itself. Selecting the view would
// wrap it as {"doc": …} and cost a 2.3 MB parse-and-restringify in the browser
// purely to unwrap it.
//
// Compression is not negotiated here on purpose: Accept-Encoding is a forbidden
// header name, so fetch() will not let this code set it. Every browser sends it
// anyway and PostgREST honours it, so the document arrives gzipped without
// anyone asking — roughly 2.3 MB becoming a few hundred KB.
async function loadFromApi({ announce = true } = {}) {
  const t0 = _dbClock();
  try {
    const res = await fetch(`${DB_URL}/rpc/stations_doc`, {
      headers: {
        apikey: DB_ANON_KEY,
        'Accept-Profile': DB_SCHEMA,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) detail = body.message;
      } catch (_) { /* not JSON; the status line stands */ }
      throw new Error(detail);
    }
    const text = await res.text();
    applyStationDoc(text, { kind: 'api', ms: Math.round(_dbClock() - t0) });
  } catch (err) {
    // Same rejection for DNS failure, CORS refusal, no network, and a project
    // paused for inactivity — the browser deliberately does not distinguish
    // them. Record what is known and let the caller fall back.
    state.loadError = `the datastore: ${err && err.message || err}`;
    if (announce) alert(`Failed to load from the datastore: ${err && err.message || err}`);
    return false;
  }
  renderAfterLoad();
  return true;
}

// The datastore first, then the file — in that order, and saying which one won.
//
// The fallback is not defensive padding. A free-tier Supabase project pauses
// after about a week of inactivity, and a paused project *fails* the read rather
// than slowing it down; MegaNet is exactly the burst-shaped tool that gets
// paused. Falling back to the committed stations.json turns that from "no data"
// into "yesterday's data" — which is only acceptable because the header then
// says so rather than letting a stale file pass for the database.
async function autoLoad() {
  if (await loadFromApi({ announce: false })) return;

  // The copy committed next to the app. Same file as GitHub raw, one less hop,
  // and it is what this app loaded from before there was a datastore. No such
  // thing over file://, where there is no server to ask.
  if (location.protocol !== 'file:'
      && await loadFromUrl('stations.json', { kind: 'bundled', announce: false })) return;

  await loadFromUrl(GITHUB_RAW_URL, { kind: 'github', announce: false });
}

// Loading and drawing are deliberately two functions, and the seam between them
// is where "did this work?" gets decided.
//
// Everything here can fail only because the *document* is bad. Drawing it is a
// separate step that can fail for its own reasons — a tab with a bug in it, a
// map library that did not load — and those must not be reported as the source
// having failed. Folded together, a render that threw would send the loader down
// its fallback chain: replacing the database's data with an older file, blaming
// the datastore for a fault in the browser, and then throwing again on the way
// back out. The data being in hand is the success condition.
function applyStationDoc(text, source) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.stations)) throw new Error('Missing "stations" array');
  state.data       = data;
  state.dataSource = {
    kind:  (source && source.kind) || 'file',
    detail: source && source.detail,
    ms:    source && source.ms,
    at:    new Date(),
    // The document's own date, which is the one that answers "how old is this
    // data?" — as opposed to `at`, which only says when it was fetched. A file
    // from GitHub is fresh and its contents may be a month old.
    dated: (data.meta && data.meta.updated) || null,
  };
  // Cleared on success: whatever failed on the way to here has been superseded
  // by something that worked, and a stale error under a good load reads as a
  // current problem.
  if (source && source.kind === 'api') state.loadError = null;
  state.memBytes.stationsJson = text.length;
  state.exportNets = null;
  state.filterOpts  = null;         // option lists and the search corpus are
  state.searchIdx   = null;         // both derived from the file
  state.repeaterIdx = null;         // so is the cached repeater-only subset
  state.passRelIdx  = null;         // and so is the pass-range relation
  NetworkView.invalidate();         // every node in the graph was a row in the old file
  resetStationFilters();
  state.selectedId = null;
  state.mapSelection.clear();       // the picked ids belonged to the old file
}

// Draw whatever was just loaded. Kept separate from applyStationDoc() — see the
// note there — and called after it in every path.
function renderAfterLoad() {
  updateHeaderStats();
  MemMeter.render();
  renderTabs();
  renderMain();
}

// Parse-and-draw, as it always was. onFileLoad() and anything outside this file
// still get one call that does the whole job.
function loadJson(text, source) {
  applyStationDoc(text, source);
  renderAfterLoad();
}

function updateHeaderStats() {
  const el = document.getElementById('hdr-stats');
  if (!el || !state.data) return;
  const s = state.data.stations;
  const src = state.dataSource;
  // The source rides along with the counts because this line is on screen on
  // every tab. "3174 stations · 88 repeaters" is identical whether it came from
  // the database or from a file committed a month ago, and telling those apart
  // should not require opening a tab and pressing a button.
  const from = src ? ` · from ${SOURCE_LABELS[src.kind] || src.kind}` : '';
  el.textContent =
    `${s.length} stations · ${s.filter(x => x.roles.includes('repeater')).length} repeaters${from}`;
  el.title = src ? dataSourceSummary() : '';
}

// One line of plain English about the loaded document: where it came from, when
// it was fetched, and the date the data itself carries. That last one is the
// number that matters — a file fetched a second ago can hold month-old data.
function dataSourceSummary() {
  const src = state.dataSource;
  if (!src) return 'Nothing loaded yet.';
  const bits = [`Loaded from ${SOURCE_LABELS[src.kind] || src.kind}`];
  if (src.detail) bits.push(src.detail);
  if (src.ms != null) bits.push(`${src.ms} ms`);
  bits.push(`at ${src.at.toLocaleTimeString()}`);
  if (src.dated) bits.push(`data dated ${src.dated}`);
  return bits.join(' · ');
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

// The search box takes a list, not just one term: an operator watching a
// telemetry log copies the addresses coming in, pastes the lot straight into
// the box and sees where those sites are. Commas, semicolons, pipes, tabs and
// new lines all separate, so a spreadsheet column, a CSV row and a log excerpt
// all work as pasted. A run of bare numbers separated by spaces splits too —
// "6128 6129" is two addresses, while "Mt Stuart" is one name, so spaces only
// separate when every piece is a number. Terms are matched with OR: a station
// answering any one of them is in.
function parseSearchTerms(text) {
  const terms = [];
  String(text || '').split(/[,;|\t\r\n]+/).forEach(chunk => {
    const term  = chunk.trim();
    if (!term) return;
    const parts = term.split(/\s+/);
    if (parts.length > 1 && parts.every(p => /^\d+$/.test(p))) terms.push(...parts);
    else terms.push(term);
  });
  return [...new Set(terms.map(t => t.toLowerCase()))];
}

// Prepared form of the box's contents: the terms, plus the numeric ones on
// their own. Splitting and testing them per station per term is what made a
// 120-address paste take most of a second; this is done once per pass and
// memoised on the raw text, since a filter pass asks for the same string
// several times over (table, map, match note).
let _searchPrep = { text: null, prep: null };
function prepareSearch(text) {
  const raw = String(text || '');
  if (_searchPrep.text !== raw) {
    const terms = parseSearchTerms(raw);
    _searchPrep = { text: raw, prep: { terms, nums: terms.filter(t => /^\d+$/.test(t)) } };
  }
  return _searchPrep.prep;
}

// Any one term is enough. A station's ALERT addresses are derived once here,
// not once per numeric term — deriving them is the expensive part.
function stationMatchesSearch(s, prep) {
  const { terms, nums } = prep;
  if (!terms.length) return true;
  const name = s.name.toLowerCase();
  const num  = (s.station_number || '').toLowerCase();
  if (terms.some(t => name.includes(t) || num.includes(t))) return true;
  if (!nums.length) return false;
  const ids = stationAlertIds(s).map(String);
  return nums.some(t => ids.some(id => id.startsWith(t)));
}

// ── Marking where a search term landed ───────────────────────────────────────
// Which stations matched is only half the answer: a filter of "491" hits a
// station number, an ALERT address and a name three different ways, and the
// row on its own doesn't say which. The table marks the exact characters that
// matched, following stationMatchesSearch's rules to the letter — substring
// for names and station numbers, leading digits for ALERT addresses — so the
// highlight can never claim a match the filter didn't make.

// Every place a term occurs in an already-lowercased string, as merged
// [start, end) pairs. Overlapping terms ("61" and "6128") become one run
// rather than nested markup.
function searchHitRanges(lower, terms) {
  const spans = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
      spans.push([i, i + t.length]);
    }
  }
  if (spans.length < 2) return spans;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
    else merged.push(spans[i]);
  }
  return merged;
}

// HTML for a field with its matched runs wrapped in <mark>. Escaping happens
// per slice, so the markup can't be spoofed by a station name containing tags.
function markHits(text, terms) {
  const str = String(text ?? '');
  if (!str || !terms || !terms.length) return esc(str);
  const spans = searchHitRanges(str.toLowerCase(), terms);
  if (!spans.length) return esc(str);
  let out = '', at = 0;
  for (const [a, b] of spans) {
    out += esc(str.slice(at, a)) + `<mark class="hit">${esc(str.slice(a, b))}</mark>`;
    at = b;
  }
  return out + esc(str.slice(at));
}

// ALERT addresses are matched from the start (6128 is found by "61", not by
// "12"), so only that leading run is marked — the longest one that matches.
function markAlertId(id, nums) {
  const str = String(id);
  let len = 0;
  for (const t of nums) if (t.length > len && str.startsWith(t)) len = t.length;
  return len ? `<mark class="hit">${str.slice(0, len)}</mark>${str.slice(len)}` : str;
}

// Names, station numbers and ALERT addresses as flat strings, built once per
// load. Used to answer "did this pasted term match anything at all?" without
// re-deriving every station's sensor list once per term on every keystroke.
function searchCorpus() {
  if (state.searchIdx) return state.searchIdx;
  const names = [], numbers = [], idPrefixes = new Set();
  (state.data?.stations || []).forEach(s => {
    names.push(s.name.toLowerCase());
    if (s.station_number) numbers.push(String(s.station_number).toLowerCase());
    // Every prefix of every address, so "is any address starting with 61 on
    // file?" is one lookup instead of a scan — a pasted log is mostly ids that
    // are on file, and those then cost nothing to confirm.
    stationAlertIds(s).forEach(id => {
      const str = String(id);
      for (let i = 1; i <= str.length; i++) idPrefixes.add(str.slice(0, i));
    });
  });
  state.searchIdx = { names, numbers, idPrefixes };
  return state.searchIdx;
}

// Which of the pasted terms are in no station's name, number or addresses?
// Pasting 40 ids off a log and being told 3 of them aren't in the database is
// the point of the exercise — a silently shorter list is not an answer. Only
// asked for an actual list (one term is just a search that found nothing, which
// the match note already says). Mirrors stationMatchesQuery's rules exactly.
function unmatchedSearchTerms(terms) {
  if (terms.length < 2 || !state.data) return [];
  const { names, numbers, idPrefixes } = searchCorpus();
  return terms.filter(t =>
    !(/^\d+$/.test(t) && idPrefixes.has(t)) &&
    !names.some(n => n.includes(t)) &&
    !numbers.some(n => n.includes(t)));
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

// filteredStations() is called several times per refresh (map layers, the
// table, the match-note chrome) — cheap to re-run once, wasteful across
// 3,000+ stations three times over. Cached against a signature of the
// filter selections themselves (not the stations), so the cache is only as
// large as what the operator has ticked, and stays correct across whichever
// function happens to mutate state.filters next.
let _filteredCache = null, _filteredCacheSig = null, _filteredCacheData = null;

function filtersSignature(f) {
  return JSON.stringify([
    f.search, f.enabledOnly, f.sensorsAll, f.basin, f.lga, f.hasCoords, f.hasAlertId,
    [...f.roles].sort(), [...f.networks].sort(), [...f.regions].sort(),
    [...f.catchments].sort(), [...f.sensors].sort(),
  ]);
}

function filteredStations() {
  if (!state.data) return [];
  const sig = filtersSignature(state.filters);
  if (_filteredCache && _filteredCacheData === state.data && _filteredCacheSig === sig) {
    return _filteredCache;
  }
  _filteredCache    = computeFilteredStations();
  _filteredCacheSig = sig;
  _filteredCacheData = state.data;
  return _filteredCache;
}

function computeFilteredStations() {
  const f = state.filters;
  const search = prepareSearch(f.search);
  return state.data.stations.filter(s => {
    if (f.enabledOnly && !s.enabled) return false;
    if (!stationMatchesSearch(s, search)) return false;
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

// Kept as one fused loop on purpose: passRangeOrphans() runs this over every
// station × repeater × address on each keystroke of the Pass Ranges filter, and
// splitting the per-range test into its own function — however tidy — costs the
// tab ~70% more render time at this call volume. See passRangesHtml() for how
// the table names a single range without a second copy of this rule.
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

// Repeaters are ~2-3% of the station list, but findRepeaterMatches used to be
// called once per field station and rescan every station each time. Caching
// the repeater-only subset (invalidated everywhere state.filterOpts is)
// turns that O(stations) scan into an O(repeaters) one.
function repeaterList(allStations) {
  if (!state.repeaterIdx) {
    state.repeaterIdx = allStations.filter(s => s.roles.includes('repeater') && s.repeater);
  }
  return state.repeaterIdx;
}

// Both directions of the pass-range relation, resolved in one pass over the
// station list and cached until the file changes (see refreshFilterOptions).
//
// Every caller used to rescan for itself: "which repeaters carry this station"
// was an O(repeaters) scan run once per station, and "which stations does this
// repeater carry" an O(stations) scan run once per repeater. Both walk the same
// AlertID-against-pass-range comparison, so one pass builds both lookups and
// every later question is a Map hit.
function passRelationIndex() {
  if (state.passRelIdx) return state.passRelIdx;
  // Nothing loaded yet: answer empty without caching, so the index (and the
  // repeater subset it builds on) is still built from the real file later.
  if (!state.data) return { byStation: new Map(), byRepeater: new Map(), addresses: [], passingAddr: new Map() };
  const stations  = state.data.stations;
  const repeaters = repeaterList(stations);
  const byStation  = new Map();   // station id  → repeaters carrying it
  const byRepeater = new Map();   // repeater id → field stations it carries
  const addrSet    = new Set();   // every distinct ALERT address in the network
  for (const r of repeaters) byRepeater.set(r.id, []);
  for (const s of stations) {
    const ids = stationAlertIds(s);
    if (!ids.length) continue;
    ids.forEach(id => addrSet.add(id));
    const isField = s.roles.includes('field');
    let carriers = null;
    for (const r of repeaters) {
      if (r.id === s.id) continue;
      if (!ids.some(id => passRangeCoversId(r.repeater, id))) continue;
      (carriers || (carriers = [])).push(r);
      if (isField) byRepeater.get(r.id).push(s);
    }
    if (carriers) byStation.set(s.id, carriers);
  }
  const addresses = [...addrSet].sort((a, b) => a - b);
  // Addresses carried per repeater: how many of the network's addresses fall
  // inside its open pass ranges (post-exclusion), regardless of which station
  // role owns the address. Distinct from byRepeater above, which counts field
  // *stations* — a station can own several addresses, so the two numbers
  // legitimately differ. Built here, once per file, for the same reason the
  // rest of this index exists (see the comment above).
  const passingAddr = new Map();
  for (const r of repeaters) {
    let n = 0;
    for (const id of addresses) if (passRangeCoversId(r.repeater, id)) n++;
    passingAddr.set(r.id, n);
  }
  state.passRelIdx = { byStation, byRepeater, addresses, passingAddr };
  return state.passRelIdx;
}

// Addresses a repeater carries — the primary "passing N" count shown wherever
// a repeater appears (see #83). Null when the repeater has no pass ranges
// recorded at all, so callers can tell "nothing configured" (show nothing)
// from "configured but carrying nothing" (show "passing 0" — a finding).
function repeaterPassingCount(station) {
  if (!station || !station.repeater) return null;
  const ranges = station.repeater.pass_ranges;
  if (!Array.isArray(ranges) || !ranges.length) return null;
  return passRelationIndex().passingAddr.get(station.id) ?? 0;
}

// Total addresses the repeater's ranges could carry (Σ high − low + 1), before
// exclusions and before any overlap with other repeaters — the denominator for
// the "how full is this repeater" utilisation figure on its editor card.
function repeaterPassRangeSpan(station) {
  return (station?.repeater?.pass_ranges || [])
    .reduce((sum, r) => sum + Math.max(0, r.high - r.low + 1), 0);
}

// The lists handed out below are the index's own arrays. Callers only read
// them, and copying ~3,100 of them per map refresh is exactly the cost the
// index exists to remove — so they are shared, not cloned.
function findRepeaterMatches(station) {
  return passRelationIndex().byStation.get(station.id) || [];
}

// Every pass-range path out of a set of field stations, with the length of each
// one. The map needs the same list twice — to draw the paths, and to work out
// which repeaters have to stay visible when the rest are hidden — so it is
// resolved once here. Stations without a position are skipped: a path needs two
// ends, and the same pair is never emitted twice however the sources overlap.
function passRangeLinks(sources) {
  const pairs = [];
  const seen  = new Set();
  for (const s of sources) {
    if (!s.roles.includes('field') || s.lat == null || s.lon == null) continue;
    for (const r of findRepeaterMatches(s)) {
      if (r.lat == null || r.lon == null) continue;
      const key = `${s.id}|${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ s, r, km: acmaHaversineKm(s.lat, s.lon, r.lat, r.lon) });
    }
  }
  return pairs;
}

function findStationMatches(repeater) {
  if (!repeater.repeater) return [];
  return passRelationIndex().byRepeater.get(repeater.id) || [];
}

// ── Related-by-pass-range stations ───────────────────────────────────────────
// Filtering for a station answers "where is it"; the question behind it is
// usually "who carries it". So while a filter is running the result set is
// extended with everything on the other end of a pass range: the repeaters
// carrying a matched field station, and the field stations carried by a matched
// repeater. The map and the table below it both read this one list, or they
// would disagree about what is on screen.
//
// Cached on the same terms as filteredStations(), plus the identity of the
// relation index — so an edited pass range drops it too.
const NO_RELATED = [];
let _relatedCache = null, _relatedCacheSig = null, _relatedCacheIdx = null;

function relatedStations() {
  if (!state.data || !state.mapRelated || !mapFilterActive()) return NO_RELATED;
  const idx = passRelationIndex();
  const sig = filtersSignature(state.filters);
  if (_relatedCache && _relatedCacheIdx === idx && _relatedCacheSig === sig) {
    return _relatedCache;
  }
  const matches = filteredStations();
  const already = new Set(matches.map(s => s.id));
  const out = [];
  for (const s of matches) {
    const related = s.roles.includes('repeater')
      ? findStationMatches(s).concat(findRepeaterMatches(s))
      : findRepeaterMatches(s);
    for (const r of related) {
      if (already.has(r.id)) continue;
      already.add(r.id);
      out.push(r);
    }
  }
  _relatedCache    = out;
  _relatedCacheSig = sig;
  _relatedCacheIdx = idx;
  return out;
}

// The same list as a Set, for the "is this row/pin related?" question the table
// and the map both ask per station. Rebuilt only when the list itself changes.
const _relatedIdSet = { list: null, ids: new Set() };

function relatedIdSet() {
  const related = relatedStations();
  if (_relatedIdSet.list !== related) {
    _relatedIdSet.list = related;
    _relatedIdSet.ids  = new Set(related.map(s => s.id));
  }
  return _relatedIdSet.ids;
}

// The list under the map: the filter's own matches, then what the pass ranges
// pulled in behind them — unless stations have been picked off the map, which
// overrides the lot until it is cleared (see the Map selection section).
function tableStations() {
  if (state.mapSelection.size) return selectedStations();
  const matches = filteredStations();
  const related = relatedStations();
  return related.length ? matches.concat(related) : matches;
}

// ── Side nav ───────────────────────────────────────────────────────────────────
// Everything that touches the nav lives here: the render, the tab switch, the
// collapse and its keyboard equivalent. Nothing else in the file reaches into
// #tab-nav.

function renderTabs() {
  const nav = document.getElementById('tab-nav');
  if (!nav) return;
  const collapsed = state.navCollapsed;
  nav.classList.toggle('collapsed', collapsed);
  syncNavChrome(collapsed);

  // The width transition must not run on the opening render. A tab builds its
  // Leaflet map the moment it renders, and a nav still sliding in from its
  // expanded default hands the map a container width that is wrong by however
  // far the slide had got — which Leaflet then caches. So the nav starts with
  // no transition, the collapsed width is forced to settle, and only then is
  // the animation allowed for the toggles that follow. The class is its own
  // flag — it survives every re-render, and needs no state of its own.
  if (!nav.classList.contains('nav-ready')) {
    void nav.offsetWidth;
    nav.classList.add('nav-ready');
  }

  // On a phone the nav is a drawer over the page, not a column beside it, so
  // the toggle at its top closes a menu rather than narrowing a rail — and has
  // to say so. Collapsed it is never seen there at all: the rail is gone and
  // the header's ☰ is what re-opens the drawer.
  const toggleWord = isPhoneNav()
    ? { icon: '✕', label: 'Close',                title: 'Close the menu' }
    : collapsed
      ? { icon: '»', label: 'Expand',   title: 'Expand the navigation' }
      : { icon: '«', label: 'Collapse', title: 'Collapse the navigation' };

  // Collapsed, the labels are clipped rather than removed: the button keeps its
  // accessible name, and the title attribute gives the sighted user a tooltip.
  const groups = TABS.map(g => `
    <div class="nav-group">
      <h2 class="nav-heading">${esc(g.group)}</h2>
      <ul class="nav-list">
        ${g.tabs.map(t => {
          const on = state.activeTab === t.id;
          return `
        <li>
          <button class="tab-btn${on ? ' active' : ''}" onclick="switchTab('${t.id}')"
                  ${on ? 'aria-current="page"' : ''} title="${esc(t.label)}">
            <span class="nav-icon" aria-hidden="true">${t.icon}</span>
            <span class="nav-label">${esc(t.label)}</span>
          </button>
        </li>`;
        }).join('')}
      </ul>
    </div>`).join('');

  nav.innerHTML = `
    <div class="nav-inner" onkeydown="navKey(event)">
      <button class="nav-toggle" onclick="toggleNav()" aria-controls="tab-nav"
              aria-expanded="${collapsed ? 'false' : 'true'}"
              title="${toggleWord.title}">
        <span class="nav-icon" aria-hidden="true">${toggleWord.icon}</span>
        <span class="nav-label">${toggleWord.label}</span>
      </button>
      ${groups}
    </div>`;
}

function switchTab(id) {
  // The Network View runs a force layout on an animation frame loop. Leaving the
  // tab is the moment it has to stop — a simulation ticking away behind another
  // tab is invisible, useless and costs a frame's work every frame. Its own init
  // starts it again when the tab comes back, so this is unconditional.
  NetworkView.stop();
  // The ARRO Data chart keeps a ResizeObserver on its stage, which the next
  // render replaces wholesale. Dropping it here stops the observer outliving
  // the element it was watching.
  ArroData.stop();
  // Same for the ALERT2 tab's coverage map: the div it was built on is about to
  // be discarded, and a Leaflet map holding a detached node keeps its tile
  // requests and window listeners alive behind whatever tab replaces it.
  Alert2.stop();
  state.activeTab = id;
  // On a phone the expanded nav is a drawer laid over the content rather than
  // a column beside it (see styles.css). Picking a tab is the end of that
  // errand, so the drawer closes behind you instead of covering what you came
  // for. No map to re-measure: the drawer never took the width in the first
  // place.
  if (!state.navCollapsed && isPhoneNav()) {
    state.navCollapsed = true;
    localStorage.setItem('mn-nav', 'collapsed');
  }
  // Same errand, same ending: the help drawer's "See also" links switch tabs,
  // and a drawer left over the tab you were sent to is in the way. The panel
  // itself stays open above the breakpoint, where it is a column and not a
  // drawer — it is meant to be read alongside the tab it describes.
  if (!state.helpCollapsed && isPhoneNav()) {
    state.helpCollapsed = true;
    localStorage.setItem('mn-help', 'collapsed');
  }
  renderTabs();
  renderHelp();
  renderMain();
}

// Below this width the icon rail is gone from the layout entirely and the nav
// is a drawer opened from the header — 56 px of permanent rail is a seventh of
// a 390 px screen, and the tables and maps need it more than the icons do.
// Kept in step with the matching breakpoint in styles.css.
function isPhoneNav() {
  return window.matchMedia('(max-width: 560px)').matches;
}

// The two bits of chrome that live outside #tab-nav and have to agree with it:
// the header's hamburger (the only way to open the drawer once the rail is
// gone) and the backdrop that closes it again.
function syncNavChrome(collapsed) {
  const burger = document.getElementById('btn-nav');
  if (burger) {
    burger.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    burger.classList.toggle('on', !collapsed);
  }
  const backdrop = document.getElementById('nav-backdrop');
  if (backdrop) backdrop.hidden = collapsed || !isPhoneNav();
}

function toggleNav() {
  setNavCollapsed(!state.navCollapsed);
}

function setNavCollapsed(collapsed) {
  state.navCollapsed = !!collapsed;
  localStorage.setItem('mn-nav', state.navCollapsed ? 'collapsed' : 'expanded');
  // The other half of the one-drawer-at-a-time rule — see setHelpCollapsed().
  if (!state.navCollapsed && isPhoneNav() && !state.helpCollapsed) {
    state.helpCollapsed = true;
    localStorage.setItem('mn-help', 'collapsed');
    renderHelp();
  }
  renderTabs();
  // The nav just took a column from the main area, or gave one back. Leaflet
  // only watches the window, so a map left unmeasured renders grey tiles and
  // hands back click coordinates offset by however much the width moved.
  // (Not on a phone — there the drawer floats and the main area never moves.)
  if (!isPhoneNav()) invalidateMapSizes(NAV_TRANSITION_MS + 40);
  // Focus follows the button through the re-render, or a keyboard collapse
  // drops the user back at the top of the page. Closing the phone drawer sends
  // focus back to the hamburger that opened it — the drawer's own toggle has
  // just gone off-screen with the rail.
  const btn = (isPhoneNav() && state.navCollapsed)
    ? document.getElementById('btn-nav')
    : document.querySelector('#tab-nav .nav-toggle');
  if (btn) btn.focus();
}

// Every Leaflet map the app holds open. They are created lazily per tab, so
// most of these are null most of the time.
function invalidateMapSizes(delay) {
  setTimeout(() => {
    [state.map, state.bfMap, state.a2.map, state.wb && state.wb.map, state.nvMap].forEach(m => {
      if (m) { try { m.invalidateSize(); } catch (_) {} }
    });
  }, delay || 0);
}

// ── Help panel ────────────────────────────────────────────────────────────────
// A right-hand rail carrying whatever HELP has to say about the open tab. It
// borrows the left nav's interaction contract wholesale (#47 / README §14): it
// collapses to a strip rather than to nothing, it remembers which it was, and
// it re-measures the maps after the width transition instead of during it.
//
// Where it deliberately differs, and why — a reference surface is not a
// navigation one, and this is the third column on a page that already budgets
// for two:
//
//  * It starts collapsed at every width (see state.helpCollapsed), not just
//    under 900 px the way the nav does.
//  * Under 560 px, where the nav leaves the layout and opens as a drawer, this
//    does the same — but the two are mutually exclusive. Opening either closes
//    the other, so a 390 px screen is never asked to hold two drawers at once.
//  * The nav's phone answer was to move its toggle into the header, which works
//    because ☰ already had the slot on the left. There is no matching slot on
//    the right, and a seventh header button cost the banner a whole extra row
//    at 390 px. So the strip stays — it just stops taking a column and becomes
//    a fixed tab on the screen edge instead, which is what "collapses to a
//    strip, never to nothing" was supposed to mean anyway.
//
// Above 560 px both are ordinary columns and may be open together: the Stations
// tab drops to a single column at 1100 px, so the only widths where nav + filter
// pane + help all take width at once are the ones with width to give.

// Where a help link into docs/ should point. Markdown served off GitHub Pages
// is a download rather than a page, so .md goes to GitHub's renderer while
// anything already HTML is served from the site itself. Derived from the raw
// URL the loader already carries, so the owner/repo is written once.
function docUrl(path) {
  if (!/\.md$/i.test(path)) return path;
  return GITHUB_RAW_URL.replace('https://raw.githubusercontent.com/', 'https://github.com/')
                       .replace(/\/main\/.*$/, '/blob/main/') + path;
}

// The one piece of chrome that lives outside #help-panel and has to agree with
// it: the backdrop that dismisses the phone drawer. (The nav needs syncNavChrome
// to keep the header's ☰ in step as well; this panel keeps its only toggle
// inside itself at every width, so there is nothing else to sync.)
function syncHelpChrome(collapsed) {
  const backdrop = document.getElementById('help-backdrop');
  if (backdrop) backdrop.hidden = collapsed || !isPhoneNav();
}

function toggleHelp() {
  setHelpCollapsed(!state.helpCollapsed);
}

function setHelpCollapsed(collapsed) {
  state.helpCollapsed = !!collapsed;
  localStorage.setItem('mn-help', state.helpCollapsed ? 'collapsed' : 'expanded');
  // One drawer at a time on a phone. Written out here rather than by calling
  // setNavCollapsed(), which would call straight back into this one.
  if (!state.helpCollapsed && isPhoneNav() && !state.navCollapsed) {
    state.navCollapsed = true;
    localStorage.setItem('mn-nav', 'collapsed');
    renderTabs();
  }
  renderHelp();
  // The panel just took a column from the main area or gave one back, and
  // Leaflet only watches the window — the same trap the nav documents. Not on a
  // phone, where the drawer floats and the main area never moves.
  if (!isPhoneNav()) invalidateMapSizes(HELP_TRANSITION_MS + 40);
  // Focus follows the button through the re-render, or a keyboard collapse
  // drops the user back at the top of the page. One target at every width: the
  // toggle is inside the panel whether the panel is a column, a strip or an
  // edge tab.
  const btn = document.querySelector('#help-panel .help-toggle');
  if (btn) btn.focus();
}

function renderHelp() {
  const panel = document.getElementById('help-panel');
  if (!panel) return;
  const collapsed = state.helpCollapsed;
  panel.classList.toggle('collapsed', collapsed);
  syncHelpChrome(collapsed);

  // Same reason renderTabs() does this — a map built on the opening render must
  // not measure itself against a rail that is still sliding. The class is its
  // own flag and survives every re-render.
  if (!panel.classList.contains('help-ready')) {
    void panel.offsetWidth;
    panel.classList.add('help-ready');
  }

  const toggle = collapsed
    ? { icon: '?', label: 'Help',  title: 'Open help for this tab' }
    : isPhoneNav()
      ? { icon: '✕', label: 'Close', title: 'Close help' }
      : { icon: '»', label: 'Hide',  title: 'Collapse help' };

  const tab = TAB_LIST.find(t => t.id === state.activeTab);
  const h   = HELP[state.activeTab];

  // HELP's prose is authored in this file and may carry markup, so it is not
  // escaped — see the note on HELP. Everything drawn from TABS is escaped the
  // same way renderTabs() escapes it.
  const section = (heading, body) => body ? `<h3 class="help-h">${heading}</h3>${body}` : '';

  const watch = h && h.watch && h.watch.length
    ? `<ul class="help-list help-bullets">${h.watch.map(w => `<li>${w}</li>`).join('')}</ul>`
    : '';

  const related = h && h.related && h.related.length
    ? `<ul class="help-list">${h.related.map(id => {
        const r = TAB_LIST.find(t => t.id === id);
        return r ? `<li>
          <button class="help-link" onclick="switchTab('${r.id}')" title="Go to ${esc(r.label)}">
            <span class="nav-icon" aria-hidden="true">${r.icon}</span>
            <span>${esc(r.label)}</span>
          </button></li>` : '';
      }).join('')}</ul>`
    : '';

  const links = h && h.links && h.links.length
    ? `<ul class="help-list help-bullets">${h.links.map(l =>
        `<li><a href="${esc(docUrl(l.href))}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`
      ).join('')}</ul>`
    : '';

  // A tab with no HELP entry says so rather than rendering an empty panel — the
  // panel is always present, so an empty one reads as broken rather than as
  // unwritten.
  const body = h
    ? `<p class="help-summary">${h.summary}</p>
       ${section('Watch out for', watch)}
       ${section('See also', related)}
       ${section('Read more', links)}`
    : `<p class="help-summary help-empty">Nothing written for this tab yet.</p>`;

  panel.innerHTML = `
    <div class="help-inner">
      <button class="help-toggle" onclick="toggleHelp()" aria-controls="help-panel"
              aria-expanded="${collapsed ? 'false' : 'true'}"
              title="${toggle.title}">
        <span class="nav-icon" aria-hidden="true">${toggle.icon}</span>
        <span class="nav-label">${toggle.label}</span>
      </button>
      <div class="help-body">
        <h2 class="help-tab">
          <span class="nav-icon" aria-hidden="true">${tab ? tab.icon : '❔'}</span>
          <span>${esc(tab ? tab.label : 'Help')}</span>
        </h2>
        ${body}
      </div>
    </div>`;
}

// Up and down walk the tabs, ignoring the group headings — the list reads as
// one column, so it should drive as one column.
function navKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const btns = [...document.querySelectorAll('#tab-nav .tab-btn')];
  const i    = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const next = btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length];
  if (next) { next.focus(); e.preventDefault(); }
}

// ── Main content dispatcher ────────────────────────────────────────────────────

function renderMain() {
  const el = document.getElementById('main-content');
  if (!el) return;
  // The ARRO launcher joins these because its raw-id box works with no file
  // loaded at all — only the station search needs stations.json, and it says so.
  // ARRO Data joins them too: a dropped CSV parses and plots on its own, and
  // only the link back to a station needs the station file.
  const noDataTabs = ['packets', 'alert2', 'maps', 'serial', 'arro', 'arrodata'];
  if (!state.data && !noDataTabs.includes(state.activeTab)) { el.innerHTML = renderEmpty(); return; }
  switch (state.activeTab) {
    case 'stations':   el.innerHTML = renderStationsHtml();  initStationFilters(); initMap(); break;
    case 'maps':       el.innerHTML = Maps.render();          Maps.init();         break;
    case 'networks':   el.innerHTML = renderNetworksHtml();               break;
    case 'passranges': el.innerHTML = renderPassRangesHtml();             break;
    case 'rf':         el.innerHTML = renderRfHtml();        initRf();    break;
    case 'rfchanges':  el.innerHTML = RfChanges.render();    RfChanges.init();    break;
    case 'workbench':  el.innerHTML = Workbench.render();    Workbench.init();    break;
    case 'bitflipper': el.innerHTML = renderBitFlipperHtml(); initBitFlipperMap(); break;
    case 'network':    el.innerHTML = NetworkView.render();  NetworkView.init();  break;
    case 'packets':    el.innerHTML = Packets.render();       Packets.init();      break;
    case 'alert2':     el.innerHTML = Alert2.render();        Alert2.init();       break;
    case 'serial':     el.innerHTML = Serial.render();        Serial.init();       break;
    case 'arro':       el.innerHTML = renderArroHtml();      initArro();  break;
    case 'arrodata':   el.innerHTML = ArroData.render();      ArroData.init();     break;
    // Same module, second instance — see the comment at the top of ArroData.
    case 'field':      el.innerHTML = ArroData.render('field'); ArroData.init();  break;
    case 'export':     el.innerHTML = renderExportHtml();     initExport();     break;
    default:           el.innerHTML = '<p style="padding:1rem">Unknown tab</p>';
  }
  updateChromeHeight();     // the Stations panes size themselves off it
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
  const stations = tableStations();
  // Empty while nothing is selected — the panel then carries `hidden` rather
  // than an empty box between the table and the editor.
  const carriers = stationCarriersHtml();
  return `
    <div class="layout map-layout">
      <aside class="sidebar stack map-pane" id="stations-left">
        <div class="panel filter-panel" id="station-filters">
          ${stationFiltersHtml()}
        </div>
        <div class="panel">
          <div class="panel-header"><h3>Map display</h3></div>
          <div class="filter-block" id="map-display-block">
            ${mapDisplayControlsHtml()}
          </div>
          <div class="filter-block">
            ${acmaFilterBlockHtml()}
          </div>
        </div>
        <div class="panel" id="map-draw-panel">
          ${MapDraw.panelHtml()}
        </div>
        <div class="panel">
          <div class="map-legend" id="map-legend">${mapLegendHtml()}</div>
        </div>
      </aside>
      <div class="map-split" id="stations-split" role="separator" aria-orientation="vertical"
           aria-label="Resize the filter pane" tabindex="0" title="Drag to resize · double-click to reset"
           onpointerdown="splitDragStart(event)" ondblclick="setSplitWidth(320,true)"
           onkeydown="splitKey(event)"></div>
      <div class="stack map-pane" id="stations-right">
        <div class="panel" style="padding:.6rem;position:relative">
          <div id="leaflet-map"></div>
          <div id="map-note" class="map-note" hidden></div>
          <div id="acma-card" class="acma-card" hidden></div>
        </div>
        <div class="panel" id="path-profile-panel" hidden></div>
        <div class="panel" id="link-budget-panel">${LinkBudget.panelHtml()}</div>
        <div class="panel">
          <div class="panel-header">
            <h2>Stations <span class="badge" id="st-count">${stations.length}</span></h2>
            <button onclick="editorNew()">+ New</button>
          </div>
          <div class="table-wrap tall" id="stations-table-wrap">
            ${stationsTable(stations)}
          </div>
        </div>
        <div class="panel" id="stations-carriers-card" ${carriers ? '' : 'hidden'}>
          ${carriers}
        </div>
        <div class="panel" id="stations-editor-card">
          ${renderStationEditorCard()}
        </div>
      </div>
    </div>`;
}

// ── Stations tab: the two panes ──────────────────────────────────────────────
// The filter pane and the map/table column are both taller than the screen, and
// while the page scrolled as one piece, reaching a filter at the bottom of the
// sidebar scrolled the map out of sight. Each column now fills the space under
// the header and scrolls inside itself, and the divider between them drags to
// re-split the width.

// How much vertical room the header takes. Measured rather than assumed: its
// title and its row of buttons wrap on a narrow window, and the panes size
// themselves off what's left. The nav used to be counted here too; it sits
// beside the main area now, so it costs the panes no height at all.
function updateChromeHeight() {
  const hdr = document.querySelector('header');
  const bar = document.getElementById('mem-bar');
  const h = (hdr ? hdr.offsetHeight : 0) + (bar && !bar.hidden ? bar.offsetHeight : 0);
  document.documentElement.style.setProperty('--mn-chrome', `${h}px`);
}

// `save` is left off while a drag is in flight — the width is written once the
// operator lets go, not sixty times a second.
function setSplitWidth(px, save) {
  state.splitW = Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, px)));
  document.documentElement.style.setProperty('--mn-split', `${state.splitW}px`);
  if (save) localStorage.setItem('mn-split', state.splitW);
}

function splitDragStart(e) {
  const bar    = e.currentTarget;
  const layout = bar.parentElement;
  if (!layout) return;
  const left = layout.getBoundingClientRect().left;
  bar.classList.add('dragging');
  bar.setPointerCapture(e.pointerId);
  const move = ev => setSplitWidth(ev.clientX - left);
  const done = () => {
    bar.classList.remove('dragging');
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', done);
    bar.removeEventListener('pointercancel', done);
    setSplitWidth(state.splitW, true);
    // The map just changed width underneath Leaflet, which only watches the window.
    if (state.map) state.map.invalidateSize();
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', done);
  bar.addEventListener('pointercancel', done);
  e.preventDefault();
}

// Keyboard equivalent of the drag, so the split isn't mouse-only.
function splitKey(e) {
  const step = e.shiftKey ? 48 : 16;
  if (e.key === 'ArrowLeft')       setSplitWidth(state.splitW - step, true);
  else if (e.key === 'ArrowRight') setSplitWidth(state.splitW + step, true);
  else if (e.key === 'Home')       setSplitWidth(320, true);
  else return;
  e.preventDefault();
  if (state.map) state.map.invalidateSize();
}

// ── Map display block ────────────────────────────────────────────────────────

// Past this the slider is measuring nothing real — no pass-range hop on this
// network reaches it. "Kill spaghetti" off is the escape hatch for the operator
// who wants every path drawn however absurd, so the cap can stay this tight.
const MAX_LINK_KM_CAP = 600;

function mapDisplayControlsHtml() {
  const on = state.mapKillSpaghetti;
  return `
    <label class="filter-check">
      <input type="checkbox" ${state.mapHideOthers ? 'checked' : ''}
             onchange="state.mapHideOthers=this.checked;refreshMapLayers()">
      Hide stations that don't match
    </label>
    <label class="filter-check">
      <input type="checkbox" ${state.mapRelated ? 'checked' : ''}
             onchange="state.mapRelated=this.checked;stationsFilterChanged()">
      Include related repeaters
    </label>
    <label class="filter-check">
      <input type="checkbox" ${state.mapShowLinks ? 'checked' : ''}
             onchange="state.mapShowLinks=this.checked;rerenderMapDisplayControls();refreshMapLayers()">
      Show signal links
    </label>
    <label class="filter-range${state.mapShowLinks ? '' : ' is-off'}">
      <span>Link opacity <strong id="link-opacity-val">${Math.round(state.mapLinkOpacity * 100)}%</strong></span>
      <input type="range" min="0.1" max="1" step="0.05" value="${state.mapLinkOpacity}"
             ${state.mapShowLinks ? '' : 'disabled'}
             oninput="document.getElementById('link-opacity-val').textContent=Math.round(this.value*100)+'%'"
             onchange="setMapLinkOpacity(+this.value)">
    </label>
    <label class="filter-check">
      <input type="checkbox" ${on ? 'checked' : ''}
             onchange="state.mapKillSpaghetti=this.checked;rerenderMapDisplayControls();refreshMapLayers()">
      Kill spaghetti
    </label>
    <label class="filter-range${on ? '' : ' is-off'}">
      <span>Max TX distance <strong id="max-tx-val">${state.mapMaxLinkKm} km</strong></span>
      <input type="range" min="0" max="${MAX_LINK_KM_CAP}" step="10" value="${state.mapMaxLinkKm}"
             ${on ? '' : 'disabled'}
             oninput="document.getElementById('max-tx-val').textContent=this.value+' km'"
             onchange="state.mapMaxLinkKm=+this.value;refreshMapLayers()">
    </label>
    <label class="filter-check">
      <input type="checkbox" ${state.mapRivers ? 'checked' : ''}
             onchange="MapRivers.setEnabled(this.checked)">
      Highlight matching rivers
    </label>
    <p class="filter-note" id="map-river-note">${MapRivers.noteHtml()}</p>
    <label class="filter-field" style="margin-top:.5rem">
      <span>Station names</span>
      <select onchange="setMapLabelMode(this.value)">
        ${[['auto', 'Auto — when few enough are in view'],
           ['on',   'On'],
           ['off',  'Off']].map(([v, l]) =>
          `<option value="${v}" ${state.mapLabelMode === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <p class="filter-note" id="map-link-note">${mapLinkNoteHtml()}</p>`;
}

function rerenderMapDisplayControls() {
  const el = document.getElementById('map-display-block');
  if (el) el.innerHTML = mapDisplayControlsHtml();
}

// What the link controls are actually doing. Counted on the last refresh so the
// note survives a re-render of the pane.
function mapLinkNoteHtml() {
  const { drawn, culled } = state.mapLinkCount;
  if (!state.mapShowLinks) return 'Signal links are hidden.';
  const links = n => `${n} link${n === 1 ? '' : 's'}`;
  if (!state.mapKillSpaghetti) {
    return `${links(drawn)} drawn — every pass-range path, however long.`;
  }
  return culled
    ? `${links(drawn)} drawn · <strong>${culled}</strong> over ${state.mapMaxLinkKm} km hidden.`
    : `${links(drawn)} drawn · none over ${state.mapMaxLinkKm} km.`;
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
      <span class="legend-dot legend-dot-rel" style="background:${ROLE_COLOR.repeater}"></span>
      <span class="small">Related by pass range</span>
    </span>
    <span class="legend-item">
      <span class="legend-line"></span>
      <span class="small">Pass-range link</span>
    </span>
    ${MapRivers.active() ? `
    <span class="legend-item">
      <span class="legend-line legend-line-river"></span>
      <span class="small">Matching watercourse (OpenStreetMap)</span>
    </span>` : ''}
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
  state.stationsShowAll = false;   // a changed filter earns a fresh row cap
  refreshMapLayers();
  MapRivers.sync();                // additive: rivers never touch what matched
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
  MapDraw.detach();
  LinkBudget.detach();
  MapRivers.detach();
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  // preferCanvas: with ~3,174 station pins and ~3,141 pass-range link lines,
  // the default SVG renderer means ~6,300 SVG nodes rebuilt on every refresh.
  // A single canvas element instead.
  state.map = L.map('leaflet-map', { preferCanvas: true });
  // A view before anything is added to the map. Leaflet defers every layer add
  // until the map has one, and the deferred adds then run in an order nothing
  // controls: a path registers the shared SVG renderer as it is queued, so a
  // layer group queued earlier can be drawn against a renderer that has not
  // been set up yet. It is replaced by the fit below on the same tick.
  state.map.setView(MAP_HOME, 4);
  state.mapFitKey = null;              // a fresh map always fits its contents once
  addBaseLayers(state.map);
  MapSpider.attach(state.map);
  MapLocate.attach(state.map);
  MapDraw.attach(state.map);
  LinkBudget.attach(state.map);
  // Before the first refresh, so the fit that refresh performs is the view the
  // first river lookup is bounded by.
  MapRivers.attach(state.map);
  // Shapes survive a tab switch, so a line drawn earlier still has a profile to
  // show on the map that has just been rebuilt.
  PathProfile.sync();
  state.map.on('click', () => { acmaClearHighlight(); clearMapFocusRepeater(); });
  // Auto/On name labels are picked from what is in view, so they are re-picked
  // whenever the view changes rather than only when the layers are rebuilt.
  state.map.on('moveend zoomend', applyMapLabels);
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
const MAP_PIN_REL   = '#00b8d4';   // dashed ring: on the map by relation, not by name
const MAP_PIN_SEL   = '#7c4dff';   // heavy ring: hand-picked into the map selection.
                                   // Violet is none of the role fills, none of the
                                   // ACMA colours, and neither the amber of a filter
                                   // match nor the cyan of a pass-range relation.
const MAP_HOME      = [-25.6, 134.3];   // middle of Australia — the opening view,
                                        // replaced by a fit to whatever is plotted

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
  const related = relatedStations().length;
  return `<strong>${matched.length}</strong> of ${total} stations match` +
         (related ? ` · <strong>${related}</strong> more via pass range` : '') +
         (located < matched.length ? ` · ${matched.length - located} without a position` : '') +
         (located > MAP_LABEL_CAP ? ` · labels on the closest ${MAP_LABEL_CAP}` : '');
}

function updateMapMatchNote() {
  const el = document.getElementById('map-match-note');
  if (el) el.innerHTML = mapMatchNoteHtml();
}

function updateMapLinkNote() {
  const el = document.getElementById('map-link-note');
  if (el) el.innerHTML = mapLinkNoteHtml();
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

// A pass-range line is drawn twice: a wide white casing underneath and the
// coloured line on top. On satellite and topo tiles a single 1.5 px orange line
// disappears into the imagery; the casing is what carries it on every basemap.
const MAP_LINK_CASING_W  = 3.5;
const MAP_LINK_CORE_W    = 1.5;
const MAP_LINK_CASING_MIX = 0.75;   // casing opacity, as a fraction of the core's

// `skipFit` clears the fit for this refresh while still recording the extent it
// would have fitted, so the map holds the operator's pan and zoom and the next
// genuine change still moves it. See clearStationFilters.
function refreshMapLayers({ skipFit = false } = {}) {
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
  // Stations on the map because a pass range links them to a match, not because
  // they matched the filter themselves. Drawn as hits, ringed differently.
  const relIds   = active ? relatedIdSet() : null;
  const related  = active ? located.filter(s => relIds.has(s.id)) : [];

  // Links follow the highlight: with a filter running, only the matched and
  // related stations draw theirs, so the lines don't bury the pins they're meant
  // to explain. They are resolved before the pins because in hide mode they
  // decide which repeaters have to stay on the map.
  const allLinks = state.mapShowLinks
    ? passRangeLinks(active ? matched.concat(related) : located) : [];
  const maxKm = state.mapKillSpaghetti ? state.mapMaxLinkKm : Infinity;
  const links = allLinks.filter(l => l.km <= maxKm);
  state.mapLinkCount = { drawn: links.length, culled: allLinks.length - links.length };
  updateMapLinkNote();

  // Highlight mode keeps every pin on the map; hide mode drops the rest —
  // except the repeaters at the far end of a drawn path. Hiding those left the
  // TX path on screen with nothing at the end of it: the one station the
  // operator most wants to see is the one the signal is going to.
  let stations = (active && state.mapHideOthers) ? matched.concat(related) : located;
  if (active && state.mapHideOthers && links.length) {
    const shown = new Set(stations.map(s => s.id));
    const kept  = [];
    for (const l of links) if (!shown.has(l.r.id)) { shown.add(l.r.id); kept.push(l.r); }
    if (kept.length) stations = stations.concat(kept);
  }
  updateMapMatchNote();
  if (!stations.length) { MapSpider.setPins('stations', []); state.mapMatchLabels = new Set(); return; }

  // A filter's matches are always named — that is what the filter was for —
  // while the set is small enough to read; the nearest to the matched extent
  // win. Everything else is named off the viewport, in applyMapLabels.
  state.mapMatchLabels = new Set(
    active && matched.length
      ? (matched.length <= MAP_LABEL_CAP ? matched : mapNearestToCentre(matched, MAP_LABEL_CAP))
          .map(s => s.id)
      : []);

  const lineColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--map-line').trim() || '#ff6f00';
  const coreOp   = state.mapLinkOpacity;
  const casingOp = coreOp * MAP_LINK_CASING_MIX;

  // Every casing first, then every core: pairing them per link would let one
  // link's white casing paint over another link's coloured line where they cross.
  for (const pass of ['casing', 'core']) {
    const casing = pass === 'casing';
    for (const l of links) {
      const lineOp = casing ? casingOp : coreOp;
      const line = L.polyline([[l.s.lat, l.s.lon], [l.r.lat, l.r.lon]], {
        color:   casing ? '#ffffff' : lineColor,
        weight:  casing ? MAP_LINK_CASING_W : MAP_LINK_CORE_W,
        opacity: lineOp,
      }).addTo(map);
      line.mnLinkRole       = pass;         // lets the opacity slider restyle in place
      line.mnLinkStationId  = l.s.id;       // and lets repeater focus restyle in place
      line.mnLinkRepeaterId = l.r.id;
      line.mnBaseOpacity    = lineOp;
      state.mapLines.push(line);
    }
  }

  for (const s of stations) {
    const role   = primaryRole(s);
    const color  = ROLE_COLOR[role] || ROLE_COLOR.field;
    const isRpt  = s.roles.includes('repeater');
    const hit    = active && matchIds.has(s.id);
    const rel    = active && !hit && relIds.has(s.id);
    const dim    = active && !hit && !rel;
    const radius = (isRpt ? 8 : 5) + (hit || rel ? 1 : 0);
    // Every pin carries a white ring so it separates from the base map and from
    // its neighbours; matches swap it for amber, and stations pulled in by a
    // pass range for a dashed cyan one — full opacity either way, but you can
    // still tell which of them the filter actually named.
    //
    // That style is kept on the marker as well, so the map selection's own ring
    // can be put on and taken off with setStyle rather than by rebuilding
    // ~3,174 markers — and so it survives the canvas renderer, which draws no
    // DOM node for a className to land on.
    const base = {
      radius,
      color:       hit ? MAP_PIN_HIT : rel ? MAP_PIN_REL : MAP_PIN_RING,
      weight:      hit || rel ? 3 : 2,
      dashArray:   rel ? '4,3' : null,
      opacity:     dim ? 0.6 : 1,
      fillOpacity: dim ? 0.45 : 1,
    };
    const marker = L.circleMarker([s.lat, s.lon], {
      ...base,
      fillColor:   color,
      className:   hit ? 'mn-pin mn-pin-hit' : rel ? 'mn-pin mn-pin-rel' : 'mn-pin',
      bubblingMouseEvents: false,          // a pin click is not an empty-map click
    }).addTo(map);
    marker.mnStationId = s.id;             // lets the table below find its pin
    marker.mnStation   = s;                // and lets labels be re-picked on pan
    marker.mnRadius    = radius;
    marker.mnBaseStyle = base;

    // bindPopup takes a function so the HTML is built when the popup opens,
    // not for all ~3,174 markers on every refresh.
    marker.bindPopup(() => {
      const idTypes = stationAlertIdTypes(s);
      const arroUrl = arroSiteUrl(arroSiteId(s));
      return `
      <strong>${esc(s.name)}</strong><br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.78rem;margin-right:2px">${r}</span>`).join('')}<br>
      ${s.roles.includes('repeater') && repeaterPassingCount(s) != null
        ? `<span style="font-size:.83rem">passing ${repeaterPassingCount(s)}</span><br>` : ''}
      ${s.station_number ? `<span style="font-size:.83rem">Stn #${esc(s.station_number)}</span><br>` : ''}
      ${idTypes.length ? `<span style="font-size:.83rem">AlertID:</span><br>${idTypes.map(t =>
        `<span style="font-size:.82rem">&nbsp;&nbsp;${t.types.length ? esc(t.types.join(' / ')) + ' — ' : ''}${t.id}</span>`).join('<br>')}<br>` : ''}
      ${s.elevation_ahd != null ? `<span style="font-size:.83rem">Elev: ${s.elevation_ahd} m AHD</span>` : ''}
      ${acmaRepeaterPopupExtra(s)}
      <div class="mn-popup-actions">
        <a href="#" onclick="focusStation('${escAttr(s.id)}');return false"
           title="Select this station in the list under the map">Show in the list below ↓</a>
        <a href="#" onclick="zoomToStation('${escAttr(s.id)}');return false"
           title="Zoom the map to the ~50 km area around this station">Zoom to station</a>
        ${arroUrl ? `<a href="${esc(arroUrl)}" target="_blank" rel="noopener"
           title="ARRO site ${esc(arroSiteId(s))} — the telemetry admin page for this station"
           >Open in ARRO admin ↗</a>` : ''}
        ${mapLinksHtml(s)}
      </div>
    `;
    });
    // Leaflet opens a bound popup on every click of its layer. Take that over,
    // so a modifier-click can mean "put this in the selection" without a popup
    // opening and closing again — a closed popup leaves its container fading
    // over the map for another 200 ms, which is long enough to swallow the next
    // click. Removing the handler leaves the binding itself intact, so
    // openPopup() and isPopupOpen() go on working everywhere else.
    marker.off('click', marker._openPopup);
    marker.on('click', onStationPinClick);
    state.mapMarkers.push(marker);
  }

  applyMapSelectionStyles();
  applyMapFocusStyles();
  MapSpider.setPins('stations', state.mapMarkers);

  // Zoom to the matches (all of them, not just the first) and to the repeaters
  // pulled in behind them — a path with its far end off-screen explains
  // nothing. Or to everything, when no filter is running.
  const fitSet = active && matched.length ? matched.concat(related) : stations;
  const fitTo  = fitSet.map(s => [s.lat, s.lon]);
  const key    = mapFitKey(fitTo);
  if (fitTo.length && key !== state.mapFitKey) {
    state.mapFitKey = key;
    // The extent is recorded either way, so a suppressed fit is skipped once
    // rather than deferred to the next refresh that happens along.
    if (!skipFit) map.fitBounds(fitTo, { padding: [24, 24], maxZoom: fitTo.length === 1 ? 14 : 12 });
  }
  applyMapLabels();
}

// ── Map selection ────────────────────────────────────────────────────────────
// A set of stations picked off the map, by drawing a shape around them or by
// modifier-clicking their pins. It is a third thing alongside the filters and
// `state.selectedId`: the filters decide what the map highlights, `selectedId`
// is the single station the editor card is on, and this is the operator's own
// pick. While it is non-empty it overrides what the table lists — a display
// override, not a filter mutation, so clearing it hands the list straight back
// to the filter.
//
// Session state, like the drawings: nothing is saved and nothing goes in the URL.

function selectedStations() {
  if (!state.data || !state.mapSelection.size) return [];
  return state.data.stations.filter(s => state.mapSelection.has(s.id));
}

// Put the selected ring on, or take it off, in place. Only the pins whose
// membership actually changed are restyled.
function applyMapSelectionStyles() {
  for (const m of state.mapMarkers) {
    const base = m.mnBaseStyle;
    if (!base) continue;
    const on = state.mapSelection.has(m.mnStationId);
    if (on === !!m.mnSelected) continue;
    m.mnSelected = on;
    m.mnRadius   = on ? base.radius + 3 : base.radius;
    m.setStyle(on
      ? { radius: m.mnRadius, color: MAP_PIN_SEL, weight: 4,
          dashArray: null, opacity: 1, fillOpacity: 1 }
      : { ...base });
  }
}

// Everything that changes the selection ends here: the pins, the list under the
// map and its header all move together.
function mapSelectionChanged() {
  applyMapSelectionStyles();
  applyMapFocusStyles();
  rerenderStations();
}

function toggleMapSelection(id) {
  if (state.mapSelection.has(id)) state.mapSelection.delete(id);
  else                            state.mapSelection.add(id);
  mapSelectionChanged();
}

// Additive: two boxes drawn over two regions give one selection holding both.
// Returns how many ids were new, which is what the caller reports.
function addToMapSelection(ids) {
  let added = 0;
  for (const id of ids) if (!state.mapSelection.has(id)) { state.mapSelection.add(id); added++; }
  mapSelectionChanged();
  return added;
}

function clearMapSelection() {
  if (!state.mapSelection.size) return;
  state.mapSelection.clear();
  mapSelectionChanged();
}

// Every click on a station pin: shift / ctrl / ⌘ adds or removes it from the
// selection, and a plain click opens the popup, as it always did. A plain
// click on a repeater also focuses it — see setMapFocusRepeater. Both live
// here because refreshMapLayers takes Leaflet's own click-to-open off the
// marker — see the note there.
function onStationPinClick(e) {
  const oe = e.originalEvent;
  if (oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)) {
    L.DomEvent.stop(e);
    toggleMapSelection(e.target.mnStationId);
    return;
  }
  L.DomEvent.stopPropagation(e);      // as Leaflet's own handler did
  const s = e.target.mnStation;
  if (s && s.roles.includes('repeater')) {
    setMapFocusRepeater(state.mapFocusRepeaterId === s.id ? null : s.id);
  }
  e.target.openPopup(e.latlng);
}

// ── Repeater focus ───────────────────────────────────────────────────────────
// Clicking a repeater pin dims every station and link that isn't on one of
// its own pass-range paths, so the repeater's own footprint dominates the
// view. A display overlay like the map selection: it restyles the existing
// markers/lines in place rather than rebuilding them, and clicking the same
// repeater again (or the empty map) clears it.

// The repeater itself plus every field station its pass ranges carry — the
// set of station ids that stay at full opacity while it is focused.
function focusedRepeaterStationIds(repeaterId) {
  if (!repeaterId || !state.data) return null;
  const repeater = state.data.stations.find(s => s.id === repeaterId);
  if (!repeater) return null;
  const ids = new Set(findStationMatches(repeater).map(s => s.id));
  ids.add(repeater.id);
  return ids;
}

function setMapFocusRepeater(id) {
  if (state.mapFocusRepeaterId === id) return;
  state.mapFocusRepeaterId = id;
  applyMapFocusStyles();
  // The "Repeaters listening" card marks whichever of its rows is the focused
  // repeater, so it follows the focus however it was set — a pin click, the
  // empty map, or one of its own rows.
  rerenderStationCarriersCard();
}

function clearMapFocusRepeater() {
  setMapFocusRepeater(null);
}

const MAP_FOCUS_DIM_OPACITY     = 0.15;
const MAP_FOCUS_DIM_FILLOPACITY = 0.12;
const MAP_FOCUS_DIM_LINE_MIX    = 0.2;   // fraction of a link's own opacity, while dimmed

// Put the focus dim on, or take it off, in place — mirrors
// applyMapSelectionStyles. Runs after it so the selection ring still shows
// through on a focused pin, and after every refreshMapLayers rebuild.
function applyMapFocusStyles() {
  const served = focusedRepeaterStationIds(state.mapFocusRepeaterId);
  for (const m of state.mapMarkers) {
    const base = m.mnBaseStyle;
    if (!base) continue;
    const dim = !!served && !served.has(m.mnStationId);
    m.mnFocusDimmed = dim;
    const opacity     = dim ? MAP_FOCUS_DIM_OPACITY     : (m.mnSelected ? 1 : base.opacity);
    const fillOpacity = dim ? MAP_FOCUS_DIM_FILLOPACITY : (m.mnSelected ? 1 : base.fillOpacity);
    m.setStyle({ opacity, fillOpacity });
  }
  for (const l of state.mapLines) {
    if (l.mnBaseOpacity == null) continue;
    const dim = !!served && l.mnLinkRepeaterId !== state.mapFocusRepeaterId;
    l.mnFocusDimmed = dim;
    l.setStyle({ opacity: dim ? l.mnBaseOpacity * MAP_FOCUS_DIM_LINE_MIX : l.mnBaseOpacity });
  }
}

// The selection as a file — the same columns the table shows, plus the station
// id, so the picked set can leave the page for a spreadsheet.
function exportMapSelection() {
  const rows = selectedStations();
  if (!rows.length) return;
  const lines = ['id,name,station_number,roles,networks,alert_ids,lat,lon,elevation_ahd,enabled'];
  for (const s of rows) {
    lines.push([
      csvEscape(s.id),
      csvEscape(s.name),
      csvEscape(s.station_number || ''),
      csvEscape(s.roles.join(' ')),
      csvEscape((s.radio_network_ids || []).map(id => netName(id)).join(' | ')),
      csvEscape(stationAlertIds(s).join(' ')),
      s.lat ?? '', s.lon ?? '', s.elevation_ahd ?? '', s.enabled ? 1 : 0,
    ].join(','));
  }
  dlText(`meganet-selection-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ── Station name labels ──────────────────────────────────────────────────────
// Which pins carry a permanent name, for the current mode and viewport. Auto
// shows them once the view holds few enough to read — at the national view that
// is ~3,100 stations, so they stay off until you zoom into a region.

// Whether the cap was reported last time, so panning around a dense region
// doesn't re-announce it on every moveend.
let _labelCapNoted = false;

function mapLabelIds() {
  const wanted = new Set();
  // Off means off: the operator asked for a clean map, and a filter's matches
  // are still ringed and still zoomed to without a name hanging off them.
  if (state.mapLabelMode === 'off') return wanted;
  for (const id of state.mapMatchLabels) wanted.add(id);

  const map = state.map;
  if (!map || !state.mapMarkers.length) return wanted;
  const bounds = map.getBounds();
  const inView = [];
  for (const m of state.mapMarkers) {
    if (m.mnStation && bounds.contains(m.getLatLng())) inView.push(m.mnStation);
  }

  let capped = false, pick;
  if (state.mapLabelMode === 'on') {
    capped = inView.length > MAP_LABEL_CAP;
    pick   = capped ? mapNearestToCentre(inView, MAP_LABEL_CAP) : inView;
  } else {
    pick = inView.length <= MAP_LABEL_CAP ? inView : [];
  }
  if (capped && !_labelCapNoted) {
    mapNote(`${inView.length} stations in view — naming the ${MAP_LABEL_CAP} closest to the centre.`, 3500);
  }
  _labelCapNoted = capped;

  for (const s of pick) wanted.add(s.id);
  return wanted;
}

// Bind or unbind the name tooltips in place. Called after a rebuild and on
// every pan and zoom, so it only touches the pins whose label actually changed
// — rebuilding ~3,100 markers to add a name is not a pan.
function applyMapLabels() {
  if (!state.map) return;
  const wanted = mapLabelIds();
  for (const m of state.mapMarkers) {
    const s = m.mnStation;
    if (!s) continue;
    const want = wanted.has(s.id);
    const has  = !!m.getTooltip();
    if (want && !has) {
      m.bindTooltip(esc(s.name), {
        permanent: true, direction: 'bottom', offset: [0, m.mnRadius || 6], className: 'mn-pin-label',
      });
    } else if (!want && has) {
      m.unbindTooltip();
    }
  }
}

function setMapLabelMode(mode) {
  state.mapLabelMode = mode;
  _labelCapNoted = false;      // a mode change is worth re-reporting the cap for
  applyMapLabels();
}

// Restyling the polylines already on the map beats rebuilding every layer to
// change one number.
function setMapLinkOpacity(v) {
  state.mapLinkOpacity = v;
  const label = document.getElementById('link-opacity-val');
  if (label) label.textContent = `${Math.round(v * 100)}%`;
  for (const l of state.mapLines) {
    if (l.mnLinkRole === 'casing')    l.setStyle({ opacity: v * MAP_LINK_CASING_MIX });
    else if (l.mnLinkRole === 'core') l.setStyle({ opacity: v });
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

// ── Station table (lower half of the Stations tab) ─────────────────────────────

// Unfiltered, the table would emit ~28,500 cells (3,174 rows × 9) as one
// innerHTML string on every keystroke. Cap what's rendered; the footer link
// lets the operator pull the rest in when they actually want it.
const STATIONS_ROW_CAP = 500;

// What the table says when it is listing a map selection rather than a filter
// result — including the way back to the filter, which is the only way back.
function selectionBarHtml() {
  const n = state.mapSelection.size;
  if (!n) return '';
  return `
    <div class="sel-bar">
      <span class="sel-bar-count"><strong>${n}</strong> station${n === 1 ? '' : 's'} selected</span>
      <span class="sel-bar-note">Picked off the map — not saved, and not part of the filter.</span>
      <span class="sel-bar-actions">
        <button onclick="exportMapSelection()" title="Download these stations as a CSV">Export CSV</button>
        <button class="filter-reset" onclick="clearMapSelection()"
                title="Go back to listing the filter result">Clear selection</button>
      </span>
    </div>`;
}

function stationsTable(allStations) {
  const selBar = selectionBarHtml();
  if (!allStations.length) {
    return selBar + `<p style="padding:.75rem;color:var(--muted)">${selBar
      ? 'None of the selected stations are in the loaded file.'
      : 'No stations match current filters.'}</p>`;
  }
  const capped    = !state.stationsShowAll && allStations.length > STATIONS_ROW_CAP;
  const stations  = capped ? allStations.slice(0, STATIONS_ROW_CAP) : allStations;
  // Same prepared terms the filter itself ran on, so the marks land exactly
  // where the match was made.
  const { terms, nums } = prepareSearch(state.filters.search);
  // Rows the filter didn't name — they are here because a pass range ties them
  // to one that did, and the badge is what says so.
  const relIds = relatedIdSet();
  return `
    ${selBar}
    ${capped ? `
      <p class="filter-note">Showing ${STATIONS_ROW_CAP} of ${allStations.length} —
        narrow the filter or <a href="#" onclick="state.stationsShowAll=true;rerenderStations();return false">show all</a>.</p>
    ` : ''}
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
              <td title="${esc(s.id)}"><span class="stn-name role-${primaryRole(s)}">${markHits(s.name, terms)}</span></td>
              <td class="small">${markHits(s.station_number || '', terms)}</td>
              <td>${s.roles.map(r => `<span class="badge">${r}</span>`).join(' ')}${
                s.roles.includes('repeater') && repeaterPassingCount(s) != null
                  ? ` <span class="badge" title="ALERT addresses carried, in this repeater's open pass ranges">passing ${repeaterPassingCount(s)}</span>`
                  : ''}${
                relIds.has(s.id)
                  ? ' <span class="badge badge--rel" title="Not a filter match — a pass range ties it to one">via pass range</span>'
                  : ''}</td>
              <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
              <td class="small">${aids.map(id => markAlertId(id, nums)).join(', ')}</td>
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
  const stations = tableStations();
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
    state.editorMsg   = null;
    fetchEditorStamp(null);
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
  state.editorMsg   = null;
  fetchEditorStamp(id);        // the version this edit starts from — see #B3
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

// A bounding box roughly radiusKm around a point, for map.fitBounds() — a
// real-world distance rather than a Leaflet zoom level, which covers different
// ground at different latitudes. One degree of latitude is ~111 km everywhere;
// a degree of longitude shrinks by cos(latitude) as it closes in toward the poles.
function boundsForRadiusKm(lat, lon, radiusKm) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
}

// "Zoom to station" from a map popup — centers the station with a 50 km
// wide view of surrounding context visible, regardless of the map's
// current extent when clicked.
function zoomToStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!state.map || !s || s.lat == null || s.lon == null) return;
  state.map.fitBounds(boundsForRadiusKm(s.lat, s.lon, 25));
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
// A repeater the pass ranges pulled in is already a row, so it counts as listed
// even though the filter never named it.
// Returns true when the filters moved, so the caller knows the sidebar has to
// be re-rendered and not just the table.
function selectStationState(s) {
  state.selectedId  = s.id;
  state.editorId    = s.id;
  // Same deep copy as selectStation: fields the form doesn't expose survive a save.
  state.editorDraft = JSON.parse(JSON.stringify(s));
  state.editorMsg   = null;
  fetchEditorStamp(s.id);
  // A map selection is what the table is listing, so a station asked for from
  // outside it has no row to be scrolled to. Adding it is the least destructive
  // answer — the picked set survives, and the count in the header says it grew.
  if (state.mapSelection.size) {
    if (!state.mapSelection.has(s.id)) {
      state.mapSelection.add(s.id);
      applyMapSelectionStyles();
    }
    return false;
  }
  if (relatedIdSet().has(s.id)) return false;
  // Being in the filter result is not enough: the table only draws the first
  // STATIONS_ROW_CAP of it, so an unfiltered list contains all 3,174 stations
  // and renders 500. A station past that has no row to select or scroll to, and
  // arriving from another tab to a table that visibly does not contain what you
  // asked for is the same failure as the filter excluding it — so it gets the
  // same answer.
  const at = filteredStations().findIndex(x => x.id === s.id);
  if (at >= 0 && (state.stationsShowAll || at < STATIONS_ROW_CAP)) return false;
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
  // The card below the table follows the same selection, so every caller that
  // reloads the editor reloads it too — there is no path that changes the
  // selected station without going through here.
  rerenderStationCarriersCard();
}

// ── Repeaters listening to the selected station ──────────────────────────────
// The mirror image of the repeater editor's "ALERT IDs in range → stations"
// list: with a station selected, this says which repeaters have a pass range
// open to *its* addresses — the hop its data actually takes out of the field,
// and the list to check when a station stops arriving.
//
// It reads findRepeaterMatches/passRangeCoversId, the same pair the map links,
// the "via pass range" badge and the Pass Ranges tab all read, so the four
// never disagree about who carries whom.

// The station the panel is about, or null: the selected row, and only when it
// is a station that actually exists. A half-filled "+ New" draft has no id to
// match a pass range against, so the panel stays away until it is saved.
function carriersStation() {
  if (!state.data || !state.selectedId) return null;
  return state.data.stations.find(x => x.id === state.selectedId) || null;
}

// One row's worth of "why is this repeater in the list": the station's own
// addresses this repeater carries, and the ranges that pick them up. The
// bounds test only says *which* range — passRangeCoversId still decides
// whether the address is carried at all, so an excluded address is absent from
// both. Same composition as passRangesHtml on the Pass Ranges tab.
function carrierRangeDetail(repeater, alertIds) {
  const ids    = alertIds.filter(id => passRangeCoversId(repeater.repeater, id));
  const ranges = (repeater.repeater.pass_ranges || [])
    .filter(p => ids.some(id => id >= p.low && id <= p.high))
    .map(p => `${p.low}–${p.high}`);
  return { ids, ranges };
}

function stationCarriersHtml() {
  const s = carriersStation();
  if (!s) return '';
  const ids  = stationAlertIds(s);
  const rpts = findRepeaterMatches(s);

  const rows = rpts
    .map(r => ({
      r,
      ...carrierRangeDetail(r, ids),
      km: (s.lat != null && s.lon != null && r.lat != null && r.lon != null)
        ? acmaHaversineKm(s.lat, s.lon, r.lat, r.lon) : null,
    }))
    // Nearest first — the closest repeater with the address open is the one the
    // station is most likely actually being heard by. Positionless repeaters
    // can't be ranked, so they go last rather than pretending to be at 0 km.
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || a.r.name.localeCompare(b.r.name));

  const header = `
    <div class="panel-header">
      <h2>Repeaters listening</h2>
      <span class="badge" title="Repeaters with a pass range open to this station">${rows.length}</span>
    </div>`;

  // Two different nothings, and they mean opposite things: a station with no
  // ALERT address (telemetry-only, or not configured yet) is not something a
  // pass range could ever cover, while a station that has one and still has no
  // carrier is orphaned — a finding, flagged in the same red the Pass Ranges
  // tab flags orphans in.
  if (!ids.length) {
    return `${header}
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">
        <strong>${esc(s.name)}</strong> has no ALERT address recorded, so there is nothing for a
        pass range to be open to. Telemetry-only stations reach the base another way.
      </p>`;
  }
  if (!rows.length) {
    return `${header}
      <p class="small" style="color:#c7401a;margin:.5rem 0 0">
        <strong>No repeater's pass ranges cover ${ids.length === 1 ? 'address' : 'addresses'}
        ${ids.join(', ')}</strong> — this station is orphaned, and nothing is listening for it.
      </p>`;
  }

  return `${header}
    <p class="small" style="color:var(--muted);margin:.5rem 0 0">
      Pass ranges open to ${ids.length === 1 ? 'address' : 'addresses'} <strong>${ids.join(', ')}</strong>.
      Click a row to put the map on that repeater and dim everything off its own paths — the
      filters, the picked selection and the station in the editor below all stay as they are.
      Clicking it again puts the map back.
    </p>
    <div class="table-wrap medium">
      <table>
        <colgroup>
          <col style="width:28%"><col style="width:18%"><col style="width:14%">
          <col style="width:18%"><col style="width:11%"><col style="width:11%">
        </colgroup>
        <thead>
          <tr>
            <th>Repeater</th><th>Network</th><th>Carries</th>
            <th>In pass range</th><th>Distance</th><th>Passing</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(({ r, ids: carried, ranges, km }) => `
            <tr class="${state.mapFocusRepeaterId === r.id ? 'rpt-focused' : ''}"
                onclick="focusRepeaterOnMap('${escAttr(r.id)}')" style="cursor:pointer"
                title="Put the map on ${escAttr(r.name)} — nothing else on this page moves">
              <td><span class="stn-name role-repeater">${esc(r.name)}</span></td>
              <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
              <td class="small">${carried.join(', ')}</td>
              <td class="small">${ranges.join(', ')}</td>
              <td class="small" title="${km == null ? 'One end has no coordinates recorded' : 'Straight-line distance'}"
                  >${km == null ? '—' : fmtKm(km)}</td>
              <td><span class="badge" title="ALERT addresses this repeater carries in total, post-exclusion">${repeaterPassingCount(r) ?? 0}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function rerenderStationCarriersCard() {
  const el = document.getElementById('stations-carriers-card');
  if (!el) return;
  const html = stationCarriersHtml();
  el.innerHTML = html;
  el.hidden    = !html;
}

// Clicking a row in that table. Deliberately narrow: it moves the map and sets
// the same repeater focus a plain click on the repeater's own pin sets, and
// touches nothing else — not state.selectedId, not the editor draft, not the
// filters, not the map selection. The station being looked at stays the station
// being looked at; only the view moves. Clicking the focused row again clears
// the focus, as clicking its pin again would.
function focusRepeaterOnMap(id) {
  const r = state.data && state.data.stations.find(x => x.id === id);
  if (!r) return;
  if (state.mapFocusRepeaterId === id) {
    setMapFocusRepeater(null);
    return;
  }
  setMapFocusRepeater(id);       // re-renders this card, so the row marks itself
  if (!state.map) return;
  if (r.lat == null || r.lon == null) {
    mapNote(`${r.name} has no coordinates recorded, so the map can't go to it.`, 4000);
    return;
  }
  state.map.setView([r.lat, r.lon], Math.max(state.map.getZoom() || 0, 10));
  const marker = state.mapMarkers.find(m => m.mnStationId === r.id);
  // No pin means the map display is hiding it (hide-others mode with a filter
  // running). The view is on it either way, so say why there is nothing there
  // rather than leaving the operator looking at empty ground.
  if (marker) marker.openPopup();
  else mapNote(`${r.name} isn't drawn right now — the map display is hiding it.`, 4000);
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
      <span class="filter-resets">
        <button class="filter-reset" onclick="clearStationFilters(false)"
                title="Put every station back at full opacity, without moving the map"
                ${anyStationFilterActive() ? '' : 'disabled'}>Clear filters</button>
        <button class="filter-reset" onclick="clearStationFilters(true)"
                title="Clear the filters and zoom back out to the whole network"
                ${anyStationFilterActive() ? '' : 'disabled'}>Clear &amp; zoom out</button>
      </span>
    </div>
    <div class="filter-block">
      <div class="filter-head">
        <span class="filter-title">Search</span>
        <button class="filter-clear" id="search-clear" onclick="clearSearch()"
                ${state.filters.search.trim() ? '' : 'hidden'}>clear</button>
      </div>
      <p class="filter-hint">Name, station # or ALERT address — or paste a list of them,
        separated by commas, spaces or new lines.</p>
      <textarea id="station-search" class="filter-search" rows="1" spellcheck="false"
                placeholder="e.g. 6128, 6129 — or paste from a telemetry log"
                oninput="mapSearchInput(this.value);autoGrowSearch(this)">${esc(state.filters.search)}</textarea>
      <p class="filter-note" id="search-terms-note">${searchTermsNoteHtml()}</p>
      <p class="filter-note" id="map-match-note">${mapMatchNoteHtml()}</p>
    </div>
    ${Object.keys(FILTER_GROUPS).map(filterGroupHtml).join('')}
    ${filterAreaHtml()}
    ${filterDataHtml()}`;
}

function renderStationFilters() {
  const el = document.getElementById('station-filters');
  if (el) el.innerHTML = stationFiltersHtml();
  initStationFilters();
}

// The search box is a <textarea>, not an <input>: a single-line input strips
// the line breaks out of a pasted column of addresses, gluing 6128 and 6129
// into 61286129. It opens one line tall and grows to fit what was pasted.
function initStationFilters() {
  const el = document.getElementById('station-search');
  if (el) autoGrowSearch(el);
}

const SEARCH_MAX_PX = 170;   // ~8 lines; past that the box scrolls instead

function autoGrowSearch(el) {
  el.style.height = 'auto';
  // Boxes are border-box here but scrollHeight excludes the border, so the
  // frame has to be added back or every growth step clips by a couple of pixels.
  const frame = el.offsetHeight - el.clientHeight;
  el.style.height = Math.min(el.scrollHeight + frame, SEARCH_MAX_PX) + 'px';
}

function clearSearch() {
  state.filters.search = '';
  const el = document.getElementById('station-search');
  if (el) { el.value = ''; autoGrowSearch(el); el.focus(); }
  stationsFilterChanged();
}

// What a pasted list did: how many terms, and which of them are in no station
// on file. Silent about a single term — the match note below already covers it.
function searchTermsNoteHtml() {
  const terms = parseSearchTerms(state.filters.search);
  if (terms.length < 2) return '';
  const missing = unmatchedSearchTerms(terms);
  if (!missing.length) return `${terms.length} search terms · all found.`;
  const shown = missing.slice(0, 8).map(esc).join(', ');
  const rest  = missing.length - 8;
  return `${terms.length} search terms · <strong>${missing.length}</strong> not in this ` +
         `database: ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
}

// Editing or deleting a station moves the per-option counts (and can retire an
// option outright), so the cached lists are dropped and the panel redrawn.
function refreshFilterOptions() {
  state.filterOpts  = null;
  state.searchIdx   = null;
  state.repeaterIdx = null;
  state.passRelIdx  = null;   // an edited pass range re-wires the relation
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
  const terms = document.getElementById('search-terms-note');
  if (terms) terms.innerHTML = searchTermsNoteHtml();
  const clear = document.getElementById('search-clear');
  if (clear) clear.hidden = !state.filters.search.trim();
  const area = document.getElementById('filter-state-area');
  if (area) area.textContent = valueGroupState(['basin', 'lga']);
  const data = document.getElementById('filter-state-data');
  if (data) data.textContent = valueGroupState(['hasCoords', 'hasAlertId', 'enabledOnly']);
  const idle = !anyStationFilterActive();
  document.querySelectorAll('#station-filters .filter-reset').forEach(b => { b.disabled = idle; });
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

// Reset buttons on the Stations tab: clear everything and redraw the panel with
// it (the boxes, the selects and the summaries all move at once).
//
// Clearing a filter is usually the operator saying "put the rest of the network
// back at full opacity" while they carry on looking at the region they had
// zoomed into — springing the map back to the national view throws away the
// thing they were doing. So the default holds the view, and the second button
// is there for when they do want to zoom back out.
function clearStationFilters(zoomOut) {
  resetStationFilters();
  renderStationFilters();
  state.stationsShowAll = false;
  refreshMapLayers({ skipFit: !zoomOut });
  rerenderStations();
  updateFilterChrome();
}

function toggleFilter(key, value, checked) {
  // The ACMA block's mechanism list is a plain Set with no "empty means all"
  // convention — the station groups go through toggleGroupFilter instead.
  const set = key === 'acmaMechanisms' ? state.filters.acma.mechanisms : state.filters[key];
  if (checked) set.add(value);
  else         set.delete(value);
}

// ── ACMA RRL interference layer ─────────────────────────────────────────────────
// Renders licensed transmitters from the ACMA Register of Radiocommunications
// Licences that could plausibly interfere with MegaNet repeater RX channels.
// All data is precomputed offline by tools/acma_fetch.py into data/acma-*.json;
// nothing here fetches until the master toggle is switched on (or the RF
// Environment tab is opened), so page load is unaffected while the layer is off.
// Contains ACMA RRL data, CC BY 4.0.

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

// ── lazy loading ──

function acmaFetchJson(name) {
  return fetch(`data/${name}`).then(r => {
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.text();
  }).then(text => {
    state.memBytes.files[name] = text.length;   // for MemMeter — free, the text is already here
    return JSON.parse(text);
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

