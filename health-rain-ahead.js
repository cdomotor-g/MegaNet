// MegaNet — health-rain-ahead.js
//
//   HealthRainAhead   Station Health's 🌧 Rain ahead card: where one weather
//                     model has rain falling in the next few days, and which
//                     stations there have a fault open that loses readings
//                     when it rains — a flat battery, checks not getting
//                     through, a gauge or level sensor not reporting — so the
//                     technicians can get to those before the rain does.
//
// After core.js (esc, escAttr — for onclick strings only — termHtml, dbProxyAvailable, state), health.js
// (Health.owns, Health.select, Health.rainChanged) and health-analysis.js (the
// stations heard and their findings); before init.js. health.js draws this
// card's section, asks for the rain when the week's analysis lands (ask), and
// puts the chips this file makes on Needs attention, the station panel and the
// map. Nothing here runs at load.
//
// ── What the rain is, and what it is not ─────────────────────────────────────
// One global numerical weather model's figure — ECMWF's IFS, published by the
// European Centre as open data — its rain a day for the next seven days, read
// at the middle of the quarter-degree square (about 25 km) each station stands
// in, through Open-Meteo, by worker/rain-ahead.js (/api/rain-ahead), which
// keeps every answer in the edge cache for three hours. Nobody has checked it.
//
// It is not a forecast or a warning, and Flood-Net issues neither
// (terms.html). It is used for one thing: ranking the faults already found
// here. So the card says whose figure it is and that it is not the Bureau's,
// links the Bureau's forecasts and warnings, never names a flood, a river
// height or a warning level, and uses its own plain words for how wet —
// *Wet*, *Very wet* — rather than the Bureau's warning vocabulary. The
// Bureau's own forecasts are not used at all: their terms are for use inside
// one's own organisation, and publishing them — which a page anybody can open
// does — needs a licence (worker/rain-ahead.js says more).
//
// ── The bands ────────────────────────────────────────────────────────────────
// Judged on the next three days — today and the two after, in the station's own
// time zone — at the station's square:
//
//   Very wet   30 mm or more on one day, or 60 mm or more across the three
//   Wet        10 mm or more on one day, or 20 mm or more across the three
//
// and the same measure on days four to seven is *later in the week*: a model's
// rain that far ahead moves from run to run, so it is a reason to plan a trip,
// not to drop everything. Below Wet is not shown.
//
// ── Who comes first ──────────────────────────────────────────────────────────
// A station with rain ahead and a *fault open*: a warning or critical finding
// in power, check signals or sensors (health-analysis.js's categories) — the
// kinds that cost readings in a rain event. Very wet before wet before later;
// sooner before later; critical before warning. Notes, data quality and the
// register do not count: none of them loses a reading when it rains.
//
// The owner filter narrows this card as it narrows Needs attention.

