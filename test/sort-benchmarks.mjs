// 📏 Benchmarks for SoRT (sort-benchmarks.js), held to the contract SoRT's
// scope builder is built to — in Chromium over the real register, with the
// database's two reads stood in for (station_benchmark and benchmark_extract,
// editors only in 0101; tools/check_station_benchmarks.sql holds the real ones
// to that), and SoRT stood in for by a page served at its real origin,
// https://cdomotor-g.github.io, that opens Flood-Net with window.open() and
// keeps every message it is sent. Every mark here is made up.
//
//   The request     read as untrusted: the contract's example, a newer
//                   version, v missing, not base64url, cut short, not JSON,
//                   not from SoRT, a nonce too short, too long or with a
//                   space, over 4 KB, unknown keys, control characters in the
//                   name, a number given as a number, a station named by
//                   nothing; found by its id, by a padded bureau number, or not.
//   The message     its exact shape: type, v, the nonce, Flood-Net's station,
//                   the printed date, the marks in ord order with numbers as
//                   numbers and the rest null; an unknown datum as UNKNOWN;
//                   Copy for SoRT's text and its round trip; one postMessage in
//                   the file, to the one origin.
//   Landing         the fragment gone from the address bar at once, the card
//                   up with focus, the request kept in this tab's
//                   sessionStorage; signed out: Sign in and Dismiss and
//                   nothing asked of the database; a reload puts it back.
//   Not an editor   "Only Flood-Net editors can see the Bureau's benchmarks",
//                   Dismiss, nothing read, and send() and copy() do nothing;
//                   before whoami() answers, nothing read either.
//   An editor       the station's marks exactly as they will go — level, datum
//                   with its meaning, height on the gauge, description,
//                   comment, the printed date, the gauge zero — markup arriving
//                   in a description shown as text.
//   No opener       Send says the SoRT tab can't be reached and offers Copy for
//                   SoRT, which copies `floodnet-benchmarks:` + base64url of
//                   the same message and forgets the request; a browser that
//                   will not copy shows the text to copy by hand.
//   None listed     "HDB lists no benchmarks", found by its bureau number
//                   alone, and Send posts an empty list to the one origin.
//   Not readable    no report row (not loaded, or not this account's): no Send.
//                   A read that fails: said, Try again, no Send.
//   Not found       a station Flood-Net does not have: said, nothing to send,
//                   nothing asked.
//   A bad request   a newer SoRT's, arriving while the tab is open: said in
//                   words, nothing kept.
//   From SoRT       end to end: SoRT's page opens the tab, an editor signs in
//                   and presses Send, and SoRT's page receives exactly the
//                   message once, from Flood-Net's origin; Close this tab
//                   closes it. A page of any other origin that opens Flood-Net
//                   the same way receives nothing.
//   The words       every marked word means something, and the fold says them
//                   all; on a phone the card stays inside the screen.
//
// Run:  npm run sortbenchmarks
//       npm run sortbenchmarks -- -v    also print what passed

import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = x => JSON.stringify(x);
const same = (a, b) => isDeepStrictEqual(a, b);

const SORT_ORIGIN = 'https://cdomotor-g.github.io';
const OTHER_ORIGIN = 'https://pages.example.net';
const KEY = 'mn-sort-benchmarks';

// base64url of the UTF-8 JSON, no padding — SoRT's side of the contract.
const b64url = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

const REQUEST = { v: 1, source: 'sort', nonce: 'n0nce-Abc_123', station: { id: 'flinton', number: '42053', name: 'Flinton' } };

