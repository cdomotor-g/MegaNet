// MegaNet — map-feed-tip.js
//
//   MapFeedTip   what the More map layers (map-feeds.js) show under the
//                pointer, as a hover tip: the power line or cable and its
//                voltage, whether it is overhead or underground and its crane
//                exclusion zone; the pipe, its size, material and depth; the
//                pipeline and who runs it; the flood outline, dam-failure
//                area, park, heritage group, biosecurity zone, fence or weed
//                square; the acid sulfate soil, the soil type; how often
//                satellites have seen water there; and the wind region.
//                Stacked with the property tip and the road's, river's and
//                bridge's names (map-tip-stack.js), and off with them by 💬.
//
// Asked for in these words (20 Nov 2026, after the Before you dig view): "add
// relevant details to the mouseover tool tip for any items under the pointer".
// The layers are pictures from other people's map services, so the map knows
// nothing about what it shows: each is asked about the point, the way the
// station card's "Open data here" and 🚧 Before you dig ask.
//
// ── What it costs ────────────────────────────────────────────────────────────
// Nothing until the pointer rests (PAUSE_MS) with a layer on that is drawn at
// this zoom; then one question to each such layer's service (Energex and Ergon
// one each, a pipe owner one a kind), within TOL_PX of the pointer. Answers are
// kept for the spot (to about a pixel at that zoom), so coming back asks
// nothing; an answer still out when the pointer moves on is dropped. The
// gauge and tide pins and the weed dots have their own hover, and are not
// asked here.
//
// ── Pointer conventions ──────────────────────────────────────────────────────
// map-property-tip.js's: a mouse or a pen rests; a finger taps and the tip
// stays until the next tap or the map moves. Nothing while a draw tool, a link
// pick or What is here owns the pointer, in 3-D, or with 💬 off.
//
// After core.js and map-feeds.js, before init.js; every call to another
// module is at run time, so its place among the modules is free.
//
// Exposes: attach, detach, linesAt, _state.

