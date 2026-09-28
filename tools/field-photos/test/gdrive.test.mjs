// The Google Drive sync, run against a fake Google and a fake MegaNet project —
// no network. The fake Google is strict where the real one is: the token
// endpoint checks the JWT's RS256 signature against the public half of a key
// pair made here, and its claims; files.list pages two at a time and answers
// only `'<folder>' in parents and trashed = false`; a download needs the token.
//
// What has to hold, because each failure is silent: every folder under the
// linked one is read, and nothing but files with bytes of their own — not a
// Google Doc, not a shortcut, not what is in the bin; a zip's photos come in as
// photos of their own, and a run that stops inside a zip carries on from it;
// the second run downloads nothing at all; a photo removed from MegaNet is
// never brought back, even when the file changes in Drive; what a run could not
// take is not tried again every fifteen minutes; and whatever is wrong with the
// key or the folder is said in a sentence — never with the key in it.
//
//   cd tools/field-photos && npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { run, providerFor } from '../lib/run.mjs';
import { gdrive, folderId, walk } from '../lib/gdrive.mjs';
import { tiff, gpsEntries, jpegWith } from '../../../test/lib/exif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = fs.readFileSync(path.join(HERE, 'fixtures', 'pack.zip'));   // two photos, a macOS fork, a readme (zip.test.mjs)

// A small phone photo — GPS and a time in its EXIF, so it is placed without
// the OCR engine — different for every seed.
function phone(seed, lat = -27.5543, lon = 152.2741) {
  const w = 40, h = 30, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 7 + seed * 50) & 255; data[i * 4 + 1] = (i * 3 + seed * 20) & 255;
    data[i * 4 + 2] = (seed * 90) & 255; data[i * 4 + 3] = 255;
  }
  return jpegWith(Buffer.from(jpeg.encode({ data, width: w, height: h }, 85).data), { tiff: tiff({
    exif: [[0x9003, 2, '2026:06:24 12:26:08'], [0x9011, 2, '+10:00']],
    gps: gpsEntries({ lat, lon }),
  }) });
}

// ── The service account ──────────────────────────────────────────────────────

const EMAIL = 'field-photos@meganet-fixture.iam.gserviceaccount.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
// The JSON Google hands over for a key, laid out as it downloads.
const keyFile = (key = privateKey) => JSON.stringify({
  type: 'service_account', project_id: 'meganet-fixture', private_key_id: 'fixture-key-1',
  private_key: key.export({ type: 'pkcs8', format: 'pem' }), client_email: EMAIL, client_id: '100000000000000000001',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
}, null, 2);

// ── The fakes ────────────────────────────────────────────────────────────────

const FOLDER = 'application/vnd.google-apps.folder';
const ROOT = '1FieldPhotosRootFolder00000000000';
let clock = 0;
const file = (id, name, parent, bytes, extra = {}) => ({
  id, name, parent, bytes, mimeType: /\.zip$/.test(name) ? 'application/zip' : /\.txt$/.test(name) ? 'text/plain' : 'image/jpeg',
  modifiedTime: new Date(Date.UTC(2026, 5, 24, 2, 0, ++clock)).toISOString(), createdTime: '2026-06-24T01:00:00.000Z',
  owners: [{ emailAddress: 'crew@example.test' }], ...extra,
});
const folder = (id, name, parent) => ({ id, name, parent, mimeType: FOLDER });

