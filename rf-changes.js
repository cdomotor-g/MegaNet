// ── RF Changes tab ──────────────────────────────────────────────────────────────
// "Did something change on the air near this repeater around the date our data
// went bad?" Two views: a retrospective timeline of AUTHORISATION_DATEs (works
// from a single extract) and diffs between archived monthly snapshots (works
// from the second archive onward — removals and parameter changes are invisible
// in a single snapshot, which is why every month is retained under
// data/acma-raw/<YYYY-MM>/). All inputs precomputed by tools/acma_fetch.py and
// tools/acma_diff.py; nothing fetched until this tab is opened.
//
// Register dates are administrative: an upper bound on when interference could
// have begun, never proof that it did. Every string in this tab is worded as
// "lead", not conclusion — keep it that way.

const RfChanges = (function () {

const RFC_CLASS = {
  cotenant: { label: 'New co-tenant at a repeater site', color: '#d32f2f',
              blurb: 'A transmitter added at a site co-located with a repeater — the highest-severity change: front-end desense plus a new intermod pair with every existing carrier on the mast.' },
  added:    { label: 'Added',                  color: '#c62828',
              blurb: 'Assignment present now, absent in the earlier snapshot — a newly commissioned transmitter.' },
  removed:  { label: 'Removed',                color: '#607d8b',
              blurb: 'Assignment gone from the register — the only way a decommissioning is ever visible.' },
  freq:     { label: 'Frequency changed',      color: '#f57c00',
              blurb: 'May have moved onto or off a MegaNet channel.' },
  power:    { label: 'Power changed',          color: '#7b1fa2',
              blurb: 'TX power or EIRP differs — direct noise-floor impact.' },
  antenna:  { label: 'Antenna changed',        color: '#0288d1',
              blurb: 'Height, azimuth, tilt or antenna model differs — a re-point toward a repeater or extended reach.' },
  site:     { label: 'Site moved',             color: '#6d4c41',
              blurb: 'Assignment relocated to a different site, possibly a repeater mast.' },
  status:   { label: 'Licence status changed', color: '#455a64',
              blurb: 'Lapsed, surrendered or reinstated.' },
};

const RFC_FIELD_LABEL = {
  f_mhz: 'Frequency (MHz)', tx_w: 'TX power (W)', eirp_w: 'EIRP (W)',
  height_m: 'Antenna height (m)', az: 'Azimuth (°)', tilt: 'Tilt (°)',
  ant_id: 'Antenna', site_id: 'Site', status: 'Licence status',
};

const RFC_SERIES_COLORS = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                           '#b8860b', '#00838f', '#ad1457', '#5d4037'];
const RFC_MARK_CAP = 800;
const RFC_DAY = 86400000;

function initRfc() {
  const A = state.acma, R = state.rfc;
  const rerender = () => { if (state.activeTab === 'rfchanges') renderMain(); };
  if (!A.loaded && !A.error) acmaEnsureCore().then(rerender).catch(rerender);
  if (!R.loaded && !R.error) rfcEnsureData().then(rerender).catch(rerender);
}

function rfcEnsureData() {
  const R = state.rfc;
  if (R.loaded) return Promise.resolve();
  if (R.loadPromise) return R.loadPromise;
  R.loading = true;
  R.loadPromise = Promise.all([
    acmaFetchJson('acma-timeline.json'),
    acmaFetchJson('acma-changes.json').catch(() => null),    // optional
    acmaFetchJson('acma-snapshots.json').catch(() => null),  // optional
  ]).then(([tl, ch, sn]) => {
    R.timeline = tl; R.changes = ch; R.snapshots = sn;
    R.loaded = true; R.loading = false; R.error = null;
  }).catch(err => {
    R.loading = false; R.loadPromise = null;
    R.error = `RF change data unavailable (${err.message}). Generate ` +
              `data/acma-timeline.json with tools/acma_fetch.py; these files ` +
              `cannot be fetched over file://.`;
    throw err;
  });
  return R.loadPromise;
}

function rfcAnchorName(id) {
  const a = state.acma.anchorById[id];
  if (a) return a.name;
  const s = (state.data?.stations || []).find(x => x.id === id);
  return s ? s.name : id;
}

// ── event filtering / ranking ──

// Events whose best anchor match passes the current selection, radius and
// minimum-score filters. Returns { e (timeline event), a (best anchor match) }.
function rfcVisibleEvents() {
  const R = state.rfc, out = [];
  if (!R.timeline) return out;
  for (const e of R.timeline.events) {
    let best = null;
    for (const a of e.anchors || []) {
      if (R.anchorSel.size && !R.anchorSel.has(a.id)) continue;
      if (a.km > R.radiusKm || a.score < R.minScore) continue;
      if (!best || a.score > best.score) best = a;
    }
    if (best && e.date) out.push({ e, a: best });
  }
  return out;
}

// Signed days from the onset date (null when no onset is set).
function rfcDaysFromOnset(e) {
  const R = state.rfc;
  if (!R.onset) return null;
  return Math.round((Date.parse(e.date) - Date.parse(R.onset)) / RFC_DAY);
}

// coincidence = interference score × temporal proximity × co-site bonus.
// Proximity decays linearly from 1 at the onset date to 0 at the window edge
// (stated in the UI tooltip — keep the formula and the tooltip in sync).
function rfcCoincidence(row) {
  const R = state.rfc;
  const days = rfcDaysFromOnset(row.e);
  if (days === null || Math.abs(days) > R.windowDays) return null;
  const prox = Math.max(0, 1 - Math.abs(days) / R.windowDays);
  const bonus = row.a.km <= 0.25 ? 1.5 : 1;
  return { days, prox, bonus, value: row.a.score * prox * bonus };
}

// Rows for the coincidence table: windowed to onset ± window when an onset is
// set, otherwise the full visible set sorted by date (newest first).
function rfcTableRows() {
  const R = state.rfc;
  let rows = rfcVisibleEvents().map(r => ({ ...r, coin: rfcCoincidence(r) }));
  if (R.onset) rows = rows.filter(r => r.coin);
  const val = r => {
    switch (R.sortKey) {
      case 'date':   return r.e.date;
      case 'days':   return r.coin ? r.coin.days : 0;
      case 'client': return r.e.client || '';
      case 'f':      return r.e.f_mhz || 0;
      case 'delta':  return rfcDeltaKhz(r) ?? 1e12;
      case 'mech':   return r.a.mech;
      case 'eirp':   return r.e.eirp_w ?? r.e.tx_w ?? 0;
      case 'km':     return r.a.km;
      case 'score':  return r.a.score;
      default:       return r.coin ? r.coin.value : Date.parse(r.e.date);
    }
  };
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * R.sortDir;
  });
  return rows;
}

