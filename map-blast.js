// MegaNet — map-blast.js
//
//   Blast radius (#161): pick a repeater on the Stations map and see what goes
//   dark if it dies — the pass-range links into it turn red, and the field
//   stations with no other repeater to fall back to get a red dashed ring.
//   Single hop, deliberately: "stranded" here means this repeater is the
//   station's ONLY carrier under the distance rule on screen, not that some
//   longer relay story ends badly (that would need a traversal to a base, and
//   what a base can hear is not in stations.json — see the issue's stop rule).
//
//   blastAnalysis(repeaterId)  carried / stranded under the drawn-link
//                              distance rule — cached on state.blastIdx, keyed
//                              on the rule the way backboneIndex().delays is
//                              keyed on the slider.
//   MapBlast                   arm/disarm (a mode on the existing repeater
//                              focus, not a new selection), the in-place
//                              restyle of pins and lines, the readout card
//                              under the map, and the stranded list as CSV.
//
// After map-backbone.js, before init.js — index.html holds the order and the
// reasons. Reaches back to core.js for state, esc, escAttr, fmtKm,
// acmaHaversineKm, dlText, csvEscape, netName; across to app.js for
// passRelationIndex, findStationMatches, stationAlertIds, applyMapFocusStyles,
// applyMapLabels, setMapFocusRepeater, zoomToStation and the two blast tokens'
// draw-time resolution convention (Leaflet options are SVG presentation
// attributes and do not take var() — the ACMA_MECH trap).
//
// Two systems already draw a station on that map and #151 taught the second
// one about the first's filter dim. This is a third, and it composes the same
// way: the blast restyle only ever touches ring colour, weight, dash and
// radius — opacity stays whatever the filter dim and the focus dim decided,
// so a stranded pin that also fails the filter stays faded with a red ring
// rather than fighting over it.

// ── The analysis ─────────────────────────────────────────────────────────────
// The distance rule is the map's own: with "Kill spaghetti" on, a fallback
// repeater only counts if it is within the Max TX distance slider — because a
// red line has to be a line that was drawn, and the drawn links live under
// that cull. With it off, any pass-range carrier counts however far away. A
// pair with no coordinates on one end cannot be distance-tested, so it counts
// as a fallback under either rule — the conservative direction: fewer rings,
// never a ring justified by a distance nobody measured.

function blastRuleMaxKm() {
  return state.mapKillSpaghetti ? state.mapMaxLinkKm : Infinity;
}

function blastWithinRule(a, b, maxKm) {
  if (!isFinite(maxKm)) return true;
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return true;
  return acmaHaversineKm(a.lat, a.lon, b.lat, b.lon) <= maxKm;
}

// carried: field stations this repeater carries under the rule, nearest first.
// stranded: the subset with no other carrier under the same rule. The 1,083
// stations that already have no carrier at all are absent from both by
// construction — they are the Pass Ranges tab's orphans, and counting them
// would answer "who is unreachable", not "who does this removal strand".
function blastAnalysis(repeaterId) {
  const maxKm = blastRuleMaxKm();
  if (!state.blastIdx || state.blastIdx.maxKm !== maxKm) {
    state.blastIdx = { maxKm, map: new Map() };
  }
  const cached = state.blastIdx.map.get(repeaterId);
  if (cached) return cached;

  const R = state.data && state.data.stations.find(s => s.id === repeaterId);
  if (!R) return { carried: [], stranded: [], maxKm };

  const byStation = passRelationIndex().byStation;
  const withKm = s => ({
    s,
    km: (s.lat != null && s.lon != null && R.lat != null && R.lon != null)
      ? acmaHaversineKm(s.lat, s.lon, R.lat, R.lon) : null,
  });
  const carried = findStationMatches(R)
    .filter(s => blastWithinRule(s, R, maxKm))
    .map(withKm)
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || a.s.name.localeCompare(b.s.name));
  const stranded = carried.filter(({ s }) =>
    !(byStation.get(s.id) || []).some(r => r.id !== R.id && blastWithinRule(s, r, maxKm)));

  const result = { carried, stranded, maxKm };
  state.blastIdx.map.set(repeaterId, result);
  return result;
}

// ── The mode, the restyle and the card ───────────────────────────────────────

