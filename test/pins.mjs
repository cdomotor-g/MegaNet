// What a station's pin says beyond its role, and whose stations the map draws
// (map-symbols.js): a triangle for a river height gauge, grey for one read by
// hand, black for a TM station, the Bureau's solid and dashed pink outlines for its
// forecast and information locations — and the Filters' Owner and Gauge blocks that pick out exactly
// those pins, and Map display's owner choice that takes the others away.
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * The pins against the files. Not against a copy of the rules typed here
//     and run on the page's own answers — that would hold the code to itself —
//     but against what stations.json and data/sls-locations.json say, read in
//     Node: every station with a water level on record is a triangle and every
//     one with none is a circle; every station either SLS calls a forecast
//     location is outlined in solid pink, every information location in
//     dashed pink; every gauge the SLS calls Manual is grey; every TM station
//     — a logger on its Telemetry field, or TM on the end of its name — is
//     black, and nothing else is.
//   * The canvas actually draws them. A pin that carries `mnShape: 'triangle'`
//     and is painted as a circle passes every assertion about options, so the
//     canvas is read back: inside a triangle pin's circumcircle but outside the
//     triangle is the ground, where a circle pin of the same size has its ring;
//     and the outline is there in the Bureau's pink, unbroken round a forecast
//     location and broken into dashes round an information location.
//   * The filters say what the pins say. "Read by a person" is exactly the grey
//     pins, "River height" exactly the triangles, "Forecast location" exactly
//     the solid outlines — the claim the Gauge block's hint makes. The Owner
//     block's rows are the owners the files name, with their counts; "only"
//     gives that owner's stations and nobody else's, and its find box hides
//     rows without unticking any.
//   * The owner choice in Map display draws one owner's stations, or everyone's
//     but theirs, says how many it is not drawing, leaves the list alone, and
//     is gone after a reload — it takes stations off the map, and a map that
//     opens missing most of the network reads as data that has gone.
//   * Show these stations draws only the kinds of station ticked — a station
//     the kind its pin's colour says, so a field station that also repeats is
//     a repeater — takes the links to an unticked kind with them, says how
//     many it is not drawing, and is gone after a reload, as the owner is.
//     Arrows along the links shares the links' card, and the pointer to
//     Signal bars beside the pins lands on ⏱️ Latency & signal's switch.
//   * The four switches are remembered, take their rows out of the legend and
//     name themselves on its "Also available" line.
//   * The SLS file is not waited for. The pins are on the map before it lands
//     and painted again when it does; a file that does not load leaves the
//     pins standing and says so.
//
// Run:  npm run pins
//       npm run pins -- -v    also print what passed

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// ── The oracle: the two files, read here ────────────────────────────────────
const stations = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const sls = JSON.parse(fs.readFileSync(repo('data/sls-locations.json'), 'utf8')).locations;
const key = (n) => String(n == null ? '' : n).trim().replace(/^0+/, '') || null;
const byKey = new Map();
for (const l of sls) {
  const k = key(l.bureau_number);
  if (!k) continue;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(l);
}
const entries = (s) => byKey.get(key(s.station_number)) || [];
const located = stations.filter((s) => s.lat != null && s.lon != null);

// A water level on record, said any way the record or the Bureau says it.
const sensorsOf = (s) => (Array.isArray(s.sensors) && s.sensors.length ? s.sensors : []);
const water = (s) => sensorsOf(s).some((x) => /^(Water Level|Gas Pressure)/i.test(x.type || ''))
  || (s.alert_ids || {}).water_level != null
  || /_water_level$/.test(s.station_type || '') || s.inspection_config_key === 'gas_only'
  || (s.location_types || []).some((l) => /^(Water Level|Reservoir|Tide)/i.test(l))
  || (s.bureau_listings || []).some((b) => String(b.section) === '3')
  || entries(s).some((e) => /river/i.test(e.data_type || '')
                         || e.forecast_location || e.information_location || e.river_data_location);
