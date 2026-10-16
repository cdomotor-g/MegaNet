// The 🎓 Radio Propagation tab (propagation-physics.js, propagation-scene.js,
// propagation-fade.js, propagation.js), held to what it teaches.
//
// A lesson that is wrong is worse than no lesson, and nothing on this tab
// throws when a number is wrong: a wavelength off by a factor still draws a
// lovely wave. So the arithmetic is held first, in Node, to figures worked by
// hand, and the ALERT frame the tab flips bits in is held to the app's own
// decoder (packets.js) — a ghost the tab says passes must be one the ALERT
// Packets tab would accept. Then the made-up catchment is held to the stories
// told about it, and the tab is driven in Chromium.
//
//   The physics    wavelength, flight time, free-space loss, the Fresnel zone,
//                  the Earth's bulge and horizon, the knife edge (6 dB on the
//                  line, nothing well clear), foliage rising with frequency
//                  and capped, two copies adding to +6 dB in step and to
//                  nothing half a wavelength apart.
//   The frame      the ABF layout packets.js decodes, bit for bit, over 500
//                  addresses and values; a flipped address bit passing as a
//                  ghost, a flipped check bit caught.
//   The receiver   alone, clean; ahead by the capture margin, clean and the
//                  other lost; even, spoilt; a keying apart, both clean; the
//                  same seed, the same picture.
//   The scene      the mountain's shadow (diffracted, and costing what a knife
//                  edge costs), the trees costing a few decibels, every echo
//                  found by the image method lying on its reflector with
//                  equal path through the mirror, the ground bounce swinging
//                  the sum as the mast moves; each story's outcome — two clean
//                  copies home, a ghost from two repeaters on one delay and
//                  none once staggered, a ghost relayed from a collision, four
//                  copies at the Town base — and the warped clock.
//   The fade test  the bench's constants the files they restate (the link
//                  budget card's receiver, feeders and bands, the whip's
//                  height, the Network Review's attenuator); dBm and dBi; the
//                  budget a sum, a decibel on the attenuator a decibel off the
//                  margin at every power; Hata to a figure worked by hand, the
//                  horizon and the smooth Earth past it; what a test in 3 dB
//                  and 5 dB steps reads, short by half a step on average, and
//                  which of the link budget's lines each grid can settle.
//   The tab        it draws (every canvas has pixels), tells the story in
//                  words, changes story from its own radios, staggers Hill B
//                  from its own button, says each collision's outcome as the
//                  sliders move, stops everything on the way out and starts
//                  again on the way back, and stands still for a device that
//                  asks for reduced motion — at the outcome, not at nothing.
//                  Section 6: Auto testing in 3 dB steps by itself; the
//                  attenuator touched handing it over; a test heard and a test
//                  missed, and the reading booked between them; the table, the
//                  reach and the comparison following the settings.
//
// Run:  npm run propagation
//       npm run propagation -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── Node: the three files, and packets.js for the frame ─────────────────────
const ctx = { console, Math, performance };
vm.createContext(ctx);
// The field allowance the scene's link budget takes, as core.js holds it —
// lifted from its source rather than restated, so the browser and this check
// price every path the same.
const fnModel = /const FN_MODEL_DEFAULTS = (\{[^}]*\});/.exec(fs.readFileSync(repo('core.js'), 'utf8'));
if (!fnModel) throw new Error('FN_MODEL_DEFAULTS not found in core.js');
vm.runInContext(`var FN_MODEL_DEFAULTS = ${fnModel[1]};`, ctx);
for (const f of ['propagation-physics.js', 'propagation-scene.js', 'propagation-fade.js', 'packets.js']) {
  vm.runInContext(fs.readFileSync(repo(f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.PH = PropPhysics; this.PS = PropScene; this.PK = Packets; this.FD = PropFade;', ctx);
const { PH, PS, PK, FD } = ctx;
// What the fade bench restates, lifted from where each is set.
const lift = (file, re, what) => {
  const m = re.exec(fs.readFileSync(repo(file), 'utf8'));
  if (!m) throw new Error(`${what} not found in ${file}`);
  return m[1];
};
const LB_LOSS = Number(lift('link-budget.js', /const LB_DEFAULT_LOSS_DB = ([\d.]+);/, 'LB_DEFAULT_LOSS_DB'));
const LB_MINS = [...lift('link-budget.js', /const LB_MARGIN = \[([\s\S]*?)\];/, 'LB_MARGIN').matchAll(/min:\s*(-?[\d.]+)/g)].map(m => Number(m[1]));
const AGL = Number(lift('path-profile.js', /const PATH_DEFAULT_AGL = ([\d.]+);/, 'PATH_DEFAULT_AGL'));
const NR_MAX = Number(lift('network-review.js', /const ATTEN_MAX = (\d+);/, 'ATTEN_MAX'));
const NR_STEP = Number(lift('network-review.js', /const ATTEN_STEP = (\d+);/, 'ATTEN_STEP'));
const PT_DEFAULT_DBI = Number(lift('link-budget.js', /def: \{ tx_w: 1, loss_db: LB_DEFAULT_LOSS_DB, gain_dbi: ([\d.]+)/, 'the point end\'s gain'));

console.log('\nThe physics — against figures worked by hand\n');
ok('a wavelength at 151.5 MHz is 1.979 m', near(PH.wavelengthM(151.5), 1.9788, 0.0005), PH.wavelengthM(151.5));
ok('radio covers 300 m in a microsecond: 30 km in 100.07 µs', near(PH.delayUs(30), 100.07, 0.01), PH.delayUs(30));
ok('free-space loss over 1 km at 100 MHz is 72.45 dB', near(PH.fsplDb(1, 100), 72.45, 1e-9));
ok('…and 6 dB more for every doubling of distance', near(PH.fsplDb(20) - PH.fsplDb(10), 6.02, 0.01));
ok('the first Fresnel zone mid-way along 20 km at 151.5 MHz is 99.5 m', near(PH.fresnelM(10, 10), 99.47, 0.05), PH.fresnelM(10, 10));
ok('…narrower at a higher frequency', PH.fresnelM(10, 10, 2400) < PH.fresnelM(10, 10, 151.5) / 3);
ok('the Earth stands 23.5 m into the middle of a 40 km path (k = 4/3)', near(PH.earthBulgeM(20, 20), 23.54, 0.02), PH.earthBulgeM(20, 20));
ok('a 20 m mast sees 18.4 km to the radio horizon', near(PH.horizonKm(20), 18.43, 0.02), PH.horizonKm(20));
ok('a knife edge exactly on the line costs 6.0 dB', near(PH.knifeDb(0), 6.03, 0.02), PH.knifeDb(0));
ok('…and nothing once it is well below it', PH.knifeDb(-1) === 0 && PH.knifeDb(PH.knifeNu(-100, 5, 5)) === 0);
ok('…but still something just under the line, inside the Fresnel zone', PH.knifeDb(PH.knifeNu(-20, 5, 5)) > 1);
ok('…and more the further it stands above', PH.knifeDb(PH.knifeNu(50, 5, 5)) > PH.knifeDb(PH.knifeNu(10, 5, 5)));
ok('ν for 10 m over a 10 km path, mid-way, at 151.5 MHz is 0.201',
  near(PH.knifeNu(10, 5, 5), 10 * Math.sqrt(2 * 10000 / (PH.wavelengthM() * 5000 * 5000)), 1e-12)
  && near(PH.knifeNu(10, 5, 5), 0.201, 0.001), PH.knifeNu(10, 5, 5));
const fol150 = PH.foliageDb(300, 151.5), fol2400 = PH.foliageDb(300, 2400);
ok('300 m of trees costs an ALERT link a few decibels', fol150 > 2 && fol150 < 10, fol150.toFixed(2));
ok('…and a 2.4 GHz link tens of decibels', fol2400 > 30, fol2400.toFixed(2));
ok('foliage loss grows with depth and never passes its ceiling',
  PH.foliageDb(100) < PH.foliageDb(200) && PH.foliageDb(1e6) <= PH.foliageMax() + 1e-9 && PH.foliageDb(0) === 0);
const lam = PH.wavelengthM();
ok('two equal copies in step add to +6.02 dB', near(PH.twoPathDb(0, 0), 6.02, 0.01));
ok('…a whole wavelength apart, the same', near(PH.twoPathDb(lam, 0), 6.02, 0.01));
ok('…half a wavelength apart, to nothing', PH.twoPathDb(lam / 2, 0) < -100);
ok('…and an echo 6 dB down, half a wavelength late, to −6.02 dB', near(PH.twoPathDb(lam / 2, -6.0206), -6.02, 0.01));
ok('a bit at 300 baud is 3.33 ms and a frame 133 ms, a keying half a second',
  near(PH.BIT_MS, 3.333, 0.001) && near(PH.FRAME_MS, 133.33, 0.01) && near(PH.KEYING_MS, 500, 1e-9));

console.log('\nThe frame — the ALERT Packets tab\'s own decoder agrees\n');
const bitsStr = b => b.join('');
let agree = 0, tried = 0;
const rnd = PH.rng(99);
for (let i = 0; i < 500; i++) {
  const a = Math.floor(rnd() * 8192), v = Math.floor(rnd() * 2048);
  const bits = PH.encodeAbf(a, v);
  const r = PK.decodeMessage(bitsStr(bits)).results.find(x => x.format === 'abf');
  const back = PH.decodeAbf(bits);
  tried++;
  if (r.valid && r.values.A === a && r.values.D === v && back.ok && back.addr === a && back.value === v) agree++;
}
ok(`encodeAbf → packets.js reads the same address and value, checks good (${agree}/${tried})`, agree === tried);
const air = PH.onAirBits(PH.encodeAbf(1234, 412));
ok('on the air: 40 bits, each word between a 0 start bit and a 1 stop bit',
  air.length === 40 && [0, 10, 20, 30].every(j => air[j].bit === 0 && air[j].data === -1)
  && [9, 19, 29, 39].every(j => air[j].bit === 1 && air[j].data === -1));
{
  const bits = PH.encodeAbf(2051, 37);
  const j = PH.ABF_MAP.findIndex(([k, i]) => k === 'A' && i === 9);
  bits[j] ^= 1;
  const d = PH.decodeAbf(bits);
  const r = PK.decodeMessage(bitsStr(bits)).results.find(x => x.format === 'abf');
  ok('a flipped address bit 9 passes, as 2563 — and packets.js accepts it too', d.ok && d.addr === 2563 && r.valid && r.values.A === 2563);
  const bits2 = PH.encodeAbf(2051, 37);
  const c = PH.ABF_MAP.findIndex(([k]) => k === 'K');
  bits2[c] ^= 1;
  const d2 = PH.decodeAbf(bits2);
  const r2 = PK.decodeMessage(bitsStr(bits2)).results.find(x => x.format === 'abf');
  ok('a flipped check bit is caught, by both', !d2.ok && d2.badChecks.includes(c) && !r2.valid);
}

console.log('\nThe receiver\n');
const frame = (addr, value) => PH.encodeAbf(addr, value);
{
  const [r] = PH.receive([{ id: 'a', startMs: 0, dbm: -90, bits: frame(1234, 412) }]);
  ok('a keying on its own is decoded cleanly', r.status === 'clean' && r.decoded.addr === 1234 && r.decoded.value === 412);
  const weak = PH.receive([{ id: 'a', startMs: 0, dbm: -125, bits: frame(1234, 412) }])[0];
  ok('below the receiver\'s floor it is too weak', weak.status === 'weak');
  const cap = PH.receive([{ id: 'a', startMs: 0, dbm: -80, bits: frame(1234, 412) },
                          { id: 'b', startMs: 50, dbm: -90, bits: frame(2051, 37) }]);
  ok('10 dB ahead on top of another, the stronger is clean and the weaker lost (capture)',
    cap[0].status === 'clean' && cap[1].status === 'lost', cap.map(r => r.status).join(', '));
  let spoilt = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const ev = PH.receive([{ id: 'a', startMs: 0, dbm: -90, bits: frame(1234, 412) },
                           { id: 'b', startMs: 0, dbm: -90, bits: frame(2051, 37) }], { seed });
    if (ev.every(r => r.status !== 'clean')) spoilt++;
  }
  ok('two even keyings on top of each other spoil each other (nearly always)', spoilt >= 18, `${spoilt}/20 seeds`);
  const apart = PH.receive([{ id: 'a', startMs: 0, dbm: -90, bits: frame(1234, 412) },
                            { id: 'b', startMs: 600, dbm: -90, bits: frame(2051, 37) }]);
  ok('a keying apart, both are clean', apart.every(r => r.status === 'clean' && !r.overlap));
  const once = JSON.stringify(PH.receive([{ id: 'a', startMs: 0, dbm: -90, bits: frame(1234, 412) },
                                          { id: 'b', startMs: 40, dbm: -92, bits: frame(2051, 37) }], { seed: 7 }));
  const again = JSON.stringify(PH.receive([{ id: 'a', startMs: 0, dbm: -90, bits: frame(1234, 412) },
                                           { id: 'b', startMs: 40, dbm: -92, bits: frame(2051, 37) }], { seed: 7 }));
  ok('the same seed draws the same flips', once === again);
}

console.log('\nThe scene — the made-up catchment and its stories\n');
{
  const shadow = PS.paths('fs1', 'r2')[0];
  ok('Hill B hears the creek only round Mt Ridge: diffracted, 15–35 dB lost bending',
    shadow.kind === 'diffracted' && shadow.losses.diffraction > 15 && shadow.losses.diffraction < 35,
    `${shadow.kind}, ${shadow.losses.diffraction.toFixed(1)} dB`);
  ok('…and the wave over the crest is longer than the straight line',
    shadow.km > Math.hypot(...[0, 1, 2].map(i => PS.antenna(PS.STATIONS[0])[i] - PS.antenna(PS.STATIONS[3])[i])));
  const view = PS.paths('fs1', 'r1')[0];
  ok('Hill A hears the creek directly, through the trees, a few decibels down',
    view.kind === 'direct' && view.losses.foliage > 2 && view.losses.foliage < 10, `${view.kind}, ${view.losses.foliage.toFixed(1)} dB of trees`);
  const echoes = PS.paths('r1', 'b1', { echoes: true });
  const kinds = echoes.map(p => p.kind);
  ok('the Town base hears Hill A four ways: direct, ground, silos, scarp',
    ['direct', 'ground', 'building', 'mountain'].every(k => kinds.includes(k)), kinds.join(', '));
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const len = a => Math.hypot(...a);
  for (const R of PS.REFLECTORS) {
    const p = echoes.find(x => x.label === R.label);
    if (!p) { ok(`an echo off ${R.label}`, false); continue; }
    const q = p.pts[1];
    const off = Math.abs(sub(q, R.p0).reduce((s, v, i) => s + v * R.n[i], 0));
    const a = p.pts[0], b = p.pts[2];
    const da = sub(a, R.p0).reduce((s, v, i) => s + v * R.n[i], 0);
    const img = a.map((v, i) => v - 2 * da * R.n[i]);
    ok(`the echo off the ${R.label.toLowerCase()} bounces on its face, and its path is the mirror image's`,
      off < 1e-9 && near(p.km, len(sub(b, img)), 1e-9), `${off}, ${p.km} vs ${len(sub(b, img))}`);
  }
  const scarp = echoes.find(p => p.kind === 'mountain');
  ok('the scarp\'s echo is kilometres longer and microseconds late — a thousandth of a bit',
    scarp.dKm > 1 && scarp.dUs > 3 && scarp.dUs < 20 && scarp.dUs / 1000 < PH.BIT_MS / 100, `${scarp.dUs.toFixed(2)} µs`);
  const ground = echoes.find(p => p.kind === 'ground');
  ok('the ground bounce is about a metre longer than the direct path', ground.dKm * 1000 > 0.2 && ground.dKm * 1000 < 4,
    `${(ground.dKm * 1000).toFixed(2)} m`);
  const sums = [];
  for (let m = 4; m <= 40; m += 0.5) {
    PS.setBaseHeight(m);
    const ps = PS.paths('r1', 'b1', { echoes: true });
    sums.push(PH.phasorSum(ps.map(p => ({ db: p.dbm, phase: p.rel }))).db - ps[0].dbm);
  }
  PS.setBaseHeight(15);
  ok('raising the Town base\'s mast swings the sum by more than 6 dB, reinforcing and cancelling',
    Math.max(...sums) - Math.min(...sums) > 6 && Math.max(...sums) > 0 && Math.min(...sums) < 0,
    `${Math.min(...sums).toFixed(1)} … ${Math.max(...sums).toFixed(1)} dB`);

  const copies = (st, rx) => st.receptions[rx].filter(r => st.keyings.find(k => k.key === r.key).via);
  const home = PS.buildStory('home');
  ok('A reading goes home: both bases get two clean copies of 1234, by two repeaters',
    ['b1', 'b2'].every(b => { const c = copies(home, b); return c.length === 2 && c.every(r => r.result.status === 'clean' && r.result.decoded.addr === 1234); }));
  const r2key = home.keyings.find(k => k.who === 'r2');
  ok('…Hill B keys once the creek is done, plus its 600 ms', near(r2key.startMs, home.keyings[0].startMs + PH.KEYING_MS + 600, 0.2), r2key.startMs);
  const same = PS.buildStory('same');
  const ghosts = ['b1', 'b2'].flatMap(b => copies(same, b)).filter(r => r.result.status === 'flipped');
  ok('Two repeaters, one delay: a base files the rain gauge under a ghost one bit from 2051',
    ghosts.some(r => { const x = r.result.decoded.addr ^ 2051; return x && !(x & (x - 1)); }),
    ghosts.map(r => r.result.decoded.addr).join(', '));
  const staggered = PS.buildStory('same', { r2: 600 });
  ok('…and with Hill B on 600 ms every repeater copy at both bases is clean',
    ['b1', 'b2'].every(b => copies(staggered, b).every(r => r.result.status === 'clean')));
  const both = PS.buildStory('both');
  const relayed = both.keyings.filter(k => k.who === 'r1');
  ok('Two stations at once: Hill A relays the rain gauge as a ghost, and not the creek',
    relayed.length === 1 && relayed[0].origin === 'fs2' && PH.decodeAbf(relayed[0].bits).addr !== 2051
    && relayed[0].heardAs.flips.length <= 2, relayed.map(k => `${k.origin}→${PH.decodeAbf(k.bits).addr}`).join(', '));
  ok('…while Hill B, hearing the rain gauge far ahead, captures it cleanly',
    both.receptions.r2.find(r => r.from === 'fs2').result.status === 'clean'
    && both.receptions.r2.find(r => r.from === 'fs1').result.status === 'lost');
  const flight = both.segs.find(s => s.flight), slow = both.segs.find(s => !s.flight);
  ok('the clock: a flight shown about 35,000× slower, the rest 6×',
    near((flight.d1 - flight.d0) / (flight.r1 - flight.r0), 35000, 1) && near((slow.d1 - slow.d0) / (slow.r1 - slow.r0), 6, 1e-9));
}


console.log('\nThe fade-margin test — the bench\'s arithmetic\n');
{
  ok('its receiver is the link budget card\'s −117 dBm', FD.RX_DBM === PH.SENS_DBM && FD.RX_DBM === -117);
  ok('its feeders, bands and whip are the link budget card\'s, its attenuator the Network Review\'s',
    FD.FEED_DB === LB_LOSS && FD.GOOD_DB === LB_MINS[0] && FD.FLOOR_DB === LB_MINS[1] && FD.FIELD_AGL === AGL
    && FD.ATTEN_MAX === NR_MAX && FD.STEPS.includes(NR_STEP),
    JSON.stringify({ LB_LOSS, LB_MINS, AGL, NR_MAX, NR_STEP }));
  ok('1 W is 30 dBm, 5 W 36.99 and 25 W 43.98: 6.99 dB a step',
    near(FD.wattsToDbm(1), 30, 1e-12) && near(FD.wattsToDbm(5), 36.99, 0.005) && near(FD.wattsToDbm(25), 43.98, 0.005)
    && near(FD.dbmToWatts(FD.wattsToDbm(25)), 25, 1e-9));
  const dbi = id => FD.ANTENNAS[id].dbd + FD.DIPOLE_DBI;
  ok('a dBd is 2.15 dB more in dBi: unity 2.15, the 3 dB collinear the link budget card\'s own 5.15, the Yagi 11.15',
    near(dbi('unity'), 2.15, 1e-12) && near(dbi('col3'), PT_DEFAULT_DBI, 1e-12) && near(dbi('yagi'), 11.15, 1e-12)
    && FD.RX_GAIN_DBI === PT_DEFAULT_DBI);

  const o = { w: 5, ant: 'col3', country: 'light', km: 30, hb: 100, atten: 12 };
  const B = FD.budget(o);
  const sum = FD.wattsToDbm(5) - 12 - FD.FEED_DB + dbi('col3') - FD.pathLossDb(30, 'light', 100) + FD.RX_GAIN_DBI - FD.FEED_DB;
  ok('the budget is a sum: transmitter − attenuator − feeder + antenna − path + repeater antenna − feeder',
    near(B.rx, sum, 1e-9) && B.stages[B.stages.length - 1].level === B.rx && near(B.margin, B.rx + 117, 1e-12)
    && B.stages.length === 7, `${B.rx.toFixed(3)} vs ${sum.toFixed(3)}`);
  let perDb = true, step3 = true, apart = true;
  for (const w of [1, 5, 25]) for (let a = 0; a < 30; a++) {
    const m0 = FD.budget({ ...o, w, atten: a }).margin, m1 = FD.budget({ ...o, w, atten: a + 1 }).margin;
    if (!near(m0 - m1, 1, 1e-9)) perDb = false;
    const p0 = FD.dbmToWatts(FD.budget({ ...o, w, atten: a }).intoAnt);
    const p3 = FD.dbmToWatts(FD.budget({ ...o, w, atten: a + 3 }).intoAnt);
    if (!near(p3 / p0, 0.5012, 0.0001)) step3 = false;
  }
  for (let a = 0; a <= 30; a += 3) {
    const m = w => FD.budget({ ...o, w, atten: a }).margin;
    if (!near(m(5) - m(1), 6.99, 0.005) || !near(m(25) - m(1), 13.98, 0.005)) apart = false;
  }
  ok('every decibel on the attenuator is a decibel off the margin, at 1, 5 and 25 W alike', perDb);
  ok('…and a 3 dB step halves the power into the antenna, whatever the transmitter', step3);
  ok('…so 5 W sits 6.99 dB above 1 W at every setting, and 25 W 13.98', apart);

  ok('Hata, urban, 20 km, a repeater 100 m up and a 4 m whip, at 151.5 MHz: 136.13 dB (a(hm) 4.19 dB)',
    near(FD.hataDb(20, 'urban', 100), 136.13, 0.005), FD.hataDb(20, 'urban', 100).toFixed(3));
  ok('…its suburban class 6.48 dB less and its open class 23.70 less, Hata\'s own corrections',
    near(FD.hataDb(20, 'urban', 100) - FD.hataDb(20, 'suburban', 100), 6.475, 0.001)
    && near(FD.hataDb(20, 'urban', 100) - FD.hataDb(20, 'open', 100), 23.698, 0.001));
  ok('…and the path never loses less than free space', FD.pathLossDb(2, 'open', 200) >= PH.fsplDb(2) - 1e-9
    && FD.pathLossDb(2, 'open', 200) > FD.hataDb(2, 'open', 200));
  const H = FD.horizonKm(100);
  ok('the radio horizon from a 4 m whip to a repeater 100 m up is 49.5 km (8.2 + 41.2)', near(H, 49.47, 0.02), H.toFixed(2));
  const near40 = Math.max(FD.hataDb(H + 10, 'light' === 'light' ? 'suburban' : '', 100), PH.fsplDb(H + 10));
  ok('past it, ITU-R P.526\'s smooth Earth adds 0.49 dB a kilometre',
    near(FD.shadowDbPerKm(), 0.493, 0.001) && near(FD.pathLossDb(H + 10, 'light', 100) - near40, 10 * FD.shadowDbPerKm(), 1e-9),
    FD.shadowDbPerKm().toFixed(4));
  ok('the bench opens on a margin the attenuator can find: 5 W, 3 dB collinear, 30 km of light timber, 28.0 dB',
    near(FD.stationMargin(), 28.0, 0.05), FD.stationMargin().toFixed(3));

  const r = FD.reading;
  const show = x => JSON.stringify({ reading: x.reading, hi: x.hi, sent: x.sent, atLeast: x.atLeast });
  ok('28 dB in 3 dB steps reads 27, between 27 and 30, after 11 transmissions; in 5 dB steps 25 (25–30) after 7',
    r(28, 3).reading === 27 && r(28, 3).hi === 30 && r(28, 3).sent === 11
    && r(28, 5).reading === 25 && r(28, 5).hi === 30 && r(28, 5).sent === 7, show(r(28, 3)) + show(r(28, 5)));
  ok('9.5 dB: 3 dB steps read 9 (9–12), 5 dB steps 5 (5–10)',
    r(9.5, 3).reading === 9 && r(9.5, 3).hi === 12 && r(9.5, 5).reading === 5 && r(9.5, 5).hi === 10);
  ok('a margin exactly on a setting reads that setting', r(27, 3).reading === 27 && r(10, 5).reading === 10);
  ok('past the attenuator\'s 30 dB both read "at least 30", every setting sent',
    r(34, 3).atLeast && r(34, 3).reading === 30 && r(34, 3).sent === 11 && r(34, 5).atLeast && r(34, 5).sent === 7);
  ok('a link short at 0 dB reads nothing, after one transmission', r(-2, 3).reading === null && r(-2, 3).sent === 1);
  let s3 = 0, s5 = 0, n = 0, w3 = 0, w5 = 0, good5 = true, good3 = true, floor3 = true, floor5 = true;
  const seen3 = new Set(), seen5 = new Set();
  for (let M = 0; M < 30; M += 0.01) {
    const a = r(M, 3), b = r(M, 5);
    s3 += M - a.reading; s5 += M - b.reading; n++;
    w3 = Math.max(w3, M - a.reading); w5 = Math.max(w5, M - b.reading);
    if ((b.reading >= 10) !== (M >= 10)) good5 = false;
    if ((a.reading >= 10) !== (M >= 10)) good3 = false;
    if ((a.reading >= 3) !== (M >= 3)) floor3 = false;
    if ((b.reading >= 3) !== (M >= 3)) floor5 = false;
    if (a.reading >= 3 && a.reading < 10) seen3.add(a.reading);
    if (b.reading >= 3 && b.reading < 10) seen5.add(b.reading);
  }
  ok('over every margin from 0 to 30 dB, 3 dB steps read 1.5 dB short on average and 5 dB steps 2.5',
    near(s3 / n, 1.5, 0.01) && near(s5 / n, 2.5, 0.01), `${(s3 / n).toFixed(3)}, ${(s5 / n).toFixed(3)}`);
  ok('…and at worst just under 3 and just under 5', w3 < 3 && w3 > 2.98 && w5 < 5 && w5 > 4.98);
  ok('inside Marginal (3–10 dB) 3 dB steps read 3, 6 or 9, and 5 dB steps only 5',
    [...seen3].sort((x, y) => x - y).join() === '3,6,9' && [...seen5].join() === '5');
  ok('5 dB steps settle "Good, 10 dB or more?" exactly and 3 dB steps cannot', good5 && !good3);
  ok('…and 3 dB steps settle the 3 dB floor exactly and 5 dB steps cannot', floor3 && !floor5);
  const cf = FD.coarseFine;
  ok('5 dB steps then 1 dB clicks: 28 reads 28 (28–29) in 11 transmissions, 26.4 reads 26 in 9',
    cf(28).reading === 28 && cf(28).hi === 29 && cf(28).sent === 11 && cf(26.4).reading === 26 && cf(26.4).sent === 9,
    show(cf(28)) + show(cf(26.4)));

  const at = (q, need) => FD.budget({ ...q, km: FD.rangeKm(q, need), atten: 0 }).margin;
  const q = { w: 5, ant: 'col3', country: 'light', km: 30, hb: 100 };
  const rg = (over) => FD.rangeKm({ ...q, ...over }, 10);
  ok('the Good range is where 10 dB is left to spare', near(at(q, 10), 10, 0.01) && near(at(q, 3), 3, 0.01));
  ok('…and it grows with power, with the antenna, with the repeater\'s height, and shrinks under timber',
    rg({ w: 1 }) < rg({}) && rg({}) < rg({ w: 25 }) && rg({ ant: 'unity' }) < rg({}) && rg({}) < rg({ ant: 'yagi' })
    && rg({ hb: 50 }) < rg({}) && rg({ country: 'dense' }) < rg({}) && rg({}) < rg({ country: 'open' }),
    [rg({ w: 1 }), rg({}), rg({ w: 25 })].map(x => x.toFixed(1)).join(' < '));
  ok('watts written readably — 25 W, 25 mW, 2 fW — and in full, 0.000 000 000 000 002 W',
    FD.fmtW(25) === '25 W' && FD.fmtW(0.025) === '25 mW' && FD.fmtW(FD.dbmToWatts(-117)) === '2 fW'
    && FD.zerosW(FD.dbmToWatts(-117)) === '0.000 000 000 000 002 W', FD.zerosW(FD.dbmToWatts(-117)));
}

// ── Chromium: the tab ────────────────────────────────────────────────────────
console.log('\nThe tab\n');
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('propagation'));
  await page.waitForTimeout(900);

  const painted = await page.evaluate(() => {
    // Does a canvas hold any pixel that is not one flat colour?
    const has = id => {
      const cv = document.getElementById(id);
      if (!cv || !cv.width || !cv.height) return false;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 4; i < d.length; i += 4 * 7) {
        if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return true;
      }
      return false;
    };
    return Object.fromEntries(['rp-scene', 'rp-lanes', 'rp-sum', 'rp-field', 'rp-trace', 'rp-prof', 'rp-bitcv', 'rp-timecv']
      .map(id => [id, has(id)]));
  });
  ok('every drawing on the tab has something drawn on it', Object.values(painted).every(Boolean), JSON.stringify(painted));
  ok('the story is told in words, a line a moment', await page.evaluate(() => document.querySelectorAll('#rp-story li').length >= 6));
  ok('what each receiver made of it: four cards, Town base among them',
    await page.evaluate(() => document.querySelectorAll('.rp-rx-card').length === 4 && /Town base/.test(document.getElementById('rp-rx').textContent)));
  ok('it is playing', await page.evaluate(() => PropScene.playing()));
  ok('its teardown is registered by its own file', await page.evaluate(() => _tabTeardowns.has('Propagation')));

  await page.click('label[for="rp-sc-same"]');
  await page.waitForTimeout(200);
  const sameTxt = await page.evaluate(() => ({ blurb: document.getElementById('rp-sc-blurb').textContent,
                                               rx: document.getElementById('rp-rx').textContent }));
  ok('picking "Two repeaters, one delay" tells that story and files a ghost at a base',
    /same delay/.test(sameTxt.blurb) && /2563/.test(sameTxt.rx), sameTxt.blurb.slice(0, 60));
  await page.click('#rp-sc-action button');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ d: PropScene.delays().r2, out: document.getElementById('rp-d-r2-out').textContent,
                                             flipped: document.querySelectorAll('.rp-rx-row--flipped').length }));
  ok('its button gives Hill B 600 ms, says so beside the slider, and the ghosts are gone',
    after.d === 600 && after.out === '600 ms' && after.flipped === 0, JSON.stringify(after));

  await page.click('label[for="rp-sc-echo"]');
  await page.waitForTimeout(200);
  const echo = await page.evaluate(() => ({ shown: !document.getElementById('rp-echo').hidden,
                                            rows: document.querySelectorAll('#rp-echo tbody tr').length }));
  ok('"Echoes in town" opens the Town base\'s four copies', echo.shown && echo.rows === 4, JSON.stringify(echo));
  const before = await page.evaluate(() => document.querySelector('#rp-echo .rp-readout').textContent);
  await page.evaluate(() => { const r = document.getElementById('rp-mast'); r.value = '9'; r.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(150);
  const mast = await page.evaluate(() => ({ out: document.getElementById('rp-mast-out').textContent, m: PropScene.baseMast(),
                                            txt: document.querySelector('#rp-echo .rp-readout').textContent }));
  ok('moving the mast slider moves the base and changes the sum', mast.m === 9 && mast.out === '9.0 m' && mast.txt !== before, mast.out);

  await page.click('#rp-l-drape');
  ok('Coverage on shows its key', await page.evaluate(() => !document.getElementById('rp-drape-key').hidden && PropScene.layers().drape));
  await page.click('#rp-l-drape');

  // Section 4: the collision, said as the sliders move.
  const say = async (id, v) => {
    await page.evaluate(([id, v]) => { const r = document.getElementById(id); r.value = String(v); r.dispatchEvent(new Event('input')); }, [id, v]);
    return page.evaluate(() => document.getElementById('rp-bit-out').textContent.replace(/\s+/g, ' '));
  };
  let t = await say('rp-b-rel', 12);
  ok('the rain gauge 12 dB ahead: it is decoded cleanly and the creek is lost', /Rain gauge \(sent 2051 = 37\): ✓/.test(t) && /Creek gauge \(sent 1234 = 412\): ✗ lost/.test(t), t.slice(0, 160));
  t = await say('rp-b-off', 700);
  ok('a keying apart: both clean, and it says they do not touch', /do not touch/.test(t) && (t.match(/✓/g) || []).length === 2);
  await say('rp-b-rel', -3);
  await say('rp-b-off', 60);

  // Section 5: the delays.
  const timing = async (a, b) => {
    for (const [id, v] of [['rp-t-a', a], ['rp-t-b', b]]) {
      await page.evaluate(([id, v]) => { const r = document.getElementById(id); r.value = String(v); r.dispatchEvent(new Event('input')); }, [id, v]);
    }
    return page.evaluate(() => document.getElementById('rp-t-out').textContent.replace(/\s+/g, ' '));
  };
  t = await timing(0, 0);
  ok('the same delay: the frames overlap, bits on bits', /bits land on bits/.test(t), t.slice(0, 80));
  t = await timing(0, 600);
  ok('600 ms apart: nothing touches and both copies are clean', /nothing touches/.test(t) && (t.match(/clean/g) || []).length === 2, t);


  // Section 6: the fade-margin test.
  const fd = () => page.evaluate(() => {
    const t = id => document.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
    const items = [...document.querySelectorAll('#rp-fm-proc li')];
    return { s: PropFade.state(), status: t('rp-fm-status'), reading: t('rp-fm-reading'), tiles: t('rp-fm-tiles'),
             out: t('rp-fm-att-out'), manual: document.getElementById('rp-fmmode-manual').checked,
             log: [...document.querySelectorAll('#rp-fm-log li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
             proc: items.length, now: items.findIndex(li => li.classList.contains('is-now')) };
  });
  ok('the contents list goes to the fade-margin test, section 6',
    await page.evaluate(() => [...document.querySelectorAll('.rp-toc-btn')]
      .some(b => /6 · Fade-margin test/.test(b.textContent) && /rp-fade/.test(b.getAttribute('onclick')))));
  await page.evaluate(() => document.getElementById('rp-fm-bench').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(3800);
  let f = await fd();
  ok('Auto runs the test by itself: 3 dB steps from 0 dB, a transmission each, every one heard so far',
    f.s.mode === 'auto' && f.s.playing && f.s.log.length >= 2 && f.s.log.every((x, i) => x.a === i * 3 && x.pass),
    JSON.stringify(f.s.log.map(x => x.a)));
  ok('…lighting the step of the procedure it is on, and saying where it has got to',
    f.proc === 7 && f.now >= 1 && /Auto — 3 dB steps: setting \d+ of 11/.test(f.status), `${f.now} · ${f.status}`);
  const fdPainted = await page.evaluate(() => ['rp-fm-bench', 'rp-fm-ladder', 'rp-fm-steps', 'rp-fm-stair'].map(id => {
    const cv = document.getElementById(id);
    if (!cv || !cv.width) return false;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 4; i < d.length; i += 4 * 7) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return true;
    return false;
  }));
  ok('its four drawings have something drawn on them', fdPainted.every(Boolean), JSON.stringify(fdPainted));

  await page.evaluate(() => { const r = document.getElementById('rp-fm-att'); r.value = '24'; r.dispatchEvent(new Event('input')); });
  f = await fd();
  ok('touching the attenuator hands it over: Manual, at 24 dB, said beside it and on the tiles',
    f.s.mode === 'manual' && !f.s.playing && f.manual && f.s.atten === 24 && f.out === '24 dB' && /Manual/.test(f.status)
    && /Attenuator 24 dB/.test(f.tiles), f.status);
  await page.click('#rp-fm-clear');
  await page.click('#rp-fm-send');
  await page.waitForTimeout(1300);
  f = await fd();
  ok('📡 at 24 dB: heard, at −113.0 dBm with 4.0 dB to spare', f.log.length === 1
    && /^24 dB ✓ heard — −113\.0 dBm, 4\.0 dB to spare$/.test(f.log[0]), f.log[0]);
  await page.evaluate(() => { const r = document.getElementById('rp-fm-att'); r.value = '30'; r.dispatchEvent(new Event('input')); });
  await page.click('#rp-fm-send');
  await page.waitForTimeout(1300);
  f = await fd();
  ok('…at 30 dB missed, and the reading books 24 dB with the truth between 24 and 30',
    /^30 dB ✗ missed/.test(f.log[1] || '') && /book a fade margin of 24 dB — the truth is somewhere from 24 to 30 dB/.test(f.reading),
    f.reading.slice(0, 140));
  await page.click('#rp-fm-down');
  ok('− one step takes 3 dB off', (await fd()).s.atten === 27);
  const mtx = () => page.evaluate(() => ({
    rows: document.querySelectorAll('#rp-fm-matrix tbody tr').length,
    heads: document.querySelectorAll('#rp-fm-matrix thead th').length,
    here: (document.querySelector('#rp-fm-matrix .rp-fm-c--here') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    first: [...document.querySelectorAll('#rp-fm-matrix tbody tr:first-child td strong')].map(x => Number(x.textContent.replace('−', '-').replace(' dBm', ''))),
  }));
  let mt = await mtx();
  ok('the table: a row a 3 dB step and a column a transmitter, 7 dB apart, this setting marked',
    mt.rows === 11 && mt.heads === 4 && /1\.0 dB to spare/.test(mt.here)
    && near(mt.first[1] - mt.first[0], 7, 0.05) && near(mt.first[2] - mt.first[1], 7, 0.05), JSON.stringify(mt));
  await page.click('label[for="rp-fmw-25"]');
  f = await fd();
  ok('25 W: the fade margin 6.99 dB higher than at 5 W, and the tests sent at 5 W cleared',
    f.s.w === 25 && near(f.s.margin - 28.035, 6.99, 0.01) && f.s.log.length === 0, f.s.margin.toFixed(2));
  await page.click('label[for="rp-fmw-5"]');
  await page.click('label[for="rp-fmstep-5"]');
  mt = await mtx();
  const before5 = (await fd()).s.atten;
  await page.click('#rp-fm-down');
  ok('5 dB steps: seven rows in the table, and ± moves the attenuator 5 dB',
    mt.rows === 7 && (await fd()).s.atten === before5 - 5, `${mt.rows} rows, ${before5} → ${(await fd()).s.atten}`);
  const cmp = await page.evaluate(() => [...document.querySelectorAll('#rp-fm-cmp tbody tr')].map(tr => [...tr.cells].map(c => c.textContent.trim())));
  ok('the comparison: 11 settings against 7, and this link read as 27 dB in 3 dB steps and 25 dB in 5',
    cmp[0][1] === '11' && cmp[0][2] === '7' && cmp[2][1] === '27 dB' && cmp[2][2] === '25 dB', JSON.stringify(cmp.slice(0, 3)));
  const reach = await page.evaluate(() => [...document.querySelectorAll('.rp-fm-rtxt')].map(x => Number(/Good to (\d+) km/.exec(x.textContent)[1])));
  ok('the reach: a bar each, 25 W further than 5 W further than 1 W', reach.length === 3 && reach[0] < reach[1] && reach[1] < reach[2],
    reach.join(' < '));
  await page.click('label[for="rp-fmview-w"]');
  ok('the ladder draws in watts too', (await fd()).s.view === 'w');
  await page.click('label[for="rp-fmview-db"]');
  await page.click('label[for="rp-fmstep-3"]');
  await page.click('label[for="rp-fmmode-auto"]');
  f = await fd();
  ok('Auto again: running, from 0 dB', f.s.mode === 'auto' && f.s.playing && f.s.log.every(x => x.a % 3 === 0));

  // Out and back.
  await page.evaluate(() => switchTab('stations'));
  await page.waitForTimeout(200);
  const gone = await page.evaluate(() => ({ story: PropScene.story(), page: !!document.getElementById('rp-page') }));
  ok('leaving the tab takes the scene down', gone.story === null && !gone.page);
  await page.evaluate(() => switchTab('propagation'));
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => ({ sc: PropScene.scenario(), playing: PropScene.playing(),
                                            checked: document.getElementById('rp-sc-echo').checked }));
  ok('coming back starts it again, on the story that was open', back.sc === 'echo' && back.playing && back.checked, JSON.stringify(back));

  // Reduced motion: still, at the outcome.
  const still = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const sp = await still.newPage();
  await applyNetworkPolicy(sp, server.origin);
  sp.on('pageerror', e => errors.push(e.message));
  await sp.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await sp.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await sp.evaluate(() => switchTab('propagation'));
  await sp.waitForTimeout(500);
  const r = await sp.evaluate(() => ({ playing: PropScene.playing(), now: PropScene.now(), end: PropScene.story().endMs,
                                       lit: document.querySelectorAll('#rp-story li.is-past, #rp-story li.is-now').length,
                                       all: document.querySelectorAll('#rp-story li').length,
                                       label: document.getElementById('rp-play').textContent }));
  ok('asked for reduced motion, it stands still at the outcome, every line of the story reached, ▶ to run it',
    !r.playing && r.now === r.end && r.lit === r.all && /Play/.test(r.label), JSON.stringify(r));
  const fr = await sp.evaluate(() => ({ s: PropFade.state(), label: document.getElementById('rp-fm-play').textContent,
                                        reading: document.getElementById('rp-fm-reading').textContent.replace(/\s+/g, ' ') }));
  ok('…and the fade-margin bench at its outcome: 0 to 27 dB heard, 30 missed, 27 dB booked, ▶ to run it',
    fr.s.mode === 'auto' && !fr.s.playing && fr.s.phase === 'done' && fr.s.log.length === 11
    && fr.s.log.slice(0, 10).every(x => x.pass) && !fr.s.log[10].pass && /book a fade margin of 27 dB/.test(fr.reading)
    && /Run the test/.test(fr.label), JSON.stringify({ n: fr.s.log.length, phase: fr.s.phase, label: fr.label }));
  await still.close();
} finally {
  await browser.close();
  server.close();
}
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
