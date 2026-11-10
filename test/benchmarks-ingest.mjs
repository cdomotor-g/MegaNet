// The reader of the Bureau's benchmark details (tools/ingest/benchmarks.py),
// held to the report's layout on an invented page.
//
// The report itself — *Queensland Flood Warning River Height Stations —
// Benchmark Details*, printed from HDB — is in the private repository, because
// what a benchmark is and where it is are editors' (0101), so nothing in this
// repository could say whether the reader still reads it. This writes two
// pages in the same fixed-width layout, with made-up stations and marks, and
// reads them with the real tool:
//
//   * the basin carried down the rows under it, and printed again on the
//     first whole row of a page;
//   * station numbers kept with their leading zeros;
//   * several benchmarks under one station, in the order printed;
//   * a station name, a description and a comment each wrapped onto the lines
//     underneath — joined with one space — and a row that carries on over a
//     page break and its whole page head;
//   * a negative level, a level kept as printed (104.20 stays 104.20), all
//     four datums, a row with no description, and one with no comment;
//   * the one byte the export wrote for a dash, read as one;
//   * a person's name in brackets after "contractor" left out, and a council's
//     kept (CLAUDE.md, "Private data");
//   * and what it refuses rather than reads: a datum it does not know, text in
//     the gap between two columns, a page out of order, a station's rows split
//     by another station, a level that is not a number.
//
// Every name, number and mark here is invented. Node, with python3 (which CI's
// runner has); without python3 it says so and fails, since it then checks
// nothing.
//
// Run:  npm run benchmarksingest   (-v to list what passed)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const TOOL = repo('tools/ingest/benchmarks.py');

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  if (!ok) console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${label}`);
}

// ── The layout ───────────────────────────────────────────────────────────────
// The column rule is the layout: seven runs of dashes, one space apart.
const WIDTHS = [25, 7, 20, 9, 10, 45, 35];
const RULE = WIDTHS.map(w => '-'.repeat(w)).join(' ');
const WIDE = RULE.length + 3;
const centre = t => (' '.repeat(Math.floor((WIDE - t.length) / 2)) + t).padEnd(WIDE);

function head(page, date = '15/10/2026') {
  return [
    '',
    `Date: ${date}`.padEnd(75) + 'Benchmarks'.padEnd(75) + `Page: ${String(page).padStart(4)}`,
    ''.padEnd(WIDE),
    centre('QUEENSLAND FLOOD WARNING RIVER HEIGHT STATIONS'),
    centre('BENCHMARK DETAILS'),
    ''.padEnd(WIDE),
    '                          Station                      Benchmark'.padEnd(WIDE),
    'Basin                        No   Station Name             (m)   Datum      Description                                   Comments'.padEnd(WIDE),
    RULE + '   ',
  ];
}
// One printed line: each field in its column, the number and the level to the
// right of theirs as HDB prints them.
function line(basin = '', number = '', name = '', level = '', datum = '', description = '', comment = '') {
  const f = [basin, number, name, level, datum, description, comment];
  f.forEach((v, i) => { if (v.length > WIDTHS[i]) throw new Error(`fixture: "${v}" is wider than its column`); });
  return [f[0].padEnd(25), f[1].padStart(7), f[2].padEnd(20), f[3].padStart(9), f[4].padEnd(10),
          f[5].padEnd(45), f[6].padEnd(35)].join(' ') + '   ';
}
const gap = [''.padEnd(WIDE), ''.padEnd(WIDE)];

function pages() {
  return [
    ...head(1),
    line('MADE-UP COAST', '599001', 'INVENTED CREEK ALERT', '4.43', 'AHD', 'TBM on slab of the invented tower.', 'Sensor is at gauge height -1.23m'),
    line('', '', '', '', '', '', 'AHD.'),
    ...gap,
    // Leading zeros, a wrapped name, two benchmarks, a level kept as printed.
    line('', '099002', 'PRETEND WATERS', '104.20', 'AHD', 'PSM 990001', 'Survey 15/09/2006'),
    line('', '', 'ALERT'),
    ...gap,
    line('', '099002', 'PRETEND WATERS', '2.62', 'STATE', 'Brass plug in the invented kerb, 18m and', 'AHD = SD - 0.065m.'),
    line('', '', 'ALERT', '', '', '294deg from the 7-8m gauge'),
    ...gap,
    // A new basin, a negative level, no comment.
    line('IMAGINARY RIVER', '599003', 'NOWHERE BRIDGE', '-0.48', 'ASSUM', 'Top of the invented orifice pipe'),
    ...gap,
    // No description; a stray byte for a dash in the comment (put in below).
    line('', '599004', 'NOWHERE WEIR', '12.00', 'UNKNOWN', '', 'Origin of level ¿ made-up mark'),
    ...gap,
    // Carries on over the page break: the description's and comment's last
    // lines are under the next page's head.
    line('', '599005', 'FAR PADDOCK TM', '311.07', 'AHD', 'Star picket in a made-up concrete block,', 'Re-Install by council contractor'),
    ...head(2),
    line('', '', '', '', '', 'approx 5 metres west of the gauge.', '(Made Up) - 16/02/2023'),
    ...gap,
    // The basin again, on the first whole row of the page.
    line('IMAGINARY RIVER', '599006', 'LAST GAUGE', '7.67', 'AHD', 'Hilti pin in concrete', 'Installed (Made-up Shire council)'),
    ...gap,
  ];
}

// The file as HDB's export writes it: ASCII, with the one byte 0xBF for a dash.
function bytes(lines) {
  return Buffer.from(lines.join('\n') + '\n', 'latin1');
}

// ── Running the tool ─────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floodnet-benchmarks-'));
let n = 0;
function run(lines) {
  const source = path.join(dir, `report-${++n}.txt`);
  const out = path.join(dir, `out-${n}.json`);
  fs.writeFileSync(source, bytes(lines));
  const r = spawnSync('python3', [TOOL, '--source', source, '--out', out], { encoding: 'utf8', timeout: 60000 });
  let doc = null;
  if (r.status === 0 && fs.existsSync(out)) {
    const text = fs.readFileSync(out, 'utf8');
    // The levels as printed: read once as numbers, and once as their literals.
    doc = JSON.parse(text);
    doc.literals = [...text.matchAll(/^\[(-?\d+\.\d+),/gm)].map(m => m[1]);
  }
  return { status: r.status, err: (r.stderr || '').trim(), doc, error: r.error };
}
const refuses = (label, lines, re) => {
  const r = run(lines);
  check(label, r.status === 2 && re.test(r.err), `exit ${r.status}: ${r.err.slice(0, 200)}`);
};

console.log('\nThe benchmark details reader, on an invented page\n');

const py = spawnSync('python3', ['--version'], { stdio: 'ignore' });
if (py.status !== 0) {
  check('python3 is here to run tools/ingest/benchmarks.py', false, 'no python3 on this machine');
} else {
  const good = run(pages());
  check('the invented report reads', good.status === 0 && !!good.doc, good.err || String(good.error || ''));
  const doc = good.doc || { meta: {}, stations: [], literals: [] };
  const none = { benchmarks: [[], [], []] };
  const st = num => doc.stations.find(s => s.bureau_number === num) || none;

  check('two pages, six stations, seven benchmarks, printed 15/10/2026',
    doc.meta.source && doc.meta.source.pages === 2 && doc.meta.stations === 6 && doc.meta.benchmarks === 7
    && doc.meta.printed === '2026-10-15', JSON.stringify(doc.meta).slice(0, 300));
  check('the stations come out in the order printed',
    doc.stations.map(s => s.bureau_number).join() === '599001,099002,599003,599004,599005,599006');
  check('a station number keeps its leading zero', st('099002').bureau_number === '099002');
  check('the basin is carried down the rows under it, and changes where a new one is printed',
    st('599001').basin === 'MADE-UP COAST' && st('099002').basin === 'MADE-UP COAST'
    && st('599003').basin === 'IMAGINARY RIVER' && st('599004').basin === 'IMAGINARY RIVER',
    doc.stations.map(s => s.basin).join(' | '));
  check('…and the basin printed again at the top of a page starts nothing new',
    st('599005').basin === 'IMAGINARY RIVER' && st('599006').basin === 'IMAGINARY RIVER');
  check('a wrapped station name is joined with a space', st('099002').name === 'PRETEND WATERS ALERT', st('099002').name);
  check('a station has every one of its benchmarks, in the order printed',
    st('099002').benchmarks.length === 2 && st('099002').benchmarks[0][1] === 'AHD' && st('099002').benchmarks[1][1] === 'STATE');
  check('a wrapped comment belongs to its own row, joined with a space',
    st('599001').benchmarks[0][3] === 'Sensor is at gauge height -1.23m AHD.', JSON.stringify(st('599001').benchmarks[0]));
  check('a wrapped description belongs to its own row — not the row above or the station below',
    st('099002').benchmarks[1][2] === 'Brass plug in the invented kerb, 18m and 294deg from the 7-8m gauge'
    && st('099002').benchmarks[0][2] === 'PSM 990001' && st('599003').benchmarks[0][2] === 'Top of the invented orifice pipe',
    JSON.stringify(st('099002').benchmarks));
  check('levels are kept as printed: 104.20 stays 104.20, and a negative level stays negative',
    doc.literals.includes('104.20') && doc.literals.includes('-0.48') && st('599003').benchmarks[0][0] === -0.48,
    doc.literals.join(' '));
  check('all four datums are read', ['AHD', 'STATE', 'ASSUM', 'UNKNOWN'].every(d => doc.meta.by_datum && doc.meta.by_datum[d] >= 1),
    JSON.stringify(doc.meta.by_datum));
  check('a row with no description has none, and a row with no comment has none',
    st('599004').benchmarks[0][2] === null && st('599003').benchmarks[0][3] === null);
  check('the one stray byte is read as a dash, and counted',
    st('599004').benchmarks[0][3] === 'Origin of level – made-up mark' && (doc.meta.stray_bytes || []).length === 1,
    JSON.stringify(st('599004').benchmarks[0]));
  check('a row carries on over a page break and its page head',
    st('599005').benchmarks[0][2] === 'Star picket in a made-up concrete block, approx 5 metres west of the gauge.',
    JSON.stringify(st('599005').benchmarks[0]));
  check('a person\'s name in brackets after "contractor" is left out, the rest of the comment kept',
    st('599005').benchmarks[0][3] === 'Re-Install by council contractor - 16/02/2023'
    && JSON.stringify(doc.meta.redacted) === JSON.stringify([{ bureau_number: '599005', column: 'comment' }]),
    JSON.stringify([st('599005').benchmarks[0][3], doc.meta.redacted]));
  check('…and a council in brackets is not a person: it stays',
    st('599006').benchmarks[0][3] === 'Installed (Made-up Shire council)', JSON.stringify(st('599006').benchmarks[0]));
  check('the document names its columns, which the database\'s loader checks before it reads a row',
    JSON.stringify(doc.meta.benchmark_columns) === JSON.stringify(['level_m', 'datum', 'description', 'comment']));

  // ── What it refuses ────────────────────────────────────────────────────────
  const swap = (from, to) => pages().map(l => (l.includes(from) ? to : l));
  refuses('a datum it does not know is refused, not stored',
    swap('NOWHERE BRIDGE', line('IMAGINARY RIVER', '599003', 'NOWHERE BRIDGE', '-0.48', 'GDA2020', 'x')), /not one of AHD, ASSUM, STATE, UNKNOWN/);
  refuses('a level that is not a number is refused',
    swap('NOWHERE BRIDGE', line('IMAGINARY RIVER', '599003', 'NOWHERE BRIDGE', '0.4m', 'ASSUM', 'x')), /is not a level/);
  refuses('text in the gap between two columns is refused rather than cut in half',
    swap('NOWHERE BRIDGE', line('IMAGINARY RIVER', '599003', 'NOWHERE BRIDGE', '-0.48', 'ASSUM', 'x').replace(/x {44} /, 'x'.repeat(46))),
    /text in the gap after the description column/);
  refuses('a page out of order is refused',
    pages().map(l => (/Page: +2/.test(l) ? l.replace(/Page: +2/, 'Page:    3') : l)), /page 3 follows page 1/);
  refuses('pages dated on different days are refused',
    pages().map(l => (/Page: +2/.test(l) ? l.replace('15/10/2026', '16/10/2026') : l)), /not one day/);
  refuses('a station whose rows are split by another station is refused',
    [...pages(), line('', '599001', 'INVENTED CREEK ALERT', '5.00', 'AHD', 'x'), ...gap], /station 599001 again, after another station/);
  refuses('a carried-on line with a level in it and no station number is refused',
    swap('294deg', line('', '', 'ALERT', '9.99', '', '294deg from the 7-8m gauge')), /no station number/);
}

fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? ` — ${failed.length} failed` : ''}\n`);
process.exit(failed.length ? 1 : 0);
