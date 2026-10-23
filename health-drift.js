// MegaNet — health-drift.js
//
//   HealthDrift   the Station Health tab's Transmitter frequency panel: every
//                 transmitter a base station hears — legacy ALERT stations and
//                 repeaters, and ALERT2 — with its carrier offset against the
//                 rest, how far it has moved, a line of its days, and the
//                 server's drift and off-channel findings (#217; 0075, 0077).
//                 And one station's of them, as its *Carrier fingerprint*: on
//                 its card on the Stations map, under its ALERT IDs and
//                 frequencies, and in the station editor's Telemetry section —
//                 its offset, whether it was heard on the channel the register
//                 says it transmits on, and whether it is drifting.
//
// After health.js (which draws this panel's section and calls render()) and
// datastore.js (dbSelect); before init.js. Nothing here runs at load: the
// first render() asks the database once — meganet.transmitter_summary, one row
// a transmitter as the server last judged it (hourly), and the open findings
// of source `transmitters` — and redraws only its own section when they come.
// app.js's stnCardHtml() places cardHtml() and repaintStnCard() calls
// cardAsk(); station-editor.js's editorForm() places editorHtml(). Both read
// frequencies.js (Frequencies.pairs) for the TX on record, and app.js
// (stationAlertIds) for the addresses a station shares, at call time.
//
// What the numbers are. The base stations' SDRs measure every burst's carrier
// offset. A legacy burst does not say who sent it, so the server puts each
// down to its transmitter first: the station, or the repeater that relayed it
// — found from the register's pass ranges and the one carrier a repeater's
// relays share (0077). An ALERT2 copy says so in its path. Each receiver's own
// crystal error, which moves everything it hears together, is worked out day
// by day and taken out, and each transmitter is measured against the median of
// the fleet that receiver hears. So 0 ppm is "like the rest", not "exactly on
// frequency"; a transmitter far from the rest, or one moving, is the one to
// check.

