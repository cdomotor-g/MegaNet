// MegaNet — site-exposure.js
//
//   SiteExposure   What the water and the ground around a station are likely
//                  to do to whatever is built there: whether it stands in or
//                  near tidal water, where the Water Act says the nearest
//                  stream stops being a watercourse, whether it is in the
//                  coastal management district, the erosion prone 40 m from
//                  HAT or a storm tide area, and what Queensland's acid
//                  sulfate soil mapping says about the ground under it — asked
//                  of the Queensland Government's own map services when a
//                  station's card opens, and set beside the tide levels the
//                  station's own record already carries. A section on the
//                  station card, flagged indicative throughout.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr, termHtml, acmaHaversineKm and announce,
// across to river-details.js for RiverDetails.currentSurvey and to app.js for
// docUrl — all only from inside its own functions, so this file's position
// among the modules is free (`npm run toplevel`). One file reaches into it:
// app.js, whose stnCardHtml() places the section and whose repaintStnCard()
// calls ask().
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Asked for in these words: "Tidal limits and acid sulphate soil info on
// stations cards to inform remediation infrastructure choices. Users may like
// to know what kind of salinity etc a site will be exposed to." A gauge post, a
// mast footing, an earth stake and a cabinet plinth all go into the ground at a
// site somebody chose for the river, not for the soil — and on this coast two
// of the things most likely to eat them are salt water and acid sulfate soil.
// Neither was anywhere in the app. Both are mapped by the State, for free, on
// the same ArcGIS platform the cadastre, the contours and the survey marks
// already come from.
//
// ── The sources ─────────────────────────────────────────────────────────────
// One host, spatial-gis.information.qld.gov.au, keyless, and its CORS reflects
// the Origin — `null` for file:// included — so the page asks it directly, as
// map-roads.js does. Each layer is asked with a point `query`: does anything
// here intersect this point (or come within a distance of it)? Measured 28
// September 2026, a point query answers in about a second.
//
//   Boundaries/AdministrativeBoundaries/1       local government areas — "is
//                                               this Queensland at all?"
//   Environment/Fisheries/15                    tidal waterways (DAF, 2023)
//   Boundaries/AdminBoundariesFramework/199     the highest astronomical tide
//                                               line (Department of Resources)
//   InlandWaters/WatercourseIdentificationMap/200  Water Act 2000 downstream
//                                               limits
//   PlanningCadastre/CoastalManagement/5        coastal management district
//                                     /9        erosion prone area, 40 m from HAT
//                                     /11, /12  storm tide, high and medium hazard
//                                     /13       where the storm tide mapping has
//                                               no LiDAR under it
//   GeoscientificInformation/SoilsAndLandResource/1902, 1952, 2002
//                                               acid sulfate soils at 1:25 000,
//                                               1:50 000 and 1:100 000
//                                    /2052      the national Atlas of Australian
//                                               Acid Sulfate Soils (CSIRO 2011),
//                                               as Queensland serves it
//                                    /1850      acid sulfate soil sample sites
//   Oceans/CoastalWaters/17                     the coastline (mean high water;
//                                               river mouths closed off) — for
//                                               the corrosivity rows
//
// and one file of this site's own, data/surf-coast.json: the stretches of that
// coastline facing open ocean swell (see "Atmospheric corrosivity" below).
//
// Every one is CC BY — 4.0 for all but the acid sulfate soils series, which
// data.qld.gov.au lists as CC BY 3.0 AU — and the card's "Sources and limits"
// names each with its custodian, which is the attribution the licence asks for.
// docs/site-exposure.md has the table with the links.
//
// Layer ids are fixed, not resolved by name the way map-roads.js resolves its
// one layer: that would be six probes of six services' descriptions, half as
// much again on the first card. What stops a renumbered layer from quietly
// answering the wrong question is that every feature query names its fields —
// a layer without them is an ArcGIS error, and an error is a row that says it
// could not be read.
//
// ── Queensland only, and said so ────────────────────────────────────────────
// The network is national and these are Queensland's maps: they stop at the
// border. Asked about a point in New South Wales every layer answers "nothing
// here", and a card that printed that as "not in tidal water, no acid sulfate
// soil" would be claiming findings nobody made. So the first question is
// coverage, and a station outside it says so in words:
//
//   * outside Queensland's extent (a box a little larger than the State): no
//     request at all — that is most of the network outside the Brisbane hub;
//   * inside a Queensland local government area, or within 50 m of a mapped
//     Queensland tidal waterway: covered. The second catches the gauge in a
//     river channel or on a jetty — Brisbane's LGA stops at the high-water
//     mark on both banks of its river, and every LGA stops at the shore;
//   * neither, but within 1 km of a Queensland LGA: the shore, just offshore
//     or just across the border (Tweed Heads is under 1 km from Coolangatta).
//     Answered, with a line saying that the layers stop at the border;
//   * otherwise: not Queensland, or offshore of its mapped land and water.
//
// ── What a row can say ──────────────────────────────────────────────────────
// Three things, and never a fourth: an answer, "asking…", or "could not be
// read" with the source named and why. A request that failed is never shown
// as "none" — that is the failure this section is most at risk of, because an
// empty answer and an unanswered question look the same to a template. The
// same goes for mapping that does not reach a point: "not mapped here" is
// said as that, and not as "no acid sulfate soil".
//
// The acid sulfate soil row takes the finest map that covers the point and
// quotes it in its own words (map_code_meaning — there are well over a hundred
// codes, and the words are the only reading of them the State publishes). The
// national atlas is always reported beside it, but Queensland's copy is
// clipped where a finer map exists and to land below 20 m, so a missing
// national polygon is explained, never read as a finding.
//
// ── What it costs ───────────────────────────────────────────────────────────
// Staged, so a station asks only what can matter to it: coverage first (two
// requests, three at the edge), then the four soil maps and — out of tidal
// water — the three distance bands to the highest-tide line, then, only with
// that line within 10 km, the Water Act limits, the four coastal hazard layers,
// the sample sites and the coastline (eight). Fourteen to eighteen requests for
// a coastal station, nine or ten inland, none outside Queensland, and this
// site's own surf beaches file once a page. Every one but the coastline is a
// count or a handful of attributes (the largest measured, the 113 sample sites
// within 2 km of Cairns Harbour, is 38 KB); the coastline, generalised to
// ~10 m, is a few to thirty kilobytes. At most IN_FLIGHT at once across the
// whole app, each given TIMEOUT_MS; a card that moves to another station drops
// the old one's queue.
//
// Answers are kept for the session per position (rounded to ~10 m), layer by
// layer, so a second open of a card asks nothing and a repaint is free. A
// layer that failed is not asked again for FAIL_TTL, Elvis's rule and for its
// reason — a blocked host costs one slow failure a minute, not one per click —
// and "Try again" on the card clears that and asks at once.
//
// ── Atmospheric corrosivity (AS 4312) ───────────────────────────────────────
// How corrosive the air is to steel and its coatings, which is mostly how far
// the sea is and how rough: AS 4312:2019's grade, C1 (very low) to CX
// (extreme), read off its Table 4.1 by the distance to the shoreline for each
// kind of shore, the highest of them; and OTE's grouping of those grades into
// three categories, each with its materials for a station's tower, enclosure
// and orifice run (OTE's instruction, November 2026 — rounded to 100 m, 1 km and
// 10 km, stricter than the table in places, never less). Both are copied from
// the SoRT Scope Builder, where the forum chooses materials with them
// (cdomotor-g/SoRT, v2/definitions.json guides.corrosion), and so is
// data/surf-coast.json (SoRT's v2/data/surf-coast.json, made from the coastline
// layer by its v2/tools/build-surf-coast.mjs: Point Danger to Agnes Water, the
// ocean beaches of the sand islands, Coolangatta's north-facing bays). atlas.json
// carries the link, so the Atlas says when SoRT's copy moves on.
//
// The distances: to a surf beach from that file, for every station (no
// request); to any other shore from the Coastline layer within COAST_M, only
// where the highest-tide line is within 10 km — the coastline cannot be nearer
// than that line, and beyond 10 km every sheltered shore is C2 on the table.
// The coastline and not the HAT line, because the HAT line runs up the tidal
// rivers (Jindalee is 4 m from it) and a riverbank 20 km from the sea is not
// what salts the air. North of the Tropic of Capricorn a shore is "tropical
// quiet", south of it "temperate semi-sheltered" — the stricter of the
// standard's two sheltered kinds, since nothing here tells a bay from a basin.
//
// ── What is deliberately not here ───────────────────────────────────────────
// A prescription. The summary under the rows says what the maps add up to in
// plain words, with the State's own sentences behind the soil one, and stops
// there: which concrete, which coating, which footing is a design decision on
// a site investigation, and the card says so every time.
const SiteExposure = (function () {
  const HOST = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services';

  // Measured at one to two seconds a query; the ceiling is map-roads.js's,
  // generous because the alternative to waiting is a row that says nothing,
  // bounded because a network that denies the host must not hold the card
  // open (see docs/floodwarning-net.md).
  const TIMEOUT_MS = 20000;
  // Across the whole app, not per card: a government map server shared with
  // everybody else in the State is owed some manners.
  const IN_FLIGHT  = 4;
  const FAIL_TTL   = 60000;
  const CACHE_MAX  = 64;
  // Four decimal places is ~11 m of latitude — finer than any of these maps
  // resolves, coarser than two stations that share a site.
  const KEY_DP     = 4;

  const IN_TIDAL_M   = 50;      // "in tidal water": a gauge's coordinate is often tens of metres out
  const EDGE_M       = 1000;    // "just off Queensland's mapped land"
  const LIMIT_M      = 20000;   // how far to look for a Water Act downstream limit
  const SITE_M       = 2000;    // how far to look for an acid sulfate soil sample site

  // How far the highest-tide line is, as a band rather than a figure: three
  // count-only questions ("any of it within 100 m? 1 km? 10 km?"), asked
  // together, a few hundred bytes each. The figure would need the line's
  // geometry, and measured on a mangrove coast that is ~200 KB within 2 km
  // even generalised to 50 m (Cairns, Mourilyan, Townsville) — for a distance
  // whose useful reading is "at the water's edge, near it, or not".
  //
  // The line and not the tidal waterways' polygons, because the polygons are
  // estuaries and creeks and stop at the coast: a beach-front station read 3.7
  // km from "tidal water" and a harbour tide gauge 0.9 km. The line follows the
  // open coast and the tidal reaches of the rivers alike (Jindalee, 20 km up
  // the Brisbane River, is 4 m from it).
  const HAT_BANDS = [['hat100', 100], ['hat1k', 1000], ['hat10k', 10000]];

  // ── Atmospheric corrosivity: the standard's table and OTE's categories ────
  // Copied from SoRT's v2/definitions.json guides.corrosion (see the header);
  // change them there first.
  const COAST_M    = 11000;       // the widest distance any kind of shore matters within (10 km), and a margin
  const SURF_TOL_M = 40;          // a piece of the coastline this near a surf stretch is that beach
  const TROPIC_LAT = -23.44;      // the Tropic of Capricorn: tropical quiet north of it
  const SURF_URL   = 'data/surf-coast.json';
  const SHORES = {
    surf:            { label: 'surf beach',               a: 'a surf beach' },
    temperate_semi:  { label: 'semi-sheltered shore',     a: 'a semi-sheltered shore' },
    tropical_quiet:  { label: 'tropical quiet shore',     a: 'a tropical quiet shore' },
    temperate_quiet: { label: 'quiet shore',              a: 'a quiet shore' },
  };
  // AS 4312:2019 Table 4.1 — the grade in each distance band (the upper edge,
  // in metres) for each kind of shore. "C3*": C2 where the site is more than
  // 50 m above sea level and more than 5 km from the shoreline.
  const AS4312 = {
    edges: [50, 100, 500, 1000, 10000, 100000],
    bands: ['0–50 m', '50–100 m', '100–500 m', '0.5–1 km', '1–10 km', '10–100 km'],
    grades: {
      temperate_quiet: ['C4', 'C3', 'C3', 'C3', 'C2', 'C2'],
      temperate_semi:  ['C5', 'C4', 'C4', 'C3', 'C3*', 'C2'],
      tropical_quiet:  ['CX', 'CX', 'C5/C4', 'C3', 'C2', 'C2'],
      surf:            ['CX', 'CX/C5', 'C5', 'C4', 'C3', 'C3*'],
    },
    beyond: 'C2',      // further than 100 km — "most areas of Australia at least 50 km from the coast"
  };
  // The grades, as the standard describes them (its section 3.2).
  const GRADES = {
    C1: ['very low', 'Inside heated or air-conditioned buildings with clean air; some semi-sheltered places far from the sea or industry.'],
    C2: ['low', 'Dry, rural areas and other areas remote from the coast or pollution — most of Australia at least 50 km from the coast.'],
    C3: ['medium', 'Mainly coastal areas with low salinity.'],
    C4: ['high', 'Mainly on the coast.'],
    C5: ['very high', 'Normally 50 m to 500 m inland from coasts exposed to surf or very rough seas.'],
    CX: ['extreme', 'Offshore structures, and within 50 m inland of coasts exposed to surf or very rough seas.'],
  };
  const GRADE_RANK = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5, CX: 6 };
  // OTE's three categories, most severe first: the distance within which each
  // kind of shore puts a station in it.
  const OTE = [
    { cat: 'C5 and CX', materials: 'all stainless — a stainless steel tower, enclosure and orifice run',
      within: { temperate_semi: 100, tropical_quiet: 1000, surf: 1000 } },
    { cat: 'C4', materials: 'a standard galvanised tower, with a stainless steel enclosure and orifice run',
      within: { temperate_quiet: 100, temperate_semi: 1000, surf: 10000 } },
  ];
  const OTE_ELSE = { cat: 'C3 and below',
    materials: 'standard — a galvanised tower, aluminium enclosure and galvanised orifice run (a stainless orifice run in a polluted river)' };
  // Which of OTE's categories a grade of the standard's falls in.
  const oteOf = g => (GRADE_RANK[g] >= 5 ? 'C5 and CX' : GRADE_RANK[g] === 4 ? 'C4' : 'C3 and below');
  const OTE_RANK = { 'C3 and below': 0, C4: 1, 'C5 and CX': 2 };

  // Queensland's extent, from the State's own layers and rounded outward: its
  // mainland runs from 138.0° to 153.55° east and down to 29.2° south, and the
  // Torres Strait islands to 9.2°. Outside this nothing is asked.
  const QLD_BOX = { w: 137.9, e: 153.7, s: -29.3, n: -9.0 };

  // ── The datasets, as the card names them ─────────────────────────────────
  // `name` is what a failure line and the sources list say; `by` is the
  // custodian as the layer's own copyright text gives it; `page` is where the
  // dataset and its licence are published.
  const SOURCES = {
    lga: {
      name: 'Queensland’s local government areas',
      title: 'Local government area boundaries — Queensland',
      by: 'State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development)',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/local-government-area-boundaries-queensland',
    },
    tidal: {
      name: 'the tidal waterways map',
      title: 'Queensland waterways for waterway barrier works — tidal',
      by: 'State of Queensland (Department of Agriculture and Fisheries), 2023',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/queensland-waterways-for-waterway-barrier-works-tidal',
    },
    hat: {
      name: 'the highest astronomical tide line',
      title: 'Highest astronomical tide — Queensland (Geographic features series)',
      by: 'State of Queensland (Department of Resources), 2023',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/geographic-features-queensland-series',
    },
    limit: {
      name: 'the Water Act watercourse map',
      title: 'Watercourse identification map — downstream limits (Water Act 2000)',
      by: 'State of Queensland (Department of Natural Resources, Mines and Energy), 2019',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/watercourse-identification-map-queensland-series',
    },
    cmd: {
      name: 'the coastal management district',
      title: 'Coastal management district',
      by: 'Queensland Government (Department of Environment and Science), 2018',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/coastal-plan-series',
    },
    epa: {
      name: 'the erosion prone area (40 m from HAT)',
      title: 'Erosion prone area — component 1, 40 m from highest astronomical tide',
      by: 'Queensland Government (Department of Environment and Science), 2018',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/erosion-prone-area-series',
    },
    storm: {
      name: 'the storm tide hazard map',
      title: 'Storm tide — high and medium hazard areas',
      by: 'Queensland Government (Department of Environment and Science), 2018',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/storm-tide-queensland-series',
    },
    ass: {
      name: 'Queensland’s acid sulfate soil maps',
      title: 'Acid sulfate soils series — 1:25 000, 1:50 000 and 1:100 000',
      by: 'State of Queensland (Department of Environment and Science), 2020',
      licence: 'CC BY 3.0 AU',
      page: 'https://www.data.qld.gov.au/dataset/acid-sulfate-soils-series',
    },
    atlas: {
      name: 'the national acid sulfate soils atlas',
      title: 'Atlas of Australian Acid Sulfate Soils (Fitzpatrick, Powell & Marvanek), as Queensland serves it',
      by: 'CSIRO, 2011',
      licence: 'CC BY 4.0',
      page: 'https://doi.org/10.4225/08/512E79A0BC589',
    },
    coast: {
      name: 'the Queensland coastline',
      title: 'Coastline — Queensland',
      by: 'State of Queensland (Department of Natural Resources and Mines), 2017',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/coastline-queensland',
    },
    surf: {
      name: 'the surf beaches file',
      title: 'Queensland’s surf beaches — the coastline’s stretches that face open ocean swell, Point Danger to Agnes Water, made from the coastline above by the SoRT Scope Builder',
      by: 'State of Queensland (Department of Natural Resources and Mines), 2017, as the SoRT Scope Builder derives it',
      licence: 'CC BY 4.0',
      page: 'https://github.com/cdomotor-g/SoRT/blob/main/v2/tools/build-surf-coast.mjs',
    },
    sites: {
      name: 'the acid sulfate soil sample sites',
      title: 'Acid sulfate soil sites (SALI), in the Queensland soil and land resource map service',
      by: 'State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), 2025',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/queensland-soil-and-land-resource-data-web-map-service',
    },
  };

  // The State's own plain-language pages the summary's soil sentence rests on.
  const READING = [
    { title: 'Acid sulfate soils explained', page: 'https://www.qld.gov.au/environment/land/management/soil/acid-sulfate/explained' },
    { title: 'Impacts of acid sulfate soils', page: 'https://www.qld.gov.au/environment/land/management/soil/acid-sulfate/impacts' },
  ];

  // Where the corrosivity rows' grades and categories come from.
  const CORROSION_READING = [
    { title: 'AS 4312:2019 Atmospheric corrosivity zones in Australia — Standards Australia',
      page: 'https://store.standards.org.au/product/as-4312-2019',
      tail: '— the grades, and its Table 4.1 (as reproduced in Timber Queensland Technical Data Sheet 35, April 2020).' },
    { title: 'Corrosion and the infrastructure options — the SoRT Scope Builder’s guide',
      page: 'https://github.com/cdomotor-g/SoRT/blob/main/v2/README.md#corrosion-as-4312-and-otes-instruction',
      tail: '— OTE’s instruction beside the standard’s table, band by band.' },
  ];

  // ── Reading an answer ────────────────────────────────────────────────────
  // Each layer's JSON is boiled down the moment it lands, so the cache holds a
  // few numbers and strings and not 200 KB of estuary. A digest that cannot
  // read what came back throws, and the layer is then a failure like any other.
  const UNREADABLE = 'answered with something this could not read';

  function features(j) {
    if (!j || !Array.isArray(j.features)) throw new Error(UNREADABLE);
    return j.features;
  }

  const DIGEST = {
    count(j) {
      if (!j || typeof j.count !== 'number') throw new Error(UNREADABLE);
      return { n: j.count };
    },
    names(j) {
      const fs = features(j);
      return { n: fs.length, names: fs.map(f => f.attributes && f.attributes.lga).filter(Boolean) };
    },
    first(j) {
      const fs = features(j);
      return { f: fs.length ? { ...(fs[0].attributes || {}) } : null };
    },
    points(j, lat, lon) {
      const list = features(j)
        .map(f => ({ ...(f.attributes || {}), km: pointKm(f, lat, lon) }))
        .filter(p => p.km != null)
        .sort((a, b) => a.km - b.km);
      return { n: list.length, list: list.slice(0, 25) };
    },
    // The surf beaches file: how far the nearest one is, in metres (anywhere —
    // a surf beach 60 km off still puts an inland site in C3 on the table).
    surf(j, lat, lon) {
      if (!j || !Array.isArray(j.lines)) throw new Error(UNREADABLE);
      surfLines = j.lines;
      const f = flat(lat, lon);
      let d2 = Infinity;
      for (const l of j.lines) for (let i = 0; i < l.length - 1; i++) {
        d2 = Math.min(d2, segD2(0, 0, f.x(l[i][0]), f.y(l[i][1]), f.x(l[i + 1][0]), f.y(l[i + 1][1])));
      }
      return { m: isFinite(d2) ? Math.sqrt(d2) : null };
    },
    // The coastline within COAST_M: the nearest shore of each sheltered kind,
    // in metres — leaving out the pieces that are a surf beach (the surf row
    // has those), and keeping only the two numbers, not the geometry.
    shores(j, lat, lon) {
      const f = flat(lat, lon);
      const near = [];
      for (const l of surfLines || []) for (let i = 0; i < l.length - 1; i++) {
        const seg = [f.x(l[i][0]), f.y(l[i][1]), f.x(l[i + 1][0]), f.y(l[i + 1][1])];
        if (segD2(0, 0, ...seg) < (COAST_M + 1000) ** 2) near.push(seg);
      }
      const onSurf = (x, y) => near.some(seg => segD2(x, y, ...seg) <= SURF_TOL_M ** 2);
      const best = {};
      for (const ft of features(j)) {
        for (const p of (ft.geometry && ft.geometry.paths) || []) {
          for (let i = 0; i < p.length - 1; i++) {
            const ax = f.x(p[i][0]), ay = f.y(p[i][1]), bx = f.x(p[i + 1][0]), by = f.y(p[i + 1][1]);
            if (onSurf((ax + bx) / 2, (ay + by) / 2)) continue;
            const kind = (p[i][1] + p[i + 1][1]) / 2 > TROPIC_LAT ? 'tropical_quiet' : 'temperate_semi';
            const d2 = segD2(0, 0, ax, ay, bx, by);
            if (best[kind] == null || d2 < best[kind]) best[kind] = d2;
          }
        }
      }
      const out = {};
      for (const [kind, d2] of Object.entries(best)) if (Math.sqrt(d2) <= COAST_M) out[kind] = Math.sqrt(d2);
      return out;
    },
  };

  // The surf beaches, once loaded — the coastline's digest leaves them out.
  let surfLines = null;
  // A flat frame in metres round a point, good to a fraction of a per cent
  // over the 11 km asked: plenty for "which band is it in".
  function flat(lat, lon) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
    return { x: x => (x - lon) * kx, y: y => (y - lat) * ky };
  }
  // The squared distance from (px, py) to the segment (ax, ay)–(bx, by).
  function segD2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return x * x + y * y;
  }

  // What is asked, one request each. `count` layers ask only how many polygons
  // the point is in; the rest name their fields (see the header for why that
  // matters) and say how their answer is read.
  const ASS_FIELDS = 'map_code,map_code_meaning,project_code';
  const LAYERS = {
    lga:       { src: 'lga',   path: 'Boundaries/AdministrativeBoundaries/MapServer/1', fields: 'lga', digest: DIGEST.names },
    lgaNear:   { src: 'lga',   path: 'Boundaries/AdministrativeBoundaries/MapServer/1', fields: 'lga', distance: EDGE_M, digest: DIGEST.names },
    tidalIn:   { src: 'tidal', path: 'Environment/Fisheries/MapServer/15', count: true, distance: IN_TIDAL_M },
    hat100:    { src: 'hat',   path: 'Boundaries/AdminBoundariesFramework/MapServer/199', count: true, distance: 100 },
    hat1k:     { src: 'hat',   path: 'Boundaries/AdminBoundariesFramework/MapServer/199', count: true, distance: 1000 },
    hat10k:    { src: 'hat',   path: 'Boundaries/AdminBoundariesFramework/MapServer/199', count: true, distance: 10000 },
    limit:     { src: 'limit', path: 'InlandWaters/WatercourseIdentificationMap/MapServer/200', fields: 'name,reference,determined',
                 distance: LIMIT_M, geometry: true, digest: DIGEST.points },
    cmd:       { src: 'cmd',   path: 'PlanningCadastre/CoastalManagement/MapServer/5',  count: true },
    hat40:     { src: 'epa',   path: 'PlanningCadastre/CoastalManagement/MapServer/9',  count: true },
    stHigh:    { src: 'storm', path: 'PlanningCadastre/CoastalManagement/MapServer/11', count: true },
    stMed:     { src: 'storm', path: 'PlanningCadastre/CoastalManagement/MapServer/12', count: true },
    stNone:    { src: 'storm', path: 'PlanningCadastre/CoastalManagement/MapServer/13', count: true },
    ass25:     { src: 'ass',   path: 'GeoscientificInformation/SoilsAndLandResource/MapServer/1902', fields: ASS_FIELDS, digest: DIGEST.first, scale: '1:25 000' },
    ass50:     { src: 'ass',   path: 'GeoscientificInformation/SoilsAndLandResource/MapServer/1952', fields: ASS_FIELDS, digest: DIGEST.first, scale: '1:50 000' },
    ass100:    { src: 'ass',   path: 'GeoscientificInformation/SoilsAndLandResource/MapServer/2002', fields: ASS_FIELDS, digest: DIGEST.first, scale: '1:100 000' },
    assNat:    { src: 'atlas', path: 'GeoscientificInformation/SoilsAndLandResource/MapServer/2052',
                 fields: 'probclass,probclass_def,mapscale,mapclass,source', digest: DIGEST.first },
    assSite:   { src: 'sites', path: 'GeoscientificInformation/SoilsAndLandResource/MapServer/1850',
                 fields: 'project_code,site_id,obs_date,field_ph_available,laboratory_data_available,core_depth_m,landform_element,site_report_url',
                 distance: SITE_M, geometry: true, digest: DIGEST.points },
    // The coastline, generalised to ~10 m: a few to thirty kilobytes within 11 km.
    coast:     { src: 'coast', path: 'Oceans/CoastalWaters/MapServer/17', fields: 'feature_type',
                 where: "feature_type IN ('Coastline','Coastline Junction')", distance: COAST_M,
                 geometry: true, offset: 0.0001, digest: DIGEST.shores },
    // This site's own file, not a query: asked once a page, read for every station.
    surf:      { src: 'surf', local: SURF_URL, digest: DIGEST.surf },
  };
  const ASS_ORDER = ['ass25', 'ass50', 'ass100'];   // finest first
  // Asked only with the highest-tide line within the widest band: every one
  // of these lies along the coast and the estuaries, and inland they would be
  // seven requests answering "no".
  const COASTAL   = ['limit', 'cmd', 'hat40', 'stHigh', 'stMed', 'stNone', 'assSite', 'coast'];

  // ── Distance ─────────────────────────────────────────────────────────────

  // A point feature's distance from the station, in km — the geometry asked
  // for in 4326, or the latitude and longitude a sample site also carries.
  function pointKm(f, lat, lon) {
    const g = f && f.geometry;
    const a = (f && f.attributes) || {};
    const y = g && isFinite(g.y) ? g.y : Number(a.latitude);
    const x = g && isFinite(g.x) ? g.x : Number(a.longitude);
    if (!isFinite(x) || !isFinite(y)) return null;
    return acmaHaversineKm(lat, lon, y, x);
  }

  // ── Asking ───────────────────────────────────────────────────────────────

  function key(s) {
    if (!s || s.lat == null || s.lon == null || s.lat === '' || s.lon === '') return null;
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return `${lat.toFixed(KEY_DP)},${lon.toFixed(KEY_DP)}`;
  }

  const pointOf = k => k.split(',').map(Number);   // [lat, lon]

  function inBox(k) {
    const [lat, lon] = pointOf(k);
    return lon >= QLD_BOX.w && lon <= QLD_BOX.e && lat >= QLD_BOX.s && lat <= QLD_BOX.n;
  }

  function queryUrl(spec, lat, lon) {
    const p = new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
    });
    if (spec.distance) { p.set('distance', String(spec.distance)); p.set('units', 'esriSRUnit_Meter'); }
    if (spec.where) p.set('where', spec.where);
    if (spec.offset) p.set('maxAllowableOffset', String(spec.offset));
    if (spec.count) {
      p.set('returnCountOnly', 'true');
    } else {
      p.set('outFields', spec.fields);
      p.set('returnGeometry', spec.geometry ? 'true' : 'false');
      if (spec.geometry) { p.set('outSR', '4326'); p.set('geometryPrecision', '5'); }
    }
    p.set('f', 'json');
    return `${HOST}/${spec.path}/query?${p}`;
  }

  // map-roads.js's askJson, with its failures put into words a card can show.
  // ArcGIS answers an error as HTTP 200 with an `error` member, so that is a
  // failure too.
  async function askJson(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`answered HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) {
        throw new Error(`answered with an error${json.error.message ? ` (${json.error.message})` : ''}`);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  function reason(e) {
    if (e && e.name === 'AbortError') return `no answer in ${TIMEOUT_MS / 1000} s`;
    if (e instanceof TypeError) return 'unreachable — offline, or the network blocks the host';
    const m = String((e && e.message) || '');
    return m ? m.slice(0, 160) : 'no usable answer';
  }

  // The queue. A job for a position the card is no longer showing is dropped
  // before it is sent — clicking along a river's worth of pins must not leave
  // a hundred questions behind it — and rejects with SUPERSEDED, which is not
  // a failure and is never kept.
  const SUPERSEDED = new Error('superseded');
  const queue = [];
  let inFlight = 0;
  let wanted = null;        // the position the card is showing

  function schedule(k, run) {
    return new Promise((resolve, reject) => {
      queue.push({ k, run, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (inFlight < IN_FLIGHT && queue.length) {
      const job = queue.shift();
      if (job.k !== wanted) { job.reject(SUPERSEDED); continue; }
      inFlight++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject)
        .finally(() => { inFlight--; pump(); });
    }
  }

  // position → { layers: { name: {ok, v} | {ok:false, at, why} }, busy, running }
  const answers = new Map();
  // element id → the station last asked about there, for the fills and retry
  const asked = new Map();

  function entry(k) {
    let a = answers.get(k);
    if (a) {
      answers.delete(k);
      answers.set(k, a);
      return a;
    }
    a = { layers: {}, busy: {}, running: null };
    answers.set(k, a);
    if (answers.size > CACHE_MAX) {
      for (const [old, v] of answers) {
        if (old !== k && !v.running) { answers.delete(old); break; }
      }
    }
    return a;
  }

  const val     = r => (r && r.ok ? r.v : undefined);
  const failed  = r => !!(r && r.ok === false);
  const settled = r => !!r && (r.ok || Date.now() - r.at < FAIL_TTL);

  // This site's own files (the surf beaches): fetched once a page, and again
  // only after a failure.
  const local = new Map();
  function localJson(path) {
    if (!local.has(path)) local.set(path, askJson(path).catch(e => { local.delete(path); throw e; }));
    return local.get(path);
  }

  function layer(k, name) {
    const a = entry(k);
    if (a.busy[name]) return a.busy[name];
    const spec = LAYERS[name];
    const [lat, lon] = pointOf(k);
    // A file of this site's is not the State's server, so it takes no place in its queue.
    const p = (spec.local ? localJson(spec.local) : schedule(k, () => askJson(queryUrl(spec, lat, lon))))
      .then(json => ({ ok: true, v: (spec.digest || DIGEST.count)(json, lat, lon) }))
      .catch(e => (e === SUPERSEDED ? { superseded: true } : { ok: false, at: Date.now(), why: reason(e) }))
      .then(r => {
        delete a.busy[name];
        if (!r.superseded) a.layers[name] = r;
        return r;
      });
    a.busy[name] = p;
    return p;
  }

  // Is this point in what Queensland's layers describe? See the header.
  function coverage(k, L) {
    if (!inBox(k)) return 'away';
    const lga = val(L.lga), tin = val(L.tidalIn);
    if ((lga && lga.n) || (tin && tin.n)) return 'in';
    if (!L.lga || !L.tidalIn) return 'pending';
    if (failed(L.lga) || failed(L.tidalIn)) return 'failed';
    if (!L.lgaNear) return 'pending';
    if (failed(L.lgaNear)) return 'failed';
    return val(L.lgaNear).n ? 'edge' : 'out';
  }

  const inTidal = L => !!(val(L.tidalIn) && val(L.tidalIn).n);

  // How near the tide comes, in metres: 0 in tidal water, else the smallest
  // band the highest-tide line is within (100, 1,000 or 10,000), Infinity for
  // none within 10 km, undefined while it cannot be said. The bands nest, so a
  // band that answers "none" answers for every band inside it. `beyond` is the
  // band the line is known to be outside of, when the one inside the hit said
  // no — "within 1 km" is true either way, "more than 100 m" only then.
  function tideBand(L) {
    if (inTidal(L)) return { m: 0, beyond: null };
    const v = HAT_BANDS.map(([n]) => val(L[n]));
    const hit = v.findIndex(x => x && x.n);
    if (hit >= 0) {
      const inner = hit > 0 && v[hit - 1] && !v[hit - 1].n ? HAT_BANDS[hit - 1][1] : null;
      return { m: HAT_BANDS[hit][1], beyond: inner };
    }
    const outer = v[v.length - 1];
    return outer && !outer.n ? { m: Infinity, beyond: HAT_BANDS[v.length - 1][1] } : undefined;
  }

  // Every layer this position needs, given what is already known. Called again
  // after each stage lands, so the stages fall out of it rather than being
  // written down twice.
  function needed(k, L) {
    if (!inBox(k)) return [];
    const out = ['lga', 'tidalIn'];
    const cov = coverage(k, L);
    if (val(L.lga) && val(L.tidalIn) && !(val(L.lga).n || val(L.tidalIn).n)) out.push('lgaNear');
    if (cov !== 'in' && cov !== 'edge') return out;
    out.push(...ASS_ORDER, 'assNat', 'surf');
    if (!inTidal(L)) out.push(...HAT_BANDS.map(([n]) => n));
    const band = tideBand(L);
    // The coastline once the surf beaches are known: its digest leaves them out.
    if (band && band.m !== Infinity) out.push(...COASTAL.filter(n => n !== 'coast' || settled(L.surf)));
    return out;
  }

  const unsettled = (k, a) => needed(k, a.layers).filter(n => !settled(a.layers[n]));

  // Ask what is still unknown, stage by stage, repainting as each lands. Stops
  // the moment the card is showing somewhere else; ask() picks it up again
  // from where it stopped.
  function run(k) {
    const a = entry(k);
    if (a.running) return a.running;
    const step = async () => {
      for (;;) {
        if (k !== wanted) return;
        const todo = unsettled(k, a);
        if (!todo.length) return;
        const got = await Promise.all(todo.map(n => layer(k, n)));
        if (got.some(r => r.superseded)) return;
        notify(k);
      }
    };
    a.running = step().catch(() => {}).then(() => {
      a.running = null;
      notify(k);
      // A card that came back to this position while the last run was on its
      // way out would otherwise find it finished and nothing asked.
      if (k === wanted && unsettled(k, a).length) run(k);
    });
    return a.running;
  }

  // Repaint every element showing this position. An element gone from the
  // page is forgotten; one re-rendered for somewhere else keeps its id but not
  // its data-mn-exposure, and the old answer must not land in it.
  function notify(k) {
    for (const [elId, s] of asked) {
      const el = document.getElementById(elId);
      if (!el) { asked.delete(elId); continue; }
      if (el.dataset.mnExposure !== k) continue;
      paint(el, s);
    }
  }

  // The fill. Focus inside the section — on Try again, say, which the new
  // markup replaces — goes to the section itself rather than to <body>.
  function paint(el, s) {
    const had = el.contains(document.activeElement);
    el.innerHTML = html(s);
    if (had) {
      const g = el.querySelector('.stn-card-exp') || el;
      g.focus({ preventScroll: true });
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const TITLE = {
    head: 'What the water and the ground around this station are likely to do to anything built there — '
        + 'tidal water, the Water Act’s downstream limits, the coastal hazard areas and acid sulfate soils — '
        + 'from the Queensland Government’s own mapping, read at the station’s recorded position. '
        + 'Indicative: check against a site investigation.',
    tidal: '“In tidal water” is within 50 m of a mapped tidal waterway (Queensland waterways for waterway barrier '
         + 'works — tidal, Department of Agriculture and Fisheries, 2023). Otherwise, how close the highest '
         + 'astronomical tide line comes (Department of Resources, 2023): where the highest predictable tide meets the '
         + 'land, on the open coast and up the tidal reaches of rivers and creeks alike — within 100 m, 1 km or 10 km, '
         + 'in a straight line.',
    limit: 'The nearest downstream limit on the Water Act 2000 watercourse identification map: where the Act stops '
         + 'treating a stream as a watercourse and the Coastal Protection and Management Act 1995 takes over. '
         + 'Where none is mapped, the Act puts it at the point the high spring tide ordinarily reaches — so a mapped '
         + 'limit is a legal line near the tidal limit, not a measurement of how far salt water gets on a given day.',
    coast: 'The coastal management district (Coastal Protection and Management Act 1995), and component 1 of the '
         + 'erosion prone area: land within 40 m of highest astronomical tide (HAT), where storm erosion and channel '
         + 'migration are expected.',
    storm: 'Queensland’s storm tide inundation area, allowing for projected climate change to 2100: high hazard is '
         + 'land the storm tide covers by more than 1 m, medium by less. “Not mapped here” is land outside the LiDAR '
         + 'the mapping was made from.',
    ass: 'Queensland’s acid sulfate soil mapping at the finest scale that covers this point, in the map’s own words. '
       + '“Actual” acid sulfate soil is already making acid; “potential” makes it when dug up, drained or dewatered.',
    atlas: 'The Atlas of Australian Acid Sulfate Soils (CSIRO, 2011) as Queensland serves it: clipped to Queensland, '
         + 'to land below 20 m and to land with no finer mapping. Its 1:2M classes are inferred from national soil and '
         + 'river maps and are provisional — not checked on the ground.',
    sites: 'The nearest acid sulfate soil sample site in Queensland’s soil database within 2 km: where a core was '
         + 'taken and tested. The report opens the site’s own record.',
    corr: 'How corrosive the air is to steel and its coatings, on AS 4312:2019’s scale from C1 (very low) to CX '
        + '(extreme): read off the standard’s Table 4.1 by the distance to the nearest surf beach and to the nearest '
        + 'other shore — a bay, a passage or a river mouth, “semi-sheltered” south of the Tropic of Capricorn and '
        + '“tropical quiet” north of it — and the higher of the two. Surf beaches are the State coastline’s '
        + 'stretches facing open ocean swell, Point Danger to Agnes Water. In a straight line, to the shoreline at mean '
        + 'high water.',
    ote: 'OTE is the Bureau team whose instruction (November 2026) groups AS 4312’s grades into three categories for a '
       + 'station’s tower, enclosure and orifice run: C3 and below (a galvanised tower, aluminium enclosure and '
       + 'galvanised orifice run), C4 (a stainless steel enclosure and orifice run) and C5 and CX (all stainless). Its '
       + 'distances are rounded to 100 m, 1 km and 10 km and are stricter than the standard’s table in places, never less.',
    tide: 'Heights on this gauge that the Bureau’s lists tie to the tide: highest astronomical tide (HAT) from its '
        + 'crossing type T, and the tide levels among its flood effects. In AHD only where the gauge zero is surveyed '
        + 'in AHD.',
  };

  const note   = t => `<span class="mn-pop-note">${t}</span>`;
  const asking = () => note('asking…');
  const unread = src => `<span class="txt-warn">could not be read</span> ${note(`— ${esc(SOURCES[src].name)}`)}`;

  function row(label, value, title) {
    if (!value) return '';
    const t = title ? ` title="${esc(title)}"` : '';
    return `<div class="acma-row"><span${t}>${esc(label)}</span><span>${value}</span></div>`;
  }

  function kmText(km) {
    if (km < 0.1) return 'under 0.1 km';
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }

  const fig = (v, dp = 2) => {
    const n = Number(v);
    return (n < 0 ? '−' : '') + Math.abs(n).toFixed(dp);
  };

  const titleCase = t => String(t || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  // "BRISBANE RIVER", "Brisbane River" and "BRISBANE R" are one stream.
  function streamKey(t) {
    const s = String(t || '').toUpperCase()
      .replace(/\bCK\b|\bCRK\b/g, 'CREEK').replace(/\bR\b|\bRIV\b/g, 'RIVER')
      .replace(/[^A-Z]+/g, ' ').trim();
    return s || null;
  }

  const mText = m => (m < 1000 ? `${m} m` : `${m / 1000} km`);

  function tidalRow(L) {
    const band = tideBand(L);
    let v;
    if (band && band.m === 0) {
      v = `In tidal water ${note(`within ${IN_TIDAL_M} m of a mapped tidal waterway`)}`;
    } else if (band && band.m === Infinity) {
      v = `None within ${mText(band.beyond)}`;
    } else if (band) {
      v = `Within ${mText(band.m)} of the highest-tide line${band.beyond ? ` ${note(`more than ${mText(band.beyond)}`)}` : ''}`;
    } else if (failed(L.tidalIn) || HAT_BANDS.some(([n]) => failed(L[n]))) {
      v = unread(HAT_BANDS.some(([n]) => failed(L[n])) ? 'hat' : 'tidal');
    } else {
      v = asking();
    }
    return row('Tidal water', v, TITLE.tidal);
  }

  // The limit on the station's own stream when there is one within 20 km —
  // "the nearest" is often another creek entirely (the Brisbane River has none
  // mapped; Norman Creek, across town, does) — and otherwise the nearest,
  // saying whose it is.
  function limitRow(s, L) {
    if (failed(L.limit)) return row('Tidal limit', unread('limit'), TITLE.limit);
    const v = val(L.limit);
    if (!v) return row('Tidal limit', asking(), TITLE.limit);
    if (!v.list.length) {
      return row('Tidal limit', `None mapped within ${LIMIT_M / 1000} km ${note('the Water Act map marks few streams’ limits')}`, TITLE.limit);
    }
    const mine = streamKey(s && s.stream);
    const same = mine ? v.list.find(l => streamKey(l.name) === mine) : null;
    const pick = same || v.list[0];
    const whose = same ? 'on this station’s stream'
      : mine ? `the nearest mapped — not on the ${titleCase(s.stream)}` : 'the nearest mapped';
    const when = isFinite(pick.determined) && pick.determined
      ? ` Determined ${new Date(Number(pick.determined)).toISOString().slice(0, 10)}.` : '';
    return row('Tidal limit',
      `${esc(pick.name || 'Unnamed')} ${note(`${esc(kmText(pick.km))} away, straight line — ${esc(whose)}`)}`,
      `${TITLE.limit}${pick.reference ? ` Reference ${pick.reference}.` : ''}${when}`);
  }

  function coastRow(L) {
    const cmd = val(L.cmd), hat = val(L.hat40);
    let v;
    if (failed(L.cmd)) v = unread('cmd');
    else if (!cmd) v = asking();
    else v = cmd.n ? 'In the coastal management district' : 'Outside the coastal management district';
    if (hat && hat.n) v += ` · within 40 m of HAT ${note('erosion prone')}`;
    else if (failed(L.hat40)) v += ` · ${unread('epa')}`;
    return row('Coast', v, TITLE.coast);
  }

  function stormRow(L) {
    const hi = val(L.stHigh), med = val(L.stMed), none = val(L.stNone);
    let v;
    if (hi && hi.n) v = `High hazard ${note('covered by more than 1 m')}`;
    else if (med && med.n) v = `Medium hazard ${note('covered by less than 1 m')}`;
    else if (failed(L.stHigh) || failed(L.stMed)) v = unread('storm');
    else if (!hi || !med) v = asking();
    else if (none && none.n) v = `Not mapped here ${note('no LiDAR under this part of the mapping')}`;
    else if (none) v = 'Not in a mapped storm tide area';
    else if (failed(L.stNone)) v = unread('storm');
    else v = asking();
    return row('Storm tide', v, TITLE.storm);
  }

  // What a map code's words say about the soil, coarsely, for the summary.
  // The row always quotes the words themselves.
  function assLevel(meaning) {
    const t = String(meaning || '').toLowerCase();
    if (!t) return null;
    if (/not assessed|not applicable/.test(t)) return 'unassessed';
    if (/dam or lake or water reservoir/.test(t)) return 'water';
    if (/^not at risk|low probability/.test(t)) return 'low';
    if (/possibly at risk/.test(t)) return 'possible';
    if (/\bactual\b/.test(t)) return 'actual';
    if (/potential ass|potential acid sulfate|\bpass\b|\bass present\b|probability of ass/.test(t)) return 'likely';
    return 'unclear';
  }

  const NATIONAL = { A: 'likely', B: 'possible', C: 'low' };

  // The finest map that says something about this point, and what the ones
  // finer than it did instead: not read, or left the point unassessed.
  function assPick(L) {
    const finer = [];
    for (const n of ASS_ORDER) {
      const scale = LAYERS[n].scale;
      if (failed(L[n])) { finer.push(`the ${scale} map could not be read`); continue; }
      const v = val(L[n]);
      if (!v) return { pending: true };
      if (!v.f) continue;
      const level = assLevel(v.f.map_code_meaning);
      if (level === 'unassessed') { finer.push(`the ${scale} map leaves it unassessed`); continue; }
      return { f: v.f, scale, level, finer };
    }
    return { f: null, finer };
  }

  function assRows(L) {
    const pick = assPick(L);
    const nat = val(L.assNat);
    if (pick.pending || (!nat && !failed(L.assNat))) return row('Acid sulfate', asking(), TITLE.ass);
    const natF = nat ? nat.f : null;
    const natText = f => `${esc(f.probclass_def || f.probclass || '')} ${note(esc([
      `national atlas, ${f.mapscale || 'scale not given'}`,
      f.mapclass && f.mapclass !== 'unclassified' ? f.mapclass : '',
      /1:2M/i.test(f.mapscale || '') ? 'inferred, not checked on the ground' : '',
    ].filter(Boolean).join(' · ')))}`;
    const out = [];
    if (pick.f) {
      const f = pick.f;
      out.push(row('Acid sulfate',
        `${esc(f.map_code_meaning || f.map_code || '')} ${note(esc([`${pick.scale} map`, f.project_code].filter(Boolean).join(' · ')))}`
        + (pick.finer.length ? ` ${note(esc(`— ${pick.finer.join('; ')}`))}` : ''), TITLE.ass));
      out.push(row('National atlas', natF ? natText(natF)
        : failed(L.assNat) ? unread('atlas')
        : note('not given here — Queensland’s copy leaves out land with finer mapping'), TITLE.atlas));
      return out.join('');
    }
    if (natF) {
      out.push(row('Acid sulfate', natText(natF)
        + (pick.finer.length ? ` ${note(esc(`— ${pick.finer.join('; ')}`))}` : ''), TITLE.atlas));
      return out.join('');
    }
    if (failed(L.assNat) || pick.finer.some(t => /could not be read/.test(t))) {
      const which = [pick.finer.some(t => /could not be read/.test(t)) ? SOURCES.ass.name : '',
                     failed(L.assNat) ? SOURCES.atlas.name : ''].filter(Boolean).join(' and ');
      return row('Acid sulfate', `<span class="txt-warn">could not be read</span> ${note(`— ${esc(which)}`)}`, TITLE.ass);
    }
    // A project that drew a polygon here and wrote "not assessed" in it has
    // said something, and it is not "not mapped".
    if (pick.finer.length) {
      return row('Acid sulfate', `Not assessed here ${note(esc(`— ${pick.finer.join('; ')}`))}`, TITLE.ass);
    }
    return row('Acid sulfate', `Not mapped here ${note('Queensland maps acid sulfate soils on coastal land, and its copy of '
      + 'the national atlas stops at 20 m elevation — not mapped is not the same as absent')}`, TITLE.ass);
  }

  // What the soil rows add up to, for the summary: 'actual', 'likely',
  // 'possible', 'low', or null for nothing to say.
  function assVerdict(L) {
    const pick = assPick(L);
    if (pick.pending) return null;
    if (pick.f) return ['actual', 'likely', 'possible', 'low'].includes(pick.level) ? pick.level : null;
    const nat = val(L.assNat);
    return nat && nat.f ? NATIONAL[nat.f.probclass] || null : null;
  }

  function siteRow(L, verdict) {
    if (failed(L.assSite)) return row('ASS sample', unread('sites'), TITLE.sites);
    const v = val(L.assSite);
    if (!v) return row('ASS sample', asking(), TITLE.sites);
    const p = v.list[0];
    if (!p) {
      return verdict === 'actual' || verdict === 'likely'
        ? row('ASS sample', `None within ${SITE_M / 1000} km ${note('no core tested nearby')}`, TITLE.sites)
        : '';
    }
    const bits = [`${p.project_code || ''} site ${p.site_id != null ? p.site_id : '?'}`.trim()];
    if (p.core_depth_m != null && isFinite(p.core_depth_m)) bits.push(`cored to ${Number(p.core_depth_m)} m`);
    if (/^y/i.test(p.laboratory_data_available || '')) bits.push('lab data');
    else if (/^y/i.test(p.field_ph_available || '')) bits.push('field pH');
    if (v.n > 1) bits.push(`${v.n} within ${SITE_M / 1000} km`);
    const url = /^https:\/\//i.test(p.site_report_url || '') ? p.site_report_url : null;
    const link = url
      ? ` <a href="${esc(url)}" target="_blank" rel="noopener"
             aria-label="${esc(`Site report for ${bits[0]} — Queensland Government, in a new tab`)}"
             >site report<span aria-hidden="true"> ↗</span></a>` : '';
    return row('ASS sample', `${esc(kmText(p.km))} away ${note(esc(bits.join(' · ')))}${link}`, TITLE.sites);
  }

  // ── Atmospheric corrosivity ──────────────────────────────────────────────

  // A distance as the corrosivity rows say it: tens of metres under 1 km,
  // because there the table's bands are 50, 100 and 500 m.
  const distText = m => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : kmText(m / 1000));
  // One of OTE's round distances: 100 m, 1 km, 10 km.
  const limText = m => (m < 1000 ? `${m} m` : `${+(m / 1000).toFixed(1)} km`);
  const gradeRank = g => Math.max(...String(g).split('/').map(t => GRADE_RANK[t.replace(/[^A-Z0-9]/g, '')] || 0));
  const gradeName = g => String(g).split('/').map(t => (GRADES[t] || [t])[0]).join(' or ');

  // The table's grade for one kind of shore at m metres, with the C3* rule
  // applied when the station's elevation is recorded.
  function gradeAt(shore, m, elev) {
    const i = AS4312.edges.findIndex(e => m < e);
    let g = i < 0 ? AS4312.beyond : AS4312.grades[shore][i];
    let why = '';
    if (g === 'C3*') {
      if (m > 5000 && elev != null && elev > 50) { g = 'C2'; why = 'C2 rather than C3: over 50 m above sea level and more than 5 km from the shore'; }
      else { g = 'C3'; if (m > 5000 && elev == null) why = 'C2 if the site is over 50 m above sea level'; }
    }
    return { g, band: i < 0 ? 'over 100 km' : AS4312.bands[i], why };
  }

  // { pending } | { failed: src } | { grade, ote, oteBy, stricter, d } — the
  // grade is the highest any kind of shore reaches; OTE's category is the
  // first of its bands any shore is within.
  function corrosion(s, L) {
    if (failed(L.surf)) return { failed: 'surf' };
    const surf = val(L.surf);
    const band = tideBand(L);
    if (!surf || band === undefined) return { pending: true };
    const d = {};
    if (surf.m != null) d.surf = surf.m;
    if (band.m !== Infinity) {
      if (failed(L.coast)) return { failed: 'coast' };
      const c = val(L.coast);
      if (!c) return { pending: true };
      Object.assign(d, c);
    }
    const elev = num(s && s.elevation_ahd);
    // Shores out of reach are more than 10 km off: C2 on the table, whatever their kind.
    // A shore over 100 km off says no more than that, so it isn't named as the reason.
    const grades = [{ shore: null, m: null, g: AS4312.beyond, band: '', why: '' },
      ...Object.entries(d).filter(([, m]) => m < AS4312.edges[AS4312.edges.length - 1])
        .map(([shore, m]) => ({ shore, m, ...gradeAt(shore, m, elev) }))];
    const grade = grades.sort((x, y) => gradeRank(y.g) - gradeRank(x.g) || (x.m ?? Infinity) - (y.m ?? Infinity))[0];
    let ote = OTE_ELSE, oteBy = null;
    for (const b of OTE) {
      const hit = Object.entries(b.within).filter(([t, lim]) => d[t] != null && d[t] < lim).sort((x, y) => d[x[0]] - d[y[0]])[0];
      if (hit) { ote = b; oteBy = { shore: hit[0], m: d[hit[0]], within: hit[1] }; break; }
    }
    const stricter = OTE_RANK[ote.cat] > Math.max(...grade.g.split('/').map(oteOf).map(c => OTE_RANK[c]));
    return { grade, ote, oteBy, stricter, d };
  }

  // The grade on the standard's scale, C1 to CX, and OTE's three categories
  // under it, the station's lit and only its category named — the two rows'
  // answers at a glance, under the first. A picture of words already in the rows, so its own words are the
  // stylesheet's (data-w): the row reads, and the card's search finds, what it
  // did before.
  function scaleHtml(grade, cat) {
    const lit = String(grade).replace(/\*/g, '').split('/');
    const tint = { C1: 'ok', C2: 'ok', C3: 'ok', C4: 'warn', C5: 'bad', CX: 'bad' };
    const cells = Object.keys(GRADE_RANK).map(k =>
      `<i class="cr-cell cr-${tint[k]}${lit.includes(k) ? ' is-lit' : ''}" data-w="${k}"></i>`).join('');
    const groups = [['C3 and below', 'standard kit', 3, ' cr-at-start'], ['C4', 'stainless box', 1, ''], ['C5 and CX', 'all stainless', 2, ' cr-at-end']]
      .map(([c, w, n, at]) => `<i class="cr-group cr-span-${n}${at}${c === cat ? ' is-lit' : ''}" data-w="${c === cat ? w : ''}"></i>`).join('');
    const said = `AS 4312 grades C1 to CX: this site ${lit.join(' or ')}; OTE's category ${cat}`;
    return `<span class="cr-scale cr-scale-6" role="img" aria-label="${esc(said)}">${cells}${groups}</span>`;
  }

  function corrosionRows(s, L) {
    const c = corrosion(s, L);
    if (c.pending) return row('Corrosivity', asking(), TITLE.corr);
    if (c.failed) return row('Corrosivity', unread(c.failed), TITLE.corr);
    const g = c.grade;
    const meaning = String(g.g).split('/').map(t => `${t} — ${GRADES[t][0]}: ${GRADES[t][1]}`).join(' Or ');
    const where = g.shore
      ? `AS 4312 Table 4.1 · ${distText(g.m)} from ${SHORES[g.shore].a} (${g.band})`
      : `AS 4312 · no shore within 10 km${c.d.surf != null ? `, the nearest surf beach ${distText(c.d.surf)} away` : ''}`;
    const out = [row('Corrosivity',
      `${termHtml(`${g.g.replace('*', '')} — ${gradeName(g.g)}`, meaning)}${scaleHtml(g.g, c.ote.cat)} ${note(esc(where + (g.why ? ` · ${g.why}` : '')))}`, TITLE.corr)];
    const by = c.oteBy ? `within ${limText(c.oteBy.within)} of ${SHORES[c.oteBy.shore].a}` : 'beyond OTE’s distances';
    out.push(row('OTE category', `${esc(c.ote.cat)} ${note(esc(`— ${c.ote.materials} · ${by}${c.stricter ? ' · stricter than the standard’s table here' : ''}`))}`, TITLE.ote));
    return out.join('');
  }

  // ── What the station's own record says about the tide ─────────────────────

  const TIDE_RE = /\bHAT\b|highest astronomical|\bMHWS\b|mean high water|spring tide|storm tide|king tide/i;
  const num = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));

  function tideName(text) {
    if (/\bHAT\b|highest astronomical/i.test(text)) return 'HAT';
    if (/\bMHWS\b|mean high water spring/i.test(text)) return 'MHWS';
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // The gauge zero in force, and only when it can carry a height into AHD. A
  // tide gauge's zero is a few metres either side of AHD's; a zero that puts
  // HAT outside −1…8 m AHD is a record to check, not a figure to print.
  function zeroOf(s) {
    const rows = ((s && s.gauge_survey) || []).filter(r => num(r.gauge_zero_m) != null);
    if (!rows.length) return null;
    const r = typeof RiverDetails !== 'undefined' && RiverDetails.currentSurvey
      ? RiverDetails.currentSurvey(rows) : rows[0];
    return r ? { m: num(r.gauge_zero_m), datum: r.datum || null, from: r.valid_from || null } : null;
  }

  function tideLevels(s) {
    const out = [];
    const seen = new Set();
    const add = (name, h) => {
      if (h == null) return;
      const k = `${name}|${h.toFixed(2)}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ name, h });
    };
    for (const c of (s && s.crossings) || []) if (c && c.crossing_type === 'T') add('HAT', num(c.height_m));
    for (const f of (s && s.flood_classes) || []) if (f && f.crossing_type === 'T') add('HAT', num(f.crossing_height_m));
    // The newest edition of the flood effects that mentions the tide at all.
    const tidal = ((s && s.flood_effects) || []).filter(e => e && TIDE_RE.test(`${e.effect || ''} ${e.detail || ''}`));
    const newest = tidal.reduce((m, e) => ((e.as_at || '') > m ? e.as_at || '' : m), '');
    for (const e of tidal) if ((e.as_at || '') === newest) add(tideName(e.effect || e.detail), num(e.height_m));
    return out.sort((a, b) => a.h - b.h);
  }

  // A height on the gauge in AHD: only through a zero surveyed in AHD, and
  // only when the answer is somewhere a tide could be. The one rule, for the
  // tide lines and for the summary's comparison with the station's ground.
  function toAhd(zero, h) {
    if (!zero || zero.datum !== 'AHD' || h == null) return null;
    const v = zero.m + h;
    return v >= -1 && v <= 8 ? v : null;
  }

  function hatAhd(levels, zero) {
    const hats = levels.filter(l => l.name === 'HAT').map(l => l.h);
    return hats.length ? toAhd(zero, Math.max(...hats)) : null;
  }

  function tideBlock(s) {
    const levels = tideLevels(s);
    if (!levels.length) return '';
    const zero = zeroOf(s);
    const ahd = h => { const v = toAhd(zero, h); return v == null ? '' : ` ≈ ${fig(v)} m AHD`; };
    const lines = levels.map(l =>
      `<span class="mn-pop-line mn-pop-indent">${esc(l.name)} — ${esc(fig(l.h))} m on the gauge${esc(ahd(l.h))}</span>`);
    const zeroLine = !zero ? 'no gauge zero recorded — heights on the gauge only'
      : zero.datum !== 'AHD' ? `gauge zero on ${zero.datum ? `a datum recorded as ${zero.datum}` : 'no recorded datum'} — not put in AHD`
      : `gauge zero ${fig(zero.m)} m AHD`;
    return `<div class="stn-card-ids stn-card-exp-tide"><span class="small txt-muted"
        title="${esc(TITLE.tide)}">Tide on the gauge</span> ${note(esc(`the Bureau’s lists · ${zeroLine}`))}<br>${lines.join('<br>')}</div>`;
  }

  // ── The summary ──────────────────────────────────────────────────────────

  function summary(s, L) {
    const items = [];
    const band = tideBand(L);
    const m = band ? band.m : undefined;
    if (m === 0) {
      items.push('Salt or brackish water at high tide: the station is in a mapped tidal waterway — saltier in a dry '
        + 'spell or a king tide, fresher in a flood. Steel and reinforced concrete corrode fastest where the tide wets '
        + 'and dries them.');
    } else if (m === 100) {
      items.push('At the water’s edge — within 100 m of where the highest tides reach, on the sea or an estuary: salt '
        + 'in the air is likely, and a storm tide can bring salt water to the site.');
    } else if (m === 1000) {
      items.push('Within 1 km of where the highest tides reach: out of the tide itself, but salt on the wind and salty '
        + 'groundwater are worth checking for.');
    } else if (m === Infinity) {
      items.push('No tidal water within 10 km, so these maps put no salt water here. Inland salinity — salty '
        + 'groundwater away from the coast — is not something they cover.');
    }
    const hi = val(L.stHigh), med = val(L.stMed);
    if ((hi && hi.n) || (med && med.n)) {
      items.push(`In a mapped storm tide area, ${hi && hi.n ? 'more' : 'less'} than 1 m deep: a surge can put seawater `
        + 'over the site (mapped allowing for sea level rise to 2100).');
    }
    const c = corrosion(s, L);
    if (c.grade) {
      const g = c.grade, gText = `${g.g.replace('*', '')} (${gradeName(g.g)})`;
      const where = g.shore ? ` — ${distText(g.m)} from ${SHORES[g.shore].a}` : ' — no shore within 10 km';
      items.push(`Salt in the air: AS 4312 grades this site ${gText}${where}. OTE’s instruction for station materials `
        + `puts it in ${c.ote.cat}${c.stricter ? ', stricter here than the standard’s table' : ''}: ${c.ote.materials}.`);
    }
    const levels = tideLevels(s);
    const hat = hatAhd(levels, zeroOf(s));
    const elev = num(s && s.elevation_ahd);
    if (hat != null && elev != null && elev - hat <= 3) {
      const how = s.elevation_source ? ', modelled' : '';
      items.push(elev < hat
        ? `The station’s recorded elevation (${fig(elev)} m AHD${how}) is below HAT on this gauge (${fig(hat)} m AHD): `
          + 'at that position the highest tides reach the ground.'
        : `The station’s recorded elevation (${fig(elev)} m AHD${how}) is ${fig(elev - hat)} m above HAT on this gauge `
          + `(${fig(hat)} m AHD).`);
    }
    const ass = assVerdict(L);
    if (ass === 'actual') {
      items.push('Actual acid sulfate soil is mapped here — already making sulfuric acid. Water in it and draining '
        + 'from it is acidic and sulfate-rich, and attacks concrete and steel, galvanising included.');
    } else if (ass === 'likely') {
      // The finer maps give a depth; the national atlas gives a probability.
      const where = assPick(L).f ? ', at the depth the map gives' : '';
      items.push(`Acid sulfate soils likely${where}. Harmless left wet and undisturbed; dug up, drained or `
        + 'dewatered, their iron sulfides oxidise to sulfuric acid, which attacks concrete and steel (galvanising '
        + 'included) and releases iron and aluminium. The soft muds they sit in can also settle under a footing.');
    } else if (ass === 'possible') {
      items.push('Acid sulfate soils possible here — worth testing for before digging.');
    } else if (ass === 'low') {
      // "Acidic soil in top 0.5m, low probability of ASS" is a map code of its
      // own; the acid is worth passing on even where the sulfides are not.
      const pick = assPick(L);
      items.push(pick.f && /acidic soil/i.test(pick.f.map_code_meaning || '')
        ? 'Acid sulfate soils are mapped as unlikely here, though the map notes acidic soil near the surface.'
        : 'Acid sulfate soils are mapped as unlikely here.');
    }
    if (!items.length) return '';
    return `<div class="stn-card-exp-sum"><span class="small txt-muted">Indicative exposure</span>
        <ul class="stn-card-exp-list">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        <p class="mn-pop-note stn-card-exp-foot">Indicative — read off maps at the station’s recorded position, which
          may be tens of metres out. Check against a site investigation before choosing materials or footings.</p></div>`;
  }

  // ── Sources, failures and the whole section ───────────────────────────────

  // The datasets actually consulted for this position, in the order the rows
  // use them — the attribution CC BY asks for, and the way to each.
  function sourcesHtml(k, L) {
    const used = [...new Set(needed(k, L).map(n => LAYERS[n].src))];
    const link = (title, page, tail) => `<li><a href="${esc(page)}" target="_blank" rel="noopener"
        aria-label="${esc(`${title} — in a new tab`)}">${esc(title)}<span aria-hidden="true"> ↗</span></a>${tail ? ` ${esc(tail)}` : ''}</li>`;
    const docs = typeof docUrl === 'function' ? docUrl('docs/site-exposure.md') : 'docs/site-exposure.md';
    return `<details class="stn-card-rhs-earlier stn-card-exp-src">
        <summary class="small">Sources and limits</summary>
        <ul class="stn-card-exp-list">${used.map(src => {
          const d = SOURCES[src];
          return link(d.title, d.page, `— © ${d.by}, ${d.licence}.`);
        }).join('')}</ul>
        <p class="stn-card-aep-line">Every row is a map read at one point: the station’s recorded position, rounded to
          about 10 m. A coordinate a few tens of metres out can move a site across a boundary, and the soil maps are
          drawn at 1:25 000 to 1:2 000 000 — a polygon edge is a line on a map, not on the ground.</p>
        <p class="stn-card-aep-line">The soil sentences in the summary are the State’s own:</p>
        <ul class="stn-card-exp-list">${READING.map(r => link(r.title, r.page, '— Queensland Government.')).join('')}</ul>
        <p class="stn-card-aep-line">The corrosivity grades are AS 4312:2019’s, read off its Table 4.1 by distance; the
          categories are OTE’s instruction, which is stricter than the table in places. Both indicative: local
          conditions — strong onshore winds, spray from a headland, industry, a polluted river — can push a site up a
          category, and the choice of materials is a design decision.</p>
        <ul class="stn-card-exp-list">${CORROSION_READING.map(r => link(r.title, r.page, r.tail)).join('')}</ul>
        <p class="stn-card-aep-line"><a href="${esc(docs)}" target="_blank" rel="noopener"
          aria-label="What each row means, and its limits — the documentation, in a new tab"
          >What each row means, and its limits<span aria-hidden="true"> ↗</span></a></p>
      </details>`;
  }

  // Which sources did not answer, by name and why, and the way to ask again.
  // `coverage` is the case where it was the first question that failed — then
  // not even "is this Queensland?" is known, and the line says so.
  function failuresHtml(k, L, coverage) {
    const bad = new Map();
    for (const n of needed(k, L)) {
      const r = L[n];
      if (!failed(r)) continue;
      const src = LAYERS[n].src;
      if (!bad.has(src)) bad.set(src, new Set());
      bad.get(src).add(r.why);
    }
    if (!bad.size) return '';
    const list = [...bad].map(([src, whys]) => `${SOURCES[src].name} (${[...whys].join('; ')})`);
    const them = list.length === 1 ? 'it' : 'them';
    const tail = coverage
      ? `So it is not yet known whether Queensland’s layers cover this station, and nothing here is claimed from ${them}.`
      : `Nothing on this card is claimed from ${them}.`;
    return `<p class="small txt-warn stn-card-exp-foot">Could not be read: ${esc(list.join('; '))}. ${esc(tail)}</p>
      <button type="button" class="pill stn-card-exp-retry" onclick="SiteExposure.retry(this)"
              aria-label="Try again — ask the Queensland Government’s map services that did not answer"
              ><span aria-hidden="true">↻</span> Try again</button>`;
  }

  // The section's contents for a station, from whatever is known now. Called
  // by stnCardHtml() on every paint and by the fills; never asks anything.
  function html(s) {
    const k = key(s);
    if (!k) return '';
    const a = answers.get(k);
    const L = (a && a.layers) || {};
    const cov = coverage(k, L);
    const busy = cov !== 'away' && needed(k, L).some(n => !L[n]);
    const headId = `mn-exposure-head-${s.id}`;
    const parts = [];

    if (cov === 'away') {
      parts.push(`<p class="small txt-muted stn-card-exp-foot">Not in Queensland. Every row this section can show
          comes from a Queensland Government dataset, and they stop at the state border — so nothing is known about
          this site from them.</p>`);
    } else if (cov === 'out') {
      parts.push(`<p class="small txt-muted stn-card-exp-foot">Not in Queensland — or offshore, beyond its mapped
          land and tidal waterways. Every row this section can show comes from a Queensland Government dataset, and
          they stop at the state border — so nothing is known about this site from them.</p>`);
    } else if (cov === 'pending') {
      parts.push('<p class="small txt-muted stn-card-exp-foot">Asking the Queensland Government’s map services…</p>');
    } else if (cov === 'failed') {
      parts.push(failuresHtml(k, L, true));
    } else {
      if (cov === 'edge') {
        parts.push(`<p class="small txt-muted stn-card-exp-foot">Just off Queensland’s mapped land — within 1 km of
            it: on the shore, offshore, or across the border. The rows below are Queensland’s, and its layers stop at
            the border.</p>`);
      }
      parts.push(tidalRow(L));
      // The same rule needed() asks by: the coastal rows exist only where the
      // coastal layers were asked.
      const band = tideBand(L);
      const coastal = !!band && band.m !== Infinity;
      if (coastal) parts.push(limitRow(s, L), coastRow(L), stormRow(L));
      parts.push(corrosionRows(s, L));
      parts.push(assRows(L));
      if (coastal) parts.push(siteRow(L, assVerdict(L)));
    }
    parts.push(tideBlock(s));
    if (cov === 'in' || cov === 'edge') {
      parts.push(summary(s, L));
      if (!busy) parts.push(failuresHtml(k, L));
      parts.push(sourcesHtml(k, L));
    }
    return `<div class="stn-card-exp" role="group" aria-labelledby="${escAttr(headId)}" tabindex="-1"${busy ? ' aria-busy="true"' : ''}>
        <span class="small txt-muted stn-card-rhs-head" id="${escAttr(headId)}"
              title="${esc(TITLE.head)}">Site exposure — tides and soils</span>
        <span class="stn-card-rhs-snap mn-pop-note">Queensland Government mapping — indicative</span>
        ${parts.join('')}
      </div>`;
  }

  // Fill an element once the answers are in. `data-mn-exposure` carries the
  // position it was rendered for and is checked before every write (notify),
  // for SLS.ask's reason: a card re-rendered for a moved pin keeps its id, and
  // the answer about the old position must not land in it.
  function ask(elId, s) {
    const k = key(s);
    if (!k) return;
    asked.set(elId, s);
    wanted = k;
    if (!inBox(k)) return;           // answered already, in words, by html()
    const a = entry(k);
    if (!unsettled(k, a).length) return;
    run(k);
  }

  // "Try again": forget this position's failures and ask at once.
  function retry(btn) {
    const el = btn && btn.closest ? btn.closest('[data-mn-exposure]') : null;
    const s = el ? asked.get(el.id) : null;
    const k = key(s);
    if (!k || el.dataset.mnExposure !== k) return;
    const a = entry(k);
    for (const n of Object.keys(a.layers)) if (failed(a.layers[n])) delete a.layers[n];
    wanted = k;
    paint(el, s);
    // Said aloud when it lands, because the press is the one thing here a
    // person asked for: a paint is silent, an answer to "try again" is not.
    run(k).then(() => {
      const left = new Set(needed(k, a.layers).filter(n => failed(a.layers[n])).map(n => LAYERS[n].src)).size;
      if (typeof announce === 'function') {
        announce(left ? `Site exposure: ${left} source${left === 1 ? '' : 's'} still could not be read.`
                      : 'Site exposure: answered.');
      }
    });
  }

  return {
    key,
    html,
    ask,
    retry,
    // Everything asked and kept, forgotten — for a check that wants to start
    // clean. The queue is emptied too; what is in flight lands in nothing.
    clear() {
      for (const job of queue.splice(0)) job.reject(SUPERSEDED);
      answers.clear();
      asked.clear();
      wanted = null;
    },
  };
})();
if (typeof window !== 'undefined') window.SiteExposure = SiteExposure;
