// MegaNet — workbench.js
//
//   Workbench   the Interference Workbench tab: pick the stations you believe
//               are affected and it assembles the evidence, scores five
//               competing explanations against each other and names what to
//               check next. It argues a case rather than showing numbers.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// The widest reach of any module in the epic, which is what a tab that exists
// to correlate five other tabs costs:
//
//   core.js       ACMA_MECH, acmaHaversineKm, buildSensorIndex, csvEscape,
//                 dlText, esc, escAttr, registerLiveMap (#142 — the case map
//                 says so itself now), slug, state
//   app.js        acmaEnsureCore, acmaEnsureDevices, acmaFetchJson,
//                 addBaseLayers, passRangeCoversId, renderMain, renderTabs,
//                 rfStripPlotHtml, stationAlertIds, switchTab — and
//                 showAcmaCard, which it reaches *only* from two inline
//                 onclick strings, so no AST walk over this file will find it
//   rf-changes.js RfChanges, for its data loader, its repeater names and its
//                 blind-spots copy
//   Leaflet       the case map, via addBaseLayers
//
// Two of those are worth flagging for whoever picks up #138: rfStripPlotHtml
// and the acma* loaders are the RF Environment / ACMA RRL layer, still in
// app.js. And Bit Flipper is reached without naming anything in bit-flipper.js
// — openBf sets three fields on state and calls switchTab, which is the loosest
// coupling of the lot and worth keeping that way.
//
// The IIFE body declares and calls nothing at load — 72 statements, 62 function
// declarations and 9 constants and the return — so this file's position among
// the modules is free, including relative to rf-changes.js.
//
// 21 of the 71 names inside are public. Three are called from code (render and
// init from renderMain, restoreFromUrl from init.js); the other eighteen exist
// only to be named by an inline on*= attribute, and the note in rf-changes.js
// about what that costs applies here eighteen times over. What is *not* public
// is the more useful list: wbAnalyse, the 257-line scoring core, the five
// wbArithH* explainers behind it and every wb*Html builder are private. Nothing
// outside this file scores a case or draws a panel.
//
// Not indented into the IIFE — see the note in rf-changes.js.
//
// Wrapped in an IIFE and moved out of app.js by M4 (#135) of #129 — the last
// child of that epic, and the only one that was a refactor rather than a move.

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

