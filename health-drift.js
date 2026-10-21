// MegaNet — health-drift.js
//
//   HealthDrift   the Station Health tab's Transmitter frequency panel: each
//                 ALERT2 transmitter's carrier offset against the others the
//                 same receivers hear, day by day, and the server's drift and
//                 off-channel findings about them (#217, 0075).
//
// After health.js (which draws this panel's section and calls render()) and
// datastore.js (dbRpc, dbSelect); before init.js. Nothing here runs at load:
// the first render() asks the database once — meganet.transmitter_offsets(),
// public, and the open findings of source `transmitters` — and redraws only
// its own section when they arrive.
//
// What the numbers are. RPi ALERT's decoder measures every ALERT2 burst's
// carrier offset. A copy that came over a repeater is on the repeater's
// carrier, so a transmitter here is the last address on a copy's path, or its
// source when there is none — repeaters are measured too. Each receiver's own
// crystal error, which moves every transmitter it hears together, is worked
// out day by day and taken out, and each transmitter is then measured against
// the median of the fleet that receiver hears. So 0 ppm is "like the rest",
// not "exactly on frequency"; a transmitter far from the rest, or one moving,
// is the one to check.

const HealthDrift = (() => {

  const DAYS = 37;
  const WEEK = 7;
  const S = {
    asked: false,
    loading: false,
    err: '',
    rows: null,        // transmitter_offsets() rows
    findings: [],      // open findings, source transmitters
    warn: 2.5,         // the off-channel warning line, ppm (app_meta tx_offset_warn_ppm)
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const sgn = (v, d) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
  const todayUtc = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const dayMs = d => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
  const DAY = 86400000;

  async function load() {
    if (S.loading) return;
    S.asked = true; S.loading = true; S.err = '';
    try {
      const [rows, findings, knobs] = await Promise.all([
        dbRpc('transmitter_offsets', { p_days: DAYS }),
        dbSelect('health_finding?select=kind,subject,severity,title,detail,evidence,first_seen&source=eq.transmitters&cleared_at=is.null&limit=500'),
        dbSelect('app_meta?select=key,value&key=eq.tx_offset_warn_ppm').catch(() => []),
      ]);
      S.rows = Array.isArray(rows) ? rows : [];
      S.findings = Array.isArray(findings) ? findings : [];
      const w = knobs && knobs[0] ? Number(knobs[0].value) : NaN;
      if (Number.isFinite(w) && w > 0) S.warn = w;
    } catch (err) {
      // A database before 0075 has no transmitter_offsets: say so quietly.
      S.err = (err && (err.code === 'PGRST202' || err.code === '42883' || err.status === 404))
        || /Could not find the function|does not exist/.test(String((err && err.message) || err))
        ? 'not on this database yet'
        : `Could not read the transmitter offsets — ${(err && err.message) || err}.`;
    }
    S.loading = false;
    redraw();
  }

  // One row per transmitter: its days, the last week's offset, the change from
  // the weeks before, and the worst open finding about it.
  function summary() {
    if (!S.rows) return [];
    const t0 = todayUtc();
    const by = new Map();
    S.rows.forEach(r => {
      const a = Number(r.addr);
      if (!by.has(a)) by.set(a, []);
      by.get(a).push({ t: dayMs(r.day), ppm: Number(r.offset_ppm), hz: Number(r.offset_hz), n: Number(r.bursts), rx: Number(r.receivers), f: Number(r.freq_mhz) });
    });
    const wmean = (pts, k) => {
      const n = pts.reduce((s, p) => s + p.n, 0);
      return n ? pts.reduce((s, p) => s + p[k] * p.n, 0) / n : null;
    };
    const fBy = new Map();
    S.findings.forEach(f => {
      const a = Number(String(f.subject || '').replace(/^a2:/, ''));
      const was = fBy.get(a);
      if (!was || (f.severity === 'critical' && was.severity !== 'critical')) fBy.set(a, f);
    });
    const stations = (typeof state !== 'undefined' && state.data && state.data.stations) || [];
    return [...by.entries()].map(([addr, pts]) => {
      pts.sort((x, y) => x.t - y.t);
      const recent = pts.filter(p => p.t > t0 - WEEK * DAY);
      const before = pts.filter(p => p.t <= t0 - WEEK * DAY);
      const w = wmean(recent, 'ppm'), b = wmean(before, 'ppm');
      const st = stations.find(s => s.alert2_station_id === addr);
      return {
        addr, pts, name: st ? st.name : '', stationId: st ? st.id : null,
        days: pts.length, bursts: pts.reduce((s, p) => s + p.n, 0),
        ppm: w, hz: wmean(recent, 'hz'), change: w != null && b != null && before.length >= 5 && recent.length >= 3 ? w - b : null,
        freq: pts.reduce((m, p) => Math.max(m, p.f || 0), 0) || null,
        finding: fBy.get(addr) || null,
      };
    }).sort((x, y) => (Math.abs(y.ppm ?? 0) - Math.abs(x.ppm ?? 0)) || x.addr - y.addr);
  }

  function sparkSvg(pts) {
    const W = 120, H = 28, t0 = todayUtc() - (DAYS - 1) * DAY, t1 = todayUtc();
    const lim = Math.max(S.warn * 1.2, ...pts.map(p => Math.abs(p.ppm || 0)));
    const x = t => ((t - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2;
    const y = v => H / 2 - (v / lim) * (H / 2 - 2);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.ppm).toFixed(1)}`).join('');
    const dots = pts.length < 3 ? pts.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.ppm).toFixed(1)}" r="1.6" fill="currentColor"/>`).join('') : '';
    return `<svg class="hl-drift-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`
      + `<rect x="0" y="${y(S.warn).toFixed(1)}" width="${W}" height="${(y(-S.warn) - y(S.warn)).toFixed(1)}" fill="currentColor" opacity="0.07"/>`
      + `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="2 2"/>`
      + `<path d="${line}" fill="none" stroke="currentColor" stroke-width="1.5"/>${dots}</svg>`;
  }

  function statusHtml(r) {
    if (r.finding) {
      const cls = r.finding.severity === 'critical' ? 'txt-bad' : 'txt-warn';
      const word = r.finding.kind === 'transmitter-drift' ? 'Drifting' : 'Off the rest';
      return `<span class="${cls}" title="${esc(r.finding.title)}"><span aria-hidden="true">⚠</span> ${esc(word)}</span>`;
    }
    if (r.ppm != null && Math.abs(r.ppm) >= S.warn * 0.8) return '<span class="txt-muted">Near the line</span>';
    return '<span class="txt-muted">Like the rest</span>';
  }

  function tableHtml(rows) {
    const body = rows.map(r => `
      <tr>
        <td><b>${esc(String(r.addr))}</b>${r.name ? ` <span class="small">${esc(r.name)}</span>` : ''}</td>
        <td class="num">${sgn(r.ppm, 2)} <span class="small">ppm</span><br><span class="small">${sgn(r.hz, 0)} Hz</span></td>
        <td class="num">${r.change == null ? '<span class="small txt-muted">too soon</span>' : `${sgn(r.change, 2)} <span class="small">ppm</span>`}</td>
        <td>${sparkSvg(r.pts)}</td>
        <td class="num">${num(r.days)}</td>
        <td class="num">${num(r.bursts)}</td>
        <td>${statusHtml(r)}</td>
      </tr>`).join('');
    return `<div class="table-wrap"><table class="hl-table hl-drift-table">
      <caption class="sr-only">Each ALERT2 transmitter's carrier offset against the others the same receivers hear, the last week, its change from the weeks before, and the server's finding</caption>
      <thead><tr><th scope="col">ALERT2 address</th><th scope="col" class="num">Last 7 days</th><th scope="col" class="num">Change from the 30 before</th>
        <th scope="col">${DAYS} days</th><th scope="col" class="num">Days</th><th scope="col" class="num">Bursts</th><th scope="col">Now</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function render() {
    if (!S.asked && typeof dbRpc === 'function') setTimeout(load, 0);
    const head = `
      <div class="panel-header"><h3 id="hl-h-drift">Transmitter frequency</h3>
        <span class="small">each ALERT2 transmitter's carrier against the others, and whether it is moving</span></div>`;
    if (S.err === 'not on this database yet') return head + '<p class="small txt-muted">The database this is connected to does not keep carrier offsets yet.</p>';
    if (S.err) return head + `<p class="small txt-bad">${esc(S.err)}</p>`;
    if (!S.rows) return head + '<p class="small">Asking the server for the carrier offsets…</p>';
    const rows = summary();
    if (!rows.length) return head + '<p class="small">No ALERT2 transmitter has been heard often enough by a base station to measure yet.</p>';
    const off = rows.filter(r => r.finding);
    const lead = off.length
      ? `<p><b>${num(off.length)} transmitter${off.length === 1 ? '' : 's'} to check:</b> ${off.slice(0, 4).map(r => esc(r.finding.title)).join('; ')}${off.length > 4 ? '; …' : ''}.</p>`
      : `<p>All ${num(rows.length)} transmitters measured are within ${esc(String(S.warn))} ppm of the rest, and none has moved by 1 ppm in a week.</p>`;
    return head + lead + `
      <p class="small hl-drift-sub">ALERT2 only: legacy ALERT bursts arrive with no carrier measurement, so most of the network is not here.
        Base stations measure every ALERT2 burst's carrier offset. A relayed copy is on the last repeater's carrier,
        so repeaters are here too. Each receiver's own crystal error is worked out day by day and taken out, and each transmitter is shown
        against the median of the fleet that receiver hears — so 0 ppm is <em>like the rest</em>, not exactly on frequency, and the shaded band
        is ±${esc(String(S.warn))} ppm. The server checks hourly: further than that from the rest is a warning, and a move of 1 ppm in a week
        (once there are five weeks of history) is drift — usually an ageing crystal, or a site running hot or cold, and a visit before it goes quiet.</p>
      ${tableHtml(rows)}`;
  }

  function redraw() {
    const el = document.getElementById('hl-drift');
    if (el) el.innerHTML = render();
  }

  // What the tests read, and the door they fill it through.
  function state_() { return { rows: S.rows, findings: S.findings, summary: summary(), err: S.err, warn: S.warn }; }
  function adopt(rows, findings) { S.asked = true; S.loading = false; S.err = ''; S.rows = rows || []; S.findings = findings || []; redraw(); }

  return { render, load, adopt, state: state_ };
})();
