// Launching Chromium in three different places without three different scripts.
//
// `chromium.launch()` on its own is correct wherever playwright-core installed
// its own browser (CI does this with `playwright-core install chromium`) and
// wherever PLAYWRIGHT_BROWSERS_PATH holds a build matching this playwright
// version. It is *not* correct when a sandbox ships a pre-installed browser at
// a revision playwright-core does not recognise — there the launch fails with
// "Executable doesn't exist" while a perfectly good chrome sits next door. So:
// try the supported path first, and only then go looking.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CANDIDATE_ROOTS = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  '/opt/pw-browsers',
].filter(Boolean);

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const root of CANDIDATE_ROOTS) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    // Newest revision first, and a full chromium ahead of a headless shell:
    // the shell cannot do everything a page needs.
    const dirs = entries
      .filter(d => d.startsWith('chromium'))
      .sort((a, b) => (a.includes('headless') - b.includes('headless'))
                   || b.localeCompare(a, 'en', { numeric: true }));
    for (const dir of dirs) {
      // chrome-linux64/ is the layout newer Playwright builds unpack to (the
      // Claude Code cloud image's chromium-1243 is one); chrome-linux/ the older.
      for (const exe of ['chrome-linux64/chrome', 'chrome-linux/chrome',
                         'chrome-headless-shell-linux64/chrome-headless-shell',
                         'chrome-linux/headless_shell',
                         'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
                         'chrome-win/chrome.exe']) {
        const p = path.join(root, dir, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

export async function launchBrowser(opts = {}) {
  const args = { headless: true, ...opts };
  try {
    return pinLook(await chromium.launch(args));
  } catch (err) {
    const exe = findChromium();
    if (!exe) {
      throw new Error(
        `Could not launch Chromium, and no pre-installed build was found.\n`
        + `Run: npx playwright-core install chromium\n`
        + `Or point CHROMIUM_PATH at a Chromium executable.\n\n`
        + `Original error: ${err.message}`);
    }
    return pinLook(await chromium.launch({ ...args, executablePath: exe }));
  }
}

// ── Which look a page opens in ───────────────────────────────────────────────
// The app has two looks (looks.js): Calm, the default since October 2026, and
// Classic, the one every check written before it was written against — its
// banner buttons, its bar of every tab under its group's heading, ☰ on a phone.
// Those checks are about Classic, and Classic is still one pick away for
// anybody who wants it, so they go on checking it: every context opens the app
// in Classic unless it asks for another, `browser.newContext({ look: 'calm' })`,
// or for none at all, `{ look: null }` — the app's own default, which is what
// `npm run calm` checks.
//
// Pinned through the address, `?look=classic`, rather than through storage:
// the address is a door the app keeps for exactly this (somebody sent a link
// back to Classic), it takes the parameter out again before anything reads the
// address, and — the reason storage would not do — a key written before the
// app runs would make every first visit a second one (Route.newDevice), which
// is what `npm run firstvisit` is about.
//
// The Stations tab's side panel rail is pinned the same way and for the same
// reason, `?rail=icons`: the icon strip every check about the map's width and
// its pins was written against, the names beside them being a column 160 px
// wider (app.js, dockNamesFromAddress). A context asks for the names with
// `{ rail: 'names' }`, or for the app's own default with `{ rail: null }` —
// which is what `npm run dock` §9 checks.
function pinLook(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (opts = {}) => {
    const { look = 'classic', rail = 'icons', ...rest } = opts || {};
    const context = await newContext(rest);
    if (look || rail) {
      await context.addInitScript(([wantLook, wantRail]) => {
        try {
          if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
          const q = new URLSearchParams(location.search);
          let changed = false;
          if (wantLook && !q.has('look')) { q.set('look', wantLook); changed = true; }
          if (wantRail && !q.has('rail')) { q.set('rail', wantRail); changed = true; }
          if (!changed) return;
          history.replaceState(history.state, '', location.pathname + '?' + q.toString() + location.hash);
        } catch (_) {}
      }, [look, rail]);
    }
    return context;
  };
  // browser.newPage() makes a context of its own, which the pin above would
  // never see — so it is made through newContext() like any other.
  browser.newPage = async (opts = {}) => (await browser.newContext(opts)).newPage();
  return browser;
}
