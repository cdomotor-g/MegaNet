// MegaNet — site-mobile.js
//
//   SiteMobile   Mobile phone signal at a station or a picked point, for each
//                of Telstra, Optus and TPG (Vodafone): estimated from the
//                transmitters the ACMA register lists, priced over the app's
//                own terrain with its own Longley–Rice, and graded the way
//                the ACMA's coverage map standard grades — good, moderate,
//                basic or no coverage. A section on the station card, and the
//                same rows on the What is here card (map-here.js).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr, announce and fmtKm; across to
// mobile-signal.js for every piece of arithmetic, terrain.js for
// Terrain.profile, itm.js for ITM.pointToPoint, land-cover.js for the cover at
// the point, path-profile.js for pathPropOf and terminalClutterDb, and app.js
// for docUrl. All from inside its own functions, so this file's position among
// the modules is free. app.js's stnCardHtml() places the section and calls
// ask(); map-here.js does the same for a picked point.
//
// ── Why an estimate, and not the carriers' map ──────────────────────────────
// There is no open feed of anybody's coverage map. The carriers publish theirs
// on their own websites only; the ACCC's open copies say covered or not, once a
// year, and nothing about how strong. What is open is the register every mobile
// transmitter has to be entered in (data/mobile/, tools/mobile_sectors.py), and
// this app already carries the rest: the terrain and the propagation model its
// link budgets run on. So this section works the signal out, says that it has,
// and links each carrier's own map beside it.
//
// ── How a figure is reached ─────────────────────────────────────────────────
//   1. The cells within 60 km (MobileSignal.MAX_RANGE_KM) are fetched — 1°
//      squares of the register, only those the index says exist.
//   2. Every sector in range is ranked on a coarse figure (free space at 1 km,
//      35 dB a decade past it) and the best PER_CARRIER sites per carrier are
//      kept: a dozen or so sites, most of them shared between carriers.
//   3. One terrain profile per site, site to point (Terrain.profile), and
//      Longley–Rice's median loss over it per band, mast height and receiver
//      (ITM.pointToPoint, at 50% time, locations and situations — the 85% of
//      the standard is MobileSignal's shift, not the model's).
//   4. The cover at the point (LandCover): a phone among trees or buildings
//      pays ITU-R P.2108's terminal clutter (terminalClutterDb), as the link
//      budget's land-cover model charges a mast under them.
//   5. MobileSignal.level for every sector, for a handheld and for an external
//      antenna; the strongest per carrier is the row.
//
// ── What a row can say ──────────────────────────────────────────────────────
// site-land.js's rule: an answer, "working it out…", or "could not be
// estimated" with why. A failure is never shown as "no coverage" — that is an
// answer, and it is only given when the register has been read and the
// terrain priced and nothing reached.
//
// ── What it costs ───────────────────────────────────────────────────────────
// The index once (~20 KB), one to four cells (a city's is ~2 MB, a rural one a
// few tens of KB), a dozen terrain profiles out of tiles terrain.js caches,
// and the land cover the What is here card has already asked for. Answers are
// kept per position for the session; a failure is not asked again for
// FAIL_TTL unless Try again is pressed.
const SiteMobile = (function () {
  const INDEX_URL = 'data/mobile/index.json';
  const cellUrl = k => `data/mobile/cells/${k}.json`;
  const KEY_DP = 5;
  const CACHE_MAX = 32;
  const CELL_MAX = 24;
  const FAIL_TTL = 60000;
  const PER_CARRIER = 4;
  // The two land-cover samples map-here.js asks for, so this lookup is the
  // same request — and the same cache entry — as that card's land cover row.
  const COVER_STEP = 0.0002;
  // Closer than this to the mast there is no terrain between, and free space
  // is the honest model.
  const ADJACENT_KM = 0.1;
  // P.2108 §3.1 is stated to 3 GHz; 3.5 GHz is priced as 3, a dB or so kind.
  const CLUTTER_MAX_MHZ = 3000;

  const MAPS = [
    { title: 'Telstra’s coverage map', page: 'https://www.telstra.com.au/coverage-networks/our-coverage' },
    { title: 'Optus’s coverage map', page: 'https://www.optus.com.au/living-network/coverage' },
    { title: 'Vodafone’s (TPG’s) coverage checker', page: 'https://www.vodafone.com.au/network/coverage-checker' },
  ];

  const SOURCES = {
    rrl: {
      title: 'Register of Radiocommunications Licences — every mobile transmitter’s site, height, azimuth, antenna and power',
      by: 'Australian Communications and Media Authority', licence: 'CC BY 4.0',
      page: 'https://www.acma.gov.au/register-radiocommunication-licences-rrl',
    },
    mocn: {
      title: 'ACCC Mobile Infrastructure Report data release — the Optus sites shared with TPG (MOCN)',
      by: 'Australian Competition and Consumer Commission', licence: 'CC BY 2.5 AU',
      page: 'https://data.gov.au/data/dataset/accc-mobile-infrastructure-report-data-release',
    },
    standard: {
      title: 'Telecommunications (Mobile Network Coverage Maps) Industry Standard 2026, Schedule 1 — the grades and the phone',
      by: 'Australian Communications and Media Authority', licence: 'Federal Register of Legislation',
      page: 'https://www.legislation.gov.au/F2026L00381/latest/text',
    },
  };

  const TITLE = {
    head: 'An estimate of the mobile signal here, for each carrier, worked out from the transmitters the ACMA register '
        + 'lists over this app’s terrain and propagation model, and graded on the ACMA coverage map standard’s scale. '
        + 'Not the carriers’ own maps, which are linked below.',
    row: 'The strongest sector of this carrier’s within 60 km, at the level the standard grades on — reached at 85% of '
       + 'locations, 8.3 dB under the median. The second line is the same with an external antenna.',
  };

  // ── Data ──────────────────────────────────────────────────────────────────

  let indexP = null;
  const cells = new Map();     // cell key → Promise<sites[]>

  function getJson(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    });
  }

  function loadIndex() {
    if (!indexP) {
      indexP = getJson(INDEX_URL).catch(e => { indexP = null; throw e; });
    }
    return indexP;
  }

  function loadCell(k) {
    if (cells.has(k)) {
      const p = cells.get(k);
      cells.delete(k); cells.set(k, p);
      return p;
    }
    const p = getJson(cellUrl(k)).then(d => d.sites || []);
    p.catch(() => cells.delete(k));
    cells.set(k, p);
    while (cells.size > CELL_MAX) cells.delete(cells.keys().next().value);
    return p;
  }

  // The cover at the point, as a clutter height: { code, label, R } where R is
  // what stands round the phone (null on open ground), or null if the service
  // did not answer.
  function coverAt(lat, lon) {
    if (typeof LandCover === 'undefined') return Promise.resolve(null);
    return LandCover.sample([lat, lat], [lon, lon + COVER_STEP]).then(r => {
      if (!r || !r.ok || !r.cls || r.cls[0] == null) return null;
      const code = r.cls[0];
      const c = LandCover.CLASSES[code];
      const R = LandCover.standsUp(code)
        ? LandCover.heights([code], r.canopy ? [r.canopy[0]] : null)[0] : null;
      return { code, label: c ? c.label : `class ${code}`, R: R > 0 ? R : null };
    }, () => null);
  }

  function propOf() {
    return typeof pathPropOf === 'function' ? pathPropOf({}) : {};
  }

  // Median basic transmission loss, mast to phone, or free space where the
  // phone is at the foot of the mast. { db, mode } or null.
  function lossDb(pfl, dKm, hTx, hRx, fMhz, P) {
    if (dKm < ADJACENT_KM || !pfl) {
      return dKm < ADJACENT_KM ? { db: MobileSignal.fsplDb(Math.max(dKm, 0.01), fMhz), mode: 'free space (at the mast)' } : null;
    }
    const r = ITM.pointToPoint({
      pfl, hTx: Math.min(3000, Math.max(0.5, hTx)), hRx, fMhz,
      climate: P.climate, N0: P.N0, pol: P.pol, epsilon: P.epsilon, sigma: P.sigma, mdvar: P.mdvar,
      time: 50, location: 50, situation: 50,
    });
    return r.ok ? { db: r.A_db, mode: r.modeLabel } : null;
  }

  async function estimate(lat, lon) {
    let index;
    try { index = await loadIndex(); } catch (_) {
      return { ok: false, why: 'the transmitter register could not be fetched' };
    }
    const keys = MobileSignal.cellsAround(lat, lon, MobileSignal.MAX_RANGE_KM, index.cells);
    let sites;
    try { sites = (await Promise.all(keys.map(loadCell))).flat(); } catch (_) {
      return { ok: false, why: 'part of the transmitter register could not be fetched' };
    }
    const cand = MobileSignal.candidates(sites, lat, lon, { perCarrier: PER_CARRIER });
    const coverP = coverAt(lat, lon);

    // One profile per site, whichever carriers it serves.
    const bySite = new Map();
    for (const list of cand) for (const c of list) if (!bySite.has(c.id)) bySite.set(c.id, c);
    const profiles = new Map();
    await Promise.all([...bySite.values()].map(c => {
      if (c.dKm < ADJACENT_KM) { profiles.set(c.id, null); return null; }
      const n = Math.max(32, Math.min(600, Math.ceil(c.dKm * 10) + 1));
      return Terrain.profile([[c.lat, c.lon], [lat, lon]], n)
        .then(p => { profiles.set(c.id, MobileSignal.pflOf(p)); }, () => { profiles.set(c.id, null); });
    }));
    const unpriced = [...bySite.values()].filter(c => c.dKm >= ADJACENT_KM && !profiles.get(c.id)).length;
    if (bySite.size && unpriced === bySite.size) {
      return { ok: false, why: 'the terrain between here and the masts could not be read' };
    }

    const cover = await coverP;
    const P = propOf();
    const losses = new Map();
    const levels = [];
    for (const list of cand) {
      for (const c of list) {
        const pfl = profiles.get(c.id);
        for (const sec of c.sectors) {
          for (const rx of [MobileSignal.RX.handheld, MobileSignal.RX.external]) {
            const lk = `${c.id}|${sec.f}|${sec.h}|${rx.hM}`;
            if (!losses.has(lk)) losses.set(lk, lossDb(pfl, c.dKm, sec.h, rx.hM, sec.f, P));
            const L = losses.get(lk);
            if (!L) continue;
            const clutter = cover && cover.R && typeof terminalClutterDb === 'function'
              ? terminalClutterDb(rx.hM, cover.R, Math.min(sec.f, CLUTTER_MAX_MHZ)) : 0;
            const v = MobileSignal.level(sec, L.db, clutter, rx, c.brgFromSite - sec.az);
            levels.push({ ...v, carrier: c.carrier, rx: rx.key, mode: L.mode, sec,
                          site: { id: c.id, lat: c.lat, lon: c.lon }, dKm: c.dKm, brg: c.brgFromPoint,
                          off: c.brgFromSite - sec.az });
          }
        }
      }
    }
    return {
      ok: true,
      handheld: MobileSignal.bestPerCarrier(levels, 'handheld'),
      external: MobileSignal.bestPerCarrier(levels, 'external'),
      considered: cand.map(l => l.length),
      sites: bySite.size, unpriced, cover,
      meta: index.meta || {},
    };
  }

  // ── Asking ───────────────────────────────────────────────────────────────

  function key(s) {
    if (!s || s.lat == null || s.lon == null || s.lat === '' || s.lon === '') return null;
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return `${lat.toFixed(KEY_DP)},${lon.toFixed(KEY_DP)}`;
  }

  const pointOf = k => k.split(',').map(Number);

  const answers = new Map();   // position → { res, busy }
  const asked = new Map();     // element id → the place last asked about there

  function entry(k) {
    let a = answers.get(k);
    if (a) {
      answers.delete(k);
      answers.set(k, a);
      return a;
    }
    a = { busy: false, res: null };
    answers.set(k, a);
    if (answers.size > CACHE_MAX) {
      for (const [old, v] of answers) {
        if (old !== k && !v.busy) { answers.delete(old); break; }
      }
    }
    return a;
  }

  const settled = r => !!r && (r.ok || Date.now() - r.at < FAIL_TTL);

  function run(k) {
    if (typeof MobileSignal === 'undefined' || typeof Terrain === 'undefined' || typeof ITM === 'undefined') return;
    const a = entry(k);
    if (a.busy || settled(a.res)) return;
    a.busy = true;
    const [lat, lon] = pointOf(k);
    Promise.resolve()
      .then(() => estimate(lat, lon))
      .then(r => r, () => ({ ok: false, why: 'the estimate failed' }))
      .then(r => {
        a.res = r.ok ? r : { ...r, at: Date.now() };
        a.busy = false;
        notify(k);
      });
  }

  function notify(k) {
    for (const [elId, s] of asked) {
      const el = document.getElementById(elId);
      if (!el) { asked.delete(elId); continue; }
      if (el.dataset.mnMobile !== k) continue;
      paint(el, s);
    }
  }

  function paint(el, s) {
    const had = el.contains(document.activeElement);
    el.innerHTML = html(s);
    if (had) {
      const g = el.querySelector('.stn-card-mobile') || el;
      g.focus({ preventScroll: true });
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const note = t => `<span class="mn-pop-note">${t}</span>`;
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dirOf = deg => COMPASS[Math.round(deg / 22.5) % 16];
  const dbm = v => `${v < 0 ? '−' : ''}${Math.abs(Math.round(v))} dBm`;
  const db1 = v => `${Math.abs(v).toFixed(1)}`;
  const bandWords = b => (b >= 3300 ? '3.5 GHz' : `${b} MHz`);

  function row(label, value, title) {
    const t = title ? ` title="${esc(title)}"` : '';
    return `<div class="acma-row"><span${t}>${esc(label)}</span><span>${value}</span></div>`;
  }

  function link(text, href, label) {
    return `<a href="${esc(href)}" target="_blank" rel="noopener"
        aria-label="${esc(`${label || text} — in a new tab`)}">${esc(text)}<span aria-hidden="true"> ↗</span></a>`;
  }

  function grade(l) {
    return `<span class="mn-mob-grade mn-mob-${esc(l.grade.key)}">${esc(l.grade.label)}</span>`;
  }

  function whence(l) {
    const bits = [bandWords(l.sec.band), `${fmtKm(l.dKm)} ${dirOf(l.brg)}`];
    if (l.sec.via === 'mocn') bits.push('Optus’s mast, shared');
    return bits.join(' · ');
  }

  function levelTitle(l) {
    return `Median ${dbm(l.median)}; graded at ${dbm(l.graded)}, the level reached at 85% of locations. `
      + `${bandWords(l.sec.band)} sector pointing ${Math.round(l.sec.az)}°, ${Math.round(l.sec.h)} m up, `
      + `register site ${l.site.id}.`;
  }

  // A carrier with masts in range but no level is one whose terrain could not
  // be read — not one with no coverage, and never said to be.
  const unpricedAt = (r, i) => !r.handheld[i] && !r.external[i] && r.considered[i] > 0;

  function carrierRow(i, r) {
    const name = MobileSignal.CARRIERS[i].name;
    const h = r.handheld[i], x = r.external[i];
    if (unpricedAt(r, i)) {
      return row(name, `<span class="txt-warn">could not be estimated</span> ${note(
        '— the terrain to its masts could not be read')}`, TITLE.row);
    }
    if (!h && !x) {
      return row(name, `${grade({ grade: MobileSignal.gradeOf(-Infinity) })} ${note(
        esc(`no transmitter registered within ${MobileSignal.MAX_RANGE_KM} km`))}`, TITLE.row);
    }
    const first = h
      ? `<span title="${esc(levelTitle(h))}">${grade(h)} ${esc(dbm(h.graded))}</span> ${note(esc(whence(h)))}`
      : note('handheld not priced');
    const second = x
      ? `<br>${note(`external antenna: <span title="${esc(levelTitle(x))}">${esc(x.grade.label)} · ${esc(dbm(x.graded))}</span>`)}`
      : '';
    return row(name, first + second, TITLE.row);
  }

  // What it adds up to, for somebody about to go there.
  function summary(r) {
    const hs = r.handheld.map((l, i) => (l ? { l, i } : null)).filter(Boolean);
    const reach = hs.filter(({ l }) => l.grade.key !== 'none').sort((a, b) => b.l.graded - a.l.graded);
    const lines = [];
    if (reach.length) {
      const names = reach.map(({ l, i }) => `${MobileSignal.CARRIERS[i].name} (${l.grade.label.toLowerCase()})`);
      const short = [0, 1, 2].filter(i => !reach.some(x => x.i === i) && !unpricedAt(r, i))
        .map(i => MobileSignal.CARRIERS[i].name);
      lines.push(`A phone here should get ${names.join(', ')}${short.length
        ? `; ${short.join(' and ')} ${short.length === 1 ? 'is' : 'are'} estimated not to reach` : ''}.`);
    } else {
      const xs = r.external.map((l, i) => (l && l.grade.key !== 'none' ? { l, i } : null)).filter(Boolean)
        .sort((a, b) => b.l.graded - a.l.graded);
      const unpriced = [0, 1, 2].some(i => unpricedAt(r, i));
      lines.push(xs.length
        ? `No carrier is estimated to reach a phone here. With an external antenna, ${
            xs.map(({ l, i }) => `${MobileSignal.CARRIERS[i].name} (${l.grade.label.toLowerCase()})`).join(', ')} might.`
        : unpriced
          ? 'No carrier that could be estimated reaches here, even with an external antenna.'
          : 'No carrier is estimated to reach here, even with an external antenna: plan on no mobile signal.');
    }
    lines.push('An estimate from registered transmitter power over ~30 m terrain — check the carrier’s own map before '
      + 'relying on it, and expect less in a gully, a building or a vehicle.');
    return `<ul class="stn-card-exp-list stn-card-exp-sum">${lines.map(l => `<li>${esc(l)}</li>`).join('')}<li>${
      MAPS.map(m => link(m.title, m.page)).join(' · ')}</li></ul>`;
  }

  // Each carrier's best sector, term by term, so a figure can be checked.
  function workings(r) {
    const lines = [];
    r.handheld.forEach((l, i) => {
      if (!l) return;
      const terms = [
        `${db1(l.rs)} dBm per resource element (register)`,
        `− ${db1(l.port)} two ports`,
        `− ${db1(l.pattern)} antenna, ${Math.round(Math.abs((((l.off % 360) + 540) % 360) - 180))}° off its ${Math.round(l.sec.az)}°`,
        `− ${db1(l.path)} path (Longley–Rice, ${(l.mode || 'median').toLowerCase()}, ${fmtKm(l.dKm)})`,
      ];
      if (l.clutter > 0) terms.push(`− ${db1(l.clutter)} cover round the phone (P.2108)`);
      terms.push(`− ${db1(-l.gain)} phone antenna`, `− ${db1(l.loss)} body`);
      lines.push(`${MobileSignal.CARRIERS[i].name}: ${terms.join(' ')} = ${dbm(l.median)} median; − ${
        db1(MobileSignal.EDGE_DB)} for 85% of locations = ${dbm(l.graded)}, ${l.grade.label.toLowerCase()}.`);
    });
    const c = r.cover;
    lines.push(c
      ? (c.R ? `Cover at the point: ${c.label}, ~${Math.round(c.R)} m — charged as P.2108 terminal clutter.`
             : `Cover at the point: ${c.label} — open, nothing charged.`)
      : 'Land cover could not be read: no clutter is charged, which flatters a point among trees or buildings.');
    lines.push(`Handheld: ${MobileSignal.RX.handheld.words}. External antenna: ${MobileSignal.RX.external.words}.`);
    lines.push(`${r.sites} masts priced, the ${PER_CARRIER} likeliest per carrier within ${MobileSignal.MAX_RANGE_KM} km`
      + `${r.unpriced ? `; ${r.unpriced} left out where the terrain could not be read` : ''}.`);
    return `<details class="stn-card-rhs-earlier stn-card-exp-src">
        <summary class="small">How each figure is reached</summary>
        <ul class="stn-card-exp-list">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </details>`;
  }

  function sourcesHtml(r) {
    const docs = typeof docUrl === 'function' ? docUrl('docs/mobile-coverage.md') : 'docs/mobile-coverage.md';
    const when = r && r.meta && r.meta.source_date ? ` The register as extracted on ${r.meta.source_date}.` : '';
    return `<details class="stn-card-rhs-earlier stn-card-exp-src">
        <summary class="small">Sources and limits</summary>
        <ul class="stn-card-exp-list">${Object.values(SOURCES).map(d =>
          `<li>${link(d.title, d.page)} ${esc(`— © ${d.by}, ${d.licence}.`)}</li>`).join('')}
          <li>${esc(`${typeof Terrain !== 'undefined' ? Terrain.attribution : 'Elevation: AWS Terrain Tiles'}.`)}</li></ul>
        <p class="stn-card-aep-line">${esc(`The register says where each transmitter is, how high, which way it points and
          the power it is licensed to radiate — not what the site actually runs, how its antenna is tilted, how busy
          it is, or whether it is switched on. The terrain is ~30 m and has no buildings; the cover is only what is
          at the point. So a figure can be a few dB either way in the open, and well out in a town or a gully.${when}`)}</p>
        <p class="stn-card-aep-line">${link('What each row means, and its limits', docs,
          'What each row means, and its limits — the documentation')}</p>
      </details>`;
  }

  // The section for a station or a point, from whatever is known now. Never
  // asks anything; ask() does, and the fill calls this again.
  function html(s) {
    const k = key(s);
    if (!k) return '';
    const headId = `mn-mobile-head-${s.id}`;
    const head = `<span class="small txt-muted stn-card-rhs-head" id="${escAttr(headId)}"
              title="${esc(TITLE.head)}">Mobile coverage — estimated</span>
        <span class="stn-card-rhs-snap mn-pop-note">from the ACMA register — not the carriers’ maps</span>`;
    const a = answers.get(k);
    const r = a && a.res;
    let body;
    if (!r) {
      body = row('Signal', note('working it out…'), TITLE.row);
    } else if (!r.ok) {
      body = `${row('Signal', `<span class="txt-warn">could not be estimated</span> ${note(esc(`— ${r.why}`))}`, TITLE.row)}
        <button type="button" class="pill stn-card-exp-retry" onclick="SiteMobile.retry(this)"
                aria-label="Try again — work the mobile signal out again"
                ><span aria-hidden="true">↻</span> Try again</button>`;
    } else {
      body = [0, 1, 2].map(i => carrierRow(i, r)).join('') + summary(r) + workings(r);
    }
    return `<div class="stn-card-mobile" role="group" aria-labelledby="${escAttr(headId)}" tabindex="-1"${!r ? ' aria-busy="true"' : ''}>
        ${head}
        ${body}
        ${sourcesHtml(r && r.ok ? r : null)}
      </div>`;
  }

  // Fill an element once the estimate is in. `data-mn-mobile` carries the
  // position it was rendered for and is checked before every write.
  function ask(elId, s) {
    const k = key(s);
    if (!k) return;
    asked.set(elId, s);
    run(k);
  }

  function retry(btn) {
    const el = btn && btn.closest ? btn.closest('[data-mn-mobile]') : null;
    const s = el ? asked.get(el.id) : null;
    const k = key(s);
    if (!k || el.dataset.mnMobile !== k) return;
    const a = entry(k);
    if (a.res && !a.res.ok) a.res = null;
    paint(el, s);
    run(k);
    if (typeof announce === 'function') announce('Mobile coverage: working it out again.');
  }

  return {
    key,
    html,
    ask,
    retry,
    // For a test or the console: the estimate itself, uncached.
    estimate,
    clear() {
      answers.clear();
      asked.clear();
      cells.clear();
      indexP = null;
    },
  };
})();
if (typeof window !== 'undefined') window.SiteMobile = SiteMobile;
