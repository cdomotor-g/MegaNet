// MegaNet — map-symbols.js
//
//   MapSymbols   What a station's pin says about the station beyond its role.
//                Its shape is what it measures: a triangle for a water level
//                (a river height gauge), a circle for a rain gauge and the
//                rest. Grey is a gauge read by hand, black a TM station (a data
//                logger and modem, not an ALERT radio). A solid pink outline is
//                the Bureau's forecast location and a dashed one its information
//                location. And whose stations, and which kinds, the map
//                draws at all.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js (state, esc, escAttr, announce, FILTER_NONE,
// stationSensors), to app.js (stationOwner, filterOptions, refreshMapLayers,
// rerenderMapLegend, updateMapMatchNote and the filter panel's redraws) and to
// sls.js (SLS), all from inside its own functions, so this file's position
// among the modules is free. Leaflet is reached the same way: the pin's shape
// goes into its canvas renderer the first time a pin is made, never at load
// (npm run toplevel).
//
// ── Why the pin changed ──────────────────────────────────────────────────────
// For its whole life a pin said one thing — its role, as a colour: field green,
// repeater blue, base orange — and 4,854 of the 4,874 stations are field
// stations, so on the map nearly every pin said the same thing. What somebody
// looking at a catchment wants to know first is the next question down: which
// of these are river gauges and which are rain gauges, which ones does the
// Bureau forecast, and which ones does nobody hear over the radio because a
// person reads them. The Bureau's own flood maps answer the first two with
// shape and outline — river heights are triangles, its forecast and
// information locations are outlined — and this follows that key rather than
// inventing another, so a map read here reads the same as one read there. The
// Bureau's key outlines them in purple and pink; at the owner's request both
// are its pink here, a forecast location's solid and an information
// location's dashed, so the dash says which and not a second colour.
//
//   shape    A triangle for a station that measures a water level — a river
//            height gauge, and a storage or tide gauge with it, since a height
//            of water is what all three record. A circle for everything else,
//            the rain gauges first among them. A station that measures both is
//            a triangle: the river height is the rarer and the more urgent
//            reading, and a combined site is a river gauge with a rain gauge
//            beside it, not the other way round.
//   fill     Grey for a gauge read by hand. Silence from it is not a fault —
//            nothing reports it over the radio — and grey is what says so from
//            across the map, before anybody opens a card to find out why
//            Flood-Net has never heard it. Black for a TM station: a data
//            logger read over a modem rather than an ALERT radio, so the
//            receivers never hear it either and its silence on them means
//            nothing — the field green is left saying ALERT.
//   outline  The Bureau's forecast location (Schedule 2 of its Service Level
//            Specification — somebody predicts a height for it) in a solid
//            pink, its information location (Schedule 3 — reported and
//            classified, not predicted) in a dashed one. Drawn round the
//            outside of the pin's own white ring, not instead of it, so a
//            match's amber, a selection's violet and a health ring still have
//            the ring to say themselves with.
//
// The shape, the grey, the black and the outline are each a switch in 🗺️ Map
// display (Station pins), on by default and remembered, on MapArrows' terms: none of them costs anything the
// map is not already paying for, and an operator who turns one off means it.
// Colour pins by health takes the fill when it is on — the fill is health then
// — and leaves the shape and the outline alone, because neither says anything
// health does.
//
// ── Where each answer comes from ─────────────────────────────────────────────
// No one field says any of it, so kind() reads every field that says some of
// it, the same evidence the Digital Twin builds a station's structure from
// (digital-twin.js, stationKind) and to the same rules where the two overlap:
//
//   water level  a Water Level or Gas Pressure sensor (a gas-purge bubbler is a
//                water level gauge), a water_level ALERT address, a station
//                type of *_water_level, a Water Level, Reservoir or Tide
//                location type, the Bureau's river height index (Section 3 of
//                its Queensland flood warning station lists), or the SLS saying
//                River, or naming it a forecast, information or river data
//                location — all three are river height locations.
//   rainfall     a Rainfall sensor or address, *_rain_gauge, a Rain Gauge
//                location type, the Bureau's rainfall indexes (Sections 1 and
//                2), or the SLS saying Rainfall.
//   by hand      the station type says manual_*; or, where it does not say
//                auto_*, the SLS calls the gauge Manual; or, where neither says
//                either way, the Bureau reads it daily (Section 2) and nothing
//                in the record says a radio does. The twin's rule, with a
//                repeater's or a base's role counted as a radio, as it is.
//   by radio     the station type says auto_*, or there is an ALERT address,
//                an AL, ALERT or TM on the end of the name, a satellite
//                terminal, a telemetry form, a repeater's or a base's role — or
//                the SLS calls the gauge Automatic.
//   TM           the digital twin's telemetry rule (stationKind): the Telemetry
//                field saying a Campbell or older data logger; else, where it
//                does not say ALERT, a TM on the end of the name; else, with no
//                AL or ALERT on the name and no ALERT address, a satellite
//                terminal. Never a gauge read by hand, and never a repeater or
//                a base, whose own colour is the more important thing to say.
//   SLS role     forecast beats information beats river data, as the card says
//                it (sls.js, roleText), across both documents for a station on
//                the border.
//
// ── What it costs ────────────────────────────────────────────────────────────
// The SLS file. sls.js fetches it once, the first time something asks, and
// never at page load; the Stations map now asks once it is drawn — the grey,
// the outlines and the owners all come from it — and paints the pins again when
// it lands. 1.2 MB of schedule is 90 KB on the wire, and the pins are on the
// screen the whole time: a pin that is grey or outlined a second late is a
// better trade than a first paint held back for it. A file that does not load
// leaves the record's own evidence — the shapes are nearly all from the record
// anyway — and the notes under the switches and the owner say what is missing.
//
// ── Whose stations ───────────────────────────────────────────────────────────
// The other half of this file is a question about the map rather than about a
// station: an operator who works for one council, or only on the Bureau's
// network, can have the map draw only that owner's stations — or every owner's
// but theirs. One owner, picked from the same list (and the same counts) as the
// Filters' Owner block, which is where to go for two or more. It is the map's
// and only the map's: the station list and the filters are untouched, as they
// are by Hide stations that don't match, and like that switch it is
// session-only — a map that opens next week missing three quarters of the
// network, over a choice made today, reads as data that has gone. The note
// under the Filters' match line says how many it is not drawing.
//
// Beside it, which kinds: a box each for field stations, repeaters and base
// stations, all ticked to begin with, so the field pins can come off and leave
// the repeater network on its own — or the other way round. On the same terms
// as the owner: the map's only, session-only, said on the match line. drawn()
// is the two together, and the one question the map asks of a station.
//
// Exposes: kind, pin, radius, marker, reset, ownersReady, askSls, slsFailed,
//          drawn, roleDrawn, linkDrawn, hiding, drawingPhrase, drawnNoteShort, ownerDrawn,
//          ownerHiding, ownerPhrase, ownerParties, sectionHtml, ownerHtml,
//          rolesHtml, noteHtml, legendHtml, legendOff, setShapes, setManual,
//          setTm, setOutlines, setOwner, setOwnerMode, setRole, the colours
//          FORECAST, INFORMATION, MANUAL and TM, the information outline's
//          INFORMATION_DASH and the triangle's TRI_SCALE.
const MapSymbols = (function () {
  // The pink sampled off the Bureau's own key for its flood warning map, and a
  // literal for the reason the ACMA squares' are: it is that key's colour and
  // means what it means there, so a theme does not restyle it. Both outlines
  // wear it; an information location's is dashed, which is what tells the two
  // apart — on the pins, the legend, the 3-D view and the AR finder alike.
  const FORECAST    = '#ff00c5';
  const INFORMATION = '#ff00c5';
  const INFORMATION_DASH = [4, 3];
  // A gauge read by hand. A mid grey that is none of the role fills, not the
  // hollow white of a proposed or unheard pin, and still a fill under the white
  // ring every pin wears, so it reads on a satellite base as well as a topo.
  const MANUAL      = '#7b8189';
  // A TM station. Black, under the same white ring, so it is told from the
  // field green of an ALERT station and the grey of a manual gauge at a glance.
  const TM          = '#000000';
  // The outline's own weight. Heavier than a pin's ring (2) so it reads as a
  // second shape round the first rather than as a thicker ring, and lighter
  // than a selection's (4), which outranks it.
  const OUTLINE_W   = 2.5;
  // A triangle's circumradius against the circle it replaces. At 1 the
  // triangle inside a 5 px circle is a speck beside its neighbours: a triangle
  // covers 41% of its circumcircle. At 1.4 it is the circle's height and a
  // little wider, which is what reads as the same size of pin. The radius a
  // triangle pin carries *is* its circumradius, so every caller that sizes off
  // getRadius() — the click target, the leader's ring, the labels' offset, the
  // selection's grow — gets the triangle's real extent without knowing it is
  // one.
  const TRI_SCALE   = 1.4;

  // station → { gen, k }. A rebuild asks for every pin's kind and every filter
  // keystroke for every station's, so it is worked out once; `gen` moves when
  // the SLS lands and when a station is saved (refreshFilterOptions), which
  // are the two things that change an answer.
  let kinds = new WeakMap();
  let gen = 0;
  // The SLS file: sent for, and failed. Failed is worth knowing apart from not
  // yet asked — it is the difference between "looking it up" and "it did not
  // load" in every note that depends on it.
  let slsAsked = false;
  let slsFailed = false;

  const slsLoaded = () => typeof SLS !== 'undefined' && SLS.loaded();
  // Whether every owner can be told yet — Health's ownersReady, for the same
  // reason: until the file lands a station with no owner of its own is not
  // known to have none.
  const ownersReady = () => typeof SLS === 'undefined' || slsLoaded() || slsFailed;

  // ── What a station is ──────────────────────────────────────────────────────

  function kind(s) {
    if (!s) return null;
    const hit = kinds.get(s);
    if (hit && hit.gen === gen) return hit.k;
    const k = work(s);
    kinds.set(s, { gen, k });
    return k;
  }

  function work(s) {
    const sensors = typeof stationSensors === 'function' ? stationSensors(s) : (s.sensors || []);
    const types = sensors.map(x => String((x && x.type) || ''));
    const aids = s.alert_ids || {};
    const locs = Array.isArray(s.location_types) ? s.location_types.map(String) : [];
    const stype = String(s.station_type || '');
    const cfg = String(s.inspection_config_key || '');
    const sections = (Array.isArray(s.bureau_listings) ? s.bureau_listings : [])
      .map(b => String(b && b.section));
    // Every document's entry: a station on the border is in both, and the
    // forecast location's solid outline belongs to it if either forecasts for it.
    const sls = slsLoaded() && SLS.entriesFor ? SLS.entriesFor(s) : [];
    const first = sls[0] || null;
    const slsData = sls.map(e => String(e.data_type || '')).join(' ');
    const role = sls.some(e => e.forecast_location) ? 'forecast'
      : sls.some(e => e.information_location) ? 'information'
      : sls.some(e => e.river_data_location) ? 'river_data' : null;

    const river = types.some(t => /^(Water Level|Gas Pressure)/i.test(t))
      || aids.water_level != null || /_water_level$/.test(stype) || cfg === 'gas_only'
      || locs.some(l => /^(Water Level|Reservoir|Tide)/i.test(l))
      || sections.includes('3') || /river/i.test(slsData) || role != null;
    const rain = types.some(t => /^Rainfall/i.test(t)) || aids.rainfall != null
      || /_rain_gauge$/.test(stype) || locs.includes('Rain Gauge')
      || sections.includes('1') || sections.includes('2') || /rainfall/i.test(slsData);

    // The SLS's first entry, as the twin reads it — the two documents have
    // never disagreed about a gauge's type, and if they ever do the more
    // specific statement of service is the one quoted everywhere else.
    const slsGauge = String((first && first.gauge_type) || '');
    const typeManual = /^manual_/.test(stype), typeAuto = /^auto_/.test(stype);
    const roles = Array.isArray(s.roles) ? s.roles : [];
    const suffix = (/\s(AL|ALERT|TM)$/i.exec(String(s.name || '').trim()) || [])[1];
    const alertAddr = sensors.some(x => x && x.alert_id != null) || Object.keys(aids).length > 0;
    const satcom = !!(s.satcom && s.satcom.enabled);
    const radio = alertAddr || !!suffix || satcom
      || ['alert', 'campbell_datalogger', 'datalogger_old', 'mace', 'gas_only', 'base_station'].includes(cfg)
      || roles.includes('repeater') || roles.includes('base');
    const manual = typeManual
      || (!typeAuto && (/^manual$/i.test(slsGauge)
        || (!/^automatic$/i.test(slsGauge) && !radio && sections.includes('2'))));
    const auto = !manual && (typeAuto || radio || /^automatic$/i.test(slsGauge));
    // TM as the twin decides it (digital-twin.js, stationKind): the Telemetry
    // field first, then the name, then the satellite terminal.
    const tmSaid = cfg === 'campbell_datalogger' || cfg === 'datalogger_old' ? true
      : cfg === 'alert' ? false
      : suffix ? /^TM$/i.test(suffix)
      : !alertAddr && satcom;
    const tm = tmSaid && !manual && !roles.includes('repeater') && !roles.includes('base');
    return { river, rain, manual, auto, tm, role, sls: sls.length > 0 };
  }

  // What the pin wears, with the switches applied. `outline` is a colour or
  // null, `outlineDash` its dash or null for a solid line; the fill is the
  // caller's, which knows about health and proposals.
  function pin(s) {
    const k = kind(s);
    const role = state.mapPinSls && k ? k.role : null;
    return {
      triangle: !!(state.mapPinShapes && k && k.river),
      manual:   !!(state.mapPinManual && k && k.manual),
      tm:       !!(state.mapPinTm && k && k.tm),
      outline:  role === 'forecast' ? FORECAST : role === 'information' ? INFORMATION : null,
      outlineDash: role === 'information' ? INFORMATION_DASH : null,
    };
  }

  // The radius a pin of this circle's size is drawn at.
  function radius(r, sym) {
    return sym && sym.triangle ? Math.round(r * TRI_SCALE * 10) / 10 : r;
  }

  // ── The pin ────────────────────────────────────────────────────────────────
  // A CircleMarker that may be a triangle and may carry an outline: three
  // options (`mnShape`, `mnOutline` and its `mnOutlineDash`) — and a fourth,
  // `mnBars` { n, fill }, ⏱️ Latency & signal's signal bars at its right
  // (map-latency.js barsFor) — and one drawing
  // routine on the canvas renderer the Stations map draws with (preferCanvas, app.js initMap). Everything else is
  // CircleMarker's own, which is the point — setStyle, setRadius, the click
  // test, setLatLng for the fan-out, the 3-D mirror reading `options` — every
  // caller that restyles a pin goes on doing exactly what it did.
  //
  // The click target stays the circumcircle: a triangle's corners are where a
  // finger lands short of its middle, and a target a little larger than the
  // mark is what every pin here has always had (the renderer's tolerance).
  // The outline widens the pin's bounds, so a redraw of the canvas round a pin
  // clears and repaints the whole of it rather than leaving its edges behind.
  let Pin = null;

  // An equilateral triangle, point up, its centroid on the station.
  function triPath(ctx, x, y, r) {
    const w = r * Math.sqrt(3) / 2;
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + w, y + r / 2);
    ctx.lineTo(x - w, y + r / 2);
    ctx.closePath();
  }

  // Where the outline runs: just outside the ring, stroke against stroke. A
  // triangle's edges are half its circumradius from its middle, so it has to
  // grow twice as far as a circle to clear the same ring by the same width.
  function outlineR(r, weight, tri) {
    const gap = (weight || 0) / 2 + OUTLINE_W / 2;
    return tri ? r + 2 * gap : r + gap;
  }

  // The signal bars: four rising bars on a white plate at the pin's right, `n`
  // of them lit in `fill` and the rest faint, so the count says what the
  // colour says. The right is the side nothing else uses — the name label
  // hangs below a pin and its tooltip above it. The plate is the pins' white
  // ring's reason: it reads over the satellite imagery and the topo alike.
  // Its top-left corner and size, for the drawing and the bounds.
  const BARS_W = 14, BARS_H = 12;
  function barsBox(x, y, r, weight) {
    return { x: x + r + (weight || 0) / 2 + 1.5, y: y - 8, w: BARS_W, h: BARS_H };
  }
  function drawBars(ctx, p, r, o) {
    const b = barsBox(p.x, p.y, r, o.weight);
    ctx.save();
    ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.beginPath();
    const k = 2.5, x0 = b.x + 0.5, y0 = b.y + 0.5, x1 = b.x + b.w - 0.5, y1 = b.y + b.h - 0.5;
    ctx.moveTo(x0 + k, y0);
    ctx.arcTo(x1, y0, x1, y1, k);
    ctx.arcTo(x1, y1, x0, y1, k);
    ctx.arcTo(x0, y1, x0, y0, k);
    ctx.arcTo(x0, y0, x1, y0, k);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(31, 41, 51, .45)';
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const h = 3 + 2 * i;
      ctx.fillStyle = i < o.mnBars.n ? o.mnBars.fill : 'rgba(79, 100, 120, .28)';
      ctx.fillRect(b.x + 1.5 + 3 * i, b.y + 10.5 - h, 2, h);
    }
    ctx.restore();
  }

  function pinClass() {
    if (Pin) return Pin;
    L.Canvas.include({
      _updateMnPin(layer) {
        if (!this._drawing || layer._empty()) return;
        const p = layer._point, ctx = this._ctx, o = layer.options;
        const tri = o.mnShape === 'triangle';
        const r = Math.max(layer._radius, 1);
        if (o.mnOutline && o.stroke !== false) {
          ctx.beginPath();
          if (tri) triPath(ctx, p.x, p.y, outlineR(r, o.weight, true));
          else ctx.arc(p.x, p.y, outlineR(r, o.weight, false), 0, Math.PI * 2, false);
          // Butt ends: a round cap reaches half the line's width into each
          // gap, and at this weight would close the dashes up.
          if (ctx.setLineDash) ctx.setLineDash(o.mnOutlineDash || []);
          ctx.globalAlpha = o.opacity;
          ctx.lineWidth = OUTLINE_W;
          ctx.strokeStyle = o.mnOutline;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'butt';
          ctx.stroke();
        }
        ctx.beginPath();
        if (tri) triPath(ctx, p.x, p.y, r);
        else ctx.arc(p.x, p.y, Math.max(Math.round(r), 1), 0, Math.PI * 2, false);
        this._fillStroke(ctx, layer);
        if (o.mnBars && o.mnBars.n) drawBars(ctx, p, r, o);
      },
    });
    Pin = L.CircleMarker.extend({
      // A renderer without the routine (an SVG fallback) draws the circle it
      // always drew, which is a pin with less to say rather than no pin.
      _updatePath() {
        if (this._renderer._updateMnPin) this._renderer._updateMnPin(this);
        else this._renderer._updateCircle(this);
      },
      _updateBounds() {
        L.CircleMarker.prototype._updateBounds.call(this);
        const o = this.options;
        if (!this._pxBounds) return;
        if (o.mnOutline) {
          const reach = outlineR(this._radius, o.weight, o.mnShape === 'triangle') + OUTLINE_W / 2
            + this._clickTolerance();
          this._pxBounds.extend(this._point.subtract([reach, reach]));
          this._pxBounds.extend(this._point.add([reach, reach]));
        }
        // The bars sit outside the circle: a redraw round the pin clears and
        // repaints them with it.
        if (o.mnBars && o.mnBars.n) {
          const b = barsBox(this._point.x, this._point.y, Math.max(this._radius, 1), o.weight);
          this._pxBounds.extend(L.point(b.x - 1, b.y - 1));
          this._pxBounds.extend(L.point(b.x + b.w + 1, b.y + b.h + 1));
        }
      },
    });
    return Pin;
  }

  function marker(latlng, options) {
    const P = pinClass();
    return new P(latlng, options);
  }

  // ── The SLS, sent for when something here needs it ────────────────────────
  // Needed by the grey and the outline, and by the Filters' Owner and Gauge
  // blocks; the shapes need it only for a handful the record does not say.
  function needSls() {
    return state.mapPinManual || state.mapPinSls;
  }

  function askSls(force) {
    if (typeof SLS === 'undefined' || slsLoaded()) return;
    if (slsAsked && !force) return;
    slsAsked = true;
    slsFailed = false;
    paintNotes();
    SLS.ensureData().then(arrived, () => { slsFailed = true; arrived(); });
  }

  // The answer changes kind() for 3,253 stations — the outlines and the grey
  // appear, the owners are known — so everything that reads it is asked again:
  // the pins (once, as Colour pins by health repaints them when its answer
  // lands), the filters' option lists and whatever of them is filtering, the
  // legend and the notes. The filter panel is not redrawn wholesale: somebody
  // may be typing in its search box, and only the two blocks that waited for
  // the file have anything new to show.
  function arrived() {
    gen++;
    if (typeof state === 'undefined' || !state.data) return;
    state.filterOpts = null;
    if (state.activeTab === 'stations') {
      if (typeof rerenderFilterGroup === 'function') rerenderFilterGroup('owners');
      if (typeof rerenderFilterGauge === 'function') rerenderFilterGauge();
      const f = state.filters;
      const filtering = f.owners.size || f.measures || f.readBy || f.slsRole;
      if (filtering && typeof stationsFilterChanged === 'function') stationsFilterChanged();
      else if (state.map && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
      if (typeof updateFilterChrome === 'function') updateFilterChrome();
    }
    paintOwnerControl();
    paintNotes();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  // A station saved or deleted: its answer may have moved.
  function reset() {
    gen++;
    kinds = new WeakMap();
  }

  // ── Whose stations the map draws ───────────────────────────────────────────

  function ownerParties(s) {
    const o = typeof stationOwner === 'function' ? stationOwner(s) : null;
    if (o) return o.parties;
    return ownersReady() ? [FILTER_NONE] : [];
  }

  function ownerHiding() {
    return !!state.mapOwner;
  }

  function ownerDrawn(s) {
    if (!state.mapOwner) return true;
    const has = ownerParties(s).includes(state.mapOwner);
    return state.mapOwnerMode === 'except' ? !has : has;
  }

  function ownerLabel(v) {
    return v === FILTER_NONE ? 'no owner on record' : v;
  }

  // "Seqwater's" / "every owner's but Seqwater's", for the notes and the map's
  // name. The none-on-record bucket is said in words, never as an apostrophe.
  function ownerPhrase() {
    const v = state.mapOwner;
    if (!v) return '';
    if (v === FILTER_NONE) {
      return state.mapOwnerMode === 'except'
        ? 'only stations with an owner on record' : 'only stations with no owner on record';
    }
    return state.mapOwnerMode === 'except' ? `every owner's stations but ${v}'s` : `only ${v}'s stations`;
  }

  // Stations with a position the map leaves off: by the owner choice and the
  // kinds together, unless asked about one of them.
  function hiddenCount(isDrawn = drawn) {
    if (!hiding() || !state.data) return 0;
    let n = 0;
    for (const s of state.data.stations) {
      if (s.lat != null && s.lon != null && !isDrawn(s)) n++;
    }
    return n;
  }

  // ── Which kinds of station the map draws ───────────────────────────────────
  // A station is the kind its pin's colour says (primaryRole), as the AR
  // finder counts them: a field station that also repeats is a repeater here,
  // a repeater that is also a base a base — so a pin is never left on the map
  // in the colour of a box that is unticked. A station with no role on record,
  // or a satcom one, is a field station, as its green pin says.
  const ROLES = ['field', 'repeater', 'base'];
  const ROLE_NAME = { field: 'Field stations', repeater: 'Repeaters', base: 'Base stations' };
  const ROLE_MEANING = {
    field:    'A station at a site that measures — a river height or a rain gauge — and sends its readings out by radio. Green pins (grey if read by hand, black if a TM station); nearly the whole network.',
    repeater: 'A radio station on high ground that hears field stations and passes their messages on, towards a base station they could not reach on their own. Blue pins, drawn bigger. A field station that also repeats counts as a repeater here.',
    base:     'Where the radio messages end up: a receiving station that hears the repeaters, and any field station near enough, and hands the readings on to the people who use them. Orange pins.',
  };

  function roleOf(s) {
    return typeof primaryRole === 'function' && Array.isArray(s.roles) ? primaryRole(s) : 'field';
  }

  function roleDrawn(s) {
    const off = state.mapRolesOff;
    return !off || !off.size || !off.has(roleOf(s));
  }

  function rolesHiding() {
    return !!(state.mapRolesOff && state.mapRolesOff.size);
  }

  // "only repeaters and base stations" / "no stations at all".
  function rolesPhrase() {
    const on = ROLES.filter(r => !state.mapRolesOff.has(r)).map(r => ROLE_NAME[r].toLowerCase());
    return on.length ? `only ${on.join(' and ')}` : 'no stations at all';
  }

  // What the map asks of a link before it draws one: both ends on the map. A
  // pass-range link ({ s, r }) is a field station reporting in, so it goes
  // with Field stations unticked even from a station that is also a repeater —
  // its pin stays, as the repeater it is drawn as, without its own reports'
  // lines. A backbone path ({ a, b }) needs only its two ends.
  function linkDrawn(l) {
    if (!rolesHiding()) return true;
    if (l.s) return !state.mapRolesOff.has('field') && roleDrawn(l.s) && roleDrawn(l.r);
    return roleDrawn(l.a) && roleDrawn(l.b);
  }

  // What the map asks of every station before it draws one.
  function drawn(s) {
    return ownerDrawn(s) && roleDrawn(s);
  }

  function hiding() {
    return ownerHiding() || rolesHiding();
  }

  // The owner and the kinds in one phrase, for the match line and the map's
  // accessible name: "only Seqwater's stations, and of those only repeaters".
  function drawingPhrase() {
    if (!rolesHiding()) return ownerPhrase();
    if (!ownerHiding()) return rolesPhrase();
    return ROLES.every(r => state.mapRolesOff.has(r))
      ? rolesPhrase() : `${ownerPhrase()}, and of those ${rolesPhrase()}`;
  }

  // The Filters' match line's half: said wherever the station count is said,
  // because a map missing pins with nothing on screen saying why reads as a
  // file that failed to load.
  function drawnNoteShort() {
    if (!hiding()) return '';
    const n = hiddenCount();
    return ` · the map is drawing ${esc(drawingPhrase())} — <strong>${n.toLocaleString()}</strong> not drawn (Layers)`;
  }

  function roleCounts() {
    const out = { field: 0, repeater: 0, base: 0 };
    if (!state.data) return out;
    for (const s of state.data.stations) {
      if (s.lat == null || s.lon == null) continue;
      const r = roleOf(s);
      if (r in out) out[r]++;
    }
    return out;
  }

  function rolesNoteHtml() {
    if (!rolesHiding()) {
      return 'Field stations measure, repeaters pass their messages on, base stations receive them. '
        + 'A station that is two of these counts as the one its pin’s colour shows.';
    }
    const n = hiddenCount(roleDrawn);
    return `Drawing ${esc(rolesPhrase())}: <strong>${n.toLocaleString()}</strong> station${
      n === 1 ? '' : 's'} not drawn, and the links that run to them${state.mapRolesOff.has('field')
      ? ' — with every field station’s link to its repeater' : ''}. The list and the filters are as they were.`;
  }

  // A card of its own at the head of Stations & links: three boxes under a
  // title, as Link colour's radios are. The counts are pins — stations with a
  // position — so they add up to what the map can draw.
  function rolesHtml() {
    const c = roleCounts();
    return `
    <div role="group" class="mapd-roles" id="map-roles-block" aria-labelledby="map-roles-h">
      <div class="mapd-card-title" id="map-roles-h">Show these stations</div>
      ${ROLES.map(r => `
      <label class="filter-check" title="${escAttr(ROLE_MEANING[r])}">
        <input type="checkbox" data-map-role="${r}" ${state.mapRolesOff.has(r) ? '' : 'checked'}
               onchange="MapSymbols.setRole('${r}', this.checked)">
        ${ROLE_NAME[r]} <span class="txt-muted">(${c[r].toLocaleString()})</span>
      </label>`).join('')}
    </div>
    <p class="filter-note" id="map-roles-note">${rolesNoteHtml()}</p>`;
  }

  function ownerOptions() {
    if (!ownersReady() || typeof filterOptions !== 'function') return [];
    return (filterOptions().owners || []);
  }

  function ownerControlHtml() {
    const opts = ownerOptions();
    const cur = state.mapOwner;
    const on = !!cur;
    // A choice that is no longer on offer — a station saved with a new owner
    // took the last of someone's — is kept on the list, at nought, rather than
    // being quietly swapped for a different answer.
    const list = cur && !opts.some(o => o.value === cur)
      ? opts.concat([{ value: cur, label: cur === FILTER_NONE ? 'No owner on record' : cur, count: 0 }])
      : opts;
    const sel = ownersReady()
      ? `<select id="map-owner" aria-label="Owner whose stations the map draws, or leaves off"
                 onchange="MapSymbols.setOwner(this.value)">
          <option value="">Every owner's stations</option>
          ${list.map(o => `<option value="${esc(o.value)}" ${cur === o.value ? 'selected' : ''}>${
            esc(o.value === FILTER_NONE ? 'No owner on record' : o.label)} (${Number(o.count).toLocaleString()})</option>`).join('')}
        </select>`
      : `<select id="map-owner" aria-label="Owner whose stations the map draws, or leaves off" disabled>
          <option>Looking up the owners…</option>
        </select>`;
    return `
      <label class="filter-field"
             title="Draw one owner's stations and leave everyone else's off the map — or the other way round. The owner the Bureau's Service Level Specification names, else the one recorded on the station; a joint owner counts under each party. The station list and the filters are not changed: the Filters' Owner block is the way to filter by owner, and to pick two or more.">
        <span>Owner</span>
        ${sel}
      </label>
      <div class="mapd-owner-mode" role="radiogroup" aria-label="Draw that owner's stations, or every other owner's">
        ${[['only', 'Only theirs'], ['except', 'Everyone’s but theirs']].map(([v, l]) => `
          <label class="filter-check${on ? '' : ' is-off'}">
            <input type="radio" name="map-owner-mode" value="${v}"
                   ${state.mapOwnerMode === v ? 'checked' : ''} ${on ? '' : 'disabled'}
                   onchange="MapSymbols.setOwnerMode('${v}')">
            ${l}
          </label>`).join('')}
      </div>
      <p class="filter-note" id="map-owner-note">${ownerNoteHtml()}</p>`;
  }

  function ownerNoteHtml() {
    if (!ownersReady()) {
      return 'Most owners come from the Bureau’s Service Level Specification, which is being looked up.';
    }
    if (!state.mapOwner) {
      return slsFailed
        ? 'The Service Level Specification did not load, so only the owners recorded on stations are listed.'
        : 'Every owner’s stations are drawn.';
    }
    const n = hiddenCount(ownerDrawn);
    return `Drawing ${esc(ownerPhrase())}: <strong>${n.toLocaleString()}</strong> station${
      n === 1 ? '' : 's'} not drawn. The list and the filters are as they were.`;
  }

  function paintOwnerControl() {
    const el = document.getElementById('map-owner-block');
    if (el) el.innerHTML = ownerControlHtml();
  }

  // ── Map display ───────────────────────────────────────────────────────────
  // Its own section, under its own heading, ahead of Stations & links: what a
  // pin looks like comes before which pins and lines are drawn. The four
  // switches are one card in the panel (.mapd-join, app.js markMapDisplayCards):
  // they are four answers to one question, and the note counts all four.
  function sectionHtml() {
    if (needSls()) askSls();
    return `
    <div class="map-display-h">Station pins</div>
    <label class="filter-check"
           title="A station that measures a water level — a river height gauge, or a storage or tide gauge — is a triangle. A rain gauge, or a station that measures neither, is a circle. A station that measures both is a triangle.">
      <input type="checkbox" ${state.mapPinShapes ? 'checked' : ''}
             onchange="MapSymbols.setShapes(this.checked)">
      Triangles for river height (water level) gauges
    </label>
    <label class="filter-check mapd-join"
           title="A gauge a person reads, not a radio: the station type says manual, the Bureau's Service Level Specification calls it Manual, or the Bureau reads it daily and nothing says a radio does. It reports nothing over the radio, so silence from it is not a fault.">
      <input type="checkbox" ${state.mapPinManual ? 'checked' : ''}
             onchange="MapSymbols.setManual(this.checked)">
      Grey for gauges read by hand (manual)
    </label>
    <label class="filter-check mapd-join"
           title="A TM station: its Telemetry field says a Campbell or older data logger, its name ends TM, or a satellite terminal reads it and nothing says ALERT. A logger and modem rather than an ALERT radio, so the receivers do not hear it — the green is left for ALERT stations.">
      <input type="checkbox" ${state.mapPinTm ? 'checked' : ''}
             onchange="MapSymbols.setTm(this.checked)">
      Black for TM stations
    </label>
    <label class="filter-check mapd-join"
           title="The Bureau's forecast locations (Schedule 2 of the Service Level Specification — a height is predicted) outlined in solid pink, its information locations (Schedule 3 — reported and classified, not predicted) in dashed pink.">
      <input type="checkbox" ${state.mapPinSls ? 'checked' : ''}
             onchange="MapSymbols.setOutlines(this.checked)">
      Outline the Bureau's forecast &amp; information locations
    </label>
    <p class="filter-note" id="map-symbols-note">${noteHtml()}</p>`;
  }

  // The Stations & links half: the owner, beside Hide stations that don't
  // match, because both decide which pins are drawn.
  function ownerHtml() {
    if (!ownersReady()) askSls();
    return `<div id="map-owner-block" class="mapd-owner">${ownerControlHtml()}</div>`;
  }

  function counts() {
    const out = { tri: 0, manual: 0, tm: 0, forecast: 0, information: 0 };
    if (!state.data) return out;
    for (const s of state.data.stations) {
      const k = kind(s);
      if (!k) continue;
      if (k.river) out.tri++;
      if (k.manual) out.manual++;
      if (k.tm) out.tm++;
      if (k.role === 'forecast') out.forecast++;
      else if (k.role === 'information') out.information++;
    }
    return out;
  }

  function noteHtml() {
    const c = counts();
    const n = v => `<strong>${v.toLocaleString()}</strong>`;
    const bits = [`${n(c.tri)} river height gauge${c.tri === 1 ? '' : 's'}`,
                  `${n(c.tm)} TM station${c.tm === 1 ? '' : 's'}`];
    if (slsLoaded()) {
      bits.push(`${n(c.manual)} read by hand`);
      bits.push(`${n(c.forecast)} forecast and ${n(c.information)} information location${c.information === 1 ? '' : 's'}`);
    }
    const tail = slsLoaded() ? ''
      : slsFailed ? ' The Bureau’s Service Level Specification did not load, so the outlines are missing and only the manual gauges the record names are grey. <button type="button" class="link-btn" onclick="MapSymbols.askSls(true)">Try again</button>'
      : needSls() ? ' Looking up the forecast, information and manual gauges in the Bureau’s Service Level Specification…'
      : '';
    return `In the file: ${bits.join(' · ')}.${tail}`;
  }

  function paintNotes() {
    const el = document.getElementById('map-symbols-note');
    if (el) el.innerHTML = noteHtml();
    const own = document.getElementById('map-owner-note');
    if (own) own.innerHTML = ownerNoteHtml();
    const roles = document.getElementById('map-roles-note');
    if (roles) roles.innerHTML = rolesNoteHtml();
  }

  // ── The legend ─────────────────────────────────────────────────────────────
  // The swatches are small SVGs, drawn as the map draws the marks: a triangle
  // and the TM black with the white ring, and the two outlines alone as the Bureau's key shows
  // them — hollow, with a white casing under the colour so the pink still
  // reads on the dark theme's panel, the information location's dashed as the
  // pin's is, casing and all, so its gaps are the panel's.
  function triSvg(fill, stroke, w) {
    return `<svg class="legend-tri" viewBox="0 0 16 15" width="16" height="15" aria-hidden="true" focusable="false">
      <polygon points="8,2 14.2,12.75 1.8,12.75" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/></svg>`;
  }

  // A circle pin with its white ring, for the black: a plain dot of it would
  // vanish into the dark theme's panel, as the pin itself does not on the map.
  function dotSvg(fill, stroke, w) {
    return `<svg class="legend-tri" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="4.75" fill="${fill}" stroke="${stroke}" stroke-width="${w}"/></svg>`;
  }

  function outlineSvg(colour, dash) {
    const d = dash ? ` stroke-dasharray="${dash.join(' ')}"` : '';
    return `<svg class="legend-tri" viewBox="0 0 16 15" width="16" height="15" aria-hidden="true" focusable="false">
      <polygon points="8,2 14.2,12.75 1.8,12.75" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round"${d}/>
      <polygon points="8,2 14.2,12.75 1.8,12.75" fill="none" stroke="${colour}" stroke-width="2.5" stroke-linejoin="round"${d}/></svg>`;
  }

  function legendHtml({ health = false } = {}) {
    const fieldFill = typeof ROLE_COLOR !== 'undefined' ? ROLE_COLOR.field : '#107c10';
    const rows = [];
    if (state.mapPinShapes) {
      rows.push(`
    <span class="legend-item">
      ${triSvg(health ? '#ffffff' : fieldFill, health ? '#5c6670' : '#ffffff', 1.5)}
      <span class="small">River height (water level) gauge — a rain gauge, or a station that measures neither, is a circle</span>
    </span>`);
    }
    if (state.mapPinManual && !health) {
      rows.push(`
    <span class="legend-item">
      <span class="legend-dot" style="--dot:${MANUAL}"></span>
      <span class="small">Read by hand — a manual gauge, silent on the radio</span>
    </span>`);
    }
    if (state.mapPinTm && !health) {
      rows.push(`
    <span class="legend-item">
      ${dotSvg(TM, '#ffffff', 1.5)}
      <span class="small">TM station — a data logger and modem, not an ALERT radio</span>
    </span>`);
    }
    if (state.mapPinSls) {
      rows.push(`
    <span class="legend-item">
      ${outlineSvg(FORECAST)}
      <span class="small">Forecast location (Bureau SLS) — solid outline</span>
    </span>
    <span class="legend-item">
      ${outlineSvg(INFORMATION, INFORMATION_DASH)}
      <span class="small">Information location (Bureau SLS) — dashed outline</span>
    </span>`);
    }
    return rows.join('');
  }

  // The switches that are off, for the legend's "Also available" line.
  function legendOff() {
    return [
      !state.mapPinShapes && 'Triangles for river height gauges',
      !state.mapPinManual && 'Grey for manual gauges',
      !state.mapPinTm     && 'Black for TM stations',
      !state.mapPinSls    && 'Forecast and information outlines',
    ].filter(Boolean);
  }

  // ── The switches ───────────────────────────────────────────────────────────
  // Remembered, and repainted in place: the pins, the legend and the note. The
  // block itself is left standing — it is under the pointer that just clicked
  // it, and nothing else in it changed.
  function store(key, on) {
    try { localStorage.setItem(key, on ? 'on' : 'off'); } catch (_) {}
  }

  function repaint() {
    paintNotes();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    if (state.map && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
  }

  function setShapes(on) {
    state.mapPinShapes = !!on;
    store('mn-pin-shapes', on);
    repaint();
    announce(on ? 'River height gauges are triangles on the map.' : 'Every station pin is a circle.');
  }

  function setManual(on) {
    state.mapPinManual = !!on;
    store('mn-pin-manual', on);
    if (on) askSls();
    repaint();
    announce(on ? 'Gauges read by hand are grey on the map.' : 'Gauges read by hand are back in their role’s colour.');
  }

  function setTm(on) {
    state.mapPinTm = !!on;
    store('mn-pin-tm', on);
    repaint();
    announce(on ? 'TM stations are black on the map.' : 'TM stations are back in their role’s colour.');
  }

  function setOutlines(on) {
    state.mapPinSls = !!on;
    store('mn-pin-sls', on);
    if (on) askSls();
    repaint();
    announce(on ? 'Forecast locations are outlined in solid pink and information locations in dashed pink.'
                : 'Forecast and information locations are no longer outlined.');
  }

  function ownerChanged() {
    paintOwnerControl();
    if (typeof updateMapMatchNote === 'function') updateMapMatchNote();
    if (state.map && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
    announce(state.mapOwner
      ? `The map is drawing ${ownerPhrase()}: ${hiddenCount(ownerDrawn).toLocaleString()} stations not drawn.`
      : 'The map is drawing every owner’s stations.');
  }

  // A box ticked or unticked: the pins and their links, the note under the
  // boxes, the match line and the legend. The boxes themselves are left
  // standing — one of them is under the pointer that just clicked it.
  function setRole(role, on) {
    if (!ROLES.includes(role)) return;
    if (on) state.mapRolesOff.delete(role);
    else state.mapRolesOff.add(role);
    paintNotes();
    if (typeof updateMapMatchNote === 'function') updateMapMatchNote();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    if (state.map && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
    announce(rolesHiding()
      ? `The map is drawing ${rolesPhrase()}: ${hiddenCount(roleDrawn).toLocaleString()} stations not drawn.`
      : 'The map is drawing every kind of station.');
  }

  function setOwner(v) {
    state.mapOwner = String(v || '');
    ownerChanged();
    // The select was just redrawn under the pointer; focus goes back to it so
    // a keyboard can carry on down the list.
    const sel = document.getElementById('map-owner');
    if (sel) sel.focus();
  }

  function setOwnerMode(mode) {
    state.mapOwnerMode = mode === 'except' ? 'except' : 'only';
    ownerChanged();
    const box = document.querySelector(`#map-owner-block input[name="map-owner-mode"][value="${state.mapOwnerMode}"]`);
    if (box) box.focus();
  }

  return {
    FORECAST, INFORMATION, INFORMATION_DASH, MANUAL, TM, TRI_SCALE,
    kind, pin, radius, marker, reset,
    ownersReady, askSls, drawn, roleDrawn, linkDrawn, hiding, drawingPhrase, drawnNoteShort,
    ownerDrawn, ownerHiding, ownerPhrase, ownerParties,
    sectionHtml, ownerHtml, rolesHtml, legendHtml, legendOff, noteHtml,
    setShapes, setManual, setTm, setOutlines, setOwner, setOwnerMode, setRole,
    slsFailed: () => slsFailed,
  };
})();
if (typeof window !== 'undefined') window.MapSymbols = MapSymbols;
