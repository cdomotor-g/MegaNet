// The station card on the Stations map (#175), and the gold leader that joins
// it to its pin in place of the desktop callout (map-leader.js), driven in a
// real browser at two widths.
//
//   1. **The card** — bottom-left of the map, painted by a plain pin click
//      *without* selecting the station, by every row selection, and never by
//      anything passive once it has been closed. It is state, not popup DOM:
//      a filter keystroke rebuilds every marker, and the card has to still be
//      there afterwards. Station details ↓ on it is the first thing in the app
//      that scrolls the editor into view.
//   2. **The leader** — no callout on a desktop; a line out of the card's top
//      outline onto a ring round the pin, which follows the pin through a pan,
//      an animated zoom, a marker rebuild and a fanned-out stack, gives way
//      when the card covers its pin (and reveal() moves the pin out), goes
//      with the card, and pulses round a repeater a Repeaters listening row
//      moved the map to.
//   3. **One card at a time** — this card and the ACMA transmitter card share
//      one rectangle, and each closes the other. The radio-path card shared
//      it too until it moved into the path tools; it is held to staying out
//      of the exclusion now, since it is no longer over the map.
//   4. **The phone** — at 375 px the callout stays: the identity and two fat
//      pills, the close button finger-sized, and Details opens the card as a
//      sheet across the bottom of the map, with focus in it and its leader up
//      to a pin the sheet is not covering.
//   5. **Discoverability** — the one-time tip about the 🗺️ button, the legend
//      naming the layers that are off, and the flyout's group headings.
//
// Why a check of its own: every failure here renders a page that looks
// entirely correct. A card that dies with a filter keystroke, a pin click that
// quietly starts selecting, a close that hands focus to <body>, two cards drawn
// on top of each other, a leader left pointing at where a pin was before the
// map moved — none of them is an error in the console, and smoke sees a clean
// tab. A phone callout wider than the map is the one the operator finds in a
// paddock, which is the worst place to find it.
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
// pixels with another fans the stack out (MapSpider) instead of opening
// anything — which is right, and is tested on its own below. Evaluated in the
// page; returns the marker.
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

