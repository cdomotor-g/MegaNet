// MegaNet — offline-tab.js
//
//   OfflineTab   the 📲 Offline & Install tab: Flood-Net with no signal,
//                explained for somebody who has never heard the words
//                "progressive web app" — what this device has kept, a button
//                that keeps the rest in one go, how to put Flood-Net on the
//                home screen in the browser being used (with the browser's own
//                Install button where it offers one), and what does not work
//                with no signal, said plainly.
//
// After pwa.js (Pwa), before init.js; nothing runs at load — renderMain()
// calls render() and init(). Reaches back to core.js for esc, announce,
// APP_VERSION, registerTabTeardown and copyToClipboard; to app.js for keptAge
// and switchTab; to modal.js for confirmDialog; and to pwa.js for everything
// about the copy itself (sw.js says what is kept and why).
//
// ── Which browser this is ────────────────────────────────────────────────────
// The steps to install differ by browser and by platform, and no browser says
// where its own menu item is. detect() reads the user-agent string — the only
// place most of this is said — for the platform (iPhone or iPad, Android, a
// computer), the browser, the iOS version (Chrome, Edge and Firefox on an
// iPhone can add to the home screen only from iOS 16.4) and the one case that
// cannot install at all: another app's built-in browser, which is what a link
// opened from mail or chat lands in, and which is told how to get out. iPadOS
// presents itself as a Mac, so a Mac with a touch screen is an iPad. It is a
// guess, and the page says so: the steps for every other browser are one
// press away. Menus move between versions, which the page says too.
//
// ── What it says, and how ────────────────────────────────────────────────────
// The device's state is Pwa.status(), read when the tab opens and again on
// every change the page can see — the signal coming and going, the worker
// taking over, the install prompt arriving or being used — so the page never
// shows a tick it has not checked. Every mark is a glyph and a word as well
// as a colour. What is announced follows core.js's rule: only the result of
// something the person pressed — Get ready's outcome, the install's, Check's,
// Remove's — and the notes beside the buttons are not live regions.
//
// Exposes: render, init, refresh, prepare, install, checkUpdate, remove,
//          copyLink, detect, last.
// Requires: core.js, app.js, modal.js and pwa.js, at call time.

