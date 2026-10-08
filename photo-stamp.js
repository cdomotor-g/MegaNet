// MegaNet — photo-stamp.js
//
//   PhotoStamp   what a photo taken in Flood-Net carries about itself: the
//                panel burnt into its pixels — the compass ribbon, the heading,
//                the position and its ±, the altitude and its datum, the
//                station, the place and the time — drawn the way Solocator
//                draws its own, and the same facts written into the file's
//                EXIF, where every other program looks for them.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Pure: facts in, text, pixels on a canvas the caller hands it, and bytes out.
// It touches no page, no `state` and no network, and the IIFE body only
// declares, so its position among the modules is free (`npm run toplevel`).
// test/camera.mjs require()s this same file under Node (the CommonJS line at
// the foot), so the stamp the check reads back is the stamp the camera draws.
//
// ── Why Solocator's panel, line for line ─────────────────────────────────────
// Most of the field photos already in Flood-Net were taken with Solocator, and
// the crews read its panel at a glance: a blue compass ribbon across the top
// with a green needle on the way the camera faced, a pale bar under it —
//
//     ❂ 242°SW (T)  ◉ -27.554294°, 152.274116° ±4m  ▲ 134m (HAE)
//
// — and green text in the bottom corners: the place on the left, the project
// and the time on the right. A photo taken in the app looks the same, so a
// folder of them reads the same as the folders already filed — with one line
// more, the station the photo is of, above the project.
//
// And it is read the same. photo-meta.js already reads that panel back by OCR
// for a photo whose EXIF has gone (Messages, a chat app, an email), so a photo
// stamped here and stripped on its way somewhere is still placed when it comes
// back in. The proportions, the colours and the order of the words below are
// measured off the two Solocator photos in test/fixtures/photos — the bands the
// OCR looks in (the top and bottom fifth of the frame) are where everything is
// printed — and `npm run camera` reads a stamped photo back with the real
// engine to prove it.
//
// ── The numbers printed ──────────────────────────────────────────────────────
// The heading is true, as Solocator's `(T)` says: the camera's compass is
// corrected by the World Magnetic Model before it gets here (field-camera.js).
// The compass word is one of eight, as Solocator prints it — `242°SW`, not
// `242°WSW` — which the reader accepts within a point and a half either way.
// The position is printed to six places (a tenth of a metre), the ± and the
// altitude to the metre, and the altitude with its datum, always: a phone's
// GPS gives height above the ellipsoid on Android and above sea level on an
// iPhone, forty metres apart here, and a height without its datum is a number
// nobody can use. Where the GPS gives no height at all, the ground's height in
// AHD may be printed instead (field-camera.js asks Elvis or the terrain), and
// says AHD. The time is the phone's own clock with its zone — `AEST`, or
// `UTC+10:00` where the zone has no name the reader knows.
//
// ── The file ─────────────────────────────────────────────────────────────────
// A canvas's JPEG has no EXIF, so the facts are written in here: the GPS block
// (position, ±, altitude, true heading, the GPS clock), the shutter's local
// time with its offset (EXIF 2.31's OffsetTimeOriginal, so no reader has to
// guess the zone), the pixel size, and `Flood-Net Field Camera` as the
// software. PhotoMeta.read reads every one of them back; so do Google Photos,
// QGIS and exiftool. The pixels are upright, so the orientation is 1.
//
// Schema: db/migrations/0035_field_photos.sql. The rest: docs/field-photos.md,
// "Taking photos in Flood-Net".

