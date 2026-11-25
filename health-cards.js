// MegaNet — health-cards.js
//
//   HealthCards   Station Health's **Station cards**: every station a
//                 maintenance hub looks after as a small card on one screen,
//                 north to south and west to east, so a technician can see at
//                 a glance which of hundreds need attention. Each card is the
//                 last few days on one timeline: battery voltage on top,
//                 signal strength underneath, and a bar for every check report
//                 that never arrived. Its border says nominal, watch, act on
//                 or silent, and the trace that made it act on is drawn red.
//
// After core.js (esc, escAttr, termHtml, announce, state), health-analysis.js
// and health.js (Health.select, which a card's chart opens the station in);
// before init.js. All of it at call time, so its place among the modules is
// free (`npm run toplevel`). Nothing runs at load: health.js's bodyHtml()
// places render() and afterRender() calls mount().
//
// ── Where the numbers come from ──────────────────────────────────────────────
// Nothing is fetched here. Station Health has already read the window's
// readings and worked them out (HealthAnalysis.run): each station's learned
// check schedule and its slots, its battery series and overnight lows, every
// transmission and how strongly each copy of it was heard. The cards draw that
// analysis, so they cost the database nothing beyond what the tab already
// reads (CLAUDE.md, *Querying the live database*).
//
// The bands come from the same findings as Needs attention: a power finding
// (battery critical, low, falling, not charging) sets the battery's band, a
// check-signal finding (silent, missed checks, frames lost) the checks' —
// critical is act on, a warning is watch. Signal strength has no finding of its
// own yet, so its lines are this module's: a median weaker than −100 dBm is
// watch, −105 dBm act on, provisional until they are agreed. A level in dBFS
// (a receiver that reports audio level, not RSSI) is drawn but not banded.
//
// ── The magnifier, and why rows and not a lens ───────────────────────────────
// The card under the pointer grows to 3×, the cards round it to 2×, the next
// ring to 1¼×. Only the rows near the pointer change height, and each row
// packs its own cards edge to edge — so nothing is left with a gap round it,
// and rows far away only get a little shorter. The focus is worked out from
// where the pointer is on the undistorted grid, and each side of the focus
// shares out only its own space, so the card under the pointer stays under it
// and the grid does not chase the pointer about. It can be turned off.
//
// Cards are positioned by custom properties (--x --y --w --h) and drawn in a
// fixed viewBox with non-scaling strokes, so a move of the magnifier sets four
// numbers on each card and redraws nothing.
//
// The pure parts (weights, geoRows, fitGrid, bandsOf, signalOf) take plain
// values, for test/health-cards.mjs.
//
// Exposes: HealthCards.

