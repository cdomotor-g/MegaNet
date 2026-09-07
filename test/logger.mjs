// The base station program, held to the database it posts into.
//
// `logger/base-station-http.CR300` is the one file in this repository that no
// check can compile: CRBasic Editor is a Windows application and there is no
// parser for the language outside it. So this file holds the two things that
// can be held without one, and both of them are things a compile would not have
// caught anyway.
//
// **The identity contract.** The program and `db/migrations/0026_bateson_test_rig.sql`
// agree on four values — the station number the local sensors report under,
// the protocol key they carry, the names of the channels, and the ALERT address
// the self-test transmits as. Nothing enforces that agreement: they are a string
// in a CRBasic Const and a string in a SQL insert, and the failure when they
// drift is silent on both sides. The logger posts happily, the endpoint accepts
// happily, and the readings resolve to nobody — which looks exactly like a
// station that has not been commissioned yet, in a rig whose entire job is to
// tell you that the path works.
//
// **The ALERT2 round trip.** `TestInject` builds a synthetic frame and
// `DecodeFrame` decodes it, and the two are the same bit-packing written twice,
// forwards and backwards, in a language nothing here runs. Restating both in
// JavaScript and asserting they compose to the identity is the only oracle
// available — the same argument `hfem.mjs` makes about a format whose only
// oracle is its specification. The trap it exists to catch is specific and
// silent: an ALERT2 record carries 13 bits of address, so an address above 8191
// wraps into the value field and decodes as a different reading rather than
// failing.
//
// The frame is BINARY as of v3.0, because that is what this receiver emits —
// so the decoder under test is the decoder in use. The check builds it byte for
// byte the way `TestInject` does and walks it through the gates `TakeFrames`
// and `DecodeFrame` actually apply: the signature, the ASCII/binary
// discriminator, the length byte against `FRAME_MIN_LEN`, the `84 01 <len> 74`
// anchor, and `(elemlen - 3) % 4`.
//
// **The packed timestamp**, also new at v3.0 and the single largest saving in
// it: a queue slot holds one Long instead of a 24-character ISO string, and
// `MakeRec` rebuilds the string from it. Two conversions that must compose to
// the identity, in a program where a wrong instant is the one failure nothing
// downstream can detect or undo. Checked exhaustively over every year the
// encoding claims, and on both sides of the year it overflows.
//
// Plus the cheap structural net a compiler would give for free — balanced
// blocks, and the plain-ASCII-with-LF rule the file states about itself in its
// own header.
//
// Run:  npm run logger
//       npm run logger -- -v    also print what passed

import fs from 'node:fs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const PROG = fs.readFileSync(repo('logger', 'base-station-http.CR300'), 'latin1');
const SQL  = fs.readFileSync(repo('db', 'migrations', '0026_bateson_test_rig.sql'), 'utf8');

// ── Reading the CRBasic ──────────────────────────────────────────────────────
//
// Not a parser. Each reader below matches one declaration shape and throws
// rather than returning a default, because a reader that silently finds nothing
// turns every assertion built on it into a test that passes while testing
// nothing — `lib/migration.mjs` says the same thing about the SQL side.

function must(re, what) {
  const m = PROG.match(re);
  if (!m) throw new Error(`could not find ${what} in base-station-http.CR300`);
  return m[1];
}

const constStr  = name => must(new RegExp(`^Const\\s+${name}\\s*=\\s*"([^"]*)"`, 'm'), `Const ${name}`);
const constNum  = name => Number(must(new RegExp(`^Const\\s+${name}\\s*=\\s*(-?\\d+)`, 'm'), `Const ${name}`));
const publicNum = name => Number(must(new RegExp(`^Public\\s+${name}\\s+As\\s+Long\\s*=\\s*(-?\\d+)`, 'm'), `Public ${name}`));

