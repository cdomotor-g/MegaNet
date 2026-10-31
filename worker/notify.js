// /api/notify/* — the API notify list: an email when the agent API changes.
//
// The owner: "if we're fiddling with the API from time to time downstream users
// may be affected so maybe we need to create some sort of notify list … if we
// do anything to the API we shoot out a message to them to let them know".
//
// What changed is data: docs/api-changelog.json (worker/changelog.js), one entry
// per change somebody using the API would notice, added in the push that makes
// the change (CLAUDE.md). This file keeps the people, and tells each of them
// about each new entry once. It is not part of the read-only agent API
// (worker/api.js), which writes nothing; it shares that module's constants only.
//
//   GET     /api/notify                     {accepting, mail, latest, …} — what the form says
//   POST    /api/notify/subscribe           {email, name?, organisation?} → 202 {ok, mail, message}
//   OPTIONS /api/notify[/subscribe]         the github.io copy's preflight
//   GET     /api/notify/confirm?token=      a page with one button: Confirm
//   POST    /api/notify/confirm             that button → a page saying so
//   GET     /api/notify/unsubscribe?token=  a page with one button: Stop these emails
//   POST    /api/notify/unsubscribe         that button, or a mail client's one-click
//                                           (RFC 8058) → the address deleted
//
// and runNotify(), from worker/index.js's scheduled(): every LIMITS.everyMinutes
// minutes, the confirmations waiting to go and the notices due.
//
// ── Double opt-in ────────────────────────────────────────────────────────────
// A sign-up is kept as pending and sent a link; only whoever reads that mailbox
// can confirm it, so an address somebody else typed in gets one email and
// nothing after. The link opens a page with a button, and only the button's
// POST confirms: a mail scanner that opens every link — the Bureau's does
// (roadmap revision 150) — confirms nobody and unsubscribes nobody. A mail
// client's own unsubscribe (List-Unsubscribe-Post, RFC 8058) is a POST, so
// stays one click. Each person's two tokens are 32 random bytes, kept only in
// the list. The answer to a sign-up is the same whether the address was on the
// list already or not, so the form cannot be used to find out who is.
//
// ── Before mail is switched on ───────────────────────────────────────────────
// Email goes through Resend, from the bug reporter's sender (worker/report.js),
// once #237's Parts 2–3 verify floodwarning.net and set RESEND_API_KEY. Until
// then a sign-up is kept, pending, and nothing is sent; the first run after the
// key exists sends every confirmation waiting. GET /api/notify says which, and
// the form says it in words.
//
// ── Where the list lives ─────────────────────────────────────────────────────
// One JSON object in the PHOTOS R2 bucket, LIST_KEY, under _meganet/ — the
// prefix the URL-signing key (worker/photos.js) and the VAPID key
// (worker/push.js) are kept under, which no photo path can reach: the photo
// route serves only field-photos/photo/<uuid>.<ext>. Never in the repository,
// and never in a log — what is logged is counts. Each write is conditional on
// the etag it read (R2's onlyIf), so two at once cannot lose either.
//
// ── Brakes ───────────────────────────────────────────────────────────────────
// Sign-ups: Flood-Net's own pages only (this origin and the github.io copy),
// JSON only, NOTIFY_RATE a minute per address, LIMITS.daySignups a UTC day and
// LIMITS.subscribers in all. Sending: LIMITS.perRun a run and LIMITS.dayEmails
// a UTC day, counted before sending, paced under Resend's two requests a second
// — so a run of new entries goes out over a few runs rather than at once.
// Resend's free plan is 100 emails a day, shared with the account mail.

import { MAIL_FROM, OTHER_ORIGINS } from './report.js';
import { PUBLIC_ORIGIN, DOCS_URL } from './api.js';
import { readChangelog, entriesAfter } from './changelog.js';

const PREFIX = '/api/notify';
export const LIST_KEY = '_meganet/api-notify/subscribers.json';
const RESEND_URL = 'https://api.resend.com/emails';
export const SIGN_UP_URL = `${PUBLIC_ORIGIN}/api#notify`;
export const CHANGELOG_URL = `${PUBLIC_ORIGIN}/api/v1/changelog`;

