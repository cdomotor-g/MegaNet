// Level surveys (levelling.js, xlsx-write.js, level-store.js, level-camera.js,
// level-survey.js, two-peg.js, survey-guide.js) — 📏 🎯 📖 under Surveying.
//
// Most of what these tabs are for is out of `smoke`'s sight: the sums, which
// are the record; a survey kept on the phone through a reload; the files it
// exports; a number read off a level's display; what goes to the database and
// in what order; and the administrator's panel. So:
//
//   1. The arithmetic, under Node — the file this check require()s is the one
//      the phone runs. The worked example booked and reduced (every RL, the
//      three checks agreeing, the misclose), the gauge boards against their
//      face values, the water check, the datums (assumed with a nominated
//      board, gauge-datum with an AHD column), every booking mistake said on
//      the row it was made on, the two-peg test, what a survey would change
//      at its station, the CSV (a spreadsheet's formula guard) and the
//      workbook's sheets; and the readers of a display and a plate.
//   2. The workbook writer: its parts, a SUM with its answer in it, Excel's
//      rules for a sheet's name.
//   3. The tabs in Chromium, as a phone (375 px, touch): the list, the worked
//      example on its run, every step, a survey started from a station search
//      and booked through the sheet's own boxes, kept through a reload; the
//      Excel, CSV and package downloads read back; the reading camera — the
//      fake camera started, then a picture of a display read by the real OCR
//      engine into a row, its picture kept small; sending, with the database's
//      doors stood in for (the order, the paths, what is not sent, the
//      database not ready yet, no signal); an administrator's panel and what
//      it applies; the two-peg test passing and failing; the guide opened at
//      a section by the sheet's own link. Nothing wider than the phone, and
//      nothing thrown.
//
// What is *not* here: 0060's rules — who may file, apply, or change gauge
// zero — which tools/check_level_surveys.sql holds against a real Postgres.
//
// Run:  npm run levels
//       npm run levels -- -v    also print what passed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { openWorkbook } from './lib/xlsx.mjs';

