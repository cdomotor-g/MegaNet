// The bug reporter's Send (worker/report.js, /api/report) — offline: GitHub,
// Resend and the bucket are stand-ins.
//
// What matters, because each fails in silence if wrong: a report goes where the
// secrets say and nowhere without them; only Flood-Net's own pages may send
// one; the brakes hold — a few a minute from one address, DAY_MAX a day in all,
// counted before anything is sent; nothing over GitHub's sizes; and a report
// cannot mention anybody on GitHub, or reach into another repository, under the
// token's name. And the answers the dialog reads — ready, unconfigured,
// ceiling, a busy minute — are the ones it expects.
//
// Run:  npm run report

import worker from '../worker/index.js';
import { handleReport, isReportPath, shape, defuse, dayKey, DAY_MAX, MAX, REPORT_RATE } from '../worker/report.js';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });
const J = v => JSON.stringify(v);

const ORIGIN = 'https://floodwarning.net';
const URL_ = `${ORIGIN}/api/report`;

function bucket() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? { text: async () => m.get(k) } : null; },
    async put(k, v) { m.set(k, String(v)); return {}; },
  };
}

// GitHub and Resend on fetch: what each was sent, and what each answers.
const calls = [];
let githubStatus = 201, resendStatus = 200, nextIssue = 100;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const h = new Headers(init.headers || {});
  calls.push({ url: u, method: init.method, headers: Object.fromEntries(h), body: init.body ? JSON.parse(init.body) : null });
  if (u === 'https://api.github.com/repos/cdomotor-g/MegaNet/issues') {
    if (githubStatus !== 201) return new Response('{"message":"Bad credentials"}', { status: githubStatus });
    const n = nextIssue++;
    return new Response(J({ number: n, html_url: `https://github.com/cdomotor-g/MegaNet/issues/${n}` }), { status: 201 });
  }
  if (u === 'https://api.resend.com/emails') return new Response('{"id":"x"}', { status: resendStatus });
  throw new Error(`unexpected fetch ${u}`);
};

let ip = 1;
function post(body, { origin = ORIGIN, type = 'application/json', addr } = {}) {
  const headers = { 'Content-Type': type, 'CF-Connecting-IP': addr || `203.0.113.${ip++}` };
  if (origin) headers.Origin = origin;
  return new Request(URL_, { method: 'POST', headers, body: typeof body === 'string' ? body : J(body) });
}
const good = { type: 'bug', title: '[Bug] Clicking a repeater does nothing', body: '**What happened**\nNothing opens.' };
async function read(res) { return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }; }

const github = () => calls.filter(c => c.url.includes('api.github.com'));
const resend = () => calls.filter(c => c.url.includes('api.resend.com'));

// ── Where the route is ────────────────────────────────────────────────────────
check('the route is /api/report and nothing near it', isReportPath('/api/report') && !isReportPath('/api/report/x') && !isReportPath('/api/reports'));
{
  const res = await worker.fetch(new Request(URL_), { PHOTOS: bucket() }, {});
  const r = await read(res);
  check('the Worker sends /api/report to it', r.status === 200 && r.body && r.body.ready === false && r.body.reason === 'unconfigured', J(r.body));
}

// ── Nowhere to send it ────────────────────────────────────────────────────────
{
  const env = { PHOTOS: bucket() };
  const g = await read(await handleReport(new Request(URL_), env));
  check('with no secret set, GET says not ready, unconfigured — the dialog keeps to GitHub\'s page', g.status === 200 && g.body.ready === false && g.body.reason === 'unconfigured', J(g.body));
  const p = await read(await handleReport(post(good), env));
  check('… and POST answers 503 {unconfigured}, sending nothing and counting nothing', p.status === 503 && p.body.unconfigured === true && calls.length === 0 && env.PHOTOS.m.size === 0, J(p.body));
  const e = await read(await handleReport(new Request(URL_), { PHOTOS: bucket(), RESEND_API_KEY: 're_x', REPORT_EMAIL_TO: 'not an address' }));
  check('a Resend key with no usable address to send to is not a destination', e.body.ready === false && J(e.body.to) === '[]', J(e.body));
}

