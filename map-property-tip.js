// MegaNet — map-property-tip.js
//
//   MapPropTip   what land is under the pointer, while the Stations map draws
//                the property boundaries, the easements or the land tenure:
//                the lot and plan, its area, its tenure and who holds that
//                kind of land, the easements over the spot, the street address,
//                the locality and council — and, with the tenure tint on, what
//                the land is used for. A hover name beside the road reserve's,
//                the bridge's and the survey mark's, stacked with them
//                (map-tip-stack.js).
//
// After core.js, site-land.js and map-lots.js, before init.js — index.html
// holds the order. Reaches back to core.js for `state` and esc, across to
// site-land.js for the services, the fields and the words, to map-lots.js for
// what is drawn at this scale, and to map-views.js for which view is in force
// — all from inside its own functions, so this file's position among the
// modules is free (`npm run toplevel`).
//
// ── Why ──────────────────────────────────────────────────────────────────────
// Asked for in these words (8 Nov 2026): "give a tool tip in the property modes
// to show whats under the cursor. give them the kinds of info that property
// services would be interested in for the given mode they are in." The lots,
// easements and tenure are one picture from the State's map server
// (map-lots.js), so the map itself knows nothing about the land it shows: a
// lot is a line in an image. What is here (map-here.js) answers for a click;
// this answers for the pointer, as you move over the land.
//
// ── What it says, by what the map draws ──────────────────────────────────────
//   * Land tenure on (Land & tenure): the tenure first — Reserve, State Land,
//     Freehold — and who holds that kind of land, then the lot and its area,
//     what the land is used for (Queensland's land use map), and where.
//   * Otherwise (Property & easements, or the lot lines on in any view): the
//     lot on plan first, its area and tenure, the easements over the spot
//     (with Easements on: or "no easement here"), the street address, and
//     where — the locality and the council.
// A road reserve or a watercourse says so in place of a lot. Never who owns a
// lot: Queensland does not publish it (site-land.js says why), and Flood-Net
// holds no landholder's name.
//
// ── What it costs ────────────────────────────────────────────────────────────
// Nothing until the pointer rests (PAUSE_MS) on land this module has not read
// yet. Then one question about the point, answered with the lot's outline
// (simplified to about a pixel), so moving about inside the same lot asks
// nothing more; the easements in that lot's box come with a second question,
// once a lot and only while Easements is on; the address is asked once a lot;
// the land use once a land-use area, only while the tenure tint is on. An
// answer still out when the pointer moves on is abandoned; a failure is not
// asked again for FAIL_MS, and the tip says the State could not be read.
//
// ── Pointer conventions ──────────────────────────────────────────────────────
// Delegated from the map's own mousemove, as the road reserve's name is
// (map-roads.js): the picture takes no pointer. Mouse and pen only — a finger
// has What is here. Nothing while a draw tool, a link pick or What is here owns
// the pointer, while the map moves, or outside Queensland.
const MapPropTip = (function () {
  const PAUSE_MS = 280;       // the pointer rests this long before the State is asked
  const TIMEOUT_MS = 12000;
  const FAIL_MS = 30000;      // a failed question is not asked again for this long
  const KEEP = 60;            // lots and land-use areas kept, newest first
  const OFFSET_PX = 1.5;      // outlines simplified to about this many screen pixels

  let map = null, tip = null, moveRaf = null, timer = null, ctl = null;
  let failedAt = 0, asked = 0, lastLL = null, lastText = '';
  const lots = [];            // { box, rings, main, others, ease: null | [...] , easeAsked }
  const uses = [];            // { box, rings, f }
  const addrs = new Map();    // lotplan → { list } | 'asking' | 'failed'

  const P = () => (typeof SiteLand !== 'undefined' && SiteLand.parts) || null;

  // ── When it is on ──────────────────────────────────────────────────────────
  // What the property picture draws at this scale (map-lots.js): the tip
  // follows the lines on the map, never promising land the map is not showing.
  function drawn() {
    if (typeof MapLots === 'undefined' || typeof MapLots.drawnNow !== 'function') return null;
    const w = MapLots.drawnNow();
    return w && (w.lots || w.easements || w.tenure) ? w : null;
  }
  function busy() {
    if (typeof state === 'undefined') return true;
    if (state.map3d) return true;
    if (state.draw && state.draw.tool) return true;
    if (state.link && state.link.picking) return true;
    if (typeof MapHere !== 'undefined' && typeof MapHere.armed === 'function' && MapHere.armed()) return true;
    return false;
  }
  function inQld(ll) {
    const b = P() && P().QLD_BOX;
    return !!b && ll.lng >= b.w && ll.lng <= b.e && ll.lat >= b.s && ll.lat <= b.n;
  }

  // ── Outlines ───────────────────────────────────────────────────────────────
  // ArcGIS rings in lon/lat (outSR 4326); inside is an odd number of crossings
  // over every ring, which counts a hole as out.
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function boxOf(rings) {
    const b = { w: Infinity, e: -Infinity, s: Infinity, n: -Infinity };
    for (const r of rings) for (const [x, y] of r) {
      if (x < b.w) b.w = x; if (x > b.e) b.e = x; if (y < b.s) b.s = y; if (y > b.n) b.n = y;
    }
    return b;
  }
  function inside(item, ll) {
    const b = item.box;
    if (!b || ll.lng < b.w || ll.lng > b.e || ll.lat < b.s || ll.lat > b.n) return false;
    let hits = 0;
    for (const r of item.rings) if (inRing(ll.lng, ll.lat, r)) hits++;
    return hits % 2 === 1;
  }
  const keepNewest = (list, item) => { list.unshift(item); if (list.length > KEEP) list.length = KEEP; return item; };
  const lotAt = ll => lots.find(x => inside(x, ll)) || null;
  const useAt = ll => uses.find(x => inside(x, ll)) || null;

  // ── Asking ─────────────────────────────────────────────────────────────────
  function offsetDeg() {
    try {
      const c = map.getCenter(), z = map.getZoom();
      const mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, z);
      return (mpp * OFFSET_PX) / 111320;
    } catch (_) { return 0.00001; }
  }
  function url(path, params) {
    const p = new URLSearchParams(params);
    p.set('f', 'json');
    return `${P().HOST}/${path}/query?${p}`;
  }
  async function getJson(u, signal) {
    asked++;
    const own = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => own && own.abort(), TIMEOUT_MS);
    const stop = () => own && own.abort();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      const r = await fetch(u, own ? { signal: own.signal } : undefined);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j || j.error || !Array.isArray(j.features)) throw new Error('unreadable');
      return j.features;
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', stop);
    }
  }
  const ringsOf = f => (f && f.geometry && Array.isArray(f.geometry.rings) ? f.geometry.rings : []);

  // The lot under a point, with the parcels on the line beside it, as
  // site-land.js digests them — and each one's outline.
  async function askLot(ll, signal) {
    const parts = P();
    const feats = await getJson(url(`${parts.LPPF}/4`, {
      geometry: `${ll.lng},${ll.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: parts.PARCEL_FIELDS, returnGeometry: 'true',
      outSR: '4326', maxAllowableOffset: String(offsetDeg()), geometryPrecision: '6',
    }), signal);
    const rank = { lot: 0, road: 1, junction: 2, water: 3, route: 4 };
    const base = [];
    for (const f of feats) {
      const p = parts.parcelOf((f && f.attributes) || {});
      if (p.cover !== 'Base') continue;
      const rings = ringsOf(f);
      if (!rings.length) continue;
      base.push({ p, rings });
    }
    base.sort((x, y) => rank[x.p.kind] - rank[y.p.kind]);
    if (!base.length) return null;
    const m = base[0];
    return keepNewest(lots, { box: boxOf(m.rings), rings: m.rings, main: m.p, others: base.slice(1).map(o => o.p),
                              ease: null, easeAsked: false });
  }

  // The easements inside a lot's box: one question a lot, and then the spot
  // under the pointer is tested against their outlines here.
  async function askEasements(lot) {
    if (lot.easeAsked) return;
    lot.easeAsked = true;
    const parts = P(), b = lot.box;
    try {
      const feats = await getJson(url(`${parts.LPPF}/4`, {
        geometry: `${b.w},${b.s},${b.e},${b.n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', where: "cover_typ = 'Easement'", outFields: parts.PARCEL_FIELDS,
        returnGeometry: 'true', outSR: '4326', maxAllowableOffset: String(offsetDeg()), geometryPrecision: '6',
        resultRecordCount: '200',
      }));
      lot.ease = feats.map(f => ({ p: parts.parcelOf((f && f.attributes) || {}), rings: ringsOf(f) }))
        .filter(e => e.rings.length).map(e => ({ ...e, box: boxOf(e.rings) }));
    } catch (_) {
      lot.ease = 'failed';
    }
    refresh();
  }

  async function askAddress(p) {
    const parts = P();
    if (!p.lotplan || !parts.LOTPLAN_RE.test(p.lotplan) || addrs.has(p.lotplan)) return;
    addrs.set(p.lotplan, 'asking');
    try {
      const feats = await getJson(url(parts.ADDR.path, {
        where: `lotplan='${p.lotplan}'`, outFields: parts.ADDR.fields, orderByFields: 'address',
        resultRecordCount: '4', returnGeometry: 'false',
      }));
      addrs.set(p.lotplan, { list: [...new Set(feats.map(f => String((f.attributes || {}).address || '').trim()).filter(Boolean))] });
    } catch (_) {
      addrs.set(p.lotplan, 'failed');
    }
    refresh();
  }

  async function askUse(ll) {
    const parts = P();
    try {
      const feats = await getJson(url(parts.USE.path, {
        geometry: `${ll.lng},${ll.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', outFields: parts.USE.fields, returnGeometry: 'true',
        outSR: '4326', maxAllowableOffset: String(offsetDeg()), geometryPrecision: '6',
      }));
      const f = feats.find(x => ringsOf(x).length);
      if (f) {
        const a = f.attributes || {};
        const rings = ringsOf(f);
        keepNewest(uses, { box: boxOf(rings), rings,
          f: { primary: String(a.primary_ || ''), secondary: String(a.secondary || ''), tertiary: String(a.tertiary || ''),
               year: a.year || null } });
      } else {
        // Not mapped here: remembered for this spot only, as a small box.
        const d = offsetDeg() * 4;
        keepNewest(uses, { box: { w: ll.lng - d, e: ll.lng + d, s: ll.lat - d, n: ll.lat + d },
          rings: [[[ll.lng - d, ll.lat - d], [ll.lng + d, ll.lat - d], [ll.lng + d, ll.lat + d], [ll.lng - d, ll.lat + d]]], f: null });
      }
    } catch (_) { /* the row says it could not be read */ }
    refresh();
  }

  // The pointer has rested on land not read yet: ask about it.
  function askHere(ll) {
    if (Date.now() - failedAt < FAIL_MS) { show(ll, failedText()); return; }
    if (ctl) ctl.abort();
    const mine = ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    show(ll, { head: 'Reading the cadastre…', lines: [] });
    askLot(ll, mine && mine.signal).then(lot => {
      if (ctl !== mine) return;
      ctl = null;
      if (!lot) { if (lastLL && sameSpot(lastLL, ll)) show(ll, { head: 'No land parcel mapped here', lines: [] }); return; }
      refresh();
    }, err => {
      if (ctl !== mine) return;
      ctl = null;
      if (err && err.name === 'AbortError') return;
      failedAt = Date.now();
      if (lastLL) show(lastLL, failedText());
    });
  }
  const sameSpot = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
  const failedText = () => ({ head: 'The State’s cadastre could not be read just now', lines: ['What is here? asks again for one point'] });

  // ── What it says ───────────────────────────────────────────────────────────
  function content(lot, ll, w) {
    const parts = P();
    const p = lot.main;
    const t = parts.tenureOf(p) || {};
    const council = parts.councilOf(p);
    const where = [p.locality, council].filter(Boolean).join(' · ');
    const area = p.kind === 'lot' ? parts.areaWords(p.area) : '';
    const lotWords = parts.parcelWords(p);
    const tenure = p.kind === 'lot' ? (p.tenure || 'Tenure not recorded') : (t.tenure || p.tenure || '');
    const lines = [];
    let head;
    if (w.tenure) {
      // Land & tenure: what kind of holding, and who holds that kind.
      head = tenure + (p.name && p.kind === 'lot' ? ` — ${p.name}` : '');
      if (t.held) lines.push(`Held by: ${t.held}`);
      lines.push([lotWords, area].filter(Boolean).join(' · '));
      const u = useAt(ll);
      if (u && u.f) lines.push(`Used for: ${parts.useWords(u.f)}${u.f.year ? ` (mapped ${u.f.year})` : ''}`);
      else if (u) lines.push('Land use: not mapped here');
      else lines.push('Land use: asking…');
    } else {
      // Property & easements, or the lot lines on: the lot, and what is over it.
      head = lotWords + (p.kind === 'lot' && p.name ? ` — ${p.name}` : '');
      lines.push([area, tenure].filter(Boolean).join(' · '));
      if (w.easements) {
        if (lot.ease === 'failed') lines.push('Easements: could not be read');
        else if (!lot.ease) lines.push('Easements: asking…');
        else {
          const here = lot.ease.filter(e => inside(e, ll));
          const n = lot.ease.length;
          if (here.length) {
            lines.push(here.map(e => (e.p.lot && e.p.plan ? `Easement ${e.p.lot} on ${e.p.plan}` : 'An easement')).join(', ')
              + ' — under the pointer');
          } else {
            lines.push(n ? `No easement here · ${n} nearby` : 'No easement here or nearby');
          }
        }
      }
      if (p.kind === 'lot' && p.lotplan) {
        const a = addrs.get(p.lotplan);
        if (a && a.list) lines.push(a.list.length ? `Address: ${a.list[0]}${a.list.length > 1 ? ` (+${a.list.length - 1})` : ''}` : 'No street address registered');
        else if (a === 'failed') lines.push('Address: could not be read');
        else lines.push('Address: asking…');
      }
    }
    if (lot.others.length) lines.push(`On the line with ${lot.others.map(o => parts.parcelWords(o)).join(', ')}`);
    if (where) lines.push(where);
    return { head, lines };
  }

  function html(c) {
    return `<div class="mn-prop-tip-h">${esc(c.head)}</div>`
      + c.lines.filter(Boolean).map(l => `<div class="mn-prop-tip-l">${esc(l)}</div>`).join('');
  }

  function show(ll, c) {
    if (!map) return;
    const body = html(c);
    lastText = [c.head, ...c.lines].filter(Boolean).join('\n');
    if (!tip) {
      tip = L.tooltip({ className: 'mn-road-label mn-prop-tip', direction: 'top', offset: [0, -10], interactive: false })
        .setContent(body).setLatLng(ll).addTo(map);
    } else {
      tip.setLatLng(ll).setContent(body);
    }
  }
  function hide() {
    if (tip) { tip.remove(); tip = null; }
    lastText = '';
  }

  // Say what is known about the spot the pointer is on, and ask for what is
  // not — the lot first; its easements, address and land use behind it.
  function refresh() {
    const ll = lastLL;
    const w = ll && drawn();
    if (!ll || !w || busy() || !inQld(ll)) { hide(); return; }
    const lot = lotAt(ll);
    if (!lot) return;
    // A road reserve with the road reserves on is named by their own label
    // (map-roads.js); two names for one road would be one too many.
    if ((lot.main.kind === 'road' || lot.main.kind === 'junction') && state.mapRoads) { hide(); return; }
    if (w.easements && !lot.easeAsked) askEasements(lot);
    if (!w.tenure && lot.main.kind === 'lot') askAddress(lot.main);
    if (w.tenure && !useAt(ll) && !timer) timer = setTimeout(() => { timer = null; if (lastLL && !useAt(lastLL)) askUse(lastLL); }, PAUSE_MS);
    show(ll, content(lot, ll, w));
  }

  function onMove(e) {
    if (!map || moveRaf) return;
    const ev = e && e.originalEvent;
    if (ev && ev.pointerType && ev.pointerType === 'touch') return;
    const ll = e.latlng;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      lastLL = ll;
      clearTimeout(timer); timer = null;
      const w = drawn();
      if (!w || busy() || !inQld(ll)) { hide(); return; }
      if (lotAt(ll)) { refresh(); return; }
      // Land not read yet: nothing said until the pointer rests on it.
      hide();
      if (ctl) { ctl.abort(); ctl = null; }
      timer = setTimeout(() => { timer = null; if (lastLL === ll) askHere(ll); }, PAUSE_MS);
    });
  }
  function onOut() {
    lastLL = null;
    clearTimeout(timer); timer = null;
    if (ctl) { ctl.abort(); ctl = null; }
    hide();
  }

  return {
    attach(m) {
      if (map === m) return;
      if (map) this.detach();
      map = m;
      m.on('mousemove', onMove);
      m.on('mouseout movestart zoomstart', onOut);
    },
    detach() {
      if (!map) return;
      map.off('mousemove', onMove);
      map.off('mouseout movestart zoomstart', onOut);
      onOut();
      map = null;
    },
    // For the checks: the words on the tip now, and how many questions the
    // State has been asked.
    _state() { return { text: lastText, shown: !!tip, asked, lots: lots.length, uses: uses.length }; },
    _forget() { lots.length = 0; uses.length = 0; addrs.clear(); failedAt = 0; asked = 0; },
  };
})();
