// MegaNet — sensor-sparks.js
//
//   SensorSparks   a sparkline on each sensor row of the station editor — the
//                  last seven days of what that row's address has sent, out of
//                  the datastore — which opens a chart of it in a dialog, with
//                  a door from there onto the Field Data tab.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, pInt and announce; to
// datastore.js for dbSelect; to sensor-values.js for SensorValues (what kind
// of sensor a type is); to health-analysis.js for HealthAnalysis — rainOf (a
// rain gauge's tips, with its wraps, resets and corrupted frames taken out),
// fmtWhen and fmtSpan; to modal.js for Modal; to app.js for switchTab and
// toggleMapFullscreen; and to arro-data.js for ArroData.fieldChannelId and
// ArroData.fieldOpenAddr, the door the dialog opens onto Field Data. All at
// call time; nothing here runs at load (`npm run toplevel`).
// station-editor.js draws the slot on each row (slotHtml) and app.js's
// rerenderStationEditorCard() asks for the slots to be filled (fill).
//
// ── What a row's line is ─────────────────────────────────────────────────────
//
// The address the row's boxes say *now* — its ALERT address; else its ALERT2
// slot under the station's ALERT2 address; else its channel under the station
// number — read off the form rather than the record, so a row retyped and not
// saved shows what its new address has sent. The same three shapes
// meganet.reading files a reading under (0024), and the same precedence.
//
// Seven days, as the hourly rollups have them (the counter at the end of each
// hour), and the last few hours from the raw readings, because the rollups are
// built once an hour (0070) and a line that stopped an hour short would read
// as a station gone quiet. One request of each for the whole station, kept two
// minutes, so redrawing the card does not ask again.
//
// What the line is in depends on what the row says the sensor is, by the same
// rules the Message Log and Station Health use:
//
//   battery    volts — the datastore's conversion when it recorded one, else
//              raw ÷ 10, on a scale no narrower than 11.5–14.5 V so one row's
//              slope reads against the next. Readings that cannot be a 12 V
//              battery (9–16.5 V, SensorValues) and one-reading spikes are left
//              out, as Station Health leaves them out, and the dialog counts
//              them — the live network stores 163 V and 203 V on battery
//              addresses, corrupted frames, and one of them flattens a week.
//   rain       the rain fallen since the window began, from the gauge's tips
//              with the counter's wraps, resets and corrupted frames taken out
//              (HealthAnalysis.rainOf) — a storm is a step, a dry week a flat
//              line. A "Rainfall Increment" row is the same address and the
//              same tips, drawn as the rain in each stretch of the window:
//              bars rather than a staircase.
//   the rest   the recorded engineering value when there is one, else the raw
//              count, which says so — a level's scale is set per site and
//              Flood-Net records none. A level's one-reading spikes are left
//              out by Station Health's rule too.
//
// ── The dialog, and the door ────────────────────────────────────────────────
//
// Pressing the line opens it larger, with axes, over 24 hours to 12 months —
// raw readings to a week, hourly rollups to 90 days, daily beyond, as the
// Field Data tab chooses — the reading under the pointer or the arrow keys,
// and the readings themselves as a table one press away (design-system.md,
// *Charts*). It is a look, not the tool: **Open in Field Data** takes the
// address and the window to the tab that filters, inspects and exports them.
// Like the row's Flip, going there leaves anything typed into the editor and
// not saved behind, which the dialog says when the card is holding some.