// ── Who may send ──────────────────────────────────────────────────────────────
const ENV = () => ({ GITHUB_ISSUES_TOKEN: 'github_pat_x', PHOTOS: bucket() });
{
  const env = ENV();
  const g = await read(await handleReport(new Request(URL_), env));
  check('with a token and the bucket, GET says ready, to GitHub', g.body.ready === true && J(g.body.to) === '["github"]', J(g.body));
  const pre = await handleReport(new Request(URL_, { method: 'OPTIONS', headers: { Origin: 'https://cdomotor-g.github.io' } }), env);
  check('the github.io copy\'s preflight is allowed: POST, Content-Type, its own origin named',
    pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === 'https://cdomotor-g.github.io'
      && /POST/.test(pre.headers.get('Access-Control-Allow-Methods')) && /Content-Type/i.test(pre.headers.get('Access-Control-Allow-Headers')));
  const preBad = await handleReport(new Request(URL_, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  check('another site\'s preflight is refused, with no CORS header', preBad.status === 403 && !preBad.headers.get('Access-Control-Allow-Origin'));
  const gx = await handleReport(new Request(URL_, { headers: { Origin: 'https://evil.example' } }), env);
  check('a GET from another site is answered with no CORS header, so its page cannot read it', !gx.headers.get('Access-Control-Allow-Origin'));
  const none = await read(await handleReport(post(good, { origin: null }), env));
  const evil = await read(await handleReport(post(good, { origin: 'https://evil.example' }), env));
  check('a POST with no Origin, or another site\'s, is refused — and nothing is sent', none.status === 403 && evil.status === 403 && github().length === 0, J({ none, evil }));
  const plain = await read(await handleReport(post(J(good), { type: 'text/plain' }), env));
  check('a POST that is not JSON is refused (415): from a page elsewhere it could skip the preflight', plain.status === 415);
  const put = await read(await handleReport(new Request(URL_, { method: 'PUT', headers: { Origin: ORIGIN } }), env));
  check('any other method is 405', put.status === 405);
}

// ── What a report may be ──────────────────────────────────────────────────────
{
  const env = ENV();
  const bad = [
    [{ ...good, type: 'spam' }, 'an unknown kind'],
    [{ ...good, type: 'toString' }, 'a kind that is only a property of every object'],
    [{ ...good, body: '   ' }, 'an empty body'],
    [{ ...good, title: '' }, 'an empty title'],
    [{ ...good, title: { x: 1 } }, 'a title that is not text'],
    ['not json', 'a body that is not JSON'],
  ];
  for (const [b, what] of bad) {
    const r = await read(await handleReport(post(b), env));
    check(`refused (400): ${what}`, r.status === 400 && r.body.error, J(r.body));
  }
  check('… and none of them reached GitHub or took a place in the day', github().length === 0 && env.PHOTOS.m.size === 0);
  const big = await read(await handleReport(post({ ...good, body: 'x'.repeat(MAX.request + 10) }), env));
  check(`a request over ${MAX.request / 1024} KB is refused (413)`, big.status === 413, J(big.body));

  const s = shape({ type: 'enhancement', title: `  ${'t'.repeat(400)}\n\n second line `, body: '```\n' + 'y'.repeat(MAX.body + 50) });
  check('a title is one line, cut at 256 — GitHub\'s own limit', s.title.length === MAX.title && !/\n/.test(s.title));
  check(`a body is cut at ${MAX.body.toLocaleString('en-AU')} characters and says so, its open code block closed`,
    s.mail.length < MAX.body + 100 && /cut at 60,000 characters/.test(s.mail) && (s.mail.match(/```/g) || []).length % 2 === 0, s.mail.slice(-80));
  check('an enhancement is filed under GitHub\'s enhancement label', s.label === 'enhancement');
}

// ── Reach ─────────────────────────────────────────────────────────────────────
{
  const d = defuse('Ping @octocat and (@someone), see other/repo#12 and #34; mail a@b.com.\n```\nat f@https://x/y.js:1\n@inside other/repo#9\n```\nend');
  check('outside code an @mention is broken with a word joiner, so GitHub notifies nobody',
    d.includes('@⁠octocat') && d.includes('(@⁠someone)'), J(d));
  check('… and so is another repository\'s owner/repo#12, which would write into its timeline', d.includes('other/repo#⁠12'), J(d));
  check('… while this repository\'s #34, an email address and a code block are left exactly as they were',
    d.includes(' #34;') && d.includes('a@b.com') && d.includes('```\nat f@https://x/y.js:1\n@inside other/repo#9\n```'), J(d));
}
{
  const d = defuse('stray `@victim and https://github.com/other/repo/issues/7 and `@a` end');
  check('an @mention after a lone backtick, and another repository\'s issue URL, are defused too',
    d.includes('`@⁠victim') && d.includes('/issues/⁠7'), J(d));
}
{
  const chunks = [new Uint8Array(MAX.request), new Uint8Array(10)];
  const req = new Request(URL_, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: new ReadableStream({ pull(c) { const v = chunks.shift(); v ? c.enqueue(v) : c.close(); } }), duplex: 'half' });
  const res = await handleReport(req, ENV(), { waitUntil() {} });
  check('a chunked body over the cap is refused with 413 without being read whole', res.status === 413, String(res.status));
}

// ── Filed ─────────────────────────────────────────────────────────────────────
{
  calls.length = 0;
  const env = ENV();
  const r = await read(await handleReport(post({ ...good, body: 'Asked @octocat about it.' }), env));
  const g = github()[0];
  check('a report is filed as an issue and the dialog gets its number and link',
    r.status === 201 && J(r.body.to) === '["github"]' && r.body.number === 100 && r.body.url === 'https://github.com/cdomotor-g/MegaNet/issues/100', J(r.body));
  check('… with this origin named for the dialog to read it', r.headers.get('Access-Control-Allow-Origin') === ORIGIN);
  check('… posted to cdomotor-g/MegaNet with the token, GitHub\'s API version and a User-Agent (GitHub refuses one without)',
    g && g.method === 'POST' && g.headers.authorization === 'Bearer github_pat_x' && g.headers['x-github-api-version'] === '2022-11-28' && /Flood-Net/.test(g.headers['user-agent'] || ''), J(g && g.headers));
  check('… its title as sent, labelled bug, the mention defused and a line saying it came from the app',
    g && g.body.title === good.title && J(g.body.labels) === '["bug"]' && g.body.body.includes('@⁠octocat') && /Sent straight from the app/.test(g.body.body), J(g && g.body));
  check('… and the day\'s count is one', env.PHOTOS.m.get(dayKey()) === '1', J([...env.PHOTOS.m]));
  check('… keyed by the UTC day under _meganet/, which no photo path reaches', /^_meganet\/reports\/\d{4}-\d{2}-\d{2}$/.test(dayKey()));
}

// ── Brakes ────────────────────────────────────────────────────────────────────
{
  const env = ENV();
  const addr = '198.51.100.7';
  const seq = [];
  for (let i = 0; i < REPORT_RATE.limit + 1; i++) seq.push(await read(await handleReport(post(good, { addr }), env)));
  const last = seq[seq.length - 1];
  check(`${REPORT_RATE.limit} a minute from one address, then 429 with Retry-After — without the binding, the isolate's window`,
    seq.slice(0, -1).every(x => x.status === 201) && last.status === 429 && !last.body.ceiling && last.headers.get('Retry-After') === String(REPORT_RATE.period), J(seq.map(x => x.status)));
  const other = await read(await handleReport(post(good, { addr: '198.51.100.8' }), env));
  check('… while another address is not held up by it', other.status === 201);

  const asked = [];
  const bound = { ...ENV(), REPORT_RATE_LIMIT: { limit: async o => { asked.push(o.key); return { success: false }; } } };
  const held = await read(await handleReport(post(good, { addr }), bound));
  check('with the binding, it decides — keyed by a hash, not the address itself',
    held.status === 429 && asked.length === 1 && /^[0-9a-f]{32}$/.test(asked[0]) && !asked[0].includes('198'), J(asked));

  calls.length = 0;
  const full = ENV();
  full.PHOTOS.m.set(dayKey(), String(DAY_MAX));
  const g = await read(await handleReport(new Request(URL_), full));
  check(`after ${DAY_MAX} in the UTC day, GET says not ready (ceiling) — the dialog offers GitHub's page`, g.body.ready === false && g.body.reason === 'ceiling', J(g.body));
  const p = await read(await handleReport(post(good), full));
  check('… and POST answers 429 {ceiling} with nothing sent', p.status === 429 && p.body.ceiling === true && github().length === 0, J(p.body));
  const yesterday = ENV();
  yesterday.PHOTOS.m.set(dayKey(Date.now() - 86400000), String(DAY_MAX));
  check('… while yesterday\'s count is not today\'s', (await read(await handleReport(new Request(URL_), yesterday))).body.ready === true);

  const unbound = { GITHUB_ISSUES_TOKEN: 'x' };
  const ug = await read(await handleReport(new Request(URL_), unbound));
  const up = await read(await handleReport(post(good), unbound));
  check('with no bucket to count in, it does not file at all', ug.body.ready === false && ug.body.reason === 'uncounted' && up.status === 503 && up.body.uncounted === true, J({ ug: ug.body, up: up.body }));
  const broken = { GITHUB_ISSUES_TOKEN: 'x', PHOTOS: { get: async () => { throw new Error('R2 down'); }, put: async () => {} } };
  const bp = await read(await handleReport(post(good), broken));
  check('… nor when the bucket cannot be read', bp.status === 503 && bp.body.uncounted === true && github().length === 0, J(bp.body));

  calls.length = 0;
  githubStatus = 401;
  const failing = ENV();
  const f = await read(await handleReport(post(good), failing));
  check('GitHub refusing is a 502 saying so, and the day\'s place stays taken', f.status === 502 && /GitHub answered HTTP 401/.test(f.body.error) && failing.PHOTOS.m.get(dayKey()) === '1', J(f.body));
  githubStatus = 201;
}

// ── Email ─────────────────────────────────────────────────────────────────────
{
  calls.length = 0;
  const env = { ...ENV(), RESEND_API_KEY: 're_key', REPORT_EMAIL_TO: 'team@example.com, second@example.com' };
  const g = await read(await handleReport(new Request(URL_), env));
  check('with a Resend key and an address too, GET says both', J(g.body.to) === '["github","email"]', J(g.body));
  const r = await read(await handleReport(post({ ...good, body: 'Asked @octocat.' }), env));
  const m = resend()[0];
  check('a report is filed and emailed', r.status === 201 && J(r.body.to) === '["github","email"]' && r.body.number, J(r.body));
  check('… from Flood-Net\'s sender, to each address, with the key',
    m && m.body.from === 'Flood-Net <noreply@floodwarning.net>' && J(m.body.to) === '["team@example.com","second@example.com"]' && m.headers.authorization === 'Bearer re_key', J(m && m.body));
  check('… naming the issue it became, and the report as typed — the mail is private, so nothing defused',
    m && m.body.text.includes(r.body.url) && m.body.text.includes('Asked @octocat.') && m.body.subject === `Flood-Net report: ${good.title}`, J(m && m.body));

  calls.length = 0;
  githubStatus = 500;
  const r2 = await read(await handleReport(post(good), env));
  check('GitHub failing while the email goes is still a 201, to email alone', r2.status === 201 && J(r2.body.to) === '["email"]' && !r2.body.url, J(r2.body));
  githubStatus = 201;

  calls.length = 0;
  const only = { PHOTOS: bucket(), RESEND_API_KEY: 're_key', REPORT_EMAIL_TO: 'team@example.com' };
  const r3 = await read(await handleReport(post(good), only));
  check('email alone, with no token: emailed, GitHub never asked', r3.status === 201 && J(r3.body.to) === '["email"]' && github().length === 0, J(r3.body));
  resendStatus = 422;
  const r4 = await read(await handleReport(post(good), only));
  check('Resend refusing when it is the only way is a 502 saying so', r4.status === 502 && /Resend answered HTTP 422/.test(r4.body.error), J(r4.body));
  resendStatus = 200;
}

// ── Report ────────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.what}${r.ok || !r.detail ? '' : ` — ${String(r.detail).slice(0, 300)}`}`);
console.log(failed.length ? `\nFAIL — ${failed.length} of ${results.length}.` : `\nPASS — ${results.length} checks: a report goes where the secrets say, from Flood-Net's own pages, a few a minute and ${DAY_MAX} a day, and reaches nobody else on GitHub.`);
process.exitCode = failed.length ? 1 : 0;
