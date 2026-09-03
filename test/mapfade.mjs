// The click that armed the tool and then drew with it — and four cards that
// finally say what they worked out.
//
// Six changes across five files, and the thing they have in common is that not
// one of them is visible to a page that merely loads. Nothing throws, no handler
// goes unresolved, every tab still renders. What moved is what happens *after* a
// real click lands, and what a tool is allowed to leave behind once it has been
// answered.
//
//   · **The draw tool that also drew.** `L.DomEvent.disableClickPropagation`
//     does not stop a click. It marks the wrapper, and when the map container
//     later sees the event it walks up from `event.target` looking for that
//     mark. `MapDraw.setTool()` replaces the whole panel's innerHTML, so by the
//     time the walk runs the button that was clicked is detached: the walk
//     starts on an orphan, finds nothing, and the map takes the click as its
//     own. Arming ✏️ Line dropped a first point under the flyout, and the tool
//     came up already waiting for point two — so a two-point line came out with
//     three, the first of them wherever the button happened to be. That is the
//     assertion below with a number on it, and the only witness to it is a real
//     pointer: page.evaluate() calling setTool() never dispatches the click the
//     bug is made of (map-controls.js).
//   · **The link budget that stayed armed.** Both ends in and the card was still
//     picking, so the next click anywhere on the map silently threw end B away
//     and started a third path — while the operator was clicking to pan. It
//     disarms itself now, and opens the ground profile that is the other half of
//     the answer (link-budget.js `bothIn`).
//   · **Escape, out of the pick.** There was no way out but the checkbox it was
//     armed from, which is at the other end of the page from the map being
//     looked at.
//   · **The margin in the corner.** The figure the whole card exists to produce
//     was only legible with the card expanded and the table read to its foot.
//   · **Half a decibel, not one.** `LB_DEFAULT_LOSS_DB` — a Radio Mobile
//     template figure was quietly charging a decibel at both ends of every
//     hypothetical path.
//   · **The chart's own edges.** Sky above the terrain and the earth's curvature
//     drawn under it, plus a Path row that is the same height whatever the two
//     names are; and built-up ground that is no longer red, because red on that
//     chart already means obstruction.
//   · **MapFade.** A whole network coloured by fade margin, banded against two
//     thresholds that are remembered and saved with the rows.
//
// What is deliberately *not* asserted: anything about a saved fade margin coming
// back out of the datastore. `applyNetworkPolicy` aborts every off-origin
// request, so `MapFade.classify` finds nothing saved and says so — which is the
// honest state to test the rest against, and stubbing rows in would be testing a
// stub. The sweep itself is left alone for the same reason: what is checked here
// is the rule (the bands, where they are kept, the controls that set them), not
// a few thousand Longley–Rice runs over one flat tile.
//
//   node --run mapfade      (or: npm run mapfade)
//       npm run mapfade -- -v    also print what passed

import zlib from 'node:zlib';
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

// ── a terrarium tile, made here ──────────────────────────────────────────────
// pathcover.mjs's, for pathcover.mjs's reason: the chart's sky, its curvature
// arc and its Path row only exist once a profile does, and the tile server is
// off-origin. elevation = R·256 + G + B/256 − 32768, so 200 m is (128, 200, 0).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function flatTerrariumPng(metres) {
  const v = metres + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v % 256), b = Math.round((v % 1) * 256);
  const W = 256, H = 256;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;                                  // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// `#111111` → [17, 17, 17]. Null for anything that is not a plain hex colour,
