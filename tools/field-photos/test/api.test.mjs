// The upload API's inbox as a sync source (lib/api.mjs, PHOTO_SOURCE=api):
// photos other apps and contractors sent to /api/upload/v1/photos, waiting in
// the inbox under a receipt, read by the same run, photo-meta.js and
// add_field_photo() as Dropbox's — filed as the sender's ('api:<label>'), with
// the sender's hints used where the photo says nothing, logged for the Review
// panel, and each receipt settled with what became of it. No network: the
// project and the inbox are fakes.
//
// Run:  cd tools/field-photos && node --test test/api.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { run, providerFor, withHints } from '../lib/run.mjs';
import { api, nameFor } from '../lib/api.mjs';
import { tiff, gpsEntries, jpegWith } from '../../../test/lib/exif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NE = fs.readFileSync(path.join(HERE, '..', '..', '..', 'test', 'fixtures', 'photos', 'solocator-gatton-ne.jpg'));
const GPS = jpegWith(NE, { tiff: tiff({
  ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [1]]],
  exif: [[0x9003, 2, '2026:06:25 09:15:00'], [0x9011, 2, '+10:00']],
  gps: gpsEntries({ lat: -27.5561, lon: 152.2731, alt: 96.5, heading: 118.25, accuracy: 3.5, date: '2026:06:24', time: [23, 15, 0] }),
}) });
// A photo with nothing in it: no EXIF, no overlay.
const PLAIN = Buffer.from(jpeg.encode({ data: Buffer.alloc(32 * 24 * 4, 128), width: 32, height: 24 }, 80).data);

const ENV = { PHOTO_SOURCE: 'api', SUPABASE_URL: 'https://project.test', SUPABASE_SECRET_KEY: 'secret-fixture',
              PHOTO_STORE_URL: '', PHOTO_UPLOAD_INBOX_URL: 'https://inbox.test/api/upload/v1/inbox' };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function fakeWorld(waiting) {
  const w = {
    waiting: waiting.map(x => ({ content_type: 'image/jpeg', received_at: '2026-11-27T01:00:00Z', attempts: 0, hints: {}, label: 'Acme Surveys', ...x })),
    rows: [], rpc: [], settled: [], cleared: [], logged: [], objects: new Map(), sync: null, cursor: null,
    refuse: null,
  };
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const headers = init.headers || {};
    if (u.host === 'inbox.test') {
      assert.equal(headers.Authorization, 'Bearer secret-fixture', 'the inbox is read with the secret key');
      const id = u.pathname.split('/').pop();
      if (method === 'DELETE') { w.cleared.push(id); return reply(200, { ok: true }); }
      const x = w.waiting.find(r => r.receipt === id);
      return x && x.bytes ? new Response(x.bytes, { status: 200 }) : reply(404, { error: 'not in the inbox' });
    }
    if (u.host !== 'project.test') return reply(404, { message: `no ${url}` });
    assert.equal(headers.apikey, 'secret-fixture');
    const p = u.pathname;
    const body = init.body && p.startsWith('/rest/') ? JSON.parse(init.body) : null;
    if (p === '/rest/v1/rpc/photo_upload_waiting') {
      return reply(200, w.waiting.filter(r => !w.settled.some(s => s.receipt === r.receipt && s.final))
        .map(({ bytes, ...r }) => ({ ...r, byte_size: bytes ? bytes.length : 1 })));
    }
    if (p === '/rest/v1/rpc/photo_upload_settle') {
      const final = body.p.outcome !== 'failed';
      w.settled.push({ receipt: body.p_receipt, ...body.p, final });
      return reply(200, { state: final ? body.p.outcome : 'waiting', final });
    }
    if (p === '/rest/v1/rpc/log_field_photo_upload') { w.logged.push(...body.p_rows); return reply(200, {}); }
    if (p === '/rest/v1/rpc/add_field_photo') {
      w.rpc.push(body.p_photo);
      const no = w.refuse && w.refuse(body.p_photo);
      if (no) return reply(no.status, no.body);
      const row = { id: `row-${w.rows.length + 1}`, station_id: body.p_photo.station_id || (body.p_photo.lat ? 'gatton' : null), lat: body.p_photo.lat ?? null, ...body.p_photo };
      w.rows.push(row);
      return reply(200, row);
    }
    if (p === '/rest/v1/field_photo' && method === 'GET') {
      const q = u.searchParams;
      const ref = q.get('origin_ref'), sha = q.get('sha256');
      const refs = ref ? ref.replace(/^in\.\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')) : null;
      const hit = w.rows.filter(r => (refs ? refs.includes(r.origin_ref) && r.origin === 'api' : true)
                                  && (sha ? `eq.${r.sha256}` === sha && !r.deleted_at : true));
      return reply(200, (refs ? hit : hit.slice(0, 1)).map(r => ({ id: r.id, origin_ref: r.origin_ref, deleted_at: r.deleted_at || null, lat: r.lat ?? null, station_id: r.station_id || null })));
    }
    if (p === '/rest/v1/field_photo_sync' && method === 'GET') return reply(200, []);
    if (p === '/rest/v1/field_photo_sync_cursor' && method === 'GET') return reply(200, []);
    if (p === '/rest/v1/field_photo_sync_cursor' && method === 'POST') { w.cursor = body.cursor; return reply(201); }
    if (p === '/rest/v1/field_photo_sync' && method === 'POST') { w.sync = body; return reply(201); }
    if (p.startsWith('/storage/v1/object/field-photos/')) {
      const key = p.replace('/storage/v1/object/field-photos/', '');
      if (method === 'POST') { w.objects.set(key, true); return reply(200, { Key: key }); }
      if (method === 'DELETE') { w.objects.delete(key); return reply(200, {}); }
    }
    return reply(404, { message: `the fixture does not answer ${method} ${url}` });
  };
  return w;
}

