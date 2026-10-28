// ⏳ Repeater Delays' plan (delay-plan.js), held to networks whose answer is
// known — built here, in Node, a station and a few repeaters at a time — and
// then to the register itself.
//
//   * the bands: under a frame apart is on top, under a lead-in and a frame is
//     close, from there it is clear and costs nothing; nearer is never cheaper
//   * two repeaters that pass one station's address, hear it and are heard
//     together by a base collide on one delay and are put clear apart
//   * no pair without a receiver that hears both, or on two transmit channels;
//     a channel not on record agrees with any
//   * three that all collide fit under a second clear of each other
//   * a second hop goes out a lead-in, a frame and its own delay after the
//     copy it heard, and is planned clear of a first hop's
//   * a delay recorded on a station is kept, and replanned when told not to
//   * from a shared delay now, the plan changes as few repeaters as it can
//   * the same register and settings give the same plan
//   * the register: every repeater on the plan, delays whole steps under the
//     limit, far fewer pairs on top than on one delay, and every limit no
//     worse than the one below it
//
// Run:  npm run delays
//       npm run delays -- -v    also print what passed

import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DP = require(path.join(REPO_ROOT, 'delay-plan.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const J = JSON.stringify;

// ── Building networks ─────────────────────────────────────────────────────────
// Positions as kilometres east and north of a point near Gatton; a degree of
// latitude is 111.2 km, a degree of longitude there 98.5 km.
const LAT0 = -27.5, LON0 = 152.3;
const at = (eKm, nKm) => ({ lat: LAT0 + nKm / 111.2, lon: LON0 + eKm / (111.2 * Math.cos(LAT0 * Math.PI / 180)) });
const field = (id, e, n, ids) => Object.assign({ id, name: id, roles: ['field'], enabled: true,
  sensors: ids.map(a => ({ alert_id: a, type: 'Rainfall' })) }, at(e, n));
const rep = (id, e, n, ranges, o = {}) => Object.assign({ id, name: id, roles: ['repeater'], enabled: true,
  repeater: { rx_mhz: o.rx === undefined ? 151.5 : o.rx, tx_mhz: o.tx === undefined ? 151.5 : o.tx,
    pass_ranges: ranges.map(([low, high]) => ({ low, high })), exclusions: [],
    ...(o.delay != null ? { delay_ms: o.delay } : {}) } }, at(e, n));
const base = (id, e, n) => Object.assign({ id, name: id, roles: ['base'], enabled: true }, at(e, n));

const byId = (p, id) => p.repeaters.find(r => r.id === id);
const pairOf = (p, a, b) => p.pairs.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));

// ── The bands ─────────────────────────────────────────────────────────────────
{
  const o = DP.settings({});
  check('a lead-in and a frame is 433 ms on the defaults', o.clearMs === 433, String(o.clearMs));
  check('the same delay is on top, and the worst', DP.band(0, o) === 'ontop' && DP.cost(0, o) === 2);
  check('132 ms apart is still on top; 133 is close', DP.band(132, o) === 'ontop' && DP.band(133, o) === 'close');
  check('432 ms is close; 433 is clear and costs nothing', DP.band(432, o) === 'close' && DP.band(433, o) === 'clear' && DP.cost(433, o) === 0);
  let mono = true;
  for (let s = 0; s < 1000; s += 7) if (DP.cost(s + 7, o) > DP.cost(s, o) + 1e-12) mono = false;
  check('further apart never costs more', mono);
  check('a longer lead-in moves the line', DP.band(500, { leadMs: 400 }) === 'close' && DP.band(533, { leadMs: 400 }) === 'clear');
}

