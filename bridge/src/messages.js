// messages.js — Turning a received MQTT payload into something the ingest
// contract accepts, and deciding which failures are the message's fault.
//
// The validation here is deliberately thin. #B4 built one validator, in SQL, and
// a second one in this process with its own opinion about what a timestamp is
// would be exactly the drift that having a single ingest contract was meant to
// prevent. So the bridge checks only what it must to build a well-formed request
// — is this JSON, is it the right *shape*, is it a sane size — and lets
// meganet.ingest() judge every reading on its merits. A reading this process
// waved through and the database rejected comes back in `rejected` with a reason,
// which is a better outcome than one this process rejected on its own authority
// and nobody can see.
//
// The one distinction that matters here is **poison versus unlucky**:
//
//   - Poison: this payload will never be accepted, however many times it is
//     redelivered. Not JSON, not a readings shape, too big. Acked and counted,
//     because a message that cannot succeed must not be retried forever — that
//     is a bridge that never makes progress, and the broker's queue grows behind
//     it until the station's messages start being dropped.
//   - Unlucky: the payload is fine and *we* failed — the database was down, the
//     network dropped. Not acked, so the broker redelivers.
//
// Getting that backwards in either direction is a data-loss bug, so it is one
// decision made in one place rather than an `if` in the middle of the client.

// The one decoder (#153, #155): hfem.js lives at the repo root so the browser
// and this process read the same file. bridge/Dockerfile builds from the repo
// root and copies it to where this path resolves inside the image.
const HFEM = require('../../hfem.js');

// The database refuses a batch over 1,000 (0007) — matching it here means a
// station gets a clear answer from the bridge rather than a 400 relayed back to
// nobody, since MQTT has no reply channel.
const MAX_READINGS = 1000;
// 256 KiB. Larger than any plausible batch of 1,000 readings and small enough
// that a device with a stuck loop cannot make the bridge hold a megabyte per
// unacked message.
const MAX_BYTES = 256 * 1024;

class PoisonMessage extends Error {
  constructor(why) {
    super(why);
    this.name = 'PoisonMessage';
    this.poison = true;
  }
}

/**
 * Parse a reading-topic payload into an array of reading objects.
 *
 * Accepts the same three shapes `meganet.ingest()` does — a single reading, an
 * array, or an object with a `readings` array — because a logger author reading
 * docs/ingest-http.md should not have to discover that MQTT is different.
 *
 * Throws PoisonMessage for anything that will never be storable.
 */
function parseReadings(payload) {
  if (payload == null || payload.length === 0) {
    throw new PoisonMessage('empty payload');
  }
  if (payload.length > MAX_BYTES) {
    throw new PoisonMessage(`payload is ${payload.length} bytes, over the ${MAX_BYTES}-byte limit`);
  }

  let body;
  const text = payload.toString('utf8');
  try {
    body = JSON.parse(text);
  } catch (err) {
    // The diagnostic that makes a misconfigured logger visible (#155): an HFEM
    // line on the JSON topic is poison either way — the sniff picks the log
    // line's words, never the parser — but "not JSON" hides exactly what went
    // wrong, and the fix is one topic segment away.
    if (text.trimStart().startsWith(':')) {
      throw new PoisonMessage(
        'looks like an HFEM line on the JSON reading topic — HFEM publishes to …/reading/hfem (misconfigured logger?)',
      );
    }
    throw new PoisonMessage(`not JSON: ${err.message}`);
  }

  let readings;
  if (Array.isArray(body)) {
    readings = body;
  } else if (body && typeof body === 'object') {
    readings = Array.isArray(body.readings) ? body.readings : [body];
  } else {
    throw new PoisonMessage(`expected an object or an array, got ${typeof body}`);
  }

  if (readings.length === 0) {
    throw new PoisonMessage('no readings in the payload');
  }
  if (readings.length > MAX_READINGS) {
    throw new PoisonMessage(
      `batch of ${readings.length} exceeds the ${MAX_READINGS}-reading limit`,
    );
  }
  for (const r of readings) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new PoisonMessage('every reading must be an object');
    }
  }

  // If the payload was an envelope, its keys other than `readings` are the
  // batch defaults ingest() already understands (`path`, `protocol`,
  // `received_at`). They are carried through untouched — the bridge has no
  // opinion about them.
  const envelope = !Array.isArray(body) && Array.isArray(body.readings)
    ? omit(body, 'readings')
    : {};

  return { readings, envelope };
}

