// MegaNet — kb-licensing.js
//
//   KbLicensing   the 🪪 Radio Licensing tab, in the Knowledge base: what this
//                 network's transmitters and receivers need by way of a radio
//                 licence, in plain words, with every rule quoted from the
//                 document it is written in and opened there on a press.
//
//                   who     who needs a licence, the three kinds, the penalty
//                   pmp     how a point-to-multipoint licence works, role by role
//                   km30    the 30 km question — law, licence and ACMA's plan,
//                           with a station to move in and out of the circle
//                   gauge   the limits a gauge keeps, and a checker for them
//                   base    a base's and a repeater's limits, a licence document
//                           read line by line, the label a transmitter at a
//                           shared site must carry, the emission code taken apart
//                   rx      receivers
//                   power   EIRP one word at a time; decibels; dBi and dBd
//                   ant     antennas: the shapes, the types, their patterns
//                   need    "does it need its own licence?", a question at a time
//                   ours    the licences this network runs under, counted
//                   ask     ACMA's own pages, who to ask, a question to send
//                   docs    the documents, to read here or at their source
//                   quiz    seven cases to try
//
// Flood-Net's own lesson, not an adaptation: no credit panel. The rules are
// ACMA's and Parliament's; licence-docs.js holds their words and the checker
// that every quotation here is on the page it names (npm run licensing).
// The words are licensing-words.js's, the drawings kb-licensing-draw.js's.
//
// After core.js (esc, escAttr, termHtml, copyToClipboard), licence-docs.js,
// licensing-words.js and kb-licensing-draw.js, before init.js. Reaches app.js
// for switchTab and acmaFetchJson, and map-acma.js for MapAcma.pdfUrl, at call
// time. Nothing runs at load: renderMain() calls render() and init().
//
// Exposes: render, init, open, go, set, role, wiz, pick, copyAsk, check, tool,
//          exportTxt, checkText, tab.

