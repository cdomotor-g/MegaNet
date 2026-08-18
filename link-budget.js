// MegaNet — link-budget.js
//
//   LinkBudget     pick two points, get a fade margin. Either end can be a
//                  station, which fills itself in from rm_systems, or an
//                  arbitrary point on the ground — which is what makes it
//                  useful for a relocation nobody has visited yet.
//   LB_MARGIN      the margin bands, and the class that colours them.
//   lbMarginClass
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, fmtKm, acmaHaversineKm and
// RM_NET_DEFAULTS; across to app.js for mapNote; and sideways to
// path-profile.js for PATH_DEFAULT_MHZ, PATH_DEFAULT_AGL, PATH_VERDICT, fsplDb,
// wattsToDbm, rmSystemOf and PathProfile, to map-draw.js for MapDraw and to
// terrain.js for Terrain. See path-profile.js's header for why the mutual
// reference constrains nothing.
//
// The number this produces is indicative and optimistic; the banner that cannot
// be dismissed and the comparison table under it are there so the figure cannot
// be read as more than it is. Do not quietly make it look more confident.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── Link budget ──────────────────────────────────────────────────────────────
// Pick two points on the map, get a fade margin. Either end can be a station —
// which fills itself in from rm_systems — or an arbitrary point on the ground,
// which is what makes this useful for a proposed relocation: drop an end on a
// hilltop nobody has been to yet and see what the path would do.
//
// The number this produces is INDICATIVE and mostly OPTIMISTIC. Free-space path
// loss plus a single knife-edge diffraction proxy leaves out clutter, climate,
// multipath, real antenna patterns and every statistical allowance Radio Mobile
// makes — and nearly all of those *reduce* real margin. Hence the red banner
// that cannot be dismissed and the comparison table underneath it: the card is
// built so the figure cannot be read as more than it is.

const LB_MARGIN = [
  { min: 20,       label: 'Good',     cls: 'ok',   note: 'Comfortable margin — still confirm in Radio Mobile.' },
  { min: 10,       label: 'Marginal', cls: 'warn', note: 'Would not survive much rain, growth or a bad day.' },
  { min: -Infinity, label: 'Poor',    cls: 'bad',  note: 'Not a link you would build on this figure.' },
];

function lbMarginClass(db) { return LB_MARGIN.find(m => db >= m.min); }

