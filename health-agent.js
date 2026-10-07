// MegaNet — health-agent.js
//
//   HealthAgent   the Station Health tab's agent: Claude, handed what the
//                 analysis found and tools over the same readings, asked to
//                 investigate and write the maintenance briefing — which
//                 stations to visit first and why, what the network and the
//                 register need, and what it could not tell.
//
// After health.js (Health.state()) and health-analysis.js (HealthAnalysis);
// before init.js. Nothing here runs at load, and nothing is fetched until
// somebody presses the button: the Anthropic SDK is imported then, pinned,
// from jsDelivr, and every request goes from this browser to Anthropic's API
// under the key the person gave it.
//
// ── Why an agent, when the analysis already ranks everything ─────────────────
// The analysis is rules: each one sound, each one blind to the others. It
// says twenty stations went silent; it cannot say "fourteen of them are the
// same repeater, two have batteries that sagged for three nights first, and
// the rest are far-away stations you only ever hear on a good night". That
// is the job a person does with the tab open — read the list, open the odd
// ones, look at the moment, set one finding against another — and it is the
// job the agent does, with the same views as tools:
//
//   list_findings      the analysis' findings, filtered
//   station_detail     a station's owner, schedule, battery, rain, level,
//                      sensors, findings, neighbours and last site visit
//   context_at         the context lens: the network at one moment
//   station_readings   its transmissions in the window, with the corrupted
//                      copies beside them
//   station_history    up to 30 days from the datastore, a line a day — for
//                      the trend the window is too short to show
//   stations_near      what the stations around it are doing
//   receivers, repeaters, find_station
//
// Every tool reads; none writes. A tool's answer is JSON, trimmed.
//
// ── Keys, and why this one is the person's ──────────────────────────────────
// floodwarning.net is a static site with a Worker in front of it, and a key
// in a Worker secret would be spendable by anyone who can reach the page.
// Until that door has a lock (an Access-gated route is the obvious one), the
// key is the person's own: typed here, used from here, held in memory unless
// they ask for it to be remembered on this device. The SDK refuses to run in
// a browser without `dangerouslyAllowBrowser`, which is exactly the decision
// being made: this browser, this person's key.

