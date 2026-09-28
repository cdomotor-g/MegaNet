// MegaNet — places.js
//
//   Places   📍 Find a place, the side panel's tool on the Stations tab (its
//            pin blue, where a station's is red): a box that takes the name of
//            a town, a river, a catchment or a council area, or a coordinate,
//            and lists what it means on the ground — and a press on one takes
//            the map there, with a blue pin and, for anything bigger than a
//            point, its outline. And, through the same parse(), a coordinate
//            pair pasted into any latitude or longitude box in the app lands
//            half in each (bindCoordPaste, from init.js).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, escAttr, announce,
// stationLatLonText, copyLatLonPillHtml and mapViewPills; across to app.js for
// mapNote, and to map-catchments.js for the basins' geometry. All of it from
// inside its own functions, so this file's position among the modules is free.
//
// ── Why it has a box of its own now ──────────────────────────────────────────
// It lived in the Stations filter box (#184): text that was not a station was
// answered under the box as well — a coordinate parsed, a town looked up — on
// the argument that both are "make the map be somewhere". In use they were two
// questions sharing one box. The filter narrows the stations on the map and
// the list, so "Gympie" typed to *find the town* also cut the network down to
// the four stations with Gympie in their names, and the answer under the box
// came and went with the caret in it. A place is not a filter: it moves the
// map and leaves the stations alone. So it has its own tool in the side
// panel's strip, beside the stations' 📍, and the filter box is the stations'
// again.
//
// And a box of its own can answer more than towns. What an operator reaches
// for a map of this network to find is as often a river or a catchment as a
// town — "where is the Lockyer", "show me the Fitzroy" — so the list is, in
// this order:
//
//   Coordinate   what the text parses as — answered on the spot, offline
//   Catchments   the 77 Queensland drainage basins the file carries, by name
//                or basin number; drawn from data/qld-basins.geojson
//   Rivers       the rivers and creeks this network's stations stand on (the
//                register's `stream`), with how many; the map goes to them
//   Councils     the local government areas its stations are in, likewise
//   Towns and    OpenStreetMap's gazetteer: towns, localities, suburbs,
//   more         airports, hills, rivers and creeks anywhere, council
//                boundaries — each with its outline or its course where OSM
//                has one
//
// The first four are the file's own and cost nothing; the last is a request.
//
// ── Coordinates are parsed here, never looked up ─────────────────────────────
// A coordinate is not a search. It is already the answer, and sending it to a
// geocoder to be told what it is would be a network round trip to learn what
// arithmetic knows — and would fail offline, which is exactly where a person
// standing beside a site with a handheld GPS is. So parse() is pure, handles
// the four shapes a coordinate actually arrives in (decimal, decimal with
// hemispheres, degrees-minutes, degrees-minutes-seconds), and an entry that
// is *only* a coordinate moves the map on the spot. Field photos and the site
// finder read coordinates through the same parse().
//
// ── The gazetteer ───────────────────────────────────────────────────────────
// Nominatim, OpenStreetMap's own. Keyless, CORS-open, and the only geocoder
// that can be called from a static page with nothing in the repo to leak. Its
// usage policy is the constraint that shapes the code below rather than a
// footnote: at most one request a second, no bulk querying, and results
// cached rather than re-asked. So a lookup is debounced well past a
// keystroke, throttled to the published rate, answered from a cache whenever
// it can be, and never fired at text that is obviously a coordinate, a number
// or too short to be a name. Each answer carries its outline or course,
// simplified to about a hundred metres (polygon_threshold), which is what lets
// a river be drawn rather than pinned.
//
// Failure is quiet and says so: no network, a blocked host or a rate limit
// leaves the file's own answers standing and puts one line in the list.
const Places = (function () {
  const URL_BASE   = 'https://nominatim.openstreetmap.org/search';
  const ATTRIB     = 'Place names © OpenStreetMap contributors (Nominatim)';
  const DEBOUNCE_MS = 650;    // a pause, not a keystroke, before anybody's
                              // geocoder is asked
  const COORD_SETTLE_MS = 250; // …and a shorter one before the map moves to a
                              // typed coordinate; see input()
  const MIN_RATE_MS = 1100;   // Nominatim's published ceiling is 1/s
  const TIMEOUT_MS  = 12000;
  const MAX_HITS    = 8;
  const MIN_CHARS   = 3;
  const CACHE_MAX   = 120;
  const LOCAL_CAP   = 6;      // rows shown per group of the file's own
  const SHAPE_DEG   = 0.001;  // the gazetteer's outlines, simplified to ~100 m

  // What counts as a place worth offering. Nominatim's `category` is the OSM
  // key and `type` the value, so this is a whitelist of keys with an optional
  // set of values under each. Everything else — a shop, a house number, a
  // driveway — is dropped: this is for finding somewhere on a map of a
  // telemetry network, and a list with a bakery in it is a list nobody reads
  // to the bottom of.
  const KINDS = {
    place:    null,   // city, town, village, hamlet, suburb, locality, island…
    aeroway:  new Set(['aerodrome', 'airstrip', 'heliport', 'terminal']),
    boundary: new Set(['administrative']),
    natural:  new Set(['peak', 'bay', 'cape', 'beach', 'volcano', 'water']),
    waterway: new Set(['river', 'stream', 'creek', 'canal', 'dam', 'weir']),
    water:    null,
    landuse:  new Set(['residential', 'reservoir']),
    railway:  new Set(['station', 'halt']),
    amenity:  new Set(['townhall']),
    leisure:  new Set(['park', 'nature_reserve']),
  };

  // The label under a result, in words rather than in OSM's own vocabulary.
  const KIND_LABEL = {
    city: 'city', town: 'town', village: 'village', hamlet: 'hamlet',
    suburb: 'suburb', locality: 'locality', isolated_dwelling: 'locality',
    neighbourhood: 'neighbourhood', island: 'island', county: 'region',
    state: 'state', region: 'region', municipality: 'local government area',
    administrative: 'boundary',
    aerodrome: 'airport', airstrip: 'airstrip', heliport: 'heliport',
    terminal: 'airport terminal',
    peak: 'peak', volcano: 'peak', bay: 'bay', cape: 'headland', beach: 'beach',
    river: 'river', stream: 'creek', creek: 'creek', canal: 'canal', dam: 'dam', weir: 'weir',
    water: 'water', reservoir: 'reservoir', lake: 'lake',
    residential: 'residential area', station: 'railway station', halt: 'railway stop',
    townhall: 'town hall', park: 'park', nature_reserve: 'nature reserve',
  };

  // Words that say what kind of thing a name is rather than which one. Left
  // out of a catchment's match, because the basins are named bare — "Fitzroy",
  // not "Fitzroy River" — and "fitzroy river catchment" means that one.
  const GENERIC = new Set(['river', 'rivers', 'creek', 'ck', 'catchment', 'basin', 'the']);

  const cache = new Map();      // lowercased query → results (LRU by re-insert)
  let lastAt = 0;               // when the last request went out, for the throttle
  let map = null;
  let layer = null;             // the pin and the outline of the one place shown
  let query = '';               // what is in the box
  let coord = null;             // what it parses as, if anything
  let local = null;             // the file's own answers: { catchments, rivers, councils }
  let gaz = { text: '', list: null, loading: false, error: '', asked: false };
  let shown = null;             // the result the map is showing: { group, n, hit, q }
  let flownTo = null;           // the coordinate the map was last moved to, so a
                                // second settle of the same text does not move it
  let lookupTimer = 0, coordTimer = 0;
  let index = null;             // rivers and councils from the file, built once per file

  // ── Coordinates ─────────────────────────────────────────────────────────────

  // A number with an optional hemisphere letter on either side of it, in any of
  // decimal / degrees-minutes / degrees-minutes-seconds. Returns signed degrees
  // and which hemisphere letter (if any) was found, so the caller can tell a
  // latitude from a longitude without guessing at their order.
  //
  // Deliberately tolerant about the symbols: ° ' " ′ ″ are all optional and a
  // space will do for any of them, because a coordinate pasted out of a GPS, a
  // spreadsheet, a text message and Google Maps arrives punctuated four
  // different ways and they all mean the same thing.
  const NUM = '[-+]?\\d+(?:\\.\\d+)?';
  const ONE = new RegExp(
    '^\\s*(?:([NSEW])\\s*)?' +
    `(${NUM})\\s*°?\\s*` +
    `(?:(${NUM})\\s*['′]?\\s*` +
    `(?:(${NUM})\\s*["″]?\\s*)?)?` +
    '([NSEW])?\\s*$', 'i');

  function parseOne(text) {
    const m = ONE.exec(String(text || ''));
    if (!m) return null;
    const hemi = (m[1] || m[5] || '').toUpperCase();
    const d = parseFloat(m[2]);
    if (!isFinite(d)) return null;
    const mm = m[3] == null ? 0 : parseFloat(m[3]);
    const ss = m[4] == null ? 0 : parseFloat(m[4]);
    if (mm < 0 || mm >= 60 || ss < 0 || ss >= 60) return null;
    // A signed degree with minutes on it is still one value: -26°7' is 26°7'
    // south, not -26 degrees plus 7 minutes north.
    const mag = Math.abs(d) + mm / 60 + ss / 3600;
    let v = d < 0 || /^-/.test(m[2]) ? -mag : mag;
    if (hemi === 'S' || hemi === 'W') v = -Math.abs(v);
    if (hemi === 'N' || hemi === 'E') v = Math.abs(v);
    return { v, hemi, hadMinutes: m[3] != null };
  }

  // The whole entry as one coordinate, or null. Splits on a comma, a slash or
  // (failing either) the gap between the two halves — which is the fiddly case,
  // because "26 07 24 S 152 34 04 E" has six numbers in it and no separator at
  // all. The hemisphere letters are what make that one tractable: where they
  // are present they mark the end of each half.
  function parse(text) {
    const s = normalise(text);
    if (!s) return null;

    const halves = split(s);
    if (!halves) return null;

    const A = parseOne(halves[0]), B = parseOne(halves[1]);
    if (!A || !B) return null;

    // Which is which. A hemisphere letter settles it outright; otherwise the
    // first is the latitude, which is the convention every one of this app's
    // own coordinate strings is written in — unless the first cannot BE a
    // latitude, in which case they were pasted the other way round and the
    // kinder reading is the right one.
    let lat, lon;
    const isLatA = A.hemi === 'N' || A.hemi === 'S';
    const isLonA = A.hemi === 'E' || A.hemi === 'W';
    const isLatB = B.hemi === 'N' || B.hemi === 'S';
    const isLonB = B.hemi === 'E' || B.hemi === 'W';
    if (isLonA || isLatB)      { lat = B.v; lon = A.v; }
    else if (isLatA || isLonB) { lat = A.v; lon = B.v; }
    else if (Math.abs(A.v) > 90 && Math.abs(B.v) <= 90) { lat = B.v; lon = A.v; }
    else                       { lat = A.v; lon = B.v; }

    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
    // Two bare integers are a pair of numbers far more often than they are a
    // coordinate — "6128 6129" is two station numbers — so a coordinate has to
    // look like one: a decimal point, minutes, or a hemisphere letter.
    const decimal = /\./.test(s);
    const marked  = !!(A.hemi || B.hemi) || A.hadMinutes || B.hadMinutes;
    if (!decimal && !marked) return null;

    return { lat, lon, text: `${Number(lat.toFixed(6))}, ${Number(lon.toFixed(6))}` };
  }

  // One coordinate's worth of text, made regular enough for split() and
  // parseOne() to read: labels off, brackets off, one space between tokens.
  function normalise(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    // Strip the labels a coordinate is sometimes pasted with, and normalise the
    // letter form of the symbols — "26d 07m 24s", which is how more than one
    // handheld writes it. The letters are only rewritten when a `d` or `m`
    // marker is actually there, because a bare trailing "s" is South far more
    // often than it is seconds, and reading it as a symbol is what would put a
    // Queensland site in Mongolia. Done here rather than per half, because the
    // halves are found by looking for the hemisphere letters and an "s" that
    // means seconds must be gone before that search runs.
    // The look-alikes first: º (an ordinal) and ˚ (a ring) stand in for the
    // degree sign, curly quotes and accents for minutes and seconds, and two
    // primes typed as one second mark — each is how some other program's
    // export writes the same symbol.
    let s = raw.replace(/[º˚]/g, '°')
               .replace(/[’‘´`]/g, "'")
               .replace(/[”“]|''/g, '"')
               .replace(/\b(lat|latitude|lon|lng|long|longitude)\s*[:=]?\s*/gi, ' ')
               .replace(/[()\[\]]/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
    if (/\d\s*[dm]\b/i.test(s)) {
      s = s.replace(/(\d)\s*d\b/gi, '$1°')
           .replace(/(\d)\s*m\b/gi, "$1'")
           .replace(/(\d)\s*s\b/gi, '$1"');
    }
    return s;
  }

  // Where the latitude stops and the longitude starts. Four rules, tried in
  // order, and every one of them deterministic — the earlier version guessed
  // with a lazy regex and cut "S 26 07.4 E 152 34.07" after the first letter,
  // which is a valid reading of the pattern and a wrong reading of the string.
  //
  //   1. an explicit separator, if it leaves exactly two parts
  //   2. the two hemisphere letters, which mark either the end of each half
  //      (trailing style, "26 07 24 S 152 34 04 E") or the start of it
  //      (leading style, "S26 28.5 E153 01.5") — told apart by whether a digit
  //      comes before the first letter
  //   3. two space-separated tokens: plain decimal degrees
  //   4. six or four bare numbers: degrees-minutes-seconds, or degrees-minutes,
  //      of each in turn
  function split(s) {
    if (/[,;/|]/.test(s)) {
      const bits = s.split(/[,;/|]+/).map(x => x.trim()).filter(Boolean);
      if (bits.length === 2) return bits;
    }
    const at = [];
    for (let i = 0; i < s.length; i++) if (/[NSEW]/i.test(s[i])) at.push(i);
    if (at.length === 2) {
      const [p1, p2] = at;
      const trailing = /\d/.test(s.slice(0, p1));
      const A = trailing ? s.slice(0, p1 + 1) : s.slice(p1, p2);
      const B = trailing ? s.slice(p1 + 1)    : s.slice(p2);
      if (A.trim() && B.trim()) return [A.trim(), B.trim()];
    }
    const bits = s.split(' ');
    if (bits.length === 2) return bits;
    if (bits.every(b => /^[-+]?\d+(\.\d+)?$/.test(b))) {
      if (bits.length === 6) return [bits.slice(0, 3).join(' '), bits.slice(3).join(' ')];
      if (bits.length === 4) return [bits.slice(0, 2).join(' '), bits.slice(2).join(' ')];
    }
    return null;
  }

  // One value on its own — "27°33'15.8\"S", "152 16.48 E", "-27.554389" —
  // as signed decimal degrees and the hemisphere letter it carried, or null.
  function parseSingle(text) {
    const s = normalise(text);
    if (!s) return null;
    const one = parseOne(s);
    if (!one || !(Math.abs(one.v) <= 180)) return null;
    return { v: one.v, hemi: one.hemi };
  }

  // ── Pasting into a latitude or longitude box ────────────────────────────────
  // Every latitude box in the app sits beside a longitude box, and a position
  // is almost always copied as the pair — out of Google Maps, a GPS, a
  // spreadsheet — so pasting "-27.554389, 152.274658" into either one puts
  // each half where it belongs instead of making the operator split it by
  // hand. A single value in degrees-minutes-seconds, or with a hemisphere
  // letter, is converted on the way in, and one with a letter that says it is
  // the other half goes to the other box. Whatever lands is decimal degrees:
  // that is all any of these boxes stores.
  //
  // The boxes are found by what they are, not wired one by one: an input with
  // data-coord="lat" or "lon", or failing that one whose id, name or data-f
  // ends in lat / latitude or lon / lng / long / longitude (data-coord="off"
  // opts one out). Its other half is the nearest box of the other kind that
  // shares an ancestor with it, which keeps a list of rows pairing within
  // each row.
  const LAT_KEY = /(?:^|[-_])lat(?:itude)?$/i;
  const LON_KEY = /(?:^|[-_])(?:lon|lng|long|longitude)$/i;
  const PLAIN   = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*$/;

  function coordRole(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    const d = el.getAttribute('data-coord');
    if (d) return d === 'lat' || d === 'lon' ? d : null;
    for (const k of [el.id, el.name, el.getAttribute('data-f')]) {
      if (!k) continue;
      if (LAT_KEY.test(k)) return 'lat';
      if (LON_KEY.test(k)) return 'lon';
    }
    return null;
  }

  function partnerOf(el, role) {
    const want = role === 'lat' ? 'lon' : 'lat';
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      for (const c of node.querySelectorAll('input')) {
        if (c !== el && coordRole(c) === want) return c;
      }
    }
    return null;
  }

  // What a paste into a `role` box means: { lat?, lon? } in decimal degrees,
  // or null to leave the paste to the browser. A plain number that fits the
  // box is left alone, so pasting a few digits into the middle of a value
  // still does what it always did.
  function readPaste(text, role) {
    const t = String(text || '').trim();
    if (!t) return null;
    const pair = parse(t);
    if (pair) return { lat: pair.lat, lon: pair.lon };
    const one = parseSingle(t);
    if (!one) return null;
    let as = role;
    if (one.hemi === 'N' || one.hemi === 'S') as = 'lat';
    else if (one.hemi === 'E' || one.hemi === 'W') as = 'lon';
    else if (role === 'lat' && Math.abs(one.v) > 90) as = 'lon';
    if (as === 'lat' && !(Math.abs(one.v) <= 90)) return null;
    if (as === role && PLAIN.test(t)) return null;
    return { [as]: one.v };
  }

  function onCoordPaste(e) {
    const el = e.target;
    const role = coordRole(el);
    if (!role || el.readOnly || el.disabled) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    const got = readPaste(text, role);
    if (!got) return;
    const other = partnerOf(el, role);
    const writes = [];
    for (const k of ['lat', 'lon']) {
      if (got[k] == null) continue;
      const box = k === role ? el : other;
      if (box && !box.readOnly && !box.disabled) writes.push([box, got[k]]);
    }
    if (!writes.length) return;
    e.preventDefault();
    // Every value in before any event goes out, because a change handler may
    // re-render the form and take the other box with it.
    for (const [box, v] of writes) box.value = String(Number(v.toFixed(7)));
    for (const [box] of writes) {
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ── The file's own: catchments, rivers, councils ──────────────────────────

  // "LOCKYER CREEK" as a person writes it. The register's stream names are
  // upper case, and a list of them shouted is harder to read than it needs to
  // be; "Mc", "O'" and a word after a hyphen or a bracket are capitalised
  // too (not one after any other apostrophe: King's Creek, not King'S).
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-(/])([a-z])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\bMc([a-z])/g, (m, a) => `Mc${a.toUpperCase()}`)
      .replace(/\bO['’]([a-z])/g, (m, a) => `${m.slice(0, 2)}${a.toUpperCase()}`);
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // A river's name as a key: the register writes a creek as "CK" as often as
  // "CREEK" (Lockyer Creek has seventeen stations under the one and one under
  // the other), and a river as "R" at the end of its name (Burdekin R), and
  // they are the same creek and the same river.
  function riverKey(s) {
    return norm(s).replace(/\b(ck|crk)\b/g, 'creek').replace(/\b(rv|riv)\b/g, 'river').replace(/ r$/, ' river');
  }

  // Rivers and councils, from the stations: each distinct name with the
  // stations it holds and the box round the ones with a position, named as
  // most of its stations spell it. Built once for each file loaded — 4,873
  // stations is a few milliseconds, but not one worth spending on every
  // keystroke.
  function fileIndex() {
    const data = typeof state !== 'undefined' ? state.data : null;
    if (!data) return { rivers: [], councils: [] };
    if (index && index.data === data) return index;
    const group = field => {
      const by = new Map();
      for (const s of data.stations || []) {
        const raw = String(s[field] || '').trim();
        if (!raw) continue;
        const key = field === 'stream' ? riverKey(raw) : norm(raw);
        let g = by.get(key);
        if (!g) by.set(key, g = { key, name: '', spell: new Map(), n: 0, s: 90, w: 180, north: -90, e: -180, located: 0 });
        g.n++;
        g.spell.set(raw, (g.spell.get(raw) || 0) + 1);
        if (s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon)) {
          g.located++;
          g.s = Math.min(g.s, s.lat); g.north = Math.max(g.north, s.lat);
          g.w = Math.min(g.w, s.lon); g.e = Math.max(g.e, s.lon);
        }
      }
      for (const g of by.values()) {
        const raw = [...g.spell].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
        g.name = field === 'stream' ? titleCase(raw) : raw;
        delete g.spell;
      }
      return [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    };
    index = { data, rivers: group('stream'), councils: group('lga') };
    return index;
  }

  // The file's answers for what is in the box. A name matches where it holds
  // what was typed; a catchment also by its basin number, whole and as a
  // number ("130", or "011" and "11" both the Bulloo — MapCatchments' rule).
  function localFor(q) {
    const t = norm(q);
    if (t.length < 2 || coord) return { catchments: [], rivers: [], councils: [] };
    const bare = t.split(' ').filter(w => !GENERIC.has(w)).join(' ');
    const digits = /^\d+$/.test(t) ? Number(t) : null;
    const cats = ((typeof state !== 'undefined' && state.data && state.data.catchments) || [])
      .filter(c => (digits != null ? c.basin_no != null && Number(c.basin_no) === digits
                                   : !!bare && norm(c.name).includes(bare)))
      .sort((a, b) => (norm(a.name).startsWith(bare) ? 0 : 1) - (norm(b.name).startsWith(bare) ? 0 : 1) || a.name.localeCompare(b.name));
    const ix = fileIndex();
    const named = (list, k) => (digits != null ? [] : list.filter(g => g.located && g.key.includes(k))
      .sort((a, b) => (a.key.startsWith(k) ? 0 : 1) - (b.key.startsWith(k) ? 0 : 1) || b.n - a.n));
    return { catchments: cats, rivers: named(ix.rivers, riverKey(q)), councils: named(ix.councils, t) };
  }

  // ── The gazetteer ───────────────────────────────────────────────────────────

  // Is this worth asking a geocoder about? Station numbers, ALERT addresses,
  // address windows and pasted digit columns are what an operator of this
  // network has in their clipboard, and none of them is a place name — sending
  // them would be bulk-querying somebody else's free service with text that
  // cannot match.
  function askable(q) {
    const s = String(q || '').trim();
    if (s.length < MIN_CHARS) return false;
    if (s.includes('\n')) return false;          // a pasted column, not a name
    if (!/[a-z]{3}/i.test(s)) return false;      // no word in it
    if (/^\d+\s*-\s*\d+$/.test(s)) return false; // an address window
    return true;
  }

  function keep(hit) {
    const allowed = KINDS[hit.category];
    if (allowed === undefined) return false;
    return allowed === null || allowed.has(hit.type);
  }

  // "Gympie" out of "Gympie, Gympie Regional Council, Queensland, 4570,
  // Australia" — the name, then just enough of the address to tell two of them
  // apart, because Queensland has more than one of most things.
  function shorten(hit) {
    const name = hit.name || String(hit.display_name || '').split(',')[0].trim();
    const rest = String(hit.display_name || '').split(',').map(x => x.trim()).slice(1);
    const where = rest.filter(x => x && x !== name && !/^\d{4}$/.test(x) && x !== 'Australia');
    return { name, where: where.slice(0, 2).join(', ') };
  }

  function remember(key, list) {
    cache.delete(key);
    cache.set(key, list);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // One request, throttled to the published rate. Resolves to a list — never
  // rejects: a failed lookup is a line in the list, not a broken tool. The
  // request's slot is taken when it is asked for, not when its wait is over:
  // two asked for inside one wait would otherwise both read the same last
  // request and go out together. `stale` says whether the box has moved on to
  // another lookup by the time the slot comes round, and then nothing is sent.
  function ask(q, stale) {
    const key = q.trim().toLowerCase();
    if (cache.has(key)) {
      const hit = cache.get(key);
      remember(key, hit);
      return Promise.resolve({ ok: true, list: hit, cached: true });
    }
    const at = Math.max(Date.now(), lastAt + MIN_RATE_MS);
    lastAt = at;
    return new Promise(resolve => setTimeout(resolve, at - Date.now())).then(() => {
      if (stale && stale()) return { ok: false, list: [], stale: true };
      const params = new URLSearchParams({
        q, format: 'jsonv2', limit: String(MAX_HITS * 3),
        countrycodes: 'au', 'accept-language': 'en',
        polygon_geojson: '1', polygon_threshold: String(SHAPE_DEG),
      });
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      return fetch(`${URL_BASE}?${params}`, { signal: ctl.signal, headers: { Accept: 'application/json' } })
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then(json => {
          const list = (Array.isArray(json) ? json : []).filter(keep).slice(0, MAX_HITS).map(h => {
            const { name, where } = shorten(h);
            const bb = Array.isArray(h.boundingbox) ? h.boundingbox.map(Number) : null;   // [s, n, w, e]
            const shape = h.geojson && h.geojson.type && h.geojson.type !== 'Point' ? h.geojson : null;
            return {
              name, where,
              kind: KIND_LABEL[h.addresstype] || KIND_LABEL[h.type] || String(h.type || '').replace(/_/g, ' '),
              lat: parseFloat(h.lat), lon: parseFloat(h.lon),
              bbox: bb && bb.every(isFinite) ? bb : null,
              shape,
            };
          }).filter(h => isFinite(h.lat) && isFinite(h.lon));
          remember(key, list);
          return { ok: true, list };
        })
        .catch(e => ({ ok: false, list: [],
                       error: e && e.name === 'AbortError' ? 'the lookup timed out'
                            : 'the place-name service could not be reached' }))
        .finally(() => clearTimeout(t));
    });
  }

  function lookup(text) {
    gaz = { text, list: null, loading: true, error: '', asked: true };
    render();
    ask(text, () => gaz.text !== text).then(res => {
      if (gaz.text !== text) return;   // the box moved on while we waited
      gaz = { text, list: res.list, loading: false, error: res.ok ? '' : res.error, asked: true };
      render();
    });
  }

  // ── On the map ──────────────────────────────────────────────────────────────

  function markerHtml(p) {
    const s = { lat: p.lat, lon: p.lon, name: p.name || p.text };
    return `
      <div class="mn-place-pop">
        <h4>${esc(p.name || 'Coordinate')}</h4>
        <p class="small">${p.kind ? `${esc(p.kind)}${p.where ? ` · ${esc(p.where)}` : ''}<br>` : ''}
          ${esc(stationLatLonText(s))}<br>
          <span class="txt-muted">${esc(p.credit || (p.name ? ATTRIB : 'Typed into Find a place — not a station.'))}</span></p>
        <div class="pill-row">
          ${copyLatLonPillHtml(s)}
          ${mapViewPills(s).join('\n          ')}
        </div>
      </div>`;
  }

  // The colour of what this tool draws: the blue of its pin, a token so that
  // it follows the theme (Leaflet's path options cannot take var()).
  function ink() {
    return (typeof cssVar === 'function' && cssVar('--place-ink', '')) || '#1a6fd6';
  }

  // Draw what `hit` is — a pin, and its outline or course where it has one —
  // replacing whatever this tool drew before. `move` is whether the map goes
  // there: a result pressed, yes; the same one drawn again on a new map (a
  // render of the tab), no. Returns the layer.
  function draw(hit, move) {
    if (!map) return null;
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
    const c = ink();
    if (hit.shape) {
      L.geoJSON(hit.shape, {
        interactive: false,
        style: f => ({ color: c, weight: /Line/.test(f.geometry.type) ? 4 : 2.5, opacity: 0.9,
                       fillColor: c, fillOpacity: /Polygon/.test(f.geometry.type) ? 0.08 : 0 }),
      }).addTo(layer);
    }
    if (hit.lat != null && hit.lon != null) {
      L.marker([hit.lat, hit.lon], {
        title: hit.name || hit.text,
        icon: L.divIcon({
          className: 'mn-place-icon',
          html: '<span class="mn-place mn-pin-blue" aria-hidden="true">📍</span>',
          iconSize: [0, 0], iconAnchor: [0, 0],
        }),
        zIndexOffset: 1500,
      }).bindPopup(() => markerHtml(hit), { maxWidth: 320 }).addTo(layer);
    }
    if (move) {
      const b = hit.bounds;
      if (b && (b[1] - b[0] > 1e-4 || b[3] - b[2] > 1e-4)) {
        map.fitBounds([[b[0], b[2]], [b[1], b[3]]], { padding: [28, 28], maxZoom: hit.maxZoom || 14 });
      } else if (hit.lat != null) {
        map.setView([hit.lat, hit.lon], Math.max(map.getZoom(), hit.zoom || 12));
      }
      if (hit.lat != null && !hit.shape) layer.eachLayer(l => { if (l.openPopup) l.openPopup(); });
    }
    return layer;
  }

  // ── The results, as a thing to go to ─────────────────────────────────────
  // Each group's rows turned into what draw() takes: a point, a box, an
  // outline. `n` is the row's index in its group.
  function hitFor(group, n) {
    if (group === 'coord') {
      return coord ? { name: '', text: coord.text, lat: coord.lat, lon: coord.lon, zoom: 13, kind: '' } : null;
    }
    if (group === 'catchment') {
      const c = local && local.catchments[n];
      if (!c) return null;
      return { name: `${c.name} catchment`, kind: `drainage basin ${c.basin_no || ''}`.trim(),
               where: c.division ? `${c.division} division` : '', catchmentId: c.id,
               credit: typeof MapCatchments !== 'undefined' ? MapCatchments.ATTRIBUTION : '' };
    }
    if (group === 'river' || group === 'council') {
      const g = local && local[group === 'river' ? 'rivers' : 'councils'][n];
      if (!g || !g.located) return null;
      const what = group === 'river' ? 'river or creek' : 'local government area';
      // The river's own course, where the gazetteer has already been asked
      // and answered with a watercourse of that name.
      const osm = group === 'river' && gaz.list
        ? gaz.list.find(h => h.shape && /river|creek|stream|canal/.test(h.kind) && riverKey(h.name) === g.key) : null;
      return {
        name: g.name, kind: `${what} · ${g.n} station${g.n === 1 ? '' : 's'}`, where: '',
        lat: (g.s + g.north) / 2, lon: (g.w + g.e) / 2,
        bounds: osm && osm.bbox ? osm.bbox : [g.s, g.north, g.w, g.e], shape: osm ? osm.shape : null, maxZoom: 13,
        credit: osm ? ATTRIB : 'Where this network\'s stations on it are — from the station register.',
      };
    }
    if (group === 'osm') {
      const h = gaz.list && gaz.list[n];
      if (!h) return null;
      const zoom = /city/.test(h.kind) ? 11 : /town|suburb|airport|peak|locality|village/.test(h.kind) ? 13 : 12;
      return { ...h, bounds: h.shape ? h.bbox : null, zoom };
    }
    return null;
  }

  // Go to a row: draw it, move the map, and say where it went.
  function go(group, n) {
    const hit = hitFor(group, n);
    if (!hit || !map) return;
    // With the query it was pressed under: a row is the one shown only in the
    // list it was pressed in, not whatever the next query puts at its index.
    shown = { group, n, hit, q: query.trim() };
    if (hit.catchmentId && typeof MapCatchments !== 'undefined') {
      // The basin's outline is 760 KB the first time it is asked for, and it is
      // asked for by somebody who pressed a catchment.
      const mine = shown;
      MapCatchments.ready().then(fc => {
        if (shown !== mine || !map) return;
        const f = ((fc && fc.features) || []).find(x => x.properties && x.properties.id === hit.catchmentId);
        if (!f) return;
        const b = L.geoJSON(f).getBounds();
        hit.shape = f.geometry;
        hit.bounds = [b.getSouth(), b.getNorth(), b.getWest(), b.getEast()];
        const at = MapCatchments.labelPoint ? MapCatchments.labelPoint(f) : null;
        const c = at || [b.getCenter().lat, b.getCenter().lng];
        hit.lat = c[0]; hit.lon = c[1];
        hit.maxZoom = 12;
        draw(hit, true);
        told(hit);
      }).catch(() => { if (typeof mapNote === 'function') mapNote('The catchment outlines could not be loaded.', 5000); });
    } else {
      draw(hit, true);
      told(hit);
    }
    render();
  }

  function told(hit) {
    const where = hit.lat != null ? stationLatLonText({ lat: hit.lat, lon: hit.lon }) : '';
    const name = hit.name || hit.text || 'That place';
    if (typeof mapNote === 'function') {
      mapNote(`${name}${where ? ` — ${where}` : ''}. Not a station: the blue pin clears with ✕ in Find a place, or with ↺.`, 7000);
    }
    announce(`${name} — the map is there, marked with a blue pin.`);
  }

  // ── The pane ────────────────────────────────────────────────────────────────

  // The pane's markup, once, for the side panel's skeleton (app.js,
  // dockSkeleton): a heading, the box, a line about what it takes, and the
  // list this module writes.
  function paneHtml() {
    return `
      <div class="places-pane">
        <div class="mn-mapctl-head places-head">
          <h2 class="mn-mapctl-title" id="places-h"><span class="mn-pin-blue" aria-hidden="true">📍</span> Find a place</h2>
        </div>
        <div class="places-box">
          <input type="search" id="places-q" class="places-q" autocomplete="off" spellcheck="false"
                 aria-labelledby="places-h" aria-describedby="places-hint" aria-controls="places-results"
                 placeholder="Town, river, catchment or lat, lon"
                 oninput="Places.input(this.value)" onkeydown="Places.key(event)">
          <button type="button" class="places-clear" onclick="Places.clear(true)" title="Clear the box and the pin on the map"
                  aria-label="Clear the place">✕</button>
        </div>
        <p class="small places-hint" id="places-hint">A town, river or creek, catchment or basin number, council area, or a coordinate. The map goes there; the stations are left as they are.</p>
        <div class="places-results" id="places-results"></div>
      </div>`;
  }

  function rowHtml(group, n, name, kind) {
    const here = shown && shown.q === query.trim() && shown.group === group && shown.n === n;
    return `<li><button type="button" class="places-hit${here ? ' is-here' : ''}" data-group="${group}" data-n="${n}"
                ${here ? 'aria-current="true"' : ''} onclick="Places.go('${group}', ${n})"
                title="Take the map to ${escAttr(name)}"><span class="places-hit-ico mn-pin-blue" aria-hidden="true">📍</span><span class="places-hit-text"><span class="places-hit-name">${esc(name)}</span> <span class="places-hit-kind">${esc(kind)}</span></span></button></li>`;
  }

  function groupHtml(id, title, rows, more) {
    if (!rows.length) return '';
    return `<section class="places-group" aria-labelledby="places-g-${id}">
        <h3 class="places-group-h" id="places-g-${id}">${esc(title)}</h3>
        <ul class="places-list">${rows.join('')}</ul>
        ${more > 0 ? `<p class="small places-more">and ${more} more — keep typing to narrow it</p>` : ''}
      </section>`;
  }

  function resultsHtml() {
    const q = query.trim();
    if (!q) return '';
    const out = [];
    if (coord) {
      out.push(groupHtml('coord', 'Coordinate', [rowHtml('coord', 0, coord.text, flownTo === `${coord.lat},${coord.lon}` ? 'the map is here' : 'go here')], 0));
    }
    const L0 = local || { catchments: [], rivers: [], councils: [] };
    const cap = (list, f) => list.slice(0, LOCAL_CAP).map(f);
    out.push(groupHtml('catchment', 'Catchments', cap(L0.catchments, (c, i) =>
      rowHtml('catchment', i, c.name, `basin ${c.basin_no || '—'}${c.division ? ` · ${c.division}` : ''}`)), L0.catchments.length - LOCAL_CAP));
    out.push(groupHtml('river', 'Rivers and creeks this network is on', cap(L0.rivers, (g, i) =>
      rowHtml('river', i, g.name, `${g.n} station${g.n === 1 ? '' : 's'}`)), L0.rivers.length - LOCAL_CAP));
    out.push(groupHtml('council', 'Council areas with stations in them', cap(L0.councils, (g, i) =>
      rowHtml('council', i, g.name, `${g.n} station${g.n === 1 ? '' : 's'}`)), L0.councils.length - LOCAL_CAP));
    if (!coord && askable(q)) {
      let body;
      if (gaz.text !== q || gaz.loading) body = '<p class="small txt-muted places-status">Looking up the place name…</p>';
      else if (gaz.error) body = `<p class="small txt-warn places-status">Place lookup unavailable — ${esc(gaz.error)}. What the station file knows is above.</p>`;
      else if (gaz.list && gaz.list.length) {
        body = `<ul class="places-list">${gaz.list.map((h, i) => rowHtml('osm', i, h.name, `${h.kind}${h.where ? ` · ${h.where}` : ''}`)).join('')}</ul>
          <p class="small txt-muted places-credit">${esc(ATTRIB)}</p>`;
      } else body = '<p class="small txt-muted places-status">No town, locality, river or airport by that name.</p>';
      out.push(`<section class="places-group" aria-labelledby="places-g-osm">
          <h3 class="places-group-h" id="places-g-osm">Towns, localities and more</h3>${body}</section>`);
    }
    const html = out.filter(Boolean).join('');
    return html || '<p class="small txt-muted places-status">Nothing by that name in the station file. Keep typing for the gazetteer — three letters at least.</p>';
  }

  // Write the list. The pressed row, or failing it the box, keeps focus: a
  // row pressed re-renders the list under the finger.
  function render() {
    const el = document.getElementById('places-results');
    if (!el) return;
    const a = document.activeElement;
    const had = a && el.contains(a) && a.dataset ? { group: a.dataset.group, n: a.dataset.n } : null;
    el.innerHTML = resultsHtml();
    if (had) {
      const back = el.querySelector(`.places-hit[data-group="${had.group}"][data-n="${had.n}"]`);
      if (back) back.focus({ preventScroll: true });
    }
  }

  // Called from the box on every keystroke. Coordinates and the file's own
  // answers are there at once — no network, works offline — and an entry that
  // is *nothing but* a coordinate takes the map with it, because that is what
  // pasting one into a box is asking for. A name waits for a pause and then,
  // only if it looks like one, is asked about.
  function input(text) {
    query = String(text || '');
    const s = query.trim();
    clearTimeout(lookupTimer);
    clearTimeout(coordTimer);
    if (!s) { clear(false); return; }
    coord = parse(s);
    local = localFor(s);
    if (coord) {
      render();
      // The list says so at once — the parse is arithmetic and costs nothing —
      // but the *map* waits for the typing to stop. Typed a character at a
      // time, "-26.1234, 152.5678" is a valid coordinate at "-26.1 152", again
      // at "-26.12 152.5" and so on, and a map that lurches at each of them is
      // a map nobody can read. A paste, which is what this is mostly for, is
      // one event and moves once.
      const key = `${coord.lat},${coord.lon}`;
      coordTimer = setTimeout(() => {
        if (!coord || `${coord.lat},${coord.lon}` !== key || flownTo === key) return;
        flownTo = key;
        go('coord', 0);
      }, COORD_SETTLE_MS);
      return;
    }
    render();
    if (askable(s) && gaz.text !== s) lookupTimer = setTimeout(() => lookup(s), DEBOUNCE_MS);
  }

  // Enter in the box goes to the first thing listed; the arrow down steps into
  // the list, where the buttons take Tab and Enter as buttons do.
  function key(e) {
    if (e.key === 'Enter') {
      const first = document.querySelector('#places-results .places-hit');
      if (first) { e.preventDefault(); go(first.dataset.group, Number(first.dataset.n)); }
    } else if (e.key === 'ArrowDown') {
      const first = document.querySelector('#places-results .places-hit');
      if (first) { e.preventDefault(); first.focus(); }
    }
  }

  // The pin and the outline off the map, the list left as it is (↺, which
  // clears what is drawn on the map and leaves the tools' own contents).
  function clearMark() {
    if (layer) { layer.remove(); layer = null; }
    shown = null;
    render();
  }

  // Everything: the box, the list and the mark. `box` also empties the field,
  // for the ✕ beside it; the field's own emptying calls this without it.
  function clear(box) {
    clearTimeout(lookupTimer);
    clearTimeout(coordTimer);
    query = ''; coord = null; local = null; flownTo = null;
    gaz = { text: '', list: null, loading: false, error: '', asked: false };
    if (box) {
      const q = document.getElementById('places-q');
      if (q) { q.value = ''; q.focus({ preventScroll: true }); }
    }
    clearMark();
  }

  return {
    parse,
    parseSingle,
    readPaste,
    coordRole,
    // Called once from init.js: one listener on the document serves every
    // latitude and longitude box, including ones rendered later.
    bindCoordPaste() { document.addEventListener('paste', onCoordPaste); },
    attribution: ATTRIB,
    paneHtml,
    input,
    key,
    go,
    clear,
    clearMark,

    // The Stations map, as it is built — the place shown is drawn on it again
    // where it was, without moving it: a render of the tab is not somebody
    // asking to go anywhere.
    attach(m) {
      map = m;
      layer = null;
      if (shown && shown.hit) draw(shown.hit, false);
    },

    // …and as it is taken down. The box, the list and the place shown are
    // kept: they are the tool's, and the tool is in the side panel, which
    // outlives the map.
    detach() {
      if (layer) layer.remove();
      layer = null;
      map = null;
    },

    // Read by the checks: what the tool holds.
    debug() {
      return {
        query, coord, flownTo,
        local: local ? { catchments: local.catchments.map(c => c.name), rivers: local.rivers.map(g => g.name), councils: local.councils.map(g => g.name) } : null,
        gaz: { text: gaz.text, loading: gaz.loading, error: gaz.error, n: gaz.list ? gaz.list.length : null },
        shown: shown ? { group: shown.group, n: shown.n, name: shown.hit.name || shown.hit.text, shape: !!shown.hit.shape } : null,
        drawn: layer ? layer.getLayers().length : 0,
      };
    },
  };
})();
if (typeof window !== 'undefined') window.Places = Places;
