// The Quansheng ALERT receiver codec (quansheng.js) against the firmware's own
// interface document.
//
// cdomotor-g/quansheng_alert_v3's docs/ALERT_SERIAL.md says of itself: "A
// client built from this page alone should work", and its own test parses
// every example line on the page with the reference client. This does the
// same with the browser's client — the lines below are the page's, verbatim,
// so a firmware change that breaks the page breaks this too. Section numbers
// (§n) are the page's.
//
// Plus the station table, which has no example on the page to copy: built
// from this repository's own stations.json, it has to pass every structural
// rule the firmware relies on, fit the flash region, and look every address
// up to the name and kind it was built from — through the firmware's own
// search, ported, over all 8,192 addresses.
//
// Node only. Run:  npm run quansheng   (-v to list what passed)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const Q = require(path.join(REPO_ROOT, 'quansheng.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// ── §3: four classes of line ─────────────────────────────────────────────────

for (const [line, want] of [
  ['OK', 'final'], ['OK,detail', 'final'], ['ERR,RANGE', 'final'],
  ['DEC,7,,95230,,3001,,,57,57,,EIF,NEG,0,0,-61,-119,-107,46,380,9F753812,10011111011101010011100000010010', 'record'],
  ['HDR,fw,4d06107f,schema,2', 'record'], ['EVT,,5230,BOOT,POR 12', 'record'],
  ['ALERT,2088,143,ABF,-20,MARBURG', 'record'],
  ['B ver=4d06107f rst=sw n=0 bl=12345678', 'debug'], ['K dfu ok=1', 'debug'],
  ['GET,SNR_REQ,12', 'data'], ['TIME,1790843762', 'data'], ['LOG,1045,5969,1,1045,OK', 'data'],
]) check(`§3 ${line.slice(0, 32)} → ${want}`, Q.classify(line) === want, Q.classify(line));

// ── §5: records, mapped by name ──────────────────────────────────────────────

const schema = Q.createSchema();
[
  'HDR,fw,4d06107f,schema,2',
  'HDR,DEC,seq,epoch,uptime_ms,boot,id,name,kind,value,eng,unit,fmt,pol,inv,frame,rssi,nf,sens,fade,burst_ms,payload_hex,payload_bin',
  'HDR,BST,seq,epoch,uptime_ms,peak,nf,burst_ms,nframes,nbits,bits_hex',
  'HDR,STA,epoch,uptime_ms,nf,rssi,sq,batt_mv,batt_pct,bursts,decodes,min_ok,log_state,log_count,log_cap,stn_src',
  'HDR,EVT,epoch,uptime_ms,code,detail',
].forEach(l => Q.parseRecord(schema, l));
check('§4 HDR sets the firmware hash and schema', schema.fw === '4d06107f' && schema.schema === 2);
check('§4 HDR replaces the field lists by name', schema.fromRadio.DEC && schema.fields.DEC.length === 21);

const DEC = [
  'DEC,1041,1790843886,187340,12,2088,MARBURG,BATT,143,14.3,V,ABF,STD,1,0,-20,-121,-109,89,412,16067B23,00010110000001100111101100100011',
  'DEC,1042,1790843919,220510,12,2443,KINGSHOLME MO,BATT,142,14.2,V,ABF,STD,1,0,-47,-121,-109,62,530,D2663B23,11010010011001100011101100100011',
  'DEC,1043,1790843919,220510,12,2442,KINGSHOLME MO,RAIN,23,23,tips,ABF,STD,1,1,-47,-121,-109,62,530,52667703,01010010011001100111011100000011',
  'DEC,1044,1790843962,263880,12,4109,ROTHWELL,RAIN,1290,1290,tips,ABF,STD,1,0,-88,-121,-109,21,455,B202AB17,10110010000000101010101100010111',
  'DEC,1045,1790843967,268870,12,4110,ROTHWELL,LVL,12,12,,ABF,STD,1,0,-104,-121,-109,5,390,72029B03,01110010000000101001101100000011',
  'DEC,7,,95230,,3001,,,57,57,,EIF,NEG,0,0,-61,-119,-107,46,380,9F753812,10011111011101010011100000010010',
];
const decs = DEC.map(l => Q.parseRecord(schema, l).rec);
check('§5.2 DEC fields by name', decs[0].id === 2088 && decs[0].name === 'MARBURG' && decs[0].kind === 'BATT'
  && decs[0].value === 143 && decs[0].eng === '14.3' && decs[0].unit === 'V' && decs[0].rssi === -20 && decs[0].fade === 89);
