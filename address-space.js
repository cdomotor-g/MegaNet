// MegaNet — address-space.js
//
//   AddressSpace   the Pass Ranges tab's pictures of the ALERT address space,
//                  and its Allocate card:
//                    * Allocate an ALERT address — pick where a new station
//                      will report through (a repeater, anywhere in a radio
//                      network, or straight to a base in a hub), how many
//                      addresses, and what for; the card suggests the free run
//                      that fits best and sets it aside in the datastore
//                      (0084, editors). The addresses set aside are listed
//                      under it, each with what it is for and whether a station
//                      has taken it up yet, and released from there.
//                    * Each repeater — its pass ranges drawn as Signal Routes
//                      draws them, squeezed to scale, with every address in
//                      them marked in use, held by two stations, set aside, or
//                      left as the band: free. How full each is, worst first.
//                    * Each radio network — the same over the union of its
//                      repeaters' ranges, with a lane a repeater underneath, so
//                      which repeater carries which block, and where two carry
//                      the same, is there to see; a table of the networks first.
//                    * All addresses — the same 8,191 bent round one wheel, 1 at
//                      the top and clockwise, a wedge a block of a hundred: each
//                      address to scale, how many repeaters carry it, and how
//                      full each block is, so a gap shows as a gap. Point at a
//                      wedge for the repeaters that carry any of it. For a hub,
//                      a radio network, or every hub together.
//                    * Address grid — all 8,191 addresses, a hundred to a row,
//                      for a hub, a radio network or every hub together, each
//                      row with how full that block of a hundred is. Point at
//                      one to say whose it is.
//                    * Map — the repeaters as numbered circles: the free
//                      addresses they carry, counted once however many of them
//                      carry each. Circles merge as you zoom out, so the number
//                      on one is what a region has left, and break apart as you
//                      zoom in.
//
// ── What "free" means here ───────────────────────────────────────────────────
// A legacy ALERT address is 13 bits, 1 to 8,191, and the Bureau's hubs reuse
// them: Brisbane's 6039 is a river gauge, Perth's an orchard. Inside a hub an
// address belongs to one station — the register has ten that break that, each
// a station entered twice. So an address is **in use** in a hub when a station
// there holds it, **set aside** when a live allocation (0084) holds it and no
// station does yet, and **free** otherwise; a scope that spans two hubs (the
// Emerald network does) asks both. Every hub together is the one scope that
// does not: an address is **in use** there when a station in any hub holds
// it — the wheel and the grid shade it by how many hubs do — **held by two**
// only when two stations in one hub hold it, and **free** only when no hub's
// station holds it and nobody has set it aside. The register is the station file in
// memory, so an address saved onto a sensor a minute ago is already in use
// here; an allocation is the datastore's, read when the tab opens, for signed-in
// accounts the database approves.
//
// After core.js (state, esc, escAttr, num-free helpers, csvEscape, dlText,
// registerTabTeardown, registerLiveMap, removeMap, announce), app.js
// (stationAlertIds, passRangeCoversId, passRelationIndex, prepareSearch,
// goToStation), datastore.js (dbSelect, dbRpc, dbCanWrite), auth.js (Auth),
// modal.js (confirmDialog), map-controls.js (addBaseLayers) and pass-ranges.js
// (passRangeRepeaterMatch, findStationMatches via app.js), all read at call
// time; before init.js. Nothing runs at load: pass-ranges.js draws the shells
// and app.js's renderMain calls init().

