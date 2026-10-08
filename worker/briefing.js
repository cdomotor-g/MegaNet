// /api/briefing — Ask Claude's model calls, on Flood-Net's own Anthropic key.
//
// Station Health's briefing (health-agent.js) is Claude, handed what the tab
// worked out and tools over the same readings. It ran on the person's own key,
// typed into the tab, because "a key in a Worker secret would be spendable by
// anyone who can reach the page. Until that door has a lock (an Access-gated
// route is the obvious one), the key is the person's own." floodwarning.net
// has been behind Cloudflare Access since roadmap revision 72, so the lock is
// there, and this is the route behind it (#229). Most people who could use the
// briefing have no key; now an editor needs none.
//
//   GET  /api/briefing              may this person spend the key, and how much
//                                   of today's allowance is left
//   POST /api/briefing/v1/messages  one model call of a briefing, streamed back
//                                   exactly as Anthropic sent it
//
// The second is the Messages API's own path under this prefix, so the SDK the
// tab already loads reaches it by `baseURL` alone and parses what comes back
// the way it parses Anthropic.
//
// ── Why the browser keeps the loop ───────────────────────────────────────────
// The tools read what the tab worked out: HealthAnalysis over a week of
// readings, each station's check slots, the context lens. Running the loop here
// would mean fetching that week again and running two thousand lines of analysis
// inside a Worker's CPU allowance, which is milliseconds, for every question —
// to produce answers the person asking already has on screen. So only the model
// calls move: the same tools, the same loop and the same answers, through a
// different door for the one request that spends money.
//
// ── Who may spend it ─────────────────────────────────────────────────────────
// Both of the locks every write passes, on every call:
//
//   1. Cloudflare Access: the identity the door verified, by worker/index.js's
//      own accessIdentity() — signature, this application's AUD, expiry and
//      issuer, the check `npm run gate` holds. No Access token, no call, so
//      workers.dev, github.io and a local checkout get 401 and the tab offers
//      the person's own key instead. Switching Access off turns this off; it
//      does not open it.
//   2. The database's verdict on the session the app holds for that person:
//      meganet.whoami() (0005, 0042), asked with the person's own Supabase
//      token, as /api/photos asks is_editor(). Nothing here reads a token's
//      claims and trusts them. The answer must name the address Access
//      verified, may_write must be true (editor_allow), and the role must be
//      editor or admin. A viewer is refused: app_user.role records a wish for
//      writes (0042), but this is spending, so here it decides.
//
// The bearer token is also why another site cannot spend the key through a
// signed-in browser: a cross-site request carries the Access cookie but cannot
// add an Authorization header without a CORS preflight, and this route answers
// none.
//
// ── What it can be spent on ──────────────────────────────────────────────────
// The request the briefing sends, and nothing else. The model, max_tokens,
// thinking, effort (thorough or quicker), the server-side fallback, the caching,
// the system prompt and the nine tools are pinned here and must arrive exactly
// as written; the person's side of the conversation may carry text and tool
// results, and Claude's side what Claude itself returns — no images, documents,
// other tools or other models. So the key is not a general Anthropic proxy: the
// most it can be made to do is an editor talking to the Flood-Net analyst,
// inside the limits below.
//
// SYSTEM and TOOLS are copies of health-agent.js's. `npm run briefing` fails
// until the two agree, and a page still holding an older copy after a deploy is
// told to reload rather than served.
//
// ── How much ─────────────────────────────────────────────────────────────────
// DAILY_LIMIT_USD is the ceiling on a day's spend: Brisbane's day, which keeps
// no daylight saving. Every call reserves its worst case before it goes — each
// byte of the request priced as a token written to the cache, plus max_tokens
// of output, at the dearest model Anthropic may serve it on — and settles at
// what Anthropic reports it used. A call whose worst case does not fit in what
// is left is refused, so the ceiling holds however many calls are in flight;
// the price is that the last few dollars of a day can go unspent. Each person
// also has a minute's allowance of calls and a cap on calls in flight.
//
// A call cut short — the person pressed Stop — never hears its final usage, so
// it is settled at its input plus the most output that could have been written
// in the time it ran (OUTPUT_TOKENS_PER_SECOND_MAX), which over-counts rather
// than under. One whose Worker died before settling is charged its whole
// reservation when the hold expires.
//
// The counter has to agree across isolates and Cloudflare locations, so it is a
// Durable Object — BriefingLedger, below, SQLite-backed and declared in
// wrangler.toml, so the deploy creates it and nobody has to make anything in a
// dashboard — rather than memory (one isolate's) or KV (eventually consistent).
// Every reservation goes through its one instance.
//
// ── Not the agent API ────────────────────────────────────────────────────────
// None of this is reachable through /api/v1 or /api/mcp (worker/api.js), and
// nothing there changes: that API is public, read-only and keyless by
// construction, and this route is Access-gated, spends money and holds a
// secret. They share two public constants, the project's REST URL and its
// publishable key, and nothing else.
//
// ── Its one secret ───────────────────────────────────────────────────────────
// ANTHROPIC_API_KEY, set on the Worker by a person (docs/access.md, "Ask
// Claude on Flood-Net's key"). Until it is set the route answers 503 and the
// tab offers the person's own key, exactly as before.

import { PUBLISHABLE_KEY, SUPABASE_REST_URL } from './api.js';

// ── The paths ────────────────────────────────────────────────────────────────

