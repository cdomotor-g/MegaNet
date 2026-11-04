// MegaNet — sort-benchmarks.js
//
//   SortBenchmarks   the Bureau's benchmarks handed back to SoRT's scope
//                    builder (the Atlas calls it `benchmarks-for-sort`): SoRT
//                    opens Flood-Net at #benchmarks-for-sort=<request>, a
//                    signed-in editor sees exactly what would go, and Send to
//                    SoRT posts the station's marks to the SoRT tab that asked
//                    and nowhere else. The reverse of SoRT's #tasks= hand-off
//                    (tasks.js), and built on its pattern.
//
// After core.js (esc, escAttr, termHtml, announce, state), datastore.js
// (dbSelect, dbCanWrite), auth.js (Auth), toast.js and station-benchmarks.js
// (its WORDS) — all read at call time. Nothing here runs at load: init.js
// calls restoreFromUrl() once after the first render, app.js's
// renderAfterLoad() calls afterLoad() when the station list lands, and
// auth.js calls authChanged() on every sign-in and sign-out.
//
// ── Why not the agent API ────────────────────────────────────────────────────
// A benchmark's description says where the mark is, to the tree and the gate
// post, and meganet.station_benchmark is editors only (0101: RLS through
// meganet.is_editor()) — not for the open internet. So it is not in the public
// API (worker/api.js stays read-only and public-only, untouched by this). This
// is how one station's marks reach SoRT instead: read with an editor's own
// session, shown to them, and sent at their press to the one tab that asked.
//
// ── The contract (fixed with SoRT's side: change both, or neither) ──────────
// SoRT calls window.open('https://floodwarning.net/#benchmarks-for-sort=<payload>',
// 'floodnet-sort-bridge'), keeping the opener. <payload> is base64url, no
// padding, of UTF-8 JSON:
//
//   {"v":1,"source":"sort","nonce":"<[A-Za-z0-9_-]{8,64}>",
//    "station":{"id":"flinton","number":"42053","name":"Flinton"}}
//
// It is somebody else's words arriving in an address, so it is read as
// untrusted (parse): at most MAX_RAW characters, v 1 (a higher one is a newer
// SoRT, and says so), source "sort", the nonce's pattern, unknown keys
// ignored, the station's id and number checked and its name cut to a line.
// The station is the station list's by its id, else by its bureau number with
// the leading zeros and spaces aside — meganet.bureau_key()'s rule, which is
// how station_benchmark puts a mark on a station. One Flood-Net does not have
// is said, and there is nothing to send.
//
// The fragment leaves the address bar as soon as it is read; the request waits
// in this tab's sessionStorage (KEY) until it is sent, copied or dismissed, so
// signing in — with Google, a trip away and back — does not lose it.
//
// Only a signed-in editor (whoami()'s may_write, and the database's own RLS
// behind it) is shown the marks, and Send to SoRT, from them only, builds
//
//   {"type":"floodnet:benchmarks","v":1,"nonce":"<the request's>",
//    "station":{"id":"flinton","number":"42053","name":"Flinton"},
//    "printed_on":"2026-10-15"|null,
//    "benchmarks":[{"ord":0,"level_m":12.345,"datum":"AHD"|"STATE"|"ASSUM"|"UNKNOWN",
//                   "on_gauge_m":1.234|null,"gauge_zero_m":11.111|null,"gauge_datum":"AHD"|null,
//                   "description":"…"|null,"comment":"…"|null}, …]}
//
// — Flood-Net's station (the one it found), the marks in ord order, numbers as
// numbers, none listed an empty list so that SoRT can say so — and posts it
// with window.opener.postMessage(msg, SORT_ORIGIN) when the opener is there
// and not closed: that one origin, a constant, never '*' and never anything
// the request said. A browser delivers it only if the opener is still a page
// of that origin. Without an opener (closed, or cut by the sign-in's trip) it
// says the SoRT tab cannot be reached from here and offers Copy for SoRT: the
// text `floodnet-benchmarks:` + base64url of the same JSON, for SoRT's Paste
// from Flood-Net box.
//
// SORT_ORIGIN is the whole of https://cdomotor-g.github.io — every one of the
// owner's GitHub Pages sites shares it, and a browser cannot narrow a message
// to a path. That is the trust: the owner's own pages, at an editor's press.
//
// test/sort-benchmarks.mjs (npm run sortbenchmarks) holds this to the contract.

