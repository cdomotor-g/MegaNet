// tools/bulletin/gather.mjs — the facts a network bulletin is written from.
//
// The scheduled bulletin task (tools/bulletin/README.md) runs this first. It
// reads the network the way the Station Health tab does — the same
// health-analysis.js over the same readings, through tools/health/report.mjs,
// the file the every-fifteen-minutes workflow runs — and adds what the tab
// shows from the server: the findings' history (opened, cleared), each
// transmitter's carrier fingerprint and who sends the corrupted copies. Then
// it looks for what no one rule can see, and writes it all down as one JSON
// file of facts, with the evidence, for the writer to judge:
//
//   * silences sorted into the ones that matter — a station that kept its
//     schedule and stopped — and the ones that do not: a station far away
//     heard a few times by luck is not "silent" in the same way
//   * what the silent stations last had in common: the receiver channel they
//     were last heard on, the repeaters that pass them, whether that channel
//     kept delivering others after they stopped
//   * signal fading at each receiver, station by station, and then grouped:
//     one station fading is its own path; several behind one repeater is the
//     repeater; everything one receiver hears is the receiver
//   * carrier fingerprints: who is off the fleet, who moved, who jumped from
//     one day to the next, whose carrier vanished — and, for each, which
//     receivers measured it, because a receiver's own error looks exactly
//     like a transmitter's
//   * bit flips by who sent them, and the hours they keep
//   * the rain, for context: a storm explains a lot of things
//   * every day's numbers, for the trends
//
// No secret is needed: everything here is public, read with the publishable
// key as the page reads it. The task's Supabase connector can go further (the
// receptions one by one); README.md has the questions worth asking it.
//
// Run:  node tools/bulletin/gather.mjs --kind daily  [--out FILE] [--cache DIR] [--now ISO]
//       node tools/bulletin/gather.mjs --kind weekly …
//
// Env:  TZ, LANG   the words' times and dates — the task sets Australia/Brisbane

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAnalysis, fetchInputs, project } from '../health/report.mjs';

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const TZ = 'Australia/Brisbane';

// Who is in each bulletin. The day's Droggie presents (Brisbane's day, Sunday
// first: the New Recruit draws the weekend shift as well as Wednesday); Alex
// Chen takes the radio scenes (Graham on Alex's own day); and two more of the
// crew take a scene each as guests, in turn, so the whole crew is heard. The
// weekly is Graham's, with Alex for the radio, the Bean Counter for its numbers
// and one guest. The Bean Counter is one of the show's lesser figures (the
// owner, 25 Oct 2026): he never presents and is in no daily — one scene a week.
export const ROTA = ['new-recruit', 'seasoned-hydrographer', 'tech-wizard', 'new-recruit', 'turbo', 'nitwit', 'know-it-all'];
export const CREW = ['seasoned-hydrographer', 'tech-wizard', 'new-recruit', 'turbo', 'nitwit', 'know-it-all'];
export function presenterFor(kind, now) {
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: TZ }));
  const day = Math.floor(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / DAY);
  if (kind === 'weekly') {
    const pool = CREW.filter(id => id !== 'seasoned-hydrographer' && id !== 'tech-wizard');
    return { presenter: 'seasoned-hydrographer', cohost: 'tech-wizard', guests: ['bean-counter', pool[Math.floor(day / 7) % pool.length]] };
  }
  const presenter = ROTA[local.getDay()];
  const cohost = presenter === 'tech-wizard' ? 'seasoned-hydrographer' : 'tech-wizard';
  const pool = CREW.filter(id => id !== presenter && id !== cohost);
  return { presenter, cohost, guests: [pool[day % pool.length], pool[(day + 1) % pool.length]] };
}