const MapFeedTip = (function () {
  const PAUSE_MS = 450;
  const TOL_PX = 8;
  const KEEP = 80;
  const MAX_LINES = 10;
  const FINEST = [1902, 1952, 2002, 2052];   // acid sulfate maps, finest first

  let map = null, tip = null, raf = null, timer = null, seq = 0, asked = 0;
  let lastLL = null, lastText = '', lastKey = '';
  const kept = new Map();   // spot key → lines

  const S = () => (typeof MapFeeds !== 'undefined' && MapFeeds.digSources ? MapFeeds.digSources() : null);
  const attr = (r, ...names) => {
    const a = (r && r.attributes) || r || {};
    for (const n of names) { const v = a[n]; if (v != null && v !== '' && v !== 'Null' && v !== ' ') return String(v).trim(); }
    return '';
  };
  const kvOf = v => parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || 0;
  const zone = kv => (typeof MapDig !== 'undefined' && MapDig.exclusionM ? MapDig.exclusionM(kv) : kv > 330 ? 8 : kv > 132 ? 6 : 3);

  function busy() {
    if (typeof state === 'undefined') return true;
    if (typeof MapTipStack !== 'undefined' && MapTipStack.off && MapTipStack.off()) return true;
    if (state.map3d) return true;
    if (state.draw && state.draw.tool) return true;
    if (state.link && state.link.picking) return true;
    if (typeof MapHere !== 'undefined' && typeof MapHere.armed === 'function' && MapHere.armed()) return true;
    return false;
  }

  // The layers on, drawn at this zoom, holding this point, that are asked
  // here (not the pins, which name themselves).
  function live(ll) {
    const s = S();
    if (!s || !map || typeof MapFeeds === 'undefined') return [];
    const z = map.getZoom();
    const on = new Set(MapFeeds.enabledList());
    return MapFeeds.FEEDS.filter(f => on.has(f.id) && !['gauge', 'tide', 'ala'].includes(f.kind)
      && z >= (f.minZoom || 0) && s.inBox(f, ll.lat, ll.lng));
  }

  function tolM(ll) {
    const mpp = 156543.03392 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
    return Math.max(2, mpp * TOL_PX);
  }
  function spotKey(ll, feeds) {
    const step = tolM(ll) / 4 / 111320;
    return `${Math.round(ll.lat / step)},${Math.round(ll.lng / step)},${map.getZoom()},${feeds.map(f => f.id).join('+')},${state.mapWind ? 1 : 0}`;
  }

  // ── Each kind of layer, asked about one point ───────────────────────────────

  function arcgisLines(f, ll, m) {
    const s = S();
    const layers = s.layersOf(f);
    if (!layers.length) return Promise.resolve([]);
    // Lines and points are found within the tolerance; an area is the one
    // under the point.
    const r = f.pane === 'lines' || f.id === 'ga-power' || f.id === 'ga-pipes' ? m : 1;
    return s.identify(f.url, layers, ll.lat, ll.lng, r).then(rs => sayArcgis(f, rs.filter(x => layers.includes(x.layerId))));
  }

  function sayArcgis(f, rs) {
    const out = [];
    const add = t => { if (t && !out.includes(t)) out.push(t); };
    switch (f.id) {
      case 'ga-power':
        for (const r of rs) {
          const name = attr(r, 'Feature Name', 'feature_name') || r.value;
          if (r.layerId === 2) {
            const kv = kvOf(attr(r, 'Capacity_kV', 'capacity_kv'));
            const under = /under/i.test(attr(r, 'Feature Subtype', 'feature_subtype'));
            add(`⚡ Transmission ${under ? 'cable, underground' : 'line, overhead'}${kv ? `, ${kv} kV` : ''}${under ? '' : ` · crane exclusion zone ${zone(kv)} m`} — ${name}`);
          } else add(`⚡ ${r.layerId === 0 ? 'Substation' : 'Power station'} — ${name}`);
        }
        break;
      case 'ga-pipes':
        for (const r of rs) {
          const st = attr(r, 'status', 'Status');
          add(`🛢️ ${r.layerId === 1 ? 'Gas' : 'Oil'} pipeline (high pressure) — ${attr(r, 'feature_name', 'Feature Name') || r.value}`
            + `${attr(r, 'operator') ? ` · ${attr(r, 'operator')}` : ''}${st && !/operation|operational/i.test(st) ? ` · ${st.toLowerCase()}` : ''}`);
        }
        break;
      case 'qld-flood-history':
        for (const r of rs) add(`🌊 Past flood reached here — ${String(r.layerName || '').replace(/ Floodline /, ' — ')}`);
        break;
      case 'qld-dam-flood':
        for (const r of rs) add(`🌊 Dam-failure flood area — ${attr(r, 'Dam name') || r.value}, ${r.layerId === 51 ? 'sunny day failure' : r.layerId === 52 ? 'largest flood, no failure' : 'largest flood with a failure'}`);
        break;
      case 'qld-heritage':
        for (const r of rs) add(`🪃 Cultural heritage ${r.layerId === 5 ? 'body' : 'party'} — ${attr(r, 'Name', 'NAME') || r.value}: talk to them before ground is disturbed`);
        break;
      case 'qld-parks': case 'capad':
        for (const r of rs) add(`🌳 ${attr(r, 'Estate name', 'ESTATENAME', 'NAME', 'Name') || r.value}${attr(r, 'TYPE', 'Type') ? ` (${attr(r, 'TYPE', 'Type')})` : ''} — works need a permit`);
        break;
      case 'qld-biosecurity':
        for (const r of rs) {
          const v = attr(r, 'Biosecurity zone', 'Feature') || r.value || '';
          add(`🐜 ${/^(infested|free)$/i.test(v) ? `Cattle tick ${v.toLowerCase()} area` : v}${/fire ant|electric ant/i.test(v) ? ' — soil, mulch and gravel leave only under the rules' : ''}`);
        }
        break;
      case 'qld-fences':
        for (const r of rs) add(`🚧 ${r.layerName || r.value} — close the gate behind you`);
        break;
      case 'qld-weeds':
        for (const r of rs) {
          const dec = attr(r, 'State declaration');
          add(`🌿 Weed survey: ${attr(r, 'Common name') || r.layerName} in this 17 km square${dec && !/not declared/i.test(dec) ? ` (${dec.toLowerCase()})` : ''}`);
        }
        break;
      case 'qld-acid-sulfate': {
        const level = t => (typeof SiteExposure !== 'undefined' && SiteExposure.assLevel ? SiteExposure.assLevel(t) : 'unclear');
        const scale = { 1902: '1:25 000', 1952: '1:50 000', 2002: '1:100 000', 2052: 'national atlas' };
        const best = rs.filter(r => FINEST.includes(r.layerId))
          .map(r => ({ r, words: attr(r, 'Map code meaning', 'map_code_meaning', 'Probability class definition', 'probclass_def', 'Probability class') || r.value }))
          .filter(x => x.r.layerId === 2052 || level(x.words) !== 'unassessed')
          .sort((a, b) => FINEST.indexOf(a.r.layerId) - FINEST.indexOf(b.r.layerId))[0];
        if (best) add(`🧪 Acid sulfate soil — ${best.words} (${scale[best.r.layerId]})`);
        break;
      }
      case 'qld-soils':
        for (const r of rs) {
          const order = attr(r, 'Australian Soil Classification Order', 'asc_ord');
          const said = order && typeof MapDig !== 'undefined' && MapDig.SOIL && MapDig.SOIL[order];
          add(`🟫 Soil: ${order || attr(r, 'Map code meaning') || r.value}${said ? ` — ${said[1]}` : ''}`);
        }
        break;
      default:
        for (const r of rs) add(`${f.label}: ${r.value || r.layerName}`);
    }
    return out;
  }

  function networkLines(ll, m) {
    const s = S();
    const box = MapFeeds.boxAround([[ll.lat, ll.lng]], m);
    return Promise.all(s.NET_SERVICES.map(svc => s.netQuery(svc, [...svc.layers.sub, ...svc.layers.hv, ...svc.layers.lv], box,
      { outFields: 'VOLTAGE,UG_OH', geometryPrecision: '6' }).then(json => ({ svc, json }), () => ({ svc, json: null }))))
      .then(rs => {
        const best = [];
        for (const { svc, json } of rs) {
          for (const l of (json && json.layers) || []) {
            const k = Object.keys(svc.layers).find(c => svc.layers[c].includes(l.id));
            if (!k) continue;
            for (const f of l.features || []) {
              const d = MapFeeds.Geo.dist([[ll.lat, ll.lng]], MapFeeds.Geo.ofEsri(f.geometry));
              if (d <= m) best.push({ svc, k, under: svc.cable.has(l.id), volts: attr(f, 'VOLTAGE'), d });
            }
          }
        }
        const seen = new Set();
        return best.sort((a, b) => a.d - b.d).filter(x => { const key = `${x.svc.name}${x.k}${x.under}${x.volts}`; if (seen.has(key)) return false; seen.add(key); return true; })
          .slice(0, 3).map(x => {
            const kv = x.k === 'sub' ? (kvOf(x.volts) || 132) : x.k === 'hv' ? 22 : 1;
            return `⚡ ${x.svc.name}: ${x.under ? 'underground cable' : 'overhead line'}, ${s.NET_CLASS[x.k].words.toLowerCase()}`
              + `${x.volts && x.volts !== 'LV' && x.k !== 'lv' ? ` ${x.volts}` : ''}${x.under ? '' : ` · crane exclusion zone ${zone(kv)} m`}`;
          });
      });
  }

  // A pipe's size, material and depth, from whatever its owner calls them.
  function pipeDetail(a) {
    const find = re => { for (const k of Object.keys(a || {})) if (re.test(k) && a[k] != null && a[k] !== '' && a[k] !== 0) return a[k]; return null; };
    const dia = find(/diam/i), mat = find(/^material$/i), depth = find(/depth/i), name = find(/_NAME$/);
    return [dia ? `${Math.round(Number(dia)) || dia} mm` : '', mat ? String(mat) : '', depth && Number(depth) > 0 ? `about ${Number(depth).toFixed(1)} m deep` : '', name ? String(name) : '']
      .filter(Boolean).join(', ');
  }

  function pipeLines(f, ll, m) {
    const s = S();
    const env = MapFeeds.boxAround([[ll.lat, ll.lng]], m);
    const geo = { geometry: `${env.getWest()},${env.getSouth()},${env.getEast()},${env.getNorth()}`, geometryType: 'esriGeometryEnvelope',
      outFields: '*', returnGeometry: 'true', geometryPrecision: '6' };
    return Promise.all(f.parts.map(part => s.partQuery(part, geo).then(j => {
      let best = null;
      for (const ft of (j && j.features) || []) {
        const d = MapFeeds.Geo.dist([[ll.lat, ll.lng]], MapFeeds.Geo.ofEsri(ft.geometry));
        if (d <= m && (!best || d < best.d)) best = { d, a: ft.attributes };
      }
      if (!best) return null;
      const det = pipeDetail(best.a);
      return `🚰 ${part.words}${det ? ` — ${det}` : ''} (${f.source.by})`;
    }, () => null))).then(xs => xs.filter(Boolean));
  }

  function wmsLines(f, ll) {
    const p = map.latLngToContainerPoint(ll);
    const b = map.getBounds(), size = map.getSize();
    const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const q = new URLSearchParams({
      service: 'WMS', version: '1.3.0', request: 'GetFeatureInfo', layers: f.wmsLayer, query_layers: f.wmsLayer, styles: '',
      crs: 'EPSG:3857', bbox: `${sw.x},${sw.y},${ne.x},${ne.y}`, width: String(size.x), height: String(size.y),
      i: String(Math.round(p.x)), j: String(Math.round(p.y)), info_format: 'application/json', feature_count: '3',
    });
    return S().askJson(`${f.url}?${q}`).then(j => {
      const fs = (j && j.features) || [];
      if (f.id === 'dea-water') {
        const d = fs[0] && fs[0].properties && fs[0].properties.data && fs[0].properties.data[0];
        const band = d && d.bands;
        const fr = band && Number(band.frequency);
        if (!band || !isFinite(fr) || fr <= 0) return [];
        return [`💧 Water seen here ${fr < 0.01 ? 'under 1' : Math.round(fr * 100)} % of the clear satellite looks since 1986 (${band.count_wet} of ${band.count_clear})`];
      }
      return fs.slice(0, 2).map(ft => { const det = pipeDetail(ft.properties || {}); return `🚰 Council drainage pipe${det ? ` — ${det}` : ''}`; });
    });
  }

  function windLine(ll) {
    if (!state.mapWind || typeof MapWind === 'undefined' || !MapWind.regionState) return null;
    const st = MapWind.regionState(ll.lat, ll.lng);
    return st && st.region ? `🌬️ Wind region ${st.text}${/^[CD]/.test(st.region) ? ' — cyclonic' : ''}` : null;
  }

  // Every line for a point, in the order the layers are listed.
  function linesAt(ll) {
    const feeds = live(ll);
    if (!feeds.length) return Promise.resolve([]);
    const m = tolM(ll);
    asked++;
    return Promise.all(feeds.map(f => {
      const go = f.kind === 'network' ? networkLines(ll, m) : f.kind === 'pipes' ? pipeLines(f, ll, m)
        : f.kind === 'wms' ? wmsLines(f, ll) : f.kind === 'arcgis' ? arcgisLines(f, ll, m) : Promise.resolve([]);
      return go.catch(() => [`${f.label}: could not be read`]);
    })).then(parts => {
      const lines = parts.flat();
      const w = lines.length || state.mapDig ? windLine(ll) : null;
      if (w) lines.push(w);
      return lines;
    });
  }

  // ── The tip ─────────────────────────────────────────────────────────────────

  function show(ll, lines) {
    if (!map) return;
    const shown = lines.slice(0, MAX_LINES);
    const more = lines.length - shown.length;
    const utility = lines.some(l => /^(⚡|🛢️|🚰)/.test(l));
    const body = '<div class="mn-prop-tip-h">Map layers here</div>'
      + shown.map(l => `<div class="mn-prop-tip-l">${esc(l)}</div>`).join('')
      + (more > 0 ? `<div class="mn-prop-tip-l">and ${more} more</div>` : '')
      + (utility ? '<div class="mn-prop-tip-l mn-feed-tip-note">A guide, not a locate: Before You Dig Australia (1100).</div>' : '');
    lastText = ['Map layers here', ...shown].join('\n');
    if (!tip) {
      tip = L.tooltip({ className: 'mn-road-label mn-prop-tip mn-feed-tip', direction: 'top', offset: [0, -10], interactive: false })
        .setContent(body).setLatLng(ll).addTo(map);
    } else tip.setLatLng(ll).setContent(body);
  }
  function hide() { if (tip) { tip.remove(); tip = null; } lastText = ''; }

  function ask(ll) {
    const feeds = live(ll);
    if (!feeds.length || busy()) { hide(); return; }
    const key = spotKey(ll, feeds);
    lastKey = key;
    if (kept.has(key)) { const l = kept.get(key); if (l.length) show(ll, l); else hide(); return; }
    const me = ++seq;
    linesAt(ll).then(lines => {
      kept.set(key, lines);
      if (kept.size > KEEP) kept.delete(kept.keys().next().value);
      if (me !== seq || lastLL !== ll) return;
      if (lines.length) show(ll, lines); else hide();
    });
  }

  let press = { type: '', at: 0 };
  const onPress = ev => { press = { type: ev.pointerType || '', at: Date.now() }; };
  const fingerLately = () => press.type === 'touch' && Date.now() - press.at < 1200;

  let nextLL = null;
  function onMove(e) {
    if (!map) return;
    const ev = e && e.originalEvent;
    if ((ev && ev.pointerType === 'touch') || fingerLately()) return;
    nextLL = e.latlng;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const ll = nextLL;
      lastLL = ll;
      seq++;
      clearTimeout(timer);
      hide();
      if (busy() || !live(ll).length) return;
      timer = setTimeout(() => { timer = null; if (lastLL === ll) ask(ll); }, PAUSE_MS);
    });
  }
  function onTap(e) {
    if (!map || !fingerLately()) return;
    const ll = e.latlng;
    setTimeout(() => {
      if (!map || (map._popup && map.hasLayer(map._popup))) return;
      clearTimeout(timer); timer = null;
      lastLL = ll; seq++;
      ask(ll);
    }, 0);
  }
  function onOut() { lastLL = null; seq++; clearTimeout(timer); timer = null; hide(); }

  return {
    attach(m) {
      if (map === m) return;
      if (map) this.detach();
      map = m;
      m.on('mousemove', onMove);
      m.on('click', onTap);
      m.on('mouseout movestart zoomstart', onOut);
      m.getContainer().addEventListener('pointerdown', onPress, true);
    },
    detach() {
      if (!map) return;
      map.off('mousemove', onMove);
      map.off('click', onTap);
      map.off('mouseout movestart zoomstart', onOut);
      map.getContainer().removeEventListener('pointerdown', onPress, true);
      onOut();
      map = null;
    },
    linesAt: (lat, lon) => linesAt(L.latLng(lat, lon)),
    // For the checks: the tip for a point, as a rest of the pointer there would.
    _ask(lat, lon) { lastLL = L.latLng(lat, lon); ask(lastLL); },
    _state() { return { text: lastText, shown: !!tip, asked, kept: kept.size, key: lastKey, keys: [...kept.keys()] }; },
    _forget() { kept.clear(); asked = 0; },
  };
})();
if (typeof window !== 'undefined') window.MapFeedTip = MapFeedTip;
