// ── ARRO LAUNCHER tab ──────────────────────────────────────────────────────────
// A jump box for ARRO's administration pages. The standalone launcher this
// replaces could only take an id you already knew; the whole reason to bring it
// in-app is the station search — `site.db_id` is an arbitrary database index and
// nobody carries 2,784 of them in their head, but everybody knows the station by
// name, by number or by one of its ALERT addresses.

const ARRO_RECENT_KEY = 'mn-arro-recent';
const ARRO_RECENT_MAX = 12;
const ARRO_RESULT_MAX = 40;   // station search results shown before "narrow it down"

function arroRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(ARRO_RECENT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}

// Most recent first, deduped on the (site, device) pair the entry actually opens
// so re-opening the same page reorders rather than accumulates.
function arroSaveRecent(site, device, label) {
  const key  = `${site}|${device || ''}`;
  const list = arroRecents().filter(r => `${r.site}|${r.device || ''}` !== key);
  list.unshift({ site, device: device || '', label: label || '', ts: Date.now() });
  try { localStorage.setItem(ARRO_RECENT_KEY, JSON.stringify(list.slice(0, ARRO_RECENT_MAX))); }
  catch (_) { /* private mode, or the quota — recents are a convenience, not state */ }
}

function arroClearRecents() {
  try { localStorage.removeItem(ARRO_RECENT_KEY); } catch (_) {}
  rerenderArroRecents();
}

// Pull the ids out of whatever was pasted. Handles a full ARRO URL of either
// shape, the `devices[]=site|device` pair the graph pages use, and a bare id.
// Returns { site, device } with either field null when it isn't there.
function arroParseIds(text) {
  const raw = String(text || '').trim();
  if (!raw) return { site: null, device: null };

  const num = s => (s != null && /^\d+$/.test(String(s).trim()) ? String(s).trim() : null);

  // `site_id=…` / `device_id=…`, whether or not the rest parses as a URL.
  const site   = num((raw.match(/[?&]site_id=(\d+)/i)   || [])[1]);
  const device = num((raw.match(/[?&]device_id=(\d+)/i) || [])[1]);
  if (site) return { site, device };

  // Graph form: devices[]=3318|2 (URL-encoded or not).
  const pair = raw.match(/devices(?:\[\]|%5B%5D)=(\d+)(?:\||%7C)(\d+)/i);
  if (pair) return { site: pair[1], device: pair[2] };

  // Bare "3318|2", or a lone id.
  const bare = raw.match(/^(\d+)\s*[|/,\s]\s*(\d+)$/);
  if (bare) return { site: bare[1], device: bare[2] };
  return { site: num(raw), device: device };
}

// Stations matching the search box, resolved to their ARRO site id. Stations
// with no db_id are still listed — saying "this one has no ARRO record" is more
// use than silently dropping it and leaving the operator to wonder.
function arroSearchResults() {
  if (!state.data) return [];
  const text = state.arro.search.trim();
  if (!text) return [];
  const prep = prepareSearch(text);
  if (!prep.terms.length) return [];
  const out = [];
  for (const s of state.data.stations) {
    if (!stationMatchesSearch(s, prep)) continue;
    out.push(s);
    if (out.length > ARRO_RESULT_MAX) break;
  }
  return out;
}

function renderArroHtml() {
  const a = state.arro;
  return `
    <div style="max-width:1000px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>ARRO Launcher</h2></div>
        <p class="small" style="color:var(--muted);margin:.5rem 0 0">
          Opens ARRO's <strong>administration</strong> pages. Find the station by name, number or
          ALERT address and the site id is filled in for you — or paste an ARRO URL and the ids are
          read out of it. Everything opens in a new tab.
        </p>
        <p class="small" style="color:var(--muted);margin:.35rem 0 0">
          Host: <code>${esc(arroHost())}</code> — set by the ARRO base URL on the Bit Flipper tab.
        </p>
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Find a station</h3></div>
        ${state.data ? `
          <input type="search" id="arro-search" value="${esc(a.search)}"
                 placeholder="Station name, station number or ALERT address — e.g. Loudoun, 541155, 6128"
                 style="margin-top:.6rem" oninput="onArroSearch(this.value)">
          <div id="arro-results" style="margin-top:.6rem">${arroResultsHtml()}</div>
        ` : `
          <p class="small" style="color:var(--muted);margin:.6rem 0 0">
            No <strong>stations.json</strong> loaded, so there is nothing to search. The raw id box
            below still works — load a file to look site ids up by name instead.
          </p>`}
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Open by id</h3></div>
        <div style="display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-end;margin-top:.6rem">
          <label style="font-size:.9rem;color:var(--muted);flex:0 0 12rem">
            ARRO site id
            <input type="text" id="arro-site" value="${esc(a.siteId)}" placeholder="e.g. 3318"
                   style="margin-top:.3rem" oninput="onArroIdInput('siteId',this.value)"
                   onkeydown="onArroKey(event)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:0 0 12rem">
            Device id <span style="font-weight:400">(optional)</span>
            <input type="text" id="arro-device" value="${esc(a.deviceId)}" placeholder="e.g. 2"
                   style="margin-top:.3rem" oninput="onArroIdInput('deviceId',this.value)"
                   onkeydown="onArroKey(event)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:1 1 18rem;min-width:14rem">
            …or paste an ARRO URL
            <input type="text" id="arro-paste" placeholder="https://…/administration/site/details/?site_id=3318"
                   style="margin-top:.3rem" oninput="onArroPaste(this.value)"
                   onkeydown="onArroKey(event)">
          </label>
        </div>
        <div id="arro-actions" style="margin-top:.75rem">${arroActionsHtml()}</div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h3>Recent</h3>
          <button onclick="arroClearRecents()" style="padding:.25rem .5rem;font-size:.8rem">Clear</button>
        </div>
        <div id="arro-recents" style="margin-top:.6rem">${arroRecentsHtml()}</div>
      </div>
    </div>`;
}

