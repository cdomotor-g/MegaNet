// The agent API's notify list (worker/notify.js, /api/notify/*) and its list of
// changes (docs/api-changelog.json, worker/changelog.js) — offline: R2, Resend
// and the static-assets binding are stand-ins.
//
// What matters, because each fails in silence if wrong: an address gets one
// email until its owner presses Confirm, and a mail scanner opening the link
// presses nothing; every notice goes once, to confirmed addresses only, each
// carrying a way out that works in one click; the sending is bounded — a run,
// a day, paced — and picks up where it stopped; nothing is sent, or even read,
// before mail is switched on, yet nothing signed up meanwhile is lost; only
// Flood-Net's own pages may sign anybody up, a few a minute; the answer never
// says whether an address was on the list; two writes at once lose neither;
// the list lives where no photo path reaches; and no address reaches a log.
//
// Run:  npm run apinotify

import fs from 'node:fs';
import { repo } from './lib/paths.mjs';
import worker from '../worker/index.js';
import { photoTarget } from '../worker/photos.js';
import { parseChangelog, resetChangelog, CHANGELOG_PATH } from '../worker/changelog.js';
import {
  handleNotify, isNotifyPath, runNotify, notifyDue, confirmationMail, noticeMail, validEmail,
  LIST_KEY, LIMITS, NOTIFY_RATE, _test,
} from '../worker/notify.js';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });
const J = v => JSON.stringify(v);

// Every line anything logs, so the end can ask whether an address got into one.
const logged = [];
const realLog = console.log;
console.log = (...a) => { logged.push(a.map(String).join(' ')); };

const ORIGIN = 'https://floodwarning.net';
const NOW0 = Date.parse('2026-11-02T01:04:00Z');
let now = NOW0;
const clock = () => now;

// ── Stand-ins ────────────────────────────────────────────────────────────────

// R2: an etag per write, and onlyIf as R2 does it — etagMatches, or a Headers
// object with If-None-Match: * for "create it only if it is not there".
function bucket() {
  const m = new Map();
  let n = 0;
  const b = {
    m, gets: 0, puts: 0, refused: 0, beforePut: null,
    async get(k) { b.gets++; return m.has(k) ? { etag: m.get(k).etag, text: async () => m.get(k).body } : null; },
    async put(k, v, opts = {}) {
      if (b.beforePut) { const f = b.beforePut; b.beforePut = null; await f(); }
      const cur = m.get(k);
      const c = opts.onlyIf;
      if (c instanceof Headers) {
        if (c.get('If-None-Match') === '*' && cur) { b.refused++; return null; }
      } else if (c && c.etagMatches !== undefined && (!cur || cur.etag !== c.etagMatches)) { b.refused++; return null; }
      b.puts++;
      m.set(k, { body: String(v), etag: `e${++n}` });
      return { key: k, etag: `e${n}` };
    },
  };
  return b;
}
const listOf = env => (env.PHOTOS.m.has(LIST_KEY) ? JSON.parse(env.PHOTOS.m.get(LIST_KEY).body) : null);
const writeList = (env, list) => env.PHOTOS.m.set(LIST_KEY, { body: J(list), etag: `seed${Math.random()}` });

// The static assets: a changelog the checks can add to.
const ENTRY = (id, date, title, extra = {}) => ({ id, date, title, summary: `What ${title} means, in plain words.`, breaking: false,
  links: [{ text: 'Read more', url: `https://floodwarning.net/api/v1/changelog#${id}` }], ...extra });
let CHANGELOG = { entries: [ENTRY('2026-10-31-first-change', '2026-10-31', 'The first change')] };
const assetReads = [];
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    assetReads.push(p);
    return p === CHANGELOG_PATH ? new Response(J(CHANGELOG), { headers: { 'Content-Type': 'application/json' } }) : new Response('Not found', { status: 404 });
  },
};
function setChangelog(entries) { CHANGELOG = { entries }; resetChangelog(); }

// Resend: what it was sent, and what it answers.
const sent = [];
let resendStatus = 200;
const fetchStub = async (url, init = {}) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
  const body = JSON.parse(init.body);
  sent.push({ headers: Object.fromEntries(new Headers(init.headers || {})), body });
  return new Response(resendStatus === 200 ? '{"id":"x"}' : '{"message":"refused"}', { status: resendStatus });
};
globalThis.fetch = fetchStub;
const slept = [];
const DEPS = { fetch: fetchStub, now: clock, sleep: async ms => { slept.push(ms); } };

