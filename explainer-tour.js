// MegaNet — explainer-tour.js
//
//   VideoTour   ▶ Show me on the app: a 🎬 video played over the app itself
//               (#265, EPIC #262). Its screenshot scenes become the real
//               thing — each opens its tab (and its station), and each part a
//               scene names is spotlit on the live page as it is said, the
//               rest of the page dimmed — while the voices play and a small
//               guide card carries the presenter, the words and the buttons.
//               Every other scene (the title, a tally, the sign-off) is drawn
//               small in the card.
//
// After core.js (state, esc, escAttr, announce) and app.js (switchTab,
// goToStation); started by explainers.js (Explainers.tour), which hands it the
// video, its voice file, the screenshots' index and the way to draw a scene.
// Nothing runs at load.
//
// ── What it may do ──────────────────────────────────────────────────────────
// Navigate, and nothing else: open a tab, open a station, scroll a part into
// view. It never presses a button that saves, uploads or sends, never types
// into a form, and the dim over the page lets every press through, so somebody
// can stop following and do it themselves at any moment — ✋ Try it yourself
// puts the card away to a pill that carries on from where it was. A shot whose
// page cannot be driven to (a dialog, say) names a part that is there instead
// (`tour` in tools/explainers/shots.json): the search scene rings the banner's
// search button and leaves the typing to the person.
//
// ── The parts ───────────────────────────────────────────────────────────────
// The same parts the screenshot points at, found by the same selectors
// (data/explainers/shots/index.json `selectors`, from tools/explainers/
// shots.json) — mostly `data-tour` hooks put on the app for the purpose, so a
// restyle does not lose them. npm run explainers walks every tour step by step
// in Chromium and fails one whose tab or part has gone.

