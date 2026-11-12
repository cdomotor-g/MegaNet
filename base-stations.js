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
  // Whether the administrators are emailed about an offline base station (0113),
  // and what was last said; null until asked, false where the database has no 0113.
  let mail = null, mailMsg = null;
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
  // The open station's panel, as RPi ALERT's own page has it (0.21): its
  // Overview — what it is doing, with its settings folded into sections — and
  // what reads like a log on tabs of its own. Which tab, and which folds are
  // open, outlive a poll's repaint; another station starts on its Overview.
  let subTab = 'overview';
  const openFolds = new Set();
  const timers = { list: null, detail: null, watch: null, wf: null, ch: null, sig: null, st: null, ing: null };
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
  const WINDOWS = [['240000', '240 kHz — the lightest'], ['288000', '288 kHz'], ['960000', '960 kHz'], ['1200000', '1.2 MHz'], ['1440000', '1.44 MHz'], ['1920000', '1.92 MHz'], ['2400000', '2.4 MHz']];
  // 288 kHz is RPi ALERT 0.22's (its decoder resamples it by a fraction): not
  // offered to a station older than that, which would refuse it.
  const NEW_288 = '0.22.0';
  // RPi ALERT 0.20: the narrowest and the widest window Automatic may take
  // (receivers.sdr.sampleRateMin / sampleRateMax, and a stick's own; 0 no limit).
  const LIMITS = [['0', 'No limit']].concat(WINDOWS.map(([v, t]) => [v, t.replace(' — the lightest', '')]));
  const WIDTH = Object.fromEntries(LIMITS.slice(1));
  const WINDOW_WORDS = {
    window: ['Window', 'The slice of the band a stick hears at once. Every channel\'s decoder works through all of it, so a wider window costs the Pi more — and hears weak bursts a little better: a stick\'s 8-bit samples spread their noise across the window, so less of it is left in each channel (at 18 Bateson, 960 kHz\'s noise floor was 5–6 dB under 288 kHz\'s). Automatic takes the narrowest that holds the stick\'s channels.'],
    min: ['No narrower than', 'With the window on Automatic: the narrowest it may take. Wider shows more of the band on the waterfall, and costs the Pi more.'],
    max: ['No wider than', 'With the window on Automatic: the widest it may take. Keeps a stick\'s work down whatever channels it has; a channel the window cannot hold is not decoded, and the stick says so below.'],
    chans: ['Channels', 'The frequencies a stick decodes at once, its own first. A stick with none of its own decodes the channels set for every stick — listening to one far from the others is what makes a window wide.'],
  };
  const FMT_SHORT = { BINARY: 'ABF', ENHANCED_IFLOWS: 'EIF', ASCII: 'ASCII' };
  const FMT_OF = { abf: 'BINARY', binary: 'BINARY', eif: 'ENHANCED_IFLOWS', iflows: 'ENHANCED_IFLOWS', enhanced_iflows: 'ENHANCED_IFLOWS', ascii: 'ASCII' };
  // 151.500, 151.5375: three decimals, four where the channel needs them.
  const mhzOf = hz => { const t = (hz / 1e6).toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
  // A channel list → its text: "151.500, 151.525, 152.400 EIF" (a format
  // shown only where it is not the stick's own).
  function chansText(list, fmt) {
    return list.map(c => mhzOf(c.freqHz) + (c.format && c.format !== fmt ? ' ' + FMT_SHORT[c.format] : '')).join(', ');
  }
  // Its text → [{ freqHz, format? }], or throws why. At most 8, none twice; the
  // station holds them to its own rules (how far apart) and says if not.
  function parseChans(text, who) {
    const items = String(text).split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
    if (!items.length) throw new Error(who + 'at least one channel, in MHz');
    if (items.length > 8) throw new Error(who + 'at most 8 channels on one stick');
    const out = [];
    for (const it of items) {
      const m = /^(\d+(?:\.\d+)?)(?:\s*mhz)?(?:\s+([a-z_ ]+))?$/i.exec(it);
      const f = m && FMT_OF[String(m[2] || '').trim().toLowerCase().replace(/\s+/g, '_')];
      if (!m || (m[2] && !f)) throw new Error(who + '"' + it + '" is not a channel — a frequency in MHz, e.g. 151.5375, or 152.4 EIF in another format');
      const hz = Math.round(Number(m[1]) * 1e6);
      if (hz < 24e6 || hz > 1766e6) throw new Error(who + 'a frequency of 24–1766 MHz');
      if (out.some(c => c.freqHz === hz)) throw new Error(who + mhzOf(hz) + ' MHz is listed twice');
      out.push(f ? { freqHz: hz, format: f } : { freqHz: hz });
    }
    return out;
  }
  // A stick's channels as its settings hold them: [own channel, ...more].
  const chansOf = (first, more) => (first ? [{ freqHz: first }] : []).concat((more || []).map(m => (m.format ? { freqHz: m.freqHz, format: m.format } : { freqHz: m.freqHz })));
  const moreOf = list => list.slice(1).map(c => (c.format ? { freqHz: c.freqHz, format: c.format } : { freqHz: c.freqHz }));

  // A stick now, from its status: what it decodes, in what window and why,
  // and what its window leaves out.
  function stickNowHtml(r) {
    const ch = Array.isArray(r.channels) && r.channels.length ? r.channels : (r.freq_hz ? [{ freq_hz: r.freq_hz, format: r.format, in_band: true }] : []);
    if (!ch.length || !r.sample_rate) return '';
    const w = r.window || {}, width = WIDTH[String(r.sample_rate)] || (r.sample_rate / 1e3) + ' kHz';
    const lim = [w.min ? 'no narrower than ' + WIDTH[String(w.min)] : '', w.max ? 'no wider than ' + WIDTH[String(w.max)] : ''].filter(Boolean).join(', ');
    const how = w.auto === false ? 'as set' : w.capped ? 'automatic, the widest allowed — ' + lim
      : w.needs && r.sample_rate > w.needs ? 'automatic, the narrowest allowed — ' + lim : 'automatic' + (lim ? ', ' + lim : '');
    const heard = ch.filter(c => c.in_band !== false), out = ch.filter(c => c.in_band === false);
    const why = { outside: 'outside the window', spike: 'it would sit on the DC spike', mirror: 'another channel\'s mirror image lands on it' };
    return `<p class="small qs-dim">Now: ${esc(heard.map(c => mhzOf(c.freq_hz)).join(', ') || 'nothing')} MHz in a ${esc(width)} window (${esc(how)}).</p>`
      + (out.length ? `<p class="small txt-warn">Not decoded: ${esc(out.map(c => mhzOf(c.freq_hz) + ' — ' + (why[c.why] || 'it does not fit beside the others')).join('; '))}`
        + (w.needs && w.needs > r.sample_rate ? esc('. A ' + (WIDTH[String(w.needs)] || w.needs) + ' window holds them all' + (w.capped ? ': raise No wider than to let it.' : '.')) : '') + '</p>' : '');
  }
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
          <td class="small">${esc(rxDetail(r)) || '—'}${r.kind === 'sdr' ? stickNowHtml(r) : ''}</td>
          <td class="small">${r.decoded != null ? esc(r.decoded) + ' decoded' : ''}${r.kind === 'sdr' ? checksHtml(r) : ''}${r.dataAgoS != null ? `<div class="qs-dim">data ${esc(span(r.dataAgoS).replace(/^0 min$/, 'just now'))}</div>` : ''}${deafFor(s, r.key) ? `<div class="${deafFor(s, r.key).severity === 'critical' ? 'txt-bad' : 'txt-warn'}">nothing new for ${esc(span((now() - Date.parse((deafFor(s, r.key).evidence || {}).changed_at)) / 1000))}</div>` : ''}</td>
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
    rows.push(['If it loses touch', recoverHtml(s)]);
    const lost = lostHtml(s);
    if (lost) rows.push(['Last lost touch', lost]);
    return `<h3>Uplink</h3><dl class="adm-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  }

  // What the station does by itself when it cannot reach Flood-Net (RPi ALERT
  // 0.23's keeper, its status' `recovery`), and the last times it had to: the
  // station's own account, told at its first check-in afterwards.
  const RECOVER = {
    full: 'it gets back by itself: joins its network again, restarts its networking, and reboots after 45 minutes',
    network: 'it reconnects and restarts its networking by itself, but is set never to reboot',
    off: 'it does nothing by itself — that is turned off on it',
  };
  const RECOVER_MODES = [['full', 'Reconnect, restart its networking, and reboot as the last resort'],
    ['network', 'Reconnect and restart its networking — never reboot'], ['off', 'Nothing — only keep what it hears']];
  const RECOVER_HOW = { 'wifi-rejoin': 'after joining its Wi-Fi network again', 'net-reconnect': 'after renewing its network connection',
    'net-restart': 'after restarting its networking', 'restart-agent': 'after restarting its own software', reboot: 'after rebooting itself',
    power: 'after somebody switched it off and on', restart: 'after its software was restarted' };
  const RECOVER_STEP = { 'wifi-rejoin': 'joined its Wi-Fi again', 'net-reconnect': 'renewed its connection', 'net-restart': 'restarted its networking',
    'restart-agent': 'restarted its software', reboot: 'rebooted itself', power: 'switched off and on by somebody', restart: 'its software was restarted' };
  const RECOVER_KIND = { 'no-network': 'it was on no network', 'dead-link': 'its network passed nothing', names: 'it could not look up Flood-Net\'s name',
    agent: 'only its own software could not reach Flood-Net', 'far-end': 'Flood-Net was not answering' };

  function recoverHtml(s) {
    const r = (s.status || {}).recovery;
    if (!r || !r.mode) return `<span class="txt-warn">it does nothing by itself</span> <span class="qs-dim">— RPi ALERT 0.23 and later get their own link back</span>`;
    return (r.mode === 'off' ? '<span class="txt-warn">' + esc(RECOVER.off) + '</span>' : esc(RECOVER[r.mode] || r.mode));
  }

  function lostHtml(s) {
    const o = (((s.status || {}).recovery || {}).outages || []).filter(x => x && isFinite(x.began) && isFinite(x.ended));
    if (!o.length) return '';
    const one = (x) => {
      const steps = (x.steps || []).map(st => (RECOVER_STEP[st.what] || st.what) + (st.ok ? '' : ' (did not work' + (st.n > 1 ? ', ' + st.n + ' times' : '') + ')')).join(', ');
      return `${esc(when(x.began))} for ${esc(span((x.ended - x.began) / 1000))}${x.kind ? ' — ' + esc(RECOVER_KIND[x.kind] || x.kind) : ''}; back ${esc(x.how ? (RECOVER_HOW[x.how] || x.how) : 'by itself')}`
        + (steps ? `<div class="small qs-dim">It ${esc(steps)}.</div>` : '');
    };
    return one(o[0]) + (o.length > 1 ? `<details class="small"><summary>${o.length - 1} more, as the station tells it</summary>${o.slice(1).map(x => `<div>${one(x)}</div>`).join('')}</details>` : '');
  }

  // ── telling the administrators (0113) ────────────────────────────────────
  // One switch for all of them, and how long a base station is unheard before
  // a message goes. Who else should be told, and about what, is #216.
  const MAIL_WAITS = [10, 15, 30, 60, 120];

  function mailHtml() {
    if (mail == null) return '';
    if (mail === false) return `<p class="small qs-dim">Nobody is emailed when a base station goes offline: the database does not have that yet — apply db/migrations/0113_base_station_mail.sql.</p>`;
    const last = (mail.recent || [])[0];
    const waits = MAIL_WAITS.includes(mail.after_min) ? MAIL_WAITS : MAIL_WAITS.concat(mail.after_min).sort((a, b) => a - b);
    const people = mail.people === 1 ? 'the one administrator is' : 'the ' + mail.people + ' administrators are';
    return `<div class="bs-mail small" style="margin-top:.75rem">
      <p>${!mail.on ? '<span class="txt-warn">Nobody is emailed when a base station goes offline.</span>'
        : !mail.ready ? `<span class="txt-warn">No email can be sent yet</span> — the mail key is not set (<a href="${esc(docUrl('docs/accounts.md'))}" target="_blank" rel="noopener">how</a>). Once it is, ${esc(people)} emailed when a base station has not checked in for ${esc(mail.after_min)} minutes, and again when it is back.`
        : `<strong>Emails:</strong> ${esc(people)} emailed when a base station has not checked in for
          <label class="sr-only" for="bs-mail-after">Minutes without a check-in before the email</label>
          <select id="bs-mail-after" style="width:auto;display:inline-block" onchange="BaseStations.mailSet(null, Number(this.value))">${waits.map(n => `<option value="${n}"${n === mail.after_min ? ' selected' : ''}>${n} minutes</option>`).join('')}</select>,
          and again when it is back.`}
        <button class="exp-btn-sm" onclick="BaseStations.mailSet(${mail.on ? 'false' : 'true'}, null)">${mail.on ? 'Turn these emails off' : 'Turn these emails on'}</button></p>
      ${last ? `<p class="qs-dim">Last told: ${esc(last.label)} offline, ${esc(ago(last.down_told_at))}${last.up_told_at && last.cleared_at ? ' — and back, ' + esc(ago(last.up_told_at)) : last.cleared_at ? ' — back since' : ' — not back yet'}.</p>` : ''}
      ${mailMsg ? `<p class="${esc(mailMsg.cls)}" role="status">${esc(mailMsg.text)}</p>` : ''}
    </div>`;
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

  // The station's decoder (receivers.sdr.decoder, RPi ALERT 0.16+).
  const DECODERS = [['lean', 'Lean — about a third of the work (default from 0.17)'], ['full', 'Full — the original decoder'],
    ['compare', 'Compare — both on every burst, to check Lean']];
  // RPi ALERT 0.19 and later: light, and lean checked against it.
  const DECODERS_19 = [['light', 'Light — about half of Lean\'s work again'], ['compare-light', 'Compare light — Lean sent, Light checked on every burst']];
  const decodersFor = s => (cmpVersion(s.version || '0', '0.19.0') >= 0 ? DECODERS.concat(DECODERS_19) : DECODERS);
  const DECODER_MEANING = 'How the station reads a burst. Lean filters each carrier guess once, about a third of the Full decoder\'s work, '
    + 'and read the same in 99.9% of 11,628 bursts at 18 Bateson. Compare runs both on every burst and counts where they differ — '
    + 'the readings sent are still the chosen one\'s — so it costs more than either. Light (RPi ALERT 0.19) filters the burst down to 48 kHz first: '
    + 'about half of Lean\'s work again, as many true readings in every test; Compare light sends Lean\'s readings and checks Light against them.';

  // What the station's decoders do between bursts (receivers.sdr.watch, RPi ALERT 0.18+).
  const WATCHES = [['always', 'Filter every sample (as before)'], ['bursts', 'Filter only around bursts'], ['check', 'Check — both, and count where they differ']];
  const WATCH_MEANING = 'Each channel\'s decoder used to filter the stick\'s whole window all the time, burst or not. Around bursts, it watches the '
    + 'channel 25 times a second and filters only from a second before something shows: from 2½ times less work at 240 kHz to 20 times less at 2.4 MHz. '
    + 'Check runs both and counts readings only one of them got; the readings sent are the first\'s.';

  // A stick's checks, as its status reports them: lean against full (receivers.sdr.decoder
  // 'compare'), and around bursts against always (receivers.sdr.watch 'check').
  function checksHtml(r) {
    const out = [], n = v => Number(v || 0).toLocaleString();
    const l = r.lean_check;
    // pair: which two (RPi ALERT 0.19: 'full-lean' or 'lean-light'); before, full against lean.
    const [hv, lt] = l && l.pair === 'lean-light' ? ['Lean', 'Light'] : ['Full', 'Lean'];
    if (l && l.compared) out.push(`${termHtml(lt + ' check', 'The station decodes every burst both ways (Decoder: Compare' + (lt === 'Light' ? ' light' : '') + ') and counts bursts the two read differently.')}: `
      + `${n(l.differ)} of ${n(l.compared)} bursts differ (${(100 * l.differ / l.compared).toFixed(2)}%)${l.time_pct != null ? ' · ' + lt.toLowerCase() + ' ' + esc(Number(l.time_pct)) + '% of ' + hv.toLowerCase() + '\'s time' : ''}`);
    const w = r.watch_check;
    if (w && (w.both || w.only_always || w.only_watch)) out.push(`${termHtml('Around-bursts check', 'Between bursts: Check. Readings both ways, and readings only one of the two decoders got.')}: `
      + `${n(w.both)} read both ways, ${n(w.only_always)} only filtering always, ${n(w.only_watch)} only around bursts`
      + (w.awake_pct != null ? ` · awake ${esc(Number(w.awake_pct))}%` : '') + (w.time_pct != null ? ` · ${esc(Number(w.time_pct))}% of the work` : ''));
    return out.map(x => `<div class="qs-dim">${x}</div>`).join('');
  }

  function formFrom(cfg, rx) {
    const sd = (cfg.receivers || {}).sdr || {};
    const f = {
      name: cfg.name || '', enabled: (cfg.meganet || {}).enabled !== false, receptions: (cfg.meganet || {}).receptions !== false,
      sdrOn: sd.enabled !== false, freq: sd.freqHz ? chansText(chansOf(sd.freqHz, sd.moreChannels), sd.format) : '', format: sd.format || 'BINARY',
      gain: sd.gainDb == null ? 'auto' : String(sd.gainDb), ppm: String(sd.ppm || 0), squelch: String(sd.squelchDb ?? 8), rate: String(sd.sampleRate || 0),
      // RPi ALERT 0.16 and later (MegaNet #259); absent on older stations, and then not offered.
      decoder: sd.decoder || '',
      // RPi ALERT 0.18 and later (MegaNet #259 part 2).
      watch: sd.watch || '',
      // RPi ALERT 0.20 and later: the window's limits; null where the station has none.
      rmin: sd.sampleRateMin === undefined ? null : String(sd.sampleRateMin || 0), rmax: sd.sampleRateMax === undefined ? null : String(sd.sampleRateMax || 0),
      audio: (cfg.audio || {}).enabled === false ? 'off' : ((cfg.audio || {}).mode || 'auto'), volume: String((cfg.audio || {}).volume ?? 80),
      kiosk: (cfg.kiosk || {}).mode || 'auto', tz: (cfg.system || {}).timezone || '',
      // RPi ALERT 0.23 and later: what it does by itself when it loses touch.
      recover: (cfg.recover || {}).mode || '',
    };
    const own = (cfg.receivers || {}).sdrDevices || [];
    for (const r of rx.filter(x => x.kind === 'sdr')) {
      const e = stickEntry(own, r) || {};
      // Its channels: its own list, if it has its own channel or more channels
      // (the rest from every stick's), or blank — every stick's.
      const ownChans = e.freqHz !== undefined || e.moreChannels !== undefined;
      const chans = ownChans ? chansText(chansOf(e.freqHz !== undefined ? e.freqHz : sd.freqHz, e.moreChannels !== undefined ? e.moreChannels : sd.moreChannels), e.format || sd.format) : '';
      f['s:' + r.key] = { name: e.name || '', freq: chans, freq0: chans, format: e.format || '',
        gain: e.gainDb === undefined ? '' : e.gainDb === null ? 'auto' : String(e.gainDb), rate: e.sampleRate === undefined ? '' : String(e.sampleRate),
        rmin: e.sampleRateMin === undefined ? '' : String(e.sampleRateMin), rmax: e.sampleRateMax === undefined ? '' : String(e.sampleRateMax), on: e.enabled !== false };
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
      if ((cfg.recover || {}).mode && f.recover && f.recover !== cfg.recover.mode) put('recover.mode', f.recover);
      if (f.sdrOn !== (sd.enabled !== false)) put('receivers.sdr.enabled', f.sdrOn);
      // Every stick's channels: the first its own channel, the rest more
      // channels — each sent only if it changed (a first channel changed
      // alone keeps Flood-Net's standard ones around it, as the station does).
      const list = parseChans(f.freq, '');
      if (list[0].freqHz !== sd.freqHz) put('receivers.sdr.freqHz', list[0].freqHz);
      if (sd.moreChannels !== undefined || list.length > 1) {
        if (canon(moreOf(list)) !== canon(sd.moreChannels || [])) put('receivers.sdr.moreChannels', moreOf(list));
      }
      if (f.format !== sd.format) put('receivers.sdr.format', f.format);
      const gain = /^(auto|agc)$/i.test(f.gain.trim()) ? null : num(f.gain, 'the gain is 0–60 dB, or auto', 0, 60);
      if (gain !== (sd.gainDb ?? null)) put('receivers.sdr.gainDb', gain);
      const ppm = num(f.ppm, 'the correction is -200…200 ppm', -200, 200);
      if (ppm !== (sd.ppm || 0)) put('receivers.sdr.ppm', ppm);
      const sq = num(f.squelch, 'the squelch is 2–40 dB', 2, 40);
      if (sq !== (sd.squelchDb ?? 8)) put('receivers.sdr.squelchDb', sq);
      if (Number(f.rate) !== (sd.sampleRate || 0)) put('receivers.sdr.sampleRate', Number(f.rate));
      if (sd.decoder !== undefined && f.decoder && f.decoder !== sd.decoder) put('receivers.sdr.decoder', f.decoder);
      if (sd.watch !== undefined && f.watch && f.watch !== sd.watch) put('receivers.sdr.watch', f.watch);
      if (f.rmin != null && f.rmax != null) {
        const lo = Number(f.rmin), hi = Number(f.rmax);
        if (Number(f.rate) === 0 && lo && hi && lo > hi) throw new Error('No narrower than is wider than No wider than — make the narrowest the narrower');
        if (lo !== (sd.sampleRateMin || 0)) put('receivers.sdr.sampleRateMin', lo);
        if (hi !== (sd.sampleRateMax || 0)) put('receivers.sdr.sampleRateMax', hi);
      }
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
          for (const k of ['name', 'format', 'gainDb', 'sampleRate', 'sampleRateMin', 'sampleRateMax', 'enabled']) delete e[k];
          if (v.name && v.name.trim()) e.name = v.name.trim();
          // Its channels, as typed: blank is every stick's; untouched, as they were.
          if (v.freq0 === undefined || (v.freq || '').trim() !== (v.freq0 || '').trim()) {
            delete e.freqHz; delete e.moreChannels;
            if (v.freq && v.freq.trim()) {
              const list = parseChans(v.freq, r.name + ': ');
              e.freqHz = list[0].freqHz; e.moreChannels = moreOf(list);
            }
          }
          if (v.format) e.format = v.format;
          if (v.gain && v.gain.trim()) e.gainDb = /^(auto|agc)$/i.test(v.gain.trim()) ? null : num(v.gain, r.name + ': a gain of 0–60 dB, or auto', 0, 60);
          if (v.rate !== undefined && v.rate !== '') e.sampleRate = Number(v.rate);
          if (v.rmin !== undefined && v.rmin !== '') e.sampleRateMin = Number(v.rmin);
          if (v.rmax !== undefined && v.rmax !== '') e.sampleRateMax = Number(v.rmax);
          if (e.sampleRateMin && e.sampleRateMax && e.sampleRateMin > e.sampleRateMax) throw new Error(r.name + ': No narrower than is wider than No wider than');
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
    const has288 = cmpVersion(s.version || '0', NEW_288) >= 0;
    const wins = has288 ? WINDOWS : WINDOWS.filter(w => w[0] !== '288000'), lims = has288 ? LIMITS : LIMITS.filter(w => w[0] !== '288000');
    // A fold: its name, what it is set to, and its fields. Open or shut as it
    // was before the poll.
    const fold = (key, title, sum, body) => `<details class="bs-fold" data-fold="${esc(key)}"${openFolds.has(key) ? ' open' : ''} ontoggle="BaseStations.fold(this)">
        <summary><span class="bs-fold-t">${title}</span><span class="bs-fold-s">${esc(sum)}</span></summary><div class="bs-fold-body">${body}</div></details>`;
    const winSum = (rate, lo, hi) => (rate && rate !== '0' ? (WIDTH[rate] || rate) + ' window, as set' : 'automatic window'
      + (lo && lo !== '0' ? ', no narrower than ' + WIDTH[lo] : '') + (hi && hi !== '0' ? ', no wider than ' + WIDTH[hi] : ''));
    const SOUND = { auto: 'automatic', live: 'real audio only', synth: 're-made bursts', beep: 'beeps', off: 'off' };
    const SCREEN = { auto: 'dashboard on a monitor', on: 'dashboard always', off: 'text console' };
    return `<h3>Settings</h3>
      <p class="small">Sent to the station as one request, and changed there through the checks its own page uses. Never from here: its ingest token, where readings go, its web page's password, its SSH keys, or what it lets Flood-Net do.</p>
      ${fold('station', 'This station', (f.name || 'no name') + ' · ' + (f.enabled ? 'sending readings' + (f.receptions ? ' and every frame' : '') : 'not sending'), `<div class="bs-form">
        ${inp('name', 'Name of the base station', ' maxlength="80"')}
        ${chk('enabled', 'Send readings to Flood-Net')}
        ${chk('receptions', 'Send every frame heard (Reception Map)')}
        ${f.recover ? sel('recover', 'When it loses touch with Flood-Net', RECOVER_MODES) : ''}
      </div>`)}
      ${fold('every', 'RTL-SDR — every stick', [f.sdrOn ? (f.freq || '—') + ' MHz' : 'RTL-SDR sticks off', winSum(f.rate, f.rmin, f.rmax), 'gain ' + f.gain + (f.gain === 'auto' ? '' : ' dB')].join(' · '), `<div class="bs-form">
        ${chk('sdrOn', 'Use RTL-SDR sticks')}
        ${inp('freq', termHtml('Channels, MHz', WINDOW_WORDS.chans[1]), ' inputmode="decimal" placeholder="151.500, 151.525"')}
        ${sel('format', 'Frame format', Object.entries(FORMATS))}
        ${inp('gain', 'Gain, dB (or auto)')}
        ${inp('ppm', 'Correction, ppm', ' inputmode="numeric"')}
        ${inp('squelch', 'Squelch, dB', ' inputmode="numeric"')}
        ${sel('rate', termHtml('Window', WINDOW_WORDS.window[1]), [['0', 'Automatic — the narrowest that holds the channels']].concat(wins))}
        ${f.rmin != null ? sel('rmin', termHtml(WINDOW_WORDS.min[0], WINDOW_WORDS.min[1]), lims) + sel('rmax', termHtml(WINDOW_WORDS.max[0], WINDOW_WORDS.max[1]), lims) : ''}
        ${f.decoder ? sel('decoder', termHtml('Decoder', DECODER_MEANING), decodersFor(s)) : ''}
        ${f.watch ? sel('watch', termHtml('Between bursts', WATCH_MEANING), WATCHES) : ''}
      </div>
      ${f.decoder ? `<p class="small qs-dim"><strong>Decoder:</strong> ${esc(DECODER_MEANING)}</p>` : ''}
      ${f.watch ? `<p class="small qs-dim"><strong>Between bursts:</strong> ${esc(WATCH_MEANING)}</p>` : ''}
      ${Object.values(WINDOW_WORDS).filter(([w]) => f.rmin != null || (w !== WINDOW_WORDS.min[0] && w !== WINDOW_WORDS.max[0])).map(([w, m]) => `<p class="small qs-dim"><strong>${esc(w)}:</strong> ${esc(m)}</p>`).join('')}`)}
      ${sticks.map(r => {
        const v = f['s:' + r.key] || {};
        const k = escAttr(r.key);
        const own = [v.name && 'name', v.freq && 'channels', v.format && 'format', v.gain && 'gain', v.rate && 'window', (v.rmin || v.rmax) && 'window limits', v.on === false && 'off'].filter(Boolean);
        const n = Array.isArray(r.channels) && r.channels.length ? r.channels.length : 1;
        const sum = [v.on === false ? 'not used' : r.state === 'running' ? 'receiving' : r.state || '', n + ' channel' + (n === 1 ? '' : 's') + (r.sample_rate ? ' in ' + (WIDTH[String(r.sample_rate)] || r.sample_rate) : ''),
          own.length ? 'its own ' + own.join(', ') : 'all as above'].filter(Boolean).join(' · ');
        return fold('s:' + r.key, esc(r.name) + ` <span class="small qs-dim">${esc(r.usb_port ? 'USB port ' + r.usb_port : r.key)}</span>`, sum, `
          <p class="small qs-dim">Blank: as for every stick, above.</p>${stickNowHtml(r)}<div class="bs-form">
          <label>Name <input type="text" maxlength="60" value="${esc(v.name)}" placeholder="${esc(r.name)}" oninput="BaseStations.stick('${k}', 'name', this.value)"></label>
          <label>${termHtml('Channels, MHz', WINDOW_WORDS.chans[1])} <input type="text" inputmode="decimal" value="${esc(v.freq)}" placeholder="${esc(f.freq)}" oninput="BaseStations.stick('${k}', 'freq', this.value)"></label>
          <label>Format <select onchange="BaseStations.stick('${k}', 'format', this.value)"><option value="">As above</option>${Object.entries(FORMATS).map(([fv, t]) => `<option value="${fv}"${v.format === fv ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label>Gain, dB <input type="text" value="${esc(v.gain)}" placeholder="${esc(f.gain)}" oninput="BaseStations.stick('${k}', 'gain', this.value)"></label>
          <label>${termHtml('Window', WINDOW_WORDS.window[1])} <select onchange="BaseStations.stick('${k}', 'rate', this.value)"><option value="">As above</option>${[['0', 'Automatic']].concat(wins).map(([wv, t]) => `<option value="${wv}"${v.rate === wv ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          ${f.rmin != null ? ['rmin', 'rmax'].map(lk => `<label>${termHtml(WINDOW_WORDS[lk === 'rmin' ? 'min' : 'max'][0], WINDOW_WORDS[lk === 'rmin' ? 'min' : 'max'][1])} <select onchange="BaseStations.stick('${k}', '${lk}', this.value)"><option value="">As above</option>${lims.map(([wv, t]) => `<option value="${wv}"${v[lk] === wv ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`).join('') : ''}
          <label class="ser-check"><input type="checkbox"${v.on !== false ? ' checked' : ''} onchange="BaseStations.stick('${k}', 'on', this.checked)"> Use this stick</label>
        </div>`);
      }).join('')}
      ${fold('sound', 'Sound, screen and clock', ['chirps ' + (SOUND[f.audio] || f.audio), 'volume ' + f.volume, SCREEN[f.kiosk] || f.kiosk, f.tz || 'time zone not set'].join(' · '), `<div class="bs-form">
        ${sel('audio', 'Chirps', [['auto', 'Automatic'], ['live', 'Only an SDR\'s real audio'], ['synth', 'A re-made burst per reading'], ['beep', 'A beep per reading'], ['off', 'Off']])}
        ${inp('volume', 'Volume, 0–100', ' inputmode="numeric"')}
        ${sel('kiosk', 'Screen', [['auto', 'Dashboard on a connected monitor'], ['on', 'Always, when a monitor is connected'], ['off', 'Text console only']])}
        ${inp('tz', 'Time zone', ' placeholder="Australia/Brisbane"')}
      </div>`)}
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

  const SUB_WORDS = {
    overview: ['Overview', 'What the station is doing now — its health, receivers and software — and its settings, folded into sections.'],
    requests: ['Requests', 'What was asked of this station from here, by whom, and what became of each.'],
    log: ['Log', 'The last lines of the station\'s own log, when asked for.'],
  };

  function subTabsHtml(s) {
    const waiting = ((detail && detail.commands) || []).filter(c => c.status === 'queued' || c.status === 'sent').length;
    const label = { overview: 'Overview', requests: 'Requests' + (waiting ? ' (' + waiting + ' waiting)' : ''), log: 'Log' + (logShown && logShown.id === s.id ? '' : '') };
    return `<div class="pill-row bs-subtabs" role="group" aria-label="What to show of ${esc(s.label)}">${Object.keys(SUB_WORDS).map(k =>
      `<button type="button" class="pill${subTab === k ? ' is-on' : ''}" aria-pressed="${subTab === k}" data-sub="${k}" title="${esc(SUB_WORDS[k][1])}"
        onclick="BaseStations.sub('${k}')">${esc(label[k])}</button>`).join('')}</div>`;
  }

  function detailHtml() {
    const s = stationOf();
    if (!s) return '';
    const sub = s.managed ? subTab : 'overview';
    const body = sub === 'requests' ? `<div id="bs-requests">${requestsHtml()}</div>`
      : sub === 'log' ? `<div id="bs-log">${logHtml(s) || '<p class="small">This station cannot be asked for its log.</p>'}</div>`
      : `${s.managed ? `<div class="bs-cols"><div>${healthHtml(s)}</div><div>${uplinkHtml(s)}${softwareHtml(s)}</div></div>` : ''}
      ${receiversHtml(s)}
      ${s.managed ? accessHtml(s) : ''}
      <div id="bs-settings">${settingsHtml(s)}</div>`;
    return `<section class="panel bs-detail" aria-labelledby="bs-detail-h">
      ${headHtml(s)}
      ${detailErr ? `<p class="small txt-bad">${esc(detailErr)}</p>` : ''}
      ${askErr ? `<p class="small txt-bad">${esc(askErr)}</p>` : ''}
      ${actionsHtml(s)}
      ${s.managed ? subTabsHtml(s) : ''}
      ${body}
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
    // What was decoded on a frequency, and the licences, are what Steady
    // signals judges by: it is read again whenever they arrive.
    paintSt();
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

  // ── what sits there all the time (0111) ──────────────────────────────────
  // A waterfall shows a band that never goes away and says nothing about it.
  // The database folds each stick's spectrum rows by the hour into the level
  // every frequency was at or above in nine minutes of ten
  // (base_station_spectrum_hourly); BandSmarts (base-station-bands.js) finds
  // what stands out of that, and says what each probably is from what can be
  // checked — the middle of the window, the other stick, a retune, the time
  // of day, a computer clock's multiples, the ACMA's licences, the traffic
  // decoded there — and whether it matters to a channel the station decodes.
  // Folded hourly, so half an hour between polls is plenty.

  const ST_DAYS = [2, 7];
  const ST_MS = 1800000;
  const ST_SURE = { sure: '', likely: 'Probably', maybe: 'Possibly' };
  const ACMA_INTERFERENCE_URL = 'https://www.acma.gov.au/radio-reception-and-interference';
  // { id, days, r, err } — r as the database answered.
  let st = null, stDays = 2, stBusy = false;

  const stTerm = (k, text) => { const w = BandSmarts.WORDS.find(x => x[0] === k); return termHtml(text || w[1], w[2]); };
  // A band's frequency: exact where it is known to be a channel or licence,
  // else as fine as the stick's bins are.
  const stFreq = b => (b.v.approx ? '≈ ' + (b.v.show_hz / 1e6).toFixed(b.bin_hz >= 5000 ? 2 : 3) : mhz(b.v.show_hz));
  const stWhen = t => new Date(t * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // What the tab already knows, for BandSmarts: the sticks' names, where the
  // station is, the channels it decodes, what it heard on each (the Channel
  // by channel panel's window) and the ACMA's licences near it once loaded.
  function stCtx(s) {
    const names = {};
    for (const k of wfSticks(s)) names[k.key] = k.name;
    const site = (st && st.r && st.r.site) || (ch && ch.r && ch.r.site) || null;
    return { names, lon: site ? site.lon : null, listening: chListening(s).filter(l => l.running),
      heard: ch && ch.id === s.id && ch.r ? (ch.r.channels || []).map(c => ({ f: Number(c.f), n: Number(c.n || 0), ok: Number(c.ok || 0) })) : [],
      acma: chAcma && !chAcma.loading && !chAcma.err ? chAcma.list : null };
  }

  function stRead(s) {
    if (!st || st.id !== s.id || !st.r) return null;
    return BandSmarts.analyse(st.r.rows || [], stCtx(s));
  }

  // A stick's window as a line: the level each frequency never dropped below
  // (solid) and its usual level (faint), its bands numbered and its channels
  // ticked along the bottom.
  function stSvg(k, listening) {
    const W = 600, H = 120, top = 16, bot = 14, n = k.steady.length, max = 50;
    const x = i => (i + 0.5) / n * W, y = v => top + (1 - Math.min(max, Math.max(0, v)) / max) * (H - top - bot);
    const path = a => Array.from(a).map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
    const fx = hz => (hz - (k.center_hz - k.rate / 2)) / k.rate * W;
    const bands = k.bands.map((b, i) => {
      const x0 = fx(b.lo_hz), w = Math.max(3, fx(b.hi_hz) - x0);
      return `<rect class="bs-st-band bs-st-band--${esc(b.v.impact.k)}" x="${x0.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${H - top - bot}"></rect>`
        + `<text class="bs-st-n" x="${(x0 + w / 2).toFixed(1)}" y="11" text-anchor="middle">${i + 1}</text>`;
    }).join('');
    const ticks = listening.filter(l => l.f * 1e6 >= k.center_hz - k.rate / 2 && l.f * 1e6 <= k.center_hz + k.rate / 2)
      .map(l => `<line class="bs-st-chan" x1="${fx(l.f * 1e6).toFixed(1)}" x2="${fx(l.f * 1e6).toFixed(1)}" y1="${H - bot}" y2="${H - bot + 5}"></line>`).join('');
    const edge = (1 - WF_USABLE) / 2 * W;
    return `<svg class="bs-st-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
        aria-label="${esc(k.name)}: the level each frequency never dropped below, ${esc(mhz(k.center_hz - k.rate / 2))} to ${esc(mhz(k.center_hz + k.rate / 2))} MHz, with ${k.bands.length} band${k.bands.length === 1 ? '' : 's'} marked">
      <rect class="bs-st-edge" x="0" y="${top}" width="${edge}" height="${H - top - bot}"></rect>
      <rect class="bs-st-edge" x="${W - edge}" y="${top}" width="${edge}" height="${H - top - bot}"></rect>
      ${bands}<path class="bs-st-typ" d="${path(k.typ)}"></path><path class="bs-st-line" d="${path(k.steady)}"></path>${ticks}
      <text class="bs-st-ax" x="2" y="${H - 2}">${esc(mhz(k.center_hz - k.rate / 2))}</text>
      <text class="bs-st-ax" x="${W / 2}" y="${H - 2}" text-anchor="middle">${esc(mhz(k.center_hz))} MHz</text>
      <text class="bs-st-ax" x="${W - 2}" y="${H - 2}" text-anchor="end">${esc(mhz(k.center_hz + k.rate / 2))}</text>
    </svg>`;
  }

  function stThereHtml(b) {
    const share = Math.round(b.share * 100) + '% of ' + b.hours + ' h';
    const since = b.whole ? 'the whole time looked at' : b.since_t ? 'without a break since ' + stWhen(b.since_t) : 'not in the last hour';
    const when = b.when === 'day' ? 'By day only.' : b.when === 'night' ? 'At night only.' : '';
    return `${esc(share)}<div class="qs-dim">${esc(since)}</div>${when ? `<div>${esc(when)}</div>` : ''}`;
  }

  function stStickHtml(k, s) {
    const listening = chListening(s);
    const rx = receiversOf(s).find(r => String(r.key).slice(-80) === k.key);
    const head = `<h3>${esc(k.name)} <span class="small qs-dim">${esc(mhz(k.center_hz - k.rate / 2))}–${esc(mhz(k.center_hz + k.rate / 2))} MHz · ${k.hours} h judged`
      + `${rx ? ' · ' + (rx.gain_db == null ? 'gain auto' : 'gain ' + esc(rx.gain_db) + ' dB') : ''}${k.retuned ? ' · retuned in this time' : ''}</span></h3>`;
    const floor = k.floor && k.floor.swing >= 4
      ? `<p class="small"><strong class="txt-warn">Its ${stTerm('floor', 'noise floor')} moves by ${esc(k.floor.swing)} dB through the day</strong>${k.floor.high === 'day' ? ', highest by day: noise at the site that comes with the sun, which points at solar gear' : k.floor.high === 'night' ? ', highest at night: something that runs then, such as lighting' : ''}. While it is up, every station sounds that much weaker.</p>` : '';
    if (!k.bands.length) return `<div class="bs-st-stick">${head}${stSvg(k, listening)}<p class="small"><span class="txt-ok">Nothing steady stands out.</span> Whatever shows on its waterfall comes and goes.</p>${floor}</div>`;
    const rows = k.bands.map((b, i) => `<tr>
        <th scope="row"><span class="bs-st-no">${i + 1}</span> ${esc(stFreq(b))} <span class="small qs-dim">MHz</span>${b.steady ? '' : `<div class="small"><span class="badge term-chip" title="${esc(BandSmarts.WORDS.find(w => w[0] === 'busy')[2])}">busy, not constant</span></div>`}</th>
        <td class="small">${esc(BandSmarts.kHz(b.width_hz))}</td>
        <td class="small">${esc(Math.round(b.over_db))} dB</td>
        <td class="small">${stThereHtml(b)}</td>
        <td class="small"><strong>${ST_SURE[b.v.sure] ? esc(ST_SURE[b.v.sure]) + ': ' : ''}${esc(b.v.title)}</strong>${b.v.why.map(w => `<div class="qs-dim">${esc(w)}</div>`).join('')}</td>
        <td class="small"><span class="${b.v.impact.cls}">${esc(b.v.impact.text)}</span></td>
        <td class="small">${b.v.todo.map(t => `<div>${esc(t)}</div>`).join('')}</td>
      </tr>`).join('');
    return `<div class="bs-st-stick">${head}${stSvg(k, listening)}
      <div class="table-wrap" role="region" tabindex="0" aria-label="${esc(k.name)}: its steady signals"><table class="adm-table bs-st-t">
        <caption class="sr-only">${esc(k.name)}: each steady signal, how wide and strong it is, how much of the time it is there, what it probably is, whether it matters and what to do</caption>
        <thead><tr><th scope="col" class="bs-st-f">Frequency</th><th scope="col">${stTerm('width')}</th><th scope="col">${stTerm('over')}</th><th scope="col">${stTerm('there')}</th>
          <th scope="col" class="bs-wide">What it probably is</th><th scope="col" class="bs-st-m">Does it matter</th><th scope="col" class="bs-wide">What to do</th></tr></thead>
        <tbody>${rows}</tbody></table></div>${floor}</div>`;
  }

  function stSummaryHtml(s, a) {
    if (!st || st.id !== s.id) return 'Loading…';
    if (st.err) return `<span class="txt-bad">${esc(st.err)}</span>`;
    if (!a.sticks.length && !a.waiting.length) return 'No hours folded for this station yet. Each stick\'s spectrum is folded on the hour, so the first appear within an hour or so of its first rows (RPi ALERT 0.13.5 or later), and a stick is judged once it has three.';
    const c = a.counts, bits = [];
    if (c.on) bits.push(`<strong class="txt-bad">${c.on} sit${c.on === 1 ? 's' : ''} on a channel it decodes</strong>`);
    if (c.beside) bits.push(`<strong class="txt-warn">${c.beside} strong beside a channel</strong>`);
    if (c.strong) bits.push(`<strong class="txt-warn">${c.strong} strong enough to matter anywhere</strong>`);
    if (c.unknown) bits.push(c.unknown + ' not identified yet');
    const hours = Math.max(0, ...a.sticks.map(k => k.hours));
    return (a.sticks.length ? (c.bands ? `Over the ${hours} hours judged: <strong>${c.steady} ${stTerm('steady', c.steady === 1 ? 'steady signal' : 'steady signals')}</strong>`
        + (c.bands - c.steady ? ` and ${c.bands - c.steady} ${stTerm('busy', 'busy, not constant')}` : '') + (bits.length ? ' — ' + bits.join(', ') : ' — none of them on or beside a channel it decodes') + '.'
        : `Over the ${hours} hours judged, nothing steady stands out on any stick.`) : '')
      + a.waiting.map(w => ` ${esc(w.name)} has ${w.hours} hour${w.hours === 1 ? '' : 's'} folded so far and is judged from three.`).join('')
      + (st.r.to ? ` <span class="qs-dim">Folded to ${esc(new Date(st.r.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}.</span>` : '')
      + (chAcma && chAcma.loading ? ' <span class="qs-dim">The ACMA licences are still loading.</span>' : '');
  }

  function stFoldsHtml() {
    return `<details class="rd-fold"><summary><h3 class="bk-inline-h">Tests that tell the causes apart</h3></summary>
        <dl class="rd-words">${BandSmarts.TESTS.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>
      <details class="rd-fold"><summary><h3 class="bk-inline-h">What can be done, from least effort to most</h3></summary>
        <ol class="small">
          <li><strong>Leave it.</strong> A band that is not on or beside a channel the station decodes, and not strong, costs nothing.</li>
          <li><strong>Change a setting</strong> (Settings, above): a narrower window leaves a strong neighbour out altogether; another channel list moves the stick's own centre spike off a channel; a fixed gain a few steps down stops a strong signal making the stick turn itself down.</li>
          <li><strong>Tidy the hut:</strong> the stick on a short USB extension lead away from the computer, ferrites on the USB, power and solar leads, the antenna and its feeder away from switch-mode supplies.</li>
          <li><strong>Fit a filter</strong> on the antenna lead: a band-pass for 148–153 MHz keeps out FM broadcast, pagers and anything far off the band; a notch takes out one strong neighbour; a cavity filter is the cure when the neighbour is on the same hill.</li>
          <li><strong>Talk to whoever holds the frequency.</strong> The licence found names them; most cases end with a phone call.</li>
          <li><strong>Report it to the ${stTerm('acma')}.</strong> See below.</li>
        </ol></details>
      <details class="rd-fold"><summary><h3 class="bk-inline-h">When to report something to the ACMA</h3></summary>
        <p class="small">The ACMA looks into interference to licensed radiocommunications services, and transmitters with no licence. It expects your own equipment to be ruled out first, so report a band only when all of these hold:</p>
        <ul class="small">
          <li>it is on the air — it goes when the antenna comes off, or a second receiver away from the hut hears it;</li>
          <li>no licence is found for it, or it is on or beside a frequency your own network is licensed for;</li>
          <li>it costs you reception — the table says it sits on, or swamps, a channel the station decodes.</li>
        </ul>
        <p class="small">Have ready: the frequency, when it is there (the table), a picture of the waterfall, where the base station is, and the licence number of the service it affects (📜 ACMA licences on the Stations map). <a href="${ACMA_INTERFERENCE_URL}" target="_blank" rel="noopener">Radio reception and interference — acma.gov.au</a></p></details>
      <details class="rd-fold"><summary><h3 class="bk-inline-h">What the words on this page mean</h3></summary>
        <dl class="rd-words">${BandSmarts.WORDS.map(w => `<dt>${esc(w[1])}</dt><dd>${esc(w[2])}</dd>`).join('')}</dl></details>`;
  }

  function stShellHtml(s) {
    return `<section class="panel bs-st" aria-labelledby="bs-st-h">
      <div class="panel-header"><h2 id="bs-st-h">Steady signals: what is always there, and what it probably is</h2>
        <div class="pill-row" role="group" aria-label="How far back">${ST_DAYS.map(d => `<button type="button" class="pill${d === stDays ? ' is-on' : ''}" aria-pressed="${d === stDays}" onclick="BaseStations.stWindow(${d})">${d} days</button>`).join('')}
          <button type="button" class="pill" onclick="BaseStations.stSave()">Save as CSV</button></div></div>
      <p class="small" id="bs-st-sum" aria-live="polite"></p>
      <div id="bs-st-body"></div>
      <p class="small qs-dim">A bright band that never leaves the waterfall is found here from the level each frequency never dropped below in nine minutes of ten, hour by hour, against the frequencies either side of it. Each line is one stick's window: solid, what is always there; faint, its usual level; shaded, the window's edges; numbered, the bands in the table; ticks, the channels it decodes. What each band is put down to comes only from what can be checked from here — the reasons are listed under it — and says "possibly" or "not identified" where that is not enough. What was decoded on a frequency is taken from Channel by channel below.</p>
      ${stFoldsHtml()}
    </section>`;
  }

  function paintSt() {
    if (state.activeTab !== 'basestations') return;
    const el = document.getElementById('bs-st');
    if (!el) return;
    const s = stationOf();
    if (!isAdmin() || !s || !s.managed || !wfSticks(s).length) { if (el.innerHTML) { el.innerHTML = ''; el.dataset.sig = ''; } return; }
    const sig = s.id + ':' + stDays;
    if (el.dataset.sig !== sig || !el.firstElementChild) { el.innerHTML = stShellHtml(s); el.dataset.sig = sig; }
    const a = stRead(s) || { sticks: [], waiting: [], counts: {} };
    const set = (id, html) => { const e = document.getElementById(id); if (e && e.innerHTML !== html) keepFocus(e, () => { e.innerHTML = html; }); };
    set('bs-st-sum', stSummaryHtml(s, a));
    set('bs-st-body', a.sticks.map(k => stStickHtml(k, s)).join(''));
  }

  async function loadSt() {
    if (!isAdmin() || openId == null || stBusy) return;
    const id = openId, days = stDays;
    stBusy = true;
    try {
      const r = await dbRpc('admin_base_station_bands', { p_id: id, p_days: days });
      if (openId !== id || stDays !== days) return;
      st = { id, days, r, err: null };
    } catch (err) {
      if (openId !== id || stDays !== days) return;
      st = { id, days, r: null, err: err.status === 404 ? 'The database does not have this yet — apply db/migrations/0111_base_station_steady_signals.sql.'
        : 'Could not load its steady signals: ' + err.message };
    } finally {
      stBusy = false;
    }
    paintSt();
  }

  function stStart() {
    clearInterval(timers.st);
    timers.st = null;
    const s = stationOf();
    if (!s || !s.managed) return;
    loadSt();
    timers.st = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') loadSt(); }, ST_MS);
  }

  function stWindow(days) {
    if (!ST_DAYS.includes(days) || days === stDays) return;
    stDays = days; st = null;
    paintSt();
    loadSt();
  }

  // A table as a file: a BOM first, since these open in Excel.
  function saveCsv(name, rows) {
    dlText(name, '\ufeff' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  }
  const fileSlug = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'base-station';

  function stRows(s) {
    const a = stRead(s);
    const rows = [['Stick', 'Frequency MHz', 'Kind', 'Width kHz', 'Strength, dB over its surroundings', 'Share of hours %', 'Hours judged', 'Since', 'What it probably is', 'How sure', 'Why', 'Does it matter', 'What to do']];
    for (const k of (a && a.sticks) || []) {
      for (const b of k.bands) {
        rows.push([k.name, stFreq(b), b.steady ? 'steady' : 'busy, not constant', (b.width_hz / 1000).toFixed(1), b.over_db, Math.round(b.share * 100), b.hours,
          b.whole ? 'the whole time' : b.since_t ? new Date(b.since_t * 1000).toISOString() : '', b.v.title, b.v.sure, b.v.why.join(' '), b.v.impact.text, b.v.todo.join(' ')]);
      }
    }
    return rows;
  }

  function stSave() {
    const s = stationOf();
    if (!s) return;
    const rows = stRows(s);
    if (rows.length < 2) { announce('No steady signals to save.'); return; }
    saveCsv('floodnet-steady-signals-' + fileSlug(s.label) + '.csv', rows);
    announce('Saved ' + (rows.length - 1) + ' steady signals.');
  }

  // ── what comes in through each (0111) ────────────────────────────────────
  // A base station a row, from the reception rollups: how many stations it
  // decodes and how many messages, legacy ALERT and ALERT2 apart, what no
  // other base station hears, its receivers, and a bar a day. For every
  // ingest point at once, so it sits under the list, not in a station's panel.

  const IN_DAYS = [1, 7, 30];
  const IN_MS = 600000;
  const IN_WORDS = [
    ['in-stations', 'Stations', 'The different transmitters a base station decoded at least three times in the period: a legacy ALERT sensor ID, or an ALERT2 station address, counts as one. Three, because a single decode can be a corrupted copy of something else.'],
    ['in-messages', 'Messages decoded', 'Bursts the base station heard and read without error. "Heard" also counts the ones it could not read.'],
    ['in-legacy', 'Legacy ALERT', 'The original ALERT protocol: a short burst carrying one sensor ID and one value, with no error correction.'],
    ['in-alert2', 'ALERT2', 'The newer protocol: longer messages from a station address, with error correction and time slots. Usually a repeater or concentrator passing on what it gathered.'],
    ['in-register', 'Not in the register', 'IDs Flood-Net\'s station register does not hold: another network\'s stations, or ones not entered yet.'],
    ['in-only', 'Only here', 'Stations this base station decoded that no other base station did in the period. If this base station goes down, these go dark.'],
    ['in-share', 'ALERT2 share', 'The part of the decoded messages that came as ALERT2 rather than legacy ALERT.'],
    ['in-owner', 'Owner', 'Who owns the station sending: from the Bureau\'s Service Level Specification where it lists the station, else the owner recorded on the station. A station owned jointly is counted under each of its owners, so the rows can add up to more than the total.'],
    ['in-network', 'Radio network', 'The local radio network the register puts the station in: the repeater it reports through and the gauges round it.'],
    ['in-hub', 'Bureau region', 'The Bureau field maintenance region (hub) the station falls in.'],
    ['in-kind', 'Kind of sensor', 'For legacy ALERT, what the sensor behind the ID measures, as the register has it (rainfall, water level, battery…). For ALERT2, whether the station sending is a repeater or a field station.'],
    ['in-path', 'Relay path', 'The repeaters an ALERT2 message says it came through, in order: the first is nearest the station sending, the last is the one the base station itself heard. "Straight from the station" means it names none.'],
    ['in-few', 'Too few to count, or no ID', 'Messages decoded from an ID heard fewer than three times in the period, or with no ID read at all. Mostly corrupted copies of other messages, so they are kept apart rather than counted as stations.'],
    ['in-part', 'Share', 'This row\'s part of all the decoded messages in the table.'],
    ['in-freq', 'Frequency', 'The frequency the receiver measured the messages on, put to the nearest 6.25 kHz channel.'],
    ['in-lic', 'Licensed on it nearby', 'Who the ACMA\'s register of radio licences has on that frequency (within 6 kHz) within 300 km of the base station, nearest first. A network\'s licence holder is the agency to ask whose stations these are. It lists every licence on the frequency, not only flood networks.'],
    ['in-from', 'Heard from', 'The transmitter the base station itself heard the message from: the last repeater in its relay path, or the station itself when it came straight. A strong, steady signal from one repeater means the stations behind it belong to that repeater\'s network.'],
    ['in-snr', 'Signal', 'How far the messages stood above the noise at the receiver, on average, in dB (SNR). Higher is closer or better placed; it is the last transmitter\'s signal, not the far station\'s.'],
    ['in-since', 'First heard', 'The first day the daily records have this ID decoded at the base station, however long ago. A group of IDs that all began on one day is a network that was switched on, or a channel the base station began listening to, that day.'],
    ['in-row-share', 'Share of the row', 'This station\'s part of the decoded messages in the row it sits under.'],
    ['in-days', 'Days decoded', 'On how many of the period\'s UTC days the base station decoded this station at least once; the last day is today, so far. Decoded every day is steady. Decoded on a few days only is a station that talks mainly when it rains, or one at the edge of range.'],
    ['in-day-bars', 'A bar a day', 'Its decoded messages each UTC day, oldest on the left: legacy ALERT at the foot, ALERT2 above. Each station is drawn to its own scale, so read the shape, not the height — a gap is a day nothing of it came through. Rest the pointer on a bar for that day\'s numbers.'],
    ['in-heard-at', 'Heard at', 'The base stations that decoded it in the period, with how many of its messages each. "Only here" means no other base station decoded it, so it goes dark if this one does.'],
    ['in-quiet', 'Gone quiet', 'Decoded earlier in the period but not at all yesterday or today (UTC). Worth a look: the station, the repeater it comes through or the base station\'s reception may have stopped.'],
    ['in-clue', 'Clues', 'What else can be said from here: whether an ALERT2 address also relays others (so it is a repeater), and for a legacy ID the nearest IDs the register does hold — agencies are given IDs in blocks, so a neighbour\'s owner is a fair first guess.'],
  ];
  const inTerm = (k, text) => { const w = IN_WORDS.find(x => x[0] === k); return termHtml(text || w[1], w[2]); };
  // { days, r, err } — r as the database answered.
  let ing = null, inDays = 7, inBusy = false;
  // The breakdown under the table (0112): by what, for which base station
  // ('all' or an ingest token's id), and whether a long list is opened out.
  const IN_BY = [['owner', 'Owner'], ['network', 'Radio network'], ['hub', 'Bureau region'], ['catchment', 'Catchment'], ['lga', 'Council area'],
    ['kind', 'Kind of sensor'], ['path', 'Relay path'], ['station', 'Station by station'], ['unknown', 'Not in the register'], ['day', 'Day by day']];
  const IN_ACMA_KM = 300;    // licences this near a base station, for the stations nobody has registered
  const IN_BY_TERM = { owner: 'in-owner', network: 'in-network', hub: 'in-hub', kind: 'in-kind', path: 'in-path' };
  const IN_TOP = 25;
  let inBy = 'owner', inAt = 'all', inMore = false, inSlsAsked = false;
  // The rows opened out into their stations, by row key, and those showing every station (0124).
  const IN_OPEN_TOP = 25;
  let inOpened = new Set(), inOpenedAll = new Set();
  // How the breakdown's rows, and the stations in an opened row, are sorted:
  // a heading clicked once sorts by it (words A to Z, numbers biggest first),
  // again the other way. Busiest first until somebody picks.
  let inSort = { key: 'both', dir: -1 }, inMSort = { key: 'both', dir: -1 };
  const IN_SORT_KEYS = { label: g => String(g.label), n: g => (g.n == null ? -1 : g.n), a: g => g.a, a2: g => g.a2, both: g => g.a + g.a2, share: g => g.a + g.a2 };
  const IN_MSORT_KEYS = { name: m => inMemberName(m), id: m => Math.min(...[...m.ids.values()].map(e => Number(e.id))), a: m => m.a, a2: m => m.a2,
    both: m => m.a + m.a2, share: m => m.a + m.a2, days: m => (m.days == null ? -1 : m.days), heard: m => m.at.size };
  function inSorted(list, how, keys) {
    const f = keys[how.key] || keys.both;
    return list.slice().sort((p, q) => {
      const x = f(p), y = f(q);
      const c = typeof x === 'string' ? x.localeCompare(y, 'en-AU', { numeric: true, sensitivity: 'base' }) : x - y;
      return c * how.dir || (q.a + q.a2) - (p.a + p.a2) || String(p.label || p.key).localeCompare(String(q.label || q.key));
    });
  }
  // A heading that sorts: the control inside the cell, aria-sort on the cell (as Repeaters).
  function inSortTh(which, key, inner, cls) {
    const s = which === 'm' ? inMSort : inSort, on = s.key === key;
    return `<th scope="col"${cls ? ` class="${cls}"` : ''}${on ? ` aria-sort="${s.dir > 0 ? 'ascending' : 'descending'}"` : ''}>`
      + `<button type="button" class="th-sort" onclick="BaseStations.inSortBy('${which}', '${key}')" title="Sort by this">${inner}`
      + (on ? `<span class="th-arrow" aria-hidden="true">${s.dir > 0 ? '▲' : '▼'}</span>` : '') + '</button></th>';
  }
  // The ACMA's devices, for the unknown stations' frequencies: { loading } | { list: [{ f, client, site, lat, lon }] } | { err }.
  let inAcma = null;

  // A station's row, read: its two protocols and their totals.
  function inRead(x) {
    const p = k => (x.protocols || []).find(q => q.protocol === k) || { n: 0, ok: 0, undecoded: 0, ids: 0, known: 0, only_here: 0, last: null };
    const a = p('alert'), a2 = p('alert2'), ok = Number(a.ok) + Number(a2.ok), n = Number(a.n) + Number(a2.n);
    const days = (x.days || []).length;
    return { a, a2, ok, n, share: ok ? Number(a2.ok) / ok : null, perDay: days ? ok / days : 0,
      last: [a.last, a2.last].filter(Boolean).sort().pop() || null };
  }

  // A day's numbers in words: what its bar says on hover, a line a protocol.
  // The four numbers after the first four are 0112's; without them, what there is.
  const inPct = (a, b) => (Number(b) ? ' (' + Math.round(Number(a) / Number(b) * 100) + '%)' : '');
  function inDayName(day) {
    const t = new Date(String(day).slice(0, 10) + 'T00:00:00Z');
    const today = new Date(now()).toISOString().slice(0, 10) === String(day).slice(0, 10);
    return (isFinite(t) ? t.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : String(day)) + (today ? ' (so far)' : '');
  }
  function inDayText(v) {
    const a = Number(v[1]), a2 = Number(v[2]), n = Number(v[3]), full = v.length >= 8;
    const line = (name, ok, heard, ids, word) => name + ': ' + chN(ok) + ' decoded'
      + (full ? ' of ' + chN(heard) + ' heard' + inPct(ok, heard) + ', from ' + chN(ids) + ' ' + word + (Number(ids) === 1 ? '' : 's') : '');
    return inDayName(v[0]) + ', UTC\n' + chN(a + a2) + ' decoded of ' + chN(n) + ' heard' + inPct(a + a2, n)
      + '\n' + line('Legacy ALERT', a, v[4], v[6], 'ID') + (a + a2 ? ' — ' + Math.round(a / (a + a2) * 100) + '% of the day' : '')
      + '\n' + line('ALERT2', a2, v[5], v[7], 'station') + (a + a2 ? ' — ' + Math.round(a2 / (a + a2) * 100) + '% of the day' : '');
  }

  function inBarsHtml(x) {
    const d = x.days || [];
    if (!d.length) return '<span class="qs-dim">—</span>';
    const W = 120, H = 28, max = Math.max(1, ...d.map(v => Number(v[1]) + Number(v[2]))), w = W / d.length;
    const bars = d.map((v, i) => {
      const h1 = Number(v[1]) / max * H, h2 = Number(v[2]) / max * H;
      return `<g><title>${esc(inDayText(v))}</title><rect class="bs-in-hit" x="${(i * w).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}"></rect>`
        + `<rect class="bs-in-a" x="${(i * w).toFixed(1)}" y="${(H - h1).toFixed(1)}" width="${Math.max(1, w - 1).toFixed(1)}" height="${h1.toFixed(1)}"></rect>`
        + `<rect class="bs-in-a2" x="${(i * w).toFixed(1)}" y="${(H - h1 - h2).toFixed(1)}" width="${Math.max(1, w - 1).toFixed(1)}" height="${h2.toFixed(1)}"></rect></g>`;
    }).join('');
    return `<svg class="bs-in-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Decoded messages a day, ${esc(String(d[0][0]).slice(0, 10))} to ${esc(String(d[d.length - 1][0]).slice(0, 10))}: at most ${esc(chN(max))} in a day. Each day's numbers are under Day by day, below.">${bars}</svg>`;
  }

  function inProtoHtml(p) {
    if (!Number(p.n)) return '<span class="qs-dim">none</span>';
    const rate = Math.round(Number(p.ok) / Number(p.n) * 100);
    return `<strong>${esc(chN(p.ok))}</strong> <span class="qs-dim">of ${esc(chN(p.n))} heard (${rate}%)</span>`
      + `<div>${esc(chN(p.ids))} station${Number(p.ids) === 1 ? '' : 's'}</div>`
      + (Number(p.ids) - Number(p.known) > 0 ? `<div class="txt-warn">${esc(chN(Number(p.ids) - Number(p.known)))} not in the register</div>` : '')
      + (Number(p.only_here) ? `<div>${esc(chN(p.only_here))} only here</div>` : '');
  }

  function inRxHtml(x) {
    const by = new Map();
    for (const r of x.receivers || []) { const e = by.get(r.point_id) || { name: r.name || r.point_id, rows: [] }; e.rows.push(r); by.set(r.point_id, e); }
    if (!by.size) return '<span class="qs-dim">—</span>';
    return [...by.values()].map(e => `<div>${esc(e.name)}: ${e.rows.map(r => esc(chN(r.ok)) + ' ' + (r.protocol === 'alert2' ? 'ALERT2' : 'legacy') + ' from ' + esc(chN(r.ids))).join(', ')}</div>`).join('');
  }

  function inTableHtml() {
    const xs = (ing && ing.r && ing.r.stations) || [];
    if (!xs.length) return '';
    const several = xs.filter(x => inRead(x).ok > 0).length > 1;
    const body = xs.map(x => {
      const v = inRead(x);
      return `<tr>
        <th scope="row">${esc(x.label)}${x.host_station ? `<div class="small qs-dim">at ${esc(x.host_station)}</div>` : ''}${x.revoked ? '<div class="small"><span class="badge">token revoked</span></div>' : ''}</th>
        <td class="small"><strong>${esc(chN(Number(v.a.ids) + Number(v.a2.ids)))}</strong>${several && Number(v.a.only_here) + Number(v.a2.only_here) ? `<div>${esc(chN(Number(v.a.only_here) + Number(v.a2.only_here)))} only here</div>` : ''}</td>
        <td class="small">${inProtoHtml(v.a)}</td>
        <td class="small">${inProtoHtml(v.a2)}</td>
        <td class="small">${v.share == null ? '<span class="qs-dim">—</span>' : Math.round(v.share * 100) + '%'}</td>
        <td class="small">${v.ok ? esc(chN(Math.round(v.perDay))) : '<span class="qs-dim">—</span>'}</td>
        <td>${inBarsHtml(x)}</td>
        <td class="small">${inRxHtml(x)}</td>
        <td class="small">${v.last ? esc(ago(v.last)) : '<span class="qs-dim">nothing</span>'}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-in-h"><table class="adm-table bs-in-t">
        <caption class="sr-only">Each base station: the stations it decodes, its decoded messages as legacy ALERT and as ALERT2, the ALERT2 share, messages a day, a bar a day, its receivers and when it last heard anything</caption>
        <thead><tr><th scope="col">Base station</th><th scope="col">${inTerm('in-stations')}</th><th scope="col">${inTerm('in-legacy')}</th><th scope="col">${inTerm('in-alert2')}</th>
          <th scope="col">${inTerm('in-share')}</th><th scope="col">${inTerm('in-messages', 'Decoded a day')}</th><th scope="col">Day by day</th><th scope="col" class="bs-wide">By receiver</th><th scope="col">Last heard</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <div class="qs-legend"><span><i class="qs-sw bs-sw-in-a" aria-hidden="true"></i>legacy ALERT</span><span><i class="qs-sw bs-sw-in-a2" aria-hidden="true"></i>ALERT2</span>
        <span class="qs-dim">a bar a day (UTC), decoded messages — rest the pointer on a bar for that day's numbers, or see Day by day below</span></div>`;
  }

  // ── …and whose it is (0112) ──────────────────────────────────────────────
  // The same messages by who owns the station sending, its radio network,
  // Bureau region, catchment, council area, kind of sensor, the repeaters an
  // ALERT2 message came through, station by station, and day by day. The
  // database names each counted station (ids: [protocol, id, decoded, the
  // register's station, sensor type, only here]); what groups them is looked
  // up here, in the register the app already holds — owners mostly come from
  // the SLS, which the database does not have.

  let inStnMemo = { src: null, map: null };
  function inStn(id) {
    const list = (state.data && state.data.stations) || [];
    if (inStnMemo.src !== list) inStnMemo = { src: list, map: new Map(list.map(st => [st.id, st])) };
    return id == null ? null : inStnMemo.map.get(id) || null;
  }
  const inOwnersReady = () => typeof SLS === 'undefined' || SLS.loaded() || inSlsAsked === 'failed';
  const inNamed = (list, id) => { const e = ((state.data && state.data[list]) || []).find(q => q.id === id); return e ? e.name : id; };

  // What a counted station falls under: [[key, label]] — one, except a station
  // owned jointly, which is under each of its owners.
  function inGroupsOf(row) {
    if (inBy === 'owner' && row[3] != null && inOwnersReady()) {
      const st = inStn(row[3]), o = st && typeof stationOwner === 'function' ? stationOwner(st) : null;
      if (o && o.parties && o.parties.length > 1) return o.parties.map(p => ['o' + p, p]);
    }
    return [inGroupOf(row)];
  }
  // …one of them: [key, label]. One not in the register is its own row
  // whatever the question.
  function inGroupOf(row) {
    const [proto, id, , stationId, type] = row;
    if (stationId == null) return inBy === 'station' ? ['?' + proto + id, (proto === 'alert2' ? 'ALERT2 station ' : 'Legacy ID ') + id + ' — not in the register'] : ['?', 'Not in the register'];
    const st = inStn(stationId);
    if (inBy === 'station') return ['s' + stationId, st ? st.name : stationId];
    if (inBy === 'kind') return inKindOf(proto, type, st);
    if (!st) return ['-', 'In the register, but not in the list this browser holds'];
    if (inBy === 'owner') {
      if (!inOwnersReady()) return ['…', 'Owners still loading…'];
      const o = typeof stationOwner === 'function' ? stationOwner(st) : null;
      return o ? ['o' + o.name, o.name] : ['', 'No owner on record'];
    }
    if (inBy === 'network') { const n = (st.radio_network_ids || []).map(netName); return n.length ? ['n' + n.join('|'), n.join(' / ')] : ['', 'No radio network recorded']; }
    if (inBy === 'hub') return st.hub_id ? ['h' + st.hub_id, inNamed('hubs', st.hub_id)] : ['', 'No Bureau region recorded'];
    if (inBy === 'catchment') { const c = (st.catchment_ids || [])[0]; return c ? ['c' + c, inNamed('catchments', c)] : ['', 'No catchment recorded']; }
    return st.lga ? ['l' + st.lga, st.lga] : ['', 'No council area recorded'];
  }

  // What kind of sensor a counted ID is: the legacy sensor's type, or what the ALERT2 station is.
  function inKindOf(proto, type, st) {
    if (proto !== 'alert2') return ['k' + (type || ''), type || 'No sensor type recorded'];
    const role = st && ['repeater', 'base', 'field'].find(r => (st.roles || []).includes(r));
    return ['r' + (role || ''), 'ALERT2 ' + (role ? ROLE_LABEL[role].toLowerCase() : 'station')];
  }

  // A row's stations (0124), one counted ID at a time: a register station
  // with its IDs together (each ID apart when the rows are stations already),
  // one the register does not hold by its ID; what it decoded, where, and a
  // day at a time when the database gives the days.
  function inMember(g, row, x, nDays) {
    const [proto, id, ok, stationId, type, only] = row;
    const mk = inBy === 'station' || stationId == null ? proto + ':' + id : 's' + stationId;
    let m = g.m.get(mk);
    if (!m) {
      m = { key: mk, station: stationId, ids: new Map(), kinds: new Set(), a: 0, a2: 0, at: new Map(), only: true,
        dA: nDays ? new Array(nDays).fill(0) : null, dA2: nDays ? new Array(nDays).fill(0) : null };
      g.m.set(mk, m);
    }
    const k = proto + ':' + id, e = m.ids.get(k) || { proto, id, type, ok: 0 };
    e.ok += Number(ok);
    m.ids.set(k, e);
    m.kinds.add(inKindOf(proto, type, stationId == null ? null : inStn(stationId))[1]);
    m[proto === 'alert2' ? 'a2' : 'a'] += Number(ok);
    m.at.set(x.label, (m.at.get(x.label) || 0) + Number(ok));
    if (!only) m.only = false;
    if (nDays) { const d = proto === 'alert2' ? m.dA2 : m.dA; row[6].forEach((v, i) => { d[i] += Number(v) || 0; }); }
  }
  // …read once the rows are added up: busiest first, with its days decoded and whether it has gone quiet.
  function inMembers(g, nDays) {
    const ms = [...g.m.values()];
    for (const m of ms) {
      if (!nDays) continue;
      const t = m.dA.map((v, i) => v + m.dA2[i]);
      m.days = t.filter(v => v > 0).length;
      m.quiet = nDays >= 3 && t.slice(0, -2).some(v => v > 0) && !t.slice(-2).some(v => v > 0);
    }
    return inSorted(ms, inMSort, IN_MSORT_KEYS);
  }

  const inPathLabel = p => ((p.path || []).length
    ? 'via ' + p.path.map((a, i) => (p.names && p.names[i]) || 'address ' + a).join(', then ') : 'Straight from the station');

  // The breakdown, read: { cols, rows: [{ label, sub, ids, a, a2, only, warn, dim }], total, note } —
  // or { need } when the database is still 0111's, or { days } for day by day.
  function inBreak() {
    const all = ((ing && ing.r && ing.r.stations) || []).filter(x => inRead(x).n > 0);
    const xs = inAt === 'all' ? all : all.filter(x => String(x.id) === String(inAt));
    if (!xs.length) return { rows: [], total: 0 };
    if (inBy === 'day') {
      const by = new Map();
      for (const x of xs) for (const v of x.days || []) {
        const e = by.get(v[0]) || [v[0], 0, 0, 0, 0, 0, 0, 0];
        for (let i = 1; i < 8; i++) e[i] += Number(v[i] || 0);
        by.set(v[0], e);
      }
      return { days: [...by.values()].sort((a, b) => (a[0] < b[0] ? 1 : -1)), full: xs.every(x => (x.days || []).every(v => v.length >= 8)), one: xs.length === 1 };
    }
    if (xs.some(x => !Array.isArray(x.ids))) return { need: true };
    const by = new Map();
    let joint = false;
    // 0124: each ID's decoded messages a day, one for each of day_list — when every ID has them.
    const dayList = (ing.r.day_list || []).map(d => String(d).slice(0, 10));
    const nDays = dayList.length && xs.every(x => x.ids.every(r => Array.isArray(r[6]) && r[6].length === dayList.length)) ? dayList.length : 0;
    const at = (key, label, sub) => { let g = by.get(key); if (!g) { g = { key, label, sub, ids: new Set(), a: 0, a2: 0, only: 0, m: new Map() }; by.set(key, g); } return g; };
    if (inBy === 'path') {
      for (const x of xs) for (const p of x.paths || []) {
        const g = at(JSON.stringify(p.path || []) + (xs.length > 1 ? x.id : ''), inPathLabel(p), xs.length > 1 ? 'heard at ' + x.label : '');
        g.a2 += Number(p.ok); g.n = (g.n || 0) + Number(p.ids);
      }
    } else {
      for (const x of xs) for (const row of x.ids) {
        const gs = inGroupsOf(row);
        if (gs.length > 1) joint = true;
        for (const [key, label] of gs) {
          const g = at(key, label);
          g.ids.add(row[0] + ':' + row[1]);
          g[row[0] === 'alert2' ? 'a2' : 'a'] += Number(row[2]);
          if (row[5]) g.only++;
          if (key[0] === '?') g.warn = true;
          inMember(g, row, x, nDays);
        }
      }
    }
    const rows = inSorted([...by.values()].map(g => Object.assign(g, { n: g.n != null ? g.n : g.ids.size, members: inBy === 'path' ? null : inMembers(g, nDays) })), inSort, IN_SORT_KEYS);
    // What was decoded but not counted as a station: the rest of each protocol's total.
    const tot = xs.map(inRead).reduce((t, v) => ({ a: t.a + Number(v.a.ok), a2: t.a2 + Number(v.a2.ok) }), { a: 0, a2: 0 });
    const listed = inBy === 'path' ? { a: 0, a2: rows.reduce((n, g) => n + g.a2, 0) }
      : xs.reduce((t, x) => { for (const r of x.ids) t[r[0] === 'alert2' ? 'a2' : 'a'] += Number(r[2]); return t; }, { a: 0, a2: 0 });
    const rest = { a: inBy === 'path' ? 0 : Math.max(0, tot.a - listed.a), a2: Math.max(0, tot.a2 - listed.a2) };
    if (rest.a + rest.a2 > 0) rows.push({ label: 'Too few to count, or no ID', few: true, n: null, a: rest.a, a2: rest.a2, only: 0, dim: true });
    return { rows, total: listed.a + listed.a2 + rest.a + rest.a2, one: xs.length === 1, several: all.length > 1, joint, dayList: nDays ? dayList : null };
  }

  function inDaysTableHtml(b) {
    const cell = (ok, heard) => `<strong>${esc(chN(ok))}</strong>${b.full ? ` <span class="qs-dim">of ${esc(chN(heard))}${esc(inPct(ok, heard))}</span>` : ''}`;
    const body = b.days.map(v => `<tr><th scope="row">${esc(inDayName(v[0]))}</th>
        <td class="small">${cell(v[1], v[4])}</td>${b.full && b.one ? `<td class="small">${esc(chN(v[6]))}</td>` : ''}
        <td class="small">${cell(v[2], v[5])}</td>${b.full && b.one ? `<td class="small">${esc(chN(v[7]))}</td>` : ''}
        <td class="small"><strong>${esc(chN(Number(v[1]) + Number(v[2])))}</strong> <span class="qs-dim">of ${esc(chN(v[3]))}${esc(inPct(Number(v[1]) + Number(v[2]), v[3]))}</span></td>
        <td class="small">${Number(v[1]) + Number(v[2]) ? Math.round(Number(v[2]) / (Number(v[1]) + Number(v[2])) * 100) + '%' : '<span class="qs-dim">—</span>'}</td></tr>`).join('');
    return `<div class="table-wrap" role="region" tabindex="0" aria-label="Day by day"><table class="adm-table bs-in-b">
        <caption class="sr-only">Each UTC day, newest first: legacy ALERT and ALERT2 messages decoded of those heard, the stations on each, the day's total and its ALERT2 share</caption>
        <thead><tr><th scope="col">Day (UTC)</th><th scope="col">${inTerm('in-legacy', 'Legacy ALERT decoded')}</th>${b.full && b.one ? '<th scope="col">Legacy IDs</th>' : ''}
          <th scope="col">${inTerm('in-alert2', 'ALERT2 decoded')}</th>${b.full && b.one ? '<th scope="col">ALERT2 stations</th>' : ''}
          <th scope="col">${inTerm('in-messages', 'All decoded')}</th><th scope="col">${inTerm('in-share')}</th></tr></thead>
        <tbody>${body}</tbody></table></div>`
      + (b.full && !b.one ? '<p class="small qs-dim">Pick one base station for how many stations it decoded each day.</p>' : '');
  }

  function inBreakHtml() {
    if (!ing || ing.err || !ing.r) return '';
    const heard = (ing.r.stations || []).filter(x => inRead(x).n > 0);
    if (!heard.length) return '';
    if (inAt !== 'all' && !heard.some(x => String(x.id) === String(inAt))) inAt = 'all';
    const pill = (on, text, call) => `<button type="button" class="pill${on ? ' is-on' : ''}" aria-pressed="${on}" onclick="${call}">${esc(text)}</button>`;
    const picks = `<div class="pill-row" role="group" aria-label="Break it down by">${IN_BY.map(([k, t]) => pill(k === inBy, t, `BaseStations.inGroup('${k}')`)).join('')}</div>`
      + (heard.length > 1 ? `<div class="pill-row" role="group" aria-label="For which base station">${pill(inAt === 'all', 'All base stations', "BaseStations.inFor('all')")}${heard.map(x => pill(String(x.id) === String(inAt), x.label, `BaseStations.inFor(${Number(x.id)})`)).join('')}</div>` : '');
    const b = inBy === 'unknown' ? {} : inBreak();
    let out;
    if (inBy === 'unknown') out = inUnknownHtml();
    else if (b.need) out = '<p class="small txt-warn">The database does not have this yet — apply db/migrations/0112_base_station_ingest_breakdown.sql. Day by day works without it.</p>';
    else if (b.days) out = b.days.length ? inDaysTableHtml(b) : '<p class="small qs-dim">Nothing in the period.</p>';
    else if (!b.rows.length) out = `<p class="small qs-dim">${inBy === 'path' ? 'No ALERT2 decoded in the period.' : 'Nothing decoded in the period.'}</p>`;
    else {
      const path = inBy === 'path', max = Math.max(1, ...b.rows.map(g => g.a + g.a2));
      const shown = inMore ? b.rows : b.rows.slice(0, IN_TOP).concat(b.rows.length > IN_TOP ? b.rows.slice(IN_TOP).filter(g => g.few) : []);
      const head = (IN_BY.find(q => q[0] === inBy) || [])[1], term = IN_BY_TERM[inBy];
      const body = shown.map((g, i) => {
        const can = !path && !g.few && g.members && g.members.length > 0, open = can && inOpened.has(g.key);
        return `<tr class="${[g.dim ? 'qs-dim' : '', can ? 'bs-in-can' : '', open ? 'is-open' : ''].filter(Boolean).join(' ')}"${can ? ` data-k="${esc(g.key)}" onclick="BaseStations.inOpen(event, this)"` : ''}>
          <th scope="row">${can ? `<button type="button" class="bs-in-open" id="bs-in-ob-${i}" aria-expanded="${open}" aria-controls="bs-in-o-${i}" aria-label="The stations in ${esc(g.label)}" title="${open ? 'Close' : 'Open out'} the stations in this row"></button>` : ''}${g.few ? inTerm('in-few') : g.warn && inBy !== 'station' ? `<button type="button" class="pill bs-in-go" title="Each of them, with its frequency, the repeater it came through and who is licensed there" onclick="BaseStations.inGroup('unknown')">${esc(g.label)} — who are they?</button>` : `<span${g.warn ? ' class="txt-warn"' : ''}>${esc(g.label)}</span>`}${g.sub ? `<div class="small qs-dim">${esc(g.sub)}</div>` : ''}</th>
          <td class="small">${g.n == null ? '—' : esc(chN(g.n))}${!path && b.one && b.several && g.only ? `<div class="qs-dim">${esc(chN(g.only))} only here</div>` : ''}</td>
          ${path ? '' : `<td class="small">${g.a ? esc(chN(g.a)) : '<span class="qs-dim">—</span>'}</td>`}
          <td class="small">${g.a2 ? esc(chN(g.a2)) : '<span class="qs-dim">—</span>'}</td>
          ${path ? '' : `<td class="small"><strong>${esc(chN(g.a + g.a2))}</strong></td>`}
          <td class="small"><span class="bs-in-mix" aria-hidden="true"><i class="bs-sw-in-a" style="width:${(g.a / max * 100).toFixed(1)}%"></i><i class="bs-sw-in-a2" style="width:${(g.a2 / max * 100).toFixed(1)}%"></i></span>
            ${b.total ? ((g.a + g.a2) / b.total * 100 < 1 ? 'under 1%' : Math.round((g.a + g.a2) / b.total * 100) + '%') : ''}</td>
        </tr>${open ? `<tr class="bs-in-sub" id="bs-in-o-${i}"><td colspan="${path ? 4 : 6}">${inOpenHtml(g, b)}</td></tr>` : ''}`;
      }).join('');
      const hidden = b.rows.length - shown.length;
      out = `<div class="table-wrap" role="region" tabindex="0" aria-label="Decoded messages by ${esc(head.toLowerCase())}"><table class="adm-table bs-in-b">
          <caption class="sr-only">Decoded messages by ${esc(head.toLowerCase())}: the stations in each row, their legacy ALERT and ALERT2 messages, and the row's share of them all</caption>
          <thead><tr>${inSortTh('b', 'label', term ? inTerm(term) : esc(inBy === 'station' ? 'Station' : head), 'bs-in-g')}${inSortTh('b', 'n', inTerm('in-stations', path ? 'ALERT2 stations' : 'Stations'))}
            ${path ? '' : inSortTh('b', 'a', inTerm('in-legacy', 'Legacy ALERT decoded'))}${inSortTh('b', path ? 'both' : 'a2', inTerm('in-alert2', 'ALERT2 decoded'))}
            ${path ? '' : inSortTh('b', 'both', 'Both')}${inSortTh('b', 'share', inTerm('in-part'), 'bs-in-p')}</tr></thead>
          <tbody>${body}</tbody></table></div>`
        + (hidden > 0 || (inMore && b.rows.length > IN_TOP) ? `<p class="small"><button type="button" class="pill" onclick="BaseStations.inAll()">${inMore ? 'Show the first ' + IN_TOP + ' only' : 'Show all ' + chN(b.rows.length) + ' rows'}</button></p>` : '')
        + (path ? '' : '<p class="small qs-dim">Open a row (▸, or anywhere on it) for the stations in it, each with a bar a day. Click a heading to sort by it, again to sort the other way.</p>')
        + (b.joint ? '<p class="small qs-dim">A station owned jointly is counted under each of its owners, so these rows add up to more than the total; each share is of the total.</p>' : '')
        + (inAt === 'all' && heard.length > 1 ? '<p class="small qs-dim">All base stations together: a station two of them decode is one station, and its messages are counted at each.</p>' : '');
    }
    return `<div class="bs-in-bhead"><h3 class="bs-in-bh">Whose it is: the decoded messages, broken down</h3>
        <button type="button" class="pill" onclick="BaseStations.inBreakSave()">Save this breakdown as CSV</button></div>${picks}<div id="bs-in-by-t">${out}</div>`;
  }

  // ── …a row opened out into its stations (0124) ────────────────────────
  // What is in the row, at a glance — how many, how much the busiest carry,
  // the ones gone quiet, what kinds and which base stations — then each
  // station with its IDs, messages, days decoded and a bar a day.

  // A bar a day, legacy ALERT at the foot and ALERT2 above, to the station's own scale.
  function inSparkHtml(dA, dA2, days, what) {
    const W = 96, H = 20, w = W / days.length, max = Math.max(1, ...dA.map((v, i) => v + dA2[i]));
    const bars = days.map((d, i) => {
      const h1 = dA[i] / max * H, h2 = dA2[i] / max * H, x = (i * w).toFixed(1), bw = Math.max(1, w - 1).toFixed(1);
      const tip = inDayName(d) + ', UTC\n' + (dA[i] + dA2[i] ? chN(dA[i]) + ' legacy ALERT, ' + chN(dA2[i]) + ' ALERT2' : 'nothing decoded');
      return `<g><title>${esc(tip)}</title><rect class="bs-in-hit" x="${x}" y="0" width="${w.toFixed(1)}" height="${H}"></rect>`
        + (h1 ? `<rect class="bs-in-a" x="${x}" y="${(H - h1).toFixed(1)}" width="${bw}" height="${h1.toFixed(1)}"></rect>` : '')
        + (h2 ? `<rect class="bs-in-a2" x="${x}" y="${(H - h1 - h2).toFixed(1)}" width="${bw}" height="${h2.toFixed(1)}"></rect>` : '') + '</g>';
    }).join('');
    const none = dA.filter((v, i) => !(v + dA2[i])).length;
    return `<svg class="bs-in-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(what)}: decoded messages a day, ${esc(days[0])} to ${esc(days[days.length - 1])}, at most ${esc(chN(max))} in a day${none ? ', nothing on ' + none + ' of them' : ''}">${bars}</svg>`;
  }

  const inIdText = e => (e.proto === 'alert2' ? 'ALERT2 ' : 'Legacy ID ') + e.id + (e.proto !== 'alert2' && e.type ? ' · ' + e.type : '');
  const inMemberName = m => (m.station != null ? (inStn(m.station) || {}).name || m.station : 'Not in the register');

  function inOpenHtml(g, b) {
    const ms = g.members || [], days = b.dayList, tot = g.a + g.a2, idsMode = inBy === 'station';
    const all = inOpenedAll.has(g.key), shown = all ? ms : ms.slice(0, IN_OPEN_TOP);
    const what = idsMode ? (ms.length === 1 ? 'ID' : 'IDs') : (ms.length === 1 ? 'station' : 'stations');
    const facts = [`<strong>${esc(chN(ms.length))} ${what}</strong>`];
    if (ms.length > 5 && tot) facts.push(`the busiest 5 send ${Math.round(ms.slice(0, 5).reduce((n, m) => n + m.a + m.a2, 0) / tot * 100)}% of the row's messages`);
    if (days) {
      const quiet = ms.filter(m => m.quiet).length, few = ms.filter(m => m.days < Math.ceil(days.length / 2)).length;
      if (quiet) facts.push(`<span class="txt-warn">${esc(chN(quiet))} ${inTerm('in-quiet', 'gone quiet')}</span>`);
      if (few && days.length >= 3) facts.push(`${esc(chN(few))} decoded on fewer than half the days`);
    }
    if (inBy !== 'kind') {
      const k = new Map();
      for (const m of ms) for (const t of m.kinds) k.set(t, (k.get(t) || 0) + 1);
      const top = [...k].sort((p, q) => q[1] - p[1] || String(p[0]).localeCompare(String(q[0])));
      if (top.length) facts.push(top.slice(0, 4).map(([t, n]) => esc(t) + ' ' + esc(chN(n))).join(', ') + (top.length > 4 ? ', and ' + (top.length - 4) + ' more kinds' : ''));
    }
    const several = inAt === 'all' && b.several;
    if (several) {
      const h = new Map();
      for (const m of ms) for (const l of m.at.keys()) h.set(l, (h.get(l) || 0) + 1);
      facts.push('heard at ' + [...h].sort((p, q) => q[1] - p[1]).map(([l, n]) => esc(l) + ' (' + esc(chN(n)) + ')').join(', '));
    }
    let spark = '';
    if (days) {
      const dA = days.map((_, i) => ms.reduce((n, m) => n + m.dA[i], 0)), dA2 = days.map((_, i) => ms.reduce((n, m) => n + m.dA2[i], 0));
      spark = `<div class="bs-in-ohead">${inSparkHtml(dA, dA2, days, 'The whole row')}<span class="small qs-dim">the whole row, a bar a day</span></div>`;
    }
    const heardAt = m => (several ? [...m.at].sort((p, q) => q[1] - p[1]).map(([l, n]) => `<div>${esc(l)} <span class="qs-dim">${esc(chN(n))}</span></div>`).join('')
      + (m.at.size === 1 && m.only ? `<div class="qs-dim">only here</div>` : '') : m.only && b.several ? 'only here' : '<span class="qs-dim">—</span>');
    const body = shown.map(m => `<tr>
        ${idsMode ? '' : `<th scope="row">${m.station != null ? `<a href="${esc('?tab=stations&station=' + encodeURIComponent(m.station))}" onclick="return BaseStations.inStation(event, '${escAttr(m.station)}')" title="Open it on the Stations tab">${esc(inMemberName(m))}</a>` : '<span class="txt-warn">Not in the register</span>'}</th>`}
        <${idsMode ? 'th scope="row"' : 'td'} class="small">${[...m.ids.values()].sort((p, q) => q.ok - p.ok).map(e => `<div>${esc(inIdText(e))}</div>`).join('')}</${idsMode ? 'th' : 'td'}>
        <td class="small">${m.a ? esc(chN(m.a)) : '<span class="qs-dim">—</span>'}</td>
        <td class="small">${m.a2 ? esc(chN(m.a2)) : '<span class="qs-dim">—</span>'}</td>
        <td class="small">${tot ? ((m.a + m.a2) / tot * 100 < 1 ? 'under 1%' : Math.round((m.a + m.a2) / tot * 100) + '%') : ''}</td>
        <td class="small">${days ? `${esc(chN(m.days))} of ${esc(chN(days.length))}${m.quiet ? `<div><span class="badge term-chip txt-warn" title="${esc(IN_WORDS.find(w => w[0] === 'in-quiet')[2])}">gone quiet</span></div>` : ''}` : '<span class="qs-dim">—</span>'}</td>
        <td>${days ? inSparkHtml(m.dA, m.dA2, days, inMemberName(m)) : '<span class="qs-dim">—</span>'}</td>
        <td class="small">${heardAt(m)}</td>
      </tr>`).join('');
    return `<div class="bs-in-open-in">
        <p class="small">${facts.join(' · ')}</p>${spark}
        <div class="table-wrap" role="region" tabindex="0" aria-label="The ${esc(what)} in ${esc(g.label)}"><table class="adm-table bs-in-m">
          <caption class="sr-only">The ${esc(what)} in ${esc(g.label)}: ${idsMode ? '' : 'the station, '}its IDs, legacy ALERT and ALERT2 messages decoded, its share of the row, the days it was decoded on, a bar a day and the base stations that heard it</caption>
          <thead><tr>${idsMode ? '' : inSortTh('m', 'name', 'Station')}${inSortTh('m', 'id', idsMode ? 'ID' : 'IDs')}${inSortTh('m', 'a', inTerm('in-legacy', 'Legacy ALERT'))}${inSortTh('m', 'a2', inTerm('in-alert2'))}
            ${inSortTh('m', 'share', inTerm('in-row-share'))}${inSortTh('m', 'days', inTerm('in-days'))}<th scope="col">${inTerm('in-day-bars')}</th>${inSortTh('m', 'heard', inTerm('in-heard-at'))}</tr></thead>
          <tbody>${body}</tbody></table></div>
        <p class="small pill-row">${ms.length > IN_OPEN_TOP ? `<button type="button" class="pill" onclick="BaseStations.inOpenAll(this)">${all ? 'Show the first ' + IN_OPEN_TOP + ' only' : 'Show all ' + esc(chN(ms.length)) + ' ' + what}</button>` : ''}
          <button type="button" class="pill" onclick="BaseStations.inOpenSave(this)">Save ${idsMode ? (ms.length === 1 ? 'this ID' : 'these IDs') : (ms.length === 1 ? 'this station' : 'these stations')} as CSV</button></p>
        ${days ? '' : '<p class="small qs-dim">A bar a day for each needs db/migrations/0124_base_station_ingest_station_days.sql applied.</p>'}
      </div>`;
  }

  // ── …and the ones nobody has registered (0114) ───────────────────────────
  // Each station decoded that the register does not hold, with what narrows
  // down whose it is: the frequency (and who the ACMA has licensed on it near
  // the base station), the transmitter the base station heard it from (the
  // last address in its path), its signal, since when, and what its number
  // says. Nothing on the air names an owner; this is the evidence to take to
  // whoever holds the licence.

  const inSnap = f => Math.round(Number(f) / 0.00625) * 0.00625;
  const inFreqOf = (fmin, fmax) => (fmin == null || fmax == null ? null : Number(fmax) - Number(fmin) > 0.007 ? null : inSnap((Number(fmin) + Number(fmax)) / 2));
  const inFreqText = u => (u.f != null ? chMhz(u.f) : u.fmin != null ? chMhz(u.fmin) + '–' + chMhz(u.fmax) : '—');
  const inDayShort = t => { const d = new Date(t); return isFinite(d) ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''; };

  // The base stations picked, and their strangers as one list: a station two
  // of them decode is one row, its messages added up.
  function inUnknown() {
    const all = ((ing && ing.r && ing.r.stations) || []).filter(x => inRead(x).n > 0);
    const xs = inAt === 'all' ? all : all.filter(x => String(x.id) === String(inAt));
    if (xs.some(x => !Array.isArray(x.strangers))) return { need: true };
    // An ALERT2 address's name, where a path names it, and what comes through it.
    const names = new Map(), relays = new Map();
    for (const x of xs) for (const p of x.paths || []) (p.path || []).forEach((a, i) => { if (p.names && p.names[i]) names.set(a, p.names[i]); });
    const by = new Map();
    for (const x of xs) for (const g of x.strangers) {
      const k = g.protocol + ':' + g.id;
      let u = by.get(k);
      if (!u) { u = { protocol: g.protocol, id: g.id, ok: 0, n: 0, days: 0, at: [], sites: [], paths: [], from: new Map(), fmin: null, fmax: null, first: null, last: null, since: null, snr: null, top: -1, only: !!g.only_here }; by.set(k, u); }
      u.ok += Number(g.ok); u.n += Number(g.n || 0); u.days = Math.max(u.days, Number(g.days || 0));
      u.at.push(x.label); if (x.site) u.sites.push(x.site);
      if (g.fmin != null) u.fmin = u.fmin == null ? Number(g.fmin) : Math.min(u.fmin, Number(g.fmin));
      if (g.fmax != null) u.fmax = u.fmax == null ? Number(g.fmax) : Math.max(u.fmax, Number(g.fmax));
      if (g.first && (!u.first || g.first < u.first)) u.first = g.first;
      if (g.last && (!u.last || g.last > u.last)) u.last = g.last;
      if (g.since && (!u.since || g.since < u.since)) u.since = g.since;
      if (Number(g.ok) > u.top) { u.top = Number(g.ok); u.snr = g.snr; }
      for (const [path, ok, snr] of g.paths || []) {
        u.paths.push({ path, ok: Number(ok), snr, at: x.label });
        const last = path.length ? path[path.length - 1] : null, key = (last == null ? 'self' : last) + '|' + x.id;
        const e = u.from.get(key) || { last, ok: 0, snr, at: x.label };
        e.ok += Number(ok); u.from.set(key, e);
        path.forEach(a => { if (a !== g.id) { const r = relays.get(a) || new Set(); r.add(g.id); relays.set(a, r); } });
      }
    }
    const list = [...by.values()].map(u => Object.assign(u, { f: inFreqOf(u.fmin, u.fmax), paths: u.paths.sort((p, q) => q.ok - p.ok), from: [...u.from.values()].sort((p, q) => q.ok - p.ok) }))
      .sort((p, q) => q.ok - p.ok || p.id - q.id);
    const tot = xs.map(inRead).reduce((n, v) => n + v.ok, 0);
    return { list, names, relays, total: tot, several: xs.length > 1, days: ing.r.days, sites: xs.map(x => x.site).filter(Boolean) };
  }

  // Who the ACMA has on a frequency near any of these sites: [{ client, n, km, site }], nearest first.
  function inLicensees(f, sites) {
    if (f == null || !inAcma || !inAcma.list || !sites.length) return [];
    const by = new Map();
    for (const d of inAcma.list) {
      if (Math.abs(d.f - f) > CH_NEAR_MHZ) continue;
      const km = Math.min(...sites.map(q => chKm(q.lat, q.lon, d.lat, d.lon)));
      if (km > IN_ACMA_KM) continue;
      const e = by.get(d.client) || { client: d.client, n: 0, km: Infinity, site: '' };
      e.n++; if (km < e.km) { e.km = km; e.site = d.site; }
      by.set(d.client, e);
    }
    return [...by.values()].sort((a, b) => a.km - b.km || a.client.localeCompare(b.client));
  }
  const inLicText = (f, sites) => inLicensees(f, sites).map(l => l.client + ' (' + l.site + ', ' + Math.round(l.km) + ' km' + (l.n > 1 ? ', ' + l.n + ' devices' : '') + ')');
  function inLicHtml(f, sites) {
    if (!sites.length) return '<span class="qs-dim">the base station has not said where it is</span>';
    if (!inAcma || inAcma.loading) return '<span class="qs-dim">loading the licences…</span>';
    if (inAcma.err) return `<span class="qs-dim">${esc(inAcma.err)}</span>`;
    const lic = inLicensees(f, sites);
    if (!lic.length) return '<span class="qs-dim">nobody within ' + IN_ACMA_KM + ' km</span>';
    return lic.slice(0, 6).map(l => `<div><strong>${esc(l.client)}</strong><div class="qs-dim">${esc(l.site)}, ${esc(chN(Math.round(l.km)))} km${l.n > 1 ? ' · ' + esc(l.n) + ' devices' : ''}</div></div>`).join('')
      + (lic.length > 6 ? `<div class="qs-dim">+${esc(lic.length - 6)} more — all of them in the CSV</div>` : '');
  }

  function inAcmaAsk() {
    if (inBy !== 'unknown' || inAcma) return;
    if (typeof acmaEnsureCore !== 'function' || typeof acmaEnsureDevices !== 'function') { inAcma = { err: 'the ACMA licences are not on this page' }; return; }
    inAcma = { loading: true };
    acmaEnsureCore().then(acmaEnsureDevices).then(() => {
      const A = state.acma, list = [];
      for (const d of Object.values(A.deviceById || {})) {
        const st = A.siteById[d.site_id];
        if (!st || d.f_mhz == null || st.lat == null || st.lon == null) continue;
        const lic = (A.licById || {})[d.lic] || {}, cl = (A.clientById || {})[lic.client_no] || {};
        list.push({ f: Number(d.f_mhz), client: cl.name || 'licensee ' + (lic.client_no || '?'), site: st.name, lat: Number(st.lat), lon: Number(st.lon) });
      }
      inAcma = { list, source: A.threats && A.threats.meta && A.threats.meta.source_date };
    }).catch(e => { inAcma = { err: 'the ACMA licences could not be loaded (' + e.message + ')' }; }).then(paintIn);
  }

  // The register's legacy IDs in order, for a stranger's neighbours: [[id, station]].
  let inIdsMemo = { src: null, ids: [] };
  function inRegIds() {
    const list = (state.data && state.data.stations) || [];
    if (inIdsMemo.src !== list) {
      const m = new Map();
      for (const st of list) for (const se of st.sensors || []) if (Number.isInteger(se.alert_id) && !m.has(se.alert_id)) m.set(se.alert_id, st);
      inIdsMemo = { src: list, ids: [...m.entries()].sort((a, b) => a[0] - b[0]) };
    }
    return inIdsMemo.ids;
  }
  // What can be said of one: [text].
  function inClues(u, d) {
    const out = [];
    if (u.protocol === 'alert2') {
      const r = d.relays.get(u.id);
      if (r && r.size) out.push('A repeater: ' + r.size + ' other unregistered station' + (r.size === 1 ? ' comes' : 's come') + ' through it');
      if (u.from.some(e => e.last == null)) out.push('Heard straight from it at times, so it is within reach of the base station');
    } else {
      const ids = inRegIds();
      let lo = 0, hi = ids.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ids[mid][0] < u.id) lo = mid + 1; else hi = mid; }
      const say = e => { const o = typeof stationOwner === 'function' && inOwnersReady() ? stationOwner(e[1]) : null; return e[0] + ' ' + e[1].name + (o ? ' (' + o.name + ')' : ''); };
      const near = [ids[lo - 1], ids[lo]].filter(e => e && Math.abs(e[0] - u.id) <= 50);
      if (near.length) out.push('Nearest IDs in the register: ' + near.map(say).join(' · '));
      else out.push('No ID within 50 of it in the register');
    }
    if (d.several && u.at.length > 1) out.push('Decoded at ' + u.at.join(' and '));
    return out;
  }
  const inAddr = (a, d) => (d.names.get(a) ? d.names.get(a) + ' (' + a + ')' : 'address ' + a);
  const inFromText = (e, d) => (e.last == null ? 'straight from it' : inAddr(e.last, d)) + (d.several ? ' at ' + e.at : '');

  function inUnknownHtml() {
    const d = inUnknown();
    if (d.need) return '<p class="small txt-warn">The database does not have this yet — apply db/migrations/0114_base_station_ingest_strangers.sql.</p>';
    if (!d.list.length) return '<p class="small qs-dim">Every station decoded in the period is in the register.</p>';
    const ok = d.list.reduce((n, u) => n + u.ok, 0), perDay = n => chN(Math.round(n / Math.max(1, d.days)));
    // Frequency by frequency.
    const fq = new Map();
    for (const u of d.list) {
      const k = (u.f != null ? chMhz(u.f) : '?') + '|' + u.protocol;
      const e = fq.get(k) || { f: u.f, protocol: u.protocol, n: 0, ok: 0, u };
      e.n++; e.ok += u.ok; fq.set(k, e);
    }
    const fRows = [...fq.values()].sort((a, b) => b.ok - a.ok).map(e => `<tr>
        <th scope="row">${e.f != null ? esc(chMhz(e.f)) + ' <span class="small qs-dim">MHz</span>' : '<span class="qs-dim">not one frequency</span>'}</th>
        <td class="small">${e.protocol === 'alert2' ? 'ALERT2' : 'Legacy ALERT'}</td>
        <td class="small">${esc(chN(e.n))}</td>
        <td class="small"><strong>${esc(chN(e.ok))}</strong> <span class="qs-dim">${Math.round(e.ok / Math.max(1, ok) * 100)}% of these</span></td>
        <td class="small">${inLicHtml(e.f, d.sites)}</td></tr>`).join('');
    // The transmitter the base station heard them from (ALERT2).
    const hop = new Map();
    for (const u of d.list) for (const e of u.from) {
      const k = (e.last == null ? 'self' : e.last) + '|' + e.at;
      const h = hop.get(k) || { last: e.last, at: e.at, ok: 0, ids: new Set(), snr: e.snr };
      h.ok += e.ok; h.ids.add(u.id); hop.set(k, h);
    }
    const hRows = [...hop.values()].sort((a, b) => b.ok - a.ok).map(h => `<tr>
        <th scope="row">${h.last == null ? 'Straight from the station' : esc(inAddr(h.last, d))}${d.several ? `<div class="small qs-dim">heard at ${esc(h.at)}</div>` : ''}</th>
        <td class="small">${esc(chN(h.ids.size))}</td><td class="small"><strong>${esc(chN(h.ok))}</strong></td>
        <td class="small">${h.snr == null ? '—' : esc(Number(h.snr).toFixed(1)) + ' dB'}</td></tr>`).join('');
    const shown = inMore ? d.list : d.list.slice(0, IN_TOP);
    const sRows = shown.map(u => `<tr>
        <th scope="row">${esc(u.id)}<div class="small qs-dim">${u.protocol === 'alert2' ? 'ALERT2 station' : 'legacy ID'}</div></th>
        <td class="small"><strong>${esc(chN(u.ok))}</strong><div class="qs-dim">${esc(perDay(u.ok))} a day${u.n > u.ok ? ' · ' + Math.round(u.ok / u.n * 100) + '% of heard' : ''}</div></td>
        <td class="small">${esc(inFreqText(u))}</td>
        <td class="small">${u.protocol !== 'alert2' ? '<span class="qs-dim">legacy carries no path</span>'
          : u.from.slice(0, 3).map(e => `<div>${esc(inFromText(e, d))} <span class="qs-dim">${esc(chN(e.ok))}${e.snr == null ? '' : ' · ' + esc(Number(e.snr).toFixed(1)) + ' dB'}</span></div>`).join('')
            + (u.paths[0] && u.paths[0].path.length > 1 ? `<div class="qs-dim">busiest path: ${esc(u.paths[0].path.map(a => d.names.get(a) || a).join(' → '))}</div>` : '')}</td>
        <td class="small">${u.snr == null ? '—' : esc(Number(u.snr).toFixed(1)) + ' dB'}</td>
        <td class="small">${u.since ? esc(inDayShort(u.since)) : '—'}<div class="qs-dim">${u.last ? 'last ' + esc(ago(u.last)) : ''}${u.days ? ' · on ' + esc(u.days) + ' day' + (u.days === 1 ? '' : 's') : ''}</div></td>
        <td class="small">${inClues(u, d).map(c => `<div>${esc(c)}</div>`).join('') || '<span class="qs-dim">—</span>'}</td></tr>`).join('');
    return `<p class="small"><strong>${esc(chN(d.list.length))} station${d.list.length === 1 ? '' : 's'} not in the register</strong> sent ${esc(chN(ok))} of the ${esc(chN(d.total))} decoded messages (${Math.round(ok / Math.max(1, d.total) * 100)}%).
        Nothing on the air says whose a station is, so this lays out what narrows it down: the frequency and who is licensed on it, the repeater it comes through, and what its number sits beside.</p>
      <h4 class="bs-in-uh">Which frequency, and who is licensed on it</h4>
      <div class="table-wrap" role="region" tabindex="0" aria-label="Unregistered stations by frequency"><table class="adm-table bs-in-b bs-in-uf">
        <caption class="sr-only">The unregistered stations by frequency and protocol: how many, their decoded messages, and who the ACMA has licensed on that frequency near the base station</caption>
        <thead><tr><th scope="col">${inTerm('in-freq')}</th><th scope="col">Protocol</th><th scope="col">${inTerm('in-stations')}</th><th scope="col">${inTerm('in-messages', 'Decoded')}</th><th scope="col" class="bs-in-l">${inTerm('in-lic')}</th></tr></thead>
        <tbody>${fRows}</tbody></table></div>
      ${hRows ? `<h4 class="bs-in-uh">Which transmitter the base station heard them from (ALERT2)</h4>
      <div class="table-wrap" role="region" tabindex="0" aria-label="Unregistered ALERT2 stations by the transmitter heard"><table class="adm-table bs-in-b bs-in-ut">
        <caption class="sr-only">The unregistered ALERT2 stations by the last transmitter in their path: how many stations came through it, their decoded messages and its signal</caption>
        <thead><tr><th scope="col">${inTerm('in-from')}</th><th scope="col">${inTerm('in-stations', 'Stations through it')}</th><th scope="col">${inTerm('in-messages', 'Decoded')}</th><th scope="col">${inTerm('in-snr')}</th></tr></thead>
        <tbody>${hRows}</tbody></table></div>
      <p class="small qs-dim">From each station's eight busiest paths. The signal is that transmitter's at the base station, whatever lies behind it — so a repeater's stations all share its figure.</p>` : ''}
      <h4 class="bs-in-uh">Station by station</h4>
      <div class="table-wrap" role="region" tabindex="0" aria-label="Unregistered stations, one a row"><table class="adm-table bs-in-b bs-in-us">
        <caption class="sr-only">Each unregistered station: its decoded messages, frequency, the transmitter it was heard from, its signal, when it was first heard, and what else can be said</caption>
        <thead><tr><th scope="col">ID</th><th scope="col">${inTerm('in-messages', 'Decoded')}</th><th scope="col">${inTerm('in-freq')}</th><th scope="col" class="bs-in-f">${inTerm('in-from')}</th><th scope="col">${inTerm('in-snr')}</th><th scope="col">${inTerm('in-since')}</th><th scope="col" class="bs-in-c">${inTerm('in-clue')}</th></tr></thead>
        <tbody>${sRows}</tbody></table></div>`
      + (d.list.length > IN_TOP ? `<p class="small"><button type="button" class="pill" onclick="BaseStations.inAll()">${inMore ? 'Show the top ' + IN_TOP + ' only' : 'Show all ' + chN(d.list.length) + ' stations'}</button></p>` : '')
      + `<p class="small qs-dim">Licences from the ACMA's Register of Radiocommunications Licences extract${inAcma && inAcma.source ? ' of ' + esc(inAcma.source) : ''} (CC BY 4.0), within ${IN_ACMA_KM} km of the base station and 6 kHz of the frequency. Once you know whose they are, add the station to the register with its ALERT2 address or sensor IDs and it leaves this list.</p>`;
  }

  // The owners come from the SLS file, which the tab may not have yet.
  function inOwnersAsk() {
    if ((inBy !== 'owner' && inBy !== 'unknown') || inSlsAsked || typeof SLS === 'undefined' || SLS.loaded()) return;
    inSlsAsked = true;
    SLS.ensureData().then(paintIn, () => { inSlsAsked = 'failed'; paintIn(); });
  }

  function inSummaryHtml() {
    if (!ing) return 'Loading…';
    if (ing.err) return `<span class="txt-bad">${esc(ing.err)}</span>`;
    const xs = ing.r.stations || [], vs = xs.map(inRead);
    const ok = vs.reduce((n, v) => n + v.ok, 0), a = vs.reduce((n, v) => n + Number(v.a.ok), 0), a2 = vs.reduce((n, v) => n + Number(v.a2.ok), 0);
    const span = ing.r.days === 1 ? 'day' : ing.r.days + ' days';
    if (!ok) return 'Nothing decoded by any base station in the last ' + span + '.';
    const net = k => (ing.r.network || []).find(q => q.protocol === k) || { ids: 0, known: 0 };
    const active = vs.filter(v => v.ok > 0).length;
    return `In the last ${span}, ${active} base station${active === 1 ? '' : 's'} brought in <strong>${esc(chN(ok))} decoded messages</strong>: `
      + `${esc(chN(a))} ${inTerm('in-legacy', 'legacy ALERT')} (${Math.round(a / ok * 100)}%) and ${esc(chN(a2))} ${inTerm('in-alert2')} (${Math.round(a2 / ok * 100)}%), `
      + `from ${esc(chN(net('alert').ids))} legacy IDs and ${esc(chN(net('alert2').ids))} ALERT2 stations across the network`
      + (Number(net('alert').ids) - Number(net('alert').known) + Number(net('alert2').ids) - Number(net('alert2').known) > 0
        ? ` — ${esc(chN(Number(net('alert').ids) - Number(net('alert').known) + Number(net('alert2').ids) - Number(net('alert2').known)))} of them ${inTerm('in-register', 'not in the register')}` : '') + '.'
      + (ing.r.to ? ` <span class="qs-dim">Rolled up to ${esc(ago(ing.r.to))}.</span>` : '');
  }

  function inShellHtml() {
    return `<section class="panel bs-in" aria-labelledby="bs-in-h">
      <div class="panel-header"><h2 id="bs-in-h">What comes in through each</h2>
        <div class="pill-row" role="group" aria-label="How far back">${IN_DAYS.map(d => `<button type="button" class="pill${d === inDays ? ' is-on' : ''}" aria-pressed="${d === inDays}" onclick="BaseStations.inWindow(${d})">${d === 1 ? '1 day' : d + ' days'}</button>`).join('')}
          <button type="button" class="pill" onclick="BaseStations.inSave()">Save as CSV</button></div></div>
      <p class="small" id="bs-in-sum" aria-live="polite"></p>
      <div id="bs-in-body"></div>
      <p class="small qs-dim">From the hourly reception rollups, so the last hour may not be in yet; a month comes by the day. A message heard by two base stations counts for both, and one relayed by two repeaters is two messages. Drive surveys are left out.</p>
      <div id="bs-in-by" class="bs-in-by"></div>
      <details class="rd-fold"><summary><h3 class="bk-inline-h">What these words mean</h3></summary>
        <dl class="rd-words">${IN_WORDS.map(w => `<dt>${esc(w[1])}</dt><dd>${esc(w[2])}</dd>`).join('')}</dl></details>
    </section>`;
  }

  function paintIn() {
    if (state.activeTab !== 'basestations') return;
    const el = document.getElementById('bs-in');
    if (!el) return;
    if (!isAdmin()) { if (el.innerHTML) { el.innerHTML = ''; el.dataset.sig = ''; } return; }
    const sig = String(inDays);
    if (el.dataset.sig !== sig || !el.firstElementChild) { el.innerHTML = inShellHtml(); el.dataset.sig = sig; }
    const set = (id, html) => { const e = document.getElementById(id); if (e && e.innerHTML !== html) keepFocus(e, () => { e.innerHTML = html; }); };
    set('bs-in-sum', inSummaryHtml());
    set('bs-in-body', inTableHtml());
    set('bs-in-by', inBreakHtml());
    inOwnersAsk();
    inAcmaAsk();
  }

  async function loadIn() {
    if (!isAdmin() || inBusy) return;
    const days = inDays;
    inBusy = true;
    try {
      const r = await dbRpc('admin_base_station_ingest', { p_days: days });
      if (inDays !== days) return;
      setNow(r.now);
      ing = { days, r, err: null };
    } catch (err) {
      if (inDays !== days) return;
      ing = { days, r: null, err: err.status === 404 ? 'The database does not have this yet — apply db/migrations/0111_base_station_steady_signals.sql.'
        : 'Could not load what comes in: ' + err.message };
    } finally {
      inBusy = false;
    }
    paintIn();
  }

  function inWindow(days) {
    if (!IN_DAYS.includes(days) || days === inDays) return;
    inDays = days; ing = null;
    paintIn();
    loadIn();
  }

  function inGroup(by) {
    if (!IN_BY.some(q => q[0] === by) || by === inBy) return;
    inBy = by; inMore = false; inOpened = new Set(); inOpenedAll = new Set();
    paintIn();
  }
  function inFor(id) {
    if (String(id) === String(inAt)) return;
    inAt = id; inMore = false; inOpened = new Set(); inOpenedAll = new Set();
    paintIn();
  }
  function inAll() { inMore = !inMore; paintIn(); }

  // A sorting heading clicked: 'b' the breakdown, 'm' the stations in its opened rows.
  function inSortBy(which, key) {
    const keys = which === 'm' ? IN_MSORT_KEYS : IN_SORT_KEYS;
    if (!keys[key]) return;
    const s = which === 'm' ? inMSort : inSort;
    const next = s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'label' || key === 'name' || key === 'id' ? 1 : -1 };
    if (which === 'm') inMSort = next; else inSort = next;
    paintIn();
  }

  // A row opened out into its stations, or closed (0124): a click anywhere on
  // it but a link or another button, or its ▸ from the keyboard.
  function inOpen(ev, tr) {
    if (ev && ev.target && ev.target.closest && ev.target.closest('a, button:not(.bs-in-open), .bs-in-sub')) return;
    const k = tr && tr.dataset.k;
    if (k == null) return;
    if (inOpened.has(k)) inOpened.delete(k); else inOpened.add(k);
    const b = tr.querySelector('.bs-in-open');
    paintIn();
    if (b && b.id && document.activeElement !== document.getElementById(b.id)) { const n = document.getElementById(b.id); if (n) n.focus({ preventScroll: true }); }
  }
  const inOpenKey = el => { const sub = el && el.closest('tr.bs-in-sub'), row = sub && sub.previousElementSibling; return row ? row.dataset.k : null; };
  function inOpenAll(el) {
    const k = inOpenKey(el);
    if (k == null) return;
    if (inOpenedAll.has(k)) inOpenedAll.delete(k); else inOpenedAll.add(k);
    paintIn();
  }
  function inStation(ev, id) {
    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey || ev.button === 1)) return true;
    if (ev && ev.preventDefault) ev.preventDefault();
    if (typeof goToStation === 'function') goToStation(id);
    return false;
  }
  // The stations in an opened row, as a file: one line each, its days as columns.
  function inOpenSave(el) {
    const k = inOpenKey(el), b = k == null ? null : inBreak(), g = b && b.rows && b.rows.find(r => r.key === k);
    if (!g || !g.members || !g.members.length) { announce('Nothing to save yet.'); return; }
    const head = (IN_BY.find(q => q[0] === inBy) || [])[1], days = b.dayList || [];
    const at = inAt === 'all' ? 'All base stations' : ((ing.r.stations || []).find(x => String(x.id) === String(inAt)) || {}).label || '';
    const tot = g.a + g.a2;
    const rows = [['Base station', head, 'Station', 'Register ID', 'IDs', 'Kind of sensor', 'Legacy ALERT decoded', 'ALERT2 decoded', 'Both', 'Share of the row %', 'Days decoded', 'Gone quiet', 'Heard at (decoded)']
      .concat(days.map(d => d + ' decoded'))]
      .concat(g.members.map(m => [at, g.label, inMemberName(m), m.station == null ? '' : m.station, [...m.ids.values()].map(inIdText).join('; '), [...m.kinds].join('; '),
        m.a, m.a2, m.a + m.a2, tot ? ((m.a + m.a2) / tot * 100).toFixed(1) : '', days.length ? m.days : '', days.length ? (m.quiet ? 'yes' : '') : '',
        [...m.at].map(([l, n]) => l + ' (' + n + ')').join('; ')].concat(days.map((_, i) => m.dA[i] + m.dA2[i]))));
    const slug = String(g.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'row';
    saveCsv('floodnet-base-station-ingest-' + inBy + '-' + slug + '-' + ing.r.days + 'd.csv', rows);
    announce('Saved ' + (rows.length - 1) + ' stations.');
  }

  // The breakdown on screen, every row of it, as a file.
  function inBreakSave() {
    if (!ing || !ing.r) { announce('Nothing to save yet.'); return; }
    if (inBy === 'unknown') {
      const d = inUnknown();
      if (d.need || !d.list.length) { announce('Nothing to save yet.'); return; }
      const rows = [['Protocol', 'ID', 'Decoded', 'Heard', 'Decoded a day', 'Frequency MHz', 'Heard from (decoded, SNR dB)', 'Busiest paths (decoded)', 'Signal SNR dB', 'Decoded at', 'First heard (UTC day)', 'Last heard', 'Days decoded on', 'Clues', 'Licensed on the frequency nearby']]
        .concat(d.list.map(u => [u.protocol === 'alert2' ? 'ALERT2' : 'Legacy ALERT', u.id, u.ok, u.n, Math.round(u.ok / Math.max(1, d.days)), inFreqText(u),
          u.from.map(e => inFromText(e, d) + ' (' + e.ok + (e.snr == null ? '' : ', ' + e.snr) + ')').join('; '),
          u.paths.slice(0, 8).map(p => (p.path.length ? p.path.join('>') : 'direct') + ' (' + p.ok + ')').join('; '),
          u.snr == null ? '' : u.snr, u.at.join('; '), u.since ? String(u.since).slice(0, 10) : '', u.last || '', u.days, inClues(u, d).join('; '), inLicText(u.f, d.sites).join('; ')]));
      saveCsv('floodnet-base-station-ingest-not-in-register-' + ing.r.days + 'd.csv', rows);
      announce('Saved ' + (rows.length - 1) + ' stations.');
      return;
    }
    const b = inBreak();
    const at = inAt === 'all' ? 'All base stations' : ((ing.r.stations || []).find(x => String(x.id) === String(inAt)) || {}).label || '';
    let rows;
    if (b && b.days && b.days.length) {
      rows = [['Base station', 'Day (UTC)', 'Legacy ALERT decoded', 'Legacy ALERT heard', 'Legacy IDs', 'ALERT2 decoded', 'ALERT2 heard', 'ALERT2 stations', 'All decoded', 'All heard']]
        .concat(b.days.map(v => [at, String(v[0]).slice(0, 10), v[1], b.full ? v[4] : '', b.full && b.one ? v[6] : '', v[2], b.full ? v[5] : '', b.full && b.one ? v[7] : '', Number(v[1]) + Number(v[2]), v[3]]));
    } else if (b && b.rows && b.rows.length) {
      const head = (IN_BY.find(q => q[0] === inBy) || [])[1];
      rows = [['Base station', head, 'Heard at', 'Stations', 'Only here', 'Legacy ALERT decoded', 'ALERT2 decoded', 'Both', 'Share %']]
        .concat(b.rows.map(g => [at, g.label, (g.sub || '').replace(/^heard at /, ''), g.n == null ? '' : g.n, b.one && b.several ? g.only : '', g.a, g.a2, g.a + g.a2, b.total ? ((g.a + g.a2) / b.total * 100).toFixed(1) : '']));
    } else { announce('Nothing to save yet.'); return; }
    saveCsv('floodnet-base-station-ingest-by-' + inBy + '-' + ing.r.days + 'd.csv', rows);
    announce('Saved ' + (rows.length - 1) + ' rows.');
  }

  function inSave() {
    const xs = (ing && ing.r && ing.r.stations) || [];
    if (!xs.length) { announce('Nothing to save yet.'); return; }
    const rows = [['Base station', 'Hosted at', 'Days', 'Stations decoded', 'Legacy ALERT heard', 'Legacy ALERT decoded', 'Legacy IDs', 'Legacy IDs not in the register', 'Legacy IDs only here',
      'ALERT2 heard', 'ALERT2 decoded', 'ALERT2 stations', 'ALERT2 stations not in the register', 'ALERT2 stations only here', 'ALERT2 share %', 'Decoded a day', 'Last heard']];
    for (const x of xs) {
      const v = inRead(x);
      rows.push([x.label, x.host_station || '', ing.r.days, Number(v.a.ids) + Number(v.a2.ids), v.a.n, v.a.ok, v.a.ids, Number(v.a.ids) - Number(v.a.known), v.a.only_here,
        v.a2.n, v.a2.ok, v.a2.ids, Number(v.a2.ids) - Number(v.a2.known), v.a2.only_here, v.share == null ? '' : Math.round(v.share * 100), Math.round(v.perDay), v.last || '']);
    }
    saveCsv('floodnet-base-station-ingest-' + ing.r.days + 'd.csv', rows);
    announce('Saved ' + (rows.length - 1) + ' base stations.');
  }

  // ── its receivers' own signal (0083) ─────────────────────────────────────
  // Every transmitter a receiver hears on that transmitter's own carrier is
  // followed against its own past; the median of how far they all sat from
  // their usual, day by day, is the receiver's own shift — its antenna, cable,
  // gain or the noise at its site moving everything at once. The server takes
  // it out before it judges any station's signal (Station Health's
  // Transmitter frequency and signal); here it is shown as the receiver's,
  // with its noise floor beside it to say which: everything weaker with the
  // floor where it was is the signal (antenna, cable, a connector, the
  // preamp); with the floor up, it is noise. admin_base_station_signal(), from
  // receiver_snr_day, judged hourly.

  const SIG_MS = 1800000;   // judged hourly: half an hour is plenty
  const SIG_DAYS = 90;
  const SIG_PROTO = { alert: 'ALERT', alert2: 'ALERT2' };
  // { id, r, err } — r as the database answered.
  let sig = null, sigBusy = false;

  const sigMean = a => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : null);
  const sigDb = v => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' dB');

  // A receiver's days, read: the last week against the thirty before, the
  // biggest step (three days either side of a day), the noise floor's move.
  function sigRead(rx, warn, today) {
    const DAY = 86400000;
    const days = (rx.days || []).map(d => ({ t: Date.parse(String(d[0]).slice(0, 10) + 'T00:00:00Z'), shift: Number(d[1]), links: Number(d[2]), nf: d[4] == null ? null : Number(d[4]) }))
      .filter(d => isFinite(d.t) && isFinite(d.shift)).sort((a, b) => a.t - b.t);
    const age = d => Math.round((today - d.t) / DAY);
    const wk = days.filter(d => age(d) < 7), before = days.filter(d => age(d) >= 7 && age(d) < 37);
    const week = wk.length >= 3 && before.length >= 5 ? sigMean(wk.map(d => d.shift)) - sigMean(before.map(d => d.shift)) : null;
    const nfOf = l => sigMean(l.map(d => d.nf).filter(v => v != null && isFinite(v)));
    const nfWeek = week != null && nfOf(wk) != null && nfOf(before) != null ? nfOf(wk) - nfOf(before) : null;
    let step = null;
    for (let i = 3; i + 3 <= days.length; i++) {
      const s = sigMean(days.slice(i, i + 3).map(d => d.shift)) - sigMean(days.slice(i - 3, i).map(d => d.shift));
      if (step == null || Math.abs(s) > Math.abs(step.db)) step = { db: s, t: days[i].t };
    }
    if (step && Math.abs(step.db) < warn) step = null;
    return { name: rx.name || rx.point_id, protocol: rx.protocol, days, week, nfWeek, step, links: days.length ? days[days.length - 1].links : 0 };
  }

  function sigSpark(days, warn, today) {
    // 40 tall: the content height of the shortest row (a name on two lines),
    // so the line fills the row without making any row taller.
    const W = 140, H = 40, t0 = today - (SIG_DAYS - 1) * 86400000;
    const shown = days.filter(d => d.t >= t0);
    const lim = Math.max(warn * 2, ...shown.map(d => Math.abs(d.shift)));
    const x = t => ((t - t0) / Math.max(1, today - t0)) * (W - 4) + 2, y = v => H / 2 - (v / lim) * (H / 2 - 2);
    const line = shown.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.shift).toFixed(1)}`).join('');
    return `<svg class="hl-drift-spark bs-sig-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">`
      + `<rect x="0" y="${y(warn).toFixed(1)}" width="${W}" height="${(y(-warn) - y(warn)).toFixed(1)}" fill="currentColor" opacity="0.07"/>`
      + `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="2 2"/>`
      + (shown.length ? `<path d="${line}" fill="none" stroke="currentColor" stroke-width="1.5"/>` : '') + '</svg>';
  }

  // What a receiver's shift says, in words.
  function sigVerdict(x, warn) {
    if (x.week == null) return ['qs-dim', 'too soon to say', 'it needs 3 days in the last week and 5 in the 30 before'];
    const floor = x.nfWeek == null ? '' : Math.abs(x.nfWeek) < 1.5 ? 'its noise floor where it was, so the signal itself: the antenna, its cable or a connector, the preamp or the gain'
      : x.nfWeek > 0 ? `its noise floor up ${x.nfWeek.toFixed(1)} dB with it, so new noise at the site — something nearby switched on, or interference`
      : `its noise floor down ${Math.abs(x.nfWeek).toFixed(1)} dB`;
    if (x.week <= -warn) return ['txt-warn', 'everything it hears is weaker', floor];
    if (x.week >= warn) return ['', 'everything it hears is stronger', floor];
    if (Math.abs(x.week) >= warn / 2) return ['', 'moving a little', ''];
    return ['txt-ok', 'steady', ''];
  }

  function sigShellHtml(s) {
    return `<section class="panel bs-sig" aria-labelledby="bs-sig-h">
      <div class="panel-header"><h2 id="bs-sig-h">Signal across what it hears</h2></div>
      <p class="small" id="bs-sig-sum" aria-live="polite"></p>
      <div id="bs-sig-body"></div>
      <p class="small qs-dim">For each of ${esc(s.label)}'s receivers, every transmitter it hears on that transmitter's own carrier, each
        against its own usual SNR; the middle of how far they all sat from it, day by day, is the receiver's own — a step on every station at
        once is the receiver, its antenna, cable or gain, or the noise at its site, not the stations. Station Health takes it out before it
        judges any station's signal. The line is its last ${SIG_DAYS} days against its mean over them; the band is ±${esc((sig && sig.r && sig.r.warn_db) || 3)} dB.
        Its noise floor (uncalibrated dBFS) is beside it: everything weaker with the floor where it was is the signal; with the floor up, it is noise.</p>
    </section>`;
  }

  function sigBodyHtml(list, warn, today) {
    if (!list.length) return '';
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="bs-sig-h"><table class="adm-table bs-sig-t">
        <caption class="sr-only">Each receiver's own SNR shift: the last week against the thirty days before, its biggest step, its noise floor, its last ${SIG_DAYS} days</caption>
        <thead><tr><th scope="col">Receiver</th><th scope="col">Last 7 days</th><th scope="col" class="bs-wide">What it says</th><th scope="col">Biggest step</th><th scope="col">${SIG_DAYS} days</th><th scope="col">Stations it is judged by</th></tr></thead>
        <tbody>${list.map(x => {
          const [cls, word, why] = sigVerdict(x, warn);
          return `<tr>
            <th scope="row">${esc(x.name)} <span class="small qs-dim">${esc(SIG_PROTO[x.protocol] || x.protocol)}</span></th>
            <td class="small">${x.week == null ? '—' : esc(sigDb(x.week)) + ' <span class="qs-dim">against the 30 days before</span>'}</td>
            <td class="small"><strong class="${cls}">${esc(word)}</strong>${why ? `<div class="qs-dim">${esc(why)}</div>` : ''}</td>
            <td class="small">${x.step ? `${esc(sigDb(x.step.db))} <span class="qs-dim">on ${esc(new Date(x.step.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }))}</span>` : '<span class="qs-dim">none past the band</span>'}</td>
            <td>${sigSpark(x.days, warn, today)}</td>
            <td class="small">${esc(x.links)}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`;
  }

  function paintSig() {
    if (state.activeTab !== 'basestations') return;
    const el = document.getElementById('bs-sig');
    if (!el) return;
    const s = stationOf();
    if (!isAdmin() || !s) { if (el.innerHTML) { el.innerHTML = ''; el.dataset.sig = ''; } return; }
    if (el.dataset.sig !== String(s.id) || !el.firstElementChild) { el.innerHTML = sigShellHtml(s); el.dataset.sig = String(s.id); }
    const today = Date.parse(new Date(now()).toISOString().slice(0, 10) + 'T00:00:00Z');
    const warn = (sig && sig.r && Number(sig.r.warn_db)) || 3;
    const list = sig && sig.id === s.id && sig.r ? (sig.r.receivers || []).map(rx => sigRead(rx, warn, today)) : [];
    const weaker = list.filter(x => x.week != null && x.week <= -warn);
    const judged = sig && sig.r && sig.r.judged_at ? ` <span class="qs-dim">Judged ${esc(ago(sig.r.judged_at))}.</span>` : '';
    const sum = !sig || sig.id !== s.id ? 'Loading…' : sig.err ? `<span class="txt-bad">${esc(sig.err)}</span>`
      : !list.length ? 'Not judged yet: it needs three or more transmitters heard on their own carriers in a day, on RPi ALERT 0.14 or later.'
      : (weaker.length ? `<strong class="txt-warn">${weaker.map(x => esc(x.name) + ' (' + esc(SIG_PROTO[x.protocol] || x.protocol) + ')').join(', ')}:
          everything ${weaker.length === 1 ? 'it hears is' : 'they hear is'} weaker than the 30 days before</strong> — the receiver, not the stations;
          Station Health has taken it out of theirs.`
        : `Every receiver hears what it usually does, within ${esc(warn)} dB.`) + judged;
    const set = (id, html) => { const e = document.getElementById(id); if (e && e.innerHTML !== html) keepFocus(e, () => { e.innerHTML = html; }); };
    set('bs-sig-sum', sum);
    set('bs-sig-body', sigBodyHtml(list, warn, today));
  }

  async function loadSig() {
    if (!isAdmin() || openId == null || sigBusy) return;
    const id = openId;
    sigBusy = true;
    try {
      const r = await dbRpc('admin_base_station_signal', { p_id: id });
      if (openId !== id) return;
      setNow(r.now);
      sig = { id, r, err: null };
    } catch (err) {
      if (openId !== id) return;
      sig = { id, r: null, err: err.status === 404 ? 'The database does not have this yet — apply db/migrations/0083_station_snr.sql.'
        : 'Could not load its receivers\' signal: ' + err.message };
    } finally {
      sigBusy = false;
    }
    paintSig();
  }

  function sigStart() {
    clearInterval(timers.sig);
    timers.sig = null;
    if (openId == null) return;
    loadSig();
    timers.sig = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') loadSig(); }, SIG_MS);
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
        <div id="bs-mail">${mailHtml()}</div>
      </div>
      <div id="bs-in"></div>
      <div id="bs-detail">${detailHtml()}</div>
      <div id="bs-wf"></div>
      <div id="bs-st"></div>
      <div id="bs-ch"></div>
      <div id="bs-sig"></div>
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
    paintIn();
    paintWf();
    paintSt();
    paintCh();
    paintSig();
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
    set('bs-mail', mailHtml());
    paintIn();
    paintWf();
    paintSt();
    paintCh();
    paintSig();
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

  // The emails' switch (0113). A database without it: said, not an error.
  async function loadMail() {
    if (!isAdmin()) return;
    try { mail = await dbRpc('admin_base_station_mail', {}); }
    catch (err) { if (err.status === 404) mail = false; }
    const el = document.getElementById('bs-mail');
    if (el && state.activeTab === 'basestations') keepFocus(el, () => { el.innerHTML = mailHtml(); });
  }

  async function mailSet(on, afterMin) {
    if (on === false && !(await confirmDialog({ title: 'Stop emailing the administrators?',
      message: 'Nobody will be emailed when a base station goes offline, or when it is back. Every one is still listed here, and each station still tries to get its own link back.',
      confirm: 'Turn the emails off', danger: true }))) return;
    try {
      mail = await dbRpc('admin_base_station_mail_set', { p_on: on, p_after_min: afterMin });
      mailMsg = { text: on === false ? 'Off: nobody is emailed.' : on === true ? 'On.' : 'Saved: after ' + mail.after_min + ' minutes.', cls: 'txt-ok' };
    } catch (err) { mailMsg = { text: 'Not changed: ' + err.message, cls: 'txt-bad' }; }
    const el = document.getElementById('bs-mail');
    if (el && state.activeTab === 'basestations') keepFocus(el, () => { el.innerHTML = mailHtml(); });
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
    clearInterval(timers.list); clearTimeout(timers.detail); clearInterval(timers.watch); clearInterval(timers.wf); clearInterval(timers.ch); clearInterval(timers.sig); clearInterval(timers.st); clearInterval(timers.ing);
    timers.list = timers.detail = timers.watch = timers.wf = timers.ch = timers.sig = timers.st = timers.ing = null;
  }

  function init() {
    if (!isAdmin()) return;
    stop();
    load();
    loadKeys();
    loadMail();
    loadLatest();
    loadIn();
    timers.ing = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') loadIn(); }, IN_MS);
    timers.list = setInterval(() => { if (!document.hidden && state.activeTab === 'basestations') { load(); loadLatest(); } }, LIST_MS);
    if (openId != null) { loadDetail(); wfStart(); stStart(); chStart(); sigStart(); timers.watch = setInterval(() => { if (!document.hidden) watch(false); }, WATCH_MS); }
    if (typeof registerTabTeardown === 'function') registerTabTeardown('base-stations', stop);
  }

  // ── what an administrator does ───────────────────────────────────────────

  function open(id) {
    if (openId === id) { close(); return; }
    openId = id; detail = null; detailErr = null; askErr = null; form = null; formNote = null; logShown = null;
    subTab = 'overview'; openFolds.clear();
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
    st = null;
    stStart();
    ch = null;
    chStart();
    sig = null;
    sigStart();
    announce('Opened ' + (s ? s.label : 'the base station') + '.');
  }

  function close() {
    openId = null; detail = null; askErr = null; form = null; formNote = null; logShown = null;
    wf = null; wfImg = null; wfHoverAt = null; ch = null; sig = null; st = null;
    clearInterval(timers.watch); clearTimeout(timers.detail); clearInterval(timers.wf); clearInterval(timers.ch); clearInterval(timers.sig); clearInterval(timers.st);
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
  function sub(k) { if (!SUB_WORDS[k] || subTab === k) return; subTab = k; repaintLive(); }
  function fold(el) { const k = el.dataset.fold; if (el.open) openFolds.add(k); else openFolds.delete(k); }
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
    list = null; error = null; detail = null; openId = null; askErr = null; keys = null; keysErr = null; keyMsg = null; mail = null; mailMsg = null; form = null; formNote = null; logShown = null; note = '';
    wf = null; wfImg = null; wfHoverAt = null; ch = null; chAcma = null; st = null; ing = null; inAcma = null;
    stop();
    if (state.activeTab === 'basestations') { repaint(); init(); }
  }

  return { render, init, load, open, close, ask, askFrom, cancel, field, stick, resetForm, saveSettings,
           keyField, addKey, removeKey, mailSet, authChanged, wfWindow, chWindow, stWindow, stSave, inWindow, inSave, inGroup, inFor, inAll, inBreakSave, inOpen, inOpenAll, inOpenSave, inStation, inSortBy, sub, fold,
           // Pure, for test/basestations.mjs.
           _liveness: liveness, _flags: flags, _recoverHtml: recoverHtml, _lostHtml: lostHtml, _patchFrom: patchFrom, _formFrom: formFrom, _stickNowHtml: stickNowHtml, _parseChans: parseChans, _checksHtml: checksHtml, _decodersFor: decodersFor, _cmpVersion: cmpVersion, _lastInstall: lastInstall, _wfLoad: loadWf,
           _chRows: chRows, _chVerdict: chVerdict, _inRead: inRead };
})();

if (typeof window !== 'undefined') window.BaseStations = BaseStations;
