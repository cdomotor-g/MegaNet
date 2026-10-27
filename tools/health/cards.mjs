// tools/health/cards.mjs — each station as the Station Health tab shows it
// when it is opened, kept by the database for the agent API (0085).
//
// Why this exists. The tab's station view — its findings with their evidence
// and what to do, its learned check schedule slot by slot, its battery's night
// lows trended — is worked out in the browser and was nowhere else. The agent
// API's GET /api/v1/stations/{id}/health and GET /api/v1/health/findings serve
// it to field apps (a field team planning a run, and on arrival), and the
// Worker cannot work it out: the analysis of a week takes seconds of CPU, and
// it needs the whole network's readings to know whether a station's receivers
// were listening. So tools/health/report.mjs, which already runs the analysis
// every fifteen minutes, writes down what it worked out: one card per station
// heard, for each of the tab's windows (3, 7 and 14 days), reported to
// meganet.report_station_cards().
//
// Nothing here judges anything. A card is health-analysis.js' own result for
// one station, put into words and numbers a program can read: its findings
// exactly as the tab lists them (same ids, severities, titles, details and
// actions), the schedule's counts day by day, the battery's night lows. The
// rules stay in health-analysis.js, in one place.
//
// The shape (CARD_VERSION 1), every time ISO 8601, every date a day in the
// run's own zone (the workflow's TZ, Australia/Brisbane):
//
//   { v, station_id, name, station_number, status, last_heard_at, heard_by,
//     findings: [{ id, kind, category, severity, about, title, detail, action,
//                  since, cause, evidence }],
//     schedule: { every_minutes, learned_from, tolerance_s, slot_times,
//                 next_due_at, sensors_per_check, checks: { due, received,
//                 incomplete, missed, missed_network_wide, unknown },
//                 received_share, miss_rate, scattered_miss_rate,
//                 trailing_misses, clock: { offset_s, drift_s_per_day },
//                 daily: [{ date, received, incomplete, missed,
//                           missed_network_wide, unknown }],
//                 spells: [{ from, to, checks, open }] } | null,
//     battery:  { address, alert_id, latest: { at, v }, last_night_low_v,
//                 min_v, max_v, night_lows: [{ at, v }], day_highs: [{ at, v }],
//                 trend_v_per_day, days_to_critical, daily_swing_v, flat,
//                 spikes_set_aside } | null }
//
// test/healthreport.mjs holds it to the demo week; worker/api.js reads it.

export const CARD_VERSION = 1;
// The Station Health tab's windows (health.js WINDOWS): what the cards are
// worked out over, and what the API's `days` takes.
export const CARD_WINDOWS = Object.freeze([3, 7, 14]);
// The database takes a card of at most this (0085); one is 2–4 KB.
export const CARD_MAX_BYTES = 32768;

const MIN = 60000, DAY = 86400000;
const SEV_RANK = { critical: 0, warn: 1, info: 2 };
// A group's list of stations, cut to this many in a card (the total kept).
const LIST_MAX = 20;
// Evidence keys that carry a moment as epoch milliseconds — said as ISO here.
const TIME_KEYS = new Set(['lastHeard', 'from', 'to', 'since', 't', 'at', 'first', 'last']);

const iso = t => (t != null && Number.isFinite(t) ? new Date(t).toISOString() : null);
const round = (v, dp = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// The stations a group finding names: ids, or { id, name } for not-heard.
function namedStations(f) {
  const s = f.evidence && f.evidence.stations;
  return Array.isArray(s) ? s.map(x => (x && typeof x === 'object' ? x.id : x)).filter(x => typeof x === 'string') : [];
}

// Evidence as a program reads it: moments as ISO, long lists cut to fit.
function evidenceOf(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev || {})) {
    if (TIME_KEYS.has(k) && typeof v === 'number' && v > 1e12 && v < 1e13) out[k] = iso(v);
    else if (Array.isArray(v) && v.length > LIST_MAX) { out[k] = v.slice(0, LIST_MAX); out[k + 'Total'] = v.length; }
    else out[k] = v;
  }
  return out;
}

function cardFinding(f, id) {
  const about = f.stationId === id ? 'station' : f.repeaterId === id ? 'repeater' : 'group';
  return {
    id: String(f.id),
    kind: f.kind,
    category: f.category || null,
    severity: f.severity,
    about,
    title: f.title || f.kind,
    detail: f.detail || '',
    action: f.action || null,
    since: iso(f.since),
    cause: f.cause || null,
    evidence: evidenceOf(f.evidence),
  };
}

