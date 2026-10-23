// MegaNet — health-glance.js
//
//   HealthGlance   a station's health where people already look (#218): three
//                  lines on its card on the Stations map — when it was last
//                  heard, where its battery is going, and what is wrong with
//                  it — each a door into the Station Health tab with the
//                  station picked; *Colour pins by health* in 🗺️ Map
//                  display, every pin OK, watch, fault or no data; and the
//                  station list's **Last heard** column, how long since
//                  Flood-Net heard each row's station — and the same again,
//                  stamped, in the station editor's header. And its checks
//                  slot by slot, the Station Health tab's strip drawn from its
//                  card's own readings, on the card and in the editor.
//
// After core.js (state, esc, escAttr, announce, stationSensors), app.js
// (stationAlertIds, refreshMapLayers, rerenderMapLegend, toggleMapFullscreen,
// the MAP_PIN_* constants), datastore.js (dbSelect), health-analysis.js
// (HealthAnalysis — the Station Health tab's own rules) and health.js
// (Health, which it opens); before init.js. All of it at call time, so its
// place among the modules is free (`npm run toplevel`). Nothing runs at load:
// app.js's stnCardHtml() places the section and repaintStnCard() calls ask();
// refreshMapLayers() calls reset() once per rebuild and pinStyle() per pin;
// mapDisplayControlsHtml() and mapLegendHtml() draw the switch's note and its
// key; stationsTable() asks for the batch (askNet), heardCellHtml() is each of
// its Last heard cells, and onHeard() is what repaints them in place;
// editorForm() (station-editor.js) places heardHeadHtml() in its header and
// checksHtml() under Telemetry. The strip is drawn by Health.slotStrip.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The Station Health tab ranks silent stations, sliding batteries and the rest
// — on its own tab. The card a person actually opens, standing at a site or
// looking at a pin, said nothing about any of it: no last-heard time, no
// battery, no finding, no way into the tab. Somebody at a mast could not see
// from its card that it went quiet on Tuesday. Now the card says so, and the
// map can say it about every station at once.
//
// ── What it costs, and why it is bounded ────────────────────────────────────
// **One request a card.** The station's readings — its datastore-resolved
// rows and its own ALERT addresses, newest first, the newest 1,000 whatever
// their age — so "last heard" is answered even for a station gone quiet a
// month ago, by the same request that carries the week its battery and its
// findings are worked out from. A second, of one row, only for a station with
// no readings left at all (they age out after about two years): when the ingest
// last heard it, from station_health, so that "never" is only ever true. Kept
// per station for CARD_TTL: a repaint (a save, a filter keystroke, the trail)
// asks nothing new, and neither does coming back to the same pin inside five
// minutes.
//
// **One request a load for the pins** — meganet.station_health, every
// station's last-heard time, paged past PostgREST's 1,000 rows should the
// network outgrow one page, kept for NET_TTL and asked again only by a map
// rebuilt after that, or by ↻ in the switch's note. Never one per station:
// the Station Health tab's own way in is seventeen pages of readings, which
// is what a visit to the Stations map must not cost. The station list's Last
// heard column reads the same batch, so the Stations tab asks for it whether
// or not the pins' switch is on — still one request, once per NET_TTL, and the
// pins, 🏠 Home and the column share whichever of them asked first.
//
// **Worked out once per answer, not once per pin.** Each station's class is
// computed when an answer lands (rebuild()), into a Map; a marker rebuild —
// every filter keystroke rebuilds ~3,174 of them — is a lookup per pin.
//
// ── Where the answers come from — the one seam #215 changes ─────────────────
// Two questions, one function each, and nothing else in this file knows where
// an answer came from:
//
//   SOURCE.station(s)   one station, for its card: its readings through
//                       HealthAnalysis.run(), the Station Health tab's own
//                       rules, so the card and the tab cannot disagree about
//                       what a battery is doing or what counts as a corrupted
//                       copy.
//   SOURCE.network()    every station, for the pins: when each was last
//                       heard, and nothing about what it said.
//
// **Since #215** (0059) the server keeps what the Station Health tab's own
// rules find wrong now — HealthAnalysis.CURRENT_KINDS, worked out every
// fifteen minutes over every receiver's week, with whether the receivers that
// hear a station were listening — each opening and clearing. While its last
// run is fresh (within SERVER_FRESH), both questions take it from there:
// station() asks for the station's open findings beside its readings (the
// battery line still wants the readings, and the kinds the server does not
// keep are still worked out here); network() asks for every open finding in
// one request and hands back the worst severity per station beside its
// last-heard time, so a pin is coloured by everything the server found and
// not only by silence. And for a station heard within the server's week,
// silence is the server's verdict alone: quietFinding() and the assumed bars
// stand down, so the rule has one home (#215's own requirement). A station
// last heard before that week, or a server that has not looked lately, gets
// the rules here as before.
//
// ── The classes ─────────────────────────────────────────────────────────────
//   OK        heard within two of its checks, and nothing worse than a note
//   Watch     quiet for two of its checks or more — the Station Health tab's
//             own bar for "Silent" — or a warning finding
//   Fault     quiet for four of its checks or a day, whichever comes first —
//             the tab's bar for a critical silence — or a critical finding
//   No data   never heard by Flood-Net's receivers; heard too seldom to judge
//             — across less than two of its checks, so it has shown no rhythm
//             to be overdue on (the tab's "no schedule learned"); or the
//             datastore could not be asked. Never "OK" for want of an answer.
//
// The second of those is not a nicety. Of the 503 stations the live
// station_health held when this was written, 115 had been heard exactly once —
// a single frame, often weeks ago, from a station no receiver here normally
// hears — and a rule that called every quiet station a fault painted ninety of
// them red. How long a station has been heard comes from station_health's
// `since`, which on a row the HTTP ingest keeps (`online` null) never moves
// after the row is made, and from a card's own oldest reading.
//
// A check is the station's own learned period (HealthAnalysis's schedule)
// once its card has been opened; until then a check is taken as three hours —
// what most of the network the Raspberry Pi feed hears is set to — and a
// fault waits for a whole day, because an assumed period is not evidence
// enough to call four checks missed. Unlike the tab, this cannot say whether
// the receivers that hear a station were listening while it was quiet: the
// card says so, and the tab is one press away to weigh it.
//
// ── On the map, colour is never the only channel ─────────────────────────────
// Bigger is worse, as on the Station Health tab's own map, and the ring says
// it again: a watch pin a step bigger in a dashed black ring, a fault two
// steps bigger in a heavy one, no data hollow in a dotted grey ring. A
// filter's amber or cyan ring, and the selection's violet, still win the ring
// — they are what somebody is doing right now — and the size and the hollow
// carry the class through them. The ring is black because a dash pattern has
// to show against the tiles: a white one, like every other pin's, vanished
// into the topo base the map opens on.
//
// The fills are the light theme's status colours as literals, in both themes,
// for ROLE_COLOR's reason (design-system.md §1): a Leaflet path option cannot
// take var(), and the base maps do not go dark with the app, so a colour that
// works over a tile works over it in either theme. The key in the legend
// takes the tokens themselves, on the panel, the way the role key does.

