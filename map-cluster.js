// MegaNet — map-cluster.js
//
//   MapCluster   nearby station pins on the Stations map drawn as one bubble
//                with how many there are, until the map is zoomed in far
//                enough to tell them apart — under any colouring of the pins:
//                their roles, Colour pins by health, or ⏱️ Latency.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reached from app.js (initMap attaches it, stopStationsMap detaches it,
// refreshMapLayers rebuilds it once the pins are drawn, the selection and a
// repeater's focus ask it again, Map display draws its switch and the legend
// its row), from map-symbols.js (a pin it has put in a bubble is neither drawn
// nor hit) and from map-latency.js (a message from a station in a bubble
// flashes the bubble). All of it from inside functions, and the IIFE body only
// declares, so this file's position among the modules is free; Leaflet is
// reached the same way (npm run toplevel).
//
// ── Why ──────────────────────────────────────────────────────────────────────
// Asked for in these words: "cluster the pins … across all modes … allow the
// user to turn it off". The whole network at once is ~4,900 pins on a map a
// few hundred pixels across, most of them on top of each other, and what reads
// at that distance is how many there are and how they are doing, not each one.
//
// ── What stays its own pin ───────────────────────────────────────────────────
// Every pin is still on the map — every module that restyles, labels, leads to
// or hit-tests a pin keeps finding it — and a pin in a bubble is only not drawn
// and not clickable (map-symbols.js, _mnClustered). So nothing that points at
// one pin is ever pointing into a bubble:
//
//   the selected station       its card's gold line ends on it (map-leader.js)
//   the map selection          picked by hand, ringed in violet
//   a filter's matches         and the stations a pass range pulled in: they
//                              are what the filter was asked for
//   a focused repeater's       the stations it serves, the ones left lit
//   stations
//
// ── How they are grouped ─────────────────────────────────────────────────────
// Once per zoom, on the zoom's own screen pixels (map.project): each pin, in
// the register's order, joins the nearest bubble begun within MERGE_PX of it or
// begins one, and a bubble of one is just its pin. A grid of MERGE_PX cells
// keeps that one pass over the pins. Panning moves nothing — the grouping is
// in the zoom's pixels, not the screen's — so only a zoom, a rebuild of the
// pins, or a change to what stays its own pin asks again. From MAX_ZOOM + 1
// every pin is its own: a station is a few hundred metres from its neighbours
// there, and the ones on one site fan out as they always did (map-spider.js).
//
// A bubble is drawn at its stations' middle, which can be off its seed by up
// to MERGE_PX, so two of them could come to lie over each other — one count
// hiding the other — or over a pin left on its own, which then could be
// neither seen nor pressed. So, settled last: any two whose discs, out to the
// pale edge, come nearer than GAP_PX are one bubble, and again, until none do.
//
// ── What a bubble says ───────────────────────────────────────────────────────
// Its count, and its colour by the colouring the pins wear (Bubble colour):
//
//   Worst      the worst of its stations — health's fault before watch before
//              OK; ⏱️ Latency's slowest, quietest or weakest band
//   Average    ⏱️ Latency's band for the stations' mean figure; health's class
//              most of them are in (classes have no mean)
//   Mix        a ring split by how many wear each colour
//
// With the pins in their role colours a bubble is always a mix: roles are
// kinds, not a scale. Hovering one says what is in it; pressing it zooms to
// its stations. A message from a station in a bubble flashes the bubble, and
// its pulse does not run along the links inside it (map-latency.js). Its glow
// stays behind the other bubbles: they are in front of the pulse canvas's
// glows, flares and pulses (discs, overBubbles), as they are of the pins.