export const NOTIFY_RATE = Object.freeze({ binding: 'NOTIFY_RATE_LIMIT', limit: 3, period: 60 });
export const LIMITS = Object.freeze({
  daySignups: 30,              // new addresses a UTC day
  subscribers: 1000,           // on the list in all, pending and confirmed
  perRun: 10,                  // emails a run of runNotify
  dayEmails: 60,               // emails a UTC day, confirmations and notices
  confirmDays: 14,             // a confirmation link works this long after it is sent
  unsentDays: 365,             // a sign-up never sent a link (mail off) is kept this long
  resendConfirmMs: 3600000,    // signing up again while pending sends the link again after this
  attempts: 3,                 // failed sends to one address before it is given up
  entriesPerNotice: 5,         // the newest few, when several are due at once
  requestBytes: 4096,
  email: 254,
  text: 100,                   // a name or an organisation
  everyMinutes: 15,            // runNotify runs on the minutes where minute % 15 === offsetMinute
  offsetMinute: 4,
  leaseMs: 5 * 60000,          // a run holds the list this long at most
  paceMs: 600,                 // between two sends: Resend allows two a second
});
const TIMEOUT_MS = 10000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

export function isNotifyPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// ── Small helpers ────────────────────────────────────────────────────────────

const iso = t => new Date(t).toISOString();
const dayOf = t => iso(t).slice(0, 10);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const token = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// A name or an organisation: one line, no control characters, LIMITS.text long.
function cleanText(v) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.text);
  return s || null;
}

export function validEmail(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length <= LIMITS.email && EMAIL_RE.test(s) ? s : null;
}

// a•••@example.com — enough for its owner to recognise, on a page anyone
// holding the link could open.
function masked(email) {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}•••${email.slice(at)}` : '•••';
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function longDate(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// ── The list ─────────────────────────────────────────────────────────────────

function emptyList() {
  return { version: 1, day: null, last_sent: null, lease_until: null, subscribers: [] };
}

async function load(bucket) {
  const obj = await bucket.get(LIST_KEY);
  if (!obj) return { list: emptyList(), etag: null };
  let list;
  try { list = JSON.parse(await obj.text()); } catch (_) { throw new Error('the list could not be read'); }
  if (!list || !Array.isArray(list.subscribers)) throw new Error('the list is not in the shape this file writes');
  return { list, etag: obj.etag || null };
}

// Read, change, write — the write only if the list is still the one read, else
// read again and change that: fn sees the list as it is and returns {write,
// result}. Never sends anything itself, so running it twice is harmless.
async function mutate(bucket, fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const { list, etag } = await load(bucket);
    const out = await fn(list) || {};
    if (out.write === false) return out.result;
    const onlyIf = etag ? { etagMatches: etag } : new Headers({ 'If-None-Match': '*' });
    const put = await bucket.put(LIST_KEY, JSON.stringify(list), { httpMetadata: { contentType: 'application/json' }, onlyIf });
    if (put !== null) return out.result;
  }
  throw new Error('the list kept changing under this write');
}

function rollDay(list, now) {
  if (!list.day || list.day.date !== dayOf(now)) list.day = { date: dayOf(now), signups: 0, emails: 0 };
  return list.day;
}

// Pending sign-ups past their time: a link sent LIMITS.confirmDays ago and not
// pressed, one never sent for LIMITS.unsentDays, one Resend refused
// LIMITS.attempts times. Returns how many went.
function purge(list, now) {
  const before = list.subscribers.length;
  list.subscribers = list.subscribers.filter(s => s.status !== 'pending' || !(
    (s.confirm_sent_at && now - Date.parse(s.confirm_sent_at) > LIMITS.confirmDays * 86400000)
    || (!s.confirm_sent_at && now - Date.parse(s.created_at) > LIMITS.unsentDays * 86400000)
    || (s.confirm_attempts || 0) >= LIMITS.attempts));
  return before - list.subscribers.length;
}

const linkExpired = (s, now) => !s.confirm_sent_at || now - Date.parse(s.confirm_sent_at) > LIMITS.confirmDays * 86400000;

// ── Mail ─────────────────────────────────────────────────────────────────────

const confirmUrl = s => `${PUBLIC_ORIGIN}${PREFIX}/confirm?token=${s.confirm_token}`;
const unsubscribeUrl = s => `${PUBLIC_ORIGIN}${PREFIX}/unsubscribe?token=${s.unsubscribe_token}`;
const hello = s => (s.name ? `Hello ${s.name},\n\n` : '');
const FOOT = `— Flood-Net, ${PUBLIC_ORIGIN}/api\nFlood-Net is not a flood warning service. For warnings, go to the Bureau of Meteorology: http://www.bom.gov.au/australia/flood/`;

