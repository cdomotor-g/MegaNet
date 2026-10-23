// The Admin tab's Base station connections (admin-links.js, 0080) and the
// tab's layout, driven in a real browser against a stand-in for the database
// that answers as it answers and records what it is asked.
//
//   1. **The layout** — every panel with a table is the page's full width (the
//      users, allowlist and tokens were a column beside the data cards, and an
//      address broke across three lines); the cards with no table share two
//      columns; on a phone the tables scroll sideways rather than folding
//      words into letters.
//   2. **The card** — 18 Bateson's month, as 0080 records it from the live
//      readings of 17, 21 and 24 Oct 2026 (three nine-minute dropouts at about
//      3 am, the 72 minutes without readings on the 19th) and a restart, a new
//      address and a route change: uptime, dropouts, the longest gap,
//      connected since, the network changes; a row a day from the day it was
//      first seen with each gap where it fell; the gaps by hour of the day,
//      and the 3 am pattern said in words.
//   3. **The log** — newest first, lost and back for a gap, what each means,
//      the filters and their counts; another window asked for by its days.
//   4. **The edges** — a station offline now is a gap still open, at the top
//      of the log; a database without 0080 says which file to apply; an
//      editor sees none of it and asks nothing.
//
// Run:  npm run adminlinks
//       npm run adminlinks -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };
const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

// 05:10 on Saturday 24 Oct in Brisbane: an hour and a quarter after the third
// 3 am dropout ended.
const NOW = '2026-10-23T19:10:00Z';
const FROM = new Date(Date.parse(NOW) - 30 * 86400e3).toISOString();
const EVENTS = [
  { id: 7, kind: 'address', started_at: '2026-10-23T17:54:36Z', from: '206.83.x.x', to: '168.140.x.x', detail: { source: 'checkins', family: 'v4', route: 'direct' } },
  { id: 6, kind: 'dropout', started_at: '2026-10-23T17:45:27Z', ended_at: '2026-10-23T17:54:36Z', seconds: 549, detail: { source: 'readings', held: 52 } },
  { id: 5, kind: 'route', started_at: '2026-10-23T11:33:24Z', from: 'floodwarning.net', to: 'direct', detail: { source: 'checkins', family: 'v4' } },
  { id: 4, kind: 'dropout', started_at: '2026-10-20T17:10:32Z', ended_at: '2026-10-20T17:19:06Z', seconds: 514, detail: { source: 'readings', held: 803 } },
  { id: 3, kind: 'quiet', started_at: '2026-10-18T22:44:26Z', ended_at: '2026-10-18T23:56:38Z', seconds: 4332, detail: { source: 'readings', held: 0 } },
  { id: 1, kind: 'dropout', started_at: '2026-10-16T17:31:34Z', ended_at: '2026-10-16T17:40:16Z', seconds: 523, detail: { source: 'readings', held: 62 } },
  { id: 2, kind: 'restart', started_at: '2026-10-12T02:10:00Z', ended_at: '2026-10-12T02:16:30Z', seconds: 390, detail: { source: 'checkins', up_s: 180 } },
];
const station = (over = {}) => ({
  id: 11, label: '18 Bateson', host_station_id: '18_bateson', app: 'RPi ALERT', version: '0.14.2', mode: 'manage', idle_s: 60,
  first_seen_at: '2026-10-06T00:37:23Z', last_seen_at: '2026-10-23T19:09:40Z', checkins: 27911, state: 'online', up_s: 124277,
  net: { route: 'direct', family: 'v4', at: NOW, v4: { addr: '168.140.x.x', since: '2026-10-23T17:54:36Z' }, v6: { addr: '2406:2d40::/32', since: '2026-10-14T00:00:00Z' } },
  events: EVENTS, ...over,
});
const links = (over = {}) => ({ now: NOW, days: 30, from: FROM, stations: [station(over)] });

