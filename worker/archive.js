// The data archive's door (#243): /api/archive/*, Flood-Net's raw rows — every
// UTC day of meganet.reading, reading_raw and reception — kept in Cloudflare R2
// (the ARCHIVE binding, bucket meganet-archive) before the database lets them
// go. db/migrations/0073_archive_then_retain.sql is the rule; this is only
// where the bytes live.
//
//   PUT  /api/archive/<table>/<yyyy>/<mm>/<dd>.v<n>.ndjson.gz   the secret key only, create-only
//   GET  (same path)                                             the secret key or an editor
//   HEAD (same path)                                             the same
//
// The writer is tools/archive/archive-to-r2.mjs, run by
// .github/workflows/archive-r2.yml with the project's secret key. It sends the
// rows' count and the object's SHA-256 as headers; they are kept on the object
// (customMetadata) so the object says what it is without the manifest, and the
// writer reads them back before it records the day.
//
// Nothing is ever overwritten or deleted here. A day whose rows changed after
// it was archived is written again as the next version, beside the first.

import { whoIs } from './photos.js';

const PREFIX = '/api/archive/';
const TABLES = ['reading', 'reading_raw', 'reception'];
// A UTC day of the busiest table, gzipped, is a few MB; this is far above that
// and inside what a Worker accepts.
export const MAX_BYTES = 90 * 1048576;
const PATH_RE = /^(reading|reading_raw|reception)\/(\d{4})\/(\d{2})\/(\d{2})\.v([1-9]\d{0,3})\.ndjson\.gz$/;

export function isArchivePath(pathname) {
  return pathname.startsWith(PREFIX);
}

// The object key for a path, or null if this route has no such object.
export function archiveKey(pathname) {
  if (!pathname.startsWith(PREFIX)) return null;
  let rest;
  try { rest = decodeURIComponent(pathname.slice(PREFIX.length)); } catch (_) { return null; }
  const m = PATH_RE.exec(rest);
  if (!m) return null;
  const [, table, y, mo, d] = m;
  const day = new Date(Date.UTC(+y, +mo - 1, +d));
  if (day.getUTCFullYear() !== +y || day.getUTCMonth() !== +mo - 1 || day.getUTCDate() !== +d) return null;
  return TABLES.includes(table) ? rest : null;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function put(request, env, key) {
  if ((await whoIs(request)) !== 'service') return json({ error: 'the archive is written with the project\'s secret key only' }, 401);
  const len = Number(request.headers.get('Content-Length'));
  if (!Number.isFinite(len) || len <= 0) return json({ error: 'a Content-Length is needed' }, 411);
  if (len > MAX_BYTES) return json({ error: `over the ${MAX_BYTES / 1048576} MB limit for one day` }, 413);
  const rows = request.headers.get('X-Archive-Rows') || '';
  const sha = (request.headers.get('X-Archive-Sha256') || '').toLowerCase();
  if (!/^\d{1,12}$/.test(rows)) return json({ error: 'X-Archive-Rows: the rows in the object, as a number' }, 400);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ error: 'X-Archive-Sha256: the object\'s SHA-256, in hex' }, 400);
  // Create-only: a version is written once. A changed day is the next version.
  if (await env.ARCHIVE.head(key)) return json({ error: 'that version of that day is already archived', statusCode: '409' }, 409);
  const obj = await env.ARCHIVE.put(key, request.body, {
    httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
    customMetadata: { rows, sha256: sha },
    sha256: sha,
  });
  if (!obj || obj.size !== len) {
    if (obj) await env.ARCHIVE.delete(key);
    return json({ error: 'the upload was cut short — send it again' }, 400);
  }
  return json({ key, size: obj.size, rows: Number(rows), sha256: sha }, 201);
}

async function get(request, env, key) {
  const who = await whoIs(request);
  if (who !== 'service' && who !== 'editor') return json({ error: 'the archive is for editors' }, 401);
  const obj = request.method === 'HEAD' ? await env.ARCHIVE.head(key) : await env.ARCHIVE.get(key);
  if (!obj) return json({ error: 'not archived' }, 404);
  const headers = new Headers({
    'Content-Type': 'application/gzip',
    'Content-Length': String(obj.size),
    'Content-Disposition': `attachment; filename="floodnet-${key.replace(/\//g, '-')}"`,
    'Cache-Control': 'private, no-store',
    'X-Archive-Rows': (obj.customMetadata && obj.customMetadata.rows) || '',
    'X-Archive-Sha256': (obj.customMetadata && obj.customMetadata.sha256) || '',
  });
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

export async function handleArchive(request, env) {
  const url = new URL(request.url);
  if (!env.ARCHIVE) return json({ error: 'the archive bucket is not bound', unbound: true }, 503);
  const key = archiveKey(url.pathname);
  if (!key) return json({ error: 'no such archive object' }, 404);
  try {
    switch (request.method) {
      case 'PUT': return await put(request, env, key);
      case 'GET': case 'HEAD': return await get(request, env, key);
      default: return json({ error: 'GET, HEAD or PUT' }, 405);
    }
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}
