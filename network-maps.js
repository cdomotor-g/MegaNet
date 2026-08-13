// MegaNet — network-maps.js
//
//   Maps   the Radio Path Maps tab: a clickable Queensland drainage-basin map,
//          region / subregion / file navigation, an embedded PDF viewer, and
//          station-aware search over the catalogue.
//
// Named for the tab rather than for the module it exposes: a maps.js sitting
// beside maps-data.js and the maps/ directory would be three different things
// wearing one name.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// This is the one module of the ten with a real load-order dependency of its
// own: it reads its entire catalogue off window.MegaNetMaps at load, which
// maps-data.js sets. maps-data.js is above core.js in index.html, so that holds
// — but it is a constraint rather than a coincidence, and moving either file
// breaks it.
//
// Otherwise it reaches back to core.js for state, esc and escAttr. It has its
// own local slug(); core.js's is shadowed here, not used.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── RADIO PATH MAPS tab (formerly "Network Maps"; see #108) ─────────────────────
//
// Ports the legacy "ALERT Map Launcher v2.html" into MegaNet: a Queensland
// drainage-basin map with clickable regions, region/subregion/file navigation
// and an embedded PDF/image viewer. Adds station-aware search — type a station
// name, ALERT ID or site number and the tool suggests the relevant map(s).
//
// Data (catalogue, basin SVG, georeference) comes from maps-data.js, exposed as
// window.MegaNetMaps and loaded before this script.