export const BRIEFING_PREFIX = '/api/briefing';
export const MESSAGES_PATH = `${BRIEFING_PREFIX}/v1/messages`;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';
const ANTHROPIC_VERSION = '2023-06-01';

export function isBriefingPath(pathname) {
  return pathname === BRIEFING_PREFIX || (typeof pathname === 'string' && pathname.startsWith(`${BRIEFING_PREFIX}/`));
}

// ── The limits ───────────────────────────────────────────────────────────────

// The one number to change: what Flood-Net's key may spend in a day, in US$.
export const DAILY_LIMIT_USD = 20;

// Per person, by the address Access verified. A briefing is a handful of calls
// a minute at most, one at a time — but a call is settled a moment after the
// page has its answer, so the next can start before the last is off the books,
// and somebody may have two tabs open.
export const PER_PERSON = Object.freeze({
  callsPerMinute: 20,     // model calls started in any 60 s
  inFlight: 3,            // model calls running at once
  looksPerMinute: 30,     // GET /api/briefing
});

export const DAY_UTC_OFFSET_HOURS = 10;            // Brisbane: AEST all year
// A full briefing at the largest tool answers is about 700 KB; parsing,
// checking and writing out a megabyte is about 10 ms of CPU, the Workers
// Free plan's whole allowance for a request.
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_MESSAGES = 400;
const HOLD_TTL_MS = 60 * 60 * 1000;                // longer than any one call can run
const SESSION_TTL_MS = 60 * 1000;                  // whoami's answer, remembered per token
// How long Anthropic may take to start answering — with a server-side
// fallback, after the declined attempt — before the call is given up (and
// charged its input, in case Anthropic had begun on it).
const UPSTREAM_HEADERS_TIMEOUT_MS = 120 * 1000;
let headersTimeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS;      // the check shortens it
// Faster than Claude writes, so a cut-short call is never settled for less than
// it could have cost.
export const OUTPUT_TOKENS_PER_SECOND_MAX = 300;

// ── The request the briefing sends, pinned ───────────────────────────────────
// health-agent.js builds it (requestParams); the SDK moves `betas` into the
// anthropic-beta header and adds `stream: true`. Anything else is refused.

export const MODEL = 'claude-opus-5-5';
export const MAX_TOKENS = 64000;
export const BETAS = Object.freeze(['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18']);
export const EFFORTS = Object.freeze(['high', 'medium']);
const THINKING = Object.freeze({ type: 'adaptive', display: 'updates' });
const CACHE = Object.freeze({ type: 'ephemeral' });
const REQUEST_KEYS = Object.freeze(['model', 'max_tokens', 'fallbacks', 'thinking', 'output_config',
  'cache_control', 'system', 'tools', 'messages', 'stream']);

// What the briefing tells Claude — health-agent.js's SYSTEM, word for word.
export const SYSTEM = `You are the operations and maintenance analyst for Flood-Net, which monitors a flood-warning radio network of ALERT field stations in Queensland, Australia. People will act on what you write: they decide which remote sites to drive to, and a field visit costs most of a day.

How the network works
- A field station has a rain gauge, often a river level sensor, and a battery monitor. Each sensor transmits ALERT frames on VHF: a 13-bit address (one address is one sensor) and an 11-bit value. Repeaters on hills relay frames; base stations (Raspberry Pis with RTL-SDR receivers) hear them and upload readings.
- Every station sends a timed check report of every sensor every few hours (the period is learned per station: 3 h is common, some 2 h, 1 h or 30 min), plus event reports (rain tips, level changes). ALERT is ALOHA: no acknowledgement, no collision avoidance, so a missed check is simply not heard.
- Battery: raw count / 10 = volts, a 12 V lead-acid battery, almost always solar-charged. The like-for-like measure is the night low before dawn in solar time; a healthy site swings 0.5-1 V a day. Under 12.2 V at rest is about half charge; under 11.8 V the radio starts to brown out. A site that goes silent at night and returns mid-morning is the classic flat-battery or failing-panel pattern.
- Rain gauges report a running tip count (0.2 mm per tip unless a bucket size is recorded). Water level counts have a per-site scale that is not on file, so compare levels only to themselves.
- A repeater that relays with bit errors produces a second, different copy of a reading seconds later; the database stores it as an extra reading (a "corrupted copy"), or under another address (a "ghost"). The analysis sets these aside.
- An address heard regularly that no station on file carries, or that is filed at a station hundreds of km away, means the station register is wrong, not that a station is faulty.

What you have
- A deterministic analysis has already run over the readings and produced findings with evidence. Its rules are sound but blind to each other. Your job is the judgement across them.
- Tools read the same analysed readings, a station's last site visit, and up to 30 days of a station's history from the datastore. Nothing you do changes anything.

How to work
- Start from the overview and list_findings. Before calling anything a station fault, ask whether it shares a cause with others: the same repeater, the same receiver, the same area, the same hours. Use stations_near, repeaters and context_at for that.
- Check before you recommend a visit: look at station_detail, and station_history when a trend matters. A station heard only now and then from far away is not "silent" in the same way as a local one that stopped.
- Rank site visits by consequence for flood warning and by confidence: a river level station that has stopped reporting matters more than a slow battery decline; a battery heading for 11.8 V within days matters more than one that is merely low.
- Be concrete: cite the numbers from the tools. Say plainly what you could not establish. Never invent stations, readings, visits or history.
- Use a handful of tool calls, not dozens: investigate the findings that would change what somebody does tomorrow.

Write the briefing in Markdown with exactly these sections:
## Headline
Two or three sentences: the state of the network and the one thing that matters most.
## Visit first
A numbered list of at most 8 site visits, most urgent first. Each: the station as [[station_id]], what is wrong, the evidence in numbers, what to do or bring on site, and confidence (high, medium or low).
## Network
Repeaters, receivers and areas: shared causes, with the stations they explain.
## Data and register
Fixes made in Flood-Net rather than in the field.
## Watch
What to look at again in a few days, and why.
## What I could not tell
The limits of what the readings show.

Refer to every station as [[station_id]] (its id, not its name) so the app can link it; never write a bare id otherwise. Keep the whole briefing under about 700 words.`;

