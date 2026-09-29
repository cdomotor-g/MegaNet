// What the photo store (worker/photos.js) lets past, and what it does not.
//
// /api/photos/* carries the field photos' bytes between the app and R2 with no
// Access identity required, so its own checks are the whole of its security:
// who may put, sign and delete (an editor, as the project says, or the
// project's secret key), which paths exist at all, and whether a view URL was
// signed here and is still in date. Each fails open and invisibly if wrong —
// the app works either way — so they are asserted here, offline: R2 is a Map,
// and the project's answers are a stand-in fetch.
//
// Run:  npm run photostore

import { handlePhotos, photoTarget, isPhotoPath, MAX_BYTES } from '../worker/photos.js';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });

// ── Stand-ins ─────────────────────────────────────────────────────────────────
function bucket() {
  const m = new Map();
  const meta = (k, v) => ({ key: k, size: v.bytes.length, httpMetadata: v.httpMetadata, httpEtag: '"e"' });
  return {
    m,
    async head(k) { const v = m.get(k); return v ? meta(k, v) : null; },
    async get(k) {
      const v = m.get(k);
      if (!v) return null;
      return { ...meta(k, v), body: v.bytes, arrayBuffer: async () => v.bytes.buffer.slice(v.bytes.byteOffset, v.bytes.byteOffset + v.bytes.length) };
    },
    async put(k, body, opts = {}) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      m.set(k, { bytes, httpMetadata: opts.httpMetadata || {} });
      return meta(k, m.get(k));
    },
    async delete(k) { m.delete(k); },
  };
}

// The project: `editor-token` is an editor, `reader-token` is signed in but not
// one, `sb_secret_ok` is the secret key. Everything else is refused.
const asked = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  asked.push(u);
  if (u.endsWith('/rest/v1/rpc/is_editor')) {
    if (auth === 'Bearer editor-token') return new Response('true', { status: 200 });
    if (auth === 'Bearer reader-token') return new Response('false', { status: 200 });
    return new Response('{"message":"JWT invalid"}', { status: 401 });
  }
  if (u.includes('/auth/v1/admin/users')) {
    return new Response('{}', { status: auth === 'Bearer sb_secret_ok' ? 200 : 401 });
  }
  return new Response('not here', { status: 404 });
};

const ORIGIN = 'https://floodwarning.net';
const P = 'photo/0b6f7c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f.jpg';
const T = 'photo/0b6f7c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f.thumb.jpg';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function req(method, path, { token, body, type, len } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (type) headers.set('Content-Type', type);
  if (body instanceof Uint8Array) headers.set('Content-Length', String(len ?? body.length));
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body) });
}
const put = (env, path, token, opts = {}) => handlePhotos(req('PUT', `/api/photos/field-photos/${path}`, { token, body: JPEG, type: 'image/jpeg', ...opts }), env);
const sign = async (env, token, paths, expiresIn) => handlePhotos(req('POST', '/api/photos/sign', { token, type: 'application/json', body: { bucket: 'field-photos', paths, expiresIn } }), env);

// ── Paths ─────────────────────────────────────────────────────────────────────
check('a photo path is ours', isPhotoPath('/api/photos/field-photos/x') && isPhotoPath('/api/photos/sign'));
check('another route is not', !isPhotoPath('/api/photosx') && !isPhotoPath('/api/db/storage/v1/x'));
check('a photo resolves', JSON.stringify(photoTarget(`/api/photos/field-photos/${P}`)) === JSON.stringify({ bucket: 'field-photos', path: P }));
check('its thumbnail resolves', !!photoTarget(`/api/photos/field-photos/${T}`));
for (const [what, p] of [
  ['another bucket', `/api/photos/inspections/${P}`],
  ['a path outside photo/', '/api/photos/field-photos/other/0b6f7c1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f.jpg'],
  ['the signing key', '/api/photos/field-photos/_meganet/url-signing-key'],
  ['a traversal', '/api/photos/field-photos/photo/../_meganet/url-signing-key'],
  ['an encoded traversal', '/api/photos/field-photos/photo%2F..%2F_meganet%2Furl-signing-key'],
  ['a name that is not a uuid', '/api/photos/field-photos/photo/cat.jpg'],
  ['a malformed escape', '/api/photos/field-photos/photo/%zz.jpg'],
]) check(`refuses ${what}`, photoTarget(p) === null, String(JSON.stringify(photoTarget(p))));

// ── Unbound ───────────────────────────────────────────────────────────────────
{
  const r = await handlePhotos(req('POST', '/api/photos/sign', { token: 'editor-token', body: {} }), {});
  const b = await r.json();
  check('without R2 it says so, for the app to fall back', r.status === 503 && b.unbound === true, `${r.status}`);
}