// Split a PostgREST `in.("a","b,c")` list the way PostgREST does.
function inList(v) {
  const s = v.replace(/^in\.\(/, '').replace(/\)$/, '');
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted && c === '\\') { cur += s[++i]; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (!quoted && c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function fakeWorld({ items = [], rows = [], drive = null, owner = 'crew.lead@example.test' } = {}) {
  const w = {
    items: [{ id: ROOT, name: 'Field photos', mimeType: FOLDER, owners: owner ? [{ emailAddress: owner }] : undefined }, ...items],
    drive,                 // a Shared Drive's id, when the folder is in one
    pageSize: 2,           // files.list answers two at a time, so every walk pages
    rows: rows.slice(), objects: new Map(), removed: [], rpc: [], log: [],
    sync: null, cursor: null, cursorWrites: 0,
    origins: new Set(['upload', 'dropbox', 'gdrive']),
    downloads: [], lists: 0, lookups: 0, tokens: 0, logMissing: false,
  };
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const md5 = b => crypto.createHash('md5').update(b).digest('hex');
  const resource = it => {
    const own = it.mimeType.startsWith('application/vnd.google-apps.');
    return {
      id: it.id, name: it.name, mimeType: it.mimeType, ...(it.parent ? { parents: [it.parent] } : {}),
      ...(own ? {} : { size: String(it.size ?? it.bytes.length), md5Checksum: md5(it.bytes) }),
      modifiedTime: it.modifiedTime || '2026-06-24T00:00:00.000Z', createdTime: it.createdTime || '2026-06-24T00:00:00.000Z',
      ...(w.drive ? { driveId: w.drive } : it.owners ? { owners: it.owners } : {}),
    };
  };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    // Google's token endpoint: a JWT, signed by the key this test made.
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      assert.equal(method, 'POST');
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, c, s] = String(form.get('assertion')).split('.');
      if (!crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s || '', 'base64url'))) {
        return reply(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      }
      const head = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(c, 'base64url'));
      assert.equal(head.alg, 'RS256');
      assert.equal(claims.iss, EMAIL);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly', 'read-only, and nothing else');
      assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
      assert.equal(claims.exp - claims.iat, 3600);
      w.tokens++;
      return reply(200, { access_token: 'ya29.fixture', expires_in: 3599, token_type: 'Bearer' });
    }
    // The Drive API.
    if (u.host === 'www.googleapis.com') {
      if ((init.headers || {}).Authorization !== 'Bearer ya29.fixture') {
        return reply(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', errors: [{ reason: 'authError' }] } });
      }
      const q = u.searchParams;
      if (u.pathname === '/drive/v3/files') {
        w.lists++;
        assert.equal(q.get('supportsAllDrives'), 'true');
        assert.equal(q.get('includeItemsFromAllDrives'), 'true');
        assert.match(q.get('fields'), /^nextPageToken,files\(/);
        if (w.drive) { assert.equal(q.get('corpora'), 'drive'); assert.equal(q.get('driveId'), w.drive); }
        else assert.equal(q.get('corpora'), null);
        const m = /^'([^']+)' in parents and trashed = false$/.exec(q.get('q'));
        assert.ok(m, `the fixture answers a folder's children, not ${q.get('q')}`);
        const kids = w.items.filter(x => x.parent === m[1] && !x.trashed);
        const from = Number(q.get('pageToken') || 0);
        const next = from + w.pageSize < kids.length ? String(from + w.pageSize) : null;
        return reply(200, { files: kids.slice(from, from + w.pageSize).map(resource), ...(next ? { nextPageToken: next } : {}) });
      }
      const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
      if (one) {
        const it = w.items.find(x => x.id === decodeURIComponent(one[1]));
        if (!it) return reply(404, { error: { code: 404, message: `File not found: ${one[1]}.`, errors: [{ reason: 'notFound' }] } });
        assert.equal(q.get('supportsAllDrives'), 'true');
        if (q.get('alt') === 'media') {
          if (w.flaky === it.id) return reply(503, { error: { code: 503, message: 'The service is currently unavailable.', errors: [{ reason: 'backendError' }] } });
          if (it.mimeType.startsWith('application/vnd.google-apps.')) {
            return reply(403, { error: { code: 403, message: 'Only files with binary content can be downloaded.', errors: [{ reason: 'fileNotDownloadable' }] } });
          }
          w.downloads.push(it.name);
          return new Response(it.bytes, { status: 200 });
        }
        return reply(200, resource(it));
      }
    }
    // The project — as the Dropbox tests' fake, for whichever origin it is asked.
    if (u.host === 'project.test') {
      assert.equal(init.headers.apikey, 'secret-fixture', 'every project call carries the secret key');
      const p = u.pathname, q = u.searchParams;
      if (p === '/rest/v1/field_photo_sync' && method === 'GET') { assert.equal(q.get('source'), 'eq.gdrive'); return reply(200, w.sync ? [{ runs: w.sync.runs }] : []); }
      if (p === '/rest/v1/field_photo_sync_cursor' && method === 'GET') { assert.equal(q.get('source'), 'eq.gdrive'); return reply(200, w.cursor ? [{ cursor: w.cursor }] : []); }
      if (p === '/rest/v1/field_photo_sync_cursor' && method === 'POST') {
        const b = JSON.parse(init.body);
        assert.equal(b.source, 'gdrive');
        w.cursor = b.cursor; w.cursorWrites++;
        return reply(201);
      }
      if (p === '/rest/v1/field_photo_sync' && method === 'POST') { w.sync = JSON.parse(init.body); return reply(201); }
      if (p === '/rest/v1/field_photo' && method === 'GET') {
        const ref = q.get('origin_ref'), sha = q.get('sha256');
        const refs = ref ? inList(ref) : null;
        if (refs) { w.lookups++; assert.equal(q.get('origin'), 'eq.gdrive'); }
        const hit = w.rows.filter(r => (refs ? refs.includes(r.origin_ref) && r.origin === 'gdrive' : true)
                                    && (sha ? `eq.${r.sha256}` === sha && !r.deleted_at : true));
        return reply(200, (refs ? hit : hit.slice(0, 1)).map(r => ({ id: r.id, origin_ref: r.origin_ref || null, deleted_at: r.deleted_at || null })));
      }
      if (p === '/rest/v1/rpc/add_field_photo') {
        const ph = JSON.parse(init.body).p_photo;
        w.rpc.push(ph);
        // What 0035's add_field_photo() refuses, as PostgREST says it.
        if (!w.origins.has(ph.origin)) return reply(409, { code: '23503', message: `${ph.origin} is not a way in for a field photo` });
        const same = w.rows.find(r => (r.origin === ph.origin && r.origin_ref === ph.origin_ref) || (r.sha256 === ph.sha256 && !r.deleted_at));
        if (same) return reply(409, { code: '23505', message: 'that file has already been imported', details: same.id });
        const row = Object.assign({ id: `row-${w.rows.length + 1}`, station_id: ph.lat ? 'gatton' : null, lat: ph.lat ?? null }, ph);
        w.rows.push(row);
        return reply(200, row);
      }
      if (p === '/rest/v1/rpc/log_field_photo_upload') {
        if (w.logMissing) return reply(404, { code: 'PGRST202', message: 'Could not find the function meganet.log_field_photo_upload(p_rows) in the schema cache' });
        w.log.push(...JSON.parse(init.body).p_rows);
        return reply(204);
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

const ENV = { PHOTO_SOURCE: 'gdrive', GDRIVE_SERVICE_ACCOUNT_JSON: keyFile(), GDRIVE_FOLDER_ID: ROOT,
              SUPABASE_URL: 'https://project.test', SUPABASE_SECRET_KEY: 'secret-fixture' };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const sync = (w, env = {}, more = {}) => run({ env: { ...ENV, ...env }, fetch: w.fetch, uuid, provider: gdrive, ...more });

// ── The runs ─────────────────────────────────────────────────────────────────

test('the folder and every folder under it are imported, and the photos in a zip in it — Google Docs, shortcuts and the bin left alone; the second run downloads nothing', async () => {
  const w = fakeWorld({ items: [
    file('photo-a', 'a.jpg', ROOT, phone(1)),
    folder('folder-site-a', 'Site A', ROOT),
    file('photo-site-a', 'IMG_0100.JPG', 'folder-site-a', phone(2, -27.5551, 152.2745)),
    folder('folder-deeper', 'Deeper', 'folder-site-a'),
    file('photo-deeper', 'b.jpeg', 'folder-deeper', phone(3, -27.5549, 152.2739)),
    file('zip-1', 'pack.zip', ROOT, PACK),
    { id: 'doc-1', name: 'Site notes', parent: ROOT, mimeType: 'application/vnd.google-apps.document' },
    { id: 'shortcut-1', name: 'shortcut.jpg', parent: ROOT, mimeType: 'application/vnd.google-apps.shortcut' },
    file('photo-binned', 'binned.jpg', ROOT, phone(4), { trashed: true }),
    file('text-1', 'notes.txt', ROOT, Buffer.from('not a photo')),
  ] });
  // The folder given as the link the address bar shows.
  const lines = [];
  const one = await sync(w, { GDRIVE_FOLDER_ID: `https://drive.google.com/drive/u/0/folders/${ROOT}?usp=sharing` }, { log: s => lines.push(s) });
  assert.equal(one.ok, true, JSON.stringify(one.report));
  assert.equal(one.report.seen, 5, 'three photos, and the two in the zip');
  assert.equal(one.report.imported, 5);
  assert.deepEqual(w.rpc.map(p => p.origin_ref).sort(),
    ['photo-a', 'photo-deeper', 'photo-site-a', 'zip-1#DCIM/IMG_1001.jpg', 'zip-1#DCIM/IMG_1002.jpg']);
  assert.ok(w.rpc.every(p => p.origin === 'gdrive' && p.uploaded_by === 'Google Drive — crew.lead@example.test'), 'filed as from Google Drive, the folder owner\'s');
  assert.deepEqual(w.downloads.sort(), ['IMG_0100.JPG', 'a.jpg', 'b.jpeg', 'pack.zip'], 'no Doc, no shortcut, nothing from the bin, no text file');
  assert.equal(w.lists, 5, 'the linked folder in three pages of two, and a page for each folder under it');

  const deep = w.rpc.find(p => p.origin_ref === 'photo-site-a');
  assert.equal(deep.title, 'IMG_0100.JPG');
  assert.equal(deep.placement, 'exif');
  assert.equal(deep.meta.gdrive.path, '/Field photos/Site A/IMG_0100.JPG');
  assert.equal(deep.meta.gdrive.id, 'photo-site-a');
  assert.equal(deep.meta.gdrive.owner, 'crew@example.test');
  assert.match(deep.meta.gdrive.md5, /^[0-9a-f]{32}$/);
  assert.ok(deep.meta.gdrive.modifiedTime && deep.meta.gdrive.createdTime);

  const zipped = w.rpc.find(p => p.origin_ref === 'zip-1#DCIM/IMG_1001.jpg');
  assert.equal(zipped.title, 'IMG_1001.jpg', 'its own name, not the zip\'s');
  assert.deepEqual(zipped.meta.gdrive.archive, { name: 'pack.zip', path: 'DCIM/IMG_1001.jpg' });
  assert.equal(zipped.meta.gdrive.path, '/Field photos/pack.zip');
  assert.ok(!w.rpc.some(p => /^\._|readme/.test(p.title)), 'the macOS fork and the readme in the zip are not photos');
  assert.equal(w.objects.size, 10, 'five photos and five thumbnails');

  assert.equal(w.sync.source, 'gdrive');
  assert.equal(w.sync.folder, 'Field photos');
  assert.equal(w.sync.account, EMAIL);
  assert.equal(w.sync.last_error, null);
  assert.equal(w.sync.runs, 1);
  assert.equal(w.sync.detail.complete, true);
  const cursor = JSON.parse(w.cursor);
  assert.equal(cursor.v, 1);
  assert.equal(cursor.folder, ROOT);
  assert.equal(cursor.files, 5, 'every file with bytes of its own: the four read, and the text file');
  assert.ok(lines.some(l => /^3 new or changed photos and 1 zip in Field photos, Google Drive \(shared with field-photos@/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /^ {2}\/Field photos\/pack\.zip: 2 photos in it, and 2 other files left alone$/.test(l)), lines.join('\n'));

  // The upload log: a row for each photo tried, one batch.
  assert.equal(w.log.length, 5);
  assert.ok(w.log.every(r => r.origin === 'gdrive' && r.outcome === 'imported' && r.batch_id === w.log[0].batch_id), JSON.stringify(w.log));
  assert.match(w.log[0].batch_id, /^[0-9a-f-]{36}$/);
  const logged = w.log.find(r => r.archive_name);
  assert.equal(logged.archive_name, 'pack.zip');
  assert.match(logged.file_name, /^DCIM\/IMG_100[12]\.jpg$/);
  assert.match(logged.sha256, /^[0-9a-f]{64}$/);
  assert.equal(w.log.find(r => r.file_name === 'a.jpg').archive_name, null);
  assert.ok(w.log.every(r => r.photo_id && r.station_id === 'gatton' && r.uploaded_by === 'Google Drive — crew.lead@example.test'));
  assert.deepEqual(Object.keys(w.log[0]), ['attempted_at', 'origin', 'batch_id', 'file_name', 'archive_name', 'sha256', 'byte_size',
                                           'outcome', 'reason', 'photo_id', 'station_id', 'uploaded_by']);

  const lookups = w.lookups;
  const two = await sync(w);
  assert.equal(two.ok, true);
  assert.equal(two.report.seen, 0);
  assert.equal(two.report.imported, 0);
  assert.equal(w.downloads.length, 4, 'nothing downloaded again');
  assert.equal(w.lookups, lookups, 'and nothing asked of the project: the cursor knew');
  assert.equal(w.log.length, 5, 'a quiet run tried nothing, and logs nothing');
  assert.equal(w.sync.runs, 2, 'every run reports, a quiet one included');
});

test('a photo removed from MegaNet stays removed — changed in Drive or not — and one added later is the only one looked at', async () => {
  const w = fakeWorld({
    items: [file('photo-x', 'x.jpg', ROOT, phone(5)), file('photo-y', 'y.jpg', ROOT, phone(6))],
    rows: [{ id: 'removed-y', origin: 'gdrive', origin_ref: 'photo-y', sha256: 'e'.repeat(64), deleted_at: '2026-06-25T00:00:00Z' }],
  });
  const one = await sync(w);
  assert.equal(one.report.imported, 1);
  assert.equal(one.report.skipped, 1);
  assert.match(one.report.detail.files.find(f => f.name === 'y.jpg').reason, /removed from MegaNet — not brought back/);
  assert.deepEqual(w.downloads, ['x.jpg'], 'a removed photo is not even downloaded');

  // Somebody removes x in MegaNet, then edits it in Drive (a new version);
  // and somebody adds z.
  w.rows.find(r => r.origin_ref === 'photo-x').deleted_at = '2026-06-26T00:00:00Z';
  w.items.find(x => x.id === 'photo-x').bytes = phone(7);
  w.items.push(file('photo-z', 'z.jpg', ROOT, phone(8)));
  const two = await sync(w);
  assert.equal(two.report.seen, 2, 'x changed, z new — y, unchanged, is not looked at again');
  assert.equal(two.report.imported, 1);
  assert.equal(two.report.skipped, 1);
  assert.match(two.report.detail.files.find(f => f.name === 'x.jpg').reason, /removed from MegaNet/);
  assert.deepEqual(w.downloads, ['x.jpg', 'z.jpg']);
  assert.deepEqual(w.rpc.map(p => p.origin_ref), ['photo-x', 'photo-z']);
});

test('a run that stops inside a zip leaves the cursor, the next carries on from the zip, and a finished zip is not opened again', async () => {
  const w = fakeWorld({ items: [file('zip-2', 'site visit.zip', ROOT, PACK)] });
  const one = await sync(w, { MAX_FILES: '1' });
  assert.equal(one.ok, true, JSON.stringify(one.report));
  assert.equal(one.report.seen, 2);
  assert.equal(one.report.imported, 1);
  assert.equal(one.report.detail.complete, false);
  assert.equal(w.cursor, null, 'not moved');

  const two = await sync(w, { MAX_FILES: '1' });
  assert.equal(two.report.skipped, 1, 'the first photo, imported last run');
  assert.equal(two.report.imported, 1, 'the second');
  assert.equal(two.report.detail.complete, true);
  assert.ok(w.cursor, 'moved on');
  assert.deepEqual(w.rpc.map(p => p.origin_ref), ['zip-2#DCIM/IMG_1001.jpg', 'zip-2#DCIM/IMG_1002.jpg']);

  const three = await sync(w);
  assert.equal(three.report.seen, 0);
  assert.equal(w.downloads.length, 2, 'the zip twice — the run that stopped in it and the one that finished it — and not again');
});

test('what a run could not take — a photo over 24 MB, a zip with a password — is dealt with once, not every fifteen minutes', async () => {
  const locked = Buffer.from(PACK);
  for (let p = locked.readUInt32LE(locked.length - 22 + 16); locked.readUInt32LE(p) === 0x02014b50;) {
    locked.writeUInt16LE(locked.readUInt16LE(p + 8) | 1, p + 8);        // every entry "encrypted"
    p += 46 + locked.readUInt16LE(p + 28) + locked.readUInt16LE(p + 30) + locked.readUInt16LE(p + 32);
  }
  const w = fakeWorld({ items: [
    file('photo-huge', 'panorama.jpg', ROOT, phone(9), { size: 30 * 1024 * 1024 }),
    file('zip-locked', 'locked.zip', ROOT, locked),
  ] });
  const one = await sync(w);
  assert.equal(one.ok, true, 'skipped with a reason is not a failure');
  assert.equal(one.report.seen, 2);
  assert.equal(one.report.skipped, 2);
  const why = Object.fromEntries(one.report.detail.files.map(f => [f.name, f.reason]));
  assert.match(why['panorama.jpg'], /30\.0 MB is over the 24 MB a photo may be/);
  assert.match(why['locked.zip'], /password-protected/);
  assert.deepEqual(w.downloads, ['locked.zip'], 'the panorama is never downloaded');
  assert.deepEqual(w.log.map(r => [r.file_name, r.outcome]), [['panorama.jpg', 'refused'], ['locked.zip', 'refused']]);

  const two = await sync(w);
  assert.equal(two.report.seen, 0);
  assert.deepEqual(w.downloads, ['locked.zip'], 'and neither is looked at again until it changes');
});

test('a folder in a Shared Drive is listed from that drive, and its photos are filed as the service account\'s; the key may be given as base64', async () => {
  const w = fakeWorld({ drive: '0ASharedDriveFixture', owner: null, items: [
    folder('folder-2026', '2026', ROOT),
    file('photo-shared', 'IMG_2001.jpg', 'folder-2026', phone(10)),
  ] });
  const out = await sync(w, { GDRIVE_SERVICE_ACCOUNT_JSON: Buffer.from(keyFile()).toString('base64') });
  assert.equal(out.ok, true, JSON.stringify(out.report));
  assert.equal(out.report.imported, 1);
  assert.equal(w.rpc[0].uploaded_by, `Google Drive — ${EMAIL}`, 'a Shared Drive\'s folder has no owner');
  assert.equal(w.rpc[0].meta.gdrive.owner, null);
});

test('before MegaNet knows Google Drive as a way in, the run stops at the first photo and says why', async () => {
  const w = fakeWorld({ items: [file('photo-1', '1.jpg', ROOT, phone(11)), file('photo-2', '2.jpg', ROOT, phone(12))] });
  w.origins.delete('gdrive');
  const out = await sync(w);
  assert.equal(out.ok, false);
  assert.match(out.report.last_error, /gdrive is not a way in for a field photo/);
  assert.equal(out.report.failed, 1);
  assert.deepEqual(w.downloads, ['1.jpg'], 'not the next one: it would be refused the same way');
  assert.equal(w.objects.size, 0, 'what it uploaded is taken down again');
  assert.equal(w.cursor, null);
});

test('the log says refused for what is wrong with the file itself, and failed for what may work next time', async () => {
  const w = fakeWorld({ items: [
    file('photo-broken', 'broken.jpg', ROOT, Buffer.from('this is not a JPEG, whatever its name says')),
    file('photo-flaky', 'flaky.jpg', ROOT, phone(19)),
  ] });
  w.flaky = 'photo-flaky';
  const out = await sync(w);
  assert.equal(out.ok, false);
  assert.equal(out.report.failed, 2, 'both fail the run, as a photo that could not be read always has');
  assert.deepEqual(w.log.map(r => [r.file_name, r.outcome]), [['broken.jpg', 'refused'], ['flaky.jpg', 'failed']]);
  assert.match(w.log[0].reason, /not a photo this can read/);
  assert.equal(w.log[0].byte_size, 42);
  assert.match(w.log[1].reason, /^Google Drive download: The service is currently unavailable\.$/);
  assert.ok(w.log.every(r => r.photo_id === null && r.station_id === null), 'neither got in, so neither points at a photo');
});

test('the upload log is best effort: while the project has none, the run still succeeds, and says so once', async () => {
  const w = fakeWorld({ items: [file('photo-1', '1.jpg', ROOT, phone(13))] });
  w.logMissing = true;
  const lines = [];
  const out = await sync(w, {}, { log: s => lines.push(s) });
  assert.equal(out.ok, true, JSON.stringify(out.report));
  assert.equal(out.report.imported, 1);
  assert.equal(lines.filter(l => /upload log/.test(l)).length, 1);
  assert.match(lines.find(l => /upload log/.test(l)), /not in this project yet/);
});

// ── What is wrong, said ──────────────────────────────────────────────────────

test('a key Google will not take fails the run out loud, and the report says so', async () => {
  const w = fakeWorld({ items: [file('photo-1', '1.jpg', ROOT, phone(14))] });
  const out = await sync(w, { GDRIVE_SERVICE_ACCOUNT_JSON: keyFile(stranger) });
  assert.equal(out.ok, false);
  assert.match(out.report.last_error, /^Google Drive token: invalid_grant — Invalid JWT Signature\.$/);
  assert.equal(w.sync.source, 'gdrive');
  assert.equal(w.sync.account, EMAIL, 'which service account it was');
  assert.match(w.sync.last_error, /Invalid JWT Signature/);
  assert.ok(!('last_ok_at' in w.sync), 'the last good run keeps its time');
  assert.equal(w.downloads.length, 0);
  assert.equal(w.cursor, null);
});

test('missing or wrong settings are named in a sentence, and the key is never repeated back', async () => {
  const w = fakeWorld();
  const said = async env => (await run({ env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SECRET_KEY: ENV.SUPABASE_SECRET_KEY, ...env }, fetch: w.fetch, uuid, provider: gdrive })).report.last_error;
  assert.match(await said({}), /^Google Drive is not configured: GDRIVE_SERVICE_ACCOUNT_JSON and GDRIVE_FOLDER_ID are both needed$/);
  assert.match(await said({ GDRIVE_SERVICE_ACCOUNT_JSON: keyFile() }), /GDRIVE_FOLDER_ID is needed/);
  assert.match(await said({ GDRIVE_SERVICE_ACCOUNT_JSON: keyFile(), GDRIVE_FOLDER_ID: 'the photos folder' }), /neither a folder's id nor its link/);
  const secret = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC-not-a-real-key';
  const broken = await said({ GDRIVE_FOLDER_ID: ROOT, GDRIVE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n` }) });
  assert.match(broken, /its private_key is not a key this can read/);
  assert.ok(!broken.includes(secret) && !broken.includes('PRIVATE KEY'), 'the key is not in the error');
  assert.match(await said({ GDRIVE_FOLDER_ID: ROOT, GDRIVE_SERVICE_ACCOUNT_JSON: '{"installed":{"client_id":"x","client_secret":"y"}}' }), /an OAuth client's JSON, not a service account key/);
  assert.match(await said({ GDRIVE_FOLDER_ID: ROOT, GDRIVE_SERVICE_ACCOUNT_JSON: 'hunter2' }), /is not a service account key/);
});

test('a folder the service account cannot see says whom to share it with; a file is not a folder', async () => {
  const w = fakeWorld();
  const out = await sync(w, { GDRIVE_FOLDER_ID: '1SomebodyElsesFolder0000000000000' });
  assert.equal(out.ok, false);
  assert.match(out.report.last_error, new RegExp(`no folder 1SomebodyElsesFolder0000000000000 that ${EMAIL.replace(/[.]/g, '\\.')} can see — share the folder with that address, as a Viewer`));
  const photo = fakeWorld({ items: [file('photo-file-0001', '1.jpg', ROOT, phone(15))] });
  assert.match((await sync(photo, { GDRIVE_FOLDER_ID: 'photo-file-0001' })).report.last_error, /GDRIVE_FOLDER_ID is "1\.jpg", a file, not a folder/);
  const link = fakeWorld({ items: [{ id: 'shortcut-0001', name: 'Photos', parent: ROOT, mimeType: 'application/vnd.google-apps.shortcut' }] });
  assert.match((await sync(link, { GDRIVE_FOLDER_ID: 'shortcut-0001' })).report.last_error, /is "Photos", a shortcut to one, not a folder/);
});

// ── The parts ────────────────────────────────────────────────────────────────

test('PHOTO_SOURCE picks the provider — Dropbox unless it says gdrive', () => {
  assert.equal(providerFor(undefined).source, 'dropbox');
  assert.equal(providerFor('').source, 'dropbox');
  assert.equal(providerFor('gdrive'), gdrive);
  assert.equal(providerFor(' GDrive ').source, 'gdrive');
  assert.throws(() => providerFor('onedrive'), /PHOTO_SOURCE is "onedrive" — it is dropbox or gdrive/);
});

test('a folder is its id or its link', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  assert.equal(folderId(id), id);
  assert.equal(folderId(`https://drive.google.com/drive/folders/${id}`), id);
  assert.equal(folderId(`https://drive.google.com/drive/u/1/folders/${id}?usp=sharing`), id);
  assert.equal(folderId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(folderId(' '), null);
  assert.equal(folderId('Field photos'), null);
});

test('the walk stops at its bounds, and says so', async () => {
  const w = fakeWorld({ items: [
    folder('f1', 'one', ROOT), folder('f2', 'two', 'f1'), folder('f3', 'three', 'f2'),
    file('p1', '1.jpg', ROOT, phone(16)), file('p2', '2.jpg', 'f1', phone(17)), file('p3', '3.jpg', 'f2', phone(18)),
  ] });
  const root = { id: ROOT, name: 'Field photos', driveId: null };
  const all = await walk(w.fetch, 'ya29.fixture', root);
  assert.deepEqual(all.map(f => f.path).sort(), ['/Field photos/1.jpg', '/Field photos/one/2.jpg', '/Field photos/one/two/3.jpg']);
  await assert.rejects(walk(w.fetch, 'ya29.fixture', root, { depth: 1 }), /folders more than 1 deep — the sync walks the whole folder every run/);
  await assert.rejects(walk(w.fetch, 'ya29.fixture', root, { folders: 2 }), /more than 2 folders/);
  await assert.rejects(walk(w.fetch, 'ya29.fixture', root, { files: 2 }), /more than 2 files/);
});
