// bridge.js — Connect, subscribe, parse, batch, insert, log the result.
//
// Deliberately the smallest file that can hold all of that: the interesting
// decisions live in batcher.js (what may be acked and when), messages.js (what
// is poison) and topics.js (the scheme). This one wires them to a socket.

const mqtt = require('mqtt');

const { SUBSCRIPTIONS, parseTopic } = require('./topics');
const { parseReadings, parseStatus, PoisonMessage } = require('./messages');
const { createBatcher } = require('./batcher');
const { createHealth } = require('./health');
const { createSink } = require('./sink');
const { createLogger } = require('./log');
const { backoffMs, sleep } = require('./backoff');

const VERSION = require('../package.json').version;

function createBridge(config, deps = {}) {
  const log = deps.log || createLogger({ level: config.bridge.logLevel, bridgeId: config.bridge.id });
  const health = deps.health || createHealth({ bridgeId: config.bridge.id, version: VERSION, log });
  const sink = deps.sink || createSink({
    apiUrl: config.api.url,
    apiKey: config.api.key,
    ingestToken: config.api.token,
    timeoutMs: config.api.timeoutMs,
  });
  const connect = deps.connect || mqtt.connect;

  let client = null;
  let heartbeatTimer = null;
  let closeHealthServer = () => {};
  let reconnectAttempt = 0;
  let stopping = false; // ends the status retry loop when the process is asked to stop

  const batcher = createBatcher({
    sink,
    log,
    health,
    maxReadings: config.bridge.batchMax,
    maxWaitMs: config.bridge.batchMs,
    retryMaxMs: config.bridge.retryMaxMs,
    seenIntervalMs: config.bridge.seenIntervalMs,
  });

  function start() {
    closeHealthServer = health.serve(config.bridge.healthPort);

    client = connect(config.mqtt.url, {
      clientId: config.mqtt.clientId,
      username: config.mqtt.username,
      password: config.mqtt.password,
      ca: config.mqtt.ca,
      rejectUnauthorized: config.mqtt.rejectUnauthorized,
      keepalive: config.mqtt.keepaliveSec,
      // The two options that make "no acked message is lost" true. A clean
      // session tells the broker to throw away everything queued for a client
      // that is not connected — which is precisely the window this process
      // exists to survive. With clean: false and a stable client id, a bridge
      // that was down for an hour is handed the hour's backlog on reconnect.
      clean: false,
      protocolVersion: 4,
      reconnectPeriod: config.mqtt.reconnectBaseMs,
      resubscribe: false, // we subscribe on every connect, from one place
    });

    // MQTT.js sends the PUBACK when this callback runs, which makes overriding
    // handleMessage the whole acknowledgement mechanism: hold the callback, and
    // the broker keeps the message.
    client.handleMessage = (packet, done) => {
      handleMessage(packet, once(done));
    };

    client.on('connect', (connack) => {
      reconnectAttempt = 0;
      client.options.reconnectPeriod = config.mqtt.reconnectBaseMs;
      health.connectionUp();
      log.info('broker_connected', {
        url: config.mqtt.url,
        client_id: config.mqtt.clientId,
        // False means the broker still had our session — and therefore anything
        // it queued while we were away. True after a broker restart that lost
        // its state, which is the case where readings may have been dropped by
        // the *broker*, and is worth being able to find in the log.
        session_present: connack?.sessionPresent ?? null,
      });

      const subscriptions = Object.fromEntries(SUBSCRIPTIONS.map((s) => [s.topic, { qos: s.qos }]));
      client.subscribe(subscriptions, (err, granted) => {
        if (err) {
          health.errored(`subscribe: ${err.message}`);
          log.error('subscribe_failed', { err });
          return;
        }
        // A broker that grants QoS 0 where we asked for 1 has quietly turned off
        // at-least-once delivery, and the acking above stops meaning anything.
        for (const g of granted || []) {
          if (g.qos !== 1) {
            log.error('subscribe_downgraded', { topic: g.topic, granted_qos: g.qos });
          }
        }
        log.info('subscribed', { topics: (granted || []).map((g) => g.topic) });
      });
    });

    client.on('reconnect', () => {
      reconnectAttempt += 1;
      // MQTT.js reconnects on a fixed period; this makes it exponential with
      // jitter, so a broker coming back does not meet the whole fleet at once.
      // Floored at one second (#102): full jitter can land on 0, and MQTT.js
      // reads reconnectPeriod 0 as "do not reconnect" — a 1-in-baseMs chance
      // per disconnect of a bridge that silently never comes back.
      client.options.reconnectPeriod = Math.max(1000, backoffMs(reconnectAttempt, {
        baseMs: config.mqtt.reconnectBaseMs,
        maxMs: config.mqtt.reconnectMaxMs,
      }));
      log.warn('broker_reconnecting', {
        attempt: reconnectAttempt,
        next_delay_ms: client.options.reconnectPeriod,
      });
    });

    client.on('close', () => {
      health.connectionDown();
      log.warn('broker_disconnected', {});
    });

    client.on('error', (err) => {
      health.errored(`mqtt: ${err.message}`);
      log.error('broker_error', { err });
    });

    if (config.bridge.heartbeatMs > 0) {
      heartbeatTimer = setInterval(heartbeat, config.bridge.heartbeatMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    }
    heartbeat();

    log.info('bridge_started', {
      version: VERSION,
      bridge_id: config.bridge.id,
      batch_ms: config.bridge.batchMs,
      batch_max: config.bridge.batchMax,
    });

    return client;
  }

  function handleMessage(packet, done) {
    const topic = packet.topic.toString();
    health.messageReceived();

    const route = parseTopic(topic);

    if (route.kind === 'unknown') {
      // Acked. A topic outside the scheme will not become one on redelivery, and
      // a bridge that refuses to ack anything it does not recognise is a bridge
      // one stray publish can wedge.
      log.warn('topic_ignored', { topic, why: route.why });
      done();
      return;
    }

    if (route.kind === 'status') {
      handleStatus(route, packet, done);
      return;
    }

    let parsed;
    try {
      parsed = parseReadings(packet.payload);
    } catch (err) {
      if (err instanceof PoisonMessage) {
        health.rejected(1);
        health.errored(err.message);
        log.error('message_unparseable', { topic, station: route.station, why: err.message });
        done(); // acked — see messages.js
        return;
      }
      throw err;
    }

    log.debug('message_queued', {
      topic,
      station: route.station,
      device: route.device,
      readings: parsed.readings.length,
      dup: packet.dup || false,
    });

    batcher.add({
      station: route.station,
      device: route.device,
      topic,
      envelope: parsed.envelope,
      readings: parsed.readings,
      ack: done,
    });
  }

  async function handleStatus(route, packet, done) {
    let status;
    try {
      status = parseStatus(route.station, packet.payload);
    } catch (err) {
      log.error('status_unparseable', { station: route.station, why: err.message });
      health.errored(err.message);
      done();
      return;
    }

    if (status.cleared) {
      // An empty retained payload is a station clearing its own status. There is
      // nothing to record and nothing wrong.
      log.info('status_cleared', { station: route.station });
      done();
      return;
    }

    try {
      await sink.postStatus({
        station: status.station,
        online: status.online,
        at: status.at,
        status: status.status,
        bridge: config.bridge.id,
      });
      log.info('station_status', {
        station: status.station,
        online: status.online,
        retained: packet.retain || false,
      });
      done();
    } catch (err) {
      health.errored(err.message);
      if (err.retryable === false) {
        log.error('status_refused', { err, station: status.station });
        done(); // will never be accepted; acking stops it coming back forever
        return;
      }
      // Left unacked — but an unacked QoS 1 PUBLISH is only re-sent on
      // session *resume*, not mid-connection (#102), so waiting for the
      // broker means an offline marker recorded at the next reconnect,
      // whenever that is. A short in-process retry closes that gap; if the
      // process dies first, the unacked message comes back on resume anyway,
      // and a retained status is replayed on every connect regardless.
      log.warn('status_deferred', { err, station: status.station });
      for (let attempt = 1; attempt <= 10 && !stopping; attempt += 1) {
        await sleep(backoffMs(attempt, { maxMs: 60_000 }));
        if (stopping) break;
        try {
          await sink.postStatus({
            station: status.station,
            online: status.online,
            at: status.at,
            status: status.status,
            bridge: config.bridge.id,
          });
          log.info('status_stored', {
            station: status.station,
            online: status.online,
            retained: packet.retain || false,
            attempt: attempt + 1,
          });
          done();
          return;
        } catch (retryErr) {
          health.errored(retryErr.message);
          if (retryErr.retryable === false) {
            log.error('status_refused', { err: retryErr, station: status.station });
            done();
            return;
          }
          log.warn('status_deferred', { err: retryErr, station: status.station, attempt: attempt + 1 });
        }
      }
    }
  }

  async function heartbeat() {
    const snapshot = health.snapshot();
    try {
      await sink.postHeartbeat(snapshot);
      log.debug('heartbeat', { pending: snapshot.pending });
    } catch (err) {
      // Not fatal and not retried: the next one is along in a minute, and the
      // gap in last_seen_at is itself the signal.
      log.warn('heartbeat_failed', { err });
    }
  }

  async function stop() {
    stopping = true;
    log.info('bridge_stopping', {});
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // Order matters: stop taking new messages, deliver what is held, ack it,
    // then hang up. A bridge that hangs up first leaves messages it had already
    // stored unacked, and the broker redelivers them on the next start — which
    // is not data loss (the primary key eats them) but is a confusing pile of
    // duplicates in the log for anyone reading it later.
    await batcher.close();
    await heartbeat();

    if (client) {
      await new Promise((resolve) => client.end(false, {}, resolve));
    }
    await closeHealthServer();
    log.info('bridge_stopped', {});
  }

  return { start, stop, batcher, health, log, get client() { return client; } };
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return undefined;
    called = true;
    return fn(...args);
  };
}

module.exports = { createBridge, VERSION };
