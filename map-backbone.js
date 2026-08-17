// MegaNet — map-backbone.js
//
//   Backbone paths: which pairs of repeaters can plausibly relay to each
//   other, which repeaters can reach a base station, the prominent black paths
//   that draws on the maps, the click-a-radio-path info card, and the suggested
//   per-repeater delay that keeps neighbouring repeaters from re-transmitting
//   on top of each other.
//
//   backboneIndex()            every repeater pair whose open pass-range
//                              windows share at least one ALERT address, plus
//                              every repeater–base pair, with the distance
//                              between them — cached on state.backboneIdx
//                              until the file changes.
//   backboneLinks(maxKm)       the pairs within a distance — the drawable list.
//   suggestedRepeaterDelays()  repeater id → suggested delay in ms (< 1000).
//   suggestedRepeaterDelayMs(station)
//   repeaterDelayLabel(station)
//   MapBackbone                the radio-path info card, the path click
//                              handler for the Stations map, the popup body
//                              for the Network View mini-map, and the
//                              cross-tab "open this path on the Stations map".
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, acmaHaversineKm;
// across to app.js for repeaterList, passRelationIndex, passRangeCoversId,
// stationAlertIdTypes, focusStation, zoomToStation and switchTab; and
// sideways to map-draw.js (MapDraw), link-budget.js (LinkBudget,
// lbMarginClass) and path-profile.js (PathProfile, rmSystemOf, fsplDb,
// wattsToDbm, PATH_DEFAULT_MHZ). See path-profile.js's header for why the
// mutual reference constrains nothing.

// ── The backbone relation ────────────────────────────────────────────────────
// Two repeaters are on a backbone path when they are close enough to hear each
// other (the Max TX distance slider) AND at least one ALERT address is open in
// both of their pass-range windows — a message that one re-transmits, the
// other would accept and pass on. That is a statement about the *windows*, not
// about which stations happen to use an address today, so the test is interval
// arithmetic rather than a walk over the sensor list.
//
// A repeater–base path is the other half of the backbone: where the traffic a
// repeater relays is finally going. A base is not a repeater — it opens no
// pass-range window of its own to intersect (the two in this network that do
// are also repeaters, and pair by the rule above on that role) — so the only
// condition on a repeater–base path is the distance one, the same Max TX
// distance that matches the repeater pairs.

// A repeater's open windows as a flat list of [lo, hi] integer intervals:
// pass_ranges minus exclusions. An inverted range (high < low) matches no
// address in passRangeCoversId, so it is dropped here as the empty interval it
// is — never swapped (see 0002_stations.sql on Laheys Lookout).
function repeaterOpenWindows(rep) {
  if (!rep || !Array.isArray(rep.pass_ranges)) return [];
  let spans = rep.pass_ranges.filter(r => r.high >= r.low).map(r => [r.low, r.high]);
  for (const e of (rep.exclusions || [])) {
    if (e.high < e.low) continue;
    const next = [];
    for (const [lo, hi] of spans) {
      if (e.high < lo || e.low > hi) { next.push([lo, hi]); continue; }
      if (lo < e.low)  next.push([lo, e.low - 1]);
      if (hi > e.high) next.push([e.high + 1, hi]);
    }
    spans = next;
  }
  return spans;
}

// How many ALERT addresses two open-window lists have in common. Any overlap
// at all is what makes a backbone pair; the count is what the path card shows.
function windowOverlapCount(a, b) {
  let n = 0;
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      const lo = Math.max(alo, blo), hi = Math.min(ahi, bhi);
      if (hi >= lo) n += hi - lo + 1;
    }
  }
  return n;
}

