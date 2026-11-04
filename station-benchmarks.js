// MegaNet — station-benchmarks.js
//
//   StationBenchmarks   the Bureau's benchmarks at a station (0101): the marks
//                       its gauge is levelled from, as HDB holds them — each
//                       one's level and datum, what it is and where, the
//                       office's comments — and what it reads on the gauge.
//                       On the station card for a signed-in editor, and in the
//                       📏 Level Survey's Datum and control step, where Use
//                       puts one in as the survey's primary benchmark.
//
// After core.js and datastore.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr and termHtml, and to datastore.js
// for dbSelect and dbCanWrite. Two files call in: app.js, whose station card
// places cardHtml() and asks cardAsk(), and level-survey.js, which asks ask(),
// rows(), listHtml() and pick(). All of it from inside its own functions: the
// IIFE body only declares (`npm run toplevel`).
//
// ── Where the rows come from ─────────────────────────────────────────────────
// meganet.station_benchmark (db/migrations/0101_station_benchmarks.sql): the
// Bureau's report *Queensland Flood Warning River Height Stations — Benchmark
// Details*, printed from HDB on 15/10/2026 and read by
// tools/ingest/benchmarks.py, put on each station by its bureau number. Read
// by editors only (RLS) — a benchmark's description is not for the open
// internet — so a person who is not one is given none, and somebody signed
// out is not asked. Levels are shown to the centimetre, as the report prints
// them; the database works out the level on the gauge, and only where the mark
// and the gauge zero are both AHD or both State.

