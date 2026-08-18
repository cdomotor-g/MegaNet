// The acknowledgement rules, which are the ones that decide whether a reading
// can be lost. Everything here uses a fake sink and a fake clock: the point is
// what gets acked and when, not whether HTTP works.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBatcher, groupByEnvelope } = require('../src/batcher');
const { SinkError } = require('../src/sink');

function fakes() {
  const calls = [];
  const logs = [];
  const sink = {
    behaviour: () => ({ accepted: 1, duplicates: 0, rejected: [], rawId: 1 }),
    async postReadings(payload) {
      calls.push(payload);
      const out = await sink.behaviour(payload, calls.length);
      if (out instanceof Error) throw out;
      return { accepted: payload.readings.length, duplicates: 0, rejected: [], rawId: calls.length, ...out };
    },
    seen: [],
    async postSeen(args) {
      sink.seen.push(args);
    },
  };
  const log = new Proxy({}, {
    get: (_t, level) => (event, fields) => logs.push({ level, event, ...fields }),
  });
  const health = {
    counts: { accepted: 0, rejected: 0, errors: 0, pending: 0 },
    inserted: ({ accepted = 0 }) => { health.counts.accepted += accepted; },
    rejected: (n) => { health.counts.rejected += n; },
    errored: () => { health.counts.errors += 1; },
    setPending: (n) => { health.counts.pending = n; },
  };
  return { calls, logs, sink, log, health };
}

function item(station, readings = 1, envelope = {}) {
  const it = {
    station,
    device: 'logger',
    topic: `meganet/v1/${station}/logger/reading`,
    envelope,
    readings: Array.from({ length: readings }, (_, i) => ({ alert_id: 1000 + i, value_raw: i })),
    acked: 0,
    ack() { it.acked += 1; },
  };
  return it;
}

const build = (f, opts = {}) => createBatcher({
  sink: f.sink,
  log: f.log,
  health: f.health,
  sleep: async () => {},
  ...opts,
});

test('a message is acked only after the batch is stored', async () => {
  const f = fakes();
  let release;
  f.sink.behaviour = () => new Promise((resolve) => { release = () => resolve({}); });

  const b = build(f, { maxWaitMs: 5 });
  const a = item('one_al');
  b.add(a);

  const flushed = b.flush();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.acked, 0, 'acked before the sink answered');

  release();
  await flushed;
  assert.equal(a.acked, 1);
});

test('a full batch goes early, and no call exceeds the reading limit', async () => {
  const f = fakes();
  const b = build(f, { maxWaitMs: 60_000, maxReadings: 10 });
  b.add(item('one_al', 6));
  assert.equal(f.calls.length, 0);
  b.add(item('two_al', 6));
  await b.flush();
  // The limit is a cap on the call, not just a flush trigger (#102): the
  // database refuses a batch over maxReadings outright, so 6+6 under a limit
  // of 10 is two deliverable calls, never one refusable one. The old
  // behaviour — one 12-reading POST — was exactly the request 0007 answers
  // with a 400, which made bisection the routine recovery after any backlog.
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map((c) => c.readings.length), [6, 6]);
  for (const c of f.calls) assert.ok(c.readings.length <= 10);
});

test('several messages become one call, and one call carries source: mqtt', async () => {
  const f = fakes();
  const b = build(f, { maxWaitMs: 5 });
  const items = [item('one_al'), item('two_al'), item('three_al')];
  items.forEach((i) => b.add(i));
  await b.flush();

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].source, 'mqtt');
  assert.equal(f.calls[0].readings.length, 3);
  assert.deepEqual(items.map((i) => i.acked), [1, 1, 1]);
});

test('messages that disagree about the envelope are not merged', async () => {
  const f = fakes();
  const b = build(f, { maxWaitMs: 5 });
  b.add(item('one_al', 1, { path: 'REPEATER_A' }));
  b.add(item('two_al', 1, { path: 'REPEATER_B' }));
  b.add(item('three_al', 1, { path: 'REPEATER_A' }));
  await b.flush();

  assert.equal(f.calls.length, 2);
  const byPath = Object.fromEntries(f.calls.map((c) => [c.path, c.readings.length]));
  assert.deepEqual(byPath, { REPEATER_A: 2, REPEATER_B: 1 });
});

test('a retryable failure is retried, and the message is acked once it lands', async () => {
  const f = fakes();
  f.sink.behaviour = (_p, n) => (n < 3 ? new SinkError('503', { status: 503, retryable: true }) : {});

  const b = build(f, { maxWaitMs: 5 });
  const a = item('one_al');
  b.add(a);
  await b.flush();

  assert.equal(f.calls.length, 3);
  assert.equal(a.acked, 1);
});

test('a database that stays down is retried, and nothing is acked meanwhile', async () => {
  const f = fakes();
  let attempts = 0;
  f.sink.behaviour = () => {
    attempts += 1;
    return attempts < 12 ? new SinkError('down', { status: 500, retryable: true }) : {};
  };

  const b = build(f, { maxWaitMs: 5 });
  const a = item('one_al');
  b.add(a);
  const flushed = b.flush();

  // There is no attempt limit — an outage of any length ends with the reading
  // stored, because the alternative is a reading that is not.
  await flushed;
  assert.equal(f.calls.length, 12);
  assert.equal(a.acked, 1);
  // Loud once, at the fifth attempt, rather than once per second forever.
  assert.equal(f.logs.filter((l) => l.event === 'sink_unavailable').length, 1);
});

