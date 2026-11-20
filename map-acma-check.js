// MegaNet — map-acma-check.js
//
//   MapAcmaCheck   two questions the 📜 ACMA licences tool (map-acma.js) is
//                  asked about the ground rather than about one station, as a
//                  section of its panel:
//
//                  · Where licences overlap — two licensed point-to-multipoint
//                    transmitters on the same frequency, at different sites,
//                    whose circles reach the same ground. A receiver there
//                    can hear both, so their messages can collide when both
//                    transmit at once; and a new transmitter there sits in
//                    two licences' planned areas. Shaded as the lens the two
//                    circles share, deepest first in a list.
//                  · Check a spot — press the map (or drag the marker) and it
//                    says what a field station there would transmit under:
//                    a licence at the spot, the circles it is inside on the
//                    chosen channel, how many same-frequency transmitters
//                    reach it, or how far it is from the nearest circle. For
//                    choosing a new site, or a move, before anybody drives out.
//
// Asked for 19 Nov 2026 with the Licence coverage view (map-views.js): "add a
// bit of creative thought … the kinds of things that would be useful here".
//
// After core.js, before init.js; reaches MapAcma (map-acma.js) for the
// register copy as it indexed it (MapAcma.core()), its panel (repaint) and its
// drawing (MapAcma.draw calls draw() here); core.js for esc, escAttr,
// termHtml, acmaHaversineKm, fmtKm and state; app.js for mapNote. All of it
// from inside functions, so nothing runs at load and this file's place among
// the modules is free (npm run toplevel).
//
// Exposes: attach, detach, html, draw, live, clear, stale, set, armSpot,
//          spotAt, clearSpot, overlaps, spot, WORDS.