const SensorSparks = (function () {
  const HOUR = 3600000, DAY = 86400000;
  const SPARK_DAYS = 7;
  const TTL = 120000;          // a load is reused this long
  const PAGE = 1000;           // PostgREST's usual cap; paged until a short page
  const ROW_CAP = 30000;       // per load — a guard, said when it bites
  const TAIL_HOURS = 3;        // raw readings this far back, past the rollups

  // The windows the dialog offers: Field Data's own keys, so the door hands
  // the same window over, and the resolution it would pick for each.
  const WINS = [
    { k: '24h',  label: '24 hours',  days: 1,   res: 'raw' },
    { k: '7d',   label: '7 days',    days: 7,   res: 'raw' },
    { k: '30d',  label: '30 days',   days: 30,  res: 'hourly' },
    { k: '90d',  label: '90 days',   days: 90,  res: 'hourly' },
    { k: '12mo', label: '12 months', days: 365, res: 'daily' },
  ];
  const RES_WORDS = {
    raw:    'every reading',
    hourly: 'the reading at the end of each hour',
    daily:  'the reading at the end of each day',
  };

  // The row's line, in px: drawn at this size and never stretched.
  const SP_W = 120, SP_H = 28, SP_PX = 3, SP_PY = 4;
  const BATT = [11.5, 14.5];
  // The dialog's chart, in px: drawn at the width the dialog gives it (W is
  // measured each time), so its labels stay the size they are on a phone.
  const CH = { W: 680, H: 250, L: 58, R: 14, T: 24, B: 30 };
  const TABLE_ROWS = 200;

  const cache = new Map();     // key -> { at, data, promise }
  let dlg = null;              // the dialog's state while it is open

  // ── addresses ─────────────────────────────────────────────────────────────

  function rowAddr(row) {
    const val = sel => (row.querySelector(sel)?.value || '').trim();
    const aid = pInt(val('.sensor-aid'));
    if (aid != null) return `a:${aid}`;
    const slot = pInt(val('.sensor-a2id'));
    const a2 = pInt(document.getElementById('ef-a2stn')?.value);
    if (slot != null && a2 != null) return `a2:${a2}/${slot}`;
    const num = (document.getElementById('ef-stnno')?.value || '').trim();
    const chan = typeof ArroData !== 'undefined' && ArroData.fieldChannelId
      ? ArroData.fieldChannelId({ alert_id: null, sensor_id: row.dataset.sensorId || '' }) : null;
    return chan && num ? `s:${num}/${chan}` : null;
  }

  function addrLabel(addr) {
    const a = String(addr || '');
    if (a.startsWith('a:')) return `ALERT ${a.slice(2)}`;
    if (a.startsWith('a2:')) { const [s, n] = a.slice(3).split('/'); return `ALERT2 ${s} slot ${n}`; }
    if (a.startsWith('s:')) { const [s, c] = a.slice(2).split('/'); return `${s} · ${c}`; }
    return a;
  }

  // The station the editor is showing — for its bucket size and its id.
  function editorStation() {
    if (state.editorId) return (state.data?.stations || []).find(s => s.id === state.editorId) || state.editorDraft || null;
    return state.editorDraft || null;
  }

  // ── reading the datastore ─────────────────────────────────────────────────

  function addrList(addrs) {
    // Quoted: an address carries a colon and a slash, both punctuation to
    // PostgREST's list parser (arro-data.js's fieldQueryRows does the same).
    const list = addrs.map(a => `"${String(a).replace(/["\\]/g, '')}"`).join(',');
    return `addr=in.(${encodeURIComponent(list).replace(/%2C/g, ',')})`;
  }

  async function paged(base) {
    const rows = [];
    let capped = false;
    for (;;) {
      const page = await dbSelect(`${base}&limit=${PAGE}&offset=${rows.length}`);
      if (!Array.isArray(page) || !page.length) break;
      rows.push(...page);
      if (page.length < PAGE) break;
      if (rows.length >= ROW_CAP) { capped = true; break; }
    }
    return { rows, capped };
  }

  const isoDay = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const num = v => (v == null || v === '' ? NaN : Number(v));

  // The readings at these addresses from t0 to now, as { addr: [{t, raw, val,
  // unit}] } oldest first. `res` raw reads meganet.reading; a rollup reads its
  // table up to the last whole hours and the raw readings after them, so the
  // line runs to now whatever the time of the last roll_up().
  async function readWindow(addrs, t0, res) {
    const now = Date.now();
    const iso = ms => encodeURIComponent(new Date(ms).toISOString());
    const rawFrom = res === 'raw' ? t0 : Math.max(t0, Math.floor(now / HOUR) * HOUR - (TAIL_HOURS - 1) * HOUR);
    const rawQ = paged(`reading?${addrList(addrs)}&reading_ts=gte.${iso(rawFrom)}`
      + '&select=addr,reading_ts,value_raw,value,unit&order=addr.asc,reading_ts.asc');
    let rollQ = Promise.resolve({ rows: [], capped: false });
    if (res !== 'raw') {
      const table = res === 'hourly' ? 'reading_hourly' : 'reading_daily';
      const lo = res === 'daily' ? isoDay(t0) : new Date(t0).toISOString();
      rollQ = paged(`${table}?${addrList(addrs)}&bucket=gte.${encodeURIComponent(lo)}`
        + '&select=addr,bucket,raw_last,val_last,unit,last_ts,n&order=addr.asc,bucket.asc');
    }
    const [raw, roll] = await Promise.all([rawQ, rollQ]);
    const out = {};
    const put = (addr, p) => (out[addr] || (out[addr] = [])).push(p);
    roll.rows.forEach(r => {
      const t = Date.parse(r.last_ts || r.bucket);
      if (!isFinite(t) || t < t0 || t >= rawFrom) return;
      put(r.addr, { t, raw: num(r.raw_last), val: num(r.val_last), unit: (r.unit || '').trim() });
    });
    raw.rows.forEach(r => {
      const t = Date.parse(r.reading_ts);
      if (!isFinite(t) || t < rawFrom) return;
      put(r.addr, { t, raw: num(r.value_raw), val: num(r.value), unit: (r.unit || '').trim() });
    });
    Object.values(out).forEach(pts => pts.sort((a, b) => a.t - b.t));
    return { pts: out, t0, t1: now, res, capped: raw.capped || roll.capped };
  }

  function load(addrs, t0, res, key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.promise;
    const entry = { at: Date.now(), data: null, promise: null };
    entry.promise = readWindow(addrs, t0, res).then(
      d => { entry.data = d; return d; },
      err => { cache.delete(key); throw err; });
    cache.set(key, entry);
    return entry.promise;
  }

  function fresh(key) {
    const hit = cache.get(key);
    return hit && hit.data && Date.now() - hit.at < TTL ? hit.data : null;
  }

  // ── what a line is ─────────────────────────────────────────────────────────

  function kindOfType(type) {
    const k = typeof SensorValues !== 'undefined' ? SensorValues.kindOf(type || '') : null;
    return k === 'battery' || k === 'rain' || k === 'level' ? k : 'other';
  }

  const round = (v, dp) => { const k = Math.pow(10, dp); return Math.round(v * k) / k; };
  const fmtNum = v => {
    const a = Math.abs(v);
    return a >= 1000 ? Math.round(v).toLocaleString() : String(round(v, a >= 100 ? 1 : a >= 10 ? 2 : 3));
  };

  const binWord = w => (w >= DAY ? 'day' : w === HOUR ? 'hour' : `${w / HOUR} hours`);

  // How wide a stretch of a window one bar of rain covers.
  function binMs(t0, t1, small) {
    const span = t1 - t0;
    if (small) return span <= 2 * DAY ? 2 * HOUR : 6 * HOUR;
    return span <= 8 * DAY ? HOUR : DAY;
  }

  // A window's points as the thing drawn: { shape: 'line' | 'bars', pts:
  // [{t, v}] or bars [{t, t1, v}], lo, hi, unit, fmt, how, … }.
  function seriesOf({ kind, incr, st, addr }, pts, t0, t1, small) {
    const sentAsValue = String(addr).startsWith('s:');
    const anyVal = pts.some(p => isFinite(p.val));
    const unitOf = list => {
      const c = new Map();
      list.forEach(p => { if (p.unit && p.unit !== 'count') c.set(p.unit, (c.get(p.unit) || 0) + 1); });
      let u = '', best = 0;
      c.forEach((n, k) => { if (n > best) { best = n; u = k; } });
      return u;
    };
    const unit = unitOf(pts);
    const spread = list => list.reduce((r, p) => [Math.min(r[0], p.v), Math.max(r[1], p.v)], [Infinity, -Infinity]);

    // Tips are counts, so a rain gauge is read off its raw counter whether or
    // not the datastore also recorded millimetres — unless a logger sent
    // millimetres in the first place, which has no tips to count.
    const rainable = kind === 'rain' && !(sentAsValue && unit)
      && typeof HealthAnalysis !== 'undefined' && HealthAnalysis.rainOf;
    if (rainable) {
      const R = HealthAnalysis.rainOf(pts.map(p => ({ t: p.t, v: p.raw })), st);
      const mm = tips => round(tips * R.mmPerTip, 2);
      const note = `${R.mmPerTip} mm a tip${R.recorded ? '' : ', assumed — no bucket size is recorded for this station'}`;
      if (incr) {
        const w = binMs(t0, t1, small);
        // On local midnight and its multiples, so a day's bar is a day.
        const mid = new Date(t0); mid.setHours(0, 0, 0, 0);
        const first = mid.getTime() + Math.floor((t0 - mid.getTime()) / w) * w;
        const bars = [];
        for (let b = first; b < t1; b += w) bars.push({ t: Math.max(b, t0), t1: Math.min(b + w, t1), v: 0 });
        R.steps.forEach(s => {
          const i = Math.floor((s.t - first) / w);
          if (bars[i]) bars[i].v += s.tips;
        });
        bars.forEach(b => { b.v = mm(b.v); });
        const top = bars.reduce((m, b) => Math.max(m, b.v), 0);
        return { shape: 'bars', bars, pts: bars.map(b => ({ t: b.t, v: b.v })), lo: 0, hi: Math.max(small ? 2 : 1, top),
                 unit: 'mm', fmt: v => `${fmtNum(v)} mm`, total: mm(R.tips), binW: w, n: pts.length,
                 how: `the rain in each ${binWord(w)}, from the gauge's tips at ${note}` };
      }
      let i = 0, tips = 0;
      const line = pts.map(p => {
        while (i < R.steps.length && R.steps[i].t <= p.t) tips += R.steps[i++].tips;
        return { t: p.t, v: mm(tips), raw: p.raw };
      });
      const fell = line.length ? line[line.length - 1].v : 0;
      return { shape: 'line', pts: line, lo: 0, hi: Math.max(small ? 10 : 1, fell), unit: 'mm', fmt: v => `${fmtNum(v)} mm`,
               fallen: true, total: fell, n: pts.length,
               how: `the rain fallen since the window began, from the gauge's tips at ${note}` };
    }

    let how, u, conv;
    if (anyVal) {
      conv = p => p.val; u = unit;
      how = 'as the datastore converted it';
    } else if (sentAsValue && unit) {
      conv = p => p.raw; u = unit;
      how = 'as the logger sent it';
    } else if (kind === 'battery') {
      conv = p => round(p.raw / 10, 1); u = 'V';
      how = 'raw ÷ 10 — the ALERT battery convention, worked out here rather than recorded';
    } else {
      conv = p => p.raw; u = '';
      how = kind === 'level'
        ? 'the raw count — a level\'s scale is set per site and Flood-Net records none'
        : 'the raw count — no conversion is recorded for this sensor';
    }
    let line = pts.map(p => ({ t: p.t, v: conv(p), raw: p.raw })).filter(p => isFinite(p.v));
    let counts = !u;
    // What Station Health leaves out (health-analysis.js, the battery and the
    // level): a battery reading no 12 V battery gives, and a one-reading spike
    // — a value far from two neighbours that agree, a few bits from them.
    const H = typeof HealthAnalysis !== 'undefined' && HealthAnalysis.spikesOf ? HealthAnalysis : null;
    const left = [];
    if (kind === 'battery' && u === 'V' && typeof SensorValues !== 'undefined') {
      const ok = line.filter(p => p.v >= SensorValues.BATT_MIN_V && p.v <= SensorValues.BATT_MAX_V);
      if (line.length >= 4 && ok.length < line.length * 0.5) {
        // Not a battery at all, here: the counts, said so, rather than a
        // line of volts that would be a fiction.
        line = line.map(p => ({ t: p.t, v: p.raw, raw: p.raw })).filter(p => isFinite(p.v));
        u = ''; counts = true;
        how = 'the raw count — most of these readings are not a 12 V battery, so another sensor, or another station, is on this address here';
      } else {
        if (ok.length < line.length) left.push(`${line.length - ok.length} that cannot be a 12 V battery`);
        line = ok;
        if (H && line.length >= 3) {
          const sp = new Set(H.spikesOf(line, 0.6, p => Math.round(p.v * 10)).map(p => p.t));
          if (sp.size) { left.push(`${sp.size} one-reading spike${sp.size === 1 ? '' : 's'}`); line = line.filter(p => !sp.has(p.t)); }
        }
      }
    } else if (kind === 'level' && H && line.length >= 3 && line.every(p => isFinite(p.raw))) {
      const c = line.map(p => p.raw).sort((a, b) => a - b);
      const med = c[c.length >> 1];
      const sp = new Set(H.spikesOf(line.map(p => ({ t: p.t, v: p.raw })), Math.max(10, 0.1 * Math.abs(med))).map(p => p.t));
      if (sp.size) { left.push(`${sp.size} one-reading spike${sp.size === 1 ? '' : 's'}`); line = line.filter(p => !sp.has(p.t)); }
    }
    if (left.length) how += `; ${left.join(' and ')} left out, as Station Health leaves them out`;
    let [lo, hi] = line.length ? spread(line) : [0, 1];
    const volts = kind === 'battery' && u === 'V';
    if (volts && small) { lo = Math.min(BATT[0], lo); hi = Math.max(BATT[1], hi); }
    // A count or two either way, or a tenth of a volt, is a wobble, not a
    // shape: the scale is never narrower than this, so it is not drawn as one.
    const whole = line.every(p => Number.isInteger(p.v));
    const minSpan = volts ? 1 : whole ? 10 : small ? 0.5 : Math.max(Math.abs((lo + hi) / 2) * 0.02, 0.05);
    if (hi - lo < minSpan) { const m = (lo + hi) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
    // Volts to the tenth the ALERT convention sends, unless recorded finer.
    const vText = v => { const t = v.toFixed(1); return Math.abs(v - Number(t)) < 1e-9 ? t : fmtNum(v); };
    return { shape: 'line', pts: line, lo, hi, unit: u, counts, n: line.length, how, left: left.length,
             fmt: v => (volts ? `${vText(v)} V` : u ? `${fmtNum(v)} ${u}` : `${fmtNum(v)}`) };
  }

  // Where the line lifts: three times the usual gap between readings, and
  // never tighter than `floor` — a rain gauge that only speaks when it rains
  // and a level every five minutes are both normal.
  function gapOf(pts, floor) {
    const d = [];
    for (let i = 1; i < pts.length; i++) { const g = pts[i].t - pts[i - 1].t; if (g > 0) d.push(g); }
    if (d.length < 3) return Infinity;
    d.sort((a, b) => a - b);
    return Math.max(3 * d[d.length >> 1], floor);
  }

  function pathOf(pts, X, Y, gap) {
    let d = '';
    pts.forEach((p, i) => {
      const q = pts[i - 1], n = pts[i + 1];
      const start = !q || p.t - q.t > gap;
      d += `${start ? 'M' : 'L'}${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`;
      if (start && (!n || n.t - p.t > gap)) d += 'h0.1';
    });
    return d;
  }

  // A few points a pixel at most: a column keeps its first, last, highest and
  // lowest, so a week of five-minute readings keeps its shape.
  function thin(pts, X, width) {
    if (pts.length <= 3 * width) return pts;
    const out = [];
    let col = null, run = [];
    const flush = () => {
      if (!run.length) return;
      let lo = run[0], hi = run[0];
      run.forEach(p => { if (p.v < lo.v) lo = p; if (p.v > hi.v) hi = p; });
      const keep = new Set([run[0], lo, hi, run[run.length - 1]]);
      run.forEach(p => { if (keep.has(p)) out.push(p); });
      run = [];
    };
    pts.forEach(p => { const c = Math.floor(X(p.t)); if (c !== col) { flush(); col = c; } run.push(p); });
    flush();
    return out;
  }

  const when = t => (typeof HealthAnalysis !== 'undefined' ? HealthAnalysis.fmtWhen(t) : new Date(t).toLocaleString());
  const ago = t => {
    const ms = Date.now() - t;
    if (ms < 90000) return 'just now';
    return typeof HealthAnalysis !== 'undefined' ? `${HealthAnalysis.fmtSpan(ms)} ago` : '';
  };

  // The headline, in words: what the line says and when it last said it.
  function summary(S, days) {
    const span = days === 1 ? '24 hours' : `${days} days`;
    if (!S.pts.length || (S.shape === 'bars' && !S.n)) return `nothing in the last ${span}`;
    if (S.fallen || S.shape === 'bars') {
      const top = S.shape === 'bars' ? S.bars.reduce((m, b) => (b.v > m.v ? b : m), S.bars[0]) : null;
      return `${S.total ? `${fmtNum(S.total)} mm of rain` : 'no rain'} in the last ${span}`
        + (top && top.v ? `, the wettest ${binWord(S.binW)} ${S.fmt(top.v)} from ${when(top.t)}` : '');
    }
    const last = S.pts[S.pts.length - 1];
    let lo = Infinity, hi = -Infinity;
    S.pts.forEach(p => { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; });
    return `${S.fmt(last.v)}${S.counts ? ' raw' : ''} at ${when(last.t)}; `
      + (lo === hi ? `steady over the last ${span}` : `${S.fmt(lo)} to ${S.fmt(hi)} over the last ${span}`);
  }

  // What the row shows beside its line: the latest, short.
  function shortValue(S) {
    if (S.fallen || S.shape === 'bars') return S.n ? `${fmtNum(S.total)} mm` : '—';
    const last = S.pts[S.pts.length - 1];
    if (!last) return '—';
    return S.counts ? `${fmtNum(last.v)} <span class="sspk-u">raw</span>` : esc(S.fmt(last.v));
  }

  // ── the row ───────────────────────────────────────────────────────────────

  // The slot, drawn by sensorRowHtml() before anything is known: a button
  // that becomes the line. Disabled until the row has an address.
  function slotHtml() {
    return `<button type="button" class="sensor-spark" onclick="SensorSparks.open(this)" disabled
             aria-label="No readings to chart — this row has no address yet"
             title="The last ${SPARK_DAYS} days of this sensor's readings, once the row has an address">${emptySvg()}<span class="sspk-val">—</span></button>`;
  }

  function emptySvg(extra = '') {
    const y = SP_H - SP_PY;
    return `<svg class="sspk-svg" viewBox="0 0 ${SP_W} ${SP_H}" width="${SP_W}" height="${SP_H}" aria-hidden="true" focusable="false">`
      + `<line class="sspk-base" x1="${SP_PX}" x2="${SP_W - SP_PX}" y1="${y}" y2="${y}"/>${extra}</svg>`;
  }

  function sparkSvg(S, t0, t1) {
    if (!S.pts.length || (S.shape === 'bars' && !S.n)) return emptySvg();
    const X = t => SP_PX + (SP_W - 2 * SP_PX) * (t - t0) / ((t1 - t0) || 1);
    const Y = v => SP_PY + (SP_H - 2 * SP_PY) * (1 - (v - S.lo) / ((S.hi - S.lo) || 1));
    let g = '';
    if (S.shape === 'bars') {
      const base = Y(S.lo);
      S.bars.forEach(b => {
        if (!b.v) return;
        const x = X(b.t), w = Math.max(1, X(b.t1) - x - 0.6), y = Y(b.v);
        g += `<rect class="sspk-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, base - y).toFixed(1)}"/>`;
      });
      return emptySvg(g);
    }
    const last = S.pts[S.pts.length - 1];
    g += `<path class="sspk-line" d="${pathOf(thin(S.pts, X, SP_W), X, Y, gapOf(S.pts, 6 * HOUR))}"/>`
       + `<circle class="sspk-end" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="2.5"/>`;
    return emptySvg(g);
  }

  function rowContext(row) {
    const type = (row.querySelector('.sensor-type')?.value || '').trim();
    return { type, kind: kindOfType(type), incr: /increment/i.test(type), st: editorStation(), addr: row.dataset.addr || '' };
  }

  function paintRow(row, data, err) {
    const btn = row.querySelector('.sensor-spark');
    if (!btn) return;
    const addr = row.dataset.addr || '';
    const ctx = rowContext(row);
    const name = `${ctx.type || 'Sensor'}${addr ? `, ${addrLabel(addr)}` : ''}`;
    if (!addr) {
      btn.disabled = true;
      btn.innerHTML = `${emptySvg()}<span class="sspk-val">—</span>`;
      btn.setAttribute('aria-label', 'No readings to chart — this row has no address yet');
      btn.title = `The last ${SPARK_DAYS} days of this sensor's readings, once the row has an address`;
      return;
    }
    btn.disabled = false;
    if (err) {
      btn.innerHTML = `${emptySvg()}<span class="sspk-val">?</span>`;
      btn.setAttribute('aria-label', `${name}: the datastore could not be asked — open the chart to try again`);
      btn.title = 'The datastore could not be asked for this sensor\'s readings. Press to try again.';
      return;
    }
    if (!data) {
      btn.innerHTML = `${emptySvg()}<span class="sspk-val sspk-wait">…</span>`;
      btn.setAttribute('aria-label', `${name}: reading the last ${SPARK_DAYS} days — open the chart`);
      btn.title = `Reading the last ${SPARK_DAYS} days of ${addrLabel(addr)} from the datastore`;
      return;
    }
    const S = seriesOf(ctx, data.pts[addr] || [], data.t0, data.t1, true);
    const said = summary(S, SPARK_DAYS);
    btn.innerHTML = `${sparkSvg(S, data.t0, data.t1)}<span class="sspk-val">${shortValue(S)}</span>`;
    btn.classList.toggle('sensor-spark--none', !S.n);
    btn.setAttribute('aria-label', `${name}: ${said}. Open the chart`);
    btn.title = `${said}.\n${S.how[0].toUpperCase()}${S.how.slice(1)}.\nPress for the chart.`;
  }

  // Every row of the editor, filled: one load for the whole station. Called
  // when the card is drawn and again when a box a row's address comes from
  // changes.
  function fill() {
    const box = document.getElementById('ef-sensors');
    if (!box) return;
    wire();
    const rows = [...box.querySelectorAll('.sensor-row')];
    rows.forEach(row => { row.dataset.addr = rowAddr(row) || ''; });
    const addrs = [...new Set(rows.map(r => r.dataset.addr).filter(Boolean))].sort();
    if (!addrs.length) { rows.forEach(r => paintRow(r)); return; }
    const t0 = Date.now() - SPARK_DAYS * DAY;
    const key = `spark|${addrs.join(',')}`;
    const have = fresh(key);
    if (have) { rows.forEach(r => paintRow(r, have)); return; }
    rows.forEach(r => paintRow(r));
    load(addrs, t0, 'hourly', key).then(
      // A row whose address changed meanwhile is the next fill's to paint.
      data => rows.forEach(r => { if (r.isConnected && addrs.includes(r.dataset.addr)) paintRow(r, data); }),
      () => rows.forEach(r => { if (r.isConnected && addrs.includes(r.dataset.addr)) paintRow(r, null, true); }));
  }

  // One listener on the card, which outlives the form drawn into it: a row's
  // address changes when one of these boxes does.
  function wire() {
    const card = document.getElementById('stations-editor-card');
    if (!card || card.dataset.sspkWired) return;
    card.dataset.sspkWired = '1';
    card.addEventListener('change', e => {
      const el = e.target;
      if (el && el.matches && el.matches('.sensor-aid, .sensor-a2id, .sensor-type, #ef-a2stn, #ef-stnno')) fill();
    });
  }

  // ── the dialog ────────────────────────────────────────────────────────────

  function open(btn) {
    const row = btn && btn.closest ? btn.closest('.sensor-row') : null;
    if (!row) return;
    const addr = row.dataset.addr || rowAddr(row);
    if (!addr) return;
    const ctx = rowContext(row);
    ctx.addr = addr;
    const st = ctx.st;
    const where = st && st.name ? ` at ${st.name}` : '';
    // The card says when it holds edits not saved (editorUnsavedRefresh,
    // station-editor.js); the tab switch the door makes would drop them.
    const unsaved = !!document.getElementById('stations-editor-card')?.classList.contains('is-unsaved');
    Modal.open({
      title: `${ctx.type || 'Sensor'} — ${addrLabel(addr)}`,
      wide: true,
      onClose: () => { dlg = null; },
      html: `
        <div class="sspk-modal">
          <p class="small sspk-sub">What ${esc(addrLabel(addr))}${esc(where)} has sent, out of the Flood-Net datastore.</p>
          <div class="hl-seg sspk-wins" role="group" aria-label="Over the last">
            ${WINS.map(w => `<button type="button" class="hl-chip" data-win="${w.k}" aria-pressed="false"
              onclick="SensorSparks.setWin('${w.k}')">${esc(w.label)}</button>`).join('')}
          </div>
          <div id="sspk-body"></div>
          <div class="sspk-foot">
            <span class="small txt-muted">The Field Data tab filters, inspects and exports these readings.${
              unsaved ? ' <strong class="sspk-unsaved">The editor has changes not saved yet — going there leaves them behind.</strong>' : ''}</span>
            <button type="button" class="primary" onclick="SensorSparks.toField()"
              title="Open ${escAttr(addrLabel(addr))} on the Field Data tab over the same window">📈 Open in Field Data →</button>
          </div>
        </div>`,
    });
    // After open(): a dialog it replaced is told it closed, which clears dlg.
    dlg = { ...ctx, win: '7d', seq: 0, data: null, S: null, at: -1 };
    setWin('7d');
  }

  function winOf(k) { return WINS.find(w => w.k === k) || WINS[1]; }

  function setWin(k) {
    if (!dlg) return;
    const w = winOf(k);
    dlg.win = w.k;
    document.querySelectorAll('.sspk-wins [data-win]').forEach(b => {
      const on = b.dataset.win === w.k;
      b.classList.toggle('hl-chip--on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const seq = ++dlg.seq;
    const me = dlg;
    const key = `win|${w.k}|${dlg.addr}`;
    const have = fresh(key);
    if (have) { draw(have); return; }
    const body = document.getElementById('sspk-body');
    if (body) body.innerHTML = `<p class="small sspk-wait">Reading ${esc(w.label)} of ${esc(addrLabel(dlg.addr))}…</p>`;
    load([dlg.addr], Date.now() - w.days * DAY, w.res, key).then(
      data => { if (dlg === me && me.seq === seq) draw(data); },
      err => {
        if (dlg !== me || me.seq !== seq) return;
        const el = document.getElementById('sspk-body');
        if (el) el.innerHTML = `<p class="small sspk-err" role="alert">The datastore could not be asked — ${esc(err && err.message || String(err))}.
          <button type="button" class="link-btn" onclick="SensorSparks.setWin('${w.k}')">Try again</button></p>`;
      });
  }

  function draw(data) {
    const w = winOf(dlg.win);
    const S = seriesOf(dlg, data.pts[dlg.addr] || [], data.t0, data.t1, false);
    dlg.data = data; dlg.S = S;
    dlg.at = S.pts.length - 1;
    const body = document.getElementById('sspk-body');
    if (!body) return;
    dlg.W = Math.max(300, Math.min(CH.W, Math.round(body.clientWidth || CH.W)));
    const said = summary(S, w.days);
    if (!S.pts.length || (S.shape === 'bars' && !S.n)) {
      body.innerHTML = `<p class="sspk-none">Nothing from ${esc(addrLabel(dlg.addr))} in the last ${esc(w.label)}.
        ${w.k !== '12mo' ? `<button type="button" class="link-btn" onclick="SensorSparks.setWin('${WINS[WINS.indexOf(w) + 1].k}')">Look back further</button>` : ''}</p>`;
      return;
    }
    body.innerHTML = `
      <p class="sspk-head"><b>${esc(said[0].toUpperCase() + said.slice(1))}.</b></p>
      <div class="sspk-stage" tabindex="0" role="group"
           aria-label="The chart — the arrow keys step through the ${S.shape === 'bars' ? 'bars' : 'readings'}, Home and End go to the ends"
           onkeydown="SensorSparks.key(event)" onpointermove="SensorSparks.point(event)" onpointerleave="SensorSparks.unpoint()">
        ${chartSvg(S, data.t0, data.t1, said)}
      </div>
      <p class="small sspk-read" id="sspk-read" aria-live="polite">${esc(readout(S, S.pts.length - 1))}</p>
      <p class="small txt-muted sspk-how">${esc(S.how[0].toUpperCase() + S.how.slice(1))}; ${esc(RES_WORDS[data.res])}${
        data.res !== 'raw' ? ' up to the last few hours, and every reading after them' : ''}.${
        data.capped ? ` <b>More readings than one look reads (${ROW_CAP.toLocaleString()}) — this is the start of the window; Field Data has the rest.</b>` : ''}</p>
      ${tableHtml(S)}`;
  }

  // ── the chart ─────────────────────────────────────────────────────────────

  function niceStep(span, n) {
    const raw = span / Math.max(1, n);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }

  function yAxis(lo, hi) {
    const step = niceStep((hi - lo) || 1, 4);
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    let dp = 0;
    while (dp < 6 && Math.abs(Math.round(step * 10 ** dp) - step * 10 ** dp) > 1e-6) dp++;
    const ticks = [];
    for (let v = a; v <= b + step / 1e6; v += step) ticks.push(+v.toFixed(10));
    return { lo: a, hi: b === a ? a + step : b, ticks, label: v => v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) };
  }

  const MON = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const T_STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];

  // Ticks on the hour, on midnight, or on the first of the month, local time
  // — at most `most` of them, which is fewer on a phone.
  function xTicks(t0, t1, most = 7) {
    const span = t1 - t0, out = [];
    if (span > 45 * DAY) {
      const every = Math.max(1, Math.ceil(span / (30.4 * DAY) / most));
      const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0);
      while (d.getTime() <= t1) {
        if (d.getTime() >= t0 && d.getMonth() % every === 0) {
          out.push({ t: d.getTime(), text: d.toLocaleDateString(undefined, d.getMonth() === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' }) });
        }
        d.setMonth(d.getMonth() + 1);
      }
      return out;
    }
    const step = T_STEPS.find(s => span / s <= most) || 28 * DAY;
    const d = new Date(t0);
    if (step < DAY) {
      d.setMinutes(0, 0, 0);
      const hs = step / HOUR;
      while (d.getTime() < t0 || d.getHours() % hs) d.setHours(d.getHours() + 1);
      for (; d.getTime() <= t1; d.setHours(d.getHours() + hs)) {
        const hm = `${String(d.getHours()).padStart(2, '0')}:00`;
        out.push({ t: d.getTime(), text: d.getHours() === 0 ? MON(d) : hm });
      }
    } else {
      d.setHours(0, 0, 0, 0);
      if (d.getTime() < t0) d.setDate(d.getDate() + 1);
      const days = Math.round(step / DAY);
      for (; d.getTime() <= t1; d.setDate(d.getDate() + days)) out.push({ t: d.getTime(), text: MON(d) });
    }
    return out;
  }

  function scales(S, t0, t1) {
    const ax = yAxis(S.lo, S.hi);
    const W = chartW();
    const X = t => CH.L + (W - CH.L - CH.R) * (t - t0) / ((t1 - t0) || 1);
    const Y = v => CH.T + (CH.H - CH.T - CH.B) * (1 - (v - ax.lo) / ((ax.hi - ax.lo) || 1));
    return { ax, X, Y };
  }

  function chartW() { return dlg && dlg.W ? dlg.W : CH.W; }

  function chartSvg(S, t0, t1, said) {
    const { ax, X, Y } = scales(S, t0, t1);
    const W = chartW();
    const f = v => v.toFixed(1);
    let g = '';
    ax.ticks.forEach(v => {
      g += `<line class="sspk-grid" x1="${CH.L}" x2="${W - CH.R}" y1="${f(Y(v))}" y2="${f(Y(v))}"/>`
         + `<text class="sspk-tick" x="${CH.L - 6}" y="${f(Y(v) + 4)}" text-anchor="end">${esc(ax.label(v))}</text>`;
    });
    xTicks(t0, t1, W < 520 ? 4 : 7).forEach(tk => {
      const x = X(tk.t);
      if (x < CH.L - 0.5 || x > W - CH.R + 0.5) return;
      g += `<line class="sspk-grid sspk-grid--x" x1="${f(x)}" x2="${f(x)}" y1="${CH.T}" y2="${CH.H - CH.B}"/>`
         + `<text class="sspk-tick" x="${f(x)}" y="${CH.H - CH.B + 16}" text-anchor="middle">${esc(tk.text)}</text>`;
    });
    if (S.unit || S.counts) {
      g += `<text class="sspk-tick sspk-unit" x="${CH.L - 6}" y="${CH.T - 10}" text-anchor="end">${esc(S.unit || 'raw')}</text>`;
    }
    if (S.shape === 'bars') {
      const base = Y(ax.lo);
      S.bars.forEach(b => {
        if (!b.v) return;
        const x = X(b.t), w = Math.max(1, X(b.t1) - x - 0.8), y = Y(b.v);
        g += `<rect class="sspk-bar" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(Math.max(1, base - y))}"/>`;
      });
    } else {
      const floor = dlg && winOf(dlg.win).res === 'raw' ? HOUR : winOf(dlg && dlg.win).res === 'hourly' ? 6 * HOUR : 2.5 * DAY;
      const last = S.pts[S.pts.length - 1];
      const gap = gapOf(S.pts, floor);
      g += `<path class="sspk-line sspk-line--big" d="${pathOf(thin(S.pts, X, W), X, Y, gap)}"/>`;
      // A reading alone between two silences is a mark of its own, not a
      // two-pixel full stop — on a station that reports twice a week it is
      // most of what there is to see.
      S.pts.forEach((p, i) => {
        const q = S.pts[i - 1], n = S.pts[i + 1];
        if ((!q || p.t - q.t > gap) && (!n || n.t - p.t > gap) && p !== last) {
          g += `<circle class="sspk-pt" cx="${f(X(p.t))}" cy="${f(Y(p.v))}" r="2.5"/>`;
        }
      });
      g += `<circle class="sspk-end" cx="${f(X(last.t))}" cy="${f(Y(last.v))}" r="3.5"/>`;
    }
    g += `<line class="sspk-axis" x1="${CH.L}" x2="${W - CH.R}" y1="${CH.H - CH.B}" y2="${CH.H - CH.B}"/>`
       + `<line class="sspk-cross" id="sspk-cross" x1="0" x2="0" y1="${CH.T}" y2="${CH.H - CH.B}" visibility="hidden"/>`
       + `<circle class="sspk-dot" id="sspk-dot" cx="0" cy="0" r="4" visibility="hidden"/>`;
    return `<svg class="sspk-chart" viewBox="0 0 ${W} ${CH.H}" role="img"
      aria-label="${escAttr(`${dlg ? dlg.type || 'Sensor' : 'Sensor'}, ${dlg ? addrLabel(dlg.addr) : ''}: ${said}`)}">${g}</svg>`;
  }

  function readout(S, i) {
    if (S.shape === 'bars') {
      const b = S.bars[i];
      if (!b) return '';
      return `${S.fmt(b.v)} — ${when(b.t)} to ${when(b.t1)}`;
    }
    const p = S.pts[i];
    if (!p) return '';
    return `${S.fmt(p.v)}${S.counts ? ' raw' : S.fallen ? ' since the window began' : ''} — ${when(p.t)}${i === S.pts.length - 1 ? ` (${ago(p.t)}, the latest)` : ''}`;
  }

  function mark(i) {
    if (!dlg || !dlg.S) return;
    const S = dlg.S, items = S.shape === 'bars' ? S.bars : S.pts;
    if (!items.length) return;
    i = Math.max(0, Math.min(items.length - 1, i));
    dlg.at = i;
    const { X, Y } = scales(S, dlg.data.t0, dlg.data.t1);
    const it = items[i];
    const x = S.shape === 'bars' ? (X(it.t) + X(it.t1)) / 2 : X(it.t);
    const y = Y(it.v);
    const cross = document.getElementById('sspk-cross'), dot = document.getElementById('sspk-dot');
    if (cross) { cross.setAttribute('x1', x.toFixed(1)); cross.setAttribute('x2', x.toFixed(1)); cross.setAttribute('visibility', 'visible'); }
    if (dot) { dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1)); dot.setAttribute('visibility', 'visible'); }
    const read = document.getElementById('sspk-read');
    if (read) read.textContent = readout(S, i);
  }

  function nearest(items, t, bars) {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if ((bars ? items[m].t1 : items[m].t) < t) lo = m + 1; else hi = m; }
    if (bars) return lo;
    const a = items[lo - 1], b = items[lo];
    return a && (!b || t - a.t < b.t - t) ? lo - 1 : lo;
  }

  function point(e) {
    if (!dlg || !dlg.S) return;
    const svg = e.currentTarget && e.currentTarget.querySelector('svg.sspk-chart');
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const W = chartW();
    const px = (e.clientX - box.left) * W / (box.width || W);
    const t = dlg.data.t0 + (px - CH.L) / (W - CH.L - CH.R) * (dlg.data.t1 - dlg.data.t0);
    const S = dlg.S;
    mark(nearest(S.shape === 'bars' ? S.bars : S.pts, t, S.shape === 'bars'));
  }

  function unpoint() {
    ['sspk-cross', 'sspk-dot'].forEach(id => document.getElementById(id)?.setAttribute('visibility', 'hidden'));
    if (dlg && dlg.S) {
      const read = document.getElementById('sspk-read');
      const S = dlg.S;
      if (read) read.textContent = readout(S, (S.shape === 'bars' ? S.bars : S.pts).length - 1);
    }
  }

  function key(e) {
    if (!dlg || !dlg.S) return;
    const items = dlg.S.shape === 'bars' ? dlg.S.bars : dlg.S.pts;
    const step = e.shiftKey ? Math.max(1, Math.round(items.length / 20)) : 1;
    const to = { ArrowLeft: dlg.at - step, ArrowRight: dlg.at + step, Home: 0, End: items.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    mark(to);
  }

  // The data as a table (design-system.md, *Charts*, part 3): newest first,
  // capped, and saying so.
  function tableHtml(S) {
    const bars = S.shape === 'bars';
    const items = (bars ? S.bars.filter(b => b.v) : S.pts).slice().reverse();
    if (!items.length) return '';
    const shown = items.slice(0, TABLE_ROWS);
    const head = bars ? '<th scope="col">From</th><th scope="col">Rain</th>'
      : `<th scope="col">When</th><th scope="col">${S.fallen ? 'Fallen since the window began' : 'Value'}</th>${S.counts ? '' : '<th scope="col">Raw count</th>'}`;
    const rows = shown.map(it => bars
      ? `<tr><td>${esc(when(it.t))}</td><td class="num">${esc(S.fmt(it.v))}</td></tr>`
      : `<tr><td>${esc(when(it.t))}</td><td class="num">${esc(S.fmt(it.v))}</td>${S.counts ? '' : `<td class="num">${isFinite(it.raw) ? esc(fmtNum(it.raw)) : '—'}</td>`}</tr>`).join('');
    const unitWord = S.binW >= DAY ? 'day' : S.binW === HOUR ? 'hour' : 'stretch';
    const what = bars ? `${items.length.toLocaleString()} ${unitWord}${items.length === 1 ? '' : unitWord === 'stretch' ? 'es' : 's'} with rain`
      : `${items.length.toLocaleString()} reading${items.length === 1 ? '' : 's'}`;
    return `
      <details class="sspk-data">
        <summary>The ${esc(what)}, as a table</summary>
        ${items.length > TABLE_ROWS ? `<p class="small txt-muted">The newest ${TABLE_ROWS} of ${items.length.toLocaleString()} — Field Data lists and exports them all.</p>` : ''}
        <div class="table-wrap sspk-table-wrap" role="region" tabindex="0" aria-label="The readings">
          <table class="sspk-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
        </div>
      </details>`;
  }

  // ── the door ──────────────────────────────────────────────────────────────

  // The same address and window on the Field Data tab. Out of full screen
  // first and the tab switched before the picker is set, as the station
  // card's Field data → does (fieldDataFromCard, app.js): switchTab() is what
  // makes the field instance the one on screen.
  function toField() {
    if (!dlg || typeof ArroData === 'undefined' || !ArroData.fieldOpenAddr) return;
    const { addr, win } = dlg;
    const stationId = state.editorId || '';
    Modal.close();
    if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
    switchTab('field');
    ArroData.fieldOpenAddr(addr, { stationId, win });
    if (typeof announce === 'function') announce(`Field Data: ${addrLabel(addr)}, ${winOf(win).label}`);
  }

  return {
    slotHtml, fill, open, setWin, toField, point, unpoint, key,
    // for test/sensorsparks.mjs
    seriesOf, addrLabel, xTicks, yAxis, WINS,
  };
})();

if (typeof window !== 'undefined') window.SensorSparks = SensorSparks;
