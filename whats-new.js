// MegaNet — whats-new.js
//
// WhatsNew — ✨ What's new in the banner, after a release with changes
// somebody using the app would notice (#222).
//
// The list is written here, for the people using the app, a line each: what
// changed on screen and where to find it. Not the roadmap's revision notes,
// which are written for whoever works on the code and say why; not the commit
// log either. An entry is added in the same push as the change it describes,
// with the next number — the number, not the date, is what "seen" remembers,
// because two releases can share a day.
//
// The pill shows only while an entry is unseen on this device, and pressing it
// is seeing them all. A device that has never opened the app (Route's
// newDevice) has seen everything already: a list of what changed is news only
// to somebody who knew what it was before.
//
// Nothing runs at load. init.js calls start().
//
// Exposes: start, open, entries.
// Requires: core.js (esc), modal.js, route.js.

const WhatsNew = (() => {
  const SEEN_KEY = 'mn-whats-new';

  // Newest first. `html` is trusted markup — it is written here, not typed in.
  const ENTRIES = [
    { n: 7, date: '2026-10-07', items: [
      '<strong>📲 Offline &amp; Install</strong>, a new tab under <em>Start here</em>: what Flood-Net does with no '
        + 'signal, what this device has saved and when, <strong>Get this device ready for no signal</strong> to save '
        + 'the rest in one go, and how to put Flood-Net on your home screen in the browser you are using — with an '
        + '<strong>Install</strong> button where the browser offers one. It also says plainly what does not work with '
        + 'no signal.',
      'One visit with a signal is now enough: the station list and the inspection sheets\' pick-lists are saved '
        + 'along with the app.',
    ] },
    { n: 6, date: '2026-10-07', items: [
      '<strong>Opens with no signal.</strong> A device that has opened Flood-Net before opens it again out of range, '
        + 'with the station list it last had — the header says it is a <strong>saved copy</strong>, and how old — and '
        + 'the inspection and maintenance sheets ready to start. On a phone it can be added to the home screen, and '
        + 'opens like an app.',
      'A page opened from the saved copy looks, once there is a signal, for a newer version, and says when there is '
        + 'one — <strong>Reload now</strong> or <strong>Later</strong>. It never reloads by itself, so a sheet half '
        + 'filled in is never lost.',
    ] },
    { n: 5, date: '2026-10-07', items: [
      '<strong>⤓ Export</strong> in the banner: what the tab you are on can save as a file, in one place — the station '
        + 'list as CSV, GeoJSON or KML (with the filters you have set), a chart, a table, a drawing. A tab with nothing '
        + 'to save says so, and why.',
      'Every file Flood-Net saves is named <strong>floodnet-…</strong>, so a download folder sorts them together.',
    ] },
    { n: 4, date: '2026-10-07', items: [
      '<strong>A station\'s health on its card.</strong> Under its owner, a station\'s card on the Stations map says '
        + 'when it was last heard, how its battery is doing night to night, and what is wrong with it — each line opens '
        + '<em>Station Health</em> on that station.',
      '<strong>Colour pins by health</strong>, in 🗺️ Map display: every pin OK, watch, fault or no data — with its size '
        + 'and a ring as well as its colour, and a key in the legend.',
    ] },
    { n: 3, date: '2026-10-07', items: [
      '<strong>No more browser pop-ups.</strong> Where the browser used to stop the page to ask <em>OK or Cancel?</em>, '
        + 'Flood-Net asks in a dialog of its own, and the button that acts says what it does — <em>Delete the station</em>, '
        + '<em>Revoke the token</em>, <em>Remove the drawings</em>. How something went is said in a note at the foot of the '
        + 'window; a failure stays there until you dismiss it.',
      'On a phone, or in a browser without Web Serial, the nav marks the <strong>Serial Monitor</strong> 🖥️: it needs '
        + 'Chrome, Edge or Opera on a computer to reach a device on a cable.',
    ] },
    { n: 2, date: '2026-10-07', items: [
      '<strong>Flood classes on the charts.</strong> On <em>ARRO Data</em> and <em>Field Data</em>, a level series\' card '
        + 'has <strong>Flood classes</strong> and <strong>AEP levels</strong>: tick either to draw the station\'s minor, '
        + 'moderate and major levels, or its AEP levels, as labelled lines across the chart — and into the PNG and SVG '
        + 'exports. Each is drawn in the series\' own datum, on the gauge or in metres AHD; one that cannot be placed '
        + 'is left out, and the card says why.',
    ] },
    { n: 1, date: '2026-10-07', items: [
      '<strong>The address bar says where you are</strong> — the tab, the station whose card is up and the map\'s '
        + 'view — so a bookmark, a reload or a link sent to somebody opens exactly that. <strong>🔗 Copy link</strong> on a '
        + 'station\'s card makes one. Back and forward move between tabs and stations.',
      '<strong>🔎 Search</strong> in the banner, or <kbd>Ctrl</kbd>+<kbd>K</kbd> anywhere: a station by name, number or '
        + 'ALERT address, a place, a tab or an action, in one box.',
      '<strong>Loading says what it is doing</strong> — which source it is asking and how much has arrived — and if '
        + 'nothing answers, what was tried, with <em>Try again</em>.',
      'A first visit opens the <strong>Site Map</strong>, the app\'s guide to every tab. After that the app opens on '
        + 'the tab you used last.',
      '<strong>🌗 Theme</strong> follows this device\'s light or dark setting unless you pick one — and there is a '
        + 'fourth, <strong>Sunlight</strong>: black on white with heavier lines on the map, for a screen read outdoors.',
    ] },
  ];

  const latest = () => ENTRIES.length ? ENTRIES[0].n : 0;

  function seen() {
    try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (_) { return latest(); }
  }

  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, String(latest())); } catch (_) {}
    sync();
  }

  const unseen = () => ENTRIES.filter(e => e.n > seen());

  function sync() {
    const btn = document.getElementById('btn-whatsnew');
    if (btn) btn.hidden = !unseen().length;
  }

  function dateText(iso) {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Every entry, newest first, the unseen ones marked — then they are seen.
  function open() {
    const fresh = new Set(unseen().map(e => e.n));
    Modal.open({
      title: 'What\'s new in Flood-Net',
      html: `<div class="wn">${ENTRIES.map(e => `
        <section class="wn-entry${fresh.has(e.n) ? ' is-new' : ''}">
          <h3 class="wn-date">${esc(dateText(e.date))}${fresh.has(e.n) ? ' <span class="wn-tag">new</span>' : ''}</h3>
          <ul>${e.items.map(i => `<li>${i}</li>`).join('')}</ul>
        </section>`).join('')}</div>`,
    });
    markSeen();
  }

  // init.js, once.
  function start() {
    if (typeof Route !== 'undefined' && Route.newDevice()) markSeen();
    else sync();
  }

  return { start, open, entries: ENTRIES };
})();
