// The syncs' and the move's side of the photo store (lib/supabase.mjs,
// move-to-r2.mjs): bytes go to R2 through the Worker when it is there, to
// Supabase Storage when it says it is not bound or cannot be reached, and the
// move puts before it removes. No network: a stand-in fetch for both.

import test from 'node:test';
import assert from 'node:assert/strict';
import { client } from '../lib/supabase.mjs';
import { photoStoreFor, DEFAULT_SUPABASE_URL } from '../lib/run.mjs';
import { move } from '../move-to-r2.mjs';

const SUPA = 'https://project.test', STORE = 'https://store.test/api/photos';
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function world({ store = 'bound' } = {}) {
  const w = { calls: [], r2: new Map(), supa: new Map() };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    w.calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === 'store.test') {
      if (store === 'unbound') return J(503, { error: 'not bound', unbound: true });
      if (store === 'access') return new Response('<html>login</html>', { status: 302, headers: { 'content-type': 'text/html' } });
      if (store === 'down') throw new TypeError('fetch failed');
      const key = u.pathname.replace('/api/photos/field-photos/', '');
      if (method === 'PUT') {
        if (w.r2.has(key)) return J(409, { error: 'exists' });
        w.r2.set(key, Buffer.from(init.body)); return J(200, { Key: key });
      }
      if (method === 'DELETE') { w.r2.delete(key); return J(200, { ok: true }); }
    }
    if (u.host === 'project.test') {
      if (u.pathname === '/storage/v1/object/list/field-photos') {
        const b = JSON.parse(init.body);
        const names = [...w.supa.keys()].map(k => k.replace('photo/', '')).sort().slice(b.offset, b.offset + b.limit);
        return J(200, names.map(n => ({ id: `id-${n}`, name: n, metadata: { size: w.supa.get(`photo/${n}`).length, mimetype: 'image/jpeg' } })));
      }
      const key = u.pathname.replace('/storage/v1/object/field-photos/', '');
      if (method === 'POST') { w.supa.set(key, Buffer.from(init.body)); return J(200, { Key: key }); }
      if (method === 'GET') return w.supa.has(key) ? new Response(w.supa.get(key), { headers: { 'content-type': 'image/jpeg' } }) : J(404, { message: 'not found' });
      if (method === 'DELETE') { const had = w.supa.delete(key); return had ? J(200, {}) : J(400, { message: 'not found' }); }
    }
    return J(404, { message: `no ${method} ${url}` });
  };
  return w;
}

const bytes = Buffer.from([0xff, 0xd8, 1, 2, 3]);

test('which store: MegaNet\'s own project uses the Worker; another project, or an empty setting, does not', () => {
  assert.equal(photoStoreFor({}), 'https://floodwarning.net/api/photos');
  assert.equal(photoStoreFor({ SUPABASE_URL: DEFAULT_SUPABASE_URL }), 'https://floodwarning.net/api/photos');
  assert.equal(photoStoreFor({ SUPABASE_URL: SUPA }), null);
  assert.equal(photoStoreFor({ PHOTO_STORE_URL: '' }), null);
  assert.equal(photoStoreFor({ SUPABASE_URL: SUPA, PHOTO_STORE_URL: STORE }), STORE);
});

test('bound: bytes go to R2, and a remove clears both', async () => {
  const w = world();
  const db = client(w.fetch, { url: SUPA, key: 'sb_secret_x', store: STORE });
  await db.upload('photo/a.jpg', bytes, 'image/jpeg');
  assert.ok(w.r2.has('photo/a.jpg'));
  assert.equal(w.supa.size, 0);
  await db.remove('photo/a.jpg');
  assert.equal(w.r2.size, 0);
  assert.ok(w.calls.includes('DELETE project.test/storage/v1/object/field-photos/photo/a.jpg'));
});

for (const state of ['unbound', 'access', 'down']) {
  test(`${state}: bytes go to Supabase Storage, as before`, async () => {
    const w = world({ store: state });
    const said = [];
    const db = client(w.fetch, { url: SUPA, key: 'sb_secret_x', store: STORE, log: s => said.push(s) });
    await db.upload('photo/a.jpg', bytes, 'image/jpeg');
    await db.upload('photo/b.jpg', bytes, 'image/jpeg');
    assert.deepEqual([...w.supa.keys()], ['photo/a.jpg', 'photo/b.jpg']);
    assert.equal(w.calls.filter(c => c.includes('store.test')).length, 1, 'asked once, then remembered');
    if (state !== 'unbound') assert.equal(said.length, 1);
  });
}

test('the move: every object put to R2, then removed from Supabase; a second run finds nothing', async () => {
  const w = world();
  for (let i = 0; i < 230; i++) w.supa.set(`photo/${String(i).padStart(4, '0')}.jpg`, bytes);
  w.r2.set('photo/0007.jpg', bytes);      // carried over by a run that stopped
  const out = await move({ env: { SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: 'sb_secret_x', PHOTO_STORE_URL: STORE }, fetch: w.fetch });
  assert.equal(out.moved, 229);
  assert.equal(out.already, 1);
  assert.equal(out.failed, 0);
  assert.equal(w.supa.size, 0);
  assert.equal(w.r2.size, 230);
  const again = await move({ env: { SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: 'sb_secret_x', PHOTO_STORE_URL: STORE }, fetch: w.fetch });
  assert.equal(again.moved + again.already + again.left, 0);
});

test('the move: a dry run only counts, and a cap leaves the rest for next time', async () => {
  const w = world();
  for (let i = 0; i < 5; i++) w.supa.set(`photo/${i}.jpg`, bytes);
  const env = { SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: 'k', PHOTO_STORE_URL: STORE };
  const dry = await move({ env: { ...env, DRY_RUN: '1' }, fetch: w.fetch });
  assert.equal(dry.left, 5);
  assert.equal(dry.bytes, 5 * bytes.length);
  assert.equal(w.r2.size, 0);
  const capped = await move({ env: { ...env, MAX_OBJECTS: '2' }, fetch: w.fetch });
  assert.equal(capped.moved, 2);
  assert.equal(capped.left, 3);
  assert.equal(w.supa.size, 3);
});

test('the move: an unbound store stops it with nothing removed, and never writes back to Supabase', async () => {
  const w = world({ store: 'unbound' });
  w.supa.set('photo/a.jpg', bytes);
  await assert.rejects(move({ env: { SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: 'k', PHOTO_STORE_URL: STORE }, fetch: w.fetch }), e => e.code === 'unbound');
  assert.ok(w.supa.has('photo/a.jpg'));
  const w2 = world({ store: 'access' });
  w2.supa.set('photo/a.jpg', bytes);
  await assert.rejects(move({ env: { SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: 'k', PHOTO_STORE_URL: STORE }, fetch: w2.fetch }), /Cloudflare Access/);
  assert.ok(w2.supa.has('photo/a.jpg'));
});