// LocName(LOC_RAIN) = "rain" — the channel table, filled in BeginProg. Read in
// declaration order, which is also the order the sensor rows carry.
function tableStrings(fn) {
  const out = new Map();
  const re = new RegExp(`^\\s*${fn}\\(([A-Z_0-9]+)\\)\\s*=\\s*"([^"]*)"`, 'gm');
  let m;
  while ((m = re.exec(PROG)) !== null) out.set(m[1], m[2]);
  if (!out.size) throw new Error(`no ${fn}() assignments found`);
  return out;
}

const LOCAL_NUMBER   = constStr('LOCAL_NUMBER');
const LOCAL_PROTOCOL = constStr('LOCAL_PROTOCOL');
const TEST_ID        = publicNum('TestId');
const LOC_N          = constNum('LOC_N');
const locName        = tableStrings('LocName');
const locUnit        = tableStrings('LocUnit');

// ── Reading the migration ────────────────────────────────────────────────────

function sqlStationNumber() {
  // The upsert is a `select` list, so the station number is the fourth literal
  // after the id. Anchored on the id so a second station in this file could not
  // be picked up by accident.
  const m = SQL.match(/'bateson_test',[\s\S]{0,400}?'([0-9]{6})'/);
  if (!m) throw new Error("could not find bateson_test's station_number in 0026");
  return m[1];
}

function sqlSensors() {
  const block = SQL.match(/insert into meganet\.sensor[\s\S]*?on conflict/);
  if (!block) throw new Error('could not find the sensor insert in 0026');
  const out = [];
  const re = /\('bateson_test',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*(null|\d+)\)/g;
  let m;
  while ((m = re.exec(block[0])) !== null) {
    out.push({ sensor_id: m[1], type: m[2], ord: Number(m[3]),
               alert_id: m[4] === 'null' ? null : Number(m[4]) });
  }
  if (!out.length) throw new Error('no bateson_test sensor rows found in 0026');
  return out;
}

function sqlProtocolKey() {
  const m = SQL.match(/insert into meganet\.protocol[\s\S]*?\(\s*6,\s*'([^']+)'/);
  if (!m) throw new Error('could not find protocol code 6 in 0026');
  return m[1];
}

const sensors = sqlSensors();
const channelRows = sensors.filter(s => s.alert_id === null);
const alertRows   = sensors.filter(s => s.alert_id !== null);

// ── 1 · The identity contract ────────────────────────────────────────────────

check('the station number in the program is the one 0026 creates',
      LOCAL_NUMBER === sqlStationNumber(),
      `program ${LOCAL_NUMBER}, migration ${sqlStationNumber()}`);

check('the local protocol key in the program is the one 0026 inserts',
      LOCAL_PROTOCOL === sqlProtocolKey(),
      `program "${LOCAL_PROTOCOL}", migration "${sqlProtocolKey()}"`);

// The channel name is half of every local reading's address (`s:999998/rain`),
// so a name here that has no sensor row is a reading that resolves to the
// station and shows as a sensor nobody can name.
const progChannels = [...locName.values()].sort();
const sqlChannels  = channelRows.map(s => s.sensor_id).sort();
check('every channel the program sends has a sensor row in 0026',
      progChannels.every(c => sqlChannels.includes(c)),
      `program [${progChannels}] vs migration [${sqlChannels}]`);
check('and 0026 has no channel row the program never sends',
      sqlChannels.every(c => progChannels.includes(c)),
      `migration [${sqlChannels}] vs program [${progChannels}]`);
check(`LOC_N (${LOC_N}) is the number of channels the program actually names`,
      locName.size === LOC_N && locUnit.size === LOC_N,
      `LocName ${locName.size}, LocUnit ${locUnit.size}`);

check('the self-test address is the alert_id 0026 reserves',
      alertRows.length === 1 && alertRows[0].alert_id === TEST_ID,
      `program TestId ${TEST_ID}, migration ${alertRows.map(r => r.alert_id)}`);

// ── 2 · The units are in the database's vocabulary ───────────────────────────
//
// An unrecognised unit is a rejected row, not a silent guess (0006), and the
// list it is checked against is seeded in a migration this program never reads.

