// The link budget card's two ends: how they are chosen, and what the table
// refuses to compute.
//
// The card spent its whole life map-only. An end could be set by clicking the
// ground, or by a two-point line drawn in Draw & measure, and by nothing else —
// so the question people actually arrive with ("what is the margin from 6128 to
// the repeater it reports through") began with hunting for two pins among
// ~3,174 at the zoom the whole network fits in. Each end now has a search box
// pointed at the app's own matcher, and can be armed so that a pin, a point or a
// row in the Stations list lands on *that* end.
//
// Why a check of its own, rather than another block in tabs.mjs or smoke.mjs:
// every failure here renders a page that looks entirely correct and throws
// nothing.
//
//   · A search box that hands back the wrong stations is a clean console.
//   · A box that loses the caret on the third keystroke is a clean console —
//     and unusable.
//   · A repaint that discards a half-typed TX power is a clean console, and the
//     figure it discards is one somebody is about to make a decision on.
//   · A pin click that never reaches the card is a clean console. It was the
//     state of the feature until this file existed: markers are built with
//     `bubblingMouseEvents: false`, so a click dead on a pin never reached
//     `map.on('click')`, and what worked was clicking *near* a pin — inside
//     MapDraw's 15 px snap ring and outside the pin's own hit area — which is
//     not an instruction anybody could follow.
//   · A budget over a zero-length path is a clean console, a fade margin of
//     +155 dB and the word "Good". That is the one thing the file header of
//     link-budget.js says this card must never produce.
//
// The search expectations are derived in the page from the station list and
// stationAlertIds(), the way search.mjs derives its own: the claim under test is
// that the card runs the *shared* matcher, not that a second copy of the rules
// written here agrees with the first.
//
//   node --run linkbudget      (or: npm run linkbudget)
//       npm run linkbudget -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond && !VERBOSE) return;
  if (cond) { console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
// The first refresh fits the map to every station, animated. A setView issued
// while that zoom is running is ignored by Leaflet, so the map is left to settle
// before anything drives it.
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// The card, open, empty, and nothing armed — the state every block below starts
// from, so the order they run in cannot matter.
async function reset() {
  await page.evaluate(() => {
    const d = document.querySelector('#link-budget-panel > details.lb-panel');
    if (d && !d.open) d.open = true;
    LinkBudget.setOpen(true);
    LinkBudget.reset();
    LinkBudget.disarm();
    state.selectedId = null;
    state.editorId = null;
    clearSearch();
  });
  await page.waitForTimeout(80);
}

const linkState = () => page.evaluate(() => ({
  a: state.link.a ? { name: state.link.a.name, sid: state.link.a.sid, kind: state.link.a.kind } : null,
  b: state.link.b ? { name: state.link.b.name, sid: state.link.b.sid, kind: state.link.b.kind } : null,
  target: state.link.target,
  picking: state.link.picking,
  q: { ...state.link.q },
  selectedId: state.selectedId,
}));

const hitNames = which => page.evaluate(w => [...document.querySelectorAll(`#lb-hits-${w} .lb-hit`)]
  .map(b => b.querySelector('.lb-hit-name').textContent.trim()), which);

console.log('\nThe search box on each end');

await reset();

// ── 1. The box runs the app's own matcher ────────────────────────────────────
// Four kinds of term, and the expectation for each derived in the page from the
// same primitives the filter uses. A name, a station number, an ALERT address
// matched from the front, and an address window — everything the Stations
// filter box takes, because it is the same prepareSearch/stationMatchesSearch
// pair behind both.
const PROBES = await page.evaluate(() => {
  const all = state.data.stations;
  const withIds = all.filter(s => stationAlertIds(s).length && s.lat != null && s.lon != null);
  const named  = withIds.find(s => s.name.length > 6);
  const numbered = withIds.find(s => (s.station_number || '').length >= 5 && s !== named);
  const addr = stationAlertIds(withIds.find(s => stationAlertIds(s).length))[0];
  return {
    name:   named.name,
    number: numbered.station_number,
    addr:   String(addr),
    window: `${addr}-${addr + 4}`,
  };
});

for (const [kind, term] of Object.entries(PROBES)) {
  const expected = await page.evaluate(t => {
    const prep = prepareSearch(t);
    return state.data.stations.filter(s => stationMatchesSearch(s, prep)).map(s => s.name);
  }, term);
  await page.fill('#lb-find-a', '');
  await page.type('#lb-find-a', term, { delay: 4 });
  await page.waitForTimeout(60);
  const shown = await hitNames('a');
  // The list is capped, so the claim is prefix-equality against the filter's
  // own answer rather than set equality.
  const agrees = shown.length > 0 && shown.every((n, i) => n === expected[i]);
  ok(`a ${kind} (“${term}”) finds what the Stations filter finds`,
     agrees, `${shown.length} shown of ${expected.length}; first: ${shown[0]}`);
}

// ── 2. Typing never redraws the box it is being typed into ───────────────────
// The one defect that makes a search box unusable rather than wrong. Asserted
// on the element itself, not on the value: a repaint hands back a *different*
// input with the same text in it, which reads identically from the outside.
await page.fill('#lb-find-a', '');
await page.evaluate(() => { document.getElementById('lb-find-a').dataset.mnSame = 'yes'; });
await page.click('#lb-find-a');
await page.type('#lb-find-a', 'Mount', { delay: 12 });
await page.waitForTimeout(80);
ok('the box survives its own keystrokes',
   await page.evaluate(() => document.getElementById('lb-find-a').dataset.mnSame === 'yes'));
ok('the caret is still in it',
   await page.evaluate(() => document.activeElement.id === 'lb-find-a'));
ok('with the whole word in it',
   (await page.inputValue('#lb-find-a')) === 'Mount');

// ── 3. Picking a result sets that end, and only that end ─────────────────────
await reset();
const first = await page.evaluate(() => {
  const s = state.data.stations.filter(x => x.lat != null && x.lon != null)[0];
  return { id: s.id, name: s.name };
});
await page.evaluate(id => LinkBudget.pick('a', id), first.id);
await page.waitForTimeout(80);
let st = await linkState();
ok('a result picked for A lands on A', st.a && st.a.name === first.name, st.a && st.a.name);
ok('…as a station endpoint, filled in from its Radio Mobile system',
   st.a && st.a.kind === 'station' && st.a.sid === first.id);
ok('…and B is untouched', st.b === null);
ok('…and picking does not select the station in the list below', st.selectedId === null);
ok('…and the box empties, because the question has been answered', st.q.a === '');

console.log('\nArming an end, and picking from somewhere else');

// ── 4. The caret arms the end ────────────────────────────────────────────────
await reset();
await page.click('#lb-find-b');
await page.waitForTimeout(80);
st = await linkState();
ok('putting the caret in end B’s box arms end B', st.target === 'b');
ok('…which arms the map with it', st.picking === true);
ok('…and the card says so on screen',
   /armed/i.test(await page.textContent('#lb-find-hint-b')));

// ── 5. A row in the Stations list — in whatever state the filters have it ────
// The filter is narrowed first, precisely because "the list in whatever
// filtered state it may already be in" is the requirement: the row taken is one
// the filter left behind, not one from the unfiltered file.
await page.evaluate(() => {
  state.filters.searches = [newSearchRow('Aber')];
  stationsFilterChanged();
});
await page.waitForTimeout(250);
const rowPick = await page.evaluate(() => {
  const tr = document.querySelector('#stations-table-wrap tr[data-sid]');
  const s = state.data.stations.find(x => x.id === tr.dataset.sid);
  return { id: s.id, name: s.name, rows: document.querySelectorAll('#stations-table-wrap tr[data-sid]').length };
});
ok('the filter narrowed the list first', rowPick.rows > 0 && rowPick.rows < 3174,
   `${rowPick.rows} rows`);
await page.click(`#stations-table-wrap tr[data-sid="${rowPick.id}"]`);
await page.waitForTimeout(150);
st = await linkState();
ok('a row clicked while B is armed lands on B', st.b && st.b.sid === rowPick.id, rowPick.name);
ok('…and does not also select it into the editor below', st.selectedId === null);
ok('…and disarms, so the next row click is an ordinary selection', st.target === null);

// The other half of that claim: with nothing armed, a row is a plain selection
// again and the budget is not touched.
const before = await linkState();
await page.click(`#stations-table-wrap tr[data-sid="${rowPick.id}"]`);
await page.waitForTimeout(150);
st = await linkState();
ok('with nothing armed a row selects, as it always did', st.selectedId === rowPick.id);
ok('…and the budget’s ends are left alone',
   JSON.stringify(st.b) === JSON.stringify(before.b) && st.a === null);

// ── 6. A click dead on a station pin ─────────────────────────────────────────
// The regression this file exists for. `bubblingMouseEvents: false` keeps a pin
// click off `map.on('click')`, so before the marker handler offered it on, the
// only way to set a station end from the map was to click *beside* the pin.
await reset();
const lone = await page.evaluate(() => {
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.02;
  const all = state.data.stations.filter(x => x.lat != null && x.lon != null);
  const s = all.filter(x => !all.some(y => y !== x && near(x, y)))[0];
  const m = state.mapMarkers.find(x => x.mnStationId === s.id);
  state.map.setView(m.getLatLng(), 14, { animate: false });
  return { id: s.id, name: s.name };
});
await page.evaluate(() => document.getElementById('leaflet-map').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(400);
const at = await page.evaluate(id => {
  const m = state.mapMarkers.find(x => x.mnStationId === id);
  const p = state.map.latLngToContainerPoint(m.getLatLng());
  const box = document.getElementById('leaflet-map').getBoundingClientRect();
  return { x: box.left + p.x, y: box.top + p.y };
}, lone.id);
await page.mouse.click(at.x, at.y);
await page.waitForTimeout(250);
st = await linkState();
ok('a click dead on a pin sets an end', st.a && st.a.sid === lone.id, lone.name);
ok('…as the station, not as a bare point', st.a && st.a.kind === 'station');
ok('…and does not also open the callout over it',
   await page.evaluate(() => !document.querySelector('.leaflet-popup')));

console.log('\nClearing');

// ── 7. Clear A, clear B, clear both ──────────────────────────────────────────
await reset();
const pair = await page.evaluate(() => {
  const all = state.data.stations.filter(x => x.lat != null && x.lon != null);
  return [all[0].id, all[3].id];
});
await page.evaluate(([a, b]) => { LinkBudget.pick('a', a); LinkBudget.pick('b', b); }, pair);
await page.type('#lb-find-a', 'left over', { delay: 4 });
await page.waitForTimeout(100);
await page.click('#lb-clear-a');
await page.waitForTimeout(100);
st = await linkState();
ok('Clear A wipes end A', st.a === null);
ok('…and what was typed into its box', st.q.a === '');
ok('…and leaves end B exactly where it was', st.b && st.b.sid === pair[1]);
await page.click('#lb-clear-b');
await page.waitForTimeout(100);
st = await linkState();
ok('Clear B wipes the other end', st.b === null);
ok('…and with nothing left, the buttons say so',
   await page.evaluate(() => document.getElementById('lb-clear-a').disabled
                          && document.getElementById('lb-clear-b').disabled
                          && document.getElementById('lb-clear-both').disabled));
await page.evaluate(([a, b]) => { LinkBudget.pick('a', a); LinkBudget.pick('b', b); }, pair);
await page.waitForTimeout(100);
await page.click('#lb-clear-both');
await page.waitForTimeout(100);
st = await linkState();
ok('Clear both ends wipes the pair', st.a === null && st.b === null);

console.log('\nWhat the table refuses to compute');

// ── 8. The same place at both ends ───────────────────────────────────────────
await reset();
const one = await page.evaluate(() => state.data.stations.find(s => s.lat != null && s.lon != null).id);
await page.evaluate(id => { LinkBudget.pick('a', id); LinkBudget.pick('b', id); }, one);
await page.waitForTimeout(120);
st = await linkState();
ok('the same station is refused at the other end', st.b === null);
ok('…with a reason on screen, rather than silently',
   /already end A/i.test(await page.evaluate(() =>
     (document.getElementById('map-note') || {}).textContent || '')));

// The refusal covers a mis-click; two *points* on the same spot can still be
// contrived, and the table must not print a margin for one either. FSPL over a
// distance of nought is 0 dB — correct, and the most optimistic answer there
// is: the margin came out at +155 dB and read "Good".
const zero = await page.evaluate(() => {
  const s = state.data.stations.find(x => x.lat != null && x.lon != null);
  state.link.a = { kind: 'point', sid: null, name: 'X', lat: s.lat, lon: s.lon,
                   ground: 100, groundSrc: 'test', sysName: null, freq: null,
                   def: { tx_w: 1, loss_db: 1, gain_dbi: 5.15, agl_m: 4, rx_dbm: -117 }, over: {} };
  state.link.b = { ...state.link.a, name: 'Y', over: {} };
  LinkBudget.rerender();
  const r = LinkBudget.current();
  const foot = document.querySelector('.lb-margin');
  return { margin: r.margin, zero: r.zero, text: foot ? foot.textContent.replace(/\s+/g, ' ') : '' };
});
ok('a zero-length path has no fade margin', zero.margin === null && zero.zero === true,
   JSON.stringify(zero.margin));
ok('…and the row says why instead of reading “Good”',
   /No path/.test(zero.text) && /same place/i.test(zero.text) && !/Good/.test(zero.text),
   zero.text.slice(0, 120));

// ── 9. A term nobody supplied is not nought ──────────────────────────────────
// `|| 0` folded an absent antenna gain into 0 dBi: the row printed "—" while
// the subtotal under it was computed as though a figure had been given, so the
// column stopped adding up. Not reachable from the committed stations.json —
// every station is on rm_system 1, which is fully populated — so the endpoint is
// built here with the hole in it, which is the shape the datastore can return.
const holed = await page.evaluate(() => {
  const [x, y] = state.data.stations.filter(s => s.lat != null && s.lon != null).slice(0, 2);
  const end = (s, n) => ({
    kind: 'station', sid: s.id, name: n, lat: s.lat, lon: s.lon,
    ground: 100, groundSrc: 'test', sysName: null, freq: null,
    def: { tx_w: 1, loss_db: 1, gain_dbi: 5.15, agl_m: 4, rx_dbm: -117 }, over: {},
  });
  state.link.a = end(x, 'A end');
  state.link.b = end(y, 'B end');
  const full = LinkBudget.current().margin;
  state.link.a.def.gain_dbi = null;               // the system has no gain recorded
  LinkBudget.rerender();
  const r = LinkBudget.current();
  const foot = document.querySelector('.lb-margin');
  return { full, margin: r.margin, eirp: r.eirp, missing: r.missing,
           text: foot ? foot.textContent.replace(/\s+/g, ' ') : '' };
});
ok('a real pair of ends does produce a margin', typeof holed.full === 'number',
   String(holed.full));
ok('an unrecorded antenna gain blanks the margin rather than reading as 0 dBi',
   holed.margin === null && holed.eirp === null);
ok('…and the note names the term that is missing',
   holed.missing.includes('TX antenna gain') && /TX antenna gain/.test(holed.text),
   holed.text.slice(0, 140));

// ── 10. A repaint must not eat what is being typed ───────────────────────────
// Every field commits on `change`, so everything typed since the last blur is
// uncommitted — and a terrain tile landing repaints the card up to twelve
// seconds after the click that asked for it.
await reset();
await page.evaluate(([a, b]) => { LinkBudget.pick('a', a); LinkBudget.pick('b', b); }, pair);
await page.waitForTimeout(120);
await page.click('#lb-f-a-tx_w', { clickCount: 3 });
await page.type('#lb-f-a-tx_w', '17', { delay: 8 });
await page.evaluate(() => LinkBudget.rerender());     // as a landing tile does
await page.waitForTimeout(80);
ok('a half-typed figure survives a repaint it did not ask for',
   (await page.inputValue('#lb-f-a-tx_w')) === '17');
ok('…and so does the caret', await page.evaluate(() => document.activeElement.id === 'lb-f-a-tx_w'));

// ── 11. The frequency box says where its figure came from ────────────────────
// It is never blank: clearing it falls straight back to the repeater channel or
// the network band, which on screen is indistinguishable from having typed that
// number in.
const freq = await page.evaluate(() => {
  const read = () => ({
    value: document.getElementById('lb-freq').value,
    flag: document.querySelector('.lb-controls .lb-flag').textContent.trim(),
  });
  const fallback = read();
  LinkBudget.setFreq('161.5');
  const edited = read();
  LinkBudget.setFreq('');
  return { fallback, edited, cleared: read() };
});
ok('an untouched frequency is flagged as a default',
   /^default/.test(freq.fallback.flag), freq.fallback.flag);
ok('a typed one is flagged as edited',
   freq.edited.flag === 'edited' && freq.edited.value === '161.5');
ok('and clearing it says default again rather than looking like an override',
   /^default/.test(freq.cleared.flag) && freq.cleared.value === freq.fallback.value,
   `${freq.cleared.value} · ${freq.cleared.flag}`);

// ── 12. A control that vanishes hands focus on ───────────────────────────────
// Both of these repaint the button that was just pressed out of existence. The
// keyboard has to land somewhere deliberate rather than on <body>, and it must
// not land back in the search box — focusing that box re-arms the end that has
// only just been filled.
await reset();
await page.click('#lb-find-a');
await page.type('#lb-find-a', PROBES.name, { delay: 4 });
await page.waitForTimeout(80);
await page.click('#lb-hits-a .lb-hit');
await page.waitForTimeout(120);
ok('picking a result hands focus to that end’s Clear button',
   await page.evaluate(() => document.activeElement.id === 'lb-clear-a'),
   await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
ok('…and does not land back in the box, which would re-arm the end',
   (await linkState()).target === null);
await page.click('#lb-clear-a');
await page.waitForTimeout(120);
ok('clearing an end hands focus to the link that refills it',
   await page.evaluate(() => document.activeElement.id === 'lb-arm-a'),
   await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));

ok('nothing threw for the whole run', errors.length === 0, errors.join('\n         '));

await context.close();
await browser.close();
await server.close();

console.log(failures
  ? `\nFAIL — ${failures} assertion(s) about the link budget card.`
  : '\nPASS — either end is found by name, number or ALERT address, armed and\n'
    + '       filled from the map or the list, cleared on its own, and the table\n'
    + '       refuses the figures it cannot honestly compute.');
process.exit(failures ? 1 : 0);