export function confirmationMail(s, entries) {
  const recent = (entries || []).slice(0, 3);
  return {
    to: s.email,
    subject: 'Confirm: email when Flood-Net\'s API changes',
    text: `${hello(s)}Somebody — we hope you — asked for an email at this address whenever Flood-Net's station API changes (${PUBLIC_ORIGIN}/api).\n\n`
      + `To start getting them, open this link and press Confirm:\n${confirmUrl(s)}\n\n`
      + `The link works for ${LIMITS.confirmDays} days. If this was not you, ignore this email: nothing more will be sent, `
      + `and the address is deleted when the link expires. To delete it now: ${unsubscribeUrl(s)}\n\n`
      + (recent.length ? `The latest changes:\n${recent.map(e => `- ${longDate(e.date)}: ${e.title}${e.breaking ? ' (breaking)' : ''}`).join('\n')}\n\n` : '')
      + `Every change: ${CHANGELOG_URL}\n\n${FOOT}\n`,
  };
}

export function noticeMail(s, due) {
  const breaking = due.some(e => e.breaking);
  const subject = `${breaking ? '[Breaking] ' : ''}Flood-Net API: ${due.length === 1 ? due[0].title : `${due.length} changes`}`;
  const body = due.map(e => `${longDate(e.date)} — ${e.title}${e.breaking ? '\nBREAKING: a client that relied on what was there before may need to change.' : ''}\n\n`
    + `${e.summary}\n${e.links.map(l => `\n${l.text}: ${l.url}`).join('')}`).join('\n\n---\n\n');
  return {
    to: s.email,
    subject: subject.length > 150 ? `${subject.slice(0, 149)}…` : subject,
    text: `${hello(s)}Flood-Net's station API has changed.\n\n${body}\n\n`
      + `Every change: ${CHANGELOG_URL}\nThe full reference: ${DOCS_URL}\n\n`
      + `You are getting this because you asked for an email when Flood-Net's API changes. To stop them: ${unsubscribeUrl(s)}\n\n${FOOT}\n`,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(s)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

// {ok, error}. The error says what Resend answered and nothing of the address,
// because it is kept in the list and may be logged as a count's reason.
async function sendMail(env, mail, d) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await d.fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.headers ? { headers: mail.headers } : {}) }),
      signal: ctl.signal,
    });
    try { await res.body?.cancel(); } catch (_) { /* nothing to let go */ }
    return res.ok ? { ok: true } : { ok: false, error: `Resend answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? `Resend did not answer within ${TIMEOUT_MS / 1000} s` : 'Resend could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

// ── The route ────────────────────────────────────────────────────────────────

function allowedOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return origin && (origin === url.origin || OTHER_ORIGINS.includes(origin)) ? origin : null;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers },
  });
}

const PAGE_STYLE = ':root{color-scheme:light dark}body{margin:0;padding:2rem 1rem;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
  + 'color:#16202a;background:#fff}main{max-width:36rem;margin:0 auto}a{color:#0b5cab}h1{font-size:1.5rem;line-height:1.3}'
  + '.crumb{color:#5a6772;font-size:.9rem}button{font:inherit;font-weight:600;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #0b5cab;'
  + 'background:#0b5cab;color:#fff;cursor:pointer}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1319}a{color:#6fb4ff}'
  + '.crumb{color:#9bacba}button{background:#1f6fd1;border-color:#4a9eff}}';

// A page of its own for the links in the emails: no script, no image, nothing
// fetched, the token never sent on as a referrer, and nothing else may frame it.
function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(title)} — Flood-Net</title><style>${PAGE_STYLE}</style></head><body><main>`
    + `<p class="crumb"><a href="/">Flood-Net</a> › <a href="/api">Station API</a></p><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

const notOurs = () => page('This link is not one we sent', '<p>It may have been copied short. The link in the email is the one to open.</p>'
  + `<p><a href="/api#notify">Sign up again</a> if you need to.</p>`, 404);

// The body, refusing to read past `cap` bytes: null if it is longer.
async function readCapped(request, cap) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { try { await reader.cancel(); } catch (_) { /* gone */ } return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(out);
}

// The token: in the query (the email's link, and a mail client's one-click
// POST to it) or in the form the page's button sends.
async function tokenOf(request, url) {
  const q = url.searchParams.get('token');
  if (q) return q;
  if (request.method !== 'POST') return null;
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('Content-Type') || '')) return null;
  const text = await readCapped(request, 1024);
  return text == null ? null : new URLSearchParams(text).get('token');
}

const WINDOWS = new Map();          // key → timestamps (ms), without the binding

async function underRate(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = (await sha256Hex(`floodnet-notify|${ip}`)).slice(0, 32);
  const b = env[NOTIFY_RATE.binding];
  if (b && typeof b.limit === 'function') {
    try {
      const out = await b.limit({ key });
      return !(out && out.success === false);
    } catch (_) { /* the binding erred: the window below decides */ }
  }
  const now = Date.now();
  const w = (WINDOWS.get(key) || []).filter(t => t > now - NOTIFY_RATE.period * 1000);
  const ok = w.length < NOTIFY_RATE.limit;
  if (ok) w.push(now);
  if (WINDOWS.size > 5000) WINDOWS.clear();
  WINDOWS.set(key, w);
  return ok;
}

function defaults(deps) {
  return {
    fetch: deps.fetch || ((...a) => fetch(...a)),
    now: deps.now || Date.now,
    sleep: deps.sleep || (ms => new Promise(r => setTimeout(r, ms))),
  };
}

async function latestEntries(env, d) {
  try { return (await readChangelog(env, PUBLIC_ORIGIN, d.now())).entries; } catch (_) { return null; }
}

async function status(env, d) {
  const entries = await latestEntries(env, d);
  const latest = entries && entries[0] ? { id: entries[0].id, date: entries[0].date, title: entries[0].title } : null;
  return {
    accepting: !!env.PHOTOS,
    mail: !!env.RESEND_API_KEY,
    ...(env.PHOTOS ? {} : { reason: 'unbound' }),
    latest,
    changelog: CHANGELOG_URL,
    sign_up: SIGN_UP_URL,
  };
}

async function subscribe(request, env, url, reply, d) {
  if (!allowedOrigin(request, url)) return reply({ error: 'sign-ups come from Flood-Net\'s own pages' }, 403);
  // JSON only: from another origin that cannot be sent without the preflight,
  // which is what holds the Origin rule above for a browser.
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return reply({ error: 'expected application/json' }, 415);
  if (Number(request.headers.get('Content-Length') || 0) > LIMITS.requestBytes) return reply({ error: 'too long' }, 413);
  const text = await readCapped(request, LIMITS.requestBytes);
  if (text == null) return reply({ error: 'too long' }, 413);
  let input;
  try { input = JSON.parse(text); } catch (_) { return reply({ error: 'expected a JSON body' }, 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ error: 'expected {email, name?, organisation?}' }, 400);
  const email = validEmail(input.email);
  if (!email) return reply({ error: 'that is not an email address this can send to' }, 400);
  const name = cleanText(input.name), organisation = cleanText(input.organisation);

  if (!(await underRate(request, env))) {
    return reply({ error: `${NOTIFY_RATE.limit} sign-ups a minute from one address at most`, retry_after: NOTIFY_RATE.period },
      429, { 'Retry-After': String(NOTIFY_RATE.period) });
  }
  if (!env.PHOTOS) return reply({ error: 'there is nowhere to keep the list yet', unbound: true }, 503);

  const mail = !!env.RESEND_API_KEY;
  const entries = await latestEntries(env, d);
  const now = d.now();
  let send = null;
  let outcome;
  try {
    outcome = await mutate(env.PHOTOS, list => {
      send = null;
      const day = rollDay(list, now);
      purge(list, now);
      const room = mail && day.emails < LIMITS.dayEmails;
      const known = list.subscribers.find(s => s.email.toLowerCase() === email.toLowerCase());
      if (known) {
        let write = false;
        if (name && !known.name) { known.name = name; write = true; }
        if (organisation && !known.organisation) { known.organisation = organisation; write = true; }
        if (known.status === 'pending' && room
          && (!known.confirm_sent_at || now - Date.parse(known.confirm_sent_at) > LIMITS.resendConfirmMs)) {
          known.confirm_sent_at = iso(now);      // taken now, so a run cannot send it as well
          day.emails++;
          send = { ...known };
          write = true;
        }
        return { write, result: 'known' };
      }
      if (day.signups >= LIMITS.daySignups) return { write: false, result: 'ceiling' };
      if (list.subscribers.length >= LIMITS.subscribers) return { write: false, result: 'full' };
      const s = {
        id: newId(), email, name, organisation, status: 'pending', created_at: iso(now),
        since_id: entries && entries[0] ? entries[0].id : null,
        confirm_token: token(), confirm_sent_at: null, confirm_attempts: 0, confirmed_at: null,
        unsubscribe_token: token(), notified_through: null, notified_at: null, notice_attempts: 0, last_error: null,
      };
      if (room) { s.confirm_sent_at = iso(now); day.emails++; send = { ...s }; }
      list.subscribers.push(s);
      day.signups++;
      return { write: true, result: 'added' };
    });
  } catch (err) {
    return reply({ error: `the list could not be kept just now (${(err && err.message) || err}) — try again in a minute`, uncounted: true }, 503);
  }
  if (outcome === 'ceiling') return reply({ error: `Flood-Net has taken its ${LIMITS.daySignups} sign-ups for today — try again tomorrow`, ceiling: true }, 429);
  if (outcome === 'full') return reply({ error: 'the list is full', full: true }, 503);

  if (send) {
    const r = await sendMail(env, confirmationMail(send, entries), d);
    if (!r.ok) {
      // Given back, so the next run tries again; a third refusal ends it.
      try {
        await mutate(env.PHOTOS, list => {
          const s = list.subscribers.find(x => x.id === send.id);
          if (!s) return { write: false };
          s.confirm_sent_at = null;
          s.confirm_attempts = (s.confirm_attempts || 0) + 1;
          s.last_error = r.error;
          return { write: true };
        });
      } catch (_) { /* the run will find it sent-looking for 14 days; harmless */ }
    }
  }
  return reply({
    ok: true,
    mail: mail ? 'on' : 'off',
    message: mail
      ? 'Thank you. If this address was not on the list already, a link to confirm it is on its way — nothing else is sent until you press it.'
      : 'Thank you — kept. Email is not switched on yet: the link to confirm the address will be sent as soon as it is, and nothing before then.',
  }, 202);
}

async function confirm(request, env, url, d) {
  if (!env.PHOTOS) return page('The list is not available', '<p>Try the link again later.</p>', 503);
  const t = await tokenOf(request, url);
  if (!t || !TOKEN_RE.test(t)) return notOurs();
  const now = d.now();
  if (request.method === 'GET') {
    let found;
    try { found = (await load(env.PHOTOS)).list.subscribers.find(s => s.confirm_token && sameToken(s.confirm_token, t)); } catch (_) {
      return page('The list could not be read', '<p>Try the link again in a minute.</p>', 503);
    }
    if (!found) return notOurs();
    if (found.status === 'confirmed') return page('You are on the list', `<p>${esc(masked(found.email))} already gets an email when Flood-Net's API changes.</p>`);
    if (linkExpired(found, now)) {
      return page('This link has expired', `<p>A link to confirm works for ${LIMITS.confirmDays} days. <a href="/api#notify">Sign up again</a> for a new one.</p>`, 410);
    }
    return page('Confirm the email', `<p>Send an email to <strong>${esc(masked(found.email))}</strong> whenever Flood-Net's station API changes?</p>`
      + `<form method="post" action="${PREFIX}/confirm"><input type="hidden" name="token" value="${esc(t)}"><button type="submit">Confirm</button></form>`
      + '<p>Every email has a link to stop them.</p>');
  }
  let out;
  try {
    out = await mutate(env.PHOTOS, list => {
      const s = list.subscribers.find(x => x.confirm_token && sameToken(x.confirm_token, t));
      if (!s) return { write: false, result: { status: 'unknown' } };
      if (s.status === 'confirmed') return { write: false, result: { status: 'already', email: s.email } };
      if (linkExpired(s, now)) return { write: false, result: { status: 'expired' } };
      s.status = 'confirmed';
      s.confirmed_at = iso(now);
      s.notified_through = s.since_id || null;   // told about everything after the newest change when they signed up
      s.last_error = null;
      return { write: true, result: { status: 'confirmed', email: s.email } };
    });
  } catch (_) {
    return page('That did not go through', '<p>The list could not be written just now. Go back and press Confirm again in a minute.</p>', 503);
  }
  if (out.status === 'unknown') return notOurs();
  if (out.status === 'expired') return page('This link has expired', `<p><a href="/api#notify">Sign up again</a> for a new one.</p>`, 410);
  return page(out.status === 'already' ? 'You are on the list' : 'Confirmed',
    `<p>${esc(masked(out.email))} will get an email when Flood-Net's station API changes — once a change is made. Every email has a link to stop them.</p>`
    + `<p>The changes so far: <a href="/api/v1/changelog">the list</a>, or <a href="/api#notify">the API page</a>.</p>`);
}

