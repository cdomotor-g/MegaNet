// The two things this change added to the Stations tab, driven in a real
// browser.
//
//   1. **Copy lat, lon** — a pill on the station's map callout and on its
//      editor card, beside Move pin on both. The callout's copies the station's
//      recorded position; the card's copies what the two coordinate boxes
//      currently say, which is not the same thing the moment a pin has been
//      dragged into them or a figure typed over them.
//   2. **The station list collapses**, the same <details> the Filters, Path
//      profile and Link budget cards on that tab already are — remembered
//      between visits, with the live row count and the selected station on the
//      summary so a shut card still answers what the list is open for.
//
// Why a check of its own rather than a few more lines in `smoke`: every failure
// here renders a page that looks entirely correct. A Copy button that puts the
// wrong coordinate on the clipboard, one that copies the saved position over
// the dragged one, a card that forgets it was shut, a summary whose count stops
// being repainted — none of them is an error in the console, and the clipboard
// is not something a person double-checks. A wrong coordinate that pastes
// cleanly into a work order is the exact defect this exists to hold shut.
//
// It is separate from `movepin` on purpose: that check is #170's, its "five
// links" assertion is a *cap* on the row mapLinksHtml() builds, and this pill
// is deliberately not part of that row — every pill in it leaves the site, and
// this one does not go anywhere at all.
//
// The clipboard is read back for real. The context is granted clipboard-read
// and clipboard-write, so `navigator.clipboard.writeText` is the path under
// test; the `document.execCommand` fallback beneath it is exercised directly at
// the end, because it is the only path that exists over `file://` — a mode this
// app supports on purpose — and nothing else here would ever reach it.
//
// Run:  npm run stationscard
//       npm run stationscard -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}

const LABEL = '📋 Copy lat, lon';

