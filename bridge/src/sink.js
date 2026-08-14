// sink.js — The other side of the bridge: MegaNet's HTTP ingest endpoint.
//
// The bridge is an MQTT client on one side and an ordinary HTTP ingest client on
// the other. It holds an ingest token from meganet.ingest_token and nothing else
// — no service key, no database password — so a host running this process that
// somebody else gets into is worth exactly one revoked token. See
// docs/ingest-mqtt.md, "What the bridge is trusted with".
//
// Four calls, all POST … /rest/v1/rpc/<fn>:
//
//   ingest_http       the readings (0007 — the same door a HTTP logger uses)
//   mqtt_status       a station's retained status, or its LWT (0008)
//   mqtt_seen         when a station's reading last arrived (0008)
//   bridge_heartbeat  this process's own pulse (0008)
//
// Every failure is classified as retryable or permanent, once, here — the
// batcher above acts on that and nothing else re-derives it from a status code.

const { PoisonMessage } = require('./messages');

class SinkError extends Error {
  constructor(message, { status = 0, retryable = true, credential = false, body } = {}) {
    super(message);
    this.name = 'SinkError';
    this.status = status;
    this.retryable = retryable;
    this.credential = credential;
    this.body = body;
  }
}

function createSink({ apiUrl, apiKey, ingestToken, timeoutMs = 15_000, fetchFn = globalThis.fetch }) {
  const base = apiUrl.replace(/\/+$/, '');

  async function rpc(fn, payload) {
    const url = `${base}/rpc/${fn}`;
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          apikey: apiKey,
          'X-Ingest-Token': ingestToken,
          'Content-Type': 'application/json',
          // Both profile headers, on purpose. These functions live in the
          // `meganet` schema, not `public`; without a profile header PostgREST
          // looks in whichever schema is first in its exposed list and answers
          // "function does not exist" if that is not ours. Sending them is free
          // when the default is already right and load-bearing when it is not.
          'Content-Profile': 'meganet',
          'Accept-Profile': 'meganet',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // DNS, TLS, connection reset, timeout. Always retryable: nothing about the
      // message is wrong, we simply could not deliver it.
      throw new SinkError(`${fn}: ${err.message}`, { retryable: true });
    }

    const text = await res.text().catch(() => '');
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 400) };
    }

    if (res.ok) return body;

    // 401/403 is the token: revoked, mistyped, or the wrong project. Retryable
    // — somebody can fix it and every message waiting is still good — but
    // flagged separately, because it is the one failure that will never clear on
    // its own and the log line should say so rather than looking like weather.
    if (res.status === 401 || res.status === 403) {
      throw new SinkError(`${fn}: ${res.status} — ingest token refused`, {
        status: res.status,
        retryable: true,
        credential: true,
        body,
      });
    }

    // 400 and 422 are PostgREST saying the *request* is wrong: a malformed
    // envelope, a batch over the limit. Retrying it produces the same 400 next
    // time, so it is permanent and the caller treats the message as poison.
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      throw new SinkError(`${fn}: ${res.status} — ${describe(body) || text.slice(0, 200)}`, {
        status: res.status,
        retryable: false,
        body,
      });
    }

    // 408, 429, 5xx, and anything unforeseen: assume it is us or them, not the
    // message. Assuming the other way loses readings.
    throw new SinkError(`${fn}: ${res.status} — ${describe(body) || text.slice(0, 200)}`, {
      status: res.status,
      retryable: true,
      body,
    });
  }

  return {
    /**
     * Post a batch of readings. Resolves with ingest()'s own answer —
     * `{accepted, duplicates, rejected, raw_id}` — which is the thing worth
     * logging: a batch that was accepted and a batch that was accepted and
     * wholly rejected are both 200s, and only the body tells them apart.
     */
    async postReadings(envelope) {
      // `{payload: …}`, not the envelope itself: PostgREST maps the top-level
      // keys of an RPC body to the function's named arguments, and
      // meganet.ingest_http() takes one argument called `payload`. Posting the
      // envelope bare asks for a function called ingest_http(source, readings),
      // which does not exist.
      const body = await rpc('ingest_http', { payload: envelope });
      return {
        accepted: body?.accepted ?? 0,
        duplicates: body?.duplicates ?? 0,
        rejected: Array.isArray(body?.rejected) ? body.rejected : [],
        rawId: body?.raw_id ?? null,
      };
    },

    postStatus({ station, online, at, status, bridge }) {
      return rpc('mqtt_status', {
        payload: { station, online, at, status, bridge },
      });
    },

    postSeen({ station, at }) {
      return rpc('mqtt_seen', { p_station: station, p_at: at });
    },

    postHeartbeat(snapshot) {
      return rpc('bridge_heartbeat', { payload: snapshot });
    },
  };
}

function describe(body) {
  if (!body || typeof body !== 'object') return '';
  return [body.message, body.details, body.hint].filter(Boolean).join(' — ');
}

module.exports = { createSink, SinkError, PoisonMessage };
