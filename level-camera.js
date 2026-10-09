// MegaNet — level-camera.js
//
//   LevelCamera   the reading camera: point the phone at a level's display
//                 and the number on it goes into the box you tapped — read by
//                 OCR, shown to you to accept or correct — and the picture it
//                 was read from is kept beside the survey as the evidence for
//                 it. The same sheet reads a serial plate for the equipment
//                 list, and takes a photo of a point.
//
// After core.js, photo-meta.js, levelling.js and level-store.js, before
// level-survey.js, two-peg.js and level-kit, which open it — index.html holds
// the order. Reaches back to core.js for esc, announce and state; to
// photo-meta.js for PhotoMeta.ocrGrey (the session's one OCR worker); to
// level-store.js for LevelStore (where the pictures are kept); to levelling.js
// for Levelling. Everything here runs from a function; nothing at load. The
// readers of text (parseReading, parseLabel) and of pixels (tighten, otsu,
// stretch) are pure, and test/levels.mjs require()s this file to hold them.
//
// ── What is read, and what is kept ───────────────────────────────────────────
//
//   The display    The guide on the live picture is the shape of a level's
//                  screen. What is inside it (and a margin) is cut out at the
//                  camera's full resolution, then cut again to the part that
//                  has text in it — the edges of the digits, found by their
//                  contrast (tighten) — so neither the engine nor the evidence
//                  carries the instrument's casing or the paddock behind it.
//   The engine     Tesseract, the one photo-meta.js already runs for field
//                  photos, in the same worker. Three passes at most, each
//                  stopping the rest once a reading is clear: the grey
//                  picture as it is (labels like Ht, R, HD and Dist come
//                  through), then black-and-white with only digits allowed,
//                  then the same with each stroke thickened — the cure for a
//                  seven-segment display, whose segments read as gaps.
//   The numbers    A staff reading is a few metres with three to five places;
//                  a distance tens of metres with one to three. Labels win
//                  where there are any; a point lost from a faint segment is
//                  put back as a suggestion, never silently. What you accept
//                  is what goes in the box — the engine only ever suggests.
//   The evidence   The text-only crop, grey, at most 960 px across, with a
//                  strip along its foot saying what it is (the row, the sight,
//                  the value taken, when, where), saved as WebP — JPEG where
//                  the browser cannot write WebP (Safari). Typically 15 to 40
//                  kB: a hundred readings is three or four megabytes. A photo
//                  of a point is kept whole, 1600 px at most, as JPEG — a few
//                  hundred kilobytes. Both are kept on the device first
//                  (LevelStore) and go to Flood-Net with the survey.
//
// ── When there is no camera ──────────────────────────────────────────────────
// A browser that will not show the camera here (a computer, a refused
// permission) takes a picture from the phone's camera app or its gallery
// instead; you drag a box over the display, and the rest is the same.

