// MegaNet — map-tip-stack.js
//
//   MapTipStack   the names on a map stand one above another when they would
//                 land on each other, instead of one over the other: the hover
//                 names in one column, the pins' own names in another.
//
// After Leaflet, before init.js — index.html holds the order and the reasons.
// Reads nothing of the app's; nothing runs at load — init.js starts it.
//
// ── Why ──────────────────────────────────────────────────────────────────────
//
// Each layer on the Stations map that names what is under the pointer does it
// with a Leaflet tooltip of its own, opened above the point: the road reserve
// (map-roads.js), the rivers (map-rivers.js, map-river-lines.js), a bridge
// (map-road-owners.js), a survey mark (map-survey.js), a radio path's sticky
// label. None of them knows about the others, and the pointer is often on more
// than one thing at once — a bridge is on a road over a river. Every one of
// them lands a few pixels above the same point, and the last one opened covers
// the rest: "Albion Street — Brassall · Ipswich City" laid over the bridge's
// name with "Bremer River" peeking out above it.
//
// The pins' own names had the same fault, the other way up. A station's name
// hangs below its pin (app.js applyMapLabels), and some 60 places in the
// register have two or three stations on one point — an AL and a TM at one
// site, a gauge and its overflow. Their names all hung from the same spot, the
// longest laid over the rest: "Macalister Bell Rd Jimbour Ck AL" over "Jimbour
// Ck AL", reported in these words: "two text fields stacked on top of each
// other … I thought we fixed this so that things go vertical instead of
// layered."
//
// ── What it does ─────────────────────────────────────────────────────────────
//
// Two kinds of name, each laid out among its own kind on each map:
//
//   hover names   every tooltip that is not permanent — the ones that come and
//                 go with the pointer. The lowest stays where its layer put it,
//                 and each one whose box meets a box already placed moves
//                 straight up until it sits GAP px clear above it.
//   pin names     the permanent tooltips that wear mn-pin-label: a station's
//                 name on the Stations map, and the same look on the message
//                 log's and the bit flipper's maps. They step the way they
//                 hang: a name below its pin keeps the highest in place and
//                 moves the others straight down under it; a name above its
//                 pin (a repeater's, on the message log) moves straight up. A
//                 name that would have to go more than MAX_SHIFT px from its
//                 pin stays where it was, overlapping — a name that far down
//                 reads as some other pin's.
//
// Only along the way a name hangs, and only as far as it has to: a name that
// meets nothing stays on its point, and each keeps its own left-right place,
// so a bridge's name is still over the bridge and the road's is still over the
// pointer, and two names on one pin are a column under it. When one goes, the
// rest settle back.
//
// The two kinds are not stepped round each other, and the other permanent
// names — a river's along its line, a drawn shape's — are left alone
// entirely. A hover name is what the pointer is asking about now, and it
// sitting over a pin's name is the right way round; stepping round every pin
// name in a dense town would send the hover name off across the map. And a
// pin's own hover name only shows on a pin with no name on the map.
//
// The pins under the names are map-stack.js's, which stands a camera on a
// bridge on a gauge in a column. A bridge's or a mark's name follows its pin
// there through the tooltip's offset, which Leaflet folds into the place this
// file starts from, so the two compose. Station pins never move there; a
// hovered pile of them fans out (map-spider.js), each pin taking its name with
// it through Leaflet's own move, so the names unstack as the pins come apart.
//
// A name that is on the map but not shown — the road, river, bridge and survey
// names stand aside while a pin's own hover name shows (styles.css,
// .mn-pin-hovering) — has no box and takes no room.
//
// ── How ──────────────────────────────────────────────────────────────────────
//
// Two methods on L.Tooltip's prototype, wrapped — the precedent is core.js's
// guard on L.Canvas._redraw, and Leaflet is pinned to 1.9.4 by index.html's
// integrity hash, so the private names it relies on cannot move under it.
//
//   _setPosition   every placement goes through it: opening, setLatLng and
//                  setContent (which both update), a sticky tooltip following
//                  the mouse, a bound tooltip following its marker, a zoom and
//                  its animation. After Leaflet has put the box at its own
//                  place, that place is kept on the tooltip and a layout of
//                  its kind on its map is asked for.
//   onRemove       a name going asks for one too, so the others come back.
//
// The layout runs in a microtask, so a frame in which several layers move
// their names is laid out after each, and always before the frame is painted —
// the names never show at their unstacked places. Each kind asks for its own,
// so a sticky label following the mouse does not measure every pin's name on
// every move. It moves a box with L.DomUtil.setPosition, as Leaflet does, so a
// zoom's animation carries the stacked place rather than snapping to it
// afterwards; the next placement by Leaflet starts again from the tooltip's
// own point.

