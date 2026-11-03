// tools/explainers/shoot.mjs — the screenshots the 🎬 Videos show (EPIC #262).
//
// A video's `shot` scene is the app itself, not a drawing of it: a screenshot
// of a tab taken from the site, with the parts the words are about ringed and
// named as they are said (explainers.js). This takes them. Each shot is a line
// in tools/explainers/shots.json — the page, a phone or a desk, what to wait
// for, what to hide (`css`), and the parts to point at, each a CSS selector —
// and comes out as
//
//   data/explainers/shots/<name>.webp     the picture
//   data/explainers/shots/index.json      every shot's size and where each of
//                                         its parts was on it (its targets)
//
// The app changes; a shot does not. So:
//   * taking one again is free — no ElevenLabs credits, nothing voiced: run
//     this, check the pictures, push;
//   * test/explainers.mjs opens each shot's page in the app as it is now and
//     fails a shot one of whose parts has gone, naming the command that takes
//     it again;
//   * CLAUDE.md and AGENTS.md say to take a shot again in the same push as a
//     change that moves or restyles what it shows.
//
//   node tools/explainers/shoot.mjs                  every shot, from https://floodwarning.net/
//   node tools/explainers/shoot.mjs home health       the ones named
//   node tools/explainers/shoot.mjs --tab stations   every shot of that tab
//   --base URL       somewhere else (a local server: http://127.0.0.1:8080/)
//   --probe NAME     print the boxes of what is on NAME's page, to choose targets
//
// Taken signed out — what anybody may see — at 1440×810 (a phone 390×844),
// a third over the pixels (a phone twice) so a projector shows it sharp, in the
// light theme with reduced motion, from Brisbane, as a first visit by a link.
// Nothing private is in reach of a signed-out page: no landholder details, no
// site codes (CLAUDE.md, Private data).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const MANIFEST = path.join(HERE, 'shots.json');
export const OUT = path.join(REPO, 'data', 'explainers', 'shots');
export const SHOT_FORMAT = 'floodnet-explainer-shots/1';
export const DEVICES = {
  desk:  { width: 1440, height: 810, scale: 4 / 3 },
  phone: { width: 390, height: 844, scale: 2, mobile: true },
};
const QUALITY = 0.86;          // WebP, a screenshot of text and lines
const BRISBANE = { latitude: -27.4698, longitude: 153.0251 };

export function readManifest(file = MANIFEST) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!m || !Array.isArray(m.shots)) throw new Error(`${file} has no "shots" list`);
  return m;
}

// The page a shot is of, opened as it will be shot: a new browser, the
// device's size, Brisbane, the light theme, this shot's own stored settings.
export async function openShot(browser, shot, base, { policy = null } = {}) {
  const dev = DEVICES[shot.device || 'desk'];
  const context = await browser.newContext({
    viewport: { width: dev.width, height: dev.height }, deviceScaleFactor: dev.scale, isMobile: !!dev.mobile, hasTouch: !!dev.mobile,
    geolocation: BRISBANE, permissions: ['geolocation'], timezoneId: 'Australia/Brisbane', locale: 'en-AU',
    colorScheme: 'light', reducedMotion: 'reduce',
  });
  if (shot.store) await context.addInitScript(kv => { for (const [k, v] of Object.entries(kv)) { try { localStorage.setItem(k, v); } catch (_) {} } }, shot.store);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (policy) await policy(page);
  await page.goto(new URL(shot.path || '', base).href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data && Array.isArray(state.data.stations), null, { timeout: 90_000 });
  if (shot.ready) await page.waitForSelector(shot.ready, { state: 'visible', timeout: 60_000 });
  // What would mislead in a still: a ▶ that does not play, a pill that
  // only says something is new on this device.
  if (shot.css) await page.addStyleTag({ content: shot.css });
  for (const st of shot.steps || []) {
    if (st.click) await page.click(st.click);
    if (st.call) await page.evaluate(([fn, args]) => window[fn](...args), [st.call[0], st.call.slice(1)]);
    if (st.scroll) await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'start' }); }, st.scroll);
    if (st.wait) await page.waitForTimeout(st.wait);
  }
  return { context, page, errors, dev };
}

