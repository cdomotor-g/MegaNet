// MegaNet — map-cameras.js
//
//   MapCameras   the councils' and QLDTraffic's flood and road cameras on the
//                Stations map: a
//                pin where each camera stands, a viewer with its latest
//                picture and how old that picture is, and a section on the
//                station card naming the cameras at or near a station.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, escAttr, fmtKm, acmaHaversineKm and
// dbProxyAvailable; across to modal.js for Modal, and to app.js for
// rerenderMapLegend and goToStation. All of it from inside its own functions,
// so this file's position among the modules is free.
//
// ── Whose cameras ────────────────────────────────────────────────────────────
// Most Queensland councils publish flood cameras on their disaster dashboards —
// a camera on a pole at a causeway, a bridge or a gauge board, its picture
// replaced every few minutes — and many show TMR's QLDTraffic cameras beside
// them. tools/council_cameras.py reads every Guardian IMS dashboard's camera
// list each week into data/council-cameras.json, with TMR's own QLDTraffic
// flood cameras (~600 cameras, 49 councils), and this layer draws that file. A quarter of the cameras stand within 250 m
// of a Flood-Net station: a council watching the same crossing the gauge does.
//
// ── Whose pictures ───────────────────────────────────────────────────────────
// Still the council's. Nothing is stored: opening a camera asks the Worker's
// /api/cameras/<id> for its latest picture, which fetches it from the camera's
// own server (at most once a minute per Cloudflare location, however many are
// looking) and passes on when that server says the picture last changed. The
// viewer says that age in words, and says it loudly past OLD_H hours — a dry
// causeway in yesterday's picture is the worst thing this layer could show.
// When the Worker cannot be reached the viewer shows the council's own address
// instead and says it cannot tell how old that picture is.
// docs/council-cameras.md has the reasons, and why storing them was not done.
//
// ── Who sees them ────────────────────────────────────────────────────────────
// Everybody, signed in or not: every camera here is on a council's public
// dashboard already. On by default and remembered, like the field photos; it
// costs one small file (35 KB over the wire) the first time the map is zoomed
// in to MIN_ZOOM, and nothing per pan after that.
//
// ── The pin ──────────────────────────────────────────────────────────────────
// A near-black tile with a white video camera on it, a CCTV sign's colours,
// with a stripe along its foot for the kind: water blue for a flood camera,
// road amber for a road camera. Centred on the camera's point, where a field
// photo's 📷 stands up off its point in yellow, so the two never read as one
// thing. Cameras closer than MERGE_PX on screen are one tile with a count; a
// tile of LIST_MAX or fewer opens them all in the viewer, one of more zooms in.
// 2-D only: the tilted map does not draw these yet.
const MapCameras = (function () {
  const CATALOG_URL = 'data/council-cameras.json';
  // Where the Worker is when this page is not on its origin — the github.io
  // copy, a checkout served locally — as bug-report.js reaches /api/report.
  const API_ORIGIN = 'https://floodwarning.net';
  // Its own pane over the network's canvas (overlay, 400), the way map-photos.js
  // explains, and just under the field photos (420): a picture of our own at
  // the same spot is the one on top. Both under the station pins (600).
  const PANE = 'mnCameras';
  const PANE_Z = 415;
  const MIN_ZOOM = 8;          // a view ~300 km across
  const DEBOUNCE_MS = 250;
  const MERGE_PX = 26;
  const PAD = 0.15;            // fraction of the view drawn beyond each edge
  const LIST_MAX = 8;          // a merged pin of this many or fewer opens them all
  const AT_M = 250;            // a camera this close to a station is at it
  const NEAR_M = 2000;         // the station card names cameras this close, and the viewer a station
  const CARD_MAX = 4;
  const OLD_H = 3;             // a picture older than this is said to be old, in the warning colour

  let map = null, layer = null, timer = null, seq = 0;
  let catP = null, cat = null; // the catalog, once read: { meta, councils, cameras, byId }
  let drawn = [];              // [{ lat, lon, n, kind, ids }]
  let note = { kind: 'off', n: 0, councils: 0, error: '' };
  let view = null;             // the viewer: { list, i, n, url, token }

  // ── The catalog ────────────────────────────────────────────────────────────

  function load() {
    if (!catP) {
      catP = fetch(CATALOG_URL).then(r => {
        if (!r.ok) throw new Error(`${CATALOG_URL}: HTTP ${r.status}`);
        return r.json();
      }).then(body => {
        const cameras = (body && Array.isArray(body.cameras) ? body.cameras : []).filter(c =>
          c && typeof c.id === 'string' && isFinite(c.lat) && isFinite(c.lon)
            && Array.isArray(c.views) && c.views.length);
        cat = {
          meta: (body && body.meta) || {},
          councils: new Map(((body && body.councils) || []).map(c => [c.key, c])),
          cameras,
          byId: new Map(cameras.map(c => [c.id, c])),
        };
        return cat;
      });
      // A list that would not come is asked for again next time.
      catP.catch(() => { catP = null; });
    }
    return catP;
  }

  // Who shows a camera: a council, or QLDTraffic (TMR), which the catalog
  // lists among them marked as an agency — its own site, not a disaster
  // dashboard. `short` is what a link calls it ("Lockyer Valley"), written by
  // the tool.
  const council = cam => (cat && cat.councils.get(cam.council)) || null;
  const councilName = cam => { const c = council(cam); return c ? c.name : cam.council; };
  const shortOf = c => (c && (c.short || c.name)) || '';
  const isAgency = cam => { const c = council(cam); return !!(c && c.agency); };
  const kindWords = cam => (cam.kind === 'road' ? 'Road camera' : 'Flood camera');

  // The councils whose dashboards show a camera, as the tool counted them.
  const councilsWithCameras = () => (cat && Number(cat.meta.councils)) || 0;

  // ── Words for time ─────────────────────────────────────────────────────────

  function span(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return '';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
    const d = Math.round(h / 24);
    return `${d} days`;
  }
  function agoWords(ms, now = Date.now()) {
    const s = span(ms, now);
    return s ? `${s} ago` : 'just now';
  }
  // A time of day, and the day too if it is not today.
  function clock(ms, now = Date.now()) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date(now).toDateString()
      ? t : `${t}, ${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`;
  }

  // ── The layer ──────────────────────────────────────────────────────────────

  const GLYPH = '<svg class="mn-cam-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<path d="M2 4.5h7.5A1.5 1.5 0 0 1 11 6v4a1.5 1.5 0 0 1-1.5 1.5H2A1.5 1.5 0 0 1 .5 10V6A1.5 1.5 0 0 1 2 4.5z'
    + 'M11.75 7.25 15.5 5v6l-3.75-2.25z"/></svg>';
  function pinHtml(kind, n) {
    return `<span class="mn-cam-pin mn-cam-pin--${kind}">${GLYPH}${n > 1 ? `<b class="mn-cam-count">${n}</b>` : ''}</span>`;
  }
  function swatch(kind) {
    return `<span class="mn-cam-pin mn-cam-swatch mn-cam-pin--${kind === 'road' ? 'road' : 'flood'}" aria-hidden="true">${GLYPH}</span>`;
  }

  // Cameras that would overlap on screen at this zoom, merged — greedily, in
  // the catalog's order (council, then the council's own numbering), so the
  // same view always merges the same way.
  function merge(cams) {
    const out = [];
    for (const c of cams) {
      const p = map.latLngToLayerPoint([c.lat, c.lon]);
      let g = out.find(o => Math.hypot(o.p.x - p.x, o.p.y - p.y) <= MERGE_PX);
      if (!g) { g = { p, lat: c.lat, lon: c.lon, cams: [] }; out.push(g); }
      g.cams.push(c);
    }
    for (const g of out) {
      g.n = g.cams.length;
      const kinds = new Set(g.cams.map(c => (c.kind === 'road' ? 'road' : 'flood')));
      g.kind = kinds.size > 1 ? 'mixed' : [...kinds][0];
    }
    return out;
  }

  function titleOf(g) {
    if (g.n === 1) {
      const c = g.cams[0];
      return `${c.name} — ${kindWords(c).toLowerCase()}, ${councilName(c)}. Open its latest picture`;
    }
    return `${g.n} cameras here — ${g.n <= LIST_MAX ? 'open them' : 'zoom in to them'}`;
  }

  function press(g) {
    if (g.n <= LIST_MAX || map.getZoom() >= 15) { open(g.cams); return; }
    map.fitBounds(L.latLngBounds(g.cams.map(c => [c.lat, c.lon])).pad(0.25), { maxZoom: 15 });
  }

  function clear() {
    if (layer) { layer.remove(); layer = null; }
    drawn = [];
  }

  function draw(groups) {
    if (layer) layer.remove();
    layer = L.layerGroup([], { pane: PANE });
    for (const g of groups) {
      const icon = L.divIcon({ className: 'mn-cam-icon', html: pinHtml(g.kind, g.n), iconSize: [0, 0], iconAnchor: [0, 0] });
      L.marker([g.lat, g.lon], { icon, pane: PANE, keyboard: true, riseOnHover: true,
                                 title: titleOf(g), alt: titleOf(g), bubblingMouseEvents: false })
        .on('click', () => press(g))
        .addTo(layer);
    }
    layer.addTo(map);
    drawn = groups.map(g => ({ lat: g.lat, lon: g.lon, n: g.n, kind: g.kind, ids: g.cams.map(c => c.id) }));
  }

  function setNote(kind, extra = {}) {
    note = Object.assign({ kind, n: 0, councils: 0, error: '' }, extra);
    const el = document.getElementById('map-cameras-note');
    if (el) el.innerHTML = noteHtml();
  }

  function run() {
    if (!map) return;
    if (!state.mapCameras) { clear(); setNote('off'); return; }
    if (map.getZoom() < MIN_ZOOM) {
      const had = drawn.length > 0;
      clear();
      setNote('zoom');
      if (had && typeof rerenderMapLegend === 'function') rerenderMapLegend();
      return;
    }
    const mine = ++seq;
    if (!cat) setNote('loading');
    load().then(c => {
      if (mine !== seq || !map || !state.mapCameras || map.getZoom() < MIN_ZOOM) return;
      const b = map.getBounds().pad(PAD);
      const inView = c.cameras.filter(x => b.contains([x.lat, x.lon]));
      draw(merge(inView));
      setNote('ok', { n: inView.length, councils: new Set(inView.filter(x => !isAgency(x)).map(x => x.council)).size });
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    }, err => {
      if (mine !== seq || !map) return;
      clear();
      setNote('fail', { error: (err && err.message) || String(err) });
    });
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function asAt() {
    const g = cat && Date.parse(cat.meta.generated || '');
    return isFinite(g) ? ` The list is read from the councils and QLDTraffic every week; this one is from ${
      new Date(g).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}.` : '';
  }

  function noteHtml() {
    const total = cat ? ` — ${cat.cameras.length} cameras from ${councilsWithCameras()} councils and QLDTraffic` : '';
    switch (note.kind) {
      case 'off':
        return `Off. Draws the flood and road cameras councils publish on their disaster dashboards, and TMR’s `
             + `QLDTraffic flood cameras${total}. Click one for its latest picture.`;
      case 'zoom':
        return `Zoom in (to level ${MIN_ZOOM} or closer) to see the flood and road cameras${total}.`;
      case 'loading':
        return 'Loading the camera list…';
      case 'fail':
        return `<span class="txt-bad">The camera list could not be loaded — ${esc(note.error)}</span>`;
      case 'ok':
        return note.n
          ? `${note.n} flood or road camera${note.n === 1 ? '' : 's'} in and around this view, shown by ${note.councils} `
            + `council${note.councils === 1 ? '' : 's'} or QLDTraffic. Click one for its latest picture — fetched from its `
            + `server when you open it, never stored.${esc(asAt())}`
          : 'No flood or road cameras in this view. They are where councils on the Guardian IMS disaster dashboard '
            + `publish them — most of Queensland, and two councils in NSW — and on TMR’s flood crossings.${esc(asAt())}`;
      default:
        return '';
    }
  }

  function controlsHtml() {
    return `
    <label class="filter-check"
           title="A pin where each flood or road camera a council shows on its disaster dashboard stands, and each of TMR’s QLDTraffic flood cameras. Click one for its latest picture and how old it is, fetched from its server when you open it. Everybody, from zoom ${MIN_ZOOM} in.">
      <input type="checkbox" ${state.mapCameras ? 'checked' : ''}
             onchange="MapCameras.setEnabled(this.checked)">
      Flood &amp; road cameras (councils, QLDTraffic)
    </label>
    <p class="filter-note" id="map-cameras-note">${noteHtml()}</p>`;
  }

  function legendHtml() {
    return `
    <span class="legend-item">
      ${swatch('flood')}
      <span class="small">Flood camera — a council’s or TMR’s, at a crossing or a gauge: its latest picture,
        and how old it is. Click one</span>
    </span>
    <span class="legend-item">
      ${swatch('road')}
      <span class="small">Road camera a council shows — mostly TMR’s QLDTraffic</span>
    </span>`;
  }

  // ── The viewer ─────────────────────────────────────────────────────────────

  function apiOrigin() {
    return typeof dbProxyAvailable === 'function' && dbProxyAvailable() ? '' : API_ORIGIN;
  }
  function pictureUrl(cam, n, fresh) {
    return `${apiOrigin()}/api/cameras/${encodeURIComponent(cam.id)}/${n}${fresh ? `?r=${Date.now()}` : ''}`;
  }

  function nearestStation(cam) {
    const list = (state.data && state.data.stations) || [];
    let best = null;
    for (const s of list) {
      if (s.lat == null || s.lon == null || s.lat === '' || s.lon === '') continue;
      const lat = +s.lat, lon = +s.lon;
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const m = acmaHaversineKm(cam.lat, cam.lon, lat, lon) * 1000;
      if (m <= NEAR_M && (!best || m < best.m)) best = { s, m };
    }
    return best;
  }

  function alsoWords(cam) {
    if (!cam.also || !cam.also.length || !cat) return '';
    const names = cam.also.map(k => (cat.councils.get(k) || { name: k }).name);
    return ` — and by ${names.join(' and ')}`;
  }

  // Whose picture, as far as the catalog knows: the operator's where the
  // address is a road agency's (or QLDTraffic says who supplied it), otherwise
  // the dashboard it came from — a council can show a camera it does not own
  // (a shire up Cape York shows its neighbours').
  function creditWords(cam) {
    const who = councilName(cam);
    const agency = isAgency(cam);
    // TMR's own camera on TMR's own QLDTraffic needs saying once.
    const other = cam.owner && cam.owner !== who && !(agency && cam.owner.includes(shortOf(council(cam))));
    const whose = other
      ? `${cam.owner}, as ${who} shows it${agency ? '' : ' on its disaster dashboard'}`
      : agency ? `from ${who}` : `from ${who}’s disaster dashboard`;
    return `Picture: ${whose}. Flood-Net fetches the latest one when you open it and keeps no copy.`;
  }

  function viewHtml(v) {
    const cam = v.list[v.i];
    const c = council(cam);
    const st = nearestStation(cam);
    const chooser = v.list.length > 1 ? `
      <ul class="mn-cam-choose" aria-label="Cameras here">${v.list.map((x, i) => `
        <li><button type="button" class="pill" aria-pressed="${i === v.i}" data-cam-i="${i}"
                    onclick="MapCameras.pick(+this.dataset.camI)">${esc(x.name)}</button></li>`).join('')}
      </ul>` : '';
    const ways = cam.views.length > 1 ? `
      <ul class="mn-cam-choose" aria-label="Which way it looks">${cam.views.map((w, n) => `
        <li><button type="button" class="pill" aria-pressed="${n === v.n}" data-cam-n="${n}"
                    onclick="MapCameras.look(+this.dataset.camN)">${esc(w.label || `View ${n + 1}`)}</button></li>`).join('')}
      </ul>` : '';
    const station = st ? `
        <div><dt>${st.m <= AT_M ? 'At station' : 'Nearest station'}</dt>
          <dd><button type="button" class="link-btn" data-station="${escAttr(st.s.id)}"
                      onclick="MapCameras.toStation(this.dataset.station)">${esc(st.s.name)}${
                        st.s.station_number ? ` (${esc(st.s.station_number)})` : ''}</button>
            — ${esc(fmtKm(st.m / 1000))} away</dd></div>` : '';
    return `<div class="mn-cam-view" data-cam="${escAttr(cam.id)}">
      ${chooser}${ways}
      <figure class="mn-cam-fig">
        <div class="mn-cam-frame" aria-busy="true">
          <img class="mn-cam-img" alt="${escAttr(`The latest picture from ${councilName(cam)}’s camera: ${cam.name}`)}" hidden>
          <p class="mn-cam-wait small">Fetching the latest picture…</p>
        </div>
        <figcaption class="mn-cam-meta small" aria-live="polite"></figcaption>
      </figure>
      <p class="mn-cam-warnline small txt-warn" role="status"></p>
      <div class="mn-cam-acts">
        <button type="button" class="pill" onclick="MapCameras.again()"
                title="Ask for the latest picture again — the camera is asked at most once a minute"
                ><span aria-hidden="true">↻</span> Fetch again</button>
        ${c && /^https?:\/\//i.test(c.dashboard || '') ? `<a class="pill" href="${escAttr(c.dashboard)}" target="_blank" rel="noopener noreferrer"
                title="${escAttr(c.agency ? `${c.name} — its flood cameras, closures and road conditions`
                  : `${c.name}’s disaster dashboard — its road closures and warnings, and every camera`)}"
                >${esc(c.agency ? shortOf(c) : `${shortOf(c)}’s dashboard`)} <span aria-hidden="true">↗</span></a>` : ''}
        <button type="button" class="pill" onclick="MapCameras.showOnMap()">Show on the map</button>
      </div>
      <dl class="mn-cam-facts small">
        <div><dt>Camera</dt><dd>${esc(kindWords(cam))}${cam.facing ? `, facing ${esc(cam.facing)}` : ''}</dd></div>
        <div><dt>Shown by</dt><dd>${esc(councilName(cam))}${esc(alsoWords(cam))}</dd></div>${station}
      </dl>
      ${cam.note ? `<p class="small txt-muted mn-cam-note">${c && c.agency ? `${esc(shortOf(c))}’s note` : 'The council’s note'}: ${
        esc(cam.note)}</p>` : ''}
      <p class="small mn-cam-safety">A picture is one moment. It does not show how deep or fast the water is, or
        whether the road under it is still there, and a road can be closed while it looks clear — check the council’s
        dashboard before you travel. If it’s flooded, forget it.</p>
      <p class="small txt-muted mn-cam-credit">${esc(creditWords(cam))}</p>
    </div>`;
  }

  function parts() {
    const root = document.querySelector('#app-modal .mn-cam-view');
    if (!root) return null;
    return {
      root,
      frame: root.querySelector('.mn-cam-frame'),
      img: root.querySelector('.mn-cam-img'),
      wait: root.querySelector('.mn-cam-wait'),
      meta: root.querySelector('.mn-cam-meta'),
      warn: root.querySelector('.mn-cam-warnline'),
    };
  }

  function busy(el, on, words = '') {
    el.frame.setAttribute('aria-busy', on ? 'true' : 'false');
    el.wait.textContent = words;
  }

  function metaHtml(got, now = Date.now()) {
    const fetched = Date.parse(got.fetched || '');
    const changed = Date.parse(got.lastModified || '');
    const said = [];
    if (got.stale) {
      said.push(`Flood-Net could not reach the camera just now (${esc(got.stale)}), so this is the last picture it `
              + `fetched${isFinite(fetched) ? `, at ${esc(clock(fetched, now))}` : ''}.`);
    }
    if (isFinite(changed)) {
      said.push(`<strong>Updated ${esc(clock(changed, now))} — ${esc(agoWords(changed, now))}</strong>, by the camera’s server.`);
    } else {
      said.push('The camera’s server does not say when this picture was taken — read the time printed on it, if there '
              + `is one.${isFinite(fetched) && !got.stale ? ` Fetched ${esc(clock(fetched, now))}.` : ''}`);
    }
    return said.join(' ');
  }

  function warnWords(cam, got, now = Date.now()) {
    const changed = Date.parse(got.lastModified || '');
    const when = isFinite(changed) ? changed : (got.stale ? Date.parse(got.fetched || '') : NaN);
    const out = [];
    if (isFinite(when) && (now - when) / 3600000 >= OLD_H) {
      out.push(`This picture is ${span(when, now)} old — the camera may be offline. It does not show the crossing as it is now.`);
    }
    if (cam.check_date) out.push('The council asks you to check the date printed on the picture.');
    return out.join(' ');
  }

  function letGo() {
    if (view && view.url) { URL.revokeObjectURL(view.url); view.url = null; }
  }

  function showPicture(el, cam, got) {
    letGo();
    view.url = URL.createObjectURL(got.blob);
    el.img.onload = () => { el.img.hidden = false; busy(el, false); };
    el.img.onerror = () => { el.img.hidden = true; busy(el, false, 'The picture came, but this browser could not show it.'); };
    el.img.removeAttribute('referrerpolicy');
    el.img.src = view.url;
    el.meta.innerHTML = metaHtml(got);
    el.warn.textContent = warnWords(cam, got);
  }

  // The Worker could not be asked, or could not fetch it: the camera's own
  // address, said to be that, with no age claimed for it.
  function showDirect(el, cam, n, why) {
    letGo();
    el.img.referrerPolicy = 'no-referrer';
    el.img.onload = () => { el.img.hidden = false; busy(el, false); };
    el.img.onerror = () => {
      el.img.hidden = true;
      busy(el, false, 'The camera’s picture could not be loaded — its server may be down, or the camera offline. '
                    + 'The council’s dashboard may say more.');
    };
    el.img.src = cam.views[n].url;
    el.meta.innerHTML = `Straight from the camera’s server: Flood-Net could not fetch it (${esc(why)}), so it cannot `
                      + 'say how old this picture is — read the time printed on it, if there is one.';
    el.warn.textContent = cam.check_date ? 'The council asks you to check the date printed on the picture.' : '';
  }

  async function fetchNow(fresh) {
    if (!view) return;
    const token = ++view.token;
    const cam = view.list[view.i], n = view.n;
    const el = parts();
    if (!el) return;
    busy(el, true, fresh ? 'Fetching it again…' : 'Fetching the latest picture…');
    let got = null, why = '';
    try {
      const res = await fetch(pictureUrl(cam, n, fresh), { cache: fresh ? 'no-cache' : 'default' });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) { /* not JSON */ }
        throw new Error(msg);
      }
      got = {
        blob: await res.blob(),
        lastModified: res.headers.get('Last-Modified'),
        fetched: res.headers.get('X-Camera-Fetched'),
        stale: res.headers.get('X-Camera-Stale'),
      };
    } catch (err) {
      why = (err && err.message) || String(err);
    }
    if (!view || token !== view.token) return;     // moved on to another camera, or closed
    const now = parts();
    if (!now) return;
    if (got) showPicture(now, cam, got);
    else showDirect(now, cam, n, why);
  }

  function repaint(focusSel) {
    const body = document.querySelector('#app-modal .modal-body');
    if (!body || !view) return;
    letGo();
    body.innerHTML = viewHtml(view);
    const title = document.getElementById('app-modal-title');
    if (title) title.textContent = view.list[view.i].name;
    const f = focusSel ? body.querySelector(focusSel) : null;
    if (f) f.focus();
    fetchNow(false);
  }

  function open(list, at = 0) {
    if (!list || !list.length || typeof Modal === 'undefined') return;
    letGo();
    // Adopted only once the shell is up: a dialog already open is closed by
    // Modal.open, and its onClose — this viewer's own, a camera ago — must
    // not take this one with it.
    const next = { list: list.slice(), i: Math.max(0, Math.min(at, list.length - 1)), n: 0, url: null, token: 0 };
    Modal.open({
      title: next.list[next.i].name,
      html: viewHtml(next),
      wide: true,
      onClose: () => { if (view === next) { letGo(); view = null; } },
    });
    view = next;
    fetchNow(false);
  }

  // ── The station card ───────────────────────────────────────────────────────

  function key(s) {
    if (!s || s.lat == null || s.lon == null || s.lat === '' || s.lon === '') return '';
    const lat = Number(s.lat), lon = Number(s.lon);
    return isFinite(lat) && isFinite(lon) ? `${lat.toFixed(5)},${lon.toFixed(5)}` : '';
  }

  // The cameras within NEAR_M of a point, nearest first.
  function near(lat, lon, max = CARD_MAX) {
    if (!cat) return [];
    const out = [];
    for (const cam of cat.cameras) {
      const m = acmaHaversineKm(lat, lon, cam.lat, cam.lon) * 1000;
      if (m <= NEAR_M) out.push({ cam, m });
    }
    return out.sort((a, b) => a.m - b.m).slice(0, max);
  }

  // The section, from what is known now: nothing until the catalog is read,
  // and nothing for a station with no camera near it. ask() fills it.
  function html(s) {
    const k = key(s);
    if (!cat || !k) return '';
    const list = near(Number(s.lat), Number(s.lon));
    if (!list.length) return '';
    const at = list.filter(x => x.m <= AT_M).length;
    const head = at === list.length ? 'at this station' : at ? 'at and near this station' : 'near this station';
    const headId = `mn-cams-head-${s.id}`;
    return `<div class="stn-card-cams" role="group" aria-labelledby="${escAttr(headId)}">
      <span class="small txt-muted stn-card-rhs-head" id="${escAttr(headId)}"
            title="Flood and road cameras councils publish on their disaster dashboards, and TMR’s QLDTraffic flood cameras, within ${NEAR_M / 1000} km of the station">Flood &amp; road cameras ${head}</span>
      <ul class="stn-card-cam-list">${list.map(({ cam, m }) => `
        <li><button type="button" class="pill" data-cam="${escAttr(cam.id)}"
                    onclick="MapCameras.openId(this.dataset.cam)">${swatch(cam.kind)}<span>${esc(cam.name)}</span></button>
          <span class="small txt-muted">${m <= AT_M ? '<span class="stn-card-cam-at">At this station</span>'
            : `${esc(fmtKm(m / 1000))} away`} · ${esc(kindWords(cam).toLowerCase())} · ${esc(councilName(cam))}</span></li>`).join('')}
      </ul>
    </div>`;
  }

  function ask(elId, s) {
    const k = key(s);
    if (!k) return;
    load().then(() => {
      const el = document.getElementById(elId);
      if (!el || el.dataset.mnCams !== k) return;
      el.innerHTML = html(s);
    }, () => { /* no list, no section — the layer's note says why */ });
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      m.on('moveend', sync);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      clear();
      map = null;
      seq++;
    },

    refresh() { if (map) sync(); },
    active() { return !!(layer && drawn.length); },
    noteHtml,
    controlsHtml,
    legendHtml,

    // On by default and remembered: the list is one small file, read once.
    setEnabled(on) {
      state.mapCameras = !!on;
      try { localStorage.setItem('mn-council-cameras', on ? 'on' : 'off'); } catch (_) { /* this session only */ }
      if (!on) { clearTimeout(timer); seq++; clear(); setNote('off'); }
      else sync();
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    },

    // The station card's section.
    key,
    html,
    ask,

    // The viewer, and what its buttons call.
    open,
    openId(id) {
      return load().then(c => { const cam = c.byId.get(id); if (cam) open([cam]); }, () => {});
    },
    pick(i) {
      if (!view || !(i >= 0 && i < view.list.length)) return;
      view.i = i;
      view.n = 0;
      repaint(`[data-cam-i="${i}"]`);
    },
    look(n) {
      if (!view || !(n >= 0 && n < view.list[view.i].views.length)) return;
      view.n = n;
      repaint(`[data-cam-n="${n}"]`);
    },
    again() { fetchNow(true); },
    showOnMap() {
      const cam = view && view.list[view.i];
      if (!cam) return;
      Modal.close();
      if (state.map) state.map.setView([cam.lat, cam.lon], Math.max(15, state.map.getZoom()));
    },
    toStation(id) {
      Modal.close();
      if (typeof goToStation === 'function') goToStation(id);
    },

    load,
    near,
    pictureUrl,
    agoWords,
    // What is drawn: a pin each, after the merge. Copies.
    drawn: () => drawn.map(d => ({ ...d, ids: d.ids.slice() })),
    // Read by the check and by nothing else.
    _note: () => ({ ...note }),
    _words: { metaHtml, warnWords, creditWords, span },
  };
})();
if (typeof window !== 'undefined') window.MapCameras = MapCameras;
