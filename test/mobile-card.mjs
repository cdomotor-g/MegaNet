// The mobile coverage section, in the page: on the What is here card and on a
// station's card (site-mobile.js).
//
// npm run mobile holds the arithmetic in Node. This holds what the page does
// with it, over ground and masts chosen here so every figure has an answer on
// paper:
//
//   · the terrain server answered with flat ground (200 m everywhere), and the
//     register answered with two invented masts — Telstra's 5 km north of the
//     point facing it, with a second behind the point facing away, and an
//     Optus site 8 km east the ACCC lists as shared with TPG;
//   · the Telstra row's level is the sum mobile-signal.js states, with
//     Longley–Rice run here in Node over the same flat profile — so a wrong
//     mast height, frequency, distance, antenna angle or receiver gets caught;
//     the trees the land cover puts at the point are charged as P.2108;
//   · TPG is served off Optus's shared mast and says so; the facing-away mast
//     never wins;
//   · a point with no mast within 60 km says so for every carrier, and plans on
//     no signal; a point whose terrain will not come says it could not be
//     estimated — never "no coverage" — and Try again recovers it;
//   · each carrier's own map is read off a coverage tile made here (Telstra
//     outdoors, Optus external antenna only, TPG none) and set under its row,
//     and a disagreement with the estimate is said;
//   · the coverage layer, off until asked, paints that tile per carrier in the
//     key's colours and asks for no tile its index does not list;
//   · a real station's card carries the section under its road section, off the
//     real register extract.
//
//   npm run mobilecard          (-- -v to list what passed)

import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { flatTerrariumPng } from './lib/terrarium.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const ITM = require(path.join(REPO_ROOT, 'itm.js'));
const M = require(path.join(REPO_ROOT, 'mobile-signal.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
let failures = 0, passes = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
};

// A point `km` from (lat, lon) on bearing `brg`.
function dest(lat, lon, brg, km) {
  const R = 6371.0088, d = km / R, t = brg * Math.PI / 180;
  const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [+(p2 * 180 / Math.PI).toFixed(5), +(l2 * 180 / Math.PI).toFixed(5)];
}

// A 256×256 8-bit greyscale PNG, every pixel `grey` — a coverage tile.
function greyPng(grey) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((256 + 1) * 256);
  for (let y = 0; y < 256; y++) raw.fill(grey, y * 257 + 1, (y + 1) * 257);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The z9 tile over a point.
function tileOf(lat, lon, z) {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [Math.floor((lon + 180) / 360 * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)];
}

// ── The invented register ────────────────────────────────────────────────────
const P = [-27.5, 152.45];
const T = dest(...P, 0, 5);        // Telstra, north, facing the point
const B = dest(...P, 180, 3);      // Telstra, south, facing away
const O = dest(...P, 90, 8);       // Optus, east, facing the point, shared with TPG
const SEC = (c, band, f, az, h, rs) => [c, band, f, az, h, 65, 25, rs];
const CELL = {
  cell: [-28, 152],
  sites: [
    ['T1', ...T, 0, [SEC(0, 700, 778, 180, 40, 38)]],
    ['T2', ...B, 0, [SEC(0, 700, 778, 180, 40, 40)]],
    ['O1', ...O, 1, [SEC(1, 900, 947.5, 270, 30, 43), SEC(1, 900, 947.5, 90, 30, 43)]],
  ],
};
const INDEX = { meta: { source_date: '2026-10-20', attribution: 'test' }, cells: { '-28_152': 4 } };

// ── The invented coverage maps ───────────────────────────────────────────────
// One z9 tile over the point, every pixel v = 2 + 3·1 + 9·0: Telstra covered
// outdoors, Optus with an external antenna only, TPG not at all — written 9·v,
// as tools/coverage_tiles.py writes it.
const [CX, CY] = tileOf(...P, 9);
const COVER_INDEX = {
  meta: { as_at: '2026-01-31', year: 2026, z_native: 9, z_min: 3, step: 9,
          box: { w: 112, e: 154.5, n: -9, s: -44.5 }, attribution: 'Mobile coverage: test' },
  tiles: { 9: [`${CX}_${CY}`] },
};
const COVER_TILE = greyPng(9 * (2 + 3 * 1 + 9 * 0));

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
await applyNetworkPolicy(page, server.origin);
let terrainUp = true;
const tile = flatTerrariumPng(200);
await page.route(/elevation-tiles-prod\/terrarium\//, route => (terrainUp
  ? route.fulfill({ status: 200, contentType: 'image/png', body: tile, headers: { 'Access-Control-Allow-Origin': '*' } })
  : route.fulfill({ status: 503, body: '' })));
