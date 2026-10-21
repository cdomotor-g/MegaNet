// MegaNet — health-flips.js
//
//   HealthFlips   who corrupts: every bit-flipped copy a base station hears,
//                 put down to the transmitter whose carrier it came on (0078,
//                 #217's fingerprints). Two places draw it:
//                   * Station Health's "Bit flips, by who sent them" panel —
//                     each transmitter's corrupted copies against what it sent,
//                     the finding when one stands out, the recent events;
//                   * the Bit Flipper's "Seen on the air" panel — the flips an
//                     entered address was in, and who sent each.
//
// After health.js and bit-flipper.js, which draw its sections and call it, and
// datastore.js (dbSelect, dbRpc); before init.js. Nothing here runs at load.
//
// Why a carrier settles it. A legacy ALERT burst does not say who sent it, so
// the existing tools — Station Health's repeater-bitflips, the Reception Map's
// blame — can only split a corrupted copy between every repeater whose pass
// range could have carried it. Every burst arrives on the carrier of the
// transmitter that put it on the air, and RPi ALERT 0.14 measures it to tens
// of hertz: the server matches a corrupted copy's carrier to the transmitters
// that could have sent the true reading, and charges the one it came on.

const HealthFlips = (() => {

  const PAGE = 40;
  const S = {
    asked: false, loading: false, err: '',
    rows: null, overview: null, findings: [], events: null, evErr: '', showEvents: false, more: false,
    seen: new Map(),          // address → { rows } for the Bit Flipper (errors are not kept: asked again next time)
    seenAsking: new Set(),
    seenTimer: null,
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const pct = r => (r == null || !Number.isFinite(Number(r)) ? '—' : `${(Number(r) * 100).toFixed(Number(r) < 0.1 ? 1 : 0)}%`);
  const missing = err => (err && (err.code === 'PGRST205' || err.code === 'PGRST202' || err.code === '42P01' || err.status === 404))
    || /Could not find the (table|function)|does not exist/.test(String((err && err.message) || err));

  function stations() { return (typeof state !== 'undefined' && state.data && state.data.stations) || []; }

  // A transmitter key (st:<station>, a:<address>) as a name.
  function who(tx) {
    if (!tx) return { name: '', id: null, rep: false };
    const id = tx.startsWith('st:') ? tx.slice(3) : null;
    const st = id ? stations().find(s => s.id === id) : null;
    if (st) return { name: st.name, number: st.station_number || '', id: st.id, rep: (st.roles || []).includes('repeater') };
    if (tx.startsWith('a:')) return { name: `ALERT ${tx.slice(2)}`, id: null, rep: false };
    return { name: id || tx, id: null, rep: false };
  }
  const stationOf = addr => stations().find(s => (s.sensors || []).some(x => Number(x.alert_id) === Number(addr))) || null;
  function addrHtml(a) {
    const st = stationOf(a);
    const t = `${esc(String(a))}${st ? ` <span class="small">${esc(st.name)}</span>` : ' <span class="small txt-muted">no station</span>'}`;
    return typeof openBitFlipper === 'function'
      ? `<button class="link-btn" onclick="openBitFlipper(${Number(a)}, { bits: 2 })" title="Open ${escAttr(String(a))} in the Bit Flipper">${t}</button>` : t;
  }
  function txHtml(tx, how) {
    if (!tx) {
      return how === 'unmatched' ? '<span class="txt-warn">a carrier no candidate has</span>'
        : how === 'no-carrier' ? '<span class="txt-muted">no carrier measured</span>' : '<span class="txt-muted">—</span>';
    }
    const w = who(tx);
    const label = `${esc(w.name)}${w.rep ? ' <span class="small">repeater</span>' : ''}`;
    return w.id && typeof Health !== 'undefined' ? `<button class="link-btn" onclick="Health.select('${escAttr(w.id)}')">${label}</button>` : label;
  }
  const when = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };

  // ── Station Health's panel ────────────────────────────────────────────────

  async function load() {
    if (S.loading) return;
    S.asked = true; S.loading = true; S.err = '';
    try {
      const [rows, overview, findings] = await Promise.all([
        dbSelect('flip_summary?select=tx,station_id,bursts,flips,rate,clear,clear_rate,clean_upstream,addr_flips,addresses,top,fleet_rate,judged_at&flips=gt.0&order=clear.desc,flips.desc&limit=1000'),
        dbRpc('flip_overview', { p_days: 7 }),
        dbSelect('health_finding?select=kind,subject,station_id,severity,title,detail&source=eq.transmitters&kind=eq.transmitter-corrupting&cleared_at=is.null&limit=500').catch(() => []),
      ]);
      S.rows = Array.isArray(rows) ? rows : [];
      S.overview = overview || {};
      S.findings = Array.isArray(findings) ? findings : [];
    } catch (err) {
      S.err = missing(err) ? 'not on this database yet' : `Could not read the bit flips — ${(err && err.message) || err}.`;
    }
    S.loading = false;
    redraw();
  }

  async function loadEvents() {
    try {
      const ev = await dbRpc('recent_flips', { p_days: 7, p_addr: null, p_tx: null });
      S.events = Array.isArray(ev) ? ev : [];
    } catch (err) { S.events = []; S.evErr = `Could not read the recent corrupted copies — ${(err && err.message) || err}.`; }
    redraw();
  }

  function overviewHtml() {
    const o = S.overview || {};
    const by = o.by_how || {};
    const total = Number(o.corrupted) || 0;
    if (!total) {
      return `<p>No corrupted copies in the last ${num(o.days || 7)} days${Number(o.undecided) ? ` that could be told from the true reading (${num(o.undecided)} pairs stayed undecided)` : ''}.</p>`;
    }
    return `<p><b>${num(total)} corrupted cop${total === 1 ? 'y' : 'ies'}</b> in the last ${num(o.days || 7)} days:
      ${num(by.carrier || 0)} put down to the transmitter they came on, by its carrier;
      ${num(by.unmatched || 0)} on a carrier none of the true reading's possible senders has${Number(by.unmatched) ? ' (a transmitter the register does not have, or one off its usual carrier)' : ''};
      ${num(by['no-carrier'] || 0)} with no carrier measured (a base station before RPi ALERT 0.14, or not an SDR).
      ${Number(o.undecided) ? `${num(o.undecided)} pairs stayed undecided and are not counted.` : ''}
      ${Number(o.weak) ? `${num(o.weak)} were much weaker than the clean copy — likely this receiver mishearing, not the sender.` : ''}</p>`;
  }

  function rowHtml(r) {
    const f = S.findings.find(x => x.subject === r.tx);
    const status = f
      ? `<span class="${f.severity === 'critical' ? 'txt-bad' : 'txt-warn'}" title="${escAttr(f.title)}"><span aria-hidden="true">⚠</span> Corrupting</span>`
      : '<span class="txt-muted">Within the usual</span>';
    const top = (Array.isArray(r.top) ? r.top : []).slice(0, 3)
      .map(t => `${addrHtml(t.true_addr)}${t.bad_addr !== t.true_addr ? ` → ${esc(String(t.bad_addr))}` : ' <span class="small">value</span>'} ×${num(t.n)}`).join('<br>');
    return `<tr>
      <th scope="row">${txHtml(r.tx)}</th>
      <td class="num">${num(r.flips)}<br><span class="small">${num(r.clear)} clear</span></td>
      <td class="num">${num(r.bursts)}</td>
      <td class="num">${pct(r.clear_rate)}<br><span class="small">${pct(r.rate)} in all</span></td>
      <td class="num">${num(r.clean_upstream)}</td>
      <td class="num">${num(r.addr_flips)}</td>
      <td class="small">${top || '—'}</td>
      <td>${status}</td>
    </tr>`;
  }

  function eventsHtml() {
    if (!S.showEvents) return `<p><button class="btn" onclick="HealthFlips.events()">Show the recent corrupted copies</button></p>`;
    if (!S.events) return '<p class="small">Asking the server for the recent corrupted copies…</p>';
    if (S.evErr) return `<p class="small txt-bad">${esc(S.evErr)}</p>`;
    if (!S.events.length) return '<p class="small">None in the last week.</p>';
    const rows = S.events.slice(0, 200).map(e => `<tr>
      <td class="small">${esc(when(e.heard_at))}</td>
      <td>${addrHtml(e.true_addr)} = ${esc(String(e.true_value))}</td>
      <td>${e.addr_flip ? esc(String(e.bad_addr)) : ''} = ${esc(String(e.bad_value))} <span class="small">${num(e.bits)} bit${e.bits === 1 ? '' : 's'}</span></td>
      <td class="small">${txHtml(e.bad_tx, e.bad_how)}${e.bad_snr != null && e.good_snr != null && e.bad_snr < e.good_snr - 6 ? ' <span class="txt-muted">weak</span>' : ''}</td>
      <td class="small">${txHtml(e.good_tx, e.good_tx ? 'carrier' : e.good_measured ? 'unmatched' : 'no-carrier')}</td>
      <td class="small">${esc(e.rule)}</td>
    </tr>`).join('');
    return `<div class="table-wrap tall" role="region" tabindex="0" aria-label="Recent corrupted copies">
      <table class="hl-table hl-flip-events">
        <caption class="sr-only">The last week's corrupted copies, newest first: the true reading, what it was corrupted to, who sent the corrupted copy, who sent the clean one, and how the two were told apart</caption>
        <thead><tr><th scope="col">Heard</th><th scope="col">True reading</th><th scope="col">Corrupted to</th>
          <th scope="col">Corrupted copy sent by</th><th scope="col">Clean copy from</th><th scope="col">Told by</th></tr></thead>
        <tbody>${rows}</tbody></table></div>${S.events.length > 200 ? `<p class="small">The newest 200 of ${num(S.events.length)}.</p>` : ''}`;
  }

  function render() {
    if (!S.asked && typeof dbSelect === 'function') setTimeout(load, 0);
    const head = `<div class="panel-header"><h3 id="hl-h-flips">Bit flips, by who sent them</h3>
      <span class="small">each corrupted copy put down to the transmitter whose carrier it came on</span></div>`;
    if (S.err === 'not on this database yet') return head + '<p class="small txt-muted">The database this is connected to does not keep bit flips yet.</p>';
    if (S.err) return head + `<p class="small txt-bad">${esc(S.err)}</p>`;
    if (!S.rows) return head + '<p class="small">Asking the server for the bit flips…</p>';
    const flagged = S.findings.length
      ? `<p><b>${num(S.findings.length)} transmitter${S.findings.length === 1 ? '' : 's'} to look at first:</b> ${S.findings.slice(0, 3).map(f => esc(f.title)).join('; ')}${S.findings.length > 3 ? '; …' : ''}.</p>` : '';
    const shown = S.more ? S.rows : S.rows.slice(0, PAGE);
    const table = S.rows.length ? `<div class="table-wrap"><table class="hl-table hl-flip-table">
        <caption class="sr-only">Each transmitter's corrupted copies over the last week, against what it sent: clear ones (as strong as the clean copy), the rate, how often the clean version reached us from upstream too, how many were wrong in the address, the commonest, and whether it stands out</caption>
        <thead><tr><th scope="col">Sent by</th><th scope="col" class="num">Corrupted copies</th><th scope="col" class="num">Bursts it sent</th>
          <th scope="col" class="num">Clear rate</th><th scope="col" class="num">Clean upstream too</th><th scope="col" class="num">In the address</th>
          <th scope="col">Commonest</th><th scope="col">Now</th></tr></thead>
        <tbody>${shown.map(rowHtml).join('')}</tbody></table></div>
        ${S.rows.length > shown.length ? `<p><button class="btn" onclick="HealthFlips.all()">Show all ${num(S.rows.length)}</button></p>` : ''}`
      : '<p class="small">No transmitter has been caught sending a corrupted copy yet.</p>';
    return head + flagged + overviewHtml() + `
      <p class="small hl-drift-sub">A corrupted copy is a burst one or two bits from a real reading, heard by the same base station within five
        seconds of it. Which of the two is wrong is decided by the first of: an address no station has; a station not otherwise heard for
        two days; the value that does not fit its address's last reading; the version heard fewer times — and a pair none of those settle is
        left undecided, never guessed. One station's sensors in one burst, and two real reports a moment apart, are not flips. The corrupted
        copy is then charged to whichever of the true reading's possible senders — its station, the repeaters that pass it — has the carrier
        it came on. <b>Clear</b> ones were as strong as the clean copy, so the transmitter sent the wrong bits; one much weaker may be this
        receiver mishearing. <b>Clean upstream too</b> counts the times the clean version reached us as well, from the station or another
        repeater: the corruption entered at this transmitter — its own receiver, interference at its site, or its radio. A transmitter is
        flagged when five or more clear ones in a week make 2% of what it sent and three times the typical transmitter's rate. It narrows;
        it does not convict.</p>
      ${table}
      ${eventsHtml()}`;
  }

  function redraw() {
    const el = document.getElementById('hl-flips');
    if (el) el.innerHTML = render();
  }

  // ── The Bit Flipper's "Seen on the air" ───────────────────────────────────

  async function loadSeen(addr) {
    if (S.seenAsking.has(addr)) return;
    S.seenAsking.add(addr);
    let failed = null;
    try {
      const rows = await dbRpc('recent_flips', { p_days: 30, p_addr: addr, p_tx: null });
      S.seen.set(addr, { rows: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      if (missing(err)) S.seen.set(addr, { rows: [], err: 'not on this database yet' });
      else failed = String((err && err.message) || err);
    }
    S.seenAsking.delete(addr);
    const el = document.getElementById('bf-seen');
    if (el && typeof bfBaseId === 'function' && bfBaseId() === addr) {
      el.innerHTML = failed ? seenErrorHtml(failed) : seenHtml(addr);
    }
  }
  function seenErrorHtml(msg) {
    return `<div class="panel"><div class="panel-header"><h3 id="bf-seen-h">Seen on the air</h3></div>
      <p class="small txt-bad">Could not ask the server — ${esc(msg)}.</p></div>`;
  }

  function seenHtml(addr) {
    const head = `<div class="panel-header"><h3 id="bf-seen-h">Seen on the air</h3>
      <span class="small txt-muted">corrupted copies this address was in, the last 30 days, and who sent each</span></div>`;
    if (addr == null || addr > 8191) return '';
    const got = S.seen.get(addr);
    if (!got) {
      if (typeof dbRpc === 'function' && !S.seenAsking.has(addr)) setTimeout(() => loadSeen(addr), 0);
      return `<div class="panel">${head}<p class="small">Asking the server…</p></div>`;
    }
    if (got.err === 'not on this database yet') return '';
    if (got.err) return `<div class="panel">${head}<p class="small txt-bad">${esc(got.err)}</p></div>`;
    const rows = got.rows;
    if (!rows.length) return `<div class="panel">${head}<p class="small">No corrupted copy involving ${esc(String(addr))} has been heard in the last 30 days.</p></div>`;
    const asTrue = rows.filter(r => r.true_addr === addr), asBad = rows.filter(r => r.bad_addr === addr && r.true_addr !== addr);
    const tally = list => {
      const m = new Map();
      list.forEach(r => { const k = r.bad_tx || `(${r.bad_how})`; m.set(k, (m.get(k) || 0) + 1); });
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.startsWith('(') ? esc(k.slice(1, -1).replace('-', ' ')) : txHtml(k)} ×${num(n)}`).join(', ');
    };
    const lines = [];
    if (asTrue.length) lines.push(`<p><b>${num(asTrue.length)}</b> of its readings came through corrupted — sent by ${tally(asTrue)}.</p>`);
    if (asBad.length) lines.push(`<p><b>${num(asBad.length)}</b> times another station's reading turned up under ${esc(String(addr))} — sent by ${tally(asBad)}.</p>`);
    const body = rows.slice(0, 50).map(e => `<tr>
      <td class="small">${esc(when(e.heard_at))}</td>
      <td>${esc(String(e.true_addr))} = ${esc(String(e.true_value))}</td>
      <td>${esc(String(e.bad_addr))} = ${esc(String(e.bad_value))}</td>
      <td class="num">${num(e.bits)}</td>
      <td class="small">${txHtml(e.bad_tx, e.bad_how)}</td>
      <td class="small">${txHtml(e.good_tx, e.good_tx ? 'carrier' : e.good_measured ? 'unmatched' : 'no-carrier')}</td>
    </tr>`).join('');
    return `<div class="panel">${head}${lines.join('')}
      <div class="table-wrap" role="region" tabindex="0" aria-labelledby="bf-seen-h"><table class="bf-table">
        <caption class="sr-only">Corrupted copies involving this address, newest first, and who sent each</caption>
        <thead><tr><th scope="col">Heard</th><th scope="col">True reading</th><th scope="col">Corrupted to</th><th scope="col" class="num">Bits</th>
          <th scope="col">Corrupted copy sent by</th><th scope="col">Clean copy from</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${rows.length > 50 ? `<p class="small">The newest 50 of ${num(rows.length)}.</p>` : ''}</div>`;
  }

  // The address changed: ask again once typing stops.
  function seenChanged() {
    clearTimeout(S.seenTimer);
    S.seenTimer = setTimeout(() => {
      const el = document.getElementById('bf-seen');
      const a = typeof bfBaseId === 'function' ? bfBaseId() : null;
      if (el) el.innerHTML = seenHtml(a);
    }, 400);
  }

  function events() { S.showEvents = true; if (!S.events) loadEvents(); redraw(); }
  function all() { S.more = true; redraw(); }
  function state_() { return { rows: S.rows, overview: S.overview, findings: S.findings, events: S.events, err: S.err }; }

  return { render, load, events, all, seenHtml, seenChanged, state: state_ };
})();
