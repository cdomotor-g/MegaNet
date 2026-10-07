// MegaNet — route.js
//
// Route — where you are, in the address bar (#211).
//
// The address says which tab is open, which station's card is up, and where
// the Stations map is looking:
//
//   ?tab=stations&station=gatton_al&map=-27.55352,152.27911,13
//
// so a view can be bookmarked, sent to somebody and reloaded, and the
// browser's back and forward buttons move between tabs and stations instead
// of leaving the app. Until this, the address never changed: every link
// opened on Stations, a reload lost your place, and back left the site.
//
// Station Health names its station the same way (#218) —
//
//   ?tab=health&station=gatton_al
//
// — which is where a station card's health lines send you, so that view is
// an address too. The tab holds it until its week of readings has been worked
// out (Health.wantStation, Health.picked), and nothing else changes: a
// station picked there replaces the step rather than adding one.
//
// ── The query string, not the fragment ──────────────────────────────────────
// The site is behind Cloudflare Access, and a signed-out visitor is sent
// through a sign-in page that only ever sees the path and the query. A
// fragment is never sent to a server, so it cannot be handed back on the far
// side of a sign-in that involved typing a code — and a link sent to a
// colleague is exactly the link most likely to meet that page. The fragment
// stays with the three things that already use it, each of which removes its
// own: a Workbench case (`#wb…`, workbench.js), a base station's pairing code
// (`#pair=`, admin-tokens.js) and the sign-in callback (auth.js). Their
// parameters and anything else in the query are left as they were.
//
// ── What is a step you can go back from ─────────────────────────────────────
// A tab change and a station's card coming up are steps (pushState). The card
// closing and the map moving are not: they replace the step you are on, so
// back goes to where you were before rather than through every pan.
//
// ── With nothing in the address ─────────────────────────────────────────────
// The last tab used on this device opens, rather than always Stations. A link
// that names a station or a map view and no tab means the Stations tab. And a
// device that has never opened the app at all — no `mn-` key in its storage —
// opens on the Site Map, the app's own guide, once (#222): firstVisit() says
// so, and site-map.js greets them. A brand-new device that arrived by a link
// goes where the link says; newDevice() is true for both, and is what keeps
// What's new from announcing every change ever made to somebody who has just
// arrived (whats-new.js).
//
// ── Before the station list has arrived ─────────────────────────────────────
// A station and a view can only be shown on a map with stations on it, and
// the list arrives a few seconds after the first render. What the address
// asked for is held (`pending`) and kept in the address meanwhile — a reload
// or a copy during the load still carries it — and applied once by
// afterLoad(), which renderAfterLoad() calls when the list has been drawn.
//
// Nothing runs at load (init.js calls start()). Every write is wrapped: a
// browser that refuses history calls (some file:// contexts, a rate limit)
// gets an app that works and an address that does not follow it.
//
// Exposes: start, sync, tabChanged, stationShown, attach, afterLoad, read,
//          href, copyLink, newDevice, firstVisit.
// Requires: core.js (state, TAB_LIST, announce, copyToClipboard), app.js
//           (switchTab, showStationCard, closeStnCard), map-leader.js, and
//           health.js (Health.picked, Health.wantStation) — all at call time.

