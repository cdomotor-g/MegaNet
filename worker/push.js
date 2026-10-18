// The sender of 0066's notifications — no route, a schedule.
//
// An administrator turns notifications on for a device on the Admin tab
// (push.js in the app), which keeps the device's Web Push subscription in
// meganet.push_subscription. Every minute (wrangler.toml's [triggers]) this
// file asks the database which devices have something to hear —
// meganet.push_due(), with the project's secret key — and sends each its
// message: encrypted to the device (RFC 8291, aes128gcm), signed for the push
// service with Flood-Net's VAPID key (RFC 8292), posted to the device's
// endpoint at Apple's, Google's, Mozilla's or Microsoft's push service. What
// each said goes back to meganet.push_done(), which the panel reads.
//
// The database decides who hears what and what it says; this file only
// carries it. Nothing here reads a request: there is no URL that reaches it.
//
// ── The VAPID key ────────────────────────────────────────────────────────────
//
// A P-256 key pair the push services know this sender by: the public half is
// what a device subscribes with, so a message signed by anybody else's is
// refused. Like the photo route's URL-signing key (photos.js), it is made the
// first time it is needed and kept in the R2 bucket under _meganet/, a prefix
// no photo path can reach — so there is nothing for anybody to set, rotate or
// leak into a repo. VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, as secrets in the
// web-push library's base64url form, take its place where they are set (a key
// carried over from another sender). The key is told to the database on every
// run (push_due's argument), which is where the page reads it.
//
// Without SUPABASE_SECRET_KEY, or without both the bucket and the two secrets,
// a run returns before it fetches anything.
//
// ── What a message is ────────────────────────────────────────────────────────
//
// The payload push_due() wrote — {title, body, count, url, tag} — as JSON,
// which sw.js shows as the notification and whose count it puts on the icon.
// One record (Apple takes 4 KB at most), with TTL and Urgency as push_due()
// asked and a Topic, so a message still waiting on a phone that is off is
// replaced by the next rather than queued behind it.
//
// Exports for test/push.mjs: runPush, encryptPayload, vapidAuthorization,
// vapidKeys, endpointAllowed, PUSH_HOSTS.

import { SUPABASE_REST_URL } from './api.js';

// The four push services a browser subscribes with — the same list 0066's
// check holds the table to. Anything else is a URL somebody made up.
export const PUSH_HOSTS = /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\/[!-~]+$/;

const KEY_OBJECT = '_meganet/vapid-key';
// RFC 8292's sub: how a push service reaches whoever runs the sender. Apple
// refuses a token without one, and one that is not a URL or mailto:.
const SUBJECT = 'https://floodwarning.net/';
// RFC 8292 allows a day; half of one, renewed per run, is plenty.
const JWT_LIFE_S = 12 * 3600;
const RECORD_SIZE = 4096;
// A record's 4096 bytes less the header (86), the tag (16) and the delimiter.
const MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1;
const SEND_WIDTH = 6;
const SEND_TIMEOUT_MS = 10000;

let keyCache = null;   // { source, publicKey, publicB64, privateKey } per isolate

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function endpointAllowed(endpoint) {
  return typeof endpoint === 'string' && endpoint.length <= 1024 && PUSH_HOSTS.test(endpoint);
}

// ── Keys ─────────────────────────────────────────────────────────────────────

// The ECDSA signing key for a public point and private scalar, both base64url
// (the web-push library's form): {publicKey, publicB64, privateKey}.
async function importVapid(publicB64, privateB64) {
  const pub = fromB64url(publicB64);
  const d = fromB64url(privateB64);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) {
    throw new Error('a VAPID key is a 65-byte uncompressed P-256 point and a 32-byte private key, base64url');
  }
  const mismatch = 'the VAPID private key is not the public key\'s';
  // Some runtimes refuse a JWK whose halves disagree as it is imported; the
  // rest are caught by the signature below. Either way, said the same.
  let privateKey, verifier;
  try {
    privateKey = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true,
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    verifier = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch (err) {
    throw new Error(`${mismatch}, or not a P-256 key (${err.message})`);
  }
  // A private key that is not the public key's would sign tokens every push
  // service refuses (403) with nothing here to say why: proved once, here.
  const probe = enc.encode('floodnet-vapid-probe');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, probe);
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, sig, probe))) throw new Error(mismatch);
  return { publicKey: pub, publicB64: b64url(pub), privateKey };
}

async function makeVapid() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64url(pub), privateKey: jwk.d };
}

// The secrets where both are set; else the bucket's pair, made and put there
// the first time. Two isolates racing on that first run each put one and then
// read back whichever landed last, so both sign with the same key after.
export async function vapidKeys(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    const source = `env:${env.VAPID_PUBLIC_KEY}`;
    if (keyCache && keyCache.source === source) return keyCache;
    keyCache = { source, ...(await importVapid(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)) };
    return keyCache;
  }
  if (!env.PHOTOS) return null;
  if (keyCache && keyCache.source === 'r2') return keyCache;
  let obj = await env.PHOTOS.get(KEY_OBJECT);
  if (!obj) {
    await env.PHOTOS.put(KEY_OBJECT, JSON.stringify(await makeVapid()),
                         { httpMetadata: { contentType: 'application/json' } });
    obj = await env.PHOTOS.get(KEY_OBJECT);
  }
  const kept = JSON.parse(await obj.text());
  keyCache = { source: 'r2', ...(await importVapid(kept.publicKey, kept.privateKey)) };
  return keyCache;
}

