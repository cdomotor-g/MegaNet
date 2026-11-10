// MegaNet — map-repcompare.js
//
//   MapRepCompare   ⚖️ Repeater comparison: pick two or more repeaters already
//                   in the network, and it lists the sites that two or more of
//                   them both carry — each site's path up to every one of the
//                   picked repeaters that listens to it priced side by side,
//                   so "which of these hears it best" is one row to read.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, termHtml, cssVar, slug,
// dlText, acmaHaversineKm and stationLatLonText; across to path-profile.js for
// pathGround, pathAnalyse, pathPropOf, rmSystemOf, stationAntenna,
// stationIsMast, wattsToDbm, pathVerdictWord, PATH_LOS_MEANING, PATH_DEFAULT_MHZ
// and the small pictures (pathThumbOf, pathThumbSvg, pathThumbKeyHtml), and
// PathProfile.openFull; land-cover.js for LandCover.sample; map-backbone.js
// for repeaterPathsOf (what sends its readings up to a repeater, by the pass
// ranges — the list 🗼 Move/New Repeater and 🚚 Relocate station keep);
// map-draw.js for MapDraw; map-controls.js for MapChrome.panel; glyphs.js for
// its rail icon; and app.js for selectedStationId, findStationMatches,
// rerenderMapLegend, mapNote, setDockTab, showStationCard, dockReveal and
// stationsCardsWhere. All of it
// from inside its own functions, so this file's position among the modules is
// free.
//
// ── The question this answers ────────────────────────────────────────────────
// 🎯 Best repeater starts from one station and asks which mast should hear
// it. This starts from the masts: two repeaters whose pass ranges overlap
// both re-send the same gauge's readings, and the questions that follow are
// about the pair — which sites do they share, which of the two hears each
// one better, and what does only one of them carry (what would be lost if it
// were switched off). Until now that was two repeater cards open side by side
// and a profile drawn by hand for every site on both lists.
//
// ── What "carries" means here ────────────────────────────────────────────────
// The rule the other finders use, unchanged (repeaterPathsOf): the field
// stations whose ALERT addresses a repeater's pass ranges take, and the
// repeaters on a backbone pair that runs up to it — all within the map's Max
// TX distance, so a repeater whose pass ranges were left wide open is not said
// to carry a gauge three hundred kilometres away. A site is *shared* when two
// or more of the picked repeaters carry it.
//
// ── The figures ──────────────────────────────────────────────────────────────
// Each path is priced one way, the way the readings go — the site transmits
// on its own radio and antenna, the repeater listens on its own radio and
// mast at the frequency it listens on — by the link budget card's own
// arithmetic (pathGround at the card's sample count, the land cover stood on
// it under the land-cover model, pathAnalyse): 🎯 Best repeater's first hop,
// to the last bit, with the small picture of the ground kept beside it. A
// path that cannot be priced says why rather than showing a figure.
//
// ── What it is not ───────────────────────────────────────────────────────────
// ~30 m terrain and omnidirectional antennas, and the pass ranges as filed:
// it says what the network is set up to do, not what was heard on the day.
// 📻 Reception and the station cards hold what was heard.

