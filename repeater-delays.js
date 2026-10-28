// MegaNet — repeater-delays.js
//
//   RepeaterDelays   ⏳ Repeater Delays, under Stations & networks: the delay
//                    each repeater should wait before sending on what it
//                    heard, so that repeaters relaying the same reading never
//                    send their copies on top of each other — worked out from
//                    the station register by delay-plan.js, for every
//                    repeater on file (Queensland and northern New South
//                    Wales), group by group, with what it costs to stay under
//                    a second and what a longer delay would buy.
//
// After core.js, app.js and delay-plan.js, before init.js; nothing runs at
// load. app.js's renderMain() calls render() and init(); map-backbone.js asks
// suggestion() for the delay a repeater's card offers, so the card and this
// tab say the same number.
//
// ── One plan, cached per file and settings ───────────────────────────────────
// A plan is half a second's search over the whole register, so it is worked
// out once per loaded file and set of settings (state.delayPlans, dropped
// wherever state.backboneIdx is — a pass range or a delay edited is a new
// plan) and handed out from there. The settings are this device's own
// ('mn-delay-plan'): which limit the repeaters take is a question about the
// hardware somebody has in front of them, not about the account.
//
// ── A recorded delay is knowledge, a planned one a suggestion ───────────────
// The register has had a place for each repeater's delay since 0015 and holds
// none yet. The plan keeps any that are recorded as they are (unless told not
// to) and plans the rest around them, so recording each delay as it is set in
// the field makes the next plan the same one; and a value that is only
// planned is never written anywhere by this tab.

