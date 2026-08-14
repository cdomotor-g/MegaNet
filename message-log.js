// MegaNet — message-log.js
//
//   MessageLog   the Message Log tab. Every message the datastore accepted,
//                newest first, as a filterable table — the arrival log the
//                Field Data tab's charts are drawn from, one row per reading.
//
// After core.js and app.js, before init.js — index.html holds the order.
// Reaches back to core.js for state, esc/escAttr/csvEscape, dbSelect,
// buildSensorIndex, announce, the registries and removeMap; across to app.js
// for switchTab, addBaseLayers, findRepeaterMatches, primaryRole,
// stationAlertIds and the MAP_FOCUS_DIM_* opacity rules; and across to
// arro-data.js (fieldShow), packets.js (prefillEncoder) and alert2.js for the
// three deep links out of the detail drawer.
//
// What this tab is for, and why it is not the Field Data tab again:
//
//   * **Watching messages arrive.** Fade-margin runs, part swaps and antenna
//     work all end the same way — somebody in a paddock asking "did that one
//     get in?". The Field Data tab answers with a chart of one station's
//     history; this tab answers with the log itself, every station at once,
//     newest first, with a Follow switch that keeps asking.
//   * **The ingress pathway.** Which base heard it, which protocol carried
//     it, which transport delivered it, and how many further copies arrived by
//     which other paths — `path`, `protocol`, `source` and `dup_paths` are
//     columns here, where on a chart they are a tooltip.
//   * **Verifying a calibration onto the trace.** A gauge tipped by hand in
//     the field either lands in this table within a minute or it did not
//     arrive. The raw value is the headline column because raw is the truth —
//     the conversion, when one was recorded, rides beside it.
//   * **Reading history in the office.** The same filters over the same
//     table serve data validation and network-performance review — a window,
//     a pasted list of addresses, a protocol, an ingress path.
//
// One reading is one row is one message copy kept: the datastore deduplicates
// on (addr, reading_ts, value_raw) and counts the further copies, so "the log"
// and "the readings" are the same rows read in arrival order. Raw readings age
// out at ~90 days (the rollups survive); this tab reads the raw table only and
// says so rather than quietly switching to rollups — the Field Data tab is the
// one that knows how to widen.

