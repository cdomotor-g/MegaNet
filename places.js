// MegaNet — places.js
//
//   Places   what the Stations filter box does with text that is not a
//            station: a coordinate, or the name of a town, locality, airport
//            or hill. Parses the first, looks up the second, and takes the map
//            to whichever it was.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, escAttr, stationLatLonText,
// copyLatLonPillHtml and mapViewPills; across to app.js for mapNote. All of it
// from inside its own functions, so this file's position among the modules is
// free.
//
// ── Why this is in the filter box and not a second box beside it ─────────────
// The filter box is where an operator types when they want the map to be
// somewhere. Until now it could only answer with stations, so "Gympie" found
// the four sites with Gympie in their names and "-26.19, 152.66" found
// nothing at all — and the operator went to Google Maps, read a coordinate off
// it and came back. Both of those are the same gesture as far as anybody using
// this is concerned, so they belong in the same box.
//
// Nothing about how stations are filtered changes. The station filter still
// sees the same text and still matches it the same way (name, station number,
// ALERT addresses, windows); this only *adds* an answer under the box when the
// text also means somewhere on the ground. A term that is both — "Gympie" is
// a town and is in four station names — gets both answers at once, which is
// the honest result and the useful one.
//
// ── Coordinates are parsed here, never looked up ─────────────────────────────
// A coordinate is not a search. It is already the answer, and sending it to a
// geocoder to be told what it is would be a network round trip to learn what
// arithmetic knows — and would fail offline, which is exactly where a person
// standing beside a site with a handheld GPS is. So parse() is pure, handles
// the four shapes a coordinate actually arrives in (decimal, decimal with
// hemispheres, degrees-minutes, degrees-minutes-seconds), and an entry that
// is *only* a coordinate moves the map on the spot.
//
// ── The gazetteer ───────────────────────────────────────────────────────────
// Nominatim, OpenStreetMap's own. Keyless, CORS-open, and the only geocoder
// that can be called from a static page with nothing in the repo to leak. Its
// usage policy is the constraint that shapes the code below rather than a
// footnote: at most one request a second, no bulk querying, and results
// cached rather than re-asked. So a lookup is debounced well past a
// keystroke, throttled to the published rate, answered from a cache whenever
// it can be, and never fired at text that is obviously a station number or an
// ALERT address — the box's usual traffic makes no geocoder requests at all.
//
// Failure is quiet and says so: no network, a blocked host or a rate limit
// leaves the station filtering untouched and puts one line under the box. This
// is an extra answer, never the only one.
const Places = (function () {
  const URL_BASE   = 'https://nominatim.openstreetmap.org/search';
  const ATTRIB     = 'Place names © OpenStreetMap contributors (Nominatim)';
  const DEBOUNCE_MS = 650;    // a pause, not a keystroke, before anybody's
                              // geocoder is asked
  const COORD_SETTLE_MS = 250; // …and a shorter one before the map moves to a
                              // typed coordinate; see forRow
  const MIN_RATE_MS = 1100;   // Nominatim's published ceiling is 1/s
  const TIMEOUT_MS  = 12000;
  const MAX_HITS    = 6;
  const MIN_CHARS   = 3;
  const CACHE_MAX   = 120;

  // What counts as a place worth offering. Nominatim's `category` is the OSM
  // key and `type` the value, so this is a whitelist of keys with an optional
  // set of values under each. Everything else — a shop, a house number, a
  // driveway — is dropped: this box is for finding a *locality*, and a list
  // with a bakery in it is a list nobody reads to the bottom of.
  const KINDS = {
    place:    null,   // city, town, village, hamlet, suburb, locality, island…
    aeroway:  new Set(['aerodrome', 'airstrip', 'heliport', 'terminal']),
    boundary: new Set(['administrative']),
    natural:  new Set(['peak', 'bay', 'cape', 'beach', 'volcano']),
    waterway: new Set(['river', 'stream', 'creek']),
    landuse:  new Set(['residential']),
    railway:  new Set(['station', 'halt']),
    amenity:  new Set(['townhall']),
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
    river: 'river', stream: 'creek', creek: 'creek',
    residential: 'residential area', station: 'railway station', halt: 'railway stop',
    townhall: 'town hall',
  };

  const cache = new Map();      // lowercased query → results array (LRU by re-insert)
  let lastAt = 0;               // when the last request went out, for the throttle
  let map = null, marker = null;
  // Per filter entry: what was typed, what came back, and whether a request is
  // out. Keyed by the entry's index, which is what the panel renders by.
  const rows = new Map();
  const timers = new Map();
  let flownTo = null;           // the coordinate the map was last moved to, so a
                                // re-render does not move it again

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
    const raw = String(text || '').trim();
    if (!raw) return null;
    // Strip the labels a coordinate is sometimes pasted with, and normalise the
    // letter form of the symbols — "26d 07m 24s", which is how more than one
    // handheld writes it. The letters are only rewritten when a `d` or `m`
    // marker is actually there, because a bare trailing "s" is South far more
    // often than it is seconds, and reading it as a symbol is what would put a
    // Queensland site in Mongolia. Done here rather than per half, because the
    // halves are found by looking for the hemisphere letters and an "s" that
    // means seconds must be gone before that search runs.
    let s = raw.replace(/\b(lat|latitude|lon|lng|long|longitude)\s*[:=]?\s*/gi, ' ')
               .replace(/[()\[\]]/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
    if (/\d\s*[dm]\b/i.test(s)) {
      s = s.replace(/(\d)\s*d\b/gi, '$1°')
           .replace(/(\d)\s*m\b/gi, "$1'")
           .replace(/(\d)\s*s\b/gi, '$1"');
    }

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

  // ── The gazetteer ───────────────────────────────────────────────────────────

  // Is this worth asking a geocoder about? Station numbers, ALERT addresses,
  // address windows and pasted digit columns are the box's normal traffic and
  // none of them is a place name — sending them would be bulk-querying
  // somebody else's free service with text that cannot match.
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

  // One request, throttled to the published rate and never overlapping. Resolves
  // to a list — never rejects: a failed lookup is a line under the box, not a
  // broken filter panel.
  function ask(q) {
    const key = q.trim().toLowerCase();
    if (cache.has(key)) {
      const hit = cache.get(key);
      remember(key, hit);
      return Promise.resolve({ ok: true, list: hit, cached: true });
    }
    const wait = Math.max(0, MIN_RATE_MS - (Date.now() - lastAt));
    return new Promise(resolve => setTimeout(resolve, wait)).then(() => {
      lastAt = Date.now();
      const params = new URLSearchParams({
        q, format: 'jsonv2', limit: String(MAX_HITS * 3),
        countrycodes: 'au', 'accept-language': 'en',
      });
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      return fetch(`${URL_BASE}?${params}`, { signal: ctl.signal, headers: { Accept: 'application/json' } })
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then(json => {
          const list = (Array.isArray(json) ? json : []).filter(keep).slice(0, MAX_HITS).map(h => {
            const { name, where } = shorten(h);
            return {
              name, where,
              kind: KIND_LABEL[h.type] || String(h.type || '').replace(/_/g, ' '),
              lat: parseFloat(h.lat), lon: parseFloat(h.lon),
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

  // ── On the map ──────────────────────────────────────────────────────────────

  function markerHtml(p) {
    const s = { lat: p.lat, lon: p.lon, name: p.name || p.text };
    return `
      <div class="mn-place-pop">
        <h4>${esc(p.name || 'Coordinate')}</h4>
        <p class="small">${p.kind ? `${esc(p.kind)}${p.where ? ` · ${esc(p.where)}` : ''}<br>` : ''}
          ${esc(stationLatLonText(s))}<br>
          <span class="txt-muted">${p.name ? esc(ATTRIB) : 'Typed into the filter box — not a station.'}</span></p>
        <div class="pill-row">
          ${copyLatLonPillHtml(s)}
          ${mapViewPills(s).join('\n          ')}
        </div>
      </div>`;
  }

  // Drop the one marker — there is never more than one — and go there. Zoom is
  // only raised, never lowered: an operator looking at a whole region who asks
  // where a town is wants the town marked on the view they have, not a jump
  // into the main street.
  function goTo(p, zoom) {
    if (!map) return;
    if (marker) marker.remove();
    marker = L.marker([p.lat, p.lon], {
      title: p.name || p.text,
      icon: L.divIcon({
        className: 'mn-place-icon',
        html: '<span class="mn-place" aria-hidden="true">📍</span>',
        iconSize: [0, 0], iconAnchor: [0, 0],
      }),
      zIndexOffset: 1500,
    }).bindPopup(() => markerHtml(p), { maxWidth: 320 }).addTo(map);
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), zoom || 12));
    marker.openPopup();
    mapNote(`${p.name ? `${p.name} — ` : ''}${stationLatLonText(p)}. Not a station; the pin clears with the filter.`, 7000);
  }

  // ── The strip under one filter entry ────────────────────────────────────────

  function stripHtml(i) {
    const r = rows.get(i);
    if (!r) return '';
    const bits = [];
    if (r.coord) {
      bits.push(`
        <button type="button" class="btn-link mn-place-go" onclick="Places.goToRow(${i}, -1)"
                title="Centre the map on this coordinate">
          📍 <strong>${esc(r.coord.text)}</strong>
          <span class="txt-muted">${r.flown ? 'the map is here' : 'go here'}</span>
        </button>`);
    }
    if (r.loading) bits.push('<span class="small txt-muted">Looking up the place name…</span>');
    else if (r.error) bits.push(`<span class="small txt-warn">Place lookup unavailable — ${esc(r.error)}. Station filtering is unaffected.</span>`);
    else if (r.list && r.list.length) {
      bits.push(r.list.map((h, n) => `
        <button type="button" class="btn-link mn-place-go" onclick="Places.goToRow(${i}, ${n})"
                title="Centre the map on ${escAttr(h.name)}">
          📍 <strong>${esc(h.name)}</strong>
          <span class="txt-muted">${esc(h.kind)}${h.where ? ` · ${esc(h.where)}` : ''}</span>
        </button>`).join(''));
      bits.push(`<span class="small txt-muted">${esc(ATTRIB)}</span>`);
    } else if (r.asked && r.list && !r.list.length) {
      bits.push('<span class="small txt-muted">No town, locality or airport by that name.</span>');
    }
    if (!bits.length) return '';
    // A <span>, not a <div>: this markup is written into the filter panel and
    // into the card's head row, and that row's container is a <span> — only
    // phrasing content may go inside one. The layout is CSS either way.
    return `<span class="search-places-in">${bits.join('')}</span>`;
  }

  // Every strip for this entry, not one: the first entry is drawn twice — once
  // in the filter panel and once in the card's head row, which is the box being
  // typed into while the card is shut (#181). A live strip beside a stale one
  // is worse than no strip at all, which is updateFilterChrome's own rule about
  // the two copies of the clear buttons.
  function paint(i) {
    const html = stripHtml(i);
    for (const el of document.querySelectorAll(`[data-mn-places="${i}"]`)) el.innerHTML = html;
  }

  function lookup(i, text) {
    const r = rows.get(i) || {};
    r.text = text;
    r.loading = true;
    r.error = '';
    r.asked = true;
    rows.set(i, r);
    paint(i);
    const mine = text;
    ask(text).then(res => {
      const cur = rows.get(i);
      if (!cur || cur.text !== mine) return;   // the box moved on while we waited
      cur.loading = false;
      cur.list = res.list;
      cur.error = res.ok ? '' : res.error;
      paint(i);
    });
  }

  return {
    parse,
    attribution: ATTRIB,

    attach(m) { map = m; },

    detach() {
      if (marker) marker.remove();
      marker = null;
      map = null;
      flownTo = null;
    },

    // Every entry's strip, rebuilt after the stack is re-rendered. The state
    // lives here rather than in the DOM, so removing an entry above this one
    // does not lose what the one below it found.
    repaint() { for (const i of rows.keys()) paint(i); },

    // The stack was rebuilt with a different number of entries: anything past
    // the end no longer exists.
    trim(n) {
      for (const i of [...rows.keys()]) if (i >= n) { rows.delete(i); clearTimeout(timers.get(i)); timers.delete(i); }
    },

    // Called from the search box on every keystroke, for the entry being typed
    // in. Coordinates are answered on the spot — no network, works offline —
    // and an entry that is *nothing but* a coordinate takes the map with it,
    // because that is what pasting one into a box is asking for. Everything
    // else waits for a pause and then, only if it looks like a name, asks.
    forRow(i, text) {
      const s = String(text || '').trim();
      const coord = parse(s);
      const prev = rows.get(i) || {};
      const r = { text: s, coord, list: prev.list, asked: prev.asked, loading: false, error: '', flown: false };
      // A different entry's results are not this one's.
      if (prev.text !== s) { r.list = null; r.asked = false; }
      rows.set(i, r);
      clearTimeout(timers.get(i));

      if (coord) {
        paint(i);
        // The strip appears at once — the parse is arithmetic and costs
        // nothing — but the *map* waits for the typing to stop. Typed a
        // character at a time, "-26.1234, 152.5678" is a valid coordinate at
        // "-26.1 152", again at "-26.12 152.5" and so on, and a map that
        // lurches at each of them is a map nobody can read. A paste, which is
        // what this feature is actually for, is one event and moves once.
        const key = `${coord.lat},${coord.lon}`;
        timers.set(i, setTimeout(() => {
          const cur = rows.get(i);
          if (!cur || cur.text !== s) return;
          cur.flown = true;
          paint(i);
          if (flownTo === key) return;
          flownTo = key;
          goTo(coord, 13);
        }, COORD_SETTLE_MS));
        return;
      }
      paint(i);
      if (!askable(s)) return;
      timers.set(i, setTimeout(() => lookup(i, s), DEBOUNCE_MS));
    },

    // A result clicked. -1 is the entry's own parsed coordinate; anything else
    // is an index into what the gazetteer returned for it.
    goToRow(i, n) {
      const r = rows.get(i);
      if (!r) return;
      if (n < 0) { if (r.coord) goTo(r.coord, 13); return; }
      const h = r.list && r.list[n];
      if (h) goTo(h, 12);
    },

    // The filter was cleared: the pin was an answer to a question nobody is
    // asking any more.
    clear() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      rows.clear();
      flownTo = null;
      if (marker) { marker.remove(); marker = null; }
    },
  };
})();
if (typeof window !== 'undefined') window.Places = Places;
