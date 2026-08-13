// MegaNet — bit-flipper.js
//
//   renderBitFlipperHtml   the Bit Flipper tab: which ALERT addresses are one
//   initBitFlipperMap      or more bit-flips away from the one you typed, and
//   and the bit            where those stations are on the map.
//   arithmetic behind them
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, ROLE_COLOR, ARRO_DEFAULT_BASE,
// buildArroUrl and buildSensorIndex — the last three hosted here for five other
// sections until M1 (#132) moved them out, which is what let this module leave
// on its own. Across to app.js for addBaseLayers, primaryRole,
// findRepeaterMatches and repeaterPassingCount.
//
// For the record, since #134's body says otherwise and someone will read it:
// this module carries no NUL bytes and never has. All three of app.js's were in
// NetworkView and are now in network-view.js — the issue misread a section
// boundary. See the correction comment on #134.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── BIT FLIPPER tab ────────────────────────────────────────────────────────────

const BF_MAX_RENDER_ROWS = 2000;   // safety cap for very large N-bit expansions
// Station of interest — the entered address. Ties the pinned table row (see
// .bf-row-base in styles.css) to its highlighted pin on the map below.
const BF_BASE_COLOR      = '#ff8c00';

// All combinations of `k` bit positions chosen from 0..width-1 (lexicographic).
function bitCombos(width, k) {
  const res = [];
  (function rec(start, combo) {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < width; i++) { combo.push(i); rec(i + 1, combo); combo.pop(); }
  })(0, []);
  return res;
}

function bfBaseId() {
  const id = parseInt(state.bfInput, 10);
  return (!isNaN(id) && id > 0 && id < 65536) ? id : null;
}

function bfBitsToFlip() {
  const n = parseInt(state.bfBits, 10);
  if (isNaN(n) || n < 1) return 1;
  return Math.min(n, 16);
}

// Compute flip variants for the current input:
// [{ bits:[...], value, binary, matches:[{station,sensor}] }] in bit-combo order.
function bfComputeVariants(idx) {
  const base = bfBaseId();
  if (base == null) return [];
  idx = idx || buildSensorIndex();
  const variants = [];
  for (const combo of bitCombos(16, bfBitsToFlip())) {
    let v = base;
    for (const b of combo) v ^= (1 << b);
    if (v <= 0 || v >= 65536 || v === base) continue;
    variants.push({ bits: combo, value: v, binary: v.toString(2).padStart(16, '0'), matches: idx.get(v) || [] });
  }
  return variants;
}

