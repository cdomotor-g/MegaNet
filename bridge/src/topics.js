// topics.js — The topic scheme, in one file, because it is the part that gets
// burned into logger firmware and changing it means visiting sites.
//
//   meganet/v1/<station>/<device>/reading        device → us, QoS 1 (JSON)
//   meganet/v1/<station>/<device>/reading/hfem   device → us, QoS 1 (an HFEM
//                                                line — #155; hfem.js decodes)
//   meganet/v1/<station>/<device>/reading/elpro/…  device → us, QoS 1 (an ELPRO
//                                                x15U gateway — #167, #169)
//   meganet/v1/<station>/status                  retained, and the LWT topic
//
// The `elpro` topic is the one that carries anything below its format segment,
// and that trailing `…` is deliberate rather than sloppy (#169). Every other
// topic here is spelled by firmware this project can ask for changes to; the
// ELPRO gateway assembles its own topic as `<Topic Prefix><MSGTYPE>/<Device>/
// <Sub-device>`, and none of those three are ours to name. On the bench it
// published `meganet/v1/elpro_test/logger/reading/elpro/Station 1003` — the
// tail is the *relayed ALERT2 station*, which is real information the payload
// does not carry, and `DBIRTH/elpro/Station 1003` for the birth certificate of
// the same. So the format segment is the point at which the tree stops being
// MegaNet's and starts being the vendor's, and everything below it is carried
// as opaque provenance rather than parsed.
//
// The payload format is a topic segment, not a content sniff, for the same
// reason the version is: the bridge's validation is deliberately thin and the
// database judges (messages.js), so the bridge choosing a protocol by looking
// at bytes would be an opinion it says it does not take — and a segment is
// ACL-able per station, which a sniff never is. `+/+/reading`,
// `+/+/reading/hfem` and `+/+/reading/elpro/#` are disjoint subscriptions (`+`
// matches exactly one level, and the `#` sits below a segment the other two
// spell differently), so the three shapes cannot arrive on each other's
// parser.
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
const READING_FORMATS = ['json', 'hfem', 'elpro'];

// The formats that ride as a trailing topic segment. 'json' is the bare
// `…/reading` topic and is deliberately not spellable as a suffix — a publisher
// that sent `…/reading/json` would be describing the default, and two topics
// meaning the same thing is a diagnosis nobody wants to make at 2am.
const READING_SUFFIXES = READING_FORMATS.filter((f) => f !== 'json');

// The formats whose publisher owns the topic *below* the format segment (#169).
// Only ELPRO's, and the list exists so that staying exact is the default: 'json'
// and 'hfem' are formats this project defined, published by firmware it can ask
// to change, and a tail on one of those is a misconfigured logger rather than a
// dialect — worth saying so in a log line instead of waving through.
const READING_TAIL_FORMATS = ['elpro'];

// How much of the vendor's tree we will carry. A tail is provenance, never
// identity — nothing resolves by it, no ACL is written against it — so this
// bound is not a validation rule but a stop on a pathological topic putting
// kilobytes into a log line and a database column. No real gateway comes close:
// the longest seen on the bench, `DBIRTH/elpro/Station 1003`, is 25 characters.
const MAX_TAIL = 256;

/**
 * The topic a device publishes readings to. `format` defaults to 'json' — the
 * bare `…/reading` topic; 'hfem' appends the segment that routes the payload
 * to the HFEM decoder.
 *
 * `tail` is the publisher's own tree below the format segment, for the formats
 * that have one — `Station 1003`, or `DBIRTH/elpro/Station 1003`. It is passed
 * through as written, slashes and spaces and all, because it is not ours to
 * spell (#169); asking for one on a format that does not carry a tail throws,
 * so a caller cannot invent a topic no subscription matches.
 */
