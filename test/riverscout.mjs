// The riverside site finder (map-riverscout.js), held to what it claims.
//
// The terrain is the terrain kit's hilly world (lib/terrarium.mjs), the stations
// the committed register and the rivers the committed Geofabric files, so the
// figures below are worked out again here — by the link budget card's own
// functions, called by this check — rather than read back from the module.
// What is under test, and the defect each block would catch:
//
//   The panel        a pane of the side panel in the tools group, its button
//                    after 📜 ACMA licences and before ℹ️; Score this river off
//                    until a place is scored; every marked word carries a
//                    meaning, and the words are listed where a finger can read.
//   The sums         the weights add to one; the fade margin's bands, the clean
//                    share's and the river distance's end points; a part nobody
//                    can supply leaves the others its weight; a place no
//                    receiver hears at "ok" never scores 50.
//   One place        a real click on a station's ground: the river it is on is
//                    found, the nearest repeaters and bases are priced, and the
//                    best margin is the card's own arithmetic to the last bit.
//   The record       signed out, the neighbours' record is said to be for
//                    editors and the other two parts share its weight; handed
//                    one, it counts the stations within 15 km — and a station
//                    with too few frames is not a record — and moves the score.
//   Along the river  a place every step, in order, each within a few hundred
//                    metres of the river's line, the click's own at nought; a
//                    cell for each in the strip, the best five numbered and
//                    pinned; a cell picked shows its own card.
//   The map          the legend names it; the armed banner names the mode and
//                    leaves on Escape; Clear takes all of it off.
//   Saving           the CSV has a row for every place scored.
//
//   npm run riverscout          (or: node riverscout.mjs)
//   npm run riverscout -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import { pressDock, reachDock } from './lib/dock-press.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const RUN_TIMEOUT = 240_000;

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                           headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });
  await pressDock(page, 'map-riverscout');
  await page.waitForTimeout(400);

  const settled = () => page.waitForFunction(() => MapRiverScout.status().kind === 'done', null, { timeout: RUN_TIMEOUT });

  // ── 0. the panel ───────────────────────────────────────────────────────────
  console.log('\nThe panel');
  const panel = await page.evaluate(() => {
    const wrap = document.querySelector('.mn-mapctl[data-panel="riverscout"]');
    const strip = [...document.querySelectorAll('#help-panel .dock-strip button')];
    const at = sel => strip.findIndex(b => b.matches(sel));
    const body = wrap && wrap.querySelector('.mn-mapctl-body');
    const terms = [...document.querySelectorAll('.rscout-panel .term, .rscout-panel .term-chip')]
      .map(el => ({ t: el.textContent.trim(), title: (el.getAttribute('title') || '').trim() }));
    return {
      present: !!wrap, docked: !!wrap && !!wrap.closest('#help-panel .dock-pane'),
      shown: !!(body && body.getClientRects().length), showing: dockShowing(),
      title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
      group: strip.find(b => b.dataset.dock === 'map-riverscout')?.closest('.dock-group')?.dataset.group,
      // Under 📻 Radio since the rail went by job: the last of 🗼 Find a
      // better site's tabs (app.js, DOCK_FAMILIES).
      job: dockJobOf('map-riverscout'), fam: dockFamilyKeys('better'),
      sweepDisabled: document.getElementById('riverscout-sweep')?.disabled,
      status: document.getElementById('riverscout-status')?.textContent || '',
      words: document.querySelectorAll('.bestrep-words dt').length,
      terms,
    };
  });
  ok('🌊 Riverside sites is a pane of the side panel, open from its button in the strip',
     panel.present && panel.docked && panel.shown && panel.showing === 'map-riverscout' && panel.title === 'Riverside sites', JSON.stringify(panel).slice(0, 300));
  ok('…under Radio, the last of Find a better site\'s tabs',
     panel.job === 'radio' && panel.fam[panel.fam.length - 1] === 'map-riverscout', JSON.stringify({ job: panel.job, fam: panel.fam }));
  ok('Score this river is off until a place is scored, and the panel says what to do',
     panel.sweepDisabled === true && /Pick a place/.test(panel.status), panel.status);
  ok('the panel\'s words are listed where a finger can read them', panel.words >= 8, `${panel.words}`);

  // ── 1. the sums ────────────────────────────────────────────────────────────
  console.log('\nThe sums');
  const sums = await page.evaluate(() => {
    const S = MapRiverScout, W = S.WEIGHTS, ok6 = state.mapFadeOkDb ?? 6, good = state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15;
    return {
      sum: W.heard + W.nbr + W.river,
      lo: S.heardFig(ok6 - 6), hi: S.heardFig(good + 10), mid: S.heardFig((ok6 - 6 + good + 10) / 2), none: S.heardFig(null),
      n70: S.nbrFig({ share: 0.7 }), n100: S.nbrFig({ share: 1 }), n85: S.nbrFig({ share: 0.85 }), nNone: S.nbrFig({ share: null }),
      r0: S.riverFig(0), r150: S.riverFig(150), r825: S.riverFig(825), r1500: S.riverFig(1500), rNone: S.riverFig(null),
      all: S.combine(1, 1, 1, 30), noNbr: S.combine(1, null, 0, 30), cap: S.combine(1, 1, 1, ok6 - 1), unheard: S.combine(null, 1, 1, null),
      ok6,
    };
  });
  ok('the weights add to one', Math.abs(sums.sum - 1) < 1e-9, `${sums.sum}`);
  ok('heard is nought 6 dB under the map\'s ok and one 10 dB over its good, in a straight line between',
     sums.lo === 0 && sums.hi === 1 && Math.abs(sums.mid - 0.5) < 1e-9 && sums.none === null, JSON.stringify(sums));
  ok('neighbours are nought at 70% clean and one at 100%; riverside one within 150 m and nought at 1.5 km',
     sums.n70 === 0 && sums.n100 === 1 && Math.abs(sums.n85 - 0.5) < 1e-9 && sums.nNone === null
     && sums.r0 === 1 && sums.r150 === 1 && Math.abs(sums.r825 - 0.5) < 1e-9 && sums.r1500 === 0 && sums.rNone === 0, JSON.stringify(sums));
  ok('all three at one is 100; with no record the other two share its weight (heard 1, river 0 → 73)',
     sums.all.score === 100 && sums.noNbr.score === 73 && !('nbr' in sums.noNbr.used)
     && Math.abs(Object.values(sums.noNbr.used).reduce((a, b) => a + b, 0) - 1) < 1e-9, JSON.stringify(sums.noNbr));
  ok('a place no receiver hears at the map\'s ok never scores 50; one nobody could price has no score',
     sums.cap.score === 49 && sums.cap.capped === true && sums.unheard.score === null, JSON.stringify([sums.cap.score, sums.unheard.score]));

  // ── 2. one place ───────────────────────────────────────────────────────────
  console.log('\nOne place');
  await page.evaluate(() => MapRiverLines.ready());
  // A station in Queensland standing on a river with a few kilometres of line
  // either way, a complete radio nearby, and a repeater or base within reach.
  const pick = await page.evaluate(async () => {
    const done = sys => sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
    const hubs = state.data.stations.filter(s => s.lat != null && Array.isArray(s.roles)
      && ((s.roles.includes('repeater') && s.repeater) || s.roles.includes('base')) && done(rmSystemOf(s)));
    let tried = 0;
    for (const s of state.data.stations) {
      if (!s.stream || s.lat == null || !s.roles.includes('field') || s.roles.includes('repeater')) continue;
      if (!(s.lon > 139 && s.lon < 153 && s.lat < -11 && s.lat > -28.5)) continue;
      if (!hubs.some(h => acmaHaversineKm(s.lat, s.lon, h.lat, h.lon) < 40)) continue;
      if (++tried > 60) break;
      const hit = await MapRiverLines.nearestTo(s.lat, s.lon, 300);
      if (!hit || hit.area < 1000) continue;
      for (const [a, b] of [[.1, 0], [-.1, 0], [0, .1], [0, -.1]]) await MapRiverLines.near(hit.lat + a, hit.lon + b);
      const st = MapRiverScout.stretchAround(hit.lat, hit.lon, hit.id, 5000, 500);
      if (st && st.places.length >= 15) return { id: s.id, name: s.name, lat: hit.lat, lon: hit.lon, river: hit.title, riverId: hit.id };
    }
    return null;
  });
  ok('the register holds a river station to test with', !!pick, JSON.stringify(pick));

  // A real click: arm, then press the map where the river is.
  await page.click('#riverscout-arm');
  const armed = await page.evaluate(() => ({ armed: MapRiverScout.armed(), banner: document.getElementById('map-mode')?.innerText || '' }));
  ok('Pick on the map arms it, and the map says what the click will do', armed.armed && /Riverside sites/.test(armed.banner), JSON.stringify(armed));
  await page.evaluate(({ lat, lon }) => state.map.setView([lat, lon], 15, { animate: false }), pick);
  await page.waitForTimeout(500);
  const xy = await page.evaluate(({ lat, lon }) => {
    const p = state.map.latLngToContainerPoint([lat, lon]), r = state.map.getContainer().getBoundingClientRect();
    const x = r.left + p.x, y = r.top + p.y, hit = document.elementFromPoint(x, y);
    return { x, y, over: hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : null };
  }, pick);
  await page.mouse.click(xy.x, xy.y);
  await settled();
  const one = await page.evaluate(() => {
    const h = MapRiverScout.here();
    return { site: h && { lat: h.lat, lon: h.lon }, score: h.score, best: h.best, hops: h.hops.map(x => ({ id: x.hub.id, km: x.km, m: x.margin, v: x.verdict })),
             river: h.river, parts: h.parts, used: h.used, armed: MapRiverScout.armed(), status: document.getElementById('riverscout-status')?.textContent,
             sweepDisabled: document.getElementById('riverscout-sweep')?.disabled, card: !!document.getElementById('riverscout-card'),
             legend: document.getElementById('map-legend')?.textContent || '' };
  });
  ok('a click on the map puts the place down within a pixel of where it was pressed and disarms',
     one.site && Math.abs(one.site.lat - pick.lat) < 0.003 && Math.abs(one.site.lon - pick.lon) < 0.003 && one.armed === false, JSON.stringify(one.site));
  ok('the river it is on is found, within 300 m', one.river && one.river.id === pick.riverId && one.river.m < 300, JSON.stringify(one.river));
  ok('the nearest repeaters and bases within reach are priced, at most four, nearest first',
     one.hops.length >= 1 && one.hops.length <= 4 && one.hops.every((h, i) => i === 0 || h.km >= one.hops[i - 1].km), JSON.stringify(one.hops));
  const check = await page.evaluate(async ({ id }) => {
    const h = MapRiverScout.here(), first = h.hops.find(x => x.m != null || x.margin != null) || h.hops[0];
    const hub = state.data.stations.find(s => s.id === first.hub.id), sys = rmSystemOf(hub);
    const mine = h.rad, her = { agl: stationAntenna(hub, sys).agl };
    const got = await pathGround({ lat: h.lat, lon: h.lon, elev: null, agl: mine.agl, mast: false },
      { lat: hub.lat, lon: hub.lon, elev: hub.elevation_ahd ?? null, agl: her.agl, mast: stationIsMast(hub) },
      { samples: 256, freqMhz: hub.repeater && hub.repeater.rx_mhz > 0 ? hub.repeater.rx_mhz : PATH_DEFAULT_MHZ });
    const coverModel = pathPropOf().model === 'cover';
    const res = coverModel ? await LandCover.sample(got.prof.lat, got.prof.lon) : null;
    const an = pathAnalyse(got.prof, { elevA: got.ends.a.elev, elevB: got.ends.b.elev, aglA: mine.agl, aglB: her.agl,
      freqMhz: hub.repeater && hub.repeater.rx_mhz > 0 ? hub.repeater.rx_mhz : PATH_DEFAULT_MHZ,
      cover: res ? res.cls : null, canopy: res && res.canopyOk ? res.canopy : null });
    const rx = rmSystemOf(hub);
    const tx = wattsToDbm(mine.txW);
    const margin = tx + mine.gain - mine.loss - an.pathLoss_db + rx.antenna_gain_dbi - rx.line_loss_db - rx.rx_threshold_dbm;
    return { ours: first.margin, card: margin, ok: an.ok };
  }, pick);
  ok('the first hop\'s fade margin is the link budget card\'s own arithmetic, to the last bit',
     check.ok && check.ours != null && Math.abs(check.ours - check.card) < 1e-6, JSON.stringify(check));
  ok('the score is a whole number of 100, and the three figures behind it are each nought to one',
     Number.isInteger(one.score) && one.score >= 0 && one.score <= 100
     && Object.values(one.parts).every(v => v == null || (v >= 0 && v <= 1)), JSON.stringify(one.parts));
  ok('the card says why, and the legend names the tool; Score this river is on',
     one.card && /Riverside site finder/.test(one.legend) && one.sweepDisabled === false, one.status);

  const termsNow = await page.evaluate(() => [...document.querySelectorAll('.rscout-panel .term, .rscout-panel .term-chip')]
    .map(el => ({ t: el.textContent.trim(), title: (el.getAttribute('title') || '').trim() })));
  ok('every word marked on the panel says what it means, in a sentence, never the word again',
     termsNow.length >= 6 && termsNow.every(x => x.title.length >= 20 && x.title.toLowerCase() !== x.t.toLowerCase()),
     JSON.stringify(termsNow.filter(x => x.title.length < 20)));

  // ── 3. the neighbours' record ──────────────────────────────────────────────
  console.log('\nThe neighbours\' record');
  const signedOut = await page.evaluate(() => ({ record: MapRiverScout.record(), nb: MapRiverScout.here().nb, used: MapRiverScout.here().used,
    note: document.getElementById('riverscout-record')?.textContent || '' }));
  ok('signed out, the record is said to be for editors, and the other two parts share its weight',
     signedOut.record.phase === 'denied' && signedOut.nb == null && !('nbr' in signedOut.used) && /editors/.test(signedOut.note), JSON.stringify(signedOut));
  const seeded = await page.evaluate(async ({ lat, lon }) => {
    const near = state.data.stations.filter(s => s.lat != null && stationAlertIds(s).length && acmaHaversineKm(lat, lon, s.lat, s.lon) < 14)
      .sort((a, b) => acmaHaversineKm(lat, lon, a.lat, a.lon) - acmaHaversineKm(lat, lon, b.lat, b.lon)).slice(0, 3);
    if (near.length < 2) return { skip: true, n: near.length };
    const tot = {};
    near.forEach((s, i) => { tot[`alert:${stationAlertIds(s)[0]}`] = { n: 1000, ok: i === 0 ? 1000 : 850 }; });
    // one that is heard too seldom to be a record
    const thin = state.data.stations.find(s => s.lat != null && !near.includes(s) && stationAlertIds(s).length && acmaHaversineKm(lat, lon, s.lat, s.lon) < 14);
    if (thin) tot[`alert:${stationAlertIds(thin)[0]}`] = { n: 5, ok: 0 };
    MapRiverScout.seedRecord(tot);
    MapRiverScout.pickPoint(lat, lon);
    await new Promise(r => setTimeout(r, 100));
    return { n: near.length, thin: !!thin };
  }, { lat: pick.lat, lon: pick.lon });
  if (seeded.skip) {
    ok('(the register has fewer than two stations within 14 km of the place — the record is not exercised)', true, JSON.stringify(seeded));
  } else {
    await settled();
    const withRec = await page.evaluate(() => { const h = MapRiverScout.here(); return { nb: h.nb && { count: h.nb.count, share: h.nb.share }, used: h.used, parts: h.parts, score: h.score }; });
    ok('handed a record, the stations within 15 km with enough frames count — not the one heard five times',
       withRec.nb && withRec.nb.count === seeded.n, JSON.stringify(withRec));
    ok('…and their clean share is distance-weighted between 85% and 100%, giving a figure between nought and one',
       withRec.nb.share > 0.84 && withRec.nb.share <= 1 && withRec.parts.nbr > 0 && withRec.parts.nbr <= 1 && 'nbr' in withRec.used, JSON.stringify(withRec));
  }

  // ── 4. along the river ─────────────────────────────────────────────────────
  console.log('\nAlong the river');
  await page.selectOption('#riverscout-span', '5');
  await page.selectOption('#riverscout-step', '500');
  await page.click('#riverscout-sweep');
  await page.waitForFunction(() => MapRiverScout.sweep() && MapRiverScout.status().kind === 'done', null, { timeout: RUN_TIMEOUT });
  const S = await page.evaluate(async () => {
    const sw = MapRiverScout.sweep(), here = MapRiverScout.here();
    const places = sw.places.map(p => ({ off: p.off, lat: p.lat, lon: p.lon, score: p.score, rank: p.rank }));
    const off = [];
    for (const p of places) { const h = await MapRiverLines.nearestTo(p.lat, p.lon, 400); off.push(h ? h.m : null); }
    const gaps = places.slice(1).map((p, i) => acmaHaversineKm(places[i].lat, places[i].lon, p.lat, p.lon) * 1000);
    return {
      n: places.length, places, off, gaps, river: sw.river.title, span: sw.span, step: sw.step, ends: sw.ends,
      cells: document.querySelectorAll('#riverscout-strip .rscout-cell').length,
      pins: document.querySelectorAll('.leaflet-mnScout-pane .mn-site').length,
      siteIdx: places.findIndex(p => p.off === 0), hereLat: here.lat,
      best: document.querySelectorAll('.rscout-best li').length,
    };
  });
  ok('a place every 500 m, 5 km each way, in order along the river — and the click\'s own at nought',
     S.n >= 15 && S.n <= 21 && S.siteIdx >= 0 && S.places.every((p, i) => i === 0 || p.off > S.places[i - 1].off), JSON.stringify({ n: S.n, siteIdx: S.siteIdx }));
  ok('…each about 500 m from the last along the ground (never 1.6 km; the line bends)',
     S.gaps.every(g => g > 100 && g <= 560), JSON.stringify(S.gaps.map(Math.round)));
  ok('…each within 400 m of the river\'s own line', S.off.every(m => m != null && m < 400), JSON.stringify(S.off.map(m => m && Math.round(m))));
  ok('every place has a score from 0 to 100, or none, and the strip has a cell for each',
     S.places.every(p => p.score === null || (Number.isInteger(p.score) && p.score >= 0 && p.score <= 100)) && S.cells === S.n, `${S.cells} cells of ${S.n}`);
  const scored = S.places.filter(p => p.score != null);
  const ranked = S.places.filter(p => p.rank).sort((a, b) => a.rank - b.rank);
  ok('the best five (or fewer, if fewer scored) are numbered 1.. and each is at least as good as every one not numbered',
     ranked.length === Math.min(5, scored.length) && ranked.every((p, i) => p.rank === i + 1)
     && ranked.every(p => scored.filter(q => !q.rank).every(q => q.score <= p.score)), JSON.stringify(ranked.map(p => [p.rank, p.score])));
  ok('…pinned on the map and listed under the strip', S.pins === ranked.length && S.best === ranked.length, `${S.pins} pins, ${S.best} listed`);
  ok('the ends of the strip are named by compass', /^[a-z-]+$/.test(S.ends.back) && /^[a-z-]+$/.test(S.ends.fwd), JSON.stringify(S.ends));

  const cell = Math.max(0, S.places.findIndex(p => p.off !== 0 && p.score != null));
  await page.locator('#riverscout-strip .rscout-cell').nth(cell).click();
  const picked = await page.evaluate(() => ({ sel: MapRiverScout.selected(), card: document.querySelector('.rscout-head')?.textContent || '' }));
  ok('pressing a cell in the strip puts that place\'s card up, and says how far along the river it is',
     picked.sel === cell && /km along the river/.test(picked.card), JSON.stringify(picked));

  const csv = await page.evaluate(() => MapRiverScout.csvText());
  const lines = csv.split('\n');
  ok('the CSV names its rules and has a row for every place scored',
     lines[0].includes('Flood-Net riverside site finder') && lines.filter(l => !l.startsWith('#')).length === S.n + 1 && !/MegaNet/.test(csv), `${lines.length} lines`);

  // ── 5. the map, and reset ──────────────────────────────────────────────────
  console.log('\nThe map, and reset');
  await page.click('#riverscout-arm');
  const banner = await page.evaluate(() => document.getElementById('map-mode')?.innerText || '');
  ok('armed again, the banner names the mode', /Riverside sites/.test(banner), banner);
  await page.keyboard.press('Escape');
  ok('…and Escape leaves it', await page.evaluate(() => !MapRiverScout.armed()));
  await page.click('.mn-mapctl[data-panel="riverscout"] button:has-text("Clear")');
  const cleared = await page.evaluate(() => ({ live: MapRiverScout.live(), here: MapRiverScout.here(), sweep: MapRiverScout.sweep(),
    dots: document.querySelectorAll('.leaflet-mnScout-pane path, .leaflet-mnScout-pane .mn-site').length,
    legend: /Riverside site finder/.test(document.getElementById('map-legend')?.textContent || '') }));
  ok('Clear takes all of it off the map and out of the legend',
     !cleared.live && !cleared.here && !cleared.sweep && cleared.dots === 0 && !cleared.legend, JSON.stringify(cleared));

  ok('nothing threw', errors.length === 0, errors.join('\n'));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? 'FAILED' : 'ok'} — ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