// ── Two repeaters, one station, one base ──────────────────────────────────────
{
  const net = [field('S', 0, 0, [1001]), rep('A', 30, 0, [[1000, 1099]]), rep('B', -30, 0, [[1000, 1099]]), base('X', 0, 50)];
  const p = DP.plan(net);
  const x = pairOf(p, 'A', 'B');
  check('two repeaters passing one station\'s address, heard together by a base, are a pair', !!x && x.weight === 1, J(p.pairs));
  check('…on top of each other on one delay', x && x.bandSame === 'ontop' && x.sepSameMs === 0, J(x));
  check('…and clear under the plan', x && x.band === 'clear' && x.sepMs >= 433, J(x));
  check('…a whole number of 50 ms steps under a second', [byId(p, 'A').delay, byId(p, 'B').delay].every(d => d % 50 === 0 && d >= 0 && d <= 999),
    J([byId(p, 'A').delay, byId(p, 'B').delay]));
  check('…where they meet is the base', x && J(x.where.map(w => w.id)) === J(['X']), J(x && x.where));
  check('…and the station is named as the reading behind it', x && x.sources[0].id === 'S' && x.sources[0].address === 1001);
  check('both are in one group, of two', p.clusters.length === 1 && p.clusters[0].repeaters.length === 2, J(p.clusters));

  const far = DP.plan([field('S', 0, 0, [1001]), rep('A', 30, 0, [[1000, 1099]]), rep('B', -30, 0, [[1000, 1099]]), base('X', 140, 0)]);
  check('no pair when no receiver hears both', far.pairs.length === 0 && far.repeaters.every(r => r.status === 'free'), J(far.pairs));

  const chans = DP.plan([field('S', 0, 0, [1001]), rep('A', 30, 0, [[1000, 1099]]), rep('B', -30, 0, [[1000, 1099]], { tx: 152.4 }), base('X', 0, 50)]);
  check('no pair when they send on two channels', chans.pairs.length === 0, J(chans.pairs));

  const unknown = DP.plan([field('S', 0, 0, [1001]), rep('A', 30, 0, [[1000, 1099]]), rep('B', -30, 0, [[1000, 1099]], { rx: null, tx: null }), base('X', 0, 50)]);
  check('a channel not on record agrees with any — a pair, and said', unknown.pairs.length === 1 && unknown.counts.channelUnknown === 1, J(unknown.counts));

  const outside = DP.plan([field('S', 0, 0, [1201]), rep('A', 30, 0, [[1000, 1099]]), rep('B', -30, 0, [[1000, 1099]]), base('X', 0, 50)]);
  check('no pair for an address neither passes', outside.pairs.length === 0);

  const excl = net.map(s => s.id === 'B' ? Object.assign({}, s, { repeater: Object.assign({}, s.repeater, { exclusions: [{ low: 1001, high: 1001 }] }) }) : s);
  check('an exclusion takes the address out of the window', DP.plan(excl).pairs.length === 0);

  const tooFar = DP.plan([field('S', 0, 0, [1001]), rep('A', 30, 0, [[1000, 1099]]), rep('B', -95, 0, [[1000, 1099]]), base('X', 0, 50)]);
  check('a repeater further from a field station than the reach does not hear it', tooFar.pairs.length === 0, J(tooFar.pairs));
}

// ── Three that all collide, under a second ────────────────────────────────────
{
  const net = [field('S', 0, 0, [2001]), rep('A', 30, 0, [[2000, 2099]]), rep('B', -30, 0, [[2000, 2099]]),
    rep('C', 0, 30, [[2000, 2099]]), base('X', 0, -40)];
  const p = DP.plan(net);
  const d = ['A', 'B', 'C'].map(id => byId(p, id).delay).sort((a, b) => a - b);
  check('three repeaters that all collide fit under a second clear of each other', p.counts.ontop === 0 && p.counts.close === 0 && p.counts.clear === 3,
    J({ counts: p.counts, d }));
  check('…as 0, then two more each a clear step on', d[0] === 0 && d[1] - d[0] >= 433 && d[2] - d[1] >= 433, J(d));
  const four = DP.plan(net.concat([rep('D', 0, -20, [[2000, 2099]])]));
  check('four that all collide cannot all be clear under a second — said, not hidden', four.counts.clear < 6 && four.counts.ontop + four.counts.close > 0,
    J(four.counts));
  const longer = DP.plan(net.concat([rep('D', 0, -20, [[2000, 2099]])]), { maxMs: 1999 });
  check('…and with up to 2 s they can', longer.counts.clear === 6, J(longer.counts));
}

// ── A second hop ──────────────────────────────────────────────────────────────
// S is heard by A and C; B passes the address too but is 95 km from S and
// 103 km from C, so it hears only A's copy — and sends a lead-in, a frame and
// its own delay after it.
{
  const net = [field('S', 0, 0, [3001]), rep('A', 40, 0, [[3000, 3099]]), rep('C', 0, 40, [[3000, 3099]]),
    rep('B', 95, 0, [[3000, 3099]]), base('X', 40, 40)];
  const p = DP.plan(net);
  const A = byId(p, 'A'), B = byId(p, 'B'), C = byId(p, 'C');
  const tA = 433 + A.delay, tC = 433 + C.delay;
  const tB = tA + 433 + B.delay;
  const ab = pairOf(p, 'A', 'B'), bc = pairOf(p, 'B', 'C'), ac = pairOf(p, 'A', 'C');
  check('a second hop is a pair with the first hops a base hears it with', !!ab && !!bc && !!ac, J(p.pairs.map(x => x.a + x.b)));
  check('…its copy a lead-in, a frame and its delay after the first copy it heard', ab && bc
    && ab.sepMs === Math.round(Math.abs(tB - tA)) && bc.sepMs === Math.round(Math.abs(tB - tC)), J({ tA, tB, tC, ab, bc }));
  check('…and all three planned clear', p.counts.clear === 3, J(p.counts));
}