function rfcDeltaKhz(row) {
  if (row.a.mech === 'cosite_desense') return null;   // proximity, not spectrum
  const rx = (state.acma.anchorById[row.a.id] || {}).rx_mhz;
  const f = row.a.product_mhz != null ? row.a.product_mhz : row.e.f_mhz;
  if (rx == null || f == null) return null;
  return (f - rx) * 1000;
}

function rfcSort(key) {
  const R = state.rfc;
  if (R.sortKey === key) R.sortDir *= -1;
  else { R.sortKey = key; R.sortDir = (key === 'coin' || key === 'score' || key === 'date') ? -1 : 1; }
  const wrap = document.getElementById('rfc-table-wrap');
  if (wrap) wrap.innerHTML = rfcTableInnerHtml();
}

// ── selector handlers ──

function rfcSelectAllAnchors() {
  state.rfc.anchorSel = new Set();
  renderMain();
}

function rfcToggleAnchor(id, on) {
  const sel = state.rfc.anchorSel;
  if (on) sel.add(id); else sel.delete(id);
  renderMain();
}

function rfcFocusAnchor(id) {
  state.rfc.anchorSel = new Set([id]);
  renderMain();
}

function rfcUseOnset(date) {
  state.rfc.onset = date;
  renderMain();
}

function rfcCardFor(deviceId, anchorId) {
  showAcmaCard(deviceId, anchorId);
}

// ── page ──

function renderRfcHtml() {
  const A = state.acma, R = state.rfc;
  if (!A.loaded || !R.loaded) {
    const msg = A.error || R.error ||
      'Loading ACMA change-detection data…';
    return `
      <div style="max-width:640px;margin:2.5rem auto;padding:1rem">
        <div class="panel" style="text-align:center;padding:2rem">
          <h2 style="margin:0 0 .6rem">RF Changes</h2>
          <p class="small" style="color:var(--muted)">${esc(msg)}</p>
        </div>
      </div>`;
  }
  return `
    <div class="stack rfc-page" style="padding:0 .25rem;position:relative">
      <div class="panel">
        <div class="panel-header"><h2>RF Changes — what changed on the air, and when</h2>
          <span class="small" style="color:var(--muted)">ACMA data: ${esc(R.timeline.meta.source_date)} · CC BY 4.0</span>
        </div>
        <p class="small" style="color:var(--muted);margin:.3rem 0 .5rem">
          Register dates are <strong>administrative</strong>: an authorisation date is an upper
          bound on when a transmitter could have come on air — licences are often authorised
          before installation (or never installed), and equipment can radiate with no register
          entry at all. A date that lines up with a data-quality step is a
          <strong>lead to investigate</strong>, never a conclusion.</p>
        ${rfcSelectorHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Timeline — authorisations vs data quality</h3></div>
        ${rfcChartHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>${R.onset ? 'Coincidence ranking' : 'Authorisation events'}</h3>
          <span style="display:flex;gap:.5rem;align-items:center">
            <span class="small" style="color:var(--muted)"
                  title="coincidence = interference score × temporal proximity × co-site bonus. Proximity decays linearly from 1 at the onset date to 0 at the window edge; ×1.5 bonus when the transmitter shares the repeater's site (≤250 m).">
              ${R.onset ? 'ranking formula ⓘ' : ''}</span>
            <button onclick="RfChanges.exportCsv()">Export CSV</button>
          </span>
        </div>
        ${R.onset ? '' : `<p class="small" style="color:var(--muted);margin:.2rem 0">
          Set an onset date above (or detect one below) to rank these by coincidence with the
          data-quality step. This table is the evidence you would attach to an ACMA
          interference complaint.</p>`}
        <div class="table-wrap tall" id="rfc-table-wrap">${rfcTableInnerHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Snapshot diff — observed register changes</h3></div>
        ${rfcDiffHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>New intermod products</h3></div>
        ${rfcImdHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Onset detection helper</h3></div>
        ${rfcOnsetHelperHtml()}
      </div>
      <div class="panel">${rfcHelpHtml()}</div>
      <div id="acma-card" class="acma-card" hidden></div>
    </div>`;
}

