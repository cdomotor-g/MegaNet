// MegaNet — sw.js
//
// The service worker (#213): Flood-Net opens with no signal on a device that
// has opened it before, with the station list it last had — said to be a
// saved copy, and how old — and the inspection and maintenance sheets ready to
// start. Not one of index.html's scripts: the browser runs it apart from any
// page, registered by pwa.js as sw.js?v=<the page's own stamp>, so every
// deploy (which bumps the stamp) is a new worker the browser installs beside
// the old one, with no build step to write a version into this file.
//
// What it keeps, and why each the way it is:
//
//   The shell — index.html and everything it loads (the scripts in their load
//   order, styles.css, the icons, the manifest, Leaflet from unpkg with its
//   SRI intact) — read off index.html as this version serves it, at install,
//   into a cache named for the version. All or nothing: a file that will not
//   come fails the install, and the worker before it carries on.
//
//   The app's page — network first, always. The site is behind Cloudflare
//   Access, and a page that came from the cache while the network was there
//   would walk round the gate for anybody who had signed in once; so the
//   cache answers the page only when the network cannot, after five seconds
//   of nothing. A page is never written into the cache from the network
//   either: what the network said might be Access's sign-in page, a redirect
//   to it, or a newer index.html than the scripts this version kept. Any
//   other address a tab is pointed at — /api/v1/…, a doc, Access's own
//   /cdn-cgi/ — is the network's alone.
//
//   A file of a version (?v=, and Leaflet, whose version is in its path) is
//   the same bytes for as long as the version lives, so the kept copy answers
//   first. Any other file of the site's — data/acma-*.json, which a monthly
//   refresh changes without a new stamp, the layers' GeoJSON — is the
//   network's whenever the network answers, exactly as if this worker were
//   not here, with the last copy kept for when it does not.
//
//   The station document — stations.json and the datastore's stations_doc —
//   network first, a copy kept on every answer with the time it was kept; with
//   no network, the copy, marked X-FloodNet-Offline: <when kept>, which the
//   loaders read (app.js) so the header says it is a saved copy and how old.
//   Never passed off as current.
//
//   The inspection and maintenance sheets' reference tables (REFERENCE below,
//   the same lists inspections.js and maintenance.js ask for — `npm run
//   offline` holds the two to each other) the same way: a sheet cannot be
//   started without them, and a draft is the point of opening with no signal.
//
//   The OCR engine — Tesseract.js, its core and its English model, from unpkg
//   (photo-meta.js) — kept the first time a page asks for each file, and
//   answered from the copy after that: the Level Survey tab reads a level's
//   display with it, and a gauging station is where the signal is not. Every
//   file's version is in its path, so a copy is right for as long as it is
//   asked for; they go in a cache of their own (floodnet-libs) that outlives a
//   deploy, because ~7 MB is not something to fetch again with every stamp.
//
//   Nothing else. The datastore's other reads, the Worker's /api routes,
//   sign-in, map tiles: the network's, as if this worker were not here.
//
//   Nothing waits on a copy being kept: the page reads the network's answer
//   as it arrives — the first load's progress (#212) counts real bytes — and
//   the copy is written beside it.
//
// The update. A new worker takes over as soon as it has its shell
// (skipWaiting, clients.claim) — the pages are network-first, so an open page
// is never swapped: only the copy kept for the next time there is no signal
// moves on. What pwa.js offers ("a newer version is ready") is for a page
// that came from the cache and finds, once it can, that the site has moved on.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL = `floodnet-shell-${VERSION}`;
const DATA = 'floodnet-data';
const OFFLINE_HEADER = 'X-FloodNet-Offline';
const PAGE_WAIT_MS = 5000;

const SCOPE = new URL(self.registration.scope);
// The page is kept, and asked for, as the scope itself — `/`, not
// `/index.html`, which Cloudflare's static assets answer with a redirect to
// `/` (auto-trailing-slash), and a redirect is never kept as the app.
const INDEX = SCOPE.href;
const APP_PAGES = new Set([SCOPE.pathname, `${SCOPE.pathname}index.html`]);
const API = new URL('api/', SCOPE).pathname;
const LEAFLET = /^https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\//;
const OCR = /^https:\/\/unpkg\.com\/(?:tesseract\.js|tesseract\.js-core|@tesseract\.js-data\/eng)@[\d.]+\//;
const LIBS = 'floodnet-libs';

