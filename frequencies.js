// MegaNet — frequencies.js
//
//   Frequencies   a station's RX/TX frequency pairs — a repeater's own pair and
//                 every other channel it or a base station uses (0033) — as
//                 rows in the station editor that "+ Add frequency" adds to,
//                 and as a line each on the station card. And on the card,
//                 under them, what it is *assumed* to transmit on, what it
//                 was *heard on* (see "Assumed, and heard on" below), and the
//                 protocol its readings came in on — legacy ALERT or ALERT2.
//                 Under Assumed, map-direct.js's Links: every step up the
//                 network toward the base stations — the repeaters that carry
//                 it or relay it on, and every base station that hears it
//                 direct — with each one's fade margin as a bar, the best
//                 first; a base station's say it is where readings come in. Each
//                 part a heading over its content, and at the top of the
//                 Radio tab a two-line summary: its best link, and whether
//                 everything it was heard on is explained.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, hintToggleHtml, fmtKm and
// acmaHaversineKm, to station-editor.js for editorUnsavedRemoved/
// editorUnsavedRefresh when a row comes and goes, to app.js for stationAlertIds
// and findRepeaterMatches, to health-glance.js for HealthGlance.channels,
// protocol and onHeard, and to map-latency.js for the Protocol line's window,
// words and keys (MapLatency.windowSpan, protoKeyHtml…). station-editor.js places editorHtml() and reads readForm()/
// formProblem() on save; app.js's stnCardHtml() places cardHtml(). All of it at
// call time: the IIFE body only declares, so this file's position among the
// modules is free (`npm run toplevel`).
//
// ── Two homes for a pair, on purpose ─────────────────────────────────────────
// A repeater's own RX/TX pair stays on the repeater (meganet.repeater.rx_mhz /
// tx_mhz, `repeater.rx_mhz` in the document): it is what the path profile, the
// fade map, the backbone, the frequency layer and the ACMA threat analysis all
// read, and it is the primary pair. Every *other* pair is a row of the
// station's `frequencies` list — a second ALERT channel, a voice or link
// channel — and a base station, which has no repeater row, keeps all of its
// pairs there. The editor draws the two as one list of rows with the primary
// first, because to the person typing them they are one list.
//
// ── What a save sends ────────────────────────────────────────────────────────
// Only a list that changed, on river-details.js's terms: save_station() leaves
// a list the document does not mention exactly as it is.
//
// ── Assumed, and heard on ────────────────────────────────────────────────────
// A field station's own TX is never on record, so the card gives two other
// answers to "what does it transmit on?", one from the register and one from
// the air, each labelled as what it is.
//
// **Assumed** is the RX of the repeaters likely to hear it directly. Every
// repeater whose pass ranges carry one of its AlertIDs carries it, but a
// carrier further off often has it second-hand, on the channel a nearer
// carrier relays it on — and that carrier's RX says nothing about the
// station. So a carrier counts as a likely direct link when it is within the
// Max TX distance of the station (the map's own slider, the rule its links and
// the backbone are drawn by) and is not fed by a nearer one: a carrier closer
// to the station whose TX is this one's RX, within the Max TX distance of it.
// The nearest in range always counts. Upper Rainbow AL is the case: Kroombit
// (28 km, in and out on 151.500), Banana Range (47 km, listening on 151.500,
// Kroombit's TX) and Mt Hopeful (57 km, listening on 152.400, Banana Range's)
// all carry it, and only Kroombit is taken to hear it first-hand.
//
// **Heard on** is the channel each of its readings was heard on by a base
// station's receiver (0050), directly or through a repeater — from the
// readings its card's Health section already asks for (HealthGlance.channels),
// so it costs no request of its own, and painted in place when they land.
// Each channel says what is known to be on it: its assumed TX (heard direct),
// a carrier's TX (relayed), or neither.
//
// **Protocol**, under it, is how those readings came in: legacy ALERT, inside
// ALERT2 (a concentrator repacking the station's legacy bursts), some each
// way, or ALERT2 sent by the station itself — over the window ⏱️ Latency &
// signal colours the pins over, by the same rule (HealthAnalysis.protocolOf),
// so the line and the pin say the same.

