// MegaNet — field-photos.js
//
//   FieldPhotos   the Field Photos tab — photos in, by the handful or the
//                 folderful, each placed where it was taken — and the viewer
//                 every other part of the app opens a photo in: a carousel
//                 over the photos taken at one spot, one station or one view.
//
// After core.js, photo-meta.js, photo-zip.js, photo-equipment.js and
// datastore.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce,
// registerTabTeardown, registerLiveMap, removeMap, KM_PER_DEG_LAT, kmPerDegLon,
// bearingDeg and fmtKm; to photo-meta.js for PhotoMeta; to photo-zip.js for
// PhotoZip; to datastore.js for dbSelect, dbRpc, dbCanWrite, dbUploadObject,
// dbSignedUrl, dbSignedUrls and dbRemoveObject; to auth.js for Auth; to
// places.js for Places.parse; to map-controls.js for makeBaseLayers (the
// viewer's move map, on Leaflet's `L`); and to app.js for switchTab,
// showStationCard, prepareSearch and stationMatchesSearch. Across to
// digital-twin.js and map-photos.js, which draw what this file holds and are
// told when it changes, and to photo-review.js, whose Review panel is drawn on
// this tab and reads this file's queue. Every one of those is a runtime call
// from inside a function here; nothing executes at load (`npm run toplevel`).
//
// ── Where a photo goes ───────────────────────────────────────────────────────
//
// Each file dropped on the tab is read before anything is sent:
//
//   1. its SHA-256, so the same bytes twice are one photo (asked of the
//      database before a byte is uploaded, and enforced by it after);
//   2. what it says about itself — EXIF, XMP — through PhotoMeta.read, which
//      needs no pixels and so works on a HEIC in a browser that cannot draw
//      one;
//   3. if that holds no position, what the picture *shows*: the overlay a field
//      camera app burned into it, read by OCR (PhotoMeta.ocrImage). This is the
//      case a photo that has been through Messages or a chat app is in — the
//      EXIF is gone and the overlay is not;
//   4. the station it is of: the nearest within a kilometre, the database's own
//      rule (meganet.field_photo_station_for), worked out here from the list
//      already in memory so the table can show it before the upload;
//   5. a 480 px thumbnail, so a grid of sixty or a twin's filmstrip is not
//      sixty phone photos over a paddock's signal.
//
// Then nothing happens until somebody presses Upload: a position read off a
// picture is a reading, and the table is where it is checked. A photo nothing
// could place still uploads — it lands in the Unplaced list, and is placed by
// hand, by coordinates or at a station.
//
// Bytes first, then the row, and a refused row takes its bytes down again —
// attachments.js's order and its reason. A HEIC is converted to JPEG, because a
// photo stored as something Chrome cannot show is a photo half the crew cannot
// see: drawn by the browser where the browser can (Safari), and by libheif,
// fetched for the purpose, where it cannot (Chrome, Firefox — see "A HEIC the
// browser cannot draw"). The hash is of the file as it arrived, so dropping the
// same HEIC again is still the same photo.
//
// ── A zip of them ────────────────────────────────────────────────────────────
//
// A .zip dropped, chosen or found in a chosen folder is a pack: opened by
// PhotoZip, and every photo in it queued as if it had been dropped on its own
// — the same hash, reading, placing and upload — with a note saying which zip
// it came out of, and one line for the pack saying how many photos it held
// and what was left out and why. The queue holds an entry, not its bytes: a
// photo is unzipped when the queue reads it, let go once it has been read, and
// unzipped again to upload it, so a pack of two hundred is never two hundred
// photos in memory (photo-zip.js's head has the rest, and the zip-bomb rules).
//
// ── What became of each one ──────────────────────────────────────────────────
//
// When an Upload finishes, a row per file goes to meganet.log_field_photo_upload
// (0036) — imported, unplaced, already in MegaNet, refused or failed, and why —
// so the Review panel (photo-review.js) can say what happened to a batch after
// the tab that sent it has gone. Best-effort: a log that cannot be written is
// said on the Review panel, and never fails the upload it was about.
//
// ── Who may see them ─────────────────────────────────────────────────────────
//
// Editors, signed in: the rows, the positions and the bytes (0035's head says
// why). Signed out, the tab says so and the twin and the map draw nothing.
//
// Issue: the Field Photos epic. Schema: db/migrations/0035_field_photos.sql,
// 0036_photo_review.sql. Bucket: tools/storage_bucket.sql. The whole of it:
// docs/field-photos.md.

