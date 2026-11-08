// The trees and buildings in the 3-D view (#278) and the digital twin (#280):
// worker/canopy.js's /api/canopy/<quadkey>.tif and worker/ground.js's
// /api/ground/* — offline, Meta's bucket a stand-in on fetch, R2 a Map, the
// project's answers a stand-in — and ground-cover.js's own readers: the tree
// finder, and the buildings' vector tiles read into outlines, each tile the
// State's or Overture's and never both.
//
// What matters, because each fails open and in silence if wrong: the canopy
// route fetches exactly one fixed folder, with nothing of the caller's but a
// single byte range, and passes Meta's answer back readable cross-site; the
// ground route serves a tile nobody wrote as 204 (MapLibre's empty tile), and
// only the project's secret key writes — never an editor, never nobody — with
// what is written being what is read back, inside its size limit. No key in
// any answer or log line.
//
// Run:  npm run groundcover

import worker from '../worker/index.js';
import { handleCanopy, isCanopyPath, canopyQuadkey, canopyRange, UPSTREAM, USER_AGENT, CACHE } from '../worker/canopy.js';
import { handleGround, isGroundPath, groundTarget, MAX_TILE_BYTES, MAX_META_BYTES, TILE_CACHE } from '../worker/ground.js';
import { mvtTile, square } from './lib/vector-tiles.mjs';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });
const J = v => JSON.stringify(v);

const ORIGIN = 'https://floodwarning.net';
const SECRET = 'sb_secret_ground_test_key';

// Every log line, to show the key is in none of them.
const logged = [];
for (const name of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[name].bind(console);
  console[name] = (...a) => { logged.push(a.map(String).join(' ')); orig(...a); };
}

// ── Meta's bucket, stood in for ──────────────────────────────────────────────

const FILE = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
const QK = '3112130013';
const META_HEADERS = { ETag: '"417ba7334e4854c99971b63061ec7217-29"', 'Last-Modified': 'Wed, 28 Jan 2026 08:07:03 GMT',
                       'Accept-Ranges': 'bytes', 'Content-Type': 'binary/octet-stream' };
let asked = [];
let meta = 'ok';     // 'ok' | '404' | '403' | '500' | 'down' | 'slow' | '416'

async function s3(url, init = {}) {
  const h = new Headers(init.headers || {});
  asked.push({ url: String(url), method: init.method || 'GET', headers: Object.fromEntries(h), redirect: init.redirect, cache: init.cache });
  if (meta === 'down') throw new TypeError('fetch failed');
  if (meta === 'slow') {
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  }
  if (meta === '403' || meta === '500') return new Response('<Error/>', { status: Number(meta) });
  if (meta === '404' || !String(url).endsWith(`/${QK}.tif`)) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'Content-Type': 'application/xml' } });
  const range = h.get('Range');
  if (range) {
    const [a, b] = range.slice(6).split('-').map(Number);
    if (meta === '416' || a >= FILE.length) {
      return new Response('<Error><Code>InvalidRange</Code></Error>', { status: 416, headers: { 'Content-Type': 'application/xml', 'Content-Range': `bytes */${FILE.length}` } });
    }
    const last = Math.min(b, FILE.length - 1);
    const part = FILE.slice(a, last + 1);
    return new Response(init.method === 'HEAD' ? null : part, { status: 206, headers: { ...META_HEADERS,
      'Content-Length': String(part.length), 'Content-Range': `bytes ${a}-${last}/${FILE.length}` } });
  }
  return new Response(init.method === 'HEAD' ? null : FILE, { status: 200, headers: { ...META_HEADERS, 'Content-Length': String(FILE.length) } });
}

const canopy = (path, { method = 'GET', headers = {} } = {}, deps = {}) =>
  handleCanopy(new Request(`${ORIGIN}${path}`, { method, headers }), {}, {}, { fetch: s3, ...deps });

// ── Canopy: which addresses ──────────────────────────────────────────────────

check('canopy: its paths and not its neighbours\'',
  isCanopyPath('/api/canopy') && isCanopyPath(`/api/canopy/${QK}.tif`) && !isCanopyPath('/api/canopyx') && !isCanopyPath('/api/cameras'));
check('canopy: a 10-digit quadkey of 0-3 is a file', canopyQuadkey(`/api/canopy/${QK}.tif`) === QK && canopyQuadkey('/api/canopy/0000000000.tif') === '0000000000');
const BAD_PATHS = ['/api/canopy', '/api/canopy/', '/api/canopy/311213001.tif', '/api/canopy/31121300130.tif',
  '/api/canopy/3112130014.tif', '/api/canopy/311213001a.tif', '/api/canopy/3112130013.TIF', '/api/canopy/3112130013',
  '/api/canopy/3112130013.tif/', '/api/canopy/3112130013.tiff', '/api/canopy/%333112130013.tif',
  '/api/canopy/../3112130013.tif', '/api/canopy/x/3112130013.tif', '/api/canopy/3112130013.tif.ovr'];
check('canopy: nothing else is', BAD_PATHS.every(p => canopyQuadkey(p) === null), J(BAD_PATHS.filter(p => canopyQuadkey(p) !== null)));
{
  asked = [];
  const rs = await Promise.all(BAD_PATHS.map(p => canopy(p)));
  check('canopy: every other address under /api/canopy is a 400, and Meta is not asked',
    rs.every(r => r.status === 400) && asked.length === 0, J(rs.map(r => r.status)));
}

