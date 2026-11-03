// MegaNet — explainers.js
//
//   Explainers   🎬 Videos, under Start here: short drawn videos about
//                Flood-Net itself — a welcome for a first look or a meeting
//                room, then how-tos that each show one job (EPIC #262, #263).
//                Drawn and voiced the way the 📺 Network Bulletin is: the same
//                player (makeShowPlayer, health-bulletin.js), the same
//                Droggies, the same stage — a scene a few seconds long, drawn
//                as SVG from a small file, its words revealed as they are
//                said.
//
// After core.js (TAB_LIST, TABS, tabShown, esc, escAttr, termHtml, announce,
// state), app.js (switchTab, goToStation) and health-bulletin.js
// (makeShowPlayer, which must be loaded first: the player is made here, at
// load). toast.js at call time. renderMain() calls render() and init(); init.js
// calls restoreFromUrl() once, after the first render.
//
// ── Where a video comes from ────────────────────────────────────────────────
// data/explainers/<id>.json, listed in data/explainers/index.json — written by
// hand (or by an agent) to tools/explainers/README.md, and checked by
// tools/explainers/validate.mjs. A file is a draft ("voice": "draft") until the
// owner has read its words and said yes; a draft plays silent, on its scenes'
// own seconds. Marked "final", the voice workflow (bulletin-voice.yml, with
// tools/voice/speak.mjs) has it said by the Droggies' cast and writes
// data/explainers/voice/<id>.json and .mp3 beside it — a scene at a time, so
// changing one scene's words says that scene again and nothing else. The
// credits ElevenLabs charges are spent once a video, not once a day.
//
// ── What a person sees ──────────────────────────────────────────────────────
// The videos as a row of cards, and the one picked in the bulletin's player.
// Under it: ⛶ Full screen (also the F key), for a meeting room — the picture
// fills the screen, the words large under it, the bar hidden while it plays
// and back on a move, a presentation clicker's Page Down and Page Up moving a
// scene; Esc leaves. 🔗 Copy link gives the address that opens the video
// ready to play (…/?watch=<id>), and a video opened from one goes full screen
// on its first ▶ — type the link into the room's laptop, press play.
// 📥 Keep for no signal fetches the video, its words and its voices so this
// device's saved copy (sw.js) has them, for a venue whose Wi-Fi cannot be
// trusted.
//
// The words of a video never say a number, a date or a tab's current name:
// those are drawn (a `figure` counts the stations on file as they are now, a
// `feature` reads the tab's icon and label from TABS) so the voices, said
// once, do not go stale.

