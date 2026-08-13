// MegaNet — mem-meter.js
//
//   MemMeter   the thin bar under the header and the panel behind it: what this
//              page is holding, and a way to give some of it back (#79).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state and esc; across to app.js for renderMain,
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

  function heapInfo() {
    const m = performance && performance.memory;
    return m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null;
  }

  function memoryReport() {
    const bytes = {
      stations: state.memBytes.stationsJson,
      acma:     acmaFileBytes(),
      terrain:  Terrain.cached() * TERRAIN_TILE_BYTES,
      arro:     arroBytes(),
      a2:       (state.a2.text || '').length * 2,
      storage:  localStorageBytes(),
    };
    const holders = HOLDERS.map(h => ({ ...h, bytes: bytes[h.key] }));
    return { holders, total: holders.reduce((s, h) => s + h.bytes, 0), heap: heapInfo() };
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
    document.addEventListener('keydown', onKey);
    if (!storageEstimate && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(e => { storageEstimate = e; renderPanel(); }).catch(() => {});
    }
  }

  function onKey(e) { if (e.key === 'Escape') closePanel(); }

  function closePanel() {
    panelOpen = false;
    const root = document.getElementById('mem-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
  }

  function renderPanel() {
    const root = document.getElementById('mem-modal');
    if (!root || !panelOpen) return;
    const { holders, total, heap } = memoryReport();
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
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="mem-title">Memory this page is holding</h2>
          <button class="modal-x" title="Close (Esc)" onclick="MemMeter.closePanel()">×</button>
        </div>
        <p class="sub">Our own accounting of what MegaNet is keeping in memory — cheap to compute
           (lengths recorded when each piece loaded), not a walk of the object graph. Estimates,
           not exact byte counts.</p>
        <table class="mem-table">
          <thead><tr><th>Holder</th><th>Estimate</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>Total (our accounting)</td><td class="mem-bytes">${fmtBytes(total)}</td><td></td></tr></tfoot>
        </table>
        <p class="mem-heap">
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
    if (state.map) refreshAcmaLayer();   // drops the map markers rather than leaving them orphaned
    renderMain();                        // RF Environment / RF Changes, if open, show "not loaded"
  }

  function releaseTerrain() {
    Terrain.clear();
    render();
  }

  function releaseArro() {
    ArroData.dropAll();   // both data tabs; confirms before dropping more than one
  }

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

