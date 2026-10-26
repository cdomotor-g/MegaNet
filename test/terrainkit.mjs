// The five terrain-and-place features added for #184, held to what each of
// them claims about the ground.
//
// Why one file rather than five: they are one change and they share one very
// expensive fixture — a terrain server. Everything below runs against tiles
// this check *makes*, per tile coordinate, from a closed-form surface, so the
// peaks it finds, the colours it paints and the coverage it computes are all
// checkable against arithmetic done here rather than against whatever SRTM
// says about Queensland today. That is the same bargain pathcover.mjs makes
// with its one flat tile, widened to a hilly world because three of these five
// are meaningless over flat ground.
//
// What is under test, and the defect each assertion would have caught:
//
//   Elevation base map   the colour file's twelve bands, paired the way its
//                        author wrote them. Pair the two lists head to head
//                        instead of end to end and the ramp puts pure blue on
//                        the mountains — which is a plot that looks deliberate
//                        and is upside down.
//   Highest ground       peaks, not maxima. Sort the grid and take the top
//                        five and you get five pixels of one hilltop, every
//                        time, and the feature is useless in a way that still
//                        renders.
//   Polar coverage       that Draw refuses what it cannot honestly compute,
//                        that it produces an overlay and a key naming the two
//                        radios, and that moving the threshold re-colours what
//                        is already computed instead of re-running the model.
//   Places               the coordinate parser, over every shape a coordinate
//                        arrives in — including "26 07 24 S", where reading
//                        the S as a seconds marker rather than as South is a
//                        silent 52-degree error — and 📍 Find a place, the
//                        blue pin's pane: a coordinate there moves the map
//                        offline, the file's catchments, rivers and council
//                        areas are listed at once and each is gone to, and a
//                        blocked gazetteer says so and leaves them standing.
//   Fade margin          the profile card's new row: a figure where both ends
//                        are stations with radios, and a stated reason where
//                        they are not — and the signal run along the line
//                        under it, which has to arrive at B in the A→B
//                        figure, be painted in its bands, and ride the cursor.
//                        And one set of radio figures behind every margin: a
//                        TX power typed into the link budget or the profile
//                        moves the budget, the profile and the signal by the
//                        same decibels. A clicked radio path makes the card
//                        the path's, its figures said once; 📋 copies the
//                        chart and every figure behind the margin, and the
//                        clipboard is read back.
//
//   node --run terrain        (or: npm run terrain)
//       npm run terrain -- -v    also print what passed

import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

// ── a hilly world, made here ─────────────────────────────────────────────────
// pathcover.mjs needs one flat tile and makes one. Three of the five features
// here are about *relief*, so this makes a tile per coordinate out of a closed
// form in tile space: a long ramp with two sine ridges across it. Deterministic,
// continuous across tile edges (the phase is a function of absolute pixel
// position, not of position within the tile), and hilly enough that a peak
// finder has something to find.
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

// Height anywhere on the planet, from the *world* position of a pixel rather
// than from its position on one zoom level's grid — otherwise the same formula
// describes a different landscape at every zoom, and a check that fetches z10
// for one feature and z12 for another is measuring two worlds.
//
// wx and wy run 0..1 across the whole Web Mercator square, which is ~40,075 km
// at the equator. HILL_KM is therefore a real distance: hills every eight
// kilometres, which at the zooms these features use is fifteen grid samples
// across — wide enough for a ±2 local-maximum window to sit on, and close
// enough that a hundred-kilometre view holds dozens of them. A slow second
// term modulates their heights so no two summits tie and the ranking is
// strict.
const EARTH_KM = 40075.017;
const HILL_KM  = 8;
function heightAtWorld(wx, wy) {
  const K = 2 * Math.PI * EARTH_KM / HILL_KM;
  const a = Math.sin(wx * K) * Math.sin(wy * K);
  const b = Math.sin(wx * K / 9.7 + 0.6) * Math.cos(wy * K / 11.3 + 1.1);
  const c = Math.sin(wx * K / 41 + 2.2);
  return Math.round(180 + 380 * a * a + 220 * b + 90 * c);
}

