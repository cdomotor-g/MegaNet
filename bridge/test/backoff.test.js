const test = require('node:test');
const assert = require('node:assert/strict');

const { backoffMs } = require('../src/backoff');

test('doubles, then stops at the cap', () => {
  const opts = { baseMs: 1000, maxMs: 10_000, jitter: false };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, opts)),
    [1000, 2000, 4000, 8000, 10_000, 10_000]);
});

test('never returns Infinity, however many attempts have failed', () => {
  const delay = backoffMs(1e6, { baseMs: 1000, maxMs: 60_000, jitter: false });
  assert.ok(Number.isFinite(delay) && delay === 60_000, `got ${delay}`);
});

test('full jitter draws from [0, ceiling]', () => {
  const opts = { baseMs: 1000, maxMs: 60_000 };
  assert.equal(backoffMs(3, { ...opts, random: () => 0 }), 0);
  assert.equal(backoffMs(3, { ...opts, random: () => 0.999999 }), 3999);
  // The point of the jitter: a thousand clients do not all wake at once.
  const draws = new Set(Array.from({ length: 200 }, () => backoffMs(5, opts)));
  assert.ok(draws.size > 100, `only ${draws.size} distinct delays in 200 draws`);
});

test('an attempt below 1 is treated as the first', () => {
  assert.equal(backoffMs(0, { baseMs: 500, jitter: false }), 500);
  assert.equal(backoffMs(-3, { baseMs: 500, jitter: false }), 500);
});