const WHO = {
  admin:  { signed_in: true, email: 'boss@bom.gov.au', display_name: 'Boss', role: 'admin', may_write: true, is_admin: true, is_member: true, status: 'automatic', signup: 'open', schema_version: '80' },
  editor: { signed_in: true, email: 'ed@bom.gov.au', display_name: null, role: 'editor', may_write: true, is_admin: false, is_member: true, status: 'automatic', signup: 'open', schema_version: '80' },
};
const USERS = [
  { id: 'u1', email: 'boss.person.with.a.long.address@bom.gov.au', display_name: 'Boss Person', role: 'admin', status: 'automatic', is_you: true, created_at: '2026-09-01T00:00:00Z', confirmed_at: '2026-09-01T00:00:00Z', may_edit: true },
  { id: 'u2', email: 'field.tech@contractor.example', display_name: 'Field Tech', role: 'editor', status: 'approved', created_at: '2026-10-02T00:00:00Z', confirmed_at: '2026-10-02T00:00:00Z', may_edit: true },
];
const ALLOW = [{ id: 1, entry: '@bom.gov.au', role: 'editor', note: 'Any Bureau address', created_at: '2026-08-01T00:00:00Z' }];
const TOKENS = [{ id: 11, label: '18 Bateson', host_station: '18_bateson', created_at: '2026-10-06T00:00:00Z', created_by: 'boss@bom.gov.au', last_used_at: NOW, revoked_at: null }];

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const asked = [];

  async function open({ who = 'admin', answer = () => links(), viewport = { width: 1440, height: 1000 } } = {}) {
    const context = await browser.newContext({ viewport, timezoneId: 'Australia/Brisbane', locale: 'en-AU' });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await page.route('**/auth/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: J({ external: {} }) }));
    await page.route('**/rest/v1/rpc/**', r => {
      const name = new URL(r.request().url()).pathname.split('/rpc/')[1];
      let body = null;
      try { body = JSON.parse(r.request().postData() || 'null'); } catch (_) {}
      asked.push({ name, body });
      const reply = (status, obj) => r.fulfill({ status, contentType: 'application/json', body: J(obj) });
      if (name === 'admin_base_station_links') {
        const a = answer(body);
        return a === 404 ? reply(404, { message: 'Could not find the function meganet.admin_base_station_links' }) : reply(200, a);
      }
      const map = { whoami: WHO[who], admin_users: USERS, admin_allowlist: ALLOW, admin_ingest_tokens: TOKENS,
                    admin_ingest_token_requests: [], push_mine: { devices: [], waiting: 0 }, my_prefs: { nav_views: null } };
      if (name in map) return reply(200, map[name]);
      return reply(404, { message: 'not stood in for' });
    });
    await page.addInitScript(() => {
      localStorage.setItem('meganet.session', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3, email: 'x@bom.gov.au' }));
      localStorage.setItem('mn-nudge', 'off');
    });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(server.url('/index.html?tab=admin'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof Auth !== 'undefined' && Auth.known(), null, { timeout: 15_000 });
    return { context, page };
  }

  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. The layout\n');
    {
      const { context, page } = await open();
      await page.waitForSelector('.bl-station', { timeout: 15_000 });
      await page.waitForSelector('#adm-people table', { timeout: 15_000 });
      await page.waitForSelector('#adm-tokens table', { timeout: 15_000 });
      const box = await page.evaluate(() => {
        const w = el => Math.round(el?.getBoundingClientRect().width || 0);
        const page = document.querySelector('.adm-page');
        const cards = [...document.querySelectorAll('.adm-cards > *')].map(el => Math.round(el.getBoundingClientRect().left));
        return {
          page: w(page),
          links: w(document.querySelector('#adm-links .panel')),
          users: w(document.querySelector('#adm-people table')),
          tokens: w(document.querySelector('#adm-tokens table')),
          roles: w(document.querySelector('[aria-labelledby="adm-roles-h"] table')),
          log: w(document.querySelector('.bl-log')),
          columns: new Set(cards).size,
          // The address's own text, on how many lines (the "you" badge after it may wrap; the address must not).
          email: (() => {
            const td = [...document.querySelectorAll('#adm-people table td')].find(c => /long\.address/.test(c.textContent));
            const walk = td && document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
            let n; while (walk && (n = walk.nextNode())) if (/long\.address/.test(n.textContent)) break;
            if (!n) return -1;
            const r = document.createRange(); r.selectNodeContents(n);
            return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size;
          })(),
        };
      });
      const full = x => x >= box.links * 0.95;
      check('every table is a row of its own: the users, the tokens, the roles and the connection log as wide as the page',
        full(box.users) && full(box.tokens) && full(box.roles) && full(box.log), J(box));
      check('…and the cards with no table share two columns', box.columns === 2, J(box));
      check('…and a long address sits on one line, not three', box.email === 1, J(box));
      await context.close();
    }
    {
      const { context, page } = await open({ viewport: { width: 390, height: 900 } });
      await page.waitForSelector('#adm-people table', { timeout: 15_000 });
      await page.waitForSelector('.bl-log', { timeout: 15_000 });
      const phone = await page.evaluate(() => ['#adm-people table', '.bl-log', '#adm-dash ~ * table, .adm-tables'].map(q => {
        const t = document.querySelector(q);
        const wrap = t?.closest('.table-wrap');
        return t ? { q, table: Math.round(t.getBoundingClientRect().width), wrap: Math.round(wrap.clientWidth), scrolls: wrap.scrollWidth > wrap.clientWidth + 1 } : { q };
      }));
      check('on a phone the users table and the log keep their columns and scroll sideways in their wrappers',
        phone.slice(0, 2).every(p => p.scrolls && p.table >= 500), J(phone));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. The card\n');
    const { context: c2, page } = await open();
    await page.waitForSelector('.bl-station', { timeout: 15_000 });
    const card = await page.evaluate(() => {
      const tiles = Object.fromEntries([...document.querySelectorAll('.bl-kpis .adm-kpi')].map(t => [
        t.querySelector('.adm-kpi-label').textContent.trim(),
        { v: t.querySelector('.adm-kpi-value').textContent.replace(/\s+/g, ''), sub: t.querySelector('.adm-kpi-sub').textContent.replace(/\s+/g, ' ').trim() }]));
      const head = document.querySelector('.bl-station-head').textContent.replace(/\s+/g, ' ');
      return { tiles, head, said: document.querySelector('.bl-said')?.textContent.replace(/\s+/g, ' ') || '' };
    });
    vlog(J(card));
    check('the station, online, with where it calls from — the blocks only, and which way',
      /18 Bateson/.test(card.head) && /Online/.test(card.head) && /168\.140\.x\.x/.test(card.head)
        && /2406:2d40::\/32/.test(card.head) && /straight to the database/.test(card.head), card.head);
    check('uptime over the month since it was first seen, and how long without a check-in',
      card.tiles['Uptime, 30 days']?.v === '99.8%' && /33 min without a check-in/.test(card.tiles['Uptime, 30 days']?.sub), J(card.tiles['Uptime, 30 days']));
    check('three dropouts, one restart; the longest nine minutes, at 3:45 on the 24th',
      card.tiles.Dropouts?.v === '3' && /1 restart · 0 software restarts/.test(card.tiles.Dropouts?.sub)
        && card.tiles['Longest gap']?.v === '9min' && /24 Oct/.test(card.tiles['Longest gap']?.sub) && /03:45/.test(card.tiles['Longest gap']?.sub),
      J([card.tiles.Dropouts, card.tiles['Longest gap']]));
    check('connected since the last one ended, and two network changes',
      /1h1[56]min/.test(card.tiles['Connected for']?.v) && /03:54/.test(card.tiles['Connected for']?.sub)
        && card.tiles['Network changes']?.v === '2' && /1 new address · 1 route change/.test(card.tiles['Network changes']?.sub),
      J([card.tiles['Connected for'], card.tiles['Network changes']]));
    check('the readings\' 72 minutes without anything counted apart, not as downtime',
      card.tiles['No readings']?.v === '1h12min', J(card.tiles['No readings']));
    check('the 3 am pattern said in words',
      /3 of the 4 dropouts and restarts started between 03:00 and 04:00/.test(card.said), card.said);
    const days = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.bl-days .bl-day:not(.bl-axis)')];
      const sat = rows[0];
      const seg = sat.querySelector('.bl-seg.bl-k--dropout');
      return {
        n: rows.length,
        first: rows[0].querySelector('.bl-day-l').textContent.trim(),
        last: rows[rows.length - 1].querySelector('.bl-day-l').textContent.trim(),
        since: document.querySelector('.bl-first')?.textContent.trim(),
        left: seg ? parseFloat(seg.style.left) : null,
        tick: !!sat.querySelector('.bl-tick.bl-k--address'),
        sr: sat.querySelector('.sr-only').textContent,
        up: sat.querySelector('.bl-day-r').textContent.trim(),
        quiet: rows.find(r => /19 Oct/.test(r.querySelector('.bl-day-l').textContent))?.querySelector('.bl-seg.bl-k--quiet') ? true : false,
      };
    });
    vlog(J(days));
    check('a row a day, today on top, back to the day it was first seen — and a line for that, not empty rows',
      days.n === 19 && /24 Oct/.test(days.first) && /6 Oct/.test(days.last) && /First checked in/.test(days.since || ''), J(days));
    check('today\'s dropout drawn at 03:45 (15.6% of the day), the new address a tick, both said for a screen reader',
      Math.abs(days.left - (3 * 60 + 45 + 27 / 60) / 1440 * 100) < 0.05 && days.tick
        && /dropout 03:45/i.test(days.sr) && /new address 03:54/i.test(days.sr) && days.up === '97%', J(days));
    check('the 19th\'s gap without readings drawn grey', days.quiet, J(days));
    const hours = await page.evaluate(() => [...document.querySelectorAll('.bl-hbars li')].map(li => li.querySelector('.bl-hn')?.textContent || ''));
    check('by hour of the day: three at 03, the restart at 12, the readings\' gap at 08',
      hours.length === 24 && hours[3] === '3' && hours[12] === '1' && hours[8] === '1'
        && hours.filter(Boolean).length === 3, J(hours));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. The log\n');
    const rows = () => page.evaluate(() => [...document.querySelectorAll('.bl-log tbody tr')].map(tr => ({
      kind: [...tr.classList].find(c => c.startsWith('bl-row--'))?.slice(8),
      when: tr.querySelector('.bl-when').textContent.replace(/\s+/g, ' ').trim(),
      len: tr.querySelector('.bl-len').textContent.trim(),
      means: tr.lastElementChild.textContent.replace(/\s+/g, ' ').trim(),
    })));
    const all = await rows();
    vlog(J(all));
    check('every event, newest first', J(all.map(r => r.kind)) === J(['address', 'dropout', 'route', 'dropout', 'quiet', 'dropout', 'restart']), J(all.map(r => r.kind)));
    check('a gap says when it was lost and when it came back, and how long',
      /lost 03:45:27/.test(all[1].when) && /back 03:54:36/.test(all[1].when) && all[1].len === '9 min', J(all[1]));
    check('…and what it means: readings heard meanwhile and sent on its return — the connection',
      /52 readings were heard meanwhile/.test(all[1].means) && /the connection, not the radio/.test(all[1].means), all[1].means);
    check('a new address says block to block; a route change which way',
      /206\.83\.x\.x → 168\.140\.x\.x/.test(all[0].means) && /Now straight to the database; was through floodwarning\.net/.test(all[2].means),
      J([all[0].means, all[2].means]));
    check('a restart says the computer started again', /started again 3 min before it checked back in/.test(all[6].means), all[6].means);
    const counts = await page.evaluate(() => [...document.querySelectorAll('.bl-log').length ? document.querySelectorAll('[onclick^="AdminLinks.setFilter"]') : []]
      .map(b => b.textContent.replace(/\s+/g, ' ').trim()));
    check('the filters count what each would show', J(counts) === J(['Everything 7', 'Dropouts & restarts 4', 'Address & route 2', 'No readings 1']), J(counts));
    await page.click('[onclick="AdminLinks.setFilter(\'net\')"]');
    const net = await rows();
    check('…and show only that', J(net.map(r => r.kind)) === J(['address', 'route']), J(net.map(r => r.kind)));
    const n0 = asked.length;
    await page.click('[onclick="AdminLinks.setDays(7)"]');
    await page.waitForFunction(() => document.querySelector('[onclick="AdminLinks.setDays(7)"]')?.classList.contains('is-on'));
    const ask = asked.slice(n0).find(a => a.name === 'admin_base_station_links');
    check('another window is asked for by its days', ask && ask.body && ask.body.p_days === 7, J(ask));
    await c2.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. The edges\n');
    {
      const { context, page } = await open({ answer: () => links({ state: 'offline', last_seen_at: '2026-10-23T18:00:00Z' }) });
      await page.waitForSelector('.bl-log tbody tr', { timeout: 15_000 });
      const off = await page.evaluate(() => ({
        head: document.querySelector('.bl-station-head').textContent.replace(/\s+/g, ' '),
        tile: [...document.querySelectorAll('.bl-kpis .adm-kpi-label')].map(l => l.textContent.trim()),
        first: document.querySelector('.bl-log tbody tr').textContent.replace(/\s+/g, ' '),
      }));
      check('a station offline now: the gap it is in is open, at the top of the log, not back yet',
        /Offline/.test(off.head) && off.tile.includes('Last check-in') && /Offline now/.test(off.first)
          && /not back yet/.test(off.first) && /1 h 10 min/.test(off.first), J(off));
      await context.close();
    }
    {
      const { context, page } = await open({ answer: () => 404 });
      await page.waitForFunction(() => /0080_base_station_links\.sql/.test(document.getElementById('adm-links')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {});
      const said = await page.evaluate(() => document.getElementById('adm-links')?.textContent.replace(/\s+/g, ' ') || '');
      check('a database without 0080 says which file to apply', /apply db\/migrations\/0080_base_station_links\.sql/.test(said), said);
      await context.close();
    }
    {
      const n1 = asked.length;
      const { context, page } = await open({ who: 'editor' });
      await page.waitForTimeout(1500);
      const ed = await page.evaluate(() => document.getElementById('adm-links')?.textContent.trim() || '');
      check('an editor sees none of it, and nothing is asked for them',
        ed === '' && !asked.slice(n1).some(a => a.name === 'admin_base_station_links'), ed.slice(0, 80));
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — admin links: the Admin tab's layout, a base station's month of connection, its log and its edges (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