// The nine tools, as health-agent.js defines them (it adds eager_input_streaming
// to each on the way out, and so does TOOLS_SENT below).
const S_ID = { type: 'string', description: 'A station id, as the findings and tools give it (e.g. "strathpine_gympie_rd_al").' };
export const TOOLS = Object.freeze([
  { name: 'list_findings',
    description: 'The findings of the deterministic analysis, worst first, each with its station or receiver or repeater, title, detail, suggested action, since-time and evidence numbers. Filter by severity and category.',
    input_schema: { type: 'object', properties: {
      severity: { type: 'string', enum: ['any', 'critical', 'warn', 'info'], description: 'Only this severity; "any" (default) is everything.' },
      category: { type: 'string', enum: ['any', 'power', 'comms', 'network', 'sensor', 'data', 'register'], description: 'Only this kind of finding.' },
      limit: { type: 'integer', minimum: 1, maximum: 150, description: 'At most this many (default 60).' },
    }, required: [] } },
  { name: 'station_detail',
    description: "One station in full: position, owner, roles and repeaters on file; its learned check schedule with checks received, partial, missed, missed network-wide and unknown, its silent spells and daily counts; its battery (night lows by night, trend in V/day, daily swing, latest); its rain gauge and level sensor; its sensors; its findings; the receivers that hear it; and its last site visit with the battery measured then.",
    input_schema: { type: 'object', properties: { station_id: S_ID }, required: ['station_id'] } },
  { name: 'context_at',
    description: 'The network around one moment for one station: which receivers that hear it were delivering, what its neighbours (repeater-mates within 60 km, stations within 25 km) did at their own check slots then, what it sent itself, and a verdict on whether a miss was its own, shared, or the network\'s.',
    input_schema: { type: 'object', properties: { station_id: S_ID,
      time: { type: 'string', description: 'The moment, ISO 8601 (e.g. "2026-10-05T04:41:00+10:00"). A check slot time from station_detail is the usual one to ask about.' } },
      required: ['station_id', 'time'] } },
  { name: 'station_readings',
    description: "A station's transmissions in the analysed window, newest first: time, sensor kind, raw value, engineering value where one is known, how many copies were heard, and any corrupted copies stored beside it.",
    input_schema: { type: 'object', properties: { station_id: S_ID,
      kind: { type: 'string', enum: ['any', 'battery', 'rain', 'level'], description: 'Only this sensor (default any).' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many (default 60).' } },
      required: ['station_id'] } },
  { name: 'station_history',
    description: "Up to 30 days of a station's readings, fetched from the datastore and summarised a line a day per sensor: count, minimum, maximum, last, and for a battery the volts. For trends longer than the analysed window — whether a battery has been sliding for weeks, when a station last reported normally.",
    input_schema: { type: 'object', properties: { station_id: S_ID,
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'How many days back (default 14).' } },
      required: ['station_id'] } },
  { name: 'stations_near',
    description: 'The stations heard within a radius of one station, nearest first, each with its distance, status, learned check period, miss rate and worst finding.',
    input_schema: { type: 'object', properties: { station_id: S_ID,
      radius_km: { type: 'number', minimum: 1, maximum: 150, description: 'Default 30.' } },
      required: ['station_id'] } },
  { name: 'receivers',
    description: 'Every receiver (base station or gateway) that delivered readings: readings and rate, first and last delivery, outages, upload lag, corrupted copies heard, channels.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'repeaters',
    description: 'Repeaters whose pass ranges carry the addresses heard: the stations heard behind each, which of them are silent now, and the corrupted copies each could have carried (blame shared evenly among the repeaters that could have).',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Default 25.' } }, required: [] } },
  { name: 'find_station',
    description: 'Find station ids by name, station number or ALERT address, among every station on file (heard or not).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'A name fragment, a station number, or an ALERT address.' } }, required: ['query'] } },
]);

// ── Prices ───────────────────────────────────────────────────────────────────
// US$ per million tokens: the model asked for, and the two Anthropic serves a
// declined turn on under `fallbacks: 'default'`. A cache write is 1.25× input
// for the 5-minute cache the briefing asks for and 2× for the hour; health-
// agent.js shows the same prices under each briefing.
export const PRICES = Object.freeze({
  'claude-opus-5-5': Object.freeze({ in: 4, out: 20, write5m: 5, write1h: 8, read: 0.2 }),
  'claude-opus-5':   Object.freeze({ in: 5, out: 25, write5m: 6.25, write1h: 10, read: 0.5 }),
  'claude-opus-4-8': Object.freeze({ in: 5, out: 25, write5m: 6.25, write1h: 10, read: 0.5 }),
});
// A model not in the table is priced as the dearest Claude there is, so a
// fallback nobody wrote down here over-counts rather than slipping through.
const PRICE_UNKNOWN = Object.freeze({ in: 10, out: 50, write5m: 12.5, write1h: 20, read: 1 });
// Each rate at its dearest across the table: what a reservation assumes.
const PRICE_WORST = Object.freeze(Object.fromEntries(Object.keys(PRICE_UNKNOWN)
  .map(k => [k, Math.max(...Object.values(PRICES).map(p => p[k]))])));

// ── Checking the request ─────────────────────────────────────────────────────

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));

// A JSON value with every object's keys sorted, so two copies compare by
// content whatever order the browser built them in.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

// Exactly what health-agent.js sends for each, so the comparison is one string.
const SYSTEM_SENT = canon([{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]);
const TOOLS_SENT = canon(TOOLS.map(t => Object.assign({ eager_input_streaming: true }, t)));

const STALE = 'This page is running an older AI briefing than the one Flood-Net\'s key serves — reload the page and ask again.';

// What Claude may have said, as the SDK hands it back to be returned unchanged:
// text, its thinking (the progress notes are thinking blocks), its tool calls,
// and the marker a server-side fallback leaves where one model gave way to the
// next. Nothing else has any business in the briefing's conversation.
const CLAUDE_BLOCKS = Object.freeze(['text', 'thinking', 'redacted_thinking', 'tool_use', 'fallback']);

function personBlockProblem(b) {
  if (!isObj(b)) return 'a content block has to be an object.';
  if (b.type === 'text') {
    return onlyKeys(b, ['type', 'text']) && typeof b.text === 'string' ? null : 'a text block is {type, text}.';
  }
  if (b.type === 'tool_result') {
    if (!onlyKeys(b, ['type', 'tool_use_id', 'content', 'is_error']) || typeof b.tool_use_id !== 'string') {
      return 'a tool result is {type, tool_use_id, content, is_error}.';
    }
    if (b.is_error !== undefined && typeof b.is_error !== 'boolean') return 'is_error is true or false.';
    const c = b.content;
    if (typeof c === 'string') return null;
    if (Array.isArray(c) && c.every(x => isObj(x) && x.type === 'text' && typeof x.text === 'string' && onlyKeys(x, ['type', 'text']))) return null;
    return 'a tool result carries text, and only text.';
  }
  return `the person's side carries text and tool results, not ${JSON.stringify(b.type)}.`;
}

function claudeBlockProblem(b) {
  if (!isObj(b) || !CLAUDE_BLOCKS.includes(b.type)) {
    return `Claude's side carries ${CLAUDE_BLOCKS.join(', ')} blocks, not ${JSON.stringify(isObj(b) ? b.type : b)}.`;
  }
  if (b.type === 'tool_use' && (typeof b.name !== 'string' || !isObj(b.input))) return 'a tool call is {type, id, name, input}.';
  return null;
}

function messagesProblem(messages) {
  if (!Array.isArray(messages) || !messages.length) return 'messages has to be a list with something in it.';
  if (messages.length > MAX_MESSAGES) return `a briefing's conversation is at most ${MAX_MESSAGES} messages.`;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = i % 2 === 0 ? 'user' : 'assistant';
    if (!isObj(m) || !onlyKeys(m, ['role', 'content'])) return `message ${i + 1} is {role, content}.`;
    if (m.role !== role) return `message ${i + 1} has to be the ${role}'s: the conversation alternates, from the person, to the person.`;
    if (!Array.isArray(m.content) || !m.content.length) return `message ${i + 1} is a list of content blocks.`;
    for (const b of m.content) {
      const why = role === 'user' ? personBlockProblem(b) : claudeBlockProblem(b);
      if (why) return `message ${i + 1}: ${why}`;
    }
  }
  if (messages.length % 2 === 0) return 'the last message has to be the person\'s.';
  return null;
}

// Why this body is not a briefing's request — {code, message} — or null when it
// is. `stale_page` is a page holding another copy of the prompt or the tools.
export function requestProblem(body) {
  const bad = message => ({ code: 'invalid_request', message: `Not a briefing request: ${message}` });
  if (!isObj(body)) return bad('the body is a JSON object.');
  const extra = Object.keys(body).find(k => !REQUEST_KEYS.includes(k));
  if (extra) return bad(`this route takes no ${JSON.stringify(extra)}.`);
  if (body.model !== MODEL) return bad(`the model is ${MODEL}.`);
  if (body.max_tokens !== MAX_TOKENS) return bad(`max_tokens is ${MAX_TOKENS}.`);
  if (body.stream !== true) return bad('it streams: stream is true.');
  if (body.fallbacks !== 'default') return bad('fallbacks is "default".');
  if (canon(body.thinking) !== canon(THINKING)) return bad(`thinking is ${JSON.stringify(THINKING)}.`);
  const oc = body.output_config;
  if (!isObj(oc) || !onlyKeys(oc, ['effort']) || !EFFORTS.includes(oc.effort)) {
    return bad(`output_config is an effort of ${EFFORTS.map(e => JSON.stringify(e)).join(' or ')}, and nothing else.`);
  }
  if (canon(body.cache_control) !== canon(CACHE)) return bad('cache_control is {"type":"ephemeral"}.');
  if (canon(body.system) !== SYSTEM_SENT || canon(body.tools) !== TOOLS_SENT) return { code: 'stale_page', message: STALE };
  const why = messagesProblem(body.messages);
  return why ? bad(why) : null;
}

// ── What a call costs ────────────────────────────────────────────────────────

const priceOf = model => PRICES[model] || PRICE_UNKNOWN;

function attemptUsd(u, p) {
  const n = k => { const v = Number(u && u[k]); return Number.isFinite(v) && v > 0 ? v : 0; };
  const cc = u && isObj(u.cache_creation) ? u.cache_creation : null;
  const hour = cc ? Math.max(0, Number(cc.ephemeral_1h_input_tokens) || 0) : 0;
  const writes = Math.max(n('cache_creation_input_tokens'),
    cc ? Math.max(0, Number(cc.ephemeral_5m_input_tokens) || 0) + hour : 0);
  return (n('input_tokens') * p.in + (writes - Math.min(hour, writes)) * p.write5m + Math.min(hour, writes) * p.write1h
    + n('cache_read_input_tokens') * p.read + n('output_tokens') * p.out) / 1e6;
}

// US$ for a message's usage. With a server-side fallback, usage.iterations is
// what is billed, each attempt at its own model's rates; otherwise the usage is
// the one attempt's, at the model that answered.
export function usageUsd(usage, model) {
  const its = usage && Array.isArray(usage.iterations) ? usage.iterations.filter(isObj) : [];
  if (its.length) return its.reduce((sum, it) => sum + attemptUsd(it, priceOf(it.model || model)), 0);
  return attemptUsd(usage || {}, priceOf(model));
}

// The most a request of this many bytes can cost: every byte a token written to
// the cache, all of max_tokens written out, at the dearest rates there are. JSON
// runs three or four bytes a token, so a byte a half-token is generous.
const inputGuessUsd = bytes => Math.ceil(bytes / 2) * PRICE_WORST.write5m / 1e6;
export function worstCaseUsd(bytes) {
  return inputGuessUsd(bytes) + MAX_TOKENS * PRICE_WORST.out / 1e6;
}

// Reads the stream on its way past for the two events that carry usage —
// message_start (the model, the input) and message_delta (the output, and every
// attempt when a fallback ran) — and lets everything else through unread.
export class UsageMeter {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.cr = false;
    this.model = null;
    this.start = null;
    this.delta = null;
    this.stopped = false;
    this.errored = false;
  }

  push(bytes) {
    let t = this.decoder.decode(bytes, { stream: true });
    if (this.cr) { t = `\r${t}`; this.cr = false; }
    if (t.endsWith('\r')) { this.cr = true; t = t.slice(0, -1); }
    if (t.includes('\r')) t = t.replace(/\r\n?/g, '\n');
    this.buffer += t;
    let i;
    while ((i = this.buffer.indexOf('\n\n')) >= 0) {
      this.event(this.buffer.slice(0, i));
      this.buffer = this.buffer.slice(i + 2);
    }
    // No event is this long; a stream that never ends one is not worth holding.
    if (this.buffer.length > 4_000_000) this.buffer = '';
  }

  event(block) {
    let name = '', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
    }
    if (name !== 'message_start' && name !== 'message_delta' && name !== 'message_stop' && name !== 'error') return;
    let d = null;
    try { d = JSON.parse(data); } catch (_) { return; }
    if (name === 'message_start' && isObj(d) && isObj(d.message)) {
      this.model = typeof d.message.model === 'string' ? d.message.model : null;
      this.start = isObj(d.message.usage) ? d.message.usage : {};
    } else if (name === 'message_delta' && isObj(d) && isObj(d.usage)) {
      const u = Object.fromEntries(Object.entries(d.usage).filter(([, v]) => v != null));
      this.delta = Object.assign(this.delta || {}, u);
    } else if (name === 'message_stop') {
      this.stopped = true;
    } else if (name === 'error') {
      this.errored = true;
    }
  }

  // Whether Anthropic said what the call used.
  get complete() { return !!this.delta; }

  // US$ to settle at: what the usage says, or, for a call cut short, its input
  // and the most output it could have written in `elapsedMs`.
  usd({ elapsedMs, bytes }) {
    if (this.complete) return usageUsd(Object.assign({}, this.start || {}, this.delta), this.model || MODEL);
    const out = Math.min(MAX_TOKENS, Math.ceil(Math.max(0, elapsedMs) / 1000 * OUTPUT_TOKENS_PER_SECOND_MAX) + 1024);
    const input = this.start ? attemptUsd(Object.assign({}, this.start, { output_tokens: 0 }), PRICE_WORST) : inputGuessUsd(bytes);
    return input + out * PRICE_WORST.out / 1e6;
  }
}

