// The 💾 ERT-A2 Simulator tab (a2-firmware.js) and its console
// (a2-terminal.js), Node then Chromium.
//
//   The console held to the PuTTY logs in archive/ERTA2_logs/: the first
//   1,098 lines of the 28 Oct 2026 log replayed through it, line for line;
//   the login, a value prompt holding its value (Enter keeps it, Backspace
//   and ← edit it, a letter refused), Tx Power's one key, a frequency to six
//   places and 152 refused, the repeater delay wrapping at 65536, Show/Save
//   ending "Press any key.." with nothing unsaved and asking with something
//   unsaved, Exit's Unsaved Changes, the timeout discarding, the format change
//   restarting the radio and FI:2044, a load taking the link off-line and an
//   option no log shows saying so.
//
//   The keys: one the unit answers held, lit, on its prompt with its option
//   lit, before the answer; a digit lit as it is typed; the keycaps; every
//   terminal step settling before it ends. The steps held to themselves: every path's steps exist and run in
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
//   stopped on the way out; a phone's width in the dark. The settings demos
//   each ending with the change made and saved. Interactive: typed and
//   tapped, a load lighting the board, Reconnect.
//
// Run:  npm run a2firmware
//       npm run a2firmware -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { cleanLog, replay } from './lib/a2-replay.mjs';

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
vm.runInContext(fs.readFileSync(repo('a2-terminal.js'), 'utf8') + '\n;globalThis.A2Terminal = A2Terminal;', ctx, { filename: 'a2-terminal.js' });
vm.runInContext(fs.readFileSync(repo('a2-firmware.js'), 'utf8') + '\n;globalThis.A2Firmware = A2Firmware;', ctx, { filename: 'a2-firmware.js' });
const F = ctx.A2Firmware;
const T = ctx.A2Terminal;

