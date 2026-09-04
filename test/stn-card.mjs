// The station card on the Stations map, and the callout it turned into a
// signpost (#175), driven in a real browser at two widths.
//
//   1. **The card** — bottom-left of the map, painted by a plain pin click
//      *without* selecting the station, by every row selection, and never by
//      anything passive once it has been closed. It is state, not popup DOM:
//      a filter keystroke rebuilds every marker and destroys the callout, and
//      the card has to still be there afterwards. Edit station ↓ on it is the
//      first thing in the app that scrolls the editor into view.
//   2. **One card at a time** — this card, the ACMA transmitter card and the
//      radio-path card share one rectangle. The two older ones never closed
//      each other, so the assertion that covers the new exclusion also pins
//      the fix for that.
//   3. **The phone** — at 375 px the callout carries the identity and two fat
//      pills, the close button is finger-sized, and Details opens the card as
//      a sheet across the bottom of the map, with focus in it.
//   4. **Discoverability** — the one-time tip about the 👁️ button, the legend
//      naming the layers that are off, and the flyout's group headings.
//
// Why a check of its own: every failure here renders a page that looks
// entirely correct. A card that dies with a filter keystroke, a pin click that
// quietly starts selecting, a close that hands focus to <body>, two cards drawn
// on top of each other — none of them is an error in the console, and smoke
// sees a clean tab. A phone callout wider than the map is the one the operator
// finds in a paddock, which is the worst place to find it.
//
// Run:  npm run stncard
//       npm run stncard -- -v

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

// A marker to click: the n-th station with ALERT ids and no other station
// within ~500 m, with the map zoomed onto it. Clicking a pin that shares its
// pixels with another fans the stack out (MapSpider) instead of opening a
// callout — which is right, and is not what this file is testing. Evaluated
// in the page; returns the marker.
const lonePin = n => `(() => {
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005;
  const all = state.data.stations.filter(x => x.lat != null && x.lon != null);
  const s = all.filter(x => stationAlertIds(x).length
    && !all.some(y => y !== x && near(x, y)))[${n}];
  const m = state.mapMarkers.find(x => x.mnStationId === s.id);
  state.map.setView(m.getLatLng(), 15, { animate: false });
  return m;
})()`;

// Open the app in a fresh context, land on the Stations tab with the map
// built. Storage is fresh per context, which is what the one-time tip needs.
async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
    null, { timeout: LOAD_TIMEOUT });
  // The first refresh fits the map to every station, animated. A setView
  // issued while that zoom animation is running is ignored by Leaflet — the
  // pin would then be tapped at the whole-network zoom, in a stack — so the
  // map is left to settle before anything drives it.
  await page.waitForFunction(() => !state.map._animatingZoom
    && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });
  await page.waitForTimeout(150);
  return { context, page };
}

