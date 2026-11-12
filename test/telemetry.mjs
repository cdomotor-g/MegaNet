// 📻 Telemetry (telemetry.js, 0123), in a real browser, with the database's
// two answers stood in for by a fixture whose sums are known by hand:
//
//   * before 0123 is applied: the tab says so plainly, offers the demo, and the
//     demo draws every panel marked as made-up;
//   * the questions asked: a week by the hour, the links for a week, and a
//     fortnight by the day for Week on week; thirty days by the day;
//   * the tiles add up (bursts, decoded share), the filters narrow them, and a
//     filter the new window does not hold is let go with a note;
//   * every chart drawn — a bar a bucket, the outcome stack, the heat map's
//     rows, a chart a base station on one scale — and its numbers on hover;
//   * ALERT and ALERT2 side by side, Who hears what (a dot where a base heard
//     nothing; an address only one base hears, counted), the links near the
//     edge (caught against the best-placed base, weakest first), Week on week
//     (+20% bursts, −10 pts decoded);
//   * the Chart builder: a measure coloured by channel, side by side by base
//     station, as a chart and as a table, a clash turned off with a note, and
//     its CSV named floodnet-…;
//   * the page's words carry their meanings, no inline style but a token, and
//     nothing scrolls the page sideways at a phone's width.
//
// Run:  npm run telemetry

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
}
const J = v => JSON.stringify(v);

const HOUR = 3600e3, DAY = 86400e3;
const now = Date.now();
const COLS = ['t', 'base', 'channel', 'protocol', 'n', 'decoded', 'copies', 'shadow', 'undecoded', 'frame', 'check', 'other', 'snr_n', 'snr_sum', 'nf_n', 'nf_sum'];

// A week by the hour: Hilltop hears ALERT2 and ALERT on 151.5375 and ALERT on
// 151.550; Depot hears 151.550 and, once a day, bursts on no known channel.
function week() {
  const from = Math.floor(now / HOUR) * HOUR - 167 * HOUR, rows = [];
  for (let i = 0; i < 168; i++) {
    const t = Math.round((from + i * HOUR) / 1000);
    rows.push([t, 'Hilltop base', 151.5375, 'alert2', 100, 40, 50, 0, 0, 10, 0, 0, 100, 1500, 100, -6500]);
    rows.push([t, 'Hilltop base', 151.5375, 'alert', 10, 0, 0, 0, 10, 0, 0, 0, 0, 0, 10, -650]);
    rows.push([t, 'Hilltop base', 151.55, 'alert', 50, 40, 5, 3, 2, 0, 0, 0, 45, 540, 50, -3250]);
    rows.push([t, 'Depot base', 151.55, 'alert', 20, 15, 0, 0, 5, 0, 0, 0, 15, 120, 20, -1340]);
    if (i % 24 === 0) rows.push([t, 'Depot base', null, 'alert', 4, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, -268]);
  }
  return { grain: 'hour', days: 7, from: new Date(from).toISOString(), to: new Date(now).toISOString(), cols: COLS, rows };
}
// Bursts 26,880 at Hilltop and 3,388 at Depot: 30,268, of which 25,200 decoded.
const TOTAL = 30268, DECODED_PCT = '83.3%';

function month() {
  const from = Math.floor(now / DAY) * DAY - 29 * DAY, rows = [];
  for (let i = 0; i < 30; i++) rows.push([Math.round((from + i * DAY) / 1000), 'Hilltop base', 151.55, 'alert', 1200, 1000, 80, 20, 100, 0, 0, 0, 1080, 12960, 1200, -78000]);
  return { grain: 'day', days: 30, from: new Date(from).toISOString(), to: new Date(now).toISOString(), cols: COLS, rows };
}

