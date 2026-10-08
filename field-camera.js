// MegaNet — field-camera.js
//
//   FieldCamera   📸 the Field Camera tab: photos taken in Flood-Net, each
//                 stamped at the shutter with where it was taken, which way the
//                 camera faced, how good the fix was, the height, the station
//                 and the time — Solocator's panel, line for line — and filed:
//                 kept on the phone until there is a signal, then uploaded by
//                 themselves into Field Photos under the station on the stamp.
//
// After core.js, photo-meta.js, photo-stamp.js, field-photos.js and
// station-ar.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, APP_VERSION,
// registerTabTeardown, bearingDeg, KM_PER_DEG_LAT and kmPerDegLon; to
// photo-stamp.js for PhotoStamp (the panel and the EXIF); to photo-meta.js for
// PhotoMeta.read and PhotoMeta.record (the same record every other door
// sends); to station-ar.js for the World Magnetic Model and the phone's
// attitude (StationAR.declination, orient, headingOf, pitchOf); to
// field-photos.js for FieldPhotos (its hash, its viewer, and the word that the
// photos changed); to datastore.js for dbSelect, dbRpc, dbCanWrite,
// dbUploadObject and dbRemoveObject; to places.js for Places.locality; to
// elvis.js, terrain.js and geoid.js for the ground's height; to auth.js for
// Auth; to app.js for switchTab, prepareSearch and stationMatchesSearch; and to
// modal.js and toast.js for confirmDialog and Toast. Every one of those is a
// runtime call from inside a function here; nothing executes at load
// (`npm run toplevel`). init.js calls boot(), which opens the photos kept on
// this device and starts sending any that are waiting.
//
// ── The stamp ────────────────────────────────────────────────────────────────
// photo-stamp.js draws it and says why it is Solocator's. This file decides
// what goes in it, at the instant the shutter is pressed:
//
//   where      the GPS's latest fix, its ± and how old it is. A fix is asked
//              for continuously (enableHighAccuracy) while the camera is up,
//              and the ± is on screen, red past 7 m — the Field Photos
//              viewer's own line — so a photo is taken once the fix settles.
//   which way  the back camera's heading, from the phone's compass, turned to
//              true north by the World Magnetic Model where the phone stands —
//              station-ar.js's model and attitude arithmetic, and its two ways
//              of reading a compass (Android's absolute orientation; an
//              iPhone's gyro, kept on north by its compass). Pointed nearly
//              straight up or down a camera faces no direction, and the
//              heading is left out rather than made up.
//   height     the GPS's, with its datum: Android reports height above the
//              ellipsoid (HAE), Apple's devices above sea level (MSL) — forty
//              metres apart in Queensland, so the label is never left off.
//              Where the GPS gives no height, the ground's in AHD, from Elvis
//              (the State's LiDAR) or the terrain tiles put into AHD, says AHD.
//   station    the one picked below, by name and number.
//   place      the town or locality OpenStreetMap names there (Places.locality),
//              where it can be asked; nothing, rather than a guess, offline.
//   time       the phone's clock, with its zone (AEST, or UTC+10:00).
//
// The same facts go into the file's EXIF (PhotoStamp.app1), and into the row
// the database is sent, with what the stamp cannot say: the fix's age, the
// compass's own accuracy where an iPhone gives one, the declination applied,
// the camera's tilt, the ground's height in AHD, and how the station was
// chosen (meta.capture).
//
// ── Which station ────────────────────────────────────────────────────────────
// Suggested from where the phone is and which way it faces: the station you are
// standing at, the one the last photo was filed under (a visit is twenty
// photos of one site), the ones in the camera's view, then the nearest — each
// with how far and which way. With nothing picked, the stamp carries the
// nearest within a kilometre, the database's own rule
// (meganet.field_photo_station_for), so a photo is filed where it would have
// been anyway. A station picked by hand stays picked until the phone is two
// kilometres from it. What is on the stamp is what the photo is filed under —
// the station sent as station_id, never left to the database to work out — so
// the picture and the record cannot disagree; "No station" is sent as a null.
// Only a photo with no station on it that nobody chose (none within a
// kilometre) is left to the database, whose rule is the same one.
//
// ── Kept, then sent ──────────────────────────────────────────────────────────
// A site often has no signal, and a photo that exists only in a page's memory
// is a photo lost when the phone locks. So each photo is written to this
// device first — IndexedDB, the full JPEG, its 480 px thumbnail and its record
// — and sent from there, one at a time, by the same doors the Field Photos tab
// uses: the hash asked of the database first (the same photo twice is one
// photo), the bytes, the thumbnail, then meganet.add_field_photo, and a refused
// row takes its bytes down again. It goes when the device is signed in and the
// network answers; failing that it waits, and is tried again when the browser
// says the network is back, when somebody signs in, when the app is opened, or
// on a back-off of fifteen seconds to ten minutes. Each upload's outcome goes
// to the Review panel's log (log_field_photo_upload) like any other. Once a
// photo is in Flood-Net its bytes are let go here; its line stays a week.
//
// ── Who may send them ────────────────────────────────────────────────────────
// Field photos are editors' (0035): signed out, the camera still works and
// the photos wait on the device, and the tab says so.
//
// Issue: the Field Photos epic. Schema: db/migrations/0035_field_photos.sql,
// 0036_photo_review.sql. The rest: docs/field-photos.md, "Taking photos in
// Flood-Net".

