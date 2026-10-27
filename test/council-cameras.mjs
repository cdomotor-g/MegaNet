// The councils' cameras: the catalog (data/council-cameras.json, from
// tools/council_cameras.py), the Worker's /api/cameras/* that fetches their
// pictures (worker/cameras.js), and the Stations map's layer, viewer and
// station-card section (map-cameras.js).
//
// In two halves.
//
// **Under Node**, the route against stand-ins for the static assets, the edge
// cache (honouring max-age on a clock the check moves) and the cameras'
// servers. What matters, because each fails in silence if wrong: only a
// camera in the catalog is fetched, from exactly its catalog address, with
// Flood-Net's name on the request and nothing of the caller's passed on; a
// picture is a picture by its own bytes, whatever its server calls it; the
// server is asked at most once a minute whatever the callers do — a query
// string included — and once for a burst; the last good picture stands in,
// marked stale, for six hours and not after; and every answer carries CORS
// open, the age headers the viewer reads, and the document lock. Then the
// catalog itself: every camera placed in Australia, an id the route accepts,
// a council the file names, http(s) pictures and none from the hosts the tool
// leaves out, plain text, and the counts in its meta true.
//
// **In Chromium**, the real app on the real catalog, with the Worker and the
// cameras' servers stood in: on for everybody (no sign-in in this harness),
// nothing below zoom 8 and the list not even fetched; pins centred on their
// cameras and the thing under the pointer; a click opening the viewer on the
// camera's latest picture with how old it is in words; an old picture said
// to be old; the Worker refusing and the council's own address used, saying
// it cannot tell the age; two cameras on one pin, a camera with three views;
// the station card naming the camera at Thornton and nothing for a station
// with none; and switching off.
//
// Run:  npm run councilcams
//       npm run councilcams -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { handleCameras, isCameraPath, indexCatalog, sniff, FRESH_S, KEEP_S, MAX_BYTES, USER_AGENT,
         CATALOG_PATH, _test } from '../worker/cameras.js';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const J = v => JSON.stringify(v);

// A real JPEG, 64 × 40: grass, water, a grey bridge.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAoAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFooorjPKCirdlpl5qO/7JD5nl43fMBjOcdT7GrX/CM6x/z5/+RE/xp2bKUZPVIyqK1f8AhGdY/wCfP/yIn+NV7zR7/T4RLdQeWhbaDvU89ex9qOV9gcJLdFKiiikSFFR729aN7etev/Y9fuvx/wAieZHXeCf+X3/tn/7NXVV5vpWuXWkeb5CRP5uM+YCcYz0wR61of8JtqX/PC1/74b/4qtFlleKtoddOvCMUmdxXP+Mv+QRF/wBdx/6C1Y//AAm2pf8APC1/74b/AOKqnqfiO81W2WCeOFFVw4MakHOCO5PrQ8trtW0HPEQcWkZ9FR729aN7etZ/2PX7r8f8jj5kNooor6czCiiigAooooAKKKKAP//Z', 'base64');

const TEXT = fs.readFileSync(path.join(REPO, 'data/council-cameras.json'), 'utf8');
const CATALOG = JSON.parse(TEXT);
const byId = new Map(CATALOG.cameras.map(c => [c.id, c]));

