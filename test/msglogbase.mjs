// The Message Log's base stations by name (message-log.js), in a real browser.
//
// A reading's path names the receiver that took it in —
// "serial-monitor/rpi-83071968-sdr1-151.5375" — which nobody says aloud. The
// receivers say whose they are (ingest_point_latest, 0045), so the log offers
// a **Base station** filter by name under More filters and the Path column
// says the name. The list is the editors' to read: with none, neither is there.
//
//   1. With the list answered: the filter lists each base once, by name, with
//      the station it stands at; the Path column says the name and which
//      receiver, with the path as kept on hover; a path no base owns stays as
//      it is kept.
//   2. Picking a base asks the datastore for that base's paths only, inside
//      the time window, and "any" takes the filter off.
//   3. With the list refused (not an editor): no filter, paths as kept, and
//      the log still loads.
//
// Run:  npm run msglogbase

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

const POINTS = [
  { token_label: 'Hilltop base', point_id: 'rpi-83071968-sdr1-151.5375', host_station_id: null },
  { token_label: 'Hilltop base', point_id: 'rpi-83071968-sdr2-152.4000', host_station_id: null },
  { token_label: 'Depot base',   point_id: 'rpi-6dfef7f4-sdr1',          host_station_id: null },
];
const now = Date.now();
const row = (i, path) => ({
  id: 1000 + i, reading_ts: new Date(now - i * 60000).toISOString(), received_at: new Date(now - i * 60000).toISOString(),
  station_id: null, alert_id: 4000 + i, station_number: null, channel: null, sensor_type: null,
  value_raw: 100 + i, value: null, unit: null, conversion: null, quality: 0, protocol: 1, source: 5, path,
  dup_count: 0, dup_paths: [], freq_mhz: 151.5375, rssi_dbm: null, level_dbfs: -55.1, snr_db: 9.9,
});
const ROWS = [
  row(1, 'serial-monitor/rpi-83071968-sdr1-151.5375'),
  row(2, 'serial-monitor/rpi-6dfef7f4-sdr1'),
  row(3, 'serial-monitor/laptop-quansheng'),
];

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const asked = [];

  async function open(editor) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${server.origin}/index.html`, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== "undefined" && state.data && typeof MessageLog !== 'undefined', null, { timeout: LOAD_TIMEOUT });
    await page.exposeFunction('__asked', q => { asked.push(q); });
    // The datastore, stood in for: the receivers' list (or a refusal), and
    // the readings — every question recorded as it was asked.
    await page.evaluate(({ points, rows, editor }) => {
      window.dbSelect = async q => {
        window.__asked(q);
        if (q.startsWith('ingest_point_latest')) { if (!editor) throw new Error('permission denied'); return points; }
        if (q.startsWith('reading?')) return /path=like|or=\(path\.like/.test(q) ? rows.slice(0, 1) : rows;
        return [];
      };
    }, { points: POINTS, rows: ROWS, editor });
    await page.evaluate(() => switchTab('msglog'));
    await page.waitForFunction(() => document.querySelectorAll('#main-content table tbody tr').length >= 3, null, { timeout: LOAD_TIMEOUT });
    return page;
  }
  const filter = page => page.evaluate(() => {
    const lab = [...document.querySelectorAll('.ml-more .ml-f')].find(l => /^Base station/.test(l.textContent.trim()));
    return lab ? [...lab.querySelectorAll('option')].map(o => o.textContent.trim()) : null;
  });
  const cells = page => page.evaluate(() => {
    const heads = [...document.querySelectorAll('#main-content table thead th')].map(h => h.textContent.trim());
    const i = heads.findIndex(h => /^Path/.test(h));
    return [...document.querySelectorAll('#main-content table tbody tr')].map(tr => tr.children[i])
      .filter(Boolean).map(td => ({ text: td.textContent.trim().replace(/\s+/g, ' '), title: td.title || '' }));
  });

  try {
    console.log('\n1. An editor: the bases by name');
    let page = await open(true);
    await page.waitForFunction(() => /Base station/.test(document.querySelector('.ml-more')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const opts = await filter(page);
    check('More filters has a Base station filter, each base once', J(opts) === J(['any', 'Depot base', 'Hilltop base']), J(opts));
    let c = await cells(page);
    check('the Path column says the base\'s name and which receiver', c[0] && c[0].text === 'Hilltop base sdr1-151.5375' && c[1].text === 'Depot base sdr1', J(c));
    check('…with the path as it is kept on hover', c[0] && /path serial-monitor\/rpi-83071968-sdr1-151\.5375/.test(c[0].title), c[0] && c[0].title);
    check('a path no base owns stays as it is kept', c[2] && c[2].text === 'serial-monitor/laptop-quansheng', J(c[2]));

    console.log('\n2. Picking a base');
    asked.length = 0;
    await page.evaluate(() => {
      const lab = [...document.querySelectorAll('.ml-more .ml-f')].find(l => /^Base station/.test(l.textContent.trim()));
      const s = lab.querySelector('select'); s.value = 'Hilltop base'; s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#main-content table tbody tr').length === 1, null, { timeout: 15000 }).catch(() => {});
    const q = asked.filter(x => x.startsWith('reading?')).pop() || '';
    check('asks for that base\'s paths only', /path=like\.serial-monitor%2Frpi-83071968\*/.test(q), q);
    check('…inside the time window', /reading_ts=gte\./.test(q) && /reading_ts=lt\./.test(q), q);
    asked.length = 0;
    await page.evaluate(() => MessageLog.setText('base', ''));
    await page.waitForFunction(() => document.querySelectorAll('#main-content table tbody tr').length >= 3, null, { timeout: 15000 }).catch(() => {});
    const q2 = asked.filter(x => x.startsWith('reading?')).pop() || '';
    check('"any" takes the filter off', q2 && !/path/.test(q2.split('select=')[0]), q2);
    await page.context().close();

    console.log('\n3. Not an editor: no list');
    page = await open(false);
    check('no Base station filter', (await filter(page)) === null);
    c = await cells(page);
    check('paths as they are kept, and the log still loads', c.length === 3 && c[0].text === 'serial-monitor/rpi-83071968-sdr1-151.5375', J(c));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
  const bad = results.filter(r => !r.ok).length;
  console.log(`\n${bad ? 'FAIL' : 'PASS'} — ${results.length - bad} of ${results.length} checks.`);
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
