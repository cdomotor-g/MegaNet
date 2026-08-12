const test = require('node:test');
const assert = require('node:assert/strict');

const { parseReadings, parseStatus, PoisonMessage, MAX_READINGS } = require('../src/messages');

const buf = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));

test('accepts the same three shapes the ingest contract does', () => {
  const one = { alert_id: 6128, reading_ts: '2026-08-12T04:15:00Z', value_raw: 12 };

  assert.deepEqual(parseReadings(buf(one)).readings, [one]);
  assert.deepEqual(parseReadings(buf([one, one])).readings, [one, one]);
  assert.deepEqual(parseReadings(buf({ readings: [one] })).readings, [one]);
});

test('envelope keys survive, and readings is not one of them', () => {
  const { readings, envelope } = parseReadings(
    buf({ path: 'MT_STUART', protocol: 'alert2', readings: [{ alert_id: 1, value_raw: 2 }] }),
  );
  assert.equal(readings.length, 1);
  assert.deepEqual(envelope, { path: 'MT_STUART', protocol: 'alert2' });
});

test('a single unwrapped reading carries no envelope', () => {
  const { envelope } = parseReadings(buf({ alert_id: 1, value_raw: 2, path: 'X' }));
  assert.deepEqual(envelope, {});
});

test('the bridge does not second-guess ingest() about a reading', () => {
  // Nonsense to the database, and deliberately fine here: one validator, in SQL,
  // so the rejection comes back with a reason somebody can read.
  const { readings } = parseReadings(buf([{ alert_id: 'not a number', reading_ts: 'yesterday' }]));
  assert.equal(readings.length, 1);
});

test('poison is anything that will never be storable', () => {
  const poison = [
    buf(''),
    Buffer.alloc(0),
    buf('{not json'),
    buf('"a string"'),
    buf('42'),
    buf([]),
    buf({ readings: [] }),
    buf([1, 2, 3]),
    buf({ readings: [null] }),
  ];
  for (const payload of poison) {
    assert.throws(() => parseReadings(payload), PoisonMessage, `accepted ${payload}`);
  }
});

test('a batch over the limit is poison, not a truncation', () => {
  const many = Array.from({ length: MAX_READINGS + 1 }, () => ({ alert_id: 1, value_raw: 1 }));
  assert.throws(() => parseReadings(buf(many)), /exceeds the 1000-reading limit/);
  // and exactly the limit is fine
  assert.equal(parseReadings(buf(many.slice(0, MAX_READINGS))).readings.length, MAX_READINGS);
});

test('an oversized payload is refused without being parsed', () => {
  const huge = Buffer.alloc(300 * 1024, 0x20);
  assert.throws(() => parseReadings(huge), /over the .* limit/);
});

test('status: JSON, with anything else the station wants to say kept', () => {
  const got = parseStatus('x_al', buf({ online: true, battery_v: 12.9, fw: '2.1' }));
  assert.equal(got.online, true);
  assert.equal(got.station, 'x_al');
  assert.deepEqual(got.status, { battery_v: 12.9, fw: '2.1' });
});

test('status: an LWT saying offline', () => {
  assert.equal(parseStatus('x_al', buf({ online: false })).online, false);
});

test('status: a station that says something without claiming to be down is up', () => {
  assert.equal(parseStatus('x_al', buf({ battery_v: 12.1 })).online, true);
});

test('status: plain-text online/offline, because an LWT should be easy to send', () => {
  for (const [text, online] of [['online', true], ['up', true], ['1', true],
    ['offline', false], ['down', false], ['0', false], ['OFFLINE\n', false]]) {
    assert.equal(parseStatus('x_al', buf(text)).online, online, `for ${JSON.stringify(text)}`);
  }
});

test('status: an empty payload clears a retained message and is not an error', () => {
  assert.deepEqual(parseStatus('x_al', Buffer.alloc(0)), { cleared: true });
  assert.deepEqual(parseStatus('x_al', null), { cleared: true });
});

test('status: anything else is poison', () => {
  assert.throws(() => parseStatus('x_al', buf('probably?')), PoisonMessage);
  assert.throws(() => parseStatus('x_al', buf([1])), PoisonMessage);
});
