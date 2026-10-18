// An administrator's notifications (0066): the Worker's sender
// (worker/push.js) and the service worker's half (sw.js), offline.
//
// What fails in silence here — a phone that is never told, with nothing red
// anywhere — is what this checks:
//
//   * the encryption: RFC 8291's own worked example reproduced byte for byte
//     (its keys, its salt, its 4096-byte record), and a message to a key made
//     here opened again the way a browser opens one;
//   * the signature: a VAPID token for the endpoint's own origin, a day or less,
//     a subject Apple accepts, signed by the key it names — and a pair whose
//     halves do not match refused before anything is signed with it;
//   * the key: made once, kept in the bucket under _meganet/, the same key for
//     the next isolate; the secrets win where they are set;
//   * a run: nothing fetched without the secret or a key; push_due asked with
//     the project's secret and the key the devices subscribed with; each device
//     sent its message with TTL, Urgency and Topic; 201, 410, a 403 with its
//     reason and a dropped connection each reported to push_done as they were;
//     an endpoint at no push service never fetched at all;
//   * that the Worker's and the database's lists of push services are the same
//     list, and that the schedule is declared and runs the sender;
//   * sw.js: a push shown as its title, body and tag, its count put on the icon
//     (or the icon cleared), an address outside the app replaced by the Admin
//     tab, a press bringing an open app forward without reloading it, or
//     opening one.
//
// The push services and the database are stand-ins on fetch; keys are made here.
//
// Run:  npm run push        (node push.mjs; -v lists what passed)

import fs from 'node:fs';
import vm from 'node:vm';
import { repo } from './lib/paths.mjs';
import worker from '../worker/index.js';
import * as api from '../worker/api.js';
import * as P from '../worker/push.js';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) { if (VERBOSE) console.log(`\n${title}`); }

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = s => Buffer.from(String(s).replace(/\s+/g, ''), 'base64url');
const b64s = buf => Buffer.from(buf).toString('base64url');
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function hkdf(salt, ikm, info, n) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}

// What a browser does with a message (RFC 8291 §3.4, from the receiving end).
async function open(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256));
  const keyInfo = Buffer.concat([enc.encode('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, sealed));
  return { rs, idlen, delimiter: plain[plain.length - 1], text: dec.decode(plain.slice(0, -1)) };
}

async function device() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, pub, auth, p256dh: b64s(pub), authB64: b64s(auth) };
}

async function vapidPair() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64s(await subtle.exportKey('raw', pair.publicKey)), privateKey: jwk.d };
}

// A bucket over a Map, as much of R2 as the sender uses.
function bucket() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? { text: async () => m.get(k), arrayBuffer: async () => enc.encode(m.get(k)).buffer } : null; },
    async put(k, v) { m.set(k, typeof v === 'string' ? v : dec.decode(v)); },
  };
}

// ── 1. The encryption, against RFC 8291's example ────────────────────────────

section('RFC 8291 Appendix A');
{
  const asPublic = b64(`BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg
                        Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8`);
  const asPrivate = b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
  const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const authSecret = 'BTBZMqHH6r4Tts7J_aSIgg';
  const salt = b64('DGv6ra1nlYgDCS1FRnbzlw');
  const plaintext = b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24');
  const expected = Buffer.concat([
    b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`),
    b64(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
         bI_0LpXMuGvnzQ`),
  ]);
  const privateKey = await subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: b64s(asPrivate), x: b64s(asPublic.slice(1, 33)), y: b64s(asPublic.slice(33)),
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const got = await P.encryptPayload(new Uint8Array(plaintext), uaPublic, authSecret,
                                     { salt: new Uint8Array(salt), server: { privateKey, publicKey: new Uint8Array(asPublic) } });
  check('the RFC\'s example, byte for byte: its 86-octet header and its ciphertext', eq(got, expected),
        `${got.length} bytes, expected ${expected.length}`);
  check('the plaintext is "When I grow up, I want to be a watermelon"', dec.decode(plaintext).includes('watermelon'));
}