const env = (extra = {}) => ({ PHOTOS: bucket(), ASSETS, ...extra });
const MAIL = { RESEND_API_KEY: 're_test' };

let ip = 1;
function post(body, { origin = ORIGIN, type = 'application/json', addr, path = '/api/notify/subscribe' } = {}) {
  const headers = { 'Content-Type': type, 'CF-Connecting-IP': addr || `203.0.113.${ip++}` };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : J(body) });
}
async function read(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* a page */ }
  return { status: res.status, json, text, headers: res.headers };
}
const call = (req, e) => handleNotify(req, e, {}, DEPS).then(read);
const getPage = (path, e) => call(new Request(`${ORIGIN}${path}`), e);
const form = (path, tokenValue, e, query = '') => call(new Request(`${ORIGIN}${path}${query}`, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: tokenValue == null ? '' : `token=${encodeURIComponent(tokenValue)}` }), e);
const tokenIn = (text, kind) => (new RegExp(`/api/notify/${kind}\\?token=([A-Za-z0-9_-]{43})`).exec(text) || [])[1];
const runs = e => runNotify(e, DEPS);

// ── Where it is ──────────────────────────────────────────────────────────────

check('the routes are /api/notify and below, and nothing near them', isNotifyPath('/api/notify') && isNotifyPath('/api/notify/subscribe')
  && isNotifyPath('/api/notify/confirm') && !isNotifyPath('/api/notifyx') && !isNotifyPath('/api/notification'));
{
  const r = await read(await worker.fetch(new Request(`${ORIGIN}/api/notify`), env(), {}));
  check('the Worker sends /api/notify to it', r.status === 200 && r.json && r.json.accepting === true && r.json.mail === false, r.text.slice(0, 200));
}
check('the list is kept under _meganet/, where no photo path reaches', LIST_KEY.startsWith('_meganet/')
  && photoTarget(`/api/photos/${LIST_KEY}`) === null && photoTarget(`/api/photos/field-photos/${LIST_KEY}`) === null
  && photoTarget(`/api/photos/field-photos/../${LIST_KEY}`) === null && photoTarget('/api/photos/field-photos/%2e%2e/_meganet/api-notify/subscribers.json') === null
  && photoTarget('/api/photos/field-photos/photo/00000000-0000-0000-0000-000000000000.jpg') !== null);

// ── The committed list of changes ────────────────────────────────────────────

{
  const file = JSON.parse(fs.readFileSync(repo('docs/api-changelog.json'), 'utf8'));
  const p = parseChangelog(file);
  check('docs/api-changelog.json is well formed: ids of their own, dates, one-line titles, summaries, breaking, https links',
    p.problems.length === 0 && p.entries.length === file.entries.length, p.problems.join(' | '));
  check('…newest first', file.entries.every((e, i, a) => i === 0 || e.date <= a[i - 1].date));
  check('…and its first entry is the ACMA licences', file.entries[file.entries.length - 1].id === '2026-10-31-acma-licences'
    && /ACMA/.test(file.entries[file.entries.length - 1].title));
  const broken = parseChangelog({ entries: [{ id: 'Bad Id', date: '31/10/2026', title: 'two\nlines', summary: '', breaking: 'no', links: [{ text: 'x', url: 'http://plain' }] }] });
  check('an entry that is not well formed is named and left out', broken.entries.length === 0 && broken.problems.length === 1
    && /id/.test(broken.problems[0]) && /date/.test(broken.problems[0]) && /https/.test(broken.problems[0]), broken.problems[0]);
}

// ── Before mail is switched on ───────────────────────────────────────────────

