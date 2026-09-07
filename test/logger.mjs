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
// `ParseAlert2` decodes it, and the two are the same bit-packing written twice,
// forwards and backwards, in a language nothing here runs. Restating both in
// JavaScript and asserting they compose to the identity is the only oracle
// available — the same argument `hfem.mjs` makes about a format whose only
// oracle is its specification. The trap it exists to catch is specific and
// silent: an ALERT2 record carries 13 bits of address, so an address above 8191
// wraps into the value field and decodes as a different reading rather than
// failing.
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

// ── 3 · The ALERT2 round trip ────────────────────────────────────────────────
//
// TestInject's packing and ParseAlert2's unpacking, both restated. The frame is
// built field for field the way the program builds it, so the assertions below
// exercise the gates ParseAlert2 applies as well as the arithmetic: field 18
// frame-valid, field 23 payload length against the trailing hex, the 0x74
// element type, and (length - 3) divisible by 4.

const N_FIELDS = 24;
const ELEM_CONCENTRATION = 116;   // 0x74

function injectLine(id, value, t) {
  const secs = t.hour * 3600 + t.minute * 60 + t.second;
  const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');
  const b0 = id % 256;
  const b1 = Math.floor(id / 256) + Math.floor(value / 256) * 32;
  const b2 = value % 256;
  return 'ALERT2A,1,9999,MEGANET,N,1,'
       + `${t.year},${t.month},${t.day},${t.hour},${t.minute},${String(t.second).padStart(2, '0')}.000`
       + ',0,0,0,0,0,1,0,0,0,7,7,9999'
       + `,74,${hex2(Math.floor(secs / 256))},${hex2(secs % 256)},${hex2(b0)},${hex2(b1)},${hex2(b2)},00`;
}

function parseAlert2(line) {
  const f = line.split(',');
  if (f.length < N_FIELDS + 4)              return { why: 'short line' };
  if (Number(f[17]) !== 1)                  return { why: 'frame flagged invalid' };
  const nPay = f.length - N_FIELDS;
  if (Number(f[22]) !== nPay)               return { why: 'payload len vs hex' };
  if (nPay < 7 || nPay > 32)                return { why: 'payload size' };
  if ((nPay - 3) % 4 !== 0)                 return { why: 'not whole records' };
  const pay = f.slice(N_FIELDS).map(h => parseInt(h, 16));
  if (pay.some(b => !(b >= 0 && b <= 255))) return { why: 'payload not hex' };
  if (pay[0] !== ELEM_CONCENTRATION)        return { why: 'not concentration elem' };
  const readings = [];
  for (let i = 3; i < nPay; i += 4) {
    if (pay[i + 3] !== 0) continue;         // non-zero status: counted, not posted
    readings.push({ id: (pay[i + 1] % 32) * 256 + pay[i],
                    value: Math.floor(pay[i + 1] / 32) * 256 + pay[i + 2] });
  }
  return { readings, frameSecs: pay[1] * 256 + pay[2] };
}

const T = { year: 2026, month: 9, day: 7, hour: 4, minute: 15, second: 7 };
const T_SECS = T.hour * 3600 + T.minute * 60 + T.second;

for (const [id, value] of [[TEST_ID, 21], [TEST_ID, 0], [TEST_ID, 2047],
                           [1, 0], [8191, 2047], [6270, 21], [255, 255], [4096, 1024]]) {
  const got = parseAlert2(injectLine(id, value, T));
  const ok = !got.why && got.readings.length === 1
          && got.readings[0].id === id && got.readings[0].value === value;
  check(`the self-test frame for ${id}/${value} decodes back to ${id}/${value}`,
        ok, got.why || JSON.stringify(got.readings));
}

check('the frame carries this logger\'s own time, so RxFrameSkew reads 0 on a good clock',
      parseAlert2(injectLine(TEST_ID, 21, T)).frameSecs === T_SECS);

// The trap. 9001 is the shape of address 0021 gave the ELPRO bench unit, and it
// does not fit on the wire: it decodes as something else entirely rather than
// failing, which is why the program's guard is 8191 and not 65535.
const wrapped = parseAlert2(injectLine(9001, 21, T)).readings[0];
check('an address above 8191 would wrap silently — which is what the program\'s guard prevents',
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

// ── 4 · Both JSON shapes are JSON ────────────────────────────────────────────
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
check('a local reading fits inside the program\'s LocalJson buffer',
      localRec.length <= 200, `${localRec.length} characters, buffer is 200`);

// ── 5 · The structural net ───────────────────────────────────────────────────
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
