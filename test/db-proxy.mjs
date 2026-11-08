// What the database proxy will and will not carry.
//
// worker/index.js forwards `/api/db/*` to the Supabase project so the browser
// never names a hostname the Bureau's filter has not categorised. That route
// carries every read, every write and the whole sign-in, and it does it with no
// Access identity and no secret — so the only things standing between it and
// being a proxy somebody else can aim are the two checks asserted here.
//
// Both fail *open* if they are wrong, and invisibly. A path check that is too
// generous still serves the app perfectly; it just also serves a request that
// should never have left the origin. A header allow-list that leaks the Access
// cookie to a third party breaks nothing anyone would notice. Neither shows up
// in the smoke test, because in both cases the app works.
//
// Run:  npm run dbproxy

import worker, { dbProxyTarget, dbProxyRequestHeaders, dbProxyIsUpgrade,
                 stationsDocTag, etagMatches, STATIONS_DOC_TAG_URL } from '../worker/index.js';

const UPSTREAM = 'https://jjprlritvhdqpvphfrnu.supabase.co';
const results = [];

function carries(what, pathname, search, expected) {
  const got = dbProxyTarget(pathname, search);
  results.push({ ok: got === expected, what, carried: true,
                 detail: got === expected ? got : `got ${got}` });
}

function refuses(what, pathname, search = '') {
  const got = dbProxyTarget(pathname, search);
  results.push({ ok: got === null, what, detail: got === null ? 'null' : `FORWARDED to ${got}` });
}

function header(what, ok, detail) {
  results.push({ ok, what, detail });
}

// An encoded slash or backslash inside a segment is not a path separator we can vouch for.
refuses('an encoded slash inside a segment', '/api/db/rest/v1/..%2f..%2fauth%2fv1%2fadmin');
refuses('an encoded backslash inside a segment', '/api/db/rest/v1/x%5cy');

// ── The three services it exists to carry ────────────────────────────────────
carries('a PostgREST table read', '/api/db/rest/v1/app_meta', '?select=value',
        `${UPSTREAM}/rest/v1/app_meta?select=value`);
carries('an RPC call', '/api/db/rest/v1/rpc/stations_doc', '',
        `${UPSTREAM}/rest/v1/rpc/stations_doc`);
carries('a GoTrue sign-in', '/api/db/auth/v1/otp', '',
        `${UPSTREAM}/auth/v1/otp`);
carries('a Storage upload', '/api/db/storage/v1/object/attachments/x.jpg', '',
        `${UPSTREAM}/storage/v1/object/attachments/x.jpg`);
carries('a service root with no path under it', '/api/db/rest/v1', '',
        `${UPSTREAM}/rest/v1`);
// The digital twin's room: a WebSocket to Realtime, the fourth service.
carries('the Realtime socket', '/api/db/realtime/v1/websocket', '?apikey=k&vsn=1.0.0',
        `${UPSTREAM}/realtime/v1/websocket?apikey=k&vsn=1.0.0`);

// ── Paths that are not its business ──────────────────────────────────────────
refuses('the gate route', '/api/session');
refuses('a static asset', '/index.html');
refuses('the migrations directory, which is a real asset path', '/db/migrations/0004_station_writes.sql');
refuses('the prefix with nothing after it', '/api/db/');

// A fourth Supabase API is still a different authority — pg_meta in particular
// is the one that would answer questions about the schema itself.
refuses('an unlisted Supabase service', '/api/db/pg/v1/query');
refuses('a service name this one is merely a prefix of', '/api/db/rest/v1x/secrets');
refuses('a bare service-shaped path outside the list', '/api/db/graphql/v1');

// ── Leaving the service root ─────────────────────────────────────────────────
// Each of these matches `rest/v1` and then walks back out of it. Whoever
// resolves the `..` afterwards is resolving it past the allow-list.
refuses('a traversal out of the service root', '/api/db/rest/v1/../../pg/v1/query');
refuses('a percent-encoded traversal', '/api/db/rest/v1/%2e%2e/%2e%2e/pg/v1/query');
refuses('a single-dot segment', '/api/db/rest/v1/./rpc/whoami');
refuses('a malformed escape', '/api/db/rest/v1/%zz/rpc/whoami');

