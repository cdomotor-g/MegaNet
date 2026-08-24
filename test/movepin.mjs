// The three things #170 added to the Stations tab, driven in a real browser.
//
//   1. The row of pills a station's callout and its editor card both carry —
//      that every one of them is there, that the two document searches carry
//      the reduced name rather than the raw one, and that a station with no
//      coordinates still gets the searches.
//   2. Move pin: arm it, drag the pin, read the coordinates back, cancel — and
//      the same again with Save, which has to reach the form's own boxes.
//   3. That arming takes the map's other interactive modes off, because a draw
//      tool leaves `pointer-events: none` on the marker pane and would make the
//      pin undraggable without either of them saying so.
//
// Why a check of its own rather than a few more lines in `smoke`: smoke opens
// every tab and asserts nothing threw, and every one of the failures above
// renders a page that looks entirely correct. A pill row missing two pills, a
// document search that sends the raw station name, a Save that writes null over
// a coordinate — none of them is an error in the console.
//
// The datastore is off-origin and refused under this harness (lib/network.mjs),
// so nothing here signs in and nothing is saved to a database. What is checked
// is the half that runs in the browser: the mode, the marker, the readout, and
// the numbers landing in #ef-lat / #ef-lon. The database half is
// tools/check_inspections.sql's business.
//
// Run:  npm run movepin        (from test/)
//       npm run movepin -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);

    const errors = [];
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('dialog', async d => { errors.push(`dialog: ${d.message()}`); await d.dismiss().catch(() => {}); });

    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(
      () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });

    // ── 1. The name reduction ─────────────────────────────────────────────
    // Read out of the page rather than re-implemented here, so this asserts the
    // shipped function and not a copy of it that agrees with itself.
    log('\nThe document search is the name a person would have typed\n');

    const terms = await page.evaluate(() => ({
      sandy:   docSearchTerms('Upper Sandy Creek AL'),
      mt:      docSearchTerms('Mt Hallen (Sandy'),
      mount:   docSearchTerms('Mount Isa TM'),
      ck:      docSearchTerms('Sandy Ck Tm'),
      saint:   docSearchTerms('St Marys AL'),
      street:  docSearchTerms('Bathurst Stanley Street (Macquarie River)'),
      dupe:    docSearchTerms('Cudgewa Creek @ Cudgewa North'),
      digits:  docSearchTerms('Swansea No. 8 WWPS'),
      empty:   docSearchTerms(''),
      // Every name in the file, so "never nothing" is a fact about the data
      // rather than about the eight examples above it.
      blanks:  state.data.stations.filter(s => s.name && !docSearchTerms(s.name)).length,
      total:   state.data.stations.length,
    }));

    check('the worked example reduces the way the request did', terms.sandy === 'upper sandy',
      `got ${JSON.stringify(terms.sandy)}`);
    check('Mt and Mount both go, wherever they sit',
      terms.mt === 'hallen' && terms.mount === 'isa',
      `${JSON.stringify(terms.mt)} / ${JSON.stringify(terms.mount)}`);
    check('so do Ck and Creek', terms.ck === 'sandy', JSON.stringify(terms.ck));
    check('St leading is Saint and stays; St trailing is Street and goes',
      terms.saint === 'st marys' && terms.street === 'bathurst stanley',
      `${JSON.stringify(terms.saint)} / ${JSON.stringify(terms.street)}`);
    check('a word said twice is said once', terms.dupe === 'cudgewa north', JSON.stringify(terms.dupe));
    check('a digit is not a stray letter and stays', terms.digits === 'swansea 8 wwps',
      JSON.stringify(terms.digits));
    check('no name in the file reduces to nothing', terms.blanks === 0,
      `${terms.blanks} of ${terms.total} came back empty`);
    check('and a station with no name asks for no search', terms.empty === '');

    // ── 2. The pills ──────────────────────────────────────────────────────
    log('\nEvery link out of a station is a pill, in both places that draw them\n');

    const pills = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.lat != null && x.lon != null);
      const div = document.createElement('div');
      div.innerHTML = mapLinksHtml(s);
      const els = [...div.children];
      const hrefs = els.map(e => e.getAttribute('href') || '');
      const noCoords = document.createElement('div');
      noCoords.innerHTML = mapLinksHtml({ id: 'x', name: 'Upper Sandy Creek AL' });
      return {
        name: s.name,
        count: els.length,
        allPills: els.every(e => e.classList.contains('pill')),
        allBlank: els.every(e => e.getAttribute('target') === '_blank'
                             && (e.getAttribute('rel') || '').includes('noopener')),
        labels: els.map(e => e.textContent.trim()),
        fwin: hrefs.find(h => h.includes('FloodWarningInfrastructure')) || '',
        oohb: hrefs.find(h => h.includes('/sites/OOHB/')) || '',
        earth: hrefs.find(h => h.includes('earth.google.com')) || '',
        q: docSearchTerms(s.name),
        noCoordsCount: noCoords.children.length,
        noCoordsLabels: [...noCoords.children].map(e => e.textContent.trim()),
      };
    });

    check('five links: three ways to look at it, two libraries to search',
      pills.count === 5, pills.labels.join(' | '));
    check('every one of them carries .pill', pills.allPills);
    check('and every one leaves the site safely', pills.allBlank,
      'target=_blank with rel=noopener');
    check('the FWIN search is the library URL plus the reduced name',
      pills.fwin.startsWith('https://bom365.sharepoint.com/sites/int-FloodWarningInfrastructureNetworkProgram2/')
      && pills.fwin.includes('view=7&q=')
      && decodeURIComponent(pills.fwin.split('&q=')[1] || '') === pills.q,
      pills.fwin);
    check('the OOHB search is the other library, same words',
      pills.oohb.startsWith('https://bom365.sharepoint.com/sites/OOHB/FWN%20Library/')
      && decodeURIComponent(pills.oohb.split('&q=')[1] || '') === pills.q,
      pills.oohb);
    check('Google Earth is a camera at the coordinate, not a geocoder',
      /^https:\/\/earth\.google\.com\/web\/@-?[\d.]+,-?[\d.]+,0a,\d+d,/.test(pills.earth),
      pills.earth);
    check('a station with no coordinates still gets its two searches',
      pills.noCoordsCount === 2 && pills.noCoordsLabels.every(l => /Search/.test(l)),
      pills.noCoordsLabels.join(' | '));

    // The callout itself, opened for real, so the action row is asserted as the
    // browser builds it rather than as a string.
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
      null, { timeout: LOAD_TIMEOUT });

    const popup = await page.evaluate(() => {
      const m = state.mapMarkers.find(x => x.mnStation && x.mnStation.lat != null);
      m.openPopup();
      const row = document.querySelector('.leaflet-popup .mn-popup-actions');
      const kids = row ? [...row.children] : [];
      const out = {
        isRow: !!row && row.classList.contains('pill-row'),
        count: kids.length,
        allPills: kids.every(e => e.classList.contains('pill')),
        // Every in-page action is a <button>; every link out is an <a>.
        inPageAreButtons: kids.filter(e => !e.hasAttribute('href'))
                              .every(e => e.tagName === 'BUTTON' && e.type === 'button'),
        noDeadLinks: kids.every(e => e.getAttribute('href') !== '#'),
        labels: kids.map(e => e.textContent.trim()),
      };
      state.map.closePopup();
      return out;
    });

    check('the callout draws its actions as a wrapping pill row', popup.isRow);
    check('and every action in it is a pill', popup.allPills && popup.count >= 7,
      `${popup.count}: ${popup.labels.join(' | ')}`);
    check('the in-page ones are buttons, not links to nowhere',
      popup.inPageAreButtons && popup.noDeadLinks);

    // ── 3. Move pin ───────────────────────────────────────────────────────
    log('\nMove pin: armed for one station, dragged, read back, saved\n');

    const armed = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.lat != null && x.lon != null);
      selectStation(s.id);
      MapMovePin.start(s.id);
      const panel = document.querySelector('.mn-movepin-panel');
      return {
        id: s.id, lat: s.lat, lon: s.lon,
        armedId: MapMovePin.armed(),
        hasPanel: !!panel,
        hasMarker: !!document.querySelector('.mn-movepin-icon'),
        // The old position, still drawn: the "was here" mark and the leader.
        ghosts: state.map ? Object.values(state.map._layers)
          .filter(l => l.options && l.options.dashArray).length : 0,
        buttonOn: !!document.querySelector('#ef-movepin.is-on'),
        pressed: document.querySelector('#ef-movepin')?.getAttribute('aria-pressed'),
        readout: panel ? panel.querySelector('dd')?.textContent.trim() : null,
      };
    });

    check('arming names the station it armed', armed.armedId === armed.id);
    check('a panel and a draggable pin appear on the map',
      armed.hasPanel && armed.hasMarker);
    check('and the old position stays as a dashed mark with a leader to the new one',
      armed.ghosts >= 2, `${armed.ghosts} dashed layer(s)`);
    check('the card’s button says it is on, to a screen reader too',
      armed.buttonOn && armed.pressed === 'true');
    check('the readout opens on where the station already is',
      Number(armed.readout) === Number(armed.lat.toFixed(6)),
      `${armed.readout} vs ${armed.lat}`);

    // A click on the map is the other way to move it — same path the drag
    // handler takes, and the one that can be driven without a real pointer.
    const moved = await page.evaluate(([lat, lon]) => {
      state.map.fire('click', { latlng: L.latLng(lat + 0.02, lon + 0.02) });
      const panel = document.querySelector('.mn-movepin-panel');
      const dds = [...panel.querySelectorAll('dd')].map(d => d.textContent.trim());
      return { lat: Number(dds[0]), lon: Number(dds[1]), moved: dds[2] };
    }, [armed.lat, armed.lon]);

    check('clicking the map moves the pin, to six decimal places',
      Math.abs(moved.lat - (armed.lat + 0.02)) < 1e-6
      && Math.abs(moved.lon - (armed.lon + 0.02)) < 1e-6,
      `${moved.lat}, ${moved.lon}`);
    check('and the panel says how far it has been moved', /\bkm\b|\bm\b/.test(moved.moved),
      moved.moved);

    // And the drag itself, with a real pointer — the interaction the mode is
    // named for, and the one a synthetic event would not prove. Leaflet's
    // dragging listens on the marker's own DOM node, which only exists because
    // this is an L.Marker with a divIcon and not one of the map's 3,174
    // circleMarkers.
    //
    // Two things this got wrong first, and both are worth the comment. The
    // mouse takes *viewport* coordinates, so the handle is measured with
    // getBoundingClientRect() rather than with locator.boundingBox(), which is
    // relative to the page. And selecting a station renders the editor card
    // below the map, which reflows everything above it — so the pin is still
    // moving when the drag would start, and the pointer goes down on empty
    // ground 200 px away and does nothing at all, silently.
    //
    // A fixed wait is what found that and is the wrong fix for it: it is a
    // guess about a slower machine. Waiting for the position to *stop changing*
    // is the same assertion without the guess — two consecutive frames agreeing
    // is what "settled" means.
    const handle = await page.evaluate(async () => {
      const at = () => {
        const r = document.querySelector('.mn-movepin-icon').getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      };
      const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      let prev = at();
      for (let i = 0; i < 60; i++) {
        await frame();
        const now = at();
        if (Math.abs(now.cx - prev.cx) < 0.5 && Math.abs(now.cy - prev.cy) < 0.5) return now;
        prev = now;
      }
      return prev;
    });
    await page.mouse.move(handle.cx, handle.cy);
    await page.mouse.down();
    await page.mouse.move(handle.cx + 90, handle.cy + 60, { steps: 12 });
    await page.mouse.up();

    const dragged = await page.evaluate(([lat, lon]) => {
      const dds = [...document.querySelectorAll('.mn-movepin-panel dd')].map(d => d.textContent.trim());
      return { lat: Number(dds[0]), lon: Number(dds[1]), moved: dds[2], was: [lat, lon] };
    }, [moved.lat, moved.lon]);

    check('dragging the pin with a real pointer moves it, south and east',
      dragged.lat < moved.lat && dragged.lon > moved.lon,
      `${moved.lat},${moved.lon} → ${dragged.lat},${dragged.lon}`);
    check('and the readout followed the drag rather than the last click',
      dragged.lat !== moved.lat && dragged.lon !== moved.lon, dragged.moved);

    const cancelled = await page.evaluate(() => {
      MapMovePin.cancel();
      return {
        armedId: MapMovePin.armed(),
        panel: !!document.querySelector('.mn-movepin-panel'),
        marker: !!document.querySelector('.mn-movepin-icon'),
        lat: document.getElementById('ef-lat')?.value,
        buttonOn: !!document.querySelector('#ef-movepin.is-on'),
      };
    });

    check('cancel takes the mode, the panel and the pin away',
      cancelled.armedId === null && !cancelled.panel && !cancelled.marker && !cancelled.buttonOn);
    check('and leaves the coordinate box exactly as it was',
      Number(cancelled.lat) === armed.lat, `${cancelled.lat} vs ${armed.lat}`);

    // Save, signed out. The write is refused — there is no session and the list
    // came from stations.json — but the numbers have to reach the form and the
    // refusal has to say which of the two reasons it was.
    const saved = await page.evaluate(([lat, lon]) => {
      MapMovePin.start(state.editorId);
      state.map.fire('click', { latlng: L.latLng(lat - 0.05, lon - 0.05) });
      MapMovePin.save();
      return {
        armedId: MapMovePin.armed(),
        lat: Number(document.getElementById('ef-lat').value),
        lon: Number(document.getElementById('ef-lon').value),
        draftLat: state.editorDraft.lat,
        status: document.getElementById('ef-status')?.textContent.trim() || '',
        panel: !!document.querySelector('.mn-movepin-panel'),
      };
    }, [armed.lat, armed.lon]);

    check('save deactivates the mode', saved.armedId === null && !saved.panel);
    check('and writes the dragged position into the form’s own boxes',
      Math.abs(saved.lat - (armed.lat - 0.05)) < 1e-6
      && Math.abs(saved.lon - (armed.lon - 0.05)) < 1e-6,
      `${saved.lat}, ${saved.lon}`);
    check('and into the draft the save reads from', saved.draftLat === saved.lat);
    check('signed out, it says so rather than failing at the network',
      /signed-in session|did not come from the datastore/.test(saved.status),
      saved.status);
    check('and the typed numbers survive the refusal',
      Math.abs(saved.lat - (armed.lat - 0.05)) < 1e-6);

    // ── 4. One mode at a time ─────────────────────────────────────────────
    log('\nArming it takes the map’s other interactive modes off\n');

    const exclusive = await page.evaluate(() => {
      MapDraw.setTool('circle');
      LinkBudget.setPicking(true);
      const before = { tool: state.draw.tool, drawing: state.map.getContainer().classList.contains('mn-drawing') };
      MapMovePin.start(state.editorId);
      const after = {
        tool: state.draw.tool,
        drawing: state.map.getContainer().classList.contains('mn-drawing'),
        armed: MapMovePin.armed(),
      };
      MapMovePin.cancel();
      return { before, after };
    });

    check('a draw tool was armed to begin with',
      exclusive.before.tool === 'circle' && exclusive.before.drawing);
    check('arming the move disarms it, so the pin can be dragged at all',
      !exclusive.after.tool && !exclusive.after.drawing && !!exclusive.after.armed);

    // Leaving the tab has to take the mode with it — a marker left pointing at
    // a map that has been removed is the leak `npm run registry` exists for,
    // one floor down.
    const tornDown = await page.evaluate(() => {
      MapMovePin.start(state.editorId);
      switchTab('networks');
      return {
        armed: MapMovePin.armed(),
        marker: !!document.querySelector('.mn-movepin-icon'),
        panel: !!document.querySelector('.mn-movepin-panel'),
      };
    });
    check('and leaving the Stations tab takes the whole mode with it',
      tornDown.armed === null && !tornDown.marker && !tornDown.panel);

    check('nothing threw for the whole run', errors.length === 0, errors[0] || '');

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }

  const bad = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).\n`);
  if (bad.length) {
    log(`FAIL — ${bad.length} of ${results.length}:\n`);
    for (const b of bad) log(`  ${b.label}${b.detail ? `\n      ${b.detail}` : ''}`);
    process.exit(1);
  }
  log('PASS — the links are pills that go where they say, and a pin moves only when\n'
    + '       somebody arms it, says where, and saves.');
}

main().catch(err => { console.error(err); process.exit(1); });