async function main() {
  const server  = await startServer();
  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);

    // Only uncaught exceptions. Aborted off-origin subresources are the network
    // policy working, not the app failing — see lib/network.mjs.
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(
      () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });

    // ── 1. The coordinate that gets copied ────────────────────────────────
    log('\nThe coordinate is the one a person can read back, not a double\n');

    const text = await page.evaluate(() => ({
      plain:    stationLatLonText({ lat: -27.3278, lon: 150.9218 }),
      // What a double actually holds after arithmetic on a coordinate.
      noisy:    stationLatLonText({ lat: 0.1 + 0.2, lon: -18.514400000000002 }),
      // Trailing zeros are noise, not precision.
      short:    stationLatLonText({ lat: -33.12, lon: 146 }),
      noLat:    stationLatLonText({ lat: null, lon: 146.0006 }),
      noLon:    stationLatLonText({ lat: -18.5144, lon: null }),
      nothing:  stationLatLonText(null),
      // Zero is a coordinate. `!s.lat` would drop the equator and the meridian.
      origin:   stationLatLonText({ lat: 0, lon: 0 }),
    }));
    check('a recorded position is copied exactly as it reads',
      text.plain === '-27.3278, 150.9218', text.plain);
    check('a double’s seventeen digits become the six that mean anything',
      text.noisy === '0.3, -18.5144', text.noisy);
    check('and trailing zeros are not added back',
      text.short === '-33.12, 146', text.short);
    check('half a position is not a position', !text.noLat && !text.noLon,
      `${text.noLat} | ${text.noLon}`);
    check('nor is no station at all', text.nothing === '');
    check('but zero is a coordinate, and survives', text.origin === '0, 0', text.origin);

    // ── 2. The callout ────────────────────────────────────────────────────
    log('\nCopy lat, lon on the map callout\n');

    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
      null, { timeout: LOAD_TIMEOUT });

    // The action row is shut by default since #175 — the pill is reached by
    // pressing "Actions (N) ▾" first, the way a person does.
    const calloutShut = await page.evaluate(() => {
      const m = state.mapMarkers.find(x => x.mnStation && x.mnStation.lat != null);
      m.openPopup();
      return {
        rowAbsent: !document.querySelector('.leaflet-popup .mn-popup-actions'),
        expander:  !!document.querySelector('.leaflet-popup .mn-popup-expand'),
      };
    });
    check('the callout opens with its actions shut', calloutShut.rowAbsent && calloutShut.expander);
    await page.click('.leaflet-popup .mn-popup-expand');
    await page.waitForSelector('.leaflet-popup .mn-copy-latlon', { timeout: 5000 });

    const pop = await page.evaluate(() => {
      const m = state.mapMarkers.find(x => x.mnStation && x.mnStation.lat != null);
      const row = document.querySelector('.leaflet-popup .mn-popup-actions');
      const btn = row && row.querySelector('.mn-copy-latlon');
      return {
        inRow:  !!btn && btn.parentElement === row,
        isPill: !!btn && btn.classList.contains('pill'),
        tag:    btn && btn.tagName,
        type:   btn && btn.type,
        label:  btn && btn.textContent.trim(),
        data:   btn && btn.getAttribute('data-mn-latlon'),
        title:  btn && btn.getAttribute('title'),
        want:   stationLatLonText(m.mnStation),
      };
    });
    check('the callout’s action row carries it', pop.inRow && pop.isPill, pop.label || 'missing');
    check('as a <button type="button">, not a link to nowhere — nothing is navigated',
      pop.tag === 'BUTTON' && pop.type === 'button', `${pop.tag} type=${pop.type}`);
    check('carrying the station’s own position', !!pop.data && pop.data === pop.want,
      `${pop.data} vs ${pop.want}`);
    check('and a tooltip naming exactly what will be copied',
      (pop.title || '').includes(pop.want), pop.title);

    await page.click('.leaflet-popup .mn-copy-latlon');
    const copied = await page.evaluate(async () => ({
      clip:  await navigator.clipboard.readText(),
      label: document.querySelector('.leaflet-popup .mn-copy-latlon')?.textContent.trim(),
    }));
    check('pressing it puts that position on the clipboard', copied.clip === pop.want, copied.clip);
    check('and the label says so, in place', copied.label === '✓ Copied', copied.label);

    // announce() writes the live region a frame after clearing it.
    await page.waitForTimeout(120);
    const said = await page.evaluate(() => document.getElementById('app-status')?.textContent.trim());
    check('a screen reader is told what was copied, not that something happened',
      said === `Copied ${pop.want}`, said);

    // The flash is 1.6 s; the label has to come back rather than the pill being
    // left reading "Copied" for the rest of the session.
    await page.waitForTimeout(1800);
    const back = await page.evaluate(() =>
      document.querySelector('.leaflet-popup .mn-copy-latlon')?.textContent.trim());
    check('then it puts itself back', back === LABEL, back);

    // ── 3. The editor card ────────────────────────────────────────────────
    log('\nCopy lat, lon on the editor card — the boxes, not the record\n');

    await page.evaluate(() => state.map.closePopup());
    const ed = await page.evaluate(() => {
      const s = state.data.stations.filter(x => x.lat != null && x.lon != null)[5];
      selectStation(s.id);
      const btn = document.querySelector('#stations-editor-card .mn-copy-latlon');
      const row = btn && btn.closest('.ef-movepin');
      return {
        found:     !!btn,
        onCoordRow: !!row && row.classList.contains('pill-row'),
        besideMove: !!row && !!row.querySelector('#ef-movepin'),
        // No baked-in coordinate: one would go stale the moment a pin is
        // dragged into the boxes, which map-move-pin does without re-rendering
        // the card.
        noStale:   !!btn && !btn.hasAttribute('data-mn-latlon'),
        handler:   btn && btn.getAttribute('onclick'),
      };
    });
    check('the editor card carries the same pill', ed.found);
    check('on the coordinate row, beside Move pin on map',
      ed.onCoordRow && ed.besideMove);
    check('reading the boxes rather than a figure baked in when the card was drawn',
      ed.noStale && ed.handler === 'editorCopyLatLon(this)', ed.handler);

    // Type over the boxes. This is the case the callout's pill cannot cover and
    // the reason the card's is a different handler: what is on screen is what a
    // person means by "this station's coordinates".
    await page.evaluate(() => {
      document.getElementById('ef-lat').value = '-12.345678';
      document.getElementById('ef-lon').value = '145.5';
    });
    await page.click('#stations-editor-card .mn-copy-latlon');
    const edited = await page.evaluate(async () => ({
      clip:  await navigator.clipboard.readText(),
      label: document.querySelector('#stations-editor-card .mn-copy-latlon')?.textContent.trim(),
    }));
    check('an edited coordinate is what reaches the clipboard, not the saved one',
      edited.clip === '-12.345678, 145.5', edited.clip);
    check('and the label confirms it', edited.label === '✓ Copied', edited.label);

    await page.waitForTimeout(1800);
    await page.evaluate(() => {
      document.getElementById('ef-lat').value = '';
      document.getElementById('ef-lon').value = '';
    });
    await page.click('#stations-editor-card .mn-copy-latlon');
    const emptied = await page.evaluate(async () => ({
      label: document.querySelector('#stations-editor-card .mn-copy-latlon')?.textContent.trim(),
      clip:  await navigator.clipboard.readText(),
    }));
    check('emptied boxes say so rather than doing nothing visible',
      emptied.label === '✗ No position', emptied.label);
    check('and nothing is written over what was already on the clipboard',
      emptied.clip === '-12.345678, 145.5', emptied.clip);

    // ── 4. The fallback ───────────────────────────────────────────────────
    log('\nThe clipboard path that exists over file://\n');

    const fell = await page.evaluate(() => {
      const ok = _copyFallback('fallback-wrote-this');
      return { ok };
    });
    const fellClip = await page.evaluate(() => navigator.clipboard.readText());
    check('execCommand still lands text, for the contexts navigator.clipboard is refused in',
      fell.ok && fellClip === 'fallback-wrote-this', `${fell.ok} / ${fellClip}`);
    const leftover = await page.evaluate(() =>
      [...document.querySelectorAll('textarea')].filter(t => t.value === 'fallback-wrote-this').length);
    check('and takes its scratch textarea away again', leftover === 0, `${leftover} left behind`);

    // ── 5. The list collapses ─────────────────────────────────────────────
    log('\nThe station list is a card that shuts, and says what it is hiding\n');

    const card = await page.evaluate(() => {
      const d = document.querySelector('#stations-list-card > details.stations-card');
      return {
        exists:  !!d,
        open:    !!d && d.open,
        heading: d ? d.querySelector('summary h3')?.textContent.replace(/\s+/g, ' ').trim() : '',
        count:   d ? d.querySelector('summary #st-count')?.textContent.trim() : '',
        rows:    tableStations().length,
        // "+ New" is in the body, not the summary: a <button> inside a <summary>
        // is a target that toggles the card as often as it is pressed.
        newInBody:    !!d && !!d.querySelector('.stations-card-body .stations-card-actions button'),
        newInSummary: !!d && !!d.querySelector('summary button'),
        // The scroll region and its name came along unchanged.
        namedRegion: (() => {
          const w = document.getElementById('stations-table-wrap');
          return !!w && w.getAttribute('role') === 'region'
              && w.getAttribute('aria-labelledby') === 'stations-table-h'
              && !!document.getElementById('stations-table-h');
        })(),
      };
    });
    check('the list is a <details class="stations-card">', card.exists);
    check('open on a first visit — the list is half of what this tab is', card.open);
    check('its summary is the heading, with the live row count on it',
      /^Stations\b/.test(card.heading) && card.count === String(card.rows),
      `${card.heading} (table has ${card.rows})`);
    check('"+ New" moved into the body rather than into the summary',
      card.newInBody && !card.newInSummary);
    check('the table is still a named scroll region inside it', card.namedRegion);

    // Shut it through the gesture a person makes, not by setting `open`.
    await page.click('#stations-list-card > details.stations-card > summary');
    await page.waitForTimeout(150);
    const shut = await page.evaluate(() => ({
      open:    document.querySelector('#stations-list-card > details.stations-card').open,
      state:   state.stationsListOpen,
      stored:  localStorage.getItem('mn-stations-list'),
      heading: document.getElementById('stations-table-h').checkVisibility(),
      table:   document.getElementById('stations-table-wrap').checkVisibility(),
      note:    document.getElementById('stations-list-note')?.textContent.trim(),
      selected: (state.data.stations.find(s => s.id === state.selectedId) || {}).name,
    }));
    check('clicking the summary shuts it', shut.open === false);
    check('and the state and the stored answer both follow',
      shut.state === false && shut.stored === 'closed',
      `state=${shut.state} stored=${shut.stored}`);
    check('the heading stays on screen; the 3,000-row scroller does not',
      shut.heading === true && shut.table === false);
    check('and the summary names the selected station, so a shut card still answers '
      + 'what the editor below is talking about',
      shut.note === `Selected: ${shut.selected}`, `${shut.note} vs ${shut.selected}`);

    // The note is repainted by rerenderStations(), which every selection path
    // goes through — including one made while the card is shut.
    const reselected = await page.evaluate(() => {
      const s = state.data.stations.filter(x => x.lat != null && x.lon != null)[9];
      selectStation(s.id);
      return { want: `Selected: ${s.name}`,
               got: document.getElementById('stations-list-note').textContent.trim() };
    });
    check('a selection made while it is shut repaints that note',
      reselected.got === reselected.want, `${reselected.got} vs ${reselected.want}`);

    const cleared = await page.evaluate(() => {
      selectStation(state.selectedId);        // toggles the selection off
      return document.getElementById('stations-list-note').textContent.trim();
    });
    check('and clearing the selection says so rather than keeping a stale name',
      cleared === 'No station selected', cleared);

    // Remembered: the whole reason this one is stored rather than reset per
    // visit, the same argument the Filters card makes.
    await page.evaluate(() => { switchTab('networks'); switchTab('stations'); });
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    const remembered = await page.evaluate(() =>
      document.querySelector('#stations-list-card > details.stations-card').open);
    check('leaving the tab and coming back finds it still shut', remembered === false);

    await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
      null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    const afterReload = await page.evaluate(() => ({
      open:  document.querySelector('#stations-list-card > details.stations-card').open,
      state: state.stationsListOpen,
    }));
    check('and so does a reload — it is a decision, not a gesture',
      afterReload.open === false && afterReload.state === false,
      `open=${afterReload.open} state=${afterReload.state}`);

    // Put it back, and prove the round trip: a card that could only ever be
    // shut would pass everything above.
    await page.click('#stations-list-card > details.stations-card > summary');
    await page.waitForTimeout(150);
    const reopened = await page.evaluate(() => ({
      open:   document.querySelector('#stations-list-card > details.stations-card').open,
      stored: localStorage.getItem('mn-stations-list'),
      table:  document.getElementById('stations-table-wrap').checkVisibility(),
      rows:   document.querySelectorAll('#stations-table-wrap tr[data-sid]').length,
    }));
    check('opening it again brings the table back, and is remembered too',
      reopened.open && reopened.stored === 'open' && reopened.table && reopened.rows > 0,
      `${reopened.rows} row(s), stored=${reopened.stored}`);

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — the position on the clipboard is the one on screen, and the station\n'
    + '       list shuts, says what it is hiding, and is remembered.');
}

main().catch(err => { console.error(err); process.exit(1); });
