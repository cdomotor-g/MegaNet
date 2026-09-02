// MegaNet — link-budget.js
//
//   LinkBudget     pick two points, get a fade margin. Either end can be a
//                  station — found by name, number or ALERT address, or picked
//                  off the map or the Stations list — which fills itself in
//                  from rm_systems, or an arbitrary point on the ground, which
//                  is what makes it useful for a relocation nobody has visited.
//   LB_MARGIN      the margin bands, and the class that colours them.
//   lbMarginClass
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, acmaHaversineKm and
// RM_NET_DEFAULTS; across to app.js for mapNote and for the search the whole
// app shares — prepareSearch, stationMatchesSearch, markHits and
// tableStations; and sideways to path-profile.js for PATH_DEFAULT_MHZ,
// PATH_DEFAULT_AGL, PATH_VERDICT, fsplDb, wattsToDbm, rmSystemOf and
// PathProfile, to map-draw.js for MapDraw and to terrain.js for Terrain. See
// path-profile.js's header for why the mutual reference constrains nothing.
//
// app.js calls back in two places, and both are named here because neither is
// obvious from that end: selectStation() offers a row to an armed end before it
// selects, and onStationPinClick() offers the pin — which never reaches
// map.on('click') at all, the markers being built with
// `bubblingMouseEvents: false`.
//
// The number this produces is a model output — Longley–Rice over sampled
// terrain and land cover, the model Radio Mobile runs — and not a measurement;
// the banner that cannot be dismissed and the comparison table under it are
// there so the figure cannot be read as more than it is. Do not quietly make it
// look more confident.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129; rebuilt on the
// Longley–Rice port (itm.js) and the land-cover layer (land-cover.js) since.

// ── Link budget ──────────────────────────────────────────────────────────────
// Pick two points on the map, get a fade margin. Either end can be a station —
// which fills itself in from rm_systems — or an arbitrary point on the ground,
// which is what makes this useful for a proposed relocation: drop an end on a
// hilltop nobody has been to yet and see what the path would do.
//
// The loss is Longley–Rice (ITM) point-to-point over the elevation profile —
// terrain, land cover stood on it, climate, ground constants, polarisation and
// the statistical allowance for the reliability asked — plus ITU-R P.2108's
// terminal-clutter term at an end whose antenna is under the trees. That is
// what Radio Mobile computes, from a better land-cover map. What it still
// leaves out (antenna patterns above all) *reduces* real margin, hence the
// banner that cannot be dismissed and the comparison table underneath it: the
// card is built so the figure cannot be read as more than it is.

// The bands are read against a margin that already carries the statistical
// allowance for the reliability asked (70% of situations by default), so they
// sit lower than they did when the figure was free space plus a knife edge:
// Radio Mobile's own network style paints +3 dB green. Ten is comfortable;
// three is the floor; under that the link is a coin toss on a bad day.
const LB_MARGIN = [
  { min: 10,       label: 'Good',     cls: 'ok',   note: 'Comfortable margin at the reliability asked for.' },
  { min: 3,        label: 'Marginal', cls: 'warn', note: 'Above threshold, but growth, rain or a season would eat it.' },
  { min: -Infinity, label: 'Poor',    cls: 'bad',  note: 'Not a link you would build on this figure.' },
];

function lbMarginClass(db) { return LB_MARGIN.find(m => db >= m.min); }

