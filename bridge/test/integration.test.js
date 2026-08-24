// The acceptance criteria of #B6, against a real MQTT broker and a real client.
//
// aedes is the broker, in-process on an ephemeral port, and a small HTTP server
// stands in for PostgREST so a test can make the database fail on demand. What
// is *not* faked is the part that is easy to get wrong: the MQTT client, QoS 1,
// the session, the acks, and the redelivery that the no-loss promise rests on.
//
//   - a test client publishing to meganet/v1/… results in a stored reading
//   - a station going offline is visible via its LWT
//   - the database failing does not ack, and does not lose the reading: the
//     bridge holds it and keeps trying until the database is back
//   - a duplicate delivery is relayed unchanged, for the primary key to eat
//   - a topic outside the scheme is acked and ignored, never a wedge
//   - a broker restart is survived without an operator

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { Aedes } = require('aedes');
const mqtt = require('mqtt');

const { loadConfig } = require('../src/config');
const { createBridge } = require('../src/bridge');
const { SUBSCRIPTIONS } = require('../src/topics');
const { createLogger } = require('../src/log');

const QUIET = { write() {} }; // the bridge's logs, not the test runner's problem

async function startBroker(port = 0, opts = {}) {
  // createBroker(), not `new Aedes()`: the constructor leaves the persistence
  // uninitialised and the broker silently never answers a CONNECT.
  const broker = await Aedes.createBroker(opts);
  const subscribed = new Set();
  const acks = [];
  let subscribes = 0;
  broker.on('subscribe', (_subs, client) => { subscribed.add(client.id); subscribes += 1; });
  // The acknowledgement that actually matters. A publisher's own PUBACK comes
  // from the *broker* and says nothing about the bridge; this one is the bridge
  // telling the broker it may forget the message, which it must not do until the
  // reading is stored.
  // packet is undefined for a message acked out of the offline queue (the
  // persistence layer clears it by id without rehydrating the whole packet),
  // which is exactly the no-loss test's path — an ack with no topic is still
  // an ack.
  broker.on('ack', (packet, client) => acks.push({ client: client.id, topic: packet ? packet.topic : null }));
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    broker,
    subscribed,
    acks,
    bridgeAcks: () => acks.filter((a) => a.client === 'test-bridge'),
    get subscribes() { return subscribes; },
    port: server.address().port,
    async close() {
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startApi() {
  const calls = [];
  let mode = 'ok';
  // Per-function transient failures: set `failures.mqtt_status = 2` and the
  // next two calls to that function answer 503, then it recovers. This is how
  // the mid-connection retry test makes the sink blink without going down.
  const failures = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const fn = req.url.split('/').pop();
      calls.push({ fn, body: JSON.parse(body || '{}'), token: req.headers['x-ingest-token'] });
      if ((mode === 'down' && fn === 'ingest_http') || failures[fn] > 0) {
        if (failures[fn] > 0) failures[fn] -= 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'the database is having a moment' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [], raw_id: calls.length }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    of: (fn) => calls.filter((c) => c.fn === fn),
    set mode(value) { mode = value; },
    failures,
    url: `http://127.0.0.1:${server.address().port}/rest/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startBridge(brokerPort, apiUrl, extra = {}, stream = QUIET) {
  const config = loadConfig({
    MQTT_URL: `mqtt://127.0.0.1:${brokerPort}`,
    MQTT_ALLOW_INSECURE: '1',
    MQTT_CLIENT_ID: 'test-bridge',
    MEGANET_API_URL: apiUrl,
    MEGANET_API_KEY: 'test-publishable-key',
    MEGANET_INGEST_TOKEN: 'mgn_test_token',
    BRIDGE_BATCH_MS: '50',
    BRIDGE_HEARTBEAT_MS: '0',
    BRIDGE_RETRY_MAX_MS: '1000',
    MQTT_RECONNECT_BASE_MS: '100',
    ...extra,
  });
  const bridge = createBridge(config, {
    log: createLogger({ level: 'error', bridgeId: 'test-bridge', stream }),
  });
  bridge.start();
  return bridge;
}

