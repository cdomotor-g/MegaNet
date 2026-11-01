// MegaNet — map-drive-mode.js
//
//   DriveMode   🚘 Drive (and ▶ Preview): the route 🛣️ Route on map worked out
//               (map-drive.js), followed in the ⛰️ 3-D view as it is driven —
//               the road ahead tilted up the screen and turning with the car,
//               the next turn and how far to it across the top, how far and
//               how long is left across the foot, said aloud as well, and the
//               stations ahead named over their pins.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, announce, termHtml, pillText,
// pillLong, fmtKm, bearingDeg, destPoint, kmPerDegLon and KM_PER_DEG_LAT;
// across to map-drive.js for the route (MapDrive.plan, reroute), to map-3d.js
// for the view and its camera (Map3D.active, toggle, stop, drive, driveFrame,
// driveTags, driveOverview, routeChanged), and to app.js for closeStnCard and
// invalidateMapSizes. All of it from inside its own functions: the IIFE body
// declares nothing but constants and nulls, so this file's position among the
// modules is free.
//
// ── Why, beside 🚗 Directions ────────────────────────────────────────────────
// Directions hands the station's coordinate to Apple or Google Maps, which
// know the roads and not the network: they stop at the gate, they do not know
// the access track somebody drove to the gauge, and they cannot show the
// stations on the way. This follows Flood-Net's own route — the road, then the
// track, then the stretch nobody has mapped — on Flood-Net's own map, with the
// pins the Stations map is showing standing on the ground round the road.
// Directions stays; this is the same trip, followed here.
//
// ── The screen ───────────────────────────────────────────────────────────────
// The Stations map's panel is fixed over the whole window (`.is-driving`,
// above the side panel and the banner, below the bug reporter and the toasts),
// the 3-D view is opened if it was not, and the camera is handed to this file
// (Map3D.drive): every frame it is put over the car, heading up, tilted
// PITCH degrees, closer in at walking pace and further out at highway speed,
// with the car CAR_AT of the way down the road left in view between the
// banner and the foot (measure), so most of the screen is the road ahead. Over it, a banner with the next turn — its arrow, how far, the
// router's own words, and the turn after it when that one comes close behind —
// and a foot with ✕ End, what is left to go and when it would arrive, the
// voice, and 🗺️ Overview (the rest of the route from overhead) or ◎ Re-centre.
//
// A drag, pinch or twist of the map is somebody looking round, and the camera
// is left where they put it (Map3D tells us: `gesture`) until ◎ Re-centre — or,
// on a real drive, until they have left it alone for FREE_MS.
//
// ── Where the car is ─────────────────────────────────────────────────────────
// The phone's position, watched (watchPosition), and put on the route: the
// nearest point of it within ON_M plus the fix's own ±, searched first just
// ahead of where the car was so that a road the route comes back along later
// does not take the car there early. On the route, the car is drawn on the
// line and carried along it at its speed between fixes — a fix a second is a
// car that jumps a second apart — and pointed along it, so the view turns with
// the road rather than with a heading that wanders when the car stops. Off it,
// it is drawn at the fix, carried on along the fix's course.
//
// A fix rougher than ROUGH_M is not followed (the banner says so), and none
// for LOST_MS says it is waiting for one.
//
// ── Off the route ────────────────────────────────────────────────────────────
// Further from it than ON_M plus the fix's ± for OFF_MS, while the car has not
// yet left the road for the track: the route is asked for again from where the
// car is (MapDrive.reroute — the same Worker, the same brakes), at most once
// every REROUTE_MS, and the old route is followed and drawn until the new one
// comes. Past the road nothing would route the rest — the router knows no
// tracks through a property — so there the banner says which way the station
// is and how far, as the crow flies.
//
// ── The words, and when they are said ────────────────────────────────────────
// The router's own turn-by-turn words (Valhalla's, in British English), then
// Flood-Net's for the stretches it adds: where the mapped road ends, the access
// track, what is not mapped, and arriving. Each is said twice — PREP seconds
// out ("In 400 metres, turn right onto Sandgate Road") and NOW seconds out —
// at the speed the car is doing, with floors for a crawl; and after a turn,
// how far it is to the next when that is more than FAR_M. Spoken with the
// browser's own voice in Australian English where it has one, and put in the
// app's live region either way. 🔊 turns the voice off and on, remembered on
// this device.
//
// The arrow is drawn from the router's words where they name the turn ("turn
// left", "keep right", "sharp", "U-turn", a roundabout) and from the bend of
// the road itself where they do not: the router's turn type is not in what the
// Worker passes on, and the bend is the same answer for the stretches the
// router never saw.
//
// ── The stations named ───────────────────────────────────────────────────────
// The pins the Stations map is drawing (state.mapMarkers — its filters, its
// colours; the 3-D view mirrors them), nearest first: the TAG_LOOK nearest
// within TAG_KM in a cone TAG_CONE degrees either side of the way the car is
// pointing, or within TAG_NEAR_KM behind it, offered to the 3-D view, which
// names those it can see — whole, between the banner and the foot, and clear
// of each other — at most TAG_MAX, with how far each is. The station driven
// to is offered first, from DEST_KM out, whatever the filters say, and named
// with a flag. Looked at again every TAG_MS — names are for reading, not for
// flickering.
//
// ── ▶ Preview ────────────────────────────────────────────────────────────────
// The drive played along the route without the phone's position, on a desk as
// on a phone: each turn's stretch at the router's own time for it, the access
// track at TRACK_KMH and what is not mapped at GAP_KMH, sped up 1, 4 or 16
// times (remembered), with ⏸ and ⏭ to the next turn. Everything else is the
// drive's, so it is the way to see what the drive will look like.
//
// ── Kept awake, and kept safe ────────────────────────────────────────────────
// The screen is kept on while the drive is (the Wake Lock API, asked again
// when the page comes back), and the drive opens with a line that says it once:
// the route knows nothing of floods, closures or roadworks. If it's flooded,
// forget it.
//
// ── Coming and going ─────────────────────────────────────────────────────────
// ✕ End or Escape ends it; so do leaving the Stations tab and the route being
// taken off the map (signing out does that). The flat map is left where the
// car was, with the route panel as it was, and the 3-D view closed again if
// the drive opened it. A render of the tab under the drive rebuilds the map
// and closes the 3-D view; attach() puts the screen and the camera back on the
// new ones, and the drive goes on.
//
// Editors only, as the route is (map-drive.js): there is nothing to drive
// without one.
const DriveMode = (function () {
  const PITCH = 58;                 // degrees from straight down: the road ahead, and a strip of sky
  const CAR_AT = 0.78;              // the car this far down the road the screen leaves in view
  const ZOOM_SLOW = 16.6;           // MapLibre's zoom at a crawl…
  const ZOOM_FAST = 14.8;           // …and at FAST_KMH and over
  const FAST_KMH = 110;
  const ZOOM_NEAR_TURN = 0.4;       // closer in for a turn coming up below TURN_KMH
  const TURN_KMH = 70;
  const FRAME_MS = 30;              // at most ~33 camera moves a second
  const GUIDE_MS = 250;             // the words looked at four times a second
  const TAG_MS = 1500;
  const TAG_KM = 12;
  const TAG_LOOK = 24;              // the nearest this many are offered; the view names those it shows
  const TAG_NEAR_KM = 0.6;
  const TAG_CONE = 70;
  const TAG_MAX = 6;
  const DEST_KM = 30;
  const ON_M = 40;
  const OFF_MS = 6000;
  const REROUTE_MS = 20000;
  const ARRIVE_M = 30;
  const ROUGH_M = 100;
  const LOST_MS = 15000;
  const FREE_MS = 15000;
  const NOTE_MS = 12000;
  const PREP_S = 15, NOW_S = 4;     // seconds out at the car's speed
  const PREP_MIN_M = 200, PREP_MAX_M = 1200, NOW_MIN_M = 25, NOW_MAX_M = 150;
  const FAR_M = 3000;
  const THEN_M = 250;               // a turn this close behind the next is shown with it
  const TRACK_KMH = 20, GAP_KMH = 5;
  const ROAD_KMH = 50;              // a road stretch the router gave no time for
  const SPEEDS = [1, 4, 16];
  const VOICE_KEY = 'mn-drive-voice';
  const SPEED_KEY = 'mn-drive-preview';

  let leaflet = null;     // the Stations map (attach)
  let d = null;           // the drive under way (start), or null
  let hud = null;         // its screen, on the map's stage
  let raf = 0;
  let keyHandler = null;
  let visHandler = null;
  let wake = null;

  // ── Words ──────────────────────────────────────────────────────────────────
  // The drive's own words, listed in the route panel's fold after the route's
  // (map-drive.js wordsHtml): the drive's screen has no room for one.
  const WORDS = [
    ['togo', 'To go', 'How far and how long is left: the rest of the road at its usual speeds — no traffic, roadworks, closures or floods — then the access track at 20 km/h and anything not mapped at walking pace.'],
    ['arrive', 'Arrive', 'The time it will be on getting to the station if the rest of the drive goes at those speeds from now. Worked out again as you go.'],
    ['off', 'Off the route', 'More than 40 m from the route, plus however rough the phone’s position is, for 6 seconds while still on the road: the route is worked out again from where you are, at most once every 20 seconds.'],
    ['preview', 'Preview', 'The drive played along the route at the roads’ usual speeds, sped up 1, 4 or 16 times. Nothing in it uses where you are.'],
  ];
  const word = k => (WORDS.find(w => w[0] === k) || [])[2] || '';
  const term = (k, text) => termHtml(text || (WORDS.find(w => w[0] === k) || [])[1] || k, word(k));

  // ── Small sums ─────────────────────────────────────────────────────────────

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const wrap180 = a => ((a % 360) + 540) % 360 - 180;

  function metres(a, b) {
    const dx = (b[1] - a[1]) * kmPerDegLon(a[0]) * 1000;
    const dy = (b[0] - a[0]) * KM_PER_DEG_LAT * 1000;
    return Math.hypot(dx, dy);
  }

  // A phone or a tablet — a device somebody drives with. MapLocate's test,
  // and map-drive.js's.
  function handheld() {
    return (typeof L !== 'undefined' && L.Browser && L.Browser.mobile)
      || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  function stored(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (_) { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) { /* a private window: not remembered */ }
  }

  // ── The route as a line to follow ──────────────────────────────────────────
  // The stretches end to end: every point, the distance to each from the start
  // (cum), the kind of the stretch each point ends (kind), and where each
  // stretch starts (legs). A stretch that begins where the last ended shares
  // its point; one that begins a little way off (a track starting within 30 m
  // of where the road stops) is joined by a short line of its own kind.
  function buildPath(legs) {
    const pts = [], kind = [], starts = [];
    for (const l of legs || []) {
      if (!l || !Array.isArray(l.pts) || l.pts.length < 2) continue;
      const last = pts[pts.length - 1];
      const shared = !!last && Math.abs(last[0] - l.pts[0][0]) < 1e-7 && Math.abs(last[1] - l.pts[0][1]) < 1e-7;
      starts.push({ kind: l.kind, i: shared ? pts.length - 1 : pts.length });
      for (let k = shared ? 1 : 0; k < l.pts.length; k++) {
        pts.push([+l.pts[k][0], +l.pts[k][1]]);
        kind.push(l.kind);
      }
    }
    if (pts.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
    for (let k = 0; k < starts.length; k++) {
      starts[k].s = cum[starts[k].i];
      starts[k].e = k + 1 < starts.length ? cum[starts[k + 1].i] : cum[cum.length - 1];
    }
    return { pts, kind, cum, total: cum[cum.length - 1], legs: starts, spd: [], tcum: [] };
  }

  // The last point at or before `s`.
  function vertexAt(path, s) {
    const c = path.cum;
    let lo = 0, hi = c.length - 1;
    if (s <= 0) return 0;
    if (s >= c[hi]) return hi - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
    return lo;
  }

  function pointAt(path, s) {
    const i = vertexAt(path, clamp(s, 0, path.total));
    const a = path.pts[i], b = path.pts[Math.min(i + 1, path.pts.length - 1)];
    const len = path.cum[Math.min(i + 1, path.cum.length - 1)] - path.cum[i];
    const t = len > 0 ? clamp((s - path.cum[i]) / len, 0, 1) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // The kind of stretch at `s`.
  function kindAt(path, s) {
    return path.kind[Math.min(vertexAt(path, s) + 1, path.kind.length - 1)];
  }

  // The way the route goes at `s`: from a little behind to a little ahead, so
  // a bend is turned through rather than snapped at.
  function headingAt(path, s, back = 10, ahead = 25) {
    const a = pointAt(path, clamp(s - back, 0, path.total));
    const b = pointAt(path, clamp(s + ahead, 0, path.total));
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) return null;
    return bearingDeg(a[0], a[1], b[0], b[1]);
  }

  // The nearest point of the route to `p`, between `from` and `to` metres
  // along it: { s, d } or null.
  function project(path, p, from = -Infinity, to = Infinity) {
    const kx = kmPerDegLon(p[0]) * 1000, ky = KM_PER_DEG_LAT * 1000;
    let best = null;
    for (let i = 0; i < path.pts.length - 1; i++) {
      if (path.cum[i + 1] < from || path.cum[i] > to) continue;
      const a = path.pts[i], b = path.pts[i + 1];
      const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
      const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * ky;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
      const dd = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || dd < best.d) best = { d: dd, s: path.cum[i] + t * (path.cum[i + 1] - path.cum[i]) };
    }
    return best;
  }

  // ── The turns ──────────────────────────────────────────────────────────────

  // The turn at `s`: { k: 'turn' | 'round' | 'uturn' | 'arrive' | 'gap', ang }
  // — `ang` degrees off straight ahead, left negative. The router's words
  // where they name it, the road's own bend where they do not.
  function turnFor(path, s, text, kind) {
    if (kind === 'arrive') return { k: 'arrive', ang: 0 };
    // The words before the road's name: "Turn right onto Left Bank Road" is a
    // right turn.
    const t = String(text || '').toLowerCase().split(/\b(?:onto|on|to|towards|toward|at|for)\b/)[0];
    const inB = s >= 15 ? bearingDeg(...pointAt(path, s - 30), ...pointAt(path, s)) : null;
    const outB = s < path.total - 5 ? bearingDeg(...pointAt(path, s), ...pointAt(path, Math.min(path.total, s + 30))) : null;
    const bend = inB == null || outB == null ? 0 : wrap180(outB - inB);
    const side = /\bleft\b/.test(t) ? -1 : /\bright\b/.test(t) ? 1 : 0;
    if (/u-turn/.test(t)) return { k: 'uturn', ang: side < 0 ? -180 : 180 };
    if (/roundabout/.test(t)) return { k: 'round', ang: bend };
    if (side && /\bsharp\b/.test(t)) return { k: 'turn', ang: 135 * side };
    if (side && /\b(bear|keep|slight|stay)\b/.test(t)) return { k: 'turn', ang: 35 * side };
    if (side && /\bturn\b/.test(t)) return { k: 'turn', ang: 90 * side };
    if (/^(drive|head|continue|go)\b/.test(t)) return { k: 'turn', ang: 0 };
    return { k: kind === 'gap' ? 'gap' : 'turn', ang: Math.abs(bend) < 20 ? 0 : bend };
  }

  // The turn as an arrow: a stem up from the foot, bent by the turn, with a
  // head — or a U, a ring with its exit, a flag.
  function arrowSvg(turn) {
    const svg = inner => `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">${inner}</svg>`;
    const stroke = 'fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
    const head = (x, y, a) => {
      const ux = Math.sin(a), uy = -Math.cos(a), nx = Math.cos(a), ny = Math.sin(a);
      const p = (px, py) => `${px.toFixed(1)},${py.toFixed(1)}`;
      return `<polygon points="${p(x + ux * 8, y + uy * 8)} ${p(x + nx * 7, y + ny * 7)} ${p(x - nx * 7, y - ny * 7)}" fill="currentColor"/>`;
    };
    if (turn.k === 'arrive') {
      return svg(`<path d="M15 44 V8" ${stroke}/><path d="M17 9 H36 L31 16 L36 23 H17 Z" fill="currentColor"/>`);
    }
    if (turn.k === 'uturn') {
      const m = turn.ang < 0 ? 1 : -1;     // a left U-turn comes back down on the left
      const x0 = 24 + 7 * m, x1 = 24 - 7 * m;
      return svg(`<path d="M${x0} 44 V20 A7 7 0 0 ${m > 0 ? 0 : 1} ${x1} 20 V30" ${stroke}/>${head(x1, 31, Math.PI)}`);
    }
    if (turn.k === 'round') {
      const a = turn.ang * Math.PI / 180;
      const ex = 24 + 9 * Math.sin(a), ey = 20 - 9 * Math.cos(a);
      const tx = 24 + 17 * Math.sin(a), ty = 20 - 17 * Math.cos(a);
      return svg(`<circle cx="24" cy="20" r="9" fill="none" stroke="currentColor" stroke-width="3.5"/>`
        + `<path d="M24 44 V29" ${stroke}/><path d="M${ex.toFixed(1)} ${ey.toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)}" ${stroke}/>${head(tx, ty, a)}`);
    }
    const a = clamp(turn.ang || 0, -160, 160) * Math.PI / 180;
    const x2 = 24 + 13 * Math.sin(a), y2 = 25 - 13 * Math.cos(a);
    const dash = turn.k === 'gap' ? ' stroke-dasharray="1 7"' : '';
    return svg(`<path d="M24 44 V25 L${x2.toFixed(1)} ${y2.toFixed(1)}" ${stroke}${dash}/>${head(x2, y2, a)}`);
  }

  // ── The plan: what is said, where ──────────────────────────────────────────
  // Each item is somewhere along the route (s), with the words for the banner
  // (text), what is said out loud before it (prep, with {d} for how far) and
  // at it (now), and its arrow.
  function buildItems(plan, path) {
    const items = [];
    const road = path.legs.find(l => l.kind === 'road');
    const roadAt = road ? path.legs.indexOf(road) : -1;
    const len = l => l.e - l.s;
    const lc = t => t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
    const km = m => fmtKm(m / 1000);
    path.legs.forEach((l, k) => {
      if (k < roadAt && l.kind === 'gap') {
        items.push({ s: l.s, kind: 'gap', text: `Make your way to the road, ${km(len(l))} away — not mapped.`,
                     now: `Make your way to the road, ${spoken(len(l))} away.` });
      }
    });
    if (road) {
      plan.steps.forEach((st, k) => {
        const v = Math.min(path.pts.length - 1, road.i + (Number(st.at) || 0));
        const text = String(st.text || '');
        items.push({ s: path.cum[v], kind: 'road', text, now: text, prep: `In {d}, ${lc(text)}`,
                     depart: k === 0, mps: st.s > 0 && st.km > 0 ? (st.km * 1000) / st.s : null });
      });
    }
    path.legs.forEach((l, k) => {
      if (k <= roadAt) return;
      const next = path.legs[k + 1];
      if (l.kind === 'gap' && next && next.kind === 'track') {
        items.push({ s: l.s, kind: 'gap', text: `The mapped road ends: ${km(len(l))} with no mapped road to the access track.`,
                     now: `The mapped road ends here. The access track starts ${spoken(len(l))} on.`, prep: 'In {d}, the mapped road ends.' });
      } else if (l.kind === 'gap' && k === path.legs.length - 1 && path.legs[k - 1] && path.legs[k - 1].kind === 'track') {
        items.push({ s: l.s, kind: 'gap', text: `The access track ends: the station is ${km(len(l))} on, not mapped.`,
                     now: `The access track ends here. The station is ${spoken(len(l))} on.`, prep: 'In {d}, the access track ends.' });
      } else if (l.kind === 'gap') {
        items.push({ s: l.s, kind: 'gap', text: `The mapped road ends: the station is ${km(len(l))} on, not mapped.`,
                     now: `The mapped road ends here. The station is ${spoken(len(l))} on.`, prep: 'In {d}, the mapped road ends.' });
      } else if (l.kind === 'track') {
        const toPin = k === path.legs.length - 1;
        items.push({ s: l.s, kind: 'track', text: `Follow the access track, ${km(len(l))}${toPin ? ', to the station' : ''}.`,
                     now: `Follow the access track, ${spoken(len(l))}${toPin ? ', to the station' : ''}.`, prep: 'In {d}, the access track starts.' });
      }
    });
    items.push({ s: path.total, kind: 'arrive', text: `Arrive at ${plan.name}.`, now: `You have arrived at ${plan.name}.`,
                 prep: `In {d}, ${plan.name}.` });
    items.sort((a, b) => a.s - b.s);
    for (const it of items) it.turn = turnFor(path, it.s, it.text, it.kind);
    return items;
  }

  // Each stretch's speed and the time to each point: a turn's stretch at the
  // router's own time for it, the track and what is not mapped at theirs.
  function timePath(path, items) {
    const roadItems = items.filter(it => it.kind === 'road');
    let r = 0;
    path.tcum = [0];
    path.spd = [];
    for (let i = 0; i < path.pts.length - 1; i++) {
      const s = path.cum[i];
      const kind = path.kind[i + 1];
      let v;
      if (kind === 'road') {
        while (r + 1 < roadItems.length && roadItems[r + 1].s <= s) r++;
        v = (roadItems[r] && roadItems[r].mps) || ROAD_KMH / 3.6;
      } else {
        v = (kind === 'track' ? TRACK_KMH : GAP_KMH) / 3.6;
      }
      v = clamp(v, 1, 40);
      path.spd.push(v);
      path.tcum.push(path.tcum[i] + (path.cum[i + 1] - s) / v);
    }
  }

  function speedAt(path, s) {
    return path.spd[Math.min(vertexAt(path, s), path.spd.length - 1)] || ROAD_KMH / 3.6;
  }

  // Seconds from `s` to the end, at the plan's speeds.
  function secondsFrom(path, s) {
    const i = vertexAt(path, s);
    const len = path.cum[i + 1] - path.cum[i];
    const t = len > 0 ? clamp((s - path.cum[i]) / len, 0, 1) : 0;
    const at = path.tcum[i] + t * (path.tcum[i + 1] - path.tcum[i]);
    return Math.max(0, path.tcum[path.tcum.length - 1] - at);
  }

  // ── Saying it ──────────────────────────────────────────────────────────────

  // How far, as the banner shows it: to the ten metres close in, the fifty
  // further out, a tenth of a kilometre past one and whole ones past ten.
  function navDist(m) {
    if (!isFinite(m)) return '';
    if (m < 20) return 'Now';
    if (m < 100) return `${Math.round(m / 10) * 10} m`;
    if (m < 1000) return `${Math.round(m / 50) * 50} m`;
    if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
  }

  // …and as it is said.
  function spoken(m) {
    if (m < 1000) return `${m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50} metres`;
    const k = m < 10000 ? Math.round(m / 100) / 10 : Math.round(m / 1000);
    return `${k} kilometre${k === 1 ? '' : 's'}`;
  }

  function duration(sec) {
    const min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function spokenDuration(sec) {
    const min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
    const h = Math.floor(min / 60), m = min % 60;
    return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
  }

  function clock(ms) {
    try {
      return new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
      const t = new Date(ms);
      return `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
  }

  // A compass word for a bearing, for the way to a station off the road.
  function compass(b) {
    const W = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return W[Math.round(((b % 360) + 360) % 360 / 45) % 8];
  }

  function voiceOn() { return stored(VOICE_KEY, 'on') !== 'off'; }

  // Out loud, when the voice is on, and in the live region either way. The
  // newest words win: what was being said is cut off rather than queued, so a
  // turn is never said after it has been passed.
  function speak(text) {
    if (!text) return;
    if (d) d.lastSaid = performance.now();
    announce(text);
    if (!d || !d.voice || typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-AU';
      speechSynthesis.speak(u);
    } catch (_) { /* no voice on this device: the live region has it */ }
  }

  function hush() {
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch (_) { /* nothing to stop */ }
  }

  // Said from inside the press that starts the drive, before anything is
  // awaited: Safari on a phone lets a page speak only once it has spoken from
  // inside a tap, and the drive's first words come after the 3-D view has
  // loaded. An empty utterance is enough to be allowed.
  function primeVoice() {
    if (!voiceOn() || typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (_) { /* no voice: the live region has it */ }
  }

  // ── Starting and ending ────────────────────────────────────────────────────

  // 🚘 Drive (`gps`) and ▶ Preview (`preview`), from the route panel.
  async function start(mode = 'gps') {
    const preview = mode === 'preview';
    if (d) {
      if (d.mode === (preview ? 'preview' : 'gps')) return;
      end({ quiet: true });
    }
    const plan = typeof MapDrive !== 'undefined' && MapDrive.plan ? MapDrive.plan() : null;
    if (!plan || plan.status !== 'ok' || !plan.legs.length) {
      announce('There is no route to follow yet — work it out on the map first.');
      return;
    }
    if (!leaflet) { announce('Open the Stations map to drive the route.'); return; }
    if (!preview && (typeof navigator === 'undefined' || !navigator.geolocation)) {
      announce('This device does not say where it is, so the drive cannot follow it. ▶ Preview plays the drive instead.');
      return;
    }
    const path = buildPath(plan.legs);
    if (!path || path.total < 1) { announce('The route is too short to drive.'); return; }
    const items = buildItems(plan, path);
    timePath(path, items);
    const x = Number(stored(SPEED_KEY, '4'));
    const now = performance.now();
    d = {
      mode: preview ? 'preview' : 'gps',
      stationId: plan.stationId, name: plan.name, dest: plan.dest,
      plan: { ...plan, start: null }, path, items,
      s: 0, pos: pointAt(path, 0), heading: headingAt(path, 0) || 0, speed: 0, zoom: ZOOM_SLOW, boost: 0,
      fix: null, lastFixAt: 0, rough: 0, gpsErr: '', watch: null,
      off: 0, rerouting: false, lastReroute: -Infinity, rerouteErr: '',
      arrived: false, said: {}, lastNext: -1, lastSaid: 0,
      follow: true, freeAt: 0, easeNext: false,
      voice: voiceOn(), x: SPEEDS.includes(x) ? x : 4, paused: false,
      t: now, lastDraw: 0, lastGuide: 0, lastTags: 0, drawn: null,
      opened3d: false, startedAt: Date.now(),
      note: { text: preview
        ? 'A preview along the route at the roads’ usual speeds, sped up — nothing here uses where you are.'
        : 'Eyes on the road. The route knows nothing of floods, closures or roadworks — if it’s flooded, forget it.',
              until: now + NOTE_MS },
    };
    const my = d;
    // Before the first await, while this is still the press: the voice and the
    // screen's wake lock are each asked for from inside it.
    primeVoice();
    holdWake();
    enterScreen();
    if (!(await takeView()) || d !== my) return;
    if (!preview) startGps();
    loop();
    const left = secondsFrom(path, 0);
    const first = items.find(it => it.depart);
    speak(`${preview ? 'Previewing the drive' : 'Driving'} to ${d.name}: ${spoken(path.total)}, about ${spokenDuration(left)}.${
      first && first.s <= 5 ? ` ${first.now}` : ''}`);
  }

  // The 3-D view, opened if it is not up, and its camera taken. False when
  // there is no view to drive in — and then the drive has ended, saying why.
  async function takeView() {
    if (typeof Map3D === 'undefined') { end({ why: 'The 3-D view is not part of this copy of Flood-Net, so the drive cannot be followed here.' }); return false; }
    const my = d;
    if (!Map3D.active()) {
      d.opened3d = true;
      let ok = false;
      try { ok = await Map3D.toggle(); } catch (_) { ok = false; }
      if (d !== my) return false;
      if (!ok || !Map3D.active()) {
        end({ why: 'The 3-D view could not start on this device, so the drive cannot be followed here. 🚗 Directions hands the trip to your maps app.' });
        return false;
      }
    }
    Map3D.drive(true, { gesture: onGesture });
    Map3D.routeChanged();
    return true;
  }

  // `why` is said instead of "Drive ended"; `quiet` says nothing.
  function end({ why = '', quiet = false } = {}) {
    if (!d) return;
    const was = d;
    d = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    stopGps(was);
    hush();
    releaseWake();
    if (typeof Map3D !== 'undefined') {
      if (Map3D.drive) Map3D.drive(false);
      if (Map3D.routeChanged) Map3D.routeChanged();
      if (was.opened3d && Map3D.active && Map3D.active() && Map3D.stop) Map3D.stop();
    }
    leaveScreen();
    // The flat map where the car was, close enough to see the roads round it
    // — when the 3-D view was closed again; left up, its camera puts it there.
    if (leaflet && was.pos && was.opened3d) {
      try { leaflet.setView(was.pos, Math.max(14, Math.min(leaflet.getZoom(), 15)), { animate: false }); } catch (_) { /* a map going away */ }
    }
    const pill = document.querySelector(`.mn-drive-panel .mn-dm-pill[data-mode="${was.mode}"]`);
    if (pill) pill.focus({ preventScroll: true });
    if (!quiet) announce(why || (was.mode === 'preview' ? 'Preview ended.' : 'Drive ended.'));
  }

  // ── The screen ─────────────────────────────────────────────────────────────

  function mapPanel() {
    const el = leaflet && leaflet.getContainer ? leaflet.getContainer() : document.getElementById('leaflet-map');
    return el && el.closest ? el.closest('.map-panel') : null;
  }

  function enterScreen() {
    if (typeof closeStnCard === 'function') closeStnCard(false);
    if (leaflet) { try { leaflet.closePopup(); } catch (_) { /* no popup */ } }
    const panel = mapPanel();
    if (panel) panel.classList.add('is-driving');
    addHud();
    if (typeof invalidateMapSizes === 'function') invalidateMapSizes(0);
    if (!keyHandler) { keyHandler = onKey; document.addEventListener('keydown', keyHandler, true); }
    const b = hud && hud.querySelector('.mn-dm-end');
    if (b) b.focus({ preventScroll: true });
  }

  function leaveScreen() {
    if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
    const panel = mapPanel();
    if (panel) panel.classList.remove('is-driving');
    for (const el of document.querySelectorAll('.map-panel.is-driving')) el.classList.remove('is-driving');
    if (hud) hud.remove();
    hud = null;
    if (typeof invalidateMapSizes === 'function') invalidateMapSizes(0);
  }

  function onKey(e) {
    if (!d || e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    end();
  }

  function addHud() {
    if (!d) return;
    const stage = leaflet && leaflet.getContainer ? leaflet.getContainer().parentElement : null;
    if (!stage) return;
    if (hud && hud.parentElement === stage) { paint(true); return; }
    if (hud) hud.remove();
    hud = document.createElement('div');
    hud.className = 'mn-dm';
    hud.setAttribute('role', 'region');
    hud.innerHTML = `
      <div class="mn-dm-top">
        <div class="mn-dm-next">
          <span class="mn-dm-arrow"></span>
          <span class="mn-dm-words"><span class="mn-dm-dist"></span><span class="mn-dm-text"></span></span>
        </div>
        <div class="mn-dm-then" hidden></div>
        <p class="mn-dm-status" hidden></p>
        <p class="mn-dm-note" hidden></p>
      </div>
      <div class="mn-dm-foot">
        <button type="button" class="mn-dm-btn mn-dm-end" onclick="DriveMode.end()" title="Stop following the route (Escape)">✕ End</button>
        <div class="mn-dm-left"></div>
        <div class="mn-dm-tools"></div>
      </div>`;
    // Beside the map's container on its stage, not in it: a press here never
    // reaches either map.
    stage.appendChild(hud);
    paint(true);
  }

  // What the screen says, written only where it changed.
  function paint(all = false) {
    if (!d || !hud) return;
    hud.setAttribute('aria-label', `${d.mode === 'preview' ? 'Preview of the drive' : 'Driving'} to ${d.name}`);
    hud.classList.toggle('is-preview', d.mode === 'preview');
    const set = (sel, html, key) => {
      const el = hud.querySelector(sel);
      if (!el) return null;
      const k = key == null ? html : key;
      if (all || el.dataset.k !== k) { el.dataset.k = k; el.innerHTML = html; }
      return el;
    };
    const show = (sel, on) => { const el = hud.querySelector(sel); if (el) el.hidden = !on; };

    const g = guideNow();
    const next = hud.querySelector('.mn-dm-next');
    if (next) next.classList.toggle('is-arrived', d.arrived);
    set('.mn-dm-arrow', g.turn ? arrowSvg(g.turn) : '', g.turn ? JSON.stringify(g.turn) : '');
    set('.mn-dm-dist', esc(g.dist));
    set('.mn-dm-text', esc(g.text));
    set('.mn-dm-then', g.then ? `Then ${arrowSvg(g.then.turn)} <span>${esc(g.then.text)}</span>` : '', g.then ? `${g.then.text}|${JSON.stringify(g.then.turn)}` : '');
    show('.mn-dm-then', !!g.then);

    const st = statusNow();
    set('.mn-dm-status', st ? `${st.term ? term(st.term, st.label) : esc(st.label)}${st.more ? ` — ${esc(st.more)}` : ''}` : '', st ? `${st.label}|${st.more}` : '');
    show('.mn-dm-status', !!st);
    const now = performance.now();
    const note = d.note && now < d.note.until ? d.note.text : '';
    set('.mn-dm-note', esc(note));
    show('.mn-dm-note', !!note);

    const left = Math.max(0, d.path.total - d.s);
    const secs = secondsFrom(d.path, d.s);
    const eta = clock(Date.now() + secs * 1000);
    set('.mn-dm-left', d.arrived
      ? `<strong class="mn-dm-togo">Arrived</strong><span class="mn-dm-sub">${esc(d.name)}</span>`
      : `<strong class="mn-dm-togo">${esc(duration(secs))}</strong><span class="mn-dm-sub">${esc(fmtKm(left / 1000))} ${term('togo', 'to go')} · ${term('arrive', 'arrive')} ${esc(eta)}${
          d.mode === 'preview' ? ` · ${term('preview', 'preview')} ${d.x}×` : ''}</span>`,
      `${d.arrived}|${duration(secs)}|${fmtKm(left / 1000)}|${eta}|${d.mode}|${d.x}`);
    paintTools(all);
    measure();
  }

  // Where the road is in view: between the banner's foot and the foot's top.
  // The camera is padded so the car stands CAR_AT of the way down it (the
  // padded box's middle is where MapLibre puts the point it is centred on),
  // and the stations are named only inside it.
  function measure() {
    if (!d || !hud) return;
    const stage = hud.getBoundingClientRect();
    if (!stage.height) return;
    const banner = hud.querySelector('.mn-dm-next'), foot = hud.querySelector('.mn-dm-foot');
    const b = banner ? Math.max(0, banner.getBoundingClientRect().bottom - stage.top) : 0;
    const f = foot ? Math.max(0, stage.bottom - foot.getBoundingClientRect().top) : 0;
    const H = stage.height;
    const y = b + CAR_AT * Math.max(1, H - f - b);
    const pad = { top: Math.max(0, Math.round(2 * y - H + f)), bottom: Math.round(f) };
    if (!d.pad || d.pad.top !== pad.top || d.pad.bottom !== pad.bottom) { d.pad = pad; d.drawn = null; }
    d.band = { top: Math.round(b), bottom: Math.round(H - f) };
  }

  function paintTools(all = false) {
    if (!d || !hud) return;
    const el = hud.querySelector('.mn-dm-tools');
    if (!el) return;
    const key = `${d.mode}|${d.paused}|${d.x}|${d.voice}|${d.follow}|${d.arrived}`;
    if (!all && el.dataset.k === key) return;
    el.dataset.k = key;
    const had = el.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    const btn = (act, label, title, extra = '') =>
      `<button type="button" class="mn-dm-btn" data-act="${act}" onclick="DriveMode.act('${act}')" title="${esc(title)}" aria-label="${esc(title)}"${extra}>${label}</button>`;
    const out = [];
    if (d.mode === 'preview') {
      out.push(d.paused || d.arrived
        ? btn('play', '▶', d.arrived ? 'Play the preview again from the start' : 'Play the preview')
        : btn('pause', '⏸', 'Pause the preview'));
      out.push(btn('speed', `${d.x}×`, `Played at ${d.x} times the roads’ usual speeds — press for ${SPEEDS[(SPEEDS.indexOf(d.x) + 1) % SPEEDS.length]} times`));
      out.push(btn('skip', '⏭', 'On to just before the next turn'));
    }
    out.push(btn('voice', d.voice ? '🔊' : '🔇', d.voice ? 'Turns are said out loud — press to stop' : 'Turns are not said — press to have them said',
      ` aria-pressed="${d.voice}"`));
    out.push(d.follow
      ? btn('overview', '🗺️', 'The rest of the route from overhead')
      : btn('centre', '◎', 'Back to following the car'));
    el.innerHTML = out.join('');
    if (had) {
      const again = el.querySelector(`[data-act="${had}"]`) || el.querySelector('button');
      if (again) again.focus({ preventScroll: true });
    }
  }

  // The next thing to do, and how far it is: { dist, text, turn, then }.
  function guideNow() {
    if (d.arrived) return { dist: '', text: `You have arrived at ${d.name}.`, turn: { k: 'arrive', ang: 0 }, then: null };
    const i = d.items.findIndex(it => it.s > d.s + 2);
    const it = i >= 0 ? d.items[i] : d.items[d.items.length - 1];
    // Off the road past where the router could help: which way the station is.
    if (d.mode === 'gps' && d.fix && !d.fix.on && d.fix.past) {
      const b = bearingDeg(d.fix.lat, d.fix.lon, d.dest[0], d.dest[1]);
      const m = metres([d.fix.lat, d.fix.lon], d.dest);
      return { dist: navDist(m), text: `${d.name} is ${fmtKm(m / 1000)} ${compass(b)} of you, as the crow flies.`,
               turn: { k: 'gap', ang: wrap180(b - d.heading) }, then: null };
    }
    let turn = it.turn;
    // The last stretch nobody mapped: the arrow points at the station.
    if (it.kind === 'arrive' && kindAt(d.path, d.s) === 'gap') {
      turn = { k: 'gap', ang: wrap180(bearingDeg(d.pos[0], d.pos[1], d.dest[0], d.dest[1]) - d.heading) };
    }
    const after = i >= 0 ? d.items[i + 1] : null;
    const then = after && after.s - it.s <= THEN_M && it.kind !== 'arrive' ? { text: after.text, turn: after.turn } : null;
    return { dist: navDist(it.s - d.s), text: it.text, turn, then };
  }

  // A line under the banner when something is not as it should be.
  function statusNow() {
    if (d.rerouting) return { label: 'Working the route out again from here…', more: '' };
    if (d.rerouteErr) return { label: 'The route could not be worked out again', more: d.rerouteErr };
    if (d.mode === 'gps') {
      if (d.gpsErr) return { label: d.gpsErr, more: '' };
      const now = performance.now();
      if (!d.fix) return { label: 'Waiting for this phone to say where it is…', more: '' };
      if (now - d.lastFixAt > LOST_MS) return { label: 'Waiting for GPS…', more: `no position for ${Math.round((now - d.lastFixAt) / 1000)} s` };
      if (d.rough) return { label: `The position is only good to ±${Math.round(d.rough)} m`, more: 'not followed until it is better' };
      if (!d.fix.on) return { term: 'off', label: 'Off the route', more: d.fix.past ? 'past the road — the station’s way is above' : '' };
    }
    return null;
  }

  // ── Moving ─────────────────────────────────────────────────────────────────

  function loop() {
    if (raf || !d) return;
    d.t = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now) {
    raf = 0;
    if (!d) return;
    raf = requestAnimationFrame(frame);
    step(Math.min(0.25, Math.max(0, (now - d.t) / 1000)), now);
  }

  // One step of `dt` seconds: the car moved on, the camera put over it, and
  // every so often the words and the names looked at again. The check calls
  // this directly, so it runs the same with no frames at all.
  function step(dt, now = performance.now()) {
    if (!d) return;
    d.t = now;
    // The 3-D view gone from under the drive some other way than a render of
    // the tab (which attach() answers): it is opened again and its camera
    // taken, or the drive ends saying why (takeView).
    if (!d.opening && typeof Map3D !== 'undefined' && !Map3D.active()) {
      const my = d;
      d.opening = true;
      takeView().then(ok => { if (d === my) { d.opening = false; if (ok) { d.drawn = null; d.easeNext = true; } } });
    }
    move(dt, now);
    if (!d.follow && d.mode === 'gps' && now - d.freeAt > FREE_MS) recentre();
    if (now - d.lastDraw >= FRAME_MS) { d.lastDraw = now; draw(); }
    if (now - d.lastGuide >= GUIDE_MS) { d.lastGuide = now; guide(); paint(); }
    if (now - d.lastTags >= TAG_MS) { d.lastTags = now; nameStations(); }
  }

  function move(dt, now) {
    let want = null;
    if (d.mode === 'preview') {
      const v = speedAt(d.path, d.s);
      if (!d.paused && !d.arrived) d.s = Math.min(d.path.total, d.s + v * d.x * dt);
      d.speed = d.paused || d.arrived ? 0 : v;
      d.pos = pointAt(d.path, d.s);
      want = headingAt(d.path, d.s);
    } else if (d.fix) {
      const age = Math.min(2, Math.max(0, (now - d.fix.at) / 1000));
      if (d.fix.on) {
        const target = Math.min(d.path.total, d.fix.s + d.speed * age);
        if (Math.abs(target - d.s) > 250) d.s = target;
        else d.s += (target - d.s) * Math.min(1, dt * 3);
        d.pos = pointAt(d.path, d.s);
        want = headingAt(d.path, d.s);
      } else {
        let to = [d.fix.lat, d.fix.lon];
        if (d.fix.course != null && d.speed > 1.5) to = destPoint(to[0], to[1], d.fix.course, (d.speed * age) / 1000);
        const k = Math.min(1, dt * 3);
        d.pos = [d.pos[0] + (to[0] - d.pos[0]) * k, d.pos[1] + (to[1] - d.pos[1]) * k];
        want = d.fix.course;
      }
    }
    if (want != null && isFinite(want)) d.heading = (d.heading + wrap180(want - d.heading) * Math.min(1, dt * 3) + 360) % 360;
    const kmh = d.speed * 3.6;
    const z = ZOOM_SLOW - (ZOOM_SLOW - ZOOM_FAST) * clamp(kmh / FAST_KMH, 0, 1) + d.boost;
    d.zoom += (z - d.zoom) * Math.min(1, dt * 0.8);
  }

  // The camera over the car — only when something moved enough to see.
  function draw() {
    if (!d || !d.pos || typeof Map3D === 'undefined' || !Map3D.driveFrame) return;
    if (!d.pad) measure();
    const f = { lat: d.pos[0], lon: d.pos[1], heading: d.heading, follow: d.follow,
                bearing: d.heading, pitch: PITCH, zoom: d.zoom, pad: d.pad };
    const was = d.drawn;
    if (was && !d.easeNext && was.follow === f.follow && Math.abs(was.lat - f.lat) < 1e-7 && Math.abs(was.lon - f.lon) < 1e-7
        && Math.abs(wrap180(was.heading - f.heading)) < 0.05 && Math.abs(was.zoom - f.zoom) < 0.002) return;
    if (d.easeNext) { f.ease = true; d.easeNext = false; }
    if (Map3D.driveFrame(f)) d.drawn = f;
  }

  // The words: arriving, the next item, and what to say about it now.
  function guide() {
    if (d.arrived) return;
    const fixAtDest = d.mode === 'gps' && d.fix && d.fix.acc <= ROUGH_M
      && metres([d.fix.lat, d.fix.lon], d.dest) <= ARRIVE_M + Math.min(d.fix.acc, 30);
    if (d.s >= d.path.total - (d.mode === 'preview' ? 1 : ARRIVE_M) || fixAtDest) { arrive(); return; }
    const i = d.items.findIndex(it => it.s > d.s + 2);
    if (i < 0) return;
    const it = d.items[i];
    const dist = it.s - d.s;
    const v = d.speed;
    const nowM = clamp(v * NOW_S, NOW_MIN_M, NOW_MAX_M);
    const prepM = clamp(v * PREP_S, PREP_MIN_M, PREP_MAX_M);
    d.boost = dist < 250 && v * 3.6 < TURN_KMH && it.kind !== 'arrive' ? ZOOM_NEAR_TURN : 0;
    const said = d.said[i] || (d.said[i] = {});
    const moved = i !== d.lastNext;
    d.lastNext = i;
    if (it.kind === 'arrive' && dist <= nowM) return;   // arrive() says it
    if (dist <= nowM) {
      if (!said.now) { said.now = said.prep = said.far = true; speak(it.now || it.text); }
    } else if (dist <= prepM) {
      if (!said.prep && dist > nowM * 1.5 && it.prep) { said.prep = said.far = true; speak(it.prep.replace('{d}', spoken(dist))); }
    } else if (moved && !said.far && dist > FAR_M && performance.now() - d.lastSaid > 3000) {
      said.far = true;
      speak(`Continue for ${spoken(dist)}.`);
    }
  }

  function arrive() {
    d.arrived = true;
    d.boost = 0;
    if (d.mode === 'preview') d.paused = true;
    speak(`You have arrived at ${d.name}.`);
    paint();
  }

  // ── The phone's position ───────────────────────────────────────────────────

  function startGps() {
    if (!d || d.watch != null || typeof navigator === 'undefined' || !navigator.geolocation) return;
    d.watch = navigator.geolocation.watchPosition(onFix, onGpsError,
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }

  function stopGps(was) {
    if (was && was.watch != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(was.watch); } catch (_) { /* gone */ }
    }
    if (was) was.watch = null;
  }

  function onGpsError(e) {
    if (!d || d.mode !== 'gps') return;
    if (e && e.code === 1) {
      end({ why: 'This phone was not allowed to say where it is, so the drive cannot follow it. ▶ Preview plays the drive without it.' });
      return;
    }
    d.gpsErr = e && e.code === 3 ? 'Waiting for GPS…' : 'This phone could not say where it is.';
    paint();
  }

  function onFix(p) {
    if (!d || d.mode !== 'gps' || !p || !p.coords) return;
    const c = p.coords;
    const now = performance.now();
    d.gpsErr = '';
    d.lastFixAt = now;
    const acc = isFinite(c.accuracy) ? c.accuracy : 0;
    if (acc > ROUGH_M) { d.rough = acc; paint(); return; }
    d.rough = 0;
    const ll = [Number(c.latitude), Number(c.longitude)];
    if (!isFinite(ll[0]) || !isFinite(ll[1])) return;
    const prev = d.fix;
    let v = c.speed != null && isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
    if (v == null && prev) {
      const dt = (now - prev.at) / 1000;
      if (dt >= 0.5) v = metres([prev.lat, prev.lon], ll) / dt;
    }
    if (v != null) d.speed = prev ? d.speed * 0.5 + v * 0.5 : v;
    let course = c.heading != null && isFinite(c.heading) && d.speed > 1.5 ? c.heading : null;
    if (course == null && prev && metres([prev.lat, prev.lon], ll) > 8) course = bearingDeg(prev.lat, prev.lon, ll[0], ll[1]);
    const m = match(ll, acc);
    d.fix = { lat: ll[0], lon: ll[1], acc, at: now, s: m.s, d: m.d, on: m.on, past: m.past, course };
    if (!prev) {
      // The first: straight there, pointing along the route or the way it goes.
      d.s = m.on ? m.s : d.s;
      d.pos = m.on ? pointAt(d.path, m.s) : ll;
      d.heading = (m.on ? headingAt(d.path, m.s) : course) ?? d.heading;
      d.easeNext = true;
    }
    offRoute(m, ll, now);
    paint();
  }

  // Where the fix is on the route: { on, s, d, past }. `past` is off the
  // route beyond the road, where nothing routes the rest.
  function match(ll, acc) {
    const tol = ON_M + Math.min(acc || 0, 60);
    let m = project(d.path, ll, d.s - 60, d.s + Math.max(1500, d.speed * 90));
    if (!m || m.d > tol) {
      const all = project(d.path, ll);
      if (all && all.d <= tol) m = all;
      else {
        const s = all ? all.s : d.s;
        return { on: false, s, d: all ? all.d : Infinity, past: s > roadEnd() + 1 };
      }
    }
    return { on: true, s: m.s, d: m.d, past: false };
  }

  function roadEnd() {
    const road = d.path.legs.find(l => l.kind === 'road');
    return road ? road.e : 0;
  }

  function offRoute(m, ll, now) {
    if (m.on) { d.off = 0; return; }
    if (!d.off) d.off = now;
    if (m.past || d.arrived) return;
    if (d.rerouting || now - d.off < OFF_MS || now - d.lastReroute < REROUTE_MS) return;
    d.rerouting = true;
    d.rerouteErr = '';
    d.lastReroute = now;
    speak('Off the route. Working it out again from here.');
    if (typeof MapDrive !== 'undefined' && MapDrive.reroute) MapDrive.reroute({ lat: ll[0], lon: ll[1], acc: d.fix ? d.fix.acc : 0 });
  }

  // ── The route, changed under the drive ─────────────────────────────────────
  // map-drive.js says so after every draw: a route asked for again from here,
  // the same route drawn again on a map built new, or the route taken away.
  function routeChanged() {
    if (!d) return;
    const p = typeof MapDrive !== 'undefined' && MapDrive.plan ? MapDrive.plan() : null;
    if (!p || p.stationId !== d.stationId) {
      end({ why: 'The route was taken off the map, so the drive has ended.' });
      return;
    }
    if (p.status === 'error') {
      if (d.rerouting) { d.rerouting = false; d.rerouteErr = p.error || 'the route service did not answer'; announce(`The route could not be worked out again: ${d.rerouteErr}`); paint(); }
      return;
    }
    if (p.status !== 'ok' || !p.legs.length) return;    // the old route is followed until the new one comes
    if (sameLegs(p.legs, d.plan.legs)) { d.rerouting = false; return; }
    const path = buildPath(p.legs);
    if (!path) return;
    const items = buildItems(p, path);
    timePath(path, items);
    d.plan = { ...p, start: null };
    d.path = path;
    d.items = items;
    d.said = {};
    d.lastNext = -1;
    d.off = 0;
    d.rerouting = false;
    d.rerouteErr = '';
    d.arrived = false;
    if (d.fix) {
      const m = match([d.fix.lat, d.fix.lon], d.fix.acc);
      d.s = m.on ? m.s : 0;
      d.fix = { ...d.fix, s: m.s, d: m.d, on: m.on, past: m.past };
    } else {
      d.s = 0;
    }
    if (typeof Map3D !== 'undefined' && Map3D.routeChanged) Map3D.routeChanged();
    speak(`New route: ${spoken(Math.max(0, path.total - d.s))}, about ${spokenDuration(secondsFrom(path, d.s))}.`);
    paint();
  }

  function sameLegs(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((l, k) => l.kind === b[k].kind && l.pts.length === b[k].pts.length
      && l.pts[0][0] === b[k].pts[0][0] && l.pts[0][1] === b[k].pts[0][1]
      && l.pts[l.pts.length - 1][0] === b[k].pts[b[k].pts.length - 1][0]
      && l.pts[l.pts.length - 1][1] === b[k].pts[b[k].pts.length - 1][1]);
  }

  // ── The stations named ─────────────────────────────────────────────────────

  function shortKm(km) {
    if (km < 1) return `${Math.max(10, Math.round(km * 100) * 10)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  }

  function nameStations() {
    if (!d || !d.pos || typeof Map3D === 'undefined' || !Map3D.driveTags) return;
    const [lat, lon] = d.pos;
    const kx = kmPerDegLon(lat);
    const near = [];
    for (const m of state.mapMarkers || []) {
      const id = m.mnStationId;
      if (id == null || id === d.stationId || typeof m.getLatLng !== 'function') continue;
      const ll = m.getLatLng();
      const dx = (ll.lng - lon) * kx, dy = (ll.lat - lat) * KM_PER_DEG_LAT;
      if (Math.abs(dx) > TAG_KM || Math.abs(dy) > TAG_KM) continue;
      const km = Math.hypot(dx, dy);
      if (km > TAG_KM) continue;
      const b = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      if (km > TAG_NEAR_KM && Math.abs(wrap180(b - d.heading)) > TAG_CONE) continue;
      near.push({ id, lat: ll.lat, lon: ll.lng, km, name: (m.mnStation && m.mnStation.name) || String(id) });
    }
    near.sort((a, b) => a.km - b.km);
    const list = near.slice(0, TAG_LOOK);
    const destKm = metres(d.pos, d.dest) / 1000;
    if (destKm <= DEST_KM) list.unshift({ id: d.stationId, lat: d.dest[0], lon: d.dest[1], km: destKm, name: d.name, dest: true });
    const offer = list.map(t => ({ id: t.id, lat: t.lat, lon: t.lon, name: t.name, dist: shortKm(t.km), dest: !!t.dest }));
    const band = d.band || {};
    d.tags = Map3D.driveTags(offer, { max: TAG_MAX, top: band.top, bottom: band.bottom }) || [];
  }

  // ── The buttons ────────────────────────────────────────────────────────────

  function onGesture() {
    if (!d) return;
    d.freeAt = performance.now();
    if (d.follow) { d.follow = false; paintTools(); }
  }

  function recentre() {
    if (!d) return;
    d.follow = true;
    d.easeNext = true;
    d.drawn = null;
    paintTools();
  }

  function act(what) {
    if (!d) return;
    if (what === 'voice') {
      d.voice = !d.voice;
      store(VOICE_KEY, d.voice ? 'on' : 'off');
      if (!d.voice) hush();
      announce(d.voice ? 'Turns will be said out loud.' : 'Turns will not be said out loud.');
    } else if (what === 'overview') {
      d.follow = false;
      d.freeAt = performance.now();
      const i = vertexAt(d.path, d.s);
      const pts = [d.pos].concat(d.path.pts.slice(i + 1));
      if (typeof Map3D !== 'undefined' && Map3D.driveOverview) Map3D.driveOverview(pts);
      announce('The rest of the route, from overhead. ◎ goes back to the car.');
    } else if (what === 'centre') {
      recentre();
    } else if (d.mode === 'preview' && what === 'pause') {
      d.paused = true;
    } else if (d.mode === 'preview' && what === 'play') {
      if (d.arrived) { d.arrived = false; d.s = 0; d.said = {}; d.lastNext = -1; d.easeNext = true; }
      d.paused = false;
    } else if (d.mode === 'preview' && what === 'speed') {
      d.x = SPEEDS[(SPEEDS.indexOf(d.x) + 1) % SPEEDS.length];
      store(SPEED_KEY, d.x);
      announce(`The preview plays at ${d.x} times the roads’ usual speeds.`);
    } else if (d.mode === 'preview' && what === 'skip') {
      const it = d.items.find(x => x.s > d.s + 2);
      if (it) {
        const lead = Math.max(60, speedAt(d.path, it.s) * 6);
        d.s = Math.max(d.s, it.s - lead);
        d.drawn = null;
      }
    }
    paint();
  }

  // ── Kept awake ─────────────────────────────────────────────────────────────

  function holdWake() {
    if (!visHandler) {
      visHandler = () => { if (d && document.visibilityState === 'visible') holdWake(); };
      document.addEventListener('visibilitychange', visHandler);
    }
    if (typeof navigator === 'undefined' || !navigator.wakeLock || wake || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(w => {
      if (!d) { w.release().catch(() => {}); return; }
      wake = w;
      w.addEventListener('release', () => { if (wake === w) wake = null; });
    }, () => { /* refused: the screen sleeps as it would */ });
  }

  function releaseWake() {
    if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
    if (wake) wake.release().catch(() => {});
    wake = null;
  }

  // ── The pills ──────────────────────────────────────────────────────────────
  // On the route panel, once the route is worked out: 🚘 Drive on a phone or a
  // tablet — a desk's position is the office network's guess, and nobody
  // drives one — and ▶ Preview everywhere.
  function pillsHtml() {
    const out = [];
    if (handheld()) {
      out.push(`<button type="button" class="pill mn-dm-pill" data-mode="gps" onclick="DriveMode.start('gps')"
        title="Follow the route as you drive, in 3-D: the road ahead turning with you, the next turn said and shown, and the stations around you named">${pillText('🚘', 'Drive')}</button>`);
    }
    out.push(`<button type="button" class="pill mn-dm-pill" data-mode="preview" onclick="DriveMode.start('preview')"
      title="Play the drive along the route in 3-D, at the roads’ usual speeds sped up — without using where you are">${pillText('▶', `Preview${pillLong(' the drive')}`)}</button>`);
    return out.join('');
  }

  return {
    WORDS,
    start, end, act, pillsHtml, routeChanged,
    active: () => !!d,

    // The route the drive is following, for the 3-D view to drape while it
    // does (map-3d.js routePlan) — the old one, while a new one is asked for.
    plan: () => (d ? { ...d.plan, legs: d.plan.legs.map(l => ({ ...l, pts: l.pts.map(p => p.slice()) })) } : null),

    // The Stations map, built or rebuilt. A drive under way is put back on it:
    // its screen on the new stage, the 3-D view opened again (a rebuild
    // closes it), and the camera taken.
    attach(m) {
      leaflet = m;
      if (!d) return;
      const my = d;
      enterScreen();
      takeView().then(ok => { if (ok && d === my) { d.drawn = null; d.easeNext = true; loop(); } });
    },

    // …and taken down. The drive goes on — its position, its words — and
    // waits for the next map: leaving the tab ends it (app.js's teardown).
    detach() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (hud) hud.remove();
      hud = null;
      leaflet = null;
    },

    // Read by the check and by nothing else.
    _state() {
      if (!d) return null;
      const g = guideNow();
      return {
        mode: d.mode, s: d.s, total: d.path.total, pos: d.pos.slice(), heading: d.heading, speed: d.speed, zoom: d.zoom,
        follow: d.follow, arrived: d.arrived, paused: d.paused, x: d.x, voice: d.voice, rerouting: d.rerouting,
        rerouteErr: d.rerouteErr, fix: d.fix ? { ...d.fix } : null, off: !!d.off, opened3d: d.opened3d,
        next: { dist: g.dist, text: g.text, turn: g.turn, then: g.then },
        items: d.items.map(it => ({ s: it.s, kind: it.kind, text: it.text, turn: it.turn })),
        tags: (d.tags || []).map(t => ({ ...t })),
        left: secondsFrom(d.path, d.s),
      };
    },
    _step: (dt, now) => step(dt, now),
    _at(s) { if (d) { d.s = clamp(s, 0, d.path.total); if (d.s < d.path.total - 1) d.arrived = false; d.drawn = null; } },
    _buildPath: buildPath,
    _turnFor: turnFor,
  };
})();
if (typeof window !== 'undefined') window.DriveMode = DriveMode;
