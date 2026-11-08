// Views on the Stations map (map-views.js, map-paths.js, map-flow.js,
// map-tails.js, map-overlay.js; easements and tenure in map-lots.js; the
// base-map setter in map-controls.js), against the real page.
//
// Views is a section at the top of Layers that sets a dozen other modules'
// switches in one press, and four ways of drawing the radio paths that each
// change what every link's opacity is. Every other check here opens the map on
// its defaults — every path, plain lines, the person's own Link opacity — so a
// chip that sets half its switches, a Put the map back that forgets the base
// map, a Best path only that leaves three lines on one station, a Tails that
// leaves the lines clickable at nothing, or a 3-D view that copies a tail's
// zero across all pass every one of them. So:
//
//   1. **Where it sits, and today's map.** The Views block is above Find a
//      control and outside the block it filters (a term that hides rows hides
//      no chip). A device that has never picked anything draws today's map:
//      nothing written, every path straight, every line at the Link opacity,
//      no filter on the tiles, no chip pressed, "Your own mix".
//   2. **Put the map back** after a view is every switch as it was before —
//      read off `state`, the base-map mix and the drawing settings, not off
//      MapViews' own snapshot, which would agree with itself.
//   3. **Every built-in view**, pressed with a real pointer: each switch the
//      build spec says it sets (§7.4), read off the state key the switch's own
//      module keeps, and every knob the view lists; its chip pressed and the
//      only one; the map rebuilt at most once while its switches are set.
//   4. **Keep this mix**: Save keeps the map as it is, a reload brings the view
//      back and still in force, pressing it after another view puts it back,
//      and ✕ removes it.
//   5. **Which paths**: best path only — at most one field line per field
//      station, fewer than every path; best until zoomed in — best below
//      zoom 11, every path from it; bundled — every path, some drawn as curves
//      that still run station → repeater; areas — no field line at all, the
//      areas canvas painted.
//   6. **Tails & spotlight**: every field line at 0 and not interactive until
//      a real pointer moves over a field pin, which lights that pin's lines;
//      leaving the map puts them out; the tails canvas has ink.
//   7. **Flow**: the flow canvas has ink and changes between two frames; the
//      lines underneath at `under` of their strength; a device asking for less
//      motion gets a still frame until Play; Live readings switches ⏱️
//      Latency's animation on and back off — but never off when it was the
//      person's own.
//   8. **Auto-contrast** changes the lines' strength between two zooms, is
//      what the lines are drawn at, disables the Link opacity slider with a
//      note, and never writes `mn-map-link-opacity`. **Balance** puts the
//      build spec's filter on the tile pane (not in `mn-base-maps`) and 50
//      takes it off.
//   9. **3-D** (when the browser has WebGL2, as `npm run map3d` needs): with
//      Tails on, the field lines the 2-D map draws at 0 are in the 3-D view's
//      own source at their full strength (`mnFullOpacity`), and closing 3-D
//      puts the 2-D lines back to their tails.
//  10. **Easements and land tenure**: off by default, and with both off the
//      cadastre's export is the one it was before Views, byte for byte; each
//      switch changes the export's layers the way it says; both off again and
//      the URL is the first one exactly.
//
// Everything off-origin is refused (lib/network.mjs) except the cadastre's
// export, the base-map tiles and — for section 9 only — the terrain tiles,
// each answered with a flat picture: what is asserted is what was asked for.
//
// Run:  npm run mapviews
//       npm run mapviews -- -v    also print what passed

