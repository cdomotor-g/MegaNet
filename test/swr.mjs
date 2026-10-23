// The 📟 SWR Meter tab (swr-model.js, swr-meter.js), Node then Chromium.
//
//   The arithmetic, against figures worked by hand: watts to decibels (3.8 W
//   of 5 is −1.19 dB), SWR ↔ |Γ| ↔ return loss ↔ mismatch loss, the SW-102
//   maker's own photo (38.84 W forward, 0.198 W reflected → VSWR 1.15), a
//   feeder taking its loss off a reflection twice, a meter at either end of
//   it, and the made-up stations each showing their fault.
//
//   Held to the files it restates: the SWR bands to the inspection form's
//   printed note, the fade-margin bands to the link budget card's, the
//   flutter to the Radio Propagation bench's, and the cliff's bit error rate
//   to the Bit Bench's — so the tabs never disagree.
//
//   What a set of readings means: each band at its edges, any two of the
//   three readings making the third, three that disagree, the meter in
//   backwards, a good SWR read through a lossy feeder, power down against the
//   setting at the radio and against what should arrive at the antenna end,
//   the wrong-band meter.
//
//   The tab in Chromium: every section, every meter drawn and named, the
//   SW-102's screen reading what the line says, its menu offset scaling it,
//   the SWR-400 calibrated and read by its switches — on the drawing and
//   beside it, keeping focus — the 3030 in return loss, readings typed and
//   read back, a case loaded, the tab opened from the inspection form's
//   readings, the text saved and ⤓ Export offering it, the loop stopped on
//   the way out, reduced motion starting still, and a phone's width.
//
// Run:  npm run swr
//       npm run swr -- -v    also print what passed

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
const J = v => JSON.stringify(v);

