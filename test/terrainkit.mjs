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
//                        silent 52-degree error.
//   Fade margin          the profile card's new row: a figure where both ends
//                        are stations with radios, and a stated reason where
//                        they are not.
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

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// ── 1. the elevation base map ───────────────────────────────────────────────
console.log('\nThe elevation base map');

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
ok('Elevation is one of the shared base maps', ramp.names.includes('Elevation'),
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
  const panel = [...document.querySelectorAll('.mn-mapctl[data-panel="basemap"] input[type="radio"]')]
    .find(r => r.value === 'Elevation');
  if (!panel) return { picked: false };
  panel.checked = true;
  panel.dispatchEvent(new Event('change', { bubbles: true }));
  // Leaflet puts the tile element in the DOM before createTile has finished
  // with it, so "a canvas exists" is not "a canvas has been painted" — the
  // wait is for a pixel with something in it, on any of them.
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const cv = [...document.querySelectorAll('.mn-base-elev canvas.leaflet-tile')];
    for (const c of cv) {
      const d = c.getContext('2d').getImageData(4, 4, 1, 1).data;
      if (d[3] === 255) {
        return { picked: true, tiles: cv.length, px: [d[0], d[1], d[2], d[3]],
                 extraShown: !document.querySelector('.mn-base-elev-extra').hidden };
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const cv = document.querySelectorAll('.mn-base-elev canvas.leaflet-tile');
  return { picked: true, tiles: cv.length, px: null,
           extraShown: !document.querySelector('.mn-base-elev-extra').hidden };
});
ok('picking Elevation puts canvas tiles on the map', painted.tiles > 0, `${painted.tiles} tile(s)`);
ok('the tiles are painted, not blank', !!painted.px && painted.px[3] === 255,
   JSON.stringify(painted.px));
ok('its relief switch and key appear with it', painted.extraShown === true);

const relief = await page.evaluate(() => {
  MapElevation.setRelief(false);
  const off = localStorage.getItem('mn-elev-relief');
  MapElevation.setRelief(true);
  return { off, on: localStorage.getItem('mn-elev-relief'), now: MapElevation.relief() };
});
ok('the relief switch is remembered', relief.off === 'off' && relief.on === 'on' && relief.now === true,
   JSON.stringify(relief));

await page.evaluate(() => {
  const r = [...document.querySelectorAll('.mn-mapctl[data-panel="basemap"] input[type="radio"]')]
    .find(x => x.value === 'OSM-Topo');
  if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
});

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

// ── 3. places and coordinates in the filter box ─────────────────────────────
console.log('\nPlaces and coordinates in the filter box');

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

// Typed into the box, a coordinate has to move the map and drop a pin — with
// no network at all, which is the case a person standing beside a site is in.
const typed = await page.evaluate(async () => {
  setStationFiltersOpen(true);
  const box = document.getElementById('station-search-0');
  box.value = '-26.1234, 152.5678';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const c = state.map.getCenter();
  return {
    d: acmaHaversineKm(c.lat, c.lng, -26.1234, 152.5678),
    pin: document.querySelectorAll('.mn-place').length,
    strips: document.querySelectorAll('[data-mn-places] .search-places-in').length,
    strip: (document.querySelector('[data-mn-places="0"]') || {}).textContent || '',
  };
});
ok('a coordinate in the filter box takes the map there', typed.d < 0.2, `${typed.d.toFixed(3)} km off`);
ok('…and drops one pin', typed.pin === 1, `${typed.pin} pin(s)`);
ok('…and says so under the box, in both copies of it', typed.strips === 2, `${typed.strips}`);
ok('…naming the coordinate it read', typed.strip.includes('-26.1234, 152.5678'), typed.strip.trim().slice(0, 80));

// A place name with the gazetteer unreachable — which is what the network
// policy makes of it — must leave the station filter alone and say so.
const blocked = await page.evaluate(async () => {
  const box = document.getElementById('station-search-0');
  box.value = 'Gympie';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2600));
  return {
    strip: (document.querySelector('[data-mn-places="0"]') || {}).textContent || '',
    matched: computeFilteredStations().length,
  };
});
ok('a blocked gazetteer says so rather than throwing',
   /unavailable/i.test(blocked.strip), blocked.strip.trim().slice(0, 120));
ok('…and the station filter is untouched by it', blocked.matched > 0, `${blocked.matched} station(s)`);

await page.evaluate(() => { clearSearch(); });
ok('clearing the filter takes the place pin with it',
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
ok('…and quoting both directions', /A→B \/ B→A/.test(marginRow.text || ''), marginRow.text || '');

const noRadio = await page.evaluate(async () => {
  MapDraw.clearAll();
  MapDraw.addLine([[-27.50, 152.40], [-27.50, 152.50]], [null, null]);
  PathProfile.setOpen(true);
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const dt = [...document.querySelectorAll('#path-profile-panel .path-stats dt')]
      .find(x => x.textContent.trim() === 'Fade margin');
    if (dt) return dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
});
ok('two points on the ground get a stated reason, not a number',
   /both ends have to be stations/.test(noRadio || ''), String(noRadio));
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
