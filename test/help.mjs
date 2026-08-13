// The help panel's content, on every tab (#105).
//
// #130's smoke test already asserts that every tab in `TABS` has a key in
// `HELP`, which is the check that stops the rail rendering blank. It says
// nothing about what is behind the key, and #105 filled all nineteen entries
// in — so the failure this file exists for is the one that arrives *next*: a
// help entry that decays.
//
// Three ways it decays, none of which throws, and all three of which are
// invisible to `npm run smoke` because the panel renders perfectly either way:
//
//   A doc link that 404s.  Thirteen of these were added at #105, out to `docs/`,
//                          `db/README.md` and a bundled specification PDF. A
//                          renamed file leaves the link pointing at nothing, and
//                          the panel is the last place anybody would look for
//                          the breakage. This is the load-bearing assertion here
//                          and it is a filesystem check, not a fetch: the answer
//                          "is that file in the repo" is the one that matters,
//                          and it is the same answer on GitHub Pages.
//
//   A "see also" naming a tab that no longer exists. The renderer drops it
//                          silently — `TAB_LIST.find()` returns undefined and
//                          the map contributes an empty string — so a tab
//                          renamed in `TABS` quietly loses every route into it.
//
//   A placeholder that shipped. "TODO", an empty summary, a one-line stub. The
//                          acceptance criterion on #105 is *real content on
//                          every tab*, and the only way that stays true of tab
//                          twenty is if something checks it.
//
// Plus the walkthroughs, which are the one thing in the panel that prose does
// not already carry: an inline SVG with no <title> is an empty box to a screen
// reader, and one with a fixed width overflows a 260 px rail. Both are asserted
// against the *rendered* drawing rather than against the source, because what
// the panel does with it is the question.
//
// Ten deliberate breaks were run against this before it was trusted, and all
// ten went red on the assertion they should have: a typo in a doc href, a "see
// also" naming a tab that does not exist, a TODO in a summary, an SVG with its
// <title> removed, an SVG given its own width attribute, a HELP entry left
// behind under a renamed key, a tab with no entry at all, a renamed in-app
// target, and both halves of docUrl() reverted — the fragment case and the
// space-encoding case.
//
// Run:  npm run help
//       npm run help -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 400);

// A summary shorter than this is a stub rather than an explanation. Set from
// the shortest entry #105 was willing to ship (Networks, 232 characters) with
// room underneath it, so it fails on a placeholder and not on brevity.
const MIN_SUMMARY = 140;