/**
 * Parse an HFEM-topic payload — a raw `:HS=1|…|NN:` line — into the same
 * `{readings, envelope}` shape parseReadings() produces, so the batcher never
 * knows which wire format a message arrived in.
 *
 * The decode is hfem.js's (#153) and the mapping to the ingest contract is
 * hfem.js's too (toReadings, #155) — this function only draws the poison
 * line: a malformed HFEM line will never parse, however often the broker
 * redelivers it, so it is poison exactly as a non-JSON payload on the JSON
 * topic is. The reason string names the offending token because the logger's
 * author will only ever see it in this bridge's log — MQTT has no reply
 * channel.
 *
 * `receivedAt` stands in as reading_ts for a message with no T parameter (an
 * event stamped by its own arrival — see hfem.js toReadings). Injectable for
 * tests; defaults to now.
 */
function parseHfem(payload, receivedAt = () => new Date().toISOString()) {
  if (payload == null || payload.length === 0) {
    throw new PoisonMessage('empty payload');
  }
  if (payload.length > MAX_BYTES) {
    throw new PoisonMessage(`payload is ${payload.length} bytes, over the ${MAX_BYTES}-byte limit`);
  }

  const line = payload.toString('utf8').trim();
  const decoded = HFEM.decode(line);
  if (!decoded.ok) {
    throw new PoisonMessage(`HFEM: ${decoded.error}`);
  }

  const mapped = HFEM.toReadings(decoded.message, { line, receivedAt: receivedAt() });
  if (!mapped.ok) {
    throw new PoisonMessage(`HFEM: ${mapped.error}`);
  }
  if (mapped.readings.length > MAX_READINGS) {
    // A line under 256 KiB can still carry thousands of one-byte sensor tags.
    throw new PoisonMessage(
      `HFEM message maps to ${mapped.readings.length} readings, over the ${MAX_READINGS}-reading limit`,
    );
  }

  return { readings: mapped.readings, envelope: mapped.envelope };
}

/**
 * Parse a status-topic payload into what meganet.mqtt_status() wants.
 *
 * A station's status message says at minimum whether it is up; anything else it
 * chooses to send — battery, firmware, signal — is kept verbatim in
 * `station_status.last_status`, so a logger can start reporting a new field
 * without a migration or a bridge release.
 *
 * An empty payload is how a broker clears a retained message. It means "forget
 * what I said", not "the station is down", and it is not an error.
 */
function parseStatus(station, payload) {
  if (payload == null || payload.length === 0) {
    return { cleared: true };
  }
  if (payload.length > MAX_BYTES) {
    throw new PoisonMessage(`status payload is ${payload.length} bytes, over the limit`);
  }

  const text = payload.toString('utf8').trim();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  // A logger with three lines of firmware publishes `online` or `offline` as
  // plain text, or a bare 1/0, and refusing that would be pedantry: the LWT is
  // the single most useful thing MQTT gives this project and it should be as
  // easy to send as the firmware allows.
  if (typeof body === 'boolean') body = { online: body };
  else if (typeof body === 'number') body = { online: body !== 0 };
  else if (typeof body === 'string') {
    const word = body.trim().toLowerCase();
    if (word === 'online' || word === 'up') body = { online: true };
    else if (word === 'offline' || word === 'down') body = { online: false };
    else throw new PoisonMessage(`status is neither JSON nor online/offline: ${truncate(text, 40)}`);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PoisonMessage('status must be an object');
  }

  // Absent `online` means the station said something about itself without
  // claiming to be down — which is only ever published by a station that is, at
  // that moment, connected.
  const online = typeof body.online === 'boolean' ? body.online : true;

  return {
    cleared: false,
    station,
    online,
    at: typeof body.at === 'string' || typeof body.at === 'number' ? body.at : undefined,
    status: omit(body, 'online', 'at'),
  };
}