console.log('\nThe console, against the logs\n');
{
  // The whole of the 28 Oct 2026 log up to where its unit's address changes
  // off the record: a repeater on RS-232 backhaul, logged in, every menu.
  const log = cleanLog(fs.readFileSync(repo('archive/ERTA2_logs/20261028 COM24-0.txt')));
  const r = replay(T, log, { stop: 1098, create: { profile: 'repeater', cfg: { rssiDbm: 0, heard: [], battery: 'External Lead-Acid' } } });
  ok('the 28 Oct 2026 log: its first 1,098 lines printed line for line', r.ok && r.n >= 1090, J(r));

  const text = e => e.lines.map(l => l.t).join('\n');
  const scr = e => T.screen(e, 40).map(l => l.t).join('\n');
  const openLine = e => (e.lines[e.lines.length - 1] || {}).t;
  const up = () => { const e = T.create(); T.key(e, 'Enter'); T.key(e, 'a'); T.type(e, 'secret'); return e; };
  let e = up();
  ok('Enter wakes it; a) Engineer, a password as stars, Login Successful! and the header over the Main Menu',
    /Password:\*{6}/.test(text(e)) && /Login Successful!/.test(text(e)) && /UTC; Station Address: 1000/.test(scr(e)) && e.at.id === 'main', scr(e));
  T.key(e, 'a'); T.key(e, 'a');
  ok('a value prompt holds the value now, the cursor after it', openLine(e) === '\t\tStation Address: 1000' && e.at.k === 'value', J(openLine(e)));
  T.key(e, 'Enter');
  ok('…Enter on its own keeps it, and nothing is unsaved', e.cfg.address === 1000 && !e.dirty && !/Config NOT Saved/.test(scr(e)));
  T.key(e, 'a'); T.type(e, '22x5');
  ok('a letter in it: Invalid Format!', /\t\tInvalid Format!/.test(text(e)) && e.cfg.address === 1000);
  T.key(e, 'a'); T.type(e, '2205');
  ok('Backspaced and typed: the new address, and Config NOT Saved', e.cfg.address === 2205 && e.dirty && /\tConfig NOT Saved/.test(scr(e)), scr(e));
  T.key(e, 'Enter'); T.key(e, 'c'); T.key(e, 'c');
  for (let i = 0; i < 5; i++) T.key(e, 'ArrowLeft');
  T.key(e, '2'); T.key(e, '5'); T.key(e, 'Enter');
  ok('← five times and 25 over the zeros: 151.525000, as the log of 2 Jun 2026', e.cfg.txMHz === '151.525000' && /c\)\tTx Frequency MHz => 151\.525000/.test(scr(e)), e.cfg.txMHz);
  T.key(e, 'd'); T.type(e, '152');
  ok('152: Invalid value!, the frequency kept', /\t\t\tInvalid value!/.test(text(e)) && e.cfg.rxMHz === '151.500000');
  T.key(e, 'e');
  ok('Tx Power: one key over the 5 of 5W', /\t\tTx Power 5W$/.test(openLine(e)) && e.at.k === 'onekey');
  T.key(e, '1');
  ok('…1, and the menu straight back with 1W', e.cfg.txPower === '1W' && /e\)\tTx Power => 1W/.test(scr(e)) && e.at.id === 'comm');
  T.key(e, 'b'); T.key(e, 'c'); T.key(e, 'i'); T.type(e, '500010000');
  ok('a repeater\'s delay past 65535 wraps without a word, as the log of 2 Sep 2026: 35856', e.cfg.repDelayMs === 35856 && /i\)\tRepeater Delay \(mSec\) => 35856/.test(scr(e)), e.cfg.repDelayMs);
  T.key(e, 'Enter'); T.key(e, 'e');
  ok('an option no log shows used says so, rather than make it up', text(e).includes(T.NOT_LOGGED) && e.at.id === 'main');
  T.key(e, 'g');
  ok('Show/Save with changes unsaved: Save Current Config? (y/n):', /Save Current Config\? \(y\/n\):$/.test(openLine(e)));
  T.key(e, 'x');
  ok('…another key: Please Respond Y or N', /Please Respond Y or N/.test(scr(e)) && e.at.k === 'yn');
  T.key(e, 'y');
  ok('…y: Configuration Saved!!, then the header with no Config NOT Saved', /Configuration Saved!!/.test(text(e)) && !e.dirty && e.at.id === 'main' && !/Config NOT Saved/.test(scr(e)));
  T.key(e, 'g');
  ok('Show/Save with nothing unsaved ends Press any key..', openLine(e) === 'Press any key..');
  T.key(e, 'Enter'); T.key(e, 'a'); T.key(e, 'b'); T.type(e, '60'); T.key(e, 'Enter'); T.key(e, 'i');
  ok('Exit with a change unsaved: Unsaved Changes Selection, Save Changes starred, at Option:',
    /Unsaved Changes Selection:\n\t\ta\)\*\tSave Changes\n\t\tb\) \tKeep but don't save\n\t\tc\) \tDiscard Changes\n\t\td\)\tCancel\n\t\t\tOption:$/.test(text(e)), scr(e).slice(-200));
  T.key(e, 'd');
  ok('…d) Cancel: back at the Main Menu, still unsaved', e.at.id === 'main' && e.dirty);
  T.timeout(e);
  ok('left at the Main Menu: Timed out - Exiting, the change discarded, the login', /\tTimed out - Exiting\n\t\tDiscarding Unsaved Config Changes\.\.\./.test(text(e)) && e.cfg.updateMin === 180 && e.at.k === 'login');

  e = up();
  T.key(e, 'c'); T.key(e, 'f'); T.key(e, 'a'); T.key(e, 'Enter'); T.key(e, 'g'); T.key(e, 'y');
  ok('the report format changed and saved: ALERT Report Format changed. Restarting Radio....', /Configuration Saved!!\n\t\tALERT Report Format changed\. Restarting Radio\.\.\.\./.test(text(e)));
  T.key(e, 'd'); T.key(e, 'f');
  ok('…and on ALERT2 format the radio\'s function image is FI:2044', /Radio Firmware: v1\.4 .* FI:2044$/m.test(scr(e)), scr(e).slice(-160));
  T.key(e, 'Enter'); T.key(e, 'h'); T.key(e, 'c');
  const ev = T.takeEvents(e);
  ok('Load Firmware to Radio: no question, the link off-line, a load on the board', !e.link && ev.length === 1 && ev[0].k === 'load' && ev[0].job === 'radio', J(ev));
  T.key(e, 'Enter');
  ok('…keys go nowhere while it is off-line', !e.link && e.at.k === 'offline-wait');
  T.reconnect(e); T.key(e, 'Enter');
  ok('…reconnected and a key: the login, as the log of 28 Oct 2026', e.link && e.at.k === 'login');

  e = T.create({ profile: 'repeater', awake: true });
  T.key(e, 'a'); T.type(e, 'secret'); T.key(e, 'c');
  ok('a repeater\'s Communication Menu: its delay at i), its lists, its agency and its RS-232 link', /i\)\tRepeater Delay \(mSec\) => 543/.test(scr(e)) && /Address List Entries/.test(scr(e)) && /Serial Baud Rate => 9600/.test(scr(e)), scr(e));
}

