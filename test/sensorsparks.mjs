// The station editor's sparklines (sensor-sparks.js): a line on every sensor
// row — the last seven days of what that row's address has sent — that opens
// a chart of it, and the chart's door onto the Field Data tab.
//
// The datastore is stood in for at `dbSelect`, the one function that talks to
// it, with a week whose answer is known, generated in the page for Loudoun Br
// AL's four rows (6128 Rainfall and Rainfall Increment, 6129 Water Level,
// 6130 Battery):
//
//   battery   133 ± 5 raw through each day — 12.8 to 13.8 V, raw ÷ 10.
//   rain      the counter at 2040, wrapping past 2047 to 0 in a storm three
//             days ago that tips 50 times, with one corrupted frame (a bit
//             flipped, 1,024 tips that never fell) in the middle of it — so
//             the right answer is 10.0 mm at the assumed 0.2 mm a tip, and a
//             line that read the counter would show neither the wrap nor the
//             flip as rain.
//   level     300 raw, rising to 420 in the storm — a raw count, said so.
//
// And the two kinds of corrupted frame the live datastore holds on these
// addresses, each the last reading of its hour so the rollups keep it too: a
// battery at 163.1 V (1631 raw) two days ago, and a level of 164 a day ago —
// 420 with one bit flipped. Both left out, as Station Health leaves them out,
// and counted where the chart says how it was drawn.
//
// Then the things that matter about the row: one load for the station, not
// one per row; a redraw that asks nothing again; a row retyped to an address
// with no readings saying "nothing" rather than keeping the old line; a new
// row with no address disabled. The dialog: its windows, the request each one
// makes (raw to a week, the hourly rollups and a raw tail beyond), a reading
// under the arrow keys, the table, and Open in Field Data landing on that tab
// with the address, the station and the window. No sideways scroll at 375 px.
//
//   npm run sensorsparks

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const STATION = 'loudoun_br_al';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}${VERBOSE && detail ? `  (${detail})` : ''}`); return; }
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
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // ── the datastore, stood in for ─────────────────────────────────────────
  await page.evaluate(() => {
    const HOUR = 3600000, DAY = 86400000;
    const now = Date.now();
    const storm = now - 3 * DAY;
    const series = {};
    // Every 15 minutes for 100 days.
    for (let t = now - 100 * DAY; t <= now - 60000; t += 15 * 60000) {
      const day = Math.sin(2 * Math.PI * (t % DAY) / DAY);
      (series['a:6130'] || (series['a:6130'] = [])).push({ t, raw: Math.round(133 + 5 * day) });
      const into = Math.max(0, Math.min(1, (t - storm) / (6 * HOUR)));
      (series['a:6129'] || (series['a:6129'] = [])).push({ t, raw: Math.round(300 + 120 * into) });
      // 2040 + 50 tips across the storm, wrapping at 2048.
      let c = (2040 + Math.round(50 * into)) % 2048;
      // One frame with bit 10 flipped, mid-storm.
      if (Math.abs(t - (storm + 3 * HOUR)) < 7 * 60000) c ^= 1024;
      (series['a:6128'] || (series['a:6128'] = [])).push({ t, raw: c });
    }
    const lastOfHour = t => Math.floor(t / HOUR) * HOUR + HOUR - 1000;
    series['a:6130'].push({ t: lastOfHour(now - 2 * DAY), raw: 1631 });
    series['a:6129'].push({ t: lastOfHour(now - DAY), raw: 420 ^ 256 });
    Object.values(series).forEach(list => list.sort((a, b) => a.t - b.t));
    const log = window.__sspk = { queries: [] };
    const wanted = q => {
      const m = q.match(/addr=in\.\(([^)]*)\)/);
      return m ? decodeURIComponent(m[1]).split(',').map(s => s.replace(/"/g, '')) : [];
    };
    const from = (q, col) => {
      const m = q.match(new RegExp(`${col}=gte\\.([^&]+)`));
      return m ? Date.parse(decodeURIComponent(m[1])) : 0;
    };
    const page = (rows, q) => {
      const lim = +(q.match(/limit=(\d+)/) || [])[1] || rows.length;
      const off = +(q.match(/offset=(\d+)/) || [])[1] || 0;
      return rows.slice(off, off + lim);
    };
    const roll = (addr, pts, size) => {
      const out = new Map();
      pts.forEach(p => {
        const b = size === DAY ? new Date(new Date(p.t).toDateString()).getTime() : Math.floor(p.t / size) * size;
        const r = out.get(b) || { addr, bucket: new Date(b).toISOString(), n: 0 };
        r.n++; r.raw_last = p.raw; r.last_ts = new Date(p.t).toISOString(); r.val_last = null; r.unit = 'count';
        out.set(b, r);
      });
      return [...out.values()];
    };
    window.dbSelect = async q => {
      log.queries.push(q);
      const addrs = wanted(q);
      if (/^reading\?/.test(q)) {
        const t0 = from(q, 'reading_ts');
        const rows = addrs.flatMap(a => (series[a] || []).filter(p => p.t >= t0).map(p => ({
          addr: a, reading_ts: new Date(p.t).toISOString(), value_raw: p.raw, value: null, unit: 'count',
        })));
        return page(rows, q);
      }
      if (/^reading_(hourly|daily)\?/.test(q)) {
        const daily = /^reading_daily/.test(q);
        const lo = from(q, 'bucket');
        const rows = addrs.flatMap(a => roll(a, series[a] || [], daily ? DAY : HOUR))
          .filter(r => Date.parse(r.bucket) >= lo - (daily ? DAY : 0));
        return page(rows, q);
      }
      if (/^quality\?/.test(q)) return [{ code: 0, key: 'good' }];
      return [];
    };
  });

  await page.evaluate(() => switchTab('stations'));
  await page.waitForTimeout(300);

  // ── 1. the rows ──────────────────────────────────────────────────────────
  console.log('\nThe rows — one line each, one load for the station\n');
  await page.evaluate(id => { window.__sspk.queries.length = 0; selectStation(id); }, STATION);
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('#ef-sensors .sensor-spark')];
    return b.length && b.every(x => !x.querySelector('.sspk-wait'));
  }, null, { timeout: 10000 });

  const rows = await page.evaluate(() => [...document.querySelectorAll('#ef-sensors .sensor-row')].map(r => {
    const b = r.querySelector('.sensor-spark');
    return {
      type: r.querySelector('.sensor-type').value,
      addr: r.dataset.addr,
      disabled: b.disabled,
      label: b.getAttribute('aria-label'),
      val: b.querySelector('.sspk-val')?.textContent.trim(),
      line: !!b.querySelector('path.sspk-line'),
      bars: b.querySelectorAll('rect.sspk-bar').length,
      // The slot sits after the type and before the actions.
      order: [...r.children].map(c => c.className.split(' ')[0]).join(','),
    };
  }));
  // Only this file's own requests: the card's other sections ask too.
  const mine = q => /^reading_(hourly|daily)\?/.test(q) || /^reading\?.*select=addr,reading_ts,value_raw,value,unit/.test(q);
  const q1 = (await page.evaluate(() => window.__sspk.queries.slice())).filter(mine);
  const by = t => rows.find(r => r.type === t) || {};
  if (VERBOSE) console.log(rows, q1);

  ok('every row has a line slot, between the type and the actions',
    rows.length === 4 && rows.every(r => /sensor-type,sensor-spark,sensor-acts/.test(r.order)), rows.map(r => r.order).join(' | '));
  ok('one load for the whole station: the hourly rollups and the raw tail, once each',
    q1.filter(q => /^reading_hourly\?/.test(q)).length === 1 && q1.filter(q => /^reading\?/.test(q)).length === 1, q1.join('\n         '));
  ok('…for its three addresses, the shared rain address once',
    q1.length === 2 && q1.every(q => /addr=in\.\(a%3A6128,a%3A6129,a%3A6130\)/.test(q.replace(/%22/g, ''))), q1[0]);
  ok('…over seven days', (() => {
    const m = (q1.find(q => /^reading_hourly/.test(q)) || '').match(/bucket=gte\.([^&]+)/);
    const d = m ? (Date.now() - Date.parse(decodeURIComponent(m[1]))) / 86400000 : 0;
    return d > 6.9 && d < 7.1;
  })());
  ok('the battery in volts, raw ÷ 10', /^1[23]\.\d V$/.test(by('Battery').val || '') && by('Battery').line, by('Battery').val);
  ok('…and its name says the latest and the range',
    /Battery, ALERT 6130: 1[23]\.\d V at .+; 1[23]\.\d V to 1[34]\.\d V over the last 7 days/.test(by('Battery').label || ''), by('Battery').label);
  ok('the rain gauge: the rain that fell, its wrap undone and the flipped frame left out — 10 mm',
    by('Rainfall').val === '10 mm' && by('Rainfall').line, by('Rainfall').val);
  ok('…said in words', /10 mm of rain in the last 7 days/.test(by('Rainfall').label || ''), by('Rainfall').label);
  ok('the increment row on the same address: bars, the same 10 mm',
    by('Rainfall Increment').bars > 0 && !by('Rainfall Increment').line && by('Rainfall Increment').val === '10 mm',
    `${by('Rainfall Increment').bars} bars, ${by('Rainfall Increment').val}`);
  ok('the level as a raw count, and saying so', /^420\s*raw$/.test(by('Water Level').val || ''), by('Water Level').val);
  ok('a 163.1 V battery frame and a flipped level frame left out of the lines',
    / 12\.8 V to 13\.8 V /.test(by('Battery').label || '') && / 300 to 420 /.test(by('Water Level').label || ''),
    `${by('Battery').label} | ${by('Water Level').label}`);

  // ── 2. redrawing, retyping, adding ──────────────────────────────────────
  console.log('\nRedrawn, retyped and added\n');
  const again = await page.evaluate(async () => {
    window.__sspk.queries.length = 0;
    rerenderStationEditorCard();
    await new Promise(r => setTimeout(r, 200));
    return {
      queries: window.__sspk.queries.filter(q => /^reading_hourly|value_raw,value,unit/.test(q)).length,
      drawn: document.querySelectorAll('#ef-sensors .sensor-spark path.sspk-line').length,
    };
  });
  ok('a redraw of the card asks the datastore nothing again', again.queries === 0 && again.drawn === 3, JSON.stringify(again));

  const retyped = await page.evaluate(async () => {
    window.__sspk.queries.length = 0;
    const row = [...document.querySelectorAll('#ef-sensors .sensor-row')].find(r => r.querySelector('.sensor-type').value === 'Battery');
    const box = row.querySelector('.sensor-aid');
    box.value = '9999';
    box.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40 && row.querySelector('.sspk-wait'); i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 50));
    const b = row.querySelector('.sensor-spark');
    return {
      addr: row.dataset.addr, asked: window.__sspk.queries.some(q => /a%3A9999/.test(q.replace(/%22/g, ''))),
      line: !!b.querySelector('path.sspk-line'), val: b.querySelector('.sspk-val').textContent.trim(),
      none: b.classList.contains('sensor-spark--none'), label: b.getAttribute('aria-label'),
    };
  });
  ok('a row retyped to another address reads that address',
    retyped.addr === 'a:9999' && retyped.asked, JSON.stringify(retyped));
  ok('…and with nothing there, says nothing rather than keeping the old line',
    !retyped.line && retyped.val === '—' && retyped.none && /nothing in the last 7 days/.test(retyped.label), retyped.label);

  const added = await page.evaluate(() => {
    editorAddSensorRow();
    const row = document.querySelector('#ef-sensors .sensor-row:last-child');
    const b = row.querySelector('.sensor-spark');
    return { disabled: b.disabled, label: b.getAttribute('aria-label') };
  });
  ok('a new row with no address has its slot, disabled, saying why', added.disabled && /no address/.test(added.label), added.label);

  // Back to the record as stored.
  await page.evaluate(id => { selectStation(id); selectStation(id); }, STATION);
  await page.waitForFunction(() => document.querySelectorAll('#ef-sensors .sensor-spark path.sspk-line').length === 3,
    null, { timeout: 10000 });

  // ── 3. the dialog ───────────────────────────────────────────────────────
  console.log('\nThe chart it opens\n');
  await page.evaluate(() => { window.__sspk.queries.length = 0; });
  const battBtn = page.locator('#ef-sensors .sensor-row', { has: page.locator('.sensor-type[value="Battery"]') }).locator('.sensor-spark');
  await battBtn.click();
  await page.waitForSelector('#app-modal .sspk-chart', { timeout: 10000 });
  const d1 = await page.evaluate(() => ({
    title: document.getElementById('app-modal-title')?.textContent,
    wins: [...document.querySelectorAll('#app-modal .sspk-wins [data-win]')].map(b => `${b.dataset.win}:${b.getAttribute('aria-pressed')}`),
    name: document.querySelector('#app-modal .sspk-chart')?.getAttribute('aria-label'),
    role: document.querySelector('#app-modal .sspk-chart')?.getAttribute('role'),
    yTicks: document.querySelectorAll('#app-modal .sspk-tick').length,
    line: !!document.querySelector('#app-modal path.sspk-line'),
    queries: window.__sspk.queries.filter(q => /^reading_(hourly|daily)\?|value_raw,value,unit/.test(q)),
    read: document.getElementById('sspk-read')?.textContent,
    door: document.querySelector('#app-modal .sspk-foot button')?.textContent.trim(),
  }));
  if (VERBOSE) console.log(d1);
  ok('the dialog is named for the row: its type and its address', d1.title === 'Battery — ALERT 6130', d1.title);
  ok('five windows, seven days pressed',
    d1.wins.join(',') === '24h:false,7d:true,30d:false,90d:false,12mo:false', d1.wins.join(','));
  ok('a week is every reading: the raw readings at that one address, and no rollup',
    d1.queries.length >= 1 && d1.queries.every(q => /^reading\?/.test(q) && /a%3A6130/.test(q.replace(/%22/g, ''))
      && !/6128|6129/.test(q)), d1.queries.join('\n         '));
  ok('the chart is a picture whose name carries the numbers',
    d1.role === 'img' && /Battery, ALERT 6130: 1[23]\.\d V at .+; .+ over the last 7 days/.test(d1.name || ''), d1.name);
  ok('…drawn, with its axes labelled', d1.line && d1.yTicks >= 6, `${d1.yTicks} tick labels`);
  ok('the readout starts at the latest', /the latest\)$/.test(d1.read || ''), d1.read);
  ok('and how it was drawn counts what was left out',
    /1 that cannot be a 12 V battery left out, as Station Health leaves them out/.test(
      await page.evaluate(() => document.querySelector('#app-modal .sspk-how')?.textContent || '')));
  ok('and the door says where it goes', /Open in Field Data/.test(d1.door || ''), d1.door);
  ok('…with no warning about unsaved edits while the card holds none',
    !(await page.evaluate(() => !!document.querySelector('#app-modal .sspk-unsaved'))));

  await page.focus('#app-modal .sspk-stage');
  await page.keyboard.press('Home');
  const home = await page.evaluate(() => document.getElementById('sspk-read')?.textContent);
  await page.keyboard.press('ArrowRight');
  const next = await page.evaluate(() => document.getElementById('sspk-read')?.textContent);
  await page.keyboard.press('End');
  const end = await page.evaluate(() => document.getElementById('sspk-read')?.textContent);
  ok('the arrow keys walk the readings — Home the first, End the latest',
    home && !/latest/.test(home) && next !== home && /the latest\)$/.test(end || ''), `${home} / ${next} / ${end}`);

  const table = await page.evaluate(() => {
    const t = document.querySelector('#app-modal .sspk-data');
    t.open = true;
    return { summary: t.querySelector('summary').textContent, rows: t.querySelectorAll('tbody tr').length,
             capped: /The newest 200 of/.test(t.textContent), head: [...t.querySelectorAll('th')].map(th => th.textContent).join('|') };
  });
  ok('the readings as a table one press away, newest 200 and saying so',
    /readings, as a table/.test(table.summary) && table.rows === 200 && table.capped && table.head === 'When|Value|Raw count', JSON.stringify(table));

  await page.evaluate(() => { window.__sspk.queries.length = 0; });
  await page.click('#app-modal .sspk-wins [data-win="30d"]');
  await page.waitForFunction(() => document.querySelector('#app-modal [data-win="30d"]')?.getAttribute('aria-pressed') === 'true'
    && !!document.querySelector('#app-modal .sspk-chart'), null, { timeout: 10000 });
  const d30 = await page.evaluate(() => ({
    queries: window.__sspk.queries.filter(q => /^reading_(hourly|daily)\?|value_raw,value,unit/.test(q)),
    name: document.querySelector('#app-modal .sspk-chart')?.getAttribute('aria-label'),
    how: document.querySelector('#app-modal .sspk-how')?.textContent,
  }));
  ok('thirty days: the hourly rollups, and the raw readings after them',
    d30.queries.some(q => /^reading_hourly\?/.test(q)) && d30.queries.some(q => /^reading\?/.test(q)), d30.queries.join('\n         '));
  ok('…and it says so', /end of each hour/.test(d30.how || '') && /over the last 30 days/.test(d30.name || ''), d30.how);

  // The rain gauge's dialog: bars on the increment row.
  await page.keyboard.press('Escape');
  const incBtn = page.locator('#ef-sensors .sensor-row', { has: page.locator('.sensor-type[value="Rainfall Increment"]') }).locator('.sensor-spark');
  await incBtn.click();
  await page.waitForSelector('#app-modal .sspk-chart', { timeout: 10000 });
  // A week in the dialog is every reading, so it sees the flipped frame the
  // hourly rollups never kept (it was not the last of its hour) — and
  // HealthAnalysis.rainOf counts nothing across a frame it throws out, so the
  // few tips that quarter hour are lost rather than 1,024 gained: 9.2 mm, not
  // 10, and nowhere near the 214 mm the flip would have been.
  const rain = await page.evaluate(() => {
    const t = document.querySelector('#app-modal .sspk-data'); t.open = true;
    return {
      bars: document.querySelectorAll('#app-modal rect.sspk-bar').length,
      name: document.querySelector('#app-modal .sspk-chart')?.getAttribute('aria-label'),
      sum: [...t.querySelectorAll('tbody tr td:last-child')].reduce((a, td) => a + parseFloat(td.textContent), 0),
      head: [...t.querySelectorAll('th')].map(th => th.textContent).join('|'),
    };
  });
  const said = parseFloat(((rain.name || '').match(/: ([\d.]+) mm of rain in the last 7 days/) || [])[1]);
  ok('the increment row\'s chart: the rain in each hour, the wrap undone and the flip not counted',
    rain.bars > 1 && said >= 9 && said <= 10, `${rain.bars} bars — ${rain.name}`);
  ok('…its table the hours with rain, adding up to what it says',
    rain.head === 'From|Rain' && Math.abs(rain.sum - said) < 0.01, `${rain.head}, ${rain.sum}`);
  await page.keyboard.press('Escape');

  // ── 4. the door ─────────────────────────────────────────────────────────
  console.log('\nOpen in Field Data\n');
  // An edit not saved: the card goes gold (editorUnsavedRefresh), and the
  // dialog says the door would leave it behind. Put back before going on.
  const warned = await page.evaluate(async () => {
    const box = document.getElementById('ef-name');
    const was = box.value;
    box.value = was + ' (edited)';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('#ef-sensors .sensor-row')]
      .find(r => r.querySelector('.sensor-type').value === 'Battery').querySelector('.sensor-spark');
    btn.click();
    const said = document.querySelector('#app-modal .sspk-unsaved')?.textContent || '';
    Modal.close();
    box.value = was;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return said;
  });
  ok('with an edit not saved, the dialog says the door leaves it behind',
    /changes not saved yet — going there leaves them behind/.test(warned), warned);
  await battBtn.click();
  await page.waitForSelector('#app-modal .sspk-chart', { timeout: 10000 });
  await page.click('#app-modal .sspk-wins [data-win="30d"]');
  await page.waitForFunction(() => document.querySelector('#app-modal [data-win="30d"]')?.getAttribute('aria-pressed') === 'true');
  await page.click('#app-modal .sspk-foot button.primary');
  await page.waitForFunction(() => state.activeTab === 'field' && ArroData.ad.series.length > 0, null, { timeout: 10000 });
  const field = await page.evaluate(() => {
    const q = ArroData.ad.fq;
    const m = document.getElementById('app-modal');
    return {
      tab: state.activeTab, station: q.stationId, sensors: q.sensors.join(','), extra: q.extra, win: q.win,
      series: ArroData.ad.series.map(s => s.prov && s.prov.addr).join(','),
      closed: !m || m.style.display === 'none',
    };
  });
  ok('the dialog closes and the Field Data tab opens', field.closed && field.tab === 'field', JSON.stringify(field));
  ok('…on the station, that address ticked, over the window the dialog was showing',
    field.station === STATION && field.sensors === 'a:6130' && !field.extra && field.win === '30d', JSON.stringify(field));
  ok('…and drawn', field.series === 'a:6130', field.series);

  // ── 5. on a phone ───────────────────────────────────────────────────────
  console.log('\nAt 375 px\n');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.evaluate(id => { switchTab('stations'); state.selectedId = null; selectStation(id); }, STATION);
  await page.waitForFunction(() => document.querySelectorAll('#ef-sensors .sensor-spark path.sspk-line').length === 3,
    null, { timeout: 10000 });
  const phone = await page.evaluate(() => {
    const se = document.scrollingElement;
    const row = document.querySelector('#ef-sensors .sensor-row');
    const box = row.getBoundingClientRect();
    const spills = [...row.children].some(c => { const r = c.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1; });
    return { sideways: se.scrollWidth > se.clientWidth + 1, spills };
  });
  ok('nothing scrolls sideways, and no row\'s line spills out of it', !phone.sideways && !phone.spills, JSON.stringify(phone));

  console.log('\n  nothing threw');
  ok('no page errors for the whole run', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close?.();
}

console.log(failures
  ? `\nFAIL — ${failures} assertion(s).\n`
  : '\nPASS — every sensor row draws its week from one load, the chart it opens reads the\n'
    + '       window it shows, and its door lands on Field Data with that address and window.\n');
process.exit(failures ? 1 : 0);