const RepeaterDelays = (function () {
  const LS_KEY = 'mn-delay-plan';
  const LIMITS = [
    { ms: 999,  label: 'Under 1 s (999 ms)', note: 'what the register can hold now' },
    { ms: 1499, label: 'Up to 1.5 s', note: '' },
    { ms: 1999, label: 'Up to 2 s', note: '' },
    { ms: 2999, label: 'Up to 3 s', note: '' },
  ];
  const BAND = {
    ontop: { label: 'On top', cls: 'rd-b--ontop', what: 'less than a frame apart — the frames overlap, and the flipped bits that make ghosts happen here' },
    close: { label: 'Close',  cls: 'rd-b--close', what: 'a frame apart or more, but the later repeater keys up during the earlier one\'s frame — a copy spoilt where both are heard about equally' },
    clear: { label: 'Clear',  cls: 'rd-b--clear', what: 'far enough apart that neither copy touches the other' },
  };
  const STATUS = {
    ontop: 'Still on top of a neighbour',
    close: 'Close to a neighbour',
    clear: 'Clear of every neighbour',
    free: 'No neighbour shares its readings',
    unplaced: 'No position on record',
    'nothing-passed': 'Passes nothing',
  };

  const S = { opts: null, compare: null, comparing: false, timer: null };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;
  const ms = v => (v == null ? '—' : `${num(v)} ms`);
  const mhz = v => (v == null ? '?' : String(v));

  function readLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  // ── Settings ───────────────────────────────────────────────────────────────

  function opts() {
    if (S.opts) return S.opts;
    let saved = {};
    try { saved = JSON.parse(readLS(LS_KEY) || '{}') || {}; } catch (_) { saved = {}; }
    const keep = ['maxMs', 'currentMs', 'leadMs', 'gridMs', 'fieldKm', 'linkKm', 'keepRecorded'];
    const o = {};
    for (const k of keep) if (saved[k] !== undefined) o[k] = saved[k];
    S.opts = DelayPlan.settings(o);
    return S.opts;
  }
  function setOpt(k, v) {
    const cur = Object.assign({}, opts());
    cur[k] = v;
    S.opts = DelayPlan.settings(cur);
    const keep = {};
    for (const key of ['maxMs', 'currentMs', 'leadMs', 'gridMs', 'fieldKm', 'linkKm', 'keepRecorded']) {
      if (S.opts[key] !== DelayPlan.DEFAULTS[key]) keep[key] = S.opts[key];
    }
    writeLS(LS_KEY, JSON.stringify(keep));
    if (k !== 'maxMs') S.compare = null;
    redraw();
  }
  function reset() {
    S.opts = DelayPlan.settings({});
    writeLS(LS_KEY, '{}');
    S.compare = null;
    redraw();
  }

  // ── Plans, cached per file ─────────────────────────────────────────────────

  function key(o) {
    return ['maxMs', 'currentMs', 'leadMs', 'frameMs', 'gridMs', 'fieldKm', 'linkKm', 'maxHops', 'keepRecorded']
      .map(k => String(o[k])).join('|');
  }
  function planFor(o) {
    if (typeof state === 'undefined' || !state.data) return null;
    if (!state.delayPlans) state.delayPlans = new Map();
    const k = key(o);
    if (!state.delayPlans.has(k)) state.delayPlans.set(k, DelayPlan.plan(state.data.stations, o));
    return state.delayPlans.get(k);
  }
  const current = () => planFor(opts());

  // What a repeater's card offers: the plan at its defaults — the same for
  // everybody, whatever this device's tab is set to — or null for a station
  // that is not a repeater on the plan.
  const planAtDefaults = () => planFor(DelayPlan.settings({})) || { repeaters: [] };
  function suggestion(station) {
    if (!station || !station.id) return null;
    const r = planAtDefaults().repeaters.find(x => x.id === station.id);
    return r ? { delay: r.delay, status: r.status, cluster: r.cluster } : null;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function bandHtml(b) {
    const B = BAND[b];
    return B ? `<span class="rd-b ${B.cls}">${esc(B.label)}</span>` : '';
  }
  function statusHtml(s) {
    if (BAND[s]) return bandHtml(s);
    return `<span class="rd-b rd-b--none">${esc(STATUS[s] || s)}</span>`;
  }
  function chan(r) {
    if (r.rx == null && r.tx == null) return '<span class="txt-muted">not recorded</span>';
    return r.rx === r.tx ? `${esc(mhz(r.rx))}` : `${esc(mhz(r.rx))} → ${esc(mhz(r.tx))}`;
  }
  function stationBtn(id, name) {
    return `<button class="link-btn" onclick="RepeaterDelays.openStation('${escAttr(id)}')">${esc(name)}</button>`;
  }

  function settingsHtml(o) {
    const limit = LIMITS.find(l => l.ms === o.maxMs);
    return `<form class="rd-settings" onsubmit="return false" aria-label="What the plan assumes">
      <label>Longest delay the repeaters take
        <select id="rd-max" onchange="RepeaterDelays.set('maxMs', +this.value)">
          ${LIMITS.map(l => `<option value="${l.ms}"${l.ms === o.maxMs ? ' selected' : ''}>${esc(l.label)}${l.note ? ` — ${esc(l.note)}` : ''}</option>`).join('')}
          ${limit ? '' : `<option value="${o.maxMs}" selected>${esc(ms(o.maxMs))}</option>`}
        </select></label>
      <label>The delay they are on now, if they share one
        <input type="number" id="rd-now" min="0" max="60000" step="1" inputmode="numeric" placeholder="not known"
          value="${o.currentMs == null ? '' : o.currentMs}" onchange="RepeaterDelays.set('currentMs', this.value)"></label>
      <label class="rd-check"><input type="checkbox" id="rd-keep"${o.keepRecorded ? ' checked' : ''}
          onchange="RepeaterDelays.set('keepRecorded', this.checked)"> Keep the delays recorded on stations</label>
    </form>`;
  }

  function tilesHtml(p) {
    const c = p.counts;
    const tile = (n, label, cls) => `<div class="bk-tile"><span class="bk-tile-n${cls ? ' ' + cls : ''}">${esc(n)}</span> <span class="bk-tile-l">${esc(label)}</span></div>`;
    return `<div class="bk-tiles">
      ${tile(num(c.linked), `of the ${num(c.repeaters)} repeaters share readings with a neighbour, in ${plural(p.clusters.length, 'group')}`)}
      ${tile(`${num(c.ontopSame)} → ${num(c.ontop)}`, 'pairs sending copies on top of each other: all on one delay → this plan', c.ontop ? 'stat-bad' : '')}
      ${tile(num(c.close), 'pairs still close — a key-up on the other\'s frame', c.close ? 'txt-warn' : '')}
      ${tile(num(c.clear), `pairs clear, of ${num(c.pairs)}`, '')}
      ${tile(num(c.free), 'repeaters with no neighbour on their readings — any delay will do', '')}
    </div>`;
  }

  function answerHtml(p) {
    const c = p.counts, o = p.settings;
    const steps = c.delaysUsed.length;
    const parts = [];
    parts.push(`Set each repeater to the <strong>Delay</strong> in the table below. With every repeater on one delay,
      <strong>${plural(c.ontopSame, 'pair')}</strong> of repeaters send their copies of the same reading on top of each other at a
      receiver that hears both — the collisions that come out as flipped bits. With these delays
      ${c.ontop ? `<strong>${num(c.ontop)}</strong> still do` : '<strong>none</strong> do'}, ${num(c.close)} ${c.close === 1 ? 'is' : 'are'} close, and
      ${num(c.clear)} ${c.clear === 1 ? 'is' : 'are'} clear.`);
    parts.push(`The plan uses ${plural(steps, 'different delay')} between ${ms(c.delaysUsed[0] || 0)} and ${ms(c.delaysUsed[steps - 1] || 0)};
      two copies are clear of each other ${ms(o.clearMs)} apart (a ${ms(o.leadMs)} lead-in and a ${ms(o.frameMs)} frame).`);
    if (o.maxMs < 1000 && (c.ontop || c.close)) {
      parts.push(`Under a second there is not room to clear every pair: the busiest groups need their copies spread over more than a
        second. If the repeaters take longer delays, pick the limit above and the plan follows — see <em>What a longer delay buys</em>.`);
    }
    if (c.channelUnknown) {
      parts.push(`${plural(c.channelUnknown, 'repeater has', 'repeaters have')} no channel on record, so each is assumed to share one with
        its neighbours — recording the channels may free some of them.`);
    }
    if (c.recorded) parts.push(`${plural(c.recorded, 'repeater has a delay', 'repeaters have delays')} recorded on ${c.recorded === 1 ? 'its station' : 'their stations'}${o.keepRecorded ? ', kept as recorded' : ', planned afresh'}.`);
    if (o.currentMs != null) parts.push(`Starting from ${ms(o.currentMs)} on every repeater, ${plural(c.changes, 'repeater needs', 'repeaters need')} changing; the rest can stay as they are.`);
    return parts.map(t => `<p>${t}</p>`).join('');
  }

  function compareHtml() {
    const rows = S.compare;
    const body = !rows
      ? `<p class="small" role="status">${S.comparing ? 'Working out each limit…' : ''}</p>
         <p><button class="btn" onclick="RepeaterDelays.compare()"${S.comparing ? ' disabled' : ''}>Work out each limit</button></p>`
      : `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="rd-h-compare">
        <table class="hl-table rd-compare">
          <caption class="sr-only">Each limit on the delay, and how many repeater pairs it leaves on top of each other, close and clear</caption>
          <thead><tr><th scope="col">Longest delay</th><th scope="col" class="num">On top</th><th scope="col" class="num">Close</th>
            <th scope="col" class="num">Clear</th><th scope="col">Delays used</th></tr></thead>
          <tbody>
            <tr><th scope="row">Every repeater on one delay</th><td class="num">${num(rows[0].counts.ontopSame)}</td>
              <td class="num">${num(rows[0].counts.closeSame)}</td><td class="num">${num(rows[0].counts.clearSame)}</td><td>one</td></tr>
            ${rows.map(p => `<tr${p.settings.maxMs === opts().maxMs ? ' class="is-selected"' : ''}>
              <th scope="row">${esc((LIMITS.find(l => l.ms === p.settings.maxMs) || { label: ms(p.settings.maxMs) }).label)}</th>
              <td class="num">${num(p.counts.ontop)}</td><td class="num">${num(p.counts.close)}</td><td class="num">${num(p.counts.clear)}</td>
              <td>${num(p.counts.delaysUsed.length)}, up to ${ms(p.counts.delaysUsed[p.counts.delaysUsed.length - 1] || 0)}</td></tr>`).join('')}
          </tbody>
        </table></div>
        <p class="small txt-muted">A delay over 999 ms cannot be recorded on a station yet — the register's limit (0015). Check the
          repeaters' own limit before planning past a second.</p>`;
    return `<details class="rd-fold" data-k="compare"><summary><h3 class="bk-inline-h" id="rd-h-compare">What a longer delay buys</h3></summary>
      ${body}</details>`;
  }

  function tableHtml(p) {
    const byId = new Map(p.repeaters.map(r => [r.id, r]));
    const showNow = p.repeaters.some(r => r.baseline != null);
    const cols = showNow ? 8 : 7;
    const rows = p.clusters.map(c => {
      const head = `<tr class="rd-group"><th scope="rowgroup" colspan="${cols}" id="rd-g-${c.n}">
        Group ${c.n} · ${esc(c.name)} <span class="small txt-muted">— ${plural(c.repeaters.length, 'repeater')}, ${plural(c.pairs, 'pair')};
        on one delay ${esc(BAND[c.worstSame].label.toLowerCase())}, planned ${esc(BAND[c.worst].label.toLowerCase())}</span></th></tr>`;
      return head + c.repeaters.map(id => rowHtml(byId.get(id), showNow)).join('');
    }).join('');
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="rd-h-table">
      <table class="hl-table rd-table">
        <caption class="sr-only">Each repeater's planned delay, group by group: its channel, its closest neighbour under the plan and how far apart their copies land, and how many readings it shares</caption>
        <thead><tr><th scope="col">Repeater</th><th scope="col">Channel, MHz</th><th scope="col" class="num">Delay</th>
          ${showNow ? '<th scope="col" class="num">Now</th>' : ''}
          <th scope="col">Closest neighbour</th><th scope="col" class="num">Apart</th><th scope="col">State</th>
          <th scope="col" class="num">Readings shared</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function rowHtml(r, showNow) {
    const n = r.neighbours[0];
    const now = r.baseline == null ? '—' : `${ms(r.baseline)}${r.change ? ' <span class="rd-change">change</span>' : ''}`;
    return `<tr id="rd-r-${escAttr(r.id)}">
      <th scope="row">${stationBtn(r.id, r.name)}${r.fixed ? ' <span class="small txt-muted">recorded</span>' : ''}</th>
      <td>${chan(r)}</td>
      <td class="num rd-delay">${ms(r.delay)}</td>
      ${showNow ? `<td class="num">${now}</td>` : ''}
      <td>${n ? `${esc(n.name)} <span class="small txt-muted">${ms(n.otherDelay)} · ${num(Math.round(n.km))} km · ${plural(n.weight, 'reading')} together</span>` : '—'}</td>
      <td class="num">${n ? ms(n.sepMs) : '—'}</td>
      <td>${statusHtml(r.status)}</td>
      <td class="num">${num(r.readings)}</td>
    </tr>`;
  }

  function freeHtml(p) {
    const free = p.repeaters.filter(r => !r.linked).sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!free.length) return '';
    return `<details class="rd-fold" data-k="free"><summary><h3 class="bk-inline-h" id="rd-h-free">${plural(free.length, 'repeater')} with no neighbour on ${free.length === 1 ? 'its' : 'their'} readings</h3></summary>
      <p class="small">No other repeater relays the same readings to a receiver that hears both, so whatever delay ${free.length === 1 ? 'it has' : 'these have'}
        is fine — leave ${free.length === 1 ? 'it' : 'them'} as ${free.length === 1 ? 'it is' : 'they are'}. (A repeater with no position or no open pass range is here too, said as such.)</p>
      <ul class="rd-free">${free.map(r => `<li>${stationBtn(r.id, r.name)} <span class="small txt-muted">${esc(r.hub ? r.hub[0].toUpperCase() + r.hub.slice(1) + ' hub' : '')}${r.status !== 'free' ? ' · ' + esc(STATUS[r.status]) : ''}</span></li>`).join('')}</ul>
    </details>`;
  }

  function pairsHtml(p) {
    if (!p.pairs.length) return '';
    return `<details class="rd-fold" data-k="pairs"><summary><h3 class="bk-inline-h" id="rd-h-pairs">Every pair, busiest first (${num(p.pairs.length)})</h3></summary>
      <p class="small">Two repeaters that relay the same reading and are heard together by a base station or a repeater that wants it. <em>Apart</em> is the
        closest their copies come — two copies of one reading, through any number of hops — on one delay and under the plan.</p>
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="rd-h-pairs">
      <table class="hl-table rd-pairs">
        <caption class="sr-only">Every pair of repeaters that can put copies of one reading on top of each other: how far apart, how many readings, where they meet, and how far apart their copies land on one delay and under the plan</caption>
        <thead><tr><th scope="col">Repeaters</th><th scope="col" class="num">km</th><th scope="col" class="num">Readings</th>
          <th scope="col">Heard together at</th><th scope="col">On one delay</th><th scope="col">Planned</th></tr></thead>
        <tbody>${p.pairs.map(x => `<tr>
          <th scope="row">${esc(x.aName)} &amp; ${esc(x.bName)}</th>
          <td class="num">${num(Math.round(x.km))}</td><td class="num">${num(x.weight)}</td>
          <td class="small">${esc(x.where.slice(0, 3).map(w => w.name).join(', '))}${x.where.length > 3 ? ` and ${num(x.where.length - 3)} more` : ''}</td>
          <td>${bandHtml(x.bandSame)} <span class="small">${ms(x.sepSameMs)}</span></td>
          <td>${bandHtml(x.band)} <span class="small">${ms(x.sepMs)}</span></td>
        </tr>`).join('')}</tbody>
      </table></div></details>`;
  }

  function howHtml(p) {
    const o = p.settings;
    return `<details class="rd-fold" data-k="how"><summary><h3 class="bk-inline-h" id="rd-h-how">How it is worked out, and what it assumes</h3></summary>
      <p>A repeater stores what it decodes and sends it on after its delay. Two repeaters whose pass ranges both take an address, and which both
        hear the station sending it, send their copies at the same moment if their delays are the same — and a receiver that hears both gets the
        two on top of each other. Bit on bit, the copies beat against each other and a few bits flip, so the frame is filed under the wrong
        address: a ghost. A little apart, the later repeater keys up during the earlier one's frame and spoils it where the two arrive at about
        the same strength. Far enough apart, both arrive clean.</p>
      <ul>
        <li><strong>Every reading is followed.</strong> For each address each station sends: the repeaters that pass it and hear the station
          (${num(o.fieldKm)} km from a field station, ${num(o.linkKm)} km from a repeater site's own gauge), then the repeaters that pass it and
          hear one of those (${num(o.linkKm)} km), up to ${num(o.maxHops)} hops. Each copy goes out a lead-in, a frame and the repeater's delay after
          the first copy it heard; a repeater sends a reading on once.</li>
        <li><strong>Copies collide where a receiver wants them.</strong> Two copies on one channel meet at a base station, or at a repeater that
          passes the address, within ${num(o.linkKm)} km of both. A repeater hears only on its receive channel and is heard only on its transmit
          channel; a channel not on record is taken to agree with any — erring towards a collision.</li>
        <li><strong>How far apart is far enough.</strong> A keying is a lead-in (the transmitter coming up and the preamble) and then the
          ${ms(o.frameMs)} frame — 40 bits at 300 baud. ${bandHtml('ontop')} is under ${ms(o.frameMs)}; ${bandHtml('close')} is under
          ${ms(o.clearMs)}; ${bandHtml('clear')} is ${ms(o.clearMs)} or more. The ${ms(o.leadMs)} lead-in is the app's own figure, not one timed on
          these repeaters: time one off the air and the bands move with it.</li>
        <li><strong>The search.</strong> Delays are whole ${ms(o.gridMs)} steps from 0 to ${ms(o.maxMs)}. Each group of repeaters that share
          readings is searched on its own — every repeater moved to whichever step costs least given the rest, again and again, with a few
          bolder moves early on to get out of a corner — on top costing most, close less the further apart, clear nothing. The same register and
          settings always give the same plan, and among delays that cost the same the one a repeater has now wins, so it asks for as few site
          visits as it can.</li>
        <li><strong>What it cannot see.</strong> Hearing is a distance, not a coverage model: a hill between two repeaters it counts as
          hearing each other makes a pair that is not there, and a long path across water it does not count leaves one out. A repeater that
          does not relay a reading twice, and counts its delay from the end of the frame it heard, is assumed. Ghosts that a collision turns into
          an address another repeater passes are not followed. Check the result where it matters — the
          <button class="link-btn" onclick="switchTab('flipsources')">Bit-Flip Sources</button> and
          <button class="link-btn" onclick="switchTab('health')">Station Health</button> tabs show whether the corrupted copies fall once a
          group is set.</li>
        <li><strong>Recording it.</strong> Record each delay on its station as it is set — the Stations tab, the repeater's card, <em>Repeater
          delay (ms)</em> — and the plan keeps it from then on. The register takes up to 999 ms.</li>
      </ul>
      <p><button class="btn" onclick="RepeaterDelays.reset()">Put the settings back</button></p>
    </details>`;
  }

  function render() {
    const o = opts();
    const p = current();
    const body = !p
      ? '<p class="small" role="status">The station register is not loaded yet.</p>'
      : `${tilesHtml(p)}<div class="rd-answer">${answerHtml(p)}</div>`;
    return `
    <div class="page rd-page" style="--page-max:1200px">
      <div class="panel">
        <div class="panel-header"><h2>Repeater delays</h2></div>
        <p class="small txt-muted">The delay each repeater should wait before sending on what it heard, so that repeaters relaying the same
          reading never send their copies on top of each other — worked out from the station register for every repeater on file,
          Queensland and northern New South Wales. A plan, not a record: nothing here is written to a station.</p>
        ${settingsHtml(o)}
        ${body}
      </div>
      ${p ? `
      <div class="panel">
        <div class="panel-header"><h3 id="rd-h-table">The delays, group by group</h3>
          <button class="btn" onclick="RepeaterDelays.exportCsv()">Save as CSV</button></div>
        <p class="small">Repeaters in a group relay some of the same readings and are heard together somewhere, so set a group's delays
          together. Busiest group first; in each, the repeater sharing the most readings first. <em>Apart</em> is how close its copies come to
          its closest neighbour's under the plan.</p>
        ${tableHtml(p)}
        ${freeHtml(p)}
        ${compareHtml()}
        ${pairsHtml(p)}
        ${howHtml(p)}
      </div>` : ''}
    </div>`;
  }

  function redraw() {
    const host = typeof state !== 'undefined' && state.activeTab === 'repdelays' ? document.getElementById('main-content') : null;
    if (!host) return;
    const y = typeof window !== 'undefined' ? window.scrollY : 0;
    const open = [...host.querySelectorAll('details[data-k]')].filter(d => d.open).map(d => d.dataset.k);
    host.innerHTML = render();
    open.forEach(k => { const d = host.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; });
    if (y && typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, y);
  }

  function init() {
    if (typeof registerTabTeardown === 'function') {
      registerTabTeardown('RepeaterDelays', () => { if (S.timer) { clearTimeout(S.timer); S.timer = null; S.comparing = false; } });
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  // Each limit worked out in turn, a beat apart, so the page stays live.
  function compare() {
    if (S.comparing || !state.data) return;
    S.comparing = true;
    redraw();
    const out = [];
    const base = opts();
    let i = 0;
    const step = () => {
      S.timer = null;
      if (state.activeTab !== 'repdelays') { S.comparing = false; return; }
      out.push(planFor(DelayPlan.settings(Object.assign({}, base, { maxMs: LIMITS[i].ms }))));
      i++;
      if (i < LIMITS.length) { S.timer = setTimeout(step, 30); return; }
      S.compare = out;
      S.comparing = false;
      redraw();
      const d = document.querySelector('details[data-k="compare"]');
      if (d) d.open = true;
    };
    S.timer = setTimeout(step, 30);
  }

  function openStation(id) { if (typeof goToStation === 'function') goToStation(id); }

  function exportCsv() {
    const p = current();
    if (!p) return;
    const head = ['group', 'group_name', 'repeater', 'station_id', 'hub', 'rx_mhz', 'tx_mhz', 'delay_ms', 'now_ms', 'change',
      'recorded_kept', 'closest_neighbour', 'neighbour_delay_ms', 'apart_ms', 'state', 'readings_shared', 'limit_ms', 'lead_in_ms'];
    const groupName = new Map(p.clusters.map(c => [c.n, c.name]));
    const order = p.clusters.flatMap(c => c.repeaters).concat(p.repeaters.filter(r => !r.linked).map(r => r.id));
    const byId = new Map(p.repeaters.map(r => [r.id, r]));
    const lines = [head.join(',')];
    for (const id of order) {
      const r = byId.get(id);
      const n = r.neighbours[0];
      lines.push([r.cluster || '', r.cluster ? groupName.get(r.cluster) : '', r.name, r.id, r.hub, r.rx ?? '', r.tx ?? '', r.delay,
        r.baseline ?? '', r.change == null ? '' : r.change ? 'yes' : 'no', r.fixed ? 'yes' : 'no',
        n ? n.name : '', n ? n.otherDelay : '', n ? n.sepMs : '', STATUS[r.status] || r.status, r.readings,
        p.settings.maxMs, p.settings.leadMs].map(csvEscape).join(','));
    }
    dlText(`repeater-delays-${p.settings.maxMs}ms.csv`, lines.join('\n') + '\n');
  }

  function exportPairsCsv() {
    const p = current();
    if (!p || !p.pairs.length) return;
    const head = ['repeater_a', 'repeater_b', 'km', 'readings_shared', 'heard_together_at', 'apart_on_one_delay_ms', 'on_one_delay',
      'apart_planned_ms', 'planned', 'example_stations'];
    const lines = [head.join(',')];
    for (const x of p.pairs) {
      lines.push([x.aName, x.bName, x.km, x.weight, x.where.map(w => w.name).join('; '), x.sepSameMs, BAND[x.bandSame].label,
        x.sepMs, BAND[x.band].label, x.sources.map(s => `${s.name} (${s.address})`).join('; ')].map(csvEscape).join(','));
    }
    dlText(`repeater-delay-pairs-${p.settings.maxMs}ms.csv`, lines.join('\n') + '\n');
  }

  return { render, init, set: setOpt, reset, compare, openStation, exportCsv, exportPairsCsv, current, suggestion, planAtDefaults,
           state: () => S };
})();
