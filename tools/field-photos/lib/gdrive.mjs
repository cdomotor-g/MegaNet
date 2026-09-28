// tools/field-photos/lib/gdrive.mjs — the Google Drive calls the sync makes, and
// the provider lib/run.mjs takes: signed in, what is new in the folder, and one
// file's bytes. Node's own crypto and fetch; no Google library.
//
// ── Who the sync is, to Google ───────────────────────────────────────────────
// A service account: an identity that belongs to a Google Cloud project rather
// than to a person. The folder is shared with its address
// (…@….iam.gserviceaccount.com) the way it would be with a colleague, as a
// Viewer, and that folder is all it can see. Its key — the JSON file Google
// hands over once — is the one credential, GDRIVE_SERVICE_ACCOUNT_JSON: each run
// signs a JWT with it here (RS256) and trades that at oauth2.googleapis.com for
// an hour's read-only access token (drive.readonly). Nothing to refresh, and
// nothing that lapses unless somebody deletes the key.
//
// Why not sign in as a person, the way a Dropbox folder is linked: a Google
// OAuth app that Google has not verified stays in "Testing", and a refresh
// token issued to an app in Testing dies after seven days — a sync that stops a
// week after it was set up, and says so only in a red run nobody is watching.
//
// ── What is new: the whole folder, walked every run ──────────────────────────
// Drive has a changes feed (changes.list, with a page token for a cursor), and
// Dropbox's cursor is exactly that. It is not used here, because what it
// reports is changes to what an *account* can see, not to a folder: a
// sub-folder dragged in from elsewhere is one change to the sub-folder and none
// to the photos inside it; a Shared Drive keeps a feed of its own; and every
// change has to be traced up through its parents before it is known to be in
// the folder at all. Each of those is a way to miss photos quietly, against a
// Google this cannot be tested with.
//
// So the folder is walked instead — files.list on each folder,
// `'<id>' in parents and trashed = false`, a thousand a page, eight folders at a
// time — and what the walk finds is compared with what the last complete walk
// found. The cursor is that list: eight bytes of SHA-256 for each file's id and
// version (its md5Checksum), about eleven characters a file. What is not in it
// is new or changed, which is Dropbox's cursor to the letter: each file is
// dealt with once for each version of it, one that failed is not tried again
// every run (only once it changes), and the cursor is saved only when a run has
// dealt with everything it listed. What it costs is a files.list call per
// folder (and per thousand files in one) every run. Bounded here at 1,000
// folders, 20 deep, and 50,000 files; past any of those the run stops and says
// the folder is too big to walk, rather than walking part of it.
//
// ── What is left alone ───────────────────────────────────────────────────────
// Google's own documents (Docs, Sheets, Forms…) have no bytes of their own to
// read. Shortcuts are skipped, not followed: the file one points to can be
// anywhere in Drive, outside the folder the sync was given and outside what
// anyone meant it to import, and a shortcut to a folder above it is a loop.
// What is in the bin is not listed.

import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const GOOGLE_OWN = 'application/vnd.google-apps.';     // Docs, Sheets, shortcuts, folders…
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,'
             + 'owners(emailAddress),imageMediaMetadata(time,location,rotation))';

export const WALK_LIMITS = Object.freeze({ depth: 20, folders: 1000, files: 50000, parallel: 8 });

export class GDriveError extends Error {
  constructor(message, { status, reason } = {}) { super(message); this.status = status; this.reason = reason || null; }
}

async function answer(res, what) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (!res.ok) {
    // The Drive API says { error: { code, message, errors: [{ reason }] } };
    // the token endpoint says { error: 'invalid_grant', error_description }.
    const e = body && body.error;
    const said = e && typeof e === 'object'
      ? e.message || (e.errors && e.errors[0] && e.errors[0].message)
      : [e, body && body.error_description].filter(Boolean).join(' — ');
    const reason = e && typeof e === 'object' ? (e.errors && e.errors[0] && e.errors[0].reason) || e.status : e;
    throw new GDriveError(`Google Drive ${what}: ${String(said || text || `HTTP ${res.status}`).slice(0, 300)}`,
      { status: res.status, reason });
  }
  return body;
}

async function get(fetch, token, path, what) {
  const res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return answer(res, what);
}

// ── The settings ─────────────────────────────────────────────────────────────

// The key, as GitHub holds it: the JSON file as downloaded, or base64 of it.
function keyJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8')); } catch (_) { return null; }
}

