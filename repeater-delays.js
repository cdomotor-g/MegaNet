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

  // ── The words this page uses in its own sense ──────────────────────────────
  // Every heading, chip and figure whose word means something particular here
  // carries its meaning on hover (core.js termHtml), from this one list, so a
  // heading and the chip under it never explain the same word two ways. The
  // timings follow the settings, so they are worked out with them. The same
  // meanings are said in words under "How it is worked out", for a finger or
  // a keyboard, which never hover.
  function words(o) {
    const f = ms(o.frameMs), c = ms(o.clearMs), l = ms(o.leadMs);
    const nowIs = o.currentMs == null ? 'what they are set to now is not known'
      : `every repeater is on ${ms(o.currentMs)} now, as entered above`;
    return {
      onRecord: 'In the station register: each repeater\'s position, channels and pass ranges — and its delay, once somebody records it after setting it on site.',
      assumed: `Taken as given, not measured: a repeater hears a field station up to ${num(o.fieldKm)} km away and a repeater or base up to ${num(o.linkKm)} km, in a straight line; a lead-in lasts ${l}, not yet timed on these repeaters; and ${nowIs}.`,
      suggested: 'A delay this plan asks for. Not what the repeater is set to now, and not written to any station.',
      predicted: 'Worked out from what is on record and what is assumed, not seen on the air: how far apart two copies land, on top, close or clear, and every count of pairs.',
      measured: 'Nothing on this page. What the receivers actually decode is on Bit-Flip Sources and Station Health — check a group there once its delays are set.',
      delay: 'The delay this plan suggests: how long the repeater should wait, after it has heard a reading, before sending it on. A suggestion, not what it is set to now — unless marked on record. It is set in the repeater itself; Flood-Net only records it.',
      channel: 'The frequency the repeater listens on, then the one it sends on, in MHz — one number when they are the same — as recorded in the station register. Two repeaters can only collide on the same sending channel.',
      now: 'What the repeater is set to today: on record when its station has a delay recorded, assumed when it is the one delay entered above. "change" means the suggested delay is different — a site visit.',
      neighbour: 'The other repeater whose copies of a shared reading land nearest in time to this one\'s with the suggested delays — with its own delay, how far away it is, and how many readings the two both send on.',
      apart: `How far apart in time the two repeaters start sending their copies of the same reading, at the closest — predicted, not measured. Under ${f} the copies overlap bit on bit; ${c} or more and they are clear of each other.`,
      state: 'How this repeater is predicted to come out against its closest neighbour with the suggested delays: on top, close or clear.',
      readings: 'How many readings this repeater sends on that another repeater also sends on, to a receiver that hears both — how much rides on getting its delay right. A reading here is one station\'s one ALERT address, such as a rain gauge\'s rainfall.',
      reading: 'One station\'s one ALERT address — a rain gauge\'s rainfall, a river gauge\'s height, a battery. Each is sent on its own, and each can be relayed by more than one repeater.',
      ontop: `The two copies start less than one frame (${f}) apart, so their bits overlap. A receiver hearing both often decodes a mix of the two: flipped bits, and readings filed under the wrong address (ghosts). This is the one to get rid of.`,
      close: `The copies start a frame (${f}) or more apart, but less than a lead-in and a frame (${c}). The later repeater comes on the air while the earlier one is still sending its data, so that earlier copy is spoilt wherever the two arrive about equally strong — usually lost rather than turned into a ghost.`,
      clear: `The copies start at least a lead-in and a frame (${c}) apart, so neither touches the other and both arrive clean.`,
      frame: `The ALERT message itself: 40 bits at 300 baud, ${f} on the air.`,
      leadin: `The time from a transmitter switching on to its first data bit — the radio settling and the tone receivers lock on to. Taken as ${l}, the app's own figure; nobody has timed it on these repeaters yet.`,
      pair: 'Two repeaters that both send on at least one of the same readings, and are both heard by a base station or a repeater that wants that reading — so their copies can collide.',
      group: 'Repeaters joined by pairs, directly or through each other. Moving one repeater\'s delay can move the problem onto another in the same group, so set a group\'s delays together.',
      where: 'The base stations and repeaters that would hear both copies — within reach of both, on their sending channel, and wanting the reading. This is where the two collide.',
      oneDelay: `How far apart the two copies would land if every repeater had the same delay — assumed, since ${nowIs}. Predicted, not measured.`,
      planned: 'How far apart the two copies would land with the suggested delays — predicted, not measured.',
      used: 'How many different delay values the plan needs, and the longest of them.',
      limit: 'The longest delay the repeaters\' own settings accept — your pick, not something on record. Flood-Net\'s register can only record up to 999 ms today, so a longer plan cannot be written down yet.',
      current: 'If you know every repeater is set to the same delay now, enter it: the plan then leaves as many as it can on that value, so fewer sites need a visit. Leave it blank if nobody knows.',
      keep: 'Treat a delay already recorded on a station as set in the field and fixed, and plan the other repeaters around it. Untick to plan every repeater afresh.',
      recorded: 'This delay is recorded on the repeater\'s station, so the plan keeps it as it is rather than suggesting another.',
      nowAssumed: 'Nothing is recorded on this repeater\'s station; this is the one delay entered above as what they all share.',
      change: 'The suggested delay is different from the one this repeater has now — a site visit.',
      free: 'No other repeater sends on the same readings to a receiver that hears both, so this repeater\'s delay cannot cause a collision. Leave it as it is.',
      km: 'Straight-line distance between the two repeaters, in kilometres.',
      linked: 'Repeaters that send on at least one reading another repeater also sends on, to a receiver hearing both — the ones whose delays matter.',
      pairReadings: 'How many readings both repeaters send on — each one station\'s one ALERT address.',
      unknownChannel: 'No channel is on record for this repeater, so the plan assumes it shares one with its neighbours — which errs towards a collision rather than away from one.',
      unplaced: 'This repeater has no position on record, so the plan cannot tell what it hears.',
      nothingPassed: 'Its pass ranges let no address through, so it relays nothing the plan can place.',
    };
  }
  // Worked out on first use and again by each render(), from the settings in
  // force — never at load.
  let W = null;
  const word = key => (W || (W = words(opts())))[key];
  const term = (key, text) => termHtml(text, word(key));
  // The words, in the order the glossary fold lists them, with the label each
  // is shown under there.
  const GLOSSARY = [
    ['delay', 'Suggested delay'], ['reading', 'Reading'], ['pair', 'Pair'], ['group', 'Group'], ['ontop', 'On top'], ['close', 'Close'],
    ['clear', 'Clear'], ['apart', 'Apart'], ['frame', 'Frame'], ['leadin', 'Lead-in'], ['channel', 'Channel'], ['now', 'Set now'],
    ['neighbour', 'Closest neighbour'], ['state', 'State'], ['readings', 'Readings shared'], ['where', 'Heard together at'],
    ['oneDelay', 'All on one delay'], ['planned', 'Suggested delays'], ['used', 'Delays used'], ['free', 'No neighbour on its readings'],
    ['recorded', 'On record'], ['change', 'Change'],
  ];
  // Where a figure comes from, each with the pill it is marked with. The key
  // under the settings lists them in words; a pill beside a figure carries
  // the same meaning on hover.
  const SOURCES = [
    ['record', 'On record', 'onRecord'], ['assumed', 'Assumed', 'assumed'], ['suggested', 'Suggested', 'suggested'],
    ['predicted', 'Predicted', 'predicted'], ['measured', 'Measured', 'measured'],
  ];

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
    return B ? `<span class="rd-b ${B.cls} term-chip" title="${esc(word(b))}">${esc(B.label)}</span>` : '';
  }
  // A pill saying where a figure comes from; `meaning` for one that says more
  // than the source's own words (a delay on record says why it is kept).
  function srcHtml(kind, text, meaning) {
    const s = SOURCES.find(x => x[0] === kind);
    return `<span class="rd-src rd-src--${kind} term-chip" title="${esc(meaning || word(s[2]))}">${esc(text || s[1].toLowerCase())}</span>`;
  }
  function statusHtml(s) {
    if (BAND[s]) return bandHtml(s);
    const why = { free: word('free'), unplaced: word('unplaced'), 'nothing-passed': word('nothingPassed') }[s];
    return `<span class="rd-b rd-b--none${why ? ' term-chip" title="' + esc(why) : ''}">${esc(STATUS[s] || s)}</span>`;
  }
  function chan(r) {
    if (r.rx == null && r.tx == null) return `<span class="txt-muted">${term('unknownChannel', 'not recorded')}</span>`;
    return r.rx === r.tx ? `${esc(mhz(r.rx))}` : `${esc(mhz(r.rx))} → ${esc(mhz(r.tx))}`;
  }
  function stationBtn(id, name) {
    return `<button class="link-btn" onclick="RepeaterDelays.openStation('${escAttr(id)}')">${esc(name)}</button>`;
  }

  function settingsHtml(o) {
    const limit = LIMITS.find(l => l.ms === o.maxMs);
    return `<form class="rd-settings" onsubmit="return false" aria-label="What the plan assumes">
      <label><span>${term('limit', 'Longest delay the repeaters take')}</span>
        <select id="rd-max" onchange="RepeaterDelays.set('maxMs', +this.value)">
          ${LIMITS.map(l => `<option value="${l.ms}"${l.ms === o.maxMs ? ' selected' : ''}>${esc(l.label)}${l.note ? ` — ${esc(l.note)}` : ''}</option>`).join('')}
          ${limit ? '' : `<option value="${o.maxMs}" selected>${esc(ms(o.maxMs))}</option>`}
        </select></label>
      <label><span>${term('current', 'The delay they are on now, if they share one')}</span>
        <input type="number" id="rd-now" min="0" max="60000" step="1" inputmode="numeric" placeholder="not known"
          value="${o.currentMs == null ? '' : o.currentMs}" onchange="RepeaterDelays.set('currentMs', this.value)"></label>
      <label class="rd-check"><input type="checkbox" id="rd-keep"${o.keepRecorded ? ' checked' : ''}
          onchange="RepeaterDelays.set('keepRecorded', this.checked)"> ${term('keep', 'Keep the delays recorded on stations')}</label>
    </form>`;
  }

  // Where the figures come from, in words a finger or a keyboard can read —
  // the same meanings the pills carry on hover. How many delays are on record
  // is the one thing the register can answer outright, so it is said here.
  function sourcesHtml(p) {
    const c = p && p.counts;
    const extra = {
      record: !c ? '' : c.recorded
        ? ` ${num(c.recorded)} of the ${num(c.repeaters)} repeaters have a delay recorded.`
        : ` None of the ${num(c.repeaters)} repeaters has a delay recorded yet.`,
    };
    const tab = (id, name) => `<button class="link-btn" onclick="switchTab('${id}')">${name}</button>`;
    const text = k => k === 'measured'
      ? esc(word(k)).replace('Bit-Flip Sources', tab('flipsources', 'Bit-Flip Sources')).replace('Station Health', tab('health', 'Station Health'))
      : esc(word(k));
    return `<p class="small rd-key-h"><strong>Where the figures come from</strong></p>
      <dl class="rd-key">${SOURCES.map(([kind, label, k]) =>
        `<dt><span class="rd-src rd-src--${kind}">${esc(label)}</span></dt><dd>${text(k)}${esc(extra[kind] || '')}</dd>`).join('')}</dl>`;
  }

  function tilesHtml(p) {
    const c = p.counts;
    // `label` is markup: its terms are termHtml's, everything else escaped here.
    const tile = (n, label, cls) => `<div class="bk-tile"><span class="bk-tile-n${cls ? ' ' + cls : ''}">${esc(n)}</span> <span class="bk-tile-l">${label}</span></div>`;
    const pairs = term('pair', 'pairs');
    return `<p class="small rd-tiles-h">${srcHtml('predicted', 'Predicted')} from the register and the assumptions — not measured on the air</p>
      <div class="bk-tiles">
      ${tile(num(c.linked), `of the ${num(c.repeaters)} repeaters ${term('linked', 'share readings with a neighbour')}, in ${num(p.clusters.length)} ${term('group', p.clusters.length === 1 ? 'group' : 'groups')}`)}
      ${tile(`${num(c.ontopSame)} → ${num(c.ontop)}`, `${pairs} sending copies ${term('ontop', 'on top of each other')}: ${term('oneDelay', 'all on one delay')} → ${term('planned', 'suggested delays')}`, c.ontop ? 'stat-bad' : '')}
      ${tile(num(c.close), `${pairs} still ${term('close', 'close')} — a key-up on the other's frame`, c.close ? 'txt-warn' : '')}
      ${tile(num(c.clear), `${pairs} ${term('clear', 'clear')}, of ${num(c.pairs)}`, '')}
      ${tile(num(c.free), `repeaters with ${term('free', 'no neighbour on their readings')} — any delay will do`, '')}
    </div>`;
  }

  function answerHtml(p) {
    const c = p.counts, o = p.settings;
    const steps = c.delaysUsed.length;
    const parts = [];
    // What the comparison starts from: the delay entered above, or — nothing
    // being known — every repeater on one delay, said as the assumption it is.
    const from = o.currentMs != null
      ? `With every repeater on ${ms(o.currentMs)}, as ${term('assumed', 'assumed')} above, the plan`
      : `${c.recorded ? `Only ${num(c.recorded)} of the ${num(c.repeaters)} repeaters ${c.recorded === 1 ? 'has its' : 'have their'} delay` : 'No repeater has its delay'} on record,
        so the plan ${term('assumed', 'assumes')} they are all on one delay today; that way it`;
    parts.push(`Set each repeater to its <strong>${term('delay', 'suggested delay')}</strong> in the table below. ${from}
      ${term('predicted', 'predicts')} <strong>${num(c.ontopSame)}</strong> ${term('pair', c.ontopSame === 1 ? 'pair' : 'pairs')} of repeaters
      sending their copies of the same ${term('reading', 'reading')} ${term('ontop', 'on top of each other')} at a receiver that hears both —
      the collisions that come out as flipped bits. With the suggested delays it predicts ${c.ontop ? `<strong>${num(c.ontop)}</strong> still do` : '<strong>none</strong> do'},
      ${num(c.close)} ${c.close === 1 ? 'is' : 'are'} ${term('close', 'close')}, and ${num(c.clear)} ${c.clear === 1 ? 'is' : 'are'} ${term('clear', 'clear')}.`);
    parts.push(`The plan uses ${plural(steps, 'different delay')} between ${ms(c.delaysUsed[0] || 0)} and ${ms(c.delaysUsed[steps - 1] || 0)};
      two copies are clear of each other ${ms(o.clearMs)} apart (a ${ms(o.leadMs)} ${term('leadin', 'lead-in')}, assumed and not yet timed on
      these repeaters, and a ${ms(o.frameMs)} ${term('frame', 'frame')}).`);
    if (o.maxMs < 1000 && (c.ontop || c.close)) {
      parts.push(`Under a second there is not room to clear every pair: the busiest groups need their copies spread over more than a
        second. If the repeaters take longer delays, pick the limit above and the plan follows — see <em>What a longer delay buys</em>.`);
    }
    if (c.channelUnknown) {
      parts.push(`${plural(c.channelUnknown, 'repeater has', 'repeaters have')} no channel on record, so each is assumed to share one with
        its neighbours — recording the channels may free some of them.`);
    }
    if (c.recorded) parts.push(`${plural(c.recorded, 'repeater has a delay', 'repeaters have delays')} recorded on ${c.recorded === 1 ? 'its station' : 'their stations'}${o.keepRecorded ? ', kept as recorded and marked on record' : ', planned afresh'}.`);
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
          <thead><tr><th scope="col">${term('limit', 'Longest delay')}</th><th scope="col" class="num">${term('ontop', 'On top')}</th>
            <th scope="col" class="num">${term('close', 'Close')}</th><th scope="col" class="num">${term('clear', 'Clear')}</th>
            <th scope="col">${term('used', 'Delays used')}</th></tr></thead>
          <tbody>
            <tr><th scope="row">Every repeater ${term('oneDelay', 'on one delay')}</th><td class="num">${num(rows[0].counts.ontopSame)}</td>
              <td class="num">${num(rows[0].counts.closeSame)}</td><td class="num">${num(rows[0].counts.clearSame)}</td><td>one</td></tr>
            ${rows.map(p => `<tr${p.settings.maxMs === opts().maxMs ? ' class="is-selected"' : ''}>
              <th scope="row">${esc((LIMITS.find(l => l.ms === p.settings.maxMs) || { label: ms(p.settings.maxMs) }).label)}</th>
              <td class="num">${num(p.counts.ontop)}</td><td class="num">${num(p.counts.close)}</td><td class="num">${num(p.counts.clear)}</td>
              <td>${num(p.counts.delaysUsed.length)}, up to ${ms(p.counts.delaysUsed[p.counts.delaysUsed.length - 1] || 0)}</td></tr>`).join('')}
          </tbody>
        </table></div>
        <p class="small txt-muted">Every count here is predicted, from the same register and assumptions. A delay over 999 ms cannot be
          recorded on a station yet — the register's limit (0015). Check the repeaters' own limit before planning past a second.</p>`;
    return `<details class="rd-fold" data-k="compare"><summary><h3 class="bk-inline-h" id="rd-h-compare">What a longer delay buys</h3></summary>
      ${body}</details>`;
  }

  function tableHtml(p) {
    const byId = new Map(p.repeaters.map(r => [r.id, r]));
    const showNow = p.repeaters.some(r => r.baseline != null);
    const cols = showNow ? 8 : 7;
    const rows = p.clusters.map(c => {
      const head = `<tr class="rd-group"><th scope="rowgroup" colspan="${cols}" id="rd-g-${c.n}">
        ${term('group', `Group ${c.n}`)} · ${esc(c.name)} <span class="small txt-muted">— ${plural(c.repeaters.length, 'repeater')},
        ${num(c.pairs)} ${term('pair', c.pairs === 1 ? 'pair' : 'pairs')}; ${term('oneDelay', 'all on one delay')} ${esc(BAND[c.worstSame].label.toLowerCase())},
        ${term('planned', 'suggested delays')} ${esc(BAND[c.worst].label.toLowerCase())}</span></th></tr>`;
      return head + c.repeaters.map(id => rowHtml(byId.get(id), showNow, byId)).join('');
    }).join('');
    return `<div class="table-wrap" role="region" tabindex="0" aria-labelledby="rd-h-table">
      <table class="hl-table rd-table">
        <caption class="sr-only">Each repeater's suggested delay, group by group: its channel, its closest neighbour with the suggested delays and how far apart their copies are predicted to land, and how many readings it shares</caption>
        <thead><tr><th scope="col">Repeater</th><th scope="col">${term('channel', 'Channel, MHz')}</th>
          <th scope="col" class="num">${term('delay', 'Suggested delay')}</th>
          ${showNow ? `<th scope="col" class="num">${term('now', 'Set now')}</th>` : ''}
          <th scope="col">${term('neighbour', 'Closest neighbour')}</th><th scope="col" class="num">${term('apart', 'Apart, predicted')}</th>
          <th scope="col">${term('state', 'State, predicted')}</th><th scope="col" class="num">${term('readings', 'Readings shared')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  // Every delay in a row says where it comes from: the suggestion bare (the
  // column says so), one on record marked, and what it is set to now marked
  // on record or assumed — "—" when nobody knows.
  function rowHtml(r, showNow, byId) {
    const n = r.neighbours[0];
    const other = n && byId ? byId.get(n.id) : null;
    const now = r.baseline == null ? `<span class="txt-muted">not known</span>`
      : `${ms(r.baseline)} ${r.recorded != null ? srcHtml('record', 'on record', word('recorded')) : srcHtml('assumed', 'assumed', word('nowAssumed'))}`
        + `${r.change ? ` <span class="rd-change term-chip" title="${esc(word('change'))}">change</span>` : ''}`;
    return `<tr id="rd-r-${escAttr(r.id)}">
      <th scope="row">${stationBtn(r.id, r.name)}</th>
      <td>${chan(r)}</td>
      <td class="num"><span class="rd-delay">${ms(r.delay)}</span>${r.fixed ? ` ${srcHtml('record', 'on record', word('recorded'))}` : ''}</td>
      ${showNow ? `<td class="num">${now}</td>` : ''}
      <td>${n ? `${esc(n.name)} <span class="small txt-muted">${other && other.fixed ? 'on record' : 'suggested'} ${ms(n.otherDelay)} · ${num(Math.round(n.km))} km away · ${plural(n.weight, 'reading')} together</span>` : '—'}</td>
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
      <p class="small">Two repeaters that relay the same reading and are heard together by a base station or a repeater that wants it. The last two
        columns are the closest their copies come — two copies of one reading, through any number of hops — predicted with every repeater on one
        delay and with the suggested delays.</p>
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="rd-h-pairs">
      <table class="hl-table rd-pairs">
        <caption class="sr-only">Every pair of repeaters that can put copies of one reading on top of each other: how far apart, how many readings, where they meet, and how far apart their copies are predicted to land with every repeater on one delay and with the suggested delays</caption>
        <thead><tr><th scope="col">Repeaters</th><th scope="col" class="num">${term('km', 'km')}</th>
          <th scope="col" class="num">${term('pairReadings', 'Readings')}</th><th scope="col">${term('where', 'Heard together at')}</th>
          <th scope="col">${term('oneDelay', 'All on one delay')}</th><th scope="col">${term('planned', 'Suggested delays')}</th></tr></thead>
        <tbody>${p.pairs.map(x => `<tr>
          <th scope="row">${esc(x.aName)} &amp; ${esc(x.bName)}</th>
          <td class="num">${num(Math.round(x.km))}</td><td class="num">${num(x.weight)}</td>
          <td class="small">${esc(x.where.slice(0, 3).map(w => w.name).join(', '))}${x.where.length > 3 ? ` and ${num(x.where.length - 3)} more` : ''}</td>
          <td>${bandHtml(x.bandSame)} <span class="small">${ms(x.sepSameMs)}</span></td>
          <td>${bandHtml(x.band)} <span class="small">${ms(x.sepMs)}</span></td>
        </tr>`).join('')}</tbody>
      </table></div></details>`;
  }

  // Every word above with a meaning on hover, listed with it: hover is for a
  // mouse, and this is the same explanation for a finger or a keyboard.
  function glossaryHtml() {
    return `<details class="rd-fold" data-k="words"><summary><h3 class="bk-inline-h" id="rd-h-words">What the words on this page mean</h3></summary>
      <dl class="rd-words">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(word(k))}</dd>`).join('')}</dl>
    </details>`;
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
          delay (ms)</em> — and from then on it shows here as on record and the plan keeps it. The register takes up to 999 ms.</li>
      </ul>
      <p><button class="btn" onclick="RepeaterDelays.reset()">Put the settings back</button></p>
    </details>`;
  }

  function render() {
    const o = opts();
    W = words(o);
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
          Queensland and northern New South Wales. A plan, not a record: every delay here is a suggestion, not one read off a repeater,
          and nothing here is written to a station.</p>
        ${settingsHtml(o)}
        ${sourcesHtml(p)}
        ${body}
      </div>
      ${p ? `
      <div class="panel">
        <div class="panel-header"><h3 id="rd-h-table">The delays, group by group</h3>
          <button class="btn" onclick="RepeaterDelays.exportCsv()">Save as CSV</button></div>
        <p class="small">Repeaters in a group relay some of the same readings and are heard together somewhere, so set a group's delays
          together. Busiest group first; in each, the repeater sharing the most readings first. <em>Apart</em> is how close its copies are
          predicted to come to its closest neighbour's with the suggested delays.${p.repeaters.some(r => r.baseline != null) ? ''
            : ' No repeater\'s delay is on record, so what each is set to now is not known — every delay in this table is a suggestion.'}</p>
        ${tableHtml(p)}
        ${freeHtml(p)}
        ${compareHtml()}
        ${pairsHtml(p)}
        ${glossaryHtml()}
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
    // Named for where each figure comes from, as the page marks them: now_ms
    // with now_source (recorded, or assumed from the delay entered), the
    // suggestion, and what it is predicted to give.
    const head = ['group', 'group_name', 'repeater', 'station_id', 'hub', 'rx_mhz', 'tx_mhz', 'suggested_delay_ms', 'now_ms', 'now_source',
      'change', 'recorded_kept', 'closest_neighbour', 'neighbour_delay_ms', 'predicted_apart_ms', 'predicted_state', 'readings_shared',
      'limit_ms', 'lead_in_ms_assumed'];
    const groupName = new Map(p.clusters.map(c => [c.n, c.name]));
    const order = p.clusters.flatMap(c => c.repeaters).concat(p.repeaters.filter(r => !r.linked).map(r => r.id));
    const byId = new Map(p.repeaters.map(r => [r.id, r]));
    const lines = [head.join(',')];
    for (const id of order) {
      const r = byId.get(id);
      const n = r.neighbours[0];
      lines.push([r.cluster || '', r.cluster ? groupName.get(r.cluster) : '', r.name, r.id, r.hub, r.rx ?? '', r.tx ?? '', r.delay,
        r.baseline ?? '', r.recorded != null ? 'recorded' : r.baseline != null ? 'assumed' : 'not known',
        r.change == null ? '' : r.change ? 'yes' : 'no', r.fixed ? 'yes' : 'no',
        n ? n.name : '', n ? n.otherDelay : '', n ? n.sepMs : '', STATUS[r.status] || r.status, r.readings,
        p.settings.maxMs, p.settings.leadMs].map(csvEscape).join(','));
    }
    dlText(`floodnet-repeater-delays-${p.settings.maxMs}ms.csv`, lines.join('\n') + '\n');
  }

  function exportPairsCsv() {
    const p = current();
    if (!p || !p.pairs.length) return;
    const head = ['repeater_a', 'repeater_b', 'km', 'readings_shared', 'heard_together_at', 'predicted_apart_on_one_delay_ms', 'on_one_delay',
      'predicted_apart_suggested_ms', 'with_suggested_delays', 'example_stations'];
    const lines = [head.join(',')];
    for (const x of p.pairs) {
      lines.push([x.aName, x.bName, x.km, x.weight, x.where.map(w => w.name).join('; '), x.sepSameMs, BAND[x.bandSame].label,
        x.sepMs, BAND[x.band].label, x.sources.map(s => `${s.name} (${s.address})`).join('; ')].map(csvEscape).join(','));
    }
    dlText(`floodnet-repeater-delay-pairs-${p.settings.maxMs}ms.csv`, lines.join('\n') + '\n');
  }

  return { render, init, set: setOpt, reset, compare, openStation, exportCsv, exportPairsCsv, current, suggestion, planAtDefaults,
           state: () => S };
})();