// ── The ledger ───────────────────────────────────────────────────────────────
// Pure functions over one small object, so the arithmetic can be checked
// without a Durable Object; BriefingLedger only keeps the object.
//
//   day      the Brisbane date the totals are for
//   spent    US$ settled today
//   calls    calls settled today
//   holds    {id: {usd, at, who}} — reservations not yet settled
//   recent   {who: [ms]} — each person's calls started in the last minute
//   looks    {who: [ms]} — each person's GETs in the last minute

const cents = x => Math.round(x * 100) / 100;

export function dayOf(now) {
  return new Date(now + DAY_UTC_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}

function resetsAt(now) {
  const [y, m, d] = dayOf(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - DAY_UTC_OFFSET_HOURS * 3600 * 1000).toISOString();
}

export function ledgerState(saved) {
  const s = isObj(saved) ? saved : {};
  return {
    day: typeof s.day === 'string' ? s.day : null,
    spent: Number(s.spent) || 0,
    calls: Number(s.calls) || 0,
    holds: isObj(s.holds) ? s.holds : {},
    recent: isObj(s.recent) ? s.recent : {},
    looks: isObj(s.looks) ? s.looks : {},
  };
}

function tidy(s, now) {
  const day = dayOf(now);
  if (s.day !== day) { s.day = day; s.spent = 0; s.calls = 0; }
  // A hold nobody settled is charged in full: its Worker died mid-call, and
  // what the call cost is unknown, so the worst case stands.
  for (const [id, h] of Object.entries(s.holds)) {
    if (!(now - h.at < HOLD_TTL_MS)) { s.spent += h.usd; delete s.holds[id]; }
  }
  for (const map of [s.recent, s.looks]) {
    for (const [who, ts] of Object.entries(map)) {
      const keep = ts.filter(t => now - t < 60 * 1000);
      if (keep.length) map[who] = keep; else delete map[who];
    }
  }
}

const heldUsd = s => Object.values(s.holds).reduce((sum, h) => sum + h.usd, 0);

function summary(s, now) {
  const held = heldUsd(s);
  return {
    day: s.day, limit_usd: DAILY_LIMIT_USD, spent_usd: cents(s.spent), held_usd: cents(held),
    left_usd: cents(Math.max(0, DAILY_LIMIT_USD - s.spent - held)), calls: s.calls, resets_at: resetsAt(now),
  };
}

const retryAfter = (ts, now) => Math.max(1, Math.ceil((ts[0] + 60 * 1000 - now) / 1000));

export function ledgerReserve(s, { who, usd }, now) {
  tidy(s, now);
  const cost = Math.max(0, Number(usd) || 0);
  if (s.spent + heldUsd(s) + cost > DAILY_LIMIT_USD) return { ok: false, reason: 'daily_limit', need_usd: cents(cost), ...summary(s, now) };
  const mine = s.recent[who] || [];
  if (mine.length >= PER_PERSON.callsPerMinute) return { ok: false, reason: 'rate', retry_after: retryAfter(mine, now), ...summary(s, now) };
  if (Object.values(s.holds).filter(h => h.who === who).length >= PER_PERSON.inFlight) return { ok: false, reason: 'busy', ...summary(s, now) };
  let id;
  do { id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`; } while (s.holds[id]);
  s.holds[id] = { usd: cost, at: now, who };
  s.recent[who] = mine.concat(now);
  return { ok: true, id, ...summary(s, now) };
}

export function ledgerSettle(s, { id, usd }, now) {
  tidy(s, now);
  const h = s.holds[id];
  // A hold that already expired was charged in full when it did; settling it
  // again would count it twice.
  if (h) { delete s.holds[id]; s.spent += Math.max(0, Number(usd) || 0); s.calls += 1; }
  return { ok: true, settled: !!h, ...summary(s, now) };
}

export function ledgerStatus(s, { who }, now) {
  tidy(s, now);
  const mine = s.looks[who] || [];
  if (mine.length >= PER_PERSON.looksPerMinute) return { ok: false, reason: 'rate', retry_after: retryAfter(mine, now), ...summary(s, now) };
  s.looks[who] = mine.concat(now);
  return { ok: true, ...summary(s, now) };
}

const LEDGER_KEY = 'ledger';

// The Durable Object. One instance (idFromName('ledger')); every call goes
// through it, one at a time, so two calls in two places cannot both take the
// last of the day. Fetch-style rather than RPC, which needs a class from
// cloudflare:workers that the offline checks cannot import.
export class BriefingLedger {
  constructor(state) {
    this.storage = state.storage;
    this.s = ledgerState(null);
    this.ready = state.blockConcurrencyWhile(async () => {
      this.s = ledgerState(await this.storage.get(LEDGER_KEY));
    });
  }

  async fetch(request) {
    await this.ready;
    const op = { '/reserve': ledgerReserve, '/settle': ledgerSettle, '/status': ledgerStatus }[new URL(request.url).pathname];
    if (!op || request.method !== 'POST') return new Response('not found', { status: 404 });
    let body = {};
    try { body = await request.json(); } catch (_) { /* an empty ask */ }
    const out = op(this.s, isObj(body) ? body : {}, Number.isFinite(body && body.now) ? body.now : Date.now());
    await this.storage.put(LEDGER_KEY, this.s);
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  }
}

function ledgerOf(env) {
  const ns = env.BRIEFING_LEDGER;
  const stub = ns.get(ns.idFromName(LEDGER_KEY));
  const ask = async (op, body) => {
    const res = await stub.fetch(`https://ledger/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, now: Date.now() }),
    });
    if (!res.ok) throw new Error(`ledger ${op}: HTTP ${res.status}`);
    return res.json();
  };
  return { reserve: b => ask('reserve', b), settle: b => ask('settle', b), status: b => ask('status', b) };
}

