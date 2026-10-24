// tools/bulletin/validate.mjs — what a network bulletin may hold.
//
// The Station Health tab's bulletin (health-bulletin.js) is a short animated
// report of the network's last day or week, drawn in the browser from a JSON
// file the scheduled bulletin task writes (tools/bulletin/README.md). The
// player draws whatever it is given and draws a bad scene as a note rather
// than failing — this is where a bad file is caught before it is published:
// tools/bulletin/publish.mjs runs it on a draft, and test/bulletin.mjs on
// every file in data/bulletins/ and on its fixtures.
//
// Pure: a bulletin in, a list of problems out (empty is good). No files read
// here — the station ids a bulletin may name are passed in.
//
//   validate(b, { stationIds })  → { errors: [...], warnings: [...] }
//   validateIndex(ix)            → { errors: [...], warnings: [...] }
//
// The shape is docs/station-health.md ("The network bulletin") and
// tools/bulletin/README.md ("The bulletin file"); keep the three in step.

export const FORMAT = 'floodnet-bulletin/1';
export const INDEX_FORMAT = 'floodnet-bulletin-index/1';
export const KINDS = ['daily', 'weekly'];
export const SKIES = ['clear', 'fair', 'patchy', 'unsettled', 'stormy'];
export const SEVS = ['critical', 'warn', 'info', 'ok'];
export const TONES = ['ok', 'warn', 'bad', 'neutral'];
export const MARKS = ['silent', 'battery', 'flip', 'carrier', 'receiver', 'repeater', 'sensor', 'signal', 'ok', 'note'];
export const LINKS = ['relay', 'blame', 'path', 'clean'];
export const STRIP = /^[HPMNU.]{1,96}$/;   // hit, partial, miss, network-wide, unknown, not due
// The Droggies crew who present (health-bulletin.js ROSTER; test/bulletin.mjs
// holds the two lists to each other).
export const PRESENTERS = ['seasoned-hydrographer', 'tech-wizard', 'new-recruit', 'turbo', 'nitwit', 'know-it-all', 'bean-counter'];

export const SCENES = {
  title:       { fields: [] },
  map:         { fields: ['marks'] },
  battery:     { fields: ['items'] },
  checks:      { fields: ['items'] },
  carrier:     { fields: ['items'] },
  triangulate: { fields: ['subject', 'suspects'] },
  receivers:   { fields: ['items'] },
  trend:       { fields: ['series'] },
  list:        { fields: ['items'] },
  signoff:     { fields: [] },
};

const LIMITS = {
  scenes: [2, 14], secs: [5, 25], total: [40, 240],
  title: 70, say: 420, headline: 170, label: 90, stat: 28, text: 160, note: 90, name: 60,
};

