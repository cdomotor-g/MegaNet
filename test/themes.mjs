// The theme follows the device, and Sunlight (#224: core.js's themeStored and
// themeResolve, app.js's applyTheme / setTheme / openThemeMenu), driven in a
// real browser with the device's colour scheme emulated.
//
//   1. **System** — a device that has never chosen follows its own light or
//      dark setting, at load and as it changes; a choice made before there
//      were four (a stored 'light') still stands against a dark device.
//   2. **The menu** — 🌗 opens the four as radios, the current one checked
//      and focused; a pick applies at once, is stored, renames the button and
//      is said; Sunlight draws the map's lines heavier.
//   3. **The rule that asked the device** — the catchment labels' darker ink
//      follows the theme the page wears, not the device's setting.
//   4. **Forced colours** — the open tab keeps a mark when the system paints
//      every background.
//
// Contrast for Sunlight is `npm run shell`'s, which holds all three themes to
// the same pairs; this check is about which theme is worn, and when.
//
// Run:  npm run themes
//       npm run themes -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

const worn = page => page.evaluate(() => ({
  choice: state.themeChoice,
  theme: state.theme,
  attr: document.documentElement.getAttribute('data-theme'),
  label: document.querySelector('#btn-theme .hdr-label').textContent,
  stored: localStorage.getItem('mn-theme'),
}));

async function open(browser, server, errors, { colorScheme = 'light', init = null, url = '/index.html?tab=stations' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(url), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  return { context, page };
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. System\n');
    {
      const { context, page } = await open(browser, server, errors);
      let W = await worn(page);
      check('a device that has never chosen follows its own setting: light here, and the button says System',
        W.choice === 'system' && W.theme === 'light' && W.attr === 'light' && W.label === 'System' && W.stored === null, J(W));
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 5_000 })
        .catch(() => {});
      W = await worn(page);
      check('…and follows it when the device goes dark, without a reload', W.attr === 'dark' && W.theme === 'dark' && W.choice === 'system', J(W));
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(100);
      check('…and back', (await worn(page)).attr === 'light');
      await context.close();
    }
    {
      const { context, page } = await open(browser, server, errors, { colorScheme: 'dark' });
      const W = await worn(page);
      check('a dark device opens dark', W.attr === 'dark' && W.choice === 'system', J(W));
      await context.close();
    }
    {
      const { context, page } = await open(browser, server, errors, { colorScheme: 'dark',
        init: () => { try { if (!localStorage.getItem('mn-theme')) localStorage.setItem('mn-theme', 'light'); } catch (_) {} } });
      const W = await worn(page);
      check('a light theme chosen before there were four still stands on a dark device', W.attr === 'light' && W.choice === 'light'
        && W.label === 'Light', J(W));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. The menu\n');
    {
      const { context, page } = await open(browser, server, errors);
      await page.waitForFunction(() => !!state.data && !!state.map && state.mapLines.length > 0, null, { timeout: LOAD_TIMEOUT });
      await page.click('#btn-theme');
      const menu = await page.evaluate(() => {
        const radios = [...document.querySelectorAll('#theme-pick input[type="radio"]')];
        return {
          title: (document.getElementById('app-modal-title') || {}).textContent,
          values: radios.map(r => r.value),
          checked: (radios.find(r => r.checked) || {}).value,
          focused: document.activeElement && document.activeElement.value,
          labelled: radios.every(r => !!r.closest('label') && r.closest('label').textContent.trim().length > 10),
        };
      });
      check('🌗 opens the four as radios, the current one checked and focused',
        menu.title === 'Theme' && menu.values.join() === 'system,light,dark,sunlight' && menu.checked === 'system'
          && menu.focused === 'system' && menu.labelled, J(menu));
      await page.click('#theme-pick input[value="sunlight"]');
      await page.waitForTimeout(50);
      const W = await worn(page);
      const said = await page.waitForFunction(() => document.getElementById('app-status').textContent === 'Theme: Sunlight',
        null, { timeout: 3_000 }).then(() => true, () => false);
      check('a pick applies at once, is stored, renames the button and is said', W.attr === 'sunlight' && W.theme === 'sunlight'
        && W.stored === 'sunlight' && W.label === 'Sunlight' && said, J({ W, said }));
      const stays = await page.evaluate(() => !!document.getElementById('theme-pick'));
      check('…and the dialog stays, so another can be tried', stays);
      const lines = await page.evaluate(() => {
        const core = state.mapLines.find(l => l.mnLinkRole === 'core');
        const casing = state.mapLines.find(l => l.mnLinkRole === 'casing');
        return { core: core && core.options.weight, casing: casing && casing.options.weight,
                 want: [MAP_LINK_CORE_W * 1.6, MAP_LINK_CASING_W * 1.6] };
      });
      check('Sunlight draws the radio paths heavier', Math.abs(lines.core - lines.want[0]) < 1e-9
        && Math.abs(lines.casing - lines.want[1]) < 1e-9, J(lines));
      const ink = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return { text: cs.getPropertyValue('--text').trim(), bg: cs.getPropertyValue('--bg').trim(), panel: cs.getPropertyValue('--panel').trim() };
      });
      check('…on black ink and white grounds', ink.text === '#000000' && ink.bg === '#ffffff' && ink.panel === '#ffffff', J(ink));
      await page.keyboard.press('Escape');
      await page.evaluate(() => toggleTheme());
      const T = await worn(page);
      check('toggleTheme() is the light/dark flip it always was: from a light theme, dark', T.choice === 'dark' && T.attr === 'dark', J(T));
      await page.evaluate(() => setTheme('system'));
      const lines2 = await page.evaluate(() => (state.mapLines.find(l => l.mnLinkRole === 'core') || {}).options.weight === MAP_LINK_CORE_W);
      check('back on System the lines are their usual weight again', lines2);
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. The rule that asked the device\n');
    {
      const { context, page } = await open(browser, server, errors, { colorScheme: 'dark',
        init: () => { try { if (!localStorage.getItem('mn-theme')) localStorage.setItem('mn-theme', 'light'); } catch (_) {} } });
      const ink = await page.evaluate(() => {
        const d = document.createElement('div');
        d.className = 'mn-catchment-label';
        d.innerHTML = '<span>Lockyer</span>';
        document.body.append(d);
        const read = () => getComputedStyle(d.firstChild).color;
        const light = read();
        document.documentElement.setAttribute('data-theme', 'dark');
        const dark = read();
        document.documentElement.setAttribute('data-theme', 'light');
        d.remove();
        return { light, dark };
      });
      check('on a dark device wearing the light theme, the catchment labels wear the light theme\'s ink',
        ink.light === 'rgb(28, 60, 82)', J(ink));
      check('…and the dark theme\'s when the page is dark', ink.dark === 'rgb(18, 48, 68)', J(ink));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. Forced colours\n');
    {
      const { context, page } = await open(browser, server, errors);
      await page.emulateMedia({ forcedColors: 'active' });
      const mark = await page.evaluate(() => {
        const b = document.querySelector('#tab-nav .tab-btn.active');
        const cs = b && getComputedStyle(b);
        return cs ? { style: cs.outlineStyle, width: cs.outlineWidth } : null;
      });
      check('the open tab keeps a mark of its own when the system paints every ground', mark && mark.style === 'solid'
        && parseFloat(mark.width) >= 2, J(mark));
      await context.close();
    }

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — the theme follows the device until somebody picks one, Sunlight is\n'
    + '       there for the field, and nothing asks the device behind the toggle\'s back.');
}

main().catch(err => { console.error(err); process.exit(1); });
