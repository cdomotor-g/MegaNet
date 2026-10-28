// MegaNet — map-stack.js
//
//   MapStack   pins of different layers that would land on one another,
//              stood one above the other instead: a column of pins, each on
//              a short leg down to its own point, rather than a pile.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reached from app.js (initMap and stopStationsMap, which attach and detach
// it; refreshMapLayers, which hands it the station pins) and from the layers
// that take part: map-photos.js, map-survey.js, map-road-owners.js and
// map-cameras.js, each handing over its pins when it draws them and asking
// how far a pin was moved when it hit-tests one. All of it from inside
// functions, and the IIFE body only declares, so this file's position among
// the modules is free.
//
// ── Why ──────────────────────────────────────────────────────────────────────
// Asked for in these words, over a camera tile sitting on a bridge pin at Joe
// Beach Bridge: "make the icons a bit more aware of each other … stack them
// nicely vertically rather than layer them". Every point layer on the Stations
// map draws in a pane of its own and knows nothing of the others, so a council
// camera at a crossing covers the bridge it watches, the bridge covers the
// gauge bolted to it and a benchmark beside the gauge goes under all three —
// and the bridge and the benchmark are hit-tested from the map's own pointer
// events (MapSurvey's convention), so the one on top is not even the one a
// click reaches.
//
// MapSpider is the other answer to pins on pins, for a different case: the
// network's own pins on one another, fanned out while the pointer is over
// them. This is every other layer's pins against the network's and against
// each other's, always, with nothing to hover — and pins of one layer are left
// to that layer, which already merges its own (a camera tile with a count, a
// photo badge with a total) or keeps them as the source has them.
//
// ── Who moves ────────────────────────────────────────────────────────────────
// LAYERS ranks them. A lower rank keeps its place and a higher rank stands
// over it, so the order is the panes' order, bottom to top: what is drawn
// higher is what moves, and a pin that has moved is never drawn under the
// one it stands on.
//
//   stations  never move: the network is what the map is for, and a pin
//             fanned or focused or led to by the card's gold line is where its
//             station is. Their rings are what everything else makes room for.
//   photos    never move either: a photo's dot is on its exact point and its
//             cones are drawn from there. Its badge already stands up off the
//             point, out of a station pin's way; that badge is room taken.
//   survey    a mark stands over a station pin or a photo badge.
//   bridges   over all of those — a gauge is very often on a bridge, and a
//             benchmark on its deck.
//   cameras   over everything: the tallest pin, and the one a council put on
//             a pole beside the crossing rather than in it.
//
// ── Where a pin goes ─────────────────────────────────────────────────────────
// Vertically, never sideways: a column reads as one place, where pins
// scattered round a point read as several. Each pin, in rank order, starts on
// its own point. If it overlaps nothing that has already been placed it stays.
// If its point is under another pin, it stands on that pin, centred over it,
// and climbs past whatever is already standing there — so three pins at one
// crossing are a tidy column, the lowest rank at the foot. If only its edge
// overlaps, it moves straight up or straight down from where it is, whichever
// clears in the shorter distance: a pin whose point is just below a station's
// steps down off its ring rather than leaping over it. A short dark leg joins
// it to what it stands for: a GAP-long tick onto the pin under it when its
// point is under that pin, or a leg all the way to its point, ending in a dot,
// when its point is clear. A pin that would have to go further than MAX_LIFT
// stays where it was, overlapping: a pin far from its point says the wrong
// place.
//
// The layout is in the map's pixel space at the current zoom, so a pan does
// not change it and a zoom does: it is worked out again on zoomend and every
// time a layer hands its pins over, which the cameras and the photos do after
// every settled pan. The order is by rank, then the data's own position, so
// the same view always stacks the same way.
//
// ── Moving a pin ─────────────────────────────────────────────────────────────
// The CSS `translate` property on the marker's own element: Leaflet positions
// a marker with `transform`, which `translate` composes with rather than
// replaces, so the pin keeps following the map through a drag and a zoom
// animation and Leaflet never has to be told. A pin that takes its own clicks
// (a camera) is clicked where it is drawn. A pin hit-tested from the map's
// pointer events (a bridge, a survey mark) asks shift() how far it was moved,
// and its hover label and callout are offset by the same.
const MapStack = (function () {
  const LAYERS = {
    stations: { rank: 0, fixed: true },
    photos:   { rank: 1, fixed: true },
    survey:   { rank: 2 },
    bridges:  { rank: 3 },
    cameras:  { rank: 4 },
  };
  const GAP      = 4;    // px between a pin and the one it stands on
  const SLACK    = 2;    // px of overlap not worth moving for: edges touching
  const MAX_LIFT = 72;   // px — never further than this above its own point
  const CELL     = 48;   // px — the overlap search's grid
  const CLIMBS   = 12;   // a column taller than this is past MAX_LIFT anyway

  const ZERO = Object.freeze({ x: 0, y: 0 });
  const sets = {};       // layer → [{ m, box }]
  let map = null;

  // A pin's box round its point, in px: [left, top, right, bottom]. A circle
  // marker's from its radius and stroke (MapSymbols' outline rides outside
  // the ring); a marker with an icon from the icon's size and anchor, which is
  // what Leaflet itself places it by.
  function boxOf(m) {
    const o = m.options || {};
    if (o.radius != null) {
      const r = o.radius + (o.weight || 0) / 2 + (o.mnOutline ? 3 : 0);
      return [-r, -r, r, r];
    }
    const io = (o.icon && o.icon.options) || {};
    const size = io.iconSize ? L.point(io.iconSize) : L.point(0, 0);
    const a = anchorOf(m);
    return [-a.x, -a.y, size.x - a.x, size.y - a.y];
  }

  function anchorOf(m) {
    const io = (m.options && m.options.icon && m.options.icon.options) || {};
    if (io.iconAnchor) return L.point(io.iconAnchor);
    return io.iconSize ? L.point(io.iconSize).divideBy(2) : L.point(0, 0);
  }

  // Where a pin belongs: its own point, or where MapSpider will put it back.
  function home(m) { return m._mnHome || m.getLatLng(); }

  const overlaps = (a, b) => a.x0 < b.x1 - SLACK && a.x1 > b.x0 + SLACK
                          && a.y0 < b.y1 - SLACK && a.y1 > b.y0 + SLACK;
  const inside = (r, p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  const moved = (r, dx, dy) => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy, layer: r.layer });

  function layout() {
    if (!map) return;
    const z = map.getZoom();
    const all = [];
    for (const layer of Object.keys(sets)) {
      const spec = LAYERS[layer];
      for (const p of sets[layer]) {
        const pt = map.project(home(p.m), z);
        all.push({ m: p.m, box: p.box, layer, rank: spec.rank, fixed: !!spec.fixed, pt });
      }
    }
    all.sort((a, b) => a.rank - b.rank || b.pt.y - a.pt.y || a.pt.x - b.pt.x);

    const grid = new Map(), homes = new Map();
    const cells = (r, fn) => {
      for (let i = Math.floor(r.x0 / CELL); i <= Math.floor(r.x1 / CELL); i++) {
        for (let j = Math.floor(r.y0 / CELL); j <= Math.floor(r.y1 / CELL); j++) fn(`${i},${j}`);
      }
    };
    const add = (g, box, item) => cells(box, k => { const c = g.get(k); if (c) c.push(item); else g.set(k, [item]); });
    // `at` is the box placed, `home` the box on the pin's own point: a pin
    // that has moved still stands for the place it came from.
    const put = (at, home) => { at.home = home; add(grid, at, at); add(homes, home, at); };
    // What a box at r would overlap, leaving out its own layer's pins.
    const hits = r => {
      const out = new Set();
      cells(r, k => { for (const o of grid.get(k) || []) if (o.layer !== r.layer && overlaps(r, o)) out.add(o); });
      return [...out];
    };

    // Up (dir -1) or down (dir 1) from dy until clear of everything but its
    // own layer: the dy it ends at, or null when that is past MAX_LIFT.
    const climb = (r, dx, dy, dir) => {
      let q = moved(r, dx, dy), left = hits(q);
      for (let n = 0; left.length && n < CLIMBS; n++) {
        dy += dir < 0 ? Math.min(...left.map(o => o.y0)) - GAP - q.y1
                      : Math.max(...left.map(o => o.y1)) + GAP - q.y0;
        q = moved(r, dx, dy);
        left = hits(q);
      }
      return left.length || Math.abs(dy) > MAX_LIFT ? null : Math.round(dy);
    };
    const centre = o => ({ x: (o.x0 + o.x1) / 2, y: (o.y0 + o.y1) / 2 });

    for (const p of all) {
      const r = { x0: p.pt.x + p.box[0], y0: p.pt.y + p.box[1], x1: p.pt.x + p.box[2], y1: p.pt.y + p.box[3], layer: p.layer };
      p.dx = 0; p.dy = 0; p.onto = false;
      const over = p.fixed ? [] : hits(r);
      if (!over.length) { put(r, r); continue; }
      // Its point under another pin, or where another pin stood before it
      // made room: stand on that one, centred over it, and climb past
      // whatever already stands there.
      const near = new Set();
      cells({ x0: p.pt.x, y0: p.pt.y, x1: p.pt.x, y1: p.pt.y }, k => {
        for (const o of homes.get(k) || []) if (o.layer !== p.layer && inside(o.home, p.pt)) near.add(o);
      });
      const base = [...near].sort((a, b) => Math.hypot(centre(a.home).x - p.pt.x, centre(a.home).y - p.pt.y)
                      - Math.hypot(centre(b.home).x - p.pt.x, centre(b.home).y - p.pt.y))[0];
      let dx = 0, dy = null;
      if (base) {
        dx = Math.round(centre(base).x - centre(r).x);
        dy = climb(r, dx, base.y0 - GAP - r.y1, -1);
      } else {
        // Only its edge over another pin: straight up or straight down from
        // where it is, whichever is the shorter way clear.
        const up = climb(r, 0, 0, -1), down = climb(r, 0, 0, 1);
        dy = up == null ? down : down == null ? up : (-up <= down ? up : down);
      }
      if (dy == null || (!dx && !dy)) { put(r, r); continue; }
      p.dx = dx; p.dy = dy; p.onto = !!base;
      put(moved(r, dx, dy), r);
    }
    for (const p of all) if (!p.fixed) paint(p);
  }

  // The move, and the leg back to what the pin stands for. The leg is the
  // icon element's own last child, so it moves with the pin, sits in its pane
  // and needs nothing redrawn on a pan; and last, so a layer that reads its
  // icon's first child still finds its own.
  function paint(p) {
    const el = p.m.getElement && p.m.getElement();
    if (!el) return;
    let leg = null;
    for (const c of el.children) if (c.classList.contains('mn-stack-leg')) leg = c;
    if (!p.dx && !p.dy) {
      el.style.translate = '';
      el.classList.remove('mn-stacked');
      if (leg) leg.remove();
      delete p.m.mnStack;
      return;
    }
    p.m.mnStack = { x: p.dx, y: p.dy };
    el.style.translate = `${p.dx}px ${p.dy}px`;
    el.classList.add('mn-stacked');
    if (!leg) {
      leg = document.createElement('span');
      leg.setAttribute('aria-hidden', 'true');
      el.appendChild(leg);
    }
    // In the icon element's own pixels, whose origin is the pin's anchor less
    // the anchor's offset. Onto a pin: a GAP-long tick from the pin's foot.
    // Clear of every pin: from the edge nearer its point down (or up) to the
    // point, where the dot is.
    const a = anchorOf(p.m);
    let x = a.x, top, len, cls = 'mn-stack-leg';
    if (p.onto) {
      x = a.x + (p.box[0] + p.box[2]) / 2;
      top = a.y + p.box[3];
      len = GAP;
    } else if (p.dy < 0) {
      top = a.y + p.box[3];
      len = -p.dy - p.box[3];
      cls += ' is-point';
    } else {
      top = a.y - p.dy;
      len = p.dy + p.box[1];
      cls += ' is-point is-above';
    }
    leg.className = cls;
    leg.style.left = `${x}px`;
    leg.style.top = `${top}px`;
    leg.style.height = `${Math.max(len, 0)}px`;
  }

  return {
    attach(m) {
      map = m;
      m.on('zoomend viewreset', layout);
    },

    detach() {
      if (map) map.off('zoomend viewreset', layout);
      map = null;
      for (const k of Object.keys(sets)) delete sets[k];
    },

    // A layer's pins, all of them, every time it draws: an empty list when it
    // clears. `box` (optional) gives a pin's box round its point when its
    // marker's own size does not say it — a zero-sized icon whose pin is
    // drawn by CSS, a badge standing off its point.
    setPins(layer, markers, box) {
      if (!LAYERS[layer]) return;
      if (!markers || !markers.length) delete sets[layer];
      else sets[layer] = markers.map(m => ({ m, box: (box && box(m)) || boxOf(m) }));
      layout();
    },

    // How far a pin was moved, in px: {x, y}, both 0 for a pin left where it was.
    shift(m) { return (m && m.mnStack) || ZERO; },
  };
})();
