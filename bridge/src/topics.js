// topics.js — The topic scheme, in one file, because it is the part that gets
// burned into logger firmware and changing it means visiting sites.
//
//   meganet/v1/<station>/<device>/reading    device → us, QoS 1
//   meganet/v1/<station>/status              retained, and the LWT topic
//
// <station> is the stations.json slug — `loudoun_br_al` — because that is
// already the station's identity in the app, in URLs and in the database, and a
// second identifier for the same site is a mapping table somebody has to keep.
//
// <device> is which box at the site is talking: `logger`, `logger_backup`,
// `rain`. Most sites have one and call it `logger`. It is a topic segment rather
// than a payload field because it is *who published*, not what was measured —
// the reading itself carries its own address (alert_id, or station_number and
// channel) and that is what MegaNet stores.
//
// The version is in the topic and not in the payload so that v2 can be
// subscribed to alongside v1 by a second bridge, and stations can be moved
// across one at a time rather than in a flag day nobody can schedule.

const ROOT = 'meganet';
const VERSION = 'v1';
const PREFIX = `${ROOT}/${VERSION}`;

// A segment is what one level of a topic may contain. Deliberately narrower
// than MQTT allows: MQTT permits almost any UTF-8, and a station id with a space
// or an emoji in it is a support call in three months' time, not a feature.
// `$` is excluded outright — `$SYS/…` is the broker's own tree.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Is this a topic segment we will accept as a station or device name? */
function isSegment(value) {
  return typeof value === 'string' && SEGMENT.test(value);
}

/** The topic a device publishes readings to. */
function readingTopic(station, device) {
  assertSegment(station, 'station');
  assertSegment(device, 'device');
  return `${PREFIX}/${station}/${device}/reading`;
}

/** The topic a device publishes its status to, retained, and wills to on death. */
function statusTopic(station) {
  assertSegment(station, 'station');
  return `${PREFIX}/${station}/status`;
}

/**
 * Everything one station may publish, as an ACL pattern. This is the string
 * that goes in the broker's ACL for that station's credential — see
 * bridge/deploy/mosquitto.acl.example.
 */
function stationAcl(station) {
  assertSegment(station, 'station');
  return `${PREFIX}/${station}/#`;
}

/** What the bridge subscribes to. Two subscriptions, both QoS 1. */
const SUBSCRIPTIONS = [
  { topic: `${PREFIX}/+/+/reading`, qos: 1 },
  { topic: `${PREFIX}/+/status`, qos: 1 },
];

/**
 * Parse a received topic.
 *
 * Returns `{kind: 'reading', station, device}`, `{kind: 'status', station}`, or
 * `{kind: 'unknown', why}`. Never throws: a topic is remote input, and the
 * bridge's response to a topic it does not understand is a log line, not a
 * crash.
 */
function parseTopic(topic) {
  if (typeof topic !== 'string' || topic === '') {
    return { kind: 'unknown', why: 'empty topic' };
  }
  const parts = topic.split('/');
  if (parts[0] !== ROOT || parts[1] !== VERSION) {
    return { kind: 'unknown', why: `not a ${PREFIX}/… topic` };
  }

  if (parts.length === 5 && parts[4] === 'reading') {
    if (!isSegment(parts[2])) return { kind: 'unknown', why: `bad station segment: ${parts[2]}` };
    if (!isSegment(parts[3])) return { kind: 'unknown', why: `bad device segment: ${parts[3]}` };
    return { kind: 'reading', station: parts[2], device: parts[3] };
  }

  if (parts.length === 4 && parts[3] === 'status') {
    if (!isSegment(parts[2])) return { kind: 'unknown', why: `bad station segment: ${parts[2]}` };
    return { kind: 'status', station: parts[2] };
  }

  return { kind: 'unknown', why: 'topic does not match the v1 scheme' };
}

function assertSegment(value, what) {
  if (!isSegment(value)) {
    throw new Error(
      `${what} must be 1–64 chars of letters, digits, dot, dash or underscore — got ${JSON.stringify(value)}`,
    );
  }
}

module.exports = {
  ROOT,
  VERSION,
  PREFIX,
  SUBSCRIPTIONS,
  isSegment,
  parseTopic,
  readingTopic,
  statusTopic,
  stationAcl,
};
