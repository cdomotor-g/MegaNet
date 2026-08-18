const test = require('node:test');
const assert = require('node:assert/strict');

const { parseReadings, parseHfem, parseStatus, PoisonMessage, MAX_READINGS } = require('../src/messages');

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

// ── HFEM (#155) ──────────────────────────────────────────────────────────────
// The decode itself is hfem.js's and test/hfem.mjs proves it against the spec;
// these tests prove the *bridge's* half: the mapping to the ingest contract,
// the poison line, and the stand-in timestamp.

const HFEM_LINE = ':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|B_1-16=13.9|NN:';

test('hfem: a line becomes ingest readings under an hfem envelope', () => {
  const { readings, envelope } = parseHfem(buf(HFEM_LINE));
  assert.deepEqual(envelope, { protocol: 'hfem', frame: HFEM_LINE });
  assert.deepEqual(readings, [
    // R_1-0: raw scheme — the count is what was transmitted, and the count is
    // what is stored (0006 decision 5).
    { station_number: '123456', channel: 'R_1',
      reading_ts: '2010-07-27T03:00:00Z', value_raw: 1055, unit: 'count' },
    // B_1-16: translated — the engineering value is also what was transmitted,
    // so it is value AND value_raw.
    { station_number: '123456', channel: 'B_1',
      reading_ts: '2010-07-27T03:00:00Z', value: 13.9, value_raw: 13.9, unit: 'V' },
  ]);
});

test('hfem: all three timestamp schemes land the same UTC instant (#152 trap 1)', () => {
  // Spec examples g) and h): the same observation written as T2 and as T3.
  const utc = (line) => parseHfem(buf(line)).readings[0].reading_ts;
  assert.equal(utc(':HS=1|I1=1|T1=20100727030000|H_1-16=1.2|NN:'), '2010-07-27T03:00:00Z');
  assert.equal(utc(':HS=1|I1=1|T2=20100727030000+10|H_1-16=1.2|NN:'), '2010-07-27T03:00:00Z');
  assert.equal(utc(':HS=1|I1=1|T3=20100727130000-10|H_1-16=1.2|NN:'), '2010-07-27T03:00:00Z');
});

test('hfem: M=1 marks every reading maintenance', () => {
  const { readings } = parseHfem(buf(':HS=1|M=1|I1=99|T1=20260817220000|R_1-0=12|H_1-16=1.5|NN:'));
  assert.equal(readings.length, 2);
  for (const r of readings) assert.equal(r.quality, 'maintenance');
});

test('hfem: dissolved oxygen ppm arrives as mg/L — one quantity, one unit key (0018)', () => {
  const { readings } = parseHfem(buf(':HS=1|I1=7|T1=20260817220000|DO_1-16=8.3|NN:'));
  assert.equal(readings[0].unit, 'mg/L');
});

test('hfem: an I2 site identifier keeps its wire value, agency and all', () => {
  const { readings } = parseHfem(buf(':HS=1|I2=AGENCY-STATION1|T1=20260817220000|H_1-16=0.4|NN:'));
  assert.equal(readings[0].station_number, 'AGENCY-STATION1');
});

test('hfem: a message with no timestamp is stamped by its own arrival', () => {
  const { readings } = parseHfem(
    buf(':HS=1|I1=5|R_1-0=3|NN:'),
    () => '2026-08-18T01:02:03Z',
  );
  assert.equal(readings[0].reading_ts, '2026-08-18T01:02:03Z');
});

test('hfem: spaces are white space, stripped before parsing (§2 note 3)', () => {
  const { readings } = parseHfem(buf(' :HS=1 | I1=123456 | T1=20100727030000 | R_1-0=1055 | NN: \n'));
  assert.equal(readings[0].value_raw, 1055);
});

test('hfem: a malformed line is poison, with the offending token named', () => {
  const poison = [
    [':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|NN', /truncated/],       // no end-of-message
    [':HS=1|I1=123456|R_1-5=9|NN:', /scheme 5/],                            // undefined scheme
    [':HS=1|I1=123456|XX_1-0=9|NN:', /unknown sensor class/],               // no such class
    [':HS=1|I1=123456|NN:', /no sensor measurements/],                      // nothing measured
    [':HS=2|I1=123456|R_1-0=9|NN:', /version 2/],                           // future version
    ['not hfem at all', /start-of-message/],
  ];
  for (const [line, why] of poison) {
    assert.throws(() => parseHfem(buf(line)), PoisonMessage, line);
    assert.throws(() => parseHfem(buf(line)), why, line);
  }
});

test('hfem: an oversized payload is refused without being parsed', () => {
  assert.throws(() => parseHfem(Buffer.alloc(300 * 1024, 0x20)), /over the/);
});

test('an HFEM line on the JSON topic is poison that says where to publish instead', () => {
  assert.throws(() => parseReadings(buf(HFEM_LINE)), /reading\/hfem/);
});