/** A log stream that keeps every line as a parsed object, for asserting on. */
function captureLog() {
  const lines = [];
  return {
    lines,
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) { try { lines.push(JSON.parse(line)); } catch { /* not ours */ } }
      }
    },
    of: (event) => lines.filter((l) => l.event === event),
  };
}

const open = [];

async function connectStation(port, station, opts = {}) {
  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, {
    clientId: `station-${station}-${Math.random().toString(16).slice(2)}`,
    clean: true,
    reconnectPeriod: 0,
    ...opts,
  });
  // Tracked so a failing assertion still leaves the broker closeable: an open
  // socket makes server.close() wait forever, and a hung test tells you nothing
  // about which assertion failed.
  open.push(client);
  return client;
}

async function closeStations() {
  await Promise.all(open.splice(0).map((c) => c.endAsync(true).catch(() => {})));
}

async function waitFor(predicate, { timeout = 5000, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const got = await predicate();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a test client publishing to meganet/v1/… results in a stored reading', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  const station = await connectStation(broker.port, '541155');
  let acked = false;
  await new Promise((resolve, reject) => {
    station.publish(
      'meganet/v1/541155/logger/reading',
      JSON.stringify({ alert_id: 6128, reading_ts: '2026-08-12T04:15:00Z', value_raw: 301 }),
      { qos: 1 },
      (err) => { if (err) reject(err); else { acked = true; resolve(); } },
    );
  });
  assert.ok(acked, 'the broker never PUBACKed the publish');

  const call = await waitFor(() => api.of('ingest_http')[0], { what: 'the reading to be posted' });
  assert.equal(call.token, 'mgn_test_token');
  assert.equal(call.body.payload.source, 'mqtt');
  assert.deepEqual(call.body.payload.readings, [
    { alert_id: 6128, reading_ts: '2026-08-12T04:15:00Z', value_raw: 301 },
  ]);

  // and the station is recorded as having been heard from
  const seen = await waitFor(() => api.of('mqtt_seen')[0], { what: 'mqtt_seen' });
  // The segment travels verbatim: the bridge takes no view on identity,
  // and meganet.resolve_publisher() folds the number to the station id
  // in the database (0020).
  assert.equal(seen.body.p_station, '541155');

});

test('a station going offline is visible via its LWT', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  // A repeater: no bureau number, so it publishes under its station id —
  // the fallback half of the 0020 rule.
  const station = await connectStation(broker.port, 'mt_mowbullan_rptr', {
    will: {
      topic: 'meganet/v1/mt_mowbullan_rptr/status',
      payload: JSON.stringify({ online: false }),
      qos: 1,
      retain: true,
    },
  });

  await station.publishAsync(
    'meganet/v1/mt_mowbullan_rptr/status',
    JSON.stringify({ online: true, battery_v: 12.9 }),
    { qos: 1, retain: true },
  );

  const up = await waitFor(() => api.of('mqtt_status')[0], { what: 'the status message' });
  assert.equal(up.body.payload.online, true);
  assert.equal(up.body.payload.station, 'mt_mowbullan_rptr');
  assert.deepEqual(up.body.payload.status, { battery_v: 12.9 });

  // The station's link drops without a DISCONNECT — a radio going quiet, not a
  // logger shutting down politely — which is when a broker publishes the will.
  station.stream.destroy();

  const down = await waitFor(() => api.of('mqtt_status').find((c) => c.body.payload.online === false),
    { what: 'the last will' });
  assert.equal(down.body.payload.station, 'mt_mowbullan_rptr');
});