const Maps = (function () {
  const MD = (typeof window !== 'undefined' && window.MegaNetMaps) || null;

  // Region fill palette (applied to basin polygons; readable on both themes).
  const REGION_COLOR = {
    'Far North':             '#2a9d8f',
    'Mackay / Whitsundays':  '#e76f51',
    'Burdekin / Townsville': '#457b9d',
    'Central QLD':           '#e9a92c',
    'Wide Bay / Burnett':    '#6aa84f',
    'SE QLD':                '#9b5de5',
    'West / South West':     '#d98b3a',
    'NSW Border':            '#8d99ae',
  };

  const mstate = {
    region:    localStorage.getItem('mn-maps-region') || 'All files',
    subregion: localStorage.getItem('mn-maps-sub')    || '_all',
    file:      localStorage.getItem('mn-maps-file')   || '',
    query:     '',
    basins:    null,   // [{name, region, pts:[[x,y],...]}]  parsed once
  };

  // ── catalogue helpers ─────────────────────────────────────────────────────────
  function regions()            { return MD ? MD.REGION_ORDER : ['All files']; }
  function subregions(region)   { return region === 'All files' ? [] : Object.keys((MD && MD.MAP_CATALOG[region]) || {}); }
  function regionFiles(region)  {
    if (!MD) return [];
    if (region === 'All files') return allFiles();
    return Object.values(MD.MAP_CATALOG[region] || {}).flat();
  }
  function allFiles() {
    if (!MD) return [];
    const seen = new Set();
    for (const r of MD.REGION_ORDER) {
      if (r === 'All files') continue;
      for (const f of regionFiles(r)) seen.add(f);
    }
    return [...seen];
  }
  function fileRegion(file) {
    if (!MD) return null;
    for (const r of MD.REGION_ORDER) {
      if (r === 'All files') continue;
      if (regionFiles(r).includes(file)) return r;
    }
    return null;
  }
  function fileSubregion(file) {
    if (!MD) return null;
    for (const r of MD.REGION_ORDER) {
      const groups = (MD.MAP_CATALOG[r]) || {};
      for (const [sub, files] of Object.entries(groups)) if (files.includes(file)) return sub;
    }
    return null;
  }
  function basinRegion(basinName) {
    if (!MD) return null;
    const slug = slugBasin(basinName);
    for (const [region, list] of Object.entries(MD.REGION_BASINS)) {
      if (list.some(b => slugBasin(b) === slug)) return region;
    }
    return null;
  }
  function slugBasin(v) {
    return String(v).toLowerCase().replace(/&apos;|&#39;/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ── files currently in view (region/subregion + text filter) ──────────────────
  function rawFiles() {
    if (mstate.region === 'All files') return allFiles();
    const data = (MD && MD.MAP_CATALOG[mstate.region]) || {};
    return mstate.subregion === '_all' ? Object.values(data).flat() : (data[mstate.subregion] || []);
  }
  function fileMatchesQuery(file, q) {
    if (!q) return true;
    const info = (MD && MD.FILE_INFO[file]) || {};
    const hay = [
      file,
      fileRegion(file) || '',
      fileSubregion(file) || '',
      ...(info.catchments || []),
      ...(info.aliases || []),
      ...(info.networks || []),
    ].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
  }
  function filteredFiles() { return rawFiles().filter(f => fileMatchesQuery(f, mstate.query)); }

  function ext(file)   { return file.split('.').pop().toUpperCase(); }
  function isImage(f)  { return /\.(png|jpe?g|gif|webp|svg)$/i.test(f); }
  // Resolve a catalogue filename to its on-disk location (files live in
  // per-region sub-folders under maps/, see maps-data.js FILE_PATH) and
  // URL-encode each path segment. Falls back to the bare name if unmapped.
  function encPath(f)  {
    const rel = (MD && MD.FILE_PATH && MD.FILE_PATH[f]) || f;
    return './' + rel.split('/').map(encodeURIComponent).join('/');
  }
  function fileTags(file) {
    const info = (MD && MD.FILE_INFO[file]) || {};
    const out = [ext(file)];
    const n = file.toLowerCase();
    if (n.includes('network to')) out.push('backbone');
    if (n.includes('old') || n.includes('blank')) out.push('legacy');
    if (n.includes('repeaters')) out.push('repeaters');
    if ((info.networks || []).length) out.push('net-linked');
    return out;
  }

  // ── station → map suggestion engine ───────────────────────────────────────────
  // Signals: (1) radio_network_id → map  [authoritative]
  //          (2) georeferenced point-in-basin → map/region  [approx ~34 km]
  //          (3) free-text keyword match against FILE_INFO
  //          (4) nearest region centroid  [coarse fallback]
  function lonLatToSvg(lon, lat) {
    const g = MD.BASIN_GEOREF;
    const det = g.ax * g.by - g.bx * g.ay;
    const x = ( g.by * (lon - g.cx) - g.bx * (lat - g.cy)) / det;
    const y = (-g.ay * (lon - g.cx) + g.ax * (lat - g.cy)) / det;
    return [x, y];
  }
  function parseBasins() {
    if (mstate.basins || !MD) return mstate.basins;
    const doc = new DOMParser().parseFromString(MD.QLD_BASIN_SVG, 'image/svg+xml');
    const out = [];
    doc.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const pts = (p.getAttribute('points') || '').trim().split(/\s+/).map(pair => {
        const [x, y] = pair.split(',').map(Number);
        return [x, y];
      }).filter(pt => pt.length === 2 && !isNaN(pt[0]) && !isNaN(pt[1]));
      if (name && pts.length > 2) out.push({ name, region: basinRegion(name), pts });
    });
    mstate.basins = out;
    return out;
  }
  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function basinOfStation(s) {
    if (!MD || s.lat == null || s.lon == null) return null;
    const [x, y] = lonLatToSvg(s.lon, s.lat);
    for (const b of parseBasins()) if (pointInPoly(x, y, b.pts)) return b;
    return null;
  }
  function nearestRegion(s) {
    if (!MD || s.lat == null || s.lon == null) return null;
    let best = null, bd = Infinity;
    for (const [region, c] of Object.entries(MD.REGION_CENTROIDS)) {
      const d = (c[0] - s.lat) ** 2 + (c[1] - s.lon) ** 2;
      if (d < bd) { bd = d; best = region; }
    }
    return best;
  }
  function stationTokens(s) {
    return (s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 2);
  }
  function mapsForStation(s) {
    if (!MD) return [];
    const scores = {};   // file -> {score, reasons:Set}
    const add = (file, score, reason) => {
      if (!file) return;
      const e = scores[file] || (scores[file] = { score: 0, reasons: new Set() });
      e.score = Math.max(e.score, score);
      e.reasons.add(reason);
    };
    // (1) radio network
    for (const net of (s.radio_network_ids || [])) {
      for (const f of (MD.NETWORK_FILES[net] || [])) add(f, 100, 'radio network ' + net);
    }
    // (2) basin (point-in-polygon)
    const basin = basinOfStation(s);
    let region = basin ? basin.region : null;
    if (basin) {
      const bslug = slugBasin(basin.name);
      let direct = false;
      for (const [file, info] of Object.entries(MD.FILE_INFO)) {
        if ((info.catchments || []).some(c => slugBasin(c) === bslug)) { add(file, 65, 'in ' + basin.name + ' catchment'); direct = true; }
      }
      if (region && !direct) for (const f of regionFiles(region)) add(f, 42, region + ' region (approx)');
    }
    // (3) keyword match on station name tokens
    const toks = stationTokens(s);
    if (toks.length) {
      for (const [file, info] of Object.entries(MD.FILE_INFO)) {
        const kw = [...(info.aliases || []), ...(info.catchments || [])].map(k => k.toLowerCase());
        const hit = toks.find(t => kw.some(k => k.includes(t) || t.includes(k)));
        if (hit) add(file, 55, "matches “" + hit + '”');
      }
    }
    // (4) region-centroid fallback if nothing yet
    if (!Object.keys(scores).length) {
      region = region || nearestRegion(s);
      if (region) for (const f of regionFiles(region)) add(f, 25, region + ' region (approx)');
    }
    return Object.entries(scores)
      .map(([file, e]) => ({ file, score: e.score, reasons: [...e.reasons] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  // ── station text search (name / ALERT ID / site number / id) ──────────────────
  function stationHaystack(s) {
    const ids = new Set();
    const a = s.alert_ids || {};
    Object.values(a).forEach(v => (Array.isArray(v) ? v : [v]).forEach(x => x != null && ids.add(String(x))));
    (s.sensors || []).forEach(se => se.alert_id != null && ids.add(String(se.alert_id)));
    const site = s.site || {};
    return {
      text: [s.name, s.id, s.station_number, site.number, site.name].filter(Boolean).join(' ').toLowerCase(),
      ids,
    };
  }
  function matchStations(query) {
    if (!state.data || !query) return [];
    const q = query.toLowerCase().trim();
    const scored = [];
    for (const s of state.data.stations) {
      const h = stationHaystack(s);
      let score = 0;
      if (h.ids.has(q)) score = 100;                                   // exact ALERT id / number
      else if (s.name && s.name.toLowerCase() === q) score = 95;       // exact name
      else if (s.name && s.name.toLowerCase().startsWith(q)) score = 80;
      else if (h.text.includes(q)) score = 60;
      else if ([...h.ids].some(id => id.includes(q)) && q.length >= 2) score = 40;
      if (score) scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).slice(0, 8);
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  function render() {
    if (!MD) {
      return `<div class="layout"><div class="panel"><h2 style="margin-top:0">Radio Path Maps</h2>
        <p class="warn-text">Map data module failed to load (<code>maps-data.js</code>). Check that it is present and loaded before <code>app.js</code>.</p></div></div>`;
    }
    return `
    <div class="maps-layout">
      <aside class="maps-left stack">
        <div class="panel">
          <div class="panel-header"><h3 style="margin:0">Find a map</h3>
            <span class="small" id="maps-total"></span></div>
          <div style="margin-top:.6rem">
            <input type="search" id="maps-search" placeholder="Map, catchment, town — or station name / ALERT ID…"
                   value="${esc(mstate.query)}" oninput="Maps.onSearch(this.value)">
          </div>
          <div class="small" style="margin-top:.4rem;color:var(--muted)">
            Browse by region below, or search a station (name, ALERT ID, site number) to get suggested maps.</div>
          <div id="maps-suggest"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><h3 style="margin:0">Queensland basins</h3>
            <button class="maps-reset" onclick="Maps.setRegion('All files')" title="Show all regions">Reset</button></div>
          <div id="maps-basin" class="maps-basin"></div>
          <div id="maps-region-chips" class="maps-chips" style="margin-top:.6rem"></div>
        </div>

        <div class="panel">
          <div id="maps-subregion-chips" class="maps-chips"></div>
          <div class="panel-header" style="margin-top:.5rem">
            <strong id="maps-list-title"></strong>
            <span class="small" id="maps-list-count"></span></div>
          <ul id="maps-file-list" class="maps-file-list"></ul>
        </div>
      </aside>

      <div class="panel maps-viewer-panel">
        <div class="maps-viewer-toolbar">
          <div style="min-width:0">
            <strong id="maps-current-file" style="display:block">No map open</strong>
            <span class="small" id="maps-current-path" style="word-break:break-all"></span>
          </div>
          <div class="button-row" style="flex-wrap:nowrap">
            <button onclick="Maps.step(-1)" title="Previous map">‹ Prev</button>
            <button onclick="Maps.step(1)" title="Next map">Next ›</button>
            <a id="maps-newtab" class="maps-newtab" target="_blank" rel="noopener">Open in new tab ↗</a>
          </div>
        </div>
        <div id="maps-viewer" class="maps-viewer">
          <div class="maps-empty">Select a map from the list, or search for a station to get a suggestion.</div>
        </div>
      </div>
    </div>`;
  }

  function init() {
    if (!MD) return;
    injectBasinMap();
    renderRegionChips();
    renderSubregionChips();
    renderList();
    renderSuggestions();
    updateTotal();
    if (mstate.file && allFiles().includes(mstate.file)) openFile(mstate.file, false);
  }

  function updateTotal() {
    const el = document.getElementById('maps-total');
    if (el) el.textContent = allFiles().length + ' maps';
  }

  function injectBasinMap() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    host.innerHTML = MD.QLD_BASIN_SVG;
    const svg = host.querySelector('svg');
    if (!svg) return;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('maps-basin-svg');
    svg.querySelector('rect')?.remove();                     // drop the white backdrop
    svg.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const region = basinRegion(name);
      p.dataset.region = region || '';
      p.dataset.basin = name;
      const col = region ? REGION_COLOR[region] : null;
      p.style.fill = col || 'var(--muted)';
      p.style.fillOpacity = region ? '0.32' : '0.06';
      p.style.stroke = col || 'var(--border)';
      p.style.strokeOpacity = '0.85';
      p.style.cursor = region ? 'pointer' : 'default';
      if (region) {
        p.addEventListener('click', () => setRegion(region));
        p.addEventListener('mouseenter', () => { p.style.fillOpacity = '0.6'; });
        p.addEventListener('mouseleave', () => applyRegionHighlight());
      }
    });
    applyRegionHighlight();
  }

  function applyRegionHighlight() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    const active = mstate.region;
    host.querySelectorAll('polygon').forEach(p => {
      const region = p.dataset.region;
      if (!region) return;
      const on = active === 'All files' || region === active;
      p.style.fillOpacity = on ? (active !== 'All files' && region === active ? '0.62' : '0.32') : '0.08';
      p.style.strokeOpacity = on ? '0.9' : '0.3';
    });
  }

  function renderRegionChips() {
    const el = document.getElementById('maps-region-chips');
    if (!el) return;
    el.innerHTML = regions().map(r => {
      const count = r === 'All files' ? allFiles().length : regionFiles(r).length;
      const hint = (MD.REGION_HINTS[r]) ? `<span class="maps-chip-hint">${esc(MD.REGION_HINTS[r])}</span>` : '';
      const dot = r !== 'All files' && REGION_COLOR[r]
        ? `<span class="maps-chip-dot" style="background:${REGION_COLOR[r]}"></span>` : '';
      return `<button class="maps-chip${r === mstate.region ? ' active' : ''}" onclick="Maps.setRegion('${escAttr(r)}')">
        ${dot}${esc(r)}<span class="maps-count">${count}</span>${hint}</button>`;
    }).join('');
  }

  function renderSubregionChips() {
    const el = document.getElementById('maps-subregion-chips');
    if (!el) return;
    const subs = subregions(mstate.region);
    if (!subs.length) { el.innerHTML = ''; return; }
    let html = `<button class="maps-chip${mstate.subregion === '_all' ? ' active' : ''}" onclick="Maps.setSubregion('_all')">All in region</button>`;
    html += subs.map(sub =>
      `<button class="maps-chip${mstate.subregion === sub ? ' active' : ''}" onclick="Maps.setSubregion('${escAttr(sub)}')">
        ${esc(sub)}<span class="maps-count">${(MD.MAP_CATALOG[mstate.region][sub] || []).length}</span></button>`
    ).join('');
    el.innerHTML = html;
  }

  function renderList() {
    const el = document.getElementById('maps-file-list');
    const titleEl = document.getElementById('maps-list-title');
    const countEl = document.getElementById('maps-list-count');
    if (!el) return;
    const files = filteredFiles();
    if (titleEl) titleEl.textContent = mstate.region + (mstate.subregion !== '_all' ? ' · ' + mstate.subregion : '');
    if (countEl) countEl.textContent = `${files.length} / ${rawFiles().length}`;
    if (!files.length) {
      el.innerHTML = `<li class="maps-file"><div class="maps-file-name small">No maps match “${esc(mstate.query)}”.</div></li>`;
      return;
    }
    el.innerHTML = files.map(f => {
      const badges = fileTags(f).map(t => `<span class="badge maps-badge">${esc(t)}</span>`).join('');
      return `<li class="maps-file${f === mstate.file ? ' selected' : ''}">
        <div style="min-width:0">
          <div class="maps-file-name">${esc(f)}</div>
          <div class="maps-badges">${badges}</div>
        </div>
        <div class="maps-file-actions">
          <button onclick="Maps.openFile('${escAttr(f)}')">Open</button>
          <a class="maps-newtab" href="${encPath(f)}" target="_blank" rel="noopener">↗</a>
        </div></li>`;
    }).join('');
  }

  function renderSuggestions() {
    const el = document.getElementById('maps-suggest');
    if (!el) return;
    const q = mstate.query.trim();
    if (!q) { el.innerHTML = ''; return; }
    if (!state.data) {
      el.innerHTML = `<div class="maps-suggest-note small">Load <strong>stations.json</strong> to search by station name / ALERT ID.</div>`;
      return;
    }
    const matches = matchStations(q);
    if (!matches.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="maps-suggest-note small">Stations matching “${esc(q)}” → suggested maps:</div>` +
      matches.map(({ s }) => {
        const maps = mapsForStation(s);
        const aid = [...stationHaystack(s).ids].slice(0, 4).join(', ');
        const chips = maps.length
          ? maps.map(m => `<button class="maps-suggest-map" title="${escAttr(m.reasons.join('; '))}" onclick="Maps.openFile('${escAttr(m.file)}')">${esc(m.file)}</button>`).join('')
          : `<span class="small" style="color:var(--muted)">no map match — try browsing the region</span>`;
        return `<div class="maps-suggest-item">
          <div class="maps-suggest-station">${esc(s.name)}
            ${aid ? `<span class="small" style="color:var(--muted)">· ALERT ${esc(aid)}</span>` : ''}</div>
          <div class="maps-suggest-maps">${chips}</div>
        </div>`;
      }).join('');
  }

  // ── actions ───────────────────────────────────────────────────────────────────
  function setRegion(region) {
    mstate.region = region;
    mstate.subregion = '_all';
    localStorage.setItem('mn-maps-region', region);
    localStorage.setItem('mn-maps-sub', '_all');
    renderRegionChips(); renderSubregionChips(); renderList(); applyRegionHighlight();
  }
  function setSubregion(sub) {
    mstate.subregion = sub;
    localStorage.setItem('mn-maps-sub', sub);
    renderSubregionChips(); renderList();
  }
  function onSearch(v) {
    mstate.query = v;
    renderList(); renderSuggestions();
  }
  // A4/A3 (and every ISO A-series) page shares a 1:√2 ratio — used as the
  // viewer's default shape until a file's real page size is known.
  const A4_RATIO = 1 / Math.SQRT2;
  const pdfAspectCache = new Map(); // file -> width/height ratio (or null if undetectable)

  function setViewerAspect(ratio) {
    const host = document.getElementById('maps-viewer');
    if (!host) return;
    if (ratio && isFinite(ratio) && ratio > 0) host.style.setProperty('--maps-aspect', String(ratio));
    else host.style.removeProperty('--maps-aspect');
  }

  // Reads just enough of the PDF to find its first /MediaBox (and any
  // /Rotate) so the viewer can be sized to the map's real page proportions
  // instead of a guessed default.
  async function loadPdfAspect(file, path) {
    if (pdfAspectCache.has(file)) return;
    try {
      const res = await fetch(path);
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('latin1').decode(buf);
      const m = text.match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/);
      let ratio = null;
      if (m) {
        let w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
        let h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
        const rot = text.match(/\/Rotate\s+(-?\d+)/);
        if (rot) {
          const deg = ((parseInt(rot[1], 10) % 360) + 360) % 360;
          if (deg === 90 || deg === 270) [w, h] = [h, w];
        }
        if (w > 0 && h > 0) ratio = w / h;
      }
      pdfAspectCache.set(file, ratio);
      if (mstate.file === file) setViewerAspect(ratio || A4_RATIO);
    } catch (e) {
      // Fetch/parse failure: the A4 fallback aspect ratio already applied stands.
    }
  }

  function openFile(file, scroll = true) {
    mstate.file = file;
    localStorage.setItem('mn-maps-file', file);
    const host = document.getElementById('maps-viewer');
    const nameEl = document.getElementById('maps-current-file');
    const pathEl = document.getElementById('maps-current-path');
    const linkEl = document.getElementById('maps-newtab');
    const path = encPath(file);
    if (nameEl) nameEl.textContent = file;
    if (pathEl) pathEl.textContent = path;
    if (linkEl) linkEl.href = path;
    if (host) {
      if (isImage(file)) {
        host.innerHTML = `<img class="maps-view-img" alt="${escAttr(file)}" src="${path}">`;
        setViewerAspect(null);
        const img = host.querySelector('img');
        if (img) img.addEventListener('load', () => {
          if (mstate.file === file && img.naturalWidth && img.naturalHeight) {
            setViewerAspect(img.naturalWidth / img.naturalHeight);
          }
        }, { once: true });
      } else {
        host.innerHTML = `<iframe class="maps-view-frame" src="${path}#view=FitH" title="${escAttr(file)}"></iframe>`;
        setViewerAspect(pdfAspectCache.get(file) || A4_RATIO);
        loadPdfAspect(file, path);
      }
    }
    renderList();
    if (scroll && host) host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function step(delta) {
    const files = filteredFiles();
    if (!files.length) return;
    const i = Math.max(0, files.indexOf(mstate.file));
    openFile(files[(i + delta + files.length) % files.length]);
  }

  return { render, init, setRegion, setSubregion, onSearch, openFile, step };
})();

