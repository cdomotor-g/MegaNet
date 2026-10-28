// The calendar on the time axis of the Plots and Field Data charts.
//
// Two things were asked for: the day of the week under every date on the axis
// (MON, TUE, …), and a heavier line wherever a week starts — Monday 00:00 —
// switching to the first of each month once the weeks are too close together
// to be any use, and to 1 January past that.
//
// Neither is worth having unless it lands on the right instant, and the axis
// it is drawn on did not: its ticks were counted in milliseconds from 1970, so
// a day's tick sat on UTC midnight — ten in the morning in Queensland — and a
// week's on a Thursday, the day 1970 began on. A "MON" under a tick ten hours
// right of the Monday line is worse than no "MON" at all. So the ticks are now
// walked on the local calendar, and this holds both halves to it:
//
//   1. **The arithmetic, in two time zones.** `ArroData.timeTicks()` over a
//      spread of windows from minutes to years: an hour's tick a whole local
//      hour, a day's local midnight, a week's a Monday, a quarter's the first
//      of a quarter. `ArroData.calBounds()` against dates worked by hand: which
//      Mondays and 1sts fall in a window, which kind each is, and the switch
//      from weeks to months to years as the window widens. Brisbane (no
//      daylight saving) and Sydney (which goes forward on 4 October 2026), so
//      a clock change cannot quietly push a midnight to 01:00.
//
//   2. **The chart as drawn**, on the demo record: every time label carrying
//      the day its instant falls on, each week line on a Monday midnight and on
//      the tick at that instant when there is one, the names over the month
//      lines, the key under the chart naming only the kinds on it, none of the
//      day line at a month a tick, the side-by-side panes carrying the lines,
//      and the hover balloon saying the day.
//
//   node --run adcal      (or: npm run adcal)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

// The chart is checked in Brisbane, and so are the dates this side works out
// to check it against — Node's own zone is the machine's, often UTC.
process.env.TZ = 'Australia/Brisbane';

const LOAD_TIMEOUT = 60000;
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

async function openPlots(tz) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: tz });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(`${tz}: ${e.message}`));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

// ── 1. The arithmetic ────────────────────────────────────────────────────────
// Every window and every tick density, checked against what the step promises.
// Run in the page so `new Date(y, m, d)` means that zone's midnight.
function tickRules() {
  const A = window.ArroData, DAY = 86400000;
  const bad = [];
  const seen = new Set();
  // Fixed starts either side of Sydney's clock change, odd minutes past, so
  // nothing lines up by accident; spans from ten minutes to three years.
  const starts = [new Date(2026, 8, 29, 7, 13).getTime(), new Date(2026, 9, 3, 22, 41).getTime(),
                  new Date(2026, 11, 30, 15, 2).getTime(), new Date(2027, 3, 4, 1, 37).getTime()];
  const spans = [6e5, 72e5, 288e5, 864e5, 3 * DAY, 9 * DAY, 20 * DAY, 45 * DAY, 100 * DAY,
                 200 * DAY, 400 * DAY, 1100 * DAY];
  for (const t0 of starts) for (const span of spans) for (const want of [3, 6, 9, 14]) {
    const t1 = t0 + span;
    const { ticks, step } = A.timeTicks(t0, t1, want);
    seen.add(step);
    const where = `${new Date(t0).toString().slice(4, 21)} +${(span / DAY).toFixed(2)} d, want ${want}, step ${step}`;
    if (ticks.some(t => t < t0 || t > t1)) bad.push(`tick outside the window — ${where}`);
    for (let i = 1; i < ticks.length; i++) if (!(ticks[i] > ticks[i - 1])) { bad.push(`ticks not increasing — ${where}`); break; }
    if (span >= step * 1.5 && !ticks.length) bad.push(`no ticks at all — ${where}`);
    for (const t of ticks) {
      const d = new Date(t);
      const at = `${d.toString().slice(0, 24)} — ${where}`;
      if (step >= 36e5 && (d.getMinutes() || d.getSeconds() || d.getMilliseconds())) bad.push(`not a whole hour: ${at}`);
      if (step >= 36e5 && step < DAY && d.getHours() % Math.round(step / 36e5)) bad.push(`hour not a multiple of the step: ${at}`);
      if (step >= DAY && d.getHours()) bad.push(`not local midnight: ${at}`);
      if ((step === 7 * DAY || step === 14 * DAY) && d.getDay() !== 1) bad.push(`week tick not a Monday: ${at}`);
      if (step >= 30 * DAY) {
        const months = Math.round(step / (30 * DAY));
        if (d.getDate() !== 1) bad.push(`month tick not the 1st: ${at}`);
        if ((d.getFullYear() * 12 + d.getMonth()) % months) bad.push(`not the first month of a ${months}-month step: ${at}`);
      }
    }
    // A fortnight's Mondays and a pair of days stay put as the window pans:
    // the same tick from two windows a day apart.
    if (step === 14 * DAY || step === 2 * DAY) {
      const again = A.timeTicks(t0 + DAY, t1 + DAY, want);
      if (again.step === step) {
        const shared = ticks.filter(t => t >= t0 + DAY);
        if (shared.some(t => !again.ticks.includes(t))) bad.push(`ticks moved when the window panned a day — ${where}`);
      }
    }
  }
  return { bad, steps: [...seen].sort((a, b) => a - b) };
}