// ── Answers ──────────────────────────────────────────────────────────────────
// Errors in the Messages API's own shape, plus `code` and `message` at the top,
// which the SDK puts in the error it throws (err.error, and err.message) — so
// the tab can say which refusal this was, and offer the person's own key where
// that helps. `x-should-retry: false` stops the SDK retrying what will not
// change in a second.

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function answer(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers } });
}

function refuse(status, code, message, extra = {}, headers = {}) {
  return answer(status, { type: 'error', error: { type: code, message }, code, message, ...extra },
    { 'x-should-retry': 'false', ...headers });
}

const usd2 = x => `US$${x.toFixed(2)}`;

function ledgerRefusal(r) {
  const now = { day: r.day, limit_usd: r.limit_usd, spent_usd: r.spent_usd, held_usd: r.held_usd, left_usd: r.left_usd, resets_at: r.resets_at };
  if (r.reason === 'daily_limit') {
    return refuse(429, 'daily_limit', `Flood-Net's Anthropic allowance for today (${usd2(r.limit_usd)}) is spent — `
      + `it starts again at midnight, Brisbane time. Your own key works meanwhile.`, now);
  }
  if (r.reason === 'busy') {
    return refuse(429, 'busy', `You already have ${PER_PERSON.inFlight} calls running on Flood-Net's key — let one finish, then ask again.`, now);
  }
  return refuse(429, 'rate_limited', `More than ${PER_PERSON.callsPerMinute} calls in a minute on Flood-Net's key — `
    + `wait ${r.retry_after} s and ask again.`, now, { 'x-should-retry': 'true', 'Retry-After': String(r.retry_after) });
}