console.log('\nThe steps\n');
{
  const ORDER = ['prep', 'check', 'host', 'boot', 'radio', 'fi', 'set', 'done'];
  const bad = [];
  for (const [id, p] of Object.entries(F.PATHS)) {
    const missing = p.steps.filter(s => !F.STEPS[s]);
    if (missing.length) bad.push(`${id}: ${missing.join(', ')}`);
    const parts = p.steps.filter(s => F.STEPS[s]).map(s => ORDER.indexOf(F.STEPS[s].part));
    if (parts.some((x, i) => i && x < parts[i - 1])) bad.push(`${id}: out of order`);
  }
  ok('every path\'s steps exist, in ELPRO\'s order', !bad.length, bad.join('; '));
  const all = F.PATHS.all.steps;
  const used = new Set(Object.values(F.PATHS).flatMap(p => p.steps));
  ok('the whole upgrade holds no step twice, and every step is on some path', new Set(all).size === all.length && Object.keys(F.STEPS).every(s => used.has(s)),
    J(Object.keys(F.STEPS).filter(s => !used.has(s))));
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
  const txt = f => (f.pc && f.pc.lines ? f.pc.lines.map(l => l.t).join('\n') : '');
  ok('the first check reads host v1.6', /Firmware: v1\.6 Aug 25 2022 14:43:29 : 9814/.test(txt(at('ver', 99))), txt(at('ver', 99)));
  const b = txt(at('b-ver', 99));
  ok('after the bootloader: v1.3 - 9967, and the old radio\'s ERROR', /Host Bootloader: v1\.3 - 9967/.test(b) && /ERROR: Could not read parameter value/.test(b) && /Old version - Update Recommended/.test(b), b);
  ok('after the function image: FI:6015 at the end of the radio\'s line', /Radio Firmware: v1\.4 .*\(10848\) FI:6015/.test(txt(at('f-ver', 99))), txt(at('f-ver', 99)));
  const fv = at('b-menu', 3.0).pc;
  const picked = fv.lines.filter(l => fv.pickNow && l.pick === fv.pickNow).map(l => l.t.trim());
  ok('the option picked is lit: a) Update Bootloader (ERTA2-B), the unit\'s own letter', J(picked) === J(['a)\tUpdate Bootloader (ERTA2-B)']), J(picked));
  ok('a unit step leaves the laptop\'s screen as it was', txt(at('h-in', 2)) === txt(at('save', 99)));

  // A key the unit answers is held on its prompt before the answer comes.
  const dAt = F.STEPS.ver.pc.keys.find(k => k.key === 'd').at;
  const mid = at('ver', dAt + 0.3).pc, after = at('ver', dAt + 0.9).pc;
  const last = f => f.lines[f.lines.length - 1].t;
  ok('d pressed: held on the Main Menu\'s prompt, the d lit and d) Unit Diagnostic picked, before the menu changes',
    /Selection: d$/.test(last(mid)) && J(mid.mark) === J([13, 14]) && mid.lines.some(l => l.pick === mid.pickNow && /d\)\tUnit Diagnostic/.test(l.t)) && /Unit Diagnostic Menu:/.test(txt({ pc: after })),
    J({ last: last(mid), mark: mid.mark }));
  ok('…its keycap in the tray, pressed down, then up and still there a second later',
    mid.keys.length === 1 && mid.keys[0].cap === 'd' && at('ver', dAt + 0.1).pc.keys[0].age < 0.28 && at('ver', dAt + 1.2).pc.keys.some(k => k.cap === 'd'), J(mid.keys));
  const sa = F.PATHS['set-addr'].steps.indexOf('s-addr');
  const two = F.STEPS['s-addr'].pc.keys.find(k => k.key === '2').at;
  const typing = F.frame('set-addr', sa, two + 0.1).pc;
  ok('a digit typed into a value shows at once, lit', /Station Address: 2$/.test(last(typing)) && typing.mark && last(typing).slice(...typing.mark) === '2', J({ last: last(typing), mark: typing.mark }));
  // Every terminal step has finished answering its keys with time to see the answer.
  const tight = [];
  for (const [id, p] of Object.entries(F.PATHS)) {
    p.steps.forEach((sid, i) => {
      const st = F.STEPS[sid];
      if (!st.pc || st.pc.win !== 'term') return;
      let lastChange = 0, prev = '';
      for (let t = 0; t <= st.dur + 2; t += 0.1) {
        const f = F.frame(id, i, t).pc;
        const sig = f.lines.map(l => l.t).join('\n') + J(f.mark) + f.pickNow;
        if (sig !== prev) { lastChange = t; prev = sig; }
      }
      if (lastChange > st.dur - 0.5) tight.push(`${id}/${sid} ${lastChange.toFixed(1)} of ${st.dur}`);
    });
  }
  ok('every terminal step settles at least half a second before it ends', !tight.length, tight.join('; '));
}