const HealthGlance = (() => {

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;

  // A check, until a station's own schedule is known (see the header).
  const ASSUMED_P = 3 * HOUR;
  // The readings a card's findings are worked out over: the station's last
  // week on the air, ending at its newest reading rather than at now — so a
  // station silent for ten days still shows the battery it went quiet with.
  const WINDOW = 7 * DAY;
  const CARD_ROWS = 1000;              // PostgREST's max rows per request here
  const CARD_TTL = 5 * MIN;
  const NET_TTL = 15 * MIN;
  const NET_PAGE = 1000;
  const NET_PAGES = 10;                // 10,000 station_status rows, then say so
  // What HealthAnalysis reads off a reading — and no more: the signal columns
  // and the duplicate bookkeeping are the tab's, not the card's.
  const CARD_SELECT = 'addr,alert_id,a2_station,a2_sensor,station_number,channel,station_id,'
                    + 'reading_ts,received_at,value_raw,protocol,path';
  // `online` and `since` say how long the ingest has been hearing a station:
  // see "The classes" above.
  const NET_SELECT = 'station_id,online,since,last_seen_at,last_reading_at';
  // The server's last look (0059): fresh while its last run is this recent —
  // three of its fifteen-minute runs — and judging silence for stations heard
  // within the week it reads.
  const SERVER_FRESH = 45 * MIN;
  const SERVER_WEEK = 7 * DAY;
  const SERVER_SELECT = 'kind,subject,station_id,severity,title,detail,evidence,first_seen';

  const CLS = {
    ok:     { word: 'OK',      icon: '✓', txt: 'txt-ok' },
    watch:  { word: 'Watch',   icon: '⚠', txt: 'txt-warn' },
    fault:  { word: 'Fault',   icon: '⛔', txt: 'txt-bad' },
    nodata: { word: 'No data', icon: '○', txt: 'txt-muted' },
  };
  const ORDER = ['fault', 'watch', 'ok', 'nodata'];
  const RANK = { nodata: -1, ok: 0, watch: 1, fault: 2 };
  const SEV = {
    critical: { word: 'Critical', icon: '⛔', txt: 'txt-bad',   rank: 0 },
    warn:     { word: 'Warning',  icon: '⚠',  txt: 'txt-warn',  rank: 1 },
    info:     { word: 'Note',     icon: 'ℹ',  txt: 'txt-muted', rank: 2 },
  };
  // A pin per class: its fill, how many pixels bigger, and its ring — colour,
  // weight and dashes. A null ring keeps the white every pin wears. The
  // colours are --ok, --warn, --bad and --muted's light values and the map's
  // black (--map-backbone), as literals — see the header.
  const PIN = {
    ok:     { fill: '#107c10', grow: 0,  ring: null,      weight: null, dash: null },
    // Leaflet strokes with round caps, which grow each dash by half the
    // weight at both ends: a gap has to be wider than the weight to survive.
    watch:  { fill: '#9e5e00', grow: 2,  ring: '#000000', weight: 2,    dash: '2,4' },
    fault:  { fill: '#c7401a', grow: 4,  ring: '#000000', weight: 3,    dash: null },
    nodata: { fill: null,      grow: -1, ring: '#4f6478', weight: 2,    dash: '1,3' },
  };

  // ── What is known ─────────────────────────────────────────────────────────

  // The pins' batch: station id → { last, first } heard (ms; first null where
  // the ingest's record cannot say), and how the asking went.
  // `at` is when it was last asked (the TTL runs from it, answered or not);
  // `okAt` when it last answered — a failed re-ask keeps that answer, said to
  // be as of then, rather than throwing it away for "no data".
  const net = {
    status: 'idle', at: 0, okAt: 0, byId: new Map(), rows: 0, capped: false,
    error: '', denied: false, seq: 0, announce: false,
    serverAt: null,                    // when the server last ran, as this batch found it fresh; null otherwise
  };
  // One entry per station whose card has asked: { status, at, glance, error,
  // denied }. `glance` survives a re-ask, so a card refreshed after CARD_TTL
  // keeps saying what it said until the new answer lands.
  const cards = new Map();
  // When the server last ran, as last asked (at most once per NET_TTL): `at`
  // null when it never has, or the database has no such thing yet.
  const server = { at: null, askedAt: 0 };
  let classes = new Map();             // station id → class, built by rebuild()
  let classesAt = 0;
  let dirty = true;
  let refreshTimer = null;

  const now_ = () => Date.now();
  const stationById = id => ((state.data && state.data.stations) || []).find(s => s.id === id) || null;
  const errText = err => (err && err.message) || String(err || 'unknown error');
  const isDenied = err => !!err && (err.status === 401 || err.status === 403 || err.status === 404);

  // ── The rules (pure) ──────────────────────────────────────────────────────

  // When a quiet station becomes a watch and when a fault, for its period P
  // (null: not learned yet). See "The classes" above.
  function bars(P) {
    if (!P) return { watch: Math.max(90 * MIN, 2 * ASSUMED_P), fault: DAY, assumed: true };
    const watch = Math.max(90 * MIN, 2 * P);
    return { watch, fault: Math.max(watch, Math.min(4 * P, DAY)), assumed: false };
  }
  function quietClass(ms, P) {
    const b = bars(P);
    return ms >= b.fault ? 'fault' : ms >= b.watch ? 'watch' : 'ok';
  }
  function worstSev(list) {
    let w = null;
    (list || []).forEach(f => { if (SEV[f.severity] && (!w || SEV[f.severity].rank < SEV[w].rank)) w = f.severity; });
    return w;
  }
  // Heard across less than two of its checks, with no schedule learned: it has
  // shown no rhythm, so a silence after it says nothing about the station.
  function briefly(k) {
    return !!k && !k.P && k.firstHeard != null && k.lastHeard != null && k.lastHeard - k.firstHeard < bars(null).watch;
  }
  // k = { lastHeard, firstHeard, P, sev }: the worse of how long it has been
  // quiet and the worst finding — a note never colours a pin, and a silence
  // after a station heard too briefly to judge is no data, not a fault.
  // k.judged: the server's fresh look covers this station's silence (see the
  // header), so how long it has been quiet decides nothing here but "no data".
  function classify(k, now) {
    if (!k || k.lastHeard == null) return 'nodata';
    const ms = now - k.lastHeard;
    const q = ms >= bars(k.P).watch && briefly(k) ? 'nodata' : k.judged ? 'ok' : quietClass(ms, k.P);
    // A finding only ever makes it worse: no finding is not "OK" for a
    // station whose silence cannot be judged.
    const f = k.sev === 'critical' ? 'fault' : k.sev === 'warn' ? 'watch' : null;
    return f && RANK[f] > RANK[q] ? f : q;
  }

  // The silence, said as a finding in HealthAnalysis's shape, from when it was
  // last heard. Not the tab's "Silent": that one also knows the receivers
  // that hear it kept delivering, which one station's readings cannot say —
  // so this one says it does not know, and where to find out.
  function quietFinding(id, lastHeard, P, now, firstHeard) {
    if (lastHeard == null) return null;
    const ms = now - lastHeard, b = bars(P);
    if (ms < b.watch || briefly({ lastHeard, firstHeard, P })) return null;
    const every = P ? `It checks every ${HealthAnalysis.fmtPeriod(P)}` : 'Its check schedule is not known yet, so three hours is assumed';
    const missed = P ? Math.floor(ms / P) : 0;
    return {
      kind: 'silent', category: 'comms', severity: ms >= b.fault ? 'critical' : 'warn',
      stationId: id, since: lastHeard,
      title: `Quiet for ${HealthAnalysis.fmtSpan(ms)}`,
      detail: `Nothing heard since ${HealthAnalysis.fmtWhen(lastHeard, now)}. ${every}${missed >= 2 ? ` — ${missed} checks gone by` : ''}. `
            + 'Whether the receivers that hear it were listening all that time is what the Station Health tab weighs.',
      action: (HealthAnalysis.ACTION && HealthAnalysis.ACTION.silent) || '',
    };
  }

  // One station's readings — any shape meganet.reading returns, newest first
  // or not — into what its card says. Pure: no fetch, no DOM.
  //   { lastHeard, firstHeard, P, battery, hasBattery, findings, sev, rows,
  //     t0, newest, capped, shared, checks }
  function glanceFrom(s, rows, now) {
    const at = r => Date.parse(r && r.reading_ts);
    const list = (rows || []).filter(r => Number.isFinite(at(r)));
    const hasBattery = (typeof stationSensors === 'function' ? stationSensors(s) : [])
      .some(se => se && /batt/i.test(String(se.type || '')));
    const empty = { lastHeard: null, firstHeard: null, P: null, battery: null, hasBattery, findings: [], sev: null,
                    rows: 0, t0: null, newest: null, capped: false, shared: false, checks: null };
    if (!list.length) return empty;
    let newest = -Infinity, oldest = Infinity;
    list.forEach(r => { const t = at(r); if (t > newest) newest = t; if (t < oldest) oldest = t; });
    const t0 = Math.max(oldest, newest - WINDOW);
    const win = list.filter(r => at(r) >= t0);
    // The cap bit when the newest 1,000 do not reach a week back: a gauge
    // tipping through a storm can say a thousand things in a day.
    const capped = list.length >= CARD_ROWS && oldest > newest - WINDOW;
    const A = HealthAnalysis.run(win, { t0, t1: Math.max(now, newest), now });
    const S = A.stations.get(s.id);
    // Readings on its addresses that the rules gave to nobody, or to another
    // station: addresses it shares, heard where nothing tells the owners
    // apart. Said rather than counted as its own.
    if (!S) return Object.assign(empty, { rows: win.length, t0, newest, capped, shared: true });
    const lastHeard = S.txs.length ? S.txs[S.txs.length - 1].t : S.lastHeard;
    // Its oldest reading here: how long it has been heard, at least — the
    // newest 1,000 of a busy station reach back further than the bar anyway.
    const firstHeard = oldest;
    const B = S.battery && (S.battery.series || []).length >= 2 ? S.battery : null;
    const findings = S.findings.filter(f => f.stationId === s.id)
      .slice().sort((a, b) => SEV[a.severity].rank - SEV[b.severity].rank || (b.since || 0) - (a.since || 0));
    return {
      lastHeard, firstHeard, P: S.schedule ? S.schedule.P : null,
      battery: B ? { lastNight: B.lastNight, latest: B.latest ? B.latest.V : null, slope: B.slope,
                     daysTo: B.daysTo, nights: (B.nights || []).length, aid: B.aid } : null,
      hasBattery: hasBattery || !!S.battery,
      findings, sev: worstSev(findings), rows: win.length, t0, newest, capped, shared: false,
      checks: checksOf(S),
    };
  }

  // Its checks, slot by slot, for the strip on the card and in the editor:
  // { P, slots: [{ t, outcome, missing }] }, or null with no schedule learned.
  // A check is received, received with frames lost, or not heard. Whether a
  // receiver that hears it was listening when one was not heard — the tab's
  // "missed" against "no receiver listening" — takes every station's
  // readings, so it is not said here: Station Health's to weigh, as the
  // card's foot says.
  function checksOf(S) {
    if (!S.schedule || !(S.slots || []).length) return null;
    return {
      P: S.schedule.P,
      slots: S.slots.map(sl => ({ t: sl.t, outcome: sl.outcome === 'hit' || sl.outcome === 'partial' ? sl.outcome : 'unheard',
                                  missing: sl.missing || [] })),
    };
  }

  // ── Where the answers come from (see the header: the seam #215 changes) ───

  // PostgREST's logic-tree quoting: a value in double quotes, with \ and "
  // escaped, so a colon in `a:6128` and anything at all in a station id are
  // values rather than grammar.
  const quoted = v => `"${String(v).replace(/["\\]/g, '\\$&')}"`;

  // ── The server's findings (0059) ──
  // When it last ran: asked at most once per NET_TTL, by whichever needs it
  // first. A database without 0059 answers 404 — no server, the rules here.
  async function serverRan() {
    if (server.askedAt && now_() - server.askedAt < NET_TTL) return server.at;
    server.askedAt = now_();
    try {
      const r = await dbSelect('health_refresh?select=at&source=eq.stations');
      server.at = r[0] ? Date.parse(r[0].at) : null;
    } catch (_) {
      server.at = null;
    }
    return server.at;
  }
  const serverFresh = () => server.at != null && Number.isFinite(server.at) && now_() - server.at <= SERVER_FRESH;
  // A stored finding in HealthAnalysis's shape.
  function fromServer(f) {
    const ev = f.evidence || {};
    const since = Date.parse(ev.since);
    return { kind: f.kind, category: ev.category || null, severity: f.severity, stationId: f.station_id,
             since: Number.isFinite(since) ? since : null, title: f.title, detail: f.detail || '', action: ev.action || '',
             server: true, firstSeen: Date.parse(f.first_seen) || null };
  }
  // What a card says is wrong: the server's findings when it has looked
  // lately, and the kinds it does not keep worked out here; otherwise all of
  // them worked out here.
  function findingsOf(g) {
    if (!g) return [];
    if (!g.server) return g.findings || [];
    const kept = new Set(HealthAnalysis.CURRENT_KINDS || []);
    return g.server.concat((g.findings || []).filter(f => !kept.has(f.kind)))
      .sort((a, b) => (SEV[a.severity] || SEV.info).rank - (SEV[b.severity] || SEV.info).rank || (b.since || 0) - (a.since || 0));
  }

  async function browserStation(s) {
    const ids = stationAlertIds(s).filter(a => Number.isInteger(a) && a >= 0);
    // Its datastore-resolved rows, whatever their address — a wired channel,
    // a relayed ALERT2 slot — and its own ALERT addresses, which a shared one
    // leaves unresolved there: the rules here sort out whose they are.
    const terms = [`station_id.eq.${quoted(s.id)}`];
    if (ids.length) terms.push(`addr.in.(${ids.map(a => quoted('a:' + a)).join(',')})`);
    const filter = terms.length > 1 ? `or=${encodeURIComponent(`(${terms.join(',')})`)}`
                                    : `station_id=eq.${encodeURIComponent(s.id)}`;
    const rows = await dbSelect(`reading?select=${CARD_SELECT}&${filter}&order=reading_ts.desc&limit=${CARD_ROWS}`);
    const g = glanceFrom(s, rows, now_());
    // No readings left: readings age out after about two years, and the ingest's
    // own record of when it last heard the station does not. So a station
    // with nothing in meganet.reading costs a second, one-row request — unless
    // the pins' batch already holds the answer — and "never" is said only
    // when it is true.
    if (!rows.length && !net.byId.has(s.id)) {
      const got = heardOf(await dbSelect(`station_health?select=${NET_SELECT}&station_id=eq.${encodeURIComponent(s.id)}`)).get(s.id);
      if (got) { g.ingestHeard = got.last; g.ingestFirst = got.first; }
    }
    // The server's open findings on it, when the server has looked lately. A
    // failure here costs only the server's view, never the card.
    g.server = null;
    try {
      await serverRan();
      if (serverFresh()) {
        // Its station findings, and (#217) its transmitter's: off channel or drifting.
        g.server = (await dbSelect(`health_finding?select=${SERVER_SELECT}&source=in.(stations,transmitters)&cleared_at=is.null`
          + `&station_id=eq.${encodeURIComponent(s.id)}`)).map(fromServer);
        g.serverAt = server.at;
      }
    } catch (_) { g.server = null; }
    return g;
  }

  // station_health keeps one row per identity the ingest has spoken for, and
  // more than one can carry a station's id (#162's twins, an MQTT topic beside
  // an HTTP address): the latest of them is when it was last heard, and the
  // earliest `since` of the rows the HTTP ingest keeps — whose `online` is
  // null, so `since` never moves after the row is made — when it was first.
  // A row the MQTT bridge keeps moves `since` whenever its connection does, so
  // a station with one says nothing about how long it has been heard.
  const heardAt = r => Math.max(Date.parse(r.last_seen_at) || -Infinity, Date.parse(r.last_reading_at) || -Infinity);
  function heardOf(rows, into) {
    const m = into || new Map();
    (rows || []).forEach(r => {
      const last = heardAt(r);
      if (!r.station_id || !Number.isFinite(last)) return;
      const since = r.online == null ? Date.parse(r.since) : NaN;
      const was = m.get(r.station_id);
      const first = was && was.first === null ? null      // an MQTT row already said "cannot say"
        : r.online != null || !Number.isFinite(since) ? null
        : was ? Math.min(was.first, since) : since;
      m.set(r.station_id, { last: was ? Math.max(was.last, last) : last, first });
    });
    return m;
  }
  async function browserNetwork(alive) {
    const byId = new Map();
    let rows = 0, capped = false;
    for (let page = 0; ; page++) {
      if (page >= NET_PAGES) { capped = true; break; }
      const got = await dbSelect(`station_health?select=${NET_SELECT}&station_id=not.is.null`
        + `&order=station_key.asc&limit=${NET_PAGE}&offset=${page * NET_PAGE}`);
      if (!alive()) return null;
      heardOf(got, byId);
      rows += got.length;
      if (got.length < NET_PAGE) break;
    }
    // Every open finding the server keeps, in one request: the worst per
    // station beside when it was last heard, and its silence's on its own —
    // the colour Last heard wears where the server judges (heard(), below).
    let serverAt = null;
    try {
      await serverRan();
      if (serverFresh()) {
        const open = await dbSelect('health_finding?select=station_id,severity,kind&source=eq.stations&cleared_at=is.null&station_id=not.is.null&limit=5000');
        if (!alive()) return null;
        open.forEach(f => {
          const n = byId.get(f.station_id);
          if (!n) return;
          n.sev = worstSev([{ severity: n.sev }, f]);
          if (f.kind === 'silent') n.quiet = worstSev([{ severity: n.quiet }, f]);
        });
        serverAt = server.at;
      }
    } catch (_) { serverAt = null; }
    return { byId, rows, capped, serverAt };
  }

  const SOURCE = { station: browserStation, network: browserNetwork };

  // ── Knowledge → classes ───────────────────────────────────────────────────

  // Everything known about one station, merged: the latest last-heard and the
  // earliest first-heard either source has, and the period and findings its
  // card worked out. A first-heard the ingest cannot vouch for (an MQTT row)
  // stays unknown unless the card's readings supply one.
  function knowledgeOf(id) {
    const n = net.byId.get(id);
    const c = cards.get(id);
    const g = c && c.glance;
    let lastHeard = n ? n.last : null;
    [g && g.lastHeard, g && g.ingestHeard].forEach(t => { if (t != null && (lastHeard == null || t > lastHeard)) lastHeard = t; });
    const firsts = [n && n.first, g && g.firstHeard, g && g.ingestFirst].filter(t => t != null);
    const firstHeard = firsts.length ? Math.min(...firsts) : null;
    // The server's look, from the card's own asking or the pins' batch, and
    // only while fresh: it judges silence for a station heard in its week.
    const srvAt = g && g.server ? g.serverAt : net.serverAt;
    const fresh = srvAt != null && now_() - srvAt <= SERVER_FRESH;
    const judged = fresh && lastHeard != null && lastHeard >= srvAt - SERVER_WEEK;
    const sev = worstSev([{ severity: g ? worstSev(findingsOf(g)) : null }, { severity: fresh && !(g && g.server) && n ? n.sev : null }]);
    // Where it judges, the server's verdict on the silence alone: the worst
    // of its open "silent" findings, or null for none.
    const quiet = !judged ? null
      : g && g.server ? worstSev(g.server.filter(f => f.kind === 'silent'))
      : n ? n.quiet || null : null;
    return { lastHeard, firstHeard, P: g ? g.P : null, sev, judged, quiet };
  }

  // Every class at once, when an answer lands — never per pin.
  function rebuild() {
    const now = now_();
    const ids = new Set(net.byId.keys());
    cards.forEach((c, id) => { if (c.glance) ids.add(id); });
    const m = new Map();
    ids.forEach(id => { const k = classify(knowledgeOf(id), now); if (k !== 'nodata') m.set(id, k); });
    classes = m;
    classesAt = now;
    dirty = false;
  }
  function classOf(id) {
    if (dirty) rebuild();
    return classes.get(id) || 'nodata';
  }

  // How many of the stations the map can show are in each class.
  function tally() {
    const t = { ok: 0, watch: 0, fault: 0, nodata: 0, total: 0 };
    ((state.data && state.data.stations) || []).forEach(s => {
      if (s.lat == null || s.lon == null) return;
      t[classOf(s.id)]++;
      t.total++;
    });
    return t;
  }
  const num = n => Number(n).toLocaleString();

  // ── The pins ──────────────────────────────────────────────────────────────

  function ensureNet(force, anyway) {
    if (!state.mapHealth && !anyway) return;
    if (net.status === 'loading') return;
    if (!force && net.at && now_() - net.at < NET_TTL) return;
    fetchNet();
  }

  async function fetchNet() {
    const seq = ++net.seq;
    net.status = 'loading';
    paintNote();
    let got = null, err = null;
    try {
      got = await SOURCE.network(() => seq === net.seq);
    } catch (e) {
      err = e;
    }
    if (seq !== net.seq) return;
    if (err) {
      Object.assign(net, { status: 'error', at: now_(), error: errText(err), denied: isDenied(err) });
    } else if (got) {
      Object.assign(net, { status: 'ok', at: now_(), okAt: now_(), byId: got.byId, rows: got.rows, capped: got.capped,
                           serverAt: got.serverAt == null ? null : got.serverAt, error: '', denied: false });
    } else {
      return;
    }
    dirty = true;
    afterAnswer(true);
  }

  // An answer landed: the pins, the note and the key follow it, once — and
  // whatever else counts the network (onNet, below).
  function afterAnswer(fromNet) {
    paintNote();
    if (fromNet) watchers.forEach(fn => { try { fn(); } catch (e) { console.warn('[health] a count:', e); } });
    if (fromNet) tellHeard(null);
    if (!state.mapHealth) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (state.activeTab === 'stations' && state.map && typeof refreshMapLayers === 'function') {
        refreshMapLayers({ skipFit: true });
      }
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
      paintNote();
      // The switch was pressed and this is what it found: the result of a
      // user's action, so a sentence for a screen reader (core.js's rule 1).
      // A load that finds the switch already on announces nothing.
      if (fromNet && net.announce) { net.announce = false; announce(summaryText()); }
    }, 0);
  }

  // Once per map rebuild, from refreshMapLayers: a map rebuilt with the
  // switch on is when the batch is asked for, or asked again once it is older
  // than NET_TTL.
  function reset() { ensureNet(); }

  // ── The counts ────────────────────────────────────────────────────────────
  // The same batch, counted, for 🏠 Home and the Instrument look's banner
  // (home.js): asked for whether or not the pins' switch is on — the counts
  // are the answer to "how is the network?", which a front page asks every
  // time — and on the pins' terms otherwise, once per NET_TTL. A watcher is
  // told each time an answer lands, good or bad.
  const watchers = new Set();
  function onNet(fn) { watchers.add(fn); }
  function askNet() { ensureNet(false, true); }
  // { status: 'idle' | 'loading' | 'ok' | 'error', okAt, denied, error,
  //   ok, watch, fault, nodata, total } — the classes as tally() counts them,
  // which are the ones the pins and Station Health's overview wear.
  function counts() {
    return { status: net.status, okAt: net.okAt, denied: net.denied, error: net.error, ...tally() };
  }

  // ── The station list's Last heard column ──────────────────────────────────
  // The same batch again, read for one thing: how long since Flood-Net heard
  // each row's station, and how that sits against its checks. The colour is
  // the silence alone, judged as the pin judges it: where the server has
  // looked lately at a station heard in its week (k.judged), its verdict —
  // red or amber for its "silent" finding, green for none — and elsewhere the
  // bars, green inside two of its checks, amber from two, red from four or a
  // day. So a station the server has weighed and not called silent is never
  // red here while its pin and its card say OK. Not the pin's whole class: a
  // sliding battery is the card's to say, and the column is only ever about
  // hearing. A station heard too seldom to judge stays grey whatever its age,
  // as its pin does. Colour is never the only channel: a watch and a fault
  // carry the card's glyph and, for a screen reader, its word.
  //
  // A cell knows where its answer is: empty while the batch is on its way (as
  // the SLS column is before its file lands — "never" before anyone has asked
  // would be a claim), "?" when it could not be asked, "never" only once the
  // datastore has said so, and an em dash for a proposed station, which is
  // not built and has nothing to have heard.

  // Short, because the column is an eighth of the table beside the map: "3 h",
  // "45 min", "7 mo" under a heading that already says *last heard*, with the
  // "ago" kept for a screen reader, which hears the cell without the heading.
  // The number and its unit are one word (a no-break space), so a narrow cell
  // wraps a glyph off the front of "7 mo" rather than "mo" off the end of it.
  // Measured in the table's own type: "45 min", the widest that ordinarily
  // turns up, is 42.5 px, and the column's content box beside the map is 43.
  function agoShort(ms) {
    if (ms < 90 * 1000) return 'now';
    const m = Math.round(ms / MIN);
    if (m < 90) return `${m}\u00a0min`;
    const h = Math.round(ms / HOUR);
    if (h < 48) return `${h}\u00a0h`;
    const d = Math.round(ms / DAY);
    if (d < 14) return `${d}\u00a0d`;
    if (d < 120) return `${Math.round(d / 7)}\u00a0wk`;
    if (d < 730) return `${Math.round(d / 30.44)}\u00a0mo`;
    return `${Math.round(d / 365.25)}\u00a0yr`;
  }
  const agoHtml = ms => esc(agoShort(ms)) + (ms < 90 * 1000 ? '' : '<span class="sr-only"> ago</span>');

  // { cls: 'ok' | 'watch' | 'fault' | 'brief' | 'never' | 'asking' | 'unknown'
  //   | 'proposed', lastHeard, firstHeard, P } — 'brief' heard too seldom to
  // judge, 'unknown' the batch could not be asked and nothing else knows.
  function heard(s, now) {
    if (!s) return { cls: 'unknown', lastHeard: null };
    if (s.proposed) return { cls: 'proposed', lastHeard: null };
    const k = knowledgeOf(s.id);
    const c = cards.get(s.id);
    if (k.lastHeard == null) {
      const known = net.okAt > 0 || !!(c && c.glance);
      return { cls: known ? 'never' : net.status === 'error' ? 'unknown' : 'asking', lastHeard: null };
    }
    const ms = now - k.lastHeard;
    const cls = ms >= bars(k.P).watch && briefly(k) ? 'brief'
      : k.judged ? (k.quiet === 'critical' ? 'fault' : k.quiet === 'warn' ? 'watch' : 'ok')
      : quietClass(ms, k.P);
    return { cls, lastHeard: k.lastHeard, firstHeard: k.firstHeard, P: k.P, judged: k.judged };
  }

  function heardCellHtml(s) {
    const now = now_();
    const h = heard(s, now);
    if (h.cls === 'asking') return '';
    if (h.cls === 'proposed') {
      return '<span class="txt-muted" title="Proposed — not built yet, so there is nothing to have heard">—</span>';
    }
    if (h.cls === 'unknown') {
      return `<span class="txt-muted" title="${net.denied
        ? 'The datastore would not let this browser read when stations were last heard'
        : 'The datastore could not be reached, so when this station was last heard is not known'}">?</span>`;
    }
    if (h.cls === 'never') {
      return '<span class="txt-muted" title="Flood-Net’s receivers have not heard this station">never</span>';
    }
    if (h.cls === 'brief') {
      return `<span class="txt-muted" title="${esc(heardTitle(h, now))}">${agoHtml(now - h.lastHeard)}</span>`;
    }
    const C = CLS[h.cls];
    return `<span class="${C.txt}" title="${esc(heardTitle(h, now))}">${heardMark(h.cls)}${agoHtml(now - h.lastHeard)}</span>`;
  }

  // What a cell with a time says when pointed at: when, and how that sits
  // against its checks — or, heard too seldom, that it cannot be judged.
  function heardTitle(h, now) {
    const when = `Last heard ${HealthAnalysis.fmtWhen(h.lastHeard, now)}`;
    if (h.cls === 'brief') {
      const once = h.lastHeard - h.firstHeard < MIN;
      return `${when} — ${once ? 'heard once' : 'heard only briefly'}, too seldom to say when it is overdue.`;
    }
    // The server's call, where it makes it: no bars to quote.
    if (h.judged) {
      return `${when}. ` + (h.P ? `It checks every ${HealthAnalysis.fmtPeriod(h.P)}. ` : '')
        + 'Whether it is overdue is the server’s call, over every receiver’s week and whether the ones that hear it '
        + (h.cls === 'ok' ? 'were listening: it has not called it silent.' : 'were listening: it calls it silent.');
    }
    // The bars themselves, in hours: "four of its checks or a day" is not what
    // an assumed check does — its fault waits the whole day.
    const b = bars(h.P), span = HealthAnalysis.fmtSpan;
    return `${when}. `
      + (h.P ? `It checks every ${HealthAnalysis.fmtPeriod(h.P)}:` : 'Until its card has been opened and its own checks learned,')
      + ` amber once quiet ${span(b.watch)}, red from ${span(b.fault)}. `
      + 'Whether its receivers were listening is Station Health’s to weigh.';
  }

  // A watch's or a fault's glyph, and its word for a screen reader.
  function heardMark(cls) {
    if (cls === 'ok' || !CLS[cls]) return '';
    const C = CLS[cls];
    return `<span aria-hidden="true">${C.icon}</span><span class="sr-only">${esc(C.word)}:</span> `;
  }

  // ── The station editor's header, and the card's Last heard line ───────────
  // The row's cell again, said in full where there is room for it: when the
  // station was last heard, as a stamp, then how long ago, coloured and marked
  // as the cell is. The same heard(), so the header, the card on the map and
  // the row it was picked from never disagree. Nothing for a draft not yet
  // saved or a proposal — neither has anything to have heard — and "asking…"
  // while the batch is on its way: this is one line somebody is reading, not a
  // column of blanks.
  //
  // The stamp is fmtWhen's — "14:32 today", "06:10 Mon 19 Oct" — with the year
  // once it is not this one, because "2 yr ago" beside a date with no year is
  // a puzzle.
  //
  // heardLineHtml(h, now, door) is the line itself — "06:43 yesterday · ⛔
  // 31 h ago" — for a station with a time; the card wraps the stamp in its
  // door into the Station Health tab (`door`).
  function heardLineHtml(h, now, door) {
    const ms = now - h.lastHeard;
    const y = new Date(h.lastHeard).getFullYear();
    const stamp = HealthAnalysis.fmtWhen(h.lastHeard, now) + (y !== new Date(now).getFullYear() ? ` ${y}` : '');
    const time = `<time datetime="${esc(new Date(h.lastHeard).toISOString())}">${esc(stamp)}</time>`;
    const C = CLS[h.cls];
    return `${door ? door(time) : time} · `
      + `<span class="${C ? C.txt : 'txt-muted'}">${heardMark(h.cls)}${ms < 90 * 1000 ? 'just now' : `${esc(agoShort(ms))} ago`}</span>`;
  }
  function heardHeadHtml(s) {
    if (!s || !s.id || s.proposed) return '';
    const now = now_();
    const h = heard(s, now);
    const label = '<span class="txt-muted">Last heard</span> ';
    if (h.cls === 'asking') return `${label}<span class="txt-muted">asking…</span>`;
    if (h.cls === 'unknown') {
      return `${label}<span class="txt-muted" title="${net.denied
        ? 'The datastore would not let this browser read when stations were last heard'
        : 'The datastore could not be reached, so when this station was last heard is not known'}">not known</span>`;
    }
    if (h.cls === 'never') {
      return `${label}<span class="txt-muted" title="Flood-Net’s receivers have not heard this station">never</span>`;
    }
    return `<span title="${esc(heardTitle(h, now))}">${label}${heardLineHtml(h, now)}</span>`;
  }

  // Told each time something new is known about when a station was heard: the
  // batch (id null — every row) or one station's card (its id).
  const heardWatchers = new Set();
  function onHeard(fn) { heardWatchers.add(fn); }
  function tellHeard(id) {
    heardWatchers.forEach(fn => { try { fn(id); } catch (e) { console.warn('[health] the Last heard column:', e); } });
  }

  // What refreshMapLayers lays over a pin's own style while the switch is on:
  // { cls, fill, ring, grow, weight, dash }, or null — the switch off, or no
  // answer yet (the pins keep their roles' colours until there is one, and
  // the note says it is asking). A lookup and a dozen property reads.
  function pinStyle(s) {
    if (!state.mapHealth || !s || !net.at) return null;
    const cls = classOf(s.id);
    const pin = PIN[cls];
    return {
      cls,
      // Hollow for no data, as a proposed station is: the map's own white.
      fill: pin.fill || (typeof MAP_PIN_PROPOSED_FILL !== 'undefined' ? MAP_PIN_PROPOSED_FILL : '#ffffff'),
      ring: pin.ring || (typeof MAP_PIN_RING !== 'undefined' ? MAP_PIN_RING : '#ffffff'),
      grow: pin.grow, weight: pin.weight, dash: pin.dash,
    };
  }

  function setPins(on) {
    state.mapHealth = !!on;
    try { localStorage.setItem('mn-map-health', on ? 'on' : 'off'); } catch (_) {}
    // One colouring of the pins at a time: ⏱️ Latency gives way (map-latency.js).
    if (on && typeof MapLatency !== 'undefined') MapLatency.yieldTo();
    if (on) {
      // An answer in hand and young is the answer; one that failed is asked
      // for again — turning the switch on is asking.
      const fresh = net.status === 'ok' && now_() - net.at < NET_TTL;
      net.announce = !fresh;
      ensureNet(net.status === 'error');
      if (fresh) announce(summaryText());
    } else {
      net.announce = false;
      announce('Pins are back in their roles’ colours.');
    }
    paintNote();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    if (typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
  }

  function askAgain() {
    net.announce = true;
    ensureNet(true);
  }

  function summaryText() {
    if (net.status === 'error' && !net.okAt) {
      return 'Pins coloured by health: no data — '
        + (net.denied ? 'the datastore would not let this browser read when stations were last heard.'
                      : 'the datastore could not be reached.');
    }
    const t = tally();
    return `Pins coloured by health: ${num(t.ok)} OK, ${num(t.watch)} to watch, ${num(t.fault)} at fault, `
         + `${num(t.nodata)} with no data.`;
  }

  // A clause for the map's accessible name (updateMapAltName): the headline
  // is the health while the pins wear it — part 1 of the graphic pattern.
  function altText() {
    if (!state.mapHealth || !net.at) return '';
    const t = tally();
    return `pins coloured by health — ${num(t.ok)} OK, ${num(t.watch)} watch, ${num(t.fault)} fault, ${num(t.nodata)} no data`;
  }

  // The note under the switch, in 🗺️ Map display.
  function noteHtml() {
    if (!state.mapHealth) {
      const lat = typeof MapLatency !== 'undefined' ? MapLatency.noteText() : '';
      return lat ? esc(lat) : 'Off — every pin wears its role’s colour.';
    }
    if (!net.okAt && net.status !== 'error') return 'Asking the datastore when each station was last heard…';
    const again = '<button type="button" class="link-btn" onclick="HealthGlance.askAgain()" '
      + 'title="Ask the datastore again when each station was last heard">↻ Ask again</button>';
    const why = net.denied ? 'the datastore would not let this browser read when stations were last heard'
                           : `the datastore could not be reached (${esc(net.error)})`;
    if (net.status === 'error' && !net.okAt) {
      return `<span class="txt-warn">No data</span> — ${why}, so every pin is hollow but those
        whose card has been opened. ${again}`;
    }
    const t = tally();
    return `As of ${esc(HealthAnalysis.fmtWhen(net.okAt))}: <strong>${num(t.ok)}</strong> OK, <strong>${num(t.watch)}</strong> watch,
      <strong>${num(t.fault)}</strong> fault, ${num(t.nodata)} no data — by when each was last heard, and
      for a station whose card has been opened, by what its readings say.`
      + (net.capped ? ` <span class="txt-warn">Stopped at ${num(NET_PAGE * NET_PAGES)} rows.</span>` : '')
      + (net.status === 'loading' ? ' Asking again…'
        : net.status === 'error' ? ` <span class="txt-warn">Asking again failed</span> — ${why}. ${again}` : ` ${again}`);
  }
  function paintNote() {
    const el = document.getElementById('map-health-note');
    if (el) el.innerHTML = noteHtml();
  }

  // The key, for the 🔑 legend while the switch is on. Each swatch repeats the
  // pin's second channel — the size, the ring, the hollow — not only its hue.
  function legendHtml() {
    if (!state.mapHealth) return '';
    const what = {
      ok:     'OK — heard within two of its checks',
      watch:  'Watch — quiet two checks or more, or a warning: a dashed ring, a step bigger',
      fault:  'Fault — quiet four checks or a day, or a critical finding: a heavy ring, bigger again',
      nodata: 'No data — never heard, heard too seldom to judge, or the datastore could not be asked: hollow, in a dotted ring',
    };
    const t = net.at ? tally() : null;
    return ORDER.map(k => `
      <span class="legend-item">
        <span class="hg-key hg-key--${k}" aria-hidden="true"></span>
        <span class="small">${esc(what[k])}${t ? ` <span class="txt-muted">(${num(t[k])})</span>` : ''}</span>
      </span>`).join('') + `
      <span class="legend-item legend-off">
        <span class="small txt-muted">Pins are coloured by health, not by role. A check is the station’s own
          once its card has been opened — three hours until then, when a fault waits a whole day.</span>
      </span>`;
  }

  // ── The card ──────────────────────────────────────────────────────────────

  const elId = id => `mn-health-card-${id}`;

  // The section, placed by stnCardHtml(). Nothing for a proposed station: it
  // is not built, the band above says so, and there is nothing to have heard.
  function cardHtml(s) {
    if (!s || s.proposed) return '';
    return `<div class="acma-sect stn-card-health" id="${esc(elId(s.id))}"
         data-mn-health="${esc(s.id)}">${sectionHtml(s)}</div>`;
  }

  function badgeHtml(cls) {
    const c = CLS[cls];
    return `<span class="hg-badge ${c.txt}"><span aria-hidden="true">${c.icon}</span> ${esc(c.word)}</span>`;
  }
  function sevHtml(sev) {
    const c = SEV[sev] || SEV.info;
    return `<span class="hg-sev ${c.txt}"><span aria-hidden="true">${c.icon}</span><span class="sr-only">${esc(c.word)}:</span></span>`;
  }
  const row = (label, html) => `<div class="acma-row"><span>${esc(label)}</span><span>${html}</span></div>`;
  // A door into the Station Health tab, on this station, at `part` of it.
  const go = (id, part, html, title) => `<button type="button" class="link-btn hg-go"
      onclick="HealthGlance.open('${escAttr(id)}', '${part}')" title="${esc(title)}">${html}</button>`;

  const fmtDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  function ago(t, now) {
    const ms = now - t;
    return ms < 90 * 1000 ? 'just now' : `${HealthAnalysis.fmtSpan(ms)} ago`;
  }

  function batteryText(B) {
    const level = B.lastNight != null ? `${B.lastNight.toFixed(1)} V last night`
      : B.latest != null ? `${B.latest.toFixed(1)} V` : '';
    const trend = B.slope == null ? 'not enough nights for a trend'
      : Math.abs(B.slope) < 0.01 ? 'night lows steady'
      : `night lows ${B.slope > 0 ? 'rising' : 'falling'} ${Math.abs(B.slope).toFixed(2)} V a day`
        + (B.slope < 0 && B.daysTo != null && B.daysTo <= 60
          ? ` — 11.8 V in about ${Math.max(1, Math.round(B.daysTo))} day${Math.round(B.daysTo) === 1 ? '' : 's'}` : '');
    return [level, trend].filter(Boolean).join(', ');
  }

  // ── Its checks, slot by slot ──────────────────────────────────────────────
  // The Station Health tab's strip, drawn by its own Health.slotStrip from the
  // card's readings: on the card under its health lines, and in the station
  // editor's Telemetry section (checksHtml). A square pressed opens the tab
  // on that check, with what the rest of the network was doing then; the
  // heading over it opens the tab's own strip, and is the keyboard's way in.

  const SLOT = {
    hit:     { label: 'received',              cls: 'hl-slot--hit' },
    partial: { label: 'received, frames lost', cls: 'hl-slot--partial' },
    unheard: { label: 'not heard',             cls: 'hl-slot--miss', x: true },
  };
  // Drawn this wide, the card's 340 px less its padding and scroll bar: a
  // three-hourly station at the tab's own size, a busier one in bars, and the
  // box scrolls sideways for the busiest rather than the page.
  const STRIP_W = 300;

  function stripHtml(s, c) {
    if (!c || typeof Health === 'undefined' || !Health.slotStrip) return '';
    const { svg, W, H: Hh } = Health.slotStrip(c.slots, c.P, { outcomes: SLOT, fit: STRIP_W });
    const n = k => c.slots.filter(sl => sl.outcome === k).length;
    const days = new Set(c.slots.map(sl => new Date(sl.t).toDateString())).size;
    return `<div class="hl-strip-wrap hg-strip-wrap">
        <svg class="hl-strip" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img"
             aria-label="${esc(`${s.name || s.id}: ${c.slots.length} checks, every ${HealthAnalysis.fmtPeriod(c.P)}, a row a day over ${days} day${days === 1 ? '' : 's'} — ${n('hit')} received, ${n('partial')} with frames lost, ${n('unheard')} not heard`)}"
             onclick="HealthGlance.stripClick(event, '${escAttr(s.id)}')">${svg}</svg>
      </div>
      <div class="qs-legend">${Object.values(SLOT).map(o => `<span><i class="hl-key ${o.cls}" aria-hidden="true"></i>${esc(o.label)}</span>`).join('')}</div>`;
  }
  const stripHead = (s, cls) => `<div class="${cls} hg-strip-head">${go(s.id, 'checks', 'Its checks, slot by slot',
      `Open the Station Health tab on ${s.name || s.id} — its checks, slot by slot, and whether its receivers were listening`)}</div>`;

  // The station editor's: the card's answer, asked for if the card has not
  // (one request, shared with the card and kept as long), and painted in
  // place by the editor when it lands (onHeard). Where there is no strip to
  // draw, it says why.
  function checksHtml(s) {
    if (!s || !s.id || s.proposed) return '';
    ask(s);
    const c = cards.get(s.id);
    const g = c && c.glance;
    const note = html => `<p class="small txt-muted ef-flush">${html}</p>`;
    let body;
    if (g && g.checks) {
      body = stripHtml(s, g.checks) + note(`From its own readings since ${esc(fmtDay(g.t0))}${g.capped ? ' (the newest 1,000)' : ''}.
        A check not heard may be its receivers rather than it — whether they were listening is Station Health’s to weigh:
        press a square for the network at that moment.`);
    } else if (!g && c && c.status === 'error') {
      body = note(`${c.denied ? 'The datastore would not let this browser read its readings.' : `The datastore could not be reached (${esc(c.error)}).`}
        <button type="button" class="link-btn" onclick="HealthGlance.retry('${escAttr(s.id)}')">Try again</button>`);
    } else if (!g) {
      body = note('Asking the datastore…');
    } else if (g.shared) {
      body = note('Its readings came on addresses it shares with other stations, and nothing heard with them says which were its.');
    } else if (!g.rows) {
      body = note('None of its readings is in the datastore, so there are no checks to draw.');
    } else {
      body = note(`No check schedule learned from its ${num(g.rows)} reading${g.rows === 1 ? '' : 's'} since ${esc(fmtDay(g.t0))} — it may report on events only.`);
    }
    return stripHead(s, 'ef-sub') + body;
  }

  // A press on a strip: the Station Health tab on the square's check, or on
  // the strip itself for anywhere else on it.
  function stripClick(e, id) {
    const r = e && e.target && e.target.closest && e.target.closest('rect[data-t]');
    open(id, r ? 'lens' : 'checks', r ? Number(r.getAttribute('data-t')) : null);
  }

  function sectionHtml(s) {
    const id = s.id;
    const c = cards.get(id);
    const g = c && c.glance;
    const now = now_();
    const headId = `mn-health-head-${id}`;
    const busy = !c || c.status === 'loading';
    const head = cls => `<span class="small txt-muted stn-card-rhs-head" id="${esc(headId)}"
        title="What its own readings say: when it was last heard, its battery's night lows, and what the Station Health tab's rules find in its last week on the air. Each line opens that tab on this station.">Health${cls ? ' ' + badgeHtml(cls) : ''}</span>`;
    const wrap = inner => `<div class="stn-card-health-body" role="group" aria-labelledby="${esc(headId)}"
        tabindex="-1"${busy ? ' aria-busy="true"' : ''}>${inner}</div>`;

    if (!g && busy) {
      return wrap(head(null) + row('Last heard', '<span class="txt-muted small">asking the datastore…</span>'));
    }
    if (!g) {
      // Asked, and no answer: an honest "no data", never "OK", and the way to
      // ask again — a signal that comes and goes is the ordinary case in the
      // field.
      return wrap(head('nodata')
        + row('Last heard', '<span class="txt-muted">no data</span>')
        + `<p class="small txt-muted stn-card-exp-foot">${c.denied
          ? 'The datastore would not let this browser read its readings.'
          : `The datastore could not be reached (${esc(c.error)}).`}
          <button type="button" class="link-btn" onclick="HealthGlance.retry('${escAttr(id)}')">Try again</button></p>`);
    }

    const k = knowledgeOf(id);
    if (k.lastHeard == null) {
      return wrap(head('nodata') + row('Last heard', g.shared
        ? '<span class="txt-muted">not told apart</span>'
        : '<span class="txt-muted">never</span>')
        + `<p class="small txt-muted stn-card-exp-foot">${g.shared
          ? `Readings were heard on addresses it shares with other stations — newest ${esc(HealthAnalysis.fmtWhen(g.newest, now))} —
             and nothing heard with them says they were this station’s.`
          : 'Flood-Net’s receivers have no readings from it.'}</p>`);
    }

    // The class is the pin's, by construction: the same knowledge through the
    // same rule, as of the same moment.
    const cls = classOf(id);
    const at = classesAt || now;
    // Silence: the server's verdict where it judges, this card's rule elsewhere.
    const quiet = k.judged ? null : quietFinding(id, k.lastHeard, k.P, at, k.firstHeard);
    // Worst first; the silence leads its own severity, being the line above.
    const findings = (quiet ? [quiet] : []).concat(findingsOf(g))
      .sort((a, b) => (SEV[a.severity] || SEV.info).rank - (SEV[b.severity] || SEV.info).rank);
    const worst = findings[0] || null;
    const name = s.name || id;
    const lines = [];
    // The editor header's line, word for word and colour for colour (heard()),
    // its stamp the door; the learned schedule under it.
    const h = heard(s, now);
    lines.push(row('Last heard', `<span title="${esc(heardTitle(h, now))}">${heardLineHtml(h, now,
        t => go(id, 'checks', t, `Open the Station Health tab on ${name} — its checks, slot by slot`))}</span>`
      + (k.P ? `<br><span class="mn-pop-note">checks every ${esc(HealthAnalysis.fmtPeriod(k.P))}</span>` : '')));
    if (g.battery) {
      lines.push(row('Battery', go(id, 'battery', esc(batteryText(g.battery)),
        `Open the Station Health tab on ${name} — its battery across its solar day, night lows ringed`)));
    } else if (g.hasBattery) {
      lines.push(row('Battery', '<span class="txt-muted small">too few readings for a trend</span>'));
    }
    lines.push(row('Findings', worst
      ? go(id, 'findings', `${sevHtml(worst.severity)} ${esc(worst.title)}`,
          `Open the Station Health tab on ${name} — its findings, with the evidence and what to do`)
        + (findings.length > 1 ? ` <span class="mn-pop-note">+${findings.length - 1} more</span>` : '')
      : '<span class="small">nothing found</span>'));
    const list = findings.length ? `
      <details class="stn-card-health-more">
        <summary class="small">${findings.length === 1 ? 'What it found' : `All ${findings.length} findings`}</summary>
        <ul class="stn-card-health-list">${findings.map(f => `
          <li>${sevHtml(f.severity)} <b>${esc(f.title)}</b>
            <span class="small">${esc(f.detail || '')}</span>
            ${f.action ? `<span class="small hg-action"><span aria-hidden="true">→</span> ${esc(f.action)}</span>` : ''}</li>`).join('')}
        </ul>
      </details>` : '';
    // Its checks under the lines: the shape of its week, which the lines
    // above can only sum up.
    const strip = g.checks ? `<div class="hg-strip">${stripHead(s, 'small')}${stripHtml(s, g.checks)}</div>` : '';
    // Where the lines came from, and what they cannot see — one sentence, the
    // card being 340 px wide and this its most-read section. A station heard
    // too briefly to judge says so first: that is why it is no data.
    const brief = cls === 'nodata' && briefly(k)
      ? (k.lastHeard - k.firstHeard < MIN ? 'Heard once' : `Heard only between ${esc(HealthAnalysis.fmtWhen(k.firstHeard, now))} and ${esc(HealthAnalysis.fmtWhen(k.lastHeard, now))}`)
        + ' — too seldom to say when it is overdue. '
      : '';
    const foot = brief + (g.lastHeard == null
      ? 'None of its readings is in the datastore — aged out, or refused when they came (a logger with a dead clock is heard but not stored); the time is when the ingest last heard it.'
      : `From ${num(g.rows)} reading${g.rows === 1 ? '' : 's'} since ${esc(fmtDay(g.t0))}${g.capped ? ' (the newest 1,000)' : ''}`
        + `${c.status === 'loading' ? ', asking again…' : c.status === 'error' ? ' — asking again just now failed' : ''}`
        + (k.judged
          ? `; whether it is silent, and the rest the server keeps, as the server last worked it out over every receiver’s week — ${esc(ago(g.serverAt || net.serverAt, now))}.`
          : '; whether its receivers were listening is Station Health’s to weigh.'));
    return wrap(head(cls) + lines.join('') + list + strip + `<p class="small txt-muted stn-card-exp-foot">${foot}</p>`);
  }

  // Paint the section in place, if the card is still on this station.
  function paintCard(id) {
    const el = document.getElementById(elId(id));
    if (!el || el.dataset.mnHealth !== id) return;
    const s = stationById(id);
    if (!s) return;
    const had = el.contains(document.activeElement);
    const opened = !!el.querySelector('details[open]');
    el.innerHTML = sectionHtml(s);
    if (opened) { const d = el.querySelector('details'); if (d) d.open = true; }
    if (had) { const g = el.querySelector('.stn-card-health-body') || el; g.focus({ preventScroll: true }); }
  }

  // From repaintStnCard(): ask, unless an answer is in hand and young, or one
  // is on its way.
  function ask(s) {
    if (!s || s.proposed) return;
    const c = cards.get(s.id);
    if (c && (c.status === 'loading' || now_() - c.at < CARD_TTL)) return;
    runCard(s);
  }

  async function runCard(s) {
    const id = s.id;
    const prev = cards.get(id);
    const entry = { status: 'loading', at: now_(), glance: prev ? prev.glance : null, error: '', denied: false };
    cards.set(id, entry);
    paintCard(id);
    let g = null, err = null;
    try { g = await SOURCE.station(s); } catch (e) { err = e; }
    if (cards.get(id) !== entry) return;           // asked again since; that answer wins
    const before = classOf(id);
    if (err) Object.assign(entry, { status: 'error', at: now_(), error: errText(err), denied: isDenied(err) });
    else Object.assign(entry, { status: 'ok', at: now_(), glance: g });
    dirty = true;
    const after = classOf(id);
    paintCard(id);
    // Its row in the station list follows its card too: the card's readings
    // can be newer than the ingest's record, and its learned period moves the
    // bars.
    tellHeard(id);
    // The pin follows its card: the two say the same thing about the station
    // somebody is looking at.
    if (state.mapHealth && net.at && after !== before) afterAnswer(false);
  }

  function retry(id) {
    const s = stationById(id);
    if (!s) return;
    const c = cards.get(id);
    if (c && c.status === 'loading') return;
    cards.delete(id);
    runCard(s);
  }

  // A line on the card, pressed: the Station Health tab, on this station, at
  // the part of it the line was about. Out of full screen first, for the
  // reason fieldDataFromCard gives — the tab would be switched invisibly
  // behind a fixed panel.
  // `t`, from a press on the strip: the check the tab opens its lens on.
  function open(id, part, t) {
    if (typeof Health === 'undefined' || !Health.showStation) return;
    if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
    Health.showStation(id, part, t);
  }

  return {
    // the card
    cardHtml, ask, retry, open,
    // its checks, slot by slot: the strip's press, and the editor's copy
    stripClick, checksHtml,
    // the pins
    pinStyle, reset, setPins, askAgain, noteHtml, legendHtml, altText,
    // the counts, for Home and the Instrument look's banner
    onNet, askNet, counts,
    // the station list's Last heard column, and the editor's header
    heardCellHtml, heardHeadHtml, onHeard,
    // when one station was last heard, as everything known says — for
    // ⏱️ Latency (map-latency.js): { lastHeard, firstHeard }
    known: id => { const k = knowledgeOf(id); return { lastHeard: k.lastHeard, firstHeard: k.firstHeard }; },
    // the rules, for test/healthcard.mjs and for #215 to keep honest
    classify, bars, glanceFrom, quietFinding, findingsOf, fromServer,
    classOf: id => classOf(id),
    // what is known, for the check
    _state: () => ({
      net: { status: net.status, at: net.at, okAt: net.okAt, ids: net.byId.size, rows: net.rows, error: net.error, denied: net.denied },
      cards: [...cards.entries()].map(([id, c]) => ({ id, status: c.status, lastHeard: c.glance ? c.glance.lastHeard : null })),
      classesAt,
    }),
  };
})();

if (typeof window !== 'undefined') window.HealthGlance = HealthGlance;
