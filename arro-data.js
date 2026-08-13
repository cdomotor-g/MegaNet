// MegaNet — arro-data.js
//
//   ArroData   the ARRO Data tab: reads ARRO's per-sensor CSV exports in the
//              browser — nothing is uploaded — links each file back to the
//              station that produced it, runs the Bureau's 3-5-7 continuity
//              filter over it, and draws raw against filtered.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, csvEscape, dlText, slug,
// arroSiteId, arroSensorUrl, bucketSizeMm and dbHostLabel; across to app.js for
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

const AD_COLORS = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                   '#b8860b', '#00838f', '#ad1457', '#5d4037',
                   '#3949ab', '#ef6c00', '#2e7d32', '#6a1b9a'];

// Point status. Ordered so that "kept" is < BAD and the drawing code can test
// with a single comparison. RANGE and RATE are removals by the two limit
// filters, which run before the 357 walk and are not part of the spec — they
// are kept distinct from BAD so a rejected reading can always say which filter
// rejected it.
const AD_UNKNOWN = 0, AD_GOOD = 1, AD_SUSPECT = 2, AD_BAD = 3, AD_OOS = 4,
      AD_RANGE = 5, AD_RATE = 6;

const AD_STATUS_LABEL = {
  [AD_UNKNOWN]: 'untested',
  [AD_GOOD]:    'good',
  [AD_SUSPECT]: 'suspect',
  [AD_BAD]:     'bad',
  [AD_OOS]:     'out of sequence',
  [AD_RANGE]:   'out of range',
  [AD_RATE]:    'rose too fast',
};

// Every status that means "this reading is not in the filtered series".
const adCut = st => st === AD_BAD || st === AD_OOS || st === AD_RANGE || st === AD_RATE;

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
  rangeOn:    false,  // minimum / maximum limits
  rangeMin:   '',     // blank = no floor
  rangeMax:   '',     // blank = no ceiling
};

