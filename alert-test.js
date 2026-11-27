// MegaNet — alert-test.js
//
// AlertTest — the 🧪 Path test planner, a card at the head of the Pass Ranges
// tab. Somebody going out to test a radio path to one repeater (X) needs
// ALERT addresses to transmit that nobody else will answer to, and then to
// know whether what they sent came in. Two modes:
//
//   One ID        an address only X passes on: "did X hear me, and did it get
//                 to a base?"
//   Stepped IDs   several such addresses, each sent through a different
//                 attenuation (an inline attenuator, in dB). Which of them
//                 arrive says how much fade margin the path to X has, to
//                 within one step.
//
// ── What "safe" means ────────────────────────────────────────────────────────
// For legacy ALERT, an address is safe for X when
//   · X's pass ranges cover it (X would relay it);
//   · no other repeater's pass ranges cover it (so nobody else relays it) —
//     taken over every repeater, in every hub, that is not decommissioned;
//   · no station holds it in X's hub or in the hub of a base that hears X, and
//     no live allocation (0084) has set it aside — the same "in use" and "set
//     aside" the wheel and grid show, read from AddressSpace.index().
// Where no address is safe — the common case for a backbone repeater whose
// ranges every neighbour shares — the card lists the addresses that fewest
// others carry, naming them, and says so.
// For ALERT2, Flood-Net holds no pass list per repeater, so the card can only
// promise that nobody uses the ID (no station, no slot on the slot table, not
// decoded by any base in 90 days: Alert2Ids.rows / free), and says it cannot
// promise who relays it.
//
// ── Did it arrive ────────────────────────────────────────────────────────────
// "Check Flood-Net" reads meganet.reading directly — the table the Message Log
// reads — bounded by received_at to the time since "I've started sending" (or
// the last hour), for just the test addresses, and lays the answer out on the
// card. Nothing sends the person to another tab. It only works if a base
// station can hear X: with the test address passed on by X alone there is no
// second hop, so a base must hear X's own transmissions. The card says which
// bases are on file as hearing X, and that a miss cannot tell "X did not hear
// you" from "no base hears X" — Flood-Net does not cover every network yet.
//
// The pure parts (steps, choose, candidates, infer, arrivals) take plain
// values, for test/alert-test.mjs.
//
// Exposes: AlertTest.
// Requires at call time: core.js (state, esc, escAttr, termHtml, announce),
// datastore.js (dbSelect), address-space.js (AddressSpace.index), map-backbone.js
// (backboneIndex), pass-ranges.js (passRangeProto), alert2-ids.js (Alert2Ids).

