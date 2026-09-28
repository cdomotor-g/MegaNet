// Pasting a coordinate into a latitude or longitude box (places.js).
//
// A pair pasted into either box splits across both, a single value in
// degrees-minutes-seconds or with a hemisphere letter is converted to decimal
// degrees (and goes to the other box when its letter says so), and a plain
// number that fits the box is left to the browser. The rule is checked on
// Places.readPaste directly, then the paste itself in a real page: boxes
// found by id, by data-f and by data-coord, paired within their own row.
//
//   node --run coordpaste      (or: npm run coordpaste)

import fs from 'node:fs';
import { launchBrowser } from './lib/browser.mjs';

const SRC = fs.readFileSync(new URL('../places.js', import.meta.url), 'utf8');

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-6;

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="form-grid">
      <label>Latitude<input type="number" step="any" id="ef-lat"></label>
      <label>Longitude<input type="number" step="any" id="ef-lon"></label>
    </div>
    <div class="row" id="r0"><input type="number" data-f="point_lat"><input type="number" data-f="point_lon"></div>
    <div class="row" id="r1"><input type="number" data-f="point_lat"><input type="number" data-f="point_lon"></div>
    <div><input type="number" class="mg" data-coord="lat"><input type="number" class="mg" data-coord="lon"></div>
    <div><input type="text" id="other-lat" data-coord="off"><input type="text" id="notes"></div>
    <script>${SRC}
Places.bindCoordPaste();</script>`);

  // The rule, on its own.
  const rp = (t, role) => page.evaluate(([t, role]) => Places.readPaste(t, role), [t, role]);
  let r = await rp('-27.554389, 152.274658', 'lat');
  ok('pair into lat', near(r?.lat, -27.554389) && near(r?.lon, 152.274658), JSON.stringify(r));
  r = await rp('-27.554389, 152.274658', 'lon');
  ok('pair into lon', near(r?.lat, -27.554389) && near(r?.lon, 152.274658), JSON.stringify(r));
  r = await rp('152.274658, -27.554389', 'lat');
  ok('pair written lon-first', near(r?.lat, -27.554389) && near(r?.lon, 152.274658), JSON.stringify(r));
  r = await rp('27°33\'15.8"S 152°16\'28.8"E', 'lat');
  ok('DMS pair', near(r?.lat, -27.5543889) && near(r?.lon, 152.2746667), JSON.stringify(r));
  r = await rp('27º33’15.8”S', 'lon');
  ok('DMS latitude into lon box goes to lat', near(r?.lat, -27.5543889) && r.lon == null, JSON.stringify(r));
  r = await rp('152 16 28.8 E', 'lat');
  ok('spaced DMS longitude into lat box goes to lon', near(r?.lon, 152.2746667) && r.lat == null, JSON.stringify(r));
  r = await rp('-27°33.25\'', 'lat');
  ok('degrees-minutes', near(r?.lat, -27.5541667), JSON.stringify(r));
  ok('plain number that fits left to the browser', (await rp('-27.55', 'lat')) === null);
  ok('text that is not a coordinate ignored', (await rp('hello', 'lon')) === null);
  ok('two bare integers are not a pair', (await rp('6128 6129', 'lat')) === null);

  // The paste, in the page.
  const paste = (sel, text, i = 0) => page.evaluate(([sel, text, i]) => {
    const el = document.querySelectorAll(sel)[i];
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [sel, text, i]);
  const vals = sel => page.evaluate(sel => [...document.querySelectorAll(sel)].map(e => e.value), sel);

  await page.evaluate(() => {
    window.changes = [];
    document.addEventListener('change', e => window.changes.push(e.target.id || e.target.dataset.f || e.target.dataset.coord));
  });
  ok('pair pasted in station lat is handled', await paste('#ef-lat', '-27.554389, 152.274658'));
  ok('station boxes split', JSON.stringify(await vals('#ef-lat, #ef-lon')) === '["-27.554389","152.274658"]',
     JSON.stringify(await vals('#ef-lat, #ef-lon')));
  ok('both boxes told', JSON.stringify(await page.evaluate(() => window.changes)) === '["ef-lat","ef-lon"]',
     JSON.stringify(await page.evaluate(() => window.changes)));

  await paste('[data-f="point_lon"]', '-27.5, 152.25', 1);
  ok('row pairs within itself', JSON.stringify(await vals('#r0 input, #r1 input')) === '["","","-27.5","152.25"]',
     JSON.stringify(await vals('#r0 input, #r1 input')));

  await paste('.mg[data-coord="lon"]', 'S 27 33 15.8 E 152 16 28.8');
  ok('data-coord boxes, DMS stored as decimal', JSON.stringify(await vals('.mg')) === '["-27.5543889","152.2746667"]',
     JSON.stringify(await vals('.mg')));

  ok('plain number not intercepted', !(await paste('#ef-lat', '-27.1')));
  ok('opted-out box not intercepted', !(await paste('#other-lat', '-27.5, 152.2')));
  ok('unrelated box not intercepted', !(await paste('#notes', '-27.5, 152.2')));
} finally {
  await browser.close();
}

if (failures) { console.log(`\ncoordpaste: ${failures} failed`); process.exit(1); }
console.log('coordpaste: ok');
