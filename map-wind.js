// MegaNet — map-wind.js
//
//   MapWind   AS/NZS 1170.2 wind loading regions (A0–A5, B1, B2, C, D) drawn
//             over the Stations map, and "what wind region is this station
//             in?" answered on its callout — so a mast or aerial conversation
//             can start from the map instead of from the Standard's figure.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`; only from inside its own functions, so
// this file's position among the modules is free, the same way #120 left it
// for MapSurvey.
//
// The polygons are Geoscience Australia's machine-readable interpretation of
// the 2021 Standard's boundary definitions (eCat 146359), simplified to ~1 km
// and embedded at data/wind-regions-as1170-2021.geojson — no live service to
// be down. Fetched once, when the Stations map is first opened or a station
// card first asks, never at page load: 650 KB of continent is not part of
// opening the app. GA's metadata is blunt that the dataset is its
// *interpretation* and "not suitable for design purposes"; the note under the
// toggle says so, and nothing here should be read as a design determination.
// Licence: CC-BY 4.0 — the attribution rides the layer onto the map's
// attribution control and is restated in the note.
const MapWind = (function () {
  const DATA_URL    = 'data/wind-regions-as1170-2021.geojson';
  const ATTRIBUTION = 'Wind regions © Commonwealth of Australia (Geoscience Australia) 2021 CC-BY 4.0';

  // Its own pane in the shared z budget map-survey.js documents: below
  // contours (335), because the broadest context on the map goes lowest —
  // regions under contour lines under rivers under marks. Pointer events off,
  // like the spider legs' pane: a polygon the size of Queensland must never
  // take a click that a pin or a link line was drawn to answer.
  const PANE   = 'mnWind';
  const PANE_Z = 330;

  // ── The ten regions, in the Standard's own order ─────────────────────────
  //
  // One row per region rather than one per family (#176). "Wind regions A–D"
  // was a single legend line and a single green for six different A regions,
  // which told an operator standing at a mast site nothing they could act on:
  // the question behind "what region is this?" is always "so what does this
  // site have to be built for?", and that answer differs by region.
  //
  // `v500` is the 500-year ultimate regional wind speed V_R from Table 3.1 of
  // AS/NZS 1170.2:2021, in m/s — the figure the Standard's own region map is
  // usually read for, and the one whose *square* is the design pressure. That
  // squaring is why `times` is here: pressure goes with V², so Region D's 80
  // m/s against Region A's 45 is (80/45)² ≈ 3.2 times the load on the same
  // mast, which is the sentence a person actually needs. Computed in
  // pressureRatio() rather than typed, so the two can never drift.
  //
  // `cyclonic` follows the NCC's reading: cyclonic areas are wind regions B2,
  // C and D — B2 was carved out of the old Region B in 2021 precisely because
  // it is tropical-cyclone country. That matters more than the wind speed for
  // an aerial or a mast: it is what brings in wind-borne debris, the cyclonic
  // tie-down and connection detailing, and low-cycle fatigue.
  //
  // Colours are literal hexes rather than tokens, for ML_CARRIER_RING's
  // reason: Leaflet path options cannot take var(), and at fill-opacity .2
  // over map tiles neither theme needs its own set. The ramp is calm to
  // cyclonic, as it always was — the six A regions now differ from each other
  // only in shade, because they differ from each other only in direction
  // multipliers, not in design speed.
  const WIND_REGIONS = [
    { id: 'A0', color: '#1b5e20', v500: 45, cyclonic: false,
      where: 'Central Australia — roughly 200 km or more from any coast',
      note: 'New in 2021. Same design speed as the rest of A, but the Standard '
          + 'will not let a site here claim shelter: Terrain Category 2 is the '
          + 'floor up to 100 m of height whatever the ground actually looks '
          + 'like, and the topographic multiplier has its own form.' },
    { id: 'A1', color: '#2e7d32', v500: 45, cyclonic: false,
      where: 'Lower west coast — Perth and south',
      note: 'Non-cyclonic, and the mildest wind loading in the Standard — ordinary '
          + 'structural detailing, no debris or cyclonic provisions.' },
    { id: 'A2', color: '#388e3c', v500: 45, cyclonic: false,
      where: 'Coastal and near-coastal NSW, including Sydney',
      note: 'Non-cyclonic. Region A speeds; the direction multipliers differ from A3.' },
    { id: 'A3', color: '#43a047', v500: 45, cyclonic: false,
      where: 'Inland NSW and the ACT',
      note: 'Non-cyclonic. Region A speeds; the direction multipliers differ from A2.' },
    { id: 'A4', color: '#4caf50', v500: 45, cyclonic: false,
      where: 'Tasmania',
      note: 'Non-cyclonic. Region A speeds, with Tasmania’s own direction multipliers.' },
    { id: 'A5', color: '#66bb6a', v500: 45, cyclonic: false,
      where: 'Southern coast — Adelaide, Melbourne and the coast between',
      note: 'Non-cyclonic. Region A speeds; Melbourne and Adelaide were both '
          + 'folded into this region in 2021.' },
    { id: 'B1', color: '#fdd835', v500: 57, cyclonic: false,
      where: 'South-east Queensland and Norfolk Island',
      note: 'Thunderstorm country, not cyclone country: the higher speed is a '
          + 'downdraft figure. Still non-cyclonic detailing.' },
    { id: 'B2', color: '#fb8c00', v500: 57, cyclonic: true,
      where: 'The band behind the cyclonic coast — northern Australia, the '
           + 'mid-west and Pilbara hinterland, Torres Strait, Christmas Island',
      note: 'Carved out of the old Region B in 2021 because tropical cyclones '
          + 'reach it. Counts as a cyclonic area: wind-borne debris, cyclonic '
          + 'connection detailing and the 1.05 climate multiplier all apply, '
          + 'even though the wind speed matches B1.' },
    { id: 'C',  color: '#e53935', v500: 66, cyclonic: true,
      where: 'The cyclonic coast — northern Queensland, the Top End, the '
           + 'mid-west and Pilbara coasts, Cocos Island',
      note: 'Cyclonic. Wind-borne debris, cyclonic tie-downs and low-cycle '
          + 'fatigue on connections; the 1.05 climate multiplier applies.' },
    { id: 'D',  color: '#6a1b9a', v500: 80, cyclonic: true,
      where: 'Severe cyclonic — the Pilbara coast, and nowhere else in Australia',
      note: 'The most severe region in the Standard. Everything Region C asks '
          + 'for, against roughly three times a Region A site’s pressure.' },
  ];

  // The A regions share a design speed, so the pressure ratio is the honest
  // way to say "how much worse is this than the mild end of the country".
  const V_BASE = 45;

  // Derived rather than typed twice, and derived in the initialiser rather than
  // by a loop: everything in this file has to be a declaration (test/toplevel.mjs
  // descends into module IIFEs, and a bare statement here would be a file that
  // *does* something at load).
  //
  // The single-letter keys are family fallbacks read only by colorFor(), so a
  // feature spelled 'A6' or a plain 'B' by some future revision of the dataset
  // still draws in the right part of the ramp instead of grey. (The legend used
  // to take REGION_COLOR.A as its one swatch; since #176 it draws every region's
  // own colour out of regions(), and nothing asks for a family colour but the
  // map itself.)
  const REGION_BY_ID = Object.fromEntries(WIND_REGIONS.map(r => [r.id, r]));
  const REGION_COLOR = Object.fromEntries([
    ...WIND_REGIONS.map(r => [r.id, r.color]),
    ['A', '#43a047'], ['B', '#fdd835'],
  ]);

  function colorFor(region) {
    return REGION_COLOR[region] || REGION_COLOR[String(region || '')[0]] || '#607d8b';
  }

  // Design pressure goes with the square of the wind speed, so this is the
  // multiplier on the load the same mast carries in the mildest part of the
  // country. One decimal place: the figure is a sense of scale, not a design
  // number, and the note under it says so.
  function pressureRatio(v500) {
    return Math.round(Math.pow(v500 / V_BASE, 2) * 10) / 10;
  }

  // The region record behind an id, or null. 'A2' and 'A2 ' both resolve; an
  // id the dataset grows later resolves to null rather than to a wrong answer.
  function regionInfo(id) {
    return REGION_BY_ID[String(id || '').trim()] || null;
  }

  // How the pressure ratio should read. The six A regions ARE the baseline, so
  // "about 1.0× Region A's design pressure" is a sentence that says nothing;
  // they say so instead, and only the regions that differ carry a figure.
  function ratioText(v500) {
    const ratio = pressureRatio(v500);
    return ratio === 1
      ? 'the baseline the other regions are multiples of'
      : `about ${ratio.toFixed(1)}× Region A’s design pressure`;
  }

  // One line of plain English about a region, for a tooltip or a card: what it
  // costs, and whether it is cyclonic. Empty for an id we have no record of.
  function regionSummary(id) {
    const r = regionInfo(id);
    if (!r) return '';
    return `${r.v500} m/s (${Math.round(r.v500 * 3.6)} km/h) ultimate regional wind speed, `
         + `${ratioText(r.v500)} — ${r.cyclonic ? 'a cyclonic area' : 'non-cyclonic'}. ${r.note}`;
  }

  let map = null, layer = null, timer = null, seq = 0;
  let data = null, loading = null;
  let note = { kind: 'off' };

  function setNote(kind) {
    note = { kind };
    const el = document.getElementById('map-wind-note');
    if (el) el.innerHTML = noteHtml();
  }

  // The file is fetched at most once per page life; both success and failure
  // are remembered. Failure is worth remembering rather than retried on a
  // timer because the two ways this fails — file:// (fetch cannot read a
  // sibling file there) and offline — do not fix themselves mid-session, and
  // the checkbox itself is the retry: off and on again asks again.
  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { data = d; loading = null; return d; })
      .catch(err => { loading = null; throw err; });
    return loading;
  }

  function clearLayer() {
    if (layer && map) map.removeLayer(layer);
    layer = null;
  }

  function render() {
    if (!map || !state.mapWind || !data) return;
    clearLayer();
    layer = L.geoJSON(data, {
      pane: PANE,
      interactive: false,
      attribution: ATTRIBUTION,
      style: f => {
        const c = colorFor(f.properties && f.properties.region);
        return { color: c, weight: 1, opacity: 0.5, fillColor: c, fillOpacity: 0.2 };
      },
    }).addTo(map);
    setNote('on');
  }

  function run() {
    const mine = ++seq;
    setNote('loading');
    ensureData().then(() => {
      if (mine !== seq || !map || !state.mapWind) return;
      render();
    }).catch(() => {
      if (mine !== seq) return;
      setNote('fail');
    });
  }

  // Ray-cast point-in-polygon over the loaded features, even-odd across every
  // ring so holes count themselves out. ~10k vertices for the whole continent
  // — microseconds per ask, no index worth building. Answers null until the
  // layer has been turned on once, which is honest: the callout only claims a
  // region when the data that claims it is on hand (and, being ~1 km
  // simplified, the answer near a boundary is as indicative as the layer).
  function inRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function regionAt(lat, lon) {
    if (!data || lat == null || lon == null) return null;
    for (const f of data.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
                  : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        let hits = 0;
        for (const ring of poly) if (inRing(lat, lon, ring)) hits++;
        if (hits % 2 === 1) {
          return { region: f.properties.region, area: f.properties.area };
        }
      }
    }
    return null;
  }

  // ── "What wind region is this?" without the layer being on ────────────────
  //
  // The station callout and the station editor card both ask this, and neither
  // can wait for somebody to tick the layer on first — a mast conversation
  // starts from the station, not from the map display panel. So an ask fetches
  // the same file the layer draws.
  //
  // That is a deliberate softening of the rule the header states, not a
  // forgetting of it: nothing is fetched at *page load*, which is the half that
  // mattered. Opening a station's callout is an ask, one cached file (650 kB of
  // continent, ~135 kB over the wire) is what the answer costs, and every later
  // ask — every other station, every re-render of the card — is free.

  const ASK_TITLE = 'AS/NZS 1170.2:2021 wind region, from Geoscience Australia’s reading of the '
    + 'Standard (~1 km boundaries). Indicative — not a design determination.';

  // Remembered so the line can say "unavailable" rather than sit on
  // "looking up…" forever. Not a lockout: the next ask tries again, the same
  // way the layer's checkbox is its own retry.
  let askFailed = false;

  // What the line should read *right now*, from whatever is on hand. Callers
  // render this synchronously, so a station opened after the polygons have
  // landed shows its region with no flash of placeholder text.
  function regionState(lat, lon) {
    if (lat == null || lon == null) {
      return { text: '—', title: 'This station has no position recorded, so there is nothing to look up.' };
    }
    if (data) {
      const wr = regionAt(lat, lon);
      if (!wr) {
        return { text: 'outside the mapped regions',
                 title: 'This position falls outside every polygon in the dataset — offshore, or outside Australia.' };
      }
      // The summary leads the tooltip since #176: somebody hovering a station's
      // wind region wants to know what the letter costs them, and the provenance
      // sentence — which is the same on every station — reads better after it.
      const why = regionSummary(wr.region);
      return { text: `${wr.region}${wr.area ? ` (${wr.area})` : ''}`,
               title: why ? `${why}\n\n${ASK_TITLE}` : ASK_TITLE };
    }
    if (askFailed) {
      return { text: 'unavailable', title: 'The wind regions file could not be read — offline, or the app is '
                                         + 'running from file://. It is tried again on the next station.' };
    }
    return { text: 'looking up…', title: ASK_TITLE };
  }

  // Fill an element with the region at a point once the polygons are on hand.
  // A no-op when they already are — the caller rendered the answer itself — so
  // this only ever runs after a fetch, which is always after the markup it
  // writes into has reached the DOM.
  //
  // `data-mn-wind` on that element carries the point it was rendered for, and
  // is checked before writing: a card that re-rendered for a different station
  // while the file was in flight keeps its element id, and the answer to the
  // old question must not land in the new one.
  function askRegion(elId, lat, lon) {
    if (data || lat == null || lon == null) return;
    const key = `${lat},${lon}`;
    const fill = () => {
      const el = document.getElementById(elId);
      if (!el || el.dataset.mnWind !== key) return;
      const st = regionState(lat, lon);
      if (el.tagName === 'INPUT') el.value = st.text; else el.textContent = st.text;
      el.title = st.title;
    };
    ensureData().then(fill, () => { askFailed = true; fill(); });
  }

  const PROVENANCE = 'Geoscience Australia’s reading of AS/NZS 1170.2:2021 (CC-BY 4.0) — '
    + 'indicative only, ~1 km boundaries, not a design determination.';

  function noteHtml() {
    // The compact ramp, not the full key: the ten-row key with speeds and
    // implications lives in the map legend since #176, and printing it twice
    // would make the display flyout scroll past the switch it belongs to.
    const key = WIND_REGIONS.map(r =>
      `<span class="legend-dot" style="--dot:${r.color}"></span>&nbsp;${r.id}`).join(' &nbsp;');
    switch (note.kind) {
      case 'loading': return 'Fetching the wind regions…';
      case 'fail':    return 'The wind regions file could not be read — offline, or the app is '
                           + 'running from file://. Untick and re-tick to try again.';
      case 'on':      return `${key}<br>What each region means for a mast is in the map legend. ${PROVENANCE}`;
      default:        return 'Wind loading regions over the whole map, A0 (temperate interior) through D '
                           + '(severe cyclonic). ' + PROVENANCE;
    }
  }

  return {
    // The map legend's key (#176). One row per region, in the Standard's own
    // order, each carrying the colour drawn on the map, where it is, the
    // ultimate regional wind speed, how much design pressure that is against
    // the mildest part of the country, and what it means for a structure. The
    // legend renders these; nothing about how they are drawn lives here, and
    // nothing about what they mean lives there.
    //
    // A copy, not the array: the legend is not the place a region's colour
    // gets edited.
    regions() {
      return WIND_REGIONS.map(r => ({
        ...r,
        kmh: Math.round(r.v500 * 3.6),
        ratio: pressureRatio(r.v500),
        ratioText: ratioText(r.v500),
      }));
    },

    // The provenance sentence, so the legend states it in the same words the
    // display note does.
    provenance() { return PROVENANCE; },

    // What a region id means, in one line — the station card's tooltip and
    // anything else that has an id but no room for the key.
    regionSummary,


    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const pane = m.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';
      }
      if (state.mapWind) run();
    },

    detach() {
      clearTimeout(timer);
      clearLayer();
      map = null;
      seq++;
    },

    // Does the map display note claim the key right now?
    active() { return !!layer; },

    noteHtml,

    // What wind region a point sits in, from the loaded data — null until the
    // layer has fetched it. The station callout asks this.
    regionAt,

    // The pair the station callout and the station editor card use: what the
    // line reads now, and the fill that follows if the polygons are not on
    // hand yet. See the block above regionState().
    regionState,
    askRegion,

    // On by default and remembered, since #176 — MapSurvey's terms rather than
    // MapContours'. The reasoning that kept it off was "a layer that costs a
    // network request stays off until asked for", and it turned out not to
    // apply here: the station card asks for the same file the moment anybody
    // opens a station, so the fetch is not avoided by having the layer off —
    // it is only deferred, and in the meantime the map does not say which
    // regions the network crosses. One 650 KB file, browser-cached after the
    // first ask, drawn under everything. An operator who turns it off means
    // it, so like the rivers and survey switches the answer is remembered.
    setEnabled(on) {
      state.mapWind = on;
      try { localStorage.setItem('mn-wind', on ? 'on' : 'off'); } catch (_) {}
      if (!on) { clearLayer(); setNote('off'); seq++; return; }
      run();
    },
  };
})();
if (typeof window !== 'undefined') window.MapWind = MapWind;
