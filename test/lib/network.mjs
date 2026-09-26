// The test's answer to "what happens to the network?", which #130 asks to be
// picked and documented. It is picked here, once, so every test agrees.
//
// **The page is fully offline except for Leaflet and MapLibre, both served from
// disk.**
//
// Why: Leaflet comes from unpkg (index.html:12 and :97) and the app is
// unusable without it — half the tabs build an L.map() and every one of those
// would throw a ReferenceError that has nothing to do with the change under
// test. So `unpkg.com/leaflet@…` is fulfilled from the `leaflet` devDependency,
// which is pinned to the same 1.9.4 the page asks for. Real Leaflet, no network.
//
// MapLibre is here for the same reason and on different terms. It is the 3-D
// view's renderer (map-3d.js) and it is **not** in index.html: it is fetched on
// the first press of ⛰️ and never for a session that does not press one. So
// unlike Leaflet it is absent from every check that does not open 3-D, which is
// all of them but one — and that is itself a property worth having, because it
// is the whole justification for loading it that way. `npm run map3d` asserts
// that `window.maplibregl` is undefined until the button is pressed.
//
// Served from the `maplibre-gl` devDependency, pinned to the same 5.24.0
// map-3d.js asks for. Real MapLibre, real WebGL, no network.
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
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function leafletDist() {
  // Resolved through node, so it works from any cwd and fails loudly if the
  // devDependency is missing rather than silently going to the network.
  return path.dirname(require.resolve('leaflet/dist/leaflet.js'));
}

// The same, for the 3-D renderer. Resolved lazily rather than at module load:
// every check imports this file and only one of them opens 3-D, so a harness
// without the package installed must still run the other forty.
function maplibreDist() {
  return path.dirname(require.resolve('maplibre-gl/dist/maplibre-gl.js'));
}

// And for the Digital Twin's renderer, three.js, on the same terms: fetched by
// a dynamic import() on the first visit to that tab (digital-twin.js) and
// absent from every check that does not go there. `three`'s package `main` is
// build/three.cjs, so resolving the bare name lands in build/, where the ESM
// build and the core it imports by a relative path both live.
//
// Served for the pinned version only. A module asking for any other version
// is aborted like everything else off-origin, so a pin that drifts from the
// package the harness vendors fails the twin check rather than being quietly
// answered with a different three.
function threeDist() {
  return path.dirname(require.resolve('three'));
}
function threeVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  return pkg.devDependencies.three;
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

    // `dist/` and everything under it — maplibre-gl.js and maplibre-gl.css. The
    // UMD build carries its own worker as an inline blob, so nothing else off
    // this host is asked for (blob: is allowed above).
    const maplibre = url.match(/unpkg\.com\/maplibre-gl@[\d.]+\/dist\/([^?#]+)/);
    if (maplibre) {
      let dist3d = null;
      try { dist3d = maplibreDist(); } catch (_) { dist3d = null; }
      const file = dist3d && path.join(dist3d, path.normalize(maplibre[1]));
      if (file && file.startsWith(dist3d + path.sep) && fs.existsSync(file)) {
        return route.fulfill({
          status: 200,
          contentType: CONTENT_TYPE[path.extname(file)] || 'application/octet-stream',
          body: fs.readFileSync(file),
        });
      }
    }

    // `build/` — three.module.min.js and the three.core.min.js it imports.
    // Served from the `three` devDependency, pinned to the same 0.185.1 the
    // module asks for. Real three, real WebGL, no network.
    const three = url.match(new RegExp(`unpkg\\.com/three@${threeVersion().replace(/\./g, '\\.')}/build/([^?#]+)`));
    if (three) {
      let dist3 = null;
      try { dist3 = threeDist(); } catch (_) { dist3 = null; }
      const file = dist3 && path.join(dist3, path.normalize(three[1]));
      if (file && file.startsWith(dist3 + path.sep) && fs.existsSync(file)) {
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