const go = w => run({ env: ENV, fetch: w.fetch, provider: providerFor('api'), uuid, worker: null });

test('PHOTO_SOURCE=api is the upload API inbox', () => {
  assert.equal(providerFor('api'), api);
  assert.equal(api.source, 'api');
});

test('a sender\'s name gets its type\'s extension when it has none', () => {
  assert.equal(nameFor('IMG_0042.JPG', 'image/jpeg'), 'IMG_0042.JPG');
  assert.equal(nameFor('gauge board', 'image/png'), 'gauge board.png');
  assert.equal(nameFor('', 'image/heic'), 'photo.heic');
});

test('hints fill only what the photo leaves empty', () => {
  const placed = withHints({ lat: -27.1, lon: 152.1, placement: 'exif', taken_at: '2026-06-24T23:15:00Z', taken_source: 'exif' },
    { lat: -30, lon: 150, taken_at: '2026-01-01T00:00:00Z', caption: 'board', station_id: 's1' });
  assert.equal(placed.placement, 'exif');
  assert.equal(placed.lat, -27.1);
  assert.equal(placed.taken_source, 'exif');
  assert.equal(placed.caption, 'board');
  assert.equal(placed.station_id, 's1');
  const bare = withHints({}, { lat: -30.123456789, lon: 150, taken_at: '2026-01-01T00:00:00+10:00' });
  assert.deepEqual([bare.lat, bare.lon, bare.placement, bare.taken_at, bare.taken_source],
    [-30.1234568, 150, 'sender', '2026-01-01T00:00:00+10:00', 'sender']);
});

