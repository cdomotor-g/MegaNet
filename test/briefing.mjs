// Ask Claude on Flood-Net's key: the route (worker/briefing.js, #229) and what
// it lets past, offline.
//
// /api/briefing spends money on a key nobody in the browser holds, so the
// properties that matter are the ones that fail in silence — a briefing still
// arrives if any of them is wrong:
//
//   * who may spend it: an Access identity this Worker verified AND the
//     database's word (meganet.whoami, asked with the person's own session)
//     that the same address is an editor or an administrator. Signed out, a
//     forged or foreign Access token, a viewer, somebody off the editors list,
//     two identities that disagree — each refused, before Anthropic or the
//     ledger is touched;
//   * what it may be spent on: the briefing's own request and nothing else —
//     the model, max_tokens, thinking, effort, fallback, caching, prompt and
//     tools pinned, and a conversation of text and tool results;
//   * how much: every call reserved at its worst case and settled at what the
//     usage says (each fallback attempt at its own model's rates), a ceiling
//     on the day that holds with calls in flight, a minute's limit and an
//     in-flight cap per person, a call cut short settled at an upper bound;
//   * that the key goes upstream and nothing of the caller's does;
//   * that the page and the Worker agree: the request health-agent.js builds,
//     sent by the real SDK (the version the page pins) with the options the
//     page gives it, is accepted, streamed back and read as Anthropic's own;
//   * that none of it is reachable through the agent API (/api/v1, /api/mcp).
//
// Anthropic, the Access key set and the database are stand-ins on fetch; the
// ledger is the real Durable Object class over a Map; Access tokens are signed
// by a key made here.
//
// Run:  npm run briefing        (node briefing.mjs; -v lists what passed)

import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import Anthropic from '@anthropic-ai/sdk';
import { repo } from './lib/paths.mjs';
import { sseText } from './lib/anthropic-sse.mjs';
import worker, * as index from '../worker/index.js';
import * as api from '../worker/api.js';
import * as B from '../worker/briefing.js';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) { if (VERBOSE) console.log(`\n${title}`); }
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ── Access: a team, an application, a key made here ─────────────────────────

const TEAM = 'flood-team.cloudflareaccess.com';
const AUD = 'aud-tag-of-the-flood-net-application';
const KID = 'briefing-test-key';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KEYS = [{ kid: KID, kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }];
const b64url = buf => Buffer.from(buf).toString('base64url');

function accessToken(email, { aud = AUD, exp = 3600, signWith = privateKey, tamper = false } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const c = b64url(JSON.stringify({ aud: [aud], iss: `https://${TEAM}`, email, iat: now, exp: now + exp }));
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${c}`), { key: signWith, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${h}.${c}.${tamper ? b64url(Buffer.alloc(sig.length, 7)) : b64url(sig)}`;
}

// ── The database: whoami by session token ────────────────────────────────────

const WHO = {
  'editor-token':  { signed_in: true, email: 'editor@bom.gov.au', role: 'editor', may_write: true, is_admin: false },
  'editor2-token': { signed_in: true, email: 'second@bom.gov.au', role: 'editor', may_write: true, is_admin: false },
  'admin-token':   { signed_in: true, email: 'admin@bom.gov.au', role: 'admin', may_write: true, is_admin: true },
  'viewer-token':  { signed_in: true, email: 'viewer@bom.gov.au', role: 'viewer', may_write: true, is_admin: false },
  'outside-token': { signed_in: true, email: 'outside@example.org', role: 'editor', may_write: false, is_admin: false },
  'anon-token':    { signed_in: false, email: null, role: null, may_write: false, is_admin: false },
};
const ACCESS = Object.fromEntries(['editor@bom.gov.au', 'second@bom.gov.au', 'admin@bom.gov.au', 'viewer@bom.gov.au',
  'outside@example.org'].map(e => [e, accessToken(e)]));

// ── Anthropic, the key set and the database, on fetch ────────────────────────

const SECRET = 'sk-ant-api03-flood-net-worker-secret';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages?beta=true';
const upstream = { calls: [], script: [], cancelled: 0 };
const asked = { whoami: 0, jwks: 0 };

globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = req.url;
  if (url === `https://${TEAM}/cdn-cgi/access/certs`) { asked.jwks++; return Response.json({ keys: KEYS }); }
  if (url === `${api.SUPABASE_REST_URL}/rpc/whoami`) {
    asked.whoami++;
    const tok = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (tok === 'expired-token') return Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
    if (tok === 'down-token') return new Response('upstream connect error', { status: 503 });
    if (req.headers.get('apikey') !== api.PUBLISHABLE_KEY || req.headers.get('content-profile') !== 'meganet') {
      return Response.json({ message: 'whoami asked without the publishable key or the schema' }, { status: 400 });
    }
    return WHO[tok] ? Response.json(WHO[tok]) : Response.json({ message: 'invalid JWT' }, { status: 401 });
  }
  if (url === ANTHROPIC) {
    const body = new Uint8Array(await req.arrayBuffer());
    upstream.calls.push({ headers: Object.fromEntries(req.headers), body });
    const next = upstream.script.shift() || (() => sse(turn('A briefing.', { input_tokens: 100, output_tokens: 50 })));
    return next(req);
  }
  throw new TypeError(`fetch to ${url}, which no check expects`);
};

