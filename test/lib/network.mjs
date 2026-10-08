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
// that the library is not imported until the button is pressed.
//
// Served from the `maplibre-gl` devDependency, pinned to the same 6.13.0
// map-3d.js asks for. Real MapLibre, real WebGL, no network.
//
// three.js (the Digital Twin), Tesseract.js (the field photos' OCR) and
// libheif-js (their HEIC decoder) are served the same way, each fetched by the
// app only when it is needed and each from the version the harness vendors —
// see beside each below.
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
// 6.x is ESM only and its `exports` map has no `main`, so the package is found
// by its package.json and `dist/` taken from there.
function maplibreDist() {
  return path.join(path.dirname(require.resolve('maplibre-gl/package.json')), 'dist');
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

// And for the field photos' OCR engine, Tesseract.js, on the same terms again:
// fetched by photo-meta.js on the first photo with no GPS in it, and absent
// from every check that does not read one. Three packages — the library and
// its worker, the WebAssembly core (it picks its own build: SIMD, relaxed SIMD
// or neither), and the English model — each served for the version the harness
// vendors and no other, so a pin that drifts fails `npm run photos` rather than
// being answered with a different engine. The worker's own fetches (its core,
// the model) are routed like the page's: Playwright intercepts a dedicated
// worker's requests too, which the photos check relies on and says so.
function tesseractDirs() {
  return {
    lib:  path.join(path.dirname(require.resolve('tesseract.js/package.json')), 'dist'),
    core: path.dirname(require.resolve('tesseract.js-core/package.json')),
    lang: path.dirname(require.resolve('@tesseract.js-data/eng/package.json')),
  };
}
// And for the field photos' HEIC decoder, libheif-js, on the same terms once
// more: fetched by field-photos.js on the first HEIC the browser cannot draw
// (Chromium draws none), from inside a worker it builds from a Blob — the glue
// by importScripts and the WebAssembly by fetch, which is cross-origin from
// there and so is answered with CORS as the OCR engine's files are. Only
// `libheif-wasm/`, the build the app asks for, and only at the version pinned.
function heifDir() {
  return path.dirname(require.resolve('libheif-js/package.json'));
}
function testPkgVersion(name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  return pkg.devDependencies[name];
}
function installedVersion(name) {
  return JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
}

const CONTENT_TYPE = {
  '.js':  'text/javascript; charset=utf-8',
  // A module is refused under any other type, so `.mjs` is named, not guessed.
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz':  'application/gzip',
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

    // `dist/` and everything under it — maplibre-gl.mjs, maplibre-gl.css, and
    // maplibre-gl-worker.mjs, which the library asks for beside itself and
    // starts through a same-origin blob: worker that imports it (map-3d.js says
    // why). The worker's own request carries a `?v=` the pattern stops before.
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
          // As unpkg answers: the module, its worker and the page's own fetch
          // of that worker (file://, map-3d.js) are all cross-origin requests.
          headers: { 'Access-Control-Allow-Origin': '*' },
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

    // The OCR engine: `dist/` of the library, the core's files, the model.
    const tess = url.match(/unpkg\.com\/(tesseract\.js|tesseract\.js-core|@tesseract\.js-data\/eng)@([\d.]+)\/([^?#]+)/);
    if (tess) {
      let dirs = null;
      try { dirs = tesseractDirs(); } catch (_) { dirs = null; }
      const [, pkg, ver, rest] = tess;
      const pinned = pkg === 'tesseract.js-core' ? installedVersion('tesseract.js-core') : testPkgVersion(pkg);
      const root = dirs && (pkg === 'tesseract.js' ? dirs.lib : pkg === 'tesseract.js-core' ? dirs.core : dirs.lang);
      const rel = pkg === 'tesseract.js' ? rest.replace(/^dist\//, '') : rest;
      const file = root && path.join(root, path.normalize(rel));
      if (ver === pinned && file && file.startsWith(root + path.sep) && fs.existsSync(file)) {
        return route.fulfill({
          status: 200,
          contentType: CONTENT_TYPE[path.extname(file)] || 'application/octet-stream',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: fs.readFileSync(file),
        });
      }
    }

    // The HEIC decoder: `libheif-wasm/libheif.js` and the `.wasm` beside it.
    const heif = url.match(/unpkg\.com\/libheif-js@([\d.]+)\/(libheif-wasm\/[^?#]+)/);
    if (heif) {
      let root = null;
      try { root = heifDir(); } catch (_) { root = null; }
      const [, ver, rest] = heif;
      const file = root && path.join(root, path.normalize(rest));
      if (ver === testPkgVersion('libheif-js') && file && file.startsWith(root + path.sep) && fs.existsSync(file)) {
        return route.fulfill({
          status: 200,
          contentType: CONTENT_TYPE[path.extname(file)] || 'application/octet-stream',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: fs.readFileSync(file),
        });
      }
    }

    blocked.push(url);
    return route.abort('blockedbyclient');
  });

  // WebSockets do not pass through page.route: a socket to any other host —
  // the digital twin's room on Supabase Realtime, say — would leave the
  // machine unseen. So every off-origin socket is closed at once, and counted
  // with the rest; a check that wants a room stands up its own fake with
  // page.routeWebSocket after this policy, which then takes precedence.
  await page.routeWebSocket(/.*/, ws => {
    const url = ws.url();
    const wsOrigin = origin.replace(/^http/, 'ws');
    if (url.startsWith(wsOrigin)) { ws.connectToServer(); return; }
    blocked.push(url);
    ws.close({ code: 1008, reason: 'off-origin' });
  });

  return { blocked };
}