const HealthAgent = (() => {

  const MODEL = 'claude-opus-5-5';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
  // Server-side refusal fallback ("default" routes by refusal category), and
  // the progress notes a model writes between tool calls.
  const BETAS = ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'];
  const MAX_TURNS = 16;
  const MAX_RESULT = 14000;           // characters of one tool answer
  const KEY_STORE = 'mn-hl-anthropic-key';
  const EFFORT_STORE = 'mn-hl-agent-effort';
  const LAST_STORE = 'mn-hl-briefing';
  // US$ per million tokens for claude-opus-5-5: input, output, cache read.
  const PRICE = { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 };

  function readStore(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function writeStore(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} }

  const G = {
    key: readStore(KEY_STORE) || '',
    remember: !!readStore(KEY_STORE),
    effort: readStore(EFFORT_STORE) === 'medium' ? 'medium' : 'high',
    running: false, stream: null, stopped: false,
    feed: [],            // [{ kind: 'tool'|'note'|'error', text }]
    live: '',            // the answer as it streams
    messages: [],        // the conversation, for follow-ups
    answer: null,        // { md, at, win, usage }
    usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    error: '',
    factory: null,       // test seam: () => client
  };
  // The last briefing, kept on this device — read the first time the tab draws.
  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    try { const last = JSON.parse(readStore(LAST_STORE) || 'null'); if (last && last.md && !G.answer) G.answer = last; } catch (_) {}
  }

  // ── the SDK ────────────────────────────────────────────────────────────────

  let sdkPromise = null;
  let Sdk = null;
  function loadClient() {
    if (G.factory) return Promise.resolve(G.factory());
    if (!sdkPromise) {
      sdkPromise = import(SDK_URL).then(m => { Sdk = m.default || m.Anthropic; return Sdk; })
        .catch(err => { sdkPromise = null; throw err; });
    }
    return sdkPromise.then(A => new A({ apiKey: G.key, dangerouslyAllowBrowser: true, maxRetries: 2 }));
  }

  // ── what the agent is told ─────────────────────────────────────────────────

  const SYSTEM = `You are the operations and maintenance analyst for Flood-Net, which monitors a flood-warning radio network of ALERT field stations in Queensland, Australia. People will act on what you write: they decide which remote sites to drive to, and a field visit costs most of a day.

How the network works
- A field station has a rain gauge, often a river level sensor, and a battery monitor. Each sensor transmits ALERT frames on VHF: a 13-bit address (one address is one sensor) and an 11-bit value. Repeaters on hills relay frames; base stations (Raspberry Pis with RTL-SDR receivers) hear them and upload readings.
- Every station sends a timed check report of every sensor every few hours (the period is learned per station: 3 h is common, some 2 h, 1 h or 30 min), plus event reports (rain tips, level changes). ALERT is ALOHA: no acknowledgement, no collision avoidance, so a missed check is simply not heard.
- Battery: raw count / 10 = volts, a 12 V lead-acid battery, almost always solar-charged. The like-for-like measure is the night low before dawn in solar time; a healthy site swings 0.5-1 V a day. Under 12.2 V at rest is about half charge; under 11.8 V the radio starts to brown out. A site that goes silent at night and returns mid-morning is the classic flat-battery or failing-panel pattern.
- Rain gauges report a running tip count (0.2 mm per tip unless a bucket size is recorded). Water level counts have a per-site scale that is not on file, so compare levels only to themselves.
- A repeater that relays with bit errors produces a second, different copy of a reading seconds later; the database stores it as an extra reading (a "corrupted copy"), or under another address (a "ghost"). The analysis sets these aside.
- An address heard regularly that no station on file carries, or that is filed at a station hundreds of km away, means the station register is wrong, not that a station is faulty.

What you have
- A deterministic analysis has already run over the readings and produced findings with evidence. Its rules are sound but blind to each other. Your job is the judgement across them.
- Tools read the same analysed readings, a station's last site visit, and up to 30 days of a station's history from the datastore. Nothing you do changes anything.

How to work
- Start from the overview and list_findings. Before calling anything a station fault, ask whether it shares a cause with others: the same repeater, the same receiver, the same area, the same hours. Use stations_near, repeaters and context_at for that.
- Check before you recommend a visit: look at station_detail, and station_history when a trend matters. A station heard only now and then from far away is not "silent" in the same way as a local one that stopped.
- Rank site visits by consequence for flood warning and by confidence: a river level station that has stopped reporting matters more than a slow battery decline; a battery heading for 11.8 V within days matters more than one that is merely low.
- Be concrete: cite the numbers from the tools. Say plainly what you could not establish. Never invent stations, readings, visits or history.
- Use a handful of tool calls, not dozens: investigate the findings that would change what somebody does tomorrow.

Write the briefing in Markdown with exactly these sections:
## Headline
Two or three sentences: the state of the network and the one thing that matters most.
## Visit first
A numbered list of at most 8 site visits, most urgent first. Each: the station as [[station_id]], what is wrong, the evidence in numbers, what to do or bring on site, and confidence (high, medium or low).
## Network
Repeaters, receivers and areas: shared causes, with the stations they explain.
## Data and register
Fixes made in Flood-Net rather than in the field.
## Watch
What to look at again in a few days, and why.
## What I could not tell
The limits of what the readings show.

Refer to every station as [[station_id]] (its id, not its name) so the app can link it; never write a bare id otherwise. Keep the whole briefing under about 700 words.`;

  const FOLLOW_UP_NOTE = 'Answer the question directly, using the tools as needed. Same conventions: numbers from the tools, stations as [[station_id]], say what you could not tell. No fixed sections; keep it short.';

  // ── the tools ─────────────────────────────────────────────────────────────

  const S_ID = { type: 'string', description: 'A station id, as the findings and tools give it (e.g. "strathpine_gympie_rd_al").' };
  const TOOLS = [
    { name: 'list_findings',
      description: 'The findings of the deterministic analysis, worst first, each with its station or receiver or repeater, title, detail, suggested action, since-time and evidence numbers. Filter by severity and category.',
      input_schema: { type: 'object', properties: {
        severity: { type: 'string', enum: ['any', 'critical', 'warn', 'info'], description: 'Only this severity; "any" (default) is everything.' },
        category: { type: 'string', enum: ['any', 'power', 'comms', 'network', 'sensor', 'data', 'register'], description: 'Only this kind of finding.' },
        limit: { type: 'integer', minimum: 1, maximum: 150, description: 'At most this many (default 60).' },
      }, required: [] } },
    { name: 'station_detail',
      description: "One station in full: position, owner, roles and repeaters on file; its learned check schedule with checks received, partial, missed, missed network-wide and unknown, its silent spells and daily counts; its battery (night lows by night, trend in V/day, daily swing, latest); its rain gauge and level sensor; its sensors; its findings; the receivers that hear it; and its last site visit with the battery measured then.",
      input_schema: { type: 'object', properties: { station_id: S_ID }, required: ['station_id'] } },
    { name: 'context_at',
      description: 'The network around one moment for one station: which receivers that hear it were delivering, what its neighbours (repeater-mates within 60 km, stations within 25 km) did at their own check slots then, what it sent itself, and a verdict on whether a miss was its own, shared, or the network\'s.',
      input_schema: { type: 'object', properties: { station_id: S_ID,
        time: { type: 'string', description: 'The moment, ISO 8601 (e.g. "2026-10-05T04:41:00+10:00"). A check slot time from station_detail is the usual one to ask about.' } },
        required: ['station_id', 'time'] } },
    { name: 'station_readings',
      description: "A station's transmissions in the analysed window, newest first: time, sensor kind, raw value, engineering value where one is known, how many copies were heard, and any corrupted copies stored beside it.",
      input_schema: { type: 'object', properties: { station_id: S_ID,
        kind: { type: 'string', enum: ['any', 'battery', 'rain', 'level'], description: 'Only this sensor (default any).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many (default 60).' } },
        required: ['station_id'] } },
    { name: 'station_history',
      description: "Up to 30 days of a station's readings, fetched from the datastore and summarised a line a day per sensor: count, minimum, maximum, last, and for a battery the volts. For trends longer than the analysed window — whether a battery has been sliding for weeks, when a station last reported normally.",
      input_schema: { type: 'object', properties: { station_id: S_ID,
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'How many days back (default 14).' } },
        required: ['station_id'] } },
    { name: 'stations_near',
      description: 'The stations heard within a radius of one station, nearest first, each with its distance, status, learned check period, miss rate and worst finding.',
      input_schema: { type: 'object', properties: { station_id: S_ID,
        radius_km: { type: 'number', minimum: 1, maximum: 150, description: 'Default 30.' } },
        required: ['station_id'] } },
    { name: 'receivers',
      description: 'Every receiver (base station or gateway) that delivered readings: readings and rate, first and last delivery, outages, upload lag, corrupted copies heard, channels.',
      input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'repeaters',
      description: 'Repeaters whose pass ranges carry the addresses heard: the stations heard behind each, which of them are silent now, and the corrupted copies each could have carried (blame shared evenly among the repeaters that could have).',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Default 25.' } }, required: [] } },
    { name: 'find_station',
      description: 'Find station ids by name, station number or ALERT address, among every station on file (heard or not).',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'A name fragment, a station number, or an ALERT address.' } }, required: ['query'] } },
  ].map(t => Object.assign({ eager_input_streaming: true }, t));

  // ── the tools, run ─────────────────────────────────────────────────────────

  const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
  const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
  const iso = t => (t == null ? null : new Date(t).toISOString());

  // Who owns the station (or the repeater) a finding is about — the owner on
  // the station, else the Bureau's SLS (Health.owner). Null for a receiver,
  // an address or the network, and while the SLS file is still on its way.
  function findingOwner(f) {
    const id = f.stationId || f.repeaterId;
    const st = id && state.data && (state.data.stations || []).find(s => s.id === id);
    const o = st && typeof Health !== 'undefined' && Health.owner ? Health.owner(st) : null;
    return o ? o.name : null;
  }

  function compactFinding(f) {
    return {
      severity: f.severity, category: f.category, kind: f.kind,
      station_id: f.stationId || null, station: f.station || null, receiver: f.host || null,
      repeater_id: f.repeaterId || null, address: f.addr || null, owner: findingOwner(f),
      title: f.title, detail: f.detail, action: f.action, since: iso(f.since), evidence: f.evidence || {},
    };
  }

  function overview(A, win) {
    const c = A.counts;
    const att = A.findings.filter(f => f.severity !== 'info');
    const infoKinds = {};
    A.findings.filter(f => f.severity === 'info').forEach(f => { infoKinds[f.kind] = (infoKinds[f.kind] || 0) + 1; });
    return {
      window: { from: iso(A.t0), to: iso(A.t1), label: win, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      counts: c,
      receivers: A.receivers.map(h => ({ receiver: h.host, readings: h.n, per_hour: Math.round(h.perHour), first: iso(h.first), last: iso(h.last), outages: h.outages.length })),
      network_events: A.netEvents.map(e => ({ from: iso(e.from), to: iso(e.to), missed: e.missed, due: e.due })),
      findings_needing_attention: att.slice(0, 70).map(compactFinding),
      findings_needing_attention_total: att.length,
      notes_by_kind: infoKinds,
    };
  }

  function stationOrError(A, id) {
    const S = A.stations.get(String(id || ''));
    if (S) return { S };
    const st = ((state.data && state.data.stations) || []).find(s => s.id === id);
    return { error: st ? `${st.name} (${id}) is on file but was not heard in the analysed window.` : `No station with id "${id}". Use find_station.` };
  }

  async function runTool(name, input) {
    const { A } = Health.state();
    if (!A) return { error: 'No analysis has run yet.' };
    const inp = input && typeof input === 'object' ? input : {};
    switch (name) {
      case 'list_findings': {
        const sev = inp.severity && inp.severity !== 'any' ? inp.severity : null;
        const cat = inp.category && inp.category !== 'any' ? inp.category : null;
        const lim = Math.max(1, Math.min(150, Number(inp.limit) || 60));
        const list = A.findings.filter(f => (!sev || f.severity === sev) && (!cat || f.category === cat));
        return { total: list.length, findings: list.slice(0, lim).map(compactFinding) };
      }
      case 'station_detail': {
        const { S, error } = stationOrError(A, inp.station_id);
        if (error) return { error };
        const st = S.st, sch = S.schedule, B = S.battery;
        const reps = A.repeaters.filter(R => R.members.includes(S)).map(R => R.name);
        let visit = null;
        try {
          const visits = await dbSelect(`inspection_chart_visit?station_id=eq.${encodeURIComponent(st.id)}&select=id,inspected_on&order=inspected_on.desc&limit=2`);
          if (visits.length) {
            const p = await dbSelect(`inspection_chart_power?inspection_id=eq.${encodeURIComponent(visits[0].id)}&select=battery_existing_v,battery_existing_v_under_load,solar_output_v,solar_charge_current_ma`);
            visit = Object.assign({ date: visits[0].inspected_on }, p[0] || {});
          } else visit = 'no visit on record';
        } catch (_) { visit = 'the inspection history did not answer'; }
        return {
          id: st.id, name: st.name, station_number: st.station_number || null, lat: st.lat, lon: st.lon,
          owner: (typeof Health !== 'undefined' && Health.owner && Health.owner(st)) || 'none on record',
          roles: st.roles, alert_ids: stationAlertIds(st), repeaters_on_file: reps, heard_by: S.paths || [...S.hosts],
          last_heard: iso(S.lastHeard), status: S.status,
          schedule: sch ? {
            period_min: sch.P / 60000, learned_from: sch.from, counts: sch.counts, miss_rate: r2(sch.missRate),
            scattered_miss_rate: r2(sch.scatteredRate), partial_rate: r2(sch.partialRate), trailing_misses: sch.trailingMisses,
            clock_drift_s_per_day: r1(sch.driftSPerDay), spells: sch.spells.map(sp => ({ from: iso(sp.from), to: iso(sp.to), checks: sp.n, still_silent: sp.open })),
            daily: sch.daily.map(d => ({ day: d.day, received: d.hit, partial: d.partial, missed: d.miss, network: d.net, unknown: d.unknown })),
            recent_slots: (S.slots || []).slice(-16).map(sl => ({ t: iso(sl.t), outcome: sl.outcome })),
          } : `no regular schedule learned from ${S.bursts.length} reports`,
          battery: B && B.latest ? {
            address: B.aid, latest_v: B.latest.V, latest_at: iso(B.latest.t), last_night_low_v: B.lastNight,
            night_lows: (B.nights || []).map(n => ({ t: iso(n.t), v: n.v })), trend_v_per_day: r2(B.slope),
            daily_swing_v: r2(B.swing), days_to_11_8_v: B.daysTo != null ? Math.round(B.daysTo) : null, spikes_left_out: B.spikes,
          } : null,
          rain: S.rain ? { address: S.rain.aid, mm: S.rain.mm, tips: S.rain.tips, mm_per_tip: S.rain.mmPerTip, bucket_recorded: S.rain.recorded,
            set_aside: { garbage: S.rain.outliers, bit_flips: S.rain.flips, jumps: S.rain.jumps }, resets: S.rain.resets,
            neighbours: (S.rainNeighbours || []).slice(0, 8) } : null,
          level: S.level ? { address: S.level.aid, readings: S.level.n, distinct_values: S.level.distinct, median_count: S.level.median, spikes: S.level.spikes, flat: S.level.flat } : null,
          sensors: S.sensors.map(x => ({ address: x.aid, kind: x.kind, types: x.types, transmissions: x.n, corrupted_copies: x.bad, ghosts: x.ghosts, last: x.last.v, last_value: x.last.conv && x.last.conv.value != null ? x.last.conv.text : null, last_at: iso(x.last.t) })),
          findings: S.findings.map(compactFinding),
          last_site_visit: visit,
        };
      }
      case 'context_at': {
        const { S, error } = stationOrError(A, inp.station_id);
        if (error) return { error };
        const t = Date.parse(inp.time);
        if (!isFinite(t)) return { error: `"${inp.time}" is not a time. Use ISO 8601.` };
        const X = HealthAnalysis.contextAt(A, S.st.id, t);
        return {
          at: iso(t), verdict: X.verdict.text, verdict_kind: X.verdict.kind,
          own_slot: X.slot ? { t: iso(X.slot.t), outcome: X.slot.outcome } : null,
          receivers: X.receivers.map(r => ({ receiver: r.host, delivering_10min_spans: r.binsWithTraffic, of: r.bins })),
          other_receivers_delivering: X.othersDelivering,
          neighbours: X.peers.map(p => ({ id: p.id, name: p.name, why: p.why, already_down: p.down, slot: p.slot ? { t: iso(p.slot.t), outcome: p.slot.outcome } : null, heard: p.heard })),
          its_transmissions: X.mine.map(m => ({ t: iso(m.t), address: m.aid, raw: m.v, corrupted_copies: m.bad.map(b => b.v) })),
          network_event: X.netEvent ? { from: iso(X.netEvent.from), to: iso(X.netEvent.to), missed: X.netEvent.missed, due: X.netEvent.due } : null,
        };
      }
      case 'station_readings': {
        const { S, error } = stationOrError(A, inp.station_id);
        if (error) return { error };
        const kind = inp.kind && inp.kind !== 'any' ? inp.kind : null;
        const lim = Math.max(1, Math.min(200, Number(inp.limit) || 60));
        const kindOf = addr => { const x = S.sensors.find(y => y.addr === addr); return x ? x.kind : null; };
        const list = S.txs.filter(tx => !kind || kindOf(tx.addr) === kind).slice(-lim).reverse();
        return { station: S.st.name, count: list.length, readings: list.map(tx => {
          const k = kindOf(tx.addr), c = SensorValues.convert(k, tx.v, S.st);
          return { t: iso(tx.t), address: tx.aid, kind: k, raw: tx.v, value: c && c.value != null ? c.text : null,
                   copies: tx.copies.length, corrupted_copies: tx.bad.map(b => ({ raw: b.x.v, bits: b.bits })) };
        }) };
      }
      case 'station_history': {
        const st = ((state.data && state.data.stations) || []).find(s => s.id === inp.station_id);
        if (!st) return { error: `No station with id "${inp.station_id}". Use find_station.` };
        const days = Math.max(1, Math.min(30, Number(inp.days) || 14));
        const ids = stationAlertIds(st).filter(a => a <= 65535);
        if (!ids.length) return { error: `${st.name} has no ALERT address on file.` };
        const t0 = Date.now() - days * 86400000;
        const kinds = new Map();
        const idx = SensorValues.index();
        ids.forEach(a => { const c = (idx.get(a) || []).find(x => x.station === st); kinds.set(a, c ? c.kind : null); });
        const rows = [];
        for (let off = 0; off < 6000; off += 1000) {
          const page = await dbSelect(`reading?alert_id=in.(${ids.join(',')})&reading_ts=gte.${encodeURIComponent(new Date(t0).toISOString())}`
            + `&select=alert_id,reading_ts,value_raw&order=reading_ts.asc,addr.asc,value_raw.asc&limit=1000&offset=${off}`);
          rows.push(...page);
          if (page.length < 1000) break;
        }
        const byDay = new Map();
        rows.forEach(r => {
          const d = new Date(r.reading_ts); const p = n => String(n).padStart(2, '0');
          const k = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}|${r.alert_id}`;
          let x = byDay.get(k);
          if (!x) byDay.set(k, x = { day: k.split('|')[0], address: r.alert_id, kind: kinds.get(r.alert_id), n: 0, min: Infinity, max: -Infinity, last: null });
          const v = Number(r.value_raw);
          x.n++; if (v < x.min) x.min = v; if (v > x.max) x.max = v; x.last = v;
        });
        const lines = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.address - b.address)).map(x => Object.assign(x,
          x.kind === 'battery' ? { min_v: r1(x.min / 10), max_v: r1(x.max / 10) } : {}));
        return { station: st.name, days, readings: rows.length, note: 'Raw counts per day per address; for a battery min_v/max_v are volts, but a corrupted copy can set a day\'s min or max — trust a run of days, not one.', daily: lines };
      }
      case 'stations_near': {
        const { S, error } = stationOrError(A, inp.station_id);
        if (error) return { error };
        const rad = Math.max(1, Math.min(150, Number(inp.radius_km) || 30));
        if (S.st.lat == null) return { error: `${S.st.name} has no position on file.` };
        const out = [...A.stations.values()].filter(P => P !== S && P.st.lat != null)
          .map(P => ({ P, d: SensorValues.km(S.st.lat, S.st.lon, P.st.lat, P.st.lon) })).filter(x => x.d <= rad)
          .sort((a, b) => a.d - b.d).slice(0, 40)
          .map(({ P, d }) => ({ id: P.st.id, name: P.st.name, km: r1(d), status: P.status, period_min: P.schedule ? P.schedule.P / 60000 : null,
                                miss_rate: P.schedule ? r2(P.schedule.missRate) : null, last_heard: iso(P.lastHeard),
                                worst: P.findings[0] ? P.findings[0].title : null }));
        return { around: S.st.name, radius_km: rad, stations: out };
      }
      case 'receivers':
        return { receivers: A.receivers.map(h => ({
          receiver: h.host, readings: h.n, per_hour: Math.round(h.perHour), first: iso(h.first), last: iso(h.last),
          outages: h.outages.map(o => ({ from: iso(o.from), to: iso(o.to) })), upload_lag_s: { p50: r1(h.lag.p50), p95: r1(h.lag.p95) },
          corrupted_copies: h.corrupted, channels: h.paths.map(p => ({ path: p.path, readings: p.n, freq_mhz: p.freq })) })) };
      case 'repeaters': {
        const lim = Math.max(1, Math.min(60, Number(inp.limit) || 25));
        return { repeaters: A.repeaters.filter(R => R.members.length).slice(0, lim).map(R => ({
          id: R.id, name: R.name, stations_heard_behind_it: R.members.length,
          silent_now: R.silent.map(S => S.st.id), corrupted_copy_blame: r1(R.blame), rate: r2(R.rate) })) };
      }
      case 'find_station': {
        const q = String(inp.query || '').trim().toLowerCase();
        if (!q) return { error: 'Say what to look for.' };
        const all = (state.data && state.data.stations) || [];
        const n = /^\d+$/.test(q) ? Number(q) : null;
        const hits = all.filter(s => String(s.name || '').toLowerCase().includes(q) || String(s.station_number || '') === q
          || (n != null && stationAlertIds(s).includes(n))).slice(0, 20);
        return { matches: hits.map(s => ({ id: s.id, name: s.name, station_number: s.station_number || null, heard_in_window: A.stations.has(s.id) })) };
      }
      default:
        return { error: `No tool called ${name}.` };
    }
  }

  // The tool's own name and the station it is looking at, for the feed.
  function toolLine(name, input) {
    const st = input && input.station_id ? (((state.data && state.data.stations) || []).find(s => s.id === input.station_id) || {}).name || input.station_id : '';
    switch (name) {
      case 'list_findings': return `Reading the findings${input && input.category && input.category !== 'any' ? ` (${input.category})` : ''}`;
      case 'station_detail': return `Looking at ${st}`;
      case 'context_at': return `What the network did around ${st} at ${input && input.time ? HealthAnalysis.fmtWhen(Date.parse(input.time)) : '?'}`;
      case 'station_readings': return `Reading ${st}'s transmissions`;
      case 'station_history': return `Fetching ${input && input.days ? input.days : 14} days of ${st}'s history`;
      case 'stations_near': return `What is happening around ${st}`;
      case 'receivers': return 'Checking the receivers';
      case 'repeaters': return 'Checking the repeaters';
      case 'find_station': return `Looking up “${(input && input.query) || ''}”`;
      default: return name;
    }
  }

  // A tool input arrives streamed and unvalidated (eager input streaming), so
  // it is checked here before anything runs on it.
  // Why a tool call cannot run as asked, or null when it can. Said back to
  // Claude in the error result, so the next call is a corrected one.
  function invalidInput(name, input) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return `No tool called ${name}. The tools are ${TOOLS.map(t => t.name).join(', ')}.`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return `${name} takes an object of named inputs.`;
    for (const k of tool.input_schema.required) if (input[k] == null || input[k] === '') return `${name} needs ${k}.`;
    for (const [k, v] of Object.entries(input)) {
      const spec = tool.input_schema.properties[k];
      if (!spec) return `${name} has no input called ${k}.`;
      if (spec.type === 'string' && typeof v !== 'string') return `${name}'s ${k} is a string.`;
      if ((spec.type === 'integer' || spec.type === 'number') && !isFinite(Number(v))) return `${name}'s ${k} is a number.`;
      if (spec.enum && !spec.enum.includes(v)) return `${name}'s ${k} is one of ${spec.enum.join(', ')}.`;
    }
    return null;
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  async function turnLoop(client, firstUser) {
    G.messages.push(firstUser);
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (G.stopped) return null;
      G.live = '';
      const notes = new Map();
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: BETAS,
        fallbacks: 'default',
        thinking: { type: 'adaptive', display: 'updates' },
        output_config: { effort: G.effort },
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: G.messages,
      });
      G.stream = stream;
      stream.on('text', delta => { G.live += delta; paintLive(); });
      stream.on('thinking', (delta, snapshot) => {
        // Progress notes between tool calls arrive as short thinking blocks.
        const k = notes.size;
        notes.set(k, snapshot);
        const last = G.feed[G.feed.length - 1];
        if (last && last.kind === 'note' && last.turn === turn && last.live) last.text = snapshot;
        else if (snapshot.trim()) G.feed.push({ kind: 'note', text: snapshot, turn, live: true });
        paintFeed();
      });
      const msg = await stream.finalMessage();
      G.stream = null;
      G.feed.forEach(f => { f.live = false; });
      const u = msg.usage || {};
      G.usage.in += u.input_tokens || 0; G.usage.out += u.output_tokens || 0;
      G.usage.cacheRead += u.cache_read_input_tokens || 0; G.usage.cacheWrite += u.cache_creation_input_tokens || 0;
      // The whole content goes back, thinking blocks and all: a thinking
      // block is bound to the turn that made it and must be returned unchanged.
      G.messages.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'refusal') {
        throw Object.assign(new Error('Claude declined to continue this conversation' + (msg.stop_details && msg.stop_details.category ? ` (${msg.stop_details.category})` : '') + '.'), { refusal: true });
      }
      if (msg.stop_reason === 'pause_turn') continue;
      const uses = msg.content.filter(b => b.type === 'tool_use');
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (msg.stop_reason === 'max_tokens') {
        // A tool call cut off mid-input is not run on what arrived of it.
        if (uses.length) throw new Error('The answer ran past its length limit in the middle of a tool call.');
        return text + '\n\n*(Cut off at the length limit.)*';
      }
      if (msg.stop_reason !== 'tool_use' || !uses.length) return text;
      const results = [];
      for (const u0 of uses) {
        if (G.stopped) return null;
        const why = invalidInput(u0.name, u0.input);
        if (why) {
          results.push({ type: 'tool_result', tool_use_id: u0.id, is_error: true, content: JSON.stringify({ error: why, INVALID_INPUT: u0.input }) });
          continue;
        }
        G.feed.push({ kind: 'tool', text: toolLine(u0.name, u0.input) });
        paintFeed();
        let out;
        try { out = await runTool(u0.name, u0.input); }
        catch (err) { out = { error: (err && err.message) || String(err) }; }
        let text = JSON.stringify(out);
        if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + '… (trimmed — ask for less)';
        results.push(Object.assign({ type: 'tool_result', tool_use_id: u0.id, content: text }, out && out.error ? { is_error: true } : {}));
      }
      // Every result of one turn in one message.
      G.messages.push({ role: 'user', content: results });
    }
    throw new Error(`Stopped after ${MAX_TURNS} rounds of tool use without an answer.`);
  }

  function errorText(err) {
    if (!err) return 'Something went wrong.';
    if (Sdk && err instanceof Sdk.APIUserAbortError || err.name === 'APIUserAbortError') return 'Stopped.';
    if (Sdk && err instanceof Sdk.AuthenticationError || err.status === 401) return 'Anthropic refused the API key. Check it, or make a new one in the Claude Console.';
    if (Sdk && err instanceof Sdk.PermissionDeniedError || err.status === 403) return 'The API key is not allowed to use this model.';
    if (Sdk && err instanceof Sdk.RateLimitError || err.status === 429) return 'Rate-limited by Anthropic — wait a minute and ask again.';
    if (Sdk && err instanceof Sdk.BadRequestError || err.status === 400) return `Anthropic rejected the request: ${err.message}`;
    if (Sdk && err instanceof Sdk.APIConnectionError || err.name === 'APIConnectionError') return 'Could not reach api.anthropic.com from this browser — a network that blocks it, or no connection.';
    if (err.status >= 500) return `Anthropic's API had a problem (${err.status}) — try again shortly.`;
    if (/import|module|Failed to fetch dynamically/i.test(String(err.message))) return 'Could not load the Anthropic SDK from cdn.jsdelivr.net — a network that blocks it, or no connection.';
    return err.message || String(err);
  }

  async function ask(question) {
    const { A, win, demo } = Health.state();
    if (!A || G.running) return;
    if (!G.key && !G.factory) { G.error = 'An Anthropic API key is needed first.'; paint(); return; }
    G.running = true; G.stopped = false; G.error = ''; G.live = '';
    const followUp = !!question && G.messages.length > 0;
    if (!followUp) { G.messages = []; G.feed = []; G.usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }; }
    G.feed.push({ kind: 'tool', text: question ? `Question: ${question}` : 'Reading the overview' });
    paint();
    const first = followUp
      ? { role: 'user', content: [{ type: 'text', text: question }, { type: 'text', text: FOLLOW_UP_NOTE }] }
      : { role: 'user', content: [
          { type: 'text', text: 'Overview of the analysed window (JSON):\n' + JSON.stringify(overview(A, win)) },
          { type: 'text', text: (demo ? 'These are demo readings: real stations, a made-up week with faults planted in it. Treat it as practice.\n' : '')
              + (question ? question + '\n\n' + FOLLOW_UP_NOTE : 'Investigate, then write the maintenance briefing.') },
        ] };
    try {
      const client = await loadClient();
      const md = await turnLoop(client, first);
      if (md != null) {
        G.answer = { md, at: Date.now(), win, demo: !!demo, question: question || null, usage: Object.assign({}, G.usage) };
        if (!question) writeStore(LAST_STORE, JSON.stringify(G.answer));
        announce('Claude\'s briefing is ready.');
      }
    } catch (err) {
      G.error = errorText(err);
      if (err && err.refusal) G.error = err.message;
    }
    if (G.stopped && !G.error) G.error = 'Stopped.';
    G.running = false; G.stream = null; G.live = '';
    paint();
  }

  function stop() {
    G.stopped = true;
    if (G.stream && G.stream.abort) { try { G.stream.abort(); } catch (_) {} }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  // The briefing's Markdown, rendered from a short list of shapes and escaped
  // everywhere else: headings, numbered and bulleted lists, paragraphs, bold,
  // code — and [[station_id]], which becomes a button that opens the station.
  function mdHtml(md) {
    const { A } = Health.state();
    const inline = s => esc(s)
      .replace(/\[\[([a-z0-9_]+)\]\]/gi, (m, id) => {
        const st = ((state.data && state.data.stations) || []).find(x => x.id === id);
        if (!st) return esc(id);
        return A && A.stations.has(id)
          ? `<button class="link-btn" onclick="Health.select('${escAttr(id)}')">${esc(st.name)}</button>`
          : `<button class="link-btn" onclick="goToStation('${escAttr(id)}')">${esc(st.name)}</button>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    String(md || '').split(/\r?\n/).forEach(line => {
      const h = line.match(/^#{1,4}\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      if (h) { close(); out.push(`<h4>${inline(h[1])}</h4>`); return; }
      if (ol) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); return; }
      if (ul) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); return; }
      if (!line.trim()) { close(); return; }
      close();
      out.push(`<p>${inline(line)}</p>`);
    });
    close();
    return out.join('');
  }

  function costText(u) {
    const usd = (u.in * PRICE.in + u.out * PRICE.out + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite) / 1e6;
    const k = n => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
    return `${k(u.in + u.cacheRead + u.cacheWrite)} tokens in (${k(u.cacheRead)} from cache), ${k(u.out)} out — about US$${usd.toFixed(2)}`;
  }

  function feedHtml() {
    if (!G.feed.length) return '';
    return `<ol class="hl-feed" aria-label="What Claude is doing">${G.feed.slice(-40).map(f => `<li class="hl-feed-${f.kind}">${
      f.kind === 'tool' ? '<span aria-hidden="true">🔎</span> ' : f.kind === 'note' ? '<span aria-hidden="true">💭</span> ' : ''}${esc(f.text)}</li>`).join('')}</ol>`;
  }

  function render() {
    restore();
    const { A } = Health.state();
    const keyed = !!G.key || !!G.factory;
    const ans = G.answer;
    return `
      <div class="panel-header"><h3 id="hl-h-agent">Ask Claude</h3>
        <span class="small">${esc(MODEL)} · reads the findings, investigates, writes the briefing</span></div>
      <p class="small">Claude gets what this tab worked out and the same views you have — a station in full, the network at a moment, a
        station's last 30 days, its neighbours, the receivers and repeaters — and decides which findings share a cause, checks the doubtful
        ones, and writes a briefing: which sites to visit first and why, what the network and the register need, and what it could not
        tell. It reads; it changes nothing. The findings and readings it looks at are sent to Anthropic's API under the key below.</p>
      <div class="hl-agent-key">
        ${G.key ? `<span class="small">Using an API key ending <span class="mono">…${esc(G.key.slice(-4))}</span>${G.remember ? ', remembered on this device' : ', for this visit only'}.</span>
            <button class="ghost" onclick="HealthAgent.forget()">Forget the key</button>`
          : G.factory ? '<span class="small">Using a test client.</span>'
          : `<label class="hl-keyfield">Anthropic API key
              <input id="hl-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" aria-describedby="hl-key-help"></label>
            <label class="hl-check"><input id="hl-key-remember" type="checkbox"> remember on this device</label>
            <button onclick="HealthAgent.setKey()">Use this key</button>
            <p id="hl-key-help" class="small">From the Claude Console (console.anthropic.com → API keys). It goes from this browser to
              api.anthropic.com and nowhere else; unticked, it is gone when the page closes. Don't tick remember on a shared computer.</p>`}
      </div>
      <div class="button-group hl-agent-run">
        <label class="small">How hard to think
          <select onchange="HealthAgent.setEffort(this.value)">
            <option value="high" ${G.effort === 'high' ? 'selected' : ''}>thorough</option>
            <option value="medium" ${G.effort === 'medium' ? 'selected' : ''}>quicker</option>
          </select></label>
        ${G.running ? '<button onclick="HealthAgent.stop()">Stop</button>'
          : `<button class="primary" onclick="HealthAgent.ask()" ${!A || !keyed ? 'disabled' : ''}>Write the briefing</button>`}
      </div>
      <div id="hl-agent-status" role="status" class="small">${G.running ? 'Working…' : G.error ? `<span class="txt-bad">${esc(G.error)}</span>` : !A ? 'The readings have to be worked out first.' : ''}</div>
      <div id="hl-agent-feed">${feedHtml()}</div>
      <div id="hl-agent-live" class="hl-brief">${G.running && G.live ? mdHtml(G.live) : ''}</div>
      ${!G.running && ans ? `
        <article class="hl-brief" aria-labelledby="hl-h-brief">
          <h4 id="hl-h-brief" class="sr-only">Claude's briefing</h4>
          <p class="small txt-muted">${ans.question ? `Asked: “${esc(ans.question)}” · ` : ''}${esc(HealthAnalysis.fmtWhen(ans.at))}${ans.demo ? ' · from the demo week' : ''}${ans.usage ? ' · ' + esc(costText(ans.usage)) : ''}</p>
          ${mdHtml(ans.md)}
          <div class="button-group"><button class="ghost" onclick="HealthAgent.copy()">Copy as text</button></div>
        </article>` : ''}
      ${G.messages.length && !G.running ? `
        <div class="hl-followup">
          <label for="hl-q" class="small">Ask a follow-up — it remembers this conversation</label>
          <div class="button-group"><input id="hl-q" type="text" placeholder="e.g. Is Upper Springbrook's silence its battery?"
            onkeydown="if (event.key === 'Enter') HealthAgent.followUp()">
          <button onclick="HealthAgent.followUp()" ${keyed ? '' : 'disabled'}>Ask</button></div>
        </div>` : ''}`;
  }

  function paint() {
    const el = document.getElementById('hl-agent');
    if (el && state.activeTab === 'health') el.innerHTML = render();
  }
  function paintFeed() {
    const el = document.getElementById('hl-agent-feed');
    if (el) el.innerHTML = feedHtml();
  }
  function paintLive() {
    const el = document.getElementById('hl-agent-live');
    if (el) el.innerHTML = mdHtml(G.live);
  }

  function setKey() {
    const el = document.getElementById('hl-key');
    const v = el ? el.value.trim() : '';
    if (!v) { G.error = 'Paste the key first.'; paint(); return; }
    G.key = v;
    G.remember = !!(document.getElementById('hl-key-remember') || {}).checked;
    writeStore(KEY_STORE, G.remember ? v : null);
    G.error = '';
    paint();
  }
  function forget() { G.key = ''; G.remember = false; writeStore(KEY_STORE, null); paint(); }
  function setEffort(v) { G.effort = v === 'medium' ? 'medium' : 'high'; writeStore(EFFORT_STORE, G.effort); }
  function followUp() {
    const el = document.getElementById('hl-q');
    const q = el ? el.value.trim() : '';
    if (q) ask(q);
  }
  function copy() {
    if (!G.answer) return;
    const done = () => announce('Briefing copied.');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(G.answer.md).then(done, () => {});
  }

  // A new set of readings: a conversation about the old ones is over.
  function dataChanged() { G.messages = []; G.feed = []; paint(); }

  function init() { /* rendered with the tab; nothing to start */ }

  return {
    render, init, ask, stop, setKey, forget, setEffort, followUp, copy, dataChanged,
    // Test seams: a client factory standing in for the SDK, and the tool runner.
    _useClient(factory) { G.factory = factory; },
    _runTool: runTool, _overview: overview, _mdHtml: mdHtml, _tools: TOOLS, _system: SYSTEM,
  };
})();

if (typeof window !== 'undefined') window.HealthAgent = HealthAgent;