// The action row: what the ids currently in the boxes would open.
function arroActionsHtml() {
  const a       = state.arro;
  const site    = a.siteId.trim();
  const device  = a.deviceId.trim();
  const siteUrl = /^\d+$/.test(site) ? arroSiteUrl(site) : null;
  const devUrl  = /^\d+$/.test(device) ? arroSensorUrl(site, device) : null;

  if (!siteUrl) {
    return `<p class="small" style="color:var(--muted);margin:0">
      Enter a numeric site id — or pick a station above — to open its ARRO pages.
      ${a.note ? `<br>${esc(a.note)}` : ''}</p>`;
  }
  return `
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center">
      <a class="btn-link" href="${esc(siteUrl)}" target="_blank" rel="noopener"
         onclick="arroRemember()">Open site admin ↗</a>
      ${devUrl
        ? `<a class="btn-link" href="${esc(devUrl)}" target="_blank" rel="noopener"
             onclick="arroRemember()">Open sensor admin ↗</a>`
        : `<span class="btn-link disabled" title="Add a device id to open a sensor page">Open sensor admin ↗</span>`}
      <span class="small" style="color:var(--muted)">
        site <code>${esc(site)}</code>${device ? ` · device <code>${esc(device)}</code>` : ''}
        ${a.note ? ` · ${esc(a.note)}` : ''}
        · press <kbd>Enter</kbd> in any box above
      </span>
    </div>`;
}