// What the SDK's stream ended in: its message, or {error} — so a route that
// broke fails the checks after it rather than ending the run.
const ended = async stream => { try { return await stream.finalMessage(); } catch (error) { return { error, content: [] }; } };
const turn = (text, usage, extra = {}) => ({ model: B.MODEL, content: [{ type: 'text', text }], usage, ...extra });
const sse = (message, headers = {}) => new Response(sseText(message), {
  status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test', ...headers } });

// A stream that sends its first `count` events (message_start, then a little
// text), then goes quiet — as Claude does while it thinks — until the reader
// goes away, which is counted.
function hanging(message, count = 3) {
  const enc = new TextEncoder();
  const events = sseText(message).split('\n\n').filter(Boolean).slice(0, count).map(e => `${e}\n\n`);
  return () => new Response(new ReadableStream({
    start(c) { events.forEach(e => c.enqueue(enc.encode(e))); },
    cancel() { upstream.cancelled++; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ── The ledger: the real class over a Map, counted ───────────────────────────

const store = new Map();
const ledgerAsked = [];
function ledgerNamespace() {
  const storage = {
    async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; },
    async put(k, v) { store.set(k, structuredClone(v)); },
  };
  let instance = new B.BriefingLedger({ storage, blockConcurrencyWhile: fn => fn() });
  return {
    // A new instance over the same storage: an evicted object, or another isolate's.
    restart() { instance = new B.BriefingLedger({ storage, blockConcurrencyWhile: fn => fn() }); },
    idFromName: name => ({ name }),
    get: () => ({ fetch: (url, init) => { ledgerAsked.push(new URL(url).pathname); return instance.fetch(new Request(url, init)); } }),
  };
}
const LEDGER = ledgerNamespace();
const ledger = () => B.ledgerState(store.get('ledger'));
function setLedger(fn) { const s = ledger(); fn(s); store.set('ledger', s); LEDGER.restart(); }

const env = { ANTHROPIC_API_KEY: SECRET, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, BRIEFING_LEDGER: LEDGER };
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };
// Every call's settling awaited — for five seconds at most, so a Worker that
// stopped settling fails its check instead of hanging the run.
async function settled(ms = 5000) {
  let timer;
  const late = new Promise(r => { timer = setTimeout(() => r('late'), ms); });
  try {
    while (pending.length) {
      if (await Promise.race([pending.shift().then(() => 'done', () => 'done'), late]) === 'late') return false;
    }
    return true;
  } finally { clearTimeout(timer); }
}

const ORIGIN = 'https://floodwarning.net';
// A call read to its end, and its own settling awaited — not that of calls a
// check has deliberately left running.
async function call(path, { method = 'GET', access, token, body, headers = {}, envOver } = {}) {
  const h = new Headers(headers);
  if (access) h.set('Cf-Access-Jwt-Assertion', access);
  if (token) h.set('Authorization', `Bearer ${token}`);
  if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
  const mine = [];
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)),
  }), envOver || env, { waitUntil: p => { mine.push(p); pending.push(p); } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* a stream, or plain text */ }
  await Promise.all(mine);
  return { status: res.status, headers: res.headers, text, json };
}
const asEditor = { access: ACCESS['editor@bom.gov.au'], token: 'editor-token' };
const asSecond = { access: ACCESS['second@bom.gov.au'], token: 'editor2-token' };
const post = (body, who = asEditor, more = {}) => call(B.MESSAGES_PATH, { method: 'POST', body, ...who, ...more });

// ── The page: health-agent.js, run as it is, for its request and options ─────
// Loaded into a context of its own with only what those two need: the origin,
// a signed-in editor's session, and fetch — which here carries the call to the
// Worker, adding the Access header Cloudflare adds at the edge.

const fromPage = [];
const pageFetch = async (url, init = {}) => {
  const headers = new Headers(init.headers);
  fromPage.push({ url: String(url), method: init.method, headers: Object.fromEntries(headers), credentials: init.credentials, body: init.body });
  headers.set('Cf-Access-Jwt-Assertion', ACCESS['editor@bom.gov.au']);
  return worker.fetch(new Request(url, { method: init.method, headers, body: init.body, signal: init.signal }), env, ctx);
};
const page = vm.createContext({
  console, Headers, URL,
  location: { origin: ORIGIN, protocol: 'https:' },
  Auth: { accessToken: () => 'editor-token' },
  fetch: pageFetch,
});
const HA = vm.runInContext(`${fs.readFileSync(repo('health-agent.js'), 'utf8')}\n;HealthAgent`, page, { filename: 'health-agent.js' });

const OPENING = [{ role: 'user', content: [
  { type: 'text', text: 'Overview of the analysed window (JSON):\n{"window":{"label":"7d"},"counts":{"attention":3}}' },
  { type: 'text', text: 'Investigate, then write the maintenance briefing.' },
] }];
// What the SDK sends for a request: everything but `betas` (a header), and
// `stream: true`. Section E holds this to what the real SDK puts on the wire.
function wire(params) {
  const { betas, ...body } = params;
  return JSON.parse(JSON.stringify({ ...body, stream: true }));
}
const good = () => wire(HA._params(structuredClone(OPENING)));
const mutate = fn => { const b = good(); fn(b); return b; };

// ── A. The paths, and the agent API's apart ─────────────────────────────────
section('A. Paths');

check('the briefing claims its own two paths', B.isBriefingPath('/api/briefing') && B.isBriefingPath('/api/briefing/v1/messages'));
check('…and not a neighbour', !B.isBriefingPath('/api/briefingx') && !B.isBriefingPath('/api/v1') && !B.isBriefingPath('/api/mcp'));
check('the agent API does not claim the briefing\'s paths', !api.isApiPath('/api/briefing') && !api.isApiPath('/api/briefing/v1/messages'));
{
  upstream.calls = []; ledgerAsked.length = 0;
  const viaApi = await call('/api/v1/messages', { method: 'POST', body: good(), ...asEditor });
  const viaMcp = await call(api.MCP_PATH, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ...asEditor,
    headers: { Accept: 'application/json, text/event-stream' } });
  const toolNames = viaMcp.json && viaMcp.json?.result ? viaMcp.json.result.tools.map(t => t.name) : [];
  check('a briefing sent to /api/v1 reaches neither Anthropic nor the ledger', viaApi.status !== 200 && upstream.calls.length === 0 && ledgerAsked.length === 0,
    `${viaApi.status}, ${upstream.calls.length} upstream, ${ledgerAsked.length} ledger`);
  check('the MCP server offers no model call, only its read-only tools', viaMcp.status === 200 && toolNames.length > 0
    && !toolNames.some(n => /brief|claude|messag|anthropic/i.test(n)) && upstream.calls.length === 0, toolNames.join(', '));
}
{
  const other = await call('/api/briefingx');
  const inner = await call('/api/briefing/v2/messages', asEditor);
  check('a path beside it is still the Worker\'s plain 404', other.status === 404 && other.text === 'Not found', `${other.status} ${other.text}`);
  check('a path under it that is not one of the two is a 404 of its own', inner.status === 404 && inner.json && inner.json?.code === 'not_found');
  const wrong = await call(B.BRIEFING_PREFIX, { method: 'POST', body: {}, ...asEditor });
  check('the status path is GET only', wrong.status === 405 && wrong.headers.get('allow') === 'GET');
}