// Where each target is on the picture, in the page's own pixels (CSS pixels:
// the picture is `scale` times larger), cut to what is in view.
export async function targetBoxes(page, targets) {
  return page.evaluate(t => {
    const out = {}, missing = [];
    for (const [id, sel] of Object.entries(t)) {
      const el = document.querySelector(sel);
      if (!el) { missing.push(id); continue; }
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left), y = Math.max(0, r.top), x2 = Math.min(innerWidth, r.right), y2 = Math.min(innerHeight, r.bottom);
      if (x2 - x < 4 || y2 - y < 4) { missing.push(id); continue; }
      out[id] = { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
    }
    return { out, missing };
  }, targets);
}

async function shoot(browser, shot, base) {
  const { context, page, errors, dev } = await openShot(browser, shot, base);
  try {
    // Settled: the map's tiles and the pictures in, nothing moving.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(shot.settle || 2500);
    const { out, missing } = await targetBoxes(page, shot.targets || {});
    if (missing.length) throw new Error(`${shot.name}: not on the page, or out of view: ${missing.join(', ')}`);
    const png = await page.screenshot({ type: 'png' });
    // WebP from the browser's own encoder: no image library to install.
    const webp = await page.evaluate(async ([b64, q]) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', q).split(',')[1];
    }, [png.toString('base64'), QUALITY]);
    const stamp = await page.evaluate(() => { const m = /[?&]v=([0-9a-z]+)/.exec([...document.scripts].map(s => s.src).find(s => /init\.js/.test(s)) || ''); return m ? m[1] : null; });
    fs.mkdirSync(OUT, { recursive: true });
    const image = `data/explainers/shots/${shot.name}.webp`;
    fs.writeFileSync(path.join(REPO, image), Buffer.from(webp, 'base64'));
    return { name: shot.name, image, device: shot.device || 'desk', path: shot.path || '', width: dev.width, height: dev.height, scale: dev.scale,
      bytes: Buffer.from(webp, 'base64').length, taken: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), site: new URL(base).host, stamp,
      targets: out, errors: errors.slice(0, 3) };
  } finally { await context.close(); }
}

export function readIndex() {
  const p = path.join(OUT, 'index.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { format: SHOT_FORMAT, shots: {} };
}

// ── command line ────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const base = arg('--base') || 'https://floodwarning.net/';
  const { chromium } = createRequire(import.meta.url)('playwright');
  const man = readManifest();
  const browser = await chromium.launch();
  try {
    if (arg('--probe')) {
      const shot = man.shots.find(s => s.name === arg('--probe'));
      if (!shot) throw new Error(`no shot "${arg('--probe')}" in ${MANIFEST}`);
      const { context, page } = await openShot(browser, shot, base);
      await page.waitForTimeout(shot.settle || 2500);
      const rows = await page.evaluate(() => [...document.querySelectorAll('#main-content [id], #main-content [class], #stn-card [id], #stn-card [class]')]
        .map(el => { const r = el.getBoundingClientRect(); return { el, r }; })
        .filter(({ r }) => r.width >= 60 && r.height >= 14 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)
        .slice(0, 200).map(({ el, r }) => `${el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/).join('.')}  [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}]  ${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48)}`));
      console.log(rows.join('\n'));
      await context.close();
    } else {
      const named = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base' && argv[i - 1] !== '--tab');
      const tab = arg('--tab');
      const todo = man.shots.filter(s => (!named.length && !tab) || named.includes(s.name) || (tab && new URLSearchParams(String(s.path || '').replace(/^\?/, '')).get('tab') === tab));
      if (!todo.length) throw new Error('no shot matches');
      const index = readIndex();
      for (const shot of todo) {
        const meta = await shoot(browser, shot, base);
        const { errors: _errs, ...kept } = meta;
        index.shots[shot.name] = kept;
        console.log(`  ${shot.name}: ${meta.width}×${meta.height} ${meta.device}, ${(meta.bytes / 1024).toFixed(0)} KB, targets ${Object.keys(meta.targets).join(', ')}${meta.errors.length ? ` — page errors: ${meta.errors.join(' | ')}` : ''}`);
      }
      // Only the shots the manifest still has.
      for (const k of Object.keys(index.shots)) if (!man.shots.some(s => s.name === k)) { delete index.shots[k]; const f = path.join(OUT, `${k}.webp`); if (fs.existsSync(f)) fs.unlinkSync(f); console.log(`  let go of ${k}`); }
      index.format = SHOT_FORMAT;
      index.shots = Object.fromEntries(Object.entries(index.shots).sort(([a], [b]) => a.localeCompare(b)));
      fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
      console.log(`Wrote data/explainers/shots/index.json — ${Object.keys(index.shots).length} shots.`);
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { await browser.close(); }
}
