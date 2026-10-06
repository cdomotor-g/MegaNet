// MegaNet — base-stations.js
//
//   BaseStations   the Base Stations tab (0049): every ingest point's health on
//                  one list — the base stations that check in, and the ones
//                  that only post — and an administrator asking one of them to
//                  do something: change a setting, restart a receiver or the
//                  whole station, install an update, show its log. And the
//                  team's SSH public keys, which a base station whose owner
//                  allows it installs for its maintenance account.
//
// After core.js, datastore.js (dbRpc) and auth.js (Auth); before init.js.
// Nothing here runs at load: renderMain() calls render() and init(), and
// auth.js calls authChanged() on every sign-in and sign-out.
//
// How it reaches a base station. It does not: nothing does. A base station
// checks in with the database about once a minute (base_station_checkin(),
// granted to its ingest token), and what is asked of it here waits in
// meganet.base_station_command until then. So this tab never shows a request
// as done until the station has answered; opening a station tells it to check
// in every five seconds for the next three minutes (admin_base_station_watch(),
// renewed while the panel stays open), which is what makes the second request
// quick even when the first one waits for the station's minute.
//
// What may be asked is the database's list (base_station_verb_check()), and the
// station holds itself to the same list again: settings — never the token,
// where readings go, the web page's password, or what the station lets MegaNet
// do — restarts, updates, its log. **This tab is not the security**: every
// function refuses anybody meganet.is_admin() says no to, and a station its
// owner set to "report" refuses everything asked of it.
//
// Signed out, or signed in without being an administrator, the tab says what
// it is for and nothing about any base station.

