// MegaNet — rf-changes.js
//
//   RfChanges   the RF Changes tab: what changed on the air near this repeater
//               around the date the data went bad. A timeline of ACMA
//               authorisation dates, diffs between archived monthly snapshots,
//               an intermod screen and a step detector for a pasted corruption
//               series.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for ACMA_MECH, acmaMechColor, acmaMechVar, cssVar,
// csvEscape, dlText, esc, escAttr and state; and across to app.js for
// acmaEnsureCore, acmaFetchJson, findRepeaterMatches, renderMain and
// showAcmaCard. Four of those five are the ACMA RRL layer, which is still in
// app.js — #138 took it and did not move it, for the reason under "U3" below.
//
// ── U3 (#138): layout, mobile and accessibility ──────────────────────────────
// What this tab was: 1,987 inline styles under a filter the check can see (536
// of them a legend swatch's own `background:`), a repeater picker that scrolled
// the whole document sideways by 520 px on a phone the moment it was opened,
// ten mouse-only sort headers, 550 rows openable by mouse only, a timeline in a
// `div{overflow-x:auto}` no keyboard could scroll whose accessible name was the
// same eleven words whether it drew nothing or eight hundred marks, and eight
// series colours in a JavaScript array that the dark theme could not reach.
//
// What it is now is #109's system applied, with three additions made to the
// system rather than to this tab — patterns 10 (a sortable header is a button)
// and 11 (a wide graphic scrolls in a named region), and the ACMA mechanism
// palette as tokens. All three are in docs/design-system.md, because #136,
// #139 and #140 each have at least one of the same three problems.
//
// The two things worth knowing before touching it again:
//
//   The chart's part 3 is the table below it, not a <details> of its own. The
//   coincidence table already lists every event the timeline draws, row for
//   row; a second copy would be a second thing to keep in step. The name says
//   so, which is what #138's issue asked for — "wire them together explicitly
//   rather than leaving it implied".
//
//   The marks stay clickable and stay out of the tab order, which is pattern 8
//   and legal here for the same reason it was legal on the basin drawing: every
//   mark opens the transmitter card, and so does every row of that table. If a
//   mark ever gains an operation the table does not have, role="img" becomes a
//   lie and the pattern stops covering it.
//
// The IIFE body declares and calls nothing at load — 41 statements, 35 function
// declarations and 5 constants and the return — so this file's position among
// the modules is free. Workbench holds a reference to RfChanges and never
// dereferences one until a tab renders, so it may load either side of this.
//
// 13 of the 40 names inside are public. Five are called from code (render and
// init from renderMain, and ensureData / anchorName / helpHtml from the
// Workbench); the other eight exist only to be named by an inline on*=
// attribute. Those eight resolve against the *global* scope at click time, so
// renaming one means rewriting the template string that names it in the same
// edit — otherwise the control goes quiet with nothing thrown until someone
// presses it. test/lib/controls.mjs presses all of them but focusAnchor, and
// says why that one is left.
//
// Not indented into the IIFE. Nearly all of these lines are inside multi-line
// template literals, so shifting them by two spaces would rewrite the HTML this
// file emits — a change to what the app produces dressed as formatting. The
// other fifteen module IIFEs indent because they were written that way, not
// because they were re-indented.
//
// Wrapped in an IIFE and moved out of app.js by M4 (#135) of #129 — the last
// child of that epic, and the only one that was a refactor rather than a move.

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

// The eight change-class swatches. `token` rather than a literal for the same
// reason ACMA_MECH grew one at #138: these are drawn as a `--dot` on a
// .legend-sq, which is a CSS context, so the token can reach the element
// directly and follow the theme with no repaint at all. There is no `color`
// alongside them because — unlike the mechanisms — nothing draws these into a
// Leaflet option or an SVG attribute; the swatch is the only consumer.
const RFC_CLASS = {
  cotenant: { label: 'New co-tenant at a repeater site', token: '--rfc-class-cotenant',
              blurb: 'A transmitter added at a site co-located with a repeater — the highest-severity change: front-end desense plus a new intermod pair with every existing carrier on the mast.' },
  added:    { label: 'Added',                  token: '--rfc-class-added',
              blurb: 'Assignment present now, absent in the earlier snapshot — a newly commissioned transmitter.' },
  removed:  { label: 'Removed',                token: '--rfc-class-removed',
              blurb: 'Assignment gone from the register — the only way a decommissioning is ever visible.' },
  freq:     { label: 'Frequency changed',      token: '--rfc-class-freq',
              blurb: 'May have moved onto or off a MegaNet channel.' },
  power:    { label: 'Power changed',          token: '--rfc-class-power',
              blurb: 'TX power or EIRP differs — direct noise-floor impact.' },
  antenna:  { label: 'Antenna changed',        token: '--rfc-class-antenna',
              blurb: 'Height, azimuth, tilt or antenna model differs — a re-point toward a repeater or extended reach.' },
  site:     { label: 'Site moved',             token: '--rfc-class-site',
              blurb: 'Assignment relocated to a different site, possibly a repeater mast.' },
  status:   { label: 'Licence status changed', token: '--rfc-class-status',
              blurb: 'Lapsed, surrendered or reinstated.' },
};