// `vapid t=<JWT>, k=<public key>` for one push service (RFC 8292 §3). The
// audience is the endpoint's origin, which is what the push service checks.
export async function vapidAuthorization(endpoint, keys, { now = Date.now(), subject = SUBJECT } = {}) {
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_LIFE_S, sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${keys.publicB64}`;
}

// ── The message ──────────────────────────────────────────────────────────────

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// RFC 8291 §3.4: the plaintext encrypted to one device, as the single
// aes128gcm record (RFC 8188) its push service carries. `salt` and `server`
// (an ECDH key pair, {publicKey: raw bytes, privateKey}) are fresh for every
// message; the test passes the RFC's own to reproduce its example byte for byte.
export async function encryptPayload(plaintext, p256dhB64, authB64, { salt, server } = {}) {
  const uaPublic = fromB64url(p256dhB64);
  const authSecret = fromB64url(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('the device key is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('the device auth secret is not 16 bytes');
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`the message is ${plaintext.length} bytes, over the ${MAX_PLAINTEXT} a record holds`);

  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  if (!server) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    server = { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, server.publicKey);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record, so its padding delimiter is 2 (the last record's) and no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 },
                                                            aes, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, new Uint8Array([server.publicKey.length]), server.publicKey, sealed);
}

// The payload as bytes, its body cut to fit a record if it ever would not.
function payloadBytes(payload) {
  let bytes = enc.encode(JSON.stringify(payload));
  if (bytes.length <= MAX_PLAINTEXT) return bytes;
  const p = { ...payload, body: String(payload.body || '').slice(0, 1000) + '…' };
  return enc.encode(JSON.stringify(p));
}

// One device: {id, status, through, asked, error}. Every failure is an answer
// for push_done to keep, never a throw that would lose the others'.
async function sendOne(row, keys, fetchImpl, now) {
  const out = { id: row.id, status: null, through: row.through, asked: row.asked ?? null, error: null };
  if (!endpointAllowed(row.endpoint)) { out.error = 'not an endpoint at a push service Flood-Net sends to'; return out; }
  try {
    const body = await encryptPayload(payloadBytes(row.payload || {}), row.p256dh, row.auth);
    const ttl = Number.isInteger(row.ttl) && row.ttl >= 0 ? row.ttl : 43200;
    const urgency = ['very-low', 'low', 'normal', 'high'].includes(row.urgency) ? row.urgency : 'normal';
    const init = {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(row.endpoint, keys, { now }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
        Topic: 'floodnet-admin',
      },
      body,
      redirect: 'manual',
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    const res = await fetchImpl(row.endpoint, init);
    out.status = res.status;
    if (!res.ok) {
      let text = '';
      try { text = (await res.text()).replace(/\s+/g, ' ').trim(); } catch (_) { /* no body */ }
      out.error = `HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`;
    }
  } catch (err) {
    out.status = null;
    out.error = String((err && err.message) || err).slice(0, 200);
  }
  return out;
}

async function rpc(fn, args, secret, fetchImpl) {
  const res = await fetchImpl(`${SUPABASE_REST_URL}/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: secret, Authorization: `Bearer ${secret}`,
      'Content-Profile': 'meganet', 'Accept-Profile': 'meganet',
      'Content-Type': 'application/json', Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// One run: ask, send, report. Answers what happened, for the log.
export async function runPush(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env || !env.SUPABASE_SECRET_KEY) return { configured: false, reason: 'no SUPABASE_SECRET_KEY' };
  let keys;
  try {
    keys = await vapidKeys(env);
  } catch (err) {
    return { configured: false, reason: `VAPID key: ${err.message}` };
  }
  if (!keys) return { configured: false, reason: 'no VAPID key: neither the PHOTOS bucket nor VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY' };

  let due;
  try {
    due = await rpc('push_due', { p_public_key: keys.publicB64 }, env.SUPABASE_SECRET_KEY, fetchImpl);
  } catch (err) {
    return { configured: true, error: err.message };
  }
  if (!Array.isArray(due) || !due.length) return { configured: true, due: 0 };

  const report = new Array(due.length);
  let next = 0;
  const lane = async () => {
    while (next < due.length) {
      const i = next++;
      report[i] = await sendOne(due[i], keys, fetchImpl, now);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_WIDTH, due.length) }, lane));

  let done = null;
  try {
    done = await rpc('push_done', { p_report: report }, env.SUPABASE_SECRET_KEY, fetchImpl);
  } catch (err) {
    return { configured: true, due: due.length, error: err.message };
  }
  return { configured: true, due: due.length, ...(done || {}) };
}

export const _test = { resetKeys: () => { keyCache = null; }, fromB64url, b64url, KEY_OBJECT, MAX_PLAINTEXT };