const AD_DAY = 86400000;

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
      mode:      'both',         // raw | filtered | both
      transform: 'value',        // value | increment | rate
      chartType: 'line',
      yMode:     'auto',         // auto | zero | manual
      yMin:      '', yMax: '',
      showRemoved:  true,
      showRollover: true,
      compare:      false,       // side-by-side raw/filtered panes, folded away
      showPoints:   'auto',      // auto | on | off
      normalise:    false,
      hover:     null,           // {x,y,t,rows:[]}
      pin:       null,           // clicked point: {key,i}
      drag:      null,
      brush:     false,          // brush-to-zoom armed (else drag pans)
      ovDrag:    null,
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
  function guessKind(meta, sensor) {
    const s = `${sensor?.type || ''} ${meta.sensorLabel || ''}`.toLowerCase();
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
    //     A rain accumulator is only tested upwards. It cannot fall except by
    //     wrapping or by corruption, and both of those already have an owner. A
    //     water level is tested in both directions, so a single dropout costs
    //     two readings: the fall into it and the climb back out.
    if (cfg.rateOn && +cfg.rateMax > 0) {
      const max = +cfg.rateMax;
      const kept = [];
      for (let k = 0; k < live.length; k++) {
        const i = live[k];
        if (k > 0) {
          const p = live[k - 1];
          const hrs = (t[i] - t[p]) / 3600000;
          const d = v[i] - v[p];
          const move = isRA ? d : Math.abs(d);
          if (hrs > 0 && move / hrs > max) { cutFlag[i] = AD_RATE; continue; }
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

    let good = 0, bad = 0, oos = 0, range = 0, rate = 0;
    for (let i = 0; i < n; i++) {
      const st = status[i];
      if (st === AD_GOOD)       good++;
      else if (st === AD_OOS)   oos++;
      else if (st === AD_RANGE) range++;
      else if (st === AD_RATE)  rate++;
      else bad++;
    }

    s.filt = { key, status, adj, rolls,
               stats: { good, bad, oos, range, rate, rollovers: rolls.length, total: n } };
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

  function yRange(v) {
    let lo = Infinity, hi = -Infinity;
    for (const s of shown()) {
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
    if (ad.yMode === 'manual') {
      const a = parseFloat(ad.yMin), b = parseFloat(ad.yMax);
      if (!isNaN(a) && !isNaN(b) && b > a) return { lo: a, hi: b };
    }
    if (ad.yMode === 'zero' && lo > 0) lo = 0;
    if (hi === lo) { hi = lo + 1; lo -= 1; }
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
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
      color:    AD_COLORS[ad.series.length % AD_COLORS.length],
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
    };
  }

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
  function fieldAddrs(st) {
    const out = [], seen = new Set();
    for (const sen of (st?.sensors || [])) {
      if (!sen.alert_id) continue;
      const addr = `a:${sen.alert_id}`;
      if (seen.has(addr)) continue;
      seen.add(addr);
      out.push({ addr, sensor: sen, label: sen.type || addr });
    }
    return out;
  }

  function fieldNoAddr(st) {
    return (st?.sensors || []).filter(sen => !sen.alert_id).map(sen => sen.type || 'sensor');
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

  const AD_FIELD_SELECT = {
    raw:    'addr,reading_ts,received_at,value_raw,value,unit,quality,path,dup_count,dup_paths',
    hourly: 'addr,bucket,n,n_dup,unit,raw_min,raw_max,raw_last,val_last,first_ts,last_ts',
    daily:  'addr,bucket,n,n_dup,unit,raw_min,raw_max,raw_last,val_last,first_ts,last_ts',
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
        const label = [st?.name || (addr.startsWith('a:') ? `ALERT ${addr.slice(2)}` : addr),
                       sensor?.type || (hit?.label || '')].filter(Boolean).join(' · ');
        const warn = [];
        if (out.capped) warn.push(`The row cap (${AD_FIELD_ROW_CAP.toLocaleString()}) was reached — this is the start of the window, not all of it. Narrow the window or pick a coarser resolution.`);
        if (res !== 'raw') warn.push(`Drawn from ${AD_RES_LABEL[res]}: each point is the counter as it read at the end of its bucket. Within-bucket minimum and maximum are in the inspector and the export.`);
        if (built.anyDup) warn.push('Some readings arrived by more than one path — click a point to see which.');
        data.warn = warn;

        const s = adoptSeries(data, {
          fileName: `${addr} · ${AD_RES_LABEL[res]}`,
          meta:     { sensorId: sensor?.sensor_id || null },
          label,
          station:  st || null,
          sensor,
          linkHow:  'address',
          sensorId: sensor?.sensor_id || null,
          kind:     guessKind({ sensorLabel: hit?.label || '' }, sensor),
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

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h3>Field readings</h3>
          <span class="small" title="Every reading on this tab comes from the MegaNet datastore. ARRO exports live on the ARRO Data tab and the two are never mixed."
                style="color:var(--muted)">${esc(dbHostLabel())}</span></div>

        <label class="ad-cfg-row" style="display:block">
          <span>Station</span>
          <input type="search" placeholder="Name, station number or id…" value="${escAttr(q.find)}"
                 oninput="ArroData.fieldSetStation('', this.value)"
                 style="width:100%;margin-top:.2rem">
        </label>
        ${st ? `
          <div class="ad-field-picked">
            <b>${esc(st.name)}</b>
            <span class="small mono">${esc(st.station_number || st.id)}</span>
            <button class="ad-x" title="Pick a different station"
                    onclick="ArroData.fieldSetStation('', '')">✕</button>
          </div>` : hits.length ? `
          <div class="ad-field-hits">
            ${hits.slice(0, AD_FIND_CAP).map(s => `
              <button class="ad-field-hit" onclick="ArroData.fieldSetStation('${escAttr(s.id)}', '')">
                ${esc(s.name)} <span class="small mono">${esc(s.station_number || '')}</span>
              </button>`).join('')}
            ${hits.length > AD_FIND_CAP ? '<div class="small" style="color:var(--muted)">More than ' + AD_FIND_CAP + ' matches — keep typing.</div>' : ''}
          </div>` : q.find.trim() ? `
          <div class="small" style="color:var(--muted);margin:.3rem 0">No station matches that.</div>` : ''}

        ${st ? `
          <div class="ad-field-sensors">
            <div class="panel-header" style="padding:0;border:0;margin:.5rem 0 .2rem">
              <h3 style="font-size:.8rem">Sensors</h3>
              <button class="btn-link" onclick="ArroData.fieldAllSensors()">${
                addrs.length && addrs.every(a => q.sensors.includes(a.addr)) ? 'none' : 'all'}</button>
            </div>
            ${addrs.map(a => `
              <label class="ad-chk" style="display:flex;gap:.35rem;align-items:baseline">
                <input type="checkbox" ${q.sensors.includes(a.addr) ? 'checked' : ''}
                       onchange="ArroData.fieldToggleSensor('${escAttr(a.addr)}')">
                <span>${esc(a.label)} <span class="small mono" style="color:var(--muted)">${esc(a.addr)}</span></span>
              </label>`).join('') || '<div class="small" style="color:var(--muted)">No ALERT addresses recorded for this station.</div>'}
            ${noAddr.length ? `
              <div class="small" style="color:var(--muted);margin-top:.3rem"
                   title="A satellite or cellular station reports under its station number and a channel name, which stations.json does not record. Type the address in below if you know it.">
                ${noAddr.length} sensor${noAddr.length === 1 ? '' : 's'} here carr${noAddr.length === 1 ? 'ies' : 'y'} no ALERT address
                (${esc(noAddr.slice(0, 3).join(', '))}${noAddr.length > 3 ? '…' : ''}).</div>` : ''}
            <label class="ad-cfg-row" style="display:block;margin-top:.35rem"
                   title="An address exactly as meganet.reading stores it — a:6128, or s:541155/rain for a station that reports under its number.">
              <span>Or an address</span>
              <input type="text" placeholder="a:6128 or s:541155/rain" value="${escAttr(q.extra)}"
                     onchange="ArroData.fieldSetDate('extra', this.value)"
                     style="width:100%;margin-top:.2rem">
            </label>
          </div>` : ''}

        <div class="panel-header" style="padding:0;border:0;margin:.6rem 0 .2rem">
          <h3 style="font-size:.8rem">Window</h3></div>
        <div class="ad-seg" role="group" aria-label="Time window" style="flex-wrap:wrap">
          ${AD_FIELD_WINDOWS.map(([k, label]) => `
            <button class="${q.win === k ? 'on' : ''}" title="${escAttr(label)}"
                    onclick="ArroData.fieldSetWindow('${k}')">${esc(k)}</button>`).join('')}
          <button class="${q.win === 'custom' ? 'on' : ''}" title="Type your own dates"
                  onclick="ArroData.fieldSetWindow('custom')">dates</button>
        </div>
        ${q.win === 'custom' ? `
          <div class="ad-field-dates">
            <input type="date" value="${escAttr(q.from)}" onchange="ArroData.fieldSetDate('from', this.value)">
            <span class="small">to</span>
            <input type="date" value="${escAttr(q.to)}" onchange="ArroData.fieldSetDate('to', this.value)">
          </div>` : ''}

        <div class="panel-header" style="padding:0;border:0;margin:.6rem 0 .2rem">
          <h3 style="font-size:.8rem" title="Raw readings below ${AD_RAW_MAX_DAYS} days, hourly below ${AD_HOURLY_MAX_DAYS}, daily beyond — override it here.">Resolution</h3></div>
        <div class="ad-seg" role="group" aria-label="Resolution">
          ${[['auto', 'Auto'], ['raw', 'Raw'], ['hourly', 'Hourly'], ['daily', 'Daily']].map(([k, label]) => `
            <button class="${q.res === k ? 'on' : ''}" onclick="ArroData.fieldSetRes('${k}')"
                    title="${escAttr(k === 'auto' ? 'Chosen from the width of the window' : 'Always draw ' + AD_RES_LABEL[k])}">${esc(label)}</button>`).join('')}
        </div>
        ${res ? `<p class="small ad-cfg-note">This window will be drawn from <b>${esc(AD_RES_LABEL[res])}</b>.</p>` : ''}

        <button style="width:100%;margin-top:.5rem" ${q.loading ? 'disabled' : ''}
                onclick="ArroData.fieldRun()">${q.loading ? 'Reading…' : 'Load readings'}</button>

        ${q.error ? `<div class="small ad-note ad-note--bad" style="margin-top:.4rem">${esc(q.error)}
            <button class="ad-inline-link" onclick="ArroData.fieldClearError()">dismiss</button></div>` : ''}
        ${q.empty ? `<div class="small ad-warn" style="margin-top:.4rem">${esc(q.empty)}</div>` : ''}
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
    const all = fieldAddrs(fieldStation()).map(a => a.addr);
    q.sensors = all.length && all.every(a => q.sensors.includes(a)) ? [] : all;
    renderSide();
  }

  function fieldSetWindow(k) { const q = fq(); q.win = k; q.error = ''; renderSide(); }
  function fieldSetRes(k)    { const q = fq(); q.res = k; renderSide(); }
  function fieldSetDate(which, v) { const q = fq(); q[which] = v; q.error = ''; renderSide(); }
  function fieldClearError() { const q = fq(); q.error = ''; q.empty = ''; renderSide(); }

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
        ${capped ? '<span>·</span><span class="ad-warn-txt small">row cap reached — this is the start of the window, not all of it</span>' : ''}
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
        <span class="small" style="color:var(--muted)">display only — the filter ran on the count</span></div>`);
    }
    if (s.prov.res !== 'raw' && e.cnt) {
      const per = s.prov.res === 'hourly' ? 'hour' : 'day';
      rows.push(`<div><span>In this ${per}</span><b>${(e.cnt[i] || 0).toLocaleString()} reading${e.cnt[i] === 1 ? '' : 's'}</b></div>`);
      if (e.lo && isFinite(e.lo[i])) {
        rows.push(`<div><span>Bucket min–max</span><b>${esc(fmtVal(e.lo[i]))} – ${esc(fmtVal(e.hi[i]))}</b>
          <span class="small" style="color:var(--muted)">the spread the plotted point hides</span></div>`);
      }
    }
    const dup = e.dup ? e.dup[i] : 0;
    const via = e.paths ? e.paths[i] : null;
    rows.push(`<div><span>Copies</span><b>${dup ? `heard ${dup + 1} times` : 'heard once'}</b></div>`);
    if (via && via.length) rows.push(`<div><span>Paths</span><b class="mono">${esc(via.join(', '))}</b></div>`);
    rows.push(`<div><span>Source</span><b>Field · <span class="mono">${esc(s.prov.addr)}</span></b></div>`);
    return rows.join('');
  }

  // "45 min", "1.5 h", "1.5 d" — only ever used for the gap threshold, which is
  // a rough number that wants a rough rendering.
  function fmtDur(ms) {
    if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
    if (ms < AD_DAY)  return `${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)} h`;
    return `${(ms / AD_DAY).toFixed(ms % AD_DAY ? 1 : 0)} d`;
  }

  function note(msg, bad) {
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
    return `
      <div class="ad-wrap">
        <div class="ad-layout">
          <aside class="ad-side" id="ad-side">${sideHtml()}</aside>
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
        <div class="small" style="margin:.3rem 0 .5rem">
          Read in your browser — nothing is uploaded.</div>
        <button onclick="document.getElementById('ad-file').click()">Choose files…</button>
        ${ad.busy ? `<div class="small" style="margin-top:.4rem">Reading ${ad.busy} file${ad.busy === 1 ? '' : 's'}…</div>` : ''}
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
                   onchange="ArroData.toggle('${s.key}')">
            <input type="color" class="ad-swatch" value="${escAttr(s.color)}" title="Series colour"
                   onchange="ArroData.setColor('${s.key}', this.value)">
            <b class="ad-series-name" title="${escAttr(s.fileName)}">${esc(s.label)}</b>
            <button class="ad-x" title="Remove this ${ad.source === 'field' ? 'series' : 'import'}" onclick="ArroData.remove('${s.key}')">✕</button>
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
            <button class="ad-inline-link ad-bad-txt" onclick="ArroData.explain()"
                    title="Readings the 357 test rejected — click for what the test does">${st.bad.toLocaleString()} removed</button> ·
            <span title="Repeat or out-of-sequence timestamps, excluded before filtering">${st.oos.toLocaleString()} repeats</span>
            ${st.range ? ` · <span class="ad-warn-txt" title="Readings outside the minimum / maximum you set">${st.range.toLocaleString()} out of range</span>` : ''}
            ${st.rate ? ` · <span class="ad-warn-txt" title="Readings that climbed faster than the rate limit">${st.rate.toLocaleString()} too fast</span>` : ''}
            ${st.rollovers ? ` · <span title="Accumulator wraps corrected">${st.rollovers} rollover${st.rollovers === 1 ? '' : 's'}</span>` : ''}
          </div>
          <div class="small ad-series-meta">
            <label title="How diff() compares two readings. A rain accumulator only climbs; a water level may move either way.">reads as
              <select onchange="ArroData.setKind('${s.key}', this.value)">
                <option value="RA" ${s.kind === 'RA' ? 'selected' : ''}>RainAccum</option>
                <option value="WL" ${s.kind === 'WL' ? 'selected' : ''}>WaterLevel</option>
              </select></label>
            <button class="btn-link" onclick="ArroData.solo('${s.key}')" title="Show only this series">solo</button>
            <button class="btn-link" onclick="ArroData.zoomTo('${s.key}')" title="Zoom the chart to this series">fit</button>
          </div>
          ${(s.warn || []).map(w => `<div class="small ad-warn">${esc(w)}</div>`).join('')}
        </div>`;
    }).join('');

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h3>${ad.source === 'field' ? 'Loaded' : 'Imports'}</h3>
          <button class="btn-link" onclick="ArroData.clearAll()">clear all</button></div>
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
    // A filter's own switch, and the body it governs.
    const block = (k, label, tip, body, note) => `
      <div class="ad-filt${c[k] ? '' : ' ad-filt--off'}">
        <label class="ad-filt-head" title="${escAttr(tip)}">
          <input type="checkbox" ${c[k] ? 'checked' : ''}
                 onchange="ArroData.setCfg('${k}', this.checked)">
          <span>${esc(label)}</span></label>
        <div class="ad-filt-body">${body}${note ? `<p class="small ad-cfg-note">${note}</p>` : ''}</div>
      </div>`;

    const unit = ad.series[0]?.unit || 'units';

    return `
      <div class="panel ad-panel">
        <div class="panel-header"><h3>Filters</h3>
          <span class="ad-panel-acts">
            <button class="btn-link" onclick="ArroData.explain()"
                    title="What the 3-5-7 continuity test does, and why it removed what it did">How the 357 filter works</button>
            <button class="btn-link" onclick="ArroData.resetCfg()">defaults</button>
          </span></div>

        ${block('use357', '3-5-7 continuity test',
          'The Bureau\'s continuity filter. Off leaves every reading the other filters kept.',
          `<p class="small" style="color:var(--muted);margin:.1rem 0 .4rem">
             A reading passes if it is within <b>${esc(c.small)}</b> of the next, or <b>${esc(c.medium)}</b> of the
             next-next, or <b>${esc(c.large)}</b> of the one after that. Bureau spec, May 2009.</p>
           ${num('small', 'Small step', 'Difference allowed against the next reading (spec: 3)', 0, 10000, c.use357)}
           ${num('medium', 'Medium step', 'Difference allowed against the next-next reading (spec: 5)', 0, 10000, c.use357)}
           ${num('large', 'Large step', 'Difference allowed against the next-next-next reading (spec: 7)', 0, 10000, c.use357)}
           ${num('breakCount', 'Break after', 'Consecutive failures that break continuity and start a new series (spec: 4)', 1, 100, c.use357)}
           ${num('startTests', 'Start window', 'Tests allowed to establish the start of a series (spec flowchart: 4)', 1, 100, c.use357)}`)}

        ${block('rolloverOn', 'Correct rollovers',
          'Detect accumulator wraps and carry the count across them',
          num('cycle', 'Rollover at', 'Accumulator cycle size — the device counts 0 to cycle−1 (spec: 2048)', 2, 1e9, c.rolloverOn),
          c.use357 ? '' : 'With the 357 test off, nothing has removed the corrupt packets a wrap is '
                        + 'easily confused with — expect spikes to be read as rollovers.')}

        ${block('oosOn', 'Drop repeat timestamps',
          'Remove readings that do not advance the clock, before filtering',
          num('minGapSec', 'Min gap (s)', 'Collapse readings closer together than this. 0 keeps the spec behaviour.', 0, 86400, c.oosOn),
          'Repeats are ARRO re-sending one observation. Four re-sends of a corrupt '
          + 'packet satisfy the spec\'s "four consecutive readings make a series" and '
          + 'survive as one — set a minimum gap to collapse them.')}

        ${block('rateOn', 'Rate of rise',
          'Remove readings that climb faster than a gauge plausibly can',
          num('rateMax', `Max rise (${esc(unit)}/h)`,
              'Fastest believable change per hour between one reading and the next', 0, 1e9, c.rateOn),
          `Each reading against the one before it, so this filter only ever claims the
           step — a corrupt plateau costs its first reading here and the rest is the 357
           test's business.
           ${ad.series.some(s => s.kind === 'RA')
              ? 'An accumulator is only tested upwards; falls belong to the rollover and 357 tests.' : ''}`)}

        ${block('rangeOn', 'Minimum / maximum',
          'Remove readings outside what this sensor can physically report',
          `${lim('rangeMin', 'Minimum', 'Readings below this are removed. Blank for no floor.', c.rangeOn)}
           ${lim('rangeMax', 'Maximum', 'Readings above this are removed. Blank for no ceiling.', c.rangeOn)}`,
          `Compared against <b>Value</b> as exported, in ${esc(unit)}, before any rollover
           correction. Leave an end blank to bound only the other one.`)}
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

  function mainHtml() {
    if (!ad.series.length) return emptyHtml();
    return `
      ${provenanceHtml()}
      ${toolbarHtml()}
      <div class="ad-stage" id="ad-stage" tabindex="0"
           aria-label="Sensor readings over time. Drag to pan, scroll to zoom, arrow keys to step.">
        <svg id="ad-svg" role="img"></svg>
        <div class="ad-tip" id="ad-tip" hidden></div>
      </div>
      <svg id="ad-ov" class="ad-ov" role="img"
           aria-label="Whole record, with the visible window shaded"></svg>
      <div id="ad-readout" class="ad-readout">${readoutHtml()}</div>
      ${compareHtml()}`;
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
                 aria-label="Every reading as exported, over the visible window"></svg>
          </figure>
          <figure>
            <figcaption>Filtered <span class="small">${kept.toLocaleString()} kept</span></figcaption>
            <svg id="ad-cmp-filt" role="img"
                 aria-label="The readings that survived the filters, over the same window"></svg>
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
        <p class="small" style="color:var(--muted)">
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
          <p class="small" style="color:var(--muted)">A silent window and a window of zeroes are
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
        <p class="small" style="color:var(--muted)">
          Readings arrive as counts, so the 3/5/7 thresholds are counts too and the filter runs on
          them exactly as it does on an ARRO export. Any conversion the datastore recorded is shown
          beside the count, never instead of it.</p>
      </div>`;
  }

  const seg = (group, cur, opts, fn) => `
    <div class="ad-seg" role="group" aria-label="${escAttr(group)}">
      ${opts.map(([v, label, tip]) => `
        <button class="${cur === v ? 'on' : ''}" title="${escAttr(tip || label)}"
                onclick="ArroData.${fn}('${v}')">${esc(label)}</button>`).join('')}
    </div>`;

  function toolbarHtml() {
    const anyFilt = ad.mode !== 'raw';
    return `
      <div class="ad-toolbar">
        ${seg('Which series', ad.mode, [
          ['raw', 'Raw', 'Everything as exported'],
          ['filtered', 'Filtered', 'Only what passed the 357 test'],
          ['both', 'Both', 'Filtered over raw, so removals show'],
        ], 'setMode')}
        ${seg('Reading', ad.transform, [
          ['value', 'Value', 'The reading itself'],
          ['increment', 'Increment', 'Step between consecutive readings'],
          ['rate', 'Rate/h', 'Step divided by the hours between readings'],
        ], 'setTransform')}
        ${seg('Chart style', ad.chartType, [
          ['line', 'Line', 'Straight between readings'],
          ['step', 'Step', 'Hold each reading until the next — how an accumulator behaves'],
          ['dots', 'Points', 'One mark per reading, nothing joined'],
        ], 'setChart')}
        ${seg('Vertical axis', ad.yMode, [
          ['auto', 'Auto', 'Fit everything on screen, spikes included'],
          ['kept', 'Kept', 'Fit the readings that passed the filter — removals run off the top'],
          ['zero', 'Zero', 'Always include zero'],
          ['manual', 'Fixed', 'Type your own range'],
        ], 'setY')}
        ${ad.yMode === 'manual' ? `
          <span class="ad-tool-grp">
            <input type="number" class="ad-num" value="${escAttr(ad.yMin)}" placeholder="min"
                   onchange="ArroData.setYRange('min', this.value)">
            <input type="number" class="ad-num" value="${escAttr(ad.yMax)}" placeholder="max"
                   onchange="ArroData.setYRange('max', this.value)">
          </span>` : ''}
        <span class="ad-tool-grp">
          <label class="ad-chk" title="Mark every reading the filter rejected"
                 style="${anyFilt ? '' : 'opacity:.45'}">
            <input type="checkbox" ${ad.showRemoved ? 'checked' : ''} ${anyFilt ? '' : 'disabled'}
                   onchange="ArroData.setFlag('showRemoved', this.checked)"> removed</label>
          <label class="ad-chk" title="Mark repeat timestamps dropped before filtering">
            <input type="checkbox" ${ad.showDupes ? 'checked' : ''}
                   onchange="ArroData.setFlag('showDupes', this.checked)"> repeats</label>
          <label class="ad-chk" title="Mark where an accumulator wrap was corrected">
            <input type="checkbox" ${ad.showRollover ? 'checked' : ''}
                   onchange="ArroData.setFlag('showRollover', this.checked)"> rollovers</label>
          <label class="ad-chk" title="Drag to select a time range instead of panning">
            <input type="checkbox" ${ad.brush ? 'checked' : ''}
                   onchange="ArroData.setFlag('brush', this.checked)"> drag zooms</label>
        </span>
        <span class="ad-tool-grp">
          ${[['all', 'All'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d'], ['90d', '90d']]
            .map(([k, l]) => `<button onclick="ArroData.preset('${k}')" title="Show the last ${l === 'All' ? 'of everything' : l}">${l}</button>`).join('')}
        </span>
        <span class="ad-tool-grp">
          <button onclick="ArroData.exportCsv('kept')" title="The filtered series, as CSV">Export kept</button>
          <button onclick="ArroData.exportCsv('all')" title="Every reading with the filter's verdict against it">Export + verdict</button>
          <button onclick="ArroData.exportImg('svg')" title="Download the chart as SVG">SVG</button>
          <button onclick="ArroData.exportImg('png')" title="Download the chart as PNG">PNG</button>
        </span>
      </div>`;
  }

  // ── readout / inspector ────────────────────────────────────────────────────

  function statusOf(s, i) {
    const f = runFilter(s, ad.cfg);
    return f.status[i];
  }

  function readoutHtml() {
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
              <span class="ad-dot" style="background:${escAttr(r.color)}"></span>
              ${esc(r.label)} <b>${esc(fmtVal(r.y))}</b>${r.unit ? ' ' + esc(r.unit) : ''}
              <span class="small" style="color:var(--muted)">${esc(r.kindLabel)}${r.q ? ' · ' + esc(r.q) : ''}</span>
            </span>`).join('')}
          <span class="small" style="color:var(--muted)">click to pin a reading</span>
        </div>`;
    }
    return statsHtml();
  }

  // What a raw tip count converts to in mm, for display next to it — never
  // fed back into runFilter/walk357, which stay in the count/Value domain
  // ARRO exported (see the comment on runFilter()). Only offered for a
  // rainfall accumulator with a real "Raw Value" column and a linked
  // station; a water level's raw count isn't a tip count at all.
  function rawBucketNote(s, i) {
    if (s.kind !== 'RA' || !s.hasRaw || !s.station) return '';
    const b = bucketSizeMm(s.station);
    const mm = s.raw[i] * b.mm;
    const note = b.recorded ? `recorded, ${b.mm} mm/tip` : `assumed ${b.mm} mm/tip — not recorded for this site`;
    return ` <span class="small" style="color:var(--muted)">= ${esc(fmtVal(mm))} mm (${esc(note)})</span>`;
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
      : st === AD_RATE ? `Moved faster than ${ad.cfg.rateMax} ${s.unit}/h from the reading before it, so it was removed before the 357 test ran.`
      : `Failed the 357 test against the readings that follow it — not within ${ad.cfg.small} of the next, ${ad.cfg.medium} of the next-next, or ${ad.cfg.large} of the one after that.`;
    const badge = st === AD_GOOD ? 'ok' : st === AD_OOS ? 'dup'
                : (st === AD_RANGE || st === AD_RATE) ? 'warn' : 'bad';
    const rolled = f.rolls.includes(i);
    return `
      <div class="ad-pin">
        <div class="ad-pin-head">
          <span class="ad-dot" style="background:${escAttr(s.color)}"></span>
          <b>${esc(s.label)}</b>
          <span class="ad-badge ad-badge--${badge}">${esc(AD_STATUS_LABEL[st])}</span>
          <button class="ad-x" onclick="ArroData.unpin()" title="Close">✕</button>
        </div>
        <div class="ad-pin-grid">
          <div><span>Reading</span><b>${esc(fmtFull(s.t[i]))}</b></div>
          <div><span>${esc(s.prov && s.prov.res !== 'raw' ? 'Last in bucket' : 'Received')}</span><b>${esc(fmtFull(s.tr[i]))}${
              // The delay between reading and receipt is worth flagging on a
              // real reading. On a rollup the two are an hour apart by
              // construction, which is not news.
              s.tr[i] !== s.t[i] && (!s.prov || s.prov.res === 'raw')
              ? ` <span class="small" style="color:var(--warn)">+${Math.round((s.tr[i] - s.t[i]) / 1000)}s</span>` : ''}</b></div>
          <div><span>Value</span><b>${esc(fmtVal(s.v[i]))} ${esc(s.unit)}</b></div>
          <div><span>Raw</span><b>${esc(fmtVal(s.raw[i]))}</b>${rawBucketNote(s, i)}</div>
          <div><span>Adjusted</span><b>${esc(fmtVal(f.adj[i]))}${rolled ? ' <span class="small">(wrap here)</span>' : ''}</b></div>
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
    if (!vis.length) return '<span class="small" style="color:var(--muted)">No series shown — tick one on the left.</span>';
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
          <span class="ad-dot" style="background:${escAttr(s.color)}"></span>
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
  const MARK_CAP = 2500;      // removed-point markers drawn before we stop

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
    const pw = w - PADL - PADR, ph = h - PADT - PADB;
    const yr = yRange(v);
    const x = t => PADL + (t - v.t0) / (v.t1 - v.t0) * pw;
    const y = val => PADT + (1 - (val - yr.lo) / (yr.hi - yr.lo)) * ph;
    const tOf = px => v.t0 + (px - PADL) / pw * (v.t1 - v.t0);
    return { v, w, h, pw, ph, yr, x, y, tOf };
  }

  function draw() {
    const svg = document.getElementById('ad-svg');
    if (!svg) return;
    const g = geom();
    if (!g) { svg.innerHTML = ''; return; }
    const c = theme();
    svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
    svg.setAttribute('width', g.w);
    svg.setAttribute('height', g.h);

    const { ticks, step } = timeTicks(g.v.t0, g.v.t1, Math.max(3, Math.round(g.pw / 110)));
    const yt = niceTicks(g.yr.lo, g.yr.hi, Math.max(2, Math.round(g.ph / 46)));

    // Everything data-driven is clipped to the plot rectangle. Without it a
    // fixed or kept-only vertical range lets curves run across the axis labels.
    let out = `<defs><clipPath id="ad-clip"><rect x="${PADL}" y="${PADT}"
                 width="${g.pw}" height="${g.ph}"/></clipPath></defs>
               <rect x="0" y="0" width="${g.w}" height="${g.h}" fill="${c.panel}"/>`;

    out += yt.map(val => `
      <line x1="${PADL}" y1="${g.y(val).toFixed(1)}" x2="${g.w - PADR}" y2="${g.y(val).toFixed(1)}"
            stroke="${c.border}" stroke-width="1"/>
      <text x="${PADL - 6}" y="${(g.y(val) + 3.5).toFixed(1)}" font-size="10" text-anchor="end"
            fill="${c.muted}">${esc(fmtVal(val))}</text>`).join('');

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
      for (const { track, kind } of layers(s)) {
        const i0 = Math.max(0, lower(track.t, track.n, g.v.t0) - 1);
        const i1 = Math.min(track.n, lower(track.t, track.n, g.v.t1) + 1);
        const pts = densify(track, i0, i1, g.x, g.pw);
        if (!pts.length) continue;
        // In "both", raw sits underneath as a ghost so that what the filter took
        // out reads as a gap in the solid line rather than a second chart.
        const ghost = ad.mode === 'both' && kind === 'raw';
        if (dots) {
          markers += pts.slice(0, 4000).map(p =>
            `<circle cx="${p[0].toFixed(1)}" cy="${g.y(p[1]).toFixed(1)}" r="${ghost ? 1.1 : 1.8}"
                     fill="${escAttr(s.color)}" opacity="${ghost ? .3 : .9}"/>`).join('');
        } else {
          series += `<path d="${pathFrom(pts, g.y, stepped, track, s)}" fill="none" stroke="${escAttr(s.color)}"
                        stroke-width="${ghost ? 1 : 1.7}" opacity="${ghost ? .34 : 1}"
                        stroke-linejoin="round" stroke-linecap="round"/>`;
        }
        // Few enough points on screen that each one is a real reading: show them.
        if (!dots && ad.showPoints !== 'off' && (i1 - i0) <= Math.max(40, g.pw / 12) && !ghost) {
          for (let k = i0; k < i1; k++) {
            markers += `<circle cx="${g.x(track.t[k]).toFixed(1)}" cy="${g.y(track.y[k]).toFixed(1)}"
                                r="2.2" fill="${escAttr(s.color)}"/>`;
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
          const isCut = st === AD_BAD || st === AD_RANGE || st === AD_RATE;
          if (!(isCut && wantBad) && !(isDup && ad.showDupes)) continue;
          if (ad.transform !== 'value') continue;   // a removed step has no meaningful height
          const px = g.x(s.t[i]), py = g.y(s.v[i]);
          // Which filter took it out, told apart by shape as well as colour —
          // at four pixels a colour alone is a guess.
          const col = st === AD_BAD ? c.bad : isDup ? c.muted : c.warn;
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
        out += `<circle cx="${g.x(r.t).toFixed(1)}" cy="${g.y(r.y).toFixed(1)}" r="3.6"
                        fill="none" stroke="${escAttr(r.color)}" stroke-width="2"/>`;
      }
    }
    if (ad.pin) {
      const s = ad.series.find(x => x.key === ad.pin.key);
      if (s && ad.transform === 'value') {
        const px = g.x(s.t[ad.pin.i]), py = g.y(s.v[ad.pin.i]);
        out += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="none"
                        stroke="${c.accent}" stroke-width="2"/>`;
      }
    }
    if (ad.drag && ad.drag.brush) {
      const a = Math.min(ad.drag.x0, ad.drag.x1), b = Math.max(ad.drag.x0, ad.drag.x1);
      out += `<rect x="${a.toFixed(1)}" y="${PADT}" width="${(b - a).toFixed(1)}" height="${g.ph}"
                    fill="${c.accent}" opacity=".14"/>`;
    }

    out += `<line x1="${PADL}" y1="${g.h - PADB}" x2="${g.w - PADR}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            <line x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${g.h - PADB}"
                  stroke="${c.muted}" stroke-width="1"/>`;

    const unit = shown()[0]?.unit || '';
    const yLabel = ad.transform === 'value' ? unit
                 : ad.transform === 'increment' ? `${unit}/reading` : `${unit}/h`;
    if (yLabel) {
      out += `<text x="6" y="${PADT + 8}" font-size="10" fill="${c.muted}">${esc(yLabel)}</text>`;
    }
    if (nMark >= MARK_CAP) {
      out += `<text x="${g.w - PADR}" y="${PADT + 10}" font-size="10" text-anchor="end" fill="${c.muted}">
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
    const w = ad.w, h = 56;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    const pw = w - PADL - PADR;
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
        out += `<path d="${pathFrom(pts, y, false, track, s)}" fill="none" stroke="${escAttr(s.color)}"
                      stroke-width="1" opacity=".85"/>`;
      }
    }
    const v = view();
    const a = x(v.t0), b = x(v.t1);
    out += `<rect x="${PADL}" y="4" width="${Math.max(0, a - PADL).toFixed(1)}" height="${h - 16}"
                  fill="${c.muted}" opacity=".22"/>
            <rect x="${b.toFixed(1)}" y="4" width="${Math.max(0, w - PADR - b).toFixed(1)}" height="${h - 16}"
                  fill="${c.muted}" opacity=".22"/>
            <rect x="${a.toFixed(1)}" y="4" width="${Math.max(1, b - a).toFixed(1)}" height="${h - 16}"
                  fill="none" stroke="${c.accent}" stroke-width="1.4"/>
            <text x="${PADL - 6}" y="${h - 5}" font-size="9" text-anchor="end" fill="${c.muted}">whole record</text>
            <text x="${PADL}" y="${h - 5}" font-size="9" fill="${c.muted}">${esc(fmtFull(ex.t0).slice(0, 10))}</text>
            <text x="${w - PADR}" y="${h - 5}" font-size="9" text-anchor="end" fill="${c.muted}">${esc(fmtFull(ex.t1).slice(0, 10))}</text>`;
    svg.innerHTML = out;

    // Every view change redraws the overview, and nothing else does — which
    // makes this the one place the comparison panes can follow the window
    // without also being rebuilt on every mouse move.
    drawCompare();
  }

  // ── side-by-side comparison ────────────────────────────────────────────────

  const CMP_PADL = 46, CMP_PADR = 10, CMP_PADT = 10, CMP_PADB = 20;

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
                 cfgKey(ad.cfg, 'cmp'), vis.map(s => `${s.key}${s.color}${s.kind}`).join(',')].join('|');
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
    let lo = Infinity, hi = -Infinity;
    for (const s of vis) {
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
    let yr = { lo: lo - pad, hi: hi + pad };
    if (ad.yMode === 'manual') {
      const a = parseFloat(ad.yMin), b = parseFloat(ad.yMax);
      if (!isNaN(a) && !isNaN(b) && b > a) yr = { lo: a, hi: b };
    }

    const c = theme();
    for (const [svg, kind] of [[a, 'raw'], [b, 'filt']]) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      svg.innerHTML = cmpPane(kind, w, h, v, yr, c);
    }
  }

  function cmpPane(kind, w, h, v, yr, c) {
    const pw = w - CMP_PADL - CMP_PADR, ph = h - CMP_PADT - CMP_PADB;
    const x = t => CMP_PADL + (t - v.t0) / (v.t1 - v.t0) * pw;
    const y = val => CMP_PADT + (1 - (val - yr.lo) / (yr.hi - yr.lo)) * ph;
    const { ticks, step } = timeTicks(v.t0, v.t1, Math.max(2, Math.round(pw / 120)));
    const yt = niceTicks(yr.lo, yr.hi, Math.max(2, Math.round(ph / 44)));
    const clip = `ad-cmp-clip-${kind}`;

    let out = `<defs><clipPath id="${clip}"><rect x="${CMP_PADL}" y="${CMP_PADT}"
                 width="${pw}" height="${ph}"/></clipPath></defs>
               <rect x="0" y="0" width="${w}" height="${h}" fill="${c.panel}"/>`;

    out += yt.map(val => `
      <line x1="${CMP_PADL}" y1="${y(val).toFixed(1)}" x2="${w - CMP_PADR}" y2="${y(val).toFixed(1)}"
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
      const track = kind === 'raw' ? tracks(s).raw : tracks(s).filt;
      const i0 = Math.max(0, lower(track.t, track.n, v.t0) - 1);
      const i1 = Math.min(track.n, lower(track.t, track.n, v.t1) + 1);
      const pts = densify(track, i0, i1, x, pw);
      if (pts.length) {
        body += `<path d="${pathFrom(pts, y, ad.chartType === 'step', track, s)}" fill="none"
                       stroke="${escAttr(s.color)}" stroke-width="1.4"
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
          const px = x(s.t[i]), py = y(s.v[i]);
          if (py < CMP_PADT - 4 || py > h - CMP_PADB + 4) continue;
          n++;
          const col = st === AD_BAD ? c.bad : st === AD_OOS ? c.muted : c.warn;
          body += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.4" fill="none"
                           stroke="${col}" stroke-width="1.3" opacity=".9"><title>${esc(AD_STATUS_LABEL[st])}
                           · ${esc(fmtVal(s.v[i]))} ${esc(s.unit)}</title></circle>`;
        }
      }
    }
    out += `<g clip-path="url(#${clip})">${body}</g>`;
    out += `<line x1="${CMP_PADL}" y1="${h - CMP_PADB}" x2="${w - CMP_PADR}" y2="${h - CMP_PADB}"
                  stroke="${c.muted}" stroke-width="1"/>
            <line x1="${CMP_PADL}" y1="${CMP_PADT}" x2="${CMP_PADL}" y2="${h - CMP_PADB}"
                  stroke="${c.muted}" stroke-width="1"/>`;
    return out;
  }

  // ── interaction ────────────────────────────────────────────────────────────

  function localX(ev, el) {
    const r = el.getBoundingClientRect();
    return (ev.clientX - r.left) * (ad.w / r.width);
  }

  function hoverAt(px, py) {
    const g = geom();
    if (!g) return null;
    const t = g.tOf(px);
    const rows = [];
    for (const s of shown()) {
      for (const { track, kind } of layers(s)) {
        if (ad.mode === 'both' && kind === 'raw') continue;   // one row per series
        if (!track.n) continue;
        let k = lower(track.t, track.n, t);
        if (k >= track.n) k = track.n - 1;
        if (k > 0 && Math.abs(track.t[k - 1] - t) < Math.abs(track.t[k] - t)) k--;
        const i = track.ref[k];
        rows.push({
          key: s.key, label: s.label, color: s.color, unit: s.unit,
          t: track.t[k], y: track.y[k], i, k,
          q: s.qcodes[s.q[i]] || '',
          kindLabel: ad.mode === 'raw' ? 'raw' : 'kept',
          dist: Math.abs(g.x(track.t[k]) - px) + Math.abs(g.y(track.y[k]) - py) * 0.35,
        });
      }
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
        <div class="ad-tip-r"><span class="ad-dot" style="background:${escAttr(r.color)}"></span>
          ${esc(r.label)} <b>${esc(fmtVal(r.y))}</b> ${esc(r.unit)}</div>`).join('');
    const r = stage.getBoundingClientRect();
    const lx = ev.clientX - r.left, ly = ev.clientY - r.top;
    tip.hidden = false;
    tip.style.left = Math.min(r.width - tip.offsetWidth - 8, lx + 14) + 'px';
    tip.style.top  = Math.min(r.height - tip.offsetHeight - 8, ly + 14) + 'px';
  }

  function bind() {
    const stage = document.getElementById('ad-stage');
    const svg = document.getElementById('ad-svg');
    if (!stage || !svg) return;

    svg.onpointermove = ev => {
      const px = localX(ev, svg);
      const r = svg.getBoundingClientRect();
      const py = (ev.clientY - r.top) * (ad.h / r.height);
      if (ad.drag) {
        if (ad.drag.brush) { ad.drag.x1 = px; draw(); return; }
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
      const g = geom();
      if (!g) return;
      svg.setPointerCapture?.(ev.pointerId);
      const px = localX(ev, svg);
      ad.drag = { px, x0: px, x1: px, t0: g.v.t0, t1: g.v.t1, brush: ad.brush || ev.shiftKey, moved: false };
    };
    svg.onpointerup = ev => {
      const d = ad.drag;
      ad.drag = null;
      if (!d) return;
      const px = localX(ev, svg);
      const moved = Math.abs(px - d.x0) > 3;
      if (d.brush && moved) {
        const g = geom();
        const a = g.v.t0 + (Math.min(d.x0, px) - PADL) / g.pw * (g.v.t1 - g.v.t0);
        const b = g.v.t0 + (Math.max(d.x0, px) - PADL) / g.pw * (g.v.t1 - g.v.t0);
        if (b - a > 1000) ad.view = { t0: a, t1: b };
      } else if (!moved) {
        // A click pins the nearest reading, so it can be read in full and
        // its verdict explained.
        const r = svg.getBoundingClientRect();
        const py = (ev.clientY - r.top) * (ad.h / r.height);
        const h = hoverAt(px, py);
        if (h && h.rows.length) ad.pin = { key: h.rows[0].key, i: h.rows[0].i };
        else ad.pin = null;
      }
      draw(); drawOv(); renderReadout();
    };
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      const g = geom();
      if (!g) return;
      const t = g.tOf(localX(ev, svg));
      const z = Math.exp(ev.deltaY * 0.0014);
      ad.view = { t0: t - (t - g.v.t0) * z, t1: t + (g.v.t1 - t) * z };
      draw(); drawOv(); renderReadout();
    }, { passive: false });
    svg.ondblclick = () => { ad.view = null; ad.pin = null; draw(); drawOv(); renderReadout(); };

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
        case '0': ad.view = null; break;
        case 'Escape': ad.pin = null; break;
        default: return;
      }
      ev.preventDefault();
      draw(); drawOv(); renderReadout();
    };

    // Overview: drag anywhere on it to centre the window there.
    const ov = document.getElementById('ad-ov');
    if (ov) {
      const jump = ev => {
        const ex = extent();
        if (!ex) return;
        const r = ov.getBoundingClientRect();
        const px = (ev.clientX - r.left) * (ad.w / r.width);
        const t = ex.t0 + (px - PADL) / (ad.w - PADL - PADR) * (ex.t1 - ex.t0);
        const v = view();
        const half = (v.t1 - v.t0) / 2;
        ad.view = { t0: t - half, t1: t + half };
        draw(); drawOv(); renderReadout();
      };
      ov.onpointerdown = ev => { ov.setPointerCapture?.(ev.pointerId); ad.ovDrag = true; jump(ev); };
      ov.onpointermove = ev => { if (ad.ovDrag) jump(ev); };
      ov.onpointerup = () => { ad.ovDrag = false; };
      ov.onpointerleave = () => { ad.ovDrag = false; };
    }

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

  function init() {
    if (ad.ro) { ad.ro.disconnect(); ad.ro = null; }
    measure();
    bind();
    draw();
    drawOv();
    const stage = document.getElementById('ad-stage');
    if (stage && typeof ResizeObserver !== 'undefined') {
      // The comparison panes size themselves off their own column, which the
      // stage's width tracks, so one observer serves both.
      ad.ro = new ResizeObserver(() => { if (measure()) { draw(); drawOv(); } });
      ad.ro.observe(stage);
    }
  }

  function stop() { if (ad.ro) { ad.ro.disconnect(); ad.ro = null; } }

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
  function redraw(sideToo) {
    for (const s of ad.series) s.tracks = null;
    if (sideToo) renderSide();
    draw(); drawOv(); renderReadout();
  }

  // ── handlers ───────────────────────────────────────────────────────────────

  const find = key => ad.series.find(s => s.key === key);

  function pick(input) { importFiles(input.files); input.value = ''; }

  function toggle(key) { const s = find(key); if (s) { s.visible = !s.visible; redraw(true); } }
  function setColor(key, v) { const s = find(key); if (s) { s.color = v; draw(); drawOv(); } }
  function setKind(key, v) { const s = find(key); if (s) { s.kind = v; s.filt = null; s.tracks = null; redraw(true); } }
  function solo(key) { ad.series.forEach(s => { s.visible = s.key === key; }); redraw(true); }
  function zoomTo(key) {
    const s = find(key);
    if (!s || !s.n) return;
    ad.view = { t0: s.t[0], t1: s.t[s.n - 1] };
    draw(); drawOv(); renderReadout();
  }
  function remove(key) {
    ad.series = ad.series.filter(s => s.key !== key);
    if (ad.pin && ad.pin.key === key) ad.pin = null;
    ad.view = null;
    renderAll();
  }
  function clearAll() {
    const what = ad.source === 'field' ? 'loaded series' : 'imports';
    if (ad.series.length > 1 && !confirm(`Remove all ${ad.series.length} ${what}?`)) return;
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
      i.series = []; i.pin = null; i.hover = null; i.view = null;
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
  function setY(v)         { ad.yMode = v; renderMainOnly(); }
  function setYRange(which, v) { if (which === 'min') ad.yMin = v; else ad.yMax = v; draw(); }
  function setFlag(k, v)   { ad[k] = v; renderMainOnly(); }
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
      });
    };
    img.onerror = () => note('The browser would not render the chart to PNG — the SVG download works.', true);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  }

  // Called on a theme change, where every colour in both panes is now wrong —
  // so the comparison redraws whether or not its inputs moved.
  function repaint() { draw(); drawOv(); drawCompare(true); }

  return {
    // The instance on screen. A getter rather than a property because `ad` is a
    // binding that moves with the active tab, and a captured reference would go
    // stale the first time the operator opened the other one.
    get ad() { return ad; },
    // Both instances' series at once, for the memory meter — which is asking
    // about the page's footprint, not about either tab.
    allSeries: () => Object.values(instances).flatMap(i => i.series),
    render, init, stop, repaint, importFiles, pick,
    toggle, setColor, setKind, solo, zoomTo, remove, clearAll, showStation,
    setCfg, resetCfg, setMode, setTransform, setChart, setY, setYRange, setFlag,
    preset, unpin, exportCsv, exportImg, explain, compareToggle, dropAll,
    // the Field Data tab (#114)
    fieldSetStation, fieldToggleSensor, fieldAllSensors, fieldSetWindow,
    fieldSetRes, fieldSetDate, fieldRun, fieldClearError,
    // exposed for reasoning about the filter outside the UI
    parseCsv, parseName, linkStation, guessKind, runFilter, walk357,
    // the series boundary both sources cross
    seriesData, adoptSeries,
  };
})();
if (typeof window !== 'undefined') window.ArroData = ArroData;

