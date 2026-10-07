// MegaNet — health-airtime.js
//
//   HealthAirtime   the Station Health tab's Airtime panel: transmissions
//                   landing on top of each other at each receiver, whether
//                   they come off worse for it, when each station's check
//                   signal goes out and how its logger keeps that time — and
//                   what to change: a check time, a repeater's delay.
//
// After health.js (Health.state, Health.select), airtime-analysis.js
// (AirtimeAnalysis, which does all the reasoning) and map-backbone.js
// (suggestedRepeaterDelayMs, read at call time); before init.js. health.js
// draws this panel's section and calls render(); this file works the analysis
// out once per Station Health result, the first time it is drawn, and redraws
// only its own section. Nothing here runs at load.
//
// Why it is here and not a tab of its own: everything it says rests on what
// Station Health has already worked out over the same window — each station's
// learned check schedule, its slots and their outcomes, the corrupted copies
// and the ghosts set aside — and the question it answers is the network's
// half of "why do this station's checks arrive damaged?".

const HealthAirtime = (() => {

  const MIN = 60000, HOUR = 3600000;
  const SEV = {
    warn: { label: 'Change', icon: '⚠', cls: 'txt-warn' },
    info: { label: 'Consider', icon: 'ℹ', cls: 'txt-muted' },
  };
  const KIND = {
    'move-check': 'Check time',
    'clock-drift': 'Clock',
    'stagger-repeaters': 'Repeater delays',
    'cannot-move': 'Check time',
  };
  const SHOW = 40;

  const S = {
    A: null,          // the Station Health result this was worked out from
    R: null,          // AirtimeAnalysis.fromHealth()'s result
    err: '',
    path: null,       // the receiver channel the folded hour is drawn for
    all: false,       // every check time, or the first SHOW
  };

  const p2 = n => String(n).padStart(2, '0');
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  const pct = (d, n) => (n ? `${Math.round(100 * d / n)}%` : '—');
  function fmtTs(t) {
    const d = new Date(t);
    return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }
  const mmss = ms => { const s = Math.round((ms % HOUR) / 1000); return `:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`; };
  function sevHtml(sev) {
    const s = SEV[sev] || SEV.info;
    return `<span class="hl-sev ${s.cls}"><span aria-hidden="true">${s.icon}</span> <span class="hl-sev-word">${esc(s.label)}</span></span>`;
  }

  // ── the analysis, once per Station Health result ───────────────────────────

  function result() {
    const st = typeof Health !== 'undefined' && Health.state ? Health.state() : null;
    const A = st && st.A;
    if (!A) { S.A = null; S.R = null; return null; }
    if (S.A === A) return S.R;
    S.A = A;
    S.err = '';
    try {
      S.R = AirtimeAnalysis.fromHealth(A, {
        suggestDelay: typeof suggestedRepeaterDelayMs === 'function' ? s => suggestedRepeaterDelayMs(s) : null,
      });
    } catch (err) {
      S.R = null;
      S.err = 'The airtime analysis failed: ' + ((err && err.message) || err) + '. The readings and the rest of the tab are fine — this is a bug, and the bug report button will carry it.';
      if (typeof recordError === 'function') recordError({ kind: 'airtime', message: S.err, where: '', stack: (err && err.stack) || '' });
    }
    if (S.R && !S.R.paths.some(p => p.path === S.path)) S.path = S.R.paths[0] ? S.R.paths[0].path : null;
    return S.R;
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  function render() {
    const R = result();
    const head = `
      <div class="panel-header"><h3 id="hl-h-air">Airtime — transmissions landing together</h3>
        <span class="small">who lands on top of whom at each receiver, and what to change</span></div>`;
    if (S.err) return head + `<p class="small txt-bad">${esc(S.err)}</p>`;
    if (!R) return head;
    if (!R.counts.transmissions) return head + '<p class="small">Nothing heard in the window to weigh.</p>';
    return head + `
      <p class="small hl-air-sub">ALERT is ALOHA: a station transmits when its logger says to, nobody listens first, and two stations heard at
        one receiver at once spoil each other — one lost, both lost, or a frame decoded with bits flipped. A frame is 133 ms on the air.
        The times stored are coarser: a base station's RTL-SDR stamps a reading when it finishes decoding it, half a second to three seconds
        after it was sent, so <b>together</b> here means two stations' frames stamped within ${AirtimeAnalysis.TOGETHER_MS / 1000} s of each other at
        one receiver channel, and nothing finer is claimed. Repeater delays are under a second — too fine to measure from these times;
        the delays offered are the Backbone's, put in front of the repeaters the corrupted copies point at.</p>
      ${kpisHtml(R)}
      <h4 id="hl-h-air-sug">What to change</h4>
      ${suggestionsHtml(R)}
      <h4 id="hl-h-air-hour">The hour, folded</h4>
      ${hourHtml(R)}
      <h4 id="hl-h-air-checks">Check signals: when each goes out</h4>
      ${checksHtml(R)}
      <h4 id="hl-h-air-pairs">Who lands together, again and again</h4>
      ${pairsHtml(R)}
      <div class="button-group hl-air-tools">
        <button class="ghost" onclick="HealthAirtime.exportCsv()" title="Every station's learned check time, how its logger keeps it, who it shares its moment with and the move suggested, as a spreadsheet">Export check times</button>
      </div>`;
  }

  function kpisHtml(R) {
    const D = R.damage, c = R.counts;
    const togRate = D.together.n ? D.together.d / D.together.n : 0, aloneRate = D.alone.n ? D.alone.d / D.alone.n : 0;
    const verdict = !D.enough
      ? 'too few corrupted copies in the window to compare'
      : D.ratio >= 2 ? `${D.ratio}× as often as the ones heard alone — crowding is corrupting frames`
      : D.ratio > 1.2 ? `${D.ratio}× as often as the ones heard alone`
      : 'no more often than the ones heard alone — crowding is not what is corrupting them';
    return `
      <ul class="hl-air-kpis">
        <li><b>${pct(c.together, c.transmissions)}</b> of ${num(c.transmissions)} transmissions landed within ${AirtimeAnalysis.TOGETHER_MS / 1000} s of another
          station's at a receiver${c.sameBurst ? ` — ${num(c.sameBurst)} pile-ups decoded out of one burst` : ''}.</li>
        <li>Of those, <b>${(100 * togRate).toFixed(1)}%</b> came with a corrupted copy or a ghost, against ${(100 * aloneRate).toFixed(1)}% of the rest:
          ${esc(verdict)}.</li>
        <li><b>${num(c.clashes)}</b> ${c.clashes === 1 ? 'pair' : 'pairs'} of stations' checks fall together, heard at a common receiver or repeater${c.hurting ? ` — ${num(c.hurting)} of them
          coming off worse for it: a frame lost, the check missed, or a corrupted copy` : ''}. Checks not shared come off worse ${(100 * R.baseline.rate).toFixed(1)}% of the time.</li>
        <li>${num(c.repeatersWithDelay)} of ${num(c.repeaters)} repeaters heard behind have a delay on file.</li>
      </ul>`;
  }

  function stationBtn(id, name) {
    return `<button class="link-btn" onclick="Health.select('${escAttr(id)}')">${esc(name)}</button>`;
  }
  // A repeater opens on the Stations tab, where its delay is recorded; a
  // station opens below, in this tab.
  function whereHtml(s) {
    if (s.repeaterIds) {
      return s.repeaterIds.map((id, i) => `<button class="link-btn" onclick="goToStation('${escAttr(id)}')">${esc(s.repeaterNames[i] || id)}</button>`).join(' &amp; ');
    }
    return stationBtn(s.stationId, s.station);
  }

  function suggestionsHtml(R) {
    const list = R.suggestions;
    if (!list.length) {
      return `<p class="small hl-empty">${R.counts.clashes
        ? 'The checks that fall together have nowhere better to go, or the readings cannot say how their loggers keep time.'
        : 'No two stations heard at a common receiver or repeater send their checks together, and no repeater pair stands out — nothing to change.'}</p>`;
    }
    const rows = list.map(s => `
      <tr class="hl-frow hl-frow--${s.severity === 'warn' ? 'warn' : 'info'}">
        <td>${sevHtml(s.severity)}<span class="small hl-air-kind">${esc(KIND[s.kind] || '')}</span></td>
        <th scope="row" class="hl-fwhere">${whereHtml(s)}</th>
        <td class="hl-fwhat"><b>${esc(s.title)}</b>
          <span class="small hl-fdetail">${esc(s.detail)}</span>
          ${s.how ? `<span class="small hl-faction"><span aria-hidden="true">→</span> ${esc(s.how)}</span>` : ''}</td>
      </tr>`).join('');
    return `
      <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="hl-h-air-sug">
        <table class="hl-table hl-airtable">
          <caption class="sr-only">What to change, most pressing first: a station's check time, a clock, or a pair of repeaters' delays</caption>
          <colgroup><col style="width:8.5rem"><col style="width:22%"><col></colgroup>
          <thead><tr><th scope="col">What</th><th scope="col">Where</th><th scope="col">Why, and how</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // The hour, every hour of the window laid over one: how many transmissions a
  // day land in each half-minute at one receiver channel, checks and the rest,
  // the ones that came with a corrupted copy, and a tick for each station's
  // check heard there.
  function hourHtml(R) {
    const paths = R.paths.slice(0, 8);
    const P = R.paths.find(p => p.path === S.path) || paths[0];
    if (!P) return '';
    const chips = paths.length > 1 ? `
      <div class="hl-seg hl-air-paths" role="group" aria-label="Which receiver channel">
        ${paths.map(p => `<button class="hl-chip hl-chip--sm${p === P ? ' hl-chip--on' : ''}" aria-pressed="${p === P}"
          onclick="HealthAirtime.setPath('${escAttr(p.path)}')">${esc(p.label)}</button>`).join('')}
      </div>` : '';
    const f = P.fold, days = R.days;
    const W = 720, Hb = 120, top = 8, bw = W / f.n.length;
    let max = 0;
    f.n.forEach(v => { if (v / days > max) max = v / days; });
    max = max || 1;
    const y = v => top + Hb - Hb * v / max;
    const bars = f.n.map((n, i) => {
      if (!n) return '';
      const x = (i * bw).toFixed(1), w = Math.max(1, bw - 1).toFixed(1);
      const all = n / days, ch = f.checks[i] / days;
      const mm = mmss(i * f.bin);
      const tip = `${mm}–${mmss((i + 1) * f.bin)}: ${all.toFixed(1)} a day, ${ch.toFixed(1)} of them checks; ${f.together[i]} landed together, ${f.damaged[i]} came with a corrupted copy`;
      return `<g><title>${esc(tip)}</title>`
        + `<rect class="hl-air-bar" x="${x}" y="${y(all).toFixed(1)}" width="${w}" height="${(top + Hb - y(all)).toFixed(1)}"/>`
        + (ch ? `<rect class="hl-air-bar hl-air-bar--check" x="${x}" y="${y(ch).toFixed(1)}" width="${w}" height="${(top + Hb - y(ch)).toFixed(1)}"/>` : '')
        + (f.damaged[i] ? `<circle class="hl-air-dmg" cx="${(i * bw + bw / 2).toFixed(1)}" cy="${(y(all) - 4).toFixed(1)}" r="${Math.min(5, 1.5 + f.damaged[i] / days).toFixed(1)}"/>` : '')
        + '</g>';
    }).join('');
    const ticks = (P.marks || []).map(m => {
      const step = Math.min(m.P, HOUR);
      const name = R.nameOf(m.id);
      const out = [];
      for (let k = 0; k * step < HOUR; k++) {
        const x = (((m.at + k * step) % HOUR) / HOUR * W).toFixed(1);
        out.push(`<line class="hl-air-tick${m.clash ? ' hl-air-tick--clash' : ''}" x1="${x}" x2="${x}" y1="${top + Hb + 4}" y2="${top + Hb + 16}"/>`);
      }
      return `<g><title>${esc(`${name}'s check${m.clash ? ' — falls together with another station\'s' : ''}`)}</title>${out.join('')}</g>`;
    }).join('');
    const hot = P.hot ? `${mmss(P.hot.from)}–${mmss(P.hot.to)} past the hour: ${P.hot.stations.length} stations' checks` : null;
    const label = `${P.label}: transmissions a day in each half-minute of the hour, up to ${max.toFixed(1)}`
      + (hot ? `; busiest minute ${hot}` : '');
    return `
      ${chips}
      <p class="small">At <b>${esc(P.label)}</b>: ${num(Math.round(P.perDay))} transmissions a day, ${pct(P.together, P.n)} of them landing within
        ${AirtimeAnalysis.TOGETHER_MS / 1000} s of another station's; ${num(P.piles)} pile-ups in the window${P.damagedPiles ? `, ${num(P.damagedPiles)} with a corrupted copy in them` : ''}.
        ${P.wholeSeconds ? 'This receiver stamps whole seconds, so nothing is said about frames decoded out of one burst.' : P.sameBurst ? `${num(P.sameBurst)} of the pile-ups were decoded out of one burst — on the air back to back or over each other.` : ''}
        ${hot ? `The busiest minute for checks is ${esc(hot)}.` : ''}</p>
      <div class="hl-chart hl-air-chart">
        <svg class="hl-air-svg" viewBox="0 0 ${W} ${top + Hb + 20}" role="img" aria-label="${escAttr(label)}">
          <line class="hl-air-base" x1="0" x2="${W}" y1="${top + Hb + 0.5}" y2="${top + Hb + 0.5}"/>
          ${bars}${ticks}
        </svg>
        <div class="hl-air-axis small" aria-hidden="true">${[':00', ':10', ':20', ':30', ':40', ':50', ':00'].map(m => `<span>${m}</span>`).join('')}</div>
      </div>
      <div class="qs-legend">
        <span><i class="hl-air-key hl-air-key--check" aria-hidden="true"></i>checks</span>
        <span><i class="hl-air-key" aria-hidden="true"></i>everything else</span>
        <span><i class="hl-air-key hl-air-key--dmg" aria-hidden="true"></i>came with a corrupted copy</span>
        <span><i class="hl-air-key hl-air-key--tick" aria-hidden="true"></i>a station's check</span>
        <span><i class="hl-air-key hl-air-key--clash" aria-hidden="true"></i>…falling together with another's</span>
      </div>
      <p class="small">Every hour of the window laid over one, so a station checking every three hours and one an hour after it stack here
        without ever meeting — the clashes and the moves are worked out on each pair's own cycle, not on this picture.</p>
      ${busiestHtml(P, R)}`;
  }

  function busiestHtml(P, R) {
    const f = P.fold, days = R.days, n = f.n.length;
    const mins = [];
    for (let i = 0; i < n; i += 2) {
      const sum = k => f[k][i] + f[k][(i + 1) % n];
      mins.push({ m: i / 2, n: sum('n'), checks: sum('checks'), together: sum('together'), damaged: sum('damaged') });
    }
    const top = mins.filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 5);
    if (!top.length) return '';
    const who = m => (P.marks || []).filter(k => {
      const step = Math.min(k.P, HOUR);
      for (let j = 0; j * step < HOUR; j++) if (Math.floor(((k.at + j * step) % HOUR) / MIN) === m) return true;
      return false;
    }).map(k => R.nameOf(k.id));
    return `
      <div class="table-wrap">
        <table class="hl-table">
          <caption>The five busiest minutes past the hour at ${esc(P.label)}</caption>
          <thead><tr><th scope="col">Minute</th><th scope="col">A day</th><th scope="col">Checks</th><th scope="col" class="col-optional">Together</th>
            <th scope="col" class="col-optional">Corrupted</th><th scope="col">Checking then</th></tr></thead>
          <tbody>${top.map(x => {
            const w = who(x.m);
            return `<tr><th scope="row">:${p2(x.m)}</th><td>${(x.n / days).toFixed(1)}</td><td>${(x.checks / days).toFixed(1)}</td>
              <td class="col-optional">${pct(x.together, x.n)}</td><td class="col-optional">${num(x.damaged)}</td>
              <td class="small">${w.length ? esc(w.slice(0, 6).join(', ') + (w.length > 6 ? ` and ${w.length - 6} more` : '')) : '—'}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  }

  function checksHtml(R) {
    const list = R.checks;
    if (!list.length) return '<p class="small">No station in the window kept a schedule regular enough to learn.</p>';
    const moveOf = new Map(R.suggestions.filter(s => s.kind === 'move-check').map(s => [s.stationId, s]));
    const shown = S.all ? list : list.slice(0, SHOW);
    return `
      <p class="small">Each station's check time, learned from the window: when it is heard (a receiver's stamp, a second or so after it was
        sent), how far it strays, and how its logger seems to keep the time — which is what decides how it is moved.</p>
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="hl-h-air-checks">
        <table class="hl-table">
          <caption class="sr-only">Each station's check: when it is heard, how far it strays, how its logger keeps time, and who it falls together with</caption>
          <thead><tr><th scope="col">Station</th><th scope="col">Heard at</th><th scope="col" class="col-optional">±</th><th scope="col">Its clock</th>
            <th scope="col">Falls together with</th><th scope="col">Suggested</th></tr></thead>
          <tbody>${shown.map(c => {
            const mv = moveOf.get(c.id);
            return `<tr>
              <th scope="row">${stationBtn(c.id, c.name)}</th>
              <td>${esc(c.clock)}</td>
              <td class="col-optional">${c.spreadMs != null ? `${Math.round(c.spreadMs / 1000)} s` : '—'}</td>
              <td>${esc(c.behaviourLabel)}${c.behaviour === 'drifting' ? ` <span class="small">(${c.driftSPerDay > 0 ? '+' : ''}${c.driftSPerDay} s a day)</span>` : ''}</td>
              <td class="${c.clashWith.length ? 'txt-warn' : ''}">${c.clashWith.length ? c.clashWith.map(id => esc(R.nameOf(id))).join(', ') : '—'}</td>
              <td class="small">${mv ? esc(AirtimeAnalysis._clockOf(mv.evidence.toMs, mv.evidence.periodMs, R.now)) : ''}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      ${list.length > SHOW ? `<button class="ghost hl-more" onclick="HealthAirtime.toggleAll()" aria-expanded="${S.all}">${S.all ? `Show the first ${SHOW}` : `Show all ${num(list.length)}`}</button>` : ''}`;
  }

  // Two stations whose frames keep landing together, worked out from what
  // was heard rather than from the schedules — so a check meeting a storm's
  // event reports is here too — and the moments three or more did at once.
  function pairsHtml(R) {
    const list = R.pairs.slice(0, 15);
    if (!list.length) return '<p class="small">No two stations\' frames landed together more than once at any receiver in the window.</p>';
    const big = R.moments.slice(0, 8);
    return `
      <p class="small">Two stations whose frames landed within ${AirtimeAnalysis.TOGETHER_MS / 1000} s of each other at one receiver channel, most
        often first, with the minute past the hour it usually happened at — the same minute again and again is two checks meeting; scattered,
        it is events.</p>
      <div class="table-wrap">
        <table class="hl-table">
          <caption class="sr-only">Pairs of stations whose frames landed together most often: how often, usually when, how close, with a corrupted copy, and last</caption>
          <thead><tr><th scope="col">Stations</th><th scope="col">Times</th><th scope="col">Usually</th><th scope="col" class="col-optional">Apart</th>
            <th scope="col">Corrupted copy</th><th scope="col">Last</th></tr></thead>
          <tbody>${list.map(p => `<tr>
            <th scope="row" class="small">${esc(p.names.join(' & '))}</th>
            <td>${num(p.n)}</td>
            <td class="small">${p.usualShare >= 0.5 ? `${esc(mmss(p.usualMs))} past` : 'scattered'}</td>
            <td class="col-optional">${p.gapMs != null ? `${(p.gapMs / 1000).toFixed(1)} s` : '—'}</td>
            <td class="${p.damaged ? 'txt-warn' : ''}">${p.damaged ? num(p.damaged) : '—'}</td>
            <td class="small">${esc(fmtTs(p.last))}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ${big.length ? `
      <div class="table-wrap">
        <table class="hl-table">
          <caption>Three stations or more at once</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Receiver</th><th scope="col">Stations</th><th scope="col" class="col-optional">Closest</th><th scope="col">Corrupted copy</th></tr></thead>
          <tbody>${big.map(m => `<tr>
            <th scope="row" class="small">${esc(fmtTs(m.t))}</th>
            <td class="small mono">${esc(AirtimeAnalysis.pathLabel(m.path))}</td>
            <td class="small">${esc(m.names.slice(0, 6).join(', ') + (m.names.length > 6 ? ` and ${m.names.length - 6} more` : ''))}</td>
            <td class="col-optional">${m.sameBurst ? 'one burst' : `${(m.minGap / 1000).toFixed(1)} s`}</td>
            <td class="${m.damaged ? 'txt-warn' : ''}">${m.damaged ? 'yes' : '—'}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  function redraw() {
    const el = document.getElementById('hl-airtime');
    if (el) el.innerHTML = render();
  }
  function setPath(p) { S.path = p; redraw(); }
  function toggleAll() { S.all = !S.all; redraw(); }

  function exportCsv() {
    const R = result();
    if (!R) return;
    const moveOf = new Map(R.suggestions.filter(s => s.kind === 'move-check').map(s => [s.stationId, s]));
    const head = ['station', 'station_id', 'every_min', 'heard_at', 'spread_s', 'clock', 'drift_s_per_day', 'falls_together_with', 'suggested', 'move_s', 'why', 'how'];
    const lines = [head.join(',')];
    R.checks.forEach(c => {
      const mv = moveOf.get(c.id);
      lines.push([
        c.name, c.id, c.P / MIN, c.clock, c.spreadMs != null ? Math.round(c.spreadMs / 1000) : '', c.behaviourLabel,
        c.driftSPerDay != null ? c.driftSPerDay : '', c.clashWith.map(id => R.nameOf(id)).join('; '),
        mv ? AirtimeAnalysis._clockOf(mv.evidence.toMs, mv.evidence.periodMs, R.now) : '', mv ? Math.round(mv.evidence.shiftMs / 1000) : '',
        mv ? mv.detail : '', mv ? mv.how : '',
      ].map(csvEscape).join(','));
    });
    dlText(`floodnet-check-times-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
    announce(`Downloaded ${R.checks.length} stations' check times as CSV.`);
  }

  // What the tests read: the result, as plain data.
  function state_() { return { R: result(), path: S.path, all: S.all }; }

  return { render, setPath, toggleAll, exportCsv, state: state_ };
})();

if (typeof window !== 'undefined') window.HealthAirtime = HealthAirtime;
