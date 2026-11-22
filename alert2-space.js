// MegaNet — alert2-space.js
//
// Alert2Space — the ALERT2 half of the 🔗 ALERT IDs tab drawn as the legacy
// half is (address-space.js): every ALERT2 ID round one wheel, and an ID
// grid a hundred to a row. Two cards, between the ALERT2 IDs card and the
// free-ID finder (alert2-ids.js), sharing that page's filter box.
//
//   · The wheel — 1 at the top, clockwise to 65,534, a wedge a block of a
//     thousand. Three rings, outside in: each ID to scale, coloured by who
//     holds it; what is on air and on file for it (heard sending, heard only
//     passing others on, on the slot table but not heard); and a bar a
//     thousand, as long as the thousand is busy beside the busiest.
//   · The grid — the thousands anything uses (and any the filter box, the
//     wheel or the free-ID finder points at), ten rows of a hundred each.
//
// Both show one hub or every hub together (Show, one between them). An ID
// pressed on either goes into the filter box, which marks it on both in the
// filter matches' amber; a range typed there is outlined on both; a thousand
// or a gap kept on the wheel is outlined on the grid, and a gap pressed sets
// the finder's Starting from. The readout under each says whose an ID is,
// with its sensor numbers drawn 0–255, a cell each: which station of a shared
// ID takes which, and how many are left.
//
// What "free" means: no station holds the ID, it is not on the slot table and
// no base station decoded it in 90 days (Alert2Ids.free). ALERT2 IDs are not
// reused hub by hub as legacy addresses are, so free is free everywhere; a
// hub's Show changes only how the IDs in use are coloured — this hub's, or
// another's.
//
// The pure parts (index, statusOf, airOf, wedges, gaps, thousands, boxOf)
// take Alert2Ids.rows() rows, for test/alert2-ids.mjs.
//
// Exposes: Alert2Space.
// Requires at call time: core.js (esc, escAttr, termHtml, state),
// alert2-ids.js (Alert2Ids), app.js (goToStation).

