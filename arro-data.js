// MegaNet — arro-data.js
//
//   ArroData   the ARRO Data tab: reads ARRO's per-sensor CSV exports in the
//              browser — nothing is uploaded — links each file back to the
//              station that produced it, runs the Bureau's 3-5-7 continuity
//              filter over it, and draws raw against filtered.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, csvEscape, dlText, slug,
// arroSiteId, arroSensorUrl, bucketSizeMm, dbHostLabel and registerTabTeardown
// (#142 — this file declares that its ResizeObserver has to be dropped on the
// way out, where app.js used to say so for it); across to app.js for
// renderMain and renderTabs; to datastore.js for dbSelect; and to modal.js for
// Modal.
//
// 3,272 lines, the largest of the fourteen and the subject of #128. Moving it
// gave it a file; it did not decompose it, and the file size is not an
// invitation to start. The whole point of the tab is seeing what the filter
// removed, so raw and filtered are two views of one immutable import — the
// parsed arrays are never written to after import. Do not optimise that away.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── ARRO DATA tab (CSV import, 357 filter, plotting) ───────────────────────────
// ARRO exports one CSV per sensor. This tab reads them in the browser — nothing
// is uploaded — links each file back to the station that produced it, runs the
// Bureau's 3-5-7 continuity filter over it, and draws the result.
//
// The whole point is *seeing what the filter removed*, so raw and filtered are
// kept as two views of one immutable import: the parsed arrays are never
// written to after import, and filtering only ever produces a parallel status
// array. A filter you cannot inspect is worse than no filter.
//
// Reference: "Hydrology Raw Data Filtering Program Specification" v2.1,
// Commonwealth Bureau of Meteorology, May 2009 (and the 1998 first edition).

// The twelve series colours. These used to be twelve hex literals here, which
// is why the top of styles.css carried a warning that a palette change did not
// reach this chart: the SVG needs a real colour value (a `var(…)` resolves to
// nothing once the picture has been pulled out of the page and handed to a
// canvas), and the only way anyone had found to give it one was to type it.
//
// They are tokens now — --ad-series-1…12, with a dark set — resolved off the
// document at the moment a series is adopted and again on every repaint(). The
// SVG still carries hex, so the PNG export is unchanged; what changed is where
// the hex comes from. Before this the chart drew the light-theme palette on a
// dark page, because toggleTheme() had no way to reach an array in a script.
//
// AD_COLORS survives as the fallback, and it is the light set exactly: a
// `getComputedStyle` miss (a stylesheet that has not landed, a test harness
// rendering without one) should degrade to the colours this chart has always
// had rather than to black.
const AD_SERIES_TOKENS = ['--ad-series-1',  '--ad-series-2',  '--ad-series-3',  '--ad-series-4',
                          '--ad-series-5',  '--ad-series-6',  '--ad-series-7',  '--ad-series-8',
                          '--ad-series-9',  '--ad-series-10', '--ad-series-11', '--ad-series-12'];

const AD_COLORS = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                   '#b8860b', '#00838f', '#ad1457', '#5d4037',
                   '#3949ab', '#ef6c00', '#2e7d32', '#6a1b9a'];

// Colour is not the only thing telling two lines apart. WCAG 1.4.1 is the rule
// and a printed-in-greyscale incident report is the everyday case: six dash
// patterns, cycled with the colour, so two series remain distinguishable with
// no hue at all. Only applied when more than one series is on the chart — a
// single dashed line says "provisional" and means nothing of the kind.
const AD_DASH = ['', '7 3', '2 3', '10 3 2 3', '5 2 1 2', '1 3'];

// …and the same six, named, for the operator who wants to say which (#191).
// The chart picked one per slot and there was no way to ask for another — which
// is fine until two series land on slots whose dashes read alike in print, or
// until somebody wants the one line that matters solid and the rest dashed.
// `auto` is the slot rule, unchanged and still the default, so a chart nobody
// has touched draws exactly what it drew before.
const AD_DASH_CHOICES = [
  ['auto',   'Auto',        null],
  ['solid',  'Solid',       ''],
  ['dash',   'Dashed',      '7 3'],
  ['dot',    'Dotted',      '2 3'],
  ['dashdot','Dash-dot',    '10 3 2 3'],
  ['long',   'Long dash',   '12 4'],
];

// The swatch grid the colour control offers beside the browser's own picker
// (#191). A native <input type="color"> is a gradient surface and an eyedropper
// — excellent for matching a colour, useless for "make this one red", which is
// what somebody comparing four traces actually wants. So: the colours a person
// asks for by name, one square each.
//
// Ten of the twelve are mid-lightness on purpose, because a chart line is drawn
// on --panel and --panel is white in one theme and near-navy in the other, so a
// colour that only works on one of them is a colour that disappears when
// somebody toggles the theme. **Black and white are the deliberate exceptions**
// and each is invisible on one of the two grounds. They are here because they
// were asked for and because they are the right answer to a real question —
// "make this one black, it is going in a printed report" — and picking one is
// an operator saying which ground they are aiming at. Nothing else in the app
// is coloured from this list; these are line colours and nothing more.
//
// Hex rather than tokens, because this is the literal the SVG carries into a
// PNG export where no stylesheet resolves anything — see slotColor(), which is
// the *other* half of that argument and is why an untouched series is still
// token-coloured and still re-resolves when the theme moves.
const AD_SWATCHES = [
  ['#c7401a', 'Red'],     ['#e06c00', 'Orange'],  ['#b8860b', 'Amber'],
  ['#107c10', 'Green'],   ['#00838f', 'Teal'],    ['#0b5cab', 'Blue'],
  ['#3949ab', 'Indigo'],  ['#7c35a3', 'Purple'],  ['#ad1457', 'Magenta'],
  ['#5d4037', 'Brown'],   ['#16202a', 'Black'],   ['#ffffff', 'White'],
];

// …and the same argument for the modes that draw marks rather than lines. Four
// shapes, cycled with the colour.
const AD_SHAPES = ['circle', 'square', 'triangle', 'diamond'];

// Point status. Ordered so that "kept" is < BAD and the drawing code can test
// with a single comparison. RANGE and RATE are removals by the two limit
// filters, which run before the 357 walk and are not part of the spec — they
// are kept distinct from BAD so a rejected reading can always say which filter
// rejected it.
const AD_UNKNOWN = 0, AD_GOOD = 1, AD_SUSPECT = 2, AD_BAD = 3, AD_OOS = 4,
      AD_RANGE = 5, AD_RATE = 6, AD_FALL = 7;

const AD_STATUS_LABEL = {
  [AD_UNKNOWN]: 'untested',
  [AD_GOOD]:    'good',
  [AD_SUSPECT]: 'suspect',
  [AD_BAD]:     'bad',
  [AD_OOS]:     'out of sequence',
  [AD_RANGE]:   'out of range',
  [AD_RATE]:    'rose too fast',
  [AD_FALL]:    'fell too fast',
};

// Every status that means "this reading is not in the filtered series".
const adCut = st => st === AD_BAD || st === AD_OOS || st === AD_RANGE
                 || st === AD_RATE || st === AD_FALL;

// Spec defaults, all overridable from the panel — the ticket asks for the steps,
// the rollover ceiling and the continuity break to be configurable.
//
// Each filter also carries its own on/off flag, so any of them can be taken out
// of the pipeline and the effect seen immediately. The 357 test is one of them:
// `use357` off leaves the pre-filters running and nothing tested for continuity,
// which is the honest way to ask "how much of this is the 357 test's doing?"
const AD_CFG_DEFAULT = {
  use357:     true,   // the 3-5-7 continuity walk itself
  small:      3,      // <= 3 against the next data
  medium:     5,      // <= 5 against the next-next
  large:      7,      // <= 7 against the next-next-next
  cycle:      2048,   // accumulator counts 0..2047, so it wraps at 2048
  breakCount: 4,      // four consecutive failures break continuity
  startTests: 4,      // start-continuity test budget (spec flowchart: testCount > 4)
  rolloverOn: true,
  oosOn:      true,   // drop out-of-sequence / duplicate timestamps
  dedupeOn:   true,
  minGapSec:  0,      // collapse readings closer together than this (0 = off)
  rateOn:     false,  // rate-of-rise limit
  rateMax:    50,     // fastest believable rise, in Value units per hour
  // The other direction, and a filter of its own rather than a sign on the one
  // above (#191). A gauge's two directions are not one number: a water level
  // rises with the catchment and falls with the channel draining, and the
  // fastest *credible* fall at a site is routinely a different figure from the
  // fastest credible rise. Before this the rise limit tested a level's falls
  // too, against the rise threshold, which is the wrong figure applied with no
  // way to say so — and tested an accumulator's falls not at all.
  fallOn:     false,  // rate-of-fall limit
  fallMax:    50,     // fastest believable fall, in Value units per hour
  rangeOn:    false,  // minimum / maximum limits
  rangeMin:   '',     // blank = no floor
  rangeMax:   '',     // blank = no ceiling
};

const AD_DAY = 86400000;

// What each vertical-axis mode is called, for the places that have to name the
// one currently set rather than offer all four — the reset button's tooltip,
// and the sentence the vertical navigator uses to say what it is steering.
const AD_Y_LABEL = { auto: 'Auto', kept: 'Kept', zero: 'Zero', manual: 'Fixed' };