const LinkBudget = (function () {
  let map = null, layer = null, clickHandler = null;

  const S = () => state.link;

  // ── endpoints ──

  function stationEndpoint(st) {
    const sys = rmSystemOf(st);
    const rep = st.repeater || null;
    return {
      kind: 'station', sid: st.id, name: st.name,
      lat: st.lat, lon: st.lon,
      ground: st.elevation_ahd != null ? st.elevation_ahd : null,
      groundSrc: st.elevation_ahd != null ? 'elevation_ahd (AHD)' : null,
      sysName: sys ? sys.name : null,
      freq: rep && rep.rx_mhz > 0 ? rep.rx_mhz : null,
      def: {
        tx_w:     sys && sys.tx_power_w != null ? sys.tx_power_w : null,
        loss_db:  sys && sys.line_loss_db != null ? sys.line_loss_db : null,
        gain_dbi: sys && sys.antenna_gain_dbi != null ? sys.antenna_gain_dbi : null,
        agl_m:    sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
        rx_dbm:   sys && sys.rx_threshold_dbm != null ? sys.rx_threshold_dbm : null,
      },
      over: {},
    };
  }

  function pointEndpoint(lat, lon) {
    return {
      kind: 'point', sid: null,
      name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat, lon, ground: null, groundSrc: null, sysName: null, freq: null,
      // A hypothetical site has to start from something; the 1 W field station
      // is what most of this network actually is.
      def: { tx_w: 1, loss_db: 1, gain_dbi: 5.15, agl_m: PATH_DEFAULT_AGL, rx_dbm: -117 },
      over: {},
    };
  }

  // The value in play, and whether the operator put it there.
  function val(e, k) { return e.over[k] != null ? e.over[k] : e.def[k]; }
  function isOver(e, k) { return e.over[k] != null; }

  // An endpoint with no surveyed height gets one from the terrain tiles —
  // asynchronously, and the card redraws when it lands.
  //
  // Not only hypothetical points: most stations carry no elevation_ahd at all
  // (2,334 of 3,174 at the time of writing), and those were left reading
  // "sampling…" for the life of the card, because nothing was ever going to
  // sample them. A tile height is not AHD and the card says so, but it beats a
  // permanent lie about work in progress — and it gives pathAnalyse a real
  // height for that end instead of nothing.
  function fillGround(e) {
    if (!e || e.ground != null || e._pending) return;
    e._pending = true;
    Terrain.sample(e.lat, e.lon).then(m => {
      e._pending = false;
      if (m != null) { e.ground = m; e.groundSrc = 'terrain tile (EGM96 geoid)'; }
      else e.groundSrc = 'unavailable';
      rerender();
    });
  }

  // ── map pick ──

  function setEnd(which, e) {
    S()[which] = e;
    fillGround(e);
    drawMarkers();
    rerender();
  }

  function onMapClick(ev) {
    // A draw tool owns its own clicks; this only takes the ones nothing else
    // wanted.
    if (!S().picking || state.draw.tool) return;
    const { ll, sid } = MapDraw.resolveClick(ev.latlng);
    const st = sid && state.data ? state.data.stations.find(s => s.id === sid) : null;
    const e = st ? stationEndpoint(st) : pointEndpoint(ll[0], ll[1]);
    // Fill whichever end is empty; once both are set, start again from A.
    const which = !S().a ? 'a' : !S().b ? 'b' : 'a';
    if (which === 'a' && S().a && S().b) S().b = null;
    setEnd(which, e);
    mapNote(S().a && S().b
      ? 'Both ends set — click again to start a new path.'
      : 'Now click the other end of the path.', 3000);
  }

  function drawMarkers() {
    if (!layer) return;
    layer.clearLayers();
    const { a, b } = S();
    [['A', a], ['B', b]].forEach(([tag, e]) => {
      if (!e) return;
      L.circleMarker([e.lat, e.lon], {
        radius: 8, color: '#c62828', weight: 3, fillColor: '#fff', fillOpacity: 1,
      }).addTo(layer).bindTooltip(`${tag} · ${esc(e.name)}`, {
        permanent: true, direction: 'top', className: 'mn-draw-label', offset: [0, -8],
      });
    });
    if (a && b) {
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]],
                 { color: '#c62828', weight: 2.5, dashArray: '6 4' }).addTo(layer);
    }
  }

  // ── the budget ──

  // The profile for exactly these two ends, when the elevation panel happens to
  // be showing it. It is the evidence for the diffraction term, so the card
  // only claims one when it can point at the profile it came from.
  function analysisFor(a, b) {
    return PathProfile.analysisFor(a.lat, a.lon, b.lat, b.lon, {
      elevA: a.ground, elevB: b.ground,
      aglA: val(a, 'agl_m'), aglB: val(b, 'agl_m'),
      freqMhz: freqOf(),
    });
  }

  function freqOf() {
    const S_ = S();
    if (S_.freqMhz > 0) return S_.freqMhz;
    for (const e of [S_.a, S_.b]) if (e && e.freq > 0) return e.freq;
    return PATH_DEFAULT_MHZ;
  }

  function compute() {
    const { a, b } = S();
    if (!a || !b) return null;
    const dKm  = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
    const fMhz = freqOf();
    const txW  = val(a, 'tx_w');
    const txDbm = wattsToDbm(txW);
    const an = analysisFor(a, b);

    const eirp = txDbm == null ? null : txDbm + (val(a, 'gain_dbi') || 0) - (val(a, 'loss_db') || 0);
    const fspl = fsplDb(dKm, fMhz);
    const diff = an ? an.diffraction_db : null;
    const rxDbm = eirp == null ? null
      : eirp - fspl - (diff || 0) + (val(b, 'gain_dbi') || 0) - (val(b, 'loss_db') || 0);
    const thr = val(b, 'rx_dbm');
    const margin = rxDbm == null || thr == null ? null : rxDbm - thr;

    return { dKm, fMhz, txW, txDbm, eirp, fspl, diff, rxDbm, thr, margin, an,
             fsplOnly: an == null };
  }

  // ── rendering ──

  function endpointCard(which, e) {
    const tag = which === 'a' ? 'A' : 'B';
    if (!e) {
      return `
        <div class="lb-end lb-end-empty">
          <div class="lb-end-head"><span class="lb-tag">${tag}</span> <em>not set</em></div>
          <p class="small">${S().picking
            ? 'Click a station or any point on the map.'
            : 'Turn on “Pick two points” and click the map.'}</p>
        </div>`;
    }
    const f = (k, label, step, unit) => {
      const over = isOver(e, k);
      const v = val(e, k);
      return `
        <label class="lb-field${over ? ' is-over' : ''}">
          <span>${esc(label)}${unit ? ` <em>${esc(unit)}</em>` : ''}</span>
          <input type="number" step="${step}" value="${v == null ? '' : v}"
                 placeholder="not set"
                 onchange="LinkBudget.setField('${which}','${k}',this.value)">
          <b class="lb-flag">${over ? 'edited'
            : e.def[k] == null ? ''
            : e.kind === 'station' ? 'default'
            // A hypothetical site's figures came from nowhere but this code, so
            // they are marked as the guesses they are rather than borrowing the
            // authority of a "default" read out of the station data.
            : 'assumed'}</b>
        </label>`;
    };
    return `
      <div class="lb-end">
        <div class="lb-end-head">
          <span class="lb-tag">${tag}</span>
          <strong>${esc(e.name)}</strong>
          <button class="draw-del" title="Clear this end"
                  onclick="LinkBudget.clearEnd('${which}')">✕</button>
        </div>
        <p class="small lb-src">${e.kind === 'station'
          ? `Station${e.sysName ? ` · ${esc(e.sysName)}` : ''}${e.freq ? ` · repeater ${e.freq} MHz` : ''}`
          : 'Hypothetical point — nothing is written back to the station data'}</p>
        <p class="small lb-src">Ground ${e.ground != null
          ? `${e.ground.toFixed(1)} m <span style="color:var(--muted)">${esc(e.groundSrc || '')}</span>`
          : (e.groundSrc === 'unavailable'
              ? '<span style="color:var(--bad)">unavailable — no terrain tile for this point</span>'
              : '<span style="color:var(--muted)">sampling…</span>')}</p>
        <div class="lb-fields">
          ${f('tx_w',     'TX power',        '0.1',  'W')}
          ${f('gain_dbi', 'Antenna gain',    '0.05', 'dBi')}
          ${f('loss_db',  'Line loss',       '0.1',  'dB')}
          ${f('agl_m',    'Antenna height',  '0.5',  'm AGL')}
          ${f('rx_dbm',   'RX threshold',    '0.1',  'dBm')}
        </div>
      </div>`;
  }

  // Every term is signed, so the column reads as an addition that visibly comes
  // out at the received level — subtotals excepted, which are the running
  // result rather than something being added.
  function budgetRow(label, value, unit, note, cls) {
    const sub = /^=/.test(label);
    return `
      <tr class="${cls || ''}">
        <th>${esc(label)}</th>
        <td class="lb-num">${value == null ? '—'
          : (value > 0 && !sub ? '+' : '') + value.toFixed(2)}</td>
        <td class="lb-unit">${esc(unit || '')}</td>
        <td class="small lb-note">${note || ''}</td>
      </tr>`;
  }

  function budgetHtml(r) {
    const a = S().a, b = S().b;
    const m = r.margin == null ? null : lbMarginClass(r.margin);
    // A blocked path can still show a fat margin: the single knife edge that
    // stands in for the terrain is the most optimistic diffraction model there
    // is, and it is standing in for a ridge above the line of sight. The number
    // stays as computed — but it does not get to read "Good".
    const blocked = !!(r.an && r.an.verdict === 'obstructed') && r.margin != null;
    return `
      <table class="lb-table">
        <tbody>
          ${budgetRow('TX power', r.txDbm, 'dBm', r.txW != null ? `${r.txW} W at ${esc(a.name)}` : 'no TX power set')}
          ${budgetRow('TX antenna gain', val(a, 'gain_dbi'), 'dBi', '')}
          ${budgetRow('TX line loss', val(a, 'loss_db') == null ? null : -val(a, 'loss_db'), 'dB', '')}
          ${budgetRow('= EIRP', r.eirp, 'dBm', '', 'lb-sub')}
          ${budgetRow('Free-space path loss', -r.fspl, 'dB',
            `${r.fMhz.toFixed(3)} MHz over ${fmtKm(r.dKm)}`)}
          ${r.diff == null
            ? `<tr class="lb-missing"><th>Diffraction proxy</th><td class="lb-num">—</td><td class="lb-unit">dB</td>
                 <td class="small lb-note">No terrain profile for these two points —
                 <strong>this result is free-space only</strong> and ignores the ground entirely.
                 ${S().a && S().b ? '<button class="lb-link" onclick="LinkBudget.profileThis()">Profile this path</button>' : ''}</td></tr>`
            : budgetRow('Diffraction proxy', -r.diff, 'dB',
                `single knife edge${r.an.v != null ? `, v=${r.an.v.toFixed(2)}` : ''} at
                 ${r.fMhz.toFixed(3)} MHz over ${fmtAglPair(val(a, 'agl_m'), val(b, 'agl_m'))}
                 — a proxy, not a propagation model`)}
          ${budgetRow('RX antenna gain', val(b, 'gain_dbi'), 'dBi', '')}
          ${budgetRow('RX line loss', val(b, 'loss_db') == null ? null : -val(b, 'loss_db'), 'dB', '')}
          ${budgetRow('= Received signal', r.rxDbm, 'dBm', `at ${esc(b.name)}`, 'lb-sub')}
          ${budgetRow('RX threshold', r.thr, 'dBm', 'receiver sensitivity')}
        </tbody>
        <tfoot>
          <tr class="lb-margin ${blocked ? 'bad' : (m ? m.cls : '')}">
            <th>Fade margin</th>
            <td class="lb-num">${r.margin == null ? '—' : (r.margin > 0 ? '+' : '') + r.margin.toFixed(1)}</td>
            <td class="lb-unit">dB</td>
            <td class="lb-note"><strong>${blocked ? 'Obstructed' : (m ? m.label : '')}</strong>
              <span class="small">${r.margin == null
                ? 'Fill in TX power and RX threshold for a margin.'
                : blocked
                  ? `Terrain rises above the line of sight, so this margin is not trustworthy${
                      m ? ` however “${m.label.toLowerCase()}” it looks` : ''}: one knife edge stands in for a
                      blocked path, and it understates it badly. Model this one properly before going near it.`
                  : esc(m.note)}</span></td>
          </tr>
        </tfoot>
      </table>
      ${r.an ? `
        <p class="small lb-eval">Terrain says <strong>${PATH_VERDICT[r.an.verdict].label.toLowerCase()}</strong>:
          ${esc(PATH_VERDICT[r.an.verdict].note)}
          ${r.an.intrusion_m > 0 ? `Worst intrusion ${Math.round(r.an.intrusion_m)} m into the 60% zone.` : ''}</p>` : ''}
      ${divergenceHtml(r)}`;
  }

  // The pair of antenna heights an analysis was run on, as one phrase.
  function fmtAglPair(x, y) {
    const n = v => (v == null ? '?' : String(Math.round(v * 10) / 10));
    return `${n(x)} / ${n(y)} m antennas`;
  }

  // Whether the elevation profile above is drawn on the same assumptions this
  // table is computed on. It is the same path over the same terrain, but each
  // card carries its own frequency and antenna heights, so the chart can show a
  // clear path while this table quotes a diffraction loss off an obstructed
  // one. Neither figure is wrong; saying nothing about the gap is.
  function divergenceHtml(r) {
    const c = r.an && r.an.chart;
    if (!c) return '';
    const a = S().a, b = S().b;
    const same = (x, y) => x != null && y != null && Math.abs(x - y) < 0.05;
    if (same(c.fMhz, r.fMhz) &&
        same(c.aglA, val(a, 'agl_m')) && same(c.aglB, val(b, 'agl_m'))) return '';
    return `
      <p class="small lb-diverge">
        The elevation profile above is drawn at <strong>${c.fMhz.toFixed(3)} MHz</strong> over
        <strong>${fmtAglPair(c.aglA, c.aglB)}</strong> — not the figures in this table. Same path,
        same terrain, different assumptions, so the chart and the diffraction line above need not agree.
        <button class="lb-link" onclick="LinkBudget.matchProfile()">Redraw the chart on these figures</button>
      </p>`;
  }

  function comparisonHtml() {
    const N = RM_NET_DEFAULTS;
    const rows = [
      ['Propagation model', 'FSPL + single knife-edge diffraction proxy', 'Longley–Rice ITM over irregular terrain'],
      ['Terrain', `Direct line sampled from ~30 m tiles`, 'Full DEM (landheight.dat), terrain-following'],
      ['Land cover / clutter', '<em>Not modelled</em>', `Urban / tree percentage (${N['%Urban or Tree']}%)`],
      ['Climate &amp; refractivity', '<em>Not modelled</em>',
       `Climate class ${N.Climate}, refractivity ${N.Refractivity}, permittivity ${N.Permittivity}, conductivity ${N.Conductivity}`],
      ['Statistical reliability', 'One deterministic figure',
       `%time ${N['%Time']} / %location ${N['%Location']} / %situation ${N['%Situation']}`],
      ['Antenna patterns', 'One gain figure, isotropic', 'Real .ant patterns, azimuth and downtilt'],
      ['Earth curvature', `Simplified — fixed k = 4/3`, 'Modelled'],
      ['Multipath, ducting, fading', '<em>Not modelled</em>', 'Statistical allowance'],
      ['Polarisation', 'Ignored', `Modelled (polarization ${N.Polarization})`],
      ['Interference / noise floor', '<em>Not modelled</em>', '— see the RF Environment tab for ACMA co-channel risk'],
    ];
    return `
      <details class="lb-compare">
        <summary>Why this is not a propagation study — what it leaves out</summary>
        <p class="small">Almost everything in the left column that is missing would <strong>reduce</strong>
          real-world margin. That is why “indicative” here mostly means <strong>optimistic</strong>:
          treat a good margin as permission to model the path properly, never as a result.</p>
        <div class="table-wrap">
          <table class="lb-compare-table">
            <thead><tr><th></th><th>MegaNet indicative</th><th>Radio Mobile (ITM / Longley–Rice)</th></tr></thead>
            <tbody>${rows.map(([k, mine, rm]) =>
              `<tr><th>${k}</th><td>${mine}</td><td>${rm}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`;
  }

  function bodyHtml() {
    const S_ = S();
    const r = compute();
    return `
      <div class="lb-disclaimer" role="alert">
        ⚠️ <strong>Indicative only.</strong> This is a first-pass sanity check, not a propagation
        study. Always confirm against Radio Mobile before making a decision.
      </div>
      <div class="lb-controls">
        <label class="filter-check">
          <input type="checkbox" ${S_.picking ? 'checked' : ''}
                 onchange="LinkBudget.setPicking(this.checked)">
          Pick two points on the map
        </label>
        <label class="draw-field">
          <span>Frequency (MHz)</span>
          <input type="number" step="0.1" min="1" value="${freqOf()}"
                 onchange="LinkBudget.setFreq(this.value)">
        </label>
        <button onclick="LinkBudget.reset()">Clear both ends</button>
      </div>
      <p class="filter-hint">${S_.picking
        ? 'Click a station to fill it in from its Radio Mobile system, or click empty ground for a hypothetical site. Every value below can be overridden.'
        : 'Ends can also be set from a line drawn in Draw &amp; measure.'}</p>
      <div class="lb-ends">
        ${endpointCard('a', S_.a)}
        ${endpointCard('b', S_.b)}
      </div>
      ${r ? budgetHtml(r) : '<p class="filter-note">Set both ends to see a budget.</p>'}
      ${comparisonHtml()}`;
  }

  function panelHtml() {
    return `
      <details class="lb-panel" ${S().open ? 'open' : ''}
               ontoggle="LinkBudget.setOpen(this.open)">
        <summary>
          <h3>Link budget <span class="lb-badge">indicative</span></h3>
          <span class="small">Fade margin between two points</span>
        </summary>
        <div class="lb-body">${S().open ? bodyHtml() : ''}</div>
      </details>`;
  }

  function rerender() {
    const el = document.getElementById('link-budget-panel');
    if (!el) return;
    const d = el.querySelector(':scope > details.lb-panel');
    // First paint only — after this the element is never replaced (#160).
    if (!d) { el.innerHTML = panelHtml(); return; }
    // Replacing an open <details> re-fires toggle on insertion in current
    // Chromium — the self-sustaining loop setOpen's guard breaks — and
    // replacing it in the same breath as a click eats the click. So from here
    // on only the body is repainted, and the element's own `open` is
    // authoritative: the browser writes it on the user's gesture before any
    // handler runs, so a repaint that disagrees has stale state and ADOPTS
    // the element's answer rather than overriding the person.
    if (d.open !== S().open) {
      S().open = d.open;
      S().picking = d.open;
    }
    const body = d.querySelector(':scope > .lb-body');
    if (body) body.innerHTML = S().open ? bodyHtml() : '';
  }

  return {
    attach(m) {
      map = m;
      layer = L.layerGroup().addTo(m);
      clickHandler = onMapClick;
      m.on('click', clickHandler);
      // Endpoints outlive the map they were picked on. A ground sample that was
      // still in flight when the tab changed resolved against a dead panel, so
      // the card came back reading "sampling…" with nothing sampling it.
      fillGround(S().a); fillGround(S().b);
      drawMarkers();
    },
    detach() {
      if (map && clickHandler) map.off('click', clickHandler);
      map = null; layer = null; clickHandler = null;
    },

    panelHtml, rerender,

    setOpen(v) {
      // Idempotent, and that is load-bearing rather than tidy (#160): current
      // Chromium fires a toggle event when a parsed `<details open>` is
      // *inserted*, and rerender() replaces the whole details. Without this
      // guard the open panel re-enters itself — toggle → setOpen → rerender →
      // insert open details → toggle — thousands of times a second: the CPU
      // pegs, every click lands on a just-detached summary, and the panel
      // "won't collapse", with nothing thrown anywhere. The browser has
      // already flipped the element by the time this runs; when the recorded
      // state matches, there is nothing to do.
      if (S().open === !!v) return;
      S().open = !!v;
      // Expanding the card arms the pick; collapsing it disarms, so a stray map
      // click doesn't quietly move an endpoint on a card nobody is looking at.
      S().picking = !!v;
      rerender();
    },
    setPicking(v) { S().picking = !!v; rerender(); },
    setFreq(v) {
      const n = Number(v);
      S().freqMhz = isFinite(n) && n > 0 ? n : null;
      rerender();
    },
    setField(which, k, v) {
      const e = S()[which];
      if (!e) return;
      const n = v.trim() === '' ? null : Number(v);
      // Blanking a box puts the default back rather than leaving a hole.
      e.over[k] = n != null && isFinite(n) ? n : null;
      if (e.over[k] == null) delete e.over[k];
      rerender();
    },
    clearEnd(which) { S()[which] = null; drawMarkers(); rerender(); },
    reset() { S().a = null; S().b = null; drawMarkers(); rerender(); },

    // The profile panel finished (or failed) — the diffraction line follows it.
    profileChanged() { if (S().open) rerender(); },

    // The budget as computed for the current endpoints, or null while either
    // end is unset. Read-only: the radio-path card quotes this so the figure
    // on the card and the figure in this panel can never disagree.
    current() { return compute(); },

    // "Link budget for this path →" on the profile panel: take the drawn line's
    // two ends as the budget's endpoints.
    fromProfile() {
      const sh = PathProfile.target();
      if (!sh || sh.pts.length !== 2) { mapNote('Draw a two-point line first', 3000); return; }
      const pick = i => {
        const ids = sh.snappedTo || [];
        const sid = i === 0 ? ids[0] : ids[ids.length - 1];
        const st = sid && state.data ? state.data.stations.find(s => s.id === sid) : null;
        return st ? stationEndpoint(st) : pointEndpoint(sh.pts[i][0], sh.pts[i][1]);
      };
      S().open = true;
      S().a = pick(0); S().b = pick(1);
      fillGround(S().a); fillGround(S().b);
      drawMarkers();
      // The one programmatic opener, so it writes the element as well as the
      // state — rerender() treats the element as authoritative and would
      // otherwise adopt its closed answer right back (#160).
      const d = document.querySelector('#link-budget-panel > details.lb-panel');
      if (d && !d.open) d.open = true;
      rerender();
      const el = document.getElementById('link-budget-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // The other direction: draw the budget's two ends as a line so the profile
    // panel picks them up and the diffraction term can be filled in.
    profileThis() {
      const { a, b } = S();
      if (!a || !b) return;
      // Open the panel BEFORE the line goes in, not after. Adding a shape
      // re-renders the profile panel synchronously and terrain then takes
      // seconds to arrive, so setting `open` afterwards left the operator
      // scrolled to a collapsed, empty card for the whole fetch — the button
      // looking like it had done nothing at all, which is what it was reported
      // as. The panel now opens on the same tick as the press and shows its own
      // "sampling terrain…" line while the tiles come in.
      state.path.open = true;
      // A second press must land back on the first line rather than stack an
      // identical one underneath it. Nothing on screen distinguishes two lines
      // between the same two points, so they only ever turn up as a Draw &
      // measure list that grows every time this button is pressed.
      const [pa, pb] = [[a.lat, a.lon], [b.lat, b.lon]];
      const existing = MapDraw.findLine(pa, pb);
      if (existing) MapDraw.focus(existing.id);
      else MapDraw.addLine([pa, pb], [a.sid || null, b.sid || null]);
      const el = document.getElementById('path-profile-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // The chart and this table are describing the same hop with different
    // antenna heights or a different frequency. Put the budget's figures into
    // the profile panel so the picture matches the numbers.
    //
    // A button rather than something profileThis() does silently: state.path
    // holds one set of overrides for *every* line drawn on the map, so writing
    // to it would quietly re-height the next hand-drawn path as well. That is
    // the operator's call to make, once, with the divergence in front of them.
    matchProfile() {
      const { a, b } = S();
      if (!a || !b) return;
      const an = analysisFor(a, b);
      if (!an) return;
      const A = val(a, 'agl_m'), B = val(b, 'agl_m');
      state.path.freqMhz = freqOf();
      state.path.aglA = an.chartFlipped ? B : A;
      state.path.aglB = an.chartFlipped ? A : B;
      PathProfile.rerender();
      rerender();
    },
  };
})();