const SortBenchmarks = (function () {

  const FRAG = /^#benchmarks-for-sort=(.*)$/;
  const KEY = 'mn-sort-benchmarks';
  const SORT_ORIGIN = 'https://cdomotor-g.github.io';
  const MSG_TYPE = 'floodnet:benchmarks';
  const COPY_PREFIX = 'floodnet-benchmarks:';
  const MAX_RAW = 4096;                // characters of request read at all
  const COLS = 'ord,level_m,datum,description,comment,gauge_zero_m,gauge_datum,on_gauge_m,printed_on';
  const DATUMS = ['AHD', 'STATE', 'ASSUM', 'UNKNOWN'];
  const DATUM_SAY = { AHD: 'AHD', STATE: 'State datum', ASSUM: 'assumed datum', UNKNOWN: 'datum unknown' };

  // ── The words this card uses ──────────────────────────────────────────────
  // One list, for the hover and for the fold that says them without one. The
  // benchmark, the datums and "on the gauge" mean what they mean on the
  // station card, so they are read from station-benchmarks.js's list.
  const WORDS = {
    sort: 'SoRT\'s scope builder (cdomotor-g.github.io/SoRT): the page a SoRT Forum fills in for a station\'s remediation scope, whose tables are pasted into Word. It opened this tab to ask for the benchmarks.',
    editor: 'A Flood-Net account on the editors\' list — the people who change stations, inspections and surveys. Only editors can read the Bureau\'s benchmarks, because their descriptions say exactly where each mark is.',
    report: 'HDB is the Bureau\'s hydrological database. The marks here are from its report "Benchmark Details" for the Queensland river height stations, printed from HDB on the date shown.',
    gaugeZero: 'The level of the gauge\'s zero in force at this station, from its gauge surveys: the one with no end date, else the one that ended last. A mark\'s height on the gauge is its level less this.',
  };
  const GLOSSARY = [['sort', 'SoRT\'s scope builder'], ['editor', 'Editor'], ['benchmark', 'Benchmark'],
    ['report', 'HDB and its report'], ['AHD', 'AHD'], ['STATE', 'State datum'], ['ASSUM', 'Assumed datum'],
    ['UNKNOWN', 'Datum unknown'], ['gaugeZero', 'Gauge zero'], ['onGauge', 'On the gauge']];
  function word(k) {
    if (WORDS[k]) return WORDS[k];
    const shared = typeof StationBenchmarks !== 'undefined' && StationBenchmarks.WORDS;
    return (shared && shared[k]) || '';
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let req = null;          // parse()'s data: { raw, nonce, station: { id, number, name } }
  let why = '';            // a request that could not be read, in words
  let got = null;          // the editor's read: { key, loading } | { key, rows, extract } | { key, error, missing }
  let phase = 'review';    // 'review' | 'sent' | 'unreachable' | 'copied' | 'copyFailed'
  let msg = null;          // what Send built: kept to copy, after a send or without an opener
  let copiedToo = false;   // copied as well, after a send
  let closeNote = '';      // the browser kept the tab open
  let listening = false;

  // ── Who may see them (the database decides; this decides what to offer) ────
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  // whoami() has answered, so may_write is the database's word and not a guess.
  const known = () => signedIn() && !!(Auth.known && Auth.known());
  const editor = () => known() && !!(Auth.mayWrite && Auth.mayWrite())
    && typeof dbCanWrite === 'function' && dbCanWrite();

  // ── Small things ───────────────────────────────────────────────────────────

  // One line of somebody else's text: control characters out, spaces closed
  // up, at most `max` characters (tasks.js's rule).
  function line(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function b64urlText(raw) {
    let s = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  function b64url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // A bureau number with its leading zeros and spaces gone — meganet.bureau_key()
  // (0028) and sls.js's key(), the same rule.
  function bureauKey(n) {
    const t = String(n == null ? '' : n).trim().replace(/^0+/, '');
    return t || null;
  }
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  function dmy(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }
  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function words(v) { return typeof v === 'string' && v.trim() ? v : null; }
  // A level as it will be sent: every figure it has, and at least centimetres.
  function metres(n) {
    if (n == null) return '';
    const s = String(n);
    return (s.split('.')[1] || '').length >= 2 ? s : n.toFixed(2);
  }
  const stations = () => (state.data && Array.isArray(state.data.stations) ? state.data.stations : []);
  const listFailed = () => !state.data && !!(state.load && !state.load.busy);

  // ── The request, read as untrusted ─────────────────────────────────────────

  // { ok: false, why } or { ok: true, data }. Pure — the check holds it to the
  // contract.
  function parse(raw) {
    const no = w => ({ ok: false, why: w });
    if (typeof raw !== 'string' || !raw) return no('The link from SoRT carried no request.');
    if (raw.length > MAX_RAW) return no('The link is too long to be a request from SoRT for benchmarks.');
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return no('The request could not be read: it is not a link from SoRT.');
    let o;
    try { o = JSON.parse(b64urlText(raw)); } catch (_) {
      return no('The request could not be read — the link may have been cut short. Ask for the benchmarks again from SoRT.');
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return no('The request could not be read: it is not a link from SoRT.');
    if (o.v !== 1) {
      return no(typeof o.v === 'number' && o.v > 1
        ? `This request is from a newer SoRT (version ${Math.floor(o.v)}) than Flood-Net reads yet. Flood-Net needs bringing up to date before it can answer it.`
        : 'The request could not be read: it is not one Flood-Net knows.');
    }
    if (o.source !== 'sort') return no('The request could not be read: it does not say it is from SoRT.');
    if (typeof o.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(o.nonce)) {
      return no('The request could not be read: it carries no reference for SoRT to know the answer by.');
    }
    const st = o.station && typeof o.station === 'object' && !Array.isArray(o.station) ? o.station : {};
    const n = typeof st.number === 'number' && Number.isInteger(st.number) && st.number >= 0 ? String(st.number)
      : typeof st.number === 'string' ? st.number.trim() : '';
    const station = {
      id: typeof st.id === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(st.id) ? st.id : '',
      number: /^[A-Za-z0-9-]{1,20}$/.test(n) ? n : '',
      name: line(st.name, 120),
    };
    if (!station.id && !station.number && !station.name) return no('The request does not say which station it is for.');
    return { ok: true, data: { raw, nonce: o.nonce, station } };
  }

  // The station list's station the request names: by its id, else by its
  // bureau number — or null.
  function findStation(want, list) {
    const all = Array.isArray(list) ? list : stations();
    if (!want) return null;
    if (want.id) {
      const s = all.find(x => x.id === want.id);
      if (s) return s;
    }
    const k = bureauKey(want.number);
    return (k && all.find(x => bureauKey(x.station_number) === k)) || null;
  }

  // ── What goes to SoRT ──────────────────────────────────────────────────────

  // The message, from the station found and the rows read. Pure.
  function message(nonce, s, rows, printedOn) {
    const list = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => Number(a.ord) - Number(b.ord));
    return {
      type: MSG_TYPE,
      v: 1,
      nonce,
      station: { id: s.id, number: s.station_number == null ? '' : String(s.station_number), name: s.name || '' },
      printed_on: validDate(printedOn) ? printedOn : null,
      benchmarks: list.map(b => ({
        ord: Number(b.ord),
        level_m: num(b.level_m),
        datum: DATUMS.includes(b.datum) ? b.datum : 'UNKNOWN',
        on_gauge_m: num(b.on_gauge_m),
        gauge_zero_m: num(b.gauge_zero_m),
        gauge_datum: typeof b.gauge_datum === 'string' && b.gauge_datum ? b.gauge_datum : null,
        description: words(b.description),
        comment: words(b.comment),
      })),
    };
  }
  // The same, as the text Copy for SoRT puts on the clipboard.
  function copyText(m) { return COPY_PREFIX + b64url(JSON.stringify(m)); }

  // The report's printed date: the report's own row, else the marks'.
  function printedOn() {
    if (!got) return null;
    const e = got.extract && got.extract.printed_on;
    if (validDate(e)) return e;
    const r = (got.rows || [])[0];
    return r && validDate(r.printed_on) ? r.printed_on : null;
  }
  // Read, and readable: the report is there for this account (its one row is
  // editors only too), so none listed means HDB lists none — not "may not see".
  const readable = () => !!(got && got.rows && (got.extract || got.rows.length));

  // ── Reading the marks (an editor's session only) ───────────────────────────

  function errText(err) {
    if (err && (err.status === 0 || err.timeout || /Failed to fetch|NetworkError|Load failed/i.test(err.message || ''))) {
      return 'Could not reach the database. Check the connection and try again.';
    }
    return `Could not read the benchmarks — ${(err && err.message) || err}.`;
  }

  async function load(force) {
    if (!req || phase !== 'review' || !editor() || typeof dbSelect !== 'function') return;
    const s = findStation(req.station);
    if (!s) return;
    const who = typeof Auth !== 'undefined' && Auth.email ? Auth.email() || '' : '';
    const key = `${req.nonce}|${s.id}|${who}`;
    if (!force && got && got.key === key) return;
    const mine = got = { key, loading: true };
    paint();
    try {
      const [rows, extract] = await Promise.all([
        dbSelect(`station_benchmark?select=${COLS}&station_id=eq.${encodeURIComponent(s.id)}&order=ord.asc`),
        dbSelect('benchmark_extract?select=printed_on'),
      ]);
      if (got !== mine) return;
      got = { key, rows: Array.isArray(rows) ? rows : [], extract: (extract && extract[0]) || null };
    } catch (err) {
      if (got !== mine) return;
      got = { key, error: errText(err), missing: !!(err && err.status === 404) };
    }
    paint();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function stationLabel(s) {
    if (s) return `${s.name}${s.station_number ? ` (${s.station_number})` : ''}`;
    const w = req.station;
    return `${w.name || w.id || w.number || 'a station'}${w.number && (w.name || w.id) ? ` (${w.number})` : ''}`;
  }
  const btn = (id, cls, call, label) => `<button type="button" id="${id}"${cls ? ` class="${cls}"` : ''} onclick="SortBenchmarks.${call}()">${label}</button>`;
  const group = (...b) => `<div class="button-group">${b.join('')}</div>`;
  const dismissBtn = (label = 'Dismiss') => btn('sbr-dismiss', 'ghost', 'dismiss', label);

  function markHtml(b) {
    const on = b.on_gauge_m == null ? ''
      : ` · ${termHtml('on the gauge', word('onGauge'))} <strong>${esc(metres(b.on_gauge_m))} m</strong>`;
    return `<li class="sbr-mark"><div><strong>${esc(metres(b.level_m))} m</strong> ${termHtml(DATUM_SAY[b.datum], word(b.datum))}${on}</div>`
      + `<div class="small">${b.description ? esc(b.description) : '<span class="txt-muted">No description.</span>'}</div>`
      + `${b.comment ? `<div class="small txt-muted">${esc(b.comment)}</div>` : ''}</li>`;
  }

  function reviewHtml(s) {
    const m = message(req.nonce, s, got.rows, printedOn());
    const printed = m.printed_on ? ` printed ${esc(dmy(m.printed_on))}` : '';
    const report = termHtml('Benchmark Details', word('report'));
    const n = m.benchmarks.length;
    const first = m.benchmarks[0];
    const zero = !first ? ''
      : first.gauge_zero_m == null ? `<p class="small txt-muted">No ${termHtml('gauge zero', word('gaugeZero'))} is on record here, so no mark is put on the gauge.</p>`
      : `<p class="small">${termHtml('Gauge zero', word('gaugeZero'))} in force: <strong>${esc(metres(first.gauge_zero_m))} m</strong>${first.gauge_datum ? ` ${termHtml(DATUM_SAY[first.gauge_datum] || first.gauge_datum, word(first.gauge_datum))}` : ''}.</p>`;
    const list = n
      ? `<p class="small">HDB's ${report} report${printed} lists ${n === 1 ? 'this mark' : `these ${n} marks`} here — exactly what will be sent:</p>
         <ol class="sbr-marks">${m.benchmarks.map(markHtml).join('')}</ol>${zero}`
      : `<p class="small"><strong>HDB lists no benchmarks for this station</strong> — its ${report} report${printed} has none for it. Send tells SoRT so.</p>`;
    return `${list}
      <p class="small"><em>Send to SoRT</em> puts ${n ? 'them' : 'that'} in the SoRT tab that asked — and nowhere else — for its
        scope and its Word tables. Nothing in Flood-Net changes.</p>
      ${group(btn('sbr-send', 'primary', 'send', 'Send to SoRT'), dismissBtn())}`;
  }

  function bodyHtml(s) {
    if (!state.data) {
      return listFailed()
        ? `<p class="small txt-bad">Flood-Net's station list has not loaded, so it cannot find the station. Reload the page to try again.</p>${group(dismissBtn())}`
        : `<p class="small" role="status">Finding it in Flood-Net's station list…</p>${group(dismissBtn())}`;
    }
    if (!s) {
      const w = req.station;
      const how = w.id || w.number
        ? 'Flood-Net looked for it by the station id and the bureau number SoRT sent, and has neither.'
        : 'SoRT sent only its name, which Flood-Net does not look a station up by.';
      return `<p class="small"><strong>${esc(stationLabel(null))} isn't in Flood-Net's station list</strong>, so Flood-Net has no
          benchmarks to send for it. ${how} Check the station in SoRT.</p>${group(dismissBtn())}`;
    }
    const k = bureauKey(req.station.number);
    const clash = req.station.id === s.id && k && k !== bureauKey(s.station_number)
      ? `<p class="small txt-warn">SoRT gave the bureau number ${esc(req.station.number)}, but Flood-Net's ${esc(s.name)} is
          ${s.station_number ? esc(s.station_number) : 'without one'}. Check it is the station you meant.</p>` : '';
    if (phase === 'sent') {
      const n = msg ? msg.benchmarks.length : 0;
      return `<p class="small" role="status"><strong>Sent to the SoRT tab that asked</strong> — ${n} benchmark${n === 1 ? '' : 's'} for
          ${esc(stationLabel(s))}. Go back to it: this tab has done its job.</p>
        ${closeNote ? `<p class="small txt-muted">${esc(closeNote)}</p>` : ''}
        ${msg ? `<p class="small txt-muted">SoRT not showing them? ${copiedToo ? 'Copied — paste them into its <em>Paste from Flood-Net</em> box.'
          : '<button type="button" class="link-btn" id="sbr-copy" onclick="SortBenchmarks.copy()">Copy for SoRT</button> and paste them into its <em>Paste from Flood-Net</em> box.'}</p>` : ''}
        ${group(btn('sbr-close', 'primary', 'closeTab', 'Close this tab'), dismissBtn('Done'))}`;
    }
    if (phase === 'copied') {
      return `<p class="small" role="status"><strong>Copied for SoRT.</strong> In the SoRT scope builder, open <em>Paste from Flood-Net</em>
          and paste. They go nowhere else.</p>
        ${closeNote ? `<p class="small txt-muted">${esc(closeNote)}</p>` : ''}
        ${group(btn('sbr-close', 'primary', 'closeTab', 'Close this tab'), dismissBtn('Done'))}`;
    }
    if (phase === 'copyFailed' && msg) {
      return `<p class="small"><strong>The browser would not copy.</strong> Select all of the text below, copy it, and paste it into
          SoRT's <em>Paste from Flood-Net</em> box.</p>
        <label class="small" for="sbr-copybox">For SoRT</label>
        <textarea id="sbr-copybox" class="sbr-copybox" readonly rows="4" onfocus="this.select()">${esc(copyText(msg))}</textarea>
        ${group(btn('sbr-copy', 'primary', 'copy', 'Copy for SoRT'), dismissBtn('Done'))}`;
    }
    if (phase === 'unreachable' && msg) {
      return `<p class="small"><strong>The SoRT tab that asked can't be reached from here</strong> — it may have been closed, or
          signing in in this tab cut the link between the two. Copy the benchmarks instead, and paste them into SoRT's
          <em>Paste from Flood-Net</em> box.</p>
        ${group(btn('sbr-copy', 'primary', 'copy', 'Copy for SoRT'), dismissBtn())}`;
    }
    if (!signedIn()) {
      return `<p class="small">The Bureau's benchmarks are for Flood-Net ${termHtml('editors', word('editor'))} only. Sign in with an
          editor's account — this request is still here when you are back.</p>
        ${group(btn('sbr-signin', 'primary', 'signIn', '🔑 Sign in'), dismissBtn())}`;
    }
    if (!known()) {
      return `<p class="small" role="status">Finding out what your account may see… If this stays, reload the page.</p>${group(dismissBtn())}`;
    }
    if (!editor()) {
      return `<p class="small"><strong>Only Flood-Net ${termHtml('editors', word('editor'))} can see the Bureau's benchmarks</strong>,
          and your account isn't one, so there is nothing to send. Ask an editor to fetch them from SoRT.</p>${group(dismissBtn())}`;
    }
    if (!got || got.loading) return `${clash}<p class="small" role="status">Reading the station's benchmarks…</p>${group(dismissBtn())}`;
    if (got.error && got.missing) {
      return `<p class="small">Flood-Net's database does not hold the Bureau's benchmarks yet, so there is nothing to send.</p>${group(dismissBtn())}`;
    }
    if (got.error) return `<p class="small txt-bad" role="alert">${esc(got.error)}</p>${group(btn('sbr-retry', 'primary', 'retry', 'Try again'), dismissBtn())}`;
    if (!readable()) {
      return `<p class="small">Flood-Net does not hold the Bureau's benchmark report yet — or your account cannot read it — so it
          cannot say what HDB lists here. Nothing is sent.</p>${group(dismissBtn())}`;
    }
    return clash + reviewHtml(s);
  }

  function foldHtml() {
    return `<details class="sbr-words"><summary class="small">What the words here mean</summary>
        <dl class="small">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(word(k))}</dd>`).join('')}</dl></details>`;
  }

  function html() {
    const head = '<h2 id="sbr-h" class="sbr-h" tabindex="-1">📏 Benchmarks for SoRT</h2>';
    if (!req) return `${head}<p class="small" role="alert">${esc(why)}</p>${group(dismissBtn())}`;
    const s = state.data ? findStation(req.station) : null;
    return `${head}
      <p class="small">${termHtml('SoRT\'s scope builder', word('sort'))} asks for the Bureau's ${termHtml('benchmarks', word('benchmark'))}
        at <strong>${esc(stationLabel(s))}</strong>.</p>
      ${bodyHtml(s)}
      ${foldHtml()}`;
  }

  // The card: over whatever tab is open, outside #main-content so that no
  // tab's render takes it away. Focus goes to it when it first appears, and
  // back to the control it was on after a repaint.
  function paint(focusId) {
    if (typeof document === 'undefined' || !document.body) return;
    let el = document.getElementById('sort-bridge');
    if (!req && !why) {
      if (el) {
        const had = el.contains(document.activeElement);
        el.remove();
        if (had) document.getElementById('main-content')?.focus({ preventScroll: true });
      }
      document.body.classList.remove('has-sort-bridge');
      return;
    }
    const fresh = !el;
    if (fresh) {
      el = document.createElement('section');
      el.id = 'sort-bridge';
      el.className = 'sort-bridge';
      el.setAttribute('aria-labelledby', 'sbr-h');
      document.body.appendChild(el);
    }
    const active = document.activeElement;
    const inside = el.contains(active);
    const had = focusId || (inside && active.id ? active.id : null);
    el.innerHTML = html();
    document.body.classList.add('has-sort-bridge');
    let to = had ? document.getElementById(had) : null;
    if (!to && (fresh || inside)) to = document.getElementById('sbr-h');
    if (to && !to.disabled) to.focus({ preventScroll: true });
  }

  // ── Coming and going ───────────────────────────────────────────────────────

  function keep(raw) { try { sessionStorage.setItem(KEY, raw); } catch (_) { /* this page only, then */ } }
  function forget() { try { sessionStorage.removeItem(KEY); } catch (_) { /* nothing kept */ } }

  function start(data) {
    req = data; why = ''; got = null; phase = 'review'; msg = null; copiedToo = false; closeNote = '';
    keep(data.raw);
  }

  // init.js, once, after the first render: a #benchmarks-for-sort=… address
  // read and taken out of the address bar at once — or one kept from earlier
  // in this browser tab (a reload, or a sign-in that went to Google and back)
  // put back. And the same for one SoRT sends to this tab while it is open:
  // window.open() to the same name changes only the fragment.
  function restoreFromUrl() {
    if (typeof window === 'undefined') return;
    if (!listening) {
      listening = true;
      window.addEventListener('hashchange', () => { if (FRAG.test(location.hash || '')) restoreFromUrl(); });
    }
    const m = FRAG.exec(location.hash || '');
    let raw = null;
    if (m) {
      raw = m[1];
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) {}
    } else {
      try { raw = sessionStorage.getItem(KEY); } catch (_) { raw = null; }
      if (!raw) return;
    }
    const read = parse(raw);
    if (read.ok) start(read.data);
    else {
      req = null; got = null; msg = null; phase = 'review';
      why = m ? read.why : '';
      forget();
    }
    paint();
    if (req) {
      announce(`SoRT's scope builder asks for the Bureau's benchmarks at ${stationLabel(state.data ? findStation(req.station) : null)}.`);
      load();
    }
  }

  // app.js's renderAfterLoad(): the station list is in, so the station can be
  // found — or a newer list has it.
  function afterLoad() {
    if (!req) return;
    paint();
    load();
  }

  // auth.js, on every sign-in and sign-out: what was read was the last
  // session's, and so is anything built from it.
  function authChanged() {
    if (!req) return;
    got = null;
    msg = null;
    copiedToo = false;
    if (phase !== 'sent' && phase !== 'copied') phase = 'review';
    paint();
    load();
  }

  function send() {
    if (!req || phase !== 'review' || !editor() || !got || !got.rows || !readable()) return;
    const s = findStation(req.station);
    if (!s) return;
    msg = message(req.nonce, s, got.rows, printedOn());
    let target = null, open = false;
    try { target = window.opener; open = !!target && target !== window && !target.closed; } catch (_) { open = false; }
    if (open) {
      try { target.postMessage(msg, SORT_ORIGIN); } catch (_) { open = false; }
    }
    if (!open) {
      phase = 'unreachable';
      announce('The SoRT tab that asked cannot be reached from here. Copy for SoRT instead.');
      paint('sbr-copy');
      return;
    }
    phase = 'sent';
    forget();
    announce(`Sent ${msg.benchmarks.length} benchmark${msg.benchmarks.length === 1 ? '' : 's'} to the SoRT tab that asked.`);
    paint('sbr-close');
  }

  async function copy() {
    if (!req || !msg || !editor()) return;
    const text = copyText(msg);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { ok = false; }
    if (!req || !msg) return;
    if (ok) {
      if (phase === 'sent') copiedToo = true;
      else phase = 'copied';
      forget();
      announce('Copied for SoRT. Paste it into its Paste from Flood-Net box.');
      if (typeof Toast !== 'undefined') Toast.show('Copied for SoRT.', { kind: 'ok' });
      paint(phase === 'copied' ? 'sbr-close' : 'sbr-dismiss');
    } else if (phase === 'sent') {
      announce('The browser would not copy.');
      if (typeof Toast !== 'undefined') Toast.show('The browser would not copy.', { kind: 'note' });
    } else {
      phase = 'copyFailed';
      paint('sbr-copybox');
    }
  }

  function dismiss() {
    req = null; why = ''; got = null; msg = null; phase = 'review'; copiedToo = false; closeNote = '';
    forget();
    paint();
  }

  // A tab a script opened, a script may close; a browser that keeps it open
  // anyway (it has been elsewhere since, say) is said so.
  function closeTab() {
    try { window.close(); } catch (_) { /* said below */ }
    setTimeout(() => {
      if (window.closed) return;
      closeNote = 'The browser kept this tab open — close it from the tab bar.';
      paint('sbr-dismiss');
    }, 400);
  }

  return {
    restoreFromUrl, afterLoad, authChanged, send, copy, dismiss, closeTab,
    signIn() { if (typeof Auth !== 'undefined') Auth.open({ mode: 'signin' }); },
    retry() { load(true); },
    // Pure, for the check.
    parse, findStation, message, copyText, bureauKey,
    SORT_ORIGIN, MSG_TYPE, COPY_PREFIX, MAX_RAW, KEY, WORDS,
    _state: () => ({ req: req ? { nonce: req.nonce, station: { ...req.station } } : null, why, phase,
                     got: got ? { loading: !!got.loading, rows: got.rows ? got.rows.length : null, error: got.error || '' } : null,
                     msg }),
  };
})();
if (typeof window !== 'undefined') window.SortBenchmarks = SortBenchmarks;