const Frequencies = (function () {

  const FIELDS = [
    { key: 'rx_mhz',       label: 'RX (MHz)',     kind: 'num',  cls: 'freq-mhz' },
    { key: 'tx_mhz',       label: 'TX (MHz)',     kind: 'num',  cls: 'freq-mhz' },
    { key: 'label',        label: 'Use',          kind: 'text', cls: 'freq-use',
      placeholder: 'Use (e.g. Voice)' },
    { key: 'acma_licence', label: 'ACMA licence', kind: 'text', cls: 'freq-lic',
      placeholder: 'ACMA licence' },
  ];

  const mhz = v => (v == null || v === '' ? '' : String(v));

  // Every pair the station has, the repeater's own first — for the card and
  // for anything that wants "all of this station's channels".
  function pairs(s) {
    const out = [];
    const r = s && s.repeater;
    if (r && (r.rx_mhz != null || r.tx_mhz != null)) {
      out.push({ rx_mhz: r.rx_mhz, tx_mhz: r.tx_mhz, acma_licence: r.acma_licence || undefined, primary: true });
    }
    for (const f of (s && s.frequencies) || []) out.push(f);
    return out;
  }

  function pairText(f) {
    const bits = [];
    if (f.rx_mhz != null) bits.push(`RX ${mhz(f.rx_mhz)}`);
    if (f.tx_mhz != null) bits.push(`TX ${mhz(f.tx_mhz)}`);
    return bits.length ? `${bits.join(' · ')} MHz` : '';
  }

  // ── Assumed, and heard on (see the header) ─────────────────────────────────

  // Channels here are 12.5 kHz apart; two figures closer than this are one.
  const SAME_MHZ = 0.002;
  const fin = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < SAME_MHZ;
  // 151.500, 151.5375: a channel to three places, or four where it has them.
  const chan = f => { const t = Number(f).toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
  const PROTOCOL = { 1: 'ALERT', 2: 'ALERT2' };   // meganet.protocol's codes
  const day = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const plural = (n, one) => `${Number(n).toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

  // A station that transmits by radio: one with an AlertID or an ALERT2 address.
  const radio = s => (typeof stationAlertIds === 'function' && stationAlertIds(s).length > 0)
    || fin(s.alert2_station_id) != null;

  // Its carriers, and which of them likely hear it directly. Null for a
  // station off the radio, or before app.js is there to ask.
  //   { all: [{ r, km, rx, tx }], direct: [the same, nearest first], maxKm }
  function carriersOf(s) {
    if (!radio(s) || typeof findRepeaterMatches !== 'function') return null;
    const maxKm = Math.max(0, Number(state.mapMaxLinkKm) || 0);
    const kmTo = (a, b) => (a.lat == null || a.lon == null || b.lat == null || b.lon == null
      ? null : acmaHaversineKm(a.lat, a.lon, b.lat, b.lon));
    const all = findRepeaterMatches(s).map(r => ({ r, km: kmTo(s, r),
      rx: fin(r.repeater && r.repeater.rx_mhz), tx: fin(r.repeater && r.repeater.tx_mhz) }));
    const near = all.filter(c => c.km != null && c.km <= maxKm).sort((a, b) => a.km - b.km);
    const direct = near.filter(c => !near.some(a => a.km < c.km && same(a.tx, c.rx)
      && (kmTo(a.r, c.r) ?? Infinity) <= maxKm));
    return { all, direct, maxKm };
  }

  // "Kroombit Repeater AL (28.5 km)", "A and B", "A, B and 3 more".
  function names(cs, withKm) {
    const one = c => `${c.r.name || c.r.id}${withKm && c.km != null ? ` (${fmtKm(c.km)})` : ''}`;
    const shown = cs.slice(0, 2).map(one);
    const more = cs.length - shown.length;
    if (more) return `${shown.join(', ')} and ${more} more`;
    return shown.join(' and ');
  }

  // ── The block's parts ──────────────────────────────────────────────────────
  // Each one a heading over its content — the word, its meaning on hover, and
  // what the column on the right is — with everything from the left edge and
  // the figures down the right. They were label/value rows once, the value
  // pushed right and its notes wrapping ragged under it; a field station's
  // Links alone ran to a block nobody could read.

  // What the words mean: on hover, and the same list in the block's "What the
  // words mean" fold, for a finger. Assumed TX's is built from the Max TX
  // distance; Links' are map-direct.js's (MapDirect.words).
  const WORDS = {
    heard: 'The channels Flood-Net’s base stations heard its readings on — directly or through a repeater — '
      + 'as each receiver recorded beside the reading. Measured, not the register’s word.',
    readings: 'How many of its readings came in on each channel, from the readings its card already asked for. '
      + 'The bar is each channel’s share of them.',
    unexplained: 'Readings came in on a channel that is neither what it is assumed to transmit on nor one that a '
      + 'repeater carrying it transmits on. Worth a look.',
    pairs: 'The receive (RX) and transmit (TX) channels on record for it: a repeater’s own pair first, marked '
      + 'primary, then every other channel it uses.',
  };
  const assumedWord = maxKm => 'What it is taken to transmit on: the RX of each repeater whose pass ranges carry its '
    + `AlertIDs and that likely hears it directly — within the Max TX distance (${maxKm} km, the map's slider) and not `
    + 'fed by a nearer repeater that carries it too. Worked out from the register, not measured.';

  // One part: `key` names it (data-freq, and its class stn-card-<key>).
  // map-direct.js draws Links with it too.
  const section = (key, label, title, html, right = '', bodyAttrs = '') => `<div class="freq-sec stn-card-${key}" data-freq="${key}">`
    + `<div class="freq-h">${termHtml(label, title)}${right ? `<span>${right}</span>` : ''}</div>`
    + `<div class="freq-body"${bodyAttrs}>${html}</div></div>`;
  // A value's caveat, on a line of its own under it.
  const note = text => ` <span class="mn-pop-note freq-why">${esc(text)}</span>`;
  const muted = text => `<span class="txt-muted">${esc(text)}</span>`;
  const dot = cls => `<span class="freq-dot ${cls}" aria-hidden="true"></span>`;
  const joinAnd = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

  // Which folds are open — by station and name — so a repaint (a fade margin
  // landing) does not snap one shut under the reader's finger.
  const openFolds = new Set();
  const foldOpen = (id, name) => (openFolds.has(`${id}|${name}`) ? ' open' : '');
  const foldAttrs = (id, name) => ` data-mn-fold="${escAttr(`${id}|${name}`)}"${foldOpen(id, name)}`;
  let folding = false;
  function trackFolds() {
    if (folding || typeof document === 'undefined') return;
    folding = true;
    // toggle does not bubble: caught on the way down.
    document.addEventListener('toggle', e => {
      const d = e.target;
      if (!d || !d.dataset || !d.dataset.mnFold) return;
      if (d.open) openFolds.add(d.dataset.mnFold); else openFolds.delete(d.dataset.mnFold);
    }, true);
  }

  function assumedHtml(C) {
    if (!C) return '';
    const S = html => section('assumed', 'Assumed TX', assumedWord(C.maxKm), html);
    if (!C.all.length) return S(muted('no repeater carries its AlertIDs'));
    if (!C.direct.length) {
      const nearest = C.all.filter(c => c.km != null).sort((a, b) => a.km - b.km)[0];
      return S(muted(`none within ${C.maxKm} km`) + note(nearest
        ? `The nearest repeater carrying it, ${names([nearest], false)}, is ${fmtKm(nearest.km)} off — past the Max TX distance.`
        : 'The repeaters carrying it have no position to measure from.'));
    }
    const byRx = new Map();
    for (const c of C.direct) {
      if (c.rx == null) continue;
      const k = chan(c.rx);
      if (!byRx.has(k)) byRx.set(k, []);
      byRx.get(k).push(c);
    }
    if (!byRx.size) {
      return S(muted('unknown') + note(`${names(C.direct, true)} `
        + `${C.direct.length === 1 ? 'carries' : 'carry'} it, with no RX on record.`));
    }
    return S([...byRx].map(([k, cs]) =>
      `<span class="freq-val">${esc(k)} MHz</span>${note(`${names(cs, true)} ${cs.length === 1 ? 'listens' : 'listen'} there`)}`).join(''));
  }

  // What is known to be on a channel it was heard on: { how, odd } — odd when
  // it is neither its assumed TX nor a channel a carrier transmits on.
  function onChannel(f, C) {
    if (!C) return { how: '', odd: false };
    const assumed = C.direct.some(c => same(c.rx, f));
    const relays = C.all.filter(c => same(c.tx, f));
    if (relays.length) return { how: `${assumed ? 'direct, or ' : ''}relayed by ${names(relays, false)}`, odd: false };
    if (assumed) return { how: 'direct — its assumed TX', odd: false };
    return { how: '', odd: C.all.length > 0 };
  }

  function heardHtml(s, C) {
    if (s.proposed || !radio(s) || typeof HealthGlance === 'undefined' || !HealthGlance.channels) return '';
    const a = HealthGlance.channels(s.id);
    const base = a && a.status === 'ok' && a.n
      ? ` From ${a.capped ? 'its newest 1,000 readings' : 'its readings in the datastore'}${a.since ? `, since ${day(a.since)}` : ''}.` : '';
    const S = (html, right) => section('heard', 'Heard on', WORDS.heard + base, html, right);
    if (!a || a.status === 'asking') {
      return S('<span class="txt-muted" aria-busy="true">asking the datastore…</span>');
    }
    if (a.status === 'error') {
      return S(muted('could not ask the datastore') + note('The Health section above says why, with Try again.'));
    }
    const shared = a.shared ? `${a.shared.toLocaleString()} more reading${a.shared === 1 ? ' came on an address it shares, put down to no station, and is'
      : 's came on addresses it shares, put down to no station, and are'} not counted.` : '';
    if (!a.list.length) {
      return S(muted('nothing recorded')
        + note(shared || 'No base station has put a channel beside any of its readings in the datastore.'));
    }
    const total = a.list.reduce((t, c) => t + c.n, 0);
    return S(a.list.map(c => {
      const on = onChannel(c.mhz, C);
      const share = total ? c.n / total : 0;
      const bits = [PROTOCOL[c.protocol] || '', c.last != null ? `last ${day(c.last)}` : ''].filter(Boolean).map(esc);
      if (on.odd) bits.push(`<span class="txt-warn">${termHtml('not explained', WORDS.unexplained)}</span>`);
      else if (on.how) bits.push(esc(on.how));
      return `<div class="freq-ch"><span class="freq-val">${esc(chan(c.mhz))} MHz</span>`
        + `<span class="freq-share" role="img" aria-label="${escAttr(`${plural(c.n, 'reading')}, ${Math.round(share * 100)} % of them`)}">`
        + `<i class="${on.odd ? 'warn' : ''}" style="--freq-share:${Math.max(2, share * 100).toFixed(1)}%"></i></span>`
        + `<span class="freq-n">${esc(c.n.toLocaleString())}</span>`
        + `<span class="mn-pop-note freq-why">${bits.join(' · ')}</span></div>`;
    }).join('') + (shared ? note(shared) : ''), termHtml('Readings', WORDS.readings));
  }

  // How its readings came in: legacy ALERT, inside ALERT2, some each way, or
  // ALERT2 from the station itself — counted over the window ⏱️ Latency &
  // signal colours the pins over (24 h unless somebody picked another), so
  // the line says what the station's pin says when the pins are coloured by
  // protocol. From the same readings as Heard on (HealthGlance.protocol); the
  // words, keys and colours are MapLatency's.
  function protoHtml(s) {
    if (s.proposed || !radio(s) || typeof HealthGlance === 'undefined' || !HealthGlance.protocol
      || typeof MapLatency === 'undefined' || !MapLatency.windowSpan) return '';
    const [span, label] = MapLatency.windowSpan();
    const a = HealthGlance.protocol(s.id, Date.now() - span);
    const S = html => section('protocol', 'Protocol',
      `${MapLatency.protoWord()} Counted over the last ${label}, the window ⏱️ Latency & signal colours the pins over.`, html);
    if (!a || a.status === 'asking') {
      return S('<span class="txt-muted" aria-busy="true">asking the datastore…</span>');
    }
    if (a.status === 'error') {
      return S(muted('could not ask the datastore') + note('The Health section above says why, with Try again.'));
    }
    const kind = p => `<span class="freq-val">${MapLatency.protoKeyHtml(p.key)} ${MapLatency.protoTermHtml(p.key)}</span>`;
    if (a.p.n) {
      return S(kind(a.p) + note(`${MapLatency.protoText(a.p)}, in the last ${label}`) + MapLatency.protoBarHtml(a.p));
    }
    // Nothing in the window: the card's week says how it came in before.
    if (a.week.n) {
      return S(kind(a.week)
        + note(`nothing in the last ${label}; since ${day(a.since)}${a.capped ? ' (its newest 1,000 readings)' : ''}: ${MapLatency.protoText(a.week)}`));
    }
    return S(muted(a.shared ? 'not told apart' : 'nothing recorded') + note(a.shared
      ? 'Its readings came on addresses it shares with other stations, and nothing heard with them says they were this station’s.'
      : 'None of its readings in the datastore says a radio format.'));
  }

  // The block's "What the words mean": every word it marks, for a finger —
  // only those of the parts on show.
  function wordsHtml(s, C, parts) {
    const list = [];
    if (parts.pairs) list.push(['Frequencies', WORDS.pairs]);
    if (C) list.push(['Assumed TX', assumedWord(C.maxKm)]);
    if (parts.links && typeof MapDirect !== 'undefined' && MapDirect.words) list.push(...Object.values(MapDirect.words()));
    if (parts.heard) list.push(['Heard on', WORDS.heard], ['Readings', WORDS.readings], ['Not explained', WORDS.unexplained]);
    if (!list.length) return '';
    return `<details class="freq-fold freq-words"${foldAttrs(s.id, 'words')}><summary>What the words mean</summary>`
      + `<dl>${list.map(([w, m]) => `<dt>${esc(w)}</dt><dd>${esc(m)}</dd>`).join('')}</dl></details>`;
  }

  // The block's inside: the pairs on record, one to a line the way the AlertID
  // block lists addresses, then Assumed TX, the Links under it (map-direct.js:
  // its repeaters and the base stations that hear it direct, by fade margin,
  // a bar each), Heard on and Protocol, and what their words mean. paint()
  // redraws it.
  function innerHtml(s) {
    const lines = pairs(s).map(f => {
      const what = [f.primary ? 'primary' : '', f.label || '', f.acma_licence ? `licence ${f.acma_licence}` : '']
        .filter(Boolean).join(', ');
      return `<span class="mn-pop-line">${esc(pairText(f))}${what
        ? ` <span class="mn-pop-note">${esc(what)}</span>` : ''}</span>`;
    });
    const C = carriersOf(s);
    const links = typeof MapDirect !== 'undefined' ? MapDirect.rowHtml(s) : '';
    const heard = heardHtml(s, C);
    return (lines.length ? section('pairs', 'Frequencies', WORDS.pairs, lines.join('<br>')) : '')
      + assumedHtml(C) + links + heard + protoHtml(s)
      + wordsHtml(s, C, { pairs: lines.length > 0, links: !!links, heard: !!heard });
  }

  // ── The summary, at the top of the Radio tab ──────────────────────────────
  // Two lines before the detail: its best link (map-direct.js), and what was
  // heard — a channel nothing explains, or that all of it is explained. Empty
  // until there is something to say; painted with the block.

  function heardSumHtml(s, C) {
    if (!C || !C.all.length || typeof HealthGlance === 'undefined' || !HealthGlance.channels) return '';
    const a = HealthGlance.channels(s.id);
    if (!a || a.status !== 'ok' || !a.list.length) return '';
    const odd = a.list.filter(c => onChannel(c.mhz, C).odd);
    if (odd.length) {
      return `<p>${dot('warn')}${odd.map(c => `${esc(plural(c.n, `${PROTOCOL[c.protocol] ? `${PROTOCOL[c.protocol]} ` : ''}reading`))} on `
        + `${esc(chan(c.mhz))} MHz ${c.n === 1 ? 'is' : 'are'} ${termHtml('not explained', WORDS.unexplained)}.`).join(' ')}</p>`;
    }
    const chs = a.list.map(c => chan(c.mhz));
    return `<p>${dot('ok')}Heard on ${esc(joinAnd(chs))} MHz, ${chs.length === 1 ? 'the channel' : 'channels'} its links use.</p>`;
  }

  function summaryInner(s) {
    return (typeof MapDirect !== 'undefined' && MapDirect.summaryHtml ? MapDirect.summaryHtml(s) : '')
      + heardSumHtml(s, carriersOf(s));
  }

  const sumId = id => `mn-freqs-sum-${id}`;

  // The summary's place: an empty box (hidden while empty) for any station on
  // the radio, and any repeater — one with no AlertIDs of its own still has
  // links up — so paint() can fill it when the figures and readings land.
  function summaryHtml(s) {
    const rep = Array.isArray(s.roles) && s.roles.includes('repeater');
    if (s.proposed || (!radio(s) && !rep)) return '';
    return `<div class="freq-sum" id="${escAttr(sumId(s.id))}" data-mn-freqs="${escAttr(String(s.id))}">${summaryInner(s)}</div>`;
  }

  const cardId = id => `mn-freqs-card-${id}`;

  // The card's block. Empty for a station with no pair that is not on the
  // radio — a satellite or wired site has no channel to assume or hear — and
  // not a base station, whose Links say it is where the readings come in.
  function cardHtml(s) {
    const base = !!s && Array.isArray(s.roles) && s.roles.includes('base');
    if (!pairs(s).length && !radio(s) && !base) return '';
    watch();
    trackFolds();
    return `<div class="stn-card-ids stn-card-freqs" id="${escAttr(cardId(s.id))}"
         data-mn-freqs="${escAttr(String(s.id))}">${innerHtml(s)}</div>`;
  }

  // Heard on, painted in place when the card's readings land — HealthGlance
  // says so for one station (its id) or for the network's batch (null, which
  // says nothing about channels). Only while the card is still on the station.
  let watching = false;
  function watch() {
    if (watching || typeof HealthGlance === 'undefined' || !HealthGlance.onHeard) return;
    watching = true;
    HealthGlance.onHeard(id => { if (id != null) paint(id); });
  }
  function paint(id) {
    const s = state.data && state.data.stations.find(x => x.id === id);
    if (!s) return;
    const el = document.getElementById(cardId(id));
    if (el && el.dataset.mnFreqs === String(id)) {
      // The folds as they are on screen now: a tap a moment ago may not have
      // reached trackFolds yet (toggle is queued), and must not be lost.
      for (const d of el.querySelectorAll('details[data-mn-fold]')) {
        if (d.open) openFolds.add(d.dataset.mnFold); else openFolds.delete(d.dataset.mnFold);
      }
      el.innerHTML = innerHtml(s);
    }
    const sum = document.getElementById(sumId(id));
    if (sum && sum.dataset.mnFreqs === String(id)) sum.innerHTML = summaryInner(s);
  }

  // ── The editor ────────────────────────────────────────────────────────────

  // Each box keeps its caption over it, the way .form-grid labels do: a row of
  // two bare frequencies cannot say which is RX once both are filled in.
  function control(f, v) {
    const val = v == null ? '' : String(v);
    const input = f.kind === 'num'
      ? `<input type="number" step="any" min="0" inputmode="decimal" data-f="${f.key}" value="${escAttr(val)}">`
      : `<input type="text" data-f="${f.key}" placeholder="${escAttr(f.placeholder || '')}" value="${escAttr(val)}">`;
    return `<label class="freq-f ${f.cls}"><span class="small">${esc(f.label)}</span>${input}</label>`;
  }

  function rowHtml(r) {
    r = r || {};
    return `
      <div class="freq-row">
        ${FIELDS.map(f => control(f, r[f.key])).join('')}
        <button type="button" class="btn-danger freq-del" onclick="Frequencies.removeRow(this)"
                aria-label="Remove this frequency" title="Remove this frequency"><span aria-hidden="true">×</span></button>
      </div>`;
  }

  // The primary row: the repeater's own two boxes, under the ids the rest of
  // the editor has always read them by (ef-rx, ef-tx). No remove button — a
  // repeater's pair is cleared by emptying it, and the licence is the
  // repeater's own box above.
  function primaryHtml(s) {
    const r = (s && s.repeater) || {};
    return `
      <div class="freq-row freq-primary">
        <label class="freq-f freq-mhz"><span class="small">RX (MHz)</span>
          <input type="number" step="any" min="0" inputmode="decimal" id="ef-rx" value="${escAttr(mhz(r.rx_mhz))}"></label>
        <label class="freq-f freq-mhz"><span class="small">TX (MHz)</span>
          <input type="number" step="any" min="0" inputmode="decimal" id="ef-tx" value="${escAttr(mhz(r.tx_mhz))}"></label>
        <span class="freq-tag small">Primary — the repeater’s own pair</span>
      </div>`;
  }

  function countText(n) {
    return n ? ` <span class="small ef-plain">— ${n}</span>` : '';
  }

  // The block, inside the Repeater configuration grid for a repeater
  // (`primary` true) and in a section of its own for a base station.
  function editorHtml(s, { primary = false } = {}) {
    const rows = (s && s.frequencies) || [];
    const n = rows.length + (primary ? 1 : 0);
    return `
      <div class="full ef-section freq-list" id="ef-freqs">
        <div class="ef-section-head">
          <div class="ef-sub">Frequencies — RX / TX<span class="freq-count">${countText(n)}</span>
            ${hintToggleHtml('ef-h-freqs', 'the frequencies')}</div>
          <button type="button" onclick="Frequencies.addRow()" aria-label="Add a frequency">+ Add frequency</button>
        </div>
        <!-- Folded behind the heading's ⓘ (hintToggleHtml, core.js), and opening
             under it rather than under however many rows there are. -->
        <div class="small ef-note hint-fold" id="ef-h-freqs" hidden>
          ${primary
            ? 'The primary pair is what the path profile, fade map, backbone, frequency layer and ACMA tools use. '
              + 'Add a row for every other channel this site listens or transmits on.'
            : 'One row per channel this station listens or transmits on.'}
          Blank means not recorded.
        </div>
        ${primary ? primaryHtml(s) : ''}
        <div class="freq-rows">${rows.map(r => rowHtml(r)).join('')}</div>
      </div>`;
  }

  function recount() {
    const box = document.getElementById('ef-freqs');
    if (!box) return;
    const n = box.querySelectorAll('.freq-row').length;
    const el = box.querySelector('.freq-count');
    if (el) el.innerHTML = countText(n);
  }

  // A new row goes at the foot, after the primary and the pairs already there,
  // with the cursor in its RX box.
  function addRow() {
    const box = document.getElementById('ef-freqs');
    if (!box) return;
    const rows = box.querySelector('.freq-rows');
    rows.insertAdjacentHTML('beforeend', rowHtml({}));
    // New since the card was drawn: anything in it is an unsaved change.
    rows.querySelector('.freq-row:last-child')?.setAttribute('data-ef-added', '');
    recount();
    const last = rows.querySelector('.freq-row:last-child input');
    if (last) last.focus();
  }

  // Focus to + Add, not to <body>: the pressed button has just gone. The head's
  // own button — the ⓘ beside its title is a button too.
  function removeRow(btn) {
    const row = btn && btn.closest('.freq-row');
    const box = document.getElementById('ef-freqs');
    if (!row || !box) return;
    editorUnsavedRemoved(row, 'A frequency pair');
    row.remove();
    recount();
    editorUnsavedRefresh();
    const add = box.querySelector('.ef-section-head > button');
    if (add) add.focus();
  }

  function readRow(el) {
    const out = {};
    for (const f of FIELDS) {
      const c = el.querySelector(`[data-f="${f.key}"]`);
      const raw = c ? String(c.value).trim() : '';
      if (raw === '') continue;
      out[f.key] = f.kind === 'num' ? Number(raw) : raw;
    }
    return out;
  }

  function normalise(rows) {
    return (rows || []).map(r => {
      const out = {};
      for (const f of FIELDS) {
        const v = r[f.key];
        if (v == null || String(v).trim() === '') continue;
        out[f.key] = f.kind === 'num' ? Number(v) : String(v).trim();
      }
      return out;
    }).filter(r => Object.keys(r).length);
  }

  // { frequencies: [...] } when the rows differ from the record's, else {} —
  // and {} when the form has no frequencies block at all.
  function readForm(record) {
    const box = document.getElementById('ef-freqs');
    if (!box) return {};
    const rows = normalise([...box.querySelectorAll('.freq-rows .freq-row')].map(readRow));
    const before = normalise((record && record.frequencies) || []);
    return JSON.stringify(rows) === JSON.stringify(before) ? {} : { frequencies: rows };
  }

  // A box the browser could not read, or a row with a use and no frequency —
  // either would be dropped by the save without a word, so it is named here.
  function formProblem() {
    const box = document.getElementById('ef-freqs');
    if (!box) return null;
    const rows = [...box.querySelectorAll('.freq-row')];
    for (let i = 0; i < rows.length; i++) {
      for (const c of rows[i].querySelectorAll('input[type="number"]')) {
        if (c.validity && (c.validity.badInput || (c.value !== '' && Number(c.value) <= 0))) {
          c.focus();
          const cap = c.closest('label')?.querySelector('span')?.textContent || 'a box';
          return `Frequencies, row ${i + 1}: “${cap}” is not a frequency in MHz. `
               + 'Nothing was saved — correct it or clear it and save again.';
        }
      }
      if (rows[i].classList.contains('freq-primary')) continue;
      const r = readRow(rows[i]);
      if (Object.keys(r).length && r.rx_mhz == null && r.tx_mhz == null) {
        const c = rows[i].querySelector('[data-f="rx_mhz"]');
        if (c) c.focus();
        return `Frequencies, row ${i + 1} has no RX or TX frequency. Nothing was saved — `
             + 'give it one, or remove the row.';
      }
    }
    return null;
  }

  return {
    FIELDS,
    pairs,
    cardHtml,
    summaryHtml,
    section,
    carriersOf,
    foldAttrs,
    // The block drawn again in place, when something it shows has landed —
    // a link's fade margin (map-direct.js).
    repaint: paint,
    editorHtml,
    addRow,
    removeRow,
    readForm,
    formProblem,
  };
})();
if (typeof window !== 'undefined') window.Frequencies = Frequencies;
