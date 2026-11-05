// MegaNet — admin-costs.js
//
//   AdminCosts   the Admin tab's Running costs: every paid service Flood-Net
//                runs on, the plan it is on, what that likely costs a month,
//                how sure that figure is, and what would make it cost more.
//
// After core.js, before admin.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr and termHtml; to auth.js for Auth.
// admin.js draws it (AdminCosts.render into #adm-costs) and repaints it on a
// sign-in or sign-out. Nothing here runs at load, and it asks nothing of the
// database: the figures are written here, from the docs and the price lists.
//
// Where the figures come from, as read on CHECKED. The plans: Supabase's from
// its connector (the organisation's plan), ElevenLabs's from the Bulletin
// voices run log (tools/voice/speak.mjs prints the tier and the credits left),
// the Anthropic key's from /api/briefing's own answer (503 not_configured), the
// Claude plan, its share and the registrar from the owner, and the rest from
// wrangler.toml, bridge/fly.toml and the docs —
// docs/datastore-decision.md (Supabase Pro), docs/mqtt-provisioning.md
// (HiveMQ, Fly.io), docs/accounts.md (Resend), docs/access.md (Cloudflare
// Access, the Anthropic key's US$20 a day), docs/field-photos.md and
// docs/data-archive.md (R2), worker/rain-ahead.js (Open-Meteo). The prices:
// each service's own pricing page on CHECKED. A service whose bill nobody has
// read yet says so (`sure: 'ask'`) rather than guessing.
//
// The paid-to-date figure (here and on the Admin dashboard's Costs to date
// tile) counts each paid row's charges from its `paid.since` to today: a
// month's or a year's charge on each anniversary of that date, or, for pay as
// you go, the months gone by. The start dates: the Claude plan from the day the
// repository was made (22 Jun 2026; when Max started is the owner's to say),
// Supabase Pro from the commit that first said so (3180804, 23 Oct 2026),
// ElevenLabs from the first voicing run (25 Oct 2026, the day its credits
// renew), the Fly.io bridge from its first deploy (19 Aug 2026), the domain
// from its registration (26 Feb 2026). A date nobody has confirmed carries
// `guess: true`, and the figure says so.
//
// Every service bills in US dollars; the panel shows Australian dollars, the
// way the card statement does. Each charge is turned into A$ at the Reserve
// Bank's average exchange rate for the month it was paid (its table F11.1: A$1
// in US$ at 4 pm each business day, from WM/Reuters —
// https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv, the month's
// daily rates averaged), then the international transaction fee most
// Australian banks' cards add to a payment in another currency (3%) goes on
// top. A month's figure, and a price in the words, is at this month's rate. A
// month after the last in USD_PER_AUD uses the last one's: add the months since
// whenever CHECKED moves. The card scheme's own rate on the day is usually
// within about half a percent of the Reserve Bank's, and a single day can sit a
// percent or two either side of its month's average.
//
// When a plan or a price changes, change its row and CHECKED together; the
// total and the counts are worked out from the rows.
const AdminCosts = (function () {

  const CHECKED = '2026-11-04';

  // ── Australian dollars ──

  // A$1 in US$, each month's average of the Reserve Bank's daily rate (F11.1,
  // published 4 Nov 2026; November is its first three business days).
  const FX_READ = '2026-11-04';
  const USD_PER_AUD = {
    '2026-02': 0.7055, '2026-03': 0.7024, '2026-04': 0.7090, '2026-05': 0.7180,
    '2026-06': 0.7026, '2026-07': 0.6963, '2026-08': 0.7102, '2026-09': 0.7126,
    '2026-10': 0.6989, '2026-11': 0.6990,
  };
  const CARD_FEE = 0.03;
  const FX_MONTHS = Object.keys(USD_PER_AUD).sort();

  // Today in Brisbane, as YYYY-MM-DD (Queensland keeps no daylight saving).
  const brisbaneToday = () => new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = iso => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
  const monthName = ym => `${MON[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
  const thisMonth = () => brisbaneToday().slice(0, 7);

  // The month's rate, or the nearest month the table has.
  function rateFor(ym) {
    if (USD_PER_AUD[ym]) return USD_PER_AUD[ym];
    const before = FX_MONTHS.filter(m => m <= ym);
    return USD_PER_AUD[before.length ? before[before.length - 1] : FX_MONTHS[0]];
  }
  // A US$ charge paid in month `ym`, in A$ with the card fee on top.
  const toAud = (usd, ym = thisMonth()) => usd / rateFor(ym) * (1 + CARD_FEE);

  // A US$ price in the words, in A$ at this month's rate with the fee: whole
  // dollars, or cents for a small price with cents in it.
  function aud(usd) {
    const a = toAud(usd);
    return a < 10 && !Number.isInteger(usd) ? `A$${a.toFixed(2)}` : `A$${Math.round(a).toLocaleString('en-AU')}`;
  }
  // A plan's price in A$, and as its bill and price list say it.
  const both = usd => `${aud(usd)} (US$${usd})`;

  // How sure each figure is. Carried by a word in a chip as well as by its
  // colour, and the same meaning on hover and in the fold below.
  const SURE = {
    confirmed: { label: 'Confirmed', tone: 'ok',
      meaning: 'The plan was read from the service itself (its connector, a run log or the Worker’s own answer) or given by the owner, on the date at the foot, and the price from its price list. The bill may still add GST or usage on top.' },
    estimate: { label: 'Estimate', tone: 'warn',
      meaning: 'Worked out from Flood-Net’s own settings and docs and the service’s price list, not read from a bill. The invoice may differ by a few dollars.' },
    ask: { label: 'Needs the bill', tone: 'bad',
      meaning: 'Only the account’s invoice or usage page can say this one: nothing in Flood-Net’s docs or settings records it.' },
    free: { label: 'Free', tone: 'muted',
      meaning: 'On the service’s free plan: it costs nothing until Flood-Net goes past the limit in the last column.' },
  };

  // The other words on the panel that mean something particular here. One
  // list: the hovers and the fold are both made from it.
  const WORDS = {
    month: 'What the service bills for one month at Flood-Net’s use now, in Australian dollars before GST: its US$ price at this month’s exchange rate, with the 3% card fee on top. The US$ under it is the bill’s own figure. A range means the price list gives one, or the use moves it.',
    compute: `The size of the database’s server — its memory and processor — which Supabase bills by the hour on top of the plan. The Pro plan’s monthly credit (US$10) pays for the smallest, Micro.`,
    credits: 'ElevenLabs’ unit of voicing: about one credit for each character said. The plan gives a set number a month; when they run out the bulletins and videos play silent until the next month starts.',
    payg: 'Billed only for what runs, by the second, with no monthly fee and no free allowance.',
    todate: 'What has been paid for Flood-Net so far, in Australian dollars before GST: each monthly or yearly charge from the day the service started being paid up to today, and the months gone by for pay as you go — each one at the exchange rate of the month it was paid, with the 3% card fee on top. ≈ means a range, or a start date nobody has confirmed.',
    fx: `What A$1 buys in US dollars: the Reserve Bank of Australia’s average over the month’s business days (its table F11.1, published ${day(FX_READ)}). Each charge uses its own month’s rate; a month the table has not reached yet uses the latest. The card’s own rate on the day is usually within about half a percent of it.`,
    fee: 'The international transaction fee: 3% of the payment, which most Australian banks’ cards add to a bill in another currency, even one paid online from here. On a card without the fee every A$ figure would be about 3% lower.',
    guess: 'A start date nobody has confirmed: worked out from Flood-Net’s own history (the day the repository was made). The figure moves when the real date is known.',
  };
  const WORD_LABELS = [
    ['month', 'A month'], ['todate', 'To date'], ['fx', 'Exchange rate'], ['fee', 'Card fee'], ['guess', 'A guess'],
    ['compute', 'Compute'], ['credits', 'Credits'], ['payg', 'Pay as you go'],
  ];

  // One row a service, dearest first. `month` is [low, high] in US dollars, as
  // the bill says it, or null where only the bill can say; `paid.each` and
  // `paid.first` are US$ too. `more` is what would make it cost more, its
  // prices in A$ at this month's rate.
  const SERVICES = [
    {
      name: 'Claude (Claude Code)', short: 'Claude', bill: 'https://claude.ai/settings/billing',
      for: 'The scheduled sessions — the daily and weekly bulletins, the CI doctor every four hours, the nightly photo reader — and the work on Flood-Net itself.',
      plan: () => `Max (5×), ${both(100)} a month before tax; about 95% of its use is Flood-Net’s (the owner, 4 Nov 2026)`,
      month: [95, 95], sure: 'confirmed',
      paid: { since: '2026-06-22', every: 'month', each: [95, 95], guess: true },
      more: () => `The share is the owner’s reckoning of a plan used for other work too. Ultra, ${both(200)} a month, if the scheduled sessions and the building outgrow Max.`,
    },
    {
      name: 'Supabase', bill: 'https://supabase.com/dashboard/org/_/billing',
      for: 'The database, sign-in and accounts, and the data every tab and the agent API read.',
      plan: () => `Pro, one project; ${termHtml('compute', WORDS.compute)} covered by the plan’s ${both(10)} credit`,
      month: [25, 25], sure: 'confirmed',
      paid: { since: '2026-10-23', every: 'month', each: [25, 25] },
      more: () => `Disk past the 8 GB included (about ${aud(0.125)} a GB); a Small compute size for the Disk IO budget (#255) about ${aud(5)} more, Medium about ${aud(50)} more; each other active project in the same organisation bills its own compute (about ${aud(10)}); egress past 250 GB.`,
    },
    {
      name: 'ElevenLabs', bill: 'https://elevenlabs.io/app/subscription',
      for: 'The voices of the network bulletins and the 🎬 Videos.',
      plan: () => `Starter (the voicing run’s log: 40,000 ${termHtml('credits', WORDS.credits)} this month)`,
      month: [6, 6], sure: 'confirmed',
      paid: { since: '2026-10-25', every: 'month', each: [6, 6], first: [1, 6] },
      more: () => `A daily bulletin takes about 800 credits, a weekly about 1,200, a video 400–900 once. Run out and they play silent until the month turns; Creator is ${both(22)} for 121,000.`,
    },
    {
      name: 'Fly.io', bill: 'https://fly.io/dashboard',
      for: 'The MQTT bridge: one small machine in Sydney that passes the broker’s readings to the database.',
      plan: () => `${termHtml('Pay as you go', WORDS.payg)}: one shared-cpu-1x machine, 256 MB, always on`,
      month: [2, 3], sure: 'estimate',
      paid: { since: '2026-08-19', every: 'use', each: [2, 3] },
      more: () => `${both(2.19)} a month in Fly’s US regions, a little more in Sydney. A second machine, or a bigger one, about doubles it.`,
    },
    {
      name: 'floodwarning.net', bill: 'https://dash.cloudflare.com/?to=/:account/domains',
      for: 'The domain the site, the Worker and the agent API answer on.',
      plan: () => 'A .net at Cloudflare Registrar, at cost; registered 26 Feb 2026, for a year as the owner remembers it',
      month: [1, 1], sure: 'estimate',
      paid: { since: '2026-02-26', every: 'year', each: [11, 13] },
      more: () => `About ${both(12)} a year. It renews about 26 Feb 2027: check auto-renew is on and the card on file is current — a lapsed domain takes the whole site with it.`,
    },
    {
      name: 'Anthropic API', bill: 'https://platform.claude.com',
      for: 'Station Health’s AI briefing on Flood-Net’s own key (/api/briefing), for editors and administrators.',
      plan: () => 'Not set up: on 4 Nov 2026 /api/briefing answered that ANTHROPIC_API_KEY is missing, so every briefing runs on the person’s own key',
      month: [0, 0], sure: 'confirmed',
      more: () => `Set the key (docs/access.md) and the briefings are Flood-Net’s: pay per use at ${aud(4)} a million tokens in and ${aud(20)} out (US$4 and US$20), probably well under a dollar a briefing (the tab shows each one’s cost in US$), held to ${both(20)} a Brisbane day.`,
    },
    {
      name: 'Cloudflare', bill: 'https://dash.cloudflare.com/?to=/:account/billing',
      for: 'The site and its Worker (/api/*), R2 for the field photos and the data archive, Access in front of the site, the rate limits and DNS.',
      plan: () => 'Workers Free; R2’s free 10 GB; Zero Trust free to 50 people',
      month: [0, 0], sure: 'free',
      more: () => `R2 past 10 GB, about ${aud(0.015)} a GB a month (100 GB of photos is about ${aud(1.5)}); Workers Paid, ${both(5)} a month, if the Free plan’s 100,000 requests a day or 10 ms of CPU stop being enough; Access past 50 people, about ${aud(7)} a person a month.`,
    },
    {
      name: 'Resend', bill: 'https://resend.com/settings/billing',
      for: 'Account emails (confirm your address, reset a password) and the agent API’s notify list.',
      plan: () => 'Free: 100 emails a day, 3,000 a month',
      month: [0, 0], sure: 'free',
      more: () => `Pro, ${both(20)} a month, once a day’s sign-ups or a changelog email to the list pass 100 a day.`,
    },
    {
      name: 'HiveMQ Cloud', bill: 'https://console.hivemq.cloud/',
      for: 'The MQTT broker the stations and gateways publish to.',
      plan: () => 'Serverless, free: 100 connections, 10 GB a month',
      month: [0, 0], sure: 'free',
      more: 'One connection a publishing station, plus the bridge: near 100 of them, Starter, billed by the hour.',
    },
    {
      name: 'Open-Meteo', bill: 'https://open-meteo.com/en/pricing',
      for: 'The rain forecast on Station Health’s Rain ahead (ECMWF’s model, through the Worker).',
      plan: () => 'The free API: non-commercial use, 10,000 calls a day',
      month: [0, 0], sure: 'free',
      more: () => `Commercial use needs a subscription (Standard, about ${both(29)} a month); the OPEN_METEO_KEY secret switches the Worker to it.`,
    },
    {
      name: 'GitHub', bill: 'https://github.com/settings/billing',
      for: 'The code, the Actions that test, voice, sync and archive, and the github.io copy.',
      plan: () => 'Free: Actions cost nothing on a public repository',
      month: [0, 0], sure: 'free',
      more: 'Only the private archive repository’s Actions count, against 2,000 free minutes a month.',
    },
    {
      name: 'Maps, routes and open data', bill: '',
      for: 'OpenStreetMap and Esri base maps, FOSSGIS’s Valhalla routes, the ACMA register, ELVIS elevation, the council cameras; the field-photo syncs read crews’ own Google Drive and Dropbox folders.',
      plan: () => 'Free under each one’s terms, with its credit on the map',
      month: [0, 0], sure: 'free',
      more: 'Nothing billed. Valhalla allows Flood-Net a request a second, which the Worker keeps to.',
    },
  ];

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn()
      && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  // ── formatting ──

  const range = (lo, hi) => lo === hi ? `${lo}` : `${lo}–${hi}`;

  // A row's month now in A$, [low, high] whole dollars, or null.
  const monthAud = s => s.month && s.month.map(x => Math.round(toAud(x)));

  function chip(k) {
    const s = SURE[k];
    return `<span class="term-chip adm-sure adm-sure--${s.tone}" title="${escAttr(s.meaning)}">${esc(s.label)}</span>`;
  }

  // ── paid to date ──

  const addMonths = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  };

  // One row's charges from its start to `today`, each { ym, usd: [low, high] }:
  // a month's or a year's charge on each anniversary of `since`, the first one
  // `first` when the row has it; for pay as you go, the use in each calendar
  // month, so each month's share goes at that month's rate.
  function charges(row, today) {
    const p = row.paid, out = [];
    if (!p || p.since > today) return out;
    if (p.every === 'use') {
      for (let from = p.since; from < today;) {
        const next = addMonths(`${from.slice(0, 7)}-01`, 1);
        const to = next < today ? next : today;
        const months = (Date.parse(to) - Date.parse(from)) / (30.44 * 864e5);
        out.push({ ym: from.slice(0, 7), usd: p.each.map(x => x * months) });
        from = to;
      }
      return out;
    }
    const step = p.every === 'year' ? 12 : 1;
    for (let n = 0, d = p.since; d <= today; d = addMonths(p.since, ++n * step)) {
      out.push({ ym: d.slice(0, 7), usd: n === 0 && p.first ? p.first : p.each });
    }
    return out;
  }

  // One row's charges from its start to `today`: [low, high] A$, each charge at
  // its own month's rate with the card fee; the same in US$, as the bills say
  // it; and how many charges (none counted for pay as you go).
  function paidSoFar(row, today = brisbaneToday()) {
    const list = charges(row, today);
    const sum = f => Math.round(list.reduce((a, c) => a + f(c), 0));
    return {
      lo: sum(c => toAud(c.usd[0], c.ym)), hi: sum(c => toAud(c.usd[1], c.ym)),
      usd: { lo: sum(c => c.usd[0]), hi: sum(c => c.usd[1]) },
      charges: row.paid && row.paid.every !== 'use' ? list.length : 0,
    };
  }

  // Everything paid so far and a month now, for this panel and the dashboard.
  function summary(today = brisbaneToday()) {
    const t = totals();
    const paid = SERVICES.filter(x => x.paid);
    const sums = paid.map(x => paidSoFar(x, today));
    return {
      today,
      lo: sums.reduce((a, x) => a + x.lo, 0),
      hi: sums.reduce((a, x) => a + x.hi, 0),
      usd: { lo: sums.reduce((a, x) => a + x.usd.lo, 0), hi: sums.reduce((a, x) => a + x.usd.hi, 0) },
      month: { lo: t.lo, hi: t.hi },
      since: paid.map(x => x.paid.since).sort()[0] || null,
      guessed: paid.filter(x => x.paid.guess).map(x => x.short || x.name),
    };
  }

  // An A$ range for a big figure: one number, ≈ when it is a range or rests on
  // a guessed date, rounded to the ten when it is.
  function bigAud(lo, hi, rough) {
    if (lo === hi && !rough) return `A$${lo.toLocaleString('en-AU')}`;
    const mid = Math.round((lo + hi) / 2 / 10) * 10;
    return `≈ A$${mid.toLocaleString('en-AU')}`;
  }
  // What is known so far, the rows the bill still has to say, and the free ones.
  // The month in A$ is the rows' own A$ figures added up, so the column adds.
  function totals() {
    const known = SERVICES.filter(s => s.month);
    const a = known.map(monthAud);
    return {
      lo: a.reduce((x, m) => x + m[0], 0),
      hi: a.reduce((x, m) => x + m[1], 0),
      usd: { lo: known.reduce((x, s) => x + s.month[0], 0), hi: known.reduce((x, s) => x + s.month[1], 0) },
      month: thisMonth(),
      paid: known.filter(s => s.month[1] > 0).length,
      ask: SERVICES.filter(s => !s.month).map(s => s.name),
      free: SERVICES.filter(s => s.sure === 'free').length,
    };
  }

  // ── the panel ──

  // The money and how sure it is come straight after the name, so a phone
  // shows them before the table has to scroll sideways.

  // The A$ figure, and the bill's own US$ under it.
  function monthCell(s) {
    if (!s.month) return '?';
    if (!s.month[1]) return '0';
    const [lo, hi] = monthAud(s);
    return `${range(lo, hi)}<div class="small txt-muted adm-cost-sub">US$${range(...s.month)}</div>`;
  }

  function toDateCell(s) {
    if (!s.paid) return '0';
    const r = paidSoFar(s);
    return `${range(r.lo, r.hi)}<div class="small txt-muted adm-cost-sub">US$${range(r.usd.lo, r.usd.hi)} since ${esc(day(s.paid.since))}${
      s.paid.guess ? ` (${termHtml('a guess', WORDS.guess)})` : ''}</div>`;
  }

  function row(s) {
    const name = s.bill
      ? `<a href="${escAttr(s.bill)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
      : esc(s.name);
    return `<tr>
      <th scope="row">${name}<div class="small txt-muted adm-cost-for">${esc(s.for)}</div></th>
      <td class="adm-cost-usd">${monthCell(s)}</td>
      <td class="adm-cost-usd">${toDateCell(s)}</td>
      <td>${chip(s.sure)}</td>
      <td>${s.plan()}</td>
      <td class="small">${esc(typeof s.more === 'function' ? s.more() : s.more)}</td>
    </tr>`;
  }

  function render() {
    const head = `<div class="panel-header"><h2 id="adm-costs-h">Running costs</h2></div>`;
    if (!isAdmin()) {
      return `<div class="panel">${head}<p class="small">Every service Flood-Net runs on and what it costs a month —
        for administrators. ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? ''
          : '<a href="#" onclick="Auth.open();return false">Sign in</a> as one to see it.'}</p></div>`;
    }
    const t = totals(), sum = summary();
    const total = range(t.lo, t.hi);
    const rate = rateFor(t.month);
    return `
      <div class="panel adm-costs">
        ${head}
        <div class="adm-kpis">
          <div class="adm-kpi"><div class="adm-kpi-label">${termHtml('Paid to date', WORDS.todate)}</div>
            <div class="adm-kpi-value">${bigAud(sum.lo, sum.hi, sum.guessed.length > 0)}</div>
            <div class="adm-kpi-sub">${sum.lo === sum.hi ? '' : `A$${sum.lo}–${sum.hi} · `}US$${range(sum.usd.lo, sum.usd.hi)} on the bills · since ${esc(day(sum.since))}${
              sum.guessed.length ? ` · ${esc(sum.guessed.join(' and '))}’s start a guess` : ''}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">${t.ask.length ? 'Known so far' : 'All told'}</div>
            <div class="adm-kpi-value">A$${total} <small>a month</small></div>
            <div class="adm-kpi-sub">${t.paid} paid services, US$${range(t.usd.lo, t.usd.hi)} at ${esc(monthName(t.month))}’s rate, before GST</div></div>
          <div class="adm-kpi${t.ask.length ? ' adm-kpi--warn' : ''}"><div class="adm-kpi-label">Not known yet</div>
            <div class="adm-kpi-value">${t.ask.length}</div>
            <div class="adm-kpi-sub">${t.ask.length ? `${esc(t.ask.join(' and '))}: only the bill says` : 'every service has a figure'}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">Free for now</div>
            <div class="adm-kpi-value">${t.free}</div>
            <div class="adm-kpi-sub">until a limit in the last column</div></div>
        </div>
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-costs-h">
          <table class="adm-table adm-costs-table">
            <thead><tr>
              <th scope="col">Service</th>
              <th scope="col">${termHtml('A month', WORDS.month)} (A$)</th>
              <th scope="col">${termHtml('To date', WORDS.todate)} (A$)</th>
              <th scope="col">How sure</th>
              <th scope="col">Plan</th>
              <th scope="col">When it costs more</th>
            </tr></thead>
            <tbody>${SERVICES.map(row).join('')}</tbody>
          </table>
        </div>
        <p class="small txt-muted">Plans and prices as read on ${esc(CHECKED)}, from each service’s price list and
          Flood-Net’s own settings and docs. A service’s name opens its billing page. Every service bills in US
          dollars: each charge is in A$ at the ${termHtml('exchange rate', WORDS.fx)} of the month it was paid
          (A$1 = US$${rate.toFixed(4)} in ${esc(monthName(t.month))}), with the 3% ${termHtml('card fee', WORDS.fee)}
          on top.</p>
        <details class="adm-why">
          <summary>What the words on this panel mean</summary>
          <dl class="adm-words">
            ${Object.values(SURE).map(s => `<dt>${esc(s.label)}</dt><dd>${esc(s.meaning)}</dd>`).join('')}
            ${WORD_LABELS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}
          </dl>
        </details>
        <details class="adm-why adm-fx">
          <summary>The exchange rates behind the A$ figures</summary>
          <p>The Reserve Bank of Australia’s average for each month (table F11.1, published ${esc(day(FX_READ))}),
            and what a US$100 bill paid that month costs with the 3% card fee.</p>
          <dl class="adm-words">
            ${FX_MONTHS.map(m => `<dt>${esc(monthName(m))}</dt><dd>A$1 = US$${USD_PER_AUD[m].toFixed(4)} · US$100 costs A$${toAud(100, m).toFixed(2)}</dd>`).join('')}
          </dl>
        </details>
      </div>`;
  }

  return { render, totals, summary, paidSoFar, bigAud, toAud, day, SERVICES, CHECKED, WORDS, USD_PER_AUD, CARD_FEE };
})();
