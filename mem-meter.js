// MegaNet — mem-meter.js
//
//   MemMeter   the thin bar under the header and the panel behind it: what this
//              page is holding, and a way to give some of it back (#79).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc and liveMaps; across to app.js for renderMain,
// updateChromeHeight and refreshAcmaLayer; and into arro-data.js and terrain.js
// for the two caches it can drop. All of it from inside MemMeter's own
// functions — the IIFE body builds tables and nothing else — so this file's
// position among the modules is free.
//
// The registry to be careful with is here rather than spread over the app: the
// HOLDERS list, the byte-measurement map and the release() switch are three
// lists of the same thing, and a feature added to one but not the others makes
// the meter under-report in silence. That is constraint 3 on #113, and having
// all three in one file is most of what moving this module buys.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── Memory meter ─────────────────────────────────────────────────────────────
// A thin bar under the header, and a panel behind it, answering "how much is
// this page holding, and can I give some back" — see issue #79. This is our
// own accounting, not a walk of the object graph: array/string lengths and
// byte counts recorded at load time (loadJson, acmaFetchJson), which is free.
// The one holder that counts rather than reads — the Leaflet layers added by
// #144 — counts a registry the map already keeps, and is timed on the file's
// heaviest map rather than assumed to be cheap.
// performance.memory (Chromium-only) and navigator.storage.estimate() are
// shown alongside where the browser actually offers them.
//
// Its position used to matter: init() called MemMeter.start() from partway
// down this file, so the binding had to be initialised above that point. Since
// M1 (#132) init() is the last statement of the last script, so it doesn't —
// this could sit anywhere. Terrain and ArroData, which its functions reach
// into, are still declared later; that was always fine, because nothing here
// touches them until a click or the sampling timer calls in.
const MemMeter = (function () {
  // Holders shown in the bar and the panel, in the order they're listed. Each
  // maps to one of the state slots the issue's table calls out; `color` is an
  // existing CSS custom property so the bar reuses the app's palette rather
  // than inventing one. `releasable` holders get a Release button — the three
  // the issue judges safe to drop and re-lazy-load or re-fetch.
  const HOLDERS = [
    { key: 'stations', label: 'stations.json',           color: '--role-repeater', releasable: false },
    // Not releasable, and that is a decision rather than an omission (#144).
    // The three releasable holders below drop a cache the app re-fetches on
    // demand; a map is not a cache. The only sensible way to drop one is to
    // leave its tab, and since #143 that happens on its own — so a Release
    // button here would either do nothing or break the tab you are looking at.
    { key: 'maps',      label: 'Leaflet map layers',      color: '--map-line',      releasable: false },
    { key: 'acma',      label: 'ACMA / RF Changes data',  color: '--role-satcom',   releasable: true  },
    { key: 'terrain',   label: 'Terrain tile cache',      color: '--role-base',     releasable: true  },
    { key: 'arro',      label: 'ARRO Data series',        color: '--role-field',    releasable: true  },
    { key: 'a2',        label: 'ALERT2 capture',          color: '--draw',         releasable: false },
    { key: 'storage',   label: 'localStorage',            color: '--muted',        releasable: false },
  ];

  const ACMA_FILES = ['acma-threats.json', 'acma-sites.json', 'acma-dictionaries.json',
                       'acma-devices.json', 'acma-timeline.json', 'acma-changes.json',
                       'acma-snapshots.json'];

  // Bytes per ARRO row: t, tr, v, raw are Float64Array (8 B each), q is
  // Uint8Array (1 B) — see ArroData's parseCsv. Length × this, not a walk.
  // A field-data series carries a couple of extra columns and says so in its
  // own bytesPerRow; this is the floor every series shares.
  const ARRO_BYTES_PER_ROW = 8 * 4 + 1;
  const TERRAIN_TILE_BYTES = 65536 * 2;   // Int16Array(65536), 2 B/element

  // Bytes per Leaflet layer, and per vertex on top of it. Measured, not picked
  // — 5,000 to 20,000 of each kind built into a real map in headless Chromium
  // with --enable-precise-memory-info and --js-flags=--expose-gc, gc'd either
  // side of the build, heap delta over the count, median of three trials:
  //
  //   circleMarker exactly as initMap() builds one — mn* properties, a bound
  //     popup, a click handler, one vertex ............... 1,183 B
  //   polyline, two vertices, as the link lines are ...... 1,472 B
  //   polyline, a hundred vertices ...................... 11,005 B
  //   marker with a divIcon, one vertex .................. 1,042 B
  //
  // The middle two give the split: (11,005 − 1,472) / 98 ≈ 97 B a vertex, and
  // a ~1,200 B base per layer then covers all four to within 10%. Vertices are
  // counted separately rather than folded into the base because a station pin
  // has one and a river outline has thousands — one constant would be wrong by
  // an order of magnitude at whichever end it was fitted to.
  const LEAFLET_BYTES_PER_LAYER  = 1200;
  const LEAFLET_BYTES_PER_VERTEX = 100;

  const WARN_BYTES = 60  * 1024 * 1024;
  const BAD_BYTES  = 100 * 1024 * 1024;
  const BAR_CAP    = 130 * 1024 * 1024;   // segment widths scale against this

  let panelOpen = false;
  let storageEstimate = null;   // {usage, quota}, fetched once per panel open

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function acmaFileBytes() {
    const F = state.memBytes.files;
    return ACMA_FILES.reduce((sum, k) => sum + (F[k] || 0), 0);
  }

  function arroBytes() {
    return ArroData.allSeries()
      .reduce((sum, s) => sum + (s.n || 0) * (s.bytesPerRow || ARRO_BYTES_PER_ROW), 0);
  }

  function localStorageBytes() {
    let sum = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        sum += (k.length + (localStorage.getItem(k) || '').length) * 2;   // UTF-16
      }
    } catch (_) { /* storage disabled — not worth surfacing here */ }
    return sum;
  }

  // A path's _latlngs is a LatLng, an array of them, or an array of arrays of
  // them (a polygon, a multi-polyline). Recursion is the whole difference.
  function countVertices(ll) {
    if (!ll) return 0;
    if (Array.isArray(ll)) return ll.reduce((n, x) => n + countVertices(x), 0);
    return 1;
  }

  // What the open tab's maps are holding. Still not a walk of the object graph:
  // eachLayer() iterates the registry the map already keeps, and _latlngs is a
  // length, not a traversal of anything the layer points at. It is the one
  // holder here that counts rather than reads a number recorded at load, so it
  // was timed rather than assumed — on Stations, the heaviest map in the app at
  // 7,855 layers and 12,025 vertices, a whole render() is 0.9 ms median /
  // 2.6 ms worst of twenty, once every five seconds and never while hidden.
  //
  // liveMaps() (core.js) returns the maps that exist right now, which since
  // #143 is the open tab's and nothing else — so this needs no per-tab list of
  // its own, and a tab added later is counted without being told about (#142).
  //
  // Tiles are counted but deliberately kept out of `bytes`: a decoded 256×256
  // tile is ~256 KB in the browser's image cache and not on the JS heap, and
  // none of the other five holders count anything of that kind. Folding ~3 MB
  // of bitmap into the total would make the total mean two things at once. The
  // panel shows the count as context instead.
  function mapsReport() {
    let maps = 0, layers = 0, vertices = 0, tiles = 0;
    liveMaps().forEach(map => {
      maps++;
      try {
        map.eachLayer(l => {
          layers++;
          if (l._latlngs)     vertices += countVertices(l._latlngs);
          else if (l._latlng) vertices += 1;
          if (l._tiles)       tiles += Object.keys(l._tiles).length;
        });
      } catch (_) { /* a map mid-teardown counts for what it managed */ }
    });
    return {
      maps, layers, vertices, tiles,
      bytes: layers * LEAFLET_BYTES_PER_LAYER + vertices * LEAFLET_BYTES_PER_VERTEX,
    };
  }

  function heapInfo() {
    const m = performance && performance.memory;
    return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
  }

  function memoryReport() {
    const maps = mapsReport();
    const bytes = {
      stations: state.memBytes.stationsJson,
      maps:     maps.bytes,
      acma:     acmaFileBytes(),
      terrain:  Terrain.cached() * TERRAIN_TILE_BYTES,
      arro:     arroBytes(),
      a2:       (state.a2.text || '').length * 2,
      storage:  localStorageBytes(),
    };
    const holders = HOLDERS.map(h => ({ ...h, bytes: bytes[h.key] }));
    return { holders, total: holders.reduce((s, h) => s + h.bytes, 0), heap: heapInfo(), maps };
  }

  // ── the bar ──

  function render() {
    const bar = document.getElementById('mem-bar');
    if (!bar) return;
    if (!state.data) { bar.hidden = true; return; }
    const wasHidden = bar.hidden;
    bar.hidden = false;
    const { holders, total } = memoryReport();
    bar.classList.toggle('mem-warn', total >= WARN_BYTES && total < BAD_BYTES);
    bar.classList.toggle('mem-bad', total >= BAD_BYTES);
    bar.title = `Memory this page is holding: ~${fmtBytes(total)} (our accounting) — click for details`;
    // The house pattern for a graphic with data behind it, applied to the one
    // graphic the shell owns (#109). The strip is seven coloured segments and
    // nothing else — a screen reader was told "Memory usage", a fixed string
    // that stayed the same whether the page was holding 4 MB or 40. The
    // accessible name carries the number now, and points at the accessible
    // *table* that is the real alternative: the panel behind this control
    // already lists every holder, its estimate and its Release button, so the
    // pattern here is "graphic, plus a summary in its name, plus the table one
    // activation away" rather than a second copy of the data in the DOM.
    // U3/U5/U6 apply the same three parts to the map, the graph, the timeline
    // and the ARRO chart — see docs/design-system.md.
    bar.setAttribute('aria-label',
      `Memory this page is holding: about ${fmtBytes(total)} across `
      + `${holders.filter(h => h.bytes > 0).length} holders. Activate for the full breakdown.`);
    bar.innerHTML = holders.filter(h => h.bytes > 0).map(h => {
      const pct = Math.max(0.4, Math.min(100, h.bytes / BAR_CAP * 100));
      return `<span class="mem-seg" style="width:${pct}%;background:var(${h.color})" `
           + `title="${esc(h.label)}: ${fmtBytes(h.bytes)}"></span>`;
    }).join('');
    if (wasHidden !== bar.hidden) updateChromeHeight();   // the bar just entered/left the layout
    if (panelOpen) renderPanel();
  }

  let timer = null;
  function start() {
    if (timer) return;
    // Never in a render path, and never while the tab is hidden — a memory
    // meter that costs memory (or wakes a backgrounded tab) is the joke.
    timer = setInterval(() => { if (document.visibilityState === 'visible') render(); }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') render();
    });
  }

  // ── the panel ──

  function togglePanel() { if (panelOpen) closePanel(); else openPanel(); }

  function openPanel() {
    panelOpen = true;
    let root = document.getElementById('mem-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'mem-modal';
      root.className = 'modal-overlay';
      root.onclick = closePanel;
      document.body.appendChild(root);
    }
    root.style.display = 'flex';
    renderPanel();
    // The strip is the control that discloses this panel, so it has to say so
    // and has to say when (#109). aria-controls is in index.html; the state is
    // here, because here is where it changes.
    document.getElementById('mem-bar')?.setAttribute('aria-expanded', 'true');
    // Same contract Modal already keeps: focus moves into the dialog on open
    // and comes back to what opened it on close. Without it Escape closes a
    // panel the keyboard was never inside, and Tab walks the page behind it.
    root.querySelector('.mem-card')?.focus();
    document.addEventListener('keydown', onKey);
    if (!storageEstimate && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(e => { storageEstimate = e; renderPanel(); }).catch(() => {});
    }
  }

  // preventDefault claims the key (the Modal contract), so dismissing this
  // panel cannot also drop a fullscreen map out from under it.
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); closePanel(); } }

  function closePanel() {
    panelOpen = false;
    const root = document.getElementById('mem-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
    const bar = document.getElementById('mem-bar');
    if (bar) {
      bar.setAttribute('aria-expanded', 'false');
      // Focus goes back to the strip, but only if it is still the panel's
      // doing — a Release button that navigated somewhere, or a close that
      // followed a click into the page behind, should not have the focus
      // dragged back up to the header.
      if (!document.activeElement || document.activeElement === document.body) bar.focus();
    }
  }

  function renderPanel() {
    const root = document.getElementById('mem-modal');
    if (!root || !panelOpen) return;
    const { holders, total, heap, maps } = memoryReport();
    const n = x => x.toLocaleString();
    const rows = holders.map(h => `
      <tr>
        <td><span class="mem-swatch" style="background:var(${h.color})"></span>${esc(h.label)}</td>
        <td class="mem-bytes">${fmtBytes(h.bytes)}</td>
        <td>${h.releasable && h.bytes > 0
              ? `<button class="mem-release" onclick="MemMeter.release('${h.key}')">Release</button>`
              : ''}</td>
      </tr>`).join('');
    root.innerHTML = `
      <div class="modal-card mem-card" role="dialog" aria-modal="true" aria-labelledby="mem-title"
           tabindex="-1" onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="mem-title">Memory this page is holding</h2>
          <button class="modal-x" title="Close (Esc)" onclick="MemMeter.closePanel()">×</button>
        </div>
        <p class="sub">Our own accounting of what MegaNet is keeping in memory — cheap to compute
           (lengths recorded when each piece loaded, map layers counted off the registry the map
           already keeps), not a walk of the object graph. Estimates, not exact byte counts.</p>
        <table class="mem-table">
          <thead><tr><th>Holder</th><th>Estimate</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>Total (our accounting)</td><td class="mem-bytes">${fmtBytes(total)}</td><td></td></tr></tfoot>
        </table>
        <p class="mem-heap">
          ${maps.maps
              ? `Leaflet: ${n(maps.maps)} map${maps.maps === 1 ? '' : 's'} open, holding
                 ${n(maps.layers)} layer${maps.layers === 1 ? '' : 's'} and ${n(maps.vertices)}
                 vertices — plus ${n(maps.tiles)} decoded tile${maps.tiles === 1 ? '' : 's'},
                 which are <em>not</em> in the total above: those sit in the browser's image
                 cache rather than on the JS heap.`
              : `Leaflet: no map open. A map exists only while its own tab does.`}<br>
          ${heap ? `Browser JS heap: ${fmtBytes(heap.used)} of ${fmtBytes(heap.limit)} limit.`
                 : `Browser JS heap: not available in this browser.`}<br>
          ${storageEstimate
              ? `Persisted storage: ${fmtBytes(storageEstimate.usage || 0)} of ${fmtBytes(storageEstimate.quota || 0)} quota.`
              : `Persisted storage: checking…`}
        </p>
        <div class="modal-foot">
          <button onclick="MemMeter.closePanel()">Close</button>
        </div>
      </div>`;
  }

  // ── release ──
  // Terrain and ARRO have their own reset logic already (Terrain.clear(),
  // ArroData.clearAll()); ACMA/RFC's is here because nothing else needed a
  // "drop everything and let it re-lazy-load" reset before now.

  function releaseAcma() {
    const A = state.acma, R = state.rfc;
    Object.assign(A, {
      loaded: false, loading: false, loadPromise: null, error: null,
      threats: null, dicts: null,
      flat: [], siteById: {}, anchorById: {}, pairsByDevice: {}, mechCounts: {},
      devLoaded: false, devPromise: null,
      deviceById: {}, devicesBySite: {}, licById: {}, clientById: {}, antById: {}, texts: [],
    });
    Object.assign(R, {
      loaded: false, loading: false, loadPromise: null, error: null,
      timeline: null, changes: null, snapshots: null,
    });
    ACMA_FILES.forEach(k => delete state.memBytes.files[k]);
    // Drops the map markers rather than leaving them orphaned. Since #143 the
    // Stations map only exists while its tab is open, so this guard is now
    // "Stations is the tab you are looking at" rather than "Stations has been
    // opened at some point" — and releasing from any other tab skips it. That
    // is the more correct of the two: from another tab there is no map and so
    // no markers to orphan, and re-entering Stations rebuilds the ACMA layer
    // from scratch off the now-empty state anyway.
    if (state.map) refreshAcmaLayer();
    renderMain();                        // RF Environment / RF Changes, if open, show "not loaded"
  }

  function releaseTerrain() {
    Terrain.clear();
    render();
  }

  function releaseArro() {
    ArroData.dropAll();   // both data tabs; confirms before dropping more than one
  }

  // The third of the three lists constraint 3 on #113 is about — HOLDERS, the
  // byte map in memoryReport() and this switch. There is no 'maps' case here on
  // purpose, and the reason is on the HOLDERS entry: the map goes when its tab
  // does, so the gesture already exists and it is not a button.
  function release(key) {
    if (key === 'acma') releaseAcma();
    else if (key === 'terrain') releaseTerrain();
    else if (key === 'arro') releaseArro();
    render();
    renderPanel();
  }

  return { start, render, togglePanel, closePanel, release };
})();
if (typeof window !== 'undefined') window.MemMeter = MemMeter;

