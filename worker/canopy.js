// /api/canopy/<quadkey>.tif — how tall the trees are, for the ⛰️ 3-D view and
// the digital twin (#278): Meta and WRI's Canopy Height Maps, version 2, passed
// through from Meta's own files.
//
//   GET  /api/canopy/<quadkey>.tif    the file, or the bytes a Range names
//   HEAD (same path)                  its size, ETag and dates, no body
//
// Meta keep one cloud-optimised GeoTIFF per zoom-10 map square (about 35 km
// across, 128 MB on average) on Amazon S3, and a reader asks for just the bytes
// it needs with a Range header. A page on floodwarning.net cannot read them
// directly: the bucket refuses cross-site reads (no Access-Control-Allow-Origin,
// and a preflight answers "CORS is not enabled for this bucket"). Copying them
// is out of the question too — 390 GB for Queensland and New South Wales. So
// this route asks Meta's bucket for the same bytes and hands them back with the
// cross-site headers. docs/ground-cover-sources.md has the research ("Tree
// heights: Meta / WRI version 2, through a Flood-Net Worker route").
//
// Two further reasons to go through here: the Bureau's web filter denies
// hostnames it has never classified, and floodwarning.net is one it knows; and
// Meta moved every file once already (version 1 to version 2), which here is a
// change to UPSTREAM and not to the app.
//
// ── Read-only by construction ───────────────────────────────────────────────
//
// GET and HEAD only, upstream and here. One fixed host and one fixed folder;
// the only part of the address the caller chooses is the quadkey, which must be
// exactly 10 digits 0–3 — anything else is a 400 and nothing is fetched. The
// one header passed on is Range, and only a single `bytes=<first>-<last>`
// range; any other Range is a 400. No query string, cookie, Authorization or
// other header of the caller's reaches Meta, nothing is stored, and the bucket
// is public and anonymous.
//
// Meta's answer goes back as it came for 200, 206, 404 (no tile there — open
// sea) and 416 (a range past the end of the file); anything else is a 502
// saying what Meta said. The files never change once published (a new version
// is a new folder), so a browser may keep what it was given for a week.
//
// CORS is open (`*`): the files are public and nothing here depends on who is
// asking. The responses carry the same document lock as /api/photos — a TIFF
// is never a page.

const PREFIX = '/api/canopy';
export const UPSTREAM = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm/';
export const DOC_URL = 'https://floodwarning.net/docs/ground-cover-sources.md';
export const USER_AGENT = `Flood-Net canopy heights (+${DOC_URL})`;
// Waiting for Meta to start answering, not for the whole body: a full file is
// hundreds of MB and is streamed through as it comes.
export const TIMEOUT_MS = 15000;
export const CACHE = 'public, max-age=604800';

const PATH_RE = /^\/api\/canopy\/([0-3]{10})\.tif$/;
const RANGE_RE = /^bytes=(\d{1,15})-(\d{1,15})$/;
// What Meta's answer may be passed on as; anything else is Meta's trouble.
const PASSED = [200, 206, 404, 416];

const OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

export function isCanopyPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// The quadkey a path names, or null.
export function canopyQuadkey(pathname) {
  const m = PATH_RE.exec(pathname || '');
  return m ? m[1] : null;
}

// A single `bytes=<first>-<last>` range, first ≤ last, as Meta should be asked
// for it; null for none at all, false for anything else.
export function canopyRange(value) {
  if (value === null || value === undefined) return null;
  const m = RANGE_RE.exec(String(value).trim());
  if (!m) return false;
  const first = Number(m[1]), last = Number(m[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) return false;
  return `bytes=${first}-${last}`;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...OPEN, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function drop(res) {
  try { if (res && res.body) res.body.cancel(); } catch (_) { /* nothing to let go */ }
}

export async function handleCanopy(request, env, ctx, deps = {}) {
  const doFetch = deps.fetch || ((...a) => fetch(...a));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: OPEN });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'GET or HEAD only' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
  }
  const url = new URL(request.url);
  const quadkey = canopyQuadkey(url.pathname);
  if (!quadkey) {
    return json({ error: 'not a canopy address: /api/canopy/<quadkey>.tif, the quadkey 10 digits 0-3' }, 400);
  }
  const range = canopyRange(request.headers.get('Range'));
  if (range === false) {
    return json({ error: 'Range: one range of bytes, as bytes=<first>-<last>' }, 400);
  }

  const headers = { 'User-Agent': USER_AGENT };
  if (range) headers.Range = range;
  const abort = new AbortController();
  const wait = deps.timeoutMs || TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), wait);
  let res;
  try {
    res = await doFetch(`${UPSTREAM}${quadkey}.tif`, {
      method: request.method,
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: abort.signal,
    });
  } catch (err) {
    const why = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? `did not answer within ${wait / 1000} s` : 'could not be reached';
    return json({ error: `Meta's canopy store ${why}`, quadkey }, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!PASSED.includes(res.status)) {
    drop(res);
    return json({ error: `Meta's canopy store answered HTTP ${res.status}`, quadkey }, 502);
  }
  if (res.status === 404) {
    drop(res);
    return json({ error: 'no canopy file for that square (open sea, or outside the map)', quadkey }, 404,
                { 'Cache-Control': 'public, max-age=86400' });
  }

  const out = new Headers(OPEN);
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const v = res.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  if (res.status === 416) {
    drop(res);
    out.set('Content-Type', 'application/json');
    out.set('Cache-Control', 'no-store');
    out.delete('Content-Length');
    return new Response(request.method === 'HEAD' ? null
      : JSON.stringify({ error: 'that range is past the end of the file', quadkey }), { status: 416, headers: out });
  }
  out.set('Content-Type', 'image/tiff');
  out.set('Cache-Control', CACHE);
  if (request.method === 'HEAD') {
    drop(res);
    return new Response(null, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
}
