// Claiming an address from the message that arrived on it (#172).
//
// Why this file exists rather than another block in tabs.mjs: tabs.mjs asks
// whether every converted tab uses the design system, which is a question about
// markup. This asks whether the Message Log's claim actually claims — a question
// about a write, an announcement, and what the tab does with what came back.
// Constraint 1 on the roadmap is that a change invisible to the existing checks
// grows a check of its own, and the two defects this caught while it was being
// written were both invisible to all seven of them.
//
// The datastore is stubbed at dbRpc, deliberately. The database half of this is
// proven against a real Postgres by tools/check_mqtt.sql — sixteen checks, and
// they cover the back-fill and both refusals. What cannot be proven there is the
// part that lives in a browser: that an unresolved relayed row offers the claim
// at all, that the picker sends the *station address* rather than the sensor
// slot, and that the tab does not go on showing a form for a write that has
// already landed.
//
//   node --run claim        (or: npm run claim)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;

// The row the bench unit really sent, on the topic it really sent it on.
const RELAYED = {
  addr: 'a2:1003/13', alert_id: null, a2_station: 1003, a2_sensor: 13,
  station_number: null, channel: '', station_id: null,
  reading_ts: '2026-03-01T04:05:00+00:00', received_at: '2026-03-01T04:05:03+00:00',
  value_raw: 155.6, value: null, unit: null, conversion: null,
  quality: 0, protocol: 5, source: 2,
  path: 'meganet/v1/elpro_test/logger/reading/elpro/Station 1003',
  dup_count: 0, dup_paths: [], last_dup_at: null, raw_id: null,
};
const RELAYED_KEY = 'a2:1003/13|2026-03-01T04:05:00+00:00|155.6';