export function validate(b, { stationIds = null } = {}) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const str = (where, v, max, { req = true } = {}) => {
    if (v == null || v === '') { if (req) err(where, 'missing'); return false; }
    if (typeof v !== 'string') { err(where, 'not text'); return false; }
    if (v.length > max) err(where, `${v.length} characters, more than ${max}`);
    if (/<[a-z/!]/i.test(v)) err(where, 'holds markup — the player writes text, not HTML');
    return true;
  };
  const num = (where, v, lo, hi, { req = true } = {}) => {
    if (v == null) { if (req) err(where, 'missing'); return false; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { err(where, 'not a number'); return false; }
    if (v < lo || v > hi) err(where, `${v} outside ${lo}…${hi}`);
    return true;
  };
  const oneOf = (where, v, list, { req = true } = {}) => {
    if (v == null) { if (req) err(where, 'missing'); return; }
    if (!list.includes(v)) err(where, `"${v}" is not one of ${list.join(', ')}`);
  };
  const iso = (where, v) => {
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) err(where, 'not an ISO time');
  };
  const sid = (where, v) => {
    if (v == null) return;
    if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9_.-]{1,80}$/.test(v)) { err(where, `"${v}" is not a station id`); return; }
    if (stationIds && !stationIds.has(v)) err(where, `"${v}" is no station in the register`);
  };
  const ll = (where, o, { req = false } = {}) => {
    if (o.lat == null && o.lon == null) { if (req && !o.id) err(where, 'neither a station id nor lat/lon'); return; }
    num(where + '.lat', o.lat, -45, -5);
    num(where + '.lon', o.lon, 110, 160);
  };
  const list = (where, v, lo, hi) => {
    if (!Array.isArray(v)) { err(where, 'not a list'); return []; }
    if (v.length < lo || v.length > hi) err(where, `${v.length} items, not ${lo}…${hi}`);
    return v.slice(0, Math.max(hi, 0));
  };

  if (!isObj(b)) return { errors: ['the bulletin is not a JSON object'], warnings };
  if (b.format !== FORMAT) err('format', `"${b.format}", not "${FORMAT}"`);
  oneOf('kind', b.kind, KINDS);
  str('id', b.id, 40);
  if (typeof b.id === 'string' && !/^(daily|weekly)-\d{4}-\d{2}-\d{2}$/.test(b.id)) err('id', 'not <kind>-YYYY-MM-DD');
  if (typeof b.id === 'string' && b.kind && !b.id.startsWith(b.kind + '-')) err('id', 'does not start with its kind');
  iso('issued_at', b.issued_at);
  if (!isObj(b.period)) err('period', 'missing');
  else {
    iso('period.from', b.period.from); iso('period.to', b.period.to);
    str('period.label', b.period.label, LIMITS.label);
    const span = Date.parse(b.period.to) - Date.parse(b.period.from);
    const want = b.kind === 'weekly' ? [6, 8] : [0.9, 1.6];
    if (Number.isFinite(span) && (span < want[0] * 86400000 || span > want[1] * 86400000))
      err('period', `${(span / 86400000).toFixed(1)} days, not a ${b.kind}'s ${want[0]}…${want[1]}`);
  }
  oneOf('presenter', b.presenter, PRESENTERS);
  oneOf('cohost', b.cohost, PRESENTERS, { req: false });
  if (!isObj(b.outlook)) err('outlook', 'missing');
  else { oneOf('outlook.sky', b.outlook.sky, SKIES); str('outlook.label', b.outlook.label, 40); }
  str('headline', b.headline, LIMITS.headline);
  list('stats', b.stats == null ? [] : b.stats, 0, 4).forEach((s, i) => {
    const w = `stats[${i}]`;
    if (!isObj(s)) { err(w, 'not an object'); return; }
    str(w + '.label', s.label, LIMITS.stat);
    if (typeof s.value === 'number') num(w + '.value', s.value, -1e7, 1e7);
    else str(w + '.value', s.value, 10);
    str(w + '.unit', s.unit, 6, { req: false });
    num(w + '.was', s.was, -1e7, 1e7, { req: false });
    oneOf(w + '.tone', s.tone, TONES, { req: false });
  });
  str('author', b.author, 80);
  if (b.caveats != null) list('caveats', b.caveats, 0, 5).forEach((c, i) => str(`caveats[${i}]`, c, 220));
  if (b.sources != null && !isObj(b.sources)) err('sources', 'not an object');

  const scenes = list('scenes', b.scenes, LIMITS.scenes[0], LIMITS.scenes[1]);
  let total = 0;
  scenes.forEach((s, i) => {
    const w = `scenes[${i}]`;
    if (!isObj(s)) { err(w, 'not an object'); return; }
    const spec = SCENES[s.type];
    if (!spec) { err(w + '.type', `"${s.type}" is not one of ${Object.keys(SCENES).join(', ')}`); return; }
    const W = `${w} (${s.type})`;
    str(W + '.title', s.title, LIMITS.title);
    str(W + '.say', s.say, LIMITS.say);
    str(W + '.sub', s.sub, LIMITS.note, { req: false });
    if (num(W + '.secs', s.secs, LIMITS.secs[0], LIMITS.secs[1])) total += s.secs;
    // Narration at a presenter's pace: about 2.6 words a second.
    if (typeof s.say === 'string' && typeof s.secs === 'number') {
      const words = s.say.trim().split(/\s+/).length;
      if (words / s.secs > 3.4) warn(W + '.say', `${words} words in ${s.secs} s is faster than anyone reads — lengthen secs or cut words`);
    }
    oneOf(W + '.presenter', s.presenter, PRESENTERS, { req: false });
    oneOf(W + '.sev', s.sev, SEVS, { req: false });
    if (s.stations != null) list(W + '.stations', s.stations, 0, 8).forEach((id, k) => sid(`${W}.stations[${k}]`, id));
    for (const f of spec.fields) if (s[f] == null) err(W + '.' + f, 'missing');
    scene(W, s);
  });
  if (scenes.length) {
    if (total < LIMITS.total[0] || total > LIMITS.total[1]) err('scenes', `${total} s in all, not ${LIMITS.total[0]}…${LIMITS.total[1]}`);
    if (scenes[0] && scenes[0].type !== 'title') err('scenes[0]', 'the first scene is the title');
    const last = scenes[scenes.length - 1];
    if (last && last.type !== 'signoff') err(`scenes[${scenes.length - 1}]`, 'the last scene is the sign-off');
  }

  function item(w, it) { if (!isObj(it)) { err(w, 'not an object'); return false; } return true; }
  function scene(W, s) {
    switch (s.type) {
      case 'title':
      case 'signoff':
        str(W + '.line', s.line, LIMITS.text, { req: false });
        break;
      case 'map': {
        if (s.focus != null) {
          if (!isObj(s.focus)) err(W + '.focus', 'not an object');
          else { ll(W + '.focus', s.focus, { req: true }); num(W + '.focus.km', s.focus.km, 5, 1500); }
        }
        list(W + '.marks', s.marks, 1, 40).forEach((m, k) => {
          const w = `${W}.marks[${k}]`;
          if (!item(w, m)) return;
          sid(w + '.id', m.id); ll(w, m, { req: true });
          oneOf(w + '.kind', m.kind, MARKS); oneOf(w + '.sev', m.sev, SEVS);
          str(w + '.label', m.label, LIMITS.name, { req: false });
        });
        if (s.areas != null) list(W + '.areas', s.areas, 0, 6).forEach((a, k) => {
          const w = `${W}.areas[${k}]`;
          if (!item(w, a)) return;
          ll(w, a, { req: true }); num(w + '.km', a.km, 2, 400);
          oneOf(w + '.sev', a.sev, SEVS); str(w + '.label', a.label, LIMITS.name, { req: false });
        });
        if (s.links != null) list(W + '.links', s.links, 0, 30).forEach((l, k) => {
          const w = `${W}.links[${k}]`;
          if (!item(w, l)) return;
          for (const end of ['from', 'to']) {
            const e = l[end];
            if (typeof e === 'string') sid(`${w}.${end}`, e);
            else if (Array.isArray(e) && e.length === 2) { num(`${w}.${end}[0]`, e[0], -45, -5); num(`${w}.${end}[1]`, e[1], 110, 160); }
            else err(`${w}.${end}`, 'neither a station id nor [lat, lon]');
          }
          oneOf(w + '.style', l.style, LINKS);
        });
        break;
      }
      case 'battery':
        list(W + '.items', s.items, 1, 5).forEach((it, k) => {
          const w = `${W}.items[${k}]`;
          if (!item(w, it)) return;
          sid(w + '.id', it.id); str(w + '.name', it.name, LIMITS.name);
          num(w + '.v', it.v, 0, 20);
          num(w + '.trend', it.trend, -5, 5, { req: false });
          num(w + '.days_to', it.days_to, 0, 3650, { req: false });
          if (it.nights != null) list(w + '.nights', it.nights, 0, 31).forEach((v, j) => num(`${w}.nights[${j}]`, v, 0, 20));
          str(w + '.note', it.note, LIMITS.note, { req: false });
        });
        break;
      case 'checks':
        list(W + '.items', s.items, 1, 6).forEach((it, k) => {
          const w = `${W}.items[${k}]`;
          if (!item(w, it)) return;
          sid(w + '.id', it.id); str(w + '.name', it.name, LIMITS.name);
          if (typeof it.strip !== 'string' || !STRIP.test(it.strip)) err(w + '.strip', 'not a strip of H P M N U . (1…96 slots)');
          num(w + '.rate', it.rate, 0, 1, { req: false });
          str(w + '.note', it.note, LIMITS.note, { req: false });
        });
        break;
      case 'carrier':
        if (s.fleet != null) list(W + '.fleet', s.fleet, 0, 2000).forEach((v, j) => num(`${W}.fleet[${j}]`, v, -100, 100));
        num(W + '.band', s.band, 0.1, 20, { req: false });
        list(W + '.items', s.items, 1, 3).forEach((it, k) => {
          const w = `${W}.items[${k}]`;
          if (!item(w, it)) return;
          sid(w + '.id', it.id); str(w + '.name', it.name, LIMITS.name);
          oneOf(w + '.kind', it.kind, ['station', 'repeater', 'alert2', 'receiver']);
          num(w + '.now', it.now, -100, 100);
          num(w + '.was', it.was, -100, 100, { req: false });
          if (it.series != null) list(w + '.series', it.series, 0, 60).forEach((v, j) => { if (v != null) num(`${w}.series[${j}]`, v, -100, 100); });
          str(w + '.note', it.note, LIMITS.note, { req: false });
        });
        break;
      case 'triangulate': {
        if (item(W + '.subject', s.subject)) {
          sid(W + '.subject.id', s.subject.id); str(W + '.subject.name', s.subject.name, LIMITS.name);
          ll(W + '.subject', s.subject);
        }
        if (s.receiver != null && item(W + '.receiver', s.receiver)) { str(W + '.receiver.name', s.receiver.name, LIMITS.name); ll(W + '.receiver', s.receiver); }
        const sus = list(W + '.suspects', s.suspects, 1, 4);
        let matched = 0;
        sus.forEach((it, k) => {
          const w = `${W}.suspects[${k}]`;
          if (!item(w, it)) return;
          sid(w + '.id', it.id); str(w + '.name', it.name, LIMITS.name); ll(w, it);
          num(w + '.hz', it.hz, -20000, 20000, { req: false });
          num(w + '.n', it.n, 0, 1e6, { req: false });
          if (it.match === true) matched++;
          else if (it.match != null && it.match !== false) err(w + '.match', 'true or false');
        });
        if (matched > 1) err(W + '.suspects', 'more than one marked the match');
        if (s.evidence != null && item(W + '.evidence', s.evidence)) {
          num(W + '.evidence.hz', s.evidence.hz, -20000, 20000, { req: false });
          num(W + '.evidence.n', s.evidence.n, 0, 1e6, { req: false });
          str(W + '.evidence.what', s.evidence.what, LIMITS.note, { req: false });
        }
        str(W + '.verdict', s.verdict, LIMITS.text, { req: false });
        break;
      }
      case 'receivers':
        list(W + '.items', s.items, 1, 5).forEach((it, k) => {
          const w = `${W}.items[${k}]`;
          if (!item(w, it)) return;
          str(w + '.name', it.name, LIMITS.name);
          list(w + '.up', it.up, 1, 168).forEach((v, j) => { if (v != null) num(`${w}.up[${j}]`, v, 0, 1); });
          str(w + '.summary', it.summary, 24, { req: false });
          str(w + '.note', it.note, LIMITS.note, { req: false });
        });
        break;
      case 'trend':
        list(W + '.series', s.series, 1, 3).forEach((se, k) => {
          const w = `${W}.series[${k}]`;
          if (!item(w, se)) return;
          str(w + '.label', se.label, LIMITS.name); str(w + '.unit', se.unit, 8, { req: false });
          oneOf(w + '.tone', se.tone, TONES, { req: false });
          num(w + '.baseline', se.baseline, -1e7, 1e7, { req: false });
          list(w + '.points', se.points, 2, 60).forEach((p, j) => {
            if (!Array.isArray(p) || p.length !== 2) { err(`${w}.points[${j}]`, 'not [label, value]'); return; }
            str(`${w}.points[${j}][0]`, p[0], 12);
            if (p[1] != null) num(`${w}.points[${j}][1]`, p[1], -1e7, 1e7);
          });
        });
        break;
      case 'list':
        list(W + '.items', s.items, 1, 6).forEach((it, k) => {
          const w = `${W}.items[${k}]`;
          if (!item(w, it)) return;
          oneOf(w + '.sev', it.sev, SEVS); str(w + '.text', it.text, LIMITS.text); sid(w + '.id', it.id);
        });
        break;
    }
  }
  return { errors, warnings };
}