// Every located repeater pair whose windows overlap, plus every located
// repeater–base pair, resolved once per loaded file — 88 repeaters is ~3,800
// pairs, cheap once, not per render. Cached on state.backboneIdx and
// invalidated exactly where state.passRelIdx is: applyStationDoc and
// refreshFilterOptions.
//
//   pairs: [{ kind, a, b, km, overlap, shared }]
//          kind = 'repeater' for a repeater–repeater path, 'base' for a
//          repeater–base one (a is always the repeater on a 'base' pair);
//          overlap = addresses open in both windows — always > 0 on a
//          'repeater' pair, and 0 on a 'base' pair whose base end holds no
//          pass ranges; shared = the network's real ALERT addresses covered by
//          both (may be empty — an overlap can sit on addresses nothing
//          transmits on yet).
//   cover: station id → Set of network ALERT addresses its windows carry.
//   delays: the suggested-delay cache, filled lazily by suggestedRepeaterDelays.
function backboneIndex() {
  if (state.backboneIdx) return state.backboneIdx;
  // Nothing loaded yet: answer empty without caching, so the index is still
  // built from the real file later — passRelationIndex's own convention.
  if (!state.data) return { pairs: [], cover: new Map(), delays: null };
  const reps = repeaterList(state.data.stations);
  const bases = state.data.stations.filter(s => s.roles.includes('base'));
  const addresses = passRelationIndex().addresses;
  const windows = new Map();
  const cover = new Map();
  // Bases are indexed alongside the repeaters because a base that is also a
  // repeater has real windows worth quoting on its paths; a pure base resolves
  // to an empty window list and an empty cover set, which is the honest answer.
  for (const r of reps.concat(bases.filter(b => !reps.includes(b)))) {
    windows.set(r.id, repeaterOpenWindows(r.repeater));
    const set = new Set();
    for (const id of addresses) if (passRangeCoversId(r.repeater, id)) set.add(id);
    cover.set(r.id, set);
  }
  const sharedAddrs = (aId, bId) => {
    const ca = cover.get(aId), cb = cover.get(bId);
    const [small, large] = ca.size <= cb.size ? [ca, cb] : [cb, ca];
    return [...small].filter(id => large.has(id)).sort((x, y) => x - y);
  };
  const pairKey = (x, y) => (x < y ? x + '|' + y : y + '|' + x);
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < reps.length; i++) {
    const a = reps[i];
    if (a.lat == null || a.lon == null) continue;
    const wa = windows.get(a.id);
    if (!wa.length) continue;
    for (let j = i + 1; j < reps.length; j++) {
      const b = reps[j];
      if (b.lat == null || b.lon == null) continue;
      const overlap = windowOverlapCount(wa, windows.get(b.id));
      if (!overlap) continue;
      seen.add(pairKey(a.id, b.id));
      pairs.push({ kind: 'repeater', a, b, km: acmaHaversineKm(a.lat, a.lon, b.lat, b.lon),
                   overlap, shared: sharedAddrs(a.id, b.id) });
    }
  }
  // Repeater → base. A station that is both keeps its repeater pairs and takes
  // base pairs only for the repeaters it did not already share a window with,
  // so no hop is drawn — or counted — twice.
  for (const b of bases) {
    if (b.lat == null || b.lon == null) continue;
    for (const a of reps) {
      if (a.id === b.id || a.lat == null || a.lon == null) continue;
      const key = pairKey(a.id, b.id);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ kind: 'base', a, b, km: acmaHaversineKm(a.lat, a.lon, b.lat, b.lon),
                   overlap: windowOverlapCount(windows.get(a.id), windows.get(b.id)),
                   shared: sharedAddrs(a.id, b.id) });
    }
  }
  state.backboneIdx = { pairs, cover, delays: null };
  return state.backboneIdx;
}

// The drawable backbone list: pairs within `maxKm` — repeater–repeater and
// repeater–base alike, on the one distance. The distance is a *match*
// condition here — spec'd off the Max TX distance slider — unlike the field
// links, where the same slider only culls the drawing.
function backboneLinks(maxKm) {
  return backboneIndex().pairs.filter(p => p.km <= (maxKm > 0 ? maxKm : 0));
}