const Alert2Space = (function () {
  const MAX = 65534, ROW = 100, K = 1000, WEDGES = 66, SLOTS = WEDGES * K;

  const WORDS = {
    wheel: 'Every ALERT2 ID from 1 at the top, clockwise to 65,534. A wedge is a block of a thousand IDs — 11,000 to 11,999 — and each ID on the outer ring is drawn to scale, so a gap is as wide as it is long.',
    use: 'One station in the register holds this ID.',
    shared: 'Two or more stations hold this ID at one site, each with its own sensor numbers — a weir\'s headwater and tailwater gauges on one logger. Normal, when every one lists its sensor numbers.',
    clash: 'Two or more stations hold this ID and their sensor numbers do not tell them apart: one lists none, or two list the same one. A reading under it may reach the wrong station, or none.',
    elsewhere: 'Held by a station in another hub. Shown faintly so this hub\'s own stand out; it is still not free.',
    slot: 'On the slot table (the ⏱️ TDMA Planner) for a site, but no station in the register holds it yet.',
    stranger: 'Decoded by the base stations at least 3 times in 90 days, but no station in the register holds it.',
    free: 'No station holds it, it is not on the slot table and no base station decoded it in 90 days — in a thousand that already has IDs in use, so it fits the numbering the network uses.',
    open: 'Free, in a thousand where nothing is in use at all.',
    air: 'What the base stations heard of each ID in 90 days, and what is on the slot table, whether a station holds the ID or not.',
    heard: 'Heard sending its own reports in the last 90 days.',
    relay: 'Heard only passing other stations\' reports on, as a repeater — its own were not decoded.',
    filed: 'On the slot table, but not heard in 90 days.',
    bars: 'A bar a thousand, as long as the IDs in use there beside the busiest thousand — the longest bar is the busiest.',
    sensors: 'The 256 sensor numbers (0–255) an ALERT2 ID can carry, a cell each. Stations sharing an ID must each take different ones.',
    gap: 'A run of free IDs between two IDs in use.',
  };
  const GLOSSARY = [['wheel', 'The wheel'], ['use', 'In use'], ['shared', 'Shared'], ['clash', 'Not told apart'], ['elsewhere', 'In another hub'],
                    ['slot', 'On the slot table only'], ['stranger', 'Heard, no station'], ['free', 'Free'], ['open', 'Free, unused thousand'],
                    ['air', 'On air and on file'], ['heard', 'Heard sending'], ['relay', 'Passing on only'], ['filed', 'On file, not heard'],
                    ['bars', 'Inner bars'], ['sensors', 'Sensor numbers'], ['gap', 'Gap']];
  const LABEL = {
    use: 'in use', shared: 'shared, told apart', clash: 'shared, not told apart', elsewhere: 'in use in another hub',
    slot: 'on the slot table, no station', stranger: 'heard, no station', free: 'free', open: 'free, in an unused thousand',
  };
  const INKED = ['use', 'shared', 'clash', 'elsewhere', 'slot', 'stranger'];
  // A colour's class: free is laid on fainter here than on the legacy half,
  // where most of a block is in use.
  const cls = st => `as-c-${st === 'free' ? 'a2free' : st}`;

  // ── 1. pure ────────────────────────────────────────────────────────────────
  const num = n => Number(n).toLocaleString('en-AU');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;
  const sent = r => r.heard.reduce((a, h) => a + (Number(h.source) || 0), 0);
  const passed = r => r.heard.reduce((a, h) => a + (Number(h.relay) || 0), 0);
  const has = (r, k) => r.checks.some(c => c.k === k);

  // The rows as the pictures ask them: by ID, the thousands anything is in,
  // and the hubs that hold any.
  //   rows: Alert2Ids.rows(); hubs: [{ id, name, ord }]
  function index(rows, hubs = []) {
    const byId = new Map(rows.map(r => [r.id, r]));
    const busyK = new Set(rows.map(r => Math.floor(r.id / K)));
    const hubIds = new Set();
    rows.forEach(r => r.holders.forEach(h => { if (h.hub) hubIds.add(h.hub); }));
    const hubBy = new Map(hubs.map(h => [h.id, h]));
    const hubList = [...hubIds].map(id => hubBy.get(id) || { id, name: id })
      .sort((a, b) => ((a.ord ?? 0) - (b.ord ?? 0)) || String(a.name).localeCompare(String(b.name)));
    const ids = rows.map(r => r.id).sort((a, b) => a - b);
    return { rows, byId, busyK, hubList, hubBy, ids };
  }
  const inScope = (sc, h) => sc === 'all' || sc === 'hub:' + (h.hub || '');

  // One ID's colour, in a scope: 'all' or 'hub:<id>'.
  function statusOf(I, sc, a) {
    if (!(a >= 1 && a <= MAX)) return 'void';
    const r = I.byId.get(a);
    if (!r) return I.busyK.has(Math.floor(a / K)) ? 'free' : 'open';
    const hs = r.holders.filter(h => inScope(sc, h));
    if (hs.length) {
      if (has(r, 'shared-bare') || has(r, 'shared-clash')) return 'clash';
      return r.holders.length > 1 ? 'shared' : 'use';
    }
    if (r.holders.length) return 'elsewhere';
    if (has(r, 'stranger')) return 'stranger';
    if (r.sites.length) return 'slot';
    return 'stranger';
  }
  // The middle ring: 3 heard sending, 2 heard only passing on, 1 on the slot
  // table and not heard, 0 nothing.
  function airOf(I, a) {
    const r = I.byId.get(a);
    if (!r) return 0;
    return sent(r) ? 3 : passed(r) ? 2 : r.sites.length ? 1 : 0;
  }

  // A stretch counted: how many of each colour, and the stations in it.
  function stretch(I, sc, lo, hi) {
    lo = Math.max(1, lo); hi = Math.min(MAX, hi);
    const c = { lo, hi, n: Math.max(0, hi - lo + 1), use: 0, shared: 0, clash: 0, elsewhere: 0, slot: 0, stranger: 0, free: 0, open: 0, held: 0, names: [] };
    if (c.n <= 0) return c;
    const i0 = lowerBound(I.ids, lo);
    for (let i = i0; i < I.ids.length && I.ids[i] <= hi; i++) {
      const r = I.byId.get(I.ids[i]), st = statusOf(I, sc, r.id);
      c[st]++;
      r.holders.filter(h => inScope(sc, h)).forEach(h => { if (c.names.length < 40 && !c.names.includes(h.name)) c.names.push(h.name); });
    }
    const taken = c.use + c.shared + c.clash + c.elsewhere + c.slot + c.stranger;
    // Its free IDs a thousand at a time: free in a busy thousand, open in one
    // nothing uses.
    for (let k = Math.floor(lo / K); k <= Math.floor(hi / K); k++) {
      const a0 = Math.max(lo, k * K), a1 = Math.min(hi, k * K + K - 1);
      let n = 0;
      for (let i = lowerBound(I.ids, a0); i < I.ids.length && I.ids[i] <= a1; i++) n++;
      if (I.busyK.has(k)) c.free += a1 - a0 + 1 - n; else c.open += a1 - a0 + 1 - n;
    }
    c.held = c.use + c.shared + c.clash;
    c.taken = taken;
    return c;
  }
  function lowerBound(list, v) {
    let i = 0, j = list.length;
    while (i < j) { const m = (i + j) >> 1; if (list[m] < v) i = m + 1; else j = m; }
    return i;
  }
  // A wedge a thousand, counted.
  function wedges(I, sc) {
    const out = [];
    for (let w = 0; w < WEDGES; w++) out.push(Object.assign(stretch(I, sc, w * K, w * K + K - 1), { wedge: w }));
    return out;
  }

  // The free runs between the lowest ID in use and the highest, biggest
  // first; and where nothing is used below or above.
  function gaps(I, n = 10) {
    const ids = I.ids;
    if (ids.length < 2) return { runs: [], lo: ids[0] ?? null, hi: ids[ids.length - 1] ?? null };
    const runs = [];
    for (let i = 1; i < ids.length; i++) if (ids[i] - ids[i - 1] > 1) runs.push({ lo: ids[i - 1] + 1, hi: ids[i] - 1, n: ids[i] - ids[i - 1] - 1 });
    runs.sort((a, b) => (b.n - a.n) || (a.lo - b.lo));
    return { runs: runs.slice(0, n), lo: ids[0], hi: ids[ids.length - 1] };
  }

  // The grid's thousands: every one anything is in, and the extra ones asked
  // for (the filter box's, the wheel's, the finder's), in order.
  function thousands(I, extra = []) {
    const ks = new Set(I.busyK);
    extra.forEach(a => { if (a >= 1 && a <= MAX) ks.add(Math.floor(a / K)); });
    return [...ks].sort((a, b) => a - b);
  }

  // The filter box as the pictures read it: an ID, or a range. Anything else
  // marks nothing.
  function boxOf(q) {
    q = String(q || '').trim();
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(q);
    if (range) {
      const lo = Math.max(1, Math.min(+range[1], +range[2])), hi = Math.min(MAX, Math.max(+range[1], +range[2]));
      return lo <= hi ? { id: null, range: { lo, hi } } : { id: null, range: null };
    }
    if (/^\d+$/.test(q) && +q >= 1 && +q <= MAX) return { id: +q, range: null };
    return { id: null, range: null };
  }

  // ── 2. state ───────────────────────────────────────────────────────────────
  const S = {
    scope: 'all',
    sel: null,          // the wheel's kept stretch: { lo, hi, wedge } or { lo, hi, gap }
    wHover: null, wRing: null, wAddr: null,
    gHover: null,
    gridKs: '',       // the thousands the grid's body was drawn for
    ro: null,
  };
  let WHEEL = null, GRID = null;

  const A2 = () => (typeof Alert2Ids !== 'undefined' ? Alert2Ids : null);
  function cur() {
    const a = A2();
    if (!a) return null;
    const D = typeof state !== 'undefined' && state.data ? state.data : null;
    const I = index(a.current(), (D && D.hubs) || []);
    if (S.scope !== 'all' && !I.hubList.some(h => 'hub:' + h.id === S.scope)) S.scope = 'all';
    return I;
  }
  const box = () => boxOf(A2() ? A2().getFilter() : '');
  const marked = () => { const b = box(); return b.id != null ? [b.id] : []; };
  const scopeName = I => (S.scope === 'all' ? 'Every hub together' : (I.hubList.find(h => 'hub:' + h.id === S.scope) || {}).name || 'a hub');

  // ── 3. colours ─────────────────────────────────────────────────────────────
  function cssColour(name, dflt) {
    try {
      const page = document.querySelector('.as-page') || document.documentElement;
      const v = getComputedStyle(page).getPropertyValue(name).trim();
      if (!v) return dflt;
      const c = document.createElement('canvas').getContext('2d');
      c.fillStyle = '#010203';
      c.fillStyle = v;
      return c.fillStyle === '#010203' ? dflt : c.fillStyle;
    } catch (_) { return dflt; }
  }
  function colours() {
    const use = cssColour('--as-use', '#00838f'), muted = cssColour('--muted', '#7a8794');
    return {
      use: [use, 1], shared: [cssColour('--a2-shared', '#7c35a3'), 1], clash: [cssColour('--as-clash', '#c7401a'), 1],
      elsewhere: [use, 0.42], slot: [cssColour('--as-alloc', '#b8860b'), 1], stranger: [cssColour('--a2-stranger', '#ad1457'), 1],
      free: [cssColour('--as-free', '#107c10'), 0.3], open: [muted, 0.16],
    };
  }

  // ── 4. the words ───────────────────────────────────────────────────────────
  const t = (k, text) => (typeof termHtml === 'function' ? termHtml(text, WORDS[k]) : esc(text));
  const key = (c, k, text) => `<span class="sr-key"><span class="sr-sw ${c.startsWith('cov') ? 'as-c-' + c : cls(c)}" aria-hidden="true"></span>${t(k, text)}</span>`;
  function statusKeysHtml(I) {
    const hub = S.scope !== 'all';
    return `${key('use', 'use', 'in use')}${key('shared', 'shared', 'shared, told apart by sensor number')}${key('clash', 'clash', 'shared, not told apart')}
      ${hub ? key('elsewhere', 'elsewhere', 'in use in another hub') : ''}${key('slot', 'slot', 'on the slot table, no station')}${key('stranger', 'stranger', 'heard, no station')}
      ${key('free', 'free', 'free, in a thousand in use')}${key('open', 'open', 'free, in an unused thousand')}`;
  }
  const hitKey = '<span class="sr-key"><span class="as-hit-sw" aria-hidden="true"></span>in the filter box</span>';
  function scopeSelectHtml(I) {
    if (!I.hubList.length) return '';
    const opt = (v, n) => `<option value="${escAttr(v)}"${v === S.scope ? ' selected' : ''}>${esc(n)}</option>`;
    return `<label>Show <select onchange="Alert2Space.setScope(this.value)">${opt('all', 'Every hub together')}
        <optgroup label="One hub — its stations' IDs coloured, the rest faint">${I.hubList.map(h => opt('hub:' + h.id, h.name)).join('')}</optgroup></select></label>`;
  }

  // The sensor numbers of an ID, 0–255 a cell each, coloured by the station
  // that lists it: who takes which, and how many are left.
  const SERIES = ['--ad-series-1', '--ad-series-3', '--ad-series-5', '--ad-series-4', '--ad-series-9', '--ad-series-8'];
  function sensorsHtml(r) {
    if (!r || !r.holders.length || !r.holders.some(h => h.slots.length)) return '';
    const by = new Map();
    r.holders.forEach((h, i) => h.slots.forEach(n => { const l = by.get(n); if (l) l.push(i); else by.set(n, [i]); }));
    let cells = '';
    for (let n = 0; n < 256; n++) {
      const l = by.get(n), x = n % 32, y = Math.floor(n / 32);
      const fill = !l ? 'color-mix(in srgb, var(--muted) 18%, transparent)' : l.length > 1 ? 'var(--as-clash)' : `var(${SERIES[l[0] % SERIES.length]})`;
      cells += `<rect x="${x}" y="${y}" width="0.86" height="0.86" style="fill:${fill}"><title>Sensor ${n}${l ? `: ${esc(l.map(i => r.holders[i].name).join(' and '))}` : ' — free'}</title></rect>`;
    }
    const used = by.size;
    const legend = r.holders.map((h, i) => `<span class="sr-key"><span class="sr-sw" style="--c:var(${SERIES[i % SERIES.length]})" aria-hidden="true"></span>${esc(h.name)}: ${h.slots.length ? esc(h.slots.join(', ')) : '<span class="txt-warn">none listed</span>'}</span>`).join('');
    return `<div class="a2s-sensors"><p class="small">${t('sensors', 'Sensor numbers')}: ${num(used)} taken of 256, ${num(256 - used)} left${[...by.values()].some(l => l.length > 1) ? ' · <span class="txt-bad">one is on two stations</span>' : ''}</p>
      <svg viewBox="0 0 32 8" role="img" aria-label="${escAttr(`Sensor numbers of ALERT2 ID ${r.id}: ${r.holders.map(h => `${h.name} ${h.slots.join(', ') || 'none'}`).join('; ')}`)}">${cells}</svg>
      <p class="small sr-keys">${legend}</p></div>`;
  }

  // One ID: whose it is, what is on file and on air, the checks. Plain, for a
  // tip the pointer cannot reach into: no buttons.
  function readoutHtml(I, a, plain) {
    if (a == null) return '';
    if (!(a >= 1 && a <= MAX)) return `${esc(String(a))} is not an ALERT2 ID — they run from 1 to ${num(MAX)}.`;
    const r = I.byId.get(a), st = statusOf(I, S.scope, a);
    const open = h => (!plain && typeof goToStation === 'function'
      ? `<button type="button" class="link-btn" onclick="goToStation(${esc(JSON.stringify(h.id))})">${esc(h.name)}</button>` : esc(h.name));
    const hubOf = h => (h.hub ? ` <span class="small txt-muted">(${esc((I.hubBy.get(h.hub) || {}).name || h.hub)})</span>` : '');
    if (!r) {
      return `<b>${a}</b> — <b class="as-f-low">free</b>${st === 'open' ? ', in a thousand nobody uses' : ''}${!plain && A2() ? ` · <button type="button" class="link-btn" onclick="Alert2Space.findFrom(${a})">Find free from here</button>` : ''}`;
    }
    const parts = [];
    if (r.holders.length) parts.push(`${r.holders.length > 1 ? `held by ${num(r.holders.length)} stations` : 'held by'} ${r.holders.map(h => `${open(h)}${hubOf(h)}`).join(', ')}`);
    else parts.push(`<span class="txt-warn">no station holds it</span>`);
    if (r.sites.length) parts.push(`slot table: ${r.sites.map(s => `${esc(s.site)} (${esc(s.runs.join(', '))})`).join('; ')}`);
    const s = sent(r), p = passed(r);
    parts.push(s || p ? `heard: ${[s ? `${num(s)} sent` : '', p ? `${num(p)} passed on` : ''].filter(Boolean).join(', ')}` : 'not heard');
    const warn = r.checks.filter(c => c.level === 'warn').map(c => `<span class="txt-warn">${esc(c.text)}</span>`);
    return `<b>${a}</b> — ${esc(LABEL[st])} · ${parts.join(' · ')}${warn.length ? ` · ${warn.join(' · ')}` : ''}${plain ? '' : sensorsHtml(r)}`;
  }
  function stretchText(I, c) {
    const bits = [c.held ? `${num(c.held)} in use` : '', c.elsewhere ? `${num(c.elsewhere)} in another hub` : '', c.slot ? `${num(c.slot)} on the slot table only` : '',
                  c.stranger ? `${num(c.stranger)} heard, no station` : ''].filter(Boolean);
    return `<b>${num(c.lo)}–${num(c.hi)}</b>: ${bits.join(', ') || 'nothing in use'} · ${num(c.free + c.open)} free${c.names.length ? ` · ${esc(c.names.slice(0, 6).join(', '))}${c.names.length > 6 ? ` and ${num(c.names.length - 6)} more` : ''}` : ''}`;
  }

  // ── 5. the wheel ───────────────────────────────────────────────────────────
  const ang = a => -Math.PI / 2 + (2 * Math.PI * a) / SLOTS;
  const ringIcon = id => `<svg class="as-ring-ico" viewBox="0 0 24 24" aria-hidden="true">${[['addr', 10], ['cover', 6.6], ['block', 3.4]]
    .map(([x, r]) => `<circle cx="12" cy="12" r="${r}"${x === id ? ' class="is-this"' : ''}/>`).join('')}</svg>`;

  function wheelHtml() {
    const I = cur();
    if (!I) return '';
    if (!I.rows.length) return '<p class="small">No ALERT2 ID is known yet — none in the register, on the slot table or heard.</p>';
    const W = wedges(I, S.scope), G = gaps(I), sel = S.sel;
    const row = (id, head, text, keys) => `<div class="as-ring-row" data-ring="${id}">${ringIcon(id)}
        <div><p><b>${head}</b> — ${text}</p><p class="small sr-keys">${keys}</p></div></div>`;
    const busiest = Math.max(1, ...W.map(w => w.taken));
    return `<div class="control-row as-controls">${scopeSelectHtml(I)}</div>
      <p class="small">${t('wheel', 'Every ALERT2 ID')}, from 1 at the top clockwise to ${num(MAX)}; a wedge is a block of a thousand. ${num(I.rows.length)} are known,
        between ${num(I.ids[0])} and ${num(I.ids[I.ids.length - 1])}. Point at the outer two rings for an ID, at the inner bars for its thousand; press to keep it.
        An ID pressed goes into the filter box above, and onto the ID grid; one typed there is kept here, marked in amber with a ring that glows.</p>
      <div class="as-ring-key">
        ${row('addr', 'Outer ring: each ID', 'a sliver an ID, to scale, coloured by who holds it.', `${statusKeysHtml(I)}${hitKey}`)}
        ${row('cover', `Middle ring: ${t('air', 'on air and on file')}`, 'what the base stations heard of each ID, and what the slot table has, whether a station holds it or not. Bare track is neither.',
          `${key('cov3', 'heard', 'heard sending')}${key('cov2', 'relay', 'heard only passing on')}${key('cov1', 'filed', 'on the slot table, not heard')}`)}
        ${row('block', `${t('bars', 'Inner bars')}: each thousand`, `as long as its IDs in use beside the busiest thousand (${plural(busiest, 'ID')}).`,
          `${key('use', 'use', 'held by a station')}${key('slot', 'slot', 'on the slot table only')}${key('stranger', 'stranger', 'heard, no station')}`)}
      </div>
      <p class="small as-ring-why"><b>The outer two together.</b> In use over bare track is a station the base stations have not heard and the slot table does not
        list — worth a look. Heard over a gap on the outer ring is somebody on air the register does not know.</p>
      <div class="as-wheel-wrap">
        <div class="as-wheel-box">
          <canvas id="a2s-wheel" tabindex="0" role="img" aria-describedby="a2s-wheel-out"
            aria-label="${escAttr(`Every ALERT2 ID round a wheel, a wedge a block of a thousand, for ${scopeName(I)}. The arrow keys step from wedge to wedge, and with Shift from one ID in use to the next; the table under the wheel holds the same.`)}"
            onpointermove="Alert2Space.wheelHover(event)" onpointerleave="Alert2Space.wheelHover(null)" onclick="Alert2Space.wheelClick(event)" onkeydown="Alert2Space.wheelKey(event)"></canvas>
          <div id="a2s-wheel-pins" class="as-pins" aria-hidden="true"></div>
        </div>
        <div id="a2s-wheel-tip" class="as-wheel-tip small" hidden></div>
      </div>
      <div id="a2s-wheel-out" class="small as-readout" aria-live="polite">${wheelOutHtml(I)}</div>
      ${G.runs.length ? `<p class="small as-runs a2s-gaps">The biggest ${t('gap', 'gaps')} between IDs in use — press one to keep it and to find free from it:
        ${G.runs.map(g => `<button type="button" class="pill" data-lo="${g.lo}" aria-pressed="${!!(sel && sel.gap && sel.lo === g.lo)}"
          onclick="Alert2Space.gapPick(${g.lo}, ${g.hi})">${g.lo === g.hi ? num(g.lo) : `${num(g.lo)}–${num(g.hi)}`} <span class="small">(${num(g.n)})</span></button>`).join(' ')}</p>` : ''}
      <p class="small txt-muted">Nothing is in use below ${num(G.lo)} or above ${num(G.hi)}.</p>
      <details class="sr-fold"><summary>Thousand by thousand — the same as a table</summary>
        <div class="table-wrap tall" role="region" tabindex="0" aria-label="ALERT2 IDs, thousand by thousand">
        <table class="hl-table as-wedges"><caption class="sr-only">Each thousand ALERT2 IDs with anything in it: how many are in use, on the slot table only, heard with no station, and free</caption>
          <thead><tr><th scope="col">Thousand</th><th scope="col" class="num">${t('use', 'In use')}</th>${S.scope !== 'all' ? `<th scope="col" class="num">${t('elsewhere', 'Other hubs')}</th>` : ''}
            <th scope="col" class="num">${t('slot', 'Slot table only')}</th><th scope="col" class="num">${t('stranger', 'Heard, no station')}</th><th scope="col" class="num">${t('free', 'Free')}</th><th scope="col">Stations</th></tr></thead>
          <tbody>${W.filter(w => w.taken).map(w => `<tr><th scope="row">${num(w.lo)}–${num(w.hi)}</th><td class="num">${num(w.held)}</td>${S.scope !== 'all' ? `<td class="num">${num(w.elsewhere)}</td>` : ''}
            <td class="num">${num(w.slot)}</td><td class="num">${num(w.stranger)}</td><td class="num">${num(w.free + w.open)}</td>
            <td class="small">${w.names.length ? `${esc(w.names.slice(0, 4).join(', '))}${w.names.length > 4 ? ` and ${num(w.names.length - 4)} more` : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  function wheelOutHtml(I) {
    const b = box(), s = S.sel;
    const lines = [];
    if (b.id != null) lines.push(`<p class="as-hit-line"><span class="as-hit-sw" aria-hidden="true"></span>In the filter box: ${readoutHtml(I, b.id)} · <button type="button" class="link-btn" onclick="Alert2Space.toGrid(${b.id})">On the ID grid</button></p>`);
    else if (b.range) lines.push(`<p class="as-hit-line"><span class="as-hit-sw" aria-hidden="true"></span>In the filter box: ${stretchText(I, stretch(I, S.scope, b.range.lo, b.range.hi))}</p>`);
    if (s && !(b.id != null && s.lo === Math.floor(b.id / K) * K && s.wedge != null)) {
      lines.push(`<p>Kept: ${stretchText(I, stretch(I, S.scope, s.lo, s.hi))} · <button type="button" class="link-btn" onclick="Alert2Space.toGrid(${Math.max(1, s.lo)})">On the ID grid</button>
        · <button type="button" class="link-btn" onclick="Alert2Space.keep(null)">Let go</button></p>`);
    }
    return lines.join('') || '<p>Point at the outer two rings for an ID, or at the inner bars for a thousand; press one — or a gap below — to keep it. With the wheel focused, the arrow keys step a thousand at a time, and with Shift from one ID in use to the next.</p>';
  }

  function wheelBase(I, D, dpr) {
    const base = document.createElement('canvas');
    base.width = Math.round(D * dpr); base.height = Math.round(D * dpr);
    const g = base.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const big = D >= 700, M = big ? 48 : 40, fs = big ? 12 : 10;
    const cx = D / 2, cy = D / 2, R = D / 2 - M;
    const rA0 = R * 0.8, rB1 = R * 0.765, rB0 = R * 0.69, rC1 = R * 0.655, rC0 = R * 0.38;
    const col = colours();
    const cov = cssColour('--accent', '#0b5cab'), text = cssColour('--muted', '#7a8794'), ink = cssColour('--text', '#16202a');
    const sector = (a0, a1, r0, r1) => { g.beginPath(); g.arc(cx, cy, r1, a0, a1); g.arc(cx, cy, r0, a1, a0, true); g.closePath(); };
    const band = (lo, hi, r0, r1, minPx) => {
      let a0 = ang(lo), a1 = ang(hi + 1);
      if (minPx && (a1 - a0) * r1 < minPx) { const m = (a0 + a1) / 2, h = minPx / r1 / 2; a0 = m - h; a1 = m + h; }
      sector(a0, a1, r0, r1);
      g.fill();
    };
    // Outer ring: the free a thousand at a time, the IDs in use over them,
    // each at least a hairline wide so one alone in a thousand still shows.
    for (let w = 0; w < WEDGES; w++) {
      const lo = Math.max(1, w * K), hi = Math.min(MAX, w * K + K - 1);
      const [c, al] = I.busyK.has(w) ? col.free : col.open;
      g.globalAlpha = al; g.fillStyle = c; band(lo, hi, rA0, R, 0);
    }
    I.ids.forEach(a => {
      const st = statusOf(I, S.scope, a);
      g.globalAlpha = col[st][1]; g.fillStyle = col[st][0];
      band(a, a, rA0, R, 1.2);
    });
    // Middle ring: on air and on file, on a bare track.
    g.globalAlpha = 0.1; g.fillStyle = text; sector(ang(1), ang(MAX + 1), rB0, rB1); g.fill();
    g.fillStyle = cov;
    I.ids.forEach(a => { const v = airOf(I, a); if (!v) return; g.globalAlpha = [0, 0.3, 0.6, 1][v]; band(a, a, rB0, rB1, 1.2); });
    // Inner bars: a thousand's IDs in use beside the busiest thousand's.
    const W = wedges(I, S.scope), most = Math.max(1, ...W.map(w => w.taken)), seam = 1 / rC1, L = rC1 - rC0;
    W.forEach((w, i) => {
      const a0 = ang(i * K) + seam, a1 = ang(i * K + K) - seam;
      g.globalAlpha = 0.12; g.fillStyle = text; sector(a0, a1, rC0, rC1); g.fill();
      if (!w.taken) return;
      let r = rC0;
      [[w.held + w.elsewhere, col.use[0]], [w.slot, col.slot[0]], [w.stranger, col.stranger[0]]].forEach(([n, c]) => {
        if (!n) return;
        const l = Math.max(2, (L * n) / most);
        g.globalAlpha = 1; g.fillStyle = c; sector(a0, a1, r, Math.min(rC1, r + l)); g.fill();
        r = Math.min(rC1, r + l);
      });
    });
    // Ticks a thousand, longer and numbered every ten thousand.
    g.globalAlpha = 1; g.strokeStyle = text; g.lineWidth = 1;
    g.font = `${fs}px system-ui, sans-serif`; g.textBaseline = 'middle';
    const tagged = marked().map(a => ang(a + 0.5));
    for (let w = 0; w < WEDGES; w++) {
      const a = ang(w * K), ux = Math.cos(a), uy = Math.sin(a), len = w % 10 === 0 ? 7 : 3;
      g.beginPath(); g.moveTo(cx + ux * (R + 2), cy + uy * (R + 2)); g.lineTo(cx + ux * (R + 2 + len), cy + uy * (R + 2 + len)); g.stroke();
      if (!w || w % 10 || tagged.some(tt => Math.abs(tt - a) * (R + 12 + fs) < 48)) continue;
      g.fillStyle = text; g.textAlign = 'center'; g.fillText(num(w * K), cx + ux * (R + 14 + fs), cy + uy * (R + 9 + fs));
    }
    g.fillStyle = ink; g.textAlign = 'left'; g.fillText('1', cx + 4, cy - R - 4 - fs);
    g.fillStyle = text; g.textAlign = 'right'; g.fillText(num(MAX), cx - 4, cy - R - 4 - fs);
    // The filter box's ID in amber, cased in the ink, with a pin from outside.
    const hit = cssColour('--hit-ring', '#e8a000'), cas = cssColour('--map-leader-ink', '#1d1402');
    g.lineJoin = 'round';
    marked().forEach(a => {
      const m = ang(a + 0.5), h = Math.max(ang(a + 1) - ang(a), 5 / R) / 2;
      sector(m - h, m + h, rB0 - 2, R + 2);
      g.strokeStyle = cas; g.lineWidth = 4; g.stroke();
      g.strokeStyle = hit; g.lineWidth = 2; g.stroke();
      const ux = Math.cos(m), uy = Math.sin(m), px = -uy * 6, py = ux * 6, r0 = R + 3, r1 = R + 3 + (big ? 18 : 14);
      g.beginPath(); g.moveTo(cx + ux * r0, cy + uy * r0);
      g.lineTo(cx + ux * r1 + px, cy + uy * r1 + py); g.lineTo(cx + ux * r1 - px, cy + uy * r1 - py); g.closePath();
      g.fillStyle = hit; g.fill(); g.strokeStyle = cas; g.lineWidth = 1.5; g.stroke();
    });
    return { base, D, dpr, M, cx, cy, R, rA0, rB0, rB1, rC0, rC1, ink, text };
  }
  const sig = I => `${S.scope}|${marked().join(',')}|${I.rows.map(r => `${r.id}:${r.holders.map(h => h.hub || '').join('.')}:${r.heard.length}:${r.sites.length}:${r.checks.map(c => c.k).join('.')}`).join(',')}`;

  function wheelPins() {
    const el = document.getElementById('a2s-wheel-pins');
    if (!el || !WHEEL) return;
    const { D, M, cx, cy, R, rA0 } = WHEEL, ids = marked();
    const k = `${D}|${ids.join(',')}`;
    if (el.dataset.pins === k) return;
    el.dataset.pins = k;
    const pc = v => `${((100 * v) / D).toFixed(3)}%`, rm = (rA0 + R) / 2, rt = R + M - 20;
    el.innerHTML = ids.map(a => {
      const th = ang(a + 0.5), ux = Math.cos(th), uy = Math.sin(th);
      const tx = Math.max(26, Math.min(D - 26, cx + ux * rt)), ty = Math.max(11, Math.min(D - 11, cy + uy * rt));
      return `<span class="as-pin" style="--x:${pc(cx + ux * rm)};--y:${pc(cy + uy * rm)};--s:${Math.round(R - rA0 + 12)}px"></span>`
        + `<span class="as-pin-tag" style="--x:${pc(tx)};--y:${pc(ty)}">${a}</span>`;
    }).join('');
  }

  function drawWheel(quick) {
    const cv = document.getElementById('a2s-wheel');
    if (!cv) return;
    const I = cur();
    if (!I) return;
    const body = document.getElementById('a2s-wheel-body');
    const D = Math.round(Math.max(240, Math.min(1240, (body && body.clientWidth) || 560)));
    const dpr = window.devicePixelRatio || 1, s0 = sig(I);
    if (!quick || !WHEEL || WHEEL.sig !== s0 || WHEEL.D !== D || WHEEL.dpr !== dpr) {
      WHEEL = Object.assign(wheelBase(I, D, dpr), { sig: s0 });
      cv.width = WHEEL.base.width; cv.height = WHEEL.base.height;
      if (cv.parentElement) cv.parentElement.style.setProperty('--ww', D + 'px');
    }
    wheelPins();
    const { cx, cy, R, rA0, rB0, rB1, rC0, rC1, ink, text } = WHEEL;
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(WHEEL.base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ringAt = { addr: [rA0, R], cover: [rB0, rB1], block: [rC0, rC1] }[S.wRing];
    if (ringAt) {
      g.globalAlpha = 0.45; g.strokeStyle = ink; g.lineWidth = 1;
      [ringAt[0] - 1.5, ringAt[1] + 1.5].forEach(r => { g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke(); });
    }
    const outline = (lo, hi, w, wash = 0.1) => {
      let a0 = ang(lo), a1 = ang(hi + 1);
      if ((a1 - a0) * R < 3) { const m = (a0 + a1) / 2; a0 = m - 1.5 / R; a1 = m + 1.5 / R; }
      g.beginPath(); g.arc(cx, cy, R + 1, a0, a1); g.arc(cx, cy, rC0 - 3, a1, a0, true); g.closePath();
      g.globalAlpha = wash; g.fillStyle = ink; g.fill();
      g.globalAlpha = 0.95; g.strokeStyle = ink; g.lineWidth = w; g.stroke();
    };
    const b = box();
    if (b.range) outline(b.range.lo, b.range.hi, 1.5, 0.06);
    if (S.sel) outline(S.sel.lo, S.sel.hi, 2);
    if (S.wHover != null && S.wAddr != null) outline(S.wAddr, S.wAddr, 1.5);
    else if (S.wHover != null) outline(S.wHover * K, S.wHover * K + K - 1, 1);
    // In the middle: the ID or thousand pointed at, else the kept, else the
    // count.
    const pa = S.wHover != null ? S.wAddr : b.id;
    const c = pa != null ? null : S.wHover != null ? stretch(I, S.scope, S.wHover * K, S.wHover * K + K - 1) : S.sel ? stretch(I, S.scope, S.sel.lo, S.sel.hi) : null;
    const W = wedges(I, S.scope), held = W.reduce((n, w) => n + w.taken, 0);
    const lines = pa != null ? ['ALERT2 ID', String(pa), LABEL[statusOf(I, S.scope, pa)]]
      : c ? [`${num(c.lo)}–${num(c.hi)}`, `${num(c.taken)} in use`, `${num(c.free + c.open)} free`]
        : [scopeName(I), `${num(held)} in use`, `of ${num(MAX)} · ${num(MAX - I.ids.length)} free`];
    const bigF = Math.round(Math.max(15, Math.min(36, R * 0.1))), smallF = Math.round(Math.max(10, Math.min(15, R * 0.046)));
    const room = (rC0 - 8) * 1.8;
    const fit = s1 => { let s2 = s1; while (s2.length > 2 && g.measureText(s2 === s1 ? s2 : s2 + '…').width > room) s2 = s2.slice(0, -1); return s2 === s1 ? s2 : s2 + '…'; };
    g.globalAlpha = 1; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${smallF}px system-ui, sans-serif`; g.fillStyle = text; g.fillText(fit(lines[0]), cx, cy - bigF * 0.95);
    g.font = `600 ${bigF}px system-ui, sans-serif`; g.fillStyle = ink; g.fillText(fit(lines[1]), cx, cy);
    g.font = `${smallF}px system-ui, sans-serif`; g.fillStyle = text; g.fillText(fit(lines[2]), cx, cy + bigF * 0.95);
  }

  function wheelAt(ev) {
    const cv = document.getElementById('a2s-wheel');
    if (!ev || !cv || !WHEEL) return null;
    const bx = cv.getBoundingClientRect();
    if (!bx.width) return null;
    const k = WHEEL.D / bx.width;
    const x = (ev.clientX - bx.left) * k - WHEEL.cx, y = (ev.clientY - bx.top) * k - WHEEL.cy;
    const d = Math.hypot(x, y), { R, rA0, rB0, rB1, rC0, rC1 } = WHEEL;
    if (d < rC0 - 3 || d > R + 12) return null;
    let th = Math.atan2(y, x) + Math.PI / 2;
    if (th < 0) th += 2 * Math.PI;
    const slot = Math.floor((th / (2 * Math.PI)) * SLOTS);
    const ring = d > (rA0 + rB1) / 2 ? 'addr' : d > (rB0 + rC1) / 2 ? 'cover' : 'block';
    // At a pixel the outer rings hold dozens of IDs: snap to an ID in use
    // within a couple of pixels, so one alone in a gap can be pointed at.
    let a = Math.max(1, Math.min(MAX, slot));
    if (ring !== 'block') {
      const I = cur(), near = Math.ceil((2.5 * SLOTS) / (2 * Math.PI * d));
      if (I) {
        const i = lowerBound(I.ids, a - near);
        let best = null;
        for (let j = i; j < I.ids.length && I.ids[j] <= a + near; j++) if (best == null || Math.abs(I.ids[j] - a) < Math.abs(best - a)) best = I.ids[j];
        if (best != null) a = best;
      }
    }
    return { w: Math.min(WEDGES - 1, Math.floor(slot / K)), ring, a };
  }
  function hundredStrip(I, a, mark) {
    const b0 = Math.floor(a / ROW) * ROW;
    let cells = '';
    for (let x = Math.max(1, b0); x < b0 + ROW && x <= MAX; x++) cells += `<rect class="${cls(statusOf(I, S.scope, x))}" x="${x - b0}" y="1" width="0.82" height="8"/>`;
    const m = mark != null && mark >= b0 && mark < b0 + ROW ? `<rect class="as-strip-at" x="${mark - b0 - 0.3}" y="0.7" width="1.42" height="8.6"/>` : '';
    return `<div class="as-strip"><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">${cells}${m}</svg>
      <span class="as-strip-ends"><span>${Math.max(1, b0)}</span><span>${Math.min(MAX, b0 + ROW - 1)}</span></span></div>`;
  }
  function wheelHover(ev) {
    const p = wheelAt(ev);
    const w = p ? p.w : null, ring = p ? p.ring : null, a = p && ring !== 'block' ? p.a : null;
    const tip = document.getElementById('a2s-wheel-tip');
    if (w !== S.wHover || ring !== S.wRing || a !== S.wAddr) {
      S.wHover = w; S.wRing = ring; S.wAddr = a;
      const I = cur();
      if (tip && I && w != null) {
        tip.innerHTML = a != null
          ? `<p class="as-tip-ring">${ring === 'cover' ? 'Middle ring — on air and on file' : 'Outer ring — each ID'}</p><p>${readoutHtml(I, a, true)}</p>${hundredStrip(I, a, a)}`
          : `<p class="as-tip-ring">Inner bars — each thousand</p><p>${stretchText(I, stretch(I, S.scope, w * K, w * K + K - 1))}</p>`;
      }
      document.querySelectorAll('#a2s-wheel-body .as-ring-row').forEach(r => r.classList.toggle('is-on', r.dataset.ring === ring));
      drawWheel(true);
    }
    if (!tip) return;
    if (w == null) { tip.hidden = true; return; }
    tip.hidden = false;
    const bx = tip.parentElement.getBoundingClientRect();
    const x = ev.clientX - bx.left, y = ev.clientY - bx.top, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 16, top = y + 16;
    if (left + tw > bx.width - 4) left = Math.max(4, x - tw - 16);
    if (top + th > bx.height - 4) top = Math.max(4, y - th - 16);
    tip.style.setProperty('--tip-x', `${Math.round(left)}px`);
    tip.style.setProperty('--tip-y', `${Math.round(top)}px`);
  }
  // An ID pressed goes into the filter box (pressed again, comes out); the
  // inner bars keep the thousand, pressed again let go.
  function wheelClick(ev) {
    const p = wheelAt(ev);
    if (!p) return;
    if (p.ring === 'block') {
      const lo = p.w * K, off = S.sel && S.sel.wedge === p.w;
      keep(off ? null : { lo, hi: lo + K - 1, wedge: p.w });
      return;
    }
    S.sel = { lo: p.w * K, hi: p.w * K + K - 1, wedge: p.w };
    pick(box().id === p.a ? null : p.a);
  }
  function wheelKey(ev) {
    const I = cur();
    if (!I) return;
    const fwd = ev.key === 'ArrowRight' || ev.key === 'ArrowDown', back = ev.key === 'ArrowLeft' || ev.key === 'ArrowUp';
    if (ev.shiftKey && (fwd || back)) {
      ev.preventDefault();
      const now = box().id ?? (S.sel ? S.sel.lo : fwd ? 0 : MAX + 1);
      const i = lowerBound(I.ids, now);
      const a = fwd ? (I.ids[I.ids[i] === now ? i + 1 : i] ?? I.ids[0]) : (I.ids[i - 1] ?? I.ids[I.ids.length - 1]);
      if (a == null) return;
      S.sel = { lo: Math.floor(a / K) * K, hi: Math.floor(a / K) * K + K - 1, wedge: Math.floor(a / K) };
      pick(a);
      return;
    }
    const c = S.sel && S.sel.wedge != null ? S.sel.wedge : null;
    let w;
    if (fwd) w = c == null ? 0 : (c + 1) % WEDGES;
    else if (back) w = c == null ? WEDGES - 1 : (c + WEDGES - 1) % WEDGES;
    else if (ev.key === 'Home') w = 0;
    else if (ev.key === 'End') w = WEDGES - 1;
    else if (ev.key === 'Escape' && S.sel) w = null;
    else return;
    ev.preventDefault();
    keep(w == null ? null : { lo: w * K, hi: w * K + K - 1, wedge: w });
  }

  // ── 6. the grid ────────────────────────────────────────────────────────────
  const gridKs = I => {
    const b = box(), extra = [];
    if (b.id != null) extra.push(b.id);
    if (b.range && b.range.hi - b.range.lo < 5 * K) extra.push(b.range.lo, b.range.hi);
    if (S.sel) extra.push(Math.max(1, S.sel.lo), S.sel.hi - S.sel.lo < 5 * K ? S.sel.hi : S.sel.lo);
    if (A2() && A2().getFrom) extra.push(A2().getFrom());
    return thousands(I, extra);
  };
  function gridHtml() {
    const I = cur();
    if (!I || !I.rows.length) return '';
    const ks = gridKs(I);
    const hundreds = [];
    ks.forEach(k => { for (let r = 0; r < 10; r++) { const lo = k * K + r * ROW, c = stretch(I, S.scope, lo, lo + ROW - 1); if (c.taken) hundreds.push(c); } });
    return `<div class="control-row as-controls">
        ${scopeSelectHtml(I)}
        <label>ID <input type="number" id="a2s-look" class="field-num" min="1" max="${MAX}" inputmode="numeric" value="${box().id ?? ''}"
          oninput="Alert2Space.lookup(this.value)" placeholder="11047"></label>
      </div>
      <p class="small">The thousands with anything in them${ks.length > I.busyK.size ? ', and the one the filter box, the wheel or the free-ID finder points at' : ''}: a row is a block of a hundred —
        11,000 to 11,099 — and the bar at its end how many of them are in use. Point at an ID to see whose it is; press one, or type it in ID, and it goes into the
        filter box above, marked here and on the wheel, and the table below filtered to it.</p>
      <p class="small sr-keys">${statusKeysHtml(I)}${hitKey}</p>
      <div class="chart-scroll as-grid-wrap" role="region" tabindex="0" aria-label="The ALERT2 ID grid — scroll sideways for the whole of it">
        <div class="as-grid-box">
          <canvas id="a2s-grid" role="img" aria-label="${escAttr(`ALERT2 IDs ${ks.map(k => `${num(k * K)}–${num(k * K + K - 1)}`).join(', ')}, a hundred to a row, for ${scopeName(I)}. The table under the grid holds the same, a hundred at a time.`)}"
            onmousemove="Alert2Space.gridHover(event)" onmouseleave="Alert2Space.gridHover(null)" onclick="Alert2Space.gridClick(event)"></canvas>
          <div id="a2s-grid-pins" class="as-pins" aria-hidden="true"></div>
        </div>
      </div>
      <div id="a2s-grid-out" class="small as-readout" aria-live="polite">${gridOutHtml(I)}</div>
      <details class="sr-fold"><summary>Hundred by hundred — the same as a table</summary>
        <div class="table-wrap tall" role="region" tabindex="0" aria-label="ALERT2 IDs, hundred by hundred">
        <table class="hl-table"><caption class="sr-only">Each block of a hundred ALERT2 IDs with anything in it</caption>
          <thead><tr><th scope="col">Block</th><th scope="col" class="num">${t('use', 'In use')}</th>${S.scope !== 'all' ? `<th scope="col" class="num">${t('elsewhere', 'Other hubs')}</th>` : ''}
            <th scope="col" class="num">${t('slot', 'Slot table only')}</th><th scope="col" class="num">${t('stranger', 'Heard, no station')}</th><th scope="col" class="num">Free</th><th scope="col">Stations</th></tr></thead>
          <tbody>${hundreds.map(c => `<tr><th scope="row">${num(c.lo)}–${num(c.hi)}</th><td class="num">${num(c.held)}</td>${S.scope !== 'all' ? `<td class="num">${num(c.elsewhere)}</td>` : ''}
            <td class="num">${num(c.slot)}</td><td class="num">${num(c.stranger)}</td><td class="num">${num(c.free + c.open)}</td>
            <td class="small">${esc(c.names.slice(0, 4).join(', ')) || '—'}${c.names.length > 4 ? ` and ${num(c.names.length - 4)} more` : ''}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  function gridOutHtml(I) {
    const a = S.gHover ?? box().id;
    if (a != null) return `${a === box().id && S.gHover == null ? '<span class="as-hit-sw" aria-hidden="true"></span>In the filter box: ' : ''}${readoutHtml(I, a)}`;
    const b = box();
    if (b.range) return `<span class="as-hit-sw" aria-hidden="true"></span>In the filter box: ${stretchText(I, stretch(I, S.scope, b.range.lo, b.range.hi))}`;
    return 'Point at an ID, or type one above.';
  }

  function drawGrid() {
    const cv = document.getElementById('a2s-grid');
    if (!cv) return;
    const I = cur();
    if (!I) return;
    const ks = gridKs(I);
    const rows = [];
    ks.forEach(k => { for (let r = 0; r < 10; r++) rows.push(k * K + r * ROW); });
    const wrap = cv.closest('.as-grid-wrap');
    const avail = Math.max(320, Math.floor((wrap && wrap.getBoundingClientRect().width) || 760));
    const GAP = 6, BAR0 = 60;
    const g = cv.getContext('2d');
    const fit = (lab, padr) => Math.max(4, Math.floor((avail - lab - GAP - GAP - BAR0 - padr) / ROW));
    const fs = Math.max(9, Math.min(13, Math.round(fit(52, 28) * 0.85))), font = `${fs}px system-ui, sans-serif`;
    g.font = font;
    const LAB = Math.max(44, Math.ceil(g.measureText('65,500').width) + 10), PADR = Math.max(24, Math.ceil(g.measureText('100').width) + 8);
    const cell = fit(LAB, PADR);
    const BAR = Math.max(BAR0, avail - (LAB + GAP + cell * ROW + GAP + PADR));
    const W = LAB + GAP + cell * ROW + GAP + BAR + PADR;
    const TOP = fs + 5, KG = Math.max(fs + 6, Math.round(cell * 1.6));
    // A thousand's ten rows together, a gap with its name between thousands.
    const yOf = i => TOP + i * cell + Math.floor(i / 10) * KG;
    const H = yOf(rows.length) + 4;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.setProperty('--gw', W + 'px'); cv.style.setProperty('--gh', H + 'px');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const col = colours(), text = cssColour('--muted', '#7a8794'), ink = cssColour('--text', '#16202a');
    const inner = cell - (cell >= 12 ? 2 : cell >= 5 ? 1 : 0);
    g.font = font; g.fillStyle = text; g.textBaseline = 'middle';
    for (let c = 0; c < ROW; c += 10) g.fillText(String(c).padStart(2, '0'), LAB + GAP + c * cell, Math.round(TOP / 2) - 1);
    rows.forEach((lo, i) => {
      const y = yOf(i);
      if (i % 10 === 0 && i) { g.globalAlpha = 1; g.fillStyle = text; g.textAlign = 'left'; g.fillText('⋯', 4, y - KG / 2); }
      g.globalAlpha = 1; g.fillStyle = i % 10 === 0 ? ink : text; g.textAlign = 'right';
      if (i % 10 === 0 || i % 5 === 0 || cell >= 10) g.fillText(num(lo), LAB, y + cell / 2);
      g.textAlign = 'left';
      let n = 0;
      for (let c = 0; c < ROW; c++) {
        const a = lo + c, st = statusOf(I, S.scope, a);
        if (st === 'void') continue;
        if (INKED.includes(st)) n++;
        const [fill, alpha] = col[st];
        g.globalAlpha = alpha; g.fillStyle = fill;
        g.fillRect(LAB + GAP + c * cell, y, inner, inner);
      }
      const bx = LAB + GAP + ROW * cell + GAP;
      g.globalAlpha = 0.14; g.fillStyle = text; g.fillRect(bx, y, BAR, inner);
      if (n) {
        g.globalAlpha = 1; g.fillStyle = col.use[0]; g.fillRect(bx, y, Math.max(2, (BAR * n) / ROW), inner);
        if (cell >= 8) { g.fillStyle = text; g.fillText(String(n), bx + BAR + 4, y + cell / 2); }
      }
    });
    g.globalAlpha = 1;
    const rowOf = new Map(rows.map((lo, i) => [lo, i]));
    const at = a => { const i = rowOf.get(Math.floor(a / ROW) * ROW); return i == null ? null : { x: LAB + GAP + (a % ROW) * cell, y: yOf(i), i }; };
    const hov = S.gHover != null && at(S.gHover);
    if (hov) { g.strokeStyle = ink; g.lineWidth = 1; g.strokeRect(hov.x - 1, hov.y - 1, inner + 2, inner + 2); }
    // A stretch outlined once in each thousand it touches — its first row
    // from where it starts, its last to where it ends, every row between
    // whole: the kept one in ink, a range typed in the filter box in amber.
    const outline = (lo, hi, colour, w) => {
      g.strokeStyle = colour; g.lineWidth = w;
      const xl = c => LAB + GAP + c * cell - 1.5, xr = c => LAB + GAP + c * cell + inner + 1.5, yt = i => yOf(i) - 1.5, yb = i => yOf(i) + inner + 1.5;
      for (let i0 = 0; i0 < rows.length; i0 += 10) {
        const k0 = rows[i0], a0 = Math.max(lo, k0), a1 = Math.min(hi, k0 + K - 1);
        if (a0 > a1) continue;
        const r0 = i0 + Math.floor((a0 - k0) / ROW), r1 = i0 + Math.floor((a1 - k0) / ROW), c0 = a0 % ROW, c1 = a1 % ROW;
        g.beginPath();
        if (r0 === r1) g.rect(xl(c0), yt(r0), xr(c1) - xl(c0), yb(r0) - yt(r0));
        else {
          g.moveTo(xl(c0), yt(r0)); g.lineTo(xr(ROW - 1), yt(r0)); g.lineTo(xr(ROW - 1), yb(r1 - 1)); g.lineTo(xr(c1), yb(r1 - 1));
          g.lineTo(xr(c1), yb(r1)); g.lineTo(xl(0), yb(r1)); g.lineTo(xl(0), yt(r0 + 1)); g.lineTo(xl(c0), yt(r0 + 1)); g.closePath();
        }
        g.stroke();
      }
    };
    const hit = cssColour('--hit-ring', '#e8a000'), cas = cssColour('--map-leader-ink', '#1d1402');
    const b = box();
    if (S.sel) outline(S.sel.lo, S.sel.hi, ink, 1.5);
    if (b.range) outline(b.range.lo, b.range.hi, hit, 2);
    g.lineJoin = 'round';
    marked().forEach(a => {
      const p = at(a);
      if (!p) return;
      const mx = p.x + inner / 2;
      g.strokeStyle = cas; g.lineWidth = 4; g.strokeRect(p.x - 2, p.y - 2, inner + 4, inner + 4);
      g.strokeStyle = hit; g.lineWidth = 2; g.strokeRect(p.x - 2, p.y - 2, inner + 4, inner + 4);
      g.fillStyle = hit; g.strokeStyle = cas; g.lineWidth = 1;
      g.beginPath(); g.moveTo(LAB + 1, p.y - 1); g.lineTo(LAB + GAP, p.y + inner / 2); g.lineTo(LAB + 1, p.y + inner + 1); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(mx - 4, TOP - 7); g.lineTo(mx + 4, TOP - 7); g.lineTo(mx, TOP - 1); g.closePath(); g.fill(); g.stroke();
    });
    const pins = document.getElementById('a2s-grid-pins'), k = `${cell}|${rows.length}|${marked().join(',')}`;
    if (pins && pins.dataset.pins !== k) {
      pins.dataset.pins = k;
      pins.innerHTML = marked().map(a => { const p = at(a); return p ? `<span class="as-pin is-cell" style="--x:${p.x + inner / 2}px;--y:${p.y + inner / 2}px;--s:${inner + 14}px"></span>` : ''; }).join('');
    }
    GRID = { LAB, GAP, cell, yOf, rows };
  }
  function gridAddr(ev) {
    const cv = document.getElementById('a2s-grid');
    if (!ev || !cv || !GRID) return null;
    const bx = cv.getBoundingClientRect();
    const x = ev.clientX - bx.left - GRID.LAB - GRID.GAP, y = ev.clientY - bx.top;
    if (x < 0 || x >= GRID.cell * ROW) return null;
    for (let i = 0; i < GRID.rows.length; i++) {
      if (y >= GRID.yOf(i) && y < GRID.yOf(i) + GRID.cell) {
        const a = GRID.rows[i] + Math.floor(x / GRID.cell);
        return a >= 1 && a <= MAX ? a : null;
      }
    }
    return null;
  }
  function gridHover(ev) {
    const a = gridAddr(ev);
    if (a === S.gHover) return;
    S.gHover = a;
    const I = cur(), out = document.getElementById('a2s-grid-out');
    if (out && I) out.innerHTML = gridOutHtml(I);
    drawGrid();
  }
  function gridClick(ev) {
    const a = gridAddr(ev);
    if (a == null) return;
    S.gHover = null;
    pick(box().id === a ? null : a);
  }
  function lookup(v) {
    const a = v === '' || v == null ? null : Math.round(Number(v));
    if (a == null || (a >= 1 && a <= MAX)) { pick(a); return; }
    const I = cur(), out = document.getElementById('a2s-grid-out');
    if (out && I) out.innerHTML = readoutHtml(I, a);
  }

  // ── 7. linking ─────────────────────────────────────────────────────────────
  // An ID into the page's filter box, as typing it there would; null empties
  // the box of an ID (a name or range typed there is left alone).
  function pick(a) {
    const x = A2();
    if (!x) return;
    if (a == null && box().id == null) { refresh(); return; }
    x.setFilter(a == null ? '' : String(a));
  }
  // What the filter box changed, followed onto both pictures.
  function onFilter() {
    const b = box();
    if (b.id != null) { const w = Math.floor(b.id / K); S.sel = { lo: w * K, hi: w * K + K - 1, wedge: w }; }
    const look = document.getElementById('a2s-look');
    if (look && look !== document.activeElement) look.value = b.id ?? '';
    refresh();
  }
  function keep(sel) {
    S.sel = sel;
    refresh();
  }
  function gapPick(lo, hi) {
    const off = S.sel && S.sel.gap && S.sel.lo === lo;
    S.sel = off ? null : { lo, hi, gap: true };
    if (!off && A2() && A2().onFrom) { const f = document.getElementById('a2i-from'); if (f) f.value = lo; A2().onFrom(lo); }
    refreshCards();
  }
  function findFrom(a) {
    const f = document.getElementById('a2i-from');
    if (f) f.value = a;
    if (A2()) A2().onFrom(a);
    if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    refreshCards();
  }
  function toGrid(a) {
    if (a != null && box().id !== a && S.sel && !(a >= S.sel.lo && a <= S.sel.hi)) S.sel = null;
    refreshCards();
    const el = document.getElementById('a2s-grid-card');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function setScope(v) {
    S.scope = v === 'all' || /^hub:/.test(String(v)) ? String(v) : 'all';
    refreshCards();
  }
  // The readouts and the drawings only: cheap, on every keystroke.
  function refresh() {
    const I = cur();
    if (!I) return;
    const wo = document.getElementById('a2s-wheel-out');
    if (wo) wo.innerHTML = wheelOutHtml(I);
    const go = document.getElementById('a2s-grid-out');
    if (go) go.innerHTML = gridOutHtml(I);
    document.querySelectorAll('.a2s-gaps .pill').forEach(btn => btn.setAttribute('aria-pressed', String(!!(S.sel && S.sel.gap && Number(btn.dataset.lo) === S.sel.lo))));
    drawWheel(true);
    // The grid's thousands follow the box and the wheel: its body redrawn
    // when they change, else just the canvas.
    if (S.gridKs !== gridKs(I).join(',')) refreshGrid(); else drawGrid();
  }
  function refreshGrid() {
    const el = document.getElementById('a2s-grid-body');
    if (!el) return;
    S.gHover = null;
    el.innerHTML = gridHtml();
    drawGrid();
    const I = cur();
    if (I) S.gridKs = gridKs(I).join(',');
  }
  function refreshCards() {
    const el = document.getElementById('a2s-wheel-body');
    if (el) { S.wHover = null; S.wRing = null; S.wAddr = null; el.innerHTML = wheelHtml(); }
    drawWheel();
    refreshGrid();
  }

  // ── 8. the cards ───────────────────────────────────────────────────────────
  function cardHtml(id, title, sub, body) {
    return `<div class="panel as-panel" id="a2s-${id}-card">
        <div class="panel-header"><h2 id="a2s-${id}-h">${title}</h2><span class="small">${sub}</span></div>
        <div id="a2s-${id}-body">${body}</div>
      </div>`;
  }
  function cardsHtml() {
    const I = cur();
    if (!I || !I.rows.length) return '';
    return cardHtml('wheel', 'All ALERT2 IDs', 'every ALERT2 ID round one wheel — where the gaps are', wheelHtml())
      + cardHtml('grid', 'ALERT2 ID grid', 'the thousands in use, a hundred to a row', gridHtml());
  }
  // Drawn once the cards are on the page, and again when a card's width
  // changes.
  function init() {
    if (typeof document === 'undefined') return;
    drawWheel();
    drawGrid();
    const I = cur();
    if (I) S.gridKs = gridKs(I).join(',');
    if (S.ro) S.ro.disconnect();
    S.ro = null;
    const els = ['a2s-wheel-body', 'a2s-grid-body'].map(id => document.getElementById(id)).filter(Boolean);
    if (!els.length || typeof ResizeObserver === 'undefined') return;
    const wide = new Map();
    S.ro = new ResizeObserver(es => es.forEach(e => {
      const w = Math.round(e.contentRect.width), seen = wide.has(e.target);
      if (wide.get(e.target) === w) return;
      wide.set(e.target, w);
      if (!seen) return;
      if (e.target.id === 'a2s-grid-body') drawGrid(); else drawWheel(true);
    }));
    els.forEach(el => S.ro.observe(el));
  }
  function stop() { if (S.ro) { S.ro.disconnect(); S.ro = null; } }

  // For tests and tours: what is kept and shown.
  function state_() { return { scope: S.scope, sel: S.sel, box: box(), grid: GRID ? GRID.rows.slice() : null }; }

  return { WORDS, GLOSSARY, cardsHtml, init, stop, onFilter, setScope, lookup, keep, gapPick, findFrom, toGrid,
           wheelHover, wheelClick, wheelKey, gridHover, gridClick, state: state_,
           // Pure, for the tests.
           index, statusOf, airOf, stretch, wedges, gaps, thousands, boxOf, sensorsHtml };
})();
if (typeof window !== 'undefined') window.Alert2Space = Alert2Space;