// ── B. Not set up ────────────────────────────────────────────────────────────
section('B. Not set up');

for (const name of ['ANTHROPIC_API_KEY', 'BRIEFING_LEDGER', 'ACCESS_AUD']) {
  upstream.calls = [];
  const envOver = { ...env, [name]: undefined };
  const r = await post(good(), asEditor, { envOver });
  check(`without ${name} the route says so — 503, not set up, naming it — and spends nothing`,
    r.status === 503 && r.json?.code === 'not_configured' && r.json?.message.includes(name) && upstream.calls.length === 0, r.text.slice(0, 160));
}

// ── C. Who may spend it ──────────────────────────────────────────────────────
section('C. Who');

async function refused(what, who, status, code) {
  upstream.calls = []; ledgerAsked.length = 0;
  const g = await call(B.BRIEFING_PREFIX, who);
  const p = await post(good(), who);
  check(`${what}: refused, ${status} ${code}, and nothing spent or reserved`,
    g.status === status && p.status === status && g.json && p.json && g.json?.code === code && p.json?.code === code
      && upstream.calls.length === 0 && ledgerAsked.length === 0 && p.headers.get('x-should-retry') === (status === 503 ? 'true' : 'false'),
    `${g.status}/${p.status} ${p.json && p.json?.code} — ${p.json && p.json?.message}`);
  return p;
}