console.log('\nThe settings demos\n');
{
  // Each demo's screen where its last laptop step ends.
  const end = (id, sid) => { const k = F.PATHS[id].steps.indexOf(sid); const f = F.frame(id, k, 99); return f.pc.lines.map(l => l.t).join('\n'); };
  ok('the address: Backspaced, 2205 typed, saved — the header says 2205, nothing unsaved',
    /Station Address: 2205/.test(end('set-addr', 's-save')) && !/Config NOT Saved/.test(end('set-addr', 's-save')), end('set-addr', 's-save'));
  const k = F.PATHS['set-addr'].steps.indexOf('s-addr');
  ok('…its still picture the prompt with 2205 in it', /\t\tStation Address: 2205$/.test(F.frame('set-addr', k, F.STEPS['s-addr'].still).pc.lines.map(l => l.t).join('\n')));
  const ts = F.PATHS['set-times'].steps.indexOf('s-save');
  ok('the times: 60 min and 30 sec in the configuration printed before the save',
    /Update Time: 60min\t\tParalysis Time: 30sec/.test(F.frame('set-times', ts, F.STEPS['s-save'].still).pc.lines.map(l => l.t).join('\n')));
  const radio = end('set-radio', 's-power');
  ok('the channel and the power: 151.525000 both ways, 1W', /Tx Frequency MHz => 151\.525000/.test(radio) && /Rx Frequency MHz => 151\.525000/.test(radio) && /Tx Power => 1W/.test(radio), radio);
  ok('the repeater: Unit Type Repeater Station, its delay 400', /Unit Type => Repeater Station/.test(end('set-repeater', 's-delay')) && /Repeater Delay \(mSec\) => 400/.test(end('set-repeater', 's-delay')));
  ok('ALERT2: FI:2044, then Exit saving it, back at the login', /FI:2044/.test(end('set-format', 's-fi')) && /User Type: Menu:/.test(end('set-format', 's-exit')));
  ok('the log to USB: off-line, then reconnected, back at the Main Menu', F.frame('set-log', F.PATHS['set-log'].steps.indexOf('s-log'), 99).pc.offline && /Main Menu:/.test(end('set-log', 's-logback')));
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
    paths: document.querySelectorAll('.fw-path').length, nPaths: Object.keys(A2Firmware.PATHS).length,
    dots: document.querySelectorAll('.fw-dot').length,
    listed: document.querySelectorAll('.fw-step').length,
    named: [...document.querySelectorAll('#fw-page svg[role="img"]')].every(s => !!(s.querySelector('title') || {}).textContent),
  }));
  ok('in the Knowledge base: seven sections, a button for every path, a dot for each of the whole upgrade\'s steps and each written out',
    shape.group === 'Knowledge base' && shape.secs === 7 && shape.paths === shape.nPaths && shape.dots === shape.listed && shape.dots > 20, J(shape));
  ok('the board is named', shape.named);
  // It plays while it is on screen: scrolled to, as somebody reading would.
  await page.evaluate(() => document.getElementById('fw-stage').scrollIntoView({ block: 'center' }));
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
  const stick = await page.evaluate(() => {
    const k = A2Firmware.state().steps.indexOf('h-in');
    const tr = () => document.getElementById('fw-stick').getAttribute('transform');
    A2Firmware.step(k); A2Firmware.seek(0); const out = tr();
    A2Firmware.seek(1); const into = tr();
    return { out, into, plug: document.getElementById('fw-stick-plug').getAttribute('opacity') };
  });
  const xy = t => (/translate\(([-\d.]+) ([-\d.]+)\)/.exec(t) || []).slice(1).map(Number);
  ok('the stick comes straight out of its socket towards you — up and to the right — and sits on it, its metal hidden, once in',
    xy(stick.out)[0] > 30 && xy(stick.out)[1] < -20 && J(xy(stick.into)) === J([0, 0]) && stick.plug === '0.000', J(stick));
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

  // Interactive: the unit's console, live.
  await page.click('.fw-mode[onclick*="live"]');
  let lv = await page.evaluate(() => ({ mode: A2Firmware.state().mode, demoHidden: document.getElementById('fw-demo-foot').hidden, liveShown: !document.getElementById('fw-live-foot').hidden }));
  ok('Interactive swaps the demo\'s controls for the terminal\'s', lv.mode === 'live' && lv.demoHidden && lv.liveShown, J(lv));
  await page.focus('#fw-stage');
  await page.keyboard.press('Enter');
  await page.keyboard.press('a');
  await page.keyboard.type('anything');
  await page.keyboard.press('Enter');
  lv = await page.evaluate(() => A2Firmware.state().live);
  ok('typed: Enter wakes it, a) Engineer, a password as stars, Login Successful! and the Main Menu',
    /Login Successful!/.test(lv.log) && /Password:\*{8}/.test(lv.log) && lv.menu === 'main', lv.log.slice(-300));
  await page.keyboard.press('a');
  await page.keyboard.press('a');
  await page.fill('#fw-live-text', '2205');
  await page.click('.fw-live-in button[type="submit"]');
  lv = await page.evaluate(() => A2Firmware.state().live);
  ok('a value sent from the box replaces the one the prompt held', lv.cfg.address === 2205 && lv.dirty && lv.menu === 'unitcfg', J({ a: lv.cfg.address, menu: lv.menu }));
  await page.focus('#fw-stage');
  await page.keyboard.press('Enter');
  await page.evaluate(() => A2Firmware.liveStick());
  for (const k of ['d', 'h', 'a', 'y']) await page.keyboard.press(k);
  lv = await page.evaluate(() => A2Firmware.state().live);
  ok('d, h, a, y with the stick in: the bootloader\'s own words, and the link off-line while the board is busy',
    /This action will update the Boot-Loader with the file on USB/.test(lv.text) && !lv.link && lv.busy && await page.evaluate(() => document.getElementById('fw-pane-unit').classList.contains('is-active')), J({ link: lv.link, busy: lv.busy }));
  await until(page, () => !A2Firmware.state().live.busy && document.getElementById('fw-led-3').getAttribute('opacity') === '1.000', null, 15_000);
  ok('…D1 to D4 lit on the board, then Reconnect asked for', await page.evaluate(() => !document.getElementById('fw-live-recon').disabled));
  await page.click('#fw-live-recon');
  await page.keyboard.press('Enter');
  lv = await page.evaluate(() => A2Firmware.state().live);
  ok('reconnected and a key: back at the Unit Diagnostic menu, as the unit does after a bootloader', lv.link && lv.menu === 'diag', J(lv.menu));
  await page.click('#fw-pc .tm-m:text("Show Firmware Version")');
  lv = await page.evaluate(() => A2Firmware.state().live);
  ok('a menu line tapped is its letter: f) Show Firmware Version', /Host Bootloader: v1\.3 - 9967/.test(lv.text) && lv.at === 'any', lv.text.slice(-200));
  await page.click('.fw-mode[onclick*="demo"]');

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
console.log('PASS — the ERT-A2 Simulator: its console against the logs, the steps, the demos, the checker and the tab.');