const REFERENCE = new Set([
  // inspections.js — TABLES, LOOKUPS and the form itself
  'inspection_form', 'inspection_config', 'inspection_section', 'calibration_kind',
  'rain_instrument_type', 'condition_rating', 'wl_instrument_type', 'power_supply', 'yes_no',
  'data_quality_rating', 'equipment_kind',
  // maintenance.js — LOOKUPS
  'asset_owner', 'comms_method', 'comms_equipment', 'council',
]);

// index.html as the app, and not something standing in for it: Access's
// sign-in page, a redirect to it, an error page.
function isApp(res, text) {
  return !!res && res.ok && res.type === 'basic' && !res.redirected
    && /text\/html/i.test(res.headers.get('content-type') || '')
    && (text === undefined || /<script src="init\.js/.test(text));
}

// Everything index.html loads that this worker keeps.
function shellUrls(html) {
  const urls = new Set([new URL('manifest.webmanifest', SCOPE).href]);
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    const at = tag.match(/\b(?:src|href)\s*=\s*"([^"]+)"/i);
    if (!at) continue;
    if (/^<link/i.test(tag) && !/\brel\s*=\s*"(?:stylesheet|icon|apple-touch-icon|manifest)"/i.test(tag)) continue;
    const u = new URL(at[1], SCOPE);
    if (u.origin === SCOPE.origin || LEAFLET.test(u.href)) urls.add(u.href);
  }
  urls.delete(INDEX);
  return [...urls];
}

// Six at a time, each kept as it arrives. A response held unread keeps its
// connection, and the browser has six to a host: an install that fetched
// everything first and kept it after would wait for ever on the seventh.
async function inTurn(items, width, fn) {
  let next = 0;
  const lane = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const res = await fetch(INDEX, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' });
    const html = res.ok ? await res.clone().text() : '';
    if (!isApp(res, html)) throw new Error('index.html did not come back as the app — not keeping it');
    // All or nothing, for this version: a file that will not come takes the
    // copy with it, and the worker before this one carries on. The page goes
    // in last, so a copy is never a page without its files. A copy this
    // version already had — sw.js changed under the same stamp, and the
    // browser is installing it again — is left as it was: it is the one the
    // worker still running answers from.
    const had = await caches.has(SHELL);
    const cache = await caches.open(SHELL);
    try {
      await inTurn(shellUrls(html), 6, async u => {
        const cross = !u.startsWith(SCOPE.origin);
        const r = await fetch(new Request(u, cross
          ? { mode: 'cors', credentials: 'omit', cache: 'no-cache' }
          : { credentials: 'same-origin', redirect: 'manual', cache: 'no-cache' }));
        if (!r.ok || (r.type !== 'basic' && r.type !== 'cors')) throw new Error(`${u}: ${r.status || r.type}`);
        await cache.put(u, r);
      });
      await cache.put(INDEX, res);
    } catch (err) {
      if (!had) await caches.delete(SHELL);
      throw err;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('floodnet-shell-') && name !== SHELL) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// pwa.js asks a worker already in charge of the site to take a page it is not
// answering — one loaded with the worker bypassed, as a hard reload does — so
// what that page asks for next is kept.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'claim') event.waitUntil(self.clients.claim());
});