// A fortnight by the day and today: 1,000 bursts a day, 90% decoded, then
// 1,200 a day, 80% decoded.
function fortnight() {
  const from = Math.floor(now / DAY) * DAY - 14 * DAY, rows = [];
  for (let i = 0; i < 15; i++) {
    const n = i < 7 ? 1000 : i < 14 ? 1200 : 100, dec = i < 7 ? 900 : i < 14 ? 960 : 80;
    rows.push([Math.round((from + i * DAY) / 1000), 'Hilltop base', 151.55, 'alert', n, dec, 0, 0, n - dec, 0, 0, 0, dec, dec * 12, n, -65 * n]);
  }
  return { grain: 'day', days: 15, from: new Date(from).toISOString(), to: new Date(now).toISOString(), cols: COLS, rows };
}

const LINK_COLS = ['base', 'protocol', 'address', 'channel', 'station_id', 'decoded', 'copies', 'relayed', 'snr_n', 'snr_sum', 'snr_min', 'snr_max', 'days', 'last_heard'];
const links = days => ({ days, cols: LINK_COLS, rows: [
  ['Hilltop base', 'alert2', 101, 151.5375, null, 400, 500, 0, 900, 18000, 10, 30, 7, Math.round(now / 1000)],
  ['Hilltop base', 'alert', 4021, 151.55, null, 300, 30, 0, 330, 3960, 6, 18, 7, Math.round(now / 1000)],
  ['Depot base', 'alert', 4021, 151.55, null, 200, 0, 0, 200, 1600, 3, 12, 7, Math.round(now / 1000)],
  ['Depot base', 'alert', 4500, 151.55, null, 50, 0, 0, 50, 450, 5, 12, 6, Math.round(now / 1000)],
] });

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const asked = [];

  async function open({ missing = false, width = 1440 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.origin}/index.html`, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof Telemetry !== 'undefined' && typeof switchTab === 'function', null, { timeout: LOAD_TIMEOUT });
    await page.exposeFunction('__asked', q => { asked.push(q); });
    await page.evaluate(({ missing, w, m, f, l7, l30 }) => {
      window.dbRpc = async (fn, args) => {
        window.__asked({ fn, args });
        if (missing) { const e = new Error('Could not find the function meganet.telemetry_traffic(p_days, p_hourly) in the schema cache'); e.status = 404; e.code = 'PGRST202'; throw e; }
        if (fn === 'telemetry_traffic') return args.p_days === 15 ? f : args.p_days === 30 ? m : w;
        if (fn === 'telemetry_links') return args.p_days === 30 ? l30 : l7;
        throw new Error('not stood in for: ' + fn);
      };
      window.__dl = null;
      window.dlText = (name, content) => { window.__dl = { name: floodnetName(name), content }; };
    }, { missing, w: week(), m: month(), f: fortnight(), l7: links(7), l30: links(30) });
    await page.evaluate(() => switchTab('telemetry'));
    return page;
  }
  const tiles = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.tm-tile')]
    .map(t => [t.querySelector('.tm-tile-l').textContent.trim(), t.querySelector('.tm-tile-n').textContent.trim()])));
  const settle = page => page.waitForFunction(() => Telemetry.state().phase === 'ready' && Telemetry.state().links != null, null, { timeout: 15000 }).catch(() => {});

  try {
    console.log('\n1. Before 0123 is applied');
    let page = await open({ missing: true });
    await page.waitForFunction(() => Telemetry.state().phase === 'error', null, { timeout: 15000 }).catch(() => {});
    const msg = await page.evaluate(() => document.querySelector('#main-content [role="alert"]')?.textContent || '');
    check('says the database does not have the summary yet, and which migration', /does not have the Telemetry summary yet \(migration 0123\)/.test(msg), msg);
    check('…and offers the demo', await page.evaluate(() => [...document.querySelectorAll('#main-content button')].some(b => /Show a demo/.test(b.textContent))));
    await page.evaluate(() => Telemetry.demo());
    const demo = await page.evaluate(() => ({ chip: !!document.querySelector('.tm-demo-chip'), says: /A demo:/.test(document.getElementById('tm-status')?.textContent || ''),
      charts: document.querySelectorAll('#main-content svg.tm-svg').length, bases: Telemetry.state().bases }));
    check('the demo says it is a demo, on made-up base stations', demo.chip && demo.says && demo.bases.every(b => /^Demo base/.test(b)), J(demo));
    check('…and draws every panel', demo.charts >= 10, J(demo));
    await page.context().close();

    console.log('\n2. A week by the hour');
    asked.length = 0;
    page = await open();
    await settle(page);
    check('asked for a week by the hour', asked.some(a => a.fn === 'telemetry_traffic' && a.args.p_days === 7 && a.args.p_hourly === true), J(asked));
    check('…the links for the week', asked.some(a => a.fn === 'telemetry_links' && a.args.p_days === 7), J(asked));
    await page.waitForFunction(() => document.querySelectorAll('#tm-wow-n rect').length > 0, null, { timeout: 15000 }).catch(() => {});
    check('…and a fortnight by the day for Week on week', asked.some(a => a.fn === 'telemetry_traffic' && a.args.p_days === 15 && a.args.p_hourly === false), J(asked));
    let t = await tiles(page);
    check(`the bursts add up (${TOTAL.toLocaleString('en-AU')})`, t['Bursts heard'] === '30.3k', J(t));
    check(`…and the decoded share (${DECODED_PCT})`, t['Decoded'] === DECODED_PCT, J(t));
    check('ALERT : ALERT2 by bursts', t['ALERT : ALERT2, % of bursts'] === '44 : 56', J(t));
    check('addresses heard, from the links', t['Addresses heard'] === '3', J(t));
    const drawn = await page.evaluate(() => ({
      bars: document.querySelectorAll('#tm-traffic .tm-hit').length,
      heatRows: [...document.querySelectorAll('#tm-heat text')].map(x => x.textContent).filter(x => /MHz|not known/.test(x)),
      multi: [...document.querySelectorAll('#tm-multi h3')].map(h => h.textContent),
      multiScale: [...document.querySelectorAll('#tm-multi svg')].map(s => [...s.querySelectorAll('text')].find(x => x.getAttribute('text-anchor') === 'end' && /\d/.test(x.textContent) && x.textContent !== '0')?.textContent),
      quality: [...document.querySelectorAll('#tm-quality-key li')].map(l => l.textContent.trim()),
    }));
    check('a bar an hour (168)', drawn.bars === 168, J(drawn.bars));
    check('the heat map has a row a channel, the unknown one last', J(drawn.heatRows) === J(['151.5375 MHz', '151.550 MHz', 'not known']), J(drawn.heatRows));
    check('a chart a base station, busiest first in the key, on one scale', J(drawn.multi) === J(['Depot base', 'Hilltop base']) && drawn.multiScale[0] === drawn.multiScale[1], J(drawn));
    check('the quality key names every outcome', J(drawn.quality) === J(['Decoded', 'Copy', 'Bit-flipped, set aside', 'Broken frame', 'Failed check', "Couldn't decode"]), J(drawn.quality));
    // Hover: the bar's numbers.
    const box = await page.evaluate(() => { const r = document.querySelectorAll('#tm-traffic .tm-hit')[100].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    const tip = await page.evaluate(() => ({ shown: !document.getElementById('tm-tip').hidden, text: document.getElementById('tm-tip').textContent, style: document.getElementById('tm-tip').getAttribute('style') || '' }));
    check('pointing at a bar shows its numbers', tip.shown && /ALERT2100/.test(tip.text.replace(/\s/g, '')) && /All180/.test(tip.text.replace(/[\s,]/g, '')), J(tip));
    check('…placed by tokens, not an inline style', /^--x: \d+px; --y: \d+px;?$/.test(tip.style.trim()), tip.style);

    console.log('\n3. ALERT and ALERT2, who hears what, the links');
    const cmp = await page.evaluate(() => [...document.querySelectorAll('#tm-compare tbody tr')].map(tr => [...tr.children].map(c => c.textContent.trim()).filter(Boolean)));
    const row = name => cmp.find(r => r[0] === name) || [];
    check('bursts side by side', J(row('Bursts heard')) === J(['Bursts heard', '13.5k', '16.8k']), J(row('Bursts heard')));
    check('…and how ALERT2 fails: broken frames', J(row('Broken frame')) === J(['Broken frame', '0.0%', '10.0%']), J(row('Broken frame')));
    check('…channels used', J(row('Channels used')) === J(['Channels used', '3', '1']), J(row('Channels used')));
    const who = await page.evaluate(() => ({
      head: [...document.querySelectorAll('#tm-who thead th')].map(h => h.textContent.trim()),
      depot: [...([...document.querySelectorAll('#tm-who tbody tr')].find(tr => /Depot/.test(tr.textContent))?.children || [])].map(c => c.textContent.trim()),
      only: document.getElementById('tm-only').textContent.replace(/\s+/g, ' ').trim(),
    }));
    check('a column a channel', J(who.head) === J(['Base station', '151.5375', '151.550', 'not known']), J(who.head));
    check('a dot where a base station heard nothing', who.depot[1] === '·' && who.depot[2] === '3,36075.0% decoded', J(who.depot));
    check('addresses only one base station hears, counted', /Depot base 1 · Hilltop base 1/.test(who.only), who.only);
    const weak = await page.evaluate(() => [...document.querySelectorAll('#tm-weak tbody tr')].map(tr => [...tr.children].map(c => c.textContent.trim())));
    check('the links near the edge, weakest first', weak.length === 2 && weak[0][0] === 'ALERT address 4021' && weak[0][2] === 'Depot base' && weak[0][3] === '8.0 dB', J(weak));
    check('…caught against the best-placed base station (200 of 330)', weak[0] && weak[0][5] === '60.6%', J(weak[0]));
    check('a dot a link on the scatter', await page.evaluate(() => document.querySelectorAll('#tm-scatter circle').length) === 4);
    const wow = await page.evaluate(() => [...document.querySelectorAll('#tm-wow-n text, #tm-wow-ok text')].map(x => x.textContent));
    check('Week on week: +20% bursts, −10 pts decoded', wow.includes('+20.0%') && wow.includes('−10.0 pts'), J(wow));

    console.log('\n4. The filters');
    await page.selectOption('#tm-base', 'Depot base');
    t = await tiles(page);
    check('one base station: its bursts only (3,388)', t['Bursts heard'] === '3,388', J(t));
    check('…the multiples down to that one', await page.evaluate(() => document.querySelectorAll('#tm-multi h3').length) === 1);
    await page.selectOption('#tm-base', 'all');
    await page.evaluate(() => Telemetry.filter('prot', 'alert2'));
    t = await tiles(page);
    check('ALERT2 only: 16,800 bursts, 90% decoded', t['Bursts heard'] === '16.8k' && t['Decoded'] === '90.0%', J(t));
    await page.evaluate(() => Telemetry.filter('prot', 'both'));
    await page.evaluate(() => Telemetry.set('split', 'c'));
    const key = await page.evaluate(() => [...document.querySelectorAll('#tm-traffic-key li')].map(l => l.textContent.trim()));
    check('split by channel: a colour a channel, busiest first', J(key) === J(['151.5375 MHz', '151.550 MHz', 'Channel not known']), J(key));
    const pressed = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Split by"] button')].map(b => b.getAttribute('aria-pressed')));
    check('…and its button says it is pressed', J(pressed) === J(['false', 'true', 'false', 'false']), J(pressed));

    console.log('\n5. The chart builder');
    await page.evaluate(() => { Telemetry.build('bm', 'okp'); Telemetry.build('bc', 'c'); Telemetry.build('bf', 'b'); });
    const b = await page.evaluate(() => ({ heads: [...document.querySelectorAll('#tm-builder h3')].map(h => h.textContent), lines: document.querySelectorAll('#tm-builder path.tm-line').length,
      key: [...document.querySelectorAll('#tm-builder-key li')].map(l => l.textContent.trim()) }));
    check('Decoded % by channel, side by side by base station', J(b.heads) === J(['Depot base', 'Hilltop base']) && b.lines >= 3, J(b));
    await page.evaluate(() => Telemetry.build('bv', 'table'));
    const tb = await page.evaluate(() => ({ cap: document.querySelector('#tm-builder caption')?.textContent, rows: document.querySelectorAll('#tm-builder tbody tr').length,
      wrap: !!document.querySelector('#tm-builder .table-wrap[role="region"][tabindex="0"]') }));
    check('…and as a table, a row a side and an hour, in a scrolling region', tb.cap === 'Decoded %' && tb.rows === 336 && tb.wrap, J(tb));
    await page.evaluate(() => Telemetry.exportCsv());
    const dl = await page.evaluate(() => window.__dl);
    check('its CSV is named floodnet-… and has the columns', dl && /^floodnet-telemetry-okp-\d{4}-\d\d-\d\d\.csv$/.test(dl.name) && /^side,along,151\.5375 MHz,151\.550 MHz/.test(dl.content), dl && dl.name + ' ' + dl.content.slice(0, 80));
    await page.evaluate(() => { Telemetry.build('bv', 'chart'); Telemetry.build('bc', 'o'); });
    const off = await page.evaluate(() => ({ bc: Telemetry.state().bc, note: document.getElementById('tm-bnote').textContent, hidden: document.getElementById('tm-bnote').hidden }));
    check('outcome colours on a percentage are turned off, with a note', off.bc === 'none' && !off.hidden && /Outcome colours split Bursts only/.test(off.note), J(off));

    console.log('\n6. The page');
    const words = await page.evaluate(() => {
      const terms = [...document.querySelectorAll('#main-content .term')];
      return { n: terms.length, bare: terms.filter(x => (x.title || '').length < 20).map(x => x.textContent), fold: document.querySelectorAll('.tm-words dt').length,
        inline: [...document.querySelectorAll('#main-content [style]')].map(e => e.getAttribute('style')).filter(s => !s.split(';').map(d => d.trim()).filter(Boolean).every(d => /^--[\w-]+\s*:/.test(d))) };
    });
    check('every marked word carries its meaning', words.n > 20 && !words.bare.length, J(words.bare));
    check('…and the fold lists them for a finger', words.fold >= 20, J(words.fold));
    check('no inline style but a token', !words.inline.length, J(words.inline.slice(0, 3)));
    await page.evaluate(() => Telemetry.filter('base', 'Depot base'));
    asked.length = 0;
    await page.evaluate(() => Telemetry.setDays(30));
    await settle(page);
    check('thirty days asked by the day', asked.some(a => a.fn === 'telemetry_traffic' && a.args.p_days === 30 && a.args.p_hourly === false), J(asked));
    const s30 = await page.evaluate(() => Telemetry.state());
    check('…a bar a day', s30.grain === 'day' && s30.nb === 30, J({ grain: s30.grain, nb: s30.nb }));
    check('a base station the window does not hold is let go, with a note', s30.base === 'all' && /Depot base heard nothing in this window/.test(s30.note), J({ base: s30.base, note: s30.note }));
    await page.context().close();

    console.log('\n7. At a phone\'s width');
    page = await open({ width: 390 });
    await settle(page);
    const wide = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: window.innerWidth }));
    check('nothing scrolls the page sideways', wide.sw <= wide.iw + 1, J(wide));
    await page.context().close();

    check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
  const bad = results.filter(r => !r.ok);
  console.log(`\n${bad.length ? 'FAIL' : 'PASS'} — ${results.length - bad.length} of ${results.length}`);
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
