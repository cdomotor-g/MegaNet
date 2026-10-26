// /api/report — the 🐞 dialog's Send, filed from here (bug-report.js).
//
// The dialog used to open GitHub's prefilled "New issue" page: a report took a
// GitHub account and a second Submit on another site, and anybody without an
// account was left to copy it into an email. This files it for them. The
// dialog asks GET when it opens, and where this answers ready, its one button
// sends the report here and the reporter is done.
//
//   GET     /api/report   {ready, to: ['github', 'email'], reason?}
//   POST    /api/report   {type, title, body} → 201 {to, number?, url?}
//   OPTIONS /api/report   the github.io copy's preflight
//
// ── Where a report goes ──────────────────────────────────────────────────────
// Worker secrets, set by a person (docs/bug-reports.md); either or both:
//
//   GITHUB_ISSUES_TOKEN   a fine-grained token on cdomotor-g/MegaNet alone,
//                         Issues: read and write. The report becomes an issue
//                         there, labelled bug, enhancement or question.
//   RESEND_API_KEY and    the report emailed as well, from the address #237
//   REPORT_EMAIL_TO       verifies with Resend. Comma-separated for more than
//                         one, and a secret rather than written here so no
//                         address sits in a public repository.
//
// With neither, GET answers ready: false and POST 503 {unconfigured: true}, and
// the dialog offers GitHub's prefilled page as it always did. A filing that
// fails — GitHub or Resend refusing, the day's ceiling reached — ends the same
// way round: the dialog says so and offers that page, so nothing typed is lost.
//
// ── Who may, and how much ────────────────────────────────────────────────────
// Anybody: the dialog is for people with no account of any kind, so there is
// no sign-in to ask for. The brakes are on volume and on reach instead:
//
//   * Origin — a POST comes from this origin or the github.io copy, so a page
//     elsewhere cannot have its visitors' browsers file reports.
//   * REPORT_RATE_LIMIT — 3 a minute per address (wrangler.toml), with a
//     window in the isolate standing in without the binding, as in api.js.
//   * DAY_MAX a UTC day in all, counted in the PHOTOS bucket under _meganet/,
//     a prefix no photo path reaches. Read then written, so two at the same
//     instant can both take the last place: a brake, not a quota. Past it the
//     dialog falls back to GitHub's page, where a person can still file under
//     their own name.
//   * Sizes — a title of 256 characters (GitHub's own limit), a body of 60,000
//     (inside its 65,536), a request of 128 KB.
//   * Reach — outside code blocks, an @mention and another repository's
//     owner/repo#123 are broken with a word joiner, so a report cannot notify
//     anybody on GitHub, or write into another project's timeline, under the
//     token's name.
//
// The repository is public, so an issue filed here is too. The dialog says so
// beside the box, and asks for codes and contact details to be left out.

const PATH = '/api/report';
const REPO = 'cdomotor-g/MegaNet';
const GITHUB_ISSUES_URL = `https://api.github.com/repos/${REPO}/issues`;
const RESEND_URL = 'https://api.resend.com/emails';
// The sender 0062's account mail uses: the one address on floodwarning.net
// that Resend is set up to send from.
const MAIL_FROM = 'Flood-Net <noreply@floodwarning.net>';

export const REPORT_RATE = Object.freeze({ binding: 'REPORT_RATE_LIMIT', limit: 3, period: 60 });
export const DAY_MAX = 25;
export const MAX = Object.freeze({ title: 256, body: 60000, request: 131072 });
export const COUNT_PREFIX = '_meganet/reports/';
const TIMEOUT_MS = 10000;

// The dialog's kinds, and the label each is filed under: GitHub's default
// labels, which every repository starts with.
export const KINDS = Object.freeze({ bug: 'bug', enhancement: 'enhancement', question: 'question' });

// Where a page on another origin may file from. This origin always may.
export const OTHER_ORIGINS = Object.freeze(['https://cdomotor-g.github.io']);

