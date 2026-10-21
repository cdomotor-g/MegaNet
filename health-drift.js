// MegaNet — health-drift.js
//
//   HealthDrift   the Station Health tab's Transmitter frequency panel: every
//                 transmitter a base station hears — legacy ALERT stations and
//                 repeaters, and ALERT2 — with its carrier offset against the
//                 rest, how far it has moved, a line of its days, and the
//                 server's drift and off-channel findings (#217; 0075, 0077).
//
// After health.js (which draws this panel's section and calls render()) and
// datastore.js (dbSelect); before init.js. Nothing here runs at load: the
// first render() asks the database once — meganet.transmitter_summary, one row
// a transmitter as the server last judged it (hourly), and the open findings
// of source `transmitters` — and redraws only its own section when they come.
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

  async function load() {
    if (S.loading) return;
    S.asked = true; S.loading = true; S.err = '';
    try {
      const [rows, findings, knobs] = await Promise.all([
        dbSelect('transmitter_summary?select=tx,protocol,station_id,via,freq_mhz,w_days,w_ppm,w_hz,b_days,b_ppm,change_ppm,bursts,receivers,days,ppm,judged_at&limit=5000'),
        quietly(dbSelect('health_finding?select=kind,subject,station_id,severity,title,detail,first_seen&source=eq.transmitters&cleared_at=is.null&limit=5000')),
        quietly(dbSelect('app_meta?select=key,value&key=eq.tx_offset_warn_ppm')),
      ]);
      adoptRows(rows, findings);
      const w = knobs && knobs[0] ? Number(knobs[0].value) : NaN;
      if (Number.isFinite(w) && w > 0) S.warn = w;
    } catch (err) {
      // A database before 0077 has no transmitter_summary: say so quietly.
      S.err = (err && (err.code === 'PGRST205' || err.code === '42P01' || err.status === 404))
        || /Could not find the table|does not exist/.test(String((err && err.message) || err))
        ? 'not on this database yet'
        : `Could not read the transmitter offsets — ${(err && err.message) || err}.`;
    }
    S.loading = false;
    redraw();
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
      : `<p>All ${num(all.length)} transmitters measured are within ${esc(String(S.warn))} ppm of the rest, and none has moved by 1 ppm in a week.</p>`;
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
        Further than that from the rest over a week is a warning; a move of 1 ppm against the thirty days before is drift — usually an ageing crystal, or a
        site running hot or cold, and worth a visit before it goes quiet.</p>
      ${controlsHtml(all)}
      ${empty || tableHtml(shown)}${more}`;
  }

  function redraw() {
    const el = document.getElementById('hl-drift');
    if (!el) return;
    const had = document.activeElement && el.contains(document.activeElement) && document.activeElement.type === 'search';
    el.innerHTML = render();
    if (had) {
      const box = el.querySelector('input[type="search"]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
  }

  function set(k, v) {
    if (!['show', 'kind', 'q', 'more'].includes(k)) return;
    S[k] = v;
    if (k !== 'more') S.more = false;
    redraw();
  }

  // What the tests read, and the door they fill it through.
  function state_() { return { rows: S.rows, findings: S.findings, summary: summary(), err: S.err, warn: S.warn, show: S.show, kind: S.kind }; }
  function adopt(rows, findings) { S.asked = true; S.loading = false; S.err = ''; adoptRows(rows, findings); redraw(); }

  return { render, load, adopt, set, state: state_ };
})();