function readingTopic(station, device, format = 'json', tail = '') {
  assertSegment(station, 'station');
  assertSegment(device, 'device');
  if (!READING_FORMATS.includes(format)) {
    throw new Error(`unknown reading format ${JSON.stringify(format)} — one of: ${READING_FORMATS.join(', ')}`);
  }
  const base = `${PREFIX}/${station}/${device}/reading`;
  if (!tail) return format === 'json' ? base : `${base}/${format}`;
  if (!READING_TAIL_FORMATS.includes(format)) {
    throw new Error(
      `the ${format} reading topic takes no tail — only ${READING_TAIL_FORMATS.join(', ')} carry one`,
    );
  }
  if (tail.length > MAX_TAIL) {
    throw new Error(`topic tail is ${tail.length} chars, over the ${MAX_TAIL}-char limit`);
  }
  return `${base}/${format}/${tail}`;
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

/**
 * What the bridge subscribes to. Four subscriptions, all QoS 1.
 *
 * The ELPRO filter ends in `#` because the gateway owns the tree below its
 * format segment (see the header). Two things about that `#` are worth knowing
 * before anyone edits this list:
 *
 *   - **It matches the parent too.** `…/reading/elpro/#` matches the bare
 *     `…/reading/elpro` as well as everything under it (MQTT 3.1.1 §4.7.1.2),
 *     which is why the exact `…/reading/elpro` filter that used to sit here is
 *     *gone* rather than kept alongside. Listing both would make a bare-topic
 *     message match two subscriptions, and a broker may then deliver it twice —
 *     a duplicate that no test here would have caught and that only shows up as
 *     an unexplained `dup_count` climbing in production.
 *   - **It stays disjoint from the other three.** `#` only ever expands below
 *     `elpro`, and the JSON and HFEM filters spell that segment differently or
 *     not at all, so no payload can arrive on two parsers.
 */
const SUBSCRIPTIONS = [
  { topic: `${PREFIX}/+/+/reading`, qos: 1 },
  { topic: `${PREFIX}/+/+/reading/hfem`, qos: 1 },
  { topic: `${PREFIX}/+/+/reading/elpro/#`, qos: 1 },
  { topic: `${PREFIX}/+/status`, qos: 1 },
];

/**
 * Parse a received topic.
 *
 * Returns `{kind: 'reading', station, device, format}` (format 'json' for the
 * bare topic, 'hfem' or 'elpro' for the suffixed ones), `{kind: 'status',
 * station}`, or `{kind: 'unknown', why}`. Never throws: a topic is remote
 * input, and the bridge's response to a topic it does not understand is a log
 * line, not a crash.
 *
 * A reading on a tail-bearing format also carries `source` — the publisher's
 * own tree below the format segment, joined back into one string. It is absent
 * rather than empty when there is no tail, so `if (route.source)` is the whole
 * test a caller needs and the two formats that never have one are unchanged.
 */
function parseTopic(topic) {
  if (typeof topic !== 'string' || topic === '') {
    return { kind: 'unknown', why: 'empty topic' };
  }
  const parts = topic.split('/');
  if (parts[0] !== ROOT || parts[1] !== VERSION) {
    return { kind: 'unknown', why: `not a ${PREFIX}/… topic` };
  }

  if (parts.length >= 5 && parts[4] === 'reading') {
    if (!isSegment(parts[2])) return { kind: 'unknown', why: `bad station segment: ${parts[2]}` };
    if (!isSegment(parts[3])) return { kind: 'unknown', why: `bad device segment: ${parts[3]}` };
    if (parts.length === 5) {
      return { kind: 'reading', station: parts[2], device: parts[3], format: 'json' };
    }

    const format = parts[5];
    if (!READING_SUFFIXES.includes(format)) {
      // A format segment nobody taught messages.js to parse. Unknown → acked
      // and logged (bridge.js), which is the right end for it — but the
      // subscription list above never matches one, so seeing this log line
      // means somebody published past the subscriptions, not through them.
      //
      // Read from READING_SUFFIXES rather than compared against a literal: this
      // line said `!== 'hfem'` until the third format arrived, which would have
      // made a correctly-subscribed `…/reading/elpro` message parse as unknown
      // and be dropped — a new format that fails by being silently ignored is
      // the worst shape of all, since the subscription looks right in the log.
      return { kind: 'unknown', why: `unknown reading format segment: ${format}` };
    }

    const tail = parts.slice(6);
    if (tail.length === 0) {
      return { kind: 'reading', station: parts[2], device: parts[3], format };
    }
    if (!READING_TAIL_FORMATS.includes(format)) {
      // Reachable only by publishing past the subscriptions — `…/reading/hfem`
      // is an exact filter — so this is somebody's diagnostic, and it should say
      // what it saw rather than the generic no-match line below.
      return { kind: 'unknown', why: `the ${format} reading topic takes no tail: ${tail.join('/')}` };
    }

    const source = tail.join('/');
    if (source.length > MAX_TAIL) {
      return { kind: 'unknown', why: `topic tail is ${source.length} chars, over the ${MAX_TAIL}-char limit` };
    }
    // Not run through isSegment(), and that is the decision this whole tail
    // rests on: `Station 1003` has a space in it, so the rule that keeps our own
    // segments boring would throw away every reading the gateway sends. The rule
    // is right for the segments MegaNet resolves things by and has no business
    // being applied to a name a vendor chose.
    return { kind: 'reading', station: parts[2], device: parts[3], format, source };
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
  READING_SUFFIXES,
  READING_TAIL_FORMATS,
  MAX_TAIL,
  SUBSCRIPTIONS,
  isSegment,
  parseTopic,
  readingTopic,
  statusTopic,
  stationAcl,
};