section('A message to a device made here');
{
  const d = await device();
  const text = JSON.stringify({ title: 'An account is waiting for your approval', body: 'Waiting: 1 account waiting for approval.', count: 1 });
  const body = await P.encryptPayload(enc.encode(text), d.p256dh, d.authB64);
  const opened = await open(body, d.privateKey, d.pub, d.auth);
  check('opened again as a browser opens it', opened.text === text, opened.text.slice(0, 80));
  check('one record of 4096, the last (delimiter 2), keyed by a 65-byte point', opened.rs === 4096 && opened.idlen === 65 && opened.delimiter === 2);
  const again = await P.encryptPayload(enc.encode(text), d.p256dh, d.authB64);
  check('a fresh salt and key every message: the same text twice is two different bodies', !eq(body, again));
  let refused = '';
  try { await P.encryptPayload(new Uint8Array(P._test.MAX_PLAINTEXT + 1), d.p256dh, d.authB64); } catch (err) { refused = err.message; }
  check('more than a record holds is refused, not sent cut', /over the/.test(refused), refused);
  try { refused = ''; await P.encryptPayload(enc.encode('x'), d.p256dh, b64s(new Uint8Array(8))); } catch (err) { refused = err.message; }
  check('an auth secret that is not 16 bytes is refused', /16 bytes/.test(refused), refused);
}

// ── 2. The VAPID key and its token ───────────────────────────────────────────

section('VAPID');
{
  const pair = await vapidPair();
  P._test.resetKeys();
  const keys = await P.vapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey });
  check('the secrets\' pair is the key', keys.publicB64 === pair.publicKey);

  const now = Date.UTC(2026, 9, 18, 4, 0, 0);
  const header = await P.vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH4KW6x?token=x', keys, { now });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  check('Authorization: vapid t=<JWT>, k=<public key>', !!m && m[4] === pair.publicKey, header.slice(0, 60));
  if (m) {
    const head = JSON.parse(dec.decode(b64(m[1])));
    const claims = JSON.parse(dec.decode(b64(m[2])));
    check('ES256', head.alg === 'ES256' && head.typ === 'JWT', JSON.stringify(head));
    check('for the push service\'s own origin', claims.aud === 'https://web.push.apple.com', claims.aud);
    check('for a day at most (RFC 8292), and not already over', claims.exp > now / 1000 && claims.exp <= now / 1000 + 86400, String(claims.exp));
    check('with a subject that is a URL (Apple refuses a token without one)', /^https:\/\/|^mailto:/.test(claims.sub), claims.sub);
    const pub = await subtle.importKey('raw', b64(pair.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64(m[3]), enc.encode(`${m[1]}.${m[2]}`));
    check('signed by the key it names', ok);
  }

  const other = await vapidPair();
  P._test.resetKeys();
  let refused = '';
  try { await P.vapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: other.privateKey }); } catch (err) { refused = err.message; }
  check('a public key and a private key that are not one pair are refused', /not the public key/.test(refused), refused);

  P._test.resetKeys();
  const b = bucket();
  const made = await P.vapidKeys({ PHOTOS: b });
  check('no secrets: a key is made and kept in the bucket, under _meganet/',
        b.m.has(P._test.KEY_OBJECT) && P._test.KEY_OBJECT.startsWith('_meganet/') && /^B[\w-]{86}$/.test(made.publicB64));
  P._test.resetKeys();
  const next = await P.vapidKeys({ PHOTOS: b });
  check('…and the next isolate signs with the same one', next.publicB64 === made.publicB64);
  P._test.resetKeys();
  check('no secrets and no bucket: no key', (await P.vapidKeys({})) === null);
}

// ── 3. A run ─────────────────────────────────────────────────────────────────

const SECRET = 'sb_secret_flood-net-test-secret';
const calls = [];
let script = {};
function stand(input, init = {}) {
  const req = new Request(input, init);
  calls.push(req);
  const fn = script[req.url] || script[new URL(req.url).origin];
  if (!fn) throw new TypeError(`fetch to ${req.url}, which no check expects`);
  return fn(req);
}

