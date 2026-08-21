const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTopic, readingTopic, statusTopic, stationAcl,
  SUBSCRIPTIONS, READING_SUFFIXES, READING_TAIL_FORMATS, MAX_TAIL,
} = require('../src/topics');

/**
 * Does an MQTT filter match a topic? The broker's rule, not an approximation of
 * it: `+` matches exactly one level, and `#` matches the level it sits at and
 * every level below — so `a/#` matches `a` as well as `a/b` (MQTT 3.1.1
 * §4.7.1.2). The tests below turn on that second clause, so it is written out
 * here rather than assumed.
 */
function matches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

test('builds the topics a station publishes to', () => {
  assert.equal(readingTopic('loudoun_br_al', 'logger'), 'meganet/v1/loudoun_br_al/logger/reading');
  assert.equal(readingTopic('loudoun_br_al', 'logger', 'hfem'), 'meganet/v1/loudoun_br_al/logger/reading/hfem');
  assert.equal(statusTopic('loudoun_br_al'), 'meganet/v1/loudoun_br_al/status');
  assert.equal(stationAcl('loudoun_br_al'), 'meganet/v1/loudoun_br_al/#');
});

test('a bureau station number is a station segment', () => {
  // The publisher identity since 0020. A number leads with a digit, which the
  // grammar has always allowed — this test is here so that stops being an
  // accident of the regex and starts being a promise.
  assert.equal(readingTopic('541155', 'logger'), 'meganet/v1/541155/logger/reading');
  assert.equal(readingTopic('422001A', 'logger'), 'meganet/v1/422001A/logger/reading');
  assert.equal(statusTopic('541155'), 'meganet/v1/541155/status');
  assert.equal(stationAcl('541155'), 'meganet/v1/541155/#');
  assert.deepEqual(parseTopic('meganet/v1/541155/logger/reading'), {
    kind: 'reading', station: '541155', device: 'logger', format: 'json',
  });
  assert.deepEqual(parseTopic('meganet/v1/541155/status'), {
    kind: 'status', station: '541155',
  });

  // A site with no bureau number publishes under its station id — the fallback
  // half of the rule, and the reason the slug shape still has to parse.
  assert.equal(statusTopic('mt_mowbullan_rptr'), 'meganet/v1/mt_mowbullan_rptr/status');

  // Leading zeros are part of the segment, not decoration: the database
  // resolves the number by exact match, so these are two different publishers
  // and the broker ACL is what stops the wrong one from being flashed.
  assert.notEqual(statusTopic('041564'), statusTopic('41564'));
});

test('refuses to build a reading topic for a format nobody parses', () => {
  assert.throws(() => readingTopic('x_al', 'logger', 'csv'), /unknown reading format/);
});

