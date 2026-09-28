// The Dropbox sync, run against a fake Dropbox and a fake MegaNet project —
// no network, and the real photo-meta.js and the real OCR engine over the two
// Solocator photos the Field Photos issue came with (their overlays; the
// middle of each is greyed out in the fixture).
//
// What has to hold, because each failure is silent: a photo read off its
// overlay lands where the overlay says; one with GPS in its EXIF is placed
// from that without the OCR engine being asked; the second run imports
// nothing; a photo somebody removed is never brought back; the cursor only
// moves when every photo in the listing was dealt with; a refused index row
// takes its bytes down again; and the run says what it did, in the table the
// tab reads.
//
//   cd tools/field-photos && npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/run.mjs';
import { readPhoto, PhotoMeta } from '../lib/read.mjs';
import { tiff, gpsEntries, jpegWith } from '../../../test/lib/exif.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', '..', '..', 'test', 'fixtures', 'photos');
const SW = fs.readFileSync(path.join(FIX, 'solocator-gatton-sw.jpg'));
const NE = fs.readFileSync(path.join(FIX, 'solocator-gatton-ne.jpg'));

// A photo with its GPS in the EXIF, the way a phone camera writes it.
const GPS = jpegWith(NE, { tiff: tiff({
  ifd0: [[0x010f, 2, 'Apple'], [0x0110, 2, 'iPhone 15'], [0x0112, 3, [1]]],
  exif: [[0x9003, 2, '2026:06:25 09:15:00'], [0x9011, 2, '+10:00'], [0xa405, 3, [26]]],
  gps: gpsEntries({ lat: -27.5561, lon: 152.2731, alt: 96.5, heading: 118.25, accuracy: 3.5, date: '2026:06:24', time: [23, 15, 0] }),
}) });

let enginePromise = null;
async function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
      return createWorker('eng', 1, { langPath, gzip: true, cachePath: os.tmpdir() });
    })();
  }
  return enginePromise;
}
// The engine, counting what it is asked — so "the OCR was not needed" is a
// number the test can read.
function countedEngine() {
  const c = { calls: 0 };
  c.setParameters = async p => (await engine()).setParameters(p);
  c.recognize = async (...a) => { c.calls++; return (await engine()).recognize(...a); };
  return c;
}

test.after(async () => { if (enginePromise) await (await enginePromise).terminate(); });

// ── The fakes ────────────────────────────────────────────────────────────────

