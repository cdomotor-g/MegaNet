// MegaNet — map-direct.js
//
//   MapDirect   a field station's links, and the base stations that hear it
//               with no repeater between. While a field station's card is
//               open, the Stations map draws a line from it to every base
//               station that can likely hear it directly; and the card's Radio
//               tab lists every link it has — those, and the repeaters that
//               carry it — with each one's fade margin, the best first
//               (the Links line, under Assumed).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, cssVar,
// acmaHaversineKm and termHtml; to app.js for stationAlertIds, MapSymbols and
// mapStrokeScale; to frequencies.js for Frequencies.carriersOf (which carriers
// hear it first-hand, and so what it is assumed to transmit on) and
// Frequencies.repaint; to map-fade.js for MapFade.known and MapFade.work (each
// link's fade margin — the fade-margin layer's own figure, worked out the same
// way); to link-budget.js for lbMarginClass (the card's bands); and to
// map-backbone.js for MapBackbone.open (a link's radio-path card). All of it
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
  const PANE = 'mnDirectLines', PANE_Z = 407;
  const HEAR_DB  = 0;     // a margin at or above this: likely heard
  const MAX_WORK = 12;    // links worked out for one station
  const SAME_MHZ = 0.002; // frequencies.js's: channels here are 12.5 kHz apart
  const DASH = '10 6';

  let map = null, layer = null;
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
  const fin = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < SAME_MHZ;
  const chan = f => { const t = Number(f).toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
  const maxKm = () => Math.max(0, Number(state.mapMaxLinkKm) || 0);
  const kmOf = (a, b) => acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
  const key = (a, b) => `${a}>${b}`;
  const db = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  const drawnOnMap = s => typeof MapSymbols === 'undefined' || !MapSymbols.drawn || MapSymbols.drawn(s);

  // A field station on the radio: what has links to list. Not one that is a
  // repeater or a base as well — its way on is the backbone, drawn already.
  function canShow(s) {
    if (!placed(s) || !Array.isArray(s.roles) || !s.roles.includes('field') || s.proposed) return false;
    if (s.roles.includes('repeater') || s.roles.includes('base')) return false;
    let ids = [];
    try { ids = stationAlertIds(s) || []; } catch (_) { ids = []; }
    return ids.length > 0 || fin(s.alert2_station_id) != null;
  }

  // Every channel a base is on record as listening on.
  function rxOf(b) {
    const out = [];
    const add = v => { const f = fin(v); if (f != null && f > 0 && !out.some(x => same(x, f))) out.push(f); };
    if (b.repeater) add(b.repeater.rx_mhz);
    for (const f of b.frequencies || []) add(f && f.rx_mhz);
    return out.sort((x, y) => x - y);
  }

  // ── Who it links to ─────────────────────────────────────────────────────────
  //   { carriers: [{ s: repeater, km, direct }], bases: [{ s: base, km, check,
  //     rx, tx }], off: [{ s, km, rx }], tx: [MHz], far, maxKm }
  // check: 'match' (listens on its assumed TX), 'unchecked' (no RX on record,
  // or no assumed TX to check against).
  function linksOf(st) {
    if (!canShow(st)) return null;
    const K = maxKm();
    const C = typeof Frequencies !== 'undefined' && Frequencies.carriersOf ? Frequencies.carriersOf(st) : null;
    const tx = [];
    for (const c of (C && C.direct) || []) if (c.rx != null && !tx.some(f => same(f, c.rx))) tx.push(c.rx);
    const carrierIds = new Set(((C && C.all) || []).map(c => c.r.id));
    const directIds = new Set(((C && C.direct) || []).map(c => c.r.id));
    const carriers = ((C && C.all) || [])
      .filter(c => c.km != null && c.km <= K && placed(c.r))
      .map(c => ({ s: c.r, km: c.km, direct: directIds.has(c.r.id) }));
    const far = ((C && C.all) || []).filter(c => c.km == null || c.km > K).length;
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
    return { carriers, bases, off, tx, far, maxKm: K };
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
    const list = L.carriers.map(c => c.s).concat(L.bases.map(b => b.s)).slice(0, MAX_WORK);
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

  const WORDS = {
    links: 'Every radio path out of this station the map knows: the repeaters whose pass ranges carry it, within the Max TX '
      + 'distance, and the base stations within it that listen on its channel and so hear it with no repeater between. Each '
      + 'with its fade margin — how many decibels its signal arrives above what the receiver needs, at the reliability the link '
      + 'budget is set to — the best first. Good is 10 dB or more, Marginal 3 or more, Poor below that. A base station under '
      + '0 dB is too weak to count as hearing it, and is named on one line under the rest. Worked out over the terrain, the '
      + 'same figure the radio-path card gives; a model, not a measurement.',
  };

  // The figure, in the link budget's bands — Good, Marginal, Poor — as the
  // radio-path card and the profile word it.
  function figHtml(r) {
    const f = r.fig;
    if (!f || f.phase === 'asking') return '<span class="txt-muted" aria-busy="true">working out…</span>';
    if (f.phase !== 'ok') return '<span class="txt-muted">no fade margin</span>';
    const m = typeof lbMarginClass === 'function' ? lbMarginClass(f.margin) : { cls: 'ok', label: '' };
    return `<strong class="txt-${m.cls}">${esc(db(f.margin))}</strong> <span class="small">${esc(m.label)}</span>`;
  }

  // What the link is, under its name, in a few words a finger can read.
  function whyText(r) {
    const where = fmtKm(r.km);
    if (r.kind === 'carrier') {
      return `${isBase(r.s) ? 'base and repeater' : 'repeater'} · ${where} · carries it${r.direct ? '' : ', likely second-hand'}`;
    }
    const ch = r.check === 'match' ? `on ${r.tx.map(chan).join(', ')} MHz` : 'channel not checked';
    return `base station · ${where} · hears it direct · ${ch}`;
  }

  function nameBtn(st, r) {
    return `<button type="button" class="link-btn" onclick="MapDirect.open('${escAttr(st.id)}','${escAttr(r.s.id)}','${r.kind === 'base' ? 'direct' : 'field'}')"
      title="Open the elevation profile and link budget for this path">${esc(r.s.name || r.s.id)}</button>`;
  }

  const weakOf = r => r.kind === 'base' && r.fig && r.fig.phase === 'ok' && r.fig.margin < HEAR_DB;

  // The card's Links line: under Assumed, in frequencies.js's block. Each
  // repeater that carries it, and each base station that hears it direct, on
  // a line; the base stations in range too weak to, on one line under them.
  // Empty for a station with no links to list.
  function rowHtml(st) {
    const L = linksOf(st);
    if (!L) return '';
    const all = rowsOf(st, L);
    const rows = all.filter(r => !weakOf(r));
    const weak = all.filter(weakOf);
    const notes = [];
    const list = (xs, one) => `${xs.slice(0, 3).map(one).join(', ')}${xs.length > 3 ? ` and ${xs.length - 3} more` : ''}`;
    if (weak.length) {
      notes.push(`Too weak to hear it direct: ${list(weak, r => `${r.s.name || r.s.id} (${fmtKm(r.km)}, ${db(r.fig.margin)})`)}.`);
    }
    if (L.off.length) {
      notes.push(`Not counted, on another channel: ${list(L.off, o => `${o.s.name || o.s.id} (${o.rx.map(chan).join(', ')} MHz)`)}.`);
    }
    if (L.far) notes.push(`${L.far} more repeater${L.far === 1 ? '' : 's'} carrying it past the Max TX distance (${L.maxKm} km).`);
    const label = `<span>${termHtml('Links', WORDS.links)}</span>`;
    const noteHtml = notes.map(n => ` <span class="mn-pop-note freq-why">${esc(n)}</span>`).join('');
    if (!all.length) {
      return `<div class="acma-row stn-card-links">${label}<span><span class="txt-muted">none within ${esc(String(L.maxKm))} km</span>${noteHtml}</span></div>`;
    }
    ask(st, L);
    const key_ = ' <span class="mn-pop-note freq-why">Fade margin: dB to spare above what the receiver needs — Good 10 or more, '
      + 'Marginal 3 or more, Poor under 3. Modelled, not measured.</span>';
    return `<div class="acma-row stn-card-links">${label}<span>${rows.map(r => `
      <span class="freq-val stn-link" data-mn-link="${escAttr(r.s.id)}" data-mn-link-kind="${r.kind}">${nameBtn(st, r)} · ${figHtml(r)}</span>
      <span class="mn-pop-note freq-why">${esc(whyText(r))}</span>`).join('')}${rows.length ? '' : '<span class="txt-muted">none heard</span>'}${noteHtml}${key_}</span></div>`;
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
      L_().polyline(ll, { pane: PANE, color: '#ffffff', weight: 8 * scale, opacity: 0.9, interactive: false })
        .addTo(layer);
      const line = L_().polyline(ll, { pane: PANE, color: c, weight: 5 * scale, opacity: 1, dashArray: DASH, lineCap: 'butt' })
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
  // 'direct' to a base that hears it with no repeater between.
  function open(aId, bId, kind) {
    if (typeof MapBackbone === 'undefined' || !byId(aId) || !byId(bId)) return;
    MapBackbone.open(kind === 'direct' ? 'direct' : 'field', aId, bId);
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
      }
      draw();
    },

    detach() {
      clearLayer();
      map = null;
    },

    // The card is on this station now (null: closed). Its lines follow it.
    follow(id) {
      const st = id ? byId(id) : null;
      const next = st && canShow(st) ? st.id : null;
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
    open,
    channelHtml,
    words: () => ({ ...WORDS }),
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
        bases: L.bases.map(b => ({ id: b.s.id, km: b.km, check: b.check })),
        off: L.off.map(o => o.s.id), tx: L.tx.slice(), maxKm: L.maxKm,
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