check('canopy: a single bytes=a-b range is passed on', canopyRange('bytes=0-1023') === 'bytes=0-1023'
  && canopyRange(' bytes=16-16 ') === 'bytes=16-16' && canopyRange(null) === null);
const BAD_RANGES = ['bytes=0-', 'bytes=-500', 'bytes=0-1,5-9', 'bytes=9-1', 'items=0-1', 'bytes=0-1 x', 'bytes =0-1',
  'bytes=1234567890123456-1234567890123457', 'bytes=0x10-0x20', 'bytes=1.5-2', ''];
check('canopy: no other Range is', BAD_RANGES.every(r => canopyRange(r) === false), J(BAD_RANGES.filter(r => canopyRange(r) !== false)));
{
  asked = [];
  const rs = await Promise.all(BAD_RANGES.map(r => canopy(`/api/canopy/${QK}.tif`, { headers: { Range: r } })));
  check('canopy: any other Range is a 400, and Meta is not asked',
    rs.every(r => r.status === 400) && asked.length === 0, J(rs.map(r => r.status)));
}

// ── Canopy: the pass-through ─────────────────────────────────────────────────

{
  asked = [];
  meta = 'ok';
  const r = await canopy(`/api/canopy/${QK}.tif?x=1&url=https://example.com/`, {
    headers: { Range: 'bytes=100-1123', Authorization: `Bearer ${SECRET}`, Cookie: 'CF_Authorization=abc',
               'X-Forwarded-For': '10.0.0.1', 'If-None-Match': '"x"', Origin: 'https://floodwarning.net' },
  });
  const body = new Uint8Array(await r.arrayBuffer());
  const a = asked[0] || {};
  check('canopy: Meta is asked once, at exactly the fixed folder and the quadkey — no query string',
    asked.length === 1 && a.url === `${UPSTREAM}${QK}.tif`
      && a.url === `https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm/${QK}.tif`, J(asked));
  check('canopy: with the Range and Flood-Net\'s User-Agent, and nothing else of the caller\'s',
    J(Object.keys(a.headers || {}).sort()) === J(['range', 'user-agent']) && a.headers.range === 'bytes=100-1123'
      && a.headers['user-agent'] === USER_AGENT, J(a.headers));
  check('canopy: GET upstream, no redirect followed, no cache in between',
    a.method === 'GET' && a.redirect === 'manual' && a.cache === 'no-store', J(a));
  check('canopy: 206 with the bytes Meta sent',
    r.status === 206 && body.length === 1024 && body.every((v, i) => v === FILE[100 + i]), `${r.status} ${body.length}`);
  const h = k => r.headers.get(k);
  check('canopy: Content-Length, Content-Range, Accept-Ranges, ETag and Last-Modified passed back',
    h('Content-Length') === '1024' && h('Content-Range') === `bytes 100-1123/${FILE.length}` && h('Accept-Ranges') === 'bytes'
      && h('ETag') === META_HEADERS.ETag && h('Last-Modified') === META_HEADERS['Last-Modified'], J(Object.fromEntries(r.headers)));
  check('canopy: as image/tiff, kept a week, readable cross-site with the range headers exposed',
    h('Content-Type') === 'image/tiff' && h('Cache-Control') === CACHE && CACHE === 'public, max-age=604800'
      && h('Access-Control-Allow-Origin') === '*' && h('Access-Control-Expose-Headers') === 'Content-Range, Content-Length, ETag');
  check('canopy: never a page — nosniff and the sandbox lock',
    h('X-Content-Type-Options') === 'nosniff' && /sandbox/.test(h('Content-Security-Policy') || ''));
  check('canopy: nothing Meta sent beyond those (no x-amz-*, no Set-Cookie)',
    [...r.headers.keys()].every(k => !k.startsWith('x-amz') && k !== 'set-cookie'));
}
{
  asked = [];
  const r = await canopy(`/api/canopy/${QK}.tif`);
  const body = new Uint8Array(await r.arrayBuffer());
  check('canopy: no Range, the whole file, 200, and no Range asked of Meta',
    r.status === 200 && body.length === FILE.length && !('range' in asked[0].headers) && r.headers.get('Content-Length') === String(FILE.length));
}
{
  asked = [];
  const r = await canopy(`/api/canopy/${QK}.tif`, { method: 'HEAD' });
  check('canopy: HEAD asks Meta with HEAD and answers with the size and no body',
    asked[0].method === 'HEAD' && r.status === 200 && r.headers.get('Content-Length') === String(FILE.length)
      && (await r.arrayBuffer()).byteLength === 0 && r.headers.get('Access-Control-Allow-Origin') === '*');
}
{
  const r = await canopy(`/api/canopy/${QK}.tif`, { headers: { Range: 'bytes=999999-1000000' } });
  check('canopy: a range past the end is 416, with Meta\'s Content-Range and CORS',
    r.status === 416 && r.headers.get('Content-Range') === `bytes */${FILE.length}` && r.headers.get('Access-Control-Allow-Origin') === '*'
      && r.headers.get('Cache-Control') === 'no-store', J(Object.fromEntries(r.headers)));
}
{
  meta = '404';
  const r = await canopy(`/api/canopy/0000000000.tif`);
  const b = await r.json();
  check('canopy: no file there (open sea) is a 404, said in words, readable cross-site',
    r.status === 404 && /open sea/.test(b.error) && b.quadkey === '0000000000' && r.headers.get('Access-Control-Allow-Origin') === '*', J(b));
  for (const m of ['403', '500']) {
    meta = m;
    const e = await canopy(`/api/canopy/${QK}.tif`);
    check(`canopy: Meta answering ${m} is a 502 saying so`, e.status === 502 && new RegExp(`HTTP ${m}`).test((await e.json()).error));
  }
  meta = 'down';
  const d = await canopy(`/api/canopy/${QK}.tif`);
  check('canopy: Meta unreachable is a 502 saying so', d.status === 502 && /could not be reached/.test((await d.json()).error));
  meta = 'slow';
  const s = await canopy(`/api/canopy/${QK}.tif`, {}, { timeoutMs: 50 });
  check('canopy: Meta not answering in time is a 502 saying so', s.status === 502 && /did not answer within/.test((await s.json()).error));
  meta = 'ok';
}
{
  asked = [];
  const rs = await Promise.all(['POST', 'PUT', 'DELETE', 'PATCH'].map(m => canopy(`/api/canopy/${QK}.tif`, { method: m })));
  check('canopy: GET and HEAD only — anything else is a 405, and Meta is not asked',
    rs.every(r => r.status === 405 && /GET, HEAD/.test(r.headers.get('Allow') || '')) && asked.length === 0, J(rs.map(r => r.status)));
  const o = await canopy(`/api/canopy/${QK}.tif`, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Headers': 'range' } });
  check('canopy: the preflight allows GET and HEAD with a Range header',
    o.status === 204 && /GET/.test(o.headers.get('Access-Control-Allow-Methods')) && /HEAD/.test(o.headers.get('Access-Control-Allow-Methods'))
      && !/PUT|POST|DELETE/.test(o.headers.get('Access-Control-Allow-Methods')) && /^range$/i.test(o.headers.get('Access-Control-Allow-Headers'))
      && o.headers.get('Access-Control-Allow-Origin') === '*' && asked.length === 0);
}

// ── R2 and the project, stood in for ─────────────────────────────────────────

function bucket() {
  const m = new Map();
  let n = 0;
  const meta = (k, v) => ({ key: k, size: v.bytes.length, httpEtag: `"${v.etag}"`, etag: v.etag, httpMetadata: v.httpMetadata, customMetadata: {} });
  return {
    m,
    calls: [],
    async head(k) { this.calls.push(['head', k]); const v = m.get(k); return v ? meta(k, v) : null; },
    async get(k) { this.calls.push(['get', k]); const v = m.get(k); return v ? { ...meta(k, v), body: new Blob([v.bytes]).stream() } : null; },
    async put(k, body, opts = {}) {
      this.calls.push(['put', k]);
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      m.set(k, { bytes: bytes.slice(), httpMetadata: opts.httpMetadata || {}, etag: `e${++n}` });
      return meta(k, m.get(k));
    },
    async delete(k) { this.calls.push(['delete', k]); m.delete(k); },
  };
}

// The auth admin API answers the secret key; is_editor answers `editor-token`,
// is_member `member-token`. Meta's bucket answers as above. Nothing else.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(UPSTREAM)) return s3(url, init);
  const auth = new Headers(init.headers || {}).get('Authorization') || '';
  if (u.includes('/auth/v1/admin/users')) return new Response('{}', { status: auth === `Bearer ${SECRET}` ? 200 : 401 });
  if (u.endsWith('/rest/v1/rpc/is_editor')) return new Response(auth === 'Bearer editor-token' ? 'true' : 'false', { status: 200 });
  if (u.endsWith('/rest/v1/rpc/is_member')) return new Response(auth === 'Bearer member-token' ? 'true' : 'false', { status: 200 });
  return new Response('not here', { status: 404 });
};