function arroResultsHtml() {
  if (!state.data) return '';
  const text = state.arro.search.trim();
  if (!text) {
    return `<p class="small" style="color:var(--muted);margin:0">
      Type to search ${state.data.stations.length.toLocaleString()} stations.</p>`;
  }
  const hits = arroSearchResults();
  if (!hits.length) {
    return `<p class="small" style="color:var(--muted);margin:0">No station matches that.</p>`;
  }
  const more  = hits.length > ARRO_RESULT_MAX;
  const shown = more ? hits.slice(0, ARRO_RESULT_MAX) : hits;
  return `
    <div class="table-wrap" style="max-height:320px">
      <table>
        <thead><tr>
          <th style="width:40%">Station</th><th style="width:13%">Stn #</th>
          <th style="width:16%">ARRO site id</th><th style="width:11%">Sensors</th>
          <th style="width:20%"></th>
        </tr></thead>
        <tbody>
          ${shown.map(s => {
            const dbId = arroSiteId(s);
            const url  = arroSiteUrl(dbId);
            const devs = stationSensors(s).filter(se => se.device_id != null).length;
            return `
              <tr>
                <td>${esc(s.name)}</td>
                <td class="small">${esc(s.station_number || '—')}</td>
                <td class="small">${dbId == null
                  ? `<span style="color:var(--muted)">none recorded</span>`
                  : `<code>${esc(dbId)}</code>`}</td>
                <td class="small">${devs || '—'}</td>
                <td class="small" style="white-space:nowrap">${dbId == null ? '' : `
                  <button onclick="arroPickStation('${escAttr(s.id)}')"
                          style="padding:.2rem .5rem;font-size:.8rem">Use</button>
                  <a href="${esc(url)}" target="_blank" rel="noopener"
                     onclick="arroRememberStation('${escAttr(s.id)}')">admin ↗</a>`}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${more ? `<p class="small" style="color:var(--muted);margin:.4rem 0 0">
      Showing the first ${ARRO_RESULT_MAX} — narrow the search to see the rest.</p>` : ''}`;
}

function arroRecentsHtml() {
  const list = arroRecents();
  if (!list.length) {
    return `<p class="small" style="color:var(--muted);margin:0">
      Nothing yet. Pages you open from here are listed for next time.</p>`;
  }
  return `
    <div style="display:grid;gap:.3rem">
      ${list.map(r => {
        const url = r.device ? arroSensorUrl(r.site, r.device) : arroSiteUrl(r.site);
        return `
          <div style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap">
            <a href="${esc(url)}" target="_blank" rel="noopener" style="font-weight:600">
              ${esc(r.label || `Site ${r.site}`)}</a>
            <span class="small" style="color:var(--muted)">
              site <code>${esc(r.site)}</code>${r.device ? ` · device <code>${esc(r.device)}</code>` : ''}
              · ${esc(r.device ? 'sensor admin' : 'site admin')}</span>
            <button onclick="arroUseRecent('${escAttr(r.site)}','${escAttr(r.device || '')}')"
                    style="padding:.1rem .45rem;font-size:.78rem">Use</button>
          </div>`;
      }).join('')}
    </div>`;
}

function initArro() {
  const el = document.getElementById(state.data ? 'arro-search' : 'arro-site');
  if (el) el.focus();
}

function rerenderArroResults() {
  const el = document.getElementById('arro-results');
  if (el) el.innerHTML = arroResultsHtml();
}

function rerenderArroActions() {
  const el = document.getElementById('arro-actions');
  if (el) el.innerHTML = arroActionsHtml();
}

function rerenderArroRecents() {
  const el = document.getElementById('arro-recents');
  if (el) el.innerHTML = arroRecentsHtml();
}

function onArroSearch(v) {
  state.arro.search = v;
  rerenderArroResults();
}

function onArroIdInput(field, v) {
  state.arro[field] = v;
  state.arro.note = '';
  rerenderArroActions();
}

// Pasting a URL fills the id boxes rather than navigating: the ids are the thing
// worth keeping, and seeing them land is what tells you the paste was understood.
function onArroPaste(v) {
  if (!v.trim()) return;
  const { site, device } = arroParseIds(v);
  if (!site && !device) { state.arro.note = 'No site id found in that.'; rerenderArroActions(); return; }
  if (site)   state.arro.siteId   = site;
  if (device) state.arro.deviceId = device;
  state.arro.note = 'read from the pasted URL';
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = state.arro.deviceId;
  rerenderArroActions();
}

// Enter opens the most specific page the boxes describe — the sensor if a device
// id is there, the site otherwise.
function onArroKey(ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const site   = state.arro.siteId.trim();
  const device = state.arro.deviceId.trim();
  if (!/^\d+$/.test(site)) return;
  const url = /^\d+$/.test(device) ? arroSensorUrl(site, device) : arroSiteUrl(site);
  arroRemember();
  window.open(url, '_blank', 'noopener');
}

// Record whatever the boxes currently point at. Called from the anchors' onclick
// as well as from Enter, so a middle-click that never fires it simply isn't
// remembered — better than remembering a page that was never opened.
function arroRemember() {
  const site   = state.arro.siteId.trim();
  const device = state.arro.deviceId.trim();
  if (!/^\d+$/.test(site)) return;
  arroSaveRecent(site, /^\d+$/.test(device) ? device : '', arroLabelForSite(site));
  rerenderArroRecents();
}

// The station name behind a site id, when we happen to know it, so the recents
// list reads as stations rather than as a column of database keys.
function arroLabelForSite(site) {
  if (!state.data) return '';
  const n = parseInt(site, 10);
  const s = state.data.stations.find(x => arroSiteId(x) === n);
  return s ? s.name : '';
}

function arroPickStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s) return;
  const dbId = arroSiteId(s);
  if (dbId == null) return;
  state.arro.siteId   = String(dbId);
  state.arro.deviceId = '';
  state.arro.note     = s.name;
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = '';
  rerenderArroActions();
  document.getElementById('arro-actions')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function arroRememberStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  const dbId = s && arroSiteId(s);
  if (dbId == null) return;
  arroSaveRecent(String(dbId), '', s.name);
  rerenderArroRecents();
}

function arroUseRecent(site, device) {
  state.arro.siteId   = String(site || '');
  state.arro.deviceId = String(device || '');
  state.arro.note     = arroLabelForSite(site);
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = state.arro.deviceId;
  rerenderArroActions();
}

