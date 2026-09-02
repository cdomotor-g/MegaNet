// The profile with the ground cover on it, and the budget that prices it.
//
// Every other check in this directory sees the elevation profile and the link
// budget in their honest no-terrain state, because the harness blocks the tile
// server and the panels say so. That is right for them and blind for this: the
// land-cover band on the chart, the cover terms in the budget, the propagation
// model over the profile and the settings that drive it are all downstream of
// a profile that exists, and nothing above ever gets one.
//
// So this check builds the ground itself. The terrain tile server is answered
// from a PNG made here — one flat terrarium tile, 200 m everywhere — and the
// land-cover service is answered through LandCover.seed(), the module's own
// test seam. Flat ground under a 10 km hop with 4 m masts has nothing above
// the line (though at VHF it is well inside the first Fresnel zone, which is
// why it reads "marginal" and not "clear"); 15 m of trees on the middle of it
// is an obstruction the ground alone cannot see. That difference is the
// feature, and every assertion here is about it:
//
//   · with cover off nothing is above the line, with cover on the path is
//     obstructed BY COVER, and the chart draws the band that did it;
//   · the budget carries Terrain, Statistics and Ground-cover rows that add
//     up to the path loss, and the margin moves the right way when the trees
//     go in, when a terminal is put under them, and when a higher reliability
//     is asked for;
//   · the propagation settings on the card are the ones the model ran on;
//   · the cover-height table changes the profile, and the switch turns it off
//     with a warning rather than silently.
//
//   node --run pathcover      (or: npm run pathcover)
//       npm run pathcover -- -v    also print what passed

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

// ── a terrarium tile, made here ──────────────────────────────────────────────
// elevation = R·256 + G + B/256 − 32768, so 200 m is (128, 200, 0). One colour
// over the whole tile, deflated, wrapped in the four chunks a PNG needs.
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
function flatTerrariumPng(metres) {
  const v = metres + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v % 256), b = Math.round((v % 1) * 256);
  const W = 256, H = 256;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;                                  // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
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

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
// Registered after the policy, so it is asked first: the terrain server is
// answered with flat ground, and everything else off-origin stays blocked.
const tile = flatTerrariumPng(200);
await page.route(/elevation-tiles-prod\/terrarium\//, route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: tile,
                  headers: { 'Access-Control-Allow-Origin': '*' } }));
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// ── the hop ──────────────────────────────────────────────────────────────────
// Two hypothetical points 10 km apart on the flat tile — no station, so the
// antenna heights and radio systems are the card's own assumed figures and
// nothing in stations.json can move the numbers. The cover seed puts trees on
// the middle two fifths of the path and rangeland everywhere else; a second
// seed, switched in later, puts end A inside the trees as well.
const HOP = { latA: -27.50, lonA: 152.40, latB: -27.50, lonB: 152.50 };

await page.evaluate(({ latA, lonA, latB, lonB }) => {
  window.__coverMode = 'middle';
  LandCover.seed((lat, lon) => {
    const n = lat.length;
    const cls = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const inTrees = (t > 0.3 && t < 0.7) || (window.__coverMode === 'endA' && t < 0.05);
      cls.push(inTrees ? 2 : 11);
    }
    return cls;
  });
  state.path.cover = true;
  MapDraw.addLine([[latA, lonA], [latB, lonB]], [null, null]);
  PathProfile.setOpen(true);
  LinkBudget.fromProfile();
}, HOP);

const settled = () => page.waitForFunction(() => {
  const c = PathProfile.coverState();
  return c.status === 'ready' || c.status === 'failed' || c.status === 'off';
}, null, { timeout: LOAD_TIMEOUT });
await settled();
await page.waitForTimeout(200);

const read = () => page.evaluate(() => {
  const r = LinkBudget.current();
  const an = r && r.an;
  const svg = document.querySelector('#path-profile-panel svg');
  const bands = svg ? [...svg.querySelectorAll('path[fill^="var(--cover-"]')].map(p => p.getAttribute('fill')) : [];
  const keys = [...document.querySelectorAll('#path-profile-panel .path-key-cover')].map(i => i.parentElement.textContent.trim());
  const rows = [...document.querySelectorAll('.lb-table tbody tr')].map(tr => ({
    label: tr.querySelector('th').textContent.trim(),
    value: tr.querySelector('.lb-num').textContent.trim(),
  }));
  const readout = Object.fromEntries([...document.querySelectorAll('.lb-readout > div')]
    .map(d => [d.querySelector('dt').textContent.trim(), d.querySelector('dd').textContent.trim()]));
  return {
    cover: PathProfile.coverState().status,
    verdict: an ? an.verdict : null,
    coverUsed: an ? an.coverUsed : null,
    worstByCover: an && an.worst ? (an.worst.cover != null && an.worst.los - an.worst.bulged >= 0) : null,
    obstructions: an ? an.obstructions.map(o => ({ byCover: o.byCover, m: Math.round(-o.peak.clearance) })) : null,
    margin: r ? r.margin : null,
    fspl: r ? r.fspl : null, aref: r ? r.aref : null, avar: r ? r.avar : null,
    clutA: r ? r.clutA : null, clutB: r ? r.clutB : null, floor: r ? r.floor : null, pathLoss: r ? r.pathLoss : null,
    mode: r && r.itm ? r.itm.modeLabel : null,
    k: an ? an.k : null,
    bands, keys, rows, readout,
    verdictText: (document.querySelector('#path-profile-panel .path-verdict strong') || {}).textContent,
    status: (document.getElementById('path-cover-status') || {}).textContent || '',
    prop: { ...state.link.prop },
  };
});

