// MegaNet — station-trail.js
//
//   StationTrail   the stations looked at this session, as a pill in the top
//                  row of the Stations map: it names the station the card was
//                  last on, brings the card back once it has been closed, and
//                  drops down every station looked at since this tab was
//                  opened — the latest first — each a way straight back to it.
//
// After core.js, app.js, map-leader.js and map-twin.js, before init.js —
// index.html holds the order and the reasons. Reaches back to core.js for
// `state`, esc, escAttr, announce and ROLE_COLOR; to app.js for the station
// card (showStationCard) and the selection (selectStationState,
// rerenderStations, rerenderStationEditorCard, renderMain); to map-leader.js
// for the centre that keeps a pin clear of the card; and to map-twin.js for
// whether the twin has the map's rectangle. Every one of those is a runtime
// call from inside this file's own functions, so its position among the
// modules is free. Nothing executes at load (`npm run toplevel`).
//
// ── What it is for ─────────────────────────────────────────────────────────
//
// The station card is the map's memory of what you were looking at, and
// closing it is a decision that holds: nothing passive brings it back (app.js,
// "The station card"). Nothing active did either, short of finding the pin
// again — at zoom 6 one pin in thousands, and in the twin not a pin at all.
// The pill is the way back: it names the station the card was last on, and
// pressing it puts that card up again.
//
// The same press drops the trail down under it: every station looked at this
// session, the one looked at last first, each a button that goes back to it —
// the map moves there, zoomed in, the station is selected as its row in the
// list selects it, and its card comes up. A station is looked at when its card
// is shown (a pin, a row, a path's far end, What is here, a pin in 3-D), when
// its twin is opened, and on a phone when its pin is tapped for the callout.
// Looking at one again moves it back to the top, so the order is always the
// order of the last look, and going back and forth between two stations keeps
// both at the head of the list.
//
// ── Where it stands ────────────────────────────────────────────────────────
//
// In the top row of the viewing window, beside whatever holds its top-left
// corner, since it folds to one row and nothing else there does: on the map
// (and in ⛰️ 3-D, whose controls are the map's) right of the zoom buttons; in
// the twin, whose zoom corner stands down, right of the flood scale at the top
// of the stage. The scale stays where it was. It is the scale's *column* the
// pill stands beside rather than the scale itself, so the pill does not move
// as the water comes and goes, or as the scale's reading changes width.
//
// It is a child of the map's stage (.mn-map-stage), not of the Leaflet
// container and not of the twin's overlay, for the station card's reason: its
// list drops down over the card, and inside the overlay it would be painted
// under it (the card is lifted over the twin, styles.css). So it cannot stand
// in the twin's stage by the stylesheet alone. place() measures where the
// corner's control is — the zoom buttons, or the twin's stage — and hands the
// numbers over as custom properties; styles.css does the rest. In the twin the
// card's top is kept below the pill's row (--stn-trail-foot, on the stage), so
// the one never covers the other.
//
// ── What it keeps ──────────────────────────────────────────────────────────
//
// The ids, in sessionStorage: this tab's session, which a reload keeps and
// closing the tab forgets — which is what "this session" means. Not
// localStorage: last week's trail is not a trail, it is a history nobody asked
// to keep. The newest MAX, the oldest going first. A station that is not in
// the loaded file (deleted, or another file loaded) is left out of what is
// shown and kept in the list, so it is back where it was if the file comes
// back.
const StationTrail = (function () {
  const KEY     = 'mn-stn-trail';
  const MAX     = 100;
  // How far in a pick from the list goes, at least: a few kilometres across,
  // the station and what is round it, and past the zoom from which a station
  // under the view has its twin's ground fetched ahead (MapTwin.prefetchZoom).
  // Closer already stays as close; in the twin it stays in the twin.
  const ZOOM_IN = 15;
  const GAP     = 8;       // px: --sp-2, the gap every control on the map keeps
  const DROP_REM = 19;     // the list's width, where the map has it: a long name and its number

  let ids     = null;      // station ids, the latest first; read on first use
  let root    = null;      // the pill and its list, while the Stations map is up
  let stage   = null;      // the .mn-map-stage it stands over
  let open    = false;     // the list is down
  let ro      = null;      // re-places it as the map and the twin's stage resize
  let watched = null;      // the twin's stage, while ro is watching it

  function load() {
    if (ids) return ids;
    ids = [];
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      if (Array.isArray(v)) ids = v.filter(x => typeof x === 'string' && x).slice(0, MAX);
    } catch (_) { /* private mode, or a value this file did not write */ }
    return ids;
  }

  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(ids)); } catch (_) { /* see load() */ }
  }

  function stations() {
    return (typeof state !== 'undefined' && state.data && state.data.stations) || [];
  }

  // The trail as it can be shown: the stations in the loaded file, in order.
  function shown() {
    const list = load();
    if (!list.length) return [];
    const byId = new Map(stations().map(s => [s.id, s]));
    return list.map(id => byId.get(id)).filter(Boolean);
  }

  function located(s) { return !!s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon); }

  function cardOn(id) { return !!(state.stnCard && state.stnCard.id === id); }

  function twinUp() { return typeof MapTwin !== 'undefined' && !!MapTwin.active && MapTwin.active(); }

  function pill() { return root && root.querySelector('.stn-trail-pill'); }
  function drop() { return root && root.querySelector('.stn-trail-drop'); }

  // ── Where it stands ────────────────────────────────────────────────────────
  // The twin's stage, while the twin has the map's rectangle.
  function twinStage() {
    if (!stage || !twinUp()) return null;
    return stage.querySelector('#map-twin.is-on #twin-stage');
  }

  function px(v) { return `${Math.max(0, Math.round(v))}px`; }

  function place() {
    if (!root || !stage || root.hidden) return;
    const s = stage.getBoundingClientRect();
    if (!s.width || !s.height) return;
    const tw = twinStage();
    // The twin's stage is rebuilt with every station it is opened for, and
    // moves down the map as the lines over it unfold: watched while it is up.
    if (ro && tw !== watched) {
      if (watched) ro.unobserve(watched);
      if (tw) ro.observe(tw);
      watched = tw;
    }
    let x = GAP, y = GAP, right = GAP;
    if (tw) {
      const t = tw.getBoundingClientRect();
      // The flood scale's column — .twin-flood-scale's width, never more than
      // half the stage (its max-width) — whether or not the scale is up.
      const scale = tw.querySelector('#twin-flood-scale');
      const w = (scale && parseFloat(getComputedStyle(scale).width)) || 192;
      const col = Math.max(0, Math.min(w, t.width / 2 - GAP));
      x = t.left - s.left + GAP + col + GAP;
      y = t.top - s.top + GAP;
      // …and short of the compass, top right.
      const compass = tw.querySelector('#twin-compass');
      const c = compass && compass.getBoundingClientRect();
      right = c && c.width ? s.right - c.left + GAP : s.right - t.right + GAP;
    } else {
      // Beside the zoom buttons, level with their top; short of ↺, top right.
      const zoom = stage.querySelector('.leaflet-top.leaflet-left .leaflet-control');
      const z = zoom && zoom.getBoundingClientRect();
      if (z && z.width) { x = z.right - s.left + GAP; y = z.top - s.top; }
      const reset = stage.querySelector('.leaflet-top.leaflet-right .leaflet-control');
      const r = reset && reset.getBoundingClientRect();
      if (r && r.width) right = s.right - r.left + GAP;
    }
    const room = s.width - x - right;
    root.style.setProperty('--trail-x', px(x));
    root.style.setProperty('--trail-y', px(y));
    root.style.setProperty('--trail-room', px(room));
    // Short of room — a phone's twin, between the scale and the compass — the
    // name has the pill to itself.
    root.classList.toggle('is-tight', room < 10 * rem());
    // The list is not held to the pill's row: it drops below the corner's
    // controls, so it may be as wide as a name needs and the map allows, and
    // where the pill is too far right for that, it is moved left until it is
    // on the map (a phone's twin again, over the scale's names — which have
    // stood down there by then).
    const p = pill();
    const ph = p ? p.offsetHeight : 0;
    const w = Math.min(DROP_REM * rem(), s.width - 2 * GAP);
    root.style.setProperty('--trail-drop-w', px(w));
    root.style.setProperty('--trail-drop-x', `${Math.round(Math.min(0, s.width - GAP - x - w))}px`);
    root.style.setProperty('--trail-drop-h', px(s.height - y - ph - GAP / 2 - GAP));
    stage.style.setProperty('--stn-trail-foot', px(y + ph + GAP));
  }

  function rem() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; }

  // ── What it says ───────────────────────────────────────────────────────────
  function count(n) { return n === 1 ? 'the one station' : `the ${n} stations`; }

  function itemHtml(s, i) {
    const role = (s.roles || []).find(r => ROLE_COLOR[r]);
    const tag = typeof proposedTagHtml === 'function' ? proposedTagHtml(s, { short: true }) : '';
    return `<li><button type="button" class="stn-trail-item${i === 0 ? ' is-current' : ''}" data-sid="${escAttr(s.id)}"
          ${i === 0 ? 'aria-current="true"' : ''} onclick="StationTrail.go('${escAttr(s.id)}')"
          title="${escAttr(`${s.name}: the map goes there, zoomed in, and it is selected with its card up`)}"
          ><span class="stn-trail-dot" style="--dot:${escAttr(role ? ROLE_COLOR[role] : 'var(--muted)')}" aria-hidden="true"></span
          ><span class="stn-trail-item-name">${esc(s.name)}</span>${tag}${s.station_number
            ? `<span class="stn-trail-item-num">${esc(s.station_number)}</span>` : ''}</button></li>`;
  }

  function listHtml(list) {
    return `<p class="stn-trail-lead" id="stn-trail-lead">Looked at this session, the latest first</p>
      <ol class="stn-trail-list" aria-labelledby="stn-trail-lead">${list.map(itemHtml).join('')}</ol>`;
  }

  function paint() {
    if (!root) return;
    const list = shown();
    const cur = list[0] || null;
    root.hidden = !cur;
    if (!cur) {
      if (open) setOpen(false);
      stage && stage.style.removeProperty('--stn-trail-foot');
      return;
    }
    const p = pill(), d = drop();
    const n = list.length;
    const more = n > 1 ? `<span class="stn-trail-more" aria-hidden="true">+${n - 1}</span>` : '';
    p.innerHTML = `<span class="stn-trail-ico" aria-hidden="true">📍</span>`
      + `<span class="stn-trail-name">${esc(cur.name)}</span>${more}`
      + `<span class="stn-trail-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>`;
    p.setAttribute('aria-expanded', open ? 'true' : 'false');
    p.setAttribute('aria-label', `${cur.name}, and ${count(n)} looked at this session`);
    p.title = cardOn(cur.id)
      ? `${cur.name}, and ${count(n)} looked at this session — pick one to go back to it`
      : `${cur.name}'s card again, and ${count(n)} looked at this session`;
    root.classList.toggle('is-open', open);
    if (d) {
      d.hidden = !open;
      if (open) d.innerHTML = listHtml(list);
    }
    place();
  }

  // ── The list, down and up ──────────────────────────────────────────────────
  // A disclosure, as the map's other panels are: the pill says so with
  // aria-expanded, and nothing traps focus. It goes up on a press anywhere
  // else, on Escape, and when focus moves off it; a pick from it puts it away
  // too. Focus that was in the list when it goes up lands on the pill — the
  // button pressed is gone with the list.
  function onAway(e) {
    if (!root || root.contains(e.target)) return;
    setOpen(false);
  }

  function setOpen(v, { refocus = false } = {}) {
    const want = !!v && !!root && !root.hidden;
    const d = drop();
    const inList = !!(d && d.contains(document.activeElement));
    if (want === open) { if (!want && refocus && pill()) pill().focus({ preventScroll: true }); return; }
    open = want;
    if (open) window.addEventListener('pointerdown', onAway, true);
    else window.removeEventListener('pointerdown', onAway, true);
    paint();
    if (!open && (refocus || inList) && pill()) pill().focus({ preventScroll: true });
  }

  function items() { return root ? [...root.querySelectorAll('.stn-trail-item')] : []; }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (!open) return;
      // Claimed: a full-screen map leaves on an unclaimed Escape (app.js).
      e.preventDefault();
      e.stopPropagation();
      setOpen(false, { refocus: true });
      return;
    }
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      const now = items();
      const next = at < 0 ? now[0] : now[Math.min(now.length - 1, at + 1)];
      if (next) next.focus();
    } else if (e.key === 'ArrowUp' && at >= 0) {
      e.preventDefault();
      (at === 0 ? pill() : list[at - 1]).focus();
    } else if (e.key === 'Home' && at >= 0) {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === 'End' && at >= 0) {
      e.preventDefault();
      list[list.length - 1].focus();
    }
  }

  function onFocusOut(e) {
    if (open && e.relatedTarget && root && !root.contains(e.relatedTarget)) setOpen(false);
  }

  // ── Going back to one ──────────────────────────────────────────────────────
  // Selected as its row selects it (less the second press that deselects: a
  // pick from here always leaves it selected), the card on it, and the map on
  // it, zoomed in. A station the filters leave out of the list has them
  // narrowed to its name, as a station opened from another tab has
  // (selectStationState) — and that re-renders the tab, map and this pill
  // included, which is why the map is asked for again after it.
  //
  // In the twin the map goes to the station dead centre and at once, at its
  // own zoom: the twin follows the map's centre to the station on the card
  // (MapTwin.sync), which is how a radio path's far end is followed there
  // (DigitalTwin.followPath). On the map the station is centred clear of the
  // card, as a row picked from the list is (focusStationOnMap).
  function go(id) {
    const s = stations().find(x => x.id === id);
    if (!s) return;
    setOpen(false);
    let redrawn = false;
    if (state.selectedId !== id) {
      if (selectStationState(s)) { renderMain(); redrawn = true; }
      else { rerenderStations(); rerenderStationEditorCard(); }
    }
    // A re-render drew a new pill, and the one focus was on went with the
    // page it was on.
    if (redrawn && pill()) pill().focus({ preventScroll: true });
    showStationCard(id, { opener: pill() });
    const map = state.map;
    if (!map || !located(s)) {
      announce(`${s.name} — selected, with its card up. It has no position to put the map on.`);
      return;
    }
    const twin = twinUp();
    const max = map.getMaxZoom();
    const cap = Number.isFinite(max) ? max : 19;
    const z = Math.min(cap, Math.max(map.getZoom() || 0, twin ? MapTwin.zoom : ZOOM_IN));
    if (twin) map.setView([s.lat, s.lon], z, { animate: false });
    else map.setView(MapLeader.centreFor(L.latLng(s.lat, s.lon), z), z);
    announce(`${s.name} — selected and on the map${twin ? ', in its digital twin' : ''}, with its card up.`);
  }

  return {
    // The Stations map, built (initMap): the pill goes over its stage, beside
    // the Leaflet container so that it comes after the map's own controls and
    // before the cards in the order Tab takes.
    attach(map) {
      this.detach();
      const container = map && map.getContainer && map.getContainer();
      const box = container && container.closest && container.closest('.mn-map-stage');
      if (!box) return;
      stage = box;
      root = document.createElement('div');
      root.id = 'stn-trail';
      root.className = 'stn-trail';
      root.hidden = true;
      root.innerHTML = `<button type="button" class="stn-trail-pill" id="stn-trail-pill" aria-expanded="false"
          aria-controls="stn-trail-drop" onclick="StationTrail.toggle()"></button>
        <div class="stn-trail-drop" id="stn-trail-drop" hidden></div>`;
      root.addEventListener('keydown', onKey);
      root.addEventListener('focusout', onFocusOut);
      stage.insertBefore(root, container.nextSibling);
      if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => place());
        ro.observe(stage);
      }
      paint();
    },

    // The map torn down (stopStationsMap): the pill goes with the stage it
    // stood over. The trail itself is kept.
    detach() {
      window.removeEventListener('pointerdown', onAway, true);
      open = false;
      if (ro) { ro.disconnect(); ro = null; }
      watched = null;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      if (stage) stage.style.removeProperty('--stn-trail-foot');
      root = null;
      stage = null;
    },

    // A station looked at: to the head of the trail.
    visit(id) {
      if (!id || !stations().some(s => s.id === id)) return;
      const list = load();
      if (list[0] !== id) {
        const at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1);
        list.unshift(id);
        if (list.length > MAX) list.length = MAX;
        save();
      }
      paint();
    },

    // Something it reads has changed — the card opened or closed, a station
    // renamed, the twin up or down: said again, and stood again.
    sync() { paint(); },

    // The pill: the card of the station it names, if that is not up already,
    // and the list down (or up again).
    toggle() {
      const cur = shown()[0];
      if (!cur) return;
      if (!cardOn(cur.id)) {
        showStationCard(cur.id, { opener: pill() });
        MapLeader.reveal();
      }
      setOpen(!open);
    },

    go,
    close() { setOpen(false); },

    // For the checks: the trail in order, what it would show, and whether its
    // list is down.
    ids() { return load().slice(); },
    shownIds() { return shown().map(s => s.id); },
    isOpen() { return open; },
    zoomIn: ZOOM_IN,
    max: MAX,
  };
})();
if (typeof window !== 'undefined') window.StationTrail = StationTrail;