// The marks the stand-in serves, out of order and made up: no real level,
// description or position.
const MARKS = {
  flinton: [
    { ord: 2, level_m: 101.5, datum: 'ASSUM', description: 'Made-up nail in a made-up post.', comment: null,
      gauge_zero_m: 98.765, gauge_datum: 'AHD', on_gauge_m: null, printed_on: '2026-10-15' },
    { ord: 0, level_m: 100.123, datum: 'AHD', description: 'Made-up bolt <img src=x onerror="window.__xss=1"> in a made-up rock.',
      comment: 'A made-up <b>comment</b>.', gauge_zero_m: 98.765, gauge_datum: 'AHD', on_gauge_m: 1.358, printed_on: '2026-10-15' },
    { ord: 1, level_m: 99, datum: 'AHD', description: '', comment: 'Made-up: no description.',
      gauge_zero_m: 98.765, gauge_datum: 'AHD', on_gauge_m: 0.235, printed_on: '2026-10-15' },
  ],
  fifteen_mile_al: [],
};
// …and the message the contract says Send makes of them.
const EXPECT = {
  type: 'floodnet:benchmarks', v: 1, nonce: REQUEST.nonce,
  station: { id: 'flinton', number: '42053', name: 'Flinton' },
  printed_on: '2026-10-15',
  benchmarks: [
    { ord: 0, level_m: 100.123, datum: 'AHD', on_gauge_m: 1.358, gauge_zero_m: 98.765, gauge_datum: 'AHD',
      description: 'Made-up bolt <img src=x onerror="window.__xss=1"> in a made-up rock.', comment: 'A made-up <b>comment</b>.' },
    { ord: 1, level_m: 99, datum: 'AHD', on_gauge_m: 0.235, gauge_zero_m: 98.765, gauge_datum: 'AHD',
      description: null, comment: 'Made-up: no description.' },
    { ord: 2, level_m: 101.5, datum: 'ASSUM', on_gauge_m: null, gauge_zero_m: 98.765, gauge_datum: 'AHD',
      description: 'Made-up nail in a made-up post.', comment: null },
  ],
};
const MARK_KEYS = ['ord', 'level_m', 'datum', 'on_gauge_m', 'gauge_zero_m', 'gauge_datum', 'description', 'comment'];

// ── The database's two reads, stood in for ──────────────────────────────────
const db = { requests: [], extract: [{ printed_on: '2026-10-15' }], fail: 0 };
const dbReads = name => db.requests.filter(r => r.name === name);
async function installDb(ctx) {
  await ctx.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    if (!['station_benchmark', 'benchmark_extract'].includes(name)) return route.fallback();
    db.requests.push({ name, url: req.url(), auth: req.headers().authorization || '' });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    if (db.fail) return json(db.fail, { message: 'made-up failure for the test' });
    if (name === 'benchmark_extract') return json(200, db.extract);
    const id = (url.searchParams.get('station_id') || '').replace(/^eq\./, '');
    return json(200, MARKS[id] || []);
  });
}