test('a waiting photo is filed as its sender\'s, logged, settled and cleared out of the inbox', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-1', file_name: 'IMG_0042.JPG', bytes: GPS, hints: { caption: 'gauge board', station_id: 'stn-7' } }]);
  const { ok, report } = await go(w);
  assert.ok(ok, JSON.stringify(report));
  assert.equal(w.rpc.length, 1);
  const p = w.rpc[0];
  assert.equal(p.origin, 'api');
  assert.equal(p.origin_ref, 'r-1');
  assert.equal(p.uploaded_by, 'api:Acme Surveys');
  assert.equal(p.caption, 'gauge board');
  assert.equal(p.station_id, 'stn-7');
  assert.equal(p.placement, 'exif', 'the photo\'s own GPS');
  assert.equal(p.meta.api.sent_by, 'Acme Surveys');
  assert.deepEqual(w.settled.map(s => [s.receipt, s.outcome, s.photo_id, s.station_id]), [['r-1', 'imported', 'row-1', 'stn-7']]);
  assert.deepEqual(w.cleared, ['r-1']);
  assert.equal(w.logged.length, 1);
  assert.equal(w.logged[0].origin, 'api');
  assert.equal(w.logged[0].uploaded_by, 'api:Acme Surveys');
  assert.equal(w.logged[0].outcome, 'imported');
  assert.equal(w.sync.source, 'api');
});

test('a photo that says nothing is placed and timed by its sender', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-2', file_name: 'board', bytes: PLAIN,
                         hints: { lat: -27.5, lon: 152.25, taken_at: '2026-11-26T09:30:00+10:00' } }]);
  const { ok, report } = await go(w);
  assert.ok(ok, JSON.stringify(report.detail.files));
  const p = w.rpc[0];
  assert.equal(p.title, 'board.jpg');
  assert.deepEqual([p.lat, p.lon, p.placement, p.taken_source], [-27.5, 152.25, 'sender', 'sender']);
  assert.equal(w.settled[0].outcome, 'imported');
});

test('a photo with nothing to place it is settled unplaced', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-3', file_name: 'x.jpg', bytes: PLAIN }]);
  await go(w);
  assert.equal(w.settled[0].outcome, 'unplaced');
  assert.deepEqual(w.cleared, ['r-3']);
});

test('a photo imported by a run that could not settle it is settled by the next, not imported twice', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-4', file_name: 'x.jpg', bytes: GPS }]);
  w.rows.push({ id: 'row-earlier', origin: 'api', origin_ref: 'r-4', lat: -27.5, station_id: 'gatton', sha256: 'x' });
  await go(w);
  assert.equal(w.rpc.length, 0);
  assert.deepEqual(w.settled.map(s => [s.outcome, s.photo_id]), [['imported', 'row-earlier']]);
  assert.deepEqual(w.cleared, ['r-4']);
});

test('bytes gone from the inbox are a refusal; a database that failed leaves it waiting', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-5', file_name: 'a.jpg', bytes: null }, { receipt: 'r-6', file_name: 'b.jpg', bytes: GPS }]);
  w.refuse = () => ({ status: 503, body: { message: 'database busy' } });
  const { report } = await go(w);
  assert.equal(report.failed, 2);
  const by = Object.fromEntries(w.settled.map(s => [s.receipt, s]));
  assert.equal(by['r-5'].outcome, 'refused');
  assert.equal(by['r-6'].outcome, 'failed');
  assert.deepEqual(w.cleared, ['r-5'], 'a failure keeps its bytes for the next run');
});

test('the same bytes already in Flood-Net are settled duplicate', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-7', file_name: 'a.jpg', bytes: GPS }]);
  w.refuse = () => ({ status: 409, body: { code: '23505', message: 'that photo is already in MegaNet', details: 'row-older' } });
  await go(w);
  assert.equal(w.settled[0].outcome, 'duplicate');
  assert.equal(w.settled[0].photo_id, 'row-older');
});

test('a station gone since the photo arrived: filed by its position instead', { timeout: 60000 }, async () => {
  const w = fakeWorld([{ receipt: 'r-8', file_name: 'a.jpg', bytes: GPS, hints: { station_id: 'gone' } }]);
  w.refuse = p => (p.station_id === 'gone' ? { status: 409, body: { code: '23503', message: 'no such station: gone' } } : null);
  const { ok } = await go(w);
  assert.ok(ok);
  assert.equal(w.rpc.length, 2);
  assert.equal(w.rpc[1].station_id, undefined);
  assert.equal(w.rpc[1].meta.api.station_gone, 'gone');
  assert.equal(w.settled[0].outcome, 'imported');
});
