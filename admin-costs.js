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
// and the rest from wrangler.toml, bridge/fly.toml and the docs —
// docs/datastore-decision.md (Supabase Pro), docs/mqtt-provisioning.md
// (HiveMQ, Fly.io), docs/accounts.md (Resend), docs/access.md (Cloudflare
// Access, the Anthropic key's US$20 a day), docs/field-photos.md and
// docs/data-archive.md (R2), worker/rain-ahead.js (Open-Meteo). The prices:
// each service's own pricing page on CHECKED. A service whose bill nobody has
// read yet says so (`sure: 'ask'`) rather than guessing.
//
// When a plan or a price changes, change its row and CHECKED together; the
// total and the counts are worked out from the rows.
const AdminCosts = (function () {

  const CHECKED = '2026-11-04';

  // How sure each figure is. Carried by a word in a chip as well as by its
  // colour, and the same meaning on hover and in the fold below.
  const SURE = {
    confirmed: { label: 'Confirmed', tone: 'ok',
      meaning: 'The plan was read from the service itself (its connector or a run log) on the date at the foot, and the price from its price list. The bill may still add GST or usage on top.' },
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
    month: 'What the service bills for one month at Flood-Net’s use now, in US dollars and before GST. A range means the price list gives one, or the use moves it.',
    compute: 'The size of the database’s server — its memory and processor — which Supabase bills by the hour on top of the plan. The Pro plan’s US$10 a month credit pays for the smallest, Micro.',
    credits: 'ElevenLabs’ unit of voicing: about one credit for each character said. The plan gives a set number a month; when they run out the bulletins and videos play silent until the next month starts.',
    payg: 'Billed only for what runs, by the second, with no monthly fee and no free allowance.',
  };
  const WORD_LABELS = [
    ['month', 'A month'], ['compute', 'Compute'], ['credits', 'Credits'], ['payg', 'Pay as you go'],
  ];

  // One row a service, dearest first. `month` is [low, high] in US dollars, or
  // null where only the bill can say; `more` is what would make it cost more.
  const SERVICES = [
    {
      name: 'Supabase', bill: 'https://supabase.com/dashboard/org/_/billing',
      for: 'The database, sign-in and accounts, and the data every tab and the agent API read.',
      plan: () => `Pro, one project; ${termHtml('compute', WORDS.compute)} covered by the plan’s US$10 credit`,
      month: [25, 25], sure: 'confirmed',
      more: 'Disk past the 8 GB included (about US$0.125 a GB); a Small compute size for the Disk IO budget (#255) about US$5 more, Medium about US$50 more; each other active project in the same organisation bills its own compute (about US$10); egress past 250 GB.',
    },
    {
      name: 'ElevenLabs', bill: 'https://elevenlabs.io/app/subscription',
      for: 'The voices of the network bulletins and the 🎬 Videos.',
      plan: () => `Starter (the voicing run’s log: 40,000 ${termHtml('credits', WORDS.credits)} this month)`,
      month: [6, 6], sure: 'confirmed',
      more: 'A daily bulletin takes about 800 credits, a weekly about 1,200, a video 400–900 once. Run out and they play silent until the month turns; Creator is US$22 for 121,000.',
    },
    {
      name: 'Fly.io', bill: 'https://fly.io/dashboard',
      for: 'The MQTT bridge: one small machine in Sydney that passes the broker’s readings to the database.',
      plan: () => `${termHtml('Pay as you go', WORDS.payg)}: one shared-cpu-1x machine, 256 MB, always on`,
      month: [2, 3], sure: 'estimate',
      more: 'US$2.19 a month in Fly’s US regions, a little more in Sydney. A second machine, or a bigger one, about doubles it.',
    },
    {
      name: 'floodwarning.net', bill: '',
      for: 'The domain the site, the Worker and the agent API answer on.',
      plan: () => 'A .net registration, registered 26 Feb 2026; its registrar is not recorded in the docs',
      month: [1, 1], sure: 'estimate',
      more: 'About US$12 a year at cost. If it was bought for one year, it renews about 26 Feb 2027 — a lapsed domain takes the whole site with it.',
    },
    {
      name: 'Anthropic API', bill: 'https://platform.claude.com',
      for: 'Station Health’s AI briefing on Flood-Net’s own key (/api/briefing), for editors and administrators.',
      plan: () => 'Pay per use, held to US$20 a Brisbane day by the Worker and by the workspace’s own monthly spend limit',
      month: null, sure: 'ask',
      more: 'Nothing until the ANTHROPIC_API_KEY secret is set; then up to US$20 a day (about US$600 a month at the very most). The Console’s Usage page says what it is.',
    },
    {
      name: 'Claude (Claude Code)', bill: 'https://claude.ai/settings/billing',
      for: 'The scheduled sessions — the daily and weekly bulletins, the CI doctor every four hours, the nightly photo reader — and the work on Flood-Net itself.',
      plan: () => 'The owner’s Claude plan, shared with other work',
      month: null, sure: 'ask',
      more: 'Not split out: the plan’s price is the cost, whatever share of it Flood-Net takes.',
    },
    {
      name: 'Cloudflare', bill: 'https://dash.cloudflare.com/?to=/:account/billing',
      for: 'The site and its Worker (/api/*), R2 for the field photos and the data archive, Access in front of the site, the rate limits and DNS.',
      plan: () => 'Workers Free; R2’s free 10 GB; Zero Trust free to 50 people',
      month: [0, 0], sure: 'free',
      more: 'R2 past 10 GB, about US$0.015 a GB a month (100 GB of photos is about US$1.50); Workers Paid, US$5 a month, if the Free plan’s 100,000 requests a day or 10 ms of CPU stop being enough; Access past 50 people, about US$7 a person a month.',
    },
    {
      name: 'Resend', bill: 'https://resend.com/settings/billing',
      for: 'Account emails (confirm your address, reset a password) and the agent API’s notify list.',
      plan: () => 'Free: 100 emails a day, 3,000 a month',
      month: [0, 0], sure: 'free',
      more: 'Pro, US$20 a month, once a day’s sign-ups or a changelog email to the list pass 100 a day.',
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
      more: 'Commercial use needs a subscription (Standard, about US$29 a month); the OPEN_METEO_KEY secret switches the Worker to it.',
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

  function usd(m) {
    if (!m) return '?';
    const [lo, hi] = m;
    if (!hi) return '0';
    return lo === hi ? `${lo}` : `${lo}–${hi}`;
  }

  function chip(k) {
    const s = SURE[k];
    return `<span class="term-chip adm-sure adm-sure--${s.tone}" title="${escAttr(s.meaning)}">${esc(s.label)}</span>`;
  }

  // What is known so far, the rows the bill still has to say, and the free ones.
  function totals() {
    const known = SERVICES.filter(s => s.month);
    return {
      lo: known.reduce((a, s) => a + s.month[0], 0),
      hi: known.reduce((a, s) => a + s.month[1], 0),
      paid: known.filter(s => s.month[1] > 0).length,
      ask: SERVICES.filter(s => !s.month).map(s => s.name),
      free: SERVICES.filter(s => s.sure === 'free').length,
    };
  }

  // ── the panel ──

  // The money and how sure it is come straight after the name, so a phone
  // shows them before the table has to scroll sideways.

  function row(s) {
    const name = s.bill
      ? `<a href="${escAttr(s.bill)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
      : esc(s.name);
    return `<tr>
      <th scope="row">${name}<div class="small txt-muted adm-cost-for">${esc(s.for)}</div></th>
      <td class="adm-cost-usd">${usd(s.month)}</td>
      <td>${chip(s.sure)}</td>
      <td>${s.plan()}</td>
      <td class="small">${esc(s.more)}</td>
    </tr>`;
  }

  function render() {
    const head = `<div class="panel-header"><h2 id="adm-costs-h">Running costs</h2></div>`;
    if (!isAdmin()) {
      return `<div class="panel">${head}<p class="small">Every service Flood-Net runs on and what it costs a month —
        for administrators. ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? ''
          : '<a href="#" onclick="Auth.open();return false">Sign in</a> as one to see it.'}</p></div>`;
    }
    const t = totals();
    const total = t.lo === t.hi ? `${t.lo}` : `${t.lo}–${t.hi}`;
    return `
      <div class="panel adm-costs">
        ${head}
        <div class="adm-kpis">
          <div class="adm-kpi"><div class="adm-kpi-label">Known so far</div>
            <div class="adm-kpi-value">US$${total} <small>a month</small></div>
            <div class="adm-kpi-sub">${t.paid} paid services, before GST</div></div>
          <div class="adm-kpi adm-kpi--warn"><div class="adm-kpi-label">Not known yet</div>
            <div class="adm-kpi-value">${t.ask.length}</div>
            <div class="adm-kpi-sub">${esc(t.ask.join(' and '))}: only the bill says</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">Free for now</div>
            <div class="adm-kpi-value">${t.free}</div>
            <div class="adm-kpi-sub">until a limit in the last column</div></div>
        </div>
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-costs-h">
          <table class="adm-table adm-costs-table">
            <thead><tr>
              <th scope="col">Service</th>
              <th scope="col">${termHtml('A month', WORDS.month)} (US$)</th>
              <th scope="col">How sure</th>
              <th scope="col">Plan</th>
              <th scope="col">When it costs more</th>
            </tr></thead>
            <tbody>${SERVICES.map(row).join('')}</tbody>
          </table>
        </div>
        <p class="small txt-muted">Plans and prices as read on ${esc(CHECKED)}, from each service’s price list and
          Flood-Net’s own settings and docs. A service’s name opens its billing page.</p>
        <details class="adm-why">
          <summary>What the words on this panel mean</summary>
          <dl class="adm-words">
            ${Object.values(SURE).map(s => `<dt>${esc(s.label)}</dt><dd>${esc(s.meaning)}</dd>`).join('')}
            ${WORD_LABELS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}
          </dl>
        </details>
      </div>`;
  }

  return { render, totals, SERVICES, CHECKED };
})();