function boundaryCases() {
  const A = window.ArroData;
  const L = (y, m, d) => new Date(y, m, d).getTime();
  const show = cal => cal.lines.map(l => {
    const d = new Date(l.t);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} ${l.kind}`;
  });
  return {
    // 1 Oct 2026 is a Thursday, 1 Nov a Sunday: the 1sts are month lines,
    // the Mondays week lines, and nothing else.
    autumn: A.calBounds(L(2026, 9, 1), L(2026, 10, 15), 1200),
    autumnShow: show(A.calBounds(L(2026, 9, 1), L(2026, 10, 15), 1200)),
    // New Year's Day 2027 is a Friday: a year line, not a month's, and the
    // Mondays either side of it weeks'.
    newYear: show(A.calBounds(L(2026, 11, 26), L(2027, 0, 12), 900)),
    // Three months on 400 px puts a week 31 px apart: months only.
    narrow: A.calBounds(L(2026, 9, 10), L(2027, 0, 10), 400),
    narrowShow: show(A.calBounds(L(2026, 9, 10), L(2027, 0, 10), 400)),
    // …and on 1200 px, 92 px apart: weeks again.
    wide: A.calBounds(L(2026, 9, 10), L(2027, 0, 10), 1200).level,
    // Eleven years on 1000 px: a month is 8 px, a year 91 — years only.
    decade: A.calBounds(L(2020, 5, 1), L(2031, 5, 1), 1000),
    decadeShow: show(A.calBounds(L(2020, 5, 1), L(2031, 5, 1), 1000)),
    // A six-hour window over a Monday midnight still draws it.
    night: show(A.calBounds(L(2026, 10, 1) + 21 * 36e5, L(2026, 10, 2) + 3 * 36e5, 1000)),
    // …and one with no boundary in it draws nothing, at the week level.
    quiet: A.calBounds(L(2026, 9, 27), L(2026, 9, 29), 1000),
    // Bad input is no lines, not a hang.
    empty: A.calBounds(5, 5, 1000).lines.length + A.calBounds(NaN, 5, 1000).lines.length
         + A.calBounds(0, 1e12, 0).lines.length,
  };
}

try {
  for (const tz of ['Australia/Brisbane', 'Australia/Sydney']) {
    console.log(`\n${tz}`);
    const { context, page } = await openPlots(tz);
    const r = await page.evaluate(tickRules);
    ok(`ticks over ${r.steps.length} step sizes, minutes to a year, each on the calendar the step promises`,
       r.bad.length === 0, r.bad.slice(0, 8).join('\n         '));
    ok('…and the windows tried reach every kind of step: minutes, hours, days, weeks, months',
       r.steps.some(s => s < 36e5) && r.steps.some(s => s >= 36e5 && s < 864e5)
       && r.steps.includes(864e5) && r.steps.includes(7 * 864e5) && r.steps.some(s => s >= 30 * 864e5),
       r.steps.join(', '));

    const b = await page.evaluate(boundaryCases);
    ok('six weeks of spring: weeks drawn, each Monday and each 1st at local midnight',
       b.autumn.level === 'week' && JSON.stringify(b.autumnShow) === JSON.stringify([
         '2026-10-1 0:00 month', '2026-10-5 0:00 week', '2026-10-12 0:00 week', '2026-10-19 0:00 week',
         '2026-10-26 0:00 week', '2026-11-1 0:00 month', '2026-11-2 0:00 week', '2026-11-9 0:00 week']),
       `${b.autumn.level}: ${b.autumnShow.join(' · ')}`);
    ok('New Year\'s Day is a year line, not a month\'s or a week\'s, and the Mondays either side weeks\'',
       JSON.stringify(b.newYear) === JSON.stringify(['2026-12-28 0:00 week', '2027-1-1 0:00 year',
                                                     '2027-1-4 0:00 week', '2027-1-11 0:00 week']),
       b.newYear.join(' · '));
    ok('three months on 400 px: weeks too close, so months only',
       b.narrow.level === 'month' && JSON.stringify(b.narrowShow) === JSON.stringify(
         ['2026-11-1 0:00 month', '2026-12-1 0:00 month', '2027-1-1 0:00 year']),
       `${b.narrow.level}: ${b.narrowShow.join(' · ')}`);
    ok('…the same three months on 1200 px: weeks again', b.wide === 'week', b.wide);
    ok('eleven years on 1000 px: years only, every 1 January in it',
       b.decade.level === 'year' && b.decadeShow.length === 11
       && b.decadeShow.every((s, i) => s === `${2021 + i}-1-1 0:00 year`),
       `${b.decade.level}: ${b.decadeShow.join(' · ')}`);
    ok('a six-hour window over Monday midnight draws that line', JSON.stringify(b.night) === '["2026-11-2 0:00 week"]',
       b.night.join(' · '));
    ok('a window with no boundary in it draws none', b.quiet.level === 'week' && b.quiet.lines.length === 0,
       JSON.stringify(b.quiet));
    ok('a window of no width, an unreadable one, or no plot to draw on: no lines', b.empty === 0, String(b.empty));

    if (tz !== 'Australia/Brisbane') { await context.close(); continue; }

    // ── 2. The chart as drawn ────────────────────────────────────────────────
    await page.evaluate(async () => {
      switchTab('arrodata');
      await new Promise(r => setTimeout(r, 60));
      await window.ArroData.loadDemo();
    });
    await page.waitForFunction(() => window.ArroData.ad.series.length > 0, null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(200);

    const drawn = async frac => {
      await page.evaluate(([a, b]) => {
        const A = window.ArroData, s = A.ad.series[0];
        const t0 = s.t[0], t1 = s.t[s.n - 1];
        A.ad.view = a == null ? null : { t0: t0 + (t1 - t0) * a, t1: t0 + (t1 - t0) * b };
        // repaint() redraws the picture; unpin() the readout under it too,
        // as a pan or a zoom does in the same frame.
        A.repaint();
        A.unpin();
      }, frac);
      return page.evaluate(() => {
        const svg = document.getElementById('ad-svg');
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        return {
          w: vb[2], h: vb[3],
          view: { ...window.ArroData.ad.view },
          ticks: [...svg.querySelectorAll('text.ad-xtick')].map(t => ({
            t: +t.dataset.t, x: +t.getAttribute('x'), y: +t.getAttribute('y'),
            label: t.firstChild ? t.firstChild.textContent : '',
            day: t.querySelector('.ad-xtick-day')?.textContent ?? null })),
          lines: [...svg.querySelectorAll('line.ad-cal')].map(l => ({
            t: +l.dataset.t, x: +l.getAttribute('x1'), kind: l.getAttribute('class').split('--')[1],
            title: l.querySelector('title')?.textContent || '' })),
          labels: [...svg.querySelectorAll('text.ad-cal-label')].map(t => ({ t: +t.dataset.t, text: t.textContent,
            y: +t.getAttribute('y') })),
          key: (k => k ? { text: k.textContent.replace(/\s+/g, ' ').trim(), title: k.getAttribute('title'),
                           sw: k.querySelectorAll('.ad-cal-sw').length } : null)(
            document.querySelector('#ad-readout .ad-cal-key')),
        };
      });
    };

    // Three weeks: the chart's ticks are days or weeks apart, every one with its day.
    let c = await drawn([0.40, 0.40 + 21 / 213]);
    ok('three weeks: every time label carries a day', c.ticks.length >= 3 && c.ticks.every(t => t.day),
       JSON.stringify(c.ticks.map(t => [t.label, t.day])));
    ok('…the day its own instant falls on', c.ticks.every(t => t.day === DAYS[new Date(t.t).getDay()]),
       c.ticks.filter(t => t.day !== DAYS[new Date(t.t).getDay()]).map(t => `${t.label}=${t.day}`).join(' '));
    ok('…a line under the date, inside the chart', c.ticks.every(t => t.y + 12 < c.h),
       `label baseline ${c.ticks[0]?.y}, chart ${c.h} tall`);
    const mondays = (() => {
      const out = [];
      const d = new Date(c.view.t0); d.setHours(0, 0, 0, 0);
      for (; d.getTime() <= c.view.t1; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === 1 && d.getTime() >= c.view.t0) out.push(d.getTime());
      }
      return out;
    })();
    const weekLines = c.lines.filter(l => l.kind === 'week' || (l.kind !== 'week' && new Date(l.t).getDay() === 1));
    ok(`…a line at each of the ${mondays.length} Monday midnights in view`,
       mondays.length >= 2 && JSON.stringify(weekLines.map(l => l.t)) === JSON.stringify(mondays),
       `lines ${weekLines.map(l => new Date(l.t).toString().slice(0, 21)).join(' · ')}`);
    ok('…each inside the plot', c.lines.every(l => l.x >= 64 && l.x <= c.w - 18), c.lines.map(l => l.x).join(' '));
    const onTick = c.lines.map(l => [l, c.ticks.find(t => t.t === l.t)]).filter(([, t]) => t);
    ok('…and where a tick names the same instant, on that tick',
       onTick.length >= 1 && onTick.every(([l, t]) => Math.abs(l.x - t.x) < 0.11),
       onTick.map(([l, t]) => `${l.x}/${t.x}`).join(' ') || 'no tick at a Monday');
    ok('…which says MON', onTick.every(([, t]) => t.day === 'MON'), onTick.map(([, t]) => t.day).join(' '));
    ok('…with what it is on hover', c.lines.every(l => /^(A week starts|\w+ starts) — \w+day \d+ \w+ \d{4}, 00:00$/.test(l.title)),
       c.lines.map(l => l.title).join(' | '));

    // Ten days: the ticks a day or two apart, so the days differ.
    c = await drawn([0.52, 0.52 + 10 / 213]);
    const names = new Set(c.ticks.map(t => t.day));
    ok('ten days: the labels name several different days', names.size >= 3 && c.ticks.every(t => t.day === DAYS[new Date(t.t).getDay()]),
       JSON.stringify(c.ticks.map(t => [t.label, t.day])));
    ok('…each at local midnight', c.ticks.every(t => new Date(t.t).getHours() === 0 && new Date(t.t).getMinutes() === 0),
       c.ticks.map(t => new Date(t.t).toString().slice(16, 21)).join(' '));

    // The key, in the readout under the chart.
    ok('the key under the chart names the lines that are on it',
       c.key && /week starts \(Mon 00:00\)/.test(c.key.text) && c.key.sw >= 1 && /calendar turns over/.test(c.key.title),
       JSON.stringify(c.key));

    // Zoomed out over the whole record and past it: weeks give way to months.
    c = await drawn([-0.5, 1.5]);
    ok('fourteen months: no week lines, a line at each 1st', c.lines.length >= 6
       && c.lines.every(l => l.kind !== 'week') && c.lines.every(l => new Date(l.t).getDate() === 1 && new Date(l.t).getHours() === 0),
       c.lines.map(l => `${new Date(l.t).toDateString()} ${l.kind}`).join(' · '));
    ok('…each named over the plot, a month by its name and 1 January by its year',
       c.labels.length === c.lines.length && c.labels.every(lb => {
         const d = new Date(lb.t);
         return lb.text === (d.getMonth() ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
                                          : String(d.getFullYear())) && lb.y < 36;
       }), JSON.stringify(c.labels.map(l => l.text)));
    ok('…and at a month a tick, no day under the labels', c.ticks.length > 0 && c.ticks.every(t => t.day === null),
       JSON.stringify(c.ticks.map(t => [t.label, t.day])));
    ok('…and the key no longer offers weeks', c.key && /month starts/.test(c.key.text) && !/week starts/.test(c.key.text),
       JSON.stringify(c.key));

    // The side-by-side panes draw the same lines.
    c = await drawn([0.40, 0.40 + 21 / 213]);
    const cmp = await page.evaluate(() => {
      const box = document.getElementById('ad-compare');
      if (!box) return null;
      box.open = true;
      window.ArroData.compareToggle(box);
      const pane = id => {
        const svg = document.getElementById(id);
        return { lines: svg.querySelectorAll('line.ad-cal').length,
                 days: [...svg.querySelectorAll('text.ad-xtick')].map(t => [+t.dataset.t, t.querySelector('.ad-xtick-day')?.textContent]) };
      };
      return { raw: pane('ad-cmp-raw'), filt: pane('ad-cmp-filt') };
    });
    ok('the side-by-side panes draw the week lines too', cmp && cmp.raw.lines >= 2 && cmp.filt.lines === cmp.raw.lines,
       JSON.stringify(cmp && { raw: cmp.raw.lines, filt: cmp.filt.lines }));
    ok('…and the days under their labels', cmp && cmp.raw.days.length > 0
       && cmp.raw.days.every(([t, d]) => d === DAYS[new Date(t).getDay()]), JSON.stringify(cmp && cmp.raw.days));

    // The balloon over the chart says the day of the reading it follows.
    const box = await page.locator('#ad-svg').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(120);
    const tip = await page.evaluate(() => document.querySelector('#ad-tip .ad-tip-t')?.textContent || '');
    ok('the hover balloon starts with the day', /^(SUN|MON|TUE|WED|THU|FRI|SAT) \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(tip), tip);

    ok('nothing threw', errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failures
  ? `\nFAIL — ${failures} check(s) failed.`
  : '\nPASS — the time axis ticks on the local calendar in both zones, every date on it\n'
    + '       carries its day, and a heavier line marks each Monday, each 1st and each\n'
    + '       1 January — weeks giving way to months, then years, as the window widens.');
process.exit(failures ? 1 : 0);
