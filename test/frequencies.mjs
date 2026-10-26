// A station's RX/TX frequency pairs (0033, frequencies.js): the repeater's own
// pair as the primary row and every other channel as a row "+ Add frequency"
// adds, in the station editor for a repeater and for a base station, and a
// line each on the station card.
//
//   1. **The copies agree**: every box a row has is a column of
//      meganet.station_frequency.
//   2. **The editor**: the primary row is the repeater's pair under the ids the
//      rest of the app reads (ef-rx, ef-tx); + Add puts a row at the foot with
//      the cursor in it; an untouched form sends no list, a filled row sends
//      exactly what was typed and nothing else changes; a row with a use and
//      no frequency, or a frequency that is not one, stops the save by name;
//      removing a row hands focus back to + Add. A base station gets a section
//      of its own; a field station gets none.
//   3. **The card**: the primary pair and the others, a line each.
//
// Run:  npm run frequencies
//       npm run frequencies -- -v

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

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

const SQL      = fs.readFileSync(repo('db/migrations/0033_aep_levels_and_frequencies.sql'), 'utf8');
const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;

function tableColumns(sql, table) {
  const m = new RegExp(`create table if not exists meganet\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!m) return [];
  return m[1].split('\n').map(l => /^\s{2}([a-z_0-9]+)\s/.exec(l)).filter(Boolean).map(x => x[1])
    .filter(c => c !== 'primary' && c !== 'constraint');
}

async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
    null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

const openEditor = (page, id) => page.evaluate(id => {
  if (state.selectedId !== id) selectStation(id);
  dockReveal(document.getElementById('stations-editor-card'));
}, id);

async function main() {
  const repeater = STATIONS.find(s => s.roles.includes('repeater') && s.repeater
    && s.repeater.rx_mhz != null && s.repeater.tx_mhz != null && s.lat != null);
  const base = STATIONS.find(s => s.roles.includes('base') && !s.roles.includes('repeater') && s.lat != null);
  const field = STATIONS.find(s => s.roles.length === 1 && s.roles[0] === 'field' && s.lat != null);

  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 1000 } });

    log('\nThe copies agree\n');
    const js = await page.evaluate(() => Frequencies.FIELDS.map(f => f.key));
    const cols = tableColumns(SQL, 'station_frequency');
    check('every box a row has is a column of meganet.station_frequency',
      js.length === 4 && js.every(k => cols.includes(k)), JSON.stringify({ js, cols }));

    log('\nThe editor — a repeater\n');
    await openEditor(page, repeater.id);
    await page.waitForSelector('#ef-freqs');
    const shape = await page.evaluate(() => ({
      primary: !!document.querySelector('#ef-freqs .freq-primary #ef-rx')
            && !!document.querySelector('#ef-freqs .freq-primary #ef-tx'),
      rx: document.getElementById('ef-rx').value, tx: document.getElementById('ef-tx').value,
      rows: document.querySelectorAll('#ef-freqs .freq-rows .freq-row').length,
      untouched: !('frequencies' in editorReadForm()),
      repeater: editorReadForm().repeater,
    }));
    check('the primary row is the repeater\'s own pair, in ef-rx and ef-tx',
      shape.primary && Number(shape.rx) === repeater.repeater.rx_mhz && Number(shape.tx) === repeater.repeater.tx_mhz,
      JSON.stringify(shape));
    check('an untouched form sends no frequency list, and the repeater\'s pair as it was',
      shape.untouched && shape.repeater.rx_mhz === repeater.repeater.rx_mhz
        && shape.repeater.tx_mhz === repeater.repeater.tx_mhz, JSON.stringify(shape.repeater));

    await page.click('#ef-freqs .ef-section-head > button');
    check('+ Add frequency puts a row at the foot, with the cursor in its RX box',
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#ef-freqs .freq-rows .freq-row');
        const last = rows[rows.length - 1];
        return last.contains(document.activeElement) && document.activeElement.dataset.f === 'rx_mhz';
      }));
    check('…and the list\'s count follows',
      await page.evaluate(() => /— 2/.test(document.querySelector('#ef-freqs .freq-count').textContent)));
    check('a row added and left blank is not a change',
      await page.evaluate(() => !('frequencies' in editorReadForm())));

    await page.fill('#ef-freqs .freq-rows .freq-row:last-child [data-f="rx_mhz"]', '150.4125');
    await page.fill('#ef-freqs .freq-rows .freq-row:last-child [data-f="tx_mhz"]', '155.9125');
    await page.fill('#ef-freqs .freq-rows .freq-row:last-child [data-f="label"]', 'Voice');
    const sent = await page.evaluate(() => {
      const d = editorReadForm();
      return { f: d.frequencies, rhs: ['flood_classes', 'crossings', 'gauge_survey', 'aep_levels'].filter(k => k in d),
               rx: d.repeater.rx_mhz };
    });
    check('a filled row goes out as typed, keyed as the document keys it',
      JSON.stringify(sent.f) === JSON.stringify([{ rx_mhz: 150.4125, tx_mhz: 155.9125, label: 'Voice' }]),
      JSON.stringify(sent.f));
    check('…and nothing else rides along: no river list, the primary pair unchanged',
      sent.rhs.length === 0 && sent.rx === repeater.repeater.rx_mhz, JSON.stringify(sent));

    // A use with no frequency.
    await page.click('#ef-freqs .ef-section-head > button');
    await page.fill('#ef-freqs .freq-rows .freq-row:last-child [data-f="label"]', 'Link');
    const p1 = await page.evaluate(() => Frequencies.formProblem());
    check('a row with a use and no frequency stops the save by name',
      p1 && /row 3 has no RX or TX frequency/.test(p1), p1 || '(none)');
    await page.fill('#ef-freqs .freq-rows .freq-row:last-child [data-f="tx_mhz"]', '-1');
    const p2 = await page.evaluate(() => Frequencies.formProblem());
    check('…as does a frequency that is not one',
      p2 && /row 3: “TX \(MHz\)” is not a frequency/.test(p2), p2 || '(none)');

    await page.click('#ef-freqs .freq-rows .freq-row:last-child .freq-del');
    check('removing a row hands focus to + Add frequency, not to <body>',
      await page.evaluate(() => document.activeElement
        && document.activeElement.closest('#ef-freqs .ef-section-head') !== null));
    check('…and the save is clear again', await page.evaluate(() => Frequencies.formProblem() === null));

    log('\nThe editor — a base station and a field station\n');
    await openEditor(page, base.id);
    await page.waitForSelector('#ef-freqs');
    const b = await page.evaluate(() => ({
      head: [...document.querySelectorAll('#stations-editor-card h4')].some(h => h.textContent.trim() === 'Base station radio'),
      primary: !!document.querySelector('#ef-freqs .freq-primary'),
      rx: !!document.getElementById('ef-rx'),
    }));
    check('a base station has a section of its own, with no primary row',
      b.head && !b.primary && !b.rx, JSON.stringify(b));

    await openEditor(page, field.id);
    await page.waitForSelector('#ef-name');
    check('a field station has no frequency rows at all',
      await page.evaluate(() => !document.getElementById('ef-freqs') && !('frequencies' in editorReadForm())));

    log('\nThe card\n');
    const lines = await page.evaluate(id => {
      const s = state.data.stations.find(x => x.id === id);
      s.frequencies = [{ rx_mhz: 150.4125, tx_mhz: 155.9125, label: 'Voice', acma_licence: '123456/1' }];
      showStationCard(id);
      const block = document.querySelector('#stn-card .stn-card-freqs');
      const out = block ? [...block.querySelectorAll('.mn-pop-line')].map(e => e.textContent.replace(/\s+/g, ' ').trim()) : null;
      delete s.frequencies;
      return out;
    }, repeater.id);
    check('the card lists the primary pair and the others, a line each',
      lines && lines.length === 2
        && lines[0].startsWith(`RX ${repeater.repeater.rx_mhz} · TX ${repeater.repeater.tx_mhz} MHz`) && /primary/.test(lines[0])
        && lines[1] === 'RX 150.4125 · TX 155.9125 MHz Voice, licence 123456/1',
      JSON.stringify(lines));
    check('a station with no pair and no radio has no block',
      await page.evaluate(() => {
        const s = state.data.stations.find(x => !x.proposed && !Frequencies.pairs(x).length && !stationAlertIds(x).length
          && x.alert2_station_id == null && x.lat != null);
        showStationCard(s.id);
        return !document.querySelector('#stn-card .stn-card-freqs');
      }));

    log('\nAssumed, and heard on\n');
    // Upper Rainbow AL (539229): Kroombit (28.5 km, 151.500 in and out),
    // Banana Range (46.6 km, in on 151.500, out on 152.400) and Mt Hopeful
    // (57.2 km, in on 152.400) carry its AlertIDs; only Kroombit is direct.
    const UR = 'upper_rainbow_al';
    await page.evaluate(() => { state.mapMaxLinkKm = 100; });
    const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
    const readingRows = [
      { station_id: UR, addr: 'a:944', freq_mhz: 151.5, protocol: 1, reading_ts: ago(1) },
      { station_id: UR, addr: 'a:944', freq_mhz: '151.500000', protocol: 1, reading_ts: ago(2) },
      { station_id: UR, addr: 'a:945', freq_mhz: 151.5, protocol: 1, reading_ts: ago(3) },
      { station_id: UR, addr: 'a:944', freq_mhz: 152.4, protocol: 1, reading_ts: ago(4) },
      { station_id: UR, addr: 'a:944', freq_mhz: 151.5375, protocol: 2, reading_ts: ago(5) },
      { station_id: UR, addr: 'a:944', freq_mhz: null, protocol: 1, reading_ts: ago(6) },
      { station_id: null, addr: 'a:944', freq_mhz: 151.5, protocol: 1, reading_ts: ago(7) },
      { station_id: 'somewhere_else', addr: 'a:944', freq_mhz: 151.95, protocol: 1, reading_ts: ago(8) },
    ].map(r => ({ alert_id: Number(r.addr.slice(2)), a2_station: null, a2_sensor: null, station_number: null, channel: '',
                  received_at: r.reading_ts, value_raw: 1, path: 'serial-monitor/test', ...r }));
    const asked = [];
    let mode = 'ok';
    await page.route('**://*.supabase.co/rest/v1/**', route => {
      const url = decodeURIComponent(route.request().url());
      if (!/\/rest\/v1\/reading\?/.test(url)) return route.fallback();
      asked.push(url);
      if (mode === 'down') return route.abort('connectionrefused');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readingRows) });
    });

    const freqCard = () => page.evaluate(() => {
      const block = document.querySelector('#stn-card .stn-card-freqs');
      if (!block) return null;
      const rows = {};
      block.querySelectorAll('.acma-row').forEach(r => {
        rows[r.firstElementChild.textContent.trim()] = {
          vals: [...r.querySelectorAll('.freq-val')].map(e => e.textContent.trim()),
          notes: [...r.querySelectorAll('.freq-why')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
          text: r.lastElementChild.textContent.replace(/\s+/g, ' ').trim(),
          title: r.firstElementChild.title,
        };
      });
      return rows;
    });

    await page.evaluate(id => showStationCard(id), UR);
    const C = await page.evaluate(id => {
      const c = Frequencies.carriersOf(state.data.stations.find(x => x.id === id));
      return { all: c.all.map(x => x.r.name), direct: c.direct.map(x => x.r.name) };
    }, UR);
    check('a station\'s carriers are the repeaters whose pass ranges carry its AlertIDs',
      ['Kroombit Repeater AL', 'Banana Range AL', 'Mt Hopeful AL'].every(n => C.all.includes(n)), JSON.stringify(C));
    check('…and only the nearest, which no nearer carrier feeds, is taken to hear it directly',
      C.direct.length === 1 && C.direct[0] === 'Kroombit Repeater AL', JSON.stringify(C));
    await page.waitForFunction(() => /MHz/.test(document.querySelector('#stn-card .stn-card-freqs')?.textContent || '')
      && !document.querySelector('#stn-card .stn-card-freqs [aria-busy]'), null, { timeout: 10_000 });
    let card = await freqCard();
    check('the card says what it is assumed to transmit on: its direct carrier\'s RX, and whose',
      card && card.Assumed && card.Assumed.vals.join('|') === 'TX 151.500 MHz'
        && /^Kroombit Repeater AL \(28\.\d km\) listens there$/.test(card.Assumed.notes[0])
        && !/Banana|Hopeful/.test(card.Assumed.text) && /Max TX distance \(100 km/.test(card.Assumed.title),
      JSON.stringify(card && card.Assumed));
    check('…and the channels its readings were heard on, most heard first, only its own rows counted',
      card && card['Heard on'] && card['Heard on'].vals.join('|') === '151.500 MHz|152.400 MHz|151.5375 MHz',
      JSON.stringify(card && card['Heard on']));
    const hn = (card && card['Heard on'] && card['Heard on'].notes) || [];
    check('…each saying how often and what is known to be on it: direct or a carrier\'s relay, or neither',
      /^ALERT · 3 readings, last .+ — direct, or relayed by Kroombit Repeater AL$/.test(hn[0] || '')
        && /^ALERT · 1 reading, last .+ — relayed by Banana Range AL and Mt Hopeful AL$/.test(hn[1] || '')
        && /^ALERT2 · 1 reading, last .+ — neither its assumed TX nor a channel its carriers transmit on$/.test(hn[2] || ''),
      JSON.stringify(hn));
    check('…and the reading on an address it shares, put down to nobody, said and not counted',
      /^1 more reading came on an address it shares, put down to no station, and is not counted\.$/.test(hn[3] || ''),
      JSON.stringify(hn));
    // The card's other reading requests (sensor-sparks.js's day) are not this
    // line's; the one that carries freq_mhz is the Health section's own.
    const withFreq = () => asked.filter(u => /select=[^&]*freq_mhz/.test(u));
    check('Heard on costs no request of its own: the card\'s readings carry freq_mhz, once',
      withFreq().length === 1 && /order=reading_ts\.desc&limit=1000/.test(withFreq()[0]), JSON.stringify(asked));
    await page.evaluate(() => repaintStnCard());
    check('…and a repaint asks nothing new', withFreq().length === 1, String(withFreq().length));

    await page.evaluate(() => { state.mapMaxLinkKm = 20; repaintStnCard(); });
    card = await freqCard();
    check('with the Max TX distance under its nearest carrier, nothing is assumed, and it says why',
      card && /^none within 20 km/.test(card.Assumed.text)
        && /Kroombit Repeater AL, is 28\.\d km off — past the Max TX distance\./.test(card.Assumed.text),
      JSON.stringify(card && card.Assumed));
    check('…and nothing heard is called direct or relayed by a link it no longer assumes',
      card && /^ALERT · 3 readings, last .+ — relayed by Kroombit Repeater AL$/.test(card['Heard on'].notes[0] || ''),
      JSON.stringify(card && card['Heard on'].notes));
    await page.evaluate(() => { state.mapMaxLinkKm = 100; });

    const lone = await page.evaluate(() => {
      const s = state.data.stations.find(x => !x.proposed && stationAlertIds(x).length && !findRepeaterMatches(x).length
        && !x.roles.includes('repeater') && x.lat != null);
      return s && s.id;
    });
    mode = 'down';
    await page.evaluate(id => showStationCard(id), lone);
    await page.waitForFunction(() => /could not ask/.test(document.querySelector('#stn-card .stn-card-freqs')?.textContent || ''),
      null, { timeout: 10_000 }).catch(() => {});
    card = await freqCard();
    check('a station no repeater carries says so, and a datastore that cannot be reached says that',
      card && card.Assumed && card.Assumed.text === 'no repeater carries its AlertIDs'
        && card['Heard on'] && /^could not ask the datastore/.test(card['Heard on'].text),
      JSON.stringify(card));
    mode = 'ok';

    await context.close();

    log('\nThe phone\n');
    const phone = await openStations(browser, server, errors, { viewport: { width: 375, height: 800 } });
    await openEditor(phone.page, repeater.id);
    await phone.page.waitForSelector('#ef-freqs');
    await phone.page.evaluate(() => { Frequencies.addRow(); Frequencies.addRow(); });
    const w = await phone.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    check('at 375 px with rows added, the page does not scroll sideways', w[0] <= w[1], JSON.stringify(w));
    const spill = await phone.page.evaluate(() => [...document.querySelectorAll('#ef-freqs .freq-row')].some(row => {
      const r = row.getBoundingClientRect();
      return [...row.querySelectorAll('input, button')].some(c => {
        const b = c.getBoundingClientRect();
        return b.width && (b.left < r.left - 1 || b.right > r.right + 1);
      });
    }));
    check('…and no box spills out of its row', !spill);
    await phone.context.close();

    check('nothing threw for the whole run', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).\n`);
  if (failed.length) {
    log(`FAIL — ${failed.length} of them.`);
    process.exit(1);
  }
  log('PASS — a repeater keeps its primary pair and gains rows, a base station has its own,');
  log('       and a save sends exactly what was typed.');
}

main().catch(e => { console.error(e); process.exit(1); });
