// MegaNet — base-station-bands.js
//
//   BandSmarts   what sits on a base station's spectrum all the time, what it
//                probably is, whether it matters and what to do about it.
//                Pure — no DOM, no state — so the Base Stations tab's Steady
//                signals panel (base-stations.js) and test/bsbands.mjs run
//                the same reasoning.
//
//   BandSmarts.analyse(rows, ctx)   the sticks and their bands, judged
//   BandSmarts.WORDS                what the panel's words mean, one list
//   BandSmarts.TESTS                the tests that tell the causes apart
//
// ── What it is given ─────────────────────────────────────────────────────────
// `rows` are admin_base_station_bands()'s (0111): an hour of one stick on one
// tuning each — { t, key, center_hz, rate, n, floor_db, low, mid } — `low` the
// level every bin was at or above in nine of the hour's ten spectrum rows and
// `mid` their median, base64, a byte a bin in half-dB steps over the floor. A
// spectrum row is the strongest a bin was in its minute, so what stays in
// `low` hour after hour was there in nearly every minute: a carrier, not
// traffic. What shows in `mid` and not in `low` is busy, not constant.
//
// `ctx` is what the tab already knows: { listening: [{ f, stick, inBand,
// running }], heard: [{ f, n, ok }], acma: [{ f, client, site, km }] or null
// when the licences are not loaded, lon (for the local hour), names: { key:
// name } }.
//
// ── How a band is found ──────────────────────────────────────────────────────
// Per stick and tuning, each bin's level is the upper quartile of its hours'
// `low`, so a band there for a quarter of the hours — by day only, say — is
// still found, and its share of the hours says how much of the time.
// A stick's window is not flat — its filter rolls off at the edges, and a
// minute's strongest noise sits some dB over the quietest fifth the floor is
// taken from — so a band is judged against its surroundings: the lower
// quarter of the levels a quarter-window around it. Bins PEAK_DB or more over
// that, side by side, are one band.
//
// ── How it is told what it is ────────────────────────────────────────────────
// By what can be checked, in the order of how sure each check is:
//   * it carries traffic the station decodes there — it is a channel;
//   * it is at the exact middle of the stick's window — the stick's own spike;
//   * another stick hears that frequency in the middle of its window and has
//     nothing there — it is made inside this stick;
//   * the stick was retuned and the band moved with it — likewise; it stayed
//     on its frequency — it is on the air;
//   * it sits on a multiple of a clock a computer near the stick runs at;
//   * it is there by day and gone at night (solar gear), or the reverse;
//   * the ACMA licenses somebody on that frequency near here;
//   * it wanders in frequency, which a licensed transmitter does not.
// What none of that settles is said to be unidentified, with the test that
// would settle it. Nothing here claims more than the evidence it lists.