// ── What reaches Supabase, and what stops here ───────────────────────────────
const sent = dbProxyRequestHeaders(new Headers({
  apikey: 'publishable-key',
  Authorization: 'Bearer the-callers-own-token',
  'Accept-Profile': 'meganet',
  'Content-Type': 'application/json',
  'x-upsert': 'false',
  'X-Ingest-Token': 'mgn_a-base-stations-token',
  // None of the below is Supabase's business, and two of them are identity.
  Cookie: 'CF_Authorization=an-access-session',
  'Cf-Access-Jwt-Assertion': 'the-access-identity',
  'CF-Connecting-IP': '203.0.113.7',
  Host: 'floodwarning.net',
  Referer: 'https://floodwarning.net/',
}));

header('the caller’s own token is forwarded',
       sent.get('authorization') === 'Bearer the-callers-own-token', sent.get('authorization'));
header('the publishable key is forwarded', sent.get('apikey') === 'publishable-key', sent.get('apikey'));
header('the schema profile is forwarded', sent.get('accept-profile') === 'meganet', sent.get('accept-profile'));
header('a Storage control header is forwarded', sent.get('x-upsert') === 'false', sent.get('x-upsert'));
header('a base station\'s ingest token is forwarded (the Serial Monitor posting from this origin)',
       sent.get('x-ingest-token') === 'mgn_a-base-stations-token', String(sent.get('x-ingest-token')));

header('the Access cookie is not', sent.get('cookie') === null, String(sent.get('cookie')));
header('the Access identity assertion is not',
       sent.get('cf-access-jwt-assertion') === null, String(sent.get('cf-access-jwt-assertion')));
header('the origin’s own Host is not', sent.get('host') === null, String(sent.get('host')));
header('the referer is not', sent.get('referer') === null, String(sent.get('referer')));

// Without this every request reaches Supabase from one address and one person's
// retries spend the whole project's auth rate limit.
header('the real caller is passed on for rate limiting',
       sent.get('x-forwarded-for') === '203.0.113.7', String(sent.get('x-forwarded-for')));

const noIp = dbProxyRequestHeaders(new Headers({ apikey: 'k' }));
header('no forwarded address is invented when there is none',
       noIp.get('x-forwarded-for') === null, String(noIp.get('x-forwarded-for')));

// ── The socket's handshake ───────────────────────────────────────────────────
// The upgrade headers go through on an upgrade and on nothing else: a plain
// request that carries them is not upgrading anything, and a socket without
// them never opens.
const wsHeaders = new Headers({
  apikey: 'k', Upgrade: 'websocket', Connection: 'Upgrade',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
  Cookie: 'CF_Authorization=an-access-session',
});
header('a WebSocket upgrade is recognised', dbProxyIsUpgrade(wsHeaders) === true, String(dbProxyIsUpgrade(wsHeaders)));
header('a plain request is not', dbProxyIsUpgrade(new Headers({ apikey: 'k' })) === false, 'false');
const up = dbProxyRequestHeaders(wsHeaders, true);
header('on an upgrade the handshake headers are forwarded',
       up.get('upgrade') === 'websocket' && up.get('connection') === 'Upgrade'
         && up.get('sec-websocket-key') === 'dGhlIHNhbXBsZSBub25jZQ==' && up.get('sec-websocket-version') === '13',
       `${up.get('upgrade')} ${up.get('connection')} ${up.get('sec-websocket-version')}`);
header('and the Access cookie still is not', up.get('cookie') === null, String(up.get('cookie')));
const plain = dbProxyRequestHeaders(wsHeaders);
header('on a plain request the handshake headers are stripped',
       plain.get('upgrade') === null && plain.get('connection') === null && plain.get('sec-websocket-key') === null,
       String(plain.get('upgrade')));

