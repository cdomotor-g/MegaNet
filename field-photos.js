// MegaNet — field-photos.js
//
//   FieldPhotos   the Field Photos tab — photos in, by the handful or the
//                 folderful, each placed where it was taken — and the viewer
//                 every other part of the app opens a photo in: a carousel
//                 over the photos taken at one spot, one station or one view.
//
// After core.js, photo-meta.js and datastore.js, before init.js — index.html
// holds the order and the reasons. Reaches back to core.js for state, esc,
// escAttr, announce, registerTabTeardown, KM_PER_DEG_LAT, kmPerDegLon,
// bearingDeg and fmtKm; to photo-meta.js for PhotoMeta; to datastore.js for
// dbSelect, dbRpc, dbCanWrite, dbUploadObject, dbSignedUrl, dbSignedUrls and
// dbRemoveObject; to auth.js for Auth; to places.js for Places.parse; and to
// app.js for switchTab, showStationCard, prepareSearch and
// stationMatchesSearch. Across to digital-twin.js and map-photos.js, which draw
// what this file holds and are told when it changes. Every one of those is a
// runtime call from inside a function here; nothing executes at load
// (`npm run toplevel`).
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
// ── Who may see them ─────────────────────────────────────────────────────────
//
// Editors, signed in: the rows, the positions and the bytes (0035's head says
// why). Signed out, the tab says so and the twin and the map draw nothing.
//
// Issue: the Field Photos epic. Schema: db/migrations/0035_field_photos.sql.
// Bucket: tools/storage_bucket.sql. The whole of it: docs/field-photos.md.

