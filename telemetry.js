// MegaNet — telemetry.js
//
//   Telemetry   the 📡 Telemetry tab: what the base stations hear, charted —
//               how much comes in, how much of it decodes, ALERT against
//               ALERT2, channel against channel and base station against base
//               station, hour by hour or day by day.
//
// After core.js and datastore.js, before init.js — index.html holds the order.
// Reads core.js (state, esc, termHtml, dlText, csvEscape, registerTabTeardown,
// announce) and datastore.js (dbRpc) at call time; nothing runs at load.
//
// What this tab is for, and why it is not the Message Log or Base Stations:
//
//   * **The network's traffic as a whole.** The Message Log is the readings,
//     one row each; Base Stations is one receiver's own page, for editors.
//     This tab is every named base station's tallies at once, for anybody, so
//     a question like "did ALERT2 on 151.5375 decode worse this week than
//     last, and at which base station?" is two clicks.
//   * **Quality as well as quantity.** A burst heard is not a reading. Each
//     tally says what became of its bursts — decoded, a copy the receiver
//     already had, a bit-flipped shadow the decoder set aside, a broken
//     frame, a failed check, nothing readable — and every chart can be split
//     by that outcome.
//   * **Simple and layered.** The ready-made panels answer the usual
//     questions; the Chart builder lays any measure along time, hour of day,
//     channel or base station, coloured by a second thing and side by side by
//     a third.
//
// Where the numbers come from: meganet.telemetry_traffic() and
// meganet.telemetry_links() (0123), which boil the reception roll-ups (0071)
// down to base station name, channel, protocol and hour or UTC day. They read
// the tallies, never the receptions, so a page view costs the database's disk
// a few megabytes at most. A tab opened before 0123 is applied says so and
// offers the demo, which runs every panel on made-up numbers.