{
  sent.length = 0;
  const e = env();
  const s = await getPage('/api/notify', e);
  check('GET says sign-ups are taken and mail is off, with the latest change and where to sign up', s.json.accepting === true && s.json.mail === false
    && s.json.latest.id === '2026-10-31-first-change' && /\/api#notify$/.test(s.json.sign_up) && /\/api\/v1\/changelog$/.test(s.json.changelog), s.text);
  const r = await call(post({ email: 'first@example.com', name: '  Ada\n Lovelace ', organisation: 'Example Council' }), e);
  check('a sign-up with mail off is kept: 202, mail off, and the form told so in words', r.status === 202 && r.json.ok === true
    && r.json.mail === 'off' && /not switched on yet/.test(r.json.message), r.text);
  const list = listOf(e);
  const s0 = list && list.subscribers[0];
  check('…as pending, with two random 43-character tokens, the newest change it is told after, its name on one line',
    s0 && s0.status === 'pending' && s0.email === 'first@example.com' && /^[A-Za-z0-9_-]{43}$/.test(s0.confirm_token)
      && /^[A-Za-z0-9_-]{43}$/.test(s0.unsubscribe_token) && s0.confirm_token !== s0.unsubscribe_token
      && s0.since_id === '2026-10-31-first-change' && s0.name === 'Ada Lovelace' && s0.organisation === 'Example Council' && s0.confirm_sent_at === null, J(s0));
  check('…and nothing is sent', sent.length === 0);
  const gets = e.PHOTOS.gets;
  assetReads.length = 0;
  const off = await runs(e);
  check('a run with no RESEND_API_KEY returns before reading anything', J(off) === '{"mail":false}' && e.PHOTOS.gets === gets && assetReads.length === 0, J(off));

  Object.assign(e, MAIL);
  const on = await runs(e);
  const m = sent[0];
  check('once the key exists, the next run sends the waiting confirmation', on.confirmations === 1 && sent.length === 1
    && m.body.to.length === 1 && m.body.to[0] === 'first@example.com' && m.body.from === 'Flood-Net <noreply@floodwarning.net>'
    && m.headers.authorization === 'Bearer re_test', J(on));
  check('…with the link to confirm, the link to delete the address, the latest changes and a greeting by name',
    m && tokenIn(m.body.text, 'confirm') === s0.confirm_token && tokenIn(m.body.text, 'unsubscribe') === s0.unsubscribe_token
      && /The first change/.test(m.body.text) && /^Hello Ada Lovelace,/.test(m.body.text) && /Confirm/.test(m.body.subject), m && m.body.text.slice(0, 300));
  const after = listOf(e).subscribers[0];
  check('…recorded as sent, and counted in the day', after.confirm_sent_at && listOf(e).day.emails === 1 && listOf(e).lease_until === null);
  const again = await runs(e);
  check('the next run sends it nothing more', sent.length === 1 && !again.confirmations, J(again));
}

// ── Who may sign up ──────────────────────────────────────────────────────────

{
  const e = env(MAIL);
  const none = await call(post({ email: 'a@example.com' }, { origin: null }), e);
  const evil = await call(post({ email: 'a@example.com' }, { origin: 'https://evil.example' }), e);
  check('a sign-up with no Origin, or another site\'s, is refused and nothing kept', none.status === 403 && evil.status === 403 && !listOf(e));
  const pre = await call(new Request(`${ORIGIN}/api/notify/subscribe`, { method: 'OPTIONS', headers: { Origin: 'https://cdomotor-g.github.io' } }), e);
  check('the github.io copy\'s preflight is allowed', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://cdomotor-g.github.io'
    && /POST/.test(pre.headers.get('access-control-allow-methods')));
  const preBad = await call(new Request(`${ORIGIN}/api/notify/subscribe`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), e);
  check('another site\'s preflight is refused', preBad.status === 403 && !preBad.headers.get('access-control-allow-origin'));
  const plain = await call(post(J({ email: 'a@example.com' }), { type: 'text/plain' }), e);
  check('a sign-up that is not JSON is refused (415): from a page elsewhere it could skip the preflight', plain.status === 415);
  for (const [b, what] of [['not json', 'a body that is not JSON'], [[1], 'an array'], [{ email: 'not an address' }, 'an address that is not one'],
    [{ email: 'a@b' }, 'an address with no domain'], [{ email: `${'x'.repeat(250)}@example.com` }, 'an address over 254 characters'], [{}, 'no address']]) {
    const x = await call(post(b), e);
    check(`refused (400): ${what}`, x.status === 400 && x.json.error, x.text);
  }
  const big = await call(post({ email: 'a@example.com', name: 'x'.repeat(LIMITS.requestBytes) }), e);
  check(`a request over ${LIMITS.requestBytes} bytes is refused (413)`, big.status === 413);
  check('…and none of them kept anything or sent anything', !listOf(e) && sent.length === 1);
  check('validEmail takes a real address and trims it', validEmail(' someone.else@sub.example.com ') === 'someone.else@sub.example.com' && validEmail('a b@example.com') === null);
  const put = await call(new Request(`${ORIGIN}/api/notify/subscribe`, { method: 'PUT', headers: { Origin: ORIGIN } }), e);
  check('any other method is 405', put.status === 405);
  const unbound = await call(post({ email: 'a@example.com' }), { ASSETS });
  const unboundGet = await getPage('/api/notify', { ASSETS });
  check('with no bucket to keep the list in: 503 unbound, and GET says not accepting', unbound.status === 503 && unbound.json.unbound === true
    && unboundGet.json.accepting === false && unboundGet.json.reason === 'unbound');
}

// ── Brakes ───────────────────────────────────────────────────────────────────

{
  _test.reset();
  const e = env();
  const addr = '198.51.100.7';
  const seq = [];
  for (let i = 0; i < NOTIFY_RATE.limit + 1; i++) seq.push(await call(post({ email: `rate${i}@example.com` }, { addr }), e));
  const last = seq[seq.length - 1];
  check(`${NOTIFY_RATE.limit} sign-ups a minute from one address, then 429 with Retry-After — the isolate's window without the binding`,
    seq.slice(0, -1).every(x => x.status === 202) && last.status === 429 && last.headers.get('retry-after') === String(NOTIFY_RATE.period), J(seq.map(x => x.status)));
  const other = await call(post({ email: 'rate-other@example.com' }, { addr: '198.51.100.8' }), e);
  check('…while another address is not held up', other.status === 202);
  const asked = [];
  const bound = env({ NOTIFY_RATE_LIMIT: { limit: async o => { asked.push(o.key); return { success: false }; } } });
  const held = await call(post({ email: 'held@example.com' }, { addr }), bound);
  check('with the binding, it decides — keyed by a hash, not the address', held.status === 429 && asked.length === 1
    && /^[0-9a-f]{32}$/.test(asked[0]) && !asked[0].includes('198'), J(asked));

  const full = env();
  writeList(full, { version: 1, day: { date: new Date(NOW0).toISOString().slice(0, 10), signups: LIMITS.daySignups, emails: 0 }, last_sent: null, lease_until: null, subscribers: [] });
  const ceiling = await call(post({ email: 'late@example.com' }), full);
  check(`after ${LIMITS.daySignups} new sign-ups in a UTC day: 429, and nothing kept`, ceiling.status === 429 && ceiling.json.ceiling === true
    && listOf(full).subscribers.length === 0, ceiling.text);
  const crowded = env();
  writeList(crowded, { version: 1, day: null, last_sent: null, lease_until: null,
    subscribers: Array.from({ length: LIMITS.subscribers }, (_, i) => ({ id: `id${i}`, email: `crowd${i}@example.com`, status: 'confirmed',
      created_at: new Date(NOW0).toISOString(), unsubscribe_token: 'u'.repeat(43), confirm_token: 'c'.repeat(43) })) });
  const fullList = await call(post({ email: 'one-more@example.com' }), crowded);
  check(`a list of ${LIMITS.subscribers} takes no more: 503`, fullList.status === 503 && fullList.json.full === true);
}

// ── Mail on: the confirmation at once, and the same answer either way ────────

let C;   // a confirmed subscriber's env, for the notices below
{
  sent.length = 0;
  const e = env(MAIL);
  const r = await call(post({ email: 'second@example.com' }), e);
  check('with mail on, a sign-up is sent its confirmation at once, and told so', r.status === 202 && r.json.mail === 'on'
    && sent.length === 1 && sent[0].body.to[0] === 'second@example.com' && /on its way/.test(r.json.message), r.text);
  const s = listOf(e).subscribers[0];
  check('…the link it carries the one kept for it, its sending recorded so no run sends it again', tokenIn(sent[0].body.text, 'confirm') === s.confirm_token
    && s.confirm_sent_at && listOf(e).day.emails === 1);
  const runAfter = await runs(e);
  check('…and the run after sends nothing more', sent.length === 1 && !runAfter.confirmations, J(runAfter));
  const same = await call(post({ email: 'Second@Example.com' }), e);
  check('signing up again within the hour sends nothing — and answers exactly as a new address does', same.status === 202
    && J(same.json) === J(r.json) && sent.length === 1 && listOf(e).subscribers.length === 1, same.text);
  now += LIMITS.resendConfirmMs + 60000;
  await call(post({ email: 'second@example.com' }), e);
  check('…after it, the same link is sent again', sent.length === 2 && tokenIn(sent[1].body.text, 'confirm') === s.confirm_token);

  sent.length = 0;
  resendStatus = 422;
  const refused = env(MAIL);
  await call(post({ email: 'refused@example.com' }), refused);
  const rs = listOf(refused).subscribers[0];
  check('a confirmation Resend refuses is given back for the next run, counted as an attempt', rs.confirm_sent_at === null
    && rs.confirm_attempts === 1 && /422/.test(rs.last_error) && !/refused@/.test(rs.last_error));
  await runs(refused); await runs(refused);
  const gone = listOf(refused).subscribers;
  check(`…and after ${LIMITS.attempts} refusals the address is let go`, sent.length === LIMITS.attempts && (await runs(refused), listOf(refused).subscribers.length === 0),
    `${sent.length} tries, ${gone.length} left`);
  resendStatus = 200;

  // ── Confirming ──
  sent.length = 0;
  const g = await getPage(`/api/notify/confirm?token=${s.confirm_token}`, e);
  check('the link opens a page with a Confirm button — and opening it confirms nothing (a mail scanner presses no buttons)',
    g.status === 200 && /<form method="post" action="\/api\/notify\/confirm">/.test(g.text) && /<button type="submit">Confirm<\/button>/.test(g.text)
      && listOf(e).subscribers[0].status === 'pending', g.text.slice(0, 200));
  check('…a page that names the address only in part, sends no referrer, runs no script and cannot be framed',
    !g.text.includes('second@example.com') && g.text.includes('s•••@example.com') && g.headers.get('referrer-policy') === 'no-referrer'
      && /default-src 'none'/.test(g.headers.get('content-security-policy')) && !/<script/i.test(g.text)
      && g.headers.get('x-frame-options') === 'DENY' && g.headers.get('cache-control') === 'no-store');
  const junk = await getPage('/api/notify/confirm?token=not-a-token', e);
  const unknown = await getPage(`/api/notify/confirm?token=${'A'.repeat(43)}`, e);
  check('a link that is not one sent here is a 404 page', junk.status === 404 && unknown.status === 404 && /not one we sent/.test(unknown.text));
  const p = await form('/api/notify/confirm', s.confirm_token, e);
  const c1 = listOf(e).subscribers[0];
  check('pressing Confirm confirms it, from the changes it signed up after', p.status === 200 && /Confirmed/.test(p.text)
    && c1.status === 'confirmed' && c1.confirmed_at && c1.notified_through === '2026-10-31-first-change', J(c1));
  const p2 = await form('/api/notify/confirm', s.confirm_token, e);
  check('…and pressing it again says so', p2.status === 200 && /You are on the list/.test(p2.text));
  const known = await call(post({ email: 'second@example.com' }), e);
  check('signing up a confirmed address answers as for any other, and sends nothing', J(known.json) === J(r.json) && sent.length === 0);

  const late = env(MAIL);
  await call(post({ email: 'late-click@example.com' }), late);
  const ls = listOf(late).subscribers[0];
  now += (LIMITS.confirmDays + 1) * 86400000;
  const lateGet = await getPage(`/api/notify/confirm?token=${ls.confirm_token}`, late);
  const latePost = await form('/api/notify/confirm', ls.confirm_token, late);
  check(`a link more than ${LIMITS.confirmDays} days old has expired: 410, not confirmed`, lateGet.status === 410 && latePost.status === 410
    && listOf(late).subscribers[0].status === 'pending');
  await call(post({ email: 'someone-new@example.com' }), late);
  check('…and the next write lets the stale sign-up go', !listOf(late).subscribers.some(x => x.email === 'late-click@example.com'));
  now = NOW0 + 2 * 3600000;
  C = e;
}

// ── Notices ──────────────────────────────────────────────────────────────────

{
  sent.length = 0;
  const quiet = await runs(C);
  check('with no new change, a run sends a confirmed subscriber nothing', sent.length === 0 && !quiet.notices, J(quiet));
  await call(post({ email: 'pending-only@example.com' }), C);
  sent.length = 0;
  setChangelog([ENTRY('2026-11-02-new-field', '2026-11-02', 'A new field on the dossier'), ...CHANGELOG.entries]);
  const r1 = await runs(C);
  const notices = sent.filter(m => /^Flood-Net API: /.test(m.body.subject));
  const n = notices[0];
  const sub = listOf(C).subscribers.find(x => x.email === 'second@example.com');
  check('a new entry is emailed to the confirmed subscriber, once', r1.notices === 1 && notices.length === 1 && n.body.to[0] === 'second@example.com'
    && n.body.subject === 'Flood-Net API: A new field on the dossier', J(r1));
  check('…not to anybody still pending', !sent.some(m => m.body.to[0] === 'pending-only@example.com' && /^Flood-Net API/.test(m.body.subject)));
  check('…saying what changed, with its links, the whole list and the reference',
    n && /A new field on the dossier/.test(n.body.text) && /What A new field on the dossier means/.test(n.body.text)
      && n.body.text.includes('https://floodwarning.net/api/v1/changelog#2026-11-02-new-field') && n.body.text.includes('https://floodwarning.net/api/v1/changelog')
      && !/The first change/.test(n.body.text));
  check('…with a way out in the body and in the headers a mail client uses for one-click unsubscribe (RFC 8058)',
    n && tokenIn(n.body.text, 'unsubscribe') === sub.unsubscribe_token && n.body.headers['List-Unsubscribe'] === `<https://floodwarning.net/api/notify/unsubscribe?token=${sub.unsubscribe_token}>`
      && n.body.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
  check('…recorded: the subscriber up to date, and the list\'s last-sent marker on the new entry', sub.notified_through === '2026-11-02-new-field'
    && listOf(C).last_sent && listOf(C).last_sent.id === '2026-11-02-new-field' && listOf(C).lease_until === null);
  const before = sent.length;
  const r2 = await runs(C);
  check('the next run sends it again to nobody', sent.length === before && !r2.notices, J(r2));

  setChangelog([ENTRY('2026-11-03-limit', '2026-11-03', 'A lower limit', { breaking: true }), ENTRY('2026-11-03-tool', '2026-11-03', 'A new tool'), ...CHANGELOG.entries]);
  sent.length = 0;
  await runs(C);
  const both = sent.find(m => m.body.to[0] === 'second@example.com');
  check('two new entries at once are one email, a breaking one flagged in its subject and its text', both && both.body.subject === '[Breaking] Flood-Net API: 2 changes'
    && /A lower limit/.test(both.body.text) && /A new tool/.test(both.body.text) && /BREAKING/.test(both.body.text) && !/A new field on the dossier/.test(both.body.text), both && both.body.subject);
}

{
  // Bounded: more confirmed subscribers than a run may send to.
  sent.length = 0;
  slept.length = 0;
  const e = env(MAIL);
  const n = LIMITS.perRun + 5;
  const subs = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, email: `many${i}@example.com`, name: null, organisation: null, status: 'confirmed',
    created_at: new Date(NOW0).toISOString(), since_id: '2026-10-31-first-change', confirm_token: `c${String(i).padStart(42, '0')}`, confirm_sent_at: new Date(NOW0).toISOString(),
    confirm_attempts: 0, confirmed_at: new Date(NOW0).toISOString(), unsubscribe_token: `u${String(i).padStart(42, '0')}`,
    notified_through: '2026-10-31-first-change', notified_at: null, notice_attempts: 0, last_error: null }));
  writeList(e, { version: 1, day: null, last_sent: null, lease_until: null, subscribers: subs });
  setChangelog([ENTRY('2026-11-04-batch', '2026-11-04', 'Batched'), ENTRY('2026-10-31-first-change', '2026-10-31', 'The first change')]);
  const r1 = await runs(e);
  check(`a run sends ${LIMITS.perRun} at most, and says how many wait`, r1.notices === LIMITS.perRun && r1.waiting === n - LIMITS.perRun && sent.length === LIMITS.perRun, J(r1));
  check(`…paced ${LIMITS.paceMs} ms apart, under Resend's two a second`, slept.length === LIMITS.perRun - 1 && slept.every(ms => ms === LIMITS.paceMs), J(slept));
  const r2 = await runs(e);
  const to = sent.map(m => m.body.to[0]);
  check('the next run sends the rest, and nobody twice', r2.notices === n - LIMITS.perRun && to.length === n && new Set(to).size === n, J(r2));
  check('…then the list\'s marker says everybody has it', listOf(e).last_sent.id === '2026-11-04-batch' && listOf(e).day.emails === n);

  const capped = env(MAIL);
  writeList(capped, { version: 1, day: { date: new Date(now).toISOString().slice(0, 10), signups: 0, emails: LIMITS.dayEmails - 2 }, last_sent: null, lease_until: null,
    subscribers: subs.map(x => ({ ...x })) });
  sent.length = 0;
  const r3 = await runs(capped);
  check(`the day's ${LIMITS.dayEmails} emails hold: with 2 left, 2 go`, r3.notices === 2 && sent.length === 2 && listOf(capped).day.emails === LIMITS.dayEmails, J(r3));

  const leased = env(MAIL);
  writeList(leased, { version: 1, day: null, last_sent: null, lease_until: new Date(now + 60000).toISOString(), subscribers: subs.map(x => ({ ...x })) });
  sent.length = 0;
  const r4 = await runs(leased);
  check('while another run holds the list, a run sends nothing', r4.busy === true && sent.length === 0);

  const failing = env(MAIL);
  writeList(failing, { version: 1, day: null, last_sent: null, lease_until: null, subscribers: [{ ...subs[0] }] });
  resendStatus = 500;
  sent.length = 0;
  const f1 = await runs(failing);
  const fs1 = listOf(failing).subscribers[0];
  check('a notice Resend refuses is not marked sent, and is tried again next run', f1.failed === 1 && fs1.notified_through === '2026-10-31-first-change'
    && fs1.notice_attempts === 1 && /500/.test(fs1.last_error), J(f1));
  await runs(failing); await runs(failing);
  check(`…and after ${LIMITS.attempts} refusals it is passed over until the next change`, sent.length === LIMITS.attempts
    && listOf(failing).subscribers[0].notified_through === '2026-11-04-batch');
  resendStatus = 200;
}