// Where the leader is, measured against what it is supposed to join: the
// card's top outline at one end, a ring centred on the pin at the other.
// Evaluated in the page; null when no leader is drawn. `onTop` allows the
// card's rounded corner (8 px) — the anchor goes round it towards a pin
// beside the card — and a pixel of rounding.
const leaderFit = `(() => {
  const g = MapLeader.geometry();
  if (!g) return null;
  const id = state.stnCard.id;
  const m = state.mapMarkers.find(x => x.mnStationId === id);
  const p = state.map.latLngToContainerPoint(m ? m.getLatLng() : L.latLng(0, 0));
  const c = document.getElementById('stn-card').getBoundingClientRect();
  const k = state.map.getContainer().getBoundingClientRect();
  const box = { left: c.left - k.left, top: c.top - k.top, right: c.right - k.left, bottom: c.bottom - k.top };
  const onTop = !!g.from && g.from.y >= box.top - 1 && g.from.y <= box.top + 9
    && g.from.x >= box.left - 1 && g.from.x <= box.right + 1;
  const toRing = g.to ? Math.hypot(g.to.x - g.ring.x, g.to.y - g.ring.y) : null;
  return {
    id: g.id, want: id, onTop, from: g.from, ring: g.ring, pin: { x: p.x, y: p.y }, box,
    atPin: Math.hypot(g.ring.x - p.x, g.ring.y - p.y) < 1.5,
    endsOnRing: toRing != null && Math.abs(toRing - g.ring.r) < 1.5,
    crown: document.getElementById('stn-card').classList.contains('mn-leader-card'),
  };
})()`;

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
      const pinBefore = state.map.latLngToContainerPoint(m.getLatLng());
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
        pinBefore: { x: pinBefore.x, y: pinBefore.y },
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
    check('no callout opens on a desktop — the card says it all', !clicked.popupToo);

    log('\nThe leader joins the card to its pin\n');

    // lonePin centres the pin, and the card can open over the middle of a
    // narrow map — beside the side panel at this width it does. When it does,
    // reveal() pans the pin out from under it; the pan is animated, so the
    // leader is measured once it is over.
    await page.waitForFunction(() => !(state.map._panAnim && state.map._panAnim._inProgress),
      null, { timeout: 5000 });
    await page.waitForTimeout(50);
    const lead = await page.evaluate(leaderFit);
    if (lead) {
      const under = clicked.pinBefore.x < lead.box.right && clicked.pinBefore.x > lead.box.left
        && clicked.pinBefore.y > lead.box.top;
      check(under ? 'the card opened over its pin, and the map moved the pin out from under it'
                  : 'the card opened clear of its pin, and the map stayed where it was',
        under ? lead.pin.x > lead.box.right
              : Math.hypot(lead.pin.x - clicked.pinBefore.x, lead.pin.y - clicked.pinBefore.y) < 1,
        JSON.stringify({ before: clicked.pinBefore, after: lead.pin, box: lead.box }));
    }
    check('a leader is drawn for the station the card is on',
      !!lead && lead.id === lead.want, lead ? `${lead.id} vs ${lead.want}` : 'no leader');
    check('out of the card\'s top outline', !!lead && lead.onTop,
      lead ? `from ${JSON.stringify(lead.from)}, card ${JSON.stringify(lead.box)}` : '');
    check('onto a ring centred on the pin, the line ending at the ring',
      !!lead && lead.atPin && lead.endsOnRing,
      lead ? `ring ${JSON.stringify(lead.ring)} pin ${JSON.stringify(lead.pin)}` : '');
    check('and the card\'s top edge goes gold with it', !!lead && lead.crown);

    // A pin above the card's straight top edge is reached straight up out of
    // it; one beside the card, round the corner and never out of its side.
    const shape = await page.evaluate(`(() => {
      const card = document.getElementById('stn-card').getBoundingClientRect();
      const k = state.map.getContainer().getBoundingClientRect();
      const m = state.mapMarkers.find(x => x.mnStationId === state.stnCard.id);
      const put = (x, y) => {
        const p = state.map.latLngToContainerPoint(m.getLatLng());
        state.map.panBy([p.x - x, p.y - y], { animate: false });
        return MapLeader.geometry();
      };
      const midX = (card.left + card.right) / 2 - k.left, top = card.top - k.top;
      const above = put(midX, Math.max(30, top - 60));
      const beside = put(card.right - k.left + 160, top + 200);
      return { above, beside, top, right: card.right - k.left };
    })()`);
    check('a pin above the card is reached straight up out of its top edge',
      !!shape.above && Math.abs(shape.above.from.y - shape.top) < 1
        && Math.abs(shape.above.from.x - shape.above.to.x) < 1,
      JSON.stringify(shape.above));
    check('a pin beside and below its top is reached from the top corner, not the side',
      !!shape.beside && shape.beside.from.y <= shape.top + 9 && shape.beside.from.x >= shape.right - 9,
      JSON.stringify(shape.beside));

    // Dragging the map moves the pin under a card that stays where it is: the
    // ring goes with the pin, and the line still starts on the card.
    const panned = await page.evaluate(`(() => {
      const before = MapLeader.geometry();
      state.map.panBy([90, -40], { animate: false });
      const fit = ${leaderFit};
      return { before, fit };
    })()`);
    check('a pan takes the ring with the pin, the line still out of the card',
      !!panned.fit && panned.fit.atPin && panned.fit.onTop
        && Math.abs(panned.fit.ring.x - (panned.before.ring.x - 90)) < 1.5
        && Math.abs(panned.fit.ring.y - (panned.before.ring.y + 40)) < 1.5,
      JSON.stringify(panned));

    // Under the card there is nowhere for a line to go: it is not drawn, and
    // reveal() moves the map until the pin is out from under it.
    const covered = await page.evaluate(`(() => {
      const card = document.getElementById('stn-card').getBoundingClientRect();
      const k = state.map.getContainer().getBoundingClientRect();
      const m = state.mapMarkers.find(x => x.mnStationId === state.stnCard.id);
      const p = state.map.latLngToContainerPoint(m.getLatLng());
      const x = (card.left + card.right) / 2 - k.left, y = (card.top + card.bottom) / 2 - k.top;
      state.map.panBy([p.x - x, p.y - y], { animate: false });
      return { under: MapLeader.geometry() === null };
    })()`);
    check('a pin under the card gets no leader', covered.under);
    await page.evaluate(() => MapLeader.reveal());
    await page.waitForTimeout(450);          // the pan is animated
    const revealed = await page.evaluate(leaderFit);
    check('and reveal() moves the map until it is clear, and the leader is back',
      !!revealed && revealed.atPin && revealed.onTop
        && revealed.pin.x > revealed.box.right,
      revealed ? JSON.stringify({ pin: revealed.pin, box: revealed.box }) : 'still covered');

    // Leaflet's animated zoom fires nothing until it is over, and the pins are
    // scaled by a CSS transition meanwhile. The leader walks its end along
    // with them rather than vanishing, and lands on the pin.
    const zoomed = await page.evaluate(async () => {
      const seen = [];
      let raf = true;
      const tick = () => { seen.push(MapLeader.geometry()); if (raf) requestAnimationFrame(tick); };
      const done = new Promise(r => state.map.once('zoomend', r));
      requestAnimationFrame(tick);
      state.map.setZoom(state.map.getZoom() + 1);
      await done;
      await new Promise(r => setTimeout(r, 60));
      raf = false;
      return { frames: seen.length, gaps: seen.filter(g => !g).length,
        rings: seen.filter(Boolean).map(g => g.ring.x) };
    });
    const zoomFit = await page.evaluate(leaderFit);
    const moved = new Set(zoomed.rings.map(x => Math.round(x))).size;
    check('through an animated zoom the leader stays drawn, moving with the pin',
      zoomed.frames >= 5 && zoomed.gaps === 0 && moved >= 3,
      `${zoomed.frames} frames, ${zoomed.gaps} without a leader, ${moved} ring positions`);
    check('and lands on the pin when the zoom ends', !!zoomFit && zoomFit.atPin,
      zoomFit ? JSON.stringify({ ring: zoomFit.ring, pin: zoomFit.pin }) : 'no leader');

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
      // The actions are groups of pills since the row grew rules between them
      // — the section's children are the rows, the pills are one level down.
      const groups = acts ? [...acts.children] : [];
      const kids = acts ? [...acts.querySelectorAll('.pill')] : [];
      return {
        position:   rowVal('Position'), want: stationLatLonText(s),
        stn:        s.station_number ? rowVal('Stn #') === String(s.station_number) : null,
        // The height, plus "modelled" exactly when the figure is modelled
        // (#198). 2,330 of the 3,176 carry an elevation_source now, and the
        // whole point of that column is that the card does not let a modelled
        // height read as a surveyed one — so this checks the marker is there
        // when it should be and absent when it should not.
        elev:       s.elevation_ahd == null ? null : (() => {
                      const v = rowVal('Elevation');
                      const base = v.startsWith(`${s.elevation_ahd} m AHD`);
                      return base && /modelled/.test(v) === !!s.elevation_source;
                    })(),
        elevRaw:    rowVal('Elevation'),
        elevSrc:    s.elevation_source || null,
        ids:        /AlertID/.test(text) && stationAlertIds(s).every(id => text.includes(String(id))),
        wind:       !!wind && wind.dataset.mnWind === `${s.lat},${s.lon}`,
        allPills:   kids.length > 0 && groups.every(g => g.classList.contains('pill-row')
                    && [...g.children].every(e => e.classList.contains('pill'))),
        grouped:    groups.length > 1 && groups.every(g =>
                    g.getAttribute('role') === 'group' && !!g.getAttribute('aria-label')),
        iconed:     kids.every(e => /^\p{Extended_Pictographic}/u.test(e.textContent.trim())),
        // Two pairs, in this order: the two ways to stand on the ground, then
        // the two Google Earth errands.
        imagery:    (() => {
          const g = groups.find(x => x.getAttribute('aria-label') === 'Imagery and terrain');
          return g ? [...g.children].map(e => e.textContent.trim().replace(/^\S+\s/, '')) : [];
        })(),
        field:      !!acts.querySelector('.mn-field-data'),
        editFirst:  kids[0] && kids[0].classList.contains('mn-edit-station')
                    && kids[0].tagName === 'BUTTON' && kids[0].type === 'button',
        hasCopy:    !!acts.querySelector('.mn-copy-latlon'),
        // "Show in the list ↓" under the map, "…→" with the cards in the side
        // panel — the arrow says which, so the name is matched without it.
        hasList:    kids.some(e => /Show in the list/.test(e.textContent.trim())),
        count:      kids.length, expect: stationActionGroups(s).flatMap(g => g.pills).length,
        footer:     /Pin clicks show this card without changing the selection/.test(text),
        carried:    findRepeaterMatches(s).length,
        saysCarried: /Carried by \d+ repeater/.test(text),
        // The jump to Repeaters listening, by what it does: the card has other
        // link buttons now — its health lines (#218) — so "any .link-btn" no
        // longer means this one.
        noJump:     !card.querySelector('button[onclick^="stnCardScrollToCarriers"]'),
      };
    });
    check('the card carries the position, as the same figure Copy hands over',
      rows.position === rows.want, `${rows.position} vs ${rows.want}`);
    check('the station number and elevation, where the station has them',
      rows.stn !== false && rows.elev !== false,
      `elevation row: "${rows.elevRaw}"  source: ${rows.elevSrc}`);
    check('every ALERT id, and the wind region under its own element id',
      rows.ids && rows.wind);
    check('every action is a pill, Station details first', rows.allPills && rows.editFirst);
    check('in named groups, each its own row — the rules a sighted reader sees',
      rows.grouped);
    check('and every one of them opens with an icon', rows.iconed);
    check('the imagery group is the two street views, then the two Google Earths',
      rows.imagery.join(' | ') === 'Google Street View ↗ | Apple Maps ↗ | Google Earth KML ⬇ | Google Earth ↗',
      rows.imagery.join(' | '));
    check('and a station with a position offers Field data', rows.field);
    check('and the rows together are every action the station offers, no more and no less',
      rows.hasCopy && rows.hasList && rows.count === rows.expect,
      `${rows.count} vs ${rows.expect}`);
    check('the footer says what a pin click does and does not do', rows.footer);
    check('a carried station says how many repeaters carry it',
      rows.carried === 0 || rows.saysCarried, `${rows.carried} carrier(s)`);
    check('but offers no jump to a card that is not drawn for an unselected station', rows.noJump);

    log('\nIt outlives the markers\n');

    // A filter change rebuilds every marker. The card is not Leaflet's, and is
    // still there — and its leader lets go of the pin that was destroyed and
    // finds the one that replaced it.
    const survived = await page.evaluate(async () => {
      const s = state.data.stations.find(x => x.id === state.stnCard.id);
      const old = state.mapMarkers.find(x => x.mnStationId === s.id);
      state.filters.searches = [newSearchRow(s.name.slice(0, 3))];
      stationsFilterChanged();
      await new Promise(r => setTimeout(r, 450));
      await new Promise(r => state.map._animatingZoom ? state.map.once('zoomend', r) : r());
      const now = state.mapMarkers.find(x => x.mnStationId === s.id);
      // The fit to the new matches may have put the pin under the card; the
      // view a row selection would take (centreFor) puts it clear again.
      const z = state.map.getZoom();
      state.map.setView(MapLeader.centreFor(now.getLatLng(), z), z, { animate: false });
      // The new marker is the one followed: moved the way a fan moves a pin,
      // the ring goes with it. A leader still holding the destroyed marker
      // would hear nothing.
      const home = now.getLatLng();
      const p = state.map.latLngToContainerPoint(home);
      now.setLatLng(state.map.containerPointToLatLng([p.x + 40, p.y - 30]));
      const g = MapLeader.geometry();
      const q = state.map.latLngToContainerPoint(now.getLatLng());
      now.setLatLng(home);
      return {
        rebuilt:   !!now && now !== old,
        cardThere: !document.getElementById('stn-card').hidden,
        title:     document.getElementById('stn-card-title').textContent.trim(),
        name:      s.name,
        follows:   !!g && Math.hypot(g.ring.x - q.x, g.ring.y - q.y) < 1.5,
        ring:      g && g.ring, want: { x: q.x, y: q.y },
      };
    });
    check('a filter change rebuilds the markers and leaves the card, still on the same station',
      survived.rebuilt && survived.cardThere && survived.title === survived.name);
    check('and its leader follows the new pin, not the destroyed one',
      survived.follows, `ring ${JSON.stringify(survived.ring)} vs pin ${JSON.stringify(survived.want)}`);
    await page.evaluate(() => { resetStationFilters(); stationsFilterChanged(); });
    await page.waitForTimeout(450);

    log('\nStation details ↓ selects, and is the first thing that scrolls to the editor\n');

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
      offered: !!document.querySelector('#stn-card button[onclick^="stnCardScrollToCarriers"]'),
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
      const leaderGone = MapLeader.geometry() === null
        && getComputedStyle(document.querySelector('.mn-leader')).display === 'none';
      rerenderStationEditorCard();          // a repaint hook, with a selection still set
      return {
        hidden:  document.getElementById('stn-card').hidden,
        idNull:  state.stnCard.id === null,
        leaderGone,
        stillHidden: document.getElementById('stn-card').hidden,
        stillNoLeader: MapLeader.geometry() === null,
      };
    });
    check('× closes the card and forgets the station', closed.hidden && closed.idNull);
    check('and takes the leader with it', closed.leaderGone);
    check('and nothing passive brings either back', closed.stillHidden && closed.stillNoLeader);

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
        showStationCard(s.id);
        MapBackbone.open('field', pair[0].id, pair[1].id);
        out.pathOffMap = !document.querySelector('.mn-map-stage #path-card')
          && !!el('path-card').closest('#stations-path-cards');
        out.pathKeepsStn = !el('stn-card').hidden && !el('path-card').hidden;
        showAcmaCard('no-such-device');
        out.acmaKeepsPath = !el('path-card').hidden && !el('acma-card').hidden;
        MapBackbone.open('field', pair[0].id, pair[1].id);
        out.pathKeepsAcma = !el('acma-card').hidden && !el('path-card').hidden;
        MapBackbone.closeCard();
      } else {
        out.pathOffMap = out.pathKeepsStn = out.acmaKeepsPath = out.pathKeepsAcma = 'no pair';
      }
      closeAcmaCard();
      return out;
    });
    check('the ACMA card closes the station card on its way open', excl.acmaHidesStn);
    check('and the station card closes the ACMA card', excl.stnHidesAcma);
    check('the radio path card is in the path tools, not over the map', excl.pathOffMap === true,
      String(excl.pathOffMap));
    check('…so opening it leaves the station card open', excl.pathKeepsStn === true, String(excl.pathKeepsStn));
    check('…and it and the ACMA card no longer close each other',
      excl.acmaKeepsPath === true && excl.pathKeepsAcma === true,
      `${excl.acmaKeepsPath} / ${excl.pathKeepsAcma}`);

    log('\nA row selection paints it too — the keyboard\'s way onto the map\n');

    const fromRow = await page.evaluate(async () => {
      const other = state.data.stations.filter(x => x.lat != null && x.id !== state.selectedId)[3];
      selectStation(other.id);
      // The view change may be an animated zoom; the leader is measured once
      // the map has arrived.
      await new Promise(r => state.map._animatingZoom ? state.map.once('zoomend', r) : r());
      await new Promise(r => setTimeout(r, 300));
      return {
        title: document.getElementById('stn-card-title').textContent.trim(),
        name:  other.name,
        popup: !!document.querySelector('.leaflet-popup'),
      };
    });
    const rowLead = await page.evaluate(leaderFit);
    check('selecting a row paints the card for that station', fromRow.title === fromRow.name);
    check('and points at its pin with the leader — no callout, at any width',
      !fromRow.popup && !!rowLead && rowLead.atPin && rowLead.onTop,
      rowLead ? `popup=${fromRow.popup} ${JSON.stringify({ ring: rowLead.ring, pin: rowLead.pin })}` : `popup=${fromRow.popup}, no leader`);
    check('with the pin put clear of the card, where the leader can reach it',
      !!rowLead && rowLead.pin.x > rowLead.box.right, rowLead ? JSON.stringify({ pin: rowLead.pin, box: rowLead.box }) : '');

    // From the keyboard: Enter on a row's button. The table repaints under
    // the keyboard and used to drop focus to <body>; it finds the row again,
    // and the card's Escape returns to it.
    await page.evaluate(() => { state.map.closePopup(); closeStnCard(false); });
    // A row that is not the selected one — Enter on that would deselect.
    const rowSid = await page.evaluate(() => [...document.querySelectorAll('#stations-table-wrap tr[data-sid]')]
      .find(tr => tr.dataset.sid !== state.selectedId).dataset.sid);
    const rowBtn = page.locator(`#stations-table-wrap tr[data-sid="${rowSid}"] button`).first();
    // The radio path clicked above brought the link budget up, and beside the
    // map that is the side panel's 〽️ pane, with the list under 📍 hidden — a
    // row there cannot take focus. So the list's pane comes up first, as 📍
    // would bring it.
    await page.evaluate(sid => dockReveal(document.querySelector(`#stations-table-wrap tr[data-sid="${sid}"]`)), rowSid);
    await rowBtn.focus();
    await page.keyboard.press('Enter');
    const keyed = await page.evaluate(sid => {
      // The pick shuts the list (pickStationFromList), so focus goes to the
      // list's toggle rather than a row it hides.
      const toggle = document.getElementById('stations-list-toggle');
      const out = { kept: document.activeElement === toggle, selected: state.selectedId === sid,
        shut: document.getElementById('stations-list-body').hidden,
        card: !document.getElementById('stn-card').hidden };
      document.getElementById('stn-card').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.backOnRow = document.activeElement === toggle;
      setStationsListOpen(true);
      return out;
    }, rowSid);
    check('Enter on a row selects it, shuts the list and keeps focus on the list\'s toggle',
      keyed.kept && keyed.selected && keyed.shut && keyed.card, JSON.stringify(keyed));
    check('and Escape on the card returns to that toggle', keyed.backOnRow);

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
      blast.none || (blast.armed && blast.label === '💥 Hide blast radius'), blast.label);
    check('with the keyboard still on it through the repaint', blast.none || blast.focused);
    check('and disarming puts the label back',
      blast.none || blast.backLabel === '💥 Show blast radius', blast.backLabel);

    // "Field data →" is the third door into the Field Data tab, after the
    // picker itself and the Message Log's per-address one — and the first that
    // starts from a station. The datastore is blocked by the network policy, so
    // what is asserted here is the handoff: the tab changes, the picker lands on
    // this station, and its addressable sensors are ticked. What happens to the
    // query after that is `npm run fieldprobe`'s subject.
    const toField = await page.evaluate(async () => {
      const s = state.data.stations.find(x =>
        x.lat != null && ArroData.fieldAddrs(x).length > 0) || state.data.stations[0];
      showStationCard(s.id);
      const pill = document.querySelector('#stn-card .mn-field-data');
      const label = pill && pill.textContent.trim();
      pill.click();
      await new Promise(r => setTimeout(r, 120));
      const q = ArroData.ad.fq;
      return {
        label, tab: state.activeTab, source: ArroData.ad.source,
        id: q && q.stationId, want: s.id,
        ticked: q ? q.sensors.length : 0, addrs: ArroData.fieldAddrs(s).length,
        probeBlock: !!document.querySelector('#ad-side .ad-field-probe'),
      };
    });
    check('Field data → is on the card, with its own icon',
      toField.label === '🌡️ Field data →', toField.label);
    check('and it opens the Field Data tab, on that station',
      toField.tab === 'field' && toField.source === 'field' && toField.id === toField.want,
      `${toField.tab}/${toField.source} ${toField.id} vs ${toField.want}`);
    check('with every address it can be reached on already ticked',
      toField.ticked === toField.addrs && toField.ticked > 0,
      `${toField.ticked} of ${toField.addrs}`);
    check('and the datastore block drawn under them', toField.probeBlock);

    await page.evaluate(() => { switchTab('stations'); });
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: 20_000 });
    await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: 10_000 });

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

    log('\nA pin picked out of a fanned stack keeps its leader\n');

    // Two stations a few metres apart share a pin's pixels: the first click
    // fans them out, the second picks one, and the leader runs to where the
    // pick is *fanned out to*. The pointer then goes to the far side of the
    // map — on its way to the card — and the fan holds, because folding it
    // would take the pin the card is on back into the stack.
    const fan = await page.evaluate(async () => {
      const all = state.data.stations.filter(x => x.lat != null && x.lon != null)
        .sort((a, b) => a.lat - b.lat);
      let a = null;
      for (let i = 0; i < all.length - 1 && !a; i++) {
        for (let j = i + 1; j < all.length && all[j].lat - all[i].lat < 0.0003; j++) {
          if (Math.abs(all[j].lon - all[i].lon) < 0.0003 && (all[j].lat !== all[i].lat || all[j].lon !== all[i].lon)) {
            a = all[i]; break;
          }
        }
      }
      if (!a) return { none: true };
      closeStnCard(false);
      const m = state.mapMarkers.find(x => x.mnStationId === a.id);
      state.map.setView([a.lat, a.lon], 15, { animate: false });
      const card = document.getElementById('stn-card').getBoundingClientRect();
      const k = state.map.getContainer().getBoundingClientRect();
      const p = state.map.latLngToContainerPoint([a.lat, a.lon]);
      state.map.panBy([p.x - (card.right - k.left + 220), 0], { animate: false });
      const fire = () => m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
      const fans = MapSpider.willFan(m);
      fire();
      const cardAfterFan = !document.getElementById('stn-card').hidden;
      fire();
      await new Promise(r => setTimeout(r, 350));
      const g = MapLeader.geometry();
      const q = state.map.latLngToContainerPoint(m.getLatLng());
      return {
        id: a.id, fans, cardAfterFan,
        fanned: Math.abs(m.getLatLng().lat - a.lat) > 1e-7 || Math.abs(m.getLatLng().lng - a.lon) > 1e-7,
        onPick: !!g && g.id === a.id && Math.hypot(g.ring.x - q.x, g.ring.y - q.y) < 1.5,
        far: { x: k.left + k.width - 30, y: k.top + k.height - 30 },
      };
    });
    if (fan.none) {
      check('(no two stations close enough to stack — the fan checks are skipped)', true);
    } else {
      check('the first click on a stack fans it and paints no card', fan.fans && !fan.cardAfterFan);
      check('the second picks a pin, and the leader runs to where it is fanned out to',
        fan.fanned && fan.onPick, JSON.stringify(fan));
      await page.mouse.move(fan.far.x, fan.far.y);
      await page.waitForTimeout(150);
      const held = await page.evaluate(id => {
        const s = state.data.stations.find(x => x.id === id);
        const m = state.mapMarkers.find(x => x.mnStationId === id);
        const stillOut = Math.abs(m.getLatLng().lat - s.lat) > 1e-7 || Math.abs(m.getLatLng().lng - s.lon) > 1e-7;
        // A click on the empty map folds the fan; the pin goes home and the
        // leader goes with it.
        state.map.fire('click', { latlng: state.map.getCenter(), originalEvent: new MouseEvent('click') });
        const g = MapLeader.geometry();
        const q = state.map.latLngToContainerPoint([s.lat, s.lon]);
        return { stillOut, home: !!g && Math.hypot(g.ring.x - q.x, g.ring.y - q.y) < 1.5 };
      }, fan.id);
      check('the pointer leaving the fan does not fold it while the card is on the pick', held.stillOut);
      check('and when the fan folds, the leader follows the pin home', held.home);
    }

    log('\nA Repeaters listening row pulses the pin it moved the map to\n');

    // The row moves the view and not the card, so the pin is pointed at with a
    // ping in the leader's gold — two pulses and gone — and no callout.
    const pinged = await page.evaluate(async () => {
      setMapFocusRepeater(null);
      const r = state.data.stations.find(x => x.roles.includes('repeater') && x.lat != null
        && state.mapMarkers.some(m => m.mnStationId === x.id));
      const before = state.stnCard.id;
      focusRepeaterOnMap(r.id);
      await new Promise(res => state.map._animatingZoom ? state.map.once('zoomend', res) : res());
      await new Promise(res => setTimeout(res, 300));
      const m = state.mapMarkers.find(x => x.mnStationId === r.id);
      const q = state.map.latLngToContainerPoint(m.getLatLng());
      const c = document.querySelector('.mn-leader-ping circle');
      return {
        ping:  !!c,
        atPin: !!c && Math.hypot(+c.getAttribute('cx') - q.x, +c.getAttribute('cy') - q.y) < 1.5,
        popup: !!document.querySelector('.leaflet-popup'),
        cardSame: state.stnCard.id === before,
      };
    });
    check('a ring pulses round the repeater\'s pin, and no callout opens',
      pinged.ping && pinged.atPin && !pinged.popup, JSON.stringify(pinged));
    check('and the card stays on the station it was on', pinged.cardSame);
    await page.waitForTimeout(2400);
    check('two pulses, and it is gone',
      await page.evaluate(() => !document.querySelector('.mn-leader-ping')));

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

    // The sheet comes up over the bottom half of the map, which is often
    // where the tapped pin is: the map moves it up clear, and the leader
    // stands up out of the sheet's top edge to it.
    await pp.waitForTimeout(450);
    const sheetLead = await pp.evaluate(leaderFit);
    check('the sheet\'s leader runs up out of its top edge to the pin, clear above it',
      !!sheetLead && sheetLead.atPin && sheetLead.onTop && sheetLead.pin.y < sheetLead.box.top,
      sheetLead ? JSON.stringify({ from: sheetLead.from, ring: sheetLead.ring, box: sheetLead.box }) : 'no leader');

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
    await pp.waitForTimeout(450);
    const followLead = await pp.evaluate(leaderFit);
    check('and the leader moves to the new pin with it',
      !!followLead && followLead.id === followLead.want && followLead.atPin,
      followLead ? JSON.stringify({ id: followLead.id, want: followLead.want }) : 'no leader');

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
    // …and told where it is: at this width the 🗺️ is in the side panel's
    // strip, not on the map, and a tip pointing at the map would send the
    // operator looking for a button that is not there.
    check('a first visit is told about the 🗺️ button, where it is, once',
      tip.shown && /🗺️/.test(tip.text) && /layers/.test(tip.text) && /side panel/.test(tip.text)
        && !/on the map/.test(tip.text) && tip.seen === '1',
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
    // Four since #186 — "Link colour" joined them when the fade-margin switch
    // became one of three radio buttons and the frequency colouring the default
    // — and five since the base maps stopped being a panel of their own and
    // became the first section of this one.
    check('the 🗺️ flyout is grouped under five headings, base maps first',
      legend.heads.join('|') === 'Base maps|Stations & links|Link colour|Overlay layers|Labels & export',
      legend.heads.join(' | '));
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
  log('\nPASS — the station card is the map\'s memory of what you were looking at, a gold\n'
    + '       leader joins it to its pin wherever the pin goes, and a phone gets a\n'
    + '       callout that fits.');
}

main().catch(err => { console.error(err); process.exit(1); });