const ctx = { console, Math };
vm.createContext(ctx);
for (const f of ['propagation-physics.js', 'packets.js', 'alert-dsp.js', 'bit-model.js', 'swr-model.js']) {
  vm.runInContext(fs.readFileSync(repo(f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('this.SM = SwrModel; this.BM = BitModel;', ctx);
const { SM, BM } = ctx;

console.log('\nThe arithmetic\n');
{
  ok('3.8 W of 5 is −1.19 dB, 4 W −0.97, 2.5 W −3.01', near(SM.db(3.8 / 5), -1.192, 0.001) && near(SM.db(4 / 5), -0.969, 0.001) && near(SM.db(2.5 / 5), -3.010, 0.001));
  ok('5 W is 36.99 dBm, and back', near(SM.wToDbm(5), 36.990, 0.001) && near(SM.dbmToW(36.99), 5, 0.001));
  ok('SWR 1.5 is |Γ| 0.2, and back', near(SM.gammaFromSwr(1.5), 0.2, 1e-12) && near(SM.swrFromGamma(0.2), 1.5, 1e-12));
  ok('SWR 1 is |Γ| 0; an open end is |Γ| 1 and SWR ∞', SM.gammaFromSwr(1) === 0 && SM.gammaFromSwr(Infinity) === 1 && SM.swrFromGamma(1) === Infinity);
  ok('|Γ| 0.2: 13.98 dB of return loss, 0.177 dB of mismatch loss', near(SM.returnLossDb(0.2), 13.979, 0.001) && near(SM.mismatchLossDb(0.2), 0.177, 0.001));
  ok('a perfect match: ∞ return loss and no mismatch loss — never −0', SM.returnLossDb(0) === Infinity && Object.is(SM.mismatchLossDb(0), 0));
  ok('an open end: no return loss, ∞ mismatch loss — never −0', Object.is(SM.returnLossDb(1), 0) && SM.mismatchLossDb(1) === Infinity);
  ok('5 W forward and 0.2 W reflected is |Γ| 0.2, SWR 1.5', near(SM.gammaFromPowers(5, 0.2), 0.2, 1e-12));
  const photo = SM.interpret({ fwd: 38.84, ref: 0.198 });
  ok('the SW-102 maker\'s photo: 38.84 W and 0.198 W read VSWR 1.15, 99.49% on', near(photo.swr, 1.154, 0.001) && near(100 - photo.reflPct, 99.49, 0.01), J([photo.swr, photo.reflPct]));
  ok('25 m of LMR-400 loses 1.2 dB at 150 MHz; 30 m of RG-58, 5.85', near(SM.cableLossDb('lmr400', 25), 1.2, 1e-9) && near(SM.cableLossDb('rg58', 30), 5.85, 1e-9));
  ok('an unknown feeder loses nothing it can be blamed for', SM.cableLossDb('', 30) === 0 && SM.cableLossDb('lmr400', 0) === 0);
}

console.log('\nHeld to the files it restates\n');
{
  const insp = fs.readFileSync(repo('inspections.js'), 'utf8');
  ok('the inspection form prints the same SWR bands', insp.includes("note: '<1.5 = Good · 1.5–2.0 = Fair · >2.0 = Poor'"));
  const band = s => SM.swrBand(s).id;
  ok('…and they are cut where it cuts them: 1.49 Good, 1.5 and 2.0 Fair, 2.01 Poor, ∞ Poor',
    band(1) === 'good' && band(1.49) === 'good' && band(1.5) === 'fair' && band(2.0) === 'fair' && band(2.01) === 'poor' && band(Infinity) === 'poor');
  const lb = fs.readFileSync(repo('link-budget.js'), 'utf8');
  const mins = [...lb.matchAll(/\{ min: (\d+),\s+label: '(Good|Marginal)'/g)].map(m => [m[2], Number(m[1])]);
  ok('the fade-margin bands are the link budget card\'s', J(mins) === J([['Good', SM.MARGIN_GOOD], ['Marginal', SM.MARGIN_FLOOR]]), J(mins));
  const pf = /const FLUTTER_DB = ([\d.]+);/.exec(fs.readFileSync(repo('propagation-fade.js'), 'utf8'));
  ok('the flutter is the Radio Propagation bench\'s', pf && Number(pf[1]) === SM.FLUTTER_DB, pf && pf[1]);
  let same = true;
  for (let d = -5; d <= 20; d += 0.25) if (SM.ber(d) !== BM.ber(d)) same = false;
  ok('the cliff\'s bit error rate is the Bit Bench\'s, decibel by decibel', same);
}

console.log('\nThe line\n');
{
  const S = SM.SCENARIOS;
  const L = (k, where) => SM.line({ ...S[k], where });
  const h = L('healthy', 'radio');
  ok('a healthy station at the radio: 4.89 W out, SWR 1.25, 4.14 W reaching the antenna',
    near(h.fwd, 4.886, 0.001) && near(h.swr, 1.25, 0.01) && near(h.atAnt, 4.140, 0.001), J([h.fwd, h.swr, h.atAnt]));
  const ha = L('healthy', 'antenna');
  ok('…and at the top of the feeder: 4.14 W, and the antenna\'s own SWR 1.30', near(ha.fwd, h.atAnt, 1e-9) && near(ha.swr, 1.3, 1e-9));
  const t = L('thin', 'radio');
  ok('a lossy feeder takes its loss off a reflection twice: |Γ| at the radio is the antenna\'s × the loss',
    near(t.gamma, t.antGamma * Math.pow(10, -t.feedDb / 10), 1e-9), J([t.gamma, t.antGamma, t.feedDb]));
  ok('…so 30 m of RG-58 reads 1.13 at the radio over an antenna at 1.60', near(t.swr, 1.13, 0.01) && near(t.antSwr, 1.6, 1e-9), J([t.swr, t.antSwr]));
  const w = L('water', 'radio'), wa = L('water', 'antenna'), hr = L('healthy', 'radio');
  ok('water in the coax: at the radio it reads almost as well as a dry line, at the antenna Fair', w.swr < 1.35 && near(w.swr, hr.swr, 0.1) && SM.swrBand(wa.swr).id === 'fair', J([w.swr, hr.swr, wa.swr]));
  const u = L('upstream', 'radio');
  ok('a bad jumper before the meter: 3.79 W at a good SWR — the meter cannot see it', near(u.fwd, 3.793, 0.001) && u.swr < 1.3, J([u.fwd, u.swr]));
  const o = L('open', 'radio');
  ok('an open antenna: SWR over 5 even through the feeder, and the radio turned down', o.swr > 5 && o.fwd < 3.5, J([o.swr, o.fwd]));
  const b = L('backwards', 'radio');
  ok('the meter in backwards reads more coming back than going out', b.ref > b.fwd && b.swr === Infinity, J([b.fwd, b.ref]));
  ok('the dummy load reads the radio: within 0.1 dB of its setting, SWR under 1.05', Math.abs(SM.db(L('dummy', 'radio').fwd / 5)) < 0.1 && L('dummy', 'radio').swr < 1.05);
  ok('every station has a label and a story', Object.values(S).every(s => s.label && s.story && s.story.length > 60));
}

console.log('\nReading the readings\n');
{
  const I = o => SM.interpret(o);
  const ids = r => r.findings.map(f => f.id);
  const c = I({ fwd: 3.8, swr: 1.01, setW: 5, where: 'radio', meter: 'sw102' });
  ok('the case: 3.8 W at SWR 1.01 of 5 W — a little down, 1.2 dB off the margin, SWR Good',
    c.ok && J(ids(c)) === J(['power', 'margin', 'swr']) && c.findings[0].cls === 'warn' && near(c.vsSetDb, -1.19, 0.01), J(ids(c)));
  const up = c.findings[0].do.join(' ');
  ok('…and what to rule out names the meter\'s position, its band and offset, the jumper, the supply and a dummy load',
    /top of the feeder/.test(up) && /VHF power offset/.test(up) && /jumper/.test(up) && /supply voltage/.test(up) && /dummy load/.test(up));
  const cb = I({ fwd: 3.8, swr: 1.01, setW: 5, where: 'radio', meter: 'sw102', steady: false });
  ok('read on data bursts, it asks about a steady test transmission too', cb.findings[0].do.some(x => /steady test transmission/.test(x)));
  const r1 = I({ fwd: 5, ref: 0.2 }), r2 = I({ fwd: 5, swr: 1.5 }), r3 = I({ ref: 0.2, swr: 1.5 });
  ok('any two of the three make the third', near(r1.swr, 1.5, 1e-9) && near(r2.ref, 0.2, 1e-9) && near(r3.fwd, 5, 1e-9));
  const d = I({ fwd: 5, ref: 0.2, swr: 3 });
  ok('three that disagree are said to', ids(d).includes('disagree') && d.disagree.typed === 3);
  const bk = I({ fwd: 0.06, ref: 4.9, setW: 5, meter: 'cc3030' });
  ok('reflected over forward: the meter is in backwards, and the words name its sockets', J(ids(bk)) === J(['backwards']) && /INPUT/.test(bk.findings[0].do[0]), J(ids(bk)));
  const th = I({ fwd: 4.886, ref: SM.line({ ...SM.SCENARIOS.thin, where: 'radio' }).ref, setW: 5, cable: 'rg58', m: 30 });
  ok('a good SWR through 30 m of RG-58 is seen through: the antenna\'s own is 1.60', near(th.antSwr, 1.6, 0.01) && ids(th).includes('hidden') && near(th.atAnt, 1.27, 0.01), J([th.antSwr, th.atAnt]));
  const at = I({ fwd: 2.07, ref: 0.2, setW: 5, where: 'antenna', cable: 'lmr400', m: 15 });
  ok('at the antenna end, power is held to what should arrive there, not the setting',
    near(at.expectAtAnt, 4.24, 0.01) && at.findings.find(f => f.id === 'power').cls === 'warn' && near(at.downDb, -3.12, 0.02), J([at.expectAtAnt, at.downDb]));
  const fine = I({ fwd: 4.14, ref: 0.07, setW: 5, where: 'antenna', cable: 'lmr400', m: 15 });
  ok('…and a healthy line read there is no fault', fine.findings.every(f => f.cls === 'ok' || f.cls === 'info'), J(fine.findings.map(f => f.cls)));
  const poor = I({ fwd: 5, swr: 2.4, setW: 5 }), open = I({ fwd: 3, swr: 15, setW: 5 });
  ok('SWR 2.4 is Poor with things to check; 15 is nearly everything back', poor.findings[0].cls === 'bad' && poor.findings[0].do.length >= 3
    && /Nearly everything/.test(open.findings[0].title), J([poor.findings[0].title, open.findings[0].title]));
  const hf = I({ fwd: 1.7, ref: 0.4, setW: 5, meter: 'sw102hf' });
  ok('the HF meter cannot measure this radio, and says so first', hf.findings[0].id === 'band' && hf.findings[0].cls === 'bad');
  ok('nonsense is refused in words', !!I({ fwd: -1, swr: 1.2 }).error && !!I({ fwd: 5, swr: 0.5 }).error && !!I({ fwd: 5 }).error);
}

console.log('\nThe cliff\n');
{
  ok(`half the frames lost at 0 dB of margin (the edge sits at ${SM.SNR_EDGE.toFixed(2)} dB SNR)`, near(SM.frameLoss(0), 0.5, 1e-9) && near(SM.SNR_EDGE, 8.288, 0.001));
  let down = true;
  for (let m = -4; m < 20; m += 0.5) if (SM.missed(m + 0.5) > SM.missed(m)) down = false;
  ok('more margin never loses more', down);
  ok('with flutter: about half at 0 dB, under 0.01% at 10', near(SM.missed(0), 0.5, 0.01) && SM.missed(10) < 1e-4, J([SM.missed(0), SM.missed(10)]));
  const at3 = SM.marginCost(3, 1.19), at10 = SM.marginCost(10, 1.19);
  ok('1.2 dB at 3 dB of margin roughly doubles the losses; at 10 dB it is still under 0.1%',
    at3.times > 1.6 && at3.times < 2.6 && at10.after < 0.001, J([at3.times, at10.after]));
}

console.log('\nThe tab, in Chromium\n');
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const until = (page, fn, arg, timeout = 10_000) => page.waitForFunction(fn, arg, { timeout });

async function openTab(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data, null, LOAD_TIMEOUT);
  await page.evaluate(() => switchTab('swr'));
  await until(page, () => !!document.getElementById('swm-page'));
  return { context, page };
}

try {
  // Reduced motion: every drawing settled, so what is on a screen is what the
  // line says, not a moment of a burst.
  let { context, page } = await openTab({ reducedMotion: 'reduce' });
  const shape = await page.evaluate(() => ({
    secs: ['swm-bench', 'swm-hook', 'swm-waves', 'swm-db', 'swm-field', 'swm-case', 'swm-more'].filter(id => document.getElementById(id)),
    group: TABS.find(g => g.tabs.some(t => t.id === 'swr')).group,
    canv: [...document.querySelectorAll('#swm-page canvas')].map(c => !!c.getAttribute('aria-label')),
    svgs: [...document.querySelectorAll('#swm-page svg[role="img"]')].map(s => !!(s.querySelector('title') || {}).textContent),
    picks: document.querySelectorAll('.swm-pick-btn').length,
    playing: SwrMeter.state().playing,
    play: document.getElementById('swm-play').getAttribute('aria-pressed'),
  }));
  ok('seven sections, in the Knowledge base, four meters to pick from', shape.secs.length === 7 && shape.group === 'Knowledge base' && shape.picks === 4, J(shape));
  ok('every canvas and every drawing named', shape.canv.length === 2 && shape.canv.every(Boolean) && shape.svgs.length >= 3 && shape.svgs.every(Boolean), J(shape));
  ok('a device asking for reduced motion starts still, with ▶ to run it', shape.playing === false && shape.play === 'false', J(shape));

  await page.evaluate(() => SwrMeter.pick('sw102'));
  const sw = await page.evaluate(() => ({
    fw: document.getElementById('swm-sw-fw').textContent, rw: document.getElementById('swm-sw-rw').textContent,
    vswr: document.getElementById('swm-sw-vswr').textContent, freq: document.getElementById('swm-sw-freq').textContent,
    v: document.getElementById('swm-verdict').textContent,
  }));
  ok('the SW-102 reads what the line says: FW 4.89 W, RW 0.060 W, VSWR 1.25, 151.500 MHz',
    sw.fw === 'FW:4.89W' && sw.rw === 'RW:0.060W' && sw.vswr === '1.25' && sw.freq === '151.500MHz', J(sw));
  ok('…and the verdict calls it Good and as set', /SWR 1\.25 — Good/.test(sw.v) && /Power as set/.test(sw.v), sw.v.slice(0, 200));

  await page.evaluate(() => SwrMeter.dev.swOffset(-24));
  const off = await page.evaluate(() => ({ fw: document.getElementById('swm-sw-fw').textContent, v: document.getElementById('swm-verdict').textContent }));
  ok('its menu offset of −24% scales every reading — 4.89 W reads 3.71 W, and the verdict says why',
    off.fw === 'FW:3.71W' && /offset of -24%/.test(off.v) && /A little down on power/.test(off.v), J(off.fw));
  await page.evaluate(() => { SwrMeter.dev.swOffset(0); SwrMeter.dev.swMenu(); });
  const menu = await page.evaluate(() => ({ menu: document.getElementById('swm-sw-menu').getAttribute('display'), main: document.getElementById('swm-sw-main').getAttribute('display'),
    item4: document.getElementById('swm-sw-mv4').textContent, pressed: document.getElementById('swm-sw-menu-btn').getAttribute('aria-pressed') }));
  ok('MENU shows its seven items, item 4 the offset', menu.menu === 'inline' && menu.main === 'none' && menu.item4 === '0' && menu.pressed === 'true', J(menu));
  await page.click('#swm-dev-svg [data-act="sw-menu"]');
  ok('…and the drawing\'s blue button closes it, the control beside following', await page.evaluate(() => !SwrMeter.state().sw.menu
    && document.getElementById('swm-sw-menu-btn').getAttribute('aria-pressed') === 'false'));

  await page.evaluate(() => SwrMeter.scenario('backwards'));
  const bk = await page.evaluate(() => ({ v: document.getElementById('swm-verdict').textContent, vswr: document.getElementById('swm-sw-vswr').textContent, sel: document.getElementById('swm-scn').value }));
  ok('in backwards: VSWR 19.99 on the screen, and the verdict says to swap the cables', bk.vswr === '19.99' && /in backwards/.test(bk.v) && /Swap the cables/.test(bk.v) && bk.sel === 'backwards', J(bk));
  await page.evaluate(() => { SwrMeter.scenario('water'); SwrMeter.where('antenna'); });
  const wa = await page.evaluate(() => ({ v: document.getElementById('swm-verdict').textContent, where: document.querySelector('input[name="swm-where"]:checked').value,
    lay: SwrMeter.state().lay, name: document.getElementById('swm-line-name').textContent }));
  ok('water, read at the antenna end: Fair, and down on what should arrive — the radios following the change',
    /Fair/.test(wa.v) && /about 4\.24 W expected/.test(wa.v) && wa.where === 'antenna' && wa.lay === 'wide' && /at the antenna end/.test(wa.name), J({ where: wa.where, lay: wa.lay }));
  await page.evaluate(() => { SwrMeter.where('radio'); SwrMeter.scenario('healthy'); SwrMeter.tx('bursts'); });
  ok('on data bursts, the SW-102 is said to read low and jumpy', await page.evaluate(() => /Read on data bursts/.test(document.getElementById('swm-verdict').textContent)));
  await page.evaluate(() => SwrMeter.tx('steady'));

  // The SWR-400, by its switches.
  await page.evaluate(() => SwrMeter.pick('swr400'));
  const needle = () => page.evaluate(() => SwrMeter.state().needle);
  let n = await needle();
  ok('the SWR-400 on POWER, FWD, 20 W: 4.89 W puts the needle at √(4.89/20) of full scale', near(n, Math.sqrt(4.886 / 20), 0.01), n);
  await page.evaluate(() => { SwrMeter.dev.func('cal'); SwrMeter.dev.cal(40); });
  let st = await page.evaluate(() => document.getElementById('swm-mn-status').textContent);
  ok('CAL at 40%: it says to turn CAL up', /Turn CAL up/.test(st), st);
  await page.evaluate(() => SwrMeter.dev.cal(78));
  st = await page.evaluate(() => document.getElementById('swm-mn-status').textContent);
  n = await needle();
  ok('CAL at 78%: on the mark, and the needle at full scale', /On the CAL mark/.test(st) && near(n, 1, 0.03), `${st} ${n}`);
  await page.click('#swm-dev-svg [data-act="mn-func"]');
  const after = await page.evaluate(() => ({ func: SwrMeter.state().mn.func, checked: document.querySelector('input[name="swm-mn-func"]:checked').value,
    st: document.getElementById('swm-mn-status').textContent, needle: SwrMeter.state().needle }));
  ok('the drawing\'s FUNCTION switch to SWR — the radio beside it following — reads SWR 1.25: the needle at |Γ| 0.111',
    after.func === 'swr' && after.checked === 'swr' && /reads SWR 1\.25/.test(after.st) && near(after.needle, 0.111, 0.01), J(after));
  await page.focus('input[name="swm-mn-range"][value="5"]');
  await page.keyboard.press('Space');
  const kept = await page.evaluate(() => ({ range: SwrMeter.state().mn.range, focus: document.activeElement && document.activeElement.name + ':' + document.activeElement.value }));
  ok('a RANGE picked from the keyboard keeps its focus', kept.range === 5 && kept.focus === 'swm-mn-range:5', J(kept));
  await page.evaluate(() => { SwrMeter.source('yours'); SwrMeter.type('fwd', '2'); SwrMeter.type('swr', '1.2'); SwrMeter.dev.func('cal'); SwrMeter.dev.cal(100); });
  st = await page.evaluate(() => document.getElementById('swm-mn-status').textContent);
  ok('2 W cannot reach the CAL mark even at MAX — and it says the SWR cannot be read', /not enough power to calibrate/.test(st), st);
  await page.evaluate(() => { SwrMeter.type('fwd', ''); SwrMeter.type('swr', ''); SwrMeter.source('scenario'); });

  // The 3030.
  await page.evaluate(() => { SwrMeter.scenario('healthy'); SwrMeter.pick('cc3030'); SwrMeter.dev.cc('rl', true); });
  const cc = await page.evaluate(() => ({ fwd: document.getElementById('swm-cc-fwd').textContent, ru: document.getElementById('swm-cc-ru').textContent,
    rev: document.getElementById('swm-cc-rev').textContent, sl: document.getElementById('swm-cc-sl').textContent, rl: document.getElementById('swm-cc-swr').textContent }));
  ok('the 3030: FWD 4.89 W, REV 59.7 mW, and 19.1 dB of return loss', cc.fwd === '4.89' && cc.rev === '59.7' && cc.ru === 'mW' && cc.sl === 'R.L' && cc.rl === '19.1 dB', J(cc));

  // Your readings, typed.
  await page.evaluate(() => SwrMeter.source('yours'));
  await page.fill('#swm-y-fwd', '3.8');
  await page.fill('#swm-y-swr', '1.01');
  await page.fill('#swm-y-setW', '5');
  const y = await page.evaluate(() => ({ v: document.getElementById('swm-verdict').textContent, focus: document.activeElement.id, fwd: document.getElementById('swm-cc-fwd').textContent }));
  ok('readings typed are read back — a little down on power — and the box keeps its focus', /A little down on power/.test(y.v) && /1\.2 dB off every link/.test(y.v) && y.focus === 'swm-y-setW' && y.fwd === '3.80', J({ focus: y.focus, fwd: y.fwd }));

  // The text, and ⤓ Export.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => SwrMeter.exportTxt())]);
  const txt = fs.readFileSync(await dl.path(), 'utf8');
  ok('the check saves as floodnet-swr-check.txt, readings and verdict in words', dl.suggestedFilename() === 'floodnet-swr-check.txt'
    && /Flood-Net — SWR check/.test(txt) && /Forward: 3\.80 W/.test(txt) && /A little down on power/.test(txt), dl.suggestedFilename());
  const offers = await page.evaluate(() => ExportMenu.offers('swr').map(o => o.label));
  ok('⤓ Export offers it', offers.length === 1 && /This check/.test(offers[0]), J(offers));

  // The case, and the tab opened from the inspection form.
  await page.evaluate(() => SwrMeter.loadCase());
  await until(page, () => !!document.getElementById('swm-y-fwd'));
  const cs = await page.evaluate(() => ({ fwd: document.getElementById('swm-y-fwd').value, swr: document.getElementById('swm-y-swr').value, meter: SwrMeter.state().meter,
    pressed: [...document.querySelectorAll('.swm-pick-btn')].filter(b => b.getAttribute('aria-pressed') === 'true').length }));
  ok('the case lands on the bench: the SW-102, 3.8 W at 1.01', cs.fwd === '3.8' && cs.swr === '1.01' && cs.meter === 'sw102' && cs.pressed === 1, J(cs));
  await page.evaluate(() => SwrMeter.open({ fwd: 4.2, ref: 0.35, swr: null, setW: 5, from: 'inspections' }));
  await until(page, () => !!document.getElementById('swm-y-fwd'));
  const fromInsp = await page.evaluate(() => ({ fwd: document.getElementById('swm-y-fwd').value, ref: document.getElementById('swm-y-ref').value,
    back: [...document.querySelectorAll('#swm-verdict button')].some(b => /Back to the inspection/.test(b.textContent)) }));
  ok('opened from the inspection form: its readings typed in, and a way back', fromInsp.fwd === '4.2' && fromInsp.ref === '0.35' && fromInsp.back, J(fromInsp));
  ok('the inspection form has the button that does it', fs.readFileSync(repo('inspections.js'), 'utf8').includes('onclick="Inspections.swrCheck()"')
    && await page.evaluate(() => typeof Inspections.swrCheck === 'function'));

  // The loop runs when asked, and stops on the way out.
  await page.evaluate(() => SwrMeter.play());
  await page.waitForTimeout(300);
  const running = await page.evaluate(() => SwrMeter.state().running);
  await page.evaluate(() => switchTab('home'));
  const stopped = await page.evaluate(() => SwrMeter.state().running);
  ok('▶ Animate runs the loop; leaving the tab stops it', running === true && stopped === false, J([running, stopped]));
  await context.close();

  // A phone, dark.
  ({ context, page } = await openTab({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' }));
  await page.waitForTimeout(400);
  const phone = await page.evaluate(() => ({ lay: SwrMeter.state().lay, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  ok('375 px: the line stands up the mast, and nothing scrolls sideways', phone.lay === 'tall' && phone.over <= 0, J(phone));
  await context.close();

  ok('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes + failures} assertion(s), ${failures} failed.`);
if (failures) process.exit(1);
console.log('PASS — the SWR Meter\'s arithmetic, and the tab.');
