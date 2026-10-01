// MegaNet — serial-viz.js
//
//   SerialViz   the canvas furniture the Serial Monitor's graphics share: a
//               canvas sized for the screen it is on, the theme's colours read
//               off its tokens, time and dB axes, a sparkline, and the
//               waterfall palette.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for cssVar, from inside exported functions only, so
// nothing here runs at load. serial.js, serial-radio.js and serial-sdr.js call
// it; it calls none of them.
//
// Colours come from the stylesheet's tokens at paint time, never from
// literals here, so the graphics follow the theme switch on their next frame
// and the contrast check's statements about --accent, --ok, --warn and the
// RSSI scale hold for what is drawn too. The one exception is the waterfall
// palette: a waterfall is a heat map of data, the same in both themes, and
// its colours encode magnitude rather than meaning.

const SerialViz = (function () {
  let cache = null, cacheAt = 0;

  // The theme's colours, re-read at most every 250 ms (a theme switch shows on
  // the next paint after that; reading computed style 60 times a second is not
  // free).
  function colors() {
    const now = Date.now();
    if (cache && now - cacheAt < 250) return cache;
    const v = (n, f) => (typeof cssVar === 'function' ? cssVar(n, f) : f);
    cache = {
      text: v('--text', '#16202a'), muted: v('--muted', '#4f6478'), border: v('--border', '#dde5ee'),
      panel: v('--panel', '#ffffff'), subtle: v('--subtle', '#f7fafc'), accent: v('--accent', '#0b5cab'),
      ok: v('--ok', '#107c10'), bad: v('--bad', '#c7401a'), warn: v('--warn', '#9e5e00'),
      strong: v('--rssi-strong', '#137a3b'), good: v('--rssi-good', '#5a9e18'), fair: v('--rssi-fair', '#c08a12'),
      marginal: v('--rssi-marginal', '#d4691f'), weak: v('--rssi-weak', '#b3261e'),
      addr: v('--c-addr', '#2f6fb8'), data: v('--c-data', '#2a7e4f'), ident: v('--c-ident', '#8a6300'), crc: v('--c-crc', '#6d51ad'),
    };
    cacheAt = now;
    return cache;
  }

  // Size the backing store to the element's CSS width × `cssH` CSS pixels at
  // the device pixel ratio. Width and height are attributes, not styles —
  // the stylesheet owns the box. Returns null when the canvas is not on screen.
  function fit(cv, cssH) {
    if (!cv || !cv.getContext) return null;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const cssW = Math.max(40, Math.floor(cv.clientWidth || cv.parentNode && cv.parentNode.clientWidth || 300));
    const w = Math.round(cssW * dpr), h = Math.round((cssH || cv.clientHeight || 120) * dpr);
    // The box's height is the stylesheet's, through a token (an inline token
    // override is the one inline style the design system allows).
    if (cssH && cv.style && cv.style.getPropertyValue('--ch') !== cssH + 'px') cv.style.setProperty('--ch', cssH + 'px');
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ctx, w, h, dpr };
  }

  function alpha(color, a) {
    // Mix a token colour with transparency. Tokens are #rrggbb or rgb(); the
    // canvas accepts color-mix() in current Chromium, but not everywhere.
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (m) {
      const n = parseInt(m[1], 16);
      return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    const r = /^rgba?\(([^)]+)\)$/.exec(color);
    if (r) { const p = r[1].split(',').map(s => s.trim()); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')'; }
    return color;
  }

  function hhmm(t, secs) {
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + (secs ? ':' + p(d.getSeconds()) : '');
  }

  // The colour on the RSSI scale for a fade margin or SNR in dB.
  function marginColor(db, c) {
    c = c || colors();
    if (db == null) return c.muted;
    return db >= 30 ? c.strong : db >= 20 ? c.good : db >= 10 ? c.fair : db >= 5 ? c.marginal : c.weak;
  }
  function marginClass(db) {
    if (db == null) return '';
    return db >= 30 ? 'm-strong' : db >= 20 ? 'm-good' : db >= 10 ? 'm-fair' : db >= 5 ? 'm-marginal' : 'm-weak';
  }

  // A sparkline of `vals` (oldest first) filling the canvas.
  function spark(cv, vals, opts) {
    opts = opts || {};
    const f = fit(cv, opts.height || 28);
    if (!f) return;
    const { ctx, w, h, dpr } = f, c = colors();
    ctx.clearRect(0, 0, w, h);
    const n = vals.length;
    if (!n) return;
    let max = opts.max || 0;
    for (const v of vals) if (v > max) max = v;
    if (max <= 0) max = 1;
    const bw = w / n;
    ctx.fillStyle = alpha(opts.color || c.accent, 0.75);
    for (let i = 0; i < n; i++) {
      const v = vals[i] || 0;
      if (!v) continue;
      const bh = Math.max(1 * dpr, (v / max) * (h - 2 * dpr));
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - dpr * 0.5), bh);
    }
    ctx.strokeStyle = c.border;
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(0, h - 0.5 * dpr); ctx.lineTo(w, h - 0.5 * dpr); ctx.stroke();
  }

  // A 256-entry heat palette (dark blue → cyan → yellow → white), as packed
  // RGBA for ImageData. The waterfall's, and the ADC histogram's.
  let lut = null;
  function heat() {
    if (lut) return lut;
    const stops = [[0, 6, 10, 32], [0.25, 18, 46, 130], [0.45, 14, 128, 170], [0.62, 70, 190, 120],
      [0.78, 240, 210, 60], [0.9, 250, 120, 40], [1, 255, 250, 235]];
    lut = new Uint32Array(256);
    const le = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let k = 0;
      while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[k + 1], t = (x - a[0]) / (b[0] - a[0]);
      const r = Math.round(a[1] + (b[1] - a[1]) * t), g = Math.round(a[2] + (b[2] - a[2]) * t), bl = Math.round(a[3] + (b[3] - a[3]) * t);
      lut[i] = le ? ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (bl << 8) | 255) >>> 0;
    }
    return lut;
  }

  // Horizontal dB grid lines with labels in a left gutter of `gx` pixels.
  function dbGrid(ctx, x0, y0, w, h, lo, hi, step, dpr, c) {
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = y0 + h - (v - lo) / (hi - lo) * h;
      ctx.strokeStyle = alpha(c.border, 0.9);
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x0 + w, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.fillText(String(v), x0 - 4 * dpr, y);
    }
  }

  return { colors, fit, alpha, hhmm, marginColor, marginClass, spark, heat, dbGrid };
})();