// The pair record for two repeater ids, either way round — the path card wants
// the shared-address figures the index already resolved.
function backbonePairFor(aId, bId) {
  return backboneIndex().pairs.find(p =>
    (p.a.id === aId && p.b.id === bId) || (p.a.id === bId && p.b.id === aId)) || null;
}

// ── Suggested repeater delay ─────────────────────────────────────────────────
// Two repeaters with the same delay that both accept the same message will
// re-transmit it at the same moment and collide at every receiver that can
// hear both. The suggestion staggers them: the backbone pairs within the Max
// TX distance form a conflict graph, greedy colouring (busiest repeater
// first — the classic Welsh–Powell order, and deterministic, so the same file
// always yields the same suggestions) assigns each repeater the lowest slot no
// conflicting neighbour holds, and slots become milliseconds. 150 ms apart
// while the budget allows, compressed to fit under 1000 ms when a dense
// network needs more slots than 150 ms spacing can hold.

const REPEATER_DELAY_STEP_MS = 150;
const REPEATER_DELAY_MAX_MS  = 999;

function suggestedRepeaterDelays() {
  const idx = backboneIndex();
  const maxKm = state.mapMaxLinkKm;
  if (idx.delays && idx.delays.maxKm === maxKm) return idx.delays.map;
  const adj = new Map();
  // Repeater pairs only: a base does not re-transmit, so a repeater–base path
  // is not a collision to stagger and its base end is not a node that can hold
  // a slot two repeaters then have to avoid.
  for (const p of backboneLinks(maxKm)) {
    if (p.kind !== 'repeater') continue;
    if (!adj.has(p.a.id)) adj.set(p.a.id, []);
    if (!adj.has(p.b.id)) adj.set(p.b.id, []);
    adj.get(p.a.id).push(p.b.id);
    adj.get(p.b.id).push(p.a.id);
  }
  const ids = [...adj.keys()].sort((x, y) =>
    (adj.get(y).length - adj.get(x).length) || (x < y ? -1 : x > y ? 1 : 0));
  const slot = new Map();
  for (const id of ids) {
    const used = new Set(adj.get(id).map(n => slot.get(n)).filter(v => v != null));
    let c = 0;
    while (used.has(c)) c++;
    slot.set(id, c);
  }
  let slots = 0;
  for (const c of slot.values()) if (c > slots) slots = c;
  const step = slots === 0 ? 0
    : Math.min(REPEATER_DELAY_STEP_MS, Math.floor(REPEATER_DELAY_MAX_MS / slots));
  const map = new Map();
  if (state.data) {
    for (const r of repeaterList(state.data.stations)) map.set(r.id, (slot.get(r.id) || 0) * step);
  }
  idx.delays = { maxKm, map };
  return map;
}

// The suggestion for one repeater, or null for a station that isn't one.
function suggestedRepeaterDelayMs(station) {
  if (!station || !station.roles.includes('repeater') || !station.repeater) return null;
  return suggestedRepeaterDelays().get(station.id) ?? null;
}

// "300 ms" / "not set — suggested 150 ms" — the recorded value always wins,
// and a computed suggestion is labelled as the guess it is (the TBRG bucket
// convention: blank means not recorded, never zero).
function repeaterDelayLabel(station) {
  const rec = station && station.repeater ? station.repeater.delay_ms : null;
  if (rec != null) return `${rec} ms`;
  const sug = suggestedRepeaterDelayMs(station);
  return sug == null ? 'not set' : `not set — suggested ${sug} ms`;
}

// ── The radio-path card and path clicks ──────────────────────────────────────
// Clicking any radio path on the Stations map — a field-station signal link or
// a backbone path — opens three things for that exact hop: this card over the
// map (who, what addresses, how far, what margin), the elevation profile
// panel, and the link budget panel, both already pointed at the clicked path.
// The card follows the #acma-card conventions: role=dialog, focus moves in,
// Escape closes back to the map.