{
  // Two writes at once: a sign-up lands while a run is recording what it sent.
  sent.length = 0;
  const e = env(MAIL);
  await call(post({ email: 'racer@example.com' }), e);
  await form('/api/notify/confirm', listOf(e).subscribers[0].confirm_token, e);
  setChangelog([ENTRY('2026-11-05-race', '2026-11-05', 'Raced'), ...CHANGELOG.entries]);
  let injected = false;
  const putsBefore = e.PHOTOS.puts;
  // The run's first write is its hold on the list; its second, after sending,
  // records — and just before that one, somebody else's sign-up is written.
  let seen = 0;
  const realPut = e.PHOTOS.put.bind(e.PHOTOS);
  e.PHOTOS.put = async (k, v, o) => {
    if (++seen === 2 && !injected) {
      injected = true;
      const cur = JSON.parse(e.PHOTOS.m.get(LIST_KEY).body);
      cur.subscribers.push({ id: 'zz', email: 'concurrent@example.com', status: 'pending', created_at: new Date(now).toISOString(),
        confirm_token: 'z'.repeat(43), unsubscribe_token: 'y'.repeat(43), confirm_sent_at: null, confirm_attempts: 0 });
      e.PHOTOS.m.set(LIST_KEY, { body: J(cur), etag: 'somebody-else' });
    }
    return realPut(k, v, o);
  };
  await runs(e);
  const after = listOf(e);
  check('two writes at once lose neither: the run\'s record and the other sign-up are both there', injected && e.PHOTOS.refused >= 1
    && after.subscribers.some(x => x.email === 'concurrent@example.com') && after.subscribers.find(x => x.email === 'racer@example.com').notified_through === '2026-11-05-race'
    && e.PHOTOS.puts > putsBefore, `${e.PHOTOS.refused} refused`);
}

