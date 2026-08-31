// MegaNet — arro-launcher.js
//
//   renderArroHtml    the ARRO Launcher tab: a jump box for ARRO's
//   initArro          administration pages, searchable by station name, number
//   and the recents   or ALERT address — site.db_id is an arbitrary database
//   list behind them  index and nobody carries 2,784 of them in their head.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, arroHost,
// arroSiteId, arroSiteUrl, arroSensorUrl and stationSensors, and across to
// app.js for prepareSearch and stationMatchesSearch.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.
// Restyled against the design system by U6 (#141) of EPIC #107 — the markup
// here uses .page, the table pattern and the tokens; the classes it names live
// in the "ARRO Launcher tab (#141)" section of styles.css.

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
  // An address range is a search even though it leaves no term behind it —
  // `4021-4025` parses to bounds rather than to text (app.js: prepareSearch).
  if (!prep.terms.length && !prep.ranges.length) return [];
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
    <div class="page" style="--page-max:1000px">
      <div class="panel">
        <div class="panel-header"><h2>ARRO Launcher</h2></div>
        <p class="small arro-lede">
          Opens ARRO's <strong>administration</strong> pages. Find the station by name, number or
          ALERT address and the site id is filled in for you — or paste an ARRO URL and the ids are
          read out of it. Everything opens in a new tab.
        </p>
        <p class="small arro-lede">
          Host: <code>${esc(arroHost())}</code> — set by the ARRO base URL on the Bit Flipper tab.
        </p>
      </div>

      <div class="panel">
        <div class="panel-header"><h3 id="arro-find-h">Find a station</h3></div>
        ${state.data ? `
          <input type="search" id="arro-search" class="arro-search" value="${esc(a.search)}"
                 aria-labelledby="arro-find-h" aria-describedby="arro-find-hint"
                 placeholder="Station name, station number or ALERT address — e.g. Loudoun, 541155, 6128"
                 oninput="onArroSearch(this.value)">
          <p id="arro-find-hint" class="small arro-hint">
            Matches the station's name, its number, or any ALERT address it reports on.</p>
          <div id="arro-results" class="arro-results">${arroResultsHtml()}</div>
        ` : `
          <p class="small arro-lede">
            No <strong>stations.json</strong> loaded, so there is nothing to search. The raw id box
            below still works — load a file to look site ids up by name instead.
          </p>`}
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Open by id</h3></div>
        <div class="arro-ids">
          <label class="arro-id-field">
            <span>ARRO site id</span>
            <input type="text" id="arro-site" value="${esc(a.siteId)}" placeholder="e.g. 3318"
                   oninput="onArroIdInput('siteId',this.value)"
                   onkeydown="onArroKey(event)">
          </label>
          <label class="arro-id-field">
            <span>Device id <span class="arro-optional">(optional)</span></span>
            <input type="text" id="arro-device" value="${esc(a.deviceId)}" placeholder="e.g. 2"
                   oninput="onArroIdInput('deviceId',this.value)"
                   onkeydown="onArroKey(event)">
          </label>
          <label class="arro-id-field arro-id-field--wide">
            <span>…or paste an ARRO URL</span>
            <input type="text" id="arro-paste" placeholder="https://…/administration/site/details/?site_id=3318"
                   oninput="onArroPaste(this.value)"
                   onkeydown="onArroKey(event)">
          </label>
        </div>
        <div id="arro-actions" class="arro-actions">${arroActionsHtml()}</div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h3 id="arro-recent-h">Recent</h3>
          <button class="arro-btn-sm" onclick="arroClearRecents()"
                  aria-label="Clear the list of recently opened ARRO pages">Clear</button>
        </div>
        <div id="arro-recents" class="arro-recents">${arroRecentsHtml()}</div>
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
    return `<p class="small arro-flush">
      Enter a numeric site id — or pick a station above — to open its ARRO pages.
      ${a.note ? `<br>${esc(a.note)}` : ''}</p>`;
  }
  const where = a.note ? ` for ${a.note}` : ` for site ${site}`;
  return `
    <div class="arro-action-row">
      <a class="btn-link" href="${esc(siteUrl)}" target="_blank" rel="noopener"
         aria-label="Open ARRO site admin${escAttr(where)} in a new tab"
         onclick="arroRemember()">Open site admin ↗</a>
      ${devUrl
        ? `<a class="btn-link" href="${esc(devUrl)}" target="_blank" rel="noopener"
             aria-label="Open ARRO sensor admin${escAttr(where)}, device ${escAttr(device)}, in a new tab"
             onclick="arroRemember()">Open sensor admin ↗</a>`
        // A disabled <button> rather than the <span> this was: a span is not in
        // the accessibility tree as a control at all, so the reason the second
        // action is unavailable was visible and nothing else. A disabled button
        // is announced as one, with its own name.
        : `<button type="button" class="btn-link disabled" disabled
                   aria-label="Open sensor admin — add a device id above first"
                   title="Add a device id to open a sensor page">Open sensor admin ↗</button>`}
      <span class="small">
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
    return `<p class="small arro-flush">
      Type to search ${state.data.stations.length.toLocaleString()} stations.</p>`;
  }
  const hits = arroSearchResults();
  if (!hits.length) {
    return `<p class="small arro-flush">No station matches that.</p>`;
  }
  const more  = hits.length > ARRO_RESULT_MAX;
  const shown = more ? hits.slice(0, ARRO_RESULT_MAX) : hits;
  // Pattern 7a — the wrapper caps its height, so it scrolls, so it is a named
  // region with a tab stop. Named off the panel's own heading rather than a
  // second form of words.
  return `
    <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="arro-find-h">
      <table>
        <caption class="sr-only">Stations matching “${esc(text)}” — ${shown.length} shown</caption>
        <colgroup>
          <col style="width:40%"><col style="width:13%">
          <col style="width:16%"><col style="width:11%"><col style="width:20%">
        </colgroup>
        <thead><tr>
          <th scope="col">Station</th><th scope="col">Stn #</th>
          <th scope="col">ARRO site id</th>
          <th scope="col" class="col-optional">Sensors</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
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
                  ? `<span class="arro-none">none recorded</span>`
                  : `<code>${esc(dbId)}</code>`}</td>
                <td class="small col-optional">${devs || '—'}</td>
                <td class="small arro-row-acts">${dbId == null ? '' : `
                  <button class="arro-btn-sm" onclick="arroPickStation('${escAttr(s.id)}')"
                          aria-label="Use ${escAttr(s.name)} — fill site id ${escAttr(dbId)} in below">Use</button>
                  <a href="${esc(url)}" target="_blank" rel="noopener"
                     aria-label="Open ARRO site admin for ${escAttr(s.name)} in a new tab"
                     onclick="arroRememberStation('${escAttr(s.id)}')">admin ↗</a>`}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${more ? `<p class="small arro-hint">
      Showing the first ${ARRO_RESULT_MAX} — narrow the search to see the rest.</p>` : ''}`;
}

function arroRecentsHtml() {
  const list = arroRecents();
  if (!list.length) {
    return `<p class="small arro-flush">
      Nothing yet. Pages you open from here are listed for next time.</p>`;
  }
  // A list of pages is a list: <ul> gives a screen reader the count on entry,
  // which a stack of divs never did.
  return `
    <ul class="arro-recent-list" aria-labelledby="arro-recent-h">
      ${list.map(r => {
        const url  = r.device ? arroSensorUrl(r.site, r.device) : arroSiteUrl(r.site);
        const what = r.device ? 'sensor admin' : 'site admin';
        const name = r.label || `Site ${r.site}`;
        return `
          <li>
            <a href="${esc(url)}" target="_blank" rel="noopener" class="arro-recent-name"
               aria-label="Open ARRO ${escAttr(what)} for ${escAttr(name)} in a new tab">
              ${esc(name)}</a>
            <span class="small">
              site <code>${esc(r.site)}</code>${r.device ? ` · device <code>${esc(r.device)}</code>` : ''}
              · ${esc(what)}</span>
            <button class="arro-btn-sm" onclick="arroUseRecent('${escAttr(r.site)}','${escAttr(r.device || '')}')"
                    aria-label="Use ${escAttr(name)} — fill these ids in above">Use</button>
          </li>`;
      }).join('')}
    </ul>`;
}

// This used to focus the search box on arrival. It no longer does, and the
// reason is the app's rather than this tab's: #109's focus policy puts focus on
// the nav button that just became `aria-current="page"` after a tab switch, and
// a tab that grabs it back leaves a keyboard user somewhere the nav did not put
// them — with no way to tell that the tab even changed. The search box is the
// first control inside the tab, so it is one Tab away from where focus is, and
// the skip link reaches it in two from anywhere. Nothing else needed doing on
// mount, so this is what is left; app.js still calls it, and a future entrance
// hook has somewhere to live.
function initArro() { /* no focus steal — see above */ }

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
  if (!site && !device) {
    state.arro.note = 'No site id found in that.';
    rerenderArroActions();
    announce('No site id found in that.');
    return;
  }
  if (site)   state.arro.siteId   = site;
  if (device) state.arro.deviceId = device;
  state.arro.note = 'read from the pasted URL';
  arroFillIds(`Read site ${state.arro.siteId}`
    + (state.arro.deviceId ? `, device ${state.arro.deviceId}` : '')
    + ' out of the pasted URL.', false);
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
  arroFillIds(`${s.name} — ARRO site ${dbId}. The open buttons are ready.`);
  document.getElementById('arro-actions')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Both "Use" buttons — in the results table and in the recents list — write the
// ids into the boxes forty rows above or below the button that was pressed.
// Sighted, the scroll says so; on a keyboard it was a button that appeared to do
// nothing. Focus follows the value into the field it landed in, and the result
// is announced, because the field's own name does not say which station it now
// holds.
// `moveFocus` is false for the paste box, where the operator is still typing:
// pulling focus out from under a paste is the one case where following the
// value is wrong.
function arroFillIds(message, moveFocus = true) {
  const siteEl = document.getElementById('arro-site');
  const devEl  = document.getElementById('arro-device');
  if (siteEl) siteEl.value = state.arro.siteId;
  if (devEl)  devEl.value  = state.arro.deviceId;
  rerenderArroActions();
  if (moveFocus) siteEl?.focus();
  if (message) announce(message);
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
  arroFillIds(`Site ${state.arro.siteId}`
    + (state.arro.deviceId ? `, device ${state.arro.deviceId}` : '')
    + `${state.arro.note ? ` — ${state.arro.note}` : ''}. The open buttons are ready.`);
}

