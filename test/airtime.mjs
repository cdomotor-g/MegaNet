// The Airtime panel's reasoning (airtime-analysis.js), held to networks whose
// answer is known — built here, in Node, transmission by transmission.
//
// Each rule the panel rests on is one network that has it and, where the
// rule could be fooled, one that only looks like it:
//
//   * the circle two checks share is as long as the greatest common divisor
//     of their periods: a 1-hour and a 3-hour station on the same minute
//     meet every 3 hours; two 3-hour stations an hour apart never meet, though
//     an hour laid over the next puts them on top of each other
//   * how a logger keeps time, read off its checks: on its slot (steady),
//     walking 40 s a day (drifting), stepped four minutes and stayed
//     (jumped), wandering two minutes either way (randomised) — and a
//     randomised station is left out of the clashes
//   * together against alone: when the damage rides on the transmissions
//     that land together, the ratio says so; when it is spread evenly, it
//     does not
//   * the pairs that land together again and again, each moment once however
//     many channels heard it, with the minute past the hour it happens at
//   * two stations decoded out of one burst are said to be; on a channel
//     whose times are whole seconds, they are not
//   * three stations on one slot: the one doing best stays, the other two are
//     moved — to slots clear of each other and of everything heard there,
//     whole half-minutes — and the move says how, by how the logger keeps
//     time
//   * a drifting check is said before it reaches another station's, with
//     when
//   * two repeaters with no delay on file whose shared stations carry the
//     corrupted copies are told apart, with the Backbone's values when it has
//     two; delays already 150 ms apart, or different output channels, are left
//     alone
//   * from Station Health's result: an address no station carries that rides
//     with one station's frames is that station's, not a crowd; a ghost is its
//     twin's
//
// Run:  npm run airtime
//       npm run airtime -- -v    also print what passed

import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';
import path from 'node:path';