// ── Leaving ──────────────────────────────────────────────────────────────────

{
  sent.length = 0;
  const s = listOf(C).subscribers.find(x => x.email === 'second@example.com');
  const g = await getPage(`/api/notify/unsubscribe?token=${s.unsubscribe_token}`, C);
  check('the way-out link opens a page with one button — opening it deletes nothing', g.status === 200
    && /<button type="submit">Stop these emails<\/button>/.test(g.text) && listOf(C).subscribers.some(x => x.id === s.id));
  const p = await form('/api/notify/unsubscribe', s.unsubscribe_token, C);
  check('pressing it deletes the address from the list', p.status === 200 && /Done/.test(p.text) && !listOf(C).subscribers.some(x => x.id === s.id));
  setChangelog([ENTRY('2026-11-06-after', '2026-11-06', 'After leaving'), ...CHANGELOG.entries]);
  await runs(C);
  check('…and nothing is sent to it after', !sent.some(m => m.body.to[0] === 'second@example.com'));
  const again = await form('/api/notify/unsubscribe', s.unsubscribe_token, C);
  check('the link again says it is not on the list', again.status === 200 && /not on the list/.test(again.text));

  const e = env(MAIL);
  await call(post({ email: 'oneclick@example.com' }), e);
  const t = listOf(e).subscribers[0].unsubscribe_token;
  const oneClick = await read(await handleNotify(new Request(`${ORIGIN}/api/notify/unsubscribe?token=${t}`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }), e, {}, DEPS));
  check('a mail client\'s one-click unsubscribe (RFC 8058: a POST with no Origin) deletes the address', oneClick.status === 200
    && listOf(e).subscribers.length === 0);
}

