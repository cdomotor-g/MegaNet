// MegaNet — health-bulletin.js
//
//   HealthBulletin   📺 Network Weather, at the top of the Station Health tab:
//                    the network's last day — or week — told as a short
//                    animated bulletin, a weather report about the network
//                    rather than the sky, presented by one of the Droggies.
//
// After core.js (esc, escAttr, announce, state), app.js and health.js (Health,
// whose page draws this one's panel first and whose stations the bulletin's
// station links open); read at call time. Nothing runs at load.
//
// ── Where a bulletin comes from ─────────────────────────────────────────────
// Not from this page. A scheduled Claude Code task runs every morning (and
// every Monday for the week), reads the network the way this tab does — the
// same health-analysis.js over the readings, the server's findings, the
// carrier fingerprints and bit-flip blame — looks further than the rules can
// (what several findings have in common, what the fingerprints say about who
// really transmitted), and writes what it found as a file of scenes:
// data/bulletins/<daily|weekly>/<date>.json, listed newest first in
// data/bulletins/index.json. tools/bulletin/README.md is that task's brief;
// tools/bulletin/validate.mjs is what a file may hold. This file only draws
// it: every scene is a small SVG drawn from the scene's own numbers, the
// narration revealed under it as the presenter "says" it (or read aloud, on
// asking), a scene's stations a press away from their place on this tab.
//
// Why drawn here and not a video. A file of numbers is a few kilobytes a day,
// works with no signal from the copy the service worker keeps, is the same
// in both themes and at any width, can be read as a transcript, and its
// stations are links. A rendered video would be none of those.
//
// ── What a person sees ──────────────────────────────────────────────────────
// The title card — the network's "forecast" (clear to stormy), the headline,
// four numbers — and ▶ Play. Playing, each scene runs its few seconds with
// its narration under it; the bar under the stage is the scenes, each a
// press away. ⏯ ⏮ ⏭, the space bar and the arrow keys on the stage, 🔊 for
// the browser's own voice, *Read it instead* for the whole script. A device
// remembers whether the panel was hidden and which bulletins it has played.
// Reduced motion: nothing plays by itself and the scenes are drawn finished.

