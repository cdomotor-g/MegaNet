// The gate signs you into the database too.
//
// MegaNet asked for two identities: Cloudflare Access at the front door, then a
// Supabase email-and-code panel before anything could be edited. They admit the
// same people — `meganet.editor_allow` is `@bom.gov.au` plus the owner, which is
// the Access policy written a second time — so the second ask was friction, not
// security. This route removes the *asking* without touching the *checking*.
//
// Why the checking has to stay: Access protects `floodwarning.net`, not
// `<project>.supabase.co`, and the anon key is committed to a public repo.
// Nothing here loosens a policy. `meganet.is_editor()` still decides every
// write from the token's own claims, and `meganet.actor()` still records which
// person made it — so a save is attributed to the operator, never to this
// Worker. What changes is only where the token comes from: Access already
// proved who this is, so the app stops making them prove it again.
//
// The safety property is structural rather than configured: a session is minted
// only for a request carrying an Access token this file has verified against the
// team's own public keys. An origin Access does not cover — `workers.dev`,
// github.io, a local file — carries no such token, gets 401, and falls back to
// the email-and-code flow that is still there. Turning the gate off does not
// quietly turn this into an open door; it turns it off.
//
// See docs/access.md ("Between the layers") and issue #173.

// Already public in core.js — the project ref is in the committed client config,
// so keeping it here costs nothing and saves a binding the operator would have
// to set. The *secret* key is a binding, and never leaves this file's scope.
const SUPABASE_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co';

// Access rotates its signing keys, so the key set is fetched rather than pinned
// — but not per request. A minted session lasts an hour; refetching the set
// every few minutes is already far more often than the keys move.
const JWKS_TTL_MS = 5 * 60 * 1000;

// Clocks disagree. A minute either way is the same allowance auth.js makes for
// its own token expiry, and is small enough that an expired token stays expired.
const CLOCK_SKEW_S = 60;

let jwksCache = null;    // { url, at, keys }

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function fetchJwks(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`Access key set: HTTP ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  if (!keys.length) throw new Error('Access key set held no keys');
  jwksCache = { url, at: Date.now(), keys };
  return keys;
}

// Verify an Access token and return its claims, or throw with a reason.
//
// Exported so `test/gate-session.mjs` can hand it a key set it generated and
// assert the refusals — a signature that does not check out, a token minted for
// a different Access application, an expired one, and `alg: none`. Every one of
// those is a way in if this function is wrong, and none of them is visible from
// the outside once it is deployed.
export async function verifyAccessJwt(token, { keys, aud, issuer, now = Date.now() }) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error('not a JWT');
  }
  const [rawHeader, rawPayload, rawSig] = token.split('.');
  const header = b64urlToJson(rawHeader);

  // `none` is the classic way in, and an attacker picks the algorithm — so this
  // is an allow-list of one rather than a check for the bad case.
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('no Access key matches this token');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(rawSig), signed);
  if (!ok) throw new Error('signature does not check out');

  const claims = b64urlToJson(rawPayload);
  const nowS = Math.floor(now / 1000);

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) {
    throw new Error('token has expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) {
    throw new Error('token is not valid yet');
  }
  // Without this an Access token for *any* application on the same team would
  // open this one. The AUD tag is what makes it this application's token.
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud || !auds.includes(aud)) throw new Error('token is for another application');

  if (issuer && claims.iss !== issuer) throw new Error('token is from another team');
  if (!claims.email) throw new Error('token carries no email');

  return claims;
}

function accessTokenFrom(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  // The header is what Access sends to an origin; the cookie is what it leaves
  // in the browser. Reading both means this still works if the request reaches
  // the Worker by a route that only carries one of them.
  const cookie = request.headers.get('Cookie') || '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1] : null;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // A minted session is per person. A cache anywhere between here and the
      // browser holding one would hand it to the next caller.
      'Cache-Control': 'no-store',
    },
  });
}

async function supabase(path, secret, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  return { ok: res.ok, status: res.status, body: parsed, text };
}

// The exchange: a verified address in, a real GoTrue session out.
//
// Two calls rather than one because GoTrue has no "mint a session for this
// address" admin endpoint. `generate_link` produces the same one-time token the
// email would have carried, and `verify` redeems it here instead of in a
// mailbox. The result is an ordinary session — ordinary refresh token included,
// which is why auth.js needs no new expiry handling.
//
// Deliberately *not* a service-role token handed to the browser: that would
// bypass every RLS policy in the database. This mints a token for the person,
// so `is_editor()` and `actor()` still see the person.
async function mintSession(email, secret) {
  const link = await supabase('admin/generate_link', secret,
                              { type: 'magiclink', email });

  if (!link.ok) {
    const msg = (link.body && (link.body.msg || link.body.message || link.body.error_description))
      || link.text || `HTTP ${link.status}`;
    // meganet.auth_user_gate() refuses to create a user for an address that is
    // not on editor_allow — see 0005_auth.sql. That is the gate admitting
    // somebody the editors list does not, which is a real answer rather than a
    // fault: the app should load read-only, not show an error.
    if (/editor_allow|not authoris|not authoriz|Database error/i.test(msg)) {
      const err = new Error('not on the editors list');
      err.readOnly = true;
      throw err;
    }
    throw new Error(`generate_link: ${msg}`);
  }

  const hashed = link.body && link.body.properties && link.body.properties.hashed_token;
  if (!hashed) throw new Error('generate_link returned no token');

  const session = await supabase('verify', secret,
                                 { type: 'magiclink', token: hashed });
  if (!session.ok || !session.body || !session.body.access_token) {
    const msg = (session.body && (session.body.msg || session.body.message))
      || session.text || `HTTP ${session.status}`;
    throw new Error(`verify: ${msg}`);
  }
  return session.body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Everything else is a static asset, and assets are served before this runs.
    // A request that gets here for any other path is a path that does not exist.
    if (url.pathname !== '/api/session') {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    // Named individually so a half-configured Worker says which one is missing
    // rather than failing as if the gate itself were broken.
    for (const name of ['SUPABASE_SECRET_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']) {
      if (!env[name]) {
        return json({ error: `Worker secret ${name} is not set — see docs/access.md` }, 503);
      }
    }

    const token = accessTokenFrom(request);
    if (!token) {
      // The ordinary answer for an origin Access does not cover. The app reads
      // this as "no gate here" and falls back to the email-and-code panel.
      return json({ error: 'no Cloudflare Access identity on this request' }, 401);
    }

    let claims;
    try {
      const keys = await fetchJwks(env.ACCESS_TEAM_DOMAIN);
      claims = await verifyAccessJwt(token, {
        keys,
        aud: env.ACCESS_AUD,
        issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      });
    } catch (err) {
      return json({ error: `Access identity refused: ${err.message}` }, 401);
    }

    try {
      const session = await mintSession(claims.email, env.SUPABASE_SECRET_KEY);
      return json({
        access_token:  session.access_token,
        refresh_token: session.refresh_token,
        expires_in:    session.expires_in,
        email:         (session.user && session.user.email) || claims.email,
      }, 200);
    } catch (err) {
      if (err.readOnly) {
        return json({ error: `${claims.email} is not on the editors list`, read_only: true }, 403);
      }
      return json({ error: `could not mint a session: ${err.message}` }, 502);
    }
  },
};
