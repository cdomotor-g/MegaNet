// MegaNet — map-survey.js
//
//   MapSurvey   permanent survey marks (PSM), CORS sites and other geodetic
//               control points from the Queensland spatial data platform,
//               drawn over the Stations map for field crews doing a
//               height/levelling check near a site (#120, part of #119).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, `esc` and `stationMapLinkUrls` (the
// Street View link on the callout is the station popup's own, so the URL shape
// is written once); across to app.js for rerenderMapLegend. All of them are
// only called from inside MapSurvey's own functions, so this file's position
// among the modules is free, the same way #133 left it for MapRivers.
//
// The shape below mirrors MapRivers deliberately (#119's own integration
// notes ask for it): bbox rounding, an LRU cache keyed by view, a debounced
// re-fetch on moveend, silent non-blocking failure, and a status note with
// the same five-state vocabulary. Two differences, both because the trigger
// is different: rivers fire off the filter box, survey marks fire off the
// toggle and the current view, so there is no search-term gate here — a
// minimum zoom stands in for it — and there is no repaint() hook, because a
// divIcon marker is styled from styles.css (var(--map-survey)) rather than
// drawn into an SVG with a colour baked in at fetch time, so a theme switch
// repaints it for free.
//
// Each mark's callout carries a launch link to its Survey Control Mark Report
// (#174): a PDF holding the administrative details, the coordinate and AHD
// blocks, the survey connections and — when the mark carries a Form 6 sketch —
// the dimensioned sketch that ties it to the road edge, a fence corner or a
// building. That sketch is the thing a crew actually needs to find the mark on
// the ground, and it is why the link is the first pill on the callout.
//
// The details beside it (mark type, condition, last visit, locality, AHD class
// and order, the free-text remarks) are NOT carried in the bbox query. They are
// fetched for one mark when its callout opens, because the join-prefixed keys
// alone cost ~40 bytes per field per feature and a dense view crosses seven
// sublayers: measured against the live service, the fields this callout reads
// take one 177-mark response from 30 kB to 180 kB, per sublayer, per view — to
// show data for the single mark anybody clicks. So the layer query stays as
// lean as #120 left it and the callout pays for itself.
//
// Pointer interaction is delegated through the map's own click and mousemove,
// hit-tested against the drawn points, for the reason MapRivers' pointer-
// conventions header records as a discovered fact: the shared pins-and-links
// canvas lives in the overlay pane ABOVE this one and owns every DOM event on
// the map, so a tooltip or popup bound to a marker in this pane is bound to
// nothing. The markers are therefore explicitly non-interactive, and the
// hover name and callout ride the map-level hit test instead.
const MapSurvey = (function () {
  // The full survey-control service. Several sublayers (CORS, survey control
  // marks split by datum, AHD heights split by how they were derived,
  // cadastral connection, destroyed marks) — resolved by name at runtime
  // below, never by a guessed numeric id.
  const SERVICE_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Location/SurveyControl/MapServer';
  // The simpler flat point layer the issue names as a fallback starting
  // point. Used when the service above can't be reached or its sublayer
  // names don't match anything recognisable — a real, issue-cited id rather
  // than a guessed sublayer number, which is why it's the fallback and not a
  // hardcoded entry in MARK_NAME/CORS_NAME below.
  const FALLBACK_URL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/FoundationData/FeatureServer/8';
  const ATTRIBUTION  = '© State of Queensland (Department of Resources)';
  // Where a mark's own report lives. The SurveyControl sublayers carry the
  // full URL in a joined field ('…rpt_link.report_url'), which is the one the
  // callout uses when it has it; this base is for deriving the same URL from a
  // mark number when it doesn't — the fallback FeatureServer below publishes
  // mrk_id but no report link at all, and the callout wants a working link
  // before the detail lookup lands. The shape was checked against the live
  // service over 328 marks and CORS sites (Brisbane, plus every CORS site in
  // Queensland): SCR + the mark number left-padded to six digits + '.pdf',
  // matching the joined field exactly every time.
  const REPORT_BASE  = 'https://qspatial.information.qld.gov.au/SurveyReport/';
  // …and the only origin an href on this callout is allowed to point at. The
  // report URL is a value from a third-party service, so it is checked against
  // this rather than trusted into an href; anything else falls back to the
  // derived URL.
  const REPORT_ORIGIN = 'https://qspatial.information.qld.gov.au/';

  const PANE        = 'mnSurvey';
  // Sits between the river pane (340) and the leader lines (350) in the
  // z-index budget MapRivers documents — points drawn over context lines,
  // under anything that has to win a click. #121 (contours) is sequenced
  // after this issue specifically so it can read this line rather than
  // picking a z-index blind; a basemap-context layer like contours belongs
  // *under* the river pane (e.g. 335), not between it and this one.
  const PANE_Z       = 345;
  // Below this, survey marks are a scatter across a region with no use to a
  // field crew (there are thousands in Queensland) — the same "not a
  // meaningful scatter yet" judgement call MapRivers' BBOX_MAX makes for
  // rivers, made on zoom instead because marks aren't filtered by a term.
  const MIN_ZOOM     = 12;
  const DEBOUNCE_MS  = 200;    // moveend settles on its own; this is just a safety margin
  const TIMEOUT_MS   = 20000;
  const BBOX_STEP    = 0.05;   // deg (~5 km) — tighter than rivers' 0.25, points are denser
  const BBOX_MAX     = 3;      // deg — a belt-and-braces backstop behind MIN_ZOOM
  const MAX_MARKS    = 400;    // rendered per view, across every sublayer combined
  const HIT_PX       = 8;      // px around a mark that the map-level hover/click hit-test accepts
  const CACHE_MAX    = 30;
  // One entry per mark clicked, not per view, so this is a much smaller number
  // than CACHE_MAX would suggest: a crew opens a handful of callouts in a
  // session and re-opening one should cost nothing.
  const DETAIL_MAX   = 60;
  const FAIL_TTL     = 60000;
  // How much of the free-text remarks the callout prints before it truncates.
  // Some marks carry a paragraph of visit history and sky obstructions, which
  // at the callout's width is three lines and past that is a wall — the whole
  // of it is on the `title`, and all of it is in the report.
  const NOTE_CHARS   = 120;

  let map = null, layer = null, timer = null, seq = 0, failedAt = 0;
  let resolved = null, resolving = null;   // sublayer resolution — see resolveLayers()
  let drawnKey = null;       // which cache entry is on the map, so a pan is not a redraw
  let drawnPoints = [];      // what draw() put there — the map-level hit test reads these
  let projected = null;      // drawnPoints in layer space, rebuilt on zoom
  let hoverTip = null, cursorSet = false, moveRaf = null;
  let popup = null;          // the open callout, if any — ours to close on clear
  let popupMark = null;      // which mark that callout is about
  const cache = new Map();   // 's,w,n,e' → { points, capped, total }
  // Per-mark detail, keyed by mark number so the same mark costs one lookup no
  // matter which sublayer it was drawn from (a mark with a datum GDA lineage
  // and a levelled AHD lineage is returned by two of them). Only answers are
  // kept: a failed lookup is not cached, so re-opening the callout retries it,
  // which is the right cost for something a person just asked for.
  const detail = new Map();     // mark number → attribute object
  const detailPending = new Map();   // mark number → in-flight promise
  let note = { kind: 'off', drawn: 0, total: 0, capped: false };

  // Field matching, checked against the live service (the spot-check #119
  // asks for). Every attribute on the SurveyControl sublayers arrives
  // join-prefixed — 'sirpub.prop.qld_surveycontrol_scdb.mrk_id',
  // '…scdb.ahdheight' — so the first patterns anchor on the key's *last*
  // segment rather than its start; the broader unanchored ones stay behind
  // them for the fallback layer, whose field names were never captured.
  const REGISTER_KEYS = [/(^|\.)mrk_id$/i, /(^|\.)reg(ister)?[_ ]?no/i, /(^|\.)mark[_ ]?no/i, /(^|\.)psm[_ ]?no/i, /station[_ ]?name/i, /(^|\.)name$/i, /(^|\.)label$/i];
  // The exact live field first, and nothing looser than "ahd height" behind
  // it: the same rows carry 'ahdadj_dt', an epoch-milliseconds adjustment
  // date that a bare /ahd/ numeric pick can land on whenever 'ahdheight' is
  // null — and a date printed as "m AHD" is worse than no height at all.
  const AHD_KEYS       = [/(^|\.)ahdheight$/i, /ahd[_ ]?height/i];

  // What the callout reads once a mark is clicked, in the order it prints
  // them, matched the same way as the two above — on the key's LAST segment,
  // because every attribute on the live joined layers arrives prefixed. Names
  // are the live service's own (checked against /layers on the SurveyControl
  // MapServer and against the Survey Control Mark Report the link opens, whose
  // headings these fields are: "Mark Type", "Mark Condition", "Last Visited",
  // "Locality Description", "Sketch Available", "Related Information").
  //
  // Deliberately short. The service publishes 54 fields per mark and the whole
  // of it is one click away in the report — what earns a place here is what a
  // crew standing at the site needs before they open a PDF on a phone: what
  // the mark physically is, whether it was there last time anyone looked, what
  // street it is on, and whether its height is good enough for the levelling
  // check that brought them.
  const DETAIL_KEYS = {
    report:    /(^|\.)report_url$/i,      // the launch link, straight from the service
    markType:  /(^|\.)mrktype_de$/i,      // STAND, R/INF, "BRASS PLAQUE IN CONC" …
    condition: /(^|\.)mrkcnd_de$/i,       // GOOD / NOT FOUND / DISTURBED / DAMAGED
    lastVisit: /(^|\.)lastvisit_dt$/i,    // epoch ms, UTC midnight of the local date
    locality:  /(^|\.)locality_de$/i,     // 'MUSGRAVE TCE/LLOYD ST-ALDERLEY'
    town:      /(^|\.)town_nm$/i,         // stands in for locality on CORS rows
    altName:   /(^|\.)alt1_nm$/i,         // 'AUSCOPE MLAP', council mark numbers
    sketch:    /(^|\.)form6_fg$/i,        // 'Y' when the report carries a sketch
    ahdClass:  /(^|\.)ahdcls_de$/i,       // 'Class D'
    ahdOrder:  /(^|\.)ahdacc_de$/i,       // '4th ORDER'
    notes:     /(^|\.)relinfo_de$/i,      // visit history, obstructions, what it looks like
  };

  function pickField(attrs, patterns) {
    if (!attrs) return null;
    for (const re of patterns) {
      const k = Object.keys(attrs).find(k => re.test(k));
      if (k && attrs[k] != null && attrs[k] !== '') return String(attrs[k]);
    }
    return null;
  }

  function pickNumericField(attrs, patterns) {
    if (!attrs) return null;
    for (const re of patterns) {
      const k = Object.keys(attrs).find(k => re.test(k) && typeof attrs[k] === 'number');
      if (k) return attrs[k];
    }
    return null;
  }

  // Rounded outward, same trick as MapRivers, so a small pan re-uses the
  // answer it already has rather than re-querying for a near-identical box.
  function roundedBbox(b) {
    const down = v => Math.floor(v / BBOX_STEP) * BBOX_STEP;
    const up   = v => Math.ceil(v / BBOX_STEP) * BBOX_STEP;
    return {
      s: Math.max(-90,  down(b.getSouth())), w: Math.max(-180, down(b.getWest())),
      n: Math.min(90,   up(b.getNorth())),   e: Math.min(180,  up(b.getEast())),
    };
  }

  async function askJson(url) {
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // ArcGIS Server returns its own errors as HTTP 200 with an `error` body.
      if (json && json.error) throw new Error(json.error.message || 'ArcGIS error');
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // Which sublayers to ask, resolved once per page load and cached — the same
  // "probe by name, don't guess an id" shape SoRT's resolveContourLayers()
  // uses for its own contour sublayers (cited by #120). Destroyed marks and
  // the cadastral-connection sublayer are deliberately never queried: #120
  // asks that destroyed marks be excluded or visibly distinguished, and
  // "excluded" is the decision made here (scope item 5); cadastral
  // connections aren't a field-crew benchmark concern and are a stated
  // non-goal on #119.
  function resolveLayers() {
    if (resolved) return Promise.resolve(resolved);
    if (resolving) return resolving;
    resolving = askJson(SERVICE_URL + '/layers?f=json')
      .then(json => {
        const layers = (json && json.layers) || [];
        const mark = [], cors = [], fields = {}, detailFields = {}, idFields = {};
        for (const l of layers) {
          const name = l.name || '';
          // Only real feature layers are worth asking. The service also lists
          // Group Layers ('Survey control marks', 'GDA coordinates') whose
          // names pass the tests below but whose /query endpoint can only
          // answer with a 400 error body — asked anyway, they just burn a
          // request and vanish into the per-sublayer catch.
          if (l.type && l.type !== 'Feature Layer') continue;
          if (/destroyed/i.test(name) || /cadastral/i.test(name)) continue;
          if (/cors/i.test(name)) cors.push(l.id);
          else if (/(gda|control mark|survey control)/i.test(name)) mark.push(l.id);
          else continue;
          // This same metadata lists each layer's fields, and the *bbox* query
          // reads exactly two of the live service's 54 — a register number and
          // an AHD height. Asking only for the names the label patterns would
          // match cuts a dense-area response by an order of magnitude (the
          // join-prefixed keys alone are ~40 characters each). The FULL
          // prefixed names, verbatim: the joined layers refuse short ones.
          // No match, or no metadata (the fallback service), stays '*'.
          const names  = (l.fields || []).map(f => f && f.name).filter(Boolean);
          const wanted = names.filter(n => REGISTER_KEYS.some(re => re.test(n)) || AHD_KEYS.some(re => re.test(n)));
          if (wanted.length) fields[l.id] = wanted.join(',');
          // The same trick again for the one-mark lookup behind a callout —
          // the header's arithmetic is why this list is asked for a single
          // mark and never for a viewport. It carries the bbox fields too, so
          // one response answers the whole callout.
          const extra = names.filter(n => !wanted.includes(n)
                                       && Object.values(DETAIL_KEYS).some(re => re.test(n)));
          if (extra.length) detailFields[l.id] = wanted.concat(extra).join(',');
          // Which field the lookup's WHERE clause names. Taken from the
          // service's own metadata rather than assembled from a prefix, for
          // the reason the sublayer ids are probed rather than guessed.
          const idField = names.find(n => REGISTER_KEYS[0].test(n));
          if (idField) idFields[l.id] = idField;
        }
        if (!mark.length && !cors.length) throw new Error('no recognisable sublayer names');
        resolved = { mode: 'probed', mark, cors, fields, detailFields, idFields };
        return resolved;
      })
      .catch(() => {
        resolved = { mode: 'fallback' };
        return resolved;
      });
    return resolving;
  }

  // Deliberately NO resultRecordCount here. The live SurveyControl feature
  // layers (ArcGIS 11.5, joined tables) answer any query carrying that
  // parameter with an empty feature set — HTTP 200, no error field, nothing
  // for askJson to throw on — so a per-layer cap sent to the server made
  // every mark invisible while the note kept counting the CORS sites, the
  // one sublayer that honours the parameter. Nothing unbounded gets through
  // without it: the server still stops at its own maxRecordCount, and
  // MAX_MARKS caps what run() will draw.
  function queryUrl(base, id, b, outFields) {
    const params = new URLSearchParams({
      f: 'json', where: '1=1',
      geometry:     `${b.w},${b.s},${b.e},${b.n}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      // The probed sublayers pass the two field names the labels actually
      // read (resolveLayers picked them out of the metadata); '*' is only
      // for a service whose fields nobody captured. Five decimal places of
      // geometry is ~1 m — the marks are benchmarks, not centimetre survey.
      outFields: outFields || '*', returnGeometry: 'true',
      geometryPrecision: '5',
    });
    return `${id == null ? base : `${base}/${id}`}/query?${params}`;
  }

  // Esri JSON straight to the {lat, lon, …} shape draw() wants — building an
  // actual GeoJSON object here would only be decomposed right back out for
  // L.marker, so that intermediate step is skipped.
  //
  // `layerId` rides along so a callout can go back to the sublayer this mark
  // came from for its details. And when the response already carries them —
  // the fallback service is asked with outFields '*', so it always does — they
  // are kept on the point itself rather than looked up again: an answer that
  // has already been paid for should not be re-bought because it arrived early.
  function pointsFromEsriJson(json, category, layerId) {
    const out = [];
    for (const f of (json && json.features) || []) {
      const g = f.geometry;
      if (!g || g.x == null || g.y == null) continue;
      out.push({
        lat: g.y, lon: g.x, category, layerId,
        register: pickField(f.attributes, REGISTER_KEYS),
        ahd:      pickNumericField(f.attributes, AHD_KEYS),
        detail:   hasDetail(f.attributes) ? detailFrom(f.attributes) : null,
      });
    }
    return out;
  }

  function queriesFor(layers, b) {
    if (layers.mode === 'fallback') {
      return [{ url: queryUrl(FALLBACK_URL, null, b), category: 'mark', id: null }];
    }
    const fieldsFor = id => layers.fields && layers.fields[id];
    return [
      ...layers.mark.map(id => ({ url: queryUrl(SERVICE_URL, id, b, fieldsFor(id)), category: 'mark', id })),
      ...layers.cors.map(id => ({ url: queryUrl(SERVICE_URL, id, b, fieldsFor(id)), category: 'cors', id })),
    ];
  }

  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  function cachePut(key, v) {
    cache.set(key, v);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // Attribution is added only while marks are actually on the map, not merely
  // while the toggle is — the same "claim it while you're using it" reading
  // the legend entry already applies via active().
  function clearLayer() {
    if (popup) { popup.remove(); popup = null; }
    popupMark = null;
    clearHover();
    drawnKey = null;
    drawnPoints = [];
    projected = null;
    if (!layer) return;
    layer.remove();
    layer = null;
    if (map && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
    rerenderMapLegend();
  }

  // The hover name: the mark number on its own, because that is what the pin
  // is and a floating label has room for nothing else.
  function markLabel(p) {
    return p.register || (p.category === 'cors' ? 'CORS site' : 'Survey mark');
  }

  // The callout's heading, where there IS room to say what the number is. The
  // word is the report's own — its first field is "Mark Number".
  function calloutTitle(p) {
    if (!p.register) return p.category === 'cors' ? 'CORS site' : 'Survey mark';
    return `${p.category === 'cors' ? 'CORS' : 'Mark'} ${p.register}`;
  }

  // ── One mark's own detail ────────────────────────────────────────────────
  // Fetched when a callout opens, never for a viewport — see the header for
  // the arithmetic. Everything below is about one mark at a time.

  // Does this row carry detail at all? The mark-type field is the test: it is
  // published by both services, read by the callout, and never asked for by
  // the bbox query — so its presence means "this row came from somewhere that
  // answered with everything", and its absence means the callout still has a
  // lookup to do. Testing the *key* rather than a value, because a mark with
  // no recorded type is still a row that was answered in full.
  function hasDetail(attrs) {
    return !!attrs && Object.keys(attrs).some(n => DETAIL_KEYS.markType.test(n));
  }

  // DETAIL_KEYS applied to a row, keeping only what is actually there.
  // Normalised at the door rather than at render time so what is held onto is
  // a dozen short strings and not the 54-field row they arrived in.
  function detailFrom(attrs) {
    const out = {};
    const names = Object.keys(attrs || {});
    for (const k of Object.keys(DETAIL_KEYS)) {
      const n = names.find(n => DETAIL_KEYS[k].test(n));
      const v = n == null ? null : attrs[n];
      if (v != null && v !== '') out[k] = v;
    }
    return out;
  }

  // What the callout knows about this mark right now: what its own row came
  // with (the fallback service answers with '*', so there it is always
  // everything), else whatever a previous callout looked up. Null means the
  // lookup has not happened yet.
  function markDetail(p) {
    return (p && p.detail) || (p && p.register ? detail.get(p.register) || null : null);
  }

  // The one-mark lookup, or null when this mark cannot be looked up — no
  // probed sublayer behind it, no id field in the service's metadata, or a
  // mark number that is not a mark number.
  function detailUrl(layers, p) {
    if (!layers || layers.mode !== 'probed' || p.layerId == null) return null;
    const idField = layers.idFields && layers.idFields[p.layerId];
    if (!idField) return null;
    // Digits and nothing else go into the WHERE clause, checked here, so
    // there is no quoting question to get wrong. Every mark number the live
    // service returned across the sample was of this shape.
    if (!/^\d+$/.test(p.register || '')) return null;
    const params = new URLSearchParams({
      f: 'json',
      where: `${idField}='${p.register}'`,
      outFields: (layers.detailFields && layers.detailFields[p.layerId]) || '*',
      returnGeometry: 'false',
    });
    return `${SERVICE_URL}/${p.layerId}/query?${params}`;
  }

  // Resolves to the detail object, or to null when there is none to be had.
  // Never rejects: a callout that cannot fill itself in says so and keeps the
  // report link, which is the part that matters.
  function loadDetail(p) {
    const have = markDetail(p);
    if (have) return Promise.resolve(have);
    const key = p.register;
    if (!key) return Promise.resolve(null);
    if (detailPending.has(key)) return detailPending.get(key);
    const job = resolveLayers()
      .then(layers => {
        const url = detailUrl(layers, p);
        if (!url) return null;
        return askJson(url).then(json => {
          const features = (json && json.features) || [];
          if (!features.length) return null;
          const d = detailFrom(features[0].attributes);
          detail.set(key, d);
          while (detail.size > DETAIL_MAX) detail.delete(detail.keys().next().value);
          return d;
        });
      })
      .catch(() => null)
      .then(d => { detailPending.delete(key); return d; });
    detailPending.set(key, job);
    return job;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // The service's dates are epoch milliseconds at UTC midnight of the day the
  // report prints: 1698969600000 against mark 43906's "Last Visited
  // 03-Nov-2023". Read back in UTC for exactly that reason — a local-time read
  // west of Greenwich would print the day before the report does.
  function fmtDate(v) {
    if (typeof v !== 'number' || !isFinite(v)) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  // The mark's report. The service's own link when there is one and it points
  // where it should — an href is not the place to trust a third party's
  // string — and otherwise the same URL derived from the mark number, which
  // is what the fallback service's marks and every callout opened before its
  // lookup lands are left with.
  function reportUrl(p, d) {
    const given = d && d.report;
    if (typeof given === 'string' && given.startsWith(REPORT_ORIGIN)) return given;
    return /^\d+$/.test(p.register || '')
      ? `${REPORT_BASE}SCR${String(p.register).padStart(6, '0')}.pdf`
      : null;
  }

  // Free text off the service. The remarks arrive as a paragraph of run-on
  // visit history with the line breaks of whatever screen they were typed on,
  // so they are collapsed to one line before anything else happens to them —
  // the whole of that line rides on the element's title, and `clip` is what
  // goes on screen. All of it is in the report either way.
  function collapse(v) {
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function clip(t) {
    return t.length > NOTE_CHARS ? `${t.slice(0, NOTE_CHARS - 1).trimEnd()}…` : t;
  }

  function draw(points, key) {
    clearLayer();
    drawnKey = key || null;
    if (!map || !points.length) return;
    layer = L.layerGroup().addTo(map);
    if (map.attributionControl) map.attributionControl.addAttribution(ATTRIBUTION);
    for (const p of points) {
      const isCors = p.category === 'cors';
      const icon = L.divIcon({
        className: 'mn-survey-div',
        html: `<div class="mn-survey-pin ${isCors ? 'mn-survey-cors' : 'mn-survey-mark'}"></div>`,
        iconSize:   isCors ? [14, 13] : [10, 9],
        iconAnchor: isCors ? [7, 10]  : [5, 7],
      });
      // Explicitly non-interactive, with nothing bound to the marker: the
      // shared pins-and-links canvas above this pane owns every DOM event on
      // the map (the header, and MapRivers' pointer conventions), so a
      // tooltip or popup bound here would be unreachable. The hover name and
      // the callout ride the map-level hit test below instead.
      L.marker([p.lat, p.lon], { pane: PANE, icon, interactive: false, keyboard: false }).addTo(layer);
    }
    drawnPoints = points;
    reproject();
    rerenderMapLegend();
  }

  // ── Delegated hover and callout — MapRivers' pattern, on points ───────────
  // Layer points survive a pan and change on zoom, so zoomend is the one
  // reprojection trigger, exactly as in map-rivers.js. Points are cheaper
  // than polylines: nearest drawn mark within HIT_PX, no bounding boxes.

  function reproject() {
    projected = null;
    if (!map || !drawnPoints.length) return;
    projected = drawnPoints.map(p => ({ p, pt: map.latLngToLayerPoint([p.lat, p.lon]) }));
  }

  function markAtPoint(layerPt) {
    if (!projected) return null;
    let best = null, bestD = HIT_PX * HIT_PX;
    for (const m of projected) {
      const dx = m.pt.x - layerPt.x, dy = m.pt.y - layerPt.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = m.p; }
    }
    return best;
  }

  function clearHover() {
    if (hoverTip) { hoverTip.remove(); hoverTip = null; }
    if (cursorSet && map) { map.getContainer().style.cursor = ''; cursorSet = false; }
  }

  // The callout. `status` is where the one-mark lookup has got to — 'ok' once
  // it has landed (or was never needed), 'loading' while it is out, 'fail'
  // when it came back with nothing. Only the middle block moves: the heading,
  // the coordinates and the report link are all built from what drawing the
  // mark already knew, so the callout is never empty and never waits to be
  // useful.
  function calloutHtml(p, status) {
    const d       = markDetail(p) || {};
    const isCors  = p.category === 'cors';
    const kind    = isCors ? 'CORS site' : 'Survey control mark';
    const where   = d.locality || d.town;
    const visited = fmtDate(d.lastVisit);
    const grade   = [d.ahdClass, d.ahdOrder].filter(Boolean).join(' / ');
    const url     = reportUrl(p, d);
    const links   = stationMapLinkUrls({ lat: p.lat, lon: p.lon, name: calloutTitle(p) });
    const line    = (html, cls) => `<span class="mn-pop-line${cls ? ' ' + cls : ''}">${html}</span><br>`;
    const out = [`<strong>${esc(calloutTitle(p))}</strong><br>`];

    // What it is, and — once known — what it physically is. 'STAND', 'R/INF',
    // 'BRASS PLAQUE IN CONC': the difference between looking for a lid at
    // ground level and looking at a wall.
    out.push(line(esc(kind + (d.markType ? ` · ${d.markType}` : ''))));
    if (where)      out.push(line(esc(where)));
    if (d.altName)  out.push(line(`Also ${esc(d.altName)}`));
    out.push(line(`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`));
    // The height and how far it can be trusted, together — a benchmark's
    // class and order are the whole question in a levelling check.
    if (p.ahd != null) out.push(line(esc(`${p.ahd} m AHD${grade ? ` · ${grade}` : ''}`)));
    // Whether it was still there the last time anybody looked. A mark last
    // visited in 1998 and a mark recorded NOT FOUND are both worth knowing
    // before driving out to it.
    if (d.condition || visited) {
      out.push(line(esc([d.condition, visited && `last visited ${visited}`]
        .filter(Boolean).join(' · '))));
    }
    if (d.notes) {
      const notes = collapse(d.notes);
      out.push(line(`<span title="${esc(notes)}">${esc(clip(notes))}</span>`, 'txt-muted'));
    }
    if (status === 'loading') out.push(line('Looking up mark details…', 'txt-muted'));
    if (status === 'fail')    out.push(line('Mark details unavailable.', 'txt-muted'));

    // The links, as the row of pills every other callout in the app ends with
    // (#170). The report first: it is the reason this callout exists.
    const pills = [];
    if (url) {
      const sketch = d.sketch === 'Y';
      const what = 'The Queensland Survey Control Mark Report for this mark — administrative detail,'
        + ' GDA2020 and AHD blocks, survey connections'
        + (sketch ? ', and the Form 6 sketch dimensioning the mark to what is around it' : '');
      pills.push(`<a class="pill" href="${esc(url)}" target="_blank" rel="noopener"
         title="${esc(what)}">Mark report (PDF${sketch ? ', with sketch' : ''}) ↗</a>`);
    }
    if (links) {
      pills.push(`<a class="pill" href="${esc(links.google)}" target="_blank" rel="noopener"
         title="Opens the nearest Google Street View panorama; sites with no coverage open the map at this location instead"
         >Google Street View ↗</a>`);
    }
    if (pills.length) out.push(`<div class="mn-popup-actions pill-row">${pills.join('\n')}</div>`);
    return out.join('\n');
  }

  function openCallout(p) {
    if (popup) { popup.remove(); popup = null; }
    popupMark = p;
    let status = markDetail(p) ? 'ok' : 'loading';
    // Content as a function, not a string: when the lookup lands, Leaflet's
    // own popup.update() calls it again and re-lays-out and re-positions the
    // callout in one step. Writing into the open popup's DOM instead would be
    // undone by the next update() Leaflet does for its own reasons.
    popup = L.popup({ maxWidth: 300, minWidth: 240 })
      .setLatLng([p.lat, p.lon])
      .setContent(() => calloutHtml(p, status))
      .openOn(map);
    if (status === 'ok') return;
    loadDetail(p).then(d => {
      // Only if this is still the callout that asked. A second click before
      // the first lookup returns is the ordinary case, not the exotic one.
      if (popupMark !== p || !popup || !popup.isOpen()) return;
      status = d ? 'ok' : 'fail';
      popup.update();
    });
  }

  function onMapClick(e) {
    if (!layer) return;
    if (state.draw.tool) return;                    // an armed draw tool owns the click
    if (state.link && state.link.picking) return;   // so does a link-budget pick
    const p = markAtPoint(e.layerPoint);
    if (!p) return;
    openCallout(p);
  }

  function onMapMove(e) {
    if (!layer || moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      if (!map || !layer) return;
      const p = state.draw.tool ? null : markAtPoint(e.layerPoint);
      if (!p) { clearHover(); return; }
      map.getContainer().style.cursor = 'pointer';
      cursorSet = true;
      // Anchored on the mark itself rather than the pointer, so the name
      // floats over the pin the way the old marker-bound tooltip meant to.
      if (!hoverTip) {
        hoverTip = L.tooltip({ className: 'mn-survey-label', direction: 'top',
                               offset: [0, -10], interactive: false })
          .setContent(esc(markLabel(p))).setLatLng([p.lat, p.lon]).addTo(map);
      } else {
        hoverTip.setLatLng([p.lat, p.lon]).setContent(esc(markLabel(p)));
      }
    });
  }

  // Only what the viewport actually shows counts as "in view". The fetch's
  // bbox is rounded outward up to BBOX_STEP (~5 km) past the screen edges,
  // and counting everything fetched let the note claim "1 mark in view"
  // while the one mark sat in that off-screen margin — the most confusing
  // face of the invisible-marks bug. The off-screen points still draw, so a
  // small pan reveals them without a refetch; they just aren't counted.
  function inViewCount(points) {
    if (!map) return 0;
    const b = map.getBounds();
    let n = 0;
    for (const p of points) if (b.contains([p.lat, p.lon])) n++;
    return n;
  }

  function setNote(kind, entry) {
    note = {
      kind,
      drawn:  entry ? inViewCount(entry.points) : 0,
      total:  entry ? entry.total : 0,
      capped: !!(entry && entry.capped),
    };
    const el = document.getElementById('map-survey-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':     return 'Survey marks are hidden.';
      case 'zoom':    return 'Zoom in to look up survey marks — this view is too wide to ask for.';
      case 'loading': return 'Looking up survey marks…';
      case 'fail':    return 'Survey marks unavailable — the Queensland spatial data service could not be reached.';
      case 'ok':
        if (!note.drawn) return 'No survey marks in view.';
        return `<strong>${note.drawn}</strong> mark${note.drawn === 1 ? '' : 's'} in view` +
               (note.capped ? ` · more in view not drawn` : '') + '.';
      default:        return '';
    }
  }

  function run() {
    if (!state.mapSurvey) { clearLayer(); setNote('off'); return; }
    if (!map) return;
    if (map.getZoom() < MIN_ZOOM) { clearLayer(); setNote('zoom'); return; }
    const b = roundedBbox(map.getBounds());
    if (b.n - b.s > BBOX_MAX || b.e - b.w > BBOX_MAX) { clearLayer(); setNote('zoom'); return; }

    const key = [b.s, b.w, b.n, b.e].map(v => v.toFixed(2)).join(',');
    const hit = cacheGet(key);
    if (hit) {
      // A pan inside the same rounded bbox is not a redraw (MapRivers' A2
      // shortcut): the marks on screen already are this entry, so only the
      // note's in-view count moves. This is also what lets a callout's
      // auto-pan survive — tearing the layer down here would take the open
      // popup with it on the very moveend that opened it.
      if (key !== drawnKey || !layer) draw(hit.points, key);
      setNote('ok', hit);
      return;
    }
    if (Date.now() - failedAt < FAIL_TTL) { clearLayer(); setNote('fail'); return; }

    const mine = ++seq;
    setNote('loading');
    resolveLayers().then(layers => {
      if (mine !== seq || !map) return;
      const queries = queriesFor(layers, b);
      return Promise.all(queries.map(q =>
        askJson(q.url).then(json => pointsFromEsriJson(json, q.category, q.id)).catch(() => null)
      )).then(results => {
        if (mine !== seq || !map) return;
        // One bad sublayer doesn't sink the rest; every sublayer failing does.
        if (results.every(r => r === null)) throw new Error('every sublayer query failed');
        const all = results.filter(Boolean).flat();
        const capped = all.length > MAX_MARKS;
        const entry = { points: capped ? all.slice(0, MAX_MARKS) : all, capped, total: all.length };
        cachePut(key, entry);
        draw(entry.points, key);
        setNote('ok', entry);
      });
    }).catch(() => {
      if (mine !== seq || !map) return;
      failedAt = Date.now();
      clearLayer();
      setNote('fail');
    });
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      m.on('moveend', sync);
      // The delegated interaction — see the header for why the markers
      // themselves cannot take these. Same trio as MapRivers.attach().
      m.on('click', onMapClick);
      m.on('mousemove', onMapMove);
      m.on('zoomend', reproject);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
      if (map) {
        map.off('moveend', sync);
        map.off('click', onMapClick);
        map.off('mousemove', onMapMove);
        map.off('zoomend', reproject);
      }
      clearLayer();
      map = null;
      seq++;
    },

    sync,

    // Does the legend claim a survey-mark key right now? Same gate MapRivers
    // uses for its own legend entry.
    active() { return !!layer; },

    noteHtml,

    // Not persisted to localStorage, unlike MapRivers. This is a specialist
    // layer (a field crew checking a benchmark near a site) rather than
    // something most sessions want on; off-by-default-every-visit is one
    // click to undo and keeps "no extra requests fire with the layer off"
    // true of a fresh page load without having to reason about a remembered
    // on-state.
    setEnabled(on) {
      state.mapSurvey = on;
      if (!on) { clearTimeout(timer); clearLayer(); setNote('off'); return; }
      setNote(map && map.getZoom() >= MIN_ZOOM ? 'loading' : 'zoom');
      sync();
    },
  };
})();