const MapBlast = (function () {

  const RING_WEIGHT = 4;        // the ring's second channel is not its colour:
  const RING_DASH   = '6,4';    // heavier than any base ring, dashed longer
  const RING_GROW   = 2;        // than the cyan relation ring, and grown 2 px

  function armedId() {
    return state.mapBlast && state.mapFocusRepeaterId ? state.mapFocusRepeaterId : null;
  }

  function token(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  // Put the blast restyle on, or take it off, in place. Called from the tail
  // of applyMapFocusStyles, so it runs after every rebuild, after every focus
  // change, and after the slider moves — and always paints over the focus
  // pass's ring decisions, never its opacity ones.
  function applyStyles() {
    const id = armedId();
    const a = id ? blastAnalysis(id) : null;
    const strandedIds = a ? new Set(a.stranded.map(x => x.s.id)) : null;
    const ringColor = a ? token('--map-blast-ring', '#b71c1c') : null;
    const lineColor = a ? token('--map-blast', '#c62828') : null;

    for (const m of state.mapMarkers) {
      const base = m.mnBaseStyle;
      if (!base) continue;
      const ring = !!strandedIds && strandedIds.has(m.mnStationId);
      if (ring) {
        m.setStyle({ color: ringColor, weight: RING_WEIGHT, dashArray: RING_DASH });
        if (!m.mnBlastRing) m.setRadius((m.mnRadius || 5) + RING_GROW);
      } else if (m.mnBlastRing) {
        m.setStyle({ color: base.color, weight: base.weight, dashArray: base.dashArray });
        m.setRadius(m.mnRadius || 5);
      }
      m.mnBlastRing = ring;
    }

    // The dying links: every drawn pass-range path into the armed repeater.
    // Colour is not their only channel either — under the focus dim these are
    // exactly the lines still at full opacity, so red-vs-faded carries the
    // distinction even where red-vs-orange cannot.
    const restore = state.mapLines.some(l => l.mnBlastRed)
      ? token('--map-line', '#ff6f00') : null;
    for (const l of state.mapLines) {
      if (l.mnLinkRole !== 'core') continue;
      const red = !!id && l.mnLinkRepeaterId === id && !l.mnLinkRepeaterId2;
      if (red) l.setStyle({ color: lineColor });
      // Restore to the line's own colour, not the global token: MapLos may
      // have painted this line obstructed-red, and disarming a blast must
      // not quietly declare its path clear.
      else if (l.mnBlastRed) l.setStyle({ color: l.mnBaseColor || restore });
      l.mnBlastRed = red;
    }

    renderCard();
  }

  // ── The readout ────────────────────────────────────────────────────────────

  function ruleHtml(maxKm) {
    return isFinite(maxKm)
      ? `counting fallback repeaters within <strong>${maxKm} km</strong> (the Max TX distance
         slider — move it and this answer follows)`
      : `counting a fallback repeater at <strong>any distance</strong> — “Kill spaghetti” is off,
         so no distance rule is applied`;
  }

  function cardHtml() {
    const id = armedId();
    if (!id || !state.data) return '';
    const R = state.data.stations.find(s => s.id === id);
    if (!R) return '';
    const a = blastAnalysis(id);

    const header = `
      <div class="panel-header">
        <h3>Blast radius — ${esc(R.name)}</h3>
        <span class="badge" title="Field stations with no other repeater to fall back to">${a.stranded.length}</span>
        <button type="button" onclick="MapBlast.disarm()"
                title="Take the blast styling off the map">Clear</button>
      </div>
      <p class="small st-note">
        If <strong>${esc(R.name)}</strong> goes dark, its ${a.carried.length} pass-range
        link${a.carried.length === 1 ? '' : 's'} die
        (<span class="blast-swatch-line" aria-hidden="true"></span> on the map) and the stations
        below have nowhere else to go
        (<span class="blast-swatch-ring" aria-hidden="true"></span> ring), ${ruleHtml(a.maxKm)}.
        Stations with no carrier at all today are not in this count: they are already orphaned
        (see the Pass Ranges tab), and removing this repeater changes nothing for them.
      </p>`;

    if (!a.carried.length) {
      return `${header}
        <p class="small st-note"><strong>Nothing breaks.</strong>
        ${esc(R.name)} carries no field stations under this rule, so there is nothing to strand.</p>`;
    }
    if (!a.stranded.length) {
      return `${header}
        <p class="small st-note"><strong>Nothing goes dark.</strong>
        Every one of the ${a.carried.length} stations this repeater carries can reach at least one
        other repeater under this rule — 63 of the network's 88 repeaters give this same answer.</p>`;
    }

    return `${header}
      <div class="table-wrap medium st-note" role="region" tabindex="0"
           aria-label="Stations stranded if ${escAttr(R.name)} goes dark — ${a.stranded.length}">
        <table>
          <caption class="sr-only">Every field station that would have no repeater left if this one went dark, with its ALERT addresses, radio network and distance</caption>
          <colgroup><col style="width:44%"><col style="width:20%"><col style="width:20%"><col style="width:16%"></colgroup>
          <thead><tr><th scope="col">Stranded station</th><th scope="col">ALERT ID(s)</th>
            <th scope="col">Network</th><th scope="col">Distance</th></tr></thead>
          <tbody>
            ${a.stranded.map(({ s, km }) => `
              <tr class="row-link" onclick="zoomToStation('${escAttr(s.id)}')"
                  title="Zoom the map to ${escAttr(s.name)}">
                <td><button type="button" class="row-open stn-name role-field"
                      onclick="event.stopPropagation();zoomToStation('${escAttr(s.id)}')"
                      title="Zoom the map to ${escAttr(s.name)}">${esc(s.name)}</button></td>
                <td class="small">${stationAlertIds(s).join(', ')}</td>
                <td class="small">${(s.radio_network_ids || []).map(nid => netName(nid)).join(', ')}</td>
                <td class="small">${km == null ? '—' : fmtKm(km)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="small st-note">
        <button type="button" class="link-btn" onclick="MapBlast.exportCsv()"
           title="The stranded list as a CSV file — same columns as this table, plus the station id">
          Download the stranded list (CSV)</button>
      </p>`;
  }

  function renderCard() {
    const el = document.getElementById('blast-card');
    if (!el) return;
    const html = cardHtml();
    el.innerHTML = html;
    el.hidden = !html;
  }

  return {
    applyStyles,

    // The popup affordance: arming is a mode on the repeater the operator
    // already picked, so the link lives where a repeater is already in hand.
    popupLinkHtml(s) {
      if (!s.roles.includes('repeater') || !s.repeater) return '';
      const on = armedId() === s.id;
      // A pill since #170, and a <button> with it: the action is in-page, so
      // this is the element #138 named — not an `<a href="#">` that navigates
      // to the top of the document if the handler ever throws.
      return `<button type="button" class="pill" onclick="MapBlast.toggle('${escAttr(s.id)}')"
        title="${on ? 'Take the blast styling off the map'
                    : 'Red links and rings: what stops getting in if this repeater dies'}"
        >${on ? 'Hide blast radius' : 'Show blast radius'}</button>`;
    },

    toggle(id) {
      const was = armedId();
      if (was === id) {
        state.mapBlast = false;
      } else {
        state.mapBlast = true;
        // Arming is built on the focus: same selection, one more consequence.
        if (state.mapFocusRepeaterId !== id) setMapFocusRepeater(id);
      }
      if (state.map) state.map.closePopup();
      applyMapFocusStyles();          // runs the blast restyle from its tail
      applyMapLabels();
    },

    disarm() {
      if (!state.mapBlast) return;
      state.mapBlast = false;
      applyMapFocusStyles();
      applyMapLabels();
    },

    exportCsv() {
      const id = armedId();
      if (!id) return;
      const R = state.data.stations.find(s => s.id === id);
      const a = blastAnalysis(id);
      const rule = isFinite(a.maxKm) ? `fallbacks within ${a.maxKm} km` : 'fallbacks at any distance';
      const lines = [`id,name,alert_ids,networks,km_to_${csvEscape(R ? R.id : id)},rule`];
      for (const { s, km } of a.stranded) {
        lines.push([
          csvEscape(s.id),
          csvEscape(s.name),
          csvEscape(stationAlertIds(s).join(' ')),
          csvEscape((s.radio_network_ids || []).map(nid => netName(nid)).join(' | ')),
          km == null ? '' : km.toFixed(1),
          csvEscape(rule),
        ].join(','));
      }
      dlText(`meganet-blast-${(R ? R.id : id)}.csv`, lines.join('\n'));
    },
  };
})();