const Telemetry = (() => {

  // ── constants ──────────────────────────────────────────────────────────────

  const HOUR = 3600e3, DAY = 86400e3;
  const WINDOWS = [[1, '24 hours'], [3, '3 days'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'A year']];
  const HOURLY_MAX = 7;            // up to a week by the hour; longer by the day
  const CACHE_MS = 10 * 60e3;      // a window read in the last ten minutes is not read again
  const WIN_KEY = 'mn-tm-days';
  const TABLE_MAX = 400;
  const SLOTS = 7;                 // categorical colours before the rest fold into "Other"
  const PROT_NAME = { alert: 'ALERT', alert2: 'ALERT2', other: 'Other' };
  const PROT_CLS = { alert: 'p1', alert2: 'p2', other: 'co' };
  const PROT_ORDER = ['alert', 'alert2', 'other'];
  const FIELDS = ['n', 'dec', 'copy', 'shadow', 'und', 'frame', 'chk', 'snrN', 'snrS', 'nfN', 'nfS'];

  // What became of a burst, in the order the stacks are drawn (bottom first).
  const OUT = [
    { k: 'dec',    name: 'Decoded',              cls: 'ok', w: 'decoded' },
    { k: 'copy',   name: 'Copy',                 cls: 'cp', w: 'copy' },
    { k: 'shadow', name: 'Bit-flipped, set aside', cls: 'sh', w: 'shadow' },
    { k: 'frame',  name: 'Broken frame',         cls: 'fr', w: 'frame' },
    { k: 'chk',    name: 'Failed check',         cls: 'ck', w: 'check' },
    { k: 'und',    name: "Couldn't decode",      cls: 'un', w: 'undecoded' },
  ];

  // ── the words ─────────────────────────────────────────────────────────────

  // One list for the page: the headings, tiles, legends and the fold at the
  // foot all read their meaning from here.
  const WORDS = {
    burst: 'One radio transmission a base station picked up, whether or not anything could be read from it. One reading often arrives as several bursts: the station\'s own, and each repeater\'s copy.',
    readings: 'Bursts that decoded and were new to that base station: a value it had not already had.',
    decodedPct: 'The share of the bursts heard that decoded, new readings and copies together. The rest were set aside, broken or unreadable.',
    failed: 'Bursts that did not decode: bit-flipped shadows set aside, broken frames, failed checks and bursts nothing could be read from.',
    decoded: 'The burst decoded and gave the base station a reading it did not have yet.',
    copy: 'The burst decoded to a reading the base station already had: ALERT2 sends each message more than once, and a repeater sends a station\'s reading again.',
    shadow: 'An ALERT burst the decoder heard with a bit or two flipped, alongside a clean copy, and set aside rather than file under the wrong address.',
    frame: 'The burst started but its frame did not add up: too short, or its framing or check bytes wrong. ALERT2\'s usual failure.',
    check: 'The burst came in whole but failed its check, or the radio itself refused it.',
    undecoded: 'The base station heard energy on the channel but could not make a message of it at all. An ALERT decoder hearing ALERT2 traffic counts its bursts here.',
    signal: 'How far above the background noise the decoded bursts came in, in decibels (dB), on average. Under about 8 dB decoding starts to fail.',
    noise: 'The background hiss on the stick while it listens, in dB below the stick\'s full scale (dBFS). Higher (nearer zero) is noisier; a rise means interference near the base station.',
    channel: 'One radio frequency, in megahertz (MHz), as the base station\'s stick names it. A wide stick that hears several channels at once is put to the 12.5 kHz channel its bursts were on.',
    base: 'A receiver at a fixed site that sends what it hears to Flood-Net, named as its owner set it up. Drives and surveys are never counted here.',
    address: 'The ALERT address or ALERT2 ID a burst was sent from. ALERT addresses belong to one sensor each; ALERT2 IDs to a station.',
    addresses: 'Different ALERT addresses and ALERT2 IDs the base stations decoded three times or more in the window. Once can be a corrupted copy that passed its checks.',
    caught: 'How many of the readings from that address this base station decoded, against the base station that decoded the most of them. 100% is as good as the best-placed base station.',
    edge: 'A link near the edge: under 10 dB of signal on average, or catching under 80% of what the best-placed base station gets. Rain fade or a small change at either end can drop it.',
    onlyOne: 'Addresses only one base station decoded in the window. If that base station goes down, Flood-Net stops hearing them.',
    relayed: 'Decoded with a repeater on its path: the burst reached the base station through a repeater rather than straight from the station.',
    weakest: 'The weakest burst decoded on that link in the window, in dB above the noise.',
    rhythm: 'Bursts in each hour of the day (or each day of the week, for a long window), averaged over the window. Stations that report on a timer make a flat floor; rain makes peaks.',
    hourTally: 'The database tallies the receptions at nine minutes past each hour, so the latest hour is still filling and the last bar is short.',
    utcDay: 'A day here is a UTC day, the way the database keeps its daily tallies: 10 am to 10 am in Queensland.',
    change: 'The last seven whole days against the seven before them, for the channels the filters leave. Bursts as a percentage change; decoding in percentage points (pts).',
  };
  const word = k => WORDS[k] || '';
  const term = (text, k) => termHtml(text, word(k));
  const GLOSSARY = [
    ['burst', 'Burst'], ['readings', 'Readings'], ['decodedPct', 'Decoded (%)'], ['failed', "Didn't decode"],
    ['decoded', 'Decoded (an outcome)'], ['copy', 'Copy'], ['shadow', 'Bit-flipped, set aside'], ['frame', 'Broken frame'],
    ['check', 'Failed check'], ['undecoded', "Couldn't decode"], ['signal', 'Signal'], ['noise', 'Noise floor'],
    ['channel', 'Channel'], ['base', 'Base station'], ['address', 'Address'], ['addresses', 'Addresses heard'],
    ['caught', 'Caught'], ['weakest', 'Weakest'], ['relayed', 'Relayed'], ['edge', 'Near the edge'], ['onlyOne', 'Heard by one base station only'],
    ['rhythm', 'The day\'s rhythm'], ['change', 'Week on week'], ['hourTally', 'The latest hour'], ['utcDay', 'A day'],
  ];

  // ── state ─────────────────────────────────────────────────────────────────

  const S = {
    days: 7, base: 'all', prot: 'both', chan: 'all',
    split: 'p', heat: 'n',
    bm: 'n', bx: 't', bc: 'p', bf: 'none', bv: 'chart',
    phase: 'idle', err: '', missing: false, demo: false, note: '',
    D: null, L: null, W: null, cache: new Map(), weekAt: 0,
    seq: 0, loadedAt: 0, readWin: false, tips: [], table: null, bound: false, rt: 0,
  };

  function readLS(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
  const stations = () => (typeof state !== 'undefined' && state.data && state.data.stations) || [];

  // ── reading the answers ───────────────────────────────────────────────────

  // 151.55 → '151.550', 151.5375 → '151.5375'; null → '' (channel not known).
  function chKey(v) {
    if (v == null || v === '') return '';
    const n = Number(v);
    if (!isFinite(n)) return '';
    let s = n.toFixed(4);
    if (s.endsWith('0')) s = s.slice(0, -1);
    return s;
  }
  const chName = k => k ? `${k} MHz` : 'Channel not known';

  function blankAcc(nx) { const a = {}; for (const f of FIELDS) a[f] = new Float64Array(nx); return a; }

  function parseTraffic(raw) {
    const cols = (raw && raw.cols) || [];
    const ix = c => cols.indexOf(c);
    const I = { t: ix('t'), base: ix('base'), ch: ix('channel'), p: ix('protocol'), n: ix('n'), dec: ix('decoded'), copy: ix('copies'),
      shadow: ix('shadow'), und: ix('undecoded'), frame: ix('frame'), chk: ix('check'), other: ix('other'),
      snrN: ix('snr_n'), snrS: ix('snr_sum'), nfN: ix('nf_n'), nfS: ix('nf_sum') };
    const v = (r, i) => (i < 0 ? 0 : Number(r[i]) || 0);
    const rows = ((raw && raw.rows) || []).map(r => ({
      t: v(r, I.t) * 1000, base: String(r[I.base] || '—'), ch: chKey(r[I.ch]),
      p: PROT_NAME[r[I.p]] ? r[I.p] : 'other',
      n: v(r, I.n), dec: v(r, I.dec), copy: v(r, I.copy), shadow: v(r, I.shadow),
      und: v(r, I.und) + v(r, I.other), frame: v(r, I.frame), chk: v(r, I.chk),
      snrN: v(r, I.snrN), snrS: v(r, I.snrS), nfN: v(r, I.nfN), nfS: v(r, I.nfS),
    }));
    const grain = raw && raw.grain === 'day' ? DAY : HOUR;
    const to = Date.parse(raw && raw.to) || Date.now();
    let from = Date.parse(raw && raw.from);
    if (!isFinite(from)) from = rows.length ? Math.min(...rows.map(r => r.t)) : to - grain;
    const nb = Math.max(1, Math.ceil((to - from) / grain));
    // Colours follow the thing, ranked once by traffic over the whole window,
    // so a filter never repaints what is left.
    const rank = key => {
      const tot = new Map();
      for (const r of rows) tot.set(r[key], (tot.get(r[key]) || 0) + r.n);
      return [...tot.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    };
    const chanRank = rank('ch'), baseRank = rank('base');
    const bases = [...baseRank].sort((a, b) => a.localeCompare(b));
    const chans = [...chanRank].sort((a, b) => (a === '' ? 1e9 : Number(a)) - (b === '' ? 1e9 : Number(b)));
    const prots = PROT_ORDER.filter(p => rows.some(r => r.p === p));
    return { grain, from, to, nb, days: raw && raw.days, rows, bases, chans, prots, chanRank, baseRank };
  }

  function parseLinks(raw) {
    const cols = (raw && raw.cols) || [];
    const ix = c => cols.indexOf(c);
    const I = { base: ix('base'), p: ix('protocol'), addr: ix('address'), ch: ix('channel'), st: ix('station_id'),
      dec: ix('decoded'), copy: ix('copies'), rel: ix('relayed'), snrN: ix('snr_n'), snrS: ix('snr_sum'),
      snrMin: ix('snr_min'), snrMax: ix('snr_max'), days: ix('days'), last: ix('last_heard') };
    const v = (r, i) => (i < 0 ? 0 : Number(r[i]) || 0);
    const rows = ((raw && raw.rows) || []).map(r => ({
      base: String(r[I.base] || '—'), p: PROT_NAME[r[I.p]] ? r[I.p] : 'other', addr: v(r, I.addr), ch: chKey(r[I.ch]),
      st: I.st < 0 ? null : (r[I.st] || null), dec: v(r, I.dec), copy: v(r, I.copy), rel: v(r, I.rel),
      snrN: v(r, I.snrN), snrS: v(r, I.snrS), snrMin: I.snrMin < 0 || r[I.snrMin] == null ? NaN : Number(r[I.snrMin]),
      snrMax: I.snrMax < 0 || r[I.snrMax] == null ? NaN : Number(r[I.snrMax]), days: v(r, I.days), last: v(r, I.last) * 1000,
    }));
    // The best-placed base station for each address: the most decoded.
    const best = new Map();
    for (const r of rows) {
      const k = r.p + ':' + r.addr;
      best.set(k, Math.max(best.get(k) || 0, r.dec + r.copy));
    }
    for (const r of rows) {
      const b = best.get(r.p + ':' + r.addr) || 0;
      r.caught = b ? 100 * (r.dec + r.copy) / b : NaN;
      r.snr = r.snrN ? r.snrS / r.snrN : NaN;
    }
    return { days: raw && raw.days, rows };
  }

  // ── filters and sums ──────────────────────────────────────────────────────

  const pass = r => (S.base === 'all' || r.base === S.base) && (S.prot === 'both' || r.p === S.prot) && (S.chan === 'all' || r.ch === S.chan);
  const rows = () => (S.D ? S.D.rows.filter(pass) : []);

  // Sum rows into groups by key, along x. xFn returns -1 to leave a row out.
  function roll(list, keyFn, xFn, nx) {
    const g = new Map();
    for (const r of list) {
      const x = xFn(r);
      if (x < 0 || x >= nx) continue;
      const k = keyFn(r);
      let a = g.get(k);
      if (!a) { a = blankAcc(nx); g.set(k, a); }
      for (const f of FIELDS) a[f][x] += r[f];
    }
    return g;
  }
  const one = () => 'all';
  const xTime = r => Math.floor((r.t - S.D.from) / S.D.grain);
  const xHod = r => (S.D.grain === HOUR ? new Date(r.t).getHours() : new Date(r.t).getUTCDay());
  const nHod = () => (S.D.grain === HOUR ? 24 : 7);

  const M = {
    n:    { name: 'Bursts', count: true, w: 'burst', v: (a, i) => a.n[i] },
    rd:   { name: 'Readings', count: true, w: 'readings', v: (a, i) => a.dec[i] },
    okp:  { name: 'Decoded %', unit: '%', w: 'decodedPct', v: (a, i) => (a.n[i] ? 100 * (a.dec[i] + a.copy[i]) / a.n[i] : NaN) },
    fail: { name: "Didn't decode %", unit: '%', w: 'failed', v: (a, i) => (a.n[i] ? 100 * (a.n[i] - a.dec[i] - a.copy[i]) / a.n[i] : NaN) },
    snr:  { name: 'Signal', unit: ' dB', w: 'signal', v: (a, i) => (a.snrN[i] ? a.snrS[i] / a.snrN[i] : NaN) },
    nf:   { name: 'Noise floor', unit: ' dBFS', w: 'noise', v: (a, i) => (a.nfN[i] ? a.nfS[i] / a.nfN[i] : NaN) },
  };

  // The three things a chart can be split by.
  const chanCls = k => { const i = S.D ? S.D.chanRank.indexOf(k) : -1; return i >= 0 && i < SLOTS ? 'c' + (i + 1) : 'co'; };
  const baseCls = k => { const i = S.D ? S.D.baseRank.indexOf(k) : -1; return i >= 0 && i < SLOTS ? 'b' + (i + 1) : 'co'; };
  const chanFold = k => (chanCls(k) === 'co' ? '~other' : k);
  const baseFold = k => (baseCls(k) === 'co' ? '~other' : k);
  const DIM = {
    p: { key: r => r.p, name: k => PROT_NAME[k], cls: k => PROT_CLS[k], order: ks => PROT_ORDER.filter(p => ks.includes(p)) },
    c: { key: r => chanFold(r.ch), name: k => (k === '~other' ? 'Other channels' : chName(k)), cls: k => (k === '~other' ? 'co' : chanCls(k)),
         order: ks => ks.slice().sort((a, b) => rankOf(S.D.chanRank, a) - rankOf(S.D.chanRank, b)) },
    b: { key: r => baseFold(r.base), name: k => (k === '~other' ? 'Other base stations' : k), cls: k => (k === '~other' ? 'co' : baseCls(k)),
         order: ks => ks.slice().sort((a, b) => rankOf(S.D.baseRank, a) - rankOf(S.D.baseRank, b)) },
  };
  function rankOf(list, k) { const i = list.indexOf(k); return k === '~other' ? 1e6 : i < 0 ? 1e5 : i; }

  // Series to draw: one per key of the dimension, or one per outcome.
  function series(dim, g, mk) {
    if (dim === 'o') {
      const a = g.get('all');
      return a ? OUT.map(o => ({ name: o.name, cls: o.cls, w: o.w, vals: Array.from(a.n, (_, i) => a[o.k][i]) })) : [];
    }
    if (dim === 'none') {
      const a = g.get('all');
      return a ? [{ name: M[mk].name, cls: 'acc', vals: Array.from(a.n, (_, i) => M[mk].v(a, i)) }] : [];
    }
    const D = DIM[dim];
    return D.order([...g.keys()]).map(k => ({ key: k, name: D.name(k), cls: D.cls(k), vals: Array.from(g.get(k).n, (_, i) => M[mk].v(g.get(k), i)) }));
  }

  // ── formatting ────────────────────────────────────────────────────────────

  function fmtN(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
    return (a < 10 && v % 1 ? v.toFixed(1) : Math.round(v).toLocaleString('en-AU'));
  }
  function fmtU(v, u) {
    if (!isFinite(v)) return '—';
    if (u === '%') return v.toFixed(1) + '%';
    if (u === ' dB' || u === ' dBFS') return v.toFixed(1) + u;
    return fmtN(v);
  }
  const pct = (a, b) => (b ? (100 * a / b) : NaN);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = n => String(n).padStart(2, '0');
  function bucketLabel(i) {
    const t = S.D.from + i * S.D.grain;
    if (S.D.grain === DAY) { const d = new Date(t); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
    const d = new Date(t);
    return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}, ${two(d.getHours())}:00–${two((d.getHours() + 1) % 24)}:00`;
  }
  function timeTicks() {
    const D = S.D, out = [];
    for (let i = 0; i < D.nb; i++) {
      const t = D.from + i * D.grain;
      if (D.grain === HOUR) {
        const d = new Date(t), h = d.getHours();
        if (D.nb <= 30 ? h % 3 === 0 : D.nb <= 80 ? h % 12 === 0 : h === 0) out.push([i, h === 0 && D.nb > 30 ? `${DOW[d.getDay()]} ${d.getDate()}` : `${two(h)}:00`]);
      } else {
        const d = new Date(t), back = D.nb - 1 - i;
        if (D.nb <= 40 ? back % 5 === 0 : D.nb <= 120 ? back % 14 === 0 : d.getUTCDate() === 1) out.push([i, `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`]);
      }
    }
    return out;
  }
  const hodLabel = i => (S.D.grain === HOUR ? `${two(i)}:00–${two((i + 1) % 24)}:00` : DOW[i]);
  const hodTicks = () => (S.D.grain === HOUR ? [0, 6, 12, 18].map(h => [h, `${two(h)}:00`]) : DOW.map((d, i) => [i, d]));
  function clock(t) { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; }

  // ── drawing (SVG as text, drawn after the page is in place) ───────────────

  function tip(html) { S.tips.push(html); return S.tips.length - 1; }
  function tipRows(title, list) {
    return `<b>${esc(title)}</b>` + list.map(r => `<span class="tm-tip-r"><span>${r.cls ? `<i class="tm-sw tm-bg-${r.cls}"></i>` : ''}${esc(r.name)}</span><span>${esc(r.val)}</span></span>`).join('');
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const e = 10 ** Math.floor(Math.log10(v)), m = v / e;
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => m <= x + 1e-9) * e;
  }
  const r1 = v => Math.round(v * 10) / 10;
  function width(id) { const el = document.getElementById(id); return el ? Math.max(260, Math.floor(el.clientWidth || 0) || 900) : 900; }
  function put(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
  function svgOpen(W, H, aria) { return `<svg class="tm-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">`; }

  // Stacked bars. groups: [{ name, cls, vals }].
  function bars({ id, nx, groups, ticks, label, pctMode = false, yMax, H = 200, unit = '', aria }) {
    const W = width(id), Lm = 48, R = 6, T = 8, B = 22, pw = W - Lm - R, ph = H - T - B;
    const tot = new Float64Array(nx);
    for (const g of groups) for (let i = 0; i < nx; i++) tot[i] += g.vals[i] || 0;
    const ymax = pctMode ? 100 : (yMax || niceMax(Math.max(0, ...tot)));
    const bw = pw / nx, gap = bw > 8 ? 2 : bw > 3.5 ? 1 : 0, bwid = Math.max(0.6, bw - gap);
    let s = svgOpen(W, H, aria).replace('class="tm-svg"', `class="tm-svg${bw > 3 ? ' tm-gap' : ''}"`);
    for (const f of [0, 0.5, 1]) {
      const y = r1(T + ph - f * ph);
      s += `<line class="${f ? 'tm-grid' : 'tm-axis'}" x1="${Lm}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
      s += `<text x="${Lm - 6}" y="${y + 4}" text-anchor="end">${pctMode ? Math.round(f * 100) + '%' : esc(fmtN(f * ymax))}</text>`;
    }
    for (let i = 0; i < nx; i++) {
      let y = T + ph;
      const x = r1(Lm + i * bw + gap / 2);
      const scale = pctMode ? (tot[i] ? 100 / tot[i] : 0) : 1;
      for (const g of groups) {
        const v = (g.vals[i] || 0) * scale;
        if (!(v > 0)) continue;
        const h = v / ymax * ph;
        y -= h;
        s += `<rect class="tm-seg tm-f-${g.cls}" x="${x}" y="${r1(y)}" width="${r1(bwid)}" height="${r1(Math.max(0.5, h))}"/>`;
      }
      const list = groups.filter(g => g.vals[i]).slice().reverse().map(g => ({ name: g.name, cls: g.cls,
        val: pctMode ? (tot[i] ? (100 * g.vals[i] / tot[i]).toFixed(1) + '%' : '—') : fmtU(g.vals[i], unit) }));
      if (groups.length > 1) list.push({ name: pctMode ? 'Bursts' : 'All', cls: '', val: fmtU(tot[i], pctMode ? '' : unit) });
      s += `<rect class="tm-hit" data-tip="${tip(tipRows(label(i), list.length ? list : [{ name: 'Nothing heard', cls: '', val: '' }]))}" x="${r1(Lm + i * bw)}" y="${T}" width="${r1(bw)}" height="${ph}"/>`;
    }
    for (const [i, t] of ticks) s += `<text x="${r1(Lm + (i + 0.5) * bw)}" y="${H - 6}" text-anchor="middle">${esc(t)}</text>`;
    put(id, s + '</svg>');
  }

  // Lines along time or hour; dots over categories. NaN breaks a line.
  function lines({ id, nx, groups, ticks, label, unit = '', H = 170, dots = false, range, aria }) {
    const W = width(id), Lm = 48, R = 6, T = 8, B = 22, pw = W - Lm - R, ph = H - T - B;
    let lo = Infinity, hi = -Infinity;
    for (const g of groups) for (const v of g.vals) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (range) [lo, hi] = range(lo, hi);
    else { const p = (hi - lo) * 0.12 || 1; lo = Math.floor(lo - p); hi = Math.ceil(hi + p); }
    if (hi <= lo) hi = lo + 1;
    const ys = v => r1(T + ph - (v - lo) / (hi - lo) * ph);
    const bw = pw / nx, xs = i => r1(Lm + (i + 0.5) * bw);
    let s = svgOpen(W, H, aria);
    for (const f of [0, 0.5, 1]) {
      const v = lo + f * (hi - lo), y = ys(v);
      s += `<line class="${f ? 'tm-grid' : 'tm-axis'}" x1="${Lm}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
      s += `<text x="${Lm - 6}" y="${y + 4}" text-anchor="end">${unit === '%' ? Math.round(v) + '%' : Math.round(v)}</text>`;
    }
    groups.forEach((g, gi) => {
      if (dots) {
        const off = groups.length > 1 ? (gi - (groups.length - 1) / 2) * Math.min(10, bw / (groups.length + 1)) : 0;
        g.vals.forEach((v, i) => { if (isFinite(v)) s += `<circle class="tm-dot tm-f-${g.cls}" cx="${r1(xs(i) + off)}" cy="${ys(v)}" r="5"/>`; });
        return;
      }
      let d = '', pen = false, lone = [];
      g.vals.forEach((v, i) => {
        if (!isFinite(v)) { pen = false; return; }
        const nextOk = i + 1 < g.vals.length && isFinite(g.vals[i + 1]);
        if (!pen && !nextOk) lone.push(i);
        d += `${pen ? 'L' : 'M'}${xs(i)} ${ys(v)}`;
        pen = true;
      });
      if (d) s += `<path class="tm-line tm-st-${g.cls}" d="${d}"/>`;
      lone.forEach(i => { s += `<circle class="tm-f-${g.cls}" cx="${xs(i)}" cy="${ys(g.vals[i])}" r="2.5"/>`; });
    });
    for (let i = 0; i < nx; i++) {
      s += `<rect class="tm-hit" data-tip="${tip(tipRows(label(i), groups.map(g => ({ name: g.name, cls: g.cls, val: fmtU(g.vals[i], unit) }))))}" x="${r1(Lm + i * bw)}" y="${T}" width="${r1(bw)}" height="${ph}"/>`;
    }
    for (const [i, t] of ticks) s += `<text x="${xs(i)}" y="${H - 6}" text-anchor="middle">${esc(t)}</text>`;
    put(id, s + '</svg>');
  }

  function legendHtml(groups) {
    if (!groups || groups.length < 2) return '';
    return `<ul class="tm-legend" aria-label="Key">${groups.map(g => `<li><i class="tm-sw tm-bg-${g.cls}"></i>${g.w ? term(g.name, g.w) : esc(g.name)}</li>`).join('')}</ul>`;
  }

  // ── the panels ────────────────────────────────────────────────────────────

  function totals() {
    const list = rows();
    const a = roll(list, one, () => 0, 1).get('all') || blankAcc(1);
    const byP = roll(list, r => r.p, () => 0, 1), byC = roll(list, r => r.ch, () => 0, 1);
    const n = a.n[0], ok = a.dec[0] + a.copy[0];
    let busy = null, weak = null;
    for (const [k, c] of byC) {
      if (!busy || c.n[0] > busy[1].n[0]) busy = [k, c];
      if (c.n[0] >= Math.max(20, 0.02 * n) && (!weak || (c.dec[0] + c.copy[0]) / c.n[0] < (weak[1].dec[0] + weak[1].copy[0]) / weak[1].n[0])) weak = [k, c];
    }
    const a1 = byP.get('alert') ? byP.get('alert').n[0] : 0, a2 = byP.get('alert2') ? byP.get('alert2').n[0] : 0;
    const addrs = S.L ? new Set(S.L.rows.filter(pass).map(r => r.p + ':' + r.addr)).size : null;
    return { n, ok, dec: a.dec[0], fail: n - ok, a1, a2, addrs, busy, weak,
      snr: a.snrN[0] ? a.snrS[0] / a.snrN[0] : NaN };
  }

  function tilesHtml() {
    const t = totals();
    const tile = (v, label) => `<div class="tm-tile"><span class="tm-tile-n">${esc(v)}</span><span class="tm-tile-l">${label}</span></div>`;
    return `<div class="tm-tiles" data-tour="tm-tiles">
      ${tile(fmtN(t.n), `${term('Bursts', 'burst')} heard`)}
      ${tile(fmtN(t.dec), term('Readings', 'readings'))}
      ${tile(t.n ? pct(t.ok, t.n).toFixed(1) + '%' : '—', term('Decoded', 'decodedPct'))}
      ${tile(fmtN(t.fail), `${term("Didn't decode", 'failed')}${t.n ? ` (${pct(t.fail, t.n).toFixed(1)}%)` : ''}`)}
      ${tile(t.a1 + t.a2 ? `${Math.round(pct(t.a1, t.a1 + t.a2))} : ${Math.round(pct(t.a2, t.a1 + t.a2))}` : '—', 'ALERT : ALERT2, % of bursts')}
      ${tile(t.addrs == null ? '…' : fmtN(t.addrs), term('Addresses heard', 'addresses'))}
      ${tile(t.busy ? (t.busy[0] || 'not known') : '—', `Busiest ${term('channel', 'channel')}, MHz`)}
      ${tile(t.weak ? (t.weak[0] || 'not known') : '—', `Weakest decoding${t.weak ? `, ${pct(t.weak[1].dec[0] + t.weak[1].copy[0], t.weak[1].n[0]).toFixed(0)}%` : ''}`)}
    </div>`;
  }

  function seg(key, opts, label, fn = 'set') {
    return `<div class="tm-seg-row" role="group" aria-label="${esc(label)}"><span class="tm-seg-l" aria-hidden="true">${esc(label)}</span>
      ${opts.map(([v, text, dis]) => `<button type="button" class="hl-chip${S[key] === v ? ' hl-chip--on' : ''}" aria-pressed="${S[key] === v}"${dis ? ' disabled' : ''}
        onclick="Telemetry.${fn}('${key}','${v}')">${esc(text)}</button>`).join('')}</div>`;
  }

  function controlsHtml() {
    const D = S.D;
    const opt = (v, text, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(text)}</option>`;
    const bases = D ? D.bases : [], chans = D ? D.chans : [];
    return `<div class="tm-controls" data-tour="tm-filters">
      <div class="tm-seg-row" role="group" aria-label="Window"><span class="tm-seg-l" aria-hidden="true">Window</span>
        ${WINDOWS.map(([d, l]) => `<button type="button" class="hl-chip${S.days === d ? ' hl-chip--on' : ''}" aria-pressed="${S.days === d}" onclick="Telemetry.setDays(${d})">${esc(l)}</button>`).join('')}</div>
      ${seg('prot', [['both', 'Both'], ['alert', 'ALERT'], ['alert2', 'ALERT2']], 'Protocol', 'filter')}
      <div class="control-row tm-selects">
        <label>${term('Base station', 'base')}
          <select id="tm-base" onchange="Telemetry.filter('base', this.value)">${opt('all', 'All base stations', S.base === 'all')}${bases.map(b => opt(b, b, S.base === b)).join('')}</select></label>
        <label>${term('Channel', 'channel')}
          <select id="tm-chan" onchange="Telemetry.filter('chan', this.value)">${opt('all', 'All channels', S.chan === 'all')}${chans.map(c => opt(c, chName(c), S.chan === c)).join('')}</select></label>
        <button type="button" class="btn" onclick="Telemetry.refresh()"${S.phase === 'loading' ? ' disabled' : ''} title="Read the tallies again now">↻ Refresh</button>
      </div>
    </div>`;
  }

  function statusHtml() {
    if (!S.D) return '';
    const D = S.D;
    const when = S.demo ? '<b>A demo:</b> made-up numbers on made-up base stations — nothing here is about the real network.'
      : `Read at ${esc(clock(S.loadedAt))} from the database's ${D.grain === HOUR ? 'hourly' : 'daily'} tallies.`;
    const grain = D.grain === HOUR ? term('The latest hour is still filling.', 'hourTally') : term('A day is a UTC day.', 'utcDay');
    const busy = S.phase === 'loading' ? ' <span role="status">Reading…</span>' : '';
    const empty = D.rows.length ? '' : ' <span class="txt-warn">No named base station reported anything in this window.</span>';
    const left = D.rows.length && !rows().length ? ' <span class="txt-warn">Nothing is left by the filters.</span>' : '';
    return `<p class="small txt-muted" id="tm-status">${when} ${grain}${busy}${empty}${left}${S.note ? ` <span class="txt-warn">${esc(S.note)}</span>` : ''}</p>`;
  }

  function panel(id, title, intro, body, tour) {
    return `<section class="panel tm-panel" aria-labelledby="tm-h-${id}"${tour ? ` data-tour="${tour}"` : ''}>
      <div class="panel-header"><h2 id="tm-h-${id}">${title}</h2></div>
      ${intro ? `<p class="small txt-muted tm-intro">${intro}</p>` : ''}
      ${body}
    </section>`;
  }

  function trafficPanel() {
    return panel('traffic', 'Traffic over time',
      `Every ${term('burst', 'burst')} the base stations heard, stacked. Split it the way you want to compare.`,
      `${seg('split', [['p', 'Protocol'], ['c', 'Channel'], ['b', 'Base station'], ['o', 'Outcome']], 'Split by')}
       <div id="tm-traffic-key"></div><div class="tm-chart" id="tm-traffic"></div>`, 'tm-traffic');
  }
  function qualityPanel() {
    return panel('quality', 'Quality over time',
      'What became of the bursts, as a share of everything heard, and how strongly they came in.',
      `<div id="tm-quality-key"></div><div class="tm-chart" id="tm-quality"></div>
       <h3 class="tm-sub">${term('Signal', 'signal')}, each base station</h3>
       <div id="tm-snr-key"></div><div class="tm-chart" id="tm-snr"></div>`, 'tm-quality');
  }
  function comparePanel() { return panel('compare', 'ALERT and ALERT2 side by side', 'The same window and filters, measure by measure.', '<div id="tm-compare"></div>'); }
  function rhythmPanel() {
    const hourly = !S.D || S.D.grain === HOUR;
    return panel('rhythm', hourly ? 'The day\'s rhythm' : 'The week\'s rhythm',
      `${term(hourly ? 'Bursts in each hour of the day' : 'Bursts on each day of the week', 'rhythm')}, averaged over the window.`,
      '<div id="tm-rhythm-key"></div><div class="tm-chart" id="tm-rhythm"></div>');
  }
  function heatPanel() {
    return panel('heat', 'Channels over time',
      `One row a ${term('channel', 'channel')}; darker is more. Colour it by the share that did not decode to see where trouble sits, in time and frequency at once.`,
      `${seg('heat', [['n', 'Bursts'], ['fail', "Share that didn't decode"]], 'Colour by')}
       <div class="tm-chart tm-scroll" id="tm-heat" role="region" aria-label="Channels over time — scrolls sideways on a narrow screen" tabindex="0"></div>`, 'tm-heat');
  }
  function multiPanel() {
    return panel('multi', 'Base stations side by side',
      'The same chart for each base station, on the same scale, so a glance says which hears most and when one went quiet.',
      '<div id="tm-multi-key"></div><div class="tm-multi" id="tm-multi"></div>');
  }
  function builderPanel() {
    const outOk = S.bm === 'n';
    return panel('builder', 'Chart builder',
      'For the layered questions: pick what to show, what runs along the bottom, what the colours are and what goes side by side. Every filter above still applies.',
      `<div class="tm-builder-ctl">
        ${seg('bm', [['n', 'Bursts'], ['rd', 'Readings'], ['okp', 'Decoded %'], ['fail', "Didn't decode %"], ['snr', 'Signal'], ['nf', 'Noise floor']], 'Show', 'build')}
        ${seg('bx', [['t', 'Time'], ['hod', S.D && S.D.grain === DAY ? 'Day of week' : 'Hour of day'], ['c', 'Channel'], ['b', 'Base station']], 'Along', 'build')}
        ${seg('bc', [['none', 'None'], ['p', 'Protocol'], ['c', 'Channel'], ['b', 'Base station'], ['o', 'Outcome', !outOk]], 'Coloured by', 'build')}
        ${seg('bf', [['none', 'None'], ['b', 'Base station'], ['p', 'Protocol'], ['c', 'Channel']], 'Side by side', 'build')}
        <div class="tm-seg-row">${seg('bv', [['chart', 'Chart'], ['table', 'Table']], 'View', 'build')}
          <button type="button" class="btn" onclick="Telemetry.exportCsv()">⤓ CSV</button></div>
        <p class="small txt-warn" id="tm-bnote" hidden></p>
      </div>
      <div id="tm-builder-key"></div><div id="tm-builder"></div>
      <p class="small txt-muted">Try: Decoded %, along Time, coloured by Channel, side by side by Base station. Or: Bursts, along Hour of day, coloured by Outcome.</p>`, 'tm-builder');
  }
  function whoPanel() {
    return panel('who', 'Who hears what',
      `${term('Bursts', 'burst')} each ${term('base station', 'base')} heard on each channel, and the share decoded. A dot is a channel that base station did not hear.`,
      '<div id="tm-who"></div><p class="small" id="tm-only"></p>');
  }
  function edgePanel() {
    return panel('edge', 'Links near the edge',
      `One dot for each ${term('address', 'address')} a base station decodes: how strong against how much of it gets through. The shaded corner is ${term('near the edge', 'edge')}.`,
      `<div id="tm-edge-key"></div><div class="tm-chart" id="tm-scatter"></div><div id="tm-weak"></div>`, 'tm-edge');
  }
  function wowPanel() {
    return panel('wow', 'Week on week',
      `${term('Each channel\'s last seven days against the seven before', 'change')}: how much more or less it carried, and whether more or less of it decoded.`,
      `<div class="tm-two"><div><h3 class="tm-sub">Bursts, change</h3><div class="tm-chart" id="tm-wow-n"></div></div>
        <div><h3 class="tm-sub">Decoded, change in percentage points</h3><div class="tm-chart" id="tm-wow-ok"></div></div></div>`);
  }

  function glossaryHtml() {
    return `<details class="tm-fold" data-k="words"><summary><h2 class="tm-fold-h" id="tm-h-words">What the words on this page mean</h2></summary>
      <dl class="tm-words">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(word(k))}</dd>`).join('')}</dl>
    </details>`;
  }
  function numbersHtml() {
    return `<details class="tm-fold" data-k="numbers" ontoggle="Telemetry.numbersToggled(this.open)"><summary><h2 class="tm-fold-h" id="tm-h-numbers">The numbers behind the charts</h2></summary>
      <div id="tm-numbers"></div>
      <p><button type="button" class="btn" onclick="Telemetry.exportTraffic()">⤓ The tallies, as filtered — CSV</button>
        <button type="button" class="btn" onclick="Telemetry.exportLinks()">⤓ The links, as filtered — CSV</button></p>
    </details>`;
  }
  function howHtml() {
    return `<details class="tm-fold" data-k="how"><summary><h2 class="tm-fold-h" id="tm-h-how">Where the numbers come from</h2></summary>
      <ul class="small">
        <li>Each base station sends Flood-Net every burst it hears. The database keeps an hourly and a daily tally of them, kept for good, and this tab reads those tallies — never the big table of every copy — so it stays light on the database.</li>
        <li>Only base stations with a name on file are counted, and never a drive or a site survey. Nothing here says where a receiver is or which stick it is.</li>
        <li>Up to a week is read by the hour; longer windows by the day. A day is a UTC day (10 am to 10 am in Queensland).</li>
        <li>The channel is the frequency the base station's stick names. A stick that hears several channels at once is put to the channel its bursts were on, or "Channel not known" when one tally spans two.</li>
        <li>Who hears what and the links count an address only once it has been decoded three times in the window: once can be a corrupted copy that passed its checks.</li>
      </ul>
    </details>`;
  }

  // ── render ────────────────────────────────────────────────────────────────

  function render() {
    let body = '';
    if (S.phase === 'error' && !S.D) {
      body = S.missing
        ? `<p class="txt-warn" role="alert">The database does not have the Telemetry summary yet (migration 0123). Once it is applied, this tab fills itself.</p>
           <p><button type="button" class="btn" onclick="Telemetry.refresh()">Try again</button> <button type="button" class="btn" onclick="Telemetry.demo()">Show a demo</button></p>`
        : `<p class="txt-bad" role="alert">${esc(S.err)}</p>
           <p><button type="button" class="btn" onclick="Telemetry.refresh()">Try again</button> <button type="button" class="btn" onclick="Telemetry.demo()">Show a demo</button></p>`;
    } else if (!S.D) {
      body = `<p class="small" role="status">Reading what the base stations heard in the last ${esc(winLabel(S.days).toLowerCase())}…</p>`;
    } else {
      body = `${statusHtml()}${tilesHtml()}`;
    }
    return `
    <div class="page tm-page" style="--page-max:1240px">
      <section class="panel" aria-labelledby="tm-h-top">
        <div class="panel-header"><h2 id="tm-h-top">Telemetry</h2>${S.demo ? '<span class="tm-demo-chip">Demo</span>' : ''}</div>
        <p class="small txt-muted">What the named base stations hear: how much comes in, how much of it decodes, ALERT against ALERT2, channel against channel and base station against base station.
          Point at a bar for its numbers; the tables are under <b>The numbers behind the charts</b> at the foot of the page.</p>
        ${controlsHtml()}
        ${body}
      </section>
      ${S.D ? `
      ${trafficPanel()}
      ${qualityPanel()}
      <div class="tm-two">${comparePanel()}${rhythmPanel()}</div>
      ${heatPanel()}
      ${multiPanel()}
      ${builderPanel()}
      ${whoPanel()}
      ${edgePanel()}
      ${wowPanel()}
      ${numbersHtml()}
      ${glossaryHtml()}
      ${howHtml()}` : glossaryHtml()}
      <div class="tm-tip" id="tm-tip" hidden></div>
    </div>`;
  }
  const winLabel = d => (WINDOWS.find(w => w[0] === d) || [d, `${d} days`])[1];

  function host() { return typeof state !== 'undefined' && state.activeTab === 'telemetry' ? document.getElementById('main-content') : null; }
  function redraw() {
    const el = host();
    if (!el) return;
    const y = typeof window !== 'undefined' ? window.scrollY : 0;
    const open = [...el.querySelectorAll('details[data-k]')].filter(d => d.open).map(d => d.dataset.k);
    el.innerHTML = render();
    open.forEach(k => { const d = el.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; });
    draw();
    if (y && window.scrollTo) window.scrollTo(0, y);
  }

  // Everything drawn to the width it has, once the page is in place.
  function draw() {
    if (!S.D || !host()) return;
    S.tips = [];
    drawTraffic(); drawQuality(); drawCompare(); drawRhythm(); drawHeat(); drawMulti(); drawBuilder(); drawWho(); drawEdge(); drawWow();
    const nums = document.querySelector('.tm-page details[data-k="numbers"]');
    if (nums && nums.open) drawNumbers();
  }

  function drawTraffic() {
    const D = S.D, dim = S.split;
    const g = roll(rows(), dim === 'o' ? one : DIM[dim].key, xTime, D.nb);
    const gs = series(dim, g, 'n');
    const t = totals();
    put('tm-traffic-key', legendHtml(gs));
    bars({ id: 'tm-traffic', nx: D.nb, groups: gs, ticks: timeTicks(), label: bucketLabel, H: 220,
      aria: `Bursts heard over the ${winLabel(S.days).toLowerCase()}: ${fmtN(t.n)} in all, ${gs.length > 1 ? `split by ${({ p: 'protocol', c: 'channel', b: 'base station', o: 'outcome' })[dim]}` : 'one series'}.` });
  }

  function drawQuality() {
    const D = S.D;
    const g = roll(rows(), one, xTime, D.nb);
    const gs = series('o', g);
    const t = totals();
    put('tm-quality-key', legendHtml(gs));
    bars({ id: 'tm-quality', nx: D.nb, groups: gs, ticks: timeTicks(), label: bucketLabel, pctMode: true, H: 170,
      aria: `What became of the bursts, as shares over time: ${t.n ? pct(t.ok, t.n).toFixed(1) : 0}% decoded over the window.` });
    const gb = roll(rows(), DIM.b.key, xTime, D.nb);
    const ls = series('b', gb, 'snr');
    put('tm-snr-key', legendHtml(ls));
    lines({ id: 'tm-snr', nx: D.nb, groups: ls, ticks: timeTicks(), label: bucketLabel, unit: ' dB', H: 150,
      aria: `Mean signal of the decoded bursts, each base station, over time: ${isFinite(t.snr) ? t.snr.toFixed(1) + ' dB over the window' : 'none recorded'}.` });
  }

  function drawCompare() {
    const list = S.D.rows.filter(r => (S.base === 'all' || r.base === S.base) && (S.chan === 'all' || r.ch === S.chan));
    const g = roll(list, r => r.p, () => 0, 1);
    const A = g.get('alert') || blankAcc(1), B = g.get('alert2') || blankAcc(1);
    const share = (a, k) => pct(a[k][0], a.n[0]);
    const lk = S.L ? S.L.rows.filter(r => (S.base === 'all' || r.base === S.base) && (S.chan === 'all' || r.ch === S.chan)) : [];
    const addrs = p => new Set(lk.filter(r => r.p === p).map(r => r.addr)).size;
    const chans = p => new Set(list.filter(r => r.p === p && r.n).map(r => r.ch)).size;
    const ROWS = [
      [term('Bursts heard', 'burst'), a => a.n[0], fmtN],
      [term('Readings', 'readings'), a => a.dec[0], fmtN],
      [term('Decoded', 'decodedPct'), a => pct(a.dec[0] + a.copy[0], a.n[0]), v => fmtU(v, '%')],
      [term('Copies', 'copy'), a => pct(a.copy[0], a.dec[0] + a.copy[0]), v => isFinite(v) ? v.toFixed(0) + '% of decoded' : '—'],
      [term('Bit-flipped, set aside', 'shadow'), a => share(a, 'shadow'), v => fmtU(v, '%')],
      [term('Broken frame', 'frame'), a => share(a, 'frame'), v => fmtU(v, '%')],
      [term('Failed check', 'check'), a => share(a, 'chk'), v => fmtU(v, '%')],
      [term("Couldn't decode", 'undecoded'), a => share(a, 'und'), v => fmtU(v, '%')],
      [term('Mean signal', 'signal'), a => (a.snrN[0] ? a.snrS[0] / a.snrN[0] : NaN), v => fmtU(v, ' dB')],
      [term('Noise floor', 'noise'), a => (a.nfN[0] ? a.nfS[0] / a.nfN[0] : NaN), v => fmtU(v, ' dBFS')],
    ];
    const bar = (v, m, cls) => (isFinite(v) && m > 0 ? `<span class="tm-bar tm-bg-${cls}" style="--w:${Math.max(2, Math.round(100 * Math.abs(v) / m))}%"></span>` : '');
    let body = '';
    const row = (label, va, vb, f) => {
      const m = Math.max(isFinite(va) ? Math.abs(va) : 0, isFinite(vb) ? Math.abs(vb) : 0);
      body += `<tr><th scope="row">${label}</th><td class="num">${esc(f(va))}</td><td class="tm-barcell">${bar(va, m, 'p1')}</td><td class="num">${esc(f(vb))}</td><td class="tm-barcell">${bar(vb, m, 'p2')}</td></tr>`;
    };
    for (const [label, fn, f] of ROWS) row(label, fn(A), fn(B), f);
    row(term('Addresses heard', 'addresses'), S.L ? addrs('alert') : NaN, S.L ? addrs('alert2') : NaN, v => isFinite(v) ? String(v) : '…');
    row(term('Channels used', 'channel'), chans('alert'), chans('alert2'), String);
    put('tm-compare', `<div class="table-wrap"><table class="tm-cmp"><caption>ALERT and ALERT2, ${esc(winLabel(S.days).toLowerCase())}${S.base !== 'all' ? `, ${esc(S.base)}` : ''}${S.chan !== 'all' ? `, ${esc(chName(S.chan))}` : ''}</caption>
      <thead><tr><th scope="col">Measure</th><th scope="col" class="num">ALERT</th><th scope="col"><span class="sr-only">ALERT, drawn</span></th><th scope="col" class="num">ALERT2</th><th scope="col"><span class="sr-only">ALERT2, drawn</span></th></tr></thead>
      <tbody>${body}</tbody></table></div>`);
  }

  function drawRhythm() {
    const D = S.D, nx = nHod();
    const g = roll(rows(), r => r.p, xHod, nx);
    // Average per day: how many of each hour (or weekday) the window holds.
    const seen = new Float64Array(nx);
    for (let i = 0; i < D.nb; i++) seen[xHod({ t: D.from + i * D.grain })]++;
    const gs = series('p', g, 'n').map(s => ({ ...s, vals: s.vals.map((v, i) => (seen[i] ? v / seen[i] : 0)) }));
    put('tm-rhythm-key', legendHtml(gs));
    bars({ id: 'tm-rhythm', nx, groups: gs, ticks: hodTicks(), label: i => `${hodLabel(i)}, on average`, H: 190,
      aria: `Bursts in each ${D.grain === HOUR ? 'hour of the day' : 'day of the week'}, averaged over the window.` });
  }

  function drawHeat() {
    const D = S.D, id = 'tm-heat';
    const g = roll(rows(), r => r.ch, xTime, D.nb);
    const keys = D.chans.filter(k => g.has(k) && g.get(k).n.some(v => v));
    const W = Math.max(560, width(id)), rowH = 22, Lm = 118, T = 4, B = 22, H = T + Math.max(1, keys.length) * rowH + B;
    const pw = W - Lm - 6, bw = pw / D.nb;
    let max = 0;
    for (const k of keys) for (const v of g.get(k).n) max = Math.max(max, v);
    let s = svgOpen(W, H, `Bursts on each channel over time, ${keys.length} channels; ${S.heat === 'n' ? 'darker is more' : 'darker is a larger share that did not decode'}.`);
    keys.forEach((k, ri) => {
      const a = g.get(k), y = T + ri * rowH;
      s += `<text x="${Lm - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(k ? k + ' MHz' : 'not known')}</text>`;
      for (let i = 0; i < D.nb; i++) {
        const n = a.n[i], fail = n ? (n - a.dec[i] - a.copy[i]) / n : 0;
        const tval = S.heat === 'n' ? Math.sqrt(n / (max || 1)) : Math.min(1, fail / 0.3);
        const cls = !n ? 'none' : S.heat === 'n' ? 'seq' : 'hot';
        s += `<rect class="tm-f-${cls}" x="${r1(Lm + i * bw)}" y="${y + 1}" width="${r1(Math.max(0.6, bw - (bw > 4 ? 1 : 0)))}" height="${rowH - 2}"${n ? ` fill-opacity="${(0.1 + 0.9 * tval).toFixed(3)}"` : ''}
          data-tip="${tip(tipRows(`${chName(k)} · ${bucketLabel(i)}`, [
            { name: 'Bursts', cls: 'seq', val: fmtN(n) },
            { name: 'Decoded', cls: 'ok', val: fmtU(pct(a.dec[i] + a.copy[i], n), '%') },
            { name: "Didn't decode", cls: 'hot', val: fmtU(n ? 100 * fail : NaN, '%') },
            { name: 'Signal', cls: '', val: fmtU(M.snr.v(a, i), ' dB') }]))}"/>`;
      }
    });
    for (const [i, t] of timeTicks()) s += `<text x="${r1(Lm + (i + 0.5) * bw)}" y="${H - 6}" text-anchor="middle">${esc(t)}</text>`;
    put(id, keys.length ? s + '</svg>' : '<p class="small txt-muted">Nothing heard for these filters.</p>');
  }

  function drawMulti() {
    const D = S.D;
    const bs = D.bases.filter(b => S.base === 'all' || b === S.base);
    const per = bs.map(b => {
      const list = rows().filter(r => r.base === b);
      return { b, list, gs: series('p', roll(list, r => r.p, xTime, D.nb), 'n'), tot: roll(list, one, () => 0, 1).get('all') };
    }).filter(x => x.tot && x.tot.n[0]);
    let ymax = 0;
    for (const x of per) for (let i = 0; i < D.nb; i++) ymax = Math.max(ymax, x.gs.reduce((s, g) => s + (g.vals[i] || 0), 0));
    ymax = niceMax(ymax);
    put('tm-multi-key', legendHtml(per[0] ? per[0].gs : []));
    put('tm-multi', per.length ? per.map((x, j) => `<div><h3 class="tm-sub">${esc(x.b)}</h3><div class="tm-chart" id="tm-m${j}"></div><p class="small txt-muted" id="tm-mc${j}"></p></div>`).join('')
      : '<p class="small txt-muted">Nothing heard for these filters.</p>');
    const ticks = timeTicks();
    per.forEach((x, j) => {
      bars({ id: 'tm-m' + j, nx: D.nb, groups: x.gs, ticks: ticks.filter((_, k) => ticks.length < 6 || k % 2 === 0), label: i => `${x.b} · ${bucketLabel(i)}`, yMax: ymax, H: 150,
        aria: `${x.b}: ${fmtN(x.tot.n[0])} bursts over the window.` });
      const chs = new Set(x.list.filter(r => r.n).map(r => r.ch)).size;
      const ad = S.L ? new Set(S.L.rows.filter(r => pass(r) && r.base === x.b).map(r => r.p + ':' + r.addr)).size : null;
      put('tm-mc' + j, `${fmtN(x.tot.n[0])} bursts · decoded ${fmtU(pct(x.tot.dec[0] + x.tot.copy[0], x.tot.n[0]), '%')} · ${chs} channel${chs === 1 ? '' : 's'}${ad == null ? '' : ` · ${ad} addresses`}`);
    });
  }

  // ── the builder ───────────────────────────────────────────────────────────

  function drawBuilder() {
    const D = S.D, note = document.getElementById('tm-bnote');
    const msgs = [];
    if (S.bc === 'o' && S.bm !== 'n') { S.bc = 'none'; msgs.push('Outcome colours split Bursts only, so the colours are off for this measure.'); }
    if (S.bc === S.bx) { S.bc = 'none'; msgs.push('The colours and the bottom of the chart were the same thing, so the colours are off.'); }
    if (S.bf !== 'none' && (S.bf === S.bx || S.bf === S.bc)) { S.bf = 'none'; msgs.push('Side by side was already in use, so it is off.'); }
    if (note) { note.hidden = !msgs.length; note.textContent = msgs.join(' '); }
    if (msgs.length) syncChips();
    const m = M[S.bm];
    const xCats = S.bx === 'c' ? D.chans : S.bx === 'b' ? D.bases : null;
    const nx = S.bx === 't' ? D.nb : S.bx === 'hod' ? nHod() : xCats.length;
    const xf = S.bx === 't' ? xTime : S.bx === 'hod' ? xHod : S.bx === 'c' ? (r => xCats.indexOf(r.ch)) : (r => xCats.indexOf(r.base));
    const facetKeys = S.bf === 'none' ? [null] : S.bf === 'p' ? D.prots : S.bf === 'b' ? D.bases : D.chans;
    const facetKey = S.bf === 'p' ? (r => r.p) : S.bf === 'b' ? (r => r.base) : (r => r.ch);
    const facetName = fv => (fv === null ? '' : S.bf === 'p' ? PROT_NAME[fv] : S.bf === 'b' ? fv : chName(fv));
    // Count measures along the hour of day are a day's average.
    const seen = new Float64Array(S.bx === 'hod' ? nHod() : 0);
    if (S.bx === 'hod') for (let i = 0; i < D.nb; i++) seen[xHod({ t: D.from + i * D.grain })]++;
    let panels = facetKeys.map(fv => {
      const list = rows().filter(r => fv === null || facetKey(r) === fv);
      const g = roll(list, S.bc === 'none' || S.bc === 'o' ? one : DIM[S.bc].key, xf, nx);
      let gs = series(S.bc, g, S.bm);
      if (S.bx === 'hod' && m.count) gs = gs.map(s => ({ ...s, vals: s.vals.map((v, i) => (seen[i] ? v / seen[i] : 0)) }));
      return { fv, gs };
    }).filter(p => p.gs.some(g => g.vals.some(v => isFinite(v) && v)));
    // One set of series for every side, in one order, so the colours, the
    // table's columns and the CSV's line up across the sides.
    const union = [], seenK = new Set(), idOf = g => (g.key !== undefined ? 'k:' + g.key : 'n:' + g.name);
    for (const p of panels) for (const g of p.gs) if (!seenK.has(idOf(g))) { seenK.add(idOf(g)); union.push(g); }
    if (DIM[S.bc]) { const ord = DIM[S.bc].order(union.map(g => g.key)); union.sort((a, b) => ord.indexOf(a.key) - ord.indexOf(b.key)); }
    panels = panels.map(p => ({ ...p, gs: union.map(u => p.gs.find(g => idOf(g) === idOf(u)) || { ...u, vals: new Array(nx).fill(m.count ? 0 : NaN) }) }));
    // Categories with nothing in them leave the axis.
    let keep = [...Array(nx).keys()];
    if (xCats) keep = keep.filter(i => panels.some(p => p.gs.some(g => isFinite(g.vals[i]) && g.vals[i])));
    panels = panels.map(p => ({ ...p, gs: xCats ? p.gs.map(g => ({ ...g, vals: keep.map(i => g.vals[i]) })) : p.gs }));
    const nxs = xCats ? keep.length : nx;
    const xLabel = j => (S.bx === 't' ? bucketLabel(j) : S.bx === 'hod' ? hodLabel(j) : S.bx === 'c' ? chName(xCats[keep[j]]) : xCats[keep[j]]);
    const ticks = S.bx === 't' ? timeTicks() : S.bx === 'hod' ? hodTicks() : keep.map((i, j) => [j, S.bx === 'c' ? (xCats[i] || '?') : xCats[i]]);
    S.table = { panels, xLabel, nxs, m, facetName };
    put('tm-builder-key', legendHtml(panels[0] ? panels[0].gs.map(g => ({ ...g, w: g.w || (S.bc === 'none' ? m.w : '') })) : []));
    const hostEl = document.getElementById('tm-builder');
    if (!hostEl) return;
    if (S.bv === 'table') { hostEl.className = ''; hostEl.innerHTML = builderTableHtml(); return; }
    if (!panels.length) { hostEl.className = ''; hostEl.innerHTML = '<p class="small txt-muted">Nothing heard for this choice.</p>'; return; }
    hostEl.className = panels.length > 1 ? 'tm-multi' : '';
    hostEl.innerHTML = panels.map((p, j) => `<div>${p.fv === null ? '' : `<h3 class="tm-sub">${esc(facetName(p.fv))}</h3>`}<div class="tm-chart" id="tm-bp${j}"></div></div>`).join('');
    let ymax = 0, lo = Infinity, hi = -Infinity;
    for (const p of panels) {
      if (m.count) for (let i = 0; i < nxs; i++) ymax = Math.max(ymax, p.gs.reduce((s, g) => s + (g.vals[i] || 0), 0));
      else for (const g of p.gs) for (const v of g.vals) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    panels.forEach((p, j) => {
      const label = i => (p.fv === null ? '' : facetName(p.fv) + ' · ') + xLabel(i);
      const H = panels.length > 1 ? 160 : 230;
      const aria = `${m.name}${S.bc !== 'none' ? `, coloured by ${({ p: 'protocol', c: 'channel', b: 'base station', o: 'outcome' })[S.bc]}` : ''}, along ${({ t: 'time', hod: S.D.grain === HOUR ? 'the hour of day' : 'the day of week', c: 'channel', b: 'base station' })[S.bx]}${p.fv === null ? '' : `, ${facetName(p.fv)}`}.`;
      if (m.count) bars({ id: 'tm-bp' + j, nx: nxs, groups: p.gs, ticks, label, yMax: niceMax(ymax), H, unit: '', aria });
      else {
        const pad = (hi - lo) * 0.1 || 1;
        const range = m.unit === '%' ? () => [Math.max(0, Math.floor((lo - pad) / 5) * 5), 100] : () => [Math.floor(lo - pad), Math.ceil(hi + pad)];
        lines({ id: 'tm-bp' + j, nx: nxs, groups: p.gs, ticks, label, unit: m.unit, H, dots: !!xCats, range, aria });
      }
    });
  }

  function builderTableHtml() {
    const T = S.table;
    if (!T || !T.panels.length) return '<p class="small txt-muted">Nothing heard for this choice.</p>';
    const side = S.bf !== 'none';
    const cols = T.panels[0].gs;
    let body = '', n = 0, all = 0;
    for (const p of T.panels) for (let i = 0; i < T.nxs; i++) {
      all++;
      if (n >= TABLE_MAX) continue;
      n++;
      body += `<tr>${side ? `<td>${esc(T.facetName(p.fv))}</td>` : ''}<th scope="row">${esc(T.xLabel(i))}</th>${p.gs.map(g => `<td class="num">${esc(fmtU(g.vals[i], T.m.unit))}</td>`).join('')}</tr>`;
    }
    return `<div class="table-wrap medium" role="region" aria-label="The chart builder's numbers" tabindex="0"><table class="tm-table"><caption>${esc(T.m.name)}${T.m.count && S.bx === 'hod' ? ', a day on average' : ''}</caption>
      <thead><tr>${side ? '<th scope="col">Side</th>' : ''}<th scope="col">Along</th>${cols.map(g => `<th scope="col" class="num">${esc(g.name)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>${all > n ? `<p class="small txt-muted">The first ${TABLE_MAX} rows of ${all.toLocaleString('en-AU')}; ⤓ CSV has them all.</p>` : ''}`;
  }

  // ── who hears what, the links, week on week ───────────────────────────────

  function drawWho() {
    const D = S.D;
    const list = S.D.rows.filter(r => (S.prot === 'both' || r.p === S.prot));
    const g = roll(list, r => r.base + '|' + r.ch, () => 0, 1);
    const chs = D.chans.filter(c => (S.chan === 'all' || c === S.chan) && D.bases.some(b => g.has(b + '|' + c)));
    const bs = D.bases.filter(b => S.base === 'all' || b === S.base);
    let max = 0;
    for (const [, a] of g) max = Math.max(max, a.n[0]);
    let body = '';
    for (const b of bs) {
      body += `<tr><th scope="row">${esc(b)}</th>` + chs.map(c => {
        const a = g.get(b + '|' + c);
        if (!a || !a.n[0]) return '<td class="tm-cell txt-muted">·</td>';
        const q = Math.min(4, Math.floor(4 * Math.sqrt(a.n[0] / (max || 1)) + 0.5));
        return `<td class="tm-cell tm-q${q}">${esc(fmtN(a.n[0]))}<small>${esc(fmtU(pct(a.dec[0] + a.copy[0], a.n[0]), '%'))} decoded</small></td>`;
      }).join('') + '</tr>';
    }
    put('tm-who', chs.length && bs.length ? `<div class="table-wrap"><table class="tm-who"><caption>Bursts and the share decoded, base station by channel (MHz)</caption>
      <thead><tr><th scope="col">Base station</th>${chs.map(c => `<th scope="col" class="tm-cell">${esc(c || 'not known')}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`
      : '<p class="small txt-muted">Nothing heard for these filters.</p>');
    const el = document.getElementById('tm-only');
    if (!el) return;
    if (!S.L) { el.textContent = 'Reading which addresses each base station hears…'; return; }
    const lk = S.L.rows.filter(r => (S.prot === 'both' || r.p === S.prot) && (S.chan === 'all' || r.ch === S.chan));
    const by = new Map();
    for (const r of lk) { const k = r.p + ':' + r.addr; if (!by.has(k)) by.set(k, new Set()); by.get(k).add(r.base); }
    const only = new Map();
    for (const [, set] of by) if (set.size === 1) { const b = [...set][0]; only.set(b, (only.get(b) || 0) + 1); }
    el.innerHTML = `${term('Addresses only one base station hears', 'onlyOne')}: ${D.bases.filter(b => S.base === 'all' || b === S.base).map(b => `<b>${esc(b)}</b> ${only.get(b) || 0}`).join(' · ') || 'none'}.`;
  }

  function stationName(id) {
    if (!id) return '';
    const s = stations().find(x => x.id === id);
    return s ? s.name : id;
  }
  const addrLabel = r => `${PROT_NAME[r.p]} ${r.p === 'alert2' ? 'ID' : 'address'} ${r.addr}`;

  function drawEdge() {
    const id = 'tm-scatter';
    if (!S.L) { put(id, '<p class="small txt-muted">Reading which addresses each base station hears…</p>'); put('tm-weak', ''); put('tm-edge-key', ''); return; }
    const list = S.L.rows.filter(pass).filter(r => isFinite(r.snr) && isFinite(r.caught));
    const W = width(id), H = 270, Lm = 48, R = 10, T = 8, B = 36, pw = W - Lm - R, ph = H - T - B;
    const xmax = Math.max(30, Math.ceil(Math.max(0, ...list.map(r => r.snr)) / 10) * 10);
    const xs = v => r1(Lm + Math.max(0, Math.min(xmax, v)) / xmax * pw), ys = v => r1(T + ph - (Math.max(0, Math.min(100, v)) / 100) * ph);
    let s = svgOpen(W, H, `${list.length} links: each address a base station decodes, mean signal against the share caught; ${list.filter(near).length} near the edge.`);
    s += `<path class="tm-f-edge" d="M${xs(0)} ${ys(100)} L${xs(10)} ${ys(100)} L${xs(10)} ${ys(80)} L${xs(xmax)} ${ys(80)} L${xs(xmax)} ${ys(0)} L${xs(0)} ${ys(0)} Z"/>`;
    s += `<text x="${xs(0) + 6}" y="${ys(0) - 6}">near the edge</text>`;
    for (const v of [0, 50, 100]) s += `<line class="${v ? 'tm-grid' : 'tm-axis'}" x1="${Lm}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text x="${Lm - 6}" y="${ys(v) + 4}" text-anchor="end">${v}%</text>`;
    for (let v = 0; v <= xmax; v += 10) s += `<text x="${xs(v)}" y="${H - 20}" text-anchor="middle">${v}</text>`;
    s += `<text x="${Lm + pw / 2}" y="${H - 4}" text-anchor="middle">Signal, dB above the noise</text>`;
    s += `<text x="${Lm + 4}" y="${T + 12}">Caught</text>`;
    const bs = new Set();
    for (const r of list) {
      bs.add(r.base);
      const nm = stationName(r.st);
      s += `<circle class="tm-dot tm-f-${baseCls(r.base)}" cx="${xs(r.snr)}" cy="${ys(r.caught)}" r="5" data-tip="${tip(tipRows(`${addrLabel(r)}${nm ? ` · ${nm}` : ''}`, [
        { name: r.base, cls: baseCls(r.base), val: r.ch ? r.ch + ' MHz' : '' },
        { name: 'Signal, mean', cls: '', val: fmtU(r.snr, ' dB') },
        { name: 'Weakest', cls: '', val: fmtU(r.snrMin, ' dB') },
        { name: 'Caught', cls: '', val: fmtU(r.caught, '%') },
        { name: 'Decoded', cls: '', val: fmtN(r.dec + r.copy) },
        { name: 'Days heard', cls: '', val: String(r.days) }]))}"/>`;
    }
    put(id, list.length ? s + '</svg>' : '<p class="small txt-muted">No address decoded three times for these filters.</p>');
    put('tm-edge-key', legendHtml(S.D.baseRank.filter(b => bs.has(b)).map(b => ({ name: b, cls: baseCls(b) }))));
    // The weakest links as a table: the same dots, one activation away.
    const weak = list.filter(near).sort((a, b) => a.snr - b.snr).slice(0, 15);
    put('tm-weak', weak.length ? `<div class="table-wrap"><table class="tm-table"><caption>The links nearest the edge, weakest first (${list.filter(near).length} of ${list.length})</caption>
      <thead><tr><th scope="col">${term('Address', 'address')}</th><th scope="col">Station</th><th scope="col">${term('Base station', 'base')}</th><th scope="col" class="num">${term('Signal', 'signal')}</th>
        <th scope="col" class="num">${term('Weakest', 'weakest')}</th><th scope="col" class="num">${term('Caught', 'caught')}</th><th scope="col" class="num">${term('Relayed', 'relayed')}</th></tr></thead>
      <tbody>${weak.map(r => `<tr><th scope="row">${esc(addrLabel(r))}</th><td>${esc(stationName(r.st) || '—')}</td><td>${esc(r.base)}</td><td class="num">${esc(fmtU(r.snr, ' dB'))}</td>
        <td class="num">${esc(fmtU(r.snrMin, ' dB'))}</td><td class="num">${esc(fmtU(r.caught, '%'))}</td><td class="num">${esc(fmtU(pct(r.rel, r.dec + r.copy), '%'))}</td></tr>`).join('')}</tbody></table></div>`
      : (list.length ? '<p class="small txt-ok">No link is near the edge for these filters.</p>' : ''));
  }
  const near = r => r.snr < 10 || r.caught < 80;

  function drawWow() {
    const W = S.W, idN = 'tm-wow-n', idO = 'tm-wow-ok';
    if (!W || W.nb < 8) { put(idN, '<p class="small txt-muted">Reading the last fortnight…</p>'); put(idO, ''); return; }
    // The last whole day is the one before today's (still filling).
    const lastHi = W.nb - 1, lastLo = lastHi - 7, prevLo = Math.max(0, lastLo - 7);
    const list = W.rows.filter(pass);
    const at = r => Math.floor((r.t - W.from) / W.grain);
    const last = roll(list, r => r.ch, r => (at(r) >= lastLo && at(r) < lastHi ? 0 : -1), 1);
    const prev = roll(list, r => r.ch, r => (at(r) >= prevLo && at(r) < lastLo ? 0 : -1), 1);
    const keys = W.chans.filter(k => last.has(k) && prev.has(k) && last.get(k).n[0] && prev.get(k).n[0]);
    const draw = (id, vals, unit, aria) => {
      // Room either side of the bars for the change written beside them.
      const rowH = 22, Lm = 104, R = 70, gapL = 70, H = keys.length * rowH + 6;
      const Wd = width(id), m = Math.max(...vals.map(Math.abs), 1e-9), mid = Lm + gapL + (Wd - Lm - R - gapL) / 2, half = (Wd - Lm - R - gapL) / 2;
      let s = svgOpen(Wd, H, aria) + `<line class="tm-axis" x1="${r1(mid)}" x2="${r1(mid)}" y1="0" y2="${H}"/>`;
      keys.forEach((k, i) => {
        const v = vals[i], y = i * rowH + 4, w = Math.abs(v) / m * half, up = v >= 0;
        const txt = `${up ? '+' : '−'}${Math.abs(v).toFixed(1)}${unit}`;
        s += `<text x="${Lm - 8}" y="${y + 13}" text-anchor="end">${esc(k ? k + ' MHz' : 'not known')}</text>`;
        s += `<rect class="tm-f-${up ? 'up' : 'down'}" x="${r1(up ? mid : mid - w)}" y="${y}" width="${r1(Math.max(1, w))}" height="${rowH - 8}" rx="3"
          data-tip="${tip(tipRows(`${chName(k)}: the last 7 days against the 7 before`, [{ name: 'Change', cls: up ? 'up' : 'down', val: txt }]))}"/>`;
        s += `<text x="${r1(up ? mid + w + 5 : mid - w - 5)}" y="${y + 12}" text-anchor="${up ? 'start' : 'end'}">${esc(txt)}</text>`;
      });
      put(id, keys.length ? s + '</svg>' : '<p class="small txt-muted">Not enough of the fortnight for these filters.</p>');
    };
    const okShare = a => 100 * (a.dec[0] + a.copy[0]) / a.n[0];
    draw(idN, keys.map(k => 100 * (last.get(k).n[0] / prev.get(k).n[0] - 1)), '%', 'Each channel\'s bursts, last seven days against the seven before, as a percentage change.');
    draw(idO, keys.map(k => okShare(last.get(k)) - okShare(prev.get(k))), ' pts', 'Each channel\'s decoded share, last seven days against the seven before, in percentage points.');
  }

  function drawNumbers() {
    const D = S.D;
    const g = roll(rows(), one, xTime, D.nb).get('all') || blankAcc(D.nb);
    const gp = roll(rows(), r => r.p, xTime, D.nb);
    const A = gp.get('alert'), B = gp.get('alert2');
    let body = '', n = 0;
    for (let i = D.nb - 1; i >= 0 && n < TABLE_MAX; i--, n++) {
      body += `<tr><th scope="row">${esc(bucketLabel(i))}</th><td class="num">${esc(fmtN(g.n[i]))}</td><td class="num">${esc(fmtN(A ? A.n[i] : 0))}</td><td class="num">${esc(fmtN(B ? B.n[i] : 0))}</td>
        <td class="num">${esc(fmtN(g.dec[i]))}</td><td class="num">${esc(fmtU(pct(g.dec[i] + g.copy[i], g.n[i]), '%'))}</td><td class="num">${esc(fmtU(M.snr.v(g, i), ' dB'))}</td><td class="num">${esc(fmtU(M.nf.v(g, i), ' dBFS'))}</td></tr>`;
    }
    put('tm-numbers', `<div class="table-wrap medium" role="region" aria-label="The numbers behind the charts" tabindex="0"><table class="tm-table"><caption>${D.grain === HOUR ? 'Each hour' : 'Each day'}, newest first, as filtered${D.nb > TABLE_MAX ? ` — the newest ${TABLE_MAX} of ${D.nb}` : ''}</caption>
      <thead><tr><th scope="col">${D.grain === HOUR ? 'Hour' : term('Day', 'utcDay')}</th><th scope="col" class="num">${term('Bursts', 'burst')}</th><th scope="col" class="num">ALERT</th><th scope="col" class="num">ALERT2</th>
        <th scope="col" class="num">${term('Readings', 'readings')}</th><th scope="col" class="num">${term('Decoded', 'decodedPct')}</th><th scope="col" class="num">${term('Signal', 'signal')}</th><th scope="col" class="num">${term('Noise floor', 'noise')}</th></tr></thead>
      <tbody>${body}</tbody></table></div>`);
  }

  // ── reading ───────────────────────────────────────────────────────────────

  const isMissing = e => !!e && (e.code === 'PGRST202' || /Could not find the function/i.test(e.message || '') || (e.status === 404 && !e.code));

  async function load(force) {
    const days = S.days, my = ++S.seq;
    const key = String(days);
    const hit = S.cache.get(key);
    const fresh = hit && Date.now() - hit.at < CACHE_MS;
    if (fresh && !force) {
      S.D = hit.D; S.L = hit.L; S.phase = 'ready'; S.demo = false; S.loadedAt = hit.at;
      redraw();
      if (!S.W || Date.now() - S.weekAt > CACHE_MS) loadWeek(my);
      return;
    }
    S.phase = 'loading'; S.err = ''; S.missing = false; S.note = '';
    redraw();
    try {
      const raw = await dbRpc('telemetry_traffic', { p_days: days, p_hourly: days <= HOURLY_MAX });
      if (my !== S.seq) return;
      S.demo = false; S.D = parseTraffic(raw); S.L = null; S.phase = 'ready'; S.loadedAt = Date.now();
      keepFilters();
      redraw();
      announce(`Telemetry: ${fmtN(totals().n)} bursts in the last ${winLabel(days).toLowerCase()}.`);
    } catch (e) {
      if (my !== S.seq) return;
      S.phase = 'error'; S.err = (e && e.message) || 'The datastore did not answer.'; S.missing = isMissing(e);
      if (S.D) S.note = `Could not read the ${winLabel(days).toLowerCase()}: ${S.err}`;
      redraw();
      return;
    }
    try {
      const lr = await dbRpc('telemetry_links', { p_days: Math.min(days, 90) });
      if (my !== S.seq) return;
      S.L = parseLinks(lr);
      S.cache.set(key, { D: S.D, L: S.L, at: S.loadedAt });
      redraw();
    } catch (e) {
      if (my !== S.seq) return;
      S.L = parseLinks(null); S.note = `The links could not be read: ${(e && e.message) || 'no answer'}`;
      redraw();
    }
    if (!S.W || force || Date.now() - S.weekAt > CACHE_MS) loadWeek(my);
  }
  async function loadWeek(my) {
    try {
      const raw = await dbRpc('telemetry_traffic', { p_days: 15, p_hourly: false });
      if (my !== S.seq || S.demo) return;
      S.W = parseTraffic(raw); S.weekAt = Date.now();
      if (host()) drawWowOnly();
    } catch (_) { /* the panel says it is still reading; Refresh asks again */ }
  }
  function drawWowOnly() { if (S.D && host()) drawWow(); }

  // A base station or channel picked that the new window does not hold.
  function keepFilters() {
    if (!S.D) return;
    if (S.base !== 'all' && !S.D.bases.includes(S.base)) { S.note = `${S.base} heard nothing in this window, so the base station filter is off.`; S.base = 'all'; }
    if (S.chan !== 'all' && !S.D.chans.includes(S.chan)) { S.note = `${chName(S.chan)} carried nothing in this window, so the channel filter is off.`; S.chan = 'all'; }
  }

  // ── controls ──────────────────────────────────────────────────────────────

  function setDays(d) {
    const n = Number(d);
    S.days = WINDOWS.some(w => w[0] === n) ? n : 7;
    writeLS(WIN_KEY, String(S.days));
    if (S.demo) { adoptDemo(); return; }
    load();
  }
  function filter(key, v) {
    if (!['base', 'prot', 'chan'].includes(key)) return;
    S[key] = v; S.note = '';
    redraw();
  }
  function set(key, v) {
    if (!['split', 'heat'].includes(key)) return;
    S[key] = v;
    syncChips();
    draw();
  }
  function build(key, v) {
    if (!['bm', 'bx', 'bc', 'bf', 'bv'].includes(key)) return;
    S[key] = v;
    const opt = document.querySelector('.tm-page [aria-label="Coloured by"] button[onclick*="\'o\'"]');
    if (opt) opt.disabled = S.bm !== 'n';
    syncChips();
    draw();
  }
  function syncChips() {
    for (const grp of document.querySelectorAll('.tm-page .tm-seg-row[role="group"]')) {
      for (const b of grp.querySelectorAll('button[onclick]')) {
        const m = /Telemetry\.(?:set|build|filter)\('(\w+)','([^']*)'\)/.exec(b.getAttribute('onclick') || '');
        if (!m) continue;
        const on = S[m[1]] === m[2];
        b.classList.toggle('hl-chip--on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    }
  }
  function refresh() {
    if (S.demo) { S.demo = false; S.D = null; S.L = null; S.W = null; }
    S.cache.clear();
    load(true);
  }
  function numbersToggled(open) { if (open && S.D) drawNumbers(); }

  // ── files ─────────────────────────────────────────────────────────────────

  const stamp = () => new Date().toISOString().slice(0, 10);
  function exportCsv() {
    const T = S.table;
    if (!T || !T.panels.length) return;
    const side = S.bf !== 'none';
    const head = [...(side ? ['side'] : []), 'along', ...T.panels[0].gs.map(g => g.name)];
    const lines = [head.map(csvEscape).join(',')];
    for (const p of T.panels) for (let i = 0; i < T.nxs; i++) {
      lines.push([...(side ? [T.facetName(p.fv)] : []), T.xLabel(i), ...p.gs.map(g => (isFinite(g.vals[i]) ? Math.round(g.vals[i] * 100) / 100 : ''))].map(csvEscape).join(','));
    }
    dlText(`floodnet-telemetry-${S.bm}-${stamp()}.csv`, lines.join('\n') + '\n');
  }
  function exportTraffic() {
    if (!S.D) return;
    const head = ['start_utc', 'base_station', 'channel_mhz', 'protocol', 'bursts', 'readings', 'copies', 'bitflip_set_aside', 'broken_frame', 'failed_check', 'could_not_decode', 'signal_db_mean', 'noise_floor_dbfs_mean'];
    const out = [head.join(',')];
    for (const r of rows()) {
      out.push([new Date(r.t).toISOString(), r.base, r.ch, PROT_NAME[r.p], r.n, r.dec, r.copy, r.shadow, r.frame, r.chk, r.und,
        r.snrN ? (r.snrS / r.snrN).toFixed(1) : '', r.nfN ? (r.nfS / r.nfN).toFixed(1) : ''].map(csvEscape).join(','));
    }
    dlText(`floodnet-telemetry-tallies-${S.days}d-${stamp()}.csv`, out.join('\n') + '\n');
  }
  function exportLinks() {
    if (!S.L) return;
    const head = ['base_station', 'protocol', 'address', 'station', 'channel_mhz', 'decoded', 'copies', 'relayed', 'signal_db_mean', 'signal_db_weakest', 'signal_db_strongest', 'caught_pct', 'days_heard', 'last_heard_utc'];
    const out = [head.join(',')];
    for (const r of S.L.rows.filter(pass)) {
      out.push([r.base, PROT_NAME[r.p], r.addr, stationName(r.st), r.ch, r.dec, r.copy, r.rel, isFinite(r.snr) ? r.snr.toFixed(1) : '',
        isFinite(r.snrMin) ? r.snrMin : '', isFinite(r.snrMax) ? r.snrMax : '', isFinite(r.caught) ? r.caught.toFixed(1) : '', r.days,
        r.last ? new Date(r.last).toISOString() : ''].map(csvEscape).join(','));
    }
    dlText(`floodnet-telemetry-links-${Math.min(S.days, 90)}d-${stamp()}.csv`, out.join('\n') + '\n');
  }

  // ── the demo ──────────────────────────────────────────────────────────────

  // Made-up base stations hearing a made-up network, in the shape the
  // database answers, so every panel runs on the same code as the real thing.
  function demoRaw(days) {
    let seed = 20261112;
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const BASES = ['Demo base A', 'Demo base B', 'Demo base C'];
    const CH = [
      ['151.500', { alert: 0.9, alert2: 0.1 }, 35], ['151.525', { alert: 1 }, 43], ['151.5375', { alert: 0.12, alert2: 0.88 }, 185],
      ['151.550', { alert: 1 }, 350], ['151.575', { alert: 1 }, 276], ['152.4625', { alert2: 1 }, 90], ['173.900', { alert2: 1 }, 60], ['173.950', { alert2: 1 }, 55],
    ];
    const GAIN = [[1, 1, 1, 1, 1, 0, 0, 0], [0.6, 0.4, 0.8, 1.2, 0.9, 0.8, 1, 0], [0.25, 0.3, 0.5, 0.4, 0.6, 1.1, 0, 1]];
    const SNR0 = [[9, 11, 14, 12, 13, 0, 0, 0], [7.5, 6.5, 12, 16, 10, 13, 18, 0], [5, 5.5, 8, 6.5, 9, 15, 0, 17]];
    const NF0 = [-65.8, -67.2, -64.1];
    const hourly = days <= HOURLY_MAX;
    const now = Date.now(), H = hourly ? days * 24 : days, grain = hourly ? HOUR : DAY;
    const from = hourly ? Math.floor(now / HOUR) * HOUR - (H - 1) * HOUR : Math.floor(now / DAY) * DAY - (H - 1) * DAY;
    const hoursAgo = t => (now - t) / HOUR;
    const storm = (h, c, w, a) => a * Math.exp(-(((h - c) / w) ** 2));
    const rainAt = (t, p) => 1 + (p === 'alert' ? 1 : 0.45) * (storm(hoursAgo(t), 96, 14, 2.4) + storm(hoursAgo(t), 38 * 24, 12, 1.3) + storm(hoursAgo(t), 71 * 24, 18, 1.0));
    const out = [];
    for (let i = 0; i < H; i++) {
      const t = from + i * grain;
      for (let b = 0; b < 3; b++) for (let c = 0; c < CH.length; c++) for (const p of ['alert', 'alert2']) {
        const sh = CH[c][1][p] || 0;
        if (!sh || !GAIN[b][c]) continue;
        const ago = hoursAgo(t);
        if (b === 1 && hourly && ago > 12 * 24 - 10 && ago <= 12 * 24) continue;
        const hod = new Date(t).getHours();
        const diurnal = 1 + 0.12 * Math.sin((hod - 9) / 24 * 2 * Math.PI);
        const scale = hourly ? 1 : 24;
        const n = Math.max(0, Math.round(CH[c][2] * GAIN[b][c] * sh * (hourly ? diurnal : 1) * rainAt(t, p) * scale * (0.85 + 0.3 * rnd())));
        const hit = b === 2 && c <= 1 && ago > 16 * 24 && ago <= 20 * 24;
        const snr = SNR0[b][c] + gauss() * 1.1 - (hit ? 6 : 0) - (rainAt(t, 'alert') - 1) * 0.4;
        const pOk = Math.min(0.985, 1 / (1 + Math.exp(-(snr - 6) / 1.5)));
        const ok = Math.min(n, Math.round(n * pOk * (0.985 + 0.03 * rnd())));
        const bad = n - ok, copy = Math.round(ok * (p === 'alert' ? 0.21 : 0.33));
        const shadow = p === 'alert' ? Math.round(bad * 0.3) : 0, frame = p === 'alert2' ? Math.round(bad * 0.8) : 0;
        const und = bad - shadow - frame;
        const nf = NF0[b] + gauss() * 0.4 + (hit ? 7 : 0);
        out.push([Math.round(t / 1000), BASES[b], CH[c][0], p, n, ok - copy, copy, shadow, und, frame, 0, 0, ok, Math.round(snr * ok * 10) / 10, n, Math.round(nf * n * 10) / 10]);
      }
    }
    const traffic = { grain: hourly ? 'hour' : 'day', days, from: new Date(from).toISOString(), to: new Date(now).toISOString(),
      cols: ['t', 'base', 'channel', 'protocol', 'n', 'decoded', 'copies', 'shadow', 'undecoded', 'frame', 'check', 'other', 'snr_n', 'snr_sum', 'nf_n', 'nf_sum'], rows: out };
    const links = [];
    for (let i = 0; i < 70; i++) {
      let r = rnd() * CH.reduce((s, x) => s + x[2], 0), c = 0;
      while (r > CH[c][2]) { r -= CH[c][2]; c++; }
      const ps = Object.keys(CH[c][1]);
      const p = ps.length === 1 ? ps[0] : (rnd() < (CH[c][1].alert || 0) ? 'alert' : 'alert2');
      const addr = p === 'alert' ? 4000 + Math.floor(rnd() * 3000) : 100 + Math.floor(rnd() * 900);
      const base = 40 + Math.floor(rnd() * 400) * Math.min(days, 90);
      for (let b = 0; b < 3; b++) {
        if (!GAIN[b][c] || rnd() > 0.35 + 0.5 * GAIN[b][c]) continue;
        const snr = Math.max(1.5, Math.min(30, SNR0[b][c] + gauss() * 4));
        const got = Math.round(base * Math.min(1, 1 / (1 + Math.exp(-(snr - 6) / 1.5))));
        if (got < 3) continue;
        links.push([BASES[b], p, addr, CH[c][0], null, got, Math.round(got * 0.2), p === 'alert2' ? Math.round(got * rnd() * 0.6) : 0, got, Math.round(snr * got * 10) / 10,
          Math.round((snr - 3 - rnd() * 4) * 10) / 10, Math.round((snr + 3 + rnd() * 4) * 10) / 10, Math.min(days, 90), Math.round(now / 1000) - Math.floor(rnd() * 3600)]);
      }
    }
    return { traffic, links: { days: Math.min(days, 90), cols: ['base', 'protocol', 'address', 'channel', 'station_id', 'decoded', 'copies', 'relayed', 'snr_n', 'snr_sum', 'snr_min', 'snr_max', 'days', 'last_heard'], rows: links } };
  }
  function adoptDemo() {
    ++S.seq;
    const d = demoRaw(S.days), w = demoRaw(15);
    S.demo = true; S.D = parseTraffic(d.traffic); S.L = parseLinks(d.links); S.W = parseTraffic(w.traffic);
    S.phase = 'ready'; S.err = ''; S.missing = false; S.note = ''; S.loadedAt = Date.now();
    keepFilters();
    redraw();
  }
  function demo() { adoptDemo(); announce('Telemetry: showing a demo on made-up numbers.'); }

  // For the tests: fill the tab from what the database would have answered.
  function adopt(raw) {
    ++S.seq;
    S.demo = false; S.D = parseTraffic(raw.traffic); S.L = raw.links ? parseLinks(raw.links) : null; S.W = raw.week ? parseTraffic(raw.week) : null;
    S.phase = 'ready'; S.err = ''; S.missing = false; S.note = ''; S.loadedAt = Date.now();
    keepFilters();
    redraw();
  }

  // ── the tab ───────────────────────────────────────────────────────────────

  function onPointer(e) {
    const tipEl = document.getElementById('tm-tip');
    if (!tipEl) return;
    const t = e.target && e.target.closest ? e.target.closest('.tm-page [data-tip]') : null;
    if (!t) { tipEl.hidden = true; return; }
    const html = S.tips[Number(t.getAttribute('data-tip'))];
    if (!html) { tipEl.hidden = true; return; }
    tipEl.innerHTML = html; tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
    // As two custom properties, so the page holds no inline style but a token.
    tipEl.style.setProperty('--x', Math.round(Math.max(4, x)) + 'px');
    tipEl.style.setProperty('--y', Math.round(Math.max(4, y)) + 'px');
  }
  function onResize() { clearTimeout(S.rt); S.rt = setTimeout(() => { if (host()) draw(); }, 150); }
  function unbind() {
    if (!S.bound) return;
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('pointerdown', onPointer);
    window.removeEventListener('resize', onResize);
    clearTimeout(S.rt);
    S.bound = false;
  }

  function init() {
    if (typeof registerTabTeardown === 'function') registerTabTeardown('Telemetry', unbind);
    if (!S.bound) {
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('pointerdown', onPointer, { passive: true });
      window.addEventListener('resize', onResize);
      S.bound = true;
    }
    if (!S.readWin) {
      S.readWin = true;
      const d = Number(readLS(WIN_KEY));
      if (WINDOWS.some(w => w[0] === d) && d !== S.days) S.days = d;
    }
    const stale = !S.loadedAt || Date.now() - S.loadedAt > CACHE_MS;
    if (S.demo || S.phase === 'loading') { redraw(); return; }
    if (!S.D || stale) load();
    else redraw();
  }

  function state_() {
    return { days: S.days, base: S.base, prot: S.prot, chan: S.chan, split: S.split, heat: S.heat, bm: S.bm, bx: S.bx, bc: S.bc, bf: S.bf, bv: S.bv,
      phase: S.phase, err: S.err, missing: S.missing, demo: S.demo, note: S.note,
      grain: S.D ? (S.D.grain === HOUR ? 'hour' : 'day') : null, nb: S.D ? S.D.nb : 0,
      bases: S.D ? S.D.bases.slice() : [], chans: S.D ? S.D.chans.slice() : [], totals: S.D ? totals() : null, links: S.L ? S.L.rows.length : null };
  }

  return { render, init, load, refresh, demo, adopt, setDays, filter, set, build, numbersToggled,
    exportCsv, exportTraffic, exportLinks, state: state_, WORDS, WINDOWS };
})();