// The service account in a key file: its address, and its private key, ready
// to sign with. Throws with a sentence — never with any of the key in it.
export function serviceAccount(raw) {
  const j = keyJson(raw);
  if (j && typeof j === 'object' && (j.installed || j.web)) {
    throw new GDriveError('GDRIVE_SERVICE_ACCOUNT_JSON is an OAuth client\'s JSON, not a service account key — make the key under IAM & Admin → Service Accounts → the account → Keys (docs/field-photos.md, "Linking a Google Drive folder")');
  }
  if (!j || typeof j !== 'object' || !j.client_email || !j.private_key) {
    throw new GDriveError('GDRIVE_SERVICE_ACCOUNT_JSON is not a service account key — it should be the whole JSON file Google gives you for the key, with client_email and private_key in it');
  }
  let key;
  try {
    // A key pasted through something that doubled its escapes has "\\n" for
    // its line breaks; PEM needs real ones.
    key = crypto.createPrivateKey(String(j.private_key).replace(/\\n/g, '\n'));
  } catch (_) {
    throw new GDriveError('GDRIVE_SERVICE_ACCOUNT_JSON: its private_key is not a key this can read — paste the whole JSON file, as it was downloaded');
  }
  return { email: String(j.client_email), key, keyId: j.private_key_id || null };
}

// The folder: its id (1AbC…), or its link as the address bar shows it —
// …/drive/folders/<id>, …/drive/u/0/folders/<id>?usp=sharing, …/open?id=<id>.
export function folderId(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

// ── The calls ────────────────────────────────────────────────────────────────

const b64url = b => Buffer.from(b).toString('base64url');

// An hour's access token, for a JWT signed with the service account's key.
export async function accessToken(fetch, sa, { now = new Date() } = {}) {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(sa.keyId ? { kid: sa.keyId } : {}) }));
  const claims = b64url(JSON.stringify({ iss: sa.email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signature = b64url(crypto.sign('sha256', Buffer.from(`${head}.${claims}`), sa.key));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }).toString(),
  });
  const body = await answer(res, 'token');
  if (!body || !body.access_token) throw new GDriveError('Google Drive token: no access token in the answer');
  return body.access_token;
}

// The linked folder: its name, the Shared Drive it is in (if it is), and
// whose it is (a Shared Drive's folders are nobody's).
export async function folder(fetch, token, id, { who = 'the service account' } = {}) {
  let f;
  try {
    const q = new URLSearchParams({ fields: 'id,name,mimeType,driveId,owners(emailAddress)', supportsAllDrives: 'true' });
    f = await get(fetch, token, `files/${encodeURIComponent(id)}?${q}`, 'folder');
  } catch (err) {
    if (err instanceof GDriveError && err.status === 404) {
      throw new GDriveError(`Google Drive: there is no folder ${id} that ${who} can see — share the folder with that address, as a Viewer (docs/field-photos.md, "Linking a Google Drive folder")`, { status: 404, reason: err.reason });
    }
    throw err;
  }
  if (!f || f.mimeType !== FOLDER) {
    const what = f && f.mimeType === SHORTCUT ? 'a shortcut to one' : 'a file';
    throw new GDriveError(`Google Drive: GDRIVE_FOLDER_ID is ${f && f.name ? `"${f.name}", ` : ''}${what}, not a folder — give it the folder's own id, or its link`);
  }
  return { id: f.id || id, name: f.name || id, driveId: f.driveId || null,
           owner: (f.owners && f.owners[0] && f.owners[0].emailAddress) || null };
}