const MapCluster = (function () {
  const LS_ON = 'mn-map-cluster';
  const LS_HOW = 'mn-map-cluster-colour';
  const HOWS = ['worst', 'average', 'mix'];
  const MERGE_PX = 56;        // pins nearer than this on the screen share a bubble
  const MAX_ZOOM = 11;        // zoomed in past this, every station has its own pin
  const RING_W = 4.5;         // a mix's ring, in px
  const EDGE_PX = 2.5;        // a bubble's pale edge, past its radius
  const GAP_PX = 2;           // the least room between a bubble and the next, or a pin
  const WHITE = '#ffffff';

  // The words Map display and the legend use, on hover where they are used
  // and in the panel's own note (core.js's rule: hover never reaches a finger).
  const WORDS = {
    'Group nearby pins': `Zoomed out, stations closer together than about ${MERGE_PX} pixels on the screen are drawn as one `
      + `bubble saying how many there are, and bubbles that would overlap become one. Zoom in, or press a bubble, and they come apart; from zoom ${MAX_ZOOM + 1} every `
      + 'station has its own pin. The selected station, the map selection, a filter\'s matches and the stations a focused '
      + 'repeater serves always keep their own pins.',
    'Bubble colour': 'How a bubble is coloured while the pins are coloured by health or by ⏱️ Latency. With the pins in their '
      + 'role colours every bubble is a mix: a role is a kind, not better or worse.',
    Worst: 'The colour of the worst station in the bubble: under Colour pins by health a fault before a watch before OK; '
      + 'under ⏱️ Latency the slowest, quietest or weakest band any of them is in. One station in trouble shows from across the map.',
    Average: 'Under ⏱️ Latency, the band the stations\' average falls in — their mean age, delay, share of checks missed or SNR '
      + '(Protocol, which has no average, takes the most common). Under Colour pins by health, the class most of them are in.',
    Mix: 'A ring round the count, split by how many of the bubble\'s stations wear each colour — their roles, their health or '
      + 'their latency band, whichever the pins are coloured by.',
  };
  const HOW_LABEL = { worst: 'Worst', average: 'Average', mix: 'Mix' };

  const stored = (k, ok, dflt) => {
    try { const v = localStorage.getItem(k); return ok.includes(v) ? v : dflt; } catch (_) { return dflt; }
  };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private browsing — this session only */ } };

  // On unless this device has said otherwise — and, like the offline copy
  // (pwa.js), off under test automation (navigator.webdriver) unless said:
  // the checks written against one pin each at the network-wide view go on
  // finding their pins, and test/clusters.mjs says 'on', or stands in for a
  // browser nobody is driving.
  const automated = typeof navigator !== 'undefined' && !!navigator.webdriver;
  const S = {
    on: stored(LS_ON, ['on', 'off'], automated ? 'off' : 'on') === 'on',
    how: stored(LS_HOW, HOWS, 'worst'),
    map: null,
    bubbles: [],          // the bubble layers on the map now
    byId: new Map(),      // station id → its bubble, for the pins in one
    over: new Set(),      // the ids of the pins kept over the bubbles
    clustered: new Set(), // the markers in a bubble now
    drawn: null,          // the pins last handed to the fan-out and the stack
    hadBubbles: false,
    soon: false,
  };
  let Bubble = null;

  // ── The bubble ────────────────────────────────────────────────────────────

  // Black or white, whichever reads on a fill.
  function inkOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return '#1f2933';
    const n = parseInt(m[1], 16);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const Lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return Lum > 0.36 ? '#1f2933' : WHITE;
  }

  const radiusFor = n => Math.round(10 + 4 * Math.log10(Math.max(2, n)));
  const countText = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));

  function bubbleClass() {
    if (Bubble) return Bubble;
    L.Canvas.include({
      _updateMnCluster(layer) {
        if (!this._drawing || layer._empty()) return;
        const p = layer._point, ctx = this._ctx, o = layer.options;
        const r = Math.max(layer._radius, 4);
        ctx.save();
        if (ctx.setLineDash) ctx.setLineDash([]);
        ctx.globalAlpha = o.mnDim ? 0.5 : 1;
        // A pale edge first, so a bubble reads over the lines and the tiles.
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + EDGE_PX, 0, Math.PI * 2, false);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fill();
        let ink;
        if (o.mnParts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2, false);
          ctx.fillStyle = WHITE;
          ctx.fill();
          const total = o.mnParts.reduce((a, q) => a + q.n, 0) || 1;
          let a = -Math.PI / 2;
          ctx.lineWidth = RING_W;
          ctx.lineCap = 'butt';
          for (const q of o.mnParts) {
            const b = a + (Math.PI * 2 * q.n) / total;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r - RING_W / 2, a, b, false);
            ctx.strokeStyle = q.colour;
            ctx.stroke();
            a = b;
          }
          ink = '#1f2933';
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2, false);
          ctx.fillStyle = o.mnFill || WHITE;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = o.mnRing || WHITE;
          ctx.stroke();
          ink = inkOn(o.mnFill);
        }
        ctx.fillStyle = ink;
        ctx.font = `700 ${r >= 18 ? 12 : 11}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(countText(o.mnCount), p.x, p.y + 0.5);
        ctx.restore();
      },
    });
    Bubble = L.CircleMarker.extend({
      _updatePath() {
        if (this._renderer._updateMnCluster) this._renderer._updateMnCluster(this);
        else this._renderer._updateCircle(this);
      },
    });
    return Bubble;
  }

  // ── How a bubble is coloured ──────────────────────────────────────────────

  // The colour a member pin shows: its fill, or — a hollow pin, white — its ring.
  function pinColour(m) {
    const o = m.options || {};
    const f = String(o.fillColor || '').toLowerCase();
    return f && f !== WHITE && f !== '#fff' ? o.fillColor : (o.color || '#4f6478');
  }

  function roleWord(m) {
    const sym = m.mnSymbol || {};
    if (sym.manual) return 'read by hand';
    if (sym.tm) return 'TM stations';
    const s = m.mnStation;
    const role = s && typeof primaryRole === 'function' ? primaryRole(s) : 'field';
    return (typeof ROLE_LABEL !== 'undefined' && ROLE_LABEL[role]) || role;
  }

  // What the pins are coloured by now, in one word.
  function colouring() {
    if (typeof MapLatency !== 'undefined' && MapLatency.on && MapLatency.on()) return 'latency';
    if (state.mapHealth && typeof HealthGlance !== 'undefined' && HealthGlance.clusterStyle) return 'health';
    return 'role';
  }

  // { fill, ring } or { parts }, and `parts` for the words either way:
  // [{ label, colour, n }], in the colouring's own order.
  function styleOf(members) {
    const how = S.how;
    const by = colouring();
    let st = null;
    if (by === 'latency') st = MapLatency.clusterStyle(members.map(m => m.mnStation), how);
    else if (by === 'health') st = HealthGlance.clusterStyle(members.map(m => m.mnStationId), how);
    if (!st) {
      // Roles: kinds, so a mix whatever is chosen.
      const parts = new Map();
      for (const m of members) {
        const k = roleWord(m) + '|' + pinColour(m);
        const q = parts.get(k);
        if (q) q.n++;
        else parts.set(k, { label: roleWord(m), colour: pinColour(m), n: 1 });
      }
      const list = [...parts.values()].sort((a, b) => b.n - a.n);
      return { parts: list, words: list, by };
    }
    const words = st.parts;
    if (how === 'mix' || !st.fill) {
      return { parts: words.filter(q => q.n).map(q => ({ ...q, colour: q.fill && q.fill.toLowerCase() !== WHITE ? q.fill : (q.ring || '#4f6478') })), words, by };
    }
    return { fill: st.fill, ring: st.ring || WHITE, words, by, picked: st.label };
  }

  function tipHtml(c) {
    const n = c.members.length;
    const lines = c.words.map(q => `${q.n.toLocaleString()} ${esc(q.label)}`);
    const how = c.by === 'role' ? '' : c.parts ? ' · coloured as a mix'
      : ` · coloured by its ${S.how === 'worst' ? 'worst' : 'average'}${c.picked ? `: ${esc(c.picked)}` : ''}`;
    return `<strong>${n.toLocaleString()} stations</strong>${how}<br><span class="small">${lines.join(' · ')}</span>`
      + '<br><span class="small txt-muted">Press to zoom in to them</span>';
  }

  // ── Grouping ──────────────────────────────────────────────────────────────

  function keepsOwnPin(m) {
    const id = m.mnStationId;
    if (id == null) return true;
    if (state.selectedId != null && id === state.selectedId) return true;
    if (state.stnCard && state.stnCard.id != null && id === state.stnCard.id) return true;
    if (state.mapSelection && state.mapSelection.has(id)) return true;
    if (m.mnHit) return true;
    if (m.mnFocusServed) return true;
    return false;
  }

  function active() {
    return !!(S.on && S.map && state.map === S.map && state.activeTab === 'stations'
      && S.map.getZoom() <= MAX_ZOOM);
  }

  function clearBubbles() {
    for (const b of S.bubbles) b.remove();
    S.bubbles = [];
    S.byId = new Map();
    S.over = new Set();
  }

  // How far out a group is drawn: a bubble to its pale edge, a pin to its ring.
  const reachOf = g => (g.members.length > 1 ? radiusFor(g.members.length) + EDGE_PX
    : (g.members[0].options.radius || 6) + 1);

  // The groups again with every two that would touch made one (see the
  // header), on the same zoom pixels. A grid of cells as wide as the furthest
  // two can be apart and still touch keeps each pass to the near ones; a pass
  // that made one moved its middle, so another follows until one makes none.
  function settle(groups, most) {
    const cell = 2 * (radiusFor(most) + EDGE_PX) + GAP_PX;
    const at = g => `${Math.floor(g.cx / cell)},${Math.floor(g.cy / cell)}`;
    const middle = g => { g.cx = g.sx / g.members.length; g.cy = g.sy / g.members.length; };
    for (let pass = 0; pass < 64; pass++) {
      const grid = new Map();
      for (const g of groups) {
        middle(g);
        const k = at(g);
        const list = grid.get(k);
        if (list) list.push(g); else grid.set(k, [g]);
      }
      let merged = false;
      for (const a of groups) {
        if (a.gone || a.members.length < 2) continue;
        const cx = Math.floor(a.cx / cell), cy = Math.floor(a.cy / cell);
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const list = grid.get(`${cx + i},${cy + j}`);
            if (!list) continue;
            for (const b of list) {
              if (b === a || b.gone) continue;
              const need = reachOf(a) + reachOf(b) + GAP_PX;
              const dx = b.cx - a.cx, dy = b.cy - a.cy;
              if (dx * dx + dy * dy >= need * need) continue;
              for (const m of b.members) a.members.push(m);
              a.sx += b.sx; a.sy += b.sy;
              b.gone = true;
              middle(a);
              merged = true;
            }
          }
        }
      }
      if (!merged) break;
      groups = groups.filter(g => !g.gone);
    }
    return groups;
  }

  // Group the pins for this zoom, draw the bubbles, and tell the pins which
  // of them are in one. `labels`: put the names right after (a rebuild of
  // the pins names them itself, once, afterwards).
  function rebuild({ labels = false } = {}) {
    S.soon = false;
    const map = S.map;
    clearBubbles();
    const markers = (state.mapMarkers || []).filter(m => m._map);
    const now = new Set();
    if (active()) {
      const z = map.getZoom();
      const seeds = new Map();
      let groups = [];
      const kept = [];
      for (const m of markers) {
        if (keepsOwnPin(m)) { kept.push(m); continue; }
        const ll = m.getLatLng();
        if (m._mnProjZ !== z || m._mnProjLL !== ll) {
          m._mnProj = map.project(ll, z);
          m._mnProjZ = z;
          m._mnProjLL = ll;
        }
        const p = m._mnProj;
        const cx = Math.floor(p.x / MERGE_PX), cy = Math.floor(p.y / MERGE_PX);
        let best = null, bd = MERGE_PX * MERGE_PX;
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const list = seeds.get(`${cx + i},${cy + j}`);
            if (!list) continue;
            for (const g of list) {
              const dx = g.x - p.x, dy = g.y - p.y, d = dx * dx + dy * dy;
              if (d <= bd) { bd = d; best = g; }
            }
          }
        }
        if (best) {
          best.members.push(m);
          best.sx += p.x; best.sy += p.y;
        } else {
          const g = { x: p.x, y: p.y, sx: p.x, sy: p.y, members: [m] };
          groups.push(g);
          const k = `${cx},${cy}`;
          const list = seeds.get(k);
          if (list) list.push(g); else seeds.set(k, [g]);
        }
      }
      groups = settle(groups, markers.length);
      const Cls = bubbleClass();
      for (const g of groups) {
        if (g.members.length < 2) continue;
        const n = g.members.length;
        const at = map.unproject(L.point(g.sx / n, g.sy / n), z);
        const st = styleOf(g.members);
        const dim = g.members.every(m => m.mnFilterDim || m.mnFocusDimmed);
        const radius = radiusFor(n);
        const c = { members: g.members, at, radius, words: st.words, by: st.by, parts: st.parts || null, picked: st.picked || '' };
        const b = new Cls(at, {
          radius, stroke: true, fill: true, weight: 0, opacity: 0, fillOpacity: 0,
          mnCount: n, mnParts: st.parts || null, mnFill: st.fill || null, mnRing: st.ring || null, mnDim: dim,
          bubblingMouseEvents: false, className: 'mn-cluster',
        }).addTo(map);
        b.mnCluster = c;
        b.on('click', () => zoomInto(c));
        // What is in it, bound the first time the pointer comes to it and
        // Leaflet's own after that: hundreds of bubbles are drawn on every zoom.
        const wantTip = () => {
          b.off('mouseover', wantTip);
          if (b.getTooltip() || !b._map) return;
          b.bindTooltip(() => tipHtml(c), { direction: 'top', offset: [0, -radius], className: 'mn-cluster-tip' });
          b.openTooltip();
        };
        b.on('mouseover', wantTip);
        S.bubbles.push(b);
        for (const m of g.members) { now.add(m); S.byId.set(m.mnStationId, b); }
      }
      // The pins that keep their own are drawn over the bubbles: a bubble of
      // a station's neighbours is often centred near it, and the card's gold
      // line ending on a bubble is a line ending on the wrong thing.
      if (S.bubbles.length) {
        for (const m of kept) {
          if (!m._map || !m.bringToFront) continue;
          m.bringToFront();
          if (m.mnStationId != null) S.over.add(m.mnStationId);
        }
      }
    }
    // The pins that went into a bubble or came out of one are drawn again:
    // the canvas once, whole, rather than each of thousands of pins asking
    // for its own patch of it (which re-projects every one of them).
    const moved = [];
    for (const m of markers) {
      const was = !!m._mnClustered, is = now.has(m);
      if (was === is) continue;
      m._mnClustered = is;
      moved.push(m);
    }
    if (moved.length && !redrawWhole(moved[0]._renderer)) moved.forEach(m => { if (m._map) m.redraw(); });
    for (const m of S.clustered) if (!now.has(m)) m._mnClustered = false;
    S.clustered = now;
    // Handed on only when they changed: handing the fan-out its pins folds a
    // fan that is open — the card's station picked out of one, say — and the
    // stack lays every pin out again.
    const drawn = markers.filter(m => !m._mnClustered);
    const same = !!S.drawn && S.drawn.length === drawn.length && drawn.every((m, i) => m === S.drawn[i]);
    if (!same && typeof MapSpider !== 'undefined') MapSpider.setPins('stations', drawn);
    // The bubbles are new layers each time there are any.
    if ((!same || S.bubbles.length || S.hadBubbles) && typeof MapStack !== 'undefined') {
      MapStack.setPins('stations', drawn.concat(S.bubbles));
    }
    S.drawn = drawn;
    S.hadBubbles = S.bubbles.length > 0;
    if (labels && typeof applyMapLabels === 'function') applyMapLabels();
    paintNote();
  }

  // The pins' canvas drawn again, all of it, on its next frame. Leaflet's own
  // way is a patch round each layer asking; with the patch the whole canvas,
  // whatever else asks in the meantime draws inside it. False where the
  // renderer is not the canvas this expects, and each pin asks for itself.
  function redrawWhole(r) {
    if (!r || !r._map || !r._bounds || typeof r._redraw !== 'function') return false;
    r._redrawBounds = r._redrawBounds || new L.Bounds();
    r._redrawBounds.extend(r._bounds.min);
    r._redrawBounds.extend(r._bounds.max);
    r._redrawRequest = r._redrawRequest || L.Util.requestAnimFrame(r._redraw, r);
    return true;
  }

  // Once, a turn later, however many things asked in this one: the selection,
  // the focus, a box.
  function soon() {
    if (S.soon) return;
    S.soon = true;
    Promise.resolve().then(() => { if (S.soon) rebuild({ labels: true }); });
  }

  // A bubble pressed: the map goes to its stations, in far enough to part them.
  function zoomInto(c) {
    const map = S.map;
    if (!map) return;
    const b = L.latLngBounds(c.members.map(m => m.getLatLng()));
    const z = map.getZoom();
    const fit = map.getBoundsZoom(b.pad(0.15), false, L.point(48, 48));
    const to = Math.min(Math.max(fit, z + 1), MAX_ZOOM + 1, map.getMaxZoom());
    map.setView(b.getCenter(), to);
  }

  function onZoom() { rebuild(); }

  // ── Attaching ─────────────────────────────────────────────────────────────

  function attach(map) {
    S.map = map;
    S.bubbles = [];
    S.byId = new Map();
    S.clustered = new Set();
    S.drawn = null;
    S.hadBubbles = false;
    map.on('zoomend', onZoom);
  }

  function detach() {
    if (S.map) S.map.off('zoomend', onZoom);
    clearBubbles();
    S.clustered = new Set();
    S.drawn = null;
    S.hadBubbles = false;
    S.map = null;
  }

  // ── The switch and the colour ─────────────────────────────────────────────

  function setOn(on) {
    S.on = !!on;
    keep(LS_ON, S.on ? 'on' : 'off');
    rebuild({ labels: true });
    paintNote();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    announce(S.on ? 'Nearby pins are grouped into bubbles until the map is zoomed in.' : 'Every station has its own pin again.');
  }

  function setHow(how) {
    if (!HOWS.includes(how)) return;
    S.how = how;
    keep(LS_HOW, how);
    rebuild();
    announce(`Bubbles coloured by ${HOW_LABEL[how].toLowerCase()}.`);
  }

  function noteHtml() {
    if (!S.on) return 'Every station has its own pin.';
    const n = S.bubbles.length, k = S.clustered.size;
    if (S.map && S.map.getZoom() > MAX_ZOOM) return `Zoomed in past ${MAX_ZOOM}: every station has its own pin.`;
    return n ? `<strong>${k.toLocaleString()}</strong> stations in <strong>${n.toLocaleString()}</strong> bubbles at this zoom.`
      : 'No stations near enough to group at this zoom.';
  }
  function paintNote() {
    const el = document.getElementById('map-cluster-note');
    if (el) el.innerHTML = noteHtml();
  }

  // Under Map display's Station pins.
  function sectionHtml() {
    return `
    <label class="filter-check" title="${escAttr(WORDS['Group nearby pins'])}">
      <input type="checkbox" id="map-cluster-on" ${S.on ? 'checked' : ''} onchange="MapCluster.setOn(this.checked)">
      Group nearby pins into bubbles
    </label>
    <label class="filter-field filter-field--spaced mapd-join">
      <span>${termHtml('Bubble colour', WORDS['Bubble colour'])}</span>
      <select id="map-cluster-how" onchange="MapCluster.setHow(this.value)">
        ${HOWS.map(h => `<option value="${h}" ${S.how === h ? 'selected' : ''} title="${escAttr(WORDS[HOW_LABEL[h]])}">${HOW_LABEL[h]}</option>`).join('')}
      </select>
    </label>
    <p class="filter-note" id="map-cluster-note">${noteHtml()}</p>
    <details class="lat-words small">
      <summary>What the bubbles' words mean</summary>
      <dl>${Object.entries(WORDS).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </details>`;
  }

  // The legend's row, while there are bubbles.
  function legendHtml() {
    if (!S.on) return '';
    return `
    <span class="legend-item">
      <span class="legend-cluster" aria-hidden="true">12</span>
      <span class="small">${termHtml('Nearby stations', WORDS['Group nearby pins'])}, grouped — how many; press to zoom in.
        Coloured by their ${termHtml(HOW_LABEL[S.how].toLowerCase(), WORDS[HOW_LABEL[S.how]])} under health or ⏱️ Latency</span>
    </span>`;
  }

  // For the map's name (app.js updateMapAltName).
  function altText() {
    if (!S.on || !S.bubbles.length) return '';
    return `${S.clustered.size.toLocaleString()} of them grouped into ${S.bubbles.length.toLocaleString()} bubbles of nearby stations`;
  }

  // Where a message from this station is to flash (map-latency.js): its
  // bubble's place and size, and `key` to know it among discs(), or null for
  // a station with its own pin.
  function bubbleOf(id) {
    const b = S.byId.get(id);
    return b && b._map ? { latlng: b.getLatLng(), radius: b.options.radius, key: L.stamp(b) } : null;
  }

  // What the pulse canvas is to keep its glows behind (map-latency.js): every
  // bubble on the map, its disc out to the pale edge. A bubble is in front of
  // the others' glows, the pins under it and the links, and a pin kept over
  // the bubbles (overBubbles) in front of them all.
  function discs() {
    return S.bubbles.filter(b => b._map).map(b => ({ latlng: b.getLatLng(), r: b.options.radius + EDGE_PX, key: L.stamp(b) }));
  }
  const overBubbles = id => S.over.has(id);

  return {
    attach, detach, rebuild, soon, setOn, setHow, sectionHtml, legendHtml, altText, bubbleOf, discs, overBubbles, noteHtml, paintNote,
    on: () => S.on, how: () => S.how, active,
    // what is drawn, for test/clusters.mjs
    _state: () => ({
      on: S.on, how: S.how, bubbles: S.bubbles.map(b => ({
        n: b.options.mnCount, fill: b.options.mnFill, parts: b.options.mnParts, dim: b.options.mnDim,
        at: b.getLatLng(), ids: b.mnCluster.members.map(m => m.mnStationId),
      })), clustered: S.clustered.size,
    }),
    WORDS, MERGE_PX, MAX_ZOOM, EDGE_PX, GAP_PX,
  };
})();

if (typeof window !== 'undefined') window.MapCluster = MapCluster;