// A station with no camera within 5 km, picked out of the data rather than
// named, so a council adding a camera near it cannot turn the check red.
const STATIONS = JSON.parse(fs.readFileSync(path.join(REPO, 'stations.json'), 'utf8')).stations;
function metres(a, b, c, d) {
  const R = 6371008.8, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const LONELY = STATIONS.find(s => s.lat != null && s.lon != null && /^[a-z0-9_]+$/.test(s.id)
  && CATALOG.cameras.every(c => metres(+s.lat, +s.lon, c.lat, c.lon) > 5000));

// ════════════════════════════════════════════════════════════════════════════
// Under Node: the route
// ════════════════════════════════════════════════════════════════════════════

const ORIGIN = 'https://floodwarning.net';
const assetsAsked = [];
const env = {
  ASSETS: {
    async fetch(req) {
      assetsAsked.push(new URL(req.url).pathname);
      return new Response(TEXT, { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  },
};

let T = Date.parse('2026-10-27T03:00:00Z');
const now = () => T;

// The edge cache, as Cloudflare's behaves for what this route needs: keyed on
// the URL, a copy kept for its max-age and gone after.
function edgeCache() {
  const m = new Map();
  return {
    m,
    async match(req) {
      const e = m.get(req.url);
      if (!e) return undefined;
      if (T > e.expires) { m.delete(req.url); return undefined; }
      return e.res.clone();
    },
    async put(req, res) {
      const age = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
      m.set(req.url, { res: res.clone(), expires: T + (age ? Number(age[1]) * 1000 : 0) });
    },
  };
}

const upstream = [];
let answer = () => jpeg();
const LM = 'Tue, 27 Oct 2026 02:48:00 GMT';
function jpeg(headers = {}) {
  return new Response(JPEG, { status: 200, headers: { 'Content-Type': 'binary/octet-stream', 'Last-Modified': LM, ...headers } });
}
const deps = { fetch: async (url, init) => { upstream.push({ url: String(url), init }); return answer(url, init); }, now };

let cache = edgeCache();
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };
async function get(p, { method = 'GET', headers = {}, e = env, d = { ...deps, cache } } = {}) {
  const res = await handleCameras(new Request(ORIGIN + p, { method, headers }), e, ctx, d);
  await Promise.all(pending.splice(0));
  return res;
}
async function body(res) { try { return await res.clone().json(); } catch (_) { return null; } }

{
  check('the route answers /api/cameras and below it, and nothing else',
    isCameraPath('/api/cameras') && isCameraPath('/api/cameras/x/0') && !isCameraPath('/api/camerasx') && !isCameraPath('/api/v1/cameras'));

  _test.reset();
  const r = await get('/api/cameras', { e: {} });
  check('without the assets binding it is a 503 saying so, as /api/photos says it of R2',
    r.status === 503 && (await body(r)).unbound === true, J(await body(r)));

  _test.reset();
  const s = await get('/api/cameras');
  const sb = await body(s);
  check('the summary: how many cameras, councils, when the list was made, where it is',
    s.status === 200 && sb.cameras === CATALOG.cameras.length && sb.councils === CATALOG.meta.councils
      && sb.generated === CATALOG.meta.generated && sb.catalog === CATALOG_PATH && sb.fresh_s === FRESH_S && sb.keep_s === KEEP_S, J(sb));
  check('… read through the assets binding, from the file the map draws', assetsAsked.includes(CATALOG_PATH), J(assetsAsked));
  await get('/api/cameras');
  check('… once per isolate', assetsAsked.length === 1, J(assetsAsked));

  const viaIndex = await worker.fetch(new Request(`${ORIGIN}/api/cameras`), env, ctx);
  check('worker/index.js sends /api/cameras here', viaIndex.status === 200 && (await body(viaIndex)).cameras === CATALOG.cameras.length);

  const no = await get('/api/cameras/no-such-camera');
  check('a camera the catalog does not have is a 404, and nothing is fetched',
    no.status === 404 && /no camera no-such-camera/.test((await body(no)).error) && upstream.length === 0, J(await body(no)));
  const odd = await get('/api/cameras/Lockyer%20Valley/0');
  const deep = await get('/api/cameras/lockyer-valley-825/0/1');
  check('an address that is not /api/cameras/<id>[/<n>] is a 404', odd.status === 404 && deep.status === 404);
  const tooFar = await get('/api/cameras/lockyer-valley-825/1');
  check('a view past the camera\'s last is a 404', tooFar.status === 404 && /has 1 picture/.test((await body(tooFar)).error), J(await body(tooFar)));
  const post = await get('/api/cameras/lockyer-valley-825', { method: 'POST' });
  check('GET only: a POST is a 405', post.status === 405 && /GET/.test(post.headers.get('Allow') || ''));
  const pre = await get('/api/cameras/lockyer-valley-825', { method: 'OPTIONS' });
  check('a preflight is answered, open to any origin', pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === '*');
  check('nothing above reached a camera', upstream.length === 0, J(upstream));

  // ── A picture ──────────────────────────────────────────────────────────────
  const cam = byId.get('lockyer-valley-825');
  const p1 = await get('/api/cameras/lockyer-valley-825?ignored=1');
  const ask = upstream[0] || {};
  const h = new Headers(ask.init && ask.init.headers);
  check('a picture is fetched from exactly the catalog\'s address for that camera',
    upstream.length === 1 && ask.url === cam.views[0].url, J(upstream.map(u => u.url)));
  check('… with Flood-Net\'s name on it, asking for an image, past every cache, following redirects',
    h.get('User-Agent') === USER_AGENT && /^Flood-Net /.test(USER_AGENT) && /image\//.test(h.get('Accept'))
      && ask.init.cache === 'no-store' && ask.init.redirect === 'follow', J({ ua: h.get('User-Agent'), init: ask.init }));
  check('… and nothing of the caller\'s request — no query, no headers', !/ignored/.test(ask.url) && !h.get('Cookie'));
  const bytes = new Uint8Array(await p1.clone().arrayBuffer());
  check('served as image/jpeg by its own bytes, though its server said binary/octet-stream',
    p1.status === 200 && p1.headers.get('Content-Type') === 'image/jpeg' && bytes.length === JPEG.length && bytes[0] === 0xFF);
  check('… with when its server last changed it, and when this route fetched it',
    p1.headers.get('Last-Modified') === LM && p1.headers.get('X-Camera-Fetched') === new Date(T).toISOString(),
    J({ lm: p1.headers.get('Last-Modified'), f: p1.headers.get('X-Camera-Fetched') }));
  check('… open to any origin, those headers readable by a script there',
    p1.headers.get('Access-Control-Allow-Origin') === '*'
      && /Last-Modified/.test(p1.headers.get('Access-Control-Expose-Headers'))
      && /X-Camera-Fetched/.test(p1.headers.get('Access-Control-Expose-Headers'))
      && /X-Camera-Stale/.test(p1.headers.get('Access-Control-Expose-Headers')));
  check('… never a page: nosniff and the sandbox lock, as /api/photos sends',
    p1.headers.get('X-Content-Type-Options') === 'nosniff' && /sandbox/.test(p1.headers.get('Content-Security-Policy') || ''));
  check(`… and a browser may keep it for the ${FRESH_S} s it is fresh`, p1.headers.get('Cache-Control') === `public, max-age=${FRESH_S}`,
    p1.headers.get('Cache-Control'));

  T += 20_000;
  const p2 = await get('/api/cameras/lockyer-valley-825/0');
  const p3 = await get('/api/cameras/lockyer-valley-825/0?r=12345');
  check('within the minute, from the edge cache — a cache-busting query string included — and the camera not asked',
    upstream.length === 1 && p2.status === 200 && p3.status === 200 && p3.headers.get('X-Camera-Fetched') === p1.headers.get('X-Camera-Fetched'),
    J({ upstream: upstream.length }));
  check('… the browser told how much of the minute is left', p2.headers.get('Cache-Control') === `public, max-age=${FRESH_S - 20}`,
    p2.headers.get('Cache-Control'));
  const same = await get('/api/cameras/lockyer-valley-825/0', { headers: { 'If-Modified-Since': LM } });
  check('a browser asking If-Modified-Since with the picture it has gets a 304', same.status === 304 && upstream.length === 1);
  const head = await get('/api/cameras/lockyer-valley-825/0', { method: 'HEAD' });
  check('HEAD: the headers and no body', head.status === 200 && head.headers.get('Content-Type') === 'image/jpeg'
    && (await head.arrayBuffer()).byteLength === 0);

  T += 45_000;
  const p4 = await get('/api/cameras/lockyer-valley-825/0');
  check('past the minute the camera is asked again', upstream.length === 2 && p4.headers.get('X-Camera-Fetched') === new Date(T).toISOString());

  // The camera's server goes down.
  T += 61_000;
  answer = () => { throw new TypeError('fetch failed'); };
  const st = await get('/api/cameras/lockyer-valley-825/0');
  check('a server that does not answer: the last picture, marked stale with why, kept out of the browser\'s cache',
    st.status === 200 && /could not be reached/.test(st.headers.get('X-Camera-Stale') || '')
      && st.headers.get('Cache-Control') === 'no-store' && st.headers.get('Last-Modified') === LM,
    J({ s: st.status, stale: st.headers.get('X-Camera-Stale'), cc: st.headers.get('Cache-Control') }));
  check('… saying when that picture was fetched', st.headers.get('X-Camera-Fetched') === p4.headers.get('X-Camera-Fetched'));
  check('… and every stale header plain ASCII', /^[\x20-\x7e]*$/.test(st.headers.get('X-Camera-Stale')));
  T += KEEP_S * 1000;
  const gone = await get('/api/cameras/lockyer-valley-825/0');
  check(`after ${KEEP_S / 3600} hours there is nothing to stand in: a 502 saying why`,
    gone.status === 502 && /could not be reached/.test((await body(gone)).error) && gone.headers.get('Access-Control-Allow-Origin') === '*',
    J(await body(gone)));

  // Answers that are not a picture.
  const other = '/api/cameras/lockyer-valley-824/0';
  answer = () => new Response('<html>camera offline</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const html = await get(other);
  check('a page where the picture should be is refused, naming what it was', html.status === 502
    && /not a picture \(text\/html\)/.test((await body(html)).error), J(await body(html)));
  answer = () => new Response('nope', { status: 404 });
  const nf = await get(other);
  check('a 404 from the camera\'s server is said as that', nf.status === 502 && /answered HTTP 404/.test((await body(nf)).error));
  answer = () => new Response(new Uint8Array(16), { status: 200, headers: { 'Content-Length': String(MAX_BYTES + 1) } });
  const big = await get(other);
  check(`a picture declared larger than ${MAX_BYTES / 1048576} MB is not read`, big.status === 502 && /larger than/.test((await body(big)).error));
  answer = () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1048576)); c.close(); } }), { status: 200 });
  const big2 = await get(other);
  check('… nor one that only turns out larger as it streams', big2.status === 502 && /larger than/.test((await body(big2)).error));
  answer = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const slow = await get(other);
  check('a server that does not answer in time is said as that', slow.status === 502 && /did not answer within 10 s/.test((await body(slow)).error),
    J(await body(slow)));
  check('none of those was kept', ![...cache.m.keys()].some(k => k.endsWith('/lockyer-valley-824/0')));

  // A burst.
  _test.reset();
  cache = edgeCache();
  upstream.length = 0;
  let release;
  answer = () => new Promise(r => { release = () => r(jpeg()); });
  const burst = Promise.all([1, 2, 3, 4].map(() => get('/api/cameras/lockyer-valley-814/0')));
  await new Promise(r => setTimeout(r, 20));
  release();
  const four = await burst;
  check('four callers at once: the camera asked once, and every one answered with the picture',
    upstream.length === 1 && four.every(x => x.status === 200 && x.headers.get('Content-Type') === 'image/jpeg'), J(upstream.length));
  check('… and nothing left in flight', _test.inflight() === 0);

  // The catalog's own guard.
  const idx = indexCatalog({ meta: { councils: 2 }, cameras: [
    { id: 'ok-1', views: [{ url: 'https://example.org/a.jpg' }] },
    { id: 'Bad Id', views: [{ url: 'https://example.org/b.jpg' }] },
    { id: 'no-views', views: [] },
    { id: 'not-http', views: [{ url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }] },
  ] });
  check('the route keeps a camera only with an id it accepts and an http(s) picture', idx.byId.size === 1 && idx.byId.has('ok-1'),
    J([...idx.byId.keys()]));
  check('sniff knows JPEG, PNG, GIF and WebP by their first bytes, and nothing else',
    sniff(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])) === 'image/jpeg'
      && sniff(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10])) === 'image/png'
      && sniff(new TextEncoder().encode('GIF89a')) === 'image/gif'
      && sniff(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')) === 'image/webp'
      && sniff(new TextEncoder().encode('<svg onload=alert(1)>')) === null);
}

