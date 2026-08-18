// batcher.js — A second's worth of readings, one call, and the acknowledgement
// rules that decide whether a message can be lost.
//
// This is the part of the bridge worth reading twice, because everything that
// can quietly lose a reading lives here.
//
// **Nothing is acked until it is stored.** MQTT.js sends the PUBACK when the
// callback handed to `handleMessage` is invoked, so the bridge holds that
// callback until `ingest_http` has answered 200 for the batch the message is in.
// Until then the broker still owns the message: if this process dies, or the
// database is down, or the container is rescheduled mid-flight, the broker
// redelivers on the next connect. That is the whole reason the client sets
// `clean: false` and a stable client id — a clean session throws the queue away,
// and a bridge with a clean session is a bridge that loses exactly the messages
// that arrived while it was broken.
//
// **A batch that cannot be delivered is retried until it can be, and never
// acked in the meantime.** Retries are exponential with jitter and capped at a
// minute; there is no attempt limit, because there is no better thing to do with
// a reading than to keep trying to store it. A database outage therefore costs
// memory — every message received during it stays in this process — and that is
// affordable precisely *because* nothing has been acked: if the queue does grow
// until the process dies, the broker still holds every message and hands them
// back on the next connect. The failure mode of the simple design is a restart,
// not a gap in the record.
//
// This is also why the bridge does not try to force a redelivery when it is
// stuck. An earlier version gave up after N attempts and reconnected to make the
// broker replay; a broker replays queued messages on session *resume*, so a
// second failure left the reading sitting in the broker with nothing scheduled
// to ask for it again, and a reading arrived only when something else happened
// to reconnect. Retrying in place has no such hole.
//
// **A batch the database refuses on its merits is bisected.** A 400 means the
// request was malformed, and retrying it produces the same 400 forever. But a
// batch is many stations' messages, and one station's bad envelope must not
// block the other twenty. So a rejected batch of more than one message is split
// in half and each half tried on its own, until the poison message is alone —
// then it is acked, logged and counted as rejected. Bisecting costs log₂(n)
// extra requests in a case that should be rare, and the alternative is either
// losing good readings or never making progress.

const { backoffMs, sleep: defaultSleep } = require('./backoff');

