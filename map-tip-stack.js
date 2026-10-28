// MegaNet — map-tip-stack.js
//
//   MapTipStack   the hover names on a map stand one above another when they
//                 would land on each other, instead of one over the other.
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
// ── What it does ─────────────────────────────────────────────────────────────
//
// Every tooltip that is not permanent — the ones that come and go with the
// pointer — is put where Leaflet puts it, and then, if two or more are open on
// one map, they are laid out together: the lowest stays where its layer put it,
// and each one whose box meets a box already placed moves straight up until it
// sits GAP px clear above it. Only up, and only as far as it has to: a name
// that collides with nothing stays on its point, and each keeps its own
// left-right place, so a bridge's name is still over the bridge and the road's
// is still over the pointer. When one goes, the rest settle back down.
//
// The permanent ones — a pin's name, a river's name along its line — are left
// where they are and are not stepped round. They are what the map says
// everywhere; a hover name is what the pointer is asking about now, and it
// sitting over them is the right way round. Stepping round every pin name in a
// dense town would send the hover name off across the map.
//
// The pins under the names are map-stack.js's, which stands a camera on a
// bridge on a gauge in a column. A bridge's or a mark's name follows its pin
// there through the tooltip's offset, which Leaflet folds into the place this
// file starts from, so the two compose.
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
//                  the mouse, a zoom and its animation. After Leaflet has put
//                  the box at its own place, that place is kept on the tooltip
//                  and a layout of its map is asked for.
//   onRemove       a name going asks for one too, so the others come back down.
//
// The layout runs in a microtask, so a frame in which several layers move
// their names is laid out after each, and always before the frame is painted —
// the names never show at their unstacked places. It moves a box with
// L.DomUtil.setPosition, as Leaflet does, so a zoom's animation carries the
// stacked place rather than snapping to it afterwards; the next placement by
// Leaflet starts again from the tooltip's own point.

const MapTipStack = (() => {
  const GAP = 3;              // px clear between two stacked names
  const open = new WeakMap(); // map → Set of the transient tooltips open on it, in opening order
  const due = new Set();      // maps whose layout is already asked for this turn
  let started = false;

  function tipsOn(map) {
    let s = open.get(map);
    if (!s) { s = new Set(); open.set(map, s); }
    return s;
  }

  function ask(map) {
    if (!map || due.has(map)) return;
    due.add(map);
    queueMicrotask(() => { due.delete(map); layout(map); });
  }

  function place(t, dy) {
    if (t._mnTipDy === dy) return;
    t._mnTipDy = dy;
    L.DomUtil.setPosition(t._container, dy ? t._mnTipAt.add(L.point(0, dy)) : t._mnTipAt);
  }

  // Each open name's box where its layer put it, in the map's layer pixels —
  // the margin Leaflet's stylesheet gives each direction included — lowest
  // first; two with the same foot keep their opening order, so a name already
  // showing is the one that stays put when another arrives.
  function boxes(map) {
    const out = [];
    for (const t of tipsOn(map)) {
      const el = t._container;
      if (t._map !== map || !el || !t._mnTipAt) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (!w || !h) { place(t, 0); continue; }
      const cs = getComputedStyle(el);
      out.push({ t, w, h,
        x: t._mnTipAt.x + (parseFloat(cs.marginLeft) || 0),
        y: t._mnTipAt.y + (parseFloat(cs.marginTop) || 0) });
    }
    return out.sort((a, b) => (b.y + b.h) - (a.y + a.h));
  }

  function layout(map) {
    const list = boxes(map);
    if (list.length < 2) { for (const b of list) place(b.t, 0); return; }
    const placed = [];
    for (const b of list) {
      let top = b.y;
      // Each move puts the box wholly above the one it met, and it only ever
      // goes up, so it meets each placed box at most once.
      for (let moved = true; moved;) {
        moved = false;
        for (const p of placed) {
          if (b.x < p.x + p.w && p.x < b.x + b.w
              && top < p.top + p.h + GAP && p.top < top + b.h + GAP) {
            top = p.top - GAP - b.h;
            moved = true;
          }
        }
      }
      placed.push({ x: b.x, w: b.w, h: b.h, top });
      place(b.t, top - b.y);
    }
  }

  function start() {
    if (started || typeof L === 'undefined' || !L.Tooltip) return;
    started = true;
    const proto = L.Tooltip.prototype;
    const setPosition = proto._setPosition, onRemove = proto.onRemove;
    proto._setPosition = function (pos) {
      setPosition.call(this, pos);
      if (this.options.permanent) return;
      this._mnTipAt = L.DomUtil.getPosition(this._container);
      this._mnTipDy = 0;
      tipsOn(this._map).add(this);
      ask(this._map);
    };
    proto.onRemove = function (map) {
      onRemove.call(this, map);
      if (this.options.permanent) return;
      tipsOn(map).delete(this);
      ask(map);
    };
  }

  return { start };
})();
