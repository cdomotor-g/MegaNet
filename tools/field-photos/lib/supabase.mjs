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

// The field photos' bytes live in Cloudflare R2 behind MegaNet's Worker
// (worker/photos.js), not in Supabase Storage, which on the free plan holds
// 1 GB. `store` is that route; without one — or while it answers that R2 is not
// bound yet, or cannot be reached — upload and remove go to Supabase Storage as
// they always did, and tools/field-photos/move-to-r2.mjs carries them over later.
export const DEFAULT_PHOTO_STORE = 'https://floodwarning.net/api/photos';

export function client(fetch, { url, key, store = null, log = () => {} }) {
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

  let storeOff = !store;
  // The response, or null for "Supabase instead".
  async function viaStore(path, init) {
    if (storeOff) return null;
    let res;
    try {
      res = await fetch(`${store.replace(/\/+$/, '')}/${BUCKET}/${path}`, { ...init, redirect: 'manual' });
    } catch (err) {
      storeOff = true;
      log(`The photo store at ${store} could not be reached (${err.message}) — writing to Supabase Storage for this run.`);
      return null;
    }
    const type = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
    if (!/json/i.test(type)) {
      // Cloudflare Access sending the request to its login page, most likely:
      // /api/photos is not in the bypass application yet (docs/field-photos.md).
      storeOff = true;
      log(`The photo store at ${store} answered HTTP ${res.status} with no JSON — is /api/photos behind Cloudflare Access? Writing to Supabase Storage for this run.`);
      return null;
    }
    if (res.status === 503) {
      let body = null;
      try { body = await res.clone().json(); } catch (_) { /* fall through */ }
      if (body && body.unbound) { storeOff = true; return null; }
    }
    return res;
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
      const via = await viaStore(path, { method: 'PUT', headers: { Authorization: `Bearer ${key}`, 'Content-Type': contentType }, body: bytes });
      if (via) return answer(via, `upload ${path}`);
      const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': contentType, 'x-upsert': 'false' },
        body: bytes,
      });
      return answer(res, `upload ${path}`);
    },
    async remove(path) {
      const via = await viaStore(path, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } });
      if (via) {
        const out = await answer(via, `remove ${path}`);
        // Not carried over yet, perhaps; gone from both either way.
        try { await fetch(`${STORAGE}/object/${BUCKET}/${path}`, { method: 'DELETE', headers: { ...auth } }); } catch (_) { /* fine */ }
        return out;
      }
      const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, { method: 'DELETE', headers: { ...auth } });
      return answer(res, `remove ${path}`);
    },
    // For the move out of Supabase Storage (move-to-r2.mjs): one page of the
    // bucket's objects under `prefix`, the bytes of one, and one put straight
    // to the store with no fallback — a move that quietly wrote back to where
    // it was reading from would be no move at all.
    async listStorage(prefix, limit, offset) {
      const res = await fetch(`${STORAGE}/object/list/${BUCKET}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      const body = await answer(res, `list ${prefix}`);
      return Array.isArray(body) ? body : [];
    },
    async downloadStorage(path) {
      const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, { headers: { ...auth } });
      if (!res.ok) await answer(res, `download ${path}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
    },
    async removeStorage(path) {
      const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, { method: 'DELETE', headers: { ...auth } });
      return answer(res, `remove ${path} from Supabase Storage`);
    },
    async putStore(path, bytes, contentType) {
      if (!store) throw new SupabaseError('no photo store configured');
      const res = await fetch(`${store.replace(/\/+$/, '')}/${BUCKET}/${path}`, {
        method: 'PUT', redirect: 'manual',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': contentType },
        body: bytes,
      });
      const type = res.headers.get('content-type') || '';
      if (!/json/i.test(type)) {
        throw new SupabaseError(`the photo store answered HTTP ${res.status} with no JSON — is /api/photos behind Cloudflare Access? (docs/field-photos.md)`, { status: res.status });
      }
      if (res.status === 503) {
        const body = await res.clone().json().catch(() => null);
        if (body && body.unbound) throw new SupabaseError('the photo store has no R2 bucket bound yet (wrangler.toml)', { status: 503, code: 'unbound' });
      }
      return answer(res, `upload ${path} to the photo store`);
    },
  };
}
