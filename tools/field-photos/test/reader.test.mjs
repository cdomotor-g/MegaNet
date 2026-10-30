// The photo reader's fetch (fetch-for-reader.mjs): which photos it asks for,
// where their bytes come from — the store's signed links, or Supabase Storage
// for one not carried over yet — what it writes for the reader, and what it
// refuses to be asked. No network: a stand-in fetch for the project and the
// store.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { options, fetchForReader } from '../fetch-for-reader.mjs';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function world() {
  const w = { calls: [], rpc: [] };
  const rows = [
    { id: ID1, station_id: 'gatton', station_name: 'Gatton', station_number: '540200', storage_path: `photo/${ID1}.jpg`,
      content_type: 'image/jpeg', byte_size: 4, width: 4000, height: 3000, taken_at: '2026-10-01T00:00:00Z', title: 'IMG_1.jpg', caption: '' },
    { id: ID2, station_id: null, station_name: null, station_number: null, storage_path: `photo/${ID2}.png`,
      content_type: 'image/png', byte_size: 3, width: 800, height: 600, taken_at: null, title: 'IMG_2.png', caption: 'loose' },
  ];
  w.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    w.calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === 'project.test' && u.pathname === '/rest/v1/rpc/photos_to_read') {
      w.rpc.push(JSON.parse(init.body));
      return J(200, rows);
    }
    if (u.host === 'project.test' && u.pathname === '/rest/v1/field_photo') {
      return J(200, rows.filter(r => u.search.includes(r.id)).map(({ station_name, station_number, ...r }) => ({ ...r, thumb_path: r.storage_path.replace(/\.\w+$/, '.thumb.jpg') })));
    }
    if (u.host === 'project.test' && u.pathname === '/rest/v1/station') return J(200, [{ id: 'gatton', name: 'Gatton', station_number: '540200' }]);
    if (u.host === 'store.test' && u.pathname === '/api/photos/sign') {
      const b = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer sb_secret_x');
      // The first is in R2; the second not yet.
      return J(200, { urls: Object.fromEntries(b.paths.filter(p => p.includes(ID1)).map(p => [p, `https://store.test/api/photos/field-photos/${p}?e=1&s=x`])),
                      missing: b.paths.filter(p => !p.includes(ID1)) });
    }
    if (u.host === 'store.test' && u.pathname.startsWith('/api/photos/field-photos/')) return new Response(Buffer.from('JPEG'), { status: 200 });
    if (u.host === 'project.test' && u.pathname.startsWith('/storage/v1/object/field-photos/')) {
      return new Response(Buffer.from('PNG'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return J(404, { message: `nothing at ${u.pathname}` });
  };
  return w;
}

const env = (out, extra = {}) => ({ SUPABASE_SECRET_KEY: 'sb_secret_x', SUPABASE_URL: 'https://project.test',
                                     PHOTO_STORE_URL: 'https://store.test/api/photos', OUT: out, ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));

test('the photos still to read, from the store and from Supabase, written with a manifest', async () => {
  const w = world(), out = tmp();
  const r = await fetchForReader({ env: env(out, { SIZE: 'full', LIMIT: '50' }), fetch: w.fetch });
  assert.deepEqual(r, { asked: 2, fetched: 2, failed: 0, bytes: 7, fromSupabase: 1 });
  assert.deepEqual(w.rpc, [{ p_reader: 'agent:photo-reader', p_version: 1, p_limit: 50 }]);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.reader, 'agent:photo-reader');
  assert.deepEqual(m.photos.map(p => [p.photo_id, p.station_name, p.file]),
    [[ID1, 'Gatton', `photos/${ID1}.jpg`], [ID2, null, `photos/${ID2}.png`]]);
  assert.equal(fs.readFileSync(path.join(out, m.photos[0].file), 'utf8'), 'JPEG');
  assert.equal(fs.readFileSync(path.join(out, m.photos[1].file), 'utf8'), 'PNG');
});

test('photos asked for by id, their stations named', async () => {
  const w = world(), out = tmp();
  const r = await fetchForReader({ env: env(out, { SELECT: 'ids', IDS: `${ID2}, ${ID1}`, SIZE: 'full' }), fetch: w.fetch });
  assert.equal(r.fetched, 2);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.photos.map(p => [p.photo_id, p.station_name]), [[ID2, null], [ID1, 'Gatton']]);
  assert.ok(!w.rpc.length, 'the list of photos to read is not asked for');
});

test('smaller when asked, and full size with a warning when there is no ImageMagick', async () => {
  const w = world(), out = tmp();
  const said = [];
  const r = await fetchForReader({ env: env(out, { SIZE: '1600' }), fetch: w.fetch, log: s => said.push(s), magick: 'no-such-imagemagick' });
  assert.equal(r.fetched, 2);
  assert.ok(said.some(s => /No ImageMagick/.test(s)), said.join(' | '));
  assert.equal(said.filter(s => /No ImageMagick/.test(s)).length, 1, 'said once');
});

test('what it refuses to be asked', () => {
  assert.throws(() => options({ SELECT: 'everything' }), /SELECT is unread or ids/);
  assert.throws(() => options({ SELECT: 'ids', IDS: 'photo/../../etc' }), /IDS is a list of photo ids/);
  assert.throws(() => options({ SELECT: 'ids', IDS: '' }), /IDS is a list of photo ids/);
  assert.throws(() => options({ SIZE: '99999' }), /SIZE is full, thumb/);
  assert.throws(() => options({ SIZE: '1600; rm -rf /' }), /SIZE is full, thumb/);
  assert.throws(() => options({ READER: 'me' }), /READER is agent:<name>/);
  assert.equal(options({}).limit, 200);
  assert.equal(options({ LIMIT: '5000' }).limit, 1000);
  assert.deepEqual(options({ SELECT: 'ids', IDS: `${ID1},${ID2}` }).ids, [ID1, ID2]);
});