export function validateIndex(ix) {
  const errors = [], warnings = [];
  if (!ix || typeof ix !== 'object') return { errors: ['the index is not a JSON object'], warnings };
  if (ix.format !== INDEX_FORMAT) errors.push(`format: "${ix.format}", not "${INDEX_FORMAT}"`);
  for (const kind of KINDS) {
    const l = ix[kind];
    if (!Array.isArray(l)) { errors.push(`${kind}: not a list`); continue; }
    let last = Infinity;
    l.forEach((e, i) => {
      const w = `${kind}[${i}]`;
      if (!e || typeof e !== 'object') { errors.push(`${w}: not an object`); return; }
      if (typeof e.file !== 'string' || !new RegExp(`^data/bulletins/${kind}/\\d{4}-\\d{2}-\\d{2}\\.json$`).test(e.file)) errors.push(`${w}.file: "${e.file}"`);
      if (typeof e.id !== 'string' || e.id !== `${kind}-${String(e.file || '').slice(-15, -5)}`) errors.push(`${w}.id: "${e.id}" does not match its file`);
      const t = Date.parse(e.issued_at);
      if (!Number.isFinite(t)) errors.push(`${w}.issued_at: not an ISO time`);
      else if (t > last) errors.push(`${w}: newer than the one before it — newest first`);
      else last = t;
      if (typeof e.headline !== 'string') errors.push(`${w}.headline: missing`);
      if (!SKIES.includes(e.sky)) errors.push(`${w}.sky: "${e.sky}"`);
    });
  }
  return { errors, warnings };
}