const BaseStations = (function () {
  // What the database last said. null is "not asked yet".
  let list = null, loading = false, error = null;
  let skew = 0;                      // the database's clock minus this browser's
  let openId = null, detail = null, detailErr = null;
  // What the database said to the last thing asked of the open station, when
  // it refused — kept until the next ask, since the reload after it succeeds.
  let askErr = null;
  let keys = null, keysErr = null;
  // The last key added or taken off: { text, cls }, for the same reason.
  let keyMsg = null;
  let note = '';
  // The settings form, mirrored so a repaint does not take typing away:
  // { id, sig, dirty, f: { field: value } }.
  let form = null;
  // The team key form, mirrored for the same reason.
  let keyForm = { owner: '', key: '' };
  // What became of the last "Send the changes": { text, cls }, kept so a poll's
  // repaint does not wipe it.
  let formNote = null;
  // The log a station sent back, shown until the panel closes: { id, lines }.
  let logShown = null;
  const timers = { list: null, detail: null, watch: null };
  let lastAsk = 0;

  const LIST_MS = 30000, BUSY_MS = 3000, IDLE_MS = 15000, WATCH_MS = 60000;
  const FORMATS = { BINARY: 'ALERT Binary', ENHANCED_IFLOWS: 'Enhanced iFLOWS', ASCII: 'ALERT ASCII' };
  const VERBS = {
    status: 'send its whole status', log: 'show its log', 'config.set': 'change settings',
    'device.restart': 'restart a receiver', 'device.rescan': 'look for receivers', 'device.forget': 'remove an unplugged receiver',
    'send-now': 'send what is queued', 'stations.refresh': 'download the station register again',
    'agent.restart': 'restart its software', reboot: 'reboot', 'update.check': 'check for updates',
    'update.install': 'install the latest release', 'update.auto': 'automatic updates', 'access.sync': 'fetch its SSH keys again',
  };

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  // ── time ─────────────────────────────────────────────────────────────────

  // Ages are worked out on the database's clock, which the answers carry: a
  // laptop five minutes out would otherwise call every station quiet.
  const now = () => Date.now() + skew;
  function setNow(ts) { const t = Date.parse(ts); if (isFinite(t)) skew = t - Date.now(); }

  function ago(ts) {
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!isFinite(t)) return '—';
    const s = Math.max(0, Math.round((now() - t) / 1000));
    return s < 10 ? 'just now' : s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago'
      : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  }
  function span(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    return sec < 3600 ? Math.round(sec / 60) + ' min' : sec < 172800 ? Math.round(sec / 3600) + ' h' : Math.round(sec / 86400) + ' days';
  }
  function when(ts) { const d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleString(); }

  // ── what a station's state is ────────────────────────────────────────────

  // online · quiet · offline · off · not managed — from when it last checked in,
  // against how often it says it checks in.
  function liveness(s) {
    if (!s.managed) return { k: 'unmanaged', label: 'not managed', cls: 'txt-muted' };
    if (s.mode === 'off') return { k: 'off', label: 'turned off on the station', cls: 'txt-muted' };
    const age = now() - Date.parse(s.last_seen_at);
    if (age <= Math.max(180000, (s.idle_s || 60) * 3000)) return { k: 'online', label: 'online', cls: 'txt-ok' };
    if (age <= 3600000) return { k: 'quiet', label: 'quiet', cls: 'txt-warn' };
    return { k: 'offline', label: 'offline', cls: 'txt-bad' };
  }

  // What needs looking at, worst first: [class, text].
  function flags(s) {
    const b = s.beat || {}, st = s.status || {}, m = st.meganet || {};
    const out = [];
    if (m.token_refused) out.push(['txt-bad', 'token refused']);
    if (b.uv) out.push(['txt-bad', 'under-voltage now']);
    else if (b.uv_boot) out.push(['txt-warn', 'under-voltage since boot']);
    if (b.temp != null && b.temp >= 75) out.push(['txt-bad', b.temp + ' °C']);
    else if (b.temp != null && b.temp >= 65) out.push(['txt-warn', b.temp + ' °C']);
    if (b.throttled) out.push(['txt-warn', 'throttled']);
    if (b.clock === false) out.push(['txt-warn', 'clock not set']);
    if (b.disk_free != null && b.disk_free < 500) out.push(['txt-warn', b.disk_free + ' MB disk free']);
    if ((b.q || 0) + (b.hold || 0) > 500) out.push(['txt-warn', ((b.q || 0) + (b.hold || 0)) + ' readings waiting']);
    const rx = receiversOf(s).filter(r => r.kind !== 'gps');
    const down = rx.filter(r => r.state !== 'running' && r.state !== 'disabled');
    if (down.length) out.push(['txt-warn', down.length + ' receiver' + (down.length === 1 ? '' : 's') + ' not receiving']);
    return out;
  }

  // The receivers the station's status names, with the heartbeat's live state
  // over the status's (which is only as fresh as the last whole status).
  function receiversOf(s) {
    const live = new Map(((s.beat || {}).rx || []).map(r => [r[0], r]));
    return ((s.status || {}).receivers || []).map(r => {
      const b = live.get(String(r.key).slice(-80));
      return Object.assign({}, r, b ? { state: b[1], decoded: b[2], dataAgoS: b[3] } : {});
    });
  }

  function rxSummary(s) {
    if (!s.managed) {
      const r = s.receivers || [];
      return r.length ? r.map(x => x.name || x.point_id).join(', ') : '—';
    }
    const rx = receiversOf(s).filter(r => r.kind !== 'gps');
    if (!rx.length) return 'none plugged in';
    return rx.filter(r => r.state === 'running').length + ' of ' + rx.length + ' receiving';
  }

  // ── the list ─────────────────────────────────────────────────────────────

  function kpisHtml() {
    const st = (list && list.stations) || [];
    const n = (k) => st.filter(s => liveness(s).k === k).length;
    const tile = (label, v, sub, mod) => `<div class="adm-kpi${mod ? ' adm-kpi--' + mod : ''}"><div class="adm-kpi-label">${esc(label)}</div>`
      + `<div class="adm-kpi-value">${esc(v)}</div><div class="adm-kpi-sub">${esc(sub)}</div></div>`;
    const needs = st.filter(s => s.managed && flags(s).length).length;
    return `<div class="adm-kpis">${tile('Online', n('online'), 'checked in within a few minutes', 'ok')}`
      + tile('Quiet or offline', n('quiet') + n('offline'), 'not heard from lately', n('quiet') + n('offline') ? 'warn' : '')
      + tile('Need a look', needs, 'power, heat, receivers, queue', needs ? 'warn' : '')
      + tile('Not managed', n('unmanaged') + n('off'), 'post, but do not check in', '') + '</div>';
  }

  function listHtml() {
    const st = (list && list.stations) || [];
    if (!st.length) return `<p class="small table-empty">No ingest points yet. A base station appears here once it has an ingest token (Admin → Ingest tokens), and checks in by itself once its software does.</p>`;
    return `
      <div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-list-h">
        <table class="adm-table bs-list">
          <caption class="sr-only">Every ingest point: whether it checks in, its receivers, its uplink and what needs a look</caption>
          <thead><tr>
            <th scope="col">Base station</th><th scope="col">State</th><th scope="col">Receivers</th>
            <th scope="col" class="col-optional">Software</th><th scope="col">Needs a look</th>
            <th scope="col" class="bs-act"><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>${st.map(s => {
            const l = liveness(s), f = s.managed ? flags(s) : [];
            const name = (s.status && s.status.name && s.status.name !== s.label) ? s.status.name : '';
            return `<tr${s.id === openId ? ' class="selected"' : ''}>
              <th scope="row">${esc(s.label)}${name ? `<div class="small qs-dim">${esc(name)}</div>` : ''}${s.host_station ? `<div class="small qs-dim">at ${esc(s.host_station)}</div>` : ''}</th>
              <td><span class="${l.cls}">● ${esc(l.label)}</span><div class="small qs-dim">${s.managed ? 'checked in ' + esc(ago(s.last_seen_at)) : 'last posted ' + esc(s.last_used_at ? ago(s.last_used_at) : 'never')}</div>
                ${s.mode === 'report' ? '<div class="small"><span class="badge">reports only</span></div>' : ''}${s.revoked_at ? '<div class="small"><span class="badge">token revoked</span></div>' : ''}</td>
              <td class="small">${esc(rxSummary(s))}</td>
              <td class="small col-optional">${s.version ? esc(s.version) : '—'}</td>
              <td class="small">${s.managed ? (f.length ? f.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join('<br>') : '<span class="txt-ok">nothing</span>') : '<span class="qs-dim">—</span>'}</td>
              <td class="adm-row-acts"><button class="exp-btn-sm" onclick="BaseStations.open(${Number(s.id)})"
                aria-label="Open ${esc(s.label)}"${s.id === openId ? ' aria-pressed="true"' : ''}>${s.id === openId ? 'Open ▾' : 'Open'}</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  }

  // ── one station ──────────────────────────────────────────────────────────

  function stationOf() { return detail && detail.station && detail.station.id === openId ? detail.station : ((list && list.stations) || []).find(s => s.id === openId) || null; }

  function canAsk(s) { return s && s.managed && s.mode === 'manage' && !s.revoked_at; }

  function headHtml(s) {
    const l = liveness(s);
    const watching = s.watch_until && Date.parse(s.watch_until) > now();
    const why = !s.managed ? 'It posts readings, but its software does not check in, so it cannot be asked anything from here.'
      : s.revoked_at ? 'Its ingest token is revoked: it can no longer check in.'
      : s.mode === 'report' ? 'Its owner set it to report only: its health shows here, and anything asked is refused.'
      : s.mode === 'off' ? 'Its owner turned remote management off on the station.'
      : l.k === 'online' ? (watching ? 'Open here, so it checks in every few seconds; what you ask is done within seconds.' : 'What you ask waits for its next check-in — within a minute.')
      : 'It has not checked in lately. What you ask waits for it for ten minutes, then expires.';
    return `<div class="panel-header"><h2 id="bs-detail-h">${esc(s.label)}</h2>
        <button class="exp-btn-sm" onclick="BaseStations.close()" aria-label="Close ${esc(s.label)}">Close</button></div>
      <p class="small"><span class="${l.cls}">● ${esc(l.label)}</span>${s.managed ? ' · checked in ' + esc(ago(s.last_seen_at)) : ''}${s.status_at ? ' · whole status ' + esc(ago(s.status_at)) : ''}
        ${s.mode === 'report' ? ' · <span class="badge">reports only</span>' : ''}</p>
      <p class="small">${esc(why)}</p>`;
  }

  // A button that asks the open station for something. What it asks rides in
  // data- attributes, which the HTML parser hands back exactly as written —
  // a confirmation with an apostrophe in it, or a receiver key, never has to
  // survive being a JS string inside an attribute as well.
  function askBtn(verb, args, conf, label, cls, aria) {
    return `<button class="${cls || 'exp-btn-sm'}" data-verb="${esc(verb)}" data-args="${esc(JSON.stringify(args || {}))}"`
      + (conf ? ` data-confirm="${esc(conf)}"` : '') + (aria ? ` aria-label="${esc(aria)}"` : '')
      + ` onclick="BaseStations.askFrom(this)">${esc(label)}</button>`;
  }

  function actionsHtml(s) {
    if (!canAsk(s)) return '';
    const b = (verb, label, args, conf, cls) => askBtn(verb, args, conf, label, cls ? 'exp-btn-sm ' + cls : 'exp-btn-sm');
    return `<div class="button-group adm-actions" role="group" aria-label="Ask ${esc(s.label)}">
      ${b('status', 'Refresh its status')}
      ${b('send-now', 'Send what is queued')}
      ${b('device.rescan', 'Look for receivers')}
      ${b('update.check', 'Check for updates')}
      ${b('agent.restart', 'Restart its software', {}, 'Restart the base station\'s software? It is back within seconds; a burst heard in those seconds is missed.')}
      ${b('reboot', 'Reboot…', {}, 'Reboot the base station? It is back in a minute or two, and hears nothing meanwhile.', 'adm-danger')}
    </div>`;
  }

  function healthHtml(s) {
    const st = s.status || {}, h = st.host || {}, b = s.beat || {}, c = st.clock || {}, loc = st.location || {};
    const rows = [
      ['Host', esc(h.hostname || '—') + (h.addresses && h.addresses.length ? ` <span class="qs-dim">${esc(h.addresses.map(a => a.address).join(', '))}</span>` : '')],
      ['Hardware', esc([h.model, h.cores ? h.cores + ' cores' : '', h.mem_mb ? h.mem_mb + ' MB' : ''].filter(Boolean).join(' · ') || '—')],
      ['System', esc([h.os, h.arch, h.node ? 'node ' + h.node : ''].filter(Boolean).join(' · ') || '—')],
      ['Up', esc(b.up != null ? span(b.up) + (b.agent_up != null ? ' (software ' + span(b.agent_up) + ')' : '') : '—')],
      ['Temperature', b.temp != null ? `<span class="${b.temp >= 75 ? 'txt-bad' : b.temp >= 65 ? 'txt-warn' : ''}">${esc(b.temp)} °C</span>` : '—'],
      ['Load, memory, disk', esc([b.load != null ? 'load ' + b.load : '', b.mem_free != null ? b.mem_free + ' MB free' : '', b.disk_free != null ? b.disk_free + ' MB disk free' : ''].filter(Boolean).join(' · ') || '—')],
      ['Power', b.uv ? '<span class="txt-bad">under-voltage now — a weak supply drops USB receivers</span>' : b.uv_boot ? '<span class="txt-warn">under-voltage since boot</span>' : b.throttled ? '<span class="txt-warn">throttled</span>' : 'good'],
      ['Clock', c.trusted === false || b.clock === false ? '<span class="txt-warn">not set yet — readings are held until it is</span>' : esc((c.source || 'set') + (c.timezone ? ' · ' + c.timezone : ''))],
      ['Location', loc.source && loc.source !== 'none' ? esc(loc.source + (loc.lat != null ? ' · ' + loc.lat + ', ' + loc.lon : '') + (loc.source === 'gps' ? '' : ' (approximate)')) : 'not given'],
    ];
    // A site survey (RPi ALERT 0.9): what it heard goes to the Reception Map's Site surveys.
    const sv = st.survey;
    if (sv && sv.state === 'running') rows.push(['Site survey', esc('“' + sv.name + '” — listening ' + span(Math.round((sv.elapsed_ms != null ? sv.elapsed_ms : sv.elapsedMs || 0) / 1000)) + ', ' + (sv.addresses || 0) + ' addresses heard')
      + ' <span class="qs-dim">· Reception Map → Site surveys</span>']);
    else if (sv && sv.state === 'armed') rows.push(['Site survey', esc('“' + sv.name + '” starts at its next power-up')]);
    return `<h3>Health</h3><dl class="adm-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  function rxDetail(r) {
    if (r.kind === 'sdr') {
      // A stick hearing several channels says each, its own first.
      const tuned = Array.isArray(r.channels) && r.channels.length > 1
        ? r.channels.map(ch => (ch.freq_hz / 1e6).toFixed(4) + ' MHz ' + (FORMATS[ch.format] || ch.format)
            + (ch.in_band === false ? ' (outside what the stick hears)' : ' (' + (ch.decoded || 0) + ' decoded)')).join(', ')
        : [r.freq_hz ? (r.freq_hz / 1e6).toFixed(4) + ' MHz' : '', FORMATS[r.format] || r.format].filter(Boolean).join(' · ');
      return [tuned, r.gain_db == null ? 'gain auto' : 'gain ' + r.gain_db + ' dB',
        r.model, r.usb_port ? 'USB port ' + r.usb_port : ''].filter(Boolean).join(' · ');
    }
    return [r.port ? String(r.port).split('/').pop() : '', r.baud ? r.baud + ' baud' : '', r.firmware ? 'firmware ' + r.firmware : '',
      r.battery_pct != null ? 'battery ' + r.battery_pct + '%' : ''].filter(Boolean).join(' · ');
  }

  function receiversHtml(s) {
    const rx = receiversOf(s);
    const ask = canAsk(s);
    if (!s.managed) {
      return `<h3>Receivers</h3>${(s.receivers || []).length ? `<ul class="small">${s.receivers.map(r => `<li>${esc(r.name || r.point_id)} <span class="qs-dim">(${esc(r.receiver)}, reported ${esc(ago(r.last_seen_at))})</span></li>`).join('')}</ul>` : '<p class="small">None reported.</p>'}`;
    }
    if (!rx.length) return '<h3>Receivers</h3><p class="small">None plugged in.</p>';
    return `<h3 id="bs-rx-h">Receivers</h3>
      <div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-rx-h"><table class="adm-table bs-rx">
        <caption class="sr-only">The station's receivers, their state and settings</caption>
        <thead><tr><th scope="col">Receiver</th><th scope="col">State</th><th scope="col" class="bs-wide">Tuned / port</th><th scope="col">Heard</th><th scope="col" class="bs-act"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rx.map(r => `<tr>
          <th scope="row">${esc(r.name)} <span class="small qs-dim">${esc(r.kind)}</span></th>
          <td class="small"><span class="${r.state === 'running' ? 'txt-ok' : r.state === 'unplugged' || r.state === 'error' ? 'txt-bad' : 'txt-warn'}">${esc(r.state === 'running' ? 'receiving' : r.state)}</span>${r.error ? `<div class="txt-warn">${esc(r.error)}</div>` : ''}</td>
          <td class="small">${esc(rxDetail(r)) || '—'}</td>
          <td class="small">${r.decoded != null ? esc(r.decoded) + ' decoded' : ''}${r.dataAgoS != null ? `<div class="qs-dim">data ${esc(span(r.dataAgoS).replace(/^0 min$/, 'just now'))}</div>` : ''}</td>
          <td class="adm-row-acts">${!ask ? '' : r.state === 'unplugged'
            ? askBtn('device.forget', { key: r.key }, 'Remove ' + r.name + '? The station forgets it — its name, its own settings and its MegaNet receiver id.', 'Remove…', 'exp-btn-sm adm-danger', 'Remove ' + r.name)
            : askBtn('device.restart', { key: r.key }, null, 'Restart', 'exp-btn-sm', 'Restart ' + r.name)}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  function uplinkHtml(s) {
    const m = (s.status || {}).meganet || {}, b = s.beat || {};
    const rows = [
      ['Sending', m.enabled === false ? '<span class="txt-warn">off on the station</span>' : m.token_refused ? '<span class="txt-bad">its token is refused</span>' : 'yes' + (m.receptions === false ? ' (readings only)' : '')],
      ['Waiting to send', esc((b.q != null ? b.q : '—') + (b.hold ? ' · ' + b.hold + ' waiting for the clock' : '') + (b.rxq ? ' · ' + b.rxq + ' receptions' : ''))],
      ['Stored since it started', esc(b.stored != null ? b.stored + (b.refused ? ' (' + b.refused + ' refused)' : '') : '—')],
      ['Last stored', esc(b.last_ok ? ago(b.last_ok) : 'not yet')],
      ['Route', esc(m.endpoint ? (/floodwarning\.net/.test(m.endpoint) ? 'floodwarning.net' : 'the database directly') : '—')],
    ];
    if (m.error) rows.push(['Last problem', `<span class="txt-warn">${esc(m.error)}</span>`]);
    return `<h3>Uplink</h3><dl class="adm-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  function softwareHtml(s) {
    const u = (s.status || {}).update || {};
    const last = u.last ? `${esc(u.last.state)} ${esc(ago(u.last.at * 1000))}: ${esc(u.last.message || '')}` : 'no install from here yet';
    const ask = canAsk(s) && u.available !== false;
    return `<h3>Software</h3>
      <dl class="adm-dl"><dt>Version</dt><dd>${esc(s.version || '—')}</dd>
        <dt>Updates</dt><dd>${u.available === false ? 'managed on the station' : (u.running ? '<span class="txt-warn">installing now</span>' : esc(u.auto ? 'installed by itself, nightly' : 'installed when asked'))}</dd>
        <dt>Last install</dt><dd class="small">${last}</dd></dl>
      ${ask ? `<div class="button-group adm-actions">
        ${askBtn('update.install', {}, 'Install the latest release on ' + s.label + '? Its software restarts on the new version, and the old one is put back if the new one does not start.', 'Install the latest release…')}
        ${askBtn('update.auto', { on: !u.auto }, null, u.auto ? 'Stop installing by itself' : 'Install new releases by itself')}</div>` : ''}`;
  }

  const SOURCES = { local: 'the station (SD card or sudo)', github: 'GitHub', meganet: 'team keys' };

  function accessHtml(s) {
    const a = (s.status || {}).access;
    if (!a) return '<h3>SSH access</h3><p class="small">Not reported yet.</p>';
    if (!a.available) return `<h3>SSH access</h3><p class="small">Not reported by this station${a.error ? ' (' + esc(a.error) + ')' : ''}.</p>`;
    const ssh = a.ssh || {}, acct = a.account || {}, pol = a.policy || {};
    const addrs = (((s.status || {}).host || {}).addresses || []).map(x => x.address);
    const keyRows = (a.keys || []).map(k => `<tr><td class="small"><code>${esc(k.fingerprint)}</code></td><td class="small">${esc(k.comment || '—')}</td>
      <td class="small">${esc(SOURCES[k.source] || k.source)}</td><td class="small">${k.restricted ? 'private networks' : 'anywhere'}</td></tr>`).join('');
    return `<h3 id="bs-ssh-h">SSH access</h3>
      <dl class="adm-dl">
        <dt>SSH</dt><dd>${ssh.active || ssh.enabled ? 'on' + (ssh.port ? ', port ' + esc(ssh.port) : '') : 'off'}${ssh.passwordLogin === true ? ' · <span class="txt-warn">passwords accepted</span>' : ssh.passwordLogin === false ? ' · keys only' : ''}</dd>
        <dt>Maintenance account</dt><dd>${acct.exists ? `<code>${esc(acct.name || 'alert')}</code> · ${acct.password === 'set' ? 'has a password (console)' : 'keys only'} · ${esc(acct.keys || 0)} key${acct.keys === 1 ? '' : 's'}` : '<span class="txt-warn">missing</span>'}</dd>
        <dt>Accounts that can log in</dt><dd class="small">${(a.logins || []).map(l => esc(l.user) + (l.password === 'set' ? ' (password)' : '')
          + (l.password === 'empty' ? ' <span class="txt-bad">(an empty password)</span>' : '')
          + (l.keys ? ' (' + esc(l.keys) + ' key' + (l.keys === 1 ? '' : 's') + ')' : '')).join(', ') || '—'}</dd>
        <dt>Team keys</dt><dd>${pol.meganetKeys ? '<span class="txt-ok">installed</span>' + (s.keys_hash && list && s.keys_hash !== list.keys_hash ? ' <span class="txt-warn">(an older list — it fetches the new one within a minute)</span>' : '') : 'not taken — its owner can turn them on in the station\'s Settings → SSH access, or with <code>ssh_meganet_keys = yes</code> on its SD card'}</dd>
        ${(pol.github || []).length ? `<dt>GitHub accounts</dt><dd class="small">${esc(pol.github.join(', '))}</dd>` : ''}
        ${addrs.length && acct.exists ? `<dt>Log in</dt><dd class="small">${addrs.map(ip => `<code>ssh ${esc(acct.name || 'alert')}@${esc(ip)}</code>`).join(' · ')}</dd>` : ''}
      </dl>
      ${keyRows ? `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-ssh-h"><table class="adm-table bs-ssh">
        <caption class="sr-only">The keys that may log in to the station's maintenance account</caption>
        <thead><tr><th scope="col" class="bs-wide">Fingerprint</th><th scope="col">Whose</th><th scope="col">From</th><th scope="col">Works from</th></tr></thead>
        <tbody>${keyRows}</tbody></table></div>${a.keys_total > (a.keys || []).length ? `<p class="small qs-dim">and ${esc(a.keys_total - a.keys.length)} more, not sent</p>` : ''}` : '<p class="small">No key on its list: nobody can log in to the maintenance account yet.</p>'}
      ${canAsk(s) && pol.meganetKeys ? `<div class="button-group adm-actions">${askBtn('access.sync', {}, null, 'Fetch its keys again')}</div>` : ''}`;
  }

  // ── the settings form ────────────────────────────────────────────────────
  // What a station may be told to change from here: its name, whether it
  // sends, its RTL-SDR channel (shared, and each stick's own), sound, screen
  // and time zone. Sent as the smallest patch that says what changed, through
  // the same checks the station's own page uses.

  function formFrom(cfg, rx) {
    const sd = (cfg.receivers || {}).sdr || {};
    const f = {
      name: cfg.name || '', enabled: (cfg.meganet || {}).enabled !== false, receptions: (cfg.meganet || {}).receptions !== false,
      sdrOn: sd.enabled !== false, freq: sd.freqHz ? (sd.freqHz / 1e6).toFixed(4) : '', format: sd.format || 'BINARY',
      gain: sd.gainDb == null ? 'auto' : String(sd.gainDb), ppm: String(sd.ppm || 0), squelch: String(sd.squelchDb ?? 8), rate: String(sd.sampleRate || 0),
      audio: (cfg.audio || {}).enabled === false ? 'off' : ((cfg.audio || {}).mode || 'auto'), volume: String((cfg.audio || {}).volume ?? 80),
      kiosk: (cfg.kiosk || {}).mode || 'auto', tz: (cfg.system || {}).timezone || '',
    };
    const own = (cfg.receivers || {}).sdrDevices || [];
    for (const r of rx.filter(x => x.kind === 'sdr')) {
      const e = own.find(o => o.key === r.key) || {};
      f['s:' + r.key] = { name: e.name || '', freq: e.freqHz ? (e.freqHz / 1e6).toFixed(4) : '', format: e.format || '',
        gain: e.gainDb === undefined ? '' : e.gainDb === null ? 'auto' : String(e.gainDb), on: e.enabled !== false };
    }
    return f;
  }

  // JSON with every object's keys in order, so that the same settings
  // rebuilt in another order compare equal.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  // The form against the settings it was filled from → { patch, error }.
  function patchFrom(cfg, f, rx) {
    const p = {}, sd = (cfg.receivers || {}).sdr || {};
    const put = (path, v) => { const ks = path.split('.'); let o = p; ks.slice(0, -1).forEach(k => { o = o[k] = o[k] || {}; }); o[ks[ks.length - 1]] = v; };
    const num = (v, what, lo, hi) => { const n = Number(String(v).trim()); if (String(v).trim() === '' || !isFinite(n) || n < lo || n > hi) throw new Error(what); return n; };
    try {
      if (f.name.trim() !== (cfg.name || '')) put('name', f.name.trim());
      if (f.enabled !== ((cfg.meganet || {}).enabled !== false)) put('meganet.enabled', f.enabled);
      if (f.receptions !== ((cfg.meganet || {}).receptions !== false)) put('meganet.receptions', f.receptions);
      if (f.sdrOn !== (sd.enabled !== false)) put('receivers.sdr.enabled', f.sdrOn);
      const hz = Math.round(num(f.freq, 'the frequency is 24–1766 MHz', 24, 1766) * 1e6);
      if (hz !== sd.freqHz) put('receivers.sdr.freqHz', hz);
      if (f.format !== sd.format) put('receivers.sdr.format', f.format);
      const gain = /^(auto|agc)$/i.test(f.gain.trim()) ? null : num(f.gain, 'the gain is 0–60 dB, or auto', 0, 60);
      if (gain !== (sd.gainDb ?? null)) put('receivers.sdr.gainDb', gain);
      const ppm = num(f.ppm, 'the correction is -200…200 ppm', -200, 200);
      if (ppm !== (sd.ppm || 0)) put('receivers.sdr.ppm', ppm);
      const sq = num(f.squelch, 'the squelch is 2–40 dB', 2, 40);
      if (sq !== (sd.squelchDb ?? 8)) put('receivers.sdr.squelchDb', sq);
      if (Number(f.rate) !== (sd.sampleRate || 0)) put('receivers.sdr.sampleRate', Number(f.rate));
      // Each stick's own, as the station's page builds them: entries for
      // sticks not shown are kept; a blank field is the shared setting.
      const sticks = rx.filter(x => x.kind === 'sdr');
      if (sticks.length) {
        const keys = new Set(sticks.map(r => r.key));
        const listOut = (((cfg.receivers || {}).sdrDevices) || []).filter(e => !keys.has(e.key));
        for (const r of sticks) {
          const v = f['s:' + r.key] || {}, before = (((cfg.receivers || {}).sdrDevices) || []).find(e => e.key === r.key) || {};
          const e = Object.assign({}, before, { key: r.key });
          for (const k of ['name', 'freqHz', 'format', 'gainDb', 'enabled']) delete e[k];
          if (v.name && v.name.trim()) e.name = v.name.trim();
          if (v.freq && v.freq.trim()) e.freqHz = Math.round(num(v.freq, r.name + ': a frequency of 24–1766 MHz', 24, 1766) * 1e6);
          if (v.format) e.format = v.format;
          if (v.gain && v.gain.trim()) e.gainDb = /^(auto|agc)$/i.test(v.gain.trim()) ? null : num(v.gain, r.name + ': a gain of 0–60 dB, or auto', 0, 60);
          if (v.on === false) e.enabled = false;
          if (Object.keys(e).length > 1) listOut.push(e);
        }
        if (canon(listOut) !== canon(((cfg.receivers || {}).sdrDevices) || [])) put('receivers.sdrDevices', listOut);
      }
      const a = cfg.audio || {};
      const wasAudio = a.enabled === false ? 'off' : (a.mode || 'auto');
      if (f.audio !== wasAudio) { if (f.audio === 'off') put('audio.enabled', false); else { put('audio.enabled', true); put('audio.mode', f.audio); } }
      const vol = num(f.volume, 'the volume is 0–100', 0, 100);
      if (vol !== (a.volume ?? 80)) put('audio.volume', vol);
      if (f.kiosk !== ((cfg.kiosk || {}).mode || 'auto')) put('kiosk.mode', f.kiosk);
      if (f.tz.trim() !== ((cfg.system || {}).timezone || '')) put('system.timezone', f.tz.trim());
    } catch (e) { return { error: e.message }; }
    return { patch: p };
  }

  function settingsHtml(s) {
    const cfg = (s.status || {}).config;
    if (!canAsk(s)) return '';
    if (!cfg) return '<h3>Settings</h3><p class="small">Its settings arrive with its whole status — opening it asks for one.</p>';
    const rx = receiversOf(s);
    const sig = JSON.stringify(cfg);
    if (!form || form.id !== s.id || (!form.dirty && form.sig !== sig)) {
      // Filled again when the station's settings changed under an untouched
      // form — after a send, that is the station having made the changes, and
      // the requests below say so; the note about sending is done with.
      if (form && form.id === s.id) formNote = null;
      form = { id: s.id, sig, dirty: false, f: formFrom(cfg, rx) };
    }
    const f = form.f;
    const inp = (k, label, extra) => `<label>${label} <input type="text" id="bs-f-${k}" value="${esc(f[k])}" oninput="BaseStations.field('${k}', this.value)"${extra || ''}></label>`;
    const sel = (k, label, opts) => `<label>${label} <select id="bs-f-${k}" onchange="BaseStations.field('${k}', this.value)">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(f[k]) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
    const chk = (k, label) => `<label class="ser-check"><input type="checkbox" id="bs-f-${k}"${f[k] ? ' checked' : ''} onchange="BaseStations.field('${k}', this.checked)"> ${label}</label>`;
    const sticks = rx.filter(x => x.kind === 'sdr');
    return `<h3>Settings</h3>
      <p class="small">Sent to the station as one request, and changed there through the checks its own page uses. Never from here: its ingest token, where readings go, its web page's password, its SSH keys, or what it lets MegaNet do.</p>
      <div class="bs-form">
        ${inp('name', 'Name of the base station', ' maxlength="80"')}
        ${chk('enabled', 'Send readings to MegaNet')}
        ${chk('receptions', 'Send every frame heard (Reception Map)')}
      </div>
      <h4>RTL-SDR — every stick</h4>
      <div class="bs-form">
        ${chk('sdrOn', 'Use RTL-SDR sticks')}
        ${inp('freq', 'Frequency, MHz', ' inputmode="decimal"')}
        ${sel('format', 'Frame format', Object.entries(FORMATS))}
        ${inp('gain', 'Gain, dB (or auto)')}
        ${inp('ppm', 'Correction, ppm', ' inputmode="numeric"')}
        ${inp('squelch', 'Squelch, dB', ' inputmode="numeric"')}
        ${sel('rate', 'Sample rate', [['0', 'Automatic'], ['240000', '240 ksps'], ['960000', '960 ksps'], ['1200000', '1.2 Msps'], ['1920000', '1.92 Msps'], ['2400000', '2.4 Msps']])}
      </div>
      ${sticks.length ? `<h4>Each stick <span class="small qs-dim">(blank: as above)</span></h4>${sticks.map(r => {
        const v = f['s:' + r.key] || {};
        const k = escAttr(r.key);
        const more = Array.isArray(r.channels) && r.channels.length > 1 ? r.channels.length - 1 : 0;
        return `<fieldset class="bs-stick"><legend>${esc(r.name)} <span class="small qs-dim">${esc(r.usb_port ? 'USB port ' + r.usb_port : r.key)}</span></legend>
          ${more ? `<p class="small qs-dim">Its own channel below; ${more === 1 ? 'its other channel is' : 'its ' + more + ' other channels are'} set on the station.</p>` : ''}<div class="bs-form">
          <label>Name <input type="text" maxlength="60" value="${esc(v.name)}" placeholder="${esc(r.name)}" oninput="BaseStations.stick('${k}', 'name', this.value)"></label>
          <label>Frequency, MHz <input type="text" inputmode="decimal" value="${esc(v.freq)}" placeholder="${esc(f.freq)}" oninput="BaseStations.stick('${k}', 'freq', this.value)"></label>
          <label>Format <select onchange="BaseStations.stick('${k}', 'format', this.value)"><option value="">As above</option>${Object.entries(FORMATS).map(([fv, t]) => `<option value="${fv}"${v.format === fv ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label>Gain, dB <input type="text" value="${esc(v.gain)}" placeholder="${esc(f.gain)}" oninput="BaseStations.stick('${k}', 'gain', this.value)"></label>
          <label class="ser-check"><input type="checkbox"${v.on !== false ? ' checked' : ''} onchange="BaseStations.stick('${k}', 'on', this.checked)"> Use this stick</label>
        </div></fieldset>`;
      }).join('')}` : ''}
      <h4>Sound, screen and clock</h4>
      <div class="bs-form">
        ${sel('audio', 'Chirps', [['auto', 'Automatic'], ['live', 'Only an SDR\'s real audio'], ['synth', 'A re-made burst per reading'], ['beep', 'A beep per reading'], ['off', 'Off']])}
        ${inp('volume', 'Volume, 0–100', ' inputmode="numeric"')}
        ${sel('kiosk', 'Screen', [['auto', 'Dashboard on a connected monitor'], ['on', 'Always, when a monitor is connected'], ['off', 'Text console only']])}
        ${inp('tz', 'Time zone', ' placeholder="Australia/Brisbane"')}
      </div>
      <div class="button-group adm-actions">
        <button class="primary" onclick="BaseStations.saveSettings()">Send the changes</button>
        <button class="exp-btn-sm" onclick="BaseStations.resetForm()">Undo my changes</button>
        <span class="small ${formNote ? formNote.cls : ''}" id="bs-form-note">${formNote ? esc(formNote.text) : ''}</span>
      </div>`;
  }

  // ── requests ─────────────────────────────────────────────────────────────

  function statusOf(c) {
    if (c.status === 'sent' && c.sent_at && now() - Date.parse(c.sent_at) > 10 * 60000) return ['txt-warn', 'no answer'];
    return { queued: ['', 'waiting for it'], sent: ['', 'handed over'], done: ['txt-ok', 'done'], failed: ['txt-bad', 'not done'],
      expired: ['txt-warn', 'expired'], cancelled: ['qs-dim', 'cancelled'] }[c.status] || ['', c.status];
  }

  function resultText(c) {
    if (c.error) return c.error;
    const r = c.result;
    if (r == null) return '';
    if (typeof r === 'string') return r;
    if (c.verb === 'config.set' && r.changed) return r.changed.length ? 'changed ' + r.changed.join(', ') : 'nothing changed';
    if (c.verb === 'log' && r.lines) return r.lines.length + ' lines — shown below';
    if (r.message) return r.message;
    return JSON.stringify(r).slice(0, 200);
  }

  function requestsHtml() {
    const cmds = (detail && detail.commands) || [];
    if (!cmds.length) return '<h3>Asked from here</h3><p class="small">Nothing yet.</p>';
    return `<h3 id="bs-req-h">Asked from here</h3>
      <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="bs-req-h"><table class="adm-table bs-req">
        <caption class="sr-only">What was asked of this base station, by whom, and what became of it</caption>
        <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">State</th><th scope="col" class="bs-wide">Answer</th><th scope="col" class="bs-act"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${cmds.map(c => {
          const [cls, label] = statusOf(c);
          const what = (VERBS[c.verb] || c.verb) + (c.verb === 'config.set' && c.args && c.args.patch ? ' (' + Object.keys(flat(c.args.patch)).join(', ') + ')' : '');
          return `<tr><td class="small">${esc(ago(c.created_at))}<div class="qs-dim">${esc(c.created_by || '')}</div></td>
            <td class="small">${esc(what)}</td><td class="small"><span class="${cls}">${esc(label)}</span></td>
            <td class="small">${esc(resultText(c))}</td>
            <td class="adm-row-acts">${c.status === 'queued' ? `<button class="exp-btn-sm" onclick="BaseStations.cancel(${Number(c.id)})" aria-label="Cancel ${esc(VERBS[c.verb] || c.verb)}">Cancel</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
  }

  function flat(o, pre, out) {
    out = out || {};
    for (const [k, v] of Object.entries(o || {})) {
      const p = pre ? pre + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, p, out); else out[p] = v;
    }
    return out;
  }

  function logHtml(s) {
    if (!canAsk(s) && !logShown) return '';
    const lines = logShown && logShown.id === s.id ? logShown.lines : null;
    return `<h3>Log</h3>
      ${canAsk(s) ? `<div class="button-group adm-actions">${askBtn('log', { lines: 200 }, null, 'Show its last 200 lines')}</div>` : ''}
      ${lines ? `<pre class="bs-log" tabindex="0" aria-label="The base station's log">${esc(lines.map(l => new Date(l.t).toLocaleTimeString() + ' ' + String(l.level).toUpperCase().padEnd(5) + ' [' + l.tag + '] ' + l.msg).join('\n'))}</pre>` : ''}`;
  }

  function detailHtml() {
    const s = stationOf();
    if (!s) return '';
    return `<section class="panel bs-detail" aria-labelledby="bs-detail-h">
      ${headHtml(s)}
      ${detailErr ? `<p class="small txt-bad">${esc(detailErr)}</p>` : ''}
      ${askErr ? `<p class="small txt-bad">${esc(askErr)}</p>` : ''}
      ${actionsHtml(s)}
      ${s.managed ? `<div class="bs-cols"><div>${healthHtml(s)}</div><div>${uplinkHtml(s)}${softwareHtml(s)}</div></div>` : ''}
      ${receiversHtml(s)}
      ${s.managed ? accessHtml(s) : ''}
      <div id="bs-settings">${settingsHtml(s)}</div>
      <div id="bs-log">${logHtml(s)}</div>
      <div id="bs-requests">${s.managed ? requestsHtml() : ''}</div>
    </section>`;
  }

  // ── team keys ────────────────────────────────────────────────────────────

  function keysHtml() {
    const ks = (keys && keys.keys) || [];
    const live = ks.filter(k => !k.removed_at), gone = ks.filter(k => k.removed_at);
    return `<div class="panel">
      <div class="panel-header"><h2 id="bs-keys-h">Team SSH keys</h2></div>
      <p class="small">Every base station has a maintenance login, <code>alert</code>, with no password: SSH keys open it, one per person. These are the team's — <strong>public keys only</strong>; nothing here can open a station by itself. A station installs them only if its owner turned that on, and they work only from a private network (the site's LAN, a VPN). Take someone's key off when they move on: stations that take the list drop it within a minute, or an hour if they are not checking in.</p>
      ${keysErr ? `<p class="small txt-bad">${esc(keysErr)}</p>` : ''}
      ${keyMsg ? `<p class="small ${keyMsg.cls}">${esc(keyMsg.text)}</p>` : ''}
      <div class="adm-tok-form">
        <label>Whose key <input type="text" id="bs-key-owner" maxlength="120" value="${esc(keyForm.owner)}" oninput="BaseStations.keyField('owner', this.value)" placeholder="e.g. Jo Bloggs"></label>
        <label>Public key <input type="text" id="bs-key-text" value="${esc(keyForm.key)}" oninput="BaseStations.keyField('key', this.value)" placeholder="ssh-ed25519 AAAA… jo@laptop" spellcheck="false"></label>
        <button class="primary" onclick="BaseStations.addKey()">Add the key</button>
      </div>
      ${live.length ? `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-keys-h"><table class="adm-table bs-team">
        <caption class="sr-only">The team's SSH public keys</caption>
        <thead><tr><th scope="col">Whose</th><th scope="col" class="bs-wide">Fingerprint</th><th scope="col" class="col-optional">Added</th><th scope="col" class="bs-act"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${live.map(k => `<tr><th scope="row">${esc(k.owner)}${k.comment ? `<div class="small qs-dim">${esc(k.comment)}</div>` : ''}</th>
          <td class="small"><code>${esc(k.fingerprint)}</code> <span class="qs-dim">${esc(k.key_type)}</span></td>
          <td class="small col-optional">${esc(when(k.added_at))}<div class="qs-dim">${esc(k.added_by || '')}</div></td>
          <td class="adm-row-acts"><button class="exp-btn-sm adm-danger" onclick="BaseStations.removeKey(${Number(k.id)})" aria-label="Take ${esc(k.owner)}'s key off">Take off…</button></td></tr>`).join('')}</tbody>
      </table></div>` : `<p class="small">${keys ? 'No team keys yet.' : 'Loading…'}</p>`}
      ${gone.length ? `<details><summary class="small">Taken off in the last 90 days (${gone.length})</summary><ul class="small">${gone.map(k => `<li>${esc(k.owner)} <code>${esc(k.fingerprint.slice(0, 22))}…</code> — off ${esc(ago(k.removed_at))} by ${esc(k.removed_by || '?')}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }

  // ── the tab ──────────────────────────────────────────────────────────────

  function outsideHtml() {
    return `<div class="panel">
      <div class="panel-header"><h2>Base stations</h2></div>
      <p class="small">Every base station's health on one list — whether it is checking in, its receivers, its uplink, its power and temperature — and, for an administrator, asking one of them to change a setting, restart, install an update or show its log, without going to site.</p>
      <p class="small">A base station is never reached from here: it checks in with MegaNet about once a minute, and what is asked waits for that. It can only be asked for a short list of things, never its token or its passwords, and its owner can turn this off on the station itself.</p>
      ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? '<p class="small">This needs an administrator.</p>'
        : '<div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>'}
    </div>`;
  }

  function msgHtml() {
    return (note ? `<p class="small">${esc(note)}</p>` : '')
      + (error ? `<p class="small txt-bad">${esc(error)}</p>` : '')
      + (loading && !list ? '<p class="small">Loading…</p>' : '');
  }

  function render() {
    const body = !isAdmin() ? outsideHtml() : `
      <div class="panel">
        <div class="panel-header"><h2 id="bs-list-h">Base stations</h2>
          <button class="exp-btn-sm" onclick="BaseStations.load()">Refresh</button></div>
        <div id="bs-kpis">${list ? kpisHtml() : ''}</div>
        <div id="bs-msg">${msgHtml()}</div>
        <div id="bs-list">${list ? listHtml() : ''}</div>
      </div>
      <div id="bs-detail">${detailHtml()}</div>
      <div id="bs-keys">${keysHtml()}</div>
      <div class="panel">
        <div class="panel-header"><h2>How a base station is reached</h2></div>
        <p class="small">It is not: it checks in. About once a minute each base station sends MegaNet a heartbeat — and its whole status when something changed — and collects what was asked of it here, which it does and answers at its next check-in. Opening one makes it check in every five seconds for the next three minutes. It can be asked only for the things above; never its token, where it sends readings, its passwords or SSH keys, or how much it lets MegaNet do — that is set on the station, which can also refuse everything (report only) or stop checking in.</p>
        <div class="button-group adm-actions">
          <a class="pill" href="${esc(docUrl('docs/base-stations.md'))}" target="_blank" rel="noopener">How it works</a>
          <button class="pill" onclick="switchTab('admin')">🛠️ Ingest tokens (Admin)</button>
        </div>
      </div>`;
    return `<div class="page" style="--page-max:1200px"><h2 class="sr-only">Base Stations</h2><div class="stack">${body}</div></div>`;
  }

  function repaint() {
    if (state.activeTab !== 'basestations') return;
    const el = document.getElementById('main-content');
    if (!el) return;
    // Typing in either form survives: it is mirrored, and focus is put back.
    keepFocus(el, () => { el.innerHTML = render(); });
  }

  // A repaint must not take the keyboard's place away. Whatever had focus is
  // found again afterwards: by its id, or else by what it does and says — the
  // same button in the new markup, since a poll's repaint changes ages and
  // states, not which buttons there are.
  function focusKey(el) {
    if (el.id) return '#' + el.id;
    return [el.tagName, el.getAttribute('onclick'), el.dataset.verb, el.dataset.args,
      el.getAttribute('aria-label'), el.getAttribute('aria-labelledby'), el.textContent.trim()].join('|');
  }
  function keepFocus(root, paint) {
    const a = document.activeElement;
    const key = a && a !== document.body && root.contains(a) ? focusKey(a) : null;
    paint();
    if (!key || (document.activeElement && document.activeElement !== document.body)) return;
    const back = key[0] === '#' ? document.getElementById(key.slice(1))
      : [...root.querySelectorAll('button, a, input, select, textarea, [tabindex]')].find(e => focusKey(e) === key);
    if (back) back.focus({ preventScroll: true });
  }

  // A poll repaints only what moves — not the forms anybody is typing in.
  function repaintLive() {
    if (state.activeTab !== 'basestations') return;
    const set = (id, html) => { const el = document.getElementById(id); if (el && el.innerHTML !== html) keepFocus(el, () => { el.innerHTML = html; }); };
    set('bs-kpis', list ? kpisHtml() : '');
    set('bs-msg', msgHtml());
    set('bs-list', list ? listHtml() : '');
    const d = document.getElementById('bs-detail');
    if (!d) return;
    const s = stationOf();
    if (!s) { set('bs-detail', ''); return; }
    if (!d.firstElementChild) { d.innerHTML = detailHtml(); return; }
    // The whole panel but the settings form, unless its station's settings
    // changed under a form nobody has touched.
    const keep = document.getElementById('bs-settings');
    const typing = form && form.dirty;
    const html = detailHtml();
    if (!typing) { if (d.innerHTML !== html) keepFocus(d, () => { d.innerHTML = html; }); return; }
    // Moving the form out and back blurs whatever is focused in it, so the
    // move is inside keepFocus too.
    keepFocus(d, () => {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const fresh = tmp.querySelector('#bs-settings');
      if (fresh && keep) fresh.replaceWith(keep);
      d.replaceChildren(...tmp.childNodes);
    });
  }

  // ── loading, polling ─────────────────────────────────────────────────────

  async function load() {
    if (!isAdmin()) { repaint(); return; }
    loading = true;
    if (!list) repaint();
    try {
      const r = await dbRpc('admin_base_stations', {});
      setNow(r.now);
      list = r;
      error = null;
    } catch (err) {
      error = err.status === 404 ? 'The database does not have this yet — apply db/migrations/0049_base_stations.sql.'
        : 'Could not load the base stations: ' + err.message;
    }
    loading = false;
    repaintLive();
    if (!document.getElementById('bs-list')) repaint();
  }

  async function loadDetail() {
    if (!isAdmin() || openId == null) return;
    const id = openId;
    try {
      const r = await dbRpc('admin_base_station', { p_id: id });
      if (openId !== id) return;
      setNow(r.now);
      detail = r;
      detailErr = null;
      // A log asked for and answered: shown until the panel closes.
      const log = (r.commands || []).find(c => c.verb === 'log' && c.status === 'done' && c.result && Array.isArray(c.result.lines));
      if (log && (!logShown || logShown.cmd !== log.id)) logShown = { id, cmd: log.id, lines: log.result.lines };
      // Keep the list's row in step with what the panel knows.
      if (list) list.stations = list.stations.map(s => s.id === id ? Object.assign({}, s, r.station, { status: s.status && r.station.status ? Object.assign({}, r.station.status) : r.station.status }) : s);
    } catch (err) {
      detailErr = 'Could not load it: ' + err.message;
    }
    repaintLive();
    scheduleDetail();
  }

  // While a request is on its way, every three seconds; otherwise every fifteen.
  function scheduleDetail() {
    clearTimeout(timers.detail);
    if (openId == null) return;
    const busy = (detail && (detail.commands || []).some(c => c.status === 'queued' || (c.status === 'sent' && now() - Date.parse(c.sent_at) < 600000)))
      || Date.now() - lastAsk < 30000;
    timers.detail = setTimeout(() => { if (!document.hidden && state.activeTab === 'basestations') loadDetail(); else scheduleDetail(); }, busy ? BUSY_MS : IDLE_MS);
  }

  async function watch(withStatus) {
    if (openId == null) return;
    try { await dbRpc('admin_base_station_watch', { p_id: openId, p_status: !!withStatus }); } catch (_) { /* a station that never checked in: nothing to watch */ }
  }

  async function loadKeys() {
    if (!isAdmin()) return;
    try { keys = await dbRpc('admin_base_station_keys', {}); keysErr = null; }
    catch (err) { keysErr = err.status === 404 ? '' : 'Could not load the team keys: ' + err.message; }
    const el = document.getElementById('bs-keys');
    if (el && state.activeTab === 'basestations') keepFocus(el, () => { el.innerHTML = keysHtml(); });
  }

  function stop() {
    clearInterval(timers.list); clearTimeout(timers.detail); clearInterval(timers.watch);
    timers.list = timers.detail = timers.watch = null;
  }

  function init() {
    if (!isAdmin()) return;
    stop();
    load();
    loadKeys();
    timers.list = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') load(); }, LIST_MS);
    if (openId != null) { loadDetail(); timers.watch = setInterval(() => { if (!document.hidden) watch(false); }, WATCH_MS); }
    if (typeof registerTabTeardown === 'function') registerTabTeardown('base-stations', stop);
  }

  // ── what an administrator does ───────────────────────────────────────────

  function open(id) {
    if (openId === id) { close(); return; }
    openId = id; detail = null; detailErr = null; askErr = null; form = null; formNote = null; logShown = null;
    clearInterval(timers.watch);
    repaint();
    document.getElementById('bs-detail-h')?.scrollIntoView({ block: 'start' });
    const s = stationOf();
    if (s && s.managed && s.mode !== 'off') {
      watch(true);
      timers.watch = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') watch(false); }, WATCH_MS);
    }
    loadDetail();
    announce('Opened ' + (s ? s.label : 'the base station') + '.');
  }

  function close() {
    openId = null; detail = null; askErr = null; form = null; formNote = null; logShown = null;
    clearInterval(timers.watch); clearTimeout(timers.detail);
    repaint();
  }

  async function ask(verb, args, confirmText) {
    const s = stationOf();
    if (!s) return;
    if (confirmText && !confirm(confirmText)) return;
    try {
      await dbRpc('admin_base_station_command', { p_id: s.id, p_verb: verb, p_args: args || {} });
      lastAsk = Date.now();
      askErr = null;
      announce('Asked ' + s.label + ' to ' + (VERBS[verb] || verb) + '. It does it at its next check-in.');
    } catch (err) {
      askErr = 'Not asked: ' + err.message;
      announce(askErr);
    }
    loadDetail();
  }

  function askFrom(btn) {
    let args = {};
    try { args = JSON.parse(btn.dataset.args || '{}'); } catch (_) { return; }
    ask(btn.dataset.verb, args, btn.dataset.confirm || null);
  }

  async function cancel(cmdId) {
    try { await dbRpc('admin_base_station_cancel', { p_command_id: cmdId }); askErr = null; announce('Cancelled.'); }
    catch (err) { askErr = 'Could not cancel: ' + err.message; announce(askErr); }
    loadDetail();
  }

  function field(k, v) { if (!form) return; form.f[k] = v; form.dirty = true; }
  function stick(key, k, v) { if (!form) return; const e = form.f['s:' + key] = form.f['s:' + key] || {}; e[k] = v; form.dirty = true; }
  function resetForm() { form = null; formNote = null; repaint(); }

  function setFormNote(text, cls) {
    formNote = text ? { text, cls: cls || '' } : null;
    const out = document.getElementById('bs-form-note');
    if (out) { out.textContent = text || ''; out.className = 'small ' + (cls || ''); }
    if (text) announce(text);
  }

  async function saveSettings() {
    const s = stationOf(), cfg = s && s.status && s.status.config;
    if (!cfg || !form) return;
    const { patch, error: why } = patchFrom(cfg, form.f, receiversOf(s));
    if (why) { setFormNote('Not sent: ' + why + '.', 'txt-bad'); return; }
    const n = Object.keys(flat(patch)).length;
    if (!n) { setFormNote('Nothing has changed.'); return; }
    try {
      await dbRpc('admin_base_station_command', { p_id: s.id, p_verb: 'config.set', p_args: { patch } });
      lastAsk = Date.now();
      // What was typed stays on screen until the station's settings change
      // under it — which they do when its next whole status arrives — and then
      // the form is filled from what the station now has.
      form.dirty = false;
      setFormNote('Sent ' + n + ' change' + (n === 1 ? '' : 's') + ' to ' + s.label + ' — it makes them at its next check-in.', 'txt-ok');
    } catch (err) {
      setFormNote('Not sent: ' + err.message, 'txt-bad');
    }
    loadDetail();
  }

  function keyField(k, v) { keyForm[k] = v; }

  function setKeyMsg(text, cls) {
    keyMsg = { text, cls };
    announce(text);
    const el = document.getElementById('bs-keys');
    if (el && state.activeTab === 'basestations') keepFocus(el, () => { el.innerHTML = keysHtml(); });
  }

  async function addKey() {
    if (!keyForm.owner.trim() || !keyForm.key.trim()) { setKeyMsg('Say whose key it is, and paste the whole public key line.', 'txt-bad'); return; }
    try {
      const r = await dbRpc('admin_base_station_key_add', { p_public_key: keyForm.key.trim(), p_owner: keyForm.owner.trim() });
      keyForm = { owner: '', key: '' };
      setKeyMsg('Added ' + r.owner + '\'s key, ' + r.fingerprint + '.', 'txt-ok');
    } catch (err) { setKeyMsg('Not added: ' + err.message, 'txt-bad'); }
    loadKeys();
  }

  async function removeKey(id) {
    const k = ((keys && keys.keys) || []).find(x => x.id === id);
    if (!k) return;
    if (!confirm('Take ' + k.owner + '\'s key off the list?\n\n' + k.fingerprint + '\n\nBase stations that take the team keys drop it at their next fetch — within a minute for one checking in.')) return;
    try { await dbRpc('admin_base_station_key_remove', { p_id: id }); setKeyMsg('Took ' + k.owner + '\'s key off.', 'txt-ok'); }
    catch (err) { setKeyMsg('Not taken off: ' + err.message, 'txt-bad'); }
    loadKeys();
  }

  // A sign-in or sign-out: everything held was the last session's.
  function authChanged() {
    list = null; error = null; detail = null; openId = null; askErr = null; keys = null; keysErr = null; keyMsg = null; form = null; formNote = null; logShown = null; note = '';
    stop();
    if (state.activeTab === 'basestations') { repaint(); init(); }
  }

  return { render, init, load, open, close, ask, askFrom, cancel, field, stick, resetForm, saveSettings,
           keyField, addKey, removeKey, authChanged,
           // Pure, for test/basestations.mjs.
           _liveness: liveness, _flags: flags, _patchFrom: patchFrom, _formFrom: formFrom };
})();

if (typeof window !== 'undefined') window.BaseStations = BaseStations;