const Explainers = (() => {

  const INDEX = 'data/explainers/index.json';
  const KIND = 'explainers';
  // The words on this page that mean something particular here — on hover
  // where they are used, and listed in full in the fold at the foot.
  const WORDS = [
    ['Draft', 'A video whose words are still being checked. It plays without voices — the words shown as they would be said — and is voiced once its script has been approved.'],
    ['Voiced', 'Said by the Droggies in their own voices: AI speech (ElevenLabs), one voice for each of them, made once when the video’s words were approved.'],
    ['Scene', 'One drawing and the words said over it — a few seconds each. ⏮ and ⏭, the arrow keys and a clicker move a scene at a time.'],
    ['Full screen', 'For a meeting room: the picture fills the screen and the words are large under it. A presentation clicker’s next and back move a scene; Esc leaves.'],
    ['Keep for no signal', 'Fetches this video, its words and its voices now, so this device’s saved copy has them and it plays where there is no signal.'],
  ];
  const meaning = w => (WORDS.find(x => x[0] === w) || [])[1] || '';

  const X = {
    want: null,          // an id asked for by ?watch=, until the index says where it is
    missing: null,       // an id asked for that is not in the index
    armed: false,        // opened from a link: the first ▶ goes full screen too
    meeting: false,      // full screen (or the page-filling stand-in)
    idle: null,          // the timer that hides the bar in a meeting
    kept: {},            // file → 'busy' | 'done' | why it could not be kept
  };

  // ── the player ─────────────────────────────────────────────────────────────

  // data/explainers/welcome.json → data/explainers/voice/welcome.json
  // (tools/explainers/validate.mjs voicePathFor says the same).
  function voiceFileOf(f) {
    const m = /^data\/explainers\/([a-z0-9][a-z0-9-]*)\.json$/.exec(f || '');
    return m && m[1] !== 'index' ? `data/explainers/voice/${m[1]}.json` : null;
  }

  const P = makeShowPlayer({
    id: 'xp', global: 'Explainers', noun: 'video', kinds: [KIND], index: INDEX, panelClass: 'xp',
    voiceFileOf,
    voice: { format: 'floodnet-explainer-voice/1', key: 'explainer', audio: /^data\/explainers\/voice\/[a-z0-9][a-z0-9-]*\.mp3$/ },
    // The voice's own hash in the address, so a video voiced again is fetched
    // again — by the browser and by the saved copy — rather than its old sound
    // played under its new words.
    audioUrl: v => `${v.audio}?h=${encodeURIComponent(v.hash || '')}`,
    panel, controls, key: meetingKey, redrawn, open: openStation, softFinish: true,
    chips: { label: 'On the map:', title: 'Pause and open this station on the Stations map' },
    stageLabel: b => `${b.title}, a video in ${(b.scenes || []).length} scenes. Space plays or pauses; arrow keys, Page Up and Page Down move between scenes; F fills the screen; M turns the sound off and on; the less-than and greater-than keys change the speed.`,
    draw: H => ({ cover: H2(H, drawCover), feature: H2(H, drawFeature), figure: H2(H, drawFigure), signoff: H2(H, drawSignoff) }),
  });
  // A drawer given the stage's own hand (colours, type, wrapping) as its last
  // argument.
  function H2(H, fn) { return (s, b, L) => fn(s, b, L, H); }

  function openStation(id) {
    exitMeeting();
    if (typeof goToStation === 'function') goToStation(id);
  }

  // ── the panel ──────────────────────────────────────────────────────────────

  function panel(api) {
    const B = api.B;
    const head = `<div class="panel-header hb-head">
        <h2 id="xp-h"><span aria-hidden="true">🎬</span> Videos</h2>
      </div>
      <p class="xp-lede">Short drawn videos about Flood-Net, said by the Droggies. The welcome is a first look — or the start of a meeting; each how-to shows one job, on the app itself.</p>`;
    if (B.loading && !B.index) return head + '<p class="small hb-note">Fetching the videos…</p>';
    if (!B.index) {
      return head + `<p class="small hb-note">${B.indexErr ? `The list of videos could not be read — ${esc(B.indexErr)}.` : 'No videos yet.'}</p>${glossaryHtml()}`;
    }
    const list = api.entries(KIND);
    if (!list.length) {
      return head + `<p class="small hb-note xp-empty">No videos yet. The first — a welcome to Flood-Net, presented by Graham — is being written.</p>${glossaryHtml()}`;
    }
    const f = api.currentFile(), got = f && B.files.get(f);
    const missing = X.missing ? `<p class="small txt-warn" role="status">There is no video called “${esc(X.missing)}”: here are the ones there are.</p>` : '';
    let body;
    if (!got || got.loading) body = '<p class="small hb-note">Fetching the video…</p>';
    else if (got.error) body = `<p class="small hb-note txt-warn">The video could not be read — ${esc(got.error)}.</p>`;
    else body = showHtml(api, got, f);
    return head + missing + cardsHtml(api, list, f) + body + glossaryHtml();
  }

  // Every video as a card: who presents it, what it is, how long, and whether
  // it is still a draft. The one showing is pressed.
  function cardsHtml(api, list, f) {
    if (list.length < 2 && f === list[0].file) return '';
    return `<div class="xp-cards" role="group" aria-label="Videos">${list.map(e => {
      const on = e.file === f;
      const secs = Number.isFinite(+e.secs) ? +e.secs : null;
      return `<button class="xp-card${on ? ' is-on' : ''}" aria-pressed="${on}" onclick="Explainers.pick('${escAttr(e.file)}')">
          <img src="${escAttr(api.portrait(e.presenter))}" alt="" width="64" height="80" loading="lazy" decoding="async">
          <span class="xp-card-t">${esc(e.title)}</span>
          <span class="xp-card-s">${esc(e.summary || '')}</span>
          <span class="xp-card-m">${secs ? esc(api.fmtDur(secs)) : ''}${e.voice !== 'final' ? ` <span class="term-chip" title="${escAttr(meaning('Draft'))}">Draft</span>` : ''}</span>
        </button>`;
    }).join('')}</div>`;
  }

  function showHtml(api, b, f) {
    const voiced = !!api.voiceOf(b);
    const draft = b.voice !== 'final';
    const others = [...new Set((b.scenes || []).map(s => s.presenter).filter(id => id && id !== b.presenter))].map(id => api.who(id).name);
    const state = draft ? `${termHtml('Draft', meaning('Draft'))} — it plays without voices until its words are approved.`
      : voiced ? `${termHtml('Voiced', meaning('Voiced'))} — said by the Droggies.`
      : 'Its words are approved; the voices are on their way, and it plays without them until they come.';
    const k = X.kept[f];
    const keptLine = k === 'busy' ? 'Keeping it…' : k === 'done' ? 'Kept on this device: it plays with no signal.' : k ? esc(k) : '';
    return `<p class="small hb-issued">${state}</p>
      ${X.armed ? '<p class="small xp-armed" role="status">Opened from a link: <b>▶ plays it full screen</b>. Esc leaves full screen; a clicker’s next and back move a scene.</p>' : ''}
      <div class="xp-show${X.meeting ? ' is-meeting' : ''}" id="xp-show" onkeydown="Explainers.key(event)" onpointermove="Explainers.wake()">
        ${api.playerHtml(b)}
        ${api.anchorHtml(b)}
      </div>
      <div class="button-group xp-tools">
        <button class="ghost" onclick="Explainers.meeting(true)" title="${escAttr(meaning('Full screen'))} (F)">⛶ ${termHtml('Full screen', meaning('Full screen'))}</button>
        <button class="ghost" onclick="Explainers.copyLink()" title="The address that opens this video ready to play — for a meeting room’s laptop, or a message">🔗 Copy link</button>
        <button class="ghost" onclick="Explainers.keepIt()"${k === 'busy' ? ' disabled' : ''} title="${escAttr(meaning('Keep for no signal'))}">📥 ${termHtml('Keep for no signal', meaning('Keep for no signal'))}</button>
        <span class="small xp-kept" role="status">${keptLine}</span>
      </div>
      <details class="hb-transcript"><summary>Read it instead</summary>${api.transcriptHtml(b)}</details>
      <p class="small hb-foot">Presented by ${esc(api.who(b.presenter).name)}${others.length ? `, with ${esc(others.join(' and '))}` : ''} (from the Droggies). ${voiced ? 'The voices are AI speech (ElevenLabs), one cast for each Droggie.' : ''}</p>`;
  }

  function glossaryHtml() {
    return `<details class="xp-fold"><summary>What the words on this page mean</summary>
        <dl class="hb-key small">${WORDS.map(([w, m]) => `<dt>${esc(w)}</dt><dd>${esc(m)}</dd>`).join('')}</dl>
      </details>`;
  }

  // The player's own bar gets ⛶ beside the speed.
  function controls() {
    return `<button class="hb-cbtn" id="xp-full" onclick="Explainers.meeting()" aria-pressed="${X.meeting}"
        aria-label="${X.meeting ? 'Leave full screen' : 'Full screen'}" title="${X.meeting ? 'Leave full screen (Esc)' : 'Full screen, for a meeting room (F)'}">${fullIcon(X.meeting)}</button>`;
  }
  const fullIcon = on => `<svg class="hb-i" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false">${on
    ? '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>' : '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'}</svg>`;

  // After every redraw: a video asked for by its link, once the index has
  // come; and a meeting carried on into the new stage.
  function redrawn(api) {
    const B = api.B;
    if (X.want && B.index) {
      const e = api.entries(KIND).find(x => x.id === X.want);
      X.missing = e ? null : X.want;
      X.want = null;
      if (!e) X.armed = false;
      if (e && api.currentFile() !== e.file) { P.pick(e.file); return; }
      if (X.missing) { P._api.redraw(); return; }
    }
    const el = document.getElementById('xp-show');
    if (el && X.meeting) el.classList.add('is-meeting');
  }

  // ── meeting mode ───────────────────────────────────────────────────────────
  // The show — the stage, its bar, the presenter and the words — made to fill
  // the screen: the browser's own full screen where it has one, and where it
  // has not (an iPhone's Safari) the same layout over the page. Esc, the
  // browser's own way out, ends it too.

  function meeting(on) {
    const want = on == null ? !X.meeting : !!on;
    if (want === X.meeting) { if (want) wake(); return; }
    const el = document.getElementById('xp-show');
    if (!el) return;
    X.meeting = want;
    el.classList.toggle('is-meeting', want);
    document.documentElement.classList.toggle('xp-meeting-on', want);
    if (want) {
      const ask = el.requestFullscreen || el.webkitRequestFullscreen;
      try { const p = ask && ask.call(el, { navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      const stage = document.getElementById('xp-stage');
      if (stage) stage.focus({ preventScroll: true });
      wake();
      if (typeof announce === 'function') announce('Full screen. Escape leaves.');
    } else {
      clearTimeout(X.idle); X.idle = null;
      el.classList.remove('is-idle');
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const leave = document.exitFullscreen || document.webkitExitFullscreen;
      if (fs && leave) { try { const p = leave.call(document); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    }
    drawFull();
  }
  function exitMeeting() { if (X.meeting) meeting(false); }
  function drawFull() {
    const btn = document.getElementById('xp-full');
    if (!btn) return;
    btn.innerHTML = fullIcon(X.meeting);
    btn.setAttribute('aria-pressed', String(X.meeting));
    btn.setAttribute('aria-label', X.meeting ? 'Leave full screen' : 'Full screen');
    btn.title = X.meeting ? 'Leave full screen (Esc)' : 'Full screen, for a meeting room (F)';
  }
  // The browser's own full screen left (Esc, its own button): the meeting with it.
  function fullscreenChanged() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fs && X.meeting) meeting(false);
  }
  // In a meeting the bar hides while it plays, and comes back on a move or a key.
  function wake() {
    const el = document.getElementById('xp-show');
    if (!el || !X.meeting) return;
    el.classList.remove('is-idle');
    clearTimeout(X.idle);
    X.idle = setTimeout(() => {
      const s = document.getElementById('xp-show');
      if (s && X.meeting && P._state().playing) s.classList.add('is-idle');
    }, 2600);
  }
  // Keys of the videos' own, before the player's: a clicker's next and back
  // (Page Down / Page Up — most clickers send these, or the arrows, which the
  // player already has), F for full screen, Esc out of the stand-in.
  function meetingKey(e) {
    const k = e.key;
    wake();
    if (k === 'PageDown') { P.next(); return true; }
    if (k === 'PageUp') { P.prev(); return true; }
    if (k === 'f' || k === 'F') { meeting(); return true; }
    if (k === 'Escape' && X.meeting) { meeting(false); return true; }
    return false;
  }

  // ── the link, and keeping it for no signal ─────────────────────────────────

  function linkFor(id) { return `${location.origin}${location.pathname}?watch=${encodeURIComponent(id)}`; }
  async function copyLink() {
    const b = P._api.current();
    if (!b) return;
    const url = linkFor(b.id);
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch (_) { ok = false; }
    const say = ok ? `Copied: ${url}` : `The link: ${url}`;
    if (typeof Toast !== 'undefined') Toast.show(say, { kind: ok ? 'done' : 'note', ms: ok ? 4000 : 12000 });
    else if (typeof announce === 'function') announce(say);
  }

  // The video's file, its voice file, its sound and the presenters' faces,
  // fetched now so the saved copy (sw.js keeps every file of the site it is
  // asked for) has them all.
  async function keepIt() {
    const api = P._api, b = api.current(), f = api.currentFile();
    if (!b || !f) return;
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || !navigator.serviceWorker.controller) {
      X.kept[f] = 'This browser is not keeping a copy of Flood-Net yet — 📲 Offline & Install sets that up first.';
      api.redraw(); return;
    }
    X.kept[f] = 'busy'; api.redraw();
    const v = api.voiceOf(b);
    const speakers = [...new Set([b.presenter, ...(b.scenes || []).map(s => s.presenter)].filter(Boolean))];
    const urls = [INDEX, f, ...(v ? [voiceFileOf(f), `${v.audio}?h=${encodeURIComponent(v.hash || '')}`] : []), ...speakers.map(id => api.portrait(id))];
    try {
      for (const u of urls) {
        const res = await fetch(u, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${u} answered ${res.status}`);
        await res.arrayBuffer();
      }
      X.kept[f] = 'done';
    } catch (err) {
      X.kept[f] = `Not kept — ${(err && err.message) || err}. Try again with a signal.`;
    }
    api.redraw();
  }

  // ?watch=<id>: read once, after the first render (init.js), and taken out of
  // the address; the Videos tab opened on that video, armed to go full screen
  // on its first ▶.
  function restoreFromUrl() {
    if (typeof location === 'undefined') return;
    let q;
    try { q = new URLSearchParams(location.search); } catch (_) { return; }
    const id = q.get('watch');
    if (!id) return;
    q.delete('watch');
    const rest = q.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (_) {}
    X.want = String(id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
    X.armed = !!X.want;
    if (typeof switchTab === 'function') switchTab('videos');
  }

  function bigPlay() {
    if (X.armed) { X.armed = false; meeting(true); const n = document.querySelector('.xp-armed'); if (n) n.remove(); }
    P.bigPlay();
  }

  // ── the scenes of the videos' own ──────────────────────────────────────────

  // A tab as TABS has it now — its icon, its label, the group it is in — so a
  // renamed tab is drawn by its new name without the video being touched.
  function tabOf(id) {
    if (typeof TABS === 'undefined') return null;
    for (const g of TABS) { const t = g.tabs.find(x => x.id === id); if (t) return { ...t, group: g.group, siblings: g.tabs }; }
    return null;
  }

  // The numbers a `figure` may draw live, from what this page has loaded; each
  // falls back to the file's own when there is nothing to count.
  function liveCount(of) {
    try {
      const st = (typeof state !== 'undefined' && state.data && Array.isArray(state.data.stations)) ? state.data.stations : null;
      const sensors = s => (typeof stationSensorTypeKeys === 'function' ? stationSensorTypeKeys(s) : []).join(' ');
      const roles = s => (Array.isArray(s.roles) ? s.roles : [s.roles]).join(' ');
      switch (of) {
        case 'stations': return st && st.length ? st.length : null;
        case 'rain': return st ? st.filter(s => /rain/i.test(sensors(s))).length || null : null;
        case 'level': return st ? st.filter(s => /level|height|stage|water/i.test(sensors(s))).length || null : null;
        case 'repeaters': return st ? st.filter(s => /repeater/i.test(roles(s))).length || null : null;
        case 'tabs': return typeof TAB_LIST !== 'undefined' ? TAB_LIST.filter(t => typeof tabShown !== 'function' || tabShown(t)).length : null;
        default: return null;
      }
    } catch (_) { return null; }
  }

  // ── cover: the video's title card ──
  function drawCover(s, b, L, H) {
    const { W, H: SH, F, pad, narrow } = L, C = H.C;
    const kicker = s.kicker || (b.kind === 'howto' ? 'FLOOD-NET · HOW TO' : 'FLOOD-NET');
    const title = s.headline || b.title || s.title;
    const pw = narrow ? 0 : 300, tw = W - pad * 2 - (pw ? pw + 40 : 0);
    const ts = narrow ? F.xl : F.xxl * 0.86;
    const tl = H.wrap(title, H.charsFor(tw, ts), 3);
    let out = `<g class="hb-a-fade" ${H.d(0.1)}>${H.text(pad, pad + F.s, kicker, F.s, `fill="${C.accent}" font-weight="700" letter-spacing="3"`)}</g>`;
    const ty = narrow ? pad + F.s * 3.4 + ts : H.vtop(L, tl.length * ts * 1.15 + F.m * 3) + ts;
    out += `<g class="hb-a-rise" ${H.d(0.4)}>${H.text(pad, ty, '', ts, `fill="${C.text}" font-weight="800"`, tl, 1.1)}</g>`;
    const line = s.line || b.summary;
    if (line) {
      const ls = F.m, ll = H.wrap(line, H.charsFor(tw, ls), narrow ? 4 : 3);
      out += `<g class="hb-a-rise" ${H.d(1.0)}>${H.text(pad, ty + (tl.length - 1) * ts * 1.1 + ts * 0.5 + ls * 1.4, '', ls, `fill="${C.muted}"`, ll)}</g>`;
    }
    // A river running under it, drawn in.
    const ry = SH - L.foot - (narrow ? 70 : 40);
    const river = k => { let dpath = `M0 ${ry + k * 14}`; for (let x = 0; x <= W; x += 80) dpath += ` Q${x + 40} ${ry + k * 14 + (k % 2 ? 12 : -12)} ${x + 80} ${ry + k * 14}`; return dpath; };
    [0, 1, 2].forEach(k => {
      out += `<path d="${river(k)}" fill="none" stroke="${k === 1 ? C.accent : C.info}" stroke-opacity="${k === 1 ? 0.9 : 0.4}" stroke-width="${k === 1 ? 5 : 3}"
        class="hb-a-draw" style="--len:${W * 1.3};--dur:2.4s;--d:${(0.3 + k * 0.25).toFixed(2)}s" stroke-dasharray="${W * 1.3}"/>`;
    });
    if (pw) out += portraitSvg(H, b.presenter, W - pad - pw, H.vtop(L, pw * 1.2), pw, 0.8);
    return out;
  }

  // A presenter's face, framed, in the drawing.
  function portraitSvg(H, id, x, y, w, delay) {
    const h = Math.round(w * 1.25), C = H.C, cid = `xp-face-${Math.round(x)}-${Math.round(y)}`;
    return `<g class="hb-a-pop" ${H.d(delay)}><defs><clipPath id="${cid}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24"/></clipPath></defs>
      <rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="28" fill="${C.ground}" stroke="${C.grid}" stroke-width="2"/>
      <image href="${escAttr(H.portrait(id))}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${cid})"/></g>`;
  }

  // ── feature: a tab, sketched, one part of it lit ──
  // Not a screenshot: a drawing of the app's window — the bar of tabs down its
  // side, the banner with its search box, the tab's heading and the shape of
  // what the tab shows (s.sketch) — with the part the scene is about (s.lit)
  // ringed and the rest dimmed, and up to three short lines beside it.
  const SKETCHES = ['map', 'card', 'chart', 'list', 'table', 'player', 'form', 'tiles'];
  const PARTS = ['rail', 'search', 'head', 'main', 'side'];
  function drawFeature(s, b, L, H) {
    const { W, H: SH, F, pad, narrow } = L, C = H.C;
    const tab = tabOf(s.tab);
    const lit = PARTS.includes(s.lit) ? s.lit : 'main';
    const hasSide = !!s.side || lit === 'side';
    const avail = SH - L.foot - pad * 1.4;
    const wx = pad, wy = pad * 0.8, ww = narrow ? W - pad * 2 : Math.round(W * 0.56), wh = narrow ? Math.round(avail * 0.56) : avail;
    const dim = p => (p === lit ? 1 : 0.42);
    const R = {};                                       // each part's box, for the ring
    let out = `<g class="hb-a-fade" ${H.d(0.1)}><rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" rx="16" fill="${C.ground}" stroke="${C.grid}" stroke-width="2"/>`;
    // The bar of tabs down the side: the group's icons, this tab's lit.
    const rw = Math.round(ww * 0.11);
    R.rail = [wx, wy, rw, wh];
    out += `<g opacity="${dim('rail')}"><rect x="${wx}" y="${wy}" width="${rw}" height="${wh}" rx="16" fill="${C.ground2}"/>`;
    const sib = tab ? tab.siblings.slice(0, 7) : [];
    sib.forEach((t, k) => {
      const cy = wy + 30 + k * Math.min(54, (wh - 40) / Math.max(1, sib.length));
      if (t.id === s.tab) out += `<rect x="${wx + 6}" y="${cy - 22}" width="${rw - 12}" height="40" rx="10" fill="${C.accent}" fill-opacity=".35"/>`;
      out += H.text(wx + rw / 2, cy + 8, t.icon || '•', Math.round(rw * 0.42), 'text-anchor="middle"');
    });
    out += '</g>';
    // The banner, its search box.
    const bx = wx + rw, bw = ww - rw, bh = Math.round(wh * 0.12);
    R.search = [bx + 16, wy + bh * 0.2, bw * 0.46, bh * 0.6];
    out += `<g opacity="${dim('search')}"><rect x="${bx + 16}" y="${wy + bh * 0.2}" width="${bw * 0.46}" height="${bh * 0.6}" rx="${bh * 0.3}" fill="${C.ground2}" stroke="${C.grid}"/>
      ${H.text(bx + 34, wy + bh * 0.5 + F.xs * 0.35, '🔍 Search', F.xs, `fill="${C.muted}"`)}</g>`;
    // The tab's heading: its icon and label, as TABS has them now.
    const hy = wy + bh + F.m;
    R.head = [bx + 12, wy + bh + 4, bw * 0.7, F.m * 1.5];
    out += `<g opacity="${dim('head')}">${H.text(bx + 20, hy, tab ? `${tab.icon} ${tab.label}` : (s.tab || ''), F.m, `fill="${C.text}" font-weight="700"`)}</g>`;
    // What the tab shows.
    const mx = bx + 16, my = hy + F.m * 0.7, mw = bw - 32 - (hasSide ? bw * 0.34 : 0), mh = wy + wh - my - 16;
    R.main = [mx, my, mw, mh];
    out += `<g opacity="${dim('main')}">${sketch(SKETCHES.includes(s.sketch) ? s.sketch : 'card', mx, my, mw, mh, C, H, s.tab || 'x')}</g>`;
    if (hasSide) {
      const sx = mx + mw + 12, sw = bw - 32 - mw - 12;
      R.side = [sx, my, sw, mh];
      out += `<g opacity="${dim('side')}"><rect x="${sx}" y="${my}" width="${sw}" height="${mh}" rx="10" fill="${C.ground2}" stroke="${C.grid}"/>
        ${[0, 1, 2, 3, 4].map(k => `<rect x="${sx + 12}" y="${my + 16 + k * 30}" width="${(sw - 24) * (k % 2 ? 0.6 : 0.85)}" height="12" rx="6" fill="${C.dot}" fill-opacity=".55"/>`).join('')}</g>`;
    }
    out += '</g>';
    // The ring round the part the scene is about.
    const [rx, ry, rw2, rh] = R[lit] || R.main;
    out += `<rect x="${(rx - 6).toFixed(1)}" y="${(ry - 6).toFixed(1)}" width="${(rw2 + 12).toFixed(1)}" height="${(rh + 12).toFixed(1)}" rx="14" fill="none"
      stroke="${C.warn}" stroke-width="5" class="hb-a-pop" ${H.d(0.7)}/>`;
    // The lines beside it (under it, on a phone).
    const pts = (s.points || []).slice(0, 3);
    const px = narrow ? pad : wx + ww + 40, pw = narrow ? W - pad * 2 : W - px - pad;
    const fs = narrow ? F.m : F.l * 0.9;
    const laid = pts.map(p => H.wrap(p, H.charsFor(pw - fs * 1.4, fs), 3));
    const need = laid.reduce((n, l) => n + l.length * fs * 1.22 + fs * 0.9, 0);
    let y = narrow ? wy + wh + fs * 1.6 : H.vtop(L, need) + fs;
    laid.forEach((l, k) => {
      out += `<g class="hb-a-rise" ${H.d(1.1 + k * 0.9)}><circle cx="${px + fs * 0.35}" cy="${y - fs * 0.34}" r="${fs * 0.26}" fill="${C.accent}"/>
        ${H.text(px + fs * 1.1, y, '', fs, `fill="${C.text}"`, l)}</g>`;
      y += l.length * fs * 1.22 + fs * 0.9;
    });
    return out;
  }
  // The shape of what a tab shows, in a box: never its real contents.
  function sketch(kind, x, y, w, h, C, H, seed) {
    let r = 0; for (const ch of seed) r = (r * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
    const box = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.land}" fill-opacity=".55" stroke="${C.grid}"/>`;
    const bar = (bx, by, bw, col = C.dot, op = 0.6) => `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${Math.max(6, bw).toFixed(1)}" height="12" rx="6" fill="${col}" fill-opacity="${op}"/>`;
    switch (kind) {
      case 'map': {
        let o = box;
        for (let k = 0; k < 3; k++) o += `<path d="M${x} ${y + h * (0.3 + k * 0.22)} C${x + w * 0.3} ${y + h * (0.2 + k * 0.25)} ${x + w * 0.6} ${y + h * (0.45 + k * 0.15)} ${x + w} ${y + h * (0.35 + k * 0.2)}" stroke="${C.basin}" stroke-width="3" fill="none"/>`;
        for (let k = 0; k < 34; k++) o += `<circle cx="${(x + 10 + rnd() * (w - 20)).toFixed(1)}" cy="${(y + 10 + rnd() * (h - 20)).toFixed(1)}" r="4.5" fill="${k % 9 ? C.dot : C.ok}"/>`;
        return o;
      }
      case 'chart': {
        let o = box, pts = [];
        for (let k = 0; k <= 12; k++) pts.push(`${(x + 14 + k * (w - 28) / 12).toFixed(1)},${(y + h * 0.25 + rnd() * h * 0.5).toFixed(1)}`);
        o += `<polyline points="${pts.join(' ')}" fill="none" stroke="${C.accent}" stroke-width="4" stroke-linejoin="round"/>`;
        o += `<line x1="${x + 14}" y1="${y + h - 16}" x2="${x + w - 14}" y2="${y + h - 16}" stroke="${C.grid}" stroke-width="2"/>`;
        return o;
      }
      case 'list': case 'table': {
        let o = box; const n = Math.max(3, Math.floor((h - 20) / 34));
        for (let k = 0; k < n; k++) {
          const ry = y + 14 + k * 34;
          if (kind === 'table' && k % 2) o += `<rect x="${x + 6}" y="${ry - 6}" width="${w - 12}" height="28" fill="${C.ground2}" fill-opacity=".6"/>`;
          o += bar(x + 16, ry, (w - 32) * (kind === 'table' ? 0.28 : 0.5 + rnd() * 0.35));
          if (kind === 'table') { o += bar(x + 16 + (w - 32) * 0.36, ry, (w - 32) * 0.25, C.muted, 0.45); o += bar(x + 16 + (w - 32) * 0.7, ry, (w - 32) * 0.2, C.muted, 0.45); }
        }
        return o;
      }
      case 'player': {
        const pw = Math.min(w - 24, (h - 24) * 16 / 9), ph = pw * 9 / 16, px = x + (w - pw) / 2, py = y + (h - ph) / 2;
        return box + `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="10" fill="${C.ground}"/>
          <circle cx="${px + pw / 2}" cy="${py + ph / 2}" r="${ph * 0.16}" fill="${C.accent}" fill-opacity=".85"/>
          <path d="M${px + pw / 2 - ph * 0.05} ${py + ph / 2 - ph * 0.08} l${ph * 0.13} ${ph * 0.08} l${-ph * 0.13} ${ph * 0.08}z" fill="${C.ground}"/>`;
      }
      case 'form': {
        let o = box; const n = Math.max(2, Math.floor((h - 20) / 56));
        for (let k = 0; k < n; k++) {
          const fy = y + 16 + k * 56;
          o += bar(x + 16, fy, (w - 32) * 0.3, C.muted, 0.5);
          o += `<rect x="${x + 16}" y="${fy + 18}" width="${(w - 32) * 0.8}" height="24" rx="6" fill="none" stroke="${C.dot}" stroke-opacity=".7" stroke-width="2"/>`;
        }
        return o;
      }
      case 'tiles': {
        let o = box; const cols = 3, rows = 2, g = 12, tw = (w - g * (cols + 1)) / cols, th = (h - g * (rows + 1)) / rows;
        for (let i = 0; i < cols * rows; i++) {
          const tx = x + g + (i % cols) * (tw + g), ty = y + g + Math.floor(i / cols) * (th + g);
          o += `<rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" rx="10" fill="${C.ground2}" stroke="${C.grid}"/>`;
          o += bar(tx + 12, ty + th - 26, tw * 0.6);
        }
        return o;
      }
      default: {                                       // a card: a heading, then label and value pairs
        let o = box; const n = Math.max(3, Math.floor((h - 50) / 32));
        o += bar(x + 16, y + 18, (w - 32) * 0.5, C.text, 0.8);
        for (let k = 0; k < n; k++) { o += bar(x + 16, y + 56 + k * 32, (w - 32) * 0.3, C.muted, 0.45); o += bar(x + 16 + (w - 32) * 0.4, y + 56 + k * 32, (w - 32) * (0.25 + rnd() * 0.3)); }
        return o;
      }
    }
  }

  // ── figure: a number or three, counted now ──
  function drawFigure(s, b, L, H) {
    const { W, F, pad, narrow } = L, C = H.C;
    const items = (s.figures || []).slice(0, 3).map(it => {
      const live = it.of ? liveCount(it.of) : null;
      return { ...it, v: live != null ? live : it.value };
    });
    if (!items.length) return '';
    const cols = narrow ? 1 : items.length, gap = 28, tileW = (W - pad * 2 - gap * (cols - 1)) / cols;
    const big = narrow ? F.xxl : items.length > 2 ? F.xxl * 0.9 : F.xxl * 1.15;
    const tileH = big * 1.1 + F.m * 2.8;
    const totalH = narrow ? items.length * tileH + (items.length - 1) * 16 : tileH;
    const top = H.vtop(L, totalH + (s.note ? F.m * 2 : 0));
    let out = '';
    items.forEach((it, k) => {
      const x = pad + (narrow ? 0 : k * (tileW + gap)), y = top + (narrow ? k * (tileH + 16) : 0);
      const num = typeof it.v === 'number' ? it.v : null;
      out += `<g class="hb-a-rise" ${H.d(0.3 + k * 0.5)}>
        <text x="${x}" y="${(y + big).toFixed(1)}" font-size="${Math.round(big)}" font-weight="800" fill="${C.ok}" ${num != null ? `data-count="${num}"` : ''}>${esc(num != null ? H.fmtStat(num) : String(it.v == null ? '—' : it.v))}<tspan font-size="${F.m}" fill="${C.muted}" dx="10">${esc(it.unit || '')}</tspan></text>
        ${H.text(x, y + big + F.m * 1.5, '', F.m, `fill="${C.text}"`, H.wrap(it.label, H.charsFor(tileW, F.m), 2))}</g>`;
    });
    if (s.note) out += `<g class="hb-a-fade" ${H.d(1.6)}>${H.text(pad, top + totalH + F.m * 1.6, '', F.s, `fill="${C.muted}"`, H.wrap(s.note, H.charsFor(W - pad * 2, F.s), 2))}</g>`;
    return out;
  }

  // ── signoff: the presenter's line, and where to go next ──
  function drawSignoff(s, b, L, H) {
    const { W, H: SH, F, pad, narrow } = L, C = H.C;
    const P0 = H.who(b.presenter);
    const line = s.line || P0.lines[0];
    const fw = narrow ? 180 : 170;
    let out = portraitSvg(H, b.presenter, W / 2 - fw / 2, pad * 0.8, fw, 0.2);
    const ly = pad * 0.8 + fw * 1.25 + F.l * 1.6;
    out += `<g class="hb-a-rise" ${H.d(0.7)}>${H.text(W / 2, ly, '', F.l, `text-anchor="middle" font-weight="700" fill="${C.text}"`, H.wrap(`“${line}”`, H.charsFor(W - pad * 2, F.l), 2))}
      ${H.text(W / 2, ly + F.l * (narrow ? 2.6 : 1.7), `— ${P0.name}`, F.s, `text-anchor="middle" fill="${C.muted}"`)}</g>`;
    const tab = s.tab && tabOf(s.tab);
    const next = s.next || (tab ? `${tab.icon} ${tab.label}` : '');
    if (next) out += `<g class="hb-a-fade" ${H.d(1.5)}>${H.text(W / 2, SH - L.foot - (narrow ? 60 : 34), next, F.m, `text-anchor="middle" fill="${C.accent}" font-weight="600"`)}</g>`;
    return out;
  }

  // ── the tab ────────────────────────────────────────────────────────────────

  let listening = false;
  function init() {
    if (!listening && typeof document !== 'undefined') {
      listening = true;
      document.addEventListener('fullscreenchange', fullscreenChanged);
      document.addEventListener('webkitfullscreenchange', fullscreenChanged);
    }
    P.init();
    if (typeof registerTabTeardown === 'function') registerTabTeardown('Videos', stop);
  }
  function stop() {
    exitMeeting();
    document.documentElement.classList.remove('xp-meeting-on');
    P.stop();
  }

  return {
    ...P,
    render: () => P.render(), init, stop, bigPlay,
    meeting, wake, copyLink, keepIt, restoreFromUrl,
    // For the tests: the scenes' own drawers and the live counts.
    _x: () => ({ ...X }), _liveCount: liveCount, _tabOf: tabOf, SKETCHES, PARTS, WORDS,
  };
})();

if (typeof window !== 'undefined') window.Explainers = Explainers;