const BandSmarts = (() => {
  const MIN_ROWS = 10;       // spectrum rows before an hour's lowest tenth means anything
  const MIN_HOURS = 3;       // hours before a stick is judged
  const PEAK_DB = 5;         // over its surroundings: a band
  const BUSY_DB = 8;         // …in the median only: busy, not constant
  const PRESENT_DB = 4;      // over its surroundings in one hour: there that hour
  const USABLE = 0.8;        // a stick's middle, of its window (base-stations.js WF_USABLE)
  const ON_HZ = 6250;        // this close to a channel is on it
  const BESIDE_HZ = 25000;   // this close is the channel beside it
  const STRONG_DB = 30;      // strong enough to matter wherever it is
  const SURE_DB = 10;        // strong enough that another stick not seeing it means something
  const WIDE_HZ = 100000;    // wider than any one transmitter here
  const DRIFT_HZ = 1500;     // wanders this far: not crystal-locked
  const SHARE_Q = 0.75;      // a bin's level is its hours' upper quartile: there a quarter of the hours is found

  // Clocks a computer or its leads near a stick run at: a multiple of one, to
  // within what a cheap crystal is out by, is probably it.
  const CLOCKS = [
    [25, 'the 25 MHz clock of wired Ethernet'], [28.8, 'the stick\'s own 28.8 MHz crystal'],
    [19.2, 'the 19.2 MHz clock of an older Raspberry Pi'], [54, 'the 54 MHz clock of a Raspberry Pi 4'],
    [48, 'a 48 MHz USB clock'], [24, 'a 24 MHz USB clock'], [12, 'a 12 MHz USB clock'], [27, 'a 27 MHz video clock'],
    [16, 'a 16 MHz microcontroller clock'], [20, 'a 20 MHz clock'], [50, 'a 50 MHz clock'], [10, 'a 10 MHz reference'],
  ];

  const WORDS = [
    ['steady', 'Steady signal', 'Something on the spectrum in nearly every minute, hour after hour: a carrier or noise source, not a station sending a burst and stopping. Found from the level each frequency never dropped below in nine minutes of ten.'],
    ['busy', 'Busy, not constant', 'Strong in more than half the minutes of an hour but not all of them — traffic, or something that comes and goes.'],
    ['over', 'Strength', 'How far the band stands above the frequencies either side of it, in decibels. 10 dB is ten times the power, 20 dB a hundred times.'],
    ['width', 'Width', 'How much of the band it takes up. Under about 2 kHz is a bare carrier with nothing on it; 6 to 25 kHz is one radio channel; much wider is noise or a wideband service.'],
    ['there', 'There', 'The share of the hours looked at in which the band was present, and since when it has been there without a break.'],
    ['centre', 'Centre spike', 'A thin line at the exact middle of what a stick is tuned to. The stick makes it itself; it is not on the air.'],
    ['spur', 'Spur', 'A signal a receiver makes inside itself, or picks up from the computer and leads beside it, rather than through its antenna.'],
    ['window', 'Window', 'The slice of the band a stick hears at once. Its outer tenth either side is its edge, where a signal from just outside can fold back in.'],
    ['floor', 'Noise floor', 'The level of the quietest fifth of a stick\'s window: the hiss everything has to be heard over. If it rises, every station sounds weaker.'],
    ['desense', 'Swamped', 'A strong signal near a channel makes the stick turn itself down, or fills its range, so weak stations on the channel are lost even though the strong one is not on it.'],
    ['licence', 'Licence found', 'The ACMA\'s public register (the RRL) lists a transmitter on this frequency within 100 km. It is allowed to be there.'],
    ['acma', 'ACMA', 'The Australian Communications and Media Authority: it licenses transmitters and looks into interference to licensed services.'],
  ];

  const TESTS = [
    ['Take the antenna off for five minutes', 'Unscrew the antenna lead at the stick and watch the waterfall. A band that stays is made inside the stick, its USB lead or the computer. One that goes came in through the antenna.'],
    ['Look at the other stick', 'Where two sticks hear the same frequency, something on the air shows on both. This is checked for you whenever their windows overlap; widening a window for a day makes them overlap.'],
    ['Move the window', 'Change the stick\'s channels or window so its centre moves. A band that keeps its frequency is on the air; one that moves with the window is the stick\'s own.'],
    ['Turn the gain down 10 dB', 'A real signal drops by about 10 dB. One that drops by 20 or 30, or vanishes, was made in the stick by something much stronger nearby overloading it — the cure is a filter or less gain, not a complaint.'],
    ['Watch the clock', 'Only by day points at solar gear; only at night at lighting; on the hour or in step with a pump or fan at whatever switches then. The table says when each band is there.'],
    ['Switch things off', 'At site, switch off one thing at a time — the network switch, the solar charge controller, a plug pack, a light — and watch the waterfall on a phone. The band goes when its source does.'],
    ['Listen to it', 'Tune a handheld or scanner to the frequency, away from the hut. A steady tone or hiss that fades within metres is local gear; data bursts or speech heard down the road is a transmitter.'],
  ];

  function bytes(b64) {
    if (!b64) return new Uint8Array(0);
    if (typeof atob === 'function') { const s = atob(b64), v = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i); return v; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const sorted = a => Array.from(a).sort((x, y) => x - y);
  function quantile(a, q) { if (!a.length) return null; const s = sorted(a); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))]; }
  const median = a => quantile(a, 0.5);
  const mhzText = hz => { const t = (hz / 1e6).toFixed(4); return t.endsWith('0') ? t.slice(0, -1) : t; };
  const kHz = hz => (hz >= 10000 ? Math.round(hz / 1000) : Math.round(hz / 100) / 10) + ' kHz';

  // The lower quarter of the levels within `half` bins of each bin.
  function surroundings(v, half) {
    const n = v.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      out[i] = quantile(Array.prototype.slice.call(v, a, b), 0.25);
    }
    return out;
  }

  // The rows by stick and tuning, each with its usable hours, oldest first.
  function tunings(rows) {
    const by = new Map();
    for (const r of rows || []) {
      if (Number(r.n) < MIN_ROWS) continue;
      const low = r.low instanceof Uint8Array ? r.low : bytes(r.low), mid = r.mid instanceof Uint8Array ? r.mid : bytes(r.mid);
      if (low.length < 16 || mid.length !== low.length) continue;
      const k = r.key + '|' + r.center_hz + '|' + r.rate + '|' + low.length;
      const g = by.get(k) || { key: r.key, center_hz: Number(r.center_hz), rate: Number(r.rate), len: low.length, hours: [] };
      g.hours.push({ t: Number(r.t), n: Number(r.n), floor: r.floor_db == null ? null : Number(r.floor_db), low, mid });
      by.set(k, g);
    }
    const out = [...by.values()];
    for (const g of out) { g.hours.sort((a, b) => a.t - b.t); g.last = g.hours[g.hours.length - 1].t; g.binHz = g.rate / g.len; }
    return out;
  }

  // Runs of bins at or over `min`, a gap of one bin joined.
  function runs(prom, min) {
    const out = [];
    let cur = null;
    for (let i = 0; i < prom.length; i++) {
      if (prom[i] >= min) { if (cur && i - cur.hi <= 2) cur.hi = i; else { cur = { lo: i, hi: i }; out.push(cur); } }
    }
    return out;
  }

  const freqOf = (g, bin) => g.center_hz - g.rate / 2 + (bin + 0.5) * g.binHz;

  // One tuning's levels and bands.
  function profile(g, lon) {
    const n = g.len, H = g.hours.length, half = Math.max(8, Math.round(n / 8));
    const steady = new Float32Array(n), typ = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      steady[i] = quantile(g.hours.map(h => h.low[i]), SHARE_Q) / 2;
      typ[i] = quantile(g.hours.map(h => h.mid[i]), SHARE_Q) / 2;
    }
    const base = surroundings(steady, half), baseTyp = surroundings(typ, half);
    const prom = steady.map((v, i) => v - base[i]), promTyp = typ.map((v, i) => v - baseTyp[i]);
    const shift = lon == null || !isFinite(lon) ? null : Math.round(lon / 15);
    const bands = [];
    const add = (r, isSteady) => {
      const src = isSteady ? steady : typ, pr = isSteady ? prom : promTyp;
      let peak = r.lo;
      for (let i = r.lo; i <= r.hi; i++) if (pr[i] > pr[peak]) peak = i;
      const f = freqOf(g, peak), a = Math.max(0, r.lo - 2), b = Math.min(n - 1, r.hi + 2);
      // Hour by hour: was it there, how strong, and where its top sat.
      const here = [], tops = [], levels = [];
      for (const h of g.hours) {
        const line = isSteady ? h.low : h.mid;
        const around = quantile(Array.prototype.slice.call(line, Math.max(0, peak - half), Math.min(n, peak + half + 1)), 0.25) / 2;
        let top = a;
        for (let i = a; i <= b; i++) if (line[i] > line[top]) top = i;
        const lvl = line[top] / 2 - around, on = lvl >= PRESENT_DB;
        here.push(on);
        if (on) { tops.push(top); levels.push(lvl); }
      }
      const present = here.filter(Boolean).length;
      let since = H;
      while (since > 0 && here[since - 1]) since--;
      const byDay = { day: [0, 0], night: [0, 0] };
      if (shift != null) {
        g.hours.forEach((h, i) => {
          const local = (((Math.floor(h.t / 3600) + shift) % 24) + 24) % 24;
          const part = local >= 8 && local < 16 ? byDay.day : local >= 20 || local < 4 ? byDay.night : null;
          if (part) { part[0]++; if (here[i]) part[1]++; }
        });
      }
      const share = p => (p[0] >= 4 ? p[1] / p[0] : null);
      const dayShare = share(byDay.day), nightShare = share(byDay.night);
      bands.push({
        key: g.key, steady: isSteady, f, lo_hz: freqOf(g, r.lo) - g.binHz / 2, hi_hz: freqOf(g, r.hi) + g.binHz / 2,
        width_hz: (r.hi - r.lo + 1) * g.binHz, bin: peak, bin_hz: g.binHz,
        over_db: Math.round(pr[peak] * 10) / 10, level_db: Math.round(src[peak] * 10) / 10,
        hours: H, present, share: present / H,
        since_t: since < H ? g.hours[since].t : null, whole: since === 0,
        drift_hz: tops.length >= 4 ? (quantile(tops, 0.9) - quantile(tops, 0.1)) * g.binHz : 0,
        spread_db: levels.length >= 4 ? Math.round((quantile(levels, 0.9) - quantile(levels, 0.1)) * 10) / 10 : 0,
        day_share: dayShare, night_share: nightShare,
        when: dayShare != null && nightShare != null ? (dayShare >= 0.7 && nightShare <= 0.2 ? 'day' : nightShare >= 0.7 && dayShare <= 0.2 ? 'night' : 'always') : null,
        offset_hz: f - g.center_hz,
        centre: Math.abs(f - g.center_hz) <= 1.5 * g.binHz,
        edge: Math.abs(f - g.center_hz) > USABLE * g.rate / 2,
      });
    };
    const st = runs(prom, PEAK_DB);
    for (const r of st) add(r, true);
    for (const r of runs(promTyp, BUSY_DB)) if (!st.some(s => s.lo <= r.hi + 1 && r.lo <= s.hi + 1)) add(r, false);
    bands.sort((x, y) => x.f - y.f);

    // The floor through the day: the hiss everything is heard over.
    const floors = g.hours.filter(h => h.floor != null);
    let floor = null;
    if (floors.length >= 12) {
      const vals = floors.map(h => h.floor), lo = quantile(vals, 0.1), hi = quantile(vals, 0.9);
      const hiHours = floors.filter(h => h.floor >= hi - 0.5).map(h => (((Math.floor(h.t / 3600) + (shift || 0)) % 24) + 24) % 24);
      const dayHi = hiHours.filter(x => x >= 8 && x < 16).length, nightHi = hiHours.filter(x => x >= 20 || x < 4).length;
      floor = { median: Math.round(median(vals) * 10) / 10, swing: Math.round((hi - lo) * 10) / 10,
        high: shift == null || !hiHours.length ? null : dayHi >= 0.7 * hiHours.length ? 'day' : nightHi >= 0.7 * hiHours.length ? 'night' : 'mixed' };
    }
    return { steady, typ, base, bands, floor };
  }

  const covers = (g, f, slackHz) => Math.abs(f - g.center_hz) <= USABLE * g.rate / 2 - (slackHz || 0);
  const tol = (a, b) => Math.max(1500, 1.5 * a, 1.5 * (b || 0));

  function clockOf(f) {
    for (const [mhz, what] of CLOCKS) {
      const n = Math.round(f / (mhz * 1e6));
      if (n >= 2 && Math.abs(f - n * mhz * 1e6) <= 5000) return { mhz, n, what };
    }
    return null;
  }

  // What a band probably is: { kind, title, sure, why: [], todo: [] }, and
  // whether it matters: { k: 'on' | 'beside' | 'strong' | 'none', cls, text }.
  function judge(b, ctx) {
    const why = [], todo = [];
    const f = mhzText(b.f) + ' MHz';
    const lic = ctx.acma == null ? null : ctx.acma.filter(a => Math.abs(a.f * 1e6 - b.f) <= Math.max(ON_HZ, b.bin_hz, b.width_hz / 2));
    const heard = (ctx.heard || []).filter(h => Math.abs(h.f * 1e6 - b.f) <= Math.max(ON_HZ, b.bin_hz, b.width_hz / 2));
    const heardN = heard.reduce((n, h) => n + Number(h.n || 0), 0), heardOk = heard.reduce((n, h) => n + Number(h.ok || 0), 0);
    const chans = (ctx.listening || []).filter(l => l.inBand !== false);
    const nearest = chans.map(l => ({ l, d: Math.abs(l.f * 1e6 - b.f) })).sort((x, y) => x.d - y.d)[0] || null;
    const clock = clockOf(b.f);
    const narrow = b.width_hz <= Math.max(2500, 2.5 * b.bin_hz);
    let kind, title, sure;

    if (heardOk > 0) {
      kind = 'traffic'; sure = 'sure';
      title = b.steady ? 'A channel it decodes, with something on it in nearly every minute' : 'A busy channel it decodes';
      const on = heard.slice().sort((x, y) => Math.abs(x.f * 1e6 - b.f) - Math.abs(y.f * 1e6 - b.f))[0];
      why.push('It decoded ' + heardOk.toLocaleString('en-AU') + ' of ' + heardN.toLocaleString('en-AU') + ' bursts heard on ' + mhzText(on.f * 1e6) + ' MHz.');
      if (b.steady && heardN >= 50 && heardOk / heardN < 0.5) {
        why.push('Fewer than half the bursts decode. A carrier sitting under the traffic does that: each burst has to be stronger than it to be read.');
        todo.push('Open the waterfall on the last hour and look between bursts: a line that never breaks is a transmitter stuck on, and Signal Routes shows which repeater or station went quiet when it began.');
      } else if (b.steady) {
        why.push('Most of what it hears decodes, so this is traffic, not something in its way.');
      }
    } else if (b.centre) {
      kind = 'centre'; sure = 'sure'; title = 'The stick\'s own centre spike';
      why.push('It is at the exact middle of the stick\'s window (' + mhzText(b.f - b.offset_hz) + ' MHz), where every RTL-SDR draws a thin line of its own.');
      todo.push('Nothing, unless a channel sits on it: then give the stick another channel or a wider window so its middle moves.');
    } else if (b.other === 'absent' && b.over_db >= SURE_DB) {
      kind = 'spur'; sure = 'likely'; title = 'Made inside this stick or its lead';
      why.push(b.other_name + ' hears ' + f + ' in the middle of its own window and has nothing there.');
    } else if (b.retune === 'moved') {
      kind = 'spur'; sure = 'likely'; title = 'Made inside this stick or its lead';
      why.push('When the stick was retuned the band moved with it, keeping its place in the window instead of its frequency.');
    } else if (clock && narrow) {
      kind = 'clock'; sure = 'likely'; title = 'A harmonic of ' + clock.what;
      why.push(f + ' is ' + clock.n + ' × ' + clock.mhz + ' MHz to within a few kHz, and it is a bare carrier ' + kHz(b.width_hz) + ' wide.');
    } else if (b.when === 'day') {
      kind = 'solar'; sure = 'likely'; title = 'Solar gear: a charge controller or inverter';
      why.push('It is there in ' + Math.round(b.day_share * 100) + '% of daylight hours and ' + Math.round(b.night_share * 100) + '% of night hours.');
    } else if (b.when === 'night') {
      kind = 'lights'; sure = 'likely'; title = 'Something that runs at night: lighting or a timer';
      why.push('It is there in ' + Math.round(b.night_share * 100) + '% of night hours and ' + Math.round(b.day_share * 100) + '% of daylight hours.');
    } else if (lic && lic.length) {
      kind = 'licensed'; sure = b.other === 'seen' || b.retune === 'stayed' ? 'sure' : 'likely';
      const who = [...new Set(lic.slice().sort((x, y) => x.km - y.km).map(a => a.client))];
      title = 'A licensed transmitter: ' + who[0] + (who.length > 1 ? ' and ' + (who.length - 1) + ' more' : '');
      const near = lic.slice().sort((x, y) => x.km - y.km)[0];
      why.push('The ACMA licenses ' + near.client + ' on ' + mhzText(near.f * 1e6) + ' MHz at ' + near.site + ', ' + near.km + ' km away'
        + (lic.length > 1 ? ', and ' + (lic.length - 1) + ' more within 100 km.' : '.'));
    } else if (b.edge && b.other !== 'seen') {
      kind = 'edge'; sure = 'maybe'; title = 'At the window\'s edge: probably folded in from just outside';
      why.push('It is in the outer tenth of the stick\'s window, where a signal just past one edge shows up at the other.');
    } else if (b.width_hz >= WIDE_HZ) {
      kind = 'broad'; sure = 'maybe'; title = 'Broadband noise';
      why.push('It is ' + kHz(b.width_hz) + ' wide — wider than any one transmitter in this band.');
    } else if (b.drift_hz >= DRIFT_HZ && b.width_hz < 30000) {
      kind = 'drifting'; sure = 'likely'; title = 'Electrical noise from nearby gear';
      why.push('Its frequency wanders by ' + kHz(b.drift_hz) + ' from hour to hour. A licensed transmitter holds its frequency; a power supply, LED light or plug pack does not.');
    } else if (b.other === 'seen' || b.retune === 'stayed') {
      kind = lic ? 'unlicensed' : 'onair'; sure = 'maybe';
      title = lic ? 'On the air, and no licence found within 100 km' : 'On the air — the licences have not loaded to check it against';
    } else {
      kind = 'unknown'; sure = 'maybe'; title = 'Not identified yet';
    }

    // What else is known, whatever it was called.
    if (kind !== 'spur' && b.other === 'seen') why.push(b.other_name + ' hears it too, so it comes in through the antennas (or is around both sticks).');
    if (kind !== 'spur' && b.retune === 'stayed') why.push('It kept its frequency when the stick was retuned, so it is not the stick\'s own.');
    if (b.other === 'absent' && b.over_db < SURE_DB && kind !== 'traffic') why.push(b.other_name + ' does not show it, but it is too weak here for that to prove anything.');
    if (kind === 'unlicensed' || kind === 'unknown' || kind === 'edge' || kind === 'drifting' || kind === 'broad') {
      if (lic && !lic.length) why.push('No licence on this frequency within 100 km in the ACMA extract.');
      if (b.other === 'none' && b.retune == null) why.push('Only this stick hears this frequency, and it has not been retuned, so whether it is on the air cannot be told from here.');
    }
    if (kind !== 'traffic' && heardN > 0 && !heardOk) why.push('It heard ' + heardN.toLocaleString('en-AU') + ' bursts here and decoded none.');
    if (b.steady && b.spread_db <= 2 && b.share >= 0.9 && ['unknown', 'unlicensed', 'onair', 'licensed', 'edge'].includes(kind)) why.push('Its level barely changes (within ' + Math.max(1, b.spread_db) + ' dB): one fixed source, not many stations.');

    // What to do, by what it is.
    if (kind === 'spur' || kind === 'clock') {
      todo.push('It is not a transmitter, so there is nothing to report.');
      todo.push('To get rid of it: put the stick on a short USB extension lead away from the computer, clip a ferrite on that lead and on the power lead, and try another USB port.'
        + (kind === 'clock' && /Ethernet/.test(title) ? ' Unplug the network cable for a minute to confirm it.' : ''));
    } else if (kind === 'solar') {
      todo.push('At site in daylight, switch the solar charge controller or inverter off for a minute and watch the waterfall: the band goes if that is it.');
      todo.push('If so: ferrites on the panel and battery leads at the controller, the antenna and its feeder kept away from them, or a quieter controller.');
    } else if (kind === 'lights' || kind === 'drifting' || kind === 'broad') {
      todo.push('At site, switch things off one at a time — lights, plug packs, a network switch, a charger — and watch the waterfall on a phone. Replace or move whatever makes it go.');
    } else if (kind === 'licensed') {
      todo.push('It is allowed to be there. Nothing to report.');
    } else if (kind === 'edge') {
      todo.push('Widen the stick\'s window a step, or give the other stick a channel near it, for a day: seen in the middle of a window, its real frequency shows.');
    } else if (kind === 'unlicensed' || kind === 'onair') {
      todo.push('Search ' + mhzText(b.f) + ' in 📜 ACMA licences on the Stations map: the extract here reaches 100 km and a strong transmitter can be further.');
      todo.push('Listen on a handheld away from the hut. Heard down the road, it is a transmitter; if it is on or beside a frequency you are licensed for and costs you reception, that is what the ACMA takes reports of.');
    } else if (kind === 'unknown') {
      todo.push('Take the antenna off for five minutes and watch the waterfall: if the band stays, it is made inside the stick or the computer; if it goes, it came in through the antenna.');
    }

    // Does it matter: only by where it is and how strong.
    let impact;
    const reach = ON_HZ + b.width_hz / 2;
    if (kind === 'traffic') {
      impact = { k: 'none', cls: 'txt-ok', text: 'No — this is what the stick is there to hear.' };
      if (!todo.length) todo.push('Nothing.');
    } else if (nearest && nearest.d <= reach) {
      impact = { k: 'on', cls: 'txt-bad', text: 'Yes — it sits on ' + mhzText(nearest.l.f * 1e6) + ' MHz, which ' + nearest.l.stick + ' decodes. A burst weaker than it will not be read.' };
      if (kind === 'centre' || kind === 'spur' || kind === 'clock') todo.unshift('Move it off the channel first: give the stick another channel or window so the band lands between channels.');
    } else if (nearest && nearest.d <= BESIDE_HZ + b.width_hz / 2 && b.over_db >= 20) {
      impact = { k: 'beside', cls: 'txt-warn', text: 'Possibly — it is ' + kHz(nearest.d) + ' from ' + mhzText(nearest.l.f * 1e6) + ' MHz and ' + Math.round(b.over_db) + ' dB over its surroundings: strong enough to swamp weak bursts on the channel beside it.' };
      todo.push('If weak stations on ' + mhzText(nearest.l.f * 1e6) + ' MHz are being missed: a narrower window, a lower fixed gain, or a band-pass filter on the antenna lead.');
    } else if (b.over_db >= STRONG_DB) {
      impact = { k: 'strong', cls: 'txt-warn', text: 'Possibly — it is not near a channel, but at ' + Math.round(b.over_db) + ' dB over its surroundings it uses up the stick\'s range, and a stick on automatic gain turns itself down for it.' };
      todo.push('Keep it out of the window if the channels allow a narrower one; otherwise a fixed, lower gain, or a filter on the antenna lead' + (kind === 'licensed' ? ' (a notch for this frequency, or a band-pass for yours).' : '.'));
    } else {
      impact = { k: 'none', cls: 'qs-dim', text: 'No — it is not on or beside a channel it decodes, and not strong enough to swamp the stick.' };
      if (!todo.length || kind === 'licensed') todo.push('Leave it.');
    }
    // The frequency to show: a bin is only so fine, so where the band is
    // known to be something with a frequency of its own, that is the one.
    const reachHz = Math.max(ON_HZ, b.bin_hz, b.width_hz / 2);
    const pick = list => list.map(x => x.f * 1e6).filter(x => Math.abs(x - b.f) <= reachHz).sort((x, y) => Math.abs(x - b.f) - Math.abs(y - b.f))[0];
    const exact = kind === 'centre' ? b.f - b.offset_hz
      : kind === 'traffic' ? pick(heard)
      : impact.k === 'on' ? nearest.l.f * 1e6
      : kind === 'licensed' ? pick(lic) : null;
    return { kind, title, sure, why, todo, impact, show_hz: exact == null ? b.f : exact, approx: exact == null && b.bin_hz >= 2000 };
  }

  // Everything, judged: { sticks: [{ key, name, center_hz, rate, bin_hz, hours,
  // from, to, steady, typ, base, bands, floor, retuned }], waiting: [{ key,
  // name, hours }], counts }.
  function analyse(rows, ctx) {
    ctx = ctx || {};
    const all = tunings(rows), names = ctx.names || {};
    const current = new Map();
    for (const g of all) if (!current.has(g.key) || current.get(g.key).last < g.last) current.set(g.key, g);
    const done = new Map();
    for (const g of all) if (g.hours.length >= MIN_HOURS) done.set(g, profile(g, ctx.lon));

    const sticks = [], waiting = [];
    for (const g of current.values()) {
      const p = done.get(g);
      if (!p) { waiting.push({ key: g.key, name: names[g.key] || g.key, hours: g.hours.length }); continue; }
      const past = all.filter(o => o.key === g.key && o !== g && o.center_hz !== g.center_hz && done.has(o));
      const others = [...current.values()].filter(o => o.key !== g.key && done.has(o));
      for (const b of p.bands) {
        // The other sticks: one that hears this frequency in its middle.
        b.other = 'none'; b.other_name = null;
        for (const o of others) {
          if (!covers(o, b.f, o.binHz)) continue;
          const hit = done.get(o).bands.some(x => Math.abs(x.f - b.f) <= tol(b.bin_hz, o.binHz) + b.width_hz / 2);
          b.other_name = names[o.key] || o.key;
          if (hit) { b.other = 'seen'; break; }
          b.other = 'absent';
        }
        // Its own past tunings: did the band keep its frequency, or its place?
        b.retune = null;
        for (const o of past) {
          const ob = done.get(o).bands;
          if (covers(o, b.f, o.binHz) && ob.some(x => Math.abs(x.f - b.f) <= tol(b.bin_hz, o.binHz) + b.width_hz / 2)) { b.retune = 'stayed'; break; }
          if (!b.centre && ob.some(x => Math.abs(x.offset_hz - b.offset_hz) <= tol(b.bin_hz, o.binHz))) b.retune = 'moved';
        }
        b.v = judge(b, ctx);
      }
      sticks.push({ key: g.key, name: names[g.key] || g.key, center_hz: g.center_hz, rate: g.rate, len: g.len, bin_hz: g.binHz,
        hours: g.hours.length, from: g.hours[0].t, to: g.last + 3600,
        steady: p.steady, typ: p.typ, base: p.base, bands: p.bands, floor: p.floor, retuned: past.length > 0 });
    }
    sticks.sort((a, b) => a.center_hz - b.center_hz || String(a.key).localeCompare(String(b.key)));
    const bands = [].concat(...sticks.map(s => s.bands));
    const count = k => bands.filter(b => b.v.impact.k === k).length;
    return { sticks, waiting, counts: { bands: bands.length, steady: bands.filter(b => b.steady).length,
      on: count('on'), beside: count('beside'), strong: count('strong'),
      unknown: bands.filter(b => ['unknown', 'unlicensed', 'onair', 'edge'].includes(b.v.kind)).length } };
  }

  return { analyse, judge, tunings, profile, clockOf, bytes, WORDS, TESTS, mhzText, kHz,
    MIN_ROWS, MIN_HOURS, PEAK_DB, ON_HZ, BESIDE_HZ, STRONG_DB };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BandSmarts;
