// The 💾 A2 Firmware tab (a2-firmware.js), Node then Chromium.
//
//   The steps held to themselves: every path's steps exist and run in
//   ELPRO's order (the stick, the check, host, bootloader, radio, function
//   image, finish), the whole upgrade holding each step once; every step says
//   which side the hands are on and has the drawing to show it — a unit step
//   moves the unit, a laptop step fills a window. The frames: pure (the same
//   picture asked for twice), the stick in after it goes in and out after it
//   comes out, D1 lit as TEST is let go and all four lit at the end of a
//   load; the terminal's version screen saying v1.6 before and the ERROR an
//   old radio gives after a new bootloader, the option picked lit within its
//   line, FI:6015 at the end. The checker against ELPRO's own examples:
//   each line read in both formats, the parts behind Release G named in
//   ELPRO's order, a part already current left alone, a radio at V1.2
//   stopped, FI:2044 taken as the ALERT2 report format's; and the checklist.
//
//   The tab in Chromium: in the Knowledge base with seven sections; playing
//   as it opens, and still when the device asks for reduced motion; the
//   ring moving between the unit and the laptop as the steps do; Back, Next,
//   the dots, the keys and the scrubber; a path picked; a pasted screen
//   making a walkthrough of just what that unit needs; ▶ Show me from the
//   written steps; the checklist saved and ⤓ Export offering it; the loop
//   stopped on the way out; a phone's width in the dark.
//
// Run:  npm run a2firmware
//       npm run a2firmware -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
function ok(name, pass, detail = '') {
  if (pass) passes++; else failures++;
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? `\n      ${detail}` : ''}`);
}
const J = v => JSON.stringify(v);

// ── Node: the module on its own ──────────────────────────────────────────────
const ctx = { console, esc: s => String(s ?? ''), escAttr: s => String(s ?? ''), window: undefined };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(repo('a2-firmware.js'), 'utf8') + '\n;globalThis.A2Firmware = A2Firmware;', ctx, { filename: 'a2-firmware.js' });
const F = ctx.A2Firmware;

console.log('\nThe steps\n');
{
  const ORDER = ['prep', 'check', 'host', 'boot', 'radio', 'fi', 'done'];
  const bad = [];
  for (const [id, p] of Object.entries(F.PATHS)) {
    const missing = p.steps.filter(s => !F.STEPS[s]);
    if (missing.length) bad.push(`${id}: ${missing.join(', ')}`);
    const parts = p.steps.filter(s => F.STEPS[s]).map(s => ORDER.indexOf(F.STEPS[s].part));
    if (parts.some((x, i) => i && x < parts[i - 1])) bad.push(`${id}: out of order`);
  }
  ok('every path\'s steps exist, in ELPRO\'s order', !bad.length, bad.join('; '));
  const all = F.PATHS.all.steps;
  ok('the whole upgrade holds every step once', new Set(all).size === all.length && Object.keys(F.STEPS).every(s => all.includes(s)),
    J(Object.keys(F.STEPS).filter(s => !all.includes(s))));
  const shape = Object.entries(F.STEPS).filter(([, s]) => !(
    (s.side === 'unit' || s.side === 'pc') && s.title && s.do && s.dur > 0 && s.still >= 0 && s.still <= s.dur
    && (s.side === 'unit' ? (s.unit || []).length > 0 : !!s.pc))).map(([k]) => k);
  ok('every step says where the hands are, and has the drawing to show it', !shape.length, J(shape));
  const host = F.PATHS.all.steps.indexOf('h-in'), boot = F.PATHS.all.steps.indexOf('b-menu'), radio = F.PATHS.all.steps.indexOf('r-menu'), fi = F.PATHS.all.steps.indexOf('f-menu');
  ok('host, then bootloader, then radio, then function image', host < boot && boot < radio && radio < fi, J([host, boot, radio, fi]));
}

console.log('\nThe frames\n');
{
  const all = F.PATHS.all.steps;
  const at = (sid, t) => F.frame('all', all.indexOf(sid), t);
  ok('a frame is a pure function of path, step and time', J(at('h-press', 3.1)) === J(at('h-press', 3.1)));
  ok('the stick goes in, and stays in into the next step', at('h-in', 99).unit.stick === 1 && at('h-press', 0).unit.stick === 1, J([at('h-in', 99).unit.stick, at('h-press', 0).unit.stick]));
  const press = at('h-press', F.STEPS['h-press'].still).unit;
  ok('holding TEST: the finger on it, the ring round it, D1 lit and the others not', press.fin > 0.99 && press.finP > 0 && press.d[0] > 0 && press.d[1] === 0, J(press));
  const drv = at('h-press', 1.35).unit;
  ok('…after the screwdriver taps RESET', drv.drv > 0.99 && drv.drvP > 0, J({ drv: drv.drv, p: drv.drvP }));
  ok('all four lit at the end of the host\'s load', J(at('h-leds', 99).unit.d) === J([1, 1, 1, 1]), J(at('h-leds', 99).unit.d));
  const out = at('h-out', 99).unit;
  ok('the stick out and the LEDs dark after the restart', out.stick === 0 && out.d.every(x => x === 0), J(out));
  ok('re-seated: out half-way through, in at the end', at('r-in', 1.3).unit.stick < 0.05 && at('r-in', 99).unit.stick === 1);
  const txt = f => (f.pc && f.pc.lines ? f.pc.lines.map(l => l.t + (l.fi ? ' ' + l.fi : '')).join('\n') : '');
  ok('the first check reads host v1.6', /Firmware: v1\.6 Aug 25 2022 14:43:29 : 9814/.test(txt(at('ver', 99))), txt(at('ver', 99)));
  const b = txt(at('b-ver', 99));
  ok('after the bootloader: v1.3 - 9967, and the old radio\'s ERROR', /Host Bootloader: v1\.3 - 9967/.test(b) && /ERROR: Could not read parameter value/.test(b) && /Old version - Update Recommended/.test(b), b);
  ok('after the function image: FI:6015 at the end of the radio\'s line', /Radio Firmware: v1\.4 .*\(10848\) FI:6015/.test(txt(at('f-ver', 99))), txt(at('f-ver', 99)));
  const picked = at('ver', 1.2).pc.lines.filter(l => l.picked).map(l => l.pk);
  ok('the option picked is lit within its line: d) Unit Diagnostic', J(picked) === J(['d) Unit Diagnostic']), J(picked));
  ok('a unit step leaves the laptop\'s screen as it was', txt(at('h-in', 2)) === txt(at('save', 99)));
}

console.log('\nThe checker, on ELPRO\'s examples\n');
{
  const A = text => { const a = F.advise(F.parse(text)); return { parts: a.parts.join(','), stop: a.stop, host: a.host?.state, boot: a.boot?.state, radio: a.radio?.state, fi: a.fi?.state, empty: !!a.empty }; };
  const p16 = F.parse('Firmware: v1.6 Aug 25 2022 14:43:29 : 9814\nHost Bootloader: v1.1 - 8708:261:33:0:0\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.4,9869');
  ok('V1.6\'s screen read: host 1.6 : 9814, bootloader 1.1 - 8708, radio FW1.4,9869',
    J(p16.host) === J({ v: [1, 6], build: 9814 }) && J(p16.boot) === J({ v: [1, 1], build: 8708 }) && J(p16.radio) === J({ v: [1, 4], build: 9869, fmt: 'old' }), J(p16));
  ok('…and needs all four, host first', A('Firmware: v1.6 Aug 25 2022 14:43:29 : 9814\nHost Bootloader: v1.1 - 8708:261:33:0:0\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.4,9869').parts === 'host,boot,radio,fi');
  const v17 = A('Firmware: v1.7 Dec 20 2023 11:33:41 : 10177\nHost Bootloader: v1.3 - 9967:24:31:0:0\nRadio Firmware: v1.4 [Jun 12 2023 13:16:43] (10075)');
  ok('V1.7 of 2023: host (an older 1.7), radio and function image — the bootloader left alone', v17.parts === 'host,radio,fi' && v17.boot === 'ok', J(v17));
  const relf = A('Firmware: v1.7 Sep 20 2024 17:32:50 : 10366\nHost Bootloader: v1.3 - 9967:0:15:2:0\nRadio Firmware: v1.4 [Jul 26 2024 17:27:44] (10301) FI:6015');
  ok('Release F, finished: the radio\'s application only — FI:6015 is current, so not re-applied', relf.parts === 'radio' && relf.fi === 'ok', J(relf));
  const relg = A('Firmware: v1.7 Sep 20 2024 17:32:50 : 10366\nHost Bootloader: v1.3 - 9967:0:15:2:0\nRadio Firmware: v1.4 [Apr 24 2026 11:52:00] (10848) FI:6015');
  ok('Release G: nothing to load', relg.parts === '' && !relg.stop && relg.host === 'ok' && relg.radio === 'ok', J(relg));
  const err = F.advise(F.parse('Firmware: v1.7 Nov 30 2022 17:04:17 : 9972\nHost Bootloader: v1.3 - 9967:0:0:0:0\nERROR: Could not read parameter value\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.3,9543\n        ** Old version - Update Recommended **'));
  ok('after a bootloader, before the radio: the ERROR explained, radio and function image needed', err.parts.join(',') === 'host,radio,fi' && err.notes.length === 1, J(err.parts));
  const old = A('Firmware: v1.6 Aug 25 2022 14:43:29 : 9814\nHost Bootloader: v1.1 - 8708:261:33:0:0\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.2,9001');
  ok('a radio at V1.2: stop, and nothing offered', old.stop && old.radio === 'stop' && old.parts === '', J(old));
  ok('a host under v1.4: stop', A('Firmware: v1.3 Jan 1 2021 10:00:00 : 7000').stop);
  ok('FI:2044 is the ALERT2 report format\'s, and current', A('Firmware: v1.7 Sep 20 2024 17:32:50 : 10366\nHost Bootloader: v1.3 - 9967:0:15:2:0\nRadio Firmware: v1.4 [Apr 24 2026 11:52:00] (10848) FI:2044').fi === 'ok');
  ok('nothing pasted, or nonsense: no verdict', A('').empty && A('hello there\n12345').empty);
}

console.log('\nThe checklist\n');
{
  const t = F.checklistText();
  ok('every step of the whole upgrade, a box each, and the warnings', (t.match(/^\[ \] \d+\. /gm) || []).length === F.PATHS.all.steps.length && /WARNING: Never interrupt the bootloader/.test(t), t.slice(0, 200));
  ok('it names Flood-Net and ELPRO\'s release', /Flood-Net checklist/.test(t) && /Release G \(24-4-26\)/.test(t));
}

// ── Chromium: the tab ────────────────────────────────────────────────────────
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
  await until(page, () => typeof state !== 'undefined' && typeof switchTab === 'function', null, LOAD_TIMEOUT);
  await page.evaluate(() => { try { localStorage.removeItem('mn-a2-firmware'); } catch (_) {} switchTab('a2firmware'); });
  await until(page, () => !!document.getElementById('fw-page'));
  return { context, page };
}
const look = page => page.evaluate(() => ({
  ...A2Firmware.state(),
  unitOn: document.getElementById('fw-pane-unit').classList.contains('is-active'),
  pcOn: document.getElementById('fw-pane-pc').classList.contains('is-active'),
  title: document.getElementById('fw-cap-title').textContent,
  dot: document.querySelector('.fw-dot.is-on')?.getAttribute('aria-label') || '',
}));

try {
  let { context, page } = await openTab();
  const shape = await page.evaluate(() => ({
    group: TABS.find(g => g.tabs.some(t => t.id === 'a2firmware')).group,
    secs: ['fw-walk', 'fw-prep', 'fw-ver', 'fw-list', 'fw-leds', 'fw-trouble', 'fw-src'].filter(id => document.getElementById(id)).length,
    paths: document.querySelectorAll('.fw-path').length,
    dots: document.querySelectorAll('.fw-dot').length,
    listed: document.querySelectorAll('.fw-step').length,
    named: [...document.querySelectorAll('#fw-page svg[role="img"]')].every(s => !!(s.querySelector('title') || {}).textContent),
  }));
  ok('in the Knowledge base: seven sections, seven paths, a dot for each of the whole upgrade\'s steps and each written out',
    shape.group === 'Knowledge base' && shape.secs === 7 && shape.paths === 7 && shape.dots === shape.listed && shape.dots > 20, J(shape));
  ok('the board is named', shape.named);
  await page.waitForTimeout(700);
  let s = await look(page);
  ok('it plays as it opens: the first step running, the laptop ringed', s.playing && s.running && s.t > 0.2 && s.pcOn && !s.unitOn, J(s));

  // Pause, and the clock stops.
  await page.click('#fw-play');
  const t0 = (await look(page)).t;
  await page.waitForTimeout(400);
  s = await look(page);
  ok('⏸ Pause stops it where it is', !s.playing && !s.running && s.t === t0, J({ t0, t: s.t }));

  // To the cable: the unit is ringed, and the caption follows.
  await page.evaluate(() => A2Firmware.step(A2Firmware.state().steps.indexOf('cable')));
  s = await look(page);
  ok('a unit step rings the unit and says so', s.step === 'cable' && s.unitOn && !s.pcOn && /USB B socket/.test(s.title) && s.dot.startsWith(`Step ${s.i + 1}:`), J(s));
  await page.click('#fw-next');
  s = await look(page);
  ok('Next ▶ to the terminal: the ring moves to the laptop', s.step === 'term' && s.pcOn && !s.unitOn, J(s));
  await page.click('#fw-back');
  ok('◀ Back returns', (await look(page)).step === 'cable');
  await page.focus('#fw-stage');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  s = await look(page);
  ok('→ steps with the walkthrough focused', s.step === 'ver', J(s.step));
  await page.keyboard.press(' ');
  s = await look(page);
  ok('Space plays, from the step\'s start', s.playing && s.t < 0.5, J(s));
  await page.keyboard.press(' ');

  // A dot jumps; the scrubber moves the picture.
  const nLeds = await page.evaluate(() => A2Firmware.state().steps.indexOf('h-leds') + 1);
  await page.click(`.fw-dot[aria-label^="Step ${nLeds}:"]`);
  s = await look(page);
  ok('a dot jumps to its step', s.i === nLeds - 1 && s.step === 'h-leds', J(s));
  await page.evaluate(() => A2Firmware.seek(1));
  let leds = await page.evaluate(() => [0, 1, 2, 3].map(i => +document.getElementById(`fw-led-${i}`).getAttribute('opacity')));
  ok('the scrubber at the end: all four LEDs lit on the drawing', leds.every(x => x > 0.99), J(leds));
  await page.evaluate(() => { A2Firmware.step(A2Firmware.state().steps.indexOf('h-press')); A2Firmware.seek(3.2 / A2Firmware.STEPS['h-press'].dur); });
  const hold = await page.evaluate(() => ({ fin: document.getElementById('fw-fin').getAttribute('opacity'), ring: +document.getElementById('fw-hold').getAttribute('stroke-dashoffset'),
    badge: document.getElementById('fw-badge-t').textContent }));
  ok('half-way through the hold: the finger on TEST, its ring filling, the badge saying why', hold.fin === '1' && hold.ring > 1 && hold.ring < 163 && /Hold TEST until D1/.test(hold.badge), J(hold));
  const term = await page.evaluate(() => { A2Firmware.step(A2Firmware.state().steps.indexOf('ver')); A2Firmware.seek(1);
    return { text: document.querySelector('#fw-pc .fw-term').textContent, sim: !!document.querySelector('#fw-pc .fw-sim') }; });
  ok('the laptop\'s terminal shows the version screen, marked Simulated', /Host Bootloader: v1\.1 - 8708/.test(term.text) && term.sim, term.text.slice(-200));

  // A path.
  await page.click('.fw-path[onclick*="\'radio\'"]');
  s = await look(page);
  ok('Radio firmware: its own steps, from the first', s.path === 'radio' && s.i === 0 && s.steps.includes('r-menu') && !s.steps.includes('h-in'), J(s.steps));

  // The checker, and its walkthrough.
  await page.evaluate(() => A2Firmware.example('v16'));
  const verdict = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#fw-verdict .fw-v--update')].length, btn: !!document.querySelector('#fw-verdict button') }));
  ok('ELPRO\'s first example: four parts needed, and a walkthrough offered', verdict.rows === 4 && verdict.btn, J(verdict));
  await page.click('#fw-verdict button');
  s = await look(page);
  ok('…which is a path of its own, the host first', s.path === 'mine' && s.steps.includes('h-press') && s.steps.includes('f-ver') && !s.steps.includes('get'), J(s.steps));
  await page.fill('#fw-before', 'Firmware: v1.6 Aug 25 2022 14:43:29 : 9814\nHost Bootloader: v1.1 - 8708:261:33:0:0\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.2,9001');
  const stop = await page.evaluate(() => ({ text: document.getElementById('fw-verdict').textContent, btn: !!document.querySelector('#fw-verdict button') }));
  ok('a radio at V1.2 typed in: stop, and no walkthrough', /Do not start/.test(stop.text) && !stop.btn, stop.text.slice(0, 120));

  // ▶ Show me, from the written steps.
  await page.click('#fw-li-b-menu button');
  s = await look(page);
  ok('▶ Show me on a written step plays it in the walkthrough', s.step === 'b-menu' && s.playing && s.pcOn, J(s));

  // The file, and the banner's Export.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => A2Firmware.exportTxt())]);
  const txt = fs.readFileSync(await dl.path(), 'utf8');
  ok('the checklist saves as floodnet-erta2-firmware-checklist.txt, a box a step', dl.suggestedFilename() === 'floodnet-erta2-firmware-checklist.txt' && /^\[ \] 1\. /m.test(txt), dl.suggestedFilename());
  const offers = await page.evaluate(() => ExportMenu.offers('a2firmware').map(o => o.label));
  ok('⤓ Export offers it', J(offers) === J(['These steps, as a checklist — TXT']), J(offers));

  // Out of the tab, the loop stops.
  await page.evaluate(() => switchTab('home'));
  ok('leaving the tab stops the animation', !(await page.evaluate(() => A2Firmware.state().running)));
  await context.close();

  // Reduced motion: still, on the telling moment.
  ({ context, page } = await openTab({ reducedMotion: 'reduce' }));
  s = await look(page);
  ok('reduced motion: paused as it opens, on the step\'s telling moment', !s.playing && !s.running && s.t > 0, J(s));
  await context.close();

  // A phone, dark.
  ({ context, page } = await openTab({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' }));
  await page.evaluate(() => { A2Firmware.path('all'); A2Firmware.step(9); });
  await page.waitForTimeout(200);
  const phone = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    unit: document.getElementById('fw-unit').getBoundingClientRect().width, stacked: document.getElementById('fw-pane-pc').getBoundingClientRect().top > document.getElementById('fw-pane-unit').getBoundingClientRect().bottom - 1 }));
  ok('375 px in the dark: nothing scrolls sideways, the unit above the laptop', phone.over <= 0 && phone.unit <= 375 && phone.stacked, J(phone));
  await context.close();

  ok('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes + failures} assertion(s), ${failures} failed.`);
if (failures) process.exit(1);
console.log('PASS — the A2 Firmware steps, its checker, and the tab.');