const TILE = '/api/ground/qld-buildings/14/15138/9478.pbf';
const TILE_KEY = '_ground/qld-buildings/14/15138/9478.pbf';
const META = '/api/ground/qld-buildings/meta.json';
const META_KEY = '_ground/qld-buildings/meta.json';
// A Mapbox Vector Tile: field 3 (layers), length-delimited, then the layer.
const tileBytes = (n = 64) => { const b = new Uint8Array(n).fill(0x08); b[0] = 0x1a; b[1] = Math.min(n - 2, 127); return b; };
const gzipped = new Uint8Array(await new Response(new Blob([tileBytes()]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

function ground(env, method, path, { token, body, headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set('Authorization', `Bearer ${token}`);
  const init = { method, headers: h };
  if (body !== undefined) { init.body = body; if (body instanceof ReadableStream) init.duplex = 'half'; }
  return handleGround(new Request(`${ORIGIN}${path}`, init), env);
}

// ── Ground: which addresses ──────────────────────────────────────────────────

check('ground: its paths and not its neighbours\'',
  isGroundPath('/api/ground') && isGroundPath(TILE) && !isGroundPath('/api/groundx') && !isGroundPath('/api/photos/x'));
check('ground: a tile of an allowed layer is an object under _ground/',
  groundTarget(TILE)?.key === TILE_KEY && groundTarget(TILE)?.kind === 'tile'
    && groundTarget('/api/ground/qld-buildings/0/0/0.pbf')?.key === '_ground/qld-buildings/0/0/0.pbf'
    && groundTarget('/api/ground/qld-buildings/18/262143/262143.pbf')?.kind === 'tile', J(groundTarget(TILE)));
check('ground: and its meta.json', groundTarget(META)?.key === META_KEY && groundTarget(META)?.kind === 'meta');
const BAD_GROUND = ['/api/ground', '/api/ground/', '/api/ground/qld-buildings', '/api/ground/qld-buildings/',
  '/api/ground/nsw-buildings/14/15138/9478.pbf', '/api/ground/QLD-buildings/14/15138/9478.pbf', '/api/ground/nsw-buildings/meta.json',
  '/api/ground/qld-buildings/19/0/0.pbf', '/api/ground/qld-buildings/1/2/0.pbf', '/api/ground/qld-buildings/1/0/2.pbf',
  '/api/ground/qld-buildings/14/015138/9478.pbf', '/api/ground/qld-buildings/14/-1/9478.pbf', '/api/ground/qld-buildings/14/15138/9478.mvt',
  '/api/ground/qld-buildings/14/15138/9478.pbf/x', '/api/ground/qld-buildings/../meta.json', '/api/ground/qld-buildings/%2e%2e/meta.json',
  '/api/ground/qld-buildings/14/15138.5/9478.pbf', '/api/ground/qld-buildings/x/meta.json', '/api/ground/_meganet/url-signing-key'];
check('ground: nothing else is', BAD_GROUND.every(p => groundTarget(p) === null), J(BAD_GROUND.filter(p => groundTarget(p) !== null)));
{
  const env = { PHOTOS: bucket() };
  const rs = [];
  for (const p of BAD_GROUND) for (const m of ['GET', 'PUT']) rs.push(await ground(env, m, p, { token: SECRET, body: m === 'PUT' ? tileBytes() : undefined }));
  check('ground: every other address is a 404 to GET and PUT, and the bucket is not touched',
    rs.every(r => r.status === 404) && env.PHOTOS.calls.length === 0, J(rs.map(r => r.status)));
}

// ── Ground: reading ──────────────────────────────────────────────────────────

{
  const env = { PHOTOS: bucket() };
  const r = await ground(env, 'GET', TILE);
  check('ground: a tile nobody wrote is 204 No Content, readable cross-site, with no body',
    r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === '*' && (await r.arrayBuffer()).byteLength === 0
      && /public/.test(r.headers.get('Cache-Control') || ''), J(Object.fromEntries(r.headers)));
  check('ground: and to HEAD', (await ground(env, 'HEAD', TILE)).status === 204);
  const mr = await ground(env, 'GET', META);
  check('ground: meta.json before the layer is built is a 404 saying so',
    mr.status === 404 && /not been built/.test((await mr.json()).error) && mr.headers.get('Access-Control-Allow-Origin') === '*');
  check('ground: unbound, it says so', (await ground({}, 'GET', TILE)).status === 503);
  const o = await ground(env, 'OPTIONS', TILE);
  check('ground: the preflight allows reading only', o.status === 204 && !/PUT/.test(o.headers.get('Access-Control-Allow-Methods')));
  const rs = await Promise.all(['DELETE', 'POST', 'PATCH'].map(m => ground(env, m, TILE, { token: SECRET })));
  check('ground: no DELETE, POST or PATCH', rs.every(x => x.status === 405) && !env.PHOTOS.calls.some(c => c[0] === 'delete'), J(rs.map(x => x.status)));
}

// ── Ground: writing ──────────────────────────────────────────────────────────

{
  const env = { PHOTOS: bucket() };
  const put = (token, body = tileBytes(), path = TILE, headers) => ground(env, 'PUT', path, { token, body, headers });
  check('ground: no key, no write', (await put(undefined)).status === 401 && !env.PHOTOS.m.size);
  check('ground: an editor may not write either', (await put('editor-token')).status === 401 && !env.PHOTOS.m.size);
  check('ground: nor a member, nor a wrong key', (await put('member-token')).status === 401 && (await put('sb_secret_wrong')).status === 401 && !env.PHOTOS.m.size);

  const t1 = tileBytes(200);
  const w = await put(SECRET, t1);
  const wb = await w.json();
  const kept = env.PHOTOS.m.get(TILE_KEY);
  check('ground: the secret key writes a tile, at _ground/<layer>/<z>/<x>/<y>.pbf, as application/x-protobuf',
    w.status === 200 && wb.key === TILE_KEY && wb.size === 200 && kept && kept.httpMetadata.contentType === 'application/x-protobuf'
      && !kept.httpMetadata.contentEncoding, J(wb));
  const g = await ground(env, 'GET', TILE);
  const gb = new Uint8Array(await g.arrayBuffer());
  check('ground: read back byte for byte, application/x-protobuf, kept a day, readable cross-site, with its ETag',
    g.status === 200 && gb.length === t1.length && gb.every((v, i) => v === t1[i]) && g.headers.get('Content-Type') === 'application/x-protobuf'
      && g.headers.get('Cache-Control') === TILE_CACHE && TILE_CACHE === 'public, max-age=86400'
      && g.headers.get('Access-Control-Allow-Origin') === '*' && g.headers.get('ETag') === '"e1"' && g.headers.get('Content-Length') === '200',
    J(Object.fromEntries(g.headers)));
  const hd = await ground(env, 'HEAD', TILE);
  check('ground: HEAD, the size and no body', hd.status === 200 && hd.headers.get('Content-Length') === '200' && (await hd.arrayBuffer()).byteLength === 0);

  const t2 = tileBytes(90);
  await put(SECRET, t2);
  const g2 = new Uint8Array(await (await ground(env, 'GET', TILE)).arrayBuffer());
  check('ground: a PUT replaces what was there', g2.length === 90 && g2.every((v, i) => v === t2[i]));

  const GZ = '/api/ground/qld-buildings/14/15139/9478.pbf';
  const wz = await put(SECRET, gzipped, GZ);
  const gz = await ground(env, 'GET', GZ);
  const gzb = new Uint8Array(await gz.arrayBuffer());
  check('ground: a gzipped tile is kept as gzip and served with Content-Encoding: gzip, never packed twice',
    wz.status === 200 && env.PHOTOS.m.get('_ground/qld-buildings/14/15139/9478.pbf').httpMetadata.contentEncoding === 'gzip'
      && gz.headers.get('Content-Encoding') === 'gzip' && gz.headers.get('Content-Type') === 'application/x-protobuf'
      && gzb.length === gzipped.length && gzb.every((v, i) => v === gzipped[i]));

  const before = env.PHOTOS.m.size;
  const html = await put(SECRET, new TextEncoder().encode('<html>not a tile</html>'), '/api/ground/qld-buildings/14/1/1.pbf');
  check('ground: something that is not a vector tile is refused', html.status === 400 && /not a vector tile/.test((await html.json()).error));
  const empty = await put(SECRET, new Uint8Array(0), '/api/ground/qld-buildings/14/1/1.pbf');
  check('ground: an empty tile is refused — leaving it out is what makes a 204', empty.status === 400 && /204/.test((await empty.json()).error));

  const exact = await put(SECRET, tileBytes(MAX_TILE_BYTES), '/api/ground/qld-buildings/14/2/2.pbf');
  check('ground: exactly 4 MB is a tile', exact.status === 200 && MAX_TILE_BYTES === 4 * 1048576, String(exact.status));
  const over = await put(SECRET, tileBytes(MAX_TILE_BYTES + 1), '/api/ground/qld-buildings/14/1/1.pbf');
  check('ground: a byte more is a 413', over.status === 413 && /4 MB/.test((await over.json()).error));
  const said = await put(SECRET, tileBytes(10), '/api/ground/qld-buildings/14/1/1.pbf', { 'Content-Length': String(MAX_TILE_BYTES + 1) });
  check('ground: a Content-Length over it is a 413 before reading', said.status === 413);
  const big = tileBytes(MAX_TILE_BYTES + 1);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(big.slice(i, i + 65536)); c.close(); } });
  const chunked = await put(SECRET, stream, '/api/ground/qld-buildings/14/1/1.pbf');
  check('ground: a chunked body over it is a 413 too', chunked.status === 413);
  check('ground: none of the refused ones written', env.PHOTOS.m.size === before + 1 && !env.PHOTOS.m.has('_ground/qld-buildings/14/1/1.pbf'));

  // meta.json
  check('ground: meta.json, no key, no write', (await put(undefined, '{}', META)).status === 401 && !env.PHOTOS.m.has(META_KEY));
  check('ground: meta.json must be a JSON object',
    (await put(SECRET, 'not json', META)).status === 400 && (await put(SECRET, '[1,2]', META)).status === 400
      && (await put(SECRET, 'null', META)).status === 400 && (await put(SECRET, new Uint8Array([0x7b, 0xff, 0x7d]), META)).status === 400
      && !env.PHOTOS.m.has(META_KEY));
  const bigMeta = `{"x":"${'a'.repeat(MAX_META_BYTES)}"}`;
  check('ground: meta.json over 1 MB is a 413', (await put(SECRET, bigMeta, META)).status === 413 && MAX_META_BYTES === 1048576);
  const doc = { layer: 'qld-buildings', built: '2026-11-08T00:00:00Z', minzoom: 12, maxzoom: 16, tiles: 2,
                attribution: '© The State of Queensland 2025' };
  const wm = await put(SECRET, JSON.stringify(doc), META);
  check('ground: the secret key writes meta.json, as application/json',
    wm.status === 200 && env.PHOTOS.m.get(META_KEY).httpMetadata.contentType === 'application/json');
  const gm = await ground(env, 'GET', META);
  check('ground: meta.json read back as written, readable cross-site',
    gm.status === 200 && J(await gm.json()) === J(doc) && gm.headers.get('Content-Type') === 'application/json'
      && gm.headers.get('Access-Control-Allow-Origin') === '*');
  check('ground: nothing deleted, ever', !env.PHOTOS.calls.some(c => c[0] === 'delete'));
}

// ── Through worker/index.js ──────────────────────────────────────────────────

{
  asked = [];
  meta = 'ok';
  const env = { PHOTOS: bucket() };
  const ctx = { waitUntil() {} };
  const c = await worker.fetch(new Request(`${ORIGIN}/api/canopy/${QK}.tif`, { headers: { Range: 'bytes=0-15' } }), env, ctx);
  check('index: worker/index.js sends /api/canopy here', c.status === 206 && asked.length === 1 && asked[0].url === `${UPSTREAM}${QK}.tif`);
  const bad = await worker.fetch(new Request(`${ORIGIN}/api/canopy/nope.tif`), env, ctx);
  check('index: … and its 400', bad.status === 400);
  const g = await worker.fetch(new Request(`${ORIGIN}${TILE}`), env, ctx);
  check('index: worker/index.js sends /api/ground here', g.status === 204);
  const p = await worker.fetch(new Request(`${ORIGIN}${TILE}`, { method: 'PUT', headers: { Authorization: `Bearer ${SECRET}` }, body: tileBytes() }), env, ctx);
  check('index: … and a PUT with the key writes through it', p.status === 200 && env.PHOTOS.m.has(TILE_KEY));
  const q = await worker.fetch(new Request(`${ORIGIN}${TILE}`, { method: 'PUT', headers: { Authorization: 'Bearer editor-token' }, body: tileBytes() }), env, ctx);
  check('index: … and without it does not', q.status === 401);
}

check('the secret key is in no log line', !logged.some(l => l.includes(SECRET)), J(logged.filter(l => l.includes(SECRET))));

// ── ground-cover.js: the tree finder, without a browser (#278) ──────────────
// The page module, loaded the way a browser would (a script, its global), and
// its pure parts asked: the zoom-10 squares a box needs, and the trees a small
// grid of canopy heights holds — one top per crown, as tall as the grid says.
{
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const ctx = vm.createContext({ console, Math, Uint8Array, Float32Array, Int32Array, Uint16Array, Uint32Array, Float64Array,
    DataView, ArrayBuffer, Map, Set, Promise, JSON, Number, Object, Array, Error, RangeError, window: undefined });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(new URL('../ground-cover.js', import.meta.url), 'utf8') + '\n;globalThis.__GC = GroundCover;', ctx);
  const GC = ctx.__GC;
  const qk = GC.quadkeysFor({ west: 153.02, south: -27.48, east: 153.03, north: -27.47 });
  check('ground-cover.js: a small box over Brisbane needs one zoom-10 square, Meta\'s 3112130013',
    Array.isArray(qk) && qk.length === 1 && qk[0] === '3112130013', J(qk));
  // 60 × 60 cells of 1.2 m: two crowns, 12 m and 20 m tall, apart.
  const w = 60, h = 60, data = new Uint8Array(w * h);
  const bump = (cx, cy, top, r) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - cx, y - cy); if (d < r) data[y * w + x] = Math.max(data[y * w + x], Math.round(top * (1 - (d / r) ** 2) + 0.4)); } };
  bump(15, 20, 12, 5); bump(42, 38, 20, 7);
  const fc = GC.treesFromGrid({ w, h, data, mpp: 1.2, box: { west: 152.0, south: -27.0006, east: 152.00073, north: -27.0 } });
  const crowns = (fc.features || []).filter(f => f.properties.kind === 'crown').map(f => f.properties.h).sort((x, y) => x - y);
  const trunks = (fc.features || []).filter(f => f.properties.kind === 'trunk').length;
  check('…and two crowns in a grid of canopy heights are two trees, each with its trunk, 12 m and 20 m tall',
    crowns.length === 2 && trunks === 2 && crowns[0] === 12 && crowns[1] === 20, J({ crowns, trunks, meta: fc.meta }));
  check('…every tree a crown above its trunk, both closed rings',
    (fc.features || []).every(f => f.properties.top > f.properties.base && f.geometry.type === 'Polygon'
      && J(f.geometry.coordinates[0][0]) === J(f.geometry.coordinates[0][f.geometry.coordinates[0].length - 1])), '');
}