const MapTipStack = (() => {
  const GAP = 3;          // px clear between two stacked names
  const MAX_SHIFT = 72;   // px — a pin's name goes no further than this from its pin,
                          // map-stack.js's MAX_LIFT for the pins themselves: four names
                          // deep under one pin, where the register has at most three
  let started = false;

  const PIN_NAME = /(^|\s)mn-pin-label(\s|$)/;
  const isPinName = t => PIN_NAME.test(t.options.className || '');

  function place(t, dy) {
    if (t._mnTipDy === dy) return;
    t._mnTipDy = dy;
    L.DomUtil.setPosition(t._container, dy ? t._mnTipAt.add(L.point(0, dy)) : t._mnTipAt);
  }

  // Each open name's box where its layer put it, in the map's layer pixels —
  // the margin Leaflet's stylesheet gives each direction included — in
  // opening order, so a name already showing is the one that stays put when
  // another arrives on the same foot (the sorts below are stable).
  function boxes(set, map) {
    const out = [];
    for (const t of set) {
      const el = t._container;
      if (t._map !== map || !el || !t._mnTipAt) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (!w || !h) { place(t, 0); continue; }
      const cs = getComputedStyle(el);
      out.push({ t, w, h, up: t.options.direction !== 'bottom' && t.options.direction !== 'center',
        x: t._mnTipAt.x + (parseFloat(cs.marginLeft) || 0),
        y: t._mnTipAt.y + (parseFloat(cs.marginTop) || 0) });
    }
    return out;
  }

  // Lay out `order` against each other: each box, in turn, starts where its
  // layer put it and steps the way it hangs past every box already placed
  // that it meets. Each step puts it wholly past the one it met, and it only
  // ever goes one way, so it meets each placed box at most once.
  function stack(order, limit) {
    const placed = [];
    for (const b of order) {
      let top = b.y;
      for (let moved = true; moved;) {
        moved = false;
        for (const p of placed) {
          if (b.x < p.x + p.w && p.x < b.x + b.w
              && top < p.top + p.h + GAP && p.top < top + b.h + GAP) {
            top = b.up ? p.top - GAP - b.h : p.top + p.h + GAP;
            moved = true;
          }
        }
      }
      if (Math.abs(top - b.y) > limit) top = b.y;
      placed.push({ x: b.x, w: b.w, h: b.h, top });
      place(b.t, top - b.y);
    }
  }

  const footFirst = (a, b) => (b.y + b.h) - (a.y + a.h);   // lowest first
  const headFirst = (a, b) => a.y - b.y;                   // highest first

  // Hover names all go up, the lowest first, as far as they need.
  function layoutHover(list) {
    stack(list.map(b => ({ ...b, up: true })).sort(footFirst), Infinity);
  }

  // A pin's name steps the way it hangs: the ones below their pins first,
  // highest first, then the ones above, lowest first.
  function layoutPinNames(list) {
    stack([...list.filter(b => !b.up).sort(headFirst), ...list.filter(b => b.up).sort(footFirst)], MAX_SHIFT);
  }

  // One kind of name: the ones open on each map, and a layout of them asked
  // for at most once a turn.
  function kind(layout) {
    const open = new WeakMap();   // map → Set of this kind's tooltips open on it, in opening order
    const due = new Set();        // maps whose layout is already asked for this turn
    const on = map => {
      let s = open.get(map);
      if (!s) { s = new Set(); open.set(map, s); }
      return s;
    };
    function ask(map) {
      if (!map || due.has(map)) return;
      due.add(map);
      queueMicrotask(() => {
        due.delete(map);
        const list = boxes(on(map), map);
        if (list.length < 2) { for (const b of list) place(b.t, 0); return; }
        layout(list);
      });
    }
    return {
      add(t)         { on(t._map).add(t); ask(t._map); },
      remove(t, map) { on(map).delete(t); ask(map); },
    };
  }

  const hover = kind(layoutHover);
  const pinNames = kind(layoutPinNames);
  const kindOf = t => t.options.permanent ? (isPinName(t) ? pinNames : null) : hover;

  function start() {
    if (started || typeof L === 'undefined' || !L.Tooltip) return;
    started = true;
    const proto = L.Tooltip.prototype;
    const setPosition = proto._setPosition, onRemove = proto.onRemove;
    proto._setPosition = function (pos) {
      setPosition.call(this, pos);
      const k = kindOf(this);
      if (!k) return;
      this._mnTipAt = L.DomUtil.getPosition(this._container);
      this._mnTipDy = 0;
      k.add(this);
    };
    proto.onRemove = function (map) {
      onRemove.call(this, map);
      const k = kindOf(this);
      if (k) k.remove(this, map);
    };
  }

  return { start };
})();
