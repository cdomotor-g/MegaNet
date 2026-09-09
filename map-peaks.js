// MegaNet — map-peaks.js
//
//   MapPeaks   the highest ground in view, found and pinned — the three to
//              five summits in the current map window, whether or not anybody
//              has ever put a station on one.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, mapViewPills, stationLatLonText and
// copyLatLonPillHtml; across to terrain.js for Terrain.grid and to app.js for
// rerenderMapLegend and mapNote. All of it from inside its own functions, so
// this file's position among the modules is free.
//
// ── The question this answers ────────────────────────────────────────────────
// Every other terrain tool here starts from somewhere we already are: profile
// this path, sweep these links, colour this network. Siting a new repeater
// starts from the opposite end — "what is high around here?" — and until now
// the only way to ask it was to squint at a topo base map and guess. This
// reads the same ~30 m terrain the profile is built on and simply answers,
// with the top N summits in view ranked, pinned and listed with their heights.
//
// "Not restricted to our sites" is the whole point: these are hilltops, not
// stations, and most of them have nothing on them. What comes back is ground.
//
// ── Peaks, not maxima ────────────────────────────────────────────────────────
// The naive version — sort the grid and take the top five samples — returns
// five pixels of the same hilltop every time. So a candidate has to be the
// highest sample within a window around it (a local maximum), and the ones
// that survive are then thinned by distance: no two peaks closer together than
// SEP_FRAC of the view's diagonal. That is the same idea as topographic isolation
// done crudely, and crude is honest here — the source is a ~30 m grid resampled
// to whatever the view needs, so the summit reported is "the highest sample
// near the top", not a trig point. The note under the switch says so, in
// metres of grid spacing, every time.
const MapPeaks = (function () {
  // The grid the search runs on. 192² is ~37,000 samples — enough to separate
  // one ridge from the next at any view worth asking the question of, and well
  // inside Terrain.grid's 640 cap and its tile budget.
  const N            = 192;
  const WINDOW       = 2;      // a candidate must be no lower than every sample
                               // within ±2 cells of it
  const SEP_FRAC     = 0.11;   // of the view's diagonal, between any two peaks
  const PAD          = 0.05;   // fraction of the view searched beyond each edge.
                               // A summit sitting on the very edge has no window
                               // around it to be the highest of, so without this
                               // the search silently ignores the rim of every
                               // view — and a one-pixel pan changes the answer.
                               // The cost is that a peak just off screen can be
                               // pinned; at 5% it is pinned just off screen too
  const DEBOUNCE_MS  = 350;    // longer than the contour layer's: this one is
                               // doing arithmetic, not just fetching a picture
  const MIN_COUNT    = 3, MAX_COUNT = 5;

  // Its own pane, above the survey marks (345) and under the leader lines
  // (350) in the z-index budget map-survey.js documents: a peak marker is a
  // point that has to win a click over the context layers, and must not sit
  // over a station pin — those are in Leaflet's markerPane at 600.
  const PANE   = 'mnPeaks';
  const PANE_Z = 348;

  let map = null, layer = null, timer = null, seq = 0;
  let found = [];                       // [{ lat, lon, m, rank }]
  let drawnFor = null;                  // { zoom, count, bounds } the pins answer for
  let note = { kind: 'off', res: null, error: '' };

  function clearPins() {
    if (layer) { layer.remove(); layer = null; }
    found = [];
    drawnFor = null;
  }

  function setNote(kind, extra) {
    note = { kind, res: (extra && extra.res) || null, error: (extra && extra.error) || '' };
    const el = document.getElementById('map-peaks-note');
    if (el) el.innerHTML = noteHtml();
  }

  // ── Finding them ────────────────────────────────────────────────────────────

  // Every sample that is the highest thing within ±WINDOW cells of itself, as
  // grid indices with their heights. A NaN (a tile that never arrived) can
  // neither be a peak nor beat one — terrain.js's loud-failure rule, applied
  // where it matters most: a gap in the data must never read as low ground.
  function localMaxima(g) {
    const { nx, ny, elev } = g;
    const out = [];
    for (let j = WINDOW; j < ny - WINDOW; j++) {
      for (let i = WINDOW; i < nx - WINDOW; i++) {
        const v = elev[j * nx + i];
        if (isNaN(v)) continue;
        let best = true;
        for (let dj = -WINDOW; dj <= WINDOW && best; dj++) {
          for (let di = -WINDOW; di <= WINDOW; di++) {
            if (!di && !dj) continue;
            const u = elev[(j + dj) * nx + (i + di)];
            if (isNaN(u)) continue;
            // Strictly greater, so a tie does not disqualify: on a flat top
            // every cell would fail a `>=` test and the whole plateau would go
            // unrepresented — which is the wrong way to be wrong about a hill.
            // The several candidates a flat top produces are reduced to one by
            // the distance thinning below, which is what that is for.
            if (u > v) { best = false; break; }
          }
        }
        if (best) out.push({ i, j, m: v });
      }
    }
    return out;
  }

  // Grid index → the coordinate it was sampled at. Terrain.grid walks the box
  // corner to corner in even steps, so this is the same arithmetic backwards.
  function llOf(box, g, c) {
    return {
      lat: box.north + (box.south - box.north) * c.j / (g.ny - 1),
      lon: box.west  + (box.east  - box.west)  * c.i / (g.nx - 1),
    };
  }

  // Highest first, thinned so no two are within `sepKm` of each other. The
  // first N that survive are the answer — which is why the sort has to come
  // before the thinning and not after it: taking the top five and *then*
  // spreading them out returns five points off one hill.
  function thin(cands, box, g, sepKm, want) {
    cands.sort((a, b) => b.m - a.m);
    const out = [];
    for (const c of cands) {
      const ll = llOf(box, g, c);
      let clear = true;
      for (const p of out) {
        if (acmaHaversineKm(ll.lat, ll.lon, p.lat, p.lon) < sepKm) { clear = false; break; }
      }
      if (!clear) continue;
      out.push({ lat: ll.lat, lon: ll.lon, m: c.m, rank: out.length + 1 });
      if (out.length >= want) break;
    }
    return out;
  }

  // ── Drawing them ────────────────────────────────────────────────────────────

  function icon(p) {
    return L.divIcon({
      className: 'mn-peak-icon',
      html: `<span class="mn-peak"><i class="mn-peak-mark" aria-hidden="true">▲</i>` +
            `<b class="mn-peak-h">${Math.round(p.m)} m</b></span>`,
      iconSize: [0, 0],            // the label sizes itself; the anchor is the summit
      iconAnchor: [0, 0],
    });
  }

  // What a peak has to say for itself. The same pills a station callout
  // carries, because the answer to "what is on that hill" is somebody else's
  // imagery and the answer to "where exactly" is the clipboard — and a summit
  // is worth nothing to a planner they cannot paste into a work order.
  function popupHtml(p) {
    const s = { lat: p.lat, lon: p.lon, name: `Peak ${p.rank} — ${Math.round(p.m)} m` };
    return `
      <div class="mn-peak-pop">
        <h4>#${p.rank} in view · ${Math.round(p.m)} m</h4>
        <p class="small">${esc(stationLatLonText(s))}<br>
          <span class="txt-muted">Ground height only — nothing is standing on it. Height is
          the highest sample on the ~${note.res || '?'} m search grid, above the EGM96 geoid.</span></p>
        <div class="pill-row">
          ${copyLatLonPillHtml(s)}
          ${mapViewPills(s).join('\n          ')}
        </div>
      </div>`;
  }

  function draw() {
    if (layer) layer.remove();
    layer = L.layerGroup([], { pane: PANE });
    for (const p of found) {
      L.marker([p.lat, p.lon], { icon: icon(p), pane: PANE, riseOnHover: true,
                                 title: `Peak ${p.rank} in view — ${Math.round(p.m)} m` })
        .bindPopup(() => popupHtml(p), { maxWidth: 320 })
        .addTo(layer);
    }
    layer.addTo(map);
  }

  // ── The pass ────────────────────────────────────────────────────────────────

  function run() {
    if (!state.mapPeaks) { clearPins(); setNote('off'); rerenderMapLegend(); return; }
    if (!map) return;

    const want = count();
    const b = map.getBounds().pad(PAD);
    // Still the same view at the same zoom, asking for no more peaks than last
    // time? Then the pins on the map are already the answer.
    if (drawnFor && drawnFor.zoom === map.getZoom() && drawnFor.count === want
        && drawnFor.bounds.equals(b, 1e-9)) { setNote('ok', { res: drawnFor.res }); return; }

    const box = { north: b.getNorth(), south: b.getSouth(),
                  east: b.getEast(),  west: b.getWest() };
    const mine = ++seq;
    setNote('loading');
    Terrain.grid(box, N, N).then(g => {
      if (mine !== seq || !map || !state.mapPeaks) return;
      if (!g.ok) { clearPins(); setNote('fail', { error: g.error }); rerenderMapLegend(); return; }

      const diagKm = acmaHaversineKm(box.north, box.west, box.south, box.east);
      const sepKm  = Math.max(g.resolution_m * WINDOW * 2 / 1000, diagKm * SEP_FRAC);
      found = thin(localMaxima(g), box, g, sepKm, want);

      if (!found.length) { clearPins(); setNote('empty'); rerenderMapLegend(); return; }
      drawnFor = { zoom: map.getZoom(), count: want, bounds: b, res: g.resolution_m };
      draw();
      setNote('ok', { res: g.resolution_m });
      rerenderMapLegend();
    }).catch(e => {
      if (mine !== seq || !map) return;
      clearPins();
      setNote('fail', { error: (e && e.message) || 'the terrain grid could not be built' });
      rerenderMapLegend();
    });
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function count() {
    const n = Math.round(state.mapPeakCount);
    return Math.max(MIN_COUNT, Math.min(MAX_COUNT, n > 0 ? n : MAX_COUNT));
  }

  function noteHtml() {
    const caveat = 'Ground height off the same ~30 m terrain the elevation profile uses — '
                 + 'the highest <em>sample</em> near each summit, not a surveyed trig point, '
                 + 'and nothing is standing on it.';
    switch (note.kind) {
      case 'off':
        return `Pin the highest ground in the current view — hilltops, not stations. ${caveat}`;
      case 'loading':
        return 'Reading the terrain in view…';
      case 'fail':
        return `<span class="txt-bad">No peaks — ${esc(note.error)}</span>`;
      case 'empty':
        return 'Nothing in this view stands out as a summit — try zooming in.';
      case 'ok':
        return `${found.length} highest point${found.length === 1 ? '' : 's'} in view, `
             + `sampled every ~${note.res} m:<br>${listHtml()}<br>${caveat}`;
      default:
        return '';
    }
  }

  // The list under the switch, which is half the feature: a ranked column of
  // heights an operator can read without hunting for pins, each one a button
  // that takes the map to it.
  function listHtml() {
    return found.map(p => `
      <button type="button" class="btn-link mn-peak-go" onclick="MapPeaks.flyTo(${p.rank})"
              title="Centre the map on this summit">
        <strong>#${p.rank}</strong> ${Math.round(p.m)} m
        <span class="txt-muted">${esc(stationLatLonText(p))}</span>
      </button>`).join('');
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      m.on('moveend', sync);
      if (state.mapPeaks) sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      clearPins();
      map = null;
      seq++;
    },

    sync,

    active() { return !!(layer && found.length); },

    peaks() { return found.slice(); },

    noteHtml,

    // Off by default and not persisted, for the reason map-survey.js gives
    // about layers that cost requests: this one fetches up to a hundred terrain
    // tiles for a view it was not asked about, and "no extra requests fire with
    // the layer off" has to stay true of a cold page load.
    setEnabled(on) {
      state.mapPeaks = on;
      if (!on) { clearTimeout(timer); clearPins(); setNote('off'); rerenderMapLegend(); return; }
      setNote('loading');
      sync();
    },

    // Three to five. Asking for more than are already drawn re-runs the search;
    // asking for fewer would too, and does, because a rank is only meaningful
    // against the list it came out of.
    setCount(n) {
      state.mapPeakCount = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(+n) || MAX_COUNT));
      try { localStorage.setItem('mn-peak-count', String(state.mapPeakCount)); }
      catch (_) { /* private browsing, a full quota — it still holds this session */ }
      if (state.mapPeaks) sync();
    },

    // From the list under the switch. Centre rather than zoom: the operator is
    // looking at a view they chose, and a peak in it is a place in that view,
    // not a reason to leave it.
    flyTo(rank) {
      const p = found.find(x => x.rank === rank);
      if (!p || !map) return;
      map.panTo([p.lat, p.lon]);
      mapNote(`Peak #${p.rank} — ${Math.round(p.m)} m at ${stationLatLonText(p)}`, 6000);
    },
  };
})();
if (typeof window !== 'undefined') window.MapPeaks = MapPeaks;