const MessageLog = (() => {

  // ── constants ──────────────────────────────────────────────────────────────

  const ML_PAGE     = 500;     // rows per request; PostgREST pages until short
  const ML_MAX_ROWS = 5000;    // per query, so a wide-open month cannot hang the tab
  const ML_FOLLOW_MS = 30000;  // Follow re-queries on this clock

  const ML_WINDOWS = [
    ['1h',  'Last hour',      3600000],
    ['6h',  'Last 6 hours',   6 * 3600000],
    ['24h', 'Last 24 hours',  24 * 3600000],
    ['7d',  'Last 7 days',    7 * 86400000],
    ['30d', 'Last 30 days',   30 * 86400000],
  ];

  // Everything meganet.reading holds about a message, minus the generated addr
  // parts the columns below re-derive. One string so the query and the CSV
  // cannot disagree about what came down.
  const ML_SELECT = 'addr,alert_id,station_number,channel,station_id,reading_ts,received_at,'
                  + 'value_raw,value,unit,conversion,quality,protocol,source,path,'
                  + 'dup_count,dup_paths,last_dup_at,raw_id';

  // The vocabularies, as seeded by db/migrations/0006_telemetry.sql. Fetched
  // fresh once per session (they are lookup tables so a new protocol is a row,
  // not a deploy) — these are the fallback when the fetch fails, so the codes
  // still read as words offline.
  const ML_SEED = {
    protocol: { 0: 'unknown', 1: 'alert', 2: 'alert2', 3: 'arro' },
    source:   { 0: 'unknown', 1: 'http', 2: 'mqtt', 3: 'manual', 4: 'backfill', 5: 'serial' },
    quality:  { 0: 'unqualified', 1: 'good', 2: 'suspect', 3: 'estimated', 4: 'bad', 5: 'missing' },
  };

  // The table's columns. `narrow: true` marks the default set for the narrow
  // view — the phone-in-a-paddock set: when did it read, who sent it, on what
  // address, and what raw value arrived. Which columns each view actually
  // shows is the operator's to change, per view, remembered on this device.
  //
  // `ts` is not hideable: it is the leftmost column by design and its cell
  // carries the row's expand button, which is what a keyboard user drives.
  const ML_COLS = [
    { key: 'ts',       label: 'Time',     narrow: true,  fixed: true,
      title: 'When the device says it read — reading_ts. Field clocks drift; the detail drawer shows the received time beside it.' },
    { key: 'received', label: 'Received', narrow: false,
      title: 'When the datastore stored it — received_at. This is the clock you can trust.' },
    { key: 'stn',      label: 'Stn #',    narrow: true,
      title: 'Station number — from the message when it carried one, else from the resolved station.' },
    { key: 'name',     label: 'Station',  narrow: true,
      title: 'The resolved station. An address owned by more than one station shows the first and says how many more.' },
    { key: 'alert',    label: 'AlertID',  narrow: true,
      title: 'The ALERT address the message was addressed to. Empty for satellite/cellular messages, which report under a station number and channel.' },
    { key: 'channel',  label: 'Channel',  narrow: false,
      title: 'Which sensor spoke, for messages addressed by station number. An ALERT address is the sensor, so radio rows have no channel.' },
    { key: 'raw',      label: 'Raw',      narrow: true,
      title: 'value_raw — as transmitted, before any conversion. Raw values are the truth; a rainfall count means nothing without the bucket size.' },
    { key: 'value',    label: 'Value',    narrow: false,
      title: 'The conversion, when the datastore recorded one, with its unit. Display only — the raw column is what arrived.' },
    { key: 'quality',  label: 'Quality',  narrow: false,
      title: 'What the source said about the reading. "unqualified" means nobody said anything — not that anybody checked.' },
    { key: 'protocol', label: 'Protocol', narrow: false,
      title: 'The wire protocol the reading was decoded from — ALERT, ALERT2, an ARRO backfill.' },
    { key: 'source',   label: 'Source',   narrow: false,
      title: 'How it reached us — the transport: HTTP, the MQTT bridge, typed in, backfilled, read off a serial port.' },
    { key: 'path',     label: 'Path',     narrow: false,
      title: 'The repeater or base that delivered the copy we kept, when the adapter knew. The duplicate copies\' paths are in the detail drawer.' },
    { key: 'dup',      label: 'Copies',   narrow: false,
      title: 'How many times this reading was heard in total. Three copies is one transmission heard direct and via two repeaters — the network working.' },
  ];

  // Carrier repeaters on the tray map take the Stations tab's dashed-cyan
  // treatment: cyan means "a pass range pulled this in", never "you named it".
  const ML_CARRIER_RING = '#00acc1';

  // ── state ──────────────────────────────────────────────────────────────────

  function defaultCols(view) {
    return ML_COLS.filter(c => view === 'wide' || c.narrow).map(c => c.key);
  }

  function storedCols(view) {
    try {
      const raw = localStorage.getItem(`mn-ml-cols-${view}`);
      if (!raw) return null;
      const keys = JSON.parse(raw).filter(k => ML_COLS.some(c => c.key === k));
      return keys.length ? [...new Set(['ts', ...keys])] : null;
    } catch (_) { return null; }
  }

  const ml = {
    q: {
      win:     '24h',
      from:    '', to: '',     // custom window, datetime-local strings
      find:    '',             // station / address box; takes a pasted list
      protocol: '', source: '', quality: '',   // '' = any, else the smallint code
      path:    '', channel: '',
      dupsOnly: false,         // only readings heard more than once
      unresolvedOnly: false,   // only rows no station has claimed yet
      order:   'received.desc',
    },
    rows:     null,    // what the last query returned, or null before the first
    capped:   false,
    more:     false,   // the last page came back full, so there is another
    loading:  false,
    error:    '',
    unmatched: [],     // pasted terms that resolved to nothing on file
    seq:      0,       // in-flight query id; a late answer to an old one is dropped
    at:       null,    // when the rows on screen were fetched (ms)
    vocab:    null,    // { protocol, source, quality } Maps code → key
    // Narrow or wide, remembered; first visit on a phone opens narrow.
    view:     localStorage.getItem('mn-ml-view')
              || (typeof window !== 'undefined' && window.innerWidth < BREAKPOINTS.sm ? 'narrow' : 'wide'),
    cols: {
      narrow: storedCols('narrow') || defaultCols('narrow'),
      wide:   storedCols('wide')   || defaultCols('wide'),
    },
    sel:      new Set(),   // selected row keys — what the tray plots and maps
    openKey:  null,        // the one row whose detail drawer is open
    focusKey: null,        // a row a deep link asked for; opened when it arrives
    trayOpen: false,
    map:      null,
    mapLayer: null,
    follow:   false,
    followTimer: null,
    raw:      new Map(),   // raw_id → reading_raw row | 'gone' | 'denied'
  };

  // ── small helpers ──────────────────────────────────────────────────────────

  const p2 = n => String(n).padStart(2, '0');

  function fmtTs(t) {
    const d = new Date(t);
    if (isNaN(d)) return String(t ?? '—');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
         + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }

  function fmtNum(v) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : String(v);
  }

  // The primary key, as a string — stable across re-fetches, which is what
  // keeps a selection alive through Follow's re-queries.
  const rowKey = r => `${r.addr}|${r.reading_ts}|${r.value_raw}`;
  const byKey  = k => (ml.rows || []).find(r => rowKey(r) === k) || null;

  function vocabKey(kind, code) {
    const m = ml.vocab && ml.vocab[kind];
    if (m && m.has(code)) return m.get(code);
    return ML_SEED[kind][code] || (code == null ? '—' : `${kind} ${code}`);
  }

  // ── station resolution ─────────────────────────────────────────────────────
  // The address is the identity, not the station (0006's point 1), so a row
  // resolves to a station three ways, in order of confidence: the station_id
  // the datastore backfilled, the ALERT address against the loaded file, the
  // station number against the loaded file. 604 of 5,122 ALERT addresses
  // belong to more than one station, so an address match names the first and
  // says how many more — a candidate, never an identification.

  let _res = null, _resFor = null;

  function resIndex() {
    if (_res && _resFor === state.data) return _res;
    const byId = new Map(), byNumber = new Map();
    let sensors = null;
    for (const s of (state.data?.stations || [])) {
      byId.set(s.id, s);
      for (const num of [s.station_number, s.site && s.site.number]) {
        if (!num) continue;
        const k = String(num);
        if (!byNumber.has(k)) byNumber.set(k, []);
        byNumber.get(k).push(s);
      }
    }
    _resFor = state.data;
    _res = {
      byId, byNumber,
      get sensors() {
        if (!sensors) sensors = state.data ? buildSensorIndex() : new Map();
        return sensors;
      },
    };
    return _res;
  }

  function rowStation(r) {
    const ri = resIndex();
    if (r.station_id && ri.byId.has(r.station_id)) {
      return { st: ri.byId.get(r.station_id), how: 'resolved by the datastore', others: 0 };
    }
    if (r.alert_id != null) {
      const sts = [...new Set((ri.sensors.get(r.alert_id) || []).map(h => h.station))];
      if (sts.length) return { st: sts[0], how: 'matched on the ALERT address', others: sts.length - 1 };
    }
    if (r.station_number) {
      const list = ri.byNumber.get(String(r.station_number)) || [];
      if (list.length) return { st: list[0], how: 'matched on the station number', others: list.length - 1 };
    }
    return { st: null, how: '', others: 0 };
  }

  // ── the query ──────────────────────────────────────────────────────────────

  function windowRange(q) {
    if (q.win === 'custom') {
      const t0 = Date.parse(q.from), t1 = Date.parse(q.to);
      if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) return null;
      return { t0, t1 };
    }
    const row = ML_WINDOWS.find(w => w[0] === q.win) || ML_WINDOWS[2];
    const t1 = Date.now();
    return { t0: t1 - row[2], t1 };
  }

  // The search box takes a pasted list, the same way the Stations tab's does:
  // commas, semicolons, pipes, tabs and new lines all separate, and a run of
  // bare numbers separated by spaces splits too — `6128 6129` is two
  // addresses, `Mt Stuart` is one name.
  function parseTerms(text) {
    const rough = String(text || '').split(/[,;|\t\r\n]+/).map(t => t.trim()).filter(Boolean);
    const out = [];
    for (const t of rough) {
      if (/^[\d\s]+$/.test(t)) out.push(...t.split(/\s+/));
      else out.push(t);
    }
    return [...new Set(out.filter(Boolean))];
  }

  // Terms into PostgREST `or=` clauses. A number is an exact ALERT address
  // and a station-number prefix at once — exact on the address because a log
  // filtered to "61" matching six thousand rows is noise, prefix on the
  // number because "422001" should find 422001A. A name term goes to the
  // loaded station file and comes back as that station's addresses; a name
  // matching nothing on file is reported rather than silently matching all.
  function resolveTerms(terms) {
    const alertIds = new Set(), numbers = new Set(), unmatched = [];
    const stations = state.data?.stations || [];
    for (const t of terms) {
      if (/^\d+$/.test(t)) {
        const n = +t;
        if (n >= 1 && n <= 65535) alertIds.add(n);
        numbers.add(t);
        continue;
      }
      const tl = t.toLowerCase();
      let hit = false;
      for (const s of stations) {
        if (!String(s.name || '').toLowerCase().includes(tl)) continue;
        hit = true;
        for (const id of stationAlertIds(s)) alertIds.add(id);
        for (const num of [s.station_number, s.site && s.site.number]) {
          if (num) numbers.add(String(num));
        }
      }
      if (!hit) unmatched.push(t);
    }
    const ors = [];
    if (alertIds.size) ors.push(`alert_id.in.(${[...alertIds].join(',')})`);
    for (const num of numbers) {
      // Station numbers are alphanumeric, but a pasted list is whatever it is —
      // strip PostgREST's own punctuation rather than trusting it.
      ors.push(`station_number.like.${num.replace(/[(),."\\*]/g, '')}*`);
    }
    return { ors, unmatched, hadTerms: terms.length > 0 };
  }

  function buildQueryPath(q, win, resolved, offset) {
    const parts = [
      `reading_ts=gte.${encodeURIComponent(new Date(win.t0).toISOString())}`,
      `reading_ts=lt.${encodeURIComponent(new Date(win.t1).toISOString())}`,
    ];
    if (resolved.ors.length) parts.push(`or=(${encodeURIComponent(resolved.ors.join(','))
      .replace(/%2C/g, ',').replace(/%28/g, '(').replace(/%29/g, ')')})`);
    if (q.protocol !== '') parts.push(`protocol=eq.${q.protocol}`);
    if (q.source   !== '') parts.push(`source=eq.${q.source}`);
    if (q.quality  !== '') parts.push(`quality=eq.${q.quality}`);
    if (q.path.trim())     parts.push(`path=ilike.${encodeURIComponent('*' + q.path.trim().replace(/[%*]/g, '') + '*')}`);
    if (q.channel.trim())  parts.push(`channel=ilike.${encodeURIComponent('*' + q.channel.trim().replace(/[%*]/g, '') + '*')}`);
    if (q.dupsOnly)        parts.push('dup_count=gt.0');
    if (q.unresolvedOnly)  parts.push('station_id=is.null');
    const [col, dir] = q.order.split('.');
    const ord = col === 'reading' ? 'reading_ts' : 'received_at';
    parts.push(`order=${ord}.${dir},addr.asc`);
    parts.push(`select=${ML_SELECT}`, `limit=${ML_PAGE}`, `offset=${offset}`);
    return `reading?${parts.join('&')}`;
  }

  async function fetchVocab() {
    if (ml.vocab) return;
    try {
      const [p, s, qy] = await Promise.all([
        dbSelect('protocol?select=code,key&order=code.asc'),
        dbSelect('ingest_source?select=code,key&order=code.asc'),
        dbSelect('quality?select=code,key&order=code.asc'),
      ]);
      ml.vocab = {
        protocol: new Map(p.map(r => [r.code, r.key])),
        source:   new Map(s.map(r => [r.code, r.key])),
        quality:  new Map(qy.map(r => [r.code, r.key])),
      };
    } catch (_) {
      // The seeded copies above stand in; the data is still right, and the
      // next run() tries again by leaving ml.vocab unset.
    }
  }

  // The query. `more` appends the next page to what is on screen; `silent`
  // is Follow's re-poll, which must neither announce (live-region rule 1 —
  // data arriving on its own is not an announcement) nor blank the table
  // while it waits.
  async function run(opts) {
    const { more = false, silent = false } = opts || {};
    const q = ml.q;
    const win = windowRange(q);
    if (!win) {
      ml.error = 'That is not a time window — the "from" moment has to fall before the "to".';
      renderNote(); return;
    }
    const resolved = resolveTerms(parseTerms(q.find));
    ml.unmatched = resolved.unmatched;
    if (resolved.hadTerms && !resolved.ors.length) {
      ml.error = `Nothing to ask for — ${resolved.unmatched.map(t => `“${t}”`).join(', ')} `
               + `match${resolved.unmatched.length === 1 ? 'es' : ''} no station on file.`;
      renderNote(); return;
    }

    const seq = ++ml.seq;
    ml.error = '';
    ml.loading = true;
    if (!silent) renderNote();

    const offset = more && ml.rows ? ml.rows.length : 0;
    let page;
    try {
      page = await dbSelect(buildQueryPath(q, win, resolved, offset));
    } catch (err) {
      if (ml.seq !== seq) return;
      ml.loading = false;
      ml.error = `Could not read the datastore — ${err && err.message || err}. `
               + `${dbHostLabel()} may be unreachable, or asleep; readings need no sign-in, so this is the connection.`;
      renderNote();
      return;
    }
    if (ml.seq !== seq) return;   // superseded

    ml.loading = false;
    ml.at = Date.now();
    ml.rows = more && ml.rows ? ml.rows.concat(page) : page;
    ml.capped = ml.rows.length >= ML_MAX_ROWS;
    // A full page means there may be more; the Load more button is the next one.
    ml.more = page.length === ML_PAGE && !ml.capped;

    // Drop selections and the open drawer for rows that are no longer here —
    // but keep every key that survived, so Follow does not un-tick the tray.
    const keys = new Set(ml.rows.map(rowKey));
    for (const k of [...ml.sel]) if (!keys.has(k)) ml.sel.delete(k);
    if (ml.openKey && !keys.has(ml.openKey)) ml.openKey = null;
    if (ml.focusKey && keys.has(ml.focusKey)) {
      ml.openKey = ml.focusKey;
      ml.sel.add(ml.focusKey);
    }

    renderNote();
    renderTable();
    refreshTray();
    if (ml.focusKey) {
      const el = document.getElementById(`ml-row-${cssKey(ml.focusKey)}`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      ml.focusKey = null;
    }
    if (!silent) {
      announce(`${ml.rows.length.toLocaleString()} message${ml.rows.length === 1 ? '' : 's'} from ${dbHostLabel()}.`);
    }
  }

  // A row key carries : / | . — none of them legal in an id. Hashed cheaply
  // instead; collisions would need two rows sharing every character.
  function cssKey(k) {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // ── rendering — the page ───────────────────────────────────────────────────

  function render() {
    return `
      <div class="ml-wrap">
        ${trayHtml()}
        <div class="panel">
          <div class="panel-header ml-header">
            <h2>Message log</h2>
            <span class="small"
                  title="Every row on this tab is a reading the MegaNet datastore accepted. ARRO's numbers live on the ARRO Data tab and the two are never mixed."
                  >${esc(dbHostLabel())}</span>
            <span class="ml-header-tools">
              <span class="ml-viewswitch" role="group" aria-label="Table width">
                <button class="ml-seg${ml.view === 'narrow' ? ' ml-seg--on' : ''}"
                        aria-pressed="${ml.view === 'narrow'}"
                        title="The few columns that matter in the field — choose which under Columns"
                        onclick="MessageLog.setView('narrow')">Narrow</button>
                <button class="ml-seg${ml.view === 'wide' ? ' ml-seg--on' : ''}"
                        aria-pressed="${ml.view === 'wide'}"
                        title="The full record — protocol, transport, ingress path, copies"
                        onclick="MessageLog.setView('wide')">Wide</button>
              </span>
              ${colChooserHtml()}
              <button class="ml-btn" onclick="MessageLog.exportCsv()"
                      title="Every fetched row, every column, whatever the views are showing">Export CSV</button>
            </span>
          </div>
          ${filtersHtml()}
          <div id="ml-note" class="small ml-note" role="status">${noteHtml()}</div>
          <div id="ml-table">${tableHtml()}</div>
        </div>
      </div>`;
  }

  function filtersHtml() {
    const q = ml.q;
    const chip = ([k, label]) => `
      <button class="ml-chip${q.win === k ? ' ml-chip--on' : ''}" aria-pressed="${q.win === k}"
              onclick="MessageLog.setWin('${k}')">${esc(label)}</button>`;
    const sel = (kind, label, title) => {
      const cur = q[kind];
      const opts = Object.entries(ML_SEED[kind])
        .map(([code, key]) => {
          const k = vocabKey(kind, +code);
          return `<option value="${code}" ${String(cur) === code ? 'selected' : ''}>${esc(k)}</option>`;
        }).join('');
      return `
        <label class="ml-f" title="${escAttr(title)}">
          <span>${esc(label)}</span>
          <select onchange="MessageLog.setCode('${kind}', this.value)">
            <option value="">any</option>${opts}
          </select>
        </label>`;
    };
    return `
      <div class="ml-filters">
        <div class="ml-f ml-f--find">
          <label for="ml-find"><span>Station, number or address — one, or a pasted list</span></label>
          <textarea id="ml-find" rows="1" placeholder="e.g. 6128 6129, 541155, Mt Stuart…"
                    title="Commas, semicolons, tabs and new lines all separate; a run of bare numbers splits on spaces. Numbers match an ALERT address exactly and a station number from the start; names go to the loaded station file and come back as its addresses."
                    oninput="MessageLog.setFind(this.value)"
                    onkeydown="MessageLog.findKey(event)">${esc(q.find)}</textarea>
        </div>
        <div class="ml-f ml-f--win" role="group" aria-label="Time window">
          ${ML_WINDOWS.map(chip).join('')}
          <button class="ml-chip${q.win === 'custom' ? ' ml-chip--on' : ''}" aria-pressed="${q.win === 'custom'}"
                  onclick="MessageLog.setWin('custom')">Custom…</button>
        </div>
        ${q.win === 'custom' ? `
        <div class="ml-f ml-f--dates">
          <label><span>From</span>
            <input type="datetime-local" value="${escAttr(q.from)}"
                   onchange="MessageLog.setDate('from', this.value)"></label>
          <label><span>To</span>
            <input type="datetime-local" value="${escAttr(q.to)}"
                   onchange="MessageLog.setDate('to', this.value)"></label>
        </div>` : ''}
        <details class="ml-more">
          <summary>More filters</summary>
          <div class="ml-more-grid">
            ${sel('protocol', 'Protocol', 'The wire protocol the reading was decoded from')}
            ${sel('source',   'Source',   'The transport that delivered it — HTTP, MQTT, serial, typed, backfilled')}
            ${sel('quality',  'Quality',  'What the source said about the reading')}
            <label class="ml-f" title="The repeater or base that delivered the kept copy — substring match">
              <span>Path</span>
              <input type="search" value="${escAttr(q.path)}"
                     onchange="MessageLog.setText('path', this.value)"></label>
            <label class="ml-f" title="The channel, for station-number-addressed messages — substring match">
              <span>Channel</span>
              <input type="search" value="${escAttr(q.channel)}"
                     onchange="MessageLog.setText('channel', this.value)"></label>
            <label class="ml-f" title="Order the log by when we received it, or by when the device says it read">
              <span>Order</span>
              <select onchange="MessageLog.setOrder(this.value)">
                <option value="received.desc" ${q.order === 'received.desc' ? 'selected' : ''}>received, newest first</option>
                <option value="received.asc"  ${q.order === 'received.asc'  ? 'selected' : ''}>received, oldest first</option>
                <option value="reading.desc"  ${q.order === 'reading.desc'  ? 'selected' : ''}>reading time, newest first</option>
                <option value="reading.asc"   ${q.order === 'reading.asc'   ? 'selected' : ''}>reading time, oldest first</option>
              </select></label>
            <label class="ml-check" title="Only readings heard more than once — the repeater-network diagnostic">
              <input type="checkbox" ${q.dupsOnly ? 'checked' : ''}
                     onchange="MessageLog.setFlag('dupsOnly', this.checked)">
              <span>heard more than once</span></label>
            <label class="ml-check" title="Only rows no station has claimed — a new site reporting before anyone added it, or an address nobody recognises">
              <input type="checkbox" ${q.unresolvedOnly ? 'checked' : ''}
                     onchange="MessageLog.setFlag('unresolvedOnly', this.checked)">
              <span>unresolved address only</span></label>
          </div>
        </details>
        <span class="ml-f ml-f--run">
          <button class="primary ml-run" onclick="MessageLog.run()"
                  title="Ask the datastore again with the filters as they stand">${ml.rows ? 'Refresh' : 'Fetch messages'}</button>
          <label class="ml-check" title="Ask again every ${ML_FOLLOW_MS / 1000} seconds while this tab is open — for watching a test message arrive from the field">
            <input type="checkbox" ${ml.follow ? 'checked' : ''}
                   onchange="MessageLog.setFollow(this.checked)">
            <span>follow</span></label>
        </span>
      </div>`;
  }

  function colChooserHtml() {
    const visible = new Set(ml.cols[ml.view]);
    return `
      <details class="ml-colpick">
        <summary title="Which columns the ${ml.view} view shows — remembered on this device, per view">Columns</summary>
        <div class="ml-colpick-list" role="group" aria-label="Columns shown in the ${ml.view} view">
          ${ML_COLS.map(c => `
            <label class="ml-check" title="${escAttr(c.title)}">
              <input type="checkbox" ${visible.has(c.key) ? 'checked' : ''} ${c.fixed ? 'disabled' : ''}
                     onchange="MessageLog.setCol('${c.key}', this.checked)">
              <span>${esc(c.label)}${c.fixed ? ' <span class="small">(always)</span>' : ''}</span>
            </label>`).join('')}
          <button class="ml-btn" onclick="MessageLog.resetCols()"
                  title="Back to the default set for this view">Reset</button>
        </div>
      </details>`;
  }

  function noteHtml() {
    if (ml.error)   return `<span class="txt-bad">${esc(ml.error)}</span>`
                         + ` <button class="ml-btn" onclick="MessageLog.run()">Retry</button>`;
    if (ml.loading) return 'Asking the datastore…';
    if (!ml.rows)   return 'Pick a window and fetch.';
    const bits = [];
    bits.push(`<b>${ml.rows.length.toLocaleString()}</b> message${ml.rows.length === 1 ? '' : 's'}`);
    if (ml.capped) bits.push(`<span class="txt-warn">the ${ML_MAX_ROWS.toLocaleString()}-row cap was reached — this is the ${ml.q.order.endsWith('desc') ? 'newest' : 'oldest'} of the window, not all of it; narrow the window or the filters</span>`);
    else if (ml.more) bits.push('more available — <button class="ml-btn" onclick="MessageLog.loadMore()">load more</button>');
    if (ml.at) bits.push(`as at ${fmtTs(ml.at)}`);
    if (ml.follow) bits.push('following');
    if (ml.unmatched.length) bits.push(`<span class="txt-warn">not in this database: ${ml.unmatched.map(esc).join(', ')}</span>`);
    if (ml.sel.size) bits.push(`${ml.sel.size} selected — <button class="ml-btn" onclick="MessageLog.clearSel()">clear</button>`);
    const days = (Date.now() - (windowRange(ml.q)?.t0 || Date.now())) / 86400000;
    if (days > 80) bits.push('<span class="small">raw readings age out at ~90 days — beyond that the Field Data tab\'s rollups are what survives</span>');
    return bits.join(' · ');
  }

  function renderNote() {
    const el = document.getElementById('ml-note');
    if (el) el.innerHTML = noteHtml();
  }

  // ── rendering — the table ──────────────────────────────────────────────────

  function visibleCols() {
    const keys = ml.cols[ml.view];
    return ML_COLS.filter(c => keys.includes(c.key));
  }

  function cellHtml(c, r, res) {
    switch (c.key) {
      case 'ts':       return '';   // rendered by rowHtml — it carries the expand button
      case 'received': return `<td class="small mono">${esc(fmtTs(r.received_at))}</td>`;
      case 'stn': {
        const num = r.station_number || (res.st && (res.st.station_number || res.st.site?.number)) || '';
        return `<td class="small mono">${esc(String(num || '—'))}</td>`;
      }
      case 'name': {
        const name = res.st ? res.st.name : (r.addr && r.addr.startsWith('a:') ? '' : '');
        const extra = res.others ? ` <span class="small" title="${res.others} more station${res.others === 1 ? ' shares' : 's share'} this address — an ALERT address is only unique within a region">+${res.others}</span>` : '';
        return `<td class="ml-name" title="${escAttr(res.st ? `${res.st.name} — ${res.how}` : 'No station on file claims this message')}">${
          name ? esc(name) + extra : '<span class="small">—</span>'}</td>`;
      }
      case 'alert':    return `<td class="small mono">${r.alert_id != null ? r.alert_id : '—'}</td>`;
      case 'channel':  return `<td class="small">${esc(r.channel || '—')}</td>`;
      case 'raw':      return `<td class="mono ml-raw">${esc(fmtNum(r.value_raw))}</td>`;
      case 'value':    return `<td class="small">${r.value != null ? `${esc(fmtNum(r.value))} ${esc(r.unit || '')}` : '—'}</td>`;
      case 'quality':  return `<td class="small">${esc(vocabKey('quality', r.quality))}</td>`;
      case 'protocol': return `<td class="small">${esc(vocabKey('protocol', r.protocol))}</td>`;
      case 'source':   return `<td class="small">${esc(vocabKey('source', r.source))}</td>`;
      case 'path':     return `<td class="small mono">${esc(r.path || '—')}</td>`;
      case 'dup': {
        const n = (r.dup_count || 0) + 1;
        const via = [r.path, ...(r.dup_paths || [])].filter(Boolean);
        return `<td class="small" title="${escAttr(via.length ? `heard via ${[...new Set(via)].join(', ')}` : 'no path recorded')}">${
          n === 1 ? 'once' : `× ${n}`}</td>`;
      }
      default: return '<td>—</td>';
    }
  }

  function rowHtml(r, cols) {
    const key  = rowKey(r);
    const ck   = cssKey(key);
    const open = ml.openKey === key;
    const res  = rowStation(r);
    const cells = cols.map(c => c.key === 'ts' ? `
      <td class="small mono ml-ts">
        <button class="ml-expand" aria-expanded="${open}" aria-controls="ml-det-${ck}"
                title="${open ? 'Close' : 'Open'} this message's detail — the full record, the pathway, and the decode"
                onclick="MessageLog.toggleRow('${escAttr(key)}')">${esc(fmtTs(r.reading_ts))}</button>
      </td>` : cellHtml(c, r, res)).join('');
    const detail = open ? `
      <tr class="ml-detail" id="ml-det-${ck}">
        <td colspan="${cols.length + 1}">${detailHtml(r, res)}</td>
      </tr>` : '';
    return `
      <tr id="ml-row-${ck}" class="${open ? 'ml-row--open' : ''}${ml.sel.has(key) ? ' ml-row--sel' : ''}"
          onclick="MessageLog.rowClick(event, '${escAttr(key)}')">
        <td class="ml-pick">
          <input type="checkbox" ${ml.sel.has(key) ? 'checked' : ''}
                 aria-label="Select the ${escAttr(fmtTs(r.reading_ts))} message from ${escAttr(res.st ? res.st.name : r.addr)} for the plot and the map"
                 onclick="MessageLog.pickClick(event)"
                 onchange="MessageLog.setSel('${escAttr(key)}', this.checked)">
        </td>
        ${cells}
      </tr>${detail}`;
  }

  function tableHtml() {
    if (!ml.rows) {
      return `<p class="small ml-flush">Nothing fetched yet. Messages the datastore accepts appear here —
        pick a window above${state.data ? '' : ' (station names resolve once the station list loads)'}.</p>`;
    }
    if (!ml.rows.length) {
      const win = windowRange(ml.q);
      return `<p class="small ml-flush">No messages ${win ? `between ${esc(fmtTs(win.t0))} and ${esc(fmtTs(win.t1))}` : 'in this window'}
        for these filters. Silence and a run of zeroes are different claims — nothing was ingested that matches.</p>`;
    }
    const cols = visibleCols();
    const all = ml.rows.every(r => ml.sel.has(rowKey(r)));
    return `
      <div class="table-wrap tall" role="region" tabindex="0" aria-label="The message log — one row per reading the datastore accepted">
        <table class="ml-table">
          <caption class="sr-only">Messages received by the datastore, one row per reading, ${esc(ml.q.order.startsWith('received') ? 'in arrival order' : 'in reading order')}</caption>
          <thead><tr>
            <th scope="col" class="ml-pick">
              <input type="checkbox" ${all && ml.rows.length ? 'checked' : ''}
                     aria-label="Select every fetched message for the plot and the map"
                     onchange="MessageLog.selAll(this.checked)">
            </th>
            ${cols.map(c => `<th scope="col" title="${escAttr(c.title)}">${esc(c.label)}</th>`).join('')}
          </tr></thead>
          <tbody>${ml.rows.map(r => rowHtml(r, cols)).join('')}</tbody>
        </table>
      </div>`;
  }

  function renderTable() {
    const el = document.getElementById('ml-table');
    if (el) el.innerHTML = tableHtml();
  }

  // ── the detail drawer ──────────────────────────────────────────────────────
  // A row opened is the whole record: identity, both clocks, the value and its
  // conversion, the pathway, and the decode — the row's journey from the wire
  // to the columns above it, leaning on the tabs that already know how.

  function bits(n, w) {
    return (n >>> 0).toString(2).padStart(w, '0');
  }

  function detailDecodeHtml(r) {
    const proto = vocabKey('protocol', r.protocol);
    const raw = Number(r.value_raw);
    const out = [];
    if (proto === 'alert' || proto === 'alert2') {
      if (r.alert_id != null && Number.isInteger(raw) && raw >= 0 && raw <= 65535) {
        const aw = r.alert_id <= 8191 ? 13 : 16;
        const vw = raw <= 2047 ? 11 : 16;
        out.push(`
          <div><span>On the wire</span>
            <b class="mono">addr ${r.alert_id} = ${bits(r.alert_id, aw)}<span class="small"> (${aw} bits)</span>
            · value ${raw} = ${bits(raw, vw)}<span class="small"> (${vw} bits)</span></b></div>`);
      }
      if (proto === 'alert' && r.alert_id != null && r.alert_id <= 8191
          && Number.isInteger(raw) && raw >= 0 && raw <= 2047) {
        out.push(`
          <div><span>Rebuild it</span>
            <button class="ml-btn" onclick="MessageLog.openInPackets('${escAttr(rowKey(r))}')"
                    title="Prefill the ALERT Packets encoder with this address and value — the 40-bit frame, the check bits and the bit map, in every format">
              Rebuild the frame on the ALERT Packets tab</button>
            <span class="small">the stored record is the decoded address and value; the framing and check bits are the encoder's to show</span></div>`);
      }
      if (proto === 'alert2') {
        out.push(`
          <div><span>Layout</span><b>ALERT2 / ERT-A2</b>
            <span class="small">four bytes inside a concentration payload — the A2C layout on the ALERT Packets tab decodes one; a whole capture belongs on the ALERT2 / ERT-A2 tab</span></div>`);
      }
    } else {
      out.push(`<div><span>Decode</span><b>${esc(proto)}</b>
        <span class="small">not a radio frame — this arrived already carrying its values</span></div>`);
    }
    return out.join('');
  }

  function detailRawHtml(r) {
    if (r.raw_id == null) {
      return `<div><span>Submission</span><b>—</b>
        <span class="small">no submission reference was stored with this reading</span></div>`;
    }
    const got = ml.raw.get(r.raw_id);
    if (got === undefined) {
      const authed = typeof Auth !== 'undefined' && Auth.isSignedIn && Auth.isSignedIn();
      return `<div><span>Submission</span>
        ${authed
          ? `<button class="ml-btn" onclick="MessageLog.fetchRaw('${escAttr(rowKey(r))}')"
               title="The ingest() call this reading arrived on — the payload as submitted, and the wire frame when the adapter gave one. Kept ~30 days.">
               Fetch the submission as received <span class="small mono">raw #${r.raw_id}</span></button>`
          : `<b class="small">raw #${r.raw_id}</b>
             <span class="small">submissions are not published to anonymous readers — sign in to fetch what the device actually sent (kept ~30 days)</span>`}
        </div>`;
    }
    if (got === 'gone') {
      return `<div><span>Submission</span><b>aged out</b>
        <span class="small">raw #${r.raw_id} — submissions are kept ~30 days and this one is past it; the reading itself is unaffected</span></div>`;
    }
    if (got === 'denied') {
      return `<div><span>Submission</span><b class="txt-warn">refused</b>
        <span class="small">the datastore would not hand raw #${r.raw_id} to this session</span></div>`;
    }
    const frame = got.frame ? `
      <div><span>Wire frame</span><b class="mono ml-frame">${esc(got.frame)}</b>
        ${vocabKey('protocol', r.protocol) === 'alert2'
          ? `<button class="ml-btn" onclick="MessageLog.openInAlert2('${escAttr(rowKey(r))}')"
               title="Hand this frame to the ALERT2 / ERT-A2 tab, which decodes the whole line — framing, ports, receiver clock and all">Decode it on the ALERT2 tab</button>`
          : ''}</div>` : '';
    return `
      <div><span>Submitted</span><b>${esc(fmtTs(got.received_at))}</b>
        <span class="small">accepted ${got.accepted} · duplicates ${got.duplicates} · rejected ${got.rejected}${got.submitted_by ? ` · by ${esc(got.submitted_by)}` : ''}</span></div>
      ${frame}
      <div class="ml-payload"><span>Payload</span>
        <pre class="mono small">${esc(JSON.stringify(got.payload, null, 2))}</pre></div>`;
  }

  function detailHtml(r, res) {
    const lag = Date.parse(r.received_at) - Date.parse(r.reading_ts);
    const via = [...new Set([r.path, ...(r.dup_paths || [])].filter(Boolean))];
    const fieldAddr = r.addr;
    return `
      <div class="ml-det-grid">
        <div><span>Identity</span><b class="mono">${esc(r.addr)}</b>
          <span class="small">${r.alert_id != null
            ? 'the address is the sensor — one ALERT address is one measurement'
            : 'station number and channel — a satellite or cellular message'}</span></div>
        <div><span>Station</span>
          ${res.st ? `<b>${esc(res.st.name)}</b>
            <span class="small">${esc(res.how)}${res.others ? ` — ${res.others} more station${res.others === 1 ? ' shares' : 's share'} this address` : ''}</span>
            <button class="ml-btn" onclick="MessageLog.showStation('${escAttr(res.st.id)}')"
                    title="Open this station on the Stations tab — the map, the editor and the repeaters listening">Show on the Stations tab</button>`
          : `<b>unresolved</b> <span class="small">no station on file claims this address — a new site reports before anyone adds it, and the reading is kept rather than dropped</span>`}
        </div>
        <div><span>Read</span><b class="mono">${esc(fmtTs(r.reading_ts))}</b>
          <span class="small">the device's own clock</span></div>
        <div><span>Received</span><b class="mono">${esc(fmtTs(r.received_at))}</b>
          ${isFinite(lag) ? `<span class="small${Math.abs(lag) > 600000 ? ' txt-warn' : ''}">${lag >= 0 ? '+' : '−'}${Math.round(Math.abs(lag) / 1000)} s after the reading${lag < 0 ? ' — the device clock is ahead of ours' : ''}</span>` : ''}</div>
        <div><span>Raw</span><b class="mono">${esc(fmtNum(r.value_raw))}</b>
          <span class="small">as transmitted — raw values are the truth</span></div>
        <div><span>Converted</span>
          ${r.value != null
            ? `<b>${esc(fmtNum(r.value))} ${esc(r.unit || '')}</b>
               <span class="small">${esc(r.conversion || 'rule not recorded')}</span>`
            : `<b>—</b> <span class="small">no conversion recorded — the raw value stands alone</span>`}</div>
        <div><span>Quality</span><b>${esc(vocabKey('quality', r.quality))}</b></div>
        <div><span>Pathway</span>
          <b>${esc(vocabKey('protocol', r.protocol))} · ${esc(vocabKey('source', r.source))}${r.path ? ` · in at ${esc(r.path)}` : ''}</b>
          <span class="small">protocol · transport${r.path ? ' · ingress point' : ' — the adapter did not say where it came in'}</span></div>
        <div><span>Copies</span>
          <b>heard ${(r.dup_count || 0) + 1} time${r.dup_count ? 's' : ''}</b>
          ${via.length ? `<span class="small mono">via ${esc(via.join(', '))}</span>` : ''}
          ${r.last_dup_at ? `<span class="small">last further copy ${esc(fmtTs(r.last_dup_at))}</span>` : ''}</div>
        ${detailDecodeHtml(r)}
        ${detailRawHtml(r)}
        <div><span>Field Data</span>
          <button class="ml-btn" onclick="MessageLog.openInField('${escAttr(rowKey(r))}')"
                  title="Chart this address' raw readings around this moment on the Field Data tab — the 357 filter, the gaps and the rollups live there">
            Chart <span class="mono">${esc(fieldAddr)}</span> around this reading</button></div>
      </div>`;
  }

  // ── the tray — plot and map over the selection ─────────────────────────────
  // Collapsed by default so the log itself is what the tab opens on. Open, it
  // is two views of the ticked rows: their raw values against time on the
  // left, and on the right the Stations map's own ghosting rules — every pin
  // stays, the selection is at full opacity and named, and the repeaters
  // whose pass ranges carry a selected station come up with it, dashed cyan,
  // exactly as the Stations tab draws a pass-range pull.

  function trayHtml() {
    return `
      <details class="panel ml-tray" id="ml-tray" ${ml.trayOpen ? 'open' : ''}
               ontoggle="MessageLog.trayToggle(this)">
        <summary title="Plot the selected messages and put their stations on the map — tick rows in the table below">
          Plot &amp; map <span class="small" id="ml-tray-sum">${traySummary()}</span>
        </summary>
        <div class="ml-tray-grid">
          <figure class="ml-plot">
            <figcaption class="small">Raw values against reading time, one colour per address
              <span id="ml-plot-legend"></span></figcaption>
            <svg id="ml-plot-svg" viewBox="0 0 640 300" role="img"
                 aria-label="Raw values of the selected messages against time"></svg>
          </figure>
          <div class="ml-mapbox">
            <div id="ml-map" class="ml-map" aria-label="Selected stations, their carrier repeaters, and the rest of the network ghosted"></div>
            <p class="small ml-map-note">Selected stations at full opacity and named; repeaters whose pass
              ranges carry them pulled in dashed cyan; everything else ghosted in place.</p>
          </div>
        </div>
      </details>`;
  }

  function traySummary() {
    return ml.sel.size
      ? `— ${ml.sel.size} message${ml.sel.size === 1 ? '' : 's'} selected`
      : '— tick rows in the table to plot them here';
  }

  function refreshTray() {
    const sum = document.getElementById('ml-tray-sum');
    if (sum) sum.textContent = traySummary();
    if (!ml.trayOpen) return;
    drawPlot();
    refreshTrayMap();
  }

  function selRows() {
    return (ml.rows || []).filter(r => ml.sel.has(rowKey(r)));
  }

  // Theme colours are read from the document rather than written as var()
  // into the SVG — the same rule the ARRO chart follows, and the same twelve
  // series tokens, so a selection here wears the colours a chart there would.
  function themeColor(token, fallback) {
    if (typeof getComputedStyle !== 'function') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return v || fallback;
  }

  function seriesColor(i) {
    return themeColor(`--ad-series-${(i % 12) + 1}`, ['#0b5cab', '#c7401a', '#107c10', '#7c35a3'][i % 4]);
  }

  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + 1; }
    const span = hi - lo;
    const step0 = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
    const t0 = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = t0; v <= hi + 1e-9; v += step) out.push(v);
    return out;
  }

  function drawPlot() {
    const svg = document.getElementById('ml-plot-svg');
    const legend = document.getElementById('ml-plot-legend');
    if (!svg) return;
    const rows = selRows();
    const cText = themeColor('--text', '#16202a'), cMuted = themeColor('--muted', '#4f6478'),
          cBorder = themeColor('--border', '#dde5ee');
    if (!rows.length) {
      svg.innerHTML = `<text x="320" y="150" text-anchor="middle" font-size="13" fill="${cMuted}">Nothing selected — tick rows in the table below.</text>`;
      svg.setAttribute('aria-label', 'No messages selected');
      if (legend) legend.innerHTML = '';
      return;
    }
    // One series per address, points in reading order. Raw values, always —
    // mixing a count series and an engineering series on one axis is exactly
    // what the raw column protects against, so the legend names the unit gap
    // rather than the axis hiding it.
    const byAddr = new Map();
    for (const r of rows) {
      if (!byAddr.has(r.addr)) byAddr.set(r.addr, []);
      byAddr.get(r.addr).push({ t: Date.parse(r.reading_ts), v: Number(r.value_raw) });
    }
    const series = [...byAddr.entries()].map(([addr, pts], i) => {
      pts.sort((a, b) => a.t - b.t);
      const hit = resIndex().sensors.get(+String(addr).replace(/^a:/, '')) || [];
      const label = hit.length && String(addr).startsWith('a:')
        ? `${addr} · ${hit[0].station.name}` : addr;
      return { addr, pts, label, color: seriesColor(i) };
    });

    const W = 640, H = 300, L = 52, R = 12, T = 12, B = 30;
    let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const s of series) for (const p of s.pts) {
      if (p.t < t0) t0 = p.t; if (p.t > t1) t1 = p.t;
      if (p.v < v0) v0 = p.v; if (p.v > v1) v1 = p.v;
    }
    if (t1 <= t0) t1 = t0 + 60000;
    if (v1 <= v0) { v0 -= 1; v1 += 1; }
    const pad = (v1 - v0) * 0.08;
    v0 -= pad; v1 += pad;
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
    const y = v => H - B - (v - v0) / (v1 - v0) * (H - T - B);

    const parts = [];
    for (const v of niceTicks(v0, v1, 5)) {
      parts.push(`<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${cBorder}" stroke-width="1"/>`);
      parts.push(`<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="${cMuted}">${+v.toPrecision(6)}</text>`);
    }
    const spanDays = (t1 - t0) / 86400000;
    for (const t of niceTicks(t0, t1, 5)) {
      const d = new Date(t);
      const lab = spanDays > 2
        ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
        : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
      parts.push(`<line x1="${x(t)}" y1="${H - B}" x2="${x(t)}" y2="${H - B + 4}" stroke="${cMuted}" stroke-width="1"/>`);
      parts.push(`<text x="${x(t)}" y="${H - B + 16}" text-anchor="middle" font-size="10" fill="${cMuted}">${lab}</text>`);
    }
    parts.push(`<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="${cText}" stroke-width="1"/>`);
    parts.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="${cText}" stroke-width="1"/>`);
    for (const s of series) {
      if (s.pts.length > 1) {
        const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
        parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6" opacity=".85"/>`);
      }
      for (const p of s.pts) {
        parts.push(`<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.addr)} · ${esc(fmtTs(p.t))} · raw ${p.v}</title></circle>`);
      }
    }
    svg.innerHTML = parts.join('');
    const n = rows.length;
    svg.setAttribute('aria-label',
      `Raw values of ${n} selected message${n === 1 ? '' : 's'} across ${series.length} address${series.length === 1 ? '' : 'es'}, `
      + `${fmtTs(t0)} to ${fmtTs(t1)}`);
    if (legend) {
      legend.innerHTML = ' · ' + series.map(s =>
        `<span class="ml-key"><span class="ml-dot" style="--dot:${escAttr(s.color)}"></span>${esc(s.label)}</span>`).join(' ');
    }
  }

  // The map. Built when the tray opens, taken down when it closes or the tab
  // is left — through removeMap(), for the reasons on that function.
  function stopTrayMap() {
    ml.map = removeMap(ml.map);
    ml.mapLayer = null;
  }

  function buildTrayMap() {
    stopTrayMap();
    const el = document.getElementById('ml-map');
    if (!el || typeof L === 'undefined') return;
    ml.map = L.map(el, { preferCanvas: true }).setView([-28, 134], 4);
    registerLiveMap('MessageLog', () => ml.map);
    addBaseLayers(ml.map);
    ml.mapLayer = L.layerGroup().addTo(ml.map);
    refreshTrayMap();
  }

  function refreshTrayMap() {
    if (!ml.map || !ml.mapLayer) return;
    const layer = ml.mapLayer;
    layer.clearLayers();
    if (!state.data) return;

    // Which stations the selection names, and the addresses it names them by.
    const picked = new Map();   // station id → { st, addrs:Set }
    for (const r of selRows()) {
      const res = rowStation(r);
      if (!res.st || res.st.lat == null || res.st.lon == null) continue;
      if (!picked.has(res.st.id)) picked.set(res.st.id, { st: res.st, addrs: new Set() });
      picked.get(res.st.id).addrs.add(r.addr);
    }

    // The repeaters whose pass ranges carry a picked station — the Stations
    // tab's own relation, from the same index it reads.
    const carriers = new Map();   // repeater id → { st, serves: [] }
    for (const { st } of picked.values()) {
      for (const rep of findRepeaterMatches(st)) {
        if (rep.lat == null || rep.lon == null || picked.has(rep.id)) continue;
        if (!carriers.has(rep.id)) carriers.set(rep.id, { st: rep, serves: [] });
        carriers.get(rep.id).serves.push(st);
      }
    }

    // Everything else, ghosted in place — the same dim the Stations tab uses
    // when a repeater focus is on, so "faded" reads the same on both maps.
    for (const s of state.data.stations) {
      if (s.lat == null || s.lon == null || picked.has(s.id) || carriers.has(s.id)) continue;
      L.circleMarker([s.lat, s.lon], {
        radius: 4, weight: 1, interactive: false,
        color: ROLE_COLOR[primaryRole(s)],
        fillColor: ROLE_COLOR[primaryRole(s)],
        opacity: MAP_FOCUS_DIM_OPACITY,
        fillOpacity: MAP_FOCUS_DIM_FILLOPACITY,
      }).addTo(layer);
    }

    const bounds = [];

    // Pass-range links first, so the pins draw over them.
    for (const { st: rep, serves } of carriers.values()) {
      for (const st of serves) {
        L.polyline([[rep.lat, rep.lon], [st.lat, st.lon]], {
          color: ROLE_COLOR.repeater, weight: 1.5, opacity: 0.55, dashArray: '5 6',
        }).addTo(layer);
      }
    }

    for (const { st: rep, serves } of carriers.values()) {
      // The dashed cyan ring is the Stations tab's mark for "a pass range
      // pulled this in" — cyan is never a station you named yourself.
      L.circleMarker([rep.lat, rep.lon], {
        radius: 12, color: ML_CARRIER_RING, weight: 2, fill: false,
        dashArray: '3 4', interactive: false,
      }).addTo(layer);
      const m = L.circleMarker([rep.lat, rep.lon], {
        radius: 8, color: '#ffffff', weight: 1.5,
        fillColor: ROLE_COLOR.repeater, fillOpacity: 0.95,
      }).addTo(layer);
      m.bindTooltip(esc(rep.name), {
        permanent: true, direction: 'top', offset: [0, -10], className: 'mn-pin-label',
      });
      m.bindPopup(`<strong>${esc(rep.name)}</strong><br>
        <span class="small">repeater — pass ranges open to ${serves.map(s => esc(s.name)).join(', ')}</span>`);
      bounds.push([rep.lat, rep.lon]);
    }

    for (const { st, addrs } of picked.values()) {
      const role = primaryRole(st);
      const m = L.circleMarker([st.lat, st.lon], {
        radius: role === 'field' ? 7 : 8, color: '#ffffff', weight: 2,
        fillColor: ROLE_COLOR[role], fillOpacity: 1,
      }).addTo(layer);
      m.bindTooltip(esc(st.name), {
        permanent: true, direction: 'bottom', offset: [0, 8], className: 'mn-pin-label',
      });
      m.bindPopup(`<strong>${esc(st.name)}</strong><br>
        <span class="small mono">${esc(st.station_number || st.id)}</span><br>
        <span class="small">selected message${[...addrs].length === 1 ? '' : 's'} on ${[...addrs].map(esc).join(', ')}</span>`);
      bounds.push([st.lat, st.lon]);
    }

    if (bounds.length) ml.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 11 });
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  function setWin(k) {
    ml.q.win = k;
    if (k === 'custom' && !ml.q.from) {
      const iso = t => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
      ml.q.from = iso(Date.now() - 86400000);
      ml.q.to   = iso(Date.now());
    }
    rerender();
    if (k !== 'custom') run();
  }

  function setDate(which, v) { ml.q[which] = v; if (ml.q.from && ml.q.to) run(); }
  function setFind(v)        { ml.q.find = v; }
  function findKey(e) {
    if (e && e.key === 'Enter') { e.preventDefault(); run(); }
  }
  function setCode(kind, v)  { ml.q[kind] = v; run(); }
  function setText(kind, v)  { ml.q[kind] = v; run(); }
  function setFlag(kind, v)  { ml.q[kind] = !!v; run(); }
  function setOrder(v)       { ml.q.order = v; run(); }
  function loadMore()        { run({ more: true }); }

  function setFollow(on) {
    ml.follow = !!on;
    disarmFollow();
    if (ml.follow) armFollow();
    renderNote();
  }

  function armFollow() {
    disarmFollow();
    ml.followTimer = setInterval(() => {
      if (!ml.loading && state.activeTab === 'msglog') run({ silent: true });
    }, ML_FOLLOW_MS);
  }

  function disarmFollow() {
    if (ml.followTimer) { clearInterval(ml.followTimer); ml.followTimer = null; }
  }

  function setView(v) {
    ml.view = v === 'narrow' ? 'narrow' : 'wide';
    try { localStorage.setItem('mn-ml-view', ml.view); } catch (_) {}
    rerender();
  }

  function setCol(key, on) {
    const cols = ml.cols[ml.view];
    const has = cols.includes(key);
    if (on && !has) {
      // Keep the chooser's order — the column order is the table's, always.
      ml.cols[ml.view] = ML_COLS.map(c => c.key).filter(k => k === key || cols.includes(k));
    } else if (!on && has && key !== 'ts') {
      ml.cols[ml.view] = cols.filter(k => k !== key);
    }
    try { localStorage.setItem(`mn-ml-cols-${ml.view}`, JSON.stringify(ml.cols[ml.view])); } catch (_) {}
    renderTable();
  }

  function resetCols() {
    ml.cols[ml.view] = defaultCols(ml.view);
    try { localStorage.removeItem(`mn-ml-cols-${ml.view}`); } catch (_) {}
    rerender();
  }

  function rowClick(e, key) {
    // The row is a mouse convenience; its first-cell button is the keyboard
    // path. Clicks on controls inside the row are theirs, not the row's.
    const t = e && e.target;
    if (t && t.closest && t.closest('button, input, a, select, pre')) return;
    toggleRow(key);
  }

  function toggleRow(key) {
    ml.openKey = ml.openKey === key ? null : key;
    renderTable();
  }

  function pickClick(e) { if (e && e.stopPropagation) e.stopPropagation(); }

  function setSel(key, on) {
    if (on) ml.sel.add(key); else ml.sel.delete(key);
    const row = document.getElementById(`ml-row-${cssKey(key)}`);
    if (row) row.classList.toggle('ml-row--sel', !!on);
    renderNote();
    refreshTray();
  }

  function selAll(on) {
    ml.sel = on ? new Set((ml.rows || []).map(rowKey)) : new Set();
    renderTable();
    renderNote();
    refreshTray();
  }

  function clearSel() {
    ml.sel = new Set();
    renderTable();
    renderNote();
    refreshTray();
  }

  function trayToggle(el) {
    ml.trayOpen = !!(el && el.open);
    if (ml.trayOpen) {
      buildTrayMap();
      drawPlot();
      refreshTray();
    } else {
      stopTrayMap();
    }
  }

  async function fetchRaw(key) {
    const r = byKey(key);
    if (!r || r.raw_id == null) return;
    try {
      const rows = await dbSelect(
        `reading_raw?id=eq.${r.raw_id}&select=id,received_at,frame,payload,accepted,duplicates,rejected,submitted_by`);
      ml.raw.set(r.raw_id, rows.length ? rows[0] : 'gone');
    } catch (err) {
      ml.raw.set(r.raw_id, err && err.status === 404 ? 'denied' : 'gone');
      if (err && err.status !== 404 && err.status !== 401 && err.status !== 403) {
        ml.raw.delete(r.raw_id);   // a network hiccup is retryable; a refusal is not
      }
    }
    renderTable();
  }

  // ── the three doors out ────────────────────────────────────────────────────

  function showStation(id) {
    state.selectedId = id;
    switchTab('stations');
  }

  function openInField(key) {
    const r = byKey(key);
    if (!r) return;
    const t = Date.parse(r.reading_ts);
    switchTab('field');
    if (typeof ArroData !== 'undefined' && ArroData.fieldShow) ArroData.fieldShow(r.addr, t);
  }

  function openInPackets(key) {
    const r = byKey(key);
    if (!r || r.alert_id == null) return;
    switchTab('packets');
    if (typeof Packets !== 'undefined' && Packets.prefillEncoder) {
      Packets.prefillEncoder('eif', r.alert_id, Number(r.value_raw));
    }
  }

  function openInAlert2(key) {
    const r = byKey(key);
    if (!r || r.raw_id == null) return;
    const got = ml.raw.get(r.raw_id);
    if (!got || typeof got !== 'object' || !got.frame) return;
    state.a2.text = got.frame;
    state.a2.source = `message log · raw #${r.raw_id}`;
    state.a2.parsed = null;
    state.a2.parsedKey = '';
    switchTab('alert2');
  }

  // The entrance from the Field Data inspector: one address, one moment.
  // Filters to the address, a two-hour window around the reading, reading
  // order — and opens the row itself when it arrives.
  function showReading(addr, tsMs) {
    const a = String(addr || '');
    ml.q.find = a.startsWith('a:') ? a.slice(2) : a.startsWith('s:') ? a.slice(2).split('/')[0] : a;
    const iso = t => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    ml.q.win = 'custom';
    ml.q.from = iso(tsMs - 3600000);
    ml.q.to   = iso(tsMs + 3600000);
    ml.q.order = 'reading.asc';
    ml.focusKey = null;
    switchTab('msglog');
    // The row's exact key is unknowable here (value_raw is part of it), so the
    // first row at that instant is the one opened.
    const seq = ml.seq + 1;   // the run() below will take this id
    run().then(() => {
      if (ml.seq !== seq || !ml.rows) return;
      const hit = ml.rows.find(r => Math.abs(Date.parse(r.reading_ts) - tsMs) < 1000);
      if (hit) {
        ml.openKey = rowKey(hit);
        ml.sel.add(ml.openKey);
        renderTable();
        refreshTray();
        const el = document.getElementById(`ml-row-${cssKey(ml.openKey)}`);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      }
    });
  }

  // ── export ─────────────────────────────────────────────────────────────────
  // Every fetched row and every column, whatever the views are hiding — the
  // narrow view is a reading aid, not a statement about the record.

  function exportCsv() {
    const rows = ml.rows || [];
    if (!rows.length) return;
    const head = ['reading_ts', 'received_at', 'addr', 'alert_id', 'station_number', 'channel',
                  'station', 'station_id', 'value_raw', 'value', 'unit', 'conversion',
                  'quality', 'protocol', 'source', 'path', 'dup_count', 'dup_paths', 'raw_id'];
    const lines = [head.join(',')];
    for (const r of rows) {
      const res = rowStation(r);
      lines.push([
        csvEscape(r.reading_ts), csvEscape(r.received_at), csvEscape(r.addr),
        r.alert_id ?? '', csvEscape(r.station_number || ''), csvEscape(r.channel || ''),
        csvEscape(res.st ? res.st.name : ''), csvEscape(r.station_id || res.st?.id || ''),
        r.value_raw ?? '', r.value ?? '', csvEscape(r.unit || ''), csvEscape(r.conversion || ''),
        csvEscape(vocabKey('quality', r.quality)), csvEscape(vocabKey('protocol', r.protocol)),
        csvEscape(vocabKey('source', r.source)), csvEscape(r.path || ''),
        r.dup_count ?? 0, csvEscape((r.dup_paths || []).join(' | ')), r.raw_id ?? '',
      ].join(','));
    }
    dlText(`meganet-message-log-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
    announce(`Downloaded ${rows.length.toLocaleString()} messages as CSV.`);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function rerender() {
    const el = document.getElementById('main-content');
    if (el && state.activeTab === 'msglog') {
      el.innerHTML = render();
      init();
    }
  }

  function stop() {
    disarmFollow();
    stopTrayMap();
  }

  function init() {
    // Safe to repeat — init() runs on every render of the tab, and the
    // registry replaces rather than stacks (#142).
    registerTabTeardown('MessageLog', stop);
    fetchVocab().then(() => {
      // Codes on screen before the vocabulary landed read as bare numbers;
      // one repaint turns them into words. Nothing else moves.
      if (state.activeTab === 'msglog' && ml.rows) renderTable();
    });
    if (ml.trayOpen) { buildTrayMap(); drawPlot(); refreshTray(); }
    if (ml.follow) armFollow();
    // The first visit fetches on its own — the tab's whole point is what has
    // just arrived, and an empty page asking to be asked is a step nobody
    // needs. After that the rows on screen stand until asked again.
    if (!ml.rows && !ml.loading) run();
  }

  // A seed door for the test harness and for working the tab offline: rows in
  // exactly the shape meganet.reading returns them. Documented as a boundary
  // the way seriesData/adoptSeries are on the ARRO module — a table the tests
  // can fill is a table the app can fill.
  function adoptRows(rows) {
    ml.rows = Array.isArray(rows) ? rows : [];
    ml.loading = false;
    ml.error = '';
    ml.at = ml.at || 0;
    renderNote();
    renderTable();
    refreshTray();
  }

  return {
    render, init, stop, run,
    setWin, setDate, setFind, findKey, setCode, setText, setFlag, setOrder, loadMore,
    setFollow, setView, setCol, resetCols,
    rowClick, toggleRow, pickClick, setSel, selAll, clearSel, trayToggle,
    fetchRaw, showStation, openInField, openInPackets, openInAlert2, showReading,
    exportCsv, adoptRows,
  };
})();
if (typeof window !== 'undefined') window.MessageLog = MessageLog;
