// MegaNet — admin-dashboard.js
//
//   AdminDash   the dashboard at the top of the Admin tab: database health,
//               where the bytes are, who is here and who has been, and the
//               visit beacon that makes "who has been" include people who never
//               sign in.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, termHtml, announce and
// registerTabTeardown; to datastore.js for dbRpc; to auth.js for Auth; to
// admin.js for Admin.waitingCount. admin.js draws it (AdminDash.render into
// #adm-dash), loads it (Admin.init) and tells it when the users come back
// (AdminDash.waitingChanged);
// app.js's switchTab() and init.js call AdminDash.beacon(). Nothing here runs
// at load.
//
// Everything on it comes from two calls made together: meganet.admin_dashboard()
// (0043) and, for Behind the scenes, meganet.admin_ops() (0109). Both refuse
// anybody meganet.is_admin() says no to. The Waiting for approval tile counts
// the users admin.js already holds instead. It is a reading of the
// database's own statistics — pg_stat_database, pg_stat_activity, the
// relation sizes, pg_stat_statements — not a copy of Supabase's or
// Cloudflare's dashboards, and it says where its numbers come from.
//
// ── The visit beacon ─────────────────────────────────────────────────────────
// A random id per browser (localStorage `meganet.visitor`), one call when the
// app opens and one the first time each tab is opened in a page's life. The
// database keeps one row per id per day (0043 says what it keeps and what it
// refuses). Nothing is sent that names an anonymous visitor; a signed-in one is
// named by the session the call already carries.
const AdminDash = (function () {

  const VISITOR_KEY = 'meganet.visitor';
  // Supabase's Pro plan, which the project moved to from the free tier (and
  // its 500 MB read-only ceiling): 8 GB of disk included per project, 100 GB
  // of file storage across the organisation. Past 8 GB the disk grows and is
  // billed, or goes read-only if the spend cap is on. The meter reads the
  // database's own size, which is a little under the disk it occupies (the
  // WAL and logs are on the disk too), so it reads slightly low.
  const DB_LIMIT      = 8 * 1024 * 1024 * 1024;
  const STORAGE_LIMIT = 100 * 1024 * 1024 * 1024;
  const AUTO_MS       = 60 * 1000;

  let data    = null;
  let loading = false;
  let error   = null;
  // Behind the scenes (0109): meganet.admin_ops(), asked beside the dashboard.
  // Its own error, so a database without 0109 still draws everything else.
  let ops      = null;
  let opsError = null;
  let loadedAt = null;
  let timer   = null;
  let sort    = { key: 'bytes', dir: -1 };
  let filter  = '';
  const beaconed = new Set();

  // ── formatting ──

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
  }
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

  function ago(ts) {
    if (!ts) return 'never';
    const s = (Date.now() - new Date(ts).getTime()) / 1000;
    if (!isFinite(s)) return '—';
    if (s < 90)            return 'just now';
    if (s < 3600)          return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2)     return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 60)    return `${Math.round(s / 86400)} d ago`;
    return `${Math.round(s / 86400 / 30)} mo ago`;
  }
  function span(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
  }
  const full = ts => (ts ? esc(new Date(ts).toLocaleString()) : '');

  // What part of the app a table belongs to. Ordered: the first match wins, so
  // the narrower patterns come first. A new table lands in "Other" until it is
  // named here, which the dashboard shows rather than hides.
  const AREAS = [
    ['Telemetry & ingest',        /^(reading|ingest|bridge_|mqtt|hfem|link_fade|station_status|alert2|base_station|telemetry)/],
    ['Inspections & maintenance', /^(inspection|measurement_|calibration|maintenance|block_fact|attachment)/],
    ['Flood history & levels',    /^(flood_|station_flood|station_aep|station_gauge|aep)/],
    ['Field photos & equipment',  /^(field_photo|equipment|station_equipment|photo)/],
    ['Stations & network',        /^(station|sensor|repeater|pass_range|radio_network|rm_system|catchment|hub|unit|protocol|quality|sls|river|bureau|doc_meta|printed)/],
    ['Users & access',            /^(app_user|editor_allow|app_visit|app_meta)/],
  ];
  function areaOf(t) {
    if (t.schema === 'auth')    return 'Supabase auth';
    if (t.schema === 'storage') return 'File storage index';
    if (t.schema !== 'meganet') return `${t.schema} schema`;
    for (const [name, re] of AREAS) if (re.test(t.name)) return name;
    return 'Other';
  }

  // ── pieces ──

  // A stat tile: label, the number, one line under it, and an optional tone
  // that is carried by a word as well as a colour (never colour alone). An id
  // lets one tile be redrawn on its own (waitingChanged).
  //
  // `go` makes the whole tile a link to the panel below that has its detail:
  // one heading id, or several joined with | tried in turn (a panel drawn only
  // once its data is in falls back to the section that holds it). The tile is
  // an <a> so it can hold its lines; AdminDash.go scrolls instead of changing
  // the address, so nothing else that reads the hash is disturbed. `extra` goes
  // between the number and the line under it (the costs tile's month).
  function tile(label, value, sub, tone, id, go, extra = '') {
    const cls = `adm-kpi${tone ? ` adm-kpi--${tone}` : ''}${go ? ' adm-kpi--go' : ''}`;
    const inner = `
      <div class="adm-kpi-label">${label}</div>
      <div class="adm-kpi-value">${value}</div>
      ${extra}
      ${sub ? `<div class="adm-kpi-sub">${sub}</div>` : ''}`;
    if (!go) return `<div class="${cls}"${id ? ` id="${id}"` : ''}>${inner}</div>`;
    const first = go.split('|')[0];
    return `<a class="${cls}" href="#${escAttr(first)}" data-go="${escAttr(go)}"${id ? ` id="${id}"` : ''}
      onclick="return AdminDash.go(event, this.dataset.go)">${inner}<span class="sr-only"> — show the details below</span></a>`;
  }

  // A tile's click: the first of its targets that is on the page, scrolled to
  // the top of the view (smoothly, unless the person asked for less motion),
  // its heading given the focus so a keyboard carries on from there, and its
  // panel ringed for a moment so the eye finds it.
  function go(e, targets) {
    if (e && e.preventDefault) e.preventDefault();
    const el = String(targets || '').split('|').map(id => document.getElementById(id)).find(Boolean);
    if (!el) return false;
    const panel = el.closest('.panel') || el;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    panel.classList.remove('adm-flash');
    void panel.offsetWidth;
    panel.classList.add('adm-flash');
    setTimeout(() => panel.classList.remove('adm-flash'), 1600);
    return false;
  }

  // Everything paid for Flood-Net so far, big, and a month now under it, in A$
  // — from the Running costs panel (admin-costs.js), which the tile opens.
  function costsTile() {
    if (typeof AdminCosts === 'undefined') return '';
    const s = AdminCosts.summary();
    const month = s.month.lo === s.month.hi ? `A$${s.month.lo}` : AdminCosts.bigAud(s.month.lo, s.month.hi);
    return tile(termHtml('Costs to date', AdminCosts.WORDS.todate), AdminCosts.bigAud(s.lo, s.hi, s.guessed.length > 0),
      `since ${esc(AdminCosts.day(s.since))}${s.guessed.length ? ` · ${esc(s.guessed.join(' and '))}’s start a guess` : ''} · with the card fee, before GST`,
      null, 'adm-kpi-costs', 'adm-costs-h',
      `<div class="adm-kpi-value2">${month} <small>a month</small></div>`);
  }

  function meter(used, limit, label) {
    const p = Math.min(100, pct(used, limit));
    const tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok';
    return `<div class="adm-meter" role="img" aria-label="${esc(`${label}: ${p}% of ${bytes(limit)}`)}">
      <span class="adm-meter-fill adm-meter--${tone}" style="width:${p}%"></span></div>`;
  }

  // Horizontal bars, one hue, largest first: magnitude is the only job here.
  // The value is printed in text ink beside every bar, so the length is never
  // the only way to read it, and the title is the hover.
  function bars(rows, { fmt = num, id } = {}) {
    if (!rows.length) return '<p class="small table-empty">Nothing recorded yet.</p>';
    const max = Math.max(...rows.map(r => r.v), 1);
    return `<ul class="adm-bars"${id ? ` aria-labelledby="${id}"` : ''}>
      ${rows.map(r => `
        <li title="${esc(`${r.k}: ${fmt(r.v)}${r.note ? ` — ${r.note}` : ''}`)}">
          <span class="adm-bar-k">${esc(r.k)}</span>
          <span class="adm-bar-track"><span class="adm-bar" style="width:${Math.max(0.5, (r.v / max) * 100)}%"></span></span>
          <span class="adm-bar-v">${esc(fmt(r.v))}</span>
        </li>`).join('')}
    </ul>`;
  }

  // Visitors a day for thirty days: stacked columns, signed in under anonymous,
  // each a hover target the full height of the plot. Two series, so a legend,
  // and the table under it for anyone who cannot read the columns.
  function visitsChart(days) {
    const max = Math.max(1, ...days.map(d => d.signed_in + d.anonymous));
    const cols = days.map(d => {
      const tot = d.signed_in + d.anonymous;
      const lbl = `${d.day}: ${d.signed_in} signed in, ${d.anonymous} anonymous, ${d.hits} opens`;
      return `<div class="adm-col" title="${esc(lbl)}">
        <span class="adm-col-seg adm-col--in" style="height:${(d.signed_in / max) * 100}%"></span>
        <span class="adm-col-seg adm-col--anon" style="height:${(d.anonymous / max) * 100}%"></span>
        ${tot ? '' : '<span class="adm-col-zero"></span>'}
      </div>`;
    }).join('');
    const first = days[0]?.day || '', last = days[days.length - 1]?.day || '';
    return `
      <div class="adm-legend small">
        <span><i class="adm-sw adm-col--in"></i>Signed in</span>
        <span><i class="adm-sw adm-col--anon"></i>Anonymous</span>
      </div>
      <div class="adm-chart" role="img" aria-label="Visitors a day for the last 30 days; the table below has the numbers">
        <div class="adm-chart-y small"><span>${max}</span><span>0</span></div>
        <div class="adm-cols">${cols}</div>
      </div>
      <div class="adm-chart-x small"><span>${esc(first)}</span><span>${esc(last)} (UTC)</span></div>
      <details><summary class="small">Table</summary>
        <div class="table-wrap medium" role="region" tabindex="0" aria-label="Visitors a day">
          <table class="adm-table"><caption class="sr-only">Visitors a day, last 30 days</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">Signed in</th><th scope="col">Anonymous</th><th scope="col">Opens</th></tr></thead>
            <tbody>${days.slice().reverse().map(d => `<tr><td>${esc(d.day)}</td><td>${d.signed_in}</td><td>${d.anonymous}</td><td>${d.hits}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`;
  }

  // What the tiles' words mean (CLAUDE.md "Plain words"): the label's hover.
  // The line under the tile says it in words too, for a finger or a keyboard.
  const WORDS = {
    waiting: 'Accounts that have confirmed their email address and are waiting for an administrator to approve or decline them. '
      + 'Their address is not on the allowlist, so nobody let them in automatically (Bureau addresses never wait). '
      + 'Until approved they cannot see the field photos or inspection records.',
  };

  // Accounts waiting for an administrator (0062), pulled out as its own tile:
  // the count in the Waiting for approval panel below, read from the same list
  // (Admin.load(), which every refresh here brings) so the two never disagree.
  // Before that list is in, whoami's approvals_waiting, which counts the same
  // accounts. Nobody waiting is a plain 0, not a blank.
  function waitingTile() {
    const listed = typeof Admin !== 'undefined' && Admin.waitingCount ? Admin.waitingCount() : null;
    const n = listed != null ? listed
      : (typeof Auth !== 'undefined' && Auth.approvalsWaiting ? Auth.approvalsWaiting() : 0);
    const sub = n
      ? `${n === 1 ? 'account' : 'accounts'} to approve or decline · <span class="adm-kpi-go">See the list</span>`
      : 'Nobody is waiting';
    return tile(termHtml('Waiting for approval', WORDS.waiting), num(n), sub, n ? 'warn' : null, 'adm-kpi-waiting',
      'adm-waiting|adm-people');
  }

  // Admin.load() calls this when the users come back, so an approval below
  // moves the number without redrawing the rest of the dashboard.
  function waitingChanged() {
    const el = document.getElementById('adm-kpi-waiting');
    if (el) el.outerHTML = waitingTile();
  }

  // ── sections ──

  function healthTiles(d) {
    const db = d.db || {}, c = d.connections || {}, u = d.users || {}, v = d.visits || {};
    const up = db.started_at ? (Date.now() - new Date(db.started_at).getTime()) / 1000 : 0;
    const hit = db.cache_hit != null ? Math.round(db.cache_hit * 1000) / 10 : null;
    const connPct = pct(c.total || 0, db.max_connections || 0);
    // Behind the scenes' own problems first: data stopping or a base station
    // gone is what an administrator opens the tab to find out.
    const opsP = ops ? opsProblems(ops) : [];
    const problems = opsP.map(p => p.text);
    if (connPct >= 80) problems.push('connections near the limit');
    if (hit != null && hit < 99) problems.push('cache hit below 99%');
    if ((c.idle_in_tx || 0) > 0 && (c.longest_tx_s || 0) > 300) problems.push('a transaction open over 5 min');
    if (pct(db.size_bytes, DB_LIMIT) >= 90) problems.push('database near the 8 GB included disk');
    if (String(db.schema_version) !== String(DB_SCHEMA_VERSION)) problems.push(`schema v${db.schema_version}, app expects v${DB_SCHEMA_VERSION}`);
    const today = (v.days || [])[(v.days || []).length - 1] || { signed_in: 0, anonymous: 0, hits: 0 };
    const storageBytes = (d.storage || []).reduce((s, b) => s + Number(b.bytes || 0), 0);
    const storageObjs  = (d.storage || []).reduce((s, b) => s + Number(b.objects || 0), 0);
    const api = d.api || [];
    const calls = r => (api.find(a => a.role === r) || {}).calls || 0;

    return `<div class="adm-kpis">
      ${tile('Health', problems.length ? '⚠ Check' : '✓ Healthy',
             problems.length ? esc(problems.join('; ')) : `Postgres ${esc(String(db.version || '').split(' ')[0])} · up ${span(up)}`,
             opsP.some(p => p.bad) ? 'bad' : problems.length ? 'warn' : 'ok', null, opsP.length ? 'adm-ops-h' : 'adm-src-h')}
      ${costsTile()}
      ${tile('Database size', bytes(db.size_bytes),
             `${meter(db.size_bytes, DB_LIMIT, 'Database size')}${pct(db.size_bytes, DB_LIMIT)}% of the 8 GB disk included on Pro`,
             null, null, 'adm-vol-h')}
      ${tile('File storage', bytes(storageBytes),
             `${meter(storageBytes, STORAGE_LIMIT, 'File storage')}${num(storageObjs)} files · ${pct(storageBytes, STORAGE_LIMIT)}% of the 100 GB included on Pro`,
             null, null, 'adm-bkt-h|adm-vol-h')}
      ${tile('Connections', `${num(c.active)} <small>active</small>`,
             `${num(c.total)} open of ${num(db.max_connections)} · ${num(c.idle_in_tx)} idle in transaction`,
             null, null, 'adm-src-h')}
      ${tile('Cache hit', hit == null ? '—' : `${hit}%`,
             `${num(db.commits)} commits · ${num(db.rollbacks)} rollbacks · ${num(db.deadlocks)} deadlocks`,
             hit != null && hit < 99 ? 'warn' : null, null, 'adm-tbl-h')}
      ${waitingTile()}
      ${tile('Users active now', num(u.active_now),
             `${num(u.sessions_active)} live session${u.sessions_active === 1 ? '' : 's'} · seen 24 h: ${num(u.seen_24h)} · 7 d: ${num(u.seen_7d)} · ${num(u.total)} users`,
             null, null, 'adm-users-h|adm-people')}
      ${tile('Visitors today', num(today.signed_in + today.anonymous),
             `${num(today.signed_in)} signed in · ${num(today.anonymous)} anonymous · ${num(v.active_15m)} in the last 15 min`,
             null, null, 'adm-vis-h')}
      ${tile('API calls', num(calls('anon') + calls('authenticated') + calls('service_role')),
             api.length ? `anonymous ${num(calls('anon'))} · signed in ${num(calls('authenticated'))} · service ${num(calls('service_role'))}`
                        : 'pg_stat_statements is not readable here', null, null, 'adm-api-h')}
    </div>`;
  }

  function volumeHtml(d) {
    const tables = d.tables || [];
    const by = new Map();
    for (const t of tables) {
      const a = areaOf(t);
      const cur = by.get(a) || { k: a, v: 0, n: 0 };
      cur.v += Number(t.bytes) || 0; cur.n++;
      by.set(a, cur);
    }
    const listed = [...by.values()].reduce((s, r) => s + r.v, 0);
    const rest = Math.max(0, Number(d.db?.size_bytes || 0) - listed);
    const rows = [...by.values()].map(r => ({ ...r, note: `${r.n} table${r.n === 1 ? '' : 's'}` }))
      .sort((a, b) => b.v - a.v);
    if (rest) rows.push({ k: 'System catalog & other schemas', v: rest, note: 'Postgres catalogs, extensions, Supabase internals' });
    const buckets = (d.storage || []).map(b => ({ k: b.bucket, v: Number(b.bytes) || 0,
      note: `${num(b.objects)} files, last ${ago(b.last_at)}` }));
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-vol-h">Where the data is</h3></div>
        <p class="small">The database's ${bytes(d.db?.size_bytes)} by part of the app — tables and their indexes.</p>
        ${bars(rows, { fmt: bytes, id: 'adm-vol-h' })}
        ${buckets.length ? `<h4 class="adm-sub-h" id="adm-bkt-h">File storage buckets <span class="small">(outside the database)</span></h4>
          ${bars(buckets, { fmt: bytes, id: 'adm-bkt-h' })}` : ''}
      </div>`;
  }

  function accessHtml(d) {
    const v = d.visits || {};
    const api = (d.api || []).filter(a => a.calls > 0)
      .map(a => ({ k: ROLE_NAMES[a.role] || a.role, v: Number(a.calls), note: `${num(a.rows)} rows, ${num(Math.round(a.ms))} ms` }));
    const tabs = (v.tabs || []).slice(0, 12).map(t => ({ k: tabLabel(t.tab), v: Number(t.visitors) }));
    const dev = v.devices || {};
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-vis-h">Visitors, last 30 days</h3></div>
        <p class="small">${num(v.visitors_30d)} browsers, ${num(v.anonymous_30d)} of them never signed in.
          Last anonymous visit ${ago(v.last_anonymous_at)}.
          ${Object.keys(dev).length ? `Devices: ${Object.entries(dev).map(([k, n]) => `${esc(k)} ${num(n)}`).join(' · ')}.` : ''}
          ${v.since ? `Counting since ${esc(v.since)}.` : 'Counting starts with this release.'}</p>
        ${visitsChart(v.days || [])}
        <h4 class="adm-sub-h" id="adm-tabs-h">Most-opened tabs <span class="small">(browsers, 30 days)</span></h4>
        ${bars(tabs, { id: 'adm-tabs-h' })}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="adm-api-h">Database calls by who asked</h3></div>
        <p class="small">Every statement the Data API ran, by the role it ran as, since the
          statistics were last reset${d.db?.stats_reset ? ` (${full(d.db.stats_reset)})` : ''}.
          Anonymous is the app and the agent API read without a sign-in; service is the
          syncs and GitHub Actions.</p>
        ${api.length ? bars(api, { id: 'adm-api-h' }) : '<p class="small">pg_stat_statements is not readable from here.</p>'}
        ${(d.slow || []).length ? `<details><summary class="small">Busiest statements (by total time)</summary>
          <div class="table-wrap medium" role="region" tabindex="0" aria-label="Busiest statements">
            <table class="adm-table"><caption class="sr-only">The statements that took the most database time</caption>
              <colgroup><col style="width:7rem"><col style="width:5rem"><col style="width:5rem"><col style="width:auto"></colgroup>
              <thead><tr><th scope="col">Role</th><th scope="col">Calls</th><th scope="col">Mean</th><th scope="col">Statement</th></tr></thead>
              <tbody>${d.slow.map(s => `<tr><td class="small">${esc(ROLE_NAMES[s.role] || s.role)}</td><td>${num(s.calls)}</td>
                <td>${esc(s.mean_ms)} ms</td><td><code class="adm-sql">${esc(s.query)}</code></td></tr>`).join('')}</tbody>
            </table>
          </div></details>` : ''}
      </div>`;
  }

  const ROLE_NAMES = { anon: 'Anonymous', authenticated: 'Signed in', service_role: 'Service (syncs)',
                       authenticator: 'API gateway', postgres: 'Owner (postgres)' };

  function tabLabel(id) {
    const t = typeof TAB_LIST !== 'undefined' && TAB_LIST.find(x => x.id === id);
    return t ? `${t.icon} ${t.label}` : id;
  }

  const COLS = [
    ['name', 'Table'], ['area', 'Area'], ['rows', 'Rows'], ['bytes', 'Size'],
    ['index_bytes', 'Indexes'], ['dead', 'Dead'], ['writes', 'Writes'], ['last_vacuum', 'Vacuumed'],
  ];

  function tableRows(d) {
    const q = filter.trim().toLowerCase();
    return (d.tables || []).map(t => ({
      ...t,
      full: `${t.schema}.${t.name}`,
      area: areaOf(t),
      dead: t.rows + (t.dead_rows || 0) ? pct(t.dead_rows || 0, t.rows + (t.dead_rows || 0)) : 0,
      writes: (t.inserts || 0) + (t.updates || 0) + (t.deletes || 0),
    }))
      .filter(t => !q || t.full.toLowerCase().includes(q) || t.area.toLowerCase().includes(q))
      .sort((a, b) => {
        const k = sort.key === 'name' ? 'full' : sort.key;
        const x = a[k], y = b[k];
        if (typeof x === 'string' || typeof y === 'string') return sort.dir * String(x ?? '').localeCompare(String(y ?? ''));
        return sort.dir * ((Number(x) || 0) - (Number(y) || 0));
      });
  }

  function tablesInner(d) {
    const rows = tableRows(d);
    return `
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="adm-tbl-h">
        <table class="adm-table adm-tables">
          <caption class="sr-only">Every table in the meganet, auth, storage and public schemas, sortable</caption>
          <colgroup><col style="width:26%"><col style="width:17%"><col style="width:9%"><col style="width:9%">
            <col style="width:9%"><col style="width:7%"><col style="width:9%"><col style="width:14%"></colgroup>
          <thead><tr>${COLS.map(([k, l]) => `<th scope="col" aria-sort="${sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">
            <button class="adm-sort" onclick="AdminDash.sortBy('${k}')">${l}${sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
          <tbody>${rows.map(t => `<tr>
            <td><code>${esc(t.schema === 'meganet' ? t.name : t.full)}</code>${t.rls ? '' : ' <span class="badge" title="Row level security is off">no RLS</span>'}</td>
            <td class="small">${esc(t.area)}</td>
            <td>${num(t.rows)}</td>
            <td>${bytes(t.bytes)}</td>
            <td class="small">${bytes(t.index_bytes)}</td>
            <td class="small${t.dead >= 20 && (t.dead_rows || 0) > 1000 ? ' txt-warn' : ''}">${t.dead}%</td>
            <td class="small" title="${esc(`${num(t.inserts)} inserted · ${num(t.updates)} updated · ${num(t.deletes)} deleted · ${num(t.seq_scans)} sequential and ${num(t.idx_scans)} index scans`)}">${num(t.writes)}</td>
            <td class="small" title="${esc(t.last_analyze ? `analysed ${new Date(t.last_analyze).toLocaleString()}` : '')}">${ago(t.last_vacuum)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <p class="small">${rows.length} of ${(d.tables || []).length} tables. Rows are Postgres's live-row
        count; "Dead" is rows waiting for vacuum; writes are since the statistics were last reset.</p>`;
  }

  function tablesHtml(d) {
    return `
      <div class="panel adm-span">
        <div class="panel-header">
          <h3 id="adm-tbl-h">Tables</h3>
          <input type="search" class="adm-filter" placeholder="Filter by name or area" value="${esc(filter)}"
                 aria-label="Filter tables" oninput="AdminDash.filterTables(this.value)">
        </div>
        <div id="adm-tables">${tablesInner(d)}</div>
      </div>`;
  }

  // ── behind the scenes (0109) ──
  //
  // What the owner's separate health page showed that this tab did not: data
  // flowing in, the base stations and their receivers, what is waiting on an
  // administrator, the database's scheduled jobs and how fast it is filling.
  // All of it from meganet.admin_ops(), which reads rollups and indexes only —
  // that page read the whole reception table on every open.

  // What the words mean (CLAUDE.md "Plain words"): the hover, and the fold at
  // the foot of the section for a finger or a keyboard. One list.
  const OPS_WORDS = {
    heard:      'When a base station\'s radio last heard a packet from any transmitter, by the base station\'s own clock. '
              + 'Over 15 minutes is unusual; over an hour, with the network up, means data has stopped coming in.',
    receptions: 'Every packet a base station\'s radio picked up and sent in — decoded or not, duplicates included. '
              + 'Counted from the hourly summaries, so the newest hour appears about ten minutes after it ends.',
    failed:     'Receptions whose bits did not check out (a bad checksum, a broken frame or noise), so they carry no reading. '
              + 'A few percent is normal; a jump points at interference or a weak link.',
    readings:   'Values from a station — a river level, rain, a battery — stored in the database. One packet can carry one reading.',
    basestation:'A computer with a radio receiver (a Raspberry Pi with an SDR stick, say) that listens to the network and sends what it hears here.',
    online:     'Online: checked in within three of its own check-in intervals (never less than three minutes). '
              + 'Quiet: last check-in within the hour. Offline: nothing for over an hour. Off: the station turned check-ins off itself. '
              + 'The same rule as the Base Stations tab.',
    receiver:   'One radio on a base station. "Running" is what it said at its last check-in; the decoded count is packets it has decoded since it started.',
    findings:   'Problems Station Health has found and not yet seen clear: critical (data stopped), to watch (getting worse) and notes. '
              + 'They clear themselves when the problem goes away.',
    tokens:     'A base station asking for its key so it can send data. It waits until an administrator approves it in Ingest tokens below.',
    push:       'Phones or computers signed up for administrator notifications whose last messages could not be delivered. '
              + 'Usually a device that was reset or uninstalled the app — remove it under Notifications.',
    jobs:       'Work the database does on a timer by itself (pg_cron): summing readings into hourly and daily totals, archiving old rows, '
              + 'checking base stations and transmitters, sending account emails. A failed run is retried at the next time.',
    growth:     'How much bigger the database got a day, measured from a snapshot taken once a day (01:41 Brisbane) — up to a week back. '
              + 'Supabase Pro includes 8 GB of disk; past that it costs more.',
  };
  const OPS_GLOSSARY = [
    ['heard', 'Last packet heard'], ['receptions', 'Receptions'], ['failed', 'Failed to decode'], ['readings', 'Readings'],
    ['basestation', 'Base station'], ['online', 'Online, quiet, offline, off'], ['receiver', 'Receiver'],
    ['findings', 'Health findings'], ['tokens', 'Token requests'], ['push', 'Notification devices failing'],
    ['jobs', 'Scheduled jobs'], ['growth', 'Database growth'],
  ];

  // What each of the database's own jobs is for, by its pg_cron name less the
  // schema's prefix (the name the table shows).
  const JOB_ABOUT = {
    'account-mail':                'Emails administrators about accounts waiting, and people when they are approved.',
    'base-station-health':         'Opens and clears findings for base stations that stop checking in and receivers that stop decoding.',
    'flip-sources':                'Works out which repeater a corrupted (bit-flipped) packet came through.',
    'retain':                      'Archives readings and receptions past their keep-time to R2, then deletes them here.',
    'roll-up':                     'Sums readings into the hourly and daily totals the charts read.',
    'roll-up-carriers':            'Sums each transmitter\'s signal by the day, for the drift and signal-strength checks.',
    'roll-up-receptions':          'Sums receptions into the hourly and daily totals (the chart above reads them).',
    'transmitter-health':          'Checks every transmitter for drift, off-channel signal and corruption, and opens findings.',
    'size-snapshot':               'Records the database\'s size once a day, for the growth figure.',
  };

  // A pg_cron schedule as words, for the five shapes this database uses; any
  // other is shown as written.
  function cronWords(s) {
    const p = String(s || '').trim().split(/\s+/);
    if (p.length !== 5 || p.slice(2).some(x => x !== '*')) return String(s || '');
    const [m, h] = p;
    let r;
    if ((r = /^\*\/(\d+)$/.exec(m)) && h === '*') return `every ${r[1]} min`;
    if (/^\d+$/.test(m) && h === '*') return `hourly at :${m.padStart(2, '0')}`;
    if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
      const bris = (Number(h) + 10) % 24;   // Brisbane keeps no daylight saving
      return `daily at ${String(bris).padStart(2, '0')}:${m.padStart(2, '0')} Brisbane`;
    }
    return String(s);
  }

  function minsAgo(ts) { return ts ? (Date.now() - new Date(ts).getTime()) / 60000 : Infinity; }
  const hhmm = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

  function opsCounts(o) {
    const st = o.stations || [];
    const jobs = o.jobs || [];
    const w = o.waiting || {};
    const g = o.growth || {};
    const perDay = Number(g.per_day) || 0;
    return {
      online:   st.filter(s => s.state === 'online').length,
      quiet:    st.filter(s => s.state === 'quiet'),
      offline:  st.filter(s => s.state === 'offline'),
      stations: st.filter(s => s.state !== 'off').length,
      receivers: st.reduce((n, s) => n + (s.receivers || []).length, 0),
      rxDown:   st.flatMap(s => (s.receivers || []).filter(r => r.state && r.state !== 'running')
                  .map(r => `${s.label} ${r.name}`)),
      jobsFailedToday: jobs.filter(j => j.failed_24h > 0),
      jobsOff:  jobs.filter(j => j.active === false),
      jobsFailed7d: jobs.reduce((n, j) => n + (Number(j.failed_7d) || 0), 0),
      waiting:  (Number(w.token_requests) || 0) + (Number(w.findings_critical) || 0) + (Number(w.findings_warn) || 0)
                + (Number(w.push_failing) || 0),
      daysLeft: g.measured && perDay > 0 ? Math.floor((DB_LIMIT - Number(g.db_bytes || 0)) / perDay) : null,
      perDay,
    };
  }

  // What the Health tile says when something behind the scenes is wrong, worst
  // first; `bad` turns the tile red rather than amber.
  function opsProblems(o) {
    const f = o.flow || {}, w = o.waiting || {}, n = opsCounts(o);
    const out = [];
    const m = minsAgo(f.last_heard_at);
    if (m > 60) out.push({ bad: true, text: f.last_heard_at ? `no packet heard for ${ago(f.last_heard_at).replace(' ago', '')}` : 'no packet ever heard' });
    else if (m > 15) out.push({ text: 'packets have gone quiet' });
    for (const s of n.offline) out.push({ bad: true, text: `base station ${s.label} offline` });
    if (n.rxDown.length) out.push({ bad: true, text: `receiver not running: ${n.rxDown.join(', ')}` });
    if (n.jobsFailedToday.length) out.push({ bad: true, text: `scheduled job failed today: ${n.jobsFailedToday.map(j => j.name.replace(/^meganet-/, '')).join(', ')}` });
    if (n.daysLeft != null && n.daysLeft < 30) out.push({ bad: true, text: `database full in about ${n.daysLeft} days` });
    if (Number(w.findings_critical) > 0) out.push({ text: `${w.findings_critical} critical health finding${w.findings_critical === 1 ? '' : 's'}` });
    for (const s of n.quiet) out.push({ text: `base station ${s.label} quiet` });
    if (n.jobsOff.length) out.push({ text: `scheduled job turned off: ${n.jobsOff.map(j => j.name).join(', ')}` });
    return out;
  }

  function opsTiles(o) {
    const f = o.flow || {}, w = o.waiting || {}, g = o.growth || {}, n = opsCounts(o);
    const heardM = minsAgo(f.last_heard_at);
    const rx = Number(f.receptions_24h) || 0;
    const failedPct = rx ? Math.round(((rx - (Number(f.ok_24h) || 0)) / rx) * 1000) / 10 : 0;
    const waitBits = [
      w.token_requests ? `${num(w.token_requests)} token request${w.token_requests === 1 ? '' : 's'}` : '',
      (w.findings_critical || 0) + (w.findings_warn || 0) ? `${num((w.findings_critical || 0) + (w.findings_warn || 0))} findings to look at` : '',
      w.push_failing ? `${num(w.push_failing)} device${w.push_failing === 1 ? '' : 's'} failing` : '',
    ].filter(Boolean);
    const jobs = o.jobs || [];
    const jobsOk = jobs.filter(j => j.active !== false && !(j.failed_24h > 0)).length;
    return `<div class="adm-kpis">
      ${tile(termHtml('Last packet heard', OPS_WORDS.heard), esc(f.last_heard_at ? ago(f.last_heard_at) : 'never'),
             `last reading stored ${esc(ago(f.last_reading_at))} · ${num(f.readings_24h)} ${termHtml('readings', OPS_WORDS.readings)} in 24 h`,
             heardM > 60 ? 'bad' : heardM > 15 ? 'warn' : 'ok', 'adm-kpi-heard', 'adm-rx-h')}
      ${tile(termHtml('Receptions · 24 h', OPS_WORDS.receptions), num(rx),
             `${failedPct}% ${termHtml('failed to decode', OPS_WORDS.failed)} · to ${esc(hhmm(f.rolled_to))}`,
             null, 'adm-kpi-rx', 'adm-rx-h')}
      ${tile(termHtml('Base stations online', OPS_WORDS.online), `${num(n.online)} <small>of ${num(n.stations)}</small>`,
             `${num(n.receivers)} receiver${n.receivers === 1 ? '' : 's'}`
               + (n.offline.length ? ` · offline: ${esc(n.offline.map(s => s.label).join(', '))}` : '')
               + (n.quiet.length ? ` · quiet: ${esc(n.quiet.map(s => s.label).join(', '))}` : ''),
             n.offline.length || n.rxDown.length ? 'bad' : n.quiet.length ? 'warn' : n.stations ? 'ok' : null, 'adm-kpi-bs', 'adm-bs-h')}
      ${tile('Waiting on you', num(n.waiting), waitBits.length ? esc(waitBits.join(' · ')) : 'Nothing behind the scenes',
             n.waiting ? 'warn' : null, 'adm-kpi-opsq', 'adm-opsq-h')}
      ${tile(termHtml('Scheduled jobs', OPS_WORDS.jobs),
             o.cron ? `${num(jobsOk)} <small>of ${num(jobs.length)} clean</small>` : '—',
             o.cron ? `${num(n.jobsFailed7d)} failed run${n.jobsFailed7d === 1 ? '' : 's'} in 7 days`
                      + (n.jobsFailedToday.length ? ` · failed today: ${esc(n.jobsFailedToday.map(j => j.name.replace(/^meganet-/, '')).join(', '))}` : '')
                    : 'This database has no pg_cron',
             n.jobsFailedToday.length ? 'bad' : n.jobsOff.length ? 'warn' : o.cron ? 'ok' : null, 'adm-kpi-jobs', 'adm-jobs-h')}
      ${tile(termHtml('Database growth', OPS_WORDS.growth),
             !g.measured ? 'Measuring' : n.perDay > 0 ? `+${bytes(n.perDay)} <small>a day</small>` : 'Not growing',
             !g.measured ? 'the first figure comes a day after the first snapshot'
               : n.daysLeft != null ? `about ${num(n.daysLeft)} days to the 8 GB disk · over ${esc(String(g.days))} days`
               : `over the last ${esc(String(g.days))} days`,
             n.daysLeft != null && n.daysLeft < 30 ? 'bad' : n.daysLeft != null && n.daysLeft < 120 ? 'warn' : null, 'adm-kpi-grow', 'adm-grow-h')}
    </div>`;
  }

  // Receptions a UTC day: decoded on the baseline, failed on top — the visits
  // chart's columns, each a hover target, a legend, and the numbers in a table.
  function receptionsChart(days) {
    const max = Math.max(1, ...days.map(d => Number(d.n) || 0));
    const h = v => `${Math.round((v / max) * 1000) / 10}%`;
    const cols = days.map(d => {
      const ok = Number(d.ok) || 0, bad = Math.max(0, (Number(d.n) || 0) - ok);
      const lbl = `${d.day}: ${num(d.n)} receptions, ${num(ok)} decoded, ${num(bad)} failed`;
      return `<div class="adm-col" title="${esc(lbl)}">
        ${ok ? `<span class="adm-col-seg adm-col--rxok" style="--h:${h(ok)}"></span>` : ''}
        ${bad ? `<span class="adm-col-seg adm-col--rxbad" style="--h:${h(bad)}"></span>` : ''}
        ${d.n ? '' : '<span class="adm-col-zero"></span>'}
      </div>`;
    }).join('');
    const first = days[0]?.day || '', last = days[days.length - 1]?.day || '';
    return `
      <div class="adm-legend small">
        <span><i class="adm-sw adm-col--rxok"></i>Decoded</span>
        <span><i class="adm-sw adm-col--rxbad"></i>${termHtml('Failed to decode', OPS_WORDS.failed)}</span>
      </div>
      <div class="adm-chart" role="img" aria-label="Receptions a day for the last 30 days; the table below has the numbers">
        <div class="adm-chart-y small"><span>${num(max)}</span><span>0</span></div>
        <div class="adm-cols adm-cols--rx">${cols}</div>
      </div>
      <div class="adm-chart-x small"><span>${esc(first)}</span><span>${esc(last)} (UTC, today so far)</span></div>
      <details><summary class="small">Table</summary>
        <div class="table-wrap medium" role="region" tabindex="0" aria-label="Receptions a day">
          <table class="adm-table"><caption class="sr-only">Receptions a day, last 30 days</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">Receptions</th><th scope="col">Decoded</th><th scope="col">Failed</th></tr></thead>
            <tbody>${days.slice().reverse().map(d => `<tr><td>${esc(d.day)}</td><td>${num(d.n)}</td><td>${num(d.ok)}</td>
              <td>${num(Math.max(0, (Number(d.n) || 0) - (Number(d.ok) || 0)))}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`;
  }

  const STATE_TONE = { online: 'ok', quiet: 'warn', offline: 'bad', off: '' };

  function stationsHtml(o) {
    const st = o.stations || [];
    const rows = st.map(s => {
      const rx = s.receivers || [];
      const rxHtml = rx.length ? rx.map(r => `<div><b>${esc(r.name)}</b>${r.kind ? ` <span class="small">${esc(r.kind)}</span>` : ''}
          · <span class="${r.state === 'running' ? 'txt-ok' : 'txt-bad'}">${esc(r.state || 'unknown')}</span>
          · <span class="small" title="${esc(`Decode count last moved ${full(r.changed_at)}`)}">${num(r.decoded)} decoded, last ${esc(ago(r.changed_at))}</span></div>`).join('')
        : '<span class="small">No receiver reported</span>';
      return `<tr>
        <td>${esc(s.label)}</td>
        <td><span class="term-chip adm-state adm-state--${STATE_TONE[s.state] ?? ''}" title="${esc(OPS_WORDS.online)}">${esc(s.state)}</span></td>
        <td class="small" title="${esc(full(s.last_seen_at))}">${esc(ago(s.last_seen_at))}</td>
        <td>${rxHtml}</td>
      </tr>`;
    }).join('');
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-bs-h">${termHtml('Base stations', OPS_WORDS.basestation)} and their ${termHtml('receivers', OPS_WORDS.receiver)}</h3></div>
        ${st.length ? `<div class="table-wrap">
          <table class="adm-table"><caption class="sr-only">Each base station, its state, last check-in and receivers</caption>
            <thead><tr><th scope="col">Base station</th><th scope="col">State</th><th scope="col">Checked in</th><th scope="col">Receivers</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>` : '<p class="small table-empty">No base station has checked in.</p>'}
        <p class="small">More on each — its radios, uplink, settings and what it hears — on
          <button class="link-btn" onclick="switchTab('basestations')">Base Stations</button>.</p>
      </div>`;
  }

  function waitingOpsHtml(o) {
    const w = o.waiting || {};
    const waitingAccounts = typeof Admin !== 'undefined' && Admin.waitingCount ? Admin.waitingCount() : null;
    const row = (label, n, action) => `<li><span>${label}</span><b class="${n ? 'txt-warn' : ''}">${num(n)}</b>${action ? `<span class="small">${action}</span>` : '<span></span>'}</li>`;
    const goBtn = (target, text) => `<button class="link-btn" onclick="return AdminDash.go(event, '${escAttr(target)}')">${text}</button>`;
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-opsq-h">Waiting on you</h3></div>
        <ul class="adm-queue">
          ${waitingAccounts != null ? row('Accounts waiting for approval', waitingAccounts, goBtn('adm-waiting|adm-people', 'See them')) : ''}
          ${row(termHtml('Base stations asking for a key', OPS_WORDS.tokens), w.token_requests, goBtn('adm-req-h|adm-tok-h', 'Ingest tokens'))}
          ${row(`${termHtml('Health findings', OPS_WORDS.findings)} — critical`, w.findings_critical, '<button class="link-btn" onclick="switchTab(\'health\')">Station Health</button>')}
          ${row('Health findings — to watch', w.findings_warn, '')}
          ${row('Health findings — notes', w.findings_info, '')}
          ${row(termHtml('Notification devices failing', OPS_WORDS.push), w.push_failing, goBtn('adm-push-h', 'Notifications'))}
        </ul>
      </div>`;
  }

  function jobsHtml(o) {
    if (!o.cron) {
      return `<div class="panel"><div class="panel-header"><h3 id="adm-jobs-h">Scheduled jobs</h3></div>
        <p class="small">This database has no pg_cron, so nothing runs on a timer.</p></div>`;
    }
    const rows = (o.jobs || []).map(j => {
      const tone = j.failed_24h > 0 ? 'txt-bad' : j.failed_7d > 0 ? 'txt-warn' : '';
      return `<tr>
        <td><span class="term" title="${esc(JOB_ABOUT[j.name.replace(/^meganet-/, '')] || 'One of the database\'s own jobs.')}">${esc(j.name.replace(/^meganet-/, ''))}</span>
          ${j.active === false ? ' <span class="badge">turned off</span>' : ''}
          ${j.last_error_at ? `<div class="small ${tone || 'txt-muted'}">last failed <span title="${esc(full(j.last_error_at))}">${esc(ago(j.last_error_at))}</span>: ${esc(j.last_error || '')}</div>` : ''}</td>
        <td class="small" title="${esc(j.schedule)}">${esc(cronWords(j.schedule))}</td>
        <td>${num(j.ok_7d)}</td>
        <td class="${tone}">${num(j.failed_7d)}</td>
        <td class="small" title="${esc(full(j.last_at))}">${esc(j.last_at ? ago(j.last_at) : 'not in 7 days')}${j.last_status && j.last_status !== 'succeeded' ? ` · ${esc(j.last_status)}` : ''}</td>
      </tr>`;
    }).join('');
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-jobs-h">${termHtml('Scheduled jobs', OPS_WORDS.jobs)} · last 7 days</h3></div>
        <div class="table-wrap">
          <table class="adm-table adm-jobs"><caption class="sr-only">The database's scheduled jobs, their runs in the last 7 days, and each one's last failure under its name</caption>
            <thead><tr><th scope="col">Job</th><th scope="col">Runs</th><th scope="col">OK</th><th scope="col">Failed</th>
              <th scope="col">Last run</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="small">Hover a job for what it does. A failed run is tried again at its next time; a failure today turns the Health tile red.</p>
      </div>`;
  }

  function growthHtml(o) {
    const g = o.growth || {}, n = opsCounts(o);
    let body;
    if (!g.measured) {
      body = `<p class="small">Measuring. The database is ${bytes(g.db_bytes)} now. A snapshot of its size is taken once a day at 01:41 Brisbane
        ${g.first_day ? `(the first on ${esc(g.first_day)})` : ''}; the growth figure appears once one is a day old.</p>`;
    } else {
      const tables = g.tables || [];
      body = `<p class="small">${bytes(g.then_bytes)} → ${bytes(g.db_bytes)} over ${esc(String(g.days))} days:
        ${n.perDay > 0 ? `<b>${bytes(n.perDay)} a day</b>, about ${num(n.daysLeft)} days until the 8 GB disk Supabase Pro includes.` : 'not growing.'}
        Receptions are kept 30 days, so their table reuses the space of the day it deletes rather than growing.</p>
        ${tables.length ? `<h4 class="adm-sub-h" id="adm-grow-t-h">The tables growing most <span class="small">(with their indexes)</span></h4>
          ${bars(tables.map(t => ({ k: String(t.name).replace(/^meganet\./, ''), v: Number(t.per_day) || 0, note: `${bytes(t.bytes)} now` })),
                 { fmt: v => `${bytes(v)}/day`, id: 'adm-grow-t-h' })}` : ''}`;
    }
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-grow-h">${termHtml('Database growth', OPS_WORDS.growth)}</h3></div>
        ${body}
      </div>`;
  }

  // What the other page showed that the database cannot see, and where to
  // look for it meanwhile. Each needs an account token kept on a server.
  function notHereHtml() {
    const ref = (/\/\/([a-z0-9]+)\.supabase\.co/.exec(typeof DB_ORIGIN !== 'undefined' ? DB_ORIGIN : '') || [])[1];
    const sb = p => (ref ? `<a href="https://supabase.com/dashboard/project/${escAttr(ref)}/${p}" target="_blank" rel="noopener">` : '<a>');
    return `
      <div class="panel">
        <div class="panel-header"><h3 id="adm-notyet-h">Not on this page yet</h3></div>
        <p class="small">These need a key to Supabase's or Cloudflare's own accounts, which Flood-Net does not hold. Until then, look there:</p>
        <ul class="small adm-notyet">
          <li><b>Errors at the database's front door</b> — requests the app made that failed. ${sb('logs/edge-logs')}Supabase logs</a></li>
          <li><b>Supabase's security and speed advice</b> — its own checks of the database. ${sb('advisors/security')}Security</a> · ${sb('advisors/performance')}Performance</a></li>
          <li><b>Backups</b> — Supabase Pro takes one a day. ${sb('database/backups/scheduled')}Backups</a></li>
          <li><b>Cloudflare Workers and R2 storage</b> — what runs floodwarning.net and holds the photos and archive.
            <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare</a></li>
          <li><b>Whether floodwarning.net is up</b> — needs a check from outside it, which can message you when it stops answering.</li>
        </ul>
      </div>`;
  }

  function opsGlossaryHtml() {
    return `<div class="panel adm-span"><details class="rd-fold adm-words"><summary><h3 class="bk-inline-h" id="adm-ops-words-h">What the words in Behind the scenes mean</h3></summary>
      <dl class="rd-words">${OPS_GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(OPS_WORDS[k])}</dd>`).join('')}</dl>
    </details></div>`;
  }

  function opsHtml() {
    const head = `<div class="panel-header"><h3 id="adm-ops-h">Behind the scenes</h3></div>`;
    if (opsError) return `<div class="panel adm-dash">${head}<p class="small txt-bad">${esc(opsError)}</p></div>`;
    if (!ops) return `<div class="panel adm-dash">${head}<p class="small">Loading…</p></div>`;
    return `
      <div class="panel adm-dash">${head}
        <p class="small">The data coming in, the base stations hearing it, what is waiting on you, the jobs the database runs on a timer,
          and how fast it is filling up.</p>
        ${opsTiles(ops)}
      </div>
      <div class="adm-dash-grid">
        <div class="stack">
          <div class="panel">
            <div class="panel-header"><h3 id="adm-rx-h">${termHtml('Receptions', OPS_WORDS.receptions)} a day</h3></div>
            <p class="small">Packets the base stations heard, last 30 days. A big jump means more data, and the database filling faster.</p>
            ${receptionsChart(ops.days || [])}
          </div>
          ${waitingOpsHtml(ops)}
          ${growthHtml(ops)}
        </div>
        <div class="stack">
          ${stationsHtml(ops)}
          ${jobsHtml(ops)}
          ${notHereHtml()}
        </div>
        ${opsGlossaryHtml()}
      </div>`;
  }

  // ── the section ──

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn()
      && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  function render() {
    const head = `
      <div class="panel-header adm-dash-head">
        <h2>Dashboard</h2>
        ${isAdmin() ? `<span class="button-group">
          <span class="small adm-stamp">${loading ? 'Loading…' : loadedAt ? `Updated ${loadedAt.toLocaleTimeString()} · refreshes every minute` : ''}</span>
          <button class="exp-btn-sm" onclick="AdminDash.load()">Refresh</button></span>` : ''}
      </div>`;
    if (!isAdmin()) {
      return `<div class="panel">${head}<p class="small">Database health, data volume, and who has been
        using the app — for administrators. ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? ''
          : '<a href="#" onclick="Auth.open();return false">Sign in</a> as one to see it.'}</p></div>`;
    }
    if (error) return `<div class="panel">${head}<p class="small txt-bad">${esc(error)}</p></div>`;
    if (!data) return `<div class="panel">${head}<p class="small">Loading…</p></div>`;
    return `
      <div class="panel adm-dash">${head}${healthTiles(data)}</div>
      ${opsHtml()}
      <div class="adm-dash-grid">
        <div class="stack">${accessHtml(data)}</div>
        <div class="stack">${volumeHtml(data)}</div>
        ${tablesHtml(data)}
      </div>`;
  }

  function repaint() {
    const el = document.getElementById('adm-dash');
    if (el && state.activeTab === 'admin') el.innerHTML = render();
  }

  // `withUsers` false on the tab's first draw, where Admin.init() is loading
  // the users itself; a refresh, by hand or by the timer, brings both.
  async function load({ withUsers = true } = {}) {
    if (!isAdmin()) { repaint(); return; }
    loading = true; repaint();
    // Both at once; either may fail without taking the other with it.
    const [dash, behind] = await Promise.allSettled([dbRpc('admin_dashboard', {}), dbRpc('admin_ops', {})]);
    if (dash.status === 'fulfilled') {
      data = dash.value;
      error = null;
      loadedAt = new Date();
    } else {
      const err = dash.reason || {};
      error = err.status === 404
        ? 'The database does not have the dashboard yet — apply db/migrations/0043_admin_dashboard.sql.'
        : `Could not load the dashboard: ${err.message}`;
    }
    if (behind.status === 'fulfilled') {
      ops = behind.value;
      opsError = null;
    } else {
      const err = behind.reason || {};
      ops = null;
      opsError = err.status === 404
        ? 'The database does not have this section yet — apply db/migrations/0109_admin_behind_the_scenes.sql.'
        : `Could not load Behind the scenes: ${err.message}`;
    }
    loading = false;
    repaint();
    // The users table reads the same visits, so it follows the same refresh.
    if (withUsers && typeof Admin !== 'undefined' && Admin.load) Admin.load();
  }

  // Called by Admin.init() whenever the tab is drawn. Loads once, then every
  // minute while the tab is open; leaving the tab stops it.
  function start() {
    if (!isAdmin()) { repaint(); return; }
    if (!data && !loading) load({ withUsers: false });
    if (!timer) timer = setInterval(() => { if (!document.hidden) load(); }, AUTO_MS);
    registerTabTeardown('admin-dashboard', stop);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function sortBy(k) {
    sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: k === 'name' || k === 'area' ? 1 : -1 };
    const el = document.getElementById('adm-tables');
    if (el && data) el.innerHTML = tablesInner(data);
    document.querySelector(`.adm-tables th[aria-sort]:not([aria-sort="none"]) button`)?.focus();
  }

  // Only the table body is redrawn, so the box being typed in keeps focus.
  function filterTables(v) {
    filter = v;
    const el = document.getElementById('adm-tables');
    if (el && data) el.innerHTML = tablesInner(data);
  }

  function authChanged() {
    data = null; error = null; loadedAt = null; ops = null; opsError = null;
    stop();
    if (state.activeTab === 'admin') { repaint(); start(); }
  }

  // ── the beacon ──

  function visitorId() {
    try {
      let id = localStorage.getItem(VISITOR_KEY);
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
        id = (crypto.randomUUID && crypto.randomUUID())
          || '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
               (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch (_) { return null; }   // storage blocked: no id, no count
  }

  function device() {
    const w = window.innerWidth || 1200;
    return w < 600 ? 'phone' : w < 1100 ? 'tablet' : 'desktop';
  }

  // Fire and forget: a failed count is never the operator's problem. The first
  // one waits a few seconds so a saved session has been adopted and the visit
  // is counted as the person it is.
  function beacon(tab, { delay = 0 } = {}) {
    if (!tab || beaconed.has(tab)) return;
    beaconed.add(tab);
    const send = () => {
      const id = visitorId();
      if (!id || typeof dbRpc !== 'function') return;
      dbRpc('log_visit', { p_visitor: id, p_tab: tab, p_device: device() }).catch(() => {});
    };
    if (delay) setTimeout(send, delay); else send();
  }

  return { render, load, start, stop, go, sortBy, filterTables, authChanged, beacon, ago, waitingChanged, VISITOR_KEY };
})();
if (typeof window !== 'undefined') window.AdminDash = AdminDash;
