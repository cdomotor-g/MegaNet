// MegaNet — site-roads.js
//
//   SiteRoads   The road and the bridge at a station or a picked point, and who
//               manages them: the nearest road and whether it is
//               State-controlled (Transport and Main Roads), the council's, a
//               park's or private; the nearest bridge and whose it is; and who
//               to call about them — the council or the TMR district, with a
//               phone number and an email address. A section on the station
//               card, and the same rows on the What is here card (map-here.js).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr and announce, to app.js for docUrl,
// and across to map-road-owners.js for every answer: the sources, the owner
// classes and the contact lookup live there, beside the layer that draws the
// same data. All from inside its own functions, so this file's position among
// the modules is free. app.js's stnCardHtml() places the section and calls
// ask(); map-here.js does the same for a picked point.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// The layer answers "whose roads are these?" for a view; this answers it for
// the one place somebody is asking about. A gauge on a bridge is the case it is
// for: whose bridge, so whose permission to work on it, and whose number to
// ring when a flood has taken its approach. The land section above it
// (site-land.js) can only say a road reserve is "council or TMR"; this is the
// half of the answer that says which.
//
// ── What a row can say ──────────────────────────────────────────────────────
// site-land.js's rule: an answer, "asking…", or "could not be read" with the
// source named and why. A request that failed is never shown as "none". The
// three questions fail apart — the road, the bridge and who to call each have
// their own rows — so a dead lookup leaves the road and the bridge standing.
//
// ── What it costs ───────────────────────────────────────────────────────────
// Four requests a position: the roads in a box ROAD_M round it, the two bridge
// sets in a box BRIDGE_M round it, and the lookup. Kept for the session per
// position, to site-land.js's metre; a failed one is not asked again for
// FAIL_TTL unless Try again is pressed.
const SiteRoads = (function () {
  const ROAD_M    = 150;
  const BRIDGE_M  = 150;
  const KEY_DP    = 5;
  const CACHE_MAX = 64;
  const FAIL_TTL  = 60000;
  // site-land.js's box: outside it nothing is asked.
  const QLD_BOX = { w: 137.9, e: 153.7, s: -29.3, n: -9.0 };
  // Nearer than this, the point is on the road or the bridge, not beside it.
  const ON_M = 12;

  const SOURCES = {
    road: {
      name: 'Queensland Roads and Tracks',
      title: 'Queensland roads and tracks (QRT) — the road segments and their owners, and its bridges',
      by: 'State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development)',
      licence: 'CC BY 4.0',
      page: 'https://www.data.qld.gov.au/dataset/queensland-roads-and-tracks',
    },
    bridge: {
      name: 'the bridge registers',
      title: 'State controlled roads bridges — Queensland (TMR’s register of the bridges it manages)',
      by: 'State of Queensland (Transport and Main Roads)',
      licence: 'CC BY 3.0 AU',
      page: 'https://www.data.qld.gov.au/dataset/state-controlled-roads-bridges-queensland',
    },
    contact: {
      name: 'QLDTraffic’s road lookup',
      title: 'Road Lookup — QLDTraffic, who to contact about a road',
      by: 'State of Queensland (Transport and Main Roads)',
      licence: 'contact details as QLDTraffic publishes them',
      page: 'https://qldtraffic.qld.gov.au/lookup.html',
    },
  };

  const NEXT = {
    permit:  { title: 'Road corridor permits — Transport and Main Roads', page: 'https://www.tmr.qld.gov.au/rcp' },
    traffic: { title: 'QLDTraffic — closures, flooding and roadworks', page: 'https://qldtraffic.qld.gov.au/' },
  };

  const TITLE = {
    head: 'The road and the bridge nearest this point, from Queensland’s own road data, and who manages each — '
        + 'Transport and Main Roads for a State-controlled road, the council for nearly every other — with who to '
        + 'call, from QLDTraffic’s road lookup.',
    road: `The nearest road within ${ROAD_M} m, as Queensland Roads and Tracks maps its centreline, with its national `
        + 'and State route numbers.',
    who: 'Who manages and controls the road. In Queensland the land under a public road is the State’s; a road '
       + 'declared State-controlled is managed by Transport and Main Roads, and nearly every other by the council.',
    bridge: `The nearest bridge within ${BRIDGE_M} m. Transport and Main Roads’ register names every bridge it `
          + 'manages; a bridge not on it is managed with the road it carries, which is normally the council’s.',
    contact: 'Who to contact about the road or bridge, as QLDTraffic’s road lookup gives it for this point.',
  };

  // ── Asking ───────────────────────────────────────────────────────────────

  function key(s) {
    if (!s || s.lat == null || s.lon == null || s.lat === '' || s.lon === '') return null;
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return `${lat.toFixed(KEY_DP)},${lon.toFixed(KEY_DP)}`;
  }

  const pointOf = k => k.split(',').map(Number);

  function inBox(k) {
    const [lat, lon] = pointOf(k);
    return lon >= QLD_BOX.w && lon <= QLD_BOX.e && lat >= QLD_BOX.s && lat <= QLD_BOX.n;
  }

  const answers = new Map();   // position → { road, bridge, contact, busy }
  const asked = new Map();     // element id → the place last asked about there

  function entry(k) {
    let a = answers.get(k);
    if (a) {
      answers.delete(k);
      answers.set(k, a);
      return a;
    }
    a = { busy: {} };
    answers.set(k, a);
    if (answers.size > CACHE_MAX) {
      for (const [old, v] of answers) {
        if (old !== k && !Object.values(v.busy).some(Boolean)) { answers.delete(old); break; }
      }
    }
    return a;
  }

  const settled = r => !!r && (r.ok || Date.now() - r.at < FAIL_TTL);

  const QUESTIONS = {
    road:    (lat, lon) => MapRoadOwners.roadNear(lat, lon, ROAD_M),
    bridge:  (lat, lon) => MapRoadOwners.bridgeNear(lat, lon, BRIDGE_M),
    contact: (lat, lon, again) => MapRoadOwners.contacts(lat, lon, again),
  };

  // `again` is Try again, which the lookup's own failure cache has to hear.
  function run(k, again) {
    if (typeof MapRoadOwners === 'undefined') return;
    const a = entry(k);
    const [lat, lon] = pointOf(k);
    for (const name of Object.keys(QUESTIONS)) {
      if (a.busy[name] || settled(a[name])) continue;
      a.busy[name] = true;
      Promise.resolve()
        .then(() => QUESTIONS[name](lat, lon, again))
        .then(r => (r && r.ok ? r : { ok: false, why: (r && r.why) || 'no usable answer' }),
              () => ({ ok: false, why: 'no usable answer' }))
        .then(r => {
          a[name] = r.ok ? r : { ...r, at: Date.now() };
          a.busy[name] = false;
          notify(k);
        });
    }
  }

  function notify(k) {
    for (const [elId, s] of asked) {
      const el = document.getElementById(elId);
      if (!el) { asked.delete(elId); continue; }
      if (el.dataset.mnRoads !== k) continue;
      paint(el, s);
    }
  }

  function paint(el, s) {
    const had = el.contains(document.activeElement);
    el.innerHTML = html(s);
    if (had) {
      const g = el.querySelector('.stn-card-roads') || el;
      g.focus({ preventScroll: true });
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const note   = t => `<span class="mn-pop-note">${t}</span>`;
  const asking = () => note('asking…');
  const unread = src => `<span class="txt-warn">could not be read</span> ${note(`— ${esc(SOURCES[src].name)}`)}`;
  const failed = r => !!(r && r.ok === false);

  function row(label, value, title) {
    if (!value) return '';
    const t = title ? ` title="${esc(title)}"` : '';
    return `<div class="acma-row"><span${t}>${esc(label)}</span><span>${value}</span></div>`;
  }

  function link(text, href, label) {
    return `<a href="${esc(href)}" target="_blank" rel="noopener"
        aria-label="${esc(`${label || text} — in a new tab`)}">${esc(text)}<span aria-hidden="true"> ↗</span></a>`;
  }

  function away(m) {
    if (m < ON_M) return 'here';
    return `${Math.round(m)} m away`;
  }

  const councilOf = r => (r && r.lga ? `${r.lga} Council` : 'the council');

  // QRT names an unnamed road "Road" and an unnamed track "Track" — no name at
  // all, which is not what a card should print as one.
  function roadName(r) {
    if (!r.name || /^(road|track)$/i.test(r.name)) return r.roadClass === 'Track' ? 'An unnamed track' : 'An unnamed road';
    return r.name;
  }

  function cap(t) { return t ? t[0].toUpperCase() + t.slice(1) : t; }

  // Who manages the road, in a row's worth of words.
  function managerWords(r) {
    switch (r.cls) {
      case 'tmr':     return 'Transport and Main Roads — State-controlled';
      case 'council': return `${councilOf(r)} — as the State records it`;
      case 'unknown': return `Not State-controlled — ${councilOf(r)}, or private`;
      case 'park':    return cap(MapRoadOwners.ownerWords(r.owner));
      case 'private': return 'Private — the owner of the land it crosses';
      default:        return cap(MapRoadOwners.ownerWords(r.owner));
    }
  }

  function roadRows(a) {
    if (failed(a.road)) return row('Road', unread('road'), TITLE.road);
    if (!a.road) return row('Road', asking(), TITLE.road);
    const r = a.road.road;
    if (!r) return row('Road', note(`none within ${a.road.radiusM} m`), TITLE.road);
    const extra = [r.routes.length ? `route ${r.routes.join(' · ')}` : '', away(r.distM)].filter(Boolean);
    const out = [row('Road', `${esc(roadName(r))} ${note(esc(extra.join(' · ')))}`, TITLE.road)];
    const notes = [];
    if (r.maint && !/^(unknown|unmaintained)$/i.test(r.maint) && r.maint !== r.owner) {
      notes.push(`maintained by ${MapRoadOwners.ownerWords(r.maint)}`);
    }
    if (/^tollway$/i.test(r.access)) notes.push('a toll road');
    out.push(row('Managed by', `${esc(managerWords(r))}${notes.length ? ` ${note(esc(notes.join(' · ')))}` : ''}`, TITLE.who));
    return out.join('');
  }

  function bridgeRow(a) {
    if (failed(a.bridge)) return row('Bridge', unread('bridge'), TITLE.bridge);
    if (!a.bridge) return row('Bridge', asking(), TITLE.bridge);
    const b = a.bridge.bridge;
    if (!b) return row('Bridge', note(`none within ${a.bridge.radiusM} m`), TITLE.bridge);
    const whose = b.kind === 'tmr'
      ? `Transport and Main Roads — structure ${b.struc || 'not numbered'}`
      : 'not State-controlled — goes with its road';
    return row('Bridge', `${esc(MapRoadOwners.bridgeTitle(b))} ${note(esc(away(b.distM)))}<br> ${note(esc(whose))}`, TITLE.bridge);
  }

  // Who to call: the contact for the road's class, and TMR's too when the
  // bridge is TMR's and the road is not — an overpass over a highway, a council
  // road on a State bridge. Each named once.
  function contactRows(a) {
    if (failed(a.contact)) return row('Contact', unread('contact'), TITLE.contact);
    if (!a.contact) return row('Contact', asking(), TITLE.contact);
    const r = a.road && a.road.ok ? a.road.road : null;
    const b = a.bridge && a.bridge.ok ? a.bridge.bridge : null;
    const want = [];
    if (r) want.push(r.cls);
    if (b && b.kind === 'tmr') want.push('tmr');
    if (!want.length) return '';
    const seen = new Set();
    const out = [];
    for (const cls of want) {
      const v = MapRoadOwners.pickContact(cls, a.contact);
      if (!v || seen.has(v.name)) continue;
      seen.add(v.name);
      out.push(row('Contact', MapRoadOwners.contactHtml(v), TITLE.contact));
    }
    if (!out.length && r) {
      out.push(row('Contact', note(esc(`not in QLDTraffic’s directory — ${MapRoadOwners.ownerWords(r.owner)}`)), TITLE.contact));
    }
    return out.join('');
  }

  // What it means for somebody about to work there, in a sentence or two, and
  // where to go next.
  function summary(a) {
    const r = a.road && a.road.ok ? a.road.road : null;
    const b = a.bridge && a.bridge.ok ? a.bridge.bridge : null;
    const lines = [];
    const next = new Set(['traffic']);
    if (r) {
      const c = councilOf(r);
      switch (r.cls) {
        case 'tmr':
          lines.push('A State-controlled road: Transport and Main Roads manages it. Works in its corridor — a gauge, '
            + 'a cable, a vehicle stopped to work — need TMR’s approval, a road corridor permit, and its closures '
            + 'in a flood are TMR’s.');
          next.add('permit');
          break;
        case 'council':
          lines.push(`A council road: ${c} manages it. Works in its reserve need the council’s approval, and its `
            + 'closures in a flood are the council’s.');
          break;
        case 'unknown':
          lines.push(`Not State-controlled, so not Transport and Main Roads’. The State has not recorded whether it `
            + `is ${c}’s or private; the council will know.`);
          break;
        case 'park':
          lines.push('A road in a national park or State forest, managed by the Queensland Parks and Wildlife '
            + 'Service: works there need a QPWS permit.');
          break;
        case 'private':
          lines.push('A private road — the landholder’s. Getting onto it needs their permission.');
          break;
        default:
          lines.push(`Managed by ${MapRoadOwners.ownerWords(r.owner)} — not the council or Transport and Main Roads.`);
      }
    }
    if (b) {
      if (b.kind === 'tmr') {
        lines.push(`The bridge is on Transport and Main Roads’ register${b.struc ? ` as structure ${b.struc}` : ''}: `
          + 'TMR manages it, and works on it or under it are TMR’s to approve.');
        next.add('permit');
      } else {
        lines.push('The bridge is not on Transport and Main Roads’ register, so it goes with the road it carries — '
          + 'normally the council’s.');
      }
    }
    const links = [...next].map(n => link(NEXT[n].title, NEXT[n].page));
    return `<ul class="stn-card-exp-list stn-card-exp-sum">${lines.map(l => `<li>${esc(l)}</li>`).join('')}<li>${
      links.join(' · ')}</li></ul>`;
  }

  function sourcesHtml() {
    const docs = typeof docUrl === 'function' ? docUrl('docs/road-owners.md') : 'docs/road-owners.md';
    return `<details class="stn-card-rhs-earlier stn-card-exp-src">
        <summary class="small">Sources and limits</summary>
        <ul class="stn-card-exp-list">${Object.values(SOURCES).map(d =>
          `<li>${link(d.title, d.page)} ${esc(`— © ${d.by}, ${d.licence}.`)}</li>`).join('')}</ul>
        <p class="stn-card-aep-line">The nearest road is the nearest mapped centreline, which can be a road the
          station is beside rather than the one it is reached by. Most roads that are not State-controlled are
          recorded with no owner: they are the council’s or private, and the card says so rather than guessing.
          The road lookup is the one QLDTraffic’s own site asks; it is not a published interface, and it can
          change without notice.</p>
        <p class="stn-card-aep-line">${link('What each row means, and its limits', docs,
          'What each row means, and its limits — the documentation')}</p>
      </details>`;
  }

  function failuresHtml(a) {
    const bad = Object.keys(SOURCES).filter(n => failed(a[n]));
    if (!bad.length) return '';
    const list = bad.map(n => `${SOURCES[n].name} (${a[n].why})`);
    return `<p class="small txt-warn stn-card-exp-foot">Could not be read: ${esc(list.join('; '))}. Nothing here is
        claimed from ${bad.length === 1 ? 'it' : 'them'}.</p>
      <button type="button" class="pill stn-card-exp-retry" onclick="SiteRoads.retry(this)"
              aria-label="Try again — ask the road services that did not answer"
              ><span aria-hidden="true">↻</span> Try again</button>`;
  }

  // The section for a station or a point, from whatever is known now. Never
  // asks anything; ask() does, and the fills call this again.
  function html(s) {
    const k = key(s);
    if (!k) return '';
    const headId = `mn-roads-head-${s.id}`;
    const head = `<span class="small txt-muted stn-card-rhs-head" id="${escAttr(headId)}"
              title="${esc(TITLE.head)}">Road and bridge — who manages them</span>
        <span class="stn-card-rhs-snap mn-pop-note">Queensland road data — not a permit</span>`;
    if (!inBox(k)) {
      return `<div class="stn-card-roads" role="group" aria-labelledby="${escAttr(headId)}" tabindex="-1">
        ${head}
        <p class="small txt-muted stn-card-exp-foot">Not in Queensland. This section reads Queensland’s road data,
          which stops at the state border — so nothing is known here about who manages the road.</p>
      </div>`;
    }
    const a = answers.get(k) || { busy: {} };
    const busy = Object.keys(QUESTIONS).some(n => !a[n]);
    const parts = [roadRows(a), bridgeRow(a), contactRows(a)];
    if (a.road && a.bridge && (a.road.ok || a.bridge.ok)) parts.push(summary(a));
    if (!busy) parts.push(failuresHtml(a));
    parts.push(sourcesHtml());
    return `<div class="stn-card-roads" role="group" aria-labelledby="${escAttr(headId)}" tabindex="-1"${busy ? ' aria-busy="true"' : ''}>
        ${head}
        ${parts.join('')}
      </div>`;
  }

  // Fill an element once the answers are in. `data-mn-roads` carries the
  // position it was rendered for and is checked before every write.
  function ask(elId, s) {
    const k = key(s);
    if (!k) return;
    asked.set(elId, s);
    if (!inBox(k)) return;
    run(k);
  }

  function retry(btn) {
    const el = btn && btn.closest ? btn.closest('[data-mn-roads]') : null;
    const s = el ? asked.get(el.id) : null;
    const k = key(s);
    if (!k || el.dataset.mnRoads !== k) return;
    const a = entry(k);
    for (const n of Object.keys(QUESTIONS)) if (failed(a[n])) delete a[n];
    paint(el, s);
    run(k, true);
    if (typeof announce === 'function') announce('Road and bridge: asking again.');
  }

  return {
    key,
    html,
    ask,
    retry,
    clear() {
      answers.clear();
      asked.clear();
    },
  };
})();
if (typeof window !== 'undefined') window.SiteRoads = SiteRoads;
