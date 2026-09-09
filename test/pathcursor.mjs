// The elevation profile's cursor, on both pictures at once.
//
// A profile and a map are two views of one line, and until the pointer is on
// both of them they stay two pictures: the chart says there is a ridge nine
// kilometres along, and the map says nothing about where nine kilometres along
// actually is. So the chart carries a dot that runs along the ground line with
// the pointer, tagged with the land height under it, and the same point is
// marked on the map — from either side. Move over the chart and the map dot
// follows; move along the line on the map and the chart's dot follows.
//
// The ground is built here, for pathcover.mjs's reason: the harness blocks the
// tile server, and a check about "the height under the cursor" is worthless
// over ground whose height nobody chose. But flat ground is worse than no
// ground for this one — every sample the same height would let a cursor that
// ignored the pointer entirely pass every assertion. So the tiles are a **ramp
// in longitude**: 0 m at the west end of the hop, 1,000 m at the east end,
// continuous across tile boundaries and independent of the zoom Terrain picks,
// because the value is computed from each pixel's own longitude rather than
// from its position in its tile.
//
// That makes every reading arithmetic. A quarter of the way along the hop the
// ground is 250 m; the cursor has to say so, the dot has to sit a quarter of
// the way across the plot, and the marker on the map has to be a quarter of the
// way along the line. Three of the four assertions in each pass would still
// hold over flat ground; the height is the one that would not.
//
// Run:  npm run pathcursor
//       npm run pathcursor -- -v    also print what passed

import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// The hop: due east, so distance along it and longitude move together and the
// ramp below is a ramp along the path.
const HOP = { lat: -27.50, lonA: 152.40, lonB: 152.50 };
const RISE = 1000;                                   // m, west end to east end
const SPAN = HOP.lonB - HOP.lonA;
const groundAt = (t) => RISE * t;                    // m, t along the path

// How long the hop actually is, so the "how far along" half of the map label
// can be checked against a figure rather than against a guess: 0.1° of
// longitude is not 10 km, and at this latitude it is a little under ten.
const HOP_KM = 2 * 6371 * Math.asin(Math.sqrt(
  Math.cos(HOP.lat * Math.PI / 180) ** 2 * Math.sin(SPAN * Math.PI / 360) ** 2));

