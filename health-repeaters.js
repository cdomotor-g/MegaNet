// MegaNet — health-repeaters.js
//
//   HealthRepeaters   the Station Health tab's Repeaters card: every repeater
//                     the window's readings say anything about, a row each —
//                     the stations heard behind it and how many of their checks
//                     got through, its own station and battery, its radio as
//                     the base stations measure it — with a state, and what the
//                     evidence together points to.
//
// After health.js (Health.state, Health.select, Health.owns), health-analysis.js
// (the repeaters, the stations behind each, the findings naming one), and
// health-airtime.js, health-drift.js and health-flips.js (their state, read at
// call time); before init.js. health.js draws this card's section and calls
// render(); the drift and flips panels ask the server and call changed()
// when their answer lands, which redraws this card with it. Nothing here runs
// at load.
//
// ── What can be told about a repeater, and how ──────────────────────────────
// A legacy ALERT frame does not say which repeater relayed it, so a repeater is
// read through what it relays and what its site says of itself:
//
//   Behind it          the stations heard in the window whose addresses its
//                      pass ranges hold, within reach (health-analysis.js's
//                      members); "only through it" are those no other repeater
//                      on file passes — the ones whose silence can only be its.
//                      Their checks: of those due while a receiver that hears
//                      them listened, how many got through, against the
//                      network's.
//   Its own station    most repeater sites carry a station of their own — a
//                      battery, often a gauge — reported like any other. Heard
//                      while the stations behind it are not, the site has power
//                      and is on the air, and the fault is on the way in; silent
//                      with them, it is the site; its battery's night lows say
//                      whether power went first.
//   Shared events      Station Health's own findings naming it: the stations
//                      behind it gone quiet together (repeater-down), silences
//                      they shared and came back from (shared-spell — at night
//                      and back in daylight is a solar site), and the corrupted
//                      copies it is the common factor in (repeater-bitflips).
//   Its radio          the server's, where the base stations measure carriers
//                      (0075 to 0083): its signal over the noise and whether it
//                      is fading, its carrier against the fleet's, and the
//                      corrupted copies caught on its own carrier — which turns
//                      the pass ranges' circumstantial blame into evidence, or
//                      points it at another repeater.
//   Airtime            a pair of repeaters re-sending the same frame together
//                      (stagger-repeaters): corruption from two keying at once,
//                      not a fault in either.
//
// The state is the worst of what the row holds; "What it points to" says what
// the pieces together suggest, as possibilities, never orders — the Backbone
// tab's way of putting it, on this window's readings rather than the server's
// period. A repeater none of this reaches (nothing behind it heard, its own
// station not heard) is left out and counted.

