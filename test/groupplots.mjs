// A station's neighbours plotted together (group-plots.js): every river
// height gauge along a river, from the river's callout or a gauge's card, and
// every rain gauge within a distance of a station — in ARRO on one graph, and
// out of the Flood-Net datastore in a dialog of strips whose door lands on
// Field Data.
//
// The register is the real one (stations.json) and the rivers are the real
// Geofabric files, so the groups are worked out from what the page itself
// holds; Loudoun Br AL, on the Condamine River with a rain gauge and a level,
// is the station they are asked about. The datastore is stood in for at
// `dbSelect`: every address asked about has fifteen-minute readings for a
// fortnight — a level of 300 raw rising to 420, and a rain counter that tips
// 50 times in a storm three days ago (10 mm at the assumed 0.2 mm a tip) —
// except one, which has sent nothing, so a strip says so.
//
// What matters: a gauge is a measurement (Rainfall and Rainfall Increment on
// one address are one gauge, ARRO handed the increment, and the register's
// two records on 6128 one strip, not two); the river group is
// the Condamine's gauges, highest ground first, and a gauge with no stream
// recorded finds its river by the line it stands on; the rain group the gauges
// inside the radius, nearest first; the ARRO pill carries every one of them as
// devices[]=site|device; the card shows the names each pill captures, and the
// slider changes them and is remembered; the river's callout has the same
// pair; the dialog draws a strip a gauge from one request an address, reads
// every strip at one instant under the arrow keys, says which sent nothing,
// opens a gauge's station on the Stations map from its name, and Open in
// Field Data lands on that tab with every address ticked under its own
// station. No sideways scroll at 375 px.
//
//   npm run groupplots

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
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations)
      && typeof GroupPlots !== 'undefined',
    null, { timeout: LOAD_TIMEOUT });

  // ── the datastore, stood in for ─────────────────────────────────────────
  await page.evaluate(() => {
    const HOUR = 3600000, DAY = 86400000, QUARTER = 15 * 60000;
    const now = Date.now();
    const storm = Math.floor((now - 3 * DAY) / HOUR) * HOUR;
    const SILENT = 'a:6129';     // Loudoun's own level: nothing, ever — a strip says so
    const rainy = new Set();
    for (const s of state.data.stations) for (const se of s.sensors || []) {
      if (/rain/i.test(se.type || '') && se.alert_id != null) rainy.add(`a:${se.alert_id}`);
    }
    const memo = new Map();
    const series = addr => {
      if (memo.has(addr)) return memo.get(addr);
      const out = [];
      if (addr !== SILENT) {
        for (let t = Math.ceil((now - 14 * DAY) / QUARTER) * QUARTER; t <= now - 60000; t += QUARTER) {
          const into = Math.max(0, Math.min(1, (t - storm) / (6 * HOUR)));
          out.push({ t, raw: rainy.has(addr) ? (2000 + Math.round(50 * into)) % 2048 : Math.round(300 + 120 * into) });
        }
      }
      memo.set(addr, out);
      return out;
    };
    const log = window.__gp = { queries: [] };
    const wanted = q => {
      const m = q.match(/addr=in\.\(([^)]*)\)/);
      return m ? decodeURIComponent(m[1]).split(',').map(s => s.replace(/"/g, '')) : [];
    };
    const from = (q, col) => {
      const m = q.match(new RegExp(`${col}=gte\\.([^&]+)`));
      return m ? Date.parse(decodeURIComponent(m[1])) : 0;
    };
    const until = (q, col) => {
      const m = q.match(new RegExp(`${col}=lt\\.([^&]+)`));
      return m ? Date.parse(decodeURIComponent(m[1])) : Infinity;
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
        const r = out.get(b) || { addr, bucket: new Date(b).toISOString(), n: 0, n_dup: 0 };
        r.n++; r.raw_last = p.raw; r.raw_min = Math.min(r.raw_min ?? p.raw, p.raw); r.raw_max = Math.max(r.raw_max ?? p.raw, p.raw);
        r.last_ts = new Date(p.t).toISOString(); r.first_ts = r.first_ts || r.last_ts; r.val_last = null; r.unit = 'count';
        out.set(b, r);
      });
      return [...out.values()];
    };
    window.dbSelect = async q => {
      log.queries.push(q);
      const addrs = wanted(q);
      if (/^reading\?/.test(q)) {
        const t0 = from(q, 'reading_ts'), t1 = until(q, 'reading_ts');
        const rows = addrs.flatMap(a => series(a).filter(p => p.t >= t0 && p.t < t1).map(p => ({
          addr: a, station_id: null, reading_ts: new Date(p.t).toISOString(), received_at: new Date(p.t).toISOString(),
          value_raw: p.raw, value: null, unit: 'count', quality: 0, path: 'test', dup_count: 0, dup_paths: [],
        })));
        return page(rows, q);
      }
      if (/^reading_(hourly|daily)\?/.test(q)) {
        const daily = /^reading_daily/.test(q);
        const lo = from(q, 'bucket');
        const rows = addrs.flatMap(a => roll(a, series(a), daily ? DAY : HOUR))
          .filter(r => Date.parse(r.bucket) >= lo - (daily ? DAY : 0));
        return page(rows, q);
      }
      if (/^quality\?/.test(q)) return [{ code: 0, key: 'good' }];
      return [];
    };
  });

  // ── 1. the groups ───────────────────────────────────────────────────────
  console.log('\nThe groups, from the register and the rivers\n');
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
  const groups = await page.evaluate(async id => {
    const st = state.data.stations.find(s => s.id === id);
    await MapRiverLines.near(st.lat, st.lon);
    const rain = GroupPlots.gaugesOf(st, 'rain'), level = GroupPlots.gaugesOf(st, 'level');
    const river = GroupPlots.streamGroup(st);
    const r25 = GroupPlots.rainGroup(st, 25), r10 = GroupPlots.rainGroup(st, 10), r100 = GroupPlots.rainGroup(st, 100);
    const arro = GroupPlots.arroOf(river);
    const pairs = river.members.flatMap(m => m.gauges.filter(g => g.arro && m.st.site && m.st.site.db_id != null)
      .map(g => `${m.st.site.db_id}|${g.arro.device_id}`));
    const named = state.data.stations.filter(s => s.stream && MapRiverLines.riverKey(s.stream) === 'condamine river'
      && (s.sensors || []).some(x => /level/i.test(x.type || '')));
    const R = MapRiverLines.riverOf(st);
    return {
      rain: rain.map(g => ({ addr: g.addr, arro: g.arro && `${g.arro.type}#${g.arro.device_id}` })),
      level: level.map(g => ({ addr: g.addr, arro: g.arro && `${g.arro.type}#${g.arro.device_id}` })),
      river: { title: river.title, how: river.how, n: river.members.length, self: river.members.some(m => m.st.id === id),
               allLevel: river.members.every(m => m.gauges.length && m.gauges.every(g => /level/i.test(g.type))),
               heights: river.members.map(m => m.st.elevation_ahd) },
      named: named.length, namedIn: named.filter(s => river.members.some(m => m.st.id === s.id)).length,
      riverOf: R,
      r25: { n: r25.members.length, km: r25.km, first: r25.members[0] && r25.members[0].st.id,
             sorted: r25.members.every((m, i, a) => !i || a[i - 1].km <= m.km), inside: r25.members.every(m => m.km <= 25) },
      r10: r10.members.length, r100: r100.members.length,
      twice: state.data.stations.filter(s => (s.sensors || []).some(x => x.alert_id === 6128)).length,
      addrs: GroupPlots.stripsOf(r25).map(s => s.addr),
      subset: r10.members.every(m => r25.members.some(x => x.st.id === m.st.id)),
      arro: arro && { count: arro.count, url: arro.url },
      pairs,
    };
  }, STATION);
  // A gauge with no stream recorded finds its river by the line it stands on.
  const byLine = await page.evaluate(async () => {
    const cands = state.data.stations.filter(s => !s.stream && s.lat != null && s.lon != null
      && (s.sensors || []).some(x => /level/i.test(x.type || ''))).slice(0, 40);
    for (const st of cands) {
      await MapRiverLines.near(st.lat, st.lon);
      const R = MapRiverLines.riverOf(st);
      if (!R || R.how !== 'line') continue;
      const g = GroupPlots.streamGroup(st);
      const me = g.members.find(m => m.st.id === st.id);
      return { name: st.name, river: R.title, how: g.how, title: g.title, mine: me && me.how,
               along: MapRiverLines.stationsAlong(R.id).some(m => m.st.id === st.id && m.how === 'line' && m.m <= MapRiverLines.NEAR_M) };
    }
    return null;
  });
  if (VERBOSE) console.log(JSON.stringify(groups, null, 1).slice(0, 2000));
  ok('a rain gauge is one gauge: its address once, ARRO handed the increment',
    groups.rain.length === 1 && groups.rain[0].addr === 'a:6128' && /Increment#4$/.test(groups.rain[0].arro || ''), JSON.stringify(groups.rain));
  ok('…and the level its own, ARRO handed the plain Water Level',
    groups.level.length === 1 && groups.level[0].addr === 'a:6129' && groups.level[0].arro === 'Water Level#1', JSON.stringify(groups.level));
  ok('the station stands on the Condamine River, which its stream names',
    groups.riverOf && groups.riverOf.title === 'Condamine River' && groups.riverOf.how === 'stream', JSON.stringify(groups.riverOf));
  ok('the river group is its river height gauges, this one among them',
    groups.river.title === 'Condamine River' && groups.river.n > 3 && groups.river.self && groups.river.allLevel, JSON.stringify(groups.river));
  ok('…every gauge whose stream names it that the river\'s extent holds', groups.namedIn >= groups.named - 1 && groups.namedIn > 3,
    `${groups.namedIn} of ${groups.named}`);
  ok('…highest ground first', groups.river.heights.every((h, i, a) => !i || h == null || a[i - 1] == null || a[i - 1] >= h),
    JSON.stringify(groups.river.heights));
  ok('the rain group: inside the radius, nearest first, this station first',
    groups.r25.km === 25 && groups.r25.sorted && groups.r25.inside && groups.r25.first === STATION && groups.r25.n > 1, JSON.stringify(groups.r25));
  ok('one gauge once: the register\'s second record on 6128 is not a second strip',
    groups.twice > 1 && new Set(groups.addrs).size === groups.addrs.length && groups.addrs.filter(a => a === 'a:6128').length === 1,
    `${groups.twice} records carry 6128; ${groups.addrs.join(',')}`);
  ok('a gauge with no stream recorded finds its river by the line within 300 m of it, and is along it',
    byLine && byLine.how === 'line' && byLine.title === byLine.river && byLine.along, JSON.stringify(byLine));
  ok('…a smaller radius a subset, a larger one more', groups.subset && groups.r10 <= groups.r25.n && groups.r100 > groups.r25.n,
    `${groups.r10} ⊆ ${groups.r25.n} < ${groups.r100}`);
  ok('ARRO\'s graph is handed every gauge on the river as devices[]=site|device',
    groups.arro && groups.arro.count === Math.min(groups.pairs.length, 40)
      && groups.pairs.slice(0, 40).every(p => groups.arro.url.includes(`devices%5B%5D=${encodeURIComponent(p)}`))
      && /^https:\/\/contrail-bom\.onerain\.au\/graph\/\?/.test(groups.arro.url),
    groups.arro && groups.arro.url.slice(0, 200));
  // The shape of a graph ARRO opened itself (27 Oct 2026): one sensor's page,
  // site_id and device_id first and tab=sensor_tab last, the rest added as
  // devices[] — the anchor's own among them. Without the anchor it was blank.
  const shape = (() => {
    const u = new URL(groups.arro ? groups.arro.url : 'https://x/');
    const keys = [...u.searchParams.keys()];
    return {
      site: u.searchParams.get('site_id'), dev: u.searchParams.get('device_id'),
      order: [...new Set(keys)].join(','), devices: u.searchParams.getAll('devices[]'),
      tz: u.searchParams.get('time_zone'), start: u.searchParams.get('data_start'),
    };
  })();
  ok('…as one sensor\'s graph: this station\'s level is the page, the rest added to it, in the order ARRO\'s own link has',
    shape.site === '3318' && shape.dev === '1' && shape.devices.includes('3318|1')
      && shape.order === 'site_id,device_id,refresh,range,legend,thresholds,bin,time_zone,data_start,data_end,hidden_devices,devices[],tab'
      && shape.tz === 'Australia/Brisbane' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(shape.start || '')
      && /[?&]tab=sensor_tab$/.test(groups.arro.url) && !/has_regular_sensors|for_forecast|markers=|invalid=/.test(groups.arro.url),
    JSON.stringify(shape));

  // ── 2. the station card ─────────────────────────────────────────────────
  console.log('\nThe station card\n');
  await page.evaluate(id => { try { localStorage.removeItem('mn-group-rain-km'); } catch (_) {} showStationCard(id); }, STATION);
  await page.waitForFunction(() => !!document.querySelector('#stn-card .stn-card-gplots .gplot-pills'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  const card = await page.evaluate(() => {
    const sec = document.querySelector('#stn-card .stn-card-gplots');
    const rows = [...sec.querySelectorAll('.gplot-row')];
    const rowOf = word => rows.find(r => r.querySelector('.gplot-row-head b')?.textContent === word);
    const desc = r => r && {
      head: r.querySelector('.gplot-row-head').textContent.replace(/\s+/g, ' ').trim(),
      arro: r.querySelector('a.pill.gplot-arro')?.getAttribute('href') || '',
      arroText: r.querySelector('a.pill.gplot-arro')?.textContent.replace(/\s+/g, ' ').trim() || '',
      target: r.querySelector('a.pill.gplot-arro')?.getAttribute('target'),
      fn: r.querySelector('button.pill.gplot-fn')?.textContent.replace(/\s+/g, ' ').trim() || '',
      names: r.querySelector('.gplot-names')?.textContent.replace(/\s+/g, ' ').trim() || '',
    };
    const data = sec.closest('.stn-card-data');
    const pillName = a => a.querySelector('.pill-lbl')?.textContent.replace(/\s+/g, ' ').trim();
    return { river: desc(rowOf('River')), rain: desc(rowOf('Rain')), slider: !!sec.querySelector('input[type=range].gplot-range'),
             dataHead: data?.querySelector('.stn-card-rhs-head')?.textContent.trim(),
             dataPills: [...(data?.querySelectorAll('.stn-card-data-pills .pill') || [])].map(pillName),
             inApp: [...document.querySelectorAll('#stn-card .stn-card-group[aria-label="In Flood-Net"] .pill')].map(pillName),
             records: [...document.querySelectorAll('#stn-card .stn-card-group[aria-label="Records"] .pill')].map(pillName),
             afterHealth: !!sec.previousElementSibling, actionsStillRows: [...document.querySelectorAll('#stn-card .stn-card-actions > *')].every(g => g.classList.contains('pill-row')) };
  });
  if (VERBOSE) console.log(card);
  ok('a river row: ARRO this river and the Flood-Net plot, with the count each captures',
    card.river && /ARRO this river · \d+/.test(card.river.arroText) && /Flood-Net plot · \d+/.test(card.river.fn)
      && card.river.target === '_blank' && /devices%5B%5D=3318%7C1/.test(card.river.arro)
      && /[?&]site_id=3318&device_id=1&/.test(card.river.arro), JSON.stringify(card.river));
  ok('…and the names of the stations it captures, this one marked',
    card.river && /Loudoun Br AL \(this one\)/.test(card.river.names) && card.river.names.split(',').length >= 3, card.river && card.river.names);
  ok('…on the Condamine River', card.river && /on the Condamine River/.test(card.river.head), card.river && card.river.head);
  ok('a rain row with its slider, at 25 km to start, and the distances in its names',
    card.slider && card.rain && /Rain within 25 km/.test(card.rain.head) && /ARRO rain · \d+/.test(card.rain.arroText)
      && /\d+(\.\d+)? km\)/.test(card.rain.names), JSON.stringify(card.rain));
  ok('the actions below are still pill rows, nothing else among them', card.actionsStillRows);
  ok('the plots are under Data, led by Field data and the station\'s ARRO admin pill — which Records no longer carries',
    card.dataHead === 'Data' && card.dataPills.length === 2 && card.dataPills[0] === 'Field data' && /ARRO admin$/.test(card.dataPills[1] || '')
      && !card.records.some(n => /ARRO/.test(n || '')), JSON.stringify({ head: card.dataHead, pills: card.dataPills, records: card.records }));
  ok('…and Field data is still in In Flood-Net as well', card.inApp.includes('Field data'), JSON.stringify(card.inApp));

  const slid = await page.evaluate(id => {
    const before = document.querySelector(`#gplot-rain-${id} .gplot-fn`)?.textContent;
    const r = document.getElementById(`gplot-km-${id}`);
    r.value = '60';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    let saved = null;
    try { saved = localStorage.getItem('mn-group-rain-km'); } catch (_) {}
    return {
      before, after: document.querySelector(`#gplot-rain-${id} .gplot-fn`)?.textContent,
      out: document.getElementById(`gplot-km-${id}-out`)?.textContent, valuetext: r.getAttribute('aria-valuetext'), saved,
    };
  }, STATION);
  const n = s => +(String(s || '').match(/· (\d+)/) || [])[1];
  ok('the slider widens it: more gauges, the words follow, remembered on this device',
    n(slid.after) > n(slid.before) && slid.out === '60 km' && slid.valuetext === '60 km' && slid.saved === '60', JSON.stringify(slid));
  await page.evaluate(id => GroupPlots.setKm(25, id), STATION);

  // ── 3. the river's callout ──────────────────────────────────────────────
  console.log('\nA river\'s callout\n');
  const callout = await page.evaluate(id => {
    const st = state.data.stations.find(s => s.id === id);
    closeStnCard(false);
    MapRiverLines.pick(MapRiverLines.riverOf(st).id);
    const pop = document.querySelector('.mn-rl-popup .gplot-callout');
    return {
      arro: pop?.querySelector('a.pill.gplot-arro')?.textContent.replace(/\s+/g, ' ').trim() || '',
      href: pop?.querySelector('a.pill.gplot-arro')?.getAttribute('href') || '',
      fn: pop?.querySelector('button.pill.gplot-fn')?.textContent.replace(/\s+/g, ' ').trim() || '',
      names: pop?.querySelector('.gplot-names')?.textContent || '',
      stationButtons: document.querySelectorAll('.mn-rl-popup .mn-rl-station').length,
    };
  }, STATION);
  ok('the river\'s callout has the same pair, ARRO this river and the Flood-Net plot',
    /ARRO this river · \d+/.test(callout.arro) && /Flood-Net plot · \d+/.test(callout.fn) && /Loudoun Br AL/.test(callout.names), JSON.stringify(callout));
  ok('…its ARRO graph the page of its first gauge, which it carries too', (() => {
    const u = new URL(callout.href || 'https://x/');
    return u.searchParams.get('site_id') && u.searchParams.getAll('devices[]')[0] === `${u.searchParams.get('site_id')}|${u.searchParams.get('device_id')}`;
  })(), callout.href.slice(0, 160));
  ok('…beside its station buttons, unchanged', callout.stationButtons > 0 && callout.stationButtons <= 8, String(callout.stationButtons));

  // ── 4. the dialog ───────────────────────────────────────────────────────
  console.log('\nThe Flood-Net plot\n');
  await page.evaluate(() => { window.__gp.queries.length = 0; });
  await page.click('.mn-rl-popup .gplot-callout button.gplot-fn');
  await page.waitForFunction(() => {
    const s = [...document.querySelectorAll('#gplot-strips .gplot-strip')];
    return s.length && s.every(x => !/Reading…/.test(x.textContent));
  }, null, { timeout: 15000 });
  const dlg = await page.evaluate(() => {
    const strips = [...document.querySelectorAll('#gplot-strips .gplot-strip')];
    return {
      title: document.getElementById('app-modal-title')?.textContent,
      strips: strips.length,
      drawn: strips.filter(s => s.querySelector('svg.gplot-chart path.sspk-line')).length,
      silent: strips.filter(s => /Nothing in the last 7 days/.test(s.textContent)).map(s => s.querySelector('.gplot-name').textContent),
      head: document.getElementById('gplot-head')?.textContent.replace(/\s+/g, ' ').trim(),
      vals: strips.map(s => s.querySelector('.gplot-val').textContent.trim()),
      table: document.querySelectorAll('#gplot-table tbody tr').length,
      arro: !!document.querySelector('#gplot-arro a[href*="contrail-bom.onerain.au/graph/"]'),
      week: document.querySelector('.gplot-wins [data-win="7d"]')?.getAttribute('aria-pressed'),
    };
  });
  const q4 = await page.evaluate(() => window.__gp.queries.filter(q => /^reading(_hourly|_daily)?\?/.test(q)));
  if (VERBOSE) console.log(dlg, q4.length);
  ok('the dialog is named for the river', dlg.title === 'Condamine River — river height', dlg.title);
  ok('a strip a gauge, every one drawn but the one that sent nothing',
    dlg.strips > 3 && dlg.drawn === dlg.strips - 1 && dlg.silent.length === 1 && dlg.silent[0] === 'Loudoun Br AL', JSON.stringify(dlg));
  ok('…the headline counts them', new RegExp(`^${dlg.strips - 1} of ${dlg.strips} gauges sent readings in the last 7 days`).test(dlg.head || ''), dlg.head);
  ok('…each strip says its latest, in raw counts here', dlg.vals.filter(v => /^420 raw$/.test(v)).length === dlg.strips - 1, dlg.vals.join(' | '));
  ok('a week is the hourly rollups and a raw tail, one request of each an address',
    q4.filter(q => /^reading_hourly\?/.test(q)).length === dlg.strips && q4.filter(q => /^reading\?/.test(q)).length === dlg.strips
      && q4.every(q => (q.match(/addr=in\.\(([^)]*)\)/) || [])[1].split(',').length === 1), `${q4.length} requests for ${dlg.strips}`);
  ok('the table has a row a gauge, and the same gauges are a link away in ARRO', dlg.table === dlg.strips && dlg.arro && dlg.week === 'true');

  const readAt = await page.evaluate(() => {
    const stage = document.querySelector('.gplot-stage');
    stage.focus();
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    for (let i = 0; i < 30; i++) stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const vals = [...document.querySelectorAll('#gplot-strips .gplot-val')].map(v => v.textContent.trim());
    return { read: document.getElementById('gplot-read').textContent, vals,
             cross: [...document.querySelectorAll('[id^="gplot-cross-"]')].every(c => c.getAttribute('visibility') === 'visible') };
  });
  ok('the arrow keys read every strip at one instant — before the storm, 300 raw',
    readAt.read && readAt.cross && readAt.vals.filter(v => /^300 raw$/.test(v)).length === dlg.strips - 1, JSON.stringify(readAt));

  await page.evaluate(() => { window.__gp.queries.length = 0; GroupPlots.setWin('30d'); });
  await page.waitForFunction(() => document.querySelector('.gplot-wins [data-win="30d"]')?.getAttribute('aria-pressed') === 'true'
    && ![...document.querySelectorAll('#gplot-strips .gplot-strip')].some(x => /Reading…/.test(x.textContent)), null, { timeout: 15000 });
  const q30 = await page.evaluate(() => window.__gp.queries.filter(q => /^reading_hourly\?/.test(q)).map(q => {
    const m = q.match(/bucket=gte\.([^&]+)/);
    return m ? (Date.now() - Date.parse(decodeURIComponent(m[1]))) / 86400000 : 0;
  }));
  ok('30 days asks the hourly rollups over 30 days', q30.length > 0 && q30.every(d => d > 29.9 && d < 30.1), JSON.stringify(q30.slice(0, 3)));

  // ── 5. the door ─────────────────────────────────────────────────────────
  console.log('\nOpen in Field Data\n');
  const want = await page.evaluate(() => [...document.querySelectorAll('#gplot-table tbody td.mono')].map(td => td.textContent));
  await page.click('.gplot-foot button.primary');
  await page.waitForFunction(() => state.activeTab === 'field' && ArroData.ad && ArroData.ad.fq && !ArroData.ad.fq.loading,
    null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const field = await page.evaluate(() => {
    const q = ArroData.ad.fq;
    const m = document.getElementById('app-modal');
    return {
      closed: !m || m.style.display === 'none', tab: state.activeTab, win: q.win, station: q.stationId,
      group: q.group && q.group.title, items: q.group ? q.group.items.length : 0, sensors: q.sensors.slice(),
      rows: document.querySelectorAll('.ad-field-group .ad-sensor-row input:checked').length,
      series: ArroData.ad.series.map(s => s.prov && s.prov.addr),
      labels: ArroData.ad.series.map(s => s.label),
    };
  });
  if (VERBOSE) console.log(field);
  ok('the dialog closes and Field Data opens over the window it was showing',
    field.closed && field.tab === 'field' && field.win === '30d' && !field.station, JSON.stringify({ ...field, labels: undefined }));
  ok('…with the group: every gauge\'s address ticked, under the river\'s name',
    field.group === 'Condamine River — river height' && field.items === want.length && field.rows === want.length
      && want.every(a => field.sensors.includes(a)), `${field.items} items, ${field.rows} ticked, ${want.length} wanted`);
  ok('…and drawn, each under the station it came from',
    field.series.length === want.length - 1 && field.labels.every(l => / · Water Level$/.test(l))
      && field.labels.some(l => /^Warwick|^Killarney|^Loudoun|^[A-Z]/.test(l)), field.labels.join(' | '));

  // The rain dialog, and its own slider.
  const rain = await page.evaluate(async id => {
    switchTab('stations');
    GroupPlots.setKm(25, id);
    GroupPlots.plot(`rain:${id}`);
    for (let i = 0; i < 100 && [...document.querySelectorAll('#gplot-strips .gplot-strip')].some(x => /Reading…/.test(x.textContent)); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const at25 = document.querySelectorAll('#gplot-strips .gplot-strip').length;
    const vals = [...document.querySelectorAll('#gplot-strips .gplot-val')].map(v => v.textContent.trim());
    const bars = document.querySelectorAll('#gplot-strips rect.sspk-bar').length;
    const head = document.getElementById('gplot-head')?.textContent.replace(/\s+/g, ' ').trim();
    GroupPlots.dlgKm(10, true);
    for (let i = 0; i < 100 && [...document.querySelectorAll('#gplot-strips .gplot-strip')].some(x => /Reading…/.test(x.textContent)); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return { at25, at10: document.querySelectorAll('#gplot-strips .gplot-strip').length, vals, bars, head,
             title: document.getElementById('app-modal-title')?.textContent, first: document.querySelector('#gplot-strips .gplot-name')?.textContent };
  }, STATION);
  if (VERBOSE) console.log(rain);
  ok('the rain dialog: a strip a gauge, this one first, the storm\'s 10 mm in bars on each',
    rain.at25 > 1 && rain.first === 'Loudoun Br AL' && rain.bars > 0 && rain.vals.every(v => v === '10 mm'), JSON.stringify(rain));
  ok('…the headline names the wettest', /sent readings in the last 7 days; the most, 10 mm at /.test(rain.head || ''), rain.head);
  ok('…and its slider narrows it, the title following', rain.at10 <= rain.at25 && rain.title === 'Rain within 10 km of Loudoun Br AL',
    `${rain.at25} → ${rain.at10}, ${rain.title}`);

  // A gauge's name is its station on the Stations map.
  const named = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#gplot-strips button.gplot-name[data-sid]')];
    const rows = document.querySelectorAll('#gplot-table tbody td button.link-btn[data-sid]').length;
    const b = btns[btns.length - 1];
    const want = { id: b && b.dataset.sid, name: b && b.textContent };
    b?.click();
    const m = document.getElementById('app-modal');
    return { strips: document.querySelectorAll('#gplot-strips .gplot-strip').length, btns: btns.length, rows, want,
             closed: !m || m.style.display === 'none', tab: state.activeTab, selected: state.selectedId,
             card: document.querySelector('#stn-card')?.textContent || '' };
  });
  if (VERBOSE) console.log({ ...named, card: named.card.slice(0, 80) });
  ok('a gauge\'s name, over its strip and in the table, opens its station on the Stations map',
    named.btns > 1 && named.rows === named.btns && named.closed && named.tab === 'stations'
      && named.selected === named.want.id && named.card.includes(named.want.name),
    JSON.stringify({ ...named, card: named.card.slice(0, 80) }));

  // ── 6. on a phone ───────────────────────────────────────────────────────
  console.log('\nAt 375 px\n');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.evaluate(id => GroupPlots.plot(`rain:${id}`), STATION);
  await page.waitForTimeout(800);
  const phone = await page.evaluate(() => {
    const se = document.scrollingElement;
    const card = document.querySelector('#app-modal .modal-card');
    const body = card.querySelector('.modal-body');
    return { sideways: se.scrollWidth > se.clientWidth + 1, inner: body.scrollWidth > body.clientWidth + 1 };
  });
  ok('nothing scrolls sideways, in the page or the dialog', !phone.sideways && !phone.inner, JSON.stringify(phone));
  await page.evaluate(() => Modal.close());

  console.log('\n  nothing threw');
  ok('no page errors for the whole run', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close?.();
}

console.log(failures
  ? `\nFAIL — ${failures} assertion(s).\n`
  : '\nPASS — a river\'s gauges and a station\'s rain gauges, in ARRO on one graph and out of the\n'
    + '       datastore a strip each, and the door lands on Field Data with every one of them.\n');
process.exit(failures ? 1 : 0);
