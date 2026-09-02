// MegaNet — path-profile.js
//
//   PathProfile   the elevation-profile card on the Stations map: the ground
//                 between two points, what stands on it, and the Fresnel zone
//                 over it.
//   the path      fresnelR1, earthBulge, fresnelV, knifeEdgeDb, fsplDb,
//   physics       wattsToDbm, rmSystemOf, kFactorFor, terminalClutterDb,
//                 pathAnalyse, PATH_VERDICT and the PATH_* constants. Shared
//                 with link-budget.js and map-los.js, which is why they travel
//                 with this file rather than with the budget.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm and RM_NET_DEFAULTS;
// sideways to terrain.js for Terrain, land-cover.js for LandCover, itm.js for
// ITM, map-draw.js for MapDraw and link-budget.js for LinkBudget.
//
// #134 flagged the PathProfile <-> LinkBudget pair as an ordering constraint to
// settle before either could move. Settled by asking what each IIFE *executes*
// rather than what it references: across the whole of app.js, all 448 top-level
// statements were declarations, four window.X exports and one sessionStorage
// read. Neither of these two calls the other at load, so the order of the two
// files is free — the same answer M2 got for Alert2 <-> Serial, for the same
// reason: init.js is still the only thing that runs.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129. The physics was then
// rebuilt on the Longley–Rice model and the land-cover layer — see pathAnalyse.

// ── Path physics ─────────────────────────────────────────────────────────────
// The maths shared by the elevation profile, the link budget and the map's
// line-of-sight layer. Deliberately visible: every term below turns up as its
// own line in the budget table, because a single predicted number is exactly
// the thing this feature must not become.
//
// Two pictures of the same hop live here, and both are drawn from one call:
//
//   the GEOMETRY — a straight line of sight from antenna to antenna, the earth
//   bulging up under it by d1·d2/(2ka), the 60% first-Fresnel envelope, and
//   whatever stands on the ground (terrain plus the land cover's representative
//   height) intruding into that envelope. This is what the chart shows and what
//   "clear / marginal / obstructed" is read off.
//
//   the LOSS — Longley–Rice (ITM) point-to-point over the same profile, which
//   is what Radio Mobile computes: free space, the reference attenuation for
//   the regime the path is in, the climate's median shift and the variability
//   allowances for the percentages asked. Plus, at each end, ITU-R P.2108's
//   terminal-clutter loss when the antenna stands *below* the cover around it
//   — the case a 4 m field station in 15 m of trees is in, and one the
//   profile alone cannot express because the antenna sits on the ground line.
//
// The land cover enters the profile the way P.1812 §3.2 says and the way Radio
// Mobile's Land cover layer does: the representative height is stood on the
// terrain at every interior sample, and NOT at the two ends — the ends are
// handled by the terminal-clutter term instead, so a canopy is not counted
// twice, once as a knife edge in the profile and once as a loss at the mast.

const PATH_DEFAULT_MHZ = 151.5;   // the network's own VHF band — RM_NET_DEFAULTS is 151–152
const PATH_DEFAULT_AGL = 4;       // m, the Field Station 1W antenna height in rm_systems
// The radius ITM itself uses (a_0 in the reference), so the chart's bulge and
// the model's horizons are the same earth.
const EARTH_R_M        = 6370e3;
// Standard-atmosphere effective earth radius — the fallback when no refractivity
// is known, and exactly what N_s = 301 gives (ITM.kFactor(301) = 1.333).
const PATH_K_FACTOR    = 4 / 3;

// First Fresnel zone radius at a point d1 from one end and d2 from the other.
//
//   r1 = sqrt(λ·d1·d2 / (d1 + d2))
//
// which in the field units is r1 = 17.32·sqrt(d1_km·d2_km / (f_GHz·D_km)). Note
// that this is *not* the 8.657 coefficient quoted in the ticket: 8.657 is the
// same formula already specialised to the path midpoint with the total distance
// as its argument (17.32/2 = 8.66). Using 8.657 against d1·d2/(f·D) would halve
// the zone everywhere, and a half-size Fresnel zone reports clearance that is
// not there — the one direction this must never err in.
function fresnelR1(d1_m, d2_m, fMhz) {
  const d = d1_m + d2_m;
  if (!(d > 0) || !(fMhz > 0) || d1_m < 0 || d2_m < 0) return 0;
  const lambda = 299.792458 / fMhz;                 // metres
  return Math.sqrt(lambda * d1_m * d2_m / d);
}

// How much the earth rises between the two ends. Added to the ground rather
// than bent into the line of sight, so the plot keeps a straight LOS and reads
// the way a Radio Mobile profile does. k defaults to 4/3; pathAnalyse passes
// the one the surface refractivity implies.
function earthBulge(d1_m, d2_m, k) {
  return (d1_m * d2_m) / (2 * (k > 0 ? k : PATH_K_FACTOR) * EARTH_R_M);
}

// Fresnel-Kirchhoff diffraction parameter. h is the obstruction height above
// the line of sight — positive when terrain is actually blocking.
function fresnelV(h_m, d1_m, d2_m, fMhz) {
  const r1 = fresnelR1(d1_m, d2_m, fMhz);
  return r1 > 0 ? Math.SQRT2 * h_m / r1 : 0;
}

