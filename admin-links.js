// MegaNet — admin-links.js
//
//   AdminLinks   the Admin tab's Base station connections: how each base
//                station's connection has been over the last week, month or
//                quarter — uptime, dropouts, restarts, the network it calls
//                from — a day-by-hour picture of when it dropped out, and the
//                Connection log of every gap and change behind it.
//
// After core.js, before admin.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr and registerTabTeardown; to
// datastore.js for dbRpc; to auth.js for Auth. admin.js draws it
// (AdminLinks.render into #adm-links) and loads it (Admin.init); auth.js calls
// AdminLinks.authChanged(). Nothing here runs at load.
//
// Everything on it is one call, meganet.admin_base_station_links() (0080),
// which refuses anybody meganet.is_admin() says no to. The database keeps the
// events — a gap in the check-ins, a new address block, a new route — and this
// draws them: every sum and percentage is worked out here, over the window
// asked for, in this browser's time zone, so "3 am" is the station's 3 am for
// anybody looking from the same place.
//
// Why it exists: on 24 Oct 2026 a phone on 18 Bateson's Wi-Fi got no answer at
// 03:51, and the explanation — nine minutes without a check-in, a new Starlink
// address after, the same at about that hour on the 17th and the 21st — took
// three logs side by side. The day chart puts the three nights in a column;
// the hour chart says it in words.
const AdminLinks = (function () {

  const WINDOWS  = [7, 30, 90];
  const AUTO_MS  = 2 * 60 * 1000;
  const LOG_PAGE = 60;
  const DAY_MS   = 86400 * 1000;

  // What each kind of event is, in words and in colour. `down` counts against
  // uptime; `quiet` comes only from the readings before 0080 and does not —
  // nothing heard and nothing sent can be a quiet radio as easily as a dead
  // link.
  const KINDS = {
    offline: { label: 'Offline now',      tone: 'bad',   down: true },
    dropout: { label: 'Dropout',          tone: 'bad',   down: true },
    restart: { label: 'Restart',          tone: 'warn',  down: true },
    agent:   { label: 'Software restart', tone: 'warn',  down: true },
    quiet:   { label: 'No readings',      tone: 'muted', down: false },
    address: { label: 'New address',      tone: 'info' },
    route:   { label: 'Route changed',    tone: 'info' },
  };
  const GAP_KINDS = ['offline', 'dropout', 'restart', 'agent', 'quiet'];

  const FILTERS = [
    ['all',    'Everything'],
    ['gaps',   'Dropouts & restarts'],
    ['net',    'Address & route'],
    ['quiet',  'No readings'],
  ];

  let data     = null;
  let loading  = false;
  let error    = null;
  let missing  = false;
  let loadedAt = null;
  let timer    = null;
  let days     = 30;
  let filter   = 'all';
  let shown    = LOG_PAGE;

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn()
      && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  // ── formatting ──

  function dur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 90) return `${sec} s`;
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.round((sec % 3600) / 60);
    if (d) return `${d} d${h ? ` ${h} h` : ''}`;
    if (h) return `${h} h${m ? ` ${m} min` : ''}`;
    return `${Math.round(sec / 60)} min`;
  }
  const day   = t => t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const clock = t => t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const hhmm  = t => t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const pct   = x => (x >= 0.9995 ? '100' : x >= 0.99 ? (Math.floor(x * 1000) / 10).toFixed(1) : (Math.floor(x * 100)).toString());
  const midnight = t => new Date(t.getFullYear(), t.getMonth(), t.getDate());

  // ── what the events add up to ──

  // The gaps, oldest first, as Dates — and, for a station not online now, the
  // gap it is in: from its last check-in to now.
  function gapsOf(st, now) {
    const out = (st.events || []).filter(e => GAP_KINDS.includes(e.kind) && e.ended_at)
      .map(e => ({ ...e, s: new Date(e.started_at), e: new Date(e.ended_at) }));
    if (st.state !== 'online' && st.mode !== 'off' && st.last_seen_at) {
      const s = new Date(st.last_seen_at);
      out.push({ kind: 'offline', started_at: st.last_seen_at, s, e: now, seconds: (now - s) / 1000, open: true, detail: {} });
    }
    return out.sort((a, b) => a.s - b.s);
  }

  const overlap = (g, a, b) => Math.max(0, Math.min(g.e, b) - Math.max(g.s, a));

  function stats(st, now, from) {
    const start = new Date(Math.max(from, new Date(st.first_seen_at || from)));
    const gaps = gapsOf(st, now);
    const seen = Math.max(1, now - start);
    let down = 0, quiet = 0, longest = null;
    const n = { dropout: 0, restart: 0, agent: 0, quiet: 0, address: 0, route: 0 };
    for (const g of gaps) {
      const o = overlap(g, start, now);
      if (!o) continue;
      if (KINDS[g.kind].down) {
        down += o;
        if (!longest || g.e - g.s > longest.e - longest.s) longest = g;
      } else quiet += o;
      if (g.kind in n) n[g.kind]++;
    }
    for (const e of st.events || []) if ((e.kind === 'address' || e.kind === 'route') && new Date(e.started_at) >= start) n[e.kind]++;
    const lastDown = gaps.filter(g => KINDS[g.kind].down && !g.open).pop();
    return { start, gaps, up: 1 - down / seen, down, quiet, longest, n,
             since: st.state === 'online' ? (lastDown ? lastDown.e : new Date(st.first_seen_at)) : null };
  }

  // When the gaps start, by hour of the day here: dropouts, restarts (the
  // computer's or its software's) and the readings' quiet ones apart.
  function byHour(gaps, start) {
    const h = Array.from({ length: 24 }, () => ({ dropout: 0, restart: 0, quiet: 0 }));
    for (const g of gaps) {
      if (g.open || g.s < start) continue;
      h[g.s.getHours()][g.kind === 'quiet' ? 'quiet' : g.kind === 'dropout' ? 'dropout' : 'restart']++;
    }
    return h;
  }

  // A regular time, said in words, when one hour holds at least three of the
  // connection's gaps and two in five of them.
  function pattern(hours) {
    const down = x => x.dropout + x.restart;
    const total = hours.reduce((s, x) => s + down(x), 0);
    let best = 0;
    for (let i = 1; i < 24; i++) if (down(hours[i]) > down(hours[best])) best = i;
    const n = down(hours[best]);
    if (n < 3 || n / total < 0.4) return '';
    const at = i => `${String(i).padStart(2, '0')}:00`;
    return `${n} of the ${total} dropouts and restarts started between ${at(best)} and ${at((best + 1) % 24)}. `
      + 'A regular hour like that is usually something on a schedule — a router\'s or a satellite dish\'s overnight '
      + 'update, or a timer on the power.';
  }

  // ── drawing ──

  function tile(label, value, sub, tone) {
    return `<div class="adm-kpi${tone ? ` adm-kpi--${tone}` : ''}">
      <div class="adm-kpi-label">${esc(label)}</div>
      <div class="adm-kpi-value">${value}</div>
      <div class="adm-kpi-sub">${sub}</div>
    </div>`;
  }

  function netLine(st) {
    const n = st.net || {};
    const parts = [];
    if (n.v4) parts.push(`IPv4 <code>${esc(n.v4.addr)}</code>`);
    if (n.v6) parts.push(`IPv6 <code>${esc(n.v6.addr)}</code>`);
    if (n.route) parts.push(n.route === 'direct' ? 'straight to the database' : 'through floodwarning.net');
    return parts.length ? parts.join(' · ') : 'no address recorded yet — the first check-in since 0080 records it';
  }

  const STATE_WORD = { online: 'Online', quiet: 'Late checking in', offline: 'Offline', off: 'Check-ins off' };

  function stationHtml(st, now, from) {
    const s = stats(st, now, from);
    const id = Number(st.id);
    const hours = byHour(s.gaps, s.start);
    const said = pattern(hours);
    const gapN = s.n.dropout + s.n.restart + s.n.agent;
    const upTone = s.up >= 0.999 ? 'ok' : s.up >= 0.98 ? '' : 'warn';
    return `
      <section class="bl-station" aria-labelledby="bl-h-${id}">
        <div class="bl-station-head">
          <h3 id="bl-h-${id}">${esc(st.label)}</h3>
          <span class="bl-state bl-state--${escAttr(st.state || 'offline')}">${esc(STATE_WORD[st.state] || st.state || '')}</span>
          <span class="small txt-muted">${esc([st.app, st.version].filter(Boolean).join(' '))}${st.app ? ' · ' : ''}${netLine(st)}</span>
        </div>
        <div class="adm-kpis bl-kpis">
          ${tile(`Uptime, ${days} days`, `${pct(s.up)}<small>%</small>`,
                 s.down ? `${dur(s.down / 1000)} without a check-in` : 'no gap in the check-ins', upTone)}
          ${tile('Dropouts', String(s.n.dropout),
                 `${s.n.restart} restart${s.n.restart === 1 ? '' : 's'} · ${s.n.agent} software restart${s.n.agent === 1 ? '' : 's'}`,
                 gapN ? '' : 'ok')}
          ${tile('Longest gap', s.longest ? dur((s.longest.e - s.longest.s) / 1000) : '—',
                 s.longest ? `${esc(day(s.longest.s))}, ${esc(hhmm(s.longest.s))}` : 'none in the window')}
          ${st.state === 'online'
            ? tile('Connected for', dur((now - s.since) / 1000), `since ${esc(day(s.since))}, ${esc(hhmm(s.since))}`, 'ok')
            : tile(st.state === 'off' ? 'Check-ins off since' : 'Last check-in',
                   st.last_seen_at ? esc(hhmm(new Date(st.last_seen_at))) : '—',
                   st.last_seen_at ? `${esc(day(new Date(st.last_seen_at)))} · ${dur((now - new Date(st.last_seen_at)) / 1000)} ago` : '',
                   st.state === 'off' ? '' : 'warn')}
          ${tile('Network changes', String(s.n.address + s.n.route),
                 `${s.n.address} new address${s.n.address === 1 ? '' : 'es'} · ${s.n.route} route change${s.n.route === 1 ? '' : 's'}`)}
          ${s.quiet ? tile('No readings', dur(s.quiet / 1000), 'before the connection log began — cause unknown') : ''}
        </div>
        <div class="bl-charts">
          ${daysHtml(st, s, now)}
          ${hoursHtml(hours, id)}
        </div>
        ${said ? `<p class="small bl-said">${esc(said)}</p>` : ''}
      </section>`;
  }

  // One row a day, newest on top, midnight to midnight here: the gaps drawn
  // where they fell, the address and route changes as ticks.
  function daysHtml(st, s, now) {
    const rows = [];
    const today = midnight(now);
    const first = new Date(st.first_seen_at || 0);
    const changes = (st.events || []).filter(e => e.kind === 'address' || e.kind === 'route');
    for (let i = 0; i < days; i++) {
      const a = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1);
      // Before it was first seen there is nothing to draw: one line says so.
      if (b <= first) {
        rows.push(`<p class="small bl-first">First checked in ${esc(day(first))}, ${esc(hhmm(first))}.</p>`);
        break;
      }
      const span = b - a;
      const lo = new Date(Math.max(a, first)), hi = new Date(Math.min(b, now));
      const label = days <= 30 || a.getDay() === 1 || a.getDate() === 1 ? esc(day(a)) : '';
      let down = 0;
      const said = [];
      const segs = s.gaps.filter(g => overlap(g, a, b)).map(g => {
        const o = overlap(g, a, b);
        if (KINDS[g.kind].down) down += overlap(g, lo, hi);
        const k = KINDS[g.kind];
        said.push(`${k.label.toLowerCase()} ${hhmm(g.s)}–${g.open ? 'now' : hhmm(g.e)}`);
        const left = (Math.max(g.s, a) - a) / span * 100;
        const tip = `${k.label}: ${day(g.s)} ${clock(g.s)} → ${g.open ? 'still' : clock(g.e)} (${dur((g.e - g.s) / 1000)})`;
        return `<span class="bl-seg bl-k--${g.kind}" style="left:${left.toFixed(2)}%;width:${Math.max(0.35, o / span * 100).toFixed(2)}%" title="${escAttr(tip)}"></span>`;
      });
      for (const e of changes) {
        const t = new Date(e.started_at);
        if (t < a || t >= b) continue;
        said.push(`${KINDS[e.kind].label.toLowerCase()} ${hhmm(t)}`);
        segs.push(`<span class="bl-tick bl-k--${e.kind}" style="left:${((t - a) / span * 100).toFixed(2)}%"
          title="${escAttr(`${KINDS[e.kind].label} ${day(t)} ${clock(t)}: ${e.from || '?'} → ${e.to || '?'}`)}"></span>`);
      }
      const up = 1 - down / Math.max(1, hi - lo);
      rows.push(`<div class="bl-day"><span class="bl-day-l">${label}</span>
        <span class="bl-track">${segs.join('')}</span>
        <span class="bl-day-r small${down ? ' bl-day-r--down' : ''}">${down ? `${pct(up)}%` : ''}</span>
        <span class="sr-only">${esc(day(a))}: ${said.length ? esc(said.join('; ')) : 'no gaps'}.</span></div>`);
    }
    const ticks = [0, 6, 12, 18, 24].map(h => `<span style="left:${(h / 24 * 100).toFixed(2)}%">${String(h % 24).padStart(2, '0')}</span>`).join('');
    return `
      <figure class="bl-days bl-days--${days}">
        <figcaption class="small">Each day, midnight to midnight here — when the check-ins stopped</figcaption>
        <div class="bl-day bl-axis" aria-hidden="true"><span class="bl-day-l"></span><span class="bl-track bl-ticks">${ticks}</span><span class="bl-day-r small">uptime</span></div>
        ${rows.join('')}
      </figure>`;
  }

  function hoursHtml(hours, id) {
    const sum = h => h.dropout + h.restart + h.quiet;
    const max = Math.max(1, ...hours.map(sum));
    const cols = hours.map((h, i) => {
      const n = sum(h);
      const at = String(i).padStart(2, '0');
      const tall = (n / max * 100).toFixed(1);
      const said = [h.dropout && `${h.dropout} dropout${h.dropout === 1 ? '' : 's'}`,
                    h.restart && `${h.restart} restart${h.restart === 1 ? '' : 's'}`,
                    h.quiet && `${h.quiet} without readings`].filter(Boolean).join(', ') || 'none';
      const seg = (k, v) => (v ? `<span class="bl-hseg bl-k--${k}" style="height:${(v / n * 100).toFixed(1)}%"></span>` : '');
      return `<li title="${escAttr(`${at}:00–${String((i + 1) % 24).padStart(2, '0')}:00 — ${said}`)}">
        <span class="bl-hcol" style="height:${tall}%">${seg('dropout', h.dropout)}${seg('restart', h.restart)}${seg('quiet', h.quiet)}</span>
        ${n ? `<span class="bl-hn" style="bottom:${tall}%">${n}</span>` : ''}
        ${i % 6 === 0 ? `<span class="bl-hl">${at}</span>` : ''}
      </li>`;
    }).join('');
    return `
      <figure class="bl-hours">
        <figcaption class="small" id="bl-hours-${id}">When the gaps start, by hour of the day</figcaption>
        <ol class="bl-hbars" aria-labelledby="bl-hours-${id}">${cols}</ol>
      </figure>`;
  }

  function legendHtml() {
    return `<p class="small bl-legend" aria-hidden="true">
      ${['dropout', 'restart', 'quiet', 'address'].map(k => `<span><i class="bl-sw bl-k--${k}"></i>${
        k === 'address' ? 'New address or route' : k === 'restart' ? 'Restart (the computer or its software)' : esc(KINDS[k].label)}</span>`).join('')}
    </p>`;
  }

  // ── the log ──

  function inFilter(kind, f = filter) {
    if (f === 'gaps')  return ['offline', 'dropout', 'restart', 'agent'].includes(kind);
    if (f === 'net')   return kind === 'address' || kind === 'route';
    if (f === 'quiet') return kind === 'quiet';
    return true;
  }

  function detailText(e) {
    const d = e.detail || {};
    const len = dur(e.seconds != null ? e.seconds : (e.e - e.s) / 1000);
    switch (e.kind) {
      case 'offline': return `No check-in since ${day(e.s)}, ${clock(e.s)}.`;
      case 'dropout':
        if (d.source === 'readings') {
          return `Nothing arrived for ${len}, though ${d.held} reading${d.held === 1 ? ' was' : 's were'} heard meanwhile and sent on its return — `
            + 'the connection, not the radio. From the readings, before the connection log began.';
        }
        return d.up_s != null
          ? `No check-in for ${len}. The computer stayed up (${dur(d.up_s)} since it started), so it was the connection.`
          : `No check-in for ${len}. The check-in that ended it carried no uptime, so whether the computer stayed up is not known.`;
      case 'restart': return `The computer started again ${dur(d.up_s)} before it checked back in — it lost power or rebooted.`;
      case 'agent':   return `The computer stayed up; the base station software started again ${dur(d.agent_up_s)} before it checked back in — an update, or the software stopping.`;
      case 'quiet':   return `Nothing heard and nothing sent for ${len}. From the readings, before the connection log began: the station, its receivers or the traffic stopped — no telling which.`;
      case 'address': {
        const fam = d.family === 'v6' ? 'IPv6' : 'IPv4';
        return e.from === e.to
          ? `A new ${fam} address in the same block, ${e.to} — the connection was made again.`
          : `${fam} address block ${e.from || '?'} → ${e.to || '?'}${d.route ? `, ${d.route === 'direct' ? 'straight to the database' : 'through floodwarning.net'}` : ''}.`;
      }
      case 'route': {
        const w = r => (r === 'direct' ? 'straight to the database' : 'through floodwarning.net');
        return `Now ${w(e.to)}; was ${w(e.from)}.`;
      }
      default: return '';
    }
  }

  function logRows(now) {
    const rows = [];
    for (const st of data.stations || []) {
      for (const g of gapsOf(st, now)) rows.push({ ...g, station: st.label });
      for (const e of st.events || []) {
        if (e.kind === 'address' || e.kind === 'route') rows.push({ ...e, s: new Date(e.started_at), station: st.label });
      }
    }
    return rows.filter(r => r.s >= new Date(data.from) || (r.e && r.e >= new Date(data.from)))
      .sort((a, b) => b.s - a.s);
  }

  function logHtml(now) {
    const all = logRows(now);
    const rows = all.filter(r => inFilter(r.kind));
    const many = (data.stations || []).length > 1;
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, all.filter(r => inFilter(r.kind, k)).length]));
    const body = rows.slice(0, shown).map(r => {
      const k = KINDS[r.kind];
      const gap = GAP_KINDS.includes(r.kind);
      return `<tr class="bl-row bl-row--${r.kind}">
        ${many ? `<td>${esc(r.station)}</td>` : ''}
        <td class="bl-when"><span class="bl-date">${esc(day(r.s))}</span>
          ${gap ? `<span class="bl-time">lost ${esc(clock(r.s))}</span><span class="bl-time">${r.open ? '<strong>not back yet</strong>' : `back ${esc(clock(r.e))}`}</span>`
                : `<span class="bl-time">${esc(clock(r.s))}</span>`}</td>
        <td><span class="bl-badge bl-k--${r.kind}">${esc(k.label)}</span></td>
        <td class="bl-len">${gap ? esc(dur((r.e - r.s) / 1000)) : ''}</td>
        <td class="small">${esc(detailText(r))}</td>
      </tr>`;
    }).join('');
    return `
      <div class="panel">
        <div class="panel-header">
          <h2 id="bl-log-h">Connection log</h2>
          <div class="pill-row" role="group" aria-label="Show">${FILTERS.map(([k, l]) => `<button type="button"
            class="pill${filter === k ? ' is-on' : ''}" aria-pressed="${filter === k}" onclick="AdminLinks.setFilter('${k}')">${esc(l)} <span class="bl-count">${counts[k]}</span></button>`).join('')}</div>
        </div>
        <p class="small">Every gap in the base stations' check-ins, and every change of the network they call from, over the
          last ${days} days — newest first, in this browser's time zone. A check-in is due about once a minute; a gap is
          three missed in a row. The address is kept only as its block, never in full.</p>
        ${rows.length ? `
        <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="bl-log-h">
          <table class="adm-table bl-log">
            <caption class="sr-only">Connection events, newest first</caption>
            <colgroup>${many ? '<col style="width:9rem">' : ''}<col style="width:10.5rem"><col style="width:9.5rem">
              <col style="width:6rem"><col></colgroup>
            <thead><tr>${many ? '<th scope="col">Station</th>' : ''}<th scope="col">When</th><th scope="col">Event</th>
              <th scope="col">Lasted</th><th scope="col">What it means</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${rows.length > shown ? `<button type="button" class="exp-btn-sm" onclick="AdminLinks.more()">Show ${Math.min(LOG_PAGE, rows.length - shown)} more of ${rows.length - shown}</button>` : ''}`
        : `<p class="small">${all.length ? 'Nothing of this kind in the window.' : `No gaps and no changes in the last ${days} days.`}</p>`}
      </div>`;
  }

  // ── the section ──

  function render() {
    const head = `
      <div class="panel-header">
        <h2 id="bl-h">Base station connections</h2>
        ${isAdmin() ? `<span class="button-group">
          <span class="pill-row" role="group" aria-label="How far back">${WINDOWS.map(d => `<button type="button"
            class="pill${d === days ? ' is-on' : ''}" aria-pressed="${d === days}" onclick="AdminLinks.setDays(${d})">${d} days</button>`).join('')}</span>
          <span class="small adm-stamp">${loading ? 'Loading…' : loadedAt ? `Updated ${loadedAt.toLocaleTimeString()}` : ''}</span>
          <button class="exp-btn-sm" onclick="AdminLinks.load()">Refresh</button></span>` : ''}
      </div>`;
    if (!isAdmin()) return '';
    let inner;
    if (missing) inner = '<p class="small">The database does not keep this yet — apply <code>db/migrations/0080_base_station_links.sql</code>.</p>';
    else if (error) inner = `<p class="small txt-bad">${esc(error)}</p>`;
    else if (!data) inner = '<p class="small">Loading…</p>';
    else if (!(data.stations || []).length) inner = '<p class="small">No base station has checked in. One that does appears here with its connection.</p>';
    if (inner) return `<div class="panel" aria-labelledby="bl-h">${head}${inner}</div>`;
    const now = new Date(data.now);
    const from = new Date(data.from);
    return `
      <div class="panel bl-panel" aria-labelledby="bl-h">${head}
        <p class="small">How each base station's connection to Flood-Net has been: a check-in about once a minute,
          and the time between them when they stopped. Uptime counts only the time since it was first seen.</p>
        ${(data.stations || []).map(st => stationHtml(st, now, from)).join('')}
        ${legendHtml()}
      </div>
      ${logHtml(now)}`;
  }

  function repaint() {
    const el = document.getElementById('adm-links');
    if (el && state.activeTab === 'admin') el.innerHTML = render();
  }

  async function load() {
    if (!isAdmin()) { repaint(); return; }
    loading = true; repaint();
    try {
      data = await dbRpc('admin_base_station_links', { p_days: days });
      error = null; missing = false;
      loadedAt = new Date();
    } catch (err) {
      if (err.status === 404) missing = true;
      else error = `Could not load the base station connections: ${err.message}`;
    }
    loading = false;
    repaint();
  }

  // Called by Admin.init() whenever the tab is drawn: loads once, then every
  // two minutes while the tab is open; leaving the tab stops it.
  function start() {
    if (!isAdmin()) { repaint(); return; }
    if (!data && !loading) load();
    if (!timer) timer = setInterval(() => { if (!document.hidden) load(); }, AUTO_MS);
    registerTabTeardown('admin-links', stop);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function setDays(d) {
    if (!WINDOWS.includes(d) || d === days) return;
    days = d; shown = LOG_PAGE;
    load();
  }
  function setFilter(f) {
    filter = FILTERS.some(([k]) => k === f) ? f : 'all';
    shown = LOG_PAGE;
    repaint();
  }
  function more() { shown += LOG_PAGE; repaint(); }

  function authChanged() {
    data = null; error = null; missing = false; loadedAt = null;
    stop();
    if (state.activeTab === 'admin') { repaint(); start(); }
  }

  return { render, load, start, stop, setDays, setFilter, more, authChanged };
})();
if (typeof window !== 'undefined') window.AdminLinks = AdminLinks;