const stubRegister = async route => {
  const u = new URL(route.request().url());
  if (u.pathname.endsWith('/data/mobile/index.json')) return route.fulfill({ json: INDEX });
  if (u.pathname.endsWith('/data/mobile/cells/-28_152.json')) return route.fulfill({ json: CELL });
  return route.fulfill({ status: 404, body: '' });
};
await page.route(/\/data\/mobile\//, stubRegister);
const coverAsked = [];
const stubCoverage = async route => {
  const u = new URL(route.request().url());
  coverAsked.push(u.pathname);
  if (u.pathname.endsWith('/data/coverage/index.json')) return route.fulfill({ json: COVER_INDEX });
  if (u.pathname.endsWith(`/data/coverage/9/${CX}/${CY}.png`)) {
    return route.fulfill({ status: 200, contentType: 'image/png', body: COVER_TILE });
  }
  return route.fulfill({ status: 404, body: '' });
};
await page.route(/\/data\/coverage\//, stubCoverage);
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
// Trees at every point asked about: the clutter the phone pays.
await page.evaluate(() => LandCover.seed(lat => lat.map(() => 2)));

async function pick(lat, lon) {
  await page.evaluate(([a, b]) => { MapHere.arm(true); MapHere.pick(a, b); }, [lat, lon]);
  return settle('mn-mobile-here');
}

async function settle(id) {
  await page.waitForFunction(id => {
    const el = document.getElementById(id);
    const g = el && el.querySelector('.stn-card-mobile');
    return g && !g.hasAttribute('aria-busy');
  }, id, { timeout: 30_000 });
  return page.evaluate(id => {
    const el = document.getElementById(id);
    const rows = {};
    for (const r of el.querySelectorAll('.acma-row')) {
      const [k, v] = r.children;
      rows[k.textContent.trim()] = v.innerText.replace(/\s+/g, ' ').trim();
    }
    return {
      rows, key: el.dataset.mnMobile,
      grades: [...el.querySelectorAll('.mn-mob-grade')].map(g => g.textContent),
      items: [...el.querySelectorAll('.stn-card-exp-sum li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
      workings: [...el.querySelectorAll('details')].map(d => d.textContent.replace(/\s+/g, ' ').trim()),
      retry: !!el.querySelector('.stn-card-exp-retry'),
    };
  }, id);
}

try {
  // ── Near the masts ─────────────────────────────────────────────────────────
  if (VERBOSE) console.log('\nWhat is here, between the invented masts');
  const a = await pick(...P);
  check('the section is keyed by the point to five places', a.key === `${P[0].toFixed(5)},${P[1].toFixed(5)}`, a.key);
  check('a row for each carrier', ['Telstra', 'Optus', 'TPG (Vodafone)'].every(k => k in a.rows), JSON.stringify(a.rows));

  // Telstra by hand: the mast facing the point, Longley–Rice over the same
  // flat profile the page built, the trees at the point charged as P.2108.
  const want = await page.evaluate(([t, p]) => {
    const prop = pathPropOf({});
    const R = LandCover.heights([2], null)[0];
    return { prop, clutter: terminalClutterDb(1.5, R, 778), dKm: MobileSignal.km(t[0], t[1], p[0], p[1]) };
  }, [T, P]);
  const n = Math.max(32, Math.min(600, Math.ceil(want.dKm * 10) + 1));
  const pfl = [n - 1, want.dKm * 1000 / (n - 1), ...new Array(n).fill(200)];
  const itm = ITM.pointToPoint({ pfl, hTx: 40, hRx: 1.5, fMhz: 778, climate: want.prop.climate, N0: want.prop.N0,
    pol: want.prop.pol, epsilon: want.prop.epsilon, sigma: want.prop.sigma, mdvar: want.prop.mdvar,
    time: 50, location: 50, situation: 50 });
  const lvl = M.level({ rs: 38, hbw: 65, f2b: 25 }, itm.A_db, want.clutter, M.RX.handheld, 0);
  const shown = `${lvl.graded < 0 ? '−' : ''}${Math.abs(Math.round(lvl.graded))} dBm`;
  check('Telstra’s level is the sum on paper — mast, band, distance, angle, phone, trees',
    a.rows.Telstra.startsWith(`${lvl.grade.label} ${shown}`), `${a.rows.Telstra} vs ${lvl.grade.label} ${shown}`);
  check('…from the mast facing the point, 5 km north, on 700 MHz', /700 MHz · 5\.00 km N\b/.test(a.rows.Telstra), a.rows.Telstra);
  check('the trees at the point are charged, and the workings say so',
    want.clutter > 0 && a.workings.some(w => /P\.2108/.test(w) && /Cover at the point: Trees/i.test(w)), a.workings[0]);
  check('the workings carry the median and the 85% shift',
    a.workings.some(w => /median; − 8\.3 for 85% of locations/.test(w)));
  check('every row has an external-antenna line', ['Telstra', 'Optus', 'TPG (Vodafone)'].every(k => /external antenna:/.test(a.rows[k])));
  check('TPG is served off Optus’s shared mast, and says so', /Optus’s mast, shared/.test(a.rows['TPG (Vodafone)'])
    && /8\.00 km E\b/.test(a.rows['TPG (Vodafone)']), a.rows['TPG (Vodafone)']);
  check('Optus’s own row is its own mast, not called shared', !/shared/.test(a.rows.Optus), a.rows.Optus);
  check('every grade is one of the standard’s four words',
    a.grades.length >= 3 && a.grades.every(g => ['Good', 'Moderate', 'Basic', 'No coverage'].includes(g)), a.grades.join());
  check('the summary names who reaches, and links all three carriers’ own maps',
    a.items.some(t => /^A phone here should get /.test(t)) && a.items.some(t => /Telstra’s coverage map/.test(t)
      && /Optus’s coverage map/.test(t) && /Vodafone’s \(TPG’s\) coverage checker/.test(t)), JSON.stringify(a.items));
  check('each carrier’s own map is read off the coverage tile at the point',
    /its own map \(2026\): covered outdoors/.test(a.rows.Telstra)
      && /its own map \(2026\): external antenna only/.test(a.rows.Optus)
      && /its own map \(2026\): not covered/.test(a.rows['TPG (Vodafone)']),
    JSON.stringify([a.rows.Telstra, a.rows.Optus, a.rows['TPG (Vodafone)']]));
  const tpgReaches = !/^No coverage/.test(a.rows['TPG (Vodafone)']);
  check('where the estimate and a carrier’s map disagree, the summary says so and names it',
    !tpgReaches || a.items.some(t => /TPG \(Vodafone\)’s own map disagree/.test(t)), JSON.stringify(a.items));
  check('the sources name the register, the ACCC’s shared-site list and the standard',
    a.workings.some(w => /Register of Radiocommunications Licences/.test(w) && /MOCN/.test(w) && /F2026L00381|Industry Standard 2026/.test(w)));

  // ── The coverage layer ────────────────────────────────────────────────────
  if (VERBOSE) console.log('The coverage layer');
  const before = coverAsked.length;
  check('the layer is off on a cold load, and claims no legend key',
    await page.evaluate(() => state.mapMobileCov === false && !MapMobileCoverage.active()));
  check('…and its note says so', await page.evaluate(() => /^Off\./.test(MapMobileCoverage.noteHtml())));
  await page.evaluate(([lat, lon]) => { MapHere.close(); state.map.setView([lat, lon], 9, { animate: false });
    MapMobileCoverage.setCarrier('telstra'); MapMobileCoverage.setEnabled(true); }, P);
  const painted = async () => page.waitForFunction(() => {
    const pane = state.map.getPane('mnMobileCov');
    const cvs = pane ? [...pane.querySelectorAll('canvas')] : [];
    return cvs.length > 0;
  }, null, { timeout: 15_000 }).then(() => page.waitForTimeout(400)).then(() => page.evaluate(() => {
    const seen = new Set();
    for (const cv of state.map.getPane('mnMobileCov').querySelectorAll('canvas')) {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i]) seen.add(`${d[i - 3]},${d[i - 2]},${d[i - 1]}`);
    }
    return [...seen];
  }));
  const tel = await painted();
  check('on, it puts a layer in its own pane, above the elevation coverage and under the contours',
    await page.evaluate(() => MapMobileCoverage.active()
      && Number(getComputedStyle(state.map.getPane('mnMobileCov')).zIndex) === 248));
  check('Telstra’s tile paints the outdoor green, and nothing else', tel.length === 1 && tel[0] === '31,157,85', tel.join(' | '));
  await page.evaluate(() => MapMobileCoverage.setCarrier('optus'));
  const opt = await painted();
  check('Optus’s, off the same tile, paints the external-antenna amber', opt.length === 1 && opt[0] === '224,161,0', opt.join(' | '));
  await page.evaluate(() => MapMobileCoverage.setCarrier('tpg'));
  const tpg = await painted();
  check('TPG’s paints nothing — the tile says none', tpg.length === 0, tpg.join(' | '));
  await page.evaluate(() => MapMobileCoverage.setCarrier('any'));
  const any = await painted();
  check('the best of the three is Telstra’s outdoor', any.length === 1 && any[0] === '31,157,85', any.join(' | '));
  const ui = await page.evaluate(() => ({
    legend: MapMobileCoverage.legendHtml(),
    controls: MapMobileCoverage.controlsHtml(), carrier: localStorage.getItem('mn-mobile-cov-carrier'),
  }));
  check('the panel offers the carrier and the opacity, with the key', /<select/.test(ui.controls)
    && /Coverage opacity/.test(ui.controls) && /Outdoor — a phone in the hand/.test(ui.controls)
    && /External antenna only/.test(ui.controls));
  check('the carrier picked is remembered', ui.carrier === 'any', String(ui.carrier));
  check('the legend keys both levels and dates the map', /4G — outdoor/.test(ui.legend)
    && /external antenna only/.test(ui.legend) && /31 January 2026/.test(ui.legend), ui.legend);
  check('only tiles the index lists are asked for',
    coverAsked.slice(before).every(p => /index\.json$/.test(p) || p.endsWith(`/9/${CX}/${CY}.png`)),
    coverAsked.slice(before).filter(p => !/index\.json$/.test(p)).slice(0, 4).join(' '));
  await page.evaluate(() => MapMobileCoverage.setEnabled(false));
  check('off again takes the layer away', await page.evaluate(() => !MapMobileCoverage.active()
    && !state.map.getPane('mnMobileCov').querySelector('canvas')));

  // ── Nowhere near a mast ───────────────────────────────────────────────────
  if (VERBOSE) console.log('Far from every mast');
  const far = await pick(-25.5, 140.5);
  check('every carrier: no coverage, no transmitter within 60 km',
    ['Telstra', 'Optus', 'TPG (Vodafone)'].every(k => /^No coverage no transmitter registered within 60 km/.test(far.rows[k])),
    JSON.stringify(far.rows));
  check('…and the summary plans on no signal', far.items.some(t => /plan on no mobile signal/.test(t)), JSON.stringify(far.items));

  // ── Terrain that will not come ────────────────────────────────────────────
  if (VERBOSE) console.log('Terrain unavailable');
  terrainUp = false;
  const Q = dest(...P, 270, 4);          // a new point, so no tile it needs is cached
  await page.evaluate(() => Terrain.clear());
  const down = await pick(...Q);
  check('no terrain is "could not be estimated", never "no coverage"',
    /^could not be estimated — the terrain between here and the masts could not be read/.test(down.rows.Signal || '')
      && !down.grades.length, JSON.stringify(down.rows));
  check('…with a Try again', down.retry);
  terrainUp = true;
  await page.evaluate(() => { Terrain.clear(); document.querySelector('#mn-mobile-here .stn-card-exp-retry').click(); });
  const back = await settle('mn-mobile-here');
  check('Try again prices it once the terrain answers', /^(Good|Moderate|Basic|No coverage) −\d+ dBm/.test(back.rows.Telstra || ''),
    JSON.stringify(back.rows));

  // ── A real station, off the real register ─────────────────────────────────
  if (VERBOSE) console.log('A station card');
  await page.unroute(/\/data\/mobile\//, stubRegister);
  await page.evaluate(() => { SiteMobile.clear(); MapHere.close(); showStationCard('loudoun_br_al'); });
  const s = await settle('mn-mobile-card-loudoun_br_al');
  check('the station card carries the section, under the road section', await page.evaluate(() => {
    const el = document.getElementById('mn-mobile-card-loudoun_br_al');
    return !!el && el.previousElementSibling && el.previousElementSibling.id === 'mn-roads-card-loudoun_br_al';
  }));
  check('…priced off the real register: a grade for each carrier',
    ['Telstra', 'Optus', 'TPG (Vodafone)'].every(k => /^(Good|Moderate|Basic|No coverage)\b/.test(s.rows[k] || '')),
    JSON.stringify(s.rows));

  check('nothing threw', !errors.length, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`  ✗ the check itself failed — ${e && e.stack || e}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n  ${passes + failures} assertion(s).`);
console.log(failures
  ? `\nFAIL — ${failures} assertion(s).`
  : '\nPASS — the mobile section prices the masts it is given, says whose they are, and never calls a failure no coverage.');
process.exit(failures ? 1 : 0);