function isStationDoc(url) {
  return /\/rpc\/stations_doc$/.test(url.pathname) || /(^|\/)stations\.json$/.test(url.pathname);
}
function isReference(url) {
  const m = url.pathname.match(/\/rest\/v1\/([a-z_]+)$/);
  return !!(m && REFERENCE.has(m[1]));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // pwa.js's look at what the site serves now goes straight to it.
  if (url.searchParams.has('floodnet-fresh')) return;
  if (req.mode === 'navigate') {
    if (url.origin === SCOPE.origin && APP_PAGES.has(url.pathname)) event.respondWith(page(req));
    return;
  }
  if (isStationDoc(url) || isReference(url)) { event.respondWith(kept(event)); return; }
  if (LEAFLET.test(req.url)) { event.respondWith(versioned(event)); return; }
  if (OCR.test(req.url)) { event.respondWith(library(event)); return; }
  if (url.origin !== SCOPE.origin || url.pathname.startsWith(API) || url.pathname.startsWith('/cdn-cgi/')) return;
  event.respondWith(url.searchParams.has('v') ? versioned(event) : file(event));
});

// A response worth keeping: whole, ours or Leaflet's, and not somewhere else's
// answer (a redirect — Access's sign-in is one).
const whole = res => res.status === 200 && (res.type === 'basic' || res.type === 'cors') && !res.redirected;

// Network first; the kept index.html only when the network cannot answer —
// an error, or nothing for PAGE_WAIT_MS.
async function page(req) {
  const network = fetch(req);
  network.catch(() => {});           // answered from the copy, its failure is nobody's
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), PAGE_WAIT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (_) { /* below */ }
  const hit = await caches.match(INDEX, { cacheName: SHELL }) || await caches.match(INDEX);
  if (hit) return hit;
  return network;                    // nothing kept: whatever the network says, late or not
}

// A file of a version: the kept copy, else the network — and kept, if it is
// this worker's version. Not a file of another (a ?v= that is not this
// worker's): while a new deploy's page loads through this worker, its files
// are the new worker's to keep. And never into a copy that has gone — a newer
// worker deletes this version's on taking over, and caches.open() would
// quietly make it again.
async function versioned(event) {
  const req = event.request;
  const hit = await caches.match(req, { cacheName: SHELL });
  if (hit) return hit;
  const res = await fetch(req);
  const v = new URL(req.url).searchParams.get('v');
  if (whole(res) && (v === null || v === VERSION)) {
    const copy = res.clone();
    event.waitUntil(caches.has(SHELL).then(has => has && caches.open(SHELL).then(c => c.put(req, copy))).catch(() => {}));
  }
  return res;
}

// A library file whose version is in its path: the kept copy, else the
// network's — kept for next time.
async function library(event) {
  const req = event.request;
  const hit = await caches.match(req, { cacheName: LIBS });
  if (hit) return hit;
  const res = await fetch(req);
  if (whole(res)) {
    const copy = res.clone();
    event.waitUntil(caches.open(LIBS).then(c => c.put(req, copy)).catch(() => {}));
  }
  return res;
}

// Any other file of the site's: the network's, as if this worker were not
// here — and a copy kept, across versions, for when there is no network.
async function file(event) {
  const req = event.request;
  try {
    const res = await fetch(req);
    if (whole(res)) {
      const copy = res.clone();
      event.waitUntil(caches.open(DATA).then(c => c.put(req, copy)).catch(() => {}));
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req, { cacheName: DATA }) || await caches.match(req, { cacheName: SHELL });
    if (hit) return hit;
    throw err;
  }
}

// The station document and the sheets' tables: the network's, with a copy
// kept beside it and when it was kept; with no network, the copy, marked as
// one — the loaders put its age in the header.
async function kept(event) {
  const req = event.request;
  try {
    const res = await fetch(req);
    if (whole(res)) event.waitUntil(keepDated(req.url, res.clone()).catch(() => {}));
    return res;
  } catch (err) {
    const hit = await caches.match(req.url, { cacheName: DATA });
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set(OFFLINE_HEADER, hit.headers.get('X-FloodNet-Kept') || 'unknown');
    return new Response(await hit.arrayBuffer(), { status: 200, headers });
  }
}

// The body as it arrived, decoded — so its length is the one said, and no
// encoding is claimed for bytes that no longer carry it.
async function keepDated(url, res) {
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.set('content-length', String(body.byteLength));
  headers.set('X-FloodNet-Kept', new Date().toISOString());
  const cache = await caches.open(DATA);
  await cache.put(url, new Response(body, { status: 200, headers }));
}