const HealthDrift = (() => {

  const PAGE = 60;
  const S = {
    asked: false,
    loading: false,
    err: '',
    rows: null,        // transmitter_summary rows
    findings: [],      // open findings, source transmitters
    warn: 2.5,         // the off-channel line, ppm (app_meta tx_offset_warn_ppm)
    drift: 1,          // the drift line, ppm against the 30 days before (tx_drift_warn_ppm)
    show: 'look',      // 'look' (findings and near the line) | 'all'
    kind: 'all',       // 'all' | 'alert' | 'alert2' | 'repeater'
    q: '',
    more: false,
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const sgn = (v, d) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
  const DAY = 86400000;
  const todayUtc = () => Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const dayMs = d => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
  const quietly = p => p.catch(() => []);
  const COLS = 'tx,protocol,station_id,via,freq_mhz,w_days,w_ppm,w_hz,b_days,b_ppm,change_ppm,bursts,receivers,days,ppm,judged_at';
  const F_COLS = 'kind,subject,station_id,severity,title,detail,first_seen';
  // A database before 0077 has no transmitter_summary.
  const missing = err => !!(err && (err.code === 'PGRST205' || err.code === '42P01' || err.status === 404))
    || /Could not find the table|does not exist/.test(String((err && err.message) || err));

  // The two lines, asked once whoever needs them first — the panel or a card.
  let knobsAsked = null;
  function askKnobs() {
    if (!knobsAsked) {
      // Kept once answered; a failure keeps the defaults and is asked again
      // by whoever needs them next.
      knobsAsked = dbSelect('app_meta?select=key,value&key=in.(tx_offset_warn_ppm,tx_drift_warn_ppm)').then(list => {
        (list || []).forEach(k => {
          const v = Number(k.value);
          if (!Number.isFinite(v) || v <= 0) return;
          if (k.key === 'tx_offset_warn_ppm') S.warn = v;
          if (k.key === 'tx_drift_warn_ppm') S.drift = v;
        });
      }, () => { knobsAsked = null; });
    }
    return knobsAsked;
  }

  async function load() {
    if (S.loading) return;
    S.asked = true; S.loading = true; S.err = '';
    try {
      const [rows, findings] = await Promise.all([
        dbSelect(`transmitter_summary?select=${COLS}&limit=5000`),
        quietly(dbSelect(`health_finding?select=${F_COLS}&source=eq.transmitters&cleared_at=is.null&limit=5000`)),
        askKnobs(),
      ]);
      adoptRows(rows, findings);
    } catch (err) {
      // A database before 0077 has no transmitter_summary: say so quietly.
      S.err = missing(err)
        ? 'not on this database yet'
        : `Could not read the transmitter offsets — ${(err && err.message) || err}.`;
    }
    S.loading = false;
    redraw();
    // A card or the editor open on a station reads the whole table now.
    paintOpen();
  }

  function adoptRows(rows, findings) {
    S.rows = Array.isArray(rows) ? rows : [];
    S.findings = Array.isArray(findings) ? findings : [];
  }

  // Who a transmitter is: its station (and number) when the register knows
  // it, else its address.
  function who(r) {
    const stations = (typeof state !== 'undefined' && state.data && state.data.stations) || [];
    const st = r.station_id ? stations.find(s => s.id === r.station_id) : null;
    const tail = String(r.tx).replace(/^[a-z0-9]+:/, '');
    const isRep = r.via === 'repeater' || !!(st && (st.roles || []).includes('repeater'));
    if (st) return { name: st.name, number: st.station_number || '', id: st.id, rep: isRep };
    if (r.tx.startsWith('a2:')) return { name: `ALERT2 ${tail}`, number: '', id: null, rep: isRep };
    if (r.tx.startsWith('a:')) return { name: `ALERT ${tail}`, number: '', id: null, rep: isRep, shared: true };
    return { name: r.station_id || tail, number: '', id: null, rep: isRep };
  }

  function summary() {
    if (!S.rows) return [];
    const fBy = new Map();
    S.findings.forEach(f => {
      const was = fBy.get(f.subject);
      if (!was || (f.severity === 'critical' && was.severity !== 'critical')) fBy.set(f.subject, f);
    });
    return S.rows.map(r => {
      const w = who(r);
      const days = (r.days || []).map(dayMs), ppm = (r.ppm || []).map(Number);
      return {
        tx: r.tx, protocol: r.protocol, via: r.via, who: w,
        ppm: r.w_ppm == null ? null : Number(r.w_ppm), hz: r.w_hz == null ? null : Number(r.w_hz),
        change: r.change_ppm == null ? null : Number(r.change_ppm),
        days: Number(r.w_days) || 0, bursts: Number(r.bursts) || 0, receivers: Number(r.receivers) || 0,
        freq: r.freq_mhz == null ? null : Number(r.freq_mhz),
        pts: days.map((t, i) => ({ t, ppm: ppm[i] })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.ppm)),
        finding: fBy.get(r.tx) || null,
        judgedAt: r.judged_at || null,
      };
    }).sort((x, y) => (!!y.finding - !!x.finding) || (Math.abs(y.ppm ?? 0) - Math.abs(x.ppm ?? 0)) || (x.tx < y.tx ? -1 : 1));
  }

  const near = r => r.finding || (r.ppm != null && Math.abs(r.ppm) >= S.warn * 0.8) || (r.change != null && Math.abs(r.change) >= 0.5);
  const ofKind = (r, k) => (k === 'all' ? true : k === 'repeater' ? r.who.rep : r.protocol === k && !(k === 'alert' && r.who.rep));
  function filtered(rows) {
    const q = S.q.trim().toLowerCase();
    return rows.filter(r => (S.show === 'all' || near(r)) && ofKind(r, S.kind)
      && (!q || `${r.who.name} ${r.who.number} ${r.tx}`.toLowerCase().includes(q)));
  }

  function sparkSvg(pts) {
    const W = 120, H = 28, DAYS = 37, t1 = todayUtc(), t0 = t1 - (DAYS - 1) * DAY;
    const lim = Math.max(S.warn * 1.2, ...pts.map(p => Math.abs(p.ppm || 0)));
    const x = t => ((t - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2;
    const y = v => H / 2 - (v / lim) * (H / 2 - 2);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.ppm).toFixed(1)}`).join('');
    const dots = pts.length < 3 ? pts.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.ppm).toFixed(1)}" r="1.6" fill="currentColor"/>`).join('') : '';
    return `<svg class="hl-drift-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`
      + `<rect x="0" y="${y(S.warn).toFixed(1)}" width="${W}" height="${(y(-S.warn) - y(S.warn)).toFixed(1)}" fill="currentColor" opacity="0.07"/>`
      + `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="2 2"/>`
      + (pts.length ? `<path d="${line}" fill="none" stroke="currentColor" stroke-width="1.5"/>${dots}` : '') + '</svg>';
  }

  function statusHtml(r) {
    if (r.finding) {
      const cls = r.finding.severity === 'critical' ? 'txt-bad' : 'txt-warn';
      const word = r.finding.kind === 'transmitter-drift' ? 'Drifting' : 'Off the rest';
      return `<span class="${cls}" title="${escAttr(r.finding.title)}"><span aria-hidden="true">⚠</span> ${esc(word)}</span>`;
    }
    if (r.ppm != null && Math.abs(r.ppm) >= S.warn * 0.8) return '<span class="txt-muted">Near the line</span>';
    return '<span class="txt-muted">Like the rest</span>';
  }

  const kindWord = r => (r.who.rep ? 'Repeater' : r.protocol === 'alert2' ? 'ALERT2' : 'ALERT');

  function nameHtml(r) {
    const w = r.who;
    const label = `<b>${esc(w.name)}</b>${w.number ? ` <span class="small">${esc(w.number)}</span>` : ''}`;
    const named = w.id && typeof Health !== 'undefined'
      ? `<button class="link-btn" onclick="Health.select('${escAttr(w.id)}')">${label}</button>` : label;
    return `${named}<br><span class="small">${esc(kindWord(r))}${w.shared ? ' · an address two stations share' : ''}</span>`;
  }

  function tableHtml(rows) {
    const body = rows.map(r => `
      <tr>
        <th scope="row">${nameHtml(r)}</th>
        <td class="num">${sgn(r.ppm, 2)} <span class="small">ppm</span><br><span class="small">${sgn(r.hz, 0)} Hz</span></td>
        <td class="num">${r.change == null ? '<span class="small txt-muted">too soon</span>' : `${sgn(r.change, 2)} <span class="small">ppm</span>`}</td>
        <td>${sparkSvg(r.pts)}</td>
        <td class="num">${num(r.days)}</td>
        <td class="num">${num(r.bursts)}</td>
        <td>${statusHtml(r)}</td>
      </tr>`).join('');
    return `<div class="table-wrap"><table class="hl-table hl-drift-table">
      <caption class="sr-only">Each transmitter's carrier offset against the others the same receivers hear: the last week, its change from the thirty days before, its days, and the server's finding</caption>
      <thead><tr><th scope="col">Transmitter</th><th scope="col" class="num">Last 7 days</th><th scope="col" class="num">Change from the 30 before</th>
        <th scope="col">37 days</th><th scope="col" class="num">Days</th><th scope="col" class="num">Bursts</th><th scope="col">Now</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function controlsHtml(all) {
    const n = k => all.filter(r => ofKind(r, k)).length;
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(label)}</option>`;
    return `<div class="hl-drift-controls">
      <label>Show <select onchange="HealthDrift.set('show', this.value)">
        ${opt('look', 'Needs a look', S.show)}${opt('all', 'Every transmitter', S.show)}</select></label>
      <label>Kind <select onchange="HealthDrift.set('kind', this.value)">
        ${opt('all', `All (${all.length})`, S.kind)}${opt('alert', `Legacy ALERT stations (${n('alert')})`, S.kind)}
        ${opt('repeater', `Repeaters (${n('repeater')})`, S.kind)}${opt('alert2', `ALERT2 (${n('alert2')})`, S.kind)}</select></label>
      <label>Find <input type="search" value="${escAttr(S.q)}" placeholder="Name, number or address" aria-label="Find a transmitter"
        oninput="HealthDrift.set('q', this.value)"></label>
    </div>`;
  }

  function render() {
    if (!S.asked && typeof dbSelect === 'function') setTimeout(load, 0);
    const head = `
      <div class="panel-header"><h3 id="hl-h-drift">Transmitter frequency</h3>
        <span class="small">each transmitter's carrier against the others, and whether it is moving</span></div>`;
    if (S.err === 'not on this database yet') return head + '<p class="small txt-muted">The database this is connected to does not keep carrier offsets yet.</p>';
    if (S.err) return head + `<p class="small txt-bad">${esc(S.err)}</p>`;
    if (!S.rows) return head + '<p class="small">Asking the server for the carrier offsets…</p>';
    const all = summary();
    if (!all.length) {
      return head + '<p class="small">No transmitter has been heard often enough by a base station to measure yet. Legacy ALERT stations are measured once a base station runs RPi ALERT 0.14 or later.</p>';
    }
    const flagged = all.filter(r => r.finding);
    const legacy = all.filter(r => r.protocol === 'alert').length;
    const at = all[0].judgedAt ? new Date(all[0].judgedAt) : null;
    const lead = flagged.length
      ? `<p><b>${num(flagged.length)} of ${num(all.length)} transmitter${all.length === 1 ? '' : 's'} to check</b> — ${flagged.slice(0, 3).map(r => esc(r.finding.title)).join('; ')}${flagged.length > 3 ? '; …' : ''}.</p>`
      : `<p>All ${num(all.length)} transmitters measured are within ${esc(String(S.warn))} ppm of the rest, and none has moved by ${esc(String(S.drift))} ppm in a week.</p>`;
    const rows = filtered(all);
    const shown = S.more ? rows : rows.slice(0, PAGE);
    const empty = !rows.length
      ? `<p class="small">${S.show === 'look' ? 'Nothing here needs a look. <button class="link-btn" onclick="HealthDrift.set(\'show\', \'all\')">Show every transmitter</button>' : 'No transmitter matches.'}</p>` : '';
    const more = rows.length > shown.length
      ? `<p><button class="btn" onclick="HealthDrift.set('more', true)">Show all ${num(rows.length)}</button></p>` : '';
    return head + lead + `
      <p class="small hl-drift-sub">${num(legacy)} legacy ALERT and ${num(all.length - legacy)} ALERT2 transmitters, judged by the server
        ${at ? `at ${esc(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : 'hourly'}.
        Base stations measure every burst's carrier offset. A burst relayed by a repeater is on the repeater's carrier, so the server puts each
        down to whoever sent it — the station, or its repeater (found from the register's pass ranges and the carrier its relays share) — and repeaters
        are measured too. Each receiver's own crystal error is worked out day by day and taken out, and each transmitter is shown against the median
        of the fleet that receiver hears — so 0 ppm is <em>like the rest</em>, not exactly on frequency, and the shaded band is ±${esc(String(S.warn))} ppm.
        Further than that from the rest over a week is a warning; a move of ${esc(String(S.drift))} ppm against the thirty days before is drift — usually an ageing crystal, or a
        site running hot or cold, and worth a visit before it goes quiet.</p>
      ${controlsHtml(all)}
      ${empty || tableHtml(shown)}${more}`;
  }

  function redraw() {
    const el = document.getElementById('hl-drift');
    if (!el) return;
    const had = document.activeElement && el.contains(document.activeElement) && document.activeElement.type === 'search';
    // The heading, focused by a door from a station's carrier fingerprint
    // (open) before the rows came: it keeps the focus through the redraw.
    const head = document.activeElement && document.activeElement.id === 'hl-h-drift';
    el.innerHTML = render();
    if (had) {
      const box = el.querySelector('input[type="search"]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
    const h = head && document.getElementById('hl-h-drift');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function set(k, v) {
    if (!['show', 'kind', 'q', 'more'].includes(k)) return;
    S[k] = v;
    if (k !== 'more') S.more = false;
    redraw();
  }

  // ── One station's carrier: its card, and the station editor ─────────────
  // What somebody looking at one station wants of the panel above: where its
  // carrier sits against the rest, whether it was heard on the channel the
  // register says it transmits on, and whether it is moving. The same block
  // on its card on the Stations map, under its ALERT IDs and frequencies, and
  // in the station editor's Telemetry section, word for word.
  //
  // Whose rows: its station's — `st:<id>`, and an ALERT2 address the server
  // resolved to it — and any `a:<address>` row for an address it shares with
  // another station, which is its carrier as much as the other's. One request
  // a station (its findings beside it, in parallel), kept for CARD_TTL — the
  // server judges hourly, so a repaint or a second look asks nothing — and
  // none at all once this tab's panel holds the whole table.
  //
  // The channel check is the register's word against the base stations'. A
  // repeater's TX (and any other pair's) is on record; the channel its bursts
  // were heard on is the receiver's. Where they differ by more than SAME_MHZ —
  // channels here are 12.5 kHz apart, a carrier's offset a few hundred hertz —
  // one of them is wrong: the record, or what was put down to the station (a
  // repeater its pass ranges do not show, relaying it on its own channel).

  const CARD_TTL = 10 * 60000;
  const SAME_MHZ = 0.002;
  const cards = new Map();     // station id → { status, at, rows, findings, error }
  const quoted = v => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
  const fin = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  // 151.500, 151.5375: three places, or four where the channel has them.
  const mhzText = f => { const t = Number(f).toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many || one + 's'}`;
  const sevCls = f => (f && f.severity === 'critical' ? 'txt-bad' : 'txt-warn');

  function stationOf(id) {
    const list = (typeof state !== 'undefined' && state.data && state.data.stations) || [];
    return list.find(s => s.id === id) || null;
  }

  function txKeys(s) {
    const keys = [`st:${s.id}`];
    if (fin(s.alert2_station_id) != null) keys.push(`a2:${fin(s.alert2_station_id)}`);
    (typeof stationAlertIds === 'function' ? stationAlertIds(s) : []).forEach(a => keys.push(`a:${a}`));
    return keys;
  }
  const mine = (s, list, key) => { const k = new Set(txKeys(s)); return (list || []).filter(r => r.station_id === s.id || k.has(r[key])); };

  // The TX frequencies the register has for it: a repeater's own pair, and
  // any other pair's (frequencies.js).
  function txOnRecord(s) {
    const pairs = typeof Frequencies !== 'undefined' && Frequencies.pairs ? Frequencies.pairs(s) : [];
    return [...new Set(pairs.map(f => fin(f.tx_mhz)).filter(v => v != null && v > 0))];
  }

  // The answer for a station: the panel's table when it has one, else its card's.
  function answerOf(s) {
    if (S.rows) return { status: 'ok', rows: mine(s, S.rows, 'tx'), findings: mine(s, S.findings, 'subject') };
    if (S.err === 'not on this database yet') return { status: 'missing' };
    return cards.get(s.id) || null;
  }

  function cardAsk(s) {
    if (!s || !s.id || s.proposed || S.rows || typeof dbSelect !== 'function') return;
    const c = cards.get(s.id);
    // A failed answer is asked again sooner: a signal that comes and goes is
    // the ordinary case in the field.
    if (c && (c.status === 'loading' || c.status === 'missing' || Date.now() - c.at < (c.status === 'error' ? 60000 : CARD_TTL))) return;
    runCard(s);
  }

  async function runCard(s) {
    const id = s.id;
    const prev = cards.get(id);
    const entry = { status: 'loading', at: Date.now(), rows: prev ? prev.rows : null, findings: prev ? prev.findings : [], error: '' };
    cards.set(id, entry);
    paint(id);
    const keys = txKeys(s).map(quoted).join(',');
    const tx = `or=${encodeURIComponent(`(station_id.eq.${quoted(id)},tx.in.(${keys}))`)}`;
    const subj = `or=${encodeURIComponent(`(station_id.eq.${quoted(id)},subject.in.(${keys}))`)}`;
    try {
      const [rows, findings] = await Promise.all([
        dbSelect(`transmitter_summary?select=${COLS}&${tx}&limit=50`),
        quietly(dbSelect(`health_finding?select=${F_COLS}&source=eq.transmitters&cleared_at=is.null&${subj}&limit=50`)),
        askKnobs(),
      ]);
      if (cards.get(id) !== entry) return;       // asked again since; that answer wins
      Object.assign(entry, { status: 'ok', at: Date.now(), rows, findings: findings || [] });
    } catch (err) {
      if (cards.get(id) !== entry) return;
      Object.assign(entry, missing(err) ? { status: 'missing', at: Date.now() }
        : { status: 'error', at: Date.now(), error: (err && err.message) || String(err) });
    }
    paint(id);
  }

  function retry(id) {
    const s = stationOf(id);
    if (!s) return;
    cards.delete(id);
    runCard(s);
  }

  // A row's three lines, and what it is, as acma-rows.
  const line = (label, html) => `<div class="acma-row"><span>${esc(label)}</span><span>${html}</span></div>`;
  const note = html => ` <span class="mn-pop-note hd-card-why">${html}</span>`;

  function offsetHtml(r, off) {
    const ppm = fin(r.w_ppm), hz = fin(r.w_hz);
    if (ppm == null) {
      const last = (r.days || []).length ? dayMs(r.days[r.days.length - 1]) : NaN;
      return `<span class="txt-muted">not measured in the last week</span>${Number.isFinite(last)
        ? note(`last on ${esc(new Date(last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}`) : ''}`;
    }
    const verdict = off ? `<span class="${sevCls(off)}" title="${escAttr(off.title)}"><span aria-hidden="true">⚠</span> off the rest</span>`
      : Math.abs(ppm) >= S.warn * 0.8 ? `near the ±${esc(String(S.warn))} ppm line`
      : '<span class="txt-muted">like the rest</span>';
    return `${hz == null ? '' : `${sgn(hz, 0)} Hz · `}${sgn(ppm, 2)} ppm — ${verdict}`;
  }

  function channelHtml(s, r) {
    const f = fin(r.freq_mhz);
    if (f == null) return '';
    const rec = txOnRecord(s);
    const heard = `heard on ${esc(mhzText(f))} MHz`;
    if (!rec.length) return line('Channel', `${heard}${note('no TX on record to check it against')}`);
    if (rec.some(t => Math.abs(t - f) < SAME_MHZ)) {
      return line('Channel', `${heard} — <span class="txt-ok"><span aria-hidden="true">✓</span> its TX on record</span>`);
    }
    const onRec = rec.map(t => `${mhzText(t)}`).join(' or ');
    const why = r.via === 'repeater'
      ? 'Its relays were heard there, so the record looks out of date.'
      : 'Either the record is out of date, or this was another transmitter relaying it — a repeater its pass ranges do not show.';
    return line('Channel', `${heard} — <span class="txt-warn"><span aria-hidden="true">⚠</span> its TX on record is ${esc(onRec)} MHz</span>${note(esc(why))}`);
  }

  function driftHtml(r, drift) {
    const change = fin(r.change_ppm);
    const vs = 'against the 30 days before';
    if (drift) {
      return `<span class="${sevCls(drift)}" title="${escAttr(drift.title)}"><span aria-hidden="true">⚠</span> drifting</span> — `
        + `${change == null ? '' : `${sgn(change, 2)} ppm `}${vs}`;
    }
    if (change != null) {
      const a = Math.abs(change);
      const word = a >= S.drift ? `<span class="txt-warn">drifting</span>` : a >= S.drift / 2 ? 'moving' : '<span class="txt-muted">steady</span>';
      return `${sgn(change, 2)} ppm ${vs} — ${word}`;
    }
    // Not judged yet: the server compares the last week with the thirty days
    // before once it has 3 days of one and 5 of the other. Meanwhile, how far
    // apart the days it has are.
    const pts = (r.ppm || []).map(Number).filter(Number.isFinite);
    const w = Number(r.w_days) || 0, b = Number(r.b_days) || 0;
    const spread = pts.length >= 2 ? Math.max(...pts) - Math.min(...pts) : null;
    return '<span class="txt-muted">too soon to judge</span>' + note(
      `it needs 3 days measured in the last week and 5 in the 30 before; it has ${num(w)} and ${num(b)}`
      + (spread == null ? '' : `. Its ${num(pts.length)} days so far are within ${spread.toFixed(2)} ppm of each other`) + '.');
  }

  function kindText(r) {
    const tail = String(r.tx).replace(/^[a-z0-9]+:/, '');
    if (r.tx.startsWith('a2:')) return `ALERT2, address ${tail}`;
    if (r.tx.startsWith('a:')) return `legacy ALERT, address ${tail} — one it shares with another station`;
    return r.via === 'repeater' ? 'legacy ALERT, as a repeater — its relays' : 'legacy ALERT';
  }

  function txBlockHtml(s, r, findings) {
    const fs = findings.filter(f => f.subject === r.tx);
    const off = fs.find(f => f.kind === 'transmitter-off-channel');
    const drift = fs.find(f => f.kind === 'transmitter-drift');
    const other = fs.filter(f => f !== off && f !== drift);
    const pts = (r.days || []).map((d, i) => ({ t: dayMs(d), ppm: Number((r.ppm || [])[i]) }))
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.ppm));
    return `<div class="hd-card-tx" data-tx="${escAttr(r.tx)}">
      ${line('Offset', offsetHtml(r, off))}
      ${channelHtml(s, r)}
      ${line('Drift', driftHtml(r, drift))}
      ${other.map(f => line('Also', `<span class="${sevCls(f)}"><span aria-hidden="true">⚠</span> ${esc(f.title)}</span>`)).join('')}
      ${pts.length ? `<div class="hd-card-spark">${sparkSvg(pts)}${note(`its last 37 days against the rest; the band is ±${esc(String(S.warn))} ppm`)}</div>` : ''}
      ${note(`${esc(kindText(r))} · ${plural(Number(r.w_days) || 0, 'day')} in the last week, ${plural(Number(r.bursts) || 0, 'burst')}, `
        + `${plural(Number(r.receivers) || 0, 'base station')}`)}
    </div>`;
  }

  function bodyHtml(s) {
    const a = answerOf(s);
    const again = `<button type="button" class="link-btn" onclick="HealthDrift.retry('${escAttr(s.id)}')">Try again</button>`;
    if (!a || a.status === 'loading' && !a.rows) return `<span class="mn-pop-line mn-pop-indent txt-muted" aria-busy="true">asking the server…</span>`;
    if (a.status === 'missing') return `<span class="mn-pop-line mn-pop-indent txt-muted">not kept on this database yet</span>`;
    if (a.status === 'error' && !a.rows) {
      return `<span class="mn-pop-line mn-pop-indent txt-muted">could not ask the server (${esc(a.error)}) — ${again}</span>`;
    }
    const rows = (a.rows || []).slice().sort((x, y) => (x.tx.startsWith('st:') ? 0 : 1) - (y.tx.startsWith('st:') ? 0 : 1) || (x.tx < y.tx ? -1 : 1));
    const door = `<button type="button" class="link-btn" onclick="HealthDrift.open('${escAttr(s.id)}')"
        title="${escAttr(`Open the Station Health tab's Transmitter frequency panel on ${s.name || s.id}`)}">Transmitter frequency in Station Health</button>`;
    if (!rows.length) {
      return `<span class="mn-pop-line mn-pop-indent">not measured yet</span>${note(`No base station's SDR has heard its own carrier
        often enough — three bursts in a day, on RPi ALERT 0.14 or later. A station heard only through its repeater is measured as the
        repeater, and a station whose carrier sits within 30 Hz of its repeater's is put down to the repeater.`)}`;
    }
    const at = rows[0].judged_at ? new Date(rows[0].judged_at) : null;
    return rows.map(r => txBlockHtml(s, r, a.findings || [])).join('')
      + note(`Its carrier against the other transmitters the same base stations hear, each receiver's own error taken out — so 0 is
        like the rest, not exactly on frequency. Judged hourly${at && Number.isFinite(at.getTime())
          ? `, last at ${esc(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ''}${a.status === 'loading' ? ', asking again…' : ''}. ${door}`);
  }

  // The card's block, under the ALERT IDs and frequencies (stnCardHtml). The
  // answer is asked for by repaintStnCard() → cardAsk(), and painted in place.
  function cardHtml(s) {
    if (!s || !s.id || s.proposed) return '';
    return `<div class="stn-card-ids stn-card-carrier" id="mn-carrier-card-${escAttr(s.id)}" data-mn-carrier="${escAttr(s.id)}">
      <span class="small txt-muted">Carrier fingerprint</span>
      <div class="hd-card-body">${bodyHtml(s)}</div></div>`;
  }

  // The editor's, in its Telemetry section: the same block, asked for if the
  // card has not (one request, shared with the card), its body painted in
  // place when the answer lands — the form around it is never redrawn.
  function editorHtml(s) {
    if (!s || !s.id || s.proposed) return '';
    cardAsk(s);
    return `<div class="full ef-section ef-carrier" id="ef-carrier" data-mn-carrier="${escAttr(s.id)}">
      <div class="ef-sub">Carrier fingerprint ${typeof hintToggleHtml === 'function' ? hintToggleHtml('ef-h-carrier', 'the carrier fingerprint') : ''}</div>
      <div class="small ef-note hint-fold" id="ef-h-carrier" hidden>
        Every burst a base station's SDR decodes comes on its transmitter's carrier, a few hundred hertz either side of the channel —
        each crystal's own, so it tells transmitters apart. The server puts each burst down to whoever sent it, this station or the
        repeater that relayed it, and measures each against the rest the same base stations hear. <b>Offset</b> is the last week's
        (±${esc(String(S.warn))} ppm off the rest is a warning); <b>Channel</b> is the channel it was heard on, checked against the TX
        saved for it in the register; <b>Drift</b> is how far it has moved against the thirty days before (${esc(String(S.drift))} ppm
        is drift — usually an ageing crystal, or a site running hot or cold, and it tends to end in silence).
      </div>
      <div class="hd-card-body" id="ef-carrier-body">${bodyHtml(s)}</div></div>`;
  }

  // Paint the block in place wherever it is open on this station.
  function paint(id) {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-mn-carrier]').forEach(el => {
      if (el.dataset.mnCarrier !== String(id)) return;
      const s = stationOf(id);
      const body = el.querySelector('.hd-card-body');
      if (s && body) body.innerHTML = bodyHtml(s);
    });
  }
  function paintOpen() {
    if (typeof document === 'undefined') return;
    new Set([...document.querySelectorAll('[data-mn-carrier]')].map(el => el.dataset.mnCarrier)).forEach(paint);
  }

  // The door: the Station Health tab on the station, at the Transmitter
  // frequency panel, found there by its name among every transmitter.
  function open(id) {
    const s = stationOf(id);
    if (!s || typeof Health === 'undefined' || !Health.showStation) return;
    if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
    S.show = 'all'; S.kind = 'all'; S.q = s.name || ''; S.more = false;
    Health.showStation(id, 'carrier');
  }

  // What the tests read, and the door they fill it through.
  function state_() { return { rows: S.rows, findings: S.findings, summary: summary(), err: S.err, warn: S.warn, drift: S.drift, show: S.show, kind: S.kind, q: S.q,
    cards: [...cards.entries()].map(([id, c]) => ({ id, status: c.status, rows: c.rows ? c.rows.length : null })) }; }
  function adopt(rows, findings) { S.asked = true; S.loading = false; S.err = ''; adoptRows(rows, findings); redraw(); paintOpen(); }

  return { render, load, adopt, set, state: state_,
    // one station's: its card on the map and the station editor
    cardHtml, cardAsk, editorHtml, retry, open, txOnRecord };
})();
