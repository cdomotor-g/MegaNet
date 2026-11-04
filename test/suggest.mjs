// "Did you mean …?" for a station's name (station-suggest.js), in Chromium
// over the real stations.json.
//
//   1. **The ear** — names spelt the way they are said, or one slip of the
//      fingers away, offer the station they belong to: "jimpy" Gympie,
//      "kabooltcher" Caboolture, "orgathella" Augathella, "mount kilkoy" Mt
//      Kilcoy, "beer burrum" Beerburrum. Each is one nobody could type their
//      way to: the Stations filter itself finds nothing for it. Gibberish, a
//      number and an address window offer nothing, and none of it is slow.
//   2. **Ctrl+K** — a name that finds nothing lists the stations that sound
//      like it under "Did you mean?", the count says so, and Enter opens the
//      first. Gibberish still offers only the place lookup.
//   3. **The Stations card** — the match note under the quick box offers the
//      spelling, picking it puts it in the box in place of what was typed and
//      the list then holds the stations it names; in a list of terms only the
//      one that found nothing is replaced.
//   4. **The pickers elsewhere** — Map Generator's and Link Budget's station
//      boxes list the sound-alikes under "Nothing is spelt …".
//
// Why a check of its own: a suggestion that has quietly stopped coming — a
// rule in the key that no longer fires, a threshold moved — throws nothing,
// and the box just says "nothing matches" the way it always did.
//
// Run:  npm run suggest
//       npm run suggest -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