const HealthBulletin = (() => {

  const INDEX = 'data/bulletins/index.json';
  const WIDE = { W: 1200, H: 750 }, TALL = { W: 720, H: 900 };
  const NARROW_PX = 620;                 // the stage below this is drawn tall
  const STALE = { daily: 36 * 3600e3, weekly: 9 * 86400e3 };

  // The crew, from the Droggies' canon (github.com/cdomotor-g/thedroggies,
  // characters/json/*.json): who they are, the lines they sign off with, and
  // the voice the browser reads them in. Their portraits are cropped from the
  // canon art into assets/presenters/. tools/bulletin/validate.mjs PRESENTERS
  // lists the same ids (test/bulletin.mjs holds the two together).
  const ROSTER = {
    'seasoned-hydrographer': { name: 'Graham Watts', role: 'Hydrographer', voice: { pitch: 0.8, rate: 0.95 },
      lines: ['It’s going to be a long day.', 'Might as well do it properly.'],
      alt: 'Graham Watts, a weathered hydrographer in a wide-brim hat and faded yellow hi-vis, gesturing wryly.' },
    'tech-wizard': { name: 'Alex Chen', role: 'Tech Wizard', voice: { pitch: 1.0, rate: 1.05 },
      lines: ['That’s not a fault, that’s a symptom.', 'Polarity matters.'],
      alt: 'Alex Chen, an intense technician in orange hi-vis and glasses, probing a logger cabinet with multimeter leads.' },
    'new-recruit': { name: 'The New Recruit', role: 'Keen but green', voice: { pitch: 1.15, rate: 1.05 },
      lines: ['Should I be writing this down?', 'Is it supposed to do that?'],
      alt: 'The New Recruit, a startled young hydrographer in box-fresh yellow hi-vis with a bulging backpack.' },
    turbo: { name: 'Turbo', role: 'Flat out at all times', voice: { pitch: 1.05, rate: 1.15 },
      lines: ['Personal best!', 'Race ya!'],
      alt: 'Turbo, grinning in an orange hi-vis vest and battered hat, striding forward and pointing ahead.' },
    nitwit: { name: 'Dale “Nitto”', role: 'Field hand', voice: { pitch: 1.25, rate: 1.1 },
      lines: ['Righto! I got this!', 'Billy’s up! Tea?'],
      alt: 'Nitto, a scruffy grinning field hand in rumpled yellow hi-vis, fumbling a water-level sensor.' },
    'know-it-all': { name: 'The Know-It-All', role: 'Claims expertise in everything', voice: { pitch: 1.0, rate: 1.1 },
      lines: ['It’s obvious.', 'I was just about to say that.'],
      alt: 'The Know-It-All, grinning in sunglasses and a cream hat, lecturing with a raised finger.' },
    'bean-counter': { name: 'The Bean Counter', role: 'Finance Services', voice: { pitch: 0.9, rate: 0.9 },
      lines: ['Every dollar has a job.', 'And how does that deliver value?'],
      alt: 'The Bean Counter, a balding finance officer in glasses and a pale blue shirt, holding a Budget Review clipboard.' },
  };
  const portrait = id => `assets/presenters/${ROSTER[id] ? id : 'seasoned-hydrographer'}.webp`;
  const who = id => ROSTER[id] || ROSTER['seasoned-hydrographer'];

  // The studio's own colours: a weather map is the same map in a light page
  // and a dark one, so the stage does not follow the theme — the panel round
  // it does. Every pair here is 4.5:1 or better on the stage's ground.
  const C = {
    ground: '#0b2234', ground2: '#103552', land: '#123f57', basin: '#2a6585', grid: '#173b55',
    dot: '#7fa9c7', text: '#f2f7fb', muted: '#a9c6db', faint: '#6f93ad',
    critical: '#ff6b6b', warn: '#ffb84d', info: '#74c7ff', ok: '#43dc9e', neutral: '#c9d8e6',
    accent: '#5fb4ff', relay: '#74c7ff', violet: '#c39bff',
  };
  const SEV_ICON = { critical: '⛔', warn: '⚠', info: 'ℹ', ok: '✓' };
  const SEV_WORD = { critical: 'Critical', warn: 'Warning', info: 'Note', ok: 'Good news' };
  const TONE = { ok: C.ok, warn: C.warn, bad: C.critical, neutral: C.neutral };
  const SKY_WORD = { clear: 'Clear', fair: 'Fair', patchy: 'Patchy', unsettled: 'Unsettled', stormy: 'Stormy' };

  const B = {
    index: null, indexErr: '', loading: false,
    kind: stored('mn-hb-kind', v => v === 'daily' || v === 'weekly') || 'daily',
    pick: { daily: null, weekly: null },     // the file chosen, or the newest
    files: new Map(),                        // file → bulletin | { error }
    scene: 0, t: 0, playing: false, ended: false, last: 0, timer: null,
    speak: stored('mn-hb-speak', v => v === '1') === '1',
    speaking: false, spokenWords: 0,
    hidden: stored('mn-hb-hidden', v => v === '1') === '1',
    narrow: null, drawnNarrow: null, ro: null,
    basins: null,                            // null | 'loading' | [{ bbox, rings }] | 'failed'
  };

  function stored(k, ok) { try { const v = localStorage.getItem(k); return v != null && ok(v) ? v : null; } catch (_) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} }
  function seen() { try { return new Set(JSON.parse(localStorage.getItem('mn-hb-seen') || '[]')); } catch (_) { return new Set(); } }
  function markSeen(id) {
    const s = seen(); if (s.has(id)) return;
    s.add(id); keep('mn-hb-seen', JSON.stringify([...s].slice(-60)));
  }
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stationName = id => {
    const st = ((typeof state !== 'undefined' && state.data && state.data.stations) || []).find(s => s.id === id);
    return st ? st.name : null;
  };
  const stationAt = id => {
    const st = ((typeof state !== 'undefined' && state.data && state.data.stations) || []).find(s => s.id === id);
    return st && Number.isFinite(+st.lat) && Number.isFinite(+st.lon) ? { lat: +st.lat, lon: +st.lon, name: st.name } : null;
  };

  // ── loading ────────────────────────────────────────────────────────────────

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }
  async function loadIndex() {
    if (B.loading) return;
    B.loading = true; B.indexErr = '';
    try { B.index = await getJson(INDEX); }
    catch (err) { B.index = null; B.indexErr = (err && err.message) || String(err); }
    B.loading = false;
    // The kind remembered on this device, unless there is none of it yet and
    // there is of the other.
    const other = B.kind === 'daily' ? 'weekly' : 'daily';
    if (!entries(B.kind).length && entries(other).length) B.kind = other;
    await loadCurrent();
  }
  function entries(kind) { return (B.index && Array.isArray(B.index[kind]) ? B.index[kind] : []); }
  function currentFile(kind) {
    const k = kind || B.kind, l = entries(k);
    return B.pick[k] && l.some(e => e.file === B.pick[k]) ? B.pick[k] : (l[0] ? l[0].file : null);
  }
  function current() { const f = currentFile(); const b = f && B.files.get(f); return b && !b.error ? b : null; }
  async function loadCurrent() {
    const f = currentFile();
    if (f && !B.files.has(f)) {
      B.files.set(f, { loading: true });
      try { B.files.set(f, await getJson(f)); }
      catch (err) { B.files.set(f, { error: (err && err.message) || String(err) }); }
    }
    resetPlay();
    redraw();
  }
  // Fixtures, for the tests and for working offline: the index and the files
  // it names, in place of fetching them.
  function adopt(index, files) {
    B.index = index; B.indexErr = '';
    B.files = new Map(Object.entries(files || {}));
    resetPlay();
    redraw();
  }

  // ── the panel ──────────────────────────────────────────────────────────────

  function render() {
    // data-no-lede: not the tab's introduction, which the Calm look folds
    // (calm-shell.js) — that is Station Health's own, under this.
    return `<section class="panel hb${B.hidden ? ' hb--hidden' : ''}" id="hb-panel" aria-labelledby="hb-h" data-no-lede>${panelInner()}</section>`;
  }
  function panelInner() {
    const b = current();
    const kinds = [['daily', 'Today'], ['weekly', 'This week']].map(([k, label]) => {
      const e = entries(k)[0];
      const fresh = e && !seen().has(e.id) ? '<span class="hb-new" aria-label="not yet played on this device">new</span>' : '';
      return `<button class="hl-chip${B.kind === k ? ' hl-chip--on' : ''}" aria-pressed="${B.kind === k}" onclick="HealthBulletin.setKind('${k}')"
        ${e ? '' : 'disabled title="None issued yet"'}>${esc(label)}${fresh}</button>`;
    }).join('');
    const list = entries(B.kind);
    const picker = list.length > 1 ? `<label class="hb-pick"><span class="sr-only">Earlier bulletins</span>
      <select onchange="HealthBulletin.pick(this.value)">${list.map(e => `<option value="${escAttr(e.file)}"${e.file === currentFile() ? ' selected' : ''}>${esc(fmtIssue(e))}</option>`).join('')}</select></label>` : '';
    const head = `<div class="panel-header hb-head">
        <h2 id="hb-h"><span aria-hidden="true">📺</span> Network Weather</h2>
        <div class="button-group hb-tools">
          <span class="hl-seg" role="group" aria-label="Which bulletin">${kinds}</span>${picker}
          <button class="ghost" onclick="HealthBulletin.toggleHidden()" aria-expanded="${!B.hidden}" aria-controls="hb-body">${B.hidden ? 'Show' : 'Hide'}</button>
        </div>
      </div>`;
    if (B.hidden) return head + `<p class="small hb-folded">${b ? `${esc(skyLabel(b))} — ${esc(b.headline)}` : 'The network’s bulletin, hidden on this device.'}</p>`;
    return head + `<div id="hb-body">${bodyHtml()}</div>`;
  }
  function skyLabel(b) { return (b.outlook && b.outlook.label) || SKY_WORD[b.outlook && b.outlook.sky] || ''; }
  function fmtIssue(e) {
    const d = new Date(e.issued_at);
    const day = isNaN(d) ? e.id : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${day} — ${SKY_WORD[e.sky] || ''}`;
  }

  function bodyHtml() {
    if (B.loading && !B.index) return '<p class="small hb-note">Fetching the latest bulletin…</p>';
    if (!B.index) {
      return `<p class="small hb-note">${B.indexErr ? `No bulletin to show — ${esc(B.indexErr)}.` : 'No bulletin yet.'}
        A scheduled task writes one every morning, and one for the week on Mondays (<a href="tools/bulletin/README.md" target="_blank" rel="noopener">how</a>).</p>`;
    }
    const f = currentFile();
    if (!f) return `<p class="small hb-note">No ${B.kind === 'weekly' ? 'weekly' : 'daily'} bulletin has been issued yet.</p>`;
    const got = B.files.get(f);
    if (!got || got.loading) return '<p class="small hb-note">Fetching the bulletin…</p>';
    if (got.error) return `<p class="small hb-note txt-warn">The bulletin could not be read — ${esc(got.error)}.</p>`;
    const b = got, P = who(b.presenter), sc = b.scenes || [];
    const stale = Date.now() - Date.parse(b.issued_at) > STALE[b.kind || 'daily'];
    return `
      <p class="small hb-issued">${esc(issuedText(b))}${stale ? ` <span class="txt-warn">— ${b.kind === 'weekly' ? 'over a week' : 'more than a day'} old: the scheduled bulletin may have stopped.</span>` : ''}</p>
      <div class="hb-studio">
        <div class="hb-stage${stageState()}" id="hb-stage" tabindex="0" role="group"
             aria-roledescription="bulletin" aria-label="${escAttr(`${b.kind === 'weekly' ? 'Weekly' : 'Daily'} network bulletin, ${sc.length} scenes. Space plays or pauses; arrow keys move between scenes.`)}"
             onkeydown="HealthBulletin.key(event)" onclick="HealthBulletin.stageClick(event)">
          <div class="hb-svgbox" id="hb-svgbox">${sceneSvg(b, B.scene)}</div>
          <div class="hb-lower" id="hb-lower">${lowerHtml(b, B.scene)}</div>
          ${!B.playing && B.t === 0 ? `<button class="hb-bigplay" onclick="event.stopPropagation(); HealthBulletin.play()">
              <span aria-hidden="true">${B.ended ? '↻' : '▶'}</span> ${B.ended ? 'Watch again' : `Play the bulletin · ${esc(fmtDur(totalSecs(b)))}`}</button>` : ''}
        </div>
        <aside class="hb-rail" aria-label="Presenter">
          <figure class="hb-presenter" id="hb-presenter">${presenterHtml(b, B.scene)}</figure>
          <div class="hb-chips" id="hb-chips">${chipsHtml(b, B.scene)}</div>
        </aside>
      </div>
      <div class="hb-bar" id="hb-bar" role="group" aria-label="Scenes">${barHtml(b)}</div>
      <div class="hb-caption" id="hb-caption">${captionHtml(b, B.scene)}</div>
      <div class="hb-controls">
        <button class="ghost hb-btn" onclick="HealthBulletin.prev()" aria-label="Previous scene" title="Previous scene (←)">⏮</button>
        <button class="hb-btn hb-btn--main" id="hb-play" onclick="HealthBulletin.toggle()" aria-label="${B.playing ? 'Pause' : 'Play'}">${B.playing ? '⏸ Pause' : '▶ Play'}</button>
        <button class="ghost hb-btn" onclick="HealthBulletin.next()" aria-label="Next scene" title="Next scene (→)">⏭</button>
        <span class="small hb-clock" id="hb-clock">${esc(clockText(b))}</span>
        ${typeof speechSynthesis !== 'undefined' ? `<button class="ghost hb-btn" onclick="HealthBulletin.toggleSpeak()" aria-pressed="${B.speak}"
            title="Read the narration aloud in this browser's own voice">${B.speak ? '🔊 Reading aloud' : '🔈 Read aloud'}</button>` : ''}
      </div>
      <details class="hb-transcript"><summary>Read it instead</summary>
        <ol>${sc.map((s, i) => `<li><b>${esc(s.title)}.</b> ${esc(s.say)}${(s.stations || []).length ? ` <span class="small">(${stationLinks(s.stations)})</span>` : ''}
          <button class="link-btn small" onclick="HealthBulletin.go(${i})">show</button></li>`).join('')}</ol>
        ${(b.caveats || []).length ? `<p class="small"><b>What it could not tell:</b> ${b.caveats.map(esc).join(' ')}</p>` : ''}
      </details>
      <p class="small hb-foot">${esc(footText(b, P))}</p>`;
  }

  // Playing: the scene runs. Paused part-way: frozen where it was. Not started
  // (or moved to while paused): drawn finished — a frozen first frame of a
  // scene that fades in is an empty stage.
  // With reduced motion asked for, a playing scene is drawn finished too: the
  // scenes and the narration move on, nothing on the stage does.
  function stageState() { return B.playing ? (reduced() ? ' is-still' : '') : B.t === 0 ? ' is-still' : ' is-paused'; }

  function issuedText(b) {
    const d = new Date(b.issued_at);
    const when = isNaN(d) ? '' : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `${b.kind === 'weekly' ? 'The week' : 'The last 24 hours'} — ${b.period && b.period.label ? b.period.label : ''}. Issued ${when}.`;
  }
  function footText(b, P) {
    const src = b.sources || {};
    const bits = [];
    if (src.readings) bits.push(`${Number(src.readings).toLocaleString()} readings`);
    if (src.stations_heard) bits.push(`${Number(src.stations_heard).toLocaleString()} stations heard`);
    return `Presented by ${P.name} (from the Droggies). Written by ${b.author || 'Claude'}${bits.length ? ` from ${bits.join(' and ')}` : ''}. `
      + 'It points at what needs a look and why it might be; it does not diagnose — check the station on this tab before driving out.';
  }
  function stationLinks(ids) {
    return ids.map(id => `<button class="link-btn" onclick="HealthBulletin.open('${escAttr(id)}')">${esc(stationName(id) || id)}</button>`).join(', ');
  }

  const totalSecs = b => (b.scenes || []).reduce((n, s) => n + (+s.secs || 8), 0);
  function fmtDur(s) { s = Math.round(s); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}` : `${s} s`; }
  function clockText(b) {
    const before = (b.scenes || []).slice(0, B.scene).reduce((n, s) => n + (+s.secs || 8), 0);
    const at = before + Math.min(B.t / 1000, +((b.scenes || [])[B.scene] || {}).secs || 8);
    const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    return `Scene ${B.scene + 1} of ${(b.scenes || []).length} · ${mmss(at)} / ${mmss(totalSecs(b))}`;
  }
  function barHtml(b) {
    const total = totalSecs(b) || 1;
    return (b.scenes || []).map((s, i) => `<button class="hb-seg${i === B.scene ? ' is-on' : ''}${i < B.scene ? ' is-done' : ''}" style="--f:${((+s.secs || 8) / total).toFixed(4)}"
        onclick="HealthBulletin.go(${i})" aria-label="${escAttr(`Scene ${i + 1}: ${s.title}`)}" title="${escAttr(s.title)}"${i === B.scene ? ' aria-current="step"' : ''}>
        <span class="hb-seg-fill" style="--p:${i < B.scene ? 100 : i === B.scene ? progressPct(s).toFixed(1) : 0}%"></span></button>`).join('');
  }
  function progressPct(s) { return Math.max(0, Math.min(100, 100 * B.t / (1000 * (+s.secs || 8)))); }
  function sceneOf(b, i) { return (b.scenes || [])[i] || null; }
  function speakerOf(b, s) { return (s && s.presenter) || b.presenter; }
  function presenterHtml(b, i) {
    const id = speakerOf(b, sceneOf(b, i)), P = who(id);
    return `<img src="${escAttr(portrait(id))}" alt="${escAttr(P.alt)}" width="320" height="400" loading="lazy" decoding="async"
        class="${B.playing ? 'is-talking' : ''}">
      <figcaption><b>${esc(P.name)}</b><span>${esc(P.role)}</span></figcaption>`;
  }
  function chipsHtml(b, i) {
    const s = sceneOf(b, i), ids = (s && s.stations) || [];
    if (!ids.length) return '';
    return `<span class="small hb-chips-k">On this tab:</span> ${ids.map(id => `<button class="hl-chip hl-chip--sm" onclick="HealthBulletin.open('${escAttr(id)}')"
      title="Pause and open this station below">${esc(stationName(id) || id)}</button>`).join(' ')}`;
  }
  function lowerHtml(b, i) {
    const s = sceneOf(b, i);
    if (!s) return '';
    const sev = s.sev && s.sev !== 'info' ? `<span class="hb-lower-sev hb-sev--${escAttr(s.sev)}">${SEV_ICON[s.sev] || ''} ${esc(SEV_WORD[s.sev] || '')}</span>` : '';
    return `<div class="hb-lower-t">${sev}${esc(s.title)}</div>${s.sub ? `<div class="hb-lower-s">${esc(s.sub)}</div>` : ''}`;
  }
  function captionHtml(b, i) {
    const s = sceneOf(b, i);
    if (!s) return '';
    const id = speakerOf(b, s), P = who(id);
    const words = String(s.say || '').split(/\s+/).filter(Boolean);
    const shown = B.t === 0 && !B.playing ? words.length : revealCount(s, words.length);
    return `<img class="hb-avatar" src="${escAttr(portrait(id))}" alt="" width="64" height="80" loading="lazy">
      <p><span class="hb-speaker">${esc(P.name)}:</span> ${words.map((w, k) => `<span class="hb-w${k < shown ? ' is-said' : ''}">${esc(w)} </span>`).join('')}</p>`;
  }
  function revealCount(s, n) {
    if (B.speak && B.speaking) return B.spokenWords;
    const secs = (+s.secs || 8) * 0.82;
    return Math.min(n, Math.ceil(n * (B.t / 1000) / secs));
  }

  // ── the scenes ─────────────────────────────────────────────────────────────

  function sceneSvg(b, i) {
    const s = sceneOf(b, i);
    if (!s) return '';
    const L = layout();
    let inner;
    try { inner = (DRAW[s.type] || drawUnknown)(s, b, L); }
    catch (err) { inner = drawUnknown(s, b, L, err); }
    return `<svg class="hb-svg hb-t-${escAttr(s.type)}" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="${escAttr(s.title)}"
      preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="hb-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.ground2}"/><stop offset="1" stop-color="${C.ground}"/></linearGradient></defs>
      <rect width="${L.W}" height="${L.H}" fill="url(#hb-g)"/>${inner}</svg>`;
  }
  function layout() {
    const narrow = B.narrow != null ? B.narrow : (typeof innerWidth === 'number' && innerWidth < 700);
    B.drawnNarrow = narrow;
    const D = narrow ? TALL : WIDE;
    // Text sizes, in the stage's own units: big enough to read on a phone
    // (the tall stage is about 340 px across there) and on a wall.
    const F = narrow ? { xs: 24, s: 28, m: 34, l: 44, xl: 64, xxl: 92 } : { xs: 18, s: 22, m: 28, l: 38, xl: 56, xxl: 84 };
    // The lower third covers the foot of the stage; nothing that matters goes there.
    return { ...D, F, narrow, pad: narrow ? 36 : 48, foot: narrow ? 150 : 118 };
  }
  const d = s => `style="--d:${(+s).toFixed(2)}s"`;
  const dd = (s, extra) => `style="--d:${(+s).toFixed(2)}s;${extra}"`;
  const sevC = s => C[s] || C.info;
  function wrap(text, chars, maxLines) {
    const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > chars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) lines.push(cur);
    if (maxLines && lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s,;:.]*\S*$/, '') + '…';
    }
    return lines;
  }
  const charsFor = (width, size) => Math.max(8, Math.floor(width / (size * 0.54)));
  function text(x, y, str, size, attrs = '', lines = null, lh = 1.22) {
    const ls = lines || [String(str)];
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" ${attrs}>${ls.map((l, k) =>
      `<tspan x="${x.toFixed(1)}" dy="${k ? (size * lh).toFixed(1) : 0}">${esc(l)}</tspan>`).join('')}</text>`;
  }
  const halo = `paint-order="stroke" stroke="${C.ground}" stroke-width="6" stroke-linejoin="round"`;
  const fmt = (v, dp = 1) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toFixed(dp));
  const signed = (v, dp = 1) => (v == null || !Number.isFinite(+v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(dp)}`);

  function drawUnknown(s, b, L, err) {
    return text(L.W / 2, L.H / 2 - 20, err ? 'This scene could not be drawn' : `A “${s.type}” scene — this page does not know how to draw it`,
      L.F.m, `text-anchor="middle" fill="${C.muted}"`)
      + text(L.W / 2, L.H / 2 + 24, 'Its narration is below, and in Read it instead.', L.F.s, `text-anchor="middle" fill="${C.faint}"`);
  }

  // ── title: the forecast, the headline and the numbers ──
  function drawTitle(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const sky = (b.outlook && b.outlook.sky) || 'fair';
    const when = new Date(b.issued_at);
    const day = isNaN(when) ? '' : when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase();
    const kicker = b.kind === 'weekly' ? 'THE WEEK ON THE NETWORK' : 'THE NETWORK WEATHER';
    let out = '';
    out += `<g class="hb-a-fade" ${d(0.1)}>${text(pad, pad + F.s, kicker, F.s, `fill="${C.accent}" font-weight="700" letter-spacing="3"`)}`
      + text(pad, pad + F.s * 2.3, day, F.xs, `fill="${C.muted}" letter-spacing="2"`) + '</g>';
    const gx = narrow ? W - pad - 170 : pad + 150, gy = narrow ? pad + 150 : 290, gs = narrow ? 0.8 : 1.15;
    out += `<g transform="translate(${gx} ${gy}) scale(${gs})"><g class="hb-a-pop" ${d(0.3)}>${skyGlyph(sky)}</g></g>`;
    const tx = narrow ? pad : 360, tw = W - tx - pad;
    const ty = narrow ? 300 : 200;
    out += `<g class="hb-a-rise" ${d(0.6)}>${text(tx, ty, skyLabel(b), F.l, `fill="${sevSky(sky)}" font-weight="700"`)}</g>`;
    const hl = wrap(b.headline, charsFor(tw, F.m), narrow ? 4 : 3);
    out += `<g class="hb-a-rise" ${d(1.0)}>${text(tx, ty + F.l * 1.3, '', F.m, `fill="${C.text}" font-weight="600"`, hl)}</g>`;
    // The numbers: four tiles across (two by two on a phone).
    const stats = (b.stats || []).slice(0, 4);
    if (stats.length) {
      const cols = narrow ? 2 : stats.length, rows = Math.ceil(stats.length / cols);
      const gap = narrow ? 14 : 18, tileW = (W - pad * 2 - gap * (cols - 1)) / cols, tileH = narrow ? 118 : 150;
      const top = narrow ? H - L.foot - rows * tileH - (rows - 1) * gap - 8 : H - L.foot - tileH - 26;
      stats.forEach((st, k) => {
        const x = pad + (k % cols) * (tileW + gap), y = top + Math.floor(k / cols) * (tileH + gap);
        const col = TONE[st.tone] || C.text;
        const delta = st.was != null && typeof st.value === 'number' ? st.value - st.was : null;
        out += `<g class="hb-a-rise" ${d(1.4 + k * 0.25)}>
          <rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="14" fill="${C.ground}" fill-opacity=".55" stroke="${C.grid}"/>
          <text x="${x + 20}" y="${y + (narrow ? F.l + 18 : F.xl + 10)}" font-size="${narrow ? F.l * 1.25 : F.xl}" font-weight="700" fill="${col}" ${typeof st.value === 'number' ? `data-count="${st.value}"` : ''}>${esc(fmtStat(st.value))}<tspan font-size="${F.s}" fill="${C.muted}" dx="6">${esc(st.unit || '')}</tspan></text>
          ${text(x + 20, y + (narrow ? F.l * 1.25 + 26 : F.xl + 16) + F.s * (narrow ? 0.6 : 1), st.label, narrow ? F.xs : F.s, `fill="${C.muted}"`, wrap(st.label, charsFor(tileW - 40, narrow ? F.xs : F.s), 1))}
          ${delta != null && delta !== 0 ? text(x + tileW - 18, y + 36, `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toLocaleString()}`, F.xs, `text-anchor="end" fill="${C.faint}"`) : ''}
        </g>`;
      });
    }
    return out;
  }
  const fmtStat = v => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 })) : String(v));
  const sevSky = sky => ({ clear: C.ok, fair: C.ok, patchy: C.warn, unsettled: C.warn, stormy: C.critical }[sky] || C.text);

  // The forecast, drawn: a sun, a cloud, rain, a storm. Centred on 0,0, about
  // 260 across.
  function skyGlyph(sky) {
    const sun = (x, y, r) => `<g class="hb-sun" transform="translate(${x} ${y})"><g class="hb-spin">${Array.from({ length: 12 }, (_, k) =>
        `<line x1="0" y1="${-(r + 14)}" x2="0" y2="${-(r + 36)}" stroke="#ffd166" stroke-width="9" stroke-linecap="round" transform="rotate(${k * 30})"/>`).join('')}</g>
        <circle r="${r}" fill="#ffd166"/></g>`;
    const cloud = (x, y, k, fill) => `<g transform="translate(${x} ${y}) scale(${k})"><g class="hb-drift" fill="${fill}">
        <circle cx="-48" cy="10" r="38"/><circle cx="0" cy="-18" r="52"/><circle cx="52" cy="6" r="40"/><rect x="-86" y="10" width="176" height="44" rx="22"/></g></g>`;
    const rain = (n, col) => Array.from({ length: n }, (_, k) =>
      `<line class="hb-rain" ${dd(k * 0.17, '')} x1="${-60 + k * 30}" y1="70" x2="${-70 + k * 30}" y2="98" stroke="${col}" stroke-width="7" stroke-linecap="round"/>`).join('');
    switch (sky) {
      case 'clear': return sun(0, 0, 62);
      case 'fair': return sun(-30, -30, 50) + cloud(40, 40, 0.7, '#e9f1f7');
      case 'patchy': return sun(-46, -46, 44) + cloud(10, 18, 0.95, '#d8e4ee');
      case 'unsettled': return cloud(0, 0, 1, '#b9c9d6') + rain(5, '#74c7ff');
      default: return cloud(0, -6, 1.05, '#7d8ea0') + rain(5, '#74c7ff')
        + '<path class="hb-bolt" d="M6 34 L-22 92 L4 92 L-12 140 L38 72 L12 72 L28 34 Z" fill="#ffd166" stroke="#0b2234" stroke-width="3"/>';
    }
  }

  // ── map: the synoptic chart — the network, its lows and its links ──
  function drawMap(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const marks = (s.marks || []).map(m => {
      const at = (m.lat == null || m.lon == null) && m.id ? stationAt(m.id) : null;
      return Object.assign({}, m, { lat: m.lat != null ? +m.lat : at && at.lat, lon: m.lon != null ? +m.lon : at && at.lon });
    }).filter(m => Number.isFinite(m.lat) && Number.isFinite(m.lon));
    const at = e => (typeof e === 'string' ? (marks.find(m => m.id === e) || stationAt(e)) : Array.isArray(e) ? { lat: e[0], lon: e[1] } : null);
    const links = (s.links || []).map(l => ({ l, a: at(l.from), z: at(l.to) })).filter(x => x.a && x.z);
    const areas = (s.areas || []).filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));
    // What is in view: the focus asked for, else everything the scene names.
    let bb;
    if (s.focus && Number.isFinite(s.focus.lat) && Number.isFinite(s.focus.lon)) {
      const km = +s.focus.km || 80, dl = km / 111.32, dn = km / (111.32 * Math.cos(s.focus.lat * Math.PI / 180));
      bb = { s: s.focus.lat - dl, n: s.focus.lat + dl, w: s.focus.lon - dn, e: s.focus.lon + dn };
    } else {
      const pts = [...marks, ...areas, ...links.flatMap(x => [x.a, x.z])];
      bb = pts.reduce((o, p) => ({ s: Math.min(o.s, p.lat), n: Math.max(o.n, p.lat), w: Math.min(o.w, p.lon), e: Math.max(o.e, p.lon) }),
        { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity });
      areas.forEach(a => { const dl = a.km / 111.32; bb.s = Math.min(bb.s, a.lat - dl); bb.n = Math.max(bb.n, a.lat + dl); });
      const mid = (bb.s + bb.n) / 2;
      const padLat = Math.max(0.25, (bb.n - bb.s) * 0.18), padLon = Math.max(0.25 / Math.cos(mid * Math.PI / 180), (bb.e - bb.w) * 0.18);
      bb = { s: bb.s - padLat, n: bb.n + padLat, w: bb.w - padLon, e: bb.e + padLon };
    }
    const box = { x: pad * 0.5, y: pad * 0.5, w: W - pad, h: H - L.foot - pad * 0.5 };
    const P = projector(bb, box);
    let out = `<g class="hb-grid" stroke="${C.grid}" stroke-width="1">${gridLines(P, box)}</g>`;
    out += `<g id="hb-basins">${basinsSvg(P, box)}</g>`;
    // The network itself, every station on file in view, faint: the stars the
    // scene's own marks stand out from.
    const all = ((typeof state !== 'undefined' && state.data && state.data.stations) || []);
    let dots = '';
    for (const st of all) {
      const la = +st.lat, lo = +st.lon;
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      const x = P.x(lo), y = P.y(la);
      if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue;
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${narrow ? 3 : 2.4}"/>`;
    }
    out += `<g fill="${C.dot}" fill-opacity=".38" class="hb-a-fade" ${d(0.1)}>${dots}</g>`;
    // Where the marks will sit, so no label lands on one.
    const order = { ok: 0, info: 1, warn: 2, critical: 3 };
    const placed = [];
    const markR = narrow ? 16 : 13;
    marks.forEach(m => { const x = P.x(m.lon), y = P.y(m.lat); placed.push({ x0: x - markR, y0: y - markR, x1: x + markR, y1: y + markR }); });
    const fits = rect => rect.x0 >= 4 && rect.x1 <= W - 4 && rect.y0 >= 4 && rect.y1 <= H - L.foot
      && !placed.some(p => !(rect.x1 < p.x0 || rect.x0 > p.x1 || rect.y1 < p.y0 || rect.y0 > p.y1));
    // Lows and highs: an area in trouble is a low, isobars round it; one all
    // checked in is a high.
    areas.forEach((a, k) => {
      const x = P.x(a.lon), y = P.y(a.lat), r = Math.max(28, a.km / P.kmPerUnit), col = sevC(a.sev);
      const low = a.sev !== 'ok';
      // Its name above it, else below, else beside: wherever nothing else is.
      let lab = '';
      if (a.label) {
        const fs = F.s, w = a.label.length * fs * 0.56 + 10;
        for (const [ly, anchor, lx] of [[y - r - 10, 'middle', x], [y + r + fs + 4, 'middle', x], [y + fs * 0.36, 'start', x + r + 10], [y + fs * 0.36, 'end', x - r - 10]]) {
          const x0 = anchor === 'middle' ? lx - w / 2 : anchor === 'start' ? lx : lx - w;
          const rect = { x0, y0: ly - fs, x1: x0 + w, y1: ly + fs * 0.25 };
          if (!fits(rect)) continue;
          placed.push(rect);
          lab = text(lx, ly, a.label, fs, `text-anchor="${anchor}" font-weight="700" fill="${col}" ${halo}`);
          break;
        }
      }
      placed.push({ x0: x - F.l * 0.4, y0: y - F.l * 0.5, x1: x + F.l * 0.4, y1: y + F.l * 0.5 });
      out += `<g class="hb-a-fade" ${d(0.5 + k * 0.4)}>${[1, 0.72, 0.45].map((f, j) =>
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * f).toFixed(1)}" fill="${j === 0 ? col : 'none'}" fill-opacity="${j === 0 ? 0.08 : 0}" stroke="${col}" stroke-opacity="${0.85 - j * 0.2}" stroke-width="${j === 0 ? 2.5 : 2}" stroke-dasharray="${j === 0 ? '' : '10 8'}"/>`).join('')}
        <circle class="hb-a-pulse" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * 0.45).toFixed(1)}" fill="none" stroke="${col}" stroke-width="3" ${d(0.9 + k * 0.4)}/>
        ${text(x, y + F.l * 0.36, low ? 'L' : 'H', F.l, `text-anchor="middle" font-weight="800" fill="${col}" ${halo}`)}
        ${lab}</g>`;
    });
    // The links: who relays whom, and where the blame points.
    links.forEach(({ l, a, z }, k) => {
      const x1 = P.x(a.lon), y1 = P.y(a.lat), x2 = P.x(z.lon), y2 = P.y(z.lat);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const cx = mx - dy * 0.12, cy = my + dx * 0.12;
      const col = { relay: C.relay, blame: C.critical, path: C.neutral, clean: C.ok }[l.style] || C.relay;
      const dash = l.style === 'relay' ? 'stroke-dasharray="12 10" class="hb-flow"' : `class="hb-a-draw" style="--d:${(1.0 + k * 0.3).toFixed(2)}s;--len:${Math.ceil(len * 1.1)}"`;
      out += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${col}"
        stroke-width="${l.style === 'blame' ? 4 : 2.5}" stroke-opacity=".9" ${dash}/>`;
    });
    // The marks, worst last so they sit on top; labels placed where they fit.
    const sorted = marks.slice().sort((m1, m2) => (order[m1.sev] || 0) - (order[m2.sev] || 0));
    sorted.forEach((m, k) => {
      const x = P.x(m.lon), y = P.y(m.lat), col = sevC(m.sev), r = markR;
      const t0 = 0.8 + k * 0.12;
      out += `<g class="hb-mark${m.id ? ' hb-hit' : ''}" ${m.id ? `data-stn="${escAttr(m.id)}"` : ''} transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        ${m.sev === 'critical' || m.sev === 'warn' ? `<circle class="hb-a-pulse" r="${r}" fill="none" stroke="${col}" stroke-width="3" ${d(t0 + 0.4)}/>` : ''}
        <g class="hb-a-pop" ${d(t0)}><circle r="${r}" fill="${C.ground}" stroke="${col}" stroke-width="3.5"/>${markIcon(m.kind, col, r * 0.62)}</g>
        ${m.id ? `<title>${esc((m.label || stationName(m.id) || m.id) + ' — open it on this tab')}</title>` : ''}</g>`;
      if (m.label) {
        const fs = F.s, w = m.label.length * fs * 0.56 + 8, h = fs * 1.25;
        const tries = [[r + 8, fs * 0.36, 'start'], [-r - 8, fs * 0.36, 'end'], [0, -r - 10, 'middle'], [0, r + fs + 4, 'middle'],
                       [r + 8, -r, 'start'], [r + 8, r + fs * 0.7, 'start'], [-r - 8, -r, 'end'], [-r - 8, r + fs * 0.7, 'end']];
        for (const [ox, oy, anchor] of tries) {
          const lx = x + ox, x0 = anchor === 'start' ? lx : anchor === 'end' ? lx - w : lx - w / 2, y0 = y + oy - fs;
          const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
          if (!fits(rect)) continue;
          placed.push(rect);
          out += `<g class="hb-a-fade" ${d(t0 + 0.3)}>${text(lx, y + oy, m.label, fs, `text-anchor="${anchor}" font-weight="600" fill="${C.text}" ${halo}`)}</g>`;
          break;
        }
      }
    });
    out += scaleBar(P, box, F);
    return out;
  }
  function projector(bb, box) {
    const mid = (bb.s + bb.n) / 2, kx = Math.cos(mid * Math.PI / 180);
    const sx = Math.max(1e-6, (bb.e - bb.w) * kx), sy = Math.max(1e-6, bb.n - bb.s);
    const k = Math.min(box.w / sx, box.h / sy);
    const ox = box.x + (box.w - sx * k) / 2, oy = box.y + (box.h - sy * k) / 2;
    return { x: lon => ox + (lon - bb.w) * kx * k, y: lat => oy + (bb.n - lat) * k, kmPerUnit: 111.32 / k,
             lon: x => bb.w + (x - ox) / (kx * k), lat: y => bb.n - (y - oy) / k };
  }
  function gridLines(P, box) {
    // A line every half degree, or every degree, or two: ten-odd across.
    const span = Math.abs(P.lon(box.x + box.w) - P.lon(box.x));
    const step = span > 12 ? 2 : span > 5 ? 1 : span > 2 ? 0.5 : 0.25;
    let out = '';
    for (let lo = Math.ceil(P.lon(box.x) / step) * step; lo <= P.lon(box.x + box.w); lo += step) out += `<line x1="${P.x(lo).toFixed(1)}" y1="${box.y}" x2="${P.x(lo).toFixed(1)}" y2="${box.y + box.h}"/>`;
    for (let la = Math.ceil(P.lat(box.y + box.h) / step) * step; la <= P.lat(box.y); la += step) out += `<line x1="${box.x}" y1="${P.y(la).toFixed(1)}" x2="${box.x + box.w}" y2="${P.y(la).toFixed(1)}"/>`;
    return out;
  }
  function scaleBar(P, box, F) {
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500];
    const want = P.kmPerUnit * box.w * 0.18;
    const km = nice.reduce((p, v) => (Math.abs(v - want) < Math.abs(p - want) ? v : p), nice[0]);
    const len = km / P.kmPerUnit, x = box.x + 14, y = box.y + 30;
    return `<g class="hb-a-fade" ${d(0.3)}><line x1="${x}" y1="${y}" x2="${(x + len).toFixed(1)}" y2="${y}" stroke="${C.muted}" stroke-width="3"/>
      <line x1="${x}" y1="${y - 7}" x2="${x}" y2="${y + 7}" stroke="${C.muted}" stroke-width="3"/><line x1="${(x + len).toFixed(1)}" y1="${y - 7}" x2="${(x + len).toFixed(1)}" y2="${y + 7}" stroke="${C.muted}" stroke-width="3"/>
      ${text(x + len + 10, y + F.xs * 0.36, `${km} km`, F.xs, `fill="${C.muted}"`)}</g>`;
  }
  function markIcon(kind, col, r) {
    const s = r / 10, sw = Math.min(4, 2.6 / s).toFixed(2);
    const g = body => `<g transform="scale(${s.toFixed(3)})" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
    switch (kind) {
      case 'silent': return g('<path d="M-6 -6 L6 6 M6 -6 L-6 6"/>');
      case 'battery': return g(`<rect x="-8" y="-5" width="14" height="10" rx="1.5"/><path d="M8 -2 V2"/><rect x="-6" y="-3" width="5" height="6" fill="${col}" stroke="none"/>`);
      case 'flip': return `<g transform="scale(${s.toFixed(3)})"><path d="M2 -10 L-6 2 H0 L-2 10 L6 -2 H0 Z" fill="${col}"/></g>`;
      case 'carrier': return g('<path d="M-9 0 C-6 -8 -3 -8 0 0 S6 8 9 0"/>');
      case 'signal': return g('<path d="M-8 -2 A11 11 0 0 1 8 -2 M-5 2 A7 7 0 0 1 5 2"/><circle cx="0" cy="6" r="1.5" fill="' + col + '"/>');
      case 'receiver': return g('<path d="M0 -9 V9 M-6 9 L0 -3 L6 9 M-7 -7 A9 9 0 0 1 7 -7"/>');
      case 'repeater': return g('<path d="M0 -8 L8 7 H-8 Z"/>');
      case 'sensor': return `<g transform="scale(${s.toFixed(3)})"><path d="M0 -9 C5 -2 7 2 7 4 A7 7 0 0 1 -7 4 C-7 2 -5 -2 0 -9 Z" fill="${col}"/></g>`;
      case 'ok': return g('<path d="M-6 0 L-2 5 L7 -6"/>');
      default: return g('<path d="M0 -6 V-5 M0 -1 V6"/>');
    }
  }
  // Queensland's river basins (the Bureau's set, data/qld-basins.geojson,
  // which the Stations map's catchments use too), under the stations: the
  // coast and the catchments, so the map reads as a map. Fetched on the first
  // map scene, then kept; drawn into the scene as soon as it lands.
  function basinsSvg(P, box) {
    if (B.basins == null) { loadBasins(); return ''; }
    if (!Array.isArray(B.basins)) return '';
    const vw = P.lon(box.x), ve = P.lon(box.x + box.w), vn = P.lat(box.y), vs = P.lat(box.y + box.h);
    let fill = '';
    for (const f of B.basins) {
      const [w, s, e, n] = f.bbox;
      if (e < vw || w > ve || n < vs || s > vn) continue;
      for (const ring of f.rings) {
        let dstr = '', lx = null, ly = null;
        for (const [lo, la] of ring) {
          const x = P.x(lo), y = P.y(la);
          if (lx != null && Math.abs(x - lx) < 1.6 && Math.abs(y - ly) < 1.6) continue;
          dstr += `${dstr ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; lx = x; ly = y;
        }
        if (dstr) fill += `<path d="${dstr}Z"/>`;
      }
    }
    return `<g fill="${C.land}" stroke="${C.basin}" stroke-width="1.2" stroke-linejoin="round" class="hb-a-fade" ${d(0)}>${fill}</g>`;
  }
  async function loadBasins() {
    if (B.basins != null) return;
    B.basins = 'loading';
    try {
      const res = await fetch('data/qld-basins.geojson', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      const gj = await res.json();
      B.basins = (gj.features || []).map(f => {
        const g = f.geometry || {}, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        const rings = polys.map(p => p[0]).filter(Boolean);
        const bbox = rings.flat().reduce((o, [lo, la]) => [Math.min(o[0], lo), Math.min(o[1], la), Math.max(o[2], lo), Math.max(o[3], la)], [Infinity, Infinity, -Infinity, -Infinity]);
        return { bbox, rings };
      });
    } catch (_) { B.basins = 'failed'; return; }
    // Into the map on the stage now, if one is up — without starting it over.
    const b = current(), s = b && sceneOf(b, B.scene), g = document.getElementById('hb-basins');
    if (s && s.type === 'map' && g) {
      const svg = document.getElementById('hb-svgbox');
      const tmp = document.createElement('div');
      tmp.innerHTML = sceneSvg(b, B.scene);
      const fresh = tmp.querySelector('#hb-basins');
      if (fresh && svg) { g.innerHTML = fresh.innerHTML; g.querySelectorAll('.hb-a-fade').forEach(n => n.classList.remove('hb-a-fade')); }
    }
  }

  // ── battery: the batteries that need a look, as batteries ──
  function drawBattery(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const items = (s.items || []).slice(0, 5);
    const cols = narrow ? Math.min(3, items.length) : items.length, rows = Math.ceil(items.length / cols);
    const cellW = (W - pad * 2) / cols, cellH = (H - L.foot - pad) / rows;
    const LO = 11.4, HI = 13.2, frac = v => Math.max(0.03, Math.min(1, (v - LO) / (HI - LO)));
    let out = '';
    items.forEach((it, k) => {
      const cx = pad + (k % cols) * cellW + cellW / 2, top = pad * 0.6 + Math.floor(k / cols) * cellH;
      const bw = Math.min(narrow ? 130 : 120, cellW * 0.42), bh = Math.min(narrow ? 210 : 250, cellH * 0.5);
      const x = cx - bw / 2, y = top + 20;
      const v = +it.v, first = Array.isArray(it.nights) && it.nights.length ? +it.nights[0] : v;
      const col = v <= 11.8 ? C.critical : v <= 12.2 ? C.warn : C.ok;
      const fNow = frac(v), fWas = frac(first);
      const fillH = (bh - 12) * fNow;
      const t0 = 0.4 + k * 0.35;
      const line = (V, c, lab) => {
        const yy = y + 6 + (bh - 12) * (1 - frac(V));
        return `<line x1="${x - 10}" y1="${yy.toFixed(1)}" x2="${x + bw + 10}" y2="${yy.toFixed(1)}" stroke="${c}" stroke-width="2" stroke-dasharray="6 5"/>`
          + (k === 0 && lab ? text(x - 14, yy + F.xs * 0.35, lab, F.xs, `text-anchor="end" fill="${c}"`) : '');
      };
      out += `<g class="hb-a-fade" ${d(t0)}>
        <rect x="${(cx - bw * 0.18).toFixed(1)}" y="${y - 14}" width="${(bw * 0.36).toFixed(1)}" height="16" rx="4" fill="${C.muted}"/>
        <rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="14" fill="${C.ground}" stroke="${C.muted}" stroke-width="4"/>
        <rect class="hb-a-fill" x="${(x + 6).toFixed(1)}" y="${(y + bh - 6 - fillH).toFixed(1)}" width="${(bw - 12).toFixed(1)}" height="${fillH.toFixed(1)}" rx="9" fill="${col}"
          ${dd(t0 + 0.4, `--from:${(fWas / fNow).toFixed(3)}`)}/>
        ${line(12.2, C.warn, '12.2 V')}${line(11.8, C.critical, '11.8 V')}
      </g>`;
      // The night lows, a dot a night, under the battery.
      const n = Array.isArray(it.nights) ? it.nights.slice(-14) : [];
      const ty = y + bh + F.l + 8;
      out += `<g class="hb-a-rise" ${d(t0 + 0.7)}>${text(cx, ty, `${fmt(v)} V`, F.l, `text-anchor="middle" font-weight="700" fill="${col}"`)}`;
      const nameLines = wrap(it.name, charsFor(cellW - 16, F.s), 2);
      out += text(cx, ty + F.s * 1.4, '', F.s, `text-anchor="middle" fill="${C.text}" font-weight="600"`, nameLines);
      let yy = ty + F.s * 1.4 + nameLines.length * F.s * 1.22 + 4;
      if (it.trend != null && Math.abs(it.trend) >= 0.005) { out += text(cx, yy, `${it.trend < 0 ? '↘' : '↗'} ${fmt(Math.abs(it.trend), 2)} V a night`, F.xs, `text-anchor="middle" fill="${C.muted}"`); yy += F.xs * 1.3; }
      if (it.days_to != null) { out += text(cx, yy, `≈ ${Math.round(it.days_to)} day${Math.round(it.days_to) === 1 ? '' : 's'} to 11.8 V`, F.xs, `text-anchor="middle" fill="${C.warn}"`); yy += F.xs * 1.3; }
      if (it.note) { out += text(cx, yy, '', F.xs, `text-anchor="middle" fill="${C.muted}"`, wrap(it.note, charsFor(cellW - 16, F.xs), 2)); }
      out += '</g>';
      if (n.length > 1) {
        const sw = Math.min(bw * 1.6, cellW - 20), sx = cx - sw / 2, sy = y + bh + 6;
        const pts = n.map((_, j) => sx + (j / (n.length - 1)) * sw);
        out += `<g class="hb-a-fade" ${d(t0 + 0.9)}>${pts.map((px, j) => `<circle cx="${px.toFixed(1)}" cy="${(sy + 2).toFixed(1)}" r="${narrow ? 4 : 3.2}"
          fill="${+n[j] <= 11.8 ? C.critical : +n[j] <= 12.2 ? C.warn : C.ok}" fill-opacity="${(0.35 + 0.65 * j / (n.length - 1)).toFixed(2)}"/>`).join('')}</g>`;
      }
    });
    return out;
  }

  // ── checks: each station's check signals, slot by slot ──
  const SLOT = { H: ['received', C.ok], P: ['frames lost', C.warn], M: ['missed', C.critical], N: ['missed network-wide', C.violet], U: ['nobody listening', C.faint], '.': ['not due', null] };
  function drawChecks(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const items = (s.items || []).slice(0, 6);
    const legendH = F.xs * (narrow ? 3.8 : 2.2);
    const rowH = Math.min(narrow ? 120 : 92, (H - L.foot - pad - legendH) / Math.max(1, items.length));
    const nameW = narrow ? 0 : 330;
    let out = '';
    items.forEach((it, k) => {
      const y = pad * 0.6 + k * rowH, t0 = 0.3 + k * 0.45;
      const strip = String(it.strip || '');
      const sx = pad + nameW, sw = W - pad * 2 - nameW - (narrow ? 0 : 110);
      const cy = narrow ? y + F.s * 1.3 + 8 : y + 18;
      const cw = sw / Math.max(1, strip.length), ch = Math.min(narrow ? 40 : 38, rowH - (narrow ? F.s * 1.6 : 26));
      out += `<g class="hb-a-fade" ${d(t0)}>${text(pad, narrow ? y + F.s : y + 18 + ch / 2 + F.s * 0.35, '', F.s, `fill="${C.text}" font-weight="600"`,
        wrap(it.name, narrow ? charsFor(W - pad * 2 - 120, F.s) : charsFor(nameW - 16, F.s), 1))}
        ${it.rate != null ? text(W - pad, narrow ? y + F.s : y + 18 + ch / 2 + F.s * 0.35, `${Math.round(it.rate * 100)}%`, F.m, `text-anchor="end" font-weight="700" fill="${it.rate >= 0.9 ? C.ok : it.rate >= 0.7 ? C.warn : C.critical}"`) : ''}</g>`;
      [...strip].forEach((c, j) => {
        const [, col] = SLOT[c] || SLOT['.'];
        const x = sx + j * cw;
        const w = Math.max(1, cw - (cw > 6 ? 2 : 0.6));
        const delay = t0 + 0.2 + Math.min(1.6, j * 1.6 / strip.length);
        if (!col) { out += `<rect x="${x.toFixed(1)}" y="${cy}" width="${w.toFixed(1)}" height="${ch}" rx="2" fill="none" stroke="${C.grid}"/>`; return; }
        out += `<g class="hb-a-pop" ${d(delay)}><rect x="${x.toFixed(1)}" y="${cy}" width="${w.toFixed(1)}" height="${ch}" rx="${Math.min(4, w / 3).toFixed(1)}"
          fill="${c === 'M' ? 'none' : col}" stroke="${col}" stroke-width="${c === 'M' ? 2.5 : 0}" fill-opacity="${c === 'U' ? 0.45 : 0.9}"/>
          ${c === 'M' && cw > 9 ? `<path d="M${(x + w * 0.25).toFixed(1)} ${cy + ch * 0.3} L${(x + w * 0.75).toFixed(1)} ${cy + ch * 0.7} M${(x + w * 0.75).toFixed(1)} ${cy + ch * 0.3} L${(x + w * 0.25).toFixed(1)} ${cy + ch * 0.7}" stroke="${col}" stroke-width="2.5"/>` : ''}</g>`;
      });
      if (it.note) out += `<g class="hb-a-fade" ${d(t0 + 1.2)}>${text(sx, cy + ch + F.xs + 4, '', F.xs, `fill="${C.muted}"`, wrap(it.note, charsFor(sw, F.xs), 1))}</g>`;
    });
    // The key.
    // The key, on as many lines as it takes.
    const keys = ['H', 'P', 'M', 'N', 'U'].map(c => [c, ...SLOT[c]]);
    const kw = ([, lab]) => F.xs * 1.6 + lab.length * F.xs * 0.56 + 18;
    const krows = [[]]; let used = 0;
    keys.forEach(k => { if (used + kw(k) > W - pad * 2 && krows[krows.length - 1].length) { krows.push([]); used = 0; } krows[krows.length - 1].push(k); used += kw(k); });
    out += `<g class="hb-a-fade" ${d(0.2)}>`;
    krows.forEach((row, r) => {
      const ky = H - L.foot - 14 - (krows.length - 1 - r) * F.xs * 1.6;
      let kx = pad;
      row.forEach(k => {
        const [c, lab, col] = k;
        out += `<rect x="${kx}" y="${ky - F.xs * 0.8}" width="${F.xs * 0.9}" height="${F.xs * 0.9}" rx="3" fill="${c === 'M' ? 'none' : col}" stroke="${col}" stroke-width="2"/>`
          + text(kx + F.xs * 1.3, ky, lab, F.xs, `fill="${C.muted}"`);
        kx += kw(k);
      });
    });
    return out + '</g>';
  }

  // ── carrier: the fleet's fingerprints, lined up, and the ones that moved ──
  function drawCarrier(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const items = (s.items || []).slice(0, 3);
    const fleet = (s.fleet || []).filter(Number.isFinite);
    const band = +s.band || 2.5;
    const ext = Math.max(5, ...items.map(it => Math.abs(+it.now) || 0), ...items.map(it => Math.abs(+it.was) || 0));
    const R = Math.min(12, Math.ceil(ext + 0.5));
    const ax0 = pad + 20, ax1 = W - pad - 20, ay = narrow ? 300 : 250;
    const X = v => ax0 + (Math.max(-R, Math.min(R, v)) + R) / (2 * R) * (ax1 - ax0);
    let out = '';
    out += `<g class="hb-a-fade" ${d(0.1)}>
      <rect x="${X(-band).toFixed(1)}" y="${ay - 60}" width="${(X(band) - X(-band)).toFixed(1)}" height="100" fill="${C.ok}" fill-opacity=".08" stroke="${C.ok}" stroke-opacity=".35" stroke-dasharray="6 6"/>
      ${text((X(-band) + X(band)) / 2, ay + 50 + F.xs * 2.4, `like the rest of the fleet: within ±${fmt(band)} ppm`, F.xs, `text-anchor="middle" fill="${C.ok}"`)}
      <line x1="${ax0}" y1="${ay + 40}" x2="${ax1}" y2="${ay + 40}" stroke="${C.muted}" stroke-width="2"/>
      ${[-R, -band, 0, band, R].map(v => `<line x1="${X(v).toFixed(1)}" y1="${ay + 40}" x2="${X(v).toFixed(1)}" y2="${ay + 50}" stroke="${C.muted}" stroke-width="2"/>`
        + text(X(v), ay + 50 + F.xs * 1.1, v === 0 ? '0' : `${signed(v, Number.isInteger(v) ? 0 : 1)}${Math.abs(v) === R ? ' ppm' : ''}`, F.xs,
          `text-anchor="${v === -R ? 'start' : v === R ? 'end' : 'middle'}" fill="${C.muted}"`)).join('')}</g>`;
    // The barcode: every transmitter measured, one faint line each.
    const sortedFleet = fleet.slice().sort((p, q) => p - q);
    out += `<g stroke="${C.dot}" stroke-width="2" stroke-opacity=".5">${sortedFleet.map((v, j) =>
      `<line class="hb-a-grow-y" ${d(0.3 + 1.2 * j / Math.max(1, sortedFleet.length))} x1="${X(v).toFixed(1)}" y1="${ay - 50}" x2="${X(v).toFixed(1)}" y2="${ay + 36}"/>`).join('')}</g>`;
    // The ones this scene is about: where they were, where they are, and a
    // line of their days under the axis. Their names stack upward from the
    // ticks, each line clear of the one under it.
    const labRows = [];
    items.forEach((it, k) => {
      const col = Math.abs(+it.now) >= 5 ? C.critical : Math.abs(+it.now) >= band || (it.was != null && Math.abs(it.now - it.was) >= 1) ? C.warn : C.info;
      const xn = X(+it.now), xw = it.was != null ? X(+it.was) : null, t0 = 1.8 + k * 0.9;
      const lw = (`${it.name} ${signed(+it.now)} ppm`).length * F.s * 0.56;
      const lanchor = xn > W * 0.66 ? 'end' : xn < W * 0.33 ? 'start' : 'middle';
      const lx0 = lanchor === 'end' ? xn - lw : lanchor === 'start' ? xn : xn - lw / 2;
      let row = 0;
      while (labRows.some(r => r.row === row && !(lx0 + lw < r.x0 || lx0 > r.x1))) row++;
      labRows.push({ row, x0: lx0, x1: lx0 + lw });
      const ly = ay - 76 - row * (F.s * 1.3);
      out += `<g>${xw != null ? `<line x1="${xw.toFixed(1)}" y1="${ay - 64}" x2="${xw.toFixed(1)}" y2="${ay + 36}" stroke="${col}" stroke-width="3" stroke-dasharray="5 5" stroke-opacity=".7" class="hb-a-fade" ${d(t0)}/>
          <path d="M${xw.toFixed(1)} ${ay - 8} L${xn.toFixed(1)} ${ay - 8}" stroke="${col}" stroke-width="3" marker-end="url(#hb-arr${k})" class="hb-a-draw" style="--d:${(t0 + 0.4).toFixed(2)}s;--len:${Math.ceil(Math.abs(xn - xw) + 10)}"/>
          <defs><marker id="hb-arr${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="${col}"/></marker></defs>` : ''}
        <g class="${xw != null ? 'hb-a-slide' : 'hb-a-pop'}" ${dd(t0 + 0.4, `--dx:${xw != null ? (xw - xn).toFixed(1) : 0}px`)}>
          <line x1="${xn.toFixed(1)}" y1="${ay - 64}" x2="${xn.toFixed(1)}" y2="${ay + 40}" stroke="${col}" stroke-width="6" stroke-linecap="round"/>
          <circle cx="${xn.toFixed(1)}" cy="${ay - 64}" r="8" fill="${col}"/></g>
        <g class="hb-a-fade" ${d(t0 + 1.0)}>${text(Math.max(ax0, Math.min(ax1, xn)), ly, `${it.name} ${signed(+it.now)} ppm`, F.s,
          `text-anchor="${lanchor}" font-weight="700" fill="${col}" ${halo}`)}</g></g>`;
      // Its days, as a line: the band shaded, the fleet's zero dotted.
      const ser = Array.isArray(it.series) ? it.series : [];
      const top = ay + 50 + F.xs * 4.2 + k * (narrow ? 150 : 104), sx0 = pad, sx1 = W - pad;
      const lineW = narrow ? sx1 - sx0 : (sx1 - sx0) * 0.58, rowH = narrow ? 70 : 64;
      const vals = ser.filter(v => v != null && Number.isFinite(+v)).map(Number);
      if (top + rowH > H - L.foot) return;
      out += `<g class="hb-a-fade" ${d(t0 + 1.2)}>`;
      if (vals.length > 1) {
        const lo = Math.min(-band, ...vals) - 0.3, hi = Math.max(band, ...vals) + 0.3;
        const Y = v => top + rowH - ((v - lo) / (hi - lo)) * rowH;
        const step = lineW / Math.max(1, ser.length - 1);
        let p = '', pen = false;
        ser.forEach((v, j) => {
          if (v == null || !Number.isFinite(+v)) { pen = false; return; }
          p += `${pen ? 'L' : 'M'}${(sx0 + j * step).toFixed(1)} ${Y(+v).toFixed(1)}`; pen = true;
        });
        out += `<rect x="${sx0}" y="${Y(band).toFixed(1)}" width="${lineW.toFixed(1)}" height="${(Y(-band) - Y(band)).toFixed(1)}" fill="${C.ok}" fill-opacity=".07"/>
          <line x1="${sx0}" y1="${Y(0).toFixed(1)}" x2="${(sx0 + lineW).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="${C.faint}" stroke-dasharray="3 5"/>
          <path d="${p}" fill="none" stroke="${col}" stroke-width="3"/>`;
      }
      const nx = narrow ? sx0 : sx0 + lineW + 24;
      const ny = narrow ? top + rowH + F.xs * 1.2 : top + F.xs;
      out += text(nx, ny, '', F.xs, `fill="${C.muted}"`, wrap(`${it.name}${it.note ? ' — ' + it.note : ''}`, charsFor(narrow ? W - pad * 2 : sx1 - nx, F.xs), narrow ? 1 : 3));
      out += '</g>';
    });
    return out;
  }

  // ── triangulate: whose fingerprint is on the corrupted copy ──
  function drawTriangulate(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const subj = Object.assign({}, s.subject || {}), sus = (s.suspects || []).slice(0, 4).map(x => Object.assign({}, x));
    const rx = s.receiver ? Object.assign({}, s.receiver) : { name: 'Base station' };
    [subj, ...sus].forEach(n => { if (n.lat == null && n.id) Object.assign(n, stationAt(n.id) || {}); });
    // The diagram on the left (the top, on a phone); the ruler on the right.
    const dg = narrow ? { x: pad, y: pad * 0.6, w: W - pad * 2, h: 380 } : { x: pad, y: pad * 0.6, w: W * 0.5, h: H - L.foot - pad };
    // Placed by where they are when every one has a position, else fanned out.
    const nodes = [{ ...subj, role: 'subject' }, ...sus.map(x => ({ ...x, role: 'suspect' })), { ...rx, role: 'receiver' }];
    if (nodes.every(n => Number.isFinite(n.lat) && Number.isFinite(n.lon))) {
      const bb = nodes.reduce((o, p) => ({ s: Math.min(o.s, p.lat), n: Math.max(o.n, p.lat), w: Math.min(o.w, p.lon), e: Math.max(o.e, p.lon) }), { s: 90, n: -90, w: 180, e: -180 });
      const padL = Math.max(0.05, (bb.n - bb.s) * 0.2), padO = Math.max(0.05, (bb.e - bb.w) * 0.2);
      const P = projector({ s: bb.s - padL, n: bb.n + padL, w: bb.w - padO, e: bb.e + padO }, { x: dg.x + 30, y: dg.y + 40, w: dg.w - 60, h: dg.h - 80 });
      nodes.forEach(n => { n.x = P.x(n.lon); n.y = P.y(n.lat); });
      // Pull apart any two drawn on top of each other — a repeater on the
      // hill above the base station is a few kilometres from it — keeping
      // all of them inside the diagram.
      const gapMin = narrow ? 150 : 140;
      for (let pass = 0; pass < 12; pass++) {
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], c = nodes[j], dx = c.x - a.x, dy = c.y - a.y, dist = Math.hypot(dx, dy);
          if (dist >= gapMin) continue;
          const push = (gapMin - dist) / 2, ux = dist ? dx / dist : 1, uy = dist ? dy / dist : 0.3;
          a.x -= ux * push; a.y -= uy * push; c.x += ux * push; c.y += uy * push;
        }
        nodes.forEach(n => { n.x = Math.max(dg.x + 70, Math.min(dg.x + dg.w - 70, n.x)); n.y = Math.max(dg.y + 30, Math.min(dg.y + dg.h - 60, n.y)); });
      }
    } else {
      nodes[0].x = dg.x + 60; nodes[0].y = dg.y + dg.h / 2;
      sus.forEach((_, k) => { const n = nodes[k + 1]; n.x = dg.x + dg.w / 2; n.y = dg.y + 40 + (k + 0.5) * (dg.h - 80) / sus.length; });
      const last = nodes[nodes.length - 1]; last.x = dg.x + dg.w - 90; last.y = dg.y + dg.h / 2;
    }
    const S = nodes[0], R = nodes[nodes.length - 1], SUS = nodes.slice(1, -1);
    const matched = SUS.find(n => n.match === true);
    let out = '';
    const seg = (a, c, col, w, extra = '') => `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${c.x.toFixed(1)}" y2="${c.y.toFixed(1)}" stroke="${col}" stroke-width="${w}" ${extra}/>`;
    SUS.forEach(n => { out += `<g class="hb-a-fade" ${d(0.3)}>${seg(S, n, C.faint, 2.5, 'stroke-dasharray="8 7"')}${seg(n, R, C.faint, 2.5, 'stroke-dasharray="8 7"')}</g>`; });
    // The clean copy goes the way it always goes; the corrupted one arrives
    // and, until the fingerprint is read, could have come from any of them.
    const anim = !reduced();
    const path = pts => 'M' + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
    if (anim) {
      SUS.forEach((n, k) => {
        out += `<circle r="9" fill="${C.ok}" opacity="0"><animate attributeName="opacity" values="0;1;1;0" dur="2.2s" begin="${(1.0 + k * 0.15).toFixed(2)}s" fill="freeze"/>
          <animateMotion dur="2.2s" begin="${(1.0 + k * 0.15).toFixed(2)}s" fill="freeze" path="${path([S, n, R])}"/></circle>`;
        out += `<circle r="9" fill="${C.critical}" opacity="0"><animate attributeName="opacity" values="0;0.9;0.9;0" dur="1.6s" begin="3.6s" fill="freeze"/>
          <animateMotion dur="1.6s" begin="3.6s" fill="freeze" path="${path([n, R])}"/></circle>`;
      });
    }
    if (matched) out += `<g class="hb-a-draw" style="--d:7.2s;--len:${Math.ceil(Math.hypot(matched.x - R.x, matched.y - R.y) + 4)}">${seg(matched, R, C.critical, 6, 'stroke-linecap="round"')}</g>`;
    const node = (n, shape, col, t) => {
      const r = narrow ? 24 : 22;
      const g = shape === 'tri' ? `<path d="M0 ${-r} L${r} ${r * 0.8} L${-r} ${r * 0.8} Z" fill="${C.ground}" stroke="${col}" stroke-width="4"/>`
        : shape === 'mast' ? `<rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" rx="6" fill="${C.ground}" stroke="${col}" stroke-width="4"/>${markIcon('receiver', col, r * 0.7)}`
        : `<circle r="${r}" fill="${C.ground}" stroke="${col}" stroke-width="4"/>${markIcon('sensor', col, r * 0.55)}`;
      const lines = wrap(n.name || '', charsFor(narrow ? 220 : 180, F.xs), 2);
      return `<g class="${n.id ? 'hb-hit' : ''}" ${n.id ? `data-stn="${escAttr(n.id)}"` : ''} transform="translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})"><g class="hb-a-pop" ${d(t)}>${g}
        ${text(0, r + F.xs + 6, '', F.xs, `text-anchor="middle" font-weight="600" fill="${C.text}" ${halo}`, lines)}</g></g>`;
    };
    out += node(S, 'dot', C.info, 0.4) + node(R, 'mast', C.accent, 0.5);
    SUS.forEach((n, k) => {
      out += node(n, 'tri', C.neutral, 0.6 + k * 0.15);
      if (matched === n) out += `<circle class="hb-a-pulse" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="30" fill="none" stroke="${C.critical}" stroke-width="4" ${d(7.4)}/>
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="30" fill="none" stroke="${C.critical}" stroke-width="5" class="hb-a-pop" ${d(7.2)}/>`;
    });
    // The ruler: each suspect's carrier as heard here, and the copy's.
    const rl = narrow ? { x: pad, y: 470, w: W - pad * 2 } : { x: W * 0.58, y: 200, w: W * 0.42 - pad };
    const hzs = SUS.map(n => +n.hz).filter(Number.isFinite);
    const ev = s.evidence || {};
    if (Number.isFinite(+ev.hz)) hzs.push(+ev.hz);
    if (hzs.length) {
      const lo = Math.min(...hzs), hi = Math.max(...hzs), span = Math.max(80, hi - lo);
      const a = lo - span * 0.25, z = hi + span * 0.25;
      const X = v => rl.x + (v - a) / (z - a) * rl.w;
      out += `<g class="hb-a-fade" ${d(4.6)}>${text(rl.x, rl.y - 70, 'Carrier as heard here', F.s, `font-weight="700" fill="${C.text}"`)}
        <line x1="${rl.x}" y1="${rl.y}" x2="${rl.x + rl.w}" y2="${rl.y}" stroke="${C.muted}" stroke-width="2"/>
        ${text(rl.x, rl.y + F.xs * 1.4, `${Math.round(a)} Hz`, F.xs, `fill="${C.faint}"`)}${text(rl.x + rl.w, rl.y + F.xs * 1.4, `${Math.round(z)} Hz`, F.xs, `text-anchor="end" fill="${C.faint}"`)}</g>`;
      SUS.forEach((n, k) => {
        if (!Number.isFinite(+n.hz)) return;
        const x = X(+n.hz), col = matched === n ? C.critical : C.neutral;
        out += `<g class="hb-a-pop" ${d(5.0 + k * 0.3)}><path d="M${x.toFixed(1)} ${rl.y} l-10 -24 h20 Z" fill="${col}"/>
          ${text(x, rl.y - 32 - (k % 2) * (F.xs * 1.2), n.name ? wrap(n.name, 26, 1)[0] : '', F.xs, `text-anchor="middle" fill="${col}" ${halo}`)}</g>`;
      });
      if (Number.isFinite(+ev.hz)) {
        const x = X(+ev.hz);
        out += `<g class="hb-a-rise" ${d(6.4)}><path d="M${x.toFixed(1)} ${rl.y + 4} l-12 28 h24 Z" fill="${C.critical}"/>
          ${text(x, rl.y + 56, '', F.xs, `text-anchor="middle" font-weight="700" fill="${C.critical}" ${halo}`, wrap(ev.what || 'the corrupted copies', 22, 2))}</g>`;
      }
    }
    if (s.verdict) {
      const vy = narrow ? rl.y + 140 : rl.y + 140;
      out += `<g class="hb-a-rise" ${d(7.6)}>${text(rl.x, vy, '', F.s, `font-weight="600" fill="${C.text}"`, wrap(s.verdict, charsFor(rl.w, F.s), narrow ? 4 : 5))}</g>`;
    }
    return out;
  }

  // ── receivers: each base station receiver, hour by hour ──
  function drawReceivers(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const items = (s.items || []).slice(0, 5);
    const rowH = Math.min(narrow ? 170 : 150, (H - L.foot - pad) / Math.max(1, items.length));
    const from = Date.parse((b.period || {}).from);
    let out = '';
    items.forEach((it, k) => {
      const up = Array.isArray(it.up) ? it.up : [];
      const y = pad * 0.6 + k * rowH, t0 = 0.3 + k * 0.4;
      const x0 = pad, w = W - pad * 2, ch = Math.max(30, Math.min(narrow ? 60 : 56, rowH - F.s * 1.6 - F.xs * 2.2)), cy = y + F.s * 1.5;
      const cw = w / Math.max(1, up.length);
      const known = up.filter(v => v != null && Number.isFinite(+v));
      const share = known.length ? known.reduce((n, v) => n + +v, 0) / known.length : null;
      out += `<g class="hb-a-fade" ${d(t0)}><text x="${x0}" y="${(y + F.s).toFixed(1)}" font-size="${F.s}" font-weight="700" fill="${C.text}">${esc(it.name)}${it.note && !narrow
          ? `<tspan font-weight="400" fill="${C.muted}" font-size="${F.xs}"> — ${esc(wrap(it.note, 60, 1)[0])}</tspan>` : ''}</text>
        ${share != null || it.summary ? text(x0 + w, y + F.s, it.summary || `${Math.round(share * 100)}% of hours`, F.s, `text-anchor="end" font-weight="700" fill="${share == null ? C.text : share >= 0.95 ? C.ok : share >= 0.75 ? C.warn : C.critical}"`) : ''}</g>`;
      out += `<g class="hb-sweep" ${dd(t0 + 0.2, `--w:${w}px`)}>` + up.map((v, j) => {
        const col = v == null ? C.grid : v >= 0.9 ? C.ok : v >= 0.4 ? C.warn : C.critical;
        return `<rect x="${(x0 + j * cw).toFixed(1)}" y="${cy}" width="${Math.max(1, cw - (cw > 5 ? 1.5 : 0.4)).toFixed(1)}" height="${ch}" fill="${col}" fill-opacity="${v == null ? 0.6 : 0.9}"/>`;
      }).join('') + '</g>';
      // Day lines and hours, in the time of the person watching.
      if (Number.isFinite(from) && up.length) {
        const per = up.length > 48 ? 'day' : 'hour';
        for (let j = 0; j <= up.length; j++) {
          const t = new Date(from + j * 3600e3);
          const mark = per === 'day' ? t.getHours() === 0 : t.getHours() % 6 === 0;
          if (!mark) continue;
          const x = x0 + j * cw;
          const lab = per === 'day' ? t.toLocaleDateString(undefined, { weekday: 'short' }) : `${String(t.getHours()).padStart(2, '0')}:00`;
          out += `<g class="hb-a-fade" ${d(t0 + 0.6)}><line x1="${x.toFixed(1)}" y1="${cy - 4}" x2="${x.toFixed(1)}" y2="${cy + ch + 4}" stroke="${C.ground}" stroke-width="2"/>
            ${k === items.length - 1 || narrow ? text(x + 3, cy + ch + F.xs + 2, lab, F.xs, `fill="${C.faint}"`) : ''}</g>`;
        }
      }
      // On a phone the note has a line of its own, under the hours.
      if (it.note && narrow) out += `<g class="hb-a-fade" ${d(t0 + 1)}>${text(x0, cy + ch + F.xs * 2.5, '', F.xs, `fill="${C.muted}"`, wrap(it.note, charsFor(w, F.xs), 1))}</g>`;
    });
    return out;
  }

  // ── trend: a few lines across the days ──
  function drawTrend(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const series = (s.series || []).slice(0, 3);
    const gap = 26, ph = (H - L.foot - pad - gap * (series.length - 1)) / Math.max(1, series.length);
    let out = '';
    series.forEach((se, k) => {
      const pts = (se.points || []).filter(p => Array.isArray(p));
      const y0 = pad * 0.6 + k * (ph + gap), t0 = 0.3 + k * 0.6;
      const lx = pad, lw = W - pad * 2 - (narrow ? 0 : 230), top = y0 + F.s * 1.5, bot = y0 + ph - F.xs * 1.6;
      const vals = pts.map(p => p[1]).filter(v => v != null && Number.isFinite(+v)).map(Number);
      const col = TONE[se.tone] || C.accent;
      const latest = [...pts].reverse().find(p => p[1] != null);
      out += `<g class="hb-a-fade" ${d(t0)}>${text(lx, y0 + F.s, se.label, F.s, `font-weight="700" fill="${C.text}"`)}
        ${latest ? text(W - pad, narrow ? y0 + F.s : y0 + ph / 2 + F.xl * 0.3, `${fmtStat(+latest[1])}${se.unit ? ' ' + se.unit : ''}`, narrow ? F.m : F.xl, `text-anchor="end" font-weight="700" fill="${col}"`) : ''}</g>`;
      if (vals.length < 2) return;
      let lo = Math.min(...vals, se.baseline != null ? +se.baseline : Infinity), hi = Math.max(...vals, se.baseline != null ? +se.baseline : -Infinity);
      if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      const padv = (hi - lo) * 0.12; lo -= padv; hi += padv;
      const X = j => lx + (j / Math.max(1, pts.length - 1)) * lw, Y = v => bot - ((v - lo) / (hi - lo)) * (bot - top);
      let p = '', pen = false, len = 0, last = null;
      pts.forEach((pt, j) => {
        if (pt[1] == null) { pen = false; return; }
        const x = X(j), y = Y(+pt[1]);
        if (last && pen) len += Math.hypot(x - last[0], y - last[1]);
        p += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; pen = true; last = [x, y];
      });
      out += `<rect x="${lx}" y="${top}" width="${lw}" height="${(bot - top).toFixed(1)}" fill="${C.ground}" fill-opacity=".45" rx="8"/>`;
      if (se.baseline != null) out += `<line x1="${lx}" y1="${Y(+se.baseline).toFixed(1)}" x2="${lx + lw}" y2="${Y(+se.baseline).toFixed(1)}" stroke="${C.faint}" stroke-dasharray="6 6"/>`;
      out += `<path d="${p}" fill="none" stroke="${col}" stroke-width="4" stroke-linejoin="round" class="hb-a-draw" style="--d:${(t0 + 0.3).toFixed(2)}s;--len:${Math.ceil(len + 20)};--dur:1.8s"/>`;
      if (last) out += `<circle class="hb-a-pop" ${d(t0 + 2.1)} cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="7" fill="${col}"/>`;
      const labs = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i);
      out += `<g class="hb-a-fade" ${d(t0 + 0.4)}>${labs.map(j => text(X(j), bot + F.xs * 1.3, String(pts[j][0]), F.xs,
        `text-anchor="${j === 0 ? 'start' : j === pts.length - 1 ? 'end' : 'middle'}" fill="${C.faint}"`)).join('')}</g>`;
    });
    return out;
  }

  // ── list: what needs a look, a line each ──
  function drawList(s, b, L) {
    const { W, H, F, pad } = L;
    const items = (s.items || []).slice(0, 6);
    const avail = H - L.foot - pad;
    // As big as fits: shrink the type until every line of every item does.
    let fs = F.l, laid;
    for (;;) {
      const chars = charsFor(W - pad * 2 - fs * 2.2, fs);
      laid = items.map(it => wrap(it.text, chars, 4));
      const need = laid.reduce((n, ls) => n + ls.length * fs * 1.22 + fs * 0.9, 0);
      if (need <= avail || fs <= F.xs) break;
      fs -= 2;
    }
    let y = pad * 0.6 + fs, out = '';
    items.forEach((it, k) => {
      const col = sevC(it.sev), t0 = 0.4 + k * 0.7;
      out += `<g class="hb-a-rise${it.id ? ' hb-hit' : ''}" ${it.id ? `data-stn="${escAttr(it.id)}"` : ''} ${d(t0)}>
        <circle cx="${pad + fs * 0.45}" cy="${y - fs * 0.35}" r="${fs * 0.45}" fill="${col}"/>
        ${text(pad + fs * 0.45, y - fs * 0.35 + fs * 0.22, SEV_ICON[it.sev] === '✓' ? '✓' : it.sev === 'critical' ? '!' : it.sev === 'warn' ? '!' : 'i', fs * 0.62, `text-anchor="middle" font-weight="800" fill="${C.ground}"`)}
        ${text(pad + fs * 1.4, y, '', fs, `fill="${C.text}"`, laid[k])}</g>`;
      y += laid[k].length * fs * 1.22 + fs * 0.9;
    });
    return out;
  }

  // ── signoff ──
  function drawSignoff(s, b, L) {
    const { W, H, F, pad, narrow } = L;
    const P = who(b.presenter);
    const line = s.line || P.lines[(new Date(b.issued_at).getDate() || 0) % P.lines.length];
    let out = `<g class="hb-a-fade" ${d(0.2)}>${skyMini(b, W / 2, narrow ? 190 : 170)}</g>`;
    out += `<g class="hb-a-rise" ${d(0.6)}>${text(W / 2, narrow ? 360 : 320, '', F.l, `text-anchor="middle" font-weight="700" fill="${C.text}"`, wrap(`“${line}”`, charsFor(W - pad * 2, F.l), 2))}
      ${text(W / 2, narrow ? 360 + F.l * 2.8 : 320 + F.l * 1.9, `— ${P.name}`, F.s, `text-anchor="middle" fill="${C.muted}"`)}</g>`;
    const next = b.kind === 'weekly' ? 'The next weekly bulletin: Monday morning.' : 'The next bulletin: tomorrow morning, about five.';
    out += `<g class="hb-a-fade" ${d(1.4)}>${text(W / 2, H - L.foot - (narrow ? 90 : 60), next, F.s, `text-anchor="middle" fill="${C.accent}"`)}</g>`;
    return out;
  }
  function skyMini(b, x, y) { return `<g transform="translate(${x} ${y}) scale(.62)">${skyGlyph((b.outlook && b.outlook.sky) || 'fair')}</g>`; }

  const DRAW = { title: drawTitle, map: drawMap, battery: drawBattery, checks: drawChecks, carrier: drawCarrier,
                 triangulate: drawTriangulate, receivers: drawReceivers, trend: drawTrend, list: drawList, signoff: drawSignoff };

  // ── playing ────────────────────────────────────────────────────────────────

  function resetPlay() { stopClock(); cancelSpeech(); B.scene = 0; B.t = 0; B.playing = false; B.ended = false; }
  function play() {
    const b = current();
    if (!b) return;
    if (B.ended) { B.scene = 0; B.t = 0; B.ended = false; }
    B.playing = true;
    markSeen(b.id);
    if (B.t === 0) startScene(); else { resumeSpeech(); drawControls(); }
    startClock();
    const stage = document.getElementById('hb-stage');
    if (stage) { stage.classList.remove('is-paused'); stage.classList.toggle('is-still', reduced()); const svg = stage.querySelector('svg'); if (svg && svg.unpauseAnimations) svg.unpauseAnimations(); }
    const big = document.querySelector('.hb-bigplay'); if (big) big.remove();
    setTalking(true);
  }
  function pause() {
    B.playing = false;
    stopClock();
    cancelSpeech();
    const stage = document.getElementById('hb-stage');
    if (stage) { stage.classList.add('is-paused'); const svg = stage.querySelector('svg'); if (svg && svg.pauseAnimations) svg.pauseAnimations(); }
    setTalking(false);
    drawControls();
  }
  function toggle() { if (B.playing) pause(); else play(); }
  function go(i) {
    const b = current();
    if (!b) return;
    const n = (b.scenes || []).length;
    B.scene = Math.max(0, Math.min(n - 1, i)); B.t = 0; B.ended = false;
    cancelSpeech();
    startScene();
    if (!B.playing) drawCaption(true);
  }
  function next() { const b = current(); if (b && B.scene < (b.scenes || []).length - 1) go(B.scene + 1); }
  function prev() { go(B.t > 2500 ? B.scene : B.scene - 1); }

  function startScene() {
    const b = current();
    if (!b) return;
    const box = document.getElementById('hb-svgbox');
    if (!box) return;
    box.innerHTML = sceneSvg(b, B.scene);
    const stage = document.getElementById('hb-stage');
    if (stage) { stage.classList.remove('is-paused'); stage.classList.toggle('is-still', !B.playing || reduced()); }
    const svg = box.querySelector('svg');
    if (svg && !B.playing && svg.pauseAnimations) svg.pauseAnimations();
    const lower = document.getElementById('hb-lower'); if (lower) lower.innerHTML = lowerHtml(b, B.scene);
    const pres = document.getElementById('hb-presenter'); if (pres) pres.innerHTML = presenterHtml(b, B.scene);
    const chips = document.getElementById('hb-chips'); if (chips) chips.innerHTML = chipsHtml(b, B.scene);
    const big = document.querySelector('.hb-bigplay'); if (big && (B.playing || B.scene > 0)) big.remove();
    countUp(box);
    drawCaption();
    drawControls();
    if (B.playing) { speakScene(); setTalking(true); }
    announceScene(b);
  }
  function announceScene(b) {
    const s = sceneOf(b, B.scene);
    if (s && typeof announce === 'function' && !B.speak) announce(`Scene ${B.scene + 1}: ${s.title}.`);
  }
  // The title's numbers count up as they appear, a second and a half each.
  function countUp(box) {
    const els = box.querySelectorAll('[data-count]');
    if (!els.length || reduced() || !B.playing) return;
    const start = performance.now();
    const frame = now => {
      const k = Math.min(1, (now - start - 1400) / 1500);
      els.forEach(el => {
        const v = +el.getAttribute('data-count'), first = el.firstChild;
        if (first && first.nodeType === 3) first.nodeValue = fmtStat(k <= 0 ? 0 : Number.isInteger(v) ? Math.round(v * easeOut(k)) : +(v * easeOut(k)).toFixed(1));
      });
      if (k < 1 && document.body.contains(box)) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  const easeOut = k => 1 - Math.pow(1 - k, 3);

  function startClock() {
    stopClock();
    B.last = performance.now();
    B.timer = setInterval(tick, 120);
  }
  function stopClock() { if (B.timer) clearInterval(B.timer); B.timer = null; }
  function tick() {
    const b = current();
    if (!b || !document.getElementById('hb-stage')) { stopClock(); return; }
    const now = performance.now();
    B.t += now - B.last; B.last = now;
    const s = sceneOf(b, B.scene), secs = (+s.secs || 8) * 1000;
    drawCaption(); drawProgress();
    // A scene ends when its time is up and its narration has been said — the
    // browser's voice can run longer than the scene's seconds; not for ever.
    const done = B.t >= secs && (!B.speaking || B.t >= secs * 2.5);
    if (!done) return;
    if (B.scene < (b.scenes || []).length - 1) { B.scene++; B.t = 0; cancelSpeech(); startScene(); }
    else {
      B.playing = false; B.ended = true; B.t = 0;
      stopClock(); setTalking(false);
      redraw();
      if (typeof announce === 'function') announce('End of the bulletin.');
    }
  }
  function drawCaption(all) {
    const b = current(), s = b && sceneOf(b, B.scene), el = document.getElementById('hb-caption');
    if (!s || !el) return;
    if (!el.querySelector('.hb-w') || el.getAttribute('data-scene') !== String(B.scene)) {
      el.innerHTML = captionHtml(b, B.scene);
      el.setAttribute('data-scene', String(B.scene));
    }
    const words = el.querySelectorAll('.hb-w');
    const n = all || !B.playing && B.t === 0 ? words.length : revealCount(s, words.length);
    words.forEach((w, k) => w.classList.toggle('is-said', k < n));
  }
  function drawProgress() {
    const b = current(), bar = document.getElementById('hb-bar');
    if (!b || !bar) return;
    const segs = bar.querySelectorAll('.hb-seg');
    if (segs.length !== (b.scenes || []).length) { bar.innerHTML = barHtml(b); return; }
    segs.forEach((seg, i) => {
      seg.classList.toggle('is-on', i === B.scene); seg.classList.toggle('is-done', i < B.scene);
      if (i === B.scene) seg.setAttribute('aria-current', 'step'); else seg.removeAttribute('aria-current');
      const f = seg.firstElementChild;
      if (f) f.style.setProperty('--p', `${i < B.scene ? 100 : i === B.scene ? progressPct(b.scenes[i]).toFixed(1) : 0}%`);
    });
    const clock = document.getElementById('hb-clock'); if (clock) clock.textContent = clockText(b);
  }
  function drawControls() {
    const btn = document.getElementById('hb-play');
    if (btn) { btn.textContent = B.playing ? '⏸ Pause' : '▶ Play'; btn.setAttribute('aria-label', B.playing ? 'Pause' : 'Play'); }
    drawProgress();
  }
  function setTalking(on) {
    const img = document.querySelector('#hb-presenter img');
    if (img) img.classList.toggle('is-talking', !!on);
  }

  // ── reading aloud ──────────────────────────────────────────────────────────
  // The browser's own voice, an Australian one where it has one, pitched and
  // paced for whoever is presenting. Nothing is sent anywhere.
  function voice() {
    if (typeof speechSynthesis === 'undefined') return null;
    const vs = speechSynthesis.getVoices() || [];
    return vs.find(v => /en[-_]AU/i.test(v.lang)) || vs.find(v => /en[-_]GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  }
  function speakScene(fromWord) {
    if (!B.speak || typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
    const b = current(), s = b && sceneOf(b, B.scene);
    if (!s) return;
    const words = String(s.say || '').split(/\s+/).filter(Boolean);
    const start = fromWord || 0;
    const said = words.slice(start).join(' ');
    if (!said) return;
    const u = new SpeechSynthesisUtterance(said);
    const v = voice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-AU';
    const P = who(speakerOf(b, s));
    u.pitch = P.voice.pitch; u.rate = P.voice.rate;
    // Word boundaries move the caption along with the voice.
    const offsets = []; let pos = 0;
    words.slice(start).forEach(w => { offsets.push(pos); pos += w.length + 1; });
    u.onboundary = e => { if (e.name && e.name !== 'word') return; let k = 0; while (k < offsets.length && offsets[k] <= e.charIndex) k++; B.spokenWords = start + k; };
    u.onend = u.onerror = () => { B.speaking = false; B.spokenWords = words.length; };
    B.speaking = true; B.spokenWords = start;
    try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (_) { B.speaking = false; }
  }
  function resumeSpeech() { if (B.speak) speakScene(B.spokenWords || 0); }
  function cancelSpeech() {
    B.speaking = false;
    if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch (_) {} }
  }
  function toggleSpeak() {
    B.speak = !B.speak;
    keep('mn-hb-speak', B.speak ? '1' : null);
    if (!B.speak) cancelSpeech(); else if (B.playing) speakScene(0);
    redrawControlsOnly();
  }
  function redrawControlsOnly() {
    const btn = [...document.querySelectorAll('.hb-controls .hb-btn')].find(x => /Read aloud|Reading aloud/.test(x.textContent));
    if (btn) { btn.textContent = B.speak ? '🔊 Reading aloud' : '🔈 Read aloud'; btn.setAttribute('aria-pressed', String(B.speak)); }
  }

  // ── events ─────────────────────────────────────────────────────────────────

  function redraw() {
    const el = document.getElementById('hb-panel');
    if (!el) return;
    el.className = `panel hb${B.hidden ? ' hb--hidden' : ''}`;
    el.innerHTML = panelInner();
    watchSize();
  }
  function setKind(k) {
    if (k !== 'daily' && k !== 'weekly' || k === B.kind) return;
    B.kind = k; keep('mn-hb-kind', k);
    resetPlay();
    redraw();
    loadCurrent();
  }
  function pick(file) { B.pick[B.kind] = file; resetPlay(); redraw(); loadCurrent(); }
  function toggleHidden() {
    B.hidden = !B.hidden; keep('mn-hb-hidden', B.hidden ? '1' : null);
    if (B.hidden) pause();
    redraw();
  }
  function key(e) {
    if (e.target && e.target.closest && e.target.closest('button, a, select') && e.target.id !== 'hb-stage') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }
  function stageClick(e) {
    const hit = e.target && e.target.closest && e.target.closest('[data-stn]');
    if (hit) { open(hit.getAttribute('data-stn')); return; }
    if (e.target && e.target.closest && e.target.closest('button')) return;
    toggle();
  }
  // A station named in the bulletin, opened where it is on this tab.
  function open(id) {
    if (!id) return;
    pause();
    if (typeof Health === 'undefined') return;
    const st = Health.state && Health.state();
    if (st && st.A && st.A.stations && st.A.stations.has(id) && Health.select) Health.select(id);
    else if (Health.showStation) Health.showStation(id);
  }

  // The stage is drawn wide on a wide screen and tall on a phone; crossing
  // over redraws the scene where it is.
  function watchSize() {
    const stage = document.getElementById('hb-stage');
    if (B.ro) { B.ro.disconnect(); B.ro = null; }
    if (!stage || typeof ResizeObserver === 'undefined') return;
    B.ro = new ResizeObserver(entries => {
      const w = entries[0] && entries[0].contentRect.width;
      if (!w) return;
      B.narrow = w < NARROW_PX;
      if (B.narrow === B.drawnNarrow) return;
      const b = current(), box = document.getElementById('hb-svgbox');
      if (!b || !box) return;
      box.innerHTML = sceneSvg(b, B.scene);
      // Redrawn where it was: finished, not played over from its start.
      const stg = document.getElementById('hb-stage');
      if (stg && B.t > 0) stg.classList.add('is-still');
    });
    B.ro.observe(stage);
  }

  function init() {
    watchSize();
    if (!B.index && !B.loading && !B.indexErr) loadIndex();
    else if (B.index && !B.files.has(currentFile() || '')) loadCurrent();
  }
  function stop() {
    pause();
    if (B.ro) { B.ro.disconnect(); B.ro = null; }
  }

  return {
    render, init, stop, adopt, refresh: () => { B.index = null; B.indexErr = ''; B.files.clear(); resetPlay(); redraw(); loadIndex(); },
    play, pause, toggle, go, next, prev, setKind, pick, toggleHidden, toggleSpeak, key, stageClick, open,
    ROSTER, _draw: (s, b, narrow) => { const was = B.narrow; B.narrow = !!narrow; try { return sceneSvg(Object.assign({ scenes: [s] }, b || {}), 0); } finally { B.narrow = was; } },
    _state: () => ({ kind: B.kind, scene: B.scene, playing: B.playing, ended: B.ended, file: currentFile(), speak: B.speak, hidden: B.hidden }),
  };
})();

if (typeof window !== 'undefined') window.HealthBulletin = HealthBulletin;