// ── terrarium tiles, made here ───────────────────────────────────────────────
// elevation = R·256 + G + B/256 − 32768. pathcover.mjs builds one flat tile
// this way; this builds a different tile per request, because the value has to
// depend on where the tile is in the world for the ramp to be continuous.
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
function encode(metres) {
  const v = Math.max(0, metres + 32768);
  return [Math.floor(v / 256) & 0xff, Math.floor(v) % 256, Math.round((v % 1) * 256) & 0xff];
}
// One column of pixels per longitude, so the tile is a vertical-striped ramp.
function rampTile(z, x) {
  const W = 256, H = 256;
  const world = 256 * Math.pow(2, z);
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const col = [];
  for (let px = 0; px < W; px++) {
    const lon = (x * 256 + px + 0.5) / world * 360 - 180;
    col.push(encode(groundAt((lon - HOP.lonA) / SPAN)));
  }
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;                                  // filter: none
    for (let px = 0; px < W; px++) {
      const o = y * (W * 3 + 1) + 1 + px * 3;
      raw[o] = col[px][0]; raw[o + 1] = col[px][1]; raw[o + 2] = col[px][2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  // Registered after the policy so it is asked first.
  await page.route(/elevation-tiles-prod\/terrarium\//, (route) => {
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
    return route.fulfill({
      status: 200, contentType: 'image/png',
      body: m ? rampTile(Number(m[1]), Number(m[2])) : Buffer.alloc(0),
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

  // The hop, dropped in programmatically and the map put over it — no land
  // cover, so the ground line is the terrain and nothing is standing on it.
  await page.evaluate((h) => {
    state.path.cover = false;
    state.path.open = true;
    MapDraw.addLine([[h.lat, h.lonA], [h.lat, h.lonB]], []);
    state.map.fitBounds([[h.lat, h.lonA], [h.lat, h.lonB]], { padding: [80, 80], animate: false });
  }, HOP);
  await page.waitForFunction(() => !!document.getElementById('path-cursor'), null, { timeout: 30_000 });
  await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

  // ── What the chart reads, and where its parts are ────────────────────────
  await page.evaluate(() => {
    // Everything the assertions below read, in one place: the cursor's own
    // parts in viewBox units, and the marker on the map in coordinates.
    window.__cursor = () => {
      const g = document.getElementById('path-cursor');
      const dot = document.getElementById('path-cursor-dot');
      const txt = document.getElementById('path-cursor-text');
      const svg = document.querySelector('svg.path-chart');
      const box = svg ? svg.getBoundingClientRect() : null;
      const vb = svg ? svg.viewBox.baseVal : null;
      return {
        shown: !!g && g.style.display !== 'none',
        x: dot ? Number(dot.getAttribute('cx')) : null,
        y: dot ? Number(dot.getAttribute('cy')) : null,
        text: txt ? txt.textContent : null,
        // The plot's own x range, so an assertion can talk in fractions along
        // the path rather than in pixels of whatever width the panel gave it.
        scale: box && vb ? { left: box.left, width: box.width, vbw: vb.width } : null,
      };
    };
    // The map's marker: the circleMarker MapDraw puts down, and its label.
    window.__mapDot = () => {
      let found = null;
      state.map.eachLayer((l) => {
        if (l instanceof L.CircleMarker && l.options.fillColor === '#2196f3') found = l;
      });
      if (!found) return null;
      const ll = found.getLatLng();
      const tip = found.getTooltip();
      return { lat: ll.lat, lon: ll.lng, label: tip ? String(tip.getContent()) : null };
    };
  });

  // The profile card is a long way down the Stations page — well below the fold
  // at any sane window height — and a pointer cannot be moved to a point that
  // is not on the screen. Each side of this check scrolls its own half into
  // view before reaching for it, and re-reads the rectangle afterwards, because
  // scrolling one out of the way is exactly what putting the other in view does.
  await page.evaluate(() => {
    window.__scrollTo = (sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    };
  });
  const showChart = async () => {
    await page.evaluate(() => window.__scrollTo('svg.path-chart'));
    await page.waitForTimeout(120);
  };
  const showMap = async () => {
    await page.evaluate(() => window.__scrollTo('#leaflet-map'));
    await page.waitForTimeout(120);
  };

  const first = await page.evaluate(() => window.__cursor());
  check('the chart is drawn with a cursor on it, and nothing showing until the pointer arrives',
    first.shown === false && !!first.scale, JSON.stringify(first));

  // A fraction along the plot, in client pixels. The chart is drawn in viewBox
  // units and stretched to the panel's width, so this is the same conversion
  // the app has to do in reverse — which is why an assertion in fractions is
  // worth more here than one in pixels.
  const L_ = 52, R_ = 14;                                  // chartSvg's own margins
  const hoverChart = async (t) => {
    await showChart();
    const s = (await page.evaluate(() => window.__cursor())).scale;
    const k = s.width / s.vbw;                             // client px per viewBox unit
    const ux = L_ + t * (s.vbw - L_ - R_);
    const box = await page.evaluate(() => {
      const r = document.querySelector('svg.path-chart').getBoundingClientRect();
      return { left: r.left, top: r.top, height: r.height };
    });
    await page.mouse.move(s.left + ux * k, box.top + box.height * 0.5);
    await page.waitForTimeout(120);
    return page.evaluate(() => ({ c: window.__cursor(), m: window.__mapDot() }));
  };

  const half = await hoverChart(0.5);
  check('a pointer halfway across the plot shows the cursor',
    half.c.shown === true, JSON.stringify(half.c));
  check('and it reads the ground height there — 500 m up a 1,000 m ramp',
    /^(4[89]\d|5[01]\d) m$/.test(half.c.text || ''), String(half.c.text));
  check('the dot sits halfway across the plot too',
    Math.abs(half.c.x - (L_ + 0.5 * (920 - L_ - R_))) < 12, String(half.c.x));
  check('and the same point is marked on the map, halfway along the line',
    !!half.m && Math.abs(half.m.lon - (HOP.lonA + SPAN * 0.5)) < SPAN * 0.03,
    JSON.stringify(half.m));
  const halfKm = /· ([\d.]+) km along$/.exec((half.m && half.m.label) || '');
  check('the map marker says the same height, and how far along it is',
    !!half.m && /^(4[89]\d|5[01]\d) m ground · /.test(half.m.label || '')
      && !!halfKm && Math.abs(Number(halfKm[1]) - HOP_KM / 2) < 0.15,
    `${half.m && half.m.label} (half of ${HOP_KM.toFixed(2)} km)`);

  const quarter = await hoverChart(0.25);
  check('a quarter of the way along, the reading is a quarter of the ramp',
    /^(2[34]\d|2[56]\d) m$/.test(quarter.c.text || ''), String(quarter.c.text));
  check('the dot has moved left with it, and the marker west along the line',
    quarter.c.x < half.c.x && !!quarter.m && quarter.m.lon < half.m.lon,
    JSON.stringify({ x: quarter.c.x, lon: quarter.m && quarter.m.lon }));
  // The whole reason the dot's y is worth an assertion: it rides the ground
  // line rather than sitting at a fixed height, so lower ground is further
  // down the plot. SVG y grows downward.
  check('and the dot rode the ground down with it — lower ground, lower on the plot',
    quarter.c.y > half.c.y, JSON.stringify({ quarter: quarter.c.y, half: half.c.y }));

  // ── Leaving the chart takes both halves away ─────────────────────────────
  await showChart();
  await page.evaluate(() => {
    const r = document.querySelector('svg.path-chart').getBoundingClientRect();
    window.__awayFromChart = { x: r.left + r.width / 2, y: r.top - 60 };
  });
  const away = await page.evaluate(() => window.__awayFromChart);
  await page.mouse.move(away.x, away.y);
  await page.waitForTimeout(200);
  const gone = await page.evaluate(() => ({ c: window.__cursor(), m: window.__mapDot() }));
  check('off the chart, the dot and the marker both go',
    gone.c.shown === false && gone.m === null, JSON.stringify(gone));

  // ── The other direction: the pointer on the map moves the chart ──────────
  const hoverMap = async (t) => {
    await showMap();
    const at = await page.evaluate(([lat, lon]) => {
      const pt = state.map.latLngToContainerPoint([lat, lon]);
      const r = state.map.getContainer().getBoundingClientRect();
      return { x: r.left + pt.x, y: r.top + pt.y };
    }, [HOP.lat, HOP.lonA + SPAN * t]);
    await page.mouse.move(at.x, at.y - 40);
    await page.waitForTimeout(80);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(150);
    return page.evaluate(() => ({ c: window.__cursor(), m: window.__mapDot() }));
  };

  const onLine = await hoverMap(0.75);
  check('running the pointer along the line on the map brings the chart’s cursor with it',
    onLine.c.shown === true, JSON.stringify(onLine.c));
  check('and it reads three quarters of the ramp, from the map’s side',
    /^(7[34]\d|7[56]\d) m$/.test(onLine.c.text || ''), String(onLine.c.text));
  check('the dot is three quarters across the plot',
    Math.abs(onLine.c.x - (L_ + 0.75 * (920 - L_ - R_))) < 25, String(onLine.c.x));

  // Well off the line — beyond the snap distance, on the same map.
  await showMap();
  const offLine = await page.evaluate(([lat, lon]) => {
    const pt = state.map.latLngToContainerPoint([lat, lon]);
    const r = state.map.getContainer().getBoundingClientRect();
    return { x: r.left + pt.x, y: r.top + pt.y };
  }, [HOP.lat + 0.02, HOP.lonA + SPAN * 0.75]);
  await page.mouse.move(offLine.x, offLine.y);
  await page.waitForTimeout(200);
  const offIt = await page.evaluate(() => ({ c: window.__cursor(), m: window.__mapDot() }));
  check('and stepping off the line puts both halves away again',
    offIt.c.shown === false && offIt.m === null, JSON.stringify(offIt));

  // ── The marker must not outlive the chart it was reading ────────────────
  await hoverMap(0.5);
  await page.evaluate(() => { MapDraw.clearAll(); });
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({
    chart: !!document.querySelector('svg.path-chart'),
    m: window.__mapDot(),
  }));
  check('deleting the line takes the chart and the marker on the ground with it',
    cleared.chart === false && cleared.m === null, JSON.stringify(cleared));

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — the cursor reads the ground under it, and the chart and the map follow each other.');