test('shutting down mid-outage leaves the message with the broker, unacked', async () => {
  const f = fakes();
  f.sink.behaviour = () => new SinkError('down', { status: 500, retryable: true });

  const b = build(f, { maxWaitMs: 60_000 });
  const a = item('one_al');
  b.add(a);
  await b.close();

  assert.equal(a.acked, 0, 'acked a batch that was never stored');
  assert.ok(f.logs.some((l) => l.event === 'unacked_returned_to_broker'));
});

test('a refused token is retried, never treated as poison', async () => {
  const f = fakes();
  let attempts = 0;
  f.sink.behaviour = () => {
    attempts += 1;
    return attempts < 3 ? new SinkError('401', { status: 401, retryable: true, credential: true }) : {};
  };

  const b = build(f, { maxWaitMs: 5 });
  const a = item('one_al');
  b.add(a);
  await b.flush();

  assert.ok(f.logs.some((l) => l.credential === true));
  assert.equal(a.acked, 1, 'the reading must survive a token being refused');
});

test('a batch refused as malformed is bisected until the bad message is alone', async () => {
  const f = fakes();
  // The third message is the bad one. Any call carrying it fails permanently.
  f.sink.behaviour = (payload) => (payload.readings.some((r) => r.poison)
    ? new SinkError('400', { status: 400, retryable: false })
    : {});

  const b = build(f, { maxWaitMs: 5 });
  const items = [item('one_al'), item('two_al'), item('three_al'), item('four_al')];
  items[2].readings = [{ poison: true }];
  items.forEach((i) => b.add(i));
  await b.flush();

  // Every good message stored and acked; the bad one acked so it stops coming
  // back, and counted as rejected rather than silently forgotten.
  assert.deepEqual(items.map((i) => i.acked), [1, 1, 1, 1]);
  assert.equal(f.health.counts.rejected, 1);
  assert.ok(f.logs.some((l) => l.event === 'message_refused' && l.station === 'three_al'));
  assert.ok(f.logs.some((l) => l.event === 'batch_bisecting'));
  // Bisection, not one call per message: 4 → [1,2] fails → … but never more
  // than the log₂ shape. The good ones must have been stored in groups.
  assert.ok(f.calls.length <= 7, `${f.calls.length} calls to isolate one bad message`);
});

test('readings the database rejected are logged, and do not stop the ack', async () => {
  const f = fakes();
  f.sink.behaviour = () => ({ accepted: 2, duplicates: 1, rejected: [{ i: 1, why: 'dead clock' }] });

  const b = build(f, { maxWaitMs: 5 });
  const a = item('one_al', 3);
  b.add(a);
  await b.flush();

  assert.equal(a.acked, 1);
  assert.ok(f.logs.some((l) => l.event === 'reading_rejected' && l.why === 'dead clock'));
});

test('mqtt_seen is throttled, not sent per message', async () => {
  const f = fakes();
  const b = build(f, { maxWaitMs: 5, seenIntervalMs: 60_000 });

  b.add(item('one_al'));
  b.add(item('one_al'));
  b.add(item('two_al'));
  await b.flush();
  assert.deepEqual(f.sink.seen.map((s) => s.station).sort(), ['one_al', 'two_al']);

  b.add(item('one_al'));
  await b.flush();
  assert.equal(f.sink.seen.length, 2, 'stamped the same station twice inside the window');
});

test('a failing mqtt_seen never costs the readings', async () => {
  const f = fakes();
  f.sink.postSeen = async () => { throw new SinkError('nope', { retryable: true }); };

  const b = build(f, { maxWaitMs: 5 });
  const a = item('one_al');
  b.add(a);
  await b.flush();

  assert.equal(a.acked, 1);
  assert.ok(f.logs.some((l) => l.event === 'seen_failed'));
});

test('messages arriving during a flush go in the next one, not into the void', async () => {
  const f = fakes();
  let release;
  f.sink.behaviour = (_p, n) => (n === 1
    ? new Promise((resolve) => { release = () => resolve({}); })
    : {});

  const b = build(f, { maxWaitMs: 5 });
  const first = item('one_al');
  const second = item('two_al');
  b.add(first);
  const flushed = b.flush();
  await new Promise((r) => setTimeout(r, 10));
  b.add(second);

  release();
  await flushed;

  assert.equal(f.calls.length, 2);
  assert.equal(second.acked, 1);
});

test('close() delivers what is held before it returns', async () => {
  const f = fakes();
  const b = build(f, { maxWaitMs: 60_000 });
  const a = item('one_al');
  b.add(a);
  await b.close();
  assert.equal(a.acked, 1);
});

test('groupByEnvelope treats key order as the same envelope', () => {
  const groups = groupByEnvelope([
    item('a_al', 1, { path: 'P', protocol: 'alert2' }),
    item('b_al', 1, { protocol: 'alert2', path: 'P' }),
  ]);
  assert.equal(groups.length, 1);
});