function fakeWorld({ files = [], rows = [], cursor = null } = {}) {
  const w = {
    files: files.map((f, i) => ({ '.tag': 'file', id: `id:${f.name}`, name: f.name, path_display: `/${f.name}`,
                                  size: f.bytes.length, rev: `r${i}`, server_modified: `2026-06-24T02:2${i}:00Z`, bytes: f.bytes })),
    listedUpTo: 0,
    rows: rows.slice(),
    objects: new Map(),
    removed: [],
    rpc: [],
    sync: null,
    cursor,
    refuse: null,          // a function (p_photo) → { status, body } to refuse an add
    lookups: 0,            // origin_ref look-ups made — one per hundred files, not one per file
    tokenOk: true,
    resetCursor: false,
    calls: [],
  };
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    w.calls.push(`${method} ${u.host}${u.pathname}`);
    // Dropbox
    if (u.host === 'api.dropboxapi.com' && u.pathname === '/oauth2/token') {
      const f = new URLSearchParams(init.body);
      if (!w.tokenOk || f.get('refresh_token') !== 'refresh-fixture' || f.get('client_id') !== 'app-key-fixture') {
        return reply(400, { error: 'invalid_grant', error_description: 'refresh token is malformed' });
      }
      return reply(200, { access_token: 'access-fixture', expires_in: 14400 });
    }
    const authed = (init.headers || {}).Authorization === 'Bearer access-fixture';
    if (u.host === 'api.dropboxapi.com' && u.pathname === '/2/users/get_current_account') {
      return authed ? reply(200, { email: 'field@example.test', name: { display_name: 'Field Crew' } }) : reply(401, { error_summary: 'expired' });
    }
    if (u.host === 'api.dropboxapi.com' && u.pathname.startsWith('/2/files/list_folder')) {
      const args = JSON.parse(init.body);
      if (u.pathname.endsWith('/continue')) {
        if (w.resetCursor) { w.resetCursor = false; return reply(409, { error_summary: 'reset/..', error: { '.tag': 'reset' } }); }
        const from = Number(String(args.cursor).replace('cursor-', ''));
        return reply(200, { entries: w.files.slice(from).map(({ bytes, ...e }) => e), cursor: `cursor-${w.files.length}`, has_more: false });
      }
      return reply(200, { entries: w.files.map(({ bytes, ...e }) => e), cursor: `cursor-${w.files.length}`, has_more: false });
    }
    if (u.host === 'content.dropboxapi.com' && u.pathname === '/2/files/download') {
      const arg = JSON.parse(init.headers['Dropbox-API-Arg']);
      const f = w.files.find(x => x.id === arg.path);
      return f ? new Response(f.bytes, { status: 200 }) : reply(409, { error_summary: 'path/not_found' });
    }
    // The project
    if (u.host === 'project.test') {
      assert.equal(init.headers.apikey, 'secret-fixture', 'every project call carries the secret key');
      const p = u.pathname;
      if (p === '/rest/v1/field_photo_sync' && method === 'GET') return reply(200, w.sync ? [{ runs: w.sync.runs }] : []);
      if (p === '/rest/v1/field_photo_sync_cursor' && method === 'GET') return reply(200, w.cursor ? [{ cursor: w.cursor }] : []);
      if (p === '/rest/v1/field_photo_sync_cursor' && method === 'POST') { w.cursor = JSON.parse(init.body).cursor; return reply(201); }
      if (p === '/rest/v1/field_photo_sync' && method === 'POST') { w.sync = JSON.parse(init.body); return reply(201); }
      if (p === '/rest/v1/field_photo' && method === 'GET') {
        const q = u.searchParams;
        const ref = q.get('origin_ref'), sha = q.get('sha256');
        // `origin_ref=in.("id:a","id:b")` — the batch the run asks before it
        // starts — or `sha256=eq.…` for one photo's bytes.
        const refs = ref ? ref.replace(/^in\.\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')) : null;
        if (refs) w.lookups++;
        const hit = w.rows.filter(r => (refs ? refs.includes(r.origin_ref) && r.origin === 'dropbox' : true)
                                    && (sha ? `eq.${r.sha256}` === sha && !r.deleted_at : true));
        return reply(200, (refs ? hit : hit.slice(0, 1)).map(r => ({ id: r.id, origin_ref: r.origin_ref || null, deleted_at: r.deleted_at || null })));
      }
      if (p === '/rest/v1/rpc/add_field_photo') {
        const body = JSON.parse(init.body);
        w.rpc.push(body.p_photo);
        const no = w.refuse && w.refuse(body.p_photo);
        if (no) return reply(no.status, no.body);
        const row = Object.assign({ id: `row-${w.rows.length + 1}`, station_id: body.p_photo.lat ? 'gatton' : null, lat: body.p_photo.lat ?? null }, body.p_photo);
        w.rows.push(row);
        return reply(200, row);
      }
      if (p.startsWith('/storage/v1/object/field-photos/')) {
        const key = p.replace('/storage/v1/object/field-photos/', '');
        if (method === 'POST') { w.objects.set(key, { type: init.headers['Content-Type'], bytes: Buffer.from(init.body).length }); return reply(200, { Key: key }); }
        if (method === 'DELETE') { w.removed.push(key); w.objects.delete(key); return reply(200, {}); }
      }
    }
    return reply(404, { message: `the fixture does not answer ${method} ${url}` });
  };
  return w;
}

const ENV = { DROPBOX_APP_KEY: 'app-key-fixture', DROPBOX_REFRESH_TOKEN: 'refresh-fixture',
              SUPABASE_URL: 'https://project.test', SUPABASE_SECRET_KEY: 'secret-fixture' };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// ── Reading ───────────────────────────────────────────────────────────────────

test('a photo read off its overlay lands where the overlay says, with its heading and time', { timeout: 120000 }, async () => {
  const r = await readPhoto(SW, { name: 'IMG_0042.jpg', worker: countedEngine(), home: { lat: -25, lon: 145 } });
  assert.equal(r.pos.placement, 'ocr');
  assert.equal(r.pos.lat, -27.554294);
  assert.equal(r.pos.lon, 152.274116);
  assert.equal(r.pos.confidence, 'high');
  assert.equal(r.pos.accuracy, 4);
  assert.deepEqual(r.heading, { deg: 242, ref: 'T' });
  assert.deepEqual(r.altitude, { m: 134, ref: 'HAE' });
  assert.equal(r.taken.local, '2026-06-24T12:26:08');
  assert.equal(r.taken.iso, '2026-06-24T02:26:08.000Z');
  assert.equal(r.taken.zone, 'printed');
  assert.ok(r.thumb && r.thumb.length > 1000 && r.thumb[0] === 0xff && r.thumb[1] === 0xd8, 'a JPEG thumbnail');
  assert.equal(r.contentType, 'image/jpeg');
  assert.equal(r.upload, SW, 'a JPEG is stored as it came');
  assert.match(r.sha, /^[0-9a-f]{64}$/);
});