const Route = (() => {
  const TAB_KEY = 'mn-tab';           // the last tab used on this device
  const MAP_SETTLE_MS = 400;          // a pan writes once it has stopped

  let started = false;
  // > 0 while the address is being applied to the app: the switchTab(),
  // showStationCard() and setView() calls that does make must not write a new
  // address on the way through. One write follows, at the end.
  let applying = 0;
  // What the address asked for that needs the station list: { station, map }.
  let pending = null;
  let mapTimer = null;
  let rememberedTab = null;
  let newDevice = false;
  let firstVisit = false;

  const validTab = id => typeof id === 'string' && TAB_LIST.some(t => t.id === id);

  // "-27.55352,152.27911,13" → { lat, lng, z }, or null for anything that is
  // not a view on this planet.
  function parseMap(v) {
    if (!v) return null;
    const p = String(v).split(',');
    if (p.length !== 3) return null;
    const [lat, lng, z] = p.map(Number);
    if (![lat, lng, z].every(Number.isFinite)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || z < 0 || z > 24) return null;
    return { lat, lng, z };
  }
  // Five decimals is about a metre, which is all a view needs.
  const fmtMap = m => `${m.lat.toFixed(5)},${m.lng.toFixed(5)},${+m.z.toFixed(2)}`;
  // Commas left as commas: `map=-27.5,152.3,13` reads as a place, and the
  // query allows them.
  const enc = v => encodeURIComponent(v).replace(/%2C/gi, ',');

  // What the address says, checked: an unknown tab or a malformed view reads
  // as absent rather than as an instruction.
  function read() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (_) { q = new URLSearchParams(); }
    const tab = q.get('tab');
    return {
      tab: validTab(tab) ? tab : null,
      station: q.get('station') || null,
      map: parseMap(q.get('map')),
      // Whether the address names anything of ours at all, sound or not: a
      // link that does — even to a tab that has since gone — is a link, and
      // not a first visit.
      named: q.has('tab') || q.has('station') || q.has('map'),
    };
  }

  // The station Station Health has open, or is holding for its readings.
  const healthStation = () => (typeof Health !== 'undefined' && Health.picked ? Health.picked() : null);
  // …and the address handing it one (or none) to hold.
  const healthWant = id => { if (typeof Health !== 'undefined' && Health.wantStation) Health.wantStation(id); };

  // The Stations map's view, while there is one to give.
  function mapView() {
    if (state.activeTab !== 'stations' || !state.map) return null;
    try {
      const c = state.map.getCenter();
      return { lat: c.lat, lng: c.lng, z: state.map.getZoom() };
    } catch (_) { return null; }       // a map that has no view yet
  }

  // The address for where the app is now — or for `over`, where it names
  // something else (a link to a station from its card). Parameters this file
  // does not own keep their place and their spelling.
  function urlFor(over = {}) {
    const tab = over.tab !== undefined ? over.tab : state.activeTab;
    const mine = [];
    if (validTab(tab)) mine.push('tab=' + enc(tab));
    if (tab === 'stations') {
      const station = over.station !== undefined ? over.station
        : (state.stnCard.id || (pending && pending.station) || null);
      const map = over.map !== undefined ? over.map
        : (mapView() || (pending && pending.map) || null);
      if (station) mine.push('station=' + enc(station));
      if (map) mine.push('map=' + enc(fmtMap(map)));
    }
    if (tab === 'health') {
      const station = over.station !== undefined ? over.station : healthStation();
      if (station) mine.push('station=' + enc(station));
    }
    const theirs = (location.search || '').replace(/^\?/, '').split('&')
      .filter(p => p && !/^(tab|station|map)(=|$)/.test(p));
    const query = mine.concat(theirs).join('&');
    // A Workbench case in the fragment takes the app to the Workbench on a
    // reload (Workbench.restoreFromUrl), over whatever tab the query names —
    // so it goes when the Workbench is left. Any other fragment stays.
    let hash = location.hash || '';
    if (/^#wb/.test(hash) && tab !== 'workbench') hash = '';
    return location.pathname + (query ? '?' + query : '') + hash;
  }

  // One gesture, one step. "Go to station" from another tab (goToStation:
  // Pass Ranges, Station Health) switches the tab and then brings the card
  // up, in one go — two pushes, and back would stop at a Stations tab nobody
  // saw. A push in the same task as the last one rewrites that one instead.
  let pushedThisTask = false;

  function write(how) {
    if (!started || applying) return;
    const url = urlFor();
    if (url === location.pathname + location.search + location.hash) return;
    try {
      if (how === 'push' && !pushedThisTask) {
        history.pushState(null, '', url);
        pushedThisTask = true;
        Promise.resolve().then(() => { pushedThisTask = false; });
      } else {
        history.replaceState(null, '', url);
      }
    } catch (_) { /* refused — the app works on, the address stays put */ }
  }

  function rememberTab() {
    const id = state.activeTab;
    if (id === rememberedTab || !validTab(id)) return;
    rememberedTab = id;
    try { localStorage.setItem(TAB_KEY, id); } catch (_) {}
  }

  // The address made to agree with the app, in place: no new step. Called at
  // the end of every renderMain() and whenever the card closes.
  function sync() {
    if (!started || applying) return;
    rememberTab();
    write('replace');
  }

  // switchTab(), straight after the tab is set: a step.
  function tabChanged() {
    if (!started || applying) return;
    rememberTab();
    write('push');
  }

  // showStationCard(): a step, unless it is the station already named — a
  // second click on the same pin has nothing to go back to.
  function stationShown(id) {
    if (!started || applying) return;
    if (state.activeTab !== 'stations') return;
    if (read().station === id) { sync(); return; }
    write('push');
  }

  // initMap(), for every map it builds: the view follows the map once it has
  // stopped moving. The map is rebuilt on every render of the tab, and a
  // listener goes with the map it was put on.
  function attach(map) {
    map.on('moveend', () => {
      if (applying) return;
      clearTimeout(mapTimer);
      mapTimer = setTimeout(() => {
        mapTimer = null;
        if (map === state.map) sync();
      }, MAP_SETTLE_MS);
    });
  }

  // A station and a view, put on the Stations map. The station's card comes
  // up without selecting it — the address is what you were looking at, and
  // selecting is an editing step (the card's own pills do it). A view in the
  // address wins; without one the station is put where a picked row puts it.
  function applyStations(want) {
    if (state.activeTab !== 'stations' || !state.map || !state.data) return;
    const s = want.station ? state.data.stations.find(x => x.id === want.station) : null;
    applying++;
    try {
      if (s) {
        if (state.stnCard.id !== s.id) showStationCard(s.id, { opener: null });
      } else if (state.stnCard.id) {
        closeStnCard(false);
      }
      const now = mapView();
      if (want.map) {
        if (!now || fmtMap(now) !== fmtMap(want.map)) {
          state.map.setView([want.map.lat, want.map.lng], want.map.z, { animate: false });
        }
      } else if (s && s.lat != null && s.lon != null) {
        const z = Math.max(state.map.getZoom() || 0, 11);
        state.map.setView(MapLeader.centreFor(L.latLng(s.lat, s.lon), z), z, { animate: false });
      }
    } finally {
      applying--;
    }
    // A link to a station the list does not carry (deleted, renamed, a typo)
    // opens the map without it, and says so.
    if (want.station && !s) announce(`The station in this link (${want.station}) is not in the station list`);
  }

  // Back or forward.
  function onPop() {
    const want = read();
    let tab = want.tab || (want.station || want.map ? 'stations' : null);
    if (!tab && /^#wb/.test(location.hash || '')) tab = 'workbench';
    if (!tab) return;                 // a step from before the app named one
    // Before the switch, so the tab is drawn on the station the step named.
    if (tab === 'health') healthWant(want.station);
    if (tab !== state.activeTab) {
      applying++;
      try { switchTab(tab); } finally { applying--; }
    }
    if (tab === 'stations') {
      if (state.data && state.map) applyStations(want);
      else pending = (want.station || want.map) ? { station: want.station, map: want.map } : null;
    }
    sync();
  }

  // init.js, before the first render: the tab the app opens on, and what is
  // held for when the stations arrive.
  function start() {
    if (started) return;
    started = true;
    const want = read();
    let tab = want.tab;
    if (!tab && (want.station || want.map)) tab = 'stations';
    // A Workbench case shared without a tab (every link made before this file)
    // is a link to the Workbench.
    if (!tab && /^#wb/.test(location.hash || '')) tab = 'workbench';
    // Asked before anything below writes a key. Storage that refuses to be
    // read is not a new device: a browser that blocks it would otherwise be
    // greeted by the guide on every visit.
    let last = null;
    try {
      last = localStorage.getItem(TAB_KEY);
      newDevice = true;
      for (let i = 0; i < localStorage.length; i++) {
        if (String(localStorage.key(i)).startsWith('mn-')) { newDevice = false; break; }
      }
    } catch (_) { newDevice = false; }
    if (!tab && validTab(last)) tab = last;
    if (!tab && newDevice && !want.named && !location.hash) { tab = 'sitemap'; firstVisit = true; }
    if (tab) state.activeTab = tab;
    rememberedTab = validTab(state.activeTab) ? state.activeTab : null;
    if (state.activeTab === 'stations' && (want.station || want.map)) {
      pending = { station: want.station, map: want.map };
    }
    // Station Health holds a named station itself, until its week is in.
    if (state.activeTab === 'health' && want.station) healthWant(want.station);
    window.addEventListener('popstate', onPop);
    sync();
  }

  // renderAfterLoad(), once a station list has been drawn: what the address
  // asked for, once. Somebody who has gone to another tab while the list was
  // on its way has moved on from it, and it is dropped rather than sprung on
  // them when they come back.
  function afterLoad() {
    if (!started) return;
    const want = pending;
    pending = null;
    if (want && state.activeTab === 'stations') applyStations(want);
    sync();
  }

  // An absolute link to a station on the Stations map, at the view on screen
  // when it is the Stations tab.
  function href(stationId) {
    const path = urlFor({ tab: 'stations', station: stationId,
      map: state.activeTab === 'stations' ? (mapView() || undefined) : null });
    try { return new URL(path, location.href).href; } catch (_) { return path; }
  }

  // The station card's 🔗 Copy link. The label says what happened and puts
  // itself back, as Copy lat, lon's does.
  function copyLink(btn, stationId) {
    if (!btn) return;
    const prev = btn.textContent;
    const flash = (label, said) => {
      btn.textContent = label;
      announce(said);
      setTimeout(() => { if (btn.isConnected) btn.textContent = prev; }, 1600);
    };
    copyToClipboard(href(stationId)).then(ok => ok
      ? flash('✓ Copied', 'Copied a link to this station')
      : flash('✗ Copy failed', 'Could not copy the link to the clipboard'));
  }

  return { start, sync, tabChanged, stationShown, attach, afterLoad, read, href, copyLink,
           newDevice: () => newDevice, firstVisit: () => firstVisit };
})();
