// The test's answer to "what happens to the network?", which #130 asks to be
// picked and documented. It is picked here, once, so every test agrees.
//
// **The page is fully offline except for Leaflet, which is served from disk.**
//
// Why: Leaflet comes from unpkg (index.html:12 and :97) and the app is
// unusable without it — half the tabs build an L.map() and every one of those
// would throw a ReferenceError that has nothing to do with the change under
// test. So `unpkg.com/leaflet@…` is fulfilled from the `leaflet` devDependency,
// which is pinned to the same 1.9.4 the page asks for. Real Leaflet, no network.
//
// Everything else off-origin is aborted: the Supabase datastore, GitHub raw,
// Overpass, the basemap tile servers. Three consequences worth stating, because
// they are the test's behaviour and not accidents:
//
//  1. autoLoad() falls through the datastore to the bundled stations.json on
//     127.0.0.1 — so the run is deterministic, uses the committed data, and
//     exercises the fallback path rather than the happy one.
//  2. Aborted subresources surface in the console as `Failed to load resource`.
//     Those are the *point* of the policy, not failures of the app, so
//     console-error filtering excludes them (see smoke.mjs). `pageerror` is
//     never filtered.
//  3. A run needs no network at all, so it behaves the same on a laptop, in
//     this sandbox, and on a CI runner.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function leafletDist() {
  // Resolved through node, so it works from any cwd and fails loudly if the
  // devDependency is missing rather than silently going to the network.
  return path.dirname(require.resolve('leaflet/dist/leaflet.js'));
}

const CONTENT_TYPE = {
  '.js':  'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Install the routing policy on a page.
 * @param page   Playwright Page
 * @param origin the loopback origin the app is served from; anything else is off-origin
 * @returns {{blocked: string[]}} every off-origin URL that was aborted
 */
export async function applyNetworkPolicy(page, origin) {
  const dist = leafletDist();
  const blocked = [];

  await page.route('**/*', async route => {
    const url = route.request().url();

    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }

    // `dist/` and everything under it — leaflet.js, leaflet.css, and the marker
    // and shadow PNGs the stylesheet pulls in relative to itself.
    const leaflet = url.match(/unpkg\.com\/leaflet@[\d.]+\/dist\/([^?#]+)/);
    if (leaflet) {
      const file = path.join(dist, path.normalize(leaflet[1]));
      if (file.startsWith(dist + path.sep) && fs.existsSync(file)) {
        return route.fulfill({
          status: 200,
          contentType: CONTENT_TYPE[path.extname(file)] || 'application/octet-stream',
          body: fs.readFileSync(file),
        });
      }
    }

    blocked.push(url);
    return route.abort('blockedbyclient');
  });

  return { blocked };
}
