// The Stations search box: address windows, and the stack of entries.
//
// Why this file exists rather than another block in tabs.mjs or shell.mjs:
// those two ask whether a tab is built out of the design system, which is a
// question about markup. This asks what the Stations filter box *selects* —
// a question about a rule, and one that nothing else in the harness can see.
// `npm run smoke` opens the tab and asserts a clean console; a search box that
// quietly returns the wrong stations throws nothing at all, which is the exact
// shape of defect the roadmap's first constraint says has to grow a check.
//
// Two rules are under test, and they were added in that order:
//
//   Windows.  A term shaped `4021-4025` is a window over ALERT addresses, and
//             every station holding an address inside it is a match.
//
//   The stack. The box is a list of entries, each pointed at whatever fields
//             the operator ticked — name, station number, ALERT addresses.
//             Entries combine as "any" (the union, the default) or "all" (the
//             intersection). This is what stops a pasted column of addresses
//             dragging in stations whose *number* merely shares those digits.
//
// Both are additive, so half of what is below is the older behaviour asserted
// again beside the new, so that "additive" is a claim the harness holds rather
// than a word in a commit message.
//
// Expectations are derived in the page from stationAlertIds() and the station
// list rather than re-implemented here: the claim is that the *filter*
// implements the rules, not that a second copy of the sensor normalisation
// agrees with the first. Everything else is compared against literal text.
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