function omit(obj, ...keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
  return out;
}

function truncate(text, n) {
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

/**
 * Parse an ELPRO-topic payload — what a 115E-2 (or any x15U gateway) publishes
 * in plain, non-Sparkplug MQTT mode:
 *
 *   {"timestamp": 954711743792, "River Level": 17.61, "Battery Voltage": 13.8}
 *
 * `timestamp` is Linux epoch MILLISECONDS, which meganet.as_ts() already takes
 * as a number (it divides anything >= 1e11 by 1000). Every other key is a
 * "Payload Prefix" chosen per input on the device's MQTT I/O page, and the
 * provisioning card asks for it to be the reading's ALERT address — so the key
 * IS the address, and no mapping table exists for anybody to keep in step.
 *
 * **This parser never throws for a payload it cannot read**, which is the one
 * place it deliberately differs from parseReadings() and parseHfem(). Those two
 * decode formats this project defined; this one decodes a format a vendor
 * controls, from a device nobody here has ever had on a bench. A message that
 * arrives in a shape the documentation did not describe is the single most
 * valuable thing this path can produce, and throwing PoisonMessage would ack it,
 * log a line to an ephemeral container log, and lose the bytes.
 *
 * So an unreadable payload returns zero readings and an envelope carrying the
 * raw text in `frame`. ingest_http() writes meganet.reading_raw BEFORE it
 * validates any row, so the bytes land in the database either way — and
 * `reading_raw.frame` is documented for exactly this ("the MQTT topic and
 * bytes"). Zero readings is a well-formed batch, not an error: raw stored,
 * nothing claimed.
 *
 * The size and count limits still throw, because those are the two cases where
 * accepting the message is what causes harm rather than what preserves evidence.
 */
function parseElpro(payload, receivedAt = () => new Date().toISOString()) {
  if (payload == null || payload.length === 0) {
    throw new PoisonMessage('empty payload');
  }
  if (payload.length > MAX_BYTES) {
    throw new PoisonMessage(`payload is ${payload.length} bytes, over the ${MAX_BYTES}-byte limit`);
  }

  const text = payload.toString('utf8');
  // `frame` is per-message, so batcher.groupByEnvelope() gives every ELPRO
  // message its own POST and therefore its own reading_raw row. That is the
  // point: merging two messages would merge the evidence.
  const envelope = { protocol: 'elpro', frame: text };

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { readings: [], envelope };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { readings: [], envelope };
  }

  const stamp = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp)
    ? body.timestamp
    : receivedAt();

  const readings = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'timestamp') continue;
    // Anything that is not an address-shaped key over a finite number is left
    // in the frame rather than guessed at. A label like "River Level" is a
    // device configured against the documentation instead of against the card;
    // the raw row says so, and nothing is invented to cover it.
    const alertId = Number(key);
    if (!Number.isInteger(alertId) || alertId < 1 || alertId > 65535) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    readings.push({ alert_id: alertId, reading_ts: stamp, value_raw: value });
  }

  if (readings.length > MAX_READINGS) {
    throw new PoisonMessage(
      `ELPRO message maps to ${readings.length} readings, over the ${MAX_READINGS}-reading limit`,
    );
  }

  return { readings, envelope };
}

module.exports = { MAX_READINGS, MAX_BYTES, PoisonMessage, parseReadings, parseHfem, parseElpro, parseStatus };