const FOOTER = '\n\n<sub>Sent straight from the app, with no GitHub account needed — the reporter is not told of replies here.</sub>';

export function isReportPath(pathname) {
  return pathname === PATH;
}

function recipients(env) {
  return String(env.REPORT_EMAIL_TO || '').split(',').map(s => s.trim())
    .filter(s => /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(s));
}

export function destinations(env) {
  const to = [];
  if (env.GITHUB_ISSUES_TOKEN) to.push('github');
  if (env.RESEND_API_KEY && recipients(env).length) to.push('email');
  return to;
}

function allowedOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return origin && (origin === url.origin || OTHER_ORIGINS.includes(origin)) ? origin : null;
}

// The body, refusing to read past `cap` bytes.
async function readCapped(request, cap) {
  if (!request.body) return new Uint8Array(0);
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
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Brakes ───────────────────────────────────────────────────────────────────

const WINDOWS = new Map();          // key → timestamps (ms), without the binding

async function underRate(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = (await sha256Hex(`floodnet-report|${ip}`)).slice(0, 32);
  const b = env[REPORT_RATE.binding];
  if (b && typeof b.limit === 'function') {
    try {
      const out = await b.limit({ key });
      return !(out && out.success === false);
    } catch (_) { /* the binding erred: the window below decides */ }
  }
  const now = Date.now();
  const w = (WINDOWS.get(key) || []).filter(t => t > now - REPORT_RATE.period * 1000);
  const ok = w.length < REPORT_RATE.limit;
  if (ok) w.push(now);
  if (WINDOWS.size > 5000) WINDOWS.clear();
  WINDOWS.set(key, w);
  return ok;
}

export function dayKey(now = Date.now()) {
  return `${COUNT_PREFIX}${new Date(now).toISOString().slice(0, 10)}`;
}

async function filedToday(env) {
  const obj = await env.PHOTOS.get(dayKey());
  return obj ? (Number(await obj.text()) || 0) : 0;
}

// ── The report ───────────────────────────────────────────────────────────────

// Outside fenced code, `@name` and `owner/repo#123` with U+2060 after the @ or
// the #: it draws as nothing, and GitHub no longer reads either as a link.
export function defuse(text) {
  return String(text).split(/(```[\s\S]*?```)/g).map((part, i) => (i % 2 ? part : part
    .replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, '$1@⁠')
    .replace(/\b([\w.-]+\/[\w.-]+)#(?=\d)/g, '$1#⁠')
    .replace(/(github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/)(?=\d)/gi, '$1⁠'))).join('');
}

function cut(text) {
  if (text.length <= MAX.body) return text;
  let out = text.slice(0, MAX.body);
  if ((out.match(/```/g) || []).length % 2) out += '\n```';
  return `${out}\n\n_(cut at ${MAX.body.toLocaleString('en-AU')} characters)_`;
}

// {label, title, body, mail} from what the dialog sent, or {error}.
export function shape(input) {
  if (!input || typeof input !== 'object') return { error: 'expected {type, title, body}' };
  const label = Object.prototype.hasOwnProperty.call(KINDS, input.type) ? KINDS[input.type] : null;
  if (!label) return { error: `type is one of ${Object.keys(KINDS).join(', ')}` };
  if (typeof input.title !== 'string' || typeof input.body !== 'string') {
    return { error: 'title and body are text' };
  }
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, MAX.title);
  const body = cut(input.body.trim());
  if (!title || !body) return { error: 'a report needs a title and a body' };
  return { label, title, body: defuse(body) + FOOTER, mail: body };
}

async function send(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

async function fileIssue(env, r) {
  const res = await send(GITHUB_ISSUES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub refuses a request with no User-Agent, and fetch here sends none.
      'User-Agent': 'Flood-Net bug reporter',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: r.title, body: r.body, labels: [r.label] }),
  });
  if (res.status !== 201) throw new Error(`GitHub answered HTTP ${res.status}`);
  const out = await res.json();
  return { number: out.number, url: out.html_url };
}

async function sendMail(env, r, issue) {
  const res = await send(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: recipients(env),
      subject: `Flood-Net report: ${r.title}`,
      text: `${issue ? `Filed as ${issue.url}\n\n` : ''}${r.title}\n\n${r.mail}\n`,
    }),
  });
  if (!res.ok) throw new Error(`Resend answered HTTP ${res.status}`);
}