const MapBackbone = (function () {
  let opener = null;   // element focus goes back to when the card closes
  let cur = null;      // { kind: 'field' | 'backbone', aId, bId } while open

  function stationById(id) {
    return state.data ? state.data.stations.find(s => s.id === id) : null;
  }

  function cardEl() { return document.getElementById('path-card'); }

  // The budget the link-budget card is showing, when it is showing this exact
  // pair — so the card and the panel under it quote the same figure, terrain
  // term included once the profile lands. Anything else falls back to a plain
  // free-space margin computed from the same primitives.
  function budgetFor(a, b) {
    const L = state.link;
    const match = L.a && L.b &&
      ((L.a.sid === a.id && L.b.sid === b.id) || (L.a.sid === b.id && L.b.sid === a.id));
    return match ? LinkBudget.current() : null;
  }

  // Free-space fade margin a → b from the stations' Radio Mobile systems: the
  // same formula LinkBudget's own compute() applies, minus the terrain term it
  // cannot have without a profile. Indicative and optimistic, and said so.
  function freeSpaceMargin(a, b) {
    const sysA = rmSystemOf(a), sysB = rmSystemOf(b);
    const dKm = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
    const fMhz = (a.repeater && a.repeater.rx_mhz > 0) ? a.repeater.rx_mhz
               : (b.repeater && b.repeater.rx_mhz > 0) ? b.repeater.rx_mhz
               : PATH_DEFAULT_MHZ;
    const txDbm = sysA ? wattsToDbm(sysA.tx_power_w) : null;
    const eirp = txDbm == null ? null : txDbm + (sysA.antenna_gain_dbi || 0) - (sysA.line_loss_db || 0);
    const rxDbm = eirp == null ? null
      : eirp - fsplDb(dKm, fMhz) + (sysB ? sysB.antenna_gain_dbi || 0 : 0)
        - (sysB ? sysB.line_loss_db || 0 : 0);
    const thr = sysB ? sysB.rx_threshold_dbm : null;
    const margin = rxDbm == null || thr == null ? null : rxDbm - thr;
    return { dKm, fMhz, margin, an: null, fsplOnly: true };
  }

  function row(label, value) {
    return `<div class="acma-row"><span>${label}</span><span>${value}</span></div>`;
  }

  function marginHtml(r) {
    if (!r || r.margin == null) {
      return '<span class="small">no figure — TX power or RX threshold not set</span>';
    }
    // An obstructed path never gets to read "good", however fat the number —
    // the budget card's own rule, reproduced rather than re-banded.
    const blocked = !!(r.an && r.an.verdict === 'obstructed');
    const m = lbMarginClass(r.margin);
    const cls = blocked ? 'bad' : m.cls;
    return `<strong style="color:var(--${cls})">${(r.margin > 0 ? '+' : '') + r.margin.toFixed(1)} dB</strong>
      <span class="small"> — ${blocked ? 'obstructed' : m.label.toLowerCase()}${
        r.fsplOnly ? ' · free-space only' : ''}</span>`;
  }

  function stationLink(s) {
    return `<a href="#" onclick="zoomToStation('${escAttr(s.id)}');return false"
      title="Zoom the map to this station">${esc(s.name)}</a>`;
  }

  function fieldRows(a, b) {
    const ids = stationAlertIdTypes(a).filter(t => passRangeCoversId(b.repeater, t.id));
    const idText = ids.length
      ? ids.map(t => `${t.types.length ? esc(t.types.join(' / ')) + ' — ' : ''}${t.id}`).join('<br>')
      : 'none — this link is drawn from the pass-range relation';
    return row('Field station', stationLink(a)) +
           row('Repeater', stationLink(b)) +
           row(`ALERT ID${ids.length === 1 ? '' : 's'} on this path`, idText);
  }

  // Is this hop a repeater reaching a base rather than another repeater? The
  // pair record says so outright — and on a 'base' pair the base is always the
  // b end, which is what lets the rows below name the two ends by the role each
  // is playing here rather than by every role it holds. An unindexed pair
  // (nothing loaded, or a card left open across a file swap) falls back to the
  // roles themselves.
  function isBaseHop(a, b) {
    const p = backbonePairFor(a.id, b.id);
    return p ? p.kind === 'base' : !b.roles.includes('repeater');
  }

  // A backbone hop is repeater ⇄ repeater or repeater ⇄ base. The base end of
  // the second kind opens no pass-range window and re-transmits nothing, so the
  // shared-address figure says what matched instead, and neither the delay row
  // nor the same-delay warning — both of them about re-transmission — is asked
  // of it.
  function backboneRows(a, b) {
    const p = backbonePairFor(a.id, b.id);
    const toBase = isBaseHop(a, b);
    const sharedText = !p ? '—'
      : p.overlap
        ? `${p.shared.length} in use in the network` +
          (p.shared.length ? `<br><span class="small">${p.shared.slice(0, 12).join(', ')}${
             p.shared.length > 12 ? '…' : ''}</span>` : '') +
          `<br><span class="small">windows overlap on ${p.overlap} address${p.overlap === 1 ? '' : 'es'}</span>`
        : `<span class="small">no pass-range window at the base end — this path is matched on
             distance alone</span>`;
    const da = a.repeater ? a.repeater.delay_ms : null;
    const db = b.repeater ? b.repeater.delay_ms : null;
    const clash = !toBase && da != null && da === db
      ? `<div class="small" style="color:var(--bad);margin-top:.35rem">⚠️ Both repeaters hold the same
           delay — a message both accept is re-transmitted at the same moment and collides at every
           receiver that hears both.</div>` : '';
    const delays = (toBase ? [a] : [a, b]).filter(st => st.repeater)
      .map(st => row('Delay — ' + esc(st.name), esc(repeaterDelayLabel(st)))).join('');
    return row('Repeater', stationLink(a)) +
           row(toBase ? 'Base station' : 'Repeater', stationLink(b)) +
           row('Shared ALERT IDs', sharedText) +
           delays +
           clash;
  }

  function backboneTitle(a, b) {
    return isBaseHop(a, b) ? 'Repeater to base path' : 'Repeater backbone path';
  }

  function cardHtml(kind, a, b) {
    const backbone = kind === 'backbone';
    const r = budgetFor(a, b) || freeSpaceMargin(a, b);
    const km = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
    return `
      <div class="acma-card-head">
        <span>
          <strong id="path-card-title">${backbone ? backboneTitle(a, b) : 'Radio path'}</strong><br>
          <span class="small txt-muted">${esc(a.name)} ⇄ ${esc(b.name)}</span>
        </span>
        <span><button type="button" onclick="MapBackbone.closeCard()"
          aria-label="Close the radio path details"><span aria-hidden="true">×</span></button></span>
      </div>
      <div class="acma-sect">
        ${backbone ? backboneRows(a, b) : fieldRows(a, b)}
        ${row('Distance', fmtKm(km))}
        ${row('Fade margin', marginHtml(r))}
      </div>
      <p class="small acma-card-note">Indicative only — the margin is the link budget card's figure
        (free-space until the terrain profile lands). The elevation profile and link budget panels
        under the map are open on this exact path:
        <a href="#" onclick="MapBackbone.scrollTo('path-profile-panel');return false">elevation profile ↓</a> ·
        <a href="#" onclick="MapBackbone.scrollTo('link-budget-panel');return false">fade margin ↓</a></p>`;
  }

  // Paint only — open() moves focus in once; a repaint (terrain landing) must
  // not keep stealing it back.
  function render() {
    const el = cardEl();
    if (!el || !cur) return;
    const a = stationById(cur.aId), b = stationById(cur.bId);
    if (!a || !b) { close(); return; }
    el.hidden = false;
    el.innerHTML = cardHtml(cur.kind, a, b);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-labelledby', 'path-card-title');
    el.tabIndex = -1;
    el.onkeydown = key;
  }

  function key(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  function close() {
    cur = null;
    const el = cardEl();
    if (el) { el.hidden = true; el.innerHTML = ''; }
    const back = opener;
    opener = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
  }

  function open(kind, aId, bId) {
    const a = stationById(aId), b = stationById(bId);
    if (!a || !b || a.lat == null || a.lon == null || b.lat == null || b.lon == null) return;
    opener = document.activeElement;
    cur = { kind, aId, bId };
    // The elevation profile follows the drawn line, so the clicked path becomes
    // one. The panel opens BEFORE the line goes in and an existing line is
    // reused rather than stacked — both LinkBudget.profileThis lessons, see the
    // comments there. fromProfile() then points the budget at the same line.
    state.path.open = true;
    const pa = [a.lat, a.lon], pb = [b.lat, b.lon];
    const existing = MapDraw.findLine(pa, pb);
    if (existing) MapDraw.focus(existing.id);
    else MapDraw.addLine([pa, pb], [aId, bId]);
    LinkBudget.fromProfile();
    render();
    const el = cardEl();
    if (el) el.focus();
  }

  return {
    open,
    closeCard: close,

    // Click handler for the Stations map's radio-path polylines (field links
    // and backbone paths both). While a draw tool is armed the click falls
    // through to the map, exactly as MapDraw's own shape handler yields.
    onLineClick(e) {
      if (state.draw.tool) return;
      L.DomEvent.stopPropagation(e);
      const l = e.target;
      if (l.mnLinkRepeaterId2) open('backbone', l.mnLinkRepeaterId, l.mnLinkRepeaterId2);
      else open('field', l.mnLinkStationId, l.mnLinkRepeaterId);
    },

    // The Network View mini-map has no profile or budget panel to open, so its
    // paths get a popup with the same figures and a hand-off to the Stations
    // tab, where the full three-card treatment runs.
    popupHtml(kind, aId, bId) {
      const a = stationById(aId), b = stationById(bId);
      if (!a || !b) return '';
      const backbone = kind === 'backbone';
      const p = backbone ? backbonePairFor(aId, bId) : null;
      const r = freeSpaceMargin(a, b);
      const km = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
      const m = r.margin != null ? lbMarginClass(r.margin) : null;
      return `
        <strong>${backbone ? backboneTitle(a, b) : 'Radio path'}</strong><br>
        <span style="font-size:.83rem">${esc(a.name)} ⇄ ${esc(b.name)}</span><br>
        ${backbone && p ? `<span style="font-size:.83rem">${p.overlap
          ? `${p.shared.length} shared ALERT ID${p.shared.length === 1 ? '' : 's'} in use · windows overlap on ${p.overlap}`
          : 'no pass-range window at the base end — matched on distance alone'}</span><br>` : ''}
        <span style="font-size:.83rem">${fmtKm(km)} · ${r.margin == null ? 'no margin figure'
          : `${(r.margin > 0 ? '+' : '') + r.margin.toFixed(1)} dB ${m.label.toLowerCase()} (free-space)`}</span>
        <div class="mn-popup-actions">
          <a href="#" onclick="MapBackbone.openOnStations('${backbone ? 'backbone' : 'field'}','${escAttr(aId)}','${escAttr(bId)}');return false"
             title="Open this path on the Stations map with the elevation profile and fade margin cards">
            Open on the Stations map ↗</a>
        </div>`;
    },

    // Cross-tab hand-off: the Stations tab renders synchronously on
    // switchTab, and the card opens on the next tick so it lands on the
    // freshly built map and panels.
    openOnStations(kind, aId, bId) {
      switchTab('stations');
      setTimeout(() => open(kind, aId, bId), 0);
    },

    // The terrain profile landed (or failed) — the card's margin follows it,
    // without re-stealing focus. Called from PathProfile.sync alongside
    // LinkBudget.profileChanged.
    profileChanged() { if (cur) render(); },

    scrollTo(id) {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  };
})();