const HealthCards = (() => {
  const DAY = 86400000, HOUR = 3600000, MIN = 60000;
  const NEAR = [3, 2, 1.25];        // the magnifier: focus, next ring, the ring after
  const SPANS = [2, 4, 7, 14];      // days a card shows, out of the window loaded
  const ZOOM_MAX = 4;
  const RATIO = 1.35;               // a card's width to its height, at Fit all
  const SIG_WATCH = -100, SIG_ACT = -105;   // dBm, provisional (see the header)
  const V_LO = 11.4, V_HI = 14.4;           // the cards' battery scale, volts
  const R_LO = -120, R_HI = -60;            // the cards' signal scale, dBm
  const VB = 1000;                  // a card's plot is 0..VB across, 0..100 down
  const BAND_WORD = { ok: 'Nominal', watch: 'Watch', act: 'Act on', silent: 'Silent' };
  const STORE = 'mn-hc';

  // What the words on the cards mean: the legend's hover and the fold below
  // the cards, from one list.
  const WORDS = {
    hub: 'The Bureau field-maintenance area a station belongs to, as Flood-Net\'s hub layer places it. Some northern NSW stations are Brisbane Hub\'s.',
    ok: 'Nothing on the card is past a watch line: battery, check signals and signal strength all look as they should for the days shown.',
    watch: 'Something is heading the wrong way but has not reached its act-on line — a battery low or falling, a check or two missed, a weak signal. Station Health\'s own findings decide battery and checks.',
    act: 'Past the line: plan a visit or a check. The trace that put it there is drawn red; the card under the pointer, and its chart, say why in words.',
    silent: 'Nothing heard from the station: Station Health found it silent, or it was expected and not heard at all in the window.',
    check: 'The report a station sends on a schedule even when nothing is happening, so we know it is alive. Flood-Net learns each station\'s schedule from what arrives — most are every 3 hours.',
    miss: 'A check report that never arrived, while a receiver that hears the station was listening.',
    partial: 'The check arrived, but some of its sensors\' frames were lost on the way.',
    unknown: 'No receiver that hears the station was listening, so the check can\'t be counted either way.',
    rssi: 'Signal strength: how strongly the base station heard each report, in dBm. Closer to 0 is stronger; −110 dBm is near the limit. It is not signal-to-noise (SNR), how far the signal stands above the background noise. Watch below −100 dBm, act on below −105 dBm — provisional lines.',
    night: 'Solar night, 6 pm to 6 am at the station: the battery runs on its own, so the overnight low is the number that matters.',
    mag: 'Grows the card under the pointer to 3×, the cards next to it to 2× and the next ones to 1¼×, so more of it can be read without clicking.',
    traffic: 'The bars on the right-hand axis: how many messages the base stations that hear this station picked up from anyone in each check-signal period — a busy network can crowd a check out. Counted from the hourly totals of what Flood-Net\'s base stations heard, so it is in whole hours.',
    offslot: 'A battery reading heard more than 30 minutes from any check slot. It is probably not this station\'s own scheduled check but another transmission or one delayed in a busy network, so it is drawn hollow and, by default, left out of the line.',
    snr: 'Signal-to-noise ratio, in dB: how far the signal stood above the background noise at the base station that heard it best. Bigger is better — 10 dB is marginal, 20 dB or more is comfortable. Only receivers that report a noise floor give one; a station without it shows no line.',
    size: '− and + (or Ctrl + scroll over the cards) make every card smaller or bigger; Fit all puts them all on the screen again.',
  };
  const GLOSSARY = [['hub', 'Maintenance hub'], ['ok', 'Nominal'], ['watch', 'Watch'], ['act', 'Act on'], ['silent', 'Silent'],
                    ['check', 'Check signal'], ['miss', 'Missed check'], ['partial', 'Frames lost'], ['unknown', 'Not listening'],
                    ['rssi', 'Signal strength'], ['night', 'Night'], ['mag', 'Magnifier'], ['size', 'Card size'], ['traffic', 'Network traffic'], ['snr', 'Signal-to-noise (SNR)']];

  const C = {
    A: null, demo: false, hub: null, span: 4, zoom: 1, mag: true,
    cards: [], G: null, focus: null, open: null, hov: null,
    els: [], raf: 0, ro: null, wheel: null, loaded: false,
  };

  // ── 1. pure ────────────────────────────────────────────────────────────────

  // Fisheye weights along a line of n cells, summing to n: near[0] for the
  // focus f, near[1] and near[2] either side. Each side shares out only its
  // own space, so the focus stays centred where its cell was; near an edge the
  // in-between sizes give way first, and no cell goes much below 0.35.
  function weights(n, f, near) {
    const w = [];
    if (f == null || n <= 0) { for (let i = 0; i < n; i++) w.push(1); return w; }
    f = Math.max(0, Math.min(n - 1, f));
    const ext = (near[0] - 1) / 2;
    const side = (dir, count) => {
      let nearN = 0;
      for (let d = 1; d <= 2; d++) { const j = f + dir * d; if (j >= 0 && j < n) nearN++; }
      const far = count - nearN, room = count - ext;
      const nearSum = (nearN >= 1 ? near[1] : 0) + (nearN >= 2 ? near[2] : 0);
      const forFar = Math.max(far * 0.35, room - nearSum);
      const forNear = Math.max(nearN * 0.6, room - forFar);
      const s = nearSum ? forNear / nearSum : 1;
      return { 1: near[1] * s, 2: near[2] * s, k: far ? Math.max(0.35, (room - nearSum * s) / far) : 1 };
    };
    const L = side(-1, f), R = side(1, n - 1 - f);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(i - f), S = i < f ? L : R;
      w.push(d === 0 ? near[0] : d <= 2 ? S[d] : S.k);
    }
    const tot = w.reduce((a, b) => a + b, 0);
    return w.map(x => x * n / tot);
  }

  // Rows of `cols`, north to south; each row west to east. Items: {lat, lon}.
  // → [[index…], …]
  function geoRows(items, cols) {
    const has = i => isFinite(items[i].lat) && isFinite(items[i].lon);
    const order = items.map((_, i) => i).sort((a, b) =>
      (has(b) - has(a)) || ((items[b].lat || 0) - (items[a].lat || 0)));
    const rows = [];
    for (let i = 0; i < order.length; i += cols) {
      rows.push(order.slice(i, i + cols).sort((a, b) => (items[a].lon || 0) - (items[b].lon || 0)));
    }
    return rows;
  }

  // The card size that fits n cards in W × H at about RATIO wide to high; then
  // `zoom` times bigger, with whole columns across W and rows running on past H.
  function fitGrid(n, W, H, zoom) {
    let best = null;
    for (let c = 1; c <= 120; c++) {
      const rows = Math.ceil(n / c), cw = W / c, rh = H / rows;
      const sc = Math.min(cw / RATIO, rh);
      if (!best || sc > best.sc) best = { cw, rh: Math.min(rh, cw / 0.9), sc };
    }
    const ratio = best.rh / best.cw;
    const cols = Math.max(1, Math.min(n || 1, Math.floor(W / (best.cw * (zoom || 1)) + 1e-6)));
    const cw = W / cols;
    return { cols, cw, rh: cw * ratio, rows: Math.ceil(n / cols) };
  }

  // A station's signal over [a, b): for each transmission, the strongest copy
  // heard. → { pts: [{t, v}], unit, med }
  function signalOf(txs, a, b) {
    const pts = [];
    let unit = null;
    (txs || []).forEach(tx => {
      if (tx.t < a || tx.t >= b) return;
      let best = null;
      (tx.copies || []).forEach(c => {
        if (c.lvl == null || !isFinite(c.lvl)) return;
        if (best == null || c.lvl > best) { best = c.lvl; unit = unit || c.lvlUnit || null; }
      });
      if (best != null) pts.push({ t: tx.t, v: best });
    });
    pts.sort((p, q) => p.t - q.t);
    const vs = pts.map(p => p.v).sort((x, y) => x - y);
    return { pts, unit, med: vs.length ? vs[Math.floor(vs.length / 2)] : null };
  }

  // The best signal-to-noise (dB) of each transmission's copies. Not every
  // receiver reports one, so the list can be empty.
  function snrOf(txs, a, b) {
    const pts = [];
    (txs || []).forEach(tx => {
      if (tx.t < a || tx.t >= b) return;
      let best = null;
      (tx.copies || []).forEach(c => { if (c.snr != null && isFinite(c.snr) && (best == null || c.snr > best)) best = c.snr; });
      if (best != null) pts.push({ t: tx.t, v: best });
    });
    pts.sort((p, q) => p.t - q.t);
    const top = pts.reduce((m, p) => Math.max(m, p.v), 0);
    return { pts, hi: Math.min(60, Math.max(30, Math.ceil(top / 10) * 10)) };
  }

  // The card's band and why. findings: the station's own (Station Health's);
  // sig: signalOf()'s; silent: expected and not heard at all.
  // → { band, battRed, sigRed, reasons: [{b, k, t}] }
  function bandsOf(findings, sig, silent) {
    const reasons = [];
    const live = (findings || []).filter(f => f.severity === 'critical' || f.severity === 'warn');
    const bandOf = f => (f.severity === 'critical' ? 'act' : 'watch');
    let battRed = false, sigRed = false, isSilent = !!silent;
    live.forEach(f => {
      const cat = f.category || '';
      if (cat === 'power') {
        if (f.severity === 'critical') battRed = true;
        reasons.push({ b: bandOf(f), k: 'Battery', t: f.title });
      } else if (cat === 'comms') {
        if (f.kind === 'silent') isSilent = true;
        reasons.push({ b: bandOf(f), k: f.kind === 'silent' || f.kind === 'silent-spell' ? 'Silent' : 'Checks', t: f.title });
      }
    });
    if (silent && !reasons.length) reasons.push({ b: 'act', k: 'Silent', t: 'Expected and not heard at all in the window' });
    if (sig && sig.med != null && (sig.unit || 'dBm') === 'dBm') {
      const m = Math.round(sig.med);
      if (sig.med < SIG_ACT) { sigRed = true; reasons.push({ b: 'act', k: 'Signal', t: `Typically ${fmtNeg(m)} dBm — weaker than ${fmtNeg(SIG_ACT)} dBm` }); }
      else if (sig.med < SIG_WATCH) reasons.push({ b: 'watch', k: 'Signal', t: `Typically ${fmtNeg(m)} dBm — weaker than ${fmtNeg(SIG_WATCH)} dBm` });
    }
    reasons.sort((x, y) => (y.b === 'act') - (x.b === 'act'));
    const band = isSilent ? 'silent' : reasons.some(r => r.b === 'act') ? 'act' : reasons.length ? 'watch' : 'ok';
    return { band, battRed, sigRed, reasons };
  }

  function fmtN(v) { return Number(v).toLocaleString('en-AU'); }
  function fmtNeg(v) { return String(v).replace('-', '−'); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── 2. the cards' models ───────────────────────────────────────────────────

  function hubName(id) {
    const h = ((state.data && state.data.hubs) || []).find(x => x.id === id);
    return h ? h.name : id ? id.charAt(0).toUpperCase() + id.slice(1) + ' Hub' : 'No hub';
  }

  // Every station the analysis knows, heard or expected, with its hub.
  function everyStation(A) {
    const out = [];
    A.stations.forEach(S => out.push({ st: S.st, S }));
    (A.notHeard || []).forEach(n => { if (n.st && !A.stations.has(n.st.id)) out.push({ st: n.st, S: null }); });
    return out;
  }

  function hubsOf(A) {
    const n = new Map();
    everyStation(A).forEach(x => { const h = x.st.hub_id || ''; n.set(h, (n.get(h) || 0) + 1); });
    return [...n.entries()].map(([id, count]) => ({ id, name: id ? hubName(id) : 'No hub', count }))
      .sort((a, b) => b.count - a.count);
  }

  function windowDays(A) { return Math.max(1, Math.round((A.t1 - A.t0) / DAY)); }
  function spanOf(A) { const a = Math.max(A.t0, A.t1 - C.span * DAY); return { a, b: A.t1 }; }

  // Solar night (6 pm – 6 am at the station's longitude) across [a, b), as
  // [from, to] pairs.
  function nightsOf(lon, a, b) {
    const off = (isFinite(lon) ? lon : 150) / 15 * HOUR;
    const out = [];
    const day0 = Math.floor((a + off) / DAY) - 1;
    for (let d = day0; d * DAY - off < b + DAY; d++) {
      const from = d * DAY + 18 * HOUR - off, to = from + 12 * HOUR;
      if (to > a && from < b) out.push([Math.max(a, from), Math.min(b, to)]);
    }
    return out;
  }

  function cardOf(x, A) {
    const { st, S } = x;
    const { a, b } = spanOf(A);
    const slots = S && S.slots ? S.slots.filter(sl => sl.t >= a && sl.t < b) : [];
    const batt = S && S.battery && S.battery.series ? S.battery.series.filter(p => p.t >= a && p.t < b) : [];
    const sig = signalOf(S ? S.txs : [], a, b);
    const snr = snrOf(S ? S.txs : [], a, b);
    const findings = S ? S.findings : [];
    const J = bandsOf(findings, sig, !S);
    const P = S && S.schedule ? S.schedule.P : null;
    const counts = { due: 0, got: 0, miss: 0, part: 0 };
    slots.forEach(sl => {
      if (sl.outcome === 'unknown') return;
      counts.due++;
      if (sl.outcome === 'hit' || sl.outcome === 'partial') counts.got++;
      if (sl.outcome === 'partial') counts.part++;
      if (sl.outcome === 'miss' || sl.outcome === 'net') counts.miss++;
    });
    const lows = S && S.battery && S.battery.nights ? S.battery.nights.filter(n => n.t >= a && n.t < b) : [];
    if (!J.reasons.length) {
      const bits = [];
      if (lows.length) bits.push(`overnight low ${lows[lows.length - 1].v.toFixed(2)} V`);
      if (counts.due) bits.push(`${counts.got} of ${counts.due} checks in`);
      if (sig.med != null) bits.push(`signal ${fmtNeg(Math.round(sig.med))} ${sig.unit || 'dBm'}`);
      J.reasons.push({ b: 'ok', k: 'Nominal', t: bits.length ? bits.join(', ') : 'nothing past a watch line' });
    }
    return { id: st.id, st, S, a, b, slots, batt, sig, snr, lows, P, counts, others: (findings || []).filter(f => f.severity !== 'info' && f.category !== 'power' && f.category !== 'comms'), ...J };
  }

  function build() {
    const A = C.A;
    if (!A) { C.cards = []; return; }
    const hubs = hubsOf(A);
    if (!C.hub || !hubs.some(h => h.id === C.hub)) C.hub = hubs.length ? hubs[0].id : '';
    const days = windowDays(A);
    if (C.span > days) C.span = SPANS.filter(s => s <= days).pop() || days;
    C.cards = everyStation(A).filter(x => (x.st.hub_id || '') === C.hub).map(x => cardOf(x, A));
  }

  // ── 3. drawing a card ──────────────────────────────────────────────────────

  function xOf(t, a, b) { return ((t - a) / (b - a)) * VB; }
  function linePath(pts, a, b, y0, h, lo, hi, gapMs) {
    let d = '', prev = null;
    pts.forEach(p => {
      const x = xOf(p.t, a, b), y = y0 + h - ((clamp(p.v, lo, hi) - lo) / (hi - lo)) * h;
      d += (prev != null && p.t - prev <= gapMs ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      prev = p.t;
    });
    return d || 'M0 0';
  }
  function barsPath(slots, want, P, a, b, y0, h) {
    let d = '';
    const w = Math.max(2, ((P || 3 * HOUR) / (b - a)) * VB * 0.8);
    slots.forEach(sl => {
      if (!want.includes(sl.outcome)) return;
      const x = xOf(sl.t, a, b) - w / 2;
      d += `M${x.toFixed(1)} ${y0}h${w.toFixed(1)}v${h}h${(-w).toFixed(1)}Z `;
    });
    return d || 'M0 0';
  }
  function nightPath(lon, a, b, y0, h) {
    return nightsOf(lon, a, b).map(([f, t]) => {
      const x0 = xOf(f, a, b), x1 = xOf(t, a, b);
      return `M${x0.toFixed(1)} ${y0}H${x1.toFixed(1)}V${y0 + h}H${x0.toFixed(1)}Z`;
    }).join(' ') || 'M0 0';
  }
  function gapOf(c) { return Math.max(2 * (c.P || 3 * HOUR), 4 * HOUR); }

  function cardHtml(c, i) {
    const word = BAND_WORD[c.band];
    const why = c.reasons.map(r => `<span class="hc-why-line hc-why--${r.b}"><b>${esc(r.k)}</b> ${esc(r.t)}</span>`).join('');
    const label = `${c.st.name}: ${word}. ${c.reasons.map(r => `${r.k}: ${r.t}`).join('. ')}. Open its chart.`;
    return `<button type="button" class="hc-card hc-card--${c.band}" data-i="${i}" aria-label="${escAttr(label)}">
      <span class="hc-top"><span class="hc-name">${esc(c.st.name)}</span><span class="hc-chip hc-chip--${c.band}" title="${escAttr(`${word}: ${WORDS[c.band] || ''}`)}">${esc(word)}</span></span>
      <svg class="hc-plot" viewBox="0 0 ${VB} 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path class="hc-night" d="${nightPath(c.st.lon, c.a, c.b, 0, 100)}"/>
        <path class="hc-s-unknown" d="${barsPath(c.slots, ['unknown'], c.P, c.a, c.b, 0, 100)}"/>
        <path class="hc-s-partial" d="${barsPath(c.slots, ['partial'], c.P, c.a, c.b, 0, 100)}"/>
        <path class="hc-s-miss" d="${barsPath(c.slots, ['miss', 'net'], c.P, c.a, c.b, 0, 100)}"/>
        <path class="hc-mid" d="M0 50H${VB}"/>
        <path class="hc-batt${c.battRed ? ' hc-red' : ''}" d="${linePath(c.batt.map(p => ({ t: p.t, v: p.V })), c.a, c.b, 3, 44, V_LO, V_HI, gapOf(c))}"/>
        <path class="hc-sig${c.sigRed ? ' hc-red' : ''}" d="${linePath(c.sig.pts, c.a, c.b, 54, 43, c.sig.unit === 'dBFS' ? -60 : R_LO, c.sig.unit === 'dBFS' ? 0 : R_HI, gapOf(c))}"/>
      </svg>
      <span class="hc-why">${why}</span>
    </button>`;
  }

  // ── 4. the panel ───────────────────────────────────────────────────────────

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (s.hub) C.hub = s.hub;
      if (SPANS.includes(s.span)) C.span = s.span;
      if (s.mag === false) C.mag = false;
    } catch { /* storage refused: defaults */ }
    C.loaded = true;
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ hub: C.hub, span: C.span, mag: C.mag })); } catch { /* fine */ }
  }

  function countsText() {
    const n = b => C.cards.filter(c => c.band === b).length;
    return `${C.cards.length.toLocaleString()} stations · ${n('act')} act on · ${n('watch')} watch · ${n('ok')} nominal · ${n('silent')} silent`;
  }

  function render(A, opts) {
    if (!C.loaded) load();
    C.A = A || null;
    C.demo = !!(opts && opts.demo);
    build();
    if (!A) return '';
    const hubs = hubsOf(A), days = windowDays(A);
    const t = (k, w) => termHtml(w, WORDS[k]);
    const sw = (cls, k, w) => `<span class="hc-key"><i class="hc-sw ${cls}" aria-hidden="true"></i>${t(k, w)}</span>`;
    return `
      <div class="panel-header"><h3 id="hc-h">Station cards</h3>
        <span class="small" id="hc-count">${esc(countsText())}</span></div>
      <p class="sub hc-sub">Every station in a ${t('hub', 'maintenance hub')} as a card, north to south and west to east, over the last
        ${C.span} days: battery voltage on top, ${t('rssi', 'signal strength')} underneath, and a bar for every ${t('check', 'check signal')} that went missing.
        Point at a card to magnify it and see why it is marked; click it for its chart.${C.demo ? ' These are the demo week\'s made-up readings.' : ''}</p>
      <div class="hc-tools" role="toolbar" aria-label="Station cards">
        <label class="hc-hub">${t('hub', 'Maintenance hub')}
          <select id="hc-hub" onchange="HealthCards.setHub(this.value)">
            ${hubs.map(h => `<option value="${escAttr(h.id)}"${h.id === C.hub ? ' selected' : ''}>${esc(h.name)} (${h.count.toLocaleString()})</option>`).join('')}
          </select></label>
        <span class="hl-seg" role="group" aria-label="Days on each card">
          ${SPANS.map(s => `<button class="hl-chip${C.span === s ? ' hl-chip--on' : ''}" aria-pressed="${C.span === s}"${s > days ? ` disabled title="Load ${s} days or more above first"` : ''}
            onclick="HealthCards.setSpan(${s})">${s} days</button>`).join('')}
        </span>
        <span class="hc-zoom" role="group" aria-label="${escAttr('Card size: ' + WORDS.size)}">
          <button onclick="HealthCards.zoomBy(-1)" aria-label="Smaller cards">−</button>
          <button onclick="HealthCards.zoomBy(0)" id="hc-zoom-txt" aria-label="Fit every card on the screen">${zoomText()}</button>
          <button onclick="HealthCards.zoomBy(1)" aria-label="Bigger cards">+</button>
        </span>
        <button class="hl-chip${C.mag ? ' hl-chip--on' : ''}" id="hc-mag" aria-pressed="${C.mag}" onclick="HealthCards.toggleMag()" title="${escAttr(WORDS.mag)}">Magnifier ${C.mag ? 'on' : 'off'}</button>
        <button onclick="HealthCards.fullscreen()" title="The cards on the whole screen; Esc comes back">Full screen</button>
      </div>
      <div class="hc-legend small">
        <span class="hc-key"><i class="hc-ln hc-ln--batt" aria-hidden="true"></i>battery (V)</span>
        <span class="hc-key"><i class="hc-ln hc-ln--sig" aria-hidden="true"></i>${t('rssi', 'signal strength')} (dBm)</span>
        <span class="hc-key"><i class="hc-ln hc-ln--red" aria-hidden="true"></i>the trace that makes it act on</span>
        ${sw('hc-sw--miss', 'miss', 'missed check')}${sw('hc-sw--partial', 'partial', 'frames lost')}${sw('hc-sw--night', 'night', 'night')}
        ${sw('hc-sw--ok', 'ok', 'nominal')}${sw('hc-sw--watch', 'watch', 'watch')}${sw('hc-sw--act', 'act', 'act on')}${sw('hc-sw--silent', 'silent', 'silent')}
      </div>
      <div id="hc-grid" class="hc-grid" role="region" aria-label="Station cards, north to south and west to east" tabindex="0">
        <div id="hc-inner" class="hc-inner"></div>
        ${C.cards.length ? '' : '<p class="small hc-empty">No stations in this hub were heard or expected in the window.</p>'}
      </div>
      <details class="hc-words"><summary>What the words on these cards mean</summary>
        <dl>${GLOSSARY.map(([k, w]) => `<div><dt>${esc(w)}</dt><dd>${esc(WORDS[k])}</dd></div>`).join('')}</dl>
      </details>
      <dialog id="hc-dialog" class="hc-dialog" aria-label="A station's chart"></dialog>`;
  }

  function zoomText() { return C.zoom <= 1.001 ? 'Fit all' : Math.round(C.zoom * 100) + '%'; }

  // ── 5. placing the cards ───────────────────────────────────────────────────

  function mount() {
    const grid = document.getElementById('hc-grid'), inner = document.getElementById('hc-inner');
    if (!grid || !inner) return;
    inner.innerHTML = gridHtml();
    C.els = [...inner.querySelectorAll('.hc-card')];
    if (C.ro) C.ro.disconnect();
    if (typeof ResizeObserver !== 'undefined') { C.ro = new ResizeObserver(() => relayout()); C.ro.observe(grid); }
    grid.addEventListener('pointermove', onMove);
    grid.addEventListener('pointerleave', () => setFocus(null));
    grid.addEventListener('click', onClick);
    C.wheel = e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(C.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    grid.addEventListener('wheel', C.wheel, { passive: false });
    relayout();
  }

  // The cards in their geographic order: north to south in rows, west to east
  // along each. Written once; a zoom or a resize only moves them.
  function gridHtml() {
    if (!C.cards.length) return '';
    return C.cards.map((c, i) => cardHtml(c, i)).join('');
  }

  function relayout() {
    const grid = document.getElementById('hc-grid'), inner = document.getElementById('hc-inner');
    if (!grid || !inner || !C.cards.length) return;
    const W = Math.max(120, grid.clientWidth - 2), H = Math.max(160, grid.clientHeight - 2);
    const g = fitGrid(C.cards.length, W, H, C.zoom);
    const rows = geoRows(C.cards.map(c => ({ lat: c.st.lat, lon: c.st.lon })), g.cols);
    const cell = new Array(C.cards.length);
    rows.forEach((row, r) => row.forEach((i, col) => { cell[i] = { r, c: col }; }));
    C.G = { ...g, W, rows, cell };
    if (C.focus && (C.focus.r >= rows.length)) C.focus = null;
    // One wrapper a row, so that a row far from the pointer is one write (its
    // top and height) and not one per card. Moving cards into new wrappers
    // drops the focus a keyboard user had on one: put it back.
    const had = document.activeElement && C.els.includes(document.activeElement) ? document.activeElement : null;
    inner.textContent = '';
    C.rowEls = rows.map(row => {
      const el = document.createElement('div');
      el.className = 'hc-row';
      row.forEach(i => { if (C.els[i]) el.appendChild(C.els[i]); });
      inner.appendChild(el);
      return el;
    });
    C.els.forEach(el => { el._hc = null; });
    C.rowSet = rows.map(() => null);
    if (had) had.focus({ preventScroll: true });
    place();
  }

  // Writes a custom property only when its value has changed since the last
  // write — a style write the browser has to look at is the cost here, not
  // the arithmetic.
  function setVar(el, k, v) {
    const m = el._v || (el._v = {});
    if (m[k] === v) return;
    m[k] = v;
    el.style.setProperty(k, v);
  }

  function place() {
    const G = C.G, inner = document.getElementById('hc-inner');
    if (!G || !inner || !C.rowEls) return;
    const f = C.mag ? C.focus : null;
    const wr = weights(G.rows.length, f ? f.r : null, NEAR);
    const tops = [0];
    for (let r = 0; r < G.rows.length; r++) tops.push(tops[r] + wr[r] * G.rh);
    setVar(inner, '--hc-h', tops[G.rows.length].toFixed(0) + 'px');
    G.rows.forEach((row, r) => {
      const dr = f ? Math.abs(r - f.r) : 99;
      const rowEl = C.rowEls[r];
      setVar(rowEl, '--hc-ry', tops[r].toFixed(1) + 'px');
      setVar(rowEl, '--hc-rh', (wr[r] * G.rh - 3).toFixed(1) + 'px');
      // Rows the magnifier does not reach are an even row, which is the same
      // as it was a moment ago: skip them once they have been placed so.
      const key = dr <= 2 ? 'f' + f.c + ':' + dr : 'even' + (wr[r] * G.rh - 3 < 22 ? ':tiny' : '');
      rowEl.classList.toggle('hc-row--anim', dr <= 3);
      if (dr > 2 && C.rowSet[r] === key) return;
      C.rowSet[r] = key;
      const ws = dr <= 2 ? weights(row.length, f.c, [NEAR[dr], NEAR[Math.max(dr, 1)], NEAR[Math.max(dr, 2)]]) : weights(row.length, null, NEAR);
      const h = wr[r] * G.rh - 3;
      let x = 0;
      row.forEach((i, col) => {
        const el = C.els[i];
        if (!el) return;
        const w = ws[col] * G.cw - 3;
        const d = f ? Math.max(dr, Math.abs(col - f.c)) : 99;
        setVar(el, '--x', x.toFixed(1) + 'px');
        setVar(el, '--w', w.toFixed(1) + 'px');
        const size = d === 0 && h >= 54 && w >= 90 ? 'big' : d === 1 && h >= 44 && w >= 80 ? 'mid' : h < 22 || w < 34 ? 'tiny' : '';
        const cls = size + (d === 0 ? ' focus' : '');
        if (el._hc !== cls) {
          el._hc = cls;
          el.classList.toggle('hc-card--big', size === 'big');
          el.classList.toggle('hc-card--mid', size === 'mid');
          el.classList.toggle('hc-card--tiny', size === 'tiny');
          el.classList.toggle('hc-card--focus', d === 0);
        }
        x += ws[col] * G.cw;
      });
    });
  }

  function onMove(e) {
    if (!C.mag || !C.G) return;
    const inner = document.getElementById('hc-inner');
    if (!inner) return;
    const b = inner.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    const G = C.G;
    const r = clamp(Math.floor(y / G.rh), 0, G.rows.length - 1);
    const c = clamp(Math.floor(x / G.cw), 0, G.rows[r].length - 1);
    if (!C.focus || C.focus.r !== r || C.focus.c !== c) setFocus({ r, c });
  }
  function setFocus(f) {
    if (!f && !C.focus) return;
    C.focus = f;
    if (C.raf) return;
    C.raf = requestAnimationFrame(() => { C.raf = 0; place(); });
  }
  function onClick(e) {
    const el = e.target.closest && e.target.closest('.hc-card');
    if (!el) return;
    openChart(Number(el.dataset.i), el);
  }

  // ── 6. the controls ────────────────────────────────────────────────────────

  function repaint() {
    const box = document.getElementById('hc-panel');
    if (!box || !C.A) return;
    box.innerHTML = render(C.A, { demo: C.demo });
    mount();
  }
  function setHub(id) { C.hub = id; C.focus = null; C.zoom = 1; save(); repaint(); announce(`${hubName(id)}: ${countsText()}.`); }
  function setSpan(d) { C.span = d; save(); repaint(); }
  function setZoom(z) {
    C.zoom = clamp(z, 1, ZOOM_MAX);
    C.focus = null;
    const t = document.getElementById('hc-zoom-txt');
    if (t) t.textContent = zoomText();
    relayout();
  }
  function zoomBy(dir) { setZoom(dir === 0 ? 1 : C.zoom * (dir > 0 ? 1.4 : 1 / 1.4)); }
  function toggleMag() {
    C.mag = !C.mag; C.focus = null; save();
    const b = document.getElementById('hc-mag');
    if (b) { b.setAttribute('aria-pressed', String(C.mag)); b.classList.toggle('hl-chip--on', C.mag); b.textContent = 'Magnifier ' + (C.mag ? 'on' : 'off'); }
    place();
  }
  function fullscreen() {
    const box = document.getElementById('hc-panel');
    if (!box) return;
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (box.requestFullscreen) box.requestFullscreen().catch(() => {});
  }

  // ── 7. a card's chart ──────────────────────────────────────────────────────

  const CH = { W: 1060, L: 62, L2: 108, R: 54, BY: 26, BH: 160, KY: 214, KH: 26, SY: 268, SH: 160 };

  function fmtTime(t) {
    return new Date(t).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(t) { return new Date(t).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); }

  // ── network traffic near the station ───────────────────────────────────────
  // Bars on the signal panel's right-hand axis: what the base stations that hear
  // this station picked up, from anybody, in each check-signal period. Read from
  // telemetry_traffic(), the public hourly roll-up (never the raw receptions),
  // once for the window and kept ten minutes. An hour is the finest it goes, so
  // a check every hour or more often is shown by the hour, and a longer period
  // adds up the hours it covers (a part-hour counted in proportion).
  const T = { rows: null, at: 0, days: 0, ask: null };
  const T_MS = 10 * MIN;
  async function trafficRows(days) {
    if (T.rows && T.days >= days && Date.now() - T.at < T_MS) return T.rows;
    if (T.ask && T.askDays >= days) return T.ask;
    T.askDays = days;
    T.ask = (async () => {
      const raw = await dbRpc('telemetry_traffic', { p_days: days, p_hourly: true });
      const cols = (raw && raw.cols) || [];
      const ti = cols.indexOf('t'), bi = cols.indexOf('base'), ni = cols.indexOf('n');
      const by = new Map();
      ((raw && raw.rows) || []).forEach(r => {
        const name = String(r[bi] || ''), t = Number(r[ti]) * 1000, n = Number(r[ni]) || 0;
        if (!name || !isFinite(t)) return;
        let m = by.get(name); if (!m) by.set(name, m = new Map());
        m.set(t, (m.get(t) || 0) + n);
      });
      T.rows = by; T.at = Date.now(); T.days = days;
      return by;
    })().finally(() => { T.ask = null; });
    return T.ask;
  }
  // The base stations that heard the station in the window, by name.
  function hearers(c) {
    const names = new Set();
    const SV = typeof SensorValues !== 'undefined' ? SensorValues : null;
    ((c.S && c.S.txs) || []).forEach(tx => {
      if (tx.t < c.a || tx.t >= c.b) return;
      (tx.copies || []).forEach(cp => {
        const at = SV && cp.host ? SV.baseOf(cp.host) : null;
        if (at && at.name) names.add(at.name);
      });
    });
    return [...names];
  }
  // → { bins: [{ t0, t1, mid, n }], max, names, hourly } — pure, for the check.
  function trafficBins(byBase, names, slots, P, a, b) {
    const hours = new Map();
    names.forEach(nm => { const m = byBase.get(nm); if (m) m.forEach((n, t) => hours.set(t, (hours.get(t) || 0) + n)); });
    const per = Math.max(P || 3 * HOUR, HOUR), hourly = !P || P <= HOUR;
    const spans = hourly
      ? (() => { const out = []; for (let t = Math.ceil(a / HOUR) * HOUR; t + HOUR <= b; t += HOUR) out.push([t, t + HOUR, t + HOUR / 2]); return out; })()
      : slots.map(sl => [sl.t - per / 2, sl.t + per / 2, sl.t]);
    const bins = spans.map(([t0, t1, mid]) => {
      let n = 0;
      hours.forEach((v, t) => { const o = Math.min(t1, t + HOUR) - Math.max(t0, t); if (o > 0) n += v * (o / HOUR); });
      return { t0, t1, mid, n: Math.round(n) };
    });
    const top = Math.max(0, ...bins.map(x => x.n));
    const mag = Math.pow(10, Math.floor(Math.log10(top || 1))), f = top / mag;
    const max = Math.max(5, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag);
    return { bins, max, names, hourly };
  }
  async function loadTraffic(c) {
    if (c.traffic !== undefined || C.demo || !c.S || typeof dbRpc !== 'function') return;
    c.traffic = null;
    try {
      if (typeof SensorValues !== 'undefined') await SensorValues.loadBases();
      const names = hearers(c);
      if (!names.length) { c.traffic = { bins: [], max: 0, names, none: true }; return; }
      const days = clamp(Math.ceil((Date.now() - c.a) / DAY) + 1, 1, 14);
      const by = await trafficRows(days);
      c.traffic = trafficBins(by, names, c.slots, c.P, c.a, c.b);
    } catch (_) { c.traffic = { bins: [], max: 0, names: [], failed: true }; }
    const i = C.cards.indexOf(c);
    if (C.open === i) drawPlot(c);
  }

  // Which traces the signal panel draws. A level in dBFS is the same shape as
  // the signal-to-noise over the receiver's noise floor, so where there is an
  // SNR the dBFS trace is left off (asked 25 Nov 2026). An RSSI in dBm is a
  // different measure and stays beside it, on its own axis. The left margin
  // holds two axes only when two are drawn.
  function panelOf(c) {
    const snrOn = c.snr.pts.length > 0;
    const dbfs = c.sig.unit === 'dBFS';
    const sigOn = !(dbfs && snrOn) && (c.sig.pts.length > 0 || !snrOn);
    return { snrOn, sigOn, dbfs, two: sigOn && snrOn, L: sigOn && snrOn ? CH.L2 : CH.L };
  }
  // A battery report that lands well away from every check slot is probably not
  // this station's scheduled check: more likely another transmission, or one
  // heard late or garbled in a busy network. Within 30 minutes of a slot (less
  // for stations that check very often) counts as on schedule.
  function offSlot(c, t) {
    if (!c.P || !c.slots.length) return false;
    return !nearest(c.slots, t, Math.min(30 * MIN, c.P / 4));
  }
  function checkOnlyOn(c) { return C.checkOnly !== false && !!c.P && c.slots.length > 0; }
  function chartSvg(c) {
    const PN = panelOf(c);
    const { W, R, BY, BH, KY, KH, SY, SH } = CH, L = PN.L, PW = W - L - R;
    const x = t => L + ((t - c.a) / (c.b - c.a)) * PW;
    const dbfs = PN.dbfs;
    const sLo = dbfs ? -60 : R_LO, sHi = dbfs ? 0 : R_HI;
    const yB = v => BY + BH - ((clamp(v, V_LO, V_HI) - V_LO) / (V_HI - V_LO)) * BH;
    const yS = v => SY + SH - ((clamp(v, sLo, sHi) - sLo) / (sHi - sLo)) * SH;
    const path = (pts, y) => { let d = '', prev = null; pts.forEach(p => { d += (prev != null && p.t - prev <= gapOf(c) ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1) + ' '; prev = p.t; }); return d || 'M0 0'; };
    // A dot on every data point, in this enlarged chart only: a line needs two
    // points joined, so a trace of one lone reading (or readings further apart
    // than the gap that breaks a line) would otherwise draw nothing and the
    // plot would look empty. One path of zero-length strokes with round caps,
    // so a few thousand points are one element.
    const dots = (pts, y) => pts.map(p => `M${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}h0.01`).join('') || 'M0 0';
    let grid = '', txt = '';
    [11.5, 12, 12.5, 13, 13.5, 14].forEach(v => { grid += `M${L} ${yB(v).toFixed(1)}H${L + PW} `; txt += `<text class="hc-ax" x="${L - 6}" y="${(yB(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(1)}</text>`; });
    if (PN.sigOn) (dbfs ? [-60, -45, -30, -15, 0] : [-120, -110, -100, -90, -80, -70, -60]).forEach(v => { grid += `M${L} ${yS(v).toFixed(1)}H${L + PW} `; txt += `<text class="hc-ax" x="${L - 6}" y="${(yS(v) + 4).toFixed(1)}" text-anchor="end">${fmtNeg(v)}</text>`; });
    let days = '';
    const d0 = new Date(c.a); d0.setHours(0, 0, 0, 0);
    for (let t = d0.getTime() + DAY; t < c.b; t += DAY) {
      if (t <= c.a) continue;
      days += `M${x(t).toFixed(1)} ${BY}V${SY + SH} `;
      if (x(t) > W - R - 70) continue;
      txt += `<text class="hc-ax hc-ax--day" x="${(x(t) + 4).toFixed(1)}" y="${SY + SH + 16}">${esc(fmtDay(t))}</text>`;
    }
    const nights = nightsOf(c.st.lon, c.a, c.b).map(([f, t]) => `M${x(f).toFixed(1)} ${BY}H${x(t).toFixed(1)}V${SY + SH}H${x(f).toFixed(1)}Z`).join(' ');
    const slotW = Math.max(3, ((c.P || 3 * HOUR) / (c.b - c.a)) * PW * 0.8);
    const bars = want => c.slots.filter(sl => want.includes(sl.outcome)).map(sl => `M${(x(sl.t) - slotW / 2).toFixed(1)} ${KY}h${slotW.toFixed(1)}v${KH}h${(-slotW).toFixed(1)}Z`).join(' ') || 'M0 0';
    const yN = v => SY + SH - (clamp(v, 0, c.snr.hi) / c.snr.hi) * SH;
    let snrSvg = '';
    if (PN.snrOn) {
      const ax = PN.two ? L - 48 : L - 6;
      for (let v = 0; v <= c.snr.hi; v += 10) {
        txt += `<text class="hc-ax hc-ax--snr" x="${ax}" y="${(yN(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
        if (!PN.two) grid += `M${L} ${yN(v).toFixed(1)}H${L + PW} `;
      }
      if (PN.two) txt += `<text class="hc-c-title hc-c-title--snr" x="${ax}" y="${SY - 9}" text-anchor="end">SNR (dB)</text>`;
      else txt += `<text class="hc-c-title hc-c-title--snr" x="${L}" y="${SY - 9}">Signal-to-noise (SNR, dB) — how far the signal stood above the noise</text>`;
      snrSvg = `<path class="hc-c-snr" d="${path(c.snr.pts, yN)}"/><path class="hc-c-dots hc-c-dots--snr" d="${dots(c.snr.pts, yN)}"/>`;
    }
    const TR = c.traffic && c.traffic.bins.length ? c.traffic : null;
    const yT = n => SY + SH - (n / TR.max) * SH;
    let trafficSvg = '';
    if (TR) {
      const bw = Math.max(3, (TR.hourly ? HOUR : (c.P || 3 * HOUR)) / (c.b - c.a) * PW * 0.8);
      const d = TR.bins.filter(b => b.n > 0).map(b => `M${(x(b.mid) - bw / 2).toFixed(1)} ${(SY + SH).toFixed(1)}V${yT(b.n).toFixed(1)}h${bw.toFixed(1)}V${(SY + SH).toFixed(1)}Z`).join(' ');
      trafficSvg = `<path class="hc-c-traffic" d="${d || 'M0 0'}"/>`;
      [0, 0.5, 1].forEach(f => { txt += `<text class="hc-ax hc-ax--r" x="${L + PW + 6}" y="${(yT(TR.max * f) + 4).toFixed(1)}">${fmtN(Math.round(TR.max * f))}</text>`; });
      txt += `<text class="hc-c-title hc-c-title--r" x="${L + PW}" y="${SY - 9}" text-anchor="end">Messages heard nearby (bars, right axis)</text>`;
    }
    c.geo = { x, yB, yS, yN };
    const battAll = c.batt.map(p => ({ t: p.t, v: p.V }));
    const battOn = battAll.filter(p => !offSlot(c, p.t)), battOff = battAll.filter(p => offSlot(c, p.t));
    const battLine = checkOnlyOn(c) ? battOn : battAll;
    const rings = (pts, y) => pts.map(p => { const px = x(p.t).toFixed(1), py = y(p.v).toFixed(1); return `M${(+px - 3.2).toFixed(1)} ${py}a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0`; }).join('') || 'M0 0';
    const ref = (y, cls) => `<path class="${cls}" d="M${L} ${y.toFixed(1)}H${L + PW}"/>`;
    return `<svg class="hc-chart" id="hc-chart" viewBox="0 0 ${W} ${SY + SH + 26}" role="img" tabindex="0"
        aria-label="${escAttr(`${c.st.name}: battery voltage, check signals and signal strength from ${fmtTime(c.a)} to ${fmtTime(c.b)}. Arrow keys step through the readings.`)}">
      <path class="hc-c-night" d="${nights || 'M0 0'}"/>
      <path class="hc-c-grid" d="${grid}"/><path class="hc-c-day" d="${days || 'M0 0'}"/>
      ${ref(yB(12.2), 'hc-c-watch')}${ref(yB(11.8), 'hc-c-act')}
      ${dbfs || !PN.sigOn ? '' : ref(yS(SIG_WATCH), 'hc-c-watch') + ref(yS(SIG_ACT), 'hc-c-act')}
      ${trafficSvg}
      <path class="hc-c-hit" d="${bars(['hit'])}"/><path class="hc-c-partial" d="${bars(['partial'])}"/>
      <path class="hc-c-miss" d="${bars(['miss', 'net'])}"/><path class="hc-c-unknown" d="${bars(['unknown'])}"/>
      <path class="hc-c-batt${c.battRed ? ' hc-red' : ''}" d="${path(battLine, yB)}"/>
      ${snrSvg}
      ${PN.sigOn ? `<path class="hc-c-sig${c.sigRed ? ' hc-red' : ''}" d="${path(c.sig.pts, yS)}"/>` : ''}
      <path class="hc-c-dots hc-c-dots--batt${c.battRed ? ' hc-red' : ''}" d="${dots(battOn, yB)}"/>
      <path class="hc-c-off${c.battRed ? ' hc-red' : ''}" d="${rings(battOff, yB)}"/>
      ${PN.sigOn ? `<path class="hc-c-dots hc-c-dots--sig${c.sigRed ? ' hc-red' : ''}" d="${dots(c.sig.pts, yS)}"/>` : ''}
      <text class="hc-c-title${c.battRed ? ' hc-red-t' : ''}" x="${L}" y="${BY - 9}">Battery voltage (V)</text>
      <text class="hc-c-title" x="${L}" y="${KY - 6}">Check signals${c.P ? ` — every ${esc(fmtEvery(c.P))}` : ''}</text>
      ${PN.sigOn ? `<text class="hc-c-title${c.sigRed ? ' hc-red-t' : ''}" x="${L}" y="${SY - 9}">${dbfs ? 'Signal level (dBFS) — how loud the receiver heard it' : 'Signal strength — RSSI (dBm), how strongly the base station heard it'}</text>` : ''}
      ${c.sig.pts.length || PN.snrOn ? '' : `<text class="hc-ax" x="${L + PW / 2}" y="${SY + SH / 2}" text-anchor="middle">No signal strength came with these reports${c.S ? '' : ' — nothing was heard'}</text>`}
      ${c.batt.length ? '' : `<text class="hc-ax" x="${L + PW / 2}" y="${BY + BH / 2}" text-anchor="middle">No battery readings in these days</text>`}
      ${txt}
      <g id="hc-cross" class="hc-cross" visibility="hidden"><path d="M0 ${BY}V${SY + SH}"/></g>
      <g id="hc-marks" class="hc-marks" aria-hidden="true"></g>
    </svg>`;
  }
  function fmtEvery(P) { const h = P / HOUR; return h === 1 ? 'hour' : Number.isInteger(h) ? `${h} hours` : `${Math.round(P / MIN)} minutes`; }

  function openChart(i, from) {
    const c = C.cards[i], dlg = document.getElementById('hc-dialog');
    if (!c || !dlg) return;
    C.open = i; C.hov = null; C.from = from || null;
    const word = BAND_WORD[c.band];
    const why = c.band === 'ok' ? 'Why it is nominal' : c.band === 'silent' ? 'Why it is silent' : `Why it is marked ${word.toLowerCase()}`;
    dlg.innerHTML = `
      <div class="hc-d-head">
        <h3 id="hc-d-h">${esc(c.st.name)}</h3><span class="hc-chip hc-chip--${c.band}">${esc(word)}</span>
        <span class="small hc-d-sub">${esc(hubName(c.st.hub_id))}${c.st.station_number ? ' · station ' + esc(c.st.station_number) : ''}${c.P ? ' · checks every ' + esc(fmtEvery(c.P)) : ''} · ${esc(fmtTime(c.a))} to ${esc(fmtTime(c.b))}</span>
        <button onclick="HealthCards.closeChart()">Close</button>
      </div>
      ${c.P && c.slots.length ? `<div class="hc-d-tog small" role="group" aria-label="Which battery readings the line joins">
        <span>${termHtml('Battery line', WORDS.offslot)}:</span>
        <button type="button" id="hc-tog-chk" aria-pressed="${checkOnlyOn(c)}" onclick="HealthCards.setCheckOnly(true)">Check readings only</button>
        <button type="button" id="hc-tog-all" aria-pressed="${!checkOnlyOn(c)}" onclick="HealthCards.setCheckOnly(false)">All readings</button>
      </div>` : ''}
      <div class="hc-d-plot" id="hc-d-plot">${chartSvg(c)}<div class="hc-tip" id="hc-tip" hidden></div></div>
      <p class="small hc-d-key" id="hc-d-key">${keyLine(c)}</p>
      <div class="hc-d-cols">
        <div><h4>${esc(why)}</h4>
          <ul class="hc-d-why">${c.reasons.map(r => `<li class="hc-why--${r.b}"><b>${esc(r.k)}</b> ${esc(r.t)}</li>`).join('')}</ul>
          ${c.others.length ? `<p class="small">Station Health also found: ${c.others.map(f => esc(f.title)).join('; ')}.</p>` : ''}
          ${c.S ? `<button onclick="HealthCards.openStation()">Open it in Station Health</button>` : ''}
        </div>
        <div class="small hc-d-what"><h4>What this shows</h4>
          <p>Each <b>dot</b> on the battery, signal and SNR lines is one report heard; a line joins dots heard close together, so a single report, or ones far apart, shows as a dot alone.</p>
          <p><b>Battery voltage (V)</b> — the voltage in each report the station sent. It climbs by day as the solar panel charges and sags overnight; the overnight low is the number that matters. Dashed lines: 12.2 V watch, 11.8 V act on.</p>
          <p><b>Hollow battery dots</b> — a reading heard more than 30 minutes from any check slot, so probably not this station\'s own scheduled check but noise in a busy network. <b>Check readings only</b> (the default) joins just the on-schedule dots; <b>All readings</b> joins every dot.</p>
          <p><b>Check signals</b> — a slot for each check report the station should have sent, on the schedule Flood-Net has learned for it. Filled: arrived. Paler: arrived with frames lost. Strong: never came. Dashed: no receiver that hears it was listening.</p>
          <p><b>Signal-to-noise (SNR)</b> — the violet line, on the left axis (beside the signal strength axis where that is drawn), in dB: how far the best-heard copy of each report stood above the background noise at the base station. Higher is better. Not every receiver reports it, so some stations have no line.</p>
          <p><b>Messages heard nearby</b> — the grey bars on the right-hand axis: how many messages the base stations that hear this station picked up, from anybody, in each check-signal period. They sit under the signal trace and line up with the check slots, so a tall bar by a missed check says the network was busy then.</p>
          ${panelOf(c).sigOn ? `<p><b>${c.sig.unit === 'dBFS' ? 'Signal level (dBFS)' : 'Signal strength — RSSI (dBm)'}</b> — ${c.sig.unit === 'dBFS'
            ? 'how loud the report was at the receiver\'s input, in decibels below full scale; this receiver does not report RSSI, so no watch or act-on line is drawn.'
            : 'how strongly the base station heard each report: the strongest copy, if more than one heard it. Closer to 0 is stronger: −70 dBm is strong, −110 dBm near the limit. It is not signal-to-noise (SNR, how far the signal stands above the background noise). Dashed lines: −100 dBm watch, −105 dBm act on (provisional).'}</p>` : ''}
        </div>
      </div>`;
    bindChart();
    dlg.addEventListener('close', onClose, { once: true });
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    loadTraffic(c);
  }
  function bindChart() {
    const svg = document.getElementById('hc-chart');
    if (svg) {
      svg.addEventListener('pointermove', e => hoverAt(pointerTime(e, svg)));
      svg.addEventListener('pointerleave', () => hoverAt(null));
      svg.addEventListener('keydown', chartKey);
    }
  }
  // The traffic has come in: the same chart again with the bars, the tip kept.
  function drawPlot(c) {
    const plot = document.getElementById('hc-d-plot'), key = document.getElementById('hc-d-key');
    if (!plot) return;
    const had = document.activeElement && document.activeElement.id === 'hc-chart';
    const svg = plot.querySelector('svg');
    if (svg) svg.outerHTML = chartSvg(c);
    if (key) key.innerHTML = keyLine(c);
    bindChart();
    if (had) { const n = document.getElementById('hc-chart'); if (n) n.focus({ preventScroll: true }); }
    if (C.hov != null) hoverAt(C.hov);
  }
  // The line under the chart that says what the bars are, or why there are none.
  function snrKey(c) {
    const t = termHtml('Signal-to-noise (SNR)', WORDS.snr);
    return c.snr.pts.length
      ? `<b>${t}</b> (violet line, left axis) — how far the best-heard copy of each report stood above the background noise. Higher is better.`
      : `<b>${t}</b> — not drawn: none of the receivers that heard this station reported a noise floor, so there is no SNR to plot.`;
  }
  function offKey(c) {
    if (!c.P || !c.slots.length) return '';
    const n = c.batt.filter(p => offSlot(c, p.t)).length;
    if (!n) return '';
    return `<br><b>${termHtml('Hollow battery dots', WORDS.offslot)}</b> (${n}) — readings heard more than 30 minutes from any check slot. They may be network noise rather than this station's own check, so ${checkOnlyOn(c) ? 'the line skips them' : 'the line joins them'}.`;
  }
  function keyLine(c) { return trafficKey(c) + '<br>' + snrKey(c) + offKey(c); }
  function setCheckOnly(on) {
    C.checkOnly = !!on;
    const c = C.cards[C.open];
    if (!c) return;
    ['chk', 'all'].forEach(k => { const b = document.getElementById('hc-tog-' + k); if (b) b.setAttribute('aria-pressed', String((k === 'chk') === checkOnlyOn(c))); });
    drawPlot(c);
  }
  function trafficKey(c) {
    const t = termHtml('Messages heard nearby', WORDS.traffic);
    if (C.demo) return `<b>${t}</b> — not drawn for the demo week: the bars come from what Flood-Net's base stations really heard.`;
    if (!c.S) return `<b>${t}</b> — not drawn: no base station has heard this station in these days.`;
    const T0 = c.traffic;
    if (T0 === undefined || T0 === null) return `<b>${t}</b> — reading the hourly totals…`;
    if (T0.failed) return `<b>${t}</b> — could not be read just now; close and open the chart to try again.`;
    if (T0.none) return `<b>${t}</b> — not drawn: none of the base stations that hear this station could be named.`;
    const by = T0.names.length > 3 ? T0.names.slice(0, 3).join(', ') + ` and ${T0.names.length - 3} more` : T0.names.join(', ');
    return `<b>${t}</b> (grey bars, right-hand axis) — everything ${esc(by)} heard from any station in each ${T0.hourly ? 'hour' : 'check period (every ' + esc(fmtEvery(c.P)) + ')'}, lined up with the check slots above. A tall bar is a busy network, which can crowd a check out.${T0.hourly ? ' Checks come more often than hourly, and the totals are hourly, so the bars are by the hour.' : ''}`;
  }
  function onClose() { const f = C.from; C.open = null; C.hov = null; if (f && f.isConnected) f.focus(); }
  function closeChart() { const dlg = document.getElementById('hc-dialog'); if (dlg && dlg.open) dlg.close(); }
  function openStation() {
    const c = C.cards[C.open];
    closeChart();
    if (c && c.S && typeof Health !== 'undefined') Health.select(c.id);
  }

  function pointerTime(e, svg) {
    const b = svg.getBoundingClientRect(), c = C.cards[C.open];
    if (!c || !b.width) return null;
    const px = ((e.clientX - b.left) / b.width) * CH.W;
    const L = panelOf(c).L;
    if (px < L - 8 || px > CH.W - CH.R + 8) return null;
    return c.a + ((px - L) / (CH.W - L - CH.R)) * (c.b - c.a);
  }
  // Every moment worth stepping to: a reading, a transmission, a check slot.
  function moments(c) {
    return [...new Set([...c.batt.map(p => p.t), ...(panelOf(c).sigOn ? c.sig.pts : []).map(p => p.t), ...c.snr.pts.map(p => p.t), ...c.slots.map(s => s.t)])].sort((a, b) => a - b);
  }
  function chartKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const c = C.cards[C.open];
    if (!c) return;
    const ts = moments(c);
    if (!ts.length) return;
    const cur = C.hov == null ? (e.key === 'ArrowLeft' ? Infinity : -Infinity) : C.hov;
    const next = e.key === 'ArrowRight' ? ts.find(t => t > cur) : [...ts].reverse().find(t => t < cur);
    hoverAt(next == null ? (e.key === 'ArrowRight' ? ts[ts.length - 1] : ts[0]) : next, true);
  }
  function nearest(pts, t, within) {
    let best = null, bd = Infinity;
    pts.forEach(p => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } });
    return best && bd <= within ? best : null;
  }
  function hoverAt(t, said) {
    const c = C.cards[C.open], tip = document.getElementById('hc-tip'), cross = document.getElementById('hc-cross');
    if (!c || !tip || !cross) return;
    if (t == null) { C.hov = null; tip.hidden = true; cross.setAttribute('visibility', 'hidden'); const mk0 = document.getElementById('hc-marks'); if (mk0) mk0.innerHTML = ''; return; }
    C.hov = t;
    const P = c.P || 3 * HOUR, win = Math.max(P / 2, 45 * MIN);
    const bp = nearest(c.batt.map(p => ({ t: p.t, v: p.V })), t, win);
    const sp = panelOf(c).sigOn ? nearest(c.sig.pts, t, win) : null;
    const sl = nearest(c.slots, t, P / 2);
    const np = nearest(c.snr.pts, t, win);
    const at = (sl && sl.t) || (bp && bp.t) || (sp && sp.t) || (np && np.t) || t;
    const { W, R } = CH, L = panelOf(c).L, PW = W - L - R;
    const px = L + ((at - c.a) / (c.b - c.a)) * PW;
    cross.setAttribute('transform', `translate(${px.toFixed(1)} 0)`);
    cross.setAttribute('visibility', 'visible');
    // Ring the very points the card is quoting, so a reading heard off the
    // check slot is not mistaken for the slot's own.
    const mk = document.getElementById('hc-marks'), G = c.geo;
    if (mk && G) {
      const ring = (p, y) => p ? `<circle cx="${G.x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="7"/>` : '';
      mk.innerHTML = ring(bp, G.yB) + (panelOf(c).sigOn ? ring(sp, G.yS) : '') + (c.snr.pts.length ? ring(np, G.yN) : '');
    }
    const O = { hit: 'arrived', partial: 'arrived, frames lost', miss: 'missed', net: 'missed network-wide', unknown: 'no receiver listening' };
    const rows = [
      ['hc-ln--batt' + (c.battRed ? ' hc-ln--red' : ''), 'Battery', bp ? bp.v.toFixed(2) + ' V' + (offSlot(c, bp.t) ? ' (off schedule, may be noise)' : '') : '—'],
      ...(panelOf(c).sigOn ? [['hc-ln--sig' + (c.sigRed ? ' hc-ln--red' : ''), c.sig.unit === 'dBFS' ? 'Signal level' : 'Signal strength', sp ? fmtNeg(Math.round(sp.v)) + ' ' + (c.sig.unit || 'dBm') : '—']] : []),
      ...(c.snr.pts.length ? [['hc-ln--snr', 'SNR', np ? np.v.toFixed(1) + ' dB' : '—']] : []),
      ['hc-ln--chk hc-ln--chk-' + (sl ? sl.outcome : 'none'), 'Check', sl ? O[sl.outcome] || sl.outcome : 'no check due'],
    ];
    if (c.traffic && c.traffic.bins.length) {
      const tb = c.traffic.bins.find(b => at >= b.t0 && at < b.t1);
      rows.push(['hc-ln--traffic', 'Messages nearby', tb ? fmtN(tb.n) + (c.traffic.hourly ? ' that hour' : ' in the period') : '—']);
    }
    tip.innerHTML = `<b>${esc(fmtTime(at))}</b>${rows.map(([cls, k, v]) => `<span class="hc-tip-row"><i class="hc-ln ${cls}" aria-hidden="true"></i><span>${esc(k)}</span><b>${esc(v)}</b></span>`).join('')}`;
    const frac = px / W;
    tip.style.setProperty('--tx', (frac * 100).toFixed(2) + '%');
    tip.classList.toggle('hc-tip--left', frac > 0.72);
    tip.hidden = false;
    if (said) announce(`${fmtTime(at)}: ${rows.map(r => `${r[1]} ${r[2]}`).join(', ')}.`);
  }

  // Station Health's analysis has changed, or the tab was drawn: the panel is
  // already in the page (render()), so only the cards need placing.
  function stop() {
    if (C.ro) { C.ro.disconnect(); C.ro = null; }
    if (C.raf) { cancelAnimationFrame(C.raf); C.raf = 0; }
    C.els = [];
  }

  return {
    render, mount, stop, setCheckOnly, setHub, setSpan, zoomBy, toggleMag, fullscreen, closeChart, openStation,
    // the pure parts, for test/health-cards.mjs
    weights, geoRows, fitGrid, signalOf, snrOf, bandsOf, nightsOf, trafficBins, WORDS, GLOSSARY,
  };
})();