// ── ground-cover.js: the buildings, without a browser (#280) ────────────────
// The digital twin has no MapLibre to read the buildings' tiles, so
// ground-cover.js reads them itself: a Mapbox Vector Tile decoder and the
// one-place-a-tile rule. Held here on tiles written by hand (the protobuf
// below, the same encoding the State's tiles and Overture's are in), with
// the State's store and Overture's file stood in for — so every number the
// twin stands a building on is arithmetic.
{
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const zlib = await import('node:zlib');
  const ctx = vm.createContext({ console, Math, Uint8Array, Float32Array, Int32Array, Uint16Array, Uint32Array, Float64Array,
    DataView, ArrayBuffer, Map, Set, Promise, JSON, Number, Object, Array, Error, RangeError, TypeError, String, BigInt,
    TextDecoder, Blob, Response, DecompressionStream, AbortSignal, Date, window: undefined, fetch: null });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(new URL('../ground-cover.js', import.meta.url), 'utf8') + '\n;globalThis.__GC = GroundCover;', ctx);
  const GC = ctx.__GC;

  // The tiles are written by test/lib/vector-tiles.mjs, which map3d and twin
  // write theirs with too.
  const mvt = (layer, features, extent) => new Uint8Array(mvtTile(layer, features, extent));

  // A zoom-14 tile in south-east Queensland, and where a point in it is in degrees.
  const Z = 14, TX = 15107, TY = 9530, EXT = 4096;
  const lngAt = px => (TX + px / EXT) / 2 ** Z * 360 - 180;
  const latAt = py => Math.atan(Math.sinh(Math.PI * (1 - 2 * (TY + py / EXT) / 2 ** Z))) * 180 / Math.PI;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  // 1. The decoder: a layer, its extent, a polygon, its properties of every kind.
  const kinds = mvt('building', [square(100, 200, 50, { s: 'shed', d: 7.5, b: true, n: { sint: -3 }, i: { int64: -5 }, u: { uint: 300 } })]);
  const dec = GC.decodeTile(kinds);
  const f0 = dec.building && dec.building.features[0];
  check('the vector tile reader: a layer, its extent, a polygon and its four corners where they were written',
    !!f0 && dec.building.extent === 4096 && f0.type === 3 && f0.rings.length === 1
      && J(f0.rings[0]) === J([[100, 200], [150, 200], [150, 250], [100, 250]]), J(dec));
  check('…and its properties of every kind a tile holds: a string, a double, a bool, a zigzag, a negative 64-bit and an unsigned integer',
    !!f0 && f0.props.s === 'shed' && f0.props.d === 7.5 && f0.props.b === true && f0.props.n === -3 && f0.props.i === -5 && f0.props.u === 300,
    J(f0 && f0.props));
  check('…and only the layers asked for', J(Object.keys(GC.decodeTile(kinds, ['buildings']))) === '[]');

  // 2. The State's tile: its buildings where the tile says, as tall as `h`.
  const stateBytes = mvt('buildings', [square(1024, 1024, 128, { h: 9 }), square(3000, 3000, 64, { h: 1.2 })]);
  const st = GC.buildingsFromTile(stateBytes, Z, TX, TY, 'state');
  const sq = st[0] && st[0].ring;
  check('a State tile: each outline in degrees where its corners are on the tile, as tall as its `h`, from the State',
    st.length === 2 && st[0].src === 'state' && st[0].h === 9 && sq.length === 4
      && near(sq[0][0], lngAt(1024), 1e-7) && near(sq[0][1], latAt(1024), 1e-7)
      && near(sq[2][0], lngAt(1152), 1e-7) && near(sq[2][1], latAt(1152), 1e-7), J(st));
  check('…and none under 2 m, the floor the State\'s tiles are cut at', st[1] && st[1].h === 2, J(st[1]));

  // 3. Overture's: height, else floors, else one storey, never under 3 m, and
  // none of those it marks under the ground.
  const ovtProps = [{ height: 7.5 }, { num_floors: { sint: 2 } }, {}, { height: 1 }, { height: -1 }, { num_floors: { sint: 0 } },
                    { height: 12, is_underground: true }, { height: 'tall' }];
  const ovtBytes = mvt('building', ovtProps.map((p, i) => square(200 + i * 300, 400, 100, p)));
  const ov = GC.buildingsFromTile(ovtBytes, Z, TX, TY, 'overture');
  check('an Overture tile: as tall as `height`, 3.2 m a floor, one storey (3.5 m) with neither, never under 3 m, and none it marks under the ground',
    J(ov.map(b => b.h)) === J([7.5, 6.4, 3.5, 3, 3, 3, 3.5]) && ov.every(b => b.src === 'overture'), J(ov.map(b => b.h)));
  check('…the same numbers as the 3-D view\'s', GC.buildingHeight({ height: 7.5 }, 'overture') === 7.5
    && Math.abs(GC.buildingHeight({ num_floors: 2 }, 'overture') - 6.4) < 1e-9 && GC.buildingHeight({}, 'overture') === 3.5
    && GC.buildingHeight({ height: 1 }, 'overture') === 3);
  check('…and a State layer is not read as Overture\'s, nor Overture\'s as the State\'s',
    GC.buildingsFromTile(ovtBytes, Z, TX, TY, 'state').length === 0 && GC.buildingsFromTile(stateBytes, Z, TX, TY, 'overture').length === 0);

  // 4. A building over the tile's edge is cut there: the next tile holds the rest.
  const edge = GC.buildingsFromTile(mvt('buildings', [square(4000, 100, 200, { h: 6 })]), Z, TX, TY, 'state')[0];
  const east = edge ? Math.max(...edge.ring.map(p => p[0])) : null;
  check('a building that runs past the tile\'s edge (its buffer) is cut at the edge, not drawn twice',
    !!edge && near(east, lngAt(4096), 1e-7) && near(Math.min(...edge.ring.map(p => p[0])), lngAt(4000), 1e-7), J(edge));

  // 5. A courtyard: the hole after its outer ring, wound the other way.
  const yard = mvt('buildings', [{ rings: [[[500, 500], [900, 500], [900, 900], [500, 900]], [[600, 600], [600, 800], [800, 800], [800, 600]]], props: { h: 8 } }]);
  const yb = GC.buildingsFromTile(yard, Z, TX, TY, 'state');
  check('a building round a courtyard: one outline with its hole', yb.length === 1 && yb[0].holes.length === 1 && yb[0].holes[0].length === 4, J(yb));

  // 6. buildings(box): the State's tile where it has one, Overture's for every
  // other, never both; the State's store and Overture's file stood in for.
  const box = { west: lngAt(900), east: lngAt(4096 + 600), north: latAt(300), south: latAt(1500) };   // this tile and the next east
  const world = { meta: 'built', stateDown: false, ovtDown: false, gz: false, asked: [], ovtAsked: [] };
  const metaBody = { layer: 'qld-buildings', attribution: '© State of Queensland (Department of Resources) 2026, CC BY 4.0', bounds: [150.0, -29.0, 154.0, -26.0] };
  ctx.fetch = async url => {
    world.asked.push(String(url));
    if (/meta\.json$/.test(url)) {
      if (world.meta === 'down') throw new TypeError('fetch failed');
      return world.meta === 'built' ? new Response(JSON.stringify(metaBody), { status: 200 }) : new Response('{}', { status: 404 });
    }
    const m = /qld-buildings\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url);
    if (m) {
      if (world.stateDown) throw new TypeError('fetch failed');
      if (+m[2] !== TX || +m[3] !== TY) return new Response(null, { status: 204 });
      return new Response(world.gz ? zlib.gzipSync(stateBytes) : stateBytes, { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  GC.setOvertureOpener(async () => {
    if (world.ovtDown) throw new Error('no catalogue');
    return { release: '2026-10-21.0', file: { getZxy: async (z, x, y) => { world.ovtAsked.push(`${z}/${x}/${y}`); return { data: ovtBytes.buffer.slice(0) }; } } };
  });
  const fresh = () => { GC.forgetOverture(); world.asked.length = 0; world.ovtAsked.length = 0; };

  fresh();
  const b1 = await GC.buildings(box);
  const here = `${Z}/${TX}/${TY}`, next = `${Z}/${TX + 1}/${TY}`;
  check('buildings(): the State\'s tile where it has one, Overture\'s for the tile it has none in',
    b1.tiles[here] === 'state' && b1.tiles[next] === 'overture' && b1.tally.state === 1 && b1.tally.overture === 1 && b1.state === 'built'
      && b1.overture === 'ready' && b1.release === '2026-10-21.0', J({ tiles: b1.tiles, tally: b1.tally }));
  check('…and Overture is never asked for the tile the State has — a house is never stood twice',
    !world.ovtAsked.includes(here) && world.ovtAsked.includes(next), J(world.ovtAsked));
  check('…only the buildings whose middle is in the box: the State\'s 9 m one, and Overture\'s in the next tile',
    b1.buildings.some(b => b.src === 'state' && b.h === 9) && !b1.buildings.some(b => b.src === 'state' && b.h === 2)
      && b1.buildings.filter(b => b.src === 'overture').length > 0 && b1.buildings.every(b => {
        const cx = b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length, cy = b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length;
        return cx >= box.west && cx <= box.east && cy >= box.south && cy <= box.north; }), J(b1.buildings.map(b => [b.src, b.h])));
  check('…credited to the State, in its own words, and to OpenStreetMap and Overture',
    b1.credit.includes(metaBody.attribution) && b1.credit.includes('© OpenStreetMap contributors, Overture Maps Foundation (ODbL)'), b1.credit);

  fresh();
  world.gz = true;
  GC.clearCache();
  const b2 = await GC.buildings(box);
  check('a State tile that arrives still gzipped is unpacked', b2.tiles[here] === 'state' && b2.buildings.some(b => b.src === 'state' && b.h === 9), J(b2.tally));
  world.gz = false;

  fresh(); GC.clearCache();
  world.meta = 'missing';
  const b3 = await GC.buildings(box);
  check('the State\'s tiles not built yet (meta.json 404): the State is not asked for a tile, Overture is asked for both',
    b3.state === 'not built' && !world.asked.some(u => /\.pbf$/.test(u)) && b3.tiles[here] === 'overture' && b3.tiles[next] === 'overture'
      && !b3.credit.includes('State of Queensland'), J({ asked: world.asked, tiles: b3.tiles, credit: b3.credit }));

  fresh(); GC.clearCache();
  world.meta = 'built'; world.ovtDown = true;
  let threw = null, b4 = null;
  try { b4 = await GC.buildings(box); } catch (err) { threw = err; }
  check('Overture out of reach: nothing thrown, the State\'s tile still read, the other tile empty, and it says Overture failed',
    !threw && b4.overture === 'failed' && b4.tiles[here] === 'state' && b4.tiles[next] === 'none' && b4.buildings.every(b => b.src === 'state'),
    J({ threw: threw && threw.message, b4: b4 && { tiles: b4.tiles, overture: b4.overture } }));
  world.ovtDown = false;

  fresh(); GC.clearCache();
  world.meta = 'down';
  const b5 = await GC.buildings(box);
  check('the State\'s store out of reach: said so, and Overture\'s buildings everywhere instead',
    b5.state === 'unreachable' && b5.tiles[here] === 'overture' && b5.tiles[next] === 'overture', J({ state: b5.state, tiles: b5.tiles }));
  world.meta = 'built';

  fresh(); GC.clearCache();
  world.stateDown = true;
  const b6 = await GC.buildings(box);
  check('a State tile that cannot be fetched: counted, and the tile is Overture\'s',
    b6.tally.stateFailed >= 1 && b6.tiles[here] === 'overture', J(b6.tally));
  world.stateDown = false;

  let refused = null;
  try { await GC.buildings({ west: 150, east: 150.1, south: -27.1, north: -27 }); } catch (err) { refused = err; }
  check('a box wider than 3 km is refused', refused instanceof ctx.RangeError || (refused && refused.name === 'RangeError'), String(refused));

  check('Overture\'s release is the catalogue\'s child marked latest, in its own form, and nothing else',
    GC.latestRelease({ latest: '2026-09-23.0', links: [{ rel: 'child', href: 'https://stac.overturemaps.org/2026-10-21.0/catalog.json', latest: true }] }) === '2026-10-21.0'
      && GC.latestRelease({ latest: '../evil' }) === null && GC.latestRelease({ links: [{ rel: 'child', href: 'https://x/../../catalog.json', latest: true }] }) === null);
  const devPm = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).devDependencies.pmtiles;
  check('the buildings reader asked of unpkg is the version the checks run against', GC.PMTILES_VER === devPm, `${GC.PMTILES_VER} vs ${devPm}`);
  GC.setOvertureOpener(null);
}

// ── Report ────────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.what}${r.ok || !r.detail ? '' : ` — ${String(r.detail).slice(0, 300)}`}`);
console.log(failed.length ? `\nFAIL — ${failed.length} of ${results.length}.` : `\nPASS — ${results.length} checks: the canopy route asks one fixed folder with nothing of the caller's but a byte range, and the ground tiles are read by anybody (an empty one a 204) and written with the secret key only; the buildings' tiles are read as written, a tile from one place only.`);
process.exitCode = failed.length ? 1 : 0;