check('§5.2 an empty field is unknown, not zero', decs[5].epoch === null && decs[5].boot === null && decs[5].name === '');
check('§5.2 two frames of one burst share uptime_ms', decs[1].uptime_ms === decs[2].uptime_ms && decs[2].frame === 1);
for (const d of decs) {
  const p = Q.decodePayload32(d.payload_hex);
  check(`§5.2 payload ${d.payload_hex} re-decodes to ${d.fmt} ${d.id} = ${d.value}`,
    p && p.fmt === d.fmt && p.id === d.id && p.value === d.value, JSON.stringify(p));
  check(`…and payload_bin is the same 32 bits`, Q.payloadBits(d.payload_hex).join('') === d.payload_bin);
}
check('payload roles: 13 address bits and 11 data bits in an ABF frame',
  Q.payloadRoles('ABF').filter(r => r === 'A').length === 13 && Q.payloadRoles('ABF').filter(r => r === 'D').length === 11);
check('…and 6 CRC bits in an EIF frame', Q.payloadRoles('EIF').filter(r => r === 'R').length === 6);

// §5.3: "These are real bursts, and each decodes (complemented, polarity STD)
// to the DEC lines above with the same uptime_ms."
const BST = [
  ['BST,14,1790843886,187340,-20,-121,412,1,100,0000003D2FCB08EE0109001060', ['2088=143']],
  ['BST,15,1790843919,220510,-47,-121,530,2,138,0000004B599711DC6B599621FC0009C30440', ['2443=142', '2442=23']],
  ['BST,16,1790843962,263880,-88,-121,455,1,115,000000000029AFEAA8F4012901C040', ['4109=1290']],
];
for (const [line, want] of BST) {
  const b = Q.parseRecord(schema, line).rec;
  const found = Q.scanBurst(Q.burstBits(b.bits_hex, b.nbits)).filter(f => f.inv === 1 && f.pol === 'STD');
  check(`§5.3 BST ${b.seq}: ${b.nbits} bits re-decode to ${want.join(' ')}`,
    found.map(f => `${f.id}=${f.value}`).join(' ') === want.join(' '), found.map(f => `${f.id}=${f.value}`).join(' '));
  check(`…which is nframes = ${b.nframes}`, found.length === b.nframes);
}

const sta = Q.parseRecord(schema, 'STA,1790843970,270000,-121,-124,0,7890,78,16,18,-104,OK,1045,5969,BUILTIN MegaNet:95f6f8d').rec;
check('§5.4 STA', sta.nf === -121 && sta.batt_mv === 7890 && sta.batt_pct === 78 && sta.log_cap === 5969 && sta.stn_src === 'BUILTIN MegaNet:95f6f8d');
const sta2 = Q.parseRecord(schema, 'STA,,31000,-119,-122,0,7650,61,0,0,,FOREIGN,0,0,BUILTIN MegaNet:95f6f8d').rec;
check('§5.4 STA with no clock and no decode yet', sta2.epoch === null && sta2.min_ok === null && sta2.log_state === 'FOREIGN');

const evts = ['EVT,,5230,BOOT,POR 12', 'EVT,,12050,CENSUS,PA4B pa=0 ON', 'EVT,1790843760,61020,CLOCK,SET',
  'EVT,1790843790,91240,SET,SNR_REQ=14', 'EVT,,5240,LOG,FOREIGN 0/0', 'EVT,1790844100,402000,STN,SPI MegaNet:95f6f8d 2604']
  .map(l => Q.parseRecord(schema, l).rec);
check('§5.5 EVT code and detail', evts[0].code === 'BOOT' && evts[0].detail === 'POR 12' && evts[3].detail === 'SNR_REQ=14');
check('§5.5 EVT detail runs to the end of the line, commas and all',
  Q.parseRecord(schema, 'EVT,1,2,SET,A=1,B=2').rec.detail === 'A=1,B=2');
check('§4 a field the radio appends is kept, not dropped',
  Q.parseRecord(schema, 'BST,1,,5,-20,-121,412,1,100,00,EXTRA').rec._10 === 'EXTRA');

