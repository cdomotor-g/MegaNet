// The mobile signal estimate's arithmetic, and the register extract it reads.
//
// mobile-signal.js turns a sector out of the ACMA register and a path loss
// into a level at a phone, and grades it the way the ACMA's coverage map
// standard (F2026L00381, Schedule 1) grades. Every step has an answer on
// paper, so every step is held to one here: the standard's edges to the
// decibel, the 85% shift against ITM's own inverse normal, the antenna pattern
// at its half-power points and behind, a level assembled term by term, the
// cells a 60 km circle touches, which sites are worth pricing and for whom
// (TPG on an Optus site only where the ACCC lists it as shared), and a terrain
// profile turned into ITM's PFL — refused when too much of it is missing,
// because a flat stretch reads as a clear path.
//
// Then the data: data/mobile/index.json names exactly the cell files there
// are, and every row in them is the shape and range the card assumes; and
// data/coverage/index.json names exactly the tiles there are, each an 8-bit
// greyscale PNG of 9·v. Node only, no browser, about a second.
//
//   npm run mobile          (-- -v to list what passed)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const M = require(path.join(REPO_ROOT, 'mobile-signal.js'));
const ITM = require(path.join(REPO_ROOT, 'itm.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
let failures = 0, passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; if (VERBOSE) console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── The standard ─────────────────────────────────────────────────────────────
console.log('\nThe ACMA coverage map standard, Schedule 1');
const g = v => M.gradeOf(v).key;
check('−95 dBm is good (Table 1: ≥ −95)', g(-95) === 'good');
check('−95.01 dBm is moderate', g(-95.01) === 'moderate');
check('−105 dBm is moderate (≥ −105)', g(-105) === 'moderate');
check('−105.01 dBm is basic', g(-105.01) === 'basic');
check('−115 dBm is basic (≥ −115)', g(-115) === 'basic');
check('−115.01 dBm is no coverage', g(-115.01) === 'none');
check('no level at all is no coverage, not an error', g(-Infinity) === 'none' && g(NaN) === 'none');
check('the grades read as the standard words them',
  M.STANDARD.grades.map(x => x.label).join('|') === 'Good|Moderate|Basic|No coverage');
check('the phone is Table 2’s: 1.5 m, −3 dBi, 4 dB body loss',
  M.RX.handheld.hM === 1.5 && M.RX.handheld.gainDbi === -3 && M.RX.handheld.lossDb === 4);
check('85% at the edge with σ = 8 dB', M.STANDARD.edgeProb === 0.85 && M.STANDARD.sigmaDb === 8);
// ITM.qerfi is the inverse of the complementary normal — the same quantile,
// computed by the propagation model's own (Hastings) approximation, good to
// ~5e-4 in z.
const zItm = ITM.qerfi(0.15);
check('the 85% shift is z(0.85)·σ, against ITM’s own inverse normal',
  Math.abs(M.EDGE_DB - 8 * zItm) < 0.01 && near(M.EDGE_DB, 8.2915, 1e-3), `${M.EDGE_DB} vs ${8 * zItm}`);
check('two transmit ports are 3.01 dB', near(M.PORT_DB, 10 * Math.log10(2), 1e-12));

// ── The antenna ──────────────────────────────────────────────────────────────
console.log('The horizontal pattern');
check('nothing on boresight', M.patternDb(0, 65, 25) === 0);
check('3 dB at half the beamwidth either side', near(M.patternDb(32.5, 65, 25), 3) && near(M.patternDb(-32.5, 65, 25), 3));
check('floored at the front-to-back ratio behind', M.patternDb(180, 65, 28) === 28);
check('25 dB behind where the register has no front-to-back', M.patternDb(180, 65, 0) === 25);
check('angles wrap: 370° off is 10° off, −350° too',
  near(M.patternDb(370, 65, 25), M.patternDb(10, 65, 25)) && near(M.patternDb(-350, 65, 25), M.patternDb(10, 65, 25)));
check('no beamwidth is an omni', M.patternDb(120, 0, 25) === 0 && M.patternDb(120, 360, 25) === 0);

// ── A level, term by term ────────────────────────────────────────────────────
console.log('A level at the phone');
{
  const sec = { rs: 40, hbw: 65, f2b: 25 };
  const l = M.level(sec, 120, 0, M.RX.handheld, 0);
  const median = 40 - 10 * Math.log10(2) - 0 - 120 - 0 - 3 - 4;
  check('median = rs − ports − pattern − path − clutter + gain − body', near(l.median, median, 1e-9), `${l.median}`);
  check('graded 8.3 dB under it, and graded on that', near(l.graded, median - M.EDGE_DB, 1e-9) && l.grade.key === 'moderate');
  const off = M.level(sec, 120, 9, M.RX.handheld, 32.5);
  check('the pattern and the clutter come off it', near(off.median, median - 3 - 9, 1e-9));
  check('negative clutter is no clutter', near(M.level(sec, 120, -5, M.RX.handheld, 0).median, median, 1e-9));
  const x = M.level(sec, 120, 0, M.RX.external, 0);
  check('an external antenna gains its gain and loses no body', near(x.median - l.median, (6 - 2) - (-3 - 4), 1e-9));
}

// ── Cells ────────────────────────────────────────────────────────────────────
console.log('The cells a circle touches');
{
  // 60 km is 0.54° of latitude and 0.61° of longitude at 27.5° S: a point
  // mid-cell reaches past every edge of its own cell, so all nine.
  const ks = M.cellsAround(-27.5, 150.5, 60);
  check('60 km from mid-cell touches its own cell and the eight round it', ks.length === 9
    && ['-29_149', '-28_150', '-27_151'].every(k => ks.includes(k)), ks.join(' '));
  const only = M.cellsAround(-27.5, 150.5, 60, { '-28_150': 10 });
  check('only the cells the index has', only.length === 1 && only[0] === '-28_150');
  check('40 km from mid-cell stays inside it', M.cellsAround(-27.5, 150.5, 40).join() === '-28_150');
  check('the cell is named for its south-west corner, south of the equator too',
    M.cellsAround(-0.5, 0.5, 1).join() === '-1_0');
}

// ── Which sites are worth pricing ────────────────────────────────────────────
console.log('Candidates');
{
  const P = [-27.5, 150.5];
  // A site `km` from the point on bearing `brg` from the point.
  const at = (km, brg) => {
    const R = 6371.0088, d = km / R, t = brg * Math.PI / 180;
    const p1 = P[0] * Math.PI / 180, l1 = P[1] * Math.PI / 180;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, l2 * 180 / Math.PI];
  };
  const row = (c, band, f, az, rs) => [c, band, f, az, 30, 65, 25, rs];
  const north = at(10, 0), east = at(10, 90), far = at(70, 180), mid = at(20, 270);
  // North site's sectors face the point (south, 180°); east site's face away (east, 90°).
  const sites = [
    ['N', ...north, 0, [row(0, 700, 778, 180, 35), row(1, 900, 950, 180, 35)]],
    ['E', ...east, 0, [row(0, 700, 778, 90, 35)]],
    ['F', ...far, 0, [row(0, 700, 778, 0, 50)]],
    ['M', ...mid, 1, [row(1, 3500, 3600, 90, 50), row(1, 700, 778, 90, 30)]],
  ];
  const c = M.candidates(sites, P[0], P[1], { perCarrier: 4 });
  check('a site past 60 km is not considered', !c[0].some(x => x.id === 'F'));
  check('the site pointing at the point ranks above the one pointing away', c[0][0].id === 'N' && c[0][1].id === 'E');
  check('distance and bearing are the point’s', near(c[0][0].dKm, 10, 1e-6) && Math.round(c[0][0].brgFromPoint) === 0);
  const m = c[1].find(x => x.id === 'M');
  check('3.5 GHz is not considered past 15 km', m && m.sectors.every(s => s.band !== 3500));
  check('an Optus site the ACCC lists as shared serves TPG too, marked as such',
    c[2].length === 1 && c[2][0].id === 'M' && c[2][0].sectors.every(s => s.via === 'mocn'));
  check('an Optus site not listed does not', !c[2].some(x => x.id === 'N'));
  check('Optus’s own sectors are its own', c[1].every(x => x.sectors.every(s => s.via === 'own')));
  const one = M.candidates(sites, P[0], P[1], { perCarrier: 1 });
  check('at most perCarrier sites each', one[0].length === 1 && one[0][0].id === 'N');
}

// ── Profiles ─────────────────────────────────────────────────────────────────
console.log('A terrain profile as ITM’s PFL');
{
  const prof = { ok: true, totalKm: 3, terrain_m: [100, null, 120, 130] };
  const pfl = M.pflOf(prof);
  check('intervals, spacing, then heights with a gap held', pfl && pfl[0] === 3 && near(pfl[1], 1000)
    && pfl.slice(2).join() === '100,100,120,130', pfl && pfl.join());
  check('a leading gap takes the first height', M.pflOf({ ok: true, totalKm: 1, terrain_m: [null, 5, 6, 7, 8] })[2] === 5);
  check('more than a quarter missing is refused', M.pflOf({ ok: true, totalKm: 1, terrain_m: [1, null, null, 4, 5] }) === null);
  check('a failed profile is refused', M.pflOf({ ok: false, error: 'x' }) === null && M.pflOf(null) === null);
  // The composition the card runs: ITM's median over a flat 10 km, through level().
  const flat = M.pflOf({ ok: true, totalKm: 10, terrain_m: new Array(101).fill(50) });
  const r = ITM.pointToPoint({ pfl: flat, hTx: 30, hRx: 1.5, fMhz: 778, time: 50, location: 50, situation: 50 });
  check('ITM prices a 10 km flat path at 700 MHz', r.ok && r.A_db > M.fsplDb(10, 778) && r.A_db < M.fsplDb(10, 778) + 40,
    r.ok ? r.A_db.toFixed(1) : r.error);
}

// ── The best per carrier ─────────────────────────────────────────────────────
{
  const L = [
    { carrier: 0, rx: 'handheld', median: -100 }, { carrier: 0, rx: 'handheld', median: -90 },
    { carrier: 0, rx: 'external', median: -70 }, { carrier: 2, rx: 'handheld', median: -120 },
  ];
  const b = M.bestPerCarrier(L, 'handheld');
  check('the strongest sector per carrier, and null for a carrier with none',
    b[0].median === -90 && b[1] === null && b[2].median === -120);
}

// ── The committed extract ────────────────────────────────────────────────────
console.log('data/mobile/');
{
  const dir = path.join(REPO_ROOT, 'data', 'mobile');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const files = fs.readdirSync(path.join(dir, 'cells')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  const listed = Object.keys(index.cells).sort();
  check('the index names exactly the cell files there are', files.join() === listed.join(),
    `${files.length} files, ${listed.length} listed`);
  check('it carries the register’s attribution', /CC BY 4\.0/.test(index.meta.attribution || ''));
  const BANDS = { 700: [740, 810], 850: [860, 895], 900: [925, 965], 1800: [1800, 1885], 2100: [2100, 2175],
                  2300: [2290, 2410], 2600: [2610, 2700], 3500: [3300, 3850] };
  const per = [0, 0, 0];
  let bad = [], total = 0, sites = 0, mocnWithoutOptus = 0, outside = 0;
  for (const k of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'cells', `${k}.json`), 'utf8'));
    const [la, lo] = k.split('_').map(Number);
    if (d.cell[0] !== la || d.cell[1] !== lo) bad.push(`${k}: cell field ${d.cell}`);
    let n = 0;
    for (const [id, lat, lon, flags, rows] of d.sites) {
      sites++;
      if (Math.floor(lat) !== la || Math.floor(lon) !== lo) outside++;
      if ((flags & M.FLAG_MOCN) && !rows.some(r => r[0] === 1)) mocnWithoutOptus++;
      for (const r of rows) {
        n++;
        const [c, band, f, az, h, hbw, f2b, rs] = r;
        const br = BANDS[band];
        if (r.length !== 8 || !(c >= 0 && c <= 2) || !br || !(f >= br[0] && f < br[1]) || !(az >= 0 && az < 360)
            || !(h >= 0 && h < 1000) || !(hbw >= 0 && hbw < 300) || !(f2b >= 0 && f2b <= 100) || !(rs > -40 && rs < 60)) {
          if (bad.length < 5) bad.push(`${k} site ${id}: ${JSON.stringify(r)}`);
        }
        per[c]++;
      }
    }
    if (n !== index.cells[k] && bad.length < 5) bad.push(`${k}: ${n} sectors, index says ${index.cells[k]}`);
    total += n;
  }
  check('every row is [carrier, band, MHz in band, azimuth, height, beamwidth, F/B, rs] in range', !bad.length, bad.join('; '));
  check('every site is in the cell it is filed under', outside === 0, `${outside} misfiled`);
  check('only a site with Optus sectors is flagged as shared with TPG', mocnWithoutOptus === 0, `${mocnWithoutOptus}`);
  check('the counts add up', total === index.meta.counts.sectors && sites === index.meta.counts.sites
    && per.join() === index.meta.counts.per_carrier.join(), `${total} / ${sites} / ${per}`);
  check('all three carriers are there in numbers', per.every(n => n > 10000), per.join());
}

