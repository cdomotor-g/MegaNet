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
//   4. **Links** (map-direct.js): under Assumed TX, every repeater that
//      carries a field station within the Max TX distance and every base
//      station in range on its channel, the best fade margin first, each with
//      a bar on one scale; a base on record as listening elsewhere left out
//      and named, and the ones too weak to hear it in a fold that a repaint
//      leaves open. The Radio tab opens with a summary: its best link, and a
//      channel nothing explains. While its card is open the map draws a line
//      to each base that hears it — and only those — and the line goes with
//      the card.
//   5. **The pins under the lines**: real clicks. Once the lines have been
//      drawn and gone a pin still opens its card, a line still opens its
//      radio-path card, and a canvas another layer leaves in a pane over the
//      links takes no click from the pins (the backstop in styles.css). A pin
//      under the elevation profile's line or a circle drawn after it still
//      takes the click (pinFirstCanvas, app.js).
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
      const flat = e => e.textContent.replace(/\s+/g, ' ').trim();
      const link = e => `${flat(e.querySelector('.link-btn'))} · ${flat(e.querySelector('.freq-fig'))}`;
      block.querySelectorAll('.freq-sec').forEach(r => {
        const h = r.querySelector('.freq-h').firstElementChild, body = r.querySelector('.freq-body');
        rows[h.textContent.trim()] = {
          vals: [...body.querySelectorAll('.freq-val')].map(e => e.textContent.trim()),
          notes: [...body.querySelectorAll('.freq-why')].map(flat),
          counts: [...body.querySelectorAll('.freq-n')].map(flat),
          links: [...body.querySelectorAll(':scope > .freq-link')].map(link),
          weak: [...body.querySelectorAll('.freq-fold .freq-link')].map(link),
          text: flat(body),
          title: h.title,
        };
      });
      const sum = document.querySelector('#stn-card .freq-sum');
      rows.summary = sum ? [...sum.querySelectorAll('p')].map(flat) : null;
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
      card && card['Assumed TX'] && card['Assumed TX'].vals.join('|') === '151.500 MHz'
        && /^Kroombit Repeater AL \(28\.\d km\) listens there$/.test(card['Assumed TX'].notes[0])
        && !/Banana|Hopeful/.test(card['Assumed TX'].text) && /Max TX distance \(100 km/.test(card['Assumed TX'].title),
      JSON.stringify(card && card['Assumed TX']));
    check('…and the channels its readings were heard on, most heard first, only its own rows counted',
      card && card['Heard on'] && card['Heard on'].vals.join('|') === '151.500 MHz|152.400 MHz|151.5375 MHz',
      JSON.stringify(card && card['Heard on']));
    const hn = (card && card['Heard on'] && card['Heard on'].notes) || [];
    check('…each saying how often and what is known to be on it: direct or a carrier\'s relay, or not explained',
      card['Heard on'].counts.join('|') === '3|1|1'
        && /^ALERT · last .+ · direct, or relayed by Kroombit Repeater AL$/.test(hn[0] || '')
        && /^ALERT · last .+ · relayed by Banana Range AL and Mt Hopeful AL$/.test(hn[1] || '')
        && /^ALERT2 · last .+ · not explained$/.test(hn[2] || ''),
      JSON.stringify(card['Heard on']));
    const shares = await page.evaluate(() => [...document.querySelectorAll('#stn-card .stn-card-heard .freq-share > i')]
      .map(i => [parseFloat(i.style.getPropertyValue('--freq-share')), i.className]));
    check('…with a bar of each channel\'s share of them, a channel nothing explains in amber',
      shares.length === 3 && Math.abs(shares[0][0] - 60) < 0.2 && Math.abs(shares[1][0] - 20) < 0.2
        && shares[2][1] === 'warn' && shares[0][1] === '', JSON.stringify(shares));
    check('the Radio tab opens with a summary that says so',
      card.summary && card.summary.includes('1 ALERT2 reading on 151.5375 MHz is not explained.'),
      JSON.stringify(card.summary));
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
      card && /^none within 20 km/.test(card['Assumed TX'].text)
        && /Kroombit Repeater AL, is 28\.\d km off — past the Max TX distance\./.test(card['Assumed TX'].text),
      JSON.stringify(card && card['Assumed TX']));
    check('…and nothing heard is called direct or relayed by a link it no longer assumes',
      card && /^ALERT · last .+ · relayed by Kroombit Repeater AL$/.test(card['Heard on'].notes[0] || ''),
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
      card && card['Assumed TX'] && card['Assumed TX'].text === 'no repeater carries its AlertIDs'
        && card['Heard on'] && /^could not ask the datastore/.test(card['Heard on'].text),
      JSON.stringify(card));
    mode = 'ok';

    log('\nLinks — its repeaters, and the base stations that hear it direct\n');
    // Greys Plains Rd AL (540317): carried by Bundamba (43 km), Hillcrest
    // (60 km) and Constitution Hill (62 km, a base too), assumed to transmit
    // on 151.500; Marburg Radar (24 km) is a base with no RX on record, SRRC
    // and Mt Stapylton are bases on record on 152.400 and 151.950. The page is
    // offline, so the fade margins are set by hand.
    const GP = 'grey_s_plains_rd_a';
    const FIG = { marburg_radar: 34.1, bundamba_barclay_st: 12, gatton_lvrc_enviromon_basestation: 4.2,
                  constitution_hill: -1.7, hillcrest_wine_glass: -18, '18_bateson': -3.2,
                  cogcc_bundall_base: -44.3, cogcc_ashmore_base: -45.8, cogcc_carrara_base: -48.3 };
    await page.evaluate(([id, fig]) => {
      state.mapMaxLinkKm = 100;
      for (const [b, m] of Object.entries(fig)) MapDirect._set(id, b, m);
      showStationCard(id);
      StnCardView.go('radio');
    }, [GP, FIG]);
    const lk = await page.evaluate(id => MapDirect._links(id), GP);
    const ids = xs => (xs || []).map(x => x.id || x);
    check('its links: the repeaters carrying it within the Max TX distance, and the base stations in range',
      lk && ['bundamba_barclay_st', 'hillcrest_wine_glass', 'constitution_hill'].every(x => ids(lk.carriers).includes(x))
        && ['marburg_radar', 'gatton_lvrc_enviromon_basestation', '18_bateson'].every(x => ids(lk.bases).includes(x))
        && !ids(lk.bases).includes('constitution_hill'), JSON.stringify(lk));
    check('…a base on record on another channel is left out; one with no RX on record is counted, unchecked',
      lk && lk.off.includes('srrc_base') && lk.off.includes('mt_stapylton_base') && lk.tx.join() === '151.5'
        && lk.bases.find(b => b.id === 'marburg_radar').check === 'unchecked'
        && lk.bases.find(b => b.id === 'cogcc_bundall_base').check === 'match', JSON.stringify(lk));
    card = await freqCard();
    const keys = card ? Object.keys(card) : [];
    const L = card && card.Links;
    const flat = v => v.replace(/\s+/g, ' ');
    check('the card lists them under Assumed TX, best fade margin first, in the link budget\'s bands',
      L && keys.indexOf('Links') === keys.indexOf('Assumed TX') + 1
        && JSON.stringify(L.links.map(flat)) === JSON.stringify([
          'Marburg Radar · +34.1 dB Good', 'Bundamba (Barclay St) AL · +12.0 dB Good',
          'GATTON LVRC ENVIROMON BASESTATION · +4.2 dB Marginal', 'Constitution Hill · −1.7 dB Poor',
          'Hillcrest AL (Wine Glass) · −18.0 dB Poor',
          // A repeater since decdc36 (Mt Marrow AL, stations.json); no figure is set for it here.
          'Mt Marrow AL · no fade margin']), JSON.stringify(L && L.links));
    const bars = await page.evaluate(() => [...document.querySelectorAll('#stn-card .stn-card-links .freq-link')].map(e => {
      const i = e.querySelector('.freq-bar > i');
      return i ? [e.dataset.mnLink, i.className, parseFloat(i.style.getPropertyValue('--freq-from')),
        parseFloat(i.style.getPropertyValue('--freq-len')), !!e.querySelector('.freq-cut')] : [e.dataset.mnLink];
    }));
    const bar = id => bars.find(b => b[0] === id) || [];
    const near = (a, b) => Math.abs(a - b) < 0.05;
    check('…each with a bar on one scale, −20 to +40 dB: out from 0 by its figure, in its band\'s colour',
      bars.length === 10 && bar('marburg_radar')[1] === 'ok' && near(bar('marburg_radar')[2], 100 / 3) && near(bar('marburg_radar')[3], 34.1 / 0.6)
        && bar('hillcrest_wine_glass')[1] === 'bad' && near(bar('hillcrest_wine_glass')[2], 2 / 0.6) && near(bar('hillcrest_wine_glass')[3], 30)
        && bar('gatton_lvrc_enviromon_basestation')[1] === 'warn'
        && bar('cogcc_bundall_base')[4] && near(bar('cogcc_bundall_base')[2], 0) && !bar('marburg_radar')[4], JSON.stringify(bars));
    check('the Radio tab\'s summary names its best link',
      card.summary && card.summary[0] === 'Best link: Marburg Radar, direct to base, +34.1 dB Good.', JSON.stringify(card.summary));
    check('…each saying what it is, in words a finger can read',
      L && L.notes[0] === 'base station · 24.1 km · hears it direct · channel not checked'
        && L.notes[1] === 'repeater · 43.4 km · carries it'
        && L.notes[3] === 'base and repeater · 62.4 km · carries it, likely second-hand', JSON.stringify(L && L.notes));
    const fold = () => page.evaluate(() => {
      const d = document.querySelector('#stn-card .stn-card-links details.freq-fold');
      return d ? { open: d.open, head: d.querySelector('summary').textContent.replace(/\s+/g, ' ').trim() } : null;
    });
    let fw = await fold();
    check('…the base stations too weak to hear it in a fold, closed, its count on it, best first inside',
      fw && !fw.open && fw.head === 'Too weak to hear it direct 4'
        && JSON.stringify(L.weak) === JSON.stringify(['18 Bateson · −3.2 dB Poor', 'CoGCC Bundall Base Station · −44.3 dB Poor',
          'CoGCC Ashmore Base Station · −45.8 dB Poor', 'CoGCC Carrara Base Station · −48.3 dB Poor']),
      JSON.stringify([fw, L.weak]));
    await page.click('#stn-card .stn-card-links details.freq-fold > summary');
    await page.evaluate(id => MapDirect._set(id, 'marburg_radar', 34.1), GP);
    fw = await fold();
    check('…which stays open when a figure lands and the block is drawn again', fw && fw.open, JSON.stringify(fw));
    check('…and those on another channel named, on a line',
      L.notes.includes('On another channel, not counted: SRRC Base Station (152.400 MHz), BoM Mt Stapylton Base Station (151.950 MHz)'),
      JSON.stringify(L.notes));
    const linkWords = await page.evaluate(() => ({
      links: document.querySelector('#stn-card .stn-card-links .freq-h .term')?.title || '',
      margin: document.querySelector('#stn-card .stn-card-links .freq-h > span .term')?.title || '',
      fold: [...document.querySelectorAll('#stn-card .freq-words dt')].map(e => e.textContent),
    }));
    check('…Links and Modelled fade margin say what they mean on hover, the bands in words under the bars, and every word in a fold',
      /fade margin/.test(linkWords.links) && /Good is 10 dB or more, Marginal 3 or more/.test(linkWords.margin)
        && /Good 10\+ Marginal 3–10 Poor under 3 modelled, not measured/.test(L.text)
        && ['Assumed TX', 'Links', 'Modelled fade margin', 'Too weak to hear it direct', 'Heard on', 'Not explained'].every(w => linkWords.fold.includes(w)),
      JSON.stringify(linkWords));
    const drawn = await page.evaluate(() => MapDirect._drawn().map(d => d.to).sort());
    check('the map draws a line to each base station that hears it, and to nothing else',
      JSON.stringify(drawn) === JSON.stringify(['gatton_lvrc_enviromon_basestation', 'marburg_radar']), JSON.stringify(drawn));
    check('…with a key in the legend while it does',
      await page.evaluate(() => !!document.querySelector('.legend-line-direct')));
    await page.click('#stn-card .stn-link[data-mn-link="marburg_radar"] button');
    check('a name opens that path\'s radio-path card, direct to base',
      await page.evaluate(() => { const c = MapBackbone.current(); return !!c && c.kind === 'direct' && c.bId === 'marburg_radar'; }));
    await page.evaluate(() => { state.mapMaxLinkKm = 20; refreshMapLayers({ skipFit: true }); });
    check('a shorter Max TX distance takes the lines past it off the map',
      await page.evaluate(() => MapDirect._drawn().length === 0));
    await page.evaluate(() => { state.mapMaxLinkKm = 100; refreshMapLayers({ skipFit: true }); });
    await page.evaluate(() => closeStnCard());
    check('…and the lines go with the card',
      await page.evaluate(() => MapDirect._drawn().length === 0 && !document.querySelector('.legend-line-direct')));
    check('a repeater\'s card has no Links line, and draws none',
      await page.evaluate(id => { showStationCard(id); return !document.querySelector('#stn-card .stn-card-links') && MapDirect._drawn().length === 0; },
        repeater.id));

    // The lines' pane is over the pins and links (400). With the map's
    // preferCanvas it used to get a canvas of its own the size of the map,
    // kept after the lines went: every click meant for a pin or a link landed
    // on it, and the map could only be panned until a reload. Real clicks,
    // because a click from code goes round the sheet.
    log('\nThe pins under the lines\n');
    const pinAt = id => page.evaluate(id => {
      const s = state.data.stations.find(x => x.id === id);
      const p = state.map.latLngToContainerPoint([s.lat, s.lon]);
      const box = state.map.getContainer().getBoundingClientRect();
      const el = document.elementFromPoint(box.left + p.x, box.top + p.y);
      return { x: box.left + p.x, y: box.top + p.y, on: !!el && !!el.closest('.leaflet-overlay-pane') };
    }, id);
    const MARBURG_VIEW = [[-27.62, 152.33], 11];
    await page.evaluate(id => { closeStnCard(); showStationCard(id); }, GP);
    await page.waitForFunction(() => MapDirect._drawn().length > 0, null, { timeout: 5000 });
    await page.evaluate(v => { closeStnCard(); state.map.setView(v[0], v[1], { animate: false }); }, MARBURG_VIEW);
    await page.waitForTimeout(400);
    let pin = await pinAt('marburg_radar');
    await page.mouse.click(pin.x, pin.y);
    await page.waitForTimeout(400);
    check('once the lines have been drawn and gone, a real click on a pin still opens its card',
      pin.on && await page.evaluate(() => !!state.stnCard && state.stnCard.id === 'marburg_radar'), JSON.stringify(pin));
    // The backstop in styles.css: a path some other layer puts in a pane of
    // its own over the links, with nothing said about the pointer.
    await page.evaluate(v => {
      closeStnCard();
      if (!state.map.getPane('mnCheckSheet')) state.map.createPane('mnCheckSheet').style.zIndex = 450;
      window.__sheet = L.polyline([[-27.0, 152.0], [-27.1, 152.1]], { pane: 'mnCheckSheet' }).addTo(state.map);
      state.map.setView(v[0], v[1], { animate: false });
    }, MARBURG_VIEW);
    await page.waitForTimeout(400);
    pin = await pinAt('marburg_radar');
    await page.mouse.click(pin.x, pin.y);
    await page.waitForTimeout(400);
    check('…as it does with a canvas some other layer leaves in a pane over the links',
      pin.on && await page.evaluate(() => !!state.stnCard && state.stnCard.id === 'marburg_radar'), JSON.stringify(pin));
    await page.evaluate(() => { window.__sheet.remove(); closeStnCard(); });
    await page.evaluate(([id, v]) => {
      MapBackbone.closeCard(); closeStnCard(); showStationCard(id); state.map.setView(v[0], v[1], { animate: false });
    }, [GP, MARBURG_VIEW]);
    await page.waitForFunction(() => MapDirect._drawn().length > 0, null, { timeout: 5000 });
    await page.waitForTimeout(400);
    const mid = await page.evaluate(id => {
      const a = state.data.stations.find(x => x.id === id), b = state.data.stations.find(x => x.id === 'marburg_radar');
      const p = state.map.latLngToContainerPoint([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2]);
      const box = state.map.getContainer().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    }, GP);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.click(mid.x, mid.y);
    await page.waitForTimeout(400);
    check('…and a real click on a line to a base still opens its radio-path card',
      await page.evaluate(() => { const c = MapBackbone.current(); return !!c && c.kind === 'direct' && c.bId === 'marburg_radar'; }),
      JSON.stringify(mid));

    // The pins first for the pointer (pinFirstCanvas, app.js). The path just
    // opened is drawn as the elevation profile's line, after the pins, ending
    // dead on Marburg's pin — which, on Leaflet's own rule (the last drawn
    // wins), could not be clicked until the line went.
    await page.evaluate(v => { MapBackbone.closeCard(); closeStnCard(); state.map.setView(v[0], v[1], { animate: false }); }, MARBURG_VIEW);
    await page.waitForTimeout(400);
    const over = await page.evaluate(id => {
      const s = state.data.stations.find(x => x.id === id);
      const pt = state.map.latLngToLayerPoint([s.lat, s.lon]);
      const r = state.map.options.renderer;
      let last = null;
      for (let o = r._drawFirst; o; o = o.next) if (o.layer.options.interactive && o.layer._containsPoint(pt)) last = o.layer;
      return { pathOpen: !!(state.path && state.path.open), lastIsPin: !!last && last.mnStationId === id };
    }, 'marburg_radar');
    pin = await pinAt('marburg_radar');
    await page.mouse.move(pin.x, pin.y);
    await page.mouse.click(pin.x, pin.y);
    await page.waitForTimeout(400);
    check('a pin at the end of the elevation profile\'s line, drawn over it, still takes the click',
      over.pathOpen && !over.lastIsPin && await page.evaluate(() => !!state.stnCard && state.stnCard.id === 'marburg_radar'),
      JSON.stringify(over));
    await page.evaluate(v => {
      closeStnCard();
      window.__overPin = 0;
      const s = state.data.stations.find(x => x.id === 'marburg_radar');
      window.__cover = L.circle([s.lat, s.lon], { radius: 3000, color: '#c2185b' })
        .on('click', () => { window.__overPin++; }).addTo(state.map);
      state.map.setView(v[0], v[1], { animate: false });
    }, MARBURG_VIEW);
    await page.waitForTimeout(400);
    pin = await pinAt('marburg_radar');
    await page.mouse.move(pin.x, pin.y);
    await page.mouse.click(pin.x, pin.y);
    await page.waitForTimeout(400);
    const inside = await page.evaluate(() => ({ card: state.stnCard && state.stnCard.id, cover: window.__overPin,
      cursor: state.map.getContainer().querySelector('.leaflet-overlay-pane canvas').classList.contains('leaflet-interactive') }));
    check('…and so does a pin under a circle drawn after it, the circle not hearing the click',
      inside.card === 'marburg_radar' && inside.cover === 0 && inside.cursor, JSON.stringify(inside));
    const beside = await page.evaluate(id => {
      const s = state.data.stations.find(x => x.id === id);
      const p = state.map.latLngToContainerPoint([s.lat, s.lon]);
      const box = state.map.getContainer().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y + 25 };
    }, 'marburg_radar');
    await page.evaluate(() => closeStnCard());
    await page.mouse.click(beside.x, beside.y);
    await page.waitForTimeout(300);
    check('…while the circle off the pin still takes its own click',
      await page.evaluate(() => window.__overPin === 1), JSON.stringify(beside));
    await page.evaluate(() => { window.__cover.remove(); closeStnCard(); });

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
    await phone.page.evaluate(([id, fig]) => {
      for (const [b, m] of Object.entries(fig)) MapDirect._set(id, b, m);
      showStationCard(id);
      StnCardView.go('radio');
    }, [GP, FIG]);
    const pw = await phone.page.evaluate(() => {
      const row = document.querySelector('#stn-card .stn-card-links');
      const card = document.getElementById('stn-card').getBoundingClientRect();
      const out = row ? [...row.querySelectorAll('*')].some(e => { const b = e.getBoundingClientRect(); return b.width && b.right > card.right + 1; }) : true;
      return [document.documentElement.scrollWidth, document.documentElement.clientWidth, out];
    });
    check('at 375 px the card\'s Links fit, and the page does not scroll sideways', pw[0] <= pw[1] && !pw[2], JSON.stringify(pw));
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