const MapAcmaCheck = (() => {
  const KEY = 'mn-acma-check-v1';
  const LAP_PANE = 'mnAcmaLicLap', LAP_Z = 396;      // just over the licence areas (395)
  const SPOT_PANE = 'mnAcmaLicSpot', SPOT_Z = 645;
  const LIST_CAP = 80;
  const CLOSE_KM = 15;           // "close": two transmitters on one frequency nearer than this, whoever holds them
  // Which overlaps are drawn. Most are one holder's own repeaters, planned to
  // meet at their edges (623 of 663 in Nov 2026), and drawn together they
  // shade the whole coast; so the default is the 40 between two holders.
  const WHICH = [['other', 'Between two holders'], ['close', `Transmitters under ${CLOSE_KM} km apart`], ['all', 'Every overlap']];

  const WORDS = {
    overlap: 'Two licensed point-to-multipoint transmitters on the same frequency, at sites more than 200 m apart, whose '
      + 'circles reach the same ground. A receiver there can hear both, so messages sent by both at once can collide; and a '
      + 'new transmitter there sits in both licences’ planned areas. Shaded where the two circles meet.',
    depth: 'How far the two circles reach into each other: the two radii added up, less the distance between the '
      + 'transmitters. The deeper, the more ground both cover.',
    spot: 'Press the map and Flood-Net reads what a field station transmitting there would run under: a licence at that '
      + 'spot, the circles it falls inside, or how far it is from the nearest one. Drag the marker to try somewhere else.',
    which: 'Between two holders: only where the two licences are held by different organisations — the overlaps nobody '
      + `planned together. Under ${CLOSE_KM} km apart: any two transmitters on one frequency that close, whoever holds them. `
      + 'Every overlap: all of them, most of which are one holder’s own repeaters meeting at their edges.',
    reach: 'How many licensed transmitters on one frequency have this spot inside their circle. More than one means a '
      + 'receiver here hears them all, and their messages can collide.',
  };
  const term = (k, text) => (typeof termHtml === 'function' ? termHtml(text, WORDS[k]) : esc(text));

  let map = null, lapLayer = null, spotLayer = null, lapRenderer = null;
  let P = load();
  let laps = null;               // { key, list }
  let spot = null;               // { lat, lon }
  let arming = false;

  function load() {
    const base = { laps: false, chan: 'any', which: 'other' };
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return v && typeof v === 'object' ? { laps: !!v.laps, chan: typeof v.chan === 'string' ? v.chan : 'any',
        which: WHICH.some(w => w[0] === v.which) ? v.which : 'other' } : base;
    } catch (_) { return base; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (_) { /* private mode */ } }

  const C = () => (typeof MapAcma !== 'undefined' && MapAcma.core ? MapAcma.core() : null);
  const hav = (a, b, c, d) => acmaHaversineKm(a, b, c, d);

  // ── Overlaps ────────────────────────────────────────────────────────────────

  function lapKey(c) {
    const s = MapAcma.summary();
    return [P.which, s.radius, s.power, s.holders.map(h => (h.on ? 1 : 0)).join('')].join('|') + `|${c.D.lics.length}`;
  }

  function overlaps() {
    const c = C();
    if (!c) return [];
    const key = lapKey(c);
    if (laps && laps.key === key) return laps.list;
    const tx = [];
    for (const l of c.counted()) {
      if (l.kind !== 'pmp' || !c.current(l)) continue;
      const R = c.radiusOf(l);
      for (const site of l.txSites) tx.push({ l, site, R });
    }
    const list = [], seen = new Set();
    for (let i = 0; i < tx.length; i++) {
      for (let j = i + 1; j < tx.length; j++) {
        const a = tx[i], b = tx[j];
        if (a.site === b.site) continue;
        const f = a.l.f.find(x => b.l.f.some(y => Math.abs(x - y) < c.SAME_MHZ));
        if (f == null) continue;
        // A cheap box first: one degree of latitude is 111 km.
        if (Math.abs(a.site.lat - b.site.lat) * 110.574 > a.R + b.R) continue;
        const d = hav(a.site.lat, a.site.lon, b.site.lat, b.site.lon);
        if (d <= c.SHARED_KM || d >= a.R + b.R) continue;
        if (P.which === 'other' && a.l.holder === b.l.holder) continue;
        if (P.which === 'close' && d >= CLOSE_KM) continue;
        const k = [a.site.id, b.site.id].sort().join('|') + `|${f.toFixed(4)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        list.push({ a, b, f, d, depth: a.R + b.R - d, same: a.l === b.l });
      }
    }
    list.sort((x, y) => y.depth - x.depth);
    laps = { key, list };
    return list;
  }

  // The lens two circles share, as lat/lon points. Worked out on a flat plane
  // round the first transmitter; at most 60 km across, that is good to metres.
  function lensOf(o) {
    const { a, b, d } = o;
    const lat0 = a.site.lat, lon0 = a.site.lon;
    const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
    const bx = (b.site.lon - lon0) * kx, by = (b.site.lat - lat0) * ky;
    const th = Math.atan2(by, bx);
    const r1 = a.R, r2 = b.R;
    const toLL = (x, y) => {
      const rx = x * Math.cos(th) - y * Math.sin(th), ry = x * Math.sin(th) + y * Math.cos(th);
      return [lat0 + ry / ky, lon0 + rx / kx];
    };
    const pts = [];
    const N = 40;
    if (d <= Math.abs(r1 - r2)) {
      // One inside the other: the lens is the smaller circle.
      const small = r1 <= r2 ? { x: 0, r: r1 } : { x: d, r: r2 };
      for (let i = 0; i < N * 2; i++) { const t = (i / (N * 2)) * Math.PI * 2; pts.push(toLL(small.x + small.r * Math.cos(t), small.r * Math.sin(t))); }
      return pts;
    }
    const x = (d * d + r1 * r1 - r2 * r2) / (2 * d);
    const h = Math.sqrt(Math.max(0, r1 * r1 - x * x));
    const a1 = Math.atan2(h, x), a2 = Math.atan2(h, d - x);
    for (let i = 0; i <= N; i++) { const t = -a1 + (2 * a1 * i) / N; pts.push(toLL(r1 * Math.cos(t), r1 * Math.sin(t))); }
    for (let i = 0; i <= N; i++) { const t = Math.PI - a2 + (2 * a2 * i) / N; pts.push(toLL(d + r2 * Math.cos(t), r2 * Math.sin(t))); }
    return pts;
  }

  // ── A spot ──────────────────────────────────────────────────────────────────

  function chanOf() { const f = Number(P.chan); return P.chan !== 'any' && Number.isFinite(f) ? f : null; }

  function spotAt(lat, lon) {
    const c = C();
    if (!c) return null;
    const chan = chanOf();
    const r = { lat, lon, chan, site: [], inside: [], nearest: null, reach: new Map() };
    for (const l of c.counted()) {
      if (!c.current(l)) continue;
      if (chan != null && !l.f.some(f => Math.abs(f - chan) < c.SAME_MHZ)) continue;
      for (const site of l.txSites) {
        const km = hav(lat, lon, site.lat, site.lon);
        if (km <= c.SITE_KM) r.site.push({ l, site, km });
        if (l.kind !== 'pmp') continue;
        const R = c.radiusOf(l);
        if (km <= R) {
          r.inside.push({ l, site, km, R, low: !!l.low && km > c.LOW_KM });
          for (const f of l.f) { const k = f.toFixed(4); const s = r.reach.get(k) || new Set(); s.add(site); r.reach.set(k, s); }
        } else if (!r.nearest || km - R < r.nearest.gap) r.nearest = { l, site, km, R, gap: km - R };
      }
    }
    r.inside.sort((x, y) => x.km - y.km);
    r.band = r.site.length ? 'covered' : r.inside.some(m => !m.low) ? 'covered' : r.inside.length ? 'unsure' : 'none';
    r.crowd = [...r.reach.entries()].filter(([, s]) => s.size > 1).map(([f, s]) => ({ f: Number(f), n: s.size }))
      .sort((x, y) => y.n - x.n);
    return r;
  }

  function spotText(r) {
    const c = C();
    if (!r || !c) return '';
    const chan = r.chan != null ? ` on ${c.mhz(r.chan)} MHz` : '';
    if (r.site.length) {
      const m = r.site[0];
      return `A licensed site${chan}: ${m.l.no} (${c.holderName(m.l)}) has a transmitter ${fmtKm(m.km)} from here.`;
    }
    if (r.inside.length) {
      const sure = r.inside.filter(m => !m.low);
      const m = (sure[0] || r.inside[0]);
      return `${sure.length ? 'Covered' : 'Uncertain'} for a field station${chan}: inside ${r.inside.length} licence${r.inside.length === 1 ? '’s circle' : 's’ circles'}, `
        + `the nearest ${m.l.no} (${c.holderName(m.l)}) ${fmtKm(m.km)} away.`
        + (sure.length ? '' : ` Only low-power licences reach here, and it is more than ${c.LOW_KM} km from each.`)
        + ' A repeater here would need a licence at its own site.';
    }
    if (r.nearest) {
      return `None found${chan}: outside every circle. The nearest is ${r.nearest.l.no} (${c.holderName(r.nearest.l)}), `
        + `${fmtKm(r.nearest.km)} away — ${fmtKm(r.nearest.gap)} past its ${r.nearest.R} km.`;
    }
    return `None found${chan}: no point-to-multipoint licence of the ticked holders${chan ? ' on that channel' : ''}.`;
  }

  // ── The section ─────────────────────────────────────────────────────────────

  function html() {
    const c = C();
    if (!c) return '';
    const list = P.laps || laps ? overlaps() : null;
    const chans = (c.D.meta.rules && c.D.meta.rules.network_channels_mhz) || [];
    const r = spot ? spotAt(spot.lat, spot.lon) : null;
    const lapRows = list ? list.slice(0, LIST_CAP).map((o, i) => `<tr class="sites-row-go" onclick="MapAcmaCheck.showLap(${i})">
        <td>${esc(o.a.l.no)} <span class="lic-muted">${esc(o.a.site.name)}</span></td>
        <td>${esc(o.b.l.no)} <span class="lic-muted">${esc(o.b.site.name)}</span></td>
        <td class="num">${esc(c.mhz(o.f))}</td><td class="num">${esc(fmtKm(o.d))}</td><td class="num">${esc(fmtKm(o.depth))}</td></tr>`).join('') : '';
    return `<fieldset class="sites-fs" data-tour="acma-check">
        <legend>Where licences overlap, and checking a spot</legend>
        <label class="lic-check lic-master"><input type="checkbox" id="acmachk-laps" ${P.laps ? 'checked' : ''}
            onchange="MapAcmaCheck.set('laps', this.checked)"> Shade where two licences ${term('overlap', 'on one frequency overlap')}</label>
        <div class="sites-row lic-selects"><label>${term('which', 'Which')} <select id="acmachk-which" onchange="MapAcmaCheck.set('which', this.value)">
          ${WHICH.map(([v, t]) => `<option value="${v}" ${P.which === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
        ${list ? `<details class="lic-more" id="acmachk-lap-list" ${list.length && list.length <= 12 ? 'open' : ''}>
          <summary>${list.length} overlap${list.length === 1 ? '' : 's'} — ${esc((WHICH.find(w => w[0] === P.which) || WHICH[0])[1].toLowerCase())}, deepest first</summary>
          ${list.length ? `<div class="lic-scroll"><table class="sites-table lic-table" id="acmachk-lap-table">
            <thead><tr><th scope="col">Licence</th><th scope="col">And licence</th><th scope="col">MHz</th>
              <th scope="col" title="The distance between the two transmitters.">Apart</th><th scope="col">${term('depth', 'Overlap')}</th></tr></thead>
            <tbody>${lapRows}</tbody></table></div>
            ${list.length > LIST_CAP ? `<p class="small txt-muted">The deepest ${LIST_CAP} of ${list.length}.</p>` : ''}`
            : '<p class="small txt-muted">No two licensed transmitters on one frequency reach the same ground.</p>'}
          <p class="small txt-muted">Repeaters on one output frequency are often planned to overlap at their edges; a deep overlap, or one
            between two holders, is the kind to ask about before adding a transmitter there.</p>
        </details>` : ''}
        <div class="sites-row lic-selects">
          <button type="button" id="acmachk-arm" onclick="MapAcmaCheck.armSpot()" aria-pressed="${arming ? 'true' : 'false'}"
                  title="${escAttr(WORDS.spot)}">${arming ? 'Press the map…' : spot ? 'Check another spot' : `Check a spot on the map`}</button>
          <label>Channel <select id="acmachk-chan" onchange="MapAcmaCheck.set('chan', this.value)">
            <option value="any" ${P.chan === 'any' ? 'selected' : ''}>Any</option>
            ${chans.map(f => `<option value="${escAttr(String(f))}" ${P.chan === String(f) ? 'selected' : ''}>${esc(c.mhz(f))} MHz</option>`).join('')}</select></label>
          ${spot ? '<button type="button" onclick="MapAcmaCheck.clearSpot()">Clear the spot</button>' : ''}
        </div>
        ${r ? `<div class="lic-spot lic-spot-${r.band}" id="acmachk-spot" role="status">
            <p><span class="term-chip lic-chip lic-band-${r.band}">${esc({ covered: 'Covered', unsure: 'Uncertain', none: 'None found' }[r.band])}</span>
              ${esc(spotText(r))}</p>
            ${r.inside.length ? `<ul class="lic-exp">${r.inside.slice(0, 6).map(m => `<li><button type="button" class="link-btn"
                onclick="MapAcma.pickLicence('${escAttr(m.l.no)}')">${esc(m.l.no)}</button> ${esc(c.holderName(m.l))} — ${esc(c.freqText(m.l))},
                ${esc(fmtKm(m.km))} of its ${m.R} km${m.low ? ` <span class="lic-muted">low power: more than ${c.LOW_KM} km</span>` : ''}</li>`).join('')}</ul>` : ''}
            ${r.crowd.length ? `<p class="small">${term('reach', 'Reach')}: ${r.crowd.slice(0, 3).map(x => `${x.n} transmitters on ${esc(c.mhz(x.f))} MHz`).join(', ')}
              reach this spot — a receiver here hears them all.</p>` : ''}
            <p class="small txt-muted">${Number(spot.lat).toFixed(5)}, ${Number(spot.lon).toFixed(5)} · drag the marker to move it.</p>
          </div>` : `<p class="small txt-muted">${esc(WORDS.spot)}</p>`}
        <details class="bestrep-words"><summary>What the words in this section mean</summary>
          <dl>${[['overlap', 'Overlap'], ['which', 'Which overlaps'], ['depth', 'Overlap (how deep)'], ['spot', 'Check a spot'], ['reach', 'Reach']]
            .map(([k, t]) => `<dt>${esc(t)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl></details>
      </fieldset>`;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    for (const l of [lapLayer, spotLayer]) if (l) l.remove();
    lapLayer = spotLayer = null;
  }

  function draw() {
    clearLayers();
    if (!map || !C()) return;
    if (P.laps) {
      lapLayer = L.layerGroup([], { pane: LAP_PANE }).addTo(map);
      lapRenderer = lapRenderer || L.canvas({ pane: LAP_PANE });
      const col = typeof cssVar === 'function' ? cssVar('--lic-lap', '#d81b60') : '#d81b60';
      for (const o of overlaps()) {
        L.polygon(lensOf(o), { pane: LAP_PANE, renderer: lapRenderer, color: col, weight: 1, opacity: 0.7, dashArray: '4 4',
          fillColor: col, fillOpacity: Math.min(0.22, 0.05 + o.depth / 250), interactive: false, mnLap: true }).addTo(lapLayer);
      }
    }
    if (spot) {
      spotLayer = L.layerGroup([], { pane: SPOT_PANE }).addTo(map);
      const r = spotAt(spot.lat, spot.lon);
      const col = { covered: '#2e7d32', unsure: '#e08a00', none: '#c62828' }[r ? r.band : 'none'];
      for (const m of r ? r.inside.slice(0, 6) : []) {
        L.polyline([[spot.lat, spot.lon], [m.site.lat, m.site.lon]], { pane: SPOT_PANE, color: col, weight: 2, opacity: 0.8,
          dashArray: m.low ? '4 6' : null, interactive: false }).addTo(spotLayer);
      }
      if (r && !r.inside.length && r.nearest) {
        L.polyline([[spot.lat, spot.lon], [r.nearest.site.lat, r.nearest.site.lon]], { pane: SPOT_PANE, color: col, weight: 2,
          opacity: 0.7, dashArray: '2 6', interactive: false }).addTo(spotLayer);
      }
      const icon = L.divIcon({ className: 'lic-spot-pin', html: `<span style="--dot:${col}" aria-hidden="true">✚</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const mk = L.marker([spot.lat, spot.lon], { pane: SPOT_PANE, icon, draggable: true, keyboard: true, title: 'The spot being checked — drag to move it' });
      mk.on('dragend', () => { const ll = mk.getLatLng(); MapAcmaCheck.spotAt(ll.lat, ll.lng); });
      mk.addTo(spotLayer);
    }
  }

  function repaint() {
    draw();
    if (typeof MapAcma !== 'undefined' && MapAcma.repaint) MapAcma.repaint();
  }

  function onMapClick(e) {
    if (!arming) return;
    arming = false;
    if (map) map.getContainer().classList.remove('lic-arming');
    MapAcmaCheck.spotAt(e.latlng.lat, e.latlng.lng);
  }

  return {
    attach(m) {
      map = m;
      lapRenderer = null;
      const pane = (name, z, events) => { if (!m.getPane(name)) { const p = m.createPane(name); p.style.zIndex = z; if (!events) p.style.pointerEvents = 'none'; } };
      pane(LAP_PANE, LAP_Z, false);
      pane(SPOT_PANE, SPOT_Z, true);
      m.on('click', onMapClick);
    },
    detach() {
      if (map) { map.off('click', onMapClick); map.getContainer().classList.remove('lic-arming'); }
      clearLayers();
      lapRenderer = null;
      arming = false;
      map = null;
    },
    html,
    draw,
    live() { return P.laps || !!spot; },
    // The panel's Clear, and Reset's half: the shading and the spot off.
    clear(opts) {
      P.laps = false;
      spot = null;
      arming = false;
      if (map) map.getContainer().classList.remove('lic-arming');
      save();
      if (!(opts && opts.quiet)) repaint();
    },
    // A setting of the licences tool changed: the overlaps are read again.
    stale() { laps = null; },
    set(key, value) {
      if (key === 'laps') P.laps = !!value;
      else if (key === 'which') { P.which = WHICH.some(w => w[0] === value) ? value : 'other'; laps = null; }
      else if (key === 'chan') P.chan = value === 'any' || !Number.isFinite(Number(value)) ? 'any' : String(value);
      else return;
      save();
      const go = () => repaint();
      if (!C() && typeof MapAcma !== 'undefined') MapAcma.load().then(go, go);
      else go();
    },
    armSpot() {
      if (!map) return;
      arming = !arming;
      map.getContainer().classList.toggle('lic-arming', arming);
      if (arming && typeof mapNote === 'function') mapNote('Press the map where a station might go.', 5000);
      if (typeof MapAcma !== 'undefined' && MapAcma.repaint) MapAcma.repaint();
    },
    spotAt(lat, lon) {
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
      spot = { lat: Number(lat), lon: Number(lon) };
      const go = () => {
        repaint();
        if (typeof mapNote === 'function') { const r = spotAt(spot.lat, spot.lon); if (r) mapNote(spotText(r), 7000); }
      };
      if (!C() && typeof MapAcma !== 'undefined') MapAcma.load().then(go, go);
      else go();
      return spot;
    },
    clearSpot() { spot = null; repaint(); },
    showLap(i) {
      const o = overlaps()[i];
      if (!o || !map) return;
      map.fitBounds(L.latLngBounds(lensOf(o)).pad(0.6), { maxZoom: 12 });
      if (typeof mapNote === 'function') mapNote(`${o.a.l.no} and ${o.b.l.no} both on ${C().mhz(o.f)} MHz, ${fmtKm(o.d)} apart.`, 6000);
    },
    // For the checks.
    which: () => P.which,
    overlaps() {
      return overlaps().map(o => ({ ah: o.a.l.holder ? o.a.l.holder.no : '', bh: o.b.l.holder ? o.b.l.holder.no : '', a: o.a.l.no, b: o.b.l.no, aSite: o.a.site.id, bSite: o.b.site.id, f: o.f, d: o.d, depth: o.depth, same: o.same }));
    },
    spot() {
      if (!spot) return null;
      const r = spotAt(spot.lat, spot.lon);
      return r ? { lat: r.lat, lon: r.lon, band: r.band, site: r.site.map(m => m.l.no), inside: r.inside.map(m => ({ no: m.l.no, km: m.km, R: m.R, low: m.low })),
        nearest: r.nearest ? { no: r.nearest.l.no, gap: r.nearest.gap } : null, crowd: r.crowd, text: spotText(r) } : null;
    },
    drawn() {
      const n = g => { let c = 0; if (g) g.eachLayer(() => { c++; }); return c; };
      return { laps: n(lapLayer), spot: n(spotLayer) };
    },
    WORDS,
  };
})();
if (typeof window !== 'undefined') window.MapAcmaCheck = MapAcmaCheck;