// And an ordinary ALERT-addressed one, because the other door has to work too.
const RADIO = {
  addr: 'a:6128', alert_id: 6128, a2_station: null, a2_sensor: null,
  station_number: null, channel: '', station_id: null,
  reading_ts: '2026-03-01T04:15:00+00:00', received_at: '2026-03-01T04:15:32+00:00',
  value_raw: 12, value: null, unit: null, conversion: null,
  quality: 0, protocol: 1, source: 2, path: null,
  dup_count: 0, dup_paths: [], last_dup_at: null, raw_id: null,
};
const RADIO_KEY = 'a:6128|2026-03-01T04:15:00+00:00|12';

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  const reads = [];
  page.on('request', r => { if (/\/reading\?/.test(r.url())) reads.push(r.url().slice(0, 60)); });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  const out = await page.evaluate(async ([relayed, relayedKey, radio, radioKey]) => {
    const main = () => document.getElementById('main-content');
    const settle = () => new Promise(r => setTimeout(r, 40));
    // toggleRow() is a toggle, and adoptRows() keeps whichever row was open —
    // so calling it a second time on the same key closes the drawer this test
    // is trying to read. Ask for the state instead of assuming it.
    const openRow = async (key) => {
      if (!main().querySelector('.ml-det-grid')) MessageLog.toggleRow(key);
      await settle();
    };
    const log = { calls: [] };

    switchTab('msglog');
    await settle();

    // Signed out first: the claim is a write, and a tab that offers one to
    // somebody who cannot make it is a tab that produces a 401 for a click.
    window.dbCanWrite = () => false;
    MessageLog.adoptRows([relayed]);
    await openRow(relayedKey);
    log.signedOutText = main().textContent;

    // Now as an editor, with the RPC captured rather than sent.
    window.dbCanWrite = () => true;
    window.dbRpc = async (fn, args) => {
      log.calls.push({ fn, args });
      if (fn === 'claim_alert_address') {
        return { station_id: args.p_station_id, name: 'Picked Station',
                 alert_id: args.p_alert_id, sensor_id: `${args.p_station_id}:${args.p_alert_id}`,
                 claimed: 2 };
      }
      return { station_id: args.p_station_id, name: 'Picked Station',
               a2_station: args.p_a2_station, claimed: 183, sensors_seen: 2 };
    };
    MessageLog.adoptRows([relayed]);
    await openRow(relayedKey);
    log.offersClaim = /Attribute to a station/.test(main().textContent);
    log.pairInCell = [...main().querySelectorAll('td')]
      .map(td => td.textContent.trim()).find(t => t.startsWith('a2 ')) || '(none)';

    MessageLog.claimOpen(relayedKey);
    await settle();
    log.asksWhich = /Which station is relayed ALERT2 station 1003\?/.test(main().textContent);
    log.saysScope = /every slot on station 1003, not only slot 13/.test(main().textContent);

    const st = state.data.stations[0];
    log.stationId = st.id;
    MessageLog.claimSearch(st.name.slice(0, 6));
    await settle();
    log.hits = main().querySelectorAll('.ml-claim-hit').length;

    await MessageLog.claimPick(st.id);
    await settle();
    log.pickerClosed = !main().querySelector('.ml-claim');
    log.gotAddress = state.data.stations.find(x => x.id === st.id)?.alert2_station_id;
    log.announced = document.getElementById('app-status')?.textContent || '';

    // A successful claim re-queries in the background. Let that land before the
    // next scenario adopts its own rows, or the late answer replaces them
    // half-way through and the scenario runs against somebody else's row.
    await new Promise(r => setTimeout(r, 400));

    // A fresh relayed station for this one. The row above is *not* unresolved
    // any more — the claim above put its address on the station, so it now
    // resolves and the drawer offers "Show on the Stations tab" instead. That
    // is the feature working, and it is asserted below.
    log.claimedRowNowResolves = /Show on the Stations tab/.test(main().textContent);

    // The refusal path: the database's own sentence, and the form left standing.
    window.dbRpc = async () => {
      const e = new Error('ALERT2 station 1004 already belongs to loudoun_br_al — pass p_replace to move it');
      e.status = 400;
      throw e;
    };
    const other = { ...relayed, addr: 'a2:1004/13', a2_station: 1004 };
    const otherKey = 'a2:1004/13|2026-03-01T04:05:00+00:00|155.6';
    MessageLog.toggleRow(relayedKey);           // close the resolved one
    await settle();
    MessageLog.adoptRows([other]);
    await openRow(otherKey);
    MessageLog.claimOpen(otherKey);
    MessageLog.claimSearch(st.name.slice(0, 6));
    await settle();
    await MessageLog.claimPick(st.id);
    await settle();
    log.refusalShown = /already belongs to loudoun_br_al/.test(main().textContent);
    log.formStillUp = !!main().querySelector('.ml-claim');
    MessageLog.claimClose();
    await new Promise(r => setTimeout(r, 400));

    // The other door: a plain ALERT address.
    window.dbRpc = async (fn, args) => { log.calls.push({ fn, args }); return {
      station_id: args.p_station_id, name: 'Picked Station', alert_id: args.p_alert_id,
      sensor_id: `${args.p_station_id}:${args.p_alert_id}`, claimed: 2 }; };
    MessageLog.adoptRows([radio]);
    await openRow(radioKey);
    MessageLog.claimOpen(radioKey);
    MessageLog.claimSearch(st.name.slice(0, 6));
    await settle();
    await MessageLog.claimPick(st.id);
    await settle();
    log.radioSensor = (state.data.stations.find(x => x.id === st.id)?.sensors || [])
      .some(x => x.alert_id === 6128);

    return log;
  }, [RELAYED, RELAYED_KEY, RADIO, RADIO_KEY]);

  console.log('\nWhat an unresolved relayed row shows');
  ok('the AlertID cell carries the pair, not the slot on its own',
     out.pairInCell === 'a2 1003/13', out.pairInCell);
  ok('signed out, it says to sign in rather than offering the claim',
     /Sign in as an editor/.test(out.signedOutText)
       && !/Attribute to a station/.test(out.signedOutText));
  ok('signed in as an editor, it offers to attribute the message', out.offersClaim);

  console.log('\nThe picker');
  ok('it names the relayed station, which is what is being claimed', out.asksWhich);
  ok('and says the claim covers every slot on it, not the one on screen', out.saysScope);
  ok('typing part of a name finds stations', out.hits > 0, `${out.hits} hits`);

  console.log('\nWhat the claim sends, and what it does with the answer');
  const a2 = out.calls.find(c => c.fn === 'claim_a2_station');
  ok('it sends the ALERT2 station address', a2 && a2.args.p_a2_station === 1003,
     JSON.stringify(a2));
  ok('never the sensor slot, which names nothing on its own',
     a2 && a2.args.p_a2_station !== 13);
  ok('and the station that was picked', a2 && a2.args.p_station_id === out.stationId);
  ok('the address lands on the station in memory, so the next render resolves it',
     out.gotAddress === 1003, String(out.gotAddress));
  ok('it announces how many readings the one click claimed, not that it worked',
     /183 readings claimed/.test(out.announced), out.announced);
  ok('the picker closes on the write, not on the read that follows it',
     out.pickerClosed);
  ok('and the rows are re-queried rather than patched in place',
     reads.length > 0, 'no read issued after the claim');
  ok('the claimed row stops offering the claim and offers the station instead',
     out.claimedRowNowResolves);

  console.log('\nWhen the datastore refuses');
  ok('it shows the database\'s own sentence', out.refusalShown);
  ok('and leaves the picker up, so the answer is still reachable', out.formStillUp);

  console.log('\nThe other door — a plain ALERT address');
  const al = out.calls.find(c => c.fn === 'claim_alert_address');
  ok('an ALERT-addressed row claims through claim_alert_address',
     al && al.args.p_alert_id === 6128, JSON.stringify(al));
  ok('and the sensor lands on the station in memory', out.radioSensor);

  console.log('\nConsole');
  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures
  ? `\nFAIL — ${failures} check(s) failed.`
  : '\nPASS — a message can name the station it came from, and the claim carries\n'
    + '       the address rather than the slot.');
process.exit(failures ? 1 : 0);
