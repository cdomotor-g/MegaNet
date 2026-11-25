// MegaNet — map-history.js
//
//   MapHistory   🕰️ Imagery over time: a slider on the Stations map that
//                scrubs back through dated pictures of the ground under it.
//
// After core.js and map-controls.js, before init.js. Like every map module it
// only declares at load; attach() is called by app.js when the Stations map is
// built, and everything it reaches in other modules (MapChrome, Glyphs, esc,
// termHtml, mapNote) it reaches at run time.
//
// ── The four sources, and why these four ─────────────────────────────────────
// Every one is free, needs no key, answers a browser on another site (CORS)
// and is licensed for this — checked in Nov 2026 before it was built:
//
//   wayback  Esri World Imagery Wayback. Every published version of the World
//            Imagery map (the Satellite base) since 20 Feb 2014 — about 200 —
//            Australia-wide. Same Esri Master Licence as the Satellite base the
//            app already shows; the one extra line is "not for exporting tiles
//            for offline use", which this does not do. A place changes in only
//            some of the releases, so the stops for a place are found by
//            Esri's own `tilemap` walk (stopsWayback): each answer names the
//            release the tile really came from, and the walk jumps straight
//            past every release that repeats it.
//   dea      Geoscience Australia's DEA GeoMAD: one cloud-free picture of each
//            calendar year from the Landsat satellites, 1986 to last year,
//            Australia-wide, 30 m pixels (a paddock, not a house). CC BY 4.0.
//            Landsat 5 to 2011, 7 for 2012, 8 and 9 from 2013.
//   qld      Queensland's aerial photo archive (TimeSeries/AerialOrtho and the
//            natural-disaster flights) — every public project over the middle
//            of the map, back to the 1990s in towns, 10–60 cm. CC BY 4.0
//            (© State of Queensland). Drawn one project at a time
//            (exportImage, LockRaster), because the slider means "this flight".
//   nsw      NSW Spatial Services' historical aerial photos (the HAPE
//            mosaics, 1947–2006, and Sydney 1943). CC BY 4.0. Patchy by year
//            and place, with no index a browser can ask, so the years for a
//            place are found by asking each year for the one tile at the
//            middle of the map (stopsNsw).
//
// Ruled out: Nearmap, Metromap and the like (paid), and Google and Bing,
// whose terms forbid drawing their imagery in somebody else's map.
//
// ── The source pill ──────────────────────────────────────────────────────────
// The map's imagery-source pill (job B) is meant to drive this: it calls
// MapHistory.setSource(id) with one of MapHistory.sources()' ids, or null for
// off, and listens for `mn-imagery-history` on document to show which is on.
// Until it lands the panel's own row of pills does the same job.