test('the database failing does not ack, and the reading lands when it returns', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  api.mode = 'down';
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  const station = await connectStation(broker.port, 'mt_stuart');
  await station.publishAsync(
    'meganet/v1/mt_stuart/logger/reading',
    JSON.stringify({ alert_id: 6129, reading_ts: '2026-08-12T04:20:00Z', value_raw: 7 }),
    { qos: 1 },
  );

  await waitFor(() => api.of('ingest_http').length >= 2, { what: 'the bridge to retry' });
  assert.deepEqual(broker.bridgeAcks(), [],
    'the bridge acked a reading the database had refused — the broker would have forgotten it');

  // The database comes back. Nothing else happens: no reconnect, no operator,
  // no redelivery. The bridge is still holding the reading and still trying.
  api.mode = 'ok';

  const acks = await waitFor(() => (broker.bridgeAcks().length ? broker.bridgeAcks() : null),
    { timeout: 20_000, what: 'the reading to be stored and acked' });
  assert.equal(acks[0].topic, 'meganet/v1/mt_stuart/logger/reading');

  const stored = api.of('ingest_http').at(-1);
  assert.equal(stored.body.payload.readings[0].alert_id, 6129);
});

test('a duplicate delivery is relayed unchanged, for the primary key to eat', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url, { BRIDGE_BATCH_MS: '10' });
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  const station = await connectStation(broker.port, 'durikai_al');
  const reading = { alert_id: 6130, reading_ts: '2026-08-12T04:25:00Z', value_raw: 42 };

  // The same reading twice, which is what QoS 1 promises may happen and what a
  // repeater network does anyway. The bridge relays both: deduplication is
  // meganet.reading's primary key, not a guess made in this process.
  for (let i = 0; i < 2; i += 1) {
    await station.publishAsync('meganet/v1/durikai_al/logger/reading', JSON.stringify(reading), { qos: 1 });
    await new Promise((r) => setTimeout(r, 40));
  }

  await waitFor(() => api.of('ingest_http').length === 2, { what: 'both copies' });
  for (const call of api.of('ingest_http')) {
    assert.deepEqual(call.body.payload.readings, [reading]);
  }

});

test('a topic outside the scheme is acked and ignored, never a wedge', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  const station = await connectStation(broker.port, 'stray');
  // Neither of these matches the bridge's subscriptions, so the broker will not
  // even deliver them — which is the first line of defence. What is being proved
  // is that the *next* good message still gets through.
  await station.publishAsync('meganet/v1/stray_al/logger/bogus', 'nonsense', { qos: 1 });
  await station.publishAsync('meganet/v2/stray_al/logger/reading', 'nonsense', { qos: 1 });
  // A payload that will never parse, on a topic that does match: this one the
  // bridge must ack itself, or it comes back forever with the queue behind it.
  await station.publishAsync('meganet/v1/stray_al/logger/reading', '{not json', { qos: 1 });

  await station.publishAsync(
    'meganet/v1/stray_al/logger/reading',
    JSON.stringify({ alert_id: 6131, reading_ts: '2026-08-12T04:30:00Z', value_raw: 1 }),
    { qos: 1 },
  );

  const call = await waitFor(() => api.of('ingest_http')[0], { what: 'the good reading' });
  assert.equal(call.body.payload.readings[0].alert_id, 6131);
  assert.equal(api.of('ingest_http').length, 1, 'the unparseable payload reached the database');

  // Both the ignorable message and the good one are acked, so neither is still
  // sitting in front of the next reading.
  await waitFor(() => broker.bridgeAcks().length === 2, { what: 'both messages to be acked' });
});