test('a photo with GPS in its EXIF is placed from that, and the OCR engine is never asked', async () => {
  const eng = countedEngine();
  const r = await readPhoto(GPS, { name: 'IMG_0100.JPG', worker: eng });
  assert.equal(eng.calls, 0);
  assert.equal(r.pos.placement, 'exif');
  assert.ok(Math.abs(r.pos.lat - -27.5561) < 1e-6 && Math.abs(r.pos.lon - 152.2731) < 1e-6, JSON.stringify(r.pos));
  assert.equal(r.pos.accuracy, 3.5);
  assert.deepEqual(r.heading, { deg: 118.25, ref: 'T' });
  assert.equal(r.taken.iso, '2026-06-24T23:15:00.000Z');
  assert.ok(r.fov > 60 && r.fov < 75, `a 26 mm lens is about 67° across, not ${r.fov}`);
  const p = PhotoMeta.record(r);
  assert.equal(p.placement, 'exif');
  assert.equal(p.meta.camera.model, 'iPhone 15');
});

// ── Running ───────────────────────────────────────────────────────────────────

test('the first run imports both photos, placed, filed and reported; the second imports nothing', { timeout: 180000 }, async () => {
  const w = fakeWorld({ files: [{ name: 'IMG_0042.jpg', bytes: SW }, { name: 'IMG_0043.jpg', bytes: NE }, { name: 'notes.txt', bytes: Buffer.from('hello') }] });
  const one = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid, now: () => new Date('2026-06-24T03:00:00Z') });
  assert.equal(one.ok, true, JSON.stringify(one.report));
  assert.equal(one.report.seen, 2, 'the text file is not a photo');
  assert.equal(one.report.imported, 2);
  assert.equal(w.rpc.length, 2);
  const [a, b] = w.rpc;
  assert.equal(a.origin, 'dropbox');
  assert.equal(a.origin_ref, 'id:IMG_0042.jpg');
  assert.equal(a.uploaded_by, 'Dropbox — field@example.test');
  assert.equal(a.placement, 'ocr');
  assert.equal(a.lat, -27.554294);
  assert.equal(a.heading_deg, 242);
  assert.equal(a.taken_at, '2026-06-24T02:26:08.000Z');
  assert.equal(b.lat, -27.5543);
  assert.equal(b.heading_deg, 46);
  assert.ok(!('station_id' in a), 'the station is the database\'s to pick by distance');
  assert.match(a.storage_path, /^photo\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(a.thumb_path, a.storage_path.replace('.jpg', '.thumb.jpg'));
  assert.ok(w.objects.has(a.storage_path) && w.objects.has(a.thumb_path), 'the photo and its thumbnail are in the bucket');
  assert.equal(a.meta.dropbox.path, '/IMG_0042.jpg');
  assert.ok(a.meta.ocr && a.meta.ocr.texts.length >= 2, 'what the OCR read is kept');
  assert.equal(w.cursor, 'cursor-3', 'the cursor moved on');
  assert.equal(w.sync.runs, 1);
  assert.equal(w.sync.account, 'field@example.test');
  assert.equal(w.sync.last_error, null);
  assert.ok(w.sync.last_ok_at);

  const two = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(two.report.seen, 0);
  assert.equal(two.report.imported, 0);
  assert.equal(w.sync.runs, 2, 'every run reports, a quiet one included');
});