const OfflineTab = (function () {
  let last = null;            // the last Pwa.status() read
  let busy = false;           // Get ready is running
  let steps = null;           // its steps, as they stand: { id: { state, detail } }
  let notes = { ready: '', update: '', install: '', remove: '' };
  let wired = null;           // what init() listens to, so it can stop

  // ── Which browser ──────────────────────────────────────────────────────────

  // { key, name, platform, ios, iosVersion, inApp } from a user-agent string.
  // key names an entry in HOW.
  // An iPhone's home-screen app says no "Safari/" either, so `standalone`
  // (navigator.standalone, Safari's own flag) keeps it from reading as one.
  function detect(ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '',
                  touchMac = typeof navigator !== 'undefined' && navigator.platform === 'MacIntel'
                    && navigator.maxTouchPoints > 1,
                  standalone = typeof navigator !== 'undefined' && navigator.standalone === true) {
    const ios = /iPhone|iPad|iPod/.test(ua) || (touchMac && /Macintosh/.test(ua));
    const iosV = ua.match(/OS (\d+)[_.](\d+)/);
    // 17.04 for iOS 17.4: a number that orders the way versions do.
    const iosVersion = ios && iosV ? Number(iosV[1]) + Number(iosV[2]) / 100 : null;
    const iosLabel = ios && iosV ? `${iosV[1]}.${iosV[2]}` : '';
    const android = /Android/.test(ua);
    const device = ios ? (/iPad/.test(ua) || touchMac ? 'iPad' : 'iPhone') : android ? 'Android' : 'computer';
    // Another app's own browser: Android's WebView marks itself "; wv)", the
    // big apps name themselves, and an iPhone app's view carries no "Safari/".
    const named = /FBAN|FBAV|Instagram|LinkedInApp|Line\/|Twitter|MicroMessenger|GSA\//.test(ua);
    const inApp = named || (android && /; wv\)/.test(ua))
      || (ios && !standalone && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua));
    let key;
    if (inApp) key = 'inapp';
    else if (ios) key = /CriOS|FxiOS|EdgiOS|OPT\//.test(ua) ? 'ios-other' : 'ios-safari';
    else if (android) {
      key = /SamsungBrowser/.test(ua) ? 'android-samsung'
        : /EdgA\//.test(ua) ? 'android-edge'
        : /Firefox\//.test(ua) ? 'android-firefox'
        : /Chrome\//.test(ua) ? 'android-chrome' : 'other';
    } else {
      key = /Edg\//.test(ua) ? 'desktop-edge'
        : /Firefox\//.test(ua) ? 'desktop-firefox'
        : /OPR\//.test(ua) ? 'desktop-chrome'
        : /Chrome\//.test(ua) ? 'desktop-chrome'
        : /Safari\//.test(ua) && /Macintosh/.test(ua) ? 'desktop-safari' : 'other';
    }
    const browser = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS|EdgA\/|Edg\//.test(ua) ? 'Edge'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\/|OPT\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    const where = device === 'computer' ? 'a computer' : device === 'Android' ? 'Android' : `an ${device}`;
    const name = inApp ? `another app's built-in browser, on ${where}` : `${browser} on ${where}`;
    return { key, name, browser, platform: device, ios, iosVersion, iosLabel, inApp };
  }

  // How to install, by browser. Steps are HTML (authored here, not data).
  const HOW = {
    'ios-safari': {
      name: 'Safari on iPhone or iPad',
      steps: [
        'Tap <strong>Share</strong> — the square with an arrow pointing up: at the foot of the screen on an iPhone, at the top on an iPad.',
        'Scroll down the list and tap <strong>Add to Home Screen</strong>.',
        'Tap <strong>Add</strong>. Flood-Net is on your home screen.',
      ],
    },
    'ios-other': {
      name: 'Chrome, Edge or Firefox on iPhone or iPad',
      steps: [
        'Tap <strong>Share</strong> — in Chrome and Edge it is in the address bar; in Firefox, open the <strong>☰</strong> menu first.',
        'Tap <strong>Add to Home Screen</strong>.',
        'Tap <strong>Add</strong>.',
      ],
      note: 'Needs iOS 16.4 or later. On an older iPhone or iPad, open this page in Safari to add it.',
    },
    'android-chrome': {
      name: 'Chrome on Android',
      steps: [
        'Tap <strong>⋮</strong> at the top right.',
        'Tap <strong>Install app</strong> — on some phones it says <strong>Add to Home screen</strong>.',
        'Tap <strong>Install</strong>.',
      ],
    },
    'android-samsung': {
      name: 'Samsung Internet',
      steps: [
        'Tap <strong>☰</strong> at the bottom right — or the install icon in the address bar, if there is one.',
        'Tap <strong>Add page to</strong>, then <strong>Home screen</strong>.',
        'Tap <strong>Add</strong>.',
      ],
    },
    'android-firefox': {
      name: 'Firefox on Android',
      steps: [
        'Tap <strong>⋮</strong>.',
        'Tap <strong>Add app to Home screen</strong> — in some versions, <strong>Install</strong>.',
        'Tap <strong>Add</strong>.',
      ],
    },
    'android-edge': {
      name: 'Edge on Android',
      steps: [
        'Tap <strong>⋯</strong> at the foot of the screen.',
        'Tap <strong>Add to phone</strong>.',
        'Tap <strong>Install</strong>.',
      ],
    },
    'desktop-chrome': {
      name: 'Chrome on a computer',
      steps: [
        'Click the install icon at the right-hand end of the address bar — a screen with a down arrow.',
        'No icon? <strong>⋮</strong> → <strong>Cast, save and share</strong> → <strong>Install page as app…</strong>',
        'Click <strong>Install</strong>. Flood-Net opens in a window of its own, and has a place among your apps.',
      ],
    },
    'desktop-edge': {
      name: 'Edge on a computer',
      steps: [
        'Click <strong>⋯</strong> at the top right.',
        '<strong>Apps</strong> → <strong>Install this site as an app</strong>.',
        'Click <strong>Install</strong>.',
      ],
    },
    'desktop-safari': {
      name: 'Safari on a Mac',
      steps: [
        '<strong>File</strong> → <strong>Add to Dock…</strong> (macOS Sonoma or later).',
        'Click <strong>Add</strong>. Flood-Net is in the Dock, and opens in a window of its own.',
      ],
    },
    'desktop-firefox': {
      name: 'Firefox on a computer',
      none: 'Firefox on a computer cannot install a site as an app. The saved copy works in a Firefox tab all the same — bookmark this page — or install Flood-Net from Chrome or Edge.',
    },
    inapp: {
      name: 'Another app\'s built-in browser',
      none: 'This page is open inside another app — mail, chat or social media opens links in a browser of its own — and that browser cannot install anything or keep a copy for long. Copy this page\'s address and open it in Safari on an iPhone or iPad, or Chrome on Android.',
    },
    other: {
      name: 'Another browser',
      steps: [
        'Open the browser\'s menu.',
        'Look for <strong>Install</strong>, <strong>Install app</strong> or <strong>Add to Home screen</strong>.',
      ],
    },
  };
  const ORDER = ['ios-safari', 'ios-other', 'android-chrome', 'android-samsung', 'android-firefox',
    'android-edge', 'desktop-chrome', 'desktop-edge', 'desktop-safari', 'desktop-firefox'];

  // ── Pieces ─────────────────────────────────────────────────────────────────

  const MARK = {
    ok:    ['✓', 'txt-ok'],
    warn:  ['!', 'txt-warn'],
    bad:   ['✗', 'txt-bad'],
    info:  ['○', 'txt-muted'],
    doing: ['…', 'txt-muted'],
  };
  const mark = kind => `<span class="ot-mark ${MARK[kind][1]}" aria-hidden="true">${MARK[kind][0]}</span>`;
  // A fact: the mark, a word that says the same, and the rest.
  const fact = (kind, word, rest = '') => `${mark(kind)} <strong>${esc(word)}</strong>${rest ? ` — ${rest}` : ''}`;

  const mb = n => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  const gb = n => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : mb(n));
  const SOURCE = { api: 'the datastore', bundled: 'this site\'s copy of stations.json', github: 'the copy on GitHub' };

  const WHY = {
    insecure: 'this page was not opened over https — a copy opened from a file, or from a plain http address, is left exactly as it is',
    nosw: 'this browser — or this window: a private one, perhaps — cannot keep one',
  };

  // The one line at the top of This device: ready, not yet, or not possible.
  function verdict(s) {
    if (!s) return { kind: 'doing', text: 'Checking what this device has kept…' };
    if (s.possible) return { kind: 'bad', text: `This device cannot keep a copy here: ${WHY[s.possible]}.` };
    const shellOk = s.shell.whole && s.worker === s.version;
    const ready = shellOk && s.list && s.sheets.of && s.sheets.kept === s.sheets.of;
    if (ready) return { kind: 'ok', text: 'Ready. This device will open Flood-Net with no signal.' };
    if (s.optedOut) return { kind: 'warn', text: 'Turned off on this device (Start again, below). Get this device ready turns it back on.' };
    if (s.automation && !s.wanted) return { kind: 'info', text: 'Not set up: this browser is being driven by an automated test, which keeps no copy unless one is asked for.' };
    if (s.settingUp || (s.worker && !shellOk)) return { kind: 'doing', text: 'Setting up — saving the app\'s files. This page will say when it is done.' };
    return { kind: 'warn', text: 'Not ready yet. Press Get this device ready, below, while you have a signal.' };
  }

  function factsHtml(s) {
    if (!s) return '';
    const rows = [];
    rows.push(['Signal', s.online ? fact('ok', 'Online') : fact('bad', 'No signal', 'what is saved on this device is what Flood-Net shows')]);
    const d = detect();
    rows.push(['Browser', `${esc(d.name)}${d.inApp ? ` — ${fact('warn', 'cannot install', 'see Put it on your home screen')}` : ''}
      <span class="ot-aside">A guess from what the browser says about itself.</span>`]);
    rows.push(['Opened as', s.installed ? fact('ok', 'The installed app') : 'A browser tab']);
    if (s.possible) {
      rows.push(['App', fact('bad', 'Cannot be saved here')]);
    } else {
      const shellOk = s.shell.whole && s.worker === s.version;
      rows.push(['App', shellOk
        ? fact('ok', 'Saved', `this version (${esc(s.version)}), ${s.shell.files} files`)
        : s.shell.files
          ? fact('doing', 'Being saved', `${s.shell.files} files so far`)
          : s.shell.older.length
            ? fact('warn', 'An older version is saved', `${esc(s.shell.older.join(', '))}; this version's files are not saved yet`)
            : fact('bad', 'Not saved yet')]);
      rows.push(['Station list', s.list
        ? fact('ok', 'Saved', `${s.list.at ? `${esc(keptAge(s.list.at))} ago, ` : ''}from ${esc(SOURCE[s.list.kind] || s.list.kind)}`)
        : fact('bad', 'Not saved yet')]);
      rows.push(['Inspection and maintenance sheets', !s.sheets.of
        ? fact('info', 'Not known')
        : s.sheets.kept === s.sheets.of
          ? fact('ok', 'Ready', `all ${s.sheets.of} of their pick-lists saved`)
          : s.sheets.kept
            ? fact('warn', 'Partly ready', `${s.sheets.kept} of ${s.sheets.of} pick-lists saved`)
            : fact('bad', 'Not saved yet')]);
      if (s.storage) {
        const kept = s.storage.persisted === true
          ? fact('ok', 'Protected', 'the browser will not clear it to make room')
          : s.storage.persisted === false
            ? fact('warn', 'Not protected', 'the browser may clear it if the device runs short of space')
            : '';
        rows.push(['Space used', `${mb(s.storage.usage)}${s.storage.quota ? ` of the ${gb(s.storage.quota)} this browser allows this site` : ''}${kept ? `<br>${kept}` : ''}`]);
      }
    }
    return `<dl class="ot-facts">${rows.map(([k, v]) => `<div class="ot-fact"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }

  function statusHtml() {
    const v = verdict(last);
    return `
      <p class="ot-verdict ot-verdict--${v.kind}">${mark(v.kind)} ${esc(v.text)}</p>
      ${factsHtml(last)}`;
  }

  const STEP_TEXT = {
    app:     'Save the app\'s files',
    list:    'Save the station list',
    sheets:  'Save the inspection and maintenance sheets\' pick-lists',
    protect: 'Ask the browser to keep them through a clean-up',
  };

  function stepDetail(id, st) {
    const d = st.detail;
    if (id === 'app') {
      if (st.state === 'failed') {
        return d === 'slow' ? 'it is taking a long time — the signal may be too weak; try again where it is stronger'
          : 'the browser could not save every file — check the signal, reload the page (to sign in again, if you have been away a while) and try again';
      }
      return d ? `${d} files` : '';
    }
    if (id === 'list') {
      if (st.state === 'done') return `from ${SOURCE[d] || d}`;
      if (st.state === 'failed') return 'none of its sources answered — reload the page and try again';
      return '';
    }
    if (id === 'sheets' && d && typeof d === 'object') return `${d.kept} of ${d.of}`;
    if (id === 'protect') {
      if (st.state === 'done') return 'it will';
      if (st.state === 'note') return 'it did not promise to — it may clear the copy if space runs short; installing Flood-Net usually changes its mind';
    }
    return '';
  }

  function stepsHtml() {
    if (!steps) return '';
    const word = { waiting: 'Waiting', doing: 'Doing', done: 'Done', failed: 'Failed', note: 'Note' };
    const kind = { waiting: 'info', doing: 'doing', done: 'ok', failed: 'bad', note: 'warn' };
    return `
      <ol class="ot-steps" aria-label="Getting this device ready">
        ${Object.keys(STEP_TEXT).map(id => {
          const st = steps[id] || { state: 'waiting' };
          const more = stepDetail(id, st);
          return `<li class="ot-step ot-step--${st.state}">${mark(kind[st.state])}
            <span><strong>${esc(STEP_TEXT[id])}</strong> — ${esc(word[st.state])}${more ? `: ${esc(more)}` : ''}</span></li>`;
        }).join('')}
      </ol>`;
  }

  function stepsFor(key) {
    const h = HOW[key];
    if (!h) return '';
    if (h.none) return `<p>${esc(h.none)}</p>`;
    return `<ol class="ot-how">${h.steps.map(x => `<li>${x}</li>`).join('')}</ol>${h.note ? `<p class="ot-aside">${esc(h.note)}</p>` : ''}`;
  }

  function installHtml() {
    const s = last;
    const d = detect();
    const iosNote = !d.ios ? ''
      : s && s.installed
        ? `<p class="ot-note">${mark('warn')} <strong>This is the home-screen app.</strong> On an iPhone or iPad its copy
            and its sign-in are its own, separate from the browser's — so get it ready here, with
            <strong>Get this device ready</strong> above.</p>`
        : `<p class="ot-note">${mark('warn')} <strong>On an iPhone or iPad</strong>, the home-screen icon keeps a copy of
            its own, separate from ${esc(d.key === 'ios-safari' ? 'Safari' : 'the browser')}'s — and its own sign-in. After
            adding it, open Flood-Net from the icon while you have a signal, sign in if asked, and press
            <strong>Get this device ready</strong> there too.</p>`;
    let lead;
    if (s && (s.installed || s.installedNow)) {
      lead = `<p class="ot-verdict ot-verdict--ok">${mark('ok')} ${s.installed
        ? 'You are using Flood-Net as an installed app.'
        : 'Installed. Look for Flood-Net on your home screen, or among your apps.'}</p>`;
    } else if (s && s.canPrompt) {
      lead = `<p>This browser can install Flood-Net for you: it asks you to confirm, and puts Flood-Net on your
          home screen or among your apps.</p>
        <div class="button-group">
          <button type="button" class="primary" id="ot-install" onclick="OfflineTab.install()">📲 Install Flood-Net</button>
        </div>`;
    } else if (d.key === 'ios-other' && d.iosVersion && d.iosVersion < 16.04) {
      lead = `<p class="ot-verdict ot-verdict--warn">${mark('warn')} This ${esc(d.platform)} runs iOS ${esc(d.iosLabel)}, and
          ${esc(d.browser)} can add to the home screen only from iOS 16.4. Open this page in Safari to add it.</p>
        <div class="button-group">
          <button type="button" onclick="OfflineTab.copyLink()">📋 Copy this page's address</button>
        </div>`;
    } else if (d.inApp) {
      lead = `<p class="ot-verdict ot-verdict--warn">${mark('warn')} ${esc(HOW.inapp.none)}</p>
        <div class="button-group">
          <button type="button" onclick="OfflineTab.copyLink()">📋 Copy this page's address</button>
        </div>`;
    } else {
      lead = `<p>In <strong>${esc(d.name)}</strong>:</p>${stepsFor(d.key)}`;
    }
    const others = ORDER.filter(k => k !== d.key);
    return `
      ${lead}
      ${notes.install ? `<p class="ot-aside">${esc(notes.install)}</p>` : ''}
      ${iosNote}
      <p>Installing is optional. With or without it, this device keeps its copy — except on an iPhone or iPad,
        where the icon keeps one of its own.</p>
      <details class="ot-more">
        <summary>Steps for other browsers</summary>
        ${others.map(k => `<h4>${esc(HOW[k].name)}</h4>${stepsFor(k)}`).join('')}
        <p class="ot-aside">Menus move between versions. If a step does not match, look in the browser's menu for
          <strong>Install</strong> or <strong>Add to Home screen</strong>.</p>
      </details>`;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    const offline = last && !last.online;
    const cannot = last && last.possible;
    return `
    <div class="page ot-page" id="ot-page" style="--page-max:1000px">
      <div class="ot-hero">
        <h2 class="ot-title" id="ot-h"><span aria-hidden="true">📲</span> Offline &amp; install</h2>
        <p class="ot-lede">Flood-Net can keep a copy of itself on this device, so it still opens where there is
          no signal — and it can sit on your home screen like any other app. This page says what that does, gets
          this device ready, and says plainly what it cannot do.</p>
      </div>

      <section class="panel ot-device" aria-labelledby="ot-device-h">
        <h3 id="ot-device-h" tabindex="-1">This device</h3>
        <div id="ot-status">${statusHtml()}</div>
        <div class="button-group">
          <button type="button" class="primary" id="ot-ready" onclick="OfflineTab.prepare()"
                  ${busy || offline || cannot ? 'disabled' : ''}>✅ Get this device ready for no signal</button>
          <button type="button" id="ot-recheck" onclick="OfflineTab.refresh()" ${busy ? 'disabled' : ''}>🔄 Check again</button>
        </div>
        ${offline ? '<p class="ot-aside">Getting ready needs a signal: come back to this page when you have one.</p>' : ''}
        <div id="ot-steps">${stepsHtml()}</div>
        ${notes.ready ? `<p class="ot-aside" id="ot-ready-note">${esc(notes.ready)}</p>` : ''}
      </section>

      <section class="panel" aria-labelledby="ot-install-h">
        <h3 id="ot-install-h" tabindex="-1">Put it on your home screen</h3>
        <div id="ot-install-body">${installHtml()}</div>
      </section>

      <section class="panel" aria-labelledby="ot-before-h">
        <h3 id="ot-before-h" tabindex="-1">Before you head out of signal</h3>
        <ol class="ot-list">
          <li>With a signal, open Flood-Net — as you have now.</li>
          <li>Press <strong>Get this device ready for no signal</strong>, above, and wait for the ticks. (Simply
            opening Flood-Net with a signal does the same by itself, given a minute; the button does it now, and
            says when it is done.)</li>
          <li>If you like, put it on your home screen (above).</li>
          <li>To be sure: turn on flight mode and open Flood-Net again. The header should say
            <em>saved copy, … old — no signal</em>. Turn flight mode off afterwards.</li>
        </ol>
      </section>

      <section class="panel" aria-labelledby="ot-nosignal-h">
        <h3 id="ot-nosignal-h" tabindex="-1">With no signal</h3>
        <div class="ot-cols">
          <div>
            <h4>${mark('ok')} Works</h4>
            <ul class="ot-list">
              <li>Opening Flood-Net — from its icon, a bookmark or its address.</li>
              <li>The station list as it was when it was saved — the header says how old — with the map's pins,
                search, the filters and each station's details.</li>
              <li><strong>Inspections</strong> and <strong>Site Maintenance</strong>: start a sheet and save its
                draft on this device.</li>
              <li>Tools that work from the station list or from what you paste: <strong>Pass Ranges</strong>,
                <strong>Bit Flipper</strong>, <strong>ALERT Packets</strong>, <strong>HFEM Messages</strong>.</li>
              <li>The <strong>Site Map</strong>, and every tab's ❔ Help.</li>
            </ul>
          </div>
          <div>
            <h4>${mark('bad')} Needs a signal</h4>
            <ul class="ot-list">
              <li>New readings — the list does not change until the device has a signal again.</li>
              <li>The map's background: street, satellite and terrain imagery is not saved, so it may be blank
                (or show only places you looked at recently). The pins are there regardless.</li>
              <li>Everything read from the datastore as you go: <strong>Field Data</strong>, the
                <strong>Message Log</strong>, <strong>Station Health</strong>, <strong>Inspection History</strong>,
                <strong>Field Photos</strong>, <strong>Base Stations</strong>, <strong>Admin</strong>.</li>
              <li>Signing in; sending a sheet to the database (its draft waits on this device); ARRO; the printed
                map sheets; Ask Claude; Report a Bug.</li>
            </ul>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="ot-updates-h">
        <h3 id="ot-updates-h" tabindex="-1">Updates</h3>
        <p>With a signal, Flood-Net always opens the newest version, and the saved copy moves on with it. A page
          that opened from the saved copy looks for a newer version as soon as it can reach the site, and says so
          at the foot of the window — <strong>Reload now</strong> or <strong>Later</strong>. It never reloads by
          itself, so a sheet you are filling in is never lost.</p>
        <div class="button-group">
          <button type="button" id="ot-check" onclick="OfflineTab.checkUpdate()" ${offline ? 'disabled' : ''}>🔎 Check for a newer version</button>
        </div>
        ${notes.update ? `<p class="ot-aside" id="ot-update-note">${esc(notes.update)}</p>` : ''}
      </section>

      <section class="panel" aria-labelledby="ot-limits-h">
        <h3 id="ot-limits-h" tabindex="-1">Good to know</h3>
        <ul class="ot-list">
          <li><strong>The first visit needs a signal</strong>, and so does signing in. After that, with no
            signal, the saved copy opens on the device itself — the sign-in cannot be reached, and is not asked
            for until there is a signal again.</li>
          <li><strong>A weak signal can be slower than none.</strong> On one bar, Flood-Net may wait a while for
            the network before it falls back to the saved copy. Flight mode makes it use the copy straight away.</li>
          <li><strong>On an iPhone or iPad</strong>, the home-screen icon keeps a copy and a sign-in of its own,
            separate from the browser's. Set it up from the icon.</li>
          <li><strong>Each browser keeps its own.</strong> Chrome and Firefox on one computer each need setting
            up, and a private or incognito window forgets its copy when it closes.</li>
          <li><strong>Clearing the browser's data</strong> for this site removes the copy, and any sheet drafts
            not yet sent. The browser may also clear the copy by itself if the device runs short of space —
            unless it has promised not to (<em>This device</em>, above).</li>
          <li><strong>What is kept:</strong> the app, the station list and the sheets' pick-lists — the same for
            everybody. Drafts are kept separately, as they always were. No readings, photos or records are
            saved.</li>
          <li><strong>It is per version.</strong> Each version of Flood-Net keeps its own copy, and the newest
            replaces the last the next time the device has a signal.</li>
        </ul>
      </section>

      <section class="panel" aria-labelledby="ot-how-h">
        <h3 id="ot-how-h" tabindex="-1">How it works</h3>
        <p>For the curious. The browser runs a small helper for this site — a <em>service worker</em> — that keeps
          the copy. With a signal it stays out of the way: Flood-Net loads from the internet as it always did, and
          the helper keeps what came. With no signal it hands over what it kept, and says how old. The site is
          behind Cloudflare Access, so the helper never shows the saved copy while the internet is answering: it
          never walks round the sign-in. An app that does this is called a <em>progressive web app</em>, or PWA.</p>
      </section>

      <section class="panel" aria-labelledby="ot-remove-h">
        <h3 id="ot-remove-h" tabindex="-1">Start again</h3>
        <p>If the saved copy seems stuck or wrong, remove it, then press <strong>Get this device ready</strong>
          again. Sheet drafts are stored separately and are not touched.</p>
        <div class="button-group">
          <button type="button" class="btn-danger" id="ot-remove" onclick="OfflineTab.remove()"
                  ${busy || cannot ? 'disabled' : ''}>🗑️ Remove the saved copy from this device</button>
        </div>
        ${notes.remove ? `<p class="ot-aside" id="ot-remove-note">${esc(notes.remove)}</p>` : ''}
      </section>
    </div>`;
  }

  // Repaint in place, if the tab is open: the page's own markup, so focus
  // goes back to the control that had it (by id) — or, where that control is
  // gone or switched off (📲 Install, once used; Get ready, while it runs), to
  // its section's heading rather than to nowhere — and the scroll stays.
  function repaint() {
    const page = document.getElementById('ot-page');
    if (!page) return;
    const active = document.activeElement && page.contains(document.activeElement) ? document.activeElement : null;
    const had = active && { id: active.id, section: (active.closest('section') || { getAttribute: () => '' }).getAttribute('aria-labelledby') };
    const open = [...page.querySelectorAll('details.ot-more')].map(d => d.open);
    page.outerHTML = render();
    const again = document.getElementById('ot-page');
    if (!again) return;
    again.querySelectorAll('details.ot-more').forEach((d, i) => { if (open[i]) d.open = true; });
    if (!had) return;
    let el = had.id && document.getElementById(had.id);
    if (!el || el.disabled) el = had.section && document.getElementById(had.section);
    if (el) el.focus({ preventScroll: true });
  }

  async function refresh() {
    try { last = await Pwa.status(); } catch (_) { /* keep what it said */ }
    repaint();
  }

  // The signal coming and going, the app being installed or opened as one,
  // and anything pwa.js sees change: each reads the device again. Undone on
  // the way out of the tab — and before a second init(), since renderMain()
  // draws this tab again without leaving it (a list arriving, a theme).
  function unwire() {
    if (!wired) return;
    window.removeEventListener('online', wired.again);
    window.removeEventListener('offline', wired.again);
    if (wired.mode) wired.mode.removeEventListener('change', wired.again);
    wired.off();
    wired = null;
  }

  function init() {
    unwire();
    const again = () => refresh();
    let mode = null;
    try { mode = matchMedia('(display-mode: standalone)'); mode.addEventListener('change', again); } catch (_) { mode = null; }
    window.addEventListener('online', again);
    window.addEventListener('offline', again);
    wired = { again, mode, off: Pwa.onChange(again) };
    registerTabTeardown('OfflineTab', unwire);
    refresh();
  }

  // ── The buttons ────────────────────────────────────────────────────────────

  async function prepare() {
    if (busy) return;
    busy = true;
    steps = { app: { state: 'waiting' }, list: { state: 'waiting' }, sheets: { state: 'waiting' }, protect: { state: 'waiting' } };
    notes.ready = '';
    repaint();
    const paintSteps = () => {
      const el = document.getElementById('ot-steps');
      if (el) el.innerHTML = stepsHtml();
    };
    let out;
    try {
      out = await Pwa.prepare((id, state, detail) => { steps[id] = { state, detail }; paintSteps(); });
    } catch (err) {
      out = { ok: false, why: 'install' };
    }
    busy = false;
    notes.ready = out.ok
      ? 'Ready. This device will open Flood-Net with no signal.'
      : out.why === 'offline' ? 'No signal: getting ready needs one. Come back to this page when you have a signal.'
      : out.why === 'insecure' || out.why === 'nosw' ? `This device cannot keep a copy here: ${WHY[out.why]}.`
      : 'Not everything could be saved — the steps above say which. Check the signal and press the button again.';
    await refresh();
    announce(notes.ready);
  }

  async function install() {
    const outcome = await Pwa.promptInstall();
    notes.install = outcome === 'accepted' ? 'Installed. Look for Flood-Net on your home screen, or among your apps.'
      : outcome === 'dismissed' ? 'Not installed. You can install it from here whenever you like.'
      : 'The browser is not offering to install it just now — use its menu instead (the steps below).';
    await refresh();
    announce(notes.install);
  }

  async function checkUpdate() {
    const btn = document.getElementById('ot-check');
    if (btn) btn.disabled = true;
    const r = await Pwa.check({ force: true });
    notes.update = r === 'newer' ? 'A newer version is ready — see the bar at the foot of the window.'
      : r === 'same' ? `This is the newest version (${APP_VERSION}).`
      : r === 'offline' ? 'No signal: checking needs one.'
      : r === 'dev' ? 'This copy has no version stamp to compare (opened from the files, not the site).'
      : 'The site could not be reached to check. If you have been away a while, reload the page to sign in again.';
    repaint();
    announce(notes.update);
  }

  async function remove() {
    const answer = await confirmDialog({
      title: 'Remove the saved copy?',
      message: 'This device will not open Flood-Net with no signal until it is set up again. Sheet drafts are kept.',
      confirm: 'Remove the saved copy', danger: true,
      checkbox: { label: 'Do not keep a copy on this device again — for a shared computer' },
    });
    if (!answer) return;
    await Pwa.remove({ keepOff: !!answer.checked });
    steps = null;
    notes.ready = '';
    notes.remove = answer.checked
      ? 'Removed, and turned off on this device. Get this device ready turns it back on.'
      : 'Removed. Flood-Net sets itself up again the next time it opens with a signal — or press Get this device ready.';
    await refresh();
    announce(notes.remove);
  }

  async function copyLink() {
    const ok = await copyToClipboard(location.href);
    notes.install = ok ? 'Copied. Paste it into Safari or Chrome.' : 'Could not copy — the address is in the bar at the top of the screen.';
    repaint();
    announce(notes.install);
  }

  return {
    render, init, refresh, prepare, install, checkUpdate, remove, copyLink, detect,
    last: () => last,
  };
})();
if (typeof window !== 'undefined') window.OfflineTab = OfflineTab;
