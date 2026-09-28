// tools/field-photos/lib/dropbox.mjs — the four Dropbox calls the sync makes,
// and nothing else: a fresh access token, whose account it is, what is new in
// the folder, and one file's bytes. At the foot, the same four as the provider
// lib/run.mjs takes (lib/gdrive.mjs is the other).
//
// The refresh token is long-lived and is the only credential kept. It comes
// one of two ways, and both are refreshed here:
//
//   · from the Field Photos tab's "Link a Dropbox folder" (PKCE, docs/field-photos.md)
//     — a public client, so the refresh takes the app key alone;
//   · from the classic code flow, with the app's secret — for whoever set it
//     up that way.

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

export class DropboxError extends Error {
  constructor(message, { status, tag } = {}) { super(message); this.status = status; this.tag = tag || null; }
}

async function json(res, what) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const tag = body && body.error && body.error['.tag'];
    const reason = (body && (body.error_summary || body.error_description || (typeof body.error === 'string' ? body.error : null))) || text || `HTTP ${res.status}`;
    throw new DropboxError(`Dropbox ${what}: ${String(reason).slice(0, 300)}`, { status: res.status, tag });
  }
  return body;
}

export async function accessToken(fetch, { appKey, appSecret, refreshToken }) {
  if (!appKey || !refreshToken) throw new DropboxError('Dropbox is not configured: DROPBOX_APP_KEY and DROPBOX_REFRESH_TOKEN are both needed');
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey });
  if (appSecret) form.set('client_secret', appSecret);
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await json(res, 'token refresh');
  if (!body || !body.access_token) throw new DropboxError('Dropbox token refresh: no access token in the answer');
  return body.access_token;
}

async function rpc(fetch, token, route, args) {
  const res = await fetch(`${API}/2/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(args === null ? {} : { 'Content-Type': 'application/json' }) },
    body: args === null ? undefined : JSON.stringify(args),
  });
  return json(res, route);
}

// Whose Dropbox this is, for the tab to say ("reading field@…'s Dropbox").
export async function account(fetch, token) {
  const a = await rpc(fetch, token, 'users/get_current_account', null);
  return (a && (a.email || (a.name && a.name.display_name))) || null;
}

// Every file added or changed since `cursor` (or in the whole folder, without
// one), as the list and the cursor to resume from. A cursor Dropbox has reset
// is started over — the origin_ref check makes that safe, only slower.
export async function changes(fetch, token, { folder = '', cursor = null } = {}) {
  const entries = [];
  let page;
  let reset = false;
  if (cursor) {
    try {
      page = await rpc(fetch, token, 'files/list_folder/continue', { cursor });
    } catch (err) {
      if (!(err instanceof DropboxError) || err.status !== 409 || err.tag !== 'reset') throw err;
      page = null;
      reset = true;
    }
  }
  if (!page) {
    page = await rpc(fetch, token, 'files/list_folder', {
      path: folder, recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: 1000,
    });
  }
  for (;;) {
    for (const e of page.entries || []) if (e['.tag'] === 'file') entries.push(e);
    if (!page.has_more) break;
    page = await rpc(fetch, token, 'files/list_folder/continue', { cursor: page.cursor });
  }
  return { entries, cursor: page.cursor, reset };
}

export async function download(fetch, token, id) {
  const res = await fetch(`${CONTENT}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: id }) },
  });
  if (!res.ok) await json(res, 'download');
  return Buffer.from(await res.arrayBuffer());
}

// ── The provider (lib/run.mjs says what one is) ──────────────────────────────
// A listed file becomes { ref, name, path, size, modified, meta }: its Dropbox
// id is the photo's origin_ref, and meta is what the photo keeps of it.

const listed = e => ({
  ref: e.id, id: e.id, name: e.name, path: e.path_display || null, size: e.size, modified: e.server_modified || '',
  meta: { path: e.path_display || null, rev: e.rev || null, content_hash: e.content_hash || null,
          server_modified: e.server_modified || null, client_modified: e.client_modified || null },
});

export const dropbox = {
  source: 'dropbox',
  label: 'Dropbox',

  settings(env) {
    const folder = (env.DROPBOX_FOLDER || '').replace(/\/+$/, '');
    return { folder, label: folder || '(the app folder)', account: null,
             appKey: env.DROPBOX_APP_KEY, appSecret: env.DROPBOX_APP_SECRET, refreshToken: env.DROPBOX_REFRESH_TOKEN };
  },

  async connect(s, fetch) {
    const token = await accessToken(fetch, { appKey: s.appKey, appSecret: s.appSecret, refreshToken: s.refreshToken });
    let who = null;
    try { who = await account(fetch, token); } catch (_) { who = null; }
    return { fetch, token, folder: s.folder, account: who,
             by: `Dropbox — ${who || 'the linked account'}`, whose: who ? `, ${who}'s Dropbox` : '' };
  },

  async changes(session, cursor) {
    const out = await changes(session.fetch, session.token, { folder: session.folder, cursor });
    return { ...out, entries: out.entries.map(listed) };
  },

  download: (session, e) => download(session.fetch, session.token, e.id),
};
