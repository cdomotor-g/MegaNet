// tools/field-photos/lib/supabase.mjs — the MegaNet project, as the sync sees
// it: the Data API (the meganet schema) and the Storage API, with the project's
// secret key, which is what lets a scheduled job write where only editors may.
//
// Every write the sync makes about a photo still goes through
// meganet.add_field_photo() — the path, type, size and duplicate rules are the
// database's, and the service key does not get around them. What it adds is
// only the two sync tables, which no browser role can write at all.

export const BUCKET = 'field-photos';

export class SupabaseError extends Error {
  constructor(message, { status, code, details } = {}) { super(message); this.status = status; this.code = code || null; this.details = details || null; }
}

export function client(fetch, { url, key }) {
  if (!url || !key) throw new SupabaseError('Supabase is not configured: SUPABASE_URL and SUPABASE_SECRET_KEY are both needed');
  const base = url.replace(/\/+$/, '');
  const REST = `${base}/rest/v1`, STORAGE = `${base}/storage/v1`;
  const auth = { apikey: key, Authorization: `Bearer ${key}` };

  async function answer(res, what) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const msg = (body && (body.message || body.error || body.msg)) || text || `HTTP ${res.status}`;
      throw new SupabaseError(`${what}: ${String(msg).slice(0, 300)}${body && body.hint ? ` — ${body.hint}` : ''}`,
        { status: res.status, code: body && body.code, details: body && body.details });
    }
    return body;
  }

  return {
    async select(path) {
      const res = await fetch(`${REST}/${path}`, { headers: { ...auth, 'Accept-Profile': 'meganet', Accept: 'application/json' } });
      const body = await answer(res, `GET ${path.split('?')[0]}`);
      return Array.isArray(body) ? body : [];
    },
    async rpc(fn, args) {
      const res = await fetch(`${REST}/rpc/${fn}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Profile': 'meganet', 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
      });
      return answer(res, fn);
    },
    // Insert or update one row by its primary key (PostgREST's upsert).
    async upsert(table, row) {
      const res = await fetch(`${REST}/${table}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Profile': 'meganet', 'Content-Type': 'application/json',
                   Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
      return answer(res, `upsert ${table}`);
    },
    async upload(path, bytes, contentType) {
      const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': contentType, 'x-upsert': 'false' },
        body: bytes,
      });
      return answer(res, `upload ${path}`);
    },
    async remove(path) {
      const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, { method: 'DELETE', headers: { ...auth } });
      return answer(res, `remove ${path}`);
    },
  };
}