// ── The marks, as one drawing each (#191) ────────────────────────────────────
// Six things get a mark on this chart — five removals and a rollover seam — and
// until now the only place the shape of any of them was written down was inside
// draw(), 400 lines away from the tick boxes that switch them on. "removed",
// "repeats" and "rollovers" beside three identical checkboxes told nobody what
// to go and look for, and a filter panel saying "Rate of rise" never said that
// the thing it puts on the chart is a small up-pointing triangle.
//
// So the shapes live here, once, and both the chart and the controls draw from
// them. The geometry is deliberately the same as draw()'s — an ✕ for the 357
// test, a hollow square for the range limits, a filled triangle for each rate
// limit pointing the way it is about, a faint dot for a repeat, a dashed
// vertical for a rollover seam — because a legend that is merely *similar* to
// what is on the chart is worse than none: it teaches a shape that is not
// there.
//
// currentColor rather than a theme lookup: these are inline in a label, and a
// label already knows what colour it is. The chart resolves the same shapes
// against theme() for the same reason it always has — it has to survive being
// serialised into a PNG with no stylesheet.
const AD_MARKS = {
  removed:  { label: 'failed the 357 test',            tone: 'bad',
              d: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none"/>' },
  range:    { label: 'outside the range limits',        tone: 'warn',
              d: '<rect x="4.2" y="4.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.8"/>' },
  rate:     { label: 'rose faster than the rate limit', tone: 'warn',
              d: '<path d="M8 3.6l4.4 7.6H3.6Z" fill="currentColor"/>' },
  fall:     { label: 'fell faster than the rate limit', tone: 'warn',
              d: '<path d="M8 12.4L3.6 4.8h8.8Z" fill="currentColor"/>' },
  repeat:   { label: 'a repeat timestamp',              tone: 'muted',
              d: '<circle cx="8" cy="8" r="2.2" fill="currentColor" opacity=".55"/>' },
  rollover: { label: 'an accumulator wrap corrected',   tone: 'warn',
              d: '<path d="M8 2v12" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.5" fill="none"/>' },
};

// One mark, at label size. aria-hidden because every caller sits next to the
// words it illustrates — a screen reader being told "triangle" after "Rate of
// fall" learns nothing it did not have.
function adMarkSvg(kind) {
  const m = AD_MARKS[kind];
  if (!m) return '';
  return `<svg class="ad-mark ad-mark--${m.tone}" viewBox="0 0 16 16" width="13" height="13"
               aria-hidden="true" focusable="false">${m.d}</svg>`;
}

// ── module ──

const ArroData = (function () {

  // One module, two tabs. ARRO Data reads CSV exports; Field Data (#114) reads
  // meganet.reading out of the datastore. Everything between a parsed series and
  // a drawn pixel is identical, and building a second copy of it was explicitly
  // not the job — so the chart, the 357 filter and the export are shared and the
  // *state* is what forks.
  //
  // The hard rule the epic sets is that the two sources never blur together, and
  // this is where that is made structural: a series lives in exactly one
  // instance, and no code path moves one between them. There is no merged list
  // to accidentally draw from.
  //
  // Only one tab is mounted at a time — renderMain() replaces the whole pane —
  // so `ad` is a binding onto whichever instance is on screen, and the inline
  // handlers in the markup below can all say `ArroData.x()` and mean "the data
  // tab you are looking at". Anything asynchronous must capture `ad` up front
  // rather than read it again in a callback: a tab switch mid-flight would
  // otherwise land a query's results in the other instance.
  function newState(source) {
    return {
      source,                  // 'arro' | 'field' — provenance, and never inferred
      series:    [],
      seq:       0,
      cfg:       { ...AD_CFG_DEFAULT },
      view:      null,           // {t0,t1} visible window, ms; null = full extent
      // Filtered, not both (#191). "Both" draws every series twice — the filtered
      // line solid over a ghost of the raw — which is the right picture for the
      // question "what did the filter take out?" and the wrong one for the
      // question somebody actually arrives with, which is "what does this gauge
      // say?". Two overlaid traces per series is also where a four-series chart
      // stops being readable. The removals are still one click away on the
      // Series control, still marked on the chart by Mark ▸ removed, and still
      // counted in the rail; what changed is which of the three the tab opens
      // holding.
      mode:      'filtered',     // raw | filtered | both
      transform: 'value',        // value | increment | rate
      chartType: 'line',
      yMode:     'auto',         // auto | zero | manual
      yMin:      '', yMax: '',
      showRemoved:  true,
      showRollover: true,
      compare:      false,       // side-by-side raw/filtered panes, folded away
      tableOpen:    false,       // the readings table under the chart (#141), folded away
      tableSig:     '',          // what it was last built from — see renderTable()
      showPoints:   'auto',      // auto | on | off
      colourOpen:   null,        // which series' colour grid is open (#191)
      normalise:    false,
      hover:     null,           // {x,y,t,rows:[]}
      pin:       null,           // clicked point: {key,i}
      // The picked readings, as "seriesKey\u0000rowIndex" — see the editing
      // section. A Set rather than an array because the chart asks "is this one
      // picked?" once per drawn mark.
      picked:    new Set(),
      // The last thing the value box was set to, kept across the re-renders an
      // edit causes so a second press of the same button does the same thing.
      editVal:   '',
      editQ:     '',
      drag:      null,
      // What a plain drag on the chart does, as one choice rather than two
      // switches (#191). It was `brush` and `yDrag`, two independent tick
      // boxes — so both could be on at once, which the gesture cannot honour:
      // a press has exactly one meaning and onpointerdown had to pick, silently
      // preferring the vertical. Three states, one control, and "none" is one
      // of them because panning is the state people spend most of their time
      // in. The Shift and Alt modifiers still outrank whatever is set here, so
      // either zoom is always reachable without touching the toolbar.
      dragMode:  'pan',          // pan | box | y
      // The chart taking the whole viewport (#191). Session-only and per
      // instance, like the map's own: it is something somebody is doing right
      // now, not a preference.
      full:      false,
      yStash:    null,           // {yMode,yMin,yMax} from before a zoom gesture forced 'manual'
      // Which navigator gesture is in flight, and what it started from:
      // { kind:'lo'|'hi'|'move', t0, t1, grab } on the horizontal strip and
      // { kind, lo, hi, grab } on the vertical one. Null when neither is held.
      ovDrag:    null,
      vovDrag:   null,
      w: 900, h: 380,
      ro:        null,
      sensorIdx: null,
      sensorIdxFor: null,
      busy:      0,
      fq:        null,           // the Field tab's picker; null on the ARRO tab
    };
  }

  const instances = { arro: newState('arro'), field: newState('field') };

  let ad = instances.arro;

  function activate(source) {
    ad = instances[source] || instances.arro;
    return ad;
  }

  // ── CSV parsing ────────────────────────────────────────────────────────────

  // Splits one CSV line, honouring quotes. ARRO does not quote anything, but a
  // hand-edited file might, and mis-parsing a quoted field is silent corruption.
  function splitLine(line) {
    if (line.indexOf('"') < 0) return line.split(',');
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',')  { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  // ARRO writes thousands separators into Value without quoting them, so
  // `1,613.0` arrives as two fields and the row is one wider than the header.
  // The columns either side of Value are fixed-width, so the surplus can only
  // belong to Value: anchor the head and the tail, and glue the middle back
  // together. 395 of the 14,942 rows in the sample export need this.
  function reconcile(fields, nHead, valueIdx) {
    if (fields.length === nHead) return fields;
    if (fields.length < nHead || valueIdx < 0) return null;
    const tail = nHead - valueIdx - 1;
    const glued = fields.slice(valueIdx, fields.length - tail).join('').replace(/,/g, '');
    return [...fields.slice(0, valueIdx), glued, ...fields.slice(fields.length - tail)];
  }

  // "2026-08-07 15:38:13" — ARRO exports station local time with no zone, and
  // reads it back the same way, so it is parsed as local rather than shifted
  // into UTC. Also accepts ISO with a T, and dd/mm/yyyy.
  function parseTs(s) {
    s = (s || '').trim();
    if (!s) return NaN;
    let m = s.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    m = s.match(/^(\d\d?)\/(\d\d?)\/(\d{4})[ T](\d\d):(\d\d)(?::(\d\d))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    const t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  function parseCsv(text) {
    const warn = [];
    const lines = text.split(/\r?\n/);
    let h = 0;
    while (h < lines.length && !lines[h].trim()) h++;
    if (h >= lines.length) return { error: 'The file is empty.' };

    const head  = splitLine(lines[h]).map(s => s.trim().toLowerCase().replace(/^﻿/, ''));
    const col   = name => head.findIndex(c => c === name);
    const iRead = col('reading'), iVal = col('value');
    if (iRead < 0 || iVal < 0) {
      return { error: 'Not an ARRO sensor export — expected "Reading" and "Value" columns, '
                    + `got: ${head.join(', ') || '(no header)'}` };
    }
    const iRecv = col('receive'), iUnit = col('unit');
    const iQual = col('data quality'), iRaw = col('raw value');

    const n0 = lines.length - h - 1;
    const t = new Float64Array(n0), tr = new Float64Array(n0);
    const v = new Float64Array(n0), raw = new Float64Array(n0);
    const q = new Uint8Array(n0);
    const qcodes = [], qmap = new Map();
    const units = new Map();
    let n = 0, skipped = 0, ragged = 0;

    for (let li = h + 1; li < lines.length; li++) {
      const line = lines[li];
      if (!line.trim()) continue;
      let f = splitLine(line);
      if (f.length !== head.length) {
        const fixed = reconcile(f, head.length, iVal);
        if (!fixed) { skipped++; continue; }
        ragged++; f = fixed;
      }
      const ts = parseTs(f[iRead]);
      const val = parseFloat(f[iVal]);
      if (isNaN(ts) || isNaN(val)) { skipped++; continue; }

      t[n]  = ts;
      tr[n] = iRecv >= 0 ? (parseTs(f[iRecv]) || ts) : ts;
      v[n]  = val;
      raw[n] = iRaw >= 0 ? (parseFloat(String(f[iRaw]).replace(/,/g, '')) ?? val) : val;
      if (isNaN(raw[n])) raw[n] = val;

      const code = iQual >= 0 ? (f[iQual] || '').trim() : '';
      let qi = qmap.get(code);
      if (qi === undefined) { qi = qcodes.length; qcodes.push(code); qmap.set(code, qi); }
      q[n] = qi;

      if (iUnit >= 0) {
        const u = (f[iUnit] || '').trim();
        if (u) units.set(u, (units.get(u) || 0) + 1);
      }
      n++;
    }

    if (!n) return { error: 'No readable rows — every line failed to parse.' };
    if (ragged)  warn.push(`${ragged} row${ragged === 1 ? '' : 's'} carried an unquoted thousands separator in Value and were re-joined.`);
    if (skipped) warn.push(`${skipped} row${skipped === 1 ? '' : 's'} could not be parsed and were dropped.`);

    let unit = '';
    let best = 0;
    for (const [u, c] of units) if (c > best) { best = c; unit = u; }

    return seriesData({ n, t, tr, v, raw, q, qcodes, unit, warn, hasRaw: iRaw >= 0 });
  }

  // ── the series boundary ──────────────────────────────────────────────────────
  // The one door into this module, and the reason the Field Data tab is a query
  // rather than a second chart. A source produces parallel arrays in whatever
  // order it happens to have them; this puts them in the order everything
  // downstream assumes, and hands back the shape runFilter(), tracks(), the
  // chart and the export all read.
  //
  // `cols` in, series data out:
  //   n, t, tr, v, raw, q   parallel arrays, length >= n (the tail is ignored)
  //   qcodes                q[i] indexes this; the labels, in first-seen order
  //   unit, warn, hasRaw    carried through untouched
  //   extra                 optional {name: TypedArray}, reordered alongside —
  //                         this is how the datastore's dup_count and path index
  //                         ride along without every source having to have them
  function seriesData(cols) {
    const { n, t, tr, v, raw, q } = cols;

    // Ascending in time, latest last — the 357 algorithm depends on it, and
    // ARRO exports newest-first. A stable sort keeps same-timestamp rows in
    // source order so the duplicate that survives de-duplication is predictable.
    const ord = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => t[a] - t[b] || a - b);
    const desc = n > 1 && t[ord[0]] !== t[0];

    const T = new Float64Array(n), TR = new Float64Array(n);
    const V = new Float64Array(n), RAW = new Float64Array(n), Q = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = ord[i];
      T[i] = t[j]; TR[i] = tr[j]; V[i] = v[j]; RAW[i] = raw[j]; Q[i] = q[j];
    }

    const extra = {};
    for (const [name, src] of Object.entries(cols.extra || {})) {
      // Same constructor as the input, so an Int32Array of path ids stays one
      // and a plain Array of strings stays one.
      const out = Array.isArray(src) ? new Array(n) : new src.constructor(n);
      for (let i = 0; i < n; i++) out[i] = src[ord[i]];
      extra[name] = out;
    }

    return {
      n, t: T, tr: TR, v: V, raw: RAW, q: Q,
      qcodes: cols.qcodes || [],
      unit:   cols.unit || '',
      warn:   cols.warn || [],
      desc,
      hasRaw: !!cols.hasRaw,
      extra,
    };
  }

  // ── filename → sensor id → station ─────────────────────────────────────────

  // `aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv`
  //  └ prefix └ site name  └ number └ sensor  └── sensor id, dots as underscores
  //
  // The tail is the thing worth having: `541134_0_R_5758` is `541134.0.R.5758`,
  // which is exactly the `sensor_id` already carried in stations.json. Parse it
  // and the station is known without anyone choosing it from a list.
  function parseName(fileName) {
    const base = fileName.replace(/\.csv$/i, '');
    const out = { fileName, siteName: '', siteNumber: '', sensorLabel: '', sensorId: null };

    const m = base.match(/^(.*?)_(\d+)_(\d+)_([A-Za-z]+)_(\d+)$/);
    if (m) {
      out.sensorId = `${m[2]}.${m[3]}.${m[4].toUpperCase()}.${m[5]}`;
      let headPart = m[1];
      const m2 = headPart.match(/^(.*)_(\d+)_([^_]+)$/);
      if (m2) { headPart = m2[1]; out.siteNumber = m2[2]; out.sensorLabel = m2[3].replace(/_/g, ' '); }
      out.siteName = headPart.replace(/^aem_/i, '').replace(/_/g, ' ').trim();
    } else {
      out.siteName = base.replace(/^aem_/i, '').replace(/_/g, ' ').trim();
    }
    return out;
  }

  // sensor_id → {station, sensor}, rebuilt whenever a different station file is
  // loaded. 3,174 stations is a linear scan worth doing once, not per import.
  function sensorIndex() {
    if (ad.sensorIdx && ad.sensorIdxFor === state.data) return ad.sensorIdx;
    const idx = new Map();
    for (const s of (state.data?.stations || [])) {
      for (const sen of (s.sensors || [])) {
        if (sen.sensor_id && !idx.has(sen.sensor_id)) idx.set(sen.sensor_id, { station: s, sensor: sen });
      }
    }
    ad.sensorIdx = idx;
    ad.sensorIdxFor = state.data;
    return idx;
  }

  function linkStation(meta) {
    if (!state.data) return { station: null, sensor: null, how: 'no station file loaded' };
    if (meta.sensorId) {
      const hit = sensorIndex().get(meta.sensorId);
      if (hit) return { ...hit, how: 'sensor id' };
    }
    const num = meta.siteNumber || (meta.sensorId || '').split('.')[0];
    if (num) {
      const st = state.data.stations.find(s => String(s.station_number) === String(num)
                                            || String(s.site?.number) === String(num));
      if (st) {
        const sen = (st.sensors || []).find(x => x.sensor_id === meta.sensorId)
                 || (st.sensors || []).find(x => (x.type || '').toLowerCase() === (meta.sensorLabel || '').toLowerCase());
        return { station: st, sensor: sen || null, how: 'station number' };
      }
    }
    return { station: null, sensor: null, how: 'no match' };
  }

  // RainAccum and WaterLevel differ only in how diff() compares two readings, so
  // the guess only has to pick between two rules — and the series list lets it
  // be corrected when the guess is wrong.
  //
  // **The fallback is `RA`, and that made this worse than a coin toss for a
  // whole class of series.** A reading addressed `s:999998/level_1`, carrying
  // `unit: "m"`, on a sensor row typed `Water Level`, came out as RainAccum —
  // because the only two things this function looked at were the sensor row
  // (which the field path failed to resolve, see fieldAddrs) and a label that
  // was empty, so it fell through to the default. The chart then offered a
  // 0.2 mm/tip conversion on a water level.
  //
  // So it now reads every piece of evidence there is, decisive one first:
  //
  //   the unit      A reading that arrived with `m` or `mAHD` is a level and one
  //                 with `mm` is rainfall. This is the device's own statement
  //                 about what it measured, and it beats every inference below.
  //   the words     The sensor's type, its label, and the channel out of the
  //                 address — `level_1` says as much as `Water Level` does.
  //   the fallback  RA, unchanged, and now only reached when there is genuinely
  //                 nothing to go on.
  function guessKind(meta, sensor) {
    const unit = String(meta.unit || '').trim();
    if (/^(m|mAHD|cm|ft)$/i.test(unit)) return 'WL';
    if (/^mm$/i.test(unit)) return 'RA';

    // The channel out of `s:<number>/<channel>`. An ALERT address carries no
    // channel and contributes nothing here, which is correct.
    const chan = String(meta.addr || '').startsWith('s:')
      ? String(meta.addr).slice(2).split('/').slice(1).join('/')
      : '';
    const s = `${sensor?.type || ''} ${meta.sensorLabel || ''} ${chan}`.toLowerCase();
    if (/rain|precip|accum/.test(s)) return 'RA';
    if (/level|height|stage|water|depth/.test(s)) return 'WL';
    return 'RA';
  }

  // ── the 3-5-7 filter ───────────────────────────────────────────────────────
  // Faithful to the spec's two components. Nothing here writes to the imported
  // arrays: the result is a parallel status array plus the rollover-adjusted
  // values, so raw and filtered stay side by side for as long as the import
  // lives.

  function cfgKey(cfg, kind) {
    return [kind, cfg.use357 ? 1 : 0, cfg.small, cfg.medium, cfg.large, cfg.cycle, cfg.breakCount,
            cfg.startTests, cfg.rolloverOn ? 1 : 0, cfg.oosOn ? 1 : 0, cfg.dedupeOn ? 1 : 0,
            cfg.minGapSec, cfg.rateOn ? 1 : 0, cfg.rateMax,
            cfg.fallOn ? 1 : 0, cfg.fallMax,
            cfg.rangeOn ? 1 : 0, cfg.rangeMin, cfg.rangeMax].join('|');
  }

  // A blank limit means "no limit". Parsed here rather than at the input, so a
  // range with only one end filled in still works.
  const bound = x => { const f = parseFloat(x); return isFinite(f) ? f : null; };

  // The 357 walk itself, over the `live` positions of one series against one
  // set of values. Returns a fresh status array; it reads `adj` and writes
  // nothing else, so it can be run twice with different rollover offsets.
  function walk357(live, adj, n, isRA, cfg) {
    const status = new Uint8Array(n);          // AD_UNKNOWN everywhere

    // diff() — "calculate different value of the two data according to data
    // type". `a` is the earlier reading (current), `b` the later one (next).
    // A rain accumulator only ever climbs, so its difference is signed and a
    // fall is a failure by construction; a water level may move either way.
    const diff = (a, b) => isRA ? (adj[live[b]] - adj[live[a]]) : Math.abs(adj[live[b]] - adj[live[a]]);
    const verify = (d, step) => isRA ? (d >= 0 && d <= step) : (d <= step);

    // Cursors walk `live` positions, skipping anything already marked Bad —
    // getPreviousCursor()/getNextCursor() in the spec.
    const prevCur = p => { for (let k = p - 1; k >= 0; k--) if (status[live[k]] !== AD_BAD) return k; return -1; };
    const nextCur = p => { for (let k = p + 1; k < live.length; k++) if (status[live[k]] !== AD_BAD) return k; return -1; };

    const mark   = (p, st) => { status[live[p]] = st; };
    // reject() — everything still Suspect between two positions failed for good.
    const reject = (from, to) => {
      for (let k = Math.max(0, from); k <= Math.min(live.length - 1, to); k++) {
        if (status[live[k]] === AD_SUSPECT) status[live[k]] = AD_BAD;
      }
    };

    const L = live.length;
    // Continuity needs four readings to exist at all. A series shorter than
    // that cannot be tested, and deleting it outright — which is where the
    // algorithm lands if it is allowed to run — would be an answer the data
    // does not support. It is kept, and the panel says it went untested.
    if (L < 4) {
      for (let k = 0; k < L; k++) status[live[k]] = AD_GOOD;
      return status;
    }

    let guard = L * 8 + 1000;    // the walk only ever moves backwards; this is
                                 // belt and braces against a malformed series
    if (L >= 2) {
      let phase = 'start';
      let start = L - 1;                       // Establish Start Continuity begins at the end
      let cur = start - 1;
      let testCount = 0, passCount = 0, lastDiff = 0;
      let lastGood = -1, next = -1, contTest = 0, restart = -1;

      while (guard-- > 0) {
        if (phase === 'start') {
          if (cur < 0) { mark(start, AD_GOOD); break; }
          const step = passCount === 0 ? cfg.small : passCount === 1 ? cfg.medium : cfg.large;
          const d = diff(cur, start);
          // For a rain accumulator the comparison is against a fixed start
          // while `cur` walks backwards, so each difference must be at least
          // the last — the `diffVal >= lastDiffVal` arm of the spec flowchart.
          const ok = verify(d, step) && (!isRA || d >= lastDiff);
          if (ok) {
            mark(cur, AD_GOOD);
            passCount++; lastDiff = d;
            if (passCount > 2) {
              // Four consecutive good readings: the series has begun.
              mark(start, AD_GOOD);
              lastGood = cur; next = lastGood;
              cur = prevCur(cur); testCount = 0; contTest = 0; restart = -1;
              phase = 'cont';
              continue;
            }
            cur = prevCur(cur);
          } else {
            mark(cur, AD_SUSPECT);
            cur = prevCur(cur);
          }
          testCount++;
          if (testCount > cfg.startTests || cur < 0) {
            // The window could not be filled. The start itself is the problem:
            // discard it, step back one, and try to begin the series there.
            mark(start, AD_BAD);
            for (let k = start - 1; k >= 0 && k > start - cfg.startTests - 3; k--) {
              if (status[live[k]] === AD_SUSPECT) status[live[k]] = AD_UNKNOWN;
            }
            start = prevCur(start);
            if (start < 0) break;
            cur = prevCur(start);
            testCount = 0; passCount = 0; lastDiff = 0;
            if (cur < 0) { mark(start, AD_GOOD); break; }
          }
          continue;
        }

        // Establish Continuity.
        if (cur < 0) { reject(0, lastGood); break; }
        const step = testCount === 0 ? cfg.small : testCount === 1 ? cfg.medium : cfg.large;
        const d = next < 0 ? Infinity : diff(cur, next);
        if (next >= 0 && verify(d, step)) {
          // fil357Pass() — the reading stands, and everything left hanging
          // between it and the last good reading is settled as Bad.
          mark(cur, AD_GOOD);
          reject(cur + 1, lastGood - 1);
          lastGood = cur; next = lastGood;
          cur = prevCur(cur);
          testCount = 0; contTest = 0; restart = -1;
        } else if (testCount < 2) {
          // Retest the same reading against the next-next, then next-next-next.
          testCount++;
          const nn = next < 0 ? -1 : nextCur(next);
          next = nn;
        } else {
          mark(cur, AD_SUSPECT);
          if (restart < 0) restart = cur;
          contTest++;
          testCount = 0;
          next = lastGood;
          cur = prevCur(cur);
          if (contTest >= cfg.breakCount) {
            // Four in a row failed: this is not noise, it is a break. The
            // suspects become the opening of a new series rather than casualties
            // of the old one.
            for (let k = Math.max(0, cur + 1); k <= restart; k++) {
              if (status[live[k]] === AD_SUSPECT) status[live[k]] = AD_UNKNOWN;
            }
            start = restart;
            cur = prevCur(start);
            testCount = 0; passCount = 0; lastDiff = 0;
            contTest = 0; restart = -1;
            phase = 'start';
            if (cur < 0) { mark(start, AD_GOOD); break; }
          }
        }
      }
    }

    // Anything still Suspect or never reached failed to earn its place.
    for (let k = 0; k < L; k++) {
      const i = live[k];
      if (status[i] === AD_SUSPECT || status[i] === AD_UNKNOWN) status[i] = AD_BAD;
    }
    return status;
  }

  function runFilter(s, cfg) {
    const key = cfgKey(cfg, s.kind);
    if (s.filt && s.filt.key === key) return s.filt;

    // `v` is ARRO's own "Value" column, filtered exactly as exported. The
    // 3/5/7 steps and the 2048 rollover ceiling below are counts-domain
    // constants from the Bureau's spec — never multiply this by
    // bucketSizeMm() (or anything else per-station) before it reaches
    // walk357(). That would rescale every threshold by the bucket size and
    // the failure mode is silent: a filter that still runs, still looks
    // right, and quietly keeps or drops the wrong readings. Bucket size is a
    // display-time conversion only — see pinHtml()'s Raw row.
    const n = s.n, t = s.t, v = s.v;
    const isRA = s.kind === 'RA';

    // 1. filterOutOfSyncDate() — the list must be strictly ascending. After the
    //    import sort the only offenders left are repeats of a timestamp, which
    //    the sample export is full of (6,111 distinct stamps across 14,942
    //    rows): the same reading re-sent, or re-graded, on a later packet.
    //    `minGapSec` widens that from "same second" to "same observation".
    //    ARRO re-sends a reading several times — the sample export carries the
    //    same value at :12, :13, :14 and :18 past the minute — and four
    //    re-sends of one corrupt packet are enough to satisfy the spec's "any
    //    four consecutive data form a continuous set" and survive as a series
    //    of their own. Off by default, because collapsing them is a departure
    //    from the spec rather than part of it.
    const gapMs = Math.max(0, +cfg.minGapSec || 0) * 1000;
    const oosFlag = new Uint8Array(n);
    const cutFlag = new Uint8Array(n);      // AD_RANGE / AD_RATE, or 0
    let live = [];
    let lastT = -Infinity;
    for (let i = 0; i < n; i++) {
      const tooClose = gapMs ? (t[i] - lastT < gapMs) : (t[i] <= lastT);
      if (tooClose && (cfg.oosOn || cfg.dedupeOn)) { oosFlag[i] = 1; continue; }
      lastT = t[i];
      live.push(i);
    }

    // 1a. Limits. Neither of these is in the Bureau's spec: they are gates on
    //     what a sensor can physically report, and they run *before* the 357
    //     walk so that a reading nothing could have produced never gets a vote
    //     on continuity. A single 2014 mm packet is enough to be tested against
    //     — and to drag three neighbours down with it — long before the walk
    //     decides it is noise.
    if (cfg.rangeOn) {
      const lo = bound(cfg.rangeMin), hi = bound(cfg.rangeMax);
      if (lo !== null || hi !== null) {
        live = live.filter(i => {
          if ((lo !== null && v[i] < lo) || (hi !== null && v[i] > hi)) { cutFlag[i] = AD_RANGE; return false; }
          return true;
        });
      }
    }

    // 1b. Rate of rise: is the *step* between two readings one this sensor could
    //     have made? Each reading is compared with the one before it in the
    //     list, and the comparison holds whether or not that neighbour was
    //     itself rejected. Anchoring to the last *surviving* reading instead is
    //     the obvious-looking alternative and it is a trap: a gauge that
    //     genuinely steps up and stays there is then measured against a value
    //     it will never return to, and the whole record after the step is lost.
    //
    //     So this filter only ever claims the step. A corrupt plateau costs its
    //     first reading here and the rest is the 357 walk's business — which is
    //     the right division of labour, because breaking and re-establishing
    //     continuity is exactly what that walk is for.
    //
    //     **The two directions are two filters (#191), not one with a sign.**
    //     Up and down are different questions with different answers at the
    //     same site: a water level rises with the catchment and falls with the
    //     channel draining, and the fastest credible figure for one is
    //     routinely not the figure for the other. Until this they were one
    //     control — `Math.abs` on a water level, so a fall was judged against
    //     the *rise* threshold with no way to say otherwise, and `d` on an
    //     accumulator, so a fall was never judged at all. So: Rate of rise
    //     tests moves upward against rateMax, Rate of fall tests moves downward
    //     against fallMax, each with its own switch, and a reading rejected by
    //     either says which. A level with a single dropout still costs two
    //     readings with both on — the fall into it and the climb back out — but
    //     it is now two named verdicts rather than one.
    //
    //     An accumulator's falls are left alone by default and should usually
    //     stay that way: it cannot fall except by wrapping or by corruption,
    //     and both of those already have an owner further down. The switch is
    //     offered anyway, because "usually" is not "never" and the operator can
    //     see what it removes.
    if ((cfg.rateOn && +cfg.rateMax > 0) || (cfg.fallOn && +cfg.fallMax > 0)) {
      const up   = cfg.rateOn && +cfg.rateMax > 0 ? +cfg.rateMax : null;
      const down = cfg.fallOn && +cfg.fallMax > 0 ? +cfg.fallMax : null;
      const kept = [];
      for (let k = 0; k < live.length; k++) {
        const i = live[k];
        if (k > 0) {
          const p = live[k - 1];
          const hrs = (t[i] - t[p]) / 3600000;
          const d = v[i] - v[p];
          if (hrs > 0) {
            if (d > 0 && up   !== null && d / hrs > up)    { cutFlag[i] = AD_RATE; continue; }
            if (d < 0 && down !== null && -d / hrs > down) { cutFlag[i] = AD_FALL; continue; }
          }
        }
        kept.push(i);
      }
      live = kept;
    }

    // 2. The walk, then adjustRolloverData(), then the walk again.
    //
    //    Order matters more than the spec lets on. A rain accumulator that
    //    wraps and a rain accumulator hit by a corrupt packet both look like a
    //    long fall, and the sample export is full of the second kind: 72 mm
    //    jumps to 1234 for one reading and drops straight back. Detecting
    //    rollovers on the raw series reads all 82 of those spikes as wraps and
    //    shifts every later reading by 2048 apiece.
    //
    //    So the spikes go first. The 357 walk removes them without any rollover
    //    help — a wrap simply breaks continuity, which is the spec's own
    //    behaviour — and only then is a fall between two *surviving* readings
    //    trustworthy enough to call a rollover. With the offsets known, the
    //    walk runs once more so continuity carries across the wrap and the
    //    output is a single climbing accumulation rather than two series.
    const adj = new Float64Array(n);
    for (let i = 0; i < n; i++) adj[i] = v[i];

    // With the 357 test switched off the pre-filters still run and nothing is
    // tested for continuity, so everything they left standing is kept.
    const walk = () => {
      if (cfg.use357) return walk357(live, adj, n, isRA, cfg);
      const st = new Uint8Array(n);
      for (const i of live) st[i] = AD_GOOD;
      return st;
    };

    let status = walk();
    const rolls = [];

    if (cfg.rolloverOn) {
      // What makes a fall a rollover is not its size but what it leaves behind:
      // wrap the counter once and the step across the seam should be an
      // ordinary one. So the test is the 357 test itself, applied to the
      // wrapped difference — 2045 → 2 is a rollover because it is really a
      // step of 5, while 1976 → 125 is not, because it would be a step of 197.
      // Size alone cannot tell the two apart: a corrupt packet reading 1976
      // sits just as close to the ceiling as a genuine wrap does.
      const kept = live.filter(i => status[i] === AD_GOOD);
      for (let k = 1; k < kept.length; k++) {
        const prev = v[kept[k - 1]], now = v[kept[k]];
        if (now >= prev) continue;
        const wrapped = now + cfg.cycle - prev;
        if (wrapped >= 0 && wrapped <= cfg.large) rolls.push(kept[k]);
      }
      if (rolls.length) {
        // Re-lay the offsets over every reading, so a point removed inside a
        // wrapped stretch still reports a sensible adjusted value when it is
        // inspected. Repeats keep their raw value: they were never part of the
        // sequence the offsets were counted along.
        const rollSet = new Set(rolls);
        let offset = 0;
        for (let i = 0; i < n; i++) {
          if (oosFlag[i]) { adj[i] = v[i]; continue; }
          if (rollSet.has(i)) offset += cfg.cycle;
          adj[i] = v[i] + offset;
        }
        status = walk();
      }
    }

    // The pre-filter verdicts go on last so they survive the walk, which knows
    // nothing about them — it was only ever handed what they left behind.
    for (let i = 0; i < n; i++) {
      if (oosFlag[i]) status[i] = AD_OOS;
      else if (cutFlag[i]) status[i] = cutFlag[i];
    }

    let good = 0, bad = 0, oos = 0, range = 0, rate = 0, fall = 0;
    for (let i = 0; i < n; i++) {
      const st = status[i];
      if (st === AD_GOOD)       good++;
      else if (st === AD_OOS)   oos++;
      else if (st === AD_RANGE) range++;
      else if (st === AD_RATE)  rate++;
      else if (st === AD_FALL)  fall++;
      else bad++;
    }

    s.filt = { key, status, adj, rolls,
               stats: { good, bad, oos, range, rate, fall, rollovers: rolls.length, total: n } };
    return s.filt;
  }

  // ── tracks: what actually gets drawn ───────────────────────────────────────
  // One import feeds two curves — everything as recorded, and what survived the
  // filter — and three readings of each: the accumulator itself, the step
  // between readings, and that step as a rate. Building them once per change
  // and caching keeps the draw path down to arithmetic on typed arrays.

  function trackKey(s, cfg) {
    return `${cfgKey(cfg, s.kind)}|${ad.transform}`;
  }

  function buildTrack(s, idx, vals) {
    const m = idx.length;
    const t = new Float64Array(m), y = new Float64Array(m);
    const ref = new Int32Array(m);
    for (let k = 0; k < m; k++) { ref[k] = idx[k]; t[k] = s.t[idx[k]]; y[k] = vals[idx[k]]; }

    if (ad.transform !== 'value') {
      const d = new Float64Array(m);
      for (let k = 1; k < m; k++) {
        const step = y[k] - y[k - 1];
        if (ad.transform === 'rate') {
          const hrs = (t[k] - t[k - 1]) / 3600000;
          d[k] = hrs > 0 ? step / hrs : 0;
        } else d[k] = step;
      }
      d[0] = 0;
      return { n: m, t, y: d, ref };
    }
    return { n: m, t, y, ref };
  }

  function tracks(s) {
    const key = trackKey(s, ad.cfg);
    if (s.tracks && s.tracks.key === key) return s.tracks;
    const f = runFilter(s, ad.cfg);
    const all = new Int32Array(s.n);
    for (let i = 0; i < s.n; i++) all[i] = i;
    const kept = [];
    for (let i = 0; i < s.n; i++) if (f.status[i] === AD_GOOD) kept.push(i);
    s.tracks = { key, raw: buildTrack(s, all, s.v), filt: buildTrack(s, kept, f.adj), f };
    return s.tracks;
  }

  const shown = () => ad.series.filter(s => s.visible);

  function extent() {
    let t0 = Infinity, t1 = -Infinity;
    for (const s of ad.series) {
      if (!s.n) continue;
      if (s.t[0] < t0) t0 = s.t[0];
      if (s.t[s.n - 1] > t1) t1 = s.t[s.n - 1];
    }
    if (!isFinite(t0)) return null;
    if (t1 <= t0) t1 = t0 + 3600000;
    return { t0, t1 };
  }

  // extent()'s other axis (#191): the whole value range in the record, which is
  // what the vertical navigator draws its track against. Deliberately the whole
  // record rather than the visible window — the navigator's job is to say where
  // the window sits inside everything there is, and a track that rescaled every
  // time the window moved could not say that. Same layer choice as drawOv, so
  // the two navigators are describing the same curve.
  function vExtent() {
    let lo = Infinity, hi = -Infinity;
    for (const s of shown()) {
      const track = tracks(s)[ad.mode === 'raw' ? 'raw' : 'filt'];
      for (let k = 0; k < track.n; k++) {
        const y = track.y[k];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    if (!isFinite(lo)) return null;
    if (hi <= lo) hi = lo + 1;
    // A hair of headroom, so a record whose maximum is also the window's
    // maximum still draws an edge handle inside the track rather than on its
    // rim where nothing can grab it.
    const pad = (hi - lo) * 0.02;
    return { lo: lo - pad, hi: hi + pad };
  }

  function view() {
    const ex = extent();
    if (!ex) return null;
    if (!ad.view) return ex;
    const t0 = Math.max(ex.t0 - (ex.t1 - ex.t0), ad.view.t0);
    const t1 = Math.min(ex.t1 + (ex.t1 - ex.t0), ad.view.t1);
    return t1 - t0 < 1000 ? { t0, t1: t0 + 1000 } : { t0, t1 };
  }

  // first index with t >= target
  function lower(arr, n, target) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < target) lo = m + 1; else hi = m; }
    return lo;
  }

  // Which curves are live given the raw/filtered/both switch.
  function layers(s) {
    const tr = tracks(s);
    if (ad.mode === 'raw')      return [{ track: tr.raw,  kind: 'raw' }];
    if (ad.mode === 'filtered') return [{ track: tr.filt, kind: 'filt' }];
    return [{ track: tr.raw, kind: 'raw' }, { track: tr.filt, kind: 'filt' }];
  }

  // ── Two vertical axes (#191) ────────────────────────────────────────────────
  // A series is drawn against the left axis unless it has been put on the
  // right, and `axisOf` is the only place that question is asked. The right
  // axis exists for the case this tab hits constantly and had no answer for:
  // a rain accumulator in millimetres and a water level in metres, over the
  // same storm, on the same chart. Sharing one scale, either the rainfall is a
  // flat line at the bottom or the level is — and the operator's actual
  // question is about their *shapes* against each other.
  //
  // A right-hand series with nothing on it is not a right axis: `sideOf`
  // reports what is actually drawn, so a chart where every visible series has
  // been sent right simply draws them on the left and keeps its one axis,
  // rather than leaving an empty scale in the left margin.
  const axisOf = s => (s.axis === 'right' ? 'right' : 'left');
  function axisSides() {
    const vis = shown();
    const right = vis.filter(s => axisOf(s) === 'right');
    // Everything on the right and nothing on the left: draw it on the left.
    if (right.length && right.length === vis.length) return { left: vis, right: [] };
    return { left: vis.filter(s => axisOf(s) === 'left'), right };
  }

  // `side` is 'left', 'right', or omitted for every visible series at once —
  // which is what everything reading a single range still wants: the overview
  // strip, the vertical navigator, the comparison panes and the stats line are
  // all describing the record rather than one of its axes.
  function yRange(v, side) {
    const list = side ? axisSides()[side] : shown();
    let lo = Infinity, hi = -Infinity;
    for (const s of list) {
      // "Kept" scales to the surviving readings alone. A single corrupt packet
      // reading 2014 mm against a gauge sitting at 300 flattens the real trace
      // into the bottom eighth of the chart, and the removals are still drawn —
      // they simply run off the top, which is a fair description of them.
      const ls = ad.yMode === 'kept' ? [{ track: tracks(s).filt, kind: 'filt' }] : layers(s);
      for (const { track } of ls) {
        const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
        const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
        for (let k = i0; k < i1; k++) {
          const y = track.y[k];
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
    }
    if (!isFinite(lo)) return { lo: 0, hi: 1 };
    // Fixed, and the vertical navigator that speaks through it, govern the
    // **left** axis only. Two typed ranges and two navigators would be a second
    // set of controls for a second axis that exists to be glanced at beside the
    // first; the right axis auto-fits its own series, and the toolbar says so
    // when there is one. Everything else — Auto, Kept, Zero — applies to both,
    // because those are rules rather than figures and both axes can obey them.
    if (ad.yMode === 'manual' && side !== 'right') {
      const a = parseFloat(ad.yMin), b = parseFloat(ad.yMax);
      if (!isNaN(a) && !isNaN(b) && b > a) return { lo: a, hi: b };
    }
    if (ad.yMode === 'zero' && lo > 0) lo = 0;
    if (hi === lo) { hi = lo + 1; lo -= 1; }
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }

  // The unit printed against one axis: the shared one if every series on that
  // side agrees, and nothing if they do not — an axis labelled "mm" with a
  // series in metres drawn against it is worse than an unlabelled one.
  function axisUnit(list) {
    const units = [...new Set(list.map(s => s.unit || '').filter(Boolean))];
    return units.length === 1 ? units[0] : '';
  }

  // ── axes ──

  const TIME_STEPS = [1e3, 5e3, 15e3, 30e3, 6e4, 3e5, 9e5, 18e5, 36e5, 108e5, 216e5, 432e5,
                      AD_DAY, 2 * AD_DAY, 7 * AD_DAY, 14 * AD_DAY, 30 * AD_DAY, 91 * AD_DAY,
                      182 * AD_DAY, 365 * AD_DAY];

  function timeTicks(t0, t1, want) {
    const span = t1 - t0;
    let step = TIME_STEPS[TIME_STEPS.length - 1];
    for (const s of TIME_STEPS) if (span / s <= want) { step = s; break; }
    const out = [];
    if (step >= 30 * AD_DAY) {
      // Month-aligned, so a long window labels the first of the month rather
      // than an arbitrary 30-day drift.
      const months = Math.max(1, Math.round(step / (30 * AD_DAY)));
      const d = new Date(t0);
      let y = d.getFullYear(), m = d.getMonth();
      for (let i = 0; i < 400; i++) {
        const tt = new Date(y, m, 1).getTime();
        if (tt > t1) break;
        if (tt >= t0) out.push(tt);
        m += months; while (m > 11) { m -= 12; y++; }
      }
    } else {
      const first = Math.ceil(t0 / step) * step;
      for (let tt = first; tt <= t1 && out.length < 400; tt += step) out.push(tt);
    }
    return { ticks: out, step };
  }

  const P2 = n => String(n).padStart(2, '0');

  function fmtTick(t, step) {
    const d = new Date(t);
    if (step < 6e4)          return `${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}`;
    if (step < 36e5)         return `${P2(d.getHours())}:${P2(d.getMinutes())}`;
    if (step < AD_DAY)       return `${d.getDate()}/${d.getMonth() + 1} ${P2(d.getHours())}:${P2(d.getMinutes())}`;
    if (step < 30 * AD_DAY)  return `${d.getDate()}/${d.getMonth() + 1}`;
    if (step < 365 * AD_DAY) return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    return String(d.getFullYear());
  }

  function fmtFull(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${P2(d.getMonth() + 1)}-${P2(d.getDate())} `
         + `${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}`;
  }

  function niceTicks(lo, hi, want) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / want;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi && out.length < 40; v += step) out.push(v);
    return out;
  }

  function fmtVal(v) {
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10)   return v.toFixed(1);
    if (a >= 1)    return v.toFixed(2);
    return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  // ── downsampling ───────────────────────────────────────────────────────────
  // Hundreds of thousands of readings cannot each become an SVG coordinate, and
  // averaging them away would hide exactly what this tool exists to find. So
  // each pixel column keeps its first, min, max and last value: the spike that
  // the filter is hunting survives at any zoom level, and the point count stops
  // growing with the data.

  function densify(track, i0, i1, x, xw) {
    const m = i1 - i0;
    const pts = [];
    if (m <= 0) return pts;
    if (m <= xw * 2) {
      for (let k = i0; k < i1; k++) pts.push([x(track.t[k]), track.y[k], k]);
      return pts;
    }
    let col = -1, first = 0, last = 0, min = 0, max = 0, fk = 0, mnk = 0, mxk = 0, lk = 0;
    const flush = () => {
      if (col < 0) return;
      pts.push([col, first, fk]);
      if (min !== first) pts.push([col, min, mnk]);
      if (max !== min)   pts.push([col, max, mxk]);
      if (last !== max)  pts.push([col, last, lk]);
    };
    for (let k = i0; k < i1; k++) {
      const px = Math.round(x(track.t[k]));
      const y = track.y[k];
      if (px !== col) { flush(); col = px; first = min = max = last = y; fk = mnk = mxk = lk = k; }
      else {
        if (y < min) { min = y; mnk = k; }
        if (y > max) { max = y; mxk = k; }
        last = y; lk = k;
      }
    }
    flush();
    return pts;
  }

  // Which readings have a silence immediately after them, accumulated along the
  // series, so that "was the record quiet anywhere between these two points?" is
  // one subtraction. Depends only on the timestamps and the series' own gap
  // threshold, neither of which changes after it is loaded, so it is computed
  // once and never invalidated by a config change.
  function gapCum(s) {
    if (s._gapCum) return s._gapCum;
    const c = new Int32Array(s.n);
    let run = 0;
    for (let i = 1; i < s.n; i++) {
      if (s.t[i] - s.t[i - 1] > s.gapMs) run++;
      c[i] = run;
    }
    s._gapCum = c;
    return c;
  }

  // `track` and `s` are the gap rule, and both are optional: without them this
  // joins every point to the next, which is what an ARRO import wants and
  // exactly what it did before the Field tab existed (s.gapMs is 0 there, so
  // passing the series changes nothing).
  //
  // With them, the pen lifts wherever the *record* went quiet for longer than
  // the series' own reporting interval. Missing data is the normal condition of
  // a radio telemetry network, and a line ruled across six hours of nothing is
  // the chart inventing readings — the one thing this tab exists to catch other
  // systems doing.
  //
  // The question is asked of the record rather than of the track being drawn,
  // and that distinction is the whole subtlety. The filtered track has a hole
  // wherever the 357 test removed a reading, and a hole there means "we do not
  // believe these readings", not "nothing arrived" — conflating the two would be
  // this tab telling exactly the kind of lie it exists to find. So a break is
  // drawn only when the underlying series really was silent in between, which is
  // what gapCum() answers.
  function pathFrom(pts, y, step, track, s) {
    if (!pts.length) return '';
    const cum = (s && s.gapMs && track && track.ref) ? gapCum(s) : null;
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i][0].toFixed(1), py = y(pts[i][1]).toFixed(1);
      let broke = false;
      if (i > 0 && cum) {
        // densify() emits up to four points per pixel column and not in track
        // order within one, so only a step that actually advances is asked.
        const a = track.ref[pts[i - 1][2]], b = track.ref[pts[i][2]];
        broke = b > a && cum[b] > cum[a];
      }
      if (i === 0 || broke) d += `M${px} ${py}`;
      else if (step) d += `H${px}V${py}`;
      else d += `L${px} ${py}`;
    }
    return d;
  }

  // ── import ─────────────────────────────────────────────────────────────────

  function importFiles(files) {
    const list = [...(files || [])].filter(f => /\.csv$/i.test(f.name));
    if (!list.length) { note('Nothing to import — ARRO exports are .csv files.', true); return; }
    ad.busy += list.length;
    renderSide();
    let done = 0;
    const problems = [];
    for (const file of list) {
      const reader = new FileReader();
      reader.onload = e => {
        try { addSeries(file.name, String(e.target.result), problems); }
        catch (err) { problems.push(`${file.name}: ${err.message}`); }
        finally { if (++done === list.length) finish(); }
      };
      reader.onerror = () => { problems.push(`${file.name}: could not be read.`); if (++done === list.length) finish(); };
      reader.readAsText(file);
    }
    function finish() {
      ad.busy = Math.max(0, ad.busy - list.length);
      ad.view = null;
      renderAll();
      note(problems.length ? problems.join(' ') : `Imported ${list.length} file${list.length === 1 ? '' : 's'}.`, !!problems.length);
    }
  }

  // ── Demo data (#191) ───────────────────────────────────────────────────────
  // One real ARRO export, committed to the repo, one click from the drop zone.
  //
  // It is the *same* export every comment in this file argues from — 14,942
  // rows of Durikai's rain accumulator over seven months, the one with 6,111
  // distinct timestamps behind those rows, the 395 values ARRO wrote with a
  // thousands separator in an unquoted CSV field, and the 82 single-reading
  // spikes to 1234 that read as rollovers unless the 357 walk removes them
  // first. Nothing about it was cleaned: it is here because it is messy, and
  // because every claim runFilter() makes about what it is defending against
  // can be checked against the file that taught it.
  //
  // It arrives through addSeries() under its real filename, so parseName picks
  // 541134.0.R.5758 out of it and linkStation finds Durikai in the station file
  // exactly as it would for a file dropped from a desktop. There is no demo
  // code path in the chart — the demo is a file, and everything downstream of
  // it is the ordinary one.
  const AD_DEMO_FILE = 'aem_Durikai_AL_541134_Rainfall_541134_0_R_5758.csv';
  const AD_DEMO_URL  = `data/demo/${AD_DEMO_FILE}`;

  async function loadDemo() {
    if (ad.busy) return;
    // Already loaded is a no-op with an explanation rather than a second copy:
    // two identical series on one chart is a puzzle, not a demonstration.
    if (ad.series.some(x => x.fileName === AD_DEMO_FILE)) {
      note('The demo series is already loaded — it is in the list below.');
      return;
    }
    const inst = ad;
    inst.busy++;
    renderSide();
    const problems = [];
    try {
      const res = await fetch(AD_DEMO_URL, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // The tab may have been switched while the file was in flight, and a
      // series belongs to the instance that asked for it — see the note on
      // `ad` above.
      const was = ad;
      ad = inst;
      try { addSeries(AD_DEMO_FILE, text, problems); } finally { ad = was; }
    } catch (err) {
      problems.push(`Demo data: ${err && err.message || err}.`);
    } finally {
      inst.busy = Math.max(0, inst.busy - 1);
    }
    if (ad !== inst) return;            // it landed in a tab nobody is looking at
    ad.view = null;
    renderAll();
    note(problems.length ? problems.join(' ')
         : 'Demo data loaded — Durikai rainfall, 14,942 readings over seven months, '
         + 'exactly as ARRO exported them. Nothing was uploaded.',
         !!problems.length);
  }

  // The other half of the boundary. Series data plus who it is, into the active
  // instance's list — every default the chart, the filter and the export happen
  // to read lives here, so adding a source is a query and a label rather than a
  // checklist of fields to remember.
  function adoptSeries(data, ident) {
    const s = {
      key:      `ad${++ad.seq}`,
      // Stamped from the instance, not passed in: a series cannot claim to be
      // from a source other than the tab that loaded it.
      source:   ad.source,
      fileName: ident.fileName || '',
      meta:     ident.meta || {},
      label:    ident.label || 'Series',
      station:  ident.station || null,
      sensor:   ident.sensor || null,
      linkHow:  ident.linkHow || '',
      sensorId: ident.sensorId || null,
      kind:     ident.kind || 'RA',
      unit:     data.unit,
      // Which of the twelve slots this series has, and whether the operator has
      // taken it over. `color` is the resolved literal the SVG carries; `slot`
      // is what re-resolves it when the theme moves, and `colorSet` is what
      // stops that happening to a colour somebody chose.
      slot:     ad.series.length % AD_SERIES_TOKENS.length,
      colorSet: false,
      color:    slotColor(ad.series.length % AD_SERIES_TOKENS.length),
      // How this trace is drawn, and which scale against (#191). All three are
      // the operator's to set and all three default to the rule that was here
      // before: the dash from the slot, the axis on the left.
      dash:     'auto',        // auto | solid | dash | dot | dashdot | long
      axis:     'left',        // left | right
      visible:  true,
      // The longest silence the chart will draw a line across. Zero is off,
      // which is what every ARRO import gets: a CSV arrives whole, so a hole in
      // one is the record's own business rather than an artefact of a window
      // somebody asked for. Field data is the other case entirely — see #114.
      gapMs:    ident.gapMs || 0,
      // Where these numbers came from, in the words the chart header and the
      // export both print. Null on ARRO, where the tab is the answer.
      prov:     ident.prov || null,
      // Display-only conversion carried alongside the counts the filter runs on
      // (engineering value, its unit, and the rule that produced it).
      eng:      ident.eng || null,
      engUnit:  ident.engUnit || '',
      n: data.n, t: data.t, tr: data.tr, v: data.v, raw: data.raw, hasRaw: data.hasRaw,
      q: data.q, qcodes: data.qcodes,
      extra:    data.extra || {},
      warn:     data.warn, wasDescending: data.desc,
      bytesPerRow: ident.bytesPerRow || 0,
      filt: null, tracks: null,
    };
    ad.series.push(s);
    return s;
  }

  function addSeries(fileName, text, problems) {
    const parsed = parseCsv(text);
    if (parsed.error) { problems.push(`${fileName}: ${parsed.error}`); return; }
    const meta = parseName(fileName);
    const link = linkStation(meta);
    const sensor = link.sensor;
    const label = [link.station?.name || meta.siteName || fileName,
                   sensor?.type || meta.sensorLabel].filter(Boolean).join(' · ');

    adoptSeries(parsed, {
      fileName, meta, label,
      station:  link.station, sensor, linkHow: link.how,
      sensorId: meta.sensorId || sensor?.sensor_id || null,
      kind:     guessKind(meta, sensor),
    });
  }

  // ── Field Data — the second entrance (#114) ──────────────────────────────────
  // Everything below produces a series and hands it to adoptSeries(). Not one
  // line of it draws anything: the chart, the 357 filter, the inspector and the
  // image export are the ARRO tab's, unmodified, and that is the whole point of
  // the exercise.
  //
  // Four things this source has to think about that a CSV import never did:
  //
  //   **The window is a request, not a file.** ARRO exports arrive whole. Here
  //   the operator asks for the last 7 days and we go and get it, which means
  //   choosing between the raw readings and #B4's rollups — and *saying which*,
  //   loudly, because a chart that quietly swapped raw counts for hourly means
  //   would flatten exactly the spikes this app exists to find. The rollups are
  //   read at `raw_last`, the counter's reading at the end of the bucket, so an
  //   accumulator still reads as an accumulator and the 357 walk still means
  //   something; the min and max inside each bucket are kept and shown in the
  //   inspector and the export rather than thrown away.
  //
  //   **Counts, not millimetres.** The 3/5/7 thresholds are count thresholds, so
  //   `v` is whatever the device transmitted and the filter runs on that. Any
  //   conversion the datastore recorded rides alongside in `eng` and is display
  //   only — see rawBucketNote() for the same rule on the ARRO side.
  //
  //   **Gaps are the interesting part.** Missing data is the normal condition of
  //   a radio telemetry network, so the line lifts rather than ruling across a
  //   silence. See gapMs on the series and pathFrom().
  //
  //   **A reading usually arrives more than once.** dup_count and dup_paths are
  //   a live diagnostic about repeater health that no other tab can show, so
  //   they come down with the readings and are surfaced per point.

  // Which table answers a window of this size. Stated as constants rather than
  // buried in the query because the chart header has to print the answer.
  const AD_RAW_MAX_DAYS    = 14;
  const AD_HOURLY_MAX_DAYS = 180;

  // Per query, across all addresses. A guard against an operator asking for a
  // year of raw 1-minute data and getting a browser tab that never comes back;
  // when it bites, the series says so rather than quietly showing a prefix.
  const AD_FIELD_ROW_CAP = 120000;

  // PostgREST pages. Supabase caps rows per response and the cap is a server
  // setting we do not control, so this pages until a request comes back short
  // rather than trusting any particular number.
  const AD_FIELD_PAGE = 10000;

  const AD_FIELD_WINDOWS = [
    ['24h',  'Last 24 hours',  1],
    ['7d',   'Last 7 days',    7],
    ['30d',  'Last 30 days',   30],
    ['90d',  'Last 90 days',   90],
    ['12mo', 'Last 12 months', 365],
  ];

  const AD_RES_LABEL = {
    raw:    'raw readings',
    hourly: 'hourly buckets',
    daily:  'daily buckets',
  };

  function newFieldQuery() {
    return {
      stationId: '',
      find:      '',        // the station search box
      sensors:   [],        // addresses ticked, as meganet.reading stores them
      extra:     '',        // an address typed in by hand
      win:       '7d',
      from:      '', to: '',   // custom window, yyyy-mm-dd
      res:       'auto',
      loading:   false,
      error:     '',
      empty:     '',
      seq:       0,         // in-flight query id; a late reply for an old one is dropped
      probe:     newFieldProbe(),   // what the datastore says it holds — see fieldProbe()
    };
  }

  // ── What the datastore actually holds ────────────────────────────────────────
  // Everything above this line asks stations.json what a station *should* be
  // reporting. This asks meganet.reading what it *has*, and the two disagree
  // constantly: 244 of the 706 addresses in the datastore today have no
  // station_id resolved at all, and the readings that prove the whole ingest
  // path works arrive under an address no registry entry could have predicted.
  //
  // 18 Bateson is the case that made this necessary and is worth stating in
  // full, because it is not an edge case so much as the shape of the problem.
  // The surveyed station `18_bateson` is document-managed: no station number,
  // no ALERT ids, no sensor rows — so fieldAddrs() returns nothing, the picker
  // says "No ALERT addresses recorded for this station", and an operator is
  // left with a text box and no idea what to type into it. Meanwhile four
  // channels report every five minutes into meganet.reading under
  // `s:999998/rain`, `/level_1`, `/level_2` and `/battery`, filed against a
  // *second* station row (`bateson_test`) that db/migrations/0026 created
  // deliberately so that workshop rain could never be read as gauged rainfall.
  // Both halves of that are right. What was missing was any way to get from
  // one to the other without reading the migration.
  //
  // So: ask. The probe is a search over the four things a reading carries its
  // identity as — station_id, channel, station_number, alert_id — and it
  // reports distinct addresses with what it saw on each. Its answers are
  // tickable exactly like a registry sensor, because to the query that follows
  // they are the same thing: an address and a window.
  //
  // It is a *search*, not a resolution. An address it finds under another
  // station id is labelled with that station id, here and again on the series
  // it produces, and the widened search below says out loud that it widened.
  function newFieldProbe() {
    return {
      term:    '',       // what was searched for; '' means "the station picked above"
      asked:   false,    // has the datastore been asked at all this session
      loading: false,
      error:   '',
      rows:    [],       // [{addr, stationId, unit, n, first, last}], newest first
      scanned: 0,        // readings read to produce them
      capped:  false,    // ...and whether that hit the cap
      widened: '',       // the word a station poll fell back to, when it did
      seq:     0,
    };
  }

  // Readings read per probe. The whole table is 17,783 rows today and this is
  // deliberately larger than that: the question is "what exists", and an answer
  // assembled from a recent slice would report a sensor that stopped six weeks
  // ago as absent — which is the one thing an operator asking this question is
  // most likely to be chasing. When it does bite, the block says so rather
  // than quietly showing a prefix, the same rule AD_FIELD_ROW_CAP follows.
  const AD_PROBE_PAGE     = 10000;
  const AD_PROBE_ROW_CAP  = 40000;
  const AD_PROBE_ADDR_CAP = 60;     // addresses listed before it asks for a narrower search
  const AD_PROBE_SELECT   = 'addr,station_id,unit,reading_ts';

  const fq = () => (ad.fq || (ad.fq = newFieldQuery()));

  function fieldStation() {
    const id = fq().stationId;
    return id ? (state.data?.stations || []).find(s => s.id === id) || null : null;
  }

  // A station's addresses, in the shape meganet.reading stores them. A radio
  // sensor *is* its ALERT address, so one address is one measurement and the
  // duplicate rows in stations.json (Rainfall and Rainfall Increment share
  // 6128) collapse to one entry. A satellite or cellular station has no ALERT
  // address at all — it reports under its station number with a channel name
  // nobody has told this app, so those are offered as unavailable rather than
  // guessed at, and the box underneath takes one typed in.
  // The channel a sensor reports under, or null if it does not report by
  // channel. `meganet.ingest()` builds an address one of two ways — `a:<alert>`
  // for a radio sensor and `s:<station number>/<channel>` for a station that has
  // no ALERT address — and this is the second one (docs/ingest-http.md,
  // *Payload shape*).
  //
  // **The test is a shape test, and that is worth being honest about.** A
  // sensor reports by channel when it has no `alert_id` and its `sensor_id`
  // carries no dot. Every ARRO-sourced sensor id is dotted — `<site>.<n>.<L>`,
  // with the ALERT address appended when there is one — and a `channel` is a
  // plain token the device chooses, so the dot separates them: of the 931
  // sensors with no alert_id today, 927 are dotted ARRO ids and 4 are the
  // channels on `bateson_test`. It would misfile a channel somebody named
  // `air.temp`, and the fix if that ever happens is to ask `meganet.reading`
  // which addresses a station has actually reported on rather than inferring it
  // from the registry — a query this tab does not make today.
  //
  // Nothing about *correctness* rests on this: it decides what the picker
  // offers. A series is resolved to its sensor by matching the channel in the
  // address against `sensor_id`, which is an exact match either way.
  function fieldChannelId(sen) {
    if (!sen || sen.alert_id) return null;
    const id = String(sen.sensor_id || '');
    return (id && !id.includes('.')) ? id : null;
  }

  function fieldAddrs(st) {
    const out = [], seen = new Set();
    const num = String(st?.station_number || '');
    for (const sen of (st?.sensors || [])) {
      // A radio sensor: the ALERT address is the whole identity.
      // A channel sensor: the station number names the site and the channel
      // names which of its sensors spoke, so both halves are needed and a
      // station with no number cannot be addressed this way at all.
      const chan = fieldChannelId(sen);
      const addr = sen.alert_id ? `a:${sen.alert_id}`
                 : (chan && num) ? `s:${num}/${chan}`
                 : null;
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      out.push({ addr, sensor: sen, label: sen.type || addr });
    }
    return out;
  }

  // The sensors that still cannot be addressed: no ALERT address, and no
  // channel to report under either. 927 of them today, all ARRO rows whose
  // address was never resolved.
  function fieldNoAddr(st) {
    const num = String(st?.station_number || '');
    return (st?.sensors || [])
      .filter(sen => !sen.alert_id && !(fieldChannelId(sen) && num))
      .map(sen => sen.type || 'sensor');
  }

  // The filter that finds a term. Four columns, because a reading carries its
  // identity in four places and an operator typing "bateson", "rain", "999998"
  // or "8101" means a different one each time.
  //
  // Deliberately not a search over `addr` itself. `addr` is generated — it is
  // `a:<alert_id>` or `s:<number>/<channel>` — so every one of its parts is
  // already covered by a column here, and searching the composite would drag
  // PostgREST's filter punctuation (`:` `/` `.` `,`) through a URL for no new
  // matches. The term is stripped to what those columns can hold instead, which
  // is why an address typed in whole belongs in the "Or an address" box above
  // rather than here.
  function fieldProbeFilter(term) {
    const safe = String(term).replace(/[^A-Za-z0-9_\- ]+/g, ' ').trim();
    if (!safe) return '';
    const like = `*${encodeURIComponent(safe)}*`;
    const parts = [
      `station_id.ilike.${like}`,
      `channel.ilike.${like}`,
      `station_number.ilike.${like}`,
    ];
    // alert_id is an integer column: ilike would be a type error, and an
    // operator who types 8101 means that address rather than a substring of it.
    if (/^\d+$/.test(safe)) parts.push(`alert_id.eq.${safe}`);
    return `or=(${parts.join(',')})`;
  }

  // The word to search for when a station's own id turns up nothing. The
  // longest run of four or more letters in its id or its name — "bateson" for
  // 18 Bateson, which finds bateson_test without this file having to know that
  // bateson_test exists. Short words are skipped because "the" and "al" match
  // half the network; nothing at all is returned rather than a guess when a
  // station's name is all digits.
  function fieldProbeWiden(st) {
    const words = `${st?.id || ''} ${st?.name || ''}`.toLowerCase().match(/[a-z]{4,}/g) || [];
    if (!words.length) return '';
    return words.sort((a, b) => b.length - a.length)[0];
  }

  // Something that tells one address from another when the registry has no name
  // for it. Without this, four probed channels all come out labelled with the
  // station they belong to and the series list is four identical rows — which
  // was true of the picked station's name before the probe existed too, and is
  // only now the common case. The channel is the device's own word for the
  // sensor (`rain`, `level_1`), which is the best name anybody has.
  function fieldAddrLabel(addr) {
    const a = String(addr || '');
    if (a.startsWith('a:')) return `ALERT ${a.slice(2)}`;
    const slash = a.indexOf('/');
    return slash >= 0 ? a.slice(slash + 1) : a;
  }

  // Paged exactly as fieldQueryRows() is, and for the same reason: the rows-per
  // -response cap is a server setting we do not control, so this reads until a
  // page comes back short.
  async function fieldProbeRows(filter) {
    const base = `reading?${filter}&select=${AD_PROBE_SELECT}&order=reading_ts.desc`;
    const rows = [];
    let capped = false;
    for (;;) {
      const page = await dbSelect(`${base}&limit=${AD_PROBE_PAGE}&offset=${rows.length}`);
      if (!Array.isArray(page) || !page.length) break;
      rows.push(...page);
      if (page.length < AD_PROBE_PAGE) break;
      if (rows.length >= AD_PROBE_ROW_CAP) { capped = true; break; }
    }
    return { rows, capped };
  }

  // Readings → one row per address. Newest-reporting first, because "is it
  // still speaking" is the question a person asking this is usually really
  // asking.
  function fieldProbeReduce(rows) {
    const by = new Map();
    for (const r of rows) {
      const addr = r.addr;
      if (!addr) continue;
      let e = by.get(addr);
      if (!e) {
        e = { addr, stationId: r.station_id || null, unit: '', n: 0, first: Infinity, last: -Infinity };
        by.set(addr, e);
      }
      e.n++;
      if (!e.unit && r.unit) e.unit = r.unit;
      if (!e.stationId && r.station_id) e.stationId = r.station_id;
      const t = Date.parse(r.reading_ts);
      if (isFinite(t)) { if (t < e.first) e.first = t; if (t > e.last) e.last = t; }
    }
    return [...by.values()].sort((a, b) => b.last - a.last);
  }

  // Ask. Three questions in order, and it stops at the first that answers:
  //
  //   1. the picked station's own id — the indexed one, and the only one whose
  //      answer needs no caveat
  //   2. its registry addresses — a reading whose address never resolved to a
  //      station still belongs to it, and station_id is null on all 244 of them
  //   3. a widened search on a word out of its name — which is how 18 Bateson
  //      finds the rig at 18 Bateson, and is flagged as a guess wherever it is
  //      shown
  //
  // A typed term skips all three and searches for exactly that. Captures the
  // instance up front, like every other query on this tab: a tab switch
  // mid-flight must not land one picker's answer in the other's.
  async function fieldProbe(term, { adopt = false } = {}) {
    const inst = ad;
    const q = fq();
    const p = q.probe;
    const st = fieldStation();
    const typed = term != null ? String(term).trim() : String(p.term || '').trim();

    if (!typed && !st) {
      p.error = 'Pick a station above, or type a station id, channel, station number or ALERT address to search for.';
      p.asked = true;
      renderSide();
      return;
    }

    const seq = ++p.seq;
    p.term = typed;
    p.asked = true;
    p.loading = true;
    p.error = '';
    p.widened = '';
    renderSide();

    const stale = () => inst.fq !== q || p.seq !== seq;
    let out = { rows: [], capped: false };
    let widened = '';
    try {
      if (typed) {
        const filter = fieldProbeFilter(typed);
        out = filter ? await fieldProbeRows(filter) : { rows: [], capped: false };
      } else {
        out = await fieldProbeRows(`station_id=eq.${encodeURIComponent(st.id)}`);
        if (stale()) return;
        if (!out.rows.length) {
          const addrs = fieldAddrs(st).map(a => a.addr);
          if (addrs.length) {
            // Quoted: an address is `a:6128` or `s:999998/rain`, and both the
            // colon and the slash are punctuation to PostgREST's list parser.
            const list = addrs.map(a => `"${String(a).replace(/["\\]/g, '')}"`).join(',');
            out = await fieldProbeRows(`addr=in.(${encodeURIComponent(list).replace(/%2C/g, ',')})`);
            if (stale()) return;
          }
        }
        if (!out.rows.length) {
          widened = fieldProbeWiden(st);
          const filter = widened ? fieldProbeFilter(widened) : '';
          if (filter) { out = await fieldProbeRows(filter); if (stale()) return; }
        }
      }
    } catch (err) {
      if (stale()) return;
      p.loading = false;
      p.rows = []; p.scanned = 0; p.capped = false;
      p.error = `Could not read the datastore — ${err && err.message || err}. `
              + `${dbHostLabel()} may be unreachable, or asleep.`;
      renderSide();
      return;
    }
    if (stale()) return;

    p.loading = false;
    p.rows    = fieldProbeReduce(out.rows);
    p.scanned = out.rows.length;
    p.capped  = out.capped;
    p.widened = p.rows.length ? widened : '';

    // Opened from the station card with nothing in the registry to tick: what
    // this found *for this station* is what "all its sensors" meant, so it is
    // ticked and drawn without a second press. A widened match is deliberately
    // not — those belong to another station row, and putting another site's
    // readings on screen under the name of the pin somebody clicked is the one
    // thing this whole path must not do on its own. They are listed, tagged
    // with the station they are filed under, and left to be chosen.
    if (adopt && p.rows.length && !p.widened) {
      q.sensors = p.rows.map(r => r.addr);
      renderSide();
      fieldRun();
      return;
    }

    renderSide();
    announce(p.rows.length
      ? `${p.rows.length} address${p.rows.length === 1 ? '' : 'es'} in the datastore.`
      : 'Nothing in the datastore matches.');
  }

  function fieldSetProbeTerm(v) { const p = fq().probe; p.term = String(v || ''); renderSide(); }

  function fieldProbeClear() { fq().probe = newFieldProbe(); renderSide(); }

  // Everything tickable: the registry's addresses, then anything the probe
  // turned up that they do not already cover. One list, because an "all" that
  // meant only half of what is on screen would be a lie about the other half.
  function fieldSelectableAddrs() {
    const out = fieldAddrs(fieldStation()).map(a => a.addr);
    const seen = new Set(out);
    for (const r of fq().probe.rows) if (!seen.has(r.addr)) { seen.add(r.addr); out.push(r.addr); }
    return out;
  }

  function fieldWindow(q) {
    if (q.win === 'custom') {
      const t0 = Date.parse(`${q.from}T00:00:00`);
      const t1 = Date.parse(`${q.to}T23:59:59.999`);
      if (!isFinite(t0) || !isFinite(t1) || t1 <= t0) return null;
      return { t0, t1 };
    }
    const row = AD_FIELD_WINDOWS.find(w => w[0] === q.win) || AD_FIELD_WINDOWS[1];
    const t1 = Date.now();
    return { t0: t1 - row[2] * AD_DAY, t1 };
  }

  function fieldRes(q, win) {
    if (q.res !== 'auto') return q.res;
    const days = (win.t1 - win.t0) / AD_DAY;
    if (days <= AD_RAW_MAX_DAYS)    return 'raw';
    if (days <= AD_HOURLY_MAX_DAYS) return 'hourly';
    return 'daily';
  }

  // How long a silence has to be before the chart stops joining across it. On a
  // rollup that is one missing bucket. On raw readings it is taken from what the
  // station actually does — three times the median gap it did report — because a
  // 15-minute station and a tipping-bucket that only speaks when it rains are
  // both normal, and one fixed threshold would libel one of them.
  function fieldGapMs(t, n, res) {
    if (res === 'hourly') return 1.5 * 3600000;
    if (res === 'daily')  return 1.5 * AD_DAY;
    if (n < 4) return 0;
    const d = [];
    for (let i = 1; i < n; i++) { const g = t[i] - t[i - 1]; if (g > 0) d.push(g); }
    if (d.length < 3) return 0;
    d.sort((a, b) => a - b);
    return Math.max(3 * d[d.length >> 1], 900000);   // never tighter than 15 minutes
  }

  // meganet.quality is six rows and never changes within a session.
  let fieldQualityMap = null;
  async function fieldQualityCodes() {
    if (fieldQualityMap) return fieldQualityMap;
    try {
      const rows = await dbSelect('quality?select=code,key&order=code.asc');
      fieldQualityMap = new Map(rows.map(r => [r.code, r.key]));
    } catch (_) {
      fieldQualityMap = new Map();   // labels degrade to the bare code; the data is still right
    }
    return fieldQualityMap;
  }

  // station_id rides along on all three so a series can be labelled with the
  // station the *readings* name rather than the one the picker happened to be
  // showing — see the owner lookup in fieldRun(). Both rollups carry it too.
  const AD_FIELD_SELECT = {
    raw:    'addr,station_id,reading_ts,received_at,value_raw,value,unit,quality,path,dup_count,dup_paths',
    hourly: 'addr,station_id,bucket,n,n_dup,unit,raw_min,raw_max,raw_last,val_last,first_ts,last_ts',
    daily:  'addr,station_id,bucket,n,n_dup,unit,raw_min,raw_max,raw_last,val_last,first_ts,last_ts',
  };

  // A date for reading_daily's `bucket`, which is a date rather than a
  // timestamptz — local, because that is the day the operator means.
  function fieldIsoDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function fieldQueryRows(addrs, win, res) {
    const table = res === 'raw' ? 'reading' : res === 'hourly' ? 'reading_hourly' : 'reading_daily';
    const tcol  = res === 'raw' ? 'reading_ts' : 'bucket';
    const lo = res === 'daily' ? fieldIsoDate(win.t0) : new Date(win.t0).toISOString();
    const hi = res === 'daily' ? fieldIsoDate(win.t1) : new Date(win.t1).toISOString();
    // Quoted, because an address is `a:6128` or `s:541155/rain` and both the
    // colon and the slash are punctuation to PostgREST's list parser.
    const list = addrs.map(a => `"${String(a).replace(/["\\]/g, '')}"`).join(',');
    const base = `${table}?addr=in.(${encodeURIComponent(list).replace(/%2C/g, ',')})`
               + `&${tcol}=gte.${encodeURIComponent(lo)}&${tcol}=lt.${encodeURIComponent(hi)}`
               + `&select=${AD_FIELD_SELECT[res]}&order=addr.asc,${tcol}.asc`;

    const rows = [];
    let capped = false;
    for (;;) {
      const page = await dbSelect(`${base}&limit=${AD_FIELD_PAGE}&offset=${rows.length}`);
      if (!Array.isArray(page) || !page.length) break;
      rows.push(...page);
      if (page.length < AD_FIELD_PAGE) break;         // short page = the end
      if (rows.length >= AD_FIELD_ROW_CAP) { capped = true; break; }
    }
    return { rows, capped };
  }

  // One address' rows into the shape seriesData() takes. Nothing here is
  // ARRO-specific and nothing downstream is field-specific — that seam is the
  // deliverable.
  function fieldCols(rows, res, qmap) {
    const n = rows.length;
    const t = new Float64Array(n), tr = new Float64Array(n);
    const v = new Float64Array(n), raw = new Float64Array(n);
    const q = new Uint8Array(n);
    const qcodes = [], qidx = new Map();
    const dup = new Int32Array(n), cnt = new Int32Array(n);
    const lo = new Float64Array(n), hi = new Float64Array(n);
    const eng = new Float64Array(n);
    const paths = new Array(n);
    const units = new Map();
    let anyEng = false, anyDup = false;

    const codeOf = key => {
      let i = qidx.get(key);
      if (i === undefined) { i = qcodes.length; qcodes.push(key); qidx.set(key, i); }
      return i;
    };

    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (res === 'raw') {
        t[i]  = Date.parse(r.reading_ts);
        tr[i] = Date.parse(r.received_at || r.reading_ts) || t[i];
        v[i]  = raw[i] = Number(r.value_raw);
        eng[i] = r.value == null ? NaN : Number(r.value);
        q[i]  = codeOf(qmap.get(r.quality) || (r.quality ? `quality ${r.quality}` : 'unqualified'));
        dup[i] = r.dup_count || 0;
        cnt[i] = 1;
        lo[i] = hi[i] = v[i];
        const via = [r.path, ...(r.dup_paths || [])].filter(Boolean);
        paths[i] = via.length ? [...new Set(via)] : null;
      } else {
        t[i]  = Date.parse(r.bucket);
        tr[i] = Date.parse(r.last_ts || r.bucket) || t[i];
        // The counter as it read at the end of the bucket. A mean would be a
        // different quantity and would make an accumulator stop accumulating.
        v[i]  = raw[i] = Number(r.raw_last);
        eng[i] = r.val_last == null ? NaN : Number(r.val_last);
        q[i]  = codeOf(res === 'hourly' ? 'hourly rollup' : 'daily rollup');
        dup[i] = r.n_dup || 0;
        cnt[i] = r.n || 0;
        lo[i] = r.raw_min == null ? NaN : Number(r.raw_min);
        hi[i] = r.raw_max == null ? NaN : Number(r.raw_max);
        paths[i] = null;
      }
      if (isFinite(eng[i])) anyEng = true;
      if (dup[i] > 0) anyDup = true;
      const u = (r.unit || '').trim();
      if (u) units.set(u, (units.get(u) || 0) + 1);
    }

    let modal = '', best = 0;
    for (const [u, c] of units) if (c > best) { best = c; modal = u; }

    // meganet.reading.unit describes `value`, the conversion — so when there is
    // one, the series itself is in counts and the unit belongs to the display
    // conversion instead. When there is not, the unit (if any) is the raw
    // column's own.
    const unit    = anyEng ? 'count' : (modal || 'count');
    const engUnit = anyEng ? modal : '';

    return {
      cols: { n, t, tr, v, raw, q, qcodes, unit, warn: [], hasRaw: true,
              extra: { dup, cnt, lo, hi, paths, eng } },
      engUnit, anyEng, anyDup,
    };
  }

  // The query. Everything above is pure; this is the only part that talks to the
  // network, and it captures its instance up front so a tab switch mid-flight
  // cannot land somebody else's readings in the field list.
  async function fieldRun() {
    const inst = ad;
    const q = fq();
    const st = fieldStation();
    const addrs = [...q.sensors];
    if (q.extra.trim()) addrs.push(q.extra.trim());

    q.error = ''; q.empty = '';
    if (!st && !addrs.length) { q.error = 'Pick a station and at least one sensor first.'; renderSide(); return; }
    if (!addrs.length)        { q.error = 'Pick at least one sensor.'; renderSide(); return; }

    const win = fieldWindow(q);
    if (!win) { q.error = 'That is not a time window — the "from" date has to fall before the "to" date.'; renderSide(); return; }
    const res = fieldRes(q, win);

    const seq = ++q.seq;
    q.loading = true;
    renderSide();

    let out;
    try {
      out = await fieldQueryRows(addrs, win, res);
    } catch (err) {
      if (inst.fq !== q || q.seq !== seq) return;
      q.loading = false;
      q.error = `Could not read the datastore — ${err && err.message || err}. `
              + `${dbHostLabel()} may be unreachable, or asleep.`;
      renderSide();
      return;
    }
    if (inst.fq !== q || q.seq !== seq) return;   // superseded, or the tab was reset

    const qmap = await fieldQualityCodes();
    if (inst.fq !== q || q.seq !== seq) return;

    q.loading = false;

    const byAddr = new Map();
    for (const r of out.rows) {
      if (!byAddr.has(r.addr)) byAddr.set(r.addr, []);
      byAddr.get(r.addr).push(r);
    }

    // Re-running replaces the addresses that were asked for rather than stacking
    // a second copy of them beside the first — and it drops them whether or not
    // anything came back, so a chart is never left showing last question's
    // answer under this question's window.
    const replacing = new Set(addrs);
    inst.series = inst.series.filter(s => !(s.prov && replacing.has(s.prov.addr)));

    if (!out.rows.length) {
      // Nothing is drawn. An empty axis over a silent window reads as "the
      // station reported zero", and silence and a run of zeroes are different
      // claims — one of them is a fault.
      q.empty = `No field readings between ${fmtFull(win.t0)} and ${fmtFull(win.t1)} for `
              + `${addrs.length === 1 ? addrs[0] : addrs.length + ' addresses'}, `
              + `at ${AD_RES_LABEL[res]}. `
              + `Nothing has been ingested for ${addrs.length === 1 ? 'it' : 'them'} in that window.`;
      inst.view = null;
      inst.pin = null;
      if (ad === inst) renderAll();
      return;
    }

    const known = new Map(fieldAddrs(st).map(a => [a.addr, a]));
    const prev = ad;
    ad = inst;                       // adoptSeries() writes into the active instance
    try {
      for (const [addr, rows] of byAddr) {
        const built = fieldCols(rows, res, qmap);
        const data  = seriesData(built.cols);
        const hit   = known.get(addr);
        const sensor = hit?.sensor || null;
        // Whose readings these are, according to the readings. An address
        // ticked out of the datastore probe can belong to another station
        // entirely — 18 Bateson's four channels are stored under
        // `bateson_test`, deliberately, so that workshop rain can never be
        // read as gauged rainfall (db/migrations/0026) — and labelling them
        // with whichever station the picker was showing would undo exactly
        // that separation. The picked station stands when the readings name
        // nobody, which is the 244 unresolved addresses' case.
        const ownerId = rows.find(r => r.station_id)?.station_id || null;
        const owner = ownerId && ownerId !== st?.id
          ? ((state.data?.stations || []).find(x => x.id === ownerId) || { id: ownerId, name: ownerId })
          : st;
        const label = [owner?.name || fieldAddrLabel(addr),
                       sensor?.type || hit?.label || fieldAddrLabel(addr)].filter(Boolean).join(' · ');
        const warn = [];
        if (out.capped) warn.push(`The row cap (${AD_FIELD_ROW_CAP.toLocaleString()}) was reached — this is the start of the window, not all of it. Narrow the window or pick a coarser resolution.`);
        if (res !== 'raw') warn.push(`Drawn from ${AD_RES_LABEL[res]}: each point is the counter as it read at the end of its bucket. Within-bucket minimum and maximum are in the inspector and the export.`);
        if (built.anyDup) warn.push('Some readings arrived by more than one path — click a point to see which.');
        data.warn = warn;

        const s = adoptSeries(data, {
          fileName: `${addr} · ${AD_RES_LABEL[res]}`,
          meta:     { sensorId: sensor?.sensor_id || null },
          label,
          station:  owner || null,
          sensor,
          linkHow:  'address',
          sensorId: sensor?.sensor_id || null,
          kind:     guessKind({ sensorLabel: hit?.label || '', unit: built.engUnit, addr }, sensor),
          gapMs:    fieldGapMs(data.t, data.n, res),
          engUnit:  built.engUnit,
          prov: {
            source: 'field',
            addr, res,
            t0: win.t0, t1: win.t1,
            at: Date.now(),
            host: dbHostLabel(),
            capped: out.capped,
          },
          // t, tr, v, raw, eng, lo, hi are Float64 (8 B); q is 1 B; dup and cnt
          // are Int32 (4 B). Paths are sparse and not worth counting.
          bytesPerRow: 8 * 7 + 1 + 4 * 2,
        });
        s.eng = data.extra.eng;
      }
    } finally { ad = prev; }

    inst.view = null;
    inst.pin = null;
    if (ad === inst) {
      renderAll();
      note(`${out.rows.length.toLocaleString()} ${AD_RES_LABEL[res]} from ${dbHostLabel()}.`);
    }
  }

  // ── the picker ───────────────────────────────────────────────────────────────

  const AD_FIND_CAP = 25;   // matches offered before the operator is asked to type more

  function fieldMatches(term) {
    const all = state.data?.stations || [];
    const t = term.trim().toLowerCase();
    if (!t) return [];
    const hits = [];
    for (const s of all) {
      if (String(s.name || '').toLowerCase().includes(t)
          || String(s.station_number || '').includes(t)
          || String(s.id || '').toLowerCase().includes(t)) {
        hits.push(s);
        if (hits.length > AD_FIND_CAP) break;
      }
    }
    return hits;
  }

  function fieldPickerHtml() {
    const q = fq();
    const st = fieldStation();
    const addrs = fieldAddrs(st);
    const noAddr = fieldNoAddr(st);
    const win = fieldWindow(q);
    const res = win ? fieldRes(q, win) : null;
    const hits = st ? [] : fieldMatches(q.find);
    // "all" means everything on screen, registry and probed alike.
    const pick = fieldSelectableAddrs();
    const allOn = pick.length > 0 && pick.every(a => q.sensors.includes(a));

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h2 id="ad-field-h">Field readings</h2>
          <span class="small"
                title="Every reading on this tab comes from the MegaNet datastore. ARRO exports live on the ARRO Data tab and the two are never mixed."
                >${esc(dbHostLabel())}</span></div>

        <label class="ad-cfg-row ad-cfg-row--block">
          <span>Station</span>
          <input type="search" class="ad-field-input" placeholder="Name, station number or id…"
                 value="${escAttr(q.find)}"
                 oninput="ArroData.fieldSetStation('', this.value)">
        </label>
        ${st ? `
          <div class="ad-field-picked">
            <b>${esc(st.name)}</b>
            <span class="small mono">${esc(st.station_number || st.id)}</span>
            <button class="ad-x" title="Pick a different station"
                    aria-label="Clear ${escAttr(st.name)} and pick a different station"
                    onclick="ArroData.fieldSetStation('', '')">✕</button>
          </div>` : hits.length ? `
          <div class="ad-field-hits" role="group" aria-label="Stations matching “${escAttr(q.find.trim())}”">
            ${hits.slice(0, AD_FIND_CAP).map(s => `
              <button class="ad-field-hit" onclick="ArroData.fieldSetStation('${escAttr(s.id)}', '')">
                ${esc(s.name)} <span class="small mono">${esc(s.station_number || '')}</span>
              </button>`).join('')}
            ${hits.length > AD_FIND_CAP ? '<div class="small">More than ' + AD_FIND_CAP + ' matches — keep typing.</div>' : ''}
          </div>` : q.find.trim() ? `
          <div class="small ad-field-none">No station matches that.</div>` : ''}

        ${st ? `
          <div class="ad-field-sensors">
            <div class="panel-header ad-subhead">
              <h3 class="ad-subhead-h" id="ad-sensors-h"
                  title="What stations.json says this station reports. What it actually reports is the block below.">Sensors</h3>
              <button class="btn-link" onclick="ArroData.fieldAllSensors()"
                      aria-label="${allOn ? 'Untick every sensor' : 'Tick every sensor'}">${
                allOn ? 'none' : 'all'}</button>
            </div>
            ${addrs.map(a => `
              <label class="ad-chk ad-sensor-row">
                <input type="checkbox" ${q.sensors.includes(a.addr) ? 'checked' : ''}
                       onchange="ArroData.fieldToggleSensor('${escAttr(a.addr)}')">
                <span>${esc(a.label)} <span class="small mono">${esc(a.addr)}</span></span>
              </label>`).join('') || `<div class="small ad-field-none">No ALERT addresses recorded for this station
                — ask the datastore below what it has heard from it.</div>`}
            ${noAddr.length ? `
              <div class="small ad-field-noaddr"
                   title="A satellite or cellular station reports under its station number and a channel name, which stations.json does not record. Ask the datastore below, or type the address in if you know it.">
                ${noAddr.length} sensor${noAddr.length === 1 ? '' : 's'} here carr${noAddr.length === 1 ? 'ies' : 'y'} no ALERT address
                (${esc(noAddr.slice(0, 3).join(', '))}${noAddr.length > 3 ? '…' : ''}).</div>` : ''}
            <label class="ad-cfg-row ad-cfg-row--block ad-cfg-row--spaced"
                   title="An address exactly as meganet.reading stores it — a:6128, or s:541155/rain for a station that reports under its number.">
              <span>Or an address</span>
              <input type="text" class="ad-field-input" placeholder="a:6128 or s:541155/rain"
                     value="${escAttr(q.extra)}"
                     onchange="ArroData.fieldSetDate('extra', this.value)">
            </label>
          </div>` : ''}

        ${fieldProbeHtml()}

        <div class="panel-header ad-subhead">
          <h3 class="ad-subhead-h" id="ad-window-h">Window</h3></div>
        <div class="ad-seg ad-seg--wrap" role="group" aria-labelledby="ad-window-h">
          ${AD_FIELD_WINDOWS.map(([k, label]) => `
            <button class="${q.win === k ? 'on' : ''}" title="${escAttr(label)}"
                    aria-pressed="${q.win === k}" aria-label="${escAttr(label)}"
                    onclick="ArroData.fieldSetWindow('${k}')">${esc(k)}</button>`).join('')}
          <button class="${q.win === 'custom' ? 'on' : ''}" title="Type your own dates"
                  aria-pressed="${q.win === 'custom'}"
                  onclick="ArroData.fieldSetWindow('custom')">dates</button>
        </div>
        ${q.win === 'custom' ? `
          <div class="ad-field-dates">
            <input type="date" value="${escAttr(q.from)}" aria-label="Window starts"
                   onchange="ArroData.fieldSetDate('from', this.value)">
            <span class="small">to</span>
            <input type="date" value="${escAttr(q.to)}" aria-label="Window ends"
                   onchange="ArroData.fieldSetDate('to', this.value)">
          </div>` : ''}

        <div class="panel-header ad-subhead">
          <h3 class="ad-subhead-h" id="ad-res-h" title="Raw readings below ${AD_RAW_MAX_DAYS} days, hourly below ${AD_HOURLY_MAX_DAYS}, daily beyond — override it here.">Resolution</h3></div>
        <div class="ad-seg" role="group" aria-labelledby="ad-res-h">
          ${[['auto', 'Auto'], ['raw', 'Raw'], ['hourly', 'Hourly'], ['daily', 'Daily']].map(([k, label]) => `
            <button class="${q.res === k ? 'on' : ''}" onclick="ArroData.fieldSetRes('${k}')"
                    aria-pressed="${q.res === k}"
                    title="${escAttr(k === 'auto' ? 'Chosen from the width of the window' : 'Always draw ' + AD_RES_LABEL[k])}">${esc(label)}</button>`).join('')}
        </div>
        ${res ? `<p class="small ad-cfg-note">This window will be drawn from <b>${esc(AD_RES_LABEL[res])}</b>.</p>` : ''}

        <button class="ad-field-run" ${q.loading ? 'disabled' : ''}
                onclick="ArroData.fieldRun()">${q.loading ? 'Reading…' : 'Load readings'}</button>

        ${q.error ? `<div class="small ad-note ad-note--bad ad-field-msg">${esc(q.error)}
            <button class="ad-inline-link" onclick="ArroData.fieldClearError()">dismiss</button></div>` : ''}
        ${q.empty ? `<div class="small ad-warn ad-field-msg">${esc(q.empty)}</div>` : ''}
      </div>`;
  }

  // The datastore block. Always drawn, station picked or not: "what is in the
  // database" is a question in its own right, and hiding the only control that
  // answers it behind having already guessed the answer is the trap this whole
  // addition exists to get out of.
  //
  // Its rows are checkboxes for the same reason the registry's are — ticking
  // one puts its address in q.sensors, and fieldRun() cannot tell where an
  // address came from, which is exactly right. What it can tell, and does, is
  // whose reading it is: see the owner lookup in fieldRun().
  function fieldProbeHtml() {
    const q  = fq();
    const p  = q.probe;
    const st = fieldStation();
    const registry = new Set(fieldAddrs(st).map(a => a.addr));
    const shown = p.rows.slice(0, AD_PROBE_ADDR_CAP);
    const other = p.rows.filter(r => r.stationId && r.stationId !== (st && st.id)).length;

    return `
      <div class="ad-field-probe">
        <div class="panel-header ad-subhead">
          <h3 class="ad-subhead-h" id="ad-probe-h"
              title="What meganet.reading has actually heard, rather than what stations.json says this station should report. The two disagree often — 244 of the 706 addresses in the datastore resolve to no station at all.">In the datastore</h3>
          <button class="btn-link" ${p.loading ? 'disabled' : ''}
                  title="${escAttr(p.term.trim()
                    ? `Search the datastore for “${p.term.trim()}”`
                    : st ? `Read the datastore for ${st.name}`
                         : 'Type something to search for first')}"
                  onclick="ArroData.fieldProbe()">${p.loading ? 'asking…' : 'ask'}</button>
        </div>

        <label class="ad-cfg-row ad-cfg-row--block"
               title="Station id, channel, station number or ALERT address — the four things a reading carries its identity as. Leave it empty to ask about the station picked above.">
          <span>Search</span>
          <input type="search" class="ad-field-input" placeholder="${escAttr(st ? st.id : 'bateson, rain, 999998, 8101…')}"
                 value="${escAttr(p.term)}"
                 oninput="ArroData.fieldSetProbeTerm(this.value)"
                 onchange="ArroData.fieldProbe(this.value)">
        </label>

        ${p.error ? `<div class="small ad-note ad-note--bad ad-field-msg">${esc(p.error)}</div>` : ''}
        ${p.loading ? '<p class="small ad-cfg-note">Reading ' + esc(dbHostLabel()) + '…</p>' : ''}

        ${!p.asked && !p.loading ? `<p class="small ad-cfg-note">${st
          ? `Nothing asked yet. <b>ask</b> reads ${esc(dbHostLabel())} for every address ${esc(st.name)} has reported on.`
          : 'Type a station id, channel, station number or ALERT address and press Enter.'}</p>` : ''}

        ${p.asked && !p.loading && !p.error && !p.rows.length ? `
          <p class="small ad-field-none">Nothing in the datastore for
            ${p.term.trim() ? `“${esc(p.term.trim())}”` : esc(st ? st.name : 'that')}.
            Nothing has ever been ingested under ${p.term.trim() ? 'it' : 'its id, its addresses, or its name'}.</p>` : ''}

        ${shown.length ? `
          <div class="ad-probe-found" role="group" aria-label="Addresses found in the datastore">
            ${shown.map(r => {
              const foreign = r.stationId && r.stationId !== (st && st.id);
              return `
              <label class="ad-chk ad-sensor-row ad-probe-row${foreign ? ' ad-probe-row--other' : ''}">
                <input type="checkbox" ${q.sensors.includes(r.addr) ? 'checked' : ''}
                       onchange="ArroData.fieldToggleSensor('${escAttr(r.addr)}')">
                <span>
                  <span class="mono">${esc(r.addr)}</span>${r.unit ? ` <span class="small">${esc(r.unit)}</span>` : ''}
                  ${registry.has(r.addr) ? '<span class="small ad-probe-tag" title="This address is in stations.json too — it is ticked in the Sensors list above as well.">registry</span>' : ''}
                  ${foreign ? `<span class="small ad-probe-tag ad-probe-tag--other"
                       title="These readings are filed against a different station row. Charting them here labels them with that station, not this one.">${esc(r.stationId)}</span>`
                    : r.stationId ? '' : '<span class="small ad-probe-tag" title="No station_id resolved on these readings — the address has never been matched to a station.">unresolved</span>'}
                  <br><span class="small">${r.n.toLocaleString()} reading${r.n === 1 ? '' : 's'} · last ${esc(fmtFull(r.last))}</span>
                </span>
              </label>`; }).join('')}
          </div>

          ${p.widened ? `<div class="small ad-warn ad-field-msg">
            Nothing is recorded against <b>${esc(st ? st.name : '')}</b> itself. These matched
            <b>${esc(p.widened)}</b> in the station id, channel or number, so they belong to
            ${other ? 'another station row' : 'addresses that resolve to no station'} —
            check it is the site you mean before you chart it.</div>` : ''}

          <p class="small ad-cfg-note">
            ${p.rows.length.toLocaleString()} address${p.rows.length === 1 ? '' : 'es'}
            ${p.rows.length > shown.length ? `(${shown.length} shown — narrow the search) ` : ''}from
            ${p.scanned.toLocaleString()} reading${p.scanned === 1 ? '' : 's'} on ${esc(dbHostLabel())}.
            ${p.capped ? `The cap (${AD_PROBE_ROW_CAP.toLocaleString()} readings) was reached, so an address that
              stopped reporting before then may be missing — search for it by name.` : ''}</p>` : ''}
      </div>`;
  }

  // Setting a station clears the sensor ticks: they are addresses belonging to
  // the station that was showing, and carrying them across would query one
  // station's addresses under another station's name.
  function fieldSetStation(id, find) {
    const q = fq();
    q.stationId = id || '';
    q.find = id ? '' : (find || '');
    q.sensors = [];
    // The probe answered a question about the station that was showing, so it
    // goes with it. A list of addresses left standing under another station's
    // name is the same mistake as carrying the sensor ticks across.
    q.probe = newFieldProbe();
    if (id) {
      // One sensor is the common case and ticking it saves a click; more than
      // one is a choice the operator should make deliberately.
      const a = fieldAddrs(fieldStation());
      if (a.length === 1) q.sensors = [a[0].addr];
    }
    q.error = ''; q.empty = '';
    renderSide();
  }

  function fieldToggleSensor(addr) {
    const q = fq();
    q.sensors = q.sensors.includes(addr) ? q.sensors.filter(a => a !== addr) : [...q.sensors, addr];
    renderSide();
  }

  function fieldAllSensors() {
    const q = fq();
    const all = fieldSelectableAddrs();
    q.sensors = all.length && all.every(a => q.sensors.includes(a)) ? [] : all;
    renderSide();
  }

  function fieldSetWindow(k) { const q = fq(); q.win = k; q.error = ''; renderSide(); }
  function fieldSetRes(k)    { const q = fq(); q.res = k; renderSide(); }
  function fieldSetDate(which, v) { const q = fq(); q[which] = v; q.error = ''; renderSide(); }
  function fieldClearError() { const q = fq(); q.error = ''; q.empty = ''; renderSide(); }

  // The station card's door in (#175): a station, everything it can be
  // addressed on ticked, and the readings drawn — the errand somebody standing
  // on a map pin is actually on. Unlike fieldShow() it starts from a *station*
  // rather than an address, which means it has to have an answer for a station
  // that cannot be addressed at all.
  //
  // That answer is the probe. With no sensor to tick there is nothing to load,
  // so it asks the datastore instead and lands the operator on a list of what
  // that station has actually reported — which for 18 Bateson is four channels
  // filed under a station row the map has no pin for, and for a genuinely
  // silent station is the sentence "nothing has ever been ingested under its
  // id, its addresses, or its name". Both are answers; an empty picker was not.
  //
  // The caller switches tabs first, exactly as the Message Log's door does:
  // switchTab('field') is what makes `ad` the field instance, and writing the
  // picker before that would set it on the ARRO tab, which has none to show.
  function fieldOpenStation(id) {
    const q = fq();
    const st = (state.data?.stations || []).find(s => s.id === id) || null;
    q.stationId = st ? st.id : '';
    q.find   = '';
    q.extra  = '';
    q.error  = ''; q.empty = '';
    q.probe  = newFieldProbe();
    q.sensors = st ? fieldAddrs(st).map(a => a.addr) : [];
    if (q.sensors.length) { fieldRun(); return; }
    renderSide();
    fieldProbe('', { adopt: true });
  }

  // The Message Log's door in: chart one address' raw readings around a
  // moment, exactly as if the operator had worked the picker by hand — so
  // everything downstream (the provenance line, the exports, the inspector)
  // behaves as it always does. Callers switchTab('field') first, which makes
  // `ad` the field instance; a day either side of the moment keeps the window
  // inside AD_RAW_MAX_DAYS, so the resolution stays raw without forcing it.
  function fieldShow(addr, tsMs) {
    const a = String(addr || '').trim();
    if (!a) return;
    let st = null;
    if (a.startsWith('a:') && state.data) {
      const hits = buildSensorIndex().get(+a.slice(2)) || [];
      st = hits.length ? hits[0].station : null;
    } else if (a.startsWith('s:') && state.data) {
      const num = a.slice(2).split('/')[0];
      st = (state.data.stations || []).find(s =>
        String(s.station_number || '') === num || String(s.site?.number || '') === num) || null;
    }
    const q = fq();
    q.stationId = st ? st.id : '';
    q.find = '';
    q.probe = newFieldProbe();
    const known = st ? fieldAddrs(st).some(x => x.addr === a) : false;
    q.sensors = known ? [a] : [];
    q.extra   = known ? '' : a;
    const day = d => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    q.win  = 'custom';
    q.from = day(tsMs - AD_DAY);
    q.to   = day(tsMs + AD_DAY);
    q.res  = 'raw';
    fieldRun();
  }

  // What the chart says about itself. Only on the Field tab: the ARRO tab's
  // answer is its own name, and adding a banner there would change a tab this
  // work promised not to touch.
  function provenanceHtml() {
    if (ad.source !== 'field') return '';
    const vis = shown().filter(s => s.prov);
    if (!vis.length) return '';
    const res = [...new Set(vis.map(s => s.prov.res))];
    const t0 = Math.min(...vis.map(s => s.prov.t0));
    const t1 = Math.max(...vis.map(s => s.prov.t1));
    const gaps = Math.max(...vis.map(s => s.gapMs || 0));
    const capped = vis.some(s => s.prov.capped);
    return `
      <div class="ad-prov" role="note">
        <span class="ad-badge ad-badge--src" title="These readings came out of the MegaNet datastore, not from ARRO. The two are never combined.">Field data</span>
        <span class="mono small">${esc(vis[0].prov.host)}</span>
        <span>·</span>
        <b>${esc(res.map(r => AD_RES_LABEL[r]).join(' + '))}</b>
        ${res.some(r => r !== 'raw') ? '<span class="small">(the counter at the end of each bucket)</span>' : ''}
        <span>·</span>
        <span>${esc(fmtFull(t0))} → ${esc(fmtFull(t1))}</span>
        ${gaps ? `<span>·</span><span class="small" title="Nothing is drawn across a silence longer than this.">gaps over ${esc(fmtDur(gaps))} left open</span>` : ''}
        ${capped ? '<span>·</span><span class="txt-warn small">row cap reached — this is the start of the window, not all of it</span>' : ''}
      </div>`;
  }

  // Repeater health, and the one diagnostic this tab can show that no other can.
  // dup_count is per reading: how many further copies of it arrived after the
  // one that was kept.
  function dupSummary(s) {
    const dup = s.extra?.dup;
    if (!dup) return '';
    let many = 0, copies = 0;
    for (let i = 0; i < s.n; i++) if (dup[i] > 0) { many++; copies += dup[i]; }
    if (!many) {
      return ' · <span title="Every reading here arrived exactly once. On a repeater network that is worth a second look — it can mean the repeaters are not hearing this station.">single path</span>';
    }
    return ` · <span title="${escAttr(`${copies.toLocaleString()} further copies arrived across ${many.toLocaleString()} readings. A repeater network delivering most readings more than once is the network working.`)}">${many.toLocaleString()} multi-path</span>`;
  }

  // The inspector rows only a field reading has. Kept out of pinHtml's grid
  // literal so the ARRO inspector still renders exactly the six it always did.
  function fieldPinRows(s, i) {
    const e = s.extra || {};
    const rows = [];
    if (s.eng && isFinite(s.eng[i])) {
      rows.push(`<div><span>Converted</span><b>${esc(fmtVal(s.eng[i]))} ${esc(s.engUnit || '')}</b>
        <span class="small">display only — the filter ran on the count</span></div>`);
    }
    if (s.prov.res !== 'raw' && e.cnt) {
      const per = s.prov.res === 'hourly' ? 'hour' : 'day';
      rows.push(`<div><span>In this ${per}</span><b>${(e.cnt[i] || 0).toLocaleString()} reading${e.cnt[i] === 1 ? '' : 's'}</b></div>`);
      if (e.lo && isFinite(e.lo[i])) {
        rows.push(`<div><span>Bucket min–max</span><b>${esc(fmtVal(e.lo[i]))} – ${esc(fmtVal(e.hi[i]))}</b>
          <span class="small">the spread the plotted point hides</span></div>`);
      }
    }
    const dup = e.dup ? e.dup[i] : 0;
    const via = e.paths ? e.paths[i] : null;
    rows.push(`<div><span>Copies</span><b>${dup ? `heard ${dup + 1} times` : 'heard once'}</b></div>`);
    if (via && via.length) rows.push(`<div><span>Paths</span><b class="mono">${esc(via.join(', '))}</b></div>`);
    rows.push(`<div><span>Source</span><b>Field · <span class="mono">${esc(s.prov.addr)}</span></b></div>`);
    // The same reading, seen as a message: the ingress pathway, the duplicate
    // copies and the decode live on the Message Log, and this is the join
    // between the two pages — its counterpart is the drawer's "chart this
    // address" button over there. Rollup points name no single message, so
    // only a raw point gets the door.
    if (s.prov.res === 'raw') {
      rows.push(`<div><span>Message Log</span>
        <button class="ad-inline-link" onclick="MessageLog.showReading('${escAttr(s.prov.addr)}', ${Math.round(s.t[i])})"
                title="Open this reading's row in the Message Log — the ingress pathway, the duplicate copies and the decode are there">Open this reading in the Message Log</button></div>`);
    }
    return rows.join('');
  }

  // "45 min", "1.5 h", "1.5 d" — only ever used for the gap threshold, which is
  // a rough number that wants a rough rendering.
  function fmtDur(ms) {
    // Seconds under the minute. Without this a 40-second gap reads "0 min",
    // which is not a rounding — it is the wrong answer, and on the Δ cells of
    // the pinned callout it would be the answer most often given, since that is
    // the scale most of these records log at.
    if (ms < 60000)   return `${Math.round(ms / 1000)} s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
    if (ms < AD_DAY)  return `${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)} h`;
    return `${(ms / AD_DAY).toFixed(ms % AD_DAY ? 1 : 0)} d`;
  }

  // Every call to this is the result of something the operator did — an import
  // finished, an export was written, a file would not parse — which is exactly
  // rule 1 of #109's live-region policy, so it goes through announce() as well
  // as onto the screen. The line itself is not a live region: it is rebuilt by
  // renderSide() often enough that a freshly-inserted one would be unreliable,
  // and two regions saying the same sentence is worse than one.
  function note(msg, bad) {
    announce(msg);
    const el = document.getElementById('ad-note');
    if (!el) return;
    el.textContent = msg;
    el.className = 'small ad-note' + (bad ? ' ad-note--bad' : '');
    clearTimeout(ad.noteTimer);
    ad.noteTimer = setTimeout(() => { if (el) { el.textContent = ''; el.className = 'small ad-note'; } }, 9000);
  }

  // ── render ─────────────────────────────────────────────────────────────────

  // `source` picks the instance, and is the only place the two tabs diverge
  // before the sidebar. Called with no argument it means the ARRO tab, which is
  // how renderMain() has always called it.
  function render(source) {
    activate(source || 'arro');
    // The <aside> is a complementary landmark in every screen reader's landmark
    // list, and an unnamed one is an entry reading "complementary" (#109 §4).
    // The two tabs get different names because they hold different things — the
    // Field tab's rail starts with a station picker the ARRO tab has no use for.
    return `
      <div class="ad-wrap${ad.series.length ? ' ad-wrap--charted' : ''}">
        <div class="ad-layout">
          <aside class="ad-side" id="ad-side"
                 aria-label="${ad.source === 'field'
                   ? 'Station, sensors, window and filters'
                   : 'Imports and filters'}">${sideHtml()}</aside>
          <section class="ad-main">${mainHtml()}</section>
        </div>
      </div>`;
  }

  function sideHtml() {
    return `
      ${ad.source === 'field' ? fieldPickerHtml() : importHtml()}
      <div id="ad-note" class="small ad-note"></div>
      ${seriesHtml()}
      ${cfgHtml()}`;
  }

  function importHtml() {
    return `
      <div class="ad-drop" id="ad-drop">
        <input type="file" id="ad-file" accept=".csv,text/csv" multiple hidden
               onchange="ArroData.pick(this)">
        <div><strong>Drop ARRO sensor CSVs here</strong></div>
        <div class="small ad-drop-sub">
          Read in your browser — nothing is uploaded.</div>
        <div class="ad-drop-acts">
          <button onclick="document.getElementById('ad-file').click()"
                  aria-label="Choose ARRO sensor CSV files to import">Choose files…</button>
          <!-- Nothing to find, nothing to export, nothing to have to hand: the
               tab is useless without a file, and the file it is useless without
               is one somebody has to go and fetch out of ARRO first. This is
               the real one (#191). -->
          <button class="btn-link" onclick="ArroData.loadDemo()" ${ad.busy ? 'disabled' : ''}
                  title="One real ARRO export shipped with the app — Durikai's rain accumulator, seven months, 14,942 readings, uncleaned"
                  aria-label="Load the bundled demo export">Demo data</button>
        </div>
        ${ad.busy ? `<div class="small ad-drop-busy">Reading ${ad.busy} file${ad.busy === 1 ? '' : 's'}…</div>` : ''}
      </div>`;
  }

  function seriesHtml() {
    if (!ad.series.length) return '';
    const rows = ad.series.map(s => {
      const f = runFilter(s, ad.cfg);
      const st = f.stats;
      const linkTxt = s.station
        ? `<a class="btn-link" href="#" onclick="ArroData.showStation('${escAttr(s.station.id)}');return false"
             title="Open this station on the Stations tab">${esc(s.station.name)}</a>`
        : `<span class="ad-unlinked" title="${escAttr(s.meta.sensorId
              ? 'No station in the loaded file carries sensor ' + s.meta.sensorId
              : 'The filename did not contain a sensor id')}">not linked</span>`;
      const arro = s.station && arroSensorUrl(arroSiteId(s.station), s.sensor?.device_id);
      return `
        <div class="ad-series${ad.sel === s.key ? ' ad-series--sel' : ''}">
          <div class="ad-series-top">
            <input type="checkbox" ${s.visible ? 'checked' : ''} title="Show on the chart"
                   aria-label="Show ${escAttr(s.label)} on the chart"
                   onchange="ArroData.toggle('${s.key}')">
            <!-- Two ways to the same value (#191): the grid for "make it red",
                 the native picker for "match this exact colour". The grid is a
                 <details> rather than a popover so it needs no positioning, no
                 outside-click handler and no z-index — it pushes the rest of
                 the card down for as long as it is open, which on a 320 px rail
                 is the honest way to show twelve swatches. -->
            <details class="ad-colour" ${ad.colourOpen === s.key ? 'open' : ''}
                     ontoggle="ArroData.colourToggle('${s.key}', this.open)">
              <summary class="ad-colour-cur" style="--sw:${escAttr(s.color)}"
                       title="Series colour — ${escAttr(s.colorSet ? 'chosen' : 'the theme’s')}"
                       aria-label="Colour for ${escAttr(s.label)}${s.colorSet ? '' : ' — currently the theme’s'}"></summary>
              <div class="ad-colour-pop">
                <div class="ad-swatches" role="group" aria-label="Pick a colour for ${escAttr(s.label)}">
                  ${AD_SWATCHES.map(([hex, name]) => `
                    <button type="button" class="ad-sw${
                        s.color.toLowerCase() === hex.toLowerCase() ? ' is-on' : ''}"
                            style="--sw:${hex}" title="${escAttr(name)}" aria-label="${escAttr(name)}"
                            aria-pressed="${s.color.toLowerCase() === hex.toLowerCase()}"
                            onclick="ArroData.setColor('${s.key}', '${hex}')"></button>`).join('')}
                </div>
                <label class="small ad-colour-any">Any colour
                  <input type="color" value="${escAttr(s.color)}"
                         aria-label="Any colour for ${escAttr(s.label)}"
                         onchange="ArroData.setColor('${s.key}', this.value)"></label>
                ${s.colorSet ? `<button class="btn-link" onclick="ArroData.setColor('${s.key}', '')"
                        title="Back to the colour this slot gets from the theme">theme colour</button>` : ''}
              </div>
            </details>
            <b class="ad-series-name" title="${escAttr(s.fileName)}">${esc(s.label)}</b>
            <button class="ad-x" title="Remove this ${ad.source === 'field' ? 'series' : 'import'}"
                    aria-label="Remove ${escAttr(s.label)}"
                    onclick="ArroData.remove('${s.key}')">✕</button>
          </div>
          <div class="small ad-series-meta">
            ${linkTxt}
            ${s.sensorId ? ` · <span class="mono">${esc(s.sensorId)}</span>` : ''}
            ${arro ? ` · <a class="btn-link" href="${escAttr(arro)}" target="_blank" rel="noopener">ARRO ↗</a>` : ''}
          </div>
          ${s.prov ? `
            <div class="small ad-series-meta">
              <span class="ad-badge ad-badge--src"
                    title="From the MegaNet datastore. Never mixed with an ARRO export.">Field</span>
              <span class="mono">${esc(s.prov.addr)}</span> ·
              <span title="Which table this was drawn from">${esc(AD_RES_LABEL[s.prov.res])}</span>
              ${dupSummary(s)}
            </div>` : ''}
          <div class="small ad-series-meta">
            <span title="Readings kept by the filters">${st.good.toLocaleString()} kept</span> ·
            <button class="ad-inline-link txt-bad" onclick="ArroData.explain()"
                    title="Readings the 357 test rejected — click for what the test does">${st.bad.toLocaleString()} removed</button> ·
            <span title="Repeat or out-of-sequence timestamps, excluded before filtering">${st.oos.toLocaleString()} repeats</span>
            ${st.range ? ` · <span class="txt-warn" title="Readings outside the minimum / maximum you set">${st.range.toLocaleString()} out of range</span>` : ''}
            ${st.rate ? ` · <span class="txt-warn" title="Readings that climbed faster than the rate-of-rise limit">${st.rate.toLocaleString()} rose too fast</span>` : ''}
            ${st.fall ? ` · <span class="txt-warn" title="Readings that dropped faster than the rate-of-fall limit">${st.fall.toLocaleString()} fell too fast</span>` : ''}
            ${st.rollovers ? ` · <span title="Accumulator wraps corrected">${st.rollovers} rollover${st.rollovers === 1 ? '' : 's'}</span>` : ''}
          </div>
          ${(() => {
            // What has been changed since this series was loaded (#191). Shown
            // only when there is something to say, and paired with the way back
            // — an edited series that could not say so, or could not be put
            // back, would be a quiet corruption of somebody's record.
            const ed = editedCount(s), del = s.deleted || 0;
            if (!ed && !del) return '';
            return `<div class="small ad-series-meta ad-series-edited">
              <span class="ad-badge ad-badge--warn" title="Changed in this browser tab. Nothing is written back to ${
                escAttr(ad.source === 'field' ? 'the datastore' : 'ARRO')}; the Export buttons write what you see.">edited</span>
              ${ed ? `<span>${ed.toLocaleString()} changed</span>` : ''}
              ${ed && del ? ' · ' : ''}
              ${del ? `<span>${del.toLocaleString()} deleted</span>` : ''}
              ${s.orig ? `<button class="btn-link" onclick="ArroData.revertSeries('${s.key}')"
                       aria-label="Put ${escAttr(s.label)} back to the values it was loaded with"
                       title="Back to the values and quality codes this series was loaded with${
                         del ? ' — deleted readings do not come back' : ''}">revert</button>` : ''}
            </div>`;
          })()}
          <div class="small ad-series-meta">
            <label title="How diff() compares two readings. A rain accumulator only climbs; a water level may move either way.">reads as
              <select aria-label="How ${escAttr(s.label)} reads — accumulator or level"
                      onchange="ArroData.setKind('${s.key}', this.value)">
                <option value="RA" ${s.kind === 'RA' ? 'selected' : ''}>RainAccum</option>
                <option value="WL" ${s.kind === 'WL' ? 'selected' : ''}>WaterLevel</option>
              </select></label>
            <button class="btn-link" onclick="ArroData.solo('${s.key}')"
                    aria-label="Show only ${escAttr(s.label)}" title="Show only this series">solo</button>
            <button class="btn-link" onclick="ArroData.zoomTo('${s.key}')"
                    aria-label="Zoom the chart to ${escAttr(s.label)}" title="Zoom the chart to this series">fit</button>
          </div>
          <!-- How this trace is drawn, and which scale against (#191). Beside
               the colour rather than in the toolbar because all three are
               facts about *this* series: the toolbar decides what the chart
               draws, the card decides what each line in it looks like. -->
          <div class="small ad-series-meta">
            <label title="The dash pattern. Auto is the one this series' slot gets — which is solid when it is the only series shown, so two lines can always be told apart without colour.">line
              <select aria-label="Line type for ${escAttr(s.label)}"
                      onchange="ArroData.setDash('${s.key}', this.value)">
                ${AD_DASH_CHOICES.map(([v, label]) =>
                  `<option value="${v}" ${(s.dash || 'auto') === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
              </select></label>
            <label title="Which vertical scale this series is drawn against. Put a series in different units — rainfall in mm beside a level in metres — on the right and both keep their own shape instead of one flattening the other.">axis
              <select aria-label="Vertical axis for ${escAttr(s.label)}"
                      onchange="ArroData.setAxis('${s.key}', this.value)">
                <option value="left"  ${axisOf(s) === 'left'  ? 'selected' : ''}>Left</option>
                <option value="right" ${axisOf(s) === 'right' ? 'selected' : ''}>Right</option>
              </select></label>
          </div>
          ${(s.warn || []).map(w => `<div class="small ad-warn">${esc(w)}</div>`).join('')}
        </div>`;
    }).join('');

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h2>${ad.source === 'field' ? 'Loaded' : 'Imports'}</h2>
          <button class="btn-link" onclick="ArroData.clearAll()"
                  aria-label="Remove all ${ad.series.length} ${
                    ad.source === 'field' ? 'loaded series' : 'imports'}">clear all</button></div>
        ${rows}
      </div>`;
  }

  // Every filter is a block with its own switch. Turning one off greys and
  // disables its settings rather than hiding them, so the panel reads the same
  // whichever way the switches are set — and so "what would this look like
  // without the rate limit?" is one click and one click back.
  function cfgHtml() {
    if (!ad.series.length) return '';
    const c = ad.cfg;
    const num = (k, label, tip, min, max, on) => `
      <label class="ad-cfg-row" title="${escAttr(tip)}">
        <span>${label}</span>
        <input type="number" value="${escAttr(c[k])}" min="${min}" max="${max}" ${on ? '' : 'disabled'}
               onchange="ArroData.setCfg('${k}', this.value)">
      </label>`;
    // Blank means "no limit", so this one must not be a number input with a
    // forced value — an empty string has to survive the round trip.
    const lim = (k, label, tip, on) => `
      <label class="ad-cfg-row" title="${escAttr(tip)}">
        <span>${label}</span>
        <input type="number" value="${escAttr(c[k])}" placeholder="none" ${on ? '' : 'disabled'}
               onchange="ArroData.setCfg('${k}', this.value)">
      </label>`;
    // A filter's own switch, and the body it governs. `mark` is the shape this
    // filter puts on the chart when it rejects something (#191) — passed as a
    // key rather than as markup, because `label` is escaped and must stay that
    // way: it is the only field here a caller could be tempted to smuggle HTML
    // through.
    const block = (k, label, tip, body, note, mark) => `
      <div class="ad-filt${c[k] ? '' : ' ad-filt--off'}">
        <label class="ad-filt-head" title="${escAttr(tip)}">
          <input type="checkbox" ${c[k] ? 'checked' : ''}
                 onchange="ArroData.setCfg('${k}', this.checked)">
          <span>${esc(label)}</span>${mark ? adMarkSvg(mark) : ''}</label>
        <div class="ad-filt-body">${body}${note ? `<p class="small ad-cfg-note">${note}</p>` : ''}</div>
      </div>`;

    const unit = ad.series[0]?.unit || 'units';

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h2>Filters</h2>
          <span class="ad-panel-acts">
            <button class="btn-link" onclick="ArroData.explain()"
                    title="What the 3-5-7 continuity test does, and why it removed what it did">How the 357 filter works</button>
            <button class="btn-link" onclick="ArroData.resetCfg()"
                    aria-label="Reset every filter to the Bureau's defaults">defaults</button>
          </span></div>

        ${block('use357', '3-5-7 continuity test',
          'The Bureau\'s continuity filter. Off leaves every reading the other filters kept.',
          `<p class="small ad-filt-lede">
             A reading passes if it is within <b>${esc(c.small)}</b> of the next, or <b>${esc(c.medium)}</b> of the
             next-next, or <b>${esc(c.large)}</b> of the one after that. Bureau spec, May 2009.</p>
           ${num('small', 'Small step', 'Difference allowed against the next reading (spec: 3)', 0, 10000, c.use357)}
           ${num('medium', 'Medium step', 'Difference allowed against the next-next reading (spec: 5)', 0, 10000, c.use357)}
           ${num('large', 'Large step', 'Difference allowed against the next-next-next reading (spec: 7)', 0, 10000, c.use357)}
           ${num('breakCount', 'Break after', 'Consecutive failures that break continuity and start a new series (spec: 4)', 1, 100, c.use357)}
           ${num('startTests', 'Start window', 'Tests allowed to establish the start of a series (spec flowchart: 4)', 1, 100, c.use357)}`,
          '', 'removed')}

        ${block('rolloverOn', 'Correct rollovers',
          'Detect accumulator wraps and carry the count across them',
          num('cycle', 'Rollover at', 'Accumulator cycle size — the device counts 0 to cycle−1 (spec: 2048)', 2, 1e9, c.rolloverOn),
          c.use357 ? '' : 'With the 357 test off, nothing has removed the corrupt packets a wrap is '
                        + 'easily confused with — expect spikes to be read as rollovers.',
          'rollover')}

        ${block('oosOn', 'Drop repeat timestamps',
          'Remove readings that do not advance the clock, before filtering',
          num('minGapSec', 'Min gap (s)', 'Collapse readings closer together than this. 0 keeps the spec behaviour.', 0, 86400, c.oosOn),
          'Repeats are ARRO re-sending one observation. Four re-sends of a corrupt '
          + 'packet satisfy the spec\'s "four consecutive readings make a series" and '
          + 'survive as one — set a minimum gap to collapse them.',
          'repeat')}

        ${block('rateOn', 'Rate of rise',
          'Remove readings that climb faster than a gauge plausibly can',
          num('rateMax', `Max rise (${esc(unit)}/h)`,
              'Fastest believable upward change per hour between one reading and the next', 0, 1e9, c.rateOn),
          `Each reading against the one before it, so this filter only ever claims the
           step — a corrupt plateau costs its first reading here and the rest is the 357
           test's business. <b>Upward moves only</b>; falls are the filter below.`,
          'rate')}

        ${block('fallOn', 'Rate of fall',
          'Remove readings that drop faster than a gauge plausibly can',
          num('fallMax', `Max fall (${esc(unit)}/h)`,
              'Fastest believable downward change per hour between one reading and the next', 0, 1e9, c.fallOn),
          `The mirror of the one above, and a separate figure on purpose: the fastest
           credible <em>fall</em> at a site is rarely the fastest credible rise — a level
           climbs with the catchment and falls with the channel draining.
           ${ad.series.some(s => s.kind === 'RA')
              ? '<b>An accumulator does not normally need this.</b> It cannot fall except '
                + 'by wrapping or by corruption, and the rollover and 357 tests already own '
                + 'both — turn it on only to see what it would take.'
              : 'With both directions on, a single dropout costs two readings: the fall '
                + 'into it and the climb back out.'}`,
          'fall')}

        ${block('rangeOn', 'Minimum / maximum',
          'Remove readings outside what this sensor can physically report',
          `${lim('rangeMin', 'Minimum', 'Readings below this are removed. Blank for no floor.', c.rangeOn)}
           ${lim('rangeMax', 'Maximum', 'Readings above this are removed. Blank for no ceiling.', c.rangeOn)}`,
          `Compared against <b>Value</b> as exported, in ${esc(unit)}, before any rollover
           correction. Leave an end blank to bound only the other one.`,
          'range')}
      </div>`;
  }

  // ── the filter, explained (issue #80) ──────────────────────────────────────
  // The panel could say what it removed and never what the test was, which
  // leaves "why did that reading go?" answerable only by opening a PDF. This is
  // the answer in the app: the spec's two components as a flowchart, and a
  // worked example whose verdicts come out of the same walk357() every import
  // goes through — so the diagram cannot drift away from the code.
  //
  // Both drawings use the theme's custom properties rather than hex, so they
  // follow light and dark without being redrawn.

  const F357_ARROW = `
    <defs>
      <marker id="f357-arr" viewBox="0 0 8 8" refX="7.5" refY="4"
              markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L8 4 L0 8 Z" fill="var(--muted)"/>
      </marker>
    </defs>`;

  // Centred lines inside a shape. A plain string is a heading line; ['x', 1] is
  // a smaller muted one.
  function f357Lines(cx, y, h, lines) {
    const lh = 13;
    const top = y + h / 2 - (lines.length - 1) * lh / 2 + 4;
    return lines.map((ln, i) => {
      const [txt, small] = Array.isArray(ln) ? ln : [ln, false];
      return `<text x="${cx}" y="${(top + i * lh).toFixed(1)}" text-anchor="middle"
                    font-size="${small ? 10 : 11.5}" fill="var(--${small ? 'muted' : 'text'})"
                    ${small ? '' : 'font-weight="600"'}>${esc(txt)}</text>`;
    }).join('');
  }

  const f357Box = (x, y, w, h, lines, strong) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="var(--panel-sub)"
          stroke="var(--${strong ? 'accent' : 'border'})" stroke-width="${strong ? 1.6 : 1}"/>
    ${f357Lines(x + w / 2, y, h, lines)}`;

  const f357Pill = (x, y, w, h, lines) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="var(--subtle)"
          stroke="var(--border)"/>
    ${f357Lines(x + w / 2, y, h, lines)}`;

  const f357Diamond = (cx, cy, rx, ry, lines) => `
    <polygon points="${cx},${cy - ry} ${cx + rx},${cy} ${cx},${cy + ry} ${cx - rx},${cy}"
             fill="var(--panel-sub)" stroke="var(--border)"/>
    ${f357Lines(cx, cy - ry, ry * 2, lines)}`;

  const f357Arrow = (d, dashed) => `
    <path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.3"
          ${dashed ? 'stroke-dasharray="4 3"' : ''} marker-end="url(#f357-arr)"/>`;

  const f357Tag = (x, y, txt, anchor) => `
    <text x="${x}" y="${y}" font-size="9.5" fill="var(--muted)"
          text-anchor="${anchor || 'start'}">${esc(txt)}</text>`;

  // Figures 2, 6 and 9 of the spec, boiled down to the shape of the thing: get
  // a series started, walk it, and start a new one when it breaks.
  function flowSvg() {
    return `
      <svg class="f357-fig" viewBox="0 0 720 660" role="img"
           aria-label="Flowchart: establish start continuity, then establish continuity, restarting a new series when four readings in a row fail">
        ${F357_ARROW}
        ${f357Pill(170, 12, 300, 32, ['Start at the newest reading'])}
        ${f357Arrow('M320 44 V60')}
        ${f357Box(170, 62, 300, 54,
          ['Establish Start Continuity', ['current against a fixed start:', 1], ['≤ 3, then ≤ 5, then ≤ 7', 1]], true)}
        ${f357Arrow('M320 116 V134')}
        ${f357Diamond(320, 170, 118, 34, ['four good in a row?'])}
        ${f357Arrow('M438 170 H498')}
        ${f357Tag(462, 163, 'no')}
        ${f357Box(500, 146, 170, 48, [['drop the start,', 1], ['begin one reading earlier', 1]])}
        ${f357Arrow('M585 146 V88 H474')}
        ${f357Arrow('M320 204 V230')}
        ${f357Tag(328, 222, 'yes')}
        ${f357Box(170, 232, 300, 54,
          ['Establish Continuity', ['current against next ≤ 3,', 1], ['next-next ≤ 5, the third ≤ 7', 1]], true)}
        ${f357Arrow('M320 286 V304')}
        ${f357Diamond(320, 340, 118, 34, ['passes the test?'])}
        ${f357Arrow('M438 340 H498')}
        ${f357Tag(462, 333, 'yes')}
        ${f357Box(500, 312, 170, 56,
          ['mark it Good', ['every Suspect back to the', 1], ['last good becomes Bad', 1]])}
        ${f357Arrow('M585 312 V258 H474')}
        ${f357Arrow('M320 374 V398')}
        ${f357Tag(328, 390, 'no')}
        ${f357Box(170, 400, 300, 40, ['mark Suspect · step back one'])}
        ${f357Arrow('M320 440 V464')}
        ${f357Diamond(320, 500, 118, 34, ['four failures in a row?'])}
        ${f357Arrow('M202 500 H130 V272 H168')}
        ${f357Tag(196, 492, 'no', 'end')}
        ${f357Arrow('M320 534 V564')}
        ${f357Tag(328, 552, 'yes')}
        ${f357Box(170, 566, 300, 44,
          ['continuity broken', ['restart the series at the first failure', 1]])}
        ${f357Arrow('M470 588 H695 V100 H474')}
        ${f357Tag(688, 440, 'and start again there', 'end')}
        ${f357Arrow('M170 244 H85 V594', true)}
        ${f357Pill(20, 596, 130, 40, [['no more data —', 1], ['suspects become Bad', 1]])}
      </svg>`;
  }

  // The same fourteen readings the code sees, with the colours coming back out
  // of walk357() rather than being chosen to look convincing.
  const F357_EX = [12, 14, 15, 17, 18, 60, 20, 21, 0, 23, 24, 26, 27, 29];
  const F357_SPEC = { small: 3, medium: 5, large: 7, cycle: 2048, breakCount: 4, startTests: 4 };

  function exampleSvg() {
    const n = F357_EX.length;
    const st = walk357(F357_EX.map((_, i) => i), Float64Array.from(F357_EX), n, true, F357_SPEC);

    const x  = i => 44 + i * 48;
    const hi = Math.max(...F357_EX), lo = Math.min(...F357_EX);
    const y  = v => 168 - (v - lo) / (hi - lo) * 118;

    // The cursors skip anything already Bad, which is why the third comparison
    // below reaches past the dropout rather than into it.
    const nextLive = k => { for (let j = k + 1; j < n; j++) if (st[j] !== AD_BAD) return j; return -1; };
    const cur = 5;                                     // the spike
    const tgt = [];
    for (let k = 0, at = cur; k < 3; k++) { at = nextLive(at); if (at < 0) break; tgt.push(at); }
    const steps = [F357_SPEC.small, F357_SPEC.medium, F357_SPEC.large];
    const tests = tgt.map((j, k) => {
      const d = F357_EX[j] - F357_EX[cur];
      return { j, d, step: steps[k], ok: d >= 0 && d <= steps[k],
               name: ['the next reading', 'the next-next', 'the one after that'][k] };
    });

    const kept = F357_EX.map((_, i) => i).filter(i => st[i] !== AD_BAD);
    const line = idx => idx.map((i, k) => `${k ? 'L' : 'M'}${x(i)} ${y(F357_EX[i]).toFixed(1)}`).join(' ');

    const dots = F357_EX.map((v, i) => {
      const bad = st[i] === AD_BAD;
      return `<circle cx="${x(i)}" cy="${y(v).toFixed(1)}" r="${i === cur ? 6 : 4.5}"
                      fill="var(--${bad ? 'bad' : 'ok'})"
                      stroke="var(--panel)" stroke-width="${i === cur ? 2 : 1}"/>
              <text x="${x(i)}" y="${(y(v) - 9).toFixed(1)}" font-size="9.5" text-anchor="middle"
                    fill="var(--${bad ? 'bad' : 'muted'})">${v}</text>`;
    }).join('');

    const links = tests.map((t, k) => `
      <path d="M${x(cur)} ${y(F357_EX[cur]).toFixed(1)} L${x(t.j)} ${y(F357_EX[t.j]).toFixed(1)}"
            stroke="var(--bad)" stroke-width="1.1" stroke-dasharray="3 3" opacity=".75" fill="none"/>
      <circle cx="${x(t.j)}" cy="${(y(F357_EX[t.j]) + 15).toFixed(1)}" r="7.5"
              fill="var(--panel)" stroke="var(--bad)"/>
      <text x="${x(t.j)}" y="${(y(F357_EX[t.j]) + 18.5).toFixed(1)}" font-size="9.5"
            text-anchor="middle" fill="var(--bad)">${k + 1}</text>`).join('');

    const rows = tests.map((t, k) => `
      <text x="44" y="${216 + k * 18}" font-size="10.5" fill="var(--text)">
        <tspan fill="var(--bad)">${k + 1}</tspan>
        <tspan dx="6">vs ${esc(t.name)}: ${t.d < 0 ? '−' : ''}${Math.abs(t.d)}, ${
          t.ok ? `inside 0 to ${t.step} — passes` : `outside 0 to ${t.step} — fails`}</tspan>
      </text>`).join('');

    const verdict = tests.every(t => !t.ok)
      ? ['All three fail, so the 60 is marked Suspect — and Bad as soon as a reading behind it passes.',
         'The 0 goes the same way; everything else is within 3 of its neighbour and survives untouched.']
      : ['The comparisons above use the specification\'s own 3, 5 and 7.', ''];

    return `
      <svg class="f357-fig" viewBox="0 0 720 300" role="img"
           aria-label="Fourteen readings: a spike of 60 and a dropout of 0 are removed, the rest kept">
        ${F357_ARROW}
        <circle cx="48" cy="17" r="4.5" fill="var(--ok)"/>
        ${f357Tag(58, 21, 'kept')}
        <circle cx="100" cy="17" r="4.5" fill="var(--bad)"/>
        ${f357Tag(110, 21, 'removed')}
        ${f357Arrow('M668 36 H472')}
        ${f357Tag(464, 40, 'the walk runs this way', 'end')}
        <path d="${line(F357_EX.map((_, i) => i))}" fill="none" stroke="var(--muted)"
              stroke-width="1" opacity=".45" stroke-dasharray="3 3"/>
        <path d="${line(kept)}" fill="none" stroke="var(--ok)" stroke-width="1.8"/>
        ${links}
        ${dots}
        <line x1="34" y1="182" x2="686" y2="182" stroke="var(--border)"/>
        ${f357Tag(44, 196, 'older')}
        ${f357Tag(676, 196, 'newest', 'end')}
        ${rows}
        <text x="44" y="272" font-size="10.5" fill="var(--muted)">
          <tspan x="44">${esc(verdict[0])}</tspan>
          <tspan x="44" dy="14">${esc(verdict[1])}</tspan>
        </text>
      </svg>`;
  }

  function explain() {
    const c = ad.cfg;
    const tweaked = c.small !== 3 || c.medium !== 5 || c.large !== 7;
    Modal.open({
      title: 'How the 357 filter works',
      wide: true,
      html: `
      <div class="f357">
        <p>ERTS packets arrive over radio, and radio loses and mangles them. The Bureau's
           <b>3-5-7 filter</b> does not ask whether a reading looks reasonable on its own — a
           corrupt packet can read 300 mm perfectly plausibly. It asks whether a reading is
           <em>continuous with the ones around it</em>, and throws out what is not.</p>

        <h3>The test</h3>
        <p>A reading passes if it is within <b>3</b> of the next reading, or within <b>5</b> of the
           next-next, or within <b>7</b> of the one after that. Three chances, widening as they
           reach further ahead, so a single lost packet does not condemn its neighbours.
           ${tweaked ? `Your panel is currently set to <b>${esc(c.small)}</b>, <b>${esc(c.medium)}</b>
             and <b>${esc(c.large)}</b> — the diagrams below use the spec's own numbers.` : ''}</p>
        <p>The comparison depends on what the sensor is. A <b>rain accumulator</b> only ever climbs,
           so its difference is signed and any fall is a failure by construction. A <b>water level</b>
           moves both ways, so the size of the change is what counts. That is the one thing the
           <em>reads as</em> selector on each import changes.</p>

        <h3>It walks backwards</h3>
        <p>The list is in ascending time order and the filter starts at the <b>newest</b> reading,
           testing each one against what comes <em>after</em> it. That is not an implementation
           detail: the newest reading is the one you have the most reason to trust as a starting
           point, and it means a reading is judged by the record that followed it rather than the
           one that led up to it.</p>

        <h3>Good, Suspect, Bad</h3>
        <p>Nothing is thrown away on first failure. A reading that fails all three comparisons is
           <b>Suspect</b>, and stays that way until something behind it passes — at which point
           every Suspect between the two is settled as <b>Bad</b>. A reading that passes is
           <b>Good</b>. Suspects that never get resolved are Bad at the end of the walk.</p>

        <h3>Two components</h3>
        <p>Getting a series started is a different problem from keeping it going, so the spec has
           two parts. <b>Establish Start Continuity</b> needs four good readings in a row before it
           will believe a series exists at all; if it cannot find them, the start reading itself is
           the problem and it steps back and tries again. <b>Establish Continuity</b> then walks the
           rest of the record.</p>
        ${flowSvg()}

        <h3>Breaking, and starting again</h3>
        <p>Four consecutive failures are not noise — they are a gap. A dead radio link, a flat
           battery, a site visit. Rather than delete everything that follows, the filter declares
           the continuity broken and hands the run back to Start Continuity to begin a new series at
           the first failure. This is why a record with a week-long outage in it comes through as two
           good series rather than one good one and a week of casualties.</p>

        <h3>A worked example</h3>
        <p>Fourteen readings from an accumulator, with one corrupt spike and one dropout. The
           colours below are not illustrative — they are what <code>walk357()</code> returns when it
           is handed exactly these numbers, from the same code the imports go through.</p>
        ${exampleSvg()}

        <h3>Rollovers</h3>
        <p>The counter in the field only counts to ${esc(c.cycle - 1)}, then wraps to zero. A wrap
           looks exactly like a huge fall, and so does a corrupt packet — so this app removes the
           noise <em>first</em>, and only then treats a fall between two surviving readings as a
           possible wrap. What makes a fall a rollover is not its size but the step it leaves
           behind: 2045 → 2 is a wrap because it is really a step of 5, while 1976 → 125 would be a
           step of 197 and is not.</p>

        <h3>Repeats are not readings</h3>
        <p>ARRO re-sends an observation several times, so the same reading arrives at :12, :13, :14
           and :18 past the minute. Anything that does not advance the clock is set aside before the
           filter runs. Four re-sends of one corrupt packet otherwise satisfy "any four consecutive
           data form a continuous set" and survive as a series of their own — which is what the
           <b>minimum gap</b> setting exists to collapse.</p>

        <h3>The numbers are counts, not millimetres</h3>
        <p>3, 5, 7 and ${esc(c.cycle)} are all in the units ARRO exported in the <b>Value</b> column.
           They are not rescaled by a station's bucket size — doing that would quietly move every
           threshold. Bucket size is a display conversion only, shown against the raw tip count when
           you click a reading.</p>

        <h3>The other filters in this panel</h3>
        <p>Only the 3-5-7 test and the rollover correction come from the spec. The rest are gates
           this app adds, each with its own switch so you can see what it is doing by turning it
           off:</p>
        <ul>
          <li><b>Rate of rise</b> — removes readings that climb faster than a gauge plausibly can,
              each compared with the one before it. It claims the step and nothing more: a corrupt
              plateau costs its first reading here, and the rest is the continuity test's business.
              An accumulator is only tested upwards, since a fall belongs to the rollover and 357
              tests.</li>
          <li><b>Minimum / maximum</b> — removes readings outside what the sensor can physically
              report, before the continuity test runs, so a value nothing could have produced never
              gets a vote on its neighbours.</li>
        </ul>
        <p>Both run before the 357 walk and are marked separately on the chart — a square for out of
           range, a triangle for too fast, a cross for the 357 test itself — so a removal always says
           which filter made the call.</p>

        <p class="f357-src">Hydrology Raw Data Filtering Program Specification v2.1, Commonwealth
           Bureau of Meteorology, May 2009, with the 1998 first edition. Both are in
           <code>docs/</code>.</p>
      </div>`,
    });
  }

  // ── what the chart says about itself (#141) ─────────────────────────────────
  // The house answer for a graphic with no DOM to annotate is three parts, and a
  // graphic needs all three (docs/design-system.md §3): a name carrying the
  // headline number and updated whenever the picture is, a sentence saying what
  // it shows, and the data as a real table one activation away. This chart had
  // none of them — `aria-label="Sensor readings over time"` told a screen reader
  // the same thing whether it was holding twelve readings or twelve thousand,
  // and the only route to a number was hovering a pixel with a mouse.
  //
  // The numbers, once, so the name and the table cannot disagree.
  function chartFacts() {
    const vis = shown();
    const v = view();
    if (!vis.length || !v) return null;
    let inView = 0, removed = 0, lo = Infinity, hi = -Infinity;
    const per = [];
    for (const s of vis) {
      const tr = tracks(s);
      const track = ad.mode === 'raw' ? tr.raw : tr.filt;
      const i0 = lower(track.t, track.n, v.t0), i1 = lower(track.t, track.n, v.t1);
      let slo = Infinity, shi = -Infinity, sum = 0;
      for (let k = i0; k < i1; k++) {
        const y = track.y[k];
        if (y < slo) slo = y;
        if (y > shi) shi = y;
        sum += y;
      }
      const f = runFilter(s, ad.cfg);
      const j0 = lower(s.t, s.n, v.t0), j1 = lower(s.t, s.n, v.t1);
      let cut = 0;
      for (let i = j0; i < j1; i++) if (adCut(f.status[i])) cut++;
      const n = Math.max(0, i1 - i0);
      per.push({
        s, n, cut, i0, i1, j0, j1, f, track,
        lo: n ? slo : null, hi: n ? shi : null,
        net: n && ad.transform === 'value' ? track.y[i1 - 1] - track.y[i0] : sum,
      });
      inView += n; removed += cut;
      if (n) { if (slo < lo) lo = slo; if (shi > hi) hi = shi; }
    }
    return { vis, v, per, inView, removed, unit: vis[0].unit || '',
             lo: isFinite(lo) ? lo : null, hi: isFinite(hi) ? hi : null };
  }

  // Parts 1 and 2 of the pattern, plus the sentence that says where the operable
  // version is. Rebuilt on every render of the stage, which is what makes it a
  // name rather than a caption.
  function chartName() {
    const f = chartFacts();
    const how = 'Drag to pan, scroll or + and − to zoom, Shift+scroll or a sideways wheel to pan, '
              + 'Shift+drag a box to zoom to it, '
              + 'Alt+drag up or down to rescale the vertical axis, arrow keys to step, '
              + '0 to reset both axes. '
              + 'Every value is in the readings table below the chart.';
    if (!f) return `Chart, empty — no series is shown. ${how}`;
    const shape = ad.chartType === 'dots' ? 'Point chart' : ad.chartType === 'step' ? 'Step chart' : 'Line chart';
    const names = f.vis.slice(0, 3).map(s => s.label).join(', ')
                + (f.vis.length > 3 ? ` and ${f.vis.length - 3} more` : '');
    const range = f.lo == null ? '' : `, ${fmtVal(f.lo)} to ${fmtVal(f.hi)} ${f.unit}`.trimEnd();
    return `${shape} of ${f.vis.length} series — ${names}. `
         + `${f.inView.toLocaleString()} reading${f.inView === 1 ? '' : 's'} shown, `
         + `${fmtFull(f.v.t0)} to ${fmtFull(f.v.t1)}${range}. `
         + `${f.removed.toLocaleString()} removed by the filters in this window. ${how}`;
  }

  function overviewName() {
    const ex = extent();
    if (!ex) return 'Overview of the whole record — nothing loaded';
    const v = view();
    return `Overview of the whole record, ${fmtFull(ex.t0)} to ${fmtFull(ex.t1)}. `
         + `The box marks the window drawn on the chart above, `
         + `${fmtFull(v.t0)} to ${fmtFull(v.t1)}. `
         + `Drag inside the box to move the window, or drag either edge to resize it; `
         + `press outside it to bring the window there.`;
  }

  // The same sentence for the other axis (#191).
  function vOverviewName() {
    const ex = vExtent();
    if (!ex) return 'Vertical range of the whole record — nothing loaded';
    const v = view();
    const yr = v ? yRange(v) : null;
    const unit = shown()[0]?.unit || '';
    return `Vertical range of the whole record, ${fmtVal(ex.lo)} to ${fmtVal(ex.hi)} ${unit}`.trimEnd()
         + `. The box marks the range drawn on the chart, ${
             yr ? `${fmtVal(yr.lo)} to ${fmtVal(yr.hi)}` : 'not set'}. `
         + `Drag inside the box to move the range, or drag the top or bottom edge to resize it; `
         + `press outside it to bring the range there. Dragging sets the vertical axis to Fixed; `
         + `Reset puts it back to ${AD_Y_LABEL[ad.yStash ? ad.yStash.yMode : ad.yMode] || 'its setting'}.`;
  }

  function mainHtml() {
    if (!ad.series.length) return emptyHtml();
    return `
      ${provenanceHtml()}
      <h2 class="sr-only">${ad.source === 'field' ? 'Field readings' : 'Imported readings'}, charted</h2>
      ${toolbarHtml()}
      <!-- Two elements, two jobs, and keeping them apart is the point. The stage
           is a *control* — it pans, it zooms, it pins a reading — so it is a tab
           stop with a name saying what operating it does. The picture inside it
           is a picture, so it is role="img" with a name carrying the numbers.
           Marking the stage itself role="img" would be the thing §3 forbids: a
           graphic that is a shortcut for controls beside it may be named as a
           picture while being clicked (pattern 8), and this is not that shape —
           arbitrary pan and zoom exist nowhere else on the tab. -->
      <!-- The stage and the two navigators that frame it (#191): the whole
           record along the bottom, the whole vertical range down the right.
           They are one grid rather than three stacked elements because both
           navigators have to be exactly as long as the axis they steer, and
           the only thing that knows how long that is is the stage itself. -->
      <div class="ad-plot${ad.full ? ' is-full' : ''}" id="ad-plot">
        <!-- Reset and full screen. Over the chart's top-right corner rather
             than in the toolbar for the same reason the map puts its own two
             there: they are about the picture in front of you, not about what
             is being drawn, and a hand that has just finished dragging the
             chart is already here. -->
        <div class="ad-stage-acts">
          <button type="button" class="ad-stage-btn" onclick="ArroData.resetView()"
                  title="Reset the view — the whole record, and the vertical axis back to ${
                    escAttr(AD_Y_LABEL[ad.yStash ? ad.yStash.yMode : ad.yMode] || 'its setting')}"
                  aria-label="Reset the chart view">↺</button>
          <button type="button" class="ad-stage-btn" onclick="ArroData.toggleFull()"
                  aria-pressed="${ad.full}"
                  title="${ad.full ? 'Exit full screen (Escape)' : 'Full screen'}"
                  aria-label="${ad.full ? 'Exit full screen' : 'Chart full screen'}">⛶</button>
        </div>
        <div class="ad-stage" id="ad-stage" tabindex="0"
             aria-label="Chart window — arrow keys to step, + and − to zoom, Shift+scroll to pan sideways, 0 to reset both axes, Escape to unpin">
          <svg id="ad-svg" role="img" aria-label="${escAttr(chartName())}"></svg>
          <div class="ad-tip" id="ad-tip" hidden></div>
        </div>
        <svg id="ad-vov" class="ad-vov" role="img"
             aria-label="${escAttr(vOverviewName())}"></svg>
        <svg id="ad-ov" class="ad-ov" role="img"
             aria-label="${escAttr(overviewName())}"></svg>
      </div>
      <div id="ad-readout" class="ad-readout">${readoutHtml()}</div>
      ${tableDetailsHtml()}
      ${compareHtml()}`;
  }

  // Part 3: the data, as a real table, one activation away. A `<details>` rather
  // than a second panel because it is the same numbers a second way and not a
  // second thing to read — and built only while it is open, because the readings
  // table is up to AD_TABLE_MAX rows and a pan should not pay for it.
  const AD_TABLE_MAX = 300;
  // …and full screen, where there is a screen to put them on (#191).
  const AD_TABLE_MAX_FULL = 3000;

  // The mark that goes with each verdict, so a row in the table and a cross on
  // the chart are visibly the same fact. AD_GOOD and AD_UNKNOWN have no mark
  // because nothing is drawn for them — the reading is simply on the line.
  const AD_MARK_FOR = {
    [AD_BAD]: 'removed', [AD_RANGE]: 'range', [AD_RATE]: 'rate',
    [AD_FALL]: 'fall',   [AD_OOS]:   'repeat',
  };

  function tableDetailsHtml() {
    return `
      <details class="ad-table" id="ad-table" ${ad.tableOpen ? 'open' : ''}
               ontoggle="ArroData.tableToggle(this)">
        <summary>Readings as a table
          <span class="small">— the numbers behind the chart, for the window on screen</span></summary>
        <div id="ad-table-body">${ad.tableOpen ? tableHtml() : ''}</div>
      </details>`;
  }

  // ── The readings table, full screen (#191) ─────────────────────────────────
  // The table under the chart is a disclosure in a column that is already
  // holding a chart, two navigators and a toolbar — which leaves it about eight
  // rows of a three-hundred-row list. That is fine as "the numbers behind the
  // picture" and useless as a place to work, and working in it is exactly what
  // editing readings turned it into.
  //
  // A modal rather than a second full-screen mode: the chart's full screen is a
  // *view* of something that stays interactive underneath, and this is not —
  // while the table is up it is the only thing on screen, which is the whole
  // reason to put it up. Modal already owns the Escape key, the Tab walls and
  // handing focus back, so none of that is re-implemented here.
  let adTableModalOpen = false;

  function openTableModal() {
    adTableModalOpen = true;
    Modal.open({
      title: `Readings — ${ad.source === 'field' ? 'field data' : 'imported'}`,
      wide: true,
      html: `<div id="ad-table-modal">${tableHtml(true)}</div>`,
    });
    // Modal.close() can also be reached by Escape, the ✕ and the backdrop, and
    // none of them know about this flag — so the element's absence is what the
    // rest of the module tests, and this is only the fast path.
    const el = document.getElementById('app-modal');
    if (el) el.addEventListener('click', () => { if (!document.getElementById('ad-table-modal')) adTableModalOpen = false; });
  }

  function closeTableModal() { adTableModalOpen = false; Modal.close(); }

  function renderTableModal() {
    const el = document.getElementById('ad-table-modal');
    if (!el) { adTableModalOpen = false; return; }
    el.innerHTML = tableHtml(true);
  }

  function tableHtml(big) {
    const f = chartFacts();
    if (!f) return '<p class="small ad-flush">No series is shown — tick one on the left.</p>';

    const summary = `
      <div class="table-wrap">
        <table>
          <caption class="sr-only">One row per series shown, over the window on the chart</caption>
          <thead><tr>
            <th scope="col">Series</th>
            <th scope="col">Readings</th>
            <th scope="col">Lowest</th>
            <th scope="col">Highest</th>
            <th scope="col">${ad.transform === 'value' ? 'Net' : 'Total'}</th>
            <th scope="col">Removed</th>
          </tr></thead>
          <tbody>
            ${f.per.map(p => `
              <tr>
                <td>${esc(p.s.label)}</td>
                <td class="small">${p.n.toLocaleString()}</td>
                <td class="small">${p.lo == null ? '—' : esc(fmtVal(p.lo))}</td>
                <td class="small">${p.hi == null ? '—' : esc(fmtVal(p.hi))}</td>
                <td class="small">${p.n ? esc(fmtVal(p.net)) : '—'}</td>
                <td class="small">${p.cut.toLocaleString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    // Every reading in the window would be a hundred thousand rows on a wide
    // one. Capped, and the cap is *said* rather than silently applied — the two
    // Export buttons in the toolbar are the uncapped answer and this points at
    // them. The cap is raised full screen, where there is a screen to put the
    // rows on and the reason for being there is to work through them.
    const cap = big ? AD_TABLE_MAX_FULL : AD_TABLE_MAX;
    const rows = [];
    let total = 0;
    for (const p of f.per) {
      for (let i = p.j0; i < p.j1; i++) {
        total++;
        if (rows.length >= cap) continue;
        const st = p.f.status[i];
        const picked = isPicked(p.s.key, i);
        const edited = p.s.edited && p.s.edited[i];
        rows.push(`
          <tr class="${picked ? 'ad-row--picked' : ''}${edited ? ' ad-row--edited' : ''}">
            <td class="ad-row-pick">
              <input type="checkbox" ${picked ? 'checked' : ''}
                     aria-label="Pick the ${escAttr(p.s.label)} reading at ${escAttr(fmtFull(p.s.t[i]))}"
                     onchange="ArroData.pickToggle('${p.s.key}', ${i})"></td>
            <td>${esc(p.s.label)}</td>
            <td class="small mono">${esc(fmtFull(p.s.t[i]))}</td>
            <!-- Editable in place (#191). A number input rather than a
                 contenteditable cell: it gets the right keyboard on a phone,
                 it refuses non-numbers without a validator, and its value
                 round-trips without any parsing of the DOM. It fires on
                 change, not on input — an edit re-runs the 357 walk over the whole series
                 and rebuilds this table, which is not something to do per
                 keystroke. -->
            <td class="small ad-row-val">
              <input type="number" step="any" class="ad-cell" value="${escAttr(p.s.v[i])}"
                     aria-label="Value of the ${escAttr(p.s.label)} reading at ${escAttr(fmtFull(p.s.t[i]))}"
                     onchange="ArroData.editCell('${p.s.key}', ${i}, 'v', this.value)">
              ${edited ? '<span class="ad-edited-dot" title="Changed since it was loaded">•</span>' : ''}
            </td>
            <td class="small col-optional">${esc(p.s.unit || '')}</td>
            <td class="small ad-row-q">
              <input type="text" class="ad-cell ad-cell--q" list="ad-qcodes-tbl"
                     value="${escAttr(p.s.qcodes[p.s.q[i]] || '')}"
                     aria-label="Quality code of the ${escAttr(p.s.label)} reading at ${escAttr(fmtFull(p.s.t[i]))}"
                     onchange="ArroData.editCell('${p.s.key}', ${i}, 'q', this.value)"></td>
            <!-- The verdict says the word and shows the mark the chart draws
                 for it, so a row here and a cross out there are visibly the
                 same fact rather than two things to correlate by timestamp. -->
            <td class="small ad-row-verdict">${adMarkSvg(AD_MARK_FOR[st] || '')}${esc(AD_STATUS_LABEL[st])}</td>
          </tr>`);
      }
    }
    const capped = total > rows.length;
    const codes = [...new Set(f.per.flatMap(p => p.s.qcodes).filter(Boolean))].sort();

    return `${summary}
      <div class="ad-table-acts">
        <p class="small ad-table-note" id="ad-table-note">
          ${capped
            ? `The first ${rows.length.toLocaleString()} of ${total.toLocaleString()} readings in this
               window. ${big ? 'Zoom the chart in for fewer' : 'Open it full screen for more, zoom in for fewer'},
               or use <b>Kept CSV</b> / <b>All + verdict CSV</b> under <b>Export</b> for all of them.`
            : `All ${total.toLocaleString()} reading${total === 1 ? '' : 's'} in this window.`}
          ${ad.picked.size ? ` <b>${ad.picked.size.toLocaleString()} picked</b> — the editor is under the chart.` : ''}
        </p>
        ${big
          ? `<button onclick="ArroData.closeTableModal()" title="Back to the chart">Close</button>`
          : `<button onclick="ArroData.openTableModal()"
                     title="Open the readings on the whole screen, with more rows">⛶ Full screen</button>`}
      </div>
      <datalist id="ad-qcodes-tbl">${codes.map(c => `<option value="${escAttr(c)}">`).join('')}</datalist>
      <div class="table-wrap ${big ? 'ad-table-full' : 'tall'}" role="region" tabindex="0" aria-labelledby="ad-table-note">
        <table>
          <caption class="sr-only">Every reading the chart draws in this window, with the filter's verdict against it. The value and quality cells can be typed into, and the first column picks a reading for the editor under the chart.</caption>
          <thead><tr>
            <th scope="col"><span class="sr-only">Picked</span></th>
            <th scope="col">Series</th>
            <th scope="col">Reading</th>
            <th scope="col">Value</th>
            <th scope="col" class="col-optional">Unit</th>
            <th scope="col">Quality</th>
            <th scope="col">Verdict</th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
  }

  // One cell, typed into. Goes through the same three steps every other edit
  // does — keep the original, mark the row, drop the caches — so a value typed
  // here and a value dragged on the chart are the same kind of change and the
  // rail counts them together.
  function editCell(key, i, which, raw) {
    const s = find(key);
    if (!s || !(i >= 0 && i < s.n)) return;
    if (which === 'v') {
      const num = parseFloat(raw);
      if (!isFinite(num)) { note('That is not a number — the reading is unchanged.', true); renderTable(true); return; }
      if (num === s.v[i]) return;
      keepOriginal(s);
      s.v[i] = num;
    } else {
      const at = qualityIndex(s, raw);
      if (at === s.q[i]) return;
      keepOriginal(s);
      s.q[i] = at;
    }
    s.edited[i] = 1;
    invalidate(s);
    // No esc(): note() writes through textContent, so escaping here would put
    // a literal &amp; on screen for a station whose name has an ampersand.
    afterEdit(`${s.label} at ${fmtFull(s.t[i])} ${
      which === 'v' ? `set to ${fmtVal(s.v[i])}` : `coded ${s.qcodes[s.q[i]] || '(no code)'}`}.`);
  }

  // Same shape as the comparison panes: remembered across re-renders, and drawn
  // the first time it is actually on screen.
  function tableToggle(el) {
    ad.tableOpen = !!el.open;
    if (ad.tableOpen) renderTable(true);
  }

  // Rebuilt where the comparison panes are — off a view change, which is the one
  // place that is not also every mouse move. Skipped mid-drag: a pan would
  // otherwise rebuild three hundred rows a frame, and the pointerup redraw
  // catches it up.
  function renderTable(force) {
    const box  = document.getElementById('ad-table');
    const body = document.getElementById('ad-table-body');
    if (!box || !box.open || !body) return;
    if (!force && (ad.drag || ad.ovDrag || ad.vovDrag)) return;
    const v = view();
    const sig = [ad.mode, ad.transform, cfgKey(ad.cfg, 'tbl'),
                 v ? `${Math.round(v.t0)}-${Math.round(v.t1)}` : '',
                 shown().map(s => s.key).join(',')].join('|');
    if (!force && sig === ad.tableSig) return;
    ad.tableSig = sig;
    body.innerHTML = tableHtml();
  }

  // Raw and filtered on one chart answers "what was removed". Raw and filtered
  // as two charts answers "what shape did the record have before, and after" —
  // which is a different question, and the one somebody asks when deciding
  // whether the settings are right. Folded away by default: it is a second
  // look, not the main one.
  function compareHtml() {
    const vis = shown();
    const tot  = vis.reduce((a, s) => a + s.n, 0);
    const kept = vis.reduce((a, s) => a + runFilter(s, ad.cfg).stats.good, 0);
    return `
      <details class="ad-compare" id="ad-compare" ${ad.compare ? 'open' : ''}
               ontoggle="ArroData.compareToggle(this)">
        <summary>Side by side <span class="small">— as recorded against what the filters kept</span></summary>
        <div class="ad-compare-grid">
          <figure>
            <figcaption>As recorded <span class="small">${tot.toLocaleString()} readings</span></figcaption>
            <svg id="ad-cmp-raw" role="img"
                 aria-label="As recorded — every one of the ${tot.toLocaleString()} readings the ${
                   ad.source === 'field' ? 'datastore returned' : 'export contains'}, over the visible window,
                   with the removals marked. The same numbers are in the readings table above."></svg>
          </figure>
          <figure>
            <figcaption>Filtered <span class="small">${kept.toLocaleString()} kept</span></figcaption>
            <svg id="ad-cmp-filt" role="img"
                 aria-label="Filtered — the ${kept.toLocaleString()} readings of ${tot.toLocaleString()}
                   that survived the filters, over the same window and the same vertical scale."></svg>
          </figure>
        </div>
        <p class="small ad-cfg-note">Both panes hold the same time window and the same vertical
           scale, so the only difference between them is the filters. Removals are marked on the
           left-hand pane. The scale follows the toolbar's <b>vertical axis</b> setting — with a
           spike in the record, <b>Kept</b> is what stops it flattening the right-hand pane.</p>
      </details>`;
  }

  function emptyHtml() {
    if (ad.source === 'field') return fieldEmptyHtml();
    return `
      <div class="ad-empty">
        <h2>Sensor data, filtered and drawn</h2>
        <p>Export a sensor from ARRO as CSV and drop it here. The filename carries
           the sensor id, so the import links itself back to the station without
           you choosing one.</p>
        <p>Every reading is kept exactly as exported. The Bureau's 3-5-7 continuity
           filter runs alongside it, never over it, so you can switch between what
           the gauge sent and what survives the test — and look at whatever it threw
           away.</p>
        <p class="small">
          Expected columns: Reading, Receive, Value, Unit, Data Quality, Raw Value.</p>
      </div>`;
  }

  function fieldEmptyHtml() {
    const q = fq();
    if (q.empty) {
      return `
        <div class="ad-empty">
          <h2>Nothing in that window</h2>
          <p>${esc(q.empty)}</p>
          <p class="small">A silent window and a window of zeroes are
             different claims, so nothing is drawn. Widen the window, or check that anything has
             been ingested for this station at all.</p>
        </div>`;
    }
    return `
      <div class="ad-empty">
        <h2>Our own telemetry</h2>
        <p>Readings that field stations sent us, out of the MegaNet datastore — pick a station,
           its sensors and a window on the left.</p>
        <p>The chart, the Bureau's 3-5-7 continuity filter and the inspector are the ARRO Data
           tab's, unchanged. What is different is where the numbers came from, and this tab never
           mixes the two: ARRO exports stay on the ARRO Data tab, and every chart and export here
           says so on its face.</p>
        <p class="small">
          Readings arrive as counts, so the 3/5/7 thresholds are counts too and the filter runs on
          them exactly as it does on an ARRO export. Any conversion the datastore recorded is shown
          beside the count, never instead of it.</p>
      </div>`;
  }

  // aria-pressed, because "on" was a background colour and nothing else: a
  // screen reader was given four identically-announced buttons and no way to
  // tell which one the chart was currently obeying (#137 made the same fix on
  // the region chips). The group's own name is the caption grp() draws above
  // it, so this is only the run of buttons.
  const seg = (group, cur, opts, fn) => `
    <div class="ad-seg">
      ${opts.map(([v, label, tip]) => `
        <button class="${cur === v ? 'on' : ''}" title="${escAttr(tip || label)}"
                aria-pressed="${cur === v}" aria-label="${escAttr(group)}: ${escAttr(label)}"
                onclick="ArroData.${fn}('${v}')">${esc(label)}</button>`).join('')}
    </div>`;

  // One captioned group on the toolbar. The caption is the group's accessible
  // name as well as its visible one — aria-labelledby rather than a repeated
  // aria-label — so the eye and a screen reader are told the same thing.
  //
  // Captions are the whole point of this arrangement. Before them the toolbar
  // was fourteen controls in one flat wrapping run: four identically-styled
  // segmented controls with nothing but a tooltip to say which governed what,
  // five bare checkboxes of two different kinds mixed together, and "90d" the
  // same shape of button as "PNG" — a jump-the-window control and a download
  // reading as siblings. Naming each cluster, splitting the checkboxes by what
  // they actually do, and putting a rule between "what is drawn" and "what is
  // shown and taken away" is the whole fix; nothing here changes what any
  // control does.
  //
  // Ids are static and the tab renders one chart at a time (both instances
  // share ad-stage / ad-svg), so they cannot collide.
  const grpId = name => 'ad-grp-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const grp = (name, body, cls) => `
    <div class="ad-grp${cls ? ' ' + cls : ''}" role="group" aria-labelledby="${grpId(name)}">
      <span class="ad-grp-cap" id="${grpId(name)}">${esc(name)}</span>
      <div class="ad-grp-body">${body}</div>
    </div>`;

  function toolbarHtml() {
    const anyFilt = ad.mode !== 'raw';
    return `
      <div class="ad-toolbar" id="ad-toolbar">
        <!-- Row one is what the chart is drawing: pick a series, pick what to
             read off it, pick how to draw it, pick the scale it is drawn
             against. Four choices, in the order somebody makes them. -->
        <div class="ad-toolbar-row">
          ${grp('Series', seg('Which series', ad.mode, [
            ['raw', 'Raw', 'Everything as exported'],
            ['filtered', 'Filtered', 'Only what passed the 357 test'],
            ['both', 'Both', 'Filtered over raw, so removals show'],
          ], 'setMode'))}
          ${grp('Reading', seg('Reading', ad.transform, [
            ['value', 'Value', 'The reading itself'],
            ['increment', 'Increment', 'Step between consecutive readings'],
            ['rate', 'Rate/h', 'Step divided by the hours between readings'],
          ], 'setTransform'))}
          ${grp('Style', seg('Chart style', ad.chartType, [
            ['line', 'Line', 'Straight between readings'],
            ['step', 'Step', 'Hold each reading until the next — how an accumulator behaves'],
            ['dots', 'Points', 'One mark per reading, nothing joined'],
          ], 'setChart'))}
          ${grp('Vertical axis',
            seg('Vertical axis', ad.yMode, [
              ['auto', 'Auto', 'Fit everything on screen, spikes included'],
              ['kept', 'Kept', 'Fit the readings that passed the filter — removals run off the top'],
              ['zero', 'Zero', 'Always include zero'],
              ['manual', 'Fixed', 'Type your own range'],
            ], 'setY') + (ad.yMode === 'manual' ? `
              <span class="ad-tool-grp ad-yrange">
                <input type="number" class="ad-num" value="${escAttr(ad.yMin)}" placeholder="min"
                       aria-label="Vertical axis minimum"
                       onchange="ArroData.setYRange('min', this.value)">
                <span class="small" aria-hidden="true">to</span>
                <input type="number" class="ad-num" value="${escAttr(ad.yMax)}" placeholder="max"
                       aria-label="Vertical axis maximum"
                       onchange="ArroData.setYRange('max', this.value)">
              </span>` : ''))}
        </div>
        <!-- Row two is the window on the record and what happens over it:
             which slice is on screen, what gets marked on it, what dragging on
             it does. Two kinds of tick, and they used to be one run of five —
             three that put marks on the chart beside two that change what a
             drag means, which is not one group however it is laid out. -->
        <div class="ad-toolbar-row">
          ${grp('Window', `
            <span class="ad-tool-grp">
              ${[['all', 'All'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']]
                .map(([k, l]) => `<button onclick="ArroData.preset('${k}')"
                       aria-label="Show ${l === 'All' ? 'the whole record' : 'the last ' + l}"
                       title="Show the last ${l === 'All' ? 'of everything' : l}">${l}</button>`).join('')}
            </span>`)}
          <!-- Each tick carries the mark it switches on (#191). "removed" was
               three words beside three identical boxes and the shapes they put
               on the chart were only written down inside draw(); a person who
               ticked one still had to work out which of five marks had just
               appeared. "removed" is the one that draws more than one shape —
               the 357 test's ✕ and whichever limit filters are running — so it
               shows them all, and the set it shows follows the switches in the
               filter panel rather than being a fixed three. -->
          ${grp('Mark', `
            <span class="ad-tool-grp">
              <label class="ad-chk${anyFilt ? '' : ' ad-chk--off'}" title="Mark every reading the filter rejected${
                anyFilt ? '' : ' — no filter is running on the Raw series'}">
                <input type="checkbox" ${ad.showRemoved ? 'checked' : ''} ${anyFilt ? '' : 'disabled'}
                       onchange="ArroData.setFlag('showRemoved', this.checked)">
                ${['removed', ad.cfg.rangeOn ? 'range' : '', ad.cfg.rateOn ? 'rate' : '',
                   ad.cfg.fallOn ? 'fall' : ''].filter(Boolean).map(adMarkSvg).join('')}
                removed</label>
              <label class="ad-chk" title="Mark repeat timestamps dropped before filtering">
                <input type="checkbox" ${ad.showDupes ? 'checked' : ''}
                       onchange="ArroData.setFlag('showDupes', this.checked)">
                ${adMarkSvg('repeat')} repeats</label>
              <label class="ad-chk" title="Mark where an accumulator wrap was corrected">
                <input type="checkbox" ${ad.showRollover ? 'checked' : ''}
                       onchange="ArroData.setFlag('showRollover', this.checked)">
                ${adMarkSvg('rollover')} rollovers</label>
            </span>`)}
          <!-- One choice, not two switches (#191). These were two independent
               tick boxes and both could be on at once — which a drag cannot
               honour: a press has one meaning, and onpointerdown had to pick
               between them silently. A segmented control with Pan in it says
               the truth, which is that this is a three-way choice whose third
               state is the one the chart spends most of its life in. Same
               shape as the four controls on the row above, so it reads as a
               choice rather than as a pair of settings. -->
          ${grp('Drag does', seg('What dragging the chart does', ad.dragMode, [
            ['pan',    'Pan',      'Drag moves the window along the record. Shift or Alt still reach either zoom.'],
            ['box',    'Box zoom', 'Drag a box to zoom to it — time and value together. Or hold Shift while dragging.'],
            ['y',      'Vertical', 'Drag up or down to rescale the vertical axis to that span; time stays put. Or hold Alt while dragging.'],
            ['select', 'Select',   'Drag a box to pick every reading in it, removed ones included, then edit or delete them. Click a picked reading and drag it up or down to move it.'],
          ], 'setDrag'))}
          ${ad.picked.size ? `
          ${grp('Picked', `
            <span class="ad-tool-grp">
              <b class="ad-picked-n">${ad.picked.size.toLocaleString()}</b>
              <button onclick="ArroData.pickAllInView()"
                      title="Pick every reading in the window on screen, removed ones included">all in view</button>
              <button onclick="ArroData.pickClear()" title="Clear the selection">clear</button>
            </span>`)}` : `
          ${grp('Picked', `
            <span class="ad-tool-grp">
              <button onclick="ArroData.pickAllInView()"
                      title="Pick every reading in the window on screen, removed ones included">all in view</button>
            </span>`)}`}
        </div>
        <!-- And row three is the four ways to take the chart away. Its own row
             rather than the end of row two: nothing on it changes what is on
             screen, and at every width the chart column actually gets, the four
             buttons wrapped onto a line of their own anyway — a row that is
             always the last line is easier to find than one that is sometimes
             the last line. Left-aligned with everything above it, so the
             captions read down a single rail. -->
        <div class="ad-toolbar-row">
          ${grp('Export', `
            <span class="ad-tool-grp">
              <button onclick="ArroData.exportCsv('kept')"
                      aria-label="Export the filtered readings as CSV"
                      title="The filtered series, as CSV">Kept CSV</button>
              <button onclick="ArroData.exportCsv('all')"
                      aria-label="Export every reading with the filter's verdict, as CSV"
                      title="Every reading with the filter's verdict against it">All + verdict CSV</button>
              <button onclick="ArroData.exportImg('svg')"
                      aria-label="Download the chart as an SVG image" title="Download the chart as SVG">SVG</button>
              <button onclick="ArroData.exportImg('png')"
                      aria-label="Download the chart as a PNG image" title="Download the chart as PNG">PNG</button>
            </span>`)}
        </div>
      </div>`;
  }

  // ── Editing readings (#191) ────────────────────────────────────────────────
  // Until now this tab could only ever describe a record. You could see that a
  // gauge had sent 1,613 mm for one reading at 22:09, see the 357 test throw it
  // out, see exactly why — and then had to open the file in something else to
  // do anything about it. That is the whole gap: the tab that knows most about
  // which readings are wrong was the one tab that could not fix one.
  //
  // **What an edit is, and what it is not.** These edits live in this browser
  // tab and nowhere else. Nothing is written back to ARRO, nothing is written to
  // the datastore, and closing the tab loses them. What they are *for* is the
  // two things people were doing by hand: producing a corrected CSV (the export
  // buttons read the edited values, because they read s.v and s.q), and seeing
  // what the filters make of a record once an obvious fault is corrected — the
  // 357 walk re-runs on every edit, so a spike deleted here immediately stops
  // dragging its neighbours down with it.
  //
  // Every edited series says so in the rail, and one press puts it back: `orig`
  // is a copy of the values and quality codes as they were read, taken at the
  // first edit and never after it, so revert means "as loaded" rather than
  // "one step ago". A deletion rebuilds the parallel arrays, and `orig` is cut
  // with the same mask so the two stay aligned — it is the rows that were
  // deleted, not the edits, that a revert cannot bring back, and the UI says so
  // before it does one.

  // The picked readings, as a set of "seriesKey\u0000rowIndex". A flat set
  // rather than a map of sets because every operation over it — count it, group
  // it, iterate it in series order — is a one-liner either way, and a flat set
  // is the one a `has` is O(1) on, which is what the chart asks on every mark
  // it draws.
  const pickKey = (key, i) => `${key}\u0000${i}`;
  const isPicked = (key, i) => ad.picked.size > 0 && ad.picked.has(pickKey(key, i));

  // The picked set, grouped by series and sorted, which is what every edit
  // wants. Rows whose series has since been removed are dropped rather than
  // throwing — `remove()` does not walk the selection.
  function pickedBySeries() {
    const by = new Map();
    for (const k of ad.picked) {
      const cut = k.indexOf('\u0000');
      const key = k.slice(0, cut), i = +k.slice(cut + 1);
      const s = find(key);
      if (!s || !(i >= 0 && i < s.n)) continue;
      let list = by.get(s);
      if (!list) by.set(s, list = []);
      list.push(i);
    }
    for (const list of by.values()) list.sort((a, b) => a - b);
    return by;
  }

  // Taken once, at the first edit, and never again — see the note above.
  function keepOriginal(s) {
    if (!s.orig) s.orig = { v: Float64Array.from(s.v), q: Uint8Array.from(s.q) };
    if (!s.edited) s.edited = new Uint8Array(s.n);
  }

  // Everything downstream of a reading's value is derived and cached, so an
  // edit has to drop both caches or the chart redraws the numbers it had
  // before. This is the only place that pairing is written down.
  function invalidate(s) { s.filt = null; s.tracks = null; }

  // A quality code, by label, added to the series' vocabulary if it is new.
  // qcodes is "the codes seen in this file, in first-seen order" and q[] indexes
  // it, so a code nobody has used yet has to be appended before it can be
  // referenced — and an empty label means "no code", which is index 0 in every
  // file that has one and a new entry in every file that does not.
  function qualityIndex(s, label) {
    const want = String(label == null ? '' : label);
    let at = s.qcodes.indexOf(want);
    if (at < 0) { s.qcodes.push(want); at = s.qcodes.length - 1; }
    return at;
  }

  // ── The four edits ─────────────────────────────────────────────────────────

  // `how` is 'set' (this value), 'by' (this much added) or 'scale'. Three rather
  // than one because the three are genuinely different jobs: correcting a
  // misread digit, undoing a datum shift across a stretch, and fixing a unit.
  function editValue(how, raw) {
    const num = parseFloat(raw);
    if (!isFinite(num)) { note('Type a number first.', true); return; }
    const by = pickedBySeries();
    if (!by.size) return;
    let n = 0;
    for (const [s, rows] of by) {
      keepOriginal(s);
      for (const i of rows) {
        const next = how === 'set' ? num : how === 'by' ? s.v[i] + num : s.v[i] * num;
        if (next === s.v[i]) continue;
        s.v[i] = next;
        s.edited[i] = 1;
        n++;
      }
      invalidate(s);
    }
    afterEdit(`${n.toLocaleString()} reading${n === 1 ? '' : 's'} ${
      how === 'set' ? `set to ${fmtVal(num)}` : how === 'by' ? `moved by ${fmtVal(num)}` : `scaled by ${fmtVal(num)}`}.`);
  }

  function editQuality(label) {
    const by = pickedBySeries();
    if (!by.size) return;
    let n = 0;
    for (const [s, rows] of by) {
      keepOriginal(s);
      const at = qualityIndex(s, label);
      for (const i of rows) {
        if (s.q[i] === at) continue;
        s.q[i] = at;
        s.edited[i] = 1;
        n++;
      }
      // The quality code is carried through the export and shown in the
      // inspector; it is not an input to the 357 walk, which reads values only.
      // Dropping the caches anyway keeps one rule rather than two.
      invalidate(s);
    }
    afterEdit(`${n.toLocaleString()} reading${n === 1 ? '' : 's'} coded ${label || '(no code)'}.`);
  }

  // Rebuilds every parallel array without the picked rows. The only edit that
  // changes `n`, and therefore the only one that has to touch `extra`, `orig`
  // and `edited` as well — everything the series carries per reading is cut
  // with one mask, here, so there is exactly one list to keep up to date.
  function editDelete() {
    const by = pickedBySeries();
    if (!by.size) return;
    const total = [...by.values()].reduce((a, r) => a + r.length, 0);
    if (!confirm(`Delete ${total.toLocaleString()} reading${total === 1 ? '' : 's'}? `
               + 'They go out of the chart, the table and the exports. '
               + 'Revert puts back edited values but not deleted rows.')) return;
    for (const [s, rows] of by) {
      keepOriginal(s);
      const drop = new Set(rows);
      const keep = [];
      for (let i = 0; i < s.n; i++) if (!drop.has(i)) keep.push(i);
      const cut = (src) => {
        const out = Array.isArray(src) ? new Array(keep.length) : new src.constructor(keep.length);
        for (let k = 0; k < keep.length; k++) out[k] = src[keep[k]];
        return out;
      };
      s.t = cut(s.t); s.tr = cut(s.tr); s.v = cut(s.v); s.raw = cut(s.raw); s.q = cut(s.q);
      s.edited = cut(s.edited);
      if (s.orig) s.orig = { v: cut(s.orig.v), q: cut(s.orig.q) };
      if (s.eng) s.eng = cut(s.eng);
      for (const [name, col] of Object.entries(s.extra || {})) s.extra[name] = cut(col);
      s.n = keep.length;
      s.deleted = (s.deleted || 0) + rows.length;
      invalidate(s);
    }
    ad.picked.clear();
    ad.pin = null;
    afterEdit(`${total.toLocaleString()} reading${total === 1 ? '' : 's'} deleted.`);
  }

  // As loaded, for one series. Deleted rows are gone for good and the button
  // says so — putting them back would mean keeping the whole original series
  // beside the edited one for the life of the tab, which is a lot of memory for
  // an undo nobody asked for.
  function revertSeries(key) {
    const s = find(key);
    if (!s || !s.orig) return;
    if (!confirm(`Put ${s.label} back to the values and quality codes it was loaded with?`
               + (s.deleted ? ` The ${s.deleted.toLocaleString()} deleted reading${
                   s.deleted === 1 ? '' : 's'} cannot come back.` : ''))) return;
    s.v = Float64Array.from(s.orig.v);
    s.q = Uint8Array.from(s.orig.q);
    s.edited = new Uint8Array(s.n);
    s.orig = null;
    invalidate(s);
    afterEdit(`${s.label} put back to the values it was loaded with.`);
  }

  const editedCount = s => {
    if (!s.edited) return 0;
    let n = 0;
    for (let i = 0; i < s.n; i++) if (s.edited[i]) n++;
    return n;
  };

  // One tail for all four: the filters re-run on the next draw because the
  // caches are gone, and the rail has to repaint because the counts in it have
  // just moved.
  function afterEdit(said) {
    ad.tableSig = '';
    renderSide();
    draw(); drawOv(); drawCompare(true); renderReadout();
    if (adTableModalOpen) renderTableModal();
    note(`${said} In this browser only — nothing is written back to ${
      ad.source === 'field' ? 'the datastore' : 'ARRO'}.`);
    announce(said);
  }

  // ── The selection ──────────────────────────────────────────────────────────

  function pickToggle(key, i) {
    const k = pickKey(key, i);
    if (ad.picked.has(k)) ad.picked.delete(k); else ad.picked.add(k);
    renderReadout(); draw();
    if (adTableModalOpen) renderTableModal(); else renderTable(true);
  }

  // Every reading in the window on screen, across every visible series —
  // removed ones included, for pickInBox()'s reason. The one gesture for "this
  // whole stretch is rubbish", which is the commonest thing anyone wants to do
  // to a record: zoom to the stretch, press this, delete.
  function pickAllInView() {
    const v = view();
    if (!v) return;
    let added = 0;
    for (const s of shown()) {
      const i0 = lower(s.t, s.n, v.t0), i1 = lower(s.t, s.n, v.t1);
      for (let i = i0; i < i1; i++) {
        const k = pickKey(s.key, i);
        if (!ad.picked.has(k)) { ad.picked.add(k); added++; }
      }
    }
    if (!added) { note('Every reading in this window is already picked.'); return; }
    announce(`${added.toLocaleString()} reading${added === 1 ? '' : 's'} picked, ${
      ad.picked.size.toLocaleString()} in all.`);
    renderMainOnly();
  }

  function pickClear() {
    if (!ad.picked.size) return;
    ad.picked.clear();
    renderReadout(); draw();
    if (adTableModalOpen) renderTableModal(); else renderTable(true);
  }

  // Everything inside a dragged box, across every visible series. Values are
  // compared against the series' own vertical scale, so a box drawn over a
  // right-axis trace picks the readings it looks like it is over rather than
  // the ones a left-axis reading of the same pixels would give.
  //
  // Removed readings are picked too, whenever they are drawn — which is the
  // point: the spike somebody wants to delete is by definition one the filter
  // has already rejected, so a lasso that could only reach survivors would miss
  // every reading anyone wants to edit.
  function pickInBox(x0, y0, x1, y1) {
    const g = geom();
    if (!g) return 0;
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    const top = Math.min(y0, y1), bot = Math.max(y0, y1);
    let added = 0;
    for (const s of shown()) {
      const sy = g.yOf(s);
      const i0 = lower(s.t, s.n, g.tOf(lo)), i1 = lower(s.t, s.n, g.tOf(hi));
      for (let i = i0; i < i1; i++) {
        const py = sy(s.v[i]);
        if (py < top || py > bot) continue;
        const k = pickKey(s.key, i);
        if (!ad.picked.has(k)) { ad.picked.add(k); added++; }
      }
    }
    return added;
  }

  // ── readout / inspector ────────────────────────────────────────────────────

  function statusOf(s, i) {
    const f = runFilter(s, ad.cfg);
    return f.status[i];
  }

  // The editor, shown in the readout strip whenever anything is picked. It goes
  // there rather than in a panel of its own because that strip is already the
  // "what is under the pointer" line, and a selection is the same kind of thing
  // — the chart's current subject — only sticky.
  function editorHtml() {
    const by = pickedBySeries();
    const total = [...by.values()].reduce((a, r) => a + r.length, 0);
    if (!total) return '';
    const one = total === 1;
    // The codes already in the file, plus whatever has been typed. Offered as a
    // datalist rather than a <select> because a code the file has never used is
    // a perfectly ordinary thing to want, and a closed list would forbid it.
    const codes = [...new Set([...by.keys()].flatMap(s => s.qcodes).filter(Boolean))].sort();
    const [s0, rows0] = [...by][0];
    return `
      <div class="ad-edit" role="group" aria-label="Edit the picked readings">
        <div class="ad-edit-head">
          <b>${total.toLocaleString()} reading${one ? '' : 's'} picked</b>
          <span class="small">${[...by].map(([s, r]) =>
            `${esc(s.label)} ×${r.length.toLocaleString()}`).join(' · ')}</span>
          ${one ? `<span class="small mono">${esc(fmtFull(s0.t[rows0[0]]))} · ${
            esc(fmtVal(s0.v[rows0[0]]))} ${esc(s0.unit)}</span>` : ''}
          <button class="ad-x" onclick="ArroData.pickClear()"
                  aria-label="Clear the selection" title="Clear the selection">✕</button>
        </div>
        <div class="ad-edit-row">
          <label class="small">Value
            <input type="number" step="any" class="ad-num" id="ad-edit-val"
                   value="${escAttr(ad.editVal)}" placeholder="${one ? escAttr(fmtVal(s0.v[rows0[0]])) : 'number'}"
                   aria-label="Value to apply to the picked readings"
                   oninput="ArroData.setEditVal(this.value)"></label>
          <button onclick="ArroData.editValue('set', document.getElementById('ad-edit-val').value)"
                  title="Give every picked reading this value">set to</button>
          <button onclick="ArroData.editValue('by', document.getElementById('ad-edit-val').value)"
                  title="Add this to every picked reading — negative subtracts. The way to undo a datum shift across a stretch.">move by</button>
          <button onclick="ArroData.editValue('scale', document.getElementById('ad-edit-val').value)"
                  title="Multiply every picked reading by this — the way to fix a unit, 0.001 for mm read as µm">×</button>
        </div>
        <div class="ad-edit-row">
          <label class="small">Quality
            <input type="text" class="ad-num ad-qbox" id="ad-edit-q" list="ad-qcodes"
                   value="${escAttr(ad.editQ)}" placeholder="code"
                   aria-label="Quality code to apply to the picked readings"
                   oninput="ArroData.setEditQ(this.value)">
            <datalist id="ad-qcodes">${codes.map(c => `<option value="${escAttr(c)}">`).join('')}</datalist>
          </label>
          <button onclick="ArroData.editQuality(document.getElementById('ad-edit-q').value)"
                  title="Code every picked reading with this. Blank clears the code.">code as</button>
          <button class="ad-edit-del" onclick="ArroData.editDelete()"
                  title="Take these readings out of the chart, the table and the exports">delete</button>
        </div>
        <p class="small ad-edit-note">
          Drag a picked reading up or down on the chart to move it.
          Edits live in this browser tab only — nothing is written back to ${
            ad.source === 'field' ? 'the datastore' : 'ARRO'}; the two
          <b>Export</b> buttons write what you see here.
        </p>
      </div>`;
  }

  function readoutHtml() {
    // A selection outranks a hover and a pin: it is the thing being worked on,
    // and it does not go away when the pointer does.
    const edit = editorHtml();
    if (edit) return edit;
    if (ad.pin) {
      const s = ad.series.find(x => x.key === ad.pin.key);
      if (s) return pinHtml(s, ad.pin.i);
    }
    if (ad.hover && ad.hover.rows.length) {
      return `
        <div class="ad-read-hover">
          <b>${esc(fmtFull(ad.hover.t))}</b>
          ${ad.hover.rows.map(r => `
            <span class="ad-read-item">
              <span class="ad-dot" style="--dot:${escAttr(r.color)}"></span>
              ${esc(r.label)} <b>${esc(fmtVal(r.y))}</b>${r.unit ? ' ' + esc(r.unit) : ''}
              <span class="small">${esc(r.kindLabel)}${r.q ? ' · ' + esc(r.q) : ''}</span>
            </span>`).join('')}
          <span class="small">click to pin a reading</span>
        </div>`;
    }
    return statsHtml();
  }

  // What a raw tip count converts to in mm, for display next to it — never
  // fed back into runFilter/walk357, which stay in the count/Value domain
  // ARRO exported (see the comment on runFilter()). Only offered for a
  // rainfall accumulator with a real "Raw Value" column and a linked
  // station; a water level's raw count isn't a tip count at all.
  //
  // **`kind` is not on its own enough to decide that, and this is where the
  // wrong answer showed up on screen.** `kind` is a guess with a fallback and
  // the operator can override it, so a series can be sitting on `RA` while its
  // readings plainly say metres — and multiplying a river level by 0.2 mm/tip
  // produces a number that looks like rainfall and is nothing at all. The unit
  // the readings actually carried is the device's own statement about what it
  // measured, so it gets a veto here: a tip count has no engineering unit, or
  // has `mm` or `count`. Anything else is not a bucket and is not offered one.
  function rawBucketNote(s, i) {
    if (s.kind !== 'RA' || !s.hasRaw || !s.station) return '';
    const eng = String(s.engUnit || '').trim();
    if (eng && !/^(mm|count)$/i.test(eng)) return '';
    const b = bucketSizeMm(s.station);
    const mm = s.raw[i] * b.mm;
    const note = b.recorded ? `recorded, ${b.mm} mm/tip` : `assumed ${b.mm} mm/tip — not recorded for this site`;
    return ` <span class="small">= ${esc(fmtVal(mm))} mm (${esc(note)})</span>`;
  }

  // The reading either side of a pinned one, as the difference the eye was
  // about to work out for itself. A callout that gives a level to three decimal
  // places and says nothing about the one before it makes the operator hold two
  // numbers in their head and subtract — on the tab whose whole job is finding
  // the reading that moved when it should not have.
  //
  // **Record order, not drawn order.** The neighbour is i±1 in the series, even
  // when the filters removed it. Every verdict in the panel around this is
  // stated against "the reading before it" — the rate-of-rise and rate-of-fall
  // limits by name, the 357 test against the three that follow — so quoting the
  // nearest *surviving* neighbour instead would answer a different question
  // from the one the badge above it just answered, and the pair would disagree
  // on a chart where they are inches apart. When the neighbour is one the
  // filters took out, the cell says which filter, rather than quietly offering
  // a difference against a reading that is not in the filtered series.
  //
  // The difference always runs in time order: `Δ previous` is what the value
  // did coming *into* this reading, `Δ next` what it does leaving it. So two
  // adjacent readings quote the same figure once each, and the pair reads as a
  // slope through the point rather than as two unrelated subtractions.
  function deltaCell(s, i, step, f) {
    const j = i + step;
    if (j < 0)           return '<b class="txt-muted">— first reading</b>';
    // s.n, not s.t.length: seriesData() guarantees the arrays are *at least*
    // n long and says the tail is ignored, so a series sitting in an
    // over-allocated buffer would otherwise be given a neighbour made of
    // whatever was left in it.
    if (j >= s.n) return '<b class="txt-muted">— last reading</b>';
    const [from, to] = step < 0 ? [j, i] : [i, j];
    const dv = s.v[to] - s.v[from];
    const dt = s.t[to] - s.t[from];
    const sign = dv > 0 ? '+' : '';
    const unit = s.unit ? ' ' + esc(s.unit) : '';
    // A zero gap is a repeat timestamp — the thing AD_OOS exists to name — and
    // a rate across it would be a division by zero dressed up as a measurement.
    const rate = dt > 0
      ? ` · ${sign}${esc(fmtVal(dv / (dt / 3600000)))}${s.unit ? ' ' + esc(s.unit) : ''}/h`
      : '';
    const gap = dt > 0 ? `over ${esc(fmtDur(dt))}` : 'same timestamp';
    const cut = adCut(f.status[j])
      ? ` · <span class="txt-warn">that reading was removed — ${esc(AD_STATUS_LABEL[f.status[j]])}</span>`
      : '';
    return `<b>${sign}${esc(fmtVal(dv))}${unit}</b>`
         + `<span class="small ad-delta-note">${gap}${rate}${cut}</span>`;
  }

  function pinHtml(s, i) {
    const f = runFilter(s, ad.cfg);
    const st = f.status[i];
    const lim = [bound(ad.cfg.rangeMin) !== null ? `below ${ad.cfg.rangeMin}` : '',
                 bound(ad.cfg.rangeMax) !== null ? `above ${ad.cfg.rangeMax}` : ''].filter(Boolean).join(' or ');
    const why = st === AD_GOOD
        ? (ad.cfg.use357 ? 'Passed the 357 test.'
                         : 'Kept — the 357 test is switched off, so nothing here was tested for continuity.')
      : st === AD_OOS ? 'Dropped before filtering — this timestamp does not advance the clock, so it is a repeat of an earlier reading rather than a new observation.'
      : st === AD_RANGE ? `Outside the limits you set — anything ${lim || 'outside the range'} is removed before the 357 test runs.`
      : st === AD_RATE ? `Climbed faster than ${ad.cfg.rateMax} ${s.unit}/h from the reading before it, so it was removed before the 357 test ran.`
      : st === AD_FALL ? `Dropped faster than ${ad.cfg.fallMax} ${s.unit}/h from the reading before it, so it was removed before the 357 test ran.`
      : `Failed the 357 test against the readings that follow it — not within ${ad.cfg.small} of the next, ${ad.cfg.medium} of the next-next, or ${ad.cfg.large} of the one after that.`;
    const badge = st === AD_GOOD ? 'ok' : st === AD_OOS ? 'dup'
                : (st === AD_RANGE || st === AD_RATE || st === AD_FALL) ? 'warn' : 'bad';
    const rolled = f.rolls.includes(i);
    return `
      <div class="ad-pin">
        <div class="ad-pin-head">
          <span class="ad-dot" style="--dot:${escAttr(s.color)}"></span>
          <b>${esc(s.label)}</b>
          <span class="ad-badge ad-badge--${badge}">${esc(AD_STATUS_LABEL[st])}</span>
          <button class="ad-x" onclick="ArroData.unpin()"
                  aria-label="Close the pinned reading" title="Close">✕</button>
        </div>
        <div class="ad-pin-grid">
          <div><span>Reading</span><b>${esc(fmtFull(s.t[i]))}</b></div>
          <div><span>${esc(s.prov && s.prov.res !== 'raw' ? 'Last in bucket' : 'Received')}</span><b>${esc(fmtFull(s.tr[i]))}${
              // The delay between reading and receipt is worth flagging on a
              // real reading. On a rollup the two are an hour apart by
              // construction, which is not news.
              s.tr[i] !== s.t[i] && (!s.prov || s.prov.res === 'raw')
              ? ` <span class="small txt-warn">+${Math.round((s.tr[i] - s.t[i]) / 1000)}s</span>` : ''}</b></div>
          <div><span>Value</span><b>${esc(fmtVal(s.v[i]))} ${esc(s.unit)}</b></div>
          <div><span>Raw</span><b>${esc(fmtVal(s.raw[i]))}</b>${rawBucketNote(s, i)}</div>
          <div><span>Adjusted</span><b>${esc(fmtVal(f.adj[i]))}${rolled ? ' <span class="small">(wrap here)</span>' : ''}</b></div>
          <div class="ad-delta"><span>&Delta; previous</span>${deltaCell(s, i, -1, f)}</div>
          <div class="ad-delta"><span>&Delta; next</span>${deltaCell(s, i, 1, f)}</div>
          <div><span>Quality</span><b>${esc(s.qcodes[s.q[i]] || '—')}</b></div>
          ${s.prov ? fieldPinRows(s, i) : ''}
        </div>
        <div class="small ad-pin-why">${esc(why)}
          <button class="ad-inline-link" onclick="ArroData.explain()"
                  title="The whole test, with the spec's own diagrams">How the 357 filter works</button>
        </div>
      </div>`;
  }

  function statsHtml() {
    const vis = shown();
    if (!vis.length) return '<span class="small">No series shown — tick one on the left.</span>';
    const v = view();
    return `<div class="ad-stats">${vis.map(s => {
      const tr = tracks(s);
      const track = ad.mode === 'raw' ? tr.raw : tr.filt;
      const i0 = lower(track.t, track.n, v.t0), i1 = lower(track.t, track.n, v.t1);
      let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
      for (let k = i0; k < i1; k++) { const y = track.y[k]; if (y < lo) lo = y; if (y > hi) hi = y; sum += y; cnt++; }
      const net = cnt && ad.transform === 'value' ? track.y[i1 - 1] - track.y[i0] : sum;
      return `
        <span class="ad-stat">
          <span class="ad-dot" style="--dot:${escAttr(s.color)}"></span>
          <b>${esc(s.label)}</b>
          <span class="small">${cnt.toLocaleString()} in view${cnt ? ` · ${fmtVal(lo)}–${fmtVal(hi)} ${esc(s.unit)}
            · ${ad.transform === 'value' ? 'net' : 'total'} ${fmtVal(net)}` : ''}</span>
        </span>`;
    }).join('')}</div>`;
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  // Theme colours are read from the document rather than written as `var(...)`
  // into the markup, because the SVG has to survive being pulled out of the
  // page and turned into a PNG, where nothing would resolve them.

  // One of the twelve series tokens, as a literal. Read fresh rather than
  // cached: the whole point is that it is different in the two themes, and the
  // cost is one getComputedStyle per series per repaint, which is nothing
  // beside the redraw it is part of.
  function slotColor(slot) {
    const tok = AD_SERIES_TOKENS[slot % AD_SERIES_TOKENS.length];
    if (typeof getComputedStyle !== 'function') return AD_COLORS[slot % AD_COLORS.length];
    const v = getComputedStyle(document.documentElement).getPropertyValue(tok).trim();
    return v || AD_COLORS[slot % AD_COLORS.length];
  }

  // Re-resolve every series that has not been coloured by hand. Called from
  // repaint(), which is what toggleTheme() calls — and across *both* instances,
  // because the theme is the document's and the tab that is not on screen would
  // otherwise come back carrying the other theme's palette.
  function reslotColors() {
    let moved = false;
    for (const inst of Object.values(instances)) {
      for (const s of inst.series) {
        if (s.colorSet) continue;
        const c = slotColor(s.slot || 0);
        if (c !== s.color) { s.color = c; moved = true; }
      }
    }
    return moved;
  }

  // The dash pattern this series is drawn with. A chosen one wins; otherwise the
  // slot rule, which is empty for a lone series — see AD_DASH.
  function seriesDash(s) {
    if (s.dash && s.dash !== 'auto') {
      const hit = AD_DASH_CHOICES.find(d => d[0] === s.dash);
      if (hit) return hit[2];
    }
    if (shown().length < 2) return '';
    return AD_DASH[(s.slot || 0) % AD_DASH.length];
  }

  function seriesShape(s) { return AD_SHAPES[(s.slot || 0) % AD_SHAPES.length]; }

  // One mark, in the shape belonging to the series. Written as a path for
  // everything but the circle so that a single string works for all four.
  function shapeMark(shape, cx, cy, r, fill, opacity) {
    const o = opacity == null ? 1 : opacity;
    const x = cx.toFixed(1), y = cy.toFixed(1);
    if (shape === 'square') {
      return `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}"
                    width="${(r * 2).toFixed(1)}" height="${(r * 2).toFixed(1)}"
                    fill="${fill}" opacity="${o}"/>`;
    }
    if (shape === 'triangle') {
      const h = r * 1.25;
      return `<path d="M${x} ${(cy - h).toFixed(1)}L${(cx + h).toFixed(1)} ${(cy + h * 0.7).toFixed(1)}
                       H${(cx - h).toFixed(1)}Z" fill="${fill}" opacity="${o}"/>`;
    }
    if (shape === 'diamond') {
      const h = r * 1.3;
      return `<path d="M${x} ${(cy - h).toFixed(1)}L${(cx + h).toFixed(1)} ${y}L${x} ${(cy + h).toFixed(1)}
                       L${(cx - h).toFixed(1)} ${y}Z" fill="${fill}" opacity="${o}"/>`;
    }
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="${o}"/>`;
  }

  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
    return {
      text:   pick('--text', '#16202a'),
      muted:  pick('--muted', '#4f6478'),
      border: pick('--border', '#dde5ee'),
      panel:  pick('--panel', '#ffffff'),
      bad:    pick('--bad', '#c7401a'),
      warn:   pick('--warn', '#a86400'),
      accent: pick('--accent', '#0b5cab'),
    };
  }

  const PADL = 64, PADR = 18, PADT = 14, PADB = 30;
  // The right margin when a second axis is drawn in it — wide enough for a
  // column of tick labels, which PADR at 18 px is not (#191).
  const PADR2 = 58;
  // The overview strip's own height and the vertical navigator's own width, so
  // the two drawing functions and the two hit-tests quote one figure each.
  const AD_OV_H = 56, AD_VOV_W = 46;
  // The plot's right margin as it is right now — PADR2 while a second vertical
  // axis is drawn in it, PADR otherwise. The overview strip under the chart has
  // to quote the same figure or its window box stops lining up with the window
  // it is describing, which is the one thing that navigator must never do.
  const padRNow = () => (axisSides().right.length ? PADR2 : PADR);
  const ovClampX  = px => Math.max(PADL, Math.min(ad.w - padRNow(), px));
  const vovClampY = py => Math.max(PADT, Math.min(ad.h - PADB, py));
  // How near an edge of either navigator's window a press has to land to mean
  // "resize that edge", in viewBox px either side of it. It lives up here
  // beside the other one-figure-each constants because three places quote it
  // and they must not disagree: the hit-test that reads a press, and the two
  // drawers that paint the cursor zone promising what that press will do.
  //
  // It was 7 while the zone drawn over it was 6, and both were too small to
  // aim at — the complaint that prompted this was simply that the edges could
  // not be grabbed. 11 is a target a hand finds without looking.
  const AD_OV_GRIP = 11;
  // …but never so much of a narrow window that its middle disappears. At a
  // flat 11 either side, a window under 22 px across would be edge all the way
  // through and could never be *moved* from the navigator again — which a deep
  // zoom reaches easily. Taking at most a third from either side always leaves
  // a third in the middle to grab.
  const navGrip = (lo, hi) => Math.max(3, Math.min(AD_OV_GRIP, (hi - lo) / 3));
  const MARK_CAP = 2500;      // removed-point markers drawn before we stop
  // Vertical throw, in viewBox px, below which a zoom box means "time only".
  // Years of x-only brushing taught a flat sweep across the chart; a hand that
  // wobbles a few pixels while making one must not be answered with a squashed
  // vertical axis it never asked for.
  const AD_BOX_EPS = 8;
  // How near a click has to land, in the same blended distance hoverAt() ranks
  // by, to count as being *on* a reading rather than near one. Pinning is happy
  // to take the nearest reading anywhere on the chart — that is what a
  // crosshair does — but picking one for editing, and grabbing one to move, are
  // not, and a delete that took a reading eighty pixels from the pointer would
  // be the worst bug on this tab.
  const AD_GRAB_PX = 14;

  function measure() {
    const stage = document.getElementById('ad-stage');
    if (!stage) return false;
    const r = stage.getBoundingClientRect();
    const w = Math.max(360, Math.round(r.width));
    const h = Math.max(240, Math.round(r.height));
    const same = w === ad.w && h === ad.h;
    ad.w = w; ad.h = h;
    return !same;
  }

  function geom() {
    const v = view();
    if (!v) return null;
    const w = ad.w, h = ad.h;
    const sides = axisSides();
    // The right margin grows to hold a second column of tick labels, and only
    // then: a chart with one axis is drawn exactly as it always was.
    const padR = sides.right.length ? PADR2 : PADR;
    const pw = w - PADL - padR, ph = h - PADT - PADB;
    const yr  = yRange(v, 'left');
    const yrR = sides.right.length ? yRange(v, 'right') : null;
    const x = t => PADL + (t - v.t0) / (v.t1 - v.t0) * pw;
    const scale = r => val => PADT + (1 - (val - r.lo) / (r.hi - r.lo)) * ph;
    const y  = scale(yr);
    const yR = yrR ? scale(yrR) : y;
    // Which scale a given series is drawn against. Everything that plots a
    // point goes through this rather than through `y` directly, so a series
    // sent to the right axis cannot be drawn against the left one by a caller
    // that forgot to ask.
    const yOf = s => (yrR && axisOf(s) === 'right' ? yR : y);
    const tOf = px => v.t0 + (px - PADL) / pw * (v.t1 - v.t0);
    // The vertical gestures — the Alt drag, the box zoom's vertical half, and
    // the navigator down the right — all commit through the *left* axis, for
    // the reason given on yRange().
    const valOf = py => yr.hi - (py - PADT) / ph * (yr.hi - yr.lo);
    return { v, w, h, pw, ph, padR, yr, yrR, sides, x, y, yR, yOf, tOf, valOf };
  }

  function draw() {
    const svg = document.getElementById('ad-svg');
    if (!svg) return;
    const g = geom();
    if (!g) { svg.innerHTML = ''; return; }
    const c = theme();
    svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
    // Fill the box rather than fit inside it. The default, `xMidYMid meet`,
    // scales the viewBox uniformly and centres the leftovers — so a viewBox
    // measured off the stage's *border* box, drawn into the content box inside
    // it, came out fractionally small and offset, and every px→time conversion
    // in here was reading from a ruler the browser had quietly moved. See
    // svgPt(); on the two navigators the same mismatch was 12–17 px.
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('width', g.w);
    svg.setAttribute('height', g.h);

    const { ticks, step } = timeTicks(g.v.t0, g.v.t1, Math.max(3, Math.round(g.pw / 110)));
    const yt = niceTicks(g.yr.lo, g.yr.hi, Math.max(2, Math.round(g.ph / 46)));

    // Everything data-driven is clipped to the plot rectangle. Without it a
    // fixed or kept-only vertical range lets curves run across the axis labels.
    let out = `<defs><clipPath id="ad-clip"><rect x="${PADL}" y="${PADT}"
                 width="${g.pw}" height="${g.ph}"/></clipPath></defs>
               <rect x="0" y="0" width="${g.w}" height="${g.h}" fill="${c.panel}"/>`;

    // The gridlines belong to the left axis; the right axis gets tick labels
    // and no lines of its own. Two sets of gridlines at two spacings over one
    // rectangle is a moiré, not a scale — and the reason for a second axis is
    // to compare two *shapes*, which needs one grid to read them against.
    out += yt.map(val => `
      <line x1="${PADL}" y1="${g.y(val).toFixed(1)}" x2="${g.w - g.padR}" y2="${g.y(val).toFixed(1)}"
            stroke="${c.border}" stroke-width="1"/>
      <text x="${PADL - 6}" y="${(g.y(val) + 3.5).toFixed(1)}" font-size="10" text-anchor="end"
            fill="${c.muted}">${esc(fmtVal(val))}</text>`).join('');

    if (g.yrR) {
      out += niceTicks(g.yrR.lo, g.yrR.hi, Math.max(2, Math.round(g.ph / 46))).map(val => `
        <text x="${g.w - g.padR + 6}" y="${(g.yR(val) + 3.5).toFixed(1)}" font-size="10"
              fill="${c.muted}">${esc(fmtVal(val))}</text>`).join('');
    }

    out += ticks.map(t => `
      <line x1="${g.x(t).toFixed(1)}" y1="${PADT}" x2="${g.x(t).toFixed(1)}" y2="${g.h - PADB}"
            stroke="${c.border}" stroke-width="1" opacity=".7"/>
      <text x="${g.x(t).toFixed(1)}" y="${g.h - PADB + 14}" font-size="10" text-anchor="middle"
            fill="${c.muted}">${esc(fmtTick(t, step))}</text>`).join('');

    // Rollover seams sit under the curves — they explain a step, they are not
    // a reading in their own right.
    if (ad.showRollover) {
      for (const s of shown()) {
        const f = runFilter(s, ad.cfg);
        for (const i of f.rolls) {
          if (s.t[i] < g.v.t0 || s.t[i] > g.v.t1) continue;
          out += `<line x1="${g.x(s.t[i]).toFixed(1)}" y1="${PADT}" x2="${g.x(s.t[i]).toFixed(1)}"
                        y2="${g.h - PADB}" stroke="${c.warn}" stroke-width="1.2" stroke-dasharray="4 3"
                        opacity=".8"><title>Accumulator wrap corrected · ${esc(fmtFull(s.t[i]))}</title></line>`;
        }
      }
    }

    const stepped = ad.chartType === 'step';
    const dots = ad.chartType === 'dots';
    let markers = '', nMark = 0;
    let series = '';

    for (const s of shown()) {
      // Which of the two vertical scales this series is drawn against (#191).
      const sy = g.yOf(s);
      for (const { track, kind } of layers(s)) {
        const i0 = Math.max(0, lower(track.t, track.n, g.v.t0) - 1);
        const i1 = Math.min(track.n, lower(track.t, track.n, g.v.t1) + 1);
        const pts = densify(track, i0, i1, g.x, g.pw);
        if (!pts.length) continue;
        // In "both", raw sits underneath as a ghost so that what the filter took
        // out reads as a gap in the solid line rather than a second chart.
        const ghost = ad.mode === 'both' && kind === 'raw';
        const shape = seriesShape(s);
        if (dots) {
          markers += pts.slice(0, 4000).map(p =>
            shapeMark(shape, p[0], sy(p[1]), ghost ? 1.3 : 2, escAttr(s.color), ghost ? .3 : .9)).join('');
        } else {
          // The dash is the series' identity without its colour — see AD_DASH.
          // It rides on the ghost too: raw and filtered are one series drawn
          // twice, and giving them different dashes would say otherwise.
          const dash = seriesDash(s);
          series += `<path d="${pathFrom(pts, sy, stepped, track, s)}" fill="none" stroke="${escAttr(s.color)}"
                        stroke-width="${ghost ? 1 : 1.7}" opacity="${ghost ? .34 : 1}"
                        ${dash ? `stroke-dasharray="${dash}"` : ''}
                        stroke-linejoin="round" stroke-linecap="round"/>`;
        }
        // Few enough points on screen that each one is a real reading: show them.
        if (!dots && ad.showPoints !== 'off' && (i1 - i0) <= Math.max(40, g.pw / 12) && !ghost) {
          for (let k = i0; k < i1; k++) {
            markers += shapeMark(shape, g.x(track.t[k]), sy(track.y[k]), 2.2, escAttr(s.color));
          }
        }
      }

      // What the filter took out, and what never made it in.
      const f = runFilter(s, ad.cfg);
      const wantBad = ad.showRemoved && ad.mode !== 'raw';
      if (wantBad || ad.showDupes) {
        const i0 = lower(s.t, s.n, g.v.t0), i1 = lower(s.t, s.n, g.v.t1);
        for (let i = i0; i < i1 && nMark < MARK_CAP; i++) {
          const st = f.status[i];
          const isDup = st === AD_OOS;
          const isCut = st === AD_BAD || st === AD_RANGE || st === AD_RATE || st === AD_FALL;
          if (!(isCut && wantBad) && !(isDup && ad.showDupes)) continue;
          if (ad.transform !== 'value') continue;   // a removed step has no meaningful height
          const px = g.x(s.t[i]), py = sy(s.v[i]);
          // Which filter took it out, told apart by shape as well as colour —
          // at four pixels a colour alone is a guess.
          const col = st === AD_BAD ? c.bad : isDup ? c.muted : c.warn;    // AD_RANGE/RATE/FALL are all warn
          nMark++;
          // A removal above the top of the scale still has to be visible, or
          // "Kept" would quietly hide the very readings it is scaled to exclude.
          if (py < PADT) {
            markers += `<path d="M${px.toFixed(1)} ${PADT}l-4 7h8Z" fill="${col}"
                              opacity=".9"><title>${esc(fmtVal(s.v[i]))} ${esc(s.unit)} — ${esc(AD_STATUS_LABEL[st])}, above the scale</title></path>`;
            continue;
          }
          if (py > g.h - PADB) continue;
          markers += st === AD_BAD
            ? `<path d="M${(px - 3).toFixed(1)} ${(py - 3).toFixed(1)}l6 6M${(px + 3).toFixed(1)} ${(py - 3).toFixed(1)}l-6 6"
                     stroke="${c.bad}" stroke-width="1.4" opacity=".92"><title>failed the 357 test</title></path>`
            : st === AD_RANGE
            ? `<rect x="${(px - 2.8).toFixed(1)}" y="${(py - 2.8).toFixed(1)}" width="5.6" height="5.6"
                     fill="none" stroke="${c.warn}" stroke-width="1.4"><title>outside the range limits</title></rect>`
            : st === AD_RATE
            ? `<path d="M${px.toFixed(1)} ${(py - 3.6).toFixed(1)}l3.4 5.8h-6.8Z" fill="${c.warn}"
                     opacity=".92"><title>rose faster than the rate limit</title></path>`
            // The mirror of it, pointing the way the reading went — the same
            // pair of shapes the two filter blocks put beside their own names.
            : st === AD_FALL
            ? `<path d="M${px.toFixed(1)} ${(py + 3.6).toFixed(1)}l3.4 -5.8h-6.8Z" fill="${c.warn}"
                     opacity=".92"><title>fell faster than the rate limit</title></path>`
            : `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="1.6" fill="${c.muted}" opacity=".5"/>`;
        }
      }
    }
    out += `<g clip-path="url(#ad-clip)">${series}${markers}</g>`;

    // Crosshair and the nearest-reading halo.
    if (ad.hover) {
      const hx = g.x(ad.hover.t);
      out += `<line x1="${hx.toFixed(1)}" y1="${PADT}" x2="${hx.toFixed(1)}" y2="${g.h - PADB}"
                    stroke="${c.accent}" stroke-width="1" opacity=".55"/>`;
      for (const r of ad.hover.rows) {
        const hs = g.yOf(ad.series.find(x => x.key === r.key) || {});
        out += `<circle cx="${g.x(r.t).toFixed(1)}" cy="${hs(r.y).toFixed(1)}" r="3.6"
                        fill="none" stroke="${escAttr(r.color)}" stroke-width="2"/>`;
      }
    }
    // Everything picked, ringed (#191). Over the curves and under the pin, so a
    // pinned reading inside a selection still reads as the pinned one. Capped
    // the way the removal marks are: "all in view" can pick ten thousand
    // readings and ten thousand rings is a solid bar, not a selection.
    if (ad.picked.size && ad.transform === 'value') {
      let rings = '', n = 0;
      for (const s of shown()) {
        const sy = g.yOf(s);
        const i0 = lower(s.t, s.n, g.v.t0), i1 = lower(s.t, s.n, g.v.t1);
        for (let i = i0; i < i1 && n < MARK_CAP; i++) {
          if (!isPicked(s.key, i)) continue;
          const py = sy(s.v[i]);
          if (py < PADT || py > g.h - PADB) continue;
          n++;
          rings += `<circle cx="${g.x(s.t[i]).toFixed(1)}" cy="${py.toFixed(1)}" r="4.5"
                            fill="none" stroke="${c.accent}" stroke-width="1.8" opacity=".95"/>`;
        }
      }
      out += `<g clip-path="url(#ad-clip)">${rings}</g>`;
    }
    if (ad.pin) {
      const s = ad.series.find(x => x.key === ad.pin.key);
      if (s && ad.transform === 'value') {
        const px = g.x(s.t[ad.pin.i]), py = g.yOf(s)(s.v[ad.pin.i]);
        out += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="none"
                        stroke="${c.accent}" stroke-width="2"/>`;
      }
    }
    // The rubber band, in three shapes matching the three committed gestures:
    // a vertical-axis drag shows a full-width band, a box brush shows the box
    // it will zoom to — unless its vertical throw is under AD_BOX_EPS, in
    // which case the feedback goes full-height, honestly promising the x-only
    // zoom the commit will deliver.
    if (ad.drag && ad.drag.mode === 'select') {
      // The lasso, drawn as a dashed box rather than the zoom's filled one:
      // the two gestures look identical under the hand and do entirely
      // different things, so they must not look identical on the chart.
      const a = Math.min(ad.drag.x0, ad.drag.x1), b = Math.max(ad.drag.x0, ad.drag.x1);
      const ya = Math.min(ad.drag.y0, ad.drag.y1), yb = Math.max(ad.drag.y0, ad.drag.y1);
      out += `<rect x="${a.toFixed(1)}" y="${ya.toFixed(1)}" width="${(b - a).toFixed(1)}"
                    height="${(yb - ya).toFixed(1)}" fill="${c.accent}" fill-opacity=".07"
                    stroke="${c.accent}" stroke-width="1.2" stroke-dasharray="5 3"/>`;
    } else if (ad.drag && ad.drag.mode !== 'pan' && ad.drag.mode !== 'movept') {
      const cl = p => Math.max(PADT, Math.min(g.h - PADB, p));
      const a = Math.min(ad.drag.x0, ad.drag.x1), b = Math.max(ad.drag.x0, ad.drag.x1);
      const ya = cl(Math.min(ad.drag.y0, ad.drag.y1)), yb = cl(Math.max(ad.drag.y0, ad.drag.y1));
      if (ad.drag.mode === 'y') {
        out += `<rect x="${PADL}" y="${ya.toFixed(1)}" width="${g.pw}" height="${(yb - ya).toFixed(1)}"
                      fill="${c.accent}" opacity=".14"/>`;
      } else if (Math.abs(ad.drag.y1 - ad.drag.y0) <= AD_BOX_EPS) {
        out += `<rect x="${a.toFixed(1)}" y="${PADT}" width="${(b - a).toFixed(1)}" height="${g.ph}"
                      fill="${c.accent}" opacity=".14"/>`;
      } else {
        out += `<rect x="${a.toFixed(1)}" y="${ya.toFixed(1)}" width="${(b - a).toFixed(1)}"
                      height="${(yb - ya).toFixed(1)}" fill="${c.accent}" opacity=".14"
                      stroke="${c.accent}" stroke-width="1"/>`;
      }
    }

    out += `<line x1="${PADL}" y1="${g.h - PADB}" x2="${g.w - g.padR}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            <line x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            ${g.yrR ? `<line x1="${g.w - g.padR}" y1="${PADT}" x2="${g.w - g.padR}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>` : ''}`;

    const suffix = u => (ad.transform === 'value' ? u
                       : ad.transform === 'increment' ? `${u}/reading` : `${u}/h`);
    const leftLabel = suffix(axisUnit(g.sides.left) || shown()[0]?.unit || '');
    if (leftLabel) {
      out += `<text x="6" y="${PADT + 8}" font-size="10" fill="${c.muted}">${esc(leftLabel)}</text>`;
    }
    if (g.yrR) {
      const rightLabel = suffix(axisUnit(g.sides.right));
      if (rightLabel) {
        out += `<text x="${g.w - 4}" y="${PADT + 8}" font-size="10" text-anchor="end"
                      fill="${c.muted}">${esc(rightLabel)}</text>`;
      }
    }
    if (nMark >= MARK_CAP) {
      out += `<text x="${g.w - g.padR}" y="${PADT + 10}" font-size="10" text-anchor="end" fill="${c.muted}">
                marks capped at ${MARK_CAP} — zoom in for the rest</text>`;
    }
    svg.innerHTML = out;
  }

  // The overview is the whole record at a glance, with the visible window over
  // it — the thing that stops a deep zoom from feeling lost.
  function drawOv() {
    const svg = document.getElementById('ad-ov');
    if (!svg) return;
    const ex = extent();
    if (!ex) { svg.innerHTML = ''; return; }
    const c = theme();
    const w = ad.w, h = AD_OV_H;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // See draw(). Here the shapes are wildly different — a viewBox as wide as
    // the chart and 56 px tall, drawn into a box as wide as the chart and 54 px
    // tall — so `meet` shrank the whole strip by ~3.5% and centred it, putting
    // the edge handles up to 17 px from where every press was being measured.
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    const pw = w - PADL - padRNow();
    const x = t => PADL + (t - ex.t0) / (ex.t1 - ex.t0) * pw;

    let lo = Infinity, hi = -Infinity;
    const vis = shown();
    for (const s of vis) {
      const track = tracks(s)[ad.mode === 'raw' ? 'raw' : 'filt'];
      for (let k = 0; k < track.n; k++) { const y = track.y[k]; if (y < lo) lo = y; if (y > hi) hi = y; }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) hi = lo + 1;
    const y = val => 6 + (1 - (val - lo) / (hi - lo)) * (h - 18);

    let out = `<rect x="0" y="0" width="${w}" height="${h}" fill="${c.panel}"/>`;
    for (const s of vis) {
      const track = tracks(s)[ad.mode === 'raw' ? 'raw' : 'filt'];
      const pts = densify(track, 0, track.n, x, pw);
      if (pts.length) {
        const dash = seriesDash(s);
        out += `<path d="${pathFrom(pts, y, false, track, s)}" fill="none" stroke="${escAttr(s.color)}"
                      stroke-width="1" opacity=".85"
                      ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
      }
    }
    const v = view();
    // Clamped to the track (#191). view() deliberately lets the window run up
    // to a whole span past either end of the record, and an edge handle drawn
    // out there is drawn outside the SVG: the pointer can never reach it, every
    // press lands on "outside the window", and the window jumps instead of
    // resizing — which is exactly what a zoomed-out chart used to do. Clamping
    // the *drawing* is the whole fix; the window itself is untouched, and the
    // hit-test below clamps identically so the two cannot disagree.
    const a = ovClampX(x(v.t0)), b = ovClampX(x(v.t1));
    out += `<rect x="${PADL}" y="4" width="${Math.max(0, a - PADL).toFixed(1)}" height="${h - 16}"
                  fill="${c.muted}" opacity=".22"/>
            <rect x="${b.toFixed(1)}" y="4" width="${Math.max(0, w - padRNow() - b).toFixed(1)}" height="${h - 16}"
                  fill="${c.muted}" opacity=".22"/>
            <rect x="${a.toFixed(1)}" y="4" width="${Math.max(1, b - a).toFixed(1)}" height="${h - 16}"
                  fill="none" stroke="${c.accent}" stroke-width="1.4"/>`;
    // Cursor affordances for the three overview gestures. The rects paint
    // nothing (fill-opacity 0 keeps them hit-testable, which fill="none" would
    // not be) — they exist so the pointer says what a press here will do: grab
    // over the window's middle, ew-resize over its edges. The edge zones come
    // last so they win where they overlap the middle, matching the JS
    // hit-test's own edge-first order, and both run the full height of the
    // strip down to the date labels: the JS only ever looks at x, so a zone
    // shorter than the band gave the strip a stripe along the top where the
    // cursor said one thing and the press did another.
    out += `<rect class="ad-ov-mid" x="${a.toFixed(1)}" y="0"
                  width="${Math.max(1, b - a).toFixed(1)}" height="${h - 12}"
                  fill="${c.accent}" fill-opacity="0"/>`;
    // The two edge handles, drawn as something a hand can land on rather than
    // as a hairline. A 2.5 px pill inside a 12 px zone was the visible half of
    // a promise the pointer could barely keep: it read as a tick mark, not as
    // a grip, so nobody aimed at it, and what they were aiming at was six
    // pixels wide. It is now a proper handle — panel-filled, accent-outlined
    // and ridged down the middle, the way every resize grip is — over a zone
    // navGrip() wide. The handle and the ridges take no pointer events at all,
    // so the classed zone behind them is always what the cursor reads: painted
    // shapes on top of a hit rect are exactly how a cursor stops being
    // reliable.
    const hy = 4 + (h - 16) / 2;
    const grip = navGrip(a, b);
    for (const e of [a, b]) {
      out += `<rect x="${(e - 3.5).toFixed(1)}" y="${(hy - 12).toFixed(1)}" width="7" height="24"
                    rx="3.5" fill="${c.panel}" stroke="${c.accent}" stroke-width="1.3"
                    pointer-events="none"/>
              <path d="M${(e - 1.5).toFixed(1)} ${(hy - 5).toFixed(1)}v10
                       M${(e + 1.5).toFixed(1)} ${(hy - 5).toFixed(1)}v10"
                    stroke="${c.accent}" stroke-width="1" opacity=".7" pointer-events="none"/>
              <rect class="ad-ov-edge" x="${(e - grip).toFixed(1)}" y="0"
                    width="${(grip * 2).toFixed(1)}" height="${h - 12}"
                    fill="${c.accent}" fill-opacity="0"/>`;
    }
    out += `<text x="${PADL - 6}" y="${h - 5}" font-size="9" text-anchor="end" fill="${c.muted}">whole record</text>
            <text x="${PADL}" y="${h - 5}" font-size="9" fill="${c.muted}">${esc(fmtFull(ex.t0).slice(0, 10))}</text>
            <text x="${w - padRNow()}" y="${h - 5}" font-size="9" text-anchor="end" fill="${c.muted}">${esc(fmtFull(ex.t1).slice(0, 10))}</text>`;
    svg.innerHTML = out;

    svg.setAttribute('aria-label', overviewName());

    // Every view change redraws the overview, and nothing else does — which
    // makes this the one place the comparison panes can follow the window
    // without also being rebuilt on every mouse move. Since #141 it is also
    // where the chart's own name and the readings table follow it, for exactly
    // that reason: chartFacts() walks the readings in the window, and doing
    // that on every crosshair move would be a measurable cost for a string
    // nothing reads between one pixel and the next.
    const stage = document.getElementById('ad-svg');
    if (stage) stage.setAttribute('aria-label', chartName());
    drawVov();
    renderTable();
    drawCompare();
  }

  // ── The vertical navigator (#191) ──────────────────────────────────────────
  // The overview strip, stood on its end and pointed at the other axis: the
  // whole value range in the record as a track, the range the chart is drawing
  // as a box on it, and the same three gestures — drag the box to move the
  // range, drag an edge to resize it, press outside it to bring it there.
  //
  // Why it exists at all: the vertical axis had four modes and a pair of number
  // boxes, and no way to *point* at a range. "Show me the bottom metre of this
  // hydrograph" was a mode change, two typed figures and a guess at what the
  // figures should be — for a question the eye had already answered by looking
  // at the chart. The horizontal axis has had the gesture for that all along.
  //
  // It speaks through commitY(), which is the same manual takeover the box
  // zoom and the Alt-drag use, so all three land in one place: yMode goes to
  // 'manual', the two inputs echo the dragged figures, and the stash the reset
  // reads is taken once. There is no fifth axis mode and no second override for
  // yRange() to consult.
  function drawVov() {
    const svg = document.getElementById('ad-vov');
    if (!svg) return;
    const ex = vExtent();
    const v = view();
    if (!ex || !v) { svg.innerHTML = ''; return; }
    const c = theme();
    const w = AD_VOV_W, h = ad.h;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // See draw(). 46 viewBox px of width drawn into 44 of content box is a 4.3%
    // uniform squeeze under `meet`, which on a 600 px column put the two
    // handles a round dozen pixels below the presses aimed at them.
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    // The track runs exactly as far as the plot rectangle does, so a value at
    // the same height on both is at the same height on the screen.
    const ph = h - PADT - PADB;
    const y  = val => PADT + (1 - (val - ex.lo) / (ex.hi - ex.lo)) * ph;
    const trackX = 13, trackW = 16;

    const yr = yRange(v);
    const top = vovClampY(y(yr.hi)), bot = vovClampY(y(yr.lo));

    let out = `<rect x="0" y="0" width="${w}" height="${h}" fill="${c.panel}"/>
               <rect x="${trackX}" y="${PADT}" width="${trackW}" height="${ph}"
                     fill="${c.border}" opacity=".45" rx="3"/>`;

    // Where the readings actually are, down the track — the vertical answer to
    // the sparkline the horizontal strip draws. One band per tenth of the
    // range, opacity by how many readings fall in it, so a hydrograph that
    // spends its life in the bottom metre says so and the operator can see
    // where it is worth dragging the window to.
    const BINS = 24;
    const hist = new Float64Array(BINS);
    let most = 0;
    for (const s of shown()) {
      const track = tracks(s)[ad.mode === 'raw' ? 'raw' : 'filt'];
      for (let k = 0; k < track.n; k++) {
        const f = (track.y[k] - ex.lo) / (ex.hi - ex.lo);
        const b = Math.max(0, Math.min(BINS - 1, Math.floor(f * BINS)));
        if (++hist[b] > most) most = hist[b];
      }
    }
    if (most) {
      const bh = ph / BINS;
      for (let b = 0; b < BINS; b++) {
        if (!hist[b]) continue;
        out += `<rect x="${trackX}" y="${(PADT + ph - (b + 1) * bh).toFixed(1)}"
                      width="${trackW}" height="${(bh + 0.5).toFixed(1)}" fill="${c.accent}"
                      opacity="${(0.12 + 0.6 * (hist[b] / most)).toFixed(3)}"/>`;
      }
    }

    // Everything outside the window, dimmed; the window itself, outlined.
    out += `<rect x="${trackX}" y="${PADT}" width="${trackW}" height="${Math.max(0, top - PADT).toFixed(1)}"
                  fill="${c.muted}" opacity=".3"/>
            <rect x="${trackX}" y="${bot.toFixed(1)}" width="${trackW}"
                  height="${Math.max(0, ad.h - PADB - bot).toFixed(1)}" fill="${c.muted}" opacity=".3"/>
            <rect x="${(trackX - 2).toFixed(1)}" y="${top.toFixed(1)}" width="${trackW + 4}"
                  height="${Math.max(1, bot - top).toFixed(1)}" fill="none"
                  stroke="${c.accent}" stroke-width="1.4" rx="2"/>`;

    // The same cursor contract as the horizontal strip, turned ninety degrees:
    // an invisible but hit-testable middle that says "grab", invisible edge
    // zones that say "resize", and a visible handle at each edge so the promise
    // is not made by the cursor alone. Edges last, so they win where a narrow
    // window makes them overlap the middle — which is the order the hit-test
    // uses too.
    //
    // Both zones take the full width of the column rather than the 24 px around
    // the track. The hit-test only ever looks at y, the column holds nothing
    // else a press could mean, and half the width there was to aim at was
    // being thrown away for no gain.
    const vgrip = navGrip(top, bot);
    const hx = trackX + trackW / 2;
    out += `<rect class="ad-vov-mid" x="0" y="${top.toFixed(1)}"
                  width="${w}" height="${Math.max(1, bot - top).toFixed(1)}"
                  fill="${c.accent}" fill-opacity="0"/>`;
    for (const e of [top, bot]) {
      out += `<rect x="${(hx - 12).toFixed(1)}" y="${(e - 3.5).toFixed(1)}" width="24" height="7"
                    rx="3.5" fill="${c.panel}" stroke="${c.accent}" stroke-width="1.3"
                    pointer-events="none"/>
              <path d="M${(hx - 5).toFixed(1)} ${(e - 1.5).toFixed(1)}h10
                       M${(hx - 5).toFixed(1)} ${(e + 1.5).toFixed(1)}h10"
                    stroke="${c.accent}" stroke-width="1" opacity=".7" pointer-events="none"/>
              <rect class="ad-vov-edge" x="0" y="${(e - vgrip).toFixed(1)}"
                    width="${w}" height="${(vgrip * 2).toFixed(1)}"
                    fill="${c.accent}" fill-opacity="0"/>`;
    }

    // The two ends of the track, named. Rotated rather than wrapped: the column
    // is 46 px and a figure like 1,613.0 does not fit across it.
    const endLabel = (val, py, anchor) => `
      <text x="${trackX + trackW + 9}" y="${py}" font-size="9" fill="${c.muted}"
            text-anchor="${anchor}" transform="rotate(90 ${trackX + trackW + 9} ${py})"
            pointer-events="none">${esc(fmtVal(val))}</text>`;
    out += endLabel(ex.hi, PADT + 2, 'start') + endLabel(ex.lo, ad.h - PADB - 2, 'end');

    svg.innerHTML = out;
    svg.setAttribute('aria-label', vOverviewName());
  }

  // ── side-by-side comparison ────────────────────────────────────────────────

  const CMP_PADL = 46, CMP_PADR = 10, CMP_PADT = 10, CMP_PADB = 20;
  // …and the right margin when a second axis puts two figures in it (#191).
  const CMP_PADR2 = 40;

  // Redrawing both panes on every mouse move would be work for nothing — the
  // crosshair does not reach them. This is what they actually depend on.
  let cmpSig = '';

  function drawCompare(force) {
    const box = document.getElementById('ad-compare');
    const a = document.getElementById('ad-cmp-raw');
    const b = document.getElementById('ad-cmp-filt');
    if (!box || !box.open || !a || !b) return;
    const vis = shown(), v = view();
    if (!vis.length || !v) { a.innerHTML = ''; b.innerHTML = ''; return; }

    const w = Math.max(240, Math.round(a.parentElement.getBoundingClientRect().width));
    const h = Math.round(Math.max(160, Math.min(300, w * 0.62)));
    const sig = [v.t0, v.t1, w, h, ad.transform, ad.chartType, ad.showRemoved, ad.showDupes,
                 ad.yMode, ad.yMin, ad.yMax,
                 cfgKey(ad.cfg, 'cmp'),
                 vis.map(s => `${s.key}${s.color}${s.kind}${s.axis}${s.dash}`).join(',')].join('|');
    // The childNodes test matters: re-rendering the main column hands back a
    // pair of empty <svg>s whose inputs have not changed, and a signature check
    // on its own would leave them empty.
    if (!force && sig === cmpSig && a.childNodes.length) return;
    cmpSig = sig;

    // One scale across both panes. Let each pane fit its own data and the
    // filtered one would come out looking exactly like the raw one, which is
    // the opposite of what a comparison is for.
    //
    // Which scale is the toolbar's business, not a second control here: fitting
    // everything means one 2014 mm spike flattens the filtered pane into a
    // line, and "Kept" is already how you ask to see its shape instead — the
    // spikes then run off the top of the left-hand pane, which is a fair
    // description of them.
    //
    // Since #191 that is one scale *per axis*: a series sent to the right axis
    // is drawn against the right axis here too, and both panes share both
    // scales. The claim these panes make — same window, same scale, so the only
    // difference between them is the filters — is unchanged; what would have
    // broken it is a rainfall trace in millimetres pulling a level in metres
    // flat in *both* panes, which is the very thing the right axis exists to
    // stop and would have come straight back here.
    const paneRange = list => {
      let lo = Infinity, hi = -Infinity;
      for (const s of list) {
        const tr = tracks(s);
        for (const track of ad.yMode === 'kept' ? [tr.filt] : [tr.raw, tr.filt]) {
          const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
          const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
          for (let k = i0; k < i1; k++) { const y = track.y[k]; if (y < lo) lo = y; if (y > hi) hi = y; }
        }
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (ad.yMode === 'zero' && lo > 0) lo = 0;
      if (hi === lo) { hi = lo + 1; lo -= 1; }
      const pad = (hi - lo) * 0.06;
      return { lo: lo - pad, hi: hi + pad };
    };

    const sides = axisSides();
    let yr = paneRange(sides.left.length ? sides.left : vis);
    // Fixed governs the left axis here for the reason it does on the main chart
    // — see yRange().
    if (ad.yMode === 'manual') {
      const a = parseFloat(ad.yMin), b = parseFloat(ad.yMax);
      if (!isNaN(a) && !isNaN(b) && b > a) yr = { lo: a, hi: b };
    }
    const yrR = sides.right.length ? paneRange(sides.right) : null;

    const c = theme();
    for (const [svg, kind] of [[a, 'raw'], [b, 'filt']]) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.innerHTML = cmpPane(kind, w, h, v, yr, c, yrR);
    }
  }

  function cmpPane(kind, w, h, v, yr, c, yrR) {
    const padR = yrR ? CMP_PADR2 : CMP_PADR;
    const pw = w - CMP_PADL - padR, ph = h - CMP_PADT - CMP_PADB;
    const x = t => CMP_PADL + (t - v.t0) / (v.t1 - v.t0) * pw;
    const scale = r => val => CMP_PADT + (1 - (val - r.lo) / (r.hi - r.lo)) * ph;
    const y  = scale(yr);
    const yR = yrR ? scale(yrR) : y;
    // Same rule as the main chart: the left axis keeps the gridlines and a
    // series is drawn against whichever scale it belongs to.
    const yOf = s => (yrR && axisOf(s) === 'right' ? yR : y);
    const { ticks, step } = timeTicks(v.t0, v.t1, Math.max(2, Math.round(pw / 120)));
    const yt = niceTicks(yr.lo, yr.hi, Math.max(2, Math.round(ph / 44)));
    const clip = `ad-cmp-clip-${kind}`;

    let out = `<defs><clipPath id="${clip}"><rect x="${CMP_PADL}" y="${CMP_PADT}"
                 width="${pw}" height="${ph}"/></clipPath></defs>
               <rect x="0" y="0" width="${w}" height="${h}" fill="${c.panel}"/>`;

    out += yt.map(val => `
      <line x1="${CMP_PADL}" y1="${y(val).toFixed(1)}" x2="${w - padR}" y2="${y(val).toFixed(1)}"
            stroke="${c.border}" stroke-width="1"/>
      <text x="${CMP_PADL - 5}" y="${(y(val) + 3.2).toFixed(1)}" font-size="9" text-anchor="end"
            fill="${c.muted}">${esc(fmtVal(val))}</text>`).join('');

    out += ticks.map(t => `
      <line x1="${x(t).toFixed(1)}" y1="${CMP_PADT}" x2="${x(t).toFixed(1)}" y2="${h - CMP_PADB}"
            stroke="${c.border}" stroke-width="1" opacity=".6"/>
      <text x="${x(t).toFixed(1)}" y="${h - CMP_PADB + 12}" font-size="9" text-anchor="middle"
            fill="${c.muted}">${esc(fmtTick(t, step))}</text>`).join('');

    let body = '';
    for (const s of shown()) {
      const sy = yOf(s);
      const track = kind === 'raw' ? tracks(s).raw : tracks(s).filt;
      const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
      const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
      const pts = densify(track, i0, i1, x, pw);
      if (pts.length) {
        const dash = seriesDash(s);
        body += `<path d="${pathFrom(pts, sy, ad.chartType === 'step', track, s)}" fill="none"
                       stroke="${escAttr(s.color)}" stroke-width="1.4"
                       ${dash ? `stroke-dasharray="${dash}"` : ''}
                       stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      // The removals belong on the "as recorded" side: that pane is the record
      // they were removed from.
      if (kind === 'raw' && ad.transform === 'value') {
        const f = runFilter(s, ad.cfg);
        const j0 = lower(s.t, s.n, v.t0), j1 = lower(s.t, s.n, v.t1);
        let n = 0;
        for (let i = j0; i < j1 && n < 900; i++) {
          const st = f.status[i];
          if (st === AD_GOOD || (st === AD_OOS && !ad.showDupes)) continue;
          const px = x(s.t[i]), py = sy(s.v[i]);
          if (py < CMP_PADT - 4 || py > h - CMP_PADB + 4) continue;
          n++;
          const col = st === AD_BAD ? c.bad : st === AD_OOS ? c.muted : c.warn;   // range/rate/fall all warn
          body += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.4" fill="none"
                           stroke="${col}" stroke-width="1.3" opacity=".9"><title>${esc(AD_STATUS_LABEL[st])}
                           · ${esc(fmtVal(s.v[i]))} ${esc(s.unit)}</title></circle>`;
        }
      }
    }
    out += `<g clip-path="url(#${clip})">${body}</g>`;
    out += `<line x1="${CMP_PADL}" y1="${h - CMP_PADB}" x2="${w - padR}" y2="${h - CMP_PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            <line x1="${CMP_PADL}" y1="${CMP_PADT}" x2="${CMP_PADL}" y2="${h - CMP_PADB}"
                  stroke="${c.muted}" stroke-width="1"/>`;
    // The right axis, when there is one. Two values at each end rather than a
    // full column: these panes are 240–420 px wide and a second set of tick
    // labels down them would cost more room than the shape they are there to
    // show. The main chart above carries the whole scale.
    if (yrR) {
      out += `<line x1="${w - padR}" y1="${CMP_PADT}" x2="${w - padR}" y2="${h - CMP_PADB}"
                    stroke="${c.muted}" stroke-width="1"/>
              <text x="${w - padR + 3}" y="${CMP_PADT + 8}" font-size="9"
                    fill="${c.muted}">${esc(fmtVal(yrR.hi))}</text>
              <text x="${w - padR + 3}" y="${h - CMP_PADB - 2}" font-size="9"
                    fill="${c.muted}">${esc(fmtVal(yrR.lo))}</text>`;
    }
    return out;
  }

  // ── interaction ────────────────────────────────────────────────────────────

  // Where a pointer event is, in an SVG's own coordinates — asked of the SVG
  // rather than worked out from its box.
  //
  // The arithmetic this replaces, `(clientX - rect.left) * (ad.w / rect.width)`,
  // looks equivalent and is not, for two reasons that compound. The rect is the
  // *border* box, while the viewBox is fitted into the content box inside it,
  // so each 1 px of border shifted the answer; and preserveAspectRatio, left at
  // its `meet` default, fitted it uniformly and centred what was left over, so
  // a viewBox whose shape did not match its box was drawn scaled down and
  // offset while this went on mapping as though it filled the box corner to
  // corner. On the chart that was a pixel or two. On the two navigators — a
  // viewBox as tall as the stage squeezed into a 56 px strip, and one as wide
  // as the stage squeezed into a 46 px column — it was 12 to 17 px, and that
  // is the whole of why their edge handles could not be grabbed: the handle
  // was painted here and every press was measured over there. The drawers now
  // ask for `none` so the fit is exact, and this asks the browser for the
  // matrix it actually drew with, which cannot disagree with what is on screen.
  function svgPt(ev, el) {
    const m = el.getScreenCTM && el.getScreenCTM();
    if (m) {
      const pt = typeof DOMPoint === 'function'
        ? new DOMPoint(ev.clientX, ev.clientY)
        : Object.assign(el.createSVGPoint(), { x: ev.clientX, y: ev.clientY });
      const q = pt.matrixTransform(m.inverse());
      return { x: q.x, y: q.y };
    }
    // No CTM means the element is not being rendered. Fall back to the box,
    // reading the viewBox off the element rather than assuming the stage's, so
    // this stays right for all three SVGs.
    const r = el.getBoundingClientRect();
    const vb = el.viewBox && el.viewBox.baseVal;
    const vw = vb && vb.width  ? vb.width  : r.width;
    const vh = vb && vb.height ? vb.height : r.height;
    return {
      x: r.width  ? (ev.clientX - r.left) * (vw / r.width)  : 0,
      y: r.height ? (ev.clientY - r.top)  * (vh / r.height) : 0,
    };
  }
  const localX = (ev, el) => svgPt(ev, el).x;

  // Which curves a pointer may land on. Not the same list as layers(): a
  // reading the filter rejected is *drawn* whenever the removal marks are on —
  // as an ✕, a □ or a triangle — and before #191 none of them could be clicked,
  // because this searched the filtered track alone in every mode but Raw. So
  // the one reading somebody actually wants to inspect, or pick and delete, was
  // the one reading on the chart that did not answer a click. The marks are
  // there; they are now reachable.
  //
  // One row per series still: the raw layer is searched, but a hit on it only
  // survives if it is nearer than the filtered layer's, so a kept reading is
  // never shadowed by the removed one beside it.
  function hoverLayers(s) {
    const out = layers(s);
    if (ad.mode === 'raw' || out.some(l => l.kind === 'raw')) return out;
    if (!ad.showRemoved) return out;
    return [...out, { track: tracks(s).raw, kind: 'raw' }];
  }

  function hoverAt(px, py) {
    const g = geom();
    if (!g) return null;
    const t = g.tOf(px);
    const rows = [];
    for (const s of shown()) {
      const sy = g.yOf(s);
      let best = null;
      for (const { track, kind } of hoverLayers(s)) {
        if (!track.n) continue;
        let k = lower(track.t, track.n, t);
        if (k >= track.n) k = track.n - 1;
        if (k > 0 && Math.abs(track.t[k - 1] - t) < Math.abs(track.t[k] - t)) k--;
        const i = track.ref[k];
        const dist = Math.abs(g.x(track.t[k]) - px) + Math.abs(sy(track.y[k]) - py) * 0.35;
        if (best && best.dist <= dist) continue;
        best = {
          key: s.key, label: s.label, color: s.color, unit: s.unit,
          t: track.t[k], y: track.y[k], i, k,
          q: s.qcodes[s.q[i]] || '',
          // Which curve it came off, so the readout can say "kept" or "removed"
          // rather than implying every reading survived.
          kindLabel: ad.mode === 'raw' ? 'raw'
                   : (kind === 'raw' && adCut(statusOf(s, i))) ? 'removed' : 'kept',
          dist,
        };
      }
      if (best) rows.push(best);
    }
    rows.sort((a, b) => a.dist - b.dist);
    return { t, x: px, y: py, rows };
  }

  function showTip(ev) {
    const tip = document.getElementById('ad-tip');
    const stage = document.getElementById('ad-stage');
    if (!tip || !stage || !ad.hover || !ad.hover.rows.length) { if (tip) tip.hidden = true; return; }
    tip.innerHTML = `<div class="ad-tip-t">${esc(fmtFull(ad.hover.t))}</div>`
      + ad.hover.rows.slice(0, 6).map(r => `
        <div class="ad-tip-r"><span class="ad-dot" style="--dot:${escAttr(r.color)}"></span>
          ${esc(r.label)} <b>${esc(fmtVal(r.y))}</b> ${esc(r.unit)}</div>`).join('');
    const r = stage.getBoundingClientRect();
    const lx = ev.clientX - r.left, ly = ev.clientY - r.top;
    tip.hidden = false;
    tip.style.left = Math.min(r.width - tip.offsetWidth - 8, lx + 14) + 'px';
    tip.style.top  = Math.min(r.height - tip.offsetHeight - 8, ly + 14) + 'px';
  }

  // A zoom gesture that lands a vertical range speaks through the same manual
  // mechanism the toolbar's Fixed mode offers — yMode='manual' plus the two
  // string fields the inputs echo — rather than through some second override
  // yRange() would have to consult. Before the first such commit, whatever
  // axis mode the operator had chosen is stashed, so reset can put it back;
  // repeat zooms keep the original stash, because "before any of this" is the
  // state reset should mean.
  function commitY(lo, hi) {
    if (!isFinite(lo) || !isFinite(hi)) return false;
    // Six significant figures keeps the inputs readable; the guard below is
    // yRange()'s own (parse, and max strictly above min), re-checked after
    // rounding so a hair-thin band cannot commit a range that then no-ops.
    const a = String(+lo.toPrecision(6)), b = String(+hi.toPrecision(6));
    if (!(parseFloat(b) > parseFloat(a))) return false;
    if (!ad.yStash) ad.yStash = { yMode: ad.yMode, yMin: ad.yMin, yMax: ad.yMax };
    ad.yMode = 'manual';
    ad.yMin = a; ad.yMax = b;
    return true;
  }

  // The other half of the bargain: undo a gesture's manual takeover. Returns
  // whether anything was restored, so callers know the toolbar changed.
  function restoreY() {
    if (!ad.yStash) return false;
    ad.yMode = ad.yStash.yMode;
    ad.yMin = ad.yStash.yMin;
    ad.yMax = ad.yStash.yMax;
    ad.yStash = null;
    return true;
  }

  // The biggest step one wheel event may take, in pixel-mode delta. Browsers
  // disagree wildly about how big a number one notch of a mouse wheel is —
  // 100 here, 120 there, 53 on a third — while a trackpad sends a stream of 2s
  // and 3s for the same physical gesture. Feeding any of them straight into the
  // exponent meant a mouse zoomed in visible lurches where a trackpad glided,
  // which is the "too jumpy" this exists to answer. Capping the step is what
  // makes the two one gesture: a trackpad's small deltas pass through
  // untouched, a mouse's single big one is held to the same ceiling, and every
  // notch is the same modest move whatever sent it.
  const AD_WHEEL_STEP = 48;

  // Drawing, coalesced onto a frame.
  //
  // A view change costs a chart redraw, both navigators, the readings table and
  // the two comparison panes — and renderTable() is up to 3,000 rows of HTML,
  // guarded against being rebuilt mid-*drag* but not against a wheel, which is
  // neither. A wheel delivers events faster than that work can run, so a flick
  // of it queued a dozen full rebuilds and the chart arrived in lurches a
  // quarter-second behind the hand. The view itself is still updated
  // synchronously — it is two numbers, and the next event has to read them —
  // but the painting happens once per frame however many events landed in it.
  let adFrame = 0;
  function drawSoon() {
    if (adFrame) return;
    adFrame = requestAnimationFrame(() => {
      adFrame = 0;
      draw(); drawOv(); renderReadout();
    });
  }
  function cancelDrawSoon() {
    if (adFrame) { cancelAnimationFrame(adFrame); adFrame = 0; }
  }

  function bind() {
    const stage = document.getElementById('ad-stage');
    const svg = document.getElementById('ad-svg');
    if (!stage || !svg) return;

    svg.onpointermove = ev => {
      const { x: px, y: py } = svgPt(ev, svg);
      if (ad.drag) {
        if (ad.drag.mode === 'movept') {
          // Written straight into the series so the curve, the marks and the
          // readout all follow the hand. The 357 walk is *not* re-run per
          // frame — the caches are dropped at pointerup — so what moves during
          // the drag is the line, and the verdicts catch up when it is let go.
          const g2 = geom();
          if (g2) {
            const dv = g2.valOf(py) - ad.drag.hold.from;
            for (const r of ad.drag.hold.rows) r.s.v[r.i] = r.v0 + dv;
            for (const r of ad.drag.hold.rows) r.s.tracks = null;
          }
          ad.drag.x1 = px; ad.drag.y1 = py;
          draw();
          return;
        }
        if (ad.drag.mode !== 'pan') { ad.drag.x1 = px; ad.drag.y1 = py; draw(); return; }
        const g = geom();
        if (!g) return;
        const dt = (ad.drag.px - px) / g.pw * (ad.drag.t1 - ad.drag.t0);
        ad.view = { t0: ad.drag.t0 + dt, t1: ad.drag.t1 + dt };
        draw(); drawOv();
        return;
      }
      ad.hover = hoverAt(px, py);
      draw();
      showTip(ev);
      renderReadout();
    };
    svg.onpointerleave = () => {
      ad.hover = null;
      const tip = document.getElementById('ad-tip');
      if (tip) tip.hidden = true;
      draw(); renderReadout();
    };
    svg.onpointerdown = ev => {
      if (ev.button) return;   // the primary button gestures; a right-click is the menu
      const g = geom();
      if (!g) return;
      svg.setPointerCapture?.(ev.pointerId);
      const { x: px, y: py } = svgPt(ev, svg);
      // Which gesture this press begins. The modifiers outrank the checkboxes
      // so a keyboard hand can always reach either zoom without touching the
      // toolbar: Alt means the vertical axis, Shift means a box, and only
      // then do the armed toggles speak — else the drag pans, as ever.
      let mode = ev.altKey ? 'y' : ev.shiftKey ? 'box' : (ad.dragMode || 'pan');
      // In Select, a press that lands on a reading that is already picked is a
      // grab on *that reading* rather than the start of a new box — which is
      // what "physically move the point" has to mean: you pick it, then you
      // take hold of it. Pressing anywhere else in Select starts a lasso, so
      // the two never compete for the same press.
      let hold = null;
      if (mode === 'select') {
        const h = hoverAt(px, py);
        const near = h && h.rows[0] && h.rows[0].dist <= AD_GRAB_PX && isPicked(h.rows[0].key, h.rows[0].i);
        if (near) {
          const s = find(h.rows[0].key);
          if (s) {
            mode = 'movept';
            // Every picked reading moves together, by the same amount, from the
            // values they had at the press — so a stretch dragged down keeps
            // its shape instead of collapsing onto one value.
            const rows = [];
            for (const [ser, idx] of pickedBySeries()) {
              for (const i of idx) rows.push({ s: ser, i, v0: ser.v[i] });
            }
            hold = { rows, from: g.valOf(py) };
          }
        }
      }
      ad.drag = { px, py, x0: px, y0: py, x1: px, y1: py, t0: g.v.t0, t1: g.v.t1, mode, hold };
    };
    svg.onpointerup = ev => {
      const d = ad.drag;
      ad.drag = null;
      if (!d) return;
      const g = geom();
      if (!g) return;
      const { x: px, y: py } = svgPt(ev, svg);
      // Movement on either axis makes a drag. Judging by x alone — as this
      // once did — reads a purely vertical zoom stroke as a click and pins a
      // reading nobody pointed at.
      const dx = Math.abs(px - d.x0), dy = Math.abs(py - d.y0);
      const moved = dx > 3 || dy > 3;
      const cl = p => Math.max(PADT, Math.min(g.h - PADB, p));
      let yDone = false;
      if (d.mode === 'movept') {
        // Pressed a picked reading and let go without moving it: that is the
        // gesture for putting one back, and it has to be, because press-on-a-
        // picked-reading is claimed by the grab and would otherwise be the one
        // reading in the selection a click could not remove.
        if (!moved) {
          const h = hoverAt(px, py);
          if (h && h.rows[0]) pickToggle(h.rows[0].key, h.rows[0].i);
          return;
        }
        // The values were written live during the drag; this is the tail that
        // makes it an edit — mark the rows, drop the caches, repaint the rail.
        if (moved) {
          for (const r of d.hold.rows) { keepOriginal(r.s); r.s.edited[r.i] = 1; invalidate(r.s); }
          afterEdit(`${d.hold.rows.length.toLocaleString()} reading${
            d.hold.rows.length === 1 ? '' : 's'} moved on the chart.`);
        }
        return;
      }
      if (moved && d.mode === 'select') {
        const n = pickInBox(d.x0, d.y0, px, py);
        renderReadout();
        if (adTableModalOpen) renderTableModal(); else renderTable(true);
        announce(n ? `${n.toLocaleString()} reading${n === 1 ? '' : 's'} picked, ${
          ad.picked.size.toLocaleString()} in all.` : 'Nothing in that box.');
        draw();
        return;
      }
      if (moved && d.mode === 'box') {
        const a = g.v.t0 + (Math.min(d.x0, px) - PADL) / g.pw * (g.v.t1 - g.v.t0);
        const b = g.v.t0 + (Math.max(d.x0, px) - PADL) / g.pw * (g.v.t1 - g.v.t0);
        if (b - a > 1000) ad.view = { t0: a, t1: b };
        // The vertical side only commits past AD_BOX_EPS — a flat sweep stays
        // the x-only zoom it always was.
        if (dy > AD_BOX_EPS) {
          yDone = commitY(g.valOf(cl(Math.max(d.y0, py))), g.valOf(cl(Math.min(d.y0, py))));
        }
      } else if (moved && d.mode === 'y') {
        if (dy > AD_BOX_EPS) {
          yDone = commitY(g.valOf(cl(Math.max(d.y0, py))), g.valOf(cl(Math.min(d.y0, py))));
        }
      } else if (!moved) {
        const h = hoverAt(px, py);
        const hit = h && h.rows[0] && h.rows[0].dist <= AD_GRAB_PX ? h.rows[0] : null;
        // In Select, and with Ctrl or ⌘ held in any mode, a click adds or
        // removes one reading. Everywhere else it pins one, which is what it
        // has always done — so the reading-in-full inspector is never behind a
        // mode change.
        if ((d.mode === 'select' || ev.ctrlKey || ev.metaKey) && hit) {
          pickToggle(hit.key, hit.i);
          return;
        }
        if (h && h.rows.length) ad.pin = { key: h.rows[0].key, i: h.rows[0].i };
        else ad.pin = null;
      }
      // A committed vertical range changes the toolbar — the Fixed segment
      // lights and the min/max inputs appear holding the dragged numbers — so
      // the pane re-renders whole; init() inside it draws chart, overview and
      // readout, which is the same trio every other gesture ends on.
      if (yDone) { renderMainOnly(); return; }
      draw(); drawOv(); renderReadout();
    };
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      const g = geom();
      if (!g) return;
      // deltaY and deltaX arrive in whatever unit the browser felt like:
      // pixels on most, lines on Firefox, pages on a rare few. Left unscaled a
      // line-mode notch is a delta of about 3 where a pixel-mode one is about
      // 50, which is why a Firefox wheel used to barely move the chart. One
      // factor, applied to both axes, so the two gestures feel the same
      // everywhere.
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
      // A wheel that says "sideways" pans time rather than zooming it. That is
      // a tilt wheel or a trackpad's horizontal gesture, which arrive as
      // deltaX, and Shift+wheel, which is the one-wheel mouse's way of saying
      // the same thing — some platforms already turn Shift+wheel into deltaX
      // themselves, so both have to be read, and the || is what stops a
      // platform that does both from panning twice as far.
      //
      // Requiring x to actually dominate is what keeps a trackpad usable: a
      // two-finger scroll meant as a zoom drifts a pixel or two sideways nearly
      // every time, and "any deltaX at all pans" would turn most zooms into
      // pans. Shift overrides the test outright, because a hand holding Shift
      // has said what it wants.
      const sideways = ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
      const raw = sideways ? (ev.deltaX || (ev.shiftKey ? ev.deltaY : 0)) : 0;
      // Both gestures are capped by the same figure, so a notch pans about as
      // far as a notch zooms and neither one lurches. See AD_WHEEL_STEP.
      const cap = d => Math.max(-AD_WHEEL_STEP, Math.min(AD_WHEEL_STEP, d * unit));
      if (raw) {
        const dt = cap(raw) / g.pw * (g.v.t1 - g.v.t0);
        ad.view = { t0: g.v.t0 + dt, t1: g.v.t1 + dt };
        drawSoon();
        return;
      }
      if (!ev.deltaY) return;
      const t = g.tOf(localX(ev, svg));
      const z = Math.exp(cap(ev.deltaY) * 0.0014);
      ad.view = { t0: t - (t - g.v.t0) * z, t1: t + (g.v.t1 - t) * z };
      drawSoon();
    }, { passive: false });
    // Reset means both axes: the window goes, and the vertical mode goes back
    // to whatever the operator had before a zoom gesture commandeered it.
    // Restoring can change the toolbar (the Fixed segment and its inputs), so
    // that path re-renders the pane instead of just redrawing.
    svg.ondblclick = () => {
      ad.view = null; ad.pin = null;
      if (restoreY()) { renderMainOnly(); return; }
      draw(); drawOv(); renderReadout();
    };

    stage.onkeydown = ev => {
      const g = geom();
      if (!g) return;
      const span = g.v.t1 - g.v.t0;
      const pan = d => { ad.view = { t0: g.v.t0 + d, t1: g.v.t1 + d }; };
      const zoom = f => {
        const mid = (g.v.t0 + g.v.t1) / 2;
        ad.view = { t0: mid - span * f / 2, t1: mid + span * f / 2 };
      };
      switch (ev.key) {
        case 'ArrowLeft':  pan(-span * 0.2); break;
        case 'ArrowRight': pan(span * 0.2);  break;
        case '+': case '=': zoom(0.6); break;
        case '-': case '_': zoom(1.7); break;
        case '0':
          ad.view = null;
          // Same both-axes reset as double-click — but this hand is on the
          // keyboard, so after the pane re-renders the stage takes focus back
          // rather than dropping it on the floor.
          if (restoreY()) {
            ev.preventDefault();
            renderMainOnly();
            document.getElementById('ad-stage')?.focus();
            return;
          }
          break;
        // Escape gives back the most recent thing claimed: the selection first,
        // then the pin. One key, unwound in the order they were made.
        case 'Escape':
          if (ad.picked.size) { ev.preventDefault(); pickClear(); return; }
          ad.pin = null;
          break;
        default: return;
      }
      ev.preventDefault();
      draw(); drawOv(); renderReadout();
    };

    bindNavigators();

    const drop = document.getElementById('ad-drop');
    if (drop) {
      for (const e of ['dragover', 'dragenter']) {
        drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('ad-drop--active'); });
      }
      for (const e of ['dragleave', 'drop']) {
        drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('ad-drop--active'); });
      }
      drop.addEventListener('drop', ev => importFiles(ev.dataTransfer && ev.dataTransfer.files));
    }
  }

  // ── The two navigators ─────────────────────────────────────────────────────
  // One binding for both, because they are one interaction on two axes: a track
  // showing everything there is, a box showing what the chart is drawing, and
  // three gestures over it.
  //
  // **What a press means, and the bug this rewrote (#191).** The rule is the
  // one anybody would guess from the cursor: within the box, the box *moves*;
  // at an edge, that edge *resizes*; outside the box, the box comes to where
  // you pressed. The horizontal strip used to get the middle case wrong in a
  // way that read as randomness. Its press handler recognised the two edges and
  // called *everything else* "pan" — and "pan" re-centred the window on the
  // press point. So a press two pixels outside the grip, which the cursor had
  // just promised was a resize, threw the window sideways by however far off
  // centre it landed; a press dead in the middle did nothing at all; and the
  // two were the same gesture. On a zoomed-out chart it was worse: view() lets
  // the window run a whole span past either end of the record, so both edge
  // handles were drawn off the ends of the track, no press could ever reach
  // one, and *every* press jumped. Three things fix it — the clamp in drawOv,
  // a real "move" that tracks the pointer by its grab offset instead of
  // teleporting to it, and a grip wide enough to hit — and only "move" is new
  // behaviour; the other two are the promised behaviour becoming reachable.
  //
  // A jump still exists and is still worth having, but it is now only what it
  // says: press somewhere the window is not, and the window comes to you. It
  // then becomes a move, so one gesture is press-to-there-and-drag.
  // The grip itself is AD_OV_GRIP / navGrip(), up with the other constants
  // both drawers quote, so the zone a press is measured against and the zone
  // the cursor is promised over are one figure and not two.
  const AD_OV_MIN  = 1000;  // the narrowest window a drag may leave, in ms

  // Which of the four a press at `p` is, given the window's two edges. Edges
  // first and the nearer one when both are in reach: an edge is the smaller
  // target, so it has to win wherever a narrow window makes them overlap — the
  // same order the two SVGs stack their cursor zones in.
  function navHit(p, lo, hi) {
    const g = navGrip(lo, hi);
    const dlo = Math.abs(p - lo), dhi = Math.abs(p - hi);
    if (dlo <= g && dlo <= dhi) return 'lo';
    if (dhi <= g) return 'hi';
    return (p > lo && p < hi) ? 'move' : 'jump';
  }

  // A cursor zone only speaks while the pointer is inside it, and a drag is
  // the one time the pointer routinely leaves — past the end of the track, up
  // onto the chart, off the window entirely — with the gesture still running
  // because the element holds the pointer capture. The cursor would flick back
  // to the strip's own `pointer` halfway through a resize, which is the second
  // half of "the double arrow does not reliably appear". So the gesture itself
  // states the cursor, on the whole element, until it ends.
  function navCursor(el, kind) {
    if (!el) return;
    el.classList.toggle('is-resizing', kind === 'lo' || kind === 'hi');
    el.classList.toggle('is-moving',   kind === 'move');
  }

  function bindNavigators() {
    const after = () => { draw(); drawOv(); renderReadout(); };

    // ── The whole record, along the bottom ──────────────────────────────────
    const ov = document.getElementById('ad-ov');
    if (ov) {
      // svgPt(), not the same sum by hand: the strip's own handles are what a
      // press here is measured against, and a mapping that disagrees with the
      // one that drew them by even a border's width is the bug this navigator
      // spent its life with. One mapping, asked of the element.
      const pxOf = ev => svgPt(ev, ov).x;
      const tAt = (px, ex) => ex.t0 + (px - PADL) / (ad.w - PADL - padRNow()) * (ex.t1 - ex.t0);

      const move = ev => {
        const d = ad.ovDrag;
        const ex = extent();
        if (!d || !ex) return;
        const t = tAt(pxOf(ev), ex);
        if (d.kind === 'lo') {
          ad.view = { t0: Math.min(t, d.t1 - AD_OV_MIN), t1: d.t1 };
        } else if (d.kind === 'hi') {
          ad.view = { t0: d.t0, t1: Math.max(t, d.t0 + AD_OV_MIN) };
        } else {
          // The grab offset is the whole of why this does not teleport: the
          // window keeps whatever part of it was under the pointer at the
          // press, so it follows the hand rather than snapping its centre to it.
          const dt = t - d.grab;
          ad.view = { t0: d.t0 + dt, t1: d.t1 + dt };
        }
        after();
      };

      ov.onpointerdown = ev => {
        if (ev.button) return;   // as on the stage: only the primary button drags
        const ex = extent();
        const v = view();
        if (!ex || !v) return;
        ov.setPointerCapture?.(ev.pointerId);
        const pw = ad.w - PADL - padRNow();
        const at = t => ovClampX(PADL + (t - ex.t0) / (ex.t1 - ex.t0) * pw);
        const px = pxOf(ev);
        let kind = navHit(px, at(v.t0), at(v.t1));
        let { t0, t1 } = v;
        if (kind === 'jump') {
          // Bring the window here, keeping its width, and carry on as a move
          // with the pointer in the middle of it — which is where it now is.
          const half = (t1 - t0) / 2;
          const t = tAt(px, ex);
          t0 = t - half; t1 = t + half;
          ad.view = { t0, t1 };
          kind = 'move';
        }
        ad.ovDrag = { kind, t0, t1, grab: tAt(px, ex) };
        navCursor(ov, kind);
        after();
      };
      ov.onpointermove = ev => { if (ad.ovDrag) move(ev); };
      ov.onpointerup = () => { ad.ovDrag = null; navCursor(ov, null); };
      ov.onpointercancel = () => { ad.ovDrag = null; navCursor(ov, null); };
      // Double-click anywhere on the strip is the whole record back, matching
      // the same gesture on the chart above it.
      ov.ondblclick = () => { ad.ovDrag = null; navCursor(ov, null); ad.view = null; after(); };
    }

    // ── The whole vertical range, down the right ────────────────────────────
    // Screen y runs downwards and values run upwards, so 'lo' here is the *top*
    // edge and holds the window's maximum. Naming them by which edge of the box
    // they are rather than by which value they carry is what lets navHit() be
    // the same function for both axes.
    const vov = document.getElementById('ad-vov');
    if (vov) {
      const pyOf = ev => svgPt(ev, vov).y;   // see pxOf on the strip above
      const valAt = (py, ex) => ex.hi - (py - PADT) / (ad.h - PADT - PADB) * (ex.hi - ex.lo);
      // The narrowest vertical window a drag may leave. Proportional rather
      // than absolute: 1000 ms means something on every record, one millimetre
      // does not.
      const minSpan = ex => (ex.hi - ex.lo) / 400;

      const move = ev => {
        const d = ad.vovDrag;
        const ex = vExtent();
        if (!d || !ex) return;
        const val = valAt(pyOf(ev), ex);
        const m = minSpan(ex);
        let lo = d.lo, hi = d.hi;
        if (d.kind === 'lo')      hi = Math.max(val, d.lo + m);      // top edge → the maximum
        else if (d.kind === 'hi') lo = Math.min(val, d.hi - m);      // bottom edge → the minimum
        else { const dv = val - d.grab; lo = d.lo + dv; hi = d.hi + dv; }
        if (commitY(lo, hi)) { draw(); drawVov(); renderReadout(); }
      };

      vov.onpointerdown = ev => {
        if (ev.button) return;
        const ex = vExtent();
        const v = view();
        if (!ex || !v) return;
        vov.setPointerCapture?.(ev.pointerId);
        const ph = ad.h - PADT - PADB;
        const at = val => vovClampY(PADT + (1 - (val - ex.lo) / (ex.hi - ex.lo)) * ph);
        const py = pyOf(ev);
        const yr = yRange(v);
        let kind = navHit(py, at(yr.hi), at(yr.lo));   // top edge first: see above
        let { lo, hi } = yr;
        if (kind === 'jump') {
          const half = (hi - lo) / 2;
          const val = valAt(py, ex);
          lo = val - half; hi = val + half;
          kind = 'move';
        }
        ad.vovDrag = { kind, lo, hi, grab: valAt(py, ex) };
        navCursor(vov, kind);
        // The first commit is what moves the toolbar to Fixed and fills its two
        // inputs, so the pane is re-rendered once, here, rather than on every
        // frame of the drag — and only when the press actually changed the
        // range, which a press on the middle of the box does not.
        const wasManual = ad.yMode === 'manual';
        if (commitY(lo, hi)) {
          if (wasManual) { draw(); drawVov(); renderReadout(); }
          else {
            renderMainOnly();
            // renderMainOnly() rebuilds the element the capture was taken on,
            // so the gesture would end here. Re-take it on the new one.
            const again = document.getElementById('ad-vov');
            if (again) { try { again.setPointerCapture?.(ev.pointerId); } catch (_) {} }
            navCursor(again, kind);
          }
        }
      };
      vov.onpointermove = ev => { if (ad.vovDrag) move(ev); };
      // The element may have been replaced mid-gesture (see above), so the end
      // of the drag clears the class off whichever one is on the page now.
      const vovDone = () => { ad.vovDrag = null; navCursor(document.getElementById('ad-vov'), null); };
      vov.onpointerup = vovDone;
      vov.onpointercancel = vovDone;
      // …and double-click gives the axis back to whatever mode it was in.
      vov.ondblclick = () => {
        vovDone();
        if (restoreY()) renderMainOnly(); else { draw(); drawVov(); }
      };
    }
  }

  function init() {
    // The observer below outlives the element it watches unless something drops
    // it on the way out of the tab. Saying so here, rather than being named in
    // app.js's stop-list, is #142; re-registering on every render is harmless
    // because the registry is keyed by name.
    registerTabTeardown('ArroData', stop);
    if (ad.ro) { ad.ro.disconnect(); ad.ro = null; }
    measure();
    bind();
    // The class is state-driven and render() emits it, so this only has to put
    // the Escape listener back after a re-render that dropped it.
    syncFullEsc();
    draw();
    drawOv();          // …which draws the vertical navigator from its tail
    const stage = document.getElementById('ad-stage');
    if (stage && typeof ResizeObserver !== 'undefined') {
      // The comparison panes size themselves off their own column, which the
      // stage's width tracks, so one observer serves both.
      ad.ro = new ResizeObserver(() => { if (measure()) { draw(); drawOv(); } });
      ad.ro.observe(stage);
    }
  }

  // Leaving the tab takes the full screen with it: the class dies with the
  // markup, and a document-level Escape handler for a chart that is no longer
  // on the page would be the leak #142 exists to stop.
  function stop() {
    if (ad.ro) { ad.ro.disconnect(); ad.ro = null; }
    cancelDrawSoon();
    ad.full = false;
    syncFullEsc();
  }

  function renderAll() {
    const side = document.getElementById('ad-side');
    const main = document.querySelector('.ad-main');
    if (!side || !main) { renderMain(); return; }
    side.innerHTML = sideHtml();
    main.innerHTML = mainHtml();
    init();
  }
  function renderSide() {
    const side = document.getElementById('ad-side');
    if (side) side.innerHTML = sideHtml();
    bind();
  }
  function renderReadout() {
    const el = document.getElementById('ad-readout');
    if (el) el.innerHTML = readoutHtml();
  }
  // Config and visibility changes invalidate the drawn curves but not the page.
  // The toolbar alone. Since #191 the Mark group shows the shapes each switched-on
  // filter draws, which is a fact about ad.cfg — so a filter turned on in the
  // rail has to repaint the toolbar as well, and repainting the whole main pane
  // for it would re-bind the chart and drop the pointer mid-gesture.
  function rerenderToolbar() {
    const el = document.getElementById('ad-toolbar');
    if (el) el.outerHTML = toolbarHtml();
  }

  function redraw(sideToo) {
    for (const s of ad.series) s.tracks = null;
    if (sideToo) renderSide();
    rerenderToolbar();
    draw(); drawOv(); renderReadout();
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  const find = key => ad.series.find(s => s.key === key);

  function pick(input) { importFiles(input.files); input.value = ''; }

  function toggle(key) { const s = find(key); if (s) { s.visible = !s.visible; redraw(true); } }
  // A colour chosen by hand takes the series out of the token palette for good,
  // in both themes. Overruling it on the next theme toggle would be the app
  // undoing a decision the operator made, which is worse than a colour that is
  // a little dark on one of the two.
  // An empty value means "give it back to the theme" (#191): clearing colorSet
  // is what lets reslotColors() re-resolve it on the next theme change, which
  // is the whole reason that flag exists.
  function setColor(key, v) {
    const s = find(key);
    if (!s) return;
    if (v) { s.color = v; s.colorSet = true; }
    else   { s.colorSet = false; s.color = slotColor(s.slot || 0); }
    // The swatch grid repaints too — the "currently this one" ring moved, and
    // the card's own dot with it.
    renderSide();
    draw(); drawOv(); drawVov(); drawCompare(true);
  }

  // Which series' colour grid is open. On the instance rather than in the DOM
  // because renderSide() rebuilds the whole rail on every change inside it, and
  // a <details> that shuts itself the moment you pick a colour is a grid you
  // can only use once per open.
  function colourToggle(key, open) {
    const next = open ? key : (ad.colourOpen === key ? null : ad.colourOpen);
    if (next === ad.colourOpen) return;
    ad.colourOpen = next;
  }

  function setDash(key, v) { const s = find(key); if (s) { s.dash = v; draw(); drawOv(); drawCompare(true); } }

  // Moving a series between the axes changes the plot's right margin, which
  // every scale on the chart is measured off — so this is a redraw of the whole
  // trio rather than of the curve that moved.
  function setAxis(key, v) {
    const s = find(key);
    if (!s) return;
    s.axis = v === 'right' ? 'right' : 'left';
    renderSide();
    draw(); drawOv(); drawVov(); drawCompare(true);
  }
  function setKind(key, v) { const s = find(key); if (s) { s.kind = v; s.filt = null; s.tracks = null; redraw(true); } }
  function solo(key) { ad.series.forEach(s => { s.visible = s.key === key; }); redraw(true); }
  function zoomTo(key) {
    const s = find(key);
    if (!s || !s.n) return;
    ad.view = { t0: s.t[0], t1: s.t[s.n - 1] };
    draw(); drawOv(); renderReadout();
  }
  // A series that has been edited says so before it goes, because closing it is
  // the one way to lose those edits without being asked (#191).
  function removeWarning(s) {
    const ed = editedCount(s), del = s.deleted || 0;
    if (!ed && !del) return '';
    return `${s.label} has ${[ed ? `${ed.toLocaleString()} edited reading${ed === 1 ? '' : 's'}` : '',
                              del ? `${del.toLocaleString()} deleted` : ''].filter(Boolean).join(' and ')}. `
         + 'Removing it loses them — the exports are the only copy. Remove it anyway?';
  }

  // Picks belonging to series that are going away go with them: pickedBySeries()
  // already skips them, but ad.picked.size is what the toolbar counts and a
  // count of readings nobody can reach is a lie.
  function forgetPicks(keys) {
    if (!ad.picked.size) return;
    const gone = new Set(keys);
    for (const k of [...ad.picked]) if (gone.has(k.slice(0, k.indexOf('\u0000')))) ad.picked.delete(k);
  }

  function remove(key) {
    const s = find(key);
    const warn = s ? removeWarning(s) : '';
    if (warn && !confirm(warn)) return;
    ad.series = ad.series.filter(x => x.key !== key);
    if (ad.pin && ad.pin.key === key) ad.pin = null;
    forgetPicks([key]);
    ad.view = null;
    renderAll();
  }
  function clearAll() {
    const what = ad.source === 'field' ? 'loaded series' : 'imports';
    const edited = ad.series.filter(s => editedCount(s) || s.deleted).length;
    const extra = edited
      ? ` ${edited} of them ${edited === 1 ? 'has' : 'have'} unsaved edits, which go with them.` : '';
    if ((ad.series.length > 1 || edited)
        && !confirm(`Remove all ${ad.series.length} ${what}?${extra}`)) return;
    forgetPicks(ad.series.map(s => s.key));
    ad.series = []; ad.pin = null; ad.hover = null; ad.view = null;
    renderAll();
  }

  // The memory meter's release. It counted both instances, so it drops both —
  // clearAll() is the per-tab button and deliberately never reaches across.
  function dropAll() {
    const total = Object.values(instances).reduce((a, i) => a + i.series.length, 0);
    if (!total) return;
    if (total > 1 && !confirm(`Remove all ${total} loaded series, on both data tabs?`)) return;
    for (const i of Object.values(instances)) {
      i.series = []; i.pin = null; i.hover = null; i.view = null; i.picked.clear();
    }
    renderAll();
  }
  function showStation(id) {
    state.selectedId = id;
    state.activeTab = 'stations';
    renderTabs();
    renderMain();
  }

  // The two range limits are the only settings where blank is itself a value —
  // "no limit" — so they are kept as typed instead of being coerced to 0.
  const AD_BLANKABLE = new Set(['rangeMin', 'rangeMax']);

  function setCfg(k, v) {
    ad.cfg[k] = typeof v === 'boolean' ? v
      : AD_BLANKABLE.has(k) ? (isFinite(parseFloat(v)) ? parseFloat(v) : '')
      : (parseFloat(v) || 0);
    for (const s of ad.series) { s.filt = null; s.tracks = null; }
    redraw(true);
  }
  function resetCfg() {
    ad.cfg = { ...AD_CFG_DEFAULT };
    for (const s of ad.series) { s.filt = null; s.tracks = null; }
    redraw(true);
  }

  function setMode(v)      { ad.mode = v; renderMainOnly(); }
  function setTransform(v) { ad.transform = v; for (const s of ad.series) s.tracks = null; renderMainOnly(); }
  function setChart(v)     { ad.chartType = v; renderMainOnly(); }
  // Choosing an axis mode — or typing into the range inputs — by hand drops
  // any stash a zoom gesture left behind: the operator has spoken since, and
  // reset must not overrule them with older state.
  function setY(v)         { ad.yMode = v; ad.yStash = null; renderMainOnly(); }
  // drawVov as well as draw: the navigator's box *is* the range these two boxes
  // hold, and one of the three saying something different from the other two is
  // the failure that navigator exists to prevent.
  function setYRange(which, v) {
    if (which === 'min') ad.yMin = v; else ad.yMax = v;
    ad.yStash = null;
    draw(); drawVov();
  }
  function setFlag(k, v)   { ad[k] = v; renderMainOnly(); }
  // Select works against where a reading is *drawn*, which only means the
  // reading itself while the chart is showing values — on Increment or Rate the
  // height of a point is a difference between two readings, and a box drawn
  // over it would pick whichever readings happened to produce it. So arming
  // Select puts the chart back on Value and says so, rather than quietly
  // picking the wrong rows.
  function setDrag(v) {
    ad.dragMode = v;
    if (v === 'select' && ad.transform !== 'value') {
      ad.transform = 'value';
      for (const s of ad.series) s.tracks = null;
      note('Showing Value — a reading can only be picked where it is drawn, and on '
         + 'Increment or Rate a point is the difference between two of them.');
    }
    renderMainOnly();
  }
  // The two edit fields keep what is typed without re-rendering under the
  // caret — which is what happens if the input's own value is state a render
  // reads back.
  function setEditVal(v)   { ad.editVal = String(v == null ? '' : v); }
  function setEditQ(v)     { ad.editQ = String(v == null ? '' : v); }

  // ── Reset the view, and full screen (#191) ─────────────────────────────────

  // Both axes back to where the tab opened them: the whole record across, and
  // whatever vertical mode was set before a gesture took it to Fixed. Exactly
  // what double-click and the 0 key already did — this is the same thing with a
  // button on it, because the two that existed were a gesture nobody is told
  // about and a keystroke that needs the chart focused first. The pin goes too:
  // it is a reading picked out of a view that is being thrown away.
  function resetView() {
    ad.view = null;
    ad.pin = null;
    const moved = restoreY();
    if (moved) renderMainOnly();
    else { draw(); drawOv(); renderReadout(); }
    announce('Chart view reset — the whole record, and the vertical axis back to '
           + `${AD_Y_LABEL[ad.yMode] || ad.yMode}.`);
  }

  // The chart over the whole viewport. A class on the plot wrapper rather than
  // a re-render, for the map's reason (toggleMapFullscreen): nothing moves in
  // the DOM, so the pointer capture, the pin and the in-flight gesture all
  // survive it — and the two navigators are inside the same wrapper, so they
  // grow with it without knowing they have.
  //
  // measure() reads the stage after the class lands and the draw follows, which
  // is why this cannot simply toggle and return: the SVG is sized in viewBox
  // units off ad.w / ad.h, and both have just changed.
  function toggleFull(on) {
    ad.full = on == null ? !ad.full : !!on;
    const plot = document.getElementById('ad-plot');
    if (plot) plot.classList.toggle('is-full', ad.full);
    syncFullEsc();
    measure();
    draw(); drawOv();
    // The two buttons live in the markup, so their pressed state and titles are
    // re-emitted rather than poked — there are two of them and one is a label
    // that changes.
    const acts = plot && plot.querySelector('.ad-stage-acts');
    if (acts) {
      const b = acts.lastElementChild;
      if (b) {
        b.setAttribute('aria-pressed', String(ad.full));
        b.title = ad.full ? 'Exit full screen (Escape)' : 'Full screen';
        b.setAttribute('aria-label', ad.full ? 'Exit full screen' : 'Chart full screen');
      }
    }
    announce(ad.full ? 'Chart is full screen. Press Escape to exit.' : 'Chart back in the page.');
    if (ad.full) document.getElementById('ad-stage')?.focus();
  }

  // Escape leaves full screen — the same contract the full-screen map keeps,
  // including yielding to anything that has already claimed the key (a modal
  // opened over the chart takes it first, and the chart stays full).
  let fullEsc = null;
  function syncFullEsc() {
    if (ad.full && !fullEsc) {
      fullEsc = e => {
        if (e.defaultPrevented || e.key !== 'Escape') return;
        e.preventDefault();
        toggleFull(false);
      };
      document.addEventListener('keydown', fullEsc);
    } else if (!ad.full && fullEsc) {
      document.removeEventListener('keydown', fullEsc);
      fullEsc = null;
    }
  }
  function unpin()         { ad.pin = null; draw(); renderReadout(); }

  // <details> reports its own state, so this only has to remember it across
  // re-renders and draw the panes the first time they are actually on screen.
  function compareToggle(el) {
    ad.compare = !!el.open;
    if (ad.compare) drawCompare(true);
  }

  function renderMainOnly() {
    const main = document.querySelector('.ad-main');
    if (!main) return;
    main.innerHTML = mainHtml();
    init();
  }

  function preset(k) {
    const ex = extent();
    if (!ex) return;
    if (k === 'all') ad.view = null;
    else {
      const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[k] || 1;
      ad.view = { t0: ex.t1 - days * AD_DAY, t1: ex.t1 };
    }
    draw(); drawOv(); renderReadout();
  }

  // ── export ─────────────────────────────────────────────────────────────────

  function exportCsv(which) {
    const vis = shown();
    if (!vis.length) { note('Nothing to export — no series is shown.', true); return; }
    if (ad.source === 'field') return exportFieldCsv(which, vis);

    const multi = vis.length > 1;
    const head = ['Reading', 'Receive', 'Value', 'Unit', 'Data Quality', 'Raw Value', 'Adjusted Value'];
    if (which === 'all') head.push('Filter Status');
    if (multi) head.unshift('Series', 'Sensor Id');

    const lines = [head.join(',')];
    let rows = 0;
    for (const s of vis) {
      const f = runFilter(s, ad.cfg);
      for (let i = 0; i < s.n; i++) {
        if (which === 'kept' && f.status[i] !== AD_GOOD) continue;
        const r = [fmtFull(s.t[i]), fmtFull(s.tr[i]), s.v[i], s.unit,
                   s.qcodes[s.q[i]] || '', s.raw[i], f.adj[i]];
        if (which === 'all') r.push(AD_STATUS_LABEL[f.status[i]]);
        if (multi) r.unshift(s.label, s.sensorId || '');
        lines.push(r.map(csvEscape).join(','));
        rows++;
      }
    }
    const base = multi ? 'arro_export' : slug(vis[0].label) || 'arro_export';
    dlText(`${base}_${which === 'kept' ? '357filtered' : 'verdict'}.csv`, lines.join('\n'));
    note(`Exported ${rows.toLocaleString()} rows.`);
  }

  // Somebody will paste one of these into an incident report, so the file has to
  // be unambiguous about which system said what long after the tab is closed.
  // The source and the resolution are columns on every row rather than a comment
  // line at the top: a comment is the first thing a spreadsheet import loses,
  // and a row that has been copied out of the sheet still carries its
  // provenance. The filename says it too.
  function exportFieldCsv(which, vis) {
    const head = ['Source', 'Datastore', 'Resolution', 'Address', 'Station', 'Station Number',
                  'Sensor', 'Reading', 'Received', 'Value (raw)', 'Unit',
                  'Converted', 'Converted Unit', 'Quality', 'Adjusted Value',
                  'Copies', 'Paths', 'Bucket Min', 'Bucket Max', 'Readings In Bucket'];
    if (which === 'all') head.push('Filter Status');

    const lines = [head.join(',')];
    let rows = 0;
    for (const s of vis) {
      const f = runFilter(s, ad.cfg);
      const e = s.extra || {};
      const p = s.prov || {};
      const roll = p.res && p.res !== 'raw';
      for (let i = 0; i < s.n; i++) {
        if (which === 'kept' && f.status[i] !== AD_GOOD) continue;
        const via = e.paths ? e.paths[i] : null;
        const r = [
          'MegaNet field data', p.host || dbHostLabel(), AD_RES_LABEL[p.res] || p.res || '',
          p.addr || '', s.station?.name || '', s.station?.station_number || '',
          s.sensor?.type || '',
          fmtFull(s.t[i]), fmtFull(s.tr[i]), s.v[i], s.unit,
          s.eng && isFinite(s.eng[i]) ? s.eng[i] : '', s.engUnit || '',
          s.qcodes[s.q[i]] || '', f.adj[i],
          e.dup ? (e.dup[i] || 0) + 1 : '',
          via && via.length ? via.join(' | ') : '',
          roll && e.lo && isFinite(e.lo[i]) ? e.lo[i] : '',
          roll && e.hi && isFinite(e.hi[i]) ? e.hi[i] : '',
          roll && e.cnt ? e.cnt[i] : '',
        ];
        if (which === 'all') r.push(AD_STATUS_LABEL[f.status[i]]);
        lines.push(r.map(csvEscape).join(','));
        rows++;
      }
    }
    const res = [...new Set(vis.map(s => s.prov?.res).filter(Boolean))].join('-') || 'field';
    const base = vis.length > 1 ? 'meganet_field' : `meganet_field_${slug(vis[0].label) || 'series'}`;
    dlText(`${base}_${res}_${which === 'kept' ? '357filtered' : 'verdict'}.csv`, lines.join('\n'));
    note(`Exported ${rows.toLocaleString()} rows of field data.`);
  }

  // The provenance line, burnt into the picture. The banner above the chart is
  // HTML and does not survive an export, and a chart pasted into an incident
  // report with nothing on it to say which system produced the numbers is
  // exactly the ambiguity this tab was built to prevent. Returns the extra
  // height it needs, so the caller can make room.
  const AD_STAMP_H = 20;
  function stampProvenance(clone, w, h) {
    if (ad.source !== 'field') return 0;
    const vis = shown().filter(s => s.prov);
    if (!vis.length) return 0;
    const p = vis[0].prov;
    const res = [...new Set(vis.map(s => s.prov.res))].map(r => AD_RES_LABEL[r]).join(' + ');
    const line = `MegaNet field data · ${p.host} · ${res} · `
               + `${fmtFull(Math.min(...vis.map(s => s.prov.t0)))} to ${fmtFull(Math.max(...vis.map(s => s.prov.t1)))}`;
    const c = theme();
    clone.setAttribute('viewBox', `0 0 ${w} ${h + AD_STAMP_H}`);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h + AD_STAMP_H);
    const ns = 'http://www.w3.org/2000/svg';
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', 0); bg.setAttribute('y', h);
    bg.setAttribute('width', w); bg.setAttribute('height', AD_STAMP_H);
    bg.setAttribute('fill', c.panel);
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', 6); txt.setAttribute('y', h + 14);
    txt.setAttribute('font-size', '10');
    txt.setAttribute('fill', c.muted);
    txt.textContent = line;
    clone.appendChild(bg);
    clone.appendChild(txt);
    return AD_STAMP_H;
  }

  function exportImg(fmt) {
    const svg = document.getElementById('ad-svg');
    if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const grew = stampProvenance(clone, ad.w, ad.h);
    const base = ad.source === 'field' ? 'meganet-field-chart' : 'arro-chart';
    const text = new XMLSerializer().serializeToString(clone);
    if (fmt === 'svg') {
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })),
        download: `${base}.svg`,
      });
      a.click();
      URL.revokeObjectURL(a.href);
      note(`Downloaded ${base}.svg.`);
      return;
    }
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = ad.w * scale; canvas.height = (ad.h + grew) * scale;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(b => {
        if (!b) { note('The browser would not render the chart to PNG — the SVG download works.', true); return; }
        const a = Object.assign(document.createElement('a'), {
          href: URL.createObjectURL(b), download: `${base}.png`,
        });
        a.click();
        URL.revokeObjectURL(a.href);
        note(`Downloaded ${base}.png.`);
      });
    };
    img.onerror = () => note('The browser would not render the chart to PNG — the SVG download works.', true);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  }

  // Called on a theme change, where every colour in both panes is now wrong —
  // so the comparison redraws whether or not its inputs moved. Since #141 the
  // series colours are among the things that just went wrong, so they are
  // re-resolved first; the sidebar only rebuilds if one actually moved, because
  // its colour swatches would otherwise show the previous theme's palette.
  function repaint() {
    if (reslotColors()) renderSide();
    draw(); drawOv(); drawCompare(true);
  }

  return {
    // The instance on screen. A getter rather than a property because `ad` is a
    // binding that moves with the active tab, and a captured reference would go
    // stale the first time the operator opened the other one.
    get ad() { return ad; },
    // Both instances' series at once, for the memory meter — which is asking
    // about the page's footprint, not about either tab.
    allSeries: () => Object.values(instances).flatMap(i => i.series),
    render, init, stop, repaint, importFiles, pick, loadDemo,
    toggle, setColor, colourToggle, setDash, setAxis, setKind, solo, zoomTo, remove, clearAll, showStation,
    setCfg, resetCfg, setMode, setTransform, setChart, setY, setYRange, setFlag, setDrag,
    resetView, toggleFull,
    // Editing readings (#191), and the selection it works over
    pickToggle, pickClear, pickAllInView, editValue, editQuality, editDelete,
    revertSeries, setEditVal, setEditQ, editCell, openTableModal, closeTableModal,
    preset, unpin, exportCsv, exportImg, explain, compareToggle, tableToggle, dropAll,
    // the Field Data tab (#114)
    fieldSetStation, fieldToggleSensor, fieldAllSensors, fieldSetWindow,
    fieldSetRes, fieldSetDate, fieldRun, fieldClearError,
    // what the datastore holds, as opposed to what the registry says it should
    fieldProbe, fieldSetProbeTerm, fieldProbeClear, fieldSelectableAddrs,
    // the Message Log's door in — one address, one moment, charted
    fieldShow,
    // and the station card's — one station, everything it reports, drawn
    fieldOpenStation,
    // exposed for reasoning about the filter outside the UI
    parseCsv, parseName, linkStation, guessKind, runFilter, walk357,
    // and about which addresses a station is reachable on, which is two shapes
    // rather than one — see fieldChannelId
    fieldAddrs, fieldNoAddr, fieldChannelId,
    // the series boundary both sources cross
    seriesData, adoptSeries,
  };
})();
if (typeof window !== 'undefined') window.ArroData = ArroData;