// One folder's children, every page of them.
async function children(fetch, token, id, driveId, max) {
  const out = [];
  let pageToken = null;
  do {
    const q = new URLSearchParams({
      q: `'${id}' in parents and trashed = false`, fields: FIELDS, pageSize: '1000',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    // A Shared Drive's folders are listed from that drive.
    if (driveId) { q.set('corpora', 'drive'); q.set('driveId', driveId); }
    if (pageToken) q.set('pageToken', pageToken);
    const page = await get(fetch, token, `files?${q}`, 'list');
    for (const f of (page && page.files) || []) out.push(f);
    pageToken = (page && page.nextPageToken) || null;
  } while (pageToken && out.length <= max);
  return out;
}

// Every file in the folder and in the folders under it, each with its path
// from the folder (/Field photos/Site A/IMG_0042.jpg). Google's own documents
// and shortcuts are left out; a file that is in two folders is listed once.
export async function walk(fetch, token, root, limits = {}) {
  const L = { ...WALK_LIMITS, ...limits };
  const tooBig = what => new GDriveError(`Google Drive: ${root.name} holds ${what} — the sync walks the whole folder every run, so link the folder the photos are saved to, not a whole drive`);
  const files = [];
  const met = new Set([root.id]);
  let folders = 1;
  let level = [{ id: root.id, path: `/${root.name}` }];
  for (let depth = 0; level.length; depth++) {
    if (depth > L.depth) throw tooBig(`folders more than ${L.depth} deep`);
    const next = [];
    for (let i = 0; i < level.length; i += L.parallel) {
      const group = level.slice(i, i + L.parallel);
      const lists = await Promise.all(group.map(f => children(fetch, token, f.id, root.driveId, L.files)));
      lists.forEach((kids, j) => {
        for (const k of kids) {
          if (!k || !k.id || met.has(k.id)) continue;
          met.add(k.id);
          const path = `${group[j].path}/${k.name}`;
          if (k.mimeType === FOLDER) {
            if (++folders > L.folders) throw tooBig(`more than ${L.folders.toLocaleString('en-AU')} folders`);
            next.push({ id: k.id, path });
          } else if (!String(k.mimeType || '').startsWith(GOOGLE_OWN)) {
            files.push({ ...k, path });
            if (files.length > L.files) throw tooBig(`more than ${L.files.toLocaleString('en-AU')} files`);
          }
        }
      });
    }
    level = next;
  }
  return files;
}

export async function download(fetch, token, id) {
  const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) await answer(res, 'download');
  return Buffer.from(await res.arrayBuffer());
}

// ── The cursor ───────────────────────────────────────────────────────────────
// Every file the last complete walk found, as 8 bytes of SHA-256 over its id
// and version: { v: 1, folder, files, marks: base64 }. Eight bytes is 64 bits —
// two of 50,000 files sharing a mark is a one-in-ten-billion chance.

const version = f => f.md5Checksum || `${f.modifiedTime || ''}/${f.size || ''}`;
const mark = f => crypto.createHash('sha256').update(`${f.id}\n${version(f)}`).digest().subarray(0, 8);

function remembered(cursor, folderId) {
  const none = new Set();
  if (!cursor) return { marks: none, reset: false };
  let c = null;
  try { c = JSON.parse(cursor); } catch (_) { c = null; }
  if (!c || c.v !== 1 || typeof c.marks !== 'string') {
    return { marks: none, reset: 'the saved cursor is not one this reads — listing the folder from the start' };
  }
  if (c.folder !== folderId) return { marks: none, reset: 'the folder is not the one the last run read — listing it from the start' };
  const b = Buffer.from(c.marks, 'base64');
  const marks = new Set();
  for (let i = 0; i + 8 <= b.length; i += 8) marks.add(b.toString('hex', i, i + 8));
  return { marks, reset: false };
}

// A listed file as the run takes it (lib/run.mjs).
function entry(f) {
  const img = f.imageMediaMetadata || null;
  return {
    ref: f.id, id: f.id, name: f.name || f.id, path: f.path || null, size: Number(f.size) || 0,
    modified: f.modifiedTime || f.createdTime || '',
    meta: {
      id: f.id, name: f.name || null, path: f.path || null, md5: f.md5Checksum || null,
      modifiedTime: f.modifiedTime || null, createdTime: f.createdTime || null,
      owner: (f.owners && f.owners[0] && f.owners[0].emailAddress) || null,
      ...(img ? { image: { time: img.time || null, location: img.location || null, rotation: img.rotation ?? null } } : {}),
    },
  };
}

// ── The provider ─────────────────────────────────────────────────────────────

export const gdrive = {
  source: 'gdrive',
  label: 'Google Drive',

  settings(env) {
    const raw = String(env.GDRIVE_SERVICE_ACCOUNT_JSON || '');
    const given = String(env.GDRIVE_FOLDER_ID || '').trim();
    const id = folderId(given);
    const j = keyJson(raw);
    return { raw, given, id, label: id || given || '(no folder set)',
             account: (j && typeof j === 'object' && typeof j.client_email === 'string' && j.client_email) || null };
  },

  async connect(s, fetch, { now = () => new Date() } = {}) {
    const missing = [!s.raw.trim() && 'GDRIVE_SERVICE_ACCOUNT_JSON', !s.given && 'GDRIVE_FOLDER_ID'].filter(Boolean);
    if (missing.length) {
      throw new GDriveError(`Google Drive is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are both' : 'is'} needed`);
    }
    if (!s.id) {
      throw new GDriveError('GDRIVE_FOLDER_ID is neither a folder\'s id nor its link — open the folder in Google Drive and copy the address bar, or the part of it after /folders/');
    }
    const sa = serviceAccount(s.raw);
    const token = await accessToken(fetch, sa, { now: now() });
    const root = await folder(fetch, token, s.id, { who: sa.email });
    return {
      fetch, token, root, account: sa.email, label: root.name,
      by: `Google Drive — ${root.owner || sa.email}`,
      whose: `, Google Drive (shared with ${sa.email})`,
    };
  },

  async changes(session, cursor) {
    const files = await walk(session.fetch, session.token, session.root);
    const before = remembered(cursor, session.root.id);
    const marks = [];
    const entries = [];
    for (const f of files) {
      const m = mark(f);
      marks.push(m);
      if (!before.marks.has(m.toString('hex'))) entries.push(entry(f));
    }
    const next = { v: 1, folder: session.root.id, files: marks.length, marks: Buffer.concat(marks).toString('base64') };
    return { entries, cursor: JSON.stringify(next), reset: before.reset };
  },

  download: (session, e) => download(session.fetch, session.token, e.id),
};