const RFC_FIELD_LABEL = {
  f_mhz: 'Frequency (MHz)', tx_w: 'TX power (W)', eirp_w: 'EIRP (W)',
  height_m: 'Antenna height (m)', az: 'Azimuth (°)', tilt: 'Tilt (°)',
  ant_id: 'Antenna', site_id: 'Site', status: 'Licence status',
};

// The eight data-quality series colours are --rfc-series-1…8 now (#138), for
// the reason #141 gave about the twelve ARRO ones: an array in a script cannot
// follow the theme, and these are drawn as `stroke=` — a presentation
// attribute, where a var() resolves to nothing — so they are resolved off the
// document at draw time instead. #5d4037 on a #18222d panel was a brown line
// nobody could see, and the chart redraws on every filter change anyway.
//
// The dash patterns are the other half, and they are not decoration: two
// corruption series drawn in two hues are one series to a red-green dichromat
// and to the greyscale printer an incident report usually comes off. Cycled
// with the colours, and — like arro-data.js — off when there is only one series,
// because a lone dashed line says "provisional" and means nothing of the kind.
const RFC_SERIES_DASH = ['', '7 4', '2 3', '10 3 2 3', '4 3', '12 4', '2 2 8 2', '6 2'];
const RFC_MARK_CAP = 800;
const RFC_DAY = 86400000;