// ── small helpers ────────────────────────────────────────────────────────────

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (v, dp = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const iso = t => (t == null || !Number.isFinite(t) ? null : new Date(t).toISOString());
const dayKey = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });            // YYYY-MM-DD in Brisbane
const dayLabel = t => new Date(t).toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'short' });
const hourOf = t => Number(new Date(t).toLocaleString('en-AU', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24;
const when = t => new Date(t).toLocaleString('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
// A receiver path as people say it: "rpi-83071968 stick 1, 151.5375 MHz".
export function pathParts(p) {
  const s = String(p || '').replace(/^serial-monitor\//, '');
  const m = s.match(/^(rpi-[0-9a-f]+)-(sdr\d+)(?:-(\d+\.\d+))?$/i);
  if (!m) return { host: s, stick: null, mhz: null, label: s };
  return { host: m[1], stick: m[2], mhz: m[3] ? Number(m[3]) : null, label: `${m[1]} stick ${m[2].replace(/\D/g, '')}${m[3] ? `, ${m[3]} MHz` : ''}` };
}
const theilSen = pts => {
  const s = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[j].x !== pts[i].x) s.push((pts[j].y - pts[i].y) / (pts[j].x - pts[i].x));
  return median(s);
};

// ── the facts, from an analysis and the server's tables ─────────────────────

// A: HealthAnalysis.run() over the context window; rows: what it ran over;
// doc: the register; server: what the public tables said (any may be missing);
// p0/p1: the period the bulletin is about.
export function buildFacts({ kind, A, rows, doc, server = {}, now, p0, p1, ctx0 }) {
  const reg = new Map((doc.stations || []).map(s => [s.id, s]));
  const mentioned = new Set();
  const stn = id => { if (id) mentioned.add(id); return id; };
  const inP = t => t >= p0 && t <= p1;
  const S = A.stations;

  // ── the network in numbers, day by day ──
  const days = [];
  for (let t = Date.parse(new Date(ctx0).toLocaleDateString('en-CA', { timeZone: TZ }) + 'T00:00:00+10:00'); t < p1; t += DAY) days.push(t);
  const perDay = new Map(days.map(t => [dayKey(t), { day: dayKey(t), label: dayLabel(t), due: 0, got: 0, missed: 0, readings: 0, corrupted: 0, heard: new Set(), rainStations: 0, mm: 0 }]));
  const bucket = t => perDay.get(dayKey(t));
  for (const r of rows) { const b = bucket(Date.parse(r.reading_ts)); if (b) { b.readings++; if (r.station_id) b.heard.add(r.station_id); } }
  const slotsInP = { due: 0, got: 0, missed: 0, net: 0, unknown: 0 };
  for (const s of S.values()) {
    for (const sl of s.slots || []) {
      const b = bucket(sl.t);
      const o = sl.outcome || (sl.burst ? 'hit' : 'miss');
      if (b && o !== 'unknown') { b.due++; if (o === 'hit' || o === 'partial') b.got++; if (o === 'miss') b.missed++; }
      if (inP(sl.t)) { if (o === 'unknown') slotsInP.unknown++; else { slotsInP.due++; if (o === 'hit' || o === 'partial') slotsInP.got++; if (o === 'miss') slotsInP.missed++; if (o === 'net') slotsInP.net++; } }
    }
    if (s.rain && Array.isArray(s.rain.steps)) {
      const byDay = new Map();
      for (const st of s.rain.steps) { const k = dayKey(st.t); byDay.set(k, (byDay.get(k) || 0) + (st.tips || 0) * (s.rain.mmPerTip || 0.2)); }
      for (const [k, mm] of byDay) { const b = perDay.get(k); if (b && mm >= 1) { b.rainStations++; b.mm = Math.max(b.mm, mm); } }
    }
  }
  for (const t of A.txs || []) { if (t.bad && t.bad.length) { const b = bucket(t.t); if (b) b.corrupted += t.bad.length; } }
  const series = [...perDay.values()].map(b => ({ day: b.day, label: b.label, checks_due: b.due, checks_received: b.got,
    received_pct: b.due ? round(100 * b.got / b.due, 1) : null, readings: b.readings, stations_heard: b.heard.size, corrupted: b.corrupted,
    rain_stations: b.rainStations, max_mm: round(b.mm, 1) }));

  // ── the findings: now, new in the period, and the server's history ──
  const F = A.findings;
  const sevRank = { critical: 0, warn: 1, info: 2 };
  const brief = f => ({
    id: f.id, kind: f.kind, severity: f.severity, category: f.category, title: f.title, detail: f.detail,
    station_id: stn(f.stationId || null), repeater_id: stn(f.repeaterId || null), host: f.host || null,
    since: iso(f.since), new: f.since != null && f.since >= p0, evidence: trimEvidence(f.evidence),
  });
  const attention = F.filter(f => f.severity !== 'info').sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  const counts = F.reduce((o, f) => { const k = `${f.kind}:${f.severity}`; o[k] = (o[k] || 0) + 1; return o; }, {});

  // ── silences: the ones that matter, and what they last had in common ──
  const silent = F.filter(f => f.kind === 'silent');
  const silences = silent.map(f => {
    const s = S.get(f.stationId);
    const txs = (s && s.txs) || [];
    const daysHeard = new Set(txs.map(t => dayKey(t.t))).size;
    const sch = s && s.schedule;
    const kept = sch && sch.exp ? sch.hits / sch.exp : null;
    // Regular: it kept a schedule, on several days, before it stopped. Else
    // occasional — heard by luck from far away, or a few times only.
    const regular = !!(sch && sch.exp >= 8 && kept >= 0.5 && daysHeard >= 3);
    const last = txs.length ? txs[txs.length - 1] : null;
    const lastPath = last && last.copies && last.copies[0] ? last.copies[0].path : null;
    const paths = {};
    txs.forEach(t => (t.copies || []).forEach(c => { const k = pathParts(c.path).label; paths[k] = (paths[k] || 0) + 1; }));
    const snrs = txs.slice(-12).flatMap(t => (t.copies || []).map(c => c.snr)).filter(Number.isFinite);
    return {
      station_id: stn(f.stationId), name: f.station || (s && s.st && s.st.name) || f.stationId, severity: f.severity, title: f.title,
      strip: s && s.slots ? s.slots.filter(sl => inP(sl.t)).map(sl => ({ hit: 'H', partial: 'P', miss: 'M', net: 'N', unknown: 'U' }[sl.outcome] || 'M')).join('').slice(-96) : '',
      regular, days_heard: daysHeard, transmissions: txs.length, period_min: sch ? Math.round(sch.P / MIN) : null, kept: round(kept, 2),
      last_heard: iso(s && s.lastHeard), last_path: lastPath ? pathParts(lastPath).label : null,
      paths, last_snr_db: round(median(snrs), 1),
      repeaters: repeatersOf(A, f.stationId),
    };
  });
  // What the regular silences share: the channel they were last heard on, and
  // whether that channel went on delivering others after they stopped.
  const lastOnPath = new Map();
  for (const t of A.txs || []) for (const c of t.copies || []) { const k = pathParts(c.path).label; const v = lastOnPath.get(k); if (!v || t.t > v) lastOnPath.set(k, t.t); }
  const groups = {};
  silences.filter(x => x.regular && x.last_path).forEach(x => { (groups[x.last_path] ||= []).push(x); });
  const silentByPath = Object.entries(groups).map(([p, xs]) => {
    const lastStop = Math.max(...xs.map(x => Date.parse(x.last_heard)));
    const chanLast = lastOnPath.get(p) || null;
    return { path: p, stations: xs.map(x => x.station_id), first_stop: iso(Math.min(...xs.map(x => Date.parse(x.last_heard)))), last_stop: iso(lastStop),
      channel_last_delivered: iso(chanLast), channel_kept_delivering: chanLast != null && chanLast > lastStop + 30 * MIN };
  }).sort((a, b) => b.stations.length - a.stations.length);

  // ── groups the analysis already made: repeaters and areas gone quiet ──
  const areas = F.filter(f => ['area-silence', 'repeater-down', 'shared-spell'].includes(f.kind)).map(f => {
    const ids = (f.evidence && f.evidence.stations) || [];
    const pts = ids.map(id => reg.get(id)).filter(s => s && Number.isFinite(+s.lat));
    const lat = median(pts.map(s => +s.lat)), lon = median(pts.map(s => +s.lon));
    const km = pts.length ? Math.max(5, ...pts.map(s => distKm(lat, lon, +s.lat, +s.lon))) : null;
    ids.forEach(stn);
    return { kind: f.kind, severity: f.severity, title: f.title, detail: f.detail, since: iso(f.since), stations: ids,
      repeater_id: stn(f.repeaterId || null), centre: lat != null ? { lat: round(lat, 4), lon: round(lon, 4), km: round(km, 0) } : null, evidence: trimEvidence(f.evidence) };
  });

  // ── batteries: every one heard, the ones going somewhere first ──
  const batteries = [];
  for (const s of S.values()) {
    const bt = s.battery;
    if (!bt || !bt.nights || !bt.nights.length) continue;
    const nights = bt.nights.map(n => n.v);
    const slope = bt.slope != null ? bt.slope : theilSen(bt.nights.map(n => ({ x: n.t / DAY, y: n.v })));
    const fs = (s.findings || []).filter(f => f.category === 'power');
    const worst = fs.sort((a, b) => sevRank[a.severity] - sevRank[b.severity])[0];
    if (!worst && !(slope <= -0.03) && !(bt.lastNight <= 12.3)) continue;
    batteries.push({ station_id: stn(s.st.id), name: s.st.name, last_night_v: bt.lastNight, latest_v: bt.latest && bt.latest.V, swing_v: round(bt.swing, 2),
      slope_v_per_night: round(slope, 3), days_to_11_8: bt.daysTo != null ? round(bt.daysTo, 1) : null, nights: nights.slice(-10),
      finding: worst ? { kind: worst.kind, severity: worst.severity, title: worst.title } : null });
  }
  batteries.sort((a, b) => (a.finding ? sevRank[a.finding.severity] : 3) - (b.finding ? sevRank[b.finding.severity] : 3) || (a.last_night_v || 99) - (b.last_night_v || 99));

  // ── check strips for the period, the stations worth showing ──
  const strip = s => (s.slots || []).filter(sl => inP(sl.t)).map(sl => ({ hit: 'H', partial: 'P', miss: 'M', net: 'N', unknown: 'U' }[sl.outcome] || (sl.burst ? 'H' : 'M'))).join('').slice(-96);
  const checkKinds = new Set(['silent', 'missed-rising', 'missed-checks', 'partial-checks']);
  const checks = [...S.values()].filter(s => s.schedule && (s.findings || []).some(f => checkKinds.has(f.kind) && f.severity !== 'info'))
    .map(s => {
      const st = strip(s), due = [...st].filter(c => c !== 'U').length, got = [...st].filter(c => c === 'H' || c === 'P').length;
      const f = (s.findings || []).filter(f => checkKinds.has(f.kind)).sort((a, b) => sevRank[a.severity] - sevRank[b.severity])[0];
      return { station_id: stn(s.st.id), name: s.st.name, strip: st, rate: due ? round(got / due, 2) : null, period_min: Math.round(s.schedule.P / MIN), finding: f ? { kind: f.kind, severity: f.severity, title: f.title } : null };
    }).filter(x => x.strip.length).sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1)).slice(0, 30);

  // ── receivers: hour by hour across the period, per stick ──
  // A logger posting its own readings (MQTT, HTTP) is not a receiver: it is
  // counted apart, and the radio receivers are what this is about.
  const hours = Math.round((p1 - p0) / HOUR);
  const sticks = new Map(), loggers = new Map(), channelsAll = new Map();
  const BLOCK = 6 * HOUR;
  for (const r of rows) {
    const t = Date.parse(r.reading_ts);
    const pp = pathParts(r.path), key = pp.stick ? `${pp.host} stick ${pp.stick.replace(/\D/g, '')}` : pp.host;
    if (!/^rpi-/.test(pp.host)) {
      if (inP(t)) { const k = String(r.path).replace(/\/logger\/.*$/, '').replace(/^meganet\/v1\//, ''); loggers.set(k, (loggers.get(k) || 0) + 1); }
      continue;
    }
    let o = sticks.get(key);
    if (!o) sticks.set(key, o = { name: key, bins: new Map(), n: 0, lag: [], snr: [], channels: {}, blocks: new Map() });
    // The upload lag across the whole context, six hours at a time: when it
    // changed is as telling as what it is.
    const lagAll = (Date.parse(r.received_at) - t) / 1000;
    if (Number.isFinite(lagAll)) { const bk = Math.floor(t / BLOCK) * BLOCK; let bl = o.blocks.get(bk); if (!bl) o.blocks.set(bk, bl = { lag: [], n: 0 }); bl.lag.push(lagAll); bl.n++; }
    // Each channel's readings hour by hour over the whole context, for "how
    // much of its usual" — a receiver can be up every hour and still hear
    // a third of what it did.
    if (pp.mhz || pp.stick) {
      const ck = `${key}${pp.mhz ? ` · ${pp.mhz.toFixed(pp.mhz * 1000 % 10 ? 4 : 3)} MHz` : ' · main'}`;
      let ch = channelsAll.get(ck);
      if (!ch) channelsAll.set(ck, ch = { name: ck, hours: new Map() });
      const hh = Math.floor(t / HOUR);
      ch.hours.set(hh, (ch.hours.get(hh) || 0) + 1);
    }
    if (!inP(t)) continue;
    o.n++;
    const h = Math.floor((t - p0) / HOUR), b10 = Math.floor((t - p0) / (10 * MIN));
    o.bins.set(h, (o.bins.get(h) || new Set()).add(b10));
    const lag = (Date.parse(r.received_at) - t) / 1000; if (Number.isFinite(lag)) o.lag.push(lag);
    if (Number.isFinite(r.snr_db)) o.snr.push(r.snr_db);
    if (pp.mhz) o.channels[pp.mhz] = (o.channels[pp.mhz] || 0) + 1;
  }
  const receivers = [...sticks.values()].map(o => ({
    name: o.name, readings: o.n, channels: o.channels,
    up: Array.from({ length: hours }, (_, h) => round((o.bins.get(h) ? o.bins.get(h).size : 0) / 6, 2)),
    lag_s_p50: round(median(o.lag), 1), snr_db_p50: round(median(o.snr), 1),
    lag_by_6h: [...o.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([t, bl]) => ({ from: when(t), readings: bl.n, lag_s_p50: round(median(bl.lag), 0) })),
  })).filter(o => o.readings > 0).sort((a, b) => a.name.localeCompare(b.name));
  // Per channel: readings an hour in the period as a share of that channel's
  // median hour while it was being listened to (hours with none after it
  // was first heard count as zero) — capped at 1.
  const h0 = Math.floor(p0 / HOUR), h1 = Math.floor(p1 / HOUR);
  const channels = [...channelsAll.values()].map(ch => {
    const hs = [...ch.hours.keys()];
    const first = Math.min(...hs), last = Math.max(...hs);
    const counts = [];
    for (let h = first; h <= last; h++) counts.push(ch.hours.get(h) || 0);
    const usual = median(counts.filter(v => v > 0));
    const inPeriod = [];
    for (let h = h0; h < h1; h++) inPeriod.push(h < first ? null : ch.hours.get(h) || 0);
    const n = inPeriod.reduce((a, v) => a + (v || 0), 0);
    return { name: ch.name, readings: n, usual_per_hour: usual, first_heard: iso(first * HOUR),
      traffic: inPeriod.map(v => (v == null || !usual ? null : round(Math.min(1, v / usual), 2))),
      per_hour: inPeriod };
  }).filter(c => c.readings >= 100).sort((a, b) => b.readings - a.readings);
  const receiverFindings = F.filter(f => f.category === 'network' && /receiver|upload|clock|net-miss/.test(f.kind)).map(brief);

  // ── signal fading: station by station at each stick, then grouped ──
  const fade = signalFade(A, rows, p0, ctx0, reg);
  fade.stations.forEach(x => stn(x.station_id));

  // ── carrier fingerprints ──
  const carrier = carrierFacts(server.transmitters, server.transmitterFindings, p0, p1, reg);
  carrier.notable.forEach(x => stn(x.station_id));

  // ── bit flips, by who sent them ──
  const flips = flipFacts(server.flipSummary, server.flipSources, reg);
  flips.senders.forEach(x => stn(x.station_id));

  // ── rain in the period, for context ──
  const rain = [];
  for (const s of S.values()) {
    if (!s.rain || !Array.isArray(s.rain.steps)) continue;
    const mm = s.rain.steps.filter(st => inP(st.t)).reduce((n, st) => n + (st.tips || 0), 0) * (s.rain.mmPerTip || 0.2);
    if (mm >= 1) rain.push({ station_id: s.st.id, name: s.st.name, mm: round(mm, 1), lat: +s.st.lat, lon: +s.st.lon });
  }
  rain.sort((a, b) => b.mm - a.mm);
  rain.slice(0, 8).forEach(x => stn(x.station_id));

  // ── the server's findings: opened and cleared in the period ──
  const hist = server.findings || [];
  // A finding the server cleared is not always good news: a station that
  // rolled out of its week is cleared too. Heard again is a reading after it.
  const lastRead = new Map();
  for (const r of rows) { if (!r.station_id) continue; const t = Date.parse(r.reading_ts); if (!(lastRead.get(r.station_id) > t)) lastRead.set(r.station_id, t); }
  const heardAfter = f => (f.station_id && f.cleared_at ? (lastRead.get(f.station_id) || 0) >= Date.parse(f.cleared_at) - 20 * MIN : null);
  const opened = hist.filter(f => Date.parse(f.first_seen) >= p0).map(f => ({ source: f.source, kind: f.kind, severity: f.severity, title: f.title, station_id: stn(f.station_id), first_seen: f.first_seen, cleared_at: f.cleared_at }));
  const cleared = hist.filter(f => f.cleared_at && Date.parse(f.cleared_at) >= p0).map(f => ({ source: f.source, kind: f.kind, severity: f.severity, title: f.title, station_id: f.station_id, first_seen: f.first_seen, cleared_at: f.cleared_at, heard_again: heardAfter(f) }));
  const backOnAir = cleared.filter(f => f.kind === 'silent' && f.severity !== 'info' && f.heard_again).map(f => stn(f.station_id));

  attention.slice(0, 80).forEach(f => { stn(f.stationId); stn(f.repeaterId); });
  const stations = {};
  for (const id of mentioned) {
    const s = reg.get(id);
    if (!s) continue;
    stations[id] = { name: s.name, lat: s.lat != null ? +s.lat : null, lon: s.lon != null ? +s.lon : null, roles: s.roles || [], basin: s.basin || null, number: s.station_number || null };
  }

  const prevSeries = series.filter(x => Date.parse(x.day + 'T12:00:00+10:00') < p0);
  return {
    format: 'floodnet-bulletin-facts/1', kind, gathered_at: iso(now),
    period: { from: iso(p0), to: iso(p1), label: periodLabel(kind, p0, p1) },
    context: { from: iso(ctx0), to: iso(p1), days: Math.round((p1 - ctx0) / DAY) },
    ...presenterFor(kind, now),
    network: {
      readings_in_context: rows.length, stations_heard_in_context: A.counts.stationsHeard,
      readings_in_period: rows.filter(r => inP(Date.parse(r.reading_ts))).length,
      stations_heard_in_period: new Set(rows.filter(r => inP(Date.parse(r.reading_ts)) && r.station_id).map(r => r.station_id)).size,
      checks_in_period: slotsInP, received_pct_in_period: slotsInP.due ? round(100 * slotsInP.got / slotsInP.due, 1) : null,
      received_pct_before: (() => { const due = prevSeries.reduce((n, x) => n + x.checks_due, 0), got = prevSeries.reduce((n, x) => n + x.checks_received, 0); return due ? round(100 * got / due, 1) : null; })(),
      corrupted_in_context: A.counts.corrupted, ghosts_in_context: A.counts.ghosts,
      findings_attention: attention.length, finding_counts: counts,
      server_last_looked: server.refresh || null,
    },
    series,
    findings: attention.slice(0, 80).map(brief),
    silences: { regular: silences.filter(x => x.regular), occasional_count: silences.filter(x => !x.regular).length,
      occasional_sample: silences.filter(x => !x.regular).slice(0, 10).map(x => ({ station_id: x.station_id, name: x.name, days_heard: x.days_heard, transmissions: x.transmissions, last_path: x.last_path })),
      by_last_path: silentByPath },
    areas, batteries: batteries.slice(0, 20), checks, receivers, receiver_findings: receiverFindings,
    loggers: Object.fromEntries(loggers), channels,
    signal: fade, carrier, flips, rain: { stations_with_rain: rain.length, top: rain.slice(0, 8) },
    server_findings: { opened: opened.slice(0, 60), opened_count: opened.length, cleared: cleared.slice(0, 60), cleared_count: cleared.length,
      opened_attention: opened.filter(f => f.severity !== 'info').length, cleared_attention: cleared.filter(f => f.severity !== 'info').length,
      back_on_air: backOnAir },
    stations,
    known_ids: [...reg.keys()],
  };
}

function trimEvidence(ev) {
  if (!ev || typeof ev !== 'object') return ev || null;
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (Array.isArray(v) && v.length > 24) { out[k] = v.slice(0, 24); out[k + 'Total'] = v.length; }
    else out[k] = v;
  }
  return out;
}
function distKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function repeatersOf(A, id) {
  return (A.repeaters || []).filter(R => (R.members || []).some(m => m.st && m.st.id === id)).map(R => R.id);
}
function periodLabel(kind, p0, p1) {
  const end = new Date(p1).toLocaleString('en-AU', { timeZone: TZ, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/:00/, '').replace(/\s?([ap])\.?m\.?/i, ' $1m');
  if (kind === 'weekly') {
    const a = new Date(p0).toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' });
    const b = new Date(p1).toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' });
    return `The seven days ${a} to ${b}`;
  }
  return `24 hours to ${end.replace(/^(\w+) (.*)$/, '$2 $1')}`;
}

// Signal fading. For every station heard on a stick in the period and on at
// least two days before it, the median SNR of its bursts in the period
// against the median of the days before. A burst a repeater relayed is the
// repeater's signal, not the station's — so a drop at every station behind
// one repeater is the repeater, and a drop at everything one stick hears is
// the stick (its antenna, its cable, its gain). Grouped here; judged by the
// writer.
export function signalFade(A, rows, p0, ctx0, reg) {
  const by = new Map();
  for (const r of rows) {
    if (!r.station_id || !Number.isFinite(r.snr_db)) continue;
    const pp = pathParts(r.path), stick = pp.stick ? `${pp.host} stick ${pp.stick.replace(/\D/g, '')}` : pp.host;
    const k = `${r.station_id}|${stick}`;
    let o = by.get(k);
    if (!o) by.set(k, o = { station_id: r.station_id, stick, before: [], during: [], days: new Set() });
    const t = Date.parse(r.reading_ts);
    if (t >= p0) o.during.push(r.snr_db); else { o.before.push(r.snr_db); o.days.add(dayKey(t)); }
  }
  const all = [];
  for (const o of by.values()) {
    if (o.during.length < 6 || o.before.length < 12 || o.days.size < 2) continue;
    const b = median(o.before), d = median(o.during);
    all.push({ station_id: o.station_id, name: (reg.get(o.station_id) || {}).name || o.station_id, stick: o.stick, before_db: round(b, 1), now_db: round(d, 1), change_db: round(d - b, 1), n: o.during.length });
  }
  const perStick = {};
  all.forEach(x => { (perStick[x.stick] ||= []).push(x.change_db); });
  const sticks = Object.entries(perStick).map(([stick, ch]) => ({ stick, stations: ch.length, median_change_db: round(median(ch), 1),
    falling_4db: ch.filter(c => c <= -4).length, rising_4db: ch.filter(c => c >= 4).length }));
  // Each station's change against its stick's median change: what the stick
  // itself did is taken out before a station is called fading.
  const stickMed = Object.fromEntries(sticks.map(s => [s.stick, s.median_change_db || 0]));
  const fading = all.map(x => ({ ...x, relative_db: round(x.change_db - stickMed[x.stick], 1) })).filter(x => x.relative_db <= -4).sort((a, b) => a.relative_db - b.relative_db);
  const reps = (A.repeaters || []).map(R => {
    const ids = new Set((R.members || []).map(m => m.st && m.st.id).filter(Boolean));
    const mine = all.filter(x => ids.has(x.station_id)).map(x => x.change_db - stickMed[x.stick]);
    const down = mine.filter(c => c <= -4).length;
    return { repeater_id: R.id, name: R.name, measured: mine.length, fading: down, median_relative_db: round(median(mine), 1) };
  }).filter(r => r.measured >= 3 && r.fading >= 3 && r.fading / r.measured >= 0.5).sort((a, b) => b.fading - a.fading);
  return { sticks, stations: fading.slice(0, 15), repeaters: reps.slice(0, 6) };
}

// Carrier fingerprints, from meganet.transmitter_summary (0077): each
// transmitter's last week against the fleet, its thirty days before, and its
// days one by one.
export function carrierFacts(txs, txFindings, p0, p1, reg) {
  const list = Array.isArray(txs) ? txs : [];
  const fleet = list.filter(t => t.w_days >= 1 && Number.isFinite(t.w_ppm)).map(t => round(t.w_ppm, 2));
  const name = t => (t.station_id && reg.get(t.station_id) ? reg.get(t.station_id).name : t.tx);
  const pDay = dayKey(p0);
  const row = (t, why) => ({ tx: t.tx, station_id: t.station_id || null, name: name(t), kind: t.protocol === 'alert2' ? 'alert2' : t.via === 'repeater' ? 'repeater' : 'station',
    w_ppm: round(t.w_ppm, 2), w_hz: round(t.w_hz, 0), w_days: t.w_days, b_ppm: round(t.b_ppm, 2), change_ppm: round(t.change_ppm, 2),
    bursts: t.bursts, receivers: t.receivers, freq_mhz: t.freq_mhz, days: t.days, ppm: t.ppm, why });
  const notable = [];
  const seen = new Set();
  const add = (t, why) => { if (seen.has(t.tx)) { notable.find(x => x.tx === t.tx).why += `; ${why}`; return; } seen.add(t.tx); notable.push(row(t, why)); };
  for (const t of list) {
    if (Math.abs(t.w_ppm) >= 2 && t.w_days >= 1) add(t, `${round(t.w_ppm, 1)} ppm from the fleet over ${t.w_days} day${t.w_days === 1 ? '' : 's'}`);
    if (t.change_ppm != null && Math.abs(t.change_ppm) >= 0.6) add(t, `moved ${round(t.change_ppm, 1)} ppm against its thirty days before`);
    const ppm = Array.isArray(t.ppm) ? t.ppm : [];
    for (let i = 1; i < ppm.length; i++) {
      if (ppm[i] != null && ppm[i - 1] != null && Math.abs(ppm[i] - ppm[i - 1]) >= 0.8 && t.days[i] >= pDay) add(t, `jumped ${round(ppm[i] - ppm[i - 1], 1)} ppm between ${t.days[i - 1]} and ${t.days[i]}`);
    }
    if (Array.isArray(t.days) && t.days.length && t.days[0] >= pDay && t.days.length === 1) add(t, 'first measured in this period');
  }
  // A carrier that vanished: measured most days before the period, not in it.
  const before = d => d < pDay;
  for (const t of list) {
    const ds = t.days || [];
    if (ds.filter(before).length >= 3 && !ds.some(d => d >= pDay)) add(t, `measured on ${ds.length} days before, none in this period — its carrier has not been heard`);
  }
  // Spread out in the open, so the writer can see a family of outliers for
  // what it is: one receiver, or one frequency.
  const offFleet = notable.filter(x => Math.abs(x.w_ppm) >= 2);
  const byFreq = {};
  offFleet.forEach(x => { const k = String(x.freq_mhz); (byFreq[k] ||= []).push(x.tx); });
  return {
    transmitters: list.length, fleet,
    fleet_spread_ppm: { p10: round(quant(fleet, 0.1), 2), p50: round(quant(fleet, 0.5), 2), p90: round(quant(fleet, 0.9), 2) },
    notable: notable.sort((a, b) => Math.abs(b.w_ppm) - Math.abs(a.w_ppm)).slice(0, 25),
    off_fleet_by_channel: byFreq,
    findings: (Array.isArray(txFindings) ? txFindings : []).map(f => ({ kind: f.kind, severity: f.severity, title: f.title, station_id: f.station_id, subject: f.subject, first_seen: f.first_seen })),
  };
}
function quant(a, q) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

// Bit flips by who sent them (0078, 0079): each transmitter's clear corrupted
// copies, and the network's week by hour and by day.
export function flipFacts(summary, sources, reg) {
  const rows = Array.isArray(summary) ? summary : [];
  const name = t => (t.station_id && reg.get(t.station_id) ? reg.get(t.station_id).name : t.tx);
  const senders = rows.filter(t => t.clear >= 3).sort((a, b) => b.clear - a.clear).slice(0, 12).map(t => ({
    tx: t.tx, station_id: t.station_id, name: name(t), bursts: t.bursts, flips: t.flips, clear: t.clear, clear_rate: round(t.clear_rate, 4),
    clean_upstream: t.clean_upstream, addr_flips: t.addr_flips, top: (t.top || []).slice(0, 4) }));
  const week = (Array.isArray(sources) ? sources : []).find(r => r.period_days === 7);
  const d = week && week.data;
  let hours = null;
  if (d && Array.isArray(d.hours)) {
    const total = d.hours.reduce((n, v) => n + v, 0) || 1;
    let best = { from: 0, share: 0 };
    for (let h = 0; h < 24; h++) { const s = [0, 1, 2, 3].reduce((n, k) => n + d.hours[(h + k) % 24], 0) / total; if (s > best.share) best = { from: h, share: s }; }
    hours = { by_hour: d.hours, busiest_four_hours_from: best.from, busiest_four_hours_share: round(best.share, 2) };
  }
  return {
    senders,
    week: d ? { heard: d.heard, corrupted: d.corrupted, by_how: d.by_how, per_day: d.per_day, hours,
      suspects: (d.candidates || []).slice(0, 8).map(c => ({ station_id: c.rid, name: c.name, blame: round(c.blame, 1), carried: c.carried, rate: round(c.rate, 4), by_carrier: c.by_carrier, clear: c.clear, only_it: c.only_it, lat: c.lat, lon: c.lon })),
      top_addresses: (d.stations || []).slice(0, 8).map(s => ({ addr: s.addr, station_id: s.station_id, n: s.n, addr_flips: s.addr_flips, senders: s.senders, candidates: s.candidates })) } : null,
  };
}

// ── the database ─────────────────────────────────────────────────────────────

async function json(fetch, url, head) {
  const res = await fetch(url, { headers: head });
  if (!res.ok) { const body = await res.text().catch(() => ''); const e = new Error(`${url.replace(/\?.*/, '')}: ${res.status} ${body.slice(0, 200)}`); e.status = res.status; throw e; }
  return res.json();
}
export async function fetchServer(fetch, { url, key, p0, log = () => {} }) {
  const head = { apikey: key, 'Accept-Profile': 'meganet' };
  const since = encodeURIComponent(new Date(p0).toISOString());
  const ask = async (what, q) => { try { return await json(fetch, `${url}/rest/v1/${q}`, head); } catch (err) { log(`  (${what} not read: ${err.message})`); return null; } };
  const [findings, transmitters, flipSummary, flipSources, refresh] = await Promise.all([
    ask('findings', `health_finding?select=source,kind,severity,title,station_id,subject,first_seen,last_seen,cleared_at&or=(first_seen.gte.${since},cleared_at.gte.${since},cleared_at.is.null)&limit=3000`),
    ask('transmitters', 'transmitter_summary?select=*'),
    ask('flip summary', 'flip_summary?select=*'),
    ask('flip sources', 'flip_sources?select=period_days,data'),
    ask('health refresh', 'health_refresh?select=source,at'),
  ]);
  return { findings: findings || [], transmitters: transmitters || [], transmitterFindings: (findings || []).filter(f => f.source === 'transmitters' && !f.cleared_at),
           flipSummary: flipSummary || [], flipSources: flipSources || [], refresh: refresh || [] };
}

export async function gather({ fetch = globalThis.fetch, kind = 'daily', now = Date.now(), cache = null, log = console.error } = {}) {
  const api = loadAnalysis();
  const span = kind === 'weekly' ? 7 * DAY : DAY;
  const ctxDays = kind === 'weekly' ? 14 : 7;
  const { url, publishable } = project();
  const p1 = now, p0 = now - span, ctx0 = now - ctxDays * DAY;
  log(`Reading ${ctxDays} days of readings and the register…`);
  const { doc, rows, capped } = await fetchInputs(fetch, { url, key: publishable, t0: ctx0, t1: now, log, cache, now });
  log(`Working them out…`);
  api.setRegister(doc);
  const A = api.HealthAnalysis.run(rows, { t0: ctx0, t1: now, now, stations: doc.stations || [] });
  log(`Asking the server for its findings, fingerprints and flips…`);
  const server = await fetchServer(fetch, { url, key: publishable, p0, log });
  const facts = buildFacts({ kind, A, rows, doc, server, now, p0, p1, ctx0 });
  if (capped) facts.network.capped = true;
  return facts;
}

// The facts, said briefly, for the person (or the agent) reading the log.
export function summary(f) {
  const n = f.network, L = [];
  L.push(`${f.kind === 'weekly' ? 'Weekly' : 'Daily'} facts — ${f.period.label}. Presenter: ${f.presenter} (co-host ${f.cohost}; guests ${(f.guests || []).join(' and ') || 'none'}).`);
  L.push(`${n.readings_in_period.toLocaleString()} readings and ${n.stations_heard_in_period} stations heard in the period; checks received ${n.received_pct_in_period}% (before: ${n.received_pct_before}%).`);
  L.push(`${n.findings_attention} findings need attention; ${f.server_findings.opened_count} opened and ${f.server_findings.cleared_count} cleared on the server in the period.`);
  L.push(`Silences: ${f.silences.regular.length} regular, ${f.silences.occasional_count} occasional (heard by luck, not missing).`);
  f.silences.by_last_path.slice(0, 4).forEach(g => L.push(`  ${g.stations.length} last heard on ${g.path}, stopping ${when(Date.parse(g.first_stop))}–${when(Date.parse(g.last_stop))}; the channel ${g.channel_kept_delivering ? 'kept delivering others' : 'stopped too'}.`));
  f.areas.slice(0, 5).forEach(a => L.push(`  group: ${a.title}`));
  f.batteries.slice(0, 5).forEach(b => L.push(`  battery: ${b.name} ${b.last_night_v} V, ${b.slope_v_per_night} V/night${b.finding ? ` — ${b.finding.title}` : ''}`));
  f.signal.repeaters.forEach(r => L.push(`  signal: ${r.fading} of ${r.measured} stations behind ${r.name} fading (${r.median_relative_db} dB)`));
  f.signal.sticks.forEach(s => L.push(`  signal at ${s.stick}: median change ${s.median_change_db} dB over ${s.stations} stations`));
  f.carrier.notable.slice(0, 6).forEach(c => L.push(`  carrier: ${c.name} — ${c.why}`));
  f.flips.senders.slice(0, 4).forEach(s => L.push(`  flips: ${s.name} sent ${s.clear} clear corrupted copies (${(100 * s.clear_rate).toFixed(1)}%)`));
  if (f.rain.stations_with_rain) L.push(`  rain: ${f.rain.stations_with_rain} gauges, most ${f.rain.top[0].mm} mm at ${f.rain.top[0].name}`);
  return L.join('\n');
}

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const kind = arg('--kind') || 'daily';
  if (!['daily', 'weekly'].includes(kind)) throw new Error('--kind daily or --kind weekly');
  const now = arg('--now') ? Date.parse(arg('--now')) : Date.now();
  const facts = await gather({ kind, now, cache: arg('--cache') });
  const out = arg('--out');
  const text = JSON.stringify(facts, null, 1);
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, text); console.error(`Facts written to ${out} (${(text.length / 1024).toFixed(0)} KB).`); }
  else process.stdout.write(text);
  console.error('\n' + summary(facts));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => { console.error(err.stack || err.message || err); process.exit(1); });
}
