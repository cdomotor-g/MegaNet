// worker/changelog.js — the agent API's list of changes, as data.
//
// docs/api-changelog.json is one entry per change somebody using the API would
// notice — a route, a field, a limit, a tool — newest first. CLAUDE.md asks for
// an entry in the same push as the change, because the entry is what tells
// people: GET /api/v1/changelog serves the list (worker/api.js), and the notify
// list (worker/notify.js) emails each new entry to everybody who asked.
//
// Read through the Worker's static-assets binding, like the ACMA register and
// the camera catalog: the file is public and deploys with the Worker, so the
// list a deploy brings is the list the next run of the notify list sees.

export const CHANGELOG_PATH = '/docs/api-changelog.json';

const ID_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX = Object.freeze({ title: 120, summary: 1200, links: 6, linkText: 80 });

// The entries the file holds that are well formed, newest first by date (the
// file's own order kept within a day). Problems are listed, not thrown: the
// check (test/api-notify.mjs) fails on any, the Worker skips the entry.
export function parseChangelog(body) {
  const problems = [];
  const raw = body && Array.isArray(body.entries) ? body.entries : null;
  if (!raw) return { entries: [], problems: ['the file has no entries list'] };
  const seen = new Set();
  const entries = [];
  raw.forEach((e, i) => {
    const at = `entry ${i + 1}${e && e.id ? ` (${e.id})` : ''}`;
    if (!e || typeof e !== 'object') { problems.push(`${at} is not an object`); return; }
    const bad = [];
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) bad.push('an id of lowercase letters, digits and hyphens');
    else if (seen.has(e.id)) bad.push('an id of its own');
    if (typeof e.date !== 'string' || !DATE_RE.test(e.date) || !Number.isFinite(Date.parse(`${e.date}T00:00:00Z`))) bad.push('a date, YYYY-MM-DD');
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > MAX.title || /[\r\n]/.test(e.title)) bad.push(`a title of one line, ${MAX.title} characters at most`);
    if (typeof e.summary !== 'string' || !e.summary.trim() || e.summary.length > MAX.summary) bad.push(`a summary, ${MAX.summary} characters at most`);
    if (typeof e.breaking !== 'boolean') bad.push('breaking, true or false');
    const links = Array.isArray(e.links) ? e.links : [];
    if (links.length > MAX.links || !links.every(l => l && typeof l.text === 'string' && l.text.trim() && l.text.length <= MAX.linkText
      && typeof l.url === 'string' && /^https:\/\/[^\s]+$/.test(l.url))) bad.push(`links, up to ${MAX.links}, each {text, url} with an https url`);
    if (bad.length) { problems.push(`${at} needs ${bad.join('; ')}`); return; }
    seen.add(e.id);
    entries.push({ id: e.id, date: e.date, title: e.title.trim(), summary: e.summary.trim(), breaking: e.breaking,
      links: links.map(l => ({ text: l.text.trim(), url: l.url })) });
  });
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].date > entries[i - 1].date) problems.push(`${entries[i].id} is newer than the entry above it: newest first`);
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { entries, problems };
}

// Settled values only (worker/api.js's rule), and for five minutes: a deploy
// starts new isolates anyway, so this only saves the read within one.
let HELD = null;
const HOLD_MS = 5 * 60 * 1000;

export async function readChangelog(env, origin, now = Date.now()) {
  if (HELD && now - HELD.at < HOLD_MS) return HELD.value;
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    throw Object.assign(new Error('the static assets binding (ASSETS) is not set'), { unbound: true });
  }
  const res = await env.ASSETS.fetch(new Request(`${origin}${CHANGELOG_PATH}`, { method: 'GET' }));
  if (!res.ok) throw new Error(`the API changelog (${CHANGELOG_PATH}) answered HTTP ${res.status}`);
  const value = parseChangelog(await res.json());
  HELD = { at: now, value };
  return value;
}

export function resetChangelog() { HELD = null; }

// The entries after `marker` (an id), newest first. A marker the list no
// longer has falls back to the entries dated on or after `sinceDay`.
export function entriesAfter(entries, marker, sinceDay) {
  const i = marker ? entries.findIndex(e => e.id === marker) : -1;
  if (i >= 0) return entries.slice(0, i);
  return sinceDay ? entries.filter(e => e.date >= sinceDay) : entries.slice();
}