// ── The carriers' coverage tiles ─────────────────────────────────────────────
console.log('data/coverage/');
{
  const dir = path.join(REPO_ROOT, 'data', 'coverage');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const m = index.meta;
  check('the index dates the maps and carries the ACCC’s attribution',
    /^\d{4}-01-31$/.test(m.as_at) && /Australian Competition and Consumer Commission/.test(m.attribution)
      && /CC BY 2\.5 AU/.test(m.attribution), JSON.stringify([m.as_at, m.attribution]));
  check('it says how a pixel is read: 9·v, three carriers to a pixel', m.step === 9 && /9\*v/.test(m.encoding)
    && m.z_native >= m.z_min && m.box && m.box.w < m.box.e && m.box.s < m.box.n);
  const onDisk = [];
  for (const z of fs.readdirSync(dir).filter(d => /^\d+$/.test(d))) {
    for (const x of fs.readdirSync(path.join(dir, z))) {
      for (const f of fs.readdirSync(path.join(dir, z, x))) onDisk.push(`${z}/${x}_${f.replace(/\.png$/, '')}`);
    }
  }
  const listed = Object.entries(index.tiles).flatMap(([z, l]) => l.map(k => `${z}/${k}`));
  check('the index lists exactly the tiles there are', onDisk.sort().join() === listed.sort().join(),
    `${onDisk.length} on disk, ${listed.length} listed`);
  check('every zoom from the overviews to native has tiles',
    Array.from({ length: m.z_native - m.z_min + 1 }, (_, i) => String(m.z_min + i)).every(z => (index.tiles[z] || []).length > 0));
  check('the counts add up', m.tiles === listed.length, `${m.tiles} vs ${listed.length}`);
  // A native tile's pixels, decoded by hand: an 8-bit greyscale PNG, every
  // value a multiple of 9 no greater than 9 × 26.
  const z9 = index.tiles[String(m.z_native)];
  const [x, y] = z9[Math.floor(z9.length / 2)].split('_');
  const png = fs.readFileSync(path.join(dir, String(m.z_native), x, `${y}.png`));
  const ihdr = png.subarray(16, 29);
  check('a tile is 256 × 256, 8-bit greyscale', png.readUInt32BE(16) === 256 && png.readUInt32BE(20) === 256
    && ihdr[8] === 8 && ihdr[9] === 0, `${png.readUInt32BE(16)}×${png.readUInt32BE(20)} depth ${ihdr[8]} type ${ihdr[9]}`);
  const zlib = await import('node:zlib');
  let off = 8, idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // Undo the scanline filters (PNG §9) to read the greys themselves.
  const W = 256, px = Buffer.alloc(W * 256);
  for (let r = 0; r < 256; r++) {
    const f = raw[r * (W + 1)], src = raw.subarray(r * (W + 1) + 1, (r + 1) * (W + 1));
    for (let i = 0; i < W; i++) {
      const a = i ? px[r * W + i - 1] : 0, b = r ? px[(r - 1) * W + i] : 0, c = i && r ? px[(r - 1) * W + i - 1] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      px[r * W + i] = (src[i] + pred) & 0xff;
    }
  }
  const bad = [...px].filter(g => g % 9 || g > 9 * 26);
  check('every pixel is 9·v with v a three-carrier code', bad.length === 0, `${bad.length} odd greys, e.g. ${bad.slice(0, 3)}`);
  check('…and the tile has coverage on it', [...px].some(g => g > 0));
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
