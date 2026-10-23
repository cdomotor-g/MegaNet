// The 🧪 Bit Bench and ⚡ Bit Errors tabs (bit-model.js, bit-bench.js,
// bit-errors.js), held to what they teach.
//
// Node first, then Chromium.
//
// The frame. BitModel builds ALERT Binary's 40 bits from PropPhysics's map,
// and three decoders in this repository have to read them back as the same
// address and value: the ALERT Packets tab's (packets.js), the 🎓 Radio
// Propagation lesson's (propagation-physics.js) and the off-air decoder's
// (alert-dsp.js, the one that decodes real bursts). The tones are lifted from
// alert-dsp.js rather than restated.
//
// The arithmetic. Bits, Gray code both ways for every 11-bit number, the
// share of random flips a frame lets through (C(24, k) / C(40, k)) and a
// CRC-6's catch, against figures worked by hand and by exhaustion; 151.5 Hz to
// a ppm; 2f₁ − f₂; a UART's ±5% made a fact of the model, not a sentence.
//
// The faults. The bench's claim is that a batch through each fault leaves the
// fingerprint that fault's physics predicts, so each is run from its defaults
// and its findings asserted: noise even, impulses in runs, a PLL in the first
// word with its ghosts inside the true address's block of 64, a clock at the
// ends of words and mostly caught, twist one way, a crystal at an hour of the
// day, intermodulation patchy, each wiring fault named by its rule. And the
// same reasoning on pasted readings.
//
// Chromium. Both tabs open clean, every section's heading with its picture;
// the site in 3-D drawn, touring the faults on its own, stepped, turned by a
// drag and following the bench; the number bench, the frame table, every
// fault drawn and sent, a batch, a mystery, readings pasted, the CSVs; the
// lesson's sections and drawings, its calculator, and the two tabs opening
// each other at the right place with focus there; reduced motion (the bench
// and the site's tour both still); a phone.
//
// Run:  npm run bitbench
//       npm run bitbench -- -v    also print what passed

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