function rfcSeriesColor(i) {
  return cssVar(`--rfc-series-${(i % 8) + 1}`, '#0b5cab');
}

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
  // The button that was just pressed no longer exists; without this a keyboard
  // sort drops the user on <body>, exactly as a tab switch used to (#109 §4).
  const btn = wrap && wrap.querySelector(`.th-sort[data-key="${CSS.escape(key)}"]`);
  if (btn) btn.focus();
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
      <div class="page" style="--page-max:640px">
        <div class="panel rf-loading">
          <h2>RF Changes</h2>
          <p class="small txt-muted">${esc(msg)}</p>
        </div>
      </div>`;
  }
  return `
    <div class="page rfc-page" style="--page-max:1400px">
      <div class="panel">
        <div class="panel-header"><h2>RF Changes — what changed on the air, and when</h2>
          <span class="small txt-muted">ACMA data: ${esc(R.timeline.meta.source_date)} · CC BY 4.0</span>
        </div>
        <p class="small txt-muted rfc-intro">
          Register dates are <strong>administrative</strong>: an authorisation date is an upper
          bound on when a transmitter could have come on air — licences are often authorised
          before installation (or never installed), and equipment can radiate with no register
          entry at all. A date that lines up with a data-quality step is a
          <strong>lead to investigate</strong>, never a conclusion.</p>
        ${rfcSelectorHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rfc-chart-h">Timeline — authorisations vs data quality</h3></div>
        ${rfcChartHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rfc-table-h">${R.onset ? 'Coincidence ranking' : 'Authorisation events'}</h3>
          <span class="button-group">
            ${R.onset ? `<span class="small txt-muted"
                  title="coincidence = interference score × temporal proximity × co-site bonus. Proximity decays linearly from 1 at the onset date to 0 at the window edge; ×1.5 bonus when the transmitter shares the repeater's site (≤250 m).">
              ranking formula ⓘ</span>` : ''}
            <button type="button" onclick="RfChanges.exportCsv()">Export CSV</button>
          </span>
        </div>
        ${R.onset ? '' : `<p class="small txt-muted rfc-note">
          Set an onset date above (or detect one below) to rank these by coincidence with the
          data-quality step. This table is the evidence you would attach to an ACMA
          interference complaint.</p>`}
        <div class="table-wrap tall" id="rfc-table-wrap"
             role="region" tabindex="0" aria-labelledby="rfc-table-h">${rfcTableInnerHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rfc-diff-h">Snapshot diff — observed register changes</h3></div>
        ${rfcDiffHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rfc-imd-h">New intermod products</h3></div>
        ${rfcImdHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3 id="rfc-onset-h">Onset detection helper</h3></div>
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
    <div class="control-row rfc-controls">
      <details class="rfc-picker" ${R.pickerOpen ? 'open' : ''} ontoggle="state.rfc.pickerOpen=this.open">
        <summary class="small">Repeaters:
          <strong>${R.anchorSel.size ? `${R.anchorSel.size} selected` : 'all'}</strong></summary>
        <div class="rfc-picker-list" role="group" aria-label="Which repeaters to include">
          <label class="rfc-pick">
            <input type="checkbox" ${R.anchorSel.size ? '' : 'checked'}
                   onchange="RfChanges.selectAllAnchors()"> <em>All repeaters</em></label>
          ${anchors.map(a => `
            <label class="rfc-pick">
              <input type="checkbox" ${R.anchorSel.has(a.station_id) ? 'checked' : ''}
                     onchange="RfChanges.toggleAnchor('${escAttr(a.station_id)}',this.checked)">
              ${esc(a.name)}${a.rx_mhz ? ` <span class="small txt-muted">${a.rx_mhz}</span>` : ''}
            </label>`).join('')}
        </div>
      </details>
      <label>Onset date
        <input type="date" value="${esc(R.onset)}"
               onchange="state.rfc.onset=this.value;renderMain()">
      </label>
      <label>Window
        <select onchange="state.rfc.windowDays=+this.value;renderMain()">
          ${[30, 60, 90, 180].map(w => `
            <option value="${w}" ${R.windowDays === w ? 'selected' : ''}>±${w} days</option>`).join('')}
        </select>
      </label>
      <label>Radius
        <select onchange="state.rfc.radiusKm=+this.value;renderMain()">
          ${[10, 25, 50, 60].map(r => `
            <option value="${r}" ${R.radiusKm === r ? 'selected' : ''}>${r} km</option>`).join('')}
        </select>
      </label>
      <label>Min score
        <input type="number" min="0" max="100" step="5" class="field-num" value="${R.minScore}"
               onchange="state.rfc.minScore=+this.value;renderMain()">
      </label>
      ${R.onset ? `<button type="button" class="small" onclick="state.rfc.onset='';renderMain()">
        <span aria-hidden="true">×</span> clear onset</button>` : ''}
    </div>`;
}

// ── timeline chart ──
// Upper band: one mark per device authorisation, one lane per interference
// mechanism, sized by score. Thin lane: licence effect/expiry as lighter marks.
// Lower band: the pasted per-station corruption series, so a coincidence
// between paperwork and data quality is visible at a glance.

// Parts 1 and 2 of the chart pattern (docs/design-system.md §3), rebuilt from
// the same numbers the picture is drawn from. The old name was
// `aria-label="ACMA authorisation events and data quality over time"` — a fixed
// string, true of an empty chart and of eight hundred marks alike, which is the
// exact failure #141 found on the ARRO chart and wrote the rule against.
//
// Part 3 is not a <details> here, because it already exists: the coincidence
// table in the next panel *is* this chart's data, row for row, and a second
// copy would be a second thing to keep in step. The name says so and points at
// it, which is what #138's issue asked for — "wire them together explicitly
// rather than leaving it implied".
//
// The one part of the picture the table does not hold is the lower band, the
// pasted corruption series. That has no second home, so the name carries its
// shape: how many series, and over what range.
function rfcChartName(f) {
  const R = state.rfc;
  const span = `${rfcFmtDate(f.lo)} to ${rfcFmtDate(f.hi)}`;
  const marks = f.inSpan.length === f.shown.length
    ? `${f.shown.length} authorisation event${f.shown.length === 1 ? '' : 's'}`
    : `${f.shown.length} of ${f.inSpan.length} authorisation events`;
  const lanes = f.lanes.map(m => (ACMA_MECH[m] || {}).label || m).join(', ');
  const band = f.series.length
    ? `The lower band plots ${f.series.length} pasted data-quality series — ${
        f.series.map(([n]) => n).join(', ')} — peaking at ${f.vmax}.`
    : 'The lower band is empty: no data-quality series has been pasted into the onset helper below.';
  const onset = R.onset
    ? `The onset is marked at ${esc(R.onset)}, with the ±${R.windowDays}-day window shaded.`
    : 'No onset date is set, so the view is the last 24 months.';
  // …and the sentence pattern 8 asks for: a graphic whose marks can be clicked
  // is named as a picture only while every operation it offers is on a named
  // control beside it. Every mark opens the transmitter card, and so does every
  // row of the table below — which is why no mark is a tab stop.
  return `Timeline, ${span}. ${marks}, in ${f.lanes.length} mechanism lane${
    f.lanes.length === 1 ? '' : 's'}: ${lanes}. Mark size is the interference score. `
    + `${onset} ${band} Every event drawn here is a row of the coincidence table below, `
    + `which is where the numbers are and where each one opens its transmitter card.`;
}

function rfcFmtDate(ms) {
  const d = new Date(ms);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

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

  const marker = cssVar('--chart-marker', '#c62828');
  const shade = onsetMs ? `
    <rect x="${x(onsetMs - R.windowDays * RFC_DAY)}" y="0"
          width="${x(onsetMs + R.windowDays * RFC_DAY) - x(onsetMs - R.windowDays * RFC_DAY)}"
          height="${axisY}" class="chart-band"/>
    <line x1="${x(onsetMs)}" y1="0" x2="${x(onsetMs)}" y2="${axisY}"
          stroke="${marker}" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="${x(onsetMs)}" y="${axisY + 22}" font-size="10" text-anchor="middle"
          fill="${marker}">onset</text>` : '';

  const shown = inSpan.slice(0, RFC_MARK_CAP);
  const marks = shown.map(r => {
    const t = Date.parse(r.e.date);
    const rad = 3 + Math.min(6, r.a.score / 15);
    // Resolved rather than referenced: `fill="var(--acma-mech-imd3)"` on an SVG
    // presentation attribute draws nothing.
    const c = acmaMechColor(r.a.mech);
    return `<circle cx="${x(t).toFixed(1)}" cy="${laneY(r.a.mech) + laneH / 2}" r="${rad.toFixed(1)}"
      fill="${c}" opacity=".75" class="rfc-mark"
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
        class="chart-line" stroke-width="1" opacity=".45">
        <title>${esc(d)} · licence ${d === r.e.lic_effect ? 'effect' : 'expiry'} · ${esc(r.e.client || r.e.lic || '')}</title></line>`;
    }
  }

  // lower band — corruption series
  let lower = '';
  const series = Object.entries(R.corrSeries || {}).filter(([, pts]) => pts.length)
    .slice(0, RFC_SERIES_DASH.length);
  let vmax = 0;
  if (series.length) {
    for (const [, pts] of series) for (const p of pts) vmax = Math.max(vmax, p.v);
    vmax = vmax || 1;
    lower = series.map(([name, pts], i) => {
      const col = rfcSeriesColor(i);
      const vis = pts.filter(p => p.t >= lo && p.t <= hi);
      const path = vis.map(p =>
        `${x(p.t).toFixed(1)},${(lowerTop + lowerH - 4 - p.v / vmax * (lowerH - 10)).toFixed(1)}`).join(' ');
      // One series is the case where a dash means nothing, so it is not drawn —
      // a lone dashed line reads as "provisional" (arro-data.js does the same).
      const dash = series.length > 1 && RFC_SERIES_DASH[i]
        ? ` stroke-dasharray="${RFC_SERIES_DASH[i]}"` : '';
      return `<polyline points="${path}" fill="none" stroke="${col}" stroke-width="1.6"${dash} opacity=".85">
        <title>${esc(name)}</title></polyline>`;
    }).join('');
  } else {
    lower = `<text x="${PADL + 8}" y="${lowerTop + lowerH / 2}" font-size="11"
      class="chart-muted">No data-quality series loaded — paste per-station corruption
      counts in the onset helper below to see coincidence at a glance.</text>`;
  }

  const legend = series.length ? `
    <ul class="rfc-legend small">
      ${series.map(([name], i) => `
        <li class="legend-item"><span class="rfc-series-line"
          style="--dot:var(--rfc-series-${(i % 8) + 1})"></span>${esc(name)}</li>`).join('')}
    </ul>` : '';

  const facts = { lo, hi, inSpan, shown, lanes, series, vmax };
  return `
    <div class="chart-scroll" role="region" tabindex="0"
         aria-label="Timeline, two years wide at its widest — scroll sideways to read the whole
                     span. The picture inside describes itself, and the coincidence table below
                     is the same events as rows.">
      <svg viewBox="0 0 ${W} ${H}" class="rfc-chart-svg" role="img"
           aria-label="${escAttr(rfcChartName(facts))}">
        ${shade}
        ${ticks.map(t => `
          <line x1="${x(t).toFixed(1)}" y1="0" x2="${x(t).toFixed(1)}" y2="${axisY}"
                class="chart-grid" stroke-width="1" opacity=".6"/>
          <text x="${x(t).toFixed(1)}" y="${axisY + 12}" font-size="10" text-anchor="middle"
                class="chart-muted">${tickLabel(t)}</text>`).join('')}
        ${lanes.map(m => `
          <rect x="4" y="${laneY(m) + laneH / 2 - 4}" width="9" height="9"
                fill="${acmaMechColor(m)}"/>
          <text x="17" y="${laneY(m) + laneH / 2 + 3}" font-size="10"
                class="chart-text">${esc((ACMA_MECH[m] || {}).label || m)}</text>
          <line x1="${PADL}" y1="${laneY(m) + laneH}" x2="${W - PADR}" y2="${laneY(m) + laneH}"
                class="chart-grid" stroke-width=".5" opacity=".5"/>`).join('')}
        <text x="4" y="${licY + 12}" font-size="10" class="chart-muted">licence dates</text>
        ${licMarks}
        <text x="4" y="${lowerTop + 10}" font-size="10" class="chart-muted">data quality</text>
        <line x1="${PADL}" y1="${lowerTop + lowerH}" x2="${W - PADR}" y2="${lowerTop + lowerH}"
              class="chart-line" stroke-width="1"/>
        ${lower}
        ${marks}
      </svg>
    </div>
    ${legend}
    <p class="small txt-muted">
      ${shown.length}${inSpan.length > shown.length ? ` of ${inSpan.length}` : ''} authorisation
      events in view · mark size = interference score · choose a mark, or a row of the table
      below, for the transmitter card.
      ${onsetMs ? 'Shaded band = the selected onset window.' : 'Showing the last 24 months — set an onset date to zoom.'}</p>`;
}

// ── coincidence table ──

// Pattern 10 (#138) — see rfSortTh in app.js, which is the same shape on the
// same kind of table one tab over. aria-sort goes on the <th>; the button takes
// the press; the arrow is aria-hidden because aria-sort has already said it.
function rfcSortTh(k, label, tip, cls = '') {
  const R = state.rfc;
  const on = R.sortKey === k;
  const dir = R.sortDir > 0 ? 'ascending' : 'descending';
  return `<th scope="col"${cls ? ` class="${cls}"` : ''}${on ? ` aria-sort="${dir}"` : ''}${
    tip ? ` title="${escAttr(tip)}"` : ''}>
    <button type="button" class="th-sort" data-key="${k}" onclick="RfChanges.sort('${k}')">${label}${
      on ? `<span class="th-arrow" aria-hidden="true">${R.sortDir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`;
}

const RFC_SORT_LABEL = {
  date: 'authorisation date', days: 'days from onset', client: 'licensee', f: 'frequency',
  delta: 'frequency offset', mech: 'mechanism', eirp: 'EIRP', km: 'distance',
  score: 'interference score', coin: 'coincidence',
};

function rfcTableInnerHtml() {
  const R = state.rfc;
  const rows = rfcTableRows();
  if (!rows.length) {
    return R.onset ? `
      <div class="table-empty">
        <p><strong>No register events near this onset.</strong></p>
        <p class="small txt-muted">A noise-floor step with no ACMA event nearby
        is itself a finding: it points away from licensed transmitters and toward your own
        infrastructure (corroding mast joints becoming an intermod mixer, a failing PA, water
        in a feeder) or an unlicensed emitter (solar charge controllers, LED signage, electric
        fences, powerline arcing). Widen the window or lower the minimum score to double-check
        before concluding.</p>
      </div>` :
      `<p class="small table-empty">No authorisation events match the current
        filters — widen the radius or lower the minimum score.</p>`;
  }
  const shown = rows.slice(0, 1000);
  return `
    <table class="bf-table">
      <caption class="sr-only">${R.onset ? 'Coincidence ranking' : 'Authorisation events'},
        ${shown.length === rows.length ? `${rows.length} rows` : `the first 1,000 of ${rows.length} rows`},
        sorted by ${esc(RFC_SORT_LABEL[R.sortKey] || R.sortKey)},
        ${R.sortDir > 0 ? 'lowest' : 'highest'} first. Choose a date to open that
        transmitter's details.</caption>
      <thead><tr>
        ${rfcSortTh('date', 'Authorised', 'DEVICE_DETAILS.AUTHORISATION_DATE — when the frequency assignment was approved (administrative)')}
        ${R.onset ? rfcSortTh('days', 'Δdays') : ''}
        ${rfcSortTh('client', 'Licensee')}${rfcSortTh('f', 'Freq (MHz)')}${rfcSortTh('delta', 'Δf (kHz)')}
        ${rfcSortTh('mech', 'Mechanism')}${rfcSortTh('eirp', 'EIRP (W)', '', 'col-optional')}${rfcSortTh('km', 'Dist (km)')}
        ${rfcSortTh('score', 'Score')}
        ${R.onset ? rfcSortTh('coin', 'Coincidence', 'score × temporal proximity (linear decay to 0 at window edge) × 1.5 co-site bonus') : ''}
      </tr></thead>
      <tbody>
        ${shown.map(r => {
          const m = ACMA_MECH[r.a.mech] || { label: r.a.mech };
          const dk = rfcDeltaKhz(r);
          // Pattern 7b: the row keeps its handler so a mouse can hit anywhere,
          // and the date cell holds the half a keyboard can reach.
          return `<tr class="row-link"
                      onclick="RfChanges.cardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
            <td class="small"><button type="button" class="row-open"
                    onclick="event.stopPropagation();RfChanges.cardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')"
                    title="Transmitter details for ${escAttr(r.e.client || r.e.lic || 'this device')}">${esc(r.e.date)}</button>${
              r.e.variation ? ' <span class="badge" title="Authorised >30 days after the licence was issued — a variation to an existing licence (added channel, power change, re-point), not a new licence">var</span>' : ''}</td>
            ${R.onset ? `<td class="small">${r.coin.days > 0 ? '+' : ''}${r.coin.days}</td>` : ''}
            <td class="small">${esc(r.e.client || '')}</td>
            <td class="small">${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) : ''}</td>
            <td class="small">${dk != null ? dk.toFixed(1) : '—'}</td>
            <td class="small"><span class="legend-sq" style="--dot:${acmaMechVar(r.a.mech)}"></span> ${m.label}</td>
            <td class="small col-optional">${r.e.eirp_w ?? r.e.tx_w ?? ''}</td>
            <td class="small">${r.a.km}${r.a.km <= 0.25 ? ' <span class="badge">co-site</span>' : ''}</td>
            <td>${r.a.score}</td>
            ${R.onset ? `<td><strong>${r.coin.value.toFixed(1)}</strong></td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${rows.length > shown.length ? `<p class="small table-empty txt-muted">Showing 1,000 of
      ${rows.length} — tighten the filters or export the CSV for the rest.</p>` : ''}`;
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
    <p class="small txt-muted">
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
    <label>Compare
      <select onchange="state.rfc.pairIdx=+this.value;renderMain()">
        ${pairs.map((q, i) => `
          <option value="${i}" ${q === p ? 'selected' : ''}>${esc(q.from)} → ${esc(q.to)}</option>`).join('')}
      </select>
    </label>
    <span class="small txt-muted">extracts ${esc(p.from_date || p.from)} →
      ${esc(p.to_date || p.to)} · grouped by nearest repeater · diff key: EFL_ID /
      device registration id (never SDD_ID)</span>`;

  if (!vis.length) {
    return `<div class="control-row">${pairSel}</div>
      <p class="small txt-muted">No register changes near the
      selected repeaters in this pair — the RF licensing picture was stable. If the data-quality
      step falls in this period, that points away from licensed transmitters (see the help
      notes below).</p>`;
  }

  return `
    <div class="control-row">${pairSel}</div>
    ${groups.map(([cls, g]) => {
      const meta = RFC_CLASS[cls];
      return `
        <div class="rfc-diff-group">
          <h4><span class="legend-sq" style="--dot:var(${meta.token})"></span>
            ${meta.label} (${g.length})</h4>
          <p class="small txt-muted rfc-diff-blurb">${meta.blurb}</p>
          ${g.slice(0, 200).map(c => rfcChangeRowHtml(c, cls, linkable)).join('')}
          ${g.length > 200 ? `<p class="small txt-muted">…and ${g.length - 200} more.</p>` : ''}
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
    .map(([k, [a, b]]) => `<span class="rfc-field">${RFC_FIELD_LABEL[k] || k}:
      <s class="txt-muted">${esc(a ?? '—')}</s> → <strong>${esc(b ?? '—')}</strong></span>`)
    .join(' · ') : '';
  const link = linkable && c.device_id
    ? ` <button type="button" class="link-btn"
            onclick="RfChanges.cardFor('${escAttr(c.device_id)}','${escAttr(c.anchor || '')}')"
            aria-label="Transmitter details for ${escAttr(c.client || 'this licensee')} at ${
              escAttr(c.site_name || c.site_id || 'this site')}">details →</button>`
    : '';
  return `
    <div class="small rfc-change">
      <strong>${esc(c.client || 'Unknown licensee')}</strong>
      · ${c.f_mhz != null ? c.f_mhz.toFixed(4) + ' MHz' : 'freq ?'}
      ${c.eirp_w != null ? `· ${c.eirp_w} W EIRP` : ''}
      · lic ${esc(c.lic || '?')}
      ${c.confidence === 'low' ? ' <span class="badge" title="Matched on a composite fingerprint (licence + site + frequency) because both stable identifiers were missing — treat with caution">low-confidence match</span>' : ''}
      ${c.cotenant ? ' <span class="badge txt-bad">co-tenant</span>' : ''}
      ${link}<br>
      <span class="txt-muted">${esc(c.site_name || c.site_id || '')}
        ${c.anchor ? `· ${c.anchor_km != null ? c.anchor_km + ' km from ' : 'near '}${esc(rfcAnchorName(c.anchor))}` : ''}
        ${c.auth ? `· authorised ${esc(c.auth)}` : ''}</span>
      ${fields ? `<br>${fields}` : ''}
    </div>`;
}

// ── new IMD products panel ──

function rfcImdHtml() {
  const p = rfcSelectedPair();
  const intro = `
    <p class="small txt-muted rfc-note">
      Adding one transmitter to a mast creates a third-order product with <em>every</em>
      carrier already there — the offender is often nowhere near the RX frequency itself.
      Listed below are only the products that are <strong>new in this snapshot pair</strong>
      (created by an added or re-tuned device) and land within tolerance of a repeater RX
      channel.</p>`;
  if (!p) {
    return `${intro}<p class="small txt-muted">Needs two archived snapshots —
      see the snapshot diff panel above.</p>`;
  }
  const latestMonth = (((state.rfc.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;
  const R = state.rfc;
  const vis = (p.new_imd || []).filter(i =>
    (!R.anchorSel.size || R.anchorSel.has(i.anchor)) &&
    (i.anchor_km == null || i.anchor_km <= R.radiusKm));
  if (!vis.length) {
    return `${intro}<p class="small txt-muted">No new intermod products land
      on an RX channel in ${esc(p.from)} → ${esc(p.to)} for the selected repeaters.</p>`;
  }
  const shown = vis.slice(0, 300);
  const devBtn = (id, anchor, label, what) => linkable && id
    ? `<button type="button" class="link-btn"
           onclick="RfChanges.cardFor('${escAttr(id)}','${escAttr(anchor)}')"
           aria-label="Transmitter details for the ${what}, ${escAttr(label)}">${esc(label)}</button>`
    : esc(label);
  return `${intro}
    <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="rfc-imd-h">
      <table class="bf-table">
        <caption class="sr-only">${shown.length === vis.length
          ? `${vis.length} new intermod products` : `the first 300 of ${vis.length} new intermod products`}
          landing on a repeater receive channel between ${esc(p.from)} and ${esc(p.to)}.</caption>
        <thead><tr><th scope="col">Product</th><th scope="col">Δ (kHz)</th><th scope="col">Order</th>
          <th scope="col">Repeater</th><th scope="col" class="col-optional">Site</th>
          <th scope="col">New device</th><th scope="col">Existing partner</th></tr></thead>
        <tbody>
          ${shown.map(i => `
            <tr>
              <td class="small rfc-formula">${esc(i.formula)}</td>
              <td class="small">${i.delta_khz}</td>
              <td class="small">IMD${i.order}</td>
              <td class="small">${esc(rfcAnchorName(i.anchor))} (RX ${i.rx_mhz})</td>
              <td class="small col-optional">${esc(i.site_name || i.site_id)}</td>
              <td class="small">${devBtn(i.device_id, i.anchor, i.client || i.trigger_key, 'newly added or re-tuned device')}
                <span class="badge">${i.trigger_class === 'added' ? 'added' : 're-tuned'}</span></td>
              <td class="small">${devBtn(i.partner_device_id, i.anchor, i.partner_client || i.partner_key, 'existing partner carrier')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${vis.length > shown.length ? `<p class="small table-empty txt-muted">Showing 300 of
      ${vis.length} — narrow the repeater selection or the radius for the rest.</p>` : ''}`;
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
    <p class="small txt-muted">Paste a per-station corruption time series —
      one line per day: <code>date, count</code> or <code>station, date, count</code>
      (ISO or dd/mm/yyyy dates). A rolling-median step detector finds sudden onsets; detected
      dates pre-fill the onset selector, and the series plots in the timeline's data-quality
      band above.</p>
    <label class="sr-only" for="rfc-corr">Corruption counts, one line per day</label>
    <textarea id="rfc-corr" rows="5"
      placeholder="Bluff Ck, 2026-04-01, 0&#10;Bluff Ck, 2026-04-02, 1&#10;Bluff Ck, 2026-04-03, 14&#10;…">${esc(R.corrText)}</textarea>
    <div class="button-group rfc-analyse"><button type="button" onclick="RfChanges.analyseCorr()">Detect steps</button></div>
    ${R.corrSteps === null ? '' : rfcStepsHtml()}`;
}

function rfcStepsHtml() {
  const R = state.rfc;
  const nSeries = Object.keys(R.corrSeries || {}).length;
  if (!nSeries) {
    return `<p class="small txt-muted">No parseable lines${R.corrBad ? ` (${R.corrBad} rejected)` : ''}.</p>`;
  }
  const stepsHtml = R.corrSteps.length ? `
    <p class="small rfc-steps-lead" id="rfc-steps-h">Detected steps, largest first — choose one to
      set it as the onset date:</p>
    <div class="button-group rfc-steps" role="group" aria-labelledby="rfc-steps-h">
      ${R.corrSteps.map(s => `
        <button type="button" class="small" onclick="RfChanges.useOnset('${escAttr(s.date)}')"
                title="Rolling-median shift of ${s.jump > 0 ? '+' : ''}${s.jump.toFixed(1)} at ${escAttr(s.station)}">
          ${esc(s.date)} · ${esc(s.station)}
          <span aria-hidden="true">${s.jump > 0 ? '▲' : '▼'}</span><span class="sr-only">${
            s.jump > 0 ? 'up' : 'down'}</span>${Math.abs(s.jump).toFixed(1)}</button>`).join('')}
    </div>` : `
    <p class="small txt-muted">No step larger than 4× the noise floor found in
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
        <p class="small rfc-common">
          <span aria-hidden="true">⚑</span> <strong>All ${matched.length} matched stations report through
          ${esc(c.name)}</strong> — corruption confined to one repeater's stations is strong
          evidence for something at or near that specific site.
          ${isAnchor ? `<button type="button" class="small" onclick="RfChanges.focusAnchor('${escAttr(c.id)}')">Focus ${esc(c.name)}</button>`
                     : `<span class="txt-muted">(${esc(c.name)} has no RX frequency recorded, so it is not in the ACMA threat layer — record repeater.rx_mhz to include it.)</span>`}
        </p>`;
    } else {
      commonHtml = `
        <p class="small txt-muted rfc-common">
          The affected stations do not share a single repeater — that spreads the search across
          sites, or points to something common to the receive side (base station, decoder) rather
          than one repeater's RF environment.</p>`;
    }
  }
  return `
    <div class="rfc-grouping">
      <div class="table-wrap">
        <table class="bf-table">
          <caption>Which repeater serves each affected station</caption>
          <thead><tr><th scope="col">Series</th><th scope="col">Matched station</th>
            <th scope="col">Serving repeater(s)</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="small">${esc(r.n)}</td>
                <td class="small">${r.st ? esc(r.st.name) : '<span class="txt-muted">no match in stations.json</span>'}</td>
                <td class="small">${r.reps.length ? r.reps.map(x => esc(x.name)).join(', ')
                  : '<span class="txt-muted">—</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${commonHtml}
    </div>`;
}

// ── help ──

function rfcHelpHtml() {
  return `
    <details class="rfc-blind">
      <summary><strong>What this page will not catch</strong>
        <span class="small txt-muted">— read before trusting an empty result</span></summary>
      <div class="small txt-muted rfc-blind-body">
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