async function unsubscribe(request, env, url, d) {
  if (!env.PHOTOS) return page('The list is not available', '<p>Try the link again later.</p>', 503);
  const t = await tokenOf(request, url);
  if (!t || !TOKEN_RE.test(t)) return notOurs();
  if (request.method === 'GET') {
    let found;
    try { found = (await load(env.PHOTOS)).list.subscribers.find(s => sameToken(s.unsubscribe_token, t)); } catch (_) {
      return page('The list could not be read', '<p>Try the link again in a minute.</p>', 503);
    }
    if (!found) return page('This address is not on the list', '<p>Nothing more will be sent to it.</p>');
    return page('Stop these emails', `<p>Stop emailing <strong>${esc(masked(found.email))}</strong> when Flood-Net's API changes, and delete the address from the list?</p>`
      + `<form method="post" action="${PREFIX}/unsubscribe"><input type="hidden" name="token" value="${esc(t)}"><button type="submit">Stop these emails</button></form>`);
  }
  let removed;
  try {
    removed = await mutate(env.PHOTOS, list => {
      const before = list.subscribers.length;
      list.subscribers = list.subscribers.filter(s => !sameToken(s.unsubscribe_token, t));
      return before === list.subscribers.length ? { write: false, result: false } : { write: true, result: true };
    });
  } catch (_) {
    return page('That did not go through', '<p>The list could not be written just now. Press the button again in a minute.</p>', 503);
  }
  return page(removed ? 'Done' : 'This address is not on the list',
    removed ? '<p>The address is deleted from the list, and nothing more will be sent to it.</p>'
      + '<p>Changed your mind? <a href="/api#notify">Sign up again</a>.</p>' : '<p>Nothing more will be sent to it.</p>');
}