const MapHistory = (function () {
  const PANE = 'mnHistory';
  const PANE_Z = 245;               // over the bases (tilePane 200), under their names (250)
  const AU = [[-44.5, 112], [-9, 154.5]];

  const WB_CONFIG = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
  const WB_TILEMAP = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap';
  const DEA_WMS = 'https://ows.dea.ga.gov.au/';
  const QLD = 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/TimeSeries';
  const QLD_SVCS = [`${QLD}/AerialOrtho_AllUsers/ImageServer`, `${QLD}/NaturalDisaster_Optical_AllUsers/ImageServer`];
  const NSW_HAPE = y => `https://portal.spatial.nsw.gov.au/tileservices/Hosted/HistoricalImagery${y}/MapServer/tile/{z}/{y}/{x}`;
  const NSW_1943 = 'https://maps.six.nsw.gov.au/arcgis/rest/services/sixmaps/sydney1943/MapServer/tile/{z}/{y}/{x}';
  // The years NSW publishes a HAPE mosaic for (its tile services, Nov 2026).
  const NSW_YEARS = [1947, 1955, 1965, 1966, 1969, 1970, 1971, 1972, 1975, 1978, 1980, 1984,
                     1986, 1989, 1990, 1991, 1994, 1996, 1998, 2004, 2005, 2006];

  const ATTR = {
    wayback: 'Imagery © Esri World Imagery Wayback — Esri, Vantor, Earthstar Geographics, and the GIS User Community',
    dea: '© Commonwealth of Australia (Geoscience Australia), DEA GeoMAD, CC BY 4.0',
    qld: 'Includes material © State of Queensland, CC BY 4.0',
    nsw: '© State of New South Wales (Spatial Services, a business unit of the Department of Customer Service NSW), CC BY 4.0',
  };

  // What the words in the panel and the slider mean — hover, and the panel's
  // fold for a finger or a keyboard (docs/design-system.md).
  const WORDS = {
    wayback: 'Every version of Esri’s satellite and aerial picture of the world it has published since February 2014. A stop is a version where the picture of this place changed; the versions in between showed the same photo.',
    dea: 'Geoscience Australia’s picture of a whole calendar year from the Landsat satellites, 1986 to last year: each pixel is the typical colour over that year, with cloud taken out. A pixel is 30 m, so it shows paddocks, rivers and towns, not houses.',
    qld: 'Photos flown for the Queensland Government, one stop per flight that covers the middle of the map: towns back to the 1990s, the country around them less often, and flights after floods and cyclones. Shown from about town size in.',
    nsw: 'Old aerial photos from NSW Spatial Services, 1943 to 2006, one stop per year that has a photo at the middle of the map. Many places have only a few years.',
    release: 'The day Esri published this version of its picture. The photo in it is usually older — Taken says when it was flown.',
    taken: 'The day the photo at the middle of the map was taken, as its publisher records it.',
    pixel: 'How much ground one pixel of the picture covers: 10 cm shows a fence post, 50 cm a car, 30 m a paddock.',
    middle: 'The dates are the ones for the point in the middle of the map. Move the map and they are found again; a stop can cover only part of the screen, and the rest then shows the base map underneath.',
  };

  const SOURCES = {
    wayback: { id: 'wayback', name: 'Esri Wayback', span: '2014 – now · all of Australia', bounds: AU },
    dea:     { id: 'dea',     name: 'Satellite years', span: '1986 – last year · all of Australia', bounds: AU },
    qld:     { id: 'qld',     name: 'Queensland photos', span: '1990s – now · Queensland', bounds: [[-29.2, 137.9], [-9.1, 153.6]], minZoom: 11 },
    nsw:     { id: 'nsw',     name: 'NSW photos', span: '1943 – 2006 · NSW, patchy', bounds: [[-37.6, 140.9], [-28.1, 153.7]], minZoom: 10 },
  };
  const ORDER = ['wayback', 'dea', 'qld', 'nsw'];

  let map = null, body = null, bar = null, layer = null;
  let src = null;                   // the source on, or null for off
  let stops = [], idx = -1;         // oldest first
  let seq = 0, timer = null, lastKey = '', busy = false, note = '';
  let wbReleases = null;            // the Wayback release list, once fetched
  const cache = new Map();          // `${src}|${key}` → stops

  // ── Small helpers ──────────────────────────────────────────────────────────
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayText(d) { return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  function monthText(d) { return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
  function e(s) { return typeof esc === 'function' ? esc(s) : String(s); }
  function term(t, k) { return typeof termHtml === 'function' ? termHtml(t, WORDS[k]) : e(t); }

  // `tries` > 1 asks again after a pause: Queensland's image server answers
  // 502 to about one question in two at busy times (Nov 2026), and the next
  // one a second later usually gets through.
  function getJSON(url, ms = 20000, tries = 1) {
    return getOnce(url, ms).then(d => (d || tries <= 1 ? d
      : new Promise(r => setTimeout(r, 900)).then(() => getJSON(url, ms, tries - 1))));
  }

  function getOnce(url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {})
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => t && clearTimeout(t));
  }

  function tileAt(lat, lon, z) {
    const n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    return { z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
  }

  function inside(b, ll) { return ll.lat >= b[0][0] && ll.lat <= b[1][0] && ll.lng >= b[0][1] && ll.lng <= b[1][1]; }

  // ── Finding the stops for the middle of the map ────────────────────────────
  // Each returns the stops oldest first: { key, date: Date, label, detail, … }.

  function waybackReleases() {
    if (wbReleases) return Promise.resolve(wbReleases);
    return getJSON(WB_CONFIG).then(cfg => {
      if (!cfg) return null;
      wbReleases = Object.entries(cfg).map(([num, v]) => {
        const m = /(\d{4})-(\d\d)-(\d\d)/.exec(v.itemTitle || '');
        return m && { num: +num, date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])),
                      url: v.itemURL, meta: v.metadataLayerUrl };
      }).filter(Boolean).sort((a, b) => b.date - a.date);   // newest first
      return wbReleases;
    });
  }

  // Esri's own walk (the Wayback app's): ask the newest release for the tile
  // at the middle; `select` names the release that tile really came from, so
  // everything between is the same photo and the next question goes straight
  // to the release older than that. One question per distinct picture.
  function stopsWayback(ll, zoom) {
    return waybackReleases().then(async rels => {
      if (!rels || !rels.length) return null;
      const t = tileAt(ll.lat, ll.lng, Math.max(11, Math.min(16, Math.round(zoom))));
      const out = [];
      let i = 0;
      for (let guard = 0; i < rels.length && guard < 60; guard++) {
        const tm = await getJSON(`${WB_TILEMAP}/${rels[i].num}/${t.z}/${t.y}/${t.x}/1/1`);
        if (!tm || !Array.isArray(tm.data) || !tm.data[0]) break;
        const sel = (Array.isArray(tm.select) && tm.select[0]) || rels[i].num;
        const k = rels.findIndex(r => r.num === sel);
        if (k < 0) break;
        out.push(rels[k]);
        i = Math.max(k, i) + 1;
      }
      return out.reverse().map(r => ({
        key: `wb${r.num}`, date: r.date, num: r.num, url: r.url, meta: r.meta,
        label: dayText(r.date), when: 'release',
        detail: 'Esri’s picture as published that day',
      }));
    });
  }

  function stopsDea() {
    const last = new Date().getUTCFullYear() - 1;
    const out = [];
    for (let y = 1986; y <= last; y++) {
      const lyr = y <= 2011 ? 'ga_ls5t_gm_cyear_3' : y === 2012 ? 'ga_ls7e_gm_cyear_3' : 'ga_ls8cls9c_gm_cyear_3';
      const sat = y <= 2011 ? 'Landsat 5' : y === 2012 ? 'Landsat 7' : 'Landsat 8 and 9';
      out.push({ key: `dea${y}`, date: new Date(Date.UTC(y, 6, 1)), year: y, lyr,
                 label: String(y), detail: `The whole year from ${sat} · 30 m pixels` });
    }
    return Promise.resolve(out);
  }

  function stopsQld(ll) {
    const q = svc => getJSON(`${svc}/query?f=json&geometry=${ll.lng},${ll.lat}&geometryType=esriGeometryPoint`
      + '&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=false'
      + '&outFields=objectid,name,year,capturestart,res_value,res_unit', 30000, 4)
      .then(d => (d && Array.isArray(d.features) ? d.features.map(f => ({ svc, a: f.attributes })) : null));
    return Promise.all(QLD_SVCS.map(q)).then(lists => {
      if (lists.every(l => l === null)) return null;
      const unit = { 1: 'mm', 2: 'cm', 3: 'm' };
      return lists.flat().filter(Boolean).map(({ svc, a }) => {
        const d = a.capturestart ? new Date(a.capturestart) : new Date(Date.UTC(a.year || 1900, 6, 1));
        const res = a.res_value ? `${+(+a.res_value).toFixed(2)} ${unit[a.res_unit] || 'm'} pixels` : '';
        const disaster = svc === QLD_SVCS[1];
        const name = String(a.name || '').replace(/_/g, ' ');
        return { key: `qld${disaster ? 'd' : ''}${a.objectid}`, date: d, svc, id: a.objectid,
                 label: a.capturestart ? monthText(d) : String(a.year), when: a.capturestart ? 'taken' : '',
                 detail: [disaster ? 'Flown after a disaster' : 'Aerial photo', res, name].filter(Boolean).join(' · ') };
      }).sort((a, b) => a.date - b.date || a.key.localeCompare(b.key));
    });
  }

  // Ask each year for the one tile under the middle of the map: a year with a
  // photo there answers with a picture, one without answers 404.
  function stopsNsw(ll) {
    const t = tileAt(ll.lat, ll.lng, 14);
    const fill = u => u.replace('{z}', t.z).replace('{y}', t.y).replace('{x}', t.x);
    const probe = url => new Promise(res => {
      const img = new Image();
      const to = setTimeout(() => { img.src = ''; res(false); }, 20000);
      img.onload = () => { clearTimeout(to); res(true); };
      img.onerror = () => { clearTimeout(to); res(false); };
      img.src = url;
    });
    const all = [{ year: 1943, url: NSW_1943 }, ...NSW_YEARS.map(y => ({ year: y, url: NSW_HAPE(y) }))];
    return Promise.all(all.map(s => probe(fill(s.url)).then(ok => (ok ? s : null)))).then(found =>
      found.filter(Boolean).map(s => ({
        key: `nsw${s.year}`, date: new Date(Date.UTC(s.year, 6, 1)), year: s.year, url: s.url,
        label: String(s.year), detail: s.year === 1943 ? 'Aerial photo · Sydney 1943' : `Aerial photo · NSW historical imagery ${s.year}`,
      })));
  }

  // ── The layer for one stop ─────────────────────────────────────────────────
  // Made on first use rather than at load, so this file does not need Leaflet
  // to have arrived before it.
  let QldTiles = null;
  const qldTiles = () => QldTiles || (QldTiles = L.TileLayer.extend({
    getTileUrl(c) {
      const R = 20037508.342789244, s = 2 * R / 2 ** c.z;
      const bbox = [-R + c.x * s, R - (c.y + 1) * s, -R + (c.x + 1) * s, R - c.y * s].join(',');
      const rule = encodeURIComponent(JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [this.options.rasterId] }));
      return `${this.options.svc}/exportImage?f=image&format=jpgpng&transparent=true&bbox=${bbox}`
        + `&bboxSR=3857&imageSR=3857&size=256,256&mosaicRule=${rule}`;
    },
  }));

  function layerFor(stop) {
    const base = { pane: PANE, maxZoom: 19, attribution: ATTR[src] };
    if (src === 'wayback') {
      const url = stop.url.replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}');
      return L.tileLayer(url, { ...base, maxNativeZoom: 18 });
    }
    if (src === 'dea') {
      return L.tileLayer.wms(DEA_WMS, { ...base, layers: stop.lyr, styles: 'simple_rgb', format: 'image/png',
        transparent: true, version: '1.3.0', time: `${stop.year}-01-01` });
    }
    if (src === 'qld') {
      // The same server's pictures fail the same way, so a tile that fails is
      // asked for again, twice, a little later.
      const l = new (qldTiles())('', { ...base, svc: stop.svc, rasterId: stop.id, minZoom: 9 });
      l.on('tileerror', ev => {
        const t = ev.tile, n = (+t.dataset.retry || 0) + 1;
        if (n > 2) return;
        t.dataset.retry = n;
        setTimeout(() => { t.src = `${l.getTileUrl(ev.coords)}&try=${n}`; }, 800 * n);
      });
      return l;
    }
    return L.tileLayer(stop.url, { ...base, maxNativeZoom: 18, bounds: SOURCES.nsw.bounds });
  }

  function show() {
    if (layer && map) { map.removeLayer(layer); layer = null; }
    const stop = stops[idx];
    if (map && src && stop) { layer = layerFor(stop); layer.addTo(map); }
    // Moving along the same list only changes the words: rebuilding the bar
    // would replace the slider under a finger that is still dragging it.
    const r = bar && bar.querySelector('.mn-history-range');
    if (r && +r.max === stops.length - 1 && stops.length) paintStop(); else paintBar();
    if (stop && src === 'wayback') taken(stop);
  }

  // When the photo in a Wayback release was taken — Esri's metadata for that
  // release at the middle of the map, at the scale the map is at.
  function taken(stop) {
    if (!stop.meta || stop.takenAt !== undefined || !map) return;
    const ll = map.getCenter(), b = map.getBounds(), sz = map.getSize();
    const url = `${stop.meta}/identify?f=json&geometry=${ll.lng},${ll.lat}&geometryType=esriGeometryPoint&sr=4326`
      + `&layers=top&tolerance=0&returnGeometry=false&mapExtent=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`
      + `&imageDisplay=${sz.x},${sz.y},96`;
    stop.takenAt = null;
    getJSON(url).then(d => {
      const a = d && d.results && d.results[0] && d.results[0].attributes;
      if (!a) return;
      const m = /^(\d{4})(\d\d)(\d\d)$/.exec(a.SRC_DATE || '');
      stop.takenAt = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      stop.who = a.NICE_DESC || '';
      stop.res = a.SRC_RES ? `${+(+a.SRC_RES).toFixed(2)} m pixels` : '';
      if (stops[idx] === stop) paintStop();
    });
  }

  // ── Finding the stops again as the map moves ───────────────────────────────
  function placeKey(ll, zoom) {
    if (src === 'dea') return 'all';
    if (src === 'wayback') { const t = tileAt(ll.lat, ll.lng, Math.max(11, Math.min(16, Math.round(zoom)))); return `${t.z}/${t.y}/${t.x}`; }
    const t = tileAt(ll.lat, ll.lng, src === 'nsw' ? 14 : 13);
    return `${t.z}/${t.y}/${t.x}`;
  }

  function refresh(force) {
    if (!map || !src) return;
    const ll = map.getCenter(), zoom = map.getZoom(), S = SOURCES[src];
    if (!inside(S.bounds, ll)) {
      note = `${S.name} cover ${src === 'qld' ? 'Queensland' : 'New South Wales'} only. Move the map there, or pick Esri Wayback or Satellite years — they cover all of Australia.`;
      stops = []; idx = -1; lastKey = ''; show(); return;
    }
    if (S.minZoom && zoom < S.minZoom) {
      note = `Zoom in closer to see ${S.name} — they are shown from about town size in.`;
      stops = []; idx = -1; lastKey = ''; show(); return;
    }
    const key = placeKey(ll, zoom);
    if (!force && key === lastKey) return;
    lastKey = key;
    const had = stops[idx] ? stops[idx].date : null;
    const mine = ++seq, ck = `${src}|${key}`;
    const go = cache.has(ck) ? Promise.resolve(cache.get(ck))
      : (src === 'wayback' ? stopsWayback(ll, zoom) : src === 'dea' ? stopsDea() : src === 'qld' ? stopsQld(ll) : stopsNsw(ll));
    busy = true; note = ''; paintBar();
    go.then(list => {
      if (mine !== seq) return;
      busy = false;
      if (list) cache.set(ck, list);
      stops = list || [];
      note = !list ? `${S.name} did not answer just now. Move the map a little to ask again.`
           : !stops.length ? `${S.name} have no pictures for the middle of the map. Try another source, or move the map.` : '';
      // Stay on the same date, as near as this place has one; else the newest.
      idx = stops.length - 1;
      if (had && stops.length) {
        let best = 0;
        stops.forEach((s, i) => { if (Math.abs(s.date - had) <= Math.abs(stops[best].date - had)) best = i; });
        idx = best;
      }
      show();
    });
  }

  function onMove() { clearTimeout(timer); timer = setTimeout(() => refresh(false), 500); }

  // ── The slider on the map ──────────────────────────────────────────────────
  function buildBar() {
    if (!map || bar) return;
    bar = L.DomUtil.create('div', 'mn-history-bar', map.getContainer());
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Imagery over time');
    bar.dataset.tour = 'imagery-history';
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.disableScrollPropagation(bar);
    bar.addEventListener('input', ev => {
      if (ev.target.classList.contains('mn-history-range')) { idx = +ev.target.value; show(); }
    });
    bar.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-step],button[data-off]');
      if (!b) return;
      if (b.dataset.off !== undefined) { setSource(null); return; }
      const n = idx + +b.dataset.step;
      if (n >= 0 && n < stops.length) { idx = n; show(); }
    });
  }

  function stopLines(stop) {
    const when = stop.when === 'release' ? term('Release', 'release') : stop.when === 'taken' ? term('Taken', 'taken') : '';
    const takenLine = stop.takenAt ? `${term('Taken', 'taken')} ${e(dayText(stop.takenAt))}${stop.who ? ` · ${e(stop.who)}` : ''}${stop.res ? ` · ${e(stop.res)}` : ''}` : '';
    return { date: `${when ? `${when} ` : ''}<strong>${e(stop.label)}</strong>`, detail: takenLine || e(stop.detail) };
  }

  function paintStop() {
    const stop = stops[idx];
    if (!bar || !stop) return;
    const t = stopLines(stop);
    const q = c => bar.querySelector(c);
    if (q('.mn-history-date')) q('.mn-history-date').innerHTML = t.date;
    if (q('.mn-history-detail')) q('.mn-history-detail').innerHTML = t.detail;
    const r = q('.mn-history-range');
    if (r) { if (+r.value !== idx) r.value = idx; r.setAttribute('aria-valuetext', stop.label); }
    if (q('.mn-history-prev')) q('.mn-history-prev').disabled = idx <= 0;
    if (q('.mn-history-next')) q('.mn-history-next').disabled = idx >= stops.length - 1;
  }

  function paintBar() {
    if (!map) return;
    if (!src) { if (bar) { bar.remove(); bar = null; } paintPanel(); return; }
    buildBar();
    const S = SOURCES[src], stop = stops[idx];
    const active = document.activeElement && bar.contains(document.activeElement) ? document.activeElement.className : '';
    const t = stop ? stopLines(stop) : null;
    bar.innerHTML = `
      <div class="mn-history-head">
        <span class="mn-history-src">🕰️ ${term(S.name, src)} <span class="small">· ${e(S.span)}</span></span>
        <button type="button" class="mn-history-off" data-off aria-label="Turn imagery over time off" title="Turn imagery over time off">✕</button>
      </div>
      ${stop ? `
      <div class="mn-history-date" aria-live="polite">${t.date}</div>
      <div class="mn-history-row">
        <button type="button" class="mn-history-prev" data-step="-1" aria-label="Older" title="Older" ${idx <= 0 ? 'disabled' : ''}>◀</button>
        <input type="range" class="mn-history-range" min="0" max="${Math.max(0, stops.length - 1)}" step="1" value="${idx}"
               aria-label="Date of the imagery" aria-valuetext="${e(stop.label)}">
        <button type="button" class="mn-history-next" data-step="1" aria-label="Newer" title="Newer" ${idx >= stops.length - 1 ? 'disabled' : ''}>▶</button>
      </div>
      <div class="mn-history-ends small"><span>${e(stops[0].label)}</span><span>${stops.length} ${stops.length === 1 ? 'date' : 'dates'} ${term('at the middle of the map', 'middle')}</span><span>${e(stops[stops.length - 1].label)}</span></div>
      <div class="mn-history-detail small">${t.detail}</div>` : ''}
      ${busy ? '<div class="mn-history-note small">Finding the dates for the middle of the map…</div>' : ''}
      ${note ? `<div class="mn-history-note small">${e(note)}</div>` : ''}
      <div class="mn-history-attr small">${e(ATTR[src])}</div>`;
    if (active) { const el = bar.querySelector(`.${active.split(' ')[0]}`); if (el) el.focus(); }
    paintPanel();
  }

  // ── The panel: which source, and what the words mean ───────────────────────
  function panelHtml() {
    return `<div class="mn-history-panel">
      <p class="small">Scrub back through dated pictures of the ground. Pick a source and a slider appears at the foot of the map; it finds the dates for the ${term('middle of the map', 'middle')} each time you move it.</p>
      <div class="pill-row mn-history-sources" role="group" aria-label="Imagery source">
        <button type="button" class="pill${src ? '' : ' is-on'}" data-src="" aria-pressed="${!src}">Off</button>
        ${ORDER.map(id => `<button type="button" class="pill${src === id ? ' is-on' : ''}" data-src="${id}" aria-pressed="${src === id}" title="${e(WORDS[id])}">${e(SOURCES[id].name)}</button>`).join('')}
      </div>
      <ul class="mn-history-list small">
        ${ORDER.map(id => `<li>${term(SOURCES[id].name, id)} — ${e(SOURCES[id].span)}</li>`).join('')}
      </ul>
      <details class="mn-history-words"><summary>What the words on this panel mean</summary>
        <dl class="small">${[['Esri Wayback', 'wayback'], ['Satellite years', 'dea'], ['Queensland photos', 'qld'], ['NSW photos', 'nsw'],
          ['Release', 'release'], ['Taken', 'taken'], ['cm / m pixels', 'pixel'], ['At the middle of the map', 'middle']]
          .map(([t, k]) => `<dt>${e(t)}</dt><dd>${e(WORDS[k])}</dd>`).join('')}</dl>
      </details>
      <p class="small mn-history-credit">Imagery: Esri World Imagery Wayback; Geoscience Australia (DEA GeoMAD, CC BY 4.0); State of Queensland (CC BY 4.0); NSW Spatial Services (CC BY 4.0).</p>
    </div>`;
  }

  function paintPanel() {
    if (!body) return;
    body.querySelectorAll('.mn-history-sources .pill').forEach(b => {
      const on = (b.dataset.src || null) === src;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function setSource(id) {
    id = id && SOURCES[id] ? id : null;
    if (id === src) return;
    src = id; stops = []; idx = -1; lastKey = ''; note = ''; busy = false; seq++;
    if (!src) { if (layer && map) map.removeLayer(layer); layer = null; }
    paintBar();
    refresh(true);
    try { document.dispatchEvent(new CustomEvent('mn-imagery-history', { detail: { source: src } })); } catch (_) {}
  }

  return {
    WORDS,
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      m.on('moveend', onMove);
      if (typeof MapChrome !== 'undefined' && MapChrome.panel) {
        MapChrome.panel(m, {
          id: 'history', icon: '🕰️', dockIcon: typeof Glyphs !== 'undefined' ? Glyphs.rail('history') : '🕰️',
          title: 'Imagery over time', name: 'Over time',
          btnLabel: 'Imagery over time — a slider through dated pictures of the ground, 1943 to now',
          group: 'show', order: 25,
          html: () => panelHtml(),
          onMount(el) {
            body = el;
            el.addEventListener('click', ev => {
              const b = ev.target.closest('button[data-src]');
              if (b) setSource(b.dataset.src || null);
            });
          },
          live: () => !!src,
          clear: () => setSource(null),
        });
      }
      if (src) { lastKey = ''; refresh(true); }
    },
    detach() {
      if (map) map.off('moveend', onMove);
      clearTimeout(timer);
      if (layer && map) map.removeLayer(layer);
      if (bar) bar.remove();
      layer = null; bar = null; body = null; map = null; seq++;
    },
    // For the imagery-source pill (job B), and the checks.
    sources: () => ORDER.map(id => ({ ...SOURCES[id], words: WORDS[id], attribution: ATTR[id] })),
    source: () => src,
    setSource,
    stops: () => stops.map(s => ({ key: s.key, label: s.label, date: s.date.toISOString().slice(0, 10) })),
    index: () => idx,
    setIndex(i) { if (i >= 0 && i < stops.length) { idx = i; show(); } },
    _tileAt: tileAt,
  };
})();

if (typeof window !== 'undefined') window.MapHistory = MapHistory;
