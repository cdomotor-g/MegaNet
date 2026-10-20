// MegaNet — mobile-signal.js
//
//   MobileSignal   the arithmetic of a mobile phone signal estimate: what a
//                  base station sector radiates per resource element, what its
//                  antenna gives away off boresight, what the ACMA's coverage
//                  map standard assumes about the phone, and how a level is
//                  graded good, moderate, basic or no coverage.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches into nothing, on purpose: test/mobile.mjs loads it into a bare Node
// VM beside itm.js, the way test/itm.mjs loads itm.js, so every figure the
// card prints can be held to a hand calculation. site-mobile.js does the
// fetching, the terrain, the propagation and the card; this file is only ever
// handed numbers.
//
// ── Where the numbers come from ──────────────────────────────────────────────
//
// The transmitters are the ACMA register's (tools/mobile_sectors.py →
// data/mobile/): one row per sector — carrier, band, frequency, azimuth,
// height, the antenna's horizontal beamwidth and front-to-back ratio, and the
// EIRP per resource element, `rs`. That last is the register's EIRP spread over
// the device's bandwidth (the tool's docstring has the formula), which is what
// RSRP is measured on.
//
// The phone, the grading and the 85% are the ACMA's Telecommunications (Mobile
// Network Coverage Maps) Industry Standard 2026, Schedule 1 — the rules every
// carrier's public map has been drawn to since 30 June 2026. Taken over whole,
// so "Moderate" here means the same level "Moderate" means on a carrier's map:
//
//   Table 1   good ≥ −95 dBm, moderate ≥ −105, basic ≥ −115, else no coverage
//             (RSRP for 4G, SS-RSRP for 5G — the same scale)
//   Table 2   the phone at 1.5 m, −3 dBi, 4 dB of body loss; 85% of locations
//             at the cell edge; lognormal fading of σ = 8 dB
//
// The 85% is a shift, not a second model: a level that is reached at 85% of
// locations is the median less z(0.85)·σ = 1.036 × 8 = 8.3 dB. The path loss
// site-mobile.js hands in is Longley–Rice's *median* (50/50/50), so the grade
// is taken 8.3 dB under it — and the card prints that graded level, so the
// number beside a grade is always on the right side of the grade's edge.
//
// ── What is assumed that the register does not say ──────────────────────────
//
//   * Two transmit ports (PORT_DB). RSRP is one port's reference signal; a 4G
//     or 5G sector transmits on two or more, and the register enters the
//     sector's EIRP. Two is the conservative count.
//   * No vertical pattern. The register carries no vertical beamwidth for any
//     mobile antenna and records 96% of tilts as 0, so a downtilt cannot be
//     priced. That flatters a point a few kilometres out by a few dB, and
//     barely matters past the first few kilometres, where the phone is
//     within a degree of the horizon either way.
//   * The horizontal pattern is 3GPP's parabola (TR 36.814): 12·(φ/φ3dB)² dB,
//     floored at the antenna's front-to-back ratio (25 dB where the register
//     has none). A sector with no beamwidth is an omni.
const MobileSignal = (function () {
  const STANDARD = {
    ref: 'Telecommunications (Mobile Network Coverage Maps) Industry Standard 2026 (F2026L00381), Schedule 1',
    url: 'https://www.legislation.gov.au/F2026L00381/latest/text',
    grades: [
      { key: 'good',     label: 'Good',        min: -95 },
      { key: 'moderate', label: 'Moderate',    min: -105 },
      { key: 'basic',    label: 'Basic',       min: -115 },
      { key: 'none',     label: 'No coverage', min: -Infinity },
    ],
    edgeProb: 0.85,
    sigmaDb: 8,
  };

  // z(0.85) — the standard normal quantile, so EDGE_DB is the 85% shift.
  // test/mobile.mjs holds it against ITM's own inverse.
  const Z_85 = 1.0364333894937898;
  const EDGE_DB = Z_85 * STANDARD.sigmaDb;

  const PORT_DB = 10 * Math.log10(2);
  const F2B_DEFAULT_DB = 25;

  // The two receivers a card shows. The handheld is the standard's phone,
  // to the decibel. The external antenna is this app's — a modem on a mast
  // at a station, or the antenna kit the carriers' "external antenna" maps
  // mean — and is said in full wherever it is shown, because nothing
  // standardises it.
  const RX = {
    handheld: { key: 'handheld', label: 'Handheld', hM: 1.5, gainDbi: -3, lossDb: 4,
                words: 'a phone outdoors at head height (1.5 m, −3 dBi, 4 dB body loss — the ACMA standard’s)' },
    external: { key: 'external', label: 'External antenna', hM: 5, gainDbi: 6, lossDb: 2,
                words: 'a 6 dBi antenna on a 5 m mast, with 2 dB of cable' },
  };

  // How far out a sector is considered. Past these a band is beyond what the
  // networks plan it for — 700/850/900 for the distance, the rest for
  // capacity — and pricing a profile for it only spends time on a sector
  // that cannot win. MAX_RANGE_KM is the widest, and the radius the cells
  // are fetched over.
  const MAX_RANGE_KM = 60;
  function rangeKm(fMhz) { return fMhz < 1000 ? 60 : fMhz < 3000 ? 35 : 15; }

  const CARRIERS = [
    { key: 'telstra', name: 'Telstra' },
    { key: 'optus',   name: 'Optus' },
    { key: 'tpg',     name: 'TPG (Vodafone)' },
  ];
  const OPTUS = 1, TPG = 2;
  const FLAG_MOCN = 1;

  // ── geometry, private — this file reaches into nothing ──

  const RAD = Math.PI / 180;

  function km(lat1, lon1, lat2, lon2) {
    const dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dl / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
    const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD)
            - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // ── the pieces ──

  // Loss off boresight, dB (positive). `offDeg` is the angle between where
  // the sector points and where the phone is, any sign, any number of turns.
  function patternDb(offDeg, hbw, f2b) {
    if (!(hbw > 0) || hbw >= 300) return 0;
    const a = Math.abs((((offDeg % 360) + 540) % 360) - 180);
    return Math.min(12 * (a / hbw) ** 2, f2b > 0 ? f2b : F2B_DEFAULT_DB);
  }

  function gradeOf(dbm) {
    if (!isFinite(dbm)) return STANDARD.grades[STANDARD.grades.length - 1];
    return STANDARD.grades.find(g => dbm >= g.min);
  }

  // Free space, dB, over d km at f MHz.
  function fsplDb(dKm, fMhz) { return 32.45 + 20 * Math.log10(fMhz) + 20 * Math.log10(Math.max(dKm, 0.001)); }

  // A ranking figure only — never printed. Free space at 1 km and 35 dB a
  // decade past it, which is near enough what rural terrain does to sort a
  // dozen sites into the order worth pricing properly. Longley–Rice decides.
  function coarseLossDb(dKm, fMhz) {
    return 32.45 + 20 * Math.log10(fMhz) + 35 * Math.log10(Math.max(dKm, 0.05));
  }

  // One sector's level at the phone, every term kept so the card can show
  // its working. `pathDb` is the median basic transmission loss over the
  // terrain; `clutterDb` what the cover round the phone takes on top.
  function level(sec, pathDb, clutterDb, rx, offDeg) {
    const pattern = patternDb(offDeg, sec.hbw, sec.f2b);
    const clutter = clutterDb > 0 ? clutterDb : 0;
    const median = sec.rs - PORT_DB - pattern - pathDb - clutter + rx.gainDbi - rx.lossDb;
    const graded = median - EDGE_DB;
    return { rs: sec.rs, port: PORT_DB, pattern, path: pathDb, clutter, gain: rx.gainDbi, loss: rx.lossDb,
             median, graded, grade: gradeOf(graded) };
  }

  // The cells (data/mobile/cells/<lat>_<lon>.json, 1° each, named for their
  // south-west corner) that a circle of rKm round a point touches — only those
  // the index says exist, so the sea and the empty middle cost no request.
  function cellsAround(lat, lon, rKm, have) {
    const dLat = rKm / 111.2;
    const dLon = rKm / (111.2 * Math.max(0.05, Math.cos(lat * RAD)));
    const out = [];
    for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++) {
      for (let lo = Math.floor(lon - dLon); lo <= Math.floor(lon + dLon); lo++) {
        const k = `${la}_${lo}`;
        if (!have || have[k]) out.push(k);
      }
    }
    return out;
  }

  // A cell row as an object: [c, band, f_mhz, az, h_m, hbw_deg, f2b_db, rs_dbm].
  function sectorOf(row) {
    return { c: row[0], band: row[1], f: row[2], az: row[3], h: row[4], hbw: row[5], f2b: row[6], rs: row[7] };
  }

  // The sites worth pricing, per carrier: the `perCarrier` sites whose best
  // sector ranks highest on the coarse figure, each with every one of that
  // carrier's sectors there. An Optus site the ACCC lists as shared with TPG
  // (the regional MOCN) is a TPG site as well, its sectors marked `via:
  // 'mocn'` so the card can say whose mast it is.
  //
  // sites: [[site_id, lat, lon, flags, [row, …]], …] as the cells hold them.
  // → [[candidate, …] for each carrier], each candidate
  //   { carrier, id, lat, lon, flags, dKm, brgFromSite, brgFromPoint, sectors, coarse }
  function candidates(sites, lat, lon, opt) {
    const per = (opt && opt.perCarrier) || 4;
    const range = (opt && opt.rangeKm) || rangeKm;
    const found = CARRIERS.map(() => new Map());
    for (const s of sites || []) {
      const [id, sLat, sLon, flags, rows] = s;
      const dKm = km(sLat, sLon, lat, lon);
      if (dKm > MAX_RANGE_KM) continue;
      const fromSite = bearing(sLat, sLon, lat, lon);
      for (const row of rows) {
        const sec = sectorOf(row);
        if (dKm > range(sec.f)) continue;
        const serves = [[sec.c, 'own']];
        if (sec.c === OPTUS && (flags & FLAG_MOCN)) serves.push([TPG, 'mocn']);
        const coarse = sec.rs - PORT_DB - patternDb(fromSite - sec.az, sec.hbw, sec.f2b) - coarseLossDb(dKm, sec.f);
        for (const [c, via] of serves) {
          let e = found[c].get(id);
          if (!e) {
            e = { carrier: c, id, lat: sLat, lon: sLon, flags, dKm,
                  brgFromSite: fromSite, brgFromPoint: bearing(lat, lon, sLat, sLon), sectors: [], coarse: -Infinity };
            found[c].set(id, e);
          }
          e.sectors.push({ ...sec, via });
          if (coarse > e.coarse) e.coarse = coarse;
        }
      }
    }
    return found.map(m => [...m.values()].sort((a, b) => b.coarse - a.coarse).slice(0, per));
  }

  // A terrain profile (Terrain.profile's shape) as ITM's PFL array:
  // [intervals, spacing_m, h0 … hn]. A missing sample holds the height before
  // it (the first valid one, at the start) — but a profile more than a quarter
  // missing is refused: a flat stretch reads as a clear path, and a clear
  // path is the one wrong answer that matters here.
  function pflOf(prof) {
    if (!prof || !prof.ok || !prof.terrain_m || prof.terrain_m.length < 2) return null;
    const t = prof.terrain_m;
    const n = t.length;
    let missing = 0, first = null;
    for (const h of t) { if (h == null) missing++; else if (first == null) first = h; }
    if (first == null || missing > n / 4) return null;
    const pfl = new Array(n + 2);
    pfl[0] = n - 1;
    pfl[1] = prof.totalKm * 1000 / (n - 1);
    let last = first;
    for (let i = 0; i < n; i++) { if (t[i] != null) last = t[i]; pfl[i + 2] = last; }
    return pfl;
  }

  // The best sector for each carrier out of a set of priced levels:
  // [{ carrier, rx, median, … }] → [best for carrier 0, 1, 2] (null if none).
  function bestPerCarrier(levels, rxKey) {
    const best = CARRIERS.map(() => null);
    for (const l of levels) {
      if (l.rx !== rxKey) continue;
      if (!best[l.carrier] || l.median > best[l.carrier].median) best[l.carrier] = l;
    }
    return best;
  }

  return {
    STANDARD, RX, CARRIERS, EDGE_DB, PORT_DB, MAX_RANGE_KM, FLAG_MOCN,
    rangeKm, patternDb, gradeOf, fsplDb, coarseLossDb, level, cellsAround, sectorOf,
    candidates, pflOf, bestPerCarrier, km, bearing,
  };
})();
if (typeof window !== 'undefined') window.MobileSignal = MobileSignal;
// test/mobile.mjs loads this file into a bare VM. Guarded so the browser,
// where `module` is undefined, never runs it.
if (typeof module !== 'undefined' && module.exports) module.exports = MobileSignal;