const KbLicensing = (function () {
  const TAB = 'licensing';
  const D = () => LicensingDraw;
  const W = () => LicensingWords;
  const L = () => LicenceDocs;
  const t = (id, text) => W().term(id, text);
  const c = (id, label) => L().cite(id, label);
  const num = (x, d) => D().num(x, d);

  const MODELS = {
    high: { name: 'High power', radius: 30, reuse: 100, base: 40, remote: 20 },
    low: { name: 'Low power', radius: 2, reuse: 10, base: 8.3, remote: 8.3 },
  };
  const S = { role: 'base', model: 'high', km: 42, kind: 'gauge', tx: 5, loss: 0.5, ant: 'col5', dur: 0.4, gap: 60, band: 'vhf',
    pick: 'yagi3', em: '7K50F2D', path: [], label: { lic: true, w2: true, shared: false } };
  let reg = null;               // the register copy, summarised, once read
  let regErr = '';

  const SECTIONS = [
    ['who', '📡', 'Who needs a licence'], ['pmp', '🛰️', 'One base, many gauges'], ['km30', '⭕', 'The 30 km question'],
    ['gauge', '🌧️', 'A gauge’s limits'], ['base', '🗼', 'A base’s and a repeater’s'], ['rx', '👂', 'Receivers'],
    ['power', '🔆', 'EIRP and decibels'], ['ant', '📶', 'Antennas'], ['need', '🧭', 'Does it need its own?'],
    ['ours', '🧮', 'Ours, counted'], ['ask', '☎️', 'ACMA’s pages'], ['docs', '📚', 'The documents'], ['quiz', '✅', 'Try seven cases'],
  ];

  // ── Pieces ──────────────────────────────────────────────────────────────────

  const out = (label, href) => `<a href="${escAttr(href)}" target="_blank" rel="noopener" aria-label="${escAttr(`${label} — in a new tab`)}">${esc(label)}<span aria-hidden="true"> ↗</span></a>`;
  function head(id, icon, title, short) {
    return `<h3 id="rlc-${id}-h" tabindex="-1"><span aria-hidden="true">${icon}</span> ${esc(title)}</h3>
      ${short ? `<p class="rlc-short">${short}</p>` : ''}`;
  }
  const sect = (id, html) => `<section class="panel rlc-sect" id="rlc-${id}" aria-labelledby="rlc-${id}-h" data-sect="${id}">${html}</section>`;
  // A drawing in a box that scrolls sideways on a phone rather than shrinking past reading.
  const figure = (name, svg, caption) => `<figure class="rlc-fig">
      <div class="rlc-fig-box" role="region" tabindex="0" aria-label="${escAttr(name)}">${svg}</div>
      ${caption ? `<figcaption>${caption}</figcaption>` : ''}
    </figure>`;
  const kind = k => L().kindChip(k);
  const dollars = units => `$${(units * 364).toLocaleString('en-AU')}`;

  // ── The head of the page ────────────────────────────────────────────────────

  function heroHtml() {
    const fact = (big, text, to) => `<li class="rlc-fact"><button type="button" class="rlc-fact-b" onclick="KbLicensing.go('${to}')">
        <span class="rlc-fact-n">${big}</span><span class="rlc-fact-t">${text}</span></button></li>`;
    return `<section class="panel rlc-hero" aria-labelledby="rlc-h">
      <h2 class="rlc-title" id="rlc-h"><span aria-hidden="true">🪪</span> Radio licensing</h2>
      <p class="rlc-lede">Every radio in this network that <em>sends</em> needs a licence from ${t('acma')} to do it. This page says which
        licence covers what, the limits a gauge and a repeater must keep, and where each rule is written — press any
        <span class="rlc-cite-eg"><span aria-hidden="true">📖</span> link like this</span> to read the rule in its own document.</p>
      <ul class="rlc-facts" aria-label="The six things to know">
        ${fact('Send = licence', 'Transmitting needs a licence. Listening does not.', 'who')}
        ${fact('1 base, many gauges', 'A licence names one base station. The gauges that report to it ride on it, unlisted.', 'pmp')}
        ${fact('1 W · 2 s · 10 s', 'A gauge on a base’s licence: 1 W into its antenna, bursts of 2 seconds, 10 seconds apart.', 'gauge')}
        ${fact('30 km', 'ACMA’s planning circle round a base. Not a distance written in the law.', 'km30')}
        ${fact('Relays', 'A repeater carries other stations’ messages, so it needs a licence naming its own site.', 'base')}
        ${fact('A label', 'A licensed transmitter over 2 W at a shared site must carry its frequency assignment number.', 'label')}
      </ul>
      <p class="filter-note rlc-disclaimer"><strong>A guide, not legal advice.</strong> Written on ${esc(L().dateText(L().SNAPSHOT))} from the documents it quotes,
        which are copies saved that day. Rules change and a licence can carry conditions of its own: read the licence document, and ask ACMA
        (1300 850 115, info@acma.gov.au) before acting on any of it.</p>
      <nav class="rlc-toc" aria-label="On this page">
        ${SECTIONS.map(([id, icon, label]) => `<button type="button" class="pill" onclick="KbLicensing.go('${id}')"><span aria-hidden="true">${icon}</span> ${esc(label)}</button>`).join('')}
        <button type="button" class="pill" onclick="KbLicensing.go('glossary')"><span aria-hidden="true">🔤</span> What the words mean</button>
      </nav>
    </section>`;
  }

  // ── Who needs a licence ─────────────────────────────────────────────────────

  function whoHtml() {
    return sect('who', `${head('who', '📡', 'Who needs a licence', 'Anything that transmits. Nothing that only listens.')}
      ${figure('A gauge, a repeater and a listening base', D().scene(),
        'The reading leaves the gauge, is heard and sent on by the repeater, and arrives at a base that only listens. Two of the three transmit.')}
      <p>The rule is one sentence of ${t('act', 'the Act')}: ${c('act-46', 'section 46')} says nobody may operate a radio device
        “otherwise than as authorised by” a licence. There are three kinds:</p>
      <ul class="rlc-cards">
        <li class="rlc-card rlc-card-on"><h4>${t('apparatus', 'Apparatus licence')} <span class="rlc-chip rlc-chip-yes">ours</span></h4>
          <p>Issued to one holder, for a transmitter at a named place, on a set frequency and power, usually for a year at a time. Every licence
            this network runs under is one of these, and each is in ${t('register', 'ACMA’s public register')}.</p></li>
        <li class="rlc-card"><h4>${t('classlic', 'Class licence')}</h4>
          <p>A standing permission for anyone, with no application and no fee, for devices that stay inside tight limits. In this band the limit is
            100 mW ${t('eirp')} — a tenth of a watt. A gauge runs a watt or more, so this does not cover it.</p></li>
        <li class="rlc-card"><h4>${t('spectrumlic', 'Spectrum licence')}</h4>
          <p>A whole block of frequencies across a region, bought at auction by phone carriers. Not used for flood telemetry.</p></li>
      </ul>
      <h4>Why the conditions matter as much as the licence</h4>
      ${L().quote('act-97')}
      <p>So a transmitter that breaks a ${t('condition')} of its licence — too much power, the wrong frequency — is treated as having no licence at all for
        that transmission. That is why the limits further down this page are worth getting right.</p>
      <div class="table-wrap"><table class="rlc-table rlc-pen">
        <caption>The most a court can impose, at the penalty unit in force since 1 July 2026 ($364)</caption>
        <thead><tr><th scope="col">What was done</th><th scope="col">Where it is written</th><th scope="col">The most that can follow</th></tr></thead>
        <tbody>
          <tr><td>Transmitting with no licence, or outside a licence’s conditions</td><td>${c('act-46-penalty', 'Act, section 46')}</td>
            <td>A person: 2 years in prison. An organisation: 1,500 penalty units — ${dollars(1500)}. Or, as a civil penalty, 300 units — ${dollars(300)}.</td></tr>
          <tr><td>A licence holder breaking a condition of its own licence</td><td>${c('act-113', 'Act, section 113')}</td>
            <td>A civil penalty of 100 units — ${dollars(100)}.</td></tr>
        </tbody></table></div>
      <p class="small txt-muted">These are ceilings, set out so the stakes are plain; ACMA’s ordinary response to a problem is a letter and a chance to fix it.
        The unit’s value: ${c('penalty-unit', 'the 2026 instrument')}.</p>`);
  }

  // ── A point-to-multipoint system ────────────────────────────────────────────

  const ROLES = {
    base: {
      n: 1, name: 'Base station', aka: 'RALI FX16 calls it the master station.',
      ours: 'A repeater, or a base that transmits.',
      listed: 'Yes — its site, frequency, power and antenna are written on the licence and shown in the register.',
      rules: () => [`The one station the licence names: ${c('lcd-base')}.`,
        `It may run the transmitter power and ${t('eirp')} its licence lists, and no more.`,
        `ACMA plans a base on no more than 40 W EIRP (${c('fx16-eirp-master')}) and an upright antenna of no more than 8.2 ${t('dbi')} (${c('fx16-master-antenna')}).`],
    },
    remote: {
      n: 2, name: 'Remote station', aka: 'The spokes of the wheel.',
      ours: 'A rain or river gauge that reports to a licensed repeater or base.',
      listed: 'No. Its location is on neither the licence nor the register.',
      rules: () => [`Covered by the base’s licence without being named: ${c('lcd-not-listed')}.`,
        `It may talk only to stations on that same licence (${c('lcd-talk-to')}), on the base’s frequencies (${c('lcd-frequency')}).`,
        `Data only, in short bursts: 2 seconds at most, 10 seconds apart at least (${c('lcd-timing')}), at 1 W into the antenna (${c('lcd-power')}).`,
        `It must stop if it causes ${t('harmful', 'harmful interference')} (${c('lcd-no-harm')}).`],
    },
    fillin: {
      n: 3, name: 'Supplementary base station', aka: 'A fill-in transmitter.',
      ours: 'Rare here. A second transmitter added to reach a pocket the licensed base cannot — behind a ridge. A repeater that carries gauges further afield is not one.',
      listed: 'No. It is “at a location that is not mentioned in the fixed licence”.',
      rules: () => [`Only to patch a gap inside the base’s own coverage: ${c('lcd-fill-gaps')}.`,
        `Never to stretch that coverage: ${c('lcd-no-extend')}.`,
        `Once it reaches past the base’s 30 km, ACMA’s policy calls it another master station needing its own licence (${c('fx16-another-master')}).`],
    },
    rcs: {
      n: 4, name: 'Remote control station', aka: 'Controls the base from somewhere else.',
      ours: 'Not something flood telemetry uses; shown so the licence’s wording makes sense.',
      listed: 'No.',
      rules: () => ['At most 1 W into the antenna, through a directional antenna, on the base’s frequencies.'],
    },
  };

  function roleHtml() {
    const r = ROLES[S.role] || ROLES.base;
    return `<div class="rlc-role-card" id="rlc-role-card" data-role="${S.role}" aria-live="polite">
        <h4><span class="rlc-num" aria-hidden="true">${r.n}</span> ${esc(r.name)} <span class="rlc-aka">${esc(r.aka)}</span></h4>
        <dl class="rlc-dl">
          <dt>In this network</dt><dd>${esc(r.ours)}</dd>
          <dt>Named on the licence?</dt><dd>${esc(r.listed)}</dd>
          <dt>Its rules</dt><dd><ul>${r.rules().map(x => `<li>${x}</li>`).join('')}</ul></dd>
        </dl>
      </div>`;
  }
  const rolePicks = () => Object.entries(ROLES).map(([k, r]) => `<button type="button" class="pill${S.role === k ? ' is-on' : ''}" aria-pressed="${S.role === k}"
      onclick="KbLicensing.role('${k}')"><span class="rlc-num" aria-hidden="true">${r.n}</span> ${esc(r.name)}</button>`).join('');

  function pmpHtml() {
    return sect('pmp', `${head('pmp', '🛰️', 'One base, many gauges', 'How a point-to-multipoint licence works — the kind most of this network runs under.')}
      <p>A ${t('pmp', 'point-to-multipoint')} licence is a wheel: a hub and its spokes. ACMA’s description: ${c('fx16-system')}.
        The licence names the hub. Everything else that talks to the hub is covered by the same licence without being written on it.</p>
      <div class="rlc-sys">
        ${figure('A point-to-multipoint system, numbered by role', `<div id="rlc-system">${D().system(S.role)}</div>`,
          'The shaded area is the ground ACMA plans the licence to serve. Pick a role to light it.')}
        <div class="pill-row rlc-roles" id="rlc-roles" role="group" aria-label="Pick a role">${rolePicks()}</div>
        ${roleHtml()}
      </div>
      <h4>Point to multipoint beside point to point</h4>
      <div class="table-wrap"><table class="rlc-table rlc-vs">
        <caption>The two kinds of fixed licence this network holds</caption>
        <thead><tr><th scope="col">&nbsp;</th><th scope="col">${t('pmp', 'Point to multipoint')}</th><th scope="col">${t('ptp', 'Point to point')}</th></tr></thead>
        <tbody>
          <tr><th scope="row">Shape</th><td>A hub and its spokes</td><td>One link between two places</td></tr>
          <tr><th scope="row">The law’s test</th><td>${c('int-pmp', 'talks to more than one other station')}</td><td>${c('int-ptp', 'talks to one other station')}</td></tr>
          <tr><th scope="row">Named on the licence</th><td>The base only</td><td>Both ends</td></tr>
          <tr><th scope="row">In the register</th><td>The base only (${c('es-register', 'why')})</td><td>Both ends</td></tr>
          <tr><th scope="row">${t('protection', 'Protected')} from later licences</th><td>The base, and its planned service area</td><td>Each end, by name</td></tr>
          <tr><th scope="row">Antenna the law asks for</th><td>None stated</td><td>At 148–174 MHz, at least 12 dBi and a beam of 44° or less — a 6-element ${t('yagi')} (${c('lcd-antenna')})</td></tr>
          <tr><th scope="row">Used here for</th><td>A repeater and the gauges round it</td><td>Carrying data from a repeater or a radar site to an office</td></tr>
        </tbody></table></div>`);
  }

  // ── The 30 km question ──────────────────────────────────────────────────────

  function explorerState() {
    const m = MODELS[S.model];
    const km = Math.min(Math.max(0, S.km), m.reuse);
    const a = -12 * Math.PI / 180;
    const toB = Math.hypot(m.reuse - km * Math.cos(a), km * Math.sin(a));
    const inside = km <= m.radius, other = toB <= m.radius;
    return { m, km, toB, inside, other, relay: S.kind === 'relay', state: inside ? 'in' : other ? 'other' : 'out' };
  }

  function explorerReadout() {
    const e = explorerState(), m = e.m;
    const row = (cls, mark, title, body) => `<li class="rlc-ex-row rlc-ex-${cls}"><span class="rlc-ex-mark" aria-hidden="true">${mark}</span>
        <div><strong>${title}</strong><span class="rlc-ex-body">${body}</span></div></li>`;
    let verdict, vcls;
    if (e.relay && !e.inside) { verdict = 'Needs a licence of its own'; vcls = 'bad'; }
    else if (e.relay) { verdict = 'Allowed only as a fill-in — safer with its own licence'; vcls = 'warn'; }
    else if (e.inside) { verdict = 'Inside what the licence was planned for'; vcls = 'ok'; }
    else { verdict = 'Beyond the plan — not unlicensed for that alone'; vcls = 'warn'; }
    const law = e.relay
      ? (e.inside
        ? row('warn', '!', 'The law', `A transmitter that relays may work here on the base’s licence only as a fill-in: to patch a gap in the base’s own coverage, on the base’s frequencies (${c('lcd-fill-gaps', 's 14(3)')}).`)
        : row('bad', '✕', 'The law', `A fill-in may not be used “to extend the coverage area of a base station” (${c('lcd-no-extend', 's 14(4)')}). Out here that is what a relay does, so this licence does not cover it.`))
      : row('ok', '✓', 'The law', `Sets no distance for a gauge. It must talk to this base, on the base’s frequencies, inside the power and timing limits, and cause no harmful interference (${c('es-anywhere', 'ACMA: “can be located anywhere”')}).`);
    const plan = e.inside
      ? row('ok', '✓', 'ACMA’s plan', `Inside the ${num(m.radius)} km service area the ${m.name.toLowerCase()} model plans on (${c(S.model === 'low' ? 'fx16-2km' : 'fx16-30km', 'RALI FX16')}).`)
      : row('bad', '✕', 'ACMA’s plan', `Outside it. FX16 says every station “must be contained within the service area” (${c(S.model === 'low' ? 'fx16-2km' : 'fx16-30km', 'RALI FX16')}); a new system would not be assigned this way without an agreed exception.`);
    const prot = e.inside
      ? row('ok', '✓', 'Protection', 'The channel is kept clear of other licensed users out to here, because the plan counts on stations being here.')
      : e.other
        ? row('bad', '✕', 'Protection', `None — and it is now ${num(e.toB)} km from the next base on the channel, inside <em>that</em> licence’s service area. This is where its bursts are most likely to be somebody else’s interference.`)
        : row('warn', '!', 'Protection', `None is planned for out here. The station is on a “no interference, no protection” footing (${c('fx19-fortuitous', 'ACMA’s words, in FX19')}).`);
    const todo = e.relay
      ? (e.inside ? 'Confirm it only fills a gap in the base’s coverage. If it carries gauges the base could not otherwise hear, license it as a base in its own right.'
        : 'License it as a base station in its own right, coordinated like any other.')
      : (e.inside ? 'Nothing more as far as distance goes. Check its power and timing in the next section.'
        : 'Do not record it as unlicensed. Pick one: ask ACMA whether it may stay on this licence; license the nearer repeater it really reports to as a base; or accept it as unprotected. If it ever interferes with anyone, it must stop.');
    return `<p class="rlc-ex-verdict rlc-ex-${vcls}" id="rlc-ex-verdict"><span class="rlc-ex-d">${num(e.km)} km from the base</span> ${esc(verdict)}</p>
      <ul class="rlc-ex-rows">${law}${plan}${prot}</ul>
      <p class="rlc-ex-todo"><strong>What to do:</strong> ${todo}</p>`;
  }
  function explorerName() {
    const e = explorerState();
    return `A ${e.relay ? 'relay' : 'gauge'} ${num(e.km)} km from a licensed base whose service area is ${num(e.m.radius)} km: ${e.inside ? 'inside it' : e.other ? 'outside it, and inside the next base’s' : 'outside it'}.`;
  }

  function licenceCounts() {
    if (!reg) return regErr ? `<p class="small txt-muted">The register copy could not be read here (${esc(regErr)}), so the counts are left out.</p>` : '<p class="small txt-muted" aria-busy="true">Counting the register copy…</p>';
    return `<p>In the register copy of ${esc(reg.asAt)}: <strong>${reg.statedN}</strong> of ${reg.pmp} point-to-multipoint licences write a distance into a
      ${t('special', 'special condition')} (“${esc(reg.statedEg)}”), and <strong>${reg.rangeN}</strong> say remote transmitters are authorised
      “within range of the specified site”. The other ${reg.pmp - reg.statedN - reg.rangeN} say nothing about distance at all.</p>`;
  }

  function km30Html() {
    const m = MODELS[S.model];
    const pdf = typeof MapAcma !== 'undefined' && MapAcma.pdfUrl ? MapAcma.pdfUrl('1463975/1') : '';
    return sect('km30', `${head('km30', '⭕', 'The 30 km question', 'Must a station more than 30 km from a licensed base have a licence of its own?')}
      <div class="rlc-answer">
        <p class="rlc-answer-h">The short answer</p>
        <p><strong>No — not for a gauge, and not for that reason alone.</strong> 30 km is not in the law and not on the Bureau’s licences. It is the
          ${t('servicearea', 'service area')} ACMA plans a licence on — and in that plan it is written as a “must”. So a gauge beyond 30 km is
          <em>outside what its licence was planned for</em>, which has consequences, but it is not unlicensed.</p>
        <p><strong>A repeater is different.</strong> A transmitter that carries the signal past the base’s reach may not run on the base’s licence at all.
          It needs its own.</p>
      </div>

      <h4>Three places a rule can live — and what each says about distance</h4>
      <ol class="rlc-layers">
        <li class="rlc-layer rlc-layer-law">
          <p class="rlc-layer-h">${kind('law')} <strong>1 · The law</strong> — the Act and the Fixed Licence determination</p>
          <p><strong>No distance.</strong> The determination lists what a remote station must do — talk only to its own licence’s stations
            (${c('lcd-talk-to', 's 13')}), on the base’s frequencies (${c('lcd-frequency', 's 15(2)')}, ${c('lcd-vhf', 's 23(2)')}), briefly
            (${c('lcd-timing', 's 15(3)')}), at low power (${c('lcd-power', 's 15(4)')}), without harmful interference (${c('lcd-no-harm', 's 15(1)')}).
            None of it is a distance. ACMA’s own explanation of the determination puts it this way:</p>
          ${L().quote('es-anywhere')}
        </li>
        <li class="rlc-layer rlc-layer-lic">
          <p class="rlc-layer-h"><span class="term-chip ld-kind" title="${escAttr(W().meaning('special'))}">The licence</span> <strong>2 · The licence document itself</strong></p>
          <p><strong>Usually no distance — but read it.</strong> A Bureau licence names the base’s site, frequency, power and antenna and stops there
            ${pdf ? `(${out('licence 1463975/1, Takura Hill', pdf)} is typical)` : ''}. A licence <em>can</em> carry a condition of its own, and where it does, that
            condition is the one that binds: ${c('lcd-own-conditions', 's 12(2)')}.</p>
          <div id="rlc-lic-counts">${licenceCounts()}</div>
        </li>
        <li class="rlc-layer rlc-layer-policy">
          <p class="rlc-layer-h">${kind('policy')} <strong>3 · ACMA’s plan</strong> — RALI FX16</p>
          <p><strong>30 km, and firmly.</strong> This is where the figure comes from:</p>
          ${L().quote('fx16-30km')}
          ${L().quote('fx16-expected')}
          <p>A ${t('rali')} is ACMA’s policy for the people who hand out frequencies (${c('fx16-policy', 'its own description')}). It bites when a licence
            is issued: the assigner certifies that the station fits it (${c('fac-consistent', 'how a RALI enters a licence')}). It allows exceptions,
            case by case (${c('fx16-exceptions', 's 6')}). It is not legislation, and breaking it is not by itself an offence.</p>
        </li>
      </ol>

      <h4>Move a station in and out of the circle</h4>
      <div class="rlc-ex" id="rlc-ex">
        <div class="rlc-ex-controls">
          <fieldset class="rlc-seg"><legend>What is it?</legend>
            <label><input type="radio" name="rlc-kind" value="gauge" ${S.kind === 'gauge' ? 'checked' : ''} onchange="KbLicensing.set('kind', this.value)"> A gauge <span class="txt-muted">(sends its own readings)</span></label>
            <label><input type="radio" name="rlc-kind" value="relay" ${S.kind === 'relay' ? 'checked' : ''} onchange="KbLicensing.set('kind', this.value)"> A repeater or fill-in <span class="txt-muted">(passes others’ on)</span></label>
          </fieldset>
          <fieldset class="rlc-seg"><legend>${t('model', 'Service model')}</legend>
            <label><input type="radio" name="rlc-model" value="high" ${S.model === 'high' ? 'checked' : ''} onchange="KbLicensing.set('model', this.value)"> High power <span class="txt-muted">(40 W base, 30 km)</span></label>
            <label><input type="radio" name="rlc-model" value="low" ${S.model === 'low' ? 'checked' : ''} onchange="KbLicensing.set('model', this.value)"> Low power <span class="txt-muted">(8.3 W base, 2 km)</span></label>
          </fieldset>
          <label class="rlc-slider">Distance from the licensed base: <output id="rlc-km-out" for="rlc-km">${num(S.km)} km</output>
            <input type="range" id="rlc-km" min="0" max="${m.reuse}" step="${S.model === 'low' ? 0.1 : 1}" value="${S.km}"
                   oninput="KbLicensing.set('km', this.value)"></label>
        </div>
        ${figure('The station, the base and its service area, from above', D().explorer(),
          `The solid circle is the service area. The line under the picture is the ${t('reuse', 're-use distance')}: ACMA puts the next base on the same channel no closer than that, and the dashed circle is that base’s own service area.`)}
        <div class="rlc-ex-read" id="rlc-ex-read" aria-live="polite">${explorerReadout()}</div>
      </div>

      <h4>What “outside the plan” costs</h4>
      <ul class="rlc-list">
        <li><strong>No protection.</strong> Only the base is checked against other users; the gauges are protected because the plan assumes where they are:
          ${c('fx16-coordination')}. In another point-to-multipoint instruction ACMA says what that means beyond the planned range:
          ${L().quote('fx19-fortuitous')}
          <span class="small txt-muted">That is RALI FX19, written for wireless broadband at 1900 MHz — a different band, quoted because it states the principle in so many words.</span></li>
        <li><strong>It must not interfere.</strong> That one <em>is</em> law, at any distance (${c('lcd-no-harm', 's 15(1)')}; ${c('fx16-interference', 'FX16 on the same point')}).
          A gauge far outside its circle is nearer to somebody else’s — move the slider past ${num(MODELS.high.reuse - MODELS.high.radius)} km to see it.</li>
        <li><strong>In a dispute, ACMA reads the RALI.</strong> ${c('fx19-dispute', 'It says so of FX19')}; a station outside the model starts on the back foot.</li>
        <li><strong>A new licence would not be issued that way.</strong> An assigner certifies against FX16, so a system designed with gauges at 45 km needs an exception agreed first.</li>
      </ul>

      <h4>So what do we do with a station beyond 30 km?</h4>
      <div class="table-wrap"><table class="rlc-table rlc-opts">
        <caption>The ways through, least effort first</caption>
        <thead><tr><th scope="col">Option</th><th scope="col">When it fits</th><th scope="col">What it takes</th></tr></thead>
        <tbody>
          <tr><th scope="row">Check which base it really reports to</th><td>Always first. Many gauges are far from one licensed base and close to another on the same channel.</td>
            <td>The ACMA licences tool on the Stations map lists the nearest licensed bases for any station.</td></tr>
          <tr><th scope="row">Leave it, knowingly</th><td>It reports to a licensed base, keeps the power and timing limits, and is nowhere near another user of the channel.</td>
            <td>Record that it is outside the planned service area and unprotected. It must stop if it ever causes interference.</td></tr>
          <tr><th scope="row">Ask ACMA</th><td>Several stations are in this position, or the answer decides money.</td>
            <td>One email — a draft is in <button type="button" class="link-btn" onclick="KbLicensing.go('ask')">ACMA’s pages</button> below. A written answer settles it.</td></tr>
          <tr><th scope="row">License the repeater nearer to it</th><td>A repeater closer to the gauge has no licence of its own, or only relays.</td>
            <td>A new point-to-multipoint licence naming that repeater’s site, through an ${t('accredited', 'accredited person')}. The gauge is then inside its circle.</td></tr>
          <tr><th scope="row">Give the station its own licence</th><td>It needs protection, or more than 1 W.</td>
            <td>A licence naming the gauge’s own site — point to point if it talks to one place.</td></tr>
        </tbody></table></div>

      <details class="rlc-sure"><summary>How sure is this, and what would make it surer</summary>
        <ul>
          <li><strong>Certain:</strong> what the law says. The Act’s sections and the Fixed Licence determination were read in full, in the version in force
            (Compilation No. 2, 21 March 2026), with ACMA’s explanatory statement. There is no distance in them.</li>
          <li><strong>Certain:</strong> what RALI FX16 says. Read in full; the two sentences quoted above are its words.</li>
          <li><strong>Checked on one licence, counted on the rest:</strong> that the Bureau’s licence documents state no distance. One was read; the register’s list of
            special conditions was counted for all of them.</li>
          <li><strong>Not written anywhere we could find:</strong> what ACMA does about an <em>existing</em> gauge beyond the service area of a licence already issued.
            The reading here — unprotected, must not interfere, not an offence in itself — follows from the documents, but only ACMA can confirm it.</li>
          <li><strong>Not read:</strong> RALI MS42 (the band plan for 148–174 MHz) and RALI LM08; ACMA’s website would not let this guide’s author open them.
            They would say which of FX16’s two routes the 151.5 MHz licences were assigned by. Both routes use the same 30 km.</li>
        </ul>
      </details>`);
  }

  // ── A gauge's limits, and the checker ───────────────────────────────────────

  function checkState() {
    const a = D().ANTENNAS[S.ant] || D().ANTENNAS.col5;
    const tx = Math.max(0.001, Number(S.tx) || 0), loss = Math.max(0, Number(S.loss) || 0);
    const atAnt = tx * Math.pow(10, -loss / 10);
    const eirp = atAnt * Math.pow(10, a.gain / 10);
    const back = a.dir ? eirp * Math.pow(10, -a.fb / 10) : eirp;
    const dur = Math.max(0.01, Number(S.dur) || 0), gap = Math.max(0.1, Number(S.gap) || 0);
    const lim = S.band === 'u5' ? 5 : 1;
    const rules = [
      { k: 'law', name: 'Power into the antenna', got: D().wattText(atAnt), limit: `${lim} W at most`, bad: atAnt > lim + 1e-9, cite: 'lcd-power',
        why: `The radio’s ${D().wattText(tx)} less ${num(loss)} dB of cable.` },
      { k: 'law', name: 'Length of one burst', got: `${num(dur, 2)} s`, limit: '2 s at most', bad: dur > 2 + 1e-9, cite: 'lcd-timing', why: 'From key-down to key-up.' },
      { k: 'law', name: 'Start to start', got: `${num(gap)} s`, limit: '10 s at least', bad: gap < 10 - 1e-9, cite: 'lcd-interval', why: 'The shortest time between two bursts beginning.' },
      { k: 'law', name: 'Share of time on the air', got: `1 in ${num(gap / dur, 0)}`, limit: '1 in 30 at most', bad: dur / gap > 1 / 30 + 1e-9, cite: 'lcd-duty', why: 'Burst length divided by start-to-start time.' },
      { k: 'policy', name: 'EIRP', got: D().wattText(eirp), limit: '20 W at most', bad: eirp > 20 + 1e-9, cite: 'fx16-eirp-remote',
        why: `${D().wattText(atAnt)} into an antenna of ${num(a.gain, 2)} dBi.` },
      { k: 'policy', name: a.dir ? 'Power off the back of the antenna' : 'Power away from the base', got: D().wattText(back), limit: '5 W at most', bad: back > 5 + 1e-9, cite: 'fx16-omni',
        why: a.dir ? `The EIRP, ${num(a.fb)} dB down behind a ${a.name.toLowerCase()}.` : 'This antenna radiates all round, so it is the whole EIRP.' },
    ];
    return { a, tx, loss, atAnt, eirp, back, dur, gap, lim, rules, fails: rules.filter(r => r.bad) };
  }

  function checkOut() {
    const k = checkState();
    const lawFails = k.fails.filter(r => r.k === 'law').length, polFails = k.fails.length - lawFails;
    const sum = !k.fails.length ? ['ok', 'Keeps all six limits', 'As a remote station of a licensed base, this set-up is inside both the law’s limits and ACMA’s planning figures.']
      : lawFails ? ['bad', `Over ${lawFails} of the law’s limits${polFails ? `, and ${polFails} of ACMA’s planning figures` : ''}`,
        'It cannot run like this as a remote station on somebody’s point-to-multipoint licence. Turn it down, or it needs a licence naming its own site that allows these settings.']
        : ['warn', `Inside the law, over ${polFails} of ACMA’s planning figures`, 'Lawful as a remote station, but more than FX16 plans a gauge on. Expect to be asked to turn it down if anybody is disturbed.'];
    const rows = k.rules.map(r => `<tr class="${r.bad ? 'rlc-row-bad' : ''}"><th scope="row">${esc(r.name)}<span class="rlc-why">${esc(r.why)}</span></th>
        <td class="num"><strong>${esc(r.got)}</strong></td><td>${esc(r.limit)}</td>
        <td><span class="rlc-chip ${r.bad ? 'rlc-chip-no' : 'rlc-chip-yes'}">${r.bad ? 'Over' : 'Within'}</span></td>
        <td>${kind(r.k)} ${c(r.cite, L().CITES[r.cite][2])}</td></tr>`).join('');
    return `<p class="rlc-ex-verdict rlc-ex-${sum[0]}" id="rlc-check-verdict">${esc(sum[1])}</p><p>${esc(sum[2])}</p>
      ${figure('Power from the radio to the air', D().ladder({ tx: k.tx, atAnt: k.atAnt, eirp: k.eirp,
        fails: { tx: false, atAnt: k.rules[0].bad, eirp: k.rules[4].bad || k.rules[5].bad },
        limits: [[k.lim, `${k.lim} W into the antenna`, 'rlc-limit-law'], [5, '5 W all round', ''], [20, '20 W EIRP', '']] }),
        `Each step to the right is ten times the power. The cable takes a little away; the antenna’s ${t('gain')} squeezes what is left into a stronger beam.`)}
      ${figure('One minute of bursts', D().timeline({ dur: k.dur, gap: k.gap, badDur: k.rules[1].bad, badGap: k.rules[2].bad, badDuty: k.rules[3].bad }),
        'Each bar is one burst. The shaded strip is the 10 seconds that must pass before the next may begin.')}
      <div class="table-wrap"><table class="rlc-table rlc-check-t">
        <caption>This set-up against each limit</caption>
        <thead><tr><th scope="col">Limit</th><th scope="col">This set-up</th><th scope="col">Allowed</th><th scope="col">Result</th><th scope="col">Where it is written</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }

  const PRESETS = [
    ['1 W gauge, collinear', { tx: 1, loss: 0.5, ant: 'col5', dur: 0.4, gap: 60 }],
    ['5 W gauge, collinear', { tx: 5, loss: 0.5, ant: 'col5', dur: 0.4, gap: 60 }],
    ['5 W through a 7 dB pad', { tx: 5, loss: 7.5, ant: 'col5', dur: 0.4, gap: 60 }],
    ['1 W gauge, 3-element Yagi', { tx: 1, loss: 0.5, ant: 'yagi3', dur: 0.4, gap: 60 }],
    ['Fast reporter, every 5 s', { tx: 1, loss: 0.5, ant: 'col5', dur: 0.4, gap: 5 }],
  ];

  function gaugeHtml() {
    const ants = Object.entries(D().ANTENNAS).filter(([k]) => k !== 'iso');
    return sect('gauge', `${head('gauge', '🌧️', 'A gauge’s limits', 'What a rain or river gauge must keep to when it rides on a base’s licence as a remote station.')}
      <ul class="rlc-rules">
        <li><span class="rlc-rule-n">1 W</span><span>into the antenna, at most — measured after the cable, not at the radio (${c('lcd-power', 's 15(4)')}). Only in 451.5–452.5 MHz and 805.5–806 MHz is it 5 W.</span></li>
        <li><span class="rlc-rule-n">2 s</span><span>is the longest a single ${t('burst', 'transmission')} may last (${c('lcd-timing', 's 15(3)')}).</span></li>
        <li><span class="rlc-rule-n">10 s</span><span>is the least from the start of one burst to the start of the next (${c('lcd-interval', 'what “repetition interval” means')}).</span></li>
        <li><span class="rlc-rule-n">1 in 30</span><span>is the most of the time it may be on the air — its ${t('duty', 'duty cycle')} (${c('lcd-duty', 'defined in s 5(3)')}).</span></li>
        <li><span class="rlc-rule-n">20 W</span><span>${t('eirp')} at most in ACMA’s plan, and no more than 5 W in any direction but towards the base — so 5 W in all if the antenna is not directional (${c('fx16-eirp-remote', 'the 20 W')}; ${c('fx16-omni', 'the 5 W')}).</span></li>
        <li><span class="rlc-rule-n">Same channel</span><span>as the base listens on, and it talks to nothing but stations on that licence (${c('lcd-frequency', 's 15(2)')}; ${c('lcd-talk-to', 's 13')}).</span></li>
      </ul>
      <p>The first four and the last are law. The 20 W and 5 W figures are ACMA’s planning policy. A condition written on the base’s own licence overrides any of them
        (${c('lcd-own-conditions', 's 12(2)')}).</p>

      <h4>Check a gauge</h4>
      <div class="rlc-check" id="rlc-check">
        <div class="pill-row" role="group" aria-label="Start from a typical set-up">
          ${PRESETS.map((p, i) => `<button type="button" class="pill" onclick="KbLicensing.check(${i})">${esc(p[0])}</button>`).join('')}
        </div>
        <div class="rlc-inputs">
          <label>${t('txpower', 'Radio’s power')} <span class="rlc-unit"><input type="number" id="rlc-in-tx" min="0.01" max="100" step="0.1" value="${escAttr(String(S.tx))}" oninput="KbLicensing.set('tx', this.value)"> W</span></label>
          <label>${t('feeder', 'Cable loss')} <span class="rlc-unit"><input type="number" id="rlc-in-loss" min="0" max="30" step="0.1" value="${escAttr(String(S.loss))}" oninput="KbLicensing.set('loss', this.value)"> dB</span></label>
          <label>${t('antenna', 'Antenna')} <select id="rlc-in-ant" onchange="KbLicensing.set('ant', this.value)">
            ${ants.map(([k, a]) => `<option value="${k}" ${S.ant === k ? 'selected' : ''}>${esc(a.name)} — ${num(a.gain, 2)} dBi</option>`).join('')}</select></label>
          <label>${t('burst', 'Burst length')} <span class="rlc-unit"><input type="number" id="rlc-in-dur" min="0.01" max="30" step="0.05" value="${escAttr(String(S.dur))}" oninput="KbLicensing.set('dur', this.value)"> s</span></label>
          <label>${t('interval', 'Start to start')} <span class="rlc-unit"><input type="number" id="rlc-in-gap" min="0.5" max="86400" step="1" value="${escAttr(String(S.gap))}" oninput="KbLicensing.set('gap', this.value)"> s</span></label>
          <label>Band <select id="rlc-in-band" onchange="KbLicensing.set('band', this.value)">
            <option value="vhf" ${S.band === 'vhf' ? 'selected' : ''}>148–174 MHz and everywhere else — 1 W</option>
            <option value="u5" ${S.band === 'u5' ? 'selected' : ''}>451.5–452.5 or 805.5–806 MHz — 5 W</option></select></label>
        </div>
        <div id="rlc-check-out" aria-live="polite">${checkOut()}</div>
      </div>
      <p class="small txt-muted">An ALERT message is 4 bytes at 300 bits a second — about a seventh of a second of data, a few tenths with the radio’s key-up time.
        The checker takes the figures you give it; it does not know a station’s real radio.</p>`);
  }

  // ── A base, a repeater, and the licence that names them ─────────────────────

  const EM = {
    '7K50F2D': 'the Bureau’s usual ALERT designator',
    '10K1F2D': 'ALERT tones in a slightly wider channel',
    '12K5F2D': 'data filling a whole 12.5 kHz channel',
    '16K0F2D': 'data in an older 25 kHz channel',
    '10K1F3E': 'narrow-band FM voice — it appears on some telemetry licences all the same',
    '2K00G1D': 'the satellite uplink of a data collection platform, near 402 MHz',
  };
  function emHtml() {
    const e = S.em in EM ? S.em : '7K50F2D';
    const bw = e.slice(0, 4), unit = { H: 'Hz', K: 'kHz', M: 'MHz' }[bw.match(/[HKM]/)[0]];
    const width = `${Number(bw.replace(/[HKM]/, '.'))} ${unit}`;
    const mod = { F: 'Frequency modulation (FM): the signal nudges the frequency up and down.', G: 'Phase modulation: the signal shifts the wave’s timing.', A: 'Amplitude modulation, both sidebands.' }[e[4]];
    const sig = { 1: 'One digital channel, keyed directly — no tones.', 2: 'One digital channel sent as audio tones on the carrier — how ALERT sends its bits.', 3: 'One analogue channel, such as a voice.' }[e[5]];
    const info = { D: 'Data, telemetry or telecommand.', E: 'Telephony — speech.' }[e[6]];
    const part = (chars, title, text) => `<li class="rlc-em-part"><span class="rlc-em-chars">${esc(chars)}</span><strong>${esc(title)}</strong><span>${esc(text)}</span></li>`;
    return `<div class="rlc-em" id="rlc-em" aria-live="polite">
        <p class="rlc-em-whole"><span class="rlc-em-code">${esc(e)}</span> ${esc(EM[e])}</p>
        <ol class="rlc-em-parts">
          ${part(bw, 'How wide', `${width}. The letter stands where the decimal point goes and gives the unit.`)}
          ${part(e[4], 'How it is modulated', mod)}
          ${part(e[5], 'What kind of signal', sig)}
          ${part(e[6], 'What it carries', info)}
        </ol>
      </div>`;
  }

  function labelHtml() {
    const q = S.label;
    const box = (k, text) => `<label class="rlc-label-q"><input type="checkbox" ${q[k] ? 'checked' : ''} onchange="KbLicensing.set('label:${k}', this.checked)"> ${text}</label>`;
    const need = q.lic && q.w2 && q.shared;
    const why = !q.lic ? 'Only a transmitter named on a licence has a frequency assignment number to show.'
      : !q.w2 ? 'At 2 W EIRP or less the rule does not apply.'
        : !q.shared ? 'With no other assigned transmitter within 200 metres it is not a shared site, so the rule does not apply. A label does no harm.'
          : 'Fit a label with the transmitter’s frequency assignment number and “Do Not Remove”, in a colour that stands out.';
    return `<fieldset class="rlc-seg rlc-label-fs"><legend>Does this transmitter need one?</legend>
        ${box('lic', 'It is a fixed transmitter named on a licence — a base or a repeater, not an unlisted gauge')}
        ${box('w2', 'Its licence allows more than 2 W EIRP')}
        ${box('shared', 'Another licensed fixed transmitter stands within 200 metres, in the same band')}
      </fieldset>
      <p class="rlc-ex-verdict rlc-ex-${need ? 'warn' : 'ok'}" id="rlc-label-verdict" aria-live="polite">${need ? 'Yes — it must carry the label' : 'No label is required'}</p>
      <p class="small">${esc(why)}</p>`;
  }

  function baseHtml() {
    const pdf = typeof MapAcma !== 'undefined' && MapAcma.pdfUrl ? MapAcma.pdfUrl('1463975/1') : '';
    const row = (k, v, what) => `<tr><th scope="row">${k}</th><td>${v}</td><td>${what}</td></tr>`;
    return sect('base', `${head('base', '🗼', 'A base’s limits, and a repeater’s', 'The station the licence names may do what the licence lists — and a repeater is always one of those.')}
      <p><strong>A repeater is a base station.</strong> It transmits to carry other stations’ messages, so it cannot ride on another licence the way a gauge
        does. It needs a licence naming its own site; the ACMA licences tool on the Stations map shows which repeaters have one. A repeater with none, sitting inside another
        base’s circle, is covered only if it is a true ${t('fillin', 'fill-in')}; one that reaches further is “another master station” (${c('fx16-another-master')}).</p>

      <h4>What ACMA plans each kind of system on</h4>
      <div class="table-wrap"><table class="rlc-table rlc-models">
        <caption>RALI FX16’s two service models</caption>
        <thead><tr><th scope="col">&nbsp;</th><th scope="col">High power</th><th scope="col">Low power</th></tr></thead>
        <tbody>
          <tr><th scope="row">Base’s ${t('eirp')}, at most</th><td>40 W (${c('fx16-eirp-master', 's 3.1')})</td><td>8.3 W (${c('fx16-low-eirp', 's 3.2')})</td></tr>
          <tr><th scope="row">A gauge’s EIRP, at most</th><td>20 W (${c('fx16-eirp-remote', 's 3.1')})</td><td>8.3 W</td></tr>
          <tr><th scope="row">${t('servicearea', 'Service area')}</th><td>30 km (${c('fx16-30km', 's 3.1')})</td><td>2 km (${c('fx16-2km', 's 3.2')})</td></tr>
          <tr><th scope="row">${t('reuse', 'Re-use distance')}</th><td>100 km (${c('fx16-reuse', 's 3.1')})</td><td>10 km (${c('fx16-low-reuse', 's 3.2')})</td></tr>
          <tr><th scope="row">Base antenna</th><td>Upright, 8.2 dBi at most (${c('fx16-master-antenna', 's 3.1')})</td><td>Planned on the same</td></tr>
          <tr><th scope="row">${t('eah', 'Antenna height')} assumed</th><td>Base 200 m, gauge 5 m (${c('fx16-heights', 's 3.1')})</td><td>Base 10 m, gauge 3 m</td></tr>
          <tr><th scope="row">Fill-in transmitters</th><td>Allowed inside the area (${c('fx16-fill-in', 's 3.1')})</td><td>Not provided for</td></tr>
        </tbody></table></div>
      <p>The same service areas apply when a point-to-multipoint licence is assigned on channels otherwise set aside for land mobile radio
        (${c('fx16-land-mobile', 's 5.4')}) — the register files those as <em>Point to Multipoint – Land Mobile Spec</em>.</p>

      <h4>A fill-in gets weaker the further it is from the base</h4>
      <div class="table-wrap"><table class="rlc-table rlc-fill">
        <caption>What a supplementary base station may run, by its distance from the base (${c('fx16-fill-in-table', 'FX16 Table 2')})</caption>
        <thead><tr><th scope="col">Distance from the base</th><th scope="col">EIRP, at most</th><th scope="col">${t('eah', 'Effective antenna height')}</th></tr></thead>
        <tbody><tr><td>Under 10 km</td><td>20 W</td><td>100 m</td></tr><tr><td>Under 20 km</td><td>10 W</td><td>25 m</td></tr><tr><td>Under 30 km</td><td>5 W</td><td>5 m</td></tr></tbody>
      </table></div>

      <h4>A licence document, line by line</h4>
      <p>Each licence is a three-page PDF from ACMA. This is what one says and what each line is for — the values are those of the Bureau’s licence for Takura Hill, near Hervey Bay
        ${pdf ? `(${out('ACMA’s own document', pdf)})` : ''}.</p>
      <div class="table-wrap"><table class="rlc-table rlc-doc">
        <caption>Licence 1463975/1, as issued 28 September 2026</caption>
        <thead><tr><th scope="col">The line</th><th scope="col">It says</th><th scope="col">What that means</th></tr></thead>
        <tbody>
          ${row(t('licensee'), 'Bureau of Meteorology', 'Who may transmit under it, and who may let others do so in writing.')}
          ${row('Licence service', 'Fixed — Point to Multipoint', 'The type. It decides which of the determination’s conditions apply.')}
          ${row('Licence number', '1463975/1', 'The number, then the issue. Type it into the Stations map’s search to find it.')}
          ${row(t('callsign'), 'VZ4MET', 'The station’s identifier.')}
          ${row('Date of effect and expiry', '28 Sep 2026 to 23 Sep 2027', 'A year. After the expiry date it authorises nothing until renewed.')}
          ${row(t('special', 'Special conditions'), 'None on this one', 'Where a licence has any, they are listed here and they outrank the general rules.')}
          ${row(t('advisory', 'Advisory note'), 'Points to the Transmitter Licence and Fixed Licence determinations', 'Where the standing conditions are. Nothing about distance or a service area.')}
          ${row('Site', 'ACMA site 16671, Takura Hill, with its latitude and longitude', 'The base station: the one place the licence names.')}
          ${row(t('frequency', 'Assigned frequency'), '151.5 MHz, to transmit and to receive', `The channel. The gauges send on the frequency the base receives on. ${t('simplex', 'Single frequency')}.`)}
          ${row(t('bandwidth'), '12.5 kHz', 'The width of the channel.')}
          ${row(t('txpower', 'Transmitter power'), '5 W', 'The most the base’s radio may put out.')}
          ${row(t('eirp'), '8.4 W', 'The most the base may radiate in its strongest direction.')}
          ${row(t('fan', 'Freq. assign. ID'), '0001167088 to transmit, 0001167091 to receive', 'ACMA’s number for this one use of the channel. The transmit one goes on the transmitter’s label — see below.')}
          ${row(t('emission', 'Emission designator'), '10K1F3E', 'The kind of signal — taken apart below.')}
          ${row(t('polarisation', 'Antenna'), 'Vertical; “Colinear Vertical”', `An upright ${t('collinear')}: all round the compass.`)}
        </tbody></table></div>

      <h4 id="rlc-label-h" tabindex="-1">A label on the transmitter</h4>
      <p>There is one thing the law asks to be <em>physically on the equipment</em>. A licensed transmitter of more than 2 W ${t('eirp')} at a
        ${t('communal', 'shared site')} must carry a label with its ${t('fan', 'frequency assignment number')} and the words “Do Not Remove”
        (${c('label-what', 'what the label says')}; ${c('label-which', 'which transmitters')}). It is there so that anybody tracing interference in a hut
        full of radios can tell whose each one is and look it up. It is not the whole licence: no name, no licence number, no expiry date is asked for.</p>
      <div class="rlc-two">
        <div>
          <div class="rlc-label-eg" role="img" aria-label="An example label: Frequency assignment 0001167088, Do Not Remove — black on white.">
            <span class="rlc-label-k">Freq. assign. ID</span><span class="rlc-label-v">0001167088</span><span class="rlc-label-d">DO NOT REMOVE</span>
          </div>
          <p class="small txt-muted">An example, with Takura Hill’s number. Any size and wording will do so long as it carries the number and “Do Not Remove” in a colour
            that stands out from its background (${c('label-form', 'the one rule on form')}).</p>
        </div>
        <div class="rlc-label-check" id="rlc-label-check">${labelHtml()}</div>
      </div>
      <ul class="rlc-list">
        <li><strong>Where the number is.</strong> On the licence document as “Freq. assign. ID”, on the transmitter’s line — not the receiver’s. The ACMA licences tool
          on the Stations map shows it beside each licensed transmitter (${c('label-number', 'what the number is')}).</li>
        <li><strong>What counts as a shared site.</strong> ${c('int-communal', 'Two or more fixed transmitters')} on assigned frequencies within 200 metres of each other, in the
          same broad band — for this network, 30 to 300 MHz. A place that had only two when the rule changed on 31 March 2025 is not counted until it has three
          (${c('int-communal-3', 'the carry-over')}). A repeater in a hut on a hill with other services is the usual case.</li>
        <li><strong>A gauge on its own</strong> at a riverbank is not at a shared site, and as an unlisted remote station it has no frequency assignment number to show. The rule is aimed at
          the licensed transmitters in the register.</li>
        <li><strong>Who must do it, and what if nobody does.</strong> Whoever operates the transmitter — the licence holder, or somebody it has authorised. Not doing so can draw a civil
          penalty of up to 100 penalty units, ${dollars(100)} (${c('act-300-must', 'Act, section 300')}).</li>
      </ul>

      <h4>The emission code, taken apart</h4>
      <div class="pill-row" role="group" aria-label="Pick an emission designator" id="rlc-em-picks">
        ${Object.keys(EM).map(e => `<button type="button" class="pill${S.em === e ? ' is-on' : ''}" aria-pressed="${S.em === e}" onclick="KbLicensing.set('em', '${e}')">${e}</button>`).join('')}
      </div>
      ${emHtml()}`);
  }

  // ── Receivers ───────────────────────────────────────────────────────────────

  function rxHtml() {
    return sect('rx', `${head('rx', '👂', 'Receivers', 'Listening needs no licence. A licence for a receiver buys protection, not permission.')}
      <ul class="rlc-cards">
        <li class="rlc-card rlc-card-on"><h4>A base that only listens</h4>
          <p>Needs nothing. Section 46 applies to a receiver only if it is one of six listed kinds (${c('types-receivers', 'the list')}), and a plain
            listening base is not one of them unless somebody has had it coordinated and licensed.</p></li>
        <li class="rlc-card"><h4>The base’s receiver on a point-to-multipoint licence</h4>
          <p>The licence lists a receive frequency beside the transmit one. That is the licence <em>referring</em> to the receiver — it is what the gauges are
            allowed to transmit to — not licensing it: ${c('lcd-receiver')}.</p></li>
        <li class="rlc-card"><h4>A ${t('rxlic', 'fixed receive licence')}</h4>
          <p>Optional. It is for a station “only used for receiving messages” whose position ACMA then plans around, so later transmitters are kept from
            drowning it (${c('int-receive', 'the definition')}). Worth it for a receiving site that matters and has no transmitter licence of its own.</p></li>
      </ul>
      <p><strong>What “protected” does and does not mean.</strong> ACMA will not license a later transmitter that its planning shows would interfere. It does not
        mean nobody can ever interfere, and several licences in the register say outright that they are on a
        ${t('nointerference', 'no interference, no protection')} footing. If a licensed service is being disturbed, the test is
        ${t('harmful', 'harmful interference')}: ${c('int-harmful', 'how the law defines it')}.</p>`);
  }

  // ── EIRP and decibels ───────────────────────────────────────────────────────

  function powerHtml() {
    const k = checkState();
    const letter = (ch, word, id, text) => `<li class="rlc-letter"><span class="rlc-letter-c" aria-hidden="true">${ch}</span>
        <div><strong>${t(id, word)}</strong><span>${text}</span></div></li>`;
    const db = (d, ratio, eg) => `<tr><td class="num">${d}</td><td>${ratio}</td><td>${eg}</td></tr>`;
    return sect('power', `${head('power', '🔆', 'EIRP and decibels', 'The figure every licence limits, one word at a time.')}
      <p>A licence does not just limit the radio. It limits how strong the station is in its strongest direction, because that is what another user of the
        channel experiences. That figure is the ${t('eirp')}: ${c('int-eirp', 'the law’s definition')}.</p>
      <ol class="rlc-letters" aria-label="EIRP, letter by letter">
        ${letter('E', 'Equivalent', 'equivalent', 'A comparison, not a measurement. “As strong as…”. Some books say Effective; it is the same thing.')}
        ${letter('I', 'Isotropically', 'isotropic', '…an imaginary antenna that radiates equally in every direction — up, down and all round — would be…')}
        ${letter('R', 'Radiated', 'radiated', '…sending out as radio waves…')}
        ${letter('P', 'Power', 'watt', '…if you fed it this many watts.')}
      </ol>
      <p class="rlc-formula"><span>EIRP</span> = <span>${t('txpower', 'radio’s power')}</span> − <span>${t('feeder', 'cable loss')}</span> + <span>${t('gain', 'antenna gain')} in ${t('dbi')}</span></p>
      <p>With the gauge set up in the checker above: ${esc(D().wattText(k.tx))} from the radio, ${num(k.loss)} dB lost in the cable, an antenna of ${num(k.a.gain, 2)} dBi —
        an EIRP of <strong id="rlc-eirp-now">${esc(D().wattText(k.eirp))}</strong>. No extra power was made: the antenna took what would have gone up into the sky and down into the ground and sent it out towards the horizon instead.</p>
      <div class="rlc-two">
        <div>
          <h4>${t('db', 'Decibels')}: adding instead of multiplying</h4>
          <div class="table-wrap"><table class="rlc-table rlc-db">
            <caption>The handful of decibel figures worth knowing</caption>
            <thead><tr><th scope="col">dB</th><th scope="col">The power is</th><th scope="col">For instance</th></tr></thead>
            <tbody>
              ${db('+3', 'doubled', '5 W becomes 10 W')}
              ${db('+6', 'four times', 'a 3-element Yagi over an isotropic antenna')}
              ${db('+10', 'ten times', '1 W becomes 10 W')}
              ${db('+20', 'a hundred times', '&nbsp;')}
              ${db('0', 'unchanged', '&nbsp;')}
              ${db('−3', 'halved', 'a long run of thin cable')}
              ${db('−10', 'a tenth', 'a 10 dB attenuator')}
            </tbody></table></div>
        </div>
        <div>
          <h4>The same power, in ${t('watt', 'watts')} and in ${t('dbm')}</h4>
          <div class="table-wrap"><table class="rlc-table rlc-db">
            <caption>Powers this page mentions, both ways</caption>
            <thead><tr><th scope="col">Watts</th><th scope="col">dBm</th><th scope="col">Where it turns up</th></tr></thead>
            <tbody>
              <tr><td class="num">0.1 W</td><td class="num">20</td><td>The class licence’s limit</td></tr>
              <tr><td class="num">1 W</td><td class="num">30</td><td>A gauge’s limit at the antenna</td></tr>
              <tr><td class="num">5 W</td><td class="num">37</td><td>A common radio; the all-round limit for a gauge</td></tr>
              <tr><td class="num">8.3 W</td><td class="num">39.2</td><td>A low-power base’s EIRP</td></tr>
              <tr><td class="num">20 W</td><td class="num">43</td><td>A gauge’s EIRP limit</td></tr>
              <tr><td class="num">40 W</td><td class="num">46</td><td>A high-power base’s EIRP</td></tr>
            </tbody></table></div>
        </div>
      </div>
      <h4>${t('dbi')} and ${t('dbd')}: two yardsticks for the same antenna</h4>
      <p>An antenna’s gain is always “compared with what?”. ACMA and licences compare with the imaginary ${t('isotropic', 'isotropic antenna')} (dBi). Antenna makers often
        compare with a real ${t('dipole', 'half-wave dipole')} (dBd), which is itself 2.15 dB better than isotropic. <strong>dBi = dBd + 2.15.</strong> A “3 dB” collinear
        in a catalogue is 5.15 dBi on a licence application. ${t('erp', 'ERP')} is to dBd what EIRP is to dBi, so an ERP is always the smaller number for the same station.</p>`);
  }

  // ── Antennas ────────────────────────────────────────────────────────────────

  function antDetail() {
    const a = D().ANTENNAS[S.pick] || D().ANTENNAS.yagi3;
    const times = Math.pow(10, a.gain / 10);
    const dBd = a.gain - 2.15;
    return `<div class="rlc-ant-card" id="rlc-ant-card" data-ant="${S.pick}" aria-live="polite">
        <div class="rlc-ant-pics">
          <figure class="rlc-ant-fig">${D().antenna(S.pick)}<figcaption>What it looks like</figcaption></figure>
          <figure class="rlc-ant-fig">${D().pattern(S.pick, 'top')}</figure>
          <figure class="rlc-ant-fig">${D().pattern(S.pick, 'side')}</figure>
        </div>
        <h4>${esc(a.name)}</h4>
        <p>${esc(a.what)}</p>
        <dl class="rlc-dl rlc-dl-tight">
          <dt>${t('gain', 'Gain')}</dt><dd>${num(a.gain, 2)} ${t('dbi')} (${dBd >= 0 ? '+' : '−'}${num(Math.abs(dBd), 2)} ${t('dbd')}) — ${num(times, 1)} times an isotropic antenna in its best direction</dd>
          <dt>Fed 1 W, its ${t('eirp')} is</dt><dd>${esc(D().wattText(times))}</dd>
          <dt>${t('beamwidth', 'Beamwidth')}</dt><dd>${a.bw >= 360 ? `All round the compass; ${a.vbw >= 360 ? 'and equally up and down' : `about ${num(a.vbw)}° top to bottom`}` : `${num(a.bw)}° between the ${t('halfpower', 'half-power points')}`}</dd>
          <dt>${t('fb', 'Front to back')}</dt><dd>${a.dir ? `${num(a.fb)} dB — ${num(100 / Math.pow(10, a.fb / 10), 1)}% of the forward power goes out behind` : 'Not a thing for an antenna with no front'}</dd>
          <dt>Used for</dt><dd>${esc(a.use)}</dd>
        </dl>
      </div>`;
  }
  const antPicks = () => Object.entries(D().ANTENNAS).map(([k, a]) => `<button type="button" class="pill${S.pick === k ? ' is-on' : ''}" aria-pressed="${S.pick === k}"
      onclick="KbLicensing.pick('${k}')">${esc(a.name)}</button>`).join('');

  function antHtml() {
    return sect('ant', `${head('ant', '📶', 'Antennas', 'An antenna makes no power. It decides where the power goes.')}
      <p>Feed the same watt into three antennas and you get three shapes. Think of a balloon holding a fixed amount of air: squeeze it flat and it bulges at the
        sides; squeeze it into a sausage and it reaches further one way. ${t('gain', 'Gain')} is how far the bulge reaches compared with the round balloon.</p>
      ${D().shapes()}
      <h4>The antennas you will meet</h4>
      <div class="pill-row rlc-ant-picks" id="rlc-ant-picks" role="group" aria-label="Pick an antenna">${antPicks()}</div>
      ${antDetail()}
      <p class="small txt-muted">Each outline shows how far the same signal would carry in each direction over open country — twice the reach takes four times the power.
        The shaded wedge is the ${t('beamwidth')}. Drawn from each antenna’s published gain, beamwidth and front-to-back figures by one formula: the right shape, not a maker’s measured plot.</p>
      <h4>Where the rules mention antennas</h4>
      <ul class="rlc-list">
        <li><strong>A base</strong> is planned on an upright (${t('polarisation', 'vertically polarised')}) antenna of no more than 8.2 dBi — a tall ${t('collinear')} (${c('fx16-master-antenna')}).</li>
        <li><strong>A gauge</strong> may use anything, but a ${t('directional')} antenna is encouraged. With an ${t('omni', 'omnidirectional')} one its whole EIRP may be no more than 5 W (${c('fx16-omni')}).
          ACMA’s example of a directional antenna at VHF is a 3-element Yagi: ${c('fx16-yagi', '6 dBi, 12 dB front to back, a 75° beam')}.</li>
        <li><strong>A point-to-point link</strong> at 148–174 MHz whose licence names no antenna must use one of at least 12 dBi with a beam of 44° or less and 20 dB front to back —
          a 6-element Yagi (${c('lcd-antenna', 'Table 1')}). If the licence names an antenna, that one must be used.</li>
        <li><strong>The licence records</strong> the antenna’s type, ${t('polarisation')}, height and — for a directional one — its ${t('azimuth')}. Changing the antenna on a base
          changes its EIRP, so it is a change to the licence.</li>
      </ul>`);
  }

  // ── Does it need its own licence? ───────────────────────────────────────────

  const WIZ = {
    start: { q: 'Does it transmit?', help: 'A gauge with a radio and an ALERT address does. So does a repeater. A base that only receives does not.',
      a: [['Yes', 'tiny'], ['No — it only listens', 'r-listen']] },
    tiny: { q: 'Is it a very low-power device — 100 mW EIRP or less, on 150.7875–152.49375 MHz?', help: 'A tenth of a watt. Almost no flood gauge is; a short-range sensor link might be.',
      a: [['Yes', 'r-class'], ['No — a watt or more', 'relay']] },
    relay: { q: 'Does it pass on other stations’ messages?', help: 'A repeater does. A gauge sends only its own readings.',
      a: [['Yes — it relays', 'r-relay'], ['No — only its own readings', 'hasbase']] },
    hasbase: { q: 'Is the repeater or base it transmits to licensed, on the channel the gauge uses?', help: 'On the Stations map, open 📜 ACMA licences and find the station: it lists the licensed bases nearest to it and their channels.',
      a: [['Yes', 'limits'], ['No', 'r-nobase'], ['Not sure', 'r-find']] },
    limits: { q: 'Does it keep a remote station’s limits — 1 W into the antenna, bursts of 2 seconds or less, 10 seconds or more apart?', help: 'The checker under “A gauge’s limits” works it out from the radio, the cable and the antenna.',
      a: [['Yes', 'inside'], ['No — more power, or longer or faster bursts', 'r-own']] },
    inside: { q: 'Is it inside that base’s service area — 30 km, or the distance the licence itself states?', help: 'The ACMA licences tool draws the circle and says how far each station is from the base.',
      a: [['Yes', 'r-covered'], ['No — further out', 'r-beyond']] },
  };
  const RESULTS = {
    'r-listen': ['ok', 'No licence needed', () => `Receiving needs none. If the site matters and has no transmitter licence, a ${t('rxlic', 'fixed receive licence')} is an optional way to have it protected.`],
    'r-class': ['ok', 'Covered by the class licence', () => 'It may run with no licence of its own under the low-power class licence, for as long as it stays at 100 mW EIRP or less. It has no protection from interference.'],
    'r-relay': ['bad', 'Yes — it needs a licence naming its own site', () => `A relay is a base station. Find its site in the register; if it has no licence there, it needs one through an ${t('accredited', 'accredited person')}. The one narrow exception is a true fill-in inside a licensed base’s coverage (${c('lcd-fill-gaps', 's 14(3)')}; ${c('lcd-no-extend', 's 14(4)')}).`],
    'r-nobase': ['bad', 'Yes — something must be licensed', () => 'With no licensed base on its channel there is nothing for it to ride on. Either the base it reports to is licensed as a point-to-multipoint base, or the gauge has a licence of its own.'],
    'r-find': ['warn', 'Find out first', () => 'Everything else depends on this. Look the station up in the ACMA licences tool on the Stations map; “none found” there is a prompt to look further, not a finding.'],
    'r-own': ['bad', 'Yes — or turn it down', () => `Over the remote-station limits it cannot ride on somebody’s point-to-multipoint licence (${c('lcd-power', 's 15(4)')}; ${c('lcd-timing', 's 15(3)')}). Bring it inside the limits, or license its own site for the settings it needs.`],
    'r-covered': ['ok', 'No — the base’s licence covers it', () => `It is a remote station of that licence: covered without being listed (${c('lcd-not-listed')}), and inside what the licence was planned for. If somebody other than the licence holder owns it, the holder’s written permission is needed (${c('act-114', 'Act, s 114')}).`],
    'r-beyond': ['warn', 'Not by law — but it is outside the plan', () => `The base’s licence still covers it in law; nothing there sets a distance. It is outside ACMA’s planned service area (${c('fx16-30km')}), so it is unprotected and must not interfere. See <button type="button" class="link-btn" onclick="KbLicensing.go('km30')">the 30 km question</button> for the ways through.`],
  };
  function wizHtml() {
    let node = 'start';
    const done = [];
    for (const i of S.path) {
      const n = WIZ[node];
      if (!n || !n.a[i]) break;
      done.push([n.q, n.a[i][0]]);
      node = n.a[i][1];
    }
    const past = done.map(([q, a], i) => `<li><span class="rlc-wiz-q">${esc(q)}</span> <strong>${esc(a)}</strong>
        <button type="button" class="link-btn" onclick="KbLicensing.wiz('back', ${i})" aria-label="${escAttr(`Change the answer to: ${q}`)}">change</button></li>`).join('');
    let now;
    if (WIZ[node]) {
      const n = WIZ[node];
      now = `<div class="rlc-wiz-now"><p class="rlc-wiz-ask" id="rlc-wiz-ask" tabindex="-1">${esc(n.q)}</p><p class="small txt-muted">${esc(n.help)}</p>
          <div class="pill-row">${n.a.map((a, i) => `<button type="button" class="pill rlc-wiz-a" onclick="KbLicensing.wiz('answer', ${i})">${esc(a[0])}</button>`).join('')}</div></div>`;
    } else {
      const r = RESULTS[node];
      now = `<div class="rlc-wiz-now rlc-wiz-result rlc-ex-${r[0]}" data-result="${node}"><p class="rlc-wiz-ask" id="rlc-wiz-ask" tabindex="-1">${esc(r[1])}</p><p>${r[2]()}</p>
          <button type="button" class="pill" onclick="KbLicensing.wiz('reset')">Start again</button></div>`;
    }
    return `<div class="rlc-wiz" id="rlc-wiz">${past ? `<ol class="rlc-wiz-past">${past}</ol>` : ''}${now}</div>`;
  }
  function needHtml() {
    return sect('need', `${head('need', '🧭', 'Does it need a licence of its own?', 'Six questions at most, for any one station.')}
      ${wizHtml()}`);
  }

  // ── Ours, counted ───────────────────────────────────────────────────────────

  function summarise(raw) {
    const H = raw.holders || [], Ls = raw.licences || [], Dv = raw.devices || [], C = raw.conditions || [];
    const bureau = new Set(H.map((h, i) => (h[4] === 'bureau' ? i : -1)).filter(i => i >= 0));
    const isPmp = l => /multipoint/i.test(l[2] || '');
    const live = l => /^granted/i.test(l[1] || '');
    const mine = Ls.map((l, i) => ({ l, i })).filter(x => bureau.has(x.l[5]) && live(x.l));
    const pmpAll = Ls.filter(l => isPmp(l) && live(l));
    const stated = pmpAll.filter(l => (l[7] || []).some(ci => /service area of \d/i.test(C[ci] || '')));
    const range = pmpAll.filter(l => (l[7] || []).some(ci => /within range of/i.test(C[ci] || '')));
    const eg = stated.length ? ((C[(stated[0][7] || []).find(ci => /service area of \d/i.test(C[ci] || ''))] || '').match(/service area of \d+(?:\.\d+)?\s*km/i) || ['a service area of 20 km'])[0] : 'a service area of 20 km';
    const pmpIdx = new Set(mine.filter(x => isPmp(x.l)).map(x => x.i));
    const tx = Dv.filter(d => d[2] === 'T' && pmpIdx.has(d[0]) && d[3] >= 148 && d[3] <= 174);
    const bins = [['8.3 W or less', 0, 'rlc-bar-low'], ['8.4 W', 0, ''], ['8.5 to 20 W', 0, ''], ['20 to 40 W', 0, ''], ['Over 40 W', 0, 'rlc-bar-bad']];
    const chans = {};
    for (const d of tx) {
      const e = d[7];
      if (e != null) bins[e <= 8.3 ? 0 : e <= 8.45 ? 1 : e <= 20 ? 2 : e <= 40 ? 3 : 4][1]++;
      chans[d[3]] = (chans[d[3]] || 0) + 1;
    }
    const top = Object.entries(chans).sort((a, b) => b[1] - a[1]);
    const soon = mine.filter(x => { const dd = Date.parse(`${String(x.l[4]).slice(0, 10)}T23:59:59Z`); return Number.isFinite(dd) && (dd - Date.now()) / 864e5 <= 90; }).length;
    return { asAt: L().dateText((raw.meta && raw.meta.source_date) || L().SNAPSHOT), total: Ls.length, holders: H.length,
      mine: mine.length, minePmp: mine.filter(x => isPmp(x.l)).length, minePtp: mine.filter(x => !isPmp(x.l)).length,
      pmp: pmpAll.length, statedN: stated.length, statedEg: eg, rangeN: range.length, bins, txN: tx.length, top, soon };
  }
  function oursBody() {
    if (!reg) return regErr ? `<p class="txt-warn">The register copy could not be read here (${esc(regErr)}).</p>` : '<p class="txt-muted" aria-busy="true">Reading the register copy…</p>';
    const tile = (n, label) => `<li class="rlc-tile"><span class="rlc-tile-n">${n}</span><span class="rlc-tile-l">${label}</span></li>`;
    const main = reg.top[0] || [151.5, 0];
    return `<ul class="rlc-tiles" aria-label="The Bureau’s licences in force">
        ${tile(reg.mine, 'Bureau licences in force')}
        ${tile(reg.minePmp, `${t('pmp', 'point to multipoint')} — a base and its gauges`)}
        ${tile(reg.minePtp, `${t('ptp', 'point to point')} — a link`)}
        ${tile(reg.soon, 'expire within 90 days')}
      </ul>
      <p>From ${t('register', 'ACMA’s register')} as it stood on ${esc(reg.asAt)} — ${reg.total} licences of ${reg.holders} holders are kept, the Bureau’s and those of councils and
        water authorities on the same channels. <strong>${main[1]}</strong> of the Bureau’s ${reg.txN} VHF base transmitters are on <strong>${num(main[0], 4)} MHz</strong>.</p>
      <h4>How strong the Bureau’s VHF bases are licensed to be</h4>
      ${figure('The Bureau’s VHF point-to-multipoint bases by licensed EIRP', D().bars(reg.bins.map(([l, n, cls]) => [l, n, cls]),
        `The Bureau’s ${reg.txN} VHF base transmitters by licensed EIRP: ${reg.bins.map(([l, n]) => `${n} at ${l}`).join(', ')}.`),
        `8.3 W is where ACMA’s low-power model stops and 40 W where its high-power model does. A base just over 8.3 W is a high-power system in the plan; the register does not say which model a licence was assigned on.`)}
      <details class="rlc-sure"><summary>The same counts as a table</summary>
        <div class="table-wrap"><table class="rlc-table"><caption>The Bureau’s VHF base transmitters by licensed EIRP</caption>
          <thead><tr><th scope="col">Licensed EIRP</th><th scope="col">Base transmitters</th></tr></thead>
          <tbody>${reg.bins.map(([l, n]) => `<tr><td>${esc(l)}</td><td class="num">${n}</td></tr>`).join('')}</tbody></table></div>
      </details>`;
  }
  function oursHtml() {
    return sect('ours', `${head('ours', '🧮', 'Ours, counted', 'The licences this network runs under, from the register copy Flood-Net refreshes each week.')}
      <div id="rlc-ours-body">${oursBody()}</div>
      <p><button type="button" class="primary" onclick="KbLicensing.tool()"><span aria-hidden="true">📜</span> Open the ACMA licences tool on the Stations map</button></p>
      <p class="small txt-muted">The tool draws every licence at its site with its service area, and says for each transmitting station whether a licence is at its site, it is
        inside a licence’s area, it reports to a licensed base from beyond the area, or none was found.</p>`);
  }

  // ── ACMA's pages, and a question to send ────────────────────────────────────

  const LINKS = [
    ['Start here', [
      ['Fixed licences', 'https://www.acma.gov.au/licences/fixed-licence', 'What a fixed licence is and how to apply.'],
      ['Options for fixed licences', 'https://www.acma.gov.au/options-fixed-licences', 'Point to multipoint, point to point and the rest, side by side.'],
      ['Apparatus licences', 'https://www.acma.gov.au/apparatus-licences', 'How apparatus licences work in general.'],
      ['Let someone else use your licence', 'https://www.acma.gov.au/let-someone-else-use-your-licence', 'Authorising a third party in writing.'],
    ]],
    ['Look a licence up', [
      ['Register of Radiocommunications Licences', 'https://www.acma.gov.au/register-radiocommunications-licences-rrl', 'Search every licence by number, holder, site or frequency.'],
      ['Radiocomms licence data', 'https://www.acma.gov.au/radiocomms-licence-data', 'The whole register as a daily download — what Flood-Net reads.'],
    ]],
    ['The rules behind an assignment', [
      ['RALIs to coordinate frequencies', 'https://www.acma.gov.au/ralis-frequency-coordination', 'Every assignment instruction, FX16 among them, in its current version.'],
      ['Band plans and allocations', 'https://www.acma.gov.au/band-plans-allocate-spectrum', 'Which service each part of the spectrum is for, including the VHF plan (RALI MS42).'],
      ['Technical details for fixed licences', 'https://www.acma.gov.au/technical-details-fixed-licences', 'The figures an application has to give.'],
      ['Fees for apparatus licences', 'https://www.acma.gov.au/fees-apparatus-licences', 'The yearly tax by band, bandwidth, area and power.'],
    ]],
    ['Receivers, low power and interference', [
      ['Fixed receive licence', 'https://www.acma.gov.au/licences/fixed-receive-licence', 'Protecting a station that only listens.'],
      ['Low interference potential devices (LIPD) class licence', 'https://www.acma.gov.au/licences/low-interference-potential-devices-lipd-class-licence', 'The 100 mW permission nobody applies for.'],
      ['Radio reception and interference', 'https://www.acma.gov.au/radio-reception-and-interference', 'What to do when something is disturbing a service.'],
      ['Our rules for EME', 'https://www.acma.gov.au/our-rules-eme', 'Limits on human exposure to radio energy that every licensed transmitter must meet.'],
    ]],
    ['The law itself', [
      ['Radiocommunications Act 1992', 'https://www.legislation.gov.au/C2004A04465/latest/text', 'Sections 46, 97, 107, 113 and 114 are the ones quoted here.'],
      ['Fixed Licence determination 2025', 'https://www.legislation.gov.au/F2025L00388/latest/text', 'The conditions on every fixed licence, in the version in force.'],
      ['Interpretation determination 2025', 'https://www.legislation.gov.au/F2025L00362/latest/text', 'What “point to multipoint station”, “fixed receive station” and “harmful interference” mean.'],
      ['LIPD class licence 2025', 'https://www.legislation.gov.au/F2025L01047/latest/text', 'Schedule 1, item 17 is the 100 mW limit for this band.'],
    ]],
  ];
  const ASK = `To: freqplan@acma.gov.au (copy info@acma.gov.au)
Subject: RALI FX16 — remote stations beyond the 30 km service area of an existing point-to-multipoint licence

We operate flood-warning telemetry in the VHF high band. Rain and river gauges report as remote stations to base stations that hold Fixed (Point to Multipoint) licences, most of them on 151.5 MHz, single frequency.

RALI FX16 (25 March 2025), section 3.1, gives a service area radius of 30 km and says all stations must be contained within it. The Radiocommunications Licence Conditions (Fixed Licence) Determination 2025 sets no distance for a remote station, and its explanatory statement says such transmitters "can be located anywhere".

Some of our gauges are more than 30 km from the licensed base they report to. Could you confirm:

1. Is a remote station that reports to a licensed base from beyond 30 km authorised by that base's licence, provided it meets sections 13, 15 and 23 of the Determination and causes no harmful interference?
2. If it is, is our understanding right that it has no protection beyond the service area and operates on a no-interference basis?
3. Would ACMA prefer such stations to be brought under a licence for a nearer base station, and is there a preferred way to do that for an existing network?
4. Do the service models of FX16 apply to these single-frequency licences on 151.5 MHz, or were they assigned under another RALI?

Thank you.`;

  function askHtml() {
    return sect('ask', `${head('ask', '☎️', 'ACMA’s pages, and who to ask', 'The regulator’s own words, and the one question worth sending.')}
      <div class="rlc-links">
        ${LINKS.map(([group, items]) => `<div class="rlc-linkgroup"><h4>${esc(group)}</h4><ul>
          ${items.map(([label, href, what]) => `<li>${out(label, href)}<span>${esc(what)}</span></li>`).join('')}</ul></div>`).join('')}
      </div>
      <p class="small txt-muted">Links were current on ${esc(L().dateText(L().SNAPSHOT))}. ACMA’s website refuses automated visits, so its pages were found by search and not
        opened by this guide’s author; the legislation links were opened and read.</p>
      <h4>Who to ask</h4>
      <ul class="rlc-list">
        <li><strong>ACMA’s customer service</strong> — 1300 850 115, info@acma.gov.au — for a particular licence, a renewal or a fee.</li>
        <li><strong>ACMA’s Spectrum Planning Section</strong> — freqplan@acma.gov.au — for what a RALI means, and for an exception to one. It is the address FX16 itself gives.</li>
        <li><strong>An ${t('accredited', 'accredited person')}</strong> — to assign a channel and lodge a new licence. They deal with ACMA for you.</li>
        <li><strong>The licence holder</strong> — the Bureau, for most of this network — before putting anybody else’s transmitter on its licence.</li>
      </ul>
      <h4>The question to send about 30 km</h4>
      <p>A written answer from ACMA is the only thing that turns “follows from the documents” into “confirmed”. This draft asks it; change it to suit and send it from your own address.</p>
      <label class="sr-only" for="rlc-ask-text">A draft question for ACMA</label>
      <textarea id="rlc-ask-text" class="rlc-ask-text" rows="14" readonly>${esc(ASK)}</textarea>
      <p><button type="button" class="primary" id="rlc-ask-copy" onclick="KbLicensing.copyAsk(this)">Copy the draft</button></p>`);
  }

  // ── The documents ───────────────────────────────────────────────────────────

  function docsHtml() {
    return sect('docs', `${head('docs', '📚', 'The documents', 'Read each one here, open the saved copy, or go to the current version.')}
      ${L().libraryHtml()}`);
  }

  // ── Six cases ───────────────────────────────────────────────────────────────

  const QUIZ = [
    ['A new rain gauge, 1 W into a collinear antenna, 12 km from a Bureau repeater that has a point-to-multipoint licence on 151.5 MHz.',
      'Covered, with nothing more to do.', () => `It is a remote station of the repeater’s licence: unlisted, inside the 30 km service area, inside the power limit. It needs the Bureau’s agreement if it is not the Bureau’s gauge (${c('act-114', 'Act, s 114')}).`],
    ['The same gauge, but 44 km from that repeater, with no nearer licensed base.',
      'Still covered in law. Outside the plan.', () => `No distance is set by law (${c('es-anywhere')}), so it is not unlicensed. It is outside FX16’s service area (${c('fx16-30km')}): unprotected, and it must stop if it interferes. Record it and consider asking ACMA.`],
    ['A river gauge with a 5 W radio on half a metre of cable, reporting to a licensed repeater 8 km away.',
      'Over the power limit — close, but not covered as it stands.', () => `About 4.5 W reaches the antenna; the limit for a remote station is 1 W (${c('lcd-power', 's 15(4)')}). Turn it down or fit an attenuator, or license its own site for 5 W.`],
    ['A solar-powered repeater on a ridge 50 km from the nearest licensed base, relaying six gauges to it.',
      'Needs its own licence.', () => `It relays, and it carries the signal beyond the base’s reach. The law forbids a fill-in extending coverage (${c('lcd-no-extend', 's 14(4)')}) and FX16 calls it another master station (${c('fx16-another-master')}).`],
    ['An office base station with a receiver and an antenna, and no transmitter.',
      'No licence needed.', () => `Listening needs none. A ${t('rxlic', 'fixed receive licence')} is optional, for protection (${c('int-receive')}).`],
    ['A council wants to put its own gauge on the Bureau’s 151.5 MHz channel near a Bureau repeater.',
      'It needs the Bureau’s written permission, or its own licence.', () => `Only the licensee and those it has authorised in writing may transmit under a licence (${c('act-114', 'Act, s 114')}). The council’s alternative is a licence of its own.`],
    ['A Bureau repeater licensed for 17 W EIRP, in a hilltop hut it shares with a council’s two-way radio base and a mobile phone tower.',
      'It must carry a label.', () => `Over 2 W EIRP at a shared site: the transmitter needs a label with its frequency assignment number and “Do Not Remove” (${c('label-what')}). The number is on its licence document.`],
  ];
  function quizHtml() {
    return sect('quiz', `${head('quiz', '✅', 'Try seven cases', 'Decide, then open each to see the answer and where it is written.')}
      <ol class="rlc-quiz">${QUIZ.map(([q, a, why], i) => `<li><details class="rlc-case" data-case="${i}"><summary>${esc(q)}</summary>
        <p class="rlc-case-a">${esc(a)}</p><p>${why()}</p></details></li>`).join('')}</ol>`);
  }

  // ── The page ────────────────────────────────────────────────────────────────

  function render() {
    return `<div class="page rlc-page" id="rlc-page" style="--page-max:1100px">
      ${heroHtml()}${whoHtml()}${pmpHtml()}${km30Html()}${gaugeHtml()}${baseHtml()}${rxHtml()}${powerHtml()}${antHtml()}
      ${needHtml()}${oursHtml()}${askHtml()}${docsHtml()}${quizHtml()}
      <section class="panel rlc-sect" id="rlc-glossary-sect" aria-labelledby="rlc-glossary-h">
        <h3 id="rlc-glossary-h" tabindex="-1"><span aria-hidden="true">🔤</span> What the words on this page mean</h3>
        <details class="rlc-glossary" id="rlc-glossary"><summary>Every marked word, in plain words — and the words each is built from</summary>
          ${W().glossaryHtml()}</details>
      </section>
    </div>`;
  }

  const el = id => document.getElementById(id);
  const here = () => !!el('rlc-page');

  function paintExplorer() {
    if (!el('rlc-ex-svg')) return;
    const e = explorerState();
    D().placeExplorer({ km: e.km, radius: e.m.radius, reuse: e.m.reuse, state: e.state, name: explorerName() });
    const o = el('rlc-km-out'); if (o) o.textContent = `${num(e.km)} km`;
    const r = el('rlc-ex-read'); if (r) r.innerHTML = explorerReadout();
  }
  function paintCheck() {
    const o = el('rlc-check-out'); if (o) o.innerHTML = checkOut();
    const n = el('rlc-eirp-now'); if (n) n.textContent = D().wattText(checkState().eirp);
  }

  function loadRegister() {
    if (reg) return;
    const get = typeof acmaFetchJson === 'function' ? acmaFetchJson('acma-station-licences.json')
      : fetch('data/acma-station-licences.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    get.then(raw => { reg = summarise(raw); regErr = ''; }, e => { regErr = (e && e.message) || 'no connection'; })
      .then(() => {
        if (!here()) return;
        const a = el('rlc-ours-body'); if (a) a.innerHTML = oursBody();
        const b = el('rlc-lic-counts'); if (b) b.innerHTML = licenceCounts();
      });
  }

  function init() {
    paintExplorer();
    loadRegister();
  }

  // Scroll to a section and put the keyboard there.
  function go(id) {
    if (id === 'glossary') { const g = el('rlc-glossary'); if (g) g.open = true; }
    const h = el(id === 'glossary' ? 'rlc-glossary-h' : id === 'label' ? 'rlc-label-h' : `rlc-${id}-h`);
    if (!h) return;
    h.scrollIntoView({ block: 'start' });
    h.focus({ preventScroll: true });
  }
  // From another tab: open this one at a section.
  function open(section) {
    if (typeof switchTab === 'function') switchTab(TAB);
    if (section) requestAnimationFrame(() => go(section));
  }

  function set(key, value) {
    if (key === 'km') { S.km = Number(value) || 0; paintExplorer(); return; }
    if (key === 'kind') { S.kind = value === 'relay' ? 'relay' : 'gauge'; paintExplorer(); return; }
    if (key === 'model') {
      const was = MODELS[S.model], now = MODELS[value] ? value : 'high';
      S.km = Math.round((S.km / was.reuse) * MODELS[now].reuse * 10) / 10;
      S.model = now;
      const r = el('rlc-km');
      if (r) { r.max = MODELS[now].reuse; r.step = now === 'low' ? 0.1 : 1; r.value = S.km; }
      paintExplorer();
      return;
    }
    if (key === 'em') {
      S.em = value;
      const box = el('rlc-em'); if (box) box.outerHTML = emHtml();
      const picks = el('rlc-em-picks');
      if (picks) for (const b of picks.querySelectorAll('button')) { const on = b.textContent === value; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); }
      return;
    }
    if (key.startsWith('label:')) {
      S.label = { ...S.label, [key.slice(6)]: !!value };
      const box = el('rlc-label-check');
      if (box) { box.innerHTML = labelHtml(); const b = box.querySelector(`input[onchange*="${key}"]`); if (b) b.focus({ preventScroll: true }); }
      return;
    }
    if (['tx', 'loss', 'dur', 'gap'].includes(key)) { S[key] = Number(value) || 0; paintCheck(); return; }
    if (key === 'ant' || key === 'band') { S[key] = value; paintCheck(); }
  }
  function check(i) {
    const p = PRESETS[i];
    if (!p) return;
    Object.assign(S, p[1]);
    for (const [id, k] of [['rlc-in-tx', 'tx'], ['rlc-in-loss', 'loss'], ['rlc-in-ant', 'ant'], ['rlc-in-dur', 'dur'], ['rlc-in-gap', 'gap']]) { const x = el(id); if (x) x.value = S[k]; }
    paintCheck();
  }
  function role(k) {
    if (!ROLES[k]) return;
    S.role = k;
    const sys = el('rlc-system'); if (sys) sys.innerHTML = D().system(k);
    const picks = el('rlc-roles'); if (picks) picks.innerHTML = rolePicks();
    const card = el('rlc-role-card'); if (card) card.outerHTML = roleHtml();
    const b = picks && picks.querySelector('[aria-pressed="true"]'); if (b) b.focus({ preventScroll: true });
  }
  function pick(k) {
    if (!D().ANTENNAS[k]) return;
    S.pick = k;
    const picks = el('rlc-ant-picks'); if (picks) picks.innerHTML = antPicks();
    const card = el('rlc-ant-card'); if (card) card.outerHTML = antDetail();
    const b = picks && picks.querySelector('[aria-pressed="true"]'); if (b) b.focus({ preventScroll: true });
  }
  function wiz(what, i) {
    if (what === 'reset') S.path = [];
    else if (what === 'back') S.path = S.path.slice(0, i);
    else if (what === 'answer') S.path = [...S.path, i];
    const box = el('rlc-wiz'); if (box) box.outerHTML = wizHtml();
    const ask = el('rlc-wiz-ask'); if (ask) ask.focus({ preventScroll: true });
  }
  function copyAsk(btn) {
    const done = ok => { if (btn) { btn.textContent = ok ? 'Copied' : 'Could not copy — select the text instead'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy the draft'; }, 2500); } };
    if (typeof copyToClipboard === 'function') copyToClipboard(ASK).then(done, () => done(false));
    else done(false);
  }
  function tool() {
    if (typeof switchTab === 'function') switchTab('stations');
  }

  // The checker's answer in words, to keep with a station's notes.
  function checkText() {
    const k = checkState();
    const lines = [
      'Flood-Net — a gauge checked against the limits for a remote station',
      `Written ${new Date().toISOString().slice(0, 10)} from the Radio Licensing lesson. A guide, not legal advice.`,
      '',
      `Radio ${D().wattText(k.tx)} · cable loss ${num(k.loss)} dB · antenna ${k.a.name} (${num(k.a.gain, 2)} dBi)`,
      `Burst ${num(k.dur, 2)} s · start to start ${num(k.gap)} s · limit at the antenna ${k.lim} W`,
      '',
      ...k.rules.map(r => `${r.bad ? 'OVER  ' : 'within'}  ${r.name}: ${r.got} (allowed: ${r.limit}) — ${r.k === 'law' ? 'law' : 'ACMA policy'}, ${L().where(r.cite)}`),
      '',
      k.fails.length ? `Over on ${k.fails.length} of 6.` : 'Keeps all six limits.',
    ];
    return lines.join('\n') + '\n';
  }
  function exportTxt(what) {
    if (typeof dlText !== 'function') return;
    if (what === 'ask') dlText('question-for-acma.txt', ASK + '\n', 'text/plain');
    else dlText('gauge-licence-check.txt', checkText(), 'text/plain');
    if (typeof announce === 'function') announce(what === 'ask' ? 'Saved the question as a text file.' : 'Saved the check as a text file.');
  }

  return { render, init, open, go, set, role, wiz, pick, check, copyAsk, tool, exportTxt, checkText, tab: TAB,
    // For the checks.
    state: () => ({ ...S, path: S.path.slice() }), checkState, explorerState, summarise, sections: () => SECTIONS.map(s => s[0]), QUIZ, WIZ, RESULTS, ASK };
})();

if (typeof window !== 'undefined') window.KbLicensing = KbLicensing;
