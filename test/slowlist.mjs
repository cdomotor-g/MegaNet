// The station list on a slow line (app.js loadFromApi, pwa.js keptList): a
// device that has opened Flood-Net before draws the copy it kept when the
// datastore has not answered whole in LIST_SLOW_MS, says it is a saved copy,
// how old and why, and carries on with the download — and what the download
// brings decides what happens next:
//
//   * the same list: the label alone changes, to "from the datastore";
//     nothing is drawn again, nothing offered
//   * a different list: offered as Use the newer list, first on the header's
//     line, with the copy still on screen and still said to be one; pressed,
//     the newer list is on screen, from the datastore
//   * no answer at all: the copy stays, now said to be there because the
//     datastore did not answer
//   * a quick answer: drawn as itself, the copy never read
//
// The copy is put where sw.js keeps it (the floodnet-data cache, under the
// address the load asks at, with the time it was kept) by the page itself, so
// no worker is needed — every other check runs without one, and pwa.js stands
// down under automation. The datastore is held back by route, 12 s.
//
// Run:  npm run slowlist

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const HOLD_MS = 12000;
const doc = fs.readFileSync(path.join(REPO_ROOT, 'stations.json'), 'utf8');
const dated = JSON.parse(doc).meta.updated;
const failures = [];
const check = (ok, label) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) failures.push(label); };

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  try {
    for (const variant of ['same', 'different', 'no answer', 'quick']) {
      console.log(`\nThe datastore's answer: ${variant}`);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await applyNetworkPolicy(page, server.origin);
      const fresh = variant === 'different' ? doc.replace(`"updated": "${dated}"`, '"updated": "2099-01-01"') : doc;
      await page.route(/\/rpc\/stations_doc/, async route => {
        if (variant === 'no answer') { await new Promise(r => setTimeout(r, HOLD_MS)); return route.abort(); }
        if (variant !== 'quick') await new Promise(r => setTimeout(r, HOLD_MS));
        return route.fulfill({ status: 200, contentType: 'application/json', body: fresh,
                               headers: { 'access-control-allow-origin': '*' } });
      });

      // A first visit, whose answer is kept the way sw.js keeps one.
      await page.goto(server.url(), { waitUntil: 'load' });
      await page.waitForFunction(() => state.load && !state.load.busy, null, { timeout: 60000 });
      await page.evaluate(async text => {
        const cache = await caches.open('floodnet-data');
        await cache.put(new URL(stationDocRequest('api')[0], location.href).href, new Response(text, {
          headers: { 'Content-Type': 'application/json', 'X-FloodNet-Kept': new Date(Date.now() - 3 * 3600e3).toISOString() },
        }));
      }, doc);

      const t0 = Date.now();
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!state.data, null, { timeout: 60000 });
      const drawnMs = Date.now() - t0;
      const read = () => page.evaluate(() => ({
        header: document.getElementById('hdr-stats').textContent,
        kind: state.dataSource && state.dataSource.kind,
        kept: !!(state.dataSource && state.dataSource.kept),
        dated: state.dataSource && state.dataSource.dated,
        newer: !!state.newerList,
        button: !!document.querySelector('#hdr-stats .hdr-newer'),
      }));
      const first = await read();
      console.log(`  · drawn after ${drawnMs} ms: ${first.header}`);

      if (variant === 'quick') {
        check(!first.kept && first.kind === 'api' && /from the datastore/.test(first.header),
          'a quick answer is drawn as itself, from the datastore');
      } else {
        check(drawnMs < HOLD_MS - 1000, `the kept copy is drawn before the answer (${drawnMs} ms, the answer held ${HOLD_MS} ms)`);
        check(first.kept && /saved copy, 3 hours old — the datastore is slow to answer; the current list is on its way/.test(first.header),
          'the header says it is a saved copy, how old, and that the current list is on its way');
        await page.evaluate(() => switchTab('stations'));
        await page.waitForFunction(() => state.load && !state.load.busy, null, { timeout: 60000 });
        await page.waitForTimeout(300);
        const after = await read();
        console.log(`  · after the answer: ${after.header}`);
        if (variant === 'same') {
          check(!after.kept && after.kind === 'api' && !after.newer && !after.button && /from the datastore/.test(after.header),
            'the same list: the label alone changes, to from the datastore, and nothing is offered');
        }
        if (variant === 'different') {
          check(after.newer && after.button && /^Use the newer list · /.test(after.header) && after.kept,
            'a different list: Use the newer list, first on the line, with the copy still on screen and said to be one');
          await page.click('#hdr-stats .hdr-newer');
          await page.waitForTimeout(500);
          const used = await read();
          console.log(`  · pressed: ${used.header}`);
          check(!used.kept && used.dated === '2099-01-01' && !used.newer && !used.button && /from the datastore/.test(used.header),
            'pressed: the newer list is on screen, from the datastore, and the button is gone');
        }
        if (variant === 'no answer') {
          check(after.kept && /saved copy, 3 hours old — no answer from the datastore/.test(after.header),
            'no answer: the copy stays, said to be there because the datastore did not answer');
        }
      }
      check(!errors.length, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (failures.length) {
    console.log(`\nFAIL — ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS — on a slow line the kept station list is drawn first, said to be a saved copy and why, and the answer\n'
    + '       relabels it, is offered, or leaves it standing; a quick answer is drawn as itself.');
}

main().catch(err => { console.error(err); process.exit(1); });