const MapRepCompare = (() => {
  const KEY = 'mn-repcompare-v1';
  const PANE = 'mnRepCmp', PANE_Z = 410;
  const LINE_PANE = 'mnRepCmpLines', LINE_Z = 409;
  const SAMPLES = 256;          // the link budget card's count
  const LANES = 4;
  const HIT_CAP = 8;
  const MAX_REPS = 6;           // a grid wider than this is not a grid anyone reads
  const COLO_KM = 0.05;

  const BAND = {
    good: ['--map-fade-good', '#00e676'], ok: ['--map-fade-ok', '#ffab00'],
    bad:  ['--map-fade-bad', '#e53935'],  none: ['--muted', '#888888'],
  };

  let map = null, body = null, layer = null, lineLayer = null;
  let repIds = load();          // the repeaters picked, in the order picked
  let hitQ = '';
  let note = '';                // what the last Add did
  let found = null;             // the answer: { reps, rows, only, K }
  let job = null;
  let status = { kind: 'idle', text: '' };
  let selectedSid = null;
  let showPics = false;         // every row's pictures open, not just the picked one's

  function load() {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(x => typeof x === 'string' || typeof x === 'number').slice(0, MAX_REPS) : [];
    } catch (_) { return []; }
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(repIds)); } catch (_) { /* private mode */ } }

  function goodDb() { return state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15; }
  function okDb()   { return isFinite(state.mapFadeOkDb) ? state.mapFadeOkDb : 6; }
  function linkKm() { return state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : 100; }

  // ── The words ───────────────────────────────────────────────────────────────
  // One list, read by the headings, the chips and the fold that says them
  // without a hover (docs/design-system.md, "Words that mean something here").

  function words() {
    const G = goodDb(), O = okDb(), K = linkKm();
    return {
      carries: `What sends its readings up to a repeater: the field stations whose ALERT addresses its pass ranges take, and the `
        + `repeaters set up to send to it — within ${K} km, the map's Max TX distance.`,
      shared: 'A site that two or more of the repeaters picked here both carry, so its readings are re-sent by each of them.',
      only: 'Sites this repeater carries that none of the others picked here does. If it went off the air, these are the '
        + 'sites the others would not cover.',
      site: 'A station that two or more of the picked repeaters both carry. Click its row to move the map to it and light '
        + 'its path to each of them.',
      cell: 'The fade margin of the path from the site up to this repeater: how many decibels its signal arrives above what '
        + `the repeater's receiver needs. Green is ${G} dB or more, yellow ${O} to ${G}, red under ${O}. A dash where this `
        + 'repeater does not carry the site.',
      best: 'Of the picked repeaters that carry the site, the one its signal reaches with the most fade margin to spare. '
        + 'Marked ★ in the grid.',
      spread: 'The gap in fade margin between the repeater that hears the site best and the one that hears it worst. A big '
        + 'gap means one of them is doing the real work.',
      km: 'Straight-line distance from the site to the repeater.',
      margin: 'Fade margin, one way — the site transmitting on its own radio and antenna, the repeater listening on its own '
        + 'radio and mast. Worked out the link budget card\'s way: Longley–Rice over ~30 m terrain, with the land cover on '
        + 'it where the propagation settings say so.',
      pic: 'The ground under the path, and what grows on it, drawn small beside its figures, with the site on the left and '
        + 'the repeater on the right. Red is ground or trees inside 60% of the Fresnel zone, where they cost signal. Click '
        + 'one to open that path\'s elevation profile full screen.',
      good: `${G} dB or more to spare — the fade margin layer's green, set in Layers.`,
      ok: `${O} to ${G} dB to spare — enough for most days, not for the worst; the fade margin layer's yellow.`,
      bad: `Under ${O} dB to spare — likely to drop readings in a storm; the fade margin layer's red.`,
      assumed: 'The site has no complete radio on file, so the radio most of the network runs is assumed for it. Its real '
        + 'margin may differ.',
      nofig: 'The path could not be priced — the terrain or the land cover could not be read, or one end has no complete '
        + 'radio on file. Hover the dash for which.',
    };
  }

  const GLOSSARY = [
    ['carries', 'Carries'], ['shared', 'Shared'], ['only', 'Only it'], ['site', 'Site'], ['cell', 'A repeater\'s column'],
    ['best', 'Best heard by'], ['spread', 'Gap'], ['km', 'km'], ['los', 'LOS'], ['margin', 'Margin'],
    ['pic', 'Ground profile'], ['good', 'Good'], ['ok', 'Ok'], ['bad', 'Poor'], ['assumed', '* assumed radio'],
    ['nofig', 'No figure'],
  ];

  function meaning(k) { return k === 'los' ? PATH_LOS_MEANING : words()[k]; }
  function term(k, text) { return termHtml(text || (GLOSSARY.find(g => g[0] === k) || [k, k])[1], meaning(k)); }
  function chip(k, text, cls) {
    return `<span class="term-chip bestrep-chip${cls ? ` ${cls}` : ''}" title="${escAttr(meaning(k))}">${esc(text)}</span>`;
  }
  function glossaryHtml() {
    return `<details class="bestrep-words"><summary>What the words on this panel mean</summary>
      <dl>${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(meaning(k))}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── The repeaters ───────────────────────────────────────────────────────────

  function stations() { return (state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => String(s.id) === String(id)) || null; }

  function isRepeater(s) {
    return !!s && Array.isArray(s.roles) && s.roles.includes('repeater') && !!s.repeater;
  }

  function picked() { return repIds.map(stationById).filter(s => isRepeater(s) && s.lat != null && s.lon != null); }

  function complete(sys) {
    return !!sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null
        && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
  }
  function systems() { return ((state.data && state.data.rm_systems) || []).filter(complete); }

  // The radio most of the network runs — the other finders' fieldDefault.
  function fieldDefault() {
    const list = systems();
    if (!list.length) return null;
    const n = new Map();
    for (const s of stations()) {
      const sys = rmSystemOf(s);
      if (complete(sys)) n.set(sys.id, (n.get(sys.id) || 0) + 1);
    }
    return list.reduce((best, r) => ((n.get(r.id) || 0) > (n.get(best.id) || 0) ? r : best), list[0]);
  }

  function radioOf(sys, agl) {
    return { sysId: sys.id, sysName: sys.name, txW: sys.tx_power_w, gain: sys.antenna_gain_dbi,
             loss: sys.line_loss_db, thr: sys.rx_threshold_dbm, agl };
  }

  // The site's end: its own radio as filed, else the network's commonest,
  // said to be assumed — on its own antenna height.
  function siteRadio(st) {
    const own = rmSystemOf(st);
    const sys = complete(own) ? own : fieldDefault();
    if (!sys) return null;
    return { ...radioOf(sys, stationAntenna(st, sys).agl), assumed: !complete(own) };
  }

  // The repeater's end: its own radio on its own mast, at what it listens on.
  function hubOf(s) {
    const sys = rmSystemOf(s);
    return {
      id: s.id, s, name: s.name, number: s.station_number || '', lat: s.lat, lon: s.lon,
      elev: s.elevation_ahd != null ? s.elevation_ahd : null,
      rad: complete(sys) ? radioOf(sys, stationAntenna(s, sys).agl) : null, mast: stationIsMast(s),
      f: s.repeater && s.repeater.rx_mhz > 0 ? +s.repeater.rx_mhz : PATH_DEFAULT_MHZ,
    };
  }

  // Everything that sends its readings up to it (repeaterPathsOf); the field
  // stations alone where map-backbone.js is not here.
  function carriedBy(rep) {
    const K = linkKm();
    if (typeof repeaterPathsOf === 'function') {
      try { return repeaterPathsOf(rep, K).upTo.map(d => d.s); } catch (_) { /* the field stations below */ }
    }
    let list = [];
    try { list = findStationMatches(rep) || []; } catch (_) { list = []; }
    return list.filter(s => s && s.id !== rep.id && s.lat != null && s.lon != null
      && acmaHaversineKm(rep.lat, rep.lon, s.lat, s.lon) <= K);
  }

  // ── Pricing one path ────────────────────────────────────────────────────────

  function oneWay(loss, from, to) {
    const tx = wattsToDbm(from.txW);
    if (tx == null || loss == null) return null;
    return tx + from.gain - from.loss - loss + to.gain - to.loss - to.thr;
  }

  // 🎯 Best repeater's first hop, with the picture kept.
  async function price(st, here, hub) {
    const dKm = acmaHaversineKm(st.lat, st.lon, hub.lat, hub.lon);
    if (dKm < COLO_KM) return { dKm, colo: true, verdict: 'clear', margin: null };
    if (!here) return { dKm, failed: 'no radio on file to assume for the site' };
    if (!hub.rad) return { dKm, failed: 'no complete radio on file for the repeater' };
    const got = await pathGround(
      { lat: st.lat, lon: st.lon, elev: st.elevation_ahd != null ? st.elevation_ahd : null, agl: here.agl, mast: stationIsMast(st) },
      { lat: hub.lat, lon: hub.lon, elev: hub.elev, agl: hub.rad.agl, mast: hub.mast },
      { samples: SAMPLES, freqMhz: hub.f });
    if (!got || !got.ok) return { dKm, failed: 'the terrain could not be read' };
    if (got.prof.partial) return { dKm, failed: 'the terrain had gaps along it' };
    const coverModel = pathPropOf().model === 'cover';
    const res = coverModel ? await LandCover.sample(got.prof.lat, got.prof.lon) : null;
    if (coverModel && !(res && res.ok)) return { dKm, failed: 'the land cover could not be read' };
    const an = pathAnalyse(got.prof, {
      elevA: got.ends.a.elev, elevB: got.ends.b.elev, aglA: here.agl, aglB: hub.rad.agl, freqMhz: hub.f,
      cover: res ? res.cls : null, canopy: res && res.canopyOk ? res.canopy : null,
    });
    if (!an.ok) return { dKm, failed: 'the model refused the path' };
    return { dKm, verdict: an.verdict, margin: oneWay(an.pathLoss_db, here, hub.rad), loss: an.pathLoss_db,
             thumb: pathThumbOf(an) };
  }

  function bandOf(fig) {
    if (!fig || fig.failed) return 'none';
    if (fig.colo) return 'good';
    if (fig.margin == null || !isFinite(fig.margin)) return 'none';
    return fig.margin >= goodDb() ? 'good' : fig.margin >= okDb() ? 'ok' : 'bad';
  }
  function bandColour(b) { return cssVar(BAND[b][0], BAND[b][1]); }
  function dbText(v) { return v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; }

  // ── The comparison ──────────────────────────────────────────────────────────

  function readiness() {
    if (!state.data) return { ok: false, why: 'No stations are loaded.' };
    const n = picked().length;
    if (n < 2) return { ok: false, why: n ? 'Add at least one more repeater — a comparison needs two.' : 'Add two or more repeaters to compare.' };
    return { ok: true };
  }

  async function lanes(list, n, fn, mine) {
    let i = 0;
    const lane = async () => { while (i < list.length && !mine.cancelled) await fn(list[i++]); };
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, lane));
  }

  // The best and the gap for a row, from whatever has been priced so far.
  function settleRow(row) {
    let best = null, lo = Infinity, hi = -Infinity;
    for (const [id, fig] of row.figs) {
      if (!fig || fig.failed) continue;
      const v = fig.colo ? Infinity : fig.margin;
      if (v == null) continue;
      if (best == null || v > best.v) best = { id, v };
      if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    row.best = best ? best.id : null;
    row.spread = isFinite(lo) && isFinite(hi) && hi > lo ? hi - lo : (isFinite(lo) ? 0 : null);
    row.worst = isFinite(lo) ? lo : null;
  }

  async function run() {
    const r = readiness();
    if (!r.ok) { setStatus('blocked', r.why); return false; }
    if (job) job.cancelled = true;
    const mine = job = { cancelled: false };
    const reps = picked().map(hubOf);
    const carried = new Map(reps.map(h => [h.id, carriedBy(h.s).filter(s => s.lat != null && s.lon != null)]));
    const by = new Map();        // station id → { st, reps: [hub ids] }
    for (const h of reps) {
      for (const s of carried.get(h.id)) {
        if (s.id === h.id) continue;
        if (!by.has(s.id)) by.set(s.id, { st: s, on: [] });
        by.get(s.id).on.push(h.id);
      }
    }
    const rows = [...by.values()].filter(x => x.on.length >= 2)
      .map(x => ({ st: x.st, on: x.on, here: siteRadio(x.st), figs: new Map(), best: null, spread: null, worst: null }))
      .sort((a, b) => b.on.length - a.on.length || String(a.st.name).localeCompare(String(b.st.name)));
    const only = new Map(reps.map(h => [h.id, [...by.values()].filter(x => x.on.length === 1 && x.on[0] === h.id).map(x => x.st)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))]));
    found = { reps, rows, only, carried: new Map(reps.map(h => [h.id, carried.get(h.id).length])), K: linkKm(), done: false };
    selectedSid = null;
    const pairs = [];
    for (const row of rows) for (const id of row.on) pairs.push({ row, hub: reps.find(h => h.id === id) });
    let n = 0;
    setStatus('running', rows.length ? `Pricing ${pairs.length} paths…` : '');
    draw();
    render();
    await lanes(pairs, LANES, async p => {
      let fig = null;
      try { fig = await price(p.row.st, p.row.here, p.hub); } catch (_) { fig = null; }
      if (mine.cancelled) return;
      p.row.figs.set(p.hub.id, fig || { dKm: acmaHaversineKm(p.row.st.lat, p.row.st.lon, p.hub.lat, p.hub.lon), failed: 'the path could not be worked out' });
      settleRow(p.row);
      n++;
      if (n % 4 === 0 || n === pairs.length) { setStatus('running', `Pricing paths — ${n} of ${pairs.length}…`); renderResults(); }
    }, mine);
    if (mine.cancelled) return false;
    job = null;
    found.done = true;
    setStatus('done', '');
    draw();
    render();
    rerenderMapLegend();
    if (typeof announce === 'function') {
      announce(`Repeater comparison: ${rows.length} site${rows.length === 1 ? '' : 's'} shared between ${reps.length} repeaters.`);
    }
    return true;
  }

  function invalidate() {
    if (job) { job.cancelled = true; job = null; }
    found = null;
    selectedSid = null;
    status = { kind: 'idle', text: '' };
  }

  // ── Picking the repeaters ───────────────────────────────────────────────────

  // → { added, already, notRep, full }
  function addReps(list) {
    const out = { added: 0, already: 0, notRep: 0, full: 0 };
    for (const s of list) {
      if (!isRepeater(s) || s.lat == null || s.lon == null) { out.notRep++; continue; }
      if (repIds.some(id => String(id) === String(s.id))) { out.already++; continue; }
      if (repIds.length >= MAX_REPS) { out.full++; continue; }
      repIds.push(s.id);
      out.added++;
    }
    if (out.added) { invalidate(); save(); }
    return out;
  }

  function addedText(r) {
    const bits = [];
    bits.push(r.added ? `Added ${r.added} repeater${r.added === 1 ? '' : 's'}.` : 'Nothing added.');
    if (r.already) bits.push(`${r.already} already in the list.`);
    if (r.notRep) bits.push(`${r.notRep} ${r.notRep === 1 ? 'is not a repeater' : 'are not repeaters'}, so left out.`);
    if (r.full) bits.push(`${r.full} left out — the comparison takes ${MAX_REPS} at most.`);
    return bits.join(' ');
  }

  function after(r) {
    note = addedText(r);
    draw();
    render();
    rerenderMapLegend();
  }

  function hits() {
    const q = hitQ.trim().toLowerCase();
    if (!q) return [];
    return stations().filter(s => isRepeater(s) && s.lat != null && s.lon != null
        && ((s.name || '').toLowerCase().includes(q) || String(s.station_number || '').toLowerCase().includes(q)))
      .slice(0, HIT_CAP);
  }

  function hitsHtml() {
    if (!hitQ.trim()) return '';
    return hits().map(s => `
      <button type="button" class="polar-hit${repIds.some(id => String(id) === String(s.id)) ? ' is-here' : ''}"
              onclick="MapRepCompare.add('${escAttr(s.id)}')">
        <span>${esc(s.name)}</span>
        <span class="small txt-muted">${esc(s.station_number || '')}</span>
      </button>`).join('') || '<p class="small txt-muted">No repeater by that name.</p>';
  }

  // ── Words on the panel ──────────────────────────────────────────────────────

  function setStatus(kind, text) {
    status = { kind, text };
    const el = document.getElementById('repcmp-status');
    if (el) el.innerHTML = statusHtml();
    const run = document.getElementById('repcmp-run');
    if (run) run.disabled = !(readiness().ok && kind !== 'running');
    const cancel = document.getElementById('repcmp-cancel');
    if (cancel) cancel.hidden = kind !== 'running';
  }

  function statusHtml() {
    if (status.kind === 'running') return `<span class="sites-run">${esc(status.text || 'Working…')}</span>`;
    if (status.kind === 'blocked') return esc(status.text);
    if (found && found.done) {
      const n = found.rows.length;
      return n
        ? `${n} site${n === 1 ? ' is' : 's are'} carried by two or more of these ${found.reps.length} repeaters. `
          + 'Click a row to see it on the map.'
        : `None of these ${found.reps.length} repeaters carry the same site, within ${found.K} km of each.`;
    }
    const r = readiness();
    return r.ok ? 'Press Compare to list the sites they share.' : esc(r.why);
  }

  function chosenHtml() {
    const list = picked();
    if (!list.length) return '<p class="small txt-muted">No repeaters yet.</p>';
    return `<ul class="sites-targets repcmp-chosen">${list.map((s, i) => `
      <li>
        <span class="repcmp-key repcmp-key-${i}" aria-hidden="true">${i + 1}</span>
        <span class="sites-t-name">${esc(s.name)}</span>
        <span class="sites-t-km">${esc(s.station_number || '')}</span>
        <button type="button" class="sites-t-x" onclick="MapRepCompare.remove('${escAttr(s.id)}')"
                aria-label="Take ${escAttr(s.name)} out of the comparison" title="Take it out of the comparison">✕</button>
      </li>`).join('')}</ul>`;
  }

  function verdictCell(fig) {
    if (!fig) return '<td>…</td>';
    if (fig.failed) return '<td>—</td>';
    if (fig.colo) return '<td>on it</td>';
    const cls = fig.verdict === 'obstructed' ? 'txt-bad' : fig.verdict === 'marginal' ? 'txt-warn' : '';
    return `<td class="${cls}">${esc(pathVerdictWord(fig.verdict))}</td>`;
  }

  function marginHtml(row, fig, star) {
    if (!fig) return '<span class="txt-muted">…</span>';
    if (fig.failed) return `<span class="term-chip txt-muted" title="${escAttr(`No figure: ${fig.failed}.`)}">—</span>`;
    const band = bandOf(fig);
    return `<span class="sites-band sites-band-${band}">${fig.colo ? 'on it' : dbText(fig.margin)}</span>${
      row.here && row.here.assumed && !fig.colo ? `<span class="term-chip txt-muted" title="${escAttr(meaning('assumed'))}">*</span>` : ''}${
      star ? `<span class="term-chip repcmp-star" title="${escAttr(meaning('best'))}">★</span>` : ''}`;
  }

  function picHtml(row, hub, fig) {
    if (!fig || fig.colo) return '';
    const label = `${row.st.name} → ${hub.name}`;
    const reading = fig.failed ? 'no figure' : `${dbText(fig.margin)} · ${pathVerdictWord(fig.verdict)}`;
    const pic = fig.thumb ? pathThumbSvg(fig.thumb)
      : `<span class="sites-thumb-none small txt-muted">No figure for this path</span>`;
    return `<button type="button" class="sites-thumb" onclick="event.stopPropagation(); MapRepCompare.profile('${escAttr(row.st.id)}', '${escAttr(hub.id)}', true)"
                    title="Open the elevation profile of ${escAttr(label)} full screen"
                    aria-label="${escAttr(`${label}: ${fig.dKm.toFixed(1)} km, ${reading}. Open its elevation profile full screen`)}">${pic}</button>`;
  }

  // One site's paths, a row a repeater — the 🗼 finder's table, turned round.
  function detailHtml(row) {
    const hubs = found.reps.filter(h => row.on.includes(h.id));
    return `
      <div class="sites-detail repcmp-detail">
        <div class="sites-actions">
          <button type="button" onclick="event.stopPropagation(); MapRepCompare.openCard('${escAttr(row.st.id)}')"
                  title="Open this station's card">Open its card</button>
          ${row.here ? `<span class="small txt-muted">Sends on ${esc(row.here.sysName || 'its radio')}${row.here.assumed ? ' (assumed)' : ''}, antenna ${row.here.agl} m up</span>` : ''}
        </div>
        <div class="table-wrap">
          <table class="sites-table sites-table-pics">
            <caption class="sr-only">${esc(row.st.name)} up to each repeater that carries it</caption>
            <thead><tr><th scope="col">Repeater</th><th scope="col">${term('km')}</th><th scope="col">${term('los')}</th><th scope="col">${term('margin')}</th><th scope="col" class="sites-t-pic">${term('pic')}</th><th scope="col"><span class="sr-only">Profile</span></th></tr></thead>
            <tbody>${hubs.map(h => {
              const fig = row.figs.get(h.id);
              const i = found.reps.indexOf(h);
              return `<tr>
                <td><span class="repcmp-key repcmp-key-${i}" aria-hidden="true">${i + 1}</span> ${esc(h.name)}</td>
                <td>${fig ? fig.dKm.toFixed(1) : '…'}</td>
                ${verdictCell(fig)}
                <td>${marginHtml(row, fig, row.best === h.id && hubs.length > 1)}</td>
                <td class="sites-t-pic">${picHtml(row, h, fig)}</td>
                <td>${fig && !fig.colo ? `<button type="button" class="btn-link" onclick="event.stopPropagation(); MapRepCompare.profile('${escAttr(row.st.id)}', '${escAttr(h.id)}')"
                      aria-label="Profile the path from ${escAttr(row.st.name)} to ${escAttr(h.name)}" title="Open this path in the elevation profile and link budget">↗</button>` : ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  // The grid: shared sites down the side, the picked repeaters across.
  function gridHtml() {
    if (!found.rows.length) return '';
    const cols = found.reps.length + 3;
    return `
      <div class="table-wrap repcmp-wrap">
        <table class="sites-table repcmp-grid" id="repcmp-grid">
          <caption class="sr-only">The sites two or more of the picked repeaters carry, and the fade margin up to each</caption>
          <thead><tr>
            <th scope="col">${term('site')}</th>
            ${found.reps.map((h, i) => `<th scope="col" class="repcmp-col"><span class="repcmp-key repcmp-key-${i}" aria-hidden="true">${i + 1}</span>
              ${termHtml(h.name, `${h.name}${h.number ? ` (${h.number})` : ''}, listening on ${h.f} MHz. ${meaning('cell')}`)}</th>`).join('')}
            <th scope="col">${term('best')}</th>
            <th scope="col">${term('spread')}</th>
          </tr></thead>
          <tbody>${found.rows.map(row => {
            const on = String(row.st.id) === String(selectedSid);
            const best = row.best != null ? found.reps.find(h => h.id === row.best) : null;
            return `
            <tr class="repcmp-row${on ? ' is-on' : ''}" data-sid="${escAttr(row.st.id)}" tabindex="0" role="button"
                aria-pressed="${on ? 'true' : 'false'}"
                title="Move the map to ${escAttr(row.st.name)} and light its paths to the repeaters that carry it"
                onclick="MapRepCompare.select('${escAttr(row.st.id)}')"
                onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); MapRepCompare.select('${escAttr(row.st.id)}'); }">
              <th scope="row">${esc(row.st.name)}<span class="small txt-muted repcmp-num">${esc(row.st.station_number || '')}</span></th>
              ${found.reps.map(h => `<td class="repcmp-col">${row.on.includes(h.id)
                ? marginHtml(row, row.figs.get(h.id), row.best === h.id)
                : `<span class="txt-muted" title="${escAttr(`${h.name} does not carry ${row.st.name}`)}">–</span>`}</td>`).join('')}
              <td class="repcmp-best">${best ? `<span class="repcmp-key repcmp-key-${found.reps.indexOf(best)}" title="${escAttr(best.name)}" aria-hidden="true">${found.reps.indexOf(best) + 1}</span><span class="sr-only">${esc(best.name)}</span>` : '—'}</td>
              <td>${row.spread == null ? '—' : `${row.spread.toFixed(1)} dB`}</td>
            </tr>
            ${on || showPics ? `<tr class="repcmp-detail-row"><td colspan="${cols}">${detailHtml(row)}</td></tr>` : ''}`;
          }).join('')}</tbody>
        </table>
      </div>
      ${pathThumbKeyHtml()}
      <p class="small txt-muted sites-thumbs-hint">Click a row to move the map to that site, light its paths and open each
        path's ${term('pic', 'ground profile')} — the site on the left, the repeater on the right.</p>`;
  }

  // One line a repeater: what it carries, how much of that is shared, what
  // only it carries, and how often it is the one that hears a shared site best.
  function summaryHtml() {
    return `
      <ul class="repcmp-sum">${found.reps.map((h, i) => {
        const shared = found.rows.filter(r => r.on.includes(h.id)).length;
        const only = found.only.get(h.id).length;
        const best = found.rows.filter(r => r.best === h.id).length;
        return `<li>
          <span class="repcmp-key repcmp-key-${i}" aria-hidden="true">${i + 1}</span>
          <strong>${esc(h.name)}</strong>
          <span class="bestrep-chips">
            ${chip('carries', `carries ${found.carried.get(h.id)}`)}
            ${chip('shared', `shared ${shared}`)}
            ${chip('only', `only it ${only}`)}
            ${found.done && shared ? chip('best', `hears best ${best}`) : ''}
          </span>
        </li>`;
      }).join('')}</ul>`;
  }

  function onlyHtml() {
    const any = found.reps.some(h => found.only.get(h.id).length);
    if (!any) return '';
    return `
      <details class="bestrep-words repcmp-only"><summary>The sites only one of them carries</summary>
        ${found.reps.map((h, i) => {
          const list = found.only.get(h.id);
          return `<p><span class="repcmp-key repcmp-key-${i}" aria-hidden="true">${i + 1}</span> <strong>${esc(h.name)}</strong> — ${
            list.length ? list.map(s => `<button type="button" class="link-btn" onclick="MapRepCompare.flyTo('${escAttr(s.id)}')"
              title="Move the map to ${escAttr(s.name)}">${esc(s.name)}</button>`).join(', ') : '<span class="txt-muted">none</span>'}</p>`;
        }).join('')}
      </details>`;
  }

  function resultsHtml() {
    if (!found) return '';
    return `
      ${summaryHtml()}
      ${found.rows.length ? `
        <label class="repcmp-pics"><input type="checkbox" ${showPics ? 'checked' : ''}
               onchange="MapRepCompare.set('pics', this.checked)"> Show every site's ground profiles</label>` : ''}
      ${gridHtml()}
      ${onlyHtml()}`;
  }

  function renderResults() {
    const el = document.getElementById('repcmp-results');
    if (el) el.innerHTML = resultsHtml();
  }

  function panelHtml() {
    if (!state.data) return '<p class="filter-note">No stations are loaded, so there are no repeaters to compare.</p>';
    const full = repIds.length >= MAX_REPS;
    return `
      <div class="sites-panel bestrep-panel repcmp-panel">
        <fieldset class="sites-fs">
          <legend>The repeaters to compare</legend>
          <div class="sites-row">
            <button type="button" onclick="MapRepCompare.addSelected()"
                    title="Add the repeater whose card is open on the map, or the one selected in the list or picked on the map">Add the selected repeater</button>
            <button type="button" onclick="MapRepCompare.addSelection()"
                    title="Add every repeater in the map selection — ctrl-click pins, or Select inside a drawn shape. Stations that are not repeaters are left out."
                    >Add the map selection (${state.mapSelection ? state.mapSelection.size : 0})</button>
          </div>
          <input type="search" id="repcmp-find" class="polar-find" autocomplete="off" spellcheck="false"
                 value="${escAttr(hitQ)}" placeholder="Or find one — repeater name or station #" ${full ? 'disabled' : ''}
                 aria-label="Find a repeater to add" oninput="MapRepCompare.setSearch(this.value)">
          <div class="polar-hits" id="repcmp-hits">${hitsHtml()}</div>
          ${chosenHtml()}
          ${note ? `<p class="small txt-muted" id="repcmp-note">${esc(note)}</p>` : ''}
          <p class="small txt-muted">Two to ${MAX_REPS} repeaters. What each ${term('carries', 'carries')} is read from its pass ranges.</p>
        </fieldset>

        <div class="sites-actions">
          <button type="button" id="repcmp-run" class="primary" onclick="MapRepCompare.run()"
                  ${readiness().ok && status.kind !== 'running' ? '' : 'disabled'}>Compare</button>
          <button type="button" id="repcmp-cancel" onclick="MapRepCompare.cancel()" ${status.kind === 'running' ? '' : 'hidden'}>Cancel</button>
          <button type="button" onclick="MapRepCompare.clear()" ${repIds.length || found ? '' : 'disabled'}>Clear</button>
          <button type="button" id="repcmp-save" onclick="MapRepCompare.save()" ${found && found.done && found.rows.length ? '' : 'disabled'}
                  title="Every shared site against every repeater that carries it, with every figure, as rows">Save CSV</button>
        </div>
        <p class="filter-note" id="repcmp-status">${statusHtml()}</p>
        <div id="repcmp-results">${resultsHtml()}</div>
        ${glossaryHtml()}
        <p class="filter-note">${esc(CAVEAT)}</p>
      </div>`;
  }

  const CAVEAT = 'Indicative. What a repeater carries is read from its pass ranges as filed, not from what was heard; '
    + '~30 m terrain and omnidirectional antennas. Open a path in the elevation profile card, and look at what 📻 Reception '
    + 'heard, before a repeater is switched off or a station is moved from one to another.';

  function render() {
    if (!body) return;
    const focusId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : null;
    body.innerHTML = panelHtml();
    if (focusId) { const el = document.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
  }

  function legendHtml() {
    if (!found) return '';
    return `
      <span class="legend-item">
        <span class="legend-site" aria-hidden="true">1</span>
        <span class="small">Repeater comparison — the numbered pins are the ${found.reps.length} repeaters compared; a line
          runs from each site they share to every one of them that carries it, coloured by fade margin: green ${goodDb()} dB
          or better, yellow ${okDb()}, red below, grey with no figure, dashed where the ground cuts the line. The site
          picked in the panel has its lines drawn heavy.</span>
      </span>`;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    if (layer) { layer.remove(); layer = null; }
    if (lineLayer) { lineLayer.remove(); lineLayer = null; }
  }

  function pinIcon(i) {
    return L.divIcon({
      className: 'mn-site-icon',
      html: `<span class="mn-site is-on"><i class="mn-site-mark" aria-hidden="true">${i + 1}</i></span>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function draw() {
    clearLayers();
    const reps = found ? found.reps : picked().map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
    if (!map || !reps.length) return;
    lineLayer = L.layerGroup([], { pane: LINE_PANE }).addTo(map);
    layer = L.layerGroup([], { pane: PANE }).addTo(map);
    if (found) {
      const sel = found.rows.find(r => String(r.st.id) === String(selectedSid)) || null;
      const line = (row, heavy) => {
        for (const id of row.on) {
          const h = found.reps.find(x => x.id === id);
          const fig = row.figs.get(id);
          L.polyline([[row.st.lat, row.st.lon], [h.lat, h.lon]], {
            pane: LINE_PANE, color: bandColour(bandOf(fig)), weight: heavy ? 4.5 : 1.5, opacity: heavy ? 0.95 : (sel ? 0.25 : 0.5),
            dashArray: fig && fig.verdict === 'obstructed' ? (heavy ? '8 6' : '5 5') : null, interactive: false,
          }).addTo(lineLayer);
        }
      };
      for (const row of found.rows) if (row !== sel) line(row, false);
      if (sel) {
        line(sel, true);
        const accent = cssVar('--accent', '#0b5cab');
        L.circleMarker([sel.st.lat, sel.st.lon], {
          pane: LINE_PANE, radius: 11, color: accent, weight: 3, opacity: 0.95, fill: true, fillColor: accent,
          fillOpacity: 0.2, interactive: false,
        }).addTo(lineLayer);
      }
    }
    reps.forEach((h, i) => {
      L.marker([h.lat, h.lon], { icon: pinIcon(i), pane: PANE, title: `${i + 1} — ${h.name}`, interactive: false, keyboard: false }).addTo(layer);
    });
  }

  // A row picked: the map goes to the site, framed with the repeaters its
  // lines run to — close enough to see the paths, wide enough to see all of
  // them. A second press on the same row lets go of it.
  function select(sid, opts) {
    if (!found) return;
    const row = found.rows.find(r => String(r.st.id) === String(sid));
    if (!row) return;
    const off = String(selectedSid) === String(sid) && !(opts && opts.keep);
    selectedSid = off ? null : row.st.id;
    draw();
    renderResults();
    if (off || !map) return;
    const pts = [[row.st.lat, row.st.lon], ...found.reps.filter(h => row.on.includes(h.id)).map(h => [h.lat, h.lon])];
    map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 13 });
    mapNote(`${row.st.name} — carried by ${row.on.map(id => found.reps.find(h => h.id === id).name).join(', ')}.`, 6000);
    const el = document.querySelector(`#repcmp-grid tr.repcmp-row[data-sid="${CSS.escape(String(row.st.id))}"]`);
    if (el) el.focus({ preventScroll: true });
  }

  function openProfile(sid, repId, full) {
    if (!found) return;
    const row = found.rows.find(r => String(r.st.id) === String(sid));
    const hub = found.reps.find(h => String(h.id) === String(repId));
    if (!row || !hub) return;
    const pa = [row.st.lat, row.st.lon], pb = [hub.lat, hub.lon];
    state.path.open = true;
    if (!full && state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
    const existing = MapDraw.findLine(pa, pb);
    if (existing) MapDraw.focus(existing.id);
    else MapDraw.addLine([pa, pb], [row.st.id, hub.id]);
    if (full) { PathProfile.openFull(); return; }
    const el = document.getElementById('path-profile-panel');
    if (el) {
      if (typeof dockReveal === 'function') dockReveal(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const where = typeof stationsCardsWhere === 'function' ? stationsCardsWhere() : 'with the station cards';
    mapNote(`Profiling ${row.st.name} → ${hub.name} — the card is ${where}.`, 5000);
  }

  function openPanel() {
    const wrap = document.querySelector('.mn-mapctl[data-panel="repcompare"]');
    if (!wrap) return false;
    if (wrap.classList.contains('is-docked')) {
      if (typeof setDockTab === 'function') setDockTab('map-repcompare');
    } else if (!wrap.classList.contains('is-open') && !(state.mapPanelsPinned && state.mapPanelsPinned.has('repcompare'))) {
      const btn = wrap.querySelector('.mn-mapctl-btn');
      if (btn) btn.click();
    }
    return true;
  }

  // ── The CSV ─────────────────────────────────────────────────────────────────
  // A line for every shared site against every picked repeater: the ones that
  // carry it with their figures, the ones that do not saying so, so the file
  // is the grid whole.

  function csvText() {
    if (!found || !found.rows.length) return '';
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const f1 = v => (v == null || !isFinite(v) ? '' : v.toFixed(1));
    const rows = [
      '# Flood-Net repeater comparison',
      `# repeaters,${found.reps.map(h => q(h.name)).join(',')}`,
      `# rules,carries: pass ranges within ${found.K} km,ok ${okDb()} dB,good ${goodDb()} dB`,
      ['site_id', 'site', 'station_number', 'site_lat', 'site_lon', 'site_radio', 'site_radio_assumed', 'carried_by_count',
       'repeater_id', 'repeater', 'repeater_rx_mhz', 'carries', 'distance_km', 'line_of_sight', 'path_loss_db',
       'fade_margin_db', 'band', 'best_heard_by', 'gap_db', 'note'].join(','),
    ];
    for (const row of found.rows) {
      for (const h of found.reps) {
        const on = row.on.includes(h.id);
        const fig = on ? row.figs.get(h.id) : null;
        const band = fig && !fig.failed ? bandOf(fig) : '';
        rows.push([
          q(row.st.id), q(row.st.name), q(row.st.station_number || ''), row.st.lat, row.st.lon,
          q(row.here ? row.here.sysName : ''), row.here && row.here.assumed ? 'yes' : '', row.on.length,
          q(h.id), q(h.name), h.f, on ? 'yes' : 'no',
          acmaHaversineKm(row.st.lat, row.st.lon, h.lat, h.lon).toFixed(2),
          fig && !fig.failed && fig.verdict ? q(pathVerdictWord(fig.verdict)) : '', fig && !fig.failed ? f1(fig.loss) : '',
          fig && !fig.failed ? f1(fig.margin) : '', band === 'bad' ? 'poor' : band === 'none' ? '' : band,
          row.best === h.id ? 'yes' : '', f1(row.spread), q(fig && fig.failed ? fig.failed : fig && fig.colo ? 'on the same site' : ''),
        ].join(','));
      }
    }
    return rows.join('\n') + '\n';
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    attach(m) {
      map = m;
      if (!m.getPane(LINE_PANE)) { const p = m.createPane(LINE_PANE); p.style.zIndex = LINE_Z; p.style.pointerEvents = 'none'; }
      if (!m.getPane(PANE)) { const p = m.createPane(PANE); p.style.zIndex = PANE_Z; p.style.pointerEvents = 'none'; }
      // After 🎯 Best repeater: that asks which mast for one station, this
      // sets the masts side by side.
      MapChrome.panel(m, {
        id: 'repcompare', icon: '⚖️', dockIcon: Glyphs.rail('repcompare'), title: 'Repeater comparison',
        btnLabel: 'Repeater comparison — the sites two or more repeaters both carry, path by path',
        group: 'tools', order: 28,
        html: () => panelHtml(),
        onMount(el) { body = el; },
        // The rail's gold ring and 🧹 Clear the selection (app.js, "Which
        // tools have something on") find these here.
        live: () => MapRepCompare.live(),
        clear: () => MapRepCompare.clear(),
      });
      draw();
    },

    detach() {
      if (job) { job.cancelled = true; job = null; if (!found || !found.done) found = null; status = { kind: 'idle', text: '' }; }
      clearLayers();
      body = null;
      map = null;
    },

    // An answer on the map, for the legend; and "is something of this tool's
    // on" for the rail: repeaters picked, a run going, or an answer.
    active() { return !!found; },
    live() { return !!found || !!job || picked().length > 0; },
    legendHtml,
    run,

    cancel() {
      if (job) job.cancelled = true;
      job = null;
      found = null;
      setStatus('idle', '');
      draw();
      render();
    },

    // Reset's half and the panel's Clear: the repeaters, the answer, all of
    // it off the map. This tool arms nothing, so there is nothing to disarm.
    clear() {
      invalidate();
      repIds = [];
      hitQ = '';
      note = '';
      showPics = false;
      save();
      draw();
      render();
      rerenderMapLegend();
    },

    add(id) {
      const s = stationById(id);
      if (!s) return;
      hitQ = '';
      after(addReps([s]));
    },

    remove(id) {
      const n = repIds.length;
      repIds = repIds.filter(x => String(x) !== String(id));
      if (repIds.length !== n) { invalidate(); save(); }
      note = '';
      draw();
      render();
      rerenderMapLegend();
    },

    addSelected() {
      const id = typeof selectedStationId === 'function' ? selectedStationId() : null;
      const s = id != null ? stationById(id) : null;
      if (!isRepeater(s)) {
        note = 'Select a repeater first — open its card, pick its row, or click its pin — then press this.';
        if (map) mapNote(note, 5000);
        render();
        return;
      }
      after(addReps([s]));
    },

    addSelection() {
      const ids = state.mapSelection ? [...state.mapSelection] : [];
      if (!ids.length) {
        note = 'Nothing is selected on the map — ctrl-click repeaters\' pins, or Select inside a drawn shape, then press this.';
        render();
        return;
      }
      after(addReps(ids.map(stationById).filter(Boolean)));
    },

    setSearch(v) {
      hitQ = String(v || '');
      const el = document.getElementById('repcmp-hits');
      if (el) el.innerHTML = hitsHtml();
    },

    set(key, value) {
      if (key === 'pics') { showPics = !!value; renderResults(); }
    },

    select,
    profile: openProfile,

    flyTo(id) {
      const s = stationById(id);
      if (!s || !map || s.lat == null) return;
      map.panTo([s.lat, s.lon]);
      mapNote(`${s.name} — ${stationLatLonText(s)}`, 6000);
    },

    openCard(id) {
      if (typeof showStationCard === 'function') showStationCard(id);
      else if (typeof selectStation === 'function') selectStation(id);
    },

    save() {
      const text = csvText();
      if (!text) return;
      dlText(`floodnet-repeater-comparison-${slug(found.reps.map(h => h.name).join('-')).slice(0, 80)}.csv`, text);
    },

    csvText,

    // Open the panel with these repeaters in it (ids) — for a hand-off from
    // another tool or a card, and the checks.
    openFor(ids) {
      invalidate();
      repIds = [];
      after(addReps((ids || []).map(stationById).filter(Boolean)));
      openPanel();
    },

    // For the checks and the map's legend.
    status() { return { ...status, done: !!(found && found.done) }; },
    repeaters() { return picked().map(s => s.id); },
    selected() { return selectedSid; },
    results() {
      if (!found) return null;
      return {
        reps: found.reps.map(h => ({ id: h.id, name: h.name, f: h.f, carried: found.carried.get(h.id), only: found.only.get(h.id).map(s => s.id) })),
        rows: found.rows.map(r => ({ id: r.st.id, name: r.st.name, on: r.on.slice(), best: r.best, spread: r.spread,
          assumed: !!(r.here && r.here.assumed),
          figs: Object.fromEntries([...r.figs].map(([id, f]) => [id, { dKm: f.dKm, margin: f.margin == null ? null : f.margin, loss: f.loss == null ? null : f.loss, verdict: f.verdict || null, failed: f.failed || null, colo: !!f.colo, thumb: !!f.thumb }])) })),
      };
    },
    // One path's figure worked out afresh, for the checks to hold the grid to.
    priceOne(sid, repId) {
      const st = stationById(sid), rep = stationById(repId);
      return st && rep ? price(st, siteRadio(st), hubOf(rep)) : Promise.resolve(null);
    },
  };
})();
