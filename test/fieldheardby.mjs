// Field Data's "Heard by": only the readings one receiver heard.
//
// A raw reading names the path of the copy that was stored (`path`) and the
// paths of the copies that landed after it (`dup_paths`). The filter keeps a
// reading when the receiver typed — a Pi, named as a path names it without the
// stick and frequency — is on either, so a base station whose copies land
// second is not drawn as having heard nothing. What this proves:
//
//   - the rows drawn are that receiver's, first or as a later copy, and a
//     receiver whose name only starts the same is not taken for it;
//   - the series says so in its label and its note, with the share;
//   - it stands beside the load for every receiver rather than replacing it;
//   - a window that would be drawn from a rollup is refused with a sentence,
//     because a rollup does not say who heard what;
//   - a receiver nothing came by says who did hear the readings.
//
//   node --run fieldheardby      (or: npm run fieldheardby)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: 60000 });

  const out = await page.evaluate(async () => {
    const A = window.ArroData;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const ADDR = 'a:64001';
    const MINE = 'serial-monitor/rpi-0a0b0c0d', OTHER = 'serial-monitor/rpi-ffff0000-sdr0';
    const now = Date.now();
    // Ten readings five minutes apart: this receiver first with four, a later
    // copy on three, absent from two, and one by a receiver named almost alike.
    const how = ['first', 'first', 'copy', 'none', 'first', 'copy', 'alike', 'none', 'copy', 'first'];
    const rows = how.map((h, i) => ({
      addr: ADDR, station_id: null, unit: null,
      reading_ts: new Date(now - (how.length - i) * 300000).toISOString(),
      received_at: new Date(now - (how.length - i) * 300000 + 2000).toISOString(),
      value_raw: 100 + i, value: null, quality: 0,
      path: h === 'first' ? `${MINE}-sdr1-152.400` : h === 'alike' ? `${MINE}9-sdr1-152.400` : OTHER,
      dup_count: h === 'copy' ? 1 : 0,
      dup_paths: h === 'copy' ? [`${MINE}-sdr2-151.5375`] : [],
    }));
    const asked = [];
    window.dbSelect = async q => {
      if (/^quality\?/.test(q)) return [{ code: 0, key: 'good' }];
      // The base stations by name (0115): Hill Base has had two Pis.
      if (/^base_station_name\?/.test(q)) return [
        { name: 'Hill Base', receiver: 'serial-monitor/rpi-0a0b0c0d', station_id: null },
        { name: 'Hill Base', receiver: 'serial-monitor/rpi-0a0b0c0d9', station_id: null },
        { name: 'Other Base', receiver: 'serial-monitor/rpi-ffff0000', station_id: null },
      ];
      if (/^reading(_hourly|_daily)?\?/.test(q)) { asked.push(q); return /^reading\?/.test(q) ? rows : []; }
      return [];
    };
    const run = async () => { A.fieldRun(); for (let i = 0; i < 80 && A.ad.fq.loading; i++) await wait(25); await wait(30); };
    const seriesOut = () => A.ad.series.filter(s => s.prov && s.prov.addr === ADDR)
      .map(s => ({ label: s.label, n: s.n, rx: s.prov.rx || '', warn: (s.warn || []).join(' | '), v: Array.from(s.v || []) }));

    switchTab('field');
    await wait(80);
    A.fieldSetDate('extra', ADDR);
    A.fieldSetWindow('24h');
    const log = { box: !!document.getElementById('ad-field-rx') };

    await run();
    log.all = seriesOut();
    log.offered = [...document.querySelectorAll('#ad-field-rx-list option')].map(o => o.value);

    A.fieldSetRx('rpi-0a0b0c0d');
    await run();
    log.both = seriesOut();

    A.fieldSetRx('hill base');
    await run();
    log.named = seriesOut().find(s => /heard by Hill Base$/.test(s.label)) || null;

    A.fieldSetRx('rpi-nobody');
    await run();
    log.nobody = A.ad.fq.empty;
    log.afterNobody = seriesOut().length;

    A.fieldSetRx('rpi-0a0b0c0d');
    A.fieldSetWindow('90d');
    const before = asked.length;
    await run();
    log.refused = A.ad.fq.error;
    log.askedWhenRefused = asked.length - before;
    return log;
  });

  const mine = (out.both || []).find(s => s.rx);
  const every = (out.both || []).find(s => !s.rx);
  ok('the picker has a Heard by box', out.box);
  ok('a load with it empty draws every reading', out.all.length === 1 && out.all[0].n === 10, JSON.stringify(out.all));
  ok('the box offers the base stations by name, each once, and no codes for them',
    out.offered.join('|') === 'Hill Base|Other Base', out.offered.join(', '));
  ok('with a receiver typed, only what it heard is drawn — first, or as a later copy',
    mine && mine.n === 7 && mine.v.join(',') === '100,101,102,104,105,108,109', JSON.stringify(mine));
  ok('a receiver whose name only starts the same is not taken for it', mine && !mine.v.includes(106));
  ok('the series says whose it is, and its share', mine && /heard by Hill Base \(rpi-0a0b0c0d\)/.test(mine.label)
    && /7 of the 10/.test(mine.warn) && /first with 4/.test(mine.warn) && /other 3/.test(mine.warn), mine && `${mine.label} — ${mine.warn}`);
  ok('it stands beside the load for every receiver', every && every.n === 10 && out.both.length === 2, JSON.stringify(out.both.map(s => s.label)));
  ok('a receiver nothing came by says who did hear the readings', /rpi-nobody/.test(out.nobody) && /Other Base/.test(out.nobody) && !/rpi-ffff0000/.test(out.nobody)
    && out.afterNobody === 3, out.nobody);
  ok('a base station\'s name stands for every receiver it has had', out.named && out.named.n === 8 && out.named.v.includes(106), JSON.stringify(out.named));
  ok('a window drawn from a rollup is refused with a sentence, and nothing is asked',
    /Only raw readings say which receiver/.test(out.refused) && out.askedWhenRefused === 0, `${out.refused} (${out.askedWhenRefused} asked)`);
  ok('no page errors for the whole run', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close?.();
}

console.log(failures ? `\nFAIL — ${failures} assertion(s).\n`
  : '\nPASS — Heard by draws one receiver\'s readings, first or as a later copy, beside everybody\'s, and says what it left out.\n');
process.exit(failures ? 1 : 0);