function rfcSelectorHtml() {
  const A = state.acma, R = state.rfc;
  const anchors = A.threats.anchors.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-start">
      <details class="rfc-picker" ${R.pickerOpen ? 'open' : ''} ontoggle="state.rfc.pickerOpen=this.open">
        <summary class="small" style="cursor:pointer">Repeaters:
          <strong>${R.anchorSel.size ? `${R.anchorSel.size} selected` : 'all'}</strong></summary>
        <div class="rfc-picker-list">
          <label style="display:flex;gap:.4rem;align-items:center">
            <input type="checkbox" ${R.anchorSel.size ? '' : 'checked'}
                   onchange="RfChanges.selectAllAnchors()"> <em>All repeaters</em></label>
          ${anchors.map(a => `
            <label style="display:flex;gap:.4rem;align-items:center">
              <input type="checkbox" ${R.anchorSel.has(a.station_id) ? 'checked' : ''}
                     onchange="RfChanges.toggleAnchor('${escAttr(a.station_id)}',this.checked)">
              ${esc(a.name)}${a.rx_mhz ? ` <span class="small" style="color:var(--muted)">${a.rx_mhz}</span>` : ''}
            </label>`).join('')}
        </div>
      </details>
      <label class="small">Onset date
        <input type="date" value="${esc(R.onset)}"
               onchange="state.rfc.onset=this.value;renderMain()">
      </label>
      <label class="small">Window
        <select onchange="state.rfc.windowDays=+this.value;renderMain()">
          ${[30, 60, 90, 180].map(w => `
            <option value="${w}" ${R.windowDays === w ? 'selected' : ''}>±${w} days</option>`).join('')}
        </select>
      </label>
      <label class="small">Radius
        <select onchange="state.rfc.radiusKm=+this.value;renderMain()">
          ${[10, 25, 50, 60].map(r => `
            <option value="${r}" ${R.radiusKm === r ? 'selected' : ''}>${r} km</option>`).join('')}
        </select>
      </label>
      <label class="small">Min score
        <input type="number" min="0" max="100" step="5" value="${R.minScore}" style="width:4.5rem"
               onchange="state.rfc.minScore=+this.value;renderMain()">
      </label>
      ${R.onset ? `<button class="small" onclick="state.rfc.onset='';renderMain()">× clear onset</button>` : ''}
    </div>`;
}

// ── timeline chart ──
// Upper band: one mark per device authorisation, one lane per interference
// mechanism, sized by score. Thin lane: licence effect/expiry as lighter marks.
// Lower band: the pasted per-station corruption series, so a coincidence
// between paperwork and data quality is visible at a glance.

function rfcChartHtml() {
  const R = state.rfc;
  const rows = rfcVisibleEvents();
  const onsetMs = R.onset ? Date.parse(R.onset) : null;
  let lo, hi;
  if (onsetMs) {
    lo = onsetMs - R.windowDays * 1.5 * RFC_DAY;
    hi = onsetMs + R.windowDays * 1.5 * RFC_DAY;
  } else {
    hi = Date.now() + 7 * RFC_DAY;
    lo = hi - 730 * RFC_DAY;
  }
  const inSpan = rows.filter(r => {
    const t = Date.parse(r.e.date);
    return t >= lo && t <= hi;
  });

  const mechs = Object.keys(ACMA_MECH).filter(m => inSpan.some(r => r.a.mech === m));
  const lanes = mechs.length ? mechs : ['co_channel'];
  const W = 1000, PADL = 118, PADR = 16, laneH = 24;
  const upperTop = 10;
  const licY = upperTop + lanes.length * laneH;
  const lowerTop = licY + 18 + 14, lowerH = 78;
  const axisY = lowerTop + lowerH + 4;
  const H = axisY + 26;
  const x = t => PADL + (t - lo) / (hi - lo) * (W - PADL - PADR);

  // month gridlines, thinned to roughly a dozen labels
  const ticks = [];
  const d0 = new Date(lo);
  let ty = d0.getUTCFullYear(), tm = d0.getUTCMonth() + 1;
  const totalMonths = Math.max(1, Math.round((hi - lo) / (30.44 * RFC_DAY)));
  const stepM = Math.max(1, Math.ceil(totalMonths / 12));
  for (let i = 0; ; i++) {
    const t = Date.UTC(ty, tm, 1);
    if (t > hi) break;
    if (i % stepM === 0) ticks.push(t);
    tm++; if (tm > 11) { tm = 0; ty++; }
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tickLabel = t => {
    const d = new Date(t);
    return `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  };

  const laneY = m => upperTop + lanes.indexOf(m) * laneH;

  const shade = onsetMs ? `
    <rect x="${x(onsetMs - R.windowDays * RFC_DAY)}" y="0"
          width="${x(onsetMs + R.windowDays * RFC_DAY) - x(onsetMs - R.windowDays * RFC_DAY)}"
          height="${axisY}" fill="rgba(211,47,47,.07)"/>
    <line x1="${x(onsetMs)}" y1="0" x2="${x(onsetMs)}" y2="${axisY}"
          stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="${x(onsetMs)}" y="${axisY + 22}" font-size="10" text-anchor="middle"
          fill="#d32f2f">onset</text>` : '';

  const shown = inSpan.slice(0, RFC_MARK_CAP);
  const marks = shown.map(r => {
    const t = Date.parse(r.e.date);
    const rad = 3 + Math.min(6, r.a.score / 15);
    const c = (ACMA_MECH[r.a.mech] || {}).color || '#666';
    return `<circle cx="${x(t).toFixed(1)}" cy="${laneY(r.a.mech) + laneH / 2}" r="${rad.toFixed(1)}"
      fill="${c}" opacity=".75" style="cursor:pointer"
      onclick="RfChanges.cardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
      <title>${esc(r.e.date)} · ${esc(r.e.client || r.e.lic || '?')} · ${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) + ' MHz · ' : ''}${esc((ACMA_MECH[r.a.mech] || {}).label || r.a.mech)} ${r.a.score} vs ${esc(rfcAnchorName(r.a.id))} · ${r.a.km} km${r.e.variation ? ' · variation to existing licence' : ''}</title>
    </circle>`;
  }).join('');

  let licMarks = '';
  let nLic = 0;
  for (const r of shown) {
    for (const d of [r.e.lic_effect, r.e.lic_expiry]) {
      const t = d ? Date.parse(d) : NaN;
      if (isNaN(t) || t < lo || t > hi || nLic >= RFC_MARK_CAP) continue;
      nLic++;
      licMarks += `<line x1="${x(t).toFixed(1)}" y1="${licY + 3}" x2="${x(t).toFixed(1)}" y2="${licY + 13}"
        stroke="var(--muted)" stroke-width="1" opacity=".45">
        <title>${esc(d)} · licence ${d === r.e.lic_effect ? 'effect' : 'expiry'} · ${esc(r.e.client || r.e.lic || '')}</title></line>`;
    }
  }

  // lower band — corruption series
  let lower = '';
  const series = Object.entries(R.corrSeries || {}).filter(([, pts]) => pts.length);
  if (series.length) {
    let vmax = 0;
    for (const [, pts] of series) for (const p of pts) vmax = Math.max(vmax, p.v);
    vmax = vmax || 1;
    lower = series.slice(0, RFC_SERIES_COLORS.length).map(([name, pts], i) => {
      const col = RFC_SERIES_COLORS[i];
      const vis = pts.filter(p => p.t >= lo && p.t <= hi);
      const path = vis.map(p =>
        `${x(p.t).toFixed(1)},${(lowerTop + lowerH - 4 - p.v / vmax * (lowerH - 10)).toFixed(1)}`).join(' ');
      return `<polyline points="${path}" fill="none" stroke="${col}" stroke-width="1.6" opacity=".85">
        <title>${esc(name)}</title></polyline>`;
    }).join('');
  } else {
    lower = `<text x="${PADL + 8}" y="${lowerTop + lowerH / 2}" font-size="11"
      style="fill:var(--muted)">No data-quality series loaded — paste per-station corruption
      counts in the onset helper below to see coincidence at a glance.</text>`;
  }

  const legend = series.length ? `
    <div class="small" style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.2rem">
      ${series.slice(0, RFC_SERIES_COLORS.length).map(([name], i) => `
        <span class="legend-item"><span class="rfc-series-line" style="background:${RFC_SERIES_COLORS[i]}"></span>
        ${esc(name)}</span>`).join('')}
    </div>` : '';

  return `
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:720px;height:auto" role="img"
           aria-label="ACMA authorisation events and data quality over time">
        ${shade}
        ${ticks.map(t => `
          <line x1="${x(t).toFixed(1)}" y1="0" x2="${x(t).toFixed(1)}" y2="${axisY}"
                stroke="var(--border)" stroke-width="1" opacity=".6"/>
          <text x="${x(t).toFixed(1)}" y="${axisY + 12}" font-size="10" text-anchor="middle"
                style="fill:var(--muted)">${tickLabel(t)}</text>`).join('')}
        ${lanes.map(m => `
          <text x="4" y="${laneY(m) + laneH / 2 + 3}" font-size="10"
                style="fill:${(ACMA_MECH[m] || {}).color || 'var(--muted)'}">${esc((ACMA_MECH[m] || {}).label || m)}</text>
          <line x1="${PADL}" y1="${laneY(m) + laneH}" x2="${W - PADR}" y2="${laneY(m) + laneH}"
                stroke="var(--border)" stroke-width=".5" opacity=".5"/>`).join('')}
        <text x="4" y="${licY + 12}" font-size="10" style="fill:var(--muted)">licence dates</text>
        ${licMarks}
        <text x="4" y="${lowerTop + 10}" font-size="10" style="fill:var(--muted)">data quality</text>
        <line x1="${PADL}" y1="${lowerTop + lowerH}" x2="${W - PADR}" y2="${lowerTop + lowerH}"
              style="stroke:var(--muted)" stroke-width="1"/>
        ${lower}
        ${marks}
      </svg>
      ${legend}
      <div class="small" style="color:var(--muted)">
        ${shown.length}${inSpan.length > shown.length ? ` of ${inSpan.length}` : ''} authorisation
        events in view · mark size = interference score · click a mark for the transmitter card.
        ${onsetMs ? 'Shaded band = the selected onset window.' : 'Showing the last 24 months — set an onset date to zoom.'}</div>
    </div>`;
}