function scheduleOf(S, now) {
  const sch = S.schedule;
  if (!sch || !sch.counts) return null;
  const c = sch.counts;
  const perDay = Math.round(DAY / sch.P);
  // The day's slots as clock times, while there are few enough to read.
  const slotTimes = [];
  if (perDay <= 24) {
    const first = sch.phase + Math.ceil((now - DAY - sch.phase) / sch.P) * sch.P;
    for (let s = first; s < first + DAY; s += sch.P) slotTimes.push(hm(s));
    slotTimes.sort();
  }
  return {
    every_minutes: sch.P / MIN,
    learned_from: sch.from || null,
    tolerance_s: Math.round(sch.tol / 1000),
    slot_times: slotTimes.length ? slotTimes : null,
    next_due_at: iso(sch.phase + Math.ceil((now - sch.phase) / sch.P) * sch.P),
    sensors_per_check: Array.isArray(sch.core) ? sch.core : [],
    checks: {
      due: c.due, received: c.hits, incomplete: c.partial, missed: c.misses,
      missed_network_wide: c.net, unknown: c.unknown,
    },
    received_share: c.due ? round((c.hits + c.partial) / c.due) : null,
    miss_rate: round(sch.missRate),
    scattered_miss_rate: round(sch.scatteredRate),
    trailing_misses: sch.trailingMisses || 0,
    clock: { offset_s: round((sch.offsetMs || 0) / 1000, 1), drift_s_per_day: round(sch.driftSPerDay, 1) },
    daily: (sch.daily || []).map(d => ({
      date: d.day, received: d.hit, incomplete: d.partial, missed: d.miss, missed_network_wide: d.net, unknown: d.unknown,
    })),
    spells: (sch.spells || []).map(sp => ({ from: iso(sp.from), to: iso(sp.to), checks: sp.n, open: !!sp.open })),
  };
}

function batteryOf(S) {
  const B = S.battery;
  if (!B) return null;
  const pt = p => ({ at: iso(p.t), v: round(p.v, 2) });
  return {
    address: B.addr || null,
    alert_id: B.aid != null ? B.aid : null,
    latest: B.latest ? { at: iso(B.latest.t), v: round(B.latest.V, 2) } : null,
    last_night_low_v: round(B.lastNight, 2),
    min_v: round(B.min, 2),
    max_v: round(B.max, 2),
    night_lows: (B.nights || []).map(pt),
    day_highs: (B.days || []).map(pt),
    trend_v_per_day: round(B.slope, 3),
    days_to_critical: round(B.daysTo, 1),
    daily_swing_v: round(B.swing, 2),
    flat: !!B.flat,
    spikes_set_aside: B.spikes || 0,
  };
}

// One card per station the analysis `A` heard, as of `now`. Each is
// { station_id, status, worst, findings, attention, card }: `worst` is the
// worst finding's severity or null, `findings` and `attention` how many there
// are and how many need attention (a warning or worse) — what the API sorts
// and filters a page of stations by without reading every card.
export function stationCards(A, { now = A.now } = {}) {
  // Each finding under every station it is about: its own, a repeater's, and
  // a group's (the stations behind a repeater, around a place).
  const byId = new Map();
  const add = (id, f) => { if (!id) return; let l = byId.get(id); if (!l) byId.set(id, l = []); if (!l.includes(f)) l.push(f); };
  for (const f of A.findings || []) {
    add(f.stationId, f);
    add(f.repeaterId, f);
    namedStations(f).forEach(id => add(id, f));
  }
  const out = [];
  for (const S of A.stations.values()) {
    const id = S.st.id;
    const findings = (byId.get(id) || []).map(f => cardFinding(f, id))
      .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.about === b.about ? 0 : a.about === 'station' ? -1 : 1));
    const card = {
      v: CARD_VERSION,
      station_id: id,
      name: S.st.name || id,
      station_number: S.st.station_number || null,
      status: S.status || null,
      last_heard_at: iso(S.lastHeard),
      heard_by: S.paths || [],
      findings,
      schedule: scheduleOf(S, now),
      battery: batteryOf(S),
    };
    out.push({
      station_id: id,
      status: card.status,
      worst: findings.length ? findings[0].severity : null,
      findings: findings.length,
      attention: findings.filter(f => f.severity !== 'info').length,
      card,
    });
  }
  return out;
}