// What was typed, and a word the station it should offer has in its name.
// Every one is a real name on file, spelt the way somebody might hear it.
const HEARD = [
  ['jimpy', 'gympie'], ['gimpy', 'gympie'], ['gmypie', 'gympie'],
  ['maroochidor', 'maroochydore'], ['marooshy', 'maroochy'],
  ['mulula', 'mooloolah'], ['tuwoomba', 'toowoomba'], ['tawoomba', 'toowoomba'],
  ['kabooltcher', 'caboolture'], ['caboolcher', 'caboolture'],
  ['wivanhoe', 'wivenhoe'], ['beerburum', 'beerburrum'], ['yumundi', 'eumundi'],
  ['kumera', 'coomera'], ['yepoon', 'yeppoon'], ['gundawindy', 'goondiwindi'],
  ['merwillumbah', 'murwillumbah'], ['mudjeraba', 'mudgeeraba'], ['kulangatta', 'coolangatta'],
  ['bundaburg', 'bundaberg'], ['gaynder', 'gayndah'], ['mackai', 'mackay'],
  ['prosapine', 'proserpine'], ['innisfale', 'innisfail'], ['kans', 'cairns'],
  ['mariba', 'mareeba'], ['daintry', 'daintree'], ['orgathella', 'augathella'],
  ['kunamulla', 'cunnamulla'], ['targomindah', 'thargomindah'], ['kwilpy', 'quilpie'],
  ['injoon', 'injune'], ['tarum', 'taroom'], ['kilkoy', 'kilcoy'], ['stanthawp', 'stanthorpe'],
  ['killarny', 'killarney'], ['withcut', 'withcott'], ['laidly', 'laidley'],
  ['beer burrum', 'beerburrum'], ['mount kilkoy', 'kilcoy'], ['goondi windi', 'goondiwindi'],
];
const NOTHING = ['zzqxw', 'qwertyuiop', 'zzz', 'ab', '6128', '4021-4025'];

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(server.url('/index.html?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && !!state.map, null, { timeout: LOAD_TIMEOUT });

    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. The ear\n');
    const ear = await page.evaluate(([heard, nothing]) => {
      const all = state.data.stations;
      StationSuggest.suggest('warm', all);   // the index, built once, not timed
      const out = { heard: [], nothing: [], slowest: 0 };
      for (const [q, want] of heard) {
        const t0 = performance.now();
        const near = StationSuggest.suggest(q, all, { limit: 4 });
        out.slowest = Math.max(out.slowest, performance.now() - t0);
        const prep = prepareSearch(q);
        out.heard.push({ q, want, names: near.map(h => h.station.name),
          first: !!near[0] && near[0].station.name.toLowerCase().includes(want),
          found: near.some(h => h.station.name.toLowerCase().includes(want)),
          typed: all.filter(s => stationMatchesSearch(s, prep)).length });
      }
      for (const q of nothing) out.nothing.push({ q, names: StationSuggest.suggest(q, all).map(h => h.station.name) });
      return out;
    }, [HEARD, NOTHING]);
    const missed = ear.heard.filter(h => !h.found);
    check(`every one of ${HEARD.length} names spelt by ear offers its station among the first four`,
      !missed.length, J(missed));
    const second = ear.heard.filter(h => h.found && !h.first);
    check('…and nearly all of them first', second.length <= 3, J(second.map(h => [h.q, h.names[0]])));
    const typable = ear.heard.filter(h => h.typed);
    check('none of them finds anything in the Stations filter as typed — they are the case this is for',
      !typable.length, J(typable.map(h => h.q)));
    const loud = ear.nothing.filter(n => n.names.length);
    check('gibberish, a two-letter word, a number and an address window offer nothing', !loud.length, J(loud));
    check('a query is heard in well under a keystroke\'s time', ear.slowest < 400, `slowest ${ear.slowest.toFixed(1)} ms`);
    const keys = await page.evaluate(() => [StationSuggest.key('Caboolture'), StationSuggest.key('kabooltcher'),
      StationSuggest.key('Gympie'), StationSuggest.key('jimpy'), StationSuggest.key('Augathella'), StationSuggest.key('orgathella')]);
    check('the key hears -ture as "cha", a soft g as j, and an r nobody says as nothing',
      keys[0] === keys[1] && keys[2] === keys[3] && keys[4] === keys[5], J(keys));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. Ctrl+K\n');
    const look = () => page.evaluate(() => ({
      groups: [...document.querySelectorAll('#pal-list .pal-group-title')].map(g => g.textContent.trim()),
      labels: [...document.querySelectorAll('#pal-list [role="option"] .pal-label')].map(o => o.textContent),
      active: (document.querySelector('#pal-list [aria-selected="true"] .pal-label') || {}).textContent || null,
      count: (document.getElementById('pal-count') || {}).textContent || '',
      none: (document.querySelector('#pal-list .pal-none') || {}).textContent || '',
    }));
    await page.keyboard.press('Control+k');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'pal-q', null, { timeout: 5_000 });
    await page.fill('#pal-q', 'kabooltcher');
    await page.waitForTimeout(60);
    let L = await look();
    check('a name spelt by ear lists the stations it sounds like, under "Did you mean?"',
      L.groups.includes('Did you mean?') && L.labels.some(x => /^Caboolture/.test(x)), J(L));
    check('…with the line above saying nothing matched as it is spelt, and the count asking',
      /Nothing matches/.test(L.none) && /did you mean Caboolture/.test(L.count), J({ none: L.none, count: L.count }));
    check('…the first of them marked for Enter', /^Caboolture/.test(L.active || ''), L.active);
    const want = L.active;
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('pal-q') && state.stnCard && state.stnCard.id, null, { timeout: 10_000 });
    const opened = await page.evaluate(() => (state.data.stations.find(s => s.id === state.stnCard.id) || {}).name);
    check('Enter opens it: its card up', opened === want, J({ opened, want }));
    await page.keyboard.press('Control+k');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'pal-q', null, { timeout: 5_000 });
    await page.fill('#pal-q', 'zzqxw');
    await page.waitForTimeout(60);
    L = await look();
    check('gibberish still offers only to look for it as a place', !L.groups.includes('Did you mean?')
      && L.labels.length === 1 && /Nothing matches/.test(L.count), J(L));
    await page.fill('#pal-q', 'gympie');
    await page.waitForTimeout(60);
    L = await look();
    check('a name that is found is not second-guessed', !L.groups.includes('Did you mean?') && L.groups[0] === 'Stations', J(L.groups));
    await page.keyboard.press('Escape');

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. The Stations card\n');
    await page.evaluate(() => { if (state.filtersOpen) toggleStationFilters(); clearSearch(); });
    await page.fill('#station-search-quick', 'jimpy');
    await page.waitForFunction(() => /Did you mean/.test((document.getElementById('map-match-note') || {}).textContent || ''), null, { timeout: 5_000 });
    let note = await page.evaluate(() => {
      const el = document.getElementById('map-match-note');
      return { text: el.textContent.replace(/\s+/g, ' ').trim(), picks: [...el.querySelectorAll('.search-suggest-pick')].map(b => b.textContent) };
    });
    check('the match note offers the spelling, with how many stations it names',
      /No stations match/.test(note.text) && note.picks[0] === 'Gympie' && /Gympie \(\d+ stations\)/.test(note.text), J(note));
    await page.click('#map-match-note .search-suggest-pick');
    await page.waitForTimeout(300);
    let after = await page.evaluate(() => ({ box: document.getElementById('station-search-quick').value,
      focus: document.activeElement && document.activeElement.id,
      n: filteredStations().length, names: filteredStations().map(s => s.name),
      note: document.getElementById('map-match-note').textContent }));
    check('picking it puts it in the box in place of what was typed, the caret back in the box',
      after.box === 'Gympie' && after.focus === 'station-search-quick', J(after));
    check('…and the list then holds the stations it names', after.n > 0 && after.names.every(n => /gympie/i.test(n)) && !/Did you mean/.test(after.note), J(after));
    await page.fill('#station-search-quick', 'Gatton, mulula');
    await page.waitForFunction(() => /did you mean/i.test((document.getElementById('map-match-note') || {}).textContent || ''), null, { timeout: 5_000 });
    note = await page.evaluate(() => document.getElementById('map-match-note').textContent.replace(/\s+/g, ' ').trim());
    check('in a list of terms, the note says which term the offer is for', /“mulula”: did you mean Mooloolah/.test(note) && /stations match/.test(note), note);
    await page.click('#map-match-note .search-suggest-pick');
    await page.waitForTimeout(300);
    after = await page.evaluate(() => ({ box: document.getElementById('station-search-quick').value,
      mool: filteredStations().filter(s => /mooloolah/i.test(s.name)).length, gatton: filteredStations().filter(s => /gatton/i.test(s.name)).length }));
    check('…and only that term is replaced, the rest as typed', after.box === 'Gatton, Mooloolah' && after.mool > 0 && after.gatton > 0, J(after));
    await page.evaluate(() => clearSearch());

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. The pickers elsewhere\n');
    await page.evaluate(() => switchTab('mapgen'));
    await page.waitForSelector('#mg-stn-find', { timeout: LOAD_TIMEOUT });
    await page.fill('#mg-stn-find', 'kabooltcher');
    await page.waitForTimeout(80);
    const pickers = await page.evaluate(() => {
      const text = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
      const hits = document.getElementById('mg-stn-hits');
      return { mg: { lead: text(hits && hits.querySelector('.mg-hint')), hits: [...(hits ? hits.querySelectorAll('.mg-hit-name') : [])].map(text) } };
    });
    await page.fill('#mg-stn-find', '');
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    check('Map Generator\'s station box lists the sound-alikes under "Nothing is spelt …"',
      /Nothing is spelt “kabooltcher” — did you mean one of these\?/.test(pickers.mg.lead) && pickers.mg.hits.some(x => /^Caboolture/.test(x)), J(pickers.mg));
    await page.evaluate(() => {
      const d = document.querySelector('#link-budget-panel > details.lb-panel');
      if (d && !d.open) d.open = true;
      dockReveal(document.getElementById('link-budget-panel'));
      LinkBudget.setOpen(true);
      LinkBudget.reset();
    });
    await page.fill('#lb-find-a', 'orgathella');
    await page.waitForTimeout(80);
    const lb = await page.evaluate(() => {
      const text = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
      return { lead: text(document.getElementById('lb-find-lead-a')),
               hits: [...document.querySelectorAll('.lb-hit-name')].map(text) };
    });
    check('Link Budget\'s end boxes do the same', !!lb && /Nothing is spelt “orgathella”/.test(lb.lead) && lb.hits.some(x => /^Augathella/.test(x)), J(lb));

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — a station name spelt the way it is said finds the station, in Ctrl+K,\n'
    + '       the Stations card and the pickers.');
}

main().catch(e => { console.error(e); process.exit(1); });