test('a broker restart is survived without an operator', async (t) => {
  const first = await startBroker();
  const api = await startApi();
  const bridge = startBridge(first.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await first.close();
  });

  await waitFor(() => first.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  // The broker goes away — a restart, a rescheduled container, a network drop.
  await closeStations();
  await first.close();
  await waitFor(() => bridge.health.state.connected === false, { what: 'the bridge to notice' });

  // …and comes back on the same address, with no memory of anything.
  const second = await startBroker(first.port);
  t.after(async () => { await second.close(); });

  await waitFor(() => second.subscribed.has('test-bridge'),
    { timeout: 20_000, what: 'the bridge to reconnect and resubscribe on its own' });

  const station = await connectStation(second.port, 'after_restart_al');
  await station.publishAsync(
    'meganet/v1/after_restart_al/logger/reading',
    JSON.stringify({ alert_id: 6132, reading_ts: '2026-08-12T05:00:00Z', value_raw: 3 }),
    { qos: 1 },
  );

  const call = await waitFor(() => api.of('ingest_http')[0], { what: 'a reading after the restart' });
  assert.equal(call.body.payload.readings[0].alert_id, 6132);
});

test('an HFEM line published to …/reading/hfem lands decoded, mapped and framed (#155)', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  const station = await connectStation(broker.port, 'gairloch_wharf');
  const line = ':HS=1|M=1|I1=123456|T3=20100727130000-10|R_1-0=1055|B_1-16=13.9|NN:';
  // A malformed line first — truncated mid-message, no NN footer. The bridge
  // must ack it itself (it will never parse) so the good line behind it moves.
  await station.publishAsync('meganet/v1/gairloch_wharf/logger/reading/hfem', ':HS=1|I1=123456|R_1-0=', { qos: 1 });
  await station.publishAsync('meganet/v1/gairloch_wharf/logger/reading/hfem', line, { qos: 1 });

  const call = await waitFor(() => api.of('ingest_http')[0], { what: 'the decoded readings' });
  assert.equal(call.body.payload.source, 'mqtt');
  assert.equal(call.body.payload.protocol, 'hfem');
  assert.equal(call.body.payload.frame, line);
  assert.deepEqual(call.body.payload.readings, [
    { station_number: '123456', channel: 'R_1', reading_ts: '2010-07-27T03:00:00Z',
      value_raw: 1055, unit: 'count', quality: 'maintenance' },
    { station_number: '123456', channel: 'B_1', reading_ts: '2010-07-27T03:00:00Z',
      value: 13.9, value_raw: 13.9, unit: 'V', quality: 'maintenance' },
  ]);
  assert.equal(api.of('ingest_http').length, 1, 'the malformed line reached the database');

  // Both messages acked: the poison one by the bridge's own hand, the good one
  // because its readings were stored.
  await waitFor(() => broker.bridgeAcks().length === 2, { what: 'both HFEM messages to be acked' });
});

test('an ELPRO payload lands decoded, and an unreadable one still lands its bytes (#166/#167)', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });

  const station = await connectStation(broker.port, 'elpro_test');
  const topic = 'meganet/v1/elpro_test/logger/reading/elpro';

  // What the device sends when it has been configured off the test card: the
  // Payload Prefix is the ALERT address, so the JSON key IS the address.
  const good = '{"timestamp":954711743792,"9001":17.61,"9003":13.8356}';
  // And what it might send instead. This is the whole reason the elpro parser
  // does not throw: nobody here has had a 115E-2 on a bench, so a shape the
  // vendor's guide did not describe must reach the database rather than an
  // ephemeral container log. Zero readings, bytes preserved.
  const unreadable = 'ELPRO 115E-2 <not json at all>';

  await station.publishAsync(topic, good, { qos: 1 });
  await station.publishAsync(topic, unreadable, { qos: 1 });

  // One POST each: `frame` differs per message, so groupByEnvelope never merges
  // two ELPRO messages — merging them would merge the evidence.
  await waitFor(() => api.of('ingest_http').length === 2, { what: 'both ELPRO messages to reach the database' });
  const calls = api.of('ingest_http').map((c) => c.body.payload);

  const decoded = calls.find((p) => p.frame === good);
  assert.ok(decoded, 'the readable payload reached the database');
  assert.equal(decoded.source, 'mqtt');
  assert.equal(decoded.protocol, 'elpro');
  assert.deepEqual(decoded.readings, [
    { alert_id: 9001, reading_ts: 954711743792, value_raw: 17.61 },
    { alert_id: 9003, reading_ts: 954711743792, value_raw: 13.8356 },
  ]);

  const captured = calls.find((p) => p.frame === unreadable);
  assert.ok(captured, 'the unreadable payload reached the database anyway');
  assert.equal(captured.protocol, 'elpro');
  assert.deepEqual(captured.readings, [], 'nothing claimed, everything kept');

  // Both acked — the second one because its bytes were stored, not because the
  // bridge gave up on it.
  await waitFor(() => broker.bridgeAcks().length === 2, { what: 'both ELPRO messages to be acked' });
});