// A term that lands in two different fields at once, which is the whole reason
// the stack exists: 491 starts ten ALERT addresses and sits inside four station
// numbers, and the two sets do not overlap. The README has used it as the
// example of an ambiguous term since long before this check.
const CROSSOVER = '491';

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

  const out = await page.evaluate(async ([windows, crossover]) => {
    const settle = () => new Promise(r => setTimeout(r, 40));

    // One entry, pointed wherever `fields` says (everything, by default).
    const row = (text, fields = {}) =>
      ({ ...newSearchRow(text), ...{ name: true, number: true, alert: true, ...fields } });
    // What the filter answers for a stack, as a sorted list of station ids.
    const selectStack = (rows, mode = 'any') => {
      state.filters.searches   = rows;
      state.filters.searchMode = mode;
      return filteredStations().map(s => s.id).sort();
    };
    const select = (text, fields) => selectStack([row(text, fields)]);
    // The same questions asked directly of the station list — the rules written
    // out once more, by hand, in one line each.
    const expectWindows = ranges => state.data.stations
      .filter(s => stationAlertIds(s).some(id => ranges.some(([lo, hi]) => id >= lo && id <= hi)))
      .map(s => s.id).sort();
    const byField = (t, field) => state.data.stations.filter(s =>
        field === 'name'   ? s.name.toLowerCase().includes(t)
      : field === 'number' ? String(s.station_number || '').toLowerCase().includes(t)
      :                      stationAlertIds(s).some(id => String(id).startsWith(t)))
      .map(s => s.id).sort();
    const same  = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const union = (...ls) => [...new Set([].concat(...ls))].sort();

    const r = {};
    const three = [[4021, 4025], [4036, 4042], [4047, 4050]];

    // ══ Windows ═══════════════════════════════════════════════════════════
    const got = select(windows);
    r.windowsExpected = expectWindows(three);
    r.windowsGot      = got;
    r.windowsMatch    = same(got, r.windowsExpected);
    r.windowsCount    = got.length;
    // Every window has to have pulled its own weight — one window quietly
    // matching nothing would still pass the set comparison above.
    r.perWindow = three.map(w => select(`${w[0]}-${w[1]}`).length);
    r.oneWindow = same(select('4021-4025'), expectWindows([[4021, 4025]]));

    // Every way of writing the same window. The en dash is what the Pass
    // Ranges tab prints and what a copy off that tab carries; the reversed
    // pair is a typo with one reading.
    const canonical = select('4036-4042');
    r.forms = {
      endash:   same(select('4036–4042'),  canonical),
      emdash:   same(select('4036—4042'),  canonical),
      dots:     same(select('4036..4042'), canonical),
      spaced:   same(select('4036 - 4042'), canonical),
      reversed: same(select('4042-4036'),   canonical),
    };

    // Separators: many windows in one entry, however they were pasted.
    const pasted = expectWindows([[4021, 4025], [4036, 4042]]);
    r.separators = {
      newlines: same(select('4021-4025\n4036-4042'), pasted),
      commas:   same(select('4021-4025, 4036-4042'), pasted),
      spaces:   same(select('4021-4025 4036-4042'),  pasted),
      semis:    same(select('4021-4025;4036-4042'),  pasted),
    };

    // Additive: a window next to the things the box already took.
    const named   = select('Amiens');
    const address = select('6128');
    const mixed   = select('Amiens, 6128, 4021-4025');
    r.namedFound   = named.length > 0;
    r.addressFound = address.length > 0;
    r.mixedIsUnion = same(mixed, union(named, address, expectWindows([[4021, 4025]])));

    // And the older rules, unchanged.
    r.twoAddresses  = same(select('6128 6129'), union(select('6128'), select('6129')));
    r.nameWithSpace = select('Mt Stuart').length > 0;
    r.emptyBoxAll   = select('').length === state.data.stations.length;
    r.prefixStillPrefix = select('612').length >= select('6128').length;

    // ══ The stack: what an entry is a list of ═════════════════════════════
    // The complaint this answers: a term that is an address to one station and
    // part of a number to another brings both back, and only one was asked for.
    const everywhere = select(crossover);
    const asId       = select(crossover, { name: false, number: false });
    const asNumber   = select(crossover, { name: false, alert: false });
    const asName     = select(crossover, { number: false, alert: false });
    r.cross = {
      everywhere: everywhere.length, id: asId.length, num: asNumber.length, name: asName.length,
      // Pointed at one field, the entry answers exactly that field's question…
      idIsField:   same(asId,     byField(crossover, 'alert')),
      numIsField:  same(asNumber, byField(crossover, 'number')),
      nameIsField: same(asName,   byField(crossover, 'name')),
      // …and the unscoped answer is the union of the three, which is precisely
      // the extra stations the operator did not ask for.
      unscopedIsUnion: same(everywhere, union(asId, asNumber, asName)),
      trims: asId.length > 0 && asNumber.length > 0 && asId.length < everywhere.length,
    };

    // Two entries, each pointed somewhere else — the case in the request.
    const numbersEntry = row(crossover, { name: false, alert: false });
    const windowEntry  = row('4021-4025', { name: false, number: false });
    const anyOfTwo = selectStack([numbersEntry, windowEntry], 'any');
    r.twoEntries = {
      count: anyOfTwo.length,
      isUnion: same(anyOfTwo, union(byField(crossover, 'number'), expectWindows([[4021, 4025]]))),
      // …and not the everything-matches-everything answer the single box gave.
      notTheOldAnswer: !same(anyOfTwo, select(`${crossover}, 4021-4025`)),
    };

    // "all" is the intersection: a name and an address window as one question.
    const some = state.data.stations.find(s => stationAlertIds(s).length && s.name.length > 3);
    const id0  = stationAlertIds(some)[0];
    const nameEntry  = row(some.name, { number: false, alert: false });
    const aroundId   = row(`${id0}-${id0}`, { name: false, number: false });
    const allOfTwo   = selectStack([nameEntry, aroundId], 'all');
    const anyOfSame  = selectStack([nameEntry, aroundId], 'any');
    r.allMode = {
      station: some.name,
      hasIt:   allOfTwo.includes(some.id),
      isIntersection: same(allOfTwo,
        selectStack([nameEntry]).filter(id => selectStack([aroundId]).includes(id)).sort()),
      narrowerThanAny: allOfTwo.length <= anyOfSame.length,
    };

    // An entry pointed at nothing is skipped, not "matches nothing".
    const nowhere = row('999999', { name: false, number: false, alert: false });
    r.inert = {
      any: same(selectStack([nameEntry, nowhere], 'any'), selectStack([nameEntry])),
      all: same(selectStack([nameEntry, nowhere], 'all'), selectStack([nameEntry])),
    };
    // And an empty new entry does not empty the table under whoever is typing.
    r.blankEntryHarmless = same(selectStack([nameEntry, row('')], 'all'), selectStack([nameEntry]));

    // ══ What the box says it did ══════════════════════════════════════════
    state.filters.searches = [row(windows)];
    state.filters.searchMode = 'any';
    r.note = searchTermsNoteHtml(0);
    state.filters.searches = [row('9000-9100')];
    r.emptyWindowNote = searchTermsNoteHtml(0);
    r.emptyWindowSelects = select('9000-9100').length;
    // A term that is on file, but not in the field this entry points at, is not
    // found — the entry said what it was a list of.
    const realNumber = String(state.data.stations.find(s => s.station_number).station_number);
    state.filters.searches = [row(`${realNumber}, 6128`, { name: false, number: false })];
    r.wrongFieldNote = searchTermsNoteHtml(0);
    r.realNumber = realNumber;
    state.filters.searches = [row('4021-4025', { name: false, number: false, alert: false })];
    r.inertNote = searchTermsNoteHtml(0);

    // ══ The table ═════════════════════════════════════════════════════════
    switchTab('stations');
    await settle();
    const marksIn = col => [...document.querySelectorAll(
      `#main-content table tbody tr td:nth-child(${col}) mark.hit`)].map(m => m.textContent.trim());
    const draw = async rows => {
      state.filters.searches = rows;
      stationsFilterChanged();
      await settle();
    };

    await draw([row('4021-4025')]);
    r.rowsDrawn   = document.querySelectorAll('#main-content table tbody tr').length;
    r.markedWhole = marksIn(5).some(t => /^40(2[1-5])$/.test(t));
    r.markedWindowText = marksIn(5).concat(marksIn(2)).some(t => t.includes('-'));

    // Scoped marks: the amber can only ever be where the match was made.
    await draw([row(crossover, { name: false, number: false })]);
    r.idOnlyMarks = { alert: marksIn(5).length, number: marksIn(2).length };
    await draw([row(crossover, { name: false, alert: false })]);
    r.numOnlyMarks = { alert: marksIn(5).length, number: marksIn(2).length };

    // ══ The controls ══════════════════════════════════════════════════════
    // Back to how a fresh page opens — the checks above left the first entry
    // pointed at one field, and "all ticked by default" is about the default.
    state.filters.searches = [newSearchRow()];
    state.filtersOpen = true;
    renderStationFilters();
    await settle();
    const boxes = () => document.querySelectorAll('#search-stack .filter-search').length;
    r.startsWithOne = boxes() === 1;
    r.modeHiddenAtOne = !document.querySelector('#search-stack .search-mode');
    document.querySelector('#search-stack .search-add').click();
    await settle();
    r.addedOne     = boxes() === 2;
    r.modeShownAtTwo = !!document.querySelector('#search-stack .search-mode');
    r.focusMoved   = document.activeElement?.id === 'station-search-1';
    r.scopeBoxes   = document.querySelectorAll('#search-stack .search-field input[type="checkbox"]').length;
    r.allTickedByDefault = [...document.querySelectorAll('#search-stack .search-field input')]
      .every(c => c.checked);
    // Typing into the second entry reaches the filter, and does not redraw the
    // stack under the caret.
    mapSearchInput(1, 'Amiens');
    r.secondEntryHeld = state.filters.searches[1].text === 'Amiens';
    setSearchField(1, 'number', false);
    r.fieldStuck = state.filters.searches[1].number === false;
    await settle();
    document.querySelectorAll('#search-stack .search-remove')[1].click();
    await settle();
    r.removedOne = boxes() === 1;
    document.querySelector('#search-stack .search-add').click();
    await settle();
    clearSearch();
    await settle();
    r.clearedToOne = boxes() === 1 && !state.filters.searches[0].text;
    r.clearRestoresFields = state.filters.searches[0].name && state.filters.searches[0].number
                            && state.filters.searches[0].alert;

    // ══ The Pass Ranges tab, on the same windows ══════════════════════════
    const repeaters = state.data.stations.filter(s => s.roles.includes('repeater') && s.repeater);
    const carrying  = repeaters.filter(rp =>
      alertIdsInRange(4021, 4025).some(id => passRangeCoversId(rp.repeater, id)));
    state.prFilter = '4021-4025';
    const shown = repeaters.filter(rp =>
      passRangeRepeaterMatch(rp, findStationMatches(rp), state.prFilter));
    r.prCarrying     = carrying.length;
    r.prShown        = shown.length;
    r.prKeepsCarrier = carrying.every(rp => shown.includes(rp));
    r.prMarksRange   = carrying.length > 0 &&
      passRangesHtml(carrying[0].repeater, [], [[4021, 4025]]).includes('mark class="hit"');
    state.prFilter = '';
    return r;
  }, [WINDOWS, CROSSOVER]);

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
  ok('a name, an address and a window in one entry is the union of the three', out.mixedIsUnion);
  ok('a run of bare numbers still splits on spaces', out.twoAddresses);
  ok('a name with a space in it still does not', out.nameWithSpace);
  ok('an empty box still matches every station', out.emptyBoxAll);
  ok('an address is still matched from the start', out.prefixStillPrefix);

  console.log(`\nWhat an entry is a list of — "${CROSSOVER}" lands in two fields at once\n`);
  ok(`pointed everywhere it brings back ${out.cross.everywhere}`,
     out.cross.trims,
     `${out.cross.id} by address, ${out.cross.num} by number, ${out.cross.name} by name`);
  ok('pointed at AlertID it answers only the address question', out.cross.idIsField);
  ok('pointed at Stn # it answers only the number question', out.cross.numIsField);
  ok('pointed at Name it answers only the name question', out.cross.nameIsField);
  ok('and the unscoped answer is exactly the three put together — the extras nobody asked for',
     out.cross.unscopedIsUnion);

  console.log('\nTwo entries, each pointed somewhere else\n');
  ok(`"any" is the union of the two, and nothing else (${out.twoEntries.count} stations)`,
     out.twoEntries.isUnion);
  ok('and it is not what the one box used to answer', out.twoEntries.notTheOldAnswer);
  ok('"all" is the intersection', out.allMode.isIntersection && out.allMode.narrowerThanAny);
  ok('and a name plus a window around one of its addresses finds that station',
     out.allMode.hasIt, out.allMode.station);
  ok('an entry pointed at no field is ignored, not "matches nothing" (any)', out.inert.any);
  ok('the same under "all", so it cannot empty the table', out.inert.all);
  ok('and a blank new entry is harmless under "all"', out.blankEntryHarmless);

  console.log('\nWhat the box says it did\n');
  ok('the note counts the addresses the windows cover',
     /16 ALERT addresses inside the 3 ranges/.test(out.note), out.note);
  ok('and says all three were found', /all found/.test(out.note), out.note);
  ok('a window nobody has addressed is named as not on file',
     /not in this database/.test(out.emptyWindowNote) && /9000-9100/.test(out.emptyWindowNote),
     out.emptyWindowNote);
  ok('and selects nothing rather than everything', out.emptyWindowSelects === 0,
     `${out.emptyWindowSelects} selected`);
  ok('a term on file but not in the field the entry points at is "not found"',
     out.wrongFieldNote.includes(out.realNumber) && /not in this database/.test(out.wrongFieldNote),
     out.wrongFieldNote);
  ok('an entry pointed at nothing says so rather than going quiet',
     /being ignored/.test(out.inertNote), out.inertNote);

  console.log('\nThe table\n');
  ok('draws the windowed rows', out.rowsDrawn > 0, `${out.rowsDrawn} rows`);
  ok('marks a windowed address whole', out.markedWhole);
  ok('and never marks the window text itself', !out.markedWindowText);
  ok('an AlertID-only entry marks addresses and never station numbers',
     out.idOnlyMarks.alert > 0 && out.idOnlyMarks.number === 0, JSON.stringify(out.idOnlyMarks));
  ok('a Stn #-only entry marks numbers and never addresses',
     out.numOnlyMarks.number > 0 && out.numOnlyMarks.alert === 0, JSON.stringify(out.numOnlyMarks));

  console.log('\nThe controls\n');
  ok('the box opens as one entry', out.startsWithOne);
  ok('with no combine control, because there is nothing to combine', out.modeHiddenAtOne);
  ok('+ adds a second', out.addedOne);
  ok('and the combine control appears with it', out.modeShownAtTwo);
  ok('with the caret already in the new entry', out.focusMoved);
  ok('three fields per entry, all ticked', out.scopeBoxes === 6 && out.allTickedByDefault,
     `${out.scopeBoxes} tick boxes across two entries`);
  ok('typing into the second entry reaches the filter', out.secondEntryHeld);
  ok('and unticking a field sticks', out.fieldStuck);
  ok('− removes it again', out.removedOne);
  ok('clear takes the stack back to one empty entry', out.clearedToOne);
  ok('pointed at everything, as a fresh page opens', out.clearRestoresFields);

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
  : '\nPASS — an address window selects the stations inside it, an entry only looks\n'
    + '       where it was pointed, and two entries never contaminate each other.');
process.exit(failures ? 1 : 0);
