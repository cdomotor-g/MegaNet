// ALERT address windows in the search box.
//
// Why this file exists rather than another block in tabs.mjs or shell.mjs:
// those two ask whether a tab is built out of the design system, which is a
// question about markup. This asks what the Stations filter box *selects* —
// a question about a rule, and one that nothing else in the harness can see.
// `npm run smoke` opens the tab and asserts a clean console; a search box that
// quietly returns the wrong stations throws nothing at all, which is the exact
// shape of defect the roadmap's first constraint says has to grow a check.
//
// The rule under test: a term shaped `4021-4025` is a window over ALERT
// addresses, and every station holding an address inside it is a match. It is
// additive — names, station numbers, bare addresses and windows mix freely in
// one paste — so half of what is below is the older behaviour, asserted again
// beside the new so that "additive" is a claim the harness holds rather than a
// word in a commit message.
//
// Expectations are derived in the page from stationAlertIds() rather than
// re-implemented here: the claim is that the *filter* implements the window
// rule, not that a second copy of the sensor normalisation agrees with the
// first. Everything else is compared against literal text.
//
//   node --run search        (or: npm run search)
//       npm run search -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

// The three windows from the request that prompted this, unedited. They are
// real: the file has stations in all three, which is what makes them worth
// asserting against rather than a made-up pair.
const WINDOWS = '4021-4025\n4036-4042\n4047-4050';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond && !VERBOSE) return;
  if (cond) { console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  const out = await page.evaluate(async (windows) => {
    const settle = () => new Promise(r => setTimeout(r, 40));

    // What the filter answers for a query, as a sorted list of station ids.
    const select = q => {
      state.filters.search = q;
      return filteredStations().map(s => s.id).sort();
    };
    // The same question asked directly of each station's addresses — the
    // window rule written out once more, by hand, in one line.
    const expectWindows = ranges => state.data.stations
      .filter(s => stationAlertIds(s).some(id => ranges.some(([lo, hi]) => id >= lo && id <= hi)))
      .map(s => s.id).sort();
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

    const r = {};
    const three = [[4021, 4025], [4036, 4042], [4047, 4050]];

    // ── The windows themselves ────────────────────────────────────────────
    const got = select(windows);
    r.windowsExpected = expectWindows(three);
    r.windowsGot      = got;
    r.windowsMatch    = same(got, r.windowsExpected);
    r.windowsCount    = got.length;
    // Every window has to have pulled its own weight — one window quietly
    // matching nothing would still pass the set comparison above.
    r.perWindow = three.map(w => select(`${w[0]}-${w[1]}`).length);

    // ── One window is still one window ────────────────────────────────────
    r.oneWindow = same(select('4021-4025'), expectWindows([[4021, 4025]]));

    // ── Every way of writing the same window ──────────────────────────────
    // The en dash is what the Pass Ranges tab prints and what a copy off that
    // tab carries; the reversed pair is a typo with one reading.
    const canonical = select('4036-4042');
    r.forms = {
      endash:   same(select('4036–4042'),   canonical),
      emdash:   same(select('4036—4042'),   canonical),
      dots:     same(select('4036..4042'),       canonical),
      spaced:   same(select('4036 - 4042'),      canonical),
      reversed: same(select('4042-4036'),        canonical),
    };

    // ── Separators: many windows in one box, however they were pasted ─────
    const pasted = expectWindows([[4021, 4025], [4036, 4042]]);
    r.separators = {
      newlines: same(select('4021-4025\n4036-4042'),  pasted),
      commas:   same(select('4021-4025, 4036-4042'),  pasted),
      spaces:   same(select('4021-4025 4036-4042'),   pasted),
      semis:    same(select('4021-4025;4036-4042'),   pasted),
    };

    // ── Additive: a window next to the things the box already took ────────
    const named   = select('Amiens');
    const address = select('6128');
    const mixed   = select('Amiens, 6128, 4021-4025');
    const union   = [...new Set([...named, ...address, ...expectWindows([[4021, 4025]])])].sort();
    r.namedFound   = named.length > 0;
    r.addressFound = address.length > 0;
    r.mixedIsUnion = same(mixed, union);

    // ── And the older rules, unchanged ────────────────────────────────────
    // A run of bare numbers still splits on spaces; a name with a space in it
    // still does not; an empty box still matches everything; a bare address
    // still matches from the start.
    r.twoAddresses  = same(select('6128 6129'),
                           [...new Set([...select('6128'), ...select('6129')])].sort());
    r.nameWithSpace = select('Mt Stuart').length > 0;
    r.emptyBoxAll   = select('').length === state.data.stations.length;
    r.prefixStillPrefix = select('612').length >= select('6128').length;

    // ── What the note under the box says ──────────────────────────────────
    state.filters.search = windows;
    r.note = searchTermsNoteHtml();
    state.filters.search = '9000-9100';
    r.emptyWindowNote = searchTermsNoteHtml();
    // A window covering nothing selects nothing — it must not fall back to
    // "no filter" and hand back the whole network.
    r.emptyWindowSelects = select('9000-9100').length;

    // ── The table marks a windowed address whole ──────────────────────────
    state.filters.search = '4021-4025';
    switchTab('stations');
    await settle();
    stationsFilterChanged();
    await settle();
    const rows = document.querySelectorAll('#main-content table tbody tr');
    r.rowsDrawn = rows.length;
    r.markedWhole = [...document.querySelectorAll('#main-content table mark.hit')]
      .some(m => /^40(2[1-5])$/.test(m.textContent.trim()));
    // The window is not a run of characters, so it must not be marked as one
    // anywhere on the row.
    r.markedWindowText = [...document.querySelectorAll('#main-content table mark.hit')]
      .some(m => m.textContent.includes('-'));

    // ── The Pass Ranges tab takes the same windows ────────────────────────
    const repeaters = state.data.stations.filter(s => s.roles.includes('repeater') && s.repeater);
    const carrying  = repeaters.filter(rp =>
      alertIdsInRange(4021, 4025).some(id => passRangeCoversId(rp.repeater, id)));
    state.prFilter = '4021-4025';
    const shown = repeaters.filter(rp =>
      passRangeRepeaterMatch(rp, findStationMatches(rp), state.prFilter));
    r.prCarrying    = carrying.length;
    r.prShown       = shown.length;
    r.prKeepsCarrier = carrying.every(rp => shown.includes(rp));
    r.prMarksRange  = carrying.length > 0 &&
      passRangesHtml(carrying[0].repeater, [], [[4021, 4025]]).includes('mark class="hit"');
    state.prFilter = '';
    state.filters.search = '';
    return r;
  }, WINDOWS);

  console.log('\nThree windows, pasted one per line\n');
  ok(`the three windows select ${out.windowsCount} stations, and exactly those`,
     out.windowsMatch, `${out.windowsGot.length} selected, ${out.windowsExpected.length} hold an address inside`);
  ok('and each window pulled its own weight',
     out.perWindow.every(n => n > 0), `per window: ${out.perWindow.join(', ')}`);
  ok('one window on its own selects the stations inside it', out.oneWindow);

  console.log('\nEvery way of writing one window\n');
  for (const [form, pass] of Object.entries(out.forms)) ok(`${form} reads as the same window`, pass);

  console.log('\nEvery way of pasting several\n');
  for (const [sep, pass] of Object.entries(out.separators)) ok(`separated by ${sep}`, pass);

  console.log('\nAdditive — nothing the box already did stopped working\n');
  ok('a name still finds stations', out.namedFound);
  ok('a bare address still finds stations', out.addressFound);
  ok('a name, an address and a window in one box is the union of the three', out.mixedIsUnion);
  ok('a run of bare numbers still splits on spaces', out.twoAddresses);
  ok('a name with a space in it still does not', out.nameWithSpace);
  ok('an empty box still matches every station', out.emptyBoxAll);
  ok('an address is still matched from the start', out.prefixStillPrefix);

  console.log('\nWhat the box says it did\n');
  ok('the note counts the addresses the windows cover',
     /16 ALERT addresses inside the 3 ranges/.test(out.note), out.note);
  ok('and says all three were found', /all found/.test(out.note), out.note);
  ok('a window nobody has addressed is named as not on file',
     /not in this database/.test(out.emptyWindowNote) && /9000-9100/.test(out.emptyWindowNote),
     out.emptyWindowNote);
  ok('and selects nothing rather than everything', out.emptyWindowSelects === 0,
     `${out.emptyWindowSelects} selected`);

  console.log('\nThe table\n');
  ok('draws the windowed rows', out.rowsDrawn > 0, `${out.rowsDrawn} rows`);
  ok('marks a windowed address whole', out.markedWhole);
  ok('and never marks the window text itself', !out.markedWindowText);

  console.log('\nThe Pass Ranges tab, on the same windows\n');
  ok('keeps every repeater carrying an address in the window',
     out.prKeepsCarrier && out.prCarrying > 0,
     `${out.prCarrying} carry it, ${out.prShown} shown`);
  ok('and marks the pass range that carries it', out.prMarksRange);

  console.log('\nConsole\n');
  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures
  ? `\nFAIL — ${failures} check(s) failed.`
  : '\nPASS — an address window selects the stations inside it, in every form and\n'
    + '       mixture, and everything the box already took still works.');
process.exit(failures ? 1 : 0);
