// The hover names on a map stand one above another (map-tip-stack.js).
//
// Each layer that names what is under the pointer — the road reserve, the
// rivers, a bridge, a survey mark, a radio path — opens a Leaflet tooltip of
// its own a few pixels above the point, and none of them knows about the
// others. On a bridge over a river on a road that was three names in one
// place, the last one opened covering the rest. This holds the stack:
//
//   * one name alone is where its layer put it, to the pixel;
//   * the bug's own case — a road's and a river's name at the pointer and a
//     bridge's on its pin just below — comes out as three boxes that do not
//     meet, the lowest where it would be alone, each keeping its own
//     left-right place, and the others no further up than they need to be;
//   * the stack follows the pointer, and a name that no longer meets the
//     others goes back to its own place;
//   * one going lets the rest settle back down;
//   * a name standing aside while a pin's own name shows takes no room;
//   * a zoom, jumped or animated, ends stacked;
//   * a permanent label (a pin's name) is neither moved nor stepped round;
//   * and a real mouse on a radio path's sticky label stacks with the rest.
//
// The names are opened here the way their layers open them — the same
// classes, direction and offsets — rather than through each layer's stubbed
// data: what is under test is the stacking every one of them goes through,
// and roads.mjs, roadowners.mjs, rivers.mjs, riverlines.mjs and survey.mjs
// already hold each layer to naming the right thing.
//
// Run:  npm run tipstack
//       npm run tipstack -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const J = v => JSON.stringify(v);

