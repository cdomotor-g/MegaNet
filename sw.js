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
//   Pages — network first, always. The site is behind Cloudflare Access, and
//   a page that came from the cache while the network was there would walk
//   round the gate for anybody who had signed in once; so the cache answers
//   a page only when the network cannot, after five seconds of nothing. A
//   page is never written into the cache from the network either: what the
//   network said might be Access's sign-in page, a redirect to it, or a newer
//   index.html than the scripts this version kept.
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
//   Nothing else. The datastore's other reads, the Worker's /api routes,
//   sign-in, map tiles: the network's, as if this worker were not here.
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
const LEAFLET = /^https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\//;

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
    const cache = await caches.open(SHELL);
    // All or nothing, for this version: a file that will not come takes the
    // whole copy with it, and the worker before this one carries on.
    try {
      await cache.put(INDEX, res);
      await inTurn(shellUrls(html), 6, async u => {
        const cross = !u.startsWith(SCOPE.origin);
        const r = await fetch(new Request(u, cross
          ? { mode: 'cors', credentials: 'omit', cache: 'no-cache' }
          : { credentials: 'same-origin', redirect: 'manual', cache: 'no-cache' }));
        if (!r.ok || (r.type !== 'basic' && r.type !== 'cors')) throw new Error(`${u}: ${r.status || r.type}`);
        await cache.put(u, r);
      });
    } catch (err) {
      await caches.delete(SHELL);
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

// pwa.js asks which version is keeping the shell, and how much of it.
self.addEventListener('message', event => {
  const m = event.data || {};
  if (m.type !== 'status') return;
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const keys = await cache.keys();
    event.source && event.source.postMessage({ type: 'status', version: VERSION, kept: keys.length });
  })());
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
  if (req.mode === 'navigate') { event.respondWith(page(req)); return; }
  if (isStationDoc(url) || isReference(url)) { event.respondWith(kept(req)); return; }
  if (url.origin === SCOPE.origin && !url.pathname.startsWith(new URL('api/', SCOPE).pathname)) {
    event.respondWith(shell(req));
    return;
  }
  if (LEAFLET.test(req.url)) event.respondWith(shell(req));
});

// Network first; the kept index.html only when the network cannot answer —
// an error, or nothing for PAGE_WAIT_MS.
async function page(req) {
  const network = fetch(req);
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), PAGE_WAIT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (_) { /* below */ }
  const hit = await caches.match(INDEX, { cacheName: SHELL }) || await caches.match(INDEX);
  if (hit) return hit;
  return network;                    // nothing kept: whatever the network says, late or not
}

// The shell: the kept copy, else the network — and kept, if it is one of
// ours and came back whole: a layer's data file fetched online is there
// offline. Not a file of another version (a ?v= that is not this worker's):
// while a new deploy's page loads through this worker, its files are the new
// worker's to keep. And never into a copy that has gone — a newer worker
// deletes this version's on taking over, and caches.open() would quietly
// make it again.
async function shell(req) {
  const hit = await caches.match(req, { cacheName: SHELL });
  if (hit) return hit;
  const res = await fetch(req);
  const v = new URL(req.url).searchParams.get('v');
  if (res.ok && (res.type === 'basic' || res.type === 'cors') && !res.redirected && (v === null || v === VERSION)) {
    const copy = res.clone();
    caches.has(SHELL).then(has => has && caches.open(SHELL).then(c => c.put(req, copy))).catch(() => {});
  }
  return res;
}

// Network first, a copy kept with when it was kept; with no network, the copy,
// marked as one.
async function kept(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(req);
    if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
      const body = await res.clone().arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('X-FloodNet-Kept', new Date().toISOString());
      await cache.put(req.url, new Response(body, { status: 200, headers }));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req.url);
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set(OFFLINE_HEADER, hit.headers.get('X-FloodNet-Kept') || 'unknown');
    return new Response(await hit.arrayBuffer(), { status: 200, headers });
  }
}