// ── The station list, when it has not changed ────────────────────────────────
// Its ETag is the ready-built list's built_at (0069), read before the list; a
// browser that names it is told 304 with no list, one that does not is sent the
// list with it, and when the note cannot be read the list goes as it always
// did. Supabase stood in for on fetch.
const AT = '2026-10-30T01:28:55.290353+00:00';
const TAG = `"sd-${AT}"`;
header('a built_at row is the list\'s ETag', stationsDocTag([{ built_at: AT }]) === TAG, String(stationsDocTag([{ built_at: AT }])));
header('no row, or a row that is not a time, is no ETag',
       stationsDocTag([]) === null && stationsDocTag(null) === null && stationsDocTag([{ built_at: 'x"y' }]) === null, 'null');
header('If-None-Match names it, as sent and as Cloudflare weakens it, in a list',
       etagMatches(TAG, TAG) && etagMatches(`W/${TAG}`, TAG) && etagMatches(`"other", ${TAG}`, TAG), 'matches');
header('a different or missing If-None-Match does not', !etagMatches('"sd-2026-01-01"', TAG) && !etagMatches(null, TAG), 'no match');

const realFetch = globalThis.fetch;
async function ask(ifNoneMatch, { tagOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url) === STATIONS_DOC_TAG_URL) {
      return tagOk ? new Response(JSON.stringify([{ built_at: AT }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('{"message":"nope"}', { status: 500 });
    }
    return new Response('{"stations":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const headers = { apikey: 'k', 'Accept-Profile': 'meganet', Accept: 'application/json' };
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const res = await worker.fetch(new Request('https://floodwarning.net/api/db/rest/v1/rpc/stations_doc', { headers }), {}, {});
    return { status: res.status, etag: res.headers.get('etag'), body: await res.text(), cache: res.headers.get('cache-control'), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  const same = await ask(`W/${TAG}`);
  header('the list unchanged: 304, its ETag, no body, and the list never asked for',
         same.status === 304 && same.etag === TAG && same.body === '' && same.cache === 'no-store'
           && same.calls.length === 1 && same.calls[0].url === STATIONS_DOC_TAG_URL,
         `${same.status} ${same.etag} ${same.calls.map(c => c.url.replace(UPSTREAM, '')).join(' then ')}`);
  header('the If-None-Match itself is not forwarded to Supabase',
         same.calls.every(c => !c.headers || c.headers.get('if-none-match') === null), 'not forwarded');
  const changed = await ask('"sd-2026-01-01T00:00:00+00:00"');
  header('the list changed: 200, the list, and its ETag — the note read first',
         changed.status === 200 && changed.etag === TAG && changed.body === '{"stations":[]}'
           && changed.calls.length === 2 && changed.calls[0].url === STATIONS_DOC_TAG_URL,
         `${changed.status} ${changed.etag} ${changed.calls.map(c => c.url.replace(UPSTREAM, '')).join(' then ')}`);
  const first = await ask(null);
  header('a first visit: the list with its ETag', first.status === 200 && first.etag === TAG && first.body === '{"stations":[]}',
         `${first.status} ${first.etag}`);
  const noNote = await ask(`W/${TAG}`, { tagOk: false });
  header('the note unreadable: the list as it always went, with no ETag',
         noNote.status === 200 && noNote.etag === null && noNote.body === '{"stations":[]}', `${noNote.status} ${noNote.etag}`);
}

console.log('');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.what} — ${r.detail}`);
console.log('');

const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} case(s) went the wrong way.\n`);
  console.log('  A path this forwards that it should not is a request leaving the origin\n'
            + '  under the app’s name; a header it forwards that it should not is identity\n'
            + '  handed to a third party. Neither is visible from outside once deployed.\n');
  process.exit(1);
}
const carried = results.filter(r => r.carried).length;
console.log(`PASS — the proxy carries its ${carried} legitimate shapes and refuses or strips the other ${results.length - carried}.`);