const FieldPhotos = (function () {

  const BUCKET = 'field-photos';
  const SIGNED_FOR = 3600;         // a thumbnail's URL outlives a session, and not by much
  const THUMB_PX = 480;
  const MATCH_M = 1000;            // the nearest station within this is the one it is of
  const NEAR_KM = 25;              // stations offered as a photo's station, around it
  const AT_ONCE = 2;               // uploads in flight
  const PAGE = 60;                 // photos in one page of the library
  const SPOT_M = 3;                // photos this close are "taken there", one marker
  const ROUGH_M = 7;               // a fix whose ± is wider than this is flagged, in red
  const FOV_ASSUMED = 60;          // a compass wedge's width when the lens did not say
  const CONE_M = 20;               // the view cone's length on the move map, metres

  // What the library, the twin and the map ask for — everything but `meta`,
  // which holds the OCR's raw readings and is the viewer's to fetch, not a
  // grid's. The three things from it that are needed everywhere come out by
  // path — the camera app among them, since whether a photo's ± can be read
  // off its overlay (PhotoMeta.printsAccuracy) is asked of every photo at a
  // spot, not only the one on screen.
  const COLS = 'id,storage_path,thumb_path,content_type,byte_size,width,height,title,caption,'
             + 'taken_at,taken_local,taken_source,lat,lon,placement,accuracy_m,altitude_m,altitude_ref,'
             + 'heading_deg,heading_ref,pitch_deg,fov_deg,station_id,station_auto,origin,uploaded_by,'
             + 'created_at,updated_at,ocr_confidence:meta->ocr->>confidence,zone_source:meta->taken->>zone_source,'
             + 'camera_software:meta->camera->>software';

  const PLACEMENT = {
    exif:    { chip: 'camera GPS',        long: 'the camera\'s own GPS, written into the file' },
    xmp:     { chip: 'camera GPS',        long: 'the camera\'s own GPS, in the file\'s XMP' },
    ocr:     { chip: 'read off the photo', long: 'read off the picture\'s overlay, by OCR' },
    manual:  { chip: 'placed by hand',    long: 'placed by hand' },
    station: { chip: 'at the station',    long: 'put at the station\'s recorded position' },
  };

  const S = () => state.photos;
  let seq = 0;

  // ── Small things ───────────────────────────────────────────────────────────

  function stations() { return (state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => s.id === id) || null; }
  // A number that is there — `known(null)` is true, and a column that is
  // null (no position, no heading, no accuracy) is not known, never nought.
  function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }
  function located(s) { return !!s && known(s.lat) && known(s.lon); }
  function signedIn() { return typeof dbCanWrite === 'function' && dbCanWrite(); }

  // Metres between two points, equirectangular about the first: centimetres
  // at a kilometre, which is the only scale anything here measures at.
  function metres(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * kmPerDegLon(lat1) * 1000, dy = (lat2 - lat1) * KM_PER_DEG_LAT * 1000;
    return Math.hypot(dx, dy);
  }

  // The nearest located station within `within` metres — the database's rule
  // for a photo nobody gave a station, restated so the table can say it first.
  function nearestStation(lat, lon, within = MATCH_M) {
    if (!known(lat) || !known(lon)) return null;
    let best = null, bd = Infinity;
    for (const s of stations()) {
      if (!located(s)) continue;
      if (Math.abs(s.lat - lat) > 0.05 || Math.abs(s.lon - lon) > 0.06) continue;
      const d = metres(lat, lon, s.lat, s.lon);
      if (d <= within && (d < bd || (d === bd && s.id < best.id))) { best = s; bd = d; }
    }
    return best ? { station: best, m: bd } : null;
  }

  // Stations around a point, nearest first — what a photo's station can be
  // changed to without a search.
  function stationsAround(lat, lon, km = NEAR_KM, cap = 8) {
    if (!known(lat) || !known(lon)) return [];
    return stations().filter(located)
      .map(s => ({ s, m: metres(lat, lon, s.lat, s.lon) }))
      .filter(x => x.m <= km * 1000)
      .sort((a, b) => a.m - b.m)
      .slice(0, cap);
  }

  // Where the network is, for the one guess the overlay parser is allowed to
  // make — which side of the equator an unsigned latitude is on.
  function home() {
    const st = stations().filter(located);
    if (!st.length) return { lat: -25, lon: 145, km: 3000 };
    const lats = st.map(s => s.lat).sort((a, b) => a - b), lons = st.map(s => s.lon).sort((a, b) => a - b);
    return { lat: lats[lats.length >> 1], lon: lons[lons.length >> 1], km: 3000 };
  }

  function mb(bytes) {
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }
  function extensionOf(name) {
    const bits = String(name || '').toLowerCase().split('.');
    return bits.length > 1 ? bits.pop() : '';
  }
  function fmtCoord(lat, lon) { return `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`; }
  function fmtM(m) { return m < 1000 ? `${Math.round(m)} m` : fmtKm(m / 1000); }
  function compass(deg) {
    return typeof PhotoMeta !== 'undefined' ? PhotoMeta.compassPoint(deg, 16) : '';
  }
  function headingText(deg, ref) {
    if (!known(deg)) return '';
    return `${Math.round(deg)}° ${compass(deg)}${ref === 'M' ? ' (magnetic)' : ref === 'T' ? ' (true)' : ''}`;
  }
  // Degrees between two headings, the short way round.
  function angleOff(a, b) { const d = Math.abs((((a - b) % 360) + 360) % 360); return d > 180 ? 360 - d : d; }

  // A fix's ±, as the viewer and the queue say it: to the metre, and red when
  // it is wider than ROUGH_M — judged on the number shown, so a fix that
  // reads ±7 m is never the red one. The words say it too, for a reader who
  // does not see the red.
  function rough(m) { return known(m) && Math.round(+m) > ROUGH_M; }
  function accHtml(m) {
    if (!known(m)) return '';
    const n = Math.round(+m);
    return rough(m)
      ? ` <span class="fp-acc fp-acc-rough" title="A rough fix: the GPS said ±${n} m, wider than ${ROUGH_M} m, so the photo may have been taken well away from this point. Move… puts it where it was taken.">±${n} m<span class="sr-only"> — a rough fix, wider than ${ROUGH_M} m</span></span>`
      : ` <span class="fp-acc">±${n} m</span>`;
  }
  // Time order, the one spots() and the twin's query keep.
  function byTaken(a, b) { return String(a.taken_at || a.created_at).localeCompare(String(b.taken_at || b.created_at)); }

  // A time as the camera's own clock read, with its zone — the photo's local
  // time, not the viewer's. `local` is YYYY-MM-DDTHH:MM:SS.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtLocal(local) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local || '');
    if (!m) return '';
    return `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}, ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}`;
  }
  function offsetOf(iso, local) {
    const a = Date.parse(iso), m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local || '');
    if (!isFinite(a) || !m) return null;
    const l = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const min = Math.round((l - a) / 60000);
    const s = min < 0 ? '-' : '+', abs = Math.abs(min);
    return `UTC${s}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  }
  function whenText(row) {
    if (row.taken_local) {
      const off = row.taken_at ? offsetOf(row.taken_at, row.taken_local) : null;
      return `${fmtLocal(row.taken_local)}${off ? ` ${off}` : ''}`;
    }
    if (row.taken_at) return new Date(row.taken_at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
    return '';
  }

  // crypto.randomUUID where it exists; attachments.js's fallback where not.
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto.getRandomValues(b)
      : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // SHA-256 of the file as it arrived. SubtleCrypto everywhere this app is
  // served from; a page opened some way that is not a secure context still
  // gets a hash rather than a refusal, from the same function in plain JS.
  async function sha256(buf) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const d = await crypto.subtle.digest('SHA-256', buf);
      return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    return sha256js(new Uint8Array(buf));
  }
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function sha256js(bytes) {
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(total);
    m.set(bytes); m[n] = 0x80;
    const bits = n * 8;
    m[total - 4] = (bits >>> 24) & 255; m[total - 3] = (bits >>> 16) & 255; m[total - 2] = (bits >>> 8) & 255; m[total - 1] = bits & 255;
    m[total - 5] = Math.floor(bits / 4294967296) & 255;
    const w = new Uint32Array(64);
    const r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[o + i * 4] << 24) | (m[o + i * 4 + 1] << 16) | (m[o + i * 4 + 2] << 8) | m[o + i * 4 + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  // ── What may be uploaded ───────────────────────────────────────────────────
  // meganet.attachment_type, the pictures in it — the same vocabulary the forms'
  // attachments use (0010), so a new camera format is one insert for both.

  function loadTypes() {
    const s = S();
    if (s.types || s.typesLoading) return s.typesP || Promise.resolve(s.types);
    s.typesLoading = true;
    s.typesP = dbSelect('attachment_type?select=*&order=ord')
      .then(rows => { s.types = rows.filter(t => String(t.content_type).startsWith('image/')); s.typesError = null; })
      .catch(err => { s.typesError = (err && err.message) || String(err); })
      .finally(() => { s.typesLoading = false; repaint(); });
    return s.typesP;
  }
  function typeFor(file, format) {
    const types = S().types || [];
    const byFormat = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', avif: 'image/avif' }[format];
    const mime = (file.type || byFormat || '').toLowerCase();
    return types.find(t => t.content_type === mime)
        || types.find(t => (t.extensions || []).includes(extensionOf(file.name)))
        || (byFormat ? types.find(t => t.content_type === byFormat) : null)
        || null;
  }
  function isHeic(file, format) {
    return format === 'heic' || /image\/hei[cf]/i.test(file.type || '') || /^(heic|heif)$/.test(extensionOf(file.name));
  }

  // ── A HEIC the browser cannot draw (#202) ──────────────────────────────────
  // iPhones save HEIC. Safari draws one and so goes the ordinary way; Chrome
  // and Firefox draw none, on any platform — and photos copied off an iPhone
  // onto a Windows PC and dropped into Chrome is exactly how a crew meets one.
  // Its position was never the problem (PhotoMeta.read needs no pixels); the
  // thumbnail, the OCR and the JPEG it is stored as all need the picture.
  //
  // So the picture comes from libheif — the decoder the Dropbox sync's
  // heic-decode wraps, as WebAssembly — on the OCR engine's terms: fetched on
  // the first HEIC the browser cannot draw and never for a session without
  // one, from unpkg (the host the Bureau's filter allows for Leaflet), pinned,
  // and run in a worker that is let go after a quiet minute. A worker because
  // a phone photo's decode is a second or two of work and a heap of a couple
  // of hundred MB that WebAssembly never hands back; in a worker the tab stays
  // live while it runs and the memory goes when the worker does.
  //
  // The build is libheif-js's WebAssembly one: 29 kB of glue and 469 kB of
  // WebAssembly, gzipped, against 698 kB for the bundle that carries the same
  // WebAssembly as base64 — and the pure-JavaScript build is slower still.
  // LGPL-3.0, which is fine for a library loaded separately and unmodified.
  // That build compiles its WebAssembly synchronously and cannot fetch it
  // for itself from a Blob worker (it looks beside the script, which is a
  // blob: URL), so the worker fetches it and hands it over as `wasmBinary`.
  //
  // It decodes the primary image — the one Safari would draw — with the
  // container's rotation and mirroring applied, to RGBA; the worker sends the
  // pixels back and they become an ImageBitmap, and from there it is a HEIC
  // Safari drew. The version is the one tools/field-photos' lockfile resolves
  // heic-decode's libheif-js to, so a HEIC dropped here and one the Dropbox
  // sync imports are decoded by the same libheif. The check serves exactly
  // this version (test/lib/network.mjs) and aborts any other.
  const HEIF_VER  = '1.23.2';
  const HEIF_LIB  = `https://unpkg.com/libheif-js@${HEIF_VER}/libheif-wasm/libheif.js`;
  const HEIF_WASM = `https://unpkg.com/libheif-js@${HEIF_VER}/libheif-wasm/libheif.wasm`;
  const HEIF_IDLE_MS = 60000;

  // The worker's whole program, which is why it is a string: a classic worker
  // made from a Blob may importScripts from another origin, and the library's
  // `libheif` factory is defined there and nowhere in the page. A failure says
  // which stage it was in, because "the decoder could not be had" and "this
  // file has no picture in it" are different advice.
  const HEIF_WORKER = `
    let lib = null;
    self.onmessage = async (e) => {
      const { id, src, wasm, buf } = e.data;
      let stage = 'load';
      try {
        if (!lib) {
          importScripts(src);
          const res = await fetch(wasm);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          lib = self.libheif({ wasmBinary: await res.arrayBuffer() });
        }
        stage = 'decode';
        const dec = new lib.HeifDecoder();
        let imgs = [];
        try {
          imgs = dec.decode(new Uint8Array(buf));
          const img = imgs.find(i => i.is_primary()) || imgs[0];
          if (!img) throw new Error('no picture in it could be read');
          const width = img.get_width(), height = img.get_height();
          const out = { data: new Uint8ClampedArray(width * height * 4), width, height };
          if (!(await new Promise(done => img.display(out, done)))) throw new Error('its picture could not be decoded');
          self.postMessage({ id, ok: true, width, height, data: out.data.buffer }, [out.data.buffer]);
        } finally {
          for (const i of imgs) { try { i.free(); } catch (_) {} }
          try { if (dec.decoder) lib.heif_context_free(dec.decoder); } catch (_) {}
        }
      } catch (err) {
        self.postMessage({ id, ok: false, stage, error: (err && err.message) || String(err) });
      }
    };`;

  let heif = null;          // { worker, url, waiting: Map(id → {resolve, reject}) } while there is one
  let heifSeq = 0, heifIdle = 0;

  function heifWorker() {
    if (heif) return heif;
    const url = URL.createObjectURL(new Blob([HEIF_WORKER], { type: 'text/javascript' }));
    const h = { worker: new Worker(url), url, waiting: new Map() };
    h.worker.onmessage = e => {
      const m = e.data || {};
      const w = h.waiting.get(m.id);
      if (!w) return;
      h.waiting.delete(m.id);
      if (m.ok) w.resolve(m); else w.reject(m);
    };
    // The worker itself died — it could not be made, or threw outside a
    // message. Everything waiting is told, and the next HEIC starts afresh.
    h.worker.onerror = e => {
      if (e && e.preventDefault) e.preventDefault();
      for (const w of h.waiting.values()) w.reject({ stage: 'load', error: (e && e.message) || 'the decoder stopped' });
      h.waiting.clear();
      releaseHeif(true);
    };
    heif = h;
    return h;
  }

  function releaseHeif(now) {
    const h = heif;
    if (!h || (!now && h.waiting.size)) return;
    heif = null;
    for (const w of h.waiting.values()) w.reject({ stage: 'load', error: 'the decoder was stopped' });
    h.waiting.clear();
    try { h.worker.terminate(); } catch (_) { /* already gone */ }
    URL.revokeObjectURL(h.url);
  }

  // The picture of a HEIC, as ImageData, or an Error saying what went wrong in
  // words the queue can show.
  async function decodeHeic(buf) {
    clearTimeout(heifIdle);
    const h = heifWorker();
    const id = ++heifSeq;
    try {
      const m = await new Promise((resolve, reject) => {
        h.waiting.set(id, { resolve, reject });
        h.worker.postMessage({ id, src: HEIF_LIB, wasm: HEIF_WASM, buf }, [buf]);
      });
      return new ImageData(new Uint8ClampedArray(m.data), m.width, m.height);
    } catch (m) {
      if (m instanceof Error) throw m;
      if (m.stage === 'load') {
        // Remembered as a failure, not as an answer: offline for a moment is
        // the common case, so the next HEIC asks again.
        releaseHeif(true);
        throw new Error(`this browser cannot draw HEIC photos, and the decoder that reads them could not be fetched (${m.error}). `
          + 'Try again when online — or on an iPhone, Settings → Camera → Formats → Most Compatible saves JPEGs');
      }
      throw new Error(`the HEIC could not be decoded — ${m.error}; it may be damaged or cut short`);
    } finally {
      clearTimeout(heifIdle);
      heifIdle = setTimeout(() => releaseHeif(false), HEIF_IDLE_MS);
    }
  }
  function looksLikeImage(file) {
    return /^image\//.test(file.type || '') || /^(jpe?g|png|webp|heic|heif)$/.test(extensionOf(file.name));
  }

  // ── The library ────────────────────────────────────────────────────────────
  // Every row this session has seen is kept by id, whichever door it came in
  // by — the library, the twin, the map, an upload — so the viewer can open any
  // of them without asking again, and an edit made in one place is the row the
  // others draw.

  function keep(rows) {
    const by = S().byId;
    for (const r of rows || []) if (r && r.id) by[r.id] = Object.assign(by[r.id] || {}, r);
    return rows;
  }

  function libQuery() {
    const f = S().filter;
    let q = `field_photo?select=${COLS}&order=taken_at.desc.nullslast,created_at.desc&limit=${S().libLimit}`;
    if (f.show === 'unplaced') q += '&lat=is.null';
    else if (f.show === 'station' && f.station) q += `&station_id=eq.${encodeURIComponent(f.station)}`;
    else if (f.show === 'dropbox') q += '&origin=eq.dropbox';
    else if (f.show === 'gdrive') q += '&origin=eq.gdrive';
    return q;
  }

  function loadLib(force) {
    const s = S();
    if (!signedIn()) { s.lib = null; s.libError = null; return; }
    const q = libQuery();
    if (!force && (s.libKey === q) && (s.lib || s.libLoading)) return;
    s.libKey = q;
    s.libLoading = true;
    s.libError = null;
    repaintLib();
    dbSelect(q)
      .then(rows => { if (S().libKey !== q) return; s.lib = keep(rows); s.libLoading = false; repaintLib(); })
      .catch(err => { if (S().libKey !== q) return; s.libLoading = false; s.lib = []; s.libError = (err && err.message) || String(err); repaintLib(); });
    // The unplaced count rides along, because the filter chip shows it.
    dbSelect('field_photo?select=id&lat=is.null&limit=1000')
      .then(rows => { s.unplacedCount = rows.length; repaintFilter(); })
      .catch(() => {});
  }

  function loadSync() {
    const s = S();
    if (!signedIn()) { s.sync = null; return; }
    dbSelect('field_photo_sync?select=*')
      .then(rows => { s.sync = rows; s.syncError = null; repaintSync(); })
      .catch(err => { s.sync = []; s.syncError = (err && err.message) || String(err); repaintSync(); });
  }

  // Photos inside a box — what the twin and the map ask for. Cached per box for
  // a minute and forgotten whenever a photo changes, so a map panned back and
  // forth is not a stream of requests and an upload shows up at once.
  function inBox(box, { limit = 500 } = {}) {
    if (!signedIn()) return Promise.resolve([]);
    const r6 = v => Number(v).toFixed(5);
    const key = `${r6(box.south)},${r6(box.west)},${r6(box.north)},${r6(box.east)}|${limit}`;
    const c = S().near[key];
    if (c && Date.now() - c.at < 60000) return c.p;
    const q = `field_photo?select=${COLS}&lat=gte.${r6(box.south)}&lat=lte.${r6(box.north)}`
            + `&lon=gte.${r6(box.west)}&lon=lte.${r6(box.east)}&order=taken_at.asc.nullslast&limit=${limit}`;
    const p = dbSelect(q).then(keep).catch(err => { delete S().near[key]; throw err; });
    S().near[key] = { at: Date.now(), p };
    return p;
  }

  // Photos that stand within `m` metres of each other are one spot — the
  // twin's marker, the map's pin, and the carousel either one opens. Greedy
  // about the first photo of each spot, in time order, which is stable as
  // photos are added.
  function spots(rows, m = SPOT_M) {
    const out = [];
    for (const r of rows) {
      if (!known(r.lat) || !known(r.lon)) continue;
      let spot = out.find(g => metres(g.lat, g.lon, r.lat, r.lon) <= m);
      if (!spot) { spot = { lat: +r.lat, lon: +r.lon, rows: [] }; out.push(spot); }
      spot.rows.push(r);
    }
    for (const g of out) {
      g.rows.sort(byTaken);
      // Every way the camera faced from here — two photos a few seconds apart,
      // one up the reach and one down it, are one spot with two views — each
      // once, to the nearest five degrees.
      g.views = [];
      for (const r of g.rows) {
        if (!known(r.heading_deg)) continue;
        const h = +r.heading_deg;
        if (g.views.some(x => Math.abs(((x.heading - h + 540) % 360) - 180) < 5)) continue;
        g.views.push({ heading: h, fov: known(r.fov_deg) ? +r.fov_deg : null, pitch: known(r.pitch_deg) ? +r.pitch_deg : null });
      }
      const first = g.views[0];
      g.heading = first ? first.heading : null;
      g.fov = first ? first.fov : null;
      g.pitch = first ? first.pitch : null;
      g.ids = g.rows.map(r => r.id);
    }
    return out;
  }

  // Something changed: forget what was cached and tell whoever draws photos.
  function changed() {
    S().near = {};
    S().libKey = '';
    if (state.activeTab === 'photos') loadLib(true);
    try { if (typeof DigitalTwin !== 'undefined' && DigitalTwin.photosChanged) DigitalTwin.photosChanged(); } catch (_) { /* its own problem */ }
    try { if (typeof MapPhotos !== 'undefined' && MapPhotos.refresh) MapPhotos.refresh(); } catch (_) { /* ditto */ }
  }

  // ── Signed URLs ────────────────────────────────────────────────────────────

  function urlFor(path) {
    const c = path && S().urls[path];
    return c && Date.now() - c.at < (SIGNED_FOR - 120) * 1000 ? c.url : null;
  }
  async function sign(paths) {
    const want = [...new Set(paths.filter(p => p && !urlFor(p)))];
    if (want.length) {
      let got = {};
      try {
        got = typeof dbSignedUrls === 'function' ? await dbSignedUrls(BUCKET, want, SIGNED_FOR) : {};
      } catch (_) { got = {}; }
      // Whatever the batch did not sign, one at a time — a proxy that does not
      // pass the batch form through still gets thumbnails.
      for (const p of want) {
        if (!got[p]) { try { got[p] = await dbSignedUrl(BUCKET, p, SIGNED_FOR); } catch (_) { /* left unsigned */ } }
      }
      const now = Date.now();
      for (const [p, url] of Object.entries(got)) if (url) S().urls[p] = { url, at: now };
    }
    return paths.map(urlFor);
  }
  function thumbOf(row) { return row.thumb_path || row.storage_path; }

  // Fill every <img data-fp-src> on the page, in one signing request.
  function paintThumbs(root = document) {
    const imgs = [...root.querySelectorAll('img[data-fp-src]')];
    if (!imgs.length) return;
    const paths = imgs.map(i => i.dataset.fpSrc);
    sign(paths).then(urls => {
      imgs.forEach((img, i) => {
        if (urls[i] && img.dataset.fpSrc === paths[i]) img.src = urls[i];
        else if (!urls[i]) img.classList.add('fp-thumb-missing');
      });
    });
  }

  // ── The queue ──────────────────────────────────────────────────────────────

  // Photos, and zips of them, by the handful — dropped, chosen, or found in a
  // chosen folder. A zip is opened in the background (openPack) and its
  // photos join the queue behind the loose ones.
  function addFiles(list) {
    const all = Array.from(list || []);
    const zips = typeof PhotoZip !== 'undefined' ? all.filter(f => PhotoZip.isZip(f)) : [];
    const loose = all.filter(f => !zips.includes(f));
    const files = loose.filter(looksLikeImage);
    const skipped = loose.length - files.length;
    if (!files.length && !zips.length) {
      say(skipped ? 'None of those are photos this tab reads (JPEG, PNG, WebP or HEIC), or zips of them.' : '', 'warn');
      return;
    }
    const s = S();
    for (const file of files) {
      s.queue.push({ key: `q${++seq}`, file, name: file.name, size: file.size, status: 'waiting', note: '' });
    }
    const bits = [];
    if (files.length) bits.push(`${files.length} photo${files.length === 1 ? '' : 's'} added`);
    if (zips.length) bits.push(`${zips.length} zip${zips.length === 1 ? '' : 's'} being opened`);
    say(`${bits.join(' and ')}${skipped ? ` — ${skipped} file${skipped === 1 ? ' was' : 's were'} not a photo and ${skipped === 1 ? 'was' : 'were'} left out` : ''}. Reading them…`);
    for (const z of zips) openPack(z);
    repaintQueue();
    readQueue();
  }

  // ── A zip pack ─────────────────────────────────────────────────────────────
  // Opened, and every photo in it queued as an entry to be unzipped when the
  // queue reaches it — the same queue, read one at a time, so the pack's
  // photos are read, placed and uploaded exactly as dropped ones are. The
  // pack keeps its own line: how many photos, what was left out and why, or
  // why the whole zip was.
  async function openPack(file) {
    const s = S();
    const pack = { key: `z${++seq}`, name: file.name, size: file.size, status: 'opening', photos: 0,
                   leftOut: [], junk: 0, note: 'Opening…' };
    packs().push(pack);
    repaintQueue();
    try {
      // The largest a photo may be is the largest attachment_type allows, when
      // that list is on hand; PhotoZip's own 24 MB when it is not.
      await loadTypes();
      const most = Math.max(0, ...(s.types || []).map(t => +t.max_bytes || 0));
      const z = await PhotoZip.open(file, { limits: most ? { entry: most } : {} });
      pack.status = 'open';
      pack.photos = z.photos.length;
      pack.leftOut = z.leftOut;
      pack.junk = z.junk;
      for (const entry of z.photos) {
        s.queue.push({ key: `q${++seq}`, file: null, zip: { blob: file, entry }, pack: pack.key, from: file.name,
                       name: entry.name, size: entry.usize, status: 'waiting', note: '' });
      }
      pack.note = packNote(pack);
    } catch (err) {
      pack.status = 'refused';
      pack.note = `Not opened — ${(err && err.message) || String(err)}.`;
    }
    announce(`${file.name}: ${pack.note}`);
    repaintQueue();
    readQueue();
  }

  function packNote(pack) {
    const bits = [`${pack.photos} photo${pack.photos === 1 ? '' : 's'} found`];
    if (pack.leftOut.length) {
      const why = {};
      for (const l of pack.leftOut) (why[l.why] = why[l.why] || []).push(l.name);
      bits.push(`${pack.leftOut.length} left out: ${Object.entries(why).map(([w, names]) =>
        `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} (${w})`).join('; ')}`);
    }
    if (pack.junk) bits.push(`${pack.junk} system file${pack.junk === 1 ? '' : 's'} skipped (__MACOSX, .DS_Store, Thumbs.db)`);
    return `${bits.join('; ')}.`;
  }

  // The file a queue item is: itself, or its zip entry unzipped — checked
  // against the zip's own size and checksum on the way (PhotoZip.file).
  function fileOf(item) {
    if (item.file) return Promise.resolve(item.file);
    if (item.zip) return PhotoZip.file(item.zip.blob, item.zip.entry);
    return Promise.reject(new Error('the file has gone from this page — add it again'));
  }

  // Read the queue one photo at a time: decoding a phone photo is 50 MB of
  // pixels, and two of those at once on a phone is how a tab gets killed.
  async function readQueue() {
    const s = S();
    if (s.reading) return;
    s.reading = true;
    try {
      await loadTypes();
      for (;;) {
        const item = s.queue.find(i => i.status === 'waiting');
        if (!item) break;
        try { await readOne(item); }
        catch (err) { item.status = 'refused'; item.readAt = Date.now(); item.note = `Refused — ${(err && err.message) || String(err)}.`; }
        repaintQueue();
      }
    } finally {
      s.reading = false;
    }
    const read = s.queue.filter(i => i.readAt && !i.announced);
    if (read.length) {
      read.forEach(i => { i.announced = true; });
      const by = k => read.filter(i => i.pos && i.pos.placement === k).length;
      const gps = by('exif') + by('xmp'), ocr = by('ocr'), none = read.filter(i => !i.pos && i.status !== 'refused').length;
      const refused = read.filter(i => i.status === 'refused').length;
      const bits = [];
      if (gps) bits.push(`${gps} placed from the camera's GPS`);
      if (ocr) bits.push(`${ocr} placed from the position printed on the photo`);
      if (none) bits.push(`${none} not placed — place ${none === 1 ? 'it' : 'them'} by hand or upload unplaced`);
      if (refused) bits.push(`${refused} refused`);
      say(`${read.length} photo${read.length === 1 ? '' : 's'} read: ${bits.join('; ')}. Check the positions, then press Upload.`, none || refused ? 'warn' : 'ok');
      announce(`${read.length} photos read — ${bits.join('; ')}`);
    }
    repaintQueue();
  }

  async function readOne(item) {
    item.status = 'reading';
    item.note = item.zip ? `Unzipping it from ${item.from}…` : 'Reading the file…';
    repaintQueue();

    const file = await fileOf(item);
    if (item.zip) { item.note = 'Reading the file…'; repaintQueueRow(item); }
    item.type = file.type || '';
    const buf = await file.arrayBuffer();
    item.sha = await sha256(buf);
    const meta = PhotoMeta.read(buf);
    item.meta = meta;

    const type = typeFor(file, meta.format);
    const heic = isHeic(file, meta.format);
    if (!type && !heic) throw new Error(`${file.type || extensionOf(file.name) || 'that'} is not a kind of photo MegaNet stores`);
    if (S().queue.some(o => o !== item && o.sha === item.sha && o.status !== 'refused')) {
      throw new Error('the same photo is already in this list');
    }

    // The pixels: for the thumbnail, for the OCR, and for a HEIC's JPEG copy.
    // Upright by its EXIF orientation, asked for by name; a browser that does
    // not take the option does the same by default.
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) { try { bmp = await createImageBitmap(file); } catch (__) { bmp = null; } }
    item.decoder = bmp ? 'browser' : null;
    // A HEIC this browser cannot draw is drawn by libheif instead, upright by
    // the container's own rotation (which is what a HEIC's reader goes by, not
    // the EXIF's), and from here on it is a HEIC Safari drew: the same
    // thumbnail, the same OCR, the same JPEG. A fresh copy of the bytes goes to
    // the worker, since the first is the one the hash and the reading came from.
    if (!bmp && heic) {
      item.note = 'Decoding the HEIC — this browser cannot draw one…';
      repaintQueueRow(item);
      bmp = await createImageBitmap(await decodeHeic(await file.arrayBuffer()));
      item.decoder = 'libheif';
    }
    if (!bmp) throw new Error('the photo could not be decoded — it may be damaged or cut short');
    try {
      item.width = bmp.width; item.height = bmp.height;

      // Where, when and which way: the file's own facts, and the overlay's
      // where the file is silent — PhotoMeta.reconcile, the same rules the
      // Dropbox sync places a photo by. A file that places the photo and
      // leaves out a ± its app printed is read for the ± alone.
      let ocr = null;
      if (PhotoMeta.needsOcr(meta)) {
        const want = !meta.gps ? 'the position printed on the photo'
                   : !meta.taken ? 'the time printed on the photo' : 'the ± printed on the photo';
        item.status = 'ocr';
        item.note = meta.gps ? `Reading ${want}…` : `No GPS in the file — reading ${want}…`;
        repaintQueue();
        try {
          ocr = await PhotoMeta.ocrImage(bmp, bmp.width, bmp.height, {
            home: home(),
            onPass: n => { item.note = `Reading ${want} — pass ${n}…`; repaintQueueRow(item); },
          });
        } catch (err) {
          item.ocrError = (err && err.message) || String(err);
        }
      }
      const got = PhotoMeta.reconcile(meta, ocr);
      item.pos = got.pos;
      item.heading = got.heading;
      item.altitude = got.altitude;
      item.taken = got.taken;
      item.pitch = got.pitch;
      item.fov = got.fov;
      item.ocr = got.ocr;

      // The station it is of.
      if (item.pos) {
        const n = nearestStation(item.pos.lat, item.pos.lon);
        item.station = n ? { id: n.station.id, auto: true, m: n.m } : null;
      }

      // The thumbnail, and a HEIC's JPEG.
      item.thumbBlob = await drawBlob(bmp, THUMB_PX, 0.82);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.thumbUrl = item.thumbBlob ? URL.createObjectURL(item.thumbBlob) : null;
      if (heic) {
        item.uploadBlob = await drawBlob(bmp, 0, 0.9);
        if (!item.uploadBlob) throw new Error('the HEIC could not be converted to a JPEG in this browser');
        item.contentType = 'image/jpeg';
        item.ext = 'jpg';
        item.converted = true;
      } else {
        item.uploadBlob = file;
        item.contentType = type.content_type;
        item.ext = type.extensions.includes(extensionOf(file.name)) ? extensionOf(file.name) : type.extensions[0];
      }
      const limit = (S().types || []).find(t => t.content_type === item.contentType);
      if (limit && item.uploadBlob.size > limit.max_bytes) {
        throw new Error(`${mb(item.uploadBlob.size)} is over the ${mb(limit.max_bytes)} limit for a ${limit.label}`);
      }
      // A photo out of a zip is let go now it has been read, and unzipped
      // again to upload it (uploadOne): read, it is a hash, a thumbnail and a
      // reading, not twenty megabytes held until somebody presses Upload. A
      // HEIC's JPEG is kept, as it is for a HEIC dropped on its own — it was
      // made here, and there is nothing to make it again from but the work.
      item.uploadBytes = item.uploadBlob.size;
      if (item.zip && !item.converted) item.uploadBlob = null;
    } finally {
      try { bmp.close(); } catch (_) { /* already gone */ }
    }

    item.status = 'ready';
    item.readAt = Date.now();
    item.note = item.pos
      ? (item.pos.placement === 'ocr' && item.pos.confidence !== 'high'
          ? 'Position read off the photo, but only once — check it before uploading.'
          : 'Ready.')
      : item.ocrError
        ? `No GPS in the file, and the picture could not be read (${item.ocrError}). Place it, or upload it unplaced.`
        : 'Nothing in the file or on the picture says where this was taken. Place it, or upload it unplaced.';
  }

  // A JPEG of an image, `px` on its long edge (0 for full size).
  async function drawBlob(bmp, px, quality) {
    const scale = px ? Math.min(1, px / Math.max(bmp.width, bmp.height)) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, w, h);
    return new Promise(resolve => cv.toBlob(b => resolve(b), 'image/jpeg', quality));
  }

  // ── Uploading ──────────────────────────────────────────────────────────────

  function uploadAll() {
    const s = S();
    if (!signedIn()) { say('Sign in first — field photos go into a private bucket only editors can write to.', 'error'); return; }
    const go = s.queue.filter(i => i.status === 'ready' || i.status === 'failed');
    if (!go.length) return;
    // A failed photo sent again is another attempt, and the log says so.
    go.forEach(i => { i.status = 'queued'; i.note = 'Waiting to upload…'; i.logged = false; i.dbRefused = false; });
    repaintQueue();
    runUploads();
  }

  async function runUploads() {
    const s = S();
    if (s.uploading) return;
    s.uploading = true;
    const worker = async () => {
      for (;;) {
        const item = s.queue.find(i => i.status === 'queued');
        if (!item) return;
        item.status = 'uploading';
        item.note = 'Uploading…';
        repaintQueueRow(item);
        try { await uploadOne(item); }
        catch (err) {
          if (err && err.already) { item.status = 'already'; item.existingId = err.already; item.note = err.message; }
          else {
            item.status = 'failed';
            item.note = (err && err.message) || String(err);
            // The database said no — a rule, not a dropped connection. Sending
            // it again is still offered; the log calls it refused.
            item.dbRefused = !!(err && err.code && /^(22|23|42)/.test(String(err.code)));
          }
        }
        repaintQueueRow(item);
      }
    };
    try {
      await Promise.all(Array.from({ length: AT_ONCE }, worker));
    } finally {
      s.uploading = false;
    }
    const done = s.queue.filter(i => i.status === 'done' && !i.told);
    const already = s.queue.filter(i => i.status === 'already' && !i.told);
    const failed = s.queue.filter(i => i.status === 'failed' && !i.told);
    [...done, ...already, ...failed].forEach(i => { i.told = true; });
    const bits = [`${done.length} uploaded`];
    if (already.length) bits.push(`${already.length} already in MegaNet`);
    if (failed.length) bits.push(`${failed.length} failed — ${failed[0].note}`);
    say(`${bits.join(', ')}.`, failed.length ? 'error' : 'ok');
    announce(bits.join(', '));
    repaintQueue();
    if (done.length) changed();
    // What became of each, for the Review panel — this press's files and any
    // the reading refused that have not been said yet. Not awaited: the log
    // is the panel's, not the upload's.
    logOutcomes([...done, ...already, ...failed, ...s.queue.filter(i => i.status === 'refused')]);
    if (s.readLabels && done.length) readLabelsAfter(done);
  }

  // ── What became of each one (0036) ─────────────────────────────────────────
  // A row per file to meganet.log_field_photo_upload, one batch per press of
  // Upload, two hundred rows a call (the function takes five hundred). Never
  // awaited by an upload and never failing one: a log that could not be
  // written is kept as a sentence for the Review panel to show.
  const LOG_CHUNK = 200;

  function outcomeOf(i) {
    if (i.status === 'done') return i.row && !known(i.row.lat) ? 'unplaced' : 'imported';
    if (i.status === 'already') return 'duplicate';
    if (i.status === 'refused') return 'refused';
    if (i.status === 'failed') return i.dbRefused ? 'refused' : 'failed';
    return null;
  }

  async function logOutcomes(items) {
    const s = S();
    const batch = uuid();
    const rows = [];
    for (const i of items) {
      const outcome = outcomeOf(i);
      if (!outcome || i.logged) continue;
      i.logged = true;
      const row = {
        batch_id: batch, origin: 'upload', file_name: String(i.name || 'unnamed').slice(0, 300), outcome,
        reason: outcome === 'imported' ? ''
              : outcome === 'unplaced' ? 'Uploaded unplaced — nothing in the file or on the picture said where it was taken.'
              : String(i.note || '').slice(0, 1000),
      };
      if (i.from) row.archive_name = String(i.from).slice(0, 300);
      if (i.sha) row.sha256 = i.sha;
      if (Number.isFinite(i.size)) row.byte_size = i.size;
      // The photo it became or already was, and its station — both as the
      // database has them, so the log's own foreign keys cannot refuse the
      // batch over a station this browser knows and the database does not.
      if (i.status === 'done' && i.row) {
        row.photo_id = i.row.id;
        if (i.row.station_id) row.station_id = i.row.station_id;
      } else if (i.status === 'already' && typeof i.existingId === 'string') {
        row.photo_id = i.existingId;
      }
      rows.push(row);
    }
    if (!rows.length) return;
    for (let k = 0; k < rows.length; k += LOG_CHUNK) {
      try {
        await dbRpc('log_field_photo_upload', { p_rows: rows.slice(k, k + LOG_CHUNK) });
        s.logError = null;
      } catch (err) {
        s.logError = (err && err.message) || String(err);
      }
    }
    if (typeof PhotoReview !== 'undefined') PhotoReview.uploadsChanged();
  }

  // "Read equipment labels after upload": the photos just uploaded that are
  // filed under a station, read one at a time by the Review panel's scanner,
  // out of the bytes this page still has — not downloaded again.
  function readLabelsAfter(items) {
    if (typeof PhotoReview === 'undefined') return;
    const jobs = items.filter(i => i.row && i.row.station_id).map(i => ({
      id: i.row.id, station_id: i.row.station_id, title: i.name,
      blob: () => (i.uploadBlob ? Promise.resolve(i.uploadBlob) : fileOf(i)),
    }));
    const unfiled = items.length - jobs.length;
    if (!jobs.length) {
      say(`${unfiled} uploaded photo${unfiled === 1 ? ' is' : 's are'} filed under no station, so no labels were read — a suggestion is for a station's register.`, 'warn');
      return;
    }
    PhotoReview.scan(jobs, {
      what: `the ${jobs.length} photo${jobs.length === 1 ? '' : 's'} just uploaded`,
      onDone: out => say(`${out.text}${unfiled ? ` ${unfiled} filed under no station were not read.` : ''}`, out.kind),
    });
  }
  function setReadLabels(on) { S().readLabels = !!on; }

  async function uploadOne(item) {
    // Asked first, so the same folder dropped twice costs one query a photo
    // rather than its bytes. The database refuses it anyway if two people race.
    const dup = await dbSelect(`field_photo?select=id,uploaded_by,created_at&sha256=eq.${item.sha}&limit=1`);
    if (dup.length) {
      const e = new Error(`Already in MegaNet — added by ${dup[0].uploaded_by || 'someone'} on ${String(dup[0].created_at || '').slice(0, 10)}.`);
      e.already = dup[0].id;
      throw e;
    }
    const id = uuid();
    const path = `photo/${id}.${item.ext}`;
    const thumb = item.thumbBlob ? `photo/${id}.thumb.jpg` : null;
    // A photo out of a zip was let go when it had been read: unzipped again
    // here, checked again, and let go again when this returns.
    const blob = item.uploadBlob || await fileOf(item);
    if (blob.size !== item.uploadBytes) {
      throw new Error(`the ${item.zip ? `photo in ${item.from}` : 'file'} is not the one that was read — add it again`);
    }
    await dbUploadObject(BUCKET, path, blob);
    if (thumb) {
      try { await dbUploadObject(BUCKET, thumb, item.thumbBlob); }
      catch (err) { try { await dbRemoveObject(BUCKET, path); } catch (_) { /* swept later */ } throw err; }
    }
    const p = photoRecord(item, path, thumb);
    let row;
    try {
      row = await dbRpc('add_field_photo', { p_photo: p });
    } catch (err) {
      // The compensating half: the bytes are up and nothing points at them.
      try { await dbRemoveObject(BUCKET, path); } catch (_) { /* swept later */ }
      if (thumb) { try { await dbRemoveObject(BUCKET, thumb); } catch (_) { /* swept later */ } }
      if (err && err.status === 409) {
        const e = new Error('Already in MegaNet — somebody added the same photo a moment ago.');
        e.already = err.details || true;
        throw e;
      }
      throw err;
    }
    item.row = row;
    keep([row]);
    item.status = 'done';
    item.note = 'Uploaded.';
  }

  // What the database is told about a photo: PhotoMeta.record — the same
  // record the Dropbox sync sends — plus the object paths and what the stored
  // bytes are, and the station if somebody chose one (or chose none, which is
  // said as a null; otherwise the database picks by distance and says so).
  function photoRecord(item, path, thumb) {
    const p = PhotoMeta.record({
      meta: item.meta, name: item.name, size: item.size, type: item.type || null,
      converted: !!item.converted, width: item.width, height: item.height, caption: item.caption,
      pos: item.pos, heading: item.heading, altitude: item.altitude, taken: item.taken,
      pitch: item.pitch, fov: item.fov, ocr: item.ocr,
    });
    Object.assign(p, {
      storage_path: path, thumb_path: thumb,
      content_type: item.contentType, byte_size: item.uploadBytes, sha256: item.sha,
    });
    if (item.station && !item.station.auto) p.station_id = item.station.id;
    else if (!item.station && item.stationCleared) p.station_id = null;
    return p;
  }

  function removeFromQueue(key) {
    const s = S();
    const i = s.queue.findIndex(x => x.key === key);
    if (i < 0) return;
    const [item] = s.queue.splice(i, 1);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    repaintQueue();
  }
  function clearFinished() {
    const s = S();
    for (const item of s.queue) if ((item.status === 'done' || item.status === 'already' || item.status === 'refused') && item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    s.queue = s.queue.filter(i => !['done', 'already', 'refused'].includes(i.status));
    // A pack's line goes with the last of its photos — or at once, for one
    // that opened on nothing, or was refused whole.
    s.packs = packs().filter(p => p.status === 'opening' || s.queue.some(i => i.pack === p.key));
    say('');
    repaintQueue();
  }
  function packs() { const s = S(); return s.packs || (s.packs = []); }

  // Placing one in the queue by hand: coordinates typed or pasted, or a station.
  function queuePlace(key, text) {
    const item = S().queue.find(i => i.key === key);
    if (!item) return;
    const p = typeof Places !== 'undefined' ? Places.parse(text) : null;
    if (!p) { item.placeError = `“${text}” is not a coordinate this can read — try -27.5543, 152.2741`; repaintQueueRow(item); return; }
    item.placeError = '';
    item.pos = { lat: p.lat, lon: p.lon, placement: 'manual', accuracy: null };
    const n = nearestStation(p.lat, p.lon);
    item.station = n ? { id: n.station.id, auto: true, m: n.m } : null;
    item.editing = false;
    if (item.status === 'ready') item.note = 'Placed by hand.';
    repaintQueueRow(item);
  }
  function queueAtStation(key, id) {
    const item = S().queue.find(i => i.key === key);
    const st = stationById(id);
    if (!item || !located(st)) return;
    if (!item.pos) item.pos = { lat: st.lat, lon: st.lon, placement: 'station', accuracy: null };
    item.station = { id: st.id, auto: false, m: metres(item.pos.lat, item.pos.lon, st.lat, st.lon) };
    item.editing = false;
    if (item.status === 'ready') item.note = item.pos.placement === 'station' ? `Placed at ${st.name}.` : `Filed under ${st.name}.`;
    repaintQueueRow(item);
  }
  function queueNoStation(key) {
    const item = S().queue.find(i => i.key === key);
    if (!item) return;
    item.station = null;
    item.stationCleared = true;
    item.editing = false;
    repaintQueueRow(item);
  }
  function queueEdit(key, on) {
    const item = S().queue.find(i => i.key === key);
    if (!item) return;
    item.editing = on == null ? !item.editing : !!on;
    item.find = '';
    repaintQueueRow(item);
    if (item.editing) {
      const el = document.getElementById(`fp-place-${key}`);
      if (el) el.focus();
    }
  }
  function queueFind(key, text) {
    const item = S().queue.find(i => i.key === key);
    if (!item) return;
    item.find = String(text || '');
    const el = document.getElementById(`fp-hits-${key}`);
    if (el) el.innerHTML = stationHitsHtml(item.find, id => `FieldPhotos.queueAtStation('${escAttr(key)}','${escAttr(id)}')`);
  }

  // ── Rendering: the tab ─────────────────────────────────────────────────────

  function say(text, kind) {
    S().msg = text ? { text, kind: kind || 'info' } : null;
    const el = document.getElementById('fp-msg');
    if (el) el.innerHTML = msgHtml();
  }
  function msgHtml() {
    const m = S().msg;
    if (!m) return '';
    const cls = m.kind === 'error' ? 'txt-bad' : m.kind === 'warn' ? 'txt-warn' : m.kind === 'ok' ? 'txt-ok' : 'txt-muted';
    return `<span class="${cls}">${esc(m.text)}</span>`;
  }

  function render() {
    const s = S();
    return `
  <div class="page fp-page" style="--page-max:1200px">
    <div class="panel" id="fp-add-panel">
      <div class="panel-header"><h2>Add field photos</h2></div>
      ${addHtml()}
    </div>
    <div class="panel" id="fp-lib-panel">
      <div class="panel-header">
        <h2>Field photos</h2>
        <div class="button-group" id="fp-filter">${filterHtml()}</div>
      </div>
      <div id="fp-lib">${libHtml()}</div>
    </div>
    <div class="panel" id="fp-review-panel">
      <div class="panel-header"><h2>Review</h2></div>
      <div id="fp-review">${typeof PhotoReview !== 'undefined' ? PhotoReview.html() : ''}</div>
    </div>
    <div class="panel" id="fp-sync-panel">
      <div class="panel-header"><h2>From Dropbox and Google Drive</h2></div>
      <div id="fp-sync">${syncHtml()}</div>
    </div>
  </div>`;
  }

  function addHtml() {
    const s = S();
    if (!signedIn()) {
      return `<p class="small">Field photos are private to signed-in editors — the pictures, and where they were
        taken, are kept in a private bucket and only ever shown through a link that expires.
        <button type="button" class="link-btn" onclick="Auth.open()">Sign in</button> to add photos or see them.</p>`;
    }
    if (s.typesError) {
      return `<p class="small txt-bad">The list of what may be uploaded could not be loaded — ${esc(s.typesError)}.
        Nothing can be uploaded until it can. <button type="button" class="link-btn" onclick="FieldPhotos.retry()">Try again</button></p>`;
    }
    return `
      <div class="fp-drop" id="fp-drop"
           ondragover="FieldPhotos.dragOver(event)" ondragleave="FieldPhotos.dragLeave(event)" ondrop="FieldPhotos.drop(event)">
        <p class="fp-drop-lead"><strong>Drop photos here</strong> — or a zip of them — or choose them:</p>
        <div class="button-group">
          <label class="fp-pick"><span>📷 Choose photos or zips</span>
            <input type="file" id="fp-files" multiple accept="image/*,.heic,.heif,.zip,application/zip"
                   onchange="FieldPhotos.addFiles(this.files);this.value=''"></label>
          <label class="fp-pick"><span>📁 Choose a folder</span>
            <input type="file" id="fp-folder" multiple webkitdirectory
                   onchange="FieldPhotos.addFiles(this.files);this.value=''"></label>
        </div>
        <p class="small txt-muted">Each photo is placed where it was taken: from the camera's own GPS if the file
          has it, and otherwise from the position a field camera app printed on the picture (Solocator, GPS Map
          Camera and the like), read off it by OCR. Nothing is uploaded until you press Upload — check the
          positions first. A photo nothing can place still uploads, into <em>Unplaced</em>. A zip is opened
          here and its photos queued one by one, each saying which zip it came from.</p>
        <label class="fp-labels-opt small"><input type="checkbox" id="fp-read-labels" ${s.readLabels ? 'checked' : ''}
               onchange="FieldPhotos.setReadLabels(this.checked)">
          Read equipment labels after upload — makes, models and serial numbers, suggested for the station's
          register. Seconds a photo, so off unless you want it.</label>
      </div>
      <p class="small fp-msg" id="fp-msg" role="status">${msgHtml()}</p>
      <div id="fp-queue">${queueHtml()}</div>`;
  }

  const STATUS = {
    waiting: 'Waiting', reading: 'Reading', ocr: 'Reading the overlay', ready: 'Ready', refused: 'Refused',
    queued: 'Waiting to upload', uploading: 'Uploading', done: 'Uploaded', already: 'Already in MegaNet', failed: 'Failed',
  };

  // The zip packs, a line each, above the photos they held.
  function packsHtml() {
    const list = packs();
    if (!list.length) return '';
    return `<ul class="fp-packs" aria-label="Zip packs">${list.map(p => `
        <li class="fp-pack fp-pack-${esc(p.status)}"><span class="fp-pack-name">🗜️ ${esc(p.name)}</span>
          <span class="small txt-muted">${esc(mb(p.size))}</span>
          <span class="small ${p.status === 'refused' ? 'txt-bad' : p.leftOut.length ? 'txt-warn' : ''}">${esc(p.note)}</span></li>`).join('')}</ul>`;
  }

  function queueHtml() {
    const q = S().queue;
    if (!q.length) return packsHtml();
    const ready = q.filter(i => i.status === 'ready' || i.status === 'failed').length;
    const busy = q.some(i => ['waiting', 'reading', 'ocr', 'queued', 'uploading'].includes(i.status))
              || packs().some(p => p.status === 'opening');
    const finished = q.some(i => ['done', 'already', 'refused'].includes(i.status));
    return `
      ${packsHtml()}
      <div class="button-group fp-queue-actions">
        <button type="button" class="primary" id="fp-upload" onclick="FieldPhotos.uploadAll()" ${ready ? '' : 'disabled'}>⬆ Upload ${ready} photo${ready === 1 ? '' : 's'}</button>
        <button type="button" onclick="FieldPhotos.clearFinished()" ${finished ? '' : 'disabled'}>Clear finished</button>
        ${busy ? '<span class="small txt-muted">Working…</span>' : ''}
      </div>
      <div class="table-wrap">
        <table class="fp-queue-table">
          <caption class="sr-only">Photos to upload: where each was taken, the station it is of, and whether it has gone</caption>
          <thead><tr>
            <th scope="col">Photo</th><th scope="col">Taken</th><th scope="col">Where</th>
            <th scope="col">Station</th><th scope="col">Status</th>
          </tr></thead>
          <tbody>${q.map(rowHtml).join('')}</tbody>
        </table>
      </div>`;
  }

  function rowHtml(item) {
    return `<tr id="fp-row-${escAttr(item.key)}" class="fp-q-${item.status}">${rowCellsHtml(item)}</tr>`
         + (item.editing ? `<tr class="fp-q-edit" id="fp-edit-${escAttr(item.key)}"><td colspan="5">${placeHtml(item)}</td></tr>` : '');
  }

  function rowCellsHtml(item) {
    const st = item.station ? stationById(item.station.id) : null;
    const pos = item.pos;
    const where = pos
      ? `<span class="fp-coord">${esc(fmtCoord(pos.lat, pos.lon))}</span>${known(pos.accuracy) ? `<span class="small">${accHtml(pos.accuracy)}</span>` : ''}
         <span class="fp-chip fp-chip-${esc(pos.placement)}">${esc(PLACEMENT[pos.placement].chip)}</span>
         ${pos.placement === 'ocr' && pos.confidence !== 'high' ? '<span class="fp-chip fp-chip-warn">read once — check it</span>' : ''}
         ${item.heading ? `<span class="small fp-heading">facing ${esc(headingText(item.heading.deg, item.heading.ref))}</span>` : ''}`
      : (['ready', 'failed'].includes(item.status) ? '<span class="txt-warn">Not found</span>' : '<span class="txt-muted">—</span>');
    const canEdit = ['ready', 'failed'].includes(item.status);
    const station = st
      ? `${esc(st.name)} <span class="small txt-muted">${item.station.auto ? `nearest, ${esc(fmtM(item.station.m))}` : 'chosen'}</span>`
      : `<span class="txt-muted">${pos ? 'none within a kilometre' : '—'}</span>`;
    const actions = [];
    if (canEdit) actions.push(`<button type="button" class="link-btn" onclick="FieldPhotos.queueEdit('${escAttr(item.key)}')" aria-expanded="${item.editing ? 'true' : 'false'}" aria-controls="fp-edit-${escAttr(item.key)}">${pos ? 'Change…' : 'Place it…'}</button>`);
    if (item.status === 'already' && item.existingId && typeof item.existingId === 'string') actions.push(`<button type="button" class="link-btn" onclick="FieldPhotos.openOne('${escAttr(item.existingId)}')">Show it</button>`);
    if (item.status === 'done' && item.row) actions.push(`<button type="button" class="link-btn" onclick="FieldPhotos.openOne('${escAttr(item.row.id)}')">Show it</button>`);
    if (!['uploading', 'queued', 'reading', 'ocr'].includes(item.status)) actions.push(`<button type="button" class="link-btn" onclick="FieldPhotos.removeFromQueue('${escAttr(item.key)}')" aria-label="Take ${escAttr(item.name)} off the list">Remove</button>`);
    return `
      <td class="fp-q-photo">${item.thumbUrl ? `<img class="fp-q-thumb" src="${esc(item.thumbUrl)}" alt="">` : '<span class="fp-q-thumb fp-thumb-missing" aria-hidden="true"></span>'}
        <span class="fp-q-name">${esc(item.name)}</span> <span class="small txt-muted">${esc(mb(item.size))}</span>
        ${item.from ? `<span class="small txt-muted fp-q-from">from ${esc(item.from)}</span>` : ''}</td>
      <td>${item.taken ? `${esc(fmtLocal(item.taken.local))}${item.taken.zone === 'assumed' ? ' <span class="small txt-muted">(zone assumed)</span>' : ''}` : '<span class="txt-muted">—</span>'}</td>
      <td>${where}</td>
      <td>${station}</td>
      <td><span class="fp-status">${esc(STATUS[item.status] || item.status)}</span>
        <span class="small fp-note">${esc(item.note || '')}</span>
        <span class="fp-row-actions">${actions.join(' ')}</span></td>`;
  }

  function placeHtml(item) {
    const pos = item.pos;
    const around = pos ? stationsAround(pos.lat, pos.lon) : [];
    return `
      <div class="fp-place">
        <label class="fp-place-field">Coordinates
          <span class="fp-place-row">
            <input type="text" id="fp-place-${escAttr(item.key)}" value="${pos ? escAttr(fmtCoord(pos.lat, pos.lon)) : ''}"
                   placeholder="-27.554294, 152.274116" autocomplete="off" spellcheck="false"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();FieldPhotos.queuePlace('${escAttr(item.key)}',this.value)}">
            <button type="button" onclick="FieldPhotos.queuePlace('${escAttr(item.key)}',document.getElementById('fp-place-${escAttr(item.key)}').value)">Set</button>
          </span>
        </label>
        ${item.placeError ? `<p class="small txt-bad">${esc(item.placeError)}</p>` : ''}
        ${around.length ? `<p class="small">The stations around it:</p>
          <div class="fp-hits">${around.map(({ s, m }) => `<button type="button" class="fp-hit" onclick="FieldPhotos.queueAtStation('${escAttr(item.key)}','${escAttr(s.id)}')">${esc(s.name)} <span class="small">${esc(fmtM(m))}</span></button>`).join('')}</div>` : ''}
        <label class="fp-place-field">${pos ? 'Or file it under another station' : 'Or put it at a station'}
          <input type="search" value="${escAttr(item.find || '')}" placeholder="name or station number" autocomplete="off"
                 oninput="FieldPhotos.queueFind('${escAttr(item.key)}',this.value)">
        </label>
        <div id="fp-hits-${escAttr(item.key)}">${stationHitsHtml(item.find || '', id => `FieldPhotos.queueAtStation('${escAttr(item.key)}','${escAttr(id)}')`)}</div>
        <div class="button-group">
          ${item.station ? `<button type="button" onclick="FieldPhotos.queueNoStation('${escAttr(item.key)}')">No station</button>` : ''}
          <button type="button" onclick="FieldPhotos.queueEdit('${escAttr(item.key)}',false)">Done</button>
        </div>
      </div>`;
  }

  // A station search in a few lines — name, number or ALERT address, through
  // the Stations tab's own matcher where it is loaded.
  function stationHitsHtml(text, onPick) {
    const q = String(text || '').trim();
    if (!q) return '';
    const prep = typeof prepareSearch === 'function' ? prepareSearch(q) : null;
    const hits = [];
    for (const s of stations()) {
      const ok = prep && typeof stationMatchesSearch === 'function'
        ? stationMatchesSearch(s, prep)
        : (s.name || '').toLowerCase().includes(q.toLowerCase()) || String(s.station_number || '').includes(q);
      if (ok && located(s)) hits.push(s);
      if (hits.length >= 12) break;
    }
    if (!hits.length) return `<p class="small txt-muted">No station with a position matches “${esc(q)}”.</p>`;
    return `<div class="fp-hits">${hits.map(s => `<button type="button" class="fp-hit" onclick="${onPick(s.id)}">${esc(s.name)} <span class="small">${esc(s.station_number || '')}</span></button>`).join('')}</div>`;
  }

  function filterHtml() {
    if (!signedIn()) return '';
    const f = S().filter, n = S().unplacedCount;
    const st = f.station ? stationById(f.station) : null;
    const chip = (key, label) => `<button type="button" class="fp-filter${f.show === key ? ' is-on' : ''}" aria-pressed="${f.show === key}" onclick="FieldPhotos.setShow('${key}')">${label}</button>`;
    return [
      chip('all', 'All'),
      chip('unplaced', `Unplaced${known(n) ? ` (${n}${n >= 1000 ? '+' : ''})` : ''}`),
      chip('dropbox', 'From Dropbox'),
      chip('gdrive', 'From Google Drive'),
      st ? chip('station', `At ${esc(st.name)}`) : '',
    ].join('');
  }

  function libHtml() {
    const s = S();
    if (!signedIn()) return '<p class="small txt-muted">Sign in to see the photos.</p>';
    if (s.libLoading && !s.lib) return '<p class="small">Loading…</p>';
    if (s.libError) {
      const missing = /field_photo/.test(s.libError) && /(does not exist|schema cache|not find)/i.test(s.libError);
      return `<p class="small txt-bad">${missing
        ? 'This database has no field photos table yet — apply <code>db/migrations/0035_field_photos.sql</code>, then run <code>tools/storage_bucket.sql</code>.'
        : `The photos could not be loaded — ${esc(s.libError)}.`}
        <button type="button" class="link-btn" onclick="FieldPhotos.retry()">Try again</button></p>`;
    }
    const rows = s.lib || [];
    if (!rows.length) {
      return `<p class="small txt-muted">${s.filter.show === 'unplaced' ? 'Every photo has a place. Nothing to do here.'
        : s.filter.show === 'station' ? 'No photos have been filed under this station yet.'
        : s.filter.show === 'dropbox' ? 'Nothing has come in from Dropbox yet.'
        : s.filter.show === 'gdrive' ? 'Nothing has come in from Google Drive yet.'
        : 'No field photos yet. Add some above.'}</p>`;
    }
    const f = s.filter;
    return `
      <p class="small txt-muted" id="fp-lib-lead">${rows.length}${rows.length >= s.libLimit ? '+' : ''} photo${rows.length === 1 ? '' : 's'}${
        f.show === 'unplaced' ? ' with no position — open one to place it' : ''}, newest first.</p>
      <ul class="fp-grid" aria-labelledby="fp-lib-lead">
        ${rows.map(r => `<li>${cardHtml(r)}</li>`).join('')}
      </ul>
      ${rows.length >= s.libLimit ? `<div class="button-group"><button type="button" onclick="FieldPhotos.more()">Show ${PAGE} more</button></div>` : ''}`;
  }

  function cardHtml(r) {
    const st = r.station_id ? stationById(r.station_id) : null;
    const where = known(r.lat) ? (st ? st.name : fmtCoord(r.lat, r.lon)) : 'Unplaced';
    return `<button type="button" class="fp-card" data-fp-id="${escAttr(r.id)}" onclick="FieldPhotos.openFromLib('${escAttr(r.id)}')"
                    aria-label="${escAttr(`${r.title || 'Photo'} — ${where}${whenText(r) ? `, ${whenText(r)}` : ''}`)}">
        <img class="fp-card-img" data-fp-src="${escAttr(thumbOf(r))}" alt="">
        <span class="fp-card-where">${esc(where)}</span>
        <span class="small fp-card-when">${esc(whenText(r) || 'no time')}</span>
        ${known(r.lat) ? `<span class="fp-chip fp-chip-${esc(r.placement)}">${esc((PLACEMENT[r.placement] || {}).chip || r.placement)}</span>` : '<span class="fp-chip fp-chip-warn">needs a place</span>'}
      </button>`;
  }

  // What each photo sync last did: every linked folder, a block each — the
  // Dropbox folder tools/field-photos reads, and a Google Drive one — from its
  // own row of meganet.field_photo_sync, drawn the same way. Only the words
  // about setting one up differ, and only Dropbox's is linked from here; a
  // source nobody has described yet (the next sync) still gets its block.
  const SOURCES = {
    dropbox: { name: 'Dropbox', doc: 'docs/field-photos.md#linking-a-dropbox-folder', link: 'docs/field-photos.md',
               how: `Photos saved into the linked Dropbox folder are imported by a scheduled job about every
                     fifteen minutes, and placed the same way as the ones dropped here. Setting it up is a Dropbox
                     app and three secrets —`, after: ' has the steps.' },
    gdrive:  { name: 'Google Drive', doc: 'docs/field-photos.md#linking-a-google-drive-folder',
               link: 'Linking a Google Drive folder',
               how: `Photos saved into the linked Google Drive folder are imported by a scheduled job, and placed
                     the same way as the ones dropped here. Setting it up:`, after: ' in docs/field-photos.md.' },
  };
  function syncAgo(t) {
    const m = Math.round((Date.now() - Date.parse(t)) / 60000);
    return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  }

  function syncHtml() {
    const s = S();
    if (!signedIn()) return '<p class="small txt-muted">Sign in to see what the Dropbox and Google Drive syncs have done.</p>';
    if (!s.sync && !s.syncError) return '<p class="small">Loading…</p>';
    const rows = s.sync || [];
    const keys = [...new Set(['dropbox', 'gdrive', ...rows.map(r => r.source)])];
    return `${s.syncError ? `<p class="small txt-bad">The syncs' report could not be read — ${esc(s.syncError)}.</p>` : ''}
      ${keys.map(k => sourceHtml(k, s.syncError ? undefined : rows.find(r => r.source === k) || null)).join('')}`;
  }

  // One source's block. `d` is its report row, null for none, undefined for
  // "could not be read".
  function sourceHtml(key, d) {
    const src = SOURCES[key] || { name: key, doc: 'docs/field-photos.md', link: 'docs/field-photos.md',
                                  how: `Photos from ${key} are imported by a scheduled job —`, after: ' says how.' };
    const href = esc(typeof docUrl === 'function' ? docUrl(src.doc) : src.doc);
    const how = `${src.how} <a href="${href}" target="_blank" rel="noopener">${esc(src.link)}</a>${src.after}`;
    let status;
    if (d === undefined) status = '';
    else if (!d || !d.last_run_at) status = `<p class="small">Not set up yet — nothing has reported from ${esc(src.name)}.</p>`;
    else {
      const ok = d.last_ok_at && (!d.last_error || Date.parse(d.last_ok_at) >= Date.parse(d.last_run_at));
      status = `
        <p class="small ${ok ? 'txt-ok' : 'txt-bad'}"><strong>${ok ? 'Working' : 'Failing'}</strong> — last ran ${esc(syncAgo(d.last_run_at))}${
          d.account ? `, reading ${esc(d.account)}'s ${esc(src.name)}` : ''}${d.folder ? ` (${esc(d.folder)})` : ''}.</p>
        ${!ok && d.last_error ? `<p class="small txt-bad">${esc(d.last_error)}</p>` : ''}
        <p class="small">Last run: ${d.seen} new file${d.seen === 1 ? '' : 's'} seen, ${d.imported} imported${d.unplaced ? ` (${d.unplaced} could not be placed — see <button type="button" class="link-btn" onclick="FieldPhotos.setShow('unplaced')">Unplaced</button>)` : ''}, ${d.skipped} skipped, ${d.failed} failed.</p>`;
    }
    return `
      <div class="fp-sync-source" id="fp-sync-${escAttr(key)}">
        <h3 class="fp-sync-name">${esc(src.name)}</h3>
        ${status}
        <p class="small txt-muted">${how}</p>
        ${key === 'dropbox' ? connectHtml() : ''}
      </div>`;
  }

  // ── Linking a Dropbox folder ───────────────────────────────────────────────
  // The sync keeps one credential: a Dropbox refresh token. Getting one is an
  // OAuth dance that is usually a terminal and a curl command; this does it in
  // the page instead, with PKCE — Dropbox's flow for a client that cannot keep
  // a secret, which is also why the sync then needs no app secret. The token is
  // shown once, to be pasted into GitHub, and kept nowhere here: not in the
  // database, not in this browser's storage. docs/field-photos.md has every
  // click, including the ones in Dropbox's App Console and in GitHub.
  const DBX_AUTH = 'https://www.dropbox.com/oauth2/authorize';
  const DBX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
  let link = { key: '', verifier: '', next: null, token: '', error: '', busy: false, opened: false };

  function b64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function challengeOf(verifier) {
    const bytes = new TextEncoder().encode(verifier);
    if (typeof crypto !== 'undefined' && crypto.subtle) return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    const hex = sha256js(bytes);
    return b64url(hex.match(/../g).map(h => parseInt(h, 16)));
  }

  function connectHtml() {
    if (!signedIn()) return '';
    const repo = typeof GITHUB_REPO === 'string' ? GITHUB_REPO : 'cdomotor-g/MegaNet';
    const secrets = `https://github.com/${repo}/settings/secrets/actions`;
    const runs = `https://github.com/${repo}/actions/workflows/field-photos-dropbox.yml`;
    return `
      <details class="fp-connect" id="fp-connect" ${link.key || link.token ? 'open' : ''}>
        <summary>Link a Dropbox folder</summary>
        <ol class="small fp-connect-steps">
          <li>In Dropbox's <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">App Console ↗</a>,
            create an app with <em>Scoped access</em> and <em>App folder</em> access, tick
            <code>files.metadata.read</code> and <code>files.content.read</code> on its Permissions tab, and copy its
            <strong>App key</strong> here:
            <span class="fp-place-row"><input type="text" id="fp-dbx-key" value="${escAttr(link.key)}" autocomplete="off" spellcheck="false"
                   aria-label="Dropbox app key" placeholder="App key" onchange="FieldPhotos.dbxKey(this.value)"></span></li>
          <li><button type="button" onclick="FieldPhotos.dbxOpen()">Open Dropbox to allow access ↗</button>
            — sign in as the account whose folder holds the photos, press <em>Allow</em>, and copy the code it shows.</li>
          <li>Paste the code:
            <span class="fp-place-row"><input type="text" id="fp-dbx-code" autocomplete="off" spellcheck="false" aria-label="The code Dropbox showed"
                   placeholder="Access code">
            <button type="button" onclick="FieldPhotos.dbxFinish(document.getElementById('fp-dbx-code').value)" ${link.busy ? 'disabled' : ''}>Get the token</button></span></li>
        </ol>
        ${link.error ? `<p class="small txt-bad" role="alert">${esc(link.error)}</p>` : ''}
        ${link.token ? `
        <p class="small txt-ok"><strong>Linked.</strong> Paste this into GitHub as the secret <code>DROPBOX_REFRESH_TOKEN</code> —
          it is shown once and kept nowhere here:</p>
        <span class="fp-place-row"><input type="text" id="fp-dbx-token" readonly value="${escAttr(link.token)}" aria-label="Dropbox refresh token">
          <button type="button" onclick="FieldPhotos.dbxCopy()">Copy</button></span>
        <p class="small">Then, in <a href="${esc(secrets)}" target="_blank" rel="noopener">the repository's Actions secrets ↗</a>,
          add <code>DROPBOX_APP_KEY</code> (<code>${esc(link.key)}</code>) and <code>SUPABASE_SECRET_KEY</code> (Supabase → Project
          Settings → API Keys → the secret key) beside it. The next run — or
          <a href="${esc(runs)}" target="_blank" rel="noopener">Run workflow ↗</a> now — imports what is in the folder.</p>` : ''}
      </details>`;
  }
  function repaintConnect() {
    const el = document.getElementById('fp-connect');
    if (el) el.outerHTML = connectHtml();
  }
  // The verifier and its challenge are made ahead of the button — when the key
  // is typed, and again after each press — so the button opens Dropbox inside
  // its own click. A window opened after an await is one a popup blocker
  // (Safari's first) is entitled to refuse.
  async function nextChallenge() {
    const raw = new Uint8Array(48);
    crypto.getRandomValues(raw);
    const verifier = b64url(raw);
    const challenge = await challengeOf(verifier);
    link.next = { verifier, challenge };
    return link.next;
  }
  function dbxKey(v) { link.key = String(v || '').trim(); link.error = ''; if (!link.next) nextChallenge(); }
  async function dbxOpen() {
    const keyEl = document.getElementById('fp-dbx-key');
    if (keyEl) link.key = keyEl.value.trim();
    if (!/^[a-z0-9]{8,32}$/i.test(link.key)) { link.error = 'Paste the app\'s App key first — it is on the app\'s Settings tab in the App Console.'; repaintConnect(); return; }
    const pkce = link.next || await nextChallenge();
    link.next = null;
    link.verifier = pkce.verifier;
    link.error = '';
    link.token = '';
    const url = `${DBX_AUTH}?${new URLSearchParams({
      client_id: link.key, response_type: 'code', token_access_type: 'offline',
      code_challenge: pkce.challenge, code_challenge_method: 'S256',
    })}`;
    link.opened = true;
    window.open(url, '_blank', 'noopener');
    nextChallenge();
    repaintConnect();
    const code = document.getElementById('fp-dbx-code');
    if (code) code.focus();
  }
  async function dbxFinish(code) {
    code = String(code || '').trim();
    if (!link.verifier || !link.key) { link.error = 'Press "Open Dropbox to allow access" first — the code belongs to that request.'; repaintConnect(); return; }
    if (!code) { link.error = 'Paste the code Dropbox showed after you pressed Allow.'; repaintConnect(); return; }
    link.busy = true;
    repaintConnect();
    try {
      const res = await fetch(DBX_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: link.verifier, client_id: link.key }).toString(),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.refresh_token) {
        throw new Error((body && (body.error_description || body.error)) || `HTTP ${res.status}`);
      }
      link.token = body.refresh_token;
      link.verifier = '';
      link.error = '';
      announce('Dropbox linked — the refresh token is ready to copy');
    } catch (err) {
      link.error = `Dropbox did not accept that code — ${(err && err.message) || err}. Codes are single-use and expire in minutes: open Dropbox again for a new one.`;
    } finally {
      link.busy = false;
      repaintConnect();
    }
  }
  async function dbxCopy() {
    try { await navigator.clipboard.writeText(link.token); announce('Copied'); }
    catch (_) { const el = document.getElementById('fp-dbx-token'); if (el) { el.select(); } }
  }

  // Repaint one part, never the tab: a half-typed coordinate in the queue must
  // survive an upload finishing beside it.
  function repaint() { repaintAdd(); repaintLib(); repaintSync(); repaintFilter(); repaintReview(); }
  function repaintReview() {
    if (typeof PhotoReview !== 'undefined') PhotoReview.repaint();
  }
  // The Review panel lists this queue too; it repaints its own list, at most a
  // few times a second, however often a row here changes.
  function queueChangedForReview() {
    if (typeof PhotoReview !== 'undefined') PhotoReview.queueChanged();
  }
  function repaintAdd() {
    const el = document.getElementById('fp-add-panel');
    if (!el) return;
    if (document.getElementById('fp-drop') && signedIn() && !S().typesError) { repaintQueue(); return; }
    el.innerHTML = `<div class="panel-header"><h2>Add field photos</h2></div>${addHtml()}`;
  }
  function repaintQueue() {
    const el = document.getElementById('fp-queue');
    if (el) el.innerHTML = queueHtml();
    queueChangedForReview();
  }
  function repaintQueueRow(item) {
    const row = document.getElementById(`fp-row-${item.key}`);
    const edit = document.getElementById(`fp-edit-${item.key}`);
    queueChangedForReview();
    if (!row || (!!edit !== !!item.editing)) { repaintQueue(); return; }
    row.className = `fp-q-${item.status}`;
    row.innerHTML = rowCellsHtml(item);
    if (edit && item.editing) edit.innerHTML = `<td colspan="5">${placeHtml(item)}</td>`;
    const up = document.getElementById('fp-upload');
    if (up) {
      const n = S().queue.filter(i => i.status === 'ready' || i.status === 'failed').length;
      up.disabled = !n;
      up.textContent = `⬆ Upload ${n} photo${n === 1 ? '' : 's'}`;
    }
  }
  function repaintLib() {
    const el = document.getElementById('fp-lib');
    if (!el) return;
    el.innerHTML = libHtml();
    paintThumbs(el);
  }
  function repaintFilter() {
    const el = document.getElementById('fp-filter');
    if (el) el.innerHTML = filterHtml();
  }
  function repaintSync() {
    const el = document.getElementById('fp-sync');
    if (el) el.innerHTML = syncHtml();
  }

  function init() {
    registerTabTeardown('FieldPhotos', stop);
    if (signedIn()) { loadTypes(); loadLib(); loadSync(); }
    if (typeof PhotoReview !== 'undefined') PhotoReview.init();
    paintThumbs(document.getElementById('fp-lib') || document);
  }
  // Leaving the tab stops nothing that matters: the queue keeps reading and
  // uploading, and says so when the tab comes back. What goes is the drag
  // highlight, which a drop that never landed would otherwise leave lit.
  function stop() {
    const el = document.getElementById('fp-drop');
    if (el) el.classList.remove('is-over');
  }

  // ── Drag and drop ──────────────────────────────────────────────────────────
  function dragOver(e) {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    e.currentTarget.classList.add('is-over');
  }
  function dragLeave(e) { e.currentTarget.classList.remove('is-over'); }
  function drop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('is-over');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  // ── The viewer ─────────────────────────────────────────────────────────────
  // One carousel for every door: the library, a spot in the twin, a pin on the
  // map, a station's photos. A dialog over the page, Escape or × to close,
  // Tab kept inside, focus handed back to whatever opened it — Modal's rules —
  // and ← → to walk the photos, swipe on a touch screen.

  let v = null;             // { ids, i, title, opener, editing, onKey, gold, goldSay, readingAcc }

  function view(ids, startId, { title = '' } = {}) {
    ids = (ids || []).filter(id => S().byId[id]);
    if (!ids.length) return;
    const opener = document.activeElement;
    unmountMoveMap();
    unmountSpotMap();
    // `gold`: the photos the compass last picked out — every one facing the
    // direction clicked, boxed on the strip — or null; `goldSay`, what the
    // note under the dial says about them.
    v = { ids, i: Math.max(0, ids.indexOf(startId)), title, opener, editing: false, gold: null, goldSay: '', readingAcc: false };
    let el = document.getElementById('fp-viewer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fp-viewer';
      el.className = 'fp-viewer';
      el.onclick = e => { if (e.target === el) close(); };
      document.body.appendChild(el);
    }
    el.hidden = false;
    v.onKey = onKey;
    document.addEventListener('keydown', v.onKey, true);
    paintViewer();
    const card = el.querySelector('.fp-v-card');
    if (card) card.focus();
    fetchMeta(ids[v.i]);
  }

  function close() {
    unmountMoveMap();
    unmountSpotMap();
    const el = document.getElementById('fp-viewer');
    if (el) { el.hidden = true; el.innerHTML = ''; }
    if (v) {
      document.removeEventListener('keydown', v.onKey, true);
      let back = v.opener;
      v = null;
      // The library may have been drawn again behind the viewer — a caption
      // saved re-reads it — taking the card that opened it with it. The same
      // photo's new card takes the focus instead.
      if (back && !document.contains(back) && back.dataset && back.dataset.fpId) {
        back = document.querySelector(`.fp-card[data-fp-id="${CSS.escape(back.dataset.fpId)}"]`);
      }
      if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
    }
  }
  function isOpen() { return !!v; }

  function go(delta) {
    if (!v) return;
    const n = v.ids.length;
    v.i = ((v.i + delta) % n + n) % n;
    v.editing = false;
    paintViewer();
    fetchMeta(v.ids[v.i]);
    const card = document.querySelector('#fp-viewer .fp-v-card');
    if (card && !card.contains(document.activeElement)) card.focus();
  }
  function goTo(i) { if (v) { v.i = i; v.editing = false; paintViewer(); fetchMeta(v.ids[v.i]); keepFocus(); } }

  function onKey(e) {
    if (!v) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (v.editing) { editPlace(); return; }
      close();
      return;
    }
    if (typing) return;
    // The move map's own keys — arrows pan it, Home and End are its too.
    if (e.target && e.target.closest && e.target.closest('.fp-v-map') && e.key !== 'Tab') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
    else if (e.key === 'End') { e.preventDefault(); goTo(v.ids.length - 1); }
    else if (e.key === 'Tab') {
      const card = document.querySelector('#fp-viewer .fp-v-card');
      const f = card ? [...card.querySelectorAll('button, a[href], input, textarea, select, [tabindex="0"]')].filter(x => !x.disabled && x.offsetParent !== null) : [];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  // The full row, meta included, for the one photo on screen.
  function fetchMeta(id) {
    const r = S().byId[id];
    if (!r || r._full) return;
    dbSelect(`field_photo?select=*&id=eq.${encodeURIComponent(id)}`)
      .then(rows => { if (rows[0]) { keep([Object.assign(rows[0], { _full: true })]); if (v && v.ids[v.i] === id) paintDetails(); } })
      .catch(() => {});
  }

  function paintViewer() {
    const el = document.getElementById('fp-viewer');
    if (!el || !v) return;
    unmountMoveMap();
    const r = S().byId[v.ids[v.i]];
    const n = v.ids.length;
    // The gold is about one spot's photos; walked on to another spot, it goes.
    if (v.gold && !spotRows(r).some(x => v.gold.has(x.id))) v.gold = null;
    const gold = v.gold || new Set();
    el.innerHTML = `
      <div class="fp-v-card" role="dialog" aria-modal="true" aria-labelledby="fp-v-title" tabindex="-1">
        <div class="fp-v-head">
          <h2 id="fp-v-title">${esc(v.title || 'Field photos')} <span class="small fp-v-count">— photo ${v.i + 1} of ${n}</span></h2>
          <button type="button" class="modal-x" aria-label="Close (Esc)" title="Close (Esc)" onclick="FieldPhotos.close()">×</button>
        </div>
        <div class="fp-v-body">
          <div class="fp-v-stage" id="fp-v-stage">
            <img id="fp-v-img" class="fp-v-img" alt="${escAttr(altOf(r))}" data-fp-src="${escAttr(r.storage_path)}">
            ${n > 1 ? `<button type="button" class="fp-v-nav fp-v-prev" onclick="FieldPhotos.go(-1)" aria-label="Previous photo">‹</button>
                       <button type="button" class="fp-v-nav fp-v-next" onclick="FieldPhotos.go(1)" aria-label="Next photo">›</button>` : ''}
          </div>
          <div class="fp-v-side">
            <div id="fp-v-details">${detailsHtml(r)}</div>
            <div id="fp-v-place"></div>
            <div class="fp-v-spot" id="fp-v-spot"></div>
            <div class="fp-v-compass" id="fp-v-compass">${compassHtml(r)}</div>
          </div>
        </div>
        ${n > 1 ? `<div class="fp-v-strip" role="group" aria-label="All ${n} photos">
          ${v.ids.map((id, i) => {
            const x = S().byId[id];
            return `<button type="button" class="fp-v-thumb${i === v.i ? ' is-here' : ''}${gold.has(id) ? ' is-gold' : ''}" onclick="FieldPhotos.goTo(${i})"
                            aria-label="${escAttr(thumbLabel(x, i))}" ${i === v.i ? 'aria-current="true"' : ''}>
                      <img data-fp-src="${escAttr(thumbOf(x))}" alt=""></button>`;
          }).join('')}
        </div>` : ''}
      </div>`;
    paintPlace();
    // The picture: its thumbnail at once (already signed, often already
    // loaded), the full size when it arrives.
    const img = el.querySelector('#fp-v-img');
    const t = urlFor(thumbOf(r));
    if (t) img.src = t;
    sign([r.storage_path]).then(([url]) => { if (url && img.isConnected && img.dataset.fpSrc === r.storage_path) img.src = url; });
    paintThumbs(el.querySelector('.fp-v-strip') || el);
    // The neighbours, ahead of the arrow.
    if (n > 1) {
      const nb = [v.ids[(v.i + 1) % n], v.ids[(v.i - 1 + n) % n]].map(id => S().byId[id]).filter(Boolean);
      sign(nb.map(x => x.storage_path)).then(urls => urls.forEach(u => { if (u) { const im = new Image(); im.src = u; } }));
    }
    const strip = el.querySelector('.fp-v-thumb.is-here');
    if (strip && strip.scrollIntoView) strip.scrollIntoView({ block: 'nearest', inline: 'center' });
    swipe(el.querySelector('#fp-v-stage'));
  }

  function altOf(r) {
    const st = r.station_id ? stationById(r.station_id) : null;
    const bits = [r.caption || r.title || 'Field photo'];
    if (st) bits.push(`at ${st.name}`);
    if (known(r.heading_deg)) bits.push(`facing ${headingText(+r.heading_deg, r.heading_ref)}`);
    if (whenText(r)) bits.push(whenText(r));
    return bits.join(', ');
  }
  // A thumbnail on the strip, in words: which, the way it looks, when — and
  // whether the compass boxed it.
  function thumbLabel(x, i) {
    const bits = [`Photo ${i + 1}`];
    if (known(x.heading_deg)) bits.push(`facing ${headingText(+x.heading_deg, x.heading_ref)}`);
    if (whenText(x)) bits.push(whenText(x));
    return bits.join(', ') + (v && v.gold && v.gold.has(x.id) ? ' — faces the direction picked on the compass' : '');
  }

  function swipe(stage) {
    if (!stage) return;
    let x0 = null, id = null;
    stage.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') { x0 = e.clientX; id = e.pointerId; } });
    stage.addEventListener('pointerup', e => {
      if (x0 === null || e.pointerId !== id) return;
      const dx = e.clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', () => { x0 = null; });
  }

  // The side, in its three parts, each painted on its own: the facts and the
  // buttons (redrawn when the full row arrives), the mover under them while
  // Move… is open (a map that must survive the facts being redrawn), and the
  // compass at the foot with the spot's map under it while the mover is shut.
  function paintDetails() {
    const el = document.getElementById('fp-v-details');
    if (el && v) el.innerHTML = detailsHtml(S().byId[v.ids[v.i]]);
  }
  function paintPlace() {
    unmountMoveMap();
    unmountSpotMap();
    const el = document.getElementById('fp-v-place');
    if (!el || !v) return;
    const r = S().byId[v.ids[v.i]];
    el.innerHTML = v.editing && r ? viewerPlaceHtml(r) : '';
    if (v.editing && r) mountMoveMap(r);
    const spot = document.getElementById('fp-v-spot');
    const show = !v.editing && r && known(r.lat) && known(r.lon) && typeof L !== 'undefined';
    if (spot) spot.innerHTML = show
      ? '<div class="fp-v-spotmap" id="fp-v-spotmap" role="region" aria-label="Satellite map of where this photo was taken"></div>' : '';
    if (show) mountSpotMap(r);
  }
  function paintCompass(note) {
    const el = document.getElementById('fp-v-compass');
    const r = v ? S().byId[v.ids[v.i]] : null;
    if (el && r) el.innerHTML = compassHtml(r, note);
    const ring = sm && sm.ring && sm.ring.getElement ? sm.ring.getElement() : null;
    if (ring && r) ring.innerHTML = dialHtml(r);
  }
  function paintSide() { paintDetails(); paintPlace(); paintCompass(); keepFocus(); }
  // A redraw takes the control that had the focus with it; the focus stays in
  // the dialog rather than falling to the page behind it.
  function keepFocus() {
    const card = document.querySelector('#fp-viewer .fp-v-card');
    if (card && !card.contains(document.activeElement)) card.focus({ preventScroll: true });
  }

  function detailsHtml(r) {
    if (!r) return '';
    const st = r.station_id ? stationById(r.station_id) : null;
    const placed = known(r.lat) && known(r.lon);
    const pl = PLACEMENT[r.placement] || null;
    const ocr = r.meta && r.meta.ocr ? r.meta.ocr : (r.ocr_confidence ? { confidence: r.ocr_confidence } : null);
    const zone = (r.meta && r.meta.taken && r.meta.taken.zone_source) || r.zone_source;
    const rel = st && placed && located(st)
      ? `${fmtM(metres(st.lat, st.lon, +r.lat, +r.lon))} ${compass(bearingDeg(st.lat, st.lon, +r.lat, +r.lon))} of the station`
      : '';
    const rows = [];
    rows.push(['Taken', whenText(r) ? `${esc(whenText(r))}${zone === 'assumed' ? ' <span class="small txt-muted">(zone assumed from where it was taken)</span>' : ''}${
      r.taken_source === 'ocr' ? ' <span class="small txt-muted">(read off the photo)</span>' : ''}` : '<span class="txt-muted">Not known</span>']);
    rows.push(['Where', placed
      ? `<span class="fp-coord">${esc(fmtCoord(r.lat, r.lon))}</span>${accHtml(r.accuracy_m)}
         <br><span class="small">${esc(pl ? pl.long : r.placement)}${r.placement === 'ocr' && ocr && ocr.confidence ? ` — ${esc(ocr.confidence)} confidence` : ''}</span>${readAccHtml(r)}`
      : '<span class="txt-warn">Not placed</span>']);
    if (known(r.heading_deg)) rows.push(['Facing', esc(headingText(+r.heading_deg, r.heading_ref))]);
    if (known(r.altitude_m)) rows.push(['Altitude', `${esc(String(Math.round(r.altitude_m)))} m${r.altitude_ref ? ` ${esc(r.altitude_ref)}` : ''}`]);
    rows.push(['Station', st ? `${esc(st.name)}${rel ? ` <span class="small txt-muted">— ${esc(rel)}${r.station_auto ? ', the nearest' : ''}</span>` : ''}` : '<span class="txt-muted">None within a kilometre</span>']);
    rows.push(['File', `${esc(r.title || '—')} <span class="small txt-muted">${r.width ? `${r.width} × ${r.height} · ` : ''}${esc(mb(r.byte_size || 0))}</span>`]);
    rows.push(['Added', `${esc(r.uploaded_by || '—')}${r.created_at ? `, ${esc(String(r.created_at).slice(0, 10))}` : ''}${
      r.origin === 'dropbox' ? ' <span class="fp-chip">Dropbox</span>' : r.origin === 'gdrive' ? ' <span class="fp-chip">Google Drive</span>' : ''}`]);
    const may = signedIn();
    return `
      <dl class="fp-v-facts">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>
      ${may ? `<label class="fp-v-caption">Caption
        <textarea rows="2" placeholder="What is in the picture" onchange="FieldPhotos.setCaption('${escAttr(r.id)}',this.value)">${esc(r.caption || '')}</textarea>
      </label>` : (r.caption ? `<p>${esc(r.caption)}</p>` : '')}
      <p class="small fp-v-msg" id="fp-v-msg" role="status"></p>
      <div class="button-group fp-v-actions">
        <button type="button" onclick="FieldPhotos.openOriginal('${escAttr(r.id)}')">Open the original ↗</button>
        ${placed ? `<button type="button" onclick="FieldPhotos.showOnMap('${escAttr(r.id)}')">🗺️ On the map</button>` : ''}
        ${st && located(st) && typeof DigitalTwin !== 'undefined' ? `<button type="button" onclick="FieldPhotos.showInTwin('${escAttr(r.id)}')">🧊 In the twin</button>` : ''}
        ${may ? `<button type="button" onclick="FieldPhotos.editPlace('${escAttr(r.id)}')" aria-expanded="${v && v.editing ? 'true' : 'false'}" aria-controls="fp-v-place">${placed ? 'Move…' : 'Place it…'}</button>` : ''}
        ${may && typeof PhotoReview !== 'undefined' ? `<button type="button" onclick="FieldPhotos.readLabels('${escAttr(r.id)}')"
             title="Read the makes, models and serial numbers on the equipment in this photo, and suggest them for its station's register">🔎 Read equipment labels</button>` : ''}
        ${may ? `<button type="button" onclick="FieldPhotos.removePhoto('${escAttr(r.id)}')">Remove</button>` : ''}
      </div>`;
  }

  // The mover: the map when Leaflet is on the page (it always is, bar a
  // blocked CDN), the coordinates box whether or not, and the stations.
  function viewerPlaceHtml(r) {
    const placed = known(r.lat) && known(r.lon);
    const around = placed ? stationsAround(+r.lat, +r.lon) : [];
    const others = placed ? spotRows(r).filter(x => x !== r) : [];
    const id = escAttr(r.id);
    const withMap = typeof L !== 'undefined';
    return `
      <div class="fp-place fp-v-move">
        ${withMap ? `<p class="small fp-v-move-lead">${placed
            ? 'Drag the pin to where the photo was taken, or click the map there.' : 'Click the map where the photo was taken.'}${
            placed && known(r.accuracy_m) ? ` The ring is the GPS's ±${Math.round(+r.accuracy_m)} m.` : ''}</p>
        <div class="fp-v-map" id="fp-v-map" role="region" aria-label="Map to move the photo's pin on — the coordinates box below does the same"></div>
        <p class="small fp-v-moved" id="fp-v-moved" aria-live="polite"></p>` : ''}
        <label class="fp-place-field">Coordinates
          <span class="fp-place-row">
            <input type="text" id="fp-v-coord" value="${placed ? escAttr(fmtCoord(r.lat, r.lon)) : ''}" placeholder="-27.554294, 152.274116"
                   autocomplete="off" spellcheck="false" oninput="FieldPhotos.moveTyped(this.value)"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();FieldPhotos.moveTo('${id}',this.value)}">
            <button type="button" class="primary" onclick="FieldPhotos.moveTo('${id}',document.getElementById('fp-v-coord').value)">Save</button>
          </span>
        </label>
        ${others.length ? `<label class="fp-v-with small"><input type="checkbox" id="fp-v-with" checked onchange="FieldPhotos.moveWith(this.checked)">
          Move the other ${others.length} photo${others.length === 1 ? '' : 's'} taken here with it, by the same distance</label>` : ''}
        ${around.length ? `<p class="small">File it under a station nearby:</p>
          <div class="fp-hits">${around.map(({ s, m }) => `<button type="button" class="fp-hit" onclick="FieldPhotos.fileUnder('${id}','${escAttr(s.id)}')">${esc(s.name)} <span class="small">${esc(fmtM(m))}</span></button>`).join('')}</div>` : ''}
        <label class="fp-place-field">${placed ? 'Or another station' : 'Or put it at a station'}
          <input type="search" placeholder="name or station number" autocomplete="off"
                 oninput="document.getElementById('fp-v-hits').innerHTML=FieldPhotos._hits(this.value,'${id}')">
        </label>
        <div id="fp-v-hits"></div>
        <div class="button-group"><button type="button" onclick="FieldPhotos.editPlace()">Cancel</button></div>
      </div>`;
  }

  function vSay(text, kind) {
    const el = document.getElementById('fp-v-msg');
    if (el) el.innerHTML = text ? `<span class="${kind === 'error' ? 'txt-bad' : 'txt-ok'}">${esc(text)}</span>` : '';
  }

  // A change to one photo. One that places it — a move, a station — shuts
  // the mover and redraws the side, since the spot, the compass and the
  // station may all be different now; a caption leaves the mover as it was.
  async function patch(id, p, done) {
    try {
      const row = await dbRpc('update_field_photo', { p_id: id, p_patch: p });
      keep([Object.assign(row, { _full: true })]);
      if (v && v.ids[v.i] === id) {
        if ('lat' in p || 'station_id' in p) { v.editing = false; paintSide(); }
        else paintDetails();
        vSay(done);
      }
      changed();
    } catch (err) {
      vSay(`Not saved — ${(err && err.message) || err}`, 'error');
    }
  }

  function setCaption(id, text) {
    const r = S().byId[id];
    if (!r || (r.caption || '') === text) return;
    patch(id, { caption: text }, 'Caption saved.');
  }
  // Move… / Place it… opens the mover, focused on its coordinates; pressed
  // again, Cancel or Escape shuts it and hands the focus back to the button.
  function editPlace() {
    if (!v) return;
    v.editing = !v.editing;
    paintDetails();
    paintPlace();
    const el = v.editing ? document.getElementById('fp-v-coord') : document.querySelector('#fp-v-details [aria-controls="fp-v-place"]');
    if (el) el.focus();
  }
  // Save: the photo to the coordinates in the box — where the pin was dragged
  // to, or what was typed — placed by hand. With "the other photos taken here
  // with it" ticked, each of those moves by the same offset, one patch each.
  async function moveTo(id, text) {
    const p = typeof Places !== 'undefined' ? Places.parse(text) : null;
    if (!p) { vSay(`“${text}” is not a coordinate this can read — try -27.5543, 152.2741`, 'error'); return; }
    const r = S().byId[id];
    if (!r) return;
    const lat = +p.lat.toFixed(7), lon = +p.lon.toFixed(7);
    const box = document.getElementById('fp-v-with');
    const others = box && box.checked && known(r.lat) && known(r.lon) ? spotRows(r).filter(x => x !== r) : [];
    if (!others.length) { await patch(id, { lat, lon, placement: 'manual' }, 'Moved.'); return; }
    const dLat = lat - +r.lat, dLon = lon - +r.lon;
    try {
      keep([Object.assign(await dbRpc('update_field_photo', { p_id: id, p_patch: { lat, lon, placement: 'manual' } }), { _full: true })]);
    } catch (err) {
      vSay(`Not saved — ${(err && err.message) || err}`, 'error');
      return;
    }
    let moved = 0, lastErr = null;
    for (const x of others) {
      try {
        const px = { lat: +(+x.lat + dLat).toFixed(7), lon: +(+x.lon + dLon).toFixed(7), placement: 'manual' };
        keep([Object.assign(await dbRpc('update_field_photo', { p_id: x.id, p_patch: px }), { _full: true })]);
        moved++;
      } catch (err) { lastErr = err; }
    }
    if (v) { v.editing = false; paintSide(); }
    const failed = others.length - moved;
    const what = failed ? `${moved} of the ${others.length} other photos` : others.length === 1 ? 'the other photo' : `the ${moved} other photos`;
    vSay(`Moved, and ${what} taken here with it.${failed ? ` ${failed} could not be moved — ${(lastErr && lastErr.message) || lastErr}.` : ''}`,
      failed ? 'error' : undefined);
    changed();
  }
  function fileUnder(id, stationId) {
    const r = S().byId[id], st = stationById(stationId);
    if (!r || !located(st)) return;
    const p = { station_id: st.id };
    if (!known(r.lat)) Object.assign(p, { lat: st.lat, lon: st.lon, placement: 'station' });
    patch(id, p, known(r.lat) ? `Filed under ${st.name}.` : `Placed at ${st.name}.`);
  }
  function hitsFor(text, id) {
    return stationHitsHtml(text, sid => `FieldPhotos.fileUnder('${escAttr(id)}','${escAttr(sid)}')`);
  }

  // The photos taken where this one was: its spot among the carousel's
  // photos, by the rule the map's pins and the twin's markers are drawn by
  // (spots(), over them in time order as those are). Just itself when it has
  // no place.
  function spotRows(r) {
    if (!r) return [];
    if (!v || !known(r.lat) || !known(r.lon)) return [r];
    const rows = v.ids.map(id => S().byId[id]).filter(x => x && known(x.lat) && known(x.lon)).sort(byTaken);
    const sp = spots(rows).find(g => g.rows.includes(r));
    return sp ? sp.rows : [r];
  }
  function fovOf(r) { return known(r.fov_deg) ? Math.max(1, Math.min(360, +r.fov_deg)) : FOV_ASSUMED; }

  // ── Moving a photo's pin ───────────────────────────────────────────────────
  // Move… opens a small map of the imagery under the buttons: the photo's pin
  // where it stands, the ring its GPS's ± draws round that fix (red past
  // ROUGH_M), the way it looks, and the other photos taken at the spot. Drag
  // the pin — or click the map — to where the photo was taken and the
  // coordinates box follows; Save writes them as placed by hand, which drops
  // the ± (the place is somebody's word now, not the GPS's). Photos taken at
  // the same spot were fixed by the same GPS within the minute and share its
  // error, so they go with it by the same offset unless that is unticked.
  // The box does all of it without the map, typed or pasted.
  //
  // One Leaflet map, made when the mover opens and taken down (removeMap, so
  // a zoom in flight cannot throw from its timer) when it shuts, the viewer
  // moves to another photo or closes: a map left behind would keep its
  // listeners on the window. It is a live map while it is up, for the nav's
  // re-measure. It is not taken down by a tab switch — the viewer sits over
  // every tab, and a mover emptied under it would be a dead map in a live
  // dialog. Imagery as below (addPhotoImagery), stretched to z21 — finer than
  // the tiles, and still the better place to drop a pin.
  let mm = null;    // { map, id, from, at, pin, ring, ghost, leader, cone, others: [{ row, dot }], withOthers }

  // The imagery under both photo maps. Esri's, as the Stations map's
  // Satellite base, at the bottom — but only its z18 tiles, stretched from
  // there: over much of the bush Esri has nothing at z19 and paints "Map data
  // not yet available", and a Leaflet layer cannot fall back tile by tile.
  // Over it, each State's own aerial program, tiled in Web Mercator:
  // Queensland's LatestStateProgram (the cache digital-twin.js exports from —
  // 10–20 cm in towns, Planet satellite where nothing was flown) and NSW's
  // SIX Maps imagery. Where a State has no tile at a zoom it answers 404, or
  // a transparent PNG past its border, and the layer below shows through.
  const STATE_IMAGERY = [
    { url: 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}',
      bounds: [[-37.6, 140.9], [-28.1, 153.7]], attribution: 'Imagery © Spatial Services NSW' },
    { url: 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}',
      bounds: [[-29.6, 137.6], [-8.9, 153.9]], attribution: 'Imagery © State of Queensland' },
  ];
  const QLD_BOX = { west: 137.6, east: 153.9, south: -29.6, north: -8.9 };

  // Queensland's photography runs to z20 nearly everywhere; elsewhere z19
  // is often not there, so a map opens a level out.
  function openZoom(lat, lon, z) {
    const q = lat >= QLD_BOX.south && lat <= QLD_BOX.north && lon >= QLD_BOX.west && lon <= QLD_BOX.east;
    return q ? z : z - 1;
  }

  function addPhotoImagery(map) {
    const base = typeof makeBaseLayers === 'function' ? makeBaseLayers().Satellite : null;
    if (base) {
      Object.assign(base.options, { maxNativeZoom: 18, maxZoom: 21, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
      base.addTo(map);
    }
    STATE_IMAGERY.forEach(s => L.tileLayer(s.url, {
      maxNativeZoom: 20, maxZoom: 21, minZoom: 6, bounds: s.bounds, attribution: s.attribution,
    }).addTo(map));
  }

  function unmountMoveMap() {
    if (!mm) return;
    const m = mm;
    mm = null;
    removeMap(m.map);
  }

  function mountMoveMap(r) {
    const el = document.getElementById('fp-v-map');
    if (!el || typeof L === 'undefined') return;
    const placed = known(r.lat) && known(r.lon);
    const from = placed ? [+r.lat, +r.lon] : null;
    const acc = placed && known(r.accuracy_m) ? +r.accuracy_m : null;
    const map = L.map(el, { maxZoom: 21, minZoom: 4, zoomControl: true, attributionControl: true, keyboard: true });
    registerLiveMap('FieldPhotos mover', () => (mm ? mm.map : null));
    map.attributionControl.setPrefix(false);
    addPhotoImagery(map);
    const box = document.getElementById('fp-v-with');
    mm = { map, id: r.id, from, at: from ? from.slice() : null, pin: null, ring: null, ghost: null, leader: null, cone: null,
           others: [], withOthers: !!(box && box.checked) };
    if (from) {
      if (acc) mm.ring = L.circle(from, { radius: acc, interactive: false, className: `fp-mm-ring${rough(acc) ? ' is-rough' : ''}` }).addTo(map);
      mm.ghost = L.circleMarker(from, { radius: 3.5, interactive: false, className: 'fp-mm-ghost' }).addTo(map);
      mm.others = spotRows(r).filter(x => x !== r).map(x => ({
        row: x, dot: L.circleMarker([+x.lat, +x.lon], { radius: 4, interactive: false, className: 'fp-mm-other' }).addTo(map),
      }));
      // The ring and a margin round it, or the pin close up.
      map.fitBounds(L.latLng(from).toBounds(Math.max(40, (acc || 0) * 3)), { maxZoom: openZoom(from[0], from[1], 20), animate: false });
    } else {
      const c = centreFor(r);
      map.setView([c.lat, c.lon], c.z, { animate: false });
    }
    if (mm.at) placePin();
    drawMove();
    map.on('click', e => setAt(e.latlng.lat, e.latlng.lng));
  }

  // ── The spot map ───────────────────────────────────────────────────────────
  // While the mover is shut: the same imagery with the photo's point, its
  // GPS ± and the compass ring round it (see The compass), and the other
  // photos taken at the spot. Look only: the
  // wheel is left to the side panel's scroll, and a pin is moved in Move….
  // Made and taken down with the side, like the mover (removeMap).
  let sm = null;    // { map, id }

  function unmountSpotMap() {
    if (!sm) return;
    const m = sm;
    sm = null;
    removeMap(m.map);
  }

  function mountSpotMap(r) {
    const el = document.getElementById('fp-v-spotmap');
    if (!el || typeof L === 'undefined') return;
    const at = [+r.lat, +r.lon];
    const acc = known(r.accuracy_m) ? +r.accuracy_m : null;
    const map = L.map(el, { maxZoom: 21, minZoom: 4, zoomControl: true, attributionControl: true, keyboard: true, scrollWheelZoom: false });
    registerLiveMap('FieldPhotos spot', () => (sm ? sm.map : null));
    map.attributionControl.setPrefix(false);
    addPhotoImagery(map);
    sm = { map, id: r.id };
    if (acc) L.circle(at, { radius: acc, interactive: false, className: `fp-mm-ring${rough(acc) ? ' is-rough' : ''}` }).addTo(map);
    spotRows(r).filter(x => x !== r).forEach(x => L.circleMarker([+x.lat, +x.lon], { radius: 4, interactive: false, className: 'fp-mm-other' }).addTo(map));
    L.circleMarker(at, { radius: 6, interactive: false, className: 'fp-sm-here' }).addTo(map);
    map.fitBounds(L.latLng(at).toBounds(Math.max(60, (acc || 0) * 3)), { maxZoom: openZoom(at[0], at[1], 19), animate: false });
    // The compass, on the map: a ring of screen size around the spot with
    // N E S W on it and a wedge per photo. Added once the view is set.
    const dial = dialHtml(r);
    if (dial) sm.ring = L.marker(at, {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'fp-cmp-icon', html: dial, iconSize: [DIAL.box, DIAL.box], iconAnchor: [DIAL.box / 2, DIAL.box / 2] }),
    }).addTo(map);
  }

  // Where a photo with no place yet is looked for: its station, the other
  // photos in the carousel, the Stations map's view, the network.
  function centreFor(r) {
    const st = r.station_id ? stationById(r.station_id) : null;
    if (located(st)) return { lat: +st.lat, lon: +st.lon, z: 18 };
    const near = v ? v.ids.map(id => S().byId[id]).find(x => x && known(x.lat) && known(x.lon)) : null;
    if (near) return { lat: +near.lat, lon: +near.lon, z: 17 };
    if (state.map && state.map.getCenter) {
      const c = state.map.getCenter();
      return { lat: c.lat, lon: c.lng, z: Math.max(12, Math.min(17, state.map.getZoom())) };
    }
    const h = home();
    return { lat: h.lat, lon: h.lon, z: 6 };
  }

  function placePin() {
    if (!mm || !mm.at || mm.pin) return;
    const m = mm;
    m.pin = L.marker(m.at, {
      draggable: true, keyboard: true, autoPan: true, riseOnHover: true,
      title: 'Drag to where the photo was taken', alt: 'The photo’s pin: drag it to where the photo was taken',
      icon: L.divIcon({ className: 'fp-mm-pin-icon', html: '<span class="fp-mm-pin"></span>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    }).addTo(m.map);
    const moved = () => { if (mm === m) { const ll = m.pin.getLatLng(); setAt(ll.lat, ll.lng, { fromPin: true }); } };
    m.pin.on('drag', moved).on('dragend', moved);
  }

  // The pin to a point: dragged there, clicked there or typed. The box
  // follows unless it is what was typed in.
  function setAt(lat, lon, o = {}) {
    if (!mm) return;
    mm.at = [lat, lon];
    if (!mm.pin) placePin();
    else if (!o.fromPin) mm.pin.setLatLng(mm.at);
    if (o.pan && !mm.map.getBounds().contains(mm.at)) mm.map.panTo(mm.at, { animate: false });
    drawMove();
    if (!o.fromBox) {
      const el = document.getElementById('fp-v-coord');
      if (el) el.value = fmtCoord(lat, lon);
    }
  }

  function conePoints(lat, lon, h, fov, len) {
    const ky = 1 / (KM_PER_DEG_LAT * 1000), kx = 1 / (kmPerDegLon(lat) * 1000);
    const pts = [[lat, lon]];
    const steps = Math.max(2, Math.ceil(fov / 10));
    for (let k = 0; k <= steps; k++) {
      const a = (h - fov / 2 + fov * k / steps) * Math.PI / 180;
      pts.push([lat + len * Math.cos(a) * ky, lon + len * Math.sin(a) * kx]);
    }
    return pts;
  }

  // What follows the pin: the leader from the fix, the cone the way the
  // camera looked, the others by the same offset, and the words.
  function drawMove() {
    if (!mm) return;
    const r = S().byId[mm.id];
    const { map, from, at } = mm;
    if (from && at) {
      if (mm.leader) mm.leader.setLatLngs([from, at]);
      else mm.leader = L.polyline([from, at], { interactive: false, className: 'fp-mm-leader' }).addTo(map);
    }
    if (at && r && known(r.heading_deg)) {
      const pts = conePoints(at[0], at[1], +r.heading_deg, fovOf(r), CONE_M);
      if (mm.cone) mm.cone.setLatLngs(pts);
      else mm.cone = L.polygon(pts, { interactive: false, className: 'fp-mm-cone' }).addTo(map);
    }
    const along = from && at && mm.withOthers;
    for (const o of mm.others) o.dot.setLatLng([+o.row.lat + (along ? at[0] - from[0] : 0), +o.row.lon + (along ? at[1] - from[1] : 0)]);
    const el = document.getElementById('fp-v-moved');
    if (el) el.textContent = movedText(r);
  }

  function movedText(r) {
    if (!mm || !mm.at) return 'Click the map where the photo was taken.';
    if (!mm.from) return 'Save puts the photo where the pin is.';
    const d = metres(mm.from[0], mm.from[1], mm.at[0], mm.at[1]);
    if (d < 0.5) return 'Not moved yet.';
    const acc = r && known(r.accuracy_m) ? ` (the GPS said ±${Math.round(+r.accuracy_m)} m)` : '';
    return `${fmtM(d)} ${compass(bearingDeg(mm.from[0], mm.from[1], mm.at[0], mm.at[1]))} of where the GPS put it${acc}. Save to keep it.`;
  }

  // The coordinates box, as it is typed: the pin goes there too.
  function moveTyped(text) {
    if (!mm) return;
    const p = typeof Places !== 'undefined' ? Places.parse(text) : null;
    if (p) setAt(p.lat, p.lon, { pan: true, fromBox: true });
  }
  function moveWith(on) {
    if (!mm) return;
    mm.withOthers = !!on;
    drawMove();
  }

  // ── The compass ────────────────────────────────────────────────────────────
  // On the spot map, round the photo's point: a ring the size of the screen
  // (not of the ground) with N E S W on it, and inside it a wedge per photo
  // taken at the spot, as wide as its lens saw (FOV_ASSUMED, dashed, where
  // the file did not say) — this photo's strong, the rest dimmed. A wedge is
  // a door: click a direction, on a wedge or on the ring, and the photo
  // facing it comes up. Where several look that way, all of them are boxed
  // in gold, on the strip and on the map, the one looking most nearly that
  // way comes up, and a click there again steps to the next. For a spot's
  // photos the strip is in the dial's order too — openSpot sorts them
  // N → E → S → W. The map is north-up, so the letters are true.
  //
  // In the SVG's 140-pixel box: the ring r 56 with the letters on it, the
  // wedges r 48; nothing is picked within the hub's r 6, where every wedge
  // meets. Only the wedges and the ring take the pointer; the rest is the map's.
  const DIAL = { face: 56, wedge: 48, label: 56, hub: 6, box: 140 };

  function polar(deg, rad) { const a = deg * Math.PI / 180; return [rad * Math.sin(a), -rad * Math.cos(a)]; }
  function wedgePath(h, fov, rad = DIAL.wedge) {
    const half = Math.min(179.9, fov / 2);
    const [x0, y0] = polar(h - half, rad), [x1, y1] = polar(h + half, rad);
    return `M0 0L${x0.toFixed(2)} ${y0.toFixed(2)}A${rad} ${rad} 0 ${half > 90 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}Z`;
  }

  function dialHtml(r) {
    if (!r || !v) return '';
    const faced = spotRows(r).filter(x => known(x.heading_deg));
    if (!faced.length) return '';
    const gold = v.gold || new Set();
    const n = v.ids.length;
    const ticks = [];
    for (let d = 22.5; d < 360; d += 22.5) {
      if (d % 90 === 0) continue;
      const [x0, y0] = polar(d, DIAL.face - 6), [x1, y1] = polar(d, DIAL.face);
      ticks.push(`<line class="fp-cmp-tick" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`);
    }
    const letters = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, d]) => {
      const [x, y] = polar(d, DIAL.label);
      return `<text class="fp-cmp-label${t === 'N' ? ' is-north' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" aria-hidden="true">${t}</text>`;
    }).join('');
    // The others first and this photo last, so that it is drawn on top.
    const wedges = faced.filter(x => x !== r).concat(faced.includes(r) ? [r] : []).map(x => {
      const i = v.ids.indexOf(x.id), fov = fovOf(x);
      const label = `${i >= 0 ? `Photo ${i + 1} of ${n}` : 'A photo'}, facing ${headingText(+x.heading_deg, x.heading_ref)}, ${
        known(x.fov_deg) ? `${Math.round(fov)}° wide` : 'its width not recorded'}${x === r ? ' — the one shown' : ''}`;
      const cls = `fp-cmp-wedge${x === r ? ' is-here' : ''}${gold.has(x.id) ? ' is-gold' : ''}${known(x.fov_deg) ? '' : ' is-assumed'}`;
      return `<path class="${cls}" d="${wedgePath(+x.heading_deg, fov)}" data-fp-id="${escAttr(x.id)}" tabindex="0" role="button"
                    aria-label="${escAttr(label)}"${x === r ? ' aria-current="true"' : ''}><title>${esc(label)}</title></path>`;
    }).join('');
    const half = DIAL.box / 2;
    return `<svg class="fp-cmp" width="${DIAL.box}" height="${DIAL.box}" viewBox="${-half} ${-half} ${DIAL.box} ${DIAL.box}" role="group"
           aria-label="Compass: which way the photos taken here look" onclick="FieldPhotos.compassClick(event)" onkeydown="FieldPhotos.compassKey(event)">
        <circle class="fp-cmp-face" r="${DIAL.face}"/>
        <circle class="fp-cmp-hit" r="${DIAL.face}"/>
        ${ticks.join('')}${wedges}${letters}
      </svg>`;
  }

  // Under the map: the way this photo looks, and what a click does.
  function compassHtml(r, note) {
    if (!r || !v) return '';
    const here = spotRows(r);
    const faced = here.filter(x => known(x.heading_deg));
    if (!faced.length) return '';
    const blind = here.length - faced.length;
    const lead = known(r.heading_deg)
      ? `Facing ${headingText(+r.heading_deg, r.heading_ref)}${known(r.fov_deg) ? `, ${Math.round(+r.fov_deg)}° wide` : ''}.`
      : 'Which way this one faced was not recorded.';
    const rest = note || (v.gold && v.goldSay) || (faced.length === 1 && faced[0] === r
      ? (here.length === 1 ? 'The only photo taken here.' : `The only one of the ${here.length} photos taken here with a direction.`)
      : `${here.length} photos taken here${blind ? ` (${blind} with no direction)` : ''} — click a direction for the one facing it.`);
    return `<p class="fp-cmp-note" id="fp-cmp-note">${esc(lead)} ${esc(rest)}</p>`;
  }

  // A click on the dial: the direction it points, from the dial's centre.
  function compassClick(e) {
    if (!v || !e || !e.currentTarget) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const k = DIAL.box / box.width;
    const x = (e.clientX - box.left - box.width / 2) * k, y = (e.clientY - box.top - box.height / 2) * k;
    const d = Math.hypot(x, y);
    if (d < DIAL.hub || d > DIAL.face + 4) return;
    pickFacing((Math.atan2(x, -y) * 180 / Math.PI + 360) % 360);
  }
  // Enter or Space on a wedge: that photo, and the others facing its way.
  function compassKey(e) {
    if (!v || (e.key !== 'Enter' && e.key !== ' ')) return;
    const id = e.target && e.target.dataset ? e.target.dataset.fpId : null;
    const x = id ? S().byId[id] : null;
    if (!x || !known(x.heading_deg)) return;
    e.preventDefault();
    pickFacing(+x.heading_deg, id);
    const w = document.querySelector(`#fp-v-spotmap [data-fp-id="${CSS.escape(id)}"]`);
    if (w) w.focus();
  }

  // The photos at this spot whose wedge takes in `deg`, the one looking most
  // nearly that way first. One of them: it comes up. Several: they are boxed
  // in gold and the first comes up — or, asked the same direction again, the
  // next after the one shown. `prefer` is a wedge chosen by the keyboard.
  function pickFacing(deg, prefer) {
    if (!v) return;
    const r = S().byId[v.ids[v.i]];
    const hits = spotRows(r).filter(x => known(x.heading_deg) && angleOff(deg, +x.heading_deg) <= fovOf(x) / 2 + 1e-6)
      .sort((a, b) => angleOff(deg, +a.heading_deg) - angleOff(deg, +b.heading_deg) || v.ids.indexOf(a.id) - v.ids.indexOf(b.id));
    const d = Math.round(deg) % 360;
    const where = `${d}° ${compass(d)}`;
    if (!hits.length) {
      v.gold = null;
      paintGold();
      paintCompass(`No photo taken here faces ${where}.`);
      return;
    }
    const ids = hits.map(x => x.id), cur = v.ids[v.i];
    const again = !!v.gold && v.gold.size === ids.length && ids.every(id => v.gold.has(id)) && ids.includes(cur);
    const next = prefer && ids.includes(prefer) ? prefer : again ? ids[(ids.indexOf(cur) + 1) % ids.length] : ids[0];
    v.gold = ids.length > 1 ? new Set(ids) : null;
    // What the boxes mean, said under the dial for as long as they stand.
    v.goldSay = ids.length > 1 ? `${ids.length} photos taken here face ${where} — boxed in gold on the strip. Click there again for the next.` : '';
    const i = v.ids.indexOf(next);
    if (i >= 0 && i !== v.i) goTo(i);
    else { paintGold(); paintCompass(); }
    if (v.goldSay && typeof announce === 'function') announce(v.goldSay);
  }

  // The gold boxes on the strip, without drawing it again.
  function paintGold() {
    if (!v) return;
    document.querySelectorAll('#fp-viewer .fp-v-thumb').forEach((b, i) => {
      const x = S().byId[v.ids[i]];
      if (!x) return;
      b.classList.toggle('is-gold', !!(v.gold && v.gold.has(x.id)));
      b.setAttribute('aria-label', thumbLabel(x, i));
    });
  }

  // ── Reading a stored photo's ± off its overlay ─────────────────────────────
  // A photo stored before the upload read the ± off the picture — from an
  // app that prints it there and leaves it out of the file (Solocator,
  // PhotoMeta.printsAccuracy) — says so under its coordinates and offers to
  // read it now: out of the stored picture, by the same OCR as the upload,
  // for it and every other photo taken at the spot that still lacks one, one
  // at a time. The ± is taken for the position already stored only when the
  // overlay's own position is the same fix (PhotoMeta.overlayAccuracy).
  function softwareOf(r) { return r.camera_software || (r.meta && r.meta.camera && r.meta.camera.software) || ''; }
  function needsAccuracy(r) {
    return !!r && known(r.lat) && known(r.lon) && !known(r.accuracy_m) && (r.placement === 'exif' || r.placement === 'xmp')
      && typeof PhotoMeta !== 'undefined' && PhotoMeta.printsAccuracy({ software: softwareOf(r) });
  }
  function readAccHtml(r) {
    if (!signedIn() || !needsAccuracy(r)) return '';
    const n = spotRows(r).filter(needsAccuracy).length;
    return `<br><span class="small txt-muted">No ± in the file — ${esc(softwareOf(r))} printed it on the picture.</span>
      <button type="button" class="link-btn small" onclick="FieldPhotos.readAccuracy('${escAttr(r.id)}')" ${v && v.readingAcc ? 'disabled' : ''}>${
        v && v.readingAcc ? 'Reading…' : n > 1 ? `Read it off the ${n} photos taken here` : 'Read it off the photo'}</button>`;
  }

  async function readAccuracy(id) {
    if (!v || v.readingAcc || typeof PhotoMeta === 'undefined') return;
    const r = S().byId[id];
    if (!r) return;
    const todo = [r, ...spotRows(r).filter(x => x !== r)].filter(needsAccuracy);
    if (!todo.length) return;
    if (S().reading) { vSay('Photos are being read on the Field Photos tab — try again when they are done.', 'error'); return; }
    const mine = v;
    mine.readingAcc = true;
    paintDetails();
    let got = 0, none = 0, failed = 0, lastErr = null;
    try {
      for (let k = 0; k < todo.length && v === mine; k++) {
        const x = todo[k];
        const lead = todo.length > 1 ? `Photo ${k + 1} of ${todo.length}: reading` : 'Reading';
        vSay(`${lead} the ± off the picture…`);
        try {
          const acc = await accuracyOffPicture(x, n => { if (v === mine) vSay(`${lead} the ± off the picture — pass ${n}…`); });
          if (acc === null) { none++; continue; }
          keep([Object.assign(await dbRpc('update_field_photo', { p_id: x.id, p_patch: { accuracy_m: acc } }), { _full: true })]);
          got++;
          if (v === mine && v.ids[v.i] === x.id) paintDetails();
        } catch (err) { failed++; lastErr = err; }
      }
    } finally {
      mine.readingAcc = false;
    }
    if (v === mine) {
      paintDetails();
      paintCompass();
      keepFocus();
      const bits = [];
      if (got) bits.push(todo.length === 1 ? 'The ± is read and saved.' : `${got} of ${todo.length} read and saved.`);
      if (none) bits.push(todo.length === 1 ? 'No ± could be read off it.' : `No ± could be read off ${none}.`);
      if (failed) bits.push(`${failed} could not be read — ${(lastErr && lastErr.message) || lastErr}.`);
      vSay(bits.join(' '), got && !failed ? undefined : 'error');
    }
    if (got) changed();
  }

  async function accuracyOffPicture(r, onPass) {
    const [url] = await sign([r.storage_path]);
    if (!url) throw new Error('its link could not be signed');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`it could not be fetched (HTTP ${res.status})`);
    const blob = await res.blob();
    let bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (_) { bmp = await createImageBitmap(blob); }
    try {
      const ocr = await PhotoMeta.ocrImage(bmp, bmp.width, bmp.height, { home: home(), onPass });
      return PhotoMeta.overlayAccuracy(ocr, { lat: +r.lat, lon: +r.lon });
    } finally {
      try { bmp.close(); } catch (_) { /* already gone */ }
    }
  }

  // "🔎 Read equipment labels": this photo's labels read, and what they say
  // proposed for its station's register — by the Review panel's scanner, so
  // one photo and a station's worth are read and proposed the same way.
  async function readLabels(id) {
    const r = S().byId[id];
    if (!r || typeof PhotoReview === 'undefined') return;
    if (!r.station_id) {
      vSay('File this photo under a station first (Move…) — what its labels say is suggested for a station\'s register.', 'error');
      return;
    }
    const here = () => v && v.ids[v.i] === id;
    vSay('Reading the labels — the whole picture, then its four quarters…');
    const out = await PhotoReview.scan([{ id: r.id, station_id: r.station_id, title: r.title, storage_path: r.storage_path }], {
      what: 'this photo',
      onProgress: text => { if (here()) vSay(text); },
    });
    if (here()) vSay(out.text, out.kind === 'error' ? 'error' : undefined);
  }

  async function removePhoto(id) {
    const r = S().byId[id];
    if (!r) return;
    if (!window.confirm(`Remove ${r.title || 'this photo'}? The picture is deleted, not just hidden, and it will not `
                      + `come back from Dropbox.`)) return;
    try {
      const out = await dbRpc('remove_field_photo', { p_id: id });
      if (out && out.storage_path) {
        try { await dbRemoveObject(out.storage_bucket || BUCKET, out.storage_path); } catch (_) { /* swept later */ }
        if (out.thumb_path) { try { await dbRemoveObject(out.storage_bucket || BUCKET, out.thumb_path); } catch (_) { /* swept later */ } }
      }
      delete S().byId[id];
      if (S().lib) S().lib = S().lib.filter(x => x.id !== id);
      announce('Photo removed');
      if (v) {
        v.ids = v.ids.filter(x => x !== id);
        if (!v.ids.length) close();
        else { v.i = Math.min(v.i, v.ids.length - 1); v.editing = false; paintViewer(); }
      }
      changed();
    } catch (err) {
      vSay(`Not removed — ${(err && err.message) || err}`, 'error');
    }
  }

  // The full-size picture is already signed for the viewer, almost always, so
  // it opens inside the click — a window opened after an await is one a popup
  // blocker is entitled to refuse.
  async function openOriginal(id) {
    const r = S().byId[id];
    if (!r) return;
    const ready = urlFor(r.storage_path);
    if (ready) { window.open(ready, '_blank', 'noopener'); return; }
    const [url] = await sign([r.storage_path]);
    if (url) window.open(url, '_blank', 'noopener');
    else vSay('The original could not be opened — the link could not be signed.', 'error');
  }

  // Where it was taken, on the Stations map: zoomed to the spot. Close enough
  // to see the pin, not so close that the map hands over to the twin — that is
  // the other button.
  function showOnMap(id) {
    const r = S().byId[id];
    if (!r || !known(r.lat)) return;
    close();
    state.mapPhotos = true;
    try { localStorage.setItem('mn-field-photos', 'on'); } catch (_) { /* memory only */ }
    if (typeof switchTab === 'function') switchTab('stations');
    if (state.map) state.map.setView([+r.lat, +r.lon], 16);
  }

  function showInTwin(id) {
    const r = S().byId[id];
    if (!r || !r.station_id || typeof DigitalTwin === 'undefined') return;
    close();
    if (DigitalTwin.focusPhoto) DigitalTwin.focusPhoto(id);
    DigitalTwin.openStation(r.station_id);
  }

  // ── The doors the rest of the app opens ────────────────────────────────────

  function openFromLib(id) {
    const ids = (S().lib || []).map(r => r.id);
    const f = S().filter;
    const st = f.show === 'station' && f.station ? stationById(f.station) : null;
    view(ids, id, { title: f.show === 'unplaced' ? 'Unplaced photos' : st ? `Photos at ${st.name}` : 'Field photos' });
  }
  async function openOne(id) {
    if (!S().byId[id]) {
      try { keep(await dbSelect(`field_photo?select=${COLS}&id=eq.${encodeURIComponent(id)}`)); } catch (_) { /* below */ }
    }
    view([id], id, { title: 'Field photo' });
  }
  // A spot's photos (the twin's marker, the map's pin), in the compass's
  // order: spot by spot as they were handed over, and within a spot N → E →
  // S → W by the way each looked, so the strip reads round the dial the way
  // its wedges do. A photo with no heading comes after the ones with; one
  // with no place, last of all. Opened on the first unless told otherwise.
  function openSpot(ids, startId, title) {
    const ordered = byCompass(ids);
    view(ordered, startId || ordered[0], { title: title || 'Photos taken here' });
  }
  function byCompass(ids) {
    const rows = (ids || []).map(id => S().byId[id]).filter(Boolean);
    const at = new Map(rows.map((r, i) => [r.id, i]));
    const bearing = r => (known(r.heading_deg) ? ((+r.heading_deg % 360) + 360) % 360 : 999);
    const groups = spots(rows.filter(r => known(r.lat) && known(r.lon)).sort(byTaken))
      .map(g => ({ rows: g.rows, first: Math.min(...g.rows.map(r => at.get(r.id))) }))
      .sort((a, b) => a.first - b.first);
    const out = [];
    for (const g of groups) out.push(...g.rows.slice().sort((a, b) => bearing(a) - bearing(b) || byTaken(a, b)).map(r => r.id));
    for (const r of rows) if (!out.includes(r.id)) out.push(r.id);
    return out;
  }

  // The station card's door: this tab, filtered to the one station.
  function openStation(id) {
    const st = stationById(id);
    if (!st) return;
    S().filter = { show: 'station', station: id };
    S().libLimit = PAGE;
    if (typeof switchTab === 'function') switchTab('photos');
  }
  function pillHtml(s) {
    if (!signedIn() || !s) return '';
    return `<button type="button" class="pill mn-photos" onclick="FieldPhotos.openStation('${escAttr(s.id)}')"
             title="The field photos filed under this station, on the Field Photos tab">📷 Field photos →</button>`;
  }

  function setShow(show) {
    const f = S().filter;
    f.show = show;
    if (show !== 'station') f.station = f.station || '';
    S().libLimit = PAGE;
    repaintFilter();
    loadLib(true);
  }
  function more() { S().libLimit += PAGE; loadLib(true); }
  function retry() {
    const s = S();
    s.types = null; s.typesError = null; s.typesP = null;
    loadTypes(); loadLib(true); loadSync();
    repaint();
  }

  // Signed in or out: what was cached was cached for somebody else. The tab
  // is drawn again whole — the queue is state, not DOM, so nothing in it is
  // lost — and whoever draws photos is told.
  function authChanged() {
    const s = S();
    s.near = {}; s.lib = null; s.libKey = ''; s.sync = null; s.urls = {};
    if (!signedIn()) { s.byId = {}; close(); }
    if (typeof PhotoReview !== 'undefined') PhotoReview.authChanged();
    if (state.activeTab === 'photos' && typeof renderMain === 'function') renderMain();
    changed();
  }

  return {
    render, init, stop,
    addFiles, uploadAll, clearFinished, removeFromQueue, retry, more, setShow,
    queuePlace, queueAtStation, queueNoStation, queueEdit, queueFind,
    dragOver, dragLeave, drop,
    view, close, isOpen, go, goTo, openFromLib, openOne, openSpot, openStation, pillHtml,
    setCaption, editPlace, moveTo, moveTyped, moveWith, fileUnder, removePhoto, openOriginal, showOnMap, showInTwin,
    compassClick, compassKey, readAccuracy,
    inBox, spots, sign, thumbOf, urlFor, paintThumbs, row: id => S().byId[id] || null,
    authChanged, changed, signedIn,
    nearestStation, whenText, headingText,
    dbxKey, dbxOpen, dbxFinish, dbxCopy,
    readLabels, setReadLabels,
    // For the Review panel (photo-review.js): the station finder, the words
    // for a queue row's state, the zip packs, and whether the log was written.
    stationHits: (text, onPick) => stationHitsHtml(text, onPick),
    statusText: st => STATUS[st] || st,
    packs: () => packs().map(p => ({ key: p.key, name: p.name, size: p.size, status: p.status, photos: p.photos,
                                     leftOut: p.leftOut.slice(), junk: p.junk, note: p.note })),
    logError: () => S().logError || null,
    _hits: hitsFor,
    // Read by the check and by nothing else.
    _queue: () => S().queue.map(i => ({
      key: i.key, name: i.name, status: i.status, note: i.note, sha: i.sha,
      from: i.from || null, pack: i.pack || null, held: !!(i.file || i.uploadBlob), bytes: i.uploadBytes || null,
      pos: i.pos ? { ...i.pos } : null, heading: i.heading ? { ...i.heading } : null,
      altitude: i.altitude ? { ...i.altitude } : null, taken: i.taken ? { ...i.taken } : null,
      station: i.station ? { ...i.station } : null, ocr: i.ocr ? { confidence: i.ocr.confidence, votes: i.ocr.votes, passes: i.ocr.passes } : null,
      width: i.width, height: i.height, contentType: i.contentType, ext: i.ext, converted: !!i.converted,
      decoder: i.decoder || null,
      thumb: !!i.thumbBlob, row: i.row ? { id: i.row.id } : null, existingId: i.existingId || null,
    })),
    _record: key => { const i = S().queue.find(x => x.key === key); return i && i.uploadBytes ? photoRecord(i, 'photo/x.jpg', 'photo/x.thumb.jpg') : null; },
    _sha256js: bytes => sha256js(bytes),
    _viewer: () => (v ? { ids: v.ids.slice(), i: v.i, title: v.title, editing: v.editing, gold: v.gold ? [...v.gold] : [],
                          readingAcc: !!v.readingAcc,
                          moving: mm ? { id: mm.id, from: mm.from && mm.from.slice(), at: mm.at && mm.at.slice(), withOthers: mm.withOthers,
                                         pin: !!mm.pin, ring: mm.ring ? mm.ring.getRadius() : null, others: mm.others.length,
                                         zoom: mm.map.getZoom() } : null } : null),
    // Where the move map's pin is on the screen, for the check to drag it.
    _pinAt: () => {
      if (!mm || !mm.pin) return null;
      const p = mm.map.latLngToContainerPoint(mm.pin.getLatLng()), b = mm.map.getContainer().getBoundingClientRect();
      return { x: b.left + p.x, y: b.top + p.y };
    },
    _mapPoint: (lat, lon) => {
      if (!mm) return null;
      const p = mm.map.latLngToContainerPoint([lat, lon]), b = mm.map.getContainer().getBoundingClientRect();
      return { x: b.left + p.x, y: b.top + p.y };
    },
  };
})();
if (typeof window !== 'undefined') window.FieldPhotos = FieldPhotos;
