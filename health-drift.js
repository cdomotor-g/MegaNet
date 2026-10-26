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
//
// And its signal (0083): the SNR of the same bursts — only those its own
// carrier says it sent, so a station heard through its repeater never takes
// on the repeater's strength — followed against its own past at each base
// station that hears it, each receiver's own steps (everything it hears
// moving at once) taken out. A fall of tx_snr_drop_warn_db in a week, or over
// three months, is the server's `transmitter-snr-falling`: an antenna, cable
// or connector going, or the transmitter's power. The panel's Signal view, a
// line on the station's card and in its editor, and a word under Needs
// attention (attnHtml()). A database before 0083 has no signal columns: the
// rows are asked for again without them, and the signal says it is not kept.

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
    snrWarn: 3,        // the signal's line, dB fallen (tx_snr_drop_warn_db)
    view: 'carrier',   // 'carrier' (frequency) | 'signal' (SNR)
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
  const SNR_COLS = 'snr_db,snr_sd,snr_change_db,snr_season_db,snr_receivers,snr_judged,snr_falling,snr_days,snr_rel';
  const F_COLS = 'kind,subject,station_id,severity,title,detail,first_seen';
  const CARRIER_KINDS = new Set(['transmitter-off-channel', 'transmitter-drift']);
  const SIGNAL_KIND = 'transmitter-snr-falling';
  // A database before 0077 has no transmitter_summary.
  const missing = err => !!(err && (err.code === 'PGRST205' || err.code === '42P01' || err.status === 404))
    || /Could not find the table|does not exist/.test(String((err && err.message) || err));
  // One before 0083 has the table without its signal columns: PostgREST says
  // so with a 400 naming the column.
  const noColumn = err => !!(err && err.status === 400) && /column .* does not exist/.test(String(err.message || err));
  let snrCols = true;
  async function askRows(filter, limit) {
    if (snrCols) {
      try {
        return await dbSelect(`transmitter_summary?select=${COLS},${SNR_COLS}${filter}&limit=${limit}`);
      } catch (err) {
        if (!noColumn(err)) throw err;
        snrCols = false;
      }
    }
    return dbSelect(`transmitter_summary?select=${COLS}${filter}&limit=${limit}`);
  }

  // The three lines, asked once whoever needs them first — the panel or a card.
  let knobsAsked = null;
  function askKnobs() {
    if (!knobsAsked) {
      // Kept once answered; a failure keeps the defaults and is asked again
      // by whoever needs them next.
      knobsAsked = dbSelect('app_meta?select=key,value&key=in.(tx_offset_warn_ppm,tx_drift_warn_ppm,tx_snr_drop_warn_db)').then(list => {
        (list || []).forEach(k => {
          const v = Number(k.value);
          if (!Number.isFinite(v) || v <= 0) return;
          if (k.key === 'tx_offset_warn_ppm') S.warn = v;
          if (k.key === 'tx_drift_warn_ppm') S.drift = v;
          if (k.key === 'tx_snr_drop_warn_db') S.snrWarn = v;
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
        askRows('', 5000),
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

  // The worst open finding of the kinds asked for, by subject.
  function worstBy(kinds) {
    const m = new Map();
    S.findings.forEach(f => {
      if (!kinds(f.kind)) return;
      const was = m.get(f.subject);
      if (!was || (f.severity === 'critical' && was.severity !== 'critical')) m.set(f.subject, f);
    });
    return m;
  }

  function summary() {
    if (!S.rows) return [];
    const fBy = worstBy(k => CARRIER_KINDS.has(k)), sBy = worstBy(k => k === SIGNAL_KIND);
    return S.rows.map(r => {
      const w = who(r);
      const days = (r.days || []).map(dayMs), ppm = (r.ppm || []).map(Number);
      const sDays = (r.snr_days || []).map(dayMs), rel = (r.snr_rel || []).map(Number);
      return {
        tx: r.tx, protocol: r.protocol, via: r.via, who: w,
        ppm: r.w_ppm == null ? null : Number(r.w_ppm), hz: r.w_hz == null ? null : Number(r.w_hz),
        change: r.change_ppm == null ? null : Number(r.change_ppm),
        days: Number(r.w_days) || 0, bursts: Number(r.bursts) || 0, receivers: Number(r.receivers) || 0,
        freq: r.freq_mhz == null ? null : Number(r.freq_mhz),
        pts: days.map((t, i) => ({ t, ppm: ppm[i] })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.ppm)),
        finding: fBy.get(r.tx) || null,
        // Its signal (0083): absent altogether on a database before it.
        snr: fin(r.snr_db), snrSd: fin(r.snr_sd), snrChange: fin(r.snr_change_db), snrSeason: fin(r.snr_season_db),
        snrRx: Number(r.snr_receivers) || 0, snrJudged: Number(r.snr_judged) || 0, snrFalling: Number(r.snr_falling) || 0,
        snrPts: sDays.map((t, i) => ({ t, v: rel[i] })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)),
        sFinding: sBy.get(r.tx) || null,
        judgedAt: r.judged_at || null,
      };
    }).sort((x, y) => (!!y.finding - !!x.finding) || (Math.abs(y.ppm ?? 0) - Math.abs(x.ppm ?? 0)) || (x.tx < y.tx ? -1 : 1));
  }
  // The signal's order: its finding first, then the furthest fallen.
  const fallen = r => Math.min(r.snrChange ?? 0, r.snrSeason ?? 0);
  const bySignal = rows => rows.slice().sort((x, y) => (!!y.sFinding - !!x.sFinding)
    || ((y.sFinding && y.sFinding.severity === 'critical') - (x.sFinding && x.sFinding.severity === 'critical')) || (fallen(x) - fallen(y))
    || (x.tx < y.tx ? -1 : 1));
  const hasSignal = r => r.snr != null || r.snrPts.length > 0;

  const near = r => r.finding || (r.ppm != null && Math.abs(r.ppm) >= S.warn * 0.8) || (r.change != null && Math.abs(r.change) >= 0.5);
  // A signal near its line: its finding, or two thirds of the way there.
  const nearS = r => r.sFinding || fallen(r) <= -S.snrWarn * 0.6;
  const ofKind = (r, k) => (k === 'all' ? true : k === 'repeater' ? r.who.rep : r.protocol === k && !(k === 'alert' && r.who.rep));
  function filtered(rows) {
    const q = S.q.trim().toLowerCase();
    const sig = S.view === 'signal';
    return rows.filter(r => (sig ? hasSignal(r) && (S.show === 'all' || nearS(r)) : S.show === 'all' || near(r)) && ofKind(r, S.kind)
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

  // The signal's line: 90 days of it against its usual (the thirty days
  // before last week), in dB, the band ±the line, the fall below the middle.
  function snrSparkSvg(pts) {
    const W = 120, H = 28, DAYS = 90, t1 = todayUtc(), t0 = t1 - (DAYS - 1) * DAY;
    const shown = pts.filter(p => p.t >= t0);
    const lim = Math.max(S.snrWarn * 2, ...shown.map(p => Math.abs(p.v || 0)));
    const x = t => ((t - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2;
    const y = v => H / 2 - (v / lim) * (H / 2 - 2);
    const line = shown.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const dots = shown.length < 3 ? shown.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="1.6" fill="currentColor"/>`).join('') : '';
    return `<svg class="hl-drift-spark hl-snr-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`
      + `<rect x="0" y="${y(S.snrWarn).toFixed(1)}" width="${W}" height="${(y(-S.snrWarn) - y(S.snrWarn)).toFixed(1)}" fill="currentColor" opacity="0.07"/>`
      + `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="2 2"/>`
      + (shown.length ? `<path d="${line}" fill="none" stroke="currentColor" stroke-width="1.5"/>${dots}` : '') + '</svg>';
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

  function snrStatusHtml(r) {
    if (r.sFinding) {
      const cls = r.sFinding.severity === 'critical' ? 'txt-bad' : 'txt-warn';
      return `<span class="${cls}" title="${escAttr(r.sFinding.title)}"><span aria-hidden="true">⚠</span> Fading</span>`;
    }
    if (r.snrChange == null && r.snrSeason == null) return '<span class="txt-muted">Too soon</span>';
    if (fallen(r) <= -S.snrWarn * 0.6) return '<span class="txt-muted">Weakening</span>';
    return '<span class="txt-muted">Steady</span>';
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

  const dbText = v => (v == null ? '<span class="small txt-muted">too soon</span>' : `${sgn(v, 1)} <span class="small">dB</span>`);
  function snrTableHtml(rows) {
    const body = rows.map(r => `
      <tr>
        <th scope="row">${nameHtml(r)}</th>
        <td class="num">${r.snr == null ? '—' : `${r.snr.toFixed(1)} <span class="small">dB</span>`}${r.snrSd == null ? ''
          : `<br><span class="small">±${r.snrSd.toFixed(1)} dB a burst</span>`}</td>
        <td class="num">${dbText(r.snrChange)}</td>
        <td class="num">${dbText(r.snrSeason)}</td>
        <td>${snrSparkSvg(r.snrPts)}</td>
        <td class="num">${num(r.snrRx)}${r.snrJudged > 1 ? `<br><span class="small">${num(r.snrFalling)} of ${num(r.snrJudged)} saw a fall</span>` : ''}</td>
        <td>${snrStatusHtml(r)}</td>
      </tr>`).join('');
    return `<div class="table-wrap"><table class="hl-table hl-drift-table hl-snr-table">
      <caption class="sr-only">Each transmitter's signal over the receivers' noise, only from bursts its own carrier says it sent: the last week, its change from the thirty days before and over three months with each receiver's own shifts taken out, its last 90 days, the base stations that hear it directly, and the server's finding</caption>
      <thead><tr><th scope="col">Transmitter</th><th scope="col" class="num">SNR, last 7 days</th><th scope="col" class="num">Change from the 30 before</th>
        <th scope="col" class="num">Three months</th><th scope="col">90 days</th><th scope="col" class="num">Base stations</th><th scope="col">Now</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function controlsHtml(all) {
    const n = k => all.filter(r => ofKind(r, k) && (S.view !== 'signal' || hasSignal(r))).length;
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(label)}</option>`;
    return `<div class="hl-drift-controls">
      <label>Look at <select onchange="HealthDrift.set('view', this.value)">
        ${opt('carrier', 'Carrier frequency', S.view)}${opt('signal', 'Signal (SNR)', S.view)}</select></label>
      <label>Show <select onchange="HealthDrift.set('show', this.value)">
        ${opt('look', 'Needs a look', S.show)}${opt('all', 'Every transmitter', S.show)}</select></label>
      <label>Kind <select onchange="HealthDrift.set('kind', this.value)">
        ${opt('all', `All (${n('all')})`, S.kind)}${opt('alert', `Legacy ALERT stations (${n('alert')})`, S.kind)}
        ${opt('repeater', `Repeaters (${n('repeater')})`, S.kind)}${opt('alert2', `ALERT2 (${n('alert2')})`, S.kind)}</select></label>
      <label>Find <input type="search" value="${escAttr(S.q)}" placeholder="Name, number or address" aria-label="Find a transmitter"
        oninput="HealthDrift.set('q', this.value)"></label>
    </div>`;
  }

  function render() {
    if (!S.asked && typeof dbSelect === 'function') setTimeout(load, 0);
    const head = `
      <div class="panel-header"><h3 id="hl-h-drift">Transmitter frequency and signal</h3>
        <span class="small">each transmitter's carrier against the others, its signal against its own past, and whether either is moving</span></div>`;
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
      ? `<p><b>${num(flagged.length)} of ${num(all.length)} transmitter${all.length === 1 ? '' : 's'} to check</b> — ${flagged.slice(0, 3).map(r => esc(r.finding.title)).join('; ')}${flagged.length > 3 ? '; …' : ''}.${signalLeadHtml(all)}</p>`
      : `<p>All ${num(all.length)} transmitters measured are within ${esc(String(S.warn))} ppm of the rest, and none has moved by ${esc(String(S.drift))} ppm in a week.${signalLeadHtml(all)}</p>`;
    const sig = S.view === 'signal';
    const rows = sig ? bySignal(filtered(all)) : filtered(all);
    const shown = S.more ? rows : rows.slice(0, PAGE);
    const empty = !snrCols && sig ? '<p class="small txt-muted">The database this is connected to does not keep the signal yet (db/migrations/0083_station_snr.sql).</p>'
      : !rows.length
      ? `<p class="small">${S.show === 'look' ? 'Nothing here needs a look. <button class="link-btn" onclick="HealthDrift.set(\'show\', \'all\')">Show every transmitter</button>' : 'No transmitter matches.'}</p>` : '';
    const more = rows.length > shown.length
      ? `<p><button class="btn" onclick="HealthDrift.set('more', true)">Show all ${num(rows.length)}</button></p>` : '';
    const about = sig ? `
      <p class="small hl-drift-sub">The signal over the receiver's noise (SNR) of every burst a base station decodes — counted only where the
        burst's carrier says who sent it: a burst a repeater relayed is the repeater's strength, so a station heard only through its repeater has
        no signal here (its repeater does), and a station heard both ways is measured on its own bursts alone. Each base station's view of a
        transmitter is followed against its own past, never against another's; everything a receiver hears moving at once — its antenna, cable,
        gain or the noise at its site — is worked out day by day and taken out. A fall of ${esc(String(S.snrWarn))} dB in the last week against
        the thirty days before, or over the last thirty days against two months earlier, is a finding: usually the antenna, its cable or connectors
        (water, corrosion, knocked or loosened), or the transmitter's power. The line is its last 90 days against that usual; the band is
        ±${esc(String(S.snrWarn))} dB. A base station new this month has no say until it has a past; one that alone saw a fall may be its own
        path. Bursts below about 8 dB do not decode, so a station near there has little left to lose and fades into missed checks instead.</p>`
      : `
      <p class="small hl-drift-sub">${num(legacy)} legacy ALERT and ${num(all.length - legacy)} ALERT2 transmitters, judged by the server
        ${at ? `at ${esc(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : 'hourly'}.
        Base stations measure every burst's carrier offset. A burst relayed by a repeater is on the repeater's carrier, so the server puts each
        down to whoever sent it — the station, or its repeater (found from the register's pass ranges and the carrier its relays share) — and repeaters
        are measured too. Each receiver's own crystal error is worked out day by day and taken out, and each transmitter is shown against the median
        of the fleet that receiver hears — so 0 ppm is <em>like the rest</em>, not exactly on frequency, and the shaded band is ±${esc(String(S.warn))} ppm.
        Further than that from the rest over a week is a warning; a move of ${esc(String(S.drift))} ppm against the thirty days before is drift — usually an ageing crystal, or a
        site running hot or cold, and worth a visit before it goes quiet.</p>`;
    return head + lead + about + `
      ${controlsHtml(all)}
      ${empty || (sig ? snrTableHtml(shown) : tableHtml(shown))}${more}`;
  }

  // The signal's sentence, after the carrier's: how many are fading, the
  // worst named, and the way to them — or that none is.
  function signalLeadHtml(all) {
    if (!snrCols) return '';
    const fading = bySignal(all.filter(r => r.sFinding));
    const measured = all.filter(hasSignal).length;
    if (!measured) return '';
    const to = S.view === 'signal' ? '' : ` <button class="link-btn" onclick="HealthDrift.set('view', 'signal')">Signal</button>`;
    if (!fading.length) return ` <span class="hl-snr-lead">None of the ${num(measured)} heard directly is fading.${to}</span>`;
    return ` <span class="hl-snr-lead"><b class="${fading.some(r => r.sFinding.severity === 'critical') ? 'txt-bad' : 'txt-warn'}">${num(fading.length)} fading</b>
      — ${fading.slice(0, 3).map(r => esc(r.sFinding.title)).join('; ')}${fading.length > 3 ? '; …' : ''}.${to}</span>`;
  }

  // Under Needs attention (health.js places it): what the server's radio
  // checks found, which the readings the tab works out cannot — a
  // transmitter fading, off channel or drifting — with the way to them.
  function attnHtml() {
    if (!S.rows) return '';
    const all = summary();
    const fading = bySignal(all.filter(r => r.sFinding)), carrier = all.filter(r => r.finding);
    if (!fading.length && !carrier.length) return '';
    const name = r => esc(r.who.name);
    const bits = [];
    if (fading.length) {
      bits.push(`<b>${num(fading.length)} transmitter${fading.length === 1 ? '' : 's'} fading</b> — ${fading.slice(0, 4).map(r => `${name(r)}
        (<span class="${r.sFinding.severity === 'critical' ? 'txt-bad' : 'txt-warn'}">${esc(String(r.sFinding.title).replace(/^.*?: /, ''))}</span>)`).join(', ')}${fading.length > 4 ? ', …' : ''}`);
    }
    if (carrier.length) bits.push(`${num(carrier.length)} off channel or drifting`);
    return `<p class="small hl-attn-radio"><span aria-hidden="true">📡</span> From the base stations' radio checks: ${bits.join('; ')}.
      <button type="button" class="link-btn" onclick="HealthDrift.toPanel('${fading.length ? 'signal' : 'carrier'}')">See them</button></p>`;
  }

  // Down to the panel, at the view asked for, its heading focused.
  function toPanel(view) {
    if (view === 'signal' || view === 'carrier') S.view = view;
    S.show = 'look'; S.q = ''; S.kind = 'all'; S.more = false;
    redraw();
    const h = document.getElementById('hl-h-drift');
    if (!h) return;
    h.setAttribute('tabindex', '-1');
    if (h.scrollIntoView) h.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  }

  function redraw() {
    const note = document.getElementById('hl-attn-radio');
    if (note) note.innerHTML = attnHtml();
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
    if (!['view', 'show', 'kind', 'q', 'more'].includes(k)) return;
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
        askRows(`&${tx}`, 50),
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

  // Its signal (0083), as heard: the last week's SNR at the base stations
  // that hear it on its own carrier, and how steady it is burst to burst.
  function signalHtml(r, fade) {
    const snr = fin(r.snr_db), sd = fin(r.snr_sd), rx = Number(r.snr_receivers) || 0;
    if (snr == null) {
      return '<span class="txt-muted">not measured in the last week</span>' + note(r.via === 'repeater'
        ? 'no burst on its carrier carried an SNR often enough — three a day at a base station that hears three or more transmitters'
        : 'only bursts on its own carrier count — a station heard only through its repeater is the repeater\'s signal, not its own');
    }
    const verdict = fade ? ` — <span class="${sevCls(fade)}" title="${escAttr(fade.title)}"><span aria-hidden="true">⚠</span> fading</span>` : '';
    return `${snr.toFixed(1)} dB over the noise${sd == null ? '' : ` · ±${sd.toFixed(1)} dB burst to burst`}${verdict}`
      + note(`at ${plural(rx, 'base station')} that hear${rx === 1 ? 's' : ''} it on its own carrier, the last 7 days${rx > 1 ? ' — a level to read, not to compare: each path is its own' : ''}`);
  }

  // How it has moved, against its own past at each base station, each
  // receiver's own steps taken out.
  function signalChangeHtml(r, fade) {
    const wk = fin(r.snr_change_db), season = fin(r.snr_season_db);
    const judged = Number(r.snr_judged) || 0, falling = Number(r.snr_falling) || 0;
    if (wk == null && season == null) {
      return '<span class="txt-muted">too soon to judge</span>' + note(
        'it needs 3 days in the last week and 5 in the 30 before at one base station (10 and 10 for three months)');
    }
    const word = v => (v == null ? '' : v <= -S.snrWarn ? `<span class="${fade ? sevCls(fade) : 'txt-warn'}">fading</span>`
      : v <= -S.snrWarn * 0.6 ? 'weakening' : v >= S.snrWarn ? 'stronger' : '<span class="txt-muted">steady</span>');
    const parts = [];
    if (wk != null) parts.push(`${sgn(wk, 1)} dB against the 30 days before — ${word(wk)}`);
    if (season != null) parts.push(`${sgn(season, 1)} dB over three months — ${word(season)}`);
    const agree = judged > 1 ? note(`${num(falling)} of the ${num(judged)} base stations that judge it saw a fall of ${esc(String(S.snrWarn))} dB${
      falling && falling < judged ? ' — one path alone may be the path, not the station' : ''}`) : '';
    return parts.join('; ') + agree;
  }

  function txBlockHtml(s, r, findings) {
    const fs = findings.filter(f => f.subject === r.tx);
    const off = fs.find(f => f.kind === 'transmitter-off-channel');
    const drift = fs.find(f => f.kind === 'transmitter-drift');
    const fade = fs.find(f => f.kind === SIGNAL_KIND);
    const other = fs.filter(f => f !== off && f !== drift && f !== fade);
    const pts = (r.days || []).map((d, i) => ({ t: dayMs(d), ppm: Number((r.ppm || [])[i]) }))
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.ppm));
    // A database before 0083 has no signal columns at all.
    const kept = 'snr_receivers' in r;
    const sPts = (r.snr_days || []).map((d, i) => ({ t: dayMs(d), v: Number((r.snr_rel || [])[i]) }))
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
    return `<div class="hd-card-tx" data-tx="${escAttr(r.tx)}">
      ${line('Offset', offsetHtml(r, off))}
      ${channelHtml(s, r)}
      ${line('Drift', driftHtml(r, drift))}
      ${kept ? line('Signal', signalHtml(r, fade)) + (fin(r.snr_db) == null && !sPts.length ? '' : line('Signal change', signalChangeHtml(r, fade)))
        : line('Signal', '<span class="txt-muted">not kept on this database yet</span>')}
      ${other.map(f => line('Also', `<span class="${sevCls(f)}"><span aria-hidden="true">⚠</span> ${esc(f.title)}</span>`)).join('')}
      ${pts.length ? `<div class="hd-card-spark">${sparkSvg(pts)}${note(`its last 37 days against the rest; the band is ±${esc(String(S.warn))} ppm`)}</div>` : ''}
      ${sPts.length ? `<div class="hd-card-spark hd-card-snr">${snrSparkSvg(sPts)}${note(`its signal's last 90 days against its usual, the receivers' own steps taken out; the band is ±${esc(String(S.snrWarn))} dB`)}</div>` : ''}
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
    // To the panel at the signal when that is what is wrong, else the carrier.
    const fadingHere = (a.findings || []).some(f => f.kind === SIGNAL_KIND);
    const door = `<button type="button" class="link-btn" onclick="HealthDrift.open('${escAttr(s.id)}'${fadingHere ? ", 'signal'" : ''})"
        title="${escAttr(`Open the Station Health tab's Transmitter frequency and signal panel on ${s.name || s.id}`)}">Transmitter frequency and signal in Station Health</button>`;
    if (!rows.length) {
      return `<span class="mn-pop-line mn-pop-indent">not measured yet</span>${note(`No base station's SDR has heard its own carrier
        often enough — three bursts in a day, on RPi ALERT 0.14 or later. A station heard only through its repeater is measured as the
        repeater — its carrier and its signal both — and a station whose carrier sits within 30 Hz of its repeater's is put down to the repeater.`)}`;
    }
    const at = rows[0].judged_at ? new Date(rows[0].judged_at) : null;
    return rows.map(r => txBlockHtml(s, r, a.findings || [])).join('')
      + note(`Its carrier against the other transmitters the same base stations hear, each receiver's own error taken out — so 0 is
        like the rest, not exactly on frequency; its signal against its own past at each base station, each receiver's own steps taken out.
        Judged hourly${at && Number.isFinite(at.getTime())
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
        <b>Signal</b> is how far above the receiver's noise its own bursts arrive — only those on its own carrier, never its repeater's
        relays of it; <b>Signal change</b> is how far that has moved against the thirty days before and over three months, at each base
        station against its own past, with every receiver's own steps taken out (a fall of ${esc(String(S.snrWarn))} dB is a finding —
        usually the antenna, its cable or connectors, or the transmitter's power).
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
  function open(id, view) {
    const s = stationOf(id);
    if (!s || typeof Health === 'undefined' || !Health.showStation) return;
    if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
    S.show = 'all'; S.kind = 'all'; S.q = s.name || ''; S.more = false;
    S.view = view === 'signal' ? 'signal' : 'carrier';
    Health.showStation(id, 'carrier');
  }

  // What the tests read, and the door they fill it through.
  function state_() { return { rows: S.rows, findings: S.findings, summary: summary(), err: S.err, warn: S.warn, drift: S.drift, snrWarn: S.snrWarn,
    view: S.view, show: S.show, kind: S.kind, q: S.q, signalKept: snrCols,
    cards: [...cards.entries()].map(([id, c]) => ({ id, status: c.status, rows: c.rows ? c.rows.length : null })) }; }
  function adopt(rows, findings) { S.asked = true; S.loading = false; S.err = ''; adoptRows(rows, findings); redraw(); paintOpen(); }

  return { render, load, adopt, set, state: state_, attnHtml, toPanel,
    // one station's: its card on the map and the station editor
    cardHtml, cardAsk, editorHtml, retry, open, txOnRecord };
})();