const expect = {
  triangle: new Set(located.filter(water).map((s) => s.id)),
  forecast: new Set(located.filter((s) => entries(s).some((e) => e.forecast_location)).map((s) => s.id)),
  information: new Set(located.filter((s) => !entries(s).some((e) => e.forecast_location)
                                          && entries(s).some((e) => e.information_location)).map((s) => s.id)),
  slsManual: new Set(located.filter((s) => !/^auto_/.test(s.station_type || '')
                                        && entries(s).some((e) => /^manual$/i.test(e.gauge_type || ''))).map((s) => s.id)),
  // The Telemetry field's logger, else TM on the name where the field does not
  // say ALERT; not a repeater or a base, and not a gauge read by hand.
  tm: new Set(located.filter((s) => {
    const cfg = s.inspection_config_key || '';
    const said = cfg === 'campbell_datalogger' || cfg === 'datalogger_old'
      || (cfg !== 'alert' && /\sTM$/i.test(String(s.name || '').trim()));
    const roles = s.roles || [];
    const byHand = /^manual_/.test(s.station_type || '')
      || (!/^auto_/.test(s.station_type || '') && (entries(s)[0] || {}).gauge_type === 'Manual');
    return said && !byHand && !roles.includes('repeater') && !roles.includes('base');
  }).map((s) => s.id)),
};
// Whose: the owner of the SLS entry the card quotes first — the more specific
// statement of service, then Queensland's — else the station's own owner.
const ROLE_ORDER = ['forecast_location', 'information_location', 'river_data_location',
                    'bureau_owned', 'bureau_assists', 'bureau_colocated'];
const rank = (l) => {
  const r = ROLE_ORDER.findIndex((f) => l[f]);
  const d = ['QLD', 'NSW'].indexOf(l.jurisdiction);
  return (r < 0 ? ROLE_ORDER.length : r) * 10 + (d < 0 ? 2 : d);
};
const ownerRaw = (s) => ([...entries(s)].sort((a, b) => rank(a) - rank(b))[0] || {}).owner || (s.owner && String(s.owner).trim()) || '';
const expectSeqwater = stations.filter((s) => ownerRaw(s).split(/\s*[/,]\s*/).map((p) => p.trim()).includes('Seqwater')).length;
const expectNoOwner = stations.filter((s) => !ownerRaw(s).trim()).length;
// The kind of station each pin is, as its colour says: a base over a repeater
// over a field station.
const kindOf = (s) => ((s.roles || []).includes('base') ? 'base' : (s.roles || []).includes('repeater') ? 'repeater' : 'field');
const kindLocated = { field: 0, repeater: 0, base: 0 };
for (const s of located) kindLocated[kindOf(s)]++;
const seqwaterLocated = located.filter((s) => ownerRaw(s).split(/\s*[/,]\s*/).map((p) => p.trim()).includes('Seqwater')).length;

const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const missing = (want, got) => [...want].filter((x) => !got.has(x)).slice(0, 5).join(', ');