test('a 115E-2 publishing what it really publishes lands a reading (#169)', async (t) => {
  // The end-to-end case the bench found and neither half of the docs predicted:
  // the gateway appends its own tree below the format segment, and wraps the
  // payload in an array with the address in a `Sensor` field. Before this test
  // the topic matched no subscription at all, so the broker never forwarded it
  // — nothing reached the bridge, nothing reached its log, and a correctly
  // provisioned unit was indistinguishable from a broken one.
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });
  const station = await connectStation(broker.port, 'elpro_test');

  const topic = 'meganet/v1/elpro_test/logger/reading/elpro/Station 1003';
  const payload = '[{"timestamp":1787288492180, "Sensor":13, "Value":243.600006}]';
  await station.publishAsync(topic, payload, { qos: 1 });

  await waitFor(() => api.of('ingest_http').length === 1, { what: 'the reading to reach the database' });
  const body = api.of('ingest_http')[0].body.payload;
  assert.equal(body.protocol, 'elpro');
  // The identity is the pair. `Sensor 13` is a slot inside the relayed station,
  // and the station half exists only in that topic tail — which is why #169
  // storing the slot alone put two instruments under one address.
  assert.deepEqual(body.readings, [
    { a2_station: 1003, a2_sensor: 13, reading_ts: 1787288492180, value_raw: 243.600006 },
  ]);
  assert.equal(body.frame, payload);
  // The relayed station is provenance the payload does not carry, so the raw row
  // has to say it — otherwise the only record of which station a reading came
  // off is a debug log line that ages out.
  assert.equal(body.path, topic);

  await waitFor(() => broker.bridgeAcks().length === 1, { what: 'the message to be acked' });
});

test('two relayed stations sending the same sensor slot stay two readings (#172)', async (t) => {
  // The defect this pair exists to close, end to end. The live bench feed sends
  // slot 10 from Station 1000 and slot 10 from Station 1001 — an RSSI at each of
  // two sites. Read as ALERT addresses they are both `a:10`: 385 rows in the
  // live database, two instruments, one identity, and nothing able to tell them
  // apart afterwards.
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });
  const station = await connectStation(broker.port, 'elpro_test');

  const base = 'meganet/v1/elpro_test/logger/reading/elpro';
  // Station 1001's frame also carries slot 0, which isAlertId() dropped on every
  // cycle for being "not an address". A slot is not an address.
  await station.publishAsync(`${base}/Station 1000`,
    '[{"timestamp":1787529190675,"Sensor":10,"Value":-101}]', { qos: 1 });
  await station.publishAsync(`${base}/Station 1001`,
    '[{"timestamp":1787527586386,"Sensor":10,"Value":-90},{"timestamp":1787527586385,"Sensor":0,"Value":1690}]',
    { qos: 1 });

  await waitFor(() => api.of('ingest_http').length === 2,
    { what: 'both relayed stations to reach the database' });

  const posted = api.of('ingest_http').flatMap((c) => c.body.payload.readings);
  const identity = (r) => `${r.a2_station}/${r.a2_sensor}`;
  assert.deepEqual(posted.map(identity).sort(), ['1000/10', '1001/0', '1001/10']);
  assert.equal(new Set(posted.map(identity)).size, 3, 'three slots, three identities');
  assert.ok(posted.every((r) => r.alert_id === undefined),
    'a relayed slot is never posted as an ALERT address');
});