await refused('signed out — no Access identity, no session', {}, 401, 'no_access');
await refused('a session but no Access identity (workers.dev, github.io)', { token: 'editor-token' }, 401, 'no_access');
await refused('an Access token whose signature does not check out', { access: accessToken('editor@bom.gov.au', { tamper: true }), token: 'editor-token' }, 401, 'no_access');
await refused('an Access token signed by a key that is not the team\'s', { access: accessToken('editor@bom.gov.au', { signWith: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), token: 'editor-token' }, 401, 'no_access');
await refused('an Access token for another application', { access: accessToken('editor@bom.gov.au', { aud: 'another-app' }), token: 'editor-token' }, 401, 'no_access');
await refused('an expired Access token', { access: accessToken('editor@bom.gov.au', { exp: -3600 }), token: 'editor-token' }, 401, 'no_access');
await refused('Access, but no Flood-Net session on the page', { access: ACCESS['editor@bom.gov.au'] }, 401, 'not_signed_in');
await refused('Access, and a session the database has expired', { access: ACCESS['editor@bom.gov.au'], token: 'expired-token' }, 401, 'not_signed_in');
await refused('Access, and a token the database calls signed out', { access: ACCESS['editor@bom.gov.au'], token: 'anon-token' }, 401, 'not_signed_in');
const mixed = await refused('an editor\'s session behind somebody else\'s Access sign-in', { access: ACCESS['viewer@bom.gov.au'], token: 'editor-token' }, 403, 'not_permitted');
check('…saying both addresses', /editor@bom\.gov\.au/.test(mixed.json?.message) && /viewer@bom\.gov\.au/.test(mixed.json?.message), mixed.json?.message);
const viewer = await refused('a viewer', { access: ACCESS['viewer@bom.gov.au'], token: 'viewer-token' }, 403, 'not_permitted');
check('…told it is for editors and administrators', /editors and administrators/.test(viewer.json?.message) && /viewer/.test(viewer.json?.message), viewer.json?.message);
const outside = await refused('signed in, but not on the editors list', { access: ACCESS['outside@example.org'], token: 'outside-token' }, 403, 'not_permitted');
check('…told so', /not on the editors list/.test(outside.json?.message), outside.json?.message);
await refused('the database not answering', { access: ACCESS['editor@bom.gov.au'], token: 'down-token' }, 503, 'unavailable');

{
  const g = await call(B.BRIEFING_PREFIX, asEditor);
  check('an editor may: today\'s allowance, whole', g.status === 200 && g.json?.ok === true && g.json?.role === 'editor'
    && g.json?.limit_usd === B.DAILY_LIMIT_USD && g.json?.left_usd === B.DAILY_LIMIT_USD && g.json?.model === B.MODEL, g.text);
  check('…and the answer is not to be cached anywhere', /no-store/.test(g.headers.get('cache-control') || ''));
  const a = await call(B.BRIEFING_PREFIX, { access: ACCESS['admin@bom.gov.au'], token: 'admin-token' });
  check('an administrator may', a.status === 200 && a.json?.role === 'admin', a.text);
  const cookie = await call(B.BRIEFING_PREFIX, { token: 'editor-token', headers: { Cookie: `theme=dark; CF_Authorization=${ACCESS['editor@bom.gov.au']}` } });
  check('the Access cookie serves as well as the header, as it does for the session exchange', cookie.status === 200, cookie.text.slice(0, 120));
  const before = asked.whoami;
  await call(B.BRIEFING_PREFIX, asEditor);
  check('the database is asked once a minute per session, not once a call', asked.whoami === before, `${asked.whoami - before} more`);
}

// ── D. What it may be spent on ───────────────────────────────────────────────
section('D. Shape');

check('the request health-agent.js builds is a briefing request', B.requestProblem(good()) === null, JSON.stringify(B.requestProblem(good())));
{
  const p = HA._params(structuredClone(OPENING));
  check('…on the betas the route sends, the model it runs and the effort it allows',
    JSON.stringify([...p.betas]) === JSON.stringify([...B.BETAS]) && p.model === B.MODEL && p.max_tokens === B.MAX_TOKENS
      && B.EFFORTS.includes(p.output_config.effort), JSON.stringify({ betas: p.betas, model: p.model, effort: p.output_config.effort }));
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  check('the prompt in worker/briefing.js is health-agent.js\'s, word for word — copy it across if not', HA._system === B.SYSTEM);
  check('…and so are the nine tools', canon(JSON.parse(JSON.stringify(HA._tools)).map(t => { const { eager_input_streaming, ...r } = t; return r; }))
    === canon(JSON.parse(JSON.stringify(B.TOOLS))), `${HA._tools.length} in the page, ${B.TOOLS.length} in the Worker`);
}

const SHAPES = [
  ['another model', b => { b.model = 'claude-fable-5-1'; }, 'invalid_request'],
  ['more output', b => { b.max_tokens = 128000; }, 'invalid_request'],
  ['not streamed', b => { b.stream = false; }, 'invalid_request'],
  ['no fallback', b => { delete b.fallbacks; }, 'invalid_request'],
  ['thinking shown in full', b => { b.thinking = { type: 'adaptive', display: 'summarized' }; }, 'invalid_request'],
  ['effort max', b => { b.output_config = { effort: 'max' }; }, 'invalid_request'],
  ['a task budget', b => { b.output_config.task_budget = { type: 'tokens', total: 900000 }; }, 'invalid_request'],
  ['an hour\'s cache', b => { b.cache_control = { type: 'ephemeral', ttl: '1h' }; }, 'invalid_request'],
  ['a tool_choice', b => { b.tool_choice = { type: 'auto' }; }, 'invalid_request'],
  ['an MCP server', b => { b.mcp_servers = [{ type: 'url', url: 'https://example.org/mcp', name: 'x' }]; }, 'invalid_request'],
  ['a different system prompt', b => { b.system[0].text = b.system[0].text.replace('Flood-Net', 'a poetry club'); }, 'stale_page'],
  ['a system prompt of its own', b => { b.system = 'You are a helpful assistant.'; }, 'stale_page'],
  ['a tool more', b => { b.tools.push({ name: 'web_search', type: 'web_search_20260209' }); }, 'stale_page'],
  ['a tool described differently', b => { b.tools[0].description = 'Anything at all.'; }, 'stale_page'],
  ['no tools', b => { delete b.tools; }, 'stale_page'],
  ['Claude speaking first', b => { b.messages.unshift({ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }); }, 'invalid_request'],
  ['Claude speaking last (a prefill)', b => { b.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Sure' }] }); }, 'invalid_request'],
  ['the person twice in a row', b => { b.messages.push({ role: 'user', content: [{ type: 'text', text: 'again' }] }); }, 'invalid_request'],
  ['an image', b => { b.messages[0].content.push({ type: 'image', source: { type: 'url', url: 'https://example.org/x.png' } }); }, 'invalid_request'],
  ['a document', b => { b.messages[0].content.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }); }, 'invalid_request'],
  ['a system message mid-conversation', b => { b.messages.push({ role: 'system', content: [{ type: 'text', text: 'x' }] }); }, 'invalid_request'],
  ['a text block with cache_control of its own', b => { b.messages[0].content[0].cache_control = { type: 'ephemeral' }; }, 'invalid_request'],
  ['a tool result carrying an image', b => {
    b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'receivers', input: {} }] });
    b.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'url', url: 'https://example.org/x.png' } }] }] });
  }, 'invalid_request'],
  ['a server tool call on Claude\'s side', b => {
    b.messages.push({ role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }] });
    b.messages.push({ role: 'user', content: [{ type: 'text', text: 'go on' }] });
  }, 'invalid_request'],
  ['content as a bare string', b => { b.messages[0].content = 'hello'; }, 'invalid_request'],
  ['no messages', b => { b.messages = []; }, 'invalid_request'],
  ['more messages than a briefing has', b => {
    for (let i = 0; i < B.MAX_MESSAGES; i++) b.messages.push(i % 2 ? { role: 'user', content: [{ type: 'text', text: 'q' }] } : { role: 'assistant', content: [{ type: 'text', text: 'a' }] });
  }, 'invalid_request'],
];
upstream.calls = []; ledgerAsked.length = 0;
for (const [what, fn, code] of SHAPES) {
  const r = await post(mutate(fn));
  check(`refused: ${what} — ${code}`, r.status === 400 && r.json && r.json?.code === code && r.headers.get('x-should-retry') === 'false',
    `${r.status} ${r.json && r.json?.code}: ${r.json && r.json?.message}`);
}
check('…none of them reached Anthropic or reserved anything', upstream.calls.length === 0 && ledgerAsked.length === 0,
  `${upstream.calls.length} upstream, ${ledgerAsked.join(',')}`);
{
  const stale = await post(mutate(b => { b.tools[0].description = 'Old.'; }));
  check('a page with an older prompt or tools is told to reload', /reload the page/.test(stale.json?.message), stale.json?.message);
  const notJson = await post('{"model": "claude-opus-5-5", ');
  check('not JSON: 400', notJson.status === 400 && notJson.json?.code === 'invalid_request');
  const text = await post(JSON.stringify(good()), asEditor, { headers: { 'Content-Type': 'text/plain' } });
  check('not sent as JSON: 415', text.status === 415, `${text.status}`);
  const big = mutate(b => { b.messages[0].content[0].text += 'x'.repeat(B.MAX_BODY_BYTES); });
  const declared = await post(JSON.stringify(big));
  check('past the size a call may carry, by its Content-Length: 413', declared.status === 413 && declared.json?.code === 'too_large', `${declared.status}`);
  const enc = new TextEncoder().encode(JSON.stringify(big));
  const chunked = await worker.fetch(new Request(`${ORIGIN}${B.MESSAGES_PATH}`, {
    method: 'POST', duplex: 'half',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': asEditor.access, Authorization: 'Bearer editor-token' },
    body: new ReadableStream({ start(c) { for (let i = 0; i < enc.length; i += 65536) c.enqueue(enc.subarray(i, i + 65536)); c.close(); } }),
  }), env, ctx);
  check('…and by what arrives when no length is declared', chunked.status === 413, `${chunked.status}`);
  check('…neither reached Anthropic', upstream.calls.length === 0);
}
{
  // A body that names the model twice: JSON.parse keeps the second, which is
  // the pinned one, while a parser that kept the first would run another
  // model, at more output. What goes upstream must be what was checked.
  setLedger(s => { s.spent = 0; s.holds = {}; s.recent = {}; });
  upstream.calls = [];
  upstream.script = [() => sse(turn('ok', { input_tokens: 10, output_tokens: 5 }))];
  const twice = `{"model":"claude-fable-5-1","max_tokens":128000,${JSON.stringify(good()).slice(1)}`;
  const r = await post(twice);
  const went = upstream.calls[0] ? Buffer.from(upstream.calls[0].body).toString() : '';
  check('a key given twice reaches Anthropic once — the value that was checked, never the other',
    r.status === 200 && went && !went.includes('claude-fable-5-1') && !went.includes('128000')
      && went.split('"model"').length === 2 && JSON.parse(went).model === B.MODEL, `${r.status} ${went.slice(0, 80)}`);
}
{
  // A conversation as the loop builds it: thinking, a tool call, its result,
  // a fallback marker, an error result, and a follow-up question.
  const b = mutate(x => {
    x.messages.push({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'Checking the repeater first.', signature: 'c2ln' },
      { type: 'tool_use', id: 't1', name: 'repeaters', input: { limit: 5 } },
      { type: 'tool_use', id: 't2', name: 'no_such_tool', input: {} }] });
    x.messages.push({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: '{"repeaters":[]}' },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: '{"error":"No tool called no_such_tool."}' }] });
    x.messages.push({ role: 'assistant', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'redacted_thinking', data: 'xyz' }, { type: 'text', text: '## Headline\nAll quiet.', citations: null }] });
    x.messages.push({ role: 'user', content: [{ type: 'text', text: 'Is the battery the cause?' }, { type: 'text', text: 'Answer directly.' }] });
  });
  check('a whole conversation as the loop builds it passes — a tool Claude made up is the loop\'s to refuse, not the route\'s',
    B.requestProblem(b) === null, JSON.stringify(B.requestProblem(b)));
}