// Single knife-edge diffraction loss, the ITU-R P.526 approximation. ~6 dB at
// grazing (v = 0), which is the number that makes a "just touching" path read
// as already costing something. Kept as the fallback the map's line-of-sight
// sweep and a profile with no usable model can still quote.
function knifeEdgeDb(v) {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

function fsplDb(dKm, fMhz) {
  if (!(dKm > 0) || !(fMhz > 0)) return 0;
  return 32.44 + 20 * Math.log10(fMhz) + 20 * Math.log10(dKm);
}

function wattsToDbm(w) { return w > 0 ? 10 * Math.log10(w * 1000) : null; }

// The Radio Mobile system a station is configured with — where its transmit
// power, feeder loss, antenna gain and height, and receiver threshold all
// already live. Every station carries an rm_system_id, so a link budget between
// two stations needs nothing typed in at all.
function rmSystemOf(st) {
  if (!st || st.rm_system_id == null || !state.data) return null;
  return (state.data.rm_systems || []).find(r => r.id === st.rm_system_id) || null;
}

// The effective-earth factor a path's refractivity implies. ITM reduces the
// sea-level N_0 to the surface refractivity N_s at the path's own mean height
// (the middle 80% of the profile, as the reference does) and derives the
// curvature from that; the chart bends its earth by the same k so the picture
// and the loss agree about where the horizon is.
function kFactorFor(terrain_m, N0) {
  const n = terrain_m.length;
  const p10 = Math.trunc(0.1 * (n - 1));
  let sum = 0, cnt = 0;
  for (let i = p10; i <= n - 1 - p10; i++) {
    const h = terrain_m[i];
    if (h != null) { sum += h; cnt++; }
  }
  const hSys = cnt ? sum / cnt : 0;
  const N_s = (N0 > 0 ? N0 : RM_NET_DEFAULTS.Refractivity) * Math.exp(-hSys / 9460);
  return { k: typeof ITM !== 'undefined' ? ITM.kFactor(N_s) : PATH_K_FACTOR, N_s, hSys };
}

// Loss at a terminal standing below the cover around it — ITU-R P.2108-1
// §3.1, the height-gain terminal correction for 30 MHz–3 GHz, which is what
// P.1812 now points at for a terminal in trees or among buildings:
//
//   A_h = J(ν) − 6.03 dB,   ν = K_nu·√(h_dif·θ_clut),   K_nu = 0.342·√f_GHz
//   h_dif = R − h,  θ_clut = atan(h_dif / w_s) in degrees,  w_s = 27 m
//
// with h the antenna height above ground, R the representative clutter height
// there, w_s the nominal street (or clearing) width, and J the P.526 knife-edge
// function — the formula IS a knife edge at the edge of the clutter, w_s away.
// ~13 dB for a 4 m antenna under 15 m trees at 150 MHz, ~18 dB at 450, and
// nothing once the antenna clears the cover. Applied only for cover that
// stands up (trees, built, wetland, crops): P.2108's open-ground variant is a
// height-gain term ITM already carries in its effective heights and two-ray
// model, and would be counted twice.
function terminalClutterDb(hAgl, R, fMhz, ws) {
  if (!(R > 0) || !(hAgl < R) || !(fMhz > 0)) return 0;
  const w = ws > 0 ? ws : 27;
  const hDif = R - hAgl;
  const theta = Math.atan(hDif / w) * 180 / Math.PI;
  const nu = 0.342 * Math.sqrt(fMhz / 1000) * Math.sqrt(hDif * theta);
  const a = knifeEdgeDb(nu) - 6.03;
  return a > 0 ? a : 0;
}

// The propagation inputs in play: the card's own, else the network's defaults.
function pathPropOf(opt) {
  const p = (opt && opt.prop) || (state.link && state.link.prop) || {};
  const D = RM_NET_DEFAULTS;
  const num = (v, d) => (v != null && isFinite(v) ? Number(v) : d);
  return {
    climate:   num(p.climate, D.Climate),
    N0:        num(p.N0, D.Refractivity),
    epsilon:   num(p.epsilon, D.Permittivity),
    sigma:     num(p.sigma, D.Conductivity),
    pol:       num(p.pol, D.Polarization),
    mdvar:     num(p.mdvar, D['Stat. mode']),
    time:      num(p.time, D['%Time']),
    location:  num(p.location, D['%Location']),
    situation: num(p.situation, D['%Situation']),
  };
}

// Turn a terrain profile into the geometry both features read off — line of
// sight from antenna to antenna, the 60% Fresnel envelope around it, and where
// the ground (or what stands on it) gets into that envelope — and into the
// Longley–Rice loss over the same profile.
//
// `elevA`/`elevB` override the sampled ground at the ends — a snapped station's
// own elevation_ahd beats a tile pixel, and mixing them is the datum compromise
// the UI declares rather than hides.
//
// `cover` is the LandCover class per sample (or null for none); `coverOff`
// says the operator turned it off, which is a different thing from not having
// it and is reported as one. `prop` is the ITM parameter set (pathPropOf).
function pathAnalyse(prof, opt) {
  const o = opt || {};
  const fMhz = o.freqMhz > 0 ? o.freqMhz : PATH_DEFAULT_MHZ;
  const D    = prof.distance_m[prof.distance_m.length - 1];
  const g    = prof.terrain_m.slice();
  const last = g.length - 1;

  // The ends: a station's surveyed height where we have one, the tile otherwise.
  const groundA = o.elevA != null ? o.elevA : g[0];
  const groundB = o.elevB != null ? o.elevB : g[last];
  if (groundA != null) g[0] = groundA;
  if (groundB != null) g[last] = groundB;
  if (groundA == null || groundB == null) {
    return { ok: false, error: 'No ground height at one or both ends of the path.' };
  }

  const aglA = o.aglA != null ? o.aglA : PATH_DEFAULT_AGL;
  const aglB = o.aglB != null ? o.aglB : PATH_DEFAULT_AGL;
  const txZ  = groundA + aglA, rxZ = groundB + aglB;
  const prop = pathPropOf(o);
  const { k, N_s, hSys } = kFactorFor(g, prop.N0);

  // What stands on the ground: the cover's representative height per sample,
  // stood on the terrain at every interior sample. The ends keep bare ground —
  // the antenna is on the ground line, and its own cover is the terminal term.
  const cls = Array.isArray(o.cover) && o.cover.length === g.length ? o.cover : null;
  const canopy = cls && Array.isArray(o.canopy) && o.canopy.length === g.length ? o.canopy : null;
  const coverH = cls ? LandCover.heights(cls, canopy) : null;
  const coverUsed = !!coverH;
  const surface = g.map((h, i) => {
    if (h == null) return null;
    if (!coverH || i === 0 || i === last) return h;
    const c = coverH[i];
    return c == null ? h : h + c;
  });
  const coverAtA = cls ? cls[0] : null, coverAtB = cls ? cls[last] : null;
  // The cover at each end, as heights(): the measured canopy where there is
  // one, the class figure otherwise.
  const endH = cls ? LandCover.heights([cls[0], cls[last]], canopy ? [canopy[0], canopy[last]] : null) : [null, null];
  const R_A = endH[0], R_B = endH[1];

  const pts = [];
  let worst = null, maxIntrusion = 0, maxV = -Infinity, coverMissing = 0;
  for (let i = 0; i < g.length; i++) {
    const d1 = prof.distance_m[i], d2 = D - d1;
    const los = txZ + (rxZ - txZ) * (D > 0 ? d1 / D : 0);
    const r1  = fresnelR1(d1, d2, fMhz);
    const bulge = earthBulge(d1, d2, k);
    const ground = g[i];
    const cover = coverH && i !== 0 && i !== last ? coverH[i] : null;
    if (coverH && i !== 0 && i !== last && cls[i] == null) coverMissing++;
    const p = { d1, los, r1, bulge, ground,
                cls: cls ? cls[i] : null,
                cover,                                        // m of cover stood here, or null
                surface: surface[i],
                bulged: ground == null ? null : ground + bulge,
                surfBulged: surface[i] == null ? null : surface[i] + bulge,
                clearance: null, ratio: null };
    if (p.surfBulged != null) {
      p.clearance = los - p.surfBulged;                // metres of air under the line
      if (r1 > 0) {
        p.ratio = p.clearance / r1;                    // in first-Fresnel radii
        if (worst == null || p.ratio < worst.ratio) worst = { ...p, i };
        const intrusion = 0.6 * r1 - p.clearance;      // into the 60% zone
        if (intrusion > maxIntrusion) maxIntrusion = intrusion;
        const v = fresnelV(-p.clearance, d1, d2, fMhz);
        if (v > maxV) maxV = v;
      }
    }
    pts.push(p);
  }
  if (!worst) return { ok: false, error: 'No usable terrain samples along this path.' };

  // The dominant edge, treated as a single knife edge — the proxy the map's
  // sweep still quotes, and the figure shown when the model cannot run.
  const diffractionDb = isFinite(maxV) ? knifeEdgeDb(maxV) : 0;
  const verdict = worst.ratio >= 0.6 ? 'clear' : worst.ratio >= 0 ? 'marginal' : 'obstructed';

  // Every run of samples standing above the line, worst first — Radio Mobile's
  // "Obstructions" list, with what each one is made of.
  const obstructions = [];
  let run = null;
  for (const p of pts) {
    const above = p.clearance != null && p.clearance < 0;
    if (above) {
      if (!run) run = { from: p.d1, to: p.d1, peak: p, byCover: false };
      run.to = p.d1;
      if (p.clearance < run.peak.clearance) run.peak = p;
      // Cover-made: the bare ground would have cleared the line here.
      if (p.cover != null && p.bulged != null && p.los - p.bulged >= 0) run.byCover = true;
    } else if (run) { obstructions.push(run); run = null; }
  }
  if (run) obstructions.push(run);
  obstructions.sort((a, b) => a.peak.clearance - b.peak.clearance);

  // Apparent elevation of each antenna from the other, over the k-earth.
  const elevA = Math.atan((rxZ - txZ) / D - D / (2 * k * EARTH_R_M)) * 180 / Math.PI;
  const elevB = Math.atan((txZ - rxZ) / D - D / (2 * k * EARTH_R_M)) * 180 / Math.PI;

  // ── the loss ──
  // The PFL the model wants is evenly spaced heights end to end. A tile gap in
  // the middle is bridged for the model only — the chart still shows the gap —
  // and the result says it stood on interpolated ground.
  let itm = null, itmError = null, bridged = 0;
  if (typeof ITM !== 'undefined' && D > 0) {
    const pfl = [last, D / last];
    for (let i = 0; i <= last; i++) {
      let h = surface[i];
      if (h == null) {
        let a = i - 1, b = i + 1;
        while (a > 0 && surface[a] == null) a--;
        while (b < last && surface[b] == null) b++;
        h = surface[a] + (surface[b] - surface[a]) * (i - a) / (b - a);
        bridged++;
      }
      pfl.push(h);
    }
    const r = ITM.pointToPoint({
      pfl, hTx: aglA, hRx: aglB, fMhz,
      climate: prop.climate, N0: prop.N0, pol: prop.pol,
      epsilon: prop.epsilon, sigma: prop.sigma, mdvar: prop.mdvar,
      time: prop.time, location: prop.location, situation: prop.situation,
    });
    if (r.ok) itm = r; else itmError = r.error;
  }
  const clutterA = coverUsed && LandCover.standsUp(coverAtA) ? terminalClutterDb(aglA, R_A, fMhz) : 0;
  const clutterB = coverUsed && LandCover.standsUp(coverAtB) ? terminalClutterDb(aglB, R_B, fMhz) : 0;

  // The obstruction floor. ITM chooses its regime by the smooth-earth horizon
  // distance, not by what actually stands in the way: two 4 m masts have a
  // 16 km smooth-earth horizon between them, so a 10 km path with a ridge
  // across it is still "line of sight" to the model, and the ridge only
  // reaches the loss through the horizons' pull on the interpolation — the
  // "smearing" ITM is criticised for, and Radio Mobile inherits as is. When the
  // geometry says the line is cut and the model's excess over free space is
  // less than one knife edge over the worst obstruction would cost, the loss
  // is held to that knife edge. It is a floor, not a replacement: on most
  // obstructed paths the model is already well above it and the row is nought.
  const knife = verdict === 'obstructed' ? diffractionDb : 0;
  const floor = itm && knife > itm.A_ref_db ? knife - itm.A_ref_db : 0;
  const pathLoss = itm ? itm.A_db + clutterA + clutterB + floor : null;

  return {
    ok: true, pts, worst, verdict, fMhz,
    D, txZ, rxZ, groundA, groundB, aglA, aglB,
    k, N_s, hSys, prop,
    intrusion_m: Math.max(0, maxIntrusion),
    diffraction_db: diffractionDb,
    v: isFinite(maxV) ? maxV : null,
    obstructions,
    elevA_deg: elevA, elevB_deg: elevB,
    coverUsed, coverOff: !!o.coverOff, coverMissing, canopyUsed: !!canopy,
    coverA: coverAtA, coverB: coverAtB, R_A, R_B,
    clutterA_db: clutterA, clutterB_db: clutterB,
    floor_db: floor,
    itm, itmError, bridged,
    pathLoss_db: pathLoss,
    fspl_db: fsplDb(D / 1000, fMhz),
    partial: !!prof.partial,
  };
}

const PATH_VERDICT = {
  clear:      { label: 'Clear',      cls: 'ok',
                note: 'Nothing on the ground reaches the 60% Fresnel zone the whole way.' },
  marginal:   { label: 'Marginal',   cls: 'warn',
                note: 'Ground or cover intrudes into the 60% Fresnel zone but stays below line of sight.' },
  obstructed: { label: 'Obstructed', cls: 'bad',
                note: 'Ground or cover rises above the line of sight — this path is blocked.' },
};

// ── Elevation profile (Stations map) ─────────────────────────────────────────
// Draw a line on the map and see the ground under it, and what is growing on
// it. The quickest read there is on whether a path is plausible, and the
// budget under it says what it costs.
//
// The chart is inline SVG built the same way rfStripPlotHtml and rfcChartHtml
// build theirs — no charting library, and nothing fetched to draw it.
//
// The profile is recomputed when the line is finished, selected or typed over,
// never while it is being dragged out: MapDraw.rerenderPanel is the one hook,
// and a geometry signature stops a repeat of the same path re-fetching.

const PathProfile = (function () {
  const SAMPLES = 256;
  let cur = { sig: null, status: 'idle', prof: null, error: '',
              cover: null, coverStatus: 'idle', coverError: '' };

  const P = () => state.path;

  // The line being profiled: the selected one, or failing that the last one
  // drawn — drawing a line selects it, so in practice this is "the line you
  // just made" without the panel going blank the moment you click elsewhere.
  function target() {
    const lines = state.draw.shapes.filter(s => s.kind === 'line');
    if (!lines.length) return null;
    const sel = lines.find(s => s.id === state.draw.selectedId);
    return sel || lines[lines.length - 1];
  }

  function sigOf(sh) {
    return sh ? sh.id + ':' + sh.pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';') : null;
  }

  function stationOf(sh, end) {
    const t = sh.snappedTo;
    if (!t || !t.length || !state.data) return null;
    const id = end === 0 ? t[0] : t[t.length - 1];
    return id ? state.data.stations.find(s => s.id === id) || null : null;
  }

  // What each end of the line is: a station (with its surveyed height and its
  // radio system) or just a point on the ground.
  function endpoint(sh, end) {
    const i = end === 0 ? 0 : sh.pts.length - 1;
    const st = stationOf(sh, end);
    const sys = st ? rmSystemOf(st) : null;
    return {
      station: st, sys,
      name: st ? st.name : `${sh.pts[i][0].toFixed(4)}, ${sh.pts[i][1].toFixed(4)}`,
      isStation: !!st,
      elev: st && st.elevation_ahd != null ? st.elevation_ahd : null,
      agl: sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
    };
  }

  // The frequency to run the Fresnel maths at: whatever repeater is on either
  // end of this path, else the band the network lives in.
  function freqFor(a, b) {
    if (P().freqMhz > 0) return P().freqMhz;
    for (const e of [a, b]) {
      const r = e.station && e.station.repeater;
      if (r && r.rx_mhz > 0) return r.rx_mhz;
    }
    return PATH_DEFAULT_MHZ;
  }

  // Everything that quotes this profile follows it: the budget's terrain and
  // cover terms, and the radio-path card that quotes the budget.
  function announce() {
    LinkBudget.profileChanged();
    MapBackbone.profileChanged();
  }

  // The cover for the profile in hand — asked for after the terrain lands, on
  // the terrain's own sample points, so cover and ground line up by index.
  function fetchCover(mine) {
    const prof = cur.prof;
    if (!prof || !P().cover) { cur.coverStatus = 'off'; cur.cover = null; return; }
    cur.coverStatus = 'loading';
    LandCover.sample(prof.lat, prof.lon).then(res => {
      if (cur.sig !== mine) return;
      cur.coverStatus = res.ok ? 'ready' : 'failed';
      cur.cover = res.ok ? res : null;
      cur.coverError = res.ok ? '' : res.error;
      rerender();
      announce();
    });
  }

  // Called on every draw-panel re-render. Cheap when nothing moved: the
  // signature is the debounce, so dragging a line out costs nothing and only a
  // finished (or edited, or re-selected) line fetches terrain.
  function sync() {
    const sh = target();
    const sig = sigOf(sh);
    if (sig === cur.sig) { rerender(); return; }
    cur = { sig, status: sh ? 'loading' : 'idle', prof: null, error: '',
            cover: null, coverStatus: 'idle', coverError: '' };
    rerender();
    if (!sh) return;
    const mine = sig;
    Terrain.profile(sh.pts, SAMPLES).then(res => {
      if (cur.sig !== mine) return;                 // the line moved on while we fetched
      cur.status = res.ok ? 'ready' : 'failed';
      cur.prof   = res.ok ? res : null;
      cur.error  = res.ok ? '' : res.error;
      rerender();
      announce();
      if (res.ok) fetchCover(mine);
    });
  }

  // The cover classes to analyse with, or null; and whether that is because
  // the switch is off.
  function coverFor() {
    if (!P().cover) return { cover: null, coverOff: true };
    const c = cur.coverStatus === 'ready' && cur.cover ? cur.cover : null;
    return { cover: c ? c.cls : null, canopy: c && c.canopyOk ? c.canopy : null, coverOff: false };
  }

  // ── the chart ──

  // `flat` draws the ground and nothing else — the multi-leg case, where there
  // is a distance profile but no single radio path to put a line of sight on.
  function chartSvg(an, prof, flat) {
    const W = 920, H = 300;
    const L = 52, R = 14, T = 14, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const D  = an.D;

    // Everything that has to fit: ground with its curvature bulge, the cover on
    // it, both antennas, and the top of the Fresnel envelope.
    let lo = Infinity, hi = -Infinity;
    for (const p of an.pts) {
      if (p.bulged != null) { lo = Math.min(lo, p.bulged); hi = Math.max(hi, p.bulged); }
      if (p.surfBulged != null) hi = Math.max(hi, p.surfBulged);
      if (!flat) {
        hi = Math.max(hi, p.los + 0.6 * p.r1);
        lo = Math.min(lo, p.los - 0.6 * p.r1);
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return '';
    const pad = Math.max(20, (hi - lo) * 0.1);
    lo -= pad; hi += pad;

    const x = d => L + (D > 0 ? d / D : 0) * iw;
    const y = m => T + (1 - (m - lo) / (hi - lo)) * ih;

    // Ground, as an area down to the axis. Gaps where a tile was missing are
    // left as gaps — a bridged gap would be invented ground.
    const runs = [];
    let run = [];
    for (const p of an.pts) {
      if (p.bulged == null) { if (run.length) runs.push(run); run = []; }
      else run.push(p);
    }
    if (run.length) runs.push(run);
    const ground = runs.map(r => {
      const top = r.map(p => `${x(p.d1).toFixed(1)},${y(p.bulged).toFixed(1)}`).join(' L');
      return `<path d="M${x(r[0].d1).toFixed(1)},${(T + ih).toFixed(1)} L${top} L${x(r[r.length - 1].d1).toFixed(1)},${(T + ih).toFixed(1)} Z"
                    fill="var(--terrain-fill)" stroke="var(--terrain-line)" stroke-width="1"/>`;
    }).join('');

    // What stands on the ground: a band from the terrain up to the cover's
    // height, one polygon per run of the same class, painted in that class's
    // token — the way Radio Mobile's Radio Link window colours its land cover.
    // A class of no height (water, bare) draws a thin line at the ground so it
    // is still *named* there; a missing class draws nothing.
    const bands = [];
    let seg = null;
    const flush = () => {
      if (!seg || !seg.pts.length) { seg = null; return; }
      const ps = seg.pts;
      const tall = ps.some(p => p.cover > 0);
      if (tall) {
        const top = ps.map(p => `${x(p.d1).toFixed(1)},${y(p.surfBulged).toFixed(1)}`).join(' L');
        const bot = ps.slice().reverse().map(p => `${x(p.d1).toFixed(1)},${y(p.bulged).toFixed(1)}`).join(' L');
        bands.push(`<path d="M${top} L${bot} Z" fill="${LandCover.colourVar(seg.cls)}" opacity=".85" stroke="none"><title>${
          esc(LandCover.CLASSES[seg.cls].label)} · ${LandCover.heightOf(seg.cls)} m</title></path>`);
      } else {
        bands.push(`<polyline points="${ps.map(p => `${x(p.d1).toFixed(1)},${y(p.bulged).toFixed(1)}`).join(' ')}"
          fill="none" stroke="${LandCover.colourVar(seg.cls)}" stroke-width="3" opacity=".9"><title>${
          esc(LandCover.CLASSES[seg.cls].label)}</title></polyline>`);
      }
      seg = null;
    };
    if (an.coverUsed) {
      for (let i = 0; i < an.pts.length; i++) {
        const p = an.pts[i];
        const c = p.cls;
        const usable = c != null && p.bulged != null && p.surfBulged != null;
        if (!usable) { flush(); continue; }
        if (seg && seg.cls !== c) {
          // Close the run on this point too, so adjacent bands meet with no gap.
          seg.pts.push({ ...p, surfBulged: p.bulged + (LandCover.heightOf(seg.cls) || 0), cover: LandCover.heightOf(seg.cls) });
          flush();
        }
        if (!seg) seg = { cls: c, pts: [] };
        seg.pts.push(p);
      }
      flush();
    }

    // Where the surface is inside the 60% zone, drawn over the top of it.
    const bad = [];
    let bseg = [];
    for (const p of an.pts) {
      const intruding = p.surfBulged != null && p.clearance != null && p.clearance < 0.6 * p.r1;
      if (intruding) bseg.push(p);
      else if (bseg.length) { bad.push(bseg); bseg = []; }
    }
    if (bseg.length) bad.push(bseg);
    const obstruction = bad.map(r => `<polyline points="${
      r.map(p => `${x(p.d1).toFixed(1)},${y(p.surfBulged).toFixed(1)}`).join(' ')
    }" fill="none" stroke="var(--bad)" stroke-width="2.5"/>`).join('');

    const radio = flat ? '' : `
      <polyline points="${an.pts.map(p => `${x(p.d1).toFixed(1)},${y(p.los + 0.6 * p.r1).toFixed(1)}`).join(' ')}"
                fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>
      <polyline points="${an.pts.map(p => `${x(p.d1).toFixed(1)},${y(p.los - 0.6 * p.r1).toFixed(1)}`).join(' ')}"
                fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>
      <line x1="${x(0)}" y1="${y(an.txZ).toFixed(1)}" x2="${x(D).toFixed(1)}" y2="${y(an.rxZ).toFixed(1)}"
            stroke="var(--accent)" stroke-width="1.8"/>`;

    // The masts themselves, so an antenna height reads as a height.
    const masts = flat ? '' : `
      <line x1="${x(0)}" y1="${y(an.groundA).toFixed(1)}" x2="${x(0)}" y2="${y(an.txZ).toFixed(1)}"
            stroke="var(--map-repeater)" stroke-width="2"/>
      <line x1="${x(D).toFixed(1)}" y1="${y(an.groundB).toFixed(1)}" x2="${x(D).toFixed(1)}" y2="${y(an.rxZ).toFixed(1)}"
            stroke="var(--map-repeater)" stroke-width="2"/>`;

    // Elevation gridlines on rounded values, so the axis reads in whole metres.
    const span = hi - lo;
    const stepM = span > 1600 ? 400 : span > 800 ? 200 : span > 400 ? 100 : span > 160 ? 50 : 20;
    const grid = [];
    for (let m = Math.ceil(lo / stepM) * stepM; m <= hi; m += stepM) {
      grid.push(`<line x1="${L}" y1="${y(m).toFixed(1)}" x2="${W - R}" y2="${y(m).toFixed(1)}"
                       stroke="var(--border)" stroke-width="1"/>
                 <text x="${L - 6}" y="${(y(m) + 3.5).toFixed(1)}" font-size="10" text-anchor="end"
                       style="fill:var(--muted)">${m}</text>`);
    }
    // The end labels are anchored inwards so neither runs off the viewBox.
    const xticks = [0, .25, .5, .75, 1].map(f => `
      <text x="${x(D * f).toFixed(1)}" y="${H - 10}" font-size="10"
            text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}"
            style="fill:var(--muted)">${fmtKm(D * f / 1000)}</text>`).join('');

    const w = an.worst;
    const marker = !flat && w && w.ratio < 0.6 ? `
      <line x1="${x(w.d1).toFixed(1)}" y1="${y(w.surfBulged).toFixed(1)}"
            x2="${x(w.d1).toFixed(1)}" y2="${y(w.los).toFixed(1)}"
            stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <circle cx="${x(w.d1).toFixed(1)}" cy="${y(w.surfBulged).toFixed(1)}" r="3.5" fill="var(--bad)"/>` : '';

    // One legend chip per class actually on this path, in path order.
    const present = [];
    if (an.coverUsed) {
      for (const p of an.pts) if (p.cls != null && !present.includes(p.cls)) present.push(p.cls);
    }
    const coverKey = present.map(c => {
      const h = LandCover.heightOf(c);
      // What this class actually stood at on this path: the class figure, or
      // the range the canopy map gave it where that took over.
      let hs = h == null ? '' : ` · ${h} m`;
      if (an.canopyUsed) {
        let lo = Infinity, hi = -Infinity;
        for (const p of an.pts) if (p.cls === c && p.cover != null && p.cover !== h) { lo = Math.min(lo, p.cover); hi = Math.max(hi, p.cover); }
        if (isFinite(lo)) hs = ` · ${Math.round(lo) === Math.round(hi) ? Math.round(lo) : `${Math.round(lo)}–${Math.round(hi)}`} m from the canopy map`;
      }
      return `<span><i class="path-key-cover" style="--dot:${LandCover.colourVar(c)}"></i> ${esc(LandCover.CLASSES[c].label)}${hs}</span>`;
    }).join('');

    return `
      <div class="path-chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="path-chart" role="img"
             aria-label="Terrain profile over ${fmtKm(D / 1000)} — ${esc((PATH_VERDICT[an.verdict] || {}).label || an.verdict)}${
               w && w.clearance != null
                 ? (w.clearance >= 0
                     ? `, worst clearance ${Math.round(w.clearance)} m under the line at ${fmtKm(w.d1 / 1000)}`
                     : `, ${w.cover != null ? 'cover' : 'terrain'} ${Math.round(-w.clearance)} m above the line at ${fmtKm(w.d1 / 1000)}`)
                 : ''}${an.coverUsed ? `, with ${present.length} land-cover class${present.length === 1 ? '' : 'es'} drawn on the ground` : ''}. The same figures are listed under the chart.">
          ${grid.join('')}
          ${radio}
          ${ground}
          ${bands.join('')}
          ${flat ? '' : obstruction}
          ${marker}
          ${masts}
          <line x1="${L}" y1="${T + ih}" x2="${W - R}" y2="${T + ih}" stroke="var(--muted)" stroke-width="1"/>
          ${xticks}
        </svg>
        <div class="path-key small">
          ${flat ? '' : `
            <span><i class="path-key-los"></i> Line of sight</span>
            <span><i class="path-key-fres"></i> 60% Fresnel zone</span>`}
          <span><i class="path-key-gnd"></i> Ground (curvature k=${an.k.toFixed(2)} included)</span>
          ${flat ? '' : '<span><i class="path-key-obs"></i> Inside the Fresnel zone</span>'}
          ${coverKey}
        </div>
        <p class="filter-hint">${esc(prof.attribution)} · sampled every
          ~${prof.resolution_m} m at zoom ${prof.zoom} over ${prof.tiles} tile${prof.tiles === 1 ? '' : 's'}${
          prof.capped ? ', zoom reduced to stay inside the tile budget for a path this long' : ''}.${
          an.coverUsed && cur.cover ? ` ${esc(LandCover.attribution)}${cur.cover.year !== 'seeded' ? ` (${cur.cover.year})` : ''}, on the same sample points.${
          an.canopyUsed ? ` ${esc(LandCover.canopyAttribution)}.` : ''}` : ''}</p>
      </div>`;
  }

  // ── the panel ──

  function readoutHtml(an, a, b) {
    const v = PATH_VERDICT[an.verdict];
    const w = an.worst;
    const worstWhat = w.clearance < 0 ? (w.cover != null && w.los - w.bulged >= 0 ? 'cover' : 'ground') : null;
    const itm = an.itm;
    return `
      <div class="path-readout">
        <div class="path-verdict ${v.cls}">
          <strong>${v.label}</strong>
          <span class="small">${esc(v.note)}</span>
        </div>
        <dl class="path-stats">
          <div><dt>Path</dt><dd>${esc(a.name)} → ${esc(b.name)}</dd></div>
          <div><dt>Distance</dt><dd>${fmtKm(an.D / 1000)}</dd></div>
          <div><dt>Frequency</dt><dd>${an.fMhz.toFixed(3)} MHz</dd></div>
          <div><dt>Worst Fresnel</dt><dd>${w.clearance >= 0
            ? `${Math.round(w.clearance)} m under the line · ${w.ratio.toFixed(2)}&nbsp;F1`
            : `<span class="txt-bad">${worstWhat} ${Math.round(-w.clearance)} m above the line</span>`}
            <span class="small">at ${fmtKm(w.d1 / 1000)}</span></dd></div>
          <div><dt>Into 60% zone</dt><dd>${an.intrusion_m > 0
            ? `${Math.round(an.intrusion_m)} m` : 'nothing'}</dd></div>
          <div><dt>Elevation angle</dt><dd>${an.elevA_deg.toFixed(3)}° / ${an.elevB_deg.toFixed(3)}°
            <span class="small">A→B / B→A</span></dd></div>
          <div><dt>Path loss</dt><dd>${an.pathLoss_db != null
            ? `${an.pathLoss_db.toFixed(1)} dB <span class="small">${esc(itm.modeLabel.toLowerCase())}, ${(an.pathLoss_db - an.fspl_db).toFixed(1)} dB over free space</span>`
            : `<span class="txt-warn">not computed</span> <span class="small">${esc(an.itmError || '')}</span>`}</dd></div>
          <div><dt>Obstructions</dt><dd>${an.obstructions.length
            ? an.obstructions.slice(0, 3).map(o => `${o.byCover ? 'cover' : 'ground'} +${Math.round(-o.peak.clearance)} m at ${fmtKm(o.peak.d1 / 1000)}`).join(', ')
              + (an.obstructions.length > 3 ? ` and ${an.obstructions.length - 3} more` : '')
            : 'none above the line'}</dd></div>
        </dl>
      </div>`;
  }

  // The ground-cover switch, and what the cover layer has to say about this
  // path: which year's map, how many samples it could not classify, or why
  // there is none — the loud-failure rule, so a bare profile is never mistaken
  // for a clear one.
  function coverStatusHtml(an) {
    if (!P().cover) {
      return `<span class="txt-warn">Off — the profile is bare ground, and a bare profile reads clear through a forest.</span>`;
    }
    switch (cur.coverStatus) {
      case 'loading': return 'Sampling land cover along the path…';
      case 'failed':  return `<span class="txt-bad">Unavailable — ${esc(cur.coverError)}</span> The profile is drawn bare and the budget has no cover terms.`;
      case 'ready': {
        const c = cur.cover;
        const bits = [`${esc(LandCover.attribution)}${c.year !== 'seeded' ? `, ${c.year} map` : ''}`];
        bits.push(c.canopyOk
          ? 'Tree heights are the canopy map’s where it has one, the table’s where it does not.'
          : '<span class="txt-warn">Canopy map unavailable — every tree stands at the table’s height.</span>');
        if (c.missing) bits.push(`<span class="txt-warn">${c.missing} of ${c.cls.length} samples unclassified (cloud or no pixel) — drawn bare there</span>`);
        if (an && an.coverUsed) {
          const ends = [['A', an.coverA, an.R_A, an.aglA, an.clutterA_db], ['B', an.coverB, an.R_B, an.aglB, an.clutterB_db]]
            .map(([tag, cls, R, agl, db]) => cls == null ? `${tag}: unclassified`
              : `${tag}: ${esc(LandCover.CLASSES[cls].label)}${R > 0 ? ` ${R} m` : ''}${
                  db > 0 ? ` — antenna at ${agl} m is <strong>under it</strong>, ${db.toFixed(1)} dB terminal loss` : ''}`);
          bits.push(`At the ends — ${ends.join(' · ')}.`);
        }
        return bits.join(' ');
      }
      default: return '';
    }
  }

  // The class → height table, editable. Radio Mobile's Land cover dialog, in
  // effect: the representative height each class is stood at, remembered
  // across sessions, with the P.1812-style defaults one click away.
  function coverTableHtml() {
    const rows = LandCover.table().map(r => `
      <tr class="${r.edited ? 'is-over' : ''}">
        <th scope="row"><i class="cover-swatch" style="--dot:${LandCover.colourVar(r.code)}"></i>${esc(r.label)}</th>
        <td>${r.def == null
          ? '<span class="small txt-muted">no height — treated as missing</span>'
          : `<input type="number" min="0" step="0.5" value="${r.h}" aria-label="${escAttr(r.label)} height in metres"
                    onchange="PathProfile.setCoverHeight(${r.code}, this.value)"> m`}</td>
        <td class="small">${r.edited ? `edited · default ${r.def} m` : esc(r.note)}</td>
      </tr>`).join('');
    return `
      <details class="path-cover-table" ${state.link.coverOpen ? 'open' : ''}
               ontoggle="state.link.coverOpen = this.open">
        <summary class="small">Cover heights — what each class is stood at on the profile</summary>
        <div class="table-wrap">
          <table class="cover-table">
            <caption class="sr-only">Representative height of each land-cover class, in metres, editable</caption>
            <thead><tr><th scope="col">Class</th><th scope="col">Height</th><th scope="col"><span class="sr-only">Source</span></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="filter-hint">Representative heights — ITU-R P.1812's term: one figure stands for every pixel
          of its class. Trees and built area start from P.1812-6's defaults (15 m, 10 m suburban); the others
          are field estimates. Where the canopy map has measured a height, that height is used instead of the
          Trees figure. Edit the table for the country you are in; it is remembered.
          <button type="button" class="lb-link" onclick="PathProfile.resetCoverHeights()">Reset to defaults</button></p>
      </details>`;
  }

  function endsFormHtml(a, b, an) {
    // Where a value came from, under the box it is in — so an antenna height
    // that arrived from the station's own system says so, and one that was
    // typed doesn't pretend to have.
    const src = (e, over) => `<b class="path-src">${
      over != null ? 'edited'
        : e.isStation && e.sys ? `default · ${esc(e.sys.name)}`
        : 'default'}</b>`;
    return `
      <div class="path-form">
        <label class="draw-field">
          <span>${esc(a.name)} antenna (m AGL)</span>
          <input type="number" step="0.5" min="0" value="${an.aglA}"
                 onchange="PathProfile.setAgl('A', this.value)">
          ${src(a, P().aglA)}
        </label>
        <label class="draw-field">
          <span>${esc(b.name)} antenna (m AGL)</span>
          <input type="number" step="0.5" min="0" value="${an.aglB}"
                 onchange="PathProfile.setAgl('B', this.value)">
          ${src(b, P().aglB)}
        </label>
        <label class="draw-field">
          <span>Frequency (MHz)</span>
          <input type="number" step="0.1" min="1" value="${an.fMhz}"
                 onchange="PathProfile.setFreq(this.value)">
          <b class="path-src">${P().freqMhz != null ? 'edited'
            : (a.station && a.station.repeater) || (b.station && b.station.repeater)
              ? 'default · repeater channel' : 'default · network band'}</b>
        </label>
      </div>
      <label class="filter-check">
        <input type="checkbox" id="path-cover-switch" ${P().cover ? 'checked' : ''}
               onchange="PathProfile.setCover(this.checked)">
        Ground cover — trees, buildings and crops stood on the terrain
      </label>
      <p class="small path-cover-note" id="path-cover-status">${coverStatusHtml(an)}</p>
      ${P().cover ? coverTableHtml() : ''}`;
  }

  function bodyHtml() {
    const sh = target();
    if (!sh) return '';
    const a = endpoint(sh, 0), b = endpoint(sh, 1);
    const multi = sh.pts.length > 2;

    if (cur.status === 'loading') {
      return `<p class="filter-note">Sampling terrain along ${fmtKm(MapDraw.lineKm(sh.pts))} of path…</p>`;
    }
    if (cur.status === 'failed') {
      return `
        <div class="path-fail">
          <strong>Terrain data unavailable.</strong>
          <span class="small">${esc(cur.error)}</span>
          <span class="small">No profile is drawn rather than a flat one — flat ground would read as a clear path.</span>
          <button onclick="PathProfile.refresh()">Try again</button>
        </div>`;
    }
    if (cur.status !== 'ready' || !cur.prof) return '';

    const prof = cur.prof;
    const warn = prof.partial ? `
      <p class="path-warn small">${prof.missing} of ${prof.terrain_m.length} samples had no tile —
        the profile is drawn with gaps rather than guessed through them.</p>` : '';

    // A dog-leg is a distance profile and nothing more. Drawing a line of sight
    // end to end across a corner would be describing a radio path that isn't
    // the one drawn.
    if (multi) {
      const an = pathAnalyse(prof, { elevA: a.elev, elevB: b.elev, aglA: 0, aglB: 0, ...coverFor() });
      return `
        <p class="path-warn small">This line has ${sh.pts.length - 1} legs, so it is a
          <strong>distance profile only</strong> — no line of sight and no Fresnel zone.
          A dog-leg is not a radio path. Draw a two-point line to analyse a hop.</p>
        ${warn}
        ${an.ok ? chartSvg(an, prof, true) : `<p class="filter-note">${esc(an.error)}</p>`}`;
    }

    const an = pathAnalyse(prof, {
      elevA: a.elev, elevB: b.elev,
      aglA: P().aglA != null ? P().aglA : a.agl,
      aglB: P().aglB != null ? P().aglB : b.agl,
      freqMhz: freqFor(a, b),
      ...coverFor(),
    });
    if (!an.ok) return `<p class="filter-note">${esc(an.error)}</p>`;

    const datum = (a.elev != null || b.elev != null) ? `
      <p class="filter-hint">Ends use the station's surveyed <code>elevation_ahd</code> (AHD);
        the ground between comes from tiles referenced to the EGM96 geoid. The two agree to
        about a metre over Australia — inside the ~${prof.resolution_m} m sampling error, but not the
        same datum. Treat every height here as indicative.</p>` : `
      <p class="filter-hint">All heights are sampled from tiles (EGM96 geoid, not AHD) — neither
        end is snapped to a station with a surveyed elevation.</p>`;

    return `
      ${readoutHtml(an, a, b)}
      ${warn}
      ${chartSvg(an, prof)}
      ${endsFormHtml(a, b, an)}
      ${datum}
      <div class="path-actions">
        <button onclick="LinkBudget.fromProfile()">Link budget for this path →</button>
      </div>`;
  }

  function panelHtml() {
    const sh = target();
    if (!sh) return '';
    return `
      <details class="path-panel" ${P().open ? 'open' : ''}
               ontoggle="PathProfile.setOpen(this.open)">
        <summary>
          <h3>Elevation profile</h3>
          <span class="small">${esc(MapDraw.measure(sh))}</span>
        </summary>
        <div class="path-body">${bodyHtml()}</div>
      </details>`;
  }

  function rerender() {
    const el = document.getElementById('path-profile-panel');
    if (!el) return;
    const sh = target();
    el.hidden = !sh;                       // no line drawn: the panel isn't there at all
    el.innerHTML = sh ? panelHtml() : '';
  }

  return {
    sync, rerender,
    setOpen(v) { P().open = !!v; },
    setAgl(which, v) {
      const n = v.trim() === '' ? null : Number(v);
      P()[which === 'A' ? 'aglA' : 'aglB'] = isFinite(n) ? n : null;
      rerender();
      announce();
    },
    setFreq(v) {
      const n = Number(v);
      P().freqMhz = isFinite(n) && n > 0 ? n : null;
      rerender();
      announce();
    },
    // The ground-cover switch. Turning it on fetches for the profile in hand;
    // turning it off keeps what was fetched (it is cached anyway) and simply
    // stops analysing with it — and says so on the card.
    setCover(on) {
      P().cover = !!on;
      try { localStorage.setItem('mn-path-cover', on ? 'on' : 'off'); } catch (_) {}
      if (on && cur.status === 'ready' && cur.coverStatus !== 'ready') fetchCover(cur.sig);
      rerender();
      announce();
    },
    setCoverHeight(code, v) {
      LandCover.setHeight(code, v);
      rerender();
      announce();
    },
    resetCoverHeights() {
      LandCover.resetHeights();
      rerender();
      announce();
    },
    refresh() { cur.sig = null; sync(); },
    // The cover layer's state, for anything that wants to say what it saw.
    coverState() { return { status: cur.coverStatus, error: cur.coverError, res: cur.cover }; },
    // What the link budget quotes for its terrain and cover lines: the analysis
    // of the same two points, or null when there isn't one.
    analysisFor(latA, lonA, latB, lonB, opt) {
      if (cur.status !== 'ready' || !cur.prof) return null;
      const sh = target();
      if (!sh || sh.pts.length !== 2) return null;
      const near = (p, lat, lon) => Math.abs(p[0] - lat) < 1e-4 && Math.abs(p[1] - lon) < 1e-4;
      const same = near(sh.pts[0], latA, lonA) && near(sh.pts[1], latB, lonB);
      // The line may have been drawn the other way round to the way the budget
      // named its ends; the profile runs along the line, so the ends' heights
      // and antennas swap with it rather than being applied to the wrong end.
      const flipped = near(sh.pts[0], latB, lonB) && near(sh.pts[1], latA, lonA);
      if (!same && !flipped) return null;
      const cov = coverFor();
      const an = pathAnalyse(cur.prof, flipped
        ? { ...opt, ...cov, elevA: opt.elevB, elevB: opt.elevA, aglA: opt.aglB, aglB: opt.aglA }
        : { ...opt, ...cov });
      if (!an.ok) return null;
      // The caller gets its *own* analysis back — its frequency, its antenna
      // heights — which is the point of passing them in. But the chart on
      // screen is drawn from this panel's form, and the two can disagree about
      // the same hop. So the settings behind the picture ride along, in the
      // caller's A→B order, and a card quoting this can say when they differ
      // rather than printing a verdict the chart above it contradicts.
      //
      // The ground at each end rides along for the same reason, and it is the
      // one that bites hardest: the chart takes a station's surveyed
      // `elevation_ahd` and otherwise the profile's own sample of the terrain,
      // while a caller can hand in a height of its own — a single-point tile
      // sample at a different zoom, say. Two different ground heights are two
      // different lines of sight, so the same hop can come back clear here and
      // obstructed on the picture, with nothing above saying why. Resolved
      // exactly as pathAnalyse resolves it for the chart's own call, so the two
      // agree whenever they should.
      const ea = endpoint(sh, 0), eb = endpoint(sh, 1);
      const g = cur.prof.terrain_m;
      const drawn = {
        fMhz: freqFor(ea, eb),
        aglA: P().aglA != null ? P().aglA : ea.agl,
        aglB: P().aglB != null ? P().aglB : eb.agl,
        groundA: ea.elev != null ? ea.elev : g[0],
        groundB: eb.elev != null ? eb.elev : g[g.length - 1],
      };
      // When the budget's ends are flipped relative to the line, its A is the
      // line's B: the terminal-cover figures come back in the caller's order
      // already (pathAnalyse was called with the swapped heights, and it reads
      // cover off the profile's own ends), so only the drawn settings swap.
      if (flipped) {
        const t = an.coverA; an.coverA = an.coverB; an.coverB = t;
        const r = an.R_A; an.R_A = an.R_B; an.R_B = r;
        const c = an.clutterA_db; an.clutterA_db = an.clutterB_db; an.clutterB_db = c;
        const e = an.elevA_deg; an.elevA_deg = an.elevB_deg; an.elevB_deg = e;
      }
      an.chart = flipped
        ? { fMhz: drawn.fMhz,
            aglA: drawn.aglB, aglB: drawn.aglA,
            groundA: drawn.groundB, groundB: drawn.groundA }
        : drawn;
      an.chartFlipped = flipped;
      return an;
    },
    target,
  };
})();
