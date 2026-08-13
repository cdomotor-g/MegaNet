// ── Path physics ─────────────────────────────────────────────────────────────
// The maths shared by the elevation profile and the link budget. Deliberately
// small and deliberately visible: every term below turns up as its own line in
// the budget table, because a single predicted number is exactly the thing this
// feature must not become.

const PATH_DEFAULT_MHZ = 151.5;   // the network's own VHF band — RM_NET_DEFAULTS is 151–152
const PATH_DEFAULT_AGL = 4;       // m, the Field Station 1W antenna height in rm_systems
const EARTH_R_M        = 6371008.8;
// Standard-atmosphere effective earth radius. "Simplified" in the comparison
// table against Radio Mobile means exactly this: one fixed k, no climate.
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
// the way a Radio Mobile profile does.
function earthBulge(d1_m, d2_m) {
  return (d1_m * d2_m) / (2 * PATH_K_FACTOR * EARTH_R_M);
}

// Fresnel-Kirchhoff diffraction parameter. h is the obstruction height above
// the line of sight — positive when terrain is actually blocking.
function fresnelV(h_m, d1_m, d2_m, fMhz) {
  const r1 = fresnelR1(d1_m, d2_m, fMhz);
  return r1 > 0 ? Math.SQRT2 * h_m / r1 : 0;
}

// Single knife-edge diffraction loss, the ITU-R P.526 approximation. ~6 dB at
// grazing (v = 0), which is the number that makes a "just touching" path read
// as already costing something.
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

// Turn a terrain profile into the geometry both features read off: line of
// sight from antenna to antenna, the 60% Fresnel envelope around it, and where
// the ground gets into that envelope.
//
// `elevA`/`elevB` override the sampled ground at the ends — a snapped station's
// own elevation_ahd beats a tile pixel, and mixing them is the datum compromise
// the UI declares rather than hides.
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

  const pts = [];
  let worst = null, maxIntrusion = 0, maxV = -Infinity;
  for (let i = 0; i < g.length; i++) {
    const d1 = prof.distance_m[i], d2 = D - d1;
    const los = txZ + (rxZ - txZ) * (D > 0 ? d1 / D : 0);
    const r1  = fresnelR1(d1, d2, fMhz);
    const bulge = earthBulge(d1, d2);
    const ground = g[i];
    const p = { d1, los, r1, bulge, ground,
                bulged: ground == null ? null : ground + bulge,
                clearance: null, ratio: null };
    if (ground != null) {
      p.clearance = los - p.bulged;                  // metres of air under the line
      if (r1 > 0) {
        p.ratio = p.clearance / r1;                  // in first-Fresnel radii
        if (worst == null || p.ratio < worst.ratio) worst = { ...p, i };
        const intrusion = 0.6 * r1 - p.clearance;    // into the 60% zone
        if (intrusion > maxIntrusion) maxIntrusion = intrusion;
        const v = fresnelV(-p.clearance, d1, d2, fMhz);
        if (v > maxV) maxV = v;
      }
    }
    pts.push(p);
  }
  if (!worst) return { ok: false, error: 'No usable terrain samples along this path.' };

  // The dominant edge, treated as a single knife edge. A proxy, and labelled as
  // one wherever it is shown.
  const diffractionDb = isFinite(maxV) ? knifeEdgeDb(maxV) : 0;
  const verdict = worst.ratio >= 0.6 ? 'clear' : worst.ratio >= 0 ? 'marginal' : 'obstructed';

  return {
    ok: true, pts, worst, verdict, fMhz,
    D, txZ, rxZ, groundA, groundB, aglA, aglB,
    intrusion_m: Math.max(0, maxIntrusion),
    diffraction_db: diffractionDb,
    v: isFinite(maxV) ? maxV : null,
    partial: !!prof.partial,
  };
}

const PATH_VERDICT = {
  clear:      { label: 'Clear',      cls: 'ok',
                note: 'Ground stays clear of the 60% Fresnel zone the whole way.' },
  marginal:   { label: 'Marginal',   cls: 'warn',
                note: 'Ground intrudes into the 60% Fresnel zone but stays below line of sight.' },
  obstructed: { label: 'Obstructed', cls: 'bad',
                note: 'Ground rises above the line of sight — this path is blocked.' },
};

// ── Elevation profile (Stations map) ─────────────────────────────────────────
// Draw a line on the map and see the ground under it. The quickest read there
// is on whether a path is plausible, before anyone opens Radio Mobile.
//
// The chart is inline SVG built the same way rfStripPlotHtml and rfcChartHtml
// build theirs — no charting library, and nothing fetched to draw it.
//
// The profile is recomputed when the line is finished, selected or typed over,
// never while it is being dragged out: MapDraw.rerenderPanel is the one hook,
// and a geometry signature stops a repeat of the same path re-fetching.

