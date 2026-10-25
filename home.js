// MegaNet — home.js
//
//   Home   🏠 the front page of the three looks drawn in pictures (looks.js:
//          🔲 Tiles, 🎚️ Instrument, 🪧 Signs) — how the network is right now,
//          the six things used most as big tiles, and every other tab under
//          them as a small one — and the pieces of those looks that live in the
//          banner: 🏠 itself, and Instrument's counts across it.
//
// After core.js (state, TABS, tabShown, tabCannot, esc, escAttr, announce) and
// glyphs.js, before init.js. Reaches across to app.js for switchTab and
// renderMain, to health-glance.js for the counts, and to nav-views.js for the
// view's groups — all at call time. Nothing runs at load (`npm run toplevel`):
// renderMain() draws the tab and renderTabs() calls chrome().
//
// ── What it is not ───────────────────────────────────────────────────────────
// A second Site Map. The Site Map explains every tab; this one is for somebody
// who already knows what they came for and wants it in one press. So a tile
// says what a tab is in two words — "Map", "Every station" — and nothing more,
// and its help (core.js, HELP.home) is a paragraph.
//
// ── The counts ───────────────────────────────────────────────────────────────
// OK, on watch and at fault are Station Health's classes, from the batch the
// map's health pins are coloured by (HealthGlance.counts): one request for the
// whole network, asked when the page or the banner first needs it and again
// once it is fifteen minutes old. While it is on its way, or if it cannot be
// had (signed out where the table is not public, no signal), a count is a
// dash, never a nought — a nought would be an answer. The station, repeater
// and base counts are the station list's own, and are there as soon as it is.
//
// Exposes: render, init, go, chrome, statusHtml, MOST.

