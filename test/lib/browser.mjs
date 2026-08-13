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
      for (const exe of ['chrome-linux/chrome', 'chrome-linux/headless_shell',
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
    return await chromium.launch(args);
  } catch (err) {
    const exe = findChromium();
    if (!exe) {
      throw new Error(
        `Could not launch Chromium, and no pre-installed build was found.\n`
        + `Run: npx playwright-core install chromium\n`
        + `Or point CHROMIUM_PATH at a Chromium executable.\n\n`
        + `Original error: ${err.message}`);
    }
    return await chromium.launch({ ...args, executablePath: exe });
  }
}
