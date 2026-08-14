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
//
// ── U2 (#137): layout, mobile and accessibility ──────────────────────────────
// The biggest of #137's three tabs and the one with the most to fix. What
// changed, and why each one is a rule rather than a repair:
//
//   The left column is a named landmark. It is an <aside> inside <main>, which
//   a screen reader lists as an unnamed complementary region — #109's own shell
//   check names this tab as one of five owing that label (shell.mjs, §4).
//
//   The basin drawing is a shortcut, and is now labelled as one. Its polygons
//   were click-only: no tab stop, no name, no keyboard route. Making a hundred
//   basins into a hundred tab stops would be worse than the problem, and it is
//   unnecessary — every action the drawing offers (setRegion) is already on a
//   named button in the region-chip row directly beneath it. So the drawing is
//   role="img" with a name that carries the headline number, and the chips are
//   the operable path. That is pattern 8 in docs/design-system.md, and the
//   condition it states is checked rather than assumed: `npm run tabs` fails if
//   a region on the drawing has no chip.
//
//   Region colours became tokens. Eight literal hex values lived in
//   REGION_COLOR and were written into `polygon.style.fill` and into a chip's
//   inline `background`. They are --maps-region-* now, with dark values, and
//   the JS sets a custom property rather than a colour — so the drawing follows
//   the theme, which it previously did not.
//
//   Every icon-only control got a name. "Open" ×N in the file list, a bare "↗"
//   anchor per row and another in the toolbar, all of which a screen reader
//   read as "Open, button" or "link, ↗". Each carries the file name now.
//
//   The search box got a label, the viewer's "open in new tab" link stops
//   pointing at nothing before a map is open, and opening a map announces
//   itself — the result of something the user did, which is rule 1.

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

  // Region fill palette. The eight values themselves live in styles.css as
  // --maps-region-* tokens with a dark-theme set (#137); what is held here is
  // the mapping from a region's name to the token that colours it, so the JS
  // hands out `var(--maps-region-far-north)` and never a colour. A basin fill
  // and the chip dot beside it then resolve the same token, and both follow the
  // theme — which the eight literals did not.
  const REGION_VAR = {
    'Far North':             'var(--maps-region-far-north)',
    'Mackay / Whitsundays':  'var(--maps-region-mackay)',
    'Burdekin / Townsville': 'var(--maps-region-burdekin)',
    'Central QLD':           'var(--maps-region-central)',
    'Wide Bay / Burnett':    'var(--maps-region-widebay)',
    'SE QLD':                'var(--maps-region-seqld)',
    'West / South West':     'var(--maps-region-west)',
    'NSW Border':            'var(--maps-region-nsw)',
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
      return `<div class="layout"><div class="panel"><div class="panel-header"><h2>Radio Path Maps</h2></div>
        <p class="warn-text">Map data module failed to load (<code>maps-data.js</code>). Check that it is present and loaded before <code>app.js</code>.</p></div></div>`;
    }
    return `
    <div class="maps-layout">
      <aside class="maps-left stack" aria-label="Find a map">
        <div class="panel">
          <div class="panel-header"><h2>Find a map</h2>
            <span class="small" id="maps-total"></span></div>
          <label class="maps-search-label" for="maps-search">
            Search maps and stations
            <input type="search" id="maps-search" placeholder="Map, catchment, town — or station name / ALERT ID…"
                   value="${esc(mstate.query)}" oninput="Maps.onSearch(this.value)">
          </label>
          <p class="small maps-hint">
            Browse by region below, or search a station (name, ALERT ID, site number) to get suggested maps.</p>
          <div id="maps-suggest"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><h2>Queensland basins</h2>
            <button class="maps-reset" onclick="Maps.setRegion('All files')" title="Show all regions">Reset</button></div>
          <div id="maps-basin" class="maps-basin"></div>
          <div id="maps-region-chips" class="maps-chips maps-chips-spaced"></div>
        </div>

        <div class="panel">
          <div id="maps-subregion-chips" class="maps-chips"></div>
          <div class="panel-header maps-list-header">
            <h2 id="maps-list-title"></h2>
            <span class="small" id="maps-list-count"></span></div>
          <ul id="maps-file-list" class="maps-file-list" aria-labelledby="maps-list-title"></ul>
        </div>
      </aside>

      <div class="panel maps-viewer-panel">
        <div class="maps-viewer-toolbar">
          <div class="maps-current">
            <strong id="maps-current-file">No map open</strong>
            <span class="small" id="maps-current-path"></span>
          </div>
          <div class="button-row maps-toolbar-actions">
            <button onclick="Maps.step(-1)" title="Previous map">‹ Prev</button>
            <button onclick="Maps.step(1)" title="Next map">Next ›</button>
            <a id="maps-newtab" class="maps-newtab" target="_blank" rel="noopener" hidden>Open in new tab ↗</a>
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

  // The drawing is a shortcut for the chip row underneath it, and is named as
  // one (pattern 8). role="img" plus a name carrying the headline number, and
  // the polygons stay out of the tab order — a hundred basins would be a
  // hundred stops for an operation that is already on eight labelled buttons.
  // Every state a polygon can be in is a data-state now, so the opacities and
  // the hover live in styles.css with the rest of the tab.
  function injectBasinMap() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    host.innerHTML = MD.QLD_BASIN_SVG;
    const svg = host.querySelector('svg');
    if (!svg) return;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('maps-basin-svg');
    svg.setAttribute('role', 'img');
    svg.querySelector('rect')?.remove();                     // drop the white backdrop
    let mapped = 0;
    svg.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const region = basinRegion(name);
      p.dataset.region = region || '';
      p.dataset.basin = name;
      p.style.setProperty('--basin', region ? REGION_VAR[region] : 'var(--muted)');
      if (region) {
        mapped++;
        p.addEventListener('click', () => setRegion(region));
      }
    });
    svg.setAttribute('aria-label',
      `Queensland drainage basins — ${mapped} of them across ${regions().length - 1} regions, `
      + 'coloured by region. Picking a basin filters the map list to its region, which the '
      + 'region buttons below do as well.');
    applyRegionHighlight();
  }

  function applyRegionHighlight() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    const active = mstate.region;
    host.querySelectorAll('polygon').forEach(p => {
      const region = p.dataset.region;
      if (!region) { p.dataset.state = 'unmapped'; return; }
      if (active === 'All files') p.dataset.state = 'on';
      else p.dataset.state = region === active ? 'active' : 'off';
    });
  }

  function renderRegionChips() {
    const el = document.getElementById('maps-region-chips');
    if (!el) return;
    el.innerHTML = regions().map(r => {
      const count = r === 'All files' ? allFiles().length : regionFiles(r).length;
      const hint = (MD.REGION_HINTS[r]) ? `<span class="maps-chip-hint">${esc(MD.REGION_HINTS[r])}</span>` : '';
      // The dot is a token override rather than a colour written onto the
      // element — the same shape as .page's --page-max, and the reason the
      // theme reaches it.
      const dot = r !== 'All files' && REGION_VAR[r]
        ? `<span class="maps-chip-dot" style="--dot:${REGION_VAR[r]}"></span>` : '';
      // Two things the visible content cannot do on its own. aria-pressed,
      // because "active" is a look and a toggle that only looks pressed is not
      // pressed as far as a screen reader is concerned. And an explicit name,
      // because the label and the count are adjacent text nodes with no space
      // between them — the computed name was "Far North5", which is a region
      // nobody has heard of.
      const n = `${r}, ${count} map${count === 1 ? '' : 's'}`;
      return `<button class="maps-chip${r === mstate.region ? ' active' : ''}" data-region="${escAttr(r)}"
        aria-pressed="${r === mstate.region}" aria-label="${escAttr(n)}"
        onclick="Maps.setRegion('${escAttr(r)}')">
        ${dot}${esc(r)}<span class="maps-count">${count}</span>${hint}</button>`;
    }).join('');
  }

  function renderSubregionChips() {
    const el = document.getElementById('maps-subregion-chips');
    if (!el) return;
    const subs = subregions(mstate.region);
    if (!subs.length) { el.innerHTML = ''; return; }
    let html = `<button class="maps-chip${mstate.subregion === '_all' ? ' active' : ''}"
      aria-pressed="${mstate.subregion === '_all'}" onclick="Maps.setSubregion('_all')">All in region</button>`;
    html += subs.map(sub => {
      const n = (MD.MAP_CATALOG[mstate.region][sub] || []).length;
      return `<button class="maps-chip${mstate.subregion === sub ? ' active' : ''}"
        aria-pressed="${mstate.subregion === sub}"
        aria-label="${escAttr(`${sub}, ${n} map${n === 1 ? '' : 's'}`)}"
        onclick="Maps.setSubregion('${escAttr(sub)}')">
        ${esc(sub)}<span class="maps-count">${n}</span></button>`;
    }).join('');
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
    // Both controls carry the file name. "Open" repeated forty times and a bare
    // "↗" are what a screen reader was given to choose between; the name is
    // sr-only so the row still reads as a name with two small buttons.
    el.innerHTML = files.map(f => {
      const badges = fileTags(f).map(t => `<span class="badge maps-badge">${esc(t)}</span>`).join('');
      const open = f === mstate.file;
      return `<li class="maps-file${open ? ' selected' : ''}"${open ? ' aria-current="true"' : ''}>
        <div class="maps-file-main">
          <div class="maps-file-name">${esc(f)}</div>
          <div class="maps-badges">${badges}</div>
        </div>
        <div class="maps-file-actions">
          <button onclick="Maps.openFile('${escAttr(f)}')">Open<span class="sr-only"> ${esc(f)} in the viewer</span></button>
          <a class="maps-newtab" href="${encPath(f)}" target="_blank" rel="noopener"
             ><span aria-hidden="true">↗</span><span class="sr-only">Open ${esc(f)} in a new tab</span></a>
        </div></li>`;
    }).join('');
  }

  function renderSuggestions() {
    const el = document.getElementById('maps-suggest');
    if (!el) return;
    const q = mstate.query.trim();
    if (!q) { el.innerHTML = ''; return; }
    if (!state.data) {
      el.innerHTML = '<p class="maps-suggest-note small">Load <strong>stations.json</strong> to search by station name / ALERT ID.</p>';
      return;
    }
    const matches = matchStations(q);
    if (!matches.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<p class="maps-suggest-note small">Stations matching “${esc(q)}” → suggested maps:</p>` +
      matches.map(({ s }) => {
        const maps = mapsForStation(s);
        const aid = [...stationHaystack(s).ids].slice(0, 4).join(', ');
        const chips = maps.length
          ? maps.map(m => `<button class="maps-suggest-map" title="${escAttr(m.reasons.join('; '))}"
              aria-label="Open ${escAttr(m.file)} — suggested because ${escAttr(m.reasons.join('; '))}"
              onclick="Maps.openFile('${escAttr(m.file)}')">${esc(m.file)}</button>`).join('')
          : '<span class="small">no map match — try browsing the region</span>';
        return `<div class="maps-suggest-item">
          <div class="maps-suggest-station">${esc(s.name)}
            ${aid ? `<span class="small">· ALERT ${esc(aid)}</span>` : ''}</div>
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
    // Hidden until there is somewhere to go: an <a> with no href is not a link
    // at all, so before the first map opened this was a tab stop that read as
    // "Open in new tab" and did nothing.
    if (linkEl) {
      linkEl.href = path;
      linkEl.hidden = false;
      linkEl.setAttribute('aria-label', 'Open ' + file + ' in a new tab');
    }
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
    // The viewer is an <iframe> or an <img>, neither of which says anything on
    // its own — and on a phone it is below the fold. Announced only when the
    // user asked for it: the restore-from-localStorage call passes scroll=false
    // and is not the result of anything anybody just did (rule 1).
    if (scroll) announce('Opened ' + file);
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

