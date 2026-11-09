// MegaNet — map-direct.js
//
//   MapDirect   a station's links up the network, toward the base stations
//               that take its readings in, and the base stations that hear it
//               with no repeater between. While a field station's card is
//               open, the Stations map draws a line from it to every base
//               station that can likely hear it directly; and every station
//               card's Radio tab lists every link it has upstream — those, the
//               repeaters that carry it and, for a repeater, the ones that
//               relay it on — with each one's fade margin, the best first
//               (the Links line, under Assumed). A base station has none: it
//               is where the readings come in.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, cssVar,
// acmaHaversineKm and termHtml; to app.js for stationAlertIds, MapSymbols and
// mapStrokeScale; to frequencies.js for Frequencies.carriersOf (which carriers
// hear it first-hand, and so what it is assumed to transmit on) and
// Frequencies.repaint; to map-fade.js for MapFade.known and MapFade.work (each
// link's fade margin — the fade-margin layer's own figure, worked out the same
// way); to link-budget.js for lbMarginClass (the card's bands); and to
// map-backbone.js for MapBackbone.open (a link's radio-path card),
// backbonePairFor (which card a repeater's link opens), and
// repeaterOpenWindows and windowOverlapCount (who relays a repeater on). All of it
// from inside its own functions — the IIFE body only declares — so this
// file's position among the modules is free (`npm run toplevel`). initMap()
// attaches it, stopStationsMap() detaches it, repaintStnCard() tells it which
// station the card is on, and frequencies.js places rowHtml().
//
// ── The gap this fills ───────────────────────────────────────────────────────
// The map draws two kinds of line: a field station to each repeater whose
// pass ranges carry it, and a repeater on to another repeater or to a base
// station (the backbone). Never a field station straight to a base — yet a
// base station hears every field station in range on a channel it listens on,
// repeater or no repeater. Greys Plains Rd AL is the case: 24 km from Marburg
// Radar with a clear shot (+34 dB), and no line between them, because Marburg
// is a base and the field links only ever end at a repeater.
//
// Drawn for every field station, those lines would be the spaghetti the map
// spends its switches cutting. So they are drawn for one station — the one
// whose card is open — and go when the card closes or moves on.
//
// ── Which base stations ──────────────────────────────────────────────────────
//   in range   placed, on the map (Show these stations), and within the Max TX
//              distance of the station — the map's own slider, the rule its
//              field links and backbone are drawn by.
//   on channel its RX channels on record (a base that is a repeater too: its
//              repeater RX; and every row of its frequencies) include what the
//              station is assumed to transmit on — the RX of the repeaters
//              likely to hear it first-hand (frequencies.js, Assumed). A base
//              with no RX on record, or a station with no assumed TX, cannot be
//              checked: counted, and the card says it was not checked. A base
//              on record as listening elsewhere is left out, and named.
//   not a carrier  a base whose pass ranges carry the station already has its
//              field link on the map, and is listed as a carrier.
//   heard      its fade margin is 0 dB or better: the signal arrives above
//              what the receiver needs, at the reliability the link budget is
//              set to (70 % of situations by default). Below that it is listed
//              as too weak, not drawn.
//
// ── Upstream only ────────────────────────────────────────────────────────────
// The Links list runs one way, as the readings do: from the station on the
// card toward the base stations (the ingest points), never back down to what
// it hears. What counts as a step up, by what the station is:
//
//   field station  the repeaters whose pass ranges carry its AlertIDs, and the
//                  base stations in range on its assumed TX (above).
//   repeater       the same for its own AlertIDs (Upper Rosenthal AL's 5767 and
//                  5768 are carried by Amiens Knob and Wilsons Peak, not by its
//                  own pass ranges), with its TX on record as the channel;
//                  and the repeaters that relay it on: within the Max TX
//                  distance, their open windows take some of what it passes on,
//                  and the channels run one way — they listen on its TX and do
//                  not transmit on its RX. Wilsons Peak (in on 151.500, out on
//                  152.400) relays Upper Rosenthal (151.500 both ways); Upper
//                  Rosenthal does not relay Wilsons Peak, which it cannot hear.
//                  Two repeaters in and out on the same channel hear each other
//                  both ways, and nothing on record says which way is up — so
//                  neither is listed as relaying the other, unless one carries
//                  the other's AlertIDs.
//   base station   nothing: its receivers put what they hear into Flood-Net,
//                  and the list says so rather than standing empty.
//
// Hop counts to the nearest base on record were tried for "up", and are not
// used: the register's base stations are a handful, most in the south-east, so
// Upper Rosenthal, 97 km from an environmental base with no channel on record,
// came out one hop from home, and Amiens Knob, which carries its AlertIDs, a
// step down.
// The pass ranges and the channel plan are what the network was set up by.
//
// ── The fade margins ─────────────────────────────────────────────────────────
// MapFade's, never one invented here: a saved row while its signature holds,
// else this session's, else worked out now by MapFade.work — the sweep's own
// computeOne, Longley–Rice over the terrain with the field allowance — so the
// figure on the card is the one the radio-path card and the fade-margin map
// give the same pair. One way, as the traffic runs: the station transmits, the
// repeater or base listens. Worked out one link at a time, kept for the
// session, and painted in place as each lands.