async function readiness(env) {
  const to = destinations(env);
  if (!to.length) return { ready: false, to, reason: 'unconfigured' };
  if (!env.PHOTOS) return { ready: false, to, reason: 'uncounted' };
  try {
    if (await filedToday(env) >= DAY_MAX) return { ready: false, to, reason: 'ceiling' };
  } catch (_) {
    return { ready: false, to, reason: 'uncounted' };
  }
  return { ready: true, to };
}

export async function handleReport(request, env) {
  const url = new URL(request.url);
  const origin = allowedOrigin(request, url);
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
  const reply = (body, status, extra = {}) => json(body, status, { ...cors, ...extra });

  if (request.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method === 'GET') return reply(await readiness(env), 200);
  if (request.method !== 'POST') return reply({ error: 'GET or POST' }, 405);
  if (!origin) return reply({ error: 'reports are sent from Flood-Net itself' }, 403);

  const to = destinations(env);
  if (!to.length) return reply({ error: 'nowhere to send a report yet', unconfigured: true }, 503);
  // JSON only: from another origin that cannot be sent without the preflight,
  // which is what holds the Origin rule above for a browser.
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) {
    return reply({ error: 'expected application/json' }, 415);
  }
  if (Number(request.headers.get('Content-Length') || 0) > MAX.request) {
    return reply({ error: `over ${MAX.request / 1024} KB` }, 413);
  }
  const bytes = await readCapped(request, MAX.request);
  if (!bytes) return reply({ error: `over ${MAX.request / 1024} KB` }, 413);
  const text = new TextDecoder().decode(bytes);
  if (text.length > MAX.request) return reply({ error: `over ${MAX.request / 1024} KB` }, 413);
  let input;
  try { input = JSON.parse(text); } catch (_) { return reply({ error: 'expected a JSON body' }, 400); }
  const r = shape(input);
  if (r.error) return reply({ error: r.error }, 400);

  if (!(await underRate(request, env))) {
    return reply({ error: `${REPORT_RATE.limit} reports a minute from one address at most`, retry_after: REPORT_RATE.period },
      429, { 'Retry-After': String(REPORT_RATE.period) });
  }

  // The day's place is taken before sending, so a run of failures cannot
  // spend more than the day's allowance of GitHub's and Resend's either.
  if (!env.PHOTOS) return reply({ error: 'no bucket to count the day\'s reports in', uncounted: true }, 503);
  try {
    const n = await filedToday(env);
    if (n >= DAY_MAX) return reply({ error: `Flood-Net has taken its ${DAY_MAX} reports for today`, ceiling: true }, 429);
    await env.PHOTOS.put(dayKey(), String(n + 1));
  } catch (e) {
    return reply({ error: `the day's count could not be kept: ${(e && e.message) || e}`, uncounted: true }, 503);
  }

  const sent = [], failed = [];
  let issue = null;
  if (to.includes('github')) {
    try { issue = await fileIssue(env, r); sent.push('github'); }
    catch (e) { failed.push((e && e.message) || String(e)); }
  }
  if (to.includes('email')) {
    try { await sendMail(env, r, issue); sent.push('email'); }
    catch (e) { failed.push((e && e.message) || String(e)); }
  }
  if (!sent.length) return reply({ error: `the report could not be filed: ${failed.join('; ')}` }, 502);
  if (failed.length) console.log(`[report] filed by ${sent.join(', ')}, not by the rest: ${failed.join('; ')}`);
  return reply({ to: sent, ...(issue || {}) }, 201);
}