test('a tail that names no relayed station mints no reading, and keeps every byte (#172)', async (t) => {
  // The gateway publishes its own devices down the same tree — `Broker
  // Diagnostics`, `System Info`. There is no station address to be had from
  // those, and inventing one is what #169 effectively did. The raw row still
  // gets the bytes, which is the whole reason reading_raw exists.
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });
  const station = await connectStation(broker.port, 'elpro_test');

  const topic = 'meganet/v1/elpro_test/logger/reading/elpro/Broker Diagnostics';
  const payload = '[{"timestamp":1787529190675,"Sensor":10,"Value":-101}]';
  await station.publishAsync(topic, payload, { qos: 1 });

  await waitFor(() => api.of('ingest_http').length === 1, { what: 'the raw row to be posted' });
  const body = api.of('ingest_http')[0].body.payload;
  assert.deepEqual(body.readings, [], 'nothing is claimed');
  assert.equal(body.frame, payload, 'the evidence survives');
  assert.equal(body.path, topic);

  await waitFor(() => broker.bridgeAcks().length === 1, { what: 'the message to be acked' });
});

test('a bridge that was down loses nothing: the broker held the hour and hands it back (#163)', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  t.after(async () => {
    await closeStations();
    await api.close();
    await broker.close();
  });

  // A first bridge connects — which is what creates the persistent session and
  // its subscriptions on the broker — and then goes away. clean: false plus the
  // stable client id is the whole promise under test: the broker must keep the
  // session, and queue QoS 1 messages for it, while nothing is connected.
  const first = startBridge(broker.port, api.url);
  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the first bridge to subscribe' });
  await first.stop();

  // Into the absence: five readings and a retained status.
  const station = await connectStation(broker.port, 'outage_al');
  const published = [6201, 6202, 6203, 6204, 6205];
  for (const id of published) {
    await station.publishAsync(
      'meganet/v1/outage_al/logger/reading',
      JSON.stringify({ alert_id: id, reading_ts: '2026-08-18T02:00:00Z', value_raw: id - 6200 }),
      { qos: 1 },
    );
  }
  await station.publishAsync(
    'meganet/v1/outage_al/status',
    JSON.stringify({ online: true, battery_v: 12.1 }),
    { qos: 1, retain: true },
  );
  // Only the bridge's own heartbeats (one at start, one at stop) may have
  // reached the API — no reading and no status, because nothing was connected
  // to relay them.
  assert.equal(api.of('ingest_http').length + api.of('mqtt_status').length, 0,
    'a reading or status reached the API while no bridge was running');

  // The replacement process connects with the same client id — a restart, a
  // redeploy, a rescheduled container — and the broker hands over the backlog.
  const second = startBridge(broker.port, api.url);
  t.after(async () => { await second.stop(); });

  await waitFor(() => {
    const got = api.of('ingest_http').flatMap((c) => c.body.payload.readings.map((r) => r.alert_id));
    return published.every((id) => got.includes(id)) ? got : null;
  }, { timeout: 10_000, what: 'every queued reading to be stored' });

  // Stored exactly once each, per the acceptance: count what was stored, not
  // what was delivered. (Redeliveries would be eaten by the primary key in
  // production; here even the delivery count should be clean, since nothing
  // was acked and nothing was duplicated.)
  const stored = api.of('ingest_http').flatMap((c) => c.body.payload.readings.map((r) => r.alert_id));
  assert.deepEqual([...stored].sort(), published.map(String).map(Number).sort(),
    'every reading published into the outage stored, none twice');

  const status = await waitFor(() => api.of('mqtt_status')[0], { what: 'the retained status' });
  assert.equal(status.body.payload.station, 'outage_al');
  assert.equal(status.body.payload.online, true);
});

