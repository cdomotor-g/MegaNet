// The 🪛 Pinouts tab (pinout-data.js, pinouts.js), Node then Chromium.
//
//   The library held to itself: every connector's pins named once, of a
//   kind the legend knows, how sure it is said and its sources linked; every
//   D-sub with the pins its shell holds; every cable's wires and loops landing
//   on pins that exist; the colours a cable's listing gives matching the ones
//   its radio's or header's own table gives; the DCE end of RS-232 the DTE's
//   with every direction turned round; the 9-to-25 adapter keeping each
//   signal's name. The field finding on the ERT-A2's internal DB9 — DTR, RTS
//   and RX held high or nothing comes out — on its pins, its cable and in the
//   CSV. Where a pin sits: a male DE-9's pin 1 top left from the
//   front, a socket's top right, and the back of either the mirror of its
//   front. The 4–20 mA arithmetic against figures worked by hand: the scale,
//   the volts across a resistor, NAMUR NE 43's bands at their edges, and the
//   loop's voltage — the WL3100 into a CR300 short of 9 V only at its 24 mA
//   fault, across 250 Ω on 12 V short at 20 mA. The CSV a row a pin.
//
//   The tab in Chromium: every connector a card; a pin picked on the drawing
//   lighting its row, and a row's button lighting the pin; arrow keys walking
//   the pins with focus; the plug that mates drawn as sockets with pin 1 on
//   the right, and turned to the wire side back on the left; the find box and
//   the kinds narrowing the cards; a hook-up drawn wire by wire and ticked off;
//   the calculator's three boxes following each other and its set-ups judged;
//   the CSV saved and ⤓ Export offering it; opened on a connector from
//   another tab; a phone's width in the dark.
//
// Run:  npm run pinouts
//       npm run pinouts -- -v    also print what passed

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
vm.runInContext(fs.readFileSync(repo('pinout-data.js'), 'utf8') + ';this.D = PinoutData;', ctx, { filename: 'pinout-data.js' });
const { D } = ctx;