const FieldCamera = (function () {
  const RAD = Math.PI / 180;

  const BUCKET = 'field-photos';
  const MATCH_M = 1000;          // the nearest station within this is the one a photo is of (0035)
  const AT_M = 60;               // a station this close (or inside the fix's ±) is where you stand
  const NEAR_KM = 5;             // stations suggested around you…
  const FAR_KM = 25;             // …or out to this, where there is nothing nearer
  const STICKY_KM = 2;           // a station picked by hand stays picked until you are this far from it
  const VIEW_HALF = 33;          // half a phone camera's view across its long side (station-ar.js's 66°)
  const SUGGEST_N = 6;
  const ROUGH_M = 7;             // the ± field-photos.js flags red
  const STALE_MS = 20000;        // a fix older than this is said to be old
  const FLAT_PITCH = 80;         // pointed this far up or down, a camera faces no direction
  const MAX_PX = 4096;           // the long side a photo is kept at
  const QUALITY = 0.9;
  const THUMB_PX = 480;          // field-photos.js's thumbnail, for the library and the twin
  const ICON_PX = 160;           // the line on this tab
  const PREVIEW_MS = 100;        // the stamp over the live picture, redrawn this often
  const MOVED_M = 15;            // the GPS moved this far: suggest again
  const LOCALITY_M = 400;        // …this far: ask the place's name again
  const GROUND_M = 25;           // …this far: ask the ground's height again
  const DECL_KM = 5;             // …this far: ask the magnetic model again
  const SENSOR_WAIT_MS = 2500;   // how long to wait for a compass before saying there is none
  const SMOOTH = 0.25;           // station-ar.js's smoothing, for the same compass
  const OFFSET_SMOOTH = 0.05;
  const UPRIGHT_U = 0.7;
  const RETRY_MS = [15e3, 30e3, 60e3, 120e3, 300e3, 600e3];
  const KEEP_DONE_MS = 7 * 86400e3;
  const DB_NAME = 'mn-field-camera';
  const SETTINGS_KEY = 'mn-camera';
  const DEFAULT_PROJECT = 'BoM-FWIN';    // what the crews' Solocator photos carry

  // What a photo is of, a tap each — written into its caption, and on the
  // stamp above the place.
  const CAPTIONS = ['Site overview', 'Logger cabinet', 'Antenna and mast', 'Solar and battery', 'Rain gauge',
                    'Staff gauge', 'Water level sensor', 'Upstream', 'Downstream', 'Access', 'Damage'];

  // ── State ──────────────────────────────────────────────────────────────────

  let settings = null;
  let booted = false;
  let wanted = false;            // the camera was on when the tab was left: put it back on return
  let stream = null, track = null, cam = 'off';   // 'off' | 'asking' | 'on' | 'denied' | 'none'
  let camWhy = '';               // why 'none', in words
  let torch = false;
  let watchId = null, gps = null, gpsError = '';
  let compass = 'off';           // 'off' | 'waiting' | 'absolute' | 'ios' | 'relative' | 'none'
  let listening = false, seenRelative = false, sensorTimer = 0;
  let vec = null, iosOff = null, compassAcc = null;
  let decl = 0, declAt = null;
  let suggestAt = null, suggestions = [];
  let pick = null;               // { id, by: 'hand' | 'none' } — what somebody chose; null is "the suggestion"
  let lastId = null;             // the station the last photo was filed under
  let caption = '';
  let find = '';
  let locality = null, localityAt = null, localityAsking = false;
  let ground = null, groundAt = null, groundAsking = false;
  let localityTried = 0, groundTried = 0;   // when an ask last came back empty
  const RETRY_ASK_MS = 60000;              // …and how long before it is asked again
  let raf = 0, lastPaint = 0, wake = null;
  let shooting = false;
  let shots = [];                // what is kept on this device, newest first (records, not bytes)
  let memOnly = false, dbP = null, mem = new Map();
  let pumping = false, pumpTimer = 0;
  let icons = new Map();         // id → object URL of its icon
  let msg = null;

  const $ = id => document.getElementById(id);

  // ── Small things ───────────────────────────────────────────────────────────

  function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }
  function norm360(x) { return ((x % 360) + 360) % 360; }
  function angleOff(a, b) { const d = Math.abs(norm360(a - b)); return d > 180 ? 360 - d : d; }
  function stations() { return (state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => s.id === id) || null; }
  function located(s) { return !!s && known(s.lat) && known(s.lon); }
  function signedIn() { return typeof dbCanWrite === 'function' && dbCanWrite(); }
  function metres(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * kmPerDegLon(lat1) * 1000, dy = (lat2 - lat1) * KM_PER_DEG_LAT * 1000;
    return Math.hypot(dx, dy);
  }
  function fmtM(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`; }
  const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function point16(deg) { return POINTS[Math.round(norm360(deg) / 22.5) % 16]; }
  function mb(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`; }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function isMobile() {
    return (typeof L !== 'undefined' && L.Browser && L.Browser.mobile) || window.matchMedia('(pointer: coarse)').matches;
  }
  // Apple's location service gives height above sea level, everybody else's
  // above the ellipsoid (the W3C's definition) — Chrome and Firefox on Android
  // pass Android's ellipsoidal altitude straight through. Every browser on an
  // iPhone, an iPad or a Mac is Apple's.
  function appleOs() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /^(iPhone|iPad|iPod|Mac)/i.test(p) || /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  }
  // The phone's zone by the name an Australian reads (AEST, ACDT…). The
  // formatter is made once: the preview asks ten times a second.
  let zoneFmt = null;
  function zoneName(d) {
    try {
      zoneFmt = zoneFmt || new Intl.DateTimeFormat('en-AU', { timeZoneName: 'short' });
      const part = zoneFmt.formatToParts(d).find(x => x.type === 'timeZoneName');
      return part ? part.value : '';
    } catch (_) { return ''; }
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  // This device's own: the project line, whether photos go up by themselves,
  // whether a copy is saved as each is taken, and whether the place is asked.

  function prefs() {
    if (settings) return settings;
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (_) { s = {}; }
    settings = {
      project: typeof s.project === 'string' ? s.project : DEFAULT_PROJECT,
      auto: s.auto !== false,
      copy: s.copy === true,
      place: s.place !== false,
    };
    return settings;
  }
  function savePrefs() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs())); } catch (_) { /* a private window */ }
  }
  function setPref(key, value) {
    const s = prefs();
    if (key === 'project') s.project = String(value || '').slice(0, 60);
    else s[key] = !!value;
    savePrefs();
    if (key === 'auto' && s.auto) pump();
    if (key === 'place' && !s.place) { locality = null; localityAt = null; }
    if (key === 'place' && s.place) askLocality(true);
    paintReadout();
    paintOutbox();
  }

  // ── Where the phone is ─────────────────────────────────────────────────────

  function startGps() {
    if (watchId != null) return;
    if (!('geolocation' in navigator)) { gpsError = 'this browser has no location'; paintReadout(); return; }
    gpsError = '';
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() {
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function onPos(p) {
    const c = p.coords;
    gps = {
      lat: c.latitude, lon: c.longitude, acc: known(c.accuracy) ? c.accuracy : null,
      alt: known(c.altitude) ? c.altitude : null, altAcc: known(c.altitudeAccuracy) ? c.altitudeAccuracy : null,
      at: p.timestamp || Date.now(),
    };
    gpsError = '';
    if (!declAt || metres(declAt.lat, declAt.lon, gps.lat, gps.lon) > DECL_KM * 1000) {
      declAt = { lat: gps.lat, lon: gps.lon };
      try { decl = typeof StationAR !== 'undefined' ? StationAR.declination(gps.lat, gps.lon, 0) : 0; } catch (_) { decl = 0; }
    }
    if (!suggestAt || metres(suggestAt.lat, suggestAt.lon, gps.lat, gps.lon) > MOVED_M) resuggest();
    askLocality(false);
    askGround(false);
    paintReadout();
  }
  function onPosErr(e) {
    gpsError = e && e.code === 1 ? 'location was refused — allow it for this site in the browser\'s settings'
             : e && e.code === 3 ? 'no fix yet' : (e && e.message) || 'no fix';
    if (e && e.code === 1) stopGps();
    paintReadout();
  }
  function fixAge() { return gps ? Math.max(0, Date.now() - gps.at) : null; }

  // The town or locality where the phone is, from OpenStreetMap — asked again
  // only after a few hundred metres, and never when the setting is off.
  function askLocality(force) {
    if (!gps || !prefs().place || localityAsking || typeof Places === 'undefined' || !Places.locality) return;
    if (!force && localityAt && metres(localityAt.lat, localityAt.lon, gps.lat, gps.lon) < LOCALITY_M
        && (locality || Date.now() - localityTried < RETRY_ASK_MS)) return;
    localityAsking = true;
    const at = { lat: gps.lat, lon: gps.lon };
    Places.locality(at.lat, at.lon).then(r => {
      localityAsking = false;
      localityAt = at;
      locality = r && r.ok && r.name ? { name: r.name, credit: r.credit || '' } : null;
      if (!locality) localityTried = Date.now();
      paintReadout();
    }, () => { localityAsking = false; localityTried = Date.now(); });
  }

  // The ground's height in AHD: Elvis (the State's LiDAR, where it has some),
  // else the terrain tiles put into AHD by the geoid grid. Printed only where
  // the GPS gives no height; kept with every photo either way.
  function askGround(force) {
    if (!gps || groundAsking) return;
    if (!force && groundAt && metres(groundAt.lat, groundAt.lon, gps.lat, gps.lon) < GROUND_M
        && (ground || Date.now() - groundTried < RETRY_ASK_MS)) return;
    groundAsking = true;
    const at = { lat: gps.lat, lon: gps.lon };
    groundOf(at.lat, at.lon).then(g => {
      groundAsking = false;
      groundAt = at;
      ground = g ? Object.assign(g, { lat: at.lat, lon: at.lon }) : null;
      if (!ground) groundTried = Date.now();
      paintReadout();
    }, () => { groundAsking = false; groundTried = Date.now(); });
  }
  async function groundOf(lat, lon) {
    if (typeof Elvis !== 'undefined') {
      const r = await Elvis.at(lat, lon);
      if (r && r.ok && known(r.height_m)) {
        return { m: r.height_m, datum: 'AHD', source: 'elvis', dataset: r.dataset || null, resolution: r.resolution || null };
      }
    }
    if (typeof Terrain !== 'undefined' && typeof Geoid !== 'undefined') {
      const [h, g] = await Promise.all([Terrain.sample(lat, lon), Geoid.at(lat, lon)]);
      if (known(h) && g && g.ok) return { m: h + g.m, datum: 'AHD', source: 'terrain', dataset: 'SRTM (terrain tiles) + AUSGeoid2020', resolution: '~30 m' };
    }
    return null;
  }

  // ── Which way the camera faces ─────────────────────────────────────────────
  // station-ar.js's compass, read the same way: an Android phone's absolute
  // orientation is the camera's heading against magnetic north; an iPhone's gyro
  // is smooth and its compass is not, so the gyro turns and the compass keeps
  // saying where north is in the gyro's frame, learnt while the phone is held up.

  function startCompass() {
    if (listening || compass === 'waiting') return;
    compass = 'waiting';
    seenRelative = false;
    vec = null; iosOff = null; compassAcc = null;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { compass = 'none'; return; }
    const listen = () => {
      if (listening) return;
      listening = true;
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
    };
    // An iPhone asks, and only inside the press — which is why this is the
    // first thing a press of Start does, before anything waits.
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(r => { if (r === 'granted') listen(); else noCompass(); }, noCompass);
    } else {
      listen();
    }
    clearTimeout(sensorTimer);
    sensorTimer = setTimeout(() => { if (compass === 'waiting') noCompass(); }, SENSOR_WAIT_MS);
  }
  function noCompass() {
    if (compass !== 'waiting' && compass !== 'none') return;
    compass = seenRelative ? 'relative' : 'none';
    paintReadout();
  }
  function stopCompass() {
    clearTimeout(sensorTimer);
    if (listening) {
      window.removeEventListener('deviceorientationabsolute', onOrient, true);
      window.removeEventListener('deviceorientation', onOrient, true);
    }
    listening = false;
    compass = 'off';
    vec = null; iosOff = null;
  }
  function onOrient(ev) {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null || typeof StationAR === 'undefined') return;
    const ios = typeof ev.webkitCompassHeading === 'number' && isFinite(ev.webkitCompassHeading) && ev.webkitCompassHeading >= 0;
    const kind = ios ? 'ios' : (ev.type === 'deviceorientationabsolute' || ev.absolute === true) ? 'absolute' : 'relative';
    // Chrome sends a relative stream beside the absolute one: north is in the
    // absolute one only, and the two are never mixed in one smoothed vector.
    if (kind === 'relative') {
      if (compass === 'absolute' || compass === 'ios') return;
      seenRelative = true;
      if (compass !== 'relative') return;
    } else if (compass !== kind) {
      compass = kind;
      vec = null;
    }
    const v = StationAR.orient(ev.alpha, ev.beta, ev.gamma);
    if (!vec) vec = { ...v };
    else for (const k of ['e', 'n', 'u', 'ux', 'uy']) vec[k] += SMOOTH * (v[k] - vec[k]);
    if (kind === 'ios') {
      const acc = ev.webkitCompassAccuracy;
      compassAcc = typeof acc === 'number' && acc >= 0 ? acc : null;
      if (Math.abs(v.u) < UPRIGHT_U) {
        const off = (ev.webkitCompassHeading - StationAR.headingOf(v)) * RAD;
        if (!iosOff) iosOff = { c: Math.cos(off), s: Math.sin(off) };
        else {
          iosOff.c += OFFSET_SMOOTH * (Math.cos(off) - iosOff.c);
          iosOff.s += OFFSET_SMOOTH * (Math.sin(off) - iosOff.s);
        }
      }
    }
  }
  function pitchNow() { return vec && typeof StationAR !== 'undefined' ? StationAR.pitchOf(vec) : null; }
  // True north, or null: no compass, a compass with no north in it, an iPhone
  // not yet held up, or a camera pointed at the sky or the ground.
  function headingNow() {
    if (!vec || typeof StationAR === 'undefined') return null;
    const p = pitchNow();
    if (known(p) && Math.abs(p) > FLAT_PITCH) return null;
    if (compass === 'absolute') return norm360(StationAR.headingOf(vec) + decl);
    if (compass === 'ios') return iosOff ? norm360(StationAR.headingOf(vec) + Math.atan2(iosOff.s, iosOff.c) / RAD + decl) : null;
    return null;
  }

  // ── The picture ────────────────────────────────────────────────────────────

  // Start: the compass first (an iPhone only asks inside the press), then the
  // GPS and the camera.
  function start() {
    wanted = true;
    startCompass();
    startGps();
    startCamera();
    holdWake();
    paintStage();
    paintReadout();
  }

  function startCamera() {
    if (stream || cam === 'asking') return;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { cam = 'none'; camWhy = 'This browser cannot show the camera here.'; paintStage(); return; }
    cam = 'asking';
    paintStage();
    // The back camera, as large as it will give: a photo is kept at up to
    // MAX_PX along its long side, and a phone's 4:3 is the shape a photo is.
    md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } } })
      .then(s => {
        if (!wanted || state.activeTab !== 'camera') { s.getTracks().forEach(t => t.stop()); cam = 'off'; return; }
        stream = s;
        track = s.getVideoTracks()[0] || null;
        torch = false;
        cam = 'on';
        attach();
        announce('Camera on. Your position, heading and station are printed on each photo.');
      }, err => {
        const name = err && err.name;
        cam = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'none';
        camWhy = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'This device has no camera the browser can use.'
               : name === 'NotReadableError' ? 'The camera is busy — another app has it. Close that app and try again.'
               : 'This browser cannot show the camera here.';
        paintStage();
      });
  }

  // The stream onto the tab's <video> — on starting, and again when the tab is
  // drawn afresh under a running camera (the station list arriving re-renders
  // it), which leaves the stream playing into an element that has gone.
  function attach() {
    const v = $('cam-video');
    if (!stream || !v) return;
    if (v.srcObject !== stream) {
      v.muted = true;
      v.setAttribute('playsinline', '');
      v.srcObject = stream;
      v.addEventListener('loadedmetadata', fitStage);
      v.addEventListener('resize', fitStage);
    }
    v.hidden = false;
    const played = v.play();
    if (played && played.catch) played.catch(() => {});
    fitStage();
    paintStage();
    loop();
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; torch = false;
    const v = $('cam-video');
    if (v) { v.srcObject = null; v.hidden = true; }
    if (cam === 'on' || cam === 'asking') cam = 'off';
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Everything the tab started, let go — the camera, the GPS, the compass, the
  // screen held awake. Photos waiting to go up are not stopped: they are the
  // device's, not the tab's.
  function stop() {
    stopCamera();
    stopGps();
    stopCompass();
    releaseWake();
    if (document.fullscreenElement && $('cam-block') && document.fullscreenElement === $('cam-block')) {
      document.exitFullscreen().catch(() => {});
    }
  }
  function off() {
    wanted = false;
    stop();
    paintStage();
    paintReadout();
  }

  // The stage takes the picture's own shape, so what is seen is the whole
  // photo — and the stamp drawn over it is the stamp at the photo's scale.
  function fitStage() {
    const v = $('cam-video'), st = $('cam-stage');
    if (!v || !st || !v.videoWidth || !v.videoHeight) return;
    st.style.setProperty('--cam-aspect', `${v.videoWidth} / ${v.videoHeight}`);
    paintPreview();
  }

  function holdWake() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible' || wake) return;
    navigator.wakeLock.request('screen').then(w => {
      if (!wanted) { w.release(); return; }
      wake = w;
      // The system lets go of it when the page is hidden; asked for again
      // when it comes back (boot's visibilitychange).
      w.addEventListener('release', () => { if (wake === w) wake = null; });
    }, () => {});
  }
  function releaseWake() {
    if (wake) wake.release().catch(() => {});
    wake = null;
  }

  function setTorch(on) {
    if (!track || !track.applyConstraints) return;
    track.applyConstraints({ advanced: [{ torch: !!on }] }).then(() => { torch = !!on; paintControls(); }, () => {
      torch = false; paintControls(); say('This camera will not light its torch from the browser.', 'warn');
    });
  }
  function canTorch() {
    try { return !!(track && track.getCapabilities && track.getCapabilities().torch); } catch (_) { return false; }
  }
  function toggleFull() {
    const el = $('cam-block');
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().then(() => fitStage(), () => {});
  }

  // The stamp over the live picture, a few times a second — the same drawing
  // the photo gets, at the size it is shown.
  // The numbers under it follow at a slower pace: they are read, not watched.
  let lastRead = 0;
  function loop() {
    if (raf) return;
    const tick = t => {
      raf = 0;
      if (cam !== 'on' || !$('cam-overlay')) return;
      if (t - lastPaint >= PREVIEW_MS) { lastPaint = t; paintPreview(); }
      if (t - lastRead >= 500) { lastRead = t; paintReadout(); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function paintPreview() {
    const cv = $('cam-overlay'), st = $('cam-stage');
    if (!cv || !st || typeof PhotoStamp === 'undefined') return;
    const r = st.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (cam !== 'on') return;
    PhotoStamp.draw(ctx, w, h, facts(new Date()));
  }

  // ── What the stamp says, now ───────────────────────────────────────────────

  function chosen() {
    if (pick && pick.by === 'none') return null;
    if (pick && pick.by === 'hand') return stationById(pick.id);
    const top = suggestions.find(x => x.m <= MATCH_M);
    return top ? top.s : null;
  }
  function stationHow() {
    if (pick && pick.by === 'none') return 'none';
    if (pick && pick.by === 'hand') return 'picked';
    return chosen() ? 'suggested' : (stations().length ? 'none-near' : 'no-list');
  }

  // Height: the GPS's with its datum; else the ground's in AHD.
  function heightNow() {
    if (gps && known(gps.alt)) return { m: gps.alt, ref: appleOs() ? 'MSL' : 'HAE', source: 'gps', accuracy: gps.altAcc };
    if (ground && known(ground.m)) return { m: ground.m, ref: 'AHD', source: ground.source, accuracy: null };
    return null;
  }

  // The facts at `when` — the stamp's, the EXIF's and the record's.
  function facts(when) {
    const st = chosen();
    const h = heightNow();
    const heading = headingNow();
    return {
      lat: gps ? gps.lat : null, lon: gps ? gps.lon : null, accuracy: gps ? gps.acc : null,
      alt: h ? h.m : null, altRef: h ? h.ref : null, height: h,
      heading, headingRef: 'T', pitch: pitchNow(),
      when: PhotoStamp.moment(when, zoneName(when)),
      station: brief(st), how: stationHow(), suggested: suggestions.map(x => x.s.id),
      project: prefs().project,
      locality: prefs().place && locality ? locality.name : '',
      caption,
    };
  }
  function brief(st) { return st ? { id: st.id, name: st.name, number: st.station_number || '' } : null; }

  // ── Suggestions ────────────────────────────────────────────────────────────
  // The stations a photo here is likely to be of, best first, each with why:
  // where you stand, the last photo's, in the camera's view, nearest.
  function suggest(list, here, heading, last) {
    if (!here || !known(here.lat) || !known(here.lon)) return [];
    const at = Math.max(AT_M, known(here.acc) ? here.acc : 0);
    const box = FAR_KM / 100 + 0.02;
    const near = [];
    for (const s of list) {
      if (!located(s) || Math.abs(s.lat - here.lat) > box || Math.abs(s.lon - here.lon) > box * 1.2) continue;
      const m = metres(here.lat, here.lon, s.lat, s.lon);
      if (m > FAR_KM * 1000) continue;
      const b = bearingDeg(here.lat, here.lon, s.lat, s.lon);
      near.push({ s, m, b, view: known(heading) && m > at && angleOff(heading, b) <= VIEW_HALF });
    }
    near.sort((a, b) => a.m - b.m || (a.s.id < b.s.id ? -1 : 1));
    const pool = near.filter(x => x.m <= NEAR_KM * 1000);
    const from = pool.length ? pool : near.slice(0, SUGGEST_N);
    const rank = x => {
      if (x.m <= at) return 0;
      if (x.s.id === last && x.m <= STICKY_KM * 1000) return 1;
      if (x.view && x.m <= STICKY_KM * 1000) return 2;
      return 3;
    };
    return from
      .map(x => Object.assign(x, { why: ['here', 'last', 'view', 'near'][rank(x)] }))
      .sort((a, b) => rank(a) - rank(b) || a.m - b.m)
      .slice(0, SUGGEST_N);
  }
  function resuggest() {
    if (!gps) { suggestions = []; return; }
    suggestAt = { lat: gps.lat, lon: gps.lon };
    suggestions = suggest(stations(), gps, headingNow(), lastId);
    // A station picked by hand is let go two kilometres from it.
    if (pick && pick.by === 'hand') {
      const s = stationById(pick.id);
      if (!located(s) || metres(gps.lat, gps.lon, s.lat, s.lon) > STICKY_KM * 1000) {
        pick = null;
        say(`${s ? s.name : 'The station you picked'} is more than ${STICKY_KM} km away now, so the stamp is back on the suggestion.`, 'warn');
      }
    }
    paintStation();
  }

  function pickStation(id) {
    const s = stationById(id);
    if (!s) return;
    pick = { id, by: 'hand' };
    find = '';
    paintStation();
    paintPreview();
    announce(`${s.name} will be printed on the photos, and they will be filed under it.`);
  }
  function pickNone() {
    pick = { id: null, by: 'none' };
    paintStation();
    paintPreview();
    announce('No station on the photos.');
  }
  function pickAuto() {
    pick = null;
    resuggest();
    paintPreview();
  }
  function findStation(text) {
    find = String(text || '');
    const el = $('cam-hits');
    if (el) el.innerHTML = hitsHtml();
  }
  // A station by name, number or ALERT address — the Stations tab's own
  // matcher where it is loaded — nearest first when there is a fix.
  function hits(q) {
    const t = String(q || '').trim();
    if (!t) return [];
    const prep = typeof prepareSearch === 'function' ? prepareSearch(t) : null;
    const out = [];
    for (const s of stations()) {
      const ok = prep && typeof stationMatchesSearch === 'function'
        ? stationMatchesSearch(s, prep)
        : (s.name || '').toLowerCase().includes(t.toLowerCase()) || String(s.station_number || '').includes(t);
      if (ok && located(s)) out.push(s);
    }
    if (gps) out.sort((a, b) => metres(gps.lat, gps.lon, a.lat, a.lon) - metres(gps.lat, gps.lon, b.lat, b.lon));
    return out.slice(0, 10);
  }
  function setCaption(text) {
    caption = String(text || '').slice(0, 200);
    const input = $('cam-caption');
    if (input && input.value !== caption) input.value = caption;
    paintCaptions();
    paintPreview();
  }
  function tapCaption(i) {
    const c = CAPTIONS[i];
    setCaption(caption === c ? '' : c);
  }

  // ── The shutter ────────────────────────────────────────────────────────────

  async function shoot() {
    const v = $('cam-video');
    if (shooting || cam !== 'on' || !v || !v.videoWidth) return;
    shooting = true;
    paintControls();
    const when = new Date();
    const f = facts(when);
    flash();
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) { /* no buzz */ }
    try {
      const scale = Math.min(1, MAX_PX / Math.max(v.videoWidth, v.videoHeight));
      const W = Math.round(v.videoWidth * scale), H = Math.round(v.videoHeight * scale);
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      cv.getContext('2d').drawImage(v, 0, 0, W, H);
      await keepShot(cv, f, { source: 'camera' });
    } catch (err) {
      say(`The photo could not be kept — ${(err && err.message) || err}.`, 'error');
    } finally {
      shooting = false;
      paintControls();
    }
  }

  function flash() {
    const el = $('cam-flash');
    if (!el) return;
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
  }

  // A photo from the phone's own camera app, or chosen from its gallery: the
  // full sensor, its HDR and its zoom, stamped with the GPS and the station
  // as they are when it comes back. Its own EXIF wins where it has a
  // position, a heading or a time — the camera app knew the shutter, this tab
  // only knows when the photo arrived; a heading it does not have is left off
  // rather than read off a phone that has since been lowered.
  async function fromFiles(list) {
    const files = Array.from(list || []).filter(f => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || ''));
    if (!files.length) return;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const meta = PhotoMeta.read(buf);
        let bmp = null;
        try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (_) { try { bmp = await createImageBitmap(file); } catch (__) { bmp = null; } }
        if (!bmp) throw new Error('this browser cannot draw that photo (a HEIC in Chrome or Firefox — choose Most Compatible in the iPhone\'s camera settings)');
        const when = meta.taken && meta.taken.iso ? new Date(meta.taken.iso) : new Date();
        const f = facts(when);
        f.heading = null;
        f.fixUsed = true;
        // A photo with no position of its own is given the phone's — but only
        // one just taken, as the camera app's is. One from the gallery, taken
        // more than ten minutes ago, is not stamped with where the phone is
        // now: it says nothing of where rather than something wrong.
        const fresh = !(meta.taken && meta.taken.iso) || Math.abs(Date.now() - Date.parse(meta.taken.iso)) < 10 * 60e3;
        if (!meta.gps && !fresh) {
          Object.assign(f, { lat: null, lon: null, accuracy: null, alt: null, altRef: null, height: null, locality: '', fixUsed: false });
          if (!pick) { f.station = null; f.how = 'none-near'; f.suggested = []; }
        }
        if (meta.gps) {
          // Far from where the phone is now (or with no fix to compare), the
          // phone's town and height are not the photo's.
          const near = gps && metres(gps.lat, gps.lon, meta.gps.lat, meta.gps.lon) <= GROUND_M * 4;
          if (!near) Object.assign(f, { alt: null, altRef: null, height: null, locality: '' });
          if (!gps || metres(gps.lat, gps.lon, meta.gps.lat, meta.gps.lon) > LOCALITY_M) f.locality = '';
          f.fixUsed = false;
          f.lat = meta.gps.lat; f.lon = meta.gps.lon;
          f.accuracy = known(meta.gps.accuracy) ? meta.gps.accuracy : null;
          if (known(meta.gps.heading)) { f.heading = meta.gps.heading; f.headingRef = meta.gps.headingRef || 'T'; }
          // Its height too, where it wrote one — above sea level, as EXIF has it.
          if (known(meta.gps.alt)) {
            f.alt = meta.gps.alt; f.altRef = meta.gps.altRef || 'MSL';
            f.height = { m: f.alt, ref: f.altRef, source: 'exif', accuracy: null };
          }
          // Where the photo says it was taken may not be where the phone is
          // now: the station is suggested for the photo's own place, unless
          // somebody has picked one (or none).
          if (!pick) {
            const sug = suggest(stations(), { lat: f.lat, lon: f.lon, acc: f.accuracy }, f.heading, lastId);
            const top = sug.find(x => x.m <= MATCH_M);
            f.station = brief(top ? top.s : null);
            f.how = top ? 'suggested' : (stations().length ? 'none-near' : 'no-list');
            f.suggested = sug.map(x => x.s.id);
          }
        }
        f.pitch = null;
        const scale = Math.min(1, MAX_PX / Math.max(bmp.width, bmp.height));
        const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        cv.getContext('2d').drawImage(bmp, 0, 0, W, H);
        try { bmp.close(); } catch (_) { /* gone */ }
        await keepShot(cv, f, { source: 'camera-app', file: file.name, exif: !!meta.gps });
      } catch (err) {
        say(`${file.name}: not kept — ${(err && err.message) || err}.`, 'error');
      }
    }
    const input = $('cam-files');
    if (input) input.value = '';
  }

  function toBlob(cv, quality) {
    return new Promise((resolve, reject) => cv.toBlob(b => (b ? resolve(b) : reject(new Error('the browser would not encode the photo'))), 'image/jpeg', quality));
  }
  async function scaled(cv, px, quality) {
    const s = Math.min(1, px / Math.max(cv.width, cv.height));
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(cv.width * s)); t.height = Math.max(1, Math.round(cv.height * s));
    const cx = t.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(cv, 0, 0, t.width, t.height);
    return new Uint8Array(await (await toBlob(t, quality)).arrayBuffer());
  }
  async function sha256(bytes) {
    if (typeof FieldPhotos !== 'undefined' && FieldPhotos.sha256) return FieldPhotos.sha256(bytes);
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // Stamp it, write its EXIF, and keep it — the photo, its thumbnail, a small
  // icon for this tab's list, and the record the database will be sent.
  async function keepShot(cv, f, from) {
    const W = cv.width, H = cv.height;
    PhotoStamp.draw(cv.getContext('2d'), W, H, f);
    const raw = new Uint8Array(await (await toBlob(cv, QUALITY)).arrayBuffer());
    const stationLine = PhotoStamp.stationText(f.station);
    const description = [stationLine, f.caption].filter(Boolean).join(' — ');
    const jpeg = PhotoStamp.withExif(raw, PhotoStamp.app1({
      lat: f.lat, lon: f.lon, accuracy: f.accuracy, alt: f.alt, heading: f.heading, headingRef: f.headingRef,
      when: f.when, width: W, height: H, description,
    }));
    const thumb = await scaled(cv, THUMB_PX, 0.82);
    const icon = await scaled(cv, ICON_PX, 0.75);
    const sha = await sha256(jpeg);
    const name = PhotoStamp.fileName(f);
    const meta = PhotoMeta.read(jpeg);
    const record = PhotoMeta.record({
      meta, name, size: jpeg.length, type: 'image/jpeg', converted: false, width: W, height: H, caption: f.caption,
      pos: known(f.lat) && known(f.lon) ? { lat: f.lat, lon: f.lon, placement: 'exif', accuracy: f.accuracy } : null,
      heading: known(f.heading) ? { deg: f.heading, ref: f.headingRef || 'T' } : null,
      altitude: known(f.alt) ? { m: Math.round(f.alt * 100) / 100, ref: f.altRef } : null,
      taken: { local: f.when.local, iso: f.when.iso, source: 'exif', zone: 'exif' },
      pitch: known(f.pitch) ? Math.round(f.pitch * 10) / 10 : null,
    });
    const st = f.station;
    const how = f.how;
    record.meta.capture = {
      app: PhotoStamp.SOFTWARE, version: typeof APP_VERSION !== 'undefined' ? APP_VERSION : null,
      source: from.source, file: from.file || null,
      gps: gps && f.fixUsed !== false ? { fix_at: new Date(gps.at).toISOString(), age_s: Math.round(fixAge() / 1000),
                   altitude_accuracy_m: known(gps.altAcc) ? Math.round(gps.altAcc) : null } : null,
      heading: known(f.heading) ? { source: from.source === 'camera' ? compass : 'exif', declination: +decl.toFixed(2),
                                    compass_accuracy: compassAcc } : null,
      height: f.height ? { source: f.height.source, ref: f.height.ref } : null,
      ground: ground && known(f.lat) && metres(ground.lat, ground.lon, f.lat, f.lon) <= GROUND_M * 4
        ? { m: Math.round(ground.m * 100) / 100, datum: 'AHD', source: ground.source, dataset: ground.dataset } : null,
      station: { how, suggested: f.suggested || [] },
      locality: f.locality ? { name: f.locality, source: 'OpenStreetMap' } : null,
      project: f.project || null,
    };
    // What is on the stamp is what the photo is filed under: the station, or
    // nobody's when somebody said "No station". With no station on the stamp
    // and nobody having said so — none within a kilometre, or no list on this
    // device — it is left to the database's own rule, which is the same rule.
    if (st) record.station_id = st.id;
    else if (how === 'none') record.station_id = null;

    const shot = {
      id: uuid(), at: f.when.ms, name, bytes: jpeg.length, sha, width: W, height: H,
      station: st ? { id: st.id, name: st.name, number: st.number } : null,
      caption: f.caption || '', lat: f.lat, lon: f.lon, accuracy: f.accuracy, heading: f.heading,
      record, status: 'waiting', tries: 0, next: 0, note: '', rowId: null, doneAt: null,
      icon: icon.buffer.slice(icon.byteOffset, icon.byteOffset + icon.byteLength),
    };
    await putShot(shot, { jpeg, thumb });
    shots.unshift(shot);
    if (st) lastId = st.id;
    persistStorage();
    if (prefs().copy) saveCopy(shot.id);
    paintOutbox();
    paintControls();
    const where = st ? `filed under ${st.name}` : 'not filed under a station';
    const ready = signedIn() && prefs().auto;
    announce(`Photo taken, ${where}. ${ready ? 'Uploading.' : 'Kept on this device.'}`);
    say(`Photo taken — ${where}${ready ? '; uploading…' : signedIn() ? '; press Upload now to send it.' : '; kept on this device until you sign in.'}`, 'ok');
    pump();
    return shot;
  }

  // Ask the browser to keep this site's storage through a clear-out: a phone
  // short of space evicts a site's data otherwise, photos and all.
  let persistAsked = false;
  function persistStorage() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  // ── Kept on this device ────────────────────────────────────────────────────
  // IndexedDB, two stores: `shots` (a record each, with its icon) and `bytes`
  // (the photo as <id> and its thumbnail as <id>.thumb). ArrayBuffers rather
  // than Blobs, which older Safari would not store. Without IndexedDB — some
  // private windows — they are held in this page only, and the tab says so.

  function db() {
    if (dbP) return dbP;
    dbP = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('this browser keeps no database')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('shots')) d.createObjectStore('shots', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('bytes')) d.createObjectStore('bytes');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('the database would not open'));
      req.onblocked = () => reject(new Error('the database is held by another tab'));
    });
    dbP.catch(() => { memOnly = true; });
    return dbP;
  }
  function tx(stores, mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('the database refused it'));
      t.onabort = () => reject(t.error || new Error('the database gave up — the device may be out of space'));
      out = fn(t);
    }));
  }
  function bare(shot) { const { _url, ...rest } = shot; return rest; }
  function putShot(shot, b) {
    if (memOnly) { mem.set(shot.id, b); return Promise.resolve(); }
    return tx(['shots', 'bytes'], 'readwrite', t => {
      t.objectStore('shots').put(bare(shot));
      if (b && b.jpeg) t.objectStore('bytes').put(b.jpeg.buffer.slice(b.jpeg.byteOffset, b.jpeg.byteOffset + b.jpeg.byteLength), shot.id);
      if (b && b.thumb) t.objectStore('bytes').put(b.thumb.buffer.slice(b.thumb.byteOffset, b.thumb.byteOffset + b.thumb.byteLength), `${shot.id}.thumb`);
    }).catch(err => {
      if (memOnly) { mem.set(shot.id, b); return; }
      throw err;
    });
  }
  function saveShot(shot) {
    if (memOnly) return Promise.resolve();
    return tx(['shots'], 'readwrite', t => { t.objectStore('shots').put(bare(shot)); }).catch(() => {});
  }
  function bytesOf(id) {
    if (memOnly) {
      const b = mem.get(id);
      return Promise.resolve(b ? { jpeg: b.jpeg || null, thumb: b.thumb || null } : { jpeg: null, thumb: null });
    }
    return tx(['bytes'], 'readonly', t => {
      const o = {}, s = t.objectStore('bytes');
      const a = s.get(id), b = s.get(`${id}.thumb`);
      a.onsuccess = () => { o.jpeg = a.result ? new Uint8Array(a.result) : null; };
      b.onsuccess = () => { o.thumb = b.result ? new Uint8Array(b.result) : null; };
      return o;
    });
  }
  function dropBytes(id) {
    if (memOnly) { mem.delete(id); return Promise.resolve(); }
    return tx(['bytes'], 'readwrite', t => { const s = t.objectStore('bytes'); s.delete(id); s.delete(`${id}.thumb`); }).catch(() => {});
  }
  function dropShot(id) {
    if (memOnly) { mem.delete(id); return Promise.resolve(); }
    return tx(['shots', 'bytes'], 'readwrite', t => {
      t.objectStore('shots').delete(id);
      const s = t.objectStore('bytes'); s.delete(id); s.delete(`${id}.thumb`);
    }).catch(() => {});
  }
  function loadShots() {
    return tx(['shots'], 'readonly', t => {
      const req = t.objectStore('shots').getAll();
      const out = { list: [] };
      req.onsuccess = () => { out.list = req.result || []; };
      return out;
    }).then(o => o.list);
  }

  // ── Sending them ───────────────────────────────────────────────────────────

  function waiting() { return shots.filter(s => s.status === 'waiting' || s.status === 'failed'); }

  // One at a time, oldest first, whenever there is something to send and
  // somebody signed in to send it as.
  async function pump(force) {
    if (pumping) return;
    clearTimeout(pumpTimer);
    if (!signedIn() || (!prefs().auto && !force)) { paintOutbox(); return; }
    pumping = true;
    const logged = [];
    try {
      for (;;) {
        const now = Date.now();
        const next = waiting().filter(s => force || !s.next || s.next <= now).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        const out = await sendOne(next);
        if (out.log) logged.push(out.log);
        if (out.stop) break;
      }
    } finally {
      pumping = false;
    }
    if (logged.length) logOutcomes(logged);
    paintOutbox();
    // The next try, for whatever is still waiting.
    const later = waiting().map(s => s.next || 0).filter(Boolean);
    if (later.length) pumpTimer = setTimeout(() => pump(), Math.max(1000, Math.min(...later) - Date.now()));
  }

  // A network that is not there answers with a TypeError, or a status no
  // database gave; a database that said no answers with its SQLSTATE.
  function offline(err) {
    return err instanceof TypeError || !err || !err.status || err.status >= 500 || err.status === 408 || err.status === 429;
  }

  async function sendOne(shot) {
    shot.status = 'uploading';
    shot.note = 'Uploading…';
    paintShot(shot);
    let path = null, thumbPath = null;
    try {
      // Asked first, so a photo that went up before its answer was lost is not
      // sent twice; the database refuses a second copy anyway.
      const dup = await dbSelect(`field_photo?select=id,station_id,uploaded_by,created_at&sha256=eq.${shot.sha}&limit=1`);
      if (dup.length) {
        await finished(shot, 'already', dup[0].id, `Already in Flood-Net — added by ${dup[0].uploaded_by || 'someone'} on ${String(dup[0].created_at || '').slice(0, 10)}.`);
        return { log: logRow(shot, 'duplicate', dup[0]) };
      }
      const b = await bytesOf(shot.id);
      if (!b.jpeg) {
        shot.status = 'refused';
        shot.note = 'The photo\'s bytes are no longer on this device — it cannot be sent.';
        await saveShot(shot);
        paintShot(shot);
        return { log: logRow(shot, 'failed', null, shot.note) };
      }
      const id = uuid();
      path = `photo/${id}.jpg`;
      thumbPath = b.thumb ? `photo/${id}.thumb.jpg` : null;
      await dbUploadObject(BUCKET, path, new Blob([b.jpeg], { type: 'image/jpeg' }));
      if (thumbPath) await dbUploadObject(BUCKET, thumbPath, new Blob([b.thumb], { type: 'image/jpeg' }));
      const p = Object.assign({}, shot.record, {
        storage_path: path, thumb_path: thumbPath, content_type: 'image/jpeg', byte_size: shot.bytes, sha256: shot.sha,
      });
      let row;
      try {
        row = await dbRpc('add_field_photo', { p_photo: p });
      } catch (err) {
        await takeDown(path, thumbPath);
        path = null;
        if (err && err.status === 409) {
          await finished(shot, 'already', err.details || null, 'Already in Flood-Net — somebody added the same photo a moment ago.');
          return { log: logRow(shot, 'duplicate', null) };
        }
        throw err;
      }
      await finished(shot, 'done', row && row.id, 'Uploaded.');
      if (row && typeof FieldPhotos !== 'undefined') {
        try { FieldPhotos.changed(); } catch (_) { /* its own */ }
      }
      return { log: logRow(shot, row && row.lat == null ? 'unplaced' : 'imported', row) };
    } catch (err) {
      if (path) await takeDown(path, thumbPath);
      const why = (err && err.message) || String(err);
      if (err && err.code === '42501') {
        // Signed in, but not as an editor: every photo would be told the same.
        shot.status = 'refused';
        shot.note = `Refused — ${why}. Field photos are added by editors; an administrator can add your address to the list.`;
        shot.code = err.code;
        await saveShot(shot);
        paintShot(shot);
        return { stop: true, log: logRow(shot, 'refused', null, why) };
      }
      if (err && err.denied) {
        // Signed out under us, or a session that ran out: it waits.
        shot.status = 'waiting';
        shot.note = 'Waiting — sign in again to send it.';
        await saveShot(shot);
        paintShot(shot);
        return { stop: true };
      }
      if (offline(err)) {
        shot.tries = (shot.tries || 0) + 1;
        shot.status = 'failed';
        const wait = RETRY_MS[Math.min(RETRY_MS.length - 1, shot.tries - 1)];
        shot.next = Date.now() + wait;
        shot.note = `No connection to Flood-Net (${why}) — trying again in ${wait < 60e3 ? `${wait / 1000} s` : `${wait / 60e3} min`}.`;
        await saveShot(shot);
        paintShot(shot);
        return { stop: true };
      }
      // The database said no — a rule, not the network. Said, and kept: a
      // station deleted since this device's list was loaded can be sent without
      // it (sendUnfiled).
      shot.status = 'refused';
      shot.note = `Refused — ${why}`;
      shot.code = (err && err.code) || null;
      await saveShot(shot);
      paintShot(shot);
      return { log: logRow(shot, 'refused', null, why) };
    }
  }

  async function takeDown(path, thumbPath) {
    try { await dbRemoveObject(BUCKET, path); } catch (_) { /* swept later */ }
    if (thumbPath) { try { await dbRemoveObject(BUCKET, thumbPath); } catch (_) { /* swept later */ } }
  }

  async function finished(shot, status, rowId, note) {
    shot.status = status;
    shot.rowId = typeof rowId === 'string' ? rowId : null;
    shot.note = note;
    shot.doneAt = Date.now();
    shot.next = 0;
    await saveShot(shot);
    await dropBytes(shot.id);
    paintShot(shot);
  }

  // What became of it, for the Review panel (0036) — best-effort, as the
  // Field Photos tab's own log is: a log that cannot be written never fails
  // the photo it is about.
  function logRow(shot, outcome, row, reason = '') {
    const r = {
      origin: 'upload', file_name: String(shot.name || 'photo.jpg').slice(0, 300), outcome,
      reason: String(reason || '').slice(0, 1000), sha256: shot.sha, byte_size: shot.bytes,
    };
    if (row && row.id) r.photo_id = row.id;
    if (row && row.station_id) r.station_id = row.station_id;
    return r;
  }
  async function logOutcomes(rows) {
    const batch = uuid();
    try {
      await dbRpc('log_field_photo_upload', { p_rows: rows.map(r => Object.assign({ batch_id: batch }, r)) });
    } catch (_) { /* the Review panel says what it can */ }
    if (typeof PhotoReview !== 'undefined' && PhotoReview.uploadsChanged) {
      try { PhotoReview.uploadsChanged(); } catch (_) { /* its own */ }
    }
  }

  function retry(id) {
    const s = shots.find(x => x.id === id);
    if (!s) return;
    if (s.status === 'failed' || s.status === 'refused') { s.status = 'waiting'; s.next = 0; s.note = ''; }
    pump(true);
  }
  function sendNow() {
    shots.forEach(s => { if (s.status === 'failed') s.next = 0; });
    pump(true);
  }
  // A photo the database refused for its station (one deleted since this
  // device's list was loaded): sent filed under nobody. The stamp keeps the
  // name; the viewer's "File under…" puts it right.
  async function sendUnfiled(id) {
    const s = shots.find(x => x.id === id);
    if (!s) return;
    s.record = Object.assign({}, s.record, { station_id: null });
    s.status = 'waiting'; s.next = 0; s.note = '';
    await saveShot(s);
    pump(true);
  }

  async function removeShot(id) {
    const s = shots.find(x => x.id === id);
    if (!s) return;
    if (s.status !== 'done' && s.status !== 'already') {
      const ok = typeof confirmDialog === 'function'
        ? await confirmDialog({ title: 'Remove this photo?', message: 'It has not been uploaded, and this device holds the only copy.',
                                confirm: 'Remove the photo', danger: true })
        : true;
      if (!ok) return;
    }
    shots = shots.filter(x => x.id !== id);
    forgetIcon(id);
    await dropShot(id);
    paintOutbox();
    paintControls();
  }
  async function clearDone() {
    const gone = shots.filter(s => s.status === 'done' || s.status === 'already');
    shots = shots.filter(s => !gone.includes(s));
    for (const s of gone) { forgetIcon(s.id); await dropShot(s.id); }
    paintOutbox();
  }
  // A copy on this device, the stamped JPEG with its EXIF, named floodnet-….
  async function saveCopy(id) {
    const s = shots.find(x => x.id === id);
    if (!s) return;
    const b = await bytesOf(id).catch(() => ({ jpeg: null }));
    if (!b.jpeg) { say('That photo has been uploaded and its bytes let go here — open it in Field Photos to save it.', 'warn'); return; }
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([b.jpeg], { type: 'image/jpeg' })), download: s.name,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  function openShot(id) {
    const s = shots.find(x => x.id === id);
    if (!s || !s.rowId || typeof FieldPhotos === 'undefined') return;
    FieldPhotos.openOne(s.rowId);
  }

  // ── Booting ────────────────────────────────────────────────────────────────
  // From init.js: open what this device kept, let go of lines a week old, and
  // send whatever is waiting — whichever tab is open. Then again whenever the
  // network comes back or the page comes back into view.
  function boot() {
    if (booted) return;
    booted = true;
    db().then(loadShots).then(list => {
      const now = Date.now();
      const old = list.filter(s => (s.status === 'done' || s.status === 'already') && s.doneAt && now - s.doneAt > KEEP_DONE_MS);
      old.forEach(s => dropShot(s.id));
      // A photo caught mid-upload by a closed page goes back in the queue.
      shots = list.filter(s => !old.includes(s))
        .map(s => (s.status === 'uploading' ? Object.assign(s, { status: 'waiting', note: '' }) : s))
        .sort((a, b) => b.at - a.at);
      paintOutbox();
      pump();
    }, () => { memOnly = true; paintOutbox(); });
    window.addEventListener('online', () => pump(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      pump();
      if (wanted && state.activeTab === 'camera') holdWake();
    });
  }

  function authChanged() {
    paintOutbox();
    if (signedIn()) pump(true);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function say(text, kind) {
    msg = text ? { text, kind: kind || 'info' } : null;
    const el = $('cam-msg');
    if (el) el.innerHTML = msgHtml();
  }
  function msgHtml() {
    if (!msg) return '';
    const cls = msg.kind === 'error' ? 'txt-bad' : msg.kind === 'warn' ? 'txt-warn' : msg.kind === 'ok' ? 'txt-ok' : 'txt-muted';
    return `<span class="${cls}">${esc(msg.text)}</span>`;
  }

  function render() {
    const s = prefs();
    return `
  <div class="page cam-page" style="--page-max:1100px">
    <div class="panel cam-panel" id="cam-panel">
      <div class="panel-header"><h2>Field Camera</h2><span class="small" id="cam-sum">${sumHtml()}</span></div>
      <p class="small cam-lead">Photos taken here carry the stamp Solocator prints — the way the camera faced,
        the position and its ±, the height, the time — and the station they are of. Each is kept on this device,
        then goes into <strong>Field Photos</strong> under that station by itself, as soon as there is a signal.</p>
      <div class="cam-block" id="cam-block">
        <div class="cam-stage" id="cam-stage" data-theme="dark" style="--cam-aspect: 4 / 3">
          <video id="cam-video" class="cam-video" playsinline muted hidden></video>
          <canvas id="cam-overlay" class="cam-overlay" aria-hidden="true"></canvas>
          <div class="cam-flash" id="cam-flash" aria-hidden="true"></div>
          <div class="cam-idle" id="cam-idle">${idleHtml()}</div>
        </div>
        <div class="cam-controls" id="cam-controls">${controlsHtml()}</div>
        <div class="cam-readout small" id="cam-readout" aria-live="off">${readoutHtml()}</div>
      </div>
      <p class="small cam-msg" id="cam-msg" role="status">${msgHtml()}</p>
      <section class="cam-section" aria-labelledby="cam-station-h">
        <h3 id="cam-station-h">Station</h3>
        <div id="cam-station">${stationHtml()}</div>
      </section>
      <section class="cam-section" aria-labelledby="cam-caption-h">
        <h3 id="cam-caption-h">What the photo shows</h3>
        <div class="pill-row" id="cam-captions">${captionsHtml()}</div>
        <label class="cam-field small">Caption, also printed on the photo
          <input type="text" id="cam-caption" maxlength="200" value="${esc(caption)}" placeholder="e.g. Logger cabinet, door open"
                 oninput="FieldCamera.setCaption(this.value)">
        </label>
      </section>
      <details class="cam-section cam-settings">
        <summary>Settings</summary>
        <label class="cam-field small">Project line, printed above the time
          <input type="text" id="cam-project" maxlength="60" value="${esc(s.project)}"
                 oninput="FieldCamera.setPref('project', this.value)">
        </label>
        <label class="cam-check small"><input type="checkbox" id="cam-auto" ${s.auto ? 'checked' : ''}
          onchange="FieldCamera.setPref('auto', this.checked)"> Upload each photo by itself as soon as it can</label>
        <label class="cam-check small"><input type="checkbox" id="cam-copy" ${s.copy ? 'checked' : ''}
          onchange="FieldCamera.setPref('copy', this.checked)"> Also save a copy of each photo on this device</label>
        <label class="cam-check small"><input type="checkbox" id="cam-place" ${s.place ? 'checked' : ''}
          onchange="FieldCamera.setPref('place', this.checked)"> Print the town or locality (asks OpenStreetMap where you are)</label>
      </details>
    </div>
    <div class="panel" id="cam-out-panel">
      <div class="panel-header">
        <h2>On this device</h2>
        <div class="button-group" id="cam-out-actions">${outActionsHtml()}</div>
      </div>
      <div id="cam-out">${outboxHtml()}</div>
    </div>
  </div>`;
  }

  function init() {
    prefs();
    if (!booted) boot();
    registerTabTeardown('FieldCamera', stop);
    paintOutbox();
    if (gps) resuggest();
    // Drawn afresh under a running camera: the stream into the new element.
    // Back on the tab with the camera wanted: on again — permission was given
    // in this page already, so nothing is asked.
    if (stream) attach();
    else if (wanted) start();
    else if (gps) paintReadout();
  }

  function idleHtml() {
    if (cam === 'on') return '';
    if (cam === 'asking') return '<p class="cam-idle-text">Asking for the camera…</p>';
    const pickBtn = `<label class="pill cam-pick">📷 Use the camera app or a saved photo
        <input type="file" id="cam-files" accept="image/*" capture="environment" class="sr-only"
               onchange="FieldCamera.fromFiles(this.files)"></label>`;
    if (cam === 'denied') {
      return `<p class="cam-idle-text">The camera was refused. Allow it for this site in the browser's settings, then press
        <button type="button" class="pill" onclick="FieldCamera.start()">Try again</button>, or ${pickBtn}</p>`;
    }
    if (cam === 'none') {
      return `<p class="cam-idle-text">${esc(camWhy || 'This browser cannot show the camera here.')}
        <button type="button" class="pill" onclick="FieldCamera.start()">Try again</button> ${pickBtn}</p>`;
    }
    return `<div class="cam-idle-text">
        <button type="button" class="primary cam-start" onclick="FieldCamera.start()">📸 Start the camera</button>
        <p class="small">The GPS and the compass start with it${isMobile() ? '' : ' — on a computer there is usually no compass, so no heading is printed'}.</p>
        ${pickBtn}
      </div>`;
  }

  function controlsHtml() {
    const on = cam === 'on';
    const last = shots[0];
    const lastUrl = last ? iconUrl(last) : null;
    return `
      <div class="cam-controls-side">
        ${on && canTorch() ? `<button type="button" class="cam-round" aria-pressed="${torch}" aria-label="Torch" title="Torch"
            onclick="FieldCamera.setTorch(${!torch})">🔦</button>` : ''}
        ${on && document.fullscreenEnabled ? `<button type="button" class="cam-round" aria-label="Full screen" title="Full screen"
            onclick="FieldCamera.toggleFull()">⛶</button>` : ''}
        ${on ? `<button type="button" class="cam-round" aria-label="Stop the camera" title="Stop the camera"
            onclick="FieldCamera.off()">✕</button>` : ''}
      </div>
      <button type="button" class="cam-shutter" id="cam-shutter" aria-label="Take a photo" title="Take a photo"
        onclick="FieldCamera.shoot()" ${on && !shooting ? '' : 'disabled'}><span aria-hidden="true"></span></button>
      <div class="cam-controls-side cam-controls-end">
        ${last ? `<button type="button" class="cam-last" aria-label="The last photo: ${esc(last.name)}" title="The last photo"
            onclick="FieldCamera.showList()">${lastUrl ? `<img src="${esc(lastUrl)}" alt="">` : '🖼️'}</button>` : ''}
        ${on ? `<label class="cam-round cam-pick" title="Use the camera app or a saved photo">📷<span class="sr-only">Use the camera app or a saved photo</span>
            <input type="file" id="cam-files" accept="image/*" capture="environment" class="sr-only"
                   onchange="FieldCamera.fromFiles(this.files)"></label>` : ''}
      </div>`;
  }

  // The live numbers under the picture: the fix, the compass, the height.
  function readoutHtml() {
    const bits = [];
    if (gps) {
      const age = fixAge();
      const rough = known(gps.acc) && Math.round(gps.acc) > ROUGH_M;
      bits.push(`<span class="cam-read${rough ? ' is-rough' : ''}">📍 ${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}
        ${known(gps.acc) ? `<strong>±${Math.round(gps.acc)} m</strong>${rough ? '<span class="sr-only"> — a rough fix, wider than 7 m</span>' : ''}` : ''}
        ${age > STALE_MS ? ` <span class="txt-warn">(fix ${Math.round(age / 1000)} s old)</span>` : ''}</span>`);
    } else if (watchId != null || gpsError) {
      bits.push(`<span class="cam-read">📍 ${gpsError ? esc(gpsError) : 'Waiting for a GPS fix…'}</span>`);
    }
    const h = headingNow();
    if (compass !== 'off') {
      const word = known(h) ? `${Math.round(h) % 360}° ${PhotoStamp.point8(h)} true` :
        compass === 'waiting' ? 'starting the compass…' :
        compass === 'ios' ? 'hold the phone up to find north' :
        compass === 'relative' ? 'no north from this compass — no heading printed' :
        compass === 'none' ? 'no compass — no heading printed' :
        vec && Math.abs(pitchNow() || 0) > FLAT_PITCH ? 'pointing up or down — no heading' : '…';
      bits.push(`<span class="cam-read">🧭 ${word}${known(h) && known(compassAcc) ? ` (±${Math.round(compassAcc)}°)` : ''}${known(h) ? `, declination ${Math.abs(decl).toFixed(1)}° ${decl < 0 ? 'W' : 'E'}` : ''}</span>`);
    }
    const ht = heightNow();
    if (ht) {
      bits.push(`<span class="cam-read">▲ ${Math.round(ht.m)} m ${ht.ref}${ht.source === 'gps' ? (known(ht.accuracy) ? ` ±${Math.round(ht.accuracy)} m` : '') : ` (ground, ${ht.source === 'elvis' ? 'LiDAR' : 'terrain'})`}</span>`);
    }
    if (ground && ht && ht.source === 'gps') {
      bits.push(`<span class="cam-read">Ground ${ground.m.toFixed(1)} m AHD (${ground.source === 'elvis' ? `Elvis${ground.resolution ? ` ${esc(ground.resolution)}` : ''}` : 'terrain'})</span>`);
    }
    if (prefs().place && locality) bits.push(`<span class="cam-read">${esc(locality.name)}</span>`);
    return bits.join(' ');
  }

  function stationHtml() {
    const st = chosen();
    const how = stationHow();
    const line = st
      ? `<strong>${esc(PhotoStamp.stationText({ name: st.name, number: st.station_number }))}</strong>
         ${gps && located(st) ? `<span class="small txt-muted">${fmtM(metres(gps.lat, gps.lon, st.lat, st.lon))} ${point16(bearingDeg(gps.lat, gps.lon, st.lat, st.lon))}</span>` : ''}
         <span class="small txt-muted">${how === 'picked' ? '· picked by you' : '· suggested — the nearest within a kilometre'}</span>`
      : `<strong>No station</strong> <span class="small txt-muted">${
          how === 'none' ? '· you said so — the photos go into Field Photos filed under nobody'
          : how === 'no-list' ? '· the station list is not loaded, so the database files each photo by distance'
          : gps ? '· none within a kilometre — the photos are filed under nobody unless you pick one'
          : '· waiting for a GPS fix to suggest one'}</span>`;
    const why = { here: 'You\'re at it', last: 'Last photo', view: 'In view', near: 'Near' };
    const chips = suggestions.map(x => {
      const on = st && st.id === x.s.id;
      return `<button type="button" class="pill cam-sug${on ? ' is-on' : ''}" aria-pressed="${on ? 'true' : 'false'}"
          onclick="FieldCamera.pickStation('${escAttr(x.s.id)}')">${esc(x.s.name)}
          <span class="cam-sug-sub">${fmtM(x.m)} ${point16(x.b)} · ${why[x.why]}</span></button>`;
    }).join('');
    return `
      <p class="cam-chosen">${line}</p>
      ${chips ? `<div class="pill-row cam-sugs" role="group" aria-label="Suggested stations">${chips}</div>` : ''}
      <div class="button-group cam-station-actions">
        <label class="cam-field cam-find small">Find a station
          <input type="search" id="cam-find" value="${esc(find)}" placeholder="Name, number or ALERT ID"
                 oninput="FieldCamera.findStation(this.value)"></label>
        ${how === 'picked' || how === 'none' ? '<button type="button" class="pill" onclick="FieldCamera.pickAuto()">Back to the suggestion</button>' : ''}
        ${how !== 'none' ? '<button type="button" class="pill" onclick="FieldCamera.pickNone()">No station</button>' : ''}
      </div>
      <div id="cam-hits">${hitsHtml()}</div>`;
  }
  function hitsHtml() {
    const q = find.trim();
    if (!q) return '';
    const list = hits(q);
    if (!list.length) return `<p class="small txt-muted">No station with a position matches “${esc(q)}”.</p>`;
    return `<div class="pill-row cam-hits">${list.map(s => `<button type="button" class="pill" onclick="FieldCamera.pickStation('${escAttr(s.id)}')">${esc(s.name)}
        <span class="cam-sug-sub">${esc(s.station_number || '')}${gps ? ` · ${fmtM(metres(gps.lat, gps.lon, s.lat, s.lon))}` : ''}</span></button>`).join('')}</div>`;
  }

  function captionsHtml() {
    return CAPTIONS.map((c, i) => `<button type="button" class="pill${caption === c ? ' is-on' : ''}" aria-pressed="${caption === c ? 'true' : 'false'}"
        onclick="FieldCamera.tapCaption(${i})">${esc(c)}</button>`).join('');
  }

  function sumHtml() {
    const w = waiting().length, up = shots.filter(s => s.status === 'uploading').length;
    const refused = shots.filter(s => s.status === 'refused').length;
    if (!shots.length) return '';
    const bits = [];
    if (up) bits.push('uploading…');
    if (w) bits.push(`${w} waiting${!signedIn() ? ' — sign in to send' : !prefs().auto ? ' — Upload now sends them' : ''}`);
    if (refused) bits.push(`<span class="txt-bad">${refused} refused</span>`);
    if (!bits.length) bits.push('<span class="txt-ok">all uploaded</span>');
    return bits.join(' · ');
  }

  function outActionsHtml() {
    const w = waiting().length;
    const done = shots.filter(s => s.status === 'done' || s.status === 'already').length;
    return `
      ${w && signedIn() ? '<button type="button" class="primary" onclick="FieldCamera.sendNow()">Upload now</button>' : ''}
      ${w && !signedIn() ? '<button type="button" class="primary" onclick="Auth.open()">Sign in to upload</button>' : ''}
      ${done ? `<button type="button" onclick="FieldCamera.clearDone()">Clear the ${done} uploaded</button>` : ''}`;
  }

  const STATUS = {
    waiting: 'Waiting to upload', uploading: 'Uploading', done: 'In Flood-Net', already: 'Already in Flood-Net',
    failed: 'Waiting for a connection', refused: 'Refused',
  };
  function outboxHtml() {
    const head = memOnly
      ? '<p class="small txt-warn">This browser will not keep photos on the device (a private window?) — they are held by this page only, and are lost if it is closed before they upload.</p>'
      : '';
    if (!shots.length) {
      return `${head}<p class="small txt-muted">No photos taken on this device yet. Each one is kept here until it is in Flood-Net,
        so a site with no signal loses nothing.</p>`;
    }
    const signed = signedIn()
      ? ''
      : '<p class="small txt-warn">Signed out: the photos below wait on this device and go up when you <button type="button" class="link-btn" onclick="Auth.open()">sign in</button>.</p>';
    const kept = shots.filter(s => s.status !== 'done' && s.status !== 'already').reduce((n, s) => n + (s.bytes || 0), 0);
    return `${head}${signed}
      ${kept ? `<p class="small txt-muted">${mb(kept)} of photos waiting on this device.</p>` : ''}
      <ul class="cam-list" aria-label="Photos taken on this device">${shots.map(shotHtml).join('')}</ul>`;
  }
  function shotHtml(s) {
    const url = iconUrl(s);
    const when = new Date(s.at);
    const t = `${when.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} ${when.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`;
    const cls = s.status === 'refused' ? 'txt-bad' : s.status === 'done' || s.status === 'already' ? 'txt-ok' : s.status === 'failed' ? 'txt-warn' : 'txt-muted';
    const acts = [];
    if (s.rowId) acts.push(`<button type="button" class="pill" onclick="FieldCamera.openShot('${escAttr(s.id)}')">Show it</button>`);
    if (s.status === 'failed' || s.status === 'refused') acts.push(`<button type="button" class="pill" onclick="FieldCamera.retry('${escAttr(s.id)}')">Try again</button>`);
    if (s.status === 'refused' && s.record && s.record.station_id) acts.push(`<button type="button" class="pill" onclick="FieldCamera.sendUnfiled('${escAttr(s.id)}')">Send it filed under no station</button>`);
    if (s.status !== 'done' && s.status !== 'already') acts.push(`<button type="button" class="pill" onclick="FieldCamera.saveCopy('${escAttr(s.id)}')">Save a copy</button>`);
    acts.push(`<button type="button" class="pill" onclick="FieldCamera.removeShot('${escAttr(s.id)}')" aria-label="Remove ${esc(s.name)}">Remove</button>`);
    return `<li class="cam-item" id="cam-item-${esc(s.id)}">
        ${url ? `<img class="cam-item-img" src="${esc(url)}" alt="" width="80" height="60">` : '<span class="cam-item-img" aria-hidden="true"></span>'}
        <div class="cam-item-body">
          <div class="cam-item-name">${esc(s.station ? PhotoStamp.stationText(s.station) : 'No station')}
            <span class="small txt-muted">${esc(t)}${s.caption ? ` · ${esc(s.caption)}` : ''}${known(s.accuracy) ? ` · ±${Math.round(s.accuracy)} m` : ''}</span></div>
          <div class="small ${cls}" id="cam-item-note-${esc(s.id)}">${esc(STATUS[s.status] || s.status)}${s.note && s.note !== 'Uploaded.' ? ` — ${esc(s.note)}` : ''}</div>
          <div class="pill-row">${acts.join('')}</div>
        </div>
      </li>`;
  }

  function iconUrl(s) {
    if (icons.has(s.id)) return icons.get(s.id);
    if (!s.icon) return null;
    const url = URL.createObjectURL(new Blob([s.icon], { type: 'image/jpeg' }));
    icons.set(s.id, url);
    return url;
  }
  function forgetIcon(id) {
    const u = icons.get(id);
    if (u) URL.revokeObjectURL(u);
    icons.delete(id);
  }

  function showList() {
    const el = $('cam-out-panel');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function paintStage() {
    const idle = $('cam-idle');
    if (idle) { idle.innerHTML = idleHtml(); idle.hidden = cam === 'on'; }
    const v = $('cam-video');
    if (v && cam !== 'on') v.hidden = true;
    paintControls();
    if (cam !== 'on') paintPreview();
  }
  function paintControls() {
    const el = $('cam-controls');
    if (el) el.innerHTML = controlsHtml();
  }
  function paintReadout() {
    const el = $('cam-readout');
    if (el) el.innerHTML = readoutHtml();
    // The heading moves the suggestions' "in view"; refreshed with the readout.
    if (gps && state.activeTab === 'camera') {
      const before = suggestions.map(x => `${x.s.id}:${x.why}`).join();
      suggestions = suggest(stations(), gps, headingNow(), lastId);
      if (suggestions.map(x => `${x.s.id}:${x.why}`).join() !== before) paintStation();
    }
  }
  function paintStation() {
    const el = $('cam-station');
    if (!el) return;
    // The find box keeps its caret through a repaint.
    const active = document.activeElement && document.activeElement.id === 'cam-find';
    el.innerHTML = stationHtml();
    if (active) { const f = $('cam-find'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  }
  function paintCaptions() {
    const el = $('cam-captions');
    if (el) el.innerHTML = captionsHtml();
  }
  function paintOutbox() {
    const el = $('cam-out');
    if (el) el.innerHTML = outboxHtml();
    const a = $('cam-out-actions');
    if (a) a.innerHTML = outActionsHtml();
    const sum = $('cam-sum');
    if (sum) sum.innerHTML = sumHtml();
  }
  function paintShot(s) {
    const note = $(`cam-item-note-${s.id}`);
    if (!note) { paintOutbox(); return; }
    const li = $(`cam-item-${s.id}`);
    if (li) li.outerHTML = shotHtml(s);
    const sum = $('cam-sum');
    if (sum) sum.innerHTML = sumHtml();
    const a = $('cam-out-actions');
    if (a) a.innerHTML = outActionsHtml();
  }

  return {
    render, init, stop, boot, authChanged,
    start, off, shoot, fromFiles, setTorch, toggleFull,
    pickStation, pickNone, pickAuto, findStation, setCaption, tapCaption, setPref,
    retry, sendNow, sendUnfiled, removeShot, clearDone, saveCopy, openShot, showList,
    // The arithmetic, for the check — none of it touches the page.
    suggest, CAPTIONS,
    // Read by the check and by nothing else.
    _debug: () => ({
      cam, compass, gps: gps ? { ...gps } : null, gpsError, heading: headingNow(), pitch: pitchNow(), decl,
      watching: watchId != null, listening, tracks: stream ? stream.getTracks().filter(t => t.readyState === 'live').length : 0,
      wanted, chosen: chosen() ? chosen().id : null, how: stationHow(),
      suggestions: suggestions.map(x => ({ id: x.s.id, m: Math.round(x.m), b: Math.round(x.b), why: x.why })),
      locality: locality ? locality.name : null, ground: ground ? { ...ground } : null,
      memOnly, pumping, caption, settings: { ...prefs() },
      shots: shots.map(s => ({ id: s.id, name: s.name, status: s.status, note: s.note, rowId: s.rowId, station: s.station ? s.station.id : null,
                               sha: s.sha, bytes: s.bytes, tries: s.tries, record: s.record })),
    }),
    _facts: () => facts(new Date()),
  };
})();
if (typeof window !== 'undefined') window.FieldCamera = FieldCamera;