const StationBenchmarks = (function () {

  const FRESH_MS = 5 * 60 * 1000;   // a station's list, asked again after five minutes
  const COLS = 'bureau_number,ord,level_m,datum,description,comment,gauge_zero_m,gauge_datum,gauge_zero_from,on_gauge_m,printed_on';
  const cache = {};                  // station id → { rows, at, p, error }

  // The words this section uses, and what each means here — one list, for the
  // hover and for the fold that says the same without one.
  const WORDS = {
    benchmark: 'A fixed survey mark near the gauge whose level is known — a pin in concrete, a bolt in a tree, a State survey mark — that the gauge is levelled from. These are the ones the Bureau holds for this station in HDB, its hydrological database.',
    AHD: 'Australian Height Datum: metres above mean sea level as the national survey fixes it. An AHD level compares with any other AHD level, anywhere.',
    ASSUM: 'An assumed datum: a level made up at the site — often 100.000 at one mark, or the gauge\'s own reading. It compares only with levels on the same assumption at this site, so it is never put on the gauge here.',
    STATE: 'Queensland\'s State datum, used before AHD. It differs from AHD by centimetres to decimetres from place to place; the comment often says by how much here.',
    UNKNOWN: 'The Bureau does not record which datum this level is in.',
    onGauge: 'What the mark would read on the river gauge: its level less the gauge zero in force (the survey row with no end date, else the one that ended last). Worked out only when the mark and the zero are both AHD or both State; left out otherwise.',
    TBM: 'Temporary benchmark — a local mark set for the gauge (a bolt, a nail, a spike), not one of the State\'s numbered survey marks. Common in the descriptions.',
    PSM: 'Permanent survey mark — a numbered mark in the Queensland survey network, whose level and position the State holds. Also in the descriptions, often with its number.',
  };
  const DATUM_LABEL = { AHD: 'AHD', ASSUM: 'assumed', STATE: 'State', UNKNOWN: 'datum unknown' };
  const DATUM_LONG = { AHD: 'm AHD', ASSUM: 'm on an assumed datum', STATE: 'm State datum', UNKNOWN: 'm, datum unknown' };

  function signedIn() { return typeof dbCanWrite === 'function' && dbCanWrite(); }
  function m2(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? '' : n.toFixed(2); }
  function dmy(iso) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }
  function datumHtml(code) { return termHtml(DATUM_LABEL[code] || code || '', WORDS[code] || ''); }

  // ── The rows ───────────────────────────────────────────────────────────────

  // The station's benchmarks, asked once and kept five minutes — and kept as
  // whoever asked, so signing in or out asks again rather than showing the
  // other person's answer. Signed out the answer is none, without asking. A
  // database before 0101 has no such view: that is an empty list, not an
  // error to show.
  function current(c) { return !!c && c.signed === signedIn(); }
  function ask(id) {
    if (!id) return Promise.resolve([]);
    const c = cache[id];
    if (c && c.p) return c.p;
    if (current(c) && c.rows && Date.now() - c.at < FRESH_MS) return Promise.resolve(c.rows);
    if (!signedIn() || typeof dbSelect !== 'function') {
      cache[id] = { rows: [], at: Date.now(), signed: signedIn() };
      return Promise.resolve([]);
    }
    const p = dbSelect(`station_benchmark?select=${COLS}&station_id=eq.${encodeURIComponent(id)}&order=ord.asc`)
      .then(rows => { cache[id] = { rows: rows || [], at: Date.now(), signed: true }; return cache[id].rows; })
      .catch(err => {
        const missing = err && (err.status === 404 || /station_benchmark/.test(String(err.message || '')));
        cache[id] = { rows: [], at: Date.now(), signed: true, error: missing ? '' : String((err && err.message) || err) };
        return [];
      });
    cache[id] = Object.assign({}, c, { p });
    return p;
  }
  function rows(id) { const c = cache[id]; return current(c) && c.rows ? c.rows : null; }

  // A name for the mark out of its description, when the description gives
  // one: "PSM 46757", "CGC200041", "BM6001". Otherwise null, and the survey
  // keeps the name it had.
  function markName(desc) {
    const m = /\b(PSM|SSM|PM|CGC|BM|SD)\s*(?:#\s*)?(\d{3,}[A-Z]?)\b/i.exec(String(desc || ''));
    if (!m) return null;
    const p = m[1].toUpperCase();
    return p === 'CGC' || p === 'BM' ? `${p}${m[2]}` : `${p} ${m[2]}`;
  }

  // What Use puts in a level survey: the datum it can be booked in, its RL in
  // that datum, a name, its description, and where the figure came from. AHD
  // and assumed go in as they are; a State mark goes in on the gauge where the
  // database could put it there (the survey has no State datum), else as an
  // assumed level; an unknown datum is an assumed one.
  function pick(id, ord) {
    const b = (rows(id) || []).find(x => Number(x.ord) === Number(ord));
    if (!b) return null;
    const level = Number(b.level_m);
    const onGauge = b.on_gauge_m == null ? null : Number(b.on_gauge_m);
    const from = `Bureau benchmark details (HDB${b.printed_on ? `, ${dmy(b.printed_on)}` : ''})`;
    let datum = 'ASSUMED', rl = level, source = `${from}: ${m2(level)} ${DATUM_LONG[b.datum] || 'm'}`;
    if (b.datum === 'AHD') datum = 'AHD';
    else if (b.datum === 'STATE' && onGauge != null) {
      datum = 'LGH';
      rl = onGauge;
      source += ` — ${m2(onGauge)} on the gauge through its zero of ${m2(b.gauge_zero_m)} m State`;
    } else if (b.datum !== 'ASSUM') {
      source += ', booked as an assumed level';
    }
    return { datum, rl, source, name: markName(b.description), description: b.description || '' };
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function itemHtml(id, b, use) {
    const on = b.on_gauge_m == null ? '' : ` · ${termHtml('on the gauge', WORDS.onGauge)} <strong>${esc(m2(b.on_gauge_m))}</strong>`;
    const btn = use ? ` <button type="button" onclick="${escAttr(use)}('${escAttr(id)}', ${Number(b.ord)})">Use</button>` : '';
    return `<li><strong>${esc(m2(b.level_m))} m</strong> ${datumHtml(b.datum)}${on}${btn}`
      + `${b.description ? `<br>${esc(b.description)}` : ''}`
      + `${b.comment ? `<br><span class="small txt-muted">${esc(b.comment)}</span>` : ''}</li>`;
  }

  function wordsHtml() {
    const keys = ['benchmark', 'AHD', 'ASSUM', 'STATE', 'UNKNOWN', 'onGauge', 'TBM', 'PSM'];
    const say = { benchmark: 'Benchmark', AHD: 'AHD', ASSUM: 'Assumed', STATE: 'State', UNKNOWN: 'Datum unknown', onGauge: 'On the gauge', TBM: 'TBM', PSM: 'PSM' };
    return `<details class="sb-words"><summary class="small">What the words here mean</summary><dl class="small">`
      + keys.map(k => `<dt>${esc(say[k])}</dt><dd>${esc(WORDS[k])}</dd>`).join('') + '</dl></details>';
  }

  // The list, with a Use button on each when `use` names the function to call
  // (level-survey.js) — or '' when the station has none.
  function listHtml(id, o = {}) {
    const list = rows(id) || [];
    if (!list.length) return '';
    const printed = list[0].printed_on ? `, printed ${dmy(list[0].printed_on)}` : '';
    return `<p class="small">The Bureau lists ${list.length === 1 ? `this ${termHtml('benchmark', WORDS.benchmark)}` : `these ${list.length} ${termHtml('benchmarks', WORDS.benchmark)}`} here (HDB${esc(printed)}):</p>`
      + `<ul class="sb-list">${list.map(b => itemHtml(id, b, o.use)).join('')}</ul>${wordsHtml()}`;
  }

  // ── The station card ───────────────────────────────────────────────────────
  // Drawn empty and filled when the rows arrive, SiteFeatures.cardAsk's terms;
  // an empty section is not drawn at all (:empty).

  function cardBodyHtml(id) {
    const c = cache[id];
    if (!current(c) || !c.rows) return '';
    if (c.error) return `<span class="small txt-muted stn-card-sb-h">Benchmarks</span><p class="small txt-bad">Could not be read — ${esc(c.error)}</p>`;
    if (!c.rows.length) return '';
    return `<span class="small txt-muted stn-card-sb-h">Benchmarks</span>${listHtml(id)}`;
  }
  function cardHtml(s) {
    if (!s || !signedIn()) return '';
    return `<div class="acma-sect stn-card-benchmarks" id="mn-bm-card-${escAttr(s.id)}" data-mn-bm="${escAttr(s.id)}">${cardBodyHtml(s.id)}</div>`;
  }
  function cardAsk(s) {
    if (!s || !signedIn()) return;
    const id = s.id;
    ask(id).then(() => {
      const el = document.getElementById(`mn-bm-card-${id}`);
      if (el && el.dataset.mnBm === id) el.innerHTML = cardBodyHtml(id);
    });
  }

  return { WORDS, ask, rows, pick, markName, listHtml, cardHtml, cardAsk };
})();