// ── Recorded, current, and the same plan twice ────────────────────────────────
{
  const net = [field('S', 0, 0, [4001]), rep('A', 30, 0, [[4000, 4099]], { delay: 300 }), rep('B', -30, 0, [[4000, 4099]], { delay: 300 }),
    base('X', 0, 50)];
  const kept = DP.plan(net);
  check('a delay recorded on a station is kept as it is', byId(kept, 'A').delay === 300 && byId(kept, 'B').delay === 300 && byId(kept, 'A').fixed,
    J(kept.repeaters.map(r => [r.id, r.delay, r.fixed])));
  check('…and two kept on one delay are said to be on top', kept.counts.ontop === 1 && kept.counts.recorded === 2);
  const fresh = DP.plan(net, { keepRecorded: false });
  check('told not to keep them, one moves and one stays', fresh.counts.ontop === 0 && fresh.counts.changes === 1
    && fresh.repeaters.some(r => r.delay === 300), J(fresh.repeaters.map(r => [r.id, r.delay, r.change])));

  const three = [field('S', 0, 0, [5001]), rep('A', 30, 0, [[5000, 5099]]), rep('B', -30, 0, [[5000, 5099]]),
    rep('C', 0, 30, [[5000, 5099]]), base('X', 0, -40), field('T', 300, 0, [6001]), rep('E', 330, 0, [[6000, 6099]])];
  const cur = DP.plan(three, { currentMs: 0 });
  check('from one shared delay now, the plan changes as few as it can', cur.counts.changes === 2 && cur.counts.clear === 3,
    J(cur.repeaters.map(r => [r.id, r.delay, r.change])));
  const two = DP.plan(three.filter(s => s.id !== 'C'), { currentMs: 200 });
  check('…two of them: one stays on 200 ms and the other moves clear of it', two.counts.changes === 1 && two.counts.clear === 1
    && two.repeaters.some(r => r.delay === 200 && r.linked), J(two.repeaters.map(r => [r.id, r.delay, r.change])));
  check('…and clearing a pair comes before keeping what they have: three on 200 ms all move', DP.plan(three, { currentMs: 200 }).counts.clear === 3);
  check('…and a repeater with no neighbour stays where it is', byId(two, 'E').delay === 200 && byId(two, 'E').status === 'free' && byId(two, 'E').change === false);

  check('the same network and settings give the same plan', J(DP.plan(three)) === J(DP.plan(three)));
}

// ── The register ──────────────────────────────────────────────────────────────
{
  const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'stations.json'), 'utf8'));
  const reps = doc.stations.filter(s => (s.roles || []).includes('repeater') && s.repeater && s.enabled !== false);
  const t0 = Date.now();
  const p = DP.plan(doc.stations);
  const took = Date.now() - t0;
  check(`the register's plan is worked out in a few seconds (${took} ms)`, took < 8000);
  check(`every repeater on file is on the plan (${reps.length})`, p.repeaters.length === reps.length && reps.length > 0);
  check('every delay a whole 50 ms step from 0 to 999', p.repeaters.every(r => r.delay % 50 === 0 && r.delay >= 0 && r.delay <= 999),
    J(p.repeaters.filter(r => r.delay % 50 || r.delay > 999).slice(0, 3)));
  check('some repeaters share readings, and the plan puts far fewer pairs on top than one delay does',
    p.counts.pairs > 0 && p.counts.ontopSame > 0 && p.counts.ontop * 4 <= p.counts.ontopSame, J(p.counts));
  check('the plan costs less than one delay for all', p.costPlan < p.costSame, `${p.costPlan.toFixed(1)} < ${p.costSame.toFixed(1)}`);
  check('every pair is in a group, and every group has a name', p.pairs.every(x => byId(p, x.a).cluster && byId(p, x.a).cluster === byId(p, x.b).cluster)
    && p.clusters.every(c => c.name && c.repeaters.length >= 2));
  check('the same register gives the same plan', J(DP.plan(doc.stations).repeaters.map(r => r.delay)) === J(p.repeaters.map(r => r.delay)));
  const limits = [999, 1999, 2999].map(m => DP.plan(doc.stations, { maxMs: m }).counts);
  check('a longer limit leaves no more pairs on top or close', limits[1].ontop + limits[1].close <= limits[0].ontop + limits[0].close
    && limits[2].ontop + limits[2].close <= limits[1].ontop + limits[1].close, J(limits.map(c => [c.ontop, c.close, c.clear])));
}

const failed = results.filter(r => !r.pass);
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the Repeater Delays plan holds on every network built for it, and on the register.');