const HealthRepeaters = (() => {

  const HOUR = 3600000, DAY = 86400000;
  const SHOW = 40;
  const SNR_THIN = 12;         // dB over the noise: little margin (backbone.js's SNR_THIN)
  const SEV_RANK = { critical: 0, warn: 1, info: 2, ok: 3 };
  // What each kind of trouble is called as a state, in the order a row's
  // state is picked when two are as bad as each other.
  const KIND_ORDER = ['offair', 'drops', 'bits', 'signal', 'power', 'site', 'carrier', 'checks', 'own', 'thin', 'blame', 'stagger'];
  const STATE_OF = { offair: 'offair', drops: 'drops', bits: 'bits', signal: 'signal', power: 'power', site: 'site', carrier: 'carrier', checks: 'checks' };
  const STATE_LABEL = {
    offair: 'Off air', drops: 'Dropping out', bits: 'Corrupting', signal: 'Fading', power: 'Power', site: 'Site silent', carrier: 'Off frequency',
    checks: 'Losing checks', watch: 'Watch', ok: 'Working', shared: 'Can\'t tell', quiet: 'Nothing behind it',
  };
  const STATE_CLS = { critical: 'txt-bad', warn: 'txt-warn', info: 'txt-muted', ok: 'txt-ok' };

  // The words this card uses in its own sense, a meaning each — on hover in
  // its headings and chips, and in the fold under the table.
  const WORDS = {
    offair: 'The base stations stopped measuring its carrier while they still measure the rest, or the stations only it can carry — or its own station with stations behind it — have gone silent: most likely the repeater itself is off the air.',
    drops: 'Stations behind it went silent together and came back, more than once or for hours: the repeater, or its link, going away for a while.',
    bits: 'It is the common factor in corrupted copies of what it relays — readings re-sent with bits flipped — or the base stations caught it sending them on its own carrier.',
    signal: 'Its signal at the base stations that hear it has fallen 3 dB or more against its own past: its antenna, feeder or connectors, or its transmitter\'s power.',
    power: 'Its own station\'s battery is low, falling or not charging — a site that may brown out.',
    site: 'The station at the repeater\'s own site has gone silent, and no station only it carries is heard since to say it still relays — the site may be going.',
    carrier: 'Its transmitter\'s frequency sits away from the rest of the fleet, or is moving: an ageing crystal, or a site running hot or cold.',
    checks: 'The stations behind it got clearly fewer of their timed checks through than the network did, while it stayed on the air: weak paths into it, or it missing frames.',
    watch: 'Nothing wrong enough to act on yet, but something to keep an eye on — the line under its state says what.',
    ok: 'The stations behind it are being heard and nothing in the readings or the radio checks counts against it.',
    shared: 'Every station behind it can come through another repeater too, and its site has no station of its own heard — so its part cannot be told from the others\'.',
    quiet: 'Its own station was heard, but no station its pass ranges hold was heard in the window.',
    behind: 'Stations heard in the window whose ALERT addresses its pass ranges hold, within reach of it. "Only through it" counts those no other repeater on file passes; "silent" those gone quiet now.',
    only: 'A station no other repeater on file passes: when it goes quiet with the repeater still on the air, it is the station; when they all do, it is the repeater.',
    checksCol: 'Of the timed checks the stations behind it owed while a receiver that hears them was listening, how many got through — against the same share across the whole network.',
    own: 'The station at the repeater\'s own site — usually its battery, often a rain gauge — and its battery\'s night-time low, the like-for-like measure of a solar site\'s charge.',
    radio: 'What the base stations measure of its transmitter: corrupted copies it could have carried (its share, where several repeaters could have), those caught on its own carrier, and its signal over the receivers\' noise.',
    share: 'Each corrupted copy is shared evenly among the repeaters that could have carried it, so a repeater collects whole ones only where it is the only way; the rate is its share against what it could have carried.',
    snr: 'Signal-to-noise ratio: how far its bursts arrive above the receiver\'s noise, in decibels. Below about 8 dB they stop decoding; under 12 dB is little margin.',
    points: 'What the evidence in the row suggests together — possibilities to check on the next visit, not a diagnosis.',
  };
  const GLOSSARY = [
    ['offair', 'Off air'], ['drops', 'Dropping out'], ['bits', 'Corrupting'], ['signal', 'Fading'], ['power', 'Power'], ['site', 'Site silent'],
    ['carrier', 'Off frequency'], ['checks', 'Losing checks'], ['watch', 'Watch'], ['ok', 'Working'], ['shared', 'Can\'t tell'],
    ['quiet', 'Nothing behind it'], ['behind', 'Behind it'], ['only', 'Only through it'], ['checksCol', 'Checks through'],
    ['own', 'Its own station'], ['radio', 'Radio'], ['share', 'Corrupted copies (its share)'], ['snr', 'SNR'], ['points', 'What it points to'],
  ];

  const S = {
    key: null,       // what the rows were worked out from
    R: null,         // analyse()'s result
    err: '',
    q: '',           // the find box
    look: false,     // only those needing a look
    all: false,      // every row, not the first SHOW
  };

  const num = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
  const pct = r => (r == null || !Number.isFinite(r) ? '—' : `${Math.round(100 * r)}%`);
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`;
  const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sgn = (v, d) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
  const isRepeater = st => !!(st && st.repeater && Array.isArray(st.repeater.pass_ranges) && st.repeater.pass_ranges.length);
  const bySev = (a, b) => (SEV_RANK[a.sev] - SEV_RANK[b.sev]) || (KIND_ORDER.indexOf(a.k) - KIND_ORDER.indexOf(b.k));
  function ago(t, now) {
    if (t == null) return '—';
    const ms = (now != null ? now : Date.now()) - t;
    return ms < 90 * 1000 ? 'just now' : `${HealthAnalysis.fmtSpan(ms)} ago`;
  }

  // ── the analysis ───────────────────────────────────────────────────────────
  // A: HealthAnalysis.run()'s result. o: { stations (the register), drift
  // (HealthDrift's summary rows), flips (flip_summary rows), flipFindings (the
  // open transmitter-corrupting findings), suggestions (Airtime's), radio
  // (whether the server's checks have answered) }. Pure: no DOM, no fetch.
  function analyse(A, o) {
    o = o || {};
    const now = A.now != null ? A.now : Date.now();
    const stations = o.stations || [];
    const reps = A.repeaters || [];
    // How many repeaters heard behind could carry each station heard.
    const carriers = new Map();
    reps.forEach(R => R.members.forEach(M => carriers.set(M.st.id, (carriers.get(M.st.id) || 0) + 1)));
    const medRate = median(reps.filter(R => R.sent >= 20).map(R => R.rate)) || 0;
    const netRate = A.counts && A.counts.checksDue ? A.counts.checksReceived / A.counts.checksDue : null;
    const driftBy = new Map();
    (o.drift || []).forEach(r => { const id = r.tx && r.tx.startsWith('st:') ? r.tx.slice(3) : r.who && r.who.id; if (id && !driftBy.has(id)) driftBy.set(id, r); });
    // The last day the base stations measured each carrier, and the fleet's:
    // a transmitter measured for days that then falls two days behind the
    // rest has stopped transmitting, whatever the stations behind it say.
    const lastDay = r => (r && Array.isArray(r.pts) && r.pts.length ? Math.max(...r.pts.map(p => p.t)) : null);
    const fleetDay = (o.drift || []).reduce((m, r) => { const d = lastDay(r); return d != null && (m == null || d > m) ? d : m; }, null);
    const flipBy = new Map();
    (o.flips || []).forEach(r => { if (r.tx && r.tx.startsWith('st:')) flipBy.set(r.tx.slice(3), r); });
    const flipF = new Map();
    (o.flipFindings || []).forEach(f => { if (f.subject) flipF.set(f.subject, f); });
    const stagger = new Map();
    (o.suggestions || []).filter(s => s.kind === 'stagger-repeaters').forEach(s => (s.repeaterIds || []).forEach((id, i) => {
      if (!stagger.has(id)) stagger.set(id, []);
      stagger.get(id).push({ s, other: (s.repeaterNames || [])[1 - i] || '' });
    }));
    const names = (list, n) => list.slice(0, n).map(M => M.st.name).join(', ') + (list.length > n ? ` and ${list.length - n} more` : '');

    function build(st, R) {
      const id = st.id;
      const own = A.stations.get(id) || null;
      // The site's own station is in its own pass ranges more often than not:
      // it is the site, not a station behind it.
      const members = R ? R.members.filter(M => M.st.id !== id) : [];
      const only = members.filter(M => carriers.get(M.st.id) === 1);
      const silent = members.filter(M => M.findings.some(f => f.kind === 'silent'));
      const onlySilent = only.filter(M => silent.includes(M));
      const checksOf = list => {
        let due = 0, got = 0;
        list.forEach(M => { const c = M.schedule && M.schedule.counts; if (c) { due += c.due; got += c.hits + c.partial; } });
        return { due, got, rate: due ? got / due : null };
      };
      const all = checksOf(members), mine = checksOf(only);
      const lead = only.length ? only : members;
      const lastBehind = lead.reduce((m, M) => (M.lastHeard != null && (m == null || M.lastHeard > m) ? M.lastHeard : m), null);
      const ownSilent = own ? own.findings.find(f => f.kind === 'silent') || null : null;
      const power = own ? own.findings.filter(f => f.category === 'power' && f.kind !== 'battery-float' && f.kind !== 'battery-overcharge')
        .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0] || null : null;
      const B = own && own.battery && own.battery.series && own.battery.series.length >= 2 ? own.battery : null;
      const naming = f => !!(f.evidence && Array.isArray(f.evidence.repeaters) && f.evidence.repeaters.includes(id));
      const down = A.findings.find(f => f.kind === 'repeater-down' && (f.repeaterId === id || naming(f))) || null;
      const spells = A.findings.filter(f => f.kind === 'shared-spell' && naming(f));
      const lon = Number.isFinite(st.lon) ? st.lon : 150;
      const night = spells.filter(f => HealthAnalysis.solarNight(f.evidence.from, f.evidence.to, lon)).length;
      const bitsF = A.findings.find(f => f.kind === 'repeater-bitflips' && f.repeaterId === id) || null;
      const d = driftBy.get(id) || null;
      const fl = flipBy.get(id) || null;
      const flF = flipF.get('st:' + id) || null;
      const pairs = stagger.get(id) || [];
      const dLast = lastDay(d);
      const carrierGone = d && d.pts.length >= 3 && fleetDay != null && dLast <= fleetDay - 2 * DAY ? dLast : null;
      // The stations behind it that went quiet with its own station: last
      // heard inside one check period of it — how a shared failure looks
      // (health-analysis.js's repeater-down, with the site as the anchor).
      const periodOf = M => (M.schedule ? M.schedule.P : 3 * HOUR);
      const withOwn = ownSilent && own.lastHeard != null
        ? silent.filter(M => M.lastHeard != null && Math.abs(M.lastHeard - own.lastHeard) <= Math.max(3 * HOUR, 1.25 * periodOf(M))) : [];

      const issues = [];
      const add = (k, sev, text) => issues.push({ k, sev, text });
      const dayText = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      if (carrierGone != null) {
        add('offair', ownSilent || silent.length >= 2 || down ? 'critical' : 'warn',
          `Its carrier has not been on the air since ${dayText(carrierGone)}${ownSilent ? ', and its own station went quiet' : ''}`);
      } else if (down) add('offair', 'critical', down.title);
      else if (withOwn.length >= 2) {
        add('offair', withOwn.length >= 3 ? 'critical' : 'warn',
          `Its own station and ${plural(withOwn.length, 'station')} behind it went quiet together, ${HealthAnalysis.fmtWhen(own.lastHeard, now)}`);
      } else if (only.length >= 2 && onlySilent.length === only.length) {
        add('offair', 'warn', `All ${num(only.length)} stations only it can carry have gone silent`);
      }
      const off = issues.some(i => i.k === 'offair');
      if (spells.length) {
        add('drops', 'warn', `${spells.length === 1 ? 'Once' : `${num(spells.length)} times`} the stations behind it went silent together and came back`
          + (night ? `${spells.length === 1 ? ', overnight' : ` — ${num(night)} of them overnight`}` : ''));
      }
      if (bitsF || flF) {
        add('bits', bitsF && bitsF.severity === 'critical' || flF && flF.severity === 'critical' ? 'critical' : 'warn',
          bitsF ? `The common factor in ${num(Math.round(R.blame))} corrupted copies, ${pct(R.rate)} of what it could have carried`
            + (flF ? ` — and caught on its own carrier sending ${plural(Number(fl && fl.clear) || 0, 'clear one')}` : '')
            : flF.title);
      } else if (R && R.blame >= 3 && R.sent >= 20 && medRate > 0 && R.rate >= 2 * medRate) {
        add('blame', 'info', `More corrupted copies than most: ${pct(R.rate)} of what it could have carried, against ${pct(medRate)} across the network's repeaters`);
      }
      if (d && d.sFinding) add('signal', d.sFinding.severity === 'critical' ? 'critical' : 'warn', d.sFinding.title);
      else if (d && d.snr != null && d.snr < SNR_THIN) add('thin', 'info', `Little margin: it reaches the base stations ${d.snr.toFixed(1)} dB over the noise`);
      if (power) add('power', power.severity, power.title);
      if (d && d.finding) add('carrier', d.finding.severity === 'critical' ? 'critical' : 'warn', d.finding.title);
      // Checks lost behind it count against it where only it carries them;
      // stations another repeater carries too lose checks for its reasons as
      // well, so they make a note at most.
      if (!off && netRate != null) {
        if (mine.due >= 20 && mine.rate < netRate - 0.15 && mine.rate < 0.85) {
          add('checks', 'warn', `The stations only it carries got ${pct(mine.rate)} of their checks through, against ${pct(netRate)} across the network`);
        } else if (all.due >= 20 && all.rate < netRate - 0.15) {
          add('checks', 'info', `Stations behind it got ${pct(all.rate)} of their checks through, against ${pct(netRate)} across the network${only.length ? '' : ' — each can come another way too'}`);
        }
      }
      // Its own station silent while the stations only it carries are heard
      // after: the repeater is relaying, and the site's logger is the one.
      // Without such stations nothing says whether it still relays, and the
      // site having gone quiet is the warning.
      const relayedSince = !!ownSilent && own.lastHeard != null && lead.some(M => M.lastHeard != null && M.lastHeard > own.lastHeard + HOUR);
      if (ownSilent && !off) {
        if (only.length && relayedSince) add('own', 'info', 'Its own station has gone silent, but the stations only it carries are still heard after');
        else add('site', 'warn', `Its own station has gone silent — last heard ${HealthAnalysis.fmtWhen(own.lastHeard, now)}`);
      }
      pairs.forEach(p => add('stagger', 'info', p.s.title));
      issues.sort(bySev);

      const worst = issues[0] || null;
      let state, sev;
      if (worst && worst.sev !== 'info') { state = STATE_OF[worst.k] || 'watch'; sev = worst.sev; }
      else if (worst) { state = 'watch'; sev = 'info'; }
      else if (!members.length) { state = 'quiet'; sev = 'ok'; }
      else if (!only.length && !own) { state = 'shared'; sev = 'ok'; }
      else { state = 'ok'; sev = 'ok'; }

      const row = {
        id, st, name: st.name, number: st.station_number || '',
        members: members.length, only: only.length, silent: silent.length, onlySilent: onlySilent.length,
        silentNames: names(silent, 4), lastBehind,
        due: all.due, got: all.got, rate: all.rate, onlyRate: mine.due >= 20 ? mine.rate : null, netRate,
        own: own ? { heard: true, lastHeard: own.lastHeard, silent: !!ownSilent, battery: B ? { lastNight: B.lastNight, slope: B.slope, swing: B.swing, latest: B.latest ? B.latest.V : null } : null } : null,
        blame: R ? R.blame : 0, blameRate: R ? R.rate : null, sent: R ? R.sent : 0, medRate,
        spells: spells.length, night,
        radio: {
          snr: d ? d.snr : null, snrChange: d ? d.snrChange : null, fading: !!(d && d.sFinding),
          ppm: d ? d.ppm : null, carrierOff: !!(d && d.finding),
          flips: fl ? Number(fl.flips) || 0 : null, clear: fl ? Number(fl.clear) || 0 : null, upstream: fl ? Number(fl.clean_upstream) || 0 : null,
          caught: !!flF,
        },
        delayMs: st.repeater && st.repeater.delay_ms != null ? Number(st.repeater.delay_ms) : null,
        stagger: pairs.map(p => p.other),
        carrierGone,
        issues, state, sev,
      };
      row.points = pointsTo(row, { down, ownSilent, power, B, bitsF, radioIn: !!o.radio, relayedSince });
      return row;
    }

    const rows = [];
    const done = new Set();
    reps.forEach(R => { if (!R.rep || !R.rep.st || done.has(R.id)) return; done.add(R.id); rows.push(build(R.rep.st, R)); });
    // A repeater whose own station was heard, with nothing behind it heard.
    A.stations.forEach(X => { if (!done.has(X.st.id) && isRepeater(X.st)) { done.add(X.st.id); rows.push(build(X.st, null)); } });
    rows.sort((a, b) => (SEV_RANK[a.sev] - SEV_RANK[b.sev]) || (b.silent - a.silent) || (b.only - a.only) || (b.members - a.members)
      || (b.blame - a.blame) || a.name.localeCompare(b.name));
    const onFile = stations.filter(isRepeater).length;
    const counts = { critical: 0, warn: 0, info: 0, ok: 0 };
    rows.forEach(r => { counts[r.sev]++; });
    const byState = {};
    rows.forEach(r => { byState[r.state] = (byState[r.state] || 0) + 1; });
    return { rows, counts, byState, onFile, unseen: Math.max(0, onFile - rows.length), netRate, medRate, radio: !!o.radio, now };
  }

  // What the pieces of a row together suggest — at most three, the strongest
  // first, each a possibility.
  function pointsTo(r, x) {
    const has = k => r.issues.find(i => i.k === k) || null;
    const off = has('offair'), drops = has('drops'), bits = has('bits'), sig = has('signal'), car = has('carrier'), checks = has('checks');
    const B = x.B;
    const trend = B && B.slope != null ? (Math.abs(B.slope) < 0.01 ? ', steady' : `, ${B.slope < 0 ? 'falling' : 'rising'} ${Math.abs(B.slope).toFixed(2)} V a day`) : '';
    const batt = B && B.lastNight != null ? `${B.lastNight.toFixed(1)} V at night${trend}` : null;
    // A power finding worth acting on: a note (a full battery not swinging,
    // say) is not why a site went quiet.
    const power = x.power && x.power.severity !== 'info' ? x.power : null;
    const out = [];
    if (off && r.carrierGone != null) {
      out.push('The base stations stopped measuring its carrier while they went on measuring the rest: it has stopped transmitting, not just relaying.');
    }
    if (off) {
      if (r.own && !r.own.silent && r.carrierGone != null) {
        out.push('Its own station is still heard, so the site has power: the repeater\'s own radio, its antenna or feeder is what stopped.');
      } else if (r.own && !r.own.silent) {
        out.push('Its own station is still heard, so the site has power and is on the air: look at the way in — its receiver and receive antenna, or what it is set to pass.');
      } else if (r.own && power) {
        out.push(`Power first: its own battery was ${batt || 'low'} before it went quiet.`);
      } else if (r.own && batt && B.slope != null && B.slope > -0.01 && B.lastNight >= 12.2) {
        out.push(`Its own station went quiet with them, its battery ${batt} before then — which points away from a flat battery, towards the radio, a fuse or the antenna.`);
      } else if (r.own) {
        out.push('Its own station went quiet with them: the site — its power or its radio.');
      } else {
        out.push('Nothing at the site reports on its own, so its power and its radio cannot be told apart from here: start with both.');
      }
    }
    if (drops && r.night) {
      out.push(power || (B && B.slope != null && B.slope < -0.01)
        ? 'It drops out overnight with a battery that sinks at night: a solar site that cannot carry the night.'
        : 'It went at night and came back in daylight — the pattern of a solar site whose battery cannot carry the night.');
    } else if (drops) {
      out.push('Silences that come and go, not at night: the link, interference, or a loose connection more than power.');
    }
    if (bits && off && r.carrierGone != null) {
      out.push('The corrupted copies counted against it were sent before it went quiet: whether the rate on its channel fell with it says how much was its.');
    } else if (bits) {
      if (r.radio.caught && r.radio.upstream > 0) {
        out.push('Caught on its own carrier while the same readings reached us clean another way: the damage enters here — its receiver, noise at its site, or its radio.');
      } else if (r.radio.caught) {
        out.push('Caught on its own carrier sending the wrong bits: its receiver, its site or its radio.');
      } else if (x.radioIn && (r.radio.clear == null || r.radio.clear < 2)) {
        out.push('Only the pass ranges point at it: the base stations\' carrier check has not caught it sending one, so another repeater on the same stations may be the one.');
      } else {
        out.push('The blame is shared among the repeaters that could have carried them; the carrier check (Bit flips, above) says who sent them where a base station measures carriers.');
      }
      if (r.stagger.length) {
        out.push(`${r.radio.caught ? 'Or its' : 'Its'} copies are landing on ${r.stagger[0]}'s: both re-send the same frames, and two repeaters keying together spoil each other — a delay between them (Airtime, above) settles which.`);
      }
    }
    if (sig && bits) out.push('Weaker on the air and corrupting what it relays: its antenna, feeder or connectors, which it hears through as well as sends on, fit both.');
    else if (sig && !off) out.push('Weaker at the base stations that hear it: its antenna, feeder or connectors, or its transmitter\'s power.');
    if (car && bits) out.push('A carrier off the rest as well as corrupted relays points at the radio itself.');
    else if (car && !off) out.push('Its carrier is off the rest or moving: an ageing crystal, or a site running hot or cold — worth a visit before it goes quiet.');
    if (checks && checks.sev !== 'info' && !off) out.push('It stays on the air while the stations only it carries lose checks: weak paths into it — their antennas, or its receive side — or it missing frames.');
    if (power && !off && !drops) {
      out.push(x.relayedSince
        ? `Its own station went quiet with its battery ${batt || 'low'}, while the stations behind it are still heard${r.only ? '' : ' — perhaps another way'}: the site's power is going.`
        : `Its battery${batt ? `, ${batt},` : ''} wants a look before it browns out.`);
    }
    if (has('site') && !power) {
      out.push(r.only
        ? `Its own station is silent and none of the ${plural(r.only, 'station')} only it carries has been heard since: the site — its power or its radio — may be going.`
        : `Its own station is silent${r.silent ? `, as ${r.silent === 1 ? 'is' : 'are'} ${plural(r.silent, 'station')} behind it` : ''}, and every station behind it can come another way, so the readings cannot say whether it still relays: the site — its power, its logger or its radio — wants a look.`);
    }
    if (!out.length && has('own')) out.push('The repeater is relaying: the site\'s own logger, its radio or its sensors are the ones to look at.');
    if (!out.length && r.state === 'shared') out.push('Every station behind it can come through another repeater too; the readings cannot tell its part from theirs.');
    if (!out.length && r.state === 'ok' && r.only) out.push(`It is the only way in for ${plural(r.only, 'station')} heard, and they are getting through.`);
    return out.slice(0, 3);
  }

  // ── the result, once per Station Health result and radio answer ────────────

  function sources() {
    const st = typeof Health !== 'undefined' && Health.state ? Health.state() : null;
    const A = st && st.A;
    const drift = typeof HealthDrift !== 'undefined' && HealthDrift.state ? HealthDrift.state() : null;
    const flips = typeof HealthFlips !== 'undefined' && HealthFlips.state ? HealthFlips.state() : null;
    const air = typeof HealthAirtime !== 'undefined' && HealthAirtime.state ? HealthAirtime.state().R : null;
    return { A, drift, flips, air };
  }
  function result() {
    const src = sources();
    if (!src.A) { S.key = null; S.R = null; return null; }
    const dRows = src.drift && src.drift.rows, fRows = src.flips && src.flips.rows;
    const dErr = src.drift && src.drift.err, fErr = src.flips && src.flips.err;
    const key = [src.A, dRows, fRows, src.air, dErr, fErr];
    if (S.key && S.key.every((v, i) => v === key[i])) return S.R;
    S.key = key;
    S.err = '';
    try {
      S.R = analyse(src.A, {
        stations: (typeof state !== 'undefined' && state.data && state.data.stations) || [],
        drift: dRows ? src.drift.summary : [],
        flips: fRows || [],
        flipFindings: (src.flips && src.flips.findings) || [],
        suggestions: src.air ? src.air.suggestions : [],
        radio: !!(dRows || fRows),
      });
      // Asked and answered with nothing to give (a database without them, or
      // a failure): the column says so rather than waiting on it.
      S.R.radioDone = !!(dRows || fRows || dErr || fErr);
    } catch (err) {
      S.R = null;
      S.err = 'The repeaters could not be worked out: ' + ((err && err.message) || err) + '. The readings and the rest of the tab are fine — this is a bug, and the bug report button will carry it.';
      if (typeof recordError === 'function') recordError({ kind: 'repeaters', message: S.err, where: '', stack: (err && err.stack) || '' });
    }
    return S.R;
  }

  // The rows the owner filter, the find box and "only those needing a look"
  // leave.
  function findText(r) {
    const o = typeof Health !== 'undefined' && Health.owner ? Health.owner(r.st) : null;
    return [r.name, r.number, o && o.name, STATE_LABEL[r.state]].filter(Boolean).join(' ').toLowerCase();
  }
  function visible(R) {
    const q = S.q.trim().toLowerCase();
    const owns = typeof Health !== 'undefined' && Health.owns ? Health.owns : () => true;
    return R.rows.filter(r => owns(r.st) && (!S.look || r.sev !== 'ok') && (!q || findText(r).includes(q)));
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  const term = (k, text) => (typeof termHtml === 'function' ? termHtml(text, WORDS[k]) : esc(text));

  function render() {
    const R = result();
    const head = `
      <div class="panel-header"><h3 id="hl-h-reps">Repeaters</h3>
        <span class="small">what the window's readings and the base stations' radio checks say about each repeater</span></div>`;
    if (S.err) return head + `<p class="small txt-bad">${esc(S.err)}</p>`;
    if (!R) return head;
    if (!R.rows.length) {
      return head + `<p class="small hl-empty">No repeater on file passes a station heard in the window, and no repeater site's own station was heard.</p>`;
    }
    const rows = visible(R);
    return head + `
      ${leadHtml(R)}
      <p class="small hl-air-sub">A legacy ALERT frame does not say which repeater relayed it, so each repeater is read through the stations
        ${term('behind', 'behind it')} — the ones ${term('only', 'only it')} can carry say most — through its own site's station and battery, and
        through what the base stations measure of its transmitter: its ${term('snr', 'signal')}, its carrier, and the corrupted copies caught on it.
        Where the server's radio checks have not answered (or this database does not keep them), the readings speak alone.
        The <button type="button" class="link-btn" onclick="Health.openReception()">Reception Map</button> weighs the corrupted copies further,
        and the <button type="button" class="link-btn" onclick="switchTab('backbone')">🗼 Backbone</button> ranks the same repeaters over 7 to 90 days
        from the server's records.</p>
      <div class="hl-filters">
        <label class="hl-check"><input type="checkbox" ${S.look ? 'checked' : ''} onchange="HealthRepeaters.setLook(this.checked)">
          only those needing a look</label>
        <input type="search" class="hl-find" placeholder="Find a repeater — name, number or owner" aria-label="Find a repeater by name, number or owner"
               value="${escAttr(S.q)}" oninput="HealthRepeaters.find(this.value)">
        <span class="small" id="hl-reps-count">${esc(countText(rows, R))}</span>
      </div>
      <div id="hl-reps-list">${listHtml(rows, R)}</div>
      ${glossaryHtml()}
      <div class="button-group hl-air-tools">
        <button class="ghost" onclick="HealthRepeaters.exportCsv()" title="Every repeater in the card, with its state, the stations behind it, its own station, its radio and what it points to, as a spreadsheet">Export repeaters</button>
      </div>`;
  }

  function leadHtml(R) {
    const bad = R.rows.filter(r => r.sev === 'critical' || r.sev === 'warn');
    const say = k => (R.byState[k] ? `${num(R.byState[k])} ${STATE_LABEL[k].toLowerCase()}` : '');
    const parts = ['offair', 'drops', 'bits', 'signal', 'power', 'site', 'carrier', 'checks'].map(say).filter(Boolean);
    const unseen = R.unseen ? ` ${plural(R.unseen, 'other repeater')} on file had nothing heard behind ${R.unseen === 1 ? 'it' : 'them'} — outside what these receivers hear, or quiet.` : '';
    if (!bad.length) {
      return `<p>${plural(R.rows.length, 'repeater')} heard behind${R.byState.watch ? `; nothing to act on, ${num(R.byState.watch)} to watch` : ', and nothing counts against any of them'}.${unseen}</p>`;
    }
    return `<p><b>${num(bad.length)} of ${plural(R.rows.length, 'repeater')} to look at</b> — ${esc(parts.join(', '))}. First: `
      + bad.slice(0, 4).map(r => `${esc(r.name)}, ${esc(STATE_LABEL[r.state].toLowerCase())}`).join('; ')
      + `${bad.length > 4 ? `; and ${num(bad.length - 4)} more` : ''}.${unseen}</p>`;
  }

  function countText(rows, R) {
    const own = typeof Health !== 'undefined' && Health.state && Health.state().owners.length;
    return `${num(rows.length)} of ${plural(R.rows.length, 'repeater')}${own ? ', the owners picked' : ''}, worst first`;
  }

  function stateHtml(r) {
    const icon = r.sev === 'critical' ? '⛔' : r.sev === 'warn' ? '⚠' : r.sev === 'info' ? 'ℹ' : r.state === 'ok' ? '✓' : '○';
    return `<span class="hl-sev term-chip ${STATE_CLS[r.sev] || 'txt-muted'}" title="${escAttr(WORDS[r.state])}"><span aria-hidden="true">${icon}</span> <span class="hl-sev-word">${esc(STATE_LABEL[r.state])}</span></span>`;
  }

  function nameHtml(r) {
    const o = typeof Health !== 'undefined' && Health.owner ? Health.owner(r.st) : null;
    // Its own station heard: opened above, in the station panel. Otherwise on
    // the Stations tab, where its pass ranges and delay are.
    const btn = r.own
      ? `<button class="link-btn" onclick="Health.select('${escAttr(r.id)}')" title="${escAttr(`Open ${r.name}'s own station above`)}">${esc(r.name)}</button>`
      : `<button class="link-btn" onclick="goToStation('${escAttr(r.id)}')" title="The repeater on the Stations tab">${esc(r.name)}</button>`;
    return `${btn}${r.number ? ` <span class="small mono">${esc(r.number)}</span>` : ''}${o ? `<span class="hl-owner">${esc(o.name)}</span>` : ''}`;
  }

  function behindHtml(r, now) {
    if (!r.members) return '<span class="small txt-muted">none heard</span>';
    return `${num(r.members)} <span class="small">heard</span>`
      + (r.only ? `<br><span class="small">${num(r.only)} only through it</span>` : '')
      + (r.silent ? `<br><span class="small txt-warn" title="${escAttr(r.silentNames)}">${num(r.silent)} silent</span>` : '')
      + (r.lastBehind != null ? `<br><span class="small">last ${esc(ago(r.lastBehind, now))}</span>` : '');
  }

  // On a phone the state and the stations behind it fold into the
  // repeater's cell, so what it points to sits beside the name.
  function narrowText(r) {
    return [r.members ? `${num(r.members)} heard behind` : 'none heard behind', r.only ? `${num(r.only)} only through it` : '',
      r.silent ? `${num(r.silent)} silent` : '', r.rate != null ? `${pct(r.rate)} of checks through` : ''].filter(Boolean).join(' · ');
  }

  function checksHtml(r) {
    if (r.rate == null) return '<span class="small txt-muted">no schedule</span>';
    const low = r.issues.some(i => i.k === 'checks' && i.sev !== 'info');
    return `${pct(r.rate)}${r.onlyRate != null ? `<br><span class="small${low ? ' txt-warn' : ''}">only through it ${pct(r.onlyRate)}</span>` : ''}`
      + `<br><span class="small">network ${pct(r.netRate)}</span>`;
  }

  function ownHtml(r, now) {
    if (!r.own) return '<span class="small txt-muted">not heard</span>';
    const b = r.own.battery;
    const v = b ? (b.lastNight != null ? b.lastNight : b.latest) : null;
    const pow = r.issues.find(i => i.k === 'power');
    return `<span class="${r.own.silent ? 'txt-warn' : ''}">${r.own.silent ? 'silent, ' : ''}${esc(ago(r.own.lastHeard, now))}</span>`
      + (v != null ? `<br><span class="small${pow && pow.sev !== 'info' ? ' txt-warn' : ''}">${v.toFixed(1)} V${b.lastNight != null ? ' at night' : ''}`
        + `${b.slope != null && Math.abs(b.slope) >= 0.01 ? `, ${b.slope < 0 ? '−' : '+'}${Math.abs(b.slope).toFixed(2)} V a day` : ''}</span>` : '');
  }

  function radioHtml(r, R) {
    const x = r.radio, bits = [];
    if (r.sent >= 1) {
      bits.push(`<span class="${r.issues.some(i => i.k === 'bits' || i.k === 'blame') ? 'txt-warn' : ''}">${r.blame.toFixed(1)} corrupted</span>`
        + ` <span class="small">(${r.blameRate != null ? `${(100 * r.blameRate).toFixed(1)}%` : '—'})</span>`);
    }
    if (x.clear != null) bits.push(`<span class="small${x.caught ? ' txt-warn' : ''}">${num(x.clear)} caught on its carrier</span>`);
    if (x.snr != null) bits.push(`<span class="small${x.fading ? ' txt-warn' : x.snr < SNR_THIN ? ' txt-muted' : ''}">SNR ${x.snr.toFixed(1)} dB${x.snrChange != null ? ` (${sgn(x.snrChange, 1)})` : ''}</span>`);
    if (x.ppm != null) bits.push(`<span class="small${x.carrierOff ? ' txt-warn' : ''}">carrier ${sgn(x.ppm, 2)} ppm</span>`);
    return bits.length ? bits.join('<br>') : `<span class="small txt-muted">${R.radio ? 'not measured' : R.radioDone ? 'not kept here' : 'asking…'}</span>`;
  }

  // An issue in the row's own words: a server finding's "Name: …" said
  // without the name the row already gives.
  function said(r, text) {
    const t = String(text).startsWith(r.name + ': ') ? String(text).slice(r.name.length + 2) : String(text);
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function pointsHtml(r) {
    const shown = r.issues.filter(i => i.sev !== 'info' || r.sev === 'info').slice(0, 3);
    return `${shown.map(i => `<b class="hl-rep-issue">${esc(said(r, i.text))}</b>`).join('')}`
      + r.points.map(p => `<span class="small hl-faction"><span aria-hidden="true">→</span> ${esc(p)}</span>`).join('')
      + (!shown.length && !r.points.length ? `<span class="small txt-muted">${esc(WORDS[r.state] || '')}</span>` : '');
  }

  function listHtml(rows, R) {
    if (!rows.length) {
      const q = S.q.trim();
      return `<p class="small hl-empty">${q ? `No repeater matches “${esc(q)}”.` : S.look ? 'None of these repeaters needs a look.' : 'No repeater of the owners picked was heard behind.'}</p>`;
    }
    const shown = S.all ? rows : rows.slice(0, SHOW);
    const now = R.now;
    return `
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="hl-h-reps">
        <table class="hl-table hl-reptable">
          <caption class="sr-only">Repeaters, worst first: the state, the stations heard behind each, how many of their checks got through, its own station, its radio, and what the evidence points to</caption>
          <colgroup><col style="width:11rem"><col style="width:7.5rem"><col style="width:7rem"><col style="width:6.5rem"><col style="width:7.5rem"><col style="width:9rem"><col></colgroup>
          <thead><tr><th scope="col">Repeater</th><th scope="col" class="col-optional">State</th><th scope="col" class="col-optional">${term('behind', 'Behind it')}</th>
            <th scope="col" class="col-optional">${term('checksCol', 'Checks through')}</th><th scope="col" class="col-optional">${term('own', 'Its own station')}</th>
            <th scope="col" class="col-optional">${term('radio', 'Radio')}</th><th scope="col">${term('points', 'What it points to')}</th></tr></thead>
          <tbody>${shown.map(r => `
            <tr class="hl-frow hl-frow--${r.sev === 'ok' ? 'ok' : r.sev}">
              <th scope="row" class="hl-rep-name">${nameHtml(r)}<span class="hl-rep-narrow">${stateHtml(r)}<br>${esc(narrowText(r))}</span></th>
              <td class="col-optional">${stateHtml(r)}</td>
              <td class="col-optional">${behindHtml(r, now)}</td>
              <td class="col-optional">${checksHtml(r)}</td>
              <td class="col-optional">${ownHtml(r, now)}</td>
              <td class="col-optional">${radioHtml(r, R)}</td>
              <td class="hl-fwhat">${pointsHtml(r)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      ${rows.length > SHOW ? `<button class="ghost hl-more" onclick="HealthRepeaters.toggleAll()" aria-expanded="${S.all}">${S.all ? `Show the first ${SHOW}` : `Show all ${num(rows.length)}`}</button>` : ''}`;
  }

  function glossaryHtml() {
    return `<details class="hl-details hl-rep-words"><summary>What the words in this card mean</summary>
      <dl class="hl-words">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  function redraw() {
    const el = document.getElementById('hl-reps');
    if (el) el.innerHTML = render();
  }
  // The rows and the count painted again in place, so the find box keeps the
  // keyboard; a press of Show all gets it back.
  function paint() {
    const R = result();
    if (!R) return;
    const rows = visible(R);
    const list = document.getElementById('hl-reps-list');
    const more = !!(document.activeElement && list && list.contains(document.activeElement) && document.activeElement.classList.contains('hl-more'));
    if (list) list.innerHTML = listHtml(rows, R);
    const n = document.getElementById('hl-reps-count');
    if (n) n.textContent = countText(rows, R);
    const back = more && list.querySelector('.hl-more');
    if (back) back.focus();
  }
  function find(q) { S.q = String(q || ''); paint(); }
  function setLook(v) { S.look = !!v; paint(); }
  function toggleAll() { S.all = !S.all; paint(); }
  // The server's radio checks landed (health-drift.js, health-flips.js), or
  // the owner filter changed: the card again, with them.
  function changed() {
    if (typeof state !== 'undefined' && state.activeTab !== 'health') return;
    const el = document.getElementById('hl-reps');
    if (!el) return;
    const had = document.activeElement && el.contains(document.activeElement) && document.activeElement.type === 'search';
    el.innerHTML = render();
    if (had) {
      const box = el.querySelector('input[type="search"]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
  }

  function exportCsv() {
    const R = result();
    if (!R) return;
    const rows = visible(R);
    const head = ['repeater', 'station_id', 'number', 'owner', 'state', 'severity', 'stations_behind', 'only_through_it', 'silent_behind',
      'checks_through', 'network_checks_through', 'own_station_last_heard', 'own_station_silent', 'battery_night_low_v', 'battery_trend_v_per_day',
      'corrupted_share', 'corrupted_rate', 'caught_on_carrier', 'snr_db', 'snr_change_db', 'carrier_ppm', 'delay_ms', 'issues', 'points_to'];
    const lines = [head.join(',')];
    rows.forEach(r => {
      const o = typeof Health !== 'undefined' && Health.owner ? Health.owner(r.st) : null;
      const b = r.own && r.own.battery;
      lines.push([
        r.name, r.id, r.number, o ? o.name : '', STATE_LABEL[r.state], r.sev, r.members, r.only, r.silent,
        r.rate != null ? r.rate.toFixed(3) : '', r.netRate != null ? r.netRate.toFixed(3) : '',
        r.own && r.own.lastHeard != null ? new Date(r.own.lastHeard).toISOString() : '', r.own ? r.own.silent : '',
        b && b.lastNight != null ? b.lastNight.toFixed(2) : '', b && b.slope != null ? b.slope.toFixed(3) : '',
        r.blame.toFixed(1), r.blameRate != null ? r.blameRate.toFixed(4) : '', r.radio.clear != null ? r.radio.clear : '',
        r.radio.snr != null ? r.radio.snr.toFixed(1) : '', r.radio.snrChange != null ? r.radio.snrChange.toFixed(1) : '',
        r.radio.ppm != null ? r.radio.ppm.toFixed(2) : '', r.delayMs != null ? r.delayMs : '',
        r.issues.map(i => said(r, i.text)).join('; '), r.points.join(' '),
      ].map(csvEscape).join(','));
    });
    dlText(`floodnet-repeaters-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
    announce(`Downloaded ${rows.length} repeaters as CSV.`);
  }

  // What the tests read: the result, as plain data.
  function state_() { return { R: result(), q: S.q, look: S.look, all: S.all }; }

  return { render, redraw, find, setLook, toggleAll, changed, exportCsv, state: state_, words: () => Object.assign({}, WORDS), _analyse: analyse };
})();

if (typeof window !== 'undefined') window.HealthRepeaters = HealthRepeaters;
