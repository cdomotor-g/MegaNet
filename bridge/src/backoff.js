// backoff.js — How long to wait before trying again.
//
// Exponential, capped, with full jitter. The jitter is not decoration: every
// station in the network loses its link to the same broker at the same moment
// when the broker restarts, and a fleet that all retries at exactly 1s, 2s, 4s
// is a fleet that reconnects in a thundering herd and knocks the broker over
// again. Full jitter — a uniform draw from [0, delay] — is the variant that
// spreads a herd best for the smallest amount of code.

/**
 * Delay before attempt `n` (1-based: the first retry is n = 1).
 *
 * @param {number} attempt   which retry this is, from 1
 * @param {object} [opts]
 * @param {number} [opts.baseMs=1000]  the first retry's ceiling
 * @param {number} [opts.maxMs=60000]  never wait longer than this
 * @param {boolean} [opts.jitter=true] false makes it deterministic, for tests
 * @param {() => number} [opts.random=Math.random]
 */
function backoffMs(attempt, opts = {}) {
  const { baseMs = 1000, maxMs = 60_000, jitter = true, random = Math.random } = opts;
  const n = Math.max(1, Math.floor(attempt));
  // 2^30 ms is 12 days; clamping the exponent keeps the arithmetic honest long
  // before the cap would have to rescue it from Infinity.
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
  return jitter ? Math.floor(random() * ceiling) : ceiling;
}

/** Promise that resolves after `ms`, and does not keep the process alive. */
function sleep(ms, { setTimeoutFn = setTimeout } = {}) {
  return new Promise((resolve) => {
    const t = setTimeoutFn(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

module.exports = { backoffMs, sleep };