// ── §7: the console ──────────────────────────────────────────────────────────

check('§7.2 OK / ERR,<reason>', Q.parseFinal('OK').ok && !Q.parseFinal('ERR,RANGE').ok && Q.parseFinal('ERR,RANGE').reason === 'RANGE');
const d = l => Q.parseData(schema, l);
check('§7.3 GET', d('GET,CONFIRM,2 COPIES').value === '2 COPIES');
check('§7.3 INFO', d('INFO,log,OK,1040,5969').key === 'log' && d('INFO,log,OK,1040,5969').values.join() === 'OK,1040,5969');
check('§7.3 TIME, set and unset', d('TIME,1790843762').epoch === 1790843762 && d('TIME,').epoch === null);
check('§7.3 LOG STAT', (x => x.stat && x.count === 1045 && x.cap === 5969 && x.oldest === 1 && x.state === 'OK')(d('LOG,1045,5969,1,1045,OK')));
check('§7.3 LOG STAT, empty log', (x => x.stat && x.count === 0 && x.oldest === null)(d('LOG,0,5969,,,OK')));
check('§7.3 LOG DUMP carries the DEC fields',
  (x => x.record && x.record.id === 4109 && x.record.value === 1290)(d('LOG,1044,1790843962,263880,12,4109,ROTHWELL,RAIN,1290,1290,tips,ABF,STD,1,0,-88,-121,-109,21,455,B202AB17,10110010000000101010101100010111')));
check('§7.3 STN INFO', (x => x.info && x.source === 'BUILTIN MegaNet:95f6f8d' && x.count === 443 && x.state === 'BUILTIN')(d('STN,BUILTIN MegaNet:95f6f8d,443,,BUILTIN')));
check('§7.3 STN GET, known and not', d('STN,2088,MARBURG,BATT').lookup && d('STN,2088,MARBURG,BATT').name === 'MARBURG'
  && d('STN,3001,,').lookup && d('STN,3001,,').name === '');
check('§7.4 SET writes spaces as _', Q.setCommand('CONFIRM', '2 COPIES') === 'SET CONFIRM 2_COPIES');
check('§7.4 values are checked whole', Q.checkSetting('SNR_REQ', '30') && !Q.checkSetting('SNR_REQ', '14')
  && Q.checkSetting('SNR_REQ', '-3') && !Q.checkSetting('SNR_REQ', '+') && Q.checkSetting('MDM_MODE', 'FSK')
  && !Q.checkSetting('CONFIRM', '2_COPIES') && Q.checkSetting('FREQ_MHZ', '151,5'));
check('§6 timeouts: LOG DUMP 15 s idle, erases 30 s, most 3 s',
  Q.timeoutFor('LOG DUMP 2') === 15000 && Q.timeoutFor('log clear yes') === 30000 && Q.timeoutFor('TIME') === 3000);

// ── §9: the screen ───────────────────────────────────────────────────────────

{
  const rows = ['FF' + '01'.repeat(126) + 'FF'];
  for (let r = 1; r < 7; r++) rows.push('FF' + '00'.repeat(126) + 'FF');
  rows.push('FF' + '80'.repeat(126) + 'FF');
  const px = Q.decodeScreen(rows);
  const at = (x, y) => px[y * 128 + x];
  let frame = true, inside = 0;
  for (let x = 0; x < 128; x++) frame = frame && at(x, 0) && at(x, 63);
  for (let y = 0; y < 64; y++) frame = frame && at(0, y) && at(127, y);
  for (let y = 1; y < 63; y++) for (let x = 1; x < 127; x++) inside += at(x, y);
  check('§9 the page\'s example is a 1-pixel frame around a blank 128 × 64 screen', frame && inside === 0);
}

// ── §10: binary frames ───────────────────────────────────────────────────────