// ── coincidence table ──

function rfcTableInnerHtml() {
  const R = state.rfc;
  const rows = rfcTableRows();
  if (!rows.length) {
    return R.onset ? `
      <div style="padding:.75rem">
        <p><strong>No register events near this onset.</strong></p>
        <p class="small" style="color:var(--muted)">A noise-floor step with no ACMA event nearby
        is itself a finding: it points away from licensed transmitters and toward your own
        infrastructure (corroding mast joints becoming an intermod mixer, a failing PA, water
        in a feeder) or an unlicensed emitter (solar charge controllers, LED signage, electric
        fences, powerline arcing). Widen the window or lower the minimum score to double-check
        before concluding.</p>
      </div>` :
      `<p style="padding:.75rem;color:var(--muted)">No authorisation events match the current
        filters — widen the radius or lower the minimum score.</p>`;
  }
  const arrow = k => R.sortKey === k ? (R.sortDir > 0 ? ' ▲' : ' ▼') : '';
  const th = (k, label, tip) => `<th style="cursor:pointer" ${tip ? `title="${escAttr(tip)}"` : ''}
    onclick="RfChanges.sort('${k}')">${label}${arrow(k)}</th>`;
  return `
    <table class="bf-table">
      <thead><tr>
        ${th('date', 'Authorised', 'DEVICE_DETAILS.AUTHORISATION_DATE — when the frequency assignment was approved (administrative)')}
        ${R.onset ? th('days', 'Δdays') : ''}
        ${th('client', 'Licensee')}${th('f', 'Freq (MHz)')}${th('delta', 'Δf (kHz)')}
        ${th('mech', 'Mechanism')}${th('eirp', 'EIRP (W)')}${th('km', 'Dist (km)')}
        ${th('score', 'Score')}
        ${R.onset ? th('coin', 'Coincidence', 'score × temporal proximity (linear decay to 0 at window edge) × 1.5 co-site bonus') : ''}
      </tr></thead>
      <tbody>
        ${rows.slice(0, 1000).map(r => {
          const m = ACMA_MECH[r.a.mech] || { label: r.a.mech, color: '#666' };
          const dk = rfcDeltaKhz(r);
          return `<tr style="cursor:pointer"
                      onclick="RfChanges.cardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
            <td class="small">${esc(r.e.date)}${r.e.variation ? ' <span class="badge" title="Authorised >30 days after the licence was issued — a variation to an existing licence (added channel, power change, re-point), not a new licence">var</span>' : ''}</td>
            ${R.onset ? `<td class="small">${r.coin.days > 0 ? '+' : ''}${r.coin.days}</td>` : ''}
            <td class="small">${esc(r.e.client || '')}</td>
            <td class="small">${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) : ''}</td>
            <td class="small">${dk != null ? dk.toFixed(1) : '—'}</td>
            <td class="small"><span class="legend-sq" style="background:${m.color}"></span> ${m.label}</td>
            <td class="small">${r.e.eirp_w ?? r.e.tx_w ?? ''}</td>
            <td class="small">${r.a.km}${r.a.km <= 0.25 ? ' <span class="badge">co-site</span>' : ''}</td>
            <td>${r.a.score}</td>
            ${R.onset ? `<td><strong>${r.coin.value.toFixed(1)}</strong></td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${rows.length > 1000 ? `<p class="small" style="color:var(--muted);padding:.4rem">Showing 1000 of ${rows.length} — tighten the filters or export the CSV.</p>` : ''}`;
}