const UNIT_SQL = fs.readFileSync(repo('db', 'migrations', '0006_telemetry.sql'), 'utf8');
const unitBlock = UNIT_SQL.match(/insert into meganet\.unit \(key, label\) values([\s\S]*?)on conflict/);
if (!unitBlock) throw new Error('could not find the unit vocabulary in 0006');
const UNITS = [...unitBlock[1].matchAll(/\(\s*'([^']+)'/g)].map(m => m[1]);
check('0006\'s unit vocabulary was read, not guessed', UNITS.length > 10, `${UNITS.length} units`);
for (const [k, u] of locUnit) {
  check(`unit "${u}" (${k}) is in meganet.unit`, UNITS.includes(u));
}

// ── 3 · The packed timestamp ─────────────────────────────────────────────────
//
// StampNow packs; UnWhen unpacks. Both restated here, and asserted to compose
// to the identity over every year MIN_YEAR..MAX_YEAR. The encoding is
// positional and deliberately allows 31 days in every month — February the
// 31st is a value it can represent and a clock will never produce — so the
// sweep covers day 31 in every month rather than only the real calendar.

const MIN_YEAR = constNum('MIN_YEAR');
const MAX_YEAR = constNum('MAX_YEAR');
const LONG_MAX = 2147483647;

function packWhen(y, mo, d, h, mi, sec) {
  let v = y - MIN_YEAR;
  v = v * 12 + (mo - 1);
  v = v * 31 + (d - 1);
  v = v * 24 + h;
  v = v * 60 + mi;
  return v * 60 + sec;
}
function unWhen(v) {
  const sec = v % 60; v = Math.floor(v / 60);
  const mi = v % 60;  v = Math.floor(v / 60);
  const h = v % 24;   v = Math.floor(v / 24);
  const d = (v % 31) + 1; v = Math.floor(v / 31);
  const mo = (v % 12) + 1; v = Math.floor(v / 12);
  return [v + MIN_YEAR, mo, d, h, mi, sec];
}

let packBad = 0, packHigh = 0, packN = 0;
for (let y = MIN_YEAR; y <= MAX_YEAR; y++)
  for (let mo = 1; mo <= 12; mo++)
    for (const d of [1, 2, 15, 28, 29, 30, 31])
      for (const h of [0, 1, 12, 23])
        for (const mi of [0, 1, 30, 59])
          for (const sec of [0, 1, 30, 59]) {
            const v = packWhen(y, mo, d, h, mi, sec);
            packHigh = Math.max(packHigh, v);
            packN++;
            const back = unWhen(v);
            if (back.join() !== [y, mo, d, h, mi, sec].join()) packBad++;
          }

check(`the packed timestamp round-trips for every year ${MIN_YEAR}-${MAX_YEAR}`,
      packBad === 0, `${packBad} mismatches in ${packN} instants`);
check('and the whole range fits a signed 32-bit Long',
      packHigh <= LONG_MAX, `largest ${packHigh}, ceiling ${LONG_MAX}`);

// The boundary, asserted from both sides — this is what MAX_YEAR is FOR, and a
// MAX_YEAR set one year too generous would wrap silently.
check(`the last second of ${MAX_YEAR} still fits`,
      packWhen(MAX_YEAR, 12, 31, 23, 59, 59) <= LONG_MAX,
      String(packWhen(MAX_YEAR, 12, 31, 23, 59, 59)));
// MAX_YEAR is the last year that is WHOLLY representable, which is the only
// useful definition: 2086 *starts* inside the range and overflows part-way
// through, so a MAX_YEAR of 2086 would accept January and silently wrap in
// December. Both halves of that are asserted.
check(`and the last second of ${MAX_YEAR + 1} does not — so ${MAX_YEAR + 1} is not wholly representable`,
      packWhen(MAX_YEAR + 1, 12, 31, 23, 59, 59) > LONG_MAX,
      String(packWhen(MAX_YEAR + 1, 12, 31, 23, 59, 59)));
check(`${MAX_YEAR + 1} would wrap mid-year, which is why MAX_YEAR is the last WHOLE year`,
      packWhen(MAX_YEAR + 1, 1, 1, 0, 0, 0) <= LONG_MAX
      && packWhen(MAX_YEAR + 1, 12, 31, 23, 59, 59) > LONG_MAX);
check('StampNow refuses a year past MAX_YEAR rather than wrapping',
      /rTime\(1\) > MAX_YEAR/.test(PROG));
check('and it still refuses one before MIN_YEAR',
      /rTime\(1\) < MIN_YEAR/.test(PROG));

// The ISO string MakeRec rebuilds has to be the one StampNow would have written.
const isoFrom = (y, mo, d, h, mi, sec) =>
  `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` +
  `T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(sec).padStart(2, '0')}Z`;
const sample = [2026, 9, 7, 4, 15, 7];
check('the stamp rebuilt from the packed Long is the stamp that was packed',
      isoFrom(...unWhen(packWhen(...sample))) === isoFrom(...sample),
      isoFrom(...unWhen(packWhen(...sample))));

// ── 4 · The ALERT2 round trip, through the binary frame ──────────────────────

const ELEM_CONCENTRATION = 116;
const SIG = [65, 76, 69, 82, 84, 50];          // "ALERT2"
const FRAME_MIN_LEN = constNum('FRAME_MIN_LEN');
const FRAME_MAX = constNum('FRAME_MAX');

// TestInject, restated byte for byte.
function injectFrame(id, value, secs) {
  const b0 = id % 256;
  const b1 = Math.floor(id / 256) + Math.floor(value / 256) * 32;
  const b2 = value % 256;
  return [...SIG, 12, 0, 132, 1, 7, ELEM_CONCENTRATION,
          Math.floor(secs / 256), secs % 256, b0, b1, b2, 0];
}

// TakeFrames' framing and DecodeFrame's unpacking, restated.
function decodeFrame(buf, loggerSecs) {
  let sig = -1;
  for (let i = 0; i + 6 <= buf.length; i++)
    if (SIG.every((b, k) => buf[i + k] === b)) { sig = i; break; }
  if (sig < 0) return { why: 'no signature' };
  if (buf.length >= sig + 8 && buf[sig + 6] === 65 && buf[sig + 7] === 44)
    return { why: 'framed as ASCII, not binary' };
  const lenByte = buf[sig + 6], total = 6 + lenByte, end = sig + total - 1;
  if (lenByte < FRAME_MIN_LEN || total > FRAME_MAX) return { why: 'implausible length byte' };
  if (end >= buf.length) return { why: 'frame incomplete' };
  let elem = -1, elemLen = 0, via = 0;
  for (let fk = sig + 7; fk <= end - 4; fk++)
    if (buf[fk] === 132 && buf[fk + 1] === 1 && buf[fk + 3] === ELEM_CONCENTRATION) {
      elemLen = buf[fk + 2]; elem = fk + 3; via = 1; break;
    }
  if (elem < 0) return { why: 'no concentration element' };
  if (elemLen < 7 || elemLen > 32 || (elemLen - 3) % 4 !== 0)
    return { why: 'element length is not whole records' };
  const readings = [];
  for (let rec = elem + 3; rec < elem + elemLen; rec += 4) {
    if (buf[rec + 3] !== 0) continue;            // non-zero status: counted, not posted
    readings.push({ id: (buf[rec + 1] % 32) * 256 + buf[rec],
                    value: Math.floor(buf[rec + 1] / 32) * 256 + buf[rec + 2] });
  }
  return { readings, skew: buf[elem + 1] * 256 + buf[elem + 2] - loggerSecs, via, total, end };
}

const T_SECS = 4 * 3600 + 15 * 60 + 7;

for (const [id, value] of [[TEST_ID, 21], [TEST_ID, 0], [TEST_ID, 2047],
                           [1, 0], [8191, 2047], [6270, 21], [255, 255], [4096, 1024]]) {
  const got = decodeFrame(injectFrame(id, value, T_SECS), T_SECS);
  const ok = !got.why && got.readings.length === 1
          && got.readings[0].id === id && got.readings[0].value === value;
  check(`the self-test frame for ${id}/${value} decodes back to ${id}/${value}`,
        ok, got.why || JSON.stringify(got.readings));
}

const ref = decodeFrame(injectFrame(TEST_ID, 21, T_SECS), T_SECS);
check('it is framed as binary, which is what this receiver speaks', ref.via === 1);
check('the anchor is the 84 01 <len> 74 one, not the loose scan', ref.via === 1);
check('the frame is 18 bytes and ends where its length byte says',
      ref.total === 18 && ref.end === 17, `total ${ref.total}, end ${ref.end}`);
check('its length byte clears FRAME_MIN_LEN, so the framer does not step past it',
      injectFrame(TEST_ID, 21, T_SECS)[6] >= FRAME_MIN_LEN);
check("it carries this logger's own time, so RxFrameSkew reads 0 on a good clock",
      ref.skew === 0);
check('the program builds exactly the eighteen bytes this check decodes',
      /tstFrame\(18\) = 0/.test(PROG) && /tstFrame\(7\) = 12/.test(PROG));

// The trap. 9001 is the shape of address 0021 gave the ELPRO bench unit, and it
// does not fit on the wire: it decodes as something else entirely rather than
// failing, which is why the program's guard is 8191 and not 65535.
const wrapped = decodeFrame(injectFrame(9001, 21, T_SECS), T_SECS).readings[0];
check("an address above 8191 would wrap silently — which is what the program's guard prevents",
      wrapped.id !== 9001, `9001 would decode as ${wrapped.id}/${wrapped.value}`);
check('TestId is inside the 13 bits the wire carries',
      TEST_ID >= 1 && TEST_ID <= 8191, `TestId ${TEST_ID}`);
check('and the program refuses anything outside them',
      /If TestId < 1 OR TestId > 8191 Then/.test(PROG));

// The self-test address must not be one a real station answers to, or a
// commissioning shot writes a reading against somebody's gauge.
const stations = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8'));
const registryIds = new Set();
for (const s of stations.stations) {
  for (const v of Object.values(s.alert_ids || {})) {
    for (const x of (Array.isArray(v) ? v : [v])) if (x != null) registryIds.add(Number(x));
  }
  for (const sen of (s.sensors || [])) if (sen.alert_id != null) registryIds.add(Number(sen.alert_id));
}
check('the self-test address is not carried by any station in the registry',
      !registryIds.has(TEST_ID), `${registryIds.size} addresses in stations.json`);

// ── 5 · Both JSON shapes are JSON ────────────────────────────────────────────
//
// The fragments are assembled in BeginProg out of CHR(34)s and concatenated in
// MakeRec, which is a wall of quotes that no compiler checks the meaning of. The
// two records below are that assembly restated; the assertion is that what comes
// out is a document the endpoint can read, not that the pieces are present.

const DQ = '"';
const F = {
  id:    '{' + DQ + 'alert_id' + DQ + ':',
  ts:    ',' + DQ + 'reading_ts' + DQ + ':' + DQ,
  val:   DQ + ',' + DQ + 'value_raw' + DQ + ':',
  sus:   ',' + DQ + 'quality' + DQ + ':' + DQ + 'suspect' + DQ,
  sn:    '{' + DQ + 'station_number' + DQ + ':' + DQ,
  ch:    DQ + ',' + DQ + 'channel' + DQ + ':' + DQ,
  eng:   ',' + DQ + 'value' + DQ + ':',
  unit:  ',' + DQ + 'unit' + DQ + ':' + DQ,
  conv:  ',' + DQ + 'conversion' + DQ + ':' + DQ,
  proto: ',' + DQ + 'protocol' + DQ + ':' + DQ + LOCAL_PROTOCOL + DQ,
};
const STAMP = '2026-09-07T04:15:00Z';

const radioRec = F.id + '6270' + F.ts + STAMP + F.val + '21' + F.sus + '}';
const localRec = F.sn + LOCAL_NUMBER + F.ch + 'rain' + DQ + F.ts + STAMP
               + F.val + '3' + F.eng + '0.600' + F.unit + 'mm' + DQ
               + F.conv + 'raw x 0.200 mm per tip' + DQ + F.proto + '}';

for (const [what, rec] of [['radio', radioRec], ['local', localRec]]) {
  let parsed = null;
  try { parsed = JSON.parse(rec); } catch (e) { /* reported below */ }
  check(`a ${what} reading renders as valid JSON`, parsed !== null, rec);
}
check('the local reading carries both the raw and the converted value',
      JSON.parse(localRec).value_raw === 3 && JSON.parse(localRec).value === 0.6);
check('the local reading names its own protocol rather than the envelope\'s',
      JSON.parse(localRec).protocol === LOCAL_PROTOCOL);
check('the local reading addresses by number and channel, never by alert_id',
      !('alert_id' in JSON.parse(localRec)));

// The whole body, as BuildBatch wraps it for ingest_http().
const body = '{' + DQ + 'payload' + DQ + ':{' + DQ + 'path' + DQ + ':' + DQ + '18 Bateson' + DQ + ','
           + DQ + 'protocol' + DQ + ':' + DQ + 'alert2' + DQ + ',' + DQ + 'readings' + DQ + ':['
           + radioRec + ',' + localRec + ']}}';
let bodyOk = false;
try { bodyOk = JSON.parse(body).payload.readings.length === 2; } catch (e) { /* reported below */ }
check('a mixed batch of both shapes is one valid payload', bodyOk, body);
check("a local reading fits inside the program's jRec buffer",
      localRec.length <= 200, `${localRec.length} characters, buffer is 200`);
check('and inside CONTENT_GUARD, so one always fits in a batch',
      localRec.length < constNum('CONTENT_GUARD'));

// The memory budget is the reason v3.0 exists, so it is asserted rather than
// remembered. A declaration added back carelessly is exactly how a program that
// now fits stops fitting, and the logger reports that as "out of memory" with
// no line number.
const SIZES = { Q_SIZE: 'Q_SIZE', BUF_MAX: 'BUF_MAX', CONTENT_SIZE: 'CONTENT_SIZE',
                FIELD_MAX: 'FIELD_MAX', RX_MAX: 'RX_MAX', LOC_N: 'LOC_N' };
const dimConst = {};
for (const k of Object.values(SIZES)) dimConst[k] = constNum(k);
let varBytes = 0;
for (const m of PROG.matchAll(
  /^(?:Public|Dim)\s+(\w+)\s*(?:\(\s*(\w+)\s*\))?\s*(?:As\s+(?:String\s*\*\s*(\w+)|Long|Boolean|Float))?/gm)) {
  const [, , arr, slen] = m;
  const n = arr ? (dimConst[arr] ?? (Number(arr) || 1)) : 1;
  const sl = slen ? (dimConst[slen] ?? Number(slen)) : null;
  varBytes += n * (sl ? sl + 1 : 4);
}
check('the declared variable memory stays inside the v3.0 budget',
      varBytes <= 15000, `${varBytes} bytes declared (v2.1 was ~35,200 and would not load)`);

// The ring buffer is three columns now and every one that went was derivable.
// A fourth reappearing is the change that would quietly undo the diet.
const qCols = [...PROG.matchAll(/^Dim (q\w+)\(Q_SIZE\)/gm)].map(m => m[1]);
check('the ring buffer is still three columns wide',
      qCols.length === 3, qCols.join(', '));
check('and none of them is a per-slot string',
      !/^Dim q\w+\(Q_SIZE\) As String/m.test(PROG));

// The forensics that came out at v3.0 must stay out — each was a table or a
// buffer measured in kilobytes, and each answered a question about the feed
// that this network has answered.
// Matched against DECLARATIONS, not against the word: the version note at the
// top of the program names every one of these in prose, deliberately, so that
// what was removed is recorded rather than merely absent.
for (const t of ['RawLog', 'FrameLog', 'ReadingLog', 'LineLog', 'LocalLog'])
  check(`the ${t} table is still gone`, !new RegExp(`^DataTable \\(${t},`, 'm').test(PROG));
for (const v of ['charTally', 'capBuf', 'capLine', 'dumpHexFull', 'RxWhyCount', 'RxByteClass'])
  check(`${v} is still gone`, !new RegExp(`^(Public|Dim)\\s+${v}\\b`, 'm').test(PROG));

// ── 6 · The structural net ───────────────────────────────────────────────────
//
// What a compiler would give for free, for a file no CI can compile. Comments
// and string literals are stripped first, because this file is two thirds prose
// and half of that prose is about the code it sits beside.

const stripped = PROG.split('\n').map(line => {
  let out = '', inStr = false;
  for (const c of line) {
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (c === "'" && !inStr) break;
    out += c;
  }
  return out;
});
const code = stripped.join('\n');
const count = re => (code.match(re) || []).length;

for (const [name, open, close] of [
  ['Sub / EndSub',                 /^\s*Sub\s/gmi,            /^\s*EndSub\s*$/gmi],
  ['BeginProg / EndProg',          /^\s*BeginProg\s*$/gmi,    /^\s*EndProg\s*$/gmi],
  ['Scan / NextScan',              /^\s*Scan\s*\(/gmi,        /^\s*NextScan\s*$/gmi],
  ['SlowSequence / EndSequence',   /^\s*SlowSequence\s*$/gmi, /^\s*EndSequence\s*$/gmi],
  ['DataTable / EndTable',         /^\s*DataTable\s*\(/gmi,   /^\s*EndTable\s*$/gmi],
  ['For / Next',                   /^\s*For\s+\w+\s*=/gmi,    /^\s*Next\s+\w+\s*$/gmi],
  ['Do / Loop',                    /^\s*Do\b/gmi,             /^\s*Loop\b/gmi],
]) {
  const a = count(open), b = count(close);
  check(`${name} balance`, a === b && a > 0, `${a} open, ${b} close`);
}

// A single-line `If x Then y` has no EndIf; only a block If opens one.
const blockIfs = stripped.filter(l => /^\s*If\b.*\bThen\s*$/i.test(l)).length;
check('If / EndIf balance', blockIfs === count(/^\s*EndIf\s*$/gmi),
      `${blockIfs} block If, ${count(/^\s*EndIf\s*$/gmi)} EndIf`);

// Every subroutine the program calls has to exist, and every one it declares
// has to be reachable — a Call naming a Sub that was renamed is the one class
// of typo this net can catch that balance cannot.
const declared = new Set([...PROG.matchAll(/^Sub\s+(\w+)\s*\(/gmi)].map(m => m[1].toLowerCase()));
const called   = new Set([...code.matchAll(/\bCall\s+(\w+)\s*\(/gi)].map(m => m[1].toLowerCase()));
const missing  = [...called].filter(n => !declared.has(n));
const orphaned = [...declared].filter(n => !called.has(n));
check('every Call names a Sub that exists', missing.length === 0, missing.join(', '));
check('every Sub is called from somewhere', orphaned.length === 0, orphaned.join(', '));

// The file says of itself that it is "deliberately plain ASCII throughout, so it
// reads the same in CRBasic Editor as it does on GitHub". Holding it to that is
// one line, and an em-dash pasted in from a comment is invisible until a Windows
// editor renders it as something else.
const nonAscii = [...PROG].filter(c => c.charCodeAt(0) > 126);
check('the program is plain ASCII, as its own header claims',
      nonAscii.length === 0, nonAscii.slice(0, 8).join(' '));
check('and has no CR, so a diff shows the line that changed',
      !PROG.includes('\r'));

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
console.log('PASS — the logger and 0026 name the same rig, and the self-test frame decodes to itself.');