// which is itself a failure worth reporting rather than swallowing.
const hex = (v) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
// Registered after the policy, so it is asked first — flat ground for the
// profile, everything else off-origin still blocked.
const tile = flatTerrariumPng(200);
await page.route(/elevation-tiles-prod\/terrarium\//, route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: tile,
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
// The first refresh fits the map to every station, animated; a click issued
// while that zoom is running lands somewhere else entirely.
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// ── the pointer ──────────────────────────────────────────────────────────────
// mapctl.mjs's helpers, because this file is asking mapctl.mjs's question at a
// different control: what a *real* click leaves behind. The panel is measured
// off the box the browser gave it rather than off a class, and every click
// arrives along the panel — the flyout sits a gap away from its icon and the
// pointer has to stay over the control the whole way (.mn-mapctl-body::after).

const look = (panel) => page.evaluate((p) => {
  const wrap = document.querySelector(`.mn-mapctl[data-panel="${p}"]`);
  if (!wrap) return null;
  const btn = wrap.querySelector('.mn-mapctl-btn');
  const body = wrap.querySelector('.mn-mapctl-body');
  const r = btn.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  return {
    icon: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    body: { x: br.left + 20, y: br.top + 20 },
    shown: !!(body.offsetWidth || body.offsetHeight || body.getClientRects().length),
  };
}, panel);

const hover = async (panel) => {
  const p = await look(panel);
  await page.mouse.move(p.icon.x, p.icon.y);
  await page.waitForTimeout(150);
  return look(panel);
};

// One control inside an open panel, clicked for real. `text` picks between
// several matches by their label; `.mn-mapctl-content` scrolls inside itself
// (styles.css caps it at 42vh), so the control is brought into that box first —
// scrolling the container only, which leaves the pointer where it is and the
// flyout open under it.
const clickInside = async (panel, selector, text = null) => {
  const p = await look(panel);
  if (!p || !p.shown) return null;
  await page.mouse.move(p.body.x, p.body.y);
  const at = await page.evaluate(([q, s, t]) => {
    const root = document.querySelector(`.mn-mapctl[data-panel="${q}"] .mn-mapctl-body`);
    const els = [...root.querySelectorAll(s)];
    const el = t ? els.find(e => (e.closest('label') || e).textContent.includes(t)) : els[0];
    if (!el) return null;
    const box = el.closest('.mn-mapctl-content');
    if (box) {
      const cr = box.getBoundingClientRect(), er = el.getBoundingClientRect();
      box.scrollTop += (er.top - cr.top) - box.clientHeight / 2;
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [panel, selector, text]);
  if (!at) return null;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);
  return at;
};

// Where on the map it is safe to click: the visible slice of the container,
// with the icon column top-right, the zoom control top-left, the note strip at
// the top and the attribution at the foot all well clear of the fractions used
// below.
const box = await page.evaluate(() => {
  const el = document.getElementById('leaflet-map');
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
  return { left: r.left, top, width: r.width, height: bottom - top };
});
const at = (fx, fy) => ({ x: box.left + box.width * fx, y: box.top + box.height * fy });
const P1 = at(0.30, 0.50), P2 = at(0.52, 0.72), AWAY = at(0.16, 0.85);
const leave = async () => { await page.mouse.move(AWAY.x, AWAY.y); await page.waitForTimeout(200); };

// The dashed preview MapDraw hangs off a pending first point. It is the shape
// the operator sees before anything is committed, and it is drawn the moment
// the pointer moves with a pending point in hand — so "did that click start a
// line" is answerable without reaching into the module. The Stations map is a
// canvas renderer (preferCanvas), so this is counted off Leaflet's own layer
// registry rather than off the DOM; '5,5' is MapDraw's ghost and nothing else
// on this map.
const ghosts = () => page.evaluate(() => {
  let n = 0;
  state.map.eachLayer((l) => {
    if (l instanceof L.Polyline && !(l instanceof L.Polygon)
        && l.options && l.options.dashArray === '5,5' && l.options.interactive === false) n++;
  });
  return n;
});

const drawState = () => page.evaluate(() => ({
  tool: state.draw.tool,
  shapes: state.draw.shapes.length,
  kinds: state.draw.shapes.map(s => s.kind),
  pts: state.draw.shapes.map(s => (s.pts ? s.pts.length : null)),
  finishHidden: (document.getElementById('draw-finish') || {}).hidden,
}));

const linkState = () => page.evaluate(() => ({
  picking: state.link.picking,
  target: state.link.target,
  a: state.link.a ? { name: state.link.a.name, kind: state.link.a.kind } : null,
  b: state.link.b ? { name: state.link.b.name, kind: state.link.b.kind } : null,
  pathOpen: state.path.open,
}));

// ── 1. Arming a tool must not also draw with it ──────────────────────────────
// The whole point of this block is that every gesture in it is a real pointer
// gesture. `MapDraw.setTool('line')` called from evaluate() cannot fail the way
// the app did, because the bug is not in setTool — it is in the click that
// reaches the map *after* setTool has replaced the button that was clicked.

console.log('\nArming a draw tool from the flyout');

await page.evaluate(() => {
  state.draw.shapes = [];
  state.draw.selectedId = null;
  MapDraw.setTool('');
  MapDraw.render();
  MapDraw.rerenderPanel();
});

await hover('draw');
const hitTool = await clickInside('draw', '.draw-tool', 'Line');
ok('the Line tool was there to click', !!hitTool);
let d = await drawState();
ok('clicking it arms the line tool', d.tool === 'line', d.tool);
ok('…and commits nothing', d.shapes === 0, JSON.stringify(d.kinds));
await leave();
// The discriminating pair. With the click leaking through to the map there is
// already a pending point under the flyout, and a pointer moving across the map
// draws the ghost from it.
ok('no ghost line follows the pointer — no first point was dropped under the flyout',
   (await ghosts()) === 0);
ok('…and Finish line is not on offer, because there is nothing to finish',
   (await drawState()).finishHidden === true);

await page.mouse.click(P1.x, P1.y);
await page.waitForTimeout(150);
await page.mouse.move(P2.x, P2.y);
await page.waitForTimeout(150);
// The same two observables again, now that there *should* be a pending point:
// this is what makes the pair above a measurement rather than a detector that
// never fires.
ok('one click on the map starts exactly one pending point — the ghost appears now',
   (await ghosts()) === 1);
d = await drawState();
ok('…with one point pending, Finish line is still hidden', d.finishHidden === true);
ok('…and still nothing committed', d.shapes === 0);

await page.mouse.click(P2.x, P2.y);
await page.waitForTimeout(150);
d = await drawState();
ok('a second click makes two, and Finish line offers itself', d.finishHidden === false);
ok('…still nothing committed until it is pressed', d.shapes === 0);

// Finished through the panel's own button, which is the second place the same
// missing stopPropagation would have dropped a point: finishLine() repaints the
// panel out from under the click as well.
await hover('draw');
const hitFinish = await clickInside('draw', '#draw-finish');
ok('the Finish line button was there to click', !!hitFinish);
d = await drawState();
ok('exactly one shape is committed, and it is a line',
   d.shapes === 1 && d.kinds[0] === 'line', JSON.stringify(d.kinds));
// The number the bug is made of. Two clicks on the map after arming the tool is
// a two-point line; the flyout's leaked click made it three, with the first
// point sitting wherever the Line button happened to be.
ok('…with exactly two points — three is the flyout’s own click, drawn',
   d.pts[0] === 2, `${d.pts[0]} points`);
await leave();
ok('and pressing Finish did not drop a fresh point on the map either',
   (await ghosts()) === 0);

await page.evaluate(() => {
  MapDraw.setTool('');
  state.draw.shapes = [];
  state.draw.selectedId = null;
  MapDraw.render();
  MapDraw.rerenderPanel();
});

// ── 2. The budget puts the map down once it has both ends ────────────────────

console.log('\nThe link budget, once it has been answered');

// linkbudget.mjs's reset, and its comment: rerender() treats the element's own
// `open` as authoritative, so the <details> is opened before the state is.
const resetCard = async () => {
  await page.evaluate(() => {
    const el = document.querySelector('#link-budget-panel > details.lb-panel');
    if (el && !el.open) el.open = true;
    LinkBudget.setOpen(true);
    LinkBudget.reset();
    LinkBudget.disarm();
    state.path.open = false;
  });
  await page.waitForTimeout(100);
};

await resetCard();
const pair = await page.evaluate(() => {
  const all = state.data.stations.filter(s => s.lat != null && s.lon != null);
  return [all[0].id, all[3].id];
});

await page.evaluate(() => LinkBudget.arm('a'));
await page.waitForTimeout(80);
let st = await linkState();
ok('arming end A puts the card in charge of the map', st.picking === true && st.target === 'a',
   JSON.stringify(st));

await page.evaluate(id => LinkBudget.pick('a', id), pair[0]);
await page.waitForTimeout(120);
st = await linkState();
ok('one end in: the card is still picking, because it is still short an end',
   st.picking === true && !!st.a, JSON.stringify(st));

await page.evaluate(() => LinkBudget.arm('b'));
await page.evaluate(id => LinkBudget.pick('b', id), pair[1]);
await page.waitForTimeout(200);
st = await linkState();
ok('both ends in', !!st.a && !!st.b, JSON.stringify(st));
ok('…and the card disarms itself rather than eating the next click on the map',
   st.picking === false, `picking=${st.picking}`);
ok('…with no end left armed', st.target === null, String(st.target));
ok('…and the ground profile opens on its own, unasked', st.pathOpen === true);

// ── 3. The margin, in the corner the eye lands on ────────────────────────────

const chip = await page.evaluate(() => {
  const el = document.getElementById('lb-margin-chip');
  const r = LinkBudget.current();
  return el ? {
    text: el.textContent.trim(), hidden: el.hidden, cls: el.className,
    title: el.title, margin: r ? r.margin : null,
  } : null;
});
ok('the card carries a margin chip', !!chip);
ok('…shown, now that there is a figure to show', chip && chip.hidden === false);
ok('…reading as a fade margin in decibels', chip && /^[+-]?\d+(\.\d)? dB$/.test(chip.text),
   chip && JSON.stringify(chip.text));
// Not a second opinion: the chip and the table foot both come out of one
// compute(), and this is what holds them to it.
ok('…and it is the figure the table computed, not a second opinion',
   chip && chip.margin != null && Math.abs(parseFloat(chip.text) - chip.margin) < 0.06,
   chip && `${chip.text} vs ${chip.margin}`);

// ── 4. Escape gets out of the pick ───────────────────────────────────────────
// Narrow on purpose: it claims the key only while there is a pick to cancel, and
// yields to a draw tool, which owns both the clicks and the key while armed. So
// the tool is off before this is asked.

console.log('\nEscape');

await page.evaluate(() => { MapDraw.setTool(''); LinkBudget.arm('a'); });
await page.waitForTimeout(100);
st = await linkState();
ok('the card is picking again, with no draw tool armed',
   st.picking === true && (await page.evaluate(() => state.draw.tool === '')));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
st = await linkState();
ok('Escape stops the pick', st.picking === false, `picking=${st.picking}`);
ok('…and disarms the end that was waiting on it', st.target === null, String(st.target));

// ── 5. Half a decibel at an end nobody has measured ──────────────────────────
// The constant, and an endpoint built the way a hypothetical site is: a
// two-point line snapped to nothing, taken by the profile card and handed to the
// budget — pathcover.mjs's route, which is the only one that produces a `point`
// endpoint without reaching into the module.

console.log('\nThe hypothetical end');

const HOP = { latA: -27.50, lonA: 152.40, latB: -27.50, lonB: 152.50 };

await page.evaluate(({ latA, lonA, latB, lonB }) => {
  state.draw.shapes = [];
  state.draw.selectedId = null;
  MapDraw.render();
  // Cover is a second off-origin service and nothing here is about it; off, so
  // the chart settles on terrain alone.
  PathProfile.setCover(false);
  MapDraw.addLine([[latA, lonA], [latB, lonB]], [null, null]);
  PathProfile.setOpen(true);
  LinkBudget.fromProfile();
}, HOP);
await page.waitForFunction(() => !!document.querySelector('#path-profile-panel svg'),
  null, { timeout: LOAD_TIMEOUT });
await page.waitForTimeout(250);

const loss = await page.evaluate(() => ({
  konst: typeof LB_DEFAULT_LOSS_DB === 'undefined' ? null : LB_DEFAULT_LOSS_DB,
  kindA: state.link.a && state.link.a.kind,
  lossA: state.link.a && state.link.a.def ? state.link.a.def.loss_db : null,
  lossB: state.link.b && state.link.b.def ? state.link.b.def.loss_db : null,
}));
ok('the default line loss is half a decibel', loss.konst === 0.5, String(loss.konst));
ok('…and it is what a point endpoint starts from, at both ends',
   loss.kindA === 'point' && loss.lossA === 0.5 && loss.lossB === 0.5, JSON.stringify(loss));

// ── 6. The chart has edges now, and the readout has a fixed height ───────────

console.log('\nThe profile chart');

const chart = await page.evaluate(() => {
  const svg = document.querySelector('#path-profile-panel svg');
  if (!svg) return null;
  const key = document.querySelector('#path-profile-panel .path-key');
  const ends = document.querySelector('#path-profile-panel .path-stats dd.path-ends');
  const pathRow = [...document.querySelectorAll('#path-profile-panel .path-stats > div')]
    .find(x => x.querySelector('dt') && x.querySelector('dt').textContent.trim() === 'Path');
  return {
    sky: svg.querySelectorAll('rect[fill="var(--profile-sky)"]').length,
    earth: svg.querySelectorAll('path[fill="var(--profile-earth)"]').length,
    earthLine: svg.querySelectorAll('polyline[stroke="var(--profile-earth-line)"]').length,
    keyText: key ? key.textContent.replace(/\s+/g, ' ').trim() : '',
    keyChip: !!(key && key.querySelector('i.path-key-earth')),
    endsIsDd: !!(ends && ends.tagName === 'DD'),
    endsSpans: ends ? ends.querySelectorAll(':scope > span').length : null,
    endsChildren: ends ? ends.children.length : null,
    endsTitle: ends ? ends.getAttribute('title') : null,
    rowIsPath: !!(pathRow && pathRow.querySelector('dd') === ends),
  };
});
ok('the chart draws its plot area', !!chart);
ok('…with sky above the terrain rather than the page showing through',
   chart && chart.sky === 1, chart && `${chart.sky} sky rect(s)`);
ok('…and the earth’s curvature filled in under it',
   chart && chart.earth === 1, chart && `${chart.earth} earth path(s)`);
ok('…with the arc itself drawn on top of the fill',
   chart && chart.earthLine === 1, chart && `${chart.earthLine} arc polyline(s)`);
ok('…and a legend chip naming it', chart && chart.keyChip && /Earth curvature/.test(chart.keyText),
   chart && chart.keyText.slice(0, 160));
// The Path row's height must not depend on the two names, which is what one
// span per line buys. Two spans, always — a third would be the old one-line
// form back.
ok('the Path row is a dd.path-ends', chart && chart.endsIsDd && chart.rowIsPath);
ok('…holding exactly two spans, one name per line',
   chart && chart.endsSpans === 2 && chart.endsChildren === 2,
   chart && `${chart.endsSpans} spans / ${chart.endsChildren} children`);
ok('…with both names in full on the title, where a clipped name goes',
   chart && /→/.test(chart.endsTitle || ''), chart && chart.endsTitle);

// ── 7. Built-up ground is not red any more ───────────────────────────────────
// Red on this chart already means obstruction — the Fresnel intrusion overlay,
// the worst-point marker, a blocked link on the map — so a brick-red built-up
// band read as one at a glance. Black on light and white on dark: the highest
// contrast either theme has, and a colour nothing else on the chart is using.

console.log('\nBuilt area on the cover band');

const built = await page.evaluate(() => {
  const read = () => getComputedStyle(document.documentElement)
    .getPropertyValue('--cover-built').trim();
  const was = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'light');
  const light = read();
  document.documentElement.setAttribute('data-theme', 'dark');
  const dark = read();
  if (was) document.documentElement.setAttribute('data-theme', was);
  else document.documentElement.removeAttribute('data-theme');
  return { light, dark };
});
const bl = hex(built.light), bd = hex(built.dark);
ok('--cover-built resolves in both themes', !!bl && !!bd, JSON.stringify(built));
ok('light theme: it is black-ish', bl && Math.max(...bl) <= 0x40, built.light);
ok('dark theme: it is white-ish', bd && Math.min(...bd) >= 0xd0, built.dark);
// The claim is not merely "dark" — it is "not red". A neutral has no channel
// running away from the others; #c4281b, the colour it used to be, has 169
// levels between its red and its blue.
ok('…and neutral in both, so it cannot be read as an obstruction',
   bl && bd && (Math.max(...bl) - Math.min(...bl)) <= 0x14
      && (Math.max(...bd) - Math.min(...bd)) <= 0x14,
   `${built.light} / ${built.dark}`);

// ── 8. MapFade: the bands, where they are kept, and the controls that set them ─

console.log('\nFade-margin colouring');

const bands = await page.evaluate(() => MapFade.bands());
ok('the bands start at the planner’s split, not the card’s',
   bands && bands.good === 15 && bands.ok === 6, JSON.stringify(bands));
ok('…and off is where the layer starts', await page.evaluate(() => MapFade.active() === false));

const moved = await page.evaluate(() => {
  MapFade.setBand('good', 12);
  return {
    bands: MapFade.bands(),
    good: localStorage.getItem('mn-map-fade-good'),
    ok: localStorage.getItem('mn-map-fade-ok'),
  };
});
ok('moving the green threshold moves it', moved.bands.good === 12 && moved.bands.ok === 6,
   JSON.stringify(moved.bands));
ok('…and writes both figures down for the next visit',
   moved.good === '12' && moved.ok === '6', JSON.stringify(moved));

const fadeTokens = await page.evaluate(() => {
  const names = ['--map-fade-good', '--map-fade-ok', '--map-fade-bad'];
  const was = document.documentElement.getAttribute('data-theme');
  const read = () => names.map(n =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim());
  document.documentElement.setAttribute('data-theme', 'light');
  const light = read();
  document.documentElement.setAttribute('data-theme', 'dark');
  const dark = read();
  if (was) document.documentElement.setAttribute('data-theme', was);
  else document.documentElement.removeAttribute('data-theme');
  return { light, dark };
});
ok('the three band colours resolve in the light theme',
   fadeTokens.light.every(v => !!hex(v)), fadeTokens.light.join(' '));
ok('…and in the dark one', fadeTokens.dark.every(v => !!hex(v)), fadeTokens.dark.join(' '));
ok('…lifted for the dark theme rather than repeated from the light one',
   fadeTokens.dark.join() !== fadeTokens.light.join());

// The switch, off the Map display panel, clicked with a real pointer. The links
// themselves are taken off the map first — turning the layer on runs a sweep
// over every link the network has, and a few thousand Longley–Rice runs against
// one flat tile is not what this block is asking about. What it is asking about
// is the markup the switch is supposed to produce.
//
// The map is put back under the pointer first: `LinkBudget.fromProfile()` above
// scrolled the budget card into view, which is the app behaving correctly and
// leaves the map's icon column somewhere else on the page.
await page.evaluate(() => {
  state.mapShowLinks = false;
  state.mapShowBackbone = false;
  rerenderMapDisplayControls();
  refreshMapLayers({ skipFit: true });
  document.getElementById('leaflet-map').scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(300);

ok('the Map display flyout opens on hover', (await hover('display')).shown);
const before = await page.evaluate(() => {
  const l = [...document.querySelectorAll('.mn-mapctl[data-panel="display"] label')]
    .find(x => /Colour links by fade margin/.test(x.textContent));
  return l ? { checked: l.querySelector('input').checked } : null;
});
ok('the Map display panel offers “Colour links by fade margin”', !!before);
ok('…unticked, because the layer is off', before && before.checked === false);

const hitFade = await clickInside('display', 'input[type="checkbox"]', 'Colour links by fade margin');
ok('the checkbox was there to click', !!hitFade);
await page.waitForTimeout(300);
ok('ticking it turns the layer on', await page.evaluate(() => MapFade.active() === true));
ok('…and remembers it, unlike the line-of-sight switch beside it',
   await page.evaluate(() => localStorage.getItem('mn-map-fade') === 'on'));

const controls = await page.evaluate(() => ({
  save: !!document.getElementById('map-fade-save'),
  good: !!document.getElementById('map-fade-good'),
  okBox: !!document.getElementById('map-fade-ok'),
  goodValue: (document.getElementById('map-fade-good') || {}).value,
  okValue: (document.getElementById('map-fade-ok') || {}).value,
  legend: (document.getElementById('map-legend') || {}).textContent || '',
}));
ok('…and the two thresholds and the Save button come with it',
   controls.save && controls.good && controls.okBox, JSON.stringify(controls));
ok('…the boxes reading the bands in force',
   controls.goodValue === '12' && controls.okValue === '6',
   `${controls.goodValue} / ${controls.okValue}`);
ok('…and the legend gains a line per band',
   /12 dB or better/.test(controls.legend) && /6–12 dB/.test(controls.legend)
     && /Under 6 dB/.test(controls.legend),
   controls.legend.replace(/\s+/g, ' ').slice(0, 200));

await leave();

// ── Nothing saved yet, which is every network the first time ────────────────
// The switch reads the datastore before it computes anything, so that a
// network whose margins are already stored does not start a terrain sweep it
// is about to throw away. The answer then redraws the map, the redraw
// classifies every line, and classify() asks the datastore — so the read has
// to be asked once and once only. It guarded 'loading', 'ready' and 'failed'
// and not 'absent', so an empty table looped: every pass cleared the queue the
// pass before it had filled, and not one profile was ever fetched. It is the
// state every network is in until somebody presses Save, and the run above
// cannot see it, because there the datastore is blocked and the read fails.
//
// A page of its own, because the module asks once per page and has already
// asked on the one above.

const empty = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page2 = await empty.newPage();
let asked = 0;
await applyNetworkPolicy(page2, server.origin);
await page2.route(/elevation-tiles-prod\/terrarium\//, route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: tile,
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
await page2.route(/\/link_fade_margin/, route => {
  asked++;
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
});
// Armed before the first paint, which is where the loop started.
await page2.addInitScript(() => {
  try { localStorage.setItem('mn-map-fade', 'on'); } catch (_) {}
});
page2.on('pageerror', e => errors.push(String(e)));
await page2.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page2.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
await page2.evaluate(() => switchTab('stations'));
await page2.waitForFunction(() => !!state.map && state.mapLines.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page2.waitForTimeout(4000);

const cold = await page2.evaluate(() => ({
  on: state.mapFade,
  painted: state.mapLines.filter(l => l.mnFadeBand).length,
  note: (document.getElementById('map-fade-note') || {}).textContent.replace(/\s+/g, ' '),
}));
ok('the switch comes back on, because it is remembered', cold.on === true);
ok('an empty table is read once, not once per redraw for ever',
   asked > 0 && asked <= 3, `asked ${asked} times`);
ok('…and the sweep actually runs against it', cold.painted > 0,
   `${cold.painted} coloured · ${cold.note.slice(0, 110)}`);
ok('…with the note saying there is nothing stored yet',
   /nothing saved yet/.test(cold.note), cold.note.slice(0, 140));
await empty.close();

// ── A table bigger than PostgREST will hand over in one go ──────────────────
// The read asks for the lot and PostgREST gives it a thousand rows: no error,
// no short-read header, just a thousand. A network of ~3,200 links therefore
// came back one-third painted and two-thirds looking as though nobody had ever
// computed them — and the note said so in as many words, about links whose
// figures were sitting in the table all along. The read pages now, ordered by
// the primary key rather than by computed_at, because offset paging over a
// column whose values are all within a second of each other repeats rows and
// drops rows, and a dropped row is indistinguishable from an uncomputed one.
//
// What is asserted is the paging contract, not the painting: the rows served
// here are synthetic and their signatures match nothing, which is exactly what
// the module should do with a row whose inputs have moved.

const paged  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page3  = await paged.newPage();
const offsets = [];
await applyNetworkPolicy(page3, server.origin);
await page3.route(/elevation-tiles-prod\/terrarium\//, route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: tile,
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
await page3.route(/\/link_fade_margin/, route => {
  const url = route.request().url();
  const off = Number((/[?&]offset=(\d+)/.exec(url) || [])[1] ?? -1);
  const lim = Number((/[?&]limit=(\d+)/.exec(url) || [])[1] ?? -1);
  offsets.push({ off, lim });
  // A full page first, then a short one. Nothing beyond that should be asked
  // for: a short page is the end of the table.
  const rows = off === 0
    ? Array.from({ length: lim }, (_, i) => ({
        station_a_id: `a${i}`, station_b_id: `b${i}`, margin_db: 20,
        margin_ab_db: 20, margin_ba_db: 20, verdict: 'clear',
        signature: 'stale/0', good_db: 15, ok_db: 6,
        computed_at: '2026-01-01T00:00:00Z' }))
    : [];
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
});
await page3.addInitScript(() => { try { localStorage.setItem('mn-map-fade', 'on'); } catch (_) {} });
page3.on('pageerror', e => errors.push(String(e)));
await page3.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page3.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
  null, { timeout: LOAD_TIMEOUT });
await page3.evaluate(() => switchTab('stations'));
await page3.waitForFunction(() => !!state.map && state.mapLines.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page3.waitForTimeout(3000);

ok('the read asks in pages rather than for the whole table',
   offsets.length >= 2 && offsets[0].off === 0 && offsets[0].lim === 1000,
   JSON.stringify(offsets.slice(0, 4)));
ok('…and goes back for the next one when a page comes back full',
   offsets.some(o => o.off === 1000), JSON.stringify(offsets.slice(0, 4)));
ok('…and stops at the first short page', !offsets.some(o => o.off >= 2000),
   JSON.stringify(offsets.slice(0, 4)));
await paged.close();

ok('nothing threw for the whole run', errors.length === 0, errors.join('\n         '));

await context.close();
await browser.close();
await server.close();

console.log(failures
  ? `\nFAIL — ${failures} of ${failures + passes} assertions about the armed tool and the cards that answer.`
  : `\nPASS — ${passes} assertions: arming a tool from the flyout does not also draw with it,\n`
    + '       the budget puts the map down once it has both ends, Escape gets out of the pick,\n'
    + '       the margin is in the corner, the chart has a sky and an earth under it, built\n'
    + '       area is no longer red, and the fade bands are set, banded and remembered.');
process.exit(failures ? 1 : 0);