function rfcExportCsv() {
  const R = state.rfc;
  const rows = rfcTableRows();
  const head = ['authorisation_date', 'days_from_onset', 'repeater', 'rx_mhz', 'licensee',
                'licence', 'licence_type', 'freq_mhz', 'product_mhz', 'delta_khz', 'mechanism',
                'eirp_w', 'tx_w', 'distance_km', 'co_site', 'score', 'temporal_proximity',
                'cosite_bonus', 'coincidence', 'variation_to_existing_licence',
                'licence_issued', 'licence_effect', 'licence_expiry', 'status',
                'device_id', 'site_id', 'stable_key'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const dk = rfcDeltaKhz(r);
    const rx = (state.acma.anchorById[r.a.id] || {}).rx_mhz;
    lines.push([
      r.e.date, r.coin ? r.coin.days : '', csvEscape(rfcAnchorName(r.a.id)), rx ?? '',
      csvEscape(r.e.client || ''), csvEscape(r.e.lic || ''), csvEscape(r.e.lic_type || ''),
      r.e.f_mhz ?? '', r.a.product_mhz ?? '', dk != null ? dk.toFixed(2) : '',
      r.a.mech, r.e.eirp_w ?? '', r.e.tx_w ?? '', r.a.km,
      r.a.km <= 0.25 ? 'yes' : '', r.a.score,
      r.coin ? r.coin.prox.toFixed(3) : '', r.coin ? r.coin.bonus : '',
      r.coin ? r.coin.value.toFixed(2) : '',
      r.e.variation ? 'yes' : '', r.e.lic_issued || '', r.e.lic_effect || '',
      r.e.lic_expiry || '', csvEscape(r.e.status || ''),
      r.e.device_id, r.e.site_id || '', r.e.key || '',
    ].join(','));
  }
  const onset = R.onset ? `-onset-${R.onset}` : '';
  dlText(`acma-rf-changes${onset}-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ── snapshot diff panel ──

function rfcPairs() {
  return (state.rfc.changes || {}).pairs || [];
}

function rfcSelectedPair() {
  const pairs = rfcPairs();
  if (!pairs.length) return null;
  const i = state.rfc.pairIdx;
  return pairs[i >= 0 && i < pairs.length ? i : pairs.length - 1];
}

function rfcChangeVisible(c) {
  const R = state.rfc;
  if (R.anchorSel.size && (!c.anchor || !R.anchorSel.has(c.anchor))) return false;
  if (c.anchor_km != null && c.anchor_km > R.radiusKm) return false;
  return true;
}

function rfcDiffEmptyHtml() {
  const months = ((state.rfc.snapshots || {}).snapshots || []).map(s => s.month);
  const one = months.length === 1;
  return `
    <p class="small" style="color:var(--muted)">
      Change detection compares two archived monthly subsets, and
      ${one ? `only one exists so far (<strong>${esc(months[0])}</strong>)`
            : months.length ? `the archived months (${months.map(esc).join(', ')}) have not been diffed — run tools/acma_diff.py`
            : 'none are archived yet — run tools/acma_diff.py --archive'}.
      The monthly ACMA refresh (2nd of each month, ~06:15 AEST) archives the next snapshot,
      and diffs appear here from then on — improving every month the archive grows.
      Removals and prior parameter values before the first archived month are unrecoverable:
      ACMA publishes a daily snapshot, not a back-catalogue, which is why the archive under
      <code>data/acma-raw/&lt;YYYY-MM&gt;/</code> must never be pruned.
      Until then, the authorisation timeline above is the available change axis.</p>`;
}

function rfcDiffHtml() {
  const R = state.rfc;
  const pairs = rfcPairs();
  if (!pairs.length) return rfcDiffEmptyHtml();
  const p = rfcSelectedPair();
  const latestMonth = (((R.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;   // SDD_IDs only resolve against the current extract
  const vis = (p.changes || []).filter(rfcChangeVisible);

  const groups = [];
  const used = new Set();
  const take = (cls, pred) => {
    const g = vis.filter(c => !used.has(c) && pred(c));
    g.forEach(c => used.add(c));
    if (g.length) groups.push([cls, g]);
  };
  take('cotenant', c => c.cotenant);
  for (const cls of ['added', 'removed', 'freq', 'power', 'antenna', 'site', 'status'])
    take(cls, c => (c.classes || [c.class]).includes(cls));

  const pairSel = `
    <label class="small">Compare
      <select onchange="state.rfc.pairIdx=+this.value;renderMain()">
        ${pairs.map((q, i) => `
          <option value="${i}" ${q === p ? 'selected' : ''}>${esc(q.from)} → ${esc(q.to)}</option>`).join('')}
      </select>
    </label>
    <span class="small" style="color:var(--muted)">extracts ${esc(p.from_date || p.from)} →
      ${esc(p.to_date || p.to)} · grouped by nearest repeater · diff key: EFL_ID /
      device registration id (never SDD_ID)</span>`;

  if (!vis.length) {
    return `<div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">${pairSel}</div>
      <p class="small" style="color:var(--muted);margin-top:.5rem">No register changes near the
      selected repeaters in this pair — the RF licensing picture was stable. If the data-quality
      step falls in this period, that points away from licensed transmitters (see the help
      notes below).</p>`;
  }

  return `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">${pairSel}</div>
    ${groups.map(([cls, g]) => {
      const meta = RFC_CLASS[cls];
      return `
        <div style="margin-top:.7rem">
          <h4 style="margin:0 0 .1rem"><span class="legend-sq" style="background:${meta.color}"></span>
            ${meta.label} (${g.length})</h4>
          <p class="small" style="color:var(--muted);margin:.1rem 0 .3rem">${meta.blurb}</p>
          ${g.slice(0, 200).map(c => rfcChangeRowHtml(c, cls, linkable)).join('')}
          ${g.length > 200 ? `<p class="small" style="color:var(--muted)">…and ${g.length - 200} more.</p>` : ''}
        </div>`;
    }).join('')}`;
}

function rfcChangeRowHtml(c, cls, linkable) {
  const fields = c.fields ? Object.entries(c.fields)
    .filter(([k]) => cls === 'status' ? k === 'status' :
                     cls === 'freq' ? k === 'f_mhz' :
                     cls === 'power' ? (k === 'tx_w' || k === 'eirp_w') :
                     cls === 'antenna' ? ['height_m', 'az', 'tilt', 'ant_id'].includes(k) :
                     cls === 'site' ? k === 'site_id' : true)
    .map(([k, [a, b]]) => `<span style="white-space:nowrap">${RFC_FIELD_LABEL[k] || k}:
      <s style="color:var(--muted)">${esc(a ?? '—')}</s> → <strong>${esc(b ?? '—')}</strong></span>`)
    .join(' · ') : '';
  const link = linkable && c.device_id
    ? ` <a href="#" onclick="RfChanges.cardFor('${escAttr(c.device_id)}','${escAttr(c.anchor || '')}');return false">details →</a>`
    : '';
  return `
    <div class="small" style="margin:.25rem 0;padding-left:.9rem">
      <strong>${esc(c.client || 'Unknown licensee')}</strong>
      · ${c.f_mhz != null ? c.f_mhz.toFixed(4) + ' MHz' : 'freq ?'}
      ${c.eirp_w != null ? `· ${c.eirp_w} W EIRP` : ''}
      · lic ${esc(c.lic || '?')}
      ${c.confidence === 'low' ? ' <span class="badge" title="Matched on a composite fingerprint (licence + site + frequency) because both stable identifiers were missing — treat with caution">low-confidence match</span>' : ''}
      ${c.cotenant ? ' <span class="badge" style="color:#d32f2f">co-tenant</span>' : ''}
      ${link}<br>
      <span style="color:var(--muted)">${esc(c.site_name || c.site_id || '')}
        ${c.anchor ? `· ${c.anchor_km != null ? c.anchor_km + ' km from ' : 'near '}${esc(rfcAnchorName(c.anchor))}` : ''}
        ${c.auth ? `· authorised ${esc(c.auth)}` : ''}</span>
      ${fields ? `<br>${fields}` : ''}
    </div>`;
}

// ── new IMD products panel ──

function rfcImdHtml() {
  const p = rfcSelectedPair();
  const intro = `
    <p class="small" style="color:var(--muted);margin:.2rem 0 .5rem">
      Adding one transmitter to a mast creates a third-order product with <em>every</em>
      carrier already there — the offender is often nowhere near the RX frequency itself.
      Listed below are only the products that are <strong>new in this snapshot pair</strong>
      (created by an added or re-tuned device) and land within tolerance of a repeater RX
      channel.</p>`;
  if (!p) {
    return `${intro}<p class="small" style="color:var(--muted)">Needs two archived snapshots —
      see the snapshot diff panel above.</p>`;
  }
  const latestMonth = (((state.rfc.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;
  const R = state.rfc;
  const vis = (p.new_imd || []).filter(i =>
    (!R.anchorSel.size || R.anchorSel.has(i.anchor)) &&
    (i.anchor_km == null || i.anchor_km <= R.radiusKm));
  if (!vis.length) {
    return `${intro}<p class="small" style="color:var(--muted)">No new intermod products land
      on an RX channel in ${esc(p.from)} → ${esc(p.to)} for the selected repeaters.</p>`;
  }
  return `${intro}
    <div class="table-wrap medium">
      <table class="bf-table">
        <thead><tr><th>Product</th><th>Δ (kHz)</th><th>Order</th><th>Repeater</th>
          <th>Site</th><th>New device</th><th>Existing partner</th></tr></thead>
        <tbody>
          ${vis.slice(0, 300).map(i => `
            <tr>
              <td class="small" style="white-space:nowrap">${esc(i.formula)}</td>
              <td class="small">${i.delta_khz}</td>
              <td class="small">IMD${i.order}</td>
              <td class="small">${esc(rfcAnchorName(i.anchor))} (RX ${i.rx_mhz})</td>
              <td class="small">${esc(i.site_name || i.site_id)}</td>
              <td class="small">${linkable && i.device_id
                ? `<a href="#" onclick="RfChanges.cardFor('${escAttr(i.device_id)}','${escAttr(i.anchor)}');return false">${esc(i.client || i.trigger_key)}</a>`
                : esc(i.client || i.trigger_key)}
                <span class="badge">${i.trigger_class === 'added' ? 'added' : 're-tuned'}</span></td>
              <td class="small">${linkable && i.partner_device_id
                ? `<a href="#" onclick="RfChanges.cardFor('${escAttr(i.partner_device_id)}','${escAttr(i.anchor)}');return false">${esc(i.partner_client || i.partner_key)}</a>`
                : esc(i.partner_client || i.partner_key)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── onset detection helper ──

function rfcParseDate(s) {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);          // dd/mm/yyyy (AU)
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[2] - 1, +m[1]);
  const d = Date.parse(s);
  return isNaN(d) ? null : d;
}

// Accepts "date,value" (single series) or "station,date,value" per line.
function rfcParseCorr(text) {
  const series = {};
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^#/.test(t) || /^station\b/i.test(t) || /^date\b/i.test(t)) continue;
    const parts = t.split(/[,;\t]+/).map(s => s.trim()).filter(Boolean);
    let name = '', ds, vs;
    if (parts.length >= 3) [name, ds, vs] = parts;
    else if (parts.length === 2) [ds, vs] = parts;
    else { bad++; continue; }
    const when = rfcParseDate(ds), v = parseFloat(vs);
    if (when == null || isNaN(v)) { bad++; continue; }
    const key = name || 'pasted series';
    (series[key] = series[key] || []).push({ t: when, v });
  }
  for (const k in series) series[k].sort((a, b) => a.t - b.t);
  return { series, bad };
}

// Rolling-median step detector — deliberately simple. A step is a shift in the
// k-point median exceeding 4× the series' robust noise estimate.
function rfcDetectSteps(series) {
  const med = arr => {
    const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const steps = [];
  for (const [name, pts] of Object.entries(series)) {
    const v = pts.map(p => p.v), n = v.length;
    const k = Math.max(3, Math.min(7, Math.floor(n / 4)));
    if (n < 2 * k) continue;
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push(Math.abs(v[i] - v[i - 1]));
    const noise = Math.max(1.4826 * med(diffs), 1e-9);
    const cand = [];
    for (let i = k; i <= n - k; i++) {
      cand.push({ i, jump: med(v.slice(i, i + k)) - med(v.slice(i - k, i)) });
    }
    cand.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
    const picked = [];
    for (const c of cand) {
      if (Math.abs(c.jump) < 4 * noise) break;
      if (picked.some(p => Math.abs(p.i - c.i) < k)) continue;
      picked.push(c);
      if (picked.length >= 3) break;
    }
    for (const c of picked) {
      steps.push({ station: name, date: new Date(pts[c.i].t).toISOString().slice(0, 10),
                   jump: c.jump });
    }
  }
  steps.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
  return steps;
}

function rfcAnalyseCorr() {
  const R = state.rfc;
  const txt = (document.getElementById('rfc-corr') || {}).value || '';
  R.corrText = txt;
  const { series, bad } = rfcParseCorr(txt);
  R.corrSeries = series;
  R.corrBad = bad;
  R.corrSteps = rfcDetectSteps(series);
  renderMain();
}

function rfcMatchStation(name) {
  const stations = state.data?.stations || [];
  const q = name.toLowerCase();
  return stations.find(s => s.id === name || (s.name || '').toLowerCase() === q) ||
         stations.find(s => (s.name || '').toLowerCase().includes(q)) || null;
}

function rfcOnsetHelperHtml() {
  const R = state.rfc;
  return `
    <p class="small" style="color:var(--muted)">Paste a per-station corruption time series —
      one line per day: <code>date, count</code> or <code>station, date, count</code>
      (ISO or dd/mm/yyyy dates). A rolling-median step detector finds sudden onsets; detected
      dates pre-fill the onset selector, and the series plots in the timeline's data-quality
      band above.</p>
    <textarea id="rfc-corr" rows="5" style="width:100%"
      placeholder="Bluff Ck, 2026-04-01, 0&#10;Bluff Ck, 2026-04-02, 1&#10;Bluff Ck, 2026-04-03, 14&#10;…">${esc(R.corrText)}</textarea>
    <div style="margin:.4rem 0"><button onclick="RfChanges.analyseCorr()">Detect steps</button></div>
    ${R.corrSteps === null ? '' : rfcStepsHtml()}`;
}

function rfcStepsHtml() {
  const R = state.rfc;
  const nSeries = Object.keys(R.corrSeries || {}).length;
  if (!nSeries) {
    return `<p class="small" style="color:var(--muted)">No parseable lines${R.corrBad ? ` (${R.corrBad} rejected)` : ''}.</p>`;
  }
  const stepsHtml = R.corrSteps.length ? `
    <div class="small" style="margin:.3rem 0">Detected steps (largest first — click to set as onset):</div>
    <div style="display:flex;gap:.4rem;flex-wrap:wrap">
      ${R.corrSteps.map(s => `
        <button class="small" onclick="RfChanges.useOnset('${escAttr(s.date)}')"
                title="Rolling-median shift of ${s.jump > 0 ? '+' : ''}${s.jump.toFixed(1)} at ${escAttr(s.station)}">
          ${esc(s.date)} · ${esc(s.station)} ${s.jump > 0 ? '▲' : '▼'}${Math.abs(s.jump).toFixed(1)}</button>`).join('')}
    </div>` : `
    <p class="small" style="color:var(--muted)">No step larger than 4× the noise floor found in
      ${nSeries} series${R.corrBad ? ` (${R.corrBad} lines rejected)` : ''} — the change may be
      gradual rather than a step, which points away from a switched-on transmitter.</p>`;
  return stepsHtml + rfcGroupingHtml();
}

// If every affected station reports through the same repeater, the search
// narrows to one site — corruption confined to one repeater's children is
// strong evidence for a specific site rather than a network-wide problem.
function rfcGroupingHtml() {
  const R = state.rfc;
  const names = Object.keys(R.corrSeries || {}).filter(n => n !== 'pasted series');
  if (!names.length || !state.data) return '';
  const rows = names.map(n => {
    const st = rfcMatchStation(n);
    const reps = st ? findRepeaterMatches(st) : [];
    return { n, st, reps };
  });
  const matched = rows.filter(r => r.st && r.reps.length);
  let commonHtml = '';
  if (matched.length > 1) {
    const common = matched[0].reps.filter(r =>
      matched.every(m => m.reps.some(x => x.id === r.id)));
    if (common.length) {
      const c = common[0];
      const isAnchor = !!state.acma.anchorById[c.id];
      commonHtml = `
        <p class="small" style="margin:.4rem 0">
          ⚑ <strong>All ${matched.length} matched stations report through
          ${esc(c.name)}</strong> — corruption confined to one repeater's stations is strong
          evidence for something at or near that specific site.
          ${isAnchor ? `<button class="small" onclick="RfChanges.focusAnchor('${escAttr(c.id)}')">Focus ${esc(c.name)}</button>`
                     : `<span style="color:var(--muted)">(${esc(c.name)} has no RX frequency recorded, so it is not in the ACMA threat layer — record repeater.rx_mhz to include it.)</span>`}
        </p>`;
    } else {
      commonHtml = `
        <p class="small" style="color:var(--muted);margin:.4rem 0">
          The affected stations do not share a single repeater — that spreads the search across
          sites, or points to something common to the receive side (base station, decoder) rather
          than one repeater's RF environment.</p>`;
    }
  }
  return `
    <div style="margin-top:.5rem">
      <div class="small" style="color:var(--muted)">Which repeater serves each affected station:</div>
      <table class="bf-table" style="margin-top:.2rem">
        <thead><tr><th>Series</th><th>Matched station</th><th>Serving repeater(s)</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="small">${esc(r.n)}</td>
              <td class="small">${r.st ? esc(r.st.name) : '<span style="color:var(--muted)">no match in stations.json</span>'}</td>
              <td class="small">${r.reps.length ? r.reps.map(x => esc(x.name)).join(', ')
                : '<span style="color:var(--muted)">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${commonHtml}
    </div>`;
}

// ── help ──

function rfcHelpHtml() {
  return `
    <details>
      <summary style="cursor:pointer"><strong>What this page will not catch</strong>
        <span class="small" style="color:var(--muted)">— read before trusting an empty result</span></summary>
      <div class="small" style="color:var(--muted);margin-top:.4rem">
        <p><strong>Anything unlicensed or faulty.</strong> Solar charge controllers, VMS/LED sign
        drivers, electric fence energisers, powerline arcing, out-of-spec or failing equipment —
        the most common sources of a raised noise floor at a remote gauging site — never appear
        in the register.</p>
        <p><strong>Removals and prior values before archiving began.</strong> ACMA publishes a
        daily snapshot with no back-catalogue; history exists only from the first archived month
        onward (see the snapshot index in the diff panel). Nothing recovers earlier months.</p>
        <p><strong>Physical installation dates.</strong> An authorisation date is when the
        paperwork was approved. Transmitters go live months later, or never.</p>
        <p><strong>Amateur transmissions.</strong> Not recorded by location — the
        50.5 MHz × 3 = 151.5 MHz harmonic path needs a spectrum sweep, not this register.</p>
        <p><strong>Degradation with no register event at all.</strong> Corroding mast joints
        maturing into an intermod mixer, a failing PA growing spurious emissions, water in a
        feeder. <strong>A step change in noise floor with no ACMA event nearby is itself a
        finding</strong> — it points at your own infrastructure, and this page says so rather
        than returning a bare empty table.</p>
        <p>Data: ACMA Register of Radiocommunications Licences (CC BY 4.0). Licensee details must
        not be used for unsolicited contact (Spam Act 2003 / DNCR Act 2006).</p>
      </div>
    </details>`;
}

// ── public surface ─────────────────────────────────────────────────────────────
// Thirteen of the forty names above. The other twenty-seven are private to this
// IIFE, which is the point of M4 (#135) — 111 globals across this file and the
// Workbench became two.
//
// Left column is what the rest of the app says; right column is the name it has
// in here. Anything reached from an inline on*= attribute is marked, because
// those resolve against the *global* scope at click time: rename one of those
// members and the template string naming it has to change in the same edit, or
// the button goes quiet with nothing thrown until someone presses it.
return {
  render:           renderRfcHtml,        // renderMain()
  init:             initRfc,              // renderMain()
  ensureData:       rfcEnsureData,        // Workbench.init()
  anchorName:       rfcAnchorName,        // Workbench, in its ACMA suspects table
  helpHtml:         rfcHelpHtml,          // Workbench, in its blind-spots panel
  // ── inline on*= handlers ──
  sort:             rfcSort,              // table header
  selectAllAnchors: rfcSelectAllAnchors,  // repeater selector
  toggleAnchor:     rfcToggleAnchor,      // repeater selector
  focusAnchor:      rfcFocusAnchor,       // grouping panel
  useOnset:         rfcUseOnset,          // step-detector suggestion
  cardFor:          rfcCardFor,           // chart marks, table rows, IMD pairs
  exportCsv:        rfcExportCsv,         // toolbar
  analyseCorr:      rfcAnalyseCorr,       // onset helper
};

})();