// Collapse duplicate matches so a sensor isn't repeated once per duplicate
// stations.json entry that shares a name (some sites appear twice in the data).
function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const k = `${m.station.name}|${m.sensor.type}|${m.sensor.sensor_id}|${m.sensor.device_id}|${m.sensor.alert_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

// Static shell — rendered once when the tab opens. Control inputs live here and
// are NOT re-rendered on keystrokes, so focus is never stolen; only #bf-results
// updates as the user types.
function renderBitFlipperHtml() {
  return `
    <div style="max-width:1000px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Bit Flipper</h2></div>
        <p class="small" style="color:var(--muted);margin:.5rem 0">
          Enter an ALERT decimal address to see its bit-flip variants and cross-reference them
          against the station database. Sensor type, Sensor ID and ARRO graph links are sourced
          from the enriched station data.
        </p>
        <div id="bf-controls" style="display:flex;flex-wrap:wrap;gap:1rem 1.25rem;align-items:flex-end;margin-top:.5rem">
          <label style="font-size:.9rem;color:var(--muted)">
            ALERT decimal address
            <input id="bf-addr" type="number" min="1" max="65535" value="${esc(state.bfInput)}" placeholder="e.g. 6129"
                   style="width:170px;margin-top:.3rem;display:block"
                   oninput="onBfAddrInput(this.value)">
          </label>
          <label style="font-size:.9rem;color:var(--muted)">
            Bits to flip
            <input id="bf-bits" type="number" min="1" max="16" value="${esc(String(bfBitsToFlip()))}"
                   style="width:100px;margin-top:.3rem;display:block"
                   oninput="onBfBitsInput(this.value)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);display:flex;gap:.4rem;align-items:center;padding-bottom:.4rem">
            <input id="bf-only" type="checkbox" ${state.bfOnlyMatches ? 'checked' : ''}
                   onchange="onBfOnlyMatches(this.checked)">
            Show only matched addresses
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:1;min-width:240px"
                 title="Its host is what every ARRO link in the app is built on — map popups, the station editor and the ARRO Launcher tab included">
            ARRO base URL <span style="font-weight:400">— sets the host app-wide</span>
            <input id="bf-arro" type="text" value="${esc(state.bfArroBase || ARRO_DEFAULT_BASE)}"
                   style="width:100%;margin-top:.3rem;display:block"
                   oninput="onBfArroInput(this.value)">
          </label>
        </div>
      </div>

      <div id="bf-results">${renderBitFlipperResults()}</div>

      <div class="panel">
        <div class="panel-header"><h3>Map</h3></div>
        <div id="bf-map" style="height:420px;border-radius:6px;margin-top:.5rem"></div>
      </div>
    </div>`;
}

// Dynamic output — recomputed and re-rendered into #bf-results on every input.
function renderBitFlipperResults() {
  const base = bfBaseId();
  if (base == null) {
    return `<div class="panel"><p class="small" style="color:var(--muted)">Enter a valid ALERT address (1–65535) above.</p></div>`;
  }

  const idx      = buildSensorIndex();
  const variants = bfComputeVariants(idx);
  const filter   = state.bfSensorFilter || '';
  const matchPasses = m => !filter || m.sensor.type === filter;
  const rowMatches  = v => v.matches.filter(matchPasses);

  // Station of interest: the exact match on the entered address (no bits
  // flipped). Pinned to the top of the table and always ARRO-linked so the
  // owning station is shown alongside its bit-flip neighbours.
  const baseRow = {
    isBase: true, bits: null, value: base,
    binary: base.toString(2).padStart(16, '0'),
    matches: idx.get(base) || [],
  };

  // sensor types present among matches (for the filter dropdown)
  const types = [...new Set([baseRow, ...variants].flatMap(v => v.matches.map(m => m.sensor.type)))].sort();

  // rows to display
  let rows;
  if (filter)                    rows = variants.filter(v => rowMatches(v).length);
  else if (state.bfOnlyMatches)  rows = variants.filter(v => v.matches.length);
  else                           rows = variants;

  const totalToShow = rows.length;
  const truncated   = rows.length > BF_MAX_RENDER_ROWS;
  if (truncated) rows = rows.slice(0, BF_MAX_RENDER_ROWS);

  // Pin the station-of-interest row at the top. It is exempt from the sensor
  // filter — that filter narrows the flip variants being compared against the
  // entered address, not the address itself — so it stays listed, and fully
  // populated, alongside the ARRO link that always graphs it. With no station
  // behind the address at all there is nothing to pin but the bits, so the
  // "only matched" rule still applies.
  const showBase = baseRow.matches.length ? true : !state.bfOnlyMatches && !filter;
  if (showBase) rows = [baseRow, ...rows];

  const matchedCount = variants.filter(v => v.matches.length).length;

  // ARRO link across the station of interest plus every matched flip-variant
  // sensor that passes the current filter. The station of interest is never
  // filtered out — the sensor filter narrows what you compare it against, not
  // the address you actually asked about.
  const arroPairs = [...baseRow.matches, ...variants.flatMap(v => v.matches.filter(matchPasses))];
  const arro = buildArroUrl(arroPairs);

  const rowsHtml = rows.map(v => {
    const ms  = dedupeMatches(v.isBase ? v.matches : rowMatches(v));
    const hit = ms.length > 0;
    const dash = '<span style="color:var(--muted)">—</span>';
    const stationBadges = hit
      ? [...new Set(ms.map(m => m.station.name))].map(n => `<span class="badge">${esc(n)}</span>`).join(' ')
      : dash;
    const sensorTypes = hit ? ms.map(m => esc(m.sensor.type)).join('<br>') : dash;
    const sensorIds   = hit ? ms.map(m => esc(m.sensor.sensor_id || '—')).join('<br>') : dash;
    const reps = hit
      ? [...new Map(ms.flatMap(m => findRepeaterMatches(m.station)).map(r => [r.id, r])).values()]
      : [];
    const repHtml = reps.length
      ? reps.map(r => {
          const n = repeaterPassingCount(r);
          return `<span class="badge badge--repeater" title="${n != null ? `passing ${n} ALERT addresses` : 'no pass ranges recorded'}">${esc(r.name)}</span>`;
        }).join(' ')
      : dash;
    // The pinned, tinted row is the station of interest — it says so in the
    // tooltip rather than in the cell, which otherwise steals width from the
    // station, sensor and repeater columns that need it.
    const bitsCell = v.isBase
      ? `<span title="Station of interest — the ALERT address you entered">NA</span>`
      : v.bits.join(', ');
    return `
      <tr${v.isBase ? ' class="bf-row-base"' : ''}>
        <td class="small mono">${bitsCell}</td>
        <td>${v.value}</td>
        <td class="small mono">${v.binary}</td>
        <td style="text-align:center">${hit ? '✓' : ''}</td>
        <td>${stationBadges}</td>
        <td class="small">${sensorTypes}</td>
        <td class="small mono">${sensorIds}</td>
        <td>${repHtml}</td>
      </tr>`;
  }).join('');

  return `
    <div class="panel">
      <div class="panel-header" style="flex-wrap:wrap;gap:.5rem">
        <h3>Bit-Flip Variants</h3>
        <span class="small" style="color:var(--muted)">
          ${variants.length} variant${variants.length === 1 ? '' : 's'} · ${matchedCount} matched
        </span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:center;margin:.5rem 0">
        ${types.length ? `
          <label class="small" style="color:var(--muted)">Filter by sensor:
            <select onchange="onBfSensorFilter(this.value)" style="margin-left:.3rem">
              <option value=""${!filter ? ' selected' : ''}>All sensors</option>
              ${types.map(t => `<option value="${esc(t)}"${filter === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </label>` : ''}
        <span id="bf-arro-link">${arro
          ? `<a href="${esc(arro.url)}" target="_blank" rel="noopener">Open ARRO graph (${arro.count} sensor${arro.count === 1 ? '' : 's'})</a>`
          : `<span class="small" style="color:var(--muted)">No ARRO-linkable sensors in current matches</span>`}</span>
      </div>
      ${truncated ? `<p class="small" style="color:#b8860b">Showing first ${BF_MAX_RENDER_ROWS} of ${totalToShow} rows — reduce the bit count or use the sensor filter to narrow.</p>` : ''}
      ${rows.length ? `
        <div class="table-wrap tall">
          <table class="bf-table">
            <colgroup>
              <col style="width:8%"><col style="width:8%"><col style="width:13%"><col style="width:5%">
              <col style="width:24%"><col style="width:10%"><col style="width:15%"><col style="width:17%">
            </colgroup>
            <thead><tr>
              <th>Bit(s)</th><th>Decimal</th><th>Binary</th><th>Match</th>
              <th>Station(s)</th><th>Sensor</th><th>Sensor ID</th><th>Repeater(s)</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`
      : `<p class="small" style="color:var(--muted)">No ${filter ? esc(filter) + ' ' : ''}matches for these variants.</p>`}
    </div>`;
}

// ── Bit Flipper event handlers ──────────────────────────────────────────────
// Each handler updates only #bf-results (never the control it fired from), so
// the focused input keeps focus and the caret while results refresh live.

function refreshBfResults() {
  const el = document.getElementById('bf-results');
  if (el) el.innerHTML = renderBitFlipperResults();
}

function scheduleBfMapRefresh() {
  if (state.bfMapTimer) clearTimeout(state.bfMapTimer);
  state.bfMapTimer = setTimeout(() => { state.bfMapTimer = null; refreshBitFlipperMap(); }, 250);
}

function onBfAddrInput(val) {
  state.bfInput = val;
  state.bfSensorFilter = '';
  refreshBfResults();
  scheduleBfMapRefresh();
}

function onBfBitsInput(val) {
  state.bfBits = val;
  state.bfSensorFilter = '';
  refreshBfResults();
  scheduleBfMapRefresh();
}

function onBfOnlyMatches(checked) {
  state.bfOnlyMatches = checked;
  refreshBfResults();
}

function onBfArroInput(val) {
  state.bfArroBase = val;
  refreshBfResults();
}

function onBfSensorFilter(val) {
  state.bfSensorFilter = val;
  refreshBfResults();
}

// Create the Leaflet map once per tab render, then draw the current variants.
function initBitFlipperMap() {
  if (state.bfMap) { state.bfMap.remove(); state.bfMap = null; }
  state.bfMapLayer = null;
  const el = document.getElementById('bf-map');
  if (!el || !state.data || typeof L === 'undefined') return;

  state.bfMap = L.map('bf-map').setView([-28, 134], 4);
  addBaseLayers(state.bfMap);
  state.bfMapLayer = L.layerGroup().addTo(state.bfMap);
  refreshBitFlipperMap();
}

// Redraw the matched-station markers, repeater markers and links for the
// current address + bit count. Reuses the existing map (no full rebuild).
function refreshBitFlipperMap() {
  if (!state.bfMap || !state.bfMapLayer || !state.data) return;
  const layer = state.bfMapLayer;
  layer.clearLayers();

  const base = bfBaseId();
  if (base == null) return;

  const idx = buildSensorIndex();

  // Collect stations matching any flip variant (across all N-bit combos)
  const stationInfo = new Map(); // station id → { station, addrs:Set, bits:Set, isBase }
  for (const combo of bitCombos(16, bfBitsToFlip())) {
    let v = base;
    for (const b of combo) v ^= (1 << b);
    if (v <= 0 || v >= 65536 || v === base) continue;
    (idx.get(v) || []).forEach(({ station: s }) => {
      if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set(), bits: new Set() });
      const info = stationInfo.get(s.id);
      info.addrs.add(v);
      info.bits.add(combo.join('+'));
    });
  }

  // The station of interest — whoever owns the address as entered. Always
  // plotted and always highlighted, including when it also turns up as a
  // flip-variant match (which would otherwise paint it like any other hit).
  (idx.get(base) || []).forEach(({ station: s }) => {
    if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set(), bits: new Set() });
    const info = stationInfo.get(s.id);
    info.addrs.add(base);
    info.isBase = true;
  });

  // Collect repeaters open to the matched field stations
  const repeaterInfo = new Map(); // repeater id → { station: r, fieldStations: [] }
  for (const { station: s } of stationInfo.values()) {
    findRepeaterMatches(s).forEach(r => {
      if (!repeaterInfo.has(r.id)) repeaterInfo.set(r.id, { station: r, fieldStations: [] });
      repeaterInfo.get(r.id).fieldStations.push(s);
    });
  }

  const bounds = [];
  const baseMarkers = [];
  for (const { station: s, addrs, bits, isBase } of stationInfo.values()) {
    if (s.lat == null || s.lon == null) continue;
    const role  = primaryRole(s);
    const color = isBase ? BF_BASE_COLOR : (ROLE_COLOR[role] || ROLE_COLOR.field);

    // The station of interest gets a halo behind its pin and its name on the
    // map, so it can be picked out of a scatter of flip matches at a glance.
    if (isBase) {
      L.circleMarker([s.lat, s.lon], {
        radius: 17, color: BF_BASE_COLOR, weight: 2, opacity: 0.9,
        fillColor: BF_BASE_COLOR, fillOpacity: 0.18, interactive: false,
      }).addTo(layer);
    }

    const marker = L.circleMarker([s.lat, s.lon], {
      radius: isBase ? 10 : (s.roles.includes('repeater') ? 9 : 6),
      color: isBase ? '#ffffff' : color,
      fillColor: color, fillOpacity: 0.9,
      weight: isBase ? 3 : 1.5,
    }).addTo(layer);

    const bitsLabel = bits.size
      ? `<br><span style="font-size:.82rem">Flipped bits: ${[...bits].join(', ')}</span>`
      : '';
    const baseLabel = isBase
      ? `<span style="background:${BF_BASE_COLOR};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-left:4px">station of interest</span>`
      : '';
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong>${baseLabel}<br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-right:2px">${r}</span>`).join('')}
      ${bitsLabel}
      <br><span style="font-size:.82rem">AlertID: ${[...addrs].sort((a, b) => a - b).join(', ')}</span>
    `);
    if (isBase) {
      marker.bindTooltip(esc(s.name), {
        permanent: true, direction: 'top', offset: [0, -12], className: 'mn-pin-label',
      });
      baseMarkers.push(marker);
    }
    bounds.push([s.lat, s.lon]);
  }

  // Draw repeaters open to matched field stations, plus lines to those stations
  for (const { station: r, fieldStations } of repeaterInfo.values()) {
    if (r.lat == null || r.lon == null) continue;

    // Only add a marker if this repeater isn't already shown as a matched station
    if (!stationInfo.has(r.id)) {
      const rMarker = L.circleMarker([r.lat, r.lon], {
        radius: 9,
        color: ROLE_COLOR.repeater,
        fillColor: ROLE_COLOR.repeater,
        fillOpacity: 0.85,
        weight: 1.5,
      }).addTo(layer);
      const served = fieldStations.map(fs => esc(fs.name)).join(', ');
      rMarker.bindPopup(`
        <strong>${esc(r.name)}</strong><br>
        <span style="background:${ROLE_COLOR.repeater};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem">repeater</span>
        <br><span style="font-size:.82rem;margin-top:4px;display:block">Open to: ${served}</span>
      `);
      bounds.push([r.lat, r.lon]);
    }

    // Draw a dashed line from the repeater to each matched field station it serves
    for (const fs of fieldStations) {
      if (fs.lat == null || fs.lon == null) continue;
      L.polyline([[r.lat, r.lon], [fs.lat, fs.lon]], {
        color: ROLE_COLOR.repeater,
        weight: 1.5,
        opacity: 0.5,
        dashArray: '5 6',
      }).addTo(layer);
    }
  }

  // Repeater pins and link lines were added after the station pins, so lift the
  // station of interest back above them.
  baseMarkers.forEach(m => m.bringToFront());

  if (bounds.length) state.bfMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
}