// ── Node ────────────────────────────────────────────────────────────────────
const ctx = { console, Math };
vm.createContext(ctx);
for (const f of ['propagation-physics.js', 'packets.js', 'alert-dsp.js', 'bit-model.js']) {
  vm.runInContext(fs.readFileSync(repo(f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.BM = BitModel; this.PH = PropPhysics; this.PK = Packets; this.AD = AlertDsp;', ctx);
const { BM, PH, PK, AD } = ctx;

console.log('\nThe frame — three decoders read it back\n');
{
  const rnd = PH.rng(7);
  let packets = 0, prop = 0, dsp = 0, tried = 0;
  for (let i = 0; i < 300; i++) {
    const a = 1 + Math.floor(rnd() * 8191), v = Math.floor(rnd() * 2048);
    const air = BM.air(a, v);
    tried++;
    const d = PK.decodeMessage(Array.from(air).join(''));
    const abf = d.ok && d.results.find(r => r.format === 'abf');
    if (abf && abf.valid && abf.values.A === a && abf.values.D === v) packets++;
    const p = PH.decodeAbf(Array.from({ length: 32 }, (_, k) => air[Math.floor(k / 8) * 10 + 1 + (k % 8)]));
    if (p.ok && p.addr === a && p.value === v) prop++;
    const r = AD.parseFrame(Uint8Array.from(air), 0, AD.BINARY);
    if (r && r.sensorId === a && r.value === v) dsp++;
  }
  ok(`the ALERT Packets tab decodes every frame to its address and value (${packets}/${tried})`, packets === tried);
  ok(`…and so does the Radio Propagation lesson's codec (${prop}/${tried})`, prop === tried);
  ok(`…and the off-air decoder, which reads real bursts (${dsp}/${tried})`, dsp === tried);
  const L = BM.layout();
  ok('40 bits: 4 start, 4 stop, 8 check, 13 address, 11 value',
    L.length === 40 && L.filter(c => c.kind === 'start').length === 4 && L.filter(c => c.kind === 'stop').length === 4
    && L.filter(c => c.kind === 'K').length === 8 && L.filter(c => c.kind === 'A').length === 13 && L.filter(c => c.kind === 'D').length === 11);
  ok('address bits 0–5 are the first data bits sent, value bit 10 the last', BM.airOf('address', 0) === 1 && BM.airOf('address', 5) === 6
    && BM.airOf('value', 10) === 36);
  ok('the tones are the off-air decoder\'s own', BM.MARK_HZ === AD.AFSK_F1 && BM.SPACE_HZ === AD.AFSK_F2, `${BM.MARK_HZ}/${AD.AFSK_F1} ${BM.SPACE_HZ}/${AD.AFSK_F2}`);
  const j0 = BM.judge(4021, 1263, BM.air(4021, 1263));
  const flipAt = (bits, k) => { const b = Uint8Array.from(bits); b[k] ^= 1; return b; };
  const jA = BM.judge(4021, 1263, flipAt(BM.air(4021, 1263), BM.airOf('address', 3)));
  const jD = BM.judge(4021, 1263, flipAt(BM.air(4021, 1263), BM.airOf('value', 7)));
  const jK = BM.judge(4021, 1263, flipAt(BM.air(4021, 1263), 7));
  const jS = BM.judge(4021, 1263, flipAt(BM.air(4021, 1263), 20));
  ok('a frame as sent is clean', j0.status === 'clean' && !j0.flips.length);
  ok('an address bit flipped passes as a ghost, 8 away', jA.status === 'ghost' && jA.addr === (4021 ^ 8), JSON.stringify(jA).slice(0, 120));
  ok('a value bit flipped passes with the wrong value', jD.status === 'wrong' && jD.value === (1263 ^ 128));
  ok('a check bit flipped is thrown out at the check', jK.status === 'rejected' && jK.why === 'check');
  ok('a start bit flipped is thrown out at the framing', jS.status === 'rejected' && jS.why === 'framing' && jS.framing[0] === 2);
  ok('nothing decoded is lost', BM.judge(1, 1, null).status === 'lost');
}

console.log('\nThe arithmetic\n');
{
  ok('1263 is 100 1110 1111 in binary and 0x4EF', BM.bin(1263, 11) === '10011101111' && BM.hex(1263, 11) === '4EF');
  ok('decimal, 0b… and 0x… all read', BM.parse('1263').value === 1263 && BM.parse('0b100 1110 1111').value === 1263 && BM.parse('0x4ef').value === 1263);
  ok('shift left doubles and drops the top bit; right halves', BM.shl(1263, 11) === (2526 & 2047) && BM.shr(1263) === 631);
  ok('rotate left and back is the same number', BM.rotr(BM.rotl(1263, 11), 11) === 1263);
  ok('inverted is 2047 − x; reversed twice is x', BM.invert(1263, 11) === 2047 - 1263 && BM.reverse(BM.reverse(1263, 11), 11) === 1263);
  ok('1 reversed in 11 bits is 1024', BM.reverse(1, 11) === 1024);
  let gray = true, oneBit = true;
  for (let v = 0; v < 2048; v++) {
    if (BM.fromGray(BM.toGray(v)) !== v) gray = false;
    if (v && BM.popcount(BM.toGray(v) ^ BM.toGray(v - 1)) !== 1) oneBit = false;
  }
  ok('Gray code there and back for every 11-bit number', gray);
  ok('…and neighbouring numbers one bit apart in it', oneBit);
  ok('two\'s complement: 2047 in 11 bits is −1', BM.signed(2047, 11) === -1 && BM.signed(1023, 11) === 1023);
  ok('a counter wraps past its top to nought', BM.wrap(2048, 11) === 0 && BM.wrap(-1, 11) === 2047);
  const d = BM.diff(600, 1200, 11);
  ok('600 → 1200 is a shift left', d.kinds.includes('shl'), d.kinds.join());
  const d2 = BM.diff(1263, 1279, 11);
  ok('1263 → 1279 is one bit, bit 4, 0 → 1', d2.kinds.includes('flip1') && d2.set.length === 1 && d2.set[0] === 4);
  const d3 = BM.diff(1263, 1271, 11);
  ok('…and 1263 → 1271, only 8 more, is two bits: a carry', d3.flips.length === 2 && !d3.kinds.includes('flip1'));
  ok('random flips pass C(24,k)/C(40,k): 60%, 35.4%, 20.5%',
    near(BM.passShare(1), 0.6, 1e-12) && near(BM.passShare(2), 276 / 780, 1e-12) && near(BM.passShare(3), 2024 / 9880, 1e-12));
  ok('a CRC-6 on x⁶ + x⁴ + x³ + 1 catches every 1-, 2- and 3-bit error over 30 bits',
    BM.crcCatches(1) === 1 && BM.crcCatches(2) === 1 && BM.crcCatches(3) === 1);
  ok('…and 26,460 of the 27,405 four-bit ones', near(BM.crcCatches(4), 26460 / 27405, 1e-12), String(BM.crcCatches(4)));
  ok('one ppm at 151.5 MHz is 151.5 Hz', BM.hzPerPpm() === 151.5);
  const im = BM.imProducts(152, 152.5021);
  ok('2 × 152.0000 − 152.5021 = 151.4979 MHz, 2.1 kHz below the channel', near(im[0].mhz, 151.4979, 1e-9) && im[0].offsetHz === -2100, JSON.stringify(im[0]));
  ok('a bit is misread 0.94% of the time at 9 dB and under 0.003% at 13: the cliff', near(BM.ber(9), 0.00942, 0.0002) && BM.ber(13) < 3e-5);
  let mono = true;
  for (let s = 0; s < 20; s += 0.5) if (BM.ber(s + 0.5) >= BM.ber(s)) mono = false;
  ok('…and never better at less signal', mono);
  ok('two equal copies opposed cancel completely; in step they add', BM.fadeAmp(1, Math.PI) < 1e-9 && near(BM.fadeAmp(1, 0), Math.SQRT2, 1e-12));
  ok('an off-frequency carrier costs nothing inside the filter\'s reach, then grows, then is lost',
    BM.edgePenaltyDb(1999, false) === 0 && BM.edgePenaltyDb(2100, false) > 0 && BM.edgePenaltyDb(6000, false) === Infinity);
  ok('a detector hears a tenth of the other tone', near(BM.toneResp(BM.SPACE_HZ - BM.MARK_HZ), 0.097, 0.01), String(BM.toneResp(BM.SPACE_HZ - BM.MARK_HZ)));
}

console.log('\nThe UART, as a model\n');
{
  const clean = (err, uart) => {
    const st = BM.run('clock', { err, uart, jitter: 0, snr: 24 }, { n: 200, seed: 3 });
    return st.counts.clean === st.n;
  };
  ok('an exact clock reads every frame', clean(0, true) && clean(0, false));
  ok('a UART stands 4% fast and 4% slow', clean(4, true) && clean(-4, true));
  ok('…and not 6%', !clean(6, true) && !clean(-6, true));
  ok('timed from the frame\'s first edge, 2% is already too much', clean(1, false) && !clean(2, false));
  const st6 = BM.run('clock', { err: 6, uart: true, jitter: 0, snr: 24 }, { n: 100, seed: 3 });
  ok('6% fast: every frame thrown out at its framing', st6.counts.rejected === 100 && st6.why.framing === 100, JSON.stringify(st6.counts));
}

console.log('\nEach fault leaves the fingerprint its physics predicts\n');
const keys = (id, p = {}, o = {}) => {
  const st = BM.run(id, p, { n: 1500, seed: 11, hours: id === 'crystal', ...o });
  return { st, fp: BM.fingerprint(st), k: new Set(BM.fingerprint(st).map(f => f.key)) };
};
{
  const n = keys('noise');
  ok('weak signal: flips spread evenly, scattered, both ways', n.k.has('even') && !n.k.has('runs') && !n.k.has('down') && !n.k.has('early'), [...n.k].join());
  const i = keys('impulse');
  ok('impulse noise: flips in runs', i.k.has('runs'), [...i.k].join());
  const m = keys('multipath');
  ok('reflections: whole frames among perfect ones, in runs', m.k.has('patchy') && m.k.has('runs'), [...m.k].join());
  const c = keys('collision');
  ok('a collision: mostly caught, every bit at risk', c.k.has('caught') && c.k.has('even'), [...c.k].join());
  const cap = BM.run('collision', { sir: 7, vary: false, start: 0 }, { n: 100, seed: 2 });
  const lost = BM.run('collision', { sir: -7, vary: false, start: 0 }, { n: 100, seed: 2 });
  ok('…6 dB ahead, captured clean; 6 dB behind, lost', cap.counts.clean === 100 && lost.counts.lost === 100);
  const x = keys('intermod');
  ok('intermodulation: patchy, not in runs', x.k.has('patchy') && !x.k.has('runs'), [...x.k].join());
  const far = BM.run('intermod', { f2: 152.6 }, { n: 300, seed: 2 });
  ok('…and a pair whose products miss the filter does no harm', far.counts.clean === 300);
  const k = keys('crystal');
  const hours = k.fp.find(f => f.key === 'hours');
  ok('crystal drift: with the time of day, worst in the afternoon heat', !!hours && hours.peak >= 12 && hours.peak <= 17 && hours.lo < 0.02, JSON.stringify(hours || {}));
  const cold = keys('crystal', { ppm: -12, tc: 0.45 });
  const coldH = cold.fp.find(f => f.key === 'hours');
  ok('…or before dawn, for one running low', !!coldH && (coldH.peak <= 6 || coldH.peak >= 23), JSON.stringify(coldH || {}));
  const p = keys('pll');
  ok('the PLL at key-up: the first word sent', p.k.has('early'), [...p.k].join());
  const block = p.st.pairs.filter(q => q.status === 'ghost');
  ok(`…its ghosts all inside the true address's block of 64 (${block.length})`, block.length > 50 && block.every(q => q.raddr >> 6 === q.addr >> 6));
  const cl = keys('clock');
  ok('clock drift: the ends of words, and mostly caught', cl.k.has('wordend') && cl.k.has('caught'), [...cl.k].join());
  const tw = keys('twist');
  const tw2 = keys('twist', { twist: -4.2 });
  ok('tone twist: flips one way — 1 → 0 with the mark weak, 0 → 1 with the space weak', tw.k.has('down') && tw2.k.has('up'), `${[...tw.k]} / ${[...tw2.k]}`);
  const s = keys('stuck');
  const sf = s.fp.find(f => f.key === 'stuck');
  ok('a stuck bit: one bit, one way, named', s.k.has('single') && !!sf && sf.bit === 4 && sf.to === 1, JSON.stringify(sf || {}));
  ok('…and readings that had it right come through right', s.st.counts.clean > 0 && s.st.counts.wrong > 0);
  for (const [id, key, p2] of [['shift', 'shl', {}], ['shift', 'shr', { left: false }], ['invert', 'invert', {}], ['reverse', 'reverse', {}],
    ['gray', 'gray', {}], ['gray', 'ungray', { way: 'ungray' }]]) {
    const r = keys(id, p2);
    ok(`${id}${p2.left === false ? ' right' : p2.way ? ' (binary read as Gray)' : ''}: named by its rule, and nothing caught`,
      r.k.has(key) && !r.k.has('runs') && r.st.counts.rejected === 0, [...r.k].join());
  }
  const a1 = BM.run('noise', {}, { n: 400, seed: 5 }), a2 = BM.run('noise', {}, { n: 400, seed: 5 });
  ok('the same seed is the same batch', JSON.stringify(a1.counts) === JSON.stringify(a2.counts) && JSON.stringify(a1.flipsAt) === JSON.stringify(a2.flipsAt));
}

console.log('\nPasted readings are read the same way\n');
{
  const rnd = PH.rng(4);
  const vals = Array.from({ length: 20 }, () => 200 + Math.floor(rnd() * 1600));
  const kOf = (pairs, field) => new Set(BM.analysePairs(pairs, field).findings.map(f => f.key));
  ok('a stuck bit, named', kOf(vals.map(v => ({ a: v, b: v | 64 })), 'value').has('stuck'));
  ok('doubled readings: a shift left', kOf(vals.map(v => ({ a: v, b: BM.shl(v, 11) })), 'value').has('shl'));
  ok('Gray code', kOf(vals.map(v => ({ a: v, b: BM.toGray(v) })), 'value').has('gray'));
  ok('one-bit flips', kOf(vals.map((v, i) => ({ a: v, b: BM.flip(v, i % 11) })), 'value').has('singles'));
  ok('bits only ever cleared, a different one each time: they read low',
    kOf(vals.map((v, i) => { const a = v | (1 << (i % 11)); return { a, b: a & ~(1 << (i % 11)) }; }), 'value').has('down'));
  ok('ghosts in address bits 0–5: the start of the transmission',
    kOf(vals.map((v, i) => ({ a: 1000 + v, b: BM.flip(1000 + v, i % 6) })), 'address').has('lowaddr'));
  ok('nothing to explain when nothing differs', kOf([{ a: 5, b: 5 }], 'value').has('none'));
  ok('every finding names a fault the bench has', ['singles', 'down', 'up', 'lowaddr', 'wordend', 'stuck', 'shl', 'gray', 'early', 'patchy', 'hours', 'onset']
    .every(k => BM.causes(k).length && BM.causes(k).every(c => BM.EFFECTS[c])));
}

// ── Chromium ────────────────────────────────────────────────────────────────
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const until = (page, fn, arg, timeout = 10_000) => page.waitForFunction(fn, arg, { timeout });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data, null, LOAD_TIMEOUT);

  console.log('\nThe Bit Bench\n');
  await page.evaluate(() => switchTab('bitbench'));
  await until(page, () => !!document.getElementById('bb-page'));
  const shape = await page.evaluate(() => ({
    secs: ['bb-num', 'bb-frame', 'bb-site', 'bb-fault', 'bb-mystery', 'bb-pairs', 'bb-more'].filter(id => document.getElementById(id)),
    tiles: [...document.querySelectorAll('#bb-page .bb-sec')].map(sec => !!sec.querySelector('h3 .gl-tile svg')),
    hues: new Set([...document.querySelectorAll('#bb-page .bb-sec')].map(sec => getComputedStyle(sec).borderTopColor)).size,
    canv: [...document.querySelectorAll('#bb-page canvas')].map(c => !!c.getAttribute('aria-label')),
    fx: document.querySelectorAll('input[name="bb-fx"]').length,
    group: TABS.find(g => g.tabs.some(t => t.id === 'bitbench')).group,
  }));
  ok('seven sections, every canvas named', shape.secs.length === 7 && shape.canv.length >= 4 && shape.canv.every(Boolean), JSON.stringify(shape));
  ok('every section\'s heading wears a picture, the panels in six colours', shape.tiles.length === 7 && shape.tiles.every(Boolean) && shape.hues === 6, JSON.stringify(shape));
  ok('fourteen faults to pick from, under Interference', shape.fx === 14 && shape.group === 'Interference', JSON.stringify(shape));

  console.log('\nThe site in 3-D\n');
  await page.evaluate(() => document.getElementById('bb-site').scrollIntoView());
  await page.waitForTimeout(400);
  const inked = id => {
    const cv = document.getElementById(id);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 211) seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4));
    return seen.size;
  };
  const site0 = await page.evaluate(([f]) => {
    const inked = eval(f);
    return { st: BitBench.state().site, scene: inked('bb-site-cv'), zoom: inked('bb-site-zoom'), order: BitScene.ORDER.length,
      named: BitScene.ORDER.every(id => BitScene.SPOTS[id].where.length > 60 && BitScene.SPOTS[id].close),
      say: document.getElementById('bb-site-say').textContent, label: document.getElementById('bb-site-cv').getAttribute('aria-label') };
  }, [inked.toString()]);
  ok('the site and its close-up are drawn, touring from the first fault', site0.st.tour && site0.st.id === 'noise' && site0.scene > 40 && site0.zoom > 4,
    JSON.stringify({ ...site0, say: undefined, label: undefined }));
  ok('…a place and a close-up for each of the fourteen, said beside it and in the drawing\'s name', site0.order === 14 && site0.named
    && /Weak signal/.test(site0.say) && /hiss/.test(site0.label), site0.say.slice(0, 120));
  await page.waitForTimeout(7300);
  const toured = await page.evaluate(() => BitBench.state().site.id);
  ok('left alone, the tour moves on to the next fault', toured === 'impulse', toured);
  const stepped = await page.evaluate(() => {
    BitBench.siteStep(-1); const a = BitBench.state().site.id;
    BitBench.siteStep(-1); const b = BitBench.state().site.id;
    BitBench.siteShow('crystal'); const c = BitBench.state().site;
    return { a, b, c, sel: document.getElementById('bb-site-pick').value, pressed: document.getElementById('bb-site-tour').getAttribute('aria-pressed') };
  });
  ok('◀ steps back round the fourteen; Show holds on the one picked', stepped.a === 'noise' && stepped.b === 'gray' && stepped.c.id === 'crystal'
    && !stepped.c.tour && stepped.sel === 'crystal' && stepped.pressed === 'false', JSON.stringify(stepped));
  const box = await (await page.$('#bb-site-cv')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const turned = await page.evaluate(() => ({ yaw: BitBench.state().site.yaw, yaw0: BitScene.YAW0 }));
  ok('dragged across, the site turns', typeof turned.yaw === 'number' && Math.abs(turned.yaw - turned.yaw0) > 0.3, JSON.stringify(turned));
  const benched = await page.evaluate(() => { BitBench.siteBench(); return { fx: BitBench.state().effect, name: document.querySelector('.bb-fx-name').textContent }; });
  ok('🧪 Try it on the bench puts the site\'s fault on the bench', benched.fx === 'crystal' && /Crystal drift/.test(benched.name), JSON.stringify(benched));
  const follows = await page.evaluate(() => { BitBench.siteTour(); BitBench.pick('collision'); return BitBench.state().site; });
  ok('…and a fault picked on the bench shows on the site, holding there', follows.id === 'collision' && !follows.tour, JSON.stringify(follows));

  await page.evaluate(() => { BitBench.width(11); BitBench.setNum('0b1010'); BitBench.flipBit(0); BitBench.op('shl'); });
  const numState = await page.evaluate(() => ({ s: BitBench.state(), dec: document.querySelector('.bb-readout dd').textContent,
    pressed: [...document.querySelectorAll('.bb-nbit')].filter(b => b.getAttribute('aria-pressed') === 'true').length }));
  ok('0b1010, bit 0 flipped, shifted left: 22, three bits pressed', numState.s.num === 22 && numState.dec === '22' && numState.pressed === 3, JSON.stringify(numState));

  const table = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#bb-frame-body .bb-frame tbody td .bb-bit-v')].map(c => c.textContent).join('');
    return { cells, want: Array.from(BitModel.air(BitBench.state().addr, BitBench.state().value)).join('') };
  });
  ok('the frame table holds the 40 bits on the air', table.cells === table.want, `${table.cells} / ${table.want}`);

  const drawn = [];
  for (const id of await page.evaluate(() => Object.keys(BitModel.EFFECTS))) {
    const r = await page.evaluate(i => {
      BitBench.pick(i);
      BitBench.sendOne();
      const cv = document.getElementById('bb-cv');
      return { name: document.querySelector('.bb-fx-name').textContent.trim(), label: cv.getAttribute('aria-label'),
        verdict: !!document.querySelector('.bb-verdict'), w: cv.width };
    }, id);
    drawn.push(r.verdict && r.w > 0 && /at work on address/.test(r.label));
  }
  ok(`every fault drawn, sent and given a verdict (${drawn.filter(Boolean).length}/${drawn.length})`, drawn.length === 14 && drawn.every(Boolean));

  const b = await page.evaluate(() => {
    BitBench.pick('pll');
    BitBench.batchSize(500);
    BitBench.batch();
    const counts = [...document.querySelectorAll('.bb-counts strong')].map(s => Number(s.textContent.replace(/,/g, '')));
    return { sum: counts.reduce((a, x) => a + x, 0), heat: document.querySelectorAll('#bb-batch td.bb-heat').length,
      findings: [...document.querySelectorAll('#bb-batch .bb-findings li')].map(l => l.textContent),
      cands: [...document.querySelectorAll('#bb-batch .bb-cands button')].map(x => x.textContent.trim()) };
  });
  ok('a batch of 500: its counts add up, 40 cells in its heat map', b.sum === 500 && b.heat === 40, JSON.stringify({ sum: b.sum, heat: b.heat }));
  ok('…and the PLL\'s batch says the first word, and names the PLL', b.findings.some(t => /first word sent/.test(t)) && b.cands.some(t => /PLL/.test(t)), JSON.stringify(b).slice(0, 300));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => BitBench.exportCsv('batch'))]);
  const csv = await (await dl.createReadStream()).toArray().then(x => Buffer.concat(x).toString());
  const lines = csv.trim().split('\n');
  ok('the batch downloads as floodnet-bit-bench-pll-500.csv, a frame a row', dl.suggestedFilename() === 'floodnet-bit-bench-pll-500.csv'
    && /^# Flood-Net Bit Bench/.test(lines[0]) && lines[1].startsWith('frame,address,value,outcome') && lines.length === 502, `${dl.suggestedFilename()} ${lines.length}`);

  const mys = await page.evaluate(() => {
    BitBench.mystery();
    const hidden = !document.querySelector('#bb-mystery-body .bb-cands');
    const sel = document.getElementById('bb-guess');
    BitBench.guess(sel.options[3].value);
    return { hidden, answer: !!document.querySelector('#bb-mystery-body .bb-answer'), score: document.querySelector('#bb-mystery-body').textContent.includes('of 1 right') };
  });
  ok('a mystery hides its fault, and a guess is answered and scored', mys.hidden && mys.answer && mys.score, JSON.stringify(mys));

  await page.evaluate(() => BitBench.pairsExample('stuck'));
  const pr = await page.evaluate(() => [...document.querySelectorAll('#bb-pairs-body .bb-findings li')].map(l => l.textContent).join(' | '));
  ok('pasted readings with a stuck bit are named so', /stuck at 1/.test(pr), pr.slice(0, 200));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => BitBench.exportCsv('pairs'))]);
  ok('…and download as floodnet-bit-bench-readings.csv', dl2.suggestedFilename() === 'floodnet-bit-bench-readings.csv');

  const offers = await page.evaluate(() => ExportMenu.offers('bitbench').map(o => ({ call: o.call[0], why: o.why })));
  ok('⤓ Export offers the batch and the readings, both ready now', offers.length === 2 && offers.every(o => o.call === 'BitBench.exportCsv' && o.why === ''), JSON.stringify(offers));

  console.log('\nThe lesson, and the two tabs opening each other\n');
  await page.evaluate(() => BitBench.learn('crystal'));
  await until(page, () => !!document.getElementById('be-page'));
  await page.waitForTimeout(200);
  const les = await page.evaluate(() => ({
    secs: document.querySelectorAll('#be-page .be-sec').length,
    focus: document.activeElement && document.activeElement.id,
    group: TABS.find(g => g.tabs.some(t => t.id === 'biterrors')).group,
    field: TABS.find(g => g.group === 'Field training').tabs.map(t => t.id),
  }));
  ok('the bench\'s "in depth" opens the lesson at its section, focus on its heading', les.focus === 'be-crystal-h', les.focus);
  ok('fifteen sections, in the Knowledge base; the five adapted lessons in Field training', les.secs === 15 && les.group === 'Knowledge base'
    && JSON.stringify(les.field) === JSON.stringify(['kbstaff', 'kblogbook', 'kblifecycle', 'kblevel', 'kbriver']), JSON.stringify(les));
  await page.waitForTimeout(300);
  const ink = await page.evaluate(() => [...document.querySelectorAll('#be-page canvas[data-draw]')].map(cv => {
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
    return n > 20;
  }));
  ok(`every drawing in the lesson is drawn (${ink.filter(Boolean).length}/${ink.length})`, ink.length === 11 && ink.every(Boolean));
  const calc = await page.evaluate(() => {
    BitErrors.im('f2', 152.6);
    const t = document.getElementById('be-im-out').textContent;
    BitErrors.im('f2', 152.5021);
    return { far: /outside — no harm here/.test(t) && !/inside the filter/.test(t), back: /inside the filter/.test(document.getElementById('be-im-out').textContent) };
  });
  ok('the calculator follows the frequencies typed', calc.far && calc.back, JSON.stringify(calc));
  await page.evaluate(() => BitErrors.bench('twist'));
  await until(page, () => !!document.getElementById('bb-page'));
  const back = await page.evaluate(() => ({ fx: BitBench.state().effect, focus: document.activeElement && document.activeElement.id }));
  ok('a section\'s "on the bench" opens the bench on its fault, focus on the faults', back.fx === 'twist' && back.focus === 'bb-fault-h', JSON.stringify(back));
  await context.close();

  console.log('\nStill, and small\n');
  const c2 = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: 'reduce' });
  const p2 = await c2.newPage();
  await applyNetworkPolicy(p2, server.origin);
  p2.on('pageerror', e => errors.push(e.message));
  await p2.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(p2, () => typeof state !== 'undefined' && !!state.data, null, LOAD_TIMEOUT);
  await p2.evaluate(() => switchTab('bitbench'));
  await until(p2, () => !!document.getElementById('bb-play'));
  const still = await p2.evaluate(() => ({ pressed: document.getElementById('bb-play').getAttribute('aria-pressed'), text: document.getElementById('bb-play').textContent,
    tour: BitBench.state().site.tour, tourText: document.getElementById('bb-site-tour').textContent }));
  ok('reduced motion: the bench starts still, with ▶ to run it', still.pressed === 'false' && /Keep sending/.test(still.text), JSON.stringify(still));
  ok('…and the site holds on one fault, with ⏵ to tour them', still.tour === false && /Tour the faults/.test(still.tourText), JSON.stringify(still));
  await p2.waitForTimeout(300);
  const wideB = await p2.evaluate(() => document.documentElement.scrollWidth);
  await p2.evaluate(() => switchTab('biterrors'));
  await p2.waitForTimeout(400);
  const wideL = await p2.evaluate(() => document.documentElement.scrollWidth);
  ok('nothing wider than a 375 px phone, on either tab', wideB <= 376 && wideL <= 376, `${wideB} ${wideL}`);
  await c2.close();
} finally {
  await browser.close();
  await server.close();
}

ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
