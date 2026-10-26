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
  const timers = { list: null, detail: null, watch: null, wf: null, ch: null };
  let lastAsk = 0;
  // The newest RPi ALERT release, as GitHub says: what a station's "Install the
  // latest release" and its nightly timer fetch (rpi-alert-update asks the same
  // URL). { version, url }, or { version: null } when GitHub could not be asked;
  // null is "not asked yet". Asked every five minutes while the tab is open, so
  // a new release shows within minutes of going out — 12 an hour, well inside
  // the 60 an hour GitHub answers per address without a token — and again in
  // ten minutes after a miss.
  let latest = null, latestAt = 0;
  const RELEASE_URL = 'https://api.github.com/repos/cdomotor-g/RPi_ALERT/releases/latest';
  const LATEST_MS = 300000, LATEST_RETRY_MS = 600000;

  const LIST_MS = 30000, BUSY_MS = 3000, IDLE_MS = 15000, WATCH_MS = 60000;
  const FORMATS = { BINARY: 'ALERT Binary', ENHANCED_IFLOWS: 'Enhanced iFLOWS', ASCII: 'ALERT ASCII' };
  // A stick's window — its sample rate — as RPi ALERT 0.15 takes them (its
  // web/sdr-plan.js RATES): the slice of the band it hears, and its cost, since
  // each channel's decoder works through the whole of it. Set here, exactly
  // that one; automatic, the narrowest that holds the stick's channels.
  const WINDOWS = [['240000', '240 kHz — the lightest'], ['960000', '960 kHz'], ['1200000', '1.2 MHz'], ['1440000', '1.44 MHz'], ['1920000', '1.92 MHz'], ['2400000', '2.4 MHz']];
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

  // ── versions ─────────────────────────────────────────────────────────────

  // -1, 0 or 1, ordered as rpi-alert-update's `sort -V` orders them: each part
  // as a number, so 0.10.0 comes after 0.9.0. A leading "v" is not part of it.
  function cmpVersion(a, b) {
    const parts = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // Is a station that checks in behind the latest release?
  function behind(s) { return !!(s.managed && s.version && latest && latest.version && cmpVersion(s.version, latest.version) < 0); }

  // A station's version with the latest release beside it: amber when the
  // station is behind it, quiet when level with it or ahead (installed from main).
  function versionHtml(v) {
    if (!v) return '—';
    if (!latest || !latest.version) return esc(v);
    const c = cmpVersion(v, latest.version);
    const rel = latest.url ? `<a href="${esc(latest.url)}" target="_blank" rel="noopener">${esc(latest.version)}</a>` : esc(latest.version);
    return esc(v) + (c < 0 ? ` · <span class="txt-warn">latest release ${rel}</span>`
      : ` <span class="qs-dim">· latest release ${rel}${c > 0 ? ' (this is newer)' : ''}</span>`);
  }

  // ── what a station's state is ────────────────────────────────────────────

  // online · quiet · offline · off · not managed — from when it last checked in,
  // against how often it says it checks in. The database says which since 0059
  // (meganet.base_station_state(), `state` on each station): the same
  // definition its health findings are opened on, so this tab and an alert
  // cannot disagree. Worked out here only from a database without it.
  const STATES = {
    unmanaged: { k: 'unmanaged', label: 'not managed', cls: 'txt-muted' },
    off:       { k: 'off', label: 'turned off on the station', cls: 'txt-muted' },
    online:    { k: 'online', label: 'online', cls: 'txt-ok' },
    quiet:     { k: 'quiet', label: 'quiet', cls: 'txt-warn' },
    offline:   { k: 'offline', label: 'offline', cls: 'txt-bad' },
  };
  function liveness(s) {
    if (s.state && STATES[s.state]) return STATES[s.state];
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
    // What only the database can know: a receiver whose count of decoded
    // frames has not moved for hours, running or not (0059).
    deafOf(s).forEach(f => out.push([f.severity === 'critical' ? 'txt-bad' : 'txt-warn', deafText(f)]));
    return out;
  }

  // The open receiver-deaf findings on a station, and one for a receiver.
  function deafOf(s) { return (s.findings || []).filter(f => f.kind === 'receiver-deaf'); }
  function deafFor(s, key) { return deafOf(s).find(f => f.rx_key === String(key).slice(-80)) || null; }
  function deafText(f) {
    const ev = f.evidence || {};
    const since = Date.parse(ev.changed_at);
    return (ev.name || f.rx_key) + ' has decoded nothing for ' + (isFinite(since) ? span((now() - since) / 1000) : 'hours');
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
              <td class="small col-optional">${s.version ? esc(s.version) : '—'}${behind(s) ? `<div class="txt-warn">${esc(latest.version)} is out</div>` : ''}</td>
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
          <td class="small">${r.decoded != null ? esc(r.decoded) + ' decoded' : ''}${r.dataAgoS != null ? `<div class="qs-dim">data ${esc(span(r.dataAgoS).replace(/^0 min$/, 'just now'))}</div>` : ''}${deafFor(s, r.key) ? `<div class="${deafFor(s, r.key).severity === 'critical' ? 'txt-bad' : 'txt-warn'}">nothing new for ${esc(span((now() - Date.parse((deafFor(s, r.key).evidence || {}).changed_at)) / 1000))}</div>` : ''}</td>
          <td class="adm-row-acts">${!ask ? '' : r.state === 'unplugged'
            ? askBtn('device.forget', { key: r.key }, 'Remove ' + r.name + '? The station forgets it — its name, its own settings and its Flood-Net receiver id.', 'Remove…', 'exp-btn-sm adm-danger', 'Remove ' + r.name)
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

  // The station's last update run. One that found nothing to install says only
  // when: its message names the release it saw then ("RPi ALERT 0.9.0 is the
  // latest release."), which is out of date once a newer one is out — the
  // latest release beside the version above is GitHub's, asked just now.
  function lastInstall(u) {
    const l = u && u.last;
    if (!l) return 'no install from here yet';
    if (l.state === 'current') return 'nothing newer when it checked ' + ago(l.at * 1000);
    return `${l.state} ${ago(l.at * 1000)}: ${l.message || ''}`;
  }

  function softwareHtml(s) {
    const u = (s.status || {}).update || {};
    const last = esc(lastInstall(u));
    const ask = canAsk(s) && u.available !== false;
    return `<h3>Software</h3>
      <dl class="adm-dl"><dt>Version</dt><dd>${versionHtml(s.version)}</dd>
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
      const e = stickEntry(own, r) || {};
      f['s:' + r.key] = { name: e.name || '', freq: e.freqHz ? (e.freqHz / 1e6).toFixed(4) : '', format: e.format || '',
        gain: e.gainDb === undefined ? '' : e.gainDb === null ? 'auto' : String(e.gainDb), rate: e.sampleRate === undefined ? '' : String(e.sampleRate), on: e.enabled !== false };
    }
    return f;
  }

  // A stick's own settings as the station finds them (RPi ALERT's sdr.js
  // own()): its entry by key — or, as RPi ALERT 0.4 wrote them, by its serial
  // alone, shared by every stick with that serial.
  function stickEntry(list, r) {
    return list.find(e => e.key === r.key) || (r.serial ? list.find(e => !e.key && e.serial && e.serial === r.serial) : null) || null;
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
          const list = ((cfg.receivers || {}).sdrDevices) || [];
          const v = f['s:' + r.key] || {}, before = stickEntry(list, r) || {};
          // A stick held by a 0.4 entry by serial gets one of its own by key
          // when something of it changes, carrying the rest — its correction
          // above all — over: an entry by key without them would hide them.
          const bySerial = !before.key && !!before.serial;
          const e = Object.assign({}, before, { key: r.key });
          delete e.serial;
          const was = JSON.stringify(Object.keys(e).sort().map(k => [k, e[k]]));
          for (const k of ['name', 'freqHz', 'format', 'gainDb', 'sampleRate', 'enabled']) delete e[k];
          if (v.name && v.name.trim()) e.name = v.name.trim();
          if (v.freq && v.freq.trim()) e.freqHz = Math.round(num(v.freq, r.name + ': a frequency of 24–1766 MHz', 24, 1766) * 1e6);
          if (v.format) e.format = v.format;
          if (v.gain && v.gain.trim()) e.gainDb = /^(auto|agc)$/i.test(v.gain.trim()) ? null : num(v.gain, r.name + ': a gain of 0–60 dB, or auto', 0, 60);
          if (v.rate !== undefined && v.rate !== '') e.sampleRate = Number(v.rate);
          if (v.on === false) e.enabled = false;
          if (bySerial && JSON.stringify(Object.keys(e).sort().map(k => [k, e[k]])) === was) continue;
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
      <p class="small">Sent to the station as one request, and changed there through the checks its own page uses. Never from here: its ingest token, where readings go, its web page's password, its SSH keys, or what it lets Flood-Net do.</p>
      <div class="bs-form">
        ${inp('name', 'Name of the base station', ' maxlength="80"')}
        ${chk('enabled', 'Send readings to Flood-Net')}
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
        ${sel('rate', 'Window', [['0', 'Automatic — the narrowest that holds the channels']].concat(WINDOWS))}
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
          <label>Window <select onchange="BaseStations.stick('${k}', 'rate', this.value)"><option value="">As above</option>${[['0', 'Automatic']].concat(WINDOWS).map(([wv, t]) => `<option value="${wv}"${v.rate === wv ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
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

  // ── what its radios hear (0068) ──────────────────────────────────────────
  // Each SDR stick sends a spectrum row with every check-in: the strongest
  // each slice of its band was since the one before, in half-dB steps over
  // the row's own floor (RPi ALERT 0.13.5). admin_base_station_spectrum()
  // folds the rows into at most 360 slices of the window asked for, and adds
  // the bursts the station heard in each slice. Stacked, newest at the top,
  // they are a waterfall — behind by a check-in, and coarse, but asking
  // nothing of the station it does not send anyway. Drawn in a container of
  // its own (#bs-wf), outside the panel a poll repaints, and polled while the
  // station is open: the last few minutes again each time, since receptions
  // can arrive a little after the row they belong beside.
  //
  // A stick's outer tenth either side is the edge of its window: the RTL2832U's
  // filter rolls off there and a signal just past one edge folds back in at
  // the other, so the station keeps its channels out of it (RPi ALERT's
  // sdr-plan.js USABLE). Its edge fills only what no stick hears in its
  // middle, darkened and hatched — at 18 Bateson (October 2026), 151.575 just
  // past the top of a 240 kHz window showed as "packets" on 151.337.

  const WF_HOURS = [1, 6, 24];
  const WF_MS = 15000;
  const WF_CSS_H = 380, WF_LEFT = 52, WF_TOP = 34;  // CSS px: times to the left, channel labels above
  const WF_RANGE_DB = 40;                           // the palette's top, over each row's floor
  const WF_USABLE = 0.8;                            // a stick's middle, of its window: the rest is its edge
  // A stick each: SerialViz.colors()'s key, and the token its swatch uses.
  const WF_TONES = [['accent', 'bs-sw-1'], ['ident', 'bs-sw-2'], ['crc', 'bs-sw-3'], ['data', 'bs-sw-4']];
  // { id, hours, bucket, rows: [{ t, key, center_hz, rate, floor_db, span_s, n, v: Uint8Array }],
  //   bursts: [[t, freq_mhz, bursts, decoded, alert2, snr]], err, v }
  let wf = null, wfHours = 1, wfBusy = false, wfImg = null, wfResize = false;
  let wfHoverAt = null;   // { x, y } under the pointer, for the line down the picture

  const mhz = hz => (hz / 1e6).toFixed(4).replace(/0{1,2}$/, '');
  const hhmm = (sec, secs) => SerialViz.hhmm(sec * 1000, secs);

  // The open station's sticks: each with its colour, its last row's span and
  // its channels — the status's SDR receivers, and any stick a row names that
  // the status does not.
  function wfSticks(s) {
    const rx = receiversOf(s).filter(r => r.kind === 'sdr');
    const latest = new Map();
    for (const r of (wf && wf.id === s.id && wf.rows) || []) { const l = latest.get(r.key); if (!l || r.t >= l.t) latest.set(r.key, r); }
    const keys = [...new Set(rx.map(r => String(r.key).slice(-80)).concat([...latest.keys()]))];
    const col = SerialViz.colors();
    return keys.map((key, i) => {
      const r = rx.find(x => String(x.key).slice(-80) === key) || null, row = latest.get(key) || null;
      const chans = !r ? [] : Array.isArray(r.channels) && r.channels.length ? r.channels.map(c => ({ hz: c.freq_hz, format: c.format }))
        : r.freq_hz ? [{ hz: r.freq_hz, format: r.format }] : [];
      const tone = WF_TONES[i % WF_TONES.length];
      return { key, name: r ? r.name : key, color: col[tone[0]], sw: tone[1], chans,
        lo: row ? row.center_hz - row.rate / 2 : null, hi: row ? row.center_hz + row.rate / 2 : null };
    });
  }

  // The frequencies and times the picture spans, in CSS pixels.
  function wfGeom(cv, sticks) {
    const spans = sticks.filter(k => k.lo != null);
    if (!spans.length || !wf) return null;
    const lo = Math.min(...spans.map(k => k.lo)), hi = Math.max(...spans.map(k => k.hi));
    const w = cv.clientWidth || 600, bottom = 18 + 4 * spans.length;
    const n = Math.round(wf.hours * 3600 / wf.bucket);
    return { lo, hi, gx: WF_LEFT, gy: WF_TOP, pw: w - WF_LEFT - 8, ph: WF_CSS_H - WF_TOP - bottom, n, bucket: wf.bucket,
      top: Math.floor(now() / 1000 / wf.bucket) * wf.bucket, spans };
  }

  // The rows as a picture, a pixel row a slice: each column the strongest any
  // stick's bins in it were — in the middle of its window, or where no stick's
  // middle reaches, at an edge (then darkened and hatched, on a layer of its
  // own). A row covers the time back to the one before it (a minute,
  // normally), so it fills the slices below it that no row of its own stick
  // fills. Kept until the rows or the width change.
  function wfPicture(g, cols) {
    const sig = wf.v + ':' + cols + ':' + g.top + ':' + g.lo + ':' + g.hi;
    if (wfImg && wfImg.sig === sig) return wfImg;
    const W = cols, H = g.n, cell = new Int16Array(W * H).fill(-1), edge = new Int16Array(W * H).fill(-1), owner = new Map();
    const rows = wf.rows.slice().sort((a, b) => b.t - a.t);
    const paint = (r, k) => {
      const len = r.v.length, f0 = r.center_hz - r.rate / 2, step = r.rate / len, sc = W / (g.hi - g.lo), mid = WF_USABLE * r.rate / 2;
      for (let i = 0; i < len; i++) {
        const x0 = Math.max(0, Math.floor((f0 + i * step - g.lo) * sc)), x1 = Math.min(W, Math.max(x0 + 1, Math.floor((f0 + (i + 1) * step - g.lo) * sc)));
        const into = Math.abs(f0 + (i + 0.5) * step - r.center_hz) <= mid ? cell : edge;
        for (let x = x0; x < x1; x++) if (r.v[i] > into[k * W + x]) into[k * W + x] = r.v[i];
      }
      owner.set(r.key + ':' + k, r);
    };
    for (const r of rows) { const k = (g.top - r.t) / g.bucket; if (k >= 0 && k < H) paint(r, k); }
    for (const r of rows) {
      const k = (g.top - r.t) / g.bucket, back = Math.min(H, Math.ceil(r.span_s / Math.max(1, r.n) / g.bucket) + k);
      for (let kk = Math.max(0, k + 1); kk < back; kk++) if (!owner.has(r.key + ':' + kk)) paint(r, kk);
    }
    const c = document.createElement('canvas'), m = document.createElement('canvas');
    c.width = m.width = W; c.height = m.height = H;
    const x = c.getContext('2d'), img = x.createImageData(W, H), px = new Uint32Array(img.data.buffer), lut = SerialViz.heat();
    const mx = m.getContext('2d'), shade = mx.createImageData(W, H), sd = shade.data;
    let edges = 0;
    for (let i = 0; i < cell.length; i++) {
      const v = cell[i] >= 0 ? cell[i] : edge[i];
      if (v < 0) continue;
      px[i] = lut[Math.min(255, Math.round(v / 2 / WF_RANGE_DB * 255))];
      if (cell[i] >= 0) continue;
      // Hatched every 7 CSS pixels, whatever the picture's size.
      const col = i % W, line = ((col * g.pw / W + (i - col) / W * g.ph / H) % 7) < 1.2;
      sd[i * 4] = sd[i * 4 + 1] = sd[i * 4 + 2] = line ? 255 : 0; sd[i * 4 + 3] = line ? 60 : 115;
      edges++;
    }
    x.putImageData(img, 0, 0);
    if (edges) mx.putImageData(shade, 0, 0);
    wfImg = { sig, canvas: c, edges: edges ? m : null, owner };
    return wfImg;
  }

  // Channel labels staggered over two lines where they would touch.
  function wfLabels(ctx, g, sticks, X) {
    const ends = [-1e9, -1e9];
    const chans = [].concat(...sticks.map(k => k.chans.filter(c => c.hz >= g.lo && c.hz <= g.hi).map(c => ({ c, k })))).sort((a, b) => a.c.hz - b.c.hz);
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (const { c, k } of chans) {
      const x = X(c.hz), t = mhz(c.hz), tw = ctx.measureText(t).width;
      const lvl = x - tw / 2 > ends[0] + 4 ? 0 : x - tw / 2 > ends[1] + 4 ? 1 : 0;
      ends[lvl] = x + tw / 2;
      ctx.fillStyle = k.color;
      ctx.fillText(t, x, 12 + lvl * 11);
      ctx.fillRect(Math.round(x) - 0.5, g.gy - 7, 1, 7);
    }
  }

  function drawWf() {
    const cv = document.getElementById('bs-wf-c');
    const s = stationOf();
    if (!cv || !s || !wf || wf.id !== s.id) return;
    const f = SerialViz.fit(cv, WF_CSS_H);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sticks = wfSticks(s), g = wfGeom(cv, sticks);
    if (!g) {
      ctx.fillStyle = col.muted; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(wf.err ? 'Nothing to draw.' : 'No spectrum rows from this station in the window yet.', w / dpr / 2, WF_CSS_H / 2);
      cv.setAttribute('aria-label', 'Waterfall: no spectrum rows from this station in the window yet.');
      return;
    }
    const X = hz => g.gx + (hz - g.lo) / (g.hi - g.lo) * g.pw, rowH = g.ph / g.n;
    // Where no stick reaches, and slices nothing covers: the panel's own ground.
    ctx.fillStyle = col.subtle; ctx.fillRect(g.gx, g.gy, g.pw, g.ph);
    const pic = wfPicture(g, Math.max(64, Math.min(1024, Math.round(g.pw * dpr))));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pic.canvas, g.gx, g.gy, g.pw, g.ph);
    if (pic.edges) ctx.drawImage(pic.edges, g.gx, g.gy, g.pw, g.ph);
    // Times down the left: every quarter hour, hour or four hours.
    const every = wf.hours <= 1 ? 900 : wf.hours <= 6 ? 3600 : 14400;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = col.muted; ctx.fillText('now', g.gx - 6, g.gy + 5);
    for (let t = Math.floor((g.top + g.bucket) / every) * every; t > g.top + g.bucket - wf.hours * 3600; t -= every) {
      const y = g.gy + (g.top + g.bucket - t) / g.bucket * rowH;
      if (y < g.gy + 14 || y > g.gy + g.ph - 4) continue;
      ctx.fillStyle = SerialViz.alpha(col.border, 0.3); ctx.fillRect(g.gx, Math.round(y), g.pw, 1);
      ctx.fillStyle = col.muted; ctx.fillText(hhmm(t), g.gx - 6, y);
    }
    // The bursts it heard, on their channels: decoded, and not.
    for (const b of wf.bursts) {
      const hz = b[1] * 1e6;
      if (hz < g.lo || hz > g.hi) continue;
      const k = (g.top - b[0]) / g.bucket;
      if (k < 0 || k >= g.n) continue;
      ctx.fillStyle = b[3] > 0 ? col.ok : col.bad;
      ctx.fillRect(X(hz) - 4, g.gy + k * rowH, 8, Math.max(2, rowH));
    }
    wfLabels(ctx, g, sticks, X);
    // Frequencies along the bottom, and each stick's span under them in its colour.
    const width = g.hi - g.lo, step = width <= 1.6e6 ? 1e5 : width <= 4e6 ? 2.5e5 : 5e5;
    ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let hz = Math.ceil(g.lo / step) * step; hz <= g.hi; hz += step) {
      const x = X(hz);
      if (x < g.gx + 20 || x > g.gx + g.pw - 20) continue;
      ctx.fillRect(Math.round(x) - 0.5, g.gy + g.ph, 1, 3);
      ctx.fillText((hz / 1e6).toFixed(step < 1e5 ? 3 : 2), x, g.gy + g.ph + 4);
    }
    g.spans.forEach((k, i) => { ctx.fillStyle = k.color; ctx.fillRect(X(k.lo), g.gy + g.ph + 17 + i * 4, X(k.hi) - X(k.lo), 3); });
    if (wfHoverAt) wfCross(ctx, g, col);
    const n = wf.bursts.reduce((a, b) => a + b[2], 0), d = wf.bursts.reduce((a, b) => a + b[3], 0);
    cv.setAttribute('aria-label', `Waterfall of the last ${wf.hours} h, ${mhz(g.lo)}–${mhz(g.hi)} MHz from ${g.spans.length} stick${g.spans.length === 1 ? '' : 's'}, newest at the top: ${n} burst${n === 1 ? '' : 's'} heard, ${d} decoded.`);
  }

  // Where the pointer is: a line down the picture.
  function wfCross(ctx, g, col) {
    const x = wfHoverAt.x;
    if (x < g.gx || x > g.gx + g.pw) return;
    ctx.fillStyle = SerialViz.alpha(col.text, 0.5);
    ctx.fillRect(Math.round(x) - 0.5, g.gy, 1, g.ph);
  }

  // What is under the pointer → the tip's lines, or null.
  function wfAt(cv, x, y) {
    const s = stationOf();
    if (!s || !wf) return null;
    const sticks = wfSticks(s), g = wfGeom(cv, sticks);
    if (!g || x < g.gx || x > g.gx + g.pw || y < g.gy || y > g.gy + g.ph) return null;
    const rowH = g.ph / g.n, hz = g.lo + (x - g.gx) / g.pw * (g.hi - g.lo), k = Math.min(g.n - 1, Math.floor((y - g.gy) / rowH));
    // What was heard is counted over the slices within three pixels: a slice
    // can be under a pixel high.
    const near = Math.max(0, Math.round(3 / rowH)), k0 = Math.max(0, k - near), k1 = Math.min(g.n - 1, k + near);
    const t0 = g.top - k1 * g.bucket, t1 = g.top - k0 * g.bucket + g.bucket, secs = g.bucket < 60;
    const lines = [mhz(hz) + ' MHz', hhmm(t0, secs) + '–' + hhmm(t1, secs)];
    const owner = wfImg ? wfImg.owner : new Map(), edgeOf = [];
    let middle = false;
    for (const k2 of g.spans) {
      if (hz < k2.lo || hz > k2.hi) continue;
      const r = owner.get(k2.key + ':' + k);
      if (!r) { lines.push(k2.name + ': no row'); continue; }
      const i = Math.min(r.v.length - 1, Math.floor((hz - (r.center_hz - r.rate / 2)) / r.rate * r.v.length));
      const atEdge = Math.abs(hz - r.center_hz) > WF_USABLE * r.rate / 2;
      if (atEdge) edgeOf.push(k2.name); else middle = true;
      lines.push(k2.name + ': +' + (r.v[i] / 2).toFixed(1) + ' dB over its floor' + (r.floor_db != null ? ' (' + (r.floor_db + r.v[i] / 2).toFixed(1) + ' dB)' : '')
        + (atEdge ? ', its window\'s edge' : ''));
    }
    if (edgeOf.length && !middle) lines.push('The edge of ' + edgeOf.join(' and ') + '\'s window: what shows here can be a signal just beyond it, folded back in');
    // The nearest channel within 15 kHz, and what was heard on it in the slice.
    const chans = [].concat(...sticks.map(k2 => k2.chans)).filter(c => Math.abs(c.hz - hz) <= 15000).sort((a, b) => Math.abs(a.hz - hz) - Math.abs(b.hz - hz));
    if (chans.length) {
      const c = chans[0], here = wf.bursts.filter(b => b[0] >= t0 && b[0] < t1 && Math.abs(b[1] * 1e6 - c.hz) < 12500);
      const n = here.reduce((a, b) => a + b[2], 0), d = here.reduce((a, b) => a + b[3], 0), a2 = here.reduce((a, b) => a + b[4], 0);
      const snr = here.reduce((a, b) => (b[5] != null && b[5] > a ? b[5] : a), -Infinity);
      lines.push('Channel ' + mhz(c.hz) + ' MHz' + (FORMATS[c.format] ? ' (' + FORMATS[c.format] + ')' : '') + ': '
        + (n ? n + ' burst' + (n === 1 ? '' : 's') + ', ' + d + ' decoded' + (a2 ? ' (' + a2 + ' ALERT2)' : '') + (isFinite(snr) ? ', best ' + snr.toFixed(1) + ' dB' : '') : 'nothing heard'));
    }
    return { x, y, lines };
  }

  function wireWf() {
    const cv = document.getElementById('bs-wf-c'), tip = document.getElementById('bs-wf-tip');
    if (!cv || !tip) return;
    cv.addEventListener('mousemove', e => {
      const b = cv.getBoundingClientRect(), at = wfAt(cv, e.clientX - b.left, e.clientY - b.top);
      wfHoverAt = at;
      drawWf();
      if (!at) { tip.hidden = true; return; }
      tip.textContent = '';
      at.lines.forEach((l, i) => { const d = document.createElement('div'); d.textContent = l; if (i === 0) d.className = 'bs-wf-tip-h'; tip.appendChild(d); });
      tip.hidden = false;
      const left = at.x + 14 + tip.offsetWidth > cv.clientWidth ? at.x - 14 - tip.offsetWidth : at.x + 14;
      tip.style.setProperty('--tip-x', Math.max(0, left) + 'px');
      tip.style.setProperty('--tip-y', Math.max(0, Math.min(at.y + 12, WF_CSS_H - tip.offsetHeight)) + 'px');
    });
    cv.addEventListener('mouseleave', () => { wfHoverAt = null; tip.hidden = true; drawWf(); });
    if (!wfResize) {
      wfResize = true;
      window.addEventListener('resize', () => { if (state.activeTab === 'basestations') drawWf(); });
    }
  }

  // The busiest channels over the window, in words: the picture's text alternative.
  function wfSummaryHtml() {
    if (!wf) return 'Loading…';
    if (wf.err) return `<span class="txt-bad">${esc(wf.err)}</span>`;
    if (!wf.rows.length) return 'No spectrum rows from this station in the window yet: a stick sends its first with the station\'s next check-in, from RPi ALERT 0.13.5 on.';
    const by = new Map();
    for (const b of wf.bursts) {
      const e = by.get(b[1]) || { f: b[1], n: 0, d: 0, a2: 0, snr: null };
      e.n += b[2]; e.d += b[3]; e.a2 += b[4];
      if (b[5] != null && (e.snr == null || b[5] > e.snr)) e.snr = b[5];
      by.set(b[1], e);
    }
    const top = [...by.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    if (!top.length) return `Nothing heard on its channels in the last ${wf.hours} h.`;
    return `Heard in the last ${wf.hours} h: ` + top.map(e => `<strong>${esc(mhz(e.f * 1e6))} MHz</strong> ${e.n} burst${e.n === 1 ? '' : 's'}, ${e.d} decoded`
      + (e.a2 ? ` (${e.a2} ALERT2)` : '') + (e.snr != null ? `, best ${esc(Number(e.snr).toFixed(1))} dB` : '')).join(' · ');
  }

  function wfLegendHtml(s) {
    const sticks = wfSticks(s);
    return sticks.map(k => `<span><i class="qs-sw ${k.sw}" aria-hidden="true"></i>${esc(k.name)} <span class="qs-dim">${k.lo != null ? esc(mhz(k.lo) + '–' + mhz(k.hi) + ' MHz') : 'no row yet'}</span></span>`).join('')
      + '<span><i class="qs-sw sw-ok" aria-hidden="true"></i>a burst decoded</span><span><i class="qs-sw bs-sw-bad" aria-hidden="true"></i>heard, not decoded</span>'
      + `<span><i class="qs-sw bs-sw-heat" aria-hidden="true"></i>0–${WF_RANGE_DB} dB over the floor</span>`
      + '<span><i class="qs-sw bs-sw-edge" aria-hidden="true"></i>a window\'s edge</span>';
  }

  function wfShellHtml(s) {
    const slice = wfHours * 10;
    return `<section class="panel bs-wf" aria-labelledby="bs-wf-h">
      <div class="panel-header"><h2 id="bs-wf-h">What ${esc(s.label)} hears</h2>
        <div class="pill-row" role="group" aria-label="How far back">${WF_HOURS.map(hh => `<button type="button" class="pill${hh === wfHours ? ' is-on' : ''}" aria-pressed="${hh === wfHours}" onclick="BaseStations.wfWindow(${hh})">${hh} h</button>`).join('')}</div></div>
      <div class="qs-legend bs-wf-legend" id="bs-wf-legend"></div>
      <div class="bs-wf-wrap"><canvas id="bs-wf-c" class="qs-canvas bs-wf-c" role="img" aria-label="Waterfall"></canvas><div class="bs-wf-tip" id="bs-wf-tip" hidden></div></div>
      <p class="small" id="bs-wf-sum" aria-live="polite"></p>
      <p class="small qs-dim">Each SDR stick sends a row with every check-in — a minute apart, five seconds while this station is open: the strongest every frequency was since the row before, over the stick's own noise floor. Here they are folded into ${slice < 60 ? slice + '-second' : slice / 60 + '-minute'} slices, newest at the top; a gap is a time the station was not checking in. The bursts it heard are marked on their channels, since a spectrum of a few short looks a second can miss one. Hatched: the edge of a stick's window — its outer tenth either side — where no stick's middle reaches: a signal just past one edge folds back in at the other, so what shows there need not be a station of its own. Point at it for the frequency, the level and what was heard.</p>
    </section>`;
  }

  // Into #bs-wf: the panel for the open station, built once per station and
  // window, its text and picture refreshed each time.
  function paintWf() {
    if (state.activeTab !== 'basestations') return;
    const el = document.getElementById('bs-wf');
    if (!el) return;
    const s = stationOf();
    if (!isAdmin() || !s || !s.managed || !wfSticks(s).length) { if (el.innerHTML) { el.innerHTML = ''; el.dataset.sig = ''; } return; }
    const sig = s.id + ':' + wfHours;
    if (el.dataset.sig !== sig || !el.firstElementChild) { el.innerHTML = wfShellHtml(s); el.dataset.sig = sig; wireWf(); }
    const set = (id, html) => { const e = document.getElementById(id); if (e && e.innerHTML !== html) e.innerHTML = html; };
    set('bs-wf-legend', wfLegendHtml(s));
    set('bs-wf-sum', wfSummaryHtml());
    drawWf();
  }

  function wfRow(r) {
    const b = atob(r.bins || ''), v = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) v[i] = b.charCodeAt(i);
    return { t: Number(r.t), key: r.key, center_hz: Number(r.center_hz), rate: Number(r.rate), floor_db: r.floor_db == null ? null : Number(r.floor_db),
      span_s: Number(r.span_s) || 0, n: Number(r.n) || 1, v };
  }

  // The window's slices, or — polling a window already held — the last few
  // minutes of them again, laid over what is held.
  async function loadWf(full) {
    if (!isAdmin() || openId == null || wfBusy) return;
    const id = openId, hours = wfHours;
    const keep = !full && wf && wf.id === id && wf.hours === hours && !wf.err;
    const last = keep ? Math.max(0, ...wf.rows.map(r => r.t), ...wf.bursts.map(b => b[0])) : 0;
    const since = keep && last ? new Date((last - Math.max(300, wf.bucket)) * 1000).toISOString() : null;
    wfBusy = true;
    try {
      const r = await dbRpc('admin_base_station_spectrum', { p_id: id, p_hours: hours, p_since: since });
      if (openId !== id || wfHours !== hours) return;
      setNow(r.now);
      const from = Date.parse(r.from) / 1000, cut = Date.parse(r.now) / 1000 - hours * 3600 - r.bucket_s;
      const rows = (keep ? wf.rows.filter(x => x.t < from) : []).concat((r.rows || []).map(wfRow)).filter(x => x.t >= cut);
      const bursts = (keep ? wf.bursts.filter(x => x[0] < from) : []).concat(r.bursts || []).filter(x => x[0] >= cut);
      wf = { id, hours, bucket: r.bucket_s, rows, bursts, err: null, v: ((wf && wf.v) || 0) + 1 };
    } catch (err) {
      if (openId !== id || wfHours !== hours) return;
      const why = err.status === 404 ? 'The database does not have this yet — apply db/migrations/0068_base_station_spectrum.sql.'
        : 'Could not load what it hears: ' + err.message;
      wf = Object.assign(keep ? wf : { id, hours, bucket: hours * 10, rows: [], bursts: [] }, { err: why, v: ((wf && wf.v) || 0) + 1 });
    } finally {
      wfBusy = false;
    }
    paintWf();
  }

  function wfStart() {
    clearInterval(timers.wf);
    timers.wf = null;
    const s = stationOf();
    if (!s || !s.managed) return;
    loadWf(true);
    timers.wf = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') loadWf(false); }, WF_MS);
  }

  function wfWindow(hours) {
    if (!WF_HOURS.includes(hours) || hours === wfHours) return;
    wfHours = hours; wf = null; wfImg = null;
    paintWf();
    loadWf(true);
  }

  // ── channel by channel (0081) ────────────────────────────────────────────
  // What the open station heard on each frequency over the last day, week or
  // month — admin_base_station_channels(), from the reception rollups — set
  // beside what the register says is there (its repeaters' pairs and listed
  // frequencies near the station) and what the ACMA has licensed near it
  // (data/acma-devices.json, app.js's loaders), with a word on each: expected;
  // licensed to someone the register does not have; heard with no licence
  // found; expected but not listened to; listened to and silent. The lay of
  // the land before anything is tidied — and why each channel earns its keep
  // on a Pi with four cores.

  const CH_DAYS = [1, 7, 30];
  const CH_MS = 300000;       // a rollup is hourly: five minutes is plenty
  const CH_REG_KM = 250;      // the register's stations this near are "around here"
  const CH_ACMA_KM = 100;     // the ACMA's licences this near
  const CH_NEAR_MHZ = 0.006;  // a channel this close is the same one (151.572 typed for 151.575)
  // { id, days, r, err } — r as the database answered.
  let ch = null, chDays = 7, chBusy = false;
  // The ACMA's licences near the open station: { key, list: [{ f, lic, client,
  // site, km, emission }], err }, or { key, loading } while the files load.
  let chAcma = null;

  function chKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2
      + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, a)));
  }
  const chMhz = f => Number(f).toFixed(4).replace(/0{1,2}$/, '');
  const chN = n => Number(n || 0).toLocaleString('en-AU');

  // Every ACMA device within CH_ACMA_KM of the station, loaded once a site.
  function chLoadAcma(site) {
    if (!site) return;
    const key = site.lat.toFixed(3) + ',' + site.lon.toFixed(3);
    if (chAcma && chAcma.key === key) return;
    if (typeof acmaEnsureCore !== 'function' || typeof acmaEnsureDevices !== 'function') { chAcma = { key, list: [], err: 'the ACMA loaders are not on this page' }; return; }
    chAcma = { key, loading: true, list: [] };
    acmaEnsureCore().then(acmaEnsureDevices).then(() => {
      const A = state.acma, list = [];
      for (const d of Object.values(A.deviceById || {})) {
        const s = A.siteById[d.site_id];
        if (!s || d.f_mhz == null) continue;
        const km = chKm(site.lat, site.lon, s.lat, s.lon);
        if (km > CH_ACMA_KM) continue;
        const lic = (A.licById || {})[d.lic] || {}, cl = (A.clientById || {})[lic.client_no] || {};
        list.push({ f: Number(d.f_mhz), lic: d.lic, client: cl.name || 'licensee ' + (lic.client_no || '?'), site: s.name, km: Math.round(km),
          emission: d.emission || '', status: lic.status || '' });
      }
      list.sort((a, b) => a.f - b.f || a.km - b.km);
      if (chAcma && chAcma.key === key) chAcma = { key, list, source: A.threats && A.threats.meta && A.threats.meta.source_date };
    }).catch(e => { if (chAcma && chAcma.key === key) chAcma = { key, list: [], err: 'the ACMA licences could not be loaded (' + e.message + ')' }; })
      .then(paintCh);
  }

  // A stick's channels as the station said them: [{ hz, inBand, why }].
  function chListening(s) {
    const out = [];
    for (const rx of receiversOf(s).filter(r => r.kind === 'sdr')) {
      const list = Array.isArray(rx.channels) && rx.channels.length ? rx.channels : rx.freq_hz ? [{ freq_hz: rx.freq_hz, in_band: true }] : [];
      for (const c of list) out.push({ f: c.freq_hz / 1e6, stick: rx.name, inBand: c.in_band !== false, why: c.why || null, running: rx.state === 'running' });
    }
    return out;
  }

  // A row a frequency: what was heard on it (a row per protocol), the sticks
  // listening to it now, the register's entries and the ACMA's licences on
  // it — the last two matched within CH_NEAR_MHZ. ACMA licences on no row's
  // frequency are the `others`.
  function chRows(r, listening, acma) {
    const rows = [];
    const find = f => rows.find(x => Math.abs(x.f - f) < 1e-6);
    const near = f => rows.filter(x => Math.abs(x.f - f) <= CH_NEAR_MHZ + 1e-9).sort((a, b) => Math.abs(a.f - f) - Math.abs(b.f - f))[0] || null;
    const get = f => find(f) || (rows.push({ f, heard: [], listen: [], reg: [], acma: [] }), rows[rows.length - 1]);
    for (const c of r.channels || []) get(Number(c.f)).heard.push(c);
    for (const l of listening) get(Number(l.f.toFixed(4))).listen.push(l);
    for (const g of r.register || []) {
      if (g.km == null || g.km > CH_REG_KM) continue;
      (near(Number(g.f)) || get(Number(g.f))).reg.push(g);
    }
    const others = [];
    for (const a of acma || []) { const x = near(a.f); if (x) x.acma.push(a); else others.push(a); }
    rows.sort((a, b) => a.f - b.f);
    return { rows, others };
  }

  // Who holds the licences on a row, nearest first: [{ client, n, km }].
  function chLicensees(row) {
    const by = new Map();
    for (const a of row.acma) { const e = by.get(a.client) || { client: a.client, n: 0, km: a.km }; e.n++; e.km = Math.min(e.km, a.km); by.set(a.client, e); }
    return [...by.values()].sort((a, b) => a.km - b.km);
  }

  // The word on a row: { k, text, cls } and the notes under it.
  function chVerdict(row) {
    const sum = k => row.heard.reduce((a, c) => a + Number(c[k] || 0), 0);
    const decoded = sum('ok'), heard = sum('n');
    const listening = row.listen.some(l => l.inBand && l.running);
    const down = !listening && row.listen.find(l => l.inBand && !l.running);
    const outside = row.listen.length && !listening && !down;
    const lic = chLicensees(row);
    const who = lic.length ? lic[0].client + (lic.length > 1 ? ' and ' + (lic.length - 1) + ' more' : '') : '';
    let v;
    if (decoded > 0) {
      v = row.reg.length ? { k: 'expected', cls: 'txt-ok', text: 'Expected — the register has it here' }
        : lic.length ? { k: 'gap', cls: 'txt-warn', text: 'Licensed to ' + who + ', not in the register' }
        : { k: 'odd', cls: 'txt-bad', text: 'Not expected, and no licence found near here' };
    } else if (heard > 0) {
      v = { k: 'undecoded', cls: 'txt-warn', text: 'Bursts, but none decode' + (row.reg.length ? ' — the register expects ALERT here' : lic.length ? ' — licensed to ' + who : '') };
    } else if (listening) {
      v = row.reg.length || lic.length ? { k: 'silent', cls: 'txt-warn', text: 'Listened to, nothing heard' + (row.reg.length ? ' — the register expects it' : ' — licensed to ' + who) }
        : { k: 'silent', cls: 'qs-dim', text: 'Listened to, nothing heard — nothing expected here' };
    } else if (down) {
      v = { k: 'down', cls: 'txt-warn', text: 'Listed on ' + down.stick + ', which is not receiving' };
    } else if (outside) {
      v = { k: 'outside', cls: 'txt-warn', text: 'Listed on ' + row.listen[0].stick + ', outside its window — not decoded' };
    } else {
      v = { k: 'missed', cls: 'txt-warn', text: 'Expected here, not listened to' };
    }
    const notes = [];
    if (decoded > 0 && !listening) notes.push('Not listened to now' + (outside ? ': outside ' + row.listen[0].stick + '’s window' : '') + '.');
    for (const c of row.heard) {
      const ids = c.ids || {}, a2 = c.protocol === 'alert2';
      if (a2 && ids.counted && !ids.near) notes.push('ALERT2 from ' + ids.counted + ' source' + (ids.counted === 1 ? '' : 's') + ', none of them in the register.');
      if (!a2 && ids.far) {
        const e = (c.far || [])[0];
        notes.push(ids.far + ' ID' + (ids.far === 1 ? ' belongs' : 's belong') + ' to register stations over ' + ((ch && ch.r && ch.r.far_km) || 400) + ' km away'
          + (e ? ' — ' + e[0] + ' is ' + (e[5] || e[4]) + ', ' + chN(e[7]) + ' km off, decoded ' + chN(e[1]) + ' times' : '') + ': another network using the same IDs.');
      }
      if (!a2 && ids.unknown) {
        const u = (c.unknown || []).slice(0, 3).map(x => x[0] + ' (' + chN(x[1]) + ')').join(', ');
        notes.push(ids.unknown + ' ID' + (ids.unknown === 1 ? '' : 's') + ' the register does not have' + (u ? ' — most decoded ' + u : '') + '.');
      }
      if (!a2 && Number(c.n) >= 50 && Number(c.ok) < 0.2 * Number(c.n) && row.heard.some(x => x.protocol === 'alert2' && Number(x.ok) > Number(c.n)))
        notes.push('Its ALERT bursts are mostly the ALERT2 traffic read as legacy ALERT (' + chN(c.ok) + ' of ' + chN(c.n) + ' decode) — each costs a decode attempt.');
    }
    return Object.assign(v, { notes, decoded, heard, listening });
  }

  function chHeardHtml(row) {
    if (!row.heard.length) return '<span class="qs-dim">—</span>';
    const days = ch.r.days;
    return row.heard.map(c => {
      const d = (c.days || []).filter(x => Number(x[2]) > 0).length;
      return `<div><strong>${esc(c.protocol === 'alert2' ? 'ALERT2' : 'ALERT')}</strong> ${esc(chN(c.ok))} decoded${Number(c.n) > Number(c.ok) ? ` <span class="qs-dim">of ${esc(chN(c.n))}</span>` : ''}`
        + `<div class="qs-dim">${c.snr != null ? 'SNR ' + esc(c.snr) + ' dB · ' : ''}${days > 1 ? 'on ' + d + ' of ' + days + ' days · ' : ''}last ${esc(ago(c.last))}</div></div>`;
    }).join('');
  }

  function chWhoHtml(row) {
    const out = [];
    for (const c of row.heard) {
      const ids = c.ids || {};
      const top = (c.top || []).filter(t => Number(t[1]) >= (ch.r.min_decodes || 3)).slice(0, 3)
        .map(t => (t[5] ? esc(t[5]) + (t[7] != null && t[7] > (ch.r.far_km || 400) ? ` <span class="txt-warn">(${esc(chN(t[7]))} km)</span>` : '')
          : (c.protocol === 'alert2' ? 'source ' : 'ID ') + esc(t[0])) + ` <span class="qs-dim">${esc(chN(t[1]))}</span>`);
      if (!top.length && !ids.counted) continue;
      out.push(`<div>${top.join(' · ')}${ids.counted > top.length ? ` <span class="qs-dim">+${esc(ids.counted - top.length)} more</span>` : ''}`
        + `<div class="qs-dim">${esc(ids.counted || 0)} ${c.protocol === 'alert2' ? 'source' : 'ID'}${ids.counted === 1 ? '' : 's'}: ${esc(ids.near || 0)} in the register here`
        + `${ids.far ? ', ' + esc(ids.far) + ' far away' : ''}${ids.unknown ? ', ' + esc(ids.unknown) + ' unknown' : ''}</div></div>`);
    }
    return out.join('') || '<span class="qs-dim">—</span>';
  }

  function chRegHtml(row) {
    if (!row.reg.length) return '<span class="qs-dim">nothing within ' + CH_REG_KM + ' km</span>';
    const part = (dir, word) => {
      const g = row.reg.filter(x => x.dir === dir);
      if (!g.length) return '';
      const first = g[0];
      return `<div>${word} ${g.length === 1 ? '' : esc(g.length) + ' '}${first.kind === 'repeater' ? 'repeater' + (g.length === 1 ? '' : 's') : 'station' + (g.length === 1 ? '' : 's')}`
        + `<div class="qs-dim">${esc(first.name)}, ${esc(chN(first.km))} km${first.label ? ' · ' + esc(first.label) : ''}${g.length > 1 ? ' (nearest)' : ''}</div></div>`;
    };
    return part('tx', 'TX of') + part('rx', 'RX of');
  }

  function chAcmaHtml(row) {
    if (!chAcma || chAcma.loading) return '<span class="qs-dim">loading…</span>';
    if (chAcma.err) return '<span class="qs-dim">—</span>';
    const lic = chLicensees(row);
    if (!lic.length) return '<span class="qs-dim">none within ' + CH_ACMA_KM + ' km</span>';
    return lic.slice(0, 3).map(l => `<div>${esc(l.client)}<div class="qs-dim">${l.n > 1 ? esc(l.n) + ' devices, nearest ' : ''}${esc(l.km)} km</div></div>`).join('')
      + (lic.length > 3 ? `<div class="qs-dim">+${esc(lic.length - 3)} more licensees</div>` : '');
  }

  function chListenHtml(row) {
    if (!row.listen.length) return '<span class="qs-dim">no</span>';
    return row.listen.map(l => `<div>${esc(l.stick)}${!l.inBand ? ` <span class="txt-warn">— ${esc(l.why === 'mirror' ? 'beside a mirror image' : l.why === 'spike' ? 'on the DC spike' : 'outside its window')}</span>`
      : !l.running ? ' <span class="txt-warn">— not receiving</span>' : ''}</div>`).join('');
  }

  function chShellHtml(s) {
    return `<section class="panel bs-ch" aria-labelledby="bs-ch-h">
      <div class="panel-header"><h2 id="bs-ch-h">Channel by channel</h2>
        <div class="pill-row" role="group" aria-label="How far back">${CH_DAYS.map(d => `<button type="button" class="pill${d === chDays ? ' is-on' : ''}" aria-pressed="${d === chDays}" onclick="BaseStations.chWindow(${d})">${d === 1 ? '1 day' : d + ' days'}</button>`).join('')}</div></div>
      <p class="small" id="bs-ch-sum" aria-live="polite"></p>
      <div id="bs-ch-body"></div>
      <p class="small qs-dim">What ${esc(s.label)} heard on each frequency — from the hourly reception rollups, so the last hour may not be in yet — beside what Flood-Net's register puts there (its repeaters' TX and RX and the other frequencies stations list, within ${CH_REG_KM} km) and what the ACMA has licensed within ${CH_ACMA_KM} km (Register of Radiocommunications Licences extract${chAcma && chAcma.source ? ' of ' + esc(chAcma.source) : ''}, CC BY 4.0). An ID counts once it has decoded ${esc((ch && ch.r && ch.r.min_decodes) || 3)} times; it is put down to the register's nearest station holding it — one more than ${esc((ch && ch.r && ch.r.far_km) || 400)} km away is another network using the same ID. A channel within ${CH_NEAR_MHZ * 1000} kHz of a licence or register entry is taken to be that one.</p>
    </section>`;
  }

  function chSummaryHtml(rows) {
    if (!ch || ch.id !== openId) return 'Loading…';
    if (ch.err) return `<span class="txt-bad">${esc(ch.err)}</span>`;
    const count = k => rows.filter(x => x.v.k === k).length;
    const heard = rows.filter(x => x.v.decoded > 0).length;
    if (!rows.length) return 'Nothing heard in the last ' + (ch.r.days === 1 ? 'day' : ch.r.days + ' days') + ', and nothing listed near it.';
    const bits = [];
    if (count('expected')) bits.push(count('expected') + ' expected');
    if (count('gap')) bits.push(`<strong class="txt-warn">${count('gap')} licensed to others but not in the register</strong>`);
    if (count('odd')) bits.push(`<strong class="txt-bad">${count('odd')} with no licence found</strong>`);
    const quiet = [count('missed') && count('missed') + ' expected but not listened to', count('silent') && count('silent') + ' listened to and silent',
      count('undecoded') && count('undecoded') + ' with bursts that do not decode', count('outside') && count('outside') + ' listed outside their stick\'s window',
      count('down') && count('down') + ' on a stick that is not receiving'].filter(Boolean);
    return `In the last ${ch.r.days === 1 ? 'day' : ch.r.days + ' days'} it decoded something on ${heard} frequenc${heard === 1 ? 'y' : 'ies'}: ${bits.join(', ') || 'none expected'}.`
      + (quiet.length ? ' ' + quiet.join('; ').replace(/^./, c => c.toUpperCase()) + '.' : '')
      + (ch.r.to ? ` <span class="qs-dim">Rolled up to ${esc(ago(ch.r.to))}.</span>` : '');
  }

  function chTableHtml(rows, others) {
    if (!rows.length) return '';
    const body = rows.map(x => `<tr>
        <th scope="row">${esc(chMhz(x.f))} <span class="small qs-dim">MHz</span></th>
        <td class="small"><strong class="${x.v.cls}">${esc(x.v.text)}</strong>${x.v.notes.map(n => `<div class="qs-dim">${esc(n)}</div>`).join('')}</td>
        <td class="small">${chHeardHtml(x)}</td>
        <td class="small">${chWhoHtml(x)}</td>
        <td class="small">${chRegHtml(x)}</td>
        <td class="small">${chAcmaHtml(x)}</td>
        <td class="small">${chListenHtml(x)}</td>
      </tr>`).join('');
    const rest = new Map();
    for (const a of others) { const k = chMhz(a.f); const e = rest.get(k) || []; e.push(a); rest.set(k, e); }
    const lo = rows[0].f - 0.25, hi = rows[rows.length - 1].f + 0.25;
    const near = [...rest.entries()].filter(([k]) => Number(k) >= lo && Number(k) <= hi);
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-ch-h"><table class="adm-table bs-ch-t">
        <caption class="sr-only">Each frequency: what it is, what was heard, from whom, what the register and the ACMA say, and which stick listens to it</caption>
        <thead><tr><th scope="col">Frequency</th><th scope="col" class="bs-wide">What it is</th><th scope="col">Heard</th><th scope="col">From</th><th scope="col">Register</th><th scope="col">ACMA licences</th><th scope="col">Listening now</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${near.length ? `<details class="small"><summary>${near.length} more licensed frequenc${near.length === 1 ? 'y' : 'ies'} near here, between ${esc(chMhz(lo))} and ${esc(chMhz(hi))} MHz, that it does not listen to</summary>
        <ul>${near.map(([k, list]) => { const l = [...new Set(list.map(a => a.client))]; return `<li>${esc(k)} MHz — ${esc(l.slice(0, 2).join('; '))}${l.length > 2 ? ' and ' + (l.length - 2) + ' more' : ''} <span class="qs-dim">(${esc(Math.min(...list.map(a => a.km)))} km)</span></li>`; }).join('')}</ul></details>` : ''}`;
  }

  // Into #bs-ch: the panel for the open station, built once per station and
  // window, its rows rebuilt from what was loaded.
  function paintCh() {
    if (state.activeTab !== 'basestations') return;
    const el = document.getElementById('bs-ch');
    if (!el) return;
    const s = stationOf();
    if (!isAdmin() || !s) { if (el.innerHTML) { el.innerHTML = ''; el.dataset.sig = ''; } return; }
    const sig = s.id + ':' + chDays + ':' + (chAcma && chAcma.source || '');
    if (el.dataset.sig !== sig || !el.firstElementChild) { el.innerHTML = chShellHtml(s); el.dataset.sig = sig; }
    let rows = [], others = [];
    if (ch && ch.id === s.id && ch.r) {
      ({ rows, others } = chRows(ch.r, chListening(s), chAcma && chAcma.list));
      rows = rows.map(x => Object.assign(x, { v: chVerdict(x) }));
    }
    const set = (id, html) => { const e = document.getElementById(id); if (e && e.innerHTML !== html) keepFocus(e, () => { e.innerHTML = html; }); };
    set('bs-ch-sum', chSummaryHtml(rows));
    set('bs-ch-body', chTableHtml(rows, others));
  }

  async function loadCh() {
    if (!isAdmin() || openId == null || chBusy) return;
    const id = openId, days = chDays;
    chBusy = true;
    try {
      const r = await dbRpc('admin_base_station_channels', { p_id: id, p_days: days });
      if (openId !== id || chDays !== days) return;
      setNow(r.now);
      ch = { id, days, r, err: null };
      chLoadAcma(r.site);
    } catch (err) {
      if (openId !== id || chDays !== days) return;
      ch = { id, days, r: null, err: err.status === 404 ? 'The database does not have this yet — apply db/migrations/0081_base_station_channels.sql.'
        : 'Could not load its channels: ' + err.message };
    } finally {
      chBusy = false;
    }
    paintCh();
  }

  function chStart() {
    clearInterval(timers.ch);
    timers.ch = null;
    if (openId == null) return;
    loadCh();
    timers.ch = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') loadCh(); }, CH_MS);
  }

  function chWindow(days) {
    if (!CH_DAYS.includes(days) || days === chDays) return;
    chDays = days; ch = null;
    paintCh();
    loadCh();
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
      <p class="small">A base station is never reached from here: it checks in with Flood-Net about once a minute, and what is asked waits for that. It can only be asked for a short list of things, never its token or its passwords, and its owner can turn this off on the station itself.</p>
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
      <div id="bs-wf"></div>
      <div id="bs-ch"></div>
      <div id="bs-keys">${keysHtml()}</div>
      <div class="panel">
        <div class="panel-header"><h2>How a base station is reached</h2></div>
        <p class="small">It is not: it checks in. About once a minute each base station sends Flood-Net a heartbeat — and its whole status when something changed — and collects what was asked of it here, which it does and answers at its next check-in. Opening one makes it check in every five seconds for the next three minutes. It can be asked only for the things above; never its token, where it sends readings, its passwords or SSH keys, or how much it lets Flood-Net do — that is set on the station, which can also refuse everything (report only) or stop checking in.</p>
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
    paintWf();
    paintCh();
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
    paintWf();
    paintCh();
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

  // GitHub's latest release, when the last answer is old enough (see `latest`).
  async function loadLatest() {
    if (!isAdmin() || Date.now() - latestAt < (latest && latest.version ? LATEST_MS : LATEST_RETRY_MS)) return;
    latestAt = Date.now();
    try {
      const r = await fetch(RELEASE_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const v = String(j.tag_name || '').replace(/^v/, '');
      if (!/^\d+(\.\d+)*$/.test(v)) throw new Error('not a version: ' + j.tag_name);
      latest = { version: v, url: /^https:\/\/github\.com\//.test(j.html_url || '') ? j.html_url : null };
    } catch (_) {
      // Not shown: the station's own version stands alone. One GitHub knew is kept.
      if (!latest) latest = { version: null };
    }
    repaintLive();
  }

  function stop() {
    clearInterval(timers.list); clearTimeout(timers.detail); clearInterval(timers.watch); clearInterval(timers.wf); clearInterval(timers.ch);
    timers.list = timers.detail = timers.watch = timers.wf = timers.ch = null;
  }

  function init() {
    if (!isAdmin()) return;
    stop();
    load();
    loadKeys();
    loadLatest();
    timers.list = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') { load(); loadLatest(); } }, LIST_MS);
    if (openId != null) { loadDetail(); wfStart(); chStart(); timers.watch = setInterval(() => { if (!document.hidden) watch(false); }, WATCH_MS); }
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
    wf = null; wfImg = null; wfHoverAt = null;
    wfStart();
    ch = null;
    chStart();
    announce('Opened ' + (s ? s.label : 'the base station') + '.');
  }

  function close() {
    openId = null; detail = null; askErr = null; form = null; formNote = null; logShown = null;
    wf = null; wfImg = null; wfHoverAt = null; ch = null;
    clearInterval(timers.watch); clearTimeout(timers.detail); clearInterval(timers.wf); clearInterval(timers.ch);
    repaint();
  }

  // `question`, when the action needs one, is confirmDialog's (askFrom builds it).
  async function ask(verb, args, question) {
    const s = stationOf();
    if (!s) return;
    if (question && !(await confirmDialog(question))) return;
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
    ask(btn.dataset.verb, args, btn.dataset.confirm ? questionFor(btn) : null);
  }

  // The question a button's data-confirm asks, in confirmDialog's terms (#223):
  // its first sentence, up to the question mark, is the dialog's title and the
  // rest is what follows; the button that acts is named for what the button
  // pressed said, without its "…"; and a button drawn as dangerous asks as one.
  function questionFor(btn) {
    const text = btn.dataset.confirm;
    const at = text.indexOf('?');
    return {
      title: at > 0 ? text.slice(0, at + 1) : text,
      message: at > 0 ? text.slice(at + 1).trim() : '',
      confirm: btn.textContent.replace(/…\s*$/, '').trim() || 'Go ahead',
      danger: btn.classList.contains('adm-danger'),
    };
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
    if (!(await confirmDialog({ title: 'Take ' + k.owner + '\'s key off the list?',
      message: k.fingerprint + '\n\nBase stations that take the team keys drop it at their next fetch — within a minute for one checking in.',
      confirm: 'Take the key off', danger: true }))) return;
    try { await dbRpc('admin_base_station_key_remove', { p_id: id }); setKeyMsg('Took ' + k.owner + '\'s key off.', 'txt-ok'); }
    catch (err) { setKeyMsg('Not taken off: ' + err.message, 'txt-bad'); }
    loadKeys();
  }

  // A sign-in or sign-out: everything held was the last session's.
  function authChanged() {
    list = null; error = null; detail = null; openId = null; askErr = null; keys = null; keysErr = null; keyMsg = null; form = null; formNote = null; logShown = null; note = '';
    wf = null; wfImg = null; wfHoverAt = null; ch = null; chAcma = null;
    stop();
    if (state.activeTab === 'basestations') { repaint(); init(); }
  }

  return { render, init, load, open, close, ask, askFrom, cancel, field, stick, resetForm, saveSettings,
           keyField, addKey, removeKey, authChanged, wfWindow, chWindow,
           // Pure, for test/basestations.mjs.
           _liveness: liveness, _flags: flags, _patchFrom: patchFrom, _formFrom: formFrom, _cmpVersion: cmpVersion, _lastInstall: lastInstall, _wfLoad: loadWf,
           _chRows: chRows, _chVerdict: chVerdict };
})();

if (typeof window !== 'undefined') window.BaseStations = BaseStations;