const AddressSpace = (() => {

  const MAX = 8191, ROW = 100, ROWS = 82, PAGE = 12, MAX_ALLOC = 16;
  const VIEW_KEY = 'meganet.pr-space-view';
  const VIEWS = [
    { id: 'repeaters', label: 'Each repeater' },
    { id: 'networks',  label: 'Each radio network' },
    { id: 'wheel',     label: 'All addresses' },
    { id: 'grid',      label: 'Address grid' },
    { id: 'map',       label: 'Map' },
  ];
  const WORD = {
    use: 'in use', clash: 'held by two stations', alloc: 'set aside', free: 'free',
    direct: 'in use, carried by no repeater here', open: 'free, carried by no repeater here', out: 'outside this network\'s ranges',
    hub1: 'in use in one hub', hub2: 'in use in two hubs', hub3: 'in use in three hubs or more',
  };

  const S = {
    view: (() => { try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.some(x => x.id === v) ? v : 'repeaters'; } catch (_) { return 'repeaters'; } })(),
    sort: 'busiest',       // busiest | fullest | freest | name
    shown: PAGE,
    only: null,            // a repeater shown on its own (from the map)
    scope: null,           // the grid's: 'hub:<id>' | 'net:<id>'
    pickAddr: null,        // the grid's picked address
    hoverAddr: null,
    wheelSel: null,        // the wheel's kept stretch: { lo, hi, wedge } or { lo, hi, gap }
    wheelHover: null,      // the wedge pointed at
    mapCount: 'free',      // free | use | alloc
    hubLines: true,
    alloc: { phase: 'idle', rows: [], err: '' },   // idle | loading | ready | signedout | denied | missing | error
    form: { where: '', count: 2, first: '', purpose: '', station: '' },
    busy: false,
    msg: null,             // { ok, text }
    map: null, layer: null, hubLayer: null, hubData: null, fitted: false,
    idx: null, idxKey: null, idxData: null, idxRows: null,
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;
  const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 0);
  const data = () => (typeof state !== 'undefined' && state.data) || null;
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const mayWrite = () => signedIn() && (typeof dbCanWrite !== 'function' || dbCanWrite())
    && (typeof Auth.mayWrite !== 'function' || Auth.mayWrite());
  const idsOf = s => (typeof stationAlertIds === 'function' ? stationAlertIds(s)
    : [...new Set((s.sensors || []).map(x => Number(x.alert_id)).filter(Number.isFinite))]);
  const covers = (rep, a) => (typeof passRangeCoversId === 'function' ? passRangeCoversId(rep, a)
    : ((rep && rep.pass_ranges) || []).some(r => a >= r.low && a <= r.high
      && !((rep && rep.exclusions) || []).some(e => a >= e.low && a <= e.high)));
  const day = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // A sorted list of addresses as runs: 5740–5743, 5750. With max, the
  // first max runs and an ellipsis.
  function runsText(addrs, max) {
    const out = [];
    [...addrs].sort((a, b) => a - b).forEach(a => {
      const l = out[out.length - 1];
      if (l && a === l[1] + 1) l[1] = a; else out.push([a, a]);
    });
    const t = out.map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}–${hi}`));
    return max && t.length > max ? `${t.slice(0, max).join(', ')}, …` : t.join(', ');
  }

  // ── The index ─────────────────────────────────────────────────────────────
  // Built once per station file and per read of the allocations, and kept: the
  // pictures, the card and the map all ask it the same few questions.

  function index() {
    const D = data();
    if (!D || !Array.isArray(D.stations)) return null;
    const key = typeof passRelationIndex === 'function' ? passRelationIndex() : null;
    if (S.idx && S.idxData === D && S.idxKey === key && S.idxRows === S.alloc.rows) return S.idx;

    const hubs = new Map((D.hubs || []).map(h => [h.id, h]));
    const nets = new Map((D.radio_networks || []).map(n => [n.id, n]));
    const byId = new Map(D.stations.map(s => [s.id, s]));
    const hubOf = s => (s && s.hub_id) || '';

    // hub → address → the stations there holding it
    const held = new Map();
    D.stations.forEach(s => {
      const ids = idsOf(s).filter(a => a >= 1 && a <= MAX);
      if (!ids.length) return;
      const h = hubOf(s);
      let m = held.get(h);
      if (!m) held.set(h, m = new Map());
      ids.forEach(a => { const l = m.get(a); if (!l) m.set(a, [s]); else if (!l.includes(s)) l.push(s); });
    });

    // hub → address → the live allocation holding it
    const allocs = new Map();
    (S.alloc.rows || []).forEach(r => {
      if (r.released_at) return;
      let m = allocs.get(r.hub_id);
      if (!m) allocs.set(r.hub_id, m = new Map());
      m.set(Number(r.alert_id), r);
    });

    const reps = D.stations
      .filter(s => (s.roles || []).includes('repeater') && s.repeater && (s.repeater.pass_ranges || []).length)
      .map(st => {
        const seen = new Set();
        (st.repeater.pass_ranges || []).forEach(p => {
          for (let a = Math.max(1, p.low); a <= Math.min(MAX, p.high); a++) if (!seen.has(a) && covers(st.repeater, a)) seen.add(a);
        });
        return {
          id: st.id, st, name: st.name, hub: hubOf(st), nets: (st.radio_network_ids || []).filter(n => nets.has(n)),
          ranges: (st.repeater.pass_ranges || []).filter(p => p.high >= p.low),
          excl: st.repeater.exclusions || [],
          carried: [...seen].sort((a, b) => a - b),
        };
      });
    const repById = new Map(reps.map(r => [r.id, r]));
    const coverBy = new Map();
    reps.forEach(r => r.carried.forEach(a => { const l = coverBy.get(a); if (l) l.push(r); else coverBy.set(a, [r]); }));

    const I = { D, hubs, nets, byId, held, allocs, reps, repById, coverBy, scopes: new Map(), tallies: new Map() };

    // Scopes: a repeater, a radio network (and the repeaters on none, a group
    // a hub), a hub. Each says which hubs it asks and which addresses it holds.
    reps.forEach(r => scopeAdd(I, { id: 'rep:' + r.id, kind: 'rep', name: r.name, hubs: [r.hub], reps: [r], addrs: r.carried }));
    const majority = rs => {
      const c = new Map();
      rs.forEach(r => c.set(r.hub, (c.get(r.hub) || 0) + 1));
      return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
    };
    const union = rs => [...new Set(rs.flatMap(r => r.carried))].sort((a, b) => a - b);
    I.groups = [];
    (D.radio_networks || []).forEach(n => {
      const rs = reps.filter(r => r.nets.includes(n.id));
      if (!rs.length) return;
      I.groups.push(scopeAdd(I, { id: 'net:' + n.id, kind: 'net', name: n.name, hubs: majority(rs), reps: rs, addrs: union(rs) }));
    });
    const loose = new Map();
    reps.filter(r => !r.nets.length).forEach(r => { const l = loose.get(r.hub); if (l) l.push(r); else loose.set(r.hub, [r]); });
    loose.forEach((rs, h) => I.groups.push(scopeAdd(I, {
      id: 'net:_none_' + (h || 'nohub'), kind: 'net', name: `No radio network — ${hubName(I, h)}`, hubs: [h], reps: rs, addrs: union(rs), loose: true,
    })));
    I.hubList = [...new Set([...held.keys(), ...reps.map(r => r.hub)])].filter(h => h && hubs.has(h))
      .sort((a, b) => ((hubs.get(a).ord ?? 0) - (hubs.get(b).ord ?? 0)) || hubName(I, a).localeCompare(hubName(I, b)));
    I.hubList.forEach(h => {
      const rs = reps.filter(r => r.hub === h);
      scopeAdd(I, { id: 'hub:' + h, kind: 'hub', name: hubName(I, h), hubs: [h], reps: rs, addrs: null, carriedSet: new Set(union(rs)) });
    });
    scopeAdd(I, { id: 'all', kind: 'all', name: 'Every hub together', hubs: I.hubList.slice(), reps, addrs: null, carriedSet: new Set(union(reps)) });

    S.idx = I; S.idxData = D; S.idxKey = key; S.idxRows = S.alloc.rows;
    return I;
  }

  function scopeAdd(I, sc) {
    if (sc.addrs) sc.set = new Set(sc.addrs);
    I.scopes.set(sc.id, sc);
    return sc;
  }
  function hubName(I, h) { const x = h && I.hubs.get(h); return x ? x.name : h ? h : 'no hub'; }

  function holders(I, hubs, a) {
    const out = [];
    hubs.forEach(h => { const l = I.held.get(h) && I.held.get(h).get(a); if (l) l.forEach(s => { if (!out.includes(s)) out.push(s); }); });
    return out;
  }
  function allocOf(I, hubs, a) {
    for (const h of hubs) { const r = I.allocs.get(h) && I.allocs.get(h).get(a); if (r) return r; }
    return null;
  }
  function status(I, hubs, a) {
    let n = 0;
    for (const h of hubs) { const l = I.held.get(h) && I.held.get(h).get(a); if (l) n += l.length; }
    if (n > 1) return 'clash';
    if (n === 1) return 'use';
    return allocOf(I, hubs, a) ? 'alloc' : 'free';
  }
  // Every hub together: two stations on an address are two only inside one
  // hub; across hubs they are the reuse the address space is built for.
  function hubsUsing(I, sc, a) {
    let n = 0, two = false;
    for (const h of sc.hubs) { const l = I.held.get(h) && I.held.get(h).get(a); if (l) { n++; if (l.length > 1) two = true; } }
    return { n, two };
  }
  function scopeStatus(I, sc, a) {
    if (sc.kind !== 'all') return status(I, sc.hubs, a);
    const u = hubsUsing(I, sc, a);
    return u.two ? 'clash' : u.n ? 'use' : allocOf(I, sc.hubs, a) ? 'alloc' : 'free';
  }
  // A scope of every address — a hub, or every hub together — rather than a
  // network's ranges.
  const whole = sc => sc.kind === 'hub' || sc.kind === 'all';
  // The finer word the grid uses: in a hub, an address no repeater there
  // carries is somebody's straight to a base, or free only for one that will
  // be; every hub together, in use in how many hubs.
  function cellStatus(I, sc, a) {
    if (a < 1 || a > MAX) return 'void';
    if (sc.kind === 'all') {
      const u = hubsUsing(I, sc, a);
      if (u.two) return 'clash';
      if (u.n) return u.n >= 3 ? 'hub3' : u.n === 2 ? 'hub2' : 'hub1';
      return allocOf(I, sc.hubs, a) ? 'alloc' : sc.carriedSet.has(a) ? 'free' : 'open';
    }
    if (sc.kind === 'hub') {
      const st = status(I, sc.hubs, a), carried = sc.carriedSet.has(a);
      return carried ? st : st === 'use' ? 'direct' : st === 'free' ? 'open' : st;
    }
    return sc.set.has(a) ? status(I, sc.hubs, a) : 'out';
  }
  function addrsOf(sc) {
    if (sc.addrs) return sc.addrs;
    const all = [];
    for (let a = 1; a <= MAX; a++) all.push(a);
    return all;
  }

  function tally(I, sc) {
    let t = I.tallies.get(sc.id);
    if (t) return t;
    t = { n: 0, use: 0, clash: 0, alloc: 0, free: 0 };
    addrsOf(sc).forEach(a => { t.n++; t[scopeStatus(I, sc, a)]++; });
    t.taken = t.use + t.clash + t.alloc;
    t.full = pct(t.taken, t.n);
    t.runs = freeRuns(I, sc);
    t.longest = t.runs.reduce((b, r) => (!b || r.n > b.n ? r : b), null);
    I.tallies.set(sc.id, t);
    return t;
  }
  function freeRuns(I, sc) {
    const runs = [];
    let cur = null;
    addrsOf(sc).forEach(a => {
      if (scopeStatus(I, sc, a) !== 'free') { cur = null; return; }
      if (cur && a === cur.hi + 1) { cur.hi = a; cur.n++; } else runs.push(cur = { lo: a, hi: a, n: 1 });
    });
    return runs;
  }
  // The smallest free run that fits, lowest first among equals: a big block
  // is kept for the station that needs a big block.
  function bestFit(runs, count) {
    return runs.filter(r => r.n >= count).sort((p, q) => (p.n - q.n) || (p.lo - q.lo))[0] || null;
  }
  const fullCls = f => (f >= 80 ? 'as-f-high' : f >= 50 ? 'as-f-mid' : 'as-f-low');

  // ── The pictures ──────────────────────────────────────────────────────────

  function searchIds() {
    if (typeof prepareSearch !== 'function' || typeof state === 'undefined' || !state.prFilter) return [];
    try { return prepareSearch(state.prFilter).nums.map(Number).filter(a => a >= 1 && a <= MAX); } catch (_) { return []; }
  }

  // The address space a scope's ranges cover, squeezed as Signal Routes
  // squeezes a repeater's (rulerHtml there): each run of carried addresses a
  // band to scale, the empty stretch between bands cut out, and every address
  // in them in use, held twice or set aside drawn over the band. With lanes,
  // a thin band a repeater underneath on the same axis.
  function rulerSvg(I, sc, lanes) {
    const addrs = sc.addrs || [];
    if (!addrs.length) return '';
    const W = 760, GUT = lanes ? 150 : 8, CH = 5.4;
    const spans = [];
    addrs.forEach(a => { const l = spans[spans.length - 1]; if (l && a === l[1] + 1) l[1] = a; else spans.push([a, a]); });
    const segs = [];
    spans.forEach(([lo, hi]) => { const last = segs[segs.length - 1]; if (last && lo <= last.hi + 20) last.hi = Math.max(last.hi, hi); else segs.push({ lo, hi }); });
    const width = segs.reduce((t, s) => t + (s.hi - s.lo + 1), 0);
    const GAPW = Math.min(14, Math.max(3, ((W - GUT - 8) * 0.25) / Math.max(1, segs.length - 1)));
    // At most 9 px an address, so a repeater passing three addresses draws
    // as three addresses rather than as the whole width.
    const scale = Math.min(9, (W - GUT - 8 - GAPW * (segs.length - 1)) / width);
    let x = GUT;
    segs.forEach(s => { s.x = x; x += (s.hi - s.lo + 1) * scale + GAPW; });
    const xOf = a => { const s = segs.find(q => a >= q.lo && a <= q.hi); return s ? s.x + (a - s.lo + 0.5) * scale : null; };
    const rect = (lo, hi, y, h, cls, tip) => {
      const x0 = xOf(lo), x1 = xOf(hi);
      if (x0 == null || x1 == null) return '';
      return `<rect class="${cls}" x="${(x0 - scale / 2).toFixed(1)}" y="${y}" width="${Math.max(1.2, x1 - x0 + scale).toFixed(1)}" height="${h}">${tip ? `<title>${esc(tip)}</title>` : ''}</rect>`;
    };
    const who = a => holders(I, sc.hubs, a).map(s => s.name).join(' and ');
    const tip = (lo, hi, st) => {
      const span = lo === hi ? String(lo) : `${lo}–${hi}`;
      if (st === 'alloc') { const r = allocOf(I, sc.hubs, lo); return `${span}: set aside${r ? ` — ${r.purpose}` : ''}`; }
      if (lo === hi) return `${span}: ${st === 'clash' ? 'held by two stations — ' : ''}${who(lo)}`;
      return `${span}: ${WORD[st]} — ${[...new Set(Array.from({ length: hi - lo + 1 }, (_, i) => who(lo + i)))].slice(0, 4).join(', ')}`;
    };
    // Status runs over a list of addresses: consecutive, the same status.
    const statusRects = (list, y, h) => {
      const out = [];
      let cur = null;
      const flush = () => { if (cur && cur.st !== 'free') out.push(rect(cur.lo, cur.hi, y, h, `as-c-${cur.st}`, tip(cur.lo, cur.hi, cur.st))); };
      list.forEach(a => {
        const st = status(I, sc.hubs, a);
        if (cur && a === cur.hi + 1 && st === cur.st) cur.hi = a;
        else { flush(); cur = { lo: a, hi: a, st }; }
      });
      flush();
      return out.join('');
    };
    const bands = (list, y, h, cls, name) => {
      const sp = [];
      list.forEach(a => { const l = sp[sp.length - 1]; if (l && a === l[1] + 1) l[1] = a; else sp.push([a, a]); });
      return sp.map(([lo, hi]) => rect(lo, hi, y, h, cls, `${name ? name + ': ' : ''}pass range ${lo}–${hi}`)).join('');
    };

    const Y = 22, BH = 20, LY = Y + BH + 8, LH = 6, LSTEP = 9;
    const nl = lanes ? sc.reps.length : 0;
    const H = (lanes ? LY + nl * LSTEP + 4 : Y + BH + 6) + 14;
    let body = bands(addrs, Y, BH, 'as-c-range', sc.kind === 'rep' ? '' : sc.name) + statusRects(addrs, Y, BH);
    if (sc.kind === 'rep') sc.reps[0].excl.forEach(e => { body += rect(Math.max(e.low, segs[0].lo), e.high, Y, BH, 'as-c-excl', `Exclusion ${e.low}–${e.high}`); });
    if (lanes) {
      body += `<text class="chart-muted as-lane" x="4" y="${Y + 14}">All ${esc(String(nl))} repeaters</text>`;
      sc.reps.forEach((r, i) => {
        const y = LY + i * LSTEP;
        const t = tally(I, I.scopes.get('rep:' + r.id));
        body += `<text class="chart-muted as-lane" x="4" y="${y + LH}"><title>${esc(`${r.name}: ${num(t.taken)} of ${num(t.n)} taken (${t.full}%)`)}</title>${esc(r.name.length > 26 ? r.name.slice(0, 25) + '…' : r.name)}</text>`
          + bands(r.carried, y, LH, 'as-c-range', r.name) + statusRects(r.carried, y, LH);
      });
    }
    // Marks for the addresses in the filter box.
    const marks = searchIds().filter(a => xOf(a) != null).map(a => {
      const xx = xOf(a).toFixed(1);
      return `<path class="as-mark" d="M${xx} ${Y - 2} l-4 -7 h8 z"><title>${esc(`${a}: searched — ${WORD[status(I, sc.hubs, a)]}`)}</title></path><line class="as-mark-line" x1="${xx}" x2="${xx}" y1="${Y - 2}" y2="${Y + BH + 2}"/>`;
    }).join('');
    // Each span's two ends under it, dropped where they would collide.
    let right = -Infinity;
    const labels = spans.flatMap(([lo, hi]) => {
      const x0 = xOf(lo) - scale / 2, x1 = xOf(hi) + scale / 2;
      return lo === hi ? [{ x: x0, t: lo, anchor: 'start' }] : [{ x: x0, t: lo, anchor: 'start' }, { x: x1, t: hi, anchor: 'end' }];
    }).map(it => {
      const w = String(it.t).length * CH, left = it.anchor === 'end' ? it.x - w : it.x;
      if (left < right + 4) return '';
      right = left + w;
      return `<text class="chart-muted sr-axis" x="${it.x.toFixed(1)}" y="${H - 3}"${it.anchor === 'end' ? ' text-anchor="end"' : ''}>${it.t}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(captionText(I, sc))}">${body}${marks}${labels}</svg>`;
  }

  function captionText(I, sc) {
    const t = tally(I, sc);
    return `${sc.name}: ${num(t.use + t.clash)} of ${plural(t.n, 'address', 'addresses')} in use (${pct(t.use + t.clash, t.n)}%), `
      + `${num(t.alloc)} set aside, ${num(t.free)} free${t.clash ? `, ${num(t.clash)} held by two stations` : ''}`
      + `${t.longest ? `; the longest free run ${t.longest.lo}–${t.longest.hi} (${num(t.longest.n)})` : ''}`;
  }

  function meterHtml(t) {
    const u = pct(t.use + t.clash, t.n), al = pct(t.alloc, t.n);
    return `<span class="as-meter" title="${escAttr(`${t.full}% taken: ${num(t.use + t.clash)} in use, ${num(t.alloc)} set aside, ${num(t.free)} free`)}" aria-hidden="true">`
      + `<span class="as-m-use" style="--w:${u}%"></span><span class="as-m-alloc" style="--w:${al}%"></span></span>`;
  }

  function figureHtml(I, sc, lanes) {
    const t = tally(I, sc);
    const head = sc.kind === 'rep' ? `<b>${esc(sc.name)}</b>` : `<b>${esc(sc.name)}</b> — ${plural(sc.reps.length, 'repeater')},`;
    return `<figure class="as-ruler" id="as-f-${escAttr(slug(sc.id))}" data-scope="${escAttr(sc.id)}">
      <figcaption class="small">${meterHtml(t)} ${head} ${num(t.use + t.clash)} of ${plural(t.n, 'address', 'addresses')} in use
        (<b class="${fullCls(t.full)}">${t.full}% taken</b>) · ${num(t.alloc)} set aside · ${num(t.free)} free${t.clash ? ` · <span class="txt-bad">${num(t.clash)} held by two</span>` : ''}
        ${t.longest ? ` · longest free run <b>${t.longest.lo}–${t.longest.hi}</b> (${num(t.longest.n)})` : ''}
        ${t.free ? ` · <button type="button" class="link-btn" onclick="AddressSpace.allocateIn(${escAttr(JSON.stringify(sc.id))})">Allocate here</button>` : ''}
        ${sc.kind === 'rep' && typeof goToStation === 'function' ? ` · <button type="button" class="link-btn" onclick="goToStation(${escAttr(JSON.stringify(sc.reps[0].id))})">Open in Stations</button>` : ''}</figcaption>
      <div class="chart-scroll" role="region" tabindex="0" aria-label="${escAttr(`${sc.name}'s address space — scroll sideways for the whole of it`)}">
        ${rulerSvg(I, sc, lanes)}
      </div></figure>`;
  }

  function keyHtml(extra = []) {
    const k = (cls, text) => `<span class="sr-key"><span class="sr-sw ${cls}" aria-hidden="true"></span>${text}</span>`;
    return `<p class="small sr-keys">${k('as-c-range', 'a pass range on record — free where nothing is drawn over it')}
      ${k('as-c-use', 'in use: a station in the hub holds it')}${k('as-c-alloc', 'set aside (allocated)')}
      ${k('as-c-clash', 'held by two stations')}${extra.join('')}</p>`;
  }

  function repeatersHtml(I) {
    const q = typeof state !== 'undefined' ? state.prFilter : '';
    let list = I.reps;
    if (S.only) list = list.filter(r => r.id === S.only);
    else if (q && typeof passRangeRepeaterMatch === 'function') {
      list = list.filter(r => passRangeRepeaterMatch(r.st, typeof findStationMatches === 'function' ? findStationMatches(r.st) : [], q));
    }
    const sc = r => I.scopes.get('rep:' + r.id);
    const sorted = list.slice().sort(S.sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
      : S.sort === 'freest' ? (a, b) => (tally(I, sc(b)).free - tally(I, sc(a)).free) || a.name.localeCompare(b.name)
        : S.sort === 'fullest' ? (a, b) => (tally(I, sc(b)).full - tally(I, sc(a)).full) || (tally(I, sc(b)).n - tally(I, sc(a)).n) || a.name.localeCompare(b.name)
          : (a, b) => (b.carried.length - a.carried.length) || a.name.localeCompare(b.name));
    const shown = sorted.slice(0, S.shown);
    const full = I.reps.filter(r => tally(I, sc(r)).full >= 80).length;
    return `<div class="control-row as-controls">
        <label>Order <select onchange="AddressSpace.setSort(this.value)">
          ${[['busiest', 'Most addresses first'], ['fullest', 'Fullest first'], ['freest', 'Most free first'], ['name', 'By name']].map(([v, l]) => `<option value="${v}"${S.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select></label>
        ${S.only ? `<button type="button" onclick="AddressSpace.showAll()">Show every repeater</button>` : ''}
        <span class="small">${S.only ? '' : `${plural(list.length, 'repeater')}${list.length !== I.reps.length ? ` of ${num(I.reps.length)} (the filter)` : ''} · `}${plural(full, 'is', 'are')} 80% taken or more</span>
      </div>
      ${keyHtml([`<span class="sr-key"><span class="sr-sw as-c-excl" aria-hidden="true"></span>an exclusion</span>`, `<span class="sr-key"><span class="as-mark-key" aria-hidden="true">▼</span>an address in the filter box</span>`])}
      ${!shown.length ? '<p class="small table-empty">No repeater matches this filter.</p>' : shown.map(r => figureHtml(I, sc(r), false)).join('')}
      ${sorted.length > shown.length ? `<p><button type="button" onclick="AddressSpace.more()">Show ${num(Math.min(PAGE, sorted.length - shown.length))} more</button>
        <button type="button" onclick="AddressSpace.more(true)">Show all ${num(sorted.length)}</button>
        <span class="small">${num(sorted.length - shown.length)} not drawn</span></p>` : ''}`;
  }

  function networksHtml(I) {
    const groups = I.groups.slice().sort((a, b) => (tally(I, b).full - tally(I, a).full) || a.name.localeCompare(b.name));
    const rows = groups.map(g => {
      const t = tally(I, g);
      return `<tr><th scope="row"><button type="button" class="link-btn" onclick="AddressSpace.scrollTo('as-f-${escAttr(slug(g.id))}')">${esc(g.name)}</button>
          <br><span class="small">${esc(g.hubs.map(h => hubName(I, h)).join(' and '))}</span></th>
        <td class="num">${num(g.reps.length)}</td><td class="num">${num(t.n)}</td><td class="num">${num(t.use + t.clash)}</td>
        <td class="num">${t.alloc ? `<span class="txt-warn">${num(t.alloc)}</span>` : '0'}</td><td class="num">${num(t.free)}</td>
        <td>${meterHtml(t)} <span class="${fullCls(t.full)}">${t.full}%</span></td>
        <td class="num col-optional">${t.longest ? `${t.longest.lo}–${t.longest.hi} (${num(t.longest.n)})` : '—'}</td></tr>`;
    }).join('');
    return `<p class="small">Each radio network's repeaters together: every address any of them carries, once, in use or free in the network's hub. The lanes
        under each are its repeaters on the same axis — where two lanes overlap, two repeaters carry the same addresses.</p>
      <div class="table-wrap" role="region" tabindex="0" aria-label="The radio networks, fullest first">
        <table class="hl-table as-nets">
          <caption class="sr-only">Each radio network: its repeaters, the addresses they carry, how many are in use, set aside and free, how full it is, and its longest free run</caption>
          <thead><tr><th scope="col">Radio network</th><th scope="col" class="num">Repeaters</th><th scope="col" class="num">Carried</th>
            <th scope="col" class="num">In use</th><th scope="col" class="num">Set aside</th><th scope="col" class="num">Free</th>
            <th scope="col">Taken</th><th scope="col" class="num col-optional">Longest free run</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      ${keyHtml()}
      ${groups.map(g => figureHtml(I, g, true)).join('')}`;
  }

  // ── The address grid ──────────────────────────────────────────────────────

  function gridScope(I) {
    let sc = S.scope && I.scopes.get(S.scope);
    if (!sc || sc.kind === 'rep') {
      const h = I.hubList.slice().sort((a, b) => I.reps.filter(r => r.hub === b).length - I.reps.filter(r => r.hub === a).length)[0];
      sc = I.scopes.get('hub:' + h) || I.groups[0];
      S.scope = sc ? sc.id : null;
    }
    return sc;
  }

  function blockRows(I, sc) {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      const b = { lo: r * ROW, hi: Math.min(MAX, r * ROW + ROW - 1), n: 0, use: 0, alloc: 0, free: 0, valid: 0 };
      for (let a = Math.max(1, b.lo); a <= b.hi; a++) {
        const st = cellStatus(I, sc, a);
        b.valid++;
        if (st === 'out') continue;
        // n: what a repeater in scope carries — every in-scope address of a
        // network, the carried ones of a hub.
        if (st !== 'direct' && st !== 'open') b.n++;
        if (st === 'use' || st === 'clash' || st === 'direct' || st.startsWith('hub')) b.use++;
        else if (st === 'alloc') b.alloc++;
        else if (st === 'free') b.free++;
      }
      // A hub's block is a hundred addresses; a network's, what it carries.
      b.den = whole(sc) ? b.valid : b.n;
      out.push(b);
    }
    return out;
  }

  // The grid's and the wheel's Show: every hub together, a hub, a network.
  function scopeSelectHtml(I, sc) {
    const opt = s => `<option value="${escAttr(s.id)}"${s.id === sc.id ? ' selected' : ''}>${esc(s.name)}</option>`;
    return `<label>Show <select onchange="AddressSpace.setScope(this.value)">
          <optgroup label="All hubs — an address in use in any of them">${opt(I.scopes.get('all'))}</optgroup>
          <optgroup label="Hubs — every address">${I.hubList.map(h => opt(I.scopes.get('hub:' + h))).join('')}</optgroup>
          <optgroup label="Radio networks — the addresses their repeaters carry">${I.groups.map(opt).join('')}</optgroup>
        </select></label>`;
  }
  // What each address's colour says, in this scope.
  function statusKeysHtml(sc) {
    const k = (cls, text) => `<span class="sr-key"><span class="sr-sw ${cls}" aria-hidden="true"></span>${text}</span>`;
    if (sc.kind === 'all') {
      return `${k('as-c-hub1', 'in use in one hub')}${k('as-c-hub2', 'in two')}${k('as-c-hub3', 'in three or more')}${k('as-c-alloc', 'set aside')}
        ${k('as-c-clash', 'held by two stations in one hub')}${k('as-c-free', 'free in every hub, and a repeater carries it')}${k('as-c-open', 'free in every hub, no repeater carries it')}`;
    }
    const hub = sc.kind === 'hub';
    return `${k('as-c-use', 'in use')}${hub ? k('as-c-direct', 'in use, no repeater here carries it') : ''}${k('as-c-alloc', 'set aside')}
        ${k('as-c-clash', 'held by two stations')}${k('as-c-free', hub ? 'free, and a repeater here carries it' : 'free')}
        ${hub ? k('as-c-open', 'free, no repeater here carries it') : k('as-c-out', 'outside the network\'s ranges')}`;
  }
  // The same, for the canvases: a colour and how strongly it is laid on.
  function cellColours() {
    const use = cssColour('--as-use', '#00838f'), muted = cssColour('--muted', '#7a8794');
    return {
      use: [use, 1], direct: [use, 0.42], hub1: [use, 0.45], hub2: [use, 0.72], hub3: [use, 1],
      clash: [cssColour('--as-clash', '#c7401a'), 1], alloc: [cssColour('--as-alloc', '#b8860b'), 1],
      free: [cssColour('--as-free', '#107c10'), 0.8], open: [muted, 0.18], out: [muted, 0.07],
    };
  }

  function gridHtml(I) {
    const sc = gridScope(I);
    if (!sc) return '<p class="small">No hub or radio network to draw.</p>';
    const t = tally(I, sc), all = whole(sc);
    const blocks = blockRows(I, sc);
    return `<div class="control-row as-controls">
        ${scopeSelectHtml(I, sc)}
        <label>Address <input type="number" id="as-look" class="field-num" min="1" max="${MAX}" inputmode="numeric" value="${S.pickAddr ?? ''}"
          oninput="AddressSpace.lookup(this.value)" placeholder="5740"></label>
      </div>
      <p class="small">${esc(captionText(I, sc))}. A row is a block of a hundred — 4000 to 4099 — and the bar at its end how much of the block is taken${all ? '' : ' of what the network carries in it'}.
        Point at an address to see whose it is; pick a free one to allocate it.</p>
      <p class="small sr-keys">${statusKeysHtml(sc)}</p>
      <div class="chart-scroll as-grid-wrap" role="region" tabindex="0" aria-label="${escAttr(`${sc.name}: the address grid — scroll sideways for the whole of it`)}">
        <canvas id="as-grid" role="img" aria-label="${escAttr(`Every ALERT address in ${sc.name}, a hundred to a row. ${captionText(I, sc)}. The table under the grid holds the same, block by block.`)}"
          onmousemove="AddressSpace.gridHover(event)" onmouseleave="AddressSpace.gridHover(null)" onclick="AddressSpace.gridClick(event)"></canvas>
      </div>
      <div id="as-readout" class="small as-readout" aria-live="polite">${readoutHtml(I, sc, S.pickAddr)}</div>
      <details class="sr-fold"><summary>Block by block — the same as a table</summary>
        <div class="table-wrap tall" role="region" tabindex="0" aria-label="${escAttr(`${sc.name}, block by block`)}">
        <table class="hl-table"><caption class="sr-only">${esc(sc.name)}: each block of a hundred addresses, how many ${all ? 'are' : 'the network carries,'} in use, set aside and free</caption>
          <thead><tr><th scope="col">Block</th>${all ? '' : '<th scope="col" class="num">Carried</th>'}<th scope="col" class="num">In use</th>
            <th scope="col" class="num">Set aside</th><th scope="col" class="num">Free${all ? ', carried' : ''}</th><th scope="col" class="num">Taken</th></tr></thead>
          <tbody>${blocks.filter(b => b.den).map(b => `<tr><th scope="row">${b.lo}–${b.hi}</th>${all ? '' : `<td class="num">${num(b.n)}</td>`}
            <td class="num">${num(b.use)}</td><td class="num">${num(b.alloc)}</td><td class="num">${num(b.free)}</td>
            <td class="num">${pct(b.use + b.alloc, b.den)}%</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  // What one address is, in a scope, and what can be done with it.
  function readoutHtml(I, sc, a) {
    if (a == null || !sc) return 'Point at an address, or type one above.';
    if (!(a >= 1 && a <= MAX)) return `${esc(String(a))} is not an ALERT address — they run from 1 to ${num(MAX)}.`;
    const hs = holders(I, sc.hubs, a), al = allocOf(I, sc.hubs, a), every = sc.kind === 'all';
    const by = (I.coverBy.get(a) || []).filter(r => sc.hubs.includes(r.hub));
    const repName = r => esc(every ? `${r.name} (${hubName(I, r.hub)})` : r.name);
    const carriers = by.length ? `carried by ${by.map(repName).join(', ')}`
      : every ? 'no repeater carries it' : `no repeater in ${esc(sc.hubs.map(h => hubName(I, h)).join(' or '))} carries it`;
    const open = s => (typeof goToStation === 'function'
      ? `<button type="button" class="link-btn" onclick="goToStation(${escAttr(JSON.stringify(s.id))})">${esc(s.name)}</button>` : esc(s.name));
    let what;
    if (every && hs.length) {
      // Hub by hub: reuse across hubs is ordinary; two in one hub is not.
      const by2 = sc.hubs.map(h => ({ h, l: (I.held.get(h) && I.held.get(h).get(a)) || [] })).filter(x => x.l.length);
      what = `in use in ${plural(by2.length, 'hub')}: ${by2.map(x => `${esc(hubName(I, x.h))} — ${x.l.length > 1 ? `<span class="txt-bad">held by ${num(x.l.length)} stations</span>: ` : ''}${x.l.map(open).join(', ')}`).join('; ')}`;
    } else if (hs.length > 1) what = `<span class="txt-bad">held by ${num(hs.length)} stations</span>: ${hs.map(open).join(', ')}`;
    else if (hs.length) what = `in use: ${open(hs[0])}${hs[0].station_number ? ` (${esc(hs[0].station_number)})` : ''}`;
    else if (al) what = `<span class="txt-warn">set aside</span> for “${esc(al.purpose)}” by ${esc(al.created_by || '—')}, ${esc(day(al.created_at))}`;
    else {
      // Every hub together, an address is allocated in a hub: through the
      // repeater that carries it, or not offered here.
      const where = by.length ? 'rep:' + by[0].id : sc.kind === 'hub' ? sc.id : every ? null : 'hub:' + sc.hubs[0];
      what = `<b class="as-f-low">free${every ? ' in every hub' : ''}</b>${where ? ` <button type="button" class="link-btn" onclick="AddressSpace.allocateIn(${escAttr(JSON.stringify(where))}, ${a})">Allocate ${a}</button>` : ''}`;
    }
    return `<b>${a}</b> — ${what} · ${carriers}${sc.kind === 'net' && !sc.set.has(a) ? ' · outside this network\'s ranges' : ''}`;
  }

  let GRID = null;   // the drawn grid's geometry, for pointing at it

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

  function drawGrid() {
    const cv = document.getElementById('as-grid');
    const I = index();
    if (!cv || !I) return;
    const sc = gridScope(I);
    const wrap = cv.parentElement;
    const avail = Math.max(320, (wrap && wrap.clientWidth) || 760);
    const LAB = 40, BAR = 60, PADR = 34, TOP = 14, GAP = 6;
    const cell = Math.max(4, Math.min(9, Math.floor((avail - LAB - BAR - PADR - 2 * GAP) / ROW)));
    const W = LAB + GAP + cell * ROW + GAP + BAR + PADR;
    const yOf = r => TOP + r * cell + Math.floor(r / 10) * 3;
    const H = yOf(ROWS) + 4;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.setProperty('--gw', W + 'px'); cv.style.setProperty('--gh', H + 'px');
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const col = cellColours();
    const text = cssColour('--muted', '#7a8794'), ink = cssColour('--text', '#16202a');
    const inner = cell >= 5 ? cell - 1 : cell;
    g.font = '9px system-ui, sans-serif';
    g.fillStyle = text; g.textBaseline = 'middle';
    for (let c = 0; c < ROW; c += 10) g.fillText(String(c).padStart(2, '0'), LAB + GAP + c * cell, 6);
    const blocks = blockRows(I, sc);
    for (let r = 0; r < ROWS; r++) {
      const y = yOf(r);
      if (r % 5 === 0) { g.globalAlpha = 1; g.fillStyle = r % 10 === 0 ? ink : text; g.textAlign = 'right'; g.fillText(String(r * ROW), LAB, y + cell / 2); g.textAlign = 'left'; }
      for (let c = 0; c < ROW; c++) {
        const a = r * ROW + c;
        const st = cellStatus(I, sc, a);
        if (st === 'void') continue;
        const [fill, alpha] = col[st];
        g.globalAlpha = alpha; g.fillStyle = fill;
        g.fillRect(LAB + GAP + c * cell, y, inner, inner);
      }
      // How full the block is.
      const b = blocks[r];
      if (b.den) {
        const bx = LAB + GAP + ROW * cell + GAP, bw = BAR;
        g.globalAlpha = 0.14; g.fillStyle = text; g.fillRect(bx, y, bw, inner);
        const wu = (bw * b.use) / b.den, wa = (bw * b.alloc) / b.den;
        g.globalAlpha = 1; g.fillStyle = col.use[0]; g.fillRect(bx, y, wu, inner);
        g.fillStyle = col.alloc[0]; g.fillRect(bx + wu, y, wa, inner);
        if (cell >= 6) { g.fillStyle = text; g.fillText(`${pct(b.use + b.alloc, b.den)}%`, bx + bw + 4, y + cell / 2); }
      }
    }
    // The searched, the pointed-at and the picked.
    g.globalAlpha = 1;
    const ring = (a, colour, w) => {
      if (a == null || a < 1 || a > MAX) return;
      const r = Math.floor(a / ROW), c = a % ROW;
      g.strokeStyle = colour; g.lineWidth = w;
      g.strokeRect(LAB + GAP + c * cell - 1, yOf(r) - 1, inner + 2, inner + 2);
    };
    searchIds().forEach(a => ring(a, ink, 1.5));
    ring(S.hoverAddr, ink, 1);
    ring(S.pickAddr, ink, 2);
    GRID = { LAB, GAP, cell, yOf, sc: sc.id };
  }

  function gridAddr(ev) {
    const cv = document.getElementById('as-grid');
    if (!ev || !cv || !GRID) return null;
    const box = cv.getBoundingClientRect();
    const x = ev.clientX - box.left - GRID.LAB - GRID.GAP, y = ev.clientY - box.top;
    if (x < 0 || x >= GRID.cell * ROW) return null;
    let r = -1;
    for (let i = 0; i < ROWS; i++) if (y >= GRID.yOf(i) && y < GRID.yOf(i) + GRID.cell) { r = i; break; }
    if (r < 0) return null;
    const a = r * ROW + Math.floor(x / GRID.cell);
    return a >= 1 && a <= MAX ? a : null;
  }
  function gridHover(ev) {
    const a = gridAddr(ev);
    if (a === S.hoverAddr) return;
    S.hoverAddr = a;
    const I = index(), out = document.getElementById('as-readout');
    if (out && I) out.innerHTML = readoutHtml(I, gridScope(I), a ?? S.pickAddr);
    drawGrid();
  }
  function gridClick(ev) {
    const a = gridAddr(ev);
    if (a == null) return;
    lookup(a);
    const look = document.getElementById('as-look');
    if (look) look.value = a;
  }
  function lookup(v) {
    const a = v === '' || v == null ? null : Math.round(Number(v));
    S.pickAddr = Number.isFinite(a) ? a : null;
    const I = index(), out = document.getElementById('as-readout');
    if (out && I) out.innerHTML = readoutHtml(I, gridScope(I), S.pickAddr);
    drawGrid();
  }

  // ── All addresses: the wheel ──────────────────────────────────────────────
  // The grid's hub or network bent round one circle: 1 at the top, clockwise
  // to 8,191, so a wedge is one of the grid's rows, a block of a hundred.
  // Three rings, outside in: each address as the grid colours it, to scale, so
  // a gap is as wide as it is long; how many of the scope's repeaters carry
  // it, so a stretch none carries is bare track; and a bar a block, as long as
  // the block is taken. Point at a wedge and a callout names the repeaters
  // that carry any of it; press one, or a gap under the wheel, to keep it.

  const SLOTS = ROWS * ROW;   // 8,200 round the circle: address 0 and 8,192–8,199 are the seam at the top
  const ang = a => -Math.PI / 2 + (2 * Math.PI * a) / SLOTS;
  let WHEEL = null;           // the drawn wheel's geometry and its rings, kept for pointing at it

  function lowerBound(list, v) {
    let i = 0, j = list.length;
    while (i < j) { const m = (i + j) >> 1; if (list[m] < v) i = m + 1; else j = m; }
    return i;
  }

  // A stretch of addresses in a scope, counted in the grid's words, with the
  // repeaters that carry any of it and the part each carries.
  function stretch(I, sc, lo, hi) {
    lo = Math.max(1, lo); hi = Math.min(MAX, hi);
    const c = { lo, hi, n: hi - lo + 1, use: 0, clash: 0, direct: 0, hub1: 0, hub2: 0, hub3: 0, alloc: 0, free: 0, open: 0, out: 0 };
    for (let a = lo; a <= hi; a++) c[cellStatus(I, sc, a)]++;
    c.held = c.use + c.clash + c.direct + c.hub1 + c.hub2 + c.hub3;
    c.den = c.n - c.out;
    c.full = pct(c.held + c.alloc, c.den);
    c.reps = sc.reps.map(r => {
      const part = [];
      for (let i = lowerBound(r.carried, lo); i < r.carried.length && r.carried[i] <= hi; i++) part.push(r.carried[i]);
      return { r, part };
    }).filter(x => x.part.length).sort((p, q) => (q.part.length - p.part.length) || p.r.name.localeCompare(q.r.name));
    return c;
  }
  function wedges(I, sc) {
    const m = I.wedges || (I.wedges = new Map());
    let w = m.get(sc.id);
    if (!w) {
      w = [];
      for (let r = 0; r < ROWS; r++) w.push(Object.assign(stretch(I, sc, r * ROW, r * ROW + ROW - 1), { wedge: r }));
      m.set(sc.id, w);
    }
    return w;
  }
  // How many of a scope's repeaters carry each address.
  function coverOf(I, sc) {
    const m = I.cover || (I.cover = new Map());
    let n = m.get(sc.id);
    if (!n) {
      n = new Uint8Array(MAX + 1);
      sc.reps.forEach(r => r.carried.forEach(a => { if (n[a] < 255) n[a]++; }));
      m.set(sc.id, n);
    }
    return n;
  }

  // A stretch in words: brief for the callout, with its buttons for the
  // readout under the wheel.
  function stretchHtml(I, sc, c, rich) {
    const every = sc.kind === 'all', hub = whole(sc), span = c.lo === c.hi ? String(c.lo) : `${c.lo}–${c.hi}`;
    const free = c.free + c.open, reused = c.hub2 + c.hub3;
    const head = `<b>${span}</b>${c.gap ? ` — a gap of ${num(c.n)}` : ''} · <b class="${fullCls(c.full)}">${c.full}% taken</b>`;
    const counts = `${num(c.held)} in use${every && reused ? ` (${num(reused)} in two hubs or more)` : ''} · ${num(c.alloc)} set aside`
      + ` · ${num(free)} free${every ? ' in every hub' : ''}${hub && free ? ` (${num(c.free)} under a repeater)` : ''}`
      + `${c.clash ? ` · <span class="txt-bad">${num(c.clash)} held by two${every ? ' in one hub' : ''}</span>` : ''}${c.out ? ` · ${num(c.out)} outside the network's ranges` : ''}`;
    const LIMIT = rich ? 24 : 8;
    const label = x => (every ? `${x.r.name} (${hubName(I, x.r.hub)})` : x.r.name);
    const name = x => (rich ? `<button type="button" class="link-btn" onclick="AddressSpace.showRep(${escAttr(JSON.stringify(x.r.id))})">${esc(label(x))}</button>` : esc(label(x)));
    const reps = c.reps.length
      ? `<p class="as-tip-h">Carried by ${plural(c.reps.length, 'repeater')}:</p>
        <ul class="hl-plain as-tip-reps">${c.reps.slice(0, LIMIT).map(x => `<li>${name(x)} <span class="small">${esc(runsText(x.part, 3))}${x.part.length > 1 ? ` (${num(x.part.length)})` : ''}</span></li>`).join('')}</ul>
        ${c.reps.length > LIMIT ? `<p class="small">and ${num(c.reps.length - LIMIT)} more</p>` : ''}`
      : `<p class="as-tip-h">No repeater ${sc.kind === 'hub' ? 'in the hub ' : ''}carries any of it${hub && free ? ' — only a station reporting straight to a base could use it' : ''}.</p>`;
    if (!rich) return `<p>${head}</p><p class="small">${counts}</p>${reps}`;
    // The first free address, under a repeater if one is: what Allocate
    // offers. Every hub together, only one under a repeater, whose hub it goes in.
    let first = null;
    for (const want of every ? ['free'] : ['free', 'open']) {
      for (let a = c.lo; a <= c.hi && first == null; a++) if (cellStatus(I, sc, a) === want) first = a;
    }
    let act = '';
    if (first != null) {
      const by = (I.coverBy.get(first) || []).filter(r => sc.hubs.includes(r.hub));
      const where = by.length ? 'rep:' + by[0].id : sc.kind === 'hub' ? sc.id : every ? null : 'hub:' + sc.hubs[0];
      if (where) act = ` · <button type="button" class="link-btn" onclick="AddressSpace.allocateIn(${escAttr(JSON.stringify(where))}, ${first})">Allocate ${first}</button>`;
    }
    act += ` · <button type="button" class="link-btn" onclick="AddressSpace.toGrid(${first ?? c.lo})">On the address grid</button>`;
    return `<p>${head} · ${counts}${act}</p>${reps}`;
  }

  function wheelHtml(I) {
    const sc = gridScope(I);
    if (!sc) return '<p class="small">No hub or radio network to draw.</p>';
    const every = sc.kind === 'all', hub = whole(sc);
    const t = tally(I, sc), W = wedges(I, sc);
    const gaps = t.runs.slice().sort((a, b) => (b.n - a.n) || (a.lo - b.lo)).slice(0, 10);
    const k = (cls, text) => `<span class="sr-key"><span class="sr-sw ${cls}" aria-hidden="true"></span>${text}</span>`;
    const sel = S.wheelSel;
    return `<div class="control-row as-controls">
        ${scopeSelectHtml(I, sc)}
      </div>
      <p class="small">${esc(captionText(I, sc))}. Every address, from 1 at the top clockwise to ${num(MAX)}; a wedge is a block of a hundred, a row
        of the address grid. ${every ? `The hubs reuse addresses, so here an address is in use when a station in any of the ${num(sc.hubs.length)} hubs holds it, shaded
        by how many do, and free only when none does — the gaps are the addresses nobody anywhere is on. ` : ''}Point at a wedge to see which repeaters carry it; press it to keep it here.</p>
      <p class="small sr-keys"><span class="sr-key"><b>Outer ring</b>, each address:</span>${statusKeysHtml(sc)}</p>
      <p class="small sr-keys"><span class="sr-key"><b>Middle ring</b>, repeaters carrying it:</span>${k('as-c-cov1', 'one')}${k('as-c-cov2', 'two')}${k('as-c-cov3', 'three or more')}
        <span class="sr-key"><b>Inner bars</b>: how much of each block is taken</span></p>
      <div class="as-wheel-wrap">
        <canvas id="as-wheel" tabindex="0" role="img" aria-describedby="as-wheel-out"
          aria-label="${escAttr(`Every ALERT address in ${sc.name} round a wheel, a wedge a block of a hundred. ${captionText(I, sc)}. The arrow keys step from wedge to wedge; the table under the wheel holds the same.`)}"
          onpointermove="AddressSpace.wheelHover(event)" onpointerleave="AddressSpace.wheelHover(null)" onclick="AddressSpace.wheelClick(event)" onkeydown="AddressSpace.wheelKey(event)"></canvas>
        <div id="as-wheel-tip" class="as-wheel-tip small" hidden></div>
      </div>
      <div id="as-wheel-out" class="small as-readout" aria-live="polite">${wheelReadoutHtml(I, sc)}</div>
      ${gaps.length ? `<p class="small as-runs as-gaps">The biggest gaps — runs no station ${every ? 'in any hub ' : sc.kind === 'hub' ? 'in the hub ' : ''}holds and nobody has set aside:
        ${gaps.map(g => `<button type="button" class="pill" data-lo="${g.lo}" aria-pressed="${!!(sel && sel.gap && sel.lo === g.lo)}"
          onclick="AddressSpace.wheelPick(${g.lo}, ${g.hi})">${g.lo === g.hi ? g.lo : `${g.lo}–${g.hi}`} <span class="small">(${num(g.n)})</span></button>`).join(' ')}</p>` : ''}
      <details class="sr-fold"><summary>Wedge by wedge — the same as a table</summary>
        <div class="table-wrap tall" role="region" tabindex="0" aria-label="${escAttr(`${sc.name}, wedge by wedge`)}">
        <table class="hl-table as-wedges"><caption class="sr-only">${esc(sc.name)}: each block of a hundred addresses, how many are in use, set aside and free, how much is taken, and the repeaters that carry any of it</caption>
          <thead><tr><th scope="col">Block</th><th scope="col" class="num">In use</th><th scope="col" class="num">Set aside</th><th scope="col" class="num">Free</th>
            <th scope="col" class="num">${hub ? 'Free, no repeater' : 'Outside'}</th><th scope="col" class="num">Taken</th><th scope="col">Repeaters carrying any of it</th></tr></thead>
          <tbody>${W.filter(w => w.den).map(w => `<tr><th scope="row">${w.lo}–${w.hi}</th><td class="num">${num(w.held)}</td><td class="num">${num(w.alloc)}</td>
            <td class="num">${num(w.free + w.open)}</td><td class="num">${num(hub ? w.open : w.out)}</td><td class="num">${w.full}%</td>
            <td class="small">${w.reps.length ? `${esc(w.reps.slice(0, 4).map(x => x.r.name).join(', '))}${w.reps.length > 4 ? ` and ${num(w.reps.length - 4)} more` : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  function selStretch(I, sc) {
    const s = S.wheelSel;
    if (!s) return null;
    return s.wedge != null ? wedges(I, sc)[s.wedge] : Object.assign(stretch(I, sc, s.lo, s.hi), { gap: true });
  }
  function wheelReadoutHtml(I, sc) {
    const c = selStretch(I, sc);
    return c ? stretchHtml(I, sc, c, true)
      : 'Point at a wedge for the repeaters that carry it, or press one — or a gap below — to keep it here. With the wheel focused, the arrow keys step round it.';
  }

  // The rings that do not move with the pointer, drawn once to a canvas of
  // their own; the pointed-at and the kept, and the words in the middle, over
  // them on every move.
  function wheelBase(I, sc, D, dpr) {
    const base = document.createElement('canvas');
    base.width = Math.round(D * dpr); base.height = Math.round(D * dpr);
    const g = base.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = D / 2, cy = D / 2, R = D / 2 - 36;
    const rA0 = R * 0.8, rB1 = R * 0.765, rB0 = R * 0.69, rC1 = R * 0.655, rC0 = R * 0.38;
    const col = cellColours();
    const cov = cssColour('--accent', '#0b5cab'), text = cssColour('--muted', '#7a8794'), ink = cssColour('--text', '#16202a');
    const sector = (a0, a1, r0, r1) => { g.beginPath(); g.arc(cx, cy, r1, a0, a1); g.arc(cx, cy, r0, a1, a0, true); g.closePath(); };
    // An arc of addresses, at least minPx wide at its rim.
    const band = (lo, hi, r0, r1, minPx) => {
      let a0 = ang(lo), a1 = ang(hi + 1);
      if (minPx && (a1 - a0) * r1 < minPx) { const m = (a0 + a1) / 2, h = minPx / r1 / 2; a0 = m - h; a1 = m + h; }
      sector(a0, a1, r0, r1);
      g.fill();
    };
    const runsOf = fn => {
      const out = [];
      let cur = null;
      for (let a = 1; a <= MAX; a++) { const v = fn(a); if (cur && v === cur.v) cur.hi = a; else out.push(cur = { lo: a, hi: a, v }); }
      return out;
    };

    // Each address, the faint first and the inked over them, an inked run at
    // least a hairline wide so one station alone in a gap still shows.
    const st = runsOf(a => cellStatus(I, sc, a));
    const faint = v => v === 'free' || v === 'open' || v === 'out';
    [false, true].forEach(inked => st.forEach(r => {
      if (faint(r.v) === inked) return;
      g.globalAlpha = col[r.v][1]; g.fillStyle = col[r.v][0];
      band(r.lo, r.hi, rA0, R, inked ? 0.9 : 0);
    }));
    // How many repeaters carry each address, on a bare track.
    const n = coverOf(I, sc);
    g.globalAlpha = 0.1; g.fillStyle = text; sector(ang(1), ang(MAX + 1), rB0, rB1); g.fill();
    g.fillStyle = cov;
    runsOf(a => Math.min(3, n[a])).forEach(r => {
      if (!r.v) return;
      g.globalAlpha = [0, 0.3, 0.6, 1][r.v];
      band(r.lo, r.hi, rB0, rB1, 0.9);
    });
    // A bar a block, in use then set aside, out from the inner edge.
    const seam = 1 / rC1;
    wedges(I, sc).forEach((w, i) => {
      if (!w.den) return;
      const a0 = ang(i * ROW) + seam, a1 = ang(i * ROW + ROW) - seam, L = rC1 - rC0;
      g.globalAlpha = 0.12; g.fillStyle = text; sector(a0, a1, rC0, rC1); g.fill();
      const lu = (L * w.held) / w.den, la = (L * w.alloc) / w.den;
      g.globalAlpha = 1;
      if (lu) { g.fillStyle = col.use[0]; sector(a0, a1, rC0, rC0 + lu); g.fill(); }
      if (la) { g.fillStyle = col.alloc[0]; sector(a0, a1, rC0 + lu, rC0 + lu + la); g.fill(); }
    });
    // Ticks a block, longer a thousand, numbered round the outside.
    g.globalAlpha = 1; g.strokeStyle = text; g.lineWidth = 1;
    g.font = '10px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let r = 0; r < ROWS; r++) {
      const a = ang(r * ROW), ux = Math.cos(a), uy = Math.sin(a), len = r % 10 === 0 ? 7 : 3;
      g.beginPath(); g.moveTo(cx + ux * (R + 2), cy + uy * (R + 2)); g.lineTo(cx + ux * (R + 2 + len), cy + uy * (R + 2 + len)); g.stroke();
      // 8000 is dropped where it would run into the 8191 at the top.
      const x = cx + ux * (R + 22), lab = String(r * ROW);
      if (r === 80 && x + g.measureText(lab).width / 2 > cx - 10 - g.measureText(String(MAX)).width) continue;
      if (r && r % 10 === 0) { g.fillStyle = text; g.textAlign = 'center'; g.fillText(lab, x, cy + uy * (R + 19)); }
    }
    g.fillStyle = ink; g.textAlign = 'left'; g.fillText('1', cx + 4, cy - R - 14);
    g.fillStyle = text; g.textAlign = 'right'; g.fillText(String(MAX), cx - 4, cy - R - 14);
    // The addresses in the filter box, a mark pointing in at each.
    g.fillStyle = ink;
    searchIds().forEach(a => {
      const t = ang(a + 0.5), ux = Math.cos(t), uy = Math.sin(t), px = -uy * 4, py = ux * 4;
      g.beginPath(); g.moveTo(cx + ux * (R + 1), cy + uy * (R + 1));
      g.lineTo(cx + ux * (R + 10) + px, cy + uy * (R + 10) + py); g.lineTo(cx + ux * (R + 10) - px, cy + uy * (R + 10) - py);
      g.closePath(); g.fill();
    });
    return { base, D, dpr, cx, cy, R, rC0, ink, text, I, sc: sc.id, q: searchIds().join(',') };
  }

  function drawWheel(quick) {
    const cv = document.getElementById('as-wheel');
    const I = index();
    if (!cv || !I) return;
    const sc = gridScope(I);
    const view = document.getElementById('as-view');
    const D = Math.round(Math.max(240, Math.min(620, (view && view.clientWidth) || 560)));
    const dpr = window.devicePixelRatio || 1;
    if (!quick || !WHEEL || WHEEL.I !== I || WHEEL.sc !== sc.id || WHEEL.D !== D || WHEEL.dpr !== dpr || WHEEL.q !== searchIds().join(',')) {
      WHEEL = wheelBase(I, sc, D, dpr);
      cv.width = WHEEL.base.width; cv.height = WHEEL.base.height;
      cv.style.setProperty('--ww', D + 'px');
    }
    const { cx, cy, R, rC0, ink, text } = WHEEL;
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(WHEEL.base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The kept stretch and the pointed-at wedge, outlined across the rings.
    const outline = (lo, hi, w) => {
      let a0 = ang(lo), a1 = ang(hi + 1);
      if ((a1 - a0) * R < 3) { const m = (a0 + a1) / 2; a0 = m - 1.5 / R; a1 = m + 1.5 / R; }
      g.beginPath(); g.arc(cx, cy, R + 1, a0, a1); g.arc(cx, cy, rC0 - 3, a1, a0, true); g.closePath();
      g.globalAlpha = 0.1; g.fillStyle = ink; g.fill();
      g.globalAlpha = 0.95; g.strokeStyle = ink; g.lineWidth = w; g.stroke();
    };
    const s = S.wheelSel, h = S.wheelHover;
    if (s) outline(s.lo, s.hi, 2);
    if (h != null && !(s && s.wedge === h)) outline(h * ROW, h * ROW + ROW - 1, 1);
    // In the middle: what is pointed at or kept, else the scope's figures.
    const c = h != null ? wedges(I, sc)[h] : selStretch(I, sc);
    const t = tally(I, sc);
    const lines = c ? [c.lo === c.hi ? String(c.lo) : `${c.lo}–${c.hi}`, `${c.full}% taken`, `${num(c.free + c.open)} free · ${plural(c.reps.length, 'repeater')}`]
      : [sc.name, `${num(t.free)} free`, `of ${num(t.n)} · ${t.full}% taken`];
    const big = Math.round(Math.max(15, Math.min(28, R * 0.1))), small = Math.round(Math.max(10, Math.min(13, R * 0.046)));
    const room = (rC0 - 8) * 1.8;
    const fit = s0 => {
      let s1 = s0;
      while (s1.length > 2 && g.measureText(s1 === s0 ? s1 : s1 + '…').width > room) s1 = s1.slice(0, -1);
      return s1 === s0 ? s1 : s1 + '…';
    };
    g.globalAlpha = 1; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${small}px system-ui, sans-serif`; g.fillStyle = text; g.fillText(fit(lines[0]), cx, cy - big * 0.95);
    g.font = `600 ${big}px system-ui, sans-serif`; g.fillStyle = ink; g.fillText(fit(lines[1]), cx, cy);
    g.font = `${small}px system-ui, sans-serif`; g.fillStyle = text; g.fillText(fit(lines[2]), cx, cy + big * 0.95);
  }

  function wheelAt(ev) {
    const cv = document.getElementById('as-wheel');
    if (!ev || !cv || !WHEEL) return null;
    const box = cv.getBoundingClientRect();
    if (!box.width) return null;
    const k = WHEEL.D / box.width;
    const x = (ev.clientX - box.left) * k - WHEEL.cx, y = (ev.clientY - box.top) * k - WHEEL.cy;
    const d = Math.hypot(x, y);
    if (d < WHEEL.rC0 - 3 || d > WHEEL.R + 12) return null;
    let t = Math.atan2(y, x) + Math.PI / 2;
    if (t < 0) t += 2 * Math.PI;
    return Math.min(ROWS - 1, Math.floor((t / (2 * Math.PI)) * ROWS));
  }
  function wheelHover(ev) {
    const w = wheelAt(ev);
    const tip = document.getElementById('as-wheel-tip');
    if (w !== S.wheelHover) {
      S.wheelHover = w;
      const I = index();
      if (tip && I && w != null) tip.innerHTML = stretchHtml(I, gridScope(I), wedges(I, gridScope(I))[w], false);
      drawWheel(true);
    }
    if (!tip) return;
    if (w == null) { tip.hidden = true; return; }
    tip.hidden = false;
    const box = tip.parentElement.getBoundingClientRect();
    const x = ev.clientX - box.left, y = ev.clientY - box.top, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 16, top = y + 16;
    if (left + tw > box.width - 4) left = Math.max(4, x - tw - 16);
    if (top + th > box.height - 4) top = Math.max(4, y - th - 16);
    tip.style.setProperty('--tip-x', `${Math.round(left)}px`);
    tip.style.setProperty('--tip-y', `${Math.round(top)}px`);
  }
  function showPick() {
    const I = index(), out = document.getElementById('as-wheel-out');
    if (out && I) out.innerHTML = wheelReadoutHtml(I, gridScope(I));
    const s = S.wheelSel;
    document.querySelectorAll('.as-gaps .pill').forEach(b => b.setAttribute('aria-pressed', String(!!(s && s.gap && Number(b.dataset.lo) === s.lo))));
    drawWheel(true);
  }
  // A wedge pressed is kept, and pressed again let go.
  function wheelClick(ev) {
    const w = wheelAt(ev);
    if (w == null) return;
    S.wheelSel = S.wheelSel && S.wheelSel.wedge === w ? null : { lo: w * ROW, hi: w * ROW + ROW - 1, wedge: w };
    showPick();
  }
  function wheelPick(lo, hi) {
    S.wheelSel = lo == null ? null : { lo: Number(lo), hi: Number(hi ?? lo), gap: true };
    showPick();
  }
  function wheelKey(ev) {
    const s = S.wheelSel, cur = s ? Math.floor(s.lo / ROW) : null;
    let w;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') w = cur == null ? 0 : (cur + 1) % ROWS;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') w = cur == null ? ROWS - 1 : (cur + ROWS - 1) % ROWS;
    else if (ev.key === 'Home') w = 0;
    else if (ev.key === 'End') w = ROWS - 1;
    else if (ev.key === 'Escape' && s) w = null;
    else return;
    ev.preventDefault();
    S.wheelSel = w == null ? null : { lo: w * ROW, hi: w * ROW + ROW - 1, wedge: w };
    showPick();
  }
  // From the wheel's readout: the same address on the grid.
  function toGrid(a) {
    S.pickAddr = a; S.hoverAddr = null;
    setView('grid');
  }

  // ── The map ───────────────────────────────────────────────────────────────

  function mapHtml(I) {
    const t = I.hubList.map(h => ({ h, t: tally(I, I.scopes.get('hub:' + h)) }));
    return `<div class="as-controls as-radios">
        <span role="radiogroup" aria-label="What the numbers count"><span class="small">Numbers count</span>
        ${[['free', 'free addresses'], ['use', 'in use'], ['alloc', 'set aside']].map(([v, l]) => `<label class="check-label"><input type="radio" name="as-count" value="${v}"${S.mapCount === v ? ' checked' : ''}
          onchange="AddressSpace.setMapCount('${v}')"> <span>${l}</span></label>`).join('')}</span>
        <label class="check-label"><input type="checkbox"${S.hubLines ? ' checked' : ''} onchange="AddressSpace.setHubLines(this.checked)"> <span>Hub boundaries</span></label>
      </div>
      <div id="as-map" class="as-map" aria-label="Map of the repeaters as numbered circles: the addresses they carry that are free, in use or set aside, each counted once; nearby repeaters merge into one circle as you zoom out. The radio network table and the repeater drawings hold the same."></div>
      <p class="small sr-keys"><span class="sr-key"><span class="as-bubble-key as-f-low" aria-hidden="true"></span>under half taken</span>
        <span class="sr-key"><span class="as-bubble-key as-f-mid" aria-hidden="true"></span>half to 80% taken</span>
        <span class="sr-key"><span class="as-bubble-key as-f-high" aria-hidden="true"></span>80% taken or more</span></p>
      <p class="small">A circle's number is the addresses its repeaters carry, each counted once however many of them carry it — so a merged circle is what
        that region has left, not a sum. Zoom in and the circles break apart; press one to zoom to it, or a single repeater for its figures.
        ${t.length ? `By hub, free under a repeater: ${t.filter(x => I.scopes.get('hub:' + x.h).carriedSet.size).map(x => `${esc(hubName(I, x.h))} <b>${num(freeCarried(I, x.h))}</b>`).join(' · ')}.` : ''}</p>`;
  }
  function freeCarried(I, h) {
    const sc = I.scopes.get('hub:' + h);
    let n = 0;
    sc.carriedSet.forEach(a => { if (status(I, sc.hubs, a) === 'free') n++; });
    return n;
  }

  function stopMap() {
    if (S.map) { try { removeMap(S.map); } catch (_) { /* gone */ } }
    S.map = null; S.layer = null; S.hubLayer = null;
  }
  function initMap() {
    if (typeof registerTabTeardown === 'function') registerTabTeardown('AddressSpace', stopMap);
    stopMap();
    const el = document.getElementById('as-map');
    if (!el || typeof L === 'undefined' || !index()) return;
    S.map = L.map('as-map').setView([-24, 147], 5);
    if (typeof registerLiveMap === 'function') registerLiveMap('AddressSpace', () => S.map);
    if (typeof addBaseLayers === 'function') addBaseLayers(S.map);
    S.layer = L.layerGroup().addTo(S.map);
    S.map.on('zoomend', drawMap);
    S.fitted = false;
    drawHubs();
    drawMap();
  }
  async function drawHubs() {
    if (!S.map) return;
    if (S.hubLayer) { S.hubLayer.remove(); S.hubLayer = null; }
    if (!S.hubLines) return;
    try {
      if (!S.hubData) {
        const res = await fetch('data/bom-hubs.geojson');
        if (!res.ok) return;
        S.hubData = await res.json();
      }
      if (!S.map || !S.hubLines) return;
      const c = cssColour('--muted', '#7a8794');
      S.hubLayer = L.geoJSON(S.hubData, { interactive: false, style: { color: c, weight: 1.5, opacity: 0.7, fill: false, dashArray: '5 4' } }).addTo(S.map);
      S.hubLayer.bringToBack();
    } catch (_) { /* the circles stand without the lines */ }
  }

  // Repeaters merged where they would sit within a circle's reach of each
  // other at this zoom, biggest first; each circle's figures its repeaters'
  // carried addresses as one set, keyed by hub.
  function clusters(I) {
    const z = S.map.getZoom(), R = 58;
    const pts = I.reps.filter(r => r.st.lat != null && r.st.lon != null)
      .map(r => ({ r, ll: L.latLng(Number(r.st.lat), Number(r.st.lon)) }))
      .map(p => Object.assign(p, { px: S.map.project(p.ll, z), w: tally(I, I.scopes.get('rep:' + p.r.id)).free }))
      .sort((a, b) => b.w - a.w);
    const out = [];
    pts.forEach(p => {
      const c = out.find(q => q.px.distanceTo(p.px) < R);
      if (c) c.m.push(p); else out.push({ px: p.px, m: [p] });
    });
    return out.map(c => {
      const keys = new Map();
      c.m.forEach(({ r }) => r.carried.forEach(a => keys.set(r.hub + '|' + a, status(I, [r.hub], a))));
      const t = { n: keys.size, use: 0, clash: 0, alloc: 0, free: 0 };
      keys.forEach(st => { t[st]++; });
      t.full = pct(t.use + t.clash + t.alloc, t.n);
      const lat = c.m.reduce((s, p) => s + p.ll.lat, 0) / c.m.length, lon = c.m.reduce((s, p) => s + p.ll.lng, 0) / c.m.length;
      return { reps: c.m.map(p => p.r), lls: c.m.map(p => p.ll), ll: L.latLng(lat, lon), t };
    });
  }

  function drawMap() {
    const I = index();
    if (!S.map || !S.layer || !I) return;
    S.layer.clearLayers();
    const word = { free: 'free', use: 'in use', alloc: 'set aside' }[S.mapCount];
    clusters(I).forEach(c => {
      const n = S.mapCount === 'use' ? c.t.use + c.t.clash : c.t[S.mapCount];
      const d = Math.round(Math.max(26, Math.min(64, 18 + Math.sqrt(n) * 1.6)));
      const label = n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      const one = c.reps.length === 1;
      const name = one ? c.reps[0].name : `${c.reps.length} repeaters`;
      const tip = `${name}: ${num(n)} ${word} of ${num(c.t.n)} carried (${c.t.full}% taken)${one ? '' : ` — ${c.reps.slice(0, 5).map(r => r.name).join(', ')}${c.reps.length > 5 ? '…' : ''}`}`;
      const m = L.marker(c.ll, {
        icon: L.divIcon({ className: 'as-bubble-wrap', iconSize: [d, d],
          html: `<span class="as-bubble ${fullCls(c.t.full)}${one ? ' is-one' : ''}" style="--d:${d}px">${label}</span>` }),
        title: tip, alt: tip, keyboard: true, riseOnHover: true,
      });
      m.bindTooltip(esc(tip));
      if (one) {
        const r = c.reps[0], t = tally(I, I.scopes.get('rep:' + r.id));
        m.bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.nets.map(id => (I.nets.get(id) || {}).name || id).join(', ') || 'no radio network')} · ${esc(hubName(I, r.hub))}
          <br>${num(t.use + t.clash)} in use, ${num(t.alloc)} set aside, <b>${num(t.free)} free</b> of ${num(t.n)} (${t.full}% taken)
          ${t.longest ? `<br>Longest free run ${t.longest.lo}–${t.longest.hi} (${num(t.longest.n)})` : ''}
          <br>${t.free ? `<button type="button" class="link-btn" onclick="AddressSpace.allocateIn(${escAttr(JSON.stringify('rep:' + r.id))})">Allocate here</button> · ` : ''}
          <button type="button" class="link-btn" onclick="AddressSpace.showRep(${escAttr(JSON.stringify(r.id))})">Its address space</button>`);
      } else {
        m.on('click', () => {
          const b = L.latLngBounds(c.lls);
          const z = S.map.getZoom();
          if (b.getNorthEast().equals(b.getSouthWest())) S.map.setView(b.getCenter(), z + 2);
          else S.map.fitBounds(b.pad(0.15), { maxZoom: Math.max(z + 1, Math.min(z + 4, 12)) });
        });
      }
      m.addTo(S.layer);
    });
    if (!S.fitted) {
      const lls = I.reps.filter(r => r.st.lat != null).map(r => [Number(r.st.lat), Number(r.st.lon)]);
      if (lls.length) { try { S.map.fitBounds(lls, { padding: [24, 24], maxZoom: 9 }); } catch (_) { /* one point */ } }
      S.fitted = true;
    }
  }

  // ── The panel ─────────────────────────────────────────────────────────────

  function panelHtml() {
    return `<div class="panel as-panel">
        <div class="panel-header"><h2 id="as-h">Address space</h2><span class="small">how full each block of ALERT addresses is</span></div>
        <div class="control-row as-views" role="group" aria-label="Draw the address space by">
          ${VIEWS.map(v => `<button type="button" class="${S.view === v.id ? 'primary' : ''}" aria-pressed="${S.view === v.id}"
            onclick="AddressSpace.setView('${v.id}')">${esc(v.label)}</button>`).join('')}
        </div>
        <div id="as-view">${viewHtml()}</div>
      </div>`;
  }
  function viewHtml() {
    const I = index();
    if (!I) return '<p class="small">The station list is not loaded yet.</p>';
    if (!I.reps.length) return '<p class="small">No repeater in the station list has pass ranges.</p>';
    return S.view === 'networks' ? networksHtml(I) : S.view === 'wheel' ? wheelHtml(I) : S.view === 'grid' ? gridHtml(I)
      : S.view === 'map' ? mapHtml(I) : repeatersHtml(I);
  }
  function refreshView() {
    const el = document.getElementById('as-view');
    if (!el) return;
    if (S.view !== 'map') stopMap();
    S.wheelHover = null;
    el.innerHTML = viewHtml();
    if (S.view === 'grid') drawGrid();
    if (S.view === 'wheel') drawWheel();
    if (S.view === 'map') initMap();
  }

  // ── The Allocate card ─────────────────────────────────────────────────────

  function allocHtml() {
    return `<div class="panel as-alloc" id="as-alloc">
        <div class="panel-header"><h2 id="as-alloc-h">Allocate an ALERT address</h2><span class="small">set addresses aside for a new station</span></div>
        <p class="small">Pick where the new station will report through, how many addresses it needs — a rain gauge is usually two, its rainfall and its
          battery — and what they are for. The card suggests the smallest free run that fits, keeping big blocks for stations that need them; type a first
          address to choose your own. <b>Free</b> means no station in the hub holds it and nobody has set it aside. Setting one aside puts it in the
          datastore for everybody, until a station's sensor takes it up in the station editor or somebody releases it.</p>
        <div class="as-form">
          <label class="as-where">Reports through <select id="as-where" onchange="AddressSpace.formChanged()">${whereOptions()}</select></label>
          <label>How many <input type="number" id="as-count" class="field-num" min="1" max="${MAX_ALLOC}" value="${S.form.count}" oninput="AddressSpace.formChanged()"></label>
          <label>First address <input type="number" id="as-first" class="field-num" min="1" max="${MAX}" value="${esc(S.form.first)}" placeholder="suggested" oninput="AddressSpace.formChanged()"></label>
          <label class="as-purpose">What for <input type="text" id="as-purpose" maxlength="200" value="${escAttr(S.form.purpose)}"
            placeholder="e.g. New rain gauge at Back Creek" oninput="AddressSpace.formChanged()"></label>
          <label class="as-station">For station <span class="small">(optional: its name or number)</span>
            <input type="text" id="as-station" value="${escAttr(S.form.station)}" placeholder="a station already in the register" oninput="AddressSpace.formChanged()"></label>
        </div>
        <div id="as-suggest">${suggestHtml()}</div>
        <p id="as-msg" class="small" role="status">${S.msg ? `<span class="${S.msg.ok ? 'txt-ok' : 'txt-bad'}">${esc(S.msg.text)}</span>` : ''}</p>
        <h3 class="sr-sub" id="as-list-h">Set aside</h3>
        <div id="as-list">${listHtml()}</div>
      </div>`;
  }

  function whereOptions() {
    const I = index();
    if (!I) return '<option value="">The station list is not loaded</option>';
    const free = id => tally(I, I.scopes.get(id)).free;
    const sel = v => (S.form.where === v ? ' selected' : '');
    const placed = new Set();
    const groups = I.groups.slice().sort((a, b) => a.name.localeCompare(b.name)).map(g => {
      const reps = g.reps.filter(r => !placed.has(r.id)).sort((a, b) => a.name.localeCompare(b.name));
      reps.forEach(r => placed.add(r.id));
      return `<optgroup label="${escAttr(g.loose ? g.name : `${g.name} network`)}">
        ${g.loose ? '' : `<option value="${escAttr(g.id)}"${sel(g.id)}>Anywhere in ${esc(g.name)}'s network — ${num(free(g.id))} free</option>`}
        ${reps.map(r => `<option value="${escAttr('rep:' + r.id)}"${sel('rep:' + r.id)}>${esc(r.name)} — ${num(free('rep:' + r.id))} free</option>`).join('')}</optgroup>`;
    }).join('');
    const hubs = `<optgroup label="Straight to a base, anywhere in a hub">${I.hubList.map(h => {
      const id = 'hub:' + h;
      return `<option value="${escAttr(id)}"${sel(id)}>${esc(hubName(I, h))} — ${num(free(id))} free</option>`;
    }).join('')}</optgroup>`;
    return `<option value=""${sel('')}>Pick a repeater, a network or a hub…</option>${groups}${hubs}`;
  }

  // The form read, and what it would set aside: { sc, ids, rep, hub, why[] }.
  function plan() {
    const I = index();
    const f = S.form;
    const out = { ids: [], why: [], sc: null, rep: null, hub: null, station: null };
    if (!I) { out.why.push('The station list is not loaded yet.'); return out; }
    const sc = f.where ? I.scopes.get(f.where) : null;
    if (!sc) { out.why.push('Pick where the station will report through.'); return out; }
    out.sc = sc;
    const count = Math.round(Number(f.count));
    if (!(count >= 1 && count <= MAX_ALLOC)) { out.why.push(`How many is 1 to ${MAX_ALLOC}.`); return out; }
    const inScope = a => (sc.addrs ? sc.set.has(a) : a >= 1 && a <= MAX);
    if (String(f.first).trim() !== '') {
      const first = Math.round(Number(f.first));
      if (!(first >= 1 && first + count - 1 <= MAX)) { out.why.push(`An ALERT address is 1 to ${num(MAX)}.`); return out; }
      for (let a = first; a < first + count; a++) {
        out.ids.push(a);
        const hs = holders(I, sc.hubs, a), al = allocOf(I, sc.hubs, a);
        if (!inScope(a)) out.why.push(`${a} is outside ${sc.name}'s pass ranges.`);
        else if (hs.length) out.why.push(`${a} is ${hs.map(s => s.name).join(' and ')}'s.`);
        else if (al) out.why.push(`${a} is set aside already, for “${al.purpose}”.`);
      }
    } else {
      const fit = bestFit(tally(I, sc).runs, count);
      if (!fit) { out.why.push(`${sc.name} has no ${count === 1 ? 'free address' : `run of ${count} free addresses`}${count > 1 ? ' — try fewer, or type a first address' : ''}.`); return out; }
      for (let a = fit.lo; a < fit.lo + count; a++) out.ids.push(a);
      out.fit = fit;
    }
    // The repeater that carries them all, and so the hub they go in.
    if (sc.kind === 'rep') out.rep = sc.reps[0];
    else if (sc.kind === 'net') out.rep = sc.reps.find(r => out.ids.every(a => r.carried.includes(a))) || null;
    out.hub = out.rep ? out.rep.hub : sc.hubs[0];
    if (!out.hub || !I.hubs.has(out.hub)) out.why.push('That repeater has no hub on record, and an allocation is kept in a hub.');
    if (String(f.station).trim()) {
      const q = String(f.station).trim().toLowerCase();
      const m = I.D.stations.filter(s => (s.hub_id || '') === out.hub && (s.name.toLowerCase() === q || String(s.station_number || '') === q));
      if (m.length === 1) out.station = m[0];
      else out.why.push(m.length ? `More than one station in ${hubName(I, out.hub)} answers to “${f.station}” — use its number.`
        : `No station in ${hubName(I, out.hub)} has the name or number “${f.station}” — leave it empty for a station not in the register yet.`);
    }
    if (String(f.purpose).trim().length < 3) out.why.push('Say what the addresses are for.');
    return out;
  }

  function suggestHtml() {
    const I = index();
    const p = plan();
    if (!p.sc) return `<p class="small">${esc(p.why[0] || '')}</p>`;
    const t = tally(I, p.sc);
    const count = Math.round(Number(S.form.count)) || 1;
    const fits = t.runs.filter(r => r.n >= count);
    const chips = fits.slice().sort((a, b) => b.n - a.n).slice(0, 8).sort((a, b) => a.lo - b.lo);
    const span = runsText(p.ids);
    const blocked = !mayWrite() ? (signedIn() ? 'Your account may read the allocations but not make them — an editor can.' : 'Sign in as an editor to set addresses aside.')
      : S.alloc.phase === 'missing' ? 'The datastore does not keep allocations yet — migration 0084 has to be applied first.'
        : S.alloc.phase === 'loading' ? 'Reading what is set aside already…'
          : S.alloc.phase !== 'ready' ? 'What is set aside already could not be read, so nothing can be added — see below.' : '';
    const ok = p.ids.length && !p.why.length;
    return `<p class="small">${esc(p.sc.name)}: ${num(t.free)} free of ${plural(t.n, 'address', 'addresses')} it carries (${t.full}% taken)${p.sc.hubs.length > 1 ? `, in ${esc(p.sc.hubs.map(h => hubName(I, h)).join(' and '))}` : ''}.
        ${p.ids.length ? `${p.fit ? 'Suggested' : 'Asked for'}: <b>${esc(span)}</b>${p.fit ? ` — the smallest free run that fits is ${p.fit.lo}–${p.fit.hi} (${num(p.fit.n)})` : ''}${p.rep ? `, carried by ${esc(p.rep.name)}` : p.sc.kind === 'hub' ? ', to report straight to a base' : ', no one repeater carries them all'}${p.station ? `, for ${esc(p.station.name)}` : ''}.` : ''}</p>
      ${chips.length ? `<p class="small as-runs">Free runs that fit: ${chips.map(r => `<button type="button" class="pill"${p.ids[0] === r.lo && !p.fit ? ' aria-pressed="true"' : ''} onclick="AddressSpace.useRun(${r.lo})">${r.lo === r.hi ? r.lo : `${r.lo}–${r.hi}`} <span class="small">(${num(r.n)})</span></button>`).join(' ')}
        ${fits.length > chips.length ? `<span class="small">and ${num(fits.length - chips.length)} more</span>` : ''}
        ${String(S.form.first).trim() ? `<button type="button" class="link-btn" onclick="AddressSpace.useRun(null)">Back to the suggestion</button>` : ''}</p>` : ''}
      ${p.why.length ? `<ul class="small hl-plain as-why">${p.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p><button type="button" class="primary" id="as-go" onclick="AddressSpace.allocate()"${ok && !blocked && !S.busy ? '' : ' disabled'}>
        ${S.busy ? 'Setting aside…' : p.ids.length ? `Allocate ${esc(span)}` : 'Allocate'}</button>
        ${blocked ? `<span class="small">${esc(blocked)}</span>` : ''}</p>`;
  }

  // The live allocations, a row a batch.
  function batches(I) {
    const by = new Map();
    (S.alloc.rows || []).filter(r => !r.released_at).forEach(r => {
      const b = by.get(r.batch);
      if (b) b.rows.push(r); else by.set(r.batch, { batch: r.batch, rows: [r] });
    });
    return [...by.values()].map(b => {
      const r0 = b.rows[0];
      const ids = b.rows.map(r => Number(r.alert_id)).sort((x, y) => x - y);
      const taken = I ? [...new Set(ids.flatMap(a => holders(I, [r0.hub_id], a)))] : [];
      return Object.assign(b, { ids, hub: r0.hub_id, rep: r0.repeater_id, station: r0.station_id, purpose: r0.purpose, by: r0.created_by, at: r0.created_at, taken });
    }).sort((p, q) => String(q.at).localeCompare(String(p.at)));
  }

  function listHtml() {
    const a = S.alloc;
    if (a.phase === 'signedout') return '<p class="small">Sign in to see the addresses set aside. Until then the suggestions above cannot see them — the datastore still refuses one that is taken.</p>';
    if (a.phase === 'denied') return '<p class="small">The addresses set aside are for approved accounts — yours is not approved yet. The suggestions above cannot see them.</p>';
    if (a.phase === 'missing') return '<p class="small txt-warn">The datastore does not keep allocations yet: migration 0084 is waiting to be applied (db/README.md, “Applying”).</p>';
    if (a.phase === 'error') return `<p class="small txt-bad" role="alert">${esc(a.err)}</p><p><button type="button" onclick="AddressSpace.load()">Try again</button></p>`;
    if (a.phase === 'loading' || a.phase === 'idle') return '<p class="small" aria-busy="true">Reading what is set aside…</p>';
    const I = index();
    const list = batches(I);
    if (!list.length) return '<p class="small">Nothing is set aside.</p>';
    const name = id => (I && I.byId.get(id) ? I.byId.get(id).name : id);
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="as-list-h">
      <table class="hl-table as-allocs">
        <caption class="sr-only">The ALERT addresses set aside: which, in what hub, through what repeater, what for, by whom and when, and whether a station holds them now</caption>
        <thead><tr><th scope="col">Addresses</th><th scope="col">What for</th><th scope="col" class="col-optional">Through</th>
          <th scope="col" class="col-optional">Set aside</th><th scope="col">Now</th><th scope="col"><span class="sr-only">Release</span></th></tr></thead>
        <tbody>${list.map(b => `<tr>
          <th scope="row">${esc(runsText(b.ids))}<br><span class="small">${esc(I ? hubName(I, b.hub) : b.hub)}</span></th>
          <td>${esc(b.purpose)}${b.station ? `<br><span class="small">for ${esc(name(b.station))}</span>` : ''}</td>
          <td class="small col-optional">${b.rep ? esc(name(b.rep)) : 'straight to a base'}</td>
          <td class="small col-optional">${esc(b.by || '—')}<br>${esc(day(b.at))}</td>
          <td class="small">${b.taken.length ? `<span class="txt-ok">taken up by ${b.taken.map(s => esc(s.name)).join(', ')}</span>` : 'waiting'}</td>
          <td>${mayWrite() ? `<button type="button" class="pill" onclick="AddressSpace.release(${escAttr(JSON.stringify(b.batch))})">Release</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="small">An address taken up by a station is that station's now — release the allocation to tidy the list. Releasing one that is still waiting
        makes it free again.</p>`;
  }

  function refreshCard() {
    const sel = document.getElementById('as-where');
    if (sel) sel.innerHTML = whereOptions();
    const sg = document.getElementById('as-suggest');
    if (sg) sg.innerHTML = suggestHtml();
    const ls = document.getElementById('as-list');
    if (ls) ls.innerHTML = listHtml();
    const msg = document.getElementById('as-msg');
    if (msg) msg.innerHTML = S.msg ? `<span class="${S.msg.ok ? 'txt-ok' : 'txt-bad'}">${esc(S.msg.text)}</span>` : '';
  }

  function formChanged() {
    const v = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    const where = v('as-where');
    if (where !== S.form.where) S.form.first = '';
    else S.form.first = v('as-first');
    Object.assign(S.form, { where, count: v('as-count') || 1, purpose: v('as-purpose'), station: v('as-station') });
    const first = document.getElementById('as-first');
    if (first && first.value !== String(S.form.first)) first.value = S.form.first;
    S.msg = null;
    const sg = document.getElementById('as-suggest');
    if (sg) sg.innerHTML = suggestHtml();
  }

  function useRun(lo) {
    S.form.first = lo == null ? '' : String(lo);
    const first = document.getElementById('as-first');
    if (first) first.value = S.form.first;
    const sg = document.getElementById('as-suggest');
    if (sg) sg.innerHTML = suggestHtml();
  }

  // From a figure, the map or the grid: the card set to a place (and an
  // address), and brought into view.
  function allocateIn(where, first) {
    S.form.where = where;
    S.form.first = first == null ? '' : String(first);
    if (first != null) S.form.count = 1;
    S.msg = null;
    const card = document.getElementById('as-alloc');
    if (!card) return;
    const sel = document.getElementById('as-where');
    if (sel) { sel.innerHTML = whereOptions(); sel.value = where; }
    const f = document.getElementById('as-first'); if (f) f.value = S.form.first;
    const c = document.getElementById('as-count'); if (c) c.value = S.form.count;
    const sg = document.getElementById('as-suggest'); if (sg) sg.innerHTML = suggestHtml();
    if (S.map) S.map.closePopup();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const purpose = document.getElementById('as-purpose');
    if (purpose) setTimeout(() => purpose.focus({ preventScroll: true }), 50);
  }

  async function allocate() {
    const p = plan();
    if (!p.ids.length || p.why.length || S.busy || !mayWrite() || S.alloc.phase !== 'ready') return;
    S.busy = true; S.msg = null;
    refreshCard();
    try {
      const rows = await dbRpc('allocate_alert_ids', {
        p_hub_id: p.hub, p_ids: p.ids, p_purpose: String(S.form.purpose).trim(),
        p_repeater_id: p.rep ? p.rep.id : null, p_station_id: p.station ? p.station.id : null,
      });
      S.alloc.rows = (Array.isArray(rows) ? rows : []).concat(S.alloc.rows);
      S.msg = { ok: true, text: `Set aside ${runsText(p.ids)} in ${hubName(index(), p.hub)} for “${String(S.form.purpose).trim()}”.` };
      S.form.first = ''; S.form.purpose = ''; S.form.station = '';
      ['as-first', 'as-purpose', 'as-station'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      if (typeof announce === 'function') announce(S.msg.text);
    } catch (e) {
      S.msg = { ok: false, text: e && e.denied ? 'The datastore refused: sign in as an editor to set addresses aside.' : `Not set aside: ${(e && e.message) || e}` };
    } finally {
      S.busy = false;
    }
    refreshCard();
    refreshView();
  }

  async function release(batch) {
    const I = index();
    const b = batches(I).find(x => x.batch === batch);
    if (!b || !mayWrite()) return;
    const go = typeof confirmDialog === 'function' ? await confirmDialog({
      title: `Release ${runsText(b.ids)}?`,
      message: b.taken.length ? `A station holds ${b.ids.length === 1 ? 'it' : 'them'} now (${b.taken.map(s => s.name).join(', ')}); releasing tidies the list and changes nothing on the station.`
        : `${b.ids.length === 1 ? 'It goes' : 'They go'} back to free in ${hubName(I, b.hub)}, for anybody to allocate. The record stays, with who released it.`,
      confirm: 'Release', danger: !b.taken.length,
    }) : true;
    if (!go) return;
    try {
      const rows = await dbRpc('release_alert_allocation', { p_ids: b.rows.map(r => r.id), p_note: b.taken.length ? 'taken up by a station' : '' });
      const gone = new Set((Array.isArray(rows) ? rows : []).filter(r => r.released_at).map(r => r.id));
      S.alloc.rows = S.alloc.rows.filter(r => !gone.has(r.id));
      S.msg = { ok: true, text: `Released ${runsText(b.ids)}.` };
      if (typeof announce === 'function') announce(S.msg.text);
    } catch (e) {
      S.msg = { ok: false, text: `Not released: ${(e && e.message) || e}` };
    }
    refreshCard();
    refreshView();
  }

  async function load() {
    if (!signedIn()) { S.alloc = { phase: 'signedout', rows: [], err: '' }; refreshCard(); return; }
    const seq = (S.loadSeq = (S.loadSeq || 0) + 1);
    S.alloc = { phase: 'loading', rows: S.alloc.rows || [], err: '' };
    refreshCard();
    try {
      const rows = await dbSelect('alert_allocation?select=id,batch,hub_id,alert_id,purpose,repeater_id,station_id,created_by,created_at,released_at'
        + '&released_at=is.null&order=created_at.desc,alert_id.asc&limit=2000');
      if (seq !== S.loadSeq) return;
      S.alloc = { phase: 'ready', rows, err: '' };
    } catch (e) {
      if (seq !== S.loadSeq) return;
      const msg = String((e && e.message) || e);
      const missing = (e && e.status === 404) || /alert_allocation/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg);
      S.alloc = { phase: missing ? 'missing' : (e && (e.status === 401 || e.status === 403)) ? 'denied' : 'error', rows: [], err: `Could not read what is set aside: ${msg}` };
    }
    refreshCard();
    if (S.view !== 'map') refreshView(); else drawMap();
  }

  // ── Controls ──────────────────────────────────────────────────────────────

  function setView(v) {
    S.view = VIEWS.some(x => x.id === v) ? v : 'repeaters';
    try { localStorage.setItem(VIEW_KEY, S.view); } catch (_) { /* private mode */ }
    document.querySelectorAll('.as-views button').forEach((b, i) => {
      const on = VIEWS[i].id === S.view;
      b.classList.toggle('primary', on);
      b.setAttribute('aria-pressed', String(on));
    });
    refreshView();
  }
  function setSort(v) { S.sort = ['busiest', 'fullest', 'freest', 'name'].includes(v) ? v : 'busiest'; S.shown = PAGE; refreshView(); }
  function more(all) { S.shown = all ? Infinity : S.shown + PAGE; refreshView(); }
  function showAll() { S.only = null; S.shown = PAGE; refreshView(); }
  function showRep(id) { S.only = id; setView('repeaters'); scrollTo('as-h'); }
  function setScope(id) { S.scope = id; S.pickAddr = null; S.hoverAddr = null; S.wheelSel = null; refreshView(); }
  function setMapCount(v) { S.mapCount = ['free', 'use', 'alloc'].includes(v) ? v : 'free'; drawMap(); }
  function setHubLines(on) { S.hubLines = !!on; drawHubs(); }
  function scrollTo(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  // The filter box changed: the repeaters drawn follow it, and the grid and
  // the wheel mark what it searched for.
  function onFilter() {
    if (S.view === 'repeaters') { S.shown = PAGE; refreshView(); }
    else if (S.view === 'grid') drawGrid();
    else if (S.view === 'wheel') drawWheel();
  }

  function init() {
    if (S.view === 'grid') drawGrid();
    if (S.view === 'wheel') drawWheel();
    if (S.view === 'map') initMap();
    if (!signedIn()) { S.alloc = { phase: 'signedout', rows: [], err: '' }; refreshCard(); }
    else if (S.alloc.phase !== 'ready' && S.alloc.phase !== 'loading') load();
  }

  function authChanged() {
    S.alloc = { phase: 'idle', rows: [], err: '' };
    S.msg = null;
    if (typeof state !== 'undefined' && state.activeTab === 'passranges') { if (signedIn()) load(); else init(); refreshView(); }
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  function exportCsv() {
    const I = index();
    if (!I) return;
    const sc = gridScope(I);
    if (!sc) return;
    const lines = [['address', 'status', 'stations', 'station_ids', 'set_aside_for', 'set_aside_by', 'carried_by'].join(',')];
    // Every hub together, each name says its hub: the same address is a
    // different station in each.
    const named = x => (sc.kind === 'all' ? `${x.name} (${hubName(I, x.hub_id || x.hub)})` : x.name);
    addrsOf(sc).forEach(a => {
      const hs = holders(I, sc.hubs, a), al = allocOf(I, sc.hubs, a);
      const by = (I.coverBy.get(a) || []).filter(r => sc.hubs.includes(r.hub));
      lines.push([a, WORD[cellStatus(I, sc, a)] || '', hs.map(named).join('; '), hs.map(s => s.id).join('; '),
        al ? al.purpose : '', al ? al.created_by : '', by.map(named).join('; ')].map(csvEscape).join(','));
    });
    dlText(`alert-addresses-${slug(sc.id)}.csv`, lines.join('\n') + '\n');
  }
  function exportAllocCsv() {
    const I = index();
    const list = batches(I);
    if (!list.length) return;
    const name = id => (I && id && I.byId.get(id) ? I.byId.get(id).name : id || '');
    const lines = [['address', 'hub', 'purpose', 'repeater', 'station', 'set_aside_by', 'set_aside_at', 'taken_up_by'].join(',')];
    list.forEach(b => b.rows.slice().sort((x, y) => x.alert_id - y.alert_id).forEach(r => {
      const hs = I ? holders(I, [r.hub_id], Number(r.alert_id)) : [];
      lines.push([r.alert_id, I ? hubName(I, r.hub_id) : r.hub_id, r.purpose, name(r.repeater_id), name(r.station_id), r.created_by, r.created_at,
        hs.map(s => s.name).join('; ')].map(csvEscape).join(','));
    }));
    dlText('alert-allocations.csv', lines.join('\n') + '\n');
  }

  // For the tests and the export menu.
  function state_() { return { view: S.view, sort: S.sort, shown: S.shown, only: S.only, scope: S.scope, pickAddr: S.pickAddr, alloc: S.alloc, form: { ...S.form }, msg: S.msg, map: S.map }; }
  function figures(id) {
    const I = index(), sc = I && I.scopes.get(id);
    return sc ? Object.assign({ id: sc.id, kind: sc.kind, name: sc.name, hubs: sc.hubs.slice() }, tally(I, sc)) : null;
  }
  function clustersAt() { const I = index(); return S.map && I ? clusters(I).map(c => ({ reps: c.reps.map(r => r.id), ...c.t })) : []; }
  // The wheel's view of a stretch of the grid's scope, and what it keeps.
  function stretchAt(lo, hi) {
    const I = index(), sc = I && gridScope(I);
    if (!sc) return null;
    const c = stretch(I, sc, lo, hi);
    return Object.assign({}, c, { reps: c.reps.map(x => ({ id: x.r.id, n: x.part.length })) });
  }
  function wheel() { return { sel: S.wheelSel, hover: S.wheelHover, geom: WHEEL && { D: WHEEL.D, cx: WHEEL.cx, cy: WHEEL.cy, R: WHEEL.R, rC0: WHEEL.rC0 } }; }

  return {
    allocHtml, panelHtml, init, onFilter, authChanged, load,
    setView, setSort, more, showAll, showRep, setScope, setMapCount, setHubLines, scrollTo,
    gridHover, gridClick, lookup, wheelHover, wheelClick, wheelPick, wheelKey, toGrid,
    formChanged, useRun, allocateIn, allocate, release,
    exportCsv, exportAllocCsv, state: state_, index, figures, plan, clusters: clustersAt, bestFit, stretch: stretchAt, wheel,
  };
})();