const Workbench = (function () {

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
  const click = conceptId ? ` onclick="Workbench.openConcept('${escAttr(conceptId)}')"` : '';
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
      <button onclick="Workbench.closeDrawer()" style="float:right">×</button>
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
        ${cur ? `<button onclick="Workbench.openConcept('')" title="All concepts">≡</button>` : ''}
        <button onclick="Workbench.closeDrawer()" title="Close">×</button>
      </span>
    </div>`;
  if (!cur) {
    el.innerHTML = `${head}
      <div class="wb-drawer-body">
        <p class="small" style="color:var(--muted)">Short, field-oriented explainers. Every entry
        says what the phenomenon looks like <em>in your data</em>, not just what it is.</p>
        ${list.map(c => `<a href="#" class="wb-drawer-item"
            onclick="Workbench.openConcept('${escAttr(c.id)}');return false">${esc(c.title)}</a>`).join('')}
      </div>`;
    return;
  }
  const also = (cur.see_also || []).map(id => {
    const t = list.find(c => c.id === id);
    return t ? `<a href="#" onclick="Workbench.openConcept('${escAttr(id)}');return false">${esc(t.title)}</a>` : '';
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
    if (!R.loaded && !R.loadPromise && !R.error) RfChanges.ensureData().then(rerender).catch(rerender);
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
        ${(wbs.affected.length || wbs.good.length) ? '<button onclick="Workbench.clearCase()">Clear</button>' : ''}
      </div>
      <label class="small" style="display:block;margin-top:.5rem">Paste ALERT IDs
        <textarea id="wb-paste" rows="2" style="margin-top:.3rem"
          placeholder="6129, 6130 2316&#10;2320 — space, comma or newline separated"></textarea>
      </label>
      <div class="button-row" style="justify-content:flex-start;margin:.4rem 0">
        <button class="primary" onclick="Workbench.addFromPaste('affected')">Add as affected</button>
        <button onclick="Workbench.addFromPaste('good')">Add as known-good</button>
      </div>
      <label class="small" style="display:block;margin-top:.4rem">Or search stations
        <input type="search" id="wb-pick" placeholder="Station name or number…"
               value="${esc(wbs.pickQuery)}" style="margin-top:.3rem"
               oninput="state.wb.pickQuery=this.value;Workbench.refreshPick()">
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
        <button onclick="Workbench.saveCase()">Save</button>
        <button onclick="Workbench.shareLink(this)" ${wbs.affected.length ? '' : 'disabled'}>Copy share link</button>
      </div>
      ${caseNames.length ? `
        <div style="display:flex;gap:.4rem;align-items:center;margin-top:.6rem">
          <select id="wb-case-sel" onchange="Workbench.loadCase(this.value)">
            <option value="">Load saved case…</option>
            ${caseNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
          </select>
          <button onclick="Workbench.deleteCase()" title="Delete the case selected above">🗑</button>
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
            <a href="#" title="${swapTitle}" onclick="Workbench.swapId('${list}',${id});return false">⇄</a>
            <a href="#" title="Remove" onclick="Workbench.removeId('${list}',${id});return false">×</a>
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
            <button onclick="Workbench.addStation('${escAttr(s.id)}','affected')" title="Add as affected">+ aff</button>
            <button onclick="Workbench.addStation('${escAttr(s.id)}','good')" title="Add as known-good">+ good</button>
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
        <button class="primary" onclick="Workbench.loadExample()">Load a worked example</button>
        <button onclick="Workbench.openConcept('')">Open the RF concept notes</button>
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
      <button style="margin-left:.5rem" onclick="Workbench.openBf(${p.a})">Open ${p.a} in Bit Flipper</button>
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
                <td><button onclick="Workbench.openBf(${p.a})">Bit Flipper →</button></td>
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
            <td class="small">${esc(RfChanges.anchorName(r.a.id))}</td>
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
      <button onclick="Workbench.openRfc()">Open in RF Changes →</button></div>`;
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
      ${RfChanges.helpHtml()}
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
        <button onclick="Workbench.exportCsv()">Export case (CSV)</button>
        <button onclick="Workbench.exportChecklist()">Site-visit checklist</button>
        <button onclick="Workbench.exportComplaint()">Draft ACMA complaint</button>
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
  // Registered here rather than in app.js's list, which is where this map was
  // named until #142 — the fifth entry, added by M4 because someone remembered.
  registerLiveMap('Workbench', () => state.wb.map);
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

// ── public surface ─────────────────────────────────────────────────────────────
// Twenty-one of the seventy-one names above; the other fifty are private. Read
// the note on RfChanges' surface first — the same rule about on*= attributes
// binds here, and eighteen of these twenty-one exist only to be named by one.
//
// What is *not* here is the more useful list: wbAnalyse, the 257-line scoring
// core, and the five wbArithH* explainers behind it are private, and so is
// every wb*Html builder. Nothing outside this file scores a case or draws a
// panel; it asks for the tab's HTML and gets it.
return {
  render:          renderWorkbenchHtml,  // renderMain()
  init:            initWb,               // renderMain()
  restoreFromUrl:  wbRestoreFromUrl,     // init.js, after the first render
  // ── inline on*= handlers ──
  addFromPaste:    wbAddFromPaste,       // setup rail, paste box
  addStation:      wbAddStation,         // setup rail, station search results
  removeId:        wbRemoveId,           // station chip
  swapId:          wbSwapId,             // station chip (affected ⇄ known-good)
  clearCase:       wbClearCase,          // setup rail
  loadExample:     wbLoadExample,        // intro panel
  openBf:          wbOpenBf,             // H5 banner and panel → Bit Flipper
  saveCase:        wbSaveCase,           // case bar
  loadCase:        wbLoadCase,           // case bar
  deleteCase:      wbDeleteCase,         // case bar
  shareLink:       wbShareLink,          // case bar
  openConcept:     wbOpenConcept,        // concept links, throughout
  closeDrawer:     wbCloseDrawer,        // concept drawer
  refreshPick:     wbRefreshPick,        // setup rail, station search box
  openRfc:         wbOpenRfc,            // timeline → RF Changes
  exportCsv:       wbExportCsv,          // actions panel
  exportChecklist: wbExportChecklist,    // actions panel
  exportComplaint: wbExportComplaint,    // actions panel
};

})();