const Home = (() => {
  // The big tiles: the tab, its picture, a two-word name and a two-word line.
  // The name is the thing ("Map"), not the tab's label ("Stations"), because
  // a tile is pressed for what it shows; the tab's own label is its title.
  const MOST = [
    { tab: 'stations',    glyph: 'map',     label: 'Map',         sub: 'Every station' },
    { tab: 'nearby',      glyph: 'nearby',  label: 'Nearby',      sub: 'Closest to you' },
    { tab: 'health',      glyph: 'health',  label: 'Health',      sub: 'Who needs a look', count: true },
    { tab: 'inspections', glyph: 'inspect', label: 'Inspect',     sub: 'Site visit sheet' },
    { tab: 'camera',      glyph: 'camera',  label: 'Camera',      sub: 'Stamped photos' },
    { tab: 'lookaround',  glyph: 'look',    label: 'Look Around', sub: 'Point the phone' },
  ];

  let watching = false;
  const num = n => Number(n).toLocaleString();

  function stations() {
    return ((state.data && state.data.stations) || []).filter(s => !s.proposed);
  }

  function counts() {
    return typeof HealthGlance !== 'undefined' && HealthGlance.counts ? HealthGlance.counts() : null;
  }

  // The batch, asked for (at most once per its own TTL), and a repaint each
  // time it lands — of whichever of the page and the banner is showing.
  function ask() {
    if (typeof HealthGlance === 'undefined' || !HealthGlance.askNet) return;
    if (!watching) { HealthGlance.onNet(repaintCounts); watching = true; }
    if (state.data && state.data.stations) HealthGlance.askNet();
  }

  function repaintCounts() {
    const now = document.getElementById('home-now');
    if (now && state.activeTab === 'home') now.outerHTML = nowHtml();
    paintBanner();
  }

  // ── The counts, as chips ─────────────────────────────────────────────────
  // Each one a button into Station Health: the class's picture, the number,
  // and its word. `brief` drops the word for the banner, where the picture
  // and the button's own name (its title and aria-label) say it.
  function statusHtml({ brief = false } = {}) {
    const c = counts();
    const known = !!c && (c.status === 'ok' || c.okAt > 0);
    const asking = !!c && c.status === 'loading' && !known;
    const items = [
      { cls: 'ok',    glyph: 'ok',    n: c && c.ok,    word: 'OK',       long: 'stations reporting as they should' },
      { cls: 'watch', glyph: 'late',  n: c && c.watch, word: 'on watch', long: 'stations on watch' },
      { cls: 'fault', glyph: 'fault', n: c && c.fault, word: 'at fault', long: 'stations at fault' },
    ];
    const why = !c ? '' : asking ? 'Asking Station Health…'
      : !known && c.status === 'error' ? (c.denied ? 'Station Health is for signed-in accounts.' : 'Station Health could not be reached.')
      : '';
    return items.map(x => {
      const v = known ? num(x.n || 0) : '—';
      const name = known ? `${v} ${x.long} — open Station Health` : `${x.long}: ${why || 'not known yet'} — open Station Health`;
      return `
        <button type="button" class="hm-chip hm-${x.cls}" data-status="${x.cls}" onclick="Home.go('health')"
                title="${escAttr(name)}" aria-label="${escAttr(name)}">
          ${Glyphs.svg(x.glyph)}<strong>${v}</strong>${brief ? '' : `<span>${esc(x.word)}</span>`}
        </button>`;
    }).join('');
  }

  // The station list's own counts: no request, there as soon as it is.
  function fleetHtml() {
    const list = stations();
    if (!list.length) return '';
    const n = role => list.filter(s => (s.roles || []).includes(role)).length;
    const items = [
      { glyph: 'gauge',    n: list.length, word: 'stations' },
      { glyph: 'repeater', n: n('repeater'), word: 'repeaters' },
      { glyph: 'base',     n: n('base'), word: 'base stations' },
    ];
    return items.map(x => `
        <span class="hm-fleet">${Glyphs.svg(x.glyph)}<strong>${num(x.n)}</strong><span>${esc(x.word)}</span></span>`).join('');
  }

  function nowHtml() {
    const c = counts();
    const known = !!c && (c.status === 'ok' || c.okAt > 0);
    const note = !c ? '' : c.status === 'loading' && !known ? 'Asking Station Health how every station is…'
      : !known && c.status === 'error'
        ? (c.denied ? 'How each station is comes from Station Health, which is for signed-in accounts.'
                    : 'Station Health could not be reached just now; the counts will follow when it can be.')
      : '';
    return `
      <section class="hm-now" id="home-now" aria-labelledby="home-now-h">
        <h3 id="home-now-h">Network now</h3>
        <div class="hm-status" role="group" aria-label="How the stations are">${statusHtml()}</div>
        <div class="hm-fleets">${fleetHtml()}</div>
        ${note ? `<p class="small txt-muted hm-note" role="status">${esc(note)}</p>` : ''}
      </section>`;
  }

  // ── The tiles ────────────────────────────────────────────────────────────

  function bigHtml() {
    const c = counts();
    const known = !!c && (c.status === 'ok' || c.okAt > 0);
    return MOST.filter(m => { const t = TAB_LIST.find(x => x.id === m.tab); return t && tabShown(t); }).map(m => {
      const hue = Glyphs.groupOf(m.tab);
      const n = m.count && known ? (c.watch || 0) + (c.fault || 0) : 0;
      return `
        <button type="button" class="hm-big" data-go="${m.tab}" data-hue="${hue}" onclick="Home.go('${m.tab}')">
          <span class="gl-tile" data-hue="${hue}">${Glyphs.svg(m.glyph)}</span>
          <span class="hm-big-name">${esc(m.label)}</span>
          <span class="hm-big-sub">${esc(m.sub)}</span>
          ${n ? `<span class="hm-badge" title="${escAttr(`${num(n)} on watch or at fault`)}">${num(n)}<span class="sr-only"> on watch or at fault</span></span>` : ''}
        </button>`;
    }).join('');
  }

  // Every other tab, under its group as TABS files them. Not the view's
  // groups: a view is the bar's, and this page is the one place every tab is
  // a press away whatever the bar is showing.
  function restHtml() {
    const skip = new Set(['home', ...MOST.map(m => m.tab)]);
    return TABS.map(g => {
      const tabs = g.tabs.filter(t => !skip.has(t.id) && tabShown(t));
      if (!tabs.length) return '';
      const [, hue] = Glyphs.group(g.group, tabs[0].id);
      const gid = 'hm-g-' + slug(g.group);
      return `
        <section class="hm-group" aria-labelledby="${gid}">
          <h4 id="${gid}">${esc(g.group)}</h4>
          <ul class="hm-tiles">
            ${tabs.map(t => {
              const cannot = tabCannot(t);
              return `
            <li><button type="button" class="hm-small" data-go="${t.id}" data-hue="${hue}" onclick="Home.go('${t.id}')"
                        title="${escAttr(cannot ? `${t.label} — ${cannot}` : t.label)}">
              <span class="gl-tile" data-hue="${hue}">${Glyphs.svg(Glyphs.tab(t.id))}</span>
              <span class="hm-small-name">${esc(t.label)}</span>
              ${cannot ? `<span class="sr-only"> — ${esc(cannot)}</span>` : ''}
            </button></li>`;
            }).join('')}
          </ul>
        </section>`;
    }).join('');
  }

  function render() {
    return `
      <div class="page hm-page">
        <h2 id="home-h" class="sr-only">Home</h2>
        ${nowHtml()}
        <section class="hm-most" aria-labelledby="home-most-h">
          <h3 id="home-most-h">Most used</h3>
          <div class="hm-bigs">${bigHtml()}</div>
        </section>
        <section class="hm-rest" aria-labelledby="home-rest-h">
          <h3 id="home-rest-h">Everything else</h3>
          ${restHtml()}
        </section>
      </div>`;
  }

  function init() { ask(); }

  function go(id) {
    if (state.activeTab === id) return;
    switchTab(id);
  }

  // ── In the banner ────────────────────────────────────────────────────────
  // 🏠 is the stylesheet's to show (Tiles and Signs); which page it is on is
  // this file's. Instrument's counts are drawn into #hdr-status, and the
  // batch asked for, whenever the bar is drawn — the look being picked, the
  // station list landing, an account signing in.
  function chrome() {
    const home = document.getElementById('btn-home');
    if (home) {
      if (state.activeTab === 'home') home.setAttribute('aria-current', 'page');
      else home.removeAttribute('aria-current');
    }
    bannerGlyphs();
    paintBanner();
    if (state.look === 'instrument') ask();
  }

  // The banner's buttons in the same hand as the rest of the look: each
  // emoji swapped for its pictogram, and put back for a look without them.
  // Only the drawing changes — the label beside it, and so the button's
  // name, is the button's own (setHeaderLabel, app.js, rewrites that alone).
  const BANNER = { 'btn-home': 'home', 'btn-palette': 'search', 'btn-share': 'share', 'btn-auth': 'user', 'btn-more': 'more', 'btn-whatsnew': 'sparkle' };
  function bannerGlyphs() {
    const on = lookHasSymbols() && typeof Glyphs !== 'undefined';
    for (const [id, name] of Object.entries(BANNER)) {
      const ico = document.querySelector(`#${id} > .hdr-ico`);
      if (!ico) continue;
      if (on && !ico.dataset.emoji) {
        ico.dataset.emoji = ico.textContent;
        ico.innerHTML = Glyphs.svg(name);
      } else if (!on && ico.dataset.emoji) {
        ico.textContent = ico.dataset.emoji;
        delete ico.dataset.emoji;
      }
    }
  }

  function paintBanner() {
    const el = document.getElementById('hdr-status');
    if (!el) return;
    const on = state.look === 'instrument' && typeof Glyphs !== 'undefined';
    if (!on) { if (!el.hidden) { el.hidden = true; el.innerHTML = ''; } return; }
    el.hidden = false;
    el.innerHTML = statusHtml({ brief: true });
  }

  return { render, init, go, chrome, statusHtml, MOST };
})();
if (typeof window !== 'undefined') window.Home = Home;
