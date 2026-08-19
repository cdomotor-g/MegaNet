// Rivers on the Stations map: named, labelled, clickable, and reachable
// without a mouse (#150).
//
// Overpass is external and this harness blocks outbound requests, so no river
// can ever be *fetched* under test — which is exactly why MapRivers.seed()
// exists: it hands geometry to the cache under the key run() is about to
// compute, so everything downstream of the fetch (grouping by name, the three
// passes, the labels, the note, the callout) is exercised on the real page
// through the real code path.
//
// The assertion worth having, per the issue: every named river drawn has a
// control in the DOM that opens its callout — checkable without a network and
// without a mouse, which is the point of putting it in the note line rather
// than on the SVG paths.
//
// Run:  npm run rivers
//       npm run rivers -- -v    also print what passed

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

// The Burdekin as three ways (a long river is many ways — the grouping is
// A1's whole point), a second river so the note lists more than one control,
// and an unnamed way that must get no label and no button. Coordinates sit
// around the view the test sets: [-20, 147] at zoom 8, where a degree is
// ~180 px, so the named runs comfortably clear the shortest-run label skip.
function fixtureWays() {
  const run = (lat, lon0, lon1, n) => Array.from({ length: n }, (_, i) =>
    [lat, lon0 + (lon1 - lon0) * (i / (n - 1))]);
  return [
    { name: 'Burdekin River', coords: run(-20.0, 146.5, 147.0, 11) },
    { name: 'Burdekin River', coords: run(-20.0, 147.0, 147.5, 11) },
    { name: 'Burdekin River', coords: run(-20.0, 147.5, 147.9, 9) },
    { name: 'Bogie River',    coords: run(-20.3, 146.6, 147.4, 17) },
    { name: 'Unnamed watercourse', coords: run(-19.7, 146.9, 146.95, 3) },
  ];
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  // hasTouch matches what this sandbox's Chromium already reports
  // (L.Browser.touchNative is true here), and it is what makes a real tap —
  // the input the 44 px hit distance exists for — dispatchable at all.
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, hasTouch: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // A view the fixture is built around, a term in the box, the switch on.
  // The debounced run that follows can only fail (the harness blocks the
  // network) — waited out so the seed's draw is the state under test.
  await page.evaluate(() => {
    state.map.setView([-20.0, 147.0], 8, { animate: false });
    state.filters.search = 'burdekin';
    MapRivers.setEnabled(true);
  });
  await page.waitForTimeout(700);

  const seeded = await page.evaluate((ways) => MapRivers.seed(ways), fixtureWays());
  check('seed() takes the fixture through run()’s real cache-hit path', seeded === true);

  // ── A1/A3: grouped, two passes, and no path pretends to take the pointer ──
  // The shared pins-and-links canvas sits above this pane and owns every DOM
  // event, so an interactive path here would be a lie — the interaction is
  // delegated to the map's own events (the file's header records why).
  const passes = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.leaflet-mnRivers-pane path')];
    return {
      total: paths.length,
      interactive: paths.filter((p) => p.classList.contains('leaflet-interactive')).length,
    };
  });
  check('five ways draw as two passes — casing and core', passes.total === 10,
    `${passes.total} paths`);
  check('no river path claims the pointer — interaction is map-delegated', passes.interactive === 0,
    `${passes.interactive} interactive paths`);

  // ── A2: one permanent label per named river, none for the unnamed ─────────
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.mn-river-label-fixed')].map((el) => el.textContent.trim()).sort());
  check('one permanent label per named river in view', labels.length === 2
    && labels[0] === 'Bogie River' && labels[1] === 'Burdekin River', JSON.stringify(labels));

  // ── A4: the note lists each named river as a real control ─────────────────
  const noteBtns = await page.evaluate(() =>
    [...document.querySelectorAll('#map-river-note .mn-river-note-btn')]
      .map((b) => ({ river: b.dataset.river, text: b.textContent.trim(), tag: b.tagName })));
  check('the note carries one real button per named river — the keyboard path',
    noteBtns.length === 2 && noteBtns.every((b) => b.tag === 'BUTTON')
      && noteBtns.map((b) => b.river).sort().join('|') === 'Bogie River|Burdekin River',
    JSON.stringify(noteBtns));
  check('the unnamed watercourse gets no label and no button',
    !labels.includes('Unnamed watercourse') && !noteBtns.some((b) => b.river === 'Unnamed watercourse'));

  const noteText = await page.evaluate(() => document.getElementById('map-river-note').textContent);
  check('the note counts rivers as well as segments', /2\s+named rivers/.test(noteText)
    && /5\s+segments drawn/.test(noteText), noteText.trim().slice(0, 120));

  // Activate a note button with the keyboard alone: open the panel it lives in,
  // focus the button, then Enter.
  //
  // The extra step is #164: the note is inside the map-display panel, and that
  // panel is an icon on the map rather than a block in the sidebar now. So the
  // keyboard path this check exists to prove is one step longer than it was —
  // reach the icon, open it, then the buttons are there — and proving the whole
  // of it is the point. Enter on the icon rather than a class set by script:
  // the disclosure has to actually work from the keyboard, or the note behind
  // it is unreachable however real its buttons are.
  await page.evaluate(() => {
    document.querySelector('.mn-mapctl[data-panel="display"] .mn-mapctl-btn').focus();
  });
  await page.keyboard.press('Enter');
  const opened = await page.evaluate(() => {
    const wrap = document.querySelector('.mn-mapctl[data-panel="display"]');
    const btn  = wrap.querySelector('.mn-mapctl-btn');
    const body = wrap.querySelector('.mn-mapctl-body');
    return {
      expanded: btn.getAttribute('aria-expanded'),
      visible: !!(body.offsetWidth || body.offsetHeight || body.getClientRects().length),
    };
  });
  check('Enter on the map-display icon opens its panel and says so',
    opened.visible && opened.expanded === 'true', JSON.stringify(opened));

  await page.evaluate(() => {
    [...document.querySelectorAll('.mn-river-note-btn')]
      .find((b) => b.dataset.river === 'Burdekin River').focus();
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  let popup = await page.evaluate(() => {
    const el = document.querySelector('.mn-river-popup .leaflet-popup-content');
    return el ? el.textContent : null;
  });
  check('Enter on a note button opens the river’s callout', !!popup
    && popup.includes('Burdekin River') && popup.includes('3 segments'), String(popup));

  // ── A3: a real hover names the river; a real tap opens the callout ────────
  // Real input events, because the whole defect this design answers is that
  // path-level listeners and real events take different routes: every real
  // event lands on the shared canvas and reaches rivers only through the
  // map-level hit test. The click is a TAP: this Chromium reports native
  // touch, so Leaflet 1.9 suppresses the compatibility mouse click — a mouse
  // user on a real desktop (touchNative false) gets the same path via click,
  // and a tap is exactly the input the finger-sized hit distance exists for.
  await page.evaluate(() => state.map.closePopup());
  const target = await page.evaluate(() => {
    const pt = state.map.latLngToContainerPoint([-20.3, 147.0]);
    const rect = state.map.getContainer().getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  });
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(250);
  const hover = await page.evaluate(() => ({
    tips: [...document.querySelectorAll('.leaflet-tooltip.mn-river-label')]
      .filter((el) => !el.classList.contains('mn-river-label-fixed'))
      .map((el) => el.textContent.trim()),
    cursor: state.map.getContainer().style.cursor,
  }));
  check('a real mouse over the line gets the river’s name and a pointer cursor',
    hover.tips.length === 1 && hover.tips[0] === 'Bogie River' && hover.cursor === 'pointer',
    JSON.stringify(hover));

  // Moving well away drops the hover name and gives the cursor back.
  await page.mouse.move(target.x, target.y - 120);
  await page.waitForTimeout(250);
  const hoverGone = await page.evaluate(() => ({
    tips: [...document.querySelectorAll('.leaflet-tooltip.mn-river-label')]
      .filter((el) => !el.classList.contains('mn-river-label-fixed')).length,
    cursor: state.map.getContainer().style.cursor,
  }));
  check('off the line, the hover name goes and the cursor returns',
    hoverGone.tips === 0 && hoverGone.cursor === '', JSON.stringify(hoverGone));

  // The click itself is driven at the map-event level — the exact event
  // Leaflet fires for a real user's click or tap. It has to be: this
  // sandbox's Chromium reports native touch, and under that flag Leaflet
  // 1.9.4 never turns the harness's synthetic mouse clicks OR taps into a
  // map click (probed directly: `fire:click` enters `_fireDOMEvent` and dies
  // before any map-level listener; a real desktop browser takes the plain
  // path). Every map-click behaviour in this suite is driven the same way.
  await page.evaluate(() => {
    window.__riverClick = (latlng, dyPx = 0) => {
      const at = state.map.layerPointToLatLng(
        state.map.latLngToLayerPoint(latlng).add([0, dyPx]));
      state.map.fire('click', {
        latlng: at,
        layerPoint: state.map.latLngToLayerPoint(at),
        containerPoint: state.map.latLngToContainerPoint(at),
        originalEvent: new MouseEvent('click'),
      });
      const el = document.querySelector('.mn-river-popup .leaflet-popup-content');
      return el ? el.textContent : null;
    };
  });
  // 5 px off the line: inside the finger-sized hit distance, outside the
  // 2.5 px stroke — the whole point of not asking anyone to hit the line.
  const hitText = await page.evaluate(() => window.__riverClick([-20.3, 147.0], 5));
  check('a click within the finger-sized hit distance opens the callout',
    !!hitText && hitText.includes('Bogie River') && hitText.includes('1 segment'), String(hitText));

  // The waits between scenarios are Leaflet's popup fade: a closed popup's
  // element leaves the DOM ~200 ms later, and these checks count elements.
  await page.evaluate(() => state.map.closePopup());
  await page.waitForTimeout(350);
  const missText = await page.evaluate(() => window.__riverClick([-20.3, 147.0], 120));
  check('a click past the hit distance opens nothing', missText === null, String(missText));

  const drawText = await page.evaluate(() => {
    state.draw.tool = 'line';   // an armed draw tool owns the click
    const out = window.__riverClick([-20.3, 147.0], 0);
    state.draw.tool = null;
    return out;
  });
  check('an armed draw tool owns the click — the river yields', drawText === null, String(drawText));

  // ── A2: a pan is not a redraw ─────────────────────────────────────────────
  // A pan that stays inside the rounded bbox refires moveend with the same
  // cache key; the paths must survive it untouched, with only the labels
  // re-anchored. Firing moveend directly is that pan, minus the flakiness of
  // aiming a real one at a 0.25°-rounded cache-key boundary.
  const survived = await page.evaluate(() => {
    window.__riverPath = document.querySelector('.leaflet-mnRivers-pane path');
    state.map.fire('moveend');
    return new Promise((resolve) => setTimeout(() => resolve({
      attached: document.contains(window.__riverPath),
      labels: document.querySelectorAll('.mn-river-label-fixed').length,
    }), 700));
  });
  check('a pan inside the cached bbox re-anchors labels without redrawing the layer',
    survived.attached === true && survived.labels === 2, JSON.stringify(survived));

  // ── A5: the switch off means it never happened ────────────────────────────
  // The 350 ms wait is Leaflet's own fade: a removed DivOverlay's element
  // leaves the DOM ~200 ms later when the map runs fade animation.
  await page.evaluate(() => MapRivers.setEnabled(false));
  await page.waitForTimeout(350);
  const off = await page.evaluate(() => {
    return {
      paths: document.querySelectorAll('.leaflet-mnRivers-pane path').length,
      labels: document.querySelectorAll('.mn-river-label-fixed').length,
      popups: document.querySelectorAll('.mn-river-popup').length,
      note: document.getElementById('map-river-note').textContent,
    };
  });
  check('the off switch removes lines, labels, callout and buttons together',
    off.paths === 0 && off.labels === 0 && off.popups === 0 && /hidden/i.test(off.note),
    JSON.stringify(off));

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
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — every named river is written on the map, and reachable without a mouse.');
