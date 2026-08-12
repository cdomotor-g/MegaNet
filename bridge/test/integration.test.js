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
const { createLogger } = require('../src/log');

const QUIET = { write() {} }; // the bridge's logs, not the test runner's problem

async function startBroker(port = 0) {
  // createBroker(), not `new Aedes()`: the constructor leaves the persistence
  // uninitialised and the broker silently never answers a CONNECT.
  const broker = await Aedes.createBroker();
  const subscribed = new Set();
  const acks = [];
  broker.on('subscribe', (_subs, client) => subscribed.add(client.id));
  // The acknowledgement that actually matters. A publisher's own PUBACK comes
  // from the *broker* and says nothing about the bridge; this one is the bridge
  // telling the broker it may forget the message, which it must not do until the
  // reading is stored.
  broker.on('ack', (packet, client) => acks.push({ client: client.id, topic: packet.topic }));
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    broker,
    subscribed,
    acks,
    bridgeAcks: () => acks.filter((a) => a.client === 'test-bridge'),
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
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const fn = req.url.split('/').pop();
      calls.push({ fn, body: JSON.parse(body || '{}'), token: req.headers['x-ingest-token'] });
      if (mode === 'down' && fn === 'ingest_http') {
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
    url: `http://127.0.0.1:${server.address().port}/rest/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startBridge(brokerPort, apiUrl, extra = {}) {
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
    log: createLogger({ level: 'error', bridgeId: 'test-bridge', stream: QUIET }),
  });
  bridge.start();
  return bridge;
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

  const station = await connectStation(broker.port, 'loudoun_br_al');
  let acked = false;
  await new Promise((resolve, reject) => {
    station.publish(
      'meganet/v1/loudoun_br_al/logger/reading',
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
  assert.equal(seen.body.p_station, 'loudoun_br_al');

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

  const station = await connectStation(broker.port, 'abercorn_al', {
    will: {
      topic: 'meganet/v1/abercorn_al/status',
      payload: JSON.stringify({ online: false }),
      qos: 1,
      retain: true,
    },
  });

  await station.publishAsync(
    'meganet/v1/abercorn_al/status',
    JSON.stringify({ online: true, battery_v: 12.9 }),
    { qos: 1, retain: true },
  );

  const up = await waitFor(() => api.of('mqtt_status')[0], { what: 'the status message' });
  assert.equal(up.body.payload.online, true);
  assert.equal(up.body.payload.station, 'abercorn_al');
  assert.deepEqual(up.body.payload.status, { battery_v: 12.9 });

  // The station's link drops without a DISCONNECT — a radio going quiet, not a
  // logger shutting down politely — which is when a broker publishes the will.
  station.stream.destroy();

  const down = await waitFor(() => api.of('mqtt_status').find((c) => c.body.payload.online === false),
    { what: 'the last will' });
  assert.equal(down.body.payload.station, 'abercorn_al');
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