const PhotoStamp = (function () {

  const SOFTWARE = 'Flood-Net Field Camera';

  // ── Geometry, in Solocator's own pixels ────────────────────────────────────
  // Measured off test/fixtures/photos/solocator-gatton-sw.jpg (1545 × 1159),
  // and scaled by the short side: k = min(width, height) / 1159. Everything is
  // printed inside the top and bottom fifth of the frame, which is where
  // PhotoMeta's OCR looks (its BANDS) — whatever the photo's shape.
  const REF = 1159;
  const G = {
    ribbonH: 135,       // the blue compass ribbon
    pxPerDeg: 8.13,     // its scale: 5° a tick
    cardinalPx: 58,     // N E S W, bold, baseline at cardinalY
    cardinalY: 53,
    interPx: 46,        // NE SE SW NW
    interY: 51,
    numPx: 27,          // 0 30 60 …, every 30°
    numY: 86,
    tickTop: 98, tickBottom: 120, tickW: 3,   // a bar every 10°
    dotY: 108, dotR: 4,                       // a dot between them
    needleW: 10, needleH: 90,
    barH: 72,           // the pale bar under the ribbon
    barPx: 48,
    barBase: 52,        // the text's baseline, down from the bar's top
    cornerPx: 36,       // the green text in the bottom corners
    cornerLine: 42,     // …its line spacing
    cornerBase: 39,     // …the last line's baseline, up from the bottom
    marginL: 30, marginR: 33,
  };

  const C = {
    ribbonTop: 'rgba(24, 62, 112, 0.92)',
    ribbonBottom: 'rgba(33, 71, 123, 0.92)',
    ribbonInk: '#ffffff',
    needle: '#7ceb23',
    needleEdge: '#0a2232',
    bar: 'rgba(220, 235, 254, 0.9)',
    barInk: '#000000',
    corner: '#00ff00',
    cornerEdge: 'rgba(0, 0, 0, 0.7)',
    cornerShadow: 'rgba(0, 0, 0, 0.5)',
  };

  const FONT = '-apple-system, "Helvetica Neue", Helvetica, Arial, Roboto, "Segoe UI", sans-serif';

  // ── Small things ───────────────────────────────────────────────────────────

  function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }
  function norm360(d) { return ((d % 360) + 360) % 360; }
  function pad(n, w = 2) { return String(n).padStart(w, '0'); }

  // Eight points, as Solocator prints them.
  const POINTS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function point8(deg) { return POINTS8[Math.round(norm360(deg) / 45) % 8]; }

  // ── The words ──────────────────────────────────────────────────────────────

  function headingText(deg, ref = 'T') {
    if (!known(deg)) return '';
    const d = Math.round(norm360(deg)) % 360;
    return `${d}°${point8(d)} (${ref === 'M' ? 'M' : 'T'})`;
  }
  function positionText(lat, lon, acc) {
    if (!known(lat) || !known(lon)) return '';
    return `${Number(lat).toFixed(6)}°, ${Number(lon).toFixed(6)}°${known(acc) ? ` ±${Math.max(1, Math.round(acc))}m` : ''}`;
  }
  function altitudeText(m, ref) {
    if (!known(m)) return '';
    return `${Math.round(m)}m${ref ? ` (${ref})` : ''}`;
  }

  // The zones the overlay reader knows by name (PhotoMeta's ZONES), by offset.
  const ZONE_OFFSET = { AEST: '+10:00', AEDT: '+11:00', ACST: '+09:30', ACDT: '+10:30',
                        AWST: '+08:00', AWDT: '+09:00', NZST: '+12:00', NZDT: '+13:00' };
  function fmtOffset(min) {
    const s = min < 0 ? '-' : '+', a = Math.abs(Math.round(min));
    return `${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }

  // The moment the shutter went, as the phone's clock read it: its local time,
  // its offset, the name its zone is printed by, and the instant. `zoneName`
  // is what Intl calls the phone's zone (field-camera.js asks it in en-AU, so
  // Brisbane is AEST); taken only when it is a zone the overlay reader knows
  // and agrees with the clock's own offset — otherwise the offset is printed.
  function moment(date, zoneName) {
    const d = date instanceof Date ? date : new Date(date);
    const offMin = -d.getTimezoneOffset();
    const offset = fmtOffset(offMin);
    const name = String(zoneName || '').toUpperCase();
    const label = ZONE_OFFSET[name] === offset ? name : (offMin === 0 ? 'UTC' : `UTC${offset}`);
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { local, offset, label, iso: d.toISOString(), ms: d.getTime(), sub: pad(d.getMilliseconds(), 3) };
  }

  // `2026-06-24, 12:26:08 AEST` — Solocator's form, which the reader parses.
  function whenText(m) {
    if (!m || !m.local) return '';
    return `${m.local.slice(0, 10)}, ${m.local.slice(11, 19)}${m.label ? ` ${m.label}` : ''}`;
  }

  function stationText(s) {
    if (!s || !s.name) return '';
    const num = String(s.number || '').trim();
    return num && !String(s.name).includes(num) ? `${s.name} (${num})` : String(s.name);
  }

  // Everything the panel prints, as lines. `f` is the facts at the shutter:
  //   heading, headingRef, lat, lon, accuracy, alt, altRef, when (moment()),
  //   station { name, number }, project, locality, caption.
  function lines(f) {
    return {
      heading: headingText(f.heading, f.headingRef),
      position: positionText(f.lat, f.lon, f.accuracy),
      altitude: altitudeText(f.alt, f.altRef),
      // Bottom right, top to bottom: the station, the project, the time.
      right: [stationText(f.station), String(f.project || '').trim(), whenText(f.when)].filter(Boolean),
      // Bottom left, top to bottom: what the photo is of, then where.
      left: [String(f.caption || '').trim(), String(f.locality || '').trim()].filter(Boolean),
    };
  }

  // The panel as text, top band then bottom — what a perfect OCR would read.
  // For the checks, and for nothing else.
  function text(f) {
    const l = lines(f);
    const bar = [l.heading, l.position, l.altitude].filter(Boolean).join('  ');
    return [bar, ...l.right, ...l.left].join('\n');
  }

  // The file's name: floodnet-, the station, the shutter's local time.
  function fileName(f) {
    const slug = String((f.station && f.station.name) || 'photo').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
    const t = (f.when && f.when.local) || '';
    const stamp = t ? `${t.slice(0, 10).replace(/-/g, '')}-${t.slice(11, 19).replace(/:/g, '')}` : 'undated';
    return `floodnet-${slug}-${stamp}.jpg`;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  // Onto any 2-D context the caller has drawn the photograph on — the full
  // frame at the shutter, or the preview over the live picture, which is the
  // same drawing at the preview's size, so what is seen is what is saved.

  function font(ctx, px, weight = 400) { ctx.font = `${weight} ${Math.max(1, px).toFixed(1)}px ${FONT}`; }

  // Text that fits `maxW`: shrunk to 70 % first, then cut with an ellipsis.
  function fitText(ctx, s, px, weight, maxW) {
    font(ctx, px, weight);
    let w = ctx.measureText(s).width;
    if (w <= maxW) return { s, px };
    const smaller = Math.max(px * 0.7, px * maxW / w);
    font(ctx, smaller, weight);
    w = ctx.measureText(s).width;
    if (w <= maxW) return { s, px: smaller };
    let cut = s;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
    return { s: `${cut.trimEnd()}…`, px: smaller };
  }

  function drawRibbon(ctx, W, k, heading) {
    const h = G.ribbonH * k;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, C.ribbonTop);
    grad.addColorStop(1, C.ribbonBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, h);

    const ppd = G.pxPerDeg * k;
    const half = W / 2 / ppd + 5;
    ctx.fillStyle = C.ribbonInk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const first = Math.ceil((heading - half) / 5) * 5;
    for (let deg = first; deg <= heading + half; deg += 5) {
      const x = W / 2 + (deg - heading) * ppd;
      const d = norm360(deg);
      if (d % 10 === 0) ctx.fillRect(x - G.tickW * k / 2, G.tickTop * k, G.tickW * k, (G.tickBottom - G.tickTop) * k);
      else { ctx.beginPath(); ctx.arc(x, G.dotY * k, G.dotR * k, 0, Math.PI * 2); ctx.fill(); }
      if (d % 30 === 0) { font(ctx, G.numPx * k, 400); ctx.fillText(String(d), x, G.numY * k); }
      if (d % 45 === 0) {
        const word = POINTS8[d / 45];
        if (word.length === 1) { font(ctx, G.cardinalPx * k, 700); ctx.fillText(word, x, G.cardinalY * k); }
        else { font(ctx, G.interPx * k, 400); ctx.fillText(word, x, G.interY * k); }
      }
    }
    // The needle: the way the camera faced, at the middle.
    const nw = G.needleW * k, nh = G.needleH * k;
    ctx.fillStyle = C.needleEdge;
    ctx.fillRect(W / 2 - nw / 2 - k, 0, nw + 2 * k, nh + k);
    ctx.fillStyle = C.needle;
    ctx.fillRect(W / 2 - nw / 2, 0, nw, nh);
  }

  // The bar's three little pictures, drawn rather than typed: ❂ and ◉ are
  // missing from more phone fonts than they are in, and a box where the
  // compass rose should be is a stamp that looks broken.
  function roseIcon(ctx, x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, Math.PI * 2); ctx.lineWidth = r * 0.22; ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(x + Math.sin(a) * r * 0.62, y - Math.cos(a) * r * 0.62);
      ctx.lineTo(x + Math.sin(a) * r, y - Math.cos(a) * r);
      ctx.lineWidth = r * 0.24; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, r * 0.22, 0, Math.PI * 2); ctx.fill();
  }
  function targetIcon(ctx, x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, r * 0.86, 0, Math.PI * 2); ctx.lineWidth = r * 0.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r * 0.52, 0, Math.PI * 2); ctx.fill();
  }
  function peakIcon(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.85); ctx.lineTo(x + r * 0.85, y + r * 0.75); ctx.lineTo(x - r * 0.85, y + r * 0.75);
    ctx.closePath(); ctx.fill();
  }

  function drawBar(ctx, W, k, top, l) {
    const h = G.barH * k;
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, top, W, h);
    const parts = [
      l.heading && { icon: roseIcon, s: l.heading },
      l.position && { icon: targetIcon, s: l.position },
      l.altitude && { icon: peakIcon, s: l.altitude },
    ].filter(Boolean);
    if (!parts.length) return;
    // Laid out at the measured size, then scaled down as a whole to fit the
    // width — a portrait photo's bar is narrower than a landscape one's.
    let px = G.barPx * k;
    const measure = size => {
      font(ctx, size, 400);
      const icon = size * 0.8, gap = size * 0.28, sep = size * 0.9;
      return parts.reduce((w, p, i) => w + icon + gap + ctx.measureText(p.s).width + (i ? sep : 0), 0);
    };
    let total = measure(px);
    if (total > W * 0.96) { px *= W * 0.96 / total; total = measure(px); }
    const icon = px * 0.8, gap = px * 0.28, sep = px * 0.9;
    let x = (W - total) / 2;
    // Centred in the bar: the middle of a capital is about 0.36 em above its
    // baseline, which at the measured size puts the baseline where
    // Solocator's is (barBase).
    const mid = top + h / 2;
    const base = mid + px * 0.36;
    ctx.fillStyle = C.barInk;
    ctx.strokeStyle = C.barInk;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    parts.forEach((p, i) => {
      if (i) x += sep;
      p.icon(ctx, x + icon / 2, mid, icon / 2);
      x += icon + gap;
      font(ctx, px, 400);
      ctx.fillText(p.s, x, base);
      x += ctx.measureText(p.s).width;
    });
  }

  // Solocator's green, with a dark edge it does not have: green on a paddock
  // or a canopy is green on green, and the edge is what keeps it legible
  // there. It costs the OCR nothing — the reader keys the band on the text's
  // own saturated hue, and a dark, grey edge falls out with the background.
  function drawCorners(ctx, W, H, k, l) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    const px = G.cornerPx * k;
    const corner = (list, align, x, maxW) => {
      ctx.textAlign = align;
      list.slice().reverse().forEach((s, i) => {
        const f = fitText(ctx, s, px, 400, maxW);
        const y = H - G.cornerBase * k - i * G.cornerLine * k;
        font(ctx, f.px, 400);
        ctx.shadowColor = C.cornerShadow;
        ctx.shadowBlur = 3 * k;
        ctx.strokeStyle = C.cornerEdge;
        ctx.lineWidth = Math.max(1, f.px * 0.12);
        ctx.strokeText(f.s, x, y);
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = C.corner;
        ctx.fillText(f.s, x, y);
      });
    };
    corner(l.left, 'left', G.marginL * k, W * 0.44);
    corner(l.right, 'right', W - G.marginR * k, W * 0.52);
    ctx.restore();
  }

  // The whole panel, onto a context `W` × `H` that already holds the picture.
  function draw(ctx, W, H, f) {
    const k = Math.min(W, H) / REF;
    const l = lines(f);
    ctx.save();
    let top = 0;
    if (known(f.heading)) { drawRibbon(ctx, W, k, norm360(f.heading)); top = G.ribbonH * k; }
    if (l.heading || l.position || l.altitude) drawBar(ctx, W, k, top, l);
    drawCorners(ctx, W, H, k, l);
    ctx.restore();
    return l;
  }

  // ── EXIF ───────────────────────────────────────────────────────────────────
  // A TIFF structure in big-endian order, as an APP1 segment: IFD0 (the
  // description, orientation, software, time and the two pointers), the Exif
  // IFD (the shutter's time and offset, the pixel size) and the GPS IFD. Every
  // value over four bytes goes in the area after its IFD, at an even offset.

  const BYTE = 1, ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, UNDEFINED = 7;

  // UTF-8 by hand: a vm context (the check) has no TextEncoder.
  function utf8(s) {
    const out = [];
    for (const ch of String(s)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  const be16 = v => [(v >>> 8) & 255, v & 255];
  const be32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

  function ascii(tag, s) { const b = utf8(s); b.push(0); return { tag, type: ASCII, count: b.length, bytes: b }; }
  function short(tag, v) { return { tag, type: SHORT, count: 1, bytes: be16(v) }; }
  function long(tag, v) { return { tag, type: LONG, count: 1, bytes: be32(v) }; }
  function bytes(tag, list, type = BYTE) { return { tag, type, count: list.length, bytes: list.slice() }; }
  function rationals(tag, pairs) {
    const b = [];
    for (const [n, d] of pairs) b.push(...be32(Math.max(0, Math.round(n))), ...be32(Math.max(1, Math.round(d))));
    return { tag, type: RATIONAL, count: pairs.length, bytes: b };
  }

  // An IFD at `at` (from the TIFF header): its entries, then their values.
  function ifd(entries, at) {
    const list = entries.slice().sort((a, b) => a.tag - b.tag);
    const head = 2 + list.length * 12 + 4;
    const out = [...be16(list.length)];
    const data = [];
    for (const e of list) {
      out.push(...be16(e.tag), ...be16(e.type), ...be32(e.count));
      if (e.bytes.length <= 4) {
        const v = e.bytes.slice();
        while (v.length < 4) v.push(0);
        out.push(...v);
      } else {
        out.push(...be32(at + head + data.length));
        data.push(...e.bytes);
        if (data.length % 2) data.push(0);
      }
    }
    out.push(0, 0, 0, 0);
    return out.concat(data);
  }

  function dmsRationals(deg) {
    const a = Math.abs(deg);
    const d = Math.floor(a);
    const mFloat = (a - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
  }

  // The TIFF for one photo. `f`: lat, lon, accuracy, alt, heading, headingRef,
  // when (moment()), width, height, description.
  function tiff(f) {
    const w = f.when || null;
    const exifTime = w ? `${w.local.slice(0, 10).replace(/-/g, ':')} ${w.local.slice(11, 19)}` : null;

    const exifEntries = [
      bytes(0x9000, utf8('0232'), UNDEFINED),
      short(0xa001, 1),
    ];
    if (exifTime) {
      exifEntries.push(ascii(0x9003, exifTime), ascii(0x9004, exifTime),
                       ascii(0x9010, w.offset), ascii(0x9011, w.offset), ascii(0x9012, w.offset),
                       ascii(0x9291, w.sub || '000'));
    }
    if (known(f.width) && known(f.height)) exifEntries.push(long(0xa002, f.width), long(0xa003, f.height));

    const gpsEntries = [];
    if (known(f.lat) && known(f.lon)) {
      gpsEntries.push(
        bytes(0x0000, [2, 3, 0, 0]),
        ascii(0x0001, f.lat < 0 ? 'S' : 'N'), rationals(0x0002, dmsRationals(f.lat)),
        ascii(0x0003, f.lon < 0 ? 'W' : 'E'), rationals(0x0004, dmsRationals(f.lon)),
        ascii(0x0012, 'WGS-84'));
      if (known(f.alt)) gpsEntries.push(bytes(0x0005, [f.alt < 0 ? 1 : 0]), rationals(0x0006, [[Math.abs(f.alt) * 100, 100]]));
      if (known(f.heading)) {
        gpsEntries.push(ascii(0x0010, f.headingRef === 'M' ? 'M' : 'T'),
                        rationals(0x0011, [[norm360(f.heading) * 100, 100]]));
      }
      if (known(f.accuracy) && f.accuracy > 0) gpsEntries.push(rationals(0x001f, [[f.accuracy * 100, 100]]));
      if (w && w.iso) {
        // The GPS clock is UTC, by definition.
        const u = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(w.iso);
        if (u) {
          gpsEntries.push(rationals(0x0007, [[+u[4], 1], [+u[5], 1], [+u[6] * 1000 + +(u[7] || '0').padEnd(3, '0').slice(0, 3), 1000]]),
                          ascii(0x001d, `${u[1]}:${u[2]}:${u[3]}`));
        }
      }
    }

    const ifd0Entries = [short(0x0112, 1), ascii(0x0131, f.software || SOFTWARE)];
    if (f.description) ifd0Entries.push(ascii(0x010e, String(f.description).slice(0, 500)));
    if (exifTime) ifd0Entries.push(ascii(0x0132, exifTime));
    // The two pointers are LONGs held in the entry itself, so IFD0's size does
    // not depend on where they point: measured with a nought, then written.
    const withPointers = (exifAt, gpsAt) => {
      const list = ifd0Entries.concat([long(0x8769, exifAt)]);
      if (gpsEntries.length) list.push(long(0x8825, gpsAt));
      return list;
    };
    const ifd0Size = ifd(withPointers(0, 0), 8).length;
    const exifAt = 8 + ifd0Size;
    const exifIfd = ifd(exifEntries, exifAt);
    const gpsAt = exifAt + exifIfd.length;
    const gpsIfd = gpsEntries.length ? ifd(gpsEntries, gpsAt) : [];
    const head = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08];
    return Uint8Array.from(head.concat(ifd(withPointers(exifAt, gpsAt), 8), exifIfd, gpsIfd));
  }

  // The APP1 segment: its marker, its length, "Exif\0\0" and the TIFF.
  function app1(f) {
    const t = tiff(f);
    const len = 2 + 6 + t.length;
    if (len > 0xffff) throw new Error('the EXIF block is too big for one segment');
    const out = new Uint8Array(2 + len);
    out.set([0xff, 0xe1, (len >> 8) & 255, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0], 0);
    out.set(t, 10);
    return out;
  }

  // A JPEG with the APP1 put in: after the start-of-image, and after a JFIF
  // APP0 where the encoder wrote one (exiftool's order — every reader reads
  // either). An Exif APP1 already there is replaced, never doubled.
  function withExif(jpeg, seg) {
    const b = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
    const pieces = [b.subarray(0, 2)];
    let o = 2;
    const lenAt = p => (b[p + 2] << 8) | b[p + 3];
    if (o + 4 <= b.length && b[o] === 0xff && b[o + 1] === 0xe0) {
      pieces.push(b.subarray(o, o + 2 + lenAt(o)));
      o += 2 + lenAt(o);
    }
    pieces.push(seg);
    // The rest of the header, segment by segment, less any Exif APP1; from
    // the start of the scan on, the bytes as they are.
    while (o + 4 <= b.length && b[o] === 0xff) {
      const m = b[o + 1];
      if (m === 0xda || m === 0xd9 || m === 0xff) break;
      const end = o + 2 + lenAt(o);
      if (lenAt(o) < 2 || end > b.length) break;
      const exif = m === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66
        && b[o + 8] === 0 && b[o + 9] === 0;
      if (!exif) pieces.push(b.subarray(o, end));
      o = end;
    }
    pieces.push(b.subarray(o));
    const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) { out.set(p, at); at += p.length; }
    return out;
  }

  return {
    SOFTWARE, GEOMETRY: G, COLOURS: C,
    point8, headingText, positionText, altitudeText, moment, whenText, stationText,
    lines, text, fileName, draw, tiff, app1, withExif,
  };
})();

if (typeof window !== 'undefined') window.PhotoStamp = PhotoStamp;
// test/camera.mjs require()s this same file — see the header. Guarded so the
// browser, where `module` is undefined, never runs it; constrains nothing below.
if (typeof module !== 'undefined' && module.exports) module.exports = PhotoStamp;
