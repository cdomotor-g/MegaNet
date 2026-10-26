// MegaNet — map-backbone.js
//
//   Backbone paths: which pairs of repeaters can plausibly relay to each
//   other, which repeaters can reach a base station, the prominent black paths
//   that draws on the maps, what a clicked radio path puts on the elevation
//   profile card, and the suggested per-repeater delay that keeps neighbouring
//   repeaters from re-transmitting on top of each other.
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
//   MapBackbone                the radio path on the profile card, the path
//                              click handler for the Stations map, the popup body
//                              for the Network View mini-map, and the
//                              cross-tab "open this path on the Stations map".
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, pillText, fmtKm, acmaHaversineKm;
// across to app.js for repeaterList, passRelationIndex, passRangeCoversId,
// stationAlertIdTypes, focusStation, zoomToStation, switchTab and
// dockReveal; and
// sideways to map-draw.js (MapDraw), link-budget.js (LinkBudget,
// lbMarginClass) and path-profile.js (PathProfile, fsplDb, wattsToDbm, and
// radioKey, radioDefaults, radioVal and radioFreq — the figures the path tools
// share — and pathMoreHtml). See path-profile.js's header for why the
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

// ── The radio path, on the profile card, and path clicks ─────────────────────
// Clicking any radio path on the Stations map — a field-station signal link or
// a backbone path — points the elevation profile and the link budget at that
// exact hop, and the profile card becomes the radio path's card: its title
// says which kind of path it is, and the rows at its head say who is at each
// end, what addresses it carries and the channel it is on, over the profile's
// own verdict, fade margin and chart.
//
// It was a card of its own, heading the profile. Before that it was a card
// over the map, in the rectangle the ACMA card uses, which put the summary of
// a path on top of the map it was clicked on and a pane away from the profile
// it summarised; as a card of its own it sat on top of the profile but said
// the distance and the fade margin the profile said again under it, in a
// second box with a second heading. So the rows went into the profile card,
// and the figures are said once. The card goes wherever the path tools go —
// the side panel's 〽️ pane beside the map, or the column under it
// (syncStationsCardsHome). Opening a path brings that pane on screen, scrolls
// the card into view and moves focus to it; Escape hands focus back to
// whatever opened it.