// Words that mean "not written yet", in the one place where shipping them is
// the failure. `esc()` is not involved — HELP is authored HTML — so a match
// here is a match in the text a reader sees.
const PLACEHOLDER = /\b(TODO|TBD|FIXME|coming soon|to be written|lorem ipsum|placeholder)\b/i;

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── The one assertion that does not need a browser ───────────────────────────
// Every `links` href that points into the repo, resolved on disk. Fetching them
// over the loopback server would prove the same thing more slowly for the HTML
// and the PDFs, and would prove nothing at all for the `.md` ones — docUrl()
// sends those to GitHub's renderer, which this harness deliberately cannot
// reach. What both cases actually rest on is the file being committed.
function docsExist(links) {
  const missing = [];
  for (const { tab, label, href } of links) {
    const file = href.split('#')[0];
    if (/^[a-z]+:/i.test(file)) continue;          // an absolute URL is somebody else's to keep
    if (!fs.existsSync(repo(file))) missing.push(`${tab}: "${label}" → ${file}`);
  }
  return missing;
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const pageErrors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(
      () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT },
    );

    // The panel ships collapsed (see the note on state.helpCollapsed), and a
    // collapsed panel has `display: none` on its body — so every measurement
    // below would come back zero. Open it once, for the whole run.
    await page.evaluate(() => setHelpCollapsed(false));

    // ── The shape of HELP itself ─────────────────────────────────────────
    const shape = await page.evaluate(() => ({
      tabs: TAB_LIST.map(t => ({ id: t.id, label: t.label })),
      help: Object.fromEntries(Object.entries(HELP).map(([id, h]) => [id, {
        summary: h.summary || '',
        watch:   h.watch   || [],
        related: h.related || [],
        links:   (h.links  || []).map(l => ({ label: l.label, href: l.href, call: l.call })),
        figure:  h.figure ? { title: h.figure.title, steps: h.figure.steps || [],
                              caption: h.figure.caption || '', svg: h.figure.svg || '' } : null,
      }])),
    }));

    const tabIds = shape.tabs.map(t => t.id);
    const helpIds = Object.keys(shape.help);

    const noEntry = tabIds.filter(id => !helpIds.includes(id));
    check('every tab has a HELP entry', noEntry.length === 0, noEntry.join(', '));

    // The other direction, which nothing else checks: an entry keyed to a tab
    // that no longer exists is content nobody can ever reach, and it reads as
    // covered when the coverage count is taken off HELP rather than off TABS.
    const orphaned = helpIds.filter(id => !tabIds.includes(id));
    check('no HELP entry for a tab that does not exist', orphaned.length === 0, orphaned.join(', '));

    for (const { id } of shape.tabs) {
      const h = shape.help[id];
      if (!h) continue;
      check(`${id}: summary is real content`,
        h.summary.length >= MIN_SUMMARY && !PLACEHOLDER.test(h.summary),
        `${h.summary.length} chars`);
      const badWatch = h.watch.filter(w => PLACEHOLDER.test(w) || w.length < 40);
      check(`${id}: no placeholder in "watch out for"`, badWatch.length === 0,
        badWatch.map(w => w.slice(0, 40)).join(' | '));
      const badRel = h.related.filter(r => !tabIds.includes(r) || r === id);
      check(`${id}: every "see also" names a real other tab`, badRel.length === 0, badRel.join(', '));
      const badLink = h.links.filter(l => !l.label || (!l.href === !l.call));
      check(`${id}: every "read more" has a label and exactly one target`,
        badLink.length === 0, badLink.map(l => l.label || '(no label)').join(', '));
    }

    // Every href in one list, checked against the filesystem in one go.
    const allLinks = shape.tabs.flatMap(({ id }) =>
      (shape.help[id]?.links || []).filter(l => l.href).map(l => ({ tab: id, ...l })));
    const missing = docsExist(allLinks);
    check(`all ${allLinks.length} doc link(s) point at a file that exists`,
      missing.length === 0, missing.join(' | '));

    // The `.md` ones go somewhere else entirely — docUrl() rewrites them to
    // GitHub's renderer, because markdown served off Pages downloads rather
    // than renders. A regression there produces a link that opens a download,
    // which is the kind of thing nobody reports.
    const mdRouting = await page.evaluate(hrefs => hrefs.map(href => ({
      href, url: docUrl(href),
    })), allLinks.map(l => l.href));
    const badMd = mdRouting.filter(({ href, url }) => /\.md(#|$)/i.test(href)
      && !/^https:\/\/github\.com\/.*\/blob\/main\//.test(url));
    check('every .md link is routed to GitHub\'s renderer', badMd.length === 0,
      badMd.map(b => b.href).join(', '));
    // And the ones that are not markdown stay on this site, with their spaces
    // encoded — a bundled specification PDF is served from the app itself.
    const badLocal = mdRouting.filter(({ href, url }) => !/\.md(#|$)/i.test(href)
      && (/^https?:/i.test(url) || / /.test(url)));
    check('every non-markdown link stays on this site, encoded', badLocal.length === 0,
      badLocal.map(b => b.url).join(', '));

    // A `call` target is audited by smoke's handler sweep only while the panel
    // is on the tab that carries it. Resolving all of them here, against the
    // same page, costs nothing and does not depend on which tab is open.
    const calls = shape.tabs.flatMap(({ id }) =>
      (shape.help[id]?.links || []).filter(l => l.call).map(l => ({ tab: id, call: l.call })));
    const badCall = await page.evaluate(cs => cs.filter(c => {
      const path = c.call.replace(/\(.*$/, '').split('.');
      let cur = window;
      for (const part of path) { cur = cur && cur[part]; }
      return typeof cur !== 'function';
    }), calls);
    check(`all ${calls.length} in-app "read more" target(s) resolve to a function`,
      badCall.length === 0, badCall.map(c => `${c.tab}: ${c.call}`).join(', '));

    // ── The panel, rendered, tab by tab ──────────────────────────────────
    const figured = [];
    for (const { id, label } of shape.tabs) {
      await page.evaluate(t => switchTab(t), id);
      await page.waitForTimeout(SETTLE / 4);

      const seen = await page.evaluate(() => {
        const body = document.querySelector('#help-panel .help-body');
        if (!body) return null;
        const svg = body.querySelector('.help-fig svg');
        const panel = document.getElementById('help-panel');
        return {
          heading: (body.querySelector('.help-tab')?.textContent || '').trim(),
          text:    (body.textContent || '').replace(/\s+/g, ' ').trim(),
          empty:   !!body.querySelector('.help-empty'),
          headings: [...body.querySelectorAll('.help-h')].map(h => h.textContent.trim()),
          svg: svg ? {
            title:   !!svg.querySelector('title')?.textContent.trim(),
            role:    svg.getAttribute('role'),
            viewBox: !!svg.getAttribute('viewBox'),
            fixed:   svg.hasAttribute('width') || svg.hasAttribute('height'),
            width:   Math.round(svg.getBoundingClientRect().width),
            height:  Math.round(svg.getBoundingClientRect().height),
            panelW:  Math.round(panel.getBoundingClientRect().width),
          } : null,
        };
      });

      if (!seen) { check(`${id}: the panel rendered`, false, 'no .help-body'); continue; }

      check(`${id}: the panel is not the "nothing written" state`, !seen.empty);
      check(`${id}: the panel is headed with the tab's own name`, seen.heading.includes(label),
        `"${seen.heading}"`);
      check(`${id}: the rendered panel carries real prose`, seen.text.length >= MIN_SUMMARY,
        `${seen.text.length} chars`);

      if (seen.svg) {
        figured.push(id);
        // A drawing is the one thing here a screen reader cannot get from the
        // prose around it, so it has to name itself.
        check(`${id}: the walkthrough names itself`, seen.svg.title && seen.svg.role === 'img',
          `title ${seen.svg.title}, role ${seen.svg.role}`);
        // The panel is 300 px, or 260 below 1400, or a phone drawer. A drawing
        // with its own width is right in exactly one of those.
        const why = !seen.svg.viewBox ? 'no viewBox'
          : seen.svg.fixed ? 'carries its own width/height attribute'
          : seen.svg.width <= 0 ? 'rendered at zero width'
          : seen.svg.width > seen.svg.panelW ? 'wider than the panel' : '';
        check(`${id}: the walkthrough scales to the rail`, !why,
          `${why ? why + ' — ' : ''}${seen.svg.width}×${seen.svg.height} `
          + `in a ${seen.svg.panelW} px panel`);
      }
    }

    // No silent coverage claim: say which tabs have a walkthrough and which do
    // not. #105 asks for one "where it clearly helps rather than applied
    // uniformly", so the small number is the intended result — but it should be
    // stated rather than inferred from a green run.
    console.log(`  · walkthrough on ${figured.length} of ${shape.tabs.length} tabs: `
      + `${figured.join(', ')}`);

    // Informational, deliberately not an assertion. "See also" is a reading
    // suggestion, and some of them are genuinely one-way — the Stations tab is
    // worth reaching from nearly everywhere and does not point back at
    // everywhere. Printed so a *missing* return route is at least visible.
    const oneWay = [];
    for (const { id } of shape.tabs) {
      for (const r of shape.help[id]?.related || []) {
        if (!(shape.help[r]?.related || []).includes(id)) oneWay.push(`${id} → ${r}`);
      }
    }
    console.log(`  · one-way "see also" link(s): ${oneWay.length ? oneWay.join(', ') : 'none'}`);

    check('no uncaught page errors while walking the panel', pageErrors.length === 0,
      pageErrors.join(' | '));

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

// A crash is not a pass. Without this flag the summary below would print PASS
// over an empty `results` — the exact shape of failure a check is supposed to
// be immune to.
let crashed = false;
await main().catch(err => {
  console.error('\nHelp-content check could not run:\n', err);
  crashed = true;
});

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
console.log('');
if (crashed) {
  console.log('FAIL — the check did not finish. Nothing above is a result.\n');
  process.exitCode = 1;
} else if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length}:\n`);
  for (const f of failed) console.log(`  ${f.name}`);
  console.log('\n  HELP is in core.js, keyed by the tab ids TABS uses. A new tab needs an entry');
  console.log('  with a real summary; a link needs a file that exists; a "see also" needs a tab');
  console.log('  that does. See the note above HELP, and #105.\n');
  process.exitCode = 1;
} else {
  console.log('PASS — every tab explains itself, and every link out of the panel lands.');
}