console.log('\nThe cover on the profile');

let s = await read();
ok('the cover layer sampled the seeded classes', s.cover === 'ready', s.cover);
ok('the analysis ran with cover on', s.coverUsed === true);
ok('trees on flat ground under 4 m masts obstruct the path', s.verdict === 'obstructed', `${s.verdict} — ${s.verdictText}`);
ok('…and the worst point is cover, not ground', s.worstByCover === true);
ok('…and the obstruction list says so', !!s.obstructions && s.obstructions.length >= 1 && s.obstructions[0].byCover === true,
   JSON.stringify(s.obstructions));
ok('the chart draws a trees band', s.bands.includes('var(--cover-trees)'), s.bands.join(', '));
ok('…and a legend chip for each class on the path',
   s.keys.some(k => /Trees/.test(k)) && s.keys.some(k => /Rangeland/.test(k)), s.keys.join(' | '));
ok('the status line names the source', /Sentinel-2/.test(s.status), s.status.slice(0, 120));
ok('…and says the canopy map could not be had here, rather than nothing', /Canopy map unavailable/.test(s.status));

console.log('\nThe budget that prices it');

const label = (rows, re) => rows.find(r => re.test(r.label));
const num = t => Number(String(t).replace(/[^0-9.+-]/g, ''));
ok('the model ran and named its regime', !!s.mode, s.mode);
ok('the budget has a Terrain row', !!label(s.rows, /^Terrain$/));
ok('…a Statistics row', !!label(s.rows, /^Statistics$/));
ok('…and a Ground cover row for each end', s.rows.filter(r => /^Ground cover at/.test(r.label)).length === 2);
const withTrees = s;
ok('the path-loss subtotal is the sum of its rows',
   Math.abs(s.pathLoss - (s.fspl + s.aref + s.avar + s.clutA + s.clutB + s.floor)) < 1e-6,
   `${s.pathLoss} vs ${s.fspl}+${s.aref}+${s.avar}+${s.clutA}+${s.clutB}+${s.floor}`);
ok('…and the printed subtotal agrees', Math.abs(num(label(s.rows, /Path loss/).value) + s.pathLoss) < 0.01,
   `${label(s.rows, /Path loss/).value} vs ${s.pathLoss}`);
ok('neither terminal stands in the trees, so both cover rows are nought', s.clutA === 0 && s.clutB === 0);
ok('the readouts carry the propagation mode and Δh', /Line of sight|Diffraction/.test(s.readout['Propagation mode'] || '') && /m$/.test(s.readout['Terrain irregularity Δh'] || ''),
   JSON.stringify(s.readout));
// N_0 = 301 at sea level is k = 4/3; reduced to the surface at 200 m it is a
// little less — which is the point: the figure follows the path, not a constant.
ok('the earth curvature is the refractivity’s at the path’s own height', s.k > 1.30 && s.k < 1.333 && /k = 1\.3/.test(s.readout['Earth curvature'] || '') && /N.?s 29\d/.test(s.readout['Earth curvature'] || ''),
   s.readout['Earth curvature']);

// ── the switch ────────────────────────────────────────────────────────────────
await page.evaluate(() => PathProfile.setCover(false));
await page.waitForTimeout(150);
s = await read();
// Not "clear": two 4 m masts 10 km apart at VHF sit inside a 70 m first
// Fresnel zone whatever the ground does. But nothing is above the line.
ok('cover off: the same flat path is no longer obstructed', s.verdict === 'marginal' && s.coverUsed === false, s.verdict);
ok('…and nothing is above the line', s.obstructions.length === 0);
ok('…the chart draws no band', s.bands.length === 0);
ok('…the status says off, in warning colour', /Off/.test(s.status) && await page.evaluate(() => !!document.querySelector('#path-cover-status .txt-warn')));
ok('…and the budget says the cover is switched off rather than showing nought', s.rows.some(r => /Ground cover/.test(r.label) && r.value === '—'));
const bare = s;
// The two figures differ, and the model is allowed to say which way: over
// flat ground two low masts sit in a two-ray null that rough ground relieves,
// and 15 m of trees is what makes the ground rough to Longley–Rice. What the
// check holds is that the trees changed the Terrain row and nothing else.
ok('the trees changed the Terrain row', Math.abs(bare.aref - withTrees.aref) > 0.5,
   `${bare.aref.toFixed(1)} vs ${withTrees.aref.toFixed(1)} dB`);