check('§10 0x05E1 DFU check frame', hex(Q.makeFrame(0x05E1)) === 'AB CD 04 00 F7 69 14 E6 80 88 DC BA', hex(Q.makeFrame(0x05E1)));
check('§10 0x05DD reboot frame', hex(Q.makeFrame(0x05DD)) === 'AB CD 04 00 CB 69 14 E6 5B EB DC BA', hex(Q.makeFrame(0x05DD)));
check('§10 0x05E0 "DFU!" frame', hex(Q.makeFrame(0x05E0, [0x21, 0x55, 0x46, 0x44])) === 'AB CD 08 00 F6 69 10 E6 0F C4 4B 04 F0 61 DC BA');
check('§10 0x0514 hello frame', hex(Q.makeFrame(0x0514, [0x2D, 0x1C, 0x0B, 0x6A])) === 'AB CD 08 00 02 69 10 E6 03 8D 06 2A 22 51 DC BA');
{
  const r = new Q.LineReader();
  const enc = s => Array.from(s, c => c.charCodeAt(0));
  const hello = Array.from(Q.makeFrame(0x0515, [0x31, 0x32]));
  const beacon = Array.from(Q.makeFrame(0x0518));
  const a = r.feed(new Uint8Array(enc('OK\r\nGET,LOG,ON\r').concat(hello, enc('\nSTA,1,2'))));
  const b = r.feed(new Uint8Array(enc(',3\r\n').concat(beacon)));
  check('§10 frames are cut out of the text stream whole',
    a.lines.join('|') === 'OK|GET,LOG,ON' && a.frames.length === 1 && a.frames[0].id === 0x0515);
  check('…a line split across reads is joined', b.lines.join('|') === 'STA,1,2,3');
  check('…and a bootloader beacon says the radio is in DFU', r.bootloader === true);
}

// ── §8: the station table, from this repository's stations.json ──────────────

{
  const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'stations.json'), 'utf8'));
  const t = Q.buildStationTable(doc.stations);
  check('the table passes every structural rule', t.problems.length === 0, t.problems.join('; '));
  check('…and fits the 64 KB region less the radio\'s 32 bytes', t.blob.length <= 65504, `${t.blob.length} bytes`);
  check('…with a source tag the radio can show', /^MegaNet:[0-9a-f]{7}$/.test(t.source), t.source);
  // the firmware's own search, over every address, against what was built
  const want = new Map();
  t.sites.forEach(s => s.members.forEach(([aid, kind]) => want.set(aid, { name: s.name, kind })));
  let wrong = 0, first = '';
  for (let aid = 0; aid <= 8191; aid++) {
    const got = Q.blobLookup(t.blob, aid), exp = want.get(aid);
    const same = (!got && !exp) || (got && exp && got.name === exp.name && got.kind === exp.kind);
    if (!same) { wrong++; if (!first) first = `${aid}: ${JSON.stringify(got)} vs ${JSON.stringify(exp)}`; }
  }
  check(`the firmware's lookup answers all 8,192 addresses as built (${want.size} named)`, wrong === 0, `${wrong} wrong — ${first}`);
  check('the radio\'s own examples look up the same: 2088 MARBURG BATT, 4110 ROTHWELL LVL',
    (x => x && x.name === 'MARBURG' && x.kind === 3)(Q.blobLookup(t.blob, 2088))
    && (x => x && x.name === 'ROTHWELL' && x.kind === 2)(Q.blobLookup(t.blob, 4110)));
  check('names are the firmware\'s charset, ≤ 40 characters', t.sites.every(s => /^[A-Z0-9 /.\-&']{1,40}$/.test(s.name)));
  const cmds = Q.uploadCommands(t.blob, 64);
  check('the upload is BEGIN, one W per 64 bytes, END',
    cmds[0] === `STN BEGIN ${t.blob.length} ${Q.hex8(Q.crc32(t.blob))}` && cmds.length === Math.ceil(t.blob.length / 64) + 2
    && cmds[cmds.length - 1] === 'STN END' && cmds[1].startsWith('STN W 0 41535442'));
  check('zlib CRC-32 check value', Q.hex8(Q.crc32(new TextEncoder().encode('123456789'))) === 'CBF43926');
  check('names: kind suffix and AL dropped, uppercase', Q.cleanName('Caniaview RN/Rep') === 'CANIAVIEW'
    && Q.cleanName('Walls Camp AL (Pacific Haven)') === 'WALLS CAMP PACIFIC HAVEN' && Q.cleanName('Loudoun Br AL') === 'LOUDOUN BR');
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
console.log('PASS — the codec reads every example the firmware\'s own document gives, and the station table is one the radio can search.');