section('A run');
{
  calls.length = 0;
  P._test.resetKeys();
  let out = await P.runPush({ PHOTOS: bucket() }, { fetchImpl: stand });
  check('without the project\'s secret key, nothing is fetched', out.configured === false && calls.length === 0, JSON.stringify(out));
  out = await P.runPush({ SUPABASE_SECRET_KEY: SECRET }, { fetchImpl: stand });
  check('without a bucket or the VAPID secrets, nothing is fetched', out.configured === false && calls.length === 0, JSON.stringify(out));

  const pair = await vapidPair();
  const env = { SUPABASE_SECRET_KEY: SECRET, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey };
  const phones = { apple: await device(), fcm: await device(), moz: await device(), wns: await device(), elsewhere: await device() };
  const payload = n => ({ title: 'A base station is asking for a token', body: `Waiting: ${n}.`, count: 2, url: './#pair=BCDF-GHJK', tag: 'floodnet-admin' });
  const row = (id, endpoint, d, extra = {}) => ({ id, endpoint, p256dh: d.p256dh, auth: d.authB64,
    through: '2026-10-18T03:59:50.000000+00:00', asked: null, urgency: 'high', ttl: 1800, payload: payload(id), ...extra });
  const due = [
    row(1, 'https://web.push.apple.com/QGuQyavXutnMH4KW6x', phones.apple, { asked: '2026-10-18T03:00:00.123456+00:00' }),
    row(2, 'https://fcm.googleapis.com/fcm/send/abc:def', phones.fcm, { urgency: 'normal', ttl: 43200 }),
    row(3, 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA', phones.moz),
    row(4, 'https://wns2-sy3p.notify.windows.com/w/?token=BQYAAA', phones.wns),
    row(5, 'https://push.example.test/somebody-made-this-up', phones.elsewhere),
  ];
  const sent = {};
  let dueAsk = null, report = null;
  script = {
    [`${api.SUPABASE_REST_URL}/rpc/push_due`]: async req => { dueAsk = { headers: req.headers, body: await req.json() }; return Response.json(due); },
    [`${api.SUPABASE_REST_URL}/rpc/push_done`]: async req => { report = { headers: req.headers, body: await req.json() }; return Response.json({ sent: 1, gone: 1, failed: 2 }); },
    'https://web.push.apple.com': async req => { sent.apple = req; return new Response(null, { status: 201 }); },
    'https://fcm.googleapis.com': async req => { sent.fcm = req; return new Response('', { status: 410 }); },
    'https://updates.push.services.mozilla.com': async req => { sent.moz = req; return Response.json({ reason: 'BadJwtToken' }, { status: 403 }); },
    'https://wns2-sy3p.notify.windows.com': async req => { sent.wns = req; throw new TypeError('connection reset'); },
  };
  calls.length = 0;
  P._test.resetKeys();
  out = await P.runPush(env, { fetchImpl: stand });

  check('push_due asked with the project\'s secret, in the meganet schema',
        dueAsk && dueAsk.headers.get('apikey') === SECRET && dueAsk.headers.get('authorization') === `Bearer ${SECRET}`
          && dueAsk.headers.get('content-profile') === 'meganet');
  check('…and told the key the devices subscribe with', dueAsk && dueAsk.body.p_public_key === pair.publicKey);
  check('an endpoint at no push service is never fetched', !calls.some(r => r.url.includes('push.example.test')));
  check('every other device is sent to, once', ['apple', 'fcm', 'moz', 'wns'].every(k => sent[k])
        && calls.filter(r => !r.url.startsWith(api.SUPABASE_REST_URL)).length === 4);

  const a = sent.apple;
  if (a) {
    check('aes128gcm, an octet stream, POST', a.method === 'POST' && a.headers.get('content-encoding') === 'aes128gcm'
          && a.headers.get('content-type') === 'application/octet-stream');
    check('TTL and Urgency as push_due asked, and a Topic so a waiting message is replaced, not queued',
          a.headers.get('ttl') === '1800' && a.headers.get('urgency') === 'high' && a.headers.get('topic') === 'floodnet-admin'
            && sent.fcm.headers.get('ttl') === '43200' && sent.fcm.headers.get('urgency') === 'normal');
    check('signed for each service\'s own origin', (() => {
      const aud = r => JSON.parse(dec.decode(b64(/t=[\w-]+\.([\w-]+)\./.exec(r.headers.get('authorization'))[1]))).aud;
      return aud(a) === 'https://web.push.apple.com' && aud(sent.fcm) === 'https://fcm.googleapis.com';
    })());
    const opened = await open(new Uint8Array(await a.arrayBuffer()), phones.apple.privateKey, phones.apple.pub, phones.apple.auth);
    check('the iPhone opens the message push_due wrote', opened.text === JSON.stringify(payload(1)), opened.text.slice(0, 80));
  }

  const by = Object.fromEntries((report ? report.body.p_report : []).map(r => [r.id, r]));
  check('push_done hears every device, the made-up endpoint included', report && Object.keys(by).length === 5);
  check('201: delivered, its mark and its test echoed back unchanged',
        by[1] && by[1].status === 201 && by[1].error === null && by[1].through === due[0].through && by[1].asked === due[0].asked);
  check('410: said as such, for the database to delete', by[2] && by[2].status === 410);
  check('403: said with the push service\'s reason', by[3] && by[3].status === 403 && /BadJwtToken/.test(by[3].error), by[3] && by[3].error);
  check('a dropped connection: no status, its error', by[4] && by[4].status === null && /connection reset/.test(by[4].error), by[4] && by[4].error);
  check('the made-up endpoint: refused here, no status', by[5] && by[5].status === null && /push service/.test(by[5].error));
  check('push_done carried the secret too', report && report.headers.get('apikey') === SECRET);
  check('the run says what happened, for the log', out.configured && out.due === 5 && out.sent === 1, JSON.stringify(out));

  script = { [`${api.SUPABASE_REST_URL}/rpc/push_due`]: async () => Response.json([]) };
  calls.length = 0;
  out = await P.runPush(env, { fetchImpl: stand });
  check('nothing due: one question, no report', out.due === 0 && calls.length === 1, JSON.stringify(out));
  script = { [`${api.SUPABASE_REST_URL}/rpc/push_due`]: async () => new Response('{"message":"function meganet.push_due does not exist"}', { status: 404 }) };
  out = await P.runPush(env, { fetchImpl: stand });
  check('a database without 0066: said, nothing sent', /push_due: HTTP 404/.test(out.error || ''), out.error);
}

// ── 4. One list of push services; the schedule ───────────────────────────────

section('The list and the schedule');
{
  const sql = fs.readFileSync(repo('db/migrations/0066_push_notifications.sql'), 'utf8');
  const fromSql = [...sql.matchAll(/endpoint\s+!?~\s+'(\^https:[^']+)'/g)].map(m => m[1]);
  const fromJs = P.PUSH_HOSTS.source.replace(/\\\//g, '/');
  check('the table\'s check, push_subscribe\'s and the sender\'s are one list of push services',
        fromSql.length === 2 && fromSql.every(s => s === fromJs), `${fromSql.join(' | ')} vs ${fromJs}`);
  for (const [url, want] of [['https://web.push.apple.com/x', true], ['https://fcm.googleapis.com/fcm/send/x', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/x', true], ['https://db5p.notify.windows.com/w/?token=x', true],
    ['http://web.push.apple.com/x', false], ['https://web.push.apple.com.example.test/x', false],
    ['https://evil.test/https://web.push.apple.com/', false], ['https://web.push.apple.com/a b', false]]) {
    check(`${want ? 'a push service' : 'not one'}: ${url}`, P.endpointAllowed(url) === want);
  }

  const toml = fs.readFileSync(repo('wrangler.toml'), 'utf8');
  check('wrangler.toml schedules the Worker every minute', /^\[triggers\]\s*\ncrons\s*=\s*\["\* \* \* \* \*"\]/m.test(toml));
  let waited = null;
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await worker.scheduled({ cron: '* * * * *' }, {}, { waitUntil: p => { waited = p; } });
    await waited;
  } finally { console.log = log; }
  check('scheduled() runs the sender, and a run with nothing to do says nothing', waited instanceof Promise && logs.length === 0, logs.join('; '));
}

// ── 5. sw.js ─────────────────────────────────────────────────────────────────

section('sw.js');
{
  const SCOPE = 'https://floodwarning.net/';
  const handlers = {};
  const shown = [], badges = [], posted = [], opened = [];
  let windows = [];
  const self = {
    location: { href: `${SCOPE}sw.js?v=test` },
    registration: { scope: SCOPE, showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    navigator: { setAppBadge: async n => { badges.push(n); }, clearAppBadge: async () => { badges.push(0); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async url => { opened.push(url); },
      claim: async () => {},
    },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
  };
  const ctx = vm.createContext({ self, URL, Promise, Response, Headers, Request, caches: {}, fetch: () => { throw new Error('no fetch'); },
                                 setTimeout, console });
  vm.runInContext(fs.readFileSync(repo('sw.js'), 'utf8'), ctx, { filename: 'sw.js' });

  async function push(data) {
    let wait = null;
    handlers.push({ data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
                    waitUntil: p => { wait = p; } });
    await wait;
  }
  check('sw.js listens for push and for a press', typeof handlers.push === 'function' && typeof handlers.notificationclick === 'function');

  await push({ title: 'An account is waiting for your approval', body: 'Waiting: 1 account.', count: 3, url: './?tab=admin', tag: 'floodnet-admin' });
  let s = shown.at(-1);
  check('shown with its title, body and tag, the newest replacing the last',
        s && s.title === 'An account is waiting for your approval' && s.opts.body === 'Waiting: 1 account.'
          && s.opts.tag === 'floodnet-admin' && s.opts.renotify === true, JSON.stringify(s));
  check('…its address resolved in the app', s && s.opts.data.url === `${SCOPE}?tab=admin`, s && s.opts.data.url);
  check('…and its count on the icon', badges.at(-1) === 3);
  await push({ title: 'Flood-Net notifications are on', count: 0 });
  check('a count of nothing clears the icon', badges.at(-1) === 0);
  await push({ title: 'x', url: 'https://evil.test/phish' });
  check('an address outside the app is the Admin tab instead', shown.at(-1).opts.data.url === `${SCOPE}?tab=admin`);
  const before = badges.length;
  await push({ title: 'x', count: 'many' });
  check('a count that is not a number leaves the icon alone', badges.length === before);
  await push(undefined);
  check('a push with nothing in it is still shown, as Flood-Net', shown.at(-1).title === 'Flood-Net');
  await push('not json');
  check('…and so is one that is not JSON', shown.at(-1).title === 'Flood-Net');

  async function press(url) {
    let wait = null, closed = false;
    handlers.notificationclick({ notification: { data: { url }, close: () => { closed = true; } }, waitUntil: p => { wait = p; } });
    await wait;
    return closed;
  }
  let focused = 0;
  windows = [{ url: `${SCOPE}?tab=stations`, postMessage: m => posted.push(m), focus: async () => { focused++; } }];
  const closed = await press(`${SCOPE}#pair=BCDF-GHJK`);
  check('pressed with the app open: closed, brought forward, told where to go — not reloaded',
        closed && focused === 1 && posted.at(-1).type === 'floodnet-open' && posted.at(-1).url === `${SCOPE}#pair=BCDF-GHJK` && !opened.length,
        JSON.stringify(posted.at(-1)));
  windows = [];
  await press(`${SCOPE}?tab=admin`);
  check('pressed with none open: opens the app there', opened.at(-1) === `${SCOPE}?tab=admin`);
}

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log('');
const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} check(s) failed.\n`);
  console.log('  A check that fails here is an administrator\'s phone that is never told, or is');
  console.log('  told something it cannot open — and nothing anywhere else turns red for it.\n');
  process.exit(1);
}
console.log(`PASS — ${results.length} checks: messages encrypted as RFC 8291's example, signed for each push service, sent and reported; sw.js shows them and counts them on the icon.`);