// ── The schedule ─────────────────────────────────────────────────────────────

{
  const due = Date.parse('2026-11-02T03:04:00Z'), notDue = Date.parse('2026-11-02T03:05:00Z');
  check(`notifyDue: every ${LIMITS.everyMinutes} minutes, at :04, :19, :34 and :49`, notifyDue(due) && notifyDue(Date.parse('2026-11-02T03:49:00Z'))
    && !notifyDue(notDue) && !notifyDue(Date.parse('2026-11-02T03:00:00Z')) && !notifyDue(undefined));
  sent.length = 0;
  const e = env(MAIL);
  writeList(e, { version: 1, day: null, last_sent: null, lease_until: null, subscribers: [{ id: 's1', email: 'scheduled@example.com', name: null, organisation: null,
    status: 'pending', created_at: new Date().toISOString(), since_id: null, confirm_token: 'k'.repeat(43), confirm_sent_at: null, confirm_attempts: 0,
    confirmed_at: null, unsubscribe_token: 'q'.repeat(43), notified_through: null, notified_at: null, notice_attempts: 0, last_error: null }] });
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const gets = e.PHOTOS.gets;
  await worker.scheduled({ scheduledTime: notDue, cron: '* * * * *' }, e, ctx);
  await Promise.all(waits);
  check('scheduled() on any other minute leaves the list alone — not even read', e.PHOTOS.gets === gets && sent.length === 0);
  waits.length = 0;
  await worker.scheduled({ scheduledTime: due, cron: '* * * * *' }, e, ctx);
  await Promise.all(waits);
  check('scheduled() on its minute sends what is due', sent.length === 1 && sent[0].body.to[0] === 'scheduled@example.com'
    && listOf(e).subscribers[0].confirm_sent_at);
}