const VideoTour = (() => {

  const T = {
    on: false, b: null, v: null, shots: {}, draw: null, cueIndex: null, who: null, portrait: null,
    i: 0, t: 0, playing: false, ended: false, timer: null, last: 0,
    audio: null, url: null, sound: false,
    away: false,                // ✋ put away to the pill
    lit: null,                  // { el, n, text } the part spotlit now
    raf: 0, from: null,
  };

  const scenes = () => (T.b && T.b.scenes) || [];
  const speaker = s => (s && s.presenter) || T.b.presenter;
  const wordsOf = s => String((s && s.say) || '').split(/\s+/).filter(Boolean);
  // A scene's seconds, and when its word k is said: by the voice file when the
  // voices play, else as the player reveals them — over four-fifths of its seconds.
  function secsOf(i) {
    if (T.sound && T.v) { const x = T.v.scenes[i], nx = T.v.scenes[i + 1]; return Math.max(0.5, (nx ? nx.start : x.end) - x.start); }
    return +(scenes()[i] || {}).secs || 8;
  }
  function wordAt(i, k) {
    if (T.sound && T.v && T.v.scenes[i] && Number.isFinite(T.v.scenes[i].words[k])) return T.v.scenes[i].words[k] - T.v.scenes[i].start;
    const n = wordsOf(scenes()[i]).length || 1;
    return secsOf(i) * 0.82 * Math.min(k, n) / n;
  }
  // The callouts' times, cue by cue in order (explainers.js cueTimes).
  function cueTimes(i) {
    const s = scenes()[i], calls = (s && s.callouts) || [], n = wordsOf(s).length || 1;
    let from = 0;
    return calls.map((c, k) => {
      let w = c.cue && T.cueIndex ? T.cueIndex(s, c.cue, from) : -1;
      if (w < 0) w = Math.round((k + 0.5) * n / Math.max(1, calls.length)); else from = w + 1;
      return wordAt(i, w);
    });
  }
  const metaOf = s => (s && s.type === 'shot' && T.shots[s.shot]) || null;
  // The live selector for a shot's part: its own tour selector where the
  // screenshot's page cannot be driven to, else the screenshot's.
  const selectorOf = (meta, target) => (meta.tour && meta.tour[target]) || (meta.selectors && meta.selectors[target]) || null;

  // ── the card ───────────────────────────────────────────────────────────────

  function cardHtml() {
    return `<div id="vt-guide" class="vt-guide" role="region" aria-label="The tour: ${escAttr(T.b.title)}" tabindex="-1" onkeydown="VideoTour.key(event)">
        <div class="vt-head">
          <img class="vt-face" id="vt-face" alt="" width="56" height="70" decoding="async">
          <div class="vt-heads"><p class="vt-who" id="vt-who"></p><p class="vt-step small" id="vt-step"></p></div>
          <button type="button" class="vt-x" onclick="VideoTour.leave()" aria-label="Leave the tour" title="Leave the tour (Esc)">✕</button>
        </div>
        <div class="vt-mini" id="vt-mini" hidden></div>
        <p class="vt-say" id="vt-say" aria-live="off"></p>
        <div class="vt-ctl">
          <button type="button" class="hb-cbtn vt-btn" onclick="VideoTour.prev()" aria-label="Previous scene" title="Previous scene (←)">⏮</button>
          <button type="button" class="hb-cbtn vt-btn vt-play" id="vt-play" onclick="VideoTour.toggle()" aria-label="Pause" title="Play or pause (space)">⏸</button>
          <button type="button" class="hb-cbtn vt-btn" onclick="VideoTour.next()" aria-label="Next scene" title="Next scene (→)">⏭</button>
          <button type="button" class="ghost vt-try" onclick="VideoTour.away()" title="Put the guide away and do it yourself — it carries on from here when you want">✋ Try it yourself</button>
        </div>
        <div class="vt-end" id="vt-end" hidden>
          <p class="small">That's the tour.</p>
          <div class="button-group"><button type="button" class="ghost" onclick="VideoTour.leave(true)">Back to the videos</button>
            <button type="button" class="ghost" onclick="VideoTour.leave()">Stay here</button>
            <button type="button" class="ghost" onclick="VideoTour.go(0); VideoTour.play()">Again</button></div>
        </div>
      </div>
      <div id="vt-pill" class="vt-pill" hidden>
        <button type="button" class="ghost" onclick="VideoTour.back()">▶ Carry on the tour</button>
        <button type="button" class="ghost" onclick="VideoTour.leave()" aria-label="Leave the tour">✕</button>
      </div>
      <div id="vt-spot" class="vt-spot" hidden aria-hidden="true"></div>
      <div id="vt-chip" class="vt-chip" hidden role="status"></div>`;
  }
  function mount() {
    unmount();
    const host = document.createElement('div');
    host.id = 'vt-host';
    host.innerHTML = cardHtml();
    document.body.appendChild(host);
    document.documentElement.classList.add('vt-on');
  }
  function unmount() {
    const h = document.getElementById('vt-host');
    if (h) h.remove();
    document.documentElement.classList.remove('vt-on');
  }
  const $ = id => document.getElementById(id);

  function drawCard() {
    const s = scenes()[T.i];
    if (!s) return;
    const P = T.who(speaker(s));
    const face = $('vt-face');
    if (face) { face.src = T.portrait(speaker(s)); face.alt = P.alt || ''; }
    const whoEl = $('vt-who'); if (whoEl) whoEl.innerHTML = `<b>${esc(P.name)}</b> <span class="small">${esc(P.role)}</span>`;
    const st = $('vt-step'); if (st) st.textContent = `${T.i + 1} of ${scenes().length} · ${s.title}`;
    const mini = $('vt-mini');
    if (mini) {
      if (metaOf(s)) { mini.hidden = true; mini.innerHTML = ''; }
      else { mini.hidden = false; try { mini.innerHTML = T.draw(s); } catch (_) { mini.innerHTML = ''; } }
    }
    const say = $('vt-say');
    if (say) say.innerHTML = wordsOf(s).map(w => `<span class="hb-w">${esc(w)} </span>`).join('');
    drawWords();
    drawPlay();
  }
  function drawWords() {
    const el = $('vt-say'), s = scenes()[T.i];
    if (!el || !s) return;
    const n = wordsOf(s).length;
    let said = 0;
    while (said < n && wordAt(T.i, said) <= T.t + 0.05) said++;
    if (!T.playing && T.t === 0) said = n;
    el.querySelectorAll('.hb-w').forEach((w, k) => w.classList.toggle('is-said', k < said));
  }
  function drawPlay() {
    const b = $('vt-play');
    if (b) { b.textContent = T.playing ? '⏸' : '▶'; b.setAttribute('aria-label', T.playing ? 'Pause' : 'Play'); }
    const end = $('vt-end'); if (end) end.hidden = !T.ended;
  }

  // ── the spotlight ──────────────────────────────────────────────────────────

  function light(el, n, text, sel) {
    T.lit = el ? { el, n, text, sel } : null;
    const spot = $('vt-spot'), chip = $('vt-chip');
    if (!spot || !chip) return;
    if (!el || T.away) { spot.hidden = true; chip.hidden = true; return; }
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
    spot.hidden = false;
    chip.hidden = !text;
    chip.innerHTML = text ? `<span class="vt-n">${n}</span> ${esc(text)}` : '';
    follow();
  }
  // The ring follows its part as the page scrolls and settles.
  function follow() {
    cancelAnimationFrame(T.raf);
    const step = () => {
      const spot = $('vt-spot'), chip = $('vt-chip');
      if (!T.on || !T.lit || !spot) return;
      // A page that redraws the part (Home's counts landing) leaves the ring on
      // a detached node: find the part again by its selector.
      if (!document.body.contains(T.lit.el) && T.lit.sel) {
        let again = null;
        try { again = document.querySelector(T.lit.sel); } catch (_) { again = null; }
        if (again) T.lit.el = again;
      }
      const r = T.lit.el.getBoundingClientRect();
      if (!r.width || !document.body.contains(T.lit.el)) { spot.hidden = true; chip.hidden = true; }
      else {
        const pad = 6;
        spot.hidden = T.away;
        // The card out of the way: to the top when it would cover the part
        // (a phone's station card is a sheet along the foot, as the guide is).
        const g = $('vt-guide');
        if (g && !g.hidden) {
          const gr = g.getBoundingClientRect(), top = g.classList.contains('vt-top');
          const covers = !(r.right < gr.left || r.left > gr.right || r.bottom < gr.top || r.top > gr.bottom);
          if (covers && !top && r.top > innerHeight * 0.4) g.classList.add('vt-top');
          else if (top && r.top < innerHeight * 0.45 && r.bottom < innerHeight - gr.height - 24) g.classList.remove('vt-top');
        }
        Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
        if (chip && T.lit.text && !T.away) {
          chip.hidden = false;
          const cw = chip.offsetWidth, ch = chip.offsetHeight;
          let x = r.right + 16, y = r.top + r.height / 2 - ch / 2;
          if (x + cw > innerWidth - 8) x = r.left - cw - 16;
          if (x < 8) { x = Math.max(8, Math.min(innerWidth - cw - 8, r.left)); y = r.bottom + 12 > innerHeight - ch - 8 ? r.top - ch - 12 : r.bottom + 12; }
          Object.assign(chip.style, { left: `${x}px`, top: `${Math.max(8, Math.min(innerHeight - ch - 8, y))}px` });
        }
      }
      T.raf = requestAnimationFrame(step);
    };
    T.raf = requestAnimationFrame(step);
  }
  // A part, once its page has drawn it: asked for again for a few seconds.
  function find(sel, cb, tries = 50) {
    let el = null;
    try { el = sel ? document.querySelector(sel) : null; } catch (_) { el = null; }
    // A part of the station card that a tab or a page is hiding: that tab or
    // page first (station-card-view.js), then it is there to ring.
    if (el && !el.getBoundingClientRect().width && typeof StnCardView !== 'undefined') StnCardView.reveal(el);
    if (el && el.getBoundingClientRect().width) { cb(el); return; }
    if (tries > 0 && T.on) setTimeout(() => find(sel, cb, tries - 1), 200);
    else cb(null);
  }

  // ── a scene ────────────────────────────────────────────────────────────────

  // Its page: the screenshot's tab, and its station.
  function navigate(meta) {
    const q = new URLSearchParams(String(meta.path || '').replace(/^\?/, ''));
    const tab = q.get('tab'), station = q.get('station');
    if (station && (tab === 'stations' || !tab) && typeof goToStation === 'function') {
      if (state.activeTab !== 'stations' || state.selectedId !== station) goToStation(station);
    } else if (tab && state.activeTab !== tab && typeof switchTab === 'function') switchTab(tab);
    // Scrolled as the screenshot was, a part into view.
    const scroll = (meta.steps || []).map(st => st.scroll).filter(Boolean).pop();
    if (scroll) find(scroll, el => { if (el) try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {} });
  }
  function enter(i) {
    T.i = i; T.shown = -1;
    light(null);
    const s = scenes()[i], meta = metaOf(s);
    if (meta) {
      navigate(meta);
      // Its focus first, without a name, until the first callout's cue.
      if (s.focus) find(selectorOf(meta, s.focus), el => { if (T.i === i && T.shown < 0) light(el, 0, '', selectorOf(meta, s.focus)); });
    }
    drawCard();
    if (typeof announce === 'function') announce(`Tour, ${i + 1} of ${scenes().length}: ${s.title}.`);
  }
  // The callout whose cue has come, spotlit.
  function cues() {
    const s = scenes()[T.i], meta = metaOf(s);
    if (!meta) return;
    const times = cueTimes(T.i);
    let k = -1;
    times.forEach((t, j) => { if (T.t + 0.05 >= t) k = j; });
    if (k === T.shown || k < 0) return;
    T.shown = k;
    const c = s.callouts[k], i = T.i;
    find(selectorOf(meta, c.target), el => { if (T.i === i && T.shown === k) light(el, k + 1, c.text, selectorOf(meta, c.target)); });
  }

  // ── the clock and the voices ───────────────────────────────────────────────

  function tick() {
    if (!T.on) return;
    const now = performance.now(), dt = now - T.last;
    T.last = now;
    if (T.sound && T.audio && T.v) {
      const at = T.audio.currentTime;
      let i = T.v.scenes.length - 1;
      while (i > 0 && at < T.v.scenes[i].start) i--;
      if (i !== T.i) enter(i);
      T.t = Math.max(0, at - T.v.scenes[i].start);
      if (T.audio.ended) { finish(); return; }
    } else {
      T.t += dt / 1000;
      if (T.t >= secsOf(T.i)) {
        if (T.i < scenes().length - 1) { T.t = 0; enter(T.i + 1); }
        else { finish(); return; }
      }
    }
    drawWords();
    cues();
  }
  function startClock() { stopClock(); T.last = performance.now(); T.timer = setInterval(tick, 100); }
  function stopClock() { if (T.timer) clearInterval(T.timer); T.timer = null; }
  function seekAudio() { if (T.sound && T.audio && T.v) { try { T.audio.currentTime = T.v.scenes[T.i].start + T.t; } catch (_) {} } }

  function play() {
    if (!T.on) return;
    if (T.ended) { T.ended = false; go(0); }
    T.playing = true;
    if (T.sound && T.audio) { seekAudio(); const p = T.audio.play(); if (p && p.catch) p.catch(() => { T.sound = false; }); }
    startClock();
    drawPlay();
  }
  function pause() {
    T.playing = false;
    stopClock();
    if (T.audio) T.audio.pause();
    drawPlay();
  }
  function toggle() { if (T.playing) pause(); else play(); }
  function go(i) {
    const n = scenes().length;
    T.ended = false; T.t = 0;
    enter(Math.max(0, Math.min(n - 1, i)));
    seekAudio();
    drawPlay();
  }
  function next() { if (T.i < scenes().length - 1) go(T.i + 1); }
  function prev() { go(T.t > 2.5 ? T.i : T.i - 1); }
  function finish() {
    pause();
    T.ended = true;
    light(null);
    drawPlay();
    const end = document.querySelector('#vt-end button'); if (end) end.focus();
    if (typeof announce === 'function') announce('End of the tour.');
  }

  // ✋ Try it yourself: the card away to a pill, the tour paused where it is.
  function away() {
    pause();
    T.away = true;
    const g = $('vt-guide'), p = $('vt-pill');
    if (g) g.hidden = true;
    if (p) p.hidden = false;
    light(T.lit && T.lit.el, T.lit && T.lit.n, T.lit && T.lit.text);
  }
  function back() {
    T.away = false;
    const g = $('vt-guide'), p = $('vt-pill');
    if (g) g.hidden = false;
    if (p) p.hidden = true;
    play();
  }

  // ── starting and leaving ──────────────────────────────────────────────────

  // opts: { video, voice (or null), shots, audioUrl, sound, who, portrait, draw(scene) → svg, cueIndex }
  function start(o) {
    leave();
    Object.assign(T, { on: true, b: o.video, v: o.voice || null, shots: o.shots || {}, draw: o.draw, cueIndex: o.cueIndex, who: o.who, portrait: o.portrait,
      sound: !!(o.sound && o.voice && o.audioUrl && typeof Audio !== 'undefined'), url: o.audioUrl, i: 0, t: 0, ended: false, away: false, from: state.activeTab });
    if (T.sound) { T.audio = new Audio(T.url); T.audio.preload = 'auto'; }
    mount();
    document.addEventListener('keydown', docKey, true);
    go(0);
    play();
    const g = $('vt-guide'); if (g) g.focus({ preventScroll: true });
  }
  function leave(toVideos) {
    if (!T.on && !document.getElementById('vt-host')) return;
    T.on = false;
    pause();
    cancelAnimationFrame(T.raf);
    if (T.audio) { T.audio.src = ''; T.audio = null; }
    document.removeEventListener('keydown', docKey, true);
    unmount();
    T.lit = null;
    if (toVideos && typeof switchTab === 'function') switchTab('videos');
  }
  // Esc anywhere leaves; the card's own keys are its own.
  function docKey(e) {
    if (e.key === 'Escape' && T.on && !document.querySelector('.modal-backdrop, dialog[open]')) { e.preventDefault(); leave(); }
  }
  function key(e) {
    const k = e.key;
    if (e.target && e.target.closest && e.target.closest('button') && (k === ' ' || k === 'Enter')) return;
    if (k === ' ') { e.preventDefault(); toggle(); }
    else if (k === 'ArrowRight') { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  return {
    start, leave, play, pause, toggle, go, next, prev, away, back, key,
    // For the tests: where the tour is, and what it has spotlit.
    _state: () => ({ on: T.on, i: T.i, t: T.t, playing: T.playing, ended: T.ended, away: T.away, sound: T.sound, shown: T.shown,
      lit: T.lit ? { n: T.lit.n, text: T.lit.text, tour: T.lit.el.getAttribute('data-tour'), id: T.lit.el.id, w: Math.round(T.lit.el.getBoundingClientRect().width) } : null }),
    _cueTimes: cueTimes, _selectorOf: selectorOf,
    // For the tests: the tour paused at scene i, t seconds in — its page, its words and its spotlight as they are then.
    _at: (i, t) => { pause(); go(i); T.t = t; drawWords(); cues(); },
  };
})();

if (typeof window !== 'undefined') window.VideoTour = VideoTour;
