// "Your lines" on the Plots chart, driven by hand in Chromium.
//
// test/plotlines.mjs holds the arithmetic to known answers in Node; this is
// the other half — that a person can actually get each kind of line onto the
// chart: type a function and press Enter, pick readings and fit a curve, draw
// freehand, rule a line and read its slope. And that the tab is called Plots.
//
//   npm run plotdraw          (-- --shot to save a screenshot to the temp directory)

import os from 'node:os';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;
const SHOT = process.argv.includes('--shot');
let failures = 0;
const ok = (name, pass, detail = '') => {
  if (pass) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  const label = await page.evaluate(() => TABS.flatMap(g => g.tabs)
    .find(t => t.id === 'arrodata')?.label);
  ok('the tab is called Plots', label === 'Plots', String(label));

  await page.evaluate(async () => {
    switchTab('arrodata');
    await new Promise(r => setTimeout(r, 60));
    await window.ArroData.loadDemo();
  });
  await page.waitForFunction(() => window.ArroData.ad.series.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(200);

  // ── A typed function ──────────────────────────────────────────────────────
  await page.click('button:has-text("ƒ(t) function")');
  ok('ƒ(t) function opens the panel with the box focused',
     await page.evaluate(() => document.activeElement?.id === 'ad-fn' && document.getElementById('ad-lines').open));

  await page.fill('#ad-fn', 'alert(1)');
  await page.press('#ad-fn', 'Enter');
  ok('something outside the grammar is refused, saying why',
     /not a function/.test(await page.textContent('#ad-fn-err').catch(() => '')));
  ok('…and draws nothing', await page.evaluate(() => window.ArroData.ad.lines.length === 0));

  // A line through the middle of the demo record's range, rising.
  const mid = await page.evaluate(() => {
    const s = window.ArroData.ad.series[0];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < s.n; i++) { if (s.v[i] < lo) lo = s.v[i]; if (s.v[i] > hi) hi = s.v[i]; }
    return { lo, hi };
  });
  const fn = `${(mid.lo + mid.hi) / 2} + 0*t`;
  await page.fill('#ad-fn', fn);
  await page.press('#ad-fn', 'Enter');
  ok('a function draws as a line on the chart', await page.locator('#ad-svg .ad-line--fn').count() === 1);
  ok('…and is listed under Your lines', await page.locator('.ad-line-row').count() === 1);
  ok('…with its source', (await page.textContent('.ad-line-what')).includes(fn));

  // ── Pick readings, fit a curve ────────────────────────────────────────────
  await page.evaluate(() => window.ArroData.setDrag('select'));
  await page.waitForTimeout(80);
  const box = await page.locator('#ad-svg').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height - 34, { steps: 8 });
  await page.mouse.up();
  const picked = await page.evaluate(() => window.ArroData.ad.picked.size);
  ok('a Select box picks readings', picked > 10, `${picked}`);
  await page.selectOption('#ad-fit-kind', 'linear');
  await page.click('button:has-text("fit a curve")');
  ok('fit a curve draws the fit, solid over the readings',
     await page.locator('#ad-svg .ad-line--fit-in').count() >= 1);
  ok('…and dashed beyond them', await page.locator('#ad-svg .ad-line--fit').count() >= 1);
  const fitRow = await page.locator('.ad-line-row').nth(1).textContent();
  ok('the fit is listed with its equation and r²', /r²\s*[0-9.]+/.test(fitRow) && /·t/.test(fitRow), fitRow.trim().slice(0, 160));

  // ── Draw and Ruler ───────────────────────────────────────────────────────
  await page.evaluate(() => { window.ArroData.pickClear(); window.ArroData.setDrag('draw'); });
  await page.waitForTimeout(80);
  const b2 = await page.locator('#ad-svg').boundingBox();
  await page.mouse.move(b2.x + 200, b2.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b2.x + 200 + i * 12, b2.y + 120 + Math.sin(i / 2) * 30);
  await page.mouse.up();
  ok('Draw leaves a stroke on the chart', await page.locator('#ad-svg .ad-line--sketch').count() === 1);
  const sketch = await page.evaluate(() => window.ArroData.ad.lines.find(l => l.kind === 'sketch'));
  ok('…kept in time and value, not pixels', sketch && sketch.pts.length > 5 && sketch.pts[0][0] > 1e12);

  await page.evaluate(() => window.ArroData.setDrag('ruler'));
  await page.waitForTimeout(80);
  const b3 = await page.locator('#ad-svg').boundingBox();
  await page.mouse.move(b3.x + 300, b3.y + b3.height - 80);
  await page.mouse.down();
  await page.mouse.move(b3.x + 600, b3.y + 80, { steps: 6 });
  await page.mouse.up();
  ok('Ruler leaves a straight line', await page.locator('#ad-svg .ad-line--ruler').count() === 1);
  const slopeText = await page.locator('#ad-svg .ad-lines-g text').allTextContents();
  ok('…labelled with its slope per hour', slopeText.some(t => /^\+.*per hour$/.test(t.trim())), slopeText.join(' | '));

  // Lines survive a pan — they are in data coordinates.
  const before = await page.locator('#ad-svg .ad-line--ruler').getAttribute('d');
  await page.evaluate(() => {
    const A = window.ArroData, v = A.ad.view || { t0: A.ad.series[0].t[0], t1: A.ad.series[0].t[A.ad.series[0].n - 1] };
    const w = v.t1 - v.t0;
    A.ad.view = { t0: v.t0 + w * 0.1, t1: v.t1 + w * 0.1 };
    A.repaint();
  });
  const after = await page.locator('#ad-svg .ad-line--ruler').getAttribute('d');
  ok('a pan moves the ruled line with the readings', before !== after);

  // Off and on, and away.
  const n = await page.evaluate(() => window.ArroData.ad.lines.length);
  ok('four lines in all', n === 4, `${n}`);
  await page.locator('.ad-line-row').first().locator('input[type="checkbox"]').uncheck();
  ok('unticking a line hides it', await page.locator('#ad-svg .ad-line--fn').count() === 0);
  await page.locator('.ad-line-row').first().locator('.ad-x').click();
  ok('✕ removes it', await page.evaluate(() => window.ArroData.ad.lines.length === 3));

  // Not on Increment: each line belongs to the Reading it was made on.
  await page.evaluate(() => window.ArroData.setTransform('increment'));
  await page.waitForTimeout(80);
  ok('on Increment the Value lines are not drawn', await page.locator('#ad-svg .ad-line').count() === 0);
  ok('…and the panel says where they are', await page.locator('.ad-line-away').count() === 3);
  await page.evaluate(() => window.ArroData.setTransform('value'));
  await page.waitForTimeout(80);

  if (SHOT) {
    const out = os.tmpdir();
    await page.evaluate(() => { window.ArroData.ad.linesOpen = true; window.ArroData.setDrag('pan'); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, 'plotdraw.png'), fullPage: true });
    console.log(`  shot  ${path.join(out, 'plotdraw.png')}`);
  }

  ok('no page errors', errors.length === 0, errors.join('\n         '));
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} check(s).`); process.exit(1); }
console.log('\nPASS — a function, a fit, a stroke and a ruler each reach the chart, follow it, and go away again.');