const env = { PHOTOS: bucket() };

// ── Writing ──────────────────────────────────────────────────────────────────
check('no token: no upload', (await put(env, P, null)).status === 401);
check('a forged token: no upload', (await put(env, P, 'forged')).status === 401);
check('signed in but not an editor: no upload', (await put(env, P, 'reader-token')).status === 401);
check('nothing was stored by any of those', env.PHOTOS.m.size === 0);
check('an SVG is refused', (await put(env, P, 'editor-token', { type: 'image/svg+xml' })).status === 415);
check('an HTML page is refused', (await put(env, P, 'editor-token', { type: 'text/html' })).status === 415);
check('a declared size over the limit is refused', (await put(env, P, 'editor-token', { len: MAX_BYTES + 1 })).status === 413);
check('an editor uploads', (await put(env, P, 'editor-token')).status === 200 && env.PHOTOS.m.has(`field-photos/${P}`));
check('create-only: the same path again is a 409', (await put(env, P, 'editor-token')).status === 409);
{
  const r = await put(env, T, 'sb_secret_ok', { type: '' });
  check('the secret key uploads (the syncs), typed from the path when untyped', r.status === 200
        && env.PHOTOS.m.get(`field-photos/${T}`).httpMetadata.contentType === 'image/jpeg', `${r.status}`);
}

// ── Signing and reading ──────────────────────────────────────────────────────
check('no token: nothing signed', (await sign(env, null, [P])).status === 401);
check('not an editor: nothing signed', (await sign(env, 'reader-token', [P])).status === 401);
const missingP = 'photo/11111111-2222-4333-8444-555555555555.jpg';
const sr = await sign(env, 'editor-token', [P, T, missingP, '../x']);
const signed = await sr.json();
check('an editor gets URLs for what the store holds', sr.status === 200 && !!signed.urls[P] && !!signed.urls[T]);
check('and is told which it does not (still in Supabase)', JSON.stringify(signed.missing) === JSON.stringify([missingP]), JSON.stringify(signed.missing));
check('a path that is not one is neither', !('../x' in signed.urls) && !signed.missing.includes('../x'));

const get = u => handlePhotos(new Request(u), env);
{
  const r = await get(signed.urls[P]);
  const bytes = new Uint8Array(await r.arrayBuffer());
  check('a signed URL serves the bytes', r.status === 200 && bytes.length === JPEG.length && bytes[0] === 0xff);
  check('as the type they were stored as', r.headers.get('content-type') === 'image/jpeg');
  check('never sniffed, never run', r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy') || ''));
  check('and readable across origins (github.io)', r.headers.get('access-control-allow-origin') === '*');
}
{
  const u = new URL(signed.urls[P]);
  const bare = `${u.origin}${u.pathname}`;
  check('no signature: 403', (await get(bare)).status === 403);
  const tampered = new URL(u); tampered.searchParams.set('s', `${u.searchParams.get('s').slice(0, -2)}AA`);
  check('a tampered signature: 403', (await get(tampered.toString())).status === 403);
  const later = new URL(u); later.searchParams.set('e', String(Number(u.searchParams.get('e')) + 3600));
  check('a stretched expiry: 403', (await get(later.toString())).status === 403);
  const other = new URL(signed.urls[P].replace(P, T));
  check('one photo\'s signature on another: 403', (await get(other.toString())).status === 403);
}
{
  const r = await sign(env, 'editor-token', [P], 60);
  const u = new URL((await r.json()).urls[P]);
  u.searchParams.set('e', String(Math.floor(Date.now() / 1000) - 5));
  check('an expired URL: 403', (await get(u.toString())).status === 403);
}

// ── Removing ──────────────────────────────────────────────────────────────────
const del = (token) => handlePhotos(req('DELETE', `/api/photos/field-photos/${P}`, { token }), env);
check('not an editor: nothing removed', (await del('reader-token')).status === 401 && env.PHOTOS.m.has(`field-photos/${P}`));
check('an editor removes', (await del('editor-token')).status === 200 && !env.PHOTOS.m.has(`field-photos/${P}`));
check('and its old URL no longer serves', (await get(signed.urls[P])).status === 404);

// ── The key itself ───────────────────────────────────────────────────────────
check('the signing key lives in the bucket, out of any served path', env.PHOTOS.m.has('_meganet/url-signing-key'));

console.log('');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.what}${r.detail && !r.ok ? ` — ${r.detail}` : ''}`);
console.log('');
const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} photo store case(s) went the wrong way.\n`);
  process.exit(1);
}
console.log(`PASS — the photo store's ${results.length} checks hold.`);