function createBatcher({
  sink,
  log,
  health,
  maxReadings = 1000,
  maxWaitMs = 1000,
  retryMaxMs = 60_000,
  warnAfterAttempts = 5,
  seenIntervalMs = 60_000,
  sleep = defaultSleep,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => new Date(),
}) {
  let queue = [];
  let queuedReadings = 0;
  let inFlight = 0; // messages taken off the queue and not yet acked (#102)
  let timer = null;
  let running = null;
  let closed = false;

  // The pending gauge counts everything the broker has not been told about:
  // waiting AND in flight. An earlier version reported queue.length from two
  // call sites, and any add() during an outage overwrote the gauge with the
  // waiting count alone — hiding exactly the stuck batch the gauge exists to
  // show (#102).
  function updatePending() {
    health.setPending(queue.length + inFlight);
  }
  const seenSent = new Map(); // station → ms of the last mqtt_seen we sent

  function add(item) {
    if (closed) {
      // Not acked: the message goes back to the broker rather than into a queue
      // that is about to be thrown away.
      log.warn('message_after_close', { station: item.station });
      return;
    }
    queue.push(item);
    queuedReadings += item.readings.length;
    updatePending();

    if (queuedReadings >= maxReadings) {
      kick();
    } else if (!timer) {
      timer = setTimeoutFn(kick, maxWaitMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  function kick() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }

  /** Send everything queued, including anything that arrives while sending. */
  async function drain() {
    while (queue.length) {
      const batch = queue;
      queue = [];
      queuedReadings = 0;
      inFlight = batch.length;
      updatePending();
      await deliver(batch);
      inFlight = 0;
      updatePending();
    }
  }

  /**
   * Deliver one batch, with retries, bisection, and the acking rules above.
   * Every item passed in leaves this function acked, bisected into a smaller
   * call, or deliberately abandoned to the broker — never silently dropped.
   */
  async function deliver(items) {
    if (items.length === 0) return;

    for (const group of groupByEnvelope(items)) {
      // The database refuses a batch over maxReadings outright, so a backlog
      // is delivered in chunks under the limit rather than as one refusable
      // call. The limit used to be only a flush trigger, which made the
      // 400-and-bisect path the routine recovery after any queue build-up —
      // and bisection is for poison, not for volume (#102). Chunking also
      // bounds the outgoing body: many 256 KiB messages no longer merge into
      // one arbitrarily large POST.
      for (const chunk of chunkByReadings(group.items, maxReadings)) {
        await deliverGroup(group.envelope, chunk);
      }
    }
  }

  async function deliverGroup(envelope, items) {
    const readings = items.flatMap((i) => i.readings);
    const payload = { ...envelope, source: envelope.source || 'mqtt', readings };

    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await sink.postReadings(payload);

        for (const item of items) item.ack();
        health.inserted({
          accepted: result.accepted,
          duplicates: result.duplicates,
          rejected: result.rejected.length,
        });

        log.info('batch_stored', {
          messages: items.length,
          readings: readings.length,
          accepted: result.accepted,
          duplicates: result.duplicates,
          rejected: result.rejected.length,
          raw_id: result.rawId,
          attempt,
        });
        // A reading the database refused is not a delivery failure — the message
        // was stored, judged and answered — but it is the thing somebody will
        // want to find later, with the reason ingest() gave.
        for (const bad of result.rejected.slice(0, 10)) {
          log.warn('reading_rejected', { i: bad.i, why: bad.why });
        }

        await stampSeen(items);
        return;
      } catch (err) {
        if (err.retryable === false) {
          await handleRefused(envelope, items, err);
          return;
        }

        health.errored(err.message);
        // Quiet for the first few — a database that blinks is a Tuesday — and
        // then loud, at a level somebody's alerting can key on, for as long as
        // it lasts. An outage should be one escalation, not one line per second.
        const loud = attempt === warnAfterAttempts || attempt % 60 === 0;
        log[loud ? 'error' : 'warn'](loud ? 'sink_unavailable' : 'batch_retrying', {
          err,
          status: err.status,
          credential: err.credential || undefined,
          messages: items.length,
          readings: readings.length,
          attempt,
        });

        if (closed) {
          // Shutting down mid-outage. These were never acked, so the broker
          // still has them and will hand them back to the next process to
          // connect with this client id. Holding the process open to keep
          // retrying would just turn a SIGTERM into a SIGKILL.
          log.error('unacked_returned_to_broker', {
            messages: items.length,
            readings: readings.length,
          });
          return;
        }

        await sleep(backoffMs(attempt, { maxMs: retryMaxMs }));
      }
    }
  }

  /** A 400/422: the request is wrong and will be wrong every time. Isolate it. */
  async function handleRefused(envelope, items, err) {
    if (items.length === 1) {
      const [item] = items;
      health.rejected(item.readings.length);
      health.errored(err.message);
      log.error('message_refused', {
        err,
        status: err.status,
        station: item.station,
        device: item.device,
        topic: item.topic,
        readings: item.readings.length,
      });
      // Acked: it will never be accepted, and an un-acked poison message is
      // redelivered forever with the whole backlog stuck behind it.
      item.ack();
      return;
    }

    const half = Math.ceil(items.length / 2);
    log.warn('batch_bisecting', { err, status: err.status, messages: items.length });
    await deliverGroup(envelope, items.slice(0, half));
    await deliverGroup(envelope, items.slice(half));
  }

  /**
   * Tell MegaNet when each station's reading last arrived, throttled — this is
   * a fact about the station, not a reading, and it is worth at most one small
   * call a minute per station. Failures are logged and dropped: the readings are
   * already stored, and a status stamp is not worth a retry loop.
   */
  async function stampSeen(items) {
    const at = now().toISOString();
    const ms = Date.now();
    const stations = new Set();
    for (const item of items) {
      const last = seenSent.get(item.station) || 0;
      if (ms - last >= seenIntervalMs) {
        stations.add(item.station);
        seenSent.set(item.station, ms);
      }
    }
    for (const station of stations) {
      try {
        await sink.postSeen({ station, at });
      } catch (err) {
        log.warn('seen_failed', { err, station });
      }
    }
  }

  return {
    add,
    flush: kick,
    get pending() {
      return queue.length;
    },
    async close() {
      closed = true;
      if (timer) clearTimeoutFn(timer);
      timer = null;
      await kick();
    },
  };
}

/**
 * Split a group into runs whose reading totals stay within `limit`. A single
 * message never exceeds the limit on its own — messages.js refuses over-limit
 * payloads as poison before they reach the queue — so every chunk here is
 * deliverable, and a chunk is never empty.
 */
function chunkByReadings(items, limit) {
  const chunks = [];
  let current = [];
  let count = 0;
  for (const item of items) {
    if (current.length && count + item.readings.length > limit) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(item);
    count += item.readings.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Readings from different messages go in one call only when they share an
 * envelope — `path`, `protocol`, `received_at` are batch defaults in the ingest
 * contract, and merging two messages that disagree about them would attribute
 * one station's readings to another's repeater path.
 */
function groupByEnvelope(items) {
  const groups = new Map();
  for (const item of items) {
    const key = stableKey(item.envelope);
    if (!groups.has(key)) groups.set(key, { envelope: item.envelope, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function stableKey(envelope) {
  const keys = Object.keys(envelope || {}).sort();
  return JSON.stringify(keys.map((k) => [k, envelope[k]]));
}

module.exports = { createBatcher, groupByEnvelope, chunkByReadings };