// ── Mail as written ──────────────────────────────────────────────────────────

{
  const s = { email: 'x@example.com', name: null, confirm_token: 'a'.repeat(43), unsubscribe_token: 'b'.repeat(43) };
  const cm = confirmationMail(s, [ENTRY('e2', '2026-11-02', 'Two', { breaking: true }), ENTRY('e1', '2026-10-31', 'One')]);
  check('a confirmation lists the latest changes, dated, a breaking one said so, and greets nobody it has no name for',
    /2 November 2026: Two \(breaking\)/.test(cm.text) && /31 October 2026: One/.test(cm.text) && !/^Hello/.test(cm.text) && !cm.headers);
  const nm = noticeMail({ ...s, name: 'Grace' }, [ENTRY('e3', '2026-11-07', 'x'.repeat(200))]);
  check('a notice\'s subject is kept to a line', nm.subject.length <= 150 && /^Hello Grace,/.test(nm.text));
  check('every email says Flood-Net is not a warning service', /not a flood warning service/.test(cm.text) && /not a flood warning service/.test(nm.text));
}

// ── Privacy ──────────────────────────────────────────────────────────────────

console.log = realLog;
check('no address, and no token, reached a log line — of the runs\' own, which say only counts', logged.length > 0
  && logged.every(l => !/@/.test(l) && !/[A-Za-z0-9_-]{43}/.test(l)), `${logged.length} lines: ${logged.slice(0, 2).join(' | ')}`);

// ── Report ───────────────────────────────────────────────────────────────────

const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.what}${r.ok || !r.detail ? '' : ` — ${String(r.detail).slice(0, 300)}`}`);
console.log(failed.length ? `\nFAIL — ${failed.length} of ${results.length}.`
  : `\nPASS — ${results.length} checks: one email until Confirm is pressed, each change once to confirmed addresses, ${LIMITS.perRun} a run and ${LIMITS.dayEmails} a day, a way out in one click, and no address in a log.`);
process.exitCode = failed.length ? 1 : 0;