// ════════════════════════════════════════════════════════════════════════════
// Under Node: the catalog
// ════════════════════════════════════════════════════════════════════════════

{
  const councils = new Map(CATALOG.councils.map(c => [c.key, c]));
  const bad = [];
  const ids = new Set();
  for (const c of CATALOG.cameras) {
    const why = [];
    if (!/^[a-z0-9-]{1,80}$/.test(c.id)) why.push('id');
    if (ids.has(c.id)) why.push('duplicate id');
    ids.add(c.id);
    if (!councils.has(c.council)) why.push('council');
    if (!['flood', 'road'].includes(c.kind)) why.push('kind');
    if (!(c.lat >= -44.5 && c.lat <= -9 && c.lon >= 112 && c.lon <= 154.5)) why.push('not in Australia');
    if (!c.name || /[<>]/.test(c.name) || /[<>]/.test(c.note || '')) why.push('not plain text');
    if (!Array.isArray(c.views) || !c.views.length) why.push('no views');
    for (const v of c.views || []) {
      if (!/^https?:\/\//.test(v.url)) why.push('not http(s)');
      if (/ims-s3-upload|livetraffic\.com|usee\.com|\/\/qldtraffic\.qld\.gov\.au\//.test(v.url)) why.push('a host the tool leaves out');
      if (/&amp;/.test(v.url)) why.push('an address still HTML-escaped');
    }
    for (const k of c.also || []) if (!councils.has(k) || k === c.council) why.push('also');
    if (why.length) bad.push(`${c.id}: ${why.join(', ')}`);
  }
  check('every camera: a route-safe unique id, a council the file names, flood or road, a point in Australia, plain text, http(s) pictures',
    bad.length === 0, bad.slice(0, 6).join(' | '));
  const m = CATALOG.meta;
  check('the meta counts the file', m.cameras === CATALOG.cameras.length
    && m.views === CATALOG.cameras.reduce((n, c) => n + c.views.length, 0)
    && m.flood + m.road === m.cameras
    && m.councils === CATALOG.councils.filter(c => c.cameras > 0 && !c.agency).length, J(m));
  check('hundreds of cameras from dozens of councils — not a list quietly emptied', m.cameras > 300 && m.councils > 30, J(m));
  const q = councils.get('qldtraffic');
  check('TMR\'s QLDTraffic flood cameras are in it, as an agency rather than a council',
    q && q.agency === true && q.dashboard === 'https://qldtraffic.qld.gov.au/'
      && CATALOG.cameras.filter(c => c.council === 'qldtraffic').length >= 20
      && CATALOG.cameras.filter(c => (c.also || []).includes('qldtraffic')).length >= 40, J(q));
  check('… a council\'s copy of a TMR camera QLDTraffic has is on TMR\'s own address, not the dashboard\'s copy',
    !CATALOG.cameras.some(c => (c.also || []).includes('qldtraffic') && /camera-custom-image/.test(c.views[0].url)));
  check('… and every camera QLDTraffic shows is a flood camera', CATALOG.cameras
    .filter(c => c.council === 'qldtraffic' || (c.also || []).includes('qldtraffic')).every(c => c.kind === 'flood'));
  check('every dashboard a link may point at is a web address', CATALOG.councils.every(c => /^https?:\/\/[^\s/]+/.test(c.dashboard)),
    J(CATALOG.councils.filter(c => !/^https?:\/\//.test(c.dashboard)).map(c => c.key)));
  check('no council\'s error carries a path from the machine that built it',
    !CATALOG.councils.some(c => /\/(tmp|home|root|Users)\//.test(c.error || '')));
  check('one camera to a line, so a week\'s changes read as a diff of cameras',
    TEXT.split('\n').filter(l => /^\s{4}\{"id": /.test(l)).length === CATALOG.cameras.length);
}

// ════════════════════════════════════════════════════════════════════════════
// In Chromium: the layer, the viewer and the card
// ════════════════════════════════════════════════════════════════════════════

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const asked = [];       // the Worker's camera addresses the page asked for
const direct = [];      // the cameras' own addresses asked for
const lists = [];       // fetches of the catalog
const mode = {};        // camera id → how the Worker answers it
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Last-Modified, X-Camera-Fetched, X-Camera-Stale',
};

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/\/data\/council-cameras\.json/.test(r.url())) lists.push(r.url()); });

  // The Worker: 127.0.0.1 is not one of its origins, so the page asks
  // floodwarning.net, as the github.io copy does.
  await page.route(/^https:\/\/floodwarning\.net\/api\/cameras\//, async route => {
    const u = new URL(route.request().url());
    asked.push(u.pathname + u.search);
    const id = (u.pathname.match(/^\/api\/cameras\/([^/]+)\/\d+$/) || [])[1];
    const how = mode[id] || 'ok';
    if (how === 'fail') {
      return route.fulfill({ status: 502, contentType: 'application/json', headers: CORS,
                             body: J({ error: 'the camera\'s server answered HTTP 503', camera: id }) });
    }
    const changed = new Date(Date.now() - (how === 'old' ? 5 * 3600e3 : 12 * 60e3)).toUTCString();
    const headers = { ...CORS, 'Content-Type': 'image/jpeg', 'X-Camera-Fetched': new Date().toISOString(), 'Cache-Control': 'no-store' };
    if (how !== 'nolm') headers['Last-Modified'] = changed;
    if (how === 'stale') headers['X-Camera-Stale'] = 'the camera\'s server did not answer within 10 s';
    return route.fulfill({ status: 200, headers, body: JPEG });
  });
  // A camera's own server, for the fallback.
  await page.route(/^https:\/\/www\.envault\.com\.au\//, route => {
    direct.push({ url: route.request().url(), referer: route.request().headers().referer || '' });
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG });
  });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  await page.evaluate(() => shutDock({ instant: true }));
  await page.waitForTimeout(400);

  const view = (lat, lon, z) => page.evaluate(([a, b, c]) => state.map.setView([a, b], c, { animate: false }), [lat, lon, z]);
  const note = () => page.evaluate(() => (document.getElementById('map-cameras-note') || {}).textContent || '');
  const pins = () => page.evaluate(() => [...document.querySelectorAll('.leaflet-mnCameras-pane .mn-cam-icon')].map(el => {
    const r = el.querySelector('.mn-cam-pin').getBoundingClientRect();
    return { title: el.getAttribute('title') || '', x: r.left + r.width / 2, y: r.top + r.height / 2,
             count: (el.querySelector('.mn-cam-count') || {}).textContent || '',
             kind: [...el.querySelector('.mn-cam-pin').classList].find(k => /--/.test(k)) || '' };
  }));
  const waitPins = () => page.waitForFunction(() => document.querySelectorAll('.leaflet-mnCameras-pane .mn-cam-icon').length > 0,
    null, { timeout: 15_000 });
  async function pinFor(name) {
    const all = await pins();
    return all.find(p => p.title.startsWith(name)) || null;
  }
  const modal = () => page.evaluate(() => {
    const m = document.getElementById('app-modal');
    if (!m || m.style.display === 'none') return null;
    const img = m.querySelector('.mn-cam-img');
    return {
      title: (m.querySelector('#app-modal-title') || {}).textContent || '',
      meta: (m.querySelector('.mn-cam-meta') || {}).textContent || '',
      warn: (m.querySelector('.mn-cam-warnline') || {}).textContent || '',
      wait: (m.querySelector('.mn-cam-wait') || {}).textContent || '',
      shown: !!img && !img.hidden && img.complete && img.naturalWidth === 64,
      src: img ? img.getAttribute('src') : '',
      referrer: img ? img.referrerPolicy : '',
      facts: (m.querySelector('.mn-cam-facts') || {}).textContent.replace(/\s+/g, ' ').trim(),
      dash: [...m.querySelectorAll('.mn-cam-acts a')].map(a => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() })),
      credit: (m.querySelector('.mn-cam-credit') || {}).textContent || '',
      safety: (m.querySelector('.mn-cam-safety') || {}).textContent.replace(/\s+/g, ' ') || '',
      choose: [...m.querySelectorAll('.mn-cam-choose')].map(ul => ({
        label: ul.getAttribute('aria-label'),
        items: [...ul.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') })),
      })),
      focus: document.activeElement ? (document.activeElement.dataset.camI ?? document.activeElement.dataset.camN ?? document.activeElement.tagName) : '',
    };
  });
  const waitShown = () => page.waitForFunction(() => {
    const m = document.getElementById('app-modal');
    const img = m && m.querySelector('.mn-cam-img');
    return !!img && !img.hidden && img.complete && img.naturalWidth > 0
      && m.querySelector('.mn-cam-frame').getAttribute('aria-busy') === 'false';
  }, null, { timeout: 15_000 });
  const closeModal = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };

  // ── On for everybody, and nothing far out ──────────────────────────────────
  const cold = await page.evaluate(() => ({
    on: state.mapCameras,
    signedIn: typeof FieldPhotos !== 'undefined' && FieldPhotos.signedIn(),
    label: [...document.querySelectorAll('label.filter-check')].map(l => l.textContent.replace(/\s+/g, ' ').trim())
      .find(t => /Flood & road cameras \(councils, QLDTraffic\)/.test(t)) || null,
  }));
  check('on by default, for a session with no sign-in at all', cold.on === true && cold.signedIn === false, J(cold));
  check('… its switch in Map display beside the field photos', cold.label === 'Flood & road cameras (councils, QLDTraffic)', J(cold));
  await view(-27.55, 152.12, 6);
  await page.waitForTimeout(700);
  check('at a state-wide view it says zoom in, draws nothing and has not fetched the list',
    /Zoom in \(to level 8 or closer\)/.test(await note()) && (await pins()).length === 0 && lists.length === 0,
    J({ note: await note(), lists }));

  // ── Helidon ────────────────────────────────────────────────────────────────
  await view(-27.551821, 152.121159, 14);
  await waitPins();
  const helidon = await pinFor('Lockyer Creek Crossing, Turner Street, Helidon');
  check('zoomed in, a pin for the Helidon crossing camera, named for it', !!helidon, J((await pins()).map(p => p.title)));
  check('… the list fetched once, from this origin', lists.length === 1 && lists[0].startsWith(server.origin), J(lists));
  check('… a flood camera\'s pin', helidon && helidon.kind === 'mn-cam-pin--flood', J(helidon));
  const where = await page.evaluate(() => {
    const p = state.map.latLngToContainerPoint([-27.551821, 152.121159]);
    const r = state.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  });
  check('… centred on the camera\'s point', helidon && Math.abs(helidon.x - where.x) <= 1.5 && Math.abs(helidon.y - where.y) <= 1.5,
    J({ helidon, where }));
  const under = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return !!(el && el.closest('.mn-cam-icon'));
  }, [helidon.x, helidon.y]);
  check('… and the thing under the pointer there, over the network\'s canvas', under);
  check('the legend keys both kinds while the pins are drawn', await page.evaluate(() => {
    const l = (document.getElementById('map-legend') || {}).innerHTML || '';
    return /Flood camera — a council’s or TMR’s/.test(l) && /Road camera a council shows/.test(l);
  }));
  check('the note counts the cameras in view and says they are fetched when opened, never stored',
    /flood or road cameras? in and around this view/.test(await note()) && /never stored/.test(await note()), await note());

  await page.mouse.click(helidon.x, helidon.y);
  await waitShown();
  const hv = await modal();
  check('a click opens the viewer on that camera', hv && hv.title === 'Lockyer Creek Crossing, Turner Street, Helidon', J(hv && hv.title));
  check('… on its latest picture, asked of the Worker by the camera\'s id', hv.shown && asked.includes('/api/cameras/lockyer-valley-825/0')
    && /^blob:/.test(hv.src), J({ asked, src: hv.src }));
  check('… with how old it is in words', /Updated .+ — 12 minutes ago, by the camera’s server/.test(hv.meta), hv.meta);
  check('… no warning for a picture twelve minutes old', hv.warn === '', hv.warn);
  check('… the council\'s dashboard a link away, in a new tab',
    hv.dash.some(d => d.href.startsWith('https://disaster.lvrc.qld.gov.au') && d.target === '_blank' && /noopener/.test(d.rel)
      && d.text.startsWith('Lockyer Valley’s dashboard')), J(hv.dash));
  check('… the nearest Flood-Net station named, and how far', /Nearest station Helidon (AL|TM) .*1\.17 km away/.test(hv.facts), hv.facts);
  check('… whose picture it is, and that Flood-Net keeps no copy',
    /from Lockyer Valley Regional Council’s disaster dashboard/.test(hv.credit) && /keeps no copy/.test(hv.credit), hv.credit);
  check('… and that a picture is one moment — if it’s flooded, forget it', /If it’s flooded, forget it/.test(hv.safety), hv.safety);
  await page.evaluate(() => MapCameras.again());
  await waitShown();
  check('Fetch again asks again, past the browser\'s cache', asked.some(a => /^\/api\/cameras\/lockyer-valley-825\/0\?r=\d+$/.test(a)), J(asked));
  await closeModal();
  check('Escape closes it', !(await modal()));

  // ── An old picture, at a gauge ─────────────────────────────────────────────
  mode['lockyer-valley-814'] = 'old';
  await view(-27.7983, 152.372773, 15);
  await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-mnCameras-pane .mn-cam-icon')]
    .some(el => /^Laidley Creek, Clarks Bridge/.test(el.getAttribute('title') || '')), null, { timeout: 15_000 });
  const clarks = await pinFor('Laidley Creek, Clarks Bridge');
  await page.mouse.click(clarks.x, clarks.y);
  await waitShown();
  const ov = await modal();
  check('a picture five hours old is said to be, in the warning line', /This picture is 5 hours old — the camera may be offline/.test(ov.warn), ov.warn);
  check('… and the station it stands at named as that', /At station Thornton \(School Rd\) AL \(540789\) — 3 m away/.test(ov.facts), ov.facts);
  await closeModal();

  // ── No Last-Modified; stale ────────────────────────────────────────────────
  mode['lockyer-valley-813'] = 'nolm';
  await page.evaluate(() => MapCameras.openId('lockyer-valley-813'));
  await waitShown();
  const nl = await modal();
  check('a server that does not say when: the viewer says to read the time printed on it',
    /does not say when this picture was taken — read the time printed on it/.test(nl.meta), nl.meta);
  await closeModal();
  mode['lockyer-valley-816'] = 'stale';
  await page.evaluate(() => MapCameras.openId('lockyer-valley-816'));
  await waitShown();
  const sv = await modal();
  check('a stale stand-in is said to be the last picture fetched, and why',
    /could not reach the camera just now \(the camera's server did not answer within 10 s\), so this is the last picture it fetched/.test(sv.meta), sv.meta);
  await closeModal();

  // ── The Worker refuses: the camera's own address ───────────────────────────
  mode['lockyer-valley-824'] = 'fail';
  await page.evaluate(() => MapCameras.openId('lockyer-valley-824'));
  await waitShown();
  const fv = await modal();
  const want = byId.get('lockyer-valley-824').views[0].url;
  check('the Worker refusing: the picture from the camera\'s own address instead',
    fv.shown && fv.src === want && direct.some(d => d.url === want), J({ src: fv.src, direct }));
  check('… sent with no referrer', fv.referrer === 'no-referrer' && direct.every(d => !d.referer), J(direct));
  check('… saying it cannot tell how old that is, and why the Worker could not',
    /Straight from the camera’s server: Flood-Net could not fetch it \(the camera's server answered HTTP 503\), so it cannot say how old/.test(fv.meta), fv.meta);
  await closeModal();

  // ── Two cameras on one pin ─────────────────────────────────────────────────
  await view(-27.52248, 152.409344, 15);
  await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-mnCameras-pane .mn-cam-count')]
    .some(b => b.textContent === '2'), null, { timeout: 15_000 });
  const pair = (await pins()).find(p => p.count === '2');
  check('two cameras on one post are one pin with a 2 on it', !!pair && /^2 cameras here/.test(pair.title), J(pair));
  await page.mouse.click(pair.x, pair.y);
  await waitShown();
  const p1v = await modal();
  check('… which opens both, the first shown', p1v.choose.length === 1 && p1v.choose[0].items.length === 2
    && p1v.choose[0].items[0].pressed === 'true' && p1v.choose[0].items[1].pressed === 'false', J(p1v.choose));
  await page.click('#app-modal [data-cam-i="1"]');
  await waitShown();
  const p2v = await modal();
  check('… the second pressed: its picture, its name for a title, the focus kept on the button',
    p2v.title === byId.get('lockyer-valley-832').name && asked.includes('/api/cameras/lockyer-valley-832/0') && p2v.focus === '1'
      && p2v.choose[0].items[1].pressed === 'true', J({ title: p2v.title, focus: p2v.focus }));
  await closeModal();

  // ── A camera that looks three ways ─────────────────────────────────────────
  const three = CATALOG.cameras.find(c => c.views.length === 3 && c.views.every(v => v.label));
  await page.evaluate(id => MapCameras.openId(id), three.id);
  await waitShown();
  const tv = await modal();
  const ways = tv.choose.find(c => c.label === 'Which way it looks');
  check('a camera with three views offers all three by the names its council gave them',
    ways && J(ways.items.map(i => i.text)) === J(three.views.map(v => v.label)), J(tv.choose));
  check('… the first pressed', ways && J(ways.items.map(i => i.pressed)) === J(['true', 'false', 'false']), J(ways && ways.items));
  await page.click('#app-modal [data-cam-n="2"]');
  await waitShown();
  const tv2 = await modal();
  const ways2 = tv2.choose.find(c => c.label === 'Which way it looks');
  check('… and the third asked for by its number, pressed, the focus on it',
    asked.includes(`/api/cameras/${three.id}/2`) && ways2 && J(ways2.items.map(i => i.pressed)) === J(['false', 'false', 'true'])
      && tv2.focus === '2', J({ asked: asked.slice(-3), ways2, focus: tv2.focus }));
  await closeModal();

  // ── A crossing only QLDTraffic shows ───────────────────────────────────────
  const tmrOnly = CATALOG.cameras.find(c => c.council === 'qldtraffic' && !c.also);
  await page.evaluate(id => MapCameras.openId(id), tmrOnly.id);
  await waitShown();
  const qv = await modal();
  check('a TMR flood camera no council shows: from QLDTraffic, its site a link away, TMR named once',
    /^Picture: from QLDTraffic \(Transport and Main Roads\)\./.test(qv.credit) && /Shown by\s*QLDTraffic \(Transport and Main Roads\)/.test(qv.facts)
      && qv.dash.some(d => d.href === 'https://qldtraffic.qld.gov.au/' && d.text.startsWith('QLDTraffic')), J({ credit: qv.credit, dash: qv.dash }));
  await closeModal();

  // ── The station card ───────────────────────────────────────────────────────
  await page.evaluate(() => goToStation('thornton_school_roa'));
  await page.waitForFunction(() => {
    const el = document.getElementById('mn-cams-card-thornton_school_roa');
    return el && el.querySelector('.stn-card-cams');
  }, null, { timeout: 15_000 });
  const card = await page.evaluate(() => {
    const el = document.getElementById('mn-cams-card-thornton_school_roa');
    return {
      head: el.querySelector('.stn-card-rhs-head').textContent.trim(),
      items: [...el.querySelectorAll('li')].map(li => ({ cam: li.querySelector('button').dataset.cam, text: li.textContent.replace(/\s+/g, ' ').trim() })),
    };
  });
  check('the Thornton gauge\'s card names the council camera on its bridge, at this station',
    /^Flood & road cameras at/.test(card.head) && card.items[0] && card.items[0].cam === 'lockyer-valley-814'
      && /At this station · flood camera · Lockyer Valley Regional Council/.test(card.items[0].text), J(card));
  await page.click('#mn-cams-card-thornton_school_roa button[data-cam="lockyer-valley-814"]');
  await waitShown();
  check('… and its button opens that camera', (await modal()).title === byId.get('lockyer-valley-814').name);
  await closeModal();
  await page.evaluate(id => goToStation(id), LONELY.id);
  await page.waitForTimeout(800);
  const none = await page.evaluate(id => {
    const el = document.getElementById(`mn-cams-card-${id}`);
    return el ? { html: el.innerHTML, display: getComputedStyle(el).display } : null;
  }, LONELY.id);
  check(`a station with no camera near it (${LONELY.name}) has no section at all`,
    none && none.html === '' && none.display === 'none', J(none));

  // ── Off ────────────────────────────────────────────────────────────────────
  await view(-27.551821, 152.121159, 14);
  await waitPins();
  await page.evaluate(() => MapCameras.setEnabled(false));
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => ({
    pins: document.querySelectorAll('.leaflet-mnCameras-pane .mn-cam-icon').length,
    legend: (document.getElementById('map-legend') || {}).innerHTML || '',
    stored: localStorage.getItem('mn-council-cameras'),
  }));
  check('switched off: no pins, the legend saying where to turn them on, remembered',
    off.pins === 0 && /Also available[^<]*Flood &amp; road cameras/.test(off.legend) && off.stored === 'off', J({ ...off, legend: off.legend.length }));
  await page.evaluate(() => MapCameras.setEnabled(true));
  await waitPins();
  check('on again: the pins back from the list already read', (await pins()).length > 0 && lists.length === 1, J(lists));

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 300)}` : ''}`);
  process.exit(1);
}
console.log('PASS — every council camera placed, its latest picture fetched by its id alone and said how old, once a minute at most.');