test('a photo somebody removed is never brought back, and one already dropped in by hand is not doubled', async () => {
  const sha = (await readPhoto(GPS, { name: 'x' })).sha;
  const w = fakeWorld({
    files: [{ name: 'IMG_0100.JPG', bytes: GPS }, { name: 'gone.jpg', bytes: SW }],
    rows: [
      { id: 'removed-1', origin: 'dropbox', origin_ref: 'id:gone.jpg', sha256: 'f'.repeat(64), deleted_at: '2026-06-25T00:00:00Z' },
      { id: 'by-hand-1', origin: 'upload', origin_ref: null, sha256: sha },
    ],
  });
  const out = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(out.report.imported, 0);
  assert.equal(out.report.skipped, 2);
  assert.equal(w.rpc.length, 0);
  assert.equal(w.objects.size, 0, 'nothing was uploaded for either');
  const reasons = out.report.detail.files.map(f => f.reason).join(' | ');
  assert.match(reasons, /removed from MegaNet/);
  assert.match(reasons, /already in MegaNet/);
});

test('a refused index row takes its bytes down again', async () => {
  const w = fakeWorld({ files: [{ name: 'IMG_0100.JPG', bytes: GPS }] });
  w.refuse = () => ({ status: 409, body: { code: '23505', message: 'this photo is already in MegaNet', details: 'row-9' } });
  const out = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(out.report.skipped, 1);
  assert.equal(w.objects.size, 0);
  assert.equal(w.removed.length, 2, 'the photo and its thumbnail');
});

test('a run that stops early leaves the cursor where it was, and the next run finishes the job', async () => {
  const w = fakeWorld({ files: [{ name: 'a.jpg', bytes: GPS }, { name: 'b.jpg', bytes: jpegWith(SW, { tiff: tiff({ gps: gpsEntries({ lat: -27.55, lon: 152.27 }) }) }) }] });
  const one = await run({ env: { ...ENV, MAX_FILES: '1' }, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(one.report.imported, 1);
  assert.equal(one.report.detail.complete, false);
  assert.equal(w.cursor, null, 'not moved');
  const two = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(two.report.imported, 1, 'the second photo');
  assert.equal(two.report.skipped, 1, 'the first, already imported');
  assert.equal(w.cursor, 'cursor-2');
});

test('a backlog longer than the cap is worked through run after run — what came in before is skipped in one look-up and never counted against the cap', async () => {
  // Three phone photos with GPS and a time in their EXIF, so no OCR.
  const phone = (lat) => jpegWith(SW, { tiff: tiff({
    exif: [[0x9003, 2, '2026:06:24 12:26:08'], [0x9011, 2, '+10:00']],
    gps: gpsEntries({ lat, lon: 152.27 }),
  }) });
  const w = fakeWorld({ files: [{ name: 'a.jpg', bytes: phone(-27.551) }, { name: 'b.jpg', bytes: phone(-27.552) }, { name: 'c.jpg', bytes: phone(-27.553) }] });
  const env = { ...ENV, MAX_FILES: '1' };
  const eng = countedEngine();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const before = w.lookups;
    const out = await run({ env, fetch: w.fetch, worker: eng, uuid });
    runs.push({ imported: out.report.imported, skipped: out.report.skipped, lookups: w.lookups - before, complete: out.report.detail.complete });
  }
  assert.deepEqual(runs.map(r => r.imported), [1, 1, 1], JSON.stringify(runs));
  assert.deepEqual(runs.map(r => r.skipped), [0, 1, 2], JSON.stringify(runs));
  assert.deepEqual(runs.map(r => r.lookups), [1, 1, 1], 'one look-up a run, whatever the listing holds');
  assert.deepEqual(runs.map(r => r.complete), [false, false, true]);
  assert.equal(w.cursor, 'cursor-3', 'the cursor moves on once the last of the backlog is in');
  assert.equal(w.rpc.length, 3);
  assert.equal(eng.calls, 0, 'the EXIF placed all three');
});

test('a cursor Dropbox has reset is started over, safely', async () => {
  const w = fakeWorld({ files: [{ name: 'a.jpg', bytes: GPS }], cursor: 'cursor-0' });
  w.resetCursor = true;
  const out = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(out.ok, true, JSON.stringify(out.report));
  assert.equal(out.report.imported, 1);
  assert.equal(w.cursor, 'cursor-1');
});

test('a refresh token Dropbox will not take fails the run out loud, and says so in the report', async () => {
  const w = fakeWorld({ files: [{ name: 'a.jpg', bytes: GPS }], cursor: 'cursor-0' });
  w.tokenOk = false;
  const out = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(out.ok, false);
  assert.match(w.sync.last_error, /token refresh/);
  assert.equal(w.cursor, 'cursor-0', 'the cursor is untouched');
  assert.ok(!('last_ok_at' in w.sync), 'the last good run keeps its time');
});

test('with no Dropbox configured it says which settings are missing', async () => {
  const w = fakeWorld();
  const out = await run({ env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SECRET_KEY: ENV.SUPABASE_SECRET_KEY }, fetch: w.fetch, uuid });
  assert.equal(out.ok, false);
  assert.match(out.report.last_error, /DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN/);
});

