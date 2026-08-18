// The HFEM codec, held to the spec's own examples (#153, EPIC #152).
//
// `archive/BoM HFEM v1.0.pdf` is the only oracle this format has — there is no
// sample capture to check against — so these tests are the specification
// restated: the ten worked examples of §4.4 decode to the expected structure
// and re-encode byte-for-byte, every row of Table 3's timestamp scheme is one
// case, and every rejection asserts its *reason*, not merely that it failed.
//
// The load-bearing assertion is the g)/h) pair: `T2=20100727030000+10` and
// `T3=20100727130000-10` are the same observation written both ways, and both
// mean 03:00 UTC. Hand either to an ISO-8601 parser and it is wrong — T2 by
// ten hours, T3 by twenty — which is #152's trap 1 in a single test.
//
// Run:  npm run hfem
//       npm run hfem -- -v    also print what passed

import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HFEM = require(path.join(REPO_ROOT, 'hfem.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function decodeOk(line) {
  const r = HFEM.decode(line);
  check(`decodes: ${line}`, r.ok, r.ok ? '' : r.error);
  return r.ok ? r.message : null;
}

// A rejection must name its reason — silent partial decode is the failure mode
// that matters in a format with no checksum.
function rejects(line, why, label = line) {
  const r = HFEM.decode(line);
  check(`rejects ${label}`, !r.ok && r.error.includes(why),
        r.ok ? 'decoded instead of rejecting' : `reason "${r.error}" does not mention "${why}"`);
}

// ── The ten worked examples of §4.4, byte-for-byte ───────────────────────────

const EXAMPLES = [
  ':HS=1|I1=123456|R_1-0=1055|NN:',                                        // a
  ':HS=1|I1=123456|R_1-0=1055|B_1-10=139|NN:',                             // b
  ':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|B_1-10=139|NN:',           // c
  ':HS=1|I1=123456|T1=20100727030000|R_1-0=1055|NN:',                      // d
  ':HS=1|I1=123456|R_1-0=101|R_2-0=201|NN:',                               // e
  ':HS=1|I1=123456|T1=20100727030000|R_1-0=101|R_2-0=201|NN:',             // f
  ':HS=1|I1=123456|T2=20100727030000+10|R_1-0=1098|H_1-10=1051|NN:',       // g
  ':HS=1|I1=123456|T3=20100727130000-10|R_1-0=1098|H_1-10=1051|NN:',       // h
  ':HS=1|M=1|I1=123456|T1=20100727030000|R_1-0=101|B_1-10=139|NN:',        // i
  ':HS=1|I1=123456|T3=20100727130000-10|R_1-6=10.2|H_1-16=120.901|NN:',    // j
];

for (const line of EXAMPLES) {
  const msg = decodeOk(line);
  if (!msg) continue;
  const enc = HFEM.encode(msg);
  check(`re-encodes byte-for-byte: ${line}`,
        enc.ok && enc.line === line, enc.ok ? `got ${enc.line}` : enc.error);
  // Round-trip property: decode → encode → decode is a fixed point.
  const again = HFEM.decode(enc.ok ? enc.line : '');
  check(`decode∘encode is a fixed point: ${line}`,
        again.ok && JSON.stringify(again.message) === JSON.stringify(msg));
}

// ── What the examples decode TO — structure, not just success ────────────────

{
  const a = HFEM.decode(EXAMPLES[0]).message;
  check('a) site came in on scheme I1, id 123456',
        a.site.scheme === 'I1' && a.site.id === '123456' && a.site.agency === null);
  check('a) R_1-0 is Rainfall #1, cumulative raw, rollover 2047 (the legacy ALERT ceiling)',
        a.sensors[0].className === 'Rainfall' && a.sensors[0].instance === 1
        && a.sensors[0].sampling === 'cumulative' && a.sensors[0].representation === 'raw'
        && a.sensors[0].rollover === 2047 && a.sensors[0].unit === 'count'
        && a.sensors[0].value === 1055);
  check('a) no timestamp, no maintenance, no notes',
        a.time === null && a.maintenance === false && a.notes.length === 0);
}
{
  const b = HFEM.decode(EXAMPLES[1]).message;
  check('b) B_1-10 is Battery #1, instantaneous raw — a raw counter has no engineering unit',
        b.sensors[1].className === 'Battery' && b.sensors[1].sampling === 'instantaneous'
        && b.sensors[1].representation === 'raw' && b.sensors[1].unit === 'count'
        && b.sensors[1].value === 139);
}
{
  const i = HFEM.decode(EXAMPLES[8]).message;
  check('i) M=1 decodes as maintenance — a data-quality fact, not a log line',
        i.maintenance === true);
}
{
  const j = HFEM.decode(EXAMPLES[9]).message;
  check('j) R_1-6 is translated: value 10.2, unit mm, cumulative',
        j.sensors[0].representation === 'translated' && j.sensors[0].value === 10.2
        && j.sensors[0].unit === 'mm' && j.sensors[0].sampling === 'cumulative'
        && j.sensors[0].rollover === null);
  check('j) H_1-16 is translated: value 120.901, unit m, instantaneous',
        j.sensors[1].representation === 'translated' && j.sensors[1].value === 120.901
        && j.sensors[1].unit === 'm' && j.sensors[1].sampling === 'instantaneous');
  check('j) three decimals on H is within Water Level\'s stated accuracy — no note',
        j.notes.length === 0);
}

// ── Table 3, one case per row — and the g)/h) pair, the whole trap in one ────

{
  const t1 = HFEM.decode(':HS=1|I1=1|T1=20100701130010|R_1-0=1|NN:').message;
  check('T1 is UTC as written', t1.time.utc === '2010-07-01T13:00:10Z'
        && t1.time.offsetHours === null && t1.time.utcIsStated === true);

  const t2 = HFEM.decode(':HS=1|I1=1|T2=20100701130010+10|R_1-0=1|NN:').message;
  check('T2: the stamp IS UTC — the suffix is ignored for the instant',
        t2.time.utc === '2010-07-01T13:00:10Z' && t2.time.utcIsStated === true);
  check('T2: the suffix yields local standard time (stamp + offset)',
        t2.time.localIso === '2010-07-01T23:00:10' && t2.time.offsetHours === 10);

  // Table 3's own T3 example: LST 03:00:10 in Victoria, written -10 → UTC is
  // the previous day, 17:00:10.
  const t3 = HFEM.decode(':HS=1|I1=1|T3=20100701030010-10|R_1-0=1|NN:').message;
  check('T3: the stamp is LOCAL — UTC = stamp + offset, sign as written',
        t3.time.utc === '2010-06-30T17:00:10Z' && t3.time.utcIsStated === false);
  check('T3: the stamp itself is the local time', t3.time.localIso === '2010-07-01T03:00:10');

  // Spec examples g) and h): the same observation written both ways.
  const g = HFEM.decode(EXAMPLES[6]).message;
  const h = HFEM.decode(EXAMPLES[7]).message;
  check('g) and h) are the same instant: T2=…030000+10 ≡ T3=…130000-10 ≡ 03:00 UTC',
        g.time.utc === '2010-07-27T03:00:00Z' && h.time.utc === g.time.utc);
  check('…and an ISO-8601 reading of either would have been wrong (T2 by 10 h, T3 by 20)',
        g.time.utc !== '2010-07-26T17:00:00Z' && h.time.utc !== '2010-07-28T09:00:00Z');
}

// ── Structural rejections, each with its reason ──────────────────────────────

rejects('HS=1|I1=123456|R_1-0=1055|NN:', 'start-of-message');
rejects(':HS=1|I1=123456|R_1-0=1055|NN', 'end-of-message');
rejects(':HS=1|I1=123456|R_1-0=1055:', 'NN footer', 'a message with no NN footer');
rejects(':HS=1|I1=123456|NN|R_1-0=1055:', 'NN footer', 'a footer that is not last');
rejects(':HS=1|I1=123456|NN|R_1-0=1055|NN:', 'NN before the end');
rejects(':XY=1|I1=123456|R_1-0=1055|NN:', 'unsupported message type "XY"');
rejects(':HS=2|I1=123456|R_1-0=1055|NN:', 'version 2');
rejects(':HS=1|I1=123456|FOO|R_1-0=1|NN:', 'not a name-value pair');
rejects(':HS=1|I1=123456|I1=123456|R_1-0=1|NN:', 'duplicate parameter "I1"');
rejects(':HS=1|I1=123456|R_1-0=1|R_1-0=2|NN:', 'duplicate parameter "R_1-0"');
rejects(':HS=1|I1=123456|I2=BOM002-12345678|R_1-0=1|NN:', 'two site identifiers');
rejects(':HS=1|I1=123456|T1=20100701130010|T2=20100701130010+10|R_1-0=1|NN:',
        'two observation timestamps');
rejects(':HS=1|R_1-0=1055|NN:', 'no site identifier');
rejects(':HS=1|I1=123456|NN:', 'no sensor measurements');
rejects(':HS=1|I1=123456||R_1-0=1|NN:', 'empty parameter');
rejects(':HS=1|I1=123456|R_1-0=1|Q=5|NN:', 'unknown parameter "Q"');
rejects(':HS=1|I1=123456789|R_1-0=1|NN:', 'eight alphanumerics', 'a nine-character I1');
rejects(':HS=1|I2=BOM02-12345678|R_1-0=1|NN:', 'six alphanumerics', 'a five-character I2 agency');

// ── Sensor-tag rejections — by name, never inferred from the tens digit ──────

rejects(':HS=1|I1=123456|R_0-0=1055|NN:', 'instances start at 1', 'instance zero (R_0-0)');
rejects(':HS=1|I1=123456|ZZ_1-0=1055|NN:', 'unknown sensor class "ZZ"');
for (const scheme of [5, 7, 8, 9, 15, 17, 18, 19, 25, 27]) {
  rejects(`:HS=1|I1=123456|R_1-${scheme}=10|NN:`, `scheme ${scheme} is not defined`,
          `undefined measurement scheme ${scheme}`);
}
rejects(':HS=1|I1=123456|R_1-0=10.5|NN:', 'raw integer counter', 'a decimal on a raw scheme');
rejects(':HS=1|I1=123456|R_1-6=ten|NN:', 'translated engineering value', 'a non-number on a translated scheme');
rejects(':HS=1|I1=123456|M=0|R_1-0=1|NN:', 'only M=1 is defined');

// ── Timestamp rejections ─────────────────────────────────────────────────────

rejects(':HS=1|I1=123456|T1=2010072703000|R_1-0=1|NN:', 'fourteen digits', 'a thirteen-digit T1');
rejects(':HS=1|I1=123456|T1=20100230030000|R_1-0=1|NN:', 'not a real calendar instant',
        'the 30th of February');
rejects(':HS=1|I1=123456|T3=20100727130000|R_1-0=1|NN:', 'whole-hour offset',
        'a T3 with no offset');
rejects(':HS=1|I1=123456|T3=20100727130000+9.5|R_1-0=1|NN:', 'half-hour zones',
        'a +9.5 offset (see #152 open question 3)');
rejects(':HS=1|I1=123456|T2=20100727130000+0930|R_1-0=1|NN:', 'whole-hour offset',
        'an HHMM-style offset');
rejects(':HS=1|I1=123456|T2=20100727130000+15|R_1-0=1|NN:', 'beyond UTC±14', 'a +15 offset');

// ── Accept-and-note, never reject: over-reporting is not lying ───────────────

{
  const r = HFEM.decode(':HS=1|I1=123456|R_1-6=10.234|NN:');
  check('extra precision is accepted…', r.ok && r.message.sensors[0].value === 10.234);
  check('…and noted against the class\'s stated accuracy',
        r.ok && r.message.notes.length === 1 && r.message.notes[0].includes('stated accuracy is 1'));
}
{
  const r = HFEM.decode(':HS=1|I1=123456|R_1-0=3000|NN:');
  check('a raw value above its scheme\'s ceiling is accepted…', r.ok && r.message.sensors[0].value === 3000);
  check('…and noted against the declared rollover',
        r.ok && r.message.notes.length === 1 && r.message.notes[0].includes('2047'));
}

// ── Whitespace, leading zeros, order (§2 notes 2–3, §2.1) ────────────────────

{
  const spaced = HFEM.decode(': HS=1 | I1=123456 | R_1-0=1055 | NN :');
  const plain  = HFEM.decode(EXAMPLES[0]);
  check('spaces are insignificant and stripped before parsing',
        spaced.ok && JSON.stringify(spaced.message) === JSON.stringify(plain.message));

  const zeros = HFEM.decode(':HS=1|I1=123456|R_01-00=1055|NN:');
  check('leading zeros on instance and scheme are insignificant',
        zeros.ok && zeros.message.sensors[0].instance === 1
        && zeros.message.sensors[0].scheme === 0
        && zeros.message.sensors[0].tag === 'R_1-0');

  const shuffled = HFEM.decode(':HS=1|R_1-0=1055|T1=20100727030000|M=1|I1=123456|NN:');
  check('body parameters decode in any order', shuffled.ok && shuffled.message.maintenance
        && shuffled.message.site.id === '123456' && shuffled.message.time !== null);
  const enc = HFEM.encode(shuffled.message);
  check('…and re-encode in spec order: header, M, site, time, sensors, NN',
        enc.ok && enc.line === ':HS=1|M=1|I1=123456|T1=20100727030000|R_1-0=1055|NN:');
}

// ── I2, and encoding a structure built by hand (#154's test-message path) ────

{
  const r = HFEM.decode(':HS=1|I2=BOM002-12345678|R_1-0=1|NN:');
  check('I2 decodes into agency and id, and says which scheme it came in on',
        r.ok && r.message.site.scheme === 'I2'
        && r.message.site.agency === 'BOM002' && r.message.site.id === '12345678');
}
{
  const enc = HFEM.encode({
    type: 'HS', version: 1, maintenance: false,
    site: { scheme: 'I1', id: '123456' },
    time: { scheme: 'T2', utc: '2010-07-27T03:00:00Z', offsetHours: 10 },
    sensors: [{ cls: 'R', instance: 1, scheme: 0, value: 1098 },
              { cls: 'H', instance: 1, scheme: 10, value: 1051 }],
  });
  check('a hand-built structure (no raw/valueText) encodes to the wire form',
        enc.ok && enc.line === EXAMPLES[6], enc.ok ? enc.line : enc.error);
  const encBad = HFEM.encode({
    type: 'HS', version: 1, site: { scheme: 'I1', id: '123456' },
    sensors: [{ cls: 'R', instance: 1, scheme: 5, value: 1 }],
  });
  check('the encoder refuses an undefined scheme too — one opinion, both directions',
        !encBad.ok && encBad.error.includes('scheme 5'));
}

// ── The ingest mapping (#155) — toReadings, the table both adapters share ────

{
  const line = ':HS=1|M=1|I1=123456|T3=20100727130000-10|R_1-0=1055|DO_1-16=8.3|NN:';
  const d = HFEM.decode(line);
  const m = HFEM.toReadings(d.message, { line });
  check('toReadings: maps a decoded message', m.ok, m.ok ? '' : m.error);
  if (m.ok) {
    check('toReadings: the envelope is protocol hfem with the wire line as frame',
          m.envelope.protocol === 'hfem' && m.envelope.frame === line);
    check('toReadings: T3 resolved to the UTC instant, not the local stamp (#152 trap 1)',
          m.readings.every(r => r.reading_ts === '2010-07-27T03:00:00Z'));
    check('toReadings: a raw scheme is value_raw in counts — no engineering unit invented',
          m.readings[0].value_raw === 1055 && m.readings[0].unit === 'count'
          && !('value' in m.readings[0]));
    check('toReadings: a translated scheme is value AND value_raw — it still transmitted something',
          m.readings[1].value === 8.3 && m.readings[1].value_raw === 8.3);
    check('toReadings: ppm becomes mg/L — one quantity, one unit key (0018 records why)',
          m.readings[1].unit === 'mg/L');
    check('toReadings: M=1 marks every reading maintenance',
          m.readings.every(r => r.quality === 'maintenance'));
    check('toReadings: channel is class_instance — the scheme digit is representation, not identity',
          m.readings[0].channel === 'R_1' && m.readings[1].channel === 'DO_1');
  }

  const noTime = HFEM.decode(':HS=1|I1=5|R_1-0=3|NN:');
  const refused = HFEM.toReadings(noTime.message);
  check('toReadings: a timestampless message without receivedAt is a refusal, never a guess',
        !refused.ok && refused.error.includes('receivedAt'));
  const stamped = HFEM.toReadings(noTime.message, { receivedAt: '2026-08-18T01:02:03Z' });
  check('toReadings: receivedAt stands in as reading_ts when the message carries no T',
        stamped.ok && stamped.readings[0].reading_ts === '2026-08-18T01:02:03Z');
  check('toReadings: a hand-built message without a line gets encode()\'s canonical frame',
        stamped.ok && stamped.envelope.frame === ':HS=1|I1=5|R_1-0=3|NN:');
}

// ── Verdict ──────────────────────────────────────────────────────────────────

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the spec\'s ten examples round-trip byte-for-byte, and every rejection names its reason.');