console.log('\nThe library, held to itself\n');
{
  const ids = D.CONNECTORS.map(c => c.id);
  ok(`${ids.length} connectors, each id once`, ids.length >= 25 && new Set(ids).size === ids.length, J(ids.filter((x, i) => ids.indexOf(x) !== i)));
  const bad = [];
  for (const c of D.CONNECTORS) {
    const ns = c.pins.map(p => p.n);
    if (new Set(ns).size !== ns.length) bad.push(`${c.id}: a pin named twice`);
    if (!D.SURE[c.sure]) bad.push(`${c.id}: sure "${c.sure}"`);
    if (!D.CATS.some(([k]) => k === c.cat)) bad.push(`${c.id}: cat "${c.cat}"`);
    if (!['dsub', 'circular', 'strip', 'header'].includes(c.face.type)) bad.push(`${c.id}: face "${c.face.type}"`);
    if (!['M', 'F', ''].includes(c.gender)) bad.push(`${c.id}: gender "${c.gender}"`);
    if (!c.name || !c.short || !c.unit || !c.find) bad.push(`${c.id}: a name, short name, unit or find words missing`);
    for (const p of c.pins) {
      if (!D.KINDS[p.kind]) bad.push(`${c.id} ${p.n}: kind "${p.kind}"`);
      if (!['out', 'in', 'both', ''].includes(p.dir)) bad.push(`${c.id} ${p.n}: dir "${p.dir}"`);
      if (!p.sig || !p.what) bad.push(`${c.id} ${p.n}: no signal or no words`);
    }
    for (const s of c.sources || []) if (!/^https:\/\//.test(s.href) || !s.label) bad.push(`${c.id}: a source without an https link or a label`);
    if (c.sure !== 'general' && !(c.sources || []).length) bad.push(`${c.id}: "${c.sure}" with no source to show for it`);
    if (c.face.type === 'dsub') {
      const want = D.DSUB[c.face.shell].reduce((a, b) => a + b, 0);
      if (J(ns) !== J(Array.from({ length: want }, (_, i) => String(i + 1)))) bad.push(`${c.id}: a ${c.face.shell} with pins ${ns.join(',')}`);
    }
    if (/meganet/i.test(J(c))) bad.push(`${c.id}: says MegaNet`);
  }
  ok('every pin once, of a kind the legend knows, every source linked, every D-sub its shell\'s pins', !bad.length, bad.slice(0, 6).join(' | '));

  const cb = [];
  for (const k of D.CABLES) {
    if (!D.SURE[k.sure]) cb.push(`${k.id}: sure`);
    if (!D.endConns(k.a).length) cb.push(`${k.id}: end A lands nowhere`);
    if (k.b && !D.endConns(k.b).length) cb.push(`${k.id}: end B lands nowhere`);
    for (const w of k.wires) if (!D.endPin(k.a, w[0]) || !D.endPin(k.b, w[1])) cb.push(`${k.id}: wire ${w[0]}→${w[1]}`);
    for (const side of ['a', 'b']) for (const [p, q] of ((k.loops || {})[side] || [])) {
      if (!D.endPin(k[side], p) || !D.endPin(k[side], q)) cb.push(`${k.id}: loop ${side} ${p}–${q}`);
    }
  }
  ok(`${D.CABLES.length} cables, every wire and loop landing on a pin that exists`, D.CABLES.length >= 10 && !cb.length, cb.join(' | '));

  // Where a cable listing gives a wire's colour and the far end's own table
  // gives one too, they are the same colour — two sources, one wire.
  const clash = [];
  for (const k of D.CABLES) for (const w of k.wires) {
    if (!w[3]) continue;
    for (const [end, ref] of [[k.a, w[0]], [k.b, w[1]]]) {
      const x = D.endPin(end, ref);
      if (x && x.p.wire && !x.p.wire.toLowerCase().startsWith(w[3].toLowerCase())) clash.push(`${k.id} ${ref}: ${w[3]} against ${x.p.wire}`);
    }
  }
  ok('a cable\'s wire colours agree with the colours in the tables it joins', !clash.length, clash.join(' | '));
}

console.log('\nRS-232\n');
{
  const dte = D.byId('rs232-de9-dte'), dce = D.byId('rs232-de9-dce');
  ok('a DE-9 computer end: TXD out on 3, RXD in on 2, ground on 5', dte.pins[2].sig === 'TXD' && dte.pins[2].dir === 'out' && dte.pins[1].sig === 'RXD'
    && dte.pins[1].dir === 'in' && dte.pins[4].kind === 'ground');
  const turned = dte.pins.every((p, i) => p.sig === dce.pins[i].sig && (p.dir === '' ? dce.pins[i].dir === '' : dce.pins[i].dir === (p.dir === 'out' ? 'in' : 'out')));
  ok('the modem end has the same names with every direction turned round', turned);
  const ad = D.cableById('de9-db25'), db25 = D.byId('rs232-db25-dte');
  const same = ad.wires.every(([a, b]) => dte.pins.find(p => p.n === String(a)).sig === db25.pins.find(p => p.n === String(b)).sig);
  ok('the 9-to-25 adapter keeps every signal\'s name (2→3, 3→2, 5→7, 4→20)', same && ad.wires.length === 9);
  const nm = D.cableById('null-3');
  ok('a three-wire null modem crosses 2 and 3 and runs ground straight', J(nm.wires.map(w => [w[0], w[1]])) === J([[2, 3], [3, 2], [5, 5]]));
  const cr = D.cableById('cr300-beam');
  ok('CR300 to the Beam: two female DCE ports and a male-to-male null modem', D.byId('cr300-rs232').gender === 'F' && D.byId('beam-9602n').gender === 'F'
    && cr.a.gender === 'M' && cr.b.gender === 'M' && cr.wires.some(w => w[0] === 2 && w[1] === 3));
}

console.log('\nThe ERT-A2\'s internal DB9: found in the field\n');
{
  const db9 = D.byId('erta2-db9'), pin = n => db9.pins.find(p => p.n === String(n));
  ok('a field finding is a level of its own, between the maker\'s document and general practice',
    J(Object.keys(D.SURE).slice(0, 4)) === J(['standard', 'maker', 'field', 'general']));
  ok('the DB9 sends on 2 and listens on 3, and DTR (4), RTS (7) and RX (3) are marked found in the field',
    pin(2).dir === 'out' && pin(3).dir === 'in' && [3, 4, 7].every(n => pin(n).found) && ![1, 2, 5, 6, 8, 9].some(n => pin(n).found)
      && /2\.5 V/.test(db9.found[0]) && /three-wire/.test(db9.found[0]));
  const k = D.cableById('erta2-db9-cr300');
  const joined = new Set(k.loops.a.flat().map(String));
  ok('its cable to a CR300: data 2 → 3, ground, and 3, 4 and 7 joined at the ERT-A2\'s end and held high',
    k.sure === 'field' && k.wires.some(w => w[0] === 2 && w[1] === 3) && k.wires.some(w => w[0] === 5 && w[1] === 5)
      && ['3', '4', '7'].every(n => joined.has(n)) && k.wires.some(w => w[0] === 4) && !k.wires.some(w => w[0] === 3), J(k.wires));
  const rows = D.csv(['erta2-db9']).trim().split('\n');
  ok('the CSV says which pins are a field finding', /,Field finding$/.test(rows[4]) && /Maker's document$/.test(rows[2]), J([rows[2], rows[4]]));
}

console.log('\nWhere a pin sits\n');
{
  const dte = D.byId('rs232-de9-dte');
  const at = (g, back) => Object.fromEntries(D.layout(dte, g, back).pts.map(p => [p.n, p]));
  const mf = at('M', false), ff = at('F', false), mb = at('M', true), fb = at('F', true);
  ok('male from the front: pin 1 top left, 5 top right, 6 bottom left', mf[1].x < 0 && mf[1].y < 0 && mf[5].x > 0 && mf[5].y < 0 && mf[6].x < 0 && mf[6].y > 0, J([mf[1], mf[5], mf[6]]));
  ok('female from the front: pin 1 top right', ff[1].x > 0 && ff[1].y < 0 && ff[5].x < 0, J(ff[1]));
  ok('either from the back is the mirror of its front', mb[1].x === -mf[1].x && fb[1].x === -ff[1].x && fb[1].x === mf[1].x);
  ok('the rule: mirrored when exactly one of socket and back', !D.mirrored('M', false) && D.mirrored('F', false) && D.mirrored('M', true) && !D.mirrored('F', true));
  const db = D.layout(D.byId('rs232-db25-dte'), 'M', false).pts;
  ok('a DB-25 has 13 on top and 12 below', db.filter(p => p.y < 0).length === 13 && db.filter(p => p.y > 0).length === 12);
  const st = D.layout(D.byId('al200x-sensor'), '', true).pts;
  ok('a terminal strip reads the same from either side', J(st.map(p => p.n)) === J(D.byId('al200x-sensor').pins.map(p => p.n)) && st[0].x === 0);
}

console.log('\n4–20 mA\n');
{
  ok('0–10 m: 4 mA is 0, 12 mA is 5, 20 mA is 10', D.ma2val(4, 0, 10) === 0 && D.ma2val(12, 0, 10) === 5 && D.ma2val(20, 0, 10) === 10);
  ok('2.5 m of 0–10 is 8 mA; a 1–8 m scale reads 20 mA at 8 m, not 7 (the WL3100 manual\'s slip)', D.val2ma(2.5, 0, 10) === 8 && D.val2ma(8, 1, 8) === 20 && D.val2ma(7, 1, 8) < 20);
  ok('20 mA across 250 Ω is 5 V, 4 mA 1 V; across 100 Ω, 2 V and 0.4 V', D.volts(20, 250) === 5 && D.volts(4, 250) === 1 && near(D.volts(20, 100), 2, 1e-12) && near(D.volts(4, 100), 0.4, 1e-12));
  const k = ma => D.band(ma).k;
  ok('NE 43 at its edges: 0 and 3.6 a fault, 3.7 below range, 4–20 in, 20.7 above, 21 a fault',
    k(0) === 'bad' && k(3.6) === 'bad' && k(3.7) === 'warn' && k(4) === 'ok' && k(20) === 'ok' && k(20.7) === 'warn' && k(21) === 'bad', J([0, 3.6, 3.7, 4, 20, 20.7, 21].map(k)));
  const cr = D.budget(12, 140, 9, 24);
  ok('the WL3100 into a CR300 on 12 V: 9.2 V at 20 mA, 8.64 V at its 24 mA fault — fine until a fault', near(cr.at20, 9.2, 1e-9) && near(cr.atFault, 8.64, 1e-9) && cr.ok && !cr.fault, J(cr));
  const r250 = D.budget(12, 255, 9, 24);
  ok('across 250 Ω (and 5 Ω of cable) on 12 V: 6.9 V at 20 mA, short of 9; at most 150 Ω in all', !r250.ok && near(r250.at20, 6.9, 1e-9) && near(r250.maxOhms, 150, 1e-9), J(r250));
  const r24 = D.budget(24, 255, 9, 24);
  ok('the same on 24 V: room at 20 mA and at the fault', r24.ok && r24.fault && near(r24.maxFault, 625, 1e-9), J(r24));
}

console.log('\nThe CSV\n');
{
  const one = D.csv(['maxon-sd125']).trim().split('\n');
  const all = D.csv().trim().split('\n');
  const pins = D.CONNECTORS.reduce((n, c) => n + c.pins.length, 0);
  ok('a header and a row a pin — for one connector and for the library', one[0] === D.CSV_HEAD && one.length === 10 && all.length === pins + 1, J([one.length, all.length, pins]));
  ok('a cell with a comma in it is quoted', /,"[^"]*,[^"]*",/.test(one[1]), one[1]);
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
  await page.evaluate(() => { try { localStorage.removeItem('mn-pinouts'); } catch (_) {} switchTab('pinouts'); });
  await until(page, () => !!document.getElementById('po-page'));
  return { context, page };
}

try {
  let { context, page } = await openTab();
  const shape = await page.evaluate(() => ({
    group: TABS.find(g => g.tabs.some(t => t.id === 'pinouts')).group,
    secs: ['po-lib', 'po-view', 'po-cables', 'po-loop', 'po-rf', 'po-read'].filter(id => document.getElementById(id)).length,
    cards: document.querySelectorAll('.po-card').length, n: PinoutData.CONNECTORS.length,
    pins: document.querySelectorAll('#po-face .po-pin[role="button"]').length,
    rows: document.querySelectorAll('#po-view tbody .po-row').length,
    named: [...document.querySelectorAll('#po-page svg[role="img"], #po-page svg[role="group"]')].every(s => !!s.getAttribute('aria-label') && !!(s.querySelector('title') || {}).textContent),
    pressed: document.querySelector('.po-card[aria-pressed="true"] .po-card-name').textContent,
  }));
  ok('six sections in the Knowledge base, a card for every connector, the DE-9 computer end open with nine pins and nine rows',
    shape.group === 'Knowledge base' && shape.secs === 6 && shape.cards === shape.n && shape.pins === 9 && shape.rows === 9 && /DE-9 male/.test(shape.pressed), J(shape));
  ok('every drawing named', shape.named);

  // A pin on the drawing lights its row; a row's button lights the pin.
  await page.click('#po-face .po-pin[data-pin="3"]');
  let sel = await page.evaluate(() => ({ row: document.querySelector('#po-view .po-row.is-sel')?.dataset.row,
    pin: document.querySelector('#po-face .po-pin.is-sel')?.dataset.pin, say: document.getElementById('po-say').textContent }));
  ok('pin 3 picked on the drawing: its row lit and TXD said', sel.row === '3' && sel.pin === '3' && /Pin 3 — TXD/.test(sel.say), J(sel));
  await page.click('#po-view .po-row[data-row="2"] .po-pin-btn');
  sel = await page.evaluate(() => ({ pin: document.querySelector('#po-face .po-pin.is-sel')?.dataset.pin,
    pressed: document.querySelector('#po-view .po-row[data-row="2"] .po-pin-btn').getAttribute('aria-pressed') }));
  ok('…and pin 2 picked from the table lights the pin on the drawing', sel.pin === '2' && sel.pressed === 'true', J(sel));
  await page.focus('#po-face .po-pin[data-pin="2"]');
  await page.keyboard.press('ArrowRight');
  sel = await page.evaluate(() => ({ pin: Pinouts.state().pin, focus: document.activeElement?.dataset?.pin,
    tabs: [...document.querySelectorAll('#po-face .po-pin')].filter(g => g.getAttribute('tabindex') === '0').length }));
  ok('the arrow keys walk the pins, focus going with them, one pin in the tab order', sel.pin === '3' && sel.focus === '3' && sel.tabs === 1, J(sel));

  // The plug that mates, and the wire side.
  const where = () => page.evaluate(() => {
    const c = n => +document.querySelector(`#po-face .po-pin[data-pin="${n}"] circle:not(.po-halo)`).getAttribute('cx');
    return { one: c(1), five: c(5), socks: document.querySelectorAll('#po-face .po-sock').length, dots: document.querySelectorAll('#po-face .po-dot').length };
  });
  const front = await where();
  await page.check('input[name="po-mate"][value="plug"]');
  const plug = await where();
  await page.check('input[name="po-back"][value="back"]');
  const plugBack = await where();
  ok('male from the front: pins, with 1 on the left', front.dots === 9 && front.socks === 0 && front.one < front.five, J(front));
  ok('the plug that mates: sockets, with 1 on the right', plug.socks === 9 && plug.dots === 0 && plug.one > plug.five, J(plug));
  ok('…and from its wire side, 1 back on the left', plugBack.socks === 9 && plugBack.one < plugBack.five, J(plugBack));

  // Finding, and the kinds.
  await page.fill('#po-q', 'PTT');
  let found = await page.evaluate(() => [...document.querySelectorAll('.po-card-name')].map(e => e.textContent));
  ok('"PTT" finds the radios and the radio plugs', found.some(t => /Maxon/.test(t)) && found.some(t => /AL200X · radio/.test(t)) && !found.some(t => /DE-9 male/.test(t)), J(found));
  await page.fill('#po-q', 'zzqx');
  ok('…and nonsense finds nothing, and says so', await page.evaluate(() => !!document.querySelector('#po-list .po-none') && !document.querySelector('.po-card')));
  await page.fill('#po-q', '');
  await page.evaluate(() => Pinouts.cat('sensor'));
  found = await page.evaluate(() => ({ cards: document.querySelectorAll('.po-card').length, heads: [...document.querySelectorAll('.po-cat-h')].map(h => h.textContent) }));
  ok('Sensors alone: one heading, its cards', J(found.heads) === J(['Sensors']) && found.cards === await page.evaluate(() => PinoutData.CONNECTORS.filter(c => c.cat === 'sensor').length), J(found));
  await page.evaluate(() => Pinouts.cat('all'));

  // A radio, picked from its card.
  await page.evaluate(() => Pinouts.pick('maxon-sd125', true));
  const mx = await page.evaluate(() => ({ h: document.getElementById('po-view-h').textContent, rows: document.querySelectorAll('#po-view tbody .po-row').length,
    wire: document.querySelector('#po-view .po-row[data-row="1"]').textContent }));
  ok('the Maxon SD-125: nine pins, pin 1 the audio in on the green wire', /Maxon SD-125/.test(mx.h) && mx.rows === 9 && /Audio in/.test(mx.wire) && /Green/.test(mx.wire), J(mx));

  // The field finding, where a tech will see it.
  await page.evaluate(() => Pinouts.pick('erta2-db9', true));
  const fd = await page.evaluate(() => ({ found: document.querySelector('#po-view .po-found')?.textContent || '',
    tags: [...document.querySelectorAll('#po-view .po-row')].filter(r => r.querySelector('.po-tag-field')).map(r => r.dataset.row) }));
  ok('the ERT-A2\'s internal DB9 says what was found in the field, and tags pins 3, 4 and 7',
    /Found in the field/.test(fd.found) && /DTR \(pin 4\), RTS \(pin 7\) and RX/.test(fd.found) && J(fd.tags) === J(['3', '4', '7']), J(fd));
  await page.evaluate(() => Pinouts.cable('erta2-db9-cr300'));
  ok('…and its cable to a CR300 carries the finding too', await page.evaluate(() => /Found in the field/.test(document.querySelector('#po-cable .po-found')?.textContent || '')));
  await page.evaluate(() => Pinouts.pick('maxon-sd125', true));

  // A cable, wire by wire.
  await page.evaluate(() => Pinouts.cable('cr300-beam'));
  const cab = await page.evaluate(() => ({ wires: document.querySelectorAll('#po-cable .po-wire').length, boxes: document.querySelectorAll('#po-cable tbody input[type="checkbox"]').length }));
  ok('CR300 to the Beam: seven wires and a loop at each end, drawn and listed', cab.wires === 9 && cab.boxes === 9, J(cab));
  for (const b of await page.$$('#po-cable tbody input[type="checkbox"]')) await b.check();
  const done = await page.evaluate(() => ({ say: document.getElementById('po-buzz-count').textContent, ok: document.querySelectorAll('#po-cable .po-wire.is-ok').length }));
  ok('every box ticked: every wire drawn as checked, and the count says what to do next', done.ok === 9 && /^9 of 9 checked — every wire/.test(done.say), J(done));
  await page.hover('#po-cable tbody tr[data-wire="1"]');
  ok('pointing at a row lights its wire', await page.evaluate(() => document.querySelector('#po-cable .po-wire.is-hl')?.dataset.wire === '1'));
  await page.evaluate(() => Pinouts.cable('hs40-cr300'));
  const hk = await page.evaluate(() => [...document.querySelectorAll('#po-cable tbody tr')].map(r => r.children[2].textContent));
  ok('the HS40 into a CR300: −S lands on SE1, on the lower row', hk.some(t => /1H · SE1/.test(t)) && hk.some(t => /BAT\+/.test(t)), J(hk));

  // The calculator.
  await page.evaluate(() => Pinouts.preset('cr300'));
  await page.fill('#po-l-ma', '12');
  let lp = await page.evaluate(() => ({ val: document.getElementById('po-l-val').value, v: document.getElementById('po-l-v').value,
    out: document.getElementById('po-loop-out').textContent, focus: document.activeElement?.id }));
  ok('12 mA on 0–10 m across 100 Ω: 5 m and 1.2 V, the box typed in keeping focus', lp.val === '5.000' && lp.v === '1.200' && lp.focus === 'po-l-ma', J(lp));
  ok('…and the CR300 has the voltage until the 24 mA fault', /until a fault/.test(lp.out) && /8\.64 V/.test(lp.out), lp.out.slice(0, 200));
  await page.fill('#po-l-val', '7.5');
  lp = await page.evaluate(() => ({ ma: document.getElementById('po-l-ma').value, v: document.getElementById('po-l-v').value }));
  ok('7.5 m typed: 16 mA and 1.6 V', lp.ma === '16.000' && lp.v === '1.600', J(lp));
  await page.evaluate(() => Pinouts.preset('r250'));
  lp = await page.evaluate(() => ({ out: document.getElementById('po-loop-out').textContent, pressed: document.getElementById('po-pre-r250').getAttribute('aria-pressed') }));
  ok('250 Ω on 12 V: not enough voltage, and what to do', lp.pressed === 'true' && /Not enough voltage/.test(lp.out) && /6\.90 V/.test(lp.out), lp.out.slice(0, 200));
  await page.fill('#po-l-supply', '24');
  lp = await page.evaluate(() => ({ out: document.getElementById('po-loop-out').textContent, pressed: document.querySelectorAll('#po-loop .po-chip[aria-pressed="true"]').length }));
  ok('a supply typed in: 24 V has the room, and no set-up is claimed any more', /has the voltage/.test(lp.out) && lp.pressed === 0, lp.out.slice(0, 160));

  // The file, and the banner's Export.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => Pinouts.exportCsv('one'))]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok('this connector saves as floodnet-pinout-maxon-sd125.csv, a row a pin', dl.suggestedFilename() === 'floodnet-pinout-maxon-sd125.csv' && csv.trim().split('\n').length === 10, dl.suggestedFilename());
  const offers = await page.evaluate(() => ExportMenu.offers('pinouts').map(o => o.label));
  ok('⤓ Export offers this connector and the whole library', J(offers) === J(['This connector — CSV', 'Every connector — CSV']), J(offers));

  // Opened on a connector from elsewhere.
  await page.evaluate(() => { switchTab('home'); Pinouts.show('beam-9602n'); });
  await until(page, () => state.activeTab === 'pinouts' && /Beam 9602N/.test(document.getElementById('po-view-h')?.textContent || ''));
  ok('Pinouts.show() opens the tab on the Beam modem', true);
  await context.close();

  // A phone, dark.
  ({ context, page } = await openTab({ viewport: { width: 375, height: 812 }, colorScheme: 'dark' }));
  await page.evaluate(() => { Pinouts.pick('cr300-top', true); Pinouts.cable('hs40-al200x'); });
  await page.waitForTimeout(200);
  const phone = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    face: document.getElementById('po-face').getBoundingClientRect().width }));
  ok('375 px in the dark: nothing scrolls sideways, the drawing fits', phone.over <= 0 && phone.face <= 375, J(phone));
  await context.close();

  ok('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes + failures} assertion(s), ${failures} failed.`);
if (failures) process.exit(1);
console.log('PASS — the Pinouts library, its arithmetic, and the tab.');
