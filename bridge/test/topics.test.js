const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTopic, readingTopic, statusTopic, stationAcl, SUBSCRIPTIONS , READING_SUFFIXES } = require('../src/topics');

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
    { topic: 'meganet/v1/+/+/reading/elpro', qos: 1 },
    { topic: 'meganet/v1/+/status', qos: 1 },
  ]);
});

test('the subscription wildcards match what the builders produce', () => {
  const matches = (filter, topic) => {
    const f = filter.split('/');
    const t = topic.split('/');
    if (f.length !== t.length) return false;
    return f.every((seg, i) => seg === '+' || seg === t[i]);
  };
  // Found by filter rather than by position: destructuring the array meant
  // adding a fourth subscription silently re-pointed `status` at the new one,
  // and the test failed somewhere unrelated to what changed.
  const byTopic = (t) => SUBSCRIPTIONS.find((s) => s.topic === t);
  const json = byTopic('meganet/v1/+/+/reading');
  const hfem = byTopic('meganet/v1/+/+/reading/hfem');
  const elpro = byTopic('meganet/v1/+/+/reading/elpro');
  const status = byTopic('meganet/v1/+/status');
  assert.ok(matches(json.topic, readingTopic('x_al', 'logger')));
  assert.ok(matches(hfem.topic, readingTopic('x_al', 'logger', 'hfem')));
  assert.ok(matches(elpro.topic, readingTopic('x_al', 'logger', 'elpro')));
  assert.ok(matches(status.topic, statusTopic('x_al')));
  // and do not overlap: `+` matches exactly one level, so every subscription is
  // disjoint from every other — a payload can never arrive on the wrong parser
  // because two filters both matched its topic.
  for (const a of SUBSCRIPTIONS) {
    for (const b of SUBSCRIPTIONS) {
      if (a === b) continue;
      assert.ok(!matches(a.topic, b.topic.replace(/\+/g, 'x_al')),
        `${a.topic} must not also match ${b.topic}`);
    }
  }
});

// ── The third reading format (#167) ──────────────────────────────────────────

test('elpro rides as a topic suffix, and is subscribed to', () => {
  assert.deepEqual(parseTopic('meganet/v1/elpro_test/logger/reading/elpro'), {
    kind: 'reading', station: 'elpro_test', device: 'logger', format: 'elpro',
  });
  assert.ok(
    SUBSCRIPTIONS.some((s) => s.topic === 'meganet/v1/+/+/reading/elpro' && s.qos === 1),
    'the parser without the subscription is a message nobody receives',
  );
});

test('every subscribed suffix parses — the check the hard-coded literal skipped', () => {
  // parseTopic gated the sixth segment on `!== 'hfem'` until the third format
  // arrived. A correctly-subscribed …/reading/elpro would have parsed as
  // unknown and been acked-and-dropped, with the subscription looking right in
  // the log. This asserts the two lists agree rather than that one string does.
  for (const format of READING_SUFFIXES) {
    const topic = `meganet/v1/s/logger/reading/${format}`;
    assert.equal(parseTopic(topic).format, format, `${topic} must parse`);
    assert.ok(
      SUBSCRIPTIONS.some((s) => s.topic === `meganet/v1/+/+/reading/${format}`),
      `${format} parses but is not subscribed`,
    );
  }
});

test('json is not spellable as a suffix', () => {
  assert.equal(parseTopic('meganet/v1/s/logger/reading/json').kind, 'unknown');
});