const PathProfile = (function () {
  const SAMPLES = 256;
  let cur = { sig: null, status: 'idle', prof: null, error: '' };

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

  // Called on every draw-panel re-render. Cheap when nothing moved: the
  // signature is the debounce, so dragging a line out costs nothing and only a
  // finished (or edited, or re-selected) line fetches terrain.
  function sync() {
    const sh = target();
    const sig = sigOf(sh);
    if (sig === cur.sig) { rerender(); return; }
    cur = { sig, status: sh ? 'loading' : 'idle', prof: null, error: '' };
    rerender();
    if (!sh) return;
    const mine = sig;
    Terrain.profile(sh.pts, SAMPLES).then(res => {
      if (cur.sig !== mine) return;                 // the line moved on while we fetched
      cur.status = res.ok ? 'ready' : 'failed';
      cur.prof   = res.ok ? res : null;
      cur.error  = res.ok ? '' : res.error;
      rerender();
      // The budget quotes this profile's diffraction term, so it follows it.
      LinkBudget.profileChanged();
    });
  }

  // ── the chart ──

  // `flat` draws the ground and nothing else — the multi-leg case, where there
  // is a distance profile but no single radio path to put a line of sight on.
  function chartSvg(an, prof, flat) {
    const W = 920, H = 300;
    const L = 52, R = 14, T = 14, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const D  = an.D;

    // Everything that has to fit: ground with its curvature bulge, both
    // antennas, and the top of the Fresnel envelope.
    let lo = Infinity, hi = -Infinity;
    for (const p of an.pts) {
      if (p.bulged != null) { lo = Math.min(lo, p.bulged); hi = Math.max(hi, p.bulged); }
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

    // Where the ground is inside the 60% zone, drawn over the top of it.
    const bad = [];
    let seg = [];
    for (const p of an.pts) {
      const intruding = p.bulged != null && p.clearance != null && p.clearance < 0.6 * p.r1;
      if (intruding) seg.push(p);
      else if (seg.length) { bad.push(seg); seg = []; }
    }
    if (seg.length) bad.push(seg);
    const obstruction = bad.map(r => `<polyline points="${
      r.map(p => `${x(p.d1).toFixed(1)},${y(p.bulged).toFixed(1)}`).join(' ')
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
      <line x1="${x(w.d1).toFixed(1)}" y1="${y(w.bulged).toFixed(1)}"
            x2="${x(w.d1).toFixed(1)}" y2="${y(w.los).toFixed(1)}"
            stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <circle cx="${x(w.d1).toFixed(1)}" cy="${y(w.bulged).toFixed(1)}" r="3.5" fill="var(--bad)"/>` : '';

    return `
      <div class="path-chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="path-chart" role="img"
             aria-label="Terrain profile with line of sight and 60% Fresnel zone">
          ${grid.join('')}
          ${radio}
          ${ground}
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
          <span><i class="path-key-gnd"></i> Ground (curvature k=4/3 included)</span>
          ${flat ? '' : '<span><i class="path-key-obs"></i> Inside the Fresnel zone</span>'}
        </div>
        <p class="filter-hint">${esc(prof.attribution)} · sampled every
          ~${prof.resolution_m} m at zoom ${prof.zoom} over ${prof.tiles} tile${prof.tiles === 1 ? '' : 's'}${
          prof.capped ? ', zoom reduced to stay inside the tile budget for a path this long' : ''}.</p>
      </div>`;
  }

  // ── the panel ──

  function readoutHtml(an, a, b) {
    const v = PATH_VERDICT[an.verdict];
    const w = an.worst;
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
          <div><dt>Worst clearance</dt><dd>${w.clearance >= 0
            ? `${Math.round(w.clearance)} m under the line · ${w.ratio.toFixed(2)}&nbsp;F1`
            : `<span style="color:var(--bad)">${Math.round(-w.clearance)} m above the line</span>`}
            <span class="small" style="color:var(--muted)">at ${fmtKm(w.d1 / 1000)}</span></dd></div>
          <div><dt>Into 60% zone</dt><dd>${an.intrusion_m > 0
            ? `${Math.round(an.intrusion_m)} m` : 'nothing'}</dd></div>
          <div><dt>Diffraction proxy</dt><dd>${an.diffraction_db > 0.05
            ? `${an.diffraction_db.toFixed(1)} dB` : '0 dB'}</dd></div>
        </dl>
      </div>`;
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
      </div>`;
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
      const an = pathAnalyse(prof, { elevA: a.elev, elevB: b.elev, aglA: 0, aglB: 0 });
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
      LinkBudget.profileChanged();
    },
    setFreq(v) {
      const n = Number(v);
      P().freqMhz = isFinite(n) && n > 0 ? n : null;
      rerender();
      LinkBudget.profileChanged();
    },
    refresh() { cur.sig = null; sync(); },
    // What the link budget quotes for its diffraction line: the analysis of the
    // same two points, or null when there isn't one.
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
      const an = pathAnalyse(cur.prof, flipped
        ? { ...opt, elevA: opt.elevB, elevB: opt.elevA, aglA: opt.aglB, aglB: opt.aglA }
        : opt);
      if (!an.ok) return null;
      // The caller gets its *own* analysis back — its frequency, its antenna
      // heights — which is the point of passing them in. But the chart on
      // screen is drawn from this panel's form, and the two can disagree about
      // the same hop. So the settings behind the picture ride along, in the
      // caller's A→B order, and a card quoting this can say when they differ
      // rather than printing a verdict the chart above it contradicts.
      const ea = endpoint(sh, 0), eb = endpoint(sh, 1);
      const drawn = {
        fMhz: freqFor(ea, eb),
        aglA: P().aglA != null ? P().aglA : ea.agl,
        aglB: P().aglB != null ? P().aglB : eb.agl,
      };
      an.chart = flipped ? { fMhz: drawn.fMhz, aglA: drawn.aglB, aglB: drawn.aglA } : drawn;
      an.chartFlipped = flipped;
      return an;
    },
    target,
  };
})();