async function main() {
  const server  = await startServer();
  const browser = await launchBrowser();
  const errors  = [];

  try {
    // ── A. Desktop ──────────────────────────────────────────────────────
    const { page } = await openStations(browser, server, errors,
      { viewport: { width: 1440, height: 900 } });

    log('\nA pin click paints the card, and does not select\n');

    // A real click on the marker — the same event Leaflet fires — rather than
    // showStationCard() called by hand, so the whole path from the pin is
    // what is under test.
    const clicked = await page.evaluate(`(() => {
      const m = ${lonePin(0)};
      const before = state.selectedId;
      m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
      const card = document.getElementById('stn-card');
      const title = document.getElementById('stn-card-title');
      return {
        id: m.mnStationId, name: m.mnStation.name,
        shown:    !!card && !card.hidden,
        title:    title && title.textContent.trim(),
        role:     card && card.getAttribute('role'),
        labelled: card && card.getAttribute('aria-labelledby'),
        tabIndex: card && card.tabIndex,
        focusIn:  card && card.contains(document.activeElement),
        selectedUnchanged: state.selectedId === before,
        popupToo: !!document.querySelector('.leaflet-popup'),
        stateId:  state.stnCard.id,
      };
    })()`);
    check('clicking a pin paints the station card', clicked.shown && clicked.stateId === clicked.id);
    check('titled with the station', clicked.title === clicked.name, `${clicked.title} vs ${clicked.name}`);
    check('as a dialog labelled by that title, focusable by script',
      clicked.role === 'dialog' && clicked.labelled === 'stn-card-title' && clicked.tabIndex === -1,
      `role=${clicked.role} labelledby=${clicked.labelled} tabindex=${clicked.tabIndex}`);
    check('a paint, not an open — focus is left where it was', clicked.focusIn === false);
    check('and the selection is untouched — a plain click still does not select',
      clicked.selectedUnchanged);
    check('the callout opens beside it, as it always did', clicked.popupToo);

    const rows = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === state.stnCard.id);
      const card = document.getElementById('stn-card');
      const text = card.textContent;
      const rowVal = label => {
        const row = [...card.querySelectorAll('.acma-row')].find(r =>
          r.firstElementChild.textContent.trim() === label);
        return row ? row.lastElementChild.textContent.trim() : null;
      };
      const wind = card.querySelector(`#mn-wind-card-${CSS.escape(s.id)}`);
      const acts = card.querySelector('.stn-card-actions');
      const kids = acts ? [...acts.children] : [];
      return {
        position:   rowVal('Position'), want: stationLatLonText(s),
        stn:        s.station_number ? rowVal('Stn #') === String(s.station_number) : null,
        elev:       s.elevation_ahd != null ? rowVal('Elevation') === `${s.elevation_ahd} m AHD` : null,
        ids:        /AlertID/.test(text) && stationAlertIds(s).every(id => text.includes(String(id))),
        wind:       !!wind && wind.dataset.mnWind === `${s.lat},${s.lon}`,
        allPills:   kids.length > 0 && kids.every(e => e.classList.contains('pill')),
        editFirst:  kids[0] && kids[0].classList.contains('mn-edit-station')
                    && kids[0].tagName === 'BUTTON' && kids[0].type === 'button',
        hasCopy:    !!acts.querySelector('.mn-copy-latlon'),
        hasList:    kids.some(e => /^Show in the list below/.test(e.textContent.trim())),
        count:      kids.length, expect: stationActionPills(s).length + 1,
        footer:     /Pin clicks show this card without changing the selection/.test(text),
        carried:    findRepeaterMatches(s).length,
        saysCarried: /Carried by \d+ repeater/.test(text),
        noJump:     !card.querySelector('.link-btn'),
      };
    });
    check('the card carries the position, as the same figure Copy hands over',
      rows.position === rows.want, `${rows.position} vs ${rows.want}`);
    check('the station number and elevation, where the station has them',
      rows.stn !== false && rows.elev !== false);
    check('every ALERT id, and the wind region under its own element id',
      rows.ids && rows.wind);
    check('every action is a pill, Edit station first', rows.allPills && rows.editFirst);
    check('and the row is Edit plus exactly what the callout offers',
      rows.hasCopy && rows.hasList && rows.count === rows.expect,
      `${rows.count} vs ${rows.expect}`);
    check('the footer says what a pin click does and does not do', rows.footer);
    check('a carried station says how many repeaters carry it',
      rows.carried === 0 || rows.saysCarried, `${rows.carried} carrier(s)`);
    check('but offers no jump to a card that is not drawn for an unselected station', rows.noJump);

    log('\nIt outlives the callout\n');

    // A filter change rebuilds every marker, which destroys the open callout.
    // The card is not Leaflet's, and is still there.
    const survived = await page.evaluate(async () => {
      const s = state.data.stations.find(x => x.id === state.stnCard.id);
      state.filters.searches = [newSearchRow(s.name.slice(0, 3))];
      stationsFilterChanged();
      await new Promise(r => setTimeout(r, 450));
      return {
        popupGone: !document.querySelector('.leaflet-popup'),
        cardThere: !document.getElementById('stn-card').hidden,
        title:     document.getElementById('stn-card-title').textContent.trim(),
        name:      s.name,
      };
    });
    check('a filter change takes the callout with the markers', survived.popupGone);
    check('and leaves the card, still on the same station',
      survived.cardThere && survived.title === survived.name);
    await page.evaluate(() => { resetStationFilters(); stationsFilterChanged(); });
    await page.waitForTimeout(450);

    log('\nEdit station ↓ selects, and is the first thing that scrolls to the editor\n');

    await page.click('#stn-card .mn-edit-station');
    // Smooth scroll — give it a moment to arrive.
    await page.waitForTimeout(700);
    const edited = await page.evaluate(() => {
      const card = document.getElementById('stations-editor-card');
      const r = card.getBoundingClientRect();
      return {
        selected:  state.selectedId === state.stnCard.id,
        inView:    r.top >= -4 && r.top < window.innerHeight,
        focusIn:   card.contains(document.activeElement),
        cardThere: !document.getElementById('stn-card').hidden,
        top: Math.round(r.top),
      };
    });
    check('Edit selects the station', edited.selected);
    check('and brings the editor card into the viewport', edited.inView, `top=${edited.top}`);
    check('with focus on its first control', edited.focusIn);
    check('while the map card stays, repainted for the selection', edited.cardThere);

    const jump = await page.evaluate(() => ({
      offered: !!document.querySelector('#stn-card .link-btn'),
      carried: findRepeaterMatches(state.data.stations.find(x => x.id === state.stnCard.id)).length,
    }));
    check('now selected, a carried station offers the jump to Repeaters listening',
      jump.carried === 0 || jump.offered, `${jump.carried} carrier(s)`);

    // Out of full screen on the way to the editor: there is no "below" inside
    // a fixed panel.
    const fromFull = await page.evaluate(() => {
      toggleMapFullscreen(true);
      const was = state.mapFullscreen;
      editStationFromCard(state.stnCard.id);
      return { was, now: state.mapFullscreen };
    });
    check('from full screen, Edit leaves full screen first', fromFull.was === true && fromFull.now === false);
    await page.waitForTimeout(400);

    log('\nClosing is a decision; opening is a gesture\n');

    await page.click('#stn-card .acma-card-head button');
    const closed = await page.evaluate(() => {
      rerenderStationEditorCard();          // a repaint hook, with a selection still set
      return {
        hidden:  document.getElementById('stn-card').hidden,
        idNull:  state.stnCard.id === null,
        stillHidden: document.getElementById('stn-card').hidden,
      };
    });
    check('× closes the card and forgets the station', closed.hidden && closed.idNull);
    check('and nothing passive brings it back', closed.stillHidden);

    const reopened = await page.evaluate(`(() => {
      const m = ${lonePin(0)};
      m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
      return !document.getElementById('stn-card').hidden;
    })()`);
    check('but the next pin click is an ask, and reopens it', reopened);

    // An explicit open moves focus in; Escape closes back to the opener — and
    // in full screen, where Escape is also how the map is left, the card's
    // Escape is the card's alone.
    const escaped = await page.evaluate(() => {
      const card = document.getElementById('stn-card');
      const esc = () => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // The theme button: on the page at every width (the first header button
      // is the phone-only ☰, which refuses focus on a desktop).
      const opener = document.getElementById('btn-theme');
      opener.focus();
      showStationCard(state.stnCard.id, { takeFocus: true });
      const focusedIn = document.activeElement === card;
      esc();
      const out = { focusedIn, hidden: card.hidden, back: document.activeElement === opener };
      // In full screen the header is behind the panel and refuses focus; the
      // card's Escape is still the card's alone, and focus lands on the map.
      toggleMapFullscreen(true);
      opener.focus();
      showStationCard(state.stnCard.id, { takeFocus: true });
      esc();
      out.fullHidden = card.hidden;
      out.fullStill  = state.mapFullscreen;
      out.onMap      = document.activeElement === document.getElementById('leaflet-map');
      toggleMapFullscreen(false);
      return out;
    });
    check('an explicit open puts focus in the card', escaped.focusedIn);
    check('Escape closes it, back to what opened it', escaped.hidden && escaped.back);
    check('in full screen, Escape is the card\'s alone — the map stays full',
      escaped.fullHidden && escaped.fullStill === true);
    check('and focus lands on the map, the opener being behind the panel', escaped.onMap);

    // The opener is often gone by the time the card closes: a table row is
    // replaced by the selection it made, and the phone callout's Details pill
    // dies with the callout. Focus then goes to the same station's row, and
    // failing that to the map — never to <body>.
    const gone = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === state.selectedId);
      const ghost = document.createElement('button');
      document.body.appendChild(ghost); ghost.focus();
      showStationCard(s.id, { opener: ghost });
      ghost.remove();
      closeStnCard();
      const a = document.activeElement;
      const row = a && a.closest('#stations-table-wrap tr[data-sid]');
      return { rowSid: row && row.dataset.sid, want: s.id, tag: a && a.tagName, isBody: a === document.body };
    });
    check('with the opener gone, closing lands on that station\'s row',
      gone.rowSid === gone.want && !gone.isBody, `${gone.tag} row=${gone.rowSid}`);

    log('\nOne card over the map at a time\n');

    const excl = await page.evaluate(() => {
      const el = id => document.getElementById(id);
      const s = state.data.stations.find(x => x.id === state.selectedId);
      const out = {};
      showStationCard(s.id);
      showAcmaCard('no-such-device');          // opens the card in its loading state
      out.acmaHidesStn = el('stn-card').hidden && !el('acma-card').hidden;
      showStationCard(s.id);
      out.stnHidesAcma = el('acma-card').hidden && !el('stn-card').hidden
        && state.acma.cardDeviceId === null;
      // A field station and one of its repeaters, both on the map.
      const pair = (() => {
        for (const f of state.data.stations) {
          if (f.lat == null) continue;
          const r = findRepeaterMatches(f).find(x => x.lat != null);
          if (r) return [f, r];
        }
        return null;
      })();
      if (pair) {
        MapBackbone.open('field', pair[0].id, pair[1].id);
        out.pathHidesStn = el('stn-card').hidden && !el('path-card').hidden;
        showAcmaCard('no-such-device');
        out.acmaHidesPath = el('path-card').hidden && !el('acma-card').hidden;
        MapBackbone.open('field', pair[0].id, pair[1].id);
        out.pathHidesAcma = el('acma-card').hidden && !el('path-card').hidden;
        MapBackbone.closeCard();
      } else {
        out.pathHidesStn = out.acmaHidesPath = out.pathHidesAcma = 'no pair';
      }
      closeAcmaCard();
      return out;
    });
    check('the ACMA card closes the station card on its way open', excl.acmaHidesStn);
    check('and the station card closes the ACMA card', excl.stnHidesAcma);
    check('the path card closes the station card', excl.pathHidesStn === true, String(excl.pathHidesStn));
    check('the ACMA card and the path card, which shared a rectangle, now close each other',
      excl.acmaHidesPath === true && excl.pathHidesAcma === true,
      `${excl.acmaHidesPath} / ${excl.pathHidesAcma}`);

    log('\nA row selection paints it too — the keyboard\'s way onto the map\n');

    const fromRow = await page.evaluate(() => {
      const other = state.data.stations.filter(x => x.lat != null && x.id !== state.selectedId)[3];
      selectStation(other.id);
      return {
        title: document.getElementById('stn-card-title').textContent.trim(),
        name:  other.name,
        popup: !!document.querySelector('.leaflet-popup'),
      };
    });
    check('selecting a row paints the card for that station', fromRow.title === fromRow.name);
    check('and on a desktop opens its callout as well', fromRow.popup);

    // From the keyboard: Enter on a row's button. The table repaints under
    // the keyboard and used to drop focus to <body>; it finds the row again,
    // and the card's Escape returns to it.
    await page.evaluate(() => { state.map.closePopup(); closeStnCard(false); });
    // A row that is not the selected one — Enter on that would deselect.
    const rowSid = await page.evaluate(() => [...document.querySelectorAll('#stations-table-wrap tr[data-sid]')]
      .find(tr => tr.dataset.sid !== state.selectedId).dataset.sid);
    const rowBtn = page.locator(`#stations-table-wrap tr[data-sid="${rowSid}"] button`).first();
    await rowBtn.focus();
    await page.keyboard.press('Enter');
    const keyed = await page.evaluate(sid => {
      const a = document.activeElement;
      const row = a && a.closest('tr[data-sid]');
      const out = { kept: !!row && row.dataset.sid === sid, selected: state.selectedId === sid,
        card: !document.getElementById('stn-card').hidden };
      document.getElementById('stn-card').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const b = document.activeElement;
      out.backOnRow = !!(b && b.closest('tr[data-sid]') && b.closest('tr[data-sid]').dataset.sid === sid);
      return out;
    }, rowSid);
    check('Enter on a row selects it and keeps focus on that row through the repaint',
      keyed.kept && keyed.selected && keyed.card);
    check('and Escape on the card returns to that row', keyed.backOnRow);

    log('\nThe modes that share the card\'s pills\n');

    // Move pin takes the map: the card gives way, and arming twice arms once.
    const modes = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === state.selectedId)
        || state.data.stations.find(x => x.lat != null);
      showStationCard(s.id);
      MapMovePin.start(s.id);
      const armedOnce = MapMovePin.armed() === s.id;
      const cardClosed = document.getElementById('stn-card').hidden;
      MapMovePin.start(s.id);
      const icons = document.querySelectorAll('.mn-movepin-icon').length;
      const panels = document.querySelectorAll('.mn-movepin-panel').length;
      MapMovePin.cancel();
      return { armedOnce, cardClosed, icons, panels,
        left: document.querySelectorAll('.mn-movepin-icon, .mn-movepin-panel').length };
    });
    check('arming Move pin from the card closes the card — the mode takes the map',
      modes.armedOnce && modes.cardClosed);
    check('and arming it twice arms it once', modes.icons === 1 && modes.panels === 1,
      `${modes.icons} pin(s), ${modes.panels} panel(s)`);
    check('so cancel leaves nothing on the map', modes.left === 0, `${modes.left} left`);

    // Blast radius is a display mode, so the card stays; its pill has to flip
    // in place, with the keyboard still on it.
    const blast = await page.evaluate(() => {
      const r = state.data.stations.find(x => x.roles.includes('repeater') && x.repeater && x.lat != null);
      if (!r) return { none: true };
      showStationCard(r.id);
      const find = () => [...document.querySelectorAll('#stn-card .stn-card-actions .pill')]
        .find(b => /blast radius/.test(b.textContent));
      const pill = find();
      if (!pill) return { none: true };
      pill.focus();
      pill.click();
      const again = find();
      const out = { label: again && again.textContent.trim(), focused: document.activeElement === again,
        armed: state.mapBlast === true };
      MapBlast.disarm();
      out.backLabel = find() && find().textContent.trim();
      closeStnCard(false);
      return out;
    });
    check('a blast pill pressed on the card flips its label in place',
      blast.none || (blast.armed && blast.label === 'Hide blast radius'), blast.label);
    check('with the keyboard still on it through the repaint', blast.none || blast.focused);
    check('and disarming puts the label back', blast.none || blast.backLabel === 'Show blast radius', blast.backLabel);

    // The ACMA card is three tabs' furniture; opening it on another tab must
    // not forget which station this map was looking at.
    const kept = await page.evaluate(() => {
      const s = state.data.stations.find(x => x.lat != null);
      showStationCard(s.id);
      switchTab('workbench');
      showAcmaCard('no-such-device');
      closeAcmaCard();
      const idKept = state.stnCard.id === s.id;
      switchTab('stations');
      const title = document.getElementById('stn-card-title');
      return { idKept, shown: !document.getElementById('stn-card').hidden,
        title: title && title.textContent.trim(), name: s.name };
    });
    check('a transmitter card opened on the Workbench leaves the station card\'s memory alone',
      kept.idKept);
    check('so it is back on the map when the tab is', kept.shown && kept.title === kept.name);
    await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: 10_000 });

    // ── B. Phone ────────────────────────────────────────────────────────
    log('\nOn a phone: a callout that fits, and a card that is a sheet\n');

    const phone = await openStations(browser, server, errors,
      { viewport: { width: 375, height: 667 }, hasTouch: true });
    const pp = phone.page;

    const compact = await pp.evaluate(`(() => {
      const m = ${lonePin(0)};
      m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
      const pop = document.querySelector('.leaflet-popup');
      const row = document.querySelector('.leaflet-popup .mn-popup-actions');
      const kids = row ? [...row.children] : [];
      const close = document.querySelector('.leaflet-container a.leaflet-popup-close-button');
      const cs = close && getComputedStyle(close);
      return {
        id: m.mnStationId,
        cardHidden: document.getElementById('stn-card').hidden,
        noWind:  !document.querySelector('.leaflet-popup [id^="mn-wind-"]'),
        noIds:   !/AlertID/.test(document.querySelector('.leaflet-popup-content').textContent),
        noExpander: !document.querySelector('.leaflet-popup .mn-popup-expand'),
        two:     kids.length === 2,
        details: kids[0] && kids[0].classList.contains('mn-popup-details'),
        copy:    kids[1] && kids[1].classList.contains('mn-copy-latlon'),
        popW:    pop ? pop.getBoundingClientRect().width : 0,
        mapW:    document.getElementById('leaflet-map').clientWidth,
        maxH:    m.getPopup().options.maxHeight,
        closeW:  cs ? parseFloat(cs.width) : 0,
        closeH:  cs ? parseFloat(cs.height) : 0,
      };
    })()`);
    check('a pin tap opens the callout alone — no card yet', compact.cardHidden);
    check('the phone callout is identity and two pills: Details, then Copy',
      compact.two && compact.details && compact.copy);
    check('with nothing else — no wind line, no ALERT ids, no expander',
      compact.noWind && compact.noIds && compact.noExpander);
    check('and it fits inside the map', compact.popW > 0 && compact.popW <= compact.mapW,
      `${Math.round(compact.popW)} px in a ${compact.mapW} px map`);
    check('scrolling inside itself past 220 px rather than growing', compact.maxH === 220);
    check('the close button is finger-sized', compact.closeW >= 42 && compact.closeH >= 42,
      `${compact.closeW}×${compact.closeH}`);

    // Leaflet pans the map to fit the callout; let that settle before the tap.
    await pp.waitForTimeout(400);
    await pp.click('.leaflet-popup .mn-popup-details');
    // A closed callout fades for 200 ms before Leaflet removes its container.
    await pp.waitForFunction(() => !document.querySelector('.leaflet-popup'),
      null, { timeout: 3000 }).catch(() => {});
    const sheet = await pp.evaluate(() => {
      const card = document.getElementById('stn-card');
      const r = card.getBoundingClientRect();
      const map = document.getElementById('leaflet-map').getBoundingClientRect();
      return {
        // Leaflet keeps map._popup pointing at the last one after it closes.
        popupGone: !document.querySelector('.leaflet-popup')
                   && !(state.map._popup && state.map._popup.isOpen()),
        shown:     !card.hidden,
        focused:   document.activeElement === card,
        spans:     r.width >= map.width - 24,
        capped:    r.height <= map.height * 0.5 + 8,
        w: Math.round(r.width), h: Math.round(r.height), mapW: Math.round(map.width), mapH: Math.round(map.height),
      };
    });
    check('Details gives the callout up for the card', sheet.popupGone && sheet.shown,
      `popupGone=${sheet.popupGone} shown=${sheet.shown}`);
    check('which takes focus — this open was asked for by name', sheet.focused);
    check('and is a sheet across the bottom of the map, capped so the map shows above it',
      sheet.spans && sheet.capped, `${sheet.w}×${sheet.h} on a ${sheet.mapW}×${sheet.mapH} map`);

    // With the sheet open, a tap on another pin moves the sheet to it and
    // opens no callout: one surface, one station.
    const follow = await pp.evaluate(`(() => {
      const m = ${lonePin(1)};
      m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
      const t = document.getElementById('stn-card-title');
      return { title: t && t.textContent.trim(), name: m.mnStation.name,
        popup: !!(state.map._popup && state.map._popup.isOpen()),
        shown: !document.getElementById('stn-card').hidden,
        focused: document.getElementById('stn-card').contains(document.activeElement) };
    })()`);
    check('with the sheet open, a tap on another pin moves the sheet to it',
      follow.shown && follow.title === follow.name, `"${follow.title}" vs "${follow.name}"`);
    check('and opens no callout under it', !follow.popup);
    check('without moving focus — a paint, not an open', follow.focused);

    await pp.keyboard.press('Escape');
    const rowOnPhone = await pp.evaluate(() => {
      const closedByEsc = document.getElementById('stn-card').hidden;
      const other = state.data.stations.filter(x => x.lat != null && x.id !== state.stnCard.id)[7];
      selectStation(other.id);
      const title = document.getElementById('stn-card-title');
      return {
        closedByEsc,
        shown: !document.getElementById('stn-card').hidden,
        title: title && title.textContent.trim(),
        name:  other.name,
        popup: !!(state.map._popup && state.map._popup.isOpen()),
      };
    });
    check('Escape closes the sheet', rowOnPhone.closedByEsc);
    check('a row selection on a phone opens the card, not the callout',
      rowOnPhone.shown && rowOnPhone.title === rowOnPhone.name && !rowOnPhone.popup,
      `shown=${rowOnPhone.shown} "${rowOnPhone.title}" vs "${rowOnPhone.name}" popup=${rowOnPhone.popup}`);
    await phone.context.close();

    // ── C. Discoverability ──────────────────────────────────────────────
    log('\nThe layers that are off say where they are\n');

    const fresh = await openStations(browser, server, errors,
      { viewport: { width: 1440, height: 900 } });
    const fp = fresh.page;

    const tip = await fp.evaluate(() => ({
      shown: !document.getElementById('map-note').hidden,
      text:  document.getElementById('map-note').textContent,
      seen:  localStorage.getItem('mn-hint-display'),
    }));
    check('a first visit is told about the 👁️ button, once',
      tip.shown && /👁️/.test(tip.text) && /layers/.test(tip.text) && tip.seen === '1',
      `shown=${tip.shown} seen=${tip.seen} "${tip.text}"`);
    await fp.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await fp.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    await fp.evaluate(() => switchTab('stations'));
    await fp.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    const again = await fp.evaluate(() => document.getElementById('map-note').hidden);
    check('and not told again', again === true);

    const legend = await fp.evaluate(() => {
      // Wind regions are ON by default since #176, so the "layers that are off"
      // line is measured with it explicitly off — that line is about the state,
      // not about which layer happens to be the default.
      const wasWind = state.mapWind;
      state.mapWind = false;
      const before = mapLegendHtml();
      state.mapWind = true; rerenderMapLegend();
      const windOn = document.getElementById('map-legend').innerHTML;
      state.mapWind = wasWind;
      state.mapLos = true; rerenderMapLegend();
      const losOn = document.getElementById('map-legend').innerHTML;
      state.mapLos = false; rerenderMapLegend();
      const heads = [...document.querySelectorAll('#map-display-block .map-display-h')].map(h => h.textContent.trim());
      return {
        offLine: /Also available/.test(before) && /Wind regions/.test(before) && /Line-of-sight/.test(before),
        windEntry: /Wind regions A–D/.test(windOn) && !/Also available[^<]*Wind regions/.test(windOn),
        // Every region is its own row now, with the speed and the pressure
        // ratio that make the letter mean something (#176) — the whole point of
        // the change, so it is asserted rather than left to the eye.
        windRows: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'C', 'D']
                    .every(r => new RegExp(`<strong>${r}</strong>`).test(windOn))
                  && /45 m\/s \(162 km\/h\)/.test(windOn)
                  && /80 m\/s \(288 km\/h\)/.test(windOn)
                  && /3\.2× Region A/.test(windOn)
                  && (windOn.match(/legend-wind-cyc/g) || []).length === 3,
        losEntry:  /Line of sight/.test(losOn) && /legend-line-los/.test(losOn)
                   && !/Also available[^<]*Line-of-sight/.test(losOn),
        heads,
      };
    });
    check('the legend names the optional layers that are off, and where to turn them on', legend.offLine);
    check('turning wind on gives it a legend entry and takes it off that line', legend.windEntry);
    check('the wind key lists all ten regions, with speeds and what they cost', legend.windRows);
    check('the same for line of sight', legend.losEntry);
    check('the 👁️ flyout is grouped under three headings',
      legend.heads.join('|') === 'Stations & links|Overlay layers|Labels & export', legend.heads.join(' | '));
    await fresh.context.close();

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
  log('\nPASS — the station card is the map\'s memory of what you were looking at, the\n'
    + '       callout is a signpost, and a phone gets a callout that fits.');
}

main().catch(err => { console.error(err); process.exit(1); });