// ── E. The page, the real SDK and the route, end to end ──────────────────────
section('E. End to end');

const pinned = JSON.parse(fs.readFileSync(repo('test/package.json'), 'utf8')).devDependencies['@anthropic-ai/sdk'];
const pageSdk = (/@anthropic-ai\/sdk@([\d.]+)/.exec(fs.readFileSync(repo('health-agent.js'), 'utf8')) || [])[1];
check('the SDK checked here is the version the page loads', pinned === pageSdk, `test ${pinned}, page ${pageSdk}`);

{
  const opts = HA._clientOptions('route');
  check('on the route the page gives the SDK this origin\'s Worker, its session and no key',
    opts.baseURL === `${ORIGIN}/api/briefing` && opts.apiKey === null && opts.authToken === 'editor-token' && typeof opts.fetch === 'function',
    JSON.stringify({ baseURL: opts.baseURL, apiKey: opts.apiKey, authToken: opts.authToken }));
  const own = HA._clientOptions('own');
  check('on the person\'s own key it gives the key, and no Worker', own.baseURL === undefined && own.fetch === undefined && 'apiKey' in own);

  setLedger(s => { s.spent = 0; s.calls = 0; s.holds = {}; s.recent = {}; s.looks = {}; });
  upstream.calls = []; fromPage.length = 0;
  const first = { model: B.MODEL, content: [
    { type: 'thinking', thinking: 'Looking at the repeaters first.', signature: 'c2lnMQ==' },
    { type: 'tool_use', id: 'toolu_1', name: 'repeaters', input: { limit: 5 } }], stop_reason: 'tool_use',
    usage: { input_tokens: 2400, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0, output_tokens: 310 } };
  const second = { model: B.MODEL, content: [{ type: 'text', text: '## Headline\nOne repeater explains it.' }], stop_reason: 'end_turn',
    usage: { input_tokens: 600, cache_creation_input_tokens: 400, cache_read_input_tokens: 11400, output_tokens: 520 } };
  upstream.script = [() => sse(first), () => sse(second)];

  const client = new Anthropic(opts);
  const conversation = structuredClone(OPENING);
  let notes = '';
  const s1 = client.beta.messages.stream(HA._params(conversation));
  s1.on('thinking', d => { notes += d; });
  const m1 = await ended(s1);
  await settled();
  const sent = fromPage[0] || {};
  check('the SDK\'s call went to the route, carrying the session and no key',
    /\/api\/briefing\/v1\/messages\?beta=true$/.test(sent.url) && sent.headers.authorization === 'Bearer editor-token'
      && !('x-api-key' in sent.headers) && sent.credentials === 'same-origin', JSON.stringify({ url: sent.url, auth: sent.headers.authorization, key: sent.headers['x-api-key'] }));
  check('…with the body this check calls a briefing\'s, field for field', JSON.stringify(JSON.parse(sent.body)) === JSON.stringify(good()));
  const up = upstream.calls[0] || { headers: {} };
  check('Anthropic got exactly the bytes the page sent', up.body && Buffer.from(up.body).toString() === sent.body);
  check('…under Flood-Net\'s key, the route\'s betas and the API version, and nothing of the caller\'s',
    up.headers['x-api-key'] === SECRET && up.headers['anthropic-beta'] === B.BETAS.join(',') && up.headers['anthropic-version'] === '2023-06-01'
      && !up.headers.authorization && !up.headers.cookie && !up.headers['cf-access-jwt-assertion'] && !up.headers['anthropic-dangerous-direct-browser-access'],
    Object.keys(up.headers).join(', '));
  check('the SDK read the stream as Anthropic\'s: its thinking note and its tool call',
    m1.stop_reason === 'tool_use' && notes === 'Looking at the repeaters first.' && m1.content[1] && m1.content[1].name === 'repeaters'
      && JSON.stringify(m1.content[1].input) === '{"limit":5}', JSON.stringify(m1.content));

  conversation.push({ role: 'assistant', content: m1.content });
  conversation.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"repeaters":[]}' }] });
  let text = '';
  const s2 = client.beta.messages.stream(HA._params(conversation));
  s2.on('text', d => { text += d; });
  const m2 = await ended(s2);
  await settled();
  check('the next turn, with the SDK\'s own blocks handed back, is a briefing too', m2.stop_reason === 'end_turn' && text === '## Headline\nOne repeater explains it.', text);
  const l = ledger();
  const expect = B.usageUsd(first.usage, B.MODEL) + B.usageUsd(second.usage, B.MODEL);
  check('the day is charged what the two calls used, at Opus 5.5\'s prices, and nothing is left held',
    near(l.spent, expect) && l.calls === 2 && Object.keys(l.holds).length === 0, `${l.spent} vs ${expect}`);
  check('…which is what the page itself would show', near(B.usageUsd(first.usage, B.MODEL),
    (2400 * 4 + 9000 * 5 + 310 * 20) / 1e6), `${B.usageUsd(first.usage, B.MODEL)}`);

  // A refusal from the route arrives as the SDK's own error, saying what it is.
  setLedger(s => { s.spent = B.DAILY_LIMIT_USD - 0.5; });
  const before = fromPage.length;
  let err = null;
  try { await client.beta.messages.stream(HA._params(structuredClone(OPENING))).finalMessage(); } catch (e) { err = e; }
  check('the day spent: the SDK throws a 429 carrying the route\'s code and words, and does not retry it',
    err && err.status === 429 && err.error && err.error.code === 'daily_limit' && /allowance for today/.test(err.message)
      && fromPage.length === before + 1, `${err && err.status} ${err && err.message} after ${fromPage.length - before} call(s)`);
  setLedger(s => { s.spent = 0; });
}