async function open(browser, server, { viewport = { width: 1400, height: 950 }, slsGate = null, slsAbort = false } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  // Registered after the policy, so it is asked first (Playwright runs routes
  // newest first): the SLS file held back, or refused, and then handed on.
  if (slsGate || slsAbort) {
    await page.route('**/data/sls-locations.json', async (route) => {
      if (slsAbort) return route.abort();
      await slsGate;
      return route.fallback();
    });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  return { context, page, errors };
}

const pins = (page) => page.evaluate(() => {
  const by = (pred) => state.mapMarkers.filter(pred).map((m) => m.mnStationId);
  return {
    n: state.mapMarkers.length,
    triangle: by((m) => m.options.mnShape === 'triangle'),
    grey: by((m) => m.options.fillColor === MapSymbols.MANUAL),
    black: by((m) => m.options.fillColor === MapSymbols.TM),
    forecast: by((m) => m.options.mnOutline === MapSymbols.FORECAST && !m.options.mnOutlineDash),
    information: by((m) => m.options.mnOutline === MapSymbols.INFORMATION && !!m.options.mnOutlineDash),
  };
});

const server = await startServer();
const browser = await launchBrowser();
const allErrors = [];
try {
  // ── 1. The SLS is not waited for ───────────────────────────────────────────
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { context, page, errors } = await open(browser, server, { slsGate: gate });
    const early = await page.evaluate(() => ({
      loaded: SLS.loaded(),
      n: state.mapMarkers.length,
      tri: state.mapMarkers.filter((m) => m.options.mnShape === 'triangle').length,
      outlined: state.mapMarkers.filter((m) => m.options.mnOutline).length,
      note: (document.getElementById('map-symbols-note') || {}).textContent || '',
    }));
    check('the pins are on the map before the SLS has answered', !early.loaded && early.n > 4000, JSON.stringify(early));
    check('…already in their shapes, from the record alone', early.tri > 2000, String(early.tri));
    check('…with no outline yet, and the note saying it is looking',
      early.outlined === 0 && /Looking up/.test(early.note), early.note);
    release();
    await page.waitForFunction(() => SLS.loaded() && state.mapMarkers.some((m) => m.options.mnOutline), null, { timeout: 30_000 });
    const late = await pins(page);
    check('…and painted again when it lands', late.forecast.length > 200 && late.information.length > 700,
      `${late.forecast.length} forecast, ${late.information.length} information`);
    allErrors.push(...errors);
    await context.close();
  }

  // ── 2. A file that does not load leaves the pins standing, and says so ────
  {
    const { context, page, errors } = await open(browser, server, { slsAbort: true });
    await page.waitForFunction(() => MapSymbols.slsFailed(), null, { timeout: 30_000 });
    const failed = await page.evaluate(() => ({
      n: state.mapMarkers.length,
      tri: state.mapMarkers.filter((m) => m.options.mnShape === 'triangle').length,
      note: (document.getElementById('map-symbols-note') || {}).textContent || '',
      retry: !!document.querySelector('#map-symbols-note button'),
    }));
    check('an SLS that does not load leaves every pin drawn, in its shape',
      failed.n > 4000 && failed.tri > 2000, JSON.stringify({ n: failed.n, tri: failed.tri }));
    check('…and the note says what is missing, with a way to try again',
      /did not load/.test(failed.note) && failed.retry, failed.note);
    allErrors.push(...errors);
    await context.close();
  }

  // ── 3. The pins against the files ──────────────────────────────────────────
  const { context, page, errors } = await open(browser, server);
  await page.waitForFunction(() => SLS.loaded(), null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  const got = await pins(page);
  const tri = new Set(got.triangle), grey = new Set(got.grey), black = new Set(got.black);
  const solid = new Set(got.forecast), dashed = new Set(got.information);
  check('every station with a water level on record is a triangle, and every other a circle',
    same(expect.triangle, tri),
    `file ${expect.triangle.size}, map ${tri.size}; not drawn as one: ${missing(expect.triangle, tri)}; drawn but not: ${missing(tri, expect.triangle)}`);
  check('every forecast location the SLS names is outlined in solid pink, and nothing else is',
    same(expect.forecast, solid), `file ${expect.forecast.size}, map ${solid.size}`);
  check('every information location (not also forecast) is outlined in dashed pink, and nothing else is',
    same(expect.information, dashed), `file ${expect.information.size}, map ${dashed.size}`);
  check('every gauge the SLS calls Manual is grey',
    [...expect.slsManual].every((id) => grey.has(id)), `${expect.slsManual.size} manual; not grey: ${missing(expect.slsManual, grey)}`);
  check('…and no grey pin is a repeater or a base, which a radio reads by definition',
    await page.evaluate(() => state.mapMarkers.filter((m) => m.options.fillColor === MapSymbols.MANUAL)
      .every((m) => !m.mnStation.roles.includes('repeater') && !m.mnStation.roles.includes('base'))));
  check('every TM station is black, and nothing else is',
    expect.tm.size > 900 && same(expect.tm, black),
    `file ${expect.tm.size}, map ${black.size}; not black: ${missing(expect.tm, black)}; black but not: ${missing(black, expect.tm)}`);
  check('…and no black pin is grey, and no ALERT-named station is black',
    [...black].every((id) => !grey.has(id))
      && await page.evaluate(() => state.mapMarkers.filter((m) => m.options.fillColor === MapSymbols.TM)
        .every((m) => !/\s(AL|ALERT)$/i.test(String(m.mnStation.name || '').trim()))));
  const greenmount = await page.evaluate(() => {
    const m = state.mapMarkers.find((x) => x.mnStation.name === 'Greenmount');
    return m && { shape: m.options.mnShape, fill: m.options.fillColor, outline: m.options.mnOutline };
  });
  check('Greenmount, the Bureau\'s rain gauge read by hand, is a grey circle',
    !!greenmount && greenmount.shape === 'circle' && greenmount.fill === '#7b8189' && !greenmount.outline,
    JSON.stringify(greenmount));

  // ── 4. The canvas draws them ───────────────────────────────────────────────
  // Read back off the renderer's own canvas, at a zoom where the pin is alone:
  // its middle is its fill; a point inside its circumcircle but outside the
  // triangle is whatever the ground is three radii away; the outline's bottom
  // edge is the Bureau's pink — all of it round a forecast location, and in
  // dashes with the ground between round an information location. Links off,
  // so nothing crosses the samples.
  await page.evaluate(() => { state.mapShowLinks = false; state.mapShowBackbone = false; refreshMapLayers({ skipFit: true }); });
  const drawn = await page.evaluate(async () => {
    const lone = (pred) => {
      const ms = state.mapMarkers.filter(pred);
      return ms.find((m) => state.mapMarkers.every((o) => o === m
        || Math.abs(o.mnStation.lat - m.mnStation.lat) > 0.03 || Math.abs(o.mnStation.lon - m.mnStation.lon) > 0.03));
    };
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))));
    const read = async (m) => {
      state.map.setView(m.getLatLng(), 13, { animate: false });
      await frames();
      const ctx = m._renderer._ctx, b = m._renderer._bounds.min, k = L.Browser.retina ? 2 : 1;
      const px = (dx, dy) => {
        const d = ctx.getImageData(Math.round((m._point.x - b.x + dx) * k), Math.round((m._point.y - b.y + dy) * k), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      return { px, r: m._radius, w: m.options.weight, fill: m.options.fillColor, name: m.mnStation.name };
    };
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
    const out = {};
    const t = lone((m) => m.options.mnShape === 'triangle' && !m.options.mnOutline && m.options.fillColor === ROLE_COLOR.field);
    if (t) {
      const g = await read(t);
      const ground = g.px(-3 * g.r, 0);
      out.triangle = {
        name: g.name,
        middle: near(g.px(0, 0), hex(g.fill), 30),
        corner: near(g.px(-0.75 * g.r, -0.5 * g.r), ground, 30) && g.px(-0.75 * g.r, -0.5 * g.r)[3] === ground[3],
      };
    }
    const c = lone((m) => m.options.mnShape === 'circle' && !m.options.mnOutline && !m.mnStation.roles.includes('repeater'));
    if (c) {
      const g = await read(c);
      const ground = g.px(-3 * g.r, 0);
      out.circle = { name: g.name, corner: !(near(g.px(-0.75 * g.r, -0.5 * g.r), ground, 30) && g.px(-0.75 * g.r, -0.5 * g.r)[3] === ground[3]) };
    }
    // Along the outline's bottom edge, a pixel at a time: pink or not, each
    // the best of the pixel and the two above and below it, so a half-pixel
    // of rounding across the line is not a gap — but never one beside it,
    // which would bridge a dash's gap. Opaque pink only: the canvas is
    // transparent off the pins, and a faint edge reads pink at any alpha.
    const edge = async (m) => {
      const g = await read(m);
      const ro = g.r + 2 * (g.w / 2 + 2.5 / 2), half = 0.8 * ro * Math.sqrt(3) / 2;
      const pink = hex(MapSymbols.FORECAST), runs = [];
      for (let x = -half; x <= half; x++) {
        let best = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          const p = g.px(x, ro / 2 + dy);
          if (p[3] >= 128) best = Math.min(best, Math.hypot(p[0] - pink[0], p[1] - pink[1], p[2] - pink[2]));
        }
        runs.push(best <= 60);
      }
      return { name: g.name, pink: runs.filter(Boolean).length, gaps: runs.filter((v) => !v).length };
    };
    const f = lone((m) => m.options.mnOutline === MapSymbols.FORECAST && !m.options.mnOutlineDash && m.options.mnShape === 'triangle');
    if (f) out.forecast = await edge(f);
    const i = lone((m) => m.options.mnOutline === MapSymbols.INFORMATION && !!m.options.mnOutlineDash && m.options.mnShape === 'triangle');
    if (i) out.information = await edge(i);
    return out;
  });
  check('a triangle pin is filled in its middle', !!drawn.triangle && drawn.triangle.middle, JSON.stringify(drawn.triangle));
  check('…and its circumcircle\'s corner is bare ground, where a circle would be ring',
    !!drawn.triangle && drawn.triangle.corner, JSON.stringify(drawn.triangle));
  check('…which the same point on a circle pin is not', !!drawn.circle && drawn.circle.corner, JSON.stringify(drawn.circle));
  check('a forecast location\'s outline is drawn in the Bureau\'s pink, unbroken',
    !!drawn.forecast && drawn.forecast.pink > 4 && drawn.forecast.gaps === 0, JSON.stringify(drawn.forecast));
  check('…and an information location\'s in the same pink, in dashes',
    !!drawn.information && drawn.information.pink > 2 && drawn.information.gaps > 0, JSON.stringify(drawn.information));
  await page.evaluate(() => { state.mapShowLinks = true; state.mapShowBackbone = true; refreshMapLayers({ skipFit: true }); });

  // ── 5. The filters say what the pins say ───────────────────────────────────
  await page.evaluate(() => { if (!state.filtersOpen) toggleStationFilters(); });
  await page.waitForSelector('#filter-group-gauge select', { state: 'attached' });
  // Open, and recorded as open, so the redraw every Clear makes keeps it so.
  const gauge = async (nth, value) => {
    await page.evaluate(() => {
      clearStationFilters(false);
      state.filterOpen.gauge = true;
      document.getElementById('filter-group-gauge').open = true;
    });
    await page.selectOption(`#filter-group-gauge select >> nth=${nth}`, value);
    await page.waitForTimeout(250);
    return page.evaluate(() => filteredStations().filter((s) => s.lat != null && s.lon != null).map((s) => s.id));
  };
  check('Gauge: "Read by a person" is exactly the grey pins', same(new Set(await gauge(1, 'manual')), grey));
  check('Gauge: "River height" is exactly the triangles', same(new Set(await gauge(0, 'river')), tri));
  check('Gauge: "Forecast location" is exactly the solid outlines', same(new Set(await gauge(2, 'forecast')), solid));
  check('Gauge: "Information location" is exactly the dashed outlines', same(new Set(await gauge(2, 'information')), dashed));
  const gaugeState = await page.evaluate(() => document.getElementById('filter-state-gauge').textContent.trim());
  check('…and the block says it is set while it is', gaugeState === '1 set', gaugeState);
  await page.evaluate(() => clearStationFilters(false));
  const cleared = await page.evaluate(() => ({
    sel: [...document.querySelectorAll('#filter-group-gauge select')].map((s) => s.value),
    n: filteredStations().length, active: anyStationFilterActive(),
  }));
  check('Clear puts the Gauge block back to Any', cleared.sel.every((v) => v === '') && !cleared.active
    && cleared.n === stations.length, JSON.stringify(cleared));

  // The Owner block.
  const owners = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#filter-list-owners .filter-row')].map((r) => ({
      name: r.querySelector('.filter-row-label span').textContent.trim(),
      count: +r.querySelector('.filter-count').textContent,
    }));
    return { rows, find: !!document.getElementById('filter-find-owners') };
  });
  const row = (n) => owners.rows.find((r) => r.name === n);
  check('the Owner block lists the owners, the most first, the Bureau leading',
    owners.rows.length > 50 && owners.rows[0].name === 'Bureau of Meteorology'
      && owners.rows.slice(0, -1).every((r, i, a) => i === 0 || a[i - 1].count >= r.count),
    owners.rows.slice(0, 3).map((r) => `${r.name} ${r.count}`).join(', '));
  check('…with the files\' count beside each (Seqwater)', row('Seqwater') && row('Seqwater').count === expectSeqwater,
    `${row('Seqwater') && row('Seqwater').count} against ${expectSeqwater}`);
  check('…and the stations nobody is on record as owning, last, in words',
    owners.rows[owners.rows.length - 1].name === 'No owner on record'
      && owners.rows[owners.rows.length - 1].count === expectNoOwner,
    JSON.stringify(owners.rows[owners.rows.length - 1]));
  await page.evaluate(() => { state.filterOpen.owners = true; document.getElementById('filter-group-owners').open = true; });
  await page.fill('#filter-find-owners', 'toowoomba');
  await page.waitForTimeout(150);
  const found = await page.evaluate(() => ({
    shown: [...document.querySelectorAll('#filter-list-owners .filter-row')].filter((r) => r.getClientRects().length)
      .map((r) => r.dataset.find),
    ticked: [...document.querySelectorAll('#filter-list-owners input[type=checkbox]')].every((b) => b.checked),
    active: anyStationFilterActive(),
  }));
  check('its find box leaves only the owners it matches on screen',
    found.shown.length >= 1 && found.shown.every((t) => t.includes('toowoomba')), found.shown.join(' | '));
  check('…and unticks nothing', found.ticked && !found.active);
  await page.fill('#filter-find-owners', '');
  const only = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#filter-list-owners .filter-row')].find((x) => x.dataset.find === 'seqwater');
    r.querySelector('button.filter-only').click();
    const m = filteredStations();
    return { n: m.length, all: m.every((s) => (stationOwner(s) || { parties: [] }).parties.includes('Seqwater')),
             state: document.getElementById('filter-state-owners').textContent.trim() };
  });
  check('"only" beside Seqwater gives Seqwater\'s stations and nobody else\'s',
    only.n === expectSeqwater && only.all, JSON.stringify(only));
  check('…and the block says one owner is ticked', /^1 of \d+$/.test(only.state), only.state);
  await page.evaluate(() => clearStationFilters(false));

  // ── 6. Map display: one owner, or everyone's but theirs ───────────────────
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForSelector('#map-owner', { state: 'attached' });
  const radios = () => page.evaluate(() => [...document.querySelectorAll('#map-owner-block input[type=radio]')].map((r) => r.disabled));
  check('the owner\'s two choices wait for an owner', (await radios()).every(Boolean));
  await page.selectOption('#map-owner', 'Seqwater');
  await page.waitForTimeout(300);
  const onlyMap = await page.evaluate(() => ({
    n: state.mapMarkers.length,
    all: state.mapMarkers.every((m) => (stationOwner(m.mnStation) || { parties: [] }).parties.includes('Seqwater')),
    list: filteredStations().length,
    note: document.getElementById('map-owner-note').textContent,
    match: document.getElementById('map-match-note').textContent,
    name: document.getElementById('leaflet-map').getAttribute('aria-label'),
  }));
  check('Only theirs: the map draws Seqwater\'s stations and no one else\'s',
    onlyMap.n === seqwaterLocated && onlyMap.all, `${onlyMap.n} drawn, ${seqwaterLocated} expected`);
  check('…leaves the list and the filters alone', onlyMap.list === stations.length, String(onlyMap.list));
  check('…and says how many it is not drawing, beside the controls and under the filters',
    /not drawn/.test(onlyMap.note) && /not drawn/.test(onlyMap.match) && /Seqwater/.test(onlyMap.name),
    `${onlyMap.note} | ${onlyMap.match}`);
  check('…with its two choices on offer', (await radios()).every((d) => !d));
  await page.click('#map-owner-block input[value="except"]');
  await page.waitForTimeout(300);
  const exceptMap = await page.evaluate(() => ({
    n: state.mapMarkers.length,
    none: state.mapMarkers.every((m) => !(stationOwner(m.mnStation) || { parties: [] }).parties.includes('Seqwater')),
  }));
  check('Everyone\'s but theirs: every other owner\'s stations, and none of Seqwater\'s',
    exceptMap.none && exceptMap.n === got.n - seqwaterLocated, `${exceptMap.n} of ${got.n}`);
  await page.selectOption('#map-owner', '');
  await page.waitForTimeout(300);
  check('Every owner\'s stations puts the whole network back',
    await page.evaluate((n) => state.mapMarkers.length === n, got.n));

  // ── 6b. Show these stations: field stations, repeaters, base stations ─────
  const boxes = () => page.evaluate(() => [...document.querySelectorAll('#map-roles-block input[data-map-role]')]
    .map((b) => [b.dataset.mapRole, b.checked]));
  check('Show these stations offers field stations, repeaters and base stations, all ticked',
    JSON.stringify(await boxes()) === JSON.stringify([['field', true], ['repeater', true], ['base', true]]),
    JSON.stringify(await boxes()));
  const kindsOnMap = () => page.evaluate(() => {
    const c = { field: 0, repeater: 0, base: 0 };
    for (const m of state.mapMarkers) c[primaryRole(m.mnStation)]++;
    const field = state.mapLines.filter((l) => l.mnLinkRole === 'core');
    const backbone = state.mapLines.filter((l) => l.mnLinkRole === 'backbone');
    const byId = new Map(state.data.stations.map((s) => [s.id, s]));
    const roleOf = (id) => primaryRole(byId.get(id));
    return { c, n: state.mapMarkers.length, field: field.length, backbone: backbone.length,
             toBase: backbone.filter((l) => roleOf(l.mnLinkRepeaterId) === 'base' || roleOf(l.mnLinkRepeaterId2) === 'base').length,
             note: document.getElementById('map-roles-note').textContent,
             match: document.getElementById('map-match-note').textContent,
             name: document.getElementById('leaflet-map').getAttribute('aria-label'),
             legend: mapLegendHtml(), list: filteredStations().length };
  });
  // Links and backbone on, so there is something for the boxes to take away.
  await page.evaluate(() => { state.mapShowLinks = true; state.mapShowBackbone = true; refreshMapLayers({ skipFit: true }); });
  await page.waitForTimeout(200);
  const allKinds = await kindsOnMap();
  check('…and with all three ticked every pin is drawn', allKinds.n === got.n, `${allKinds.n} of ${got.n}`);
  await page.uncheck('#map-roles-block input[data-map-role="field"]');
  await page.waitForTimeout(300);
  const noField = await kindsOnMap();
  check('Field stations unticked: no field station pins, every repeater and base still drawn',
    noField.c.field === 0 && noField.c.repeater === kindLocated.repeater && noField.c.base === kindLocated.base,
    JSON.stringify({ map: noField.c, file: kindLocated }));
  check('…a field station that also repeats stays, as the repeater its pin shows',
    await page.evaluate(() => state.mapMarkers.some((m) => m.mnStation.roles.includes('field') && m.mnStation.roles.includes('repeater'))));
  check('…the field stations\' links go with them, the backbone stays',
    noField.field === 0 && noField.backbone > 0 && allKinds.field > 0, JSON.stringify({ before: allKinds.field, field: noField.field, backbone: noField.backbone }));
  check('…says how many it is not drawing, beside the boxes, under the filters and in the map\'s name',
    /not drawn/.test(noField.note) && /only repeaters and base stations/.test(noField.match)
      && /not drawn/.test(noField.match) && /only repeaters and base stations/.test(noField.name),
    `${noField.note} | ${noField.match}`);
  check('…the legend says field stations are not drawn', /Field Station — not drawn/.test(noField.legend));
  check('…and leaves the list alone', noField.list === stations.length, String(noField.list));
  await page.uncheck('#map-roles-block input[data-map-role="base"]');
  await page.waitForTimeout(300);
  const repOnly = await kindsOnMap();
  check('Repeaters alone: only repeater pins, and no path to a base',
    repOnly.n === kindLocated.repeater && repOnly.c.base === 0 && repOnly.toBase === 0 && allKinds.toBase > 0,
    JSON.stringify({ c: repOnly.c, toBase: repOnly.toBase, before: allKinds.toBase }));
  await page.check('#map-roles-block input[data-map-role="field"]');
  await page.check('#map-roles-block input[data-map-role="base"]');
  await page.waitForTimeout(300);
  const kindsBack = await kindsOnMap();
  check('All three ticked again puts the whole network back, links and all',
    kindsBack.n === got.n && kindsBack.field === allKinds.field && !/not drawn/.test(kindsBack.match),
    JSON.stringify({ n: kindsBack.n, field: kindsBack.field }));
  await page.evaluate(() => { state.mapShowLinks = false; state.mapShowBackbone = false; refreshMapLayers({ skipFit: true }); });

  // Arrows along the links is in the links' card, not a card of its own.
  check('Arrows along the links joins the card above it',
    await page.evaluate(() => {
      const box = document.querySelector('#map-display-block input[onchange^="MapArrows.setEnabled"]');
      const row = box && box.closest('label');
      return !!row && row.classList.contains('mapd-join') && !row.classList.contains('mapd-card-top');
    }));

  // The pointer to Signal bars beside the pins: ⏱️ Latency & signal, opened on
  // its switch — focused, not ticked.
  const barsBefore = await page.evaluate(() => MapLatency.bars());
  await page.click('#map-display-block .mapd-goto button');
  await page.waitForFunction(() => document.activeElement && document.activeElement.matches('#map-latency-panel input[data-lat-f="bars"]'),
    null, { timeout: 5000 }).catch(() => {});
  const landed = await page.evaluate(() => ({
    focused: !!document.activeElement && document.activeElement.matches('#map-latency-panel input[data-lat-f="bars"]'),
    bars: MapLatency.bars(),
  }));
  check('The Signal bars pointer in Layers lands on ⏱️ Latency & signal\'s switch, and ticks nothing',
    landed.focused && landed.bars === barsBefore, JSON.stringify(landed));
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForSelector('#map-owner', { state: 'attached' });

  // ── 7. The switches, the legend and what is remembered ────────────────────
  await page.selectOption('#map-owner', 'Seqwater');
  await page.uncheck('#map-roles-block input[data-map-role="base"]');
  await page.waitForTimeout(200);
  const legendOn = await page.evaluate(() => mapLegendHtml());
  check('the legend keys the triangle, the grey, the black and both outlines while they are on',
    /River height \(water level\) gauge/.test(legendOn) && /Read by hand/.test(legendOn)
      && /TM station/.test(legendOn)
      && /Forecast location/.test(legendOn) && /Information location/.test(legendOn)
      && legendOn.includes('#ff00c5') && !legendOn.includes('#8400a8')
      && /stroke="#ff00c5"[^>]*stroke-dasharray="4 3"/.test(legendOn));
  await page.uncheck('#map-display-block input[onchange^="MapSymbols.setShapes"]');
  await page.uncheck('#map-display-block input[onchange^="MapSymbols.setManual"]');
  await page.uncheck('#map-display-block input[onchange^="MapSymbols.setTm"]');
  await page.uncheck('#map-display-block input[onchange^="MapSymbols.setOutlines"]');
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => ({
    shaped: state.mapMarkers.filter((m) => m.options.mnShape === 'triangle' || m.options.mnOutline
                                        || m.options.fillColor === MapSymbols.MANUAL
                                        || m.options.fillColor === MapSymbols.TM).length,
    legend: mapLegendHtml(),
    stored: ['mn-pin-shapes', 'mn-pin-manual', 'mn-pin-tm', 'mn-pin-sls'].map((k) => localStorage.getItem(k)),
  }));
  check('with the four switches off every pin is a circle in its role\'s colour, unoutlined', off.shaped === 0, String(off.shaped));
  check('…their rows leave the legend and its "Also available" line names them',
    !/Read by hand/.test(off.legend) && !/TM station —/.test(off.legend)
      && /Also available[^<]*Triangles for river height gauges/.test(off.legend)
      && /Grey for manual gauges/.test(off.legend) && /Black for TM stations/.test(off.legend)
      && /Forecast and information outlines/.test(off.legend));
  check('…and they are remembered', off.stored.every((v) => v === 'off'), off.stored.join(','));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  const back = await page.evaluate(() => ({
    switches: [state.mapPinShapes, state.mapPinManual, state.mapPinTm, state.mapPinSls],
    owner: state.mapOwner, kinds: state.mapRolesOff.size, n: state.mapMarkers.length,
    tri: state.mapMarkers.filter((m) => m.options.mnShape === 'triangle').length,
  }));
  check('after a reload the switches are still off', back.switches.every((v) => v === false) && back.tri === 0,
    JSON.stringify(back.switches));
  check('…and the owner choice and Show these stations are gone: every station is drawn',
    back.owner === '' && back.kinds === 0 && back.n === got.n,
    JSON.stringify({ owner: back.owner, kinds: back.kinds, n: back.n }));
  await page.evaluate(() => { MapSymbols.setShapes(true); MapSymbols.setManual(true); MapSymbols.setTm(true); MapSymbols.setOutlines(true); });
  allErrors.push(...errors);
  await context.close();

  check('nothing threw for the whole run', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
if (failed.length) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS — the pins say what the files say, and the filters and the owner choice agree with them.');