// ── Zip packs ─────────────────────────────────────────────────────────────────

test('a zip saved into the Dropbox folder: each photo in it comes in as a photo of its own, and the rest of the zip is left alone', async () => {
  // Two phone photos, a macOS resource fork and a readme, zipped by Info-ZIP
  // (test/zip.test.mjs has what is in it).
  const PACK = fs.readFileSync(path.join(HERE, 'fixtures', 'pack.zip'));
  const w = fakeWorld({ files: [{ name: 'Gatton 23 June.zip', bytes: PACK }] });
  const eng = countedEngine();
  const one = await run({ env: ENV, fetch: w.fetch, worker: eng, uuid });
  assert.equal(one.ok, true, JSON.stringify(one.report));
  assert.equal(one.report.seen, 2, 'the two photos in it — not the zip, the fork or the readme');
  assert.equal(one.report.imported, 2);
  assert.deepEqual(w.rpc.map(p => p.origin_ref), ['id:Gatton 23 June.zip#DCIM/IMG_1001.jpg', 'id:Gatton 23 June.zip#DCIM/IMG_1002.jpg']);
  const [a, b] = w.rpc;
  assert.equal(a.origin, 'dropbox');
  assert.equal(a.title, 'IMG_1001.jpg', 'its own name, not the zip\'s');
  assert.equal(a.uploaded_by, 'Dropbox — field@example.test');
  assert.equal(a.placement, 'exif');
  assert.ok(Math.abs(a.lat - -27.5549) < 1e-6 && Math.abs(b.lat - -27.5551) < 1e-6);
  assert.equal(a.meta.dropbox.path, '/Gatton 23 June.zip', 'the Dropbox file is the zip');
  assert.deepEqual(a.meta.dropbox.archive, { name: 'Gatton 23 June.zip', path: 'DCIM/IMG_1001.jpg' });
  assert.equal(eng.calls, 0, 'both placed by their EXIF');
  assert.deepEqual(one.report.detail.files.map(f => f.path),
    ['/Gatton 23 June.zip › DCIM/IMG_1001.jpg', '/Gatton 23 June.zip › DCIM/IMG_1002.jpg']);
  assert.equal(w.cursor, 'cursor-1', 'the cursor moved past the zip');

  const two = await run({ env: ENV, fetch: w.fetch, worker: eng, uuid });
  assert.equal(two.report.seen, 0, 'a finished zip is not opened again');
  assert.equal(w.rpc.length, 2);
});

test('a zip that cannot be opened is skipped with its reason, and a damaged one fails — neither stops the run', async () => {
  const PACK = fs.readFileSync(path.join(HERE, 'fixtures', 'pack.zip'));
  const locked = Buffer.from(PACK);
  for (let p = locked.readUInt32LE(locked.length - 22 + 16); locked.readUInt32LE(p) === 0x02014b50;) {
    locked.writeUInt16LE(locked.readUInt16LE(p + 8) | 1, p + 8);
    p += 46 + locked.readUInt16LE(p + 28) + locked.readUInt16LE(p + 30) + locked.readUInt16LE(p + 32);
  }
  const w = fakeWorld({ files: [
    { name: 'locked.zip', bytes: locked },
    { name: 'truncated.zip', bytes: PACK.subarray(0, 1000) },
    { name: 'IMG_0100.JPG', bytes: GPS },
  ] });
  const out = await run({ env: ENV, fetch: w.fetch, worker: countedEngine(), uuid });
  assert.equal(out.report.imported, 1, 'the loose photo');
  assert.equal(out.report.skipped, 1);
  assert.equal(out.report.failed, 1);
  assert.equal(out.ok, false, 'a damaged zip is a failure to look at');
  const why = Object.fromEntries(out.report.detail.files.map(f => [f.name, `${f.result}: ${f.reason}`]));
  assert.match(why['locked.zip'], /^skipped: it is password-protected/);
  assert.match(why['truncated.zip'], /^failed: not a zip file, or not the whole of one/);
  assert.equal(w.cursor, 'cursor-3', 'dealt with, all three: the cursor moves on');
});