ok('…and left free space alone', Math.abs(bare.fspl - withTrees.fspl) < 1e-9);
await page.evaluate(() => PathProfile.setCover(true));
await settled();
await page.waitForTimeout(150);

// ── a terminal under the trees ───────────────────────────────────────────────
await page.evaluate(() => { window.__coverMode = 'endA'; LandCover.clear(); PathProfile.refresh(); });
await page.waitForFunction(() => PathProfile.coverState().status === 'ready', null, { timeout: LOAD_TIMEOUT });
await page.waitForTimeout(200);
s = await read();
ok('end A in the trees: a terminal-clutter loss appears at A only', s.clutA > 0 && s.clutB === 0,
   `${s.clutA} / ${s.clutB}`);
ok('…of the order P.2108 gives a 4 m antenna under 15 m at VHF (10–20 dB)', s.clutA > 8 && s.clutA < 22, `${s.clutA.toFixed(1)} dB`);
ok('…and the row says the antenna is under the cover',
   /under 15 m of trees/.test((await page.evaluate(() => document.querySelector('.lb-table').textContent)) || ''));
// Moving the trees onto end A also puts a horizon a few hundred metres from
// it, so the Terrain row moves too; the margin falls by at least the terminal
// loss, and the printed row is the figure the sum used.
ok('…and the margin fell by at least that', (withTrees.margin - s.margin) > s.clutA - 0.01,
   `${withTrees.margin.toFixed(2)} → ${s.margin.toFixed(2)} vs ${s.clutA.toFixed(2)}`);
ok('…with the row printing the figure', Math.abs(num(label(s.rows, /Ground cover at/).value) + s.clutA) < 0.01);
const underTrees = s;

// ── the height table ─────────────────────────────────────────────────────────
await page.evaluate(() => PathProfile.setCoverHeight(2, 2));
await page.waitForTimeout(150);
s = await read();
ok('trees at 2 m: nothing reaches the 4 m line of sight', s.verdict !== 'obstructed' && s.obstructions.length === 0, s.verdict);
ok('…and no terminal loss either', s.clutA === 0);
ok('…and the table remembers the edit', await page.evaluate(() => LandCover.heightOf(2) === 2 && JSON.parse(localStorage.getItem('mn-cover-heights-v1'))['2'] === 2));
await page.evaluate(() => PathProfile.resetCoverHeights());
await page.waitForTimeout(150);
s = await read();
ok('reset puts the 15 m back', s.verdict === 'obstructed' && await page.evaluate(() => LandCover.heightOf(2) === 15));

console.log('\nThe propagation settings');

ok('the settings start from the Radio Mobile export’s figures',
   s.prop.climate === 2 && s.prop.N0 === 301 && s.prop.situation === 70 && s.prop.mdvar === 0, JSON.stringify(s.prop));
await page.evaluate(() => LinkBudget.setProp('situation', 95));
await page.waitForTimeout(150);
s = await read();
ok('asking for 95% of situations costs margin', s.margin < underTrees.margin, `${underTrees.margin.toFixed(1)} → ${s.margin.toFixed(1)} dB`);
ok('…and the Statistics row grew by the same amount', Math.abs((underTrees.margin - s.margin) - (s.avar - underTrees.avar)) < 1e-6);
const at95 = s;
await page.evaluate(() => LinkBudget.setProp('N0', 350));
await page.waitForTimeout(150);
s = await read();
ok('a wetter atmosphere bends the earth more', s.k > at95.k, `k ${at95.k.toFixed(3)} → ${s.k.toFixed(3)}`);
ok('…and the chart legend follows it', await page.evaluate(() => /k=1\.[4-9]/.test(document.querySelector('#path-profile-panel .path-key').textContent)));
await page.evaluate(() => LinkBudget.resetProp());
await page.waitForTimeout(150);
s = await read();
ok('reset returns to the network defaults', s.prop.N0 === 301 && s.prop.situation === 70 && Math.abs(s.margin - underTrees.margin) < 1e-6);
ok('in Spot mode the time and location boxes are disabled',
   await page.evaluate(() => document.getElementById('lb-prop-time').disabled && document.getElementById('lb-prop-location').disabled
                          && !document.getElementById('lb-prop-situation').disabled));
await page.evaluate(() => LinkBudget.setProp('mdvar', 3));
await page.waitForTimeout(150);
ok('in Broadcast mode all three are read',
   await page.evaluate(() => !document.getElementById('lb-prop-time').disabled && !document.getElementById('lb-prop-location').disabled));
await page.evaluate(() => LinkBudget.resetProp());

ok('nothing threw for the whole run', errors.length === 0, errors.join('\n         '));

await context.close();
await browser.close();
await server.close();

console.log(failures
  ? `\nFAIL — ${failures} of ${failures + passes} assertions about the profile’s cover and the budget over it.`
  : `\nPASS — ${passes} assertions: the cover stands on the profile, the chart draws it, the model prices it,\n`
    + '       and the settings that drive the model are the ones on the card.');
process.exit(failures ? 1 : 0);