// ── F. What a call costs, and what it is charged ─────────────────────────────
section('F. Spend');

{
  const u = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 4000 };
  check('usage at Opus 5.5\'s prices', near(B.usageUsd(u, 'claude-opus-5-5'), (1000 * 4 + 2000 * 5 + 30000 * 0.2 + 4000 * 20) / 1e6));
  const hour = { input_tokens: 0, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, output_tokens: 0 };
  check('an hour\'s cache writes at twice the input price', near(B.usageUsd(hour, 'claude-opus-5-5'), (1000 * 5 + 2000 * 8) / 1e6));
  const fb = { input_tokens: 412, output_tokens: 264, iterations: [
    { type: 'message', model: 'claude-opus-5-5', input_tokens: 535, output_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 412, output_tokens: 264 }] };
  check('a fallback charges every attempt at its own model\'s rates', near(B.usageUsd(fb, 'claude-opus-4-8'), (535 * 4 + 412 * 5 + 264 * 25) / 1e6));
  check('a model the table does not know is priced as the dearest there is', B.usageUsd({ input_tokens: 1e6 }, 'claude-new') >= 10);
  check('a call\'s worst case covers its whole output at the dearest output rate', B.worstCaseUsd(0) === B.MAX_TOKENS * 25 / 1e6, `${B.worstCaseUsd(0)}`);
}
{
  // The meter, fed the same stream whole and in pieces cut anywhere —
  // through a multi-byte character and between a \r and its \n.
  const msg = { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Brisbane — 12.4 V ✓' }],
    usage: { input_tokens: 77, output_tokens: 88, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 70, output_tokens: 3 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 77, output_tokens: 88 }] } };
  const lf = new TextEncoder().encode(sseText(msg));
  const crlf = new TextEncoder().encode(sseText(msg).replace(/\n/g, '\r\n'));
  const whole = new B.UsageMeter(); whole.push(lf);
  let same = true;
  for (const bytes of [lf, crlf]) {
    for (const step of [1, 2, 3, 7, 64]) {
      const m = new B.UsageMeter();
      for (let i = 0; i < bytes.length; i += step) m.push(bytes.subarray(i, i + step));
      if (!m.complete || !near(m.usd({ elapsedMs: 0, bytes: 0 }), whole.usd({ elapsedMs: 0, bytes: 0 })) || m.model !== 'claude-opus-4-8') same = false;
    }
  }
  check('the meter reads the usage alike whole, byte by byte, and with CRLF', whole.complete && same,
    `${whole.usd({ elapsedMs: 0, bytes: 0 })}`);
  check('…and charges the fallback\'s attempts', near(whole.usd({ elapsedMs: 0, bytes: 0 }), (70 * 4 + 3 * 20 + 77 * 5 + 88 * 25) / 1e6));
}
{
  setLedger(s => { s.spent = 0; s.calls = 0; s.holds = {}; });
  const fbMsg = { model: 'claude-opus-4-8', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
    { type: 'text', text: 'Answered on the fallback.' }],
    usage: { input_tokens: 5000, output_tokens: 900, iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 5100, output_tokens: 0 },
      { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 5000, output_tokens: 900 }] } };
  upstream.script = [() => sse(fbMsg)];
  const r = await post(good());
  check('a stream is passed through byte for byte', r.status === 200 && r.text === sseText(fbMsg)
    && /^text\/event-stream/.test(r.headers.get('content-type')) && r.headers.get('request-id') === 'req_test');
  check('…and the day is charged both attempts of a fallback', near(ledger().spent, B.usageUsd(fbMsg.usage, 'claude-opus-4-8')), `${ledger().spent}`);
}
{
  setLedger(s => { s.spent = 0; s.holds = {}; });
  upstream.script = [() => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 })];
  const r = await post(good());
  check('Anthropic refusing the key is the Worker\'s fault, not the person\'s: 502, said so, nothing charged',
    r.status === 502 && r.json?.code === 'key_refused' && /ANTHROPIC_API_KEY/.test(r.json?.message) && ledger().spent === 0 && !Object.keys(ledger().holds).length, r.text);
  upstream.script = [() => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529, headers: { 'x-should-retry': 'true' } })];
  const o = await post(good());
  check('Anthropic overloaded: its answer passed on as it was, nothing charged', o.status === 529 && o.json?.error?.type === 'overloaded_error'
    && o.headers.get('x-should-retry') === 'true' && ledger().spent === 0 && !Object.keys(ledger().holds).length, `${o.status}`);
  // Anthropic that never starts answering: given up on, and charged its input
  // — it may have begun — but not its output.
  B._test.headersTimeout(50);
  upstream.script = [req => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))];
  const t = await post(good());
  B._test.headersTimeout(null);
  const tl = ledger();
  const input = Math.ceil(new TextEncoder().encode(JSON.stringify(good())).length / 2) * 6.25 / 1e6;
  check('Anthropic never answering: given up, 502, charged its input but no output', t.status === 502 && t.json?.code === 'upstream_unreachable'
    && near(tl.spent, input) && !Object.keys(tl.holds).length, `${t.status} ${tl.spent} vs ${input}`);
  setLedger(s => { s.spent = 0; });
  upstream.script = [() => { throw new TypeError('connect ECONNREFUSED'); }];
  const d = await post(good());
  check('Anthropic unreachable: 502, nothing charged', d.status === 502 && d.json?.code === 'upstream_unreachable' && ledger().spent === 0
    && !Object.keys(ledger().holds).length, d.text);
}
{
  // Stop pressed mid-call, while Claude is thinking and Anthropic is sending
  // nothing: the browser cancels the stream, and only the Worker noticing the
  // browser gone — not a write failing — can stop Anthropic.
  setLedger(s => { s.spent = 0; s.holds = {}; });
  const startUsage = { input_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000, output_tokens: 1 };
  upstream.script = [hanging({ model: B.MODEL, content: [{ type: 'text', text: 'Half an answer' }], usage: startUsage }, 1)];
  upstream.cancelled = 0;
  const res = await worker.fetch(new Request(`${ORIGIN}${B.MESSAGES_PATH}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': asEditor.access, Authorization: 'Bearer editor-token' },
    body: JSON.stringify(good()) }), env, ctx);
  const reader = res.body.getReader();
  await reader.read();
  check('mid-call, the call is held, not yet charged', Object.keys(ledger().holds).length === 1 && ledger().spent === 0);
  await reader.cancel();
  await settled();
  const l = ledger();
  const floor = (3000 * 5 + 20000 * 0.5) / 1e6;      // its input at the dearest rates
  check('Stop: Anthropic is told to stop too', upstream.cancelled === 1, `${upstream.cancelled}`);
  check('…and the call is settled at its input and the most it could have written by then — more than nothing, less than its worst case',
    !Object.keys(l.holds).length && l.spent > floor && l.spent < B.worstCaseUsd(JSON.stringify(good()).length), `${l.spent}`);
}

// ── G. The limits ────────────────────────────────────────────────────────────
section('G. Limits');

{
  setLedger(s => { s.spent = 0; s.holds = {}; s.recent = {}; });
  upstream.calls = [];
  let okCount = 0;
  for (let i = 0; i < B.PER_PERSON.callsPerMinute; i++) if ((await post(good())).status === 200) okCount++;
  const over = await post(good());
  check(`${B.PER_PERSON.callsPerMinute} calls in a minute are let through`, okCount === B.PER_PERSON.callsPerMinute, `${okCount}`);
  check('…the next is refused, saying when to try again, and the SDK may retry it then',
    over.status === 429 && over.json?.code === 'rate_limited' && Number(over.headers.get('retry-after')) > 0
      && over.headers.get('x-should-retry') === 'true' && upstream.calls.length === B.PER_PERSON.callsPerMinute, `${over.status} ${over.json && over.json?.code}`);
  const other = await post(good(), asSecond);
  check('…and it is that person\'s limit, not everybody\'s', other.status === 200, `${other.status}`);
}
{
  setLedger(s => { s.spent = 0; s.holds = {}; s.recent = {}; });
  const open = [];
  for (let i = 0; i < B.PER_PERSON.inFlight; i++) {
    upstream.script.push(hanging({ model: B.MODEL, content: [{ type: 'text', text: '…' }], usage: { input_tokens: 10, output_tokens: 1 } }));
    const res = await worker.fetch(new Request(`${ORIGIN}${B.MESSAGES_PATH}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': asEditor.access, Authorization: 'Bearer editor-token' },
      body: JSON.stringify(good()) }), env, ctx);
    open.push(res.body.getReader());
  }
  const third = await post(good());
  check(`one call more while a person's ${B.PER_PERSON.inFlight} are still running is refused`, third.status === 429 && third.json?.code === 'busy', third.text.slice(0, 120));
  for (const r of open) await r.cancel();
  await settled();
  check('…and once they end, nothing is held', !Object.keys(ledger().holds).length);
}
{
  // The ceiling: reserved at the worst case, so it holds with calls in flight.
  setLedger(s => { s.spent = B.DAILY_LIMIT_USD - B.worstCaseUsd(JSON.stringify(good()).length) - 0.01; s.holds = {}; s.recent = {}; });
  upstream.calls = [];
  upstream.script = [hanging({ model: B.MODEL, content: [{ type: 'text', text: '…' }], usage: { input_tokens: 10, output_tokens: 1 } })];
  const res = await worker.fetch(new Request(`${ORIGIN}${B.MESSAGES_PATH}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': asEditor.access, Authorization: 'Bearer editor-token' },
    body: JSON.stringify(good()) }), env, ctx);
  const held = res.body.getReader();
  const second = await post(good(), asSecond);
  check('the last call that fits is let through; a second, with the first still running, is not',
    res.status === 200 && second.status === 429 && second.json?.code === 'daily_limit' && upstream.calls.length === 1,
    `${res.status}, ${second.status} ${second.json && second.json?.code}`);
  check('…told the day is spent, when it starts again, and that their own key works',
    /US\$20\.00/.test(second.json?.message) && /midnight, Brisbane time/.test(second.json?.message) && /own key/.test(second.json?.message)
      && second.headers.get('x-should-retry') === 'false' && second.json?.left_usd >= 0 && typeof second.json?.resets_at === 'string', second.json?.message);
  await held.cancel();
  await settled();
  setLedger(s => { s.spent = B.DAILY_LIMIT_USD; s.holds = {}; });
  const g = await call(B.BRIEFING_PREFIX, asEditor);
  check('a spent day answers the page\'s question the same way, so it offers the person\'s own key',
    g.status === 429 && g.json?.code === 'daily_limit', `${g.status} ${g.json && g.json?.code}`);
  setLedger(s => { s.spent = 0; });
}
{
  // The arithmetic, over time, without the Worker.
  const T = Date.parse('2026-10-07T13:00:00Z');            // 11 pm in Brisbane
  const s = B.ledgerState(null);
  const a = B.ledgerReserve(s, { who: 'x', usd: 2 }, T);
  check('a reservation counts against the day at once', a.ok && a.held_usd === 2 && a.left_usd === B.DAILY_LIMIT_USD - 2 && a.day === '2026-10-07', JSON.stringify(a));
  B.ledgerSettle(s, { id: a.id, usd: 0.4 }, T + 1000);
  check('…and is settled at what was used', s.spent === 0.4 && !Object.keys(s.holds).length && s.calls === 1);
  check('a late second settle of the same call counts nothing', B.ledgerSettle(s, { id: a.id, usd: 9 }, T + 2000).settled === false && s.spent === 0.4);
  check('the day is Brisbane\'s: 13:59 UTC is still the 7th, 14:00 UTC is the 8th', B.dayOf(Date.parse('2026-10-07T13:59:59Z')) === '2026-10-07'
    && B.dayOf(Date.parse('2026-10-07T14:00:00Z')) === '2026-10-08');
  check('…and resets at its midnight', B.ledgerStatus(B.ledgerState(null), { who: 'x' }, T).resets_at === '2026-10-07T14:00:00.000Z');
  const b = B.ledgerReserve(s, { who: 'x', usd: 3 }, T + 3000);
  const next = B.ledgerStatus(s, { who: 'y' }, T + 3600 * 1000);
  check('a new day starts at nothing spent, with a call still running held over into it',
    next.day === '2026-10-08' && next.spent_usd === 0 && next.held_usd === 3, JSON.stringify(next));
  B.ledgerStatus(s, { who: 'y' }, T + 3000 + 61 * 60 * 1000);
  check('a hold its Worker never settled is charged its whole worst case when it lapses', s.spent === 3 && !s.holds[b.id], `${s.spent}`);
  const full = B.ledgerState({ day: '2026-10-08', spent: B.DAILY_LIMIT_USD - 1 });
  check('a call whose worst case does not fit is refused even with a dollar left', B.ledgerReserve(full, { who: 'x', usd: 1.5 }, T + 3600 * 1000).reason === 'daily_limit');
  check('…one that fits is not', B.ledgerReserve(full, { who: 'x', usd: 0.9 }, T + 3600 * 1000).ok === true);
  const looks = B.ledgerState(null);
  let looked = 0;
  for (let i = 0; i <= B.PER_PERSON.looksPerMinute; i++) if (B.ledgerStatus(looks, { who: 'x' }, T + i).ok) looked++;
  check(`asking how much is left is limited too (${B.PER_PERSON.looksPerMinute} a minute)`, looked === B.PER_PERSON.looksPerMinute, `${looked}`);
}
{
  // What a call is charged is kept by the object itself, not only in its memory:
  // a restarted ledger (evicted, or another isolate's) still knows the day.
  setLedger(s => { s.spent = 0; s.calls = 0; s.holds = {}; s.recent = {}; s.looks = {}; });
  const kept = { input_tokens: 1000, output_tokens: 1000 };
  upstream.script = [() => sse(turn('kept', kept))];
  const r = await post(good());
  LEDGER.restart();
  const g = await call(B.BRIEFING_PREFIX, asEditor);
  const want = Math.round(B.usageUsd(kept, B.MODEL) * 100) / 100;
  check('the spend outlives the object holding it: a restarted ledger still knows the day', r.status === 200 && g.json
    && g.json?.spent_usd === want && g.json?.calls === 1, `${g.json && g.json?.spent_usd} vs ${want}`);
  setLedger(s => { s.spent = 0; s.calls = 0; });
}

// ── H. Deployed as written ───────────────────────────────────────────────────
section('H. Config and docs');

{
  const toml = fs.readFileSync(repo('wrangler.toml'), 'utf8');
  check('wrangler.toml binds BRIEFING_LEDGER to the BriefingLedger class',
    /\[\[durable_objects\.bindings\]\]\s*\nname = "BRIEFING_LEDGER"\s*\nclass_name = "BriefingLedger"/.test(toml));
  check('…and creates it SQLite-backed, the kind the Free plan has', /\[\[migrations\]\]\s*\ntag = "[^"]+"\s*\nnew_sqlite_classes = \["BriefingLedger"\]/.test(toml));
  check('the Worker\'s main module exports the class, as Durable Objects require', index.BriefingLedger === B.BriefingLedger);
  const accessDoc = fs.readFileSync(repo('docs/access.md'), 'utf8');
  const healthDoc = fs.readFileSync(repo('docs/station-health.md'), 'utf8');
  const limit = `US$${B.DAILY_LIMIT_USD}`;
  check('docs/access.md says how to set ANTHROPIC_API_KEY, and the ceiling the code sets', /ANTHROPIC_API_KEY/.test(accessDoc) && accessDoc.includes(limit), limit);
  check('docs/station-health.md says the same ceiling', healthDoc.includes(limit));
  const flat = accessDoc.replace(/\s+/g, ' ');
  check('…and docs/access.md each person\'s limits as the code sets them', flat.includes(`start ${B.PER_PERSON.callsPerMinute} calls a minute`)
    && flat.includes(`run ${B.PER_PERSON.inFlight} at once`), `${B.PER_PERSON.callsPerMinute} / ${B.PER_PERSON.inFlight}`);
  check('the agent API\'s doc does not mention the route — it is not part of that API', !/api\/briefing/.test(fs.readFileSync(repo('docs/agent-api.md'), 'utf8')));
}

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log('');
const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} check(s) failed.\n`);
  console.log('  The briefing route spends money on a key nobody in the browser holds: a check');
  console.log('  that fails here is somebody it should refuse, a request it should not carry, or');
  console.log('  a ceiling that no longer holds — and a briefing would still arrive.\n');
  process.exit(1);
}
console.log(`PASS — ${results.length} checks: Flood-Net's key answers editors and administrators behind Access, carries only a briefing, and holds the day's ceiling.`);