test('a broker granting QoS 0 is called out loud — subscribe_downgraded (#163)', async (t) => {
  // A broker configured (or misconfigured) to cap subscriptions at QoS 0 has
  // quietly turned off at-least-once delivery; the bridge cannot fix that, but
  // it must say so at a level somebody's alerting can key on. aedes cannot be
  // made to answer a SUBACK with a downgraded grant (this version captures the
  // granted QoS before authorizeSubscribe can lower it), so the downgrade is
  // played by a fake client — which is the exact surface bridge.js reads: the
  // granted array of its subscribe callback.
  const api = await startApi();
  const logs = captureLog();
  const handlers = {};
  const client = {
    options: {},
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
    subscribe(subs, cb) {
      cb(null, Object.keys(subs).map((topic) => ({ topic, qos: 0 })));
    },
    end(_force, _opts, done) { if (done) done(); },
  };
  const config = loadConfig({
    MQTT_URL: 'mqtt://127.0.0.1:1',
    MQTT_ALLOW_INSECURE: '1',
    MQTT_CLIENT_ID: 'test-bridge',
    MEGANET_API_URL: api.url,
    MEGANET_API_KEY: 'test-publishable-key',
    MEGANET_INGEST_TOKEN: 'mgn_test_token',
    BRIDGE_HEARTBEAT_MS: '0',
  });
  const bridge = createBridge(config, {
    log: createLogger({ level: 'error', bridgeId: 'test-bridge', stream: logs }),
    connect: () => client,
  });
  bridge.start();
  t.after(async () => { await bridge.stop(); await api.close(); });

  for (const fn of handlers.connect) fn({ sessionPresent: false });

  // Counted and named off SUBSCRIPTIONS rather than pinned to a literal list:
  // adding the elpro format made a hard-coded 3 fail here, in a test about QoS
  // downgrades, which says nothing about what actually changed.
  const downgraded = logs.of('subscribe_downgraded');
  assert.equal(downgraded.length, SUBSCRIPTIONS.length, 'one line per downgraded subscription');
  assert.ok(downgraded.every((l) => l.level === 'error' && l.granted_qos === 0));
  assert.deepEqual(
    downgraded.map((l) => l.topic).sort(),
    SUBSCRIPTIONS.map((s) => s.topic).sort(),
  );
});

test('a status deferred by a blinking sink is retried in-process, not parked until reconnect (#163)', async (t) => {
  const broker = await startBroker();
  const api = await startApi();
  const bridge = startBridge(broker.port, api.url);
  t.after(async () => {
    await closeStations();
    await bridge.stop();
    await api.close();
    await broker.close();
  });

  await waitFor(() => broker.subscribed.has('test-bridge'), { what: 'the bridge to subscribe' });
  const subscribesBefore = broker.subscribes;

  // The sink blinks: the next two mqtt_status calls fail 503, then it recovers.
  api.failures.mqtt_status = 2;

  const station = await connectStation(broker.port, 'blink_al');
  await station.publishAsync(
    'meganet/v1/blink_al/status',
    JSON.stringify({ online: false }),
    { qos: 1 },
  );

  // Three calls — two refused, one stored — without any reconnect. Before the
  // #102 fix this offline marker would have sat unacked until the next session
  // resume, whenever that happened to be.
  await waitFor(() => api.of('mqtt_status').length >= 3, { timeout: 15_000, what: 'the in-process retry' });
  await waitFor(() => broker.bridgeAcks().some((a) => a.topic === 'meganet/v1/blink_al/status'),
    { timeout: 15_000, what: 'the status to be acked after the retry' });
  assert.equal(broker.subscribes, subscribesBefore, 'the retry must not ride a reconnect');
  assert.equal(api.of('mqtt_status').at(-1).body.payload.online, false);
});
