// topics.js — The topic scheme, in one file, because it is the part that gets
// burned into logger firmware and changing it means visiting sites.
//
//   meganet/v1/<station>/<device>/reading        device → us, QoS 1 (JSON)
//   meganet/v1/<station>/<device>/reading/hfem   device → us, QoS 1 (an HFEM
//                                                line — #155; hfem.js decodes)
//   meganet/v1/<station>/status                  retained, and the LWT topic
//
// The payload format is a topic segment, not a content sniff, for the same
// reason the version is: the bridge's validation is deliberately thin and the
// database judges (messages.js), so the bridge choosing a protocol by looking
// at bytes would be an opinion it says it does not take — and a segment is
// ACL-able per station, which a sniff never is. `+/+/reading` and
// `+/+/reading/hfem` are disjoint subscriptions (`+` matches exactly one
// level), so the two shapes cannot arrive on each other's parser.
//
// <station> is the BUREAU STATION NUMBER — `541155` — the number on the site
// card, in the Bureau's systems and on the paperwork. It was the stations.json
// slug until 0020, on the reasoning that the slug was already the station's
// identity in the app and a second identifier is a mapping table somebody has
// to keep. The reasoning was right and the identifier was wrong: the slug is
// derived from the station's NAME by core.js `slug()`, so it exists because
// somebody typed "Loudoun Br AL" into this app. Nobody at the site knows it,
// and editing the name moves it — in the one copy that costs a site visit to
// change. The bureau number is not ours to move, which is what makes it a key.
//
// Sites that have no bureau number — repeaters, radars, base stations, a test
// rig — publish under their station id instead. That is one rule, not two
// identifiers: a site has a number or it has not, and the database resolves
// either without a mapping table (meganet.resolve_publisher, 0020). The two
// namespaces are disjoint on the live registry, and the bureau number is unique
// among stations that have one, so "number first, then id" cannot be a guess.
//
// Publish the number exactly as meganet.station.station_number holds it —
// `41564`, not `041564`. A mistyped segment is loud rather than silent: the
// broker ACL is generated from that same column (deploy/mosquitto.acl.example),
// so a credential may only write the topic its number actually spells, and the
// broker refuses the publish rather than the database quietly filing it under
// an identity nobody claims.
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

// The payload formats a reading topic may carry. 'json' is the bare topic;
// anything else is a suffix segment. Growing this set means teaching
// messages.js the shape first — the subscription without the parser is a
// message the bridge acks nothing about.
const READING_FORMATS = ['json', 'hfem'];

/**
 * The topic a device publishes readings to. `format` defaults to 'json' — the
 * bare `…/reading` topic; 'hfem' appends the segment that routes the payload
 * to the HFEM decoder.
 */
function readingTopic(station, device, format = 'json') {
  assertSegment(station, 'station');
  assertSegment(device, 'device');
  if (!READING_FORMATS.includes(format)) {
    throw new Error(`unknown reading format ${JSON.stringify(format)} — one of: ${READING_FORMATS.join(', ')}`);
  }
  const base = `${PREFIX}/${station}/${device}/reading`;
  return format === 'json' ? base : `${base}/${format}`;
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

/** What the bridge subscribes to. Three subscriptions, all QoS 1. */
const SUBSCRIPTIONS = [
  { topic: `${PREFIX}/+/+/reading`, qos: 1 },
  { topic: `${PREFIX}/+/+/reading/hfem`, qos: 1 },
  { topic: `${PREFIX}/+/status`, qos: 1 },
];

/**
 * Parse a received topic.
 *
 * Returns `{kind: 'reading', station, device, format}` (format 'json' for the
 * bare topic, 'hfem' for the suffixed one), `{kind: 'status', station}`, or
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

  if ((parts.length === 5 || parts.length === 6) && parts[4] === 'reading') {
    if (!isSegment(parts[2])) return { kind: 'unknown', why: `bad station segment: ${parts[2]}` };
    if (!isSegment(parts[3])) return { kind: 'unknown', why: `bad device segment: ${parts[3]}` };
    if (parts.length === 6 && parts[5] !== 'hfem') {
      // A format segment nobody taught messages.js to parse. Unknown → acked
      // and logged (bridge.js), which is the right end for it — but the
      // subscription list above never matches one, so seeing this log line
      // means somebody published past the subscriptions, not through them.
      return { kind: 'unknown', why: `unknown reading format segment: ${parts[5]}` };
    }
    return { kind: 'reading', station: parts[2], device: parts[3],
             format: parts.length === 6 ? parts[5] : 'json' };
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
  READING_FORMATS,
  SUBSCRIPTIONS,
  isSegment,
  parseTopic,
  readingTopic,
  statusTopic,
  stationAcl,
};