// Out past Lake Eyre: no station, so no pin and no pin's name under the stack.
const C = { lat: -28.4, lon: 136.6 };
const GAP = 3;   // map-tip-stack.js's

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  await page.evaluate(() => shutDock({ instant: true }));
  await page.waitForTimeout(400);
  await page.evaluate((c) => state.map.setView([c.lat, c.lon], 13, { animate: false }), C);
  await page.waitForTimeout(300);

  // The page's half: open a name the way its layer does, at a point given in
  // the map's own pixels from the middle, and read every open one back.
  await page.evaluate(() => {
    const map = state.map;
    const tips = window.__tips = {};
    const at = (dx, dy) => {
      const mid = map.latLngToContainerPoint(map.getCenter());
      return map.containerPointToLatLng([mid.x + dx, mid.y + dy]);
    };
    window.__at = at;
    window.__open = (key, cls, offsetY, text, dx, dy, extra = {}) => {
      if (tips[key]) tips[key].remove();
      tips[key] = L.tooltip({ className: cls, direction: 'top', offset: [0, offsetY], interactive: false, ...extra })
        .setContent(text).setLatLng(at(dx, dy)).addTo(map);
      tips[key].mnAt = [dx, dy];
    };
    window.__move = (key, dx, dy) => { tips[key].setLatLng(at(dx, dy)); tips[key].mnAt = [dx, dy]; };
    window.__close = (key) => { if (tips[key]) { tips[key].remove(); delete tips[key]; } };
    // Each open name's box on screen, and where its point is on screen —
    // what a layer alone would have done with it is the point, the offset
    // and the margin Leaflet's stylesheet gives a top tooltip.
    window.__read = () => new Promise(res => requestAnimationFrame(() => {
      const box = map.getContainer().getBoundingClientRect();
      const out = {};
      for (const [k, t] of Object.entries(tips)) {
        const el = t.getElement();
        const r = el.getBoundingClientRect();
        const p = map.latLngToContainerPoint(t.getLatLng());
        const cs = getComputedStyle(el);
        out[k] = {
          left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height,
          shown: cs.display !== 'none' && r.width > 0,
          ax: box.left + p.x,
          natBottom: box.top + p.y + t.options.offset[1] + (parseFloat(cs.marginTop) || 0),
        };
      }
      res(out);
    }));
  });
  const open = (...a) => page.evaluate((a) => window.__open(...a), a);
  const move = (...a) => page.evaluate((a) => window.__move(...a), a);
  const close = (k) => page.evaluate((k) => window.__close(k), k);
  const read = () => page.evaluate(() => window.__read());

  const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const overlaps = (r) => {
    const keys = Object.keys(r).filter(k => r[k].shown);
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) if (meet(r[keys[i]], r[keys[j]])) out.push(`${keys[i]}×${keys[j]}`);
    }
    return out;
  };
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  const atHome = (b) => near(b.bottom, b.natBottom);
  const centred = (b) => near((b.left + b.right) / 2, b.ax);

  const ROAD = 'Albion Street — Brassall · Ipswich City';
  const RIVER = 'Bremer River';
  const BRIDGE = 'Hancock Bridge — not State-controlled: normally the council’s';

  // ── One alone ──────────────────────────────────────────────────────────────
  await open('road', 'mn-road-label', -6, ROAD, 0, 0);
  let r = await read();
  check('one name alone is where its layer put it, to the pixel',
    atHome(r.road) && centred(r.road), J(r.road));

  // ── The bug: road and river at the pointer, the bridge on its pin below ────
  await close('road');
  await open('bridge', 'mn-bridge-label', -8, BRIDGE, -40, 6);
  const bridgeAlone = (await read()).bridge;
  await open('road', 'mn-road-label', -6, ROAD, 0, 0);
  await open('river', 'mn-river-label mn-rl-tip', -8, RIVER, 0, 0);
  r = await read();
  check('a road, a river and a bridge under one pointer: three names, none over another',
    overlaps(r).length === 0, J({ overlaps: overlaps(r), r }));
  check('…the lowest — the bridge, on its pin — where it would be alone',
    near(r.bridge.top, bridgeAlone.top) && near(r.bridge.left, bridgeAlone.left), J({ now: r.bridge, alone: bridgeAlone }));
  check('…each still over its own point left to right — the bridge on its pin, the road and the river on the pointer',
    centred(r.bridge) && centred(r.road) && centred(r.river), J(r));
  check('…stacked bottom to top in the order their points come, road over bridge and river over road',
    r.road.bottom <= r.bridge.top && r.river.bottom <= r.road.top, J(r));
  check('…and no further up than they have to be: a gap of ' + GAP + ' px each',
    near(r.bridge.top - r.road.bottom, GAP) && near(r.road.top - r.river.bottom, GAP), J(r));

  // ── Following the pointer ─────────────────────────────────────────────────
  await move('road', 12, -3);
  await move('river', 12, -3);
  r = await read();
  check('the pointer moves on along the road: still none over another',
    overlaps(r).length === 0 && centred(r.road) && centred(r.river), J({ overlaps: overlaps(r), r }));
  await move('road', 600, 0);
  await move('river', 600, 0);
  r = await read();
  check('off past the bridge’s name, the bridge’s comes back down to its own place',
    atHome(r.bridge) && near(r.bridge.top, bridgeAlone.top), J(r.bridge));
  check('…and the road’s is on its own place too, the river’s stacked over it',
    atHome(r.road) && near(r.road.top - r.river.bottom, GAP) && overlaps(r).length === 0, J(r));

  // ── One going ─────────────────────────────────────────────────────────────
  await move('road', 0, 0);
  await move('river', 0, 0);
  await close('bridge');
  r = await read();
  check('the bridge’s name goes: the road’s settles back onto the pointer',
    atHome(r.road) && overlaps(r).length === 0 && near(r.road.top - r.river.bottom, GAP), J(r));
  await close('road');
  r = await read();
  check('…and the road’s goes: the river’s does too', atHome(r.river), J(r.river));

  // ── Standing aside for a pin's own name ───────────────────────────────────
  await open('road', 'mn-road-label', -6, ROAD, 0, 0);
  await open('bridge', 'mn-bridge-label', -8, BRIDGE, -40, 6);
  await page.evaluate(() => {
    window.__open('pin', 'mn-pin-label', -8, 'Some Creek at Somewhere', 0, 0);
    state.map.getContainer().classList.add('mn-pin-hovering');
  });
  r = await read();
  check('while a pin’s own name shows, the names standing aside for it take no room: it is on its pin',
    r.pin.shown && !r.road.shown && !r.river.shown && !r.bridge.shown && atHome(r.pin), J(r.pin));
  await page.evaluate(() => {
    state.map.getContainer().classList.remove('mn-pin-hovering');
    window.__close('pin');
  });
  r = await read();
  check('…and when it goes, the others come back stacked', overlaps(r).length === 0
    && r.road.shown && r.river.shown && r.bridge.shown, J({ overlaps: overlaps(r), r }));

  // ── Zoom ──────────────────────────────────────────────────────────────────
  await page.evaluate(() => state.map.setZoom(state.map.getZoom() - 2, { animate: false }));
  r = await read();
  check('a zoom out, jumped: still none over another', overlaps(r).length === 0, J({ overlaps: overlaps(r), r }));
  await page.evaluate(() => state.map.setZoom(state.map.getZoom() + 2));
  await page.waitForTimeout(600);
  r = await read();
  check('a zoom back in, animated: still none over another', overlaps(r).length === 0, J({ overlaps: overlaps(r), r }));
  check('…the bridge on its pin again, where it was before the zoom',
    centred(r.bridge) && near(r.bridge.top, bridgeAlone.top, 1.5), J({ now: r.bridge, alone: bridgeAlone }));

  // ── Permanent labels are not stepped round ────────────────────────────────
  for (const k of ['road', 'river', 'bridge']) await close(k);
  await page.evaluate(() => {
    const map = state.map;
    window.__fixed = L.tooltip({ permanent: true, direction: 'center', className: 'mn-pin-label', interactive: false })
      .setContent('A pin’s own name').setLatLng(window.__at(0, -20)).addTo(map);
  });
  const fixedBefore = await page.evaluate(() => window.__fixed.getElement().getBoundingClientRect().toJSON());
  await open('road', 'mn-road-label', -6, ROAD, 0, 0);
  await open('river', 'mn-river-label mn-rl-tip', -8, RIVER, 0, 0);
  r = await read();
  const fixedAfter = await page.evaluate(() => window.__fixed.getElement().getBoundingClientRect().toJSON());
  check('a permanent label under the hover names is neither moved…',
    near(fixedBefore.top, fixedAfter.top) && near(fixedBefore.left, fixedAfter.left), J({ fixedBefore, fixedAfter }));
  check('…nor stepped round: the road’s name is still on the pointer', atHome(r.road), J(r.road));
  await page.evaluate(() => window.__fixed.remove());
  for (const k of ['road', 'river']) await close(k);

  // ── A real mouse ──────────────────────────────────────────────────────────
  // A radio path's label is a sticky tooltip bound to the line (app.js
  // MAP_LINK_TIP): it opens and follows the pointer on Leaflet's own mouse
  // handling, which is the path every other kind of name does not take here.
  await open('road', 'mn-road-label', -6, ROAD, 0, 0);
  const at = await page.evaluate(() => {
    const map = state.map;
    window.__line = L.polyline([window.__at(-300, 0), window.__at(300, 0)], { weight: 14, color: '#06c' })
      .bindTooltip('A radio path — backbone', { sticky: true, direction: 'top', offset: [0, -10], className: 'mn-link-tip' })
      .addTo(map);
    const box = map.getContainer().getBoundingClientRect();
    const p = map.latLngToContainerPoint(window.__at(0, 0));
    return { x: box.left + p.x, y: box.top + p.y };
  });
  // Leaflet's canvas renderer hit-tests one move in 32 ms and drops the rest
  // (Canvas._handleMouseHover), so the last step of a glide can be thrown
  // away: arrive, wait out the window, and move once more.
  const glide = async (x, y) => {
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(80);
    await page.mouse.move(x + 1, y);
    await page.waitForTimeout(250);
  };
  await page.mouse.move(at.x - 80, at.y - 120);
  await page.waitForTimeout(100);
  await glide(at.x, at.y);
  const real = await page.evaluate(() => new Promise(res => requestAnimationFrame(() => {
    const link = document.querySelector('.leaflet-tooltip.mn-link-tip');
    const road = window.__tips.road.getElement();
    res({ link: link && link.getBoundingClientRect().toJSON(), road: road.getBoundingClientRect().toJSON() });
  })));
  check('a real mouse onto a radio path under the road’s name: its sticky label opens…', !!real.link, J(real));
  check('…and stacks with the road’s rather than over it', !!real.link && !meet(real.link, real.road), J(real));
  await glide(at.x + 5, at.y - 120);
  r = await read();
  check('…and the mouse off the line: its label goes and the road’s is back on its point',
    !(await page.evaluate(() => !!document.querySelector('.leaflet-tooltip.mn-link-tip'))) && atHome(r.road), J(r.road));

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — the hover names on a map stand one above another, never one over another.');