export async function handleNotify(request, env, ctx, deps = {}) {
  const d = defaults(deps);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === `${PREFIX}/confirm` && (request.method === 'GET' || request.method === 'POST')) return await confirm(request, env || {}, url, d);
    if (path === `${PREFIX}/unsubscribe` && (request.method === 'GET' || request.method === 'POST')) return await unsubscribe(request, env || {}, url, d);
    const origin = allowedOrigin(request, url);
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    const reply = (body, status, extra = {}) => json(body, status, { ...cors, ...extra });
    if (path !== PREFIX && path !== `${PREFIX}/subscribe`) return reply({ error: 'not a notify list address' }, 404);
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (path === PREFIX) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply({ error: 'GET only' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
      return reply(await status(env || {}, d), 200);
    }
    if (request.method !== 'POST') return reply({ error: 'POST only' }, 405, { Allow: 'POST, OPTIONS' });
    return await subscribe(request, env || {}, url, reply, d);
  } catch (err) {
    return json({ error: `the notify list: ${(err && err.message) || err}` }, 500);
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

// Whether the minute scheduled() fired for is one this runs on.
export function notifyDue(scheduledTime) {
  const minute = Math.floor(Number(scheduledTime) / 60000);
  return Number.isFinite(minute) && minute % LIMITS.everyMinutes === LIMITS.offsetMinute;
}

// What is due: confirmations first (somebody is waiting on each), then the
// notices; and `marks`, subscribers with nothing to be told who are up to date.
function plan(list, entries, now) {
  const jobs = [], marks = [];
  for (const s of list.subscribers) {
    if (s.status === 'pending' && !s.confirm_sent_at && (s.confirm_attempts || 0) < LIMITS.attempts) jobs.push({ kind: 'confirm', id: s.id });
  }
  const newest = entries[0];
  if (newest) {
    for (const s of list.subscribers) {
      if (s.status !== 'confirmed' || s.notified_through === newest.id) continue;
      const due = entriesAfter(entries, s.notified_through, String(s.confirmed_at || s.created_at || '').slice(0, 10)).slice(0, LIMITS.entriesPerNotice);
      if (due.length) jobs.push({ kind: 'notice', id: s.id, entries: due, through: newest.id });
      else marks.push({ id: s.id, through: newest.id });
    }
  }
  return { jobs, marks };
}

// One run: send what is due, within the run's and the day's allowance, and
// record what went. Answers counts only — this is what gets logged.
export async function runNotify(env, deps = {}) {
  const d = defaults(deps);
  if (!env || !env.RESEND_API_KEY) return { mail: false };
  if (!env.PHOTOS) return { mail: true, error: 'no PHOTOS bucket to keep the list in' };
  const now = d.now();
  let first;
  try { first = await load(env.PHOTOS); } catch (err) { return { mail: true, error: err.message }; }
  if (!first.list.subscribers.length) return { mail: true, subscribers: 0 };
  const entries = (await latestEntries(env, d)) || [];
  const before = plan(first.list, entries, now);
  const stale = first.list.subscribers.some(s => s.status === 'pending' && (purge({ subscribers: [s] }, now) > 0));
  if (!before.jobs.length && !before.marks.length && !stale) return { mail: true, due: 0 };

  // The list, held for this run: another run that starts meanwhile goes away.
  let held;
  try {
    held = await mutate(env.PHOTOS, list => {
      if (list.lease_until && Date.parse(list.lease_until) > now) return { write: false, result: null };
      const day = rollDay(list, now);
      const purged = purge(list, now);
      list.lease_until = iso(now + LIMITS.leaseMs);
      const { jobs, marks } = plan(list, entries, now);
      const budget = Math.max(0, Math.min(LIMITS.perRun, LIMITS.dayEmails - day.emails));
      const work = jobs.slice(0, budget);
      day.emails += work.length;                 // counted before sending
      const snap = new Map(list.subscribers.map(s => [s.id, { ...s }]));
      return { write: true, result: { work, marks, purged, waiting: jobs.length - work.length, snap } };
    });
  } catch (err) {
    return { mail: true, error: err.message };
  }
  if (!held) return { mail: true, busy: true };

  const results = [];
  for (let i = 0; i < held.work.length; i++) {
    if (i) await d.sleep(LIMITS.paceMs);
    const job = held.work[i];
    const s = held.snap.get(job.id);
    const r = await sendMail(env, job.kind === 'confirm' ? confirmationMail(s, entries) : noticeMail(s, job.entries), d);
    results.push({ ...job, ok: r.ok, error: r.error || null });
  }

  try {
    await mutate(env.PHOTOS, list => {
      const at = iso(now);
      for (const r of results) {
        const s = list.subscribers.find(x => x.id === r.id);
        if (!s) continue;                        // gone meanwhile: unsubscribed
        if (r.kind === 'confirm') {
          if (r.ok) { s.confirm_sent_at = s.confirm_sent_at || at; s.last_error = null; }
          else { s.confirm_attempts = (s.confirm_attempts || 0) + 1; s.last_error = r.error; }
        } else if (r.ok || (s.notice_attempts || 0) + 1 >= LIMITS.attempts) {
          // Sent — or refused LIMITS.attempts times, and passed over until the next change.
          s.notified_through = r.through;
          s.notified_at = at;
          s.notice_attempts = 0;
          s.last_error = r.ok ? null : r.error;
        } else {
          s.notice_attempts = (s.notice_attempts || 0) + 1;
          s.last_error = r.error;
        }
      }
      for (const m of held.marks) {
        const s = list.subscribers.find(x => x.id === m.id);
        if (s && s.status === 'confirmed') s.notified_through = m.through;
      }
      const newest = entries[0] && entries[0].id;
      const confirmed = list.subscribers.filter(s => s.status === 'confirmed');
      if (newest && confirmed.length && confirmed.every(s => s.notified_through === newest)
        && (!list.last_sent || list.last_sent.id !== newest)) list.last_sent = { id: newest, at };
      list.lease_until = null;
      return { write: true };
    });
  } catch (err) {
    return { mail: true, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, error: `not recorded: ${err.message}` };
  }
  return {
    mail: true,
    confirmations: results.filter(r => r.kind === 'confirm' && r.ok).length,
    notices: results.filter(r => r.kind === 'notice' && r.ok).length,
    failed: results.filter(r => !r.ok).length,
    waiting: held.waiting,
    purged: held.purged,
  };
}

// Read by the check and by nothing else.
export const _test = { reset() { WINDOWS.clear(); }, plan, masked };
