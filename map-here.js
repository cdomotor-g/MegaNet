// MegaNet — map-here.js
//
//   MapHere   "what is here" — a point on the map, and everything the app
//             already knows about the ground under it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc/escAttr, acmaHaversineKm,
// stationLatLonText and copyLatLonPillHtml; across to terrain.js, land-cover.js,
// map-wind.js, map-catchments.js, map-hubs.js and map-survey.js for the answers,
// and to app.js for the card furniture it shares with the station card. All of
// it from inside its own functions, so this file's position among the modules
// is free.
//
// ── Why this is one tool rather than six ─────────────────────────────────────
//
// Every fact this card prints was already in the app and every one of them was
// reachable only by asking about a *station*. Wind region, drainage basin,
// maintenance hub, ground height, land cover — the station card has them all,
// and the question that actually arrives on a map is the other one: *this hill
// here, not the site three kilometres away*. Siting a new repeater, judging
// where a road crosses a ridge, working out whose hub a complaint belongs to —
// none of those start from a station, and until this tool the only way to ask
// was to move a pin and read the card, which edits the network to answer a
// question about the ground.
//
// So: arm the tool, click the map, and the same answers come back about the
// point rather than about a station.
//
// ── What it will not do ──────────────────────────────────────────────────────
//
// It answers from what the app can reach and says so when it cannot reach it.
// Three of the rows are honest about a limit rather than quietly weaker:
//
//   * **Ground height** is a terrain tile, ~30 m sampling, above the EGM96
//     geoid — not AHD, and not a survey. The station card's own elevation row
//     is a *surveyed* figure and these two must never be read as the same
//     number, so this one names its datum every time.
//   * **Ground height (Elvis)** is the second answer to the same question, off
//     the best model Geoscience Australia holds at that point (#198) — which
//     is 1 m LiDAR over most of settled Queensland and the same ~30 m SRTM
//     elsewhere. It is in **AHD**, so unlike the row above it is comparable
//     with a station's surveyed elevation, and it names the resolution because
//     the two are not interchangeable.
//
//     The two rows are kept apart on purpose. Where they disagree that is
//     information rather than noise: over an incised creek a 1 m surface finds
//     the channel floor that a 30 m one smooths away, and a single averaged
//     number would throw exactly that away. It is also one request per pick
//     against an undocumented service, so it fails on its own without taking
//     the card with it.
//   * **The nearest survey mark** is the nearest mark the survey layer has
//     actually drawn. That layer fetches a viewport at a time past its own
//     minimum zoom, so with it off, or zoomed out, there is no answer — and the
//     card says that rather than reporting the nearest of nothing.
//   * **Land cover** is a 10 m raster class, which is a category and not a
//     measurement of the tree in front of you.
//
// ── One card at a time ───────────────────────────────────────────────────────
//
// This card shares its rectangle with the station card, the ACMA transmitter
// card and the radio-path card, and joins their exclusion: opening any of them
// closes the others. Four cards stacked in one corner is the failure that rule
// was written for.
const MapHere = (function () {
  const CARD_ID = 'here-card';
  // How far apart the two land-cover samples are, in degrees of longitude —
  // about 20 m, which is two pixels of a 10 m raster. The service samples a
  // path rather than a point, so it is asked for the shortest honest path
  // through the point and the reading at the point is the one taken.
  const COVER_STEP = 0.0002;

  let map = null, marker = null, armed = false, at = null;
  // Bumped whenever the point moves or the card closes, so an answer that was
  // out when the question changed is dropped rather than written into the card
  // it no longer describes. MapFade's generation counter, on a card.
  let gen = 0;
  let facts = {};

  // ── The pin ────────────────────────────────────────────────────────────────

  function icon() {
    return L.divIcon({
      className: 'mn-here-icon',
      html: '<div class="mn-here"><i class="mn-here-ring"></i><i class="mn-here-dot"></i></div>',
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
  }

  function place(lat, lon) {
    if (!map) return;
    if (marker) marker.remove();
    marker = L.marker([lat, lon], {
      icon: icon(), zIndexOffset: 1400, interactive: false,
      title: 'What is here',
    }).addTo(map);
  }

  // ── Asking ─────────────────────────────────────────────────────────────────

  function ask(lat, lon) {
    const mine = ++gen;
    facts = { elev: 'loading', elvis: 'loading', cover: 'loading', basin: 'loading', hub: 'loading' };
    const keep = fn => (...a) => { if (mine === gen) fn(...a); };

    Terrain.sample(lat, lon)
      .then(keep(m => { facts.elev = m == null ? null : m; render(); }),
            keep(() => { facts.elev = null; render(); }));

    // The same ground, asked of the nation's own model (#198). This is the row
    // that can say AHD — the datum every other height in this app is in, and
    // the one the terrain tile above is not — and can say whether the answer
    // came off 1 m LiDAR or the same ~30 m SRTM the tile did.
    //
    // One request, for one point, because a person clicked it. It resolves
    // either way and its own module holds a negative cache, so a network that
    // denies the host costs one slow call a minute rather than one per pick.
    Elvis.at(lat, lon)
      .then(keep(r => { facts.elvis = r && r.ok ? r : (r || null); render(); }),
            keep(() => { facts.elvis = null; render(); }));

    // Two samples twenty metres apart, because the cover service answers about
    // a path. The first is the point; the second is only there to make it one.
    LandCover.sample([lat, lat], [lon, lon + COVER_STEP])
      .then(keep(r => {
        facts.cover = r && r.ok && r.cls && r.cls[0] != null
          ? { code: r.cls[0], canopy: r.canopy ? r.canopy[0] : null } : null;
        render();
      }), keep(() => { facts.cover = null; render(); }));

    MapCatchments.ready()
      .then(keep(() => { facts.basin = MapCatchments.catchmentAt(lat, lon); render(); }),
            keep(() => { facts.basin = null; render(); }));

    MapHubs.ready()
      .then(keep(() => { facts.hub = MapHubs.hubAt(lat, lon); render(); }),
            keep(() => { facts.hub = null; render(); }));
  }

  // ── The answers that need no fetch ─────────────────────────────────────────

  // Nearest station, and nearest repeater, with the distance to each. Two rows
  // rather than one because they are two questions: "what is near here" and
  // "what could carry a radio put here", and on this network the answer is
  // very often not the same station.
  function nearestOf(lat, lon, pick) {
    if (!state.data) return null;
    let best = null, bestKm = Infinity;
    for (const s of state.data.stations) {
      if (s.lat == null || s.lon == null) continue;
      if (pick && !pick(s)) continue;
      const km = acmaHaversineKm(lat, lon, s.lat, s.lon);
      if (km < bestKm) { bestKm = km; best = s; }
    }
    return best ? { s: best, km: bestKm } : null;
  }

  // Which way, in words. A bearing in degrees is the precise answer and the
  // wrong one for a card: "8.4 km NNE" is what somebody standing here would
  // say, and the degrees are on the tooltip for anybody who wants them.
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  function bearing(fromLat, fromLon, toLat, toLon) {
    const rad = Math.PI / 180;
    const y = Math.sin((toLon - fromLon) * rad) * Math.cos(toLat * rad);
    const x = Math.cos(fromLat * rad) * Math.sin(toLat * rad)
            - Math.sin(fromLat * rad) * Math.cos(toLat * rad) * Math.cos((toLon - fromLon) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  function fmtKm(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`;
  }

  function awayRow(label, hit, onclick, title) {
    if (!hit) return acmaCardRow(label, null);
    const deg = bearing(at[0], at[1], hit.s.lat, hit.s.lon);
    const dir = COMPASS[Math.round(deg / 22.5) % 16];
    return `<div class="acma-row"><span>${esc(label)}</span><span>
      <button type="button" class="link-btn" onclick="${onclick}"
              title="${escAttr(title)}">${esc(hit.s.name)}</button>
      <span class="txt-muted" title="${escAttr(`${deg.toFixed(0)}° true`)}"
        >${esc(fmtKm(hit.km))} ${esc(dir)}</span></span></div>`;
  }

  // ── The card ───────────────────────────────────────────────────────────────

  function elevRow() {
    if (facts.elev === 'loading') return acmaCardRow('Ground height', 'reading the terrain…');
    if (facts.elev == null) {
      return acmaCardRow('Ground height', 'no terrain tile for this point');
    }
    return `<div class="acma-row"><span>Ground height</span><span
      title="AWS Terrain Tiles (SRTM/GMTED), ~30 m sampling, above the EGM96 geoid — not AHD, and not a survey."
      >${esc(Math.round(facts.elev))} m <span class="mn-pop-note">EGM96</span></span></div>`;
  }

  // The same question asked of Elvis, kept as its own row rather than folded
  // into the one above. Two models disagreeing about the ground is information
  // — over an incised creek a 1 m surface finds the channel floor a 30 m one
  // smooths away — and collapsing them to a single number would throw exactly
  // that away. The datum is on both rows for the same reason the row above
  // carries EGM96: these are not the same figure and must not read as one.
  function elvisRow() {
    if (facts.elvis === 'loading') {
      return acmaCardRow('Ground height (Elvis)', 'asking Geoscience Australia…');
    }
    if (!facts.elvis) {
      return acmaCardRow('Ground height (Elvis)', 'unavailable — offline, or the service refused');
    }
    if (!facts.elvis.ok) {
      return acmaCardRow('Ground height (Elvis)', esc(facts.elvis.error || 'no answer'));
    }
    const e = facts.elvis;
    const res = e.resolution ? ` <span class="mn-pop-note">${esc(e.resolution)}</span>` : '';
    const title = [
      'Elvis — Geoscience Australia / ICSM. Australian Height Datum.',
      e.source  ? `Source: ${e.source}.` : '',
      e.dataset ? `Dataset: ${e.dataset}.` : '',
      'The best model the nation holds here, which is not the ~30 m tile the row above reads.',
    ].filter(Boolean).join(' ');
    return `<div class="acma-row"><span>Ground height (Elvis)</span><span
      title="${esc(title)}"
      >${esc(e.height_m.toFixed(1))} m <span class="mn-pop-note">AHD</span>${res}</span></div>`;
  }

  function coverRow() {
    if (facts.cover === 'loading') return acmaCardRow('Land cover', 'looking it up…');
    if (!facts.cover) return acmaCardRow('Land cover', 'unavailable — offline, or the service refused');
    const c = LandCover.CLASSES[facts.cover.code];
    const stands = LandCover.heightOf(facts.cover.code);
    const canopy = facts.cover.canopy;
    const bits = [c ? c.label : `class ${facts.cover.code}`];
    if (canopy != null && canopy > 0) bits.push(`canopy ${Math.round(canopy)} m`);
    else if (stands != null && stands > 0) bits.push(`stands ~${stands} m`);
    return acmaCardRow('Land cover', bits.join(' · '));
  }

  function basinRow() {
    if (facts.basin === 'loading') return acmaCardRow('Drainage basin', 'looking it up…');
    if (!facts.basin) return acmaCardRow('Drainage basin', 'outside the mapped basins');
    const b = facts.basin;
    return `<div class="acma-row"><span>Drainage basin</span><span>
      <button type="button" class="link-btn" onclick="MapHere.showBasin('${escAttr(b.id)}')"
              title="Turn the catchments layer on and frame this basin"
        >${esc(b.name)}</button>
      <span class="txt-muted">${esc(b.basin_no != null ? `no. ${b.basin_no}` : '')}</span></span></div>`;
  }

  function hubRow() {
    if (facts.hub === 'loading') return acmaCardRow('Maintenance hub', 'looking it up…');
    if (!facts.hub) return acmaCardRow('Maintenance hub', 'outside the mapped hubs');
    return acmaCardRow('Maintenance hub', esc(facts.hub.name));
  }

  // The survey layer answers about what it has drawn, so this row is about the
  // layer as much as about the ground. Three states, each of them true.
  function surveyRow() {
    const hit = MapSurvey.nearest(at[0], at[1]);
    if (hit) {
      const name = hit.mark.name || hit.mark.number || 'mark';
      return `<div class="acma-row"><span>Nearest survey mark</span><span>
        <button type="button" class="link-btn" onclick="MapHere.showMark()"
                title="Open this mark's callout">${esc(name)}</button>
        <span class="txt-muted">${esc(fmtKm(hit.km))}</span></span></div>`;
    }
    if (!state.mapSurvey) {
      return `<div class="acma-row"><span>Nearest survey mark</span><span>
        <button type="button" class="link-btn" onclick="MapSurvey.setEnabled(true);MapHere.repaint()"
                title="Turn the survey-mark layer on — it draws from about zoom 12"
          >turn the layer on</button></span></div>`;
    }
    return acmaCardRow('Nearest survey mark',
      'none drawn here yet — the layer draws a viewport at a time from about zoom 12');
  }

  function cardHtml() {
    if (!at) return '';
    const [lat, lon] = at;
    const wind   = MapWind.regionState(lat, lon);
    const windId = 'mn-here-wind';
    MapWind.askRegion(windId, lat, lon);
    const near   = nearestOf(lat, lon);
    const rpt    = nearestOf(lat, lon, s => s.roles.includes('repeater'));
    const text   = stationLatLonText({ lat, lon });
    return `
      <div class="acma-card-head">
        <span><strong id="here-card-title">What is here</strong><br>
          <span class="small txt-muted">${esc(text)}</span></span>
        <button type="button" onclick="MapHere.close()"
                aria-label="Close the what-is-here card"><span aria-hidden="true">×</span></button>
      </div>
      <div class="acma-sect">
        ${elevRow()}
        ${elvisRow()}
        ${coverRow()}
        <div class="acma-row"><span>Wind region</span><span><span id="${windId}"
            data-mn-wind="${escAttr(`${lat},${lon}`)}"
            title="${escAttr(wind.title)}">${esc(wind.text)}</span>
            <span class="mn-pop-note">indicative</span></span></div>
        ${basinRow()}
        ${hubRow()}
      </div>
      <div class="acma-sect">
        ${awayRow('Nearest station', near, `MapHere.goToStation('${near ? escAttr(near.s.id) : ''}')`,
                  'Show this station on the map and open its card')}
        ${awayRow('Nearest repeater', rpt, `MapHere.goToStation('${rpt ? escAttr(rpt.s.id) : ''}')`,
                  'Show this repeater on the map and open its card')}
        ${surveyRow()}
      </div>
      <div class="pill-row stn-card-group" role="group" aria-label="What is here">
        ${copyLatLonPillHtml({ lat, lon })}
        <button type="button" class="pill" onclick="MapHere.zoom()"
                title="Zoom the map in on this point">🔍 Zoom here</button>
        <button type="button" class="pill${armed ? ' is-on' : ''}" onclick="MapHere.arm()"
                aria-pressed="${armed}"
                title="Pick another point">📍 ${armed ? 'Click the map…' : 'Pick another point'}</button>
      </div>
      <p class="small acma-card-note">
        Ground height and land cover are read off ~30 m terrain and a 10 m raster — context for
        siting, never a survey. The wind region is indicative.
      </p>`;
  }

  function render() {
    const el = document.getElementById(CARD_ID);
    if (!el) return;
    if (!at) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = cardHtml();
    el.hidden = false;
  }

  // ── Arming ─────────────────────────────────────────────────────────────────

  function syncCursor() {
    if (!map) return;
    map.getContainer().classList.toggle('mn-here-picking', armed);
  }

  function syncBtn() {
    for (const b of document.querySelectorAll('.mn-map-here')) {
      b.setAttribute('aria-pressed', String(armed));
      const label = armed ? 'Click the map to say where' : 'What is here?';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.classList.toggle('is-on', armed);
    }
  }

  // The 2-D map's own click. It is *not* the one the 3-D view uses — see pick()
  // below for why the coordinate this carries is the wrong one while the map is
  // tilted, and map-3d.js for the handler that stops it arriving at all.
  function onMapClick(e) {
    if (!armed || !e || !e.latlng) return;
    setPoint(e.latlng.lat, e.latlng.lng);
  }

  // The pin this tool drops is a Leaflet marker, and Leaflet is under the
  // canvas while 3-D is on. A no-op unless that mode is open.
  function syncThreeD() {
    if (typeof Map3D !== 'undefined' && Map3D.hereChanged) Map3D.hereChanged();
  }

  function setPoint(lat, lon) {
    at = [lat, lon];
    armed = false;
    syncThreeD();
    syncCursor();
    syncBtn();
    place(lat, lon);
    // The other three cards share this rectangle; only one of them is ever the
    // answer to what somebody just did.
    if (state.stnCard && state.stnCard.id) closeStnCard(false);
    if (state.acma && state.acma.cardDeviceId) closeAcmaCard(false);
    MapBackbone.closeCard(false);
    ask(lat, lon);
    render();
    announce(`What is here: ${stationLatLonText({ lat, lon })}. The card is under the map's left edge.`);
  }

  return {
    attach(m) {
      map = m;
      armed = false;
      at = null;
      map.on('click', onMapClick);
      syncCursor();
      syncBtn();
    },

    detach() {
      if (map) map.off('click', onMapClick);
      if (marker) marker.remove();
      marker = null;
      map = null;
      armed = false;
      at = null;
      gen++;
    },

    armed() { return armed; },

    // Where the last pick was, as [lat, lon], or null. The 3-D view mirrors it
    // onto the terrain (map-3d.js): the Leaflet marker `place()` drops is under
    // the WebGL canvas in that mode, and a card that answers about a point you
    // cannot see on the map is half an answer.
    point() { return at ? [at[0], at[1]] : null; },

    // ── A pick from somewhere that is not a Leaflet click (#194) ─────────────
    // `onMapClick` reads `e.latlng`, which is where that pixel is on the *2-D*
    // map. In 3-D that is the wrong question and it has a plausible answer: the
    // MapLibre camera has its own centre, zoom, pitch and bearing, so the two
    // agree only while it has not been moved and diverge without limit once it
    // has. Measured at ~150 m with the camera barely off the 2-D view.
    //
    // So the 3-D view does not let that click through at all; it calls this
    // with the lngLat its own renderer computed, which is the point under the
    // pointer on the terrain being looked at. Same pick, same card, same
    // answers — the only difference is which projection was asked.
    //
    // Returns whether it took the pick, so the caller can tell a pick from an
    // ordinary click on the ground.
    pick(lat, lon) {
      if (!armed || !isFinite(lat) || !isFinite(lon)) return false;
      setPoint(lat, lon);
      return true;
    },

    // The corner button, and the card's own "pick another point" pill.
    //
    // Arming takes the other click-takers off the map, exactly as MapMovePin
    // does on the way in: a draw tool and a link-budget end pick both answer
    // the same click, and two modes armed at once means one click doing two
    // things nobody asked for in an order nobody chose.
    arm(on) {
      armed = on == null ? !armed : !!on;
      if (armed) {
        if (state.draw && state.draw.tool) MapDraw.setTool('');
        LinkBudget.setPicking(false);
        if (MapMovePin.armed()) MapMovePin.cancel();
      }
      syncCursor();
      syncBtn();
      render();
      if (armed) announce('What is here is armed. Click the map to say where.');
    },

    close() {
      at = null;
      armed = false;
      gen++;
      if (marker) { marker.remove(); marker = null; }
      syncThreeD();
      syncCursor();
      syncBtn();
      render();
    },

    // Repaint from whatever is on hand — the survey row is the caller, because
    // turning that layer on changes this card's answer without changing the
    // point it is about.
    repaint() { render(); },

    zoom() {
      if (map && at) map.setView(at, Math.max(map.getZoom(), 14), { animate: true });
    },

    goToStation(id) {
      const s = id && state.data && state.data.stations.find(x => x.id === id);
      if (!s || s.lat == null) return;
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), 12), { animate: true });
      showStationCard(s.id);
    },

    showBasin(id) {
      if (!state.mapCatchments) MapCatchments.setEnabled(true);
      MapCatchments.zoomTo(id);
    },

    showMark() {
      if (!at) return;
      const hit = MapSurvey.nearest(at[0], at[1]);
      if (hit) MapSurvey.show(hit.mark);
    },
  };
})();
if (typeof window !== 'undefined') window.MapHere = MapHere;
