// MegaNet — map-tasks.js
//
//   MapTasks   the Stations map's Tasks layer: every station with an
//              unfinished task the signed-in person may see, ringed in the
//              colour of its most pressing task, with how many on a badge.
//              The Tasks view (map-views.js, Everyone) turns it on.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches across to tasks.js for Tasks — the list (mapRows), the grouping
// (stationGroups, mergeOnScreen), the pin (pinIcon, pinTitle, pinPopupHtml)
// and the key (keyHtml), so this map and the Tasks tab's own say the same
// thing in the same colours — to app.js for selectStation and
// rerenderMapLegend, and to core.js for state. All of it from inside its own
// functions, so this file's position among the modules is free.
//
// ── Who sees what ────────────────────────────────────────────────────────────
// The database decides (0095): task_list() returns the tasks this person may
// see and no others, and this layer draws what it returns. Signed out, or
// signed in and on no team, it draws nothing and its note says why.
//
// ── The pin ──────────────────────────────────────────────────────────────────
// Two markers, as map-photos.js draws its pins: the ring in a pane under the
// network's canvas, so the station's own pin is drawn over it and the click on
// it stays the station's; the badge in a pane over the canvas, up and right of
// the pin, the button. Turned on by hand or by the view, the map moves to
// take in every station with a task, unless they are all in view already. Pressing a station's badge opens its card (which lists
// its tasks, tasks.js cardHtml); pressing a merged one zooms in to its stations.
const MapTasks = (function () {
  const PANE = 'mnTasks';
  const PANE_Z = 425;
  const RING_PANE = 'mnTaskRings';
  const RING_Z = 397;
  const LS = 'mn-map-tasks';
  const LIVE = ['open', 'in_progress', 'waiting'];   // tasks.js's unfinished ones

  let map = null, layer = null, seq = 0;
  let groups = [];
  let fitNext = false;         // turned on just now: show where the tasks are
  let note = { kind: 'off', n: 0, stations: 0, unplaced: 0, error: '' };

  const T = () => (typeof Tasks !== 'undefined' ? Tasks : null);
  const forMe = () => !!(T() && T().forMe && T().forMe());

  function setNote(kind, extra = {}) {
    note = Object.assign({ kind, n: 0, stations: 0, unplaced: 0, error: '' }, extra);
    const el = document.getElementById('map-tasks-note');
    if (el) el.innerHTML = noteHtml();
  }

  function clear() {
    if (layer) { layer.remove(); layer = null; }
  }

  function draw() {
    clear();
    if (!map || !groups.length) return;
    const t = T();
    layer = L.layerGroup();
    for (const g of t.mergeOnScreen(map, groups)) {
      L.marker([g.lat, g.lon], { icon: ringIcon(g), pane: RING_PANE, interactive: false, keyboard: false }).addTo(layer);
      const title = t.pinTitle(g);
      L.marker([g.lat, g.lon], { icon: t.pinIcon(g, { ring: false }), pane: PANE, keyboard: true, riseOnHover: true,
                                 title, alt: title, bubblingMouseEvents: false })
        .on('click', () => press(g))
        .addTo(layer);
    }
    layer.addTo(map);
  }
  function ringIcon(g) {
    return L.divIcon({
      className: 'mn-task-icon',
      html: `<span class="mn-task-pin mn-task-${g.key}${g.many ? ' mn-task-many' : ''}"><i class="mn-task-ring" aria-hidden="true"></i></span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function press(g) {
    if (!map) return;
    if (g.many) {
      try { map.fitBounds(g.members.map(x => [x.lat, x.lon]), { padding: [60, 60], maxZoom: 14 }); } catch (_) { /* gone */ }
      return;
    }
    if (typeof state !== 'undefined' && state.selectedId === g.id) return;   // its card is open already
    if (typeof selectStation === 'function') selectStation(g.id);
  }

  function run() {
    if (!map) return;
    if (!state.mapTasks) { groups = []; clear(); setNote('off'); return; }
    if (!forMe()) { groups = []; clear(); setNote(typeof Auth !== 'undefined' && Auth.isSignedIn() ? 'not-yours' : 'signed-out'); return; }
    const mine = ++seq;
    if (!groups.length) setNote('loading');
    T().mapRows().then(rows => {
      if (mine !== seq || !map || !state.mapTasks) return;
      const live = (rows || []).filter(r => LIVE.includes(r.status));
      const got = T().stationGroups(live);
      groups = got.groups;
      if (fitNext && groups.length) {
        fitNext = false;
        // Only when some are out of view: a map already showing them stays put.
        const v = map.getBounds();
        if (!groups.every(g => v.contains([g.lat, g.lon]))) {
          try { map.fitBounds(groups.map(g => [g.lat, g.lon]), { padding: [60, 60], maxZoom: 11 }); } catch (_) { /* not sized */ }
        }
      }
      draw();
      setNote('ok', { n: groups.reduce((a, g) => a + g.n, 0), stations: groups.length, unplaced: got.unplaced });
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    }).catch(err => {
      if (mine !== seq || !map) return;
      groups = []; clear();
      setNote('fail', { error: (err && err.message) || String(err) });
    });
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':
        return 'A ring and a ✅ badge on every station with an unfinished task you may see, in the colour of its most pressing one.';
      case 'signed-out':
        return 'Tasks are for the people on a team — sign in to see where yours are.';
      case 'not-yours':
        return 'Tasks are for administrators and the people on a team; a team’s owner adds you to it.';
      case 'loading':
        return 'Reading your tasks…';
      case 'fail':
        return `<span class="txt-bad">No tasks — ${esc(note.error)}</span>`;
      case 'ok':
        return note.n
          ? `${note.n} unfinished task${note.n === 1 ? '' : 's'} at ${note.stations} station${note.stations === 1 ? '' : 's'}. Press a ✅ for the station’s card and its tasks.`
            + (note.unplaced ? ` ${note.unplaced} more ${note.unplaced === 1 ? 'is' : 'are'} not at a station on the map.` : '')
          : 'No unfinished tasks at a station that you may see.';
      default:
        return '';
    }
  }

  function legendHtml() {
    const keys = [...new Set(groups.map(g => g.key))];
    return `<span class="legend-item"><span class="small"><strong>Tasks</strong> — ${T() ? T().keyHtml(keys.length ? keys : null) : ''}</span></span>`;
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      if (!m.getPane(RING_PANE)) {
        const p = m.createPane(RING_PANE);
        p.style.zIndex = RING_Z;
        p.style.pointerEvents = 'none';
      }
      m.on('zoomend', draw);
      run();
    },
    detach() {
      if (map) map.off('zoomend', draw);
      clear();
      groups = [];
      map = null;
      seq++;
    },
    // The list changed (a task made or moved on, a sign-in): draw again.
    refresh() { if (map) run(); },
    active() { return !!(layer && groups.length); },
    noteHtml,
    legendHtml,
    // Off unless switched on, and remembered once it is.
    setEnabled(on) {
      state.mapTasks = !!on;
      fitNext = !!on;
      try { localStorage.setItem(LS, on ? 'on' : 'off'); } catch (_) { /* this session only */ }
      run();
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    },
    // Read by the checks.
    _groups: () => groups.map(g => ({ id: g.id, n: g.n, key: g.key })),
    _note: () => ({ ...note }),
  };
})();
if (typeof window !== 'undefined') window.MapTasks = MapTasks;