const LevelCamera = (function () {
  const READ_MAX = 960;          // the evidence crop's long side, a reading
  const LABEL_MAX = 1280;        // …a label
  const PHOTO_MAX = 1600;        // a photo of a point
  const OCR_MAX_W = 1400;        // the widest picture handed to the engine
  const OCR_MIN_H = 120;         // …and the shortest, enlarged to it
  const GUIDE_ASPECT = { reading: 3, label: 2 };
  const MARGIN = 0.06;           // around the guide, cut with it

  // ── Reading numbers out of text (pure) ─────────────────────────────────────

  // The engine's usual confusions, undone where a character sits among digits.
  const LOOKS_DIGIT = { O: '0', o: '0', Q: '0', D: '0', U: '0', I: '1', l: '1', '|': '1', i: '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', b: '6', g: '9', q: '9', T: '7' };
  function fixDigits(line) {
    let s = String(line || '');
    // A lookalike between digits, or a digit and the point.
    for (let k = 0; k < 2; k++) {
      s = s.replace(/([\d.])([OoQDUIl|i!SsBZzGbgqT])(?=[\d.])/g, (m, a, c) => a + LOOKS_DIGIT[c]);
    }
    return s;
  }

  const L_HEIGHT = /(?:^|[^A-Za-z])(R[bfim]?|Rdg|Read(?:ing)?|Ht|Hgt|Height|Staff|Stf|BS|FS|IS|H)\s*[:=]?\s*$/i;
  const L_DIST = /(?:^|[^A-Za-z])(HD|SD|D|Dist(?:ance)?|Dst|HzD|d)\s*[:=]?\s*$/i;
  const L_LEVEL = /(?:^|[^A-Za-z])(Z|RL|Elev(?:ation)?|dH|ΔH|Diff|HI)\s*[:=]?\s*$/i;
  const L_ID = /(?:^|[^A-Za-z])(Pt|PtID|Point|No|Job|Line|Stn|Station|#)\s*[:.=]?\s*$/i;

  // → { height, distance, candidates: [{ text, value, decimals, kind, guessed, line, height, distance }] }
  function parseReading(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = [];
    lines.forEach((raw, li) => {
      let line = fixDigits(raw)
        .replace(/\b\d{1,2}[:/]\d{2}(?:[:/]\d{2,4})?\b/g, ' ')      // a time or a date
        .replace(/(\d),(\d{2,})/g, '$1.$2')                         // a decimal comma
        .replace(/(\d)\s*\.\s+(\d)/g, '$1.$2')                      // a point the engine spaced off
        .replace(/(\d)\s+\.(\d)/g, '$1.$2');
      const re = /([+-]?\d+(?:\.\d+)?)\s*(m(?![a-z]))?/g;
      let m;
      while ((m = re.exec(line))) {
        const s = m[1];
        const before = line.slice(0, m.index);
        const kind = L_ID.test(before) ? 'id' : L_DIST.test(before) ? 'distance' : L_LEVEL.test(before) ? 'level' : L_HEIGHT.test(before) ? 'height' : '';
        const decimals = (s.split('.')[1] || '').length;
        out.push({ text: s, value: Number(s), decimals, kind, guessed: false, line: li, unit: !!m[2] });
        // A point lost from a faint segment: four to six bare digits, offered
        // with it put back where a staff reading or a distance would have it.
        if (!decimals && /^\d{4,6}$/.test(s) && kind !== 'id') {
          out.push({ text: `${s[0]}.${s.slice(1)}`, value: Number(`${s[0]}.${s.slice(1)}`), decimals: s.length - 1, kind, guessed: true, line: li });
          out.push({ text: `${s.slice(0, 2)}.${s.slice(2)}`, value: Number(`${s.slice(0, 2)}.${s.slice(2)}`), decimals: s.length - 2, kind, guessed: true, line: li });
        }
      }
    });
    for (const c of out) { c.height = scoreHeight(c); c.distance = scoreDistance(c); }
    const pick = (key, not) => out.filter(c => c[key] > 0 && c !== not)
      .sort((a, b) => b[key] - a[key] || a.line - b.line)[0] || null;
    const h = pick('height');
    const d = pick('distance', h);
    return {
      height: h ? Number(h.value.toFixed(Math.min(5, h.decimals || 3))) : null,
      distance: d ? Number(d.value.toFixed(Math.min(3, d.decimals || 2))) : null,
      sureHeight: !!h && h.height >= 3,
      candidates: out.filter(c => c.kind !== 'id').sort((a, b) => Math.max(b.height, b.distance) - Math.max(a.height, a.distance)),
    };
  }
  function scoreHeight(c) {
    if (c.kind === 'id' || !Number.isFinite(c.value) || c.value < -0.5 || c.value > 6) return 0;
    let s = 1;
    if (c.kind === 'height') s += 3;
    if (c.kind === 'distance' || c.kind === 'level') s -= 2;
    if (c.decimals >= 3 && c.decimals <= 5) s += 2;
    else if (c.decimals === 2) s += 0.5;
    else if (!c.decimals) s -= 1;
    if (c.guessed) s -= 1.5;
    if (c.unit) s += 0.3;
    if (c.line === 0) s += 0.3;
    return Math.max(0, s);
  }
  function scoreDistance(c) {
    if (c.kind === 'id' || !Number.isFinite(c.value) || c.value < 0.5 || c.value > 150) return 0;
    let s = 1;
    if (c.kind === 'distance') s += 3;
    if (c.kind === 'height' || c.kind === 'level') s -= 2;
    if (c.decimals >= 1 && c.decimals <= 3) s += 1;
    if (c.decimals >= 4) s -= 1;
    if (c.guessed) s -= 1.5;
    return Math.max(0, s);
  }

  // A level's or a staff's plate: make, model, serial number.
  const MAKES = [
    ['Leica', /\bLEICA\b/i], ['Trimble', /\bTRIMBLE\b/i], ['Topcon', /\bTOPCON\b/i], ['Sokkia', /\bSOKKIA\b/i],
    ['Nikon', /\bNIKON\b/i], ['Spectra', /\bSPECTRA\b/i], ['Pentax', /\bPENTAX\b/i], ['GeoMax', /\bGEO\s?MAX\b/i],
    ['CST/berger', /\bCST\b|\bBERGER\b/i], ['South', /\bSOUTH\s+(?:SURVEY|DL|DS|NL)/i], ['Stonex', /\bSTONEX\b/i],
    ['Hilti', /\bHILTI\b/i], ['Bosch', /\bBOSCH\b/i], ['Zeiss', /\bZEISS\b/i], ['Kolida', /\bKOLIDA\b/i],
    ['FOIF', /\bFOIF\b/i], ['Nedo', /\bNEDO\b/i], ['Sola', /\bSOLA\b/i],
  ];
  const MODELS = [
    { re: /\bSPRINTER\s*-?\s*(\d{2,3}\s?M?)\b/i, make: 'Leica', name: m => `Sprinter ${m[1].replace(/\s/g, '').toUpperCase()}` },
    { re: /\bLS\s*-?\s*(10|15)\b/i, make: 'Leica', name: m => `LS${m[1]}` },
    { re: /\bDNA\s*-?\s*(03|10)\b/i, make: 'Leica', name: m => `DNA${m[1]}` },
    { re: /\bNA\s*-?\s*(7[2-3]\d|2|K\s?2|M\s?2|3[02]\d)\b/i, make: 'Leica', name: m => `NA${m[1].replace(/\s/g, '').toUpperCase()}` },
    { re: /\bDI\s?NI\s*-?\s*(\d{2})\b/i, make: 'Trimble', name: m => `DiNi ${m[1]}` },
    { re: /\bDL\s*-?\s*(50[1-3])\b/i, make: 'Topcon', name: m => `DL-${m[1]}` },
    { re: /\bAT\s*-?\s*B\s?(\d)\b/i, make: 'Topcon', name: m => `AT-B${m[1]}` },
    { re: /\bSDL\s*-?\s*(1X|30M?|50)\b/i, make: 'Sokkia', name: m => `SDL${m[1].toUpperCase()}` },
    { re: /\bAX\s*-?\s*2S\b/i, make: 'Nikon', name: () => 'AX-2S' },
    { re: /\bAE\s*-?\s*7\b/i, make: 'Nikon', name: () => 'AE-7' },
    { re: /\bZDL\s*-?\s*(\d{3})\b/i, make: 'GeoMax', name: m => `ZDL${m[1]}` },
    { re: /\bZAL\s*-?\s*(\d{3})\b/i, make: 'GeoMax', name: m => `ZAL${m[1]}` },
  ];
  const SERIAL = /(?:\bS\s*[/|I1\\]\s*N\b|\bSN\b|\bSER(?:IAL)?\.?\s*(?:N[O0]\.?|NUMBER|#)?|\bN[O0]\.)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{3,17})/i;
  function parseLabel(text) {
    const flat = String(text || '').replace(/[‐-―]/g, '-');
    let make = '', model = '', serial = '';
    for (const [name, re] of MAKES) if (re.test(flat)) { make = name; break; }
    for (const m of MODELS) {
      const hit = flat.match(m.re);
      if (hit && (!make || make === m.make)) { model = m.name(hit); make = make || m.make; break; }
    }
    const s = flat.match(SERIAL);
    if (s) serial = s[1].toUpperCase();
    else {
      // No label: the longest run of six to nine digits on its own.
      const runs = flat.match(/\b\d{6,9}\b/g) || [];
      serial = runs.sort((a, b) => b.length - a.length)[0] || '';
    }
    return { make, model, serial };
  }

  // ── Reading pixels (pure) ──────────────────────────────────────────────────

  // Grey, stretched between the 1st and 99th percentile.
  function stretch(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= gray.length * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= gray.length * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    const out = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((gray[i] - lo) * 255 / span)));
    return out;
  }

  // Otsu's threshold: the grey level that best splits ink from ground.
  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const n = gray.length;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, at = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; at = t; }
    }
    return at;
  }

  // Ink black on white: thresholded, and turned over where the display is
  // light-on-dark (more ink than ground).
  function binary(gray) {
    const t = otsu(gray);
    const out = new Uint8Array(gray.length);
    let dark = 0;
    for (let i = 0; i < gray.length; i++) { const d = gray[i] <= t; out[i] = d ? 0 : 255; if (d) dark++; }
    if (dark > gray.length * 0.55) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
    return out;
  }

  // Each stroke thickened by a pixel or two, so a seven-segment digit's
  // segments meet: the darkest pixel of each neighbourhood.
  function thicken(bin, w, h, r = 1) {
    const out = new Uint8Array(bin.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 255;
        for (let dy = -r; dy <= r && v; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w && bin[yy * w + xx] === 0) { v = 0; break; }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // Where the text is in a grey picture: the box round the pixels with a
  // sharp edge beside them, rows and columns with enough of those, the gaps
  // between characters and lines closed. Null where that is most of the
  // picture already, or so little of it that it is more likely noise.
  function tighten(gray, w, h) {
    if (!gray || w < 16 || h < 16) return null;
    const g = new Uint16Array(w * h);
    let max = 0;
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        const v = Math.abs(gray[i + 1] - gray[i]) + Math.abs(gray[i + w] - gray[i]);
        g[i] = v;
        if (v > max) max = v;
      }
    }
    const hist = new Uint32Array(511);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let acc = 0, p90 = 0;
    for (let v = 0; v < hist.length; v++) { acc += hist[v]; if (acc >= g.length * 0.9) { p90 = v; break; } }
    const t = Math.max(24, p90, max * 0.25);
    const rows = new Uint32Array(h), cols = new Uint32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] >= t) { rows[y]++; cols[x]++; }
    // The runs of edge along one axis, a small gap bridged. A display's
    // lines are separate runs (the staff reading above the distance), so
    // every run with a fair share of the strongest one's edge is kept — the
    // box is round all the text, not round its busiest line — and a speck of
    // glare or a scratch, with next to none, is not.
    const span = (prof, n, other, gapFrac) => {
      const need = Math.max(2, other * 0.02);
      const gap = Math.max(2, Math.round(n * gapFrac));
      const runs = [];
      let cur = null, lastOn = -1e9;
      for (let i = 0; i < n; i++) {
        if (prof[i] >= need) {
          if (cur && i - lastOn <= gap) cur.b = i;
          else { cur = { a: i, b: i, mass: 0 }; runs.push(cur); }
          cur.mass += prof[i];
          lastOn = i;
        }
      }
      if (!runs.length) return null;
      const top = Math.max(...runs.map(r => r.mass));
      const kept = runs.filter(r => r.mass >= top * 0.2);
      return { a: Math.min(...kept.map(r => r.a)), b: Math.max(...kept.map(r => r.b)) };
    };
    const ry = span(rows, h, w, 0.12), rx = span(cols, w, h, 0.18);
    if (!ry || !rx) return null;
    const mx = Math.round(w * 0.05), my = Math.round(h * 0.12);
    const x0 = Math.max(0, rx.a - mx), x1 = Math.min(w, rx.b + 1 + mx);
    const y0 = Math.max(0, ry.a - my), y1 = Math.min(h, ry.b + 1 + my);
    const bw = x1 - x0, bh = y1 - y0;
    if (bw * bh > w * h * 0.85 || bw < w * 0.15 || bh < h * 0.15) return null;
    return { x: x0, y: y0, w: bw, h: bh };
  }

  // ── The sheet ──────────────────────────────────────────────────────────────

  let S = null;    // the open sheet: { opts, resolve, stream, track, … }

  const $ = id => document.getElementById(id);

  // Open the sheet. opts:
  //   purpose   'reading' | 'label' | 'photo'
  //   title     what the sheet says it is for ("Row 4 · Foresight")
  //   expect    'height' | 'distance' — which number a reading is
  //   owner, owner_id, row_id, field   where the picture is filed
  //   caption   { what, station, where: {lat, lon, acc} } for the strip
  // Resolves with { value, distance, text, evidence, label } or null.
  function read(opts = {}) {
    if (S) close(null);
    return new Promise(resolve => {
      S = { opts: Object.assign({ purpose: 'reading', expect: 'height' }, opts), resolve, stream: null, track: null,
            torch: false, crop: null, shot: null, result: null, back: document.activeElement, busy: false, wake: null };
      mount();
      startCamera();
      askWhere();
    });
  }
  function photo(opts = {}) { return read(Object.assign({}, opts, { purpose: 'photo' })); }

  function mount() {
    const o = S.opts;
    const el = document.createElement('div');
    el.id = 'lc-sheet';
    el.className = `lc-sheet lc-${o.purpose}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'lc-title');
    const guide = o.purpose === 'photo' ? '' : `<div class="lc-guide" id="lc-guide" style="--lc-aspect:${GUIDE_ASPECT[o.purpose] || 3}"><span>${
      o.purpose === 'label' ? 'Fit the label in the box' : 'Fit the level\'s display in the box'}</span></div>`;
    el.innerHTML = `
      <div class="lc-head">
        <h2 id="lc-title">${esc(o.title || (o.purpose === 'label' ? 'Read a label' : o.purpose === 'photo' ? 'Take a photo' : 'Read the display'))}</h2>
        <button type="button" class="lc-x" onclick="LevelCamera.close()" aria-label="Close the camera">✕</button>
      </div>
      <div class="lc-stage" id="lc-stage">
        <video id="lc-video" class="lc-video" playsinline muted></video>
        ${guide}
        <div class="lc-pick" id="lc-pick" hidden></div>
        <p class="lc-note" id="lc-note" role="status" aria-live="polite"></p>
      </div>
      <div class="lc-result" id="lc-result" hidden></div>
      <div class="lc-controls" id="lc-controls">
        <label class="lc-round" title="Use the camera app or a picture you have">
          <input type="file" id="lc-file" accept="image/*" capture="environment" onchange="LevelCamera.fromFile(this.files)">
          <span aria-hidden="true">🖼️</span><span class="sr-only">Use the camera app or a saved picture</span>
        </label>
        <button type="button" class="lc-shutter" id="lc-shutter" onclick="LevelCamera.shoot()" aria-label="${o.purpose === 'photo' ? 'Take the photo' : 'Read it'}" disabled></button>
        <button type="button" class="lc-round" id="lc-torch" onclick="LevelCamera.torch()" aria-label="Torch" hidden>🔦</button>
        ${o.purpose === 'photo' ? '' : '<button type="button" class="lc-round lc-type" onclick="LevelCamera.typeIt()" aria-label="Type it instead">⌨️</button>'}
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('keydown', onKey);
    const sh = $('lc-shutter');
    if (sh) sh.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
    if (e.key !== 'Tab') return;
    const el = $('lc-sheet');
    const f = [...el.querySelectorAll('button:not([disabled]):not([hidden]), input:not([type=file]), [tabindex="0"], label.lc-round')]
      .filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function note(text, kind = '') {
    const n = $('lc-note');
    if (!n) return;
    n.textContent = text || '';
    n.className = `lc-note${kind ? ` txt-${kind}` : ''}`;
  }

  function startCamera() {
    const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
    if (!md || !md.getUserMedia) { noCamera('This browser will not show the camera here — use 🖼️ to take or pick a picture.'); return; }
    note('Starting the camera…');
    md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } })
      .then(stream => {
        if (!S) { stream.getTracks().forEach(t => t.stop()); return; }
        S.stream = stream;
        S.track = stream.getVideoTracks()[0] || null;
        const v = $('lc-video');
        v.muted = true;
        v.srcObject = stream;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
        const caps = S.track && S.track.getCapabilities ? S.track.getCapabilities() : {};
        const t = $('lc-torch');
        if (t) t.hidden = !(caps && caps.torch);
        // The shutter is live once there is a picture to take — before the
        // video knows its size, a press would take nothing.
        const live = () => {
          if (!S || S.stream !== stream || !v.videoWidth) return;
          const sh = $('lc-shutter');
          if (sh && !S.shot) sh.disabled = false;
          note(S.opts.purpose === 'photo' ? '' : 'Hold steady, square on to the display, close enough to fill the box.');
        };
        if (v.videoWidth) live();
        else { v.addEventListener('loadedmetadata', live, { once: true }); v.addEventListener('playing', live, { once: true }); }
        holdWake();
      }, err => {
        const name = err && err.name;
        noCamera(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'The camera was not allowed — use 🖼️ to take a picture with the camera app instead, or type it.'
          : name === 'NotReadableError' ? 'The camera is busy in another app — close it, or use 🖼️.'
          : 'No camera the browser can use here — use 🖼️ to take or pick a picture.');
      });
  }
  function noCamera(why) {
    const v = $('lc-video');
    if (v) v.hidden = true;
    const g = $('lc-guide');
    if (g) g.hidden = true;
    note(why, 'warn');
  }
  function stopCamera() {
    if (S && S.stream) S.stream.getTracks().forEach(t => t.stop());
    if (S) { S.stream = null; S.track = null; }
    if (S && S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
  }
  function holdWake() {
    if (!S || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(w => { if (S) S.wake = w; else w.release(); }, () => {});
  }
  function torch() {
    if (!S || !S.track || !S.track.applyConstraints) return;
    const on = !S.torch;
    S.track.applyConstraints({ advanced: [{ torch: on }] }).then(() => { S.torch = on; }, () => note('This camera will not light its torch from the browser.', 'warn'));
  }
  // Where the phone is, for the strip — the survey's fix if it has one,
  // else one asked for now, never waited for.
  function askWhere() {
    const w = S.opts.caption && S.opts.caption.where;
    if (w && w.lat != null) { S.where = w; return; }
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(p => {
      if (S) S.where = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    }, () => {}, { enableHighAccuracy: false, maximumAge: 120000, timeout: 8000 });
  }

  function close(result = null) {
    if (!S) return;
    const s = S;
    stopCamera();
    S = null;
    const el = $('lc-sheet');
    if (el) el.remove();
    if (s.back && s.back.focus && document.contains(s.back)) { try { s.back.focus(); } catch (_) { /* gone */ } }
    s.resolve(result);
  }

  // ── Taking the picture ─────────────────────────────────────────────────────

  // The frame at the camera's own resolution, and the guide's box in it: the
  // video is drawn to cover the stage, so the box is mapped back through that.
  function shoot() {
    if (!S || S.busy) return;
    const v = $('lc-video');
    if (!v || !v.videoWidth) return;
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    let box = { x: 0, y: 0, w: cv.width, h: cv.height };
    const g = $('lc-guide'), st = $('lc-stage');
    if (g && st && !g.hidden) {
      const sr = st.getBoundingClientRect(), gr = g.getBoundingClientRect();
      const scale = Math.max(sr.width / cv.width, sr.height / cv.height);
      const offX = (sr.width - cv.width * scale) / 2, offY = (sr.height - cv.height * scale) / 2;
      box = rectIn(cv, (gr.left - sr.left - offX) / scale, (gr.top - sr.top - offY) / scale, gr.width / scale, gr.height / scale, MARGIN);
    }
    if (navigator.vibrate) { try { navigator.vibrate(30); } catch (_) { /* not every phone */ } }
    stopCamera();
    v.hidden = true;
    if (g) g.hidden = true;
    S.shot = cv;
    handle(cv, box);
  }
  function rectIn(cv, x, y, w, h, margin = 0) {
    const mx = w * margin, my = h * margin;
    const x0 = Math.max(0, Math.floor(x - mx)), y0 = Math.max(0, Math.floor(y - my));
    const x1 = Math.min(cv.width, Math.ceil(x + w + mx)), y1 = Math.min(cv.height, Math.ceil(y + h + my));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  // A picture from the camera app or the gallery: shown whole, a box dragged
  // over the display (one is there to start with), then read the same way.
  async function fromFile(files) {
    const f = files && files[0];
    if (!S || !f) return;
    stopCamera();
    let bmp = null;
    try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); }
    catch (_) {
      try { bmp = await createImageBitmap(f); } catch (__) { bmp = null; }
    }
    if (!bmp) { note('That picture could not be opened here — a JPEG or PNG will do.', 'bad'); return; }
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    S.shot = cv;
    const v = $('lc-video'); if (v) v.hidden = true;
    const g = $('lc-guide'); if (g) g.hidden = true;
    if (S.opts.purpose === 'photo') { handle(cv, { x: 0, y: 0, w: cv.width, h: cv.height }); return; }
    pickBox(cv);
  }

  function pickBox(cv) {
    const pick = $('lc-pick');
    pick.hidden = false;
    pick.innerHTML = `<canvas id="lc-pick-cv" class="lc-pick-cv"></canvas><div class="lc-box" id="lc-box"></div>`;
    const c = $('lc-pick-cv');
    const st = $('lc-stage').getBoundingClientRect();
    const scale = Math.min(st.width / cv.width, st.height / cv.height);
    c.width = Math.round(cv.width * scale); c.height = Math.round(cv.height * scale);
    c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
    const aspect = GUIDE_ASPECT[S.opts.purpose] || 3;
    const bw = c.width * 0.8, bh = Math.min(c.height * 0.8, bw / aspect);
    S.pick = { scale, x: (c.width - bw) / 2, y: (c.height - bh) / 2, w: bw, h: bh };
    paintBox();
    let from = null;
    c.parentElement.onpointerdown = e => {
      const r = c.getBoundingClientRect();
      from = { x: e.clientX - r.left, y: e.clientY - r.top };
      c.parentElement.setPointerCapture(e.pointerId);
    };
    c.parentElement.onpointermove = e => {
      if (!from) return;
      const r = c.getBoundingClientRect();
      const x = Math.max(0, Math.min(c.width, e.clientX - r.left)), y = Math.max(0, Math.min(c.height, e.clientY - r.top));
      Object.assign(S.pick, { x: Math.min(from.x, x), y: Math.min(from.y, y), w: Math.abs(x - from.x), h: Math.abs(y - from.y) });
      paintBox();
    };
    c.parentElement.onpointerup = () => { from = null; };
    note('Drag a box round the display, then press the button.');
    const sh = $('lc-shutter');
    sh.disabled = false;
    sh.onclick = () => {
      const p = S.pick;
      if (p.w < 12 || p.h < 8) { note('Drag a box round the display first.', 'warn'); return; }
      pick.hidden = true;
      handle(cv, rectIn(cv, p.x / p.scale, p.y / p.scale, p.w / p.scale, p.h / p.scale, 0));
    };
  }
  function paintBox() {
    const b = $('lc-box'), c = $('lc-pick-cv');
    if (!b || !c || !S || !S.pick) return;
    const p = S.pick;
    Object.assign(b.style, { left: `${c.offsetLeft + p.x}px`, top: `${c.offsetTop + p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
  }

  // ── Reading it ─────────────────────────────────────────────────────────────

  function greyOf(cv, box, maxW) {
    const scale = Math.min(1, maxW / box.w);
    const w = Math.max(1, Math.round(box.w * scale)), h = Math.max(1, Math.round(box.h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(cv, box.x, box.y, box.w, box.h, 0, 0, w, h);
    const px = cx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000 | 0;
    return { gray, w, h, scale };
  }

  async function handle(cv, box) {
    const o = S.opts;
    S.busy = true;
    const sh = $('lc-shutter'); if (sh) sh.disabled = true;
    if (o.purpose === 'photo') {
      S.crop = box;
      S.busy = false;
      showResult({ photo: true });
      return;
    }
    // Cut to where the text is: found on a small copy, applied to the full one.
    const small = greyOf(cv, box, 480);
    const t = tighten(small.gray, small.w, small.h);
    S.crop = t ? { x: box.x + Math.round(t.x / small.scale), y: box.y + Math.round(t.y / small.scale),
                   w: Math.round(t.w / small.scale), h: Math.round(t.h / small.scale) } : box;
    showResult({ reading: true });
    const prefs = typeof LevelStore !== 'undefined' ? LevelStore.prefs() : { ocr: true };
    if (!prefs.ocr || typeof PhotoMeta === 'undefined' || !PhotoMeta.ocrGrey) {
      S.busy = false;
      settle(null, prefs.ocr ? 'Reading needs the OCR engine, which is not loaded here — type the number.' : 'Reading is switched off — type the number.');
      return;
    }
    note('Reading…');
    try {
      S.result = await ocr(cv, S.crop, o.purpose);
      settle(S.result);
    } catch (err) {
      settle(null, navigator.onLine === false
        ? 'The reader is not on this device yet — it needs a signal once (Level Survey → Get ready for no signal). Type the number; the picture is kept.'
        : `It could not be read (${String((err && err.message) || err)}) — type the number; the picture is kept.`);
    } finally {
      S && (S.busy = false);
    }
  }

  // Up to three passes, the later ones only while the reading is not clear.
  async function ocr(cv, box, purpose) {
    let scaleW = Math.min(OCR_MAX_W, box.w);
    if (box.h * (scaleW / box.w) < OCR_MIN_H) scaleW = Math.min(OCR_MAX_W * 1.5, Math.round(box.w * OCR_MIN_H / box.h));
    const g = greyOf(cv, box, scaleW);
    if (g.scale < 1 && box.w < scaleW) { /* enlarged below */ }
    const up = scaleW > box.w ? enlarge(cv, box, scaleW) : g;
    const grey = stretch(up.gray);
    const texts = [];
    const v1 = { variant: 'grey', gray: grey, width: up.w, height: up.h };
    const r1 = await PhotoMeta.ocrGrey(v1, 6, purpose === 'label' ? {} : { preserve_interword_spaces: '1' });
    texts.push(r1.text || '');
    if (purpose === 'label') {
      const lab = parseLabel(texts.join('\n'));
      if (!lab.serial) {
        const r2 = await PhotoMeta.ocrGrey({ variant: 'bin', gray: binary(grey), width: up.w, height: up.h }, 11, {});
        texts.push(r2.text || '');
      }
      return { text: texts.join('\n'), label: parseLabel(texts.join('\n')) };
    }
    let parsed = parseReading(texts.join('\n'));
    if (!parsed.sureHeight || parsed.height == null) {
      const bin = binary(grey);
      const r2 = await PhotoMeta.ocrGrey({ variant: 'bin', gray: bin, width: up.w, height: up.h }, 6, { tessedit_char_whitelist: '0123456789.-' });
      texts.push(r2.text || '');
      parsed = vote(texts);
      if (!parsed.sureHeight) {
        const thick = thicken(bin, up.w, up.h, Math.max(1, Math.round(up.h / 120)));
        const r3 = await PhotoMeta.ocrGrey({ variant: 'thick', gray: thick, width: up.w, height: up.h }, 6, { tessedit_char_whitelist: '0123456789.-' });
        texts.push(r3.text || '');
        parsed = vote(texts);
      }
    }
    return Object.assign({ text: texts.join('\n') }, parsed);
  }
  // Two passes that read the same number make it surer.
  function vote(texts) {
    const all = texts.map(parseReading);
    const pool = parseReading(texts.join('\n'));
    const seen = {};
    for (const p of all) for (const c of p.candidates) seen[c.text] = (seen[c.text] || 0) + 1;
    for (const c of pool.candidates) {
      if (seen[c.text] > 1) { c.height += c.height ? 1 : 0; c.distance += c.distance ? 1 : 0; }
    }
    const best = (key, not) => pool.candidates.filter(c => c[key] > 0 && c !== not).sort((a, b) => b[key] - a[key])[0] || null;
    const h = best('height'), d = best('distance', h);
    return Object.assign(pool, {
      height: h ? Number(h.value.toFixed(Math.min(5, h.decimals || 3))) : null,
      distance: d ? Number(d.value.toFixed(Math.min(3, d.decimals || 2))) : null,
      sureHeight: !!h && h.height >= 3,
    });
  }
  function enlarge(cv, box, w) {
    const scale = w / box.w;
    const h = Math.max(1, Math.round(box.h * scale));
    const c = document.createElement('canvas');
    c.width = Math.round(w); c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(cv, box.x, box.y, box.w, box.h, 0, 0, c.width, h);
    const px = cx.getImageData(0, 0, c.width, h).data;
    const gray = new Uint8Array(c.width * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000 | 0;
    return { gray, w: c.width, h, scale };
  }

  // ── What was read, to accept or correct ────────────────────────────────────

  function showResult(kind) {
    const r = $('lc-result');
    r.hidden = false;
    const prev = document.createElement('canvas');
    const b = S.crop;
    const maxW = Math.min(900, Math.max(320, b.w));
    const sc = Math.min(1, maxW / b.w);
    prev.width = Math.max(1, Math.round(b.w * sc)); prev.height = Math.max(1, Math.round(b.h * sc));
    prev.getContext('2d').drawImage(S.shot, b.x, b.y, b.w, b.h, 0, 0, prev.width, prev.height);
    prev.className = 'lc-preview';
    prev.setAttribute('role', 'img');
    prev.setAttribute('aria-label', kind.photo ? 'The photo' : 'What was read');
    const o = S.opts;
    r.innerHTML = '';
    r.appendChild(prev);
    const body = document.createElement('div');
    body.className = 'lc-answer';
    body.id = 'lc-answer';
    if (kind.photo) {
      body.innerHTML = `<div class="button-row"><button type="button" class="primary" onclick="LevelCamera.accept()">Keep the photo</button>
        <button type="button" onclick="LevelCamera.retake()">Retake</button></div>`;
    } else if (o.purpose === 'label') {
      body.innerHTML = `<p class="txt-muted">Reading the label…</p>`;
    } else {
      body.innerHTML = `<p class="txt-muted">Reading…</p>`;
    }
    r.appendChild(body);
    $('lc-controls').hidden = true;
    const st = $('lc-stage'); if (st) st.hidden = true;
  }

  function settle(res, why) {
    if (!S) return;
    const o = S.opts;
    const body = $('lc-answer');
    if (!body) return;
    note('');
    if (o.purpose === 'label') {
      const l = (res && res.label) || { make: '', model: '', serial: '' };
      body.innerHTML = `
        ${why ? `<p class="txt-warn">${esc(why)}</p>` : `<p class="txt-muted">Check what was read; correct anything that is wrong.</p>`}
        <div class="lc-fields">
          <label>Make <input id="lc-make" value="${esc(l.make)}" autocomplete="off"></label>
          <label>Model <input id="lc-model" value="${esc(l.model)}" autocomplete="off"></label>
          <label>Serial number <input id="lc-serial" value="${esc(l.serial)}" autocomplete="off" autocapitalize="characters"></label>
        </div>
        ${res && res.text ? `<details class="lc-raw"><summary>What the reader saw</summary><pre>${esc(res.text.trim())}</pre></details>` : ''}
        <div class="button-row"><button type="button" class="primary" onclick="LevelCamera.accept()">Use these</button>
          <button type="button" onclick="LevelCamera.retake()">Retake</button></div>`;
      const f = $('lc-serial'); if (f) f.focus();
      return;
    }
    const wantDist = o.expect === 'distance';
    const main = res ? (wantDist ? res.distance : res.height) : null;
    const other = res ? (wantDist ? res.height : res.distance) : null;
    const chips = res ? res.candidates.filter(c => (wantDist ? c.distance : c.height) > 0).slice(0, 4) : [];
    body.innerHTML = `
      ${why ? `<p class="txt-warn">${esc(why)}</p>`
            : main == null ? '<p class="txt-warn">No reading found in that — try again closer and square on, or type it.</p>'
            : `<p class="txt-muted">${res.sureHeight || wantDist ? 'Read as' : 'Best guess'} — check it against the display.</p>`}
      <label class="lc-value-label" for="lc-value">${esc(o.title || 'Reading')} (m)</label>
      <input id="lc-value" class="lc-value" inputmode="decimal" autocomplete="off" value="${main == null ? '' : esc(String(main))}"
             onkeydown="if (event.key === 'Enter') LevelCamera.accept()">
      ${chips.length > 1 ? `<div class="pill-row lc-chips" role="group" aria-label="Other numbers read">${chips.map(c =>
        `<button type="button" class="pill" onclick="document.getElementById('lc-value').value='${c.value}'">${esc(c.text)}${c.kind ? ` <small>${esc(c.kind)}</small>` : ''}${c.guessed ? ' <small>point added</small>' : ''}</button>`).join('')}</div>` : ''}
      ${!wantDist && other != null ? `<label class="check-label lc-also"><input type="checkbox" id="lc-dist-too" checked> Also take the distance, ${esc(String(other))} m</label>` : ''}
      ${res && res.text ? `<details class="lc-raw"><summary>What the reader saw</summary><pre>${esc(res.text.trim())}</pre></details>` : ''}
      <div class="button-row"><button type="button" class="primary" onclick="LevelCamera.accept()">Use this reading</button>
        <button type="button" onclick="LevelCamera.retake()">Retake</button></div>`;
    const f = $('lc-value'); if (f) { f.focus(); f.select(); }
    announce(main == null ? 'No reading found.' : `Read ${main} metres. Check it, then use it.`);
  }

  // Type it, with no picture: the sheet closes and the box is the caller's.
  function typeIt() { close({ typed: true }); }

  function retake() {
    if (!S) return;
    const o = S.opts, resolve = S.resolve, back = S.back;
    stopCamera();
    const el = $('lc-sheet'); if (el) el.remove();
    S = null;
    read(o).then(resolve);
    if (S) S.back = back;
  }

  // The picture becomes evidence — the crop with its strip — kept on the
  // device; the value, the distance or the label go back to the caller.
  async function accept() {
    if (!S || S.busy) return;
    const o = S.opts;
    let value = null, distance = null, label = null;
    if (o.purpose === 'reading') {
      value = Levelling.num($('lc-value') && $('lc-value').value);
      if (value == null) { note('Type the number as the display shows it, or Retake.', 'warn'); const f = $('lc-value'); if (f) f.focus(); return; }
      const also = $('lc-dist-too');
      if (also && also.checked && S.result) distance = o.expect === 'distance' ? null : S.result.distance;
    } else if (o.purpose === 'label') {
      label = { make: ($('lc-make') || {}).value || '', model: ($('lc-model') || {}).value || '', serial: ($('lc-serial') || {}).value || '' };
    }
    S.busy = true;
    let evidence = null;
    try {
      const keep = typeof LevelStore === 'undefined' || LevelStore.prefs().keepCrops !== false || o.purpose === 'photo';
      if (keep && typeof LevelStore !== 'undefined') {
        const pic = await evidenceImage(S.shot, S.crop, o, value);
        if (pic) {
          const w = S.where || {};
          evidence = await LevelStore.addEvidence({
            owner: o.owner || 'survey', owner_id: o.owner_id || null, row_id: o.row_id || null, field: o.field || null,
            kind: o.purpose === 'photo' ? 'photo' : o.purpose === 'label' ? 'label' : 'reading',
            type: pic.type, width: pic.width, height: pic.height, ocr_text: S.result && S.result.text ? S.result.text.slice(0, 2000) : null,
            value_m: value, taken_at: new Date().toISOString(), lat: w.lat == null ? null : w.lat, lon: w.lon == null ? null : w.lon,
            acc: w.acc == null ? null : Math.round(w.acc * 10) / 10, sha256: pic.sha256 || null,
          }, pic.bytes);
        }
      }
    } catch (err) {
      note(`The picture could not be kept (${String((err && err.message) || err)}); the reading is still taken.`, 'warn');
    }
    const text = S.result ? S.result.text : '';
    close({ value, distance, label, text, evidence });
  }

  // The kept picture: grey for a reading or a label (the display has no
  // colour worth bytes), whole for a photo; never wider than it needs to be;
  // a strip along its foot saying what, which value, when and where.
  async function evidenceImage(cv, box, o, value) {
    const max = o.purpose === 'photo' ? PHOTO_MAX : o.purpose === 'label' ? LABEL_MAX : READ_MAX;
    const sc = Math.min(1, max / Math.max(box.w, box.h));
    const w = Math.max(1, Math.round(box.w * sc)), h = Math.max(1, Math.round(box.h * sc));
    const fs = Math.max(11, Math.round(Math.max(w, 360) * (o.purpose === 'photo' ? 0.018 : 0.028)));
    const strip = Math.round(fs * 2.9);
    const c = document.createElement('canvas');
    c.width = w; c.height = h + strip;
    const cx = c.getContext('2d', { willReadFrequently: o.purpose !== 'photo' });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(cv, box.x, box.y, box.w, box.h, 0, 0, w, h);
    if (o.purpose !== 'photo') {
      const id = cx.getImageData(0, 0, w, h);
      const d = id.data;
      const gray = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
      const st = stretch(gray);
      for (let i = 0, p = 0; i < st.length; i++, p += 4) { d[p] = d[p + 1] = d[p + 2] = st[i]; }
      cx.putImageData(id, 0, 0);
    }
    cx.fillStyle = '#101418';
    cx.fillRect(0, h, w, strip);
    cx.fillStyle = '#ffffff';
    cx.textBaseline = 'top';
    const cap = o.caption || {};
    const when = new Date();
    const wh = S && S.where;
    const line1 = [cap.what || o.title || '', value != null ? `read ${value} m` : ''].filter(Boolean).join(' · ');
    const line2 = [cap.station || '', `${Levelling.dmy(Levelling.today(when))} ${Levelling.clock(when)}`,
                   wh && wh.lat != null ? `${wh.lat.toFixed(5)}, ${wh.lon.toFixed(5)}${wh.acc != null ? ` ±${Math.round(wh.acc)} m` : ''}` : '']
      .filter(Boolean).join(' · ');
    cx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    cx.fillText(fit(cx, line1, w - fs), fs * 0.5, h + fs * 0.35);
    cx.font = `${Math.round(fs * 0.86)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    cx.fillText(fit(cx, line2, w - fs), fs * 0.5, h + fs * 1.55);
    const types = o.purpose === 'photo' ? [['image/jpeg', 0.8]] : [['image/webp', 0.72], ['image/jpeg', 0.74]];
    for (const [type, q] of types) {
      const blob = await new Promise(res => c.toBlob(res, type, q));
      if (blob && blob.type === type) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let sha256 = null;
        try {
          if (crypto && crypto.subtle) {
            const dg = await crypto.subtle.digest('SHA-256', bytes);
            sha256 = [...new Uint8Array(dg)].map(x => x.toString(16).padStart(2, '0')).join('');
          }
        } catch (_) { /* not on an insecure origin; the bytes stand without it */ }
        return { bytes, type, width: c.width, height: c.height, sha256 };
      }
    }
    return null;
  }
  function fit(cx, text, w) {
    let t = String(text || '');
    if (cx.measureText(t).width <= w) return t;
    while (t.length > 4 && cx.measureText(`${t}…`).width > w) t = t.slice(0, -1);
    return `${t}…`;
  }

  // Make the reader ready for no signal: start it once, so every file it
  // needs is kept (sw.js) and its model stored (Tesseract.js, IndexedDB).
  async function warm() {
    if (typeof PhotoMeta === 'undefined' || !PhotoMeta.ocrWarm) throw new Error('the OCR engine is not part of this page');
    return PhotoMeta.ocrWarm();
  }
  // Is it ready? The files kept, as far as this page can tell.
  async function readyOffline() {
    try {
      if (typeof caches === 'undefined') return null;
      if (!(await caches.has('floodnet-libs'))) return false;
      const c = await caches.open('floodnet-libs');
      const keys = (await c.keys()).map(r => r.url);
      return ['tesseract.min.js', 'worker.min.js', 'lstm.wasm.js'].every(f => keys.some(u => u.includes(f)));
    } catch (_) {
      return null;
    }
  }

  return {
    read, photo, close, shoot, fromFile, torch, typeIt, retake, accept, warm, readyOffline,
    parseReading, parseLabel, tighten, otsu, stretch, binary, thicken, fixDigits,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LevelCamera;