const FieldPhotos = (function () {

  const BUCKET = 'field-photos';
  const SIGNED_FOR = 3600;         // a thumbnail's URL outlives a session, and not by much
  const THUMB_PX = 480;
  const MATCH_M = 1000;            // the nearest station within this is the one it is of
  const NEAR_KM = 25;              // stations offered as a photo's station, around it
  const AT_ONCE = 2;               // uploads in flight
  const PAGE = 60;                 // photos in one page of the library
  const SPOT_M = 3;                // photos this close are "taken there", one marker

  // What the library, the twin and the map ask for — everything but `meta`,
  // which holds the OCR's raw readings and is the viewer's to fetch, not a
  // grid's. The two things from it that are shown everywhere come out by path.
  const COLS = 'id,storage_path,thumb_path,content_type,byte_size,width,height,title,caption,'
             + 'taken_at,taken_local,taken_source,lat,lon,placement,accuracy_m,altitude_m,altitude_ref,'
             + 'heading_deg,heading_ref,pitch_deg,fov_deg,station_id,station_auto,origin,uploaded_by,'
             + 'created_at,updated_at,ocr_confidence:meta->ocr->>confidence,zone_source:meta->taken->>zone_source';

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
      g.rows.sort((a, b) => String(a.taken_at || a.created_at).localeCompare(String(b.taken_at || b.created_at)));
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

  function addFiles(list) {
    const files = Array.from(list || []).filter(looksLikeImage);
    const skipped = Array.from(list || []).length - files.length;
    if (!files.length) {
      say(skipped ? 'None of those are photos this tab reads (JPEG, PNG, WebP or HEIC).' : '', 'warn');
      return;
    }
    const s = S();
    for (const file of files) {
      s.queue.push({ key: `q${++seq}`, file, name: file.name, size: file.size, status: 'waiting', note: '' });
    }
    say(`${files.length} photo${files.length === 1 ? '' : 's'} added${skipped ? ` — ${skipped} file${skipped === 1 ? ' was' : 's were'} not a photo and ${skipped === 1 ? 'was' : 'were'} left out` : ''}. Reading them…`);
    repaintQueue();
    readQueue();
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
    const file = item.file;
    item.status = 'reading';
    item.note = 'Reading the file…';
    repaintQueue();

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
      // Dropbox sync places a photo by.
      let ocr = null;
      if (PhotoMeta.needsOcr(meta)) {
        const want = meta.gps ? 'the time printed on the photo' : 'the position printed on the photo';
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
    go.forEach(i => { i.status = 'queued'; i.note = 'Waiting to upload…'; });
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
          else { item.status = 'failed'; item.note = (err && err.message) || String(err); }
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
  }

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
    await dbUploadObject(BUCKET, path, item.uploadBlob);
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
      meta: item.meta, name: item.name, size: item.size, type: item.file.type || null,
      converted: !!item.converted, width: item.width, height: item.height, caption: item.caption,
      pos: item.pos, heading: item.heading, altitude: item.altitude, taken: item.taken,
      pitch: item.pitch, fov: item.fov, ocr: item.ocr,
    });
    Object.assign(p, {
      storage_path: path, thumb_path: thumb,
      content_type: item.contentType, byte_size: item.uploadBlob.size, sha256: item.sha,
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
    say('');
    repaintQueue();
  }

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
    <div class="panel" id="fp-sync-panel">
      <div class="panel-header"><h2>From Dropbox</h2></div>
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
        <p class="fp-drop-lead"><strong>Drop photos here</strong>, or choose them:</p>
        <div class="button-group">
          <label class="fp-pick"><span>📷 Choose photos</span>
            <input type="file" id="fp-files" multiple accept="image/*,.heic,.heif"
                   onchange="FieldPhotos.addFiles(this.files);this.value=''"></label>
          <label class="fp-pick"><span>📁 Choose a folder</span>
            <input type="file" id="fp-folder" multiple webkitdirectory
                   onchange="FieldPhotos.addFiles(this.files);this.value=''"></label>
        </div>
        <p class="small txt-muted">Each photo is placed where it was taken: from the camera's own GPS if the file
          has it, and otherwise from the position a field camera app printed on the picture (Solocator, GPS Map
          Camera and the like), read off it by OCR. Nothing is uploaded until you press Upload — check the
          positions first. A photo nothing can place still uploads, into <em>Unplaced</em>.</p>
      </div>
      <p class="small fp-msg" id="fp-msg" role="status">${msgHtml()}</p>
      <div id="fp-queue">${queueHtml()}</div>`;
  }

  const STATUS = {
    waiting: 'Waiting', reading: 'Reading', ocr: 'Reading the overlay', ready: 'Ready', refused: 'Refused',
    queued: 'Waiting to upload', uploading: 'Uploading', done: 'Uploaded', already: 'Already in MegaNet', failed: 'Failed',
  };

  function queueHtml() {
    const q = S().queue;
    if (!q.length) return '';
    const ready = q.filter(i => i.status === 'ready' || i.status === 'failed').length;
    const busy = q.some(i => ['waiting', 'reading', 'ocr', 'queued', 'uploading'].includes(i.status));
    const finished = q.some(i => ['done', 'already', 'refused'].includes(i.status));
    return `
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
      ? `<span class="fp-coord">${esc(fmtCoord(pos.lat, pos.lon))}</span>${known(pos.accuracy) ? ` <span class="small">±${esc(String(Math.round(pos.accuracy)))} m</span>` : ''}
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
        <span class="fp-q-name">${esc(item.name)}</span> <span class="small txt-muted">${esc(mb(item.size))}</span></td>
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

  function syncHtml() {
    const s = S();
    if (!signedIn()) return '<p class="small txt-muted">Sign in to see what the Dropbox sync has done.</p>';
    const rows = s.sync;
    const how = `Photos saved into the linked Dropbox folder are imported by a scheduled job about every
      fifteen minutes, and placed the same way as the ones dropped here. Setting it up is a Dropbox app and
      three secrets — <a href="${esc(typeof docUrl === 'function' ? docUrl('docs/field-photos.md') : 'docs/field-photos.md')}" target="_blank" rel="noopener">docs/field-photos.md</a> has the steps.`;
    if (s.syncError) return `<p class="small txt-bad">The sync's report could not be read — ${esc(s.syncError)}.</p><p class="small">${how}</p>${connectHtml()}`;
    if (!rows) return '<p class="small">Loading…</p>';
    const d = rows.find(r => r.source === 'dropbox');
    if (!d || !d.last_run_at) return `<p class="small">Not set up yet — nothing has reported from Dropbox.</p><p class="small txt-muted">${how}</p>${connectHtml()}`;
    const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
    const ok = d.last_ok_at && (!d.last_error || Date.parse(d.last_ok_at) >= Date.parse(d.last_run_at));
    return `
      <p class="small ${ok ? 'txt-ok' : 'txt-bad'}"><strong>${ok ? 'Working' : 'Failing'}</strong> — last ran ${esc(ago(d.last_run_at))}${
        d.account ? `, reading ${esc(d.account)}'s Dropbox` : ''}${d.folder ? ` (${esc(d.folder)})` : ''}.</p>
      ${!ok && d.last_error ? `<p class="small txt-bad">${esc(d.last_error)}</p>` : ''}
      <p class="small">Last run: ${d.seen} new file${d.seen === 1 ? '' : 's'} seen, ${d.imported} imported${d.unplaced ? ` (${d.unplaced} could not be placed — see <button type="button" class="link-btn" onclick="FieldPhotos.setShow('unplaced')">Unplaced</button>)` : ''}, ${d.skipped} skipped, ${d.failed} failed.</p>
      <p class="small txt-muted">${how}</p>
      ${connectHtml()}`;
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
  function repaint() { repaintAdd(); repaintLib(); repaintSync(); repaintFilter(); }
  function repaintAdd() {
    const el = document.getElementById('fp-add-panel');
    if (!el) return;
    if (document.getElementById('fp-drop') && signedIn() && !S().typesError) { repaintQueue(); return; }
    el.innerHTML = `<div class="panel-header"><h2>Add field photos</h2></div>${addHtml()}`;
  }
  function repaintQueue() {
    const el = document.getElementById('fp-queue');
    if (el) el.innerHTML = queueHtml();
  }
  function repaintQueueRow(item) {
    const row = document.getElementById(`fp-row-${item.key}`);
    const edit = document.getElementById(`fp-edit-${item.key}`);
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

  let v = null;             // { ids, i, title, opener, editing, onKey }

  function view(ids, startId, { title = '' } = {}) {
    ids = (ids || []).filter(id => S().byId[id]);
    if (!ids.length) return;
    const opener = document.activeElement;
    v = { ids, i: Math.max(0, ids.indexOf(startId)), title, opener, editing: false };
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
  function goTo(i) { if (v) { v.i = i; v.editing = false; paintViewer(); fetchMeta(v.ids[v.i]); } }

  function onKey(e) {
    if (!v) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (v.editing) { v.editing = false; paintViewer(); return; }
      close();
      return;
    }
    if (typing) return;
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
    const r = S().byId[v.ids[v.i]];
    const n = v.ids.length;
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
          <div class="fp-v-side" id="fp-v-details">${detailsHtml(r)}</div>
        </div>
        ${n > 1 ? `<div class="fp-v-strip" role="group" aria-label="All ${n} photos">
          ${v.ids.map((id, i) => {
            const x = S().byId[id];
            return `<button type="button" class="fp-v-thumb${i === v.i ? ' is-here' : ''}" onclick="FieldPhotos.goTo(${i})"
                            aria-label="Photo ${i + 1}${whenText(x) ? `, ${escAttr(whenText(x))}` : ''}" ${i === v.i ? 'aria-current="true"' : ''}>
                      <img data-fp-src="${escAttr(thumbOf(x))}" alt=""></button>`;
          }).join('')}
        </div>` : ''}
      </div>`;
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

  function paintDetails() {
    const el = document.getElementById('fp-v-details');
    if (el && v) el.innerHTML = detailsHtml(S().byId[v.ids[v.i]]);
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
      ? `<span class="fp-coord">${esc(fmtCoord(r.lat, r.lon))}</span>${known(r.accuracy_m) ? ` ±${esc(String(Math.round(r.accuracy_m)))} m` : ''}
         <br><span class="small">${esc(pl ? pl.long : r.placement)}${r.placement === 'ocr' && ocr && ocr.confidence ? ` — ${esc(ocr.confidence)} confidence` : ''}</span>`
      : '<span class="txt-warn">Not placed</span>']);
    if (known(r.heading_deg)) rows.push(['Facing', esc(headingText(+r.heading_deg, r.heading_ref))]);
    if (known(r.altitude_m)) rows.push(['Altitude', `${esc(String(Math.round(r.altitude_m)))} m${r.altitude_ref ? ` ${esc(r.altitude_ref)}` : ''}`]);
    rows.push(['Station', st ? `${esc(st.name)}${rel ? ` <span class="small txt-muted">— ${esc(rel)}${r.station_auto ? ', the nearest' : ''}</span>` : ''}` : '<span class="txt-muted">None within a kilometre</span>']);
    rows.push(['File', `${esc(r.title || '—')} <span class="small txt-muted">${r.width ? `${r.width} × ${r.height} · ` : ''}${esc(mb(r.byte_size || 0))}</span>`]);
    rows.push(['Added', `${esc(r.uploaded_by || '—')}${r.created_at ? `, ${esc(String(r.created_at).slice(0, 10))}` : ''}${r.origin === 'dropbox' ? ' <span class="fp-chip">Dropbox</span>' : ''}`]);
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
        ${may ? `<button type="button" onclick="FieldPhotos.removePhoto('${escAttr(r.id)}')">Remove</button>` : ''}
      </div>
      ${v && v.editing ? `<div id="fp-v-place">${viewerPlaceHtml(r)}</div>` : ''}`;
  }

  function viewerPlaceHtml(r) {
    const placed = known(r.lat);
    const around = placed ? stationsAround(+r.lat, +r.lon) : [];
    return `
      <div class="fp-place">
        <label class="fp-place-field">Coordinates
          <span class="fp-place-row">
            <input type="text" id="fp-v-coord" value="${placed ? escAttr(fmtCoord(r.lat, r.lon)) : ''}" placeholder="-27.554294, 152.274116"
                   autocomplete="off" spellcheck="false"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();FieldPhotos.moveTo('${escAttr(r.id)}',this.value)}">
            <button type="button" onclick="FieldPhotos.moveTo('${escAttr(r.id)}',document.getElementById('fp-v-coord').value)">Set</button>
          </span>
        </label>
        ${around.length ? `<p class="small">File it under a station nearby:</p>
          <div class="fp-hits">${around.map(({ s, m }) => `<button type="button" class="fp-hit" onclick="FieldPhotos.fileUnder('${escAttr(r.id)}','${escAttr(s.id)}')">${esc(s.name)} <span class="small">${esc(fmtM(m))}</span></button>`).join('')}</div>` : ''}
        <label class="fp-place-field">${placed ? 'Or another station' : 'Or put it at a station'}
          <input type="search" placeholder="name or station number" autocomplete="off"
                 oninput="document.getElementById('fp-v-hits').innerHTML=FieldPhotos._hits(this.value,'${escAttr(r.id)}')">
        </label>
        <div id="fp-v-hits"></div>
      </div>`;
  }

  function vSay(text, kind) {
    const el = document.getElementById('fp-v-msg');
    if (el) el.innerHTML = text ? `<span class="${kind === 'error' ? 'txt-bad' : 'txt-ok'}">${esc(text)}</span>` : '';
  }

  async function patch(id, p, done) {
    try {
      const row = await dbRpc('update_field_photo', { p_id: id, p_patch: p });
      keep([Object.assign(row, { _full: true })]);
      if (v && v.ids[v.i] === id) { v.editing = false; paintDetails(); vSay(done); }
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
  function editPlace() {
    if (!v) return;
    v.editing = !v.editing;
    paintDetails();
    const el = document.getElementById('fp-v-coord');
    if (el) el.focus();
  }
  function moveTo(id, text) {
    const p = typeof Places !== 'undefined' ? Places.parse(text) : null;
    if (!p) { vSay(`“${text}” is not a coordinate this can read — try -27.5543, 152.2741`, 'error'); return; }
    patch(id, { lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7), placement: 'manual' }, 'Moved.');
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
  // A spot's photos (the twin's marker, the map's pin).
  function openSpot(ids, startId, title) { view(ids, startId || ids[0], { title: title || 'Photos taken here' }); }

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
    if (state.activeTab === 'photos' && typeof renderMain === 'function') renderMain();
    changed();
  }

  return {
    render, init, stop,
    addFiles, uploadAll, clearFinished, removeFromQueue, retry, more, setShow,
    queuePlace, queueAtStation, queueNoStation, queueEdit, queueFind,
    dragOver, dragLeave, drop,
    view, close, isOpen, go, goTo, openFromLib, openOne, openSpot, openStation, pillHtml,
    setCaption, editPlace, moveTo, fileUnder, removePhoto, openOriginal, showOnMap, showInTwin,
    inBox, spots, sign, thumbOf, urlFor, row: id => S().byId[id] || null,
    authChanged, changed, signedIn,
    nearestStation, whenText, headingText,
    dbxKey, dbxOpen, dbxFinish, dbxCopy,
    _hits: hitsFor,
    // Read by the check and by nothing else.
    _queue: () => S().queue.map(i => ({
      key: i.key, name: i.name, status: i.status, note: i.note, sha: i.sha,
      pos: i.pos ? { ...i.pos } : null, heading: i.heading ? { ...i.heading } : null,
      altitude: i.altitude ? { ...i.altitude } : null, taken: i.taken ? { ...i.taken } : null,
      station: i.station ? { ...i.station } : null, ocr: i.ocr ? { confidence: i.ocr.confidence, votes: i.ocr.votes, passes: i.ocr.passes } : null,
      width: i.width, height: i.height, contentType: i.contentType, ext: i.ext, converted: !!i.converted,
      decoder: i.decoder || null,
      thumb: !!i.thumbBlob, row: i.row ? { id: i.row.id } : null, existingId: i.existingId || null,
    })),
    _record: key => { const i = S().queue.find(x => x.key === key); return i && i.uploadBlob ? photoRecord(i, 'photo/x.jpg', 'photo/x.thumb.jpg') : null; },
    _sha256js: bytes => sha256js(bytes),
    _viewer: () => (v ? { ids: v.ids.slice(), i: v.i, title: v.title, editing: v.editing } : null),
  };
})();
if (typeof window !== 'undefined') window.FieldPhotos = FieldPhotos;
