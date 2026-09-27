// MegaNet — twin-presence.js
//
//   TwinPresence   who else is standing in this station's digital twin: a room
//                  per station on Supabase Realtime, an avatar for each visitor
//                  in it, their poses a few times a second — so two people
//                  looking at one site see each other walk about in it, and
//                  see what the other one is pointing at.
//
// After digital-twin.js, whose scene the avatars stand in, and before
// map-twin.js. Reaches back to core.js for DB_ORIGIN, DB_ANON_KEY,
// DB_PROXY_PATH, dbProxyAvailable and esc; across to auth.js for the signed-in
// email (its local part is the name, as the header already shows it) and to
// digital-twin.js for the avatar seams (DigitalTwin.remote.*). Every one of
// those is a runtime call from inside a function, so the position among the
// modules is free; nothing executes at load (`npm run toplevel`).
//
// ── The room ──────────────────────────────────────────────────────────────────
//
// Supabase Realtime is a Phoenix server the project already has: no table, no
// migration, no server of ours. One WebSocket, one channel per station
// (`realtime:twin:<station id>`), two of its three features: *presence* — who
// is in the room, with the name and the colours they chose, kept by the server
// and told to everyone as they come and go — and *broadcast* — the poses,
// fanned out to the others and kept by nobody. The protocol is a hundred lines
// of JSON and is written here rather than fetched as a library: frames are
// `{topic, event, payload, ref, join_ref}` (protocol version 1.0.0), a join is
// `phx_join` with the channel's config, a heartbeat every twenty seconds on
// the `phoenix` topic keeps the socket alive, and the server's own events are
// `presence_state` (the whole room, on joining), `presence_diff` (joins and
// leaves since) and `broadcast` (someone's pose). All of it verified live
// against the project before it was written down.
//
// ── The wire, and who may listen ─────────────────────────────────────────────
//
// The socket goes the way every other database call goes (core.js, "which way
// round to the database"): through the site's own Worker where there is one
// (`/api/db/realtime/v1`, which worker/index.js carries with the WebSocket
// upgrade), and to the project directly everywhere else. The channel is a
// public one, joined with the project's publishable key, so what goes into it
// is what anyone holding that key could read: a chosen name — the local part
// of a signed-in address, or "Visitor 417" — three colours, and metres from
// the station. Never the address itself, never the session token, never a
// coordinate on the Earth (the station is the origin, and which station is in
// the channel's name that any visitor to the page can see anyway).
//
// And what a public room cannot promise: a pose is written by the client that
// sends it, and a presence key is chosen by the client that joins, so someone
// holding the key could move another visitor's figure or wear another name.
// Nothing is at stake in that beyond a prank — a figure's place on a patch of
// ground — and it is the trade for a room that needs no sign-in; a private
// channel with row-level security is the next step if it ever matters. What
// the client does promise is to be unbothered by it: every field of every
// frame is checked and bounded before it is used, names are cut to length
// and escaped where they are written, and figures are built for at most
// ROOM_CAP visitors however many keys the room reports.
//
// ── The budget ────────────────────────────────────────────────────────────────
//
// The project's plan allows a hundred messages a second across everything,
// and a pose sent to a room of N is N − 1 messages. So a pose goes out at
// most four times a second, and only when it changed — a visitor standing
// still costs a keep-alive every five seconds — and past four others in the
// room a visitor listens without publishing (the line under the stage says
// so): five people walking at once are five senders to four receivers four
// times a second, eighty messages, inside the budget with room for the
// heartbeats. The cap is what keeps a busy day from silencing the readings
// the same project serves; figures are drawn for up to eight, so a visitor
// who is listening still sees who is there.
const TwinPresence = (function () {
  const KEY_AVATAR   = 'mn-twin-avatar';     // { hat, shirt, pants } as chosen
  const KEY_VISITOR  = 'mn-twin-visitor';    // one id per browser, made once
  const KEY_ENABLED  = 'mn-twin-presence';   // 'off' to explore alone
  const SEND_HZ      = 4;                    // poses a second, at most
  const KEEPALIVE_MS = 5000;                 // a pose that did not change, this often
  const HEARTBEAT_MS = 20000;                // the socket's own keep-alive
  const ROOM_CAP     = 4;                    // more others than this: listen, do not publish
  const FIGURE_CAP   = 8;                    // figures drawn, however many keys the room reports
  const BACKOFF_S    = [1, 2, 5, 10];        // reconnect waits after a dropped socket
  const MOVE_EPS     = 0.05;                 // metres before a pose counts as changed
  const TURN_EPS     = 0.02;                 // radians, likewise
  const STALE_MS     = 15000;                // a peer whose last pose is older stops being drawn

  // Six hats, six shirts, six pairs of trousers: the defaults are picked from
  // these by the visitor's id, so a person is the same figure every visit
  // until they choose otherwise.
  const HATS   = ['#ffd400', '#ffffff', '#ff7a1a', '#2f80d6', '#e03030', '#2e9e4f'];
  const SHIRTS = ['#ff6a00', '#e8e800', '#2f80d6', '#e03030', '#2e9e4f', '#8a8f96'];
  const PANTS  = ['#1f2a44', '#8a7a52', '#5b6168', '#202224', '#5a3d2b', '#2e4d2e'];

  const st = {
    enabled: true,
    station: null, topic: null,
    ws: null, joinRef: null, ref: 0,
    pending: new Map(),        // ref → callback for its phx_reply
    status: 'off',             // 'off' | 'connecting' | 'joined' | 'retrying' | 'alone'
    why: '',                   // for 'alone': what stopped it, in the notes' own words
    key: null,                 // this tab's presence key
    uid: null,                 // this browser's id (or the signed-in user's)
    name: '',
    colours: null,
    peers: new Map(),          // key → { key, name, hat, shirt, pants, uid, pose, at }
    hb: 0, hbMissed: 0,
    retry: 0, retryTimer: 0,
    flushTimer: 0,
    lastSent: null, lastSentAt: 0, sent: 0, received: 0,
    closing: false,
  };

  // ── settings and identity ──────────────────────────────────────────────────
  function readEnabled() {
    try { return localStorage.getItem(KEY_ENABLED) !== 'off'; } catch (_) { return true; }
  }
  function uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
  function visitorId() {
    let v = null;
    try { v = localStorage.getItem(KEY_VISITOR); } catch (_) {}
    if (!v) { v = uuid(); try { localStorage.setItem(KEY_VISITOR, v); } catch (_) {} }
    return v;
  }
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }
  function isHex(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }
  function defaultColours(id) {
    const h = hash(id);
    return { hat: HATS[h % HATS.length], shirt: SHIRTS[(h >>> 4) % SHIRTS.length], pants: PANTS[(h >>> 8) % PANTS.length] };
  }
  function loadColours() {
    const d = defaultColours(visitorId());
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY_AVATAR) || '{}') || {}; } catch (_) { s = {}; }
    return { hat: isHex(s.hat) ? s.hat.toLowerCase() : d.hat, shirt: isHex(s.shirt) ? s.shirt.toLowerCase() : d.shirt, pants: isHex(s.pants) ? s.pants.toLowerCase() : d.pants };
  }
  function saveColours() {
    try { localStorage.setItem(KEY_AVATAR, JSON.stringify(st.colours)); } catch (_) {}
  }
  // The name: the local part of a signed-in address (auth.js's own rule for
  // the header), else a visitor number that is the same every visit.
  function displayName() {
    const email = typeof Auth !== 'undefined' && Auth.email ? Auth.email() : null;
    if (email && email.includes('@')) return email.split('@')[0].slice(0, 24);
    return `Visitor ${100 + (hash(visitorId()) % 900)}`;
  }
  function signedIn() { return typeof Auth !== 'undefined' && Auth.isSignedIn ? !!Auth.isSignedIn() : false; }
  function identity() {
    if (!st.colours) st.colours = loadColours();
    st.name = displayName();
    st.uid = visitorId();
  }

  // ── the wire ───────────────────────────────────────────────────────────────
  function realtimeUrl() {
    const proxied = typeof dbProxyAvailable === 'function' && dbProxyAvailable();
    const base = proxied ? `${location.origin}${DB_PROXY_PATH}` : DB_ORIGIN;
    return `${base.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(DB_ANON_KEY)}&vsn=1.0.0`;
  }
  function send(topic, event, payload, joinRef) {
    if (!st.ws || st.ws.readyState !== 1) return null;
    const ref = String(++st.ref);
    const frame = { topic, event, payload, ref };
    if (joinRef) frame.join_ref = joinRef;
    try { st.ws.send(JSON.stringify(frame)); } catch (_) { return null; }
    return ref;
  }

  function setStatus(status, why = '') {
    st.status = status;
    st.why = why;
    changed();
  }
  function changed() {
    if (typeof DigitalTwin !== 'undefined' && DigitalTwin.presenceChanged) {
      try { DigitalTwin.presenceChanged(); } catch (_) {}
    }
  }

  // Any socket there is goes first: its close is then nobody's business, and
  // a retry never leaves two open.
  function dropSocket() {
    const ws = st.ws;
    st.ws = null;
    st.joinRef = null;
    st.pending.clear();
    stopHeartbeat();
    if (ws) { try { ws.close(); } catch (_) {} }
  }
  // The room's memory of who is there goes with the socket: a rejoin gets
  // the whole room again from presence_state, and a figure standing where
  // someone was ten seconds ago is a wrong answer.
  function forgetPeers() {
    st.peers.clear();
    remote('clear');
  }

  function connect() {
    dropSocket();
    let ws;
    try { ws = new WebSocket(realtimeUrl()); } catch (err) {
      setStatus('alone', `this browser could not open a socket (${(err && err.message) || err})`);
      return;
    }
    st.ws = ws;
    st.closing = false;
    setStatus('connecting');
    ws.onopen = () => {
      if (st.ws !== ws) return;
      st.retry = 0;
      const ref = send(st.topic, 'phx_join', {
        config: { broadcast: { self: false, ack: false }, presence: { enabled: true, key: st.key }, private: false },
        access_token: DB_ANON_KEY,
      });
      st.joinRef = ref;
      st.pending.set(ref, r => {
        if (r && r.status === 'ok') joined();
        else {
          // A refusal is not a dropped socket: no retry, and the reason on
          // the line under the stage.
          const reason = r && r.response ? (r.response.reason || JSON.stringify(r.response)) : 'no reply';
          st.closing = true;
          try { ws.close(); } catch (_) {}
          setStatus('alone', `the room refused the join (${String(reason).slice(0, 80)})`);
        }
      });
      startHeartbeat();
    };
    ws.onmessage = e => {
      if (st.ws !== ws) return;
      let m = null;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m) handle(m);
    };
    ws.onerror = () => {};   // onclose follows, and says what it can
    ws.onclose = ev => {
      if (st.ws !== ws) return;
      stopHeartbeat();
      st.ws = null;
      st.joinRef = null;
      st.pending.clear();
      forgetPeers();
      if (st.closing || !st.station) { if (st.status !== 'alone') setStatus('off'); return; }
      scheduleRetry(`the socket closed (${ev && ev.code ? ev.code : 'no code'})`);
    };
  }

  function scheduleRetry(why) {
    clearTimeout(st.retryTimer);
    if (st.retry >= BACKOFF_S.length) {
      setStatus('alone', `the room could not be reached — ${why}`);
      return;
    }
    const wait = BACKOFF_S[st.retry++];
    setStatus('retrying', why);
    st.retryTimer = setTimeout(() => { st.retryTimer = 0; if (st.station) connect(); }, wait * 1000);
  }

  function startHeartbeat() {
    stopHeartbeat();
    st.hbMissed = 0;
    st.hb = setInterval(() => {
      if (!st.ws || st.ws.readyState !== 1) return;
      if (st.hbMissed >= 2) { try { st.ws.close(); } catch (_) {} return; }
      st.hbMissed++;
      const ref = send('phoenix', 'heartbeat', {});
      if (ref) st.pending.set(ref, () => { st.hbMissed = 0; });
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() { clearInterval(st.hb); st.hb = 0; }

  function handle(m) {
    if (m.event === 'phx_reply') {
      const cb = st.pending.get(m.ref);
      if (cb) { st.pending.delete(m.ref); cb(m.payload || {}); }
      return;
    }
    if (m.topic !== st.topic) return;
    st.received++;
    switch (m.event) {
      case 'presence_state':
        st.peers.clear();
        remote('clear');
        applyJoins(m.payload || {});
        changed();
        break;
      case 'presence_diff': {
        // A visitor who re-tracks (a new colour) is a leave and a join of the
        // same key in one diff: the leave goes first, and a key that is in
        // both is an update, not a departure.
        const joins = (m.payload && m.payload.joins) || {}, leaves = (m.payload && m.payload.leaves) || {};
        applyLeaves(leaves, joins);
        applyJoins(joins);
        changed();
        break;
      }
      case 'broadcast':
        if (m.payload && m.payload.event === 'pose') onPose(m.payload.payload);
        break;
      case 'phx_error':
        forgetPeers();
        scheduleRetry('the room errored');
        break;
      case 'phx_close':
        // The server shut the channel — after our own leave that is the
        // expected end; otherwise it is a room to rejoin.
        if (!st.closing && st.station) { forgetPeers(); scheduleRetry('the room was closed'); }
        break;
      default: break;
    }
  }

  function applyJoins(joins) {
    for (const key of Object.keys(joins)) {
      if (key === st.key || typeof key !== 'string' || key.length > 128) continue;
      const metas = (joins[key] && Array.isArray(joins[key].metas)) ? joins[key].metas : [];
      const meta = metas[metas.length - 1] || {};
      const peer = st.peers.get(key) || { key, pose: null, at: 0, drawn: false };
      peer.name = String(meta.name || 'Visitor').replace(/[\u0000-\u001f]/g, '').slice(0, 24) || 'Visitor';
      peer.hat = isHex(meta.hat) ? meta.hat.toLowerCase() : HATS[0];
      peer.shirt = isHex(meta.shirt) ? meta.shirt.toLowerCase() : SHIRTS[0];
      peer.pants = isHex(meta.pants) ? meta.pants.toLowerCase() : PANTS[0];
      st.peers.set(key, peer);
      // A figure for the first ROOM_CAP of them; the rest are a count on the
      // line, so a room flooded with keys costs no more than eight figures.
      const drawnCount = [...st.peers.values()].filter(p => p.drawn).length;
      if (peer.drawn || drawnCount < FIGURE_CAP) {
        peer.drawn = true;
        remote('set', key, { name: peer.name, hat: peer.hat, shirt: peer.shirt, pants: peer.pants });
      }
    }
  }
  function applyLeaves(leaves, joins = {}) {
    for (const key of Object.keys(leaves)) {
      if (key === st.key || Object.prototype.hasOwnProperty.call(joins, key)) continue;
      st.peers.delete(key);
      remote('remove', key);
    }
  }
  function onPose(p) {
    if (!p || typeof p !== 'object' || !p.key || p.key === st.key) return;
    const peer = st.peers.get(p.key);
    if (!peer) return;
    if (typeof p.x !== 'number' || typeof p.z !== 'number' || Math.abs(p.x) > 1e5 || Math.abs(p.z) > 1e5) return;
    const pose = {
      mode: p.mode === 'walk' ? 'walk' : 'orbit',
      x: num(p.x), z: num(p.z), yaw: num(p.yaw), pitch: num(p.pitch),
      level: ['ground', 'ladder', 'deck'].includes(p.level) ? p.level : 'ground',
      climb: num(p.climb), point: !!p.point,
    };
    peer.pose = pose;
    peer.at = Date.now();
    remote('pose', p.key, pose);
  }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  function remote(op, key, arg) {
    if (typeof DigitalTwin === 'undefined' || !DigitalTwin.remote) return;
    try {
      if (op === 'set') DigitalTwin.remote.set(key, arg);
      else if (op === 'pose') DigitalTwin.remote.pose(key, arg);
      else if (op === 'remove') DigitalTwin.remote.remove(key);
      else if (op === 'clear') DigitalTwin.remote.clear();
    } catch (_) {}
  }

  function joined() {
    setStatus('joined');
    track();
  }
  function track() {
    if (st.status !== 'joined' || !st.joinRef) return;
    send(st.topic, 'presence', {
      type: 'presence', event: 'track',
      payload: { name: st.name, hat: st.colours.hat, shirt: st.colours.shirt, pants: st.colours.pants, since: new Date().toISOString() },
    }, st.joinRef);
  }

  // ── the poses ──────────────────────────────────────────────────────────────
  function moved(a, b) {
    if (!a || !b) return true;
    return a.mode !== b.mode || a.level !== b.level || !!a.point !== !!b.point
      || Math.abs(a.x - b.x) > MOVE_EPS || Math.abs(a.z - b.z) > MOVE_EPS || Math.abs(a.climb - b.climb) > MOVE_EPS
      || Math.abs(a.yaw - b.yaw) > TURN_EPS || Math.abs(a.pitch - b.pitch) > TURN_EPS;
  }
  // Called every frame by the twin with the visitor's own pose; what leaves is
  // gated here: at most SEND_HZ a second, only when it changed, a keep-alive
  // otherwise, nothing at all past the room cap.
  function spectating() { return st.status === 'joined' && st.peers.size > ROOM_CAP; }
  function publish(pose) {
    if (st.status !== 'joined' || !pose) return;
    if (spectating()) return;
    const now = Date.now();
    const change = moved(st.lastSent, pose);
    const gap = now - st.lastSentAt;
    if (!change && gap < KEEPALIVE_MS) return;
    if (change && gap < 1000 / SEND_HZ) {
      // Too soon: the latest pose goes when the gap has passed, so a visitor
      // who stops moving is seen where they stopped.
      st.queued = pose;
      if (!st.flushTimer) st.flushTimer = setTimeout(() => { st.flushTimer = 0; const q = st.queued; st.queued = null; if (q) publish(q); }, 1000 / SEND_HZ - gap + 5);
      return;
    }
    const out = { key: st.key, mode: pose.mode, x: round(pose.x), z: round(pose.z), yaw: round(pose.yaw, 3), pitch: round(pose.pitch, 3),
                  level: pose.level, climb: round(pose.climb), point: !!pose.point };
    if (send(st.topic, 'broadcast', { type: 'broadcast', event: 'pose', payload: out }, st.joinRef)) {
      st.lastSent = { ...pose };
      st.lastSentAt = now;
      st.sent++;
    }
  }
  function round(v, dp = 2) { const k = Math.pow(10, dp); return Math.round((Number(v) || 0) * k) / k; }

  // ── in and out of the room ─────────────────────────────────────────────────
  function join(stationId) {
    st.enabled = readEnabled();
    identity();
    if (!st.enabled) { leave(); setStatus('off'); return; }
    if (!stationId) return;
    if (st.station === stationId && st.ws && st.ws.readyState <= 1) { resync(); return; }
    leave();
    st.station = stationId;
    st.topic = `realtime:twin:${stationId}`;
    st.key = uuid();
    st.retry = 0;
    st.lastSent = null; st.lastSentAt = 0;
    connect();
  }

  // The scene was rebuilt under a room still joined: every figure is built
  // again from what the room said, and stood where its last pose put it.
  function resync() {
    for (const peer of st.peers.values()) {
      if (!peer.drawn) continue;
      remote('set', peer.key, { name: peer.name, hat: peer.hat, shirt: peer.shirt, pants: peer.pants });
      if (peer.pose) remote('pose', peer.key, peer.pose);
    }
    changed();
  }

  function leave() {
    clearTimeout(st.retryTimer); st.retryTimer = 0;
    clearTimeout(st.flushTimer); st.flushTimer = 0; st.queued = null;
    stopHeartbeat();
    const ws = st.ws;
    st.closing = true;
    if (ws) {
      if (ws.readyState === 1 && st.joinRef) send(st.topic, 'phx_leave', {}, st.joinRef);
      st.ws = null;
      try { ws.close(); } catch (_) {}
    }
    st.pending.clear();
    st.joinRef = null;
    st.station = null; st.topic = null; st.key = null;
    st.peers.clear();
    remote('clear');
    if (st.status !== 'off') setStatus('off');
  }

  // ── what the panels show ───────────────────────────────────────────────────
  function names() {
    const now = Date.now();
    return [...st.peers.values()].map(p => ({ name: p.name, drawn: !!p.drawn, here: !!(p.pose && p.pose.mode === 'walk' && now - p.at < STALE_MS) }));
  }
  function lineHtml() {
    if (!st.enabled || st.status === 'off') return '';
    const e = typeof esc === 'function' ? esc : (s => String(s));
    if (st.status === 'connecting' || st.status === 'retrying') return '<span class="twin-peers-lead">👥</span> Looking for others here…';
    if (st.status === 'alone') return `<span class="twin-peers-lead">👥</span> Exploring alone — ${e(st.why || 'the room could not be reached')}.`;
    const list = names();
    if (!list.length) return `<span class="twin-peers-lead">👥</span> Only you here so far — others would see you as <strong>${e(st.name)}</strong>.`;
    // The ones with a figure by name, the rest as a count.
    const shown = list.filter(p => p.drawn).slice(0, FIGURE_CAP), more = list.length - shown.length;
    const who = shown.map(p => `<strong>${e(p.name)}</strong>${p.here ? '' : ' <span class="twin-peers-fact">(looking on)</span>'}`).join(' · ');
    return `<span class="twin-peers-lead">👥 With you:</span> ${who}${more ? ` <span class="twin-peers-fact">and ${more} more</span>` : ''}${spectating() ? ' <span class="twin-peers-fact">— a full room, so you are listening only</span>' : ''}`;
  }

  return {
    join, leave, publish, track,
    setEnabled(on) {
      st.enabled = !!on;
      try { localStorage.setItem(KEY_ENABLED, on ? 'on' : 'off'); } catch (_) {}
      if (!on) { leave(); setStatus('off'); }
      else if (typeof DigitalTwin !== 'undefined' && DigitalTwin.debug) {
        const d = DigitalTwin.debug();
        if (d.built && d.stationId) join(d.stationId);
      }
    },
    enabled() { return readEnabled(); },
    setAvatar(patch) {
      if (!st.colours) st.colours = loadColours();
      for (const k of ['hat', 'shirt', 'pants']) if (patch && isHex(patch[k])) st.colours[k] = patch[k].toLowerCase();
      saveColours();
      if (st.status === 'joined') track();
      changed();
    },
    avatar() { identity(); return { name: st.name, signedIn: signedIn(), ...st.colours }; },
    peers() { return [...st.peers.values()].map(p => ({ ...p })); },
    status() { return st.status; },
    lineHtml,
    debug() {
      identity();
      return {
        enabled: st.enabled, status: st.status, why: st.why, station: st.station, topic: st.topic, key: st.key,
        name: st.name, uid: st.uid, colours: { ...st.colours }, url: realtimeUrl(),
        peers: [...st.peers.values()].map(p => ({ key: p.key, name: p.name, hat: p.hat, shirt: p.shirt, pants: p.pants, pose: p.pose, drawn: !!p.drawn })),
        sent: st.sent, received: st.received, spectating: spectating(), open: !!(st.ws && st.ws.readyState === 1),
        hz: SEND_HZ, cap: ROOM_CAP, figureCap: FIGURE_CAP,
      };
    },
  };
})();
if (typeof window !== 'undefined') window.TwinPresence = TwinPresence;
