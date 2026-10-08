// The 🎓 Radio Propagation tab (propagation-physics.js, propagation-scene.js,
// propagation.js), held to what it teaches.
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
//   The tab        it draws (every canvas has pixels), tells the story in
//                  words, changes story from its own radios, staggers Hill B
//                  from its own button, says each collision's outcome as the
//                  sliders move, stops everything on the way out and starts
//                  again on the way back, and stands still for a device that
//                  asks for reduced motion — at the outcome, not at nothing.
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
for (const f of ['propagation-physics.js', 'propagation-scene.js', 'packets.js']) {
  vm.runInContext(fs.readFileSync(repo(f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.PH = PropPhysics; this.PS = PropScene; this.PK = Packets;', ctx);
const { PH, PS, PK } = ctx;

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
  await still.close();
} finally {
  await browser.close();
  server.close();
}
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