test('refuses to build a topic out of something that is not a segment', () => {
  for (const bad of ['', 'has space', 'a/b', 'wild+card', 'hash#', '$SYS', '_leading', null, 7]) {
    assert.throws(() => readingTopic(bad, 'logger'), /station must be/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('parses a reading topic', () => {
  assert.deepEqual(parseTopic('meganet/v1/loudoun_br_al/logger/reading'), {
    kind: 'reading',
    station: 'loudoun_br_al',
    device: 'logger',
    format: 'json',
  });
});

test('parses an HFEM reading topic (#155)', () => {
  assert.deepEqual(parseTopic('meganet/v1/loudoun_br_al/logger/reading/hfem'), {
    kind: 'reading',
    station: 'loudoun_br_al',
    device: 'logger',
    format: 'hfem',
  });
  // A format segment nobody taught messages.js: unknown, with the segment named.
  const got = parseTopic('meganet/v1/loudoun_br_al/logger/reading/csv');
  assert.equal(got.kind, 'unknown');
  assert.match(got.why, /csv/);
});

test('parses a status topic', () => {
  assert.deepEqual(parseTopic('meganet/v1/abercorn_al/status'), {
    kind: 'status',
    station: 'abercorn_al',
  });
});

test('a topic outside the scheme is unknown, never a throw', () => {
  const outside = [
    '',
    'meganet/v2/x/logger/reading',
    'meganet/v1/x/logger/readings',
    'meganet/v1/x/logger/reading/extra',
    'meganet/v1/x/logger',
    'other/v1/x/status',
    '$SYS/broker/uptime',
    'meganet/v1//status',
    'meganet/v1/has space/logger/reading',
  ];
  for (const topic of outside) {
    const got = parseTopic(topic);
    assert.equal(got.kind, 'unknown', `${topic} parsed as ${got.kind}`);
    assert.ok(got.why, `${topic} came back without a reason`);
  }
});

test('the subscriptions cover every topic kind, at QoS 1', () => {
  assert.deepEqual(SUBSCRIPTIONS, [
    { topic: 'meganet/v1/+/+/reading', qos: 1 },
    { topic: 'meganet/v1/+/+/reading/hfem', qos: 1 },
    { topic: 'meganet/v1/+/+/reading/elpro/#', qos: 1 },
    { topic: 'meganet/v1/+/status', qos: 1 },
  ]);
});

test('the bare elpro filter is gone, not kept beside the wildcard (#169)', () => {
  // `…/reading/elpro/#` already matches `…/reading/elpro`. Listing the exact
  // filter as well would make a bare-topic message match two subscriptions, and
  // a broker may deliver it once per match — a duplicate reading with nothing in
  // any log to explain it, which is why this is asserted rather than remembered.
  assert.ok(
    !SUBSCRIPTIONS.some((s) => s.topic === 'meganet/v1/+/+/reading/elpro'),
    'the exact elpro filter must not sit beside the wildcard one',
  );
  assert.ok(matches('meganet/v1/+/+/reading/elpro/#', 'meganet/v1/s/logger/reading/elpro'));
});

test('every topic the scheme can produce matches exactly one subscription', () => {
  // Replaces a pairwise filter-against-filter check, which cannot express what
  // the `#` made possible: two filters overlapping *below* a segment rather than
  // at it. Exactly-one is the property that matters at both ends — none means a
  // publisher the broker never forwards (#169, and the reason this took a
  // screenshot of the broker to diagnose), two means a duplicate delivery.
  const topics = [
    readingTopic('x_al', 'logger'),
    readingTopic('541155', 'logger'),
    readingTopic('x_al', 'logger', 'hfem'),
    readingTopic('x_al', 'logger', 'elpro'),
    // What the 115E-2 actually publishes, tails and all.
    readingTopic('elpro_test', 'logger', 'elpro', 'Station 1003'),
    readingTopic('elpro_test', 'logger', 'elpro', 'DBIRTH/elpro/Station 1003'),
    readingTopic('elpro_test', 'logger', 'elpro', 'Broker Diagnostics'),
    statusTopic('x_al'),
  ];
  for (const topic of topics) {
    const hit = SUBSCRIPTIONS.filter((s) => matches(s.topic, topic));
    assert.equal(hit.length, 1,
      `${topic} matched ${hit.length} subscriptions: ${hit.map((h) => h.topic).join(', ') || 'none'}`);
  }
});

// ── The third reading format (#167) ──────────────────────────────────────────

test('elpro rides as a topic suffix, and is subscribed to', () => {
  assert.deepEqual(parseTopic('meganet/v1/elpro_test/logger/reading/elpro'), {
    kind: 'reading', station: 'elpro_test', device: 'logger', format: 'elpro',
  });
  assert.ok(
    SUBSCRIPTIONS.some((s) => matches(s.topic, 'meganet/v1/elpro_test/logger/reading/elpro') && s.qos === 1),
    'the parser without the subscription is a message nobody receives',
  );
});

// ── The gateway's own tree below the format segment (#169) ───────────────────

test('an elpro topic carries the gateway tail as source, spaces and all', () => {
  // The topic the bench unit actually published. `Station 1003` is the relayed
  // ALERT2 station, and the space in it is why the tail is never run through
  // isSegment(): the rule that keeps MegaNet's own segments boring would throw
  // away every reading this device sends.
  assert.deepEqual(parseTopic('meganet/v1/elpro_test/logger/reading/elpro/Station 1003'), {
    kind: 'reading', station: 'elpro_test', device: 'logger', format: 'elpro',
    source: 'Station 1003',
  });
  // A deeper tail is one string, not a second parse — nothing resolves by it.
  assert.equal(
    parseTopic('meganet/v1/elpro_test/logger/reading/elpro/DBIRTH/elpro/Station 1000').source,
    'DBIRTH/elpro/Station 1000',
  );
});

test('source is absent, not empty, when there is no tail', () => {
  // So `if (route.source)` is the whole test bridge.js needs, and the two
  // formats that never carry one parse to exactly what they always did.
  assert.ok(!('source' in parseTopic('meganet/v1/s/logger/reading/elpro')));
  assert.ok(!('source' in parseTopic('meganet/v1/s/logger/reading/hfem')));
  assert.ok(!('source' in parseTopic('meganet/v1/s/logger/reading')));
});

test('only the formats that own a tail may carry one', () => {
  assert.deepEqual(READING_TAIL_FORMATS, ['elpro']);
  // Reachable only by publishing past the subscriptions — the HFEM filter is
  // exact — so it is somebody's diagnostic, and it should name what it saw.
  const got = parseTopic('meganet/v1/s/logger/reading/hfem/Station 1003');
  assert.equal(got.kind, 'unknown');
  assert.match(got.why, /takes no tail/);
  assert.throws(() => readingTopic('s', 'logger', 'hfem', 'Station 1003'), /takes no tail/);
});

test('a tail is bounded, because it reaches a log line and a database column', () => {
  const long = 'x'.repeat(MAX_TAIL + 1);
  const got = parseTopic(`meganet/v1/s/logger/reading/elpro/${long}`);
  assert.equal(got.kind, 'unknown');
  assert.match(got.why, /over the 256-char limit/);
  assert.equal(parseTopic(`meganet/v1/s/logger/reading/elpro/${'x'.repeat(MAX_TAIL)}`).kind, 'reading');
  assert.throws(() => readingTopic('s', 'logger', 'elpro', long), /over the 256-char limit/);
});

test('a station ACL still covers everything the gateway publishes', () => {
  // The tail sits under the station segment, so the per-station credential that
  // 0020 generates needs no widening to permit it — which is the property that
  // made putting the vendor's tree below our format segment safe in the first
  // place.
  assert.ok(matches(stationAcl('elpro_test'),
    'meganet/v1/elpro_test/logger/reading/elpro/DBIRTH/elpro/Station 1003'));
});

test('every subscribed suffix parses — the check the hard-coded literal skipped', () => {
  // parseTopic gated the sixth segment on `!== 'hfem'` until the third format
  // arrived. A correctly-subscribed …/reading/elpro would have parsed as
  // unknown and been acked-and-dropped, with the subscription looking right in
  // the log. This asserts the two lists agree rather than that one string does.
  for (const format of READING_SUFFIXES) {
    const topic = `meganet/v1/s/logger/reading/${format}`;
    assert.equal(parseTopic(topic).format, format, `${topic} must parse`);
    // Asserted by matching rather than by string equality, so that a format
    // gaining or losing a tail is not also a rewrite of this check.
    assert.ok(
      SUBSCRIPTIONS.some((s) => matches(s.topic, topic)),
      `${format} parses but is not subscribed`,
    );
  }
});

test('json is not spellable as a suffix', () => {
  assert.equal(parseTopic('meganet/v1/s/logger/reading/json').kind, 'unknown');
});