const HealthRainAhead = (() => {

  const HOUR = 3600000;
  const API_ORIGIN = 'https://floodwarning.net';
  const PATH = '/api/rain-ahead';
  const GRID = 0.25;            // worker/rain-ahead.js's GRID: both ends snap alike
  const CHUNK = 50;             // its CELLS_MAX
  const AT_ONCE = 3;            // requests at a time
  const KEEP_MS = 3 * HOUR;     // a square's figure is asked again after this (the Worker's FRESH_S)
  const NEAR = 3;               // today and the two after: what the bands are judged on
  const WEEK = 7;
  const BANDS = { very: { day: 30, total: 60 }, wet: { day: 10, total: 20 } };
  const FAULT_CATS = new Set(['power', 'comms', 'sensor']);
  const SEV_RANK = { critical: 0, warn: 1, info: 2 };
  const SHOW = 8;               // rows of Get to these first before Show all
  const RING = '#0288d1';       // the map's rain halo, edge and fill: literals, as Leaflet path
  const FILL = '#29b6f6';       // options take no var() (styles.css's .hl-rain-ring matches them)

  // Said under the card whether or not the route answered.
  const SOURCE = {
    credit: 'Rain from ECMWF’s IFS weather model (© ECMWF, CC BY 4.0), through Open-Meteo.com (CC BY 4.0).',
    ecmwf: 'https://www.ecmwf.int/',
    openMeteo: 'https://open-meteo.com/',
    licence: 'https://creativecommons.org/licenses/by/4.0/',
  };
  const BOM_HOME = 'https://www.bom.gov.au/';
  const BOM_WARNINGS = 'https://www.bom.gov.au/australia/warnings/';

  const BAND_LABEL = { very: 'Very wet', wet: 'Wet' };
  const LATER_LABEL = { very: 'Very wet later', wet: 'Wet later' };

  // The words this card uses in its own sense, a meaning each — on hover where
  // they appear, and in the fold under the card.
  const WORDS = {
    ahead: 'Rain the weather model has falling at a station over the next three days — today and the two after: 10 mm or more on one day, or 20 mm or more across the three. A raw model figure for the 25 km square the station stands in, used here only to choose which faults to fix first. Not a forecast or a warning.',
    very: 'The weather model has 30 mm or more on one of the next three days at this station, or 60 mm or more across the three.',
    wet: 'The weather model has 10 mm or more on one of the next three days at this station, or 20 mm or more across the three — but not enough to be Very wet.',
    later: 'Nothing much in the next three days, but the weather model has a wet or very wet spell, by the same measure, on days four to seven. That far ahead a model’s rain moves a lot from one run to the next: a reason to plan a visit, not to drop everything.',
    fault: 'A warning or critical finding about power (the battery), check signals (getting through to the base stations) or a sensor — the faults that lose readings when it rains. Notes, data-quality and register findings do not count.',
    first: 'Stations with rain ahead and a fault open: very wet before wet before later in the week, sooner before later, then the worst fault first — the visits to make before the rain arrives.',
    week: 'The weather model’s rain in millimetres on each of the next seven days at the station, today first, in the station’s own time zone. The last four are paler: that far ahead the figure is least sure.',
    model: 'ECMWF’s IFS — the European Centre for Medium-Range Weather Forecasts’ global model, run four times a day on a 9 km grid — read at the middle of the quarter-degree square (about 25 km) each station stands in, through Open-Meteo, and fetched again every three hours. Nobody has checked it: it can miss a storm, or put one in the next valley.',
    basin: 'The river basin the station is filed under on the register. Stations with none on file are counted under “No basin on file”.',
  };
  const GLOSSARY = [
    ['ahead', 'Rain ahead'], ['very', 'Very wet'], ['wet', 'Wet'], ['later', 'Wet later, Very wet later'],
    ['fault', 'Fault open'], ['first', 'Get to these first'], ['week', 'Next 7 days'], ['model', 'The weather model'], ['basin', 'Basin'],
  ];

  const R = {
    cells: new Map(),          // 'lat,lon' → { tz, days, mm, fetched }
    source: null,              // the route's own SOURCE, when it has answered
    fetched: null,             // the newest answer's time (ms)
    stale: '',                 // why an answer came from the edge cache's last copy
    err: '',
    loading: false,
    seq: 0,
    demo: false,
    demoBy: null,              // station id → a made-up cell, for the demo week
    all: false,                // every row of Get to these first
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;
  const term = (k, text) => (typeof termHtml === 'function' ? termHtml(text, WORDS[k]) : esc(text));
  const mm1 = v => (v == null ? '—' : v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));

  // ── squares ──────────────────────────────────────────────────────────────

  function snap(v) { const s = Math.round(v / GRID) * GRID; return Object.is(s, -0) ? 0 : s; }
  function cellOf(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return `${snap(lat).toFixed(2)},${snap(lon).toFixed(2)}`;
  }
  const cmpCell = (a, b) => {
    const [la, oa] = a.split(',').map(Number), [lb, ob] = b.split(',').map(Number);
    return la - lb || oa - ob;
  };

  // Today's date where the station is, as the model's days are written.
  function todayIn(tz, now) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(now != null ? now : Date.now()));
    } catch (_) {
      return new Date((now != null ? now : Date.now()) + 10 * HOUR).toISOString().slice(0, 10);
    }
  }

  // ── judging a square's week ──────────────────────────────────────────────

  // A run of days' rain → 'very' | 'wet' | null.
  function bandOf(list) {
    const xs = (list || []).map(v => (Number.isFinite(v) ? v : 0));
    if (!xs.length) return null;
    const max = Math.max(...xs), total = xs.reduce((a, b) => a + b, 0);
    if (max >= BANDS.very.day || total >= BANDS.very.total) return 'very';
    if (max >= BANDS.wet.day || total >= BANDS.wet.total) return 'wet';
    return null;
  }

  // A square's answer → the week from today, judged:
  //   { days: [{ date, mm, i }], near: { band, max, maxAt, total, first },
  //     later: { band, max, maxAt, total } }
  // `i` is days from today; `maxAt` the wettest day's i; `first` the first day
  // of the three wet enough on its own (10 mm), or null. An answer that has
  // aged past today starts at today; one with no today in it is no answer.
  function judge(cell, now) {
    if (!cell || !Array.isArray(cell.days) || !Array.isArray(cell.mm)) return null;
    const today = todayIn(cell.tz, now);
    let start = cell.days.indexOf(today);
    if (start < 0) start = cell.days.length && cell.days[0] > today ? 0 : -1;
    if (start < 0) return null;
    const days = [];
    for (let k = start; k < cell.days.length && days.length < WEEK; k++) {
      const v = cell.mm[k];
      days.push({ date: cell.days[k], mm: Number.isFinite(v) ? v : null, i: days.length });
    }
    if (!days.length) return null;
    const part = list => {
      const xs = list.map(d => d.mm || 0);
      const max = xs.length ? Math.max(...xs) : 0;
      const at = list.find(d => (d.mm || 0) === max);
      return { band: bandOf(list.map(d => d.mm)), max, maxAt: at ? at.i : null, total: xs.reduce((a, b) => a + b, 0) };
    };
    const near = part(days.slice(0, NEAR));
    const f = days.slice(0, NEAR).find(d => (d.mm || 0) >= BANDS.wet.day);
    near.first = f ? f.i : (near.band ? 0 : null);
    const later = part(days.slice(NEAR, WEEK));
    return { days, near, later };
  }

  // A station → its week judged, or null (no answer for its square yet).
  function of(id, now) {
    if (R.demo) return R.demoBy && R.demoBy.has(id) ? judge(R.demoBy.get(id), now) : null;
    const A = healthA();
    const S = A && A.stations.get(id);
    const st = S ? S.st : (state.data && state.data.stations || []).find(s => s.id === id);
    const key = st ? cellOf(st.lat, st.lon) : null;
    return key && R.cells.has(key) ? judge(R.cells.get(key), now) : null;
  }

  const healthA = () => (typeof Health !== 'undefined' && Health.state ? Health.state().A : null);
  const owns = st => (typeof Health !== 'undefined' && Health.owns ? Health.owns(st) : true);

  // ── asking ───────────────────────────────────────────────────────────────

  function apiOrigin() {
    return typeof dbProxyAvailable === 'function' && dbProxyAvailable() ? '' : API_ORIGIN;
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) throw new Error((body && body.error) || `the route answered HTTP ${res.status}`);
    if (!body || !Array.isArray(body.cells)) throw new Error('the route answered without the squares');
    return body;
  }

  // An answer from the route → R.cells.
  function absorb(body, at) {
    const fetched = Date.parse(body.fetched) || at || Date.now();
    for (const c of body.cells || []) {
      if (!c || !Array.isArray(c.at)) continue;
      const key = cellOf(Number(c.at[0]), Number(c.at[1]));
      if (!key) continue;
      R.cells.set(key, { tz: c.tz, days: c.days, mm: c.mm, fetched: at || Date.now() });
    }
    if (body.source) R.source = body.source;
    R.fetched = R.fetched == null ? fetched : Math.max(R.fetched, fetched);
    if (body.stale) R.stale = String(body.stale);
  }

  // The week's analysis has landed: the rain at every square a station heard
  // stands in, the squares not already in hand, CHUNK a request, sorted so the
  // same stations make the same requests on every device — and the same answers
  // in the edge cache. In the demo week, a made-up week instead.
  async function ask(A, opts) {
    const seq = ++R.seq;
    R.err = '';
    R.demo = !!(opts && opts.demo);
    if (!A) { R.loading = false; return; }
    if (R.demo) {
      R.demoBy = demoOutlook(A);
      R.loading = false;
      changed();
      return;
    }
    R.demoBy = null;
    const now = Date.now();
    const want = new Set();
    for (const S of A.stations.values()) {
      const k = cellOf(S.st.lat, S.st.lon);
      if (k) want.add(k);
    }
    const missing = [...want].filter(k => { const c = R.cells.get(k); return !c || now - c.fetched > KEEP_MS; }).sort(cmpCell);
    if (!missing.length) { R.loading = false; changed(); return; }
    R.loading = true;
    R.stale = '';
    changed();
    const chunks = [];
    for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
    const errs = [];
    let next = 0;
    async function lane() {
      while (next < chunks.length) {
        const ch = chunks[next++];
        try {
          const body = await getJson(`${apiOrigin()}${PATH}?cells=${ch.join(';')}`);
          if (seq !== R.seq) return;
          absorb(body, Date.now());
        } catch (err) {
          errs.push((err && err.message) || String(err));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, chunks.length) }, lane));
    if (seq !== R.seq) return;
    R.loading = false;
    if (errs.length) {
      R.err = errs[0] + (chunks.length > 1 ? ` (${errs.length} of ${chunks.length} requests)` : '');
    }
    changed();
  }

  function changed() {
    if (typeof Health !== 'undefined' && Health.rainChanged) Health.rainChanged();
  }

  // The demo week's rain, made up so the card has something to show: the
  // stations heard, north to south, the top third very wet tomorrow, the next
  // wet the day after, and the rest dry until the end of the week. Real days,
  // from today, in Brisbane's time.
  function demoOutlook(A) {
    const t = Date.now();
    const days = [];
    for (let k = 0; k < WEEK; k++) days.push(todayIn('Australia/Brisbane', t + k * 24 * HOUR));
    const list = [...A.stations.values()].filter(S => Number.isFinite(S.st.lat) && Number.isFinite(S.st.lon))
      .sort((a, b) => b.st.lat - a.st.lat || String(a.st.id).localeCompare(String(b.st.id)));
    const by = new Map();
    const third = Math.max(1, Math.ceil(list.length / 3));
    list.forEach((S, i) => {
      const mm = i < third ? [4, 46, 22, 6, 1, 0, 0]
               : i < 2 * third ? [0, 3, 14, 5, 0, 0, 0]
               : [0, 0, 1, 0, 8, 26, 12];
      by.set(S.st.id, { tz: 'Australia/Brisbane', days: days.slice(), mm });
    });
    return by;
  }

  // ── what the card lists ──────────────────────────────────────────────────

  const rankOf = o => (o.near.band === 'very' ? 0 : o.near.band === 'wet' ? 1 : o.later.band === 'very' ? 2 : o.later.band === 'wet' ? 3 : 9);

  // Every station heard (the owner filter's) with rain ahead, near or later:
  // [{ S, o, faults, rank }], who to get to first first.
  function rows(A) {
    const out = [];
    if (!A) return out;
    for (const S of A.stations.values()) {
      if (!owns(S.st)) continue;
      const o = of(S.st.id);
      if (!o) continue;
      const rank = rankOf(o);
      if (rank === 9) continue;
      const faults = S.findings.filter(f => f.severity !== 'info' && FAULT_CATS.has(f.category))
        .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
      out.push({ S, o, faults, rank });
    }
    const worst = r => (r.faults.length ? SEV_RANK[r.faults[0].severity] ?? 3 : 3);
    const soon = r => (r.rank < 2 ? (r.o.near.first ?? 9) : (r.o.later.maxAt ?? 9));
    const wettest = r => (r.rank < 2 ? r.o.near.max : r.o.later.max);
    return out.sort((a, b) => a.rank - b.rank || soon(a) - soon(b) || worst(a) - worst(b)
      || wettest(b) - wettest(a) || String(a.S.st.name).localeCompare(String(b.S.st.name)));
  }

  function tally(A) {
    const all = rows(A);
    const near = all.filter(r => r.rank < 2);
    return {
      all, near,
      very: near.filter(r => r.rank === 0).length,
      first: all.filter(r => r.faults.length),
      nearFaults: near.filter(r => r.faults.length).length,
      later: all.filter(r => r.rank >= 2).length,
      laterFaults: all.filter(r => r.rank >= 2 && r.faults.length).length,
    };
  }

  const ready = () => R.demo ? !!R.demoBy : R.cells.size > 0;

  // ── words for days ───────────────────────────────────────────────────────

  function dayName(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    if (!y) return String(date);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  }
  function dayWord(o, i) {
    if (i == null) return '';
    if (i === 0) return 'today';
    if (i === 1) return 'tomorrow';
    const d = o.days[i];
    return d ? dayName(d.date) : '';
  }
  // "46 mm tomorrow" — the wettest day of the part that set the band.
  function wettestText(o, later) {
    const p = later ? o.later : o.near;
    return `${mm1(p.max)} mm ${dayWord(o, p.maxAt)}`;
  }

  function chipTitle(o, later) {
    const p = later ? o.later : o.near;
    const span = later ? 'days four to seven' : 'the next three days';
    return `The weather model has ${wettestText(o, later)}, and ${mm1(p.total)} mm across ${span}, at this station's 25 km square — `
      + (later ? 'a reason to plan a visit; a model\'s rain that far ahead moves from run to run. ' : 'get to its faults before the rain does. ')
      + 'A raw model figure, not a forecast or a warning: the Bureau of Meteorology\'s are at bom.gov.au.';
  }

  function chip(o, later) {
    const band = later ? o.later.band : o.near.band;
    if (!band) return '';
    const label = later ? LATER_LABEL[band] : BAND_LABEL[band];
    return `<span class="term-chip hl-rain-chip hl-rain-chip--${band}${later ? ' hl-rain-chip--later' : ''}" title="${esc(chipTitle(o, later))}">`
      + `<span aria-hidden="true">🌧</span> ${esc(label)} · ${esc(wettestText(o, later))}</span>`;
  }

  // The week as seven small cells, today first; the last four paler.
  function weekHtml(o) {
    const lvl = v => (v == null ? 'none' : v >= BANDS.very.day ? 'very' : v >= BANDS.wet.day ? 'wet' : v >= 1 ? 'some' : 'dry');
    const said = o.days.map(d => `${dayWord(o, d.i) || dayName(d.date)} ${d.mm == null ? 'no figure' : mm1(d.mm) + ' mm'}`).join(', ');
    return `<span class="hl-rain-week" role="img" aria-label="${esc(`The model's rain a day: ${said}`)}">${o.days.map(d => `
      <span class="hl-rain-day hl-rain-day--${lvl(d.mm)}${d.i >= NEAR ? ' hl-rain-day--later' : ''}">`
        + `<span class="hl-rain-dname">${esc(d.i === 0 ? 'Today' : dayName(d.date))}</span>`
        + `<span class="hl-rain-dmm">${esc(d.mm == null ? '—' : mm1(d.mm))}</span></span>`).join('')}</span>`;
  }

  // ── for the rest of Station Health ───────────────────────────────────────

  // Beside a finding in Needs attention: only a fault, and only rain in the
  // next three days — a chip there means "before the rain".
  function chipHtml(id, f) {
    if (!id || (f && (!FAULT_CATS.has(f.category) || f.severity === 'info'))) return '';
    const o = of(id);
    return o && o.near.band ? chip(o, false) : '';
  }

  // The station panel's line: its band and its week, or what is known.
  function factHtml(id) {
    if (!ready()) {
      return R.loading ? '<span class="txt-muted">Asking the weather model…</span>'
        : R.err ? `<span class="txt-muted">${esc('The weather model’s rain is not to hand.')}</span>` : '';
    }
    const o = of(id);
    if (!o) return `<span class="txt-muted">${esc(R.loading ? 'Asking the weather model…' : 'No figure for this station’s square.')}</span>`;
    const head = o.near.band ? chip(o, false) : o.later.band ? chip(o, true)
      : `<span class="txt-muted">${esc('Little or none — under 10 mm a day all week')}</span>`;
    return `${head} ${weekHtml(o)}`;
  }

  // The map's halo round a station with rain in the next three days.
  function haloOf(id) {
    const o = ready() ? of(id) : null;
    return o && o.near.band ? { band: o.near.band, color: RING, fill: FILL } : null;
  }

  function legendHtml() {
    if (!ready()) return '';
    return `<span><i class="hl-rain-ring" aria-hidden="true"></i>${term('ahead', 'rain ahead')} (model)</span>`;
  }

  // The Calm look's sentence: how many stations have rain ahead and a fault
  // open, and the way down to them. Nothing while there is nothing to say.
  function verdictHtml(A) {
    if (!ready() || !A) return '';
    const t = tally(A);
    if (!t.nearFaults) return '';
    return ` <strong>${term('ahead', 'Rain ahead')}</strong> at ${plural(t.nearFaults, 'station')} with a fault open —
      <button type="button" class="link-btn" onclick="HealthRainAhead.toCard()">get to ${t.nearFaults === 1 ? 'it' : 'them'} first</button>.`;
  }

  function toCard() {
    const h = document.getElementById('hl-h-rain');
    if (!h) return;
    h.setAttribute('tabindex', '-1');
    h.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  }

  function showAll() {
    R.all = !R.all;
    const el = document.getElementById('hl-rain');
    if (el) el.innerHTML = render();
    const b = document.querySelector('#hl-rain .hl-rain-more');
    if (b) b.focus();
  }

  // ── the card ─────────────────────────────────────────────────────────────

  function ledeHtml(A, t) {
    const where = typeof Health !== 'undefined' && Health.state && Health.state().owners.length ? 'the stations of the owners picked' : 'the stations heard';
    const demo = R.demo ? '<strong>Demo week</strong> — the rain ahead is made up as well, so the card has something to show. ' : '';
    if (!t.near.length) {
      return `${demo}<strong>No ${term('ahead', 'rain ahead')}</strong> in the next three days at ${where}: the weather model has under 10 mm a day,
        and under 20 mm across the three, everywhere.${t.later ? ` It has rain later in the week at ${plural(t.later, 'station')}${t.laterFaults ? `, ${num(t.laterFaults)} with a fault open — below` : ''}.` : ''}`;
    }
    const faults = t.nearFaults
      ? ` <strong>${plural(t.nearFaults, 'of them has', 'of them have')} a ${term('fault', 'fault open')}</strong> that loses readings when it rains: get to ${t.nearFaults === 1 ? 'it' : 'those'} first.`
      : ' None of them has a fault open that loses readings in the rain.';
    return `${demo}<strong>The weather model has ${term('ahead', 'rain ahead')} at ${plural(t.near.length, 'station')}</strong> in the next three days${
      t.very ? ` — ${num(t.very)} ${term('very', 'very wet')}` : ''}.${faults}${
      t.later ? ` Later in the week it has rain at ${plural(t.later, 'more station', 'more stations')}.` : ''}`;
  }

  function firstHtml(list) {
    if (!list.length) return '';
    const shown = R.all ? list : list.slice(0, SHOW);
    const sev = f => `<span class="${f.severity === 'critical' ? 'txt-bad' : 'txt-warn'}" aria-hidden="true">${f.severity === 'critical' ? '⛔' : '⚠'}</span>`
      + `<span class="sr-only">${f.severity === 'critical' ? 'Critical' : 'Warning'}:</span> ${esc(f.title)}`;
    const body = shown.map(r => {
      const st = r.S.st;
      const later = r.rank >= 2;
      return `<tr>
        <td>${chip(r.o, later)}</td>
        <th scope="row"><button class="link-btn" onclick="Health.select('${escAttr(st.id)}')"
              title="Open ${esc(st.name)} below — its checks, battery and sensors">${esc(st.name)}</button></th>
        <td><ul class="hl-rain-faults">${r.faults.slice(0, 3).map(f => `<li>${sev(f)}</li>`).join('')}${
          r.faults.length > 3 ? `<li class="small txt-muted">and ${num(r.faults.length - 3)} more</li>` : ''}</ul></td>
        <td class="col-optional">${weekHtml(r.o)}</td>
      </tr>`;
    }).join('');
    return `<h4 id="hl-h-rain-first">${term('first', 'Get to these first')}</h4>
      <div class="table-wrap" role="region" tabindex="0" aria-labelledby="hl-h-rain-first">
        <table class="hl-table hl-rain-table">
          <caption class="sr-only">Stations with rain ahead and a fault open, the wettest and soonest first: how wet, the station, its faults and the model's week</caption>
          <colgroup><col class="hl-rain-col-chip"><col class="hl-rain-col-stn"><col><col class="hl-rain-col-week col-optional"></colgroup>
          <thead><tr><th scope="col">${term('ahead', 'Rain ahead')}</th><th scope="col">Station</th>
            <th scope="col">${term('fault', 'Faults open')}</th><th scope="col" class="col-optional">${term('week', 'Next 7 days, mm')}</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${list.length > SHOW ? `<button type="button" class="ghost hl-rain-more" onclick="HealthRainAhead.showAll()">${R.all ? 'Show the first ' + SHOW : `Show all ${num(list.length)}`}</button>` : ''}`;
  }

  // Where the rain is, by basin: the next three days only.
  function basinsHtml(near) {
    if (!near.length) return '';
    const names = new Map(((state.data && state.data.catchments) || []).map(c => [c.id, c.name]));
    const NONE = 'No basin on file';
    const by = new Map();
    for (const r of near) {
      const id = (r.S.st.catchment_ids || [])[0];
      const name = (id && names.get(id)) || NONE;
      if (!by.has(name)) by.set(name, { name, n: 0, faults: 0, top: null });
      const b = by.get(name);
      b.n++;
      if (r.faults.length) b.faults++;
      if (!b.top || r.o.near.max > b.top.o.near.max) b.top = r;
    }
    const list = [...by.values()].sort((a, b) => (a.name === NONE) - (b.name === NONE) || b.top.o.near.max - a.top.o.near.max || a.name.localeCompare(b.name));
    return `<details class="hl-details hl-rain-basins"><summary>Where the model has rain ahead, by ${term('basin', 'basin')}</summary>
      <div class="table-wrap" role="region" tabindex="0" aria-label="Rain ahead by basin">
        <table class="hl-table">
          <caption class="sr-only">Each basin with rain ahead in the next three days: its wettest station, how many stations heard there have rain ahead, and how many of those have a fault open</caption>
          <thead><tr><th scope="col">${term('basin', 'Basin')}</th><th scope="col">Wettest</th><th scope="col">With rain ahead</th><th scope="col">With a fault open</th></tr></thead>
          <tbody>${list.map(b => `<tr><th scope="row">${esc(b.name)}</th>
            <td>${esc(wettestText(b.top.o))} <span class="small txt-muted">at ${esc(b.top.S.st.name)}</span></td>
            <td>${num(b.n)}</td><td>${b.faults ? num(b.faults) : '<span class="txt-muted">none</span>'}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </details>`;
  }

  function wordsHtml() {
    return `<details class="hl-details"><summary>What the words in this card mean</summary>
      <dl class="hl-words">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl>
    </details>`;
  }

  function sourceHtml() {
    const s = Object.assign({}, SOURCE, R.source && typeof R.source === 'object' ? { credit: R.source.credit || SOURCE.credit } : {});
    const when = R.demo ? 'The rain on this card is made up for the demo week.'
      : R.fetched ? `Fetched ${new Date(R.fetched).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${R.stale ? ` — the last copy kept, because ${esc(R.stale)}` : ''}.` : '';
    return `<p class="small hl-rain-src">${esc(s.credit)}
      <a href="${esc(SOURCE.ecmwf)}" target="_blank" rel="noopener">ECMWF</a> ·
      <a href="${esc(SOURCE.openMeteo)}" target="_blank" rel="noopener">Open-Meteo</a> ·
      <a href="${esc(SOURCE.licence)}" target="_blank" rel="noopener">CC BY 4.0</a>. ${when}
      <strong>A weather model’s raw figure, used here only to choose which faults to fix first — not a forecast or a warning
      from the Bureau of Meteorology or from Flood-Net.</strong> For forecasts and warnings, go to the Bureau:
      <a href="${BOM_HOME}" target="_blank" rel="noopener">bom.gov.au</a> ·
      <a href="${BOM_WARNINGS}" target="_blank" rel="noopener">warnings</a>.</p>`;
  }

  function render() {
    const A = healthA();
    const head = `<div class="panel-header"><h3 id="hl-h-rain"><span aria-hidden="true">🌧</span> ${term('ahead', 'Rain ahead')}</h3>
      <span class="small">${term('model', 'one weather model')}’s next week, at the stations heard</span></div>`;
    if (!A) return head;
    let body;
    if (!ready()) {
      body = R.loading ? '<p class="small hl-empty">Asking the weather model for the coming week’s rain at the stations heard…</p>'
        : R.err ? `<p class="small"><span class="txt-warn">The weather model’s rain could not be fetched — ${esc(R.err)}.</span>
            Nothing else on this tab depends on it; Refresh asks again.</p>`
        : '<p class="small hl-empty">The weather model has not been asked yet.</p>';
      return `${head}${body}${sourceHtml()}`;
    }
    const t = tally(A);
    const partly = R.err ? ` <span class="txt-warn small">Some squares could not be fetched — ${esc(R.err)} — so some stations may be missing.</span>` : '';
    const busy = R.loading ? ' <span class="small txt-muted">Asking the weather model about more stations…</span>' : '';
    return `${head}
      <p class="hl-rain-lede">${ledeHtml(A, t)}${partly}${busy}</p>
      ${firstHtml(t.first)}
      ${basinsHtml(t.near)}
      ${wordsHtml()}
      ${sourceHtml()}`;
  }

  function state_() {
    return { cells: R.cells.size, fetched: R.fetched, stale: R.stale, err: R.err, loading: R.loading, demo: R.demo };
  }

  return {
    ask, of, render, chipHtml, factHtml, haloOf, legendHtml, verdictHtml, toCard, showAll,
    words: () => Object.assign({}, WORDS), state: state_,
    _bandOf: bandOf, _judge: judge, _cellOf: cellOf, _rows: rows, _absorb: absorb, _todayIn: todayIn,
    _reset() { Object.assign(R, { cells: new Map(), source: null, fetched: null, stale: '', err: '', loading: false, seq: R.seq + 1, demo: false, demoBy: null, all: false }); },
  };
})();

if (typeof window !== 'undefined') window.HealthRainAhead = HealthRainAhead;