const LinkBudget = (function () {
  let map = null, layer = null, clickHandler = null;

  const S = () => state.link;

  // ── endpoints ──

  function stationEndpoint(st) {
    const sys = rmSystemOf(st);
    const rep = st.repeater || null;
    return {
      kind: 'station', sid: st.id, name: st.name,
      lat: st.lat, lon: st.lon,
      ground: st.elevation_ahd != null ? st.elevation_ahd : null,
      groundSrc: st.elevation_ahd != null ? 'elevation_ahd (AHD)' : null,
      sysName: sys ? sys.name : null,
      freq: rep && rep.rx_mhz > 0 ? rep.rx_mhz : null,
      def: {
        tx_w:     sys && sys.tx_power_w != null ? sys.tx_power_w : null,
        loss_db:  sys && sys.line_loss_db != null ? sys.line_loss_db : null,
        gain_dbi: sys && sys.antenna_gain_dbi != null ? sys.antenna_gain_dbi : null,
        agl_m:    sys && sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL,
        rx_dbm:   sys && sys.rx_threshold_dbm != null ? sys.rx_threshold_dbm : null,
      },
      over: {},
    };
  }

  function pointEndpoint(lat, lon) {
    return {
      kind: 'point', sid: null,
      name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat, lon, ground: null, groundSrc: null, sysName: null, freq: null,
      // A hypothetical site has to start from something; the 1 W field station
      // is what most of this network actually is.
      def: { tx_w: 1, loss_db: 1, gain_dbi: 5.15, agl_m: PATH_DEFAULT_AGL, rx_dbm: -117 },
      over: {},
    };
  }

  // ── finding an end without hunting for its pin ───────────────────────────
  // The card was map-only: an end could be set by clicking the ground, by a
  // two-point line drawn in Draw & measure, and by nothing else. That is right
  // for "what would this hilltop do" and useless for the question people
  // actually arrive with — "what is the margin from 6128 to the repeater it
  // reports through" — where both ends are known by name, number or ALERT
  // address long before anybody knows which of ~3,174 pins they are.
  //
  // So each end gets a box, and it is the box this app already has: the same
  // prepareSearch / stationMatchesSearch pair behind the Stations filter, Pass
  // Ranges and the ARRO Launcher, called with one argument-pair so it is "one
  // box pointed at everything". A name, a station number, an ALERT address and
  // an address window (`4021-4025`) therefore mean here exactly what they mean
  // there, which is the whole reason not to write a second matcher.
  const LB_FIND_CAP = 25;   // offered before the operator is asked to narrow

  function findQ(which) {
    const S_ = S();
    if (!S_.q) S_.q = { a: '', b: '' };
    return String(S_.q[which] == null ? '' : S_.q[which]);
  }

  // Always { prep, hits } — a caller destructures it, and an empty array in one
  // branch is the shape that would come apart in that caller's hands.
  function findHits(which) {
    const text = findQ(which).trim();
    if (!state.data || !text) return { prep: null, hits: [] };
    // prepareSearch memoises exactly one string (app.js), and both ends ask it
    // during the same paint — so the answer is copied out of it here, before
    // the other end's question overwrites the arrays it handed back.
    const prep = { ...prepareSearch(text) };
    // A window is a search even though it leaves no term behind it: `4021-4025`
    // parses to bounds rather than to text.
    if (!prep.terms.length && !prep.ranges.length) return { prep, hits: [] };
    const hits = [];
    for (const s of state.data.stations) {
      if (!stationMatchesSearch(s, prep)) continue;
      hits.push(s);
      if (hits.length > LB_FIND_CAP) break;   // one over, so "more than" is knowable
    }
    return { prep, hits };
  }

  // Whether this end is the one the next station pick fills.
  function armed(which) { return S().target === which; }

  // Both ends' station ids, so a list can say which of the two it is already on
  // rather than offering a station that is already at the other end as though
  // picking it would do something new.
  function sidOf(which) { const e = S()[which]; return e && e.sid ? e.sid : null; }

  // The list under an end's box, and the two different lists it can be. With
  // something typed it is the whole file searched. With the box empty and the
  // end armed it is the set the tab is already showing — tableStations() is the
  // Stations table's own list, filters, pass-range relatives, map selection and
  // all — so "pick it out of the list I have already narrowed" costs one click
  // rather than a second search that repeats the filtering by hand.
  function findListHtml(which) {
    if (!state.data) return '';
    const text = findQ(which).trim();
    if (!text && !armed(which)) return '';
    const { prep, hits } = text ? findHits(which) : { prep: null, hits: tableStations() };
    const more  = hits.length > LB_FIND_CAP;
    const shown = more ? hits.slice(0, LB_FIND_CAP) : hits;
    const lead  = text
      ? `${hits.length === 0 ? 'No station matches' : more ? `More than ${LB_FIND_CAP} match` : `${hits.length} match${hits.length === 1 ? '' : 'es'}`} “${esc(text)}”${more ? ' — keep typing to narrow it' : ''}`
      : `The <strong>Stations</strong> list holds ${hits.length.toLocaleString()} right now${
          more ? `; the first ${LB_FIND_CAP} are here. Narrow the filters, or type to search all of them`
               : ''}`;
    if (!shown.length) {
      return `<p class="small lb-find-none">${lead}.</p>`;
    }
    const otherSid = sidOf(which === 'a' ? 'b' : 'a');
    const mine     = sidOf(which);
    return `
      <p class="small lb-find-lead" id="lb-find-lead-${which}">${lead}.</p>
      <div class="lb-hits" role="group" aria-labelledby="lb-find-lead-${which}">
        ${shown.map(st => {
          const here  = st.id === mine;
          const there = st.id === otherSid;
          return `
            <button type="button" class="lb-hit${here ? ' is-here' : ''}"
                    onclick="LinkBudget.pick('${which}','${escAttr(st.id)}')">
              <span class="lb-hit-name">${prep ? markHits(st.name, prep.terms) : esc(st.name)}</span>
              <span class="small lb-hit-num">${prep
                ? markHits(st.station_number || '', prep.terms)
                : esc(st.station_number || '')}</span>
              ${here ? '<span class="lb-hit-at">this end</span>'
                : there ? `<span class="lb-hit-at">end ${which === 'a' ? 'B' : 'A'}</span>` : ''}
            </button>`;
        }).join('')}
      </div>`;
  }

  // The box itself, plus the sentence that says what arming an end means. The
  // input is never re-rendered by typing into it — setSearch repaints only the
  // list below — so the caret survives a paste, exactly as the Stations filter
  // box and the ARRO Launcher's do.
  function findHtml(which) {
    const tag = which === 'a' ? 'A' : 'B';
    const on  = armed(which);
    if (!state.data) {
      return `<p class="small lb-src">No stations loaded, so there is nothing to search —
        click the map for a hypothetical point instead.</p>`;
    }
    return `
      <div class="lb-find${on ? ' is-armed' : ''}">
        <label class="sr-only" for="lb-find-${which}">Find the station at end ${tag}</label>
        <div class="lb-find-row">
          <input type="search" id="lb-find-${which}" class="lb-find-input"
                 value="${escAttr(findQ(which))}" autocomplete="off" spellcheck="false"
                 placeholder="Name, station # or ALERT address — e.g. Loudoun, 541155, 6128"
                 aria-describedby="lb-find-hint-${which}"
                 onfocus="LinkBudget.arm('${which}')"
                 oninput="LinkBudget.setSearch('${which}',this.value)">
          <button type="button" class="lb-find-x" id="lb-clear-${which}"
                  onclick="LinkBudget.clearEnd('${which}')"
                  aria-label="Clear end ${tag}"
                  title="Clear end ${tag} — the station, anything typed here, and any override on it"
                  ${S()[which] || findQ(which).trim() ? '' : 'disabled'}>Clear ${tag}</button>
        </div>
        <p class="small lb-find-hint" id="lb-find-hint-${which}">${on
          ? `<strong>End ${tag} is armed.</strong> Click a station pin or any point on the map,
             or a row in the <strong>Stations</strong> list below — in whatever state the filters
             have it — and it lands here.
             <button type="button" class="lb-link" id="lb-arm-${which}"
                     onclick="LinkBudget.disarm()">Stop picking end ${tag}</button>`
          : `Type to search, or <button type="button" class="lb-link" id="lb-arm-${which}"
               onclick="LinkBudget.arm('${which}')">pick end ${tag} off the map or the list</button>.`}</p>
        <div id="lb-hits-${which}">${findListHtml(which)}</div>
      </div>`;
  }

  // The value in play, and whether the operator put it there.
  function val(e, k) { return e.over[k] != null ? e.over[k] : e.def[k]; }
  function isOver(e, k) { return e.over[k] != null; }

  // An endpoint with no surveyed height gets one from the terrain tiles —
  // asynchronously, and the card redraws when it lands.
  //
  // Not only hypothetical points: most stations carry no elevation_ahd at all
  // (2,334 of 3,174 at the time of writing), and those were left reading
  // "sampling…" for the life of the card, because nothing was ever going to
  // sample them. A tile height is not AHD and the card says so, but it beats a
  // permanent lie about work in progress — and it gives pathAnalyse a real
  // height for that end instead of nothing.
  function fillGround(e) {
    if (!e || e.ground != null || e._pending) return;
    e._pending = true;
    Terrain.sample(e.lat, e.lon).then(m => {
      e._pending = false;
      if (m != null) { e.ground = m; e.groundSrc = 'terrain tile (EGM96 geoid)'; }
      else e.groundSrc = 'unavailable';
      // A tile can take up to twelve seconds, and the end it was fetched for
      // may have been cleared or replaced in the meantime. Writing the height
      // onto the orphan is harmless; repainting the card for it is not — a
      // repaint is what discards an uncommitted figure (see keepFocus), and one
      // fired on behalf of an endpoint that is no longer on screen has nothing
      // to show for the cost.
      if (S().a !== e && S().b !== e) return;
      rerender();
    });
  }

  // ── map pick ──

  function setEnd(which, e) {
    S()[which] = e;
    fillGround(e);
    drawMarkers();
    rerender();
  }

  function onMapClick(ev) {
    // A draw tool owns its own clicks; this only takes the ones nothing else
    // wanted.
    if (!S().picking || state.draw.tool) return;
    const { ll, sid } = MapDraw.resolveClick(ev.latlng);
    const st = sid && state.data ? state.data.stations.find(s => s.id === sid) : null;
    takeEndpoint(st ? stationEndpoint(st) : pointEndpoint(ll[0], ll[1]));
  }

  // Which end a pick is about to land on: the armed one, or — with nothing
  // armed — whichever is empty, A before B, starting again from A once both
  // are. Its own function so a station can be checked against the *other* end
  // before it is taken.
  function destEnd() {
    const t = S().target;
    if (t === 'a' || t === 'b') return t;
    return !S().a ? 'a' : !S().b ? 'b' : 'a';
  }

  // Where a picked end goes, however it was picked — a click on the ground, a
  // pin, or a row in the Stations list.
  //
  // An armed end wins when there is one: the operator has said which end they
  // are filling, and a pick that ignored them would be the card overruling the
  // person. With nothing armed this is the original cycle — A, then B, then
  // start again from A with B cleared, so a third click is visibly a new path
  // rather than a silent edit to the old one.
  function takeEndpoint(e) {
    const t = S().target;
    if (t === 'a' || t === 'b') {
      const tag = t.toUpperCase();
      S().target = null;
      setEnd(t, e);
      mapNote(S().a && S().b
        ? `End ${tag} set — both ends are in.`
        : `End ${tag} set — now the other end.`, 3000);
      return;
    }
    const which = destEnd();
    if (which === 'a' && S().a && S().b) S().b = null;
    setEnd(which, e);
    mapNote(S().a && S().b
      ? 'Both ends set — click again to start a new path.'
      : 'Now click the other end of the path.', 3000);
  }

  // A station offered to the card from outside the map: a row in the Stations
  // list, a pin whose own click never reaches the map, or a result in an end's
  // own search box. Answers whether it was taken, so selectStation() knows
  // whether it still has a selection to make.
  //
  // A station with no recorded position is refused rather than accepted as a
  // pair of nulls: every figure downstream would come out NaN, and an endpoint
  // reading "not set" for its own coordinates is not a link end.
  function takeStationEnd(sid, which) {
    const st = state.data ? state.data.stations.find(s => s.id === sid) : null;
    if (!st) return false;
    if (st.lat == null || st.lon == null) {
      mapNote(`${st.name} has no position recorded — a link budget needs one at both ends.`, 5000);
      return false;
    }
    // The same station at both ends is a zero-length path, and a zero-length
    // path loses nothing: the table comes out with an enormous margin marked
    // "Good". It is always a mis-pick, so it is refused with a reason rather
    // than computed. The one case with no other end to collide with is the
    // unaimed cycle landing back on A, which clears B on the way.
    const dest = which || destEnd();
    const other = dest === 'a' ? 'b' : 'a';
    const clearsOther = !S().target && dest === 'a' && S().a && S().b;
    const at = clearsOther ? null : S()[other];
    if (at && at.sid === st.id) {
      mapNote(`${st.name} is already end ${other.toUpperCase()} — a link budget needs two different places.`, 5000);
      return false;
    }
    if (which) { findQ(which); S().target = which; S().q[which] = ''; }
    takeEndpoint(stationEndpoint(st));
    return true;
  }

  function drawMarkers() {
    if (!layer) return;
    layer.clearLayers();
    const { a, b } = S();
    [['A', a], ['B', b]].forEach(([tag, e]) => {
      if (!e) return;
      L.circleMarker([e.lat, e.lon], {
        radius: 8, color: '#c62828', weight: 3, fillColor: '#fff', fillOpacity: 1,
      }).addTo(layer).bindTooltip(`${tag} · ${esc(e.name)}`, {
        permanent: true, direction: 'top', className: 'mn-draw-label', offset: [0, -8],
      });
    });
    if (a && b) {
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]],
                 { color: '#c62828', weight: 2.5, dashArray: '6 4' }).addTo(layer);
    }
  }

  // ── the budget ──

  // The profile for exactly these two ends, when the elevation panel happens to
  // be showing it. It is the evidence for the diffraction term, so the card
  // only claims one when it can point at the profile it came from.
  function analysisFor(a, b) {
    return PathProfile.analysisFor(a.lat, a.lon, b.lat, b.lon, {
      elevA: a.ground, elevB: b.ground,
      aglA: val(a, 'agl_m'), aglB: val(b, 'agl_m'),
      freqMhz: freqOf(),
    });
  }

  function freqOf() {
    const S_ = S();
    if (S_.freqMhz > 0) return S_.freqMhz;
    for (const e of [S_.a, S_.b]) if (e && e.freq > 0) return e.freq;
    return PATH_DEFAULT_MHZ;
  }

  function compute() {
    const { a, b } = S();
    if (!a || !b) return null;
    const dKm  = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
    const fMhz = freqOf();
    const txW  = val(a, 'tx_w');
    const txDbm = wattsToDbm(txW);
    const an = analysisFor(a, b);

    // A term that is not known is not nought. `|| 0` folded an absent antenna
    // gain into 0 dBi and carried on: the row printed "—" while the = EIRP
    // subtotal under it was computed as though it were zero, so the column
    // stopped adding up and the margin quoted a figure nobody supplied. TX
    // power and the RX threshold already blank the margin when they are
    // missing; these now do the same. Genuine zeroes are untouched — 0 dBi is a
    // number, and `n == null` is the only thing that fails here.
    const txG = val(a, 'gain_dbi'), txL = val(a, 'loss_db');
    const rxG = val(b, 'gain_dbi'), rxL = val(b, 'loss_db');
    const eirp = txDbm == null || txG == null || txL == null ? null : txDbm + txG - txL;

    // The path loss, term by term. With a profile and a model run over it, the
    // free-space figure is the model's own (over the profile's length, which
    // is the haversine distance to a metre or two) so the column adds up to
    // the loss the model reports. Without one, it is free space over the
    // great circle and nothing else — and the card says so in red.
    const itm = an && an.itm ? an.itm : null;
    const fspl = itm ? itm.A_fs_db : fsplDb(dKm, fMhz);
    const aref = itm ? itm.A_ref_db : null;            // terrain: the reference attenuation
    const avar = itm ? itm.A_var_db : null;            // statistics: median shift + variability
    const clutA = an && an.coverUsed ? an.clutterA_db : null;
    const clutB = an && an.coverUsed ? an.clutterB_db : null;
    const floor = itm ? an.floor_db : 0;
    // The knife-edge proxy is what stands in when the profile exists but the
    // model refused it (a 400 m hop, say, or a mast under 0.5 m).
    const proxy = an && !itm ? an.diffraction_db : null;
    const pathLoss = itm
      ? fspl + aref + avar + (clutA || 0) + (clutB || 0) + floor
      : fspl + (proxy || 0);

    const rxDbm = eirp == null || rxG == null || rxL == null ? null
      : eirp - pathLoss + rxG - rxL;
    const thr = val(b, 'rx_dbm');
    // Which of them is actually missing, so the note can name it rather than
    // listing both and being half wrong.
    const missing = [
      [txDbm, 'TX power'], [txG, 'TX antenna gain'], [txL, 'TX line loss'],
      [rxG, 'RX antenna gain'], [rxL, 'RX line loss'], [thr, 'RX threshold'],
    ].filter(([v]) => v == null).map(([, label]) => label);
    // Both ends in the same place is not a path. fsplDb answers 0 for a
    // distance of nought — correctly, it has nothing to integrate over — so
    // every loss vanishes and the margin comes out enormous and "Good". Two
    // points snapped to the same pin will do it, and so will a station picked
    // for both ends from somewhere this card cannot vet. A figure that is a
    // fantasy is worse than no figure, so there is none.
    const zero = !(dKm > 0.0005);
    const margin = zero || rxDbm == null || thr == null ? null : rxDbm - thr;

    // Radio Mobile's other readouts, from the same figures: the received level
    // as a voltage into 50 Ω (dBm = 20·log10(µV) − 107), the field strength at
    // the receiving antenna (E = P_r + 77.2 + 20·log10 f − G_r, dBµV/m), the
    // field the receiver *needs* for its threshold, and the system gain — the
    // most path loss the two ends could stand and still hear each other.
    const uV = rxDbm == null ? null : Math.pow(10, (rxDbm + 107) / 20);
    const efield = rxDbm == null || rxG == null ? null : rxDbm + 77.2 + 20 * Math.log10(fMhz) - rxG;
    const efieldReq = thr == null || rxG == null || rxL == null ? null : thr + rxL + 77.2 + 20 * Math.log10(fMhz) - rxG;
    const sysGain = eirp == null || rxG == null || rxL == null || thr == null ? null : eirp + rxG - rxL - thr;

    return { dKm, fMhz, txW, txDbm, eirp, fspl, aref, avar, clutA, clutB, floor, proxy, pathLoss,
             rxDbm, thr, margin, an, itm, uV, efield, efieldReq, sysGain,
             // kept for the radio-path card, which reads them
             diff: itm ? aref + avar + (clutA || 0) + (clutB || 0) + floor : proxy,
             zero, missing, fsplOnly: an == null };
  }

  // ── rendering ──

  function endpointCard(which, e) {
    const tag = which === 'a' ? 'A' : 'B';
    if (!e) {
      return `
        <div class="lb-end lb-end-empty${armed(which) ? ' is-armed' : ''}">
          <div class="lb-end-head"><span class="lb-tag">${tag}</span> <em>not set</em></div>
          ${findHtml(which)}
        </div>`;
    }
    const f = (k, label, step, unit) => {
      const over = isOver(e, k);
      const v = val(e, k);
      return `
        <label class="lb-field${over ? ' is-over' : ''}">
          <span>${esc(label)}${unit ? ` <em>${esc(unit)}</em>` : ''}</span>
          <input type="number" step="${step}" id="lb-f-${which}-${k}"
                 value="${v == null ? '' : v}"
                 placeholder="not set"
                 onchange="LinkBudget.setField('${which}','${k}',this.value)">
          <b class="lb-flag">${over ? 'edited'
            : e.def[k] == null ? ''
            : e.kind === 'station' ? 'default'
            // A hypothetical site's figures came from nowhere but this code, so
            // they are marked as the guesses they are rather than borrowing the
            // authority of a "default" read out of the station data.
            : 'assumed'}</b>
        </label>`;
    };
    return `
      <div class="lb-end${armed(which) ? ' is-armed' : ''}">
        <div class="lb-end-head">
          <span class="lb-tag">${tag}</span>
          <strong>${esc(e.name)}</strong>
        </div>
        ${findHtml(which)}
        <p class="small lb-src">${e.kind === 'station'
          ? `Station${e.sysName ? ` · ${esc(e.sysName)}` : ''}${e.freq ? ` · repeater ${e.freq} MHz` : ''}`
          : 'Hypothetical point — nothing is written back to the station data'}</p>
        <p class="small lb-src">Ground ${e.ground != null
          ? `${e.ground.toFixed(1)} m <span class="txt-muted">${esc(e.groundSrc || '')}</span>`
          : (e.groundSrc === 'unavailable'
              ? '<span class="txt-bad">unavailable — no terrain tile for this point</span>'
              : '<span class="txt-muted">sampling…</span>')}</p>
        <div class="lb-fields">
          ${f('tx_w',     'TX power',        '0.1',  'W')}
          ${f('gain_dbi', 'Antenna gain',    '0.05', 'dBi')}
          ${f('loss_db',  'Line loss',       '0.1',  'dB')}
          ${f('agl_m',    'Antenna height',  '0.5',  'm AGL')}
          ${f('rx_dbm',   'RX threshold',    '0.1',  'dBm')}
        </div>
      </div>`;
  }

  // Every term is signed, so the column reads as an addition that visibly comes
  // out at the received level — subtotals excepted, which are the running
  // result rather than something being added.
  function budgetRow(label, value, unit, note, cls) {
    const sub = /^=/.test(label);
    return `
      <tr class="${cls || ''}">
        <th scope="row">${esc(label)}</th>
        <td class="lb-num">${value == null ? '—'
          : (value > 0 && !sub ? '+' : '') + value.toFixed(2)}</td>
        <td class="lb-unit">${esc(unit || '')}</td>
        <td class="small lb-note">${note || ''}</td>
      </tr>`;
  }

  function budgetHtml(r) {
    const a = S().a, b = S().b;
    const m = r.margin == null ? null : lbMarginClass(r.margin);
    // A blocked path with no model run over it can still show a fat margin:
    // the single knife edge that stands in for the terrain is the most
    // optimistic diffraction model there is. With the model run, the loss IS
    // the obstruction's price and the margin is what it says — but the row
    // still names the obstruction, because a margin that survives a blocked
    // path is worth a second look, not a green light.
    const blockedNoModel = !!(r.an && r.an.verdict === 'obstructed' && !r.itm) && r.margin != null;
    const noPath = !!r.zero;
    const an = r.an, itm = r.itm;
    const P_ = S().prop;
    const pct = itm ? `${P_.mdvar === 0 ? '' : `${P_.time}% of time, `}${P_.mdvar === 3 ? `${P_.location}% of locations, ` : ''}${P_.situation}% of situations`
                    : '';
    const coverNote = (tag, e, cls, R, agl, db) => {
      if (cls == null) return `${esc(e.name)}: cover unclassified here`;
      const c = LandCover.CLASSES[cls];
      if (!(db > 0)) return `${esc(e.name)} stands in ${esc(c.label.toLowerCase())}${R > 0 ? ` (${Math.round(R)} m)` : ''} — antenna at ${agl} m is ${R > 0 ? 'above it' : 'in the clear'}`;
      return `${esc(e.name)}: antenna at ${agl} m is <strong>under ${Math.round(R)} m of ${esc(c.label.toLowerCase())}</strong> — P.2108 terminal clutter`;
    };
    return `
      <div class="table-wrap">
      <table class="lb-table">
        <caption class="sr-only">The link budget, term by term — each gain and loss between the transmitter and the receiver, and the margin they add up to</caption>
        <tbody>
          ${budgetRow('TX power', r.txDbm, 'dBm', r.txW != null ? `${r.txW} W at ${esc(a.name)}` : 'no TX power set')}
          ${budgetRow('TX antenna gain', val(a, 'gain_dbi'), 'dBi',
            val(a, 'gain_dbi') == null ? '<span class="txt-bad">not set — no EIRP without it</span>' : '')}
          ${budgetRow('TX line loss', val(a, 'loss_db') == null ? null : -val(a, 'loss_db'), 'dB',
            val(a, 'loss_db') == null ? '<span class="txt-bad">not set — no EIRP without it</span>' : '')}
          ${budgetRow('= EIRP', r.eirp, 'dBm', '', 'lb-sub')}
          ${budgetRow('Free-space loss', -r.fspl, 'dB',
            r.zero
              ? '<strong>Both ends are in the same place</strong> — nothing below this line means anything'
              : `${r.fMhz.toFixed(3)} MHz over ${fmtKm(r.dKm)}`)}
          ${!an
            ? `<tr class="lb-missing"><th scope="row">Terrain &amp; cover</th><td class="lb-num">—</td><td class="lb-unit">dB</td>
                 <td class="small lb-note">No terrain profile for these two points —
                 <strong>this result is free-space only</strong> and ignores the ground entirely.
                 ${S().a && S().b ? '<button class="lb-link" onclick="LinkBudget.profileThis()">Profile this path</button>' : ''}</td></tr>`
            : itm ? `
              ${budgetRow('Terrain', -r.aref, 'dB',
                `Longley–Rice reference attenuation, <strong>${esc(itm.modeLabel.toLowerCase())}</strong> regime over
                 ${fmtAglPair(val(a, 'agl_m'), val(b, 'agl_m'))}, Δh ${Math.round(itm.delta_h_m)} m${
                 an.coverUsed ? ', cover stood on the profile' : ', <span class="txt-warn">bare ground</span>'}`)}
              ${budgetRow('Statistics', -r.avar, 'dB',
                `${esc(ITM.CLIMATE[P_.climate])} climate, ${esc(ITM.MDVAR[P_.mdvar] || '')} mode, ${pct}${
                 r.avar < 0 ? ' — below the median, a gain' : ''}`)}
              ${r.floor > 0.05 ? budgetRow('Obstruction floor', -r.floor, 'dB',
                `the model's ${esc(itm.modeLabel.toLowerCase())} regime prices this profile at ${r.aref.toFixed(1)} dB over free space, but
                 the line is cut and one knife edge over the worst obstruction${an.v != null ? ` (v=${an.v.toFixed(2)})` : ''} costs
                 ${an.diffraction_db.toFixed(1)} dB — the loss is held to at least that`) : ''}
              ${an.coverUsed ? `
                ${budgetRow(`Ground cover at ${esc(a.name)}`, -r.clutA, 'dB', coverNote('A', a, an.coverA, an.R_A, val(a, 'agl_m'), r.clutA))}
                ${budgetRow(`Ground cover at ${esc(b.name)}`, -r.clutB, 'dB', coverNote('B', b, an.coverB, an.R_B, val(b, 'agl_m'), r.clutB))}`
              : `<tr class="lb-missing"><th scope="row">Ground cover</th><td class="lb-num">—</td><td class="lb-unit">dB</td>
                   <td class="small lb-note">${an.coverOff
                     ? 'Switched off on the profile card — trees and buildings are not in this figure.'
                     : 'Not available for this path — trees and buildings are not in this figure.'}</td></tr>`}`
            : budgetRow('Diffraction proxy', -(r.proxy || 0), 'dB',
                `<span class="txt-warn">The model could not run${an.itmError ? ` — ${esc(an.itmError)}` : ''}</span>;
                 a single knife edge${an.v != null ? `, v=${an.v.toFixed(2)}` : ''} stands in`)}
          ${budgetRow('= Path loss', -r.pathLoss, 'dB', an && itm
            ? `${(r.pathLoss - r.fspl).toFixed(1)} dB over free space${itm.warnings.length ? ` · <span class="txt-warn">${itm.warnings.length} model warning${itm.warnings.length === 1 ? '' : 's'} below</span>` : ''}`
            : '', 'lb-sub')}
          ${budgetRow('RX antenna gain', val(b, 'gain_dbi'), 'dBi',
            val(b, 'gain_dbi') == null ? '<span class="txt-bad">not set — no received level without it</span>' : '')}
          ${budgetRow('RX line loss', val(b, 'loss_db') == null ? null : -val(b, 'loss_db'), 'dB',
            val(b, 'loss_db') == null ? '<span class="txt-bad">not set — no received level without it</span>' : '')}
          ${budgetRow('= Received signal', r.rxDbm, 'dBm', `at ${esc(b.name)}${r.uV != null ? ` · ${fmtUv(r.uV)}` : ''}`, 'lb-sub')}
          ${budgetRow('RX threshold', r.thr, 'dBm', `receiver sensitivity${r.thr != null ? ` · ${fmtUv(Math.pow(10, (r.thr + 107) / 20))}` : ''}`)}
        </tbody>
        <tfoot>
          <tr class="lb-margin ${blockedNoModel || noPath ? 'bad' : (m ? m.cls : '')}">
            <th>Fade margin</th>
            <td class="lb-num">${r.margin == null ? '—' : (r.margin > 0 ? '+' : '') + r.margin.toFixed(1)}</td>
            <td class="lb-unit">dB</td>
            <td class="lb-note"><strong>${noPath ? 'No path'
              : blockedNoModel ? 'Obstructed'
              : m ? m.label
              : 'Not computed'}</strong>
              <span class="small">${r.margin == null
                ? (r.zero
                    ? 'Both ends are in the same place. There is no path here to have a margin — move one of them.'
                    : r.missing.length
                      ? `No figure has been given for ${esc(fmtList(r.missing))}, and a margin
                         computed around a missing term would be an invented one. Fill ${
                           r.missing.length === 1 ? 'it' : 'them'} in above.`
                      : 'Fill in the missing figures above for a margin.')
                : blockedNoModel
                  ? `Terrain rises above the line of sight and the model did not run, so this margin is not trustworthy${
                      m ? ` however “${m.label.toLowerCase()}” it looks` : ''}: one knife edge stands in for a
                      blocked path, and it understates it badly.`
                  : itm
                    ? `${esc(m.note)} This is the margin above the threshold at ${pct} — Radio Mobile's “Rx relative” —
                       not the margin above the median.`
                    : r.fsplOnly
                      ? 'Free space only — no terrain, no cover, no statistics. Optimistic by whatever the ground costs.'
                      : esc(m.note)}</span></td>
          </tr>
        </tfoot>
      </table>
      </div>
      ${an ? `
        <p class="small lb-eval">Terrain${an.coverUsed ? ' and cover' : ''} say <strong>${PATH_VERDICT[an.verdict].label.toLowerCase()}</strong>:
          ${esc(PATH_VERDICT[an.verdict].note)}
          ${an.intrusion_m > 0 ? `Worst intrusion ${Math.round(an.intrusion_m)} m into the 60% zone at ${fmtKm(an.worst.d1 / 1000)}.` : ''}
          ${an.verdict === 'obstructed' && itm ? 'The model has priced the obstruction; the margin above is what is left after it.' : ''}</p>` : ''}
      ${readoutHtml(r)}
      ${divergenceHtml(r)}`;
  }

  // Microvolts into 50 Ω, in the units a receiver's data sheet uses.
  function fmtUv(uv) {
    if (uv == null) return '';
    return uv >= 1000 ? `${(uv / 1000).toFixed(2)} mV` : uv >= 10 ? `${uv.toFixed(1)} µV` : `${uv.toFixed(2)} µV`;
  }

  // Radio Mobile's Radio Link window, as a definition list: the figures the
  // model computed on the way to the margin, and the ones a planner reads off
  // the same window — field strength, system gain, the horizons and the
  // elevation angles at each end — none of which change the margin, all of
  // which say what kind of path this is.
  function readoutHtml(r) {
    const an = r.an, itm = r.itm;
    if (!an) return '';
    const a = S().a, b = S().b;
    const bearing = bearingDeg(a.lat, a.lon, b.lat, b.lon);
    const w = an.worst;
    const rows = [
      ['Azimuth A→B', `${bearing.toFixed(1)}°`],
      ['Elevation angle', `${an.elevA_deg.toFixed(3)}° / ${an.elevB_deg.toFixed(3)}°`],
      ['Worst Fresnel', w.clearance >= 0 ? `${w.ratio.toFixed(2)} F1 at ${fmtKm(w.d1 / 1000)}`
        : `<span class="txt-bad">${Math.round(-w.clearance)} m above the line at ${fmtKm(w.d1 / 1000)}</span>`],
      ['Obstructions', an.obstructions.length
        ? an.obstructions.slice(0, 3).map(o => `${o.byCover ? 'cover' : 'ground'} +${Math.round(-o.peak.clearance)} m at ${fmtKm(o.peak.d1 / 1000)}`).join('; ')
          + (an.obstructions.length > 3 ? `; ${an.obstructions.length - 3} more` : '')
        : 'none'],
      ['Earth curvature', `k = ${an.k.toFixed(3)} <span class="small">N<sub>s</sub> ${an.N_s.toFixed(0)} at ${Math.round(an.hSys)} m</span>`],
    ];
    if (itm) {
      rows.push(
        ['Propagation mode', itm.modeLabel],
        ['Terrain irregularity Δh', `${itm.delta_h_m.toFixed(0)} m`],
        ['Effective heights', `${itm.h_e_m[0].toFixed(1)} / ${itm.h_e_m[1].toFixed(1)} m`],
        ['Horizons', `${fmtKm(itm.d_hzn_m[0] / 1000)} / ${fmtKm(itm.d_hzn_m[1] / 1000)}`],
        ['Median shift V<sub>med</sub>', `${itm.V_med_db.toFixed(1)} dB`],
        ['Variability Y<sub>R</sub> + Y<sub>S</sub>', `${(itm.Y_R_db + itm.Y_S_db).toFixed(1)} dB`],
      );
    }
    if (r.efield != null) rows.push(['E-field at RX', `${r.efield.toFixed(1)} dBµV/m`]);
    if (r.efieldReq != null) rows.push(['Required E-field', `${r.efieldReq.toFixed(1)} dBµV/m`]);
    if (r.sysGain != null) rows.push(['System gain A→B', `${r.sysGain.toFixed(1)} dB`]);
    const warns = itm && itm.warnings.length
      ? `<ul class="lb-warn-list small">${itm.warnings.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
    return `
      <dl class="lb-readout small">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
      </dl>
      ${warns}`;
  }

  function fmtList(xs) {
    if (xs.length <= 1) return xs[0] || '';
    return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  }

  // The pair of antenna heights an analysis was run on, as one phrase.
  function fmtAglPair(x, y) {
    const n = v => (v == null ? '?' : String(Math.round(v * 10) / 10));
    return `${n(x)} / ${n(y)} m antennas`;
  }

  // Whether the elevation profile above is drawn on the same assumptions this
  // table is computed on. It is the same path over the same terrain, but each
  // card carries its own frequency and antenna heights, so the chart can show a
  // clear path while this table quotes a diffraction loss off an obstructed
  // one. Neither figure is wrong; saying nothing about the gap is.
  function divergenceHtml(r) {
    const c = r.an && r.an.chart;
    if (!c) return '';
    const a = S().a, b = S().b;
    const same = (x, y) => x != null && y != null && Math.abs(x - y) < 0.05;
    // Heights, in metres off ~30 m tiles: agreeing to within half a metre is
    // agreeing. The budget's own end height is whatever fillGround put there,
    // and where there is none it fell back to the profile's sample — the same
    // number the chart used — so nothing to report.
    const sameM = (x, y) => x != null && y != null && Math.abs(x - y) < 0.5;
    const gA = a.ground != null ? a.ground : c.groundA;
    const gB = b.ground != null ? b.ground : c.groundB;
    const settings = !(same(c.fMhz, r.fMhz) &&
                       same(c.aglA, val(a, 'agl_m')) && same(c.aglB, val(b, 'agl_m')));
    // Only when the chart has a height at both ends to be compared against. A
    // profile with a missing tile at an end has none, and its own analysis
    // failed for that reason — quoting a picture that never drew is not a
    // divergence, it is noise on top of an error the panel already shows.
    const ground = c.groundA != null && c.groundB != null
      && !(sameM(c.groundA, gA) && sameM(c.groundB, gB));
    if (!settings && !ground) return '';
    return `
      ${settings ? `
        <p class="small lb-diverge">
          The elevation profile above is drawn at <strong>${c.fMhz.toFixed(3)} MHz</strong> over
          <strong>${fmtAglPair(c.aglA, c.aglB)}</strong> — not the figures in this table. Same path,
          same terrain, different assumptions, so the chart and the diffraction line above need not agree.
          <button class="lb-link" onclick="LinkBudget.matchProfile()">Redraw the chart on these figures</button>
        </p>` : ''}
      ${ground ? `
        <p class="small lb-diverge">
          The chart above stands its ends on <strong>${fmtGroundPair(c.groundA, c.groundB)}</strong>;
          this table stands them on <strong>${fmtGroundPair(gA, gB)}</strong>. That is a different line
          of sight over the same ridge, so the verdict here and the picture above can genuinely
          disagree — the profile reads an end off the terrain it sampled for the chart, and this card
          off the station's surveyed height or a single-point tile sample of its own. There is no
          button for this one: neither height is an assumption to be switched, and the honest
          reading is the surveyed one where a survey exists.
        </p>` : ''}`;
  }

  // The pair of ground heights an analysis stood its ends on, as one phrase.
  function fmtGroundPair(x, y) {
    const n = v => (v == null ? '?' : String(Math.round(v * 10) / 10));
    return `${n(x)} / ${n(y)} m of ground`;
  }

  // The propagation model's inputs — Radio Mobile's Network properties, on the
  // card. Every one starts from the figure the Radio Mobile export writes, so
  // the two tools argue from the same premises until somebody changes one here.
  function propHtml() {
    const P_ = S().prop;
    const D = RM_NET_DEFAULTS;
    const flag = (v, d) => `<b class="lb-flag">${Math.abs(Number(v) - Number(d)) < 1e-9 ? 'default · network' : 'edited'}</b>`;
    const sel = (key, label, opts, d) => `
      <label class="draw-field">
        <span>${label}</span>
        <select id="lb-prop-${key}" onchange="LinkBudget.setProp('${key}', this.value)">
          ${opts.map(([v, t]) => `<option value="${v}" ${Number(v) === Number(P_[key]) ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
        ${flag(P_[key], d)}
      </label>`;
    const num = (key, label, step, min, max, d, unit) => `
      <label class="draw-field">
        <span>${label}${unit ? ` <em>${unit}</em>` : ''}</span>
        <input type="number" id="lb-prop-${key}" step="${step}" min="${min}" max="${max}" value="${P_[key]}"
               onchange="LinkBudget.setProp('${key}', this.value)">
        ${flag(P_[key], d)}
      </label>`;
    // Which percentages the mode actually reads — the others are greyed, the
    // way Radio Mobile greys them, because in Spot mode only %situations enters
    // the model and a %time typed there would change nothing.
    const md = Number(P_.mdvar);
    const usesTime = md !== 0, usesLoc = md === 3;
    const pctField = (key, label, on) => `
      <label class="draw-field${on ? '' : ' is-unused'}">
        <span>${label}</span>
        <input type="number" id="lb-prop-${key}" step="1" min="0.1" max="99.9" value="${P_[key]}" ${on ? '' : 'disabled'}
               onchange="LinkBudget.setProp('${key}', this.value)">
        ${on ? flag(P_[key], key === 'time' ? D['%Time'] : key === 'location' ? D['%Location'] : D['%Situation'])
             : '<b class="lb-flag">not read in this mode</b>'}
      </label>`;
    return `
      <details class="lb-propset" ${S().propOpen ? 'open' : ''} ontoggle="LinkBudget.setPropOpen(this.open)">
        <summary class="small">Propagation settings — climate, ground, reliability
          <span class="txt-muted">(${esc(ITM.CLIMATE[P_.climate])}, ${esc(ITM.MDVAR[P_.mdvar] || '')}, ${P_.situation}% of situations)</span></summary>
        <div class="lb-prop">
          ${sel('climate', 'Radio climate', Object.entries(ITM.CLIMATE), D.Climate)}
          ${num('N0', 'Surface refractivity', 1, 250, 400, D.Refractivity, 'N-units')}
          ${num('epsilon', 'Ground permittivity', 1, 1, 100, D.Permittivity, 'ε<sub>r</sub>')}
          ${num('sigma', 'Ground conductivity', 0.001, 0.0001, 10, D.Conductivity, 'S/m')}
          ${sel('pol', 'Polarization', [[0, 'Horizontal'], [1, 'Vertical']], D.Polarization)}
          ${sel('mdvar', 'Mode of variability', Object.entries(ITM.MDVAR), D['Stat. mode'])}
          ${pctField('time', '% of time', usesTime)}
          ${pctField('location', '% of locations', usesLoc)}
          ${pctField('situation', '% of situations', true)}
        </div>
        <p class="filter-hint">Longley–Rice's own inputs, one for one with Radio Mobile's network properties.
          Refractivity 301 is k = 4/3; average ground is ε<sub>r</sub> 15, σ 0.005 S/m (poor 4 / 0.001, good 25 / 0.02,
          sea water 81 / 5). Spot mode reads only % of situations; Accidental and Mobile add % of time;
          Broadcast reads all three. Higher percentages ask for a more reliable link and cost margin.
          <button type="button" class="lb-link" onclick="LinkBudget.resetProp()">Reset to the network defaults</button></p>
      </details>`;
  }

  // What this card models, what Radio Mobile models, and what neither does —
  // kept as a table because "the same model" is a claim that deserves to be
  // checked line by line, and the lines where it is *not* the same still
  // matter to anyone deciding on the figure.
  function comparisonHtml() {
    const N = RM_NET_DEFAULTS;
    const rows = [
      ['Propagation model', 'Longley–Rice ITM v1.2.2, point-to-point — NTIA’s reference code ported line for line and held to it at 10<sup>−6</sup> dB',
       'The same ITM, except line-of-sight paths, where Radio Mobile substitutes its own two-ray method'],
      ['Terrain', 'SRTM/GMTED ~30 m tiles, 256 samples along the great circle', 'Its own DEM (SRTM 3″ or 1″), up to 500 samples'],
      ['Land cover', 'Sentinel-2 10 m classes, a height per class (editable), stood on the profile; measured canopy heights for trees',
       'GlobCover ~300 m classes with a height and a “density” per class, plus unpublished forest and urban loss terms'],
      ['Terminal in trees or town', 'ITU-R P.2108 §3.1 height-gain loss when the antenna is below the cover', 'Part of the same unpublished clutter term'],
      ['Climate &amp; refractivity', 'Modelled — the same seven climates and N<sub>s</sub>', `Modelled (export writes climate ${N.Climate}, N ${N.Refractivity})`],
      ['Statistical reliability', 'Modelled — %time / %locations / %situations by mode', `Modelled (export writes ${N['%Time']} / ${N['%Location']} / ${N['%Situation']})`],
      ['Ground constants, polarisation', 'Modelled', 'Modelled'],
      ['Earth curvature', 'k from N<sub>s</sub> at the path’s mean height, the same as the model’s', 'k = 1.3333 from N<sub>s</sub> = 301, fixed'],
      ['Antenna patterns', '<em>Not modelled</em> — one gain figure, in every direction', 'Real .ant patterns with azimuth and tilt'],
      ['Ducting, rain, multipath fading', '<em>Not modelled</em> beyond the model’s own time variability', 'The same — nothing beyond ITM'],
      ['Interference / noise floor', '<em>Not modelled</em> — see the RF Environment tab for ACMA co-channel risk', 'Not modelled'],
    ];
    return `
      <details class="lb-compare">
        <summary>What this models, next to Radio Mobile — and what neither does</summary>
        <p class="small">The figure is a <strong>model output</strong>: the same public-domain propagation model Radio
          Mobile runs, over ~30 m terrain and 10 m land cover, with representative heights standing in for the
          trees and buildings a survey would measure. It is as good as its inputs. The rows that say
          <em>not modelled</em> all cost real margin, and an antenna pattern pointed the wrong way costs more than
          any of them — confirm on air before anything is built on it.</p>
        <div class="table-wrap">
          <table class="lb-compare-table">
            <caption class="sr-only">What this budget models against what Radio Mobile models, term by term</caption>
            <thead><tr><th scope="col"><span class="sr-only">Term</span></th>
              <th scope="col">MegaNet</th>
              <th scope="col">Radio Mobile</th></tr></thead>
            <tbody>${rows.map(([k, mine, rm]) =>
              `<tr><th scope="row">${k}</th><td>${mine}</td><td>${rm}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`;
  }

  function bodyHtml() {
    const S_ = S();
    const r = compute();
    return `
      <div class="lb-disclaimer" role="alert">
        ⚠️ <strong>A model, not a measurement.</strong> Longley–Rice over sampled terrain and land cover, at the
        reliability set below. Antenna patterns, interference and the trees the map missed are not in it.
        Confirm on air before building on the figure.
      </div>
      <div class="lb-controls">
        <label class="filter-check">
          <input type="checkbox" ${S_.picking ? 'checked' : ''}
                 onchange="LinkBudget.setPicking(this.checked)">
          Pick two points on the map
        </label>
        <label class="draw-field">
          <span>Frequency (MHz)</span>
          <input type="number" step="0.1" min="1" id="lb-freq" value="${freqOf()}"
                 onchange="LinkBudget.setFreq(this.value)">
          <!-- The box is never blank: clearing it falls straight back to the
               repeater's channel or the network's band, which on screen is
               indistinguishable from having typed that figure in. The flag is
               what tells them apart, and it is the one the elevation profile's
               otherwise-identical box has carried all along. -->
          <b class="lb-flag">${S_.freqMhz != null ? 'edited'
            : (S_.a && S_.a.freq > 0) || (S_.b && S_.b.freq > 0)
              ? 'default · repeater channel' : 'default · network band'}</b>
        </label>
        <button id="lb-clear-both" onclick="LinkBudget.reset()"
                ${S_.a || S_.b || findQ('a').trim() || findQ('b').trim() ? '' : 'disabled'}
                >Clear both ends</button>
      </div>
      <p class="filter-hint">${S_.target
        ? `Every value below can be overridden, whichever way an end was picked.`
        : S_.picking
          ? 'Click a station to fill it in from its Radio Mobile system, or click empty ground for a hypothetical site. Every value below can be overridden.'
          : 'Search for either end below, or set both from a line drawn in Draw &amp; measure.'}</p>
      <div class="lb-ends">
        ${endpointCard('a', S_.a)}
        ${endpointCard('b', S_.b)}
      </div>
      ${propHtml()}
      ${r ? budgetHtml(r) : '<p class="filter-note">Set both ends to see a budget.</p>'}
      ${comparisonHtml()}`;
  }

  function panelHtml() {
    return `
      <details class="lb-panel" ${S().open ? 'open' : ''}
               ontoggle="LinkBudget.setOpen(this.open)">
        <summary>
          <h3>Link budget <span class="lb-badge">modelled</span></h3>
          <span class="small">Fade margin between two points — Longley–Rice over terrain and cover</span>
        </summary>
        <div class="lb-body">${S().open ? bodyHtml() : ''}</div>
      </details>`;
  }

  function rerender() {
    const el = document.getElementById('link-budget-panel');
    if (!el) return;
    const d = el.querySelector(':scope > details.lb-panel');
    // First paint only — after this the element is never replaced (#160).
    if (!d) { el.innerHTML = panelHtml(); return; }
    // Replacing an open <details> re-fires toggle on insertion in current
    // Chromium — the self-sustaining loop setOpen's guard breaks — and
    // replacing it in the same breath as a click eats the click. So from here
    // on only the body is repainted, and the element's own `open` is
    // authoritative: the browser writes it on the user's gesture before any
    // handler runs, so a repaint that disagrees has stale state and ADOPTS
    // the element's answer rather than overriding the person.
    if (d.open !== S().open) {
      S().open = d.open;
      S().picking = d.open;
    }
    const body = d.querySelector(':scope > .lb-body');
    if (body) keepFocus(() => { body.innerHTML = S().open ? bodyHtml() : ''; });
  }

  // A repaint must not eat what somebody is in the middle of typing. The body
  // is replaced wholesale, so every control in it is a different element
  // afterwards: this notes which one held the caret, where the caret sat and
  // what was in the box, and puts all three back by id.
  //
  // Not a nicety. The number fields commit on `change`, so everything typed
  // since the last blur is uncommitted — and fillGround() repaints whenever a
  // terrain tile lands, seconds after the click that asked for it. A figure
  // half-typed when the tile arrived was thrown away silently, the box
  // reverting to its default under the cursor. Buttons are restored too, so
  // pressing one that redraws itself does not drop focus on <body>.
  function keepFocus(paint) {
    const el = document.activeElement;
    const id = el && el.id && el.id.startsWith('lb-') ? el.id : null;
    const box = id && el.tagName === 'INPUT';
    const value = box ? el.value : null;
    let start = null, end = null;
    // Only some input types expose a selection; a number field throws.
    if (box) try { start = el.selectionStart; end = el.selectionEnd; } catch { /* no caret */ }
    paint();
    if (!id) return;
    const next = document.getElementById(id);
    if (!next || next === el) return;
    if (value != null && next.value !== value) next.value = value;
    next.focus({ preventScroll: true });
    if (start != null) try { next.setSelectionRange(start, end); } catch { /* no caret */ }
  }

  // Somewhere deliberate for the caret to land when the control that had it has
  // been repainted out of existence, following renderSearchStack's rule in
  // app.js: a control that vanishes under the pointer hands focus on rather
  // than letting the document have it. Never moves focus that was somewhere
  // else — a repaint the operator did not cause must not steal it.
  function handFocus(id) {
    const el = document.getElementById(id);
    if (!el || el.disabled) return;
    const at = document.activeElement;
    if (at && at !== document.body && !document.getElementById('link-budget-panel').contains(at)) return;
    el.focus({ preventScroll: true });
  }

  // The two clear buttons and the one below them, without a repaint — typing
  // must never redraw the box being typed into.
  function refreshClears() {
    const S_ = S();
    for (const w of ['a', 'b']) {
      const b = document.getElementById(`lb-clear-${w}`);
      if (b) b.disabled = !(S_[w] || findQ(w).trim());
    }
    const both = document.getElementById('lb-clear-both');
    if (both) both.disabled = !(S_.a || S_.b || findQ('a').trim() || findQ('b').trim());
  }

  return {
    attach(m) {
      map = m;
      layer = L.layerGroup().addTo(m);
      clickHandler = onMapClick;
      m.on('click', clickHandler);
      // Endpoints outlive the map they were picked on. A ground sample that was
      // still in flight when the tab changed resolved against a dead panel, so
      // the card came back reading "sampling…" with nothing sampling it.
      fillGround(S().a); fillGround(S().b);
      drawMarkers();
    },
    detach() {
      if (map && clickHandler) map.off('click', clickHandler);
      // The one caller destroys the map on the next line, which would take this
      // with it — but app.js documents every detach() as self-contained and
      // re-runnable, and against a map that survives this stranded the A/B
      // markers and the dashed line with nothing left holding them.
      if (map && layer) map.removeLayer(layer);
      map = null; layer = null; clickHandler = null;
    },

    panelHtml, rerender,

    setOpen(v) {
      // Idempotent, and that is load-bearing rather than tidy (#160): current
      // Chromium fires a toggle event when a parsed `<details open>` is
      // *inserted*, and rerender() replaces the whole details. Without this
      // guard the open panel re-enters itself — toggle → setOpen → rerender →
      // insert open details → toggle — thousands of times a second: the CPU
      // pegs, every click lands on a just-detached summary, and the panel
      // "won't collapse", with nothing thrown anywhere. The browser has
      // already flipped the element by the time this runs; when the recorded
      // state matches, there is nothing to do.
      if (S().open === !!v) return;
      S().open = !!v;
      // Expanding the card arms the pick; collapsing it disarms, so a stray map
      // click doesn't quietly move an endpoint on a card nobody is looking at.
      S().picking = !!v;
      rerender();
    },
    setPicking(v) {
      S().picking = !!v;
      // Disarming the map disarms the end that was waiting on it: an armed end
      // that no longer answers clicks is a card claiming a mode it does not
      // have. MapMovePin calls this on its way in for exactly that reason.
      if (!S().picking) S().target = null;
      rerender();
    },

    // Arm an end: the next station picked anywhere — a pin, the ground, a row
    // in the Stations list, or a result in this end's own box — fills it.
    //
    // Idempotent, and that is load-bearing rather than tidy: the box arms on
    // focus, arming repaints the card, and the repaint puts focus back (see
    // keepFocus) — so a version that did work on every call would re-enter
    // itself for as long as the caret stayed in the box, exactly as setOpen's
    // guard exists to stop <details> doing.
    arm(which) {
      if (which !== 'a' && which !== 'b') return;
      if (S().target === which && S().picking) return;
      S().target = which;
      S().picking = true;
      rerender();
    },

    disarm() {
      if (!S().target) return;
      S().target = null;
      rerender();
    },

    // Typing in an end's box. Only the list under it is repainted — never the
    // box — so the caret and a part-typed word survive, which is the rule the
    // Stations filter box and the ARRO Launcher both run on. No debounce: this
    // is one linear pass over the station list capped at 26 hits, not a rebuild
    // of ~3,174 markers and a table.
    setSearch(which, text) {
      if (which !== 'a' && which !== 'b') return;
      findQ(which);
      const S_ = S();
      if (S_.q[which] === text) return;
      S_.q[which] = String(text == null ? '' : text);
      const el = document.getElementById(`lb-hits-${which}`);
      if (el) el.innerHTML = findListHtml(which);
      refreshClears();
    },

    // A result in an end's own list. Picking is deliberately not the same as
    // selecting: the editor card below stays on whatever it was on, because an
    // operator building a budget asked for an endpoint, not for the form to be
    // reloaded and the map flown somewhere.
    pick(which, sid) {
      const w = which === 'b' ? 'b' : 'a';
      if (!takeStationEnd(sid, w)) return;
      // The button that was pressed has just been replaced by the repaint that
      // followed it, so a keyboard user would be dropped on <body>. The box
      // beside it cannot take the focus back — focusing it re-arms the end that
      // has only this moment been filled — so it goes to the control that
      // undoes the pick, which is the one thing anybody would want next.
      handFocus(`lb-clear-${w}`);
    },

    // Offered by selectStation() — a row in the Stations list, in whatever
    // state the filters have it — and by a pin click, which never reaches the
    // map's own click handler (the markers are built with
    // bubblingMouseEvents:false, so the pin swallows it). Answers whether it
    // was taken.
    takeStation(sid) {
      const t = S().target;
      if ((t !== 'a' && t !== 'b') || !state.data) return false;
      return takeStationEnd(sid, null);
    },

    // A click landing dead on a station pin, offered by app.js's marker
    // handler. Wider than takeStation: the pick does not have to be aimed at a
    // named end, because "Pick two points on the map" is itself the operator
    // saying the map is doing the choosing — with nothing armed this fills A,
    // then B, exactly as a click on the ground beside the pin always has.
    mapPickStation(sid) {
      if (!S().picking || state.draw.tool || !state.data) return false;
      return takeStationEnd(sid, null);
    },
    setFreq(v) {
      const n = Number(v);
      S().freqMhz = isFinite(n) && n > 0 ? n : null;
      rerender();
      // The profile chart's curvature and cover terms do not move with the
      // frequency, but the map's radio-path card quotes this budget.
      MapBackbone.profileChanged();
    },

    // One propagation setting. The model validates ranges itself and says why
    // it refused; the card only keeps the box a number. The chart follows,
    // because its earth curvature is the refractivity's.
    setProp(key, v) {
      const P_ = S().prop;
      if (!(key in P_)) return;
      const n = Number(v);
      if (!isFinite(n)) return;
      P_[key] = key === 'climate' || key === 'pol' || key === 'mdvar' ? Math.round(n) : n;
      rerender();
      PathProfile.rerender();
      MapBackbone.profileChanged();
    },
    resetProp() {
      const D = RM_NET_DEFAULTS;
      S().prop = {
        climate: D.Climate, N0: D.Refractivity, epsilon: D.Permittivity, sigma: D.Conductivity,
        pol: D.Polarization, mdvar: D['Stat. mode'],
        time: D['%Time'], location: D['%Location'], situation: D['%Situation'],
      };
      rerender();
      PathProfile.rerender();
      MapBackbone.profileChanged();
    },
    setPropOpen(v) { S().propOpen = !!v; },
    setField(which, k, v) {
      const e = S()[which];
      if (!e) return;
      const n = v.trim() === '' ? null : Number(v);
      // Blanking a box puts the default back rather than leaving a hole.
      e.over[k] = n != null && isFinite(n) ? n : null;
      if (e.over[k] == null) delete e.over[k];
      rerender();
    },
    // Clear one end: the endpoint, its overrides and whatever is typed in its
    // box. An armed end stays armed — "clear this and pick another" is what the
    // button is usually pressed for, and there is a separate control that says
    // stop.
    clearEnd(which) {
      if (which !== 'a' && which !== 'b') return;
      findQ(which);
      S()[which] = null;
      S().q[which] = '';
      drawMarkers();
      rerender();
      // The button that was just pressed is now disabled — there is nothing
      // left to clear — and a disabled control cannot hold focus. Hand it to
      // the link beside it, which is how the end gets filled again.
      handFocus(`lb-arm-${which}`);
    },
    reset() {
      const S_ = S();
      findQ('a');
      S_.a = null; S_.b = null;
      S_.q.a = ''; S_.q.b = '';
      drawMarkers();
      rerender();
    },

    // The profile panel finished (or failed) — the diffraction line follows it.
    profileChanged() { if (S().open) rerender(); },

    // The budget as computed for the current endpoints, or null while either
    // end is unset. Read-only: the radio-path card quotes this so the figure
    // on the card and the figure in this panel can never disagree.
    current() { return compute(); },

    // "Link budget for this path →" on the profile panel: take the drawn line's
    // two ends as the budget's endpoints.
    fromProfile() {
      const sh = PathProfile.target();
      if (!sh || sh.pts.length !== 2) { mapNote('Draw a two-point line first', 3000); return; }
      const pick = i => {
        const ids = sh.snappedTo || [];
        const sid = i === 0 ? ids[0] : ids[ids.length - 1];
        const st = sid && state.data ? state.data.stations.find(s => s.id === sid) : null;
        return st ? stationEndpoint(st) : pointEndpoint(sh.pts[i][0], sh.pts[i][1]);
      };
      S().open = true;
      S().a = pick(0); S().b = pick(1);
      // Both ends have just been replaced wholesale, so a half-typed search
      // against the old ones is a question about something that is no longer
      // on the card. The arm goes with them for the same reason.
      findQ('a');
      S().q.a = ''; S().q.b = '';
      S().target = null;
      fillGround(S().a); fillGround(S().b);
      drawMarkers();
      // The one programmatic opener, so it writes the element as well as the
      // state — rerender() treats the element as authoritative and would
      // otherwise adopt its closed answer right back (#160).
      const d = document.querySelector('#link-budget-panel > details.lb-panel');
      if (d && !d.open) d.open = true;
      rerender();
      const el = document.getElementById('link-budget-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // The other direction: draw the budget's two ends as a line so the profile
    // panel picks them up and the diffraction term can be filled in.
    profileThis() {
      const { a, b } = S();
      if (!a || !b) return;
      // Open the panel BEFORE the line goes in, not after. Adding a shape
      // re-renders the profile panel synchronously and terrain then takes
      // seconds to arrive, so setting `open` afterwards left the operator
      // scrolled to a collapsed, empty card for the whole fetch — the button
      // looking like it had done nothing at all, which is what it was reported
      // as. The panel now opens on the same tick as the press and shows its own
      // "sampling terrain…" line while the tiles come in.
      state.path.open = true;
      // A second press must land back on the first line rather than stack an
      // identical one underneath it. Nothing on screen distinguishes two lines
      // between the same two points, so they only ever turn up as a Draw &
      // measure list that grows every time this button is pressed.
      const [pa, pb] = [[a.lat, a.lon], [b.lat, b.lon]];
      const existing = MapDraw.findLine(pa, pb);
      if (existing) MapDraw.focus(existing.id);
      else MapDraw.addLine([pa, pb], [a.sid || null, b.sid || null]);
      const el = document.getElementById('path-profile-panel');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // The chart and this table are describing the same hop with different
    // antenna heights or a different frequency. Put the budget's figures into
    // the profile panel so the picture matches the numbers.
    //
    // A button rather than something profileThis() does silently: state.path
    // holds one set of overrides for *every* line drawn on the map, so writing
    // to it would quietly re-height the next hand-drawn path as well. That is
    // the operator's call to make, once, with the divergence in front of them.
    matchProfile() {
      const { a, b } = S();
      if (!a || !b) return;
      const an = analysisFor(a, b);
      if (!an) return;
      const A = val(a, 'agl_m'), B = val(b, 'agl_m');
      state.path.freqMhz = freqOf();
      state.path.aglA = an.chartFlipped ? B : A;
      state.path.aglB = an.chartFlipped ? A : B;
      PathProfile.rerender();
      rerender();
    },
  };
})();