process.env.TZ = 'Australia/Brisbane';
const require = createRequire(import.meta.url);
const AT = require(path.join(REPO_ROOT, 'airtime-analysis.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const SEC = 1000, MIN = 60000, HOUR = 3600000, DAY = 86400000;
const T0 = Date.UTC(2026, 8, 1, 14, 0, 0);      // midnight in Brisbane
const DAYS = 7;
const T1 = T0 + DAYS * DAY;

// A seeded generator, so a failure is the same failure every run.
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; }

// A network: stations that check on a period at a phase, each check's time
// off its slot by off(t), heard at `paths`; damaged(t, k) says whether that
// check came off worse. Returns analyse()'s input.
function network(defs, opts) {
  const o = opts || {};
  const txs = [], stations = [];
  defs.forEach(d => {
    const slots = [], resid = [];
    for (let k = Math.ceil((T0 - d.phase) / d.P); d.phase + k * d.P < T1 - 5 * MIN; k++) {
      const t = d.phase + k * d.P;
      const off = d.off ? d.off(t, k) : 0;
      const dmg = d.damaged ? d.damaged(t, k) : false;
      const at = t + off;
      slots.push({ t, outcome: dmg ? 'partial' : 'hit', damaged: dmg, spell: false });
      resid.push({ t, d: off });
      (d.frames || [0]).forEach((f, i) => {
        txs.push({ t: at + f, src: d.id, ghost: false, check: true, damaged: dmg && i === 0,
          arr: (d.paths || ['serial-monitor/pi-sdr0']).map(p => ({ path: p, t: at + f + (o.lag || 0), bad: false })) });
      });
    }
    stations.push({ id: d.id, name: d.name || d.id, P: d.P, phase: d.phase, resid, footMs: (d.frames || [0]).slice(-1)[0],
      paths: d.paths || ['serial-monitor/pi-sdr0'], reps: d.reps || [], slots });
  });
  (o.extra || []).forEach(x => txs.push(x));
  return { t0: T0, t1: T1, now: T1, txs, stations, repeaters: o.repeaters || [] };
}

// ── arithmetic ───────────────────────────────────────────────────────────────
check('two stretches that overlap have negative clearance', AT._clearance(0, 1000, 500, 1000, HOUR) === -500);
check('…and two apart have the gap between them', AT._clearance(0, 1000, 5000, 1000, HOUR) === 4000);
check('…measured round the circle, across its end', AT._clearance(HOUR - 1000, 500, 2000, 500, HOUR) === 2500);
check('the circle of a 1-hour and a 3-hour station is an hour long', AT._gcd(HOUR, 3 * HOUR) === HOUR);
check('…of a 2-hour and a 3-hour station, an hour too', AT._gcd(2 * HOUR, 3 * HOUR) === HOUR);
check('a 3-hourly check is said as the first after midnight and the period', AT._clockOf(T0 + 17 * MIN + 42 * SEC, 3 * HOUR, T1) === '00:17:42, then every 3 h',
  AT._clockOf(T0 + 17 * MIN + 42 * SEC, 3 * HOUR, T1));
check('a 15-minute check as the minutes past every hour', AT._clockOf(T0 + 7 * MIN + 42 * SEC, 15 * MIN, T1) === ':07:42, :22:42, :37:42, :52:42 past every hour',
  AT._clockOf(T0 + 7 * MIN + 42 * SEC, 15 * MIN, T1));

// ── the circle two checks share ──────────────────────────────────────────────
{
  const R = AT.analyse(network([
    { id: 'hourly', P: HOUR, phase: T0 + 17 * MIN },
    { id: 'three', P: 3 * HOUR, phase: T0 + 2 * HOUR + 17 * MIN + 1500 },
  ]));
  const c = R.clashes[0];
  check('a 1-hour and a 3-hour station on the same minute clash', R.clashes.length === 1, JSON.stringify(R.clashes.map(x => [x.a, x.b, x.clearanceMs])));
  check('…every 3 hours', c && c.everyMs === 3 * HOUR);
  check('…and were due together at every one of the 3-hour station\'s checks', c && c.together === R.checks.find(x => x.id === 'three').n, c && `${c.together}`);
}
{
  const R = AT.analyse(network([
    { id: 'a', P: 3 * HOUR, phase: T0 + 17 * MIN },
    { id: 'b', P: 3 * HOUR, phase: T0 + HOUR + 17 * MIN + 1500 },
  ]));
  check('two 3-hour stations an hour apart do not clash, though the hour folded stacks them', R.clashes.length === 0
    && R.paths[0].fold.n[Math.floor((17 * MIN) / AT.FOLD_BIN)] === R.paths[0].n, JSON.stringify(R.clashes));
}
{
  const R = AT.analyse(network([
    { id: 'two', P: 2 * HOUR, phase: T0 },
    { id: 'three', P: 3 * HOUR, phase: T0 + HOUR },
  ]));
  check('a 2-hour station at midnight and a 3-hour one at 01:00 meet at 04:00, every 6 hours', R.clashes.length === 1 && R.clashes[0].everyMs === 6 * HOUR,
    JSON.stringify(R.clashes.map(x => x.everyMs / HOUR)));
}

// ── how a logger keeps time ──────────────────────────────────────────────────
{
  const r = rng(7);
  const t = (n, f) => Array.from({ length: n }, (_, k) => ({ t: T0 + k * 3 * HOUR, d: f(k, T0 + k * 3 * HOUR) }));
  const steady = AT._timing(t(56, () => 1500 + (r() - 0.5) * 3000));
  const drift = AT._timing(t(56, (k, tt) => 2000 + 40 * SEC * (tt - T0) / DAY + (r() - 0.5) * 2000));
  const jump = AT._timing(t(56, k => (k < 30 ? 1000 : 4 * MIN + 1000) + (r() - 0.5) * 2000));
  const jitter = AT._timing(t(56, () => (r() - 0.5) * 4 * MIN));
  check('a check on its slot to within a couple of seconds keeps its time', steady.behaviour === 'steady', `${steady.behaviour} ±${Math.round(steady.spreadMs)} ms`);
  check('a check walking 40 s a day is drifting, at about 40 s a day', drift.behaviour === 'drifting' && Math.abs(drift.driftSPerDay - 40) < 3, `${drift.behaviour} ${drift.driftSPerDay}`);
  check('…and is placed where it is now, not where it was on average', Math.abs(drift.offAt(T0 + 7 * DAY) - (2000 + 280 * SEC)) < 5 * SEC, `${Math.round(drift.offAt(T0 + 7 * DAY) / 1000)} s`);
  check('a check that stepped four minutes and stayed jumped, when and by how much', jump.behaviour === 'jumped' && Math.abs(jump.jump.ms - 4 * MIN) < 5 * SEC
    && jump.jump.t === T0 + 30 * 3 * HOUR, JSON.stringify(jump.jump));
  check('…and is placed after the step', Math.abs(jump.offAt(T1) - (4 * MIN + 1000)) < 5 * SEC);
  check('a check wandering two minutes either way is randomised', jitter.behaviour === 'jittered', `${jitter.behaviour} ±${Math.round(jitter.spreadMs / 1000)} s`);
  check('five checks are too few to tell', AT._timing(t(5, () => 0)).behaviour === 'unclear');

  const r2 = rng(11);
  const R = AT.analyse(network([
    { id: 'random', P: 3 * HOUR, phase: T0 + 17 * MIN, off: () => (r2() - 0.5) * 4 * MIN },
    { id: 'fixed', P: 3 * HOUR, phase: T0 + 17 * MIN + 1000 },
  ]));
  check('a randomised station is left out of the clashes', R.clashes.length === 0 && R.checks.find(c => c.id === 'random').behaviour === 'jittered',
    JSON.stringify(R.clashes));
}

// ── together against alone ───────────────────────────────────────────────────
{
  // Two stations on one slot, a third of their shared checks damaged; eight
  // more alone, damaged one check in fifty.
  const r = rng(3);
  const defs = [
    { id: 'p', P: 3 * HOUR, phase: T0 + 40 * MIN, damaged: () => r() < 0.34 },
    { id: 'q', P: 3 * HOUR, phase: T0 + 40 * MIN + 1200 },
  ];
  for (let i = 0; i < 8; i++) defs.push({ id: 'lone' + i, P: 3 * HOUR, phase: T0 + (60 + i * 13) * MIN, damaged: () => r() < 0.02 });
  const R = AT.analyse(network(defs));
  check('damage riding on the transmissions that land together reads as a ratio well above one', R.damage.enough && R.damage.ratio >= 5,
    JSON.stringify(R.damage));
  check('…the clash between them hurts', R.clashes.length === 1 && R.clashes[0].hurts, JSON.stringify(R.clashes.map(c => [c.together, c.damaged, c.rate])));
  check('…and is held against every other check in the network', R.baseline.n === 8 * 56 && R.baseline.rate < 0.06, JSON.stringify(R.baseline));
  check('…so moving one is a warning, not a note', R.suggestions[0] && R.suggestions[0].kind === 'move-check' && R.suggestions[0].severity === 'warn',
    R.suggestions[0] && R.suggestions[0].title);
  check('…and the one moved is the one doing worse', R.suggestions[0] && R.suggestions[0].stationId === 'p', R.suggestions[0] && R.suggestions[0].stationId);

  const r3 = rng(5);
  const even = defs.map(d => Object.assign({}, d, { damaged: () => r3() < 0.08 }));
  const E = AT.analyse(network(even));
  check('damage spread evenly reads as a ratio near one', E.damage.ratio != null && E.damage.ratio < 2.5, JSON.stringify(E.damage));
  check('…and the move it still calls for is a note', E.suggestions.filter(s => s.kind === 'move-check').every(s => s.severity === 'info'),
    E.suggestions.map(s => s.severity).join());
}

// ── who lands together, again and again ─────────────────────────────────────
{
  // Two stations meeting at :20 every three hours, heard on two channels at
  // once; a third whose events land beside one of them now and then.
  const two = ['serial-monitor/pi-sdr0-151.500', 'serial-monitor/pi-sdr1-151.525'];
  const extra = [];
  for (let k = 0; k < 6; k++) {
    const t = T0 + 20 * MIN + k * 15 * HOUR + 1000;     // 15 h: on one of their checks every time
    extra.push({ t, src: 'events', ghost: false, check: false, damaged: false, arr: [{ path: two[0], t, bad: false }] });
  }
  const R = AT.analyse(network([
    { id: 'm', P: 3 * HOUR, phase: T0 + 20 * MIN, paths: two },
    { id: 'n', P: 3 * HOUR, phase: T0 + 20 * MIN + 1500, paths: two },
  ], { extra }));
  const top = R.pairs[0];
  check('two stations meeting every check are the pair most often together', top && [top.a, top.b].join() === 'm,n', JSON.stringify(R.pairs.map(p => [p.a, p.b, p.n])));
  check('…counted once a moment, though two channels heard it', top && top.n === 56, top && `${top.n}`);
  check('…usually at the same minute past the hour', top && top.usualShare === 1 && top.usualMs === 20 * MIN, top && JSON.stringify([top.usualMs / MIN, top.usualShare]));
  const ev = R.pairs.find(p => p.a === 'events' || p.b === 'events');
  check('…and the events that landed beside them now and then are counted too', ev && ev.n === 6, JSON.stringify(ev && ev.n));
  check('three at once is a moment of its own', R.moments.length === 6 && R.moments.every(m => m.srcs.length === 3), `${R.moments.length}`);
}

// ── one burst, and whole seconds ─────────────────────────────────────────────
{
  const R = AT.analyse(network([
    { id: 'a', P: HOUR, phase: T0 + 5 * MIN },
    { id: 'b', P: HOUR, phase: T0 + 5 * MIN + 120 },
  ]));
  const P = R.paths[0];
  check('two stations decoded 120 ms apart came out of one burst', P.sameBurst === P.piles && P.piles >= 160, `${P.sameBurst} of ${P.piles}`);
  const W = AT.analyse(network([
    { id: 'a', P: HOUR, phase: T0 + 5 * MIN },
    { id: 'b', P: HOUR, phase: T0 + 5 * MIN },
  ]));
  check('…but on a channel whose times are whole seconds, nothing finer than together is said', W.paths[0].wholeSeconds && W.paths[0].sameBurst === 0
    && W.paths[0].piles >= 160, JSON.stringify({ whole: W.paths[0].wholeSeconds, same: W.paths[0].sameBurst, piles: W.paths[0].piles }));
}

// ── three on one slot ────────────────────────────────────────────────────────
{
  const r = rng(9);
  const defs = [
    { id: 'keep', name: 'Keeper', P: 3 * HOUR, phase: T0 + 20 * MIN, frames: [0, 5400, 10800] },
    { id: 'mv1', name: 'Mover One', P: 3 * HOUR, phase: T0 + 20 * MIN + 2000, frames: [0, 5400, 10800], damaged: () => r() < 0.4 },
    { id: 'mv2', name: 'Mover Two', P: HOUR, phase: T0 + 20 * MIN + 6000, damaged: () => r() < 0.3 },
  ];
  // The rest of the receiver's checks, every nine minutes round the hour
  // between them, so the gaps left are known.
  for (let i = 0; i < 5; i++) defs.push({ id: 'o' + i, P: HOUR, phase: T0 + (30 + i * 6) * MIN });
  const R = AT.analyse(network(defs));
  const moves = R.suggestions.filter(s => s.kind === 'move-check');
  const ids = moves.map(m => m.stationId).sort();
  check('three stations on one slot: two moves', moves.length === 2 && ids.join() === 'mv1,mv2', ids.join());
  check('…the one doing best stays', !moves.some(m => m.stationId === 'keep'));
  const to = Object.fromEntries(moves.map(m => [m.stationId, m.evidence.toMs]));
  check('…each sent to a whole half-minute', moves.every(m => m.evidence.toMs % AT.STEP_MS === 0), JSON.stringify(to));
  // Every planned position against every other check, at the guard the
  // analysis used.
  const pos = new Map(R.checks.map(c => [c.id, { P: c.P, at: to[c.id] != null ? to[c.id] : c.at, f: c.footMs, s: c.spreadMs }]));
  let worst = Infinity;
  for (const [a, A] of pos) for (const [b, B] of pos) {
    if (a >= b) continue;
    const g = AT._gcd(A.P, B.P);
    worst = Math.min(worst, AT._clearance(A.at % g, A.f, B.at % g, B.f, g));
  }
  check('…to slots clear of each other and of every other check heard there by a minute or more', worst >= 60 * SEC, `${Math.round(worst / 1000)} s`);
  check('…and a steady logger is told to change its offset or start time', moves.every(m => /offset or start time/.test(m.how)), moves[0] && moves[0].how);
  check('…in the words of a time people can set', moves.every(m => /^Move .+'s check \d/.test(m.title)), moves.map(m => m.title).join(' | '));
}

// ── a drifting check, before it arrives ──────────────────────────────────────
{
  const R = AT.analyse(network([
    { id: 'walker', P: 3 * HOUR, phase: T0 + 30 * MIN, off: t => 40 * SEC * (t - T0) / DAY },
    { id: 'target', P: 3 * HOUR, phase: T0 + 30 * MIN + 7 * 40 * SEC + 3 * 40 * SEC },
  ]));
  const s = R.suggestions.find(x => x.kind === 'clock-drift');
  check('a check walking 40 s a day toward another station\'s is said before it arrives', !!s && s.stationId === 'walker' && !s.evidence.now, s && s.detail);
  check('…with when — in about two days at the guard\'s width', s && s.evidence.inMs > 1 * DAY && s.evidence.inMs < 3.5 * DAY, s && `${(s.evidence.inMs / DAY).toFixed(1)} days`);
  check('…and told to set its clock before anything else', s && /set its clock/.test(s.how));
}

// ── repeaters ────────────────────────────────────────────────────────────────
{
  const r = rng(13);
  const defs = [];
  for (let i = 0; i < 6; i++) defs.push({ id: 's' + i, P: 3 * HOUR, phase: T0 + (10 + i * 23) * MIN, damaged: () => r() < 0.15 });
  for (let i = 0; i < 6; i++) defs.push({ id: 'c' + i, P: 3 * HOUR, phase: T0 + (12 + i * 23) * MIN });
  const members = defs.slice(0, 6).map(d => d.id);
  const reps = (d1, d2, f2) => [
    { id: 'R1', name: 'Hill One', delayMs: d1, suggestedMs: 150, txMhz: 151.5, members },
    { id: 'R2', name: 'Hill Two', delayMs: d2, suggestedMs: 300, txMhz: f2 || 151.5, members },
    { id: 'R3', name: 'Hill Three', delayMs: null, suggestedMs: 150, txMhz: 151.5, members: defs.slice(6).map(d => d.id) },
  ];
  const R = AT.analyse(network(defs, { repeaters: reps(null, null) }));
  const s = R.suggestions.filter(x => x.kind === 'stagger-repeaters');
  check('two repeaters with no delay whose shared stations carry the corrupted copies are told apart', s.length === 1 && s[0].repeaterIds.join() === 'R1,R2',
    JSON.stringify(s.map(x => x.repeaterIds)));
  check('…with the Backbone\'s two values', s[0] && /Hill One 150 ms and Hill Two 300 ms/.test(s[0].detail), s[0] && s[0].detail);
  check('…and the repeater carrying only clean stations is left alone', !s.some(x => x.repeaterIds.includes('R3')));
  const apart = AT.analyse(network(defs, { repeaters: reps(150, 300) }));
  check('delays already 150 ms apart are left alone', !apart.suggestions.some(x => x.kind === 'stagger-repeaters'));
  const same = AT.analyse(network(defs, { repeaters: reps(200, 200) }));
  check('the same delay on both is a warning', (same.suggestions.find(x => x.kind === 'stagger-repeaters') || {}).severity === 'warn');
  const chan = AT.analyse(network(defs, { repeaters: reps(null, null, 152.4) }));
  check('repeaters sending on different channels are left alone', !chan.suggestions.some(x => x.kind === 'stagger-repeaters'));
  check('how many repeaters have a delay on file is counted', same.counts.repeaters === 3 && same.counts.repeatersWithDelay === 2, JSON.stringify(same.counts));
}

// ── from Station Health's result ─────────────────────────────────────────────
{
  // Two stations, and an address no station carries that is sent 3 s after
  // station A's battery every check — A's sensor the register does not list.
  // A ghost of B's frame on another address, 2 s after it.
  const mk = (addr, t, v, path) => ({ addr, aid: Number(addr.slice(2)), t, v, copies: [{ t, v, path: path || 'serial-monitor/pi-sdr0', host: 'serial-monitor/pi' }], bad: [], hosts: new Set(['pi']) });
  const sTx = { a: [], b: [] }, all = [];
  const slots = { a: [], b: [] };
  for (let k = 0; k < 40; k++) {
    const t = T0 + 20 * MIN + k * 3 * HOUR;
    const ta = mk('a:100', t, 130), tu = mk('a:999', t + 3000, 50);
    const tb = mk('a:200', t + 40 * MIN, 131);
    sTx.a.push(ta); sTx.b.push(tb); all.push(ta, tu, tb);
    slots.a.push({ t, outcome: 'hit', burst: { t, txs: [ta] } });
    slots.b.push({ t: t + 40 * MIN, outcome: 'hit', burst: { t: t + 40 * MIN, txs: [tb] } });
  }
  const twin = sTx.b[10];
  const ghost = mk('a:201', twin.t + 2000, 131);
  ghost.ghostOf = { of: twin, bits: 1 };
  twin.ghosts = 1;
  all.push(ghost);
  const S = (id, name) => ({ st: { id, name, lat: -27.5, lon: 153 }, txs: sTx[id], slots: slots[id], paths: ['serial-monitor/pi-sdr0'],
    schedule: { P: 3 * HOUR, phase: slots[id][0].t } });
  const A = { t0: T0, t1: T0 + 5 * DAY, now: T0 + 5 * DAY, txs: all, stations: new Map([['a', S('a', 'Alpha')], ['b', S('b', 'Bravo')]]), repeaters: [] };
  const R = AT.fromHealth(A);
  check('an address no station carries, sent beside one station every check, is that station\'s and no crowd', R.counts.together === 0 && R.counts.piles === 0,
    JSON.stringify(R.counts));
  check('…a ghost is its twin\'s, and its twin is the damaged one', R.damage.alone.d === 1 && R.counts.transmissions === 120, JSON.stringify(R.damage));
  check('the stations\' checks come through with when they are heard', R.checks.length === 2 && R.checks.every(c => c.behaviour === 'steady')
    && R.checks.find(c => c.id === 'a').clock === '00:20:00, then every 3 h', JSON.stringify(R.checks.map(c => [c.id, c.behaviour, c.clock])));
  check('an empty result reads as nothing, not as an error', AT.fromHealth(null).counts.transmissions === 0);
}

const failed = results.filter(r => !r.pass);
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the Airtime panel\'s reasoning holds on every network built for it.');
