// MegaNet — admin-dashboard.js
//
//   AdminDash   the dashboard at the top of the Admin tab: database health,
//               where the bytes are, who is here and who has been, and the
//               visit beacon that makes "who has been" include people who never
//               sign in.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce and
// registerTabTeardown; to datastore.js for dbRpc; to auth.js for Auth. admin.js
// draws it (AdminDash.render into #adm-dash) and loads it (Admin.init);
// app.js's switchTab() and init.js call AdminDash.beacon(). Nothing here runs
// at load.
//
// Everything on it comes from one call, meganet.admin_dashboard() (0043),
// which refuses anybody meganet.is_admin() says no to. It is a reading of the
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
  // Supabase's free tier: 500 MB of database, 1 GB of file storage. The
  // project is on it (README, "a free-tier Supabase project pauses"), so the
  // meters are against those; a paid plan would only make them read low.
  const DB_LIMIT      = 500 * 1024 * 1024;
  const STORAGE_LIMIT = 1024 * 1024 * 1024;
  const AUTO_MS       = 60 * 1000;

  let data    = null;
  let loading = false;
  let error   = null;
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
  // that is carried by a word as well as a colour (never colour alone).
  function tile(label, value, sub, tone) {
    return `<div class="adm-kpi${tone ? ` adm-kpi--${tone}` : ''}">
      <div class="adm-kpi-label">${label}</div>
      <div class="adm-kpi-value">${value}</div>
      ${sub ? `<div class="adm-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function meter(used, limit, label) {
    const p = Math.min(100, pct(used, limit));
    const tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok';
    return `<div class="adm-meter" role="img" aria-label="${escAttr(`${label}: ${p}% of ${bytes(limit)}`)}">
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
        <li title="${escAttr(`${r.k}: ${fmt(r.v)}${r.note ? ` — ${r.note}` : ''}`)}">
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
      return `<div class="adm-col" title="${escAttr(lbl)}">
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

  // ── sections ──

  function healthTiles(d) {
    const db = d.db || {}, c = d.connections || {}, u = d.users || {}, v = d.visits || {};
    const up = db.started_at ? (Date.now() - new Date(db.started_at).getTime()) / 1000 : 0;
    const hit = db.cache_hit != null ? Math.round(db.cache_hit * 1000) / 10 : null;
    const connPct = pct(c.total || 0, db.max_connections || 0);
    const problems = [];
    if (connPct >= 80) problems.push('connections near the limit');
    if (hit != null && hit < 99) problems.push('cache hit below 99%');
    if ((c.idle_in_tx || 0) > 0 && (c.longest_tx_s || 0) > 300) problems.push('a transaction open over 5 min');
    if (pct(db.size_bytes, DB_LIMIT) >= 90) problems.push('database near 500 MB');
    if (String(db.schema_version) !== String(DB_SCHEMA_VERSION)) problems.push(`schema v${db.schema_version}, app expects v${DB_SCHEMA_VERSION}`);
    const today = (v.days || [])[(v.days || []).length - 1] || { signed_in: 0, anonymous: 0, hits: 0 };
    const storageBytes = (d.storage || []).reduce((s, b) => s + Number(b.bytes || 0), 0);
    const storageObjs  = (d.storage || []).reduce((s, b) => s + Number(b.objects || 0), 0);
    const api = d.api || [];
    const calls = r => (api.find(a => a.role === r) || {}).calls || 0;

    return `<div class="adm-kpis">
      ${tile('Health', problems.length ? '⚠ Check' : '✓ Healthy',
             problems.length ? esc(problems.join('; ')) : `Postgres ${esc(String(db.version || '').split(' ')[0])} · up ${span(up)}`,
             problems.length ? 'warn' : 'ok')}
      ${tile('Database size', bytes(db.size_bytes),
             `${meter(db.size_bytes, DB_LIMIT, 'Database size')}${pct(db.size_bytes, DB_LIMIT)}% of the 500 MB free tier`)}
      ${tile('File storage', bytes(storageBytes),
             `${meter(storageBytes, STORAGE_LIMIT, 'File storage')}${num(storageObjs)} files · ${pct(storageBytes, STORAGE_LIMIT)}% of 1 GB`)}
      ${tile('Connections', `${num(c.active)} <small>active</small>`,
             `${num(c.total)} open of ${num(db.max_connections)} · ${num(c.idle_in_tx)} idle in transaction`)}
      ${tile('Cache hit', hit == null ? '—' : `${hit}%`,
             `${num(db.commits)} commits · ${num(db.rollbacks)} rollbacks · ${num(db.deadlocks)} deadlocks`,
             hit != null && hit < 99 ? 'warn' : null)}
      ${tile('Users active now', num(u.active_now),
             `${num(u.sessions_active)} live session${u.sessions_active === 1 ? '' : 's'} · seen 24 h: ${num(u.seen_24h)} · 7 d: ${num(u.seen_7d)} · ${num(u.total)} users`)}
      ${tile('Visitors today', num(today.signed_in + today.anonymous),
             `${num(today.signed_in)} signed in · ${num(today.anonymous)} anonymous · ${num(v.active_15m)} in the last 15 min`)}
      ${tile('API calls', num(calls('anon') + calls('authenticated') + calls('service_role')),
             api.length ? `anonymous ${num(calls('anon'))} · signed in ${num(calls('authenticated'))} · service ${num(calls('service_role'))}`
                        : 'pg_stat_statements is not readable here')}
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
            <td class="small" title="${escAttr(`${num(t.inserts)} inserted · ${num(t.updates)} updated · ${num(t.deletes)} deleted · ${num(t.seq_scans)} sequential and ${num(t.idx_scans)} index scans`)}">${num(t.writes)}</td>
            <td class="small" title="${escAttr(t.last_analyze ? `analysed ${new Date(t.last_analyze).toLocaleString()}` : '')}">${ago(t.last_vacuum)}</td>
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
          <input type="search" class="adm-filter" placeholder="Filter by name or area" value="${escAttr(filter)}"
                 aria-label="Filter tables" oninput="AdminDash.filterTables(this.value)">
        </div>
        <div id="adm-tables">${tablesInner(d)}</div>
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
    try {
      data = await dbRpc('admin_dashboard', {});
      error = null;
      loadedAt = new Date();
    } catch (err) {
      error = err.status === 404
        ? 'The database does not have the dashboard yet — apply db/migrations/0043_admin_dashboard.sql.'
        : `Could not load the dashboard: ${err.message}`;
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
    data = null; error = null; loadedAt = null;
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

  return { render, load, start, stop, sortBy, filterTables, authChanged, beacon, ago, VISITOR_KEY };
})();
if (typeof window !== 'undefined') window.AdminDash = AdminDash;