// SoRT, and a page of some other origin, stood in for: a button that opens
// Flood-Net at the address in this page's own fragment, under the contract's
// window name, and a list of every message that arrives.
const OPENER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opener stand-in</title></head><body>
<button id="ask" onclick="window.open(decodeURIComponent(location.hash.slice(1)), 'floodnet-sort-bridge')">Ask Flood-Net</button>
<script>window.__got = []; addEventListener('message', e => window.__got.push({ origin: e.origin, data: e.data }));</script>
</body></html>`;
async function installOpeners(ctx) {
  for (const origin of [SORT_ORIGIN, OTHER_ORIGIN]) {
    await ctx.route(`${origin}/**`, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: OPENER_PAGE }));
  }
}

// Who is signed in, as whoami() would have it — every getter the card asks.
const as = (page, who) => page.evaluate(w => {
  dbSetAccessToken(w ? 'test-token' : null);
  Auth.isSignedIn = () => !!w;
  Auth.known = () => !!w && w !== 'unknown';
  Auth.mayWrite = () => w === 'editor';
  Auth.email = () => (w ? `${w}@example.com` : null);
  SortBenchmarks.authChanged();
}, who);

const card = page => page.evaluate(() => {
  const el = document.getElementById('sort-bridge');
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
});
const has = (page, id) => page.evaluate(i => !!document.querySelector(`#sort-bridge #${i}`), id);
const kept = page => page.evaluate(k => { try { return sessionStorage.getItem(k); } catch (_) { return 'unreadable'; } }, KEY);
const waitText = (page, re) => page.waitForFunction(src => {
  const el = document.getElementById('sort-bridge');
  return !!el && new RegExp(src).test(el.textContent.replace(/\s+/g, ' '));
}, re.source, { timeout: 15_000 });
const ready = page => page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
// The fragment, as SoRT writes it — and set on a page that is already open.
const frag = o => `#benchmarks-for-sort=${typeof o === 'string' ? o : b64url(o)}`;
const land = (page, o) => page.evaluate(h => { location.hash = h; }, frag(o));

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

async function newContext(viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'Australia/Brisbane', locale: 'en-AU' });
  await applyNetworkPolicy(ctx, server.origin);
  await installDb(ctx);
  await installOpeners(ctx);
  await ctx.addInitScript(() => { try { localStorage.setItem('mn-nudge', 'off'); } catch (_) {} });
  ctx.on('page', p => p.on('pageerror', e => errors.push(String(e))));
  return ctx;
}
async function openDirect(ctx, hash = '') {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url('/index.html') + hash, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await ready(page);
  return page;
}

try {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nThe request, read as untrusted\n');
  const ctx1 = await newContext();
  const p1 = await openDirect(ctx1);
  const parsed = await p1.evaluate(c => {
    const P = SortBenchmarks.parse;
    const out = {};
    for (const [k, v] of Object.entries(c)) out[k] = P(v);
    out.broken = P('not!base64');
    out.cut = P(c.good.slice(0, 30));
    out.notJson = P(btoa('hello').replace(/=+$/, ''));
    out.empty = P('');
    out.big = P('A'.repeat(4097));
    return out;
  }, {
    good: b64url(REQUEST),
    newer: b64url({ ...REQUEST, v: 2 }),
    noV: b64url({ ...REQUEST, v: undefined }),
    notSort: b64url({ ...REQUEST, source: 'elsewhere' }),
    shortNonce: b64url({ ...REQUEST, nonce: 'abc1234' }),
    longNonce: b64url({ ...REQUEST, nonce: 'n'.repeat(65) }),
    spaceNonce: b64url({ ...REQUEST, nonce: 'has a space' }),
    odd: b64url({ ...REQUEST, colour: 'red', station: { id: 'flinton', number: 42053, name: 'Flin\u0007ton\n  AL', hub: 'x', extra: [1] } }),
    badId: b64url({ ...REQUEST, station: { id: 'no spaces!', number: ' 042053 ', name: '' } }),
    nothing: b64url({ ...REQUEST, station: { id: '', number: '', name: '   ' } }),
    arrayStation: b64url({ ...REQUEST, station: ['flinton'] }),
    array: b64url([REQUEST]),
  });
  ok('the contract\'s example reads: the nonce and the station', parsed.good.ok && parsed.good.data.nonce === REQUEST.nonce
    && same(parsed.good.data.station, REQUEST.station), J(parsed.good));
  ok('a newer version is refused in words that say so', !parsed.newer.ok && /newer SoRT \(version 2\)/.test(parsed.newer.why), J(parsed.newer));
  ok('…and one with no version is not read', !parsed.noV.ok && !/newer/.test(parsed.noV.why), J(parsed.noV));
  ok('not base64url, cut short, not JSON, empty or a JSON list: refused in words',
    ['broken', 'cut', 'notJson', 'empty', 'array'].every(k => !parsed[k].ok && parsed[k].why.length > 20),
    J(['broken', 'cut', 'notJson', 'empty', 'array'].map(k => parsed[k])));
  ok('over 4 KB is refused before it is decoded', !parsed.big.ok && /too long/.test(parsed.big.why), J(parsed.big));
  ok('one not from SoRT is refused', !parsed.notSort.ok, J(parsed.notSort));
  ok('a nonce too short, too long or with a space is refused',
    !parsed.shortNonce.ok && !parsed.longNonce.ok && !parsed.spaceNonce.ok, J([parsed.shortNonce, parsed.longNonce, parsed.spaceNonce]));
  ok('unknown keys are ignored, control characters taken out of the name, a number given as a number read',
    parsed.odd.ok && same(parsed.odd.data.station, { id: 'flinton', number: '42053', name: 'Flin ton AL' }), J(parsed.odd));
  ok('…an id that is not an id dropped and a padded number trimmed',
    parsed.badId.ok && same(parsed.badId.data.station, { id: '', number: '042053', name: '' }), J(parsed.badId));
  ok('a station named by nothing — or a list where the station goes — is refused',
    !parsed.nothing.ok && !parsed.arrayStation.ok && /which station/.test(parsed.nothing.why), J([parsed.nothing, parsed.arrayStation]));

  const found = await p1.evaluate(() => {
    const F = w => { const s = SortBenchmarks.findStation(w); return s ? s.id : null; };
    return { id: F({ id: 'flinton', number: '', name: '' }), padded: F({ id: '', number: '042053', name: '' }),
             wrongId: F({ id: 'no_such_station', number: '42053', name: '' }), neither: F({ id: 'no_such_station', number: '987123', name: '' }),
             nameOnly: F({ id: '', number: '', name: 'Flinton' }), key: SortBenchmarks.bureauKey(' 000540601 ') };
  });
  ok('the station is found by its id, else by its bureau number with the leading zeros aside (bureau_key\'s rule)',
    found.id === 'flinton' && found.padded === 'flinton' && found.wrongId === 'flinton' && found.key === '540601', J(found));
  ok('…and neither, or a name alone, finds none', found.neither === null && found.nameOnly === null, J(found));

  console.log('\nThe message\n');
  const built = await p1.evaluate(([marks, nonce]) => {
    const s = state.data.stations.find(x => x.id === 'flinton');
    const m = SortBenchmarks.message(nonce, s, marks, '2026-10-15');
    const odd = SortBenchmarks.message(nonce, s, [{ ord: '0', level_m: '5.5', datum: 'LGH', description: '  ', comment: '', gauge_zero_m: '', gauge_datum: '', on_gauge_m: 'x' }], 'not a date');
    return { m, odd, text: SortBenchmarks.copyText(m), origin: SortBenchmarks.SORT_ORIGIN, prefix: SortBenchmarks.COPY_PREFIX };
  }, [MARKS.flinton, REQUEST.nonce]);
  ok('the message is exactly the contract\'s: type, v, nonce, Flood-Net\'s station, printed_on, the marks in ord order',
    same(built.m, EXPECT), `${J(built.m)}\n         wanted ${J(EXPECT)}`);
  ok('…each mark with exactly the contract\'s keys, numbers as numbers',
    built.m.benchmarks.every(b => same(Object.keys(b).sort(), [...MARK_KEYS].sort()) && typeof b.level_m === 'number' && typeof b.ord === 'number'),
    J(built.m.benchmarks));
  ok('a datum the contract does not name goes as UNKNOWN, blank words and figures as null, a bad date as null',
    same(built.odd.benchmarks[0], { ord: 0, level_m: 5.5, datum: 'UNKNOWN', on_gauge_m: null, gauge_zero_m: null, gauge_datum: null,
      description: null, comment: null }) && built.odd.printed_on === null, J(built.odd));
  ok('Copy for SoRT\'s text is floodnet-benchmarks: and base64url of the same message, no padding',
    built.prefix === 'floodnet-benchmarks:' && built.text.startsWith('floodnet-benchmarks:')
    && /^[A-Za-z0-9_-]+$/.test(built.text.slice(20)) && same(unb64url(built.text.slice(20)), EXPECT), built.text.slice(0, 60));
  const src = fs.readFileSync(`${REPO_ROOT}/sort-benchmarks.js`, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const posts = src.match(/postMessage\([^)]*\)/g) || [];
  ok('the one origin is https://cdomotor-g.github.io, a constant, and the file posts to it and nowhere else',
    built.origin === SORT_ORIGIN && /const SORT_ORIGIN = 'https:\/\/cdomotor-g\.github\.io';/.test(src)
    && posts.length === 1 && posts[0] === 'postMessage(msg, SORT_ORIGIN)' && !/['"]\*['"]/.test(src), J(posts));
  await ctx1.close();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nLanding signed out\n');
  db.requests = [];
  const ctx2 = await newContext();
  const p2 = await openDirect(ctx2, frag(REQUEST));
  await p2.waitForSelector('#sort-bridge #sbr-h', { timeout: 15_000 });
  const landed = await p2.evaluate(() => ({ hash: location.hash, href: location.href, focus: document.activeElement && document.activeElement.id,
    nudgeHidden: document.body.classList.contains('has-sort-bridge') }));
  ok('the address bar loses the fragment as soon as it is read', landed.hash === '' && !/benchmarks-for-sort/.test(landed.href), J(landed));
  ok('the card is up, says who asks and for which station, and has focus',
    /SoRT's scope builder asks for the Bureau's benchmarks at Flinton \(42053\)/.test(await card(p2)) && landed.focus === 'sbr-h', await card(p2));
  ok('the request is kept in this browser tab until it is dealt with', (await kept(p2)) === b64url(REQUEST));
  ok('signed out: why, Sign in and Dismiss — and no Send',
    /for Flood-Net editors only/.test(await card(p2)) && await has(p2, 'sbr-signin') && await has(p2, 'sbr-dismiss') && !(await has(p2, 'sbr-send')), await card(p2));
  ok('…the visitor note stands aside for the card\'s own Sign in', landed.nudgeHidden);
  ok('…and nothing was asked of the database', db.requests.length === 0, J(db.requests));
  await p2.click('#sbr-signin');
  ok('Sign in opens the sign-in panel over the card', await p2.evaluate(() => {
    const m = document.getElementById('auth-modal');
    return !!m && m.style.display === 'flex';
  }));
  await p2.keyboard.press('Escape');
  await p2.reload({ waitUntil: 'load' });
  await ready(p2);
  await p2.waitForSelector('#sort-bridge #sbr-h', { timeout: 15_000 });
  ok('a reload — or a sign-in\'s trip to Google and back — puts the request back from this tab',
    /at Flinton \(42053\)/.test(await card(p2)) && (await p2.evaluate(() => location.hash)) === '', await card(p2));

  console.log('\nSigned in, not an editor\n');
  await as(p2, 'unknown');
  await waitText(p2, /Finding out what your account may see/);
  ok('before whoami() answers: nothing read, no Send', db.requests.length === 0 && !(await has(p2, 'sbr-send')), J(db.requests));
  await as(p2, 'reader');
  await waitText(p2, /Only Flood-Net editors can see the Bureau's benchmarks/);
  ok('"Only Flood-Net editors can see the Bureau\'s benchmarks", Dismiss, and no Send or Sign in',
    await has(p2, 'sbr-dismiss') && !(await has(p2, 'sbr-send')) && !(await has(p2, 'sbr-signin')), await card(p2));
  const quiet = await p2.evaluate(async () => {
    window.__posted = [];
    window.__copied = [];
    window.opener = { closed: false, postMessage: (...a) => window.__posted.push(a) };
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: t => { window.__copied.push(t); return Promise.resolve(); } });
    SortBenchmarks.send();
    await SortBenchmarks.copy();
    return { posted: window.__posted.length, copied: window.__copied.length, phase: SortBenchmarks._state().phase };
  });
  ok('…and a non-editor sends nothing, even calling Send and Copy by hand', quiet.posted === 0 && quiet.copied === 0 && quiet.phase === 'review', J(quiet));
  ok('…nor is anything read for them', db.requests.length === 0, J(db.requests));

  console.log('\nAn editor, with no SoRT tab to send to\n');
  await p2.evaluate(() => { window.opener = null; });
  await as(p2, 'editor');
  await p2.waitForSelector('#sort-bridge #sbr-send', { timeout: 15_000 });
  const marksRead = dbReads('station_benchmark');
  const u = marksRead[0] ? new URL(marksRead[0].url) : null;
  ok('an editor\'s session reads the station\'s marks once, in ord order, and the report\'s row once',
    marksRead.length === 1 && u.searchParams.get('station_id') === 'eq.flinton' && u.searchParams.get('order') === 'ord.asc'
    && /level_m/.test(u.searchParams.get('select')) && dbReads('benchmark_extract').length === 1
    && marksRead[0].auth === 'Bearer test-token', J(db.requests));
  const shown = await p2.evaluate(() => {
    const el = document.getElementById('sort-bridge');
    return {
      marks: [...el.querySelectorAll('.sbr-mark')].map(li => li.innerText.replace(/\s+/g, ' ').trim()),
      imgs: el.querySelectorAll('img, b').length, xss: window.__xss || 0,
      terms: [...el.querySelectorAll('.term')].map(t => ({ text: t.textContent, title: t.getAttribute('title') || '' })),
      fold: [...el.querySelectorAll('.sbr-words dt')].map(dt => ({ dt: dt.textContent, dd: dt.nextElementSibling ? dt.nextElementSibling.textContent : '' })),
    };
  });
  const text2 = await card(p2);
  ok('the marks are listed in ord order, each level as it will be sent with its datum and its height on the gauge',
    shown.marks.length === 3 && /^100\.123 m AHD · on the gauge 1\.358 m/.test(shown.marks[0]) && /^99\.00 m AHD · on the gauge 0\.235 m/.test(shown.marks[1])
    && /^101\.50 m assumed datum Made-up nail/.test(shown.marks[2]) && !/on the gauge/.test(shown.marks[2]), J(shown.marks));
  ok('…each with its description (or that it has none) and its comment', /Made-up bolt/.test(shown.marks[0]) && /A made-up <b>comment<\/b>\./.test(shown.marks[0])
    && /No description\..*Made-up: no description\./.test(shown.marks[1]), J(shown.marks));
  ok('…markup arriving in a description or a comment shown as text, not run', shown.imgs === 0 && shown.xss === 0
    && /<img src=x onerror=/.test(shown.marks[0]), J({ imgs: shown.imgs, xss: shown.xss }));
  ok('…the report\'s printed date and the gauge zero in force', /report printed 15\/10\/2026 lists these 3 marks here — exactly what will be sent/.test(text2)
    && /Gauge zero in force: 98\.765 m AHD/.test(text2), text2);
  ok('…a sentence saying they go only to the SoRT tab that asked, for its scope and its Word tables, then Send to SoRT and Dismiss',
    /Send to SoRT puts them in the SoRT tab that asked — and nowhere else — for its scope and its Word tables/.test(text2)
    && await has(p2, 'sbr-send') && await has(p2, 'sbr-dismiss'), text2);
  ok('every marked word means something in a sentence of its own',
    shown.terms.length >= 6 && shown.terms.every(t => t.title.length > 40 && t.title.toLowerCase() !== t.text.toLowerCase()), J(shown.terms));
  ok('…and the fold says them all without a hover', shown.fold.length >= 8 && shown.fold.every(f => f.dd.length > 40)
    && ['AHD', 'Assumed datum', 'On the gauge', 'Editor'].every(w => shown.fold.some(f => f.dt === w)), J(shown.fold.map(f => f.dt)));
  ok('the request is still kept: nothing is sent until Send', (await kept(p2)) === b64url(REQUEST));

  await p2.click('#sbr-send');
  await waitText(p2, /can't be reached from here/);
  ok('no opener: Send says the SoRT tab can\'t be reached from here and offers Copy for SoRT',
    await has(p2, 'sbr-copy') && (await p2.evaluate(() => document.activeElement && document.activeElement.id)) === 'sbr-copy'
    && (await kept(p2)) === b64url(REQUEST), await card(p2));
  await p2.click('#sbr-copy');
  await waitText(p2, /Copied for SoRT/);
  const copied = await p2.evaluate(() => window.__copied);
  ok('Copy for SoRT copies floodnet-benchmarks: and the same message, once',
    copied.length === 1 && copied[0].startsWith('floodnet-benchmarks:') && same(unb64url(copied[0].slice(20)), EXPECT),
    copied[0] && copied[0].slice(0, 60));
  ok('…and the request is forgotten once copied', (await kept(p2)) === null);
  await p2.click('#sbr-dismiss');
  ok('Done takes the card away', !(await p2.evaluate(() => !!document.getElementById('sort-bridge'))));

  // A browser that will not copy, on a request that arrives while the tab is open.
  await p2.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('no')) }));
  await land(p2, { ...REQUEST, nonce: 'second-ask-0002' });
  await p2.waitForSelector('#sort-bridge #sbr-send', { timeout: 15_000 });
  ok('a request SoRT sends to the open tab (the fragment changing) is read too, and its fragment cleared',
    (await p2.evaluate(() => location.hash)) === '' && (await kept(p2)) === b64url({ ...REQUEST, nonce: 'second-ask-0002' }));
  await p2.click('#sbr-send');
  await p2.waitForSelector('#sort-bridge #sbr-copy');
  await p2.click('#sbr-copy');
  await p2.waitForSelector('#sort-bridge #sbr-copybox');
  const box = await p2.evaluate(() => document.getElementById('sbr-copybox').value);
  ok('a browser that will not copy is shown the text to copy by hand, and the request kept',
    box.startsWith('floodnet-benchmarks:') && unb64url(box.slice(20)).nonce === 'second-ask-0002' && (await kept(p2)) !== null, box.slice(0, 40));
  await p2.click('#sbr-dismiss');
  ok('Dismiss forgets it', (await kept(p2)) === null && !(await p2.evaluate(() => !!document.getElementById('sort-bridge'))));

  console.log('\nNone listed, by the bureau number alone\n');
  await p2.evaluate(() => { window.__posted = []; window.opener = { closed: false, postMessage: (...a) => window.__posted.push(a) }; });
  await land(p2, { ...REQUEST, nonce: 'third-ask-0003', station: { number: '540601', name: 'Fifteen Mile' } });
  await waitText(p2, /HDB lists no benchmarks for this station/);
  ok('"HDB lists no benchmarks for this station", found by its bureau number, and Send still offered',
    /at Fifteen Mile AL \(540601\)/.test(await card(p2)) && await has(p2, 'sbr-send'), await card(p2));
  await p2.click('#sbr-send');
  await waitText(p2, /Sent to the SoRT tab that asked/);
  const posted = await p2.evaluate(() => window.__posted);
  ok('Send posts an empty list, to https://cdomotor-g.github.io and that alone, once',
    posted.length === 1 && posted[0][1] === SORT_ORIGIN && posted[0].length === 2
    && same(posted[0][0], { type: 'floodnet:benchmarks', v: 1, nonce: 'third-ask-0003',
      station: { id: 'fifteen_mile_al', number: '540601', name: 'Fifteen Mile AL' }, printed_on: '2026-10-15', benchmarks: [] }), J(posted));
  ok('…says it is sent, offers Close this tab, and forgets the request',
    await has(p2, 'sbr-close') && (await kept(p2)) === null && /0 benchmarks for Fifteen Mile AL/.test(await card(p2)), await card(p2));
  await p2.click('#sbr-dismiss');

  console.log('\nNot readable, and a read that fails\n');
  db.extract = [];
  await land(p2, { ...REQUEST, nonce: 'fourth-ask-0004', station: { id: 'fifteen_mile_al' } });
  await waitText(p2, /does not hold the Bureau's benchmark report yet/);
  ok('no report row (not loaded, or not this account\'s to read): said, and no Send', !(await has(p2, 'sbr-send')), await card(p2));
  db.extract = [{ printed_on: '2026-10-15' }];
  await p2.click('#sbr-dismiss');
  db.fail = 500;
  await land(p2, { ...REQUEST, nonce: 'fifth-ask-00005' });
  await waitText(p2, /Could not read the benchmarks/);
  ok('a read that fails: said, Try again, and no Send', await has(p2, 'sbr-retry') && !(await has(p2, 'sbr-send')), await card(p2));
  db.fail = 0;
  await p2.click('#sbr-retry');
  await p2.waitForSelector('#sort-bridge #sbr-send', { timeout: 15_000 });
  ok('…Try again reads it', (await p2.evaluate(() => document.querySelectorAll('#sort-bridge .sbr-mark').length)) === 3);
  await p2.click('#sbr-dismiss');

  console.log('\nNot found, and a bad request\n');
  const before = db.requests.length;
  await land(p2, { ...REQUEST, nonce: 'sixth-ask-00006', station: { id: 'no_such_station', number: '987123', name: 'Nowhere Creek' } });
  await waitText(p2, /isn't in Flood-Net's station list/);
  ok('a station Flood-Net does not have is said, with nothing to send and nothing asked',
    /Nowhere Creek \(987123\) isn't in Flood-Net's station list/.test(await card(p2)) && !(await has(p2, 'sbr-send'))
    && db.requests.length === before, await card(p2));
  await p2.click('#sbr-dismiss');
  await land(p2, { ...REQUEST, v: 2 });
  await waitText(p2, /newer SoRT \(version 2\)/);
  ok('a newer SoRT\'s request is said in words, cleared from the address bar and not kept',
    (await p2.evaluate(() => location.hash)) === '' && (await kept(p2)) === null && await has(p2, 'sbr-dismiss'), await card(p2));
  await p2.click('#sbr-dismiss');
  await ctx2.close();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nFrom SoRT, end to end\n');
  db.requests = [];
  const ctx3 = await newContext();
  const target = server.url('/index.html') + frag(REQUEST);
  const sort = await ctx3.newPage();
  await sort.goto(`${SORT_ORIGIN}/SoRT/v2/#${encodeURIComponent(target)}`, { waitUntil: 'load' });
  const [pop] = await Promise.all([ctx3.waitForEvent('page'), sort.click('#ask')]);
  await pop.waitForLoadState('load');
  await ready(pop);
  await pop.waitForSelector('#sort-bridge #sbr-h', { timeout: 15_000 });
  ok('SoRT\'s page opens Flood-Net with the opener kept, and the card is up signed out',
    (await pop.evaluate(() => !!window.opener && window.name)) === 'floodnet-sort-bridge' && await has(pop, 'sbr-signin'), await card(pop));
  await as(pop, 'editor');
  await pop.waitForSelector('#sort-bridge #sbr-send', { timeout: 15_000 });
  await pop.click('#sbr-send');
  await sort.waitForFunction(() => window.__got.length > 0, null, { timeout: 10_000 });
  await pop.waitForTimeout(300);
  const got = await sort.evaluate(() => window.__got);
  ok('SoRT\'s page receives exactly the contract\'s message, once, from Flood-Net\'s origin',
    got.length === 1 && got[0].origin === server.origin && same(got[0].data, EXPECT), J(got));
  ok('…and the card says it is sent and forgets the request', /Sent to the SoRT tab that asked — 3 benchmarks for Flinton \(42053\)/.test(await card(pop))
    && (await kept(pop)) === null, await card(pop));
  const closed = pop.waitForEvent('close', { timeout: 5_000 }).then(() => true, () => false);
  await pop.click('#sbr-close');
  ok('Close this tab closes it', await closed);

  const other = await ctx3.newPage();
  await other.goto(`${OTHER_ORIGIN}/#${encodeURIComponent(target)}`, { waitUntil: 'load' });
  const [pop2] = await Promise.all([ctx3.waitForEvent('page'), other.click('#ask')]);
  await pop2.waitForLoadState('load');
  await ready(pop2);
  await pop2.waitForSelector('#sort-bridge #sbr-h', { timeout: 15_000 });
  await as(pop2, 'editor');
  await pop2.waitForSelector('#sort-bridge #sbr-send', { timeout: 15_000 });
  await pop2.click('#sbr-send');
  await pop2.waitForTimeout(800);
  const leaked = await other.evaluate(() => window.__got);
  ok('a page of any other origin that opens Flood-Net the same way receives nothing',
    leaked.length === 0 && (await sort.evaluate(() => window.__got.length)) === 1, J(leaked));
  await ctx3.close();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nOn a phone\n');
  const ctx4 = await newContext({ width: 375, height: 740 });
  const p4 = await openDirect(ctx4, frag(REQUEST));
  await p4.waitForSelector('#sort-bridge #sbr-h', { timeout: 15_000 });
  const fit = await p4.evaluate(() => {
    const r = document.getElementById('sort-bridge').getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight,
             scroll: document.documentElement.scrollWidth };
  });
  ok('the card stays inside a phone\'s screen, with a gutter each side, and the page does not scroll sideways',
    fit.left >= 15 && fit.right <= fit.w - 15 && fit.top >= 0 && fit.bottom <= fit.h && fit.scroll <= fit.w, J(fit));
  await ctx4.close();

  ok('no page threw', errors.length === 0, errors.join('\n         '));
} catch (err) {
  failures++;
  console.log(`  FAIL the check itself threw: ${err && err.stack || err}`);
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
