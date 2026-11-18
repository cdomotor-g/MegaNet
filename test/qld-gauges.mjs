// The State's live river heights (#295): worker/qld-gauges.js's /api/qld-gauges,
// offline — the State's portal and the edge cache are stand-ins.
//
// Run:  npm run qldgauges

import worker from '../worker/index.js';
import { handleQldGauges, isQldGaugesPath, parseSites, readingTime, readGauges, upstreamUrl, UPSTREAM, SITES_MAX, FRESH_S } from '../worker/qld-gauges.js';

const results = [];
const check = (what, ok, detail = '') => results.push({ ok: !!ok, what, detail });
const J = v => JSON.stringify(v);
const ORIGIN = 'https://floodwarning.net';

const portal = {
  error_num: 0, licence: 'CC_40_BY',
  return: {
    '130105B': [{ values: [{ v: '1.016', q: 130, time: '20261119060000' }], varfrom: '100.00', varto: '100.00' }],
    '144003A': [{ values: [{ v: '0.577', q: 130, time: '20261119060000' }], varfrom: '100.00', varto: '100.00' }],
    '999999Z': [{ values: [{ v: '', q: 255, time: '20261119060000' }] }],
  },
};

function stand() {
  const calls = [];
  const store = new Map();
  const cache = {
    async match(req) { const v = store.get(req.url); return v ? new Response(v) : undefined; },
    async put(req, res) { store.set(req.url, await res.text()); },
  };
  let now = Date.parse('2026-11-18T20:00:00Z');
  const deps = {
    cache, now: () => now,
    fetch: async (u, init) => { calls.push({ u, init }); return deps.answer ? deps.answer(u) : new Response(J(portal), { status: 200 }); },
  };
  return { calls, deps, tick: s => { now += s * 1000; }, store };
}
const ask = (path, s, init = {}) => handleQldGauges(new Request(`${ORIGIN}${path}`, init), {}, {}, s.deps);

check('its path and not its neighbours\'', isQldGaugesPath('/api/qld-gauges') && !isQldGaugesPath('/api/qld-gaugesx') && !isQldGaugesPath('/api/cameras'));
check('site lists: sorted, no repeats', J(parseSites('144003A,130105B,130105B')) === J(['130105B', '144003A']));
const BAD = ['', '130105', '130105b', '13010', '130105B;x', '130105B,', ',130105B', '../130105B', '130105B%2C144003A', 'a'.repeat(9),
  Array.from({ length: SITES_MAX + 1 }, (_, i) => `${100000 + i}A`).join(',')];
check('anything else is not a site list', BAD.every(b => parseSites(b) === null), J(BAD.filter(b => parseSites(b) !== null)));
check('the State\'s time is Queensland time, UTC+10', readingTime('20261119060000') === '2026-11-19T06:00:00+10:00' && readingTime('x') === null);
check('the portal is asked once, at the fixed address, for stage only, and only the site numbers come from the caller',
  (() => { const u = upstreamUrl(['130105B']); return u.startsWith(`${UPSTREAM}?`) && /"varfrom":"100.00","varto":"100.00"/.test(u) && /"site_list":"130105B"/.test(u); })());
check('a reading with no value is left out', J(Object.keys(readGauges(portal, ['130105B', '999999Z', '111111A']))) === J(['130105B']));

{
  const s = stand();
  const r = await ask('/api/qld-gauges?sites=144003A,130105B', s);
  const b = await r.json();
  check('a good ask: 200, readings in metres with Queensland time, the datum said, CORS open',
    r.status === 200 && b.gauges['130105B'].m === 1.016 && b.gauges['144003A'].at === '2026-11-19T06:00:00+10:00'
      && /not AHD/.test(b.source.datum) && r.headers.get('Access-Control-Allow-Origin') === '*', J(b));
  check('the portal was asked once, GET, with Flood-Net\'s User-Agent and nothing of the caller\'s',
    s.calls.length === 1 && s.calls[0].init.headers['User-Agent'].startsWith('Flood-Net') && !('Cookie' in s.calls[0].init.headers) && !('Authorization' in s.calls[0].init.headers));
  await ask('/api/qld-gauges?sites=130105B,144003A', s);
  check('the same sites in another order are one cache entry: the portal is not asked again', s.calls.length === 1, String(s.calls.length));
  s.tick(FRESH_S + 5);
  await ask('/api/qld-gauges?sites=130105B,144003A', s);
  check('after the fresh time it is asked again', s.calls.length === 2);
  s.deps.answer = () => new Response('<html>Request Rejected</html>', { status: 200 });
  s.tick(FRESH_S + 5);
  const st = await (await ask('/api/qld-gauges?sites=130105B,144003A', s)).json();
  check('the portal down: the last good answer, marked stale', st.stale === true && st.gauges['130105B'].m === 1.016, J(st));
}
{
  const s = stand();
  s.deps.answer = () => { throw new Error('down'); };
  const r = await ask('/api/qld-gauges?sites=130105B', s);
  check('the portal down with nothing kept: 502 in words', r.status === 502 && /did not answer/.test((await r.json()).error));
  const before = s.calls.length;
  const bad = await ask('/api/qld-gauges?sites=nope', s);
  check('a bad list: 400, the portal not asked', bad.status === 400 && s.calls.length === before);
  const post = await ask('/api/qld-gauges?sites=130105B', s, { method: 'POST' });
  check('POST is a 405', post.status === 405);
  const pre = await ask('/api/qld-gauges', s, { method: 'OPTIONS' });
  check('the preflight is a 204 with CORS', pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === '*');
  const sub = await ask('/api/qld-gauges/x?sites=130105B', s);
  check('nothing under it', sub.status === 404);
}
{
  const r = await worker.fetch(new Request(`${ORIGIN}/api/qld-gauges?sites=bad`), {}, {});
  check('the Worker routes it', r.status === 400);
}

const failed = results.filter(x => !x.ok);
for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.what}${r.ok || !r.detail ? '' : ` — ${String(r.detail).slice(0, 300)}`}`);
console.log(failed.length ? `\nFAIL — ${failed.length} of ${results.length}.` : `\nPASS — ${results.length} checks: /api/qld-gauges takes only State gauge numbers, asks the portal one fixed call, keeps answers 20 minutes and serves the last good one when it is down.`);
process.exitCode = failed.length ? 1 : 0;