const tileCache = new Map();
function terrariumPng(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const W = 256, H = 256;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let py = 0; py < H; py++) {
    raw[py * (W * 3 + 1)] = 0;
    for (let px = 0; px < W; px++) {
      const side = 256 * Math.pow(2, z);
      const v = heightAtWorld((x * 256 + px) / side, (y * 256 + py) / side) + 32768;
      const o = py * (W * 3 + 1) + 1 + px * 3;
      raw[o] = Math.floor(v / 256) & 0xff;
      raw[o + 1] = Math.floor(v) % 256;
      raw[o + 2] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  tileCache.set(key, png);
  return png;
}

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];
let tileHits = 0;

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// 📋 Copy for a report is read back off the clipboard (section 4).
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
// Registered after the policy, so it is asked first — the terrain server is
// answered with this world and everything else off-origin stays blocked.
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  tileHits++;
  return route.fulfill({ status: 200, contentType: 'image/png',
                         body: terrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
page.on('pageerror', e => errors.push(String(e)));

// The Elvis height source's WCS (map-elevation.js), answered here with a
// float32 GeoTIFF of the layout the live service sends — so the fetch, the
// content-type test and the TIFF reader under test are the real ones. Three
// kinds of ground, keyed on the box's west edge: west of 151° the service is
// down (500), west of 152° it has no survey (every internal block unwritten),
// and elsewhere the left half of each tile is 1234.5 m of LiDAR and the right
// half is written but 0.0 — the service's own hole — so a tile there is
// partly 5 m and partly the 30 m world above.
const elvisAsked = [];
function wcsTiff(kind) {
  const W = 256, T = 128, IFD = 8, NTAG = 11;
  const OFFS = IFD + 2 + NTAG * 12 + 4, LENS = OFFS + 16, DATA = LENS + 16;
  const blocks = kind === 'empty' ? 0 : 4;
  const buf = Buffer.alloc(DATA + blocks * T * T * 4);
  buf.write('II', 0, 'ascii'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(IFD, 4);
  buf.writeUInt16LE(NTAG, IFD);
  const tags = [[256, 3, 1, W], [257, 3, 1, W], [258, 3, 1, 32], [259, 3, 1, 1], [262, 3, 1, 1],
                [277, 3, 1, 1], [322, 3, 1, T], [323, 3, 1, T], [324, 4, 4, OFFS], [325, 4, 4, LENS],
                [339, 3, 1, 3]];
  tags.forEach(([tag, type, cnt, v], i) => {
    const e = IFD + 2 + i * 12;
    buf.writeUInt16LE(tag, e); buf.writeUInt16LE(type, e + 2); buf.writeUInt32LE(cnt, e + 4);
    if (type === 3 && cnt === 1) buf.writeUInt16LE(v, e + 8); else buf.writeUInt32LE(v, e + 8);
  });
  for (let b = 0; b < blocks; b++) {
    const at = DATA + b * T * T * 4;
    buf.writeUInt32LE(at, OFFS + b * 4); buf.writeUInt32LE(T * T * 4, LENS + b * 4);
    if (b % 2 === 0) for (let i = 0; i < T * T; i++) buf.writeFloatLE(1234.5, at + i * 4);
  }
  return buf;
}
await page.route(/services\.ga\.gov\.au\/.*WCSServer/, route => {
  const url = route.request().url();
  elvisAsked.push(url);
  const west = Number((/BBOX=([-\d.]+)/.exec(url) || [])[1]);
  if (west < 151) return route.fulfill({ status: 500, body: 'down',
                                          headers: { 'Access-Control-Allow-Origin': '*' } });
  return route.fulfill({ status: 200, contentType: 'image/tiff',
                         body: wcsTiff(west < 152 ? 'empty' : 'mixed'),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// ── 1. the elevation overlay ────────────────────────────────────────────────
// It was a base map until #186 and is an overlay with an opacity slider now:
// picked as a base it took the localities, the roads and the watercourses with
// it, and the ground and the place names are not alternatives. What is asserted
// is unchanged apart from where it lives — the ramp, the painting, the relief
// switch — plus the two things being an overlay is *for*: it is out of the base
// picker, and it draws under the place-name layers rather than over them.
console.log('\nThe elevation overlay');

const ramp = await page.evaluate(() => ({
  stops: MapElevation.RAMP.map(b => [b.m, b.hex.toLowerCase()]),
  names: Object.keys(makeBaseLayers()),
  at: [-5, 0, 0.5, 60, 300, 450, 950, 1400].map(m => [m, MapElevation.colourAt(m).toLowerCase()]),
  legendTop: (MapElevation.rampHtml().match(/--dot:(#[0-9a-fA-F]{6})/) || [])[1],
  relief: MapElevation.relief(),
}));

// The twelve heights and the twelve colours of the file, paired end to end:
// its colour list runs top-of-legend first (highest band) while its heights
// run bottom-up, so the lists are reversed against each other. Written out in
// full rather than derived, because "the ramp is whatever the code says" is
// the one thing this cannot assert.
const WANT = [[0, '#0000ff'], [1, '#6464ff'], [50, '#4080ff'], [100, '#2f97ff'],
              [150, '#00f4f4'], [250, '#88ffff'], [400, '#4b9700'], [500, '#00ca00'],
              [700, '#00ff80'], [800, '#80ff00'], [900, '#8f8f8f'], [1000, '#ffff80']];
ok('the colour file is twelve bands', ramp.stops.length === 12, `${ramp.stops.length}`);
ok('every height carries the colour the file gives it',
   JSON.stringify(ramp.stops) === JSON.stringify(WANT),
   JSON.stringify(ramp.stops));
ok('the sea is blue and the tops are pale — the ramp is not upside down',
   ramp.stops[0][1] === '#0000ff' && ramp.stops[11][1] === '#ffff80');
ok('Elevation is no longer one of the base maps', !ramp.names.includes('Elevation'),
   ramp.names.join(', '));
for (const [m, hex] of ramp.at) {
  const band = WANT.filter(([h]) => m >= h).pop() || WANT[0];
  ok(`${m} m paints ${band[1]}`, hex === band[1], `got ${hex}`);
}
ok('the key is drawn highest band first', ramp.legendTop === '#FFFF80',
   String(ramp.legendTop));

// Selecting it has to actually paint: a canvas tile on the map is proof that
// createTile ran, the terrarium PNG decoded and getImageData was allowed.
const painted = await page.evaluate(async () => {
  MapElevation.setEnabled(true);
  // Leaflet puts the tile element in the DOM before createTile has finished
  // with it, so "a canvas exists" is not "a canvas has been painted" — the
  // wait is for a pixel with something in it, on any of them.
  const until = Date.now() + 20000;
  const pane = () => document.querySelector('.leaflet-mnElevation-pane');
  const key = () => document.querySelector('#map-display-block .elev-ramp');
  const slider = () => document.querySelector('#map-display-block input[aria-label="Elevation shading opacity"]');
  while (Date.now() < until) {
    const cv = [...document.querySelectorAll('.mn-base-elev canvas.leaflet-tile')];
    for (const c of cv) {
      const d = c.getContext('2d').getImageData(4, 4, 1, 1).data;
      if (d[3] === 255) {
        return { tiles: cv.length, px: [d[0], d[1], d[2], d[3]],
                 inPane: !!pane() && pane().contains(c),
                 paneZ: pane() ? Number(getComputedStyle(pane()).zIndex) : null,
                 labelZ: (() => { const p = document.querySelector('.leaflet-mnBaseLabels-pane');
                                  return p ? Number(getComputedStyle(p).zIndex) : null; })(),
                 key: !!key(), slider: !!slider(),
                 opacity: MapElevation.opacity() };
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const cv = document.querySelectorAll('.mn-base-elev canvas.leaflet-tile');
  return { tiles: cv.length, px: null, inPane: false, paneZ: null, labelZ: null,
           key: !!key(), slider: !!slider(), opacity: MapElevation.opacity() };
});
ok('switching the overlay on puts canvas tiles on the map', painted.tiles > 0, `${painted.tiles} tile(s)`);
ok('the tiles are painted, not blank', !!painted.px && painted.px[3] === 255,
   JSON.stringify(painted.px));
ok('they are in a pane of their own, not the base layer', painted.inPane, JSON.stringify(painted));
// The whole point of the move: on Satellite and Dark the place names ride in
// mnBaseLabels, and they have to stay *over* the wash or the ground has taken
// the names with it again.
ok('drawn under the place-name layers, which is why it stopped being a base',
   painted.paneZ != null && painted.labelZ != null && painted.paneZ < painted.labelZ,
   `${painted.paneZ} < ${painted.labelZ}`);
ok('its opacity slider and key are in the Map display panel',
   painted.slider && painted.key, JSON.stringify(painted));
ok('and it opens at less than full strength, so the base is still readable',
   painted.opacity > 0 && painted.opacity < 1, String(painted.opacity));

const opacity = await page.evaluate(() => {
  MapElevation.setOpacity(0.3);
  return { now: MapElevation.opacity(), stored: localStorage.getItem('mn-map-elev-opacity') };
});
ok('the opacity is remembered', opacity.now === 0.3 && Number(opacity.stored) === 0.3,
   JSON.stringify(opacity));

const relief = await page.evaluate(() => {
  MapElevation.setRelief(false);
  const off = localStorage.getItem('mn-elev-relief');
  MapElevation.setRelief(true);
  return { off, on: localStorage.getItem('mn-elev-relief'), now: MapElevation.relief() };
});
ok('the relief switch is remembered', relief.off === 'off' && relief.on === 'on' && relief.now === true,
   JSON.stringify(relief));

// ── the height source: ~30 m everywhere, or Elvis 5 m where it is held ─────
// A picture of better ground, not a new terrain source — so what is held here
// is that it costs nothing until picked, that it draws the WCS's heights in the
// same ramp, that it falls back to the 30 m tiles where the grid is empty, and
// that the note says which of those is on screen.
ok('Elvis is not asked for anything while the source is the 30 m tiles',
   elvisAsked.length === 0, `${elvisAsked.length} request(s)`);

const srcUi = await page.evaluate(() => {
  const sel = document.querySelector('#map-display-block select[aria-label="Elevation shading source"]');
  return { sel: !!sel, value: sel && sel.value, opts: sel ? [...sel.options].map(o => o.value) : [],
           src: MapElevation.source() };
});
ok('a height-source menu sits with the elevation controls, on the 30 m tiles by default',
   srcUi.sel && srcUi.value === 'srtm' && srcUi.src === 'srtm'
   && JSON.stringify(srcUi.opts) === '["srtm","elvis"]', JSON.stringify(srcUi));

// `want` is a status kind; the tiles load at moveend and then the queue, so a
// wait on "any status" would read the last view's answer back as this one's.
const elvisAt = async (ll, z, want) => {
  await page.evaluate(([ll, z]) => state.map.setView(ll, z, { animate: false }), [ll, z]);
  await page.waitForFunction(k => MapElevation.sourceStatus().kind === k, want,
    { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);   // the note follows the tiles on a 250 ms debounce
  return page.evaluate(() => ({ ...MapElevation.sourceStatus(),
    note: document.getElementById('map-elev-note')?.textContent || '' }));
};

await page.evaluate(() => {
  MapElevation._elvisReset();
  MapElevation.setSource('elvis');
});
const picked = await page.evaluate(() => ({
  stored: localStorage.getItem('mn-map-elev-src'),
  sel: document.querySelector('#map-display-block select[aria-label="Elevation shading source"]')?.value,
}));
ok('picking Elvis is remembered and the menu shows it',
   picked.stored === 'elvis' && picked.sel === 'elvis', JSON.stringify(picked));

const far = await elvisAt([-27.5, 152.5], 11, 'zoom');
ok('below its zoom floor the note says the 30 m tiles are what is drawn',
   far.kind === 'zoom' && /zoom 13/.test(far.note), `${far.kind}: ${far.note.slice(0, 120)}`);
ok('…and nothing is asked of Elvis out there', elvisAsked.length === 0,
   `${elvisAsked.length} request(s)`);

const near = await elvisAt([-27.5, 152.5], 14, 'partial');
const px = await page.evaluate(() => {
  for (const c of document.querySelectorAll('.mn-base-elev canvas.leaflet-tile-loaded')) {
    const cx = c.getContext('2d');
    const l = cx.getImageData(10, 128, 1, 1).data, r = cx.getImageData(250, 128, 1, 1).data;
    if (l[3] === 255 && r[3] === 255) return { l: [...l], r: [...r] };
  }
  return null;
});
ok('with Elvis picked the WCS is asked for a GDA94 GeoTIFF of the tile',
   elvisAsked.length > 0 && elvisAsked.every(u => /CRS=EPSG:4283/.test(u) && /FORMAT=GeoTIFF/.test(u)
     && /WIDTH=256&HEIGHT=256/.test(u)), elvisAsked[0] || 'none');
ok('the 5 m heights are painted in the same ramp (1234.5 m is the top band)',
   !!px && px.l[0] === 0xff && px.l[1] === 0xff && px.l[2] === 0x80, JSON.stringify(px));
ok('…and the grid\'s 0.0 holes are filled from the 30 m tiles, not painted as sea',
   !!px && !(px.r[0] === 0xff && px.r[1] === 0xff && px.r[2] === 0x80)
   && !(px.r[0] === 0 && px.r[1] === 0 && px.r[2] === 0xff), JSON.stringify(px));
ok('the note says Elvis 5 m is in use and where it fell back',
   near.kind === 'partial' && /Elvis 5 m/.test(near.note) && /partly/.test(near.note)
   && /30 m/.test(near.note), `${near.kind}: ${near.note.slice(0, 160)}`);

const none = await elvisAt([-27.5, 151.5], 14, 'none');
ok('where the grid holds no survey the note says so and the tiles are 30 m',
   none.kind === 'none' && /No Elvis 5 m grid here/.test(none.note), `${none.kind}: ${none.note.slice(0, 120)}`);

const down = await elvisAt([-27.5, 150.5], 14, 'down');
ok('a service that fails is reported as unreachable, not as "no data"',
   down.kind === 'down' && /could not be reached/.test(down.note), `${down.kind}: ${down.note.slice(0, 120)}`);

const cap = await page.evaluate(() => document.querySelectorAll('.mn-base-elev canvas.leaflet-tile').length);
ok('tiles still paint while Elvis is down', cap > 0, `${cap} tile(s)`);

await page.evaluate(() => { MapElevation.setSource('srtm'); MapElevation._elvisReset(); });

await page.evaluate(() => MapElevation.setEnabled(false));

// ── 2. the highest ground in view ───────────────────────────────────────────
console.log('\nThe highest ground in view');

// A view small enough that the grid is fine and the whole plot fits the tile
// budget, somewhere in the hilly world above.
await page.evaluate(() => state.map.setView([-27.5, 152.5], 11));
await page.waitForTimeout(400);

// `want` is what the switch is set to: a pass is debounced and then
// asynchronous, so waiting for "any peaks at all" would read the *previous*
// pass's answer back and call it this one's.
const peaksOf = async want => {
  await page.evaluate(() => MapPeaks.sync());
  await page.waitForFunction(n => MapPeaks.peaks().length === n ||
    /No peaks|stands out/.test(document.getElementById('map-peaks-note')?.textContent || ''),
    want, { timeout: LOAD_TIMEOUT });
  return page.evaluate(() => ({
    peaks: MapPeaks.peaks(),
    pins: document.querySelectorAll('.mn-peak').length,
    legend: /Highest ground in view/.test(document.getElementById('map-legend')?.textContent || ''),
    note: document.getElementById('map-peaks-note')?.textContent || '',
  }));
};

const offNote = await page.evaluate(() => ({
  offList: /Highest ground in view/.test(document.getElementById('map-legend')?.textContent || ''),
  active: MapPeaks.active(),
}));
ok('off, it is offered in the legend rather than drawn',
   offNote.offList === true && offNote.active === false);

await page.evaluate(() => MapPeaks.setEnabled(true));
let pk = await peaksOf(5);
ok('five peaks by default', pk.peaks.length === 5, `${pk.peaks.length}`);
ok('a pin for each', pk.pins === pk.peaks.length, `${pk.pins} pin(s)`);
ok('ranked 1..n', pk.peaks.every((p, i) => p.rank === i + 1));
ok('highest first', pk.peaks.every((p, i) => i === 0 || p.m <= pk.peaks[i - 1].m),
   pk.peaks.map(p => Math.round(p.m)).join(' → '));
// The whole difference between a peak finder and a sort: no two of them may be
// the same hill. The separation floor is a ninth of the view, comfortably
// under the module's own SEP_FRAC of 0.11.
const sep = await page.evaluate(peaks => {
  let worst = Infinity;
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      worst = Math.min(worst, acmaHaversineKm(peaks[i].lat, peaks[i].lon, peaks[j].lat, peaks[j].lon));
    }
  }
  const b = state.map.getBounds();
  const diag = acmaHaversineKm(b.getNorth(), b.getWest(), b.getSouth(), b.getEast());
  return { worst, diag };
}, pk.peaks);
ok('no two peaks are the same hill', sep.worst > sep.diag * 0.09,
   `closest pair ${sep.worst.toFixed(1)} km over a ${sep.diag.toFixed(0)} km view`);
ok('the legend claims the layer only while it is drawn', pk.legend === true);
ok('the note says what grid the summits were found on', /sampled every ~\d+ m/.test(pk.note), pk.note.slice(0, 120));

await page.evaluate(() => MapPeaks.setCount(3));
pk = await peaksOf(3);
ok('three when three are asked for', pk.peaks.length === 3, `${pk.peaks.length}`);
ok('the count is remembered',
   await page.evaluate(() => localStorage.getItem('mn-peak-count') === '3'));

const flew = await page.evaluate(async () => {
  const p = MapPeaks.peaks()[1];
  MapPeaks.flyTo(2);
  // panTo is animated, so the centre a frame later is somewhere on the way.
  await new Promise(r => setTimeout(r, 1200));
  const c = state.map.getCenter();
  return { d: acmaHaversineKm(c.lat, c.lng, p.lat, p.lon) };
});
ok('the list takes the map to a summit', flew.d < 0.5, `${flew.d.toFixed(3)} km off`);

await page.evaluate(() => { MapPeaks.setEnabled(false); state.map.setView([-27.5, 152.5], 11); });
ok('switching it off takes the pins with it',
   await page.evaluate(() => document.querySelectorAll('.mn-peak').length === 0 && !MapPeaks.active()));

// ── 3. places and coordinates: 📍 Find a place ──────────────────────────────
console.log('\nPlaces and coordinates in Find a place');

const COORDS = [
  ['-26.1234, 152.5678', -26.1234, 152.5678],
  ['-26.1234 152.5678', -26.1234, 152.5678],
  ['26.1234S, 152.5678E', -26.1234, 152.5678],
  ['S26.1234 E152.5678', -26.1234, 152.5678],
  ['26°07\'24"S 152°34\'04"E', -26.123333, 152.567778],
  ['26 07 24 S 152 34 04 E', -26.123333, 152.567778],
  ['S 26 07.4 E 152 34.07', -26.123333, 152.567833],
  ['26d 07m 24s S 152d 34m 04s E', -26.123333, 152.567778],
  ['lat=-26.1 lon=152.5', -26.1, 152.5],
  ['(-27.4698, 153.0251)', -27.4698, 153.0251],
  ['152.5678, -26.1234', -26.1234, 152.5678],
];
const NOT_COORDS = ['6128 6129', '4021-4025', 'Gympie', 'Mt Kanigan', '491', '-26.1234', 'Kanigan 6128'];

const parsed = await page.evaluate(({ COORDS, NOT_COORDS }) => ({
  hits: COORDS.map(([t]) => Places.parse(t)),
  misses: NOT_COORDS.map(t => Places.parse(t)),
}), { COORDS, NOT_COORDS });

COORDS.forEach(([t, lat, lon], i) => {
  const got = parsed.hits[i];
  ok(`"${t}" parses`, !!got && Math.abs(got.lat - lat) < 2e-4 && Math.abs(got.lon - lon) < 2e-4,
     got ? got.text : 'null');
});
NOT_COORDS.forEach((t, i) => {
  ok(`"${t}" is not a coordinate`, parsed.misses[i] === null,
     parsed.misses[i] ? parsed.misses[i].text : '');
});

// 📍 Find a place — the blue pin's pane in the side panel. A coordinate typed
// into it moves the map and drops a blue pin, with no network at all, which
// is the case a person standing beside a site is in.
const typed = await page.evaluate(async () => {
  setDockTab('places', { instant: true });
  const box = document.getElementById('places-q');
  box.focus();
  box.value = '-26.1234, 152.5678';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const c = state.map.getCenter();
  return {
    d: acmaHaversineKm(c.lat, c.lng, -26.1234, 152.5678),
    pin: document.querySelectorAll('.mn-place.mn-pin-blue').length,
    list: (document.getElementById('places-results') || {}).textContent || '',
    filtering: anyStationFilterActive(),
  };
});
ok('a coordinate in Find a place takes the map there', typed.d < 0.2, `${typed.d.toFixed(3)} km off`);
ok('…and drops one blue pin', typed.pin === 1, `${typed.pin} pin(s)`);
ok('…and lists the coordinate it read', typed.list.includes('-26.1234, 152.5678'), typed.list.trim().slice(0, 80));
ok('…without filtering a single station', typed.filtering === false);

// The file's own answers, at once and offline: a catchment by name and by its
// basin number, the rivers the stations stand on (a creek written CK and
// CREEK is one creek), the council areas they are in.
const local = await page.evaluate(async () => {
  const ask = async t => {
    const box = document.getElementById('places-q');
    box.value = t;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return Places.debug().local;
  };
  return { fitzroy: await ask('fitzroy'), basin: await ask('130'), lockyer: await ask('lockyer') };
});
ok('a catchment by name, and the rivers named for it', local.fitzroy.catchments.includes('Fitzroy') && local.fitzroy.rivers.includes('Fitzroy River'), JSON.stringify(local.fitzroy));
ok('…and by its basin number alone', JSON.stringify(local.basin.catchments) === JSON.stringify(['Fitzroy']) && !local.basin.rivers.length, JSON.stringify(local.basin));
ok('Lockyer Creek once, however its stations spell it, and the council area',
  local.lockyer.rivers.filter(n => /^Lockyer C/.test(n)).length === 1 && local.lockyer.rivers.includes('Lockyer Creek')
    && local.lockyer.councils.includes('Lockyer Valley Regional'), JSON.stringify(local.lockyer));

// Pressed: the catchment drawn in outline and the map fitted to it; the river
// the stretch its stations span.
const went = await page.evaluate(async () => {
  const box = document.getElementById('places-q');
  box.value = 'fitzroy';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  Places.go('catchment', 0);
  const until = Date.now() + 15000;
  while (Date.now() < until && !(Places.debug().shown && Places.debug().shown.shape)) await new Promise(r => setTimeout(r, 100));
  const b = state.map.getBounds();
  const cat = { shown: Places.debug().shown, drawn: Places.debug().drawn,
                inView: b.contains([-23.5, 149.5]), span: b.getEast() - b.getWest() };
  Places.go('river', 0);
  await new Promise(r => setTimeout(r, 400));
  const rb = state.map.getBounds();
  const on = state.data.stations.filter(s => /^FITZROY RIVER$/i.test(String(s.stream || '').trim()) && s.lat != null);
  return { cat, river: { shown: Places.debug().shown, all: on.every(s => rb.pad(0.01).contains([s.lat, s.lon])), n: on.length } };
});
ok('a catchment pressed: its outline and a pin drawn, and the map fitted to the basin',
  went.cat.shown && went.cat.shown.group === 'catchment' && went.cat.shown.shape && went.cat.drawn === 2 && went.cat.inView && went.cat.span > 2,
  JSON.stringify(went.cat));
ok('a river pressed: the map over every station on it', went.river.shown && went.river.shown.group === 'river' && went.river.all && went.river.n > 3,
  JSON.stringify(went.river));

// A place name with the gazetteer unreachable — which is what the network
// policy makes of it — must say so and leave the file's answers standing.
const blocked = await page.evaluate(async () => {
  const box = document.getElementById('places-q');
  box.value = 'Gympie';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2600));
  return {
    list: (document.getElementById('places-results') || {}).textContent || '',
    councils: Places.debug().local.councils,
    matched: computeFilteredStations().length,
  };
});
ok('a blocked gazetteer says so rather than throwing', /unavailable/i.test(blocked.list), blocked.list.trim().slice(0, 160));
ok('…and the file\'s own answers stand beside it — the council area Gympie\'s stations are in',
  blocked.councils.includes('Gympie Regional') && blocked.list.includes('Gympie Regional'), JSON.stringify(blocked.councils));
ok('…and the station filter is untouched by any of it', blocked.matched > 0, `${blocked.matched} station(s)`);

// Nominatim's ceiling is a request a second. Typed a letter every 700 ms —
// each past the 650 ms pause, so each a lookup — the requests still go out a
// slot of 1.1 s apart, and one overtaken by the next before its turn is not
// sent at all. (A slot taken when the wait was over, not when it began, let two go
// out together.) The gazetteer answers from a stand-in here: the network
// policy blocks the real one.
const paced = await page.evaluate(async () => {
  const calls = [], t0 = performance.now(), real = window.fetch;
  window.fetch = (url, opts) => {
    if (!String(url).includes('nominatim')) return real(url, opts);
    const q = new URL(String(url)).searchParams.get('q');
    calls.push({ q, t: performance.now() - t0 });
    return Promise.resolve(new Response(JSON.stringify([{ category: 'place', type: 'town', addresstype: 'town', name: q,
      display_name: `${q}, Somewhere Regional, Queensland, 4000, Australia`, lat: '-26.19', lon: '152.66' }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  const box = document.getElementById('places-q');
  const type = v => { box.value = v; box.dispatchEvent(new Event('input', { bubbles: true })); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    for (const v of ['Kil', 'Kilk', 'Kilki', 'Kilkiv']) { type(v); await sleep(700); }
    await sleep(3000);
    const answered = Places.debug().gaz;
    // A row pressed is the one shown in its own list only, not in the next
    // query's at the same place.
    Places.go('osm', 0);
    const mine = document.querySelectorAll('#places-results .places-hit.is-here').length;
    type('Kilcoy'); await sleep(2000);
    const other = document.querySelectorAll('#places-results .places-hit.is-here, #places-results [aria-current]').length;
    return { calls, answered, mine, other };
  } finally { window.fetch = real; }
});
const gaps = paced.calls.slice(1).map((c, i) => Math.round(c.t - paced.calls[i].t));
// A second, not 1.1: the slots are 1.1 s apart, and a timer running late on a
// loaded machine can only eat into that margin, never go under the second.
ok('the gazetteer asked no more than once a second, however the typing falls',
  paced.calls.length >= 3 && gaps.every(g => g >= 1000), `${paced.calls.map(c => c.q).join(', ')}; gaps ${gaps.join(', ')} ms`);
ok('…a lookup overtaken before its turn not sent, and the last one answered',
  !paced.calls.some(c => c.q === 'Kilki') && paced.answered.text === 'Kilkiv' && !paced.answered.loading && paced.answered.n === 1,
  JSON.stringify(paced.answered));
ok('a row pressed is marked as the place shown in its own list, and in no other',
  paced.mine === 1 && paced.other === 0, `${paced.mine} / ${paced.other}`);

await page.evaluate(() => { Places.clear(true); shutDock({ instant: true }); });
ok('✕ takes the place pin with it',
   await page.evaluate(() => document.querySelectorAll('.mn-place').length === 0));

// ── 4. the fade margin on the profile card ──────────────────────────────────
console.log('\nThe fade margin on the profile card');

const PAIR = ['beenleigh_al', 'carbrook_al'];
const marginRow = await page.evaluate(async ids => {
  const a = state.data.stations.find(s => s.id === ids[0]);
  const b = state.data.stations.find(s => s.id === ids[1]);
  state.path.cover = false;
  MapDraw.addLine([[a.lat, a.lon], [b.lat, b.lon]], [a.id, b.id]);
  PathProfile.setOpen(true);
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const dt = [...document.querySelectorAll('#path-profile-panel .path-stats dt')]
      .find(x => x.textContent.trim() === 'Fade margin');
    if (dt && !/not computed/.test(dt.nextElementSibling.textContent)) {
      return { text: dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim(),
               cls: dt.nextElementSibling.querySelector('span').className };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  const dt = [...document.querySelectorAll('#path-profile-panel .path-stats dt')]
    .find(x => x.textContent.trim() === 'Fade margin');
  return { text: dt ? dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim() : null, cls: '' };
}, PAIR);
ok('the readout has a Fade margin row', marginRow.text != null, String(marginRow.text));
ok('…carrying a signed figure in dB', /[-+]\d+(\.\d)? dB/.test(marginRow.text || ''),
   marginRow.text || '');
ok('…banded with the link budget\'s own bands',
   /txt-(ok|warn|bad)/.test(marginRow.cls), marginRow.cls);
ok('…one way, naming the two ends A → B, and no way back',
   / · \S.* → \S/.test(marginRow.text || '') && !/B→A/.test(marginRow.text || ''), marginRow.text || '');

// The signal along the line. Priced after the chart is up, in slices, so it is
// waited for; then held to the row above it, to the bands, and to moving.
const sig = await page.evaluate(async () => {
  const until = Date.now() + 40000;
  while (Date.now() < until && !PathProfile.signalState()) await new Promise(r => setTimeout(r, 200));
  const s = PathProfile.signalState();
  if (!s) return null;
  const dd = [...document.querySelectorAll('#path-profile-panel .path-stats dt')]
    .find(x => x.textContent.trim() === 'Fade margin').nextElementSibling.textContent;
  const m = dd.trim().match(/^([-+]?\d+\.\d) dB/);
  // A colour as the page paints it: resolved by the cascade (the tokens, the
  // mix), then painted on a canvas and read back, because a computed mix comes
  // back as oklch() or color() rather than as three sRGB numbers.
  const probe = document.createElement('i');
  document.body.appendChild(probe);
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = c => {
    probe.style.color = ''; probe.style.color = c;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const tokens = { ok: rgb('var(--ok)'), warn: rgb('var(--warn)'), bad: rgb('var(--bad)') };
  // Nearest as seen, so in OKLab rather than in raw sRGB: a dark amber and a
  // dark green are close in sRGB numbers and nothing alike to look at.
  const lab = c => {
    const [r, g, b] = c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  };
  const nearest = c => Object.entries(tokens)
    .map(([k, t]) => [k, Math.hypot(...lab(t).map((v, i) => v - lab(c)[i]))]).sort((a, b) => a[1] - b[1])[0][0];
  const bands = [-8, -0.5, 0, 1, 2.9, 3.1, 5, 6.5, 9.9, 10.1, 12, 20, 60].map(v => ({
    m: v, band: lbMarginClass(v).cls, painted: nearest(rgb(s.colour(v))),
  }));
  const exact = { under: rgb(s.colour(-3)).join(), bad: tokens.bad.join(), strong: rgb(s.colour(40)).join(), ok: tokens.ok.join() };
  probe.remove();
  const stops = [...document.querySelectorAll('#path-sig-grad stop')].length;
  const svgOk = !!document.querySelector('#path-sig-under #path-sig-run path')
             && !!document.querySelector('#path-sig-over #path-sig-tag')
             && !document.getElementById('path-sig-run-ba');
  // The reveal is the wavefront's sphere round A, so how far it has run is its
  // horizontal radius.
  const width = () => Number(document.getElementById('path-sig-reveal').getAttribute('rx'));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Playing, on screen — the side panel's 〽️ pane brought up and the chart
  // scrolled to, as pathcursor.mjs does, because off screen it idles: the
  // wavefront moves. Looked at for longer than an arrival, its hold and the
  // breath after it last together, so some of what is seen is travel.
  // The card draws its chart at its column's width, and redraws it once the
  // pane comes up and that width is known (PathProfile's fitCard) — so the
  // chart looked at is the one drawn after that, not the one revealed.
  const fitted = () => { const c = document.querySelector('#path-profile-panel svg.path-chart');
    return c && Math.abs(c.getBoundingClientRect().width - c.viewBox.baseVal.width) <= 25 ? c : null; };
  dockReveal(document.querySelector('svg.path-chart'));
  document.querySelector('svg.path-chart').scrollIntoView({ block: 'center', behavior: 'instant' });
  for (let k = 0; k < 40 && !fitted(); k++) await sleep(50);
  await sleep(150);
  const chart = fitted() || document.querySelector('svg.path-chart');
  if (!s.playing) PathProfile.signalToggle();
  const seen = new Set();
  // …and the wavefront is the wave, not the Fresnel zone: mid-run it stands
  // the height of the sky, with the zone's stretch of it a part of that. It
  // was once only as tall as the zone, which drew the signal as a lens that
  // swelled out of A and narrowed into B.
  const fronts = [];
  const tall = id => { const el = document.getElementById(id);
    return el && el.getAttribute('d') ? el.getBBox().height : null; };
  for (let k = 0; k < 24; k++) {
    seen.add(width());
    // Travelling only — arrived, the front is hidden and the reveal run on.
    const going = document.getElementById('path-sig-front').style.display !== 'none';
    const w = tall('path-sig-wave-0'), z = tall('path-sig-ripple-0');
    if (going && w != null && z != null
        && width() > 0.2 * Number(document.querySelector('#path-sig-run rect').getAttribute('width'))) fronts.push([w, z]);
    await sleep(100);
  }
  // The card closed: no frames, nothing moving; opened again, it carries on.
  const card = chart.closest('details');
  card.open = false;
  await sleep(250);
  const idleW = width(), idleRun = PathProfile.signalState().running;
  await sleep(400);
  const idleOff = !idleRun && width() === idleW;
  card.open = true;
  await sleep(250);
  const back = new Set();
  for (let k = 0; k < 24; k++) { back.add(width()); await sleep(100); }
  // Held: the run whole, and nothing moving.
  PathProfile.signalToggle();
  const stored = localStorage.getItem('mn-path-signal');
  const heldW = width();
  await sleep(350);
  const heldW2 = width();
  const tag = document.getElementById('path-sig-tag-text').textContent;
  const btn = document.getElementById('path-sig-toggle').textContent;
  PathProfile.signalToggle();
  // The cursor: the figure at the point under it, on the chart's tag and on the
  // map's marker. At B it is the A→B fade margin itself.
  const D = s.m[s.m.length - 1].d1;
  const mapLabel = () => { let t = null; state.map.eachLayer(l => {
    if (l instanceof L.CircleMarker && l.getTooltip && l.getTooltip()) t = String(l.getTooltip().getContent()); }); return t; };
  PathProfile.hoverAt(D);
  const hoverEnd = { tag: document.getElementById('path-cursor-text').textContent, map: mapLabel() };
  PathProfile.hoverAt(D / 2);
  const hoverMid = { tag: document.getElementById('path-cursor-text').textContent, map: mapLabel() };
  PathProfile.hoverOff();
  return {
    rowAB: m ? Number(m[1]) : null,
    end: s.m[s.m.length - 1].m, near: s.m[0].m,
    n: s.m.length, stops, hoverEnd, hoverMid,
    bands, exact, svgOk, moved: seen.size >= 3, seen: seen.size, loop: JSON.stringify({
      playing: PathProfile.signalState().playing, running: PathProfile.signalState().running,
      inView: PathProfile.signalState().inView }),
    fronts, ih: Number(document.querySelector('#path-sig-run rect').getAttribute('height')),
    stored, heldW, heldW2, tag, btn, idleOff, resumed: back.size >= 3, iw: Number(document.querySelector('#path-sig-run rect').getAttribute('width')),
  };
});
ok('the signal is priced along the line, A → B', !!sig && sig.n > 40, sig ? `${sig.n} points` : 'never priced');
if (sig) {
  ok('…and arrives at B in the A→B fade margin',
     Math.abs(sig.end - sig.rowAB) < 0.06, `${sig.end.toFixed(2)} against the row's ${sig.rowAB}`);
  ok('…stronger near the transmitter than at the receiver',
     sig.near > sig.end, `${sig.near.toFixed(1)} → ${sig.end.toFixed(1)}`);
  const off = sig.bands.filter(b => b.band !== b.painted);
  ok('every colour on the line is nearest its fade-margin band\'s own token', !off.length,
     off.map(b => `${b.m} dB is ${b.band}, painted nearest ${b.painted}`).join('; '));
  ok('…red outright under the RX threshold, green outright when strong',
     sig.exact.under === sig.exact.bad && sig.exact.strong === sig.exact.ok, JSON.stringify(sig.exact));
  ok('the chart carries one run, a gradient stop per priced point, and the tag',
     sig.svgOk && sig.stops === sig.n, `${sig.stops} stops for ${sig.n} points`);
  ok('playing, the wavefront moves', sig.moved, `${sig.seen} distinct positions in 2.4 s; ${sig.loop}`);
  ok('…as the whole wave, the height of the sky, with the Fresnel zone a stretch of it',
     sig.fronts.length > 0 && sig.fronts.every(([w, z]) => w > 0.95 * sig.ih && z < w),
     JSON.stringify({ ih: sig.ih, fronts: sig.fronts.slice(0, 4) }));
  ok('…not while the card is closed, and again when it is opened', sig.idleOff && sig.resumed,
     `idle ${sig.idleOff}, resumed ${sig.resumed}`);
  const fig = `${sig.rowAB > 0 ? '+' : ''}${sig.rowAB.toFixed(1)} dB`;
  ok('the cursor at B carries the fade margin, on the chart and on the map',
     sig.hoverEnd.tag.endsWith(` · ${fig}`)
       && sig.hoverEnd.map.includes(sig.rowAB >= 0 ? `signal ${fig} over B’s threshold` : `signal ${Math.abs(sig.rowAB).toFixed(1)} dB under B’s threshold`),
     JSON.stringify(sig.hoverEnd));
  ok('…and the figure where it is anywhere along the line, with the distance still last on the map',
     /^\d+ m · [-+]?\d+\.\d dB$/.test(sig.hoverMid.tag) && /· signal .* threshold · [\d.]+ km along$/.test(sig.hoverMid.map || ''),
     JSON.stringify(sig.hoverMid));
  ok('⏸ holds the run whole, still, says so, and is remembered',
     sig.stored === 'still' && sig.heldW >= sig.iw - 0.5 && sig.heldW === sig.heldW2
       && /arrives/.test(sig.tag) && /Play/.test(sig.btn),
     `${sig.stored}; ${sig.heldW} of ${sig.iw}; "${sig.tag}"; ${sig.btn}`);
}

// A clicked radio path makes the profile card the path's card. It was a card
// of its own heading the profile, and said the distance and the fade margin
// the readout under it said again, in a second box under a second heading. So
// now: the title says it is a radio path, the rows at the head of the card
// name the ends, the addresses and the channel, and the distance and the fade
// margin are said once — by the readout, which drops its Path row because the
// rows above it name the ends already. An obstruction the model has priced is
// said beside the figure rather than painted over it: a yes or no on the
// geometry, where the margin is the model's answer with the obstruction in it.
const pathCard = await page.evaluate(async ids => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const el = document.getElementById('path-profile-panel');
  const read = () => {
    const dt = [...el.querySelectorAll('.path-readout > .path-stats > div > dt')].find(x => x.textContent.trim() === 'Fade margin');
    const v = dt ? dt.nextElementSibling : null;
    const p = PathProfile.shownMargin();
    return {
      verdict: p ? p.verdict : null,
      fig: p ? `${p.margin > 0 ? '+' : ''}${p.margin.toFixed(1)} dB` : null,
      want: p ? `txt-${lbMarginClass(p.margin).cls}` : null,
      text: v ? v.textContent.replace(/\s+/g, ' ').trim() : null,
      cls: v && v.querySelector('span') ? v.querySelector('span').className : '',
    };
  };
  MapBackbone.open('field', ids[0], ids[1]);
  const until = Date.now() + 40000;
  while (Date.now() < until && !(PathProfile.shownMargin() && read().text)) await sleep(200);
  if (!PathProfile.shownMargin()) return null;
  const labels = sel => [...el.querySelectorAll(sel)].map(n => n.textContent.trim());
  const out = {
    title: (document.getElementById('path-card-title') || {}).textContent || '',
    inCard: !!el.querySelector('#path-card-title'),
    cards: document.querySelectorAll('#path-card').length,
    open: MapBackbone.current(),
    rows: labels('.path-card-rows .acma-row > span:first-child'),
    stats: labels('.path-readout > .path-stats > div > dt'),
    plain: read(),
  };
  // Low masts, for a path the ground cuts: the model prices the cut, and the
  // figure has to say it was priced in beside it rather than turn red.
  PathProfile.setRadio('A', 'agl_m', '0.5');
  PathProfile.setRadio('B', 'agl_m', '0.5');
  await sleep(100);
  out.low = read();
  PathProfile.setRadio('A', 'agl_m', '');
  PathProfile.setRadio('B', 'agl_m', '');
  await sleep(100);
  return out;
}, PAIR);
ok('a radio path makes the profile card the path\'s card, with no card of its own over it',
   !!pathCard && pathCard.title === 'Radio path' && pathCard.inCard && pathCard.cards === 0 && !!pathCard.open,
   JSON.stringify(pathCard && { title: pathCard.title, cards: pathCard.cards, open: pathCard.open }));
if (pathCard) {
  ok('…the ends, the addresses and the channel at its head',
     ['Field station', 'Repeater', 'Frequency'].every(l => pathCard.rows.includes(l))
       && pathCard.rows.some(l => /^ALERT ID/.test(l)), pathCard.rows.join(', '));
  ok('…the distance and the fade margin said once, by the readout, with no Path row under the ends',
     !pathCard.rows.includes('Distance') && !pathCard.rows.includes('Fade margin')
       && pathCard.stats.includes('Distance') && pathCard.stats.includes('Fade margin') && !pathCard.stats.includes('Path'),
     JSON.stringify({ rows: pathCard.rows, stats: pathCard.stats }));
  ok('…the profile\'s own figure, in the band\'s colour',
     !!pathCard.plain.text && pathCard.plain.text.startsWith(pathCard.plain.fig) && pathCard.plain.cls === pathCard.plain.want
       && pathCard.plain.want === marginRow.cls,
     JSON.stringify(pathCard.plain));
  const named = r => !!r.text && (r.verdict === 'obstructed') === / · line of sight obstructed, priced in · /.test(r.text)
    && r.cls === r.want;
  ok('…and an obstruction the model priced named beside the figure, in the figure\'s colour, not painted over it',
     named(pathCard.plain) && named(pathCard.low) && pathCard.low.verdict === 'obstructed',
     JSON.stringify({ plain: pathCard.plain, low: pathCard.low }));
}

// One set of radio figures behind every margin on the page. A TX power typed
// into the link budget used to be the budget's alone: the profile's margin, the
// signal along its line and the radio-path card over them (since folded into
// the profile card) all stayed on the radio systems, so the same hop read two
// ways a card apart. Each site now
// keeps one set (state.radio). Four times the TX power at the budget's A is
// +6.02 dB on the budget's margin and on the profile's, which is one way, A to
// B, the same way round; the profile's own TX box shows it, flagged edited,
// and B — the receiver — has no TX box to change nothing with; the card's
// readout quotes the new figure and the one way it was priced, with no way
// back beside it; and the signal arrives at B in the new figure. Typed into
// the profile's box instead, the budget's box and margin follow. Blank puts all
// of it back.
const shared = await page.evaluate(async () => {
  const L = state.link, sh = PathProfile.target();
  if (!L.a || !L.b || !sh || !sh.snappedTo) return null;
  const until = Date.now() + 40000;
  while (Date.now() < until && !PathProfile.signalState()) await new Promise(r => setTimeout(r, 200));
  // Which of the line's ends is the budget's A: fromProfile builds them the
  // same way round, and MapBackbone.open reused the line it drew above.
  const tagA = L.a.key === radioKey({ id: sh.snappedTo[0] }) ? 'A' : 'B';
  const flag = id => {
    const el = document.getElementById(id);
    const f = el && el.parentElement.querySelector('.path-src');
    return f ? f.textContent.trim() : null;
  };
  const read = () => {
    const p = PathProfile.shownMargin();
    const dt = [...document.querySelectorAll('#path-profile-panel .path-readout > .path-stats > div > dt')]
      .find(x => x.textContent.trim() === 'Fade margin');
    const sig = PathProfile.signalState();
    return {
      budget: LinkBudget.current().margin,
      prof: p ? p.margin : null,
      card: dt ? dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim() : null,
      sigEnd: sig ? sig.end : null,
      lbTx: document.getElementById('lb-f-a-tx_w').value,
      pathTx: (document.getElementById('path-f-A-tx_w') || {}).value,
      pathFlag: flag('path-f-A-tx_w'),
      pathTxB: !!document.getElementById('path-f-B-tx_w'),
    };
  };
  const base = L.a.def.tx_w;
  const before = read();
  LinkBudget.setField('a', 'tx_w', String(base * 4));
  const fromBudget = read();
  LinkBudget.setField('a', 'tx_w', '');
  PathProfile.setRadio(tagA, 'tx_w', String(base * 2));
  const fromProfile = read();
  PathProfile.setRadio(tagA, 'tx_w', '');
  return { base, tagA, before, fromBudget, fromProfile, after: read() };
});
ok('the budget and the profile are on the same two stations, the same way round',
   !!shared && shared.tagA === 'A', shared ? shared.tagA : String(shared));
if (shared && shared.tagA === 'A') {
  const { before: b0, fromBudget: fb, fromProfile: fp, after: af } = shared;
  const q = 10 * Math.log10(4), h = 10 * Math.log10(2);
  const near = (x, y) => x != null && y != null && Math.abs(x - y) < 0.01;
  ok('4× the TX power in the link budget is +6.02 dB on its own margin',
     near(fb.budget - b0.budget, q), `${b0.budget} → ${fb.budget}`);
  ok('…and on the profile\'s one-way margin, A to B',
     near(fb.prof - b0.prof, q), JSON.stringify({ b0, fb }));
  ok('…the profile\'s TX box shows the figure, flagged edited',
     Number(fb.pathTx) === shared.base * 4 && fb.pathFlag === 'edited', `${fb.pathTx} · ${fb.pathFlag}`);
  ok('…and B, the receiver, has no TX power box', !b0.pathTxB && !fb.pathTxB);
  const fig = m => `${m > 0 ? '+' : ''}${m.toFixed(1)} dB`;
  ok('…the card\'s readout quotes the new figure',
     !!fb.card && fb.card.startsWith(fig(fb.prof)) && !!b0.card && b0.card !== fb.card,
     `${b0.card} → ${fb.card} against ${fig(fb.prof)}`);
  ok('…naming the one way it was priced, with no way back beside it',
     !!fb.card && / → /.test(fb.card) && !/ back /.test(fb.card), fb.card);
  ok('…and the signal along the line arrives at B in the new margin',
     near(fb.sigEnd, fb.prof), `${fb.sigEnd} against ${fb.prof}`);
  ok('2× typed into the profile\'s box is +3.01 dB on the budget, its box showing it',
     near(fp.budget - b0.budget, h) && Number(fp.lbTx) === shared.base * 2, `${fp.lbTx} W, ${b0.budget} → ${fp.budget}`);
  ok('blanking the box puts every card back on the station\'s own figure',
     near(af.budget, b0.budget) && near(af.prof, b0.prof) && af.lbTx === b0.lbTx
       && af.pathTx === b0.pathTx && af.pathFlag !== 'edited', JSON.stringify(af));
}

// 📋 Copy for a report. What it carries is written from one list of rows, so
// it is held as rows: the fade margin the card quotes, a budget column that
// adds up to it term by term, the two ends where they are, every setting
// Radio Mobile asks for, and a picture for paper with no theme token left
// unresolved in it. Then the real press, read back off the clipboard: a
// document with the chart inside it as a picture, the same report as plain
// text, and the picture on its own.
const report = await page.evaluate(ids => {
  const r = PathProfile.report();
  const p = PathProfile.shownMargin();
  if (!r || !p) return null;
  const st = id => state.data.stations.find(s => s.id === id);
  const sh = PathProfile.target();
  const a = st(sh.snappedTo[0]), b = st(sh.snappedTo[sh.snappedTo.length - 1]);
  const terms = r.rows.budget.filter(x => !x[4] && x[0] !== 'RX threshold');
  const thr = r.rows.budget.find(x => x[0] === 'RX threshold');
  const pos = r.rows.ends.find(x => x[0] === 'Position (WGS84, decimal)');
  return {
    margin: p.margin, rowsMargin: r.rows.margin,
    sum: terms.reduce((t, x) => t + x[1], 0) - thr[1],
    result: r.rows.budget[r.rows.budget.length - 1],
    textFig: r.text.includes(`Fade margin: ${p.margin > 0 ? '+' : ''}${p.margin.toFixed(1)} dB`),
    heads: ['THE TWO ENDS', 'THE PATH', 'PROPAGATION MODEL AND SETTINGS', 'LINK BUDGET'].filter(h => !r.text.includes(h)),
    settings: ['Surface refractivity (N0)', 'Ground conductivity', 'Ground relative permittivity', 'Climate',
               'Polarization', 'Mode of variability', '% of time / locations / situations', 'Propagation mode']
      .filter(l => !r.rows.model.some(m => m[0] === l)),
    pos, wantA: `${a.lat.toFixed(6)}°, ${a.lon.toFixed(6)}°`, wantB: `${b.lat.toFixed(6)}°, ${b.lon.toFixed(6)}°`,
    radio: r.rows.radio.map(x => x[0]),
    svgVar: /var\(--/.test(r.svg || 'var(--'),
    svgNames: !!r.svg && r.svg.includes(esc(a.name)) && r.svg.includes(esc(b.name)),
    svgCursor: !!r.svg && /path-cursor|onmousemove/.test(r.svg),
    stillHover: (() => { PathProfile.hoverAt(100); return !!document.querySelector('#path-profile-panel #path-cursor:not([style*="none"])'); })(),
    file: r.rows.file,
    brief: {
      top: r.text.startsWith(r.brief.text),
      tables: /THE TWO ENDS|LINK BUDGET/.test(r.brief.text) || /<table|Link budget/.test(r.brief.html),
      margin: r.brief.html.includes('Fade margin:') && r.brief.html.includes('Line of sight:'),
    },
  };
}, PAIR);
ok('📋 the report quotes the card\'s fade margin', !!report && report.textFig && report.rowsMargin === report.margin,
   JSON.stringify(report && { margin: report.margin, rows: report.rowsMargin }));
if (report) {
  ok('…with a budget whose terms add up to it, term by term',
     Math.abs(report.sum - report.margin) < 0.01 && report.result[0] === 'Fade margin' && report.result[1] === report.margin,
     `${report.sum} against ${report.margin}`);
  ok('…the ends where they are, the radio path\'s rows, and every section',
     !!report.pos && report.pos[1] === report.wantA && report.pos[2] === report.wantB
       && report.radio.includes('Field station') && !report.heads.length,
     JSON.stringify({ pos: report.pos, radio: report.radio, missing: report.heads }));
  ok('…every propagation setting Radio Mobile asks for', !report.settings.length, `missing ${report.settings.join(', ')}`);
  ok('…a picture for paper in plain colours, the ends named on it, nothing of the screen\'s cursor in it',
     !report.svgVar && report.svgNames && !report.svgCursor, JSON.stringify(report));
  ok('…drawn without taking the cursor away from the chart on the card', report.stillHover);
  ok('…and a file name that says Flood-Net', /^floodnet-path-/.test(report.file), report.file);
  ok('📄 the summary is the report\'s top — the margin and the verdict, none of the tables',
     report.brief.top && report.brief.margin && !report.brief.tables, JSON.stringify(report.brief));
}
await page.evaluate(() => PathProfile.hoverOff());
await page.click('#path-copy');
const pasted = await page.evaluate(async () => {
  const until = Date.now() + 15000;
  let items = [];
  while (Date.now() < until) {
    try { items = await navigator.clipboard.read(); } catch (_) { items = []; }
    if (items.length && items[0].types.includes('text/html')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const it = items[0];
  if (!it) return null;
  const out = { types: it.types.slice() };
  if (it.types.includes('text/html')) {
    const h = await (await it.getType('text/html')).text();
    out.img = /<img[^>]+src="data:image\/png;base64,/.test(h);
    out.budget = /Link budget — how the fade margin is worked out/.test(h);
  }
  if (it.types.includes('text/plain')) out.text = (await (await it.getType('text/plain')).text()) === PathProfile.report().text;
  if (it.types.includes('image/png')) {
    const bmp = await createImageBitmap(await it.getType('image/png'));
    out.png = [bmp.width, bmp.height];
  }
  out.toast = [...document.querySelectorAll('.toast-text')].map(t => t.textContent).pop() || '';
  return out;
});
ok('the press puts a document, plain text and a picture on the clipboard',
   !!pasted && ['text/html', 'text/plain', 'image/png'].every(t => pasted.types.includes(t)), JSON.stringify(pasted));
if (pasted) {
  ok('…the document carrying the chart as a picture and the budget under it', pasted.img && pasted.budget, JSON.stringify(pasted));
  ok('…the text the report\'s own, and the picture drawn at twice its size',
     pasted.text && !!pasted.png && pasted.png[0] === 2400 && pasted.png[1] > 900, JSON.stringify(pasted));
  ok('…and says it did', /^Copied/.test(pasted.toast), pasted.toast);
}
// 📄 Copy a summary: the same three ways, the document stopping at the chart.
await page.click('#path-copy-brief');
const brief = await page.evaluate(async () => {
  const want = PathProfile.report().brief.text;
  const until = Date.now() + 15000;
  let it = null, text = '';
  while (Date.now() < until) {
    try { [it] = await navigator.clipboard.read(); } catch (_) { it = null; }
    text = it && it.types.includes('text/plain') ? await (await it.getType('text/plain')).text() : '';
    if (text === want && it.types.includes('text/html')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (!it) return null;
  const out = { types: it.types.slice(), text: text === want };
  if (it.types.includes('text/html')) {
    const h = await (await it.getType('text/html')).text();
    out.img = /<img[^>]+src="data:image\/png;base64,/.test(h);
    out.tables = /<table|Link budget/.test(h);
  }
  out.toast = [...document.querySelectorAll('.toast-text')].map(t => t.textContent).pop() || '';
  return out;
});
ok('📄 the summary press puts the summary\'s text, a document and the picture on the clipboard',
   !!brief && brief.text && ['text/html', 'text/plain', 'image/png'].every(t => brief.types.includes(t)), JSON.stringify(brief));
if (brief) {
  ok('…the document carrying the chart and no table under it', brief.img && !brief.tables, JSON.stringify(brief));
  ok('…and says what it copied', /^Copied: the fade margin/.test(brief.toast), brief.toast);
}

// Shown on asking: the cards carry the answer, and the explaining behind a
// click. The budget's answer block says the figure the corner chip says; the
// working, the profile's geometry and the chart's notes start shut, their
// words still in the page; and a disclosure opened stays open through the
// repaint a changed figure causes, then shuts when asked.
const more = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const d = id => document.querySelector(`[data-more="${id}"]`);
  const shut = ['lb-working', 'lb-model', 'path-figures', 'path-chart', 'path-heights'].map(id => [id, d(id) ? d(id).open : null]);
  const result = (document.querySelector('.lb-result-db') || {}).textContent;
  const chip = (document.getElementById('lb-margin-chip') || {}).textContent;
  const tableInPage = !!(d('lb-working') && d('lb-working').querySelector('.lb-table .lb-margin'));
  d('lb-working').open = true;
  await sleep(50);                         // toggle is dispatched a task later
  LinkBudget.setField('a', 'tx_w', '3');
  const kept = d('lb-working').open && state.link.more['lb-working'] === true;
  d('lb-working').open = false;
  await sleep(50);
  LinkBudget.setField('a', 'tx_w', '');
  return { shut, result, chip, tableInPage, kept, shutAgain: d('lb-working').open === false && !state.link.more['lb-working'] };
});
ok('the link budget\'s answer says the corner chip\'s figure', !!more.result && more.result === more.chip,
   `${more.result} against ${more.chip}`);
ok('…the working, the model note, the profile\'s geometry, the chart\'s notes and the datums start shut',
   more.shut.every(([, open]) => open === false), JSON.stringify(more.shut));
ok('…with the term-by-term table still in the page behind the working', more.tableInPage);
ok('a disclosure opened stays open through a repaint, and shuts when asked',
   more.kept && more.shutAgain, JSON.stringify(more));

// Full screen: the same chart, drawn again at the size the window gives it,
// with the readout over it — and only one chart in the page at a time, since
// its parts are found by id.
const fullView = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rowOf = root => {
    const dt = [...root.querySelectorAll('.path-stats dt')].find(x => x.textContent.trim() === 'Fade margin');
    return dt ? dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  const before = rowOf(document.getElementById('path-profile-panel'));
  const cardSvg = document.querySelector('#path-profile-panel svg.path-chart');
  const cardVbw = cardSvg ? cardSvg.viewBox.baseVal.width : 0;
  // Focused as a real click focuses it: the ⛶ pressed is the one focus has to
  // come back to, though the card's repaint replaces it as the view opens.
  const btn = document.getElementById('path-full-open');
  btn.focus();
  btn.click();
  await sleep(300);
  const host = document.getElementById('path-full');
  const svg = host && host.querySelector('svg.path-chart');
  const open = {
    full: PathProfile.isFull(),
    charts: document.querySelectorAll('svg.path-chart').length,
    inModal: !!svg,
    away: !!document.querySelector('#path-profile-panel .path-full-away'),
    vbw: svg ? svg.viewBox.baseVal.width : 0,
    cardVbw,
    shownW: svg ? svg.getBoundingClientRect().width : 0,
    title: (document.getElementById('app-modal-title') || {}).textContent || '',
    row: host ? rowOf(host) : null,
    sig: !!PathProfile.signalState() && !!host.querySelector('#path-sig-run'),
    flip: !!document.getElementById('path-full-flip'),
  };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(300);
  const shut = {
    full: PathProfile.isFull(),
    modal: !document.getElementById('path-full'),
    back: !!document.querySelector('#path-profile-panel svg.path-chart'),
    charts: document.querySelectorAll('svg.path-chart').length,
    focus: document.activeElement && document.activeElement.id,
  };
  return { before, open, shut };
});
ok('⛶ opens the chart full screen, the only chart in the page, the card saying where it went',
   fullView.open.full && fullView.open.inModal && fullView.open.charts === 1 && fullView.open.away,
   JSON.stringify(fullView.open));
ok('…drawn at the width it is shown at, wider than the card draws it',
   fullView.open.vbw > fullView.open.cardVbw && Math.abs(fullView.open.vbw - fullView.open.shownW) < 3,
   `${fullView.open.vbw} drawn, ${fullView.open.shownW.toFixed(0)} shown, ${fullView.open.cardVbw} on the card`);
ok('…with the readout\'s figures, the signal along the line and ⇄, named for its two ends',
   fullView.open.row === fullView.before && fullView.open.sig && fullView.open.flip
     && /Beenleigh/i.test(fullView.open.title) && /Carbrook/i.test(fullView.open.title),
   JSON.stringify({ title: fullView.open.title, row: fullView.open.row, before: fullView.before }));
ok('Escape puts it back on the card, focus on ⛶',
   !fullView.shut.full && fullView.shut.modal && fullView.shut.back && fullView.shut.charts === 1
     && fullView.shut.focus === 'path-full-open',
   JSON.stringify(fullView.shut));
await page.evaluate(() => MapBackbone.closeCard(false));

const noRadio = await page.evaluate(async () => {
  MapDraw.clearAll();
  MapDraw.addLine([[-27.50, 152.40], [-27.50, 152.50]], [null, null]);
  PathProfile.setOpen(true);
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const dt = [...document.querySelectorAll('#path-profile-panel .path-stats dt')]
      .find(x => x.textContent.trim() === 'Fade margin');
    if (dt) return { row: dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim(),
                     sig: (document.getElementById('path-sig-key') || {}).textContent || '',
                     layer: !!document.getElementById('path-sig-under') };
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
});
ok('two points on the ground get a stated reason, not a number',
   /both ends have to be stations/.test((noRadio || {}).row || ''), JSON.stringify(noRadio));
ok('…and no signal along the line, with the key saying why',
   !!noRadio && !noRadio.layer && /No signal drawn/.test(noRadio.sig), JSON.stringify(noRadio));
await page.evaluate(() => { MapDraw.clearAll(); PathProfile.setOpen(false); });

// ── 5. polar radio coverage ─────────────────────────────────────────────────
console.log('\nPolar radio coverage');

const panelUp = await page.evaluate(() => ({
  panel: !!document.querySelector('.mn-mapctl[data-panel="polar"]'),
  draw: !!document.getElementById('polar-draw'),
  legendOff: MapPolar.legend(),
}));
ok('the tool is a panel on the map', panelUp.panel && panelUp.draw);
ok('nothing is claimed in the legend before anything is drawn', panelUp.legendOff === null);

// A short range and a coarse step: the assertion is about the machinery, and a
// 50 km 1° plot is 11,520 model runs nobody needs to sit through here.
const drew = await page.evaluate(async () => {
  MapPolar.set('centre', 'station');
  MapPolar.pickCentre('beenleigh_al');
  MapPolar.set('rMaxKm', 12);
  MapPolar.set('azStep', 6);
  MapPolar.set('unit', 'dbm');
  MapPolar.set('fromDbm', -120);
  MapPolar.set('toDbm', -60);
  MapPolar.draw();
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (MapPolar.active()) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const img = document.querySelector('.leaflet-pane.leaflet-mnPolar-pane img');
  return {
    active: MapPolar.active(),
    src: img ? img.src.slice(0, 22) : null,
    len: img ? img.src.length : 0,
    status: (document.getElementById('polar-status') || {}).textContent.replace(/\s+/g, ' ').trim(),
    legend: MapPolar.legend(),
    key: /Polar radio coverage/.test(document.getElementById('map-legend')?.textContent || ''),
  };
});
ok('Draw produces an overlay', drew.active === true);
ok('…rendered as an image over the plot box', drew.src === 'data:image/png;base64,' && drew.len > 2000,
   `${drew.src} (${drew.len} bytes)`);
ok('…and says how it was computed', /radials? at .*range bands out to/.test(drew.status), drew.status.slice(0, 140));
ok('the key names both radios and the direction',
   !!drew.legend && drew.legend.centre === 'Beenleigh AL' && !!drew.legend.mobile && !!drew.legend.dir,
   JSON.stringify(drew.legend && { c: drew.legend.centre, m: drew.legend.mobile, d: drew.legend.dir }));
ok('…with twelve colours in it', !!drew.legend && drew.legend.colours.length === 12);
ok('the map legend carries it while it is drawn', drew.key === true);

// Radio Mobile's dialog saves the coverage data as well as drawing it, and a
// table is the half a picture cannot serve. Captured through
// URL.createObjectURL rather than through a real download, which is `drawkml`'s
// own trick for a file that is written by an anchor click.
const csv = await page.evaluate(async () => {
  let blob = null;
  const origU = URL.createObjectURL, origC = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = b => { blob = b; return 'blob:stub'; };
  HTMLAnchorElement.prototype.click = function () {};
  try { MapPolar.save(); }
  finally { URL.createObjectURL = origU; HTMLAnchorElement.prototype.click = origC; }
  return blob ? await blob.text() : null;
});
const csvLines = (csv || '').trim().split('\n');
const csvHead  = csvLines.filter(l => l.startsWith('#'));
const csvBody  = csvLines.filter(l => l && !l.startsWith('#') && !l.startsWith('azimuth_deg'));
ok('the plot saves its numbers as well as drawing them', csvBody.length > 100,
   `${csvBody.length} row(s)`);
ok('…under a header naming the run\'s own conditions',
   csvHead.some(l => l.includes('Beenleigh AL')) && csvHead.some(l => /frequency_mhz,151/.test(l))
   && csvHead.some(l => /no antenna patterns/.test(l)),
   csvHead.join(' | ').slice(0, 160));
ok('…with all four figures per cell, not just the one on screen',
   csvLines.some(l => l.startsWith('azimuth_deg,range_km,lat,lon,rx_dbm_centre_tx,'
     + 'margin_db_centre_tx,rx_dbm_centre_rx,margin_db_centre_rx')));
// Every row has to land inside the plot it claims to describe: eight columns,
// a range inside the radial range asked for, and a coordinate that measures
// back to that range from the centre.
const csvSane = await page.evaluate(rows => {
  let bad = 0, worstKm = 0;
  for (const r of rows) {
    const f = r.split(',');
    if (f.length !== 8) { bad++; continue; }
    const [az, km, lat, lon] = f.map(Number);
    if (!(az >= 0 && az < 360) || !(km > 0 && km <= 12.001)) { bad++; continue; }
    const d = acmaHaversineKm(-27.7258, 153.2192, lat, lon);
    worstKm = Math.max(worstKm, Math.abs(d - km));
  }
  return { bad, worstKm };
}, csvBody.slice(0, 400));
ok('…every row inside the plot it describes', csvSane.bad === 0, `${csvSane.bad} bad row(s)`);
ok('…and its coordinate measures back to its own range',
   csvSane.worstKm < 0.02, `worst ${csvSane.worstKm.toFixed(4)} km out`);

// Moving the threshold is a re-read of figures already in hand: the overlay
// has to change and the terrain must not be fetched again. That separation is
// the whole reason the levels are kept rather than the colours.
const before = tileHits;
const rebanded = await page.evaluate(async () => {
  const was = document.querySelector('.leaflet-pane.leaflet-mnPolar-pane img').src;
  MapPolar.set('toDbm', -80);
  await new Promise(r => setTimeout(r, 300));
  const now = document.querySelector('.leaflet-pane.leaflet-mnPolar-pane img');
  return { changed: !!now && now.src !== was, still: MapPolar.active() };
});
ok('a new threshold re-colours the plot', rebanded.changed && rebanded.still);
ok('…without fetching the terrain again', tileHits === before, `${tileHits - before} extra tile(s)`);

// …and a setting that changes what would be computed has to take the stale
// plot off the map rather than leave it there answering a different question.
const invalidated = await page.evaluate(async () => {
  MapPolar.set('rMaxKm', 25);
  await new Promise(r => setTimeout(r, 200));
  return { active: MapPolar.active(), legend: MapPolar.legend() };
});
ok('changing the range clears the plot it no longer describes',
   invalidated.active === false && invalidated.legend === null);

const refused = await page.evaluate(() => {
  MapPolar.set('rMaxKm', 0);
  const btn = document.getElementById('polar-draw');
  const status = () => (document.getElementById('polar-status') || {}).textContent.trim();
  MapPolar.draw();
  const said = status();
  MapPolar.set('rMaxKm', 12);
  return { said, disabled: !!btn && btn.disabled };
});
ok('a range that is not a range is refused with a reason, not drawn',
   /maximum radial range/i.test(refused.said), refused.said.slice(0, 100));

await page.evaluate(() => MapPolar.clear());

// ── the console ─────────────────────────────────────────────────────────────
ok('nothing threw', errors.length === 0, errors.join('\n         '));

await context.close();
await browser.close();
await server.close();

console.log(`\n  ${passes + failures} assertion(s), ${tileHits} terrain tile(s) served.`);
if (failures) {
  console.log(`\nFAIL — ${failures} of ${passes + failures}.`);
  process.exit(1);
}
console.log('\nPASS — the elevation ramp is the colour file\'s own, the peak finder returns\n'
  + '       peaks rather than one hilltop five times, a coordinate in the filter box\n'
  + '       moves the map with no network, the profile card carries a fade margin, and\n'
  + '       the polar plot draws, keys itself and re-bands without re-computing.');