import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const GL_TIMEOUT = Number(process.env.MAP3D_TIMEOUT || 45_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  if (!pass) console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const J = v => JSON.stringify(v);
const section = s => console.log(`\n${s}`);

// ── Flat pictures for the routes ─────────────────────────────────────────────
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function flatPng(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const BASE_TILE = flatPng(8, [0x66, 0x99, 0x66]);
// Terrarium: (R × 256 + G + B / 256) − 32768 m, so 128/100/0 is flat ground at 100 m.
const DEM_TILE = flatPng(256, [128, 100, 0]);
const CORS = { 'Access-Control-Allow-Origin': '*' };

// ── What the build spec says each view sets (§7.4), as the state keys the
// switches' own modules keep. Written out here rather than read off
// MapViews.VIEWS, so a view whose values drift from the spec's intent fails.
const ALL = { field: true, repeater: true, base: true };
const FIELD_ONLY = { field: true, repeater: false, base: false };
const STATE_KEY = {
  links: 'mapShowLinks', backbone: 'mapShowBackbone', arrows: 'mapArrows', colour: 'mapLinkColour',
  health: 'mapHealth', outlines: 'mapPinSls', riverLines: 'mapRiverLines', riverCatchment: 'mapRiverCatchment',
  rain: 'mapRain', elev: 'mapElev', catchments: 'mapCatchments', lots: 'mapLots', easements: 'mapEasements',
  tenure: 'mapTenure', roads: 'mapRoads', roadOwners: 'mapRoadOwners', councils: 'mapCouncils',
  survey: 'mapSurvey', hubs: 'mapHubs', wind: 'mapWind', cameras: 'mapCameras', photos: 'mapPhotos',
  siteFeatures: 'mapSiteFeatures', twinOffer: 'mapTwinAuto',
};
const SPEC = {
  overview: { links: true, roles: ALL, backbone: true, arrows: false, colour: 'freq', health: false, outlines: false,
    riverLines: true, riverCatchment: false, rain: false, elev: false, catchments: false, lots: false,
    easements: false, tenure: false, roads: false, roadOwners: false, councils: false, survey: false, hubs: false,
    wind: false, cameras: true, photos: true, siteFeatures: true, twinOffer: false,
    drawing: { paths: 'lod', draw: 'flow', auto: true, balance: 50 } },
  site: { base: 'Satellite', links: true, roles: ALL, backbone: true, arrows: false, colour: 'freq', health: true,
    lots: true, easements: true, roads: true, survey: true, photos: true, siteFeatures: true, cameras: true,
    twinOffer: true, riverLines: true, rain: false, elev: false, catchments: false, tenure: false, roadOwners: false,
    councils: false, hubs: false, wind: false,
    drawing: { paths: 'every', draw: 'tails', follow: true, auto: true, balance: 35 } },
  radio: { base: 'Satellite', links: true, colour: 'freq', backbone: true, arrows: true, health: true, hubs: true,
    riverLines: true, photos: true, siteFeatures: true, twinOffer: true, lots: false, easements: false,
    tenure: false, roads: false, roadOwners: false, councils: false, rain: false, elev: false, catchments: false,
    drawing: { paths: 'every', draw: 'tails', auto: true, balance: 62 } },
  weak: { links: true, colour: 'fade', backbone: true, arrows: false, health: false,
    drawing: { paths: 'every', draw: 'lines', auto: true, balance: 85 } },
  backbone: { roles: { field: false, repeater: true, base: true }, links: true, backbone: true, arrows: true,
    hubs: true, drawing: { draw: 'flow', auto: true, balance: 60 } },
  traffic: { backbone: true, health: true, arrows: false,
    drawing: { paths: 'best', draw: 'flow', flowMode: 'live', auto: true, balance: 65 } },
  rivers: { base: 'OSM-Topo', links: false, backbone: false, arrows: false, roles: FIELD_ONLY, outlines: true,
    health: false, riverLines: true, riverCatchment: true, catchments: true, elev: true, rain: false, cameras: true,
    lots: false, easements: false, tenure: false, roads: false, roadOwners: false, councils: false },
  rain: { base: 'Light', links: false, backbone: false, roles: FIELD_ONLY, outlines: true, riverLines: true,
    catchments: true, rain: true, elev: false },
  property: { base: 'Satellite', links: false, backbone: false, arrows: false, health: false, roles: ALL,
    outlines: false, lots: true, easements: true, roads: true, roadOwners: true, councils: true, survey: true,
    riverLines: true, photos: true, siteFeatures: true, twinOffer: true, rain: false, elev: false, catchments: false,
    hubs: false, wind: false },
  land: { base: 'OSM-Topo', links: false, backbone: false, roles: ALL, tenure: true, lots: true, easements: true,
    riverLines: true, catchments: true, councils: true, roads: true, elev: false, rain: false },
};

// The cadastre export's layers as they were before Views (git d38649d,
// map-lots.js dynamicLayers): what "easements and tenure off is the export it
// always was" is held to, literally.
function lotsOnlyLayers(id, labelScale = 5000, labelWhere = null) {
  const outline = (color, width) => ({
    type: 'simple',
    symbol: { type: 'esriSFS', style: 'esriSFSNull',
              outline: { type: 'esriSLS', style: 'esriSLSSolid', color, width } },
  });
  return JSON.stringify([
    { id: 1, source: { type: 'mapLayer', mapLayerId: id },
      drawingInfo: {
        renderer: outline([255, 255, 255, 235], 0.9),
        showLabels: true,
        labelingInfo: [{
          labelExpressionInfo: { expression: '$feature.lotplan' },
          labelPlacement: 'esriServerPolygonPlacementAlwaysHorizontal',
          minScale: labelScale,
          ...(labelWhere ? { where: labelWhere } : {}),
          symbol: { type: 'esriTS', color: [255, 255, 255, 255],
                    haloColor: [20, 20, 20, 220], haloSize: 1.5,
                    font: { family: 'Arial', size: 9 } },
        }],
      } },
    { id: 0, source: { type: 'mapLayer', mapLayerId: id },
      drawingInfo: { renderer: outline([20, 20, 20, 150], 2.4), showLabels: false } },
  ]);
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(`${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
  // Registered after the policy, so consulted first.
  let demOn = false;
  await page.route(/elevation-tiles-prod\/terrarium\/\d+\/\d+\/\d+\.png/, route => (demOn
    ? route.fulfill({ status: 200, contentType: 'image/png', body: DEM_TILE, headers: CORS })
    : route.abort('blockedbyclient')));
  await page.route(/(tile\.openstreetmap\.org|tile\.opentopomap\.org|server\.arcgisonline\.com|basemaps\.cartocdn\.com)/,
    route => route.fulfill({ status: 200, contentType: 'image/png', body: BASE_TILE, headers: CORS }));
  const cadAsked = [];
  await page.route(/LandParcelPropertyFramework\/MapServer\/export\?/, route => {
    cadAsked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: BASE_TILE, headers: CORS });
  });

  const settle = (ms = 500) => page.waitForTimeout(ms);
  const boot = async () => {
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: LOAD_TIMEOUT });
    await settle(600);
  };
  // Layers: a pane of the side panel on a wide screen, else its corner flyout.
  const openLayers = async () => {
    await page.evaluate(() => {
      const wrap = document.querySelector('.mn-mapctl[data-panel="display"]');
      if (wrap && wrap.classList.contains('is-docked')) setDockTab('map-display');
      else if (wrap) wrap.querySelector('.mn-mapctl-btn').click();
    });
    await page.waitForFunction(() => {
      const b = document.getElementById('map-views-block');
      return !!b && b.getClientRects().length > 0;
    }, null, { timeout: 10_000 });
    await settle(300);
  };
  // A control inside one of the section's folds (How the radio paths are
  // drawn, Line strength) is opened the way a person would: by its summary.
  const unfold = async sel => {
    const shut = await page.evaluate(q => {
      const el = document.querySelector(q);
      const d = el && el.closest('details.mv-fold');
      return d && !d.open ? `#${d.id} > summary` : null;
    }, sel);
    if (shut) { await page.click(shut); await settle(200); }
  };
  // A real pointer on a control of the panel, scrolled to first.
  const press = async (sel, ms = 500) => {
    await unfold(sel);
    await page.locator(sel).first().scrollIntoViewIfNeeded();
    await page.click(sel);
    await settle(ms);
  };
  const view = async (lat, lon, zoom, ms = 700) => {
    await page.evaluate(([a, b, z]) => state.map.setView([a, b], z, { animate: false }), [lat, lon, zoom]);
    await settle(ms);
  };
  // What is drawn: lines by role, field cores per station, curves.
  const lineStats = () => page.evaluate(() => {
    const by = {}, per = new Map();
    let curved = 0;
    for (const l of state.mapLines) {
      by[l.mnLinkRole] = (by[l.mnLinkRole] || 0) + 1;
      if (l.mnLinkRole !== 'core') continue;
      per.set(l.mnLinkStationId, (per.get(l.mnLinkStationId) || 0) + 1);
      if (l.getLatLngs().length > 2) curved++;
    }
    let maxPer = 0;
    for (const n of per.values()) if (n > maxPer) maxPer = n;
    return { core: by.core || 0, casing: by.casing || 0, backbone: by.backbone || 0, stations: per.size, maxPer,
             curved, thinned: state.mapLinkCount.thinned, mode: MapPaths.mode(), zoom: state.map.getZoom() };
  });
  // The ink on one of the overlays' canvases (a pane can hold more than one:
  // MapTails draws its spotlight on a canvas of its own): how many pixels,
  // and a hash of where they are and what colour, to tell two frames apart.
  const ink = cls => page.evaluate(k => {
    const c = state.map.getContainer().querySelector(`canvas.${k}`);
    if (!c) return { none: true };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, h = 2166136261;
    for (let i = 3; i < d.length; i += 4) {
      if (!d[i]) continue;
      n++;
      h = Math.imul(h ^ (i * 31 + d[i - 3] * 7 + d[i - 2] * 5 + d[i - 1] * 3 + d[i]), 16777619) >>> 0;
    }
    return { n, h, vis: c.style.visibility };
  }, cls);
  // Every switch a view can set, read off the state its own module keeps.
  const readKnobs = () => page.evaluate(K => {
    const out = {};
    for (const [k, key] of Object.entries(K)) out[k] = state[key];
    out.roles = {};
    for (const r of ['field', 'repeater', 'base']) out.roles[r] = !state.mapRolesOff.has(r);
    const mix = state.map.mnBases.mix();
    out.mix = mix;
    out.order = state.map.mnBases.order();
    out.basesOn = Object.entries(mix).filter(([, v]) => v && v.on).map(([n]) => n);
    out.settings = MapViews.settings();
    return out;
  }, STATE_KEY);
  // Where a read differs from what a view (the spec's or its own) wants.
  function knobDiffs(got, want) {
    const bad = [];
    for (const [k, w] of Object.entries(want)) {
      if (w == null) continue;
      if (k === 'base') {
        const name = typeof w === 'string' ? w : null;
        if (name && !(got.basesOn.length === 1 && got.basesOn[0] === name)) bad.push(`base: ${J(got.basesOn)} not [${name}]`);
      } else if (k === 'roles') {
        for (const r of ['field', 'repeater', 'base']) {
          if ((w[r] !== false) !== got.roles[r]) bad.push(`roles.${r}: ${got.roles[r]}`);
        }
      } else if (k === 'drawing') {
        const s = got.settings;
        for (const [dk, dv] of Object.entries(w)) {
          let have, wantV;
          if (dk === 'flowMode') { have = s.flow.mode; wantV = dv; }
          else if (dk === 'follow') { have = s.tails.follow; wantV = dv; }
          else if (dk === 'flow') { if (!dv || dv.mode == null) continue; have = s.flow.mode; wantV = dv.mode; }
          else if (dk === 'tails') { if (!dv || dv.follow == null) continue; have = s.tails.follow; wantV = dv.follow; }
          else { have = s[dk]; wantV = dv; }
          if (have !== wantV) bad.push(`drawing.${dk}: ${J(have)} not ${J(wantV)}`);
        }
      } else if (k in STATE_KEY) {
        const have = got[k];
        const same = typeof w === 'boolean' ? !!have === w : have === w;
        if (!same) bad.push(`${k} (state.${STATE_KEY[k]}): ${J(have)} not ${J(w)}`);
      } else {
        bad.push(`${k}: a knob this check does not know`);
      }
    }
    return bad;
  }

  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await boot();
  await openLayers();

  // Count the map's real rebuilds — a refreshMapLayers call that replaced the
  // lines, whatever the hold said, so a build that ignores the hold is
  // counted too — and the ones made while a view is applied, read round
  // MapViews.apply itself (what the chip's onclick calls), which is
  // synchronous. Not round the click: the panel stops a click's propagation,
  // so a listener on window never hears it.
  const countBuilds = () => page.evaluate(() => {
    if (window.__mvBuilds) return;
    const orig = window.refreshMapLayers;
    window.__mvBuilds = { n: 0, during: null };
    window.refreshMapLayers = function (...a) {
      const was = state.mapLines;
      const r = orig.apply(this, a);
      if (state.mapLines !== was) window.__mvBuilds.n++;
      return r;
    };
    const apply = MapViews.apply;
    MapViews.apply = function (...a) {
      const b = window.__mvBuilds.n;
      try { return apply.apply(this, a); } finally { window.__mvBuilds.during = window.__mvBuilds.n - b; }
    };
  });

  // ── 1. Where it sits, and today's map ─────────────────────────────────────
  section('1. Where Views sits, and a device that has never picked anything');
  const place = await page.evaluate(() => {
    const v = document.getElementById('map-views-block');
    const f = document.getElementById('map-display-find');
    const d = document.getElementById('map-display-block');
    return {
      views: !!v, find: !!f,
      before: !!(v && f && (v.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING)),
      above: !!(v && f && v.getBoundingClientRect().bottom <= f.getBoundingClientRect().top + 1),
      outside: !!(v && d && !d.contains(v) && !v.contains(d)),
      filterBlock: !!(v && v.classList.contains('filter-block')),
      heading: v ? (v.querySelector('.map-display-h') || {}).textContent : null,
      chips: v ? v.querySelectorAll('button.mv-chip').length : 0,
      groups: v ? [...v.querySelectorAll('.mv-group-h')].map(e => e.textContent.trim()) : [],
      builtIn: MapViews.VIEWS.length,
      titled: v ? [...v.querySelectorAll('button.mv-chip')].every(b => (b.title || '').length > 30) : false,
    };
  });
  check('Layers has the Views block, headed Views, with a chip button for every built-in view',
    place.views && place.heading === 'Views' && place.chips === place.builtIn && place.builtIn >= 10, J(place));
  check('…its chips in the spec\'s groups, then Your views',
    J(place.groups) === J(['Everyone', 'Technicians', 'Flood', 'Property', 'Your views']),
    J(place.groups));
  check('…every chip saying on hover what the view does', place.titled);
  check('…above the Find a control box, in the page and on screen', place.before && place.above, J(place));
  check('…and outside the block the find box filters, with no filter-block class', place.outside && !place.filterBlock, J(place));

  await page.fill('#map-display-find', 'wind');
  await settle(300);
  const found = await page.evaluate(() => {
    const v = document.getElementById('map-views-block');
    const chips = [...v.querySelectorAll('button.mv-chip')];
    const rows = [...document.getElementById('map-display-block').children]
      .filter(e => e.id !== 'map-display-find-row' && e.id !== 'map-display-find-none');
    return { chipsShown: chips.filter(c => c.getClientRects().length > 0).length, chips: chips.length,
             blockShown: v.getClientRects().length > 0,
             rowsHidden: rows.filter(r => r.getClientRects().length === 0).length, rows: rows.length };
  });
  check('a term in Find a control filters the panel\'s rows but hides no chip of Views',
    found.blockShown && found.chipsShown === found.chips && found.rowsHidden > 0, J(found));
  await page.fill('#map-display-find', '');
  await settle(300);

  const fresh = await page.evaluate(() => {
    const cores = state.mapLines.filter(l => l.mnLinkRole === 'core');
    const casings = state.mapLines.filter(l => l.mnLinkRole === 'casing');
    const v = state.mapLinkOpacity, mix = MAP_LINK_CASING_MIX;
    return {
      stored: localStorage.getItem('mn-map-drawing'), pick: localStorage.getItem('mn-map-view-pick'),
      settings: MapViews.settings(), filter: state.map.getPane('tilePane').style.filter,
      cores: cores.length,
      offCore: cores.filter(l => Math.abs(l.options.opacity - v) > 1e-6 || l.options.interactive === false).length,
      offCasing: casings.filter(l => Math.abs(l.options.opacity - v * mix) > 1e-6).length,
      curved: cores.filter(l => l.getLatLngs().length !== 2).length,
      thinned: state.mapLinkCount.thinned,
      pressed: [...document.querySelectorAll('#map-views-block .mv-chip[aria-pressed="true"]')].map(b => b.id),
      now: (document.getElementById('mv-now') || {}).textContent || '',
      undo: !!document.getElementById('mv-undo'),
      easements: state.mapEasements, tenure: state.mapTenure,
    };
  });
  check('nothing is written until somebody picks something',
    fresh.stored === null && fresh.pick === null, J({ stored: fresh.stored, pick: fresh.pick }));
  check('the drawing settings open as today\'s map: every path, lines, the person\'s own opacity, Balance even',
    J(fresh.settings) === J({ paths: 'every', draw: 'lines', flow: { mode: 'all', speed: 1, under: 0.35, playing: null },
      tails: { len: 24, spot: 90, follow: true, backboneFull: true }, auto: false, balance: 50 }), J(fresh.settings));
  check('…every field line straight, none thinned, each core at the Link opacity and its casing at the casing mix',
    fresh.cores > 500 && fresh.offCore === 0 && fresh.offCasing === 0 && fresh.curved === 0 && fresh.thinned === 0,
    J({ cores: fresh.cores, offCore: fresh.offCore, offCasing: fresh.offCasing, curved: fresh.curved, thinned: fresh.thinned }));
  check('…no filter on the tiles', fresh.filter === '', J(fresh.filter));
  check('…no chip pressed, the line under them saying it is your own mix, nothing to put back',
    fresh.pressed.length === 0 && /Your own mix/.test(fresh.now) && !fresh.undo, J({ pressed: fresh.pressed, now: fresh.now }));
  check('…easements and land tenure off', fresh.easements === false && fresh.tenure === false);

  // With Views untouched its five overlays hold one pixel each: a full-screen
  // canvas on a phone is ten-odd MB, and nobody has asked for these yet.
  const idle = await page.evaluate(() => ['mn-areas-canvas', 'mn-paths-canvas', 'mn-flow-canvas', 'mn-spot-canvas', 'mn-tails-canvas']
    .map(c => { const el = document.querySelector('canvas.' + c); return el ? el.width * el.height : -1; }));
  check('the five Views overlays cost one pixel each until their drawing is chosen', idle.every(n => n === 1), J(idle));

  // The detailed drawing controls sit in one fold that starts shut, so the
  // older Layers rows are not pushed a screen down; its summary still says
  // what is chosen, and opening it is kept. The quick settings (which paths,
  // how drawn, Balance) open under the view in force instead.
  const folds = await page.evaluate(() => [...document.querySelectorAll('#map-views-block details.mv-fold')]
    .map(d => ({ id: d.id, open: d.open, says: d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim() })));
  check('the More drawing settings fold starts shut, its summary naming the choice',
    folds.length === 1 && !folds[0].open && /More drawing settings Every path · Lines · Your Link opacity/.test(folds[0].says), J(folds));
  const quick = await page.evaluate(() => {
    const o = document.getElementById('mv-open');
    return { open: !!o, groups: o ? [...o.querySelectorAll('.mv-q-h')].map(e => e.textContent.trim()) : [],
      pressed: o ? [...o.querySelectorAll('.mv-seg-b[aria-pressed="true"]')].map(b => b.id) : [] };
  });
  check('…and the quick settings show for your own mix: which paths, how drawn, Balance, with what is on pressed',
    quick.open && J(quick.groups) === J(['Which paths', 'Draw them as', 'Balance'])
      && J(quick.pressed) === J(['mv-q-paths-every', 'mv-q-draw-lines', 'mv-q-balance-even']), J(quick));
  await page.click('#mv-card-more > summary');
  await settle(200);
  const foldKept = await page.evaluate(() => { MapViews.rerender(); return { open: document.getElementById('mv-card-more').open,
    stored: localStorage.getItem('mn-map-views-open') }; });
  check('…and the fold opened stays open through a redraw, remembered on the device', foldKept.open && /"more":true/.test(foldKept.stored), J(foldKept));
  await page.click('#mv-card-more > summary');
  await settle(200);

  const words = await page.evaluate(() => {
    const v = document.getElementById('map-views-block');
    const fold = v.querySelector('details.mv-words');
    const dts = fold ? [...fold.querySelectorAll('dt')].map(e => e.textContent) : [];
    const terms = [...v.querySelectorAll('.term')];
    return { fold: !!fold, missing: Object.keys(MapViews.WORDS).filter(k => !dts.includes(k)),
             terms: terms.length, empty: terms.filter(t => !(t.title || '').trim()).map(t => t.textContent) };
  });
  check('every special word in Views has its meaning on hover, and all of them are in its words fold',
    words.fold && words.missing.length === 0 && words.terms >= 8 && words.empty.length === 0, J(words));

  // ── 2. Put the map back ───────────────────────────────────────────────────
  section('2. Put the map back');
  const S0 = await readKnobs();
  await press('#mv-chip-site', 900);
  const mid = await readKnobs();
  check('Site visit changed the map', mid.settings.draw === 'tails' && mid.basesOn.join() === 'Satellite', J({ draw: mid.settings.draw, bases: mid.basesOn }));
  const hasUndo = await page.evaluate(() => !!document.getElementById('mv-undo'));
  check('…and offers Put the map back', hasUndo);
  await press('#mv-undo', 900);
  const S1 = await readKnobs();
  const undoDiff = Object.keys(S0).filter(k => J(S0[k]) !== J(S1[k]));
  check('Put the map back: every switch, the base-map mix and its order, and the drawing as they were',
    undoDiff.length === 0, undoDiff.map(k => `${k}: ${J(S0[k])} → ${J(S1[k])}`).join(' ; '));
  const afterUndo = await page.evaluate(() => ({
    undo: !!document.getElementById('mv-undo'),
    pressed: [...document.querySelectorAll('#map-views-block .mv-chip[aria-pressed="true"]')].map(b => b.id),
    pick: localStorage.getItem('mn-map-view-pick'),
  }));
  check('…and then nothing more to put back, and no chip pressed', !afterUndo.undo && afterUndo.pressed.length === 0, J(afterUndo));

  // ── 3. Every built-in view ────────────────────────────────────────────────
  section('3. Every built-in view, pressed');
  await countBuilds();
  const VIEWS = await page.evaluate(() => MapViews.VIEWS.map(v => ({ id: v.id, label: v.label, knobs: v.knobs })));
  check('the built-in views are the ten the spec names',
    J(VIEWS.map(v => v.id)) === J(Object.keys(SPEC)), J(VIEWS.map(v => v.id)));
  for (const v of VIEWS) {
    const nErr = errors.length;
    await press(`#mv-chip-${v.id}`, 900);
    const got = await readKnobs();
    const st = await page.evaluate(() => ({
      active: MapViews.active(),
      pressed: [...document.querySelectorAll('#map-views-block .mv-chip[aria-pressed="true"]')].map(b => b.dataset.view),
      now: (document.getElementById('mv-now') || {}).textContent || '',
      builds: window.__mvBuilds.during,
      hold: state.mapRefreshHold, owed: state.mapRefreshOwed,
      baseRow: (() => {
        const on = Object.entries(state.map.mnBases.mix()).filter(([, x]) => x.on).map(([n]) => n);
        return on.map(n => { const b = document.querySelector(`[data-base-row="${n}"] input[type="checkbox"]`); return b ? b.checked : null; });
      })(),
    }));
    const spec = knobDiffs(got, SPEC[v.id] || {});
    const own = knobDiffs(got, v.knobs);
    check(`${v.label}: every switch the spec says it sets`, spec.length === 0, spec.join(' ; '));
    check(`${v.label}: every knob the view lists`, own.length === 0, own.join(' ; '));
    check(`${v.label}: its chip pressed, the only one, and the line under the chips naming it`,
      st.active === v.id && st.pressed.length === 1 && st.pressed[0] === v.id && st.now.includes(v.label), J(st));
    check(`${v.label}: the map rebuilt at most once while its switches were set, and the hold let go`,
      typeof st.builds === 'number' && st.builds <= 1 && !st.hold && !st.owed, J({ builds: st.builds, hold: st.hold, owed: st.owed }));
    check(`${v.label}: the base-map rows in the panel say what the map shows`, st.baseRow.every(x => x !== false), J(st.baseRow));
    check(`${v.label}: no page errors`, errors.length === nErr, errors.slice(nErr).join(' | '));
    if (v.id === 'traffic') {
      await settle(400);
      check('Live traffic: ⏱️ Latency\'s animation on, for the pulses', await page.evaluate(() => MapLatency.anim() === true));
    }
    if (v.id === 'rivers') {
      check('…and the next view, drawn as lines, switched it back off', await page.evaluate(() => MapLatency.anim() === false));
    }
  }

  // ── 4. Keep this mix ──────────────────────────────────────────────────────
  section('4. Keep this mix');
  await press('#mv-chip-weak', 900);
  await page.evaluate(() => MapViews.set({ balance: 70 }));
  await settle(300);
  const own = await page.evaluate(() => ({ active: MapViews.active(), now: document.getElementById('mv-now').textContent }));
  check('Weak links with Balance moved off it by more than a nudge is your own mix', own.active === null && /Your own mix/.test(own.now), J(own));
  await page.locator('#mv-save-name').scrollIntoViewIfNeeded();
  await page.fill('#mv-save-name', 'Check view');
  await press('.mv-save-btn', 500);
  const kept = await page.evaluate(() => ({
    saved: MapViews.saved(), active: MapViews.active(),
    stored: JSON.parse(localStorage.getItem('mn-map-saved-views') || '[]').map(v => v.name),
    chip: (() => { const c = document.querySelector('#map-views-block .mv-chip--saved'); return c && { text: (c.querySelector('b') || c).textContent.trim(), pressed: c.getAttribute('aria-pressed') }; })(),
    box: document.getElementById('mv-save-name').value,
  }));
  const keptId = kept.saved[0] && kept.saved[0].id;
  check('Save keeps the map as it is, under Your views, pressed and in force',
    kept.saved.length === 1 && kept.saved[0].name === 'Check view' && kept.active === keptId
      && kept.chip && kept.chip.text === 'Check view' && kept.chip.pressed === 'true', J(kept));
  check('…written to this device and the name box emptied', J(kept.stored) === J(['Check view']) && kept.box === '', J(kept));

  await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await boot();
  await openLayers();
  const back = await page.evaluate(() => ({
    saved: MapViews.saved().map(v => v.name), active: MapViews.active(),
    pressed: [...document.querySelectorAll('#map-views-block .mv-chip[aria-pressed="true"]')].map(b => (b.querySelector('b') || b).textContent.trim()),
    balance: MapViews.settings().balance, colour: state.mapLinkColour,
  }));
  check('after a reload the kept view is there, still in force and pressed',
    J(back.saved) === J(['Check view']) && back.active === keptId && J(back.pressed) === J(['Check view'])
      && back.balance === 70 && back.colour === 'fade', J(back));
  await press('#mv-chip-overview', 900);
  await press(`#mv-chip-${keptId}`, 900);
  const again = await page.evaluate(() => ({ active: MapViews.active(), balance: MapViews.settings().balance,
    paths: MapViews.settings().paths, colour: state.mapLinkColour }));
  check('pressing it after another view puts its mix back', again.active === keptId && again.balance === 70
    && again.paths === 'every' && again.colour === 'fade', J(again));
  await press('.mv-chip-x', 400);
  const gone = await page.evaluate(() => ({
    saved: MapViews.saved().length, chip: !!document.querySelector('#map-views-block .mv-chip--saved'),
    stored: localStorage.getItem('mn-map-saved-views'), pick: localStorage.getItem('mn-map-view-pick'),
  }));
  check('✕ removes it: from the list, from the panel and from this device',
    gone.saved === 0 && !gone.chip && gone.stored === '[]' && gone.pick === null, J(gone));

  // A clean device again for the drawing: every switch back to its default.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await boot();
  await openLayers();

  // ── 5. Which paths ────────────────────────────────────────────────────────
  section('5. Which paths');
  const every = await lineStats();
  await press('#mv-paths-best', 900);
  const best = await lineStats();
  check('Best path only: at most one field line per field station',
    best.core > 0 && best.maxPer === 1 && best.casing === best.core, J(best));
  check('…fewer lines than every path, the rest counted as thinned',
    best.core < every.core && best.thinned === every.core - best.core && best.stations === every.stations,
    `${every.core} → ${best.core}, thinned ${best.thinned}; stations ${every.stations} → ${best.stations}`);
  const bestNote = await page.evaluate(() => { const n = document.getElementById('mv-paths-note'); return n && !n.hidden ? n.textContent : ''; });
  check('…and the section says how many are drawn', /\d/.test(bestNote), bestNote);

  await view(-27.55, 152.3, 9);
  await press('#mv-paths-lod', 900);
  const lodOut = await lineStats();
  await page.evaluate(() => state.map.setZoom(11, { animate: false }));
  await settle(900);
  const lodIn = await lineStats();
  await page.evaluate(() => state.map.setZoom(10, { animate: false }));
  await settle(900);
  const lodBack = await lineStats();
  check('Best path until you zoom in: below zoom 11, one path per field station',
    lodOut.mode === 'best' && lodOut.maxPer === 1 && lodOut.core === best.core, J(lodOut));
  check('…from zoom 11, every path', lodIn.mode === 'every' && lodIn.core === every.core && lodIn.thinned === 0, J(lodIn));
  check('…and back to one each when zoomed out again', lodBack.mode === 'best' && lodBack.core === best.core, J(lodBack));

  await press('#mv-paths-bundle', 900);
  const bundle = await lineStats();
  const ends = await page.evaluate(() => {
    const byId = new Map(state.data.stations.map(s => [s.id, s]));
    let wrong = 0, curved = 0, short = 0;
    for (const l of state.mapLines) {
      if (l.mnLinkRole !== 'core') continue;
      const p = l.getLatLngs();
      if (p.length <= 2) continue;
      curved++;
      if (p.length < 8) short++;
      const s = byId.get(l.mnLinkStationId), r = byId.get(l.mnLinkRepeaterId);
      const at = (q, x) => Math.abs(q.lat - x.lat) < 1e-9 && Math.abs(q.lng - x.lon) < 1e-9;
      if (!s || !r || !at(p[0], s) || !at(p[p.length - 1], r)) wrong++;
    }
    return { curved, wrong, short, trunks: MapPaths._state().trunks.length };
  });
  check('Bundled into trunks: every path still drawn', bundle.core === every.core && bundle.thinned === 0, J(bundle));
  check('…some of them as curves of more than two points', bundle.curved > 0 && ends.short === 0, J(ends));
  check('…each curve still running from its station to its repeater (the arrows read that way)', ends.wrong === 0, J(ends));
  check('…and the trunks they gather into worked out', ends.trunks > 0, J(ends));

  await view(-27.5, 152.5, 8);
  await press('#mv-paths-areas', 900);
  const areas = await lineStats();
  const areaInk = await ink('mn-areas-canvas');
  const areaSt = await page.evaluate(() => MapPaths._state().areas.length);
  check('Areas, no lines: no field core or casing line left', areas.core === 0 && areas.casing === 0, J(areas));
  check('…the backbone still drawn', areas.backbone > 0, J(areas));
  check('…and the areas painted on the mnAreas canvas', !areaInk.none && areaInk.n > 1000 && areaSt > 0, J({ ...areaInk, areas: areaSt }));
  await press('#mv-paths-every', 900);
  const everyAgain = await lineStats();
  check('Every path again: as many lines as at first', everyAgain.core === every.core && everyAgain.thinned === 0, J(everyAgain));

  // ── 6. Tails & spotlight ──────────────────────────────────────────────────
  section('6. Tails & spotlight');
  await view(-27.55, 152.3, 10);
  await press('#mv-draw-tails', 900);
  const field = () => page.evaluate(() => {
    const f = state.mapLines.filter(l => l.mnLinkRole === 'core' || l.mnLinkRole === 'casing');
    return { n: f.length, zero: f.filter(l => l.options.opacity === 0).length,
             dead: f.filter(l => l.options.interactive === false).length,
             full: f.filter(l => !(l.mnFullOpacity > 0)).length };
  });
  const dark = await field();
  check('Tails: every field line drawn at 0 and not interactive while the pointer is off the map',
    dark.n > 0 && dark.zero === dark.n && dark.dead === dark.n, J(dark));
  check('…each still carrying its full strength for whatever mirrors it', dark.full === 0, J(dark));
  const tailInk = await ink('mn-tails-canvas');
  check('…and the tails drawn on the mnTails canvas', !tailInk.none && tailInk.n > 100, J(tailInk));

  // A field pin near the middle of the map with lines of its own, and one far
  // from it, outside the spotlight.
  const target = await page.evaluate(() => {
    const map = state.map, sz = map.getSize(), r = map.getContainer().getBoundingClientRect();
    const spot = MapViews.settings().tails.spot;
    const ids = new Set(state.mapLines.filter(l => l.mnLinkRole === 'core').map(l => l.mnLinkStationId));
    let near = null, far = null;
    for (const m of state.mapMarkers) {
      if (!ids.has(m.mnStationId) || !m._map) continue;
      const p = map.latLngToContainerPoint(m.getLatLng());
      const d = Math.hypot(p.x - sz.x / 2, p.y - sz.y / 2);
      if (p.x < 60 || p.y < 60 || p.x > sz.x - 60 || p.y > sz.y - 60) continue;
      const under = document.elementFromPoint(r.left + p.x, r.top + p.y);
      if (!under || !under.closest('#leaflet-map')) continue;
      if (!near || d < near.d) near = { id: m.mnStationId, x: r.left + p.x, y: r.top + p.y, px: p, d };
    }
    if (near) {
      for (const m of state.mapMarkers) {
        if (!ids.has(m.mnStationId)) continue;
        const p = map.latLngToContainerPoint(m.getLatLng());
        const d = Math.hypot(p.x - near.px.x, p.y - near.px.y);
        if (d > spot * 2.5 && (!far || d > far.d)) far = { id: m.mnStationId, d };
      }
    }
    return { near, far, spot };
  });
  check('a field pin with lines of its own is on screen to point at', !!target.near && !!target.far, J(target));
  if (target.near && target.far) {
    await page.mouse.move(target.near.x - 40, target.near.y - 40);
    await page.mouse.move(target.near.x, target.near.y, { steps: 6 });
    await settle(500);
    const lit = await page.evaluate(({ near, far }) => {
      const of = id => state.mapLines.filter(l => (l.mnLinkRole === 'core' || l.mnLinkRole === 'casing') && l.mnLinkStationId === id);
      const mine = of(near.id), other = of(far.id);
      return {
        mine: mine.length, mineLit: mine.filter(l => l.options.opacity > 0.05 && l.options.interactive !== false).length,
        other: other.length, otherDark: other.filter(l => l.options.opacity === 0 && l.options.interactive === false).length,
        lit: MapTails._state().lit.stations.includes(near.id),
      };
    }, target);
    check('a real pointer over a field pin lights its lines, at strength and interactive',
      lit.mine > 0 && lit.mineLit === lit.mine && lit.lit, J(lit));
    check('…while a station well outside the spotlight keeps its lines dark and not interactive',
      lit.other > 0 && lit.otherDark === lit.other, J(lit));
    const box = await page.evaluate(() => { const r = state.map.getContainer().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
    await page.mouse.move(box.x + box.w / 2, Math.max(2, box.y - 30), { steps: 4 });
    await settle(500);
    const out = await page.evaluate(id => state.mapLines.filter(l => l.mnLinkRole === 'core' && l.mnLinkStationId === id)
      .every(l => l.options.opacity === 0 && l.options.interactive === false), target.near.id);
    check('…and the pointer leaving the map puts them out again', out);
  }

  // ── 7. Flow ───────────────────────────────────────────────────────────────
  section('7. Flow');
  await press('#mv-draw-flow', 700);
  if (await page.evaluate(() => MapViews.settings().flow.mode !== 'all')) await press('#mv-flowmode-all', 700);
  const flowA = await ink('mn-flow-canvas');
  await settle(350);
  const flowB = await ink('mn-flow-canvas');
  const flowSt = await page.evaluate(() => {
    const cores = state.mapLines.filter(l => l.mnLinkRole === 'core');
    const under = MapViews.settings().flow.under;
    return { playing: MapFlow.playing(), active: MapFlow.active(), under,
             off: cores.filter(l => !l.mnFocusDimmed && Math.abs(l.options.opacity - l.mnFullOpacity * under) > 0.005).length,
             n: cores.length };
  });
  check('Flow: the dashes drawn on the mnFlow canvas', !flowA.none && flowA.n > 100 && flowSt.active, J({ flowA, flowSt }));
  check('…moving: the canvas differs between two frames', flowSt.playing && flowA.h !== flowB.h, J({ a: flowA.h, b: flowB.h }));
  check('…over the lines faded to the Lines underneath share of their strength', flowSt.n > 0 && flowSt.off === 0, J(flowSt));

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(500);
  const stillA = await ink('mn-flow-canvas');
  await settle(450);
  const stillB = await ink('mn-flow-canvas');
  const still = await page.evaluate(() => ({ playing: MapFlow.playing(), pace: MapFlow._state().pace,
    btn: (document.getElementById('mv-play') || {}).textContent }));
  check('a device asking for less motion: the dashes stand still, drawn in place',
    !still.playing && stillA.n > 100 && stillA.h === stillB.h && /Play/.test(still.btn || ''), J({ ...still, a: stillA, b: stillB }));
  await press('#mv-play', 300);
  const playA = await ink('mn-flow-canvas');
  await settle(350);
  const playB = await ink('mn-flow-canvas');
  check('…until Play, which sets them moving', await page.evaluate(() => MapFlow.playing()) && playA.h !== playB.h,
    J({ a: playA.h, b: playB.h }));
  await page.evaluate(() => MapViews.set({ flow: { playing: null } }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle(300);

  // Live readings: ⏱️ Latency's animation, switched by Flow only when it was off.
  const anim0 = await page.evaluate(() => MapLatency.anim());
  await press('#mv-flowmode-live', 700);
  const animLive = await page.evaluate(() => MapLatency.anim());
  await press('#mv-flowmode-all', 700);
  const animAll = await page.evaluate(() => MapLatency.anim());
  check('Live readings switches ⏱️ Latency\'s animation on, and Everything flows back off',
    anim0 === false && animLive === true && animAll === false, J({ anim0, animLive, animAll }));
  await press('#mv-flowmode-live', 700);
  await press('#mv-draw-lines', 700);
  check('…as does leaving Flow for Lines', await page.evaluate(() => MapLatency.anim() === false));
  await page.evaluate(() => MapLatency.setAnim(true, { quiet: true }));
  await press('#mv-draw-flow', 500);
  await press('#mv-flowmode-live', 700);
  await press('#mv-flowmode-all', 700);
  check('…but an animation the person had on is left on', await page.evaluate(() => MapLatency.anim() === true));
  await page.evaluate(() => MapLatency.setAnim(false, { quiet: true }));
  await press('#mv-draw-lines', 700);
  // …and one the person sets by hand while in Live readings is theirs too.
  await press('#mv-draw-flow', 500);
  await press('#mv-flowmode-live', 700);
  await page.evaluate(() => { MapLatency.setAnim(false); MapLatency.setAnim(true); });
  await press('#mv-flowmode-all', 700);
  check('…and one switched on by hand while in Live readings stays on after it',
    await page.evaluate(() => MapLatency.anim() === true && MapFlow._state().ownStored === false));
  await page.evaluate(() => MapLatency.setAnim(false, { quiet: true }));

  // Over empty ground (open sea east of the coast) Flow has nothing to draw,
  // so it stops asking for frames; back over the network it starts again.
  const flowFirst = await page.evaluate(() => MapFlow._state().pace);
  await view(-21, 160, 9, 1200);
  const sea = await page.evaluate(() => ({ pace: MapFlow._state().pace, dashes: MapFlow._state().last.dashes }));
  await view(-27.5, 152.9, 10, 1200);
  const land = await page.evaluate(() => ({ pace: MapFlow._state().pace, dashes: MapFlow._state().last.dashes }));
  check('Flow stops its frames where there is nothing to draw, and starts them again where there is',
    flowFirst === 'run' && sea.dashes === 0 && sea.pace !== 'run' && land.dashes > 0 && land.pace === 'run', J({ flowFirst, sea, land }));

  // Presenting (#279): the switch at the top of Views holds the dashes still,
  // marks the page, puts a chip on the map and is remembered; the chip's own
  // button turns it off and the dashes move again.
  await press('#mv-present', 700);
  const pres = await page.evaluate(() => ({ on: state.presenting, stored: localStorage.getItem('mn-presenting'),
    attr: document.documentElement.hasAttribute('data-presenting'), chip: !!document.querySelector('#leaflet-map .mv-present-chip'),
    playing: MapFlow._state().playing, pace: MapFlow._state().pace, held: !!document.querySelector('#mv-play.mv-play-held') || !document.getElementById('mv-play') }));
  check('Presenting on: the dashes held still, the page marked, a chip on the map, remembered on the device',
    pres.on && pres.stored === 'on' && pres.attr && pres.chip && !pres.playing && pres.pace !== 'run', J(pres));
  await page.click('#leaflet-map .mv-present-off');
  await settle(700);
  const presOff = await page.evaluate(() => ({ on: state.presenting, stored: localStorage.getItem('mn-presenting'),
    chip: !!document.querySelector('#leaflet-map .mv-present-chip'), playing: MapFlow._state().playing, pace: MapFlow._state().pace }));
  check('…and the chip\'s Turn off puts it all back: the dashes moving, no chip',
    !presOff.on && presOff.stored === 'off' && !presOff.chip && presOff.playing && presOff.pace === 'run', J(presOff));
  await press('#mv-draw-lines', 700);

  // ── 8. Auto-contrast and Balance ──────────────────────────────────────────
  section('8. Line strength: auto-contrast and Balance');
  const lsBefore = await page.evaluate(() => ({ ls: localStorage.getItem('mn-map-link-opacity'), v: state.mapLinkOpacity }));
  await view(-25, 148, 6);
  await press('#mv-auto', 900);
  const strength = () => page.evaluate(() => {
    const cores = state.mapLines.filter(l => l.mnLinkRole === 'core' && !l.mnFocusDimmed);
    const a = MapViews.autoValue();
    return { z: state.map.getZoom(), auto: a, op: cores.length ? cores[0].options.opacity : null,
             off: cores.filter(l => Math.abs(l.options.opacity - a) > 0.005).length, n: cores.length };
  });
  const z6 = await strength();
  await page.evaluate(() => state.map.setZoom(10, { animate: false }));
  await settle(900);
  const z10 = await strength();
  check('Auto-contrast: the lines drawn at its figure, between 12 % and 90 %',
    z6.n > 0 && z6.off === 0 && z10.off === 0 && [z6.auto, z10.auto].every(a => a >= 0.12 && a <= 0.9), J({ z6, z10 }));
  check('…a different figure, and so a different line opacity, zoomed out and zoomed in',
    Math.abs(z6.op - z10.op) > 0.05 && z6.op < z10.op, J({ z6: z6.op, z10: z10.op }));
  const row = await page.evaluate(() => {
    const inp = document.querySelector('#map-display-block input[aria-label="Link opacity"]');
    const note = document.getElementById('mv-op-note');
    return { disabled: inp && inp.disabled, note: note && note.textContent };
  });
  check('…the Link opacity slider off while it does, with a note saying so',
    row.disabled === true && /Auto-contrast is setting this/.test(row.note || ''), J(row));
  await press('#mv-auto', 700);
  const manual = await page.evaluate(() => {
    const inp = document.querySelector('#map-display-block input[aria-label="Link opacity"]');
    const cores = state.mapLines.filter(l => l.mnLinkRole === 'core' && !l.mnFocusDimmed);
    return { disabled: inp && inp.disabled, note: !!document.getElementById('mv-op-note'),
             off: cores.filter(l => Math.abs(l.options.opacity - state.mapLinkOpacity) > 0.005).length,
             ls: localStorage.getItem('mn-map-link-opacity'), v: state.mapLinkOpacity };
  });
  check('…and turned off, the slider is back and the lines are at the person\'s own Link opacity',
    manual.disabled === false && !manual.note && manual.off === 0, J(manual));
  check('…which auto-contrast never wrote', manual.ls === lsBefore.ls && manual.v === lsBefore.v,
    J({ before: lsBefore, after: { ls: manual.ls, v: manual.v } }));

  const basesBefore = await page.evaluate(() => localStorage.getItem('mn-base-maps'));
  await unfold('#mv-balance');
  await page.locator('#mv-balance').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const r = document.getElementById('mv-balance');
    r.value = 85;
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(500);
  const bal = await page.evaluate(() => {
    const cores = state.mapLines.filter(l => l.mnLinkRole === 'core' && !l.mnFocusDimmed);
    const want = Math.min(1, state.mapLinkOpacity * (0.45 + 1.1 * 85 / 100));
    return { filter: state.map.getPane('tilePane').style.filter, balance: MapViews.settings().balance,
             off: cores.filter(l => Math.abs(l.options.opacity - want) > 0.005).length,
             bases: localStorage.getItem('mn-base-maps'),
             stored: JSON.parse(localStorage.getItem('mn-map-drawing') || '{}').balance };
  });
  check('Balance 85: the tile pane greyed and darkened by the spec\'s formula',
    bal.balance === 85 && bal.filter === 'grayscale(0.595) brightness(0.685)', J(bal));
  check('…the lines stronger by the same Balance', bal.off === 0, J(bal));
  check('…kept with the drawing settings, and not written into the base maps every map shares',
    bal.stored === 85 && bal.bases === basesBefore, J({ stored: bal.stored, bases: bal.bases === basesBefore }));
  await page.evaluate(() => MapViews.set({ balance: 50 }));
  await settle(300);
  const even = await page.evaluate(() => state.map.getPane('tilePane').style.filter);
  check('Balance 50 takes the filter off', even === '', J(even));

  // ── 9. 3-D ────────────────────────────────────────────────────────────────
  section('9. Tails in the 3-D view');
  const gl2 = await page.evaluate(() => {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch (_) { return false; }
  });
  if (!gl2) {
    console.log('  SKIP — this browser has no WebGL2, so the 3-D view cannot be opened here.');
  } else {
    await view(-27.55, 152.3, 10);
    await press('#mv-draw-tails', 900);
    demOn = true;
    await page.evaluate(() => { Map3D.setWater(false); return Map3D.toggle(); });
    await page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded() && !!Map3D._map().getTerrain(),
      null, { timeout: GL_TIMEOUT });
    await settle(800);
    const three = await page.evaluate(async () => {
      const src = Map3D._map().getSource('mn-links');
      const data = src && (typeof src.getData === 'function' ? await src.getData() : src.serialize().data);
      const feats = (data && data.features) || [];
      const fieldF = feats.filter(f => f.properties.sid != null && f.properties.rid2 == null && !f.properties.dash);
      const cores = state.mapLines.filter(l => l.mnLinkRole === 'core' && !l.mnFocusDimmed);
      return {
        flat: MapViews._state().flat,
        mirrored: fieldF.length, cores: cores.length,
        faint: fieldF.filter(f => !(f.properties.op >= 0.8)).length,
        minOp: fieldF.reduce((a, f) => Math.min(a, f.properties.op), 1),
        twoD: cores.filter(l => Math.abs(l.options.opacity - l.mnFullOpacity) > 0.005).length,
        mirror: Map3D._mirror().links.features.filter(f => f.properties.sid != null && f.properties.rid2 == null && !f.properties.dash && !(f.properties.op > 0)).length,
      };
    });
    check('3-D open: every field line in the 3-D view\'s own source, drawn at its full strength rather than a tail\'s 0',
      three.mirrored === three.cores && three.cores > 0 && three.faint === 0 && three.mirror === 0, J(three));
    check('…and the 2-D lines under it at full strength too (no tails while 3-D is up)', !three.flat && three.twoD === 0, J(three));
    await page.evaluate(() => Map3D.toggle());
    await page.waitForFunction(() => !state.map3d, null, { timeout: GL_TIMEOUT });
    await settle(800);
    await openLayers();
    const flatAgain = await field();
    check('3-D closed: the field lines back to their tails, at 0 and not interactive',
      flatAgain.zero === flatAgain.n && flatAgain.dead === flatAgain.n && await page.evaluate(() => MapViews._state().flat),
      J(flatAgain));
    await press('#mv-draw-lines', 700);

    // Areas in 3-D (Run 2's N3, option B): the repeaters' areas draped on the
    // ground as an image under the polar plot and the cadastre, and the field
    // stations' left-out paths still there for the digital twin's rays.
    await press('#mv-paths-areas', 1200);
    const twinPaths = await page.evaluate(() => {
      const st = state.data.stations.find(s => (s.roles || []).includes('field') && MapPaths.droppedFor(s.id).length > 0);
      return st ? MapPaths.droppedFor(st.id).length : 0;
    });
    await page.evaluate(() => Map3D.toggle());
    await page.waitForFunction(() => !!Map3D._map() && Map3D._map().isStyleLoaded() && !!Map3D._map().getTerrain(),
      null, { timeout: GL_TIMEOUT });
    await settle(1200);
    const areas3d = await page.evaluate(() => {
      const m = Map3D._map();
      const src = m.getSource('mn-areas');
      const layers = m.getStyle().layers.map(l => l.id);
      return { layer: !!m.getLayer('mn-areas'), type: src && src.type, under: layers.indexOf('mn-areas') < layers.indexOf('mn-links'),
               fieldMirrored: Map3D._mirror().links.features.filter(f => f.properties.sid != null && f.properties.rid2 == null).length };
    });
    check('Areas in 3-D: the repeaters\' areas draped on the ground, under the paths, with no field paths drawn',
      areas3d.layer && areas3d.type === 'image' && areas3d.under && areas3d.fieldMirrored === 0, J(areas3d));
    check('…and a field station\'s left-out paths handed to the digital twin for its rays', twinPaths > 0, J({ twinPaths }));
    await page.evaluate(() => Map3D.toggle());
    await page.waitForFunction(() => !state.map3d, null, { timeout: GL_TIMEOUT });
    await settle(600);
    await openLayers();
    await press('#mv-paths-every', 1200);
    demOn = false;
  }

  // ── 10. Easements and land tenure ─────────────────────────────────────────
  section('10. Easements and land tenure');
  await openLayers();
  const off = await page.evaluate(() => ({
    e: state.mapEasements, t: state.mapTenure, lots: state.mapLots,
    le: localStorage.getItem('mn-easements'), lt: localStorage.getItem('mn-land-tenure'),
    rows: [...document.querySelectorAll('#map-display-block input[type="checkbox"]')]
      .filter(b => /MapLots\.set(Easements|Tenure)/.test(b.getAttribute('onchange') || '')).map(b => b.checked),
  }));
  check('easements and land tenure are off by default, with their two rows unticked in Layers',
    off.e === false && off.t === false && off.lots === true && J(off.rows) === J([false, false]), J(off));

  const layersOf = url => new URL(url).searchParams.get('dynamicLayers');
  const paramsOf = url => [...new URL(url).searchParams.keys()].sort().join(',');
  // The URL of the cadastre image on the map, once it is one `ok` accepts.
  // Read off the overlay rather than off the route: the same URL asked for a
  // second time is the browser's image cache's to answer, and never reaches
  // the network.
  const exportOnMap = async ok => {
    const until = Date.now() + 15_000;
    let url = null;
    while (Date.now() < until) {
      url = await page.evaluate(() => {
        const o = Object.values(state.map._layers).find(l => l instanceof L.ImageOverlay && l.options.pane === 'mnLots');
        return o ? o._url : null;
      });
      if (url && ok(layersOf(url))) break;
      url = null;
      await settle(100);
    }
    await settle(300);
    return url;
  };

  let n0 = cadAsked.length;
  await view(-27.5598, 151.9507, 15, 300);
  const urlOff = await exportOnMap(() => true);
  const lotsSt = await page.evaluate(() => MapLots._state());
  const id = lotsSt.layerId;
  check('zoomed in, the property boundaries are exported', !!urlOff && cadAsked.length > n0 && lotsSt.want && lotsSt.want.lots, J(lotsSt));
  check('…with easements and tenure off, the export\'s layers exactly as they were before Views',
    !!urlOff && layersOf(urlOff) === lotsOnlyLayers(id), urlOff && layersOf(urlOff).slice(0, 200));
  check('…and no parameter added', !!urlOff && paramsOf(urlOff) === 'bbox,bboxSR,dpi,dynamicLayers,f,format,imageSR,size,transparent',
    urlOff && paramsOf(urlOff));
  const tiles = await page.evaluate(async () => (await MapLots.tiles()).url);
  check('…and the 3-D view\'s cadastre tiles asked for as they were too',
    new URL(tiles.replace('{bbox-epsg-3857}', '0')).searchParams.get('dynamicLayers')
      === lotsOnlyLayers(id, 2500, "cover_typ = 'Base' AND lot_area >= 400"));

  n0 = cadAsked.length;
  await press('#map-display-block input[onchange^="MapLots.setEasements"]', 200);
  const urlE = await exportOnMap(l => /Easement/.test(l));
  const eLayers = urlE ? JSON.parse(layersOf(urlE)) : [];
  const eSt = await page.evaluate(() => ({ s: MapLots._state(), ls: localStorage.getItem('mn-easements'), on: state.mapEasements }));
  check('Easements, dashed: switched on, remembered, and the export asked again',
    eSt.on === true && eSt.ls === 'on' && !!urlE && urlE !== urlOff && cadAsked.length > n0, J({ ls: eSt.ls, on: eSt.on }));
  check('…the lot lines leaving the easements out, and the easements drawn dashed on their own',
    eLayers.filter(e => e.definitionExpression === "cover_typ <> 'Easement'").length === 2
      && eLayers.some(e => e.definitionExpression === "cover_typ = 'Easement'"
        && e.drawingInfo.renderer.symbol.outline.style === 'esriSLSDash'),
    J(eLayers.map(e => ({ id: e.id, where: e.definitionExpression, style: e.drawingInfo.renderer.symbol && e.drawingInfo.renderer.symbol.outline && e.drawingInfo.renderer.symbol.outline.style }))));
  check('…and the image on the map says it holds them', eSt.s.want && eSt.s.want.easements === true, J(eSt.s.want));

  n0 = cadAsked.length;
  await press('#map-display-block input[onchange^="MapLots.setTenure"]', 200);
  const urlT = await exportOnMap(l => /uniqueValue/.test(l));
  const tLayers = urlT ? JSON.parse(layersOf(urlT)) : [];
  const tSt = await page.evaluate(() => ({ s: MapLots._state(), ls: localStorage.getItem('mn-land-tenure'), on: state.mapTenure }));
  const tenureEntry = tLayers.find(e => e.drawingInfo && e.drawingInfo.renderer && e.drawingInfo.renderer.type === 'uniqueValue');
  check('Land tenure: switched on, remembered, and the export asked again',
    tSt.on === true && tSt.ls === 'on' && !!urlT && urlT !== urlE && cadAsked.length > n0, J({ ls: tSt.ls, on: tSt.on }));
  check('…with the tenure sublayer tinted by a renderer of its own classes, last in the list (under the lines)',
    !!tenureEntry && tenureEntry.source.mapLayerId === tSt.s.tenureId && tLayers[tLayers.length - 1] === tenureEntry
      && tenureEntry.drawingInfo.renderer.uniqueValueInfos.length >= 5,
    J(tenureEntry && { src: tenureEntry.source, n: tenureEntry.drawingInfo.renderer.uniqueValueInfos.length }));

  n0 = cadAsked.length;
  await press('#map-display-block input[onchange^="MapLots.setEasements"]', 200);
  await settle(300);
  await press('#map-display-block input[onchange^="MapLots.setTenure"]', 200);
  const urlBack = await exportOnMap(l => l === lotsOnlyLayers(id));
  const backSt = await page.evaluate(() => ({ e: localStorage.getItem('mn-easements'), t: localStorage.getItem('mn-land-tenure'),
    want: MapLots._state().want }));
  check('both off again: the export URL is the first one, byte for byte', urlBack === urlOff,
    `${(urlBack || '').length} vs ${(urlOff || '').length} chars`);
  check('…remembered as off', backSt.e === 'off' && backSt.t === 'off'
    && J(backSt.want) === J({ lots: true, easements: false, tenure: false }), J(backSt));

  await context.close();
} finally {
  await browser.close();
  await server.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join('\n---\n'));
const bad = results.filter(r => !r.pass);
if (bad.length) {
  console.log(`\nFAIL — ${bad.length} of ${results.length} check(s).`);
  process.exit(1);
}
console.log(`\nPASS — ${results.length} checks: Views above Find a control, every built-in view set and pressed and put back,\n`
  + '       a kept view through a reload, which paths, tails, flow, auto-contrast, Balance, 3-D, easements and tenure.');