// ── Who is asking ────────────────────────────────────────────────────────────

const sessions = new Map();     // sha256(token) → { who, until }

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// meganet.whoami() as the person's own token sees it: {who} when the database
// answered (whatever it said), {expired} when it refused the token, {down} when
// it did not answer. Remembered for a minute, so a briefing's dozen calls ask
// once.
async function whoami(token) {
  const h = await sha256Hex(token);
  const hit = sessions.get(h);
  if (hit && hit.until > Date.now()) return { who: hit.who };
  let res;
  try {
    res = await fetch(`${SUPABASE_REST_URL}/rpc/whoami`, {
      method: 'POST',
      headers: {
        apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`,
        'Content-Profile': 'meganet', 'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: '{}',
    });
  } catch (_) { return { down: true }; }
  if (res.status === 401 || res.status === 403) return { expired: true };
  if (!res.ok) return { down: true };
  let who = null;
  try { who = await res.json(); } catch (_) { return { down: true }; }
  if (!isObj(who)) return { down: true };
  if (sessions.size > 500) sessions.clear();
  sessions.set(h, { who, until: Date.now() + SESSION_TTL_MS });
  return { who };
}

// {email, role} for an editor or an administrator; {refusal} for anybody else.
async function person(request, env, accessIdentity) {
  const door = await accessIdentity(request, env);
  if (!door || !door.claims) {
    return { refusal: refuse(401, 'no_access', 'Flood-Net\'s key is for editors signed in through Cloudflare Access at '
      + `floodwarning.net, and this request carries no Access sign-in it could verify (${(door && door.error) || 'none'}).`) };
  }
  const email = String(door.claims.email).toLowerCase();
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return { refusal: refuse(401, 'not_signed_in', 'This page is not signed in to Flood-Net, and Flood-Net\'s key is for editors and administrators.') };
  const v = await whoami(m[1]);
  if (v.down) return { refusal: refuse(503, 'unavailable', 'The database did not answer when asked who this is — try again in a minute.', {}, { 'x-should-retry': 'true' }) };
  const who = v.who;
  if (v.expired || !who || who.signed_in !== true) {
    return { refusal: refuse(401, 'not_signed_in', 'This page\'s Flood-Net session has ended — reload the page to sign in again.') };
  }
  if (String(who.email || '').toLowerCase() !== email) {
    return { refusal: refuse(403, 'not_permitted', `This page is signed in to Flood-Net as ${who.email || 'nobody'}, `
      + `but Cloudflare Access let in ${email}. Sign out of Flood-Net and reload, so the two agree.`) };
  }
  const role = who.is_admin === true ? 'admin' : who.role;
  if (who.may_write !== true || (role !== 'editor' && role !== 'admin')) {
    const what = who.may_write !== true ? 'not on the editors list' : `a ${role || 'viewer'}`;
    return { refusal: refuse(403, 'not_permitted', `Flood-Net's key is for editors and administrators, and ${email} is ${what}.`) };
  }
  return { email, role };
}

// ── The two routes ───────────────────────────────────────────────────────────

async function status(env, p) {
  let r;
  try { r = await ledgerOf(env).status({ who: p.email }); } catch (err) {
    return refuse(503, 'unavailable', `The day's ledger did not answer: ${err.message}`, {}, { 'x-should-retry': 'true' });
  }
  if (!r.ok) return ledgerRefusal(r);
  // Less left than the smallest call reserves is a spent day, said the way a
  // call would be refused, so the tab offers the person's own key up front.
  if (r.left_usd < worstCaseUsd(0)) return ledgerRefusal({ ...r, reason: 'daily_limit' });
  return answer(200, {
    ok: true, model: MODEL, email: p.email, role: p.role,
    day: r.day, limit_usd: r.limit_usd, spent_usd: r.spent_usd, held_usd: r.held_usd, left_usd: r.left_usd,
    calls: r.calls, resets_at: r.resets_at, calls_per_minute: PER_PERSON.callsPerMinute,
  });
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

async function messages(request, env, ctx, p) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return refuse(415, 'invalid_request', 'Not a briefing request: it is sent as application/json.');
  const declared = Number(request.headers.get('Content-Length'));
  const tooLarge = () => refuse(413, 'too_large', `This conversation is past the ${MAX_BODY_BYTES.toLocaleString('en-AU')} bytes a call on `
    + 'Flood-Net\'s key may carry — start a new briefing.');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (!bytes) return tooLarge();
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) {
    return refuse(400, 'invalid_request', 'Not a briefing request: the body is not JSON.');
  }
  const why = requestProblem(body);
  if (why) return refuse(400, why.code, why.message);
  // What goes to Anthropic is what was checked, written out again — never the
  // caller's bytes, which another parser could read differently (a key given
  // twice, of which JSON.parse keeps the last). For what the SDK sends the two
  // are the same bytes, so the caller's length stands for both.
  const sending = JSON.stringify(body);

  const ledger = ledgerOf(env);
  let hold;
  try { hold = await ledger.reserve({ who: p.email, usd: worstCaseUsd(bytes.byteLength) }); } catch (err) {
    return refuse(503, 'unavailable', `The day's ledger did not answer, so nothing was spent: ${err.message}`, {}, { 'x-should-retry': 'true' });
  }
  if (!hold.ok) return ledgerRefusal(hold);

  // From here the hold is settled exactly once, whatever happens — and kept
  // alive past the response, so a browser that leaves cannot leave it open.
  let settled = false;
  const settle = async usd => {
    if (settled) return;
    settled = true;
    try { await ledger.settle({ id: hold.id, usd }); } catch (_) { /* it expires, and is charged in full */ }
  };
  const started = Date.now();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), headersTimeoutMs);
  let upstream;
  try {
    // Built here, not copied: the caller's Authorization, cookies and Access
    // headers stop at this Worker, and the key is the only credential that
    // leaves it.
    upstream = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        // Trimmed: a key pasted into the dashboard with its newline would
        // otherwise be an invalid header, and read as Anthropic unreachable.
        'x-api-key': String(env.ANTHROPIC_API_KEY).trim(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': BETAS.join(','),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: sending,
      signal: timeout.signal,
    });
  } catch (err) {
    // A connection that never opened cost nothing; one given up on may have.
    const work = settle(timeout.signal.aborted ? inputGuessUsd(bytes.byteLength) : 0);
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    await work;
    return refuse(502, 'upstream_unreachable', `Could not reach Anthropic's API from Flood-Net's Worker: ${err.message}`, {}, { 'x-should-retry': 'true' });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    // Refused before any work: nothing billed.
    const text = await upstream.text().catch(() => '');
    const work = settle(0);
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    await work;
    if (upstream.status === 401 || upstream.status === 403) {
      return refuse(502, 'key_refused', 'Anthropic refused Flood-Net\'s key — an administrator has to check ANTHROPIC_API_KEY on the Worker. Your own key works meanwhile.');
    }
    const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/json', ...NO_STORE };
    for (const h of ['retry-after', 'x-should-retry', 'request-id']) {
      const v = upstream.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    return new Response(text, { status: upstream.status, headers });
  }

  // The stream, passed through byte for byte, with the meter reading it.
  const meter = new UsageMeter();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  // The browser leaving cancels `readable`, which errors the writer: stop
  // Anthropic writing too, rather than paying for what nobody will read.
  writer.closed.catch(() => { reader.cancel().catch(() => {}); });
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        meter.push(value);
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      try { await reader.cancel(); } catch (_) { /* gone */ }
      try { await writer.abort(err); } catch (_) { /* gone */ }
    } finally {
      await settle(meter.usd({ elapsedMs: Date.now() - started, bytes: bytes.byteLength }));
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);
  const headers = { 'Content-Type': 'text/event-stream; charset=utf-8', ...NO_STORE };
  const rid = upstream.headers.get('request-id');
  if (rid) headers['request-id'] = rid;
  return new Response(readable, { status: 200, headers });
}

