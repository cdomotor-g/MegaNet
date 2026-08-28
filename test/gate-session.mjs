// The gate's own door check (#173).
//
// worker/index.js turns a Cloudflare Access token into a Supabase session, which
// makes `verifyAccessJwt()` the only thing standing between the front gate and a
// token that can write to the database. Everything it is supposed to refuse
// fails *silently* if it is wrong: a forged signature, a token minted for a
// different Access application on the same team, an expired one, `alg: none`.
// None of those is visible from the outside — the app would sign in and work,
// which is precisely the problem. So each refusal is asserted here.
//
// The keys are generated in-process, so this runs offline and never needs the
// real team's key set: the question is whether the verifier checks, not whether
// Cloudflare's keys are what they say they are.
//
// Run:  npm run gate

import crypto from 'node:crypto';
import { verifyAccessJwt } from '../worker/index.js';

const AUD    = 'aud-tag-for-this-application';
const ISSUER = 'https://example.cloudflareaccess.com';
const KID    = 'test-key-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KEYS = [{ kid: KID, kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }];

const b64url = buf => Buffer.from(buf).toString('base64url');

// Mint an Access-shaped token. Every case below is this, with one thing wrong.
function mint({ header = {}, claims = {}, signWith = privateKey, tamper = false } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT', ...header }));
  const now = Math.floor(Date.now() / 1000);
  const c = b64url(JSON.stringify({
    aud: [AUD], iss: ISSUER, email: 'someone@bom.gov.au',
    iat: now, exp: now + 3600, ...claims,
  }));
  if (header.alg === 'none') return `${h}.${c}.`;
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${c}`),
                          { key: signWith, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${h}.${c}.${tamper ? b64url(Buffer.alloc(sig.length, 1)) : b64url(sig)}`;
}

const opts = { keys: KEYS, aud: AUD, issuer: ISSUER };
const results = [];

async function refuses(what, token, extra = {}) {
  try {
    await verifyAccessJwt(token, { ...opts, ...extra });
    results.push({ ok: false, what, detail: 'ACCEPTED IT' });
  } catch (err) {
    results.push({ ok: true, what, detail: err.message });
  }
}

async function accepts(what, token, extra = {}) {
  try {
    const claims = await verifyAccessJwt(token, { ...opts, ...extra });
    results.push({ ok: claims.email === 'someone@bom.gov.au', what,
                   detail: `email ${claims.email}` });
  } catch (err) {
    results.push({ ok: false, what, detail: `REFUSED IT: ${err.message}` });
  }
}

// The one that must work, first — a check that refuses everything is not a check.
await accepts('a genuine token from the team, for this application', mint());

// `alg: none` says "trust me, no signature". The algorithm is chosen by whoever
// wrote the token, so this is the classic way in.
await refuses('alg: none', mint({ header: { alg: 'none' } }));
await refuses('alg swapped to HS256', mint({ header: { alg: 'HS256' } }));

// A signature that does not check out, and a signature by the wrong key —
// the difference between a token edited in transit and one minted elsewhere.
await refuses('a tampered signature', mint({ tamper: true }));
await refuses('signed by a key that is not the team\'s',
              mint({ signWith: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }));
await refuses('a kid naming a key that is not in the set',
              mint({ header: { kid: 'some-other-key' } }));

// Access issues a token per application. Without the aud check, a token for any
// other application on the same team would open this one.
await refuses('a token for another Access application',
              mint({ claims: { aud: ['a-different-application'] } }));
await refuses('a token for another team', mint({ claims: { iss: 'https://elsewhere.cloudflareaccess.com' } }));

// Expiry, and the clock allowance in both directions.
await refuses('an expired token',
              mint({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }));
await refuses('a token that is not valid yet',
              mint({ claims: { nbf: Math.floor(Date.now() / 1000) + 3600 } }));

// Shapes that are not tokens at all — the paths before any crypto runs.
await refuses('an empty string', '');
await refuses('something that is not a JWT', 'not-a-token');
await refuses('a token with no email claim', mint({ claims: { email: undefined } }));

// The verifier must not be talked out of checking by an absent expectation.
await refuses('a genuine token when no AUD is configured', mint(), { aud: undefined });

console.log('');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.what} — ${r.detail}`);
console.log('');

const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} case(s) went the wrong way.\n`);
  console.log('  Every one of these is a way past the front gate into the database,\n'
            + '  and none of them is visible from outside once deployed.\n');
  process.exit(1);
}
console.log(`PASS — the Access verifier accepts the genuine token and refuses the other ${results.length - 1}.`);