const MapBackbone = (function () {
  let opener = null;   // element focus goes back to on Escape
  let cur = null;      // { kind: 'field' | 'backbone', aId, bId } while open

  function stationById(id) {
    return state.data ? state.data.stations.find(s => s.id === id) : null;
  }

  function cardEl() { return document.getElementById('path-profile-panel'); }

  // The budget the link-budget card is showing, when it is showing this exact
  // pair, terrain term included once the profile lands — priced from its own
  // A, which may be either end. Quoted only until the profile has a figure of
  // its own: the profile's readout says the margin once it has one.
  function budgetFor(a, b) {
    const L = state.link;
    const fwd = L.a && L.b && L.a.sid === a.id && L.b.sid === b.id;
    const match = fwd || (L.a && L.b && L.a.sid === b.id && L.b.sid === a.id);
    const r = match ? LinkBudget.current() : null;
    return r ? { ...r, from: fwd ? a : b, to: fwd ? b : a } : null;
  }

  // Free-space fade margin a → b on the figures the path tools price with —
  // the stations' Radio Mobile systems, with whatever has been typed over them
  // in the link budget or the elevation profile (radioVal, path-profile.js),
  // so a TX power changed there moves this figure too. The same formula
  // LinkBudget's own compute() applies, minus the terrain term it cannot have
  // without a profile: indicative and optimistic, and said so. A figure not on
  // file is not nought (the budget's rule) — no margin, rather than one
  // computed round a hole.
  function freeSpaceMargin(a, b) {
    const kA = radioKey(a), kB = radioKey(b);
    const dA = radioDefaults(a), dB = radioDefaults(b);
    const dKm = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
    const fMhz = radioFreq(a, b);
    const txDbm = wattsToDbm(radioVal(kA, dA, 'tx_w'));
    const gA = radioVal(kA, dA, 'gain_dbi'), lA = radioVal(kA, dA, 'loss_db');
    const gB = radioVal(kB, dB, 'gain_dbi'), lB = radioVal(kB, dB, 'loss_db');
    const thr = radioVal(kB, dB, 'rx_dbm');
    const eirp = txDbm == null || gA == null || lA == null ? null : txDbm + gA - lA;
    const rxDbm = eirp == null || gB == null || lB == null ? null : eirp - fsplDb(dKm, fMhz) + gB - lB;
    const margin = rxDbm == null || thr == null ? null : rxDbm - thr;
    return { dKm, fMhz, margin, an: null, fsplOnly: true, from: a, to: b };
  }

  function row(label, value) {
    return `<div class="acma-row"><span>${label}</span><span>${value}</span></div>`;
  }

  function marginHtml(r) {
    if (!r || r.margin == null) {
      return '<span class="small">no figure — a TX power, antenna gain, line loss or RX threshold is not set</span>';
    }
    // Coloured by the number, in the bands the profile and the budget colour it
    // in. "Obstructed" is a yes or no on the geometry — something stands above
    // the line of sight — and the margin is what the model says is left after
    // paying for it, so it is said beside the figure rather than painted over
    // it. It was painted over it, and a path the profile called +39.6 dB good
    // read red here. The one override is the budget card's own: an obstructed
    // path with no model run over it is priced by a single knife edge, the most
    // optimistic estimate there is, and never reads "good".
    const verdict = r.an ? r.an.verdict : null;
    const guessed = verdict === 'obstructed' && !r.itm;
    const m = lbMarginClass(r.margin);
    const cls = guessed ? 'bad' : m.cls;
    const note = r.fsplOnly ? ' · free-space only'
      : verdict === 'obstructed' && !guessed ? ' · line of sight obstructed, priced in' : '';
    const db = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    // Which way it was priced, on a line of its own: the way the traffic runs,
    // unless the profile has been flipped to look at the other.
    const way = r.from && r.to
      ? `<br><span class="small path-card-way">${esc(r.from.name)} → ${esc(r.to.name)}</span>` : '';
    return `<strong class="txt-${cls}">${db(r.margin)}</strong>
      <span class="small"> — ${guessed ? 'obstructed' : m.label.toLowerCase()}${note}</span>${way}`;
  }

  // The channel the path is on — MapFreq's pick, the one the link colouring
  // uses. A path with no recorded frequency says so rather than quoting the
  // default the free-space margin falls back to.
  function freqHtml(a, b) {
    const ch = typeof MapFreq !== 'undefined' ? MapFreq.pathChannel(a, b) : null;
    if (!ch) return '<span class="small">not recorded — no RX frequency on file for the repeater</span>';
    return esc(ch.label) + (ch.far ? `<br><span class="small">far end ${esc(ch.far)}</span>` : '');
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

  // A backbone hop is repeater → repeater or repeater → base. The base end of
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
      ? `<div class="small txt-bad mn-pop-warn">⚠️ Both repeaters hold the same
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

  // The radio path's part of the profile card, for PathProfile to lay out
  // (panelHtml, bodyHtml) — or null when no path is open, or the profile is on
  // some other line. The rows keep the map cards' label/value grammar
  // (.acma-row), because they quote the same kind of figure.
  //
  //   title    'Radio path', or which kind of backbone path it is
  //   rows     who is at each end, the addresses it carries, its channel
  //   interim  () → the distance and a fade margin, for the card to show
  //            while it has no readout of its own — the ground still on its
  //            way, or not to be had. The budget's figure, or a plain
  //            free-space one, and said to be which; the readout says both once
  //            it is there. A function, so the budget is not priced again on
  //            every repaint for a figure the readout has replaced.
  //   note     where the working is, and how the margin is reckoned
  function section() {
    if (!cur) return null;
    const a = stationById(cur.aId), b = stationById(cur.bId);
    if (!a || !b || !onProfile(a, b)) return null;
    const backbone = cur.kind === 'backbone';
    return {
      title: backbone ? backboneTitle(a, b) : 'Radio path',
      rows: `
        <div class="path-card-rows">
          ${backbone ? backboneRows(a, b) : fieldRows(a, b)}
          ${row('Frequency', freqHtml(a, b))}
        </div>`,
      interim: () => `
        <div class="path-card-rows">
          ${row('Distance', fmtKm(acmaHaversineKm(a.lat, a.lon, b.lat, b.lon)))}
          ${row('Fade margin', marginHtml(budgetFor(a, b) || freeSpaceMargin(a, b)))}
        </div>`,
      note: `
        <p class="small path-card-note">Indicative only. Every gain and loss behind the fade margin is in the
          <a href="#" onclick="MapBackbone.scrollTo('link-budget-panel');return false">link budget ↓</a>.</p>
        ${pathMoreHtml('path-card-about', 'How the fade margin is worked out', `
          <p class="small path-card-note">One way: from A, the transmitter, to B, the receiver — named beside the
            figure. From the map that is the way the traffic runs — a field station to its repeater, a repeater to
            its base — since nothing in the network transmits back down; ⇄ Flip direction prices it the other way
            round. It is worked out over the ground on this card, on the TX power and the other figures set here
            and in the link budget below — change one in either and this follows. Until the ground has landed it
            is the free-space figure, and says so.</p>`)}`,
    };
  }

  // Whether the profile is still on this path. The rows say whose path the
  // card is on, so once the profile has moved on — another line drawn or
  // selected, this one deleted or dragged off its stations — they would be
  // describing something the card no longer shows, and they go. The same ends
  // either way round (a flipped line is the same path), found the way open()
  // found them.
  function onProfile(a, b) {
    if (typeof PathProfile === 'undefined' || typeof MapDraw === 'undefined') return true;
    const line = MapDraw.findLine([a.lat, a.lon], [b.lat, b.lon]);
    const t = PathProfile.target();
    return !!(line && t && t.id === line.id);
  }

  // A path the profile has left is not coming back by itself: forgotten, so a
  // line drawn between the same two stations later is a drawn line, not the
  // path somebody clicked an hour ago.
  function forgetIfMoved() {
    if (!cur) return;
    const a = stationById(cur.aId), b = stationById(cur.bId);
    if (!a || !b || !onProfile(a, b)) { cur = null; opener = null; }
  }

  // Bring the card on screen, with focus on it. In the side panel that is its
  // pane (〽️), opened if it was shut or showing something else (dockReveal).
  // Under the map there is no pane — the page scrolls — but a full-screen map
  // covers the column, so full screen is left first, for scrollTo's reason
  // below; beside the map the side panel stays on screen in full screen and
  // nothing needs leaving. `nearest` rather than `start`, so that under the map
  // the page scrolls only as far as the card and the map stays as much in view
  // as it can.
  function reveal(el) {
    if (state.mapFullscreen && !el.closest('#help-panel') && typeof toggleMapFullscreen === 'function') {
      toggleMapFullscreen(false);
    }
    dockReveal(el);
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Escape on the card hands focus back to whatever opened the path — the
  // pin, the row, the map — and leaves the card as it is: it is the profile
  // too, and that stays until the line does. Not from a box being typed in,
  // where Escape is the box's own business.
  function key(e) {
    if (e.key !== 'Escape' || !cur) return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    const back = opener;
    if (!back || !document.contains(back) || typeof back.focus !== 'function') return;
    e.stopPropagation();
    back.focus();
  }

  // The path forgotten: the card goes back to being the line's elevation
  // profile. `refocus` is false when it is nobody's gesture — 🧹 clearing the
  // map — so focus stays on the button that was pressed.
  function close(refocus = true) {
    const was = cur;
    cur = null;
    const back = opener;
    opener = null;
    if (was && typeof PathProfile !== 'undefined') PathProfile.rerender();
    if (refocus && back && document.contains(back) && typeof back.focus === 'function') back.focus();
  }

  function open(kind, aId, bId) {
    const a = stationById(aId), b = stationById(bId);
    if (!a || !b || a.lat == null || a.lon == null || b.lat == null || b.lon == null) return;
    // An opener inside the card — a second path opened while focus is still
    // on this one — is no opener at all; the one recorded when it opened
    // still stands, as showStationCard keeps its own.
    const el = cardEl();
    if (!(el && el.contains(document.activeElement))) opener = document.activeElement;
    // No closing of the map's cards (#175's rule): the path is shown in the
    // path tools, so the station card or the transmitter card someone was
    // reading stays open beside it.
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
    // The card again, now that the budget it quotes until the ground lands is
    // on this pair too.
    PathProfile.rerender();
    // After the budget's own scroll to itself (fromProfile), so the card —
    // the answer to the click — is what ends up in view.
    if (el && cur) reveal(el);
  }

  return {
    open,
    closeCard: close,
    section,
    onKey: key,
    // The path open on the card, or null.
    current() { return cur ? { ...cur } : null; },
    // After a full render of the Stations tab: the profile card paints itself
    // back (PathProfile.sync, from initMap) with this path's rows on it, so
    // all that is left here is to let go of a path it is no longer on.
    repaint() { forgetIfMoved(); },

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
    // tab, where the full treatment — the path on the profile card, at the head
    // of the path tools — runs.
    popupHtml(kind, aId, bId) {
      const a = stationById(aId), b = stationById(bId);
      if (!a || !b) return '';
      const backbone = kind === 'backbone';
      const p = backbone ? backbonePairFor(aId, bId) : null;
      const r = freeSpaceMargin(a, b);
      const km = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
      const m = r.margin != null ? lbMarginClass(r.margin) : null;
      const ch = typeof MapFreq !== 'undefined' ? MapFreq.pathChannel(a, b) : null;
      return `
        <strong>${backbone ? backboneTitle(a, b) : 'Radio path'}</strong><br>
        <span class="mn-pop-line">${esc(a.name)} → ${esc(b.name)}</span><br>
        ${backbone && p ? `<span class="mn-pop-line">${p.overlap
          ? `${p.shared.length} shared ALERT ID${p.shared.length === 1 ? '' : 's'} in use · windows overlap on ${p.overlap}`
          : 'no pass-range window at the base end — matched on distance alone'}</span><br>` : ''}
        <span class="mn-pop-line">${ch ? esc(ch.label) + (ch.far ? ` (far end ${esc(ch.far)})` : '') + ' · ' : ''}${fmtKm(km)} · ${r.margin == null ? 'no margin figure'
          : `${(r.margin > 0 ? '+' : '') + r.margin.toFixed(1)} dB ${m.label.toLowerCase()} (free-space)`}</span>
        <!-- The same list a station callout carries (#170, .pill-list), and the
             same reason its two in-page actions became buttons: this one is
             in-page too — it switches tab and opens a card — so the anchor it
             used to be was announcing a link to nowhere. -->
        <div class="mn-popup-actions pill-row pill-list">
          <button type="button" class="pill"
             onclick="MapBackbone.openOnStations('${backbone ? 'backbone' : 'field'}','${escAttr(aId)}','${escAttr(bId)}')"
             title="Open this path on the Stations map with the elevation profile and fade margin cards"
             >${pillText('🗺️', 'Open on the Stations map', '↗')}</button>
        </div>`;
    },

    // Cross-tab hand-off: the Stations tab renders synchronously on
    // switchTab, and the card opens on the next tick so it lands on the
    // freshly built map and panels.
    openOnStations(kind, aId, bId) {
      switchTab('stations');
      setTimeout(() => open(kind, aId, bId), 0);
    },

    // The terrain profile landed (or failed), or a figure moved. The card has
    // already been drawn again with this path's rows on it — PathProfile asks
    // for them as it draws — so this only lets go of a path the profile has
    // left. Called from PathProfile.sync alongside LinkBudget.profileChanged.
    profileChanged() { forgetIfMoved(); },

    // The link budget, from the link on the card. Out of full
    // screen first when the card is under the map, for editStationFromCard's
    // reason — there is nothing to scroll to under a fixed panel — but not in
    // the side panel, which stays on screen beside a full-screen map and is
    // where the link was pressed. Then the pane that holds it on screen (〽️),
    // for dockReveal's.
    scrollTo(id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (state.mapFullscreen && !el.closest('#help-panel') && typeof toggleMapFullscreen === 'function') {
        toggleMapFullscreen(false);
      }
      dockReveal(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  };
})();