// `accessIdentity` is worker/index.js's: who Cloudflare Access says this is,
// verified, as the session exchange asks it.
export async function handleBriefing(request, env, ctx, accessIdentity) {
  const url = new URL(request.url);
  const isStatus = url.pathname === BRIEFING_PREFIX;
  const isMessages = url.pathname === MESSAGES_PATH;
  if (!isStatus && !isMessages) return refuse(404, 'not_found', 'Not a briefing path.');
  if (request.method !== (isStatus ? 'GET' : 'POST')) {
    return refuse(405, 'method_not_allowed', `${isStatus ? 'GET' : 'POST'} only.`, {}, { Allow: isStatus ? 'GET' : 'POST' });
  }
  // Named, so a half-set-up Worker says which part is missing. The tab reads
  // any of these as "Flood-Net's key is not set up" and offers the person's own.
  for (const name of ['ANTHROPIC_API_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'BRIEFING_LEDGER']) {
    if (!env || !env[name]) {
      return refuse(503, 'not_configured', `Flood-Net's key is not set up on this Worker yet (${name} is missing — see docs/access.md). `
        + 'Your own key works meanwhile.');
    }
  }
  try {
    const p = await person(request, env, accessIdentity);
    if (p.refusal) return p.refusal;
    return isStatus ? await status(env, p) : await messages(request, env, ctx, p);
  } catch (err) {
    return refuse(500, 'internal', `The briefing route failed: ${(err && err.message) || err}`);
  }
}

// For the check: forget the sessions remembered, as a fresh isolate would; and
// wait less than two minutes for an Anthropic that never answers.
export const _test = {
  forgetSessions: () => sessions.clear(),
  headersTimeout: ms => { headersTimeoutMs = ms == null ? UPSTREAM_HEADERS_TIMEOUT_MS : ms; },
};