const require = createRequire(import.meta.url);
const L = require('../levelling.js');
const X = require('../xlsx-write.js');
const C = require('../level-camera.js');

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const OCR_TIMEOUT = Number(process.env.OCR_TIMEOUT || 180_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail && (!pass || VERBOSE) ? ` — ${detail}` : ''}`);
}
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);
const near = (a, b, tol = 1e-9) => a != null && b != null && Math.abs(a - b) <= tol;

// ═══ 1. The arithmetic ═══════════════════════════════════════════════════════

section('The worked example, booked and reduced');
{
  const { survey, test } = L.practice();
  const red = L.reduce(survey);
  check('the sums: ΣBS 5.674, ΣFS 5.673, ΣRise 4.237, ΣFall 4.236',
    near(red.sums.bs, 5.674) && near(red.sums.fs, 5.673) && near(red.sums.rise, 4.237) && near(red.sums.fall, 4.236), J(red.sums));
  check('the three checks agree, exactly — whole hundredths of a millimetre, not binary fractions',
    red.checks.agree && red.checks.bsfs === 0.001 && red.checks.risefall === 0.001 && red.checks.lastfirst === 0.001, J(red.checks));
  check('closed on the opening benchmark, misclose +0.001 m, within ±0.003', red.closed && red.closesOnBm && red.misclose === 0.001 && red.within);
  check('two change points, three set-ups', red.cps === 2 && red.setups.length === 3);
  check('each level: RL in AHD and on the gauge through gauge zero 26.800',
    red.rows.map(o => L.fmt(o.rl)).join(' ') === '31.250 30.796 29.801 29.642 28.799 27.804 27.435 27.087 27.014 29.311 31.251'
    && red.rows.map(o => L.fmt(o.lgh)).join(' ') === '4.450 3.996 3.001 2.842 1.999 1.004 0.635 0.287 0.214 2.511 4.451',
    red.rows.map(o => `${L.fmt(o.rl)}/${L.fmt(o.lgh)}`).join(' '));
  check('rise and fall are on the right rows: row 4 falls 0.159, row 10 rises 2.297',
    red.rows[3].fall === 0.159 && red.rows[3].rise == null && red.rows[9].rise === 2.297 && red.rows[9].fall == null);
  check('roles: opening, change points, closing', red.rows[0].role === 'open' && red.rows[3].role === 'cp' && red.rows[9].role === 'cp' && red.rows[10].role === 'close');
  check('the boards against their face values: −4, +1, −1, +4 mm, none to adjust',
    J(red.boards.map(b => [b.error, b.adjust])) === J([[-0.004, false], [0.001, false], [-0.001, false], [0.004, false]]), J(red.boards));
  check('nothing wrong with it', red.problems.length === 0, J(red.problems));
  const wc = L.waterCheck(survey, red);
  check('the water check: surveyed 0.635 at 09:42, board +5 mm, logger −4 mm, three minutes apart',
    wc.surveyed === 0.635 && wc.boardLessSurveyed === 0.005 && wc.loggerLessSurveyed === -0.004 && wc.spread === 3 && wc.done, J(wc));
  const t = L.twoPeg(test);
  check('its two-peg test: −0.133 and −0.134, error 0.001, pass; B should read 1.686 from set-up 2',
    t.d1 === -0.133 && t.d2 === -0.134 && t.error === 0.001 && t.pass && L.fmt(t.bShould) === '1.686', J(t));
  const items = L.review(survey, red, test);
  const missing = items.filter(i => !i.ok).map(i => i.key);
  check('the final field check: only the photos still to take', J(missing) === J(['photos']), J(items.map(i => [i.key, i.ok])));
  check('…and it says which', /site overview/.test(items.find(i => i.key === 'photos').detail));
  const ch = L.stationChanges(survey, red, { gauge_survey: [{ valid_from: '2014-06-04', gauge_zero_m: 26.8, datum: 'AHD' }] });
  check('what it would change at its station: gauge zero (the same, unticked), the benchmark, four boards, the CTR, the CTF, the offset',
    J(ch.map(c => c.key)) === J(['gauge_zero', 'bm:BM999001_1', 'board:3–4 m board', 'board:2–3 m board', 'board:1–2 m board', 'board:0–1 m board', 'ctr:CTR', 'ctf:CTF', 'offset'])
    && ch[0].same && !ch[0].on && ch[1].on && !ch[ch.length - 1].on, J(ch.map(c => [c.key, c.on, c.same])));
  check('…the offset correction is what the logger was out by, turned round: +0.004 m',
    ch[ch.length - 1].value.correction_m === 0.004);
}

section('Booking mistakes, said on the row they were made on');
{
  const R = (k, n, x) => L.blankRow(k, Object.assign({ name: n }, x));
  const e = L.blankSurvey({ datum: 'AHD' });
  e.bm.rl = 10;
  e.rows = [R('bm', 'BM', { bs: 1 }), R('other', 'x', { is: 1.2, fs: 1.3 }), R('other', 'y', { bs: 1.1 }), R('cp', 'CP', { fs: 1.5 }), R('other', 'z', { is: 1 })];
  const red = L.reduce(e);
  const at = red.problems.map(p => `${p.code}@${e.rows.findIndex(r => r.id === p.row)}`);
  check('an intermediate and a foresight on one row — that row, and only that row', at.includes('is-and-fs@1') && !at.includes('after-close@2'), J(at));
  check('a backsight with no foresight', at.includes('bs-alone@2'), J(at));
  check('a row after the run closed', at.includes('after-close@4'), J(at));
  check('not closed on the benchmark, and no change point', red.problems.some(p => p.code === 'not-on-bm') && red.problems.some(p => p.code === 'no-cp'));
  check('a reading typed with a comma, or as text, is a reading; nonsense is not, and is never zero',
    L.num('1,245') === 1.245 && L.num(' 2.5 m') === 2.5 && L.num('1.2.3') === null && L.num('') === null && L.num(0) === 0);
}

section('The datums');
{
  const R = (k, n, x) => L.blankRow(k, Object.assign({ name: n }, x));
  const s = L.blankSurvey({ datum: 'ASSUMED', station: { number: '123456' } });
  check('an assumed survey starts its benchmark at 100.000, named for the station', s.bm.rl === 100 && s.bm.name === 'BM123456_1');
  s.rows = [R('bm', 'BM123456_1', { bs: 1.5 }), R('board', 'B3', { is: 2.0, face: 3 }), R('board', 'B2', { is: 3.01, face: 2 }),
            R('cp', 'CP1', { fs: 3.2, bs: 1.1 }), R('bm', 'BM123456_1', { fs: 0.4 })];
  s.gauge_zero.from_row = s.rows[1].id;
  const red = L.reduce(s);
  check('gauge zero found from the nominated board: its top less its face value, 99.500 − 3 = 96.500',
    red.gaugeZero.rl === 96.5 && red.gaugeZero.how === 'board', J(red.gaugeZero));
  check('no AHD column on an assumed survey — it is never made up', red.rows.every(o => o.ahd === null));
  check('the other board is held to the nominated one, and its disagreement said — not averaged',
    red.boards[1].error === -0.01 && !red.boards[1].adjust && red.problems.some(p => p.code === 'board' && /does not agree/.test(p.text)), J(red.boards));
  const g = L.blankSurvey({ datum: 'LGH' });
  g.bm.rl = 4.5; g.gauge_zero.rl = 20;
  g.rows = [R('bm', 'BM', { bs: 1.2 }), R('cp', 'CP1', { fs: 1.0, bs: 1.4 }), R('bm', 'BM', { fs: 1.6 })];
  const rg = L.reduce(g);
  check('a gauge-datum survey: levels on the gauge, and in AHD where gauge zero\'s AHD level is given',
    rg.rows[1].lgh === 4.7 && rg.rows[1].ahd === 24.7 && rg.misclose === 0 && rg.within, J(rg.rows.map(o => [o.lgh, o.ahd])));
}

section('The CSV and the workbook');
{
  const { survey, test } = L.practice();
  survey.rows[1].desc = '=HYPERLINK("http://example.invalid")';
  const red = L.reduce(survey);
  const csv = L.surveyCsv(survey, red);
  const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  check('a byte-order mark for Excel, CRLF lines, a header and one row a sight, then Σ and the misclose',
    csv.startsWith('﻿') && lines.length === 1 + 11 + 2 && /^Station number,Station name,Survey date,Datum,Row,Point/.test(lines[0]), lines.length);
  check('numbers are numbers: row 2\'s IS and fall', /,1\.866,,,0\.454,/.test(lines[2]) || lines[2].includes(',1.866,') , lines[2]);
  check('a description that starts like a formula is written as text, not run', lines[2].includes(`"'=HYPERLINK(""http://example.invalid"")"`), lines[2]);
  const sheets = L.workbook(survey, red, { test, photos: [{ file: 'photos/a.webp', row: 2, point: 'B', what: 'Intermediate reading', value: 1.866 }] });
  check('the workbook\'s sheets: the survey, the boards, the checks, the two-peg test, the photos',
    J(sheets.map(s => s.name)) === J(['Survey', 'Gauge boards', 'Checks', 'Two-peg test', 'Photos']));
  const flat = sheets[0].rows.flat().map(c => (c && typeof c === 'object' ? c.f || c.v : c));
  check('the run\'s Σ row is SUM formulas, with their answers cached', flat.some(v => /^SUM\(B\d+:B\d+\)$/.test(String(v))), '');
  check('a practice survey says so on its sheet', sheets[0].rows[1][0].v.includes('PRACTICE'));
  check('the file is named for the station and the date', L.fileStem(survey).startsWith('floodnet-level-survey-999001-') && L.fileStem(survey).endsWith('-practice'));
}

section('The workbook writer');
{
  const parts = X.parts([{ name: 'A/B: [c]?', rows: [['x', 1.5, { f: 'SUM(B1:B1)', v: 1.5, s: 'num3b' }, '<&>']], merges: ['A1:B1'], freeze: 1, landscape: true, fitWidth: true },
                         { name: 'a/b: [c]?', rows: [] }]);
  const names = parts.map(p => p[0]);
  check('the parts an .xlsx needs', ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].every(n => names.includes(n)), J(names));
  const wb = parts.find(p => p[0] === 'xl/workbook.xml')[1];
  check('Excel\'s rules for a sheet\'s name: no []:*?/\\, and two the same apart are made two', /name="A B   c"/.test(wb) && /name="a b   c \(2\)"/.test(wb), wb.match(/name="[^"]*"/g));
  const sh = parts.find(p => p[0] === 'xl/worksheets/sheet1.xml')[1];
  check('text inline and escaped, numbers as numbers, a formula with its answer', sh.includes('<t xml:space="preserve">&lt;&amp;&gt;</t>') && sh.includes('<v>1.5</v>') && sh.includes('<f>SUM(B1:B1)</f><v>1.5</v>'));
  check('a frozen row, landscape and one page wide', sh.includes('state="frozen"') && sh.includes('orientation="landscape"') && sh.includes('fitToWidth="1"'));
  check('column letters past Z', X.colName(0) === 'A' && X.colName(25) === 'Z' && X.colName(26) === 'AA' && X.colName(701) === 'ZZ' && X.colName(702) === 'AAA');
}

section('Reading a display and a plate');
{
  const r = s => C.parseReading(s);
  check('a Leica-style screen: R and HD', r('R 1.24537 m\nHD 23.456 m').height === 1.24537 && r('R 1.24537 m\nHD 23.456 m').distance === 23.456);
  check('no labels: the staff reading by its places, the distance by its size', r('1.2450m\n 23.45m').height === 1.245 && r('1.2450m\n 23.45m').distance === 23.45);
  check('Ht and Dist labels', r('Ht: 1.2345\nDist: 12.34').height === 1.2345 && r('Ht: 1.2345\nDist: 12.34').distance === 12.34);
  check('a point number is not a reading', r('Pt 12\nRb 0.96512m').height === 0.96512 && !r('Pt 12').candidates.some(c => c.value === 12));
  check('the engine\'s O for 0 put right among digits, and a decimal comma read', r('1.2O5').height === 1.205 && r('R 1,2453 m').height === 1.2453);
  check('a time on the display is not a reading', r('10:35\n1.342').height === 1.342 && !r('10:35').candidates.length);
  const lost = r('12450');
  check('a lost decimal point is offered back — and marked as a guess, never sure', lost.height === 1.245 && !lost.sureHeight && lost.candidates.some(c => c.guessed));
  const lab = C.parseLabel('Leica Geosystems\nSprinter 150M\nS/N 1234567\nMade in China');
  check('a plate: make, model and serial', lab.make === 'Leica' && lab.model === 'Sprinter 150M' && lab.serial === '1234567', J(lab));
  check('…and a model that implies its make', C.parseLabel('TOPCON DL-502\nSERIAL NO. ZL0987').model === 'DL-502' && C.parseLabel('DiNi 03 No. 700123').make === 'Trimble');
  const w = 200, h = 100, g = new Uint8Array(w * h).fill(200);
  for (let y = 40; y < 60; y++) for (let x = 60; x < 140; x++) if ((x >> 2) % 2 === 0) g[y * w + x] = 30;
  const box = C.tighten(g, w, h);
  check('where the text is: the box round the strokes, with a margin', box && box.x < 60 && box.x > 40 && box.x + box.w > 140 && box.x + box.w < 160 && box.y < 40 && box.y + box.h > 60, J(box));
  check('…and nothing where there is no text', C.tighten(new Uint8Array(w * h).fill(128), w, h) === null);
  // Two lines with a gap between them — the staff reading over the distance —
  // and a speck of glare off to the side: the box is round both lines and not
  // stretched to the speck.
  const g2 = new Uint8Array(w * h).fill(200);
  for (let y = 22; y < 36; y++) for (let x = 50; x < 150; x++) if ((x >> 2) % 2 === 0) g2[y * w + x] = 30;
  for (let y = 64; y < 78; y++) for (let x = 50; x < 130; x++) if ((x >> 2) % 2 === 0) g2[y * w + x] = 30;
  g2[90 * w + 190] = 0;
  const two = C.tighten(g2, w, h);
  check('…every line of a display, not only its busiest one, and not a speck beside it', two && two.y < 22 && two.y + two.h > 78 && two.x + two.w < 165, J(two));
}

// ═══ 2. The tabs, as a phone ═════════════════════════════════════════════════

const server = await startServer();
const browser = await launchBrowser({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floodnet-levels-'));

try {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, acceptDownloads: true,
    geolocation: { latitude: -27.5545, longitude: 152.2786, accuracy: 6 }, permissions: ['geolocation', 'camera'],
    timezoneId: 'Australia/Brisbane',
  });
  const page = await context.newPage();
  const net = await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const txt = sel => page.locator(sel).innerText();

  section('The list, and the worked example');
  await page.evaluate(() => switchTab('levels'));
  await page.waitForSelector('#lv-root .lv-hero');
  check('the tab opens on its list: new, practise, open a file, and getting ready for no signal',
    (await page.locator('#lv-root button', { hasText: 'New survey' }).count()) === 1 && (await page.locator('#lv-ready').count()) === 1);
  check('nothing wider than the phone (the list)', (await wide()) <= 1, await wide());
  await page.locator('#lv-root button', { hasText: 'Practise' }).click();
  await page.waitForSelector('#lv-rows .lv-row');
  check('the worked example opens on its run, eleven rows, marked practice',
    (await page.locator('#lv-rows .lv-row').count()) === 11 && /practice/.test(await txt('.lv-top')));
  check('…closed, misclose +0.001 m, the three checks agreeing', /Misclose\s*\+0\.001 m/.test(await txt('#lv-live-run')) && /all three agree/.test(await txt('#lv-live-run')));
  await page.locator('#lv-root input[type="checkbox"]').first().check();
  check('…and as a level book: the columns, and Σ', (await page.locator('#lv-table table.lv-book tbody tr').count()) === 11 && /5\.674/.test(await txt('#lv-table tfoot')));
  check('nothing wider than the phone (the run as a level book)', (await wide()) <= 1, await wide());
  for (const s of ['site', 'kit', 'datum', 'water', 'check']) {
    await page.evaluate(id => LevelSurvey.go(id), s);
    await page.waitForSelector('#lv-step h3');
    const w = await wide();
    check(`step "${s}" draws, and fits the phone`, w <= 1, w);
  }
  check('the final check names what is left: photos', /Still to take/.test(await txt('#lv-live-check')));
  const sendBtn = await page.locator('#lv-step button', { hasText: 'Send to Flood-Net' }).count();
  check('a practice survey offers no Send', sendBtn === 0 && /stays on this device/.test(await txt('#lv-step')));

  section('A new survey, booked through the sheet');
  await page.evaluate(() => LevelSurvey.home());
  await page.locator('#lv-root button', { hasText: 'New survey' }).click();
  await page.waitForSelector('#lv-stn-q');
  await page.fill('#lv-stn-q', 'gatton');
  await page.waitForSelector('#lv-hits .lv-hit');
  check('a station search offers stations', (await page.locator('#lv-hits .lv-hit').count()) > 0);
  await page.locator('#lv-root button', { hasText: 'Near me' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#lv-hits .lv-hit').length > 0 && /m|km/.test(document.querySelector('#lv-hits').textContent), null, { timeout: 25_000 });
  const nearest = await page.locator('#lv-hits .lv-hit').first().innerText();
  check('📍 Near me lists the stations nearest the phone, with how far', /Gatton/i.test(nearest) && /\d+ m|\d\.\d km/.test(nearest), nearest);
  await page.locator('#lv-hits .lv-hit').first().click();
  const sid = await page.evaluate(() => { const d = LevelStore.list('surveys').find(x => !x.practice); return d && d.station; });
  check('picked: the survey is filed under it, and its benchmark named for it', sid && sid.id && /^BM\w+_1$/.test(await page.evaluate(() => LevelStore.list('surveys').find(x => !x.practice).bm.name)), J(sid));
  await page.evaluate(() => LevelSurvey.go('datum'));
  await page.locator('.lv-datum', { hasText: 'Assumed' }).click();
  check('choosing assumed starts the benchmark at 100.000', await page.evaluate(() => LevelStore.list('surveys').find(x => !x.practice).bm.rl === 100));
  await page.evaluate(() => LevelSurvey.go('run'));
  await page.waitForSelector('#lv-rows .lv-row');
  await page.locator('#lv-rows .lv-row-btn').first().click();
  await page.fill('#lv-r-bs', '1.500');
  await page.locator('#lv-root button', { hasText: 'Done' }).click();
  await page.locator('#lv-root button', { hasText: 'Intermediate' }).click();
  await page.fill('#lv-r-is', '2.000');
  check('an intermediate\'s level appears as it is typed: 100 + 1.500 − 2.000 = 99.500', /RL\s*99\.500/.test(await txt('#lv-live-row')), await txt('#lv-live-row'));
  check('nothing wider than the phone (the row editor)', (await wide()) <= 1, await wide());
  const rowNew = await page.evaluate(() => LevelStore.list('surveys').find(x => !x.practice).rows[1].id);
  await page.locator('#lv-root button', { hasText: 'Done' }).click();

  section('The reading camera');
  // A level's display, drawn here: two lines, dark on the grey-green of an LCD.
  const shot = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 900; cv.height = 300;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#b9c4a2'; cx.fillRect(0, 0, 900, 300);
    cx.fillStyle = '#16180f';
    cx.font = 'bold 64px "DejaVu Sans Mono", "Liberation Mono", monospace';
    cx.fillText('R   1.4120 m', 150, 135);
    cx.fillText('HD  18.20 m', 150, 225);
    const b = await new Promise(r => cv.toBlob(r, 'image/png'));
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  await page.evaluate(id => LevelSurvey.editRow(id), rowNew);
  const tessRequests = [];
  page.on('request', r => { if (/unpkg\.com\/tesseract/.test(r.url())) tessRequests.push(r.url()); });
  await page.evaluate(() => { LevelSurvey.readInto('is'); });
  await page.waitForSelector('#lc-sheet');
  await page.waitForFunction(() => !document.getElementById('lc-shutter').disabled && document.getElementById('lc-video').videoWidth > 0, null, { timeout: 20_000 }).catch(() => {});
  const cam = await page.evaluate(() => ({ live: !document.getElementById('lc-shutter').disabled, w: document.getElementById('lc-video').videoWidth,
    note: document.getElementById('lc-note').textContent }));
  check('the camera starts: the shutter is live over the fake camera\'s picture', cam.live && cam.w > 0, J(cam));
  check('…the guide on it is a display\'s shape, and the sheet is a dialog', await page.evaluate(() => {
    const g = document.getElementById('lc-guide'), s = document.getElementById('lc-sheet');
    const r = g.getBoundingClientRect();
    return r.width / r.height > 2.5 && s.getAttribute('role') === 'dialog' && s.getAttribute('aria-modal') === 'true';
  }));
  await page.setInputFiles('#lc-file', { name: 'display.png', mimeType: 'image/png', buffer: Buffer.from(shot) });
  await page.waitForSelector('#lc-box');
  await page.locator('#lc-shutter').click();
  await page.waitForFunction(() => { const v = document.getElementById('lc-value'); return v && v.value; }, null, { timeout: OCR_TIMEOUT });
  const read = await page.evaluate(() => ({ value: document.getElementById('lc-value').value, also: !!document.getElementById('lc-dist-too') }));
  check('the real OCR engine reads the display: 1.412, the distance offered beside it', Number(read.value) === 1.412 && read.also, J(read));
  check('…the engine fetched only when a picture needed reading, from the version pinned', tessRequests.length > 0 && tessRequests.every(u => /@7\.0\.0|@1\.0\.0/.test(u)), tessRequests.length);
  await page.locator('#lc-sheet button', { hasText: 'Use this reading' }).click();
  await page.waitForFunction(() => !document.getElementById('lc-sheet'), null, { timeout: 10_000 });
  await page.waitForFunction(id => { const d = LevelStore.list('surveys').find(x => !x.practice); const r = d.rows.find(x => x.id === id); return r && r.is === 1.412; }, rowNew, { timeout: 10_000 });
  const ev = await page.evaluate(id => {
    const d = LevelStore.list('surveys').find(x => !x.practice);
    const r = d.rows.find(x => x.id === id);
    const p = (r.photos || [])[0];
    const e = p && LevelStore.evidence(p.id);
    return { is: r.is, is_d: r.is_d, ref: p, e: e && { type: e.type, bytes: e.bytes, kind: e.kind, value: e.value_m, w: e.width, h: e.height, ocr: e.ocr_text, field: e.field, owner: e.owner } };
  }, rowNew);
  check('accepted: the row takes the reading and the distance', ev.is === 1.412 && ev.is_d === 18.2, J(ev));
  check('its picture is kept as the reading\'s evidence: filed under the survey, the row and the sight',
    ev.ref && ev.ref.kind === 'reading' && ev.e && ev.e.kind === 'reading' && ev.e.field === 'is' && ev.e.owner === 'survey' && ev.e.value === 1.412, J(ev.e));
  check('…cut to the display, grey WebP, small: under 40 kB and under 960 px across', ev.e && ev.e.type === 'image/webp' && ev.e.bytes < 40_000 && ev.e.w <= 960, J(ev.e));
  check('…with what the engine saw kept beside it', ev.e && /1\.4120/.test(ev.e.ocr || ''), ev.e && ev.e.ocr);

  section('Kept on the phone');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('levels'));
  await page.waitForFunction(() => document.querySelectorAll('#lv-root .lv-cards .lv-card').length >= 2, null, { timeout: 10_000 });
  const kept = await page.evaluate(() => LevelStore.list('surveys').map(d => ({ practice: d.practice, rows: d.rows.length, ev: LevelStore.evidenceOf(d.id).length })));
  check('both surveys come back after a reload — rows, reading and picture', kept.some(k => !k.practice && k.rows === 2 && k.ev === 1) && kept.some(k => k.practice), J(kept));

  section('The files');
  const practiceId = await page.evaluate(() => LevelStore.list('surveys').find(x => x.practice).id);
  await page.evaluate(id => { LevelSurvey.open(id); LevelSurvey.go('check'); }, practiceId);
  const grab = async label => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.locator('#lv-step button', { hasText: label }).click()]);
    const to = path.join(tmp, d.suggestedFilename());
    await d.saveAs(to);
    return { name: d.suggestedFilename(), file: to };
  };
  const xl = await grab('Excel workbook');
  check('Excel: named floodnet-level-survey-<station>-<date>-practice.xlsx', /^floodnet-level-survey-999001-\d{4}-\d{2}-\d{2}-practice\.xlsx$/.test(xl.name), xl.name);
  const wb = openWorkbook(xl.file);
  const cells = wb.cells('Survey');
  check('…it opens: the sheets, the title, the run and its closure', J(wb.names) === J(['Survey', 'Gauge boards', 'Checks', 'Two-peg test'])
    && cells.A1 === 'Level survey — rise and fall' && Object.values(cells).includes('BM999001_1') && Object.values(cells).includes('PASS'), J(wb.names));
  check('…the Σ row holds the sums', Object.values(cells).includes('5.674') && Object.values(cells).includes('5.673'), '');
  const cs = await grab('CSV');
  const csvText = fs.readFileSync(cs.file, 'utf8');
  check('CSV: a header and eleven sights, the misclose at the foot', csvText.replace(/^﻿/, '').split('\r\n').filter(Boolean).length === 14 && /Misclose,0\.001/.test(csvText));
  const zp = await grab('Package');
  const zbuf = fs.readFileSync(zp.file);
  check('the package: a zip of the workbook, the CSV, the survey file and a README',
    zbuf.subarray(0, 2).toString() === 'PK' && ['.xlsx', '.csv', '.json', 'README.txt'].every(s => zbuf.includes(Buffer.from(s))), zp.name);

  section('Sending, with the database stood in for');
  // The doors 0060 opened, recorded rather than reached: the network policy
  // blocks the datastore, and its rules are tools/check_level_surveys.sql's.
  await page.evaluate(() => {
    window.__calls = [];
    window.__fail = null;
    window.dbRpc = async (fn, args) => {
      window.__calls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
      if (window.__fail) throw window.__fail;
      if (fn === 'level_survey_save') return { survey: { id: args.p.id, status: 'submitted', outcome: 'open', misclose_m: null } };
      if (fn === 'two_peg_test_save') return { test: { error_m: 0.001, passed: true } };
      return {};
    };
    window.dbUploadObject = async (bucket, p, blob) => { window.__calls.push({ fn: 'upload', bucket, path: p, size: blob.size, type: blob.type }); return { bucket, path: p }; };
    window.dbCanWrite = () => true;
    Auth.isSignedIn = () => true;
  });
  const realId = await page.evaluate(() => LevelStore.list('surveys').find(x => !x.practice).id);
  await page.evaluate(id => LevelStore.queue('surveys', id), realId);
  await page.waitForFunction(id => (LevelStore.get('surveys', id).sync || {}).state === 'sent', realId, { timeout: 15_000 });
  const calls = await page.evaluate(() => window.__calls);
  const order = calls.map(c => c.fn);
  check('sent in order: the survey, then its picture\'s bytes, then the picture\'s record',
    order.indexOf('level_survey_save') >= 0 && order.indexOf('level_survey_save') < order.indexOf('upload') && order.indexOf('upload') < order.indexOf('level_evidence_add'), J(order));
  const save = calls.find(c => c.fn === 'level_survey_save').args.p;
  check('…the survey without the phone\'s bookkeeping, with the sheet\'s own result', !('sync' in save) && save.result && save.result.closed === false && save.result.misclose === null, J(save.result));
  const up = calls.find(c => c.fn === 'upload'), add = calls.find(c => c.fn === 'level_evidence_add');
  check('…the picture into the level-surveys bucket at survey/<survey>/<picture>.webp, and its record at the same path',
    up.bucket === 'level-surveys' && up.path === `survey/${realId}/${add.args.p.id}.webp` && add.args.p.storage_path === up.path && add.args.p.value_m === 1.412, J({ up, p: add.args.p.storage_path }));
  check('a practice survey is never sent', !calls.some(c => c.fn === 'level_survey_save' && c.args.p.practice));
  await page.evaluate(() => { window.__calls = []; window.__fail = Object.assign(new Error('Could not find the function meganet.level_survey_save'), { status: 404, code: 'PGRST202', denied: true }); });
  await page.evaluate(id => LevelStore.queue('surveys', id), realId);
  await page.waitForFunction(id => (LevelStore.get('surveys', id).sync || {}).state === 'not-ready', realId, { timeout: 10_000 });
  check('a database without 0060 yet: kept here, and said plainly — not taken for a refusal',
    /0060/.test(await page.evaluate(id => LevelStore.get('surveys', id).sync.note, realId)));
  await page.evaluate(() => { window.__fail = new TypeError('Failed to fetch'); });
  await page.evaluate(id => LevelStore.queue('surveys', id), realId);
  await page.waitForFunction(id => (LevelStore.get('surveys', id).sync || {}).state === 'failed', realId, { timeout: 10_000 });
  check('no signal: waiting, to be tried again later', await page.evaluate(id => LevelStore.get('surveys', id).sync.next > Date.now(), realId));
  await page.evaluate(() => { window.__fail = null; });

  section('An administrator\'s panel');
  await page.evaluate(() => {
    const { survey } = Levelling.practice();
    survey.practice = false;
    survey.station = { id: 'abercorn_al', number: '539218', name: 'Abercorn AL' };
    window.__srv = survey;
    window.dbSelect = async q => {
      if (/^level_survey\?/.test(q)) return [{ id: survey.id, station_id: 'abercorn_al', station_number: '539218', station_name: 'Abercorn AL', survey_date: survey.date,
        datum: 'AHD', bm_name: survey.bm.name, outcome: 'pass', misclose_m: 0.001, tolerance_m: 0.003, rows_n: 11, status: 'submitted',
        submitted_by: 'crew@example.test', submitted_at: new Date().toISOString(), decided_by: null, decided_at: null, decision_note: null, doc: survey }];
      return [];
    };
    Auth.isAdmin = () => true;
    Auth.role = () => 'admin';
  });
  await page.evaluate(() => LevelSurvey.openServer(window.__srv.id));
  await page.waitForSelector('.lv-decide');
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.lv-decide input[data-change]')].map(b => b.checked));
  check('the panel lists what the survey found, ticked only where it is new: not the gauge zero it was given, not the offset',
    boxes.length === 9 && boxes[0] === false && boxes[boxes.length - 1] === false && boxes.slice(1, -1).every(Boolean), J(boxes));
  check('nothing wider than the phone (a filed survey and its panel)', (await wide()) <= 1, await wide());
  await page.evaluate(() => { window.__calls = []; });
  await page.locator('.lv-decide button', { hasText: 'Apply what is ticked' }).click();
  await page.locator('[data-ask="yes"]').click();
  await page.waitForFunction(() => window.__calls.some(c => c.fn === 'level_survey_apply'), null, { timeout: 10_000 });
  const ap = await page.evaluate(() => window.__calls.find(c => c.fn === 'level_survey_apply').args);
  check('applied: the benchmark, four boards, the CTR and the CTF, each as a point, for that survey',
    ap.p_survey === (await page.evaluate(() => window.__srv.id)) && ap.p_changes.length === 7 && ap.p_changes.every(c => c.kind === 'point')
    && ap.p_changes[0].value.kind === 'bm' && ap.p_changes[0].value.primary === true, J(ap.p_changes.map(c => [c.kind, c.value.kind, c.value.name])));

  section('The two-peg test');
  await page.evaluate(() => switchTab('twopeg'));
  await page.locator('#tp-root button', { hasText: 'New test' }).click();
  await page.waitForSelector('#tp-a1');
  for (const [k, v] of [['a1', '1.200'], ['b1', '1.300'], ['a2', '1.500'], ['b2', '1.602']]) await page.fill(`#tp-${k}`, v);
  check('1.200/1.300 then 1.500/1.602: error 0.002 m, PASS', /PASS — error 0\.002 m/.test(await txt('#tp-live')), await txt('#tp-live'));
  await page.fill('#tp-b2', '1.604');
  check('…1.604: error 0.004 m, FAIL, and what B should have read', /FAIL — error 0\.004 m/.test(await txt('#tp-live')) && /should read|would read/.test(await txt('#tp-live')), await txt('#tp-live'));
  check('the two set-ups drawn, each with a title saying what it shows', (await page.locator('#tp-diagrams svg[role="img"] title').count()) === 2);
  check('nothing wider than the phone (the test)', (await wide()) <= 1, await wide());

  section('How to Survey');
  await page.evaluate(() => SurveyGuide.show('booking'));
  await page.waitForFunction(() => document.getElementById('sg-booking') && document.getElementById('sg-booking').open, null, { timeout: 10_000 });
  check('a section opened by its link: the worked example booked, eleven rows, and its misclose',
    (await page.locator('#sg-booking table tbody tr').count()) === 11 && /\+0\.001 m/.test(await txt('#sg-booking')));
  check('nothing wider than the phone (the guide)', (await wide()) <= 1, await wide());

  check('no request left the machine but the pinned OCR engine', net.blocked.every(u => !/tesseract/.test(u)), net.blocked.filter(u => /tesseract/.test(u)).join(', '));
  check('nothing thrown on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(r => !r.pass);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} — ${results.length - failed.length} of ${results.length} checks.`);
process.exit(failed.length ? 1 : 0);
