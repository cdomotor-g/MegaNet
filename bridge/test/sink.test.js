// The sink's failure classification, through the real createSink against a
// real HTTP server — not by reading the constants (#163). This is the single
// decision the batcher acts on, and every misclassification is a data-loss
// bug in one direction or the other: poison marked retryable wedges the
// queue; retryable marked poison acks and drops readings that were fine.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createSink, SinkError } = require('../src/sink');

async function serverAnswering(status, body = '{}') {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/rest/v1`,
    // closeAllConnections first: fetch keeps its socket alive for the pool,
    // and a bare close() waits for it — forever, from the runner's view.
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

async function classify(status) {
  const api = await serverAnswering(status, JSON.stringify({ message: `status ${status}` }));
  const sink = createSink({ apiUrl: api.url, apiKey: 'k', ingestToken: 't' });
  try {
    await sink.postReadings({ readings: [] });
    throw new Error(`a ${status} did not throw`);
  } catch (err) {
    assert.ok(err instanceof SinkError, `a ${status} threw ${err.name}, not SinkError`);
    return { status: err.status, retryable: err.retryable, credential: err.credential };
  } finally {
    await api.close();
  }
}

test('401 and 403 are the token: retryable, and flagged credential', async () => {
  for (const s of [401, 403]) {
    assert.deepEqual(await classify(s), { status: s, retryable: true, credential: true });
  }
});

test('400 and 422 are the request: permanent, and the caller treats the message as poison', async () => {
  for (const s of [400, 422]) {
    assert.deepEqual(await classify(s), { status: s, retryable: false, credential: false });
  }
});

test('404 is the server, not the message: retryable (#102)', async () => {
  // PostgREST answers 404 for a function missing from its schema cache — an
  // unapplied migration, a stale cache, a mistyped URL. This exact condition
  // occurred in production (the whole of 0008 sat unapplied under a deployed
  // bridge); poison here would have acked and dropped every reading until
  // somebody noticed.
  assert.deepEqual(await classify(404), { status: 404, retryable: true, credential: false });
});

test('408, 429 and 5xx are weather: retryable', async () => {
  for (const s of [408, 429, 500, 502, 503]) {
    assert.deepEqual(await classify(s), { status: s, retryable: true, credential: false });
  }
});

test('a connection that never happens is retryable — nothing about the message is wrong', async () => {
  const api = await serverAnswering(200);
  await api.close(); // the port is now dead
  const sink = createSink({ apiUrl: api.url, apiKey: 'k', ingestToken: 't', timeoutMs: 2000 });
  await assert.rejects(sink.postReadings({ readings: [] }), (err) => {
    assert.ok(err instanceof SinkError);
    assert.equal(err.retryable, true);
    assert.equal(err.credential, false);
    return true;
  });
});

test('a 200 with a non-JSON body still resolves — a stored batch is never re-sent over a mangled answer', async () => {
  // PostgREST always answers JSON, but a proxy in front of it may not. The
  // batch was stored (200); postReadings normalises the unreadable answer to
  // its zero-counts shape rather than throwing, because a throw here would
  // send the whole batch again for no reason.
  const api = await serverAnswering(200, 'OK');
  try {
    const sink = createSink({ apiUrl: api.url, apiKey: 'k', ingestToken: 't' });
    const out = await sink.postReadings({ readings: [] });
    assert.deepEqual(out, { accepted: 0, duplicates: 0, rejected: [], rawId: null });
  } finally {
    await api.close();
  }
});
