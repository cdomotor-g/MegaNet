const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTopic, readingTopic, statusTopic, stationAcl, SUBSCRIPTIONS } = require('../src/topics');

test('builds the topics a station publishes to', () => {
  assert.equal(readingTopic('loudoun_br_al', 'logger'), 'meganet/v1/loudoun_br_al/logger/reading');
  assert.equal(statusTopic('loudoun_br_al'), 'meganet/v1/loudoun_br_al/status');
  assert.equal(stationAcl('loudoun_br_al'), 'meganet/v1/loudoun_br_al/#');
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
  });
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

test('the subscriptions cover both topic kinds, at QoS 1', () => {
  assert.deepEqual(SUBSCRIPTIONS, [
    { topic: 'meganet/v1/+/+/reading', qos: 1 },
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
  assert.ok(matches(SUBSCRIPTIONS[0].topic, readingTopic('x_al', 'logger')));
  assert.ok(matches(SUBSCRIPTIONS[1].topic, statusTopic('x_al')));
  // and do not overlap: a status message must never arrive on the reading path
  assert.ok(!matches(SUBSCRIPTIONS[0].topic, statusTopic('x_al')));
  assert.ok(!matches(SUBSCRIPTIONS[1].topic, readingTopic('x_al', 'logger')));
});