const MapDirect = (function () {
  // Over the network's links (400), their arrowheads (405) and 🎯's lines
  // (408), under 🪜 Hops to base (409): this is the card's station's own
  // answer, and the hops, when somebody lights them, are the bigger one.
  //
  // SVG, and a pane that takes no pointer, never the map's shared canvas
  // pattern: with preferCanvas, a path in a pane of its own gets a canvas of
  // its own, the size of the map, and this pane is over the links (400). That
  // sheet took every click and hover meant for a pin or a link under it — and
  // stayed after the lines went, since Leaflet keeps a pane's renderer, so the
  // map could only be panned until the page was reloaded. An SVG path in a
  // pane with pointer-events off answers only on its own stroke (Leaflet puts
  // pointer-events back on each interactive path), which is all a line wants.
  // map-rivers.js and site-features.js say the same; styles.css backs it up.
  const PANE = 'mnDirectLines', PANE_Z = 407;
  const HEAR_DB  = 0;     // a margin at or above this: likely heard
  const MAX_WORK = 12;    // links worked out for one station
  const SAME_MHZ = 0.002; // frequencies.js's: channels here are 12.5 kHz apart
  const DASH = '10 6';

  let map = null, layer = null;
  let renderer = null;    // this map's SVG renderer in PANE (attach)
  let onId = null;        // the field station the lines are drawn for
  // `${from}>${to}` → { phase: 'asking' | 'ok' | 'none', margin, verdict }
  const figs = new Map();
  const queue = [];
  let running = 0;

  // ── Small things ────────────────────────────────────────────────────────────

  const stations = () => (state.data && state.data.stations) || [];
  const byId = id => stations().find(s => s.id === id) || null;
  const placed = s => !!s && s.lat != null && s.lon != null;
  const isBase = s => !!s && Array.isArray(s.roles) && s.roles.includes('base');
  const isRep = s => !!s && Array.isArray(s.roles) && s.roles.includes('repeater');
  const fin = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < SAME_MHZ;
  const chan = f => { const t = Number(f).toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
  const maxKm = () => Math.max(0, Number(state.mapMaxLinkKm) || 0);
  const kmOf = (a, b) => acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
  const key = (a, b) => `${a}>${b}`;
  const db = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`;
  const drawnOnMap = s => typeof MapSymbols === 'undefined' || !MapSymbols.drawn || MapSymbols.drawn(s);

  const onRadio = s => {
    let ids = [];
    try { ids = stationAlertIds(s) || []; } catch (_) { ids = []; }
    return ids.length > 0 || fin(s.alert2_station_id) != null;
  };

  // What the card lists links for: a base station (to say it has none, being
  // where the readings come in), a repeater, and a field station on the radio
  // — placed, and not proposed.
  function canList(s) {
    if (!s || !Array.isArray(s.roles) || s.proposed) return false;
    if (isBase(s)) return true;
    if (!placed(s)) return false;
    if (isRep(s)) return true;
    return s.roles.includes('field') && onRadio(s);
  }

  // What the map draws lines for: a field station only. A repeater's and a
  // base's way on is the backbone, drawn already.
  const canDraw = s => canList(s) && !isBase(s) && !isRep(s);

  // Every channel a base is on record as listening on.
  function rxOf(b) {
    const out = [];
    const add = v => { const f = fin(v); if (f != null && f > 0 && !out.some(x => same(x, f))) out.push(f); };
    if (b.repeater) add(b.repeater.rx_mhz);
    for (const f of b.frequencies || []) add(f && f.rx_mhz);
    return out.sort((x, y) => x - y);
  }

  // The repeaters that relay a repeater on (see "Upstream only"): within the
  // Max TX distance, their open windows taking some of what it passes on, and
  // the channels one way — they listen on its TX and do not transmit on its
  // RX, all four on record. Not a base (listed as one), nor one listed already.
  function relaysOf(st, K, skip) {
    const r0 = st.repeater;
    const tx = fin(r0 && r0.tx_mhz), rx = fin(r0 && r0.rx_mhz);
    if (tx == null || rx == null || typeof repeaterOpenWindows !== 'function' || typeof windowOverlapCount !== 'function') return [];
    const mine = repeaterOpenWindows(r0);
    if (!mine.length) return [];
    const out = [];
    for (const r of stations()) {
      if (r.id === st.id || !isRep(r) || isBase(r) || !r.repeater || skip.has(r.id) || !placed(r)) continue;
      const rrx = fin(r.repeater.rx_mhz), rtx = fin(r.repeater.tx_mhz);
      if (!same(rrx, tx) || rtx == null || same(rtx, rx)) continue;
      const km = kmOf(st, r);
      if (!(km <= K) || !windowOverlapCount(mine, repeaterOpenWindows(r.repeater))) continue;
      out.push({ s: r, km });
    }
    return out.sort((x, y) => x.km - y.km);
  }

  // ── Who it links to ─────────────────────────────────────────────────────────
  //   { carriers: [{ s: repeater, km, direct }], relays: [{ s: repeater, km }],
  //     bases: [{ s: base, km, check, rx, tx }], off: [{ s, km, rx }],
  //     tx: [MHz], far, maxKm, rep, ingest }
  // check: 'match' (listens on its TX — a repeater's on record, a field
  // station's assumed), 'unchecked' (no RX on record, or no TX to check
  // against). A base station answers { ingest: true } and empty lists.
  function linksOf(st) {
    if (!canList(st)) return null;
    const K = maxKm();
    if (isBase(st)) return { carriers: [], relays: [], bases: [], off: [], tx: [], far: 0, maxKm: K, rep: false, ingest: true };
    const rep = isRep(st);
    const C = typeof Frequencies !== 'undefined' && Frequencies.carriersOf ? Frequencies.carriersOf(st) : null;
    // What it transmits on: a repeater's TX on record; a field station's own
    // never is, so the RX of the repeaters likely to hear it first-hand.
    const tx = [];
    const own = rep ? fin(st.repeater && st.repeater.tx_mhz) : null;
    if (own != null) tx.push(own);
    else for (const c of (C && C.direct) || []) if (c.rx != null && !tx.some(f => same(f, c.rx))) tx.push(c.rx);
    const carrierIds = new Set(((C && C.all) || []).map(c => c.r.id));
    const directIds = new Set(((C && C.direct) || []).map(c => c.r.id));
    const carriers = ((C && C.all) || [])
      .filter(c => c.km != null && c.km <= K && placed(c.r))
      .map(c => ({ s: c.r, km: c.km, direct: directIds.has(c.r.id) }));
    const far = ((C && C.all) || []).filter(c => c.km == null || c.km > K).length;
    const relays = rep && st.repeater ? relaysOf(st, K, carrierIds) : [];
    const bases = [], off = [];
    for (const b of stations()) {
      if (!isBase(b) || b.id === st.id || carrierIds.has(b.id) || !placed(b) || !drawnOnMap(b)) continue;
      const km = kmOf(st, b);
      if (!(km <= K)) continue;
      const rx = rxOf(b);
      const hit = tx.filter(f => rx.some(r => same(r, f)));
      if (rx.length && tx.length && !hit.length) { off.push({ s: b, km, rx }); continue; }
      bases.push({ s: b, km, rx, tx: hit, check: rx.length && tx.length ? 'match' : 'unchecked' });
    }
    bases.sort((x, y) => x.km - y.km);
    off.sort((x, y) => x.km - y.km);
    return { carriers, relays, bases, off, tx, far, maxKm: K, rep, ingest: false };
  }

  // ── The fade margins ────────────────────────────────────────────────────────

  // What is known of one link now, without asking for anything.
  function figOf(a, b) {
    const k = key(a.id, b.id);
    const f = figs.get(k);
    if (f && f.phase !== 'none') return f;
    if (typeof MapFade !== 'undefined' && MapFade.known) {
      const kn = MapFade.known(a, b);
      if (kn && kn.margin != null && isFinite(kn.margin)) {
        const got = { phase: 'ok', margin: kn.margin, verdict: kn.verdict || null };
        figs.set(k, got);
        return got;
      }
    }
    return f || null;
  }

  // Work out every link of one station nobody has a figure for, a couple at a
  // time; the card and the lines repaint as each lands.
  function ask(st, L) {
    if (typeof MapFade === 'undefined' || !MapFade.work) return;
    const list = L.carriers.map(c => c.s).concat(L.relays.map(r => r.s), L.bases.map(b => b.s)).slice(0, MAX_WORK);
    for (const other of list) {
      if (figOf(st, other)) continue;
      figs.set(key(st.id, other.id), { phase: 'asking' });
      queue.push([st.id, other.id]);
    }
    pump();
  }

  function pump() {
    while (running < 2 && queue.length) {
      const [aId, bId] = queue.shift();
      const a = byId(aId), b = byId(bId);
      if (!a || !b) { figs.delete(key(aId, bId)); continue; }
      running++;
      // A figure that came in some other way while this one was out — the
      // fade-margin layer's sweep, a saved row — is not overwritten by a
      // failure, or by a second copy of itself.
      const put = v => { const was = figs.get(key(aId, bId)); if (!(was && was.phase === 'ok')) figs.set(key(aId, bId), v); };
      Promise.resolve().then(() => MapFade.work(a, b)).then(k => {
        put(k && k.margin != null && isFinite(k.margin)
          ? { phase: 'ok', margin: k.margin, verdict: k.verdict || null } : { phase: 'none' });
      }, () => {
        put({ phase: 'none' });
      }).finally(() => {
        running--;
        landed(aId);
        pump();
      });
    }
  }

  // A figure for one of `id`'s links landed: its card's line and its lines on
  // the map, if they are still on show.
  function landed(id) {
    if (typeof Frequencies !== 'undefined' && Frequencies.repaint) Frequencies.repaint(id);
    if (id === onId) redraw();
  }

  // The lines again, and the legend's key when they came or went.
  function redraw() {
    const had = active();
    draw();
    if (had !== active()) { try { rerenderMapLegend(); } catch (_) { /* not the Stations tab */ } }
  }

  function active() { return !!(onId && layer && layer.getLayers().length); }

  // ── The list, for the card ──────────────────────────────────────────────────

  // Every link, the best fade margin first; those still being worked out, or
  // that could not be, after them, nearest first.
  function rowsOf(st, L) {
    const rows = L.carriers.map(c => ({ kind: 'carrier', s: c.s, km: c.km, direct: c.direct, fig: figOf(st, c.s) }))
      .concat(L.relays.map(r => ({ kind: 'relay', s: r.s, km: r.km, fig: figOf(st, r.s) })))
      .concat(L.bases.map(b => ({ kind: 'base', s: b.s, km: b.km, check: b.check, rx: b.rx, tx: b.tx, fig: figOf(st, b.s) })));
    const m = r => (r.fig && r.fig.phase === 'ok' ? r.fig.margin : null);
    return rows.sort((x, y) => {
      const a = m(x), b = m(y);
      if (a != null && b != null) return b - a || x.km - y.km;
      if (a != null) return -1;
      if (b != null) return 1;
      return x.km - y.km;
    });
  }

  // What its words mean: on hover, and in the block's "What the words mean"
  // fold (frequencies.js) — [word, meaning].
  const WORDS = {
    links: ['Links', 'Every radio path from this station up the network, toward the base stations that take its readings '
      + 'into Flood-Net — never back down to what it hears. The repeaters whose pass ranges carry it; for a repeater, also '
      + 'the repeaters that relay it on; and the base stations that listen on its channel and so hear it with no repeater '
      + 'between. All within the Max TX distance, best fade margin first. A base station has none: it is where the '
      + 'readings come in.'],
    relay: ['Relays it on', 'A repeater that takes what this repeater relays and passes it on toward a base station: its '
      + 'pass ranges take some of the same AlertIDs, it listens on the channel this one transmits on, and it does not '
      + 'transmit on the channel this one listens on — so the traffic between them runs one way, up.'],
    ingest: ['Base station', 'Where readings come into Flood-Net: its receivers hear field stations and repeaters and put '
      + 'their readings in the datastore. Every station\'s links point toward one, so a base station has none of its own.'],
    margin: ['Modelled fade margin', 'How many decibels (dB) its signal arrives above what the receiver needs, at the reliability the '
      + 'link budget is set to. Good is 10 dB or more, Marginal 3 or more, Poor below that. Worked out over the terrain — '
      + 'the figure the radio-path card gives — a model, not a measurement: the real link can be several dB better or worse, '
      + 'so treat it as a guide and test it on site before relying on it. The bars draw it on one scale, −20 to +40 dB.'],
    second: ['Second-hand', 'A repeater that carries it, but most likely hears it through a nearer repeater that carries it '
      + 'too, rather than from the station itself.'],
    unchecked: ['Channel not checked', 'The base station has no receive channel on record, so nobody has checked that it '
      + 'listens on the one this station is assumed to transmit on.'],
    weak: ['Too weak to hear it direct', 'Base stations in range, on its channel, whose fade margin is under 0 dB: the '
      + 'signal arrives below what the receiver needs, so they are not counted as hearing it.'],
    off: ['On another channel', 'Base stations in range that are on record as listening on a different channel, so they '
      + 'cannot hear it, and are not counted.'],
  };
  const word = (k, text) => termHtml(text || WORDS[k][0], WORDS[k][1]);

  // The figure, in the link budget's bands — Good, Marginal, Poor — as the
  // radio-path card and the profile word it.
  function figHtml(r) {
    const f = r.fig;
    if (!f || f.phase === 'asking') return '<span class="txt-muted" aria-busy="true">working out…</span>';
    if (f.phase !== 'ok') return '<span class="txt-muted">no fade margin</span>';
    const m = band(f.margin);
    return `<strong class="txt-${m.cls}">${esc(db(f.margin))}</strong> <span class="small">${esc(m.label)}</span>`;
  }
  const band = v => (typeof lbMarginClass === 'function' ? lbMarginClass(v) : { cls: 'ok', label: '' });

  // ── The bars ──
  // Every link's fade margin on one scale, −20 to +40 dB, with the bands
  // shaded behind it and a tick at 0, so the strong link stands out before a
  // word is read. Fixed, so one station's card and the next read alike; a
  // figure past an end runs to that end, with an arrow.
  const LO = -20, HI = 40, TICKS = [-20, 0, 10, 20, 40];
  const pct = v => ((Math.max(LO, Math.min(HI, v)) - LO) / (HI - LO)) * 100;
  const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;
  // Where 0 and the band edges fall, for the shading — and below, each tick's
  // and each bar's place — as custom properties styles.css reads: the tab's
  // rule is no inline style but a token override (`npm run tabs`).
  function scaleStyle() {
    const good = typeof LB_MARGIN !== 'undefined' ? LB_MARGIN[0].min : 10;
    const fair = typeof LB_MARGIN !== 'undefined' ? LB_MARGIN[1].min : 3;
    return ` style="--freq-zero:${pct(0).toFixed(2)}%;--freq-fair:${pct(fair).toFixed(2)}%;--freq-good:${pct(good).toFixed(2)}%"`;
  }
  const axisHtml = () => `<span class="freq-axis" aria-hidden="true">${TICKS.map(v =>
    `<span style="--freq-at:${pct(v).toFixed(2)}%">${signed(v)}</span>`).join('')}</span>`;
  function barHtml(r) {
    const f = r.fig;
    if (!f || f.phase !== 'ok') return '<span class="freq-bar" aria-hidden="true"></span>';
    const m = band(f.margin), z = pct(0), p = pct(f.margin);
    const cut = f.margin < LO ? '<span class="freq-cut">◂</span>' : f.margin > HI ? '<span class="freq-cut freq-cut-hi">▸</span>' : '';
    return `<span class="freq-bar" role="img" aria-label="${escAttr(`Fade margin ${db(f.margin)}, ${m.label}`)}">`
      + `<i class="${m.cls}" style="--freq-from:${Math.min(z, p).toFixed(2)}%;--freq-len:${Math.abs(p - z).toFixed(2)}%"></i>${cut}</span>`;
  }

  // What the link is, under its name, in a few words a finger can read.
  function whyHtml(r) {
    const where = esc(fmtKm(r.km));
    if (r.kind === 'carrier') {
      return `${isBase(r.s) ? 'base and repeater' : 'repeater'} · ${where} · carries it${r.direct ? '' : `, likely ${word('second', 'second-hand')}`}`;
    }
    if (r.kind === 'relay') return `repeater · ${where} · ${word('relay', 'relays it on')}`;
    const ch = r.check === 'match' ? `on ${esc(r.tx.map(chan).join(', '))} MHz` : word('unchecked', 'channel not checked');
    return `base station · ${where} · hears it direct · ${ch}`;
  }

  // Which radio-path card a link opens: from a field station, its field link
  // to a repeater or its path direct to a base; from a repeater, the backbone
  // path the map draws for the pair (every repeater–base pair, and every two
  // repeaters whose windows overlap), else the field link its AlertIDs make.
  function pathKind(st, r) {
    if (!isRep(st)) return r.kind === 'base' ? 'direct' : 'field';
    return typeof backbonePairFor === 'function' && backbonePairFor(st.id, r.s.id) ? 'backbone' : 'field';
  }

  function nameBtn(st, r) {
    return `<button type="button" class="link-btn" onclick="MapDirect.open('${escAttr(st.id)}','${escAttr(r.s.id)}','${pathKind(st, r)}')"
      title="Open the elevation profile and link budget for this path">${esc(r.s.name || r.s.id)}</button>`;
  }

  // One link: its name and figure, its bar, and what it is. A base too weak
  // to hear it gives its distance only.
  function itemHtml(st, r, weak) {
    return `<div class="freq-link stn-link${weak ? ' freq-link-weak' : ''}" data-mn-link="${escAttr(r.s.id)}" data-mn-link-kind="${r.kind}">`
      + `${nameBtn(st, r)}<span class="freq-fig">${figHtml(r)}</span>${barHtml(r)}`
      + `<span class="mn-pop-note freq-why">${weak ? esc(fmtKm(r.km)) : whyHtml(r)}</span></div>`;
  }

  const weakOf = r => r.kind === 'base' && r.fig && r.fig.phase === 'ok' && r.fig.margin < HEAR_DB;

  // The bands, in words, under the bars — the key a finger can read.
  function keyHtml() {
    const B = typeof LB_MARGIN !== 'undefined' ? LB_MARGIN : [{ min: 10, label: 'Good', cls: 'ok' }, { min: 3, label: 'Marginal', cls: 'warn' },
      { min: -Infinity, label: 'Poor', cls: 'bad' }];
    const range = i => (i === 0 ? `${B[0].min}+` : B[i].min === -Infinity ? `under ${B[i - 1].min}` : `${B[i].min}–${B[i - 1].min}`);
    return `<span class="freq-key">${B.map((b, i) => `<span><span class="freq-dot ${b.cls}" aria-hidden="true"></span>${esc(b.label)} ${range(i)}</span>`).join(' ')}`
      + ' <span>modelled, not measured</span></span>';
  }

  // The card's Links, under Assumed TX, in frequencies.js's block: each
  // repeater that carries it and each base station that hears it direct, a
  // bar each, the best first; the base stations in range too weak to, in a
  // fold under them; those on another channel named on a line. Empty for a
  // station with no links to list.
  function rowHtml(st) {
    const L = linksOf(st);
    if (!L) return '';
    const all = rowsOf(st, L);
    const rows = all.filter(r => !weakOf(r));
    const weak = all.filter(weakOf);
    const list = (xs, one) => `${xs.slice(0, 3).map(one).join(', ')}${xs.length > 3 ? ` and ${xs.length - 3} more` : ''}`;
    const notes = [];
    if (L.off.length) {
      notes.push(`<span class="mn-pop-note freq-why">${word('off')}, not counted: ${esc(list(L.off, o =>
        `${o.s.name || o.s.id} (${o.rx.map(chan).join(', ')} MHz)`))}</span>`);
    }
    if (L.far) {
      notes.push(`<span class="mn-pop-note freq-why">${esc(`${L.far} more repeater${L.far === 1 ? '' : 's'} carrying it past the Max TX `
        + `distance (${L.maxKm} km).`)}</span>`);
    }
    const S = (html, right = '') => (typeof Frequencies !== 'undefined' && Frequencies.section
      ? Frequencies.section('links', WORDS.links[0], WORDS.links[1], html, right, scaleStyle()) : '');
    if (L.ingest) {
      return S(`<span class="txt-muted">none — it is a ${word('ingest', 'base station')}</span>`
        + ' <span class="mn-pop-note freq-why">Readings come into Flood-Net here, so there is no link further up to show.</span>');
    }
    if (!all.length) {
      if (L.rep) {
        notes.unshift('<span class="mn-pop-note freq-why">Nothing on record takes it on toward a base station: no repeater '
          + 'carries its AlertIDs or relays it on, and no base station in range listens on its channel.</span>');
      }
      return S(`<span class="txt-muted">none within ${esc(String(L.maxKm))} km</span>${notes.join('')}`);
    }
    ask(st, L);
    const fold = typeof Frequencies !== 'undefined' && Frequencies.foldAttrs ? Frequencies.foldAttrs(st.id, 'weak') : '';
    const weakHtml = weak.length ? `<details class="freq-fold"${fold}><summary>${word('weak')} <b class="freq-count">${weak.length}</b></summary>`
      + `<div class="freq-fold-body">${axisHtml()}${weak.map(r => itemHtml(st, r, true)).join('')}</div></details>` : '';
    return S(axisHtml() + (rows.length ? rows.map(r => itemHtml(st, r, false)).join('') : '<span class="txt-muted">none heard</span>')
      + weakHtml + notes.join('') + keyHtml(), word('margin', 'Modelled fade margin, dB'));
  }

  // The summary's first line, at the top of the Radio tab (frequencies.js):
  // its best link, and when that is a base station's, whether the repeaters
  // do any better than Poor. Empty until a figure has landed.
  function summaryHtml(st) {
    const L = linksOf(st);
    if (!L) return '';
    const rows = rowsOf(st, L).filter(r => !weakOf(r) && r.fig && r.fig.phase === 'ok');
    if (!rows.length) return '';
    const best = rows[0], m = band(best.fig.margin);
    const what = best.kind === 'base' ? 'direct to base' : isBase(best.s) ? 'a base and repeater' : 'a repeater';
    const reps = rows.filter(r => r.kind !== 'base');
    const poor = typeof LB_MARGIN !== 'undefined' ? LB_MARGIN[1].min : 3;
    const after = best.kind === 'base' && reps.length && reps.every(r => r.fig.margin < poor)
      ? (reps.length === 1 ? ' Its repeater link is Poor.' : ` All ${reps.length} repeater links are Poor.`) : '';
    return `<p><span class="freq-dot ${m.cls}" aria-hidden="true"></span>${rows.length === 1 ? 'Its only link' : 'Best link'}: `
      + `<b>${esc(best.s.name || best.s.id)}</b>, ${what}, <strong class="txt-${m.cls}">${esc(db(best.fig.margin))}</strong> ${esc(m.label)}.${after}</p>`;
  }

  // ── The lines on the map ────────────────────────────────────────────────────

  function clearLayer() {
    if (layer) { layer.remove(); layer = null; }
  }

  const BAND_TOKEN = { ok: ['--map-fade-good', '#00e676'], warn: ['--map-fade-ok', '#ffab00'], bad: ['--map-fade-bad', '#e53935'] };

  function tipHtml(st, b, f, base) {
    const m = typeof lbMarginClass === 'function' ? lbMarginClass(f.margin) : null;
    const ch = base.check === 'match' ? `${esc(base.tx.map(chan).join(', '))} MHz, which ${esc(b.name)} listens on`
      : 'channel not checked';
    return `<div class="mn-link-tip-head">Direct to base — no repeater between</div>
      <div class="mn-link-tip-hop"><span class="mn-link-tip-k">TX</span> ${esc(st.name)} → <span class="mn-link-tip-k">RX</span>
        ${esc(b.name)} · ${ch}</div>
      <div class="mn-link-tip-note">${esc(fmtKm(base.km))} · fade margin ${esc(db(f.margin))}${m ? ` — ${esc(m.label)}` : ''}.
        Drawn while ${esc(st.name)}'s card is open.</div>`;
  }

  function draw() {
    clearLayer();
    if (!map || !onId) return;
    const st = byId(onId);
    const L = st ? linksOf(st) : null;
    if (!L || !L.bases.length) return;
    ask(st, L);
    const scale = typeof mapStrokeScale === 'function' ? mapStrokeScale() : 1;
    layer = L_().layerGroup([], { pane: PANE }).addTo(map);
    for (const base of L.bases) {
      const f = figOf(st, base.s);
      if (!f || f.phase !== 'ok' || f.margin < HEAR_DB) continue;
      const band = typeof lbMarginClass === 'function' ? lbMarginClass(f.margin).cls : 'ok';
      const c = cssVar(BAND_TOKEN[band][0], BAND_TOKEN[band][1]);
      const ll = [[st.lat, st.lon], [base.s.lat, base.s.lon]];
      L_().polyline(ll, { pane: PANE, renderer, color: '#ffffff', weight: 8 * scale, opacity: 0.9, interactive: false })
        .addTo(layer);
      const line = L_().polyline(ll, { pane: PANE, renderer, color: c, weight: 5 * scale, opacity: 1, dashArray: DASH, lineCap: 'butt' })
        .addTo(layer);
      line.mnDirect = { from: st.id, to: base.s.id, margin: f.margin, band };
      line.bindTooltip(() => tipHtml(st, base.s, f, base), { sticky: true, direction: 'top', className: 'mn-link-tip' });
      line.on('click', e => {
        if (state.draw && state.draw.tool) return;
        L_().DomEvent.stopPropagation(e);
        open(st.id, base.s.id, 'direct');
      });
    }
    if (!layer.getLayers().length) clearLayer();
  }

  // Leaflet, asked for when it is needed — a page without the map has none.
  const L_ = () => window.L;

  // A link's radio-path card: the elevation profile and the link budget on the
  // pair, the station transmitting. 'field' to a repeater that carries it,
  // 'direct' to a base that hears it with no repeater between, 'backbone' from
  // a repeater along a path the map draws (pathKind).
  function open(aId, bId, kind) {
    if (typeof MapBackbone === 'undefined' || !byId(aId) || !byId(bId)) return;
    MapBackbone.open(kind === 'direct' || kind === 'backbone' ? kind : 'field', aId, bId);
  }

  // The channel a direct path is on, for the radio-path card's Frequency row.
  function channelHtml(a, b) {
    const L = linksOf(a);
    const base = L && L.bases.find(x => x.s.id === b.id);
    const rx = rxOf(b);
    if (base && base.check === 'match') {
      return `${esc(base.tx.map(chan).join(', '))} MHz<br><span class="small">its assumed TX, which ${esc(b.name)} listens on</span>`;
    }
    if (!rx.length) return `<span class="small">not checked — no RX frequency on record for ${esc(b.name)}</span>`;
    return `<span class="small">not checked — its assumed TX is not known; ${esc(b.name)} listens on ${esc(rx.map(chan).join(', '))} MHz</span>`;
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const p = m.createPane(PANE);
        p.style.zIndex = PANE_Z;
        p.style.pointerEvents = 'none';
      }
      renderer = L_().svg({ pane: PANE });
      draw();
    },

    detach() {
      clearLayer();
      map = null;
      renderer = null;
    },

    // The card is on this station now (null: closed). Its lines follow it.
    follow(id) {
      const st = id ? byId(id) : null;
      const next = st && canDraw(st) ? st.id : null;
      if (next === null && onId === null) return;
      const moved = next !== onId;
      onId = next;
      if (moved) { clearLayer(); try { rerenderMapLegend(); } catch (_) { /* not the Stations tab */ } }
      redraw();
    },

    // Something the lines depend on moved — the Max TX distance, the stations
    // on the map: drawn again for the same station.
    sync() { if (onId) redraw(); },

    rowHtml,
    summaryHtml,
    open,
    channelHtml,
    words: () => Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, v.slice()])),
    active,

    legendHtml() {
      if (!onId || !layer || !layer.getLayers().length) return '';
      const st = byId(onId);
      return `
      <span class="legend-item">
        <span class="legend-line legend-line-direct"></span>
        <span class="small">Direct to base — a base station that hears ${esc(st ? st.name : 'this station')} with no repeater
          between, drawn while its card is open; coloured by fade margin, green Good (10 dB or more), amber Marginal (3 or more),
          red Poor</span>
      </span>`;
    },

    // For the check: who it links to, the lines drawn, and a figure set by hand.
    _links(id) {
      const st = byId(id);
      const L = st ? linksOf(st) : null;
      return L && {
        carriers: L.carriers.map(c => ({ id: c.s.id, km: c.km, direct: c.direct })),
        relays: L.relays.map(r => ({ id: r.s.id, km: r.km })),
        bases: L.bases.map(b => ({ id: b.s.id, km: b.km, check: b.check })),
        off: L.off.map(o => o.s.id), tx: L.tx.slice(), maxKm: L.maxKm, ingest: L.ingest,
      };
    },
    _drawn() { return layer ? layer.getLayers().filter(l => l.mnDirect).map(l => ({ ...l.mnDirect })) : []; },
    _set(aId, bId, margin) {
      figs.set(key(aId, bId), margin == null ? { phase: 'none' } : { phase: 'ok', margin, verdict: null });
      landed(aId);
    },
    _onId() { return onId; },
  };
})();
if (typeof window !== 'undefined') window.MapDirect = MapDirect;
