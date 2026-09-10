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

import { dbProxyTarget, dbProxyRequestHeaders } from '../worker/index.js';

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
