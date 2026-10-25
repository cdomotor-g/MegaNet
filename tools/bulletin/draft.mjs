// tools/bulletin/draft.mjs — a first draft of a bulletin, from the facts.
//
// The scheduled task's writer starts from this (tools/bulletin/README.md):
// every scene the facts can fill, in the order a bulletin usually runs, with
// the numbers already in the shapes the player draws — the fleet's
// fingerprints, the check strips, the receivers' hours — and narration that is
// correct but plain. The writer's job is the judgement the draft cannot make:
// what these findings have in common, what is new, what can wait, and saying
// it the way a person would. A draft published as it stands is a valid,
// truthful, dull bulletin; that is the floor, not the aim.
//
// Run:  node tools/bulletin/draft.mjs FACTS.json > DRAFT.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TZ = 'Australia/Brisbane';
const clip = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : (many || one + 's')}`;
const sevOf = f => (f === 'critical' ? 'critical' : f === 'warn' ? 'warn' : f === 'info' ? 'info' : 'ok');

export function draft(F) {
  const st = id => (F.stations || {})[id] || null;
  const nameOf = id => (st(id) && st(id).name) || id;
  const known = new Set(F.known_ids || []);
  const ok = id => id && known.has(id);
  const scenes = [];
  const n = F.network;
  const issue = new Date(F.gathered_at);
  const dateKey = issue.toLocaleDateString('en-CA', { timeZone: TZ });
  const weekly = F.kind === 'weekly';

  // How the network looks, in one word: by what needs a visit, not by count.
  const crit = (F.findings || []).filter(f => f.severity === 'critical').length;
  const regular = (F.silences && F.silences.regular) || [];
  const sky = crit >= 8 || regular.length >= 15 ? 'stormy' : crit >= 3 || regular.length >= 6 ? 'unsettled' : crit || regular.length ? 'patchy' : (F.findings || []).length ? 'fair' : 'clear';
  const skyLabel = { stormy: 'Stormy', unsettled: 'Unsettled', patchy: 'Patchy', fair: 'Fair', clear: 'Clear' }[sky];

  const groups = (F.silences && F.silences.by_last_path) || [];
  const headline = clip(regular.length
    ? `${plural(regular.length, 'station')} that keep a schedule went quiet${groups[0] && groups[0].stations.length >= 3 ? `, ${groups[0].stations.length} of them last heard on one channel` : ''}; ${plural(crit, 'critical finding')} in all.`
    : `${plural((F.findings || []).length, 'finding')} need attention, ${plural(crit, 'critical')}.`, 170);

  const opened = (F.server_findings || {}).opened || [], cleared = (F.server_findings || {}).cleared || [];
  const stats = [
    { label: 'stations heard', value: n.stations_heard_in_period, tone: 'neutral' },
    { label: 'checks received', value: n.received_pct_in_period == null ? '—' : Math.round(n.received_pct_in_period), unit: '%',
      ...(n.received_pct_before != null ? { was: Math.round(n.received_pct_before) } : {}),
      tone: n.received_pct_in_period >= 90 ? 'ok' : n.received_pct_in_period >= 75 ? 'warn' : 'bad' },
    // Not the server's opened and cleared: its findings open and close every
    // fifteen minutes as stations come and go, and the count says nothing.
    { label: 'quiet, keep a schedule', value: regular.length, tone: regular.length ? 'warn' : 'ok' },
    { label: 'critical findings', value: crit, tone: crit ? 'bad' : 'ok' },
  ];

  scenes.push({ type: 'title', title: weekly ? 'The week on the network' : 'Good morning', secs: 10,
    say: clip(`${weekly ? 'Here is the week on the network' : 'Good morning — here is the network for the last 24 hours'}: ${skyLabel.toLowerCase()}. ${headline}`, 400) });

  // The map: who went quiet, the groups, the worst batteries and flips.
  const marks = [];
  const addMark = (id, kind, sev, label) => {
    if (!ok(id) || marks.some(m => m.id === id) || marks.length >= 30) return;
    const s = st(id); if (!s || s.lat == null) return;
    marks.push({ id, kind, sev, ...(label ? { label: clip(label, 60) } : {}) });
  };
  regular.slice(0, 18).forEach((x, k) => addMark(x.station_id, 'silent', sevOf(x.severity), k < 4 ? x.name : null));
  (F.batteries || []).filter(b => b.finding && b.finding.severity === 'critical').slice(0, 4).forEach(b => addMark(b.station_id, 'battery', 'critical', b.name));
  (F.flips && F.flips.senders || []).slice(0, 2).forEach(s => addMark(s.station_id, 'flip', 'warn', s.name));
  const areas = (F.areas || []).filter(a => a.centre).slice(0, 4).map(a => ({ lat: a.centre.lat, lon: a.centre.lon, km: Math.max(5, Math.min(120, a.centre.km || 20)), sev: sevOf(a.severity), label: clip(a.title.replace(/ went quiet together.*$/, ''), 58) }));
  if (marks.length) {
    const near = marks.filter(m => st(m.id)).map(m => st(m.id));
    scenes.push({ type: 'map', title: 'Where', sub: clip(`${plural(marks.length, 'station')} to look at`, 90), secs: 12, sev: crit ? 'critical' : 'warn',
      say: clip(regular.length ? `The stations that went quiet are on the map${areas.length ? ', and the places where several went together are circled' : ''}. When several go together, look for what they share before blaming each one.` : 'These are the stations with something to look at.', 400),
      stations: marks.slice(0, 6).map(m => m.id), marks, ...(areas.length ? { areas } : {}),
      ...(near.length > 1 ? {} : {}) });
  }

  // Batteries.
  const bats = (F.batteries || []).filter(b => ok(b.station_id) && b.last_night_v != null).slice(0, 4);
  if (bats.length) {
    const b0 = bats[0];
    scenes.push({ type: 'battery', title: 'Batteries', secs: 11, sev: bats.some(b => b.finding && b.finding.severity === 'critical') ? 'critical' : 'warn',
      say: clip(`${b0.name}: last night's low was ${b0.last_night_v} volts${b0.days_to_11_8 != null ? `, about ${Math.round(b0.days_to_11_8)} days from 11.8 at its present slide` : ''}. ${bats.length > 1 ? `${plural(bats.length - 1, 'other')} to watch.` : ''}`, 400),
      stations: bats.map(b => b.station_id),
      items: bats.map(b => ({ id: b.station_id, name: clip(b.name, 60), v: b.last_night_v, ...(b.slope_v_per_night != null ? { trend: Math.max(-5, Math.min(5, b.slope_v_per_night)) } : {}),
        ...(b.days_to_11_8 != null ? { days_to: b.days_to_11_8 } : {}), nights: (b.nights || []).slice(-10), ...(b.finding ? { note: clip(b.finding.title, 90) } : {}) })) });
  }

  // Check strips.
  const chk = (F.checks || []).filter(c => ok(c.station_id) && /^[HPMNU.]+$/.test(c.strip)).slice(0, 5);
  if (chk.length) {
    scenes.push({ type: 'checks', title: 'Check signals', secs: 10, sev: 'warn',
      say: clip(`Each mark is a check that was due. ${chk[0].name} received ${Math.round(100 * (chk[0].rate || 0))}% of its checks in the period.`, 400),
      stations: chk.map(c => c.station_id),
      items: chk.map(c => ({ id: c.station_id, name: clip(c.name, 60), strip: c.strip.slice(-48), ...(c.rate != null ? { rate: c.rate } : {}), ...(c.finding ? { note: clip(c.finding.title, 90) } : {}) })) });
  }

  // Carrier fingerprints.
  const car = (F.carrier && F.carrier.notable || []).filter(c => Number.isFinite(c.w_ppm)).slice(0, 2);
  if (car.length && F.carrier.fleet.length) {
    scenes.push({ type: 'carrier', title: 'Fingerprints', sub: 'every radio’s crystal sits a little off its channel', presenter: F.cohost, secs: 14,
      say: clip(`Every transmitter sits a little off its channel — its fingerprint. ${car[0].name} ${car[0].why}.`, 400),
      stations: car.map(c => c.station_id).filter(ok),
      fleet: F.carrier.fleet.slice(0, 2000).map(v => Math.max(-100, Math.min(100, v))), band: 2.5,
      items: car.map(c => ({ ...(ok(c.station_id) ? { id: c.station_id } : {}), name: clip(c.name, 60), kind: c.kind, now: Math.max(-100, Math.min(100, c.w_ppm)),
        ...(c.b_ppm != null ? { was: c.b_ppm } : {}), series: (c.ppm || []).slice(-37), note: clip(c.why, 90) })) });
  }

  // Whose copy: a corrupted address two repeaters could have carried, and
  // whose carrier the copies came on.
  const top = F.flips && F.flips.week && (F.flips.week.top_addresses || []).find(a => a.candidates && a.candidates.length >= 2 && a.senders && Object.keys(a.senders).length);
  if (top && ok(top.station_id)) {
    const sends = Object.entries(top.senders).map(([tx, k]) => [tx.replace(/^st:/, ''), k]).sort((a, b) => b[1] - a[1]);
    const total = sends.reduce((m, [, k]) => m + k, 0);
    const sus = top.candidates.filter(ok).slice(0, 3);
    if (sus.length >= 2) {
      const lead = sends[0][0];
      scenes.push({ type: 'triangulate', title: 'Whose copy was it?', sub: 'the fingerprint on the corrupted copies', presenter: F.cohost, secs: 15, sev: 'warn',
        say: clip(`${nameOf(top.station_id)}'s readings came through corrupted ${top.n} times this week. ${plural(sus.length, 'repeater')} could have carried them; the carrier on the corrupted copies says which.`, 400),
        stations: [top.station_id, ...sus].filter(ok).slice(0, 4),
        subject: { id: top.station_id, name: clip(nameOf(top.station_id), 60) },
        suspects: sus.map(id => ({ id, name: clip(nameOf(id), 60), n: top.senders['st:' + id] || 0, match: id === lead })),
        evidence: { n: total, what: clip(`${total} of the copies, on ${nameOf(lead)}'s carrier`, 90) },
        verdict: clip(`${sends[0][1]} of the ${total} corrupted copies with a carrier came on ${nameOf(lead)}'s: the bits flip there — its receiver, its site or its radio.`, 160) });
    }
  }

  // Receivers.
  const rx = (F.receivers || []).filter(r => Array.isArray(r.up) && r.up.length).slice(0, 4);
  if (rx.length) {
    scenes.push({ type: 'receivers', title: 'Receivers', secs: 10,
      say: clip(rx.map(r => `${r.name}: ${Math.round(100 * r.up.reduce((a, v) => a + (v || 0), 0) / r.up.length)}% of the period, uploads a median ${r.lag_s_p50} seconds behind.`).join(' '), 400),
      items: rx.map(r => ({ name: clip(r.name, 60), up: r.up.slice(-168), note: clip(`uploads a median ${r.lag_s_p50} s behind`, 90) })) });
  }

  // The days.
  // Whole days only: the day the bulletin is written in has hours still to
  // come, and its dip would read as news.
  const today = new Date(F.period.to).toLocaleDateString('en-CA', { timeZone: TZ });
  const days = (F.series || []).filter(d => d.checks_due > 0 && d.day !== today);
  if (days.length >= 3) {
    scenes.push({ type: 'trend', title: weekly ? 'The fortnight' : 'The week so far', secs: 11,
      say: clip(`Checks received, day by day: ${days.map(d => `${d.label} ${Math.round(d.received_pct)}%`).slice(-7).join(', ')}.`, 400),
      series: [
        { label: 'Checks received', unit: '%', tone: 'warn', points: days.slice(-14).map(d => [d.label, Math.round(d.received_pct)]) },
        { label: 'Corrupted copies a day', tone: 'neutral', points: days.slice(-14).map(d => [d.label, d.corrupted]) },
      ] });
  }

  // Worth a look.
  const items = [];
  if (groups[0] && groups[0].stations.length >= 3) items.push({ sev: 'warn', text: clip(`${groups[0].stations.length} regular stations last heard on ${groups[0].path} went quiet.`, 160) });
  (F.findings || []).filter(f => f.severity === 'critical' && f.station_id && ok(f.station_id)).slice(0, 3)
    .forEach(f => items.push({ sev: 'critical', id: f.station_id, text: clip(`${nameOf(f.station_id)} — ${f.title}.`, 160) }));
  const back = (F.server_findings || {}).back_on_air || [];
  if (back.length) items.push({ sev: 'ok', text: clip(`Heard again: ${plural(back.length, 'station')} the server had called silent — ${back.slice(0, 3).map(nameOf).join(', ')}${back.length > 3 ? ' among them' : ''}.`, 160) });
  if (items.length) scenes.push({ type: 'list', title: weekly ? 'This week, worth a look' : 'Worth a look today', secs: 11, say: 'So, worth a look: ' + clip(items.map(i => i.text.replace(/\.$/, '')).join('; '), 370) + '.', items: items.slice(0, 6), stations: items.map(i => i.id).filter(Boolean).slice(0, 6) });

  scenes.push({ type: 'signoff', title: 'That’s the network', secs: 7, say: weekly ? 'That’s the week on the network. Back on Monday.' : 'That’s the network this morning. Back tomorrow.' });

  // The guests (facts.guests): a scene each, the first of the kinds that suit
  // them not already somebody's. The Bean Counter takes the numbers, nothing else.
  for (const g of F.guests || []) {
    const kinds = g === 'bean-counter' ? ['trend'] : ['battery', 'checks', 'trend', 'list'];
    const sc = kinds.map(k => scenes.find(x => x.type === k && !x.presenter)).find(Boolean);
    if (sc) sc.presenter = g;
  }

  // Long enough to say: about 2.4 words a second, a couple of seconds to look.
  scenes.forEach(sc => { const words = String(sc.say).split(/\s+/).length; sc.secs = Math.min(25, Math.max(sc.secs, Math.ceil(words / 2.4) + 2)); });

  return {
    format: 'floodnet-bulletin/1', kind: F.kind, id: `${F.kind}-${dateKey}`, issued_at: F.gathered_at,
    period: { from: F.period.from, to: F.period.to, label: clip(F.period.label, 90) },
    presenter: F.presenter, cohost: F.cohost,
    outlook: { sky, label: skyLabel }, headline, stats,
    scenes,
    sources: { readings: n.readings_in_period, stations_heard: n.stations_heard_in_period, gathered_at: F.gathered_at },
    caveats: [],
    author: 'the bulletin draft (tools/bulletin/draft.mjs)',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = process.argv[2];
  if (!f) { console.error('node tools/bulletin/draft.mjs FACTS.json > DRAFT.json'); process.exit(2); }
  process.stdout.write(JSON.stringify(draft(JSON.parse(fs.readFileSync(f, 'utf8'))), null, 1) + '\n');
}