const AlertTest = (function () {
  const A_MAX = 8191;
  const FOLLOW_MS = 30000;
  const LOOKBACK_MS = 3600000;
  const MAX_AGE_MS = 24 * 3600000;       // never ask the database further back than a day
  const KEY = 'mn-alert-test';

  const WORDS = {
    safe: 'An address only the repeater you are testing passes on, that no station in its area uses and nobody has set aside — so no other repeater answers it and it cannot be mistaken for a real station\'s reading.',
    pass: 'The block of ALERT addresses a repeater is set to pass on. A message outside every repeater\'s range is not relayed.',
    others: 'Other repeaters whose pass ranges also cover this address, so they would pass it on too and the test would not be X alone.',
    attn: 'Signal taken off on purpose with an inline attenuator between your test transmitter and its antenna, in decibels (dB). More dB, weaker signal at the repeater.',
    margin: 'Fade margin: how many dB the signal at the repeater can drop before it stops being heard. Here the card reads it off the most attenuation that still arrived.',
    band: 'Good is the fade margin the map\'s colouring calls good (15 dB by default); Fair is above the floor but short of good; Poor is under the floor (6 dB by default). Both numbers are set on the map\'s fade-margin card.',
    direct: 'A base station that can hear the repeater\'s own transmissions, as the register has it: the right channel and in range. With the test address passed on by one repeater only, a base must hear that repeater directly for anything to arrive.',
    hub: 'The Bureau\'s regional grouping of stations. An ALERT address belongs to one station inside a hub, but the same number is reused in other hubs.',
    setaside: 'An address someone has reserved on the Pass Ranges tab for a station not yet installed.',
    clock: 'The time you pressed "I\'ve started sending". Only messages Flood-Net received after it are counted, so an old message cannot pass for yours.',
    a2: 'An ALERT2 address (1–65,534): a different space from legacy ALERT addresses. Flood-Net holds no pass list for ALERT2 repeaters, so it can say nobody uses an ID but not who relays it.',
  };
  const GLOSSARY = [['safe', 'Safe test address'], ['pass', 'Pass range'], ['others', 'Also carried by'], ['attn', 'Attenuation'],
                    ['margin', 'Fade margin'], ['band', 'Good / Fair / Poor'], ['direct', 'Base that hears it'], ['hub', 'Hub'],
                    ['setaside', 'Set aside'], ['clock', 'Started sending'], ['a2', 'ALERT2 ID']];

  // ── 1. pure ────────────────────────────────────────────────────────────────

  // The attenuation steps: count of them, step dB apart, from `first` dB.
  function steps(count, stepDb, first) {
    const n = Math.max(2, Math.min(10, Math.floor(Number(count)) || 5));
    const d = Math.max(1, Math.min(20, Number(stepDb) || 5));
    const f = Math.max(0, Number(first) || 0);
    return Array.from({ length: n }, (_, i) => f + i * d);
  }

  // Runs of consecutive numbers in an ascending list: [{ lo, hi, n }].
  function runs(list) {
    const out = [];
    for (const a of list) { const l = out[out.length - 1]; if (l && a === l.hi + 1) { l.hi = a; l.n++; } else out.push({ lo: a, hi: a, n: 1 }); }
    return out;
  }

  // Which of a sorted list of safe numbers to send. One: the middle of the
  // roomiest runs, so a slip of a digit lands on another safe address, up to
  // `want` of them. Several (n): a run of n consecutive numbers, the tightest
  // that has a spare one at each end, centred; failing that the roomiest run
  // with the rest from the next, flagged not consecutive.
  function choose(safe, mode, n, want) {
    const rs = runs(safe);
    if (!rs.length) return { ids: [], consecutive: true };
    if (mode === 'one') {
      const mids = rs.slice().sort((a, b) => b.n - a.n || a.lo - b.lo).slice(0, want || 5)
        .map(r => ({ id: r.lo + Math.floor((r.n - 1) / 2), room: Math.floor((r.n - 1) / 2) }));
      return { ids: mids.map(m => m.id).sort((a, b) => a - b), consecutive: true, room: new Map(mids.map(m => [m.id, m.room])) };
    }
    const fit = rs.filter(r => r.n >= n);
    if (fit.length) {
      const snug = fit.filter(r => r.n >= n + 2).sort((a, b) => a.n - b.n || a.lo - b.lo)[0]
        || fit.sort((a, b) => b.n - a.n || a.lo - b.lo)[0];
      const start = snug.lo + Math.floor((snug.n - n) / 2);
      return { ids: Array.from({ length: n }, (_, i) => start + i), consecutive: true };
    }
    const ids = [];
    for (const r of rs.slice().sort((a, b) => b.n - a.n || a.lo - b.lo)) {
      for (let a = r.lo; a <= r.hi && ids.length < n; a++) ids.push(a);
      if (ids.length >= n) break;
    }
    return { ids: ids.sort((a, b) => a - b), consecutive: false };
  }

  // The addresses X passes on, and what stands in the way of each. `I` is
  // AddressSpace.index()'s answer: reps, repById, coverBy, held, allocs.
  //   hubs: the hubs a station must not hold the address in.
  // Returns { x, safe: [a…], shared: [{ a, others }…] fewest-others first,
  //           blocked: { held, others, setAside } counts of X's addresses }.
  function candidates(I, xId, hubs) {
    const x = I && I.repById && I.repById.get(xId);
    if (!x) return null;
    const safe = [], shared = [];
    const blocked = { held: 0, others: 0, setAside: 0 };
    const hubList = hubs && hubs.length ? hubs : (I.hubList || []);
    for (const a of x.carried) {
      if (a < 1 || a > A_MAX) continue;
      const others = (I.coverBy.get(a) || []).filter(r => r.id !== xId && !(r.st && r.st.decommissioned));
      let held = null, aside = false;
      for (const h of hubList) {
        const l = I.held.get(h) && I.held.get(h).get(a);
        if (l && l.length) { held = l[0]; break; }
        if (I.allocs.get(h) && I.allocs.get(h).get(a)) aside = true;
      }
      if (held) { blocked.held++; continue; }
      if (aside) { blocked.setAside++; continue; }
      if (others.length) { blocked.others++; shared.push({ a, others: others.map(r => r.name) }); continue; }
      safe.push(a);
    }
    shared.sort((p, q) => p.others.length - q.others.length || p.a - q.a);
    return { x, safe, shared, blocked, hubs: hubList };
  }

  // What the steps say about the fade margin. `db`: the steps' attenuations;
  // `arrived`: those that arrived, by attenuation. The margin is at least the
  // most attenuation up to which every step arrived, and less than the first
  // step that did not. A step that arrived beyond a lost one is noted: the
  // loss may be the hop on to the base, not the path to X.
  function infer(db, arrived, good, ok) {
    const sorted = db.slice().sort((a, b) => a - b);
    const got = new Set(arrived);
    let lo = null, hi = null;
    for (const d of sorted) { if (got.has(d)) lo = d; else { hi = d; break; } }
    const mixed = hi != null && sorted.some(d => d > hi && got.has(d));
    let band;
    if (lo == null) band = 'none';
    else if (lo >= good) band = 'good';
    else if (hi != null && hi <= ok) band = 'poor';
    else if (lo >= ok && (hi == null || hi <= good)) band = 'fair';
    else band = 'unclear';
    return { lo, hi, mixed, band, all: hi == null && lo != null, none: lo == null };
  }

  // Readings rows → one answer per test address. `key` is the column that names
  // the address ('alert_id' or 'a2_station').
  function arrivals(rows, ids, key) {
    const out = new Map(ids.map(id => [id, { id, n: 0, first: null, last: null, paths: [], rssi: null, snr: null }]));
    for (const r of rows || []) {
      const o = out.get(Number(r[key]));
      if (!o) continue;
      o.n += 1 + (Number(r.dup_count) || 0);
      const t = r.received_at || r.reading_ts;
      if (t && (!o.last || t > o.last)) o.last = t;
      if (t && (!o.first || t < o.first)) o.first = t;
      const p = String(r.path || '').replace(/^serial-monitor\//, '');
      if (p && !o.paths.includes(p)) o.paths.push(p);
      if (r.rssi_dbm != null && (o.rssi == null || Number(r.rssi_dbm) > o.rssi)) o.rssi = Number(r.rssi_dbm);
      if (r.snr_db != null && (o.snr == null || Number(r.snr_db) > o.snr)) o.snr = Number(r.snr_db);
    }
    return out;
  }

  // The query for the check. Bounded by received_at, which is indexed, and by
  // the time since the clock — never wider than a day.
  function queryPath(proto, ids, sinceMs, nowMs) {
    const t0 = Math.max(Number(sinceMs) || 0, nowMs - MAX_AGE_MS);
    const list = ids.map(Number).filter(Number.isFinite).join(',');
    const col = proto === 'alert2' ? 'a2_station' : 'alert_id';
    const proc = proto === 'alert2' ? 'protocol=eq.2' : 'protocol=eq.1';
    return `reading?received_at=gte.${encodeURIComponent(new Date(t0).toISOString())}&${proc}&${col}=in.(${list})`
      + '&select=alert_id,a2_station,reading_ts,received_at,path,dup_count,freq_mhz,rssi_dbm,snr_db'
      + '&order=received_at.desc&limit=500';
  }

  // ALERT2: the free IDs from a number up, as a sorted list, off Alert2Ids' own rows.
  function a2Free(rows, from, free) { return free(rows, from, 400); }

  // ── 2. state ───────────────────────────────────────────────────────────────
  const S = { x: '', mode: 'one', count: 5, stepDb: 5, a2From: 60000, locked: null, res: null, follow: false, timer: 0 };
  let loaded = false;
  function load() {   // the kept plan, read the first time the card is drawn
    if (loaded) return; loaded = true;
    try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}'), { res: null, follow: false, timer: 0 }); } catch (_) { /* kept per device only */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ x: S.x, mode: S.mode, count: S.count, stepDb: S.stepDb, a2From: S.a2From, locked: S.locked })); } catch (_) { /* fine */ }
  }

  const data = () => (typeof state !== 'undefined' && state.data) || null;
  const proto = () => (typeof passRangeProto === 'function' ? passRangeProto() : 'alert');
  const goodDb = () => (typeof state !== 'undefined' && state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15);
  const okDb = () => (typeof state !== 'undefined' && isFinite(state.mapFadeOkDb) ? state.mapFadeOkDb : 6);
  const fmtT = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };

  function repeaters() {
    const D = data();
    return D ? D.stations.filter(s => (s.roles || []).includes('repeater') && s.repeater && !s.decommissioned && (s.repeater.pass_ranges || []).length)
      .sort((a, b) => String(a.name).localeCompare(String(b.name))) : [];
  }
  function stationOf(id) { const D = data(); return D ? D.stations.find(s => s.id === id) || null : null; }

  // Bases the register has hearing X: a 'base' pair in the backbone index.
  function directBases(xId) {
    if (typeof backboneIndex !== 'function') return null;
    const idx = backboneIndex();
    return (idx.pairs || []).filter(p => p.kind === 'base' && p.a && p.a.id === xId)
      .map(p => ({ id: p.b.id, name: p.b.name, hub: p.b.hub_id || '', km: p.km })).sort((a, b) => a.km - b.km);
  }

  // The plan as it stands (or as locked).
  function current() {
    const p = proto();
    const out = { proto: p, x: S.x, mode: S.mode };
    out.res = S.res;
    const st = S.x ? stationOf(S.x) : null;
    out.station = st;
    if (!st) return out;
    out.bases = directBases(S.x);
    const dbs = steps(S.count, S.stepDb, 0);
    out.steps = dbs;
    const want = S.mode === 'one' ? 5 : dbs.length;
    if (p === 'alert') {
      const I = typeof AddressSpace !== 'undefined' && AddressSpace.index ? AddressSpace.index() : null;
      const hubs = [...new Set([st.hub_id].concat((out.bases || []).map(b => b.hub)).filter(Boolean))];
      out.cand = I ? candidates(I, S.x, hubs) : null;
      if (out.cand) {
        out.pick = choose(out.cand.safe, S.mode, dbs.length, 5);
        out.ids = out.pick.ids;
        if (!out.ids.length && out.cand.shared.length) {
          out.fallback = out.cand.shared.slice(0, S.mode === 'one' ? 5 : dbs.length);
          out.ids = out.fallback.map(f => f.a).sort((a, b) => a - b);
        }
      }
    } else if (typeof Alert2Ids !== 'undefined') {
      const rows = Alert2Ids.current();
      const free = a2Free(rows, S.a2From, Alert2Ids.free);
      out.pick = choose(free, S.mode, dbs.length, 5);
      out.ids = out.pick.ids;
    }
    out.want = want;
    // Locked: the kept addresses and steps stand, whatever the list says now.
    if (S.locked && S.locked.proto === p && S.locked.x === S.x) {
      out.ids = S.locked.ids; out.steps = S.locked.steps; out.mode = S.locked.mode; out.startedAt = S.locked.startedAt;
      out.locked = true; out.fallback = S.locked.fallback || null; out.pick = null;
    }
    return out;
  }

  // ── 3. the card ────────────────────────────────────────────────────────────
  function cardHtml() {
    load();
    return `<details class="panel atp" id="atp-card"${S.x || S.locked ? ' open' : ''}>
      <summary><h2 class="atp-h">🧪 Path test planner</h2> <span class="small txt-muted">addresses to send to test the path to one repeater, and whether they arrived</span></summary>
      <div id="atp-root" class="stack">${bodyHtml()}</div></details>`;
  }

  function bodyHtml() {
    const reps = repeaters();
    if (!reps.length) return '<p class="txt-muted">The station list has no repeaters with pass ranges yet.</p>';
    const P = current();
    const opts = reps.map(r => `<option value="${escAttr(r.id)}"${r.id === S.x ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
    const stepRow = S.mode === 'steps' ? `
        <label class="tdp-ctl">How many IDs <input type="number" id="atp-count" min="2" max="10" value="${S.count}" onchange="AlertTest.set('count', this.value)"></label>
        <label class="tdp-ctl">${termHtml('Attenuation', WORDS.attn)} a step, dB <input type="number" id="atp-step" min="1" max="20" value="${S.stepDb}" onchange="AlertTest.set('stepDb', this.value)"></label>` : '';
    const a2Row = P.proto === 'alert2' ? `
        <label class="tdp-ctl">Look for ${termHtml('ALERT2 IDs', WORDS.a2)} from <input type="number" id="atp-a2from" min="1" max="65534" value="${S.a2From}" onchange="AlertTest.set('a2From', this.value)"></label>` : '';
    return `<div class="atp-controls">
        <label class="tdp-ctl">Repeater to test <select id="atp-x" onchange="AlertTest.set('x', this.value)"><option value="">Choose a repeater…</option>${opts}</select></label>
        <div class="pr-proto" role="group" aria-label="Which test">
          <button type="button" class="pr-proto-btn${S.mode === 'one' ? ' active' : ''}" aria-pressed="${S.mode === 'one'}" onclick="AlertTest.set('mode','one')"
            title="One address only the repeater passes on: did it hear you, and did it reach a base?">One ID</button>
          <button type="button" class="pr-proto-btn${S.mode === 'steps' ? ' active' : ''}" aria-pressed="${S.mode === 'steps'}" onclick="AlertTest.set('mode','steps')"
            title="Several addresses, each sent through more attenuation than the last, so which arrive says how much fade margin the path has.">Stepped IDs — fade margin</button>
        </div>${stepRow}${a2Row}</div>
      ${!S.x ? '<p class="small txt-muted">Choose the repeater you are going to test. The card finds addresses only it will answer, or says plainly that there are none.</p>' : planHtml(P)}
      ${S.x ? caveatHtml(P) : ''}
      ${wordsHtml()}`;
  }

  function planHtml(P) {
    if (!P.station) return '<p class="txt-warn">That repeater is not in the station list.</p>';
    const out = [];
    if (P.proto === 'alert') {
      if (!P.cand) return '<p class="txt-muted">The address list is still loading — try again in a moment.</p>';
      const c = P.cand;
      const total = c.x.carried.length;
      out.push(`<p class="small"><strong>${esc(P.station.name)}</strong> passes on ${total.toLocaleString('en-AU')} addresses (its ${termHtml('pass ranges', WORDS.pass)}).
        ${c.safe.length.toLocaleString('en-AU')} of them are ${termHtml('safe test addresses', WORDS.safe)}.
        ${c.blocked.others ? `${c.blocked.others.toLocaleString('en-AU')} are ${termHtml('also carried', WORDS.others)} by another repeater. ` : ''}${
          c.blocked.held ? `${c.blocked.held.toLocaleString('en-AU')} belong to a station in ${termHtml('its area', WORDS.hub)}. ` : ''}${
          c.blocked.setAside ? `${c.blocked.setAside.toLocaleString('en-AU')} are ${termHtml('set aside', WORDS.setaside)}.` : ''}</p>`);
    } else {
      out.push(`<p class="small">${termHtml('ALERT2', WORDS.a2)} has no pass list per repeater on file, so these are IDs <em>nobody uses</em> — no station, no slot on the slot table, not heard by any base in 90 days.
        Flood-Net cannot say that only ${esc(P.station.name)} relays them: check the relay settings on the repeater itself before you rely on that.</p>`);
    }
    if (!P.ids || !P.ids.length) {
      out.push(`<p class="txt-warn">${P.proto === 'alert' ? `Nothing ${esc(P.station.name)} passes on is free of other repeaters, stations and reservations, and nothing is carried by it alone.` : 'No free ALERT2 ID found from that number up. Try a higher starting number.'}</p>`);
      return out.join('');
    }
    if (P.fallback) {
      out.push(`<p class="txt-warn">No address is carried by ${esc(P.station.name)} alone. These are the nearest to it — each is also passed on by the repeaters named, so what they relay will arrive too. Do not read an arrival as ${esc(P.station.name)} alone.</p>`);
    }
    const dbs = P.steps || [];
    const stepped = P.mode === 'steps';
    const locked = !!P.locked;
    const rowsHtml = P.ids.map((id, i) => {
      const fb = P.fallback && P.fallback.find(f => f.a === id);
      const room = P.pick && P.pick.room && P.pick.room.get(id);
      const why = P.proto === 'alert2' ? 'Free: no station, slot or base has used it'
        : fb ? `Also carried by ${fb.others.join(', ')}`
        : `Only ${P.station.name} passes it on; no station or reservation${room >= 1 ? `; ${room}+ safe addresses either side` : ''}`;
      const db = stepped ? (P.steps || dbs)[i] : null;
      const r = P.res && P.res.byId && P.res.byId.get(id);
      return `<tr><th scope="row" class="tdp-num">${id}</th>${stepped ? `<td>${db} dB</td>` : '<td>normal power, no attenuator</td>'}<td class="small">${esc(why)}</td>${
        P.res && !P.res.err ? `<td>${r && r.n ? `<strong class="txt-ok">arrived</strong> ×${r.n}, last ${esc(fmtT(r.last))}${r.paths.length ? ` <span class="small txt-muted">via ${esc(r.paths[0])}</span>` : ''}${
          r.rssi != null ? ` <span class="small txt-muted">${r.rssi} dBm</span>` : ''}` : '<span class="txt-warn">not seen</span>'}</td>` : ''}</tr>`;
    }).join('');
    out.push(`<div class="table-wrap" role="region" tabindex="0" aria-label="The test addresses"><table class="tdp-table atp-table">
      <thead><tr><th scope="col" class="tdp-num">${termHtml('Address', P.proto === 'alert2' ? WORDS.a2 : WORDS.safe)}</th><th scope="col">${termHtml('Send at', WORDS.attn)}</th><th scope="col">Why this one</th>${
        P.res && !P.res.err ? '<th scope="col">In Flood-Net</th>' : ''}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`);
    if (stepped && P.pick && !P.pick.consecutive) out.push('<p class="small txt-muted">There is no run of safe addresses long enough, so these are not consecutive — keep the table by you.</p>');
    out.push(stepped
      ? '<p class="small">Put the attenuator in line for each address in turn, send it a few times, and note the order. The lowest address goes at the lowest attenuation.</p>'
      : '<p class="small">Send the address from where you are testing, at the power and antenna the station will really use. Send it a few times a minute apart.</p>');
    out.push(`<div class="button-group atp-actions">
      ${locked ? `<button type="button" onclick="AlertTest.restart()">↺ Start over</button>`
               : `<button type="button" onclick="AlertTest.lock()" title="Keeps these addresses and starts the clock. Without it they could change if the station list does.">▶ I've started sending</button>`}
      <button type="button" onclick="AlertTest.check()"${P.res && P.res.loading ? ' disabled' : ''}>🔎 Check Flood-Net</button>
      <label class="small"><input type="checkbox" ${S.follow ? 'checked' : ''} onchange="AlertTest.setFollow(this.checked)"> keep checking every 30 s</label></div>`);
    if (locked) out.push(`<p class="small txt-muted">Addresses kept. ${termHtml('Started sending', WORDS.clock)} at ${esc(fmtT(P.startedAt))}; only messages received after that count.</p>`);
    out.push(resultHtml(P));
    return out.join('');
  }

  function resultHtml(P) {
    const R = P.res;
    if (!R) return '<p id="atp-status" class="small txt-muted" role="status" aria-live="polite"></p>';
    if (R.loading) return '<p id="atp-status" class="small txt-muted" role="status" aria-live="polite">Asking Flood-Net…</p>';
    if (R.err) return `<p id="atp-status" class="txt-warn small" role="status" aria-live="polite">Could not read what Flood-Net received (${esc(R.err)}). Signing in may help; the Message Log tab shows the same rows.</p>`;
    const got = P.ids.filter(id => R.byId.get(id) && R.byId.get(id).n);
    let verdict;
    if (P.mode === 'steps') {
      const dbs = P.steps || [];
      const arrivedDb = dbs.filter((d, i) => R.byId.get(P.ids[i]) && R.byId.get(P.ids[i]).n);
      const inf = infer(dbs, arrivedDb, goodDb(), okDb());
      const name = P.station ? P.station.name : 'the repeater';
      let say;
      if (inf.none) say = `Nothing arrived, not even at ${dbs[0]} dB. Either ${esc(name)} did not hear you or no base hears it — see below.`;
      else if (inf.all) say = `Every step arrived, up to ${inf.lo} dB: the fade margin is at least <strong>${inf.lo} dB</strong>. Add more attenuation to find where it ends.`;
      else say = `Arrived up to ${inf.lo} dB and was lost at ${inf.hi} dB: ${termHtml('fade margin', WORDS.margin)} is between <strong>${inf.lo} and ${inf.hi} dB</strong>.`;
      const bandText = { good: 'Good', fair: 'Fair', poor: 'Poor', unclear: 'Not clear from these steps', none: 'No reading' }[inf.band];
      verdict = `<div class="atp-verdict atp-${inf.band}"><p>${say}</p>
        <p>${termHtml('Rated', WORDS.band)}: <strong>${bandText}</strong> <span class="small txt-muted">(good from ${goodDb()} dB, floor ${okDb()} dB)</span></p>${
        inf.mixed ? '<p class="small txt-warn">A step arrived after a lower one was lost. The loss may be the hop on to the base, not the path to the repeater — send the missing steps again.</p>' : ''}</div>`;
    } else {
      verdict = got.length
        ? `<div class="atp-verdict atp-good"><p><strong>Arrived.</strong> ${esc(P.station ? P.station.name : 'The repeater')} heard it and passed it to a base.</p></div>`
        : `<div class="atp-verdict atp-none"><p><strong>Nothing arrived yet</strong> since ${esc(fmtT(R.since))}. See the note below before reading that as a fail.</p></div>`;
    }
    return `<div id="atp-status" role="status" aria-live="polite">${verdict}<p class="small txt-muted">Checked at ${esc(fmtT(R.at))}: ${R.rows} message${R.rows === 1 ? '' : 's'} for these addresses since ${esc(fmtT(R.since))}.</p></div>`;
  }

  function caveatHtml(P) {
    if (!P.station) return '';
    const name = esc(P.station.name);
    const bases = P.bases;
    const have = bases && bases.length
      ? `On file, ${termHtml('bases that hear', WORDS.direct)} ${name}: ${bases.slice(0, 4).map(b => `${esc(b.name)} (${b.km.toFixed(0)} km)`).join(', ')}${bases.length > 4 ? ` and ${bases.length - 4} more` : ''}.`
      : bases ? `On file, <strong>no base station is recorded hearing ${name}</strong>, so a test here may never show in Flood-Net.` : '';
    return `<div class="panel atp-caveat"><p class="small"><strong>Read a miss carefully.</strong> A test address only shows in Flood-Net if a base station can hear ${name}. Only ${name} passes it on, so there is no second hop: if no base hears ${name}'s own transmissions, nothing arrives even when it heard you perfectly.
      Flood-Net does not have full coverage of every network yet, so "not seen" can mean ${name} did not hear you <em>or</em> no base hears ${name} — it cannot tell which. An arrival, though, is firm: the path to ${name} works.</p>
      ${have ? `<p class="small">${have}</p>` : ''}</div>`;
  }

  function wordsHtml() {
    return `<details class="tdp-more"><summary>What the words on this card mean</summary>
      <dl class="tds-words small">${GLOSSARY.map(([k, l]) => `<dt>${esc(l)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl></details>`;
  }

  // ── 4. actions ─────────────────────────────────────────────────────────────
  function repaint() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('atp-root');
    if (!el) { stopFollow(); return; }
    const had = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : '';
    el.innerHTML = bodyHtml();
    if (had) { const x = document.getElementById(had); if (x) x.focus(); }
  }
  function set(k, v) {
    if (k === 'x') S.x = String(v || '');
    else if (k === 'mode') S.mode = v === 'steps' ? 'steps' : 'one';
    else if (k === 'count') S.count = Math.max(2, Math.min(10, parseInt(v, 10) || 5));
    else if (k === 'stepDb') S.stepDb = Math.max(1, Math.min(20, Number(v) || 5));
    else if (k === 'a2From') S.a2From = Math.max(1, Math.min(65534, parseInt(v, 10) || 60000));
    S.res = null;
    if (S.locked && k !== 'a2From') S.locked = null;
    save(); repaint();
  }
  function lock() {
    const P = current();
    if (!P.ids || !P.ids.length) return;
    S.locked = { proto: P.proto, x: S.x, mode: S.mode, ids: P.ids.slice(), steps: (P.steps || []).slice(), fallback: P.fallback || null, startedAt: Date.now() };
    S.res = null; save(); repaint();
    if (typeof announce === 'function') announce('Kept the test addresses and started the clock.');
  }
  function restart() { S.locked = null; S.res = null; save(); repaint(); }
  async function check() {
    const P = current();
    if (!P.ids || !P.ids.length || typeof dbSelect !== 'function') return;
    const since = P.startedAt || Date.now() - LOOKBACK_MS;
    S.res = { loading: true }; repaint();
    try {
      const rows = await dbSelect(queryPath(P.proto, P.ids, since, Date.now()));
      S.res = { at: Date.now(), since: Math.max(since, Date.now() - MAX_AGE_MS), rows: rows.length, byId: arrivals(rows, P.ids, P.proto === 'alert2' ? 'a2_station' : 'alert_id') };
    } catch (e) {
      S.res = { err: String((e && e.message) || e).slice(0, 80) };
    }
    repaint();
  }
  function setFollow(on) {
    S.follow = !!on;
    stopFollow();
    if (S.follow) { S.timer = setInterval(() => { if (!document.getElementById('atp-root')) stopFollow(); else check(); }, FOLLOW_MS); check(); }
  }
  function stopFollow() { if (S.timer) { clearInterval(S.timer); S.timer = 0; } }

  return { WORDS, cardHtml, set, lock, restart, check, setFollow, repaint, current,
           // Pure, for the tests.
           steps, runs, choose, candidates, infer, arrivals, queryPath };
})();
if (typeof window !== 'undefined') window.AlertTest = AlertTest;
