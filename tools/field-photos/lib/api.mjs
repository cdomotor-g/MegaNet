// tools/field-photos/lib/api.mjs — the photo upload API's inbox, as a place
// the field photo sync reads from (PHOTO_SOURCE=api).
//
// Photos sent to https://floodwarning.net/api/upload/v1/photos by other apps
// and contractors (worker/upload.js) wait, unread, in an inbox in R2, each
// under a receipt in meganet.photo_upload_receipt (db/migrations/0127). This
// is the provider lib/run.mjs reads them through — the same run, the same
// photo-meta.js and the same add_field_photo() as Dropbox and Google Drive:
//
//   changes   the waiting receipts, oldest first (photo_upload_waiting)
//   download  the bytes, from the Worker's inbox route, with the secret key
//   settle    what became of each (photo_upload_settle), and — once that is
//             final — the bytes cleared out of the inbox
//
// A file here carries two things the folder syncs' do not: `by`, the photo's
// uploaded_by ('api:<the key's label>'), since each photo is a different
// sender's; and `hints`, what the sender said about it (a station, a caption,
// a position and time used only where the photo itself says nothing).
//
// There is no cursor: the inbox is what is waiting, and a settled receipt
// leaves it. A photo a run did not reach waits for the next.

export const DEFAULT_INBOX = 'https://floodwarning.net/api/upload/v1/inbox';
const DEFAULT_SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const PHOTO_EXT = /\.(jpe?g|png|heic|heif|webp)$/i;

// The run picks files by their name's extension; a sender may name a photo
// anything, so its type's extension is added where its name has none.
export function nameFor(fileName, type) {
  const n = String(fileName || '').trim() || 'photo';
  return PHOTO_EXT.test(n) ? n : `${n}.${EXT[type] || 'jpg'}`;
}

async function rpc(session, fn, args) {
  const res = await session.fetch(`${session.supabase}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: session.key, Authorization: `Bearer ${session.key}`, 'Content-Profile': 'meganet',
               'Accept-Profile': 'meganet', 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(`${fn}: ${(body && body.message) || text || `HTTP ${res.status}`}`);
    err.status = res.status;
    if (res.status === 404) err.message = `${fn} is not in this project yet — apply db/migrations/0127_photo_upload_api.sql`;
    throw err;
  }
  return body;
}

export const api = {
  source: 'api',
  label: 'the upload API',

  settings(env) {
    return {
      label: 'the upload API inbox',
      inbox: String(env.PHOTO_UPLOAD_INBOX_URL || DEFAULT_INBOX).replace(/\/+$/, ''),
      supabase: String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, ''),
      key: env.SUPABASE_SECRET_KEY || '',
      limit: Math.max(1, Math.min(1000, Number(env.MAX_FILES) || 150)),
      account: null,
    };
  },

  async connect(settings, fetch) {
    if (!settings.key) throw new Error('SUPABASE_SECRET_KEY is not set — the inbox is read with the project\'s secret key');
    return { ...settings, fetch, account: null, by: 'api', label: settings.label };
  },

  async changes(session) {
    const rows = await rpc(session, 'photo_upload_waiting', { p_limit: session.limit });
    const entries = (rows || []).map(r => ({
      ref: r.receipt,
      name: nameFor(r.file_name, r.content_type),
      path: `${r.label} › ${r.file_name}`,
      size: Number(r.byte_size) || null,
      modified: r.received_at,
      by: `api:${r.label}`,
      hints: r.hints || {},
      meta: { receipt: r.receipt, sent_by: r.label, received_at: r.received_at, hints: r.hints || {} },
    }));
    return { entries, cursor: 'inbox', reset: false };
  },

  async download(session, e) {
    const res = await session.fetch(`${session.inbox}/${e.ref}`, { headers: { Authorization: `Bearer ${session.key}` } });
    if (!res.ok) {
      const err = new Error(`the inbox answered HTTP ${res.status} for receipt ${e.ref}`);
      if (res.status === 404) err.refused = true;     // the bytes are gone: trying again will not bring them back
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  },

  // `outcome` as the upload log has it; skipped (the run's word for a rule
  // that said no) is a refusal to the sender.
  async settle(session, e, { outcome, id = null, station = null, reason = null }) {
    const out = await rpc(session, 'photo_upload_settle', { p_receipt: e.ref, p: {
      outcome: outcome === 'skipped' ? 'refused' : outcome,
      photo_id: id, station_id: station, reason: reason || '',
    } });
    if (out && out.final) {
      const res = await session.fetch(`${session.inbox}/${e.ref}`, { method: 'DELETE', headers: { Authorization: `Bearer ${session.key}` } });
      if (!res.ok && res.status !== 404) throw new Error(`the inbox did not clear receipt ${e.ref} — HTTP ${res.status}`);
    }
    return out;
  },
};
