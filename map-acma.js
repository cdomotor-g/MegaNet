// MegaNet — map-acma.js
//
//   MapAcma   📜 ACMA licences: the radio licences this network's own
//             transmitters run under, put on the Stations map — each licence
//             at its site with the area it covers shaded — with a search by
//             station or licence, a view that colours every transmitting
//             station by its licensing state, and a plain-words guide to the
//             rules. The station card's "ACMA licences near here" section is
//             this module's too (cardHtml / cardAsk).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, termHtml, cssVar, slug,
// dlText, csvEscape, acmaHaversineKm, bearingDeg, fmtKm and stationLatLonText;
// across to frequencies.js for Frequencies.pairs and Frequencies.carriersOf
// (the channels a station has, and the repeaters that carry it);
// path-profile.js for rmSystemOf; map-controls.js for MapChrome.panel;
// glyphs.js for its rail icon; and app.js for acmaFetchJson,
// selectedStationId, stationAlertIds, stationOwner, rerenderMapLegend,
// mapNote, setDockTab and showStationCard. All of it from inside its own
// functions, so this file's position among the modules is free.
//
// ── Not the interference layer ───────────────────────────────────────────────
// 🗺️ Layers › ACMA licences (app.js, acma*) and 📡 RF Changes answer "who
// else transmits near our receivers" from a register extract cut to 60 km
// round the repeaters, transmitters only. This asks the opposite — "what are
// OUR transmitters licensed under" — from its own small file,
// data/acma-station-licences.json (tools/acma_station_licences.py): the fixed
// licences of the Bureau of Meteorology, of anybody else on this network's
// channels, and councils' point-to-multipoint licences in 148–174 MHz, with
// both ends of every point-to-point link and each licence's special
// conditions. Refreshed weekly with the rest of the register data.
//
// ── What a licence covers, and what is drawn ─────────────────────────────────
// Point to point: the two sites the licence names. A line between them.
//
// Point to multipoint: the licence names its base station only. The remote
// stations that talk to that base are authorised by it but are written on
// neither the licence nor the register, and the licence states no distance
// (Radiocommunications Licence Conditions (Fixed Licence) Determination 2025,
// ss 5, 13, 15 and 23). The circle is therefore not a legal boundary. It is
// the service-area radius ACMA plans a point-to-multipoint service on — 30 km
// for a high-power system, 2 km for a low-power one (RALI FX16) — and it is a
// setting. Where a licence's own special conditions state a service area in
// kilometres, that figure is drawn instead and the panel says so.
//
// ── A station's licensing state ──────────────────────────────────────────────
// For a station that transmits (an ALERT address, or a repeater):
//   site   a current licence has a transmitter within SITE_KM of it;
//   area   it is inside the circle of a current point-to-multipoint licence;
//   none   neither was found — never "unlicensed": the extract can lag, the
//          holder may not be in the list, a class licence may apply.
// A licence on a channel the station is known not to use counts for neither.
// Everything else — no address, a base that only listens — is "not a
// transmitter": receiving needs no licence.

const MapAcma = (() => {
  const FILE = 'acma-station-licences.json';
  const KEY = 'mn-acma-lic-v1';
  const AREA_PANE = 'mnAcmaLicArea', AREA_Z = 395;
  const SITE_PANE = 'mnAcmaLicSite', SITE_Z = 590;
  const COVER_PANE = 'mnAcmaLicCover', COVER_Z = 596;
  const SITE_KM = 0.5;          // tools/acma_fetch.py --suggest-radius-m: the register's site and the pin are one place
  const PLAN_KM = 30;           // RALI FX16, high-power point-to-multipoint service area
  const SOON_DAYS = 90;
  const SAME_MHZ = 0.002;
  const CARD_ROWS = 4, CARD_MORE = 10;
  const HIT_CAP = 8;
  const NONE_CAP = 150;

  const CLASSES = [
    ['bureau', 'Bureau of Meteorology', '--lic-bureau', '#1565c0'],
    ['council', 'Councils', '--lic-council', '#e65100'],
    ['other', 'Water and other authorities', '--lic-other', '#6a1b9a'],
  ];
  const STATES = [
    ['site', 'Licence at the site', '--lic-site', '#2e7d32'],
    ['area', 'Inside a licence’s area', '--lic-area', '#0277bd'],
    ['none', 'None found', '--lic-none', '#c62828'],
    ['na', 'Not a transmitter', '--muted', '#888888'],
  ];
  const stateLabel = k => (STATES.find(s => s[0] === k) || STATES[3])[1];
  const stateColour = k => { const s = STATES.find(x => x[0] === k) || STATES[3]; return cssVar(s[2], s[3]); };
  const classColour = k => { const c = CLASSES.find(x => x[0] === k) || CLASSES[2]; return cssVar(c[2], c[3]); };

  let map = null, body = null;
  let areaLayer = null, siteLayer = null, coverLayer = null, coverRenderer = null;
  let D = null;                 // the file, indexed
  let loading = null, loadErr = '';
  let F = loadPrefs();
  let hitQ = '';
  let picked = null;            // { type: 'station' | 'licence', id }
  let cover = null;             // the coverage answer, cached: { key, rows, counts, holders }
  let noneSort = 'gap';
  let noneOwner = '';     // the none-found list narrowed to one owner ('' = all)
  const NEAR_MISS_KM = 10; // a gap this small is likely a station just past the assumed reach, not a missing licence

  function loadPrefs() {
    const base = { show: false, cover: false, cls: { bureau: true, council: true, other: true }, off: [],
      types: { pmp: true, ptp: true }, status: 'all', band: 'all', radius: PLAN_KM };
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!v || typeof v !== 'object') return base;
      return {
        show: !!v.show, cover: !!v.cover,
        cls: { ...base.cls, ...(v.cls && typeof v.cls === 'object' ? v.cls : {}) },
        off: Array.isArray(v.off) ? v.off.map(String).slice(0, 200) : [],
        types: { ...base.types, ...(v.types && typeof v.types === 'object' ? v.types : {}) },
        status: ['all', 'current', 'soon', 'lapsed'].includes(v.status) ? v.status : 'all',
        band: ['all', 'vhf', 'uhf'].includes(v.band) ? v.band : 'all',
        radius: Number(v.radius) >= 1 && Number(v.radius) <= 150 ? Number(v.radius) : PLAN_KM,
      };
    } catch (_) { return base; }
  }
  function savePrefs() { try { localStorage.setItem(KEY, JSON.stringify(F)); } catch (_) { /* private mode */ } }

  // ── The words ───────────────────────────────────────────────────────────────
  // One list, read by the headings, the chips and the fold that says them
  // without a hover (docs/design-system.md, "Words that mean something here").

  function words() {
    const R = F.radius;
    return {
      register: 'ACMA’s Register of Radiocommunications Licences: the public list of every apparatus licence — who holds '
        + 'it, where its transmitters and receivers are, on what frequency and at what power. Flood-Net reads a copy made '
        + 'once a week, so a licence granted or renewed in the last few days may not be here yet.',
      holder: 'The organisation the licence is issued to (the licensee). Only the holders ticked in this panel are '
        + 'searched: the Bureau of Meteorology, anybody else with a licence on a channel this network uses, and councils '
        + 'with their own telemetry licences in the same band.',
      pmp: 'Point to multipoint: one base station at a named site, and the remote stations that talk to it. The licence '
        + 'and the register name the base only — the remote stations are covered by it without being listed.',
      ptp: 'Point to point: a radio link between two named sites. Both ends are on the licence; it covers nothing else.',
      area: `The circle round a point-to-multipoint base: ${R} km here. The licence does not say how far away its remote `
        + 'stations may be. When ACMA hands out a channel it assumes they are all within 30 km of the base (2 km for a '
        + 'low-power system) and keeps other users of the channel clear of that circle only (RALI FX16). So the circle is '
        + 'the reach ACMA assumes — a sensible first look, not a legal boundary. A station outside it is not unlicensed '
        + 'for that reason alone; it is just further out than ACMA allowed for. Where a licence’s own special conditions '
        + 'give a distance, that is drawn instead.',
      site: `A current licence has a transmitter within ${Math.round(SITE_KM * 1000)} m of the station, on a channel the `
        + 'station uses (or its channel is not on record).',
      inarea: 'No licence names the station’s own site, but it stands inside the circle of a current point-to-multipoint '
        + 'licence on its channel — the kind of licence that covers remote stations talking to its base.',
      none: 'Nothing was found for the station among the ticked holders’ licences. That is not the same as unlicensed: '
        + 'the weekly copy can lag, the licence may be held by somebody not in the list, or a transmitter of 100 mW EIRP '
        + 'or less may run under the class licence for low-power devices.',
      na: 'The station has no ALERT address and is not a repeater, so it is not recorded as transmitting. Receiving '
        + 'needs no licence.',
      nearmiss: `A station with none found whose nearest point-to-multipoint base on its channel is ${NEAR_MISS_KM} km or less `
        + 'beyond the circle. Most likely it talks to that base and is simply further out than ACMA assumes; widen '
        + 'Assumed reach to see them fall inside.',
      farout: `A station with none found that is more than ${NEAR_MISS_KM} km beyond the nearest circle on its channel. `
        + 'These are the likelier real gaps: check which base it reports through and whether that base is licensed.',
      nochan: 'A station with none found and no point-to-multipoint base on its channel among the ticked holders. Either '
        + 'its channel on record is wrong, its licence is held by somebody not ticked, or there is none.',
      gap: 'How far the station is outside the nearest point-to-multipoint licence’s circle: its distance from that base, '
        + 'less the radius.',
      carries: 'The base of the covering licence stands where a repeater that carries this station stands — by the '
        + 'repeater’s pass ranges — so the station really does talk to that licensed base.',
      soon: `The licence expires within ${SOON_DAYS} days. Licences here run a year at a time; an expired licence `
        + 'authorises nothing until it is renewed.',
      lapsed: 'The register shows the licence as expired, surrendered or otherwise not in force.',
      eirp: 'Effective isotropic radiated power: the transmitter’s power, less the cable’s loss, multiplied by the '
        + 'antenna’s gain — what the licence allows the antenna to put out in its strongest direction.',
      txpower: 'The power the licence allows the transmitter to feed into its antenna cable, in watts.',
      emission: 'The emission designator: the channel width, then three characters for how the signal is modulated and '
        + 'what it carries. 7K50F2D is a 7.5 kHz wide FM signal carrying data — an ALERT burst.',
      cond: 'A special condition ACMA wrote on this one licence, beyond the rules every licence of its type carries. '
        + 'Where the two differ, the special condition is the one that applies.',
      under: 'Transmitting stations at one of the licence’s sites, or inside its circle. A licence with none may be for '
        + 'a site Flood-Net does not hold, or one no longer in use.',
      recorded: 'The licence number typed on the station’s own record in Flood-Net (a repeater’s ACMA licence, or a '
        + 'frequency’s), checked against the register copy.',
    };
  }

  const GLOSSARY = [
    ['register', 'Register'], ['holder', 'Holder'], ['pmp', 'Point to multipoint (PMP)'], ['ptp', 'Point to point (PTP)'],
    ['area', 'Covered area'], ['site', 'Licence at the site'], ['inarea', 'Inside a licence’s area'], ['none', 'None found'],
    ['na', 'Not a transmitter'], ['gap', 'Gap'], ['nearmiss', 'Just past a circle'], ['farout', 'Well outside'], ['nochan', 'No base on its channel'], ['carries', 'Carries it'], ['soon', 'Expires soon'], ['lapsed', 'Not in force'],
    ['txpower', 'TX power'], ['eirp', 'EIRP'], ['emission', 'Emission'], ['cond', 'Special condition'],
    ['under', 'Stations under it'], ['recorded', 'On the station’s record'],
  ];

  function meaning(k) { return words()[k === 'area-state' ? 'inarea' : k]; }
  function term(k, text) { return termHtml(text || (GLOSSARY.find(g => g[0] === k) || [k, k])[1], meaning(k)); }
  function chip(k, text, cls) {
    return `<span class="term-chip lic-chip${cls ? ` ${cls}` : ''}" title="${escAttr(meaning(k))}">${esc(text)}</span>`;
  }
  const stateMeaning = k => meaning(k === 'area' ? 'inarea' : k);
  function stateChip(k) {
    return `<span class="term-chip lic-chip lic-state lic-state-${k}" title="${escAttr(stateMeaning(k))}">${esc(stateLabel(k))}</span>`;
  }
  function glossaryHtml(cls) {
    return `<details class="bestrep-words ${cls || ''}"><summary>What the words ${cls ? 'in this section' : 'on this panel'} mean</summary>
      <dl>${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(meaning(k))}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── ACMA's own pages ────────────────────────────────────────────────────────
  // The licence document: checked against eight licence numbers of different
  // lengths (Nov 2026) — millions / thousands (not zero-padded) / number /
  // issue. The register itself moved to a new site on 10 June 2026 whose
  // address for one licence could not be confirmed from here, so the register
  // link goes to its search page.

  const REGISTER_URL = 'https://www.acma.gov.au/register-radiocommunication-licences-rrl#/licences';
  function pdfUrl(no) {
    const m = /^(\d+)\/(\d+)$/.exec(String(no).trim());
    if (!m) return '';
    const n = Number(m[1]);
    const blob = `https://cdn.acma.gov.au/rrl/licences/${Math.floor(n / 1e6)}/${Math.floor(n / 1e3) % 1000}/${m[1]}/${m[2]}.pdf`;
    return `https://backend.acma.gov.au/rrl/v1/licences/pdf?blobUrl=${encodeURIComponent(blob)}&licenceNumber=${m[1]}-${m[2]}.pdf`;
  }
  function out(text, href, label) {
    return `<a href="${escAttr(href)}" target="_blank" rel="noopener"
        aria-label="${escAttr(`${label || text} — in a new tab`)}">${esc(text)}<span aria-hidden="true"> ↗</span></a>`;
  }
  function licLinks(l) {
    const pdf = pdfUrl(l.no);
    return [
      pdf ? out('Licence document (PDF)', pdf, `ACMA’s licence document for ${l.no}`) : '',
      out('Search the register', REGISTER_URL, `ACMA’s register — search it for ${l.no}`),
    ].filter(Boolean).join(' · ');
  }

  // ── The file ────────────────────────────────────────────────────────────────

  const tidyName = n => {
    const s = String(n || '').trim();
    if (!s || s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Of|And|The|For)\b/g, w => w.toLowerCase())
      .replace(/^./, c => c.toUpperCase());
  };

  function index(raw) {
    const holders = (raw.holders || []).map(([no, name, trading, type, cls, net], i) =>
      ({ i, no: String(no), name: tidyName(name), trading: trading || '', type: type || '', cls: cls || 'other', net: !!net }));
    const sites = (raw.sites || []).map(([id, name, lat, lon, st, precision], i) =>
      ({ i, id: String(id), name: name || '', lat, lon, state: st || '', precision: precision || '' }));
    const conds = raw.conditions || [];
    const lics = (raw.licences || []).map(([no, status, cat, issued, expiry, h, callsign, cs], i) => ({
      i, no: String(no), status: status || '', cat: cat || '', issued: issued || '', expiry: expiry || '',
      holder: holders[h], callsign: callsign || '', conds: (cs || []).map(c => conds[c]).filter(Boolean),
      kind: /multipoint/i.test(cat || '') ? 'pmp' : 'ptp', devs: [],
    }));
    for (const [li, si, tr, f, bw, em, txW, eirpW, antM, az, auth, efl, rel] of (raw.devices || [])) {
      const l = lics[li], site = sites[si];
      if (l && site) l.devs.push({ site, tr, f, bw, em, txW, eirpW, antM, az, auth, efl, rel });
    }
    const uniq = xs => [...new Set(xs)];
    for (const l of lics) {
      const tx = l.devs.filter(d => d.tr === 'T');
      l.txSites = uniq(tx.map(d => d.site));
      l.sites = uniq(l.devs.map(d => d.site));
      l.f = uniq(tx.map(d => d.f)).sort((a, b) => a - b);
      l.maxF = l.f.length ? l.f[l.f.length - 1] : null;
      // A link: a transmitter and the receiver it is paired with at another site.
      l.links = [];
      if (l.kind === 'ptp') {
        const seen = new Set();
        for (const t of tx) {
          const r = l.devs.find(d => d.tr === 'R' && d.site !== t.site && (d.efl === t.rel || d.rel === t.efl))
            || l.devs.find(d => d.tr === 'R' && d.site !== t.site && Math.abs(d.f - t.f) < SAME_MHZ);
          if (!r) continue;
          const k = [t.site.id, r.site.id].sort().join('|');
          if (!seen.has(k)) { seen.add(k); l.links.push([t.site, r.site]); }
        }
      }
      // A service area the licence's own special conditions state, in km.
      l.statedKm = null;
      for (const c of l.conds) {
        const m = /service area of (\d+(?:\.\d+)?)\s*km/i.exec(c);
        if (m) { l.statedKm = Number(m[1]); break; }
      }
      l.search = `${l.no} ${l.holder ? l.holder.name : ''} ${l.holder ? l.holder.trading : ''} ${l.callsign} ${l.sites.map(s => `${s.name} ${s.id}`).join(' ')}`.toLowerCase();
    }
    return { meta: raw.meta || {}, holders, sites, lics };
  }

  function ensure() {
    if (D) return Promise.resolve(D);
    if (!loading) {
      const get = typeof acmaFetchJson === 'function' ? acmaFetchJson(FILE)
        : fetch(`data/${FILE}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
      loading = get.then(raw => { D = index(raw); loadErr = ''; cover = null; return D; })
        .catch(e => { loading = null; loadErr = (e && e.message) || 'could not be read'; throw e; });
    }
    return loading;
  }

  const asAt = () => (D && D.meta.source_date) || '';
  const dateText = iso => {
    if (!/^\d{4}-\d{2}-\d{2}/.test(iso || '')) return iso || '';
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
  };

  // ── A licence's standing, kind and reach ────────────────────────────────────

  function daysLeft(l) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(l.expiry)) return null;
    return Math.floor((Date.parse(`${l.expiry.slice(0, 10)}T23:59:59Z`) - Date.now()) / 864e5);
  }
  // 'lapsed' | 'soon' | 'ok'
  function standing(l) {
    const d = daysLeft(l);
    if (!/^granted/i.test(l.status) || (d != null && d < 0)) return 'lapsed';
    return d != null && d <= SOON_DAYS ? 'soon' : 'ok';
  }
  const current = l => standing(l) !== 'lapsed';
  const kindWord = l => (l.kind === 'pmp' ? 'point to multipoint' : 'point to point');
  const kindShort = l => (l.kind === 'pmp' ? 'PMP' : 'PTP');
  const radiusOf = l => (l.statedKm != null ? l.statedKm : F.radius);
  const mhz = f => { const t = Number(f).toFixed(4).replace(/0+$/, ''); return t.endsWith('.') ? `${t}0` : t; };
  const freqText = l => (l.f.length ? `${l.f.slice(0, 3).map(mhz).join(', ')}${l.f.length > 3 ? '…' : ''} MHz` : 'no transmit frequency');
  const watt = w => (w == null ? '—' : `${Number(w) >= 10 ? Math.round(w) : Number(w).toFixed(1).replace(/\.0$/, '')} W`);

  function holderOn(h) { return !!h && F.cls[h.cls] !== false && !F.off.includes(h.no); }
  function inBand(l) {
    if (F.band === 'all') return true;
    return l.f.some(f => (F.band === 'vhf' ? f >= 148 && f <= 174 : f >= 400 && f <= 520));
  }
  // The licences the map draws: the ticked holders', of the ticked types, standing and band.
  function shown(l) {
    if (!holderOn(l.holder) || F.types[l.kind] === false || !inBand(l)) return false;
    const st = standing(l);
    if (F.status === 'current') return st !== 'lapsed';
    if (F.status === 'soon') return st === 'soon';
    if (F.status === 'lapsed') return st === 'lapsed';
    return true;
  }
  // The licences a verdict is read from: the ticked holders', whatever is drawn.
  const counted = () => (D ? D.lics.filter(l => holderOn(l.holder)) : []);

  // ── A station ───────────────────────────────────────────────────────────────

  function stations() { return (state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => String(s.id) === String(id)) || null; }
  const located = s => !!s && s.lat != null && s.lon != null && s.lat !== '' && s.lon !== '' && isFinite(Number(s.lat)) && isFinite(Number(s.lon));
  const isRepeater = s => !!s && (!!s.repeater || (Array.isArray(s.roles) && s.roles.includes('repeater')));
  function alertIds(s) {
    if (typeof stationAlertIds === 'function') return stationAlertIds(s);
    return Object.values((s && s.alert_ids) || {}).filter(v => v != null);
  }
  // The rule frequencies.js uses for "transmits by radio", and a repeater.
  function transmits(s) {
    return isRepeater(s) || alertIds(s).length > 0 || (s.alert2_station_id != null && s.alert2_station_id !== '');
  }
  const fin = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  // The channels it is known to transmit on: its own pairs, else the listening
  // channel of each repeater that likely hears it directly.
  function txChannels(s, withCarriers) {
    const out = [];
    const pairs = typeof Frequencies !== 'undefined' ? Frequencies.pairs(s) : [];
    for (const p of pairs) { const f = fin(p.tx_mhz); if (f != null) out.push(f); }
    if (!out.length && withCarriers !== false) {
      const C = carriers(s);
      for (const c of (C ? C.direct : [])) if (c.rx != null) out.push(c.rx);
    }
    return [...new Set(out)];
  }
  function carriers(s) {
    try { return typeof Frequencies !== 'undefined' && Frequencies.carriersOf ? Frequencies.carriersOf(s) : null; }
    catch (_) { return null; }
  }
  // true: on one of its channels; false: known to be on another; null: its channel is not on record.
  function onChannel(l, chans) {
    if (!chans.length || !l.f.length) return null;
    return l.f.some(f => chans.some(c => Math.abs(f - c) < SAME_MHZ));
  }
  const kmTo = (s, site) => acmaHaversineKm(Number(s.lat), Number(s.lon), site.lat, site.lon);
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const dirOf = (s, site) => COMPASS[Math.round(bearingDeg(Number(s.lat), Number(s.lon), site.lat, site.lon) / 22.5) % 16];

  function recordedOn(s) {
    const pairs = typeof Frequencies !== 'undefined' ? Frequencies.pairs(s) : [];
    const nums = [...new Set(pairs.map(p => String(p.acma_licence || '').trim()).filter(Boolean))];
    return nums.map(n => {
      const key = n.replace(/\s+/g, '');
      const l = D.lics.find(x => x.no === key) || (key.includes('/') ? null : D.lics.find(x => x.no.split('/')[0] === key));
      return { typed: n, lic: l || null, km: l && located(s) ? Math.min(...l.sites.map(site => kmTo(s, site))) : null };
    });
  }

  // Every licence of the ticked holders against one station:
  //   near   each licence once, nearest first — for the card's list
  //   state  'site' | 'area' | 'none' | 'na', and what it rests on
  function assess(s, opts) {
    const light = !!(opts && opts.light);        // the coverage view: no list, no carriers unless needed
    const a = { st: s, transmits: transmits(s), located: located(s), state: 'na', site: [], area: [], off: [], lapsed: [],
      nearestPmp: null, near: [], chans: [], recorded: [] };
    if (!D || !a.located) return a;
    a.chans = txChannels(s, a.transmits);
    for (const l of counted()) {
      let best = null, bestTx = null;
      for (const site of l.sites) {
        const km = kmTo(s, site);
        if (!best || km < best.km) best = { km, site };
        if (l.txSites.includes(site) && (!bestTx || km < bestTx.km)) bestTx = { km, site };
      }
      if (!best) continue;
      const ok = onChannel(l, a.chans), cur = current(l);
      const R = l.kind === 'pmp' ? radiusOf(l) : null;
      const atSite = !!bestTx && bestTx.km <= SITE_KM;
      const inside = l.kind === 'pmp' && !!bestTx && bestTx.km <= R;
      const m = { lic: l, km: best.km, site: best.site, txKm: bestTx ? bestTx.km : null, txSite: bestTx ? bestTx.site : null,
        ok, atSite, inside, rxOnly: !atSite && best.km <= SITE_KM };
      if (atSite || inside) {
        if (!cur) a.lapsed.push(m);
        else if (ok === false) a.off.push(m);
        else (atSite ? a.site : a.area).push(m);
      }
      if (l.kind === 'pmp' && cur && ok !== false && bestTx && (!a.nearestPmp || bestTx.km - R < a.nearestPmp.gap)) {
        a.nearestPmp = { ...m, gap: bestTx.km - R, radius: R };
      }
      if (!light) a.near.push(m);
    }
    a.site.sort((x, y) => x.txKm - y.txKm);
    a.area.sort((x, y) => x.txKm - y.txKm);
    if (!light) a.near.sort((x, y) => x.km - y.km);
    if (a.transmits) a.state = a.site.length ? 'site' : a.area.length ? 'area' : 'none';
    // Which covering base a repeater that carries it stands at.
    if (a.state === 'area' && !light) {
      const C = carriers(s);
      const reps = C ? C.all.map(c => c.r).filter(located) : [];
      for (const m of a.area) {
        const r = reps.find(x => kmTo(x, m.txSite) <= SITE_KM);
        if (r) m.via = r;
      }
      a.area.sort((x, y) => (y.via ? 1 : 0) - (x.via ? 1 : 0) || x.txKm - y.txKm);
      a.carried = reps.length > 0;
    }
    if (!light) a.recorded = recordedOn(s);
    return a;
  }

  const holderName = l => (l.holder ? l.holder.name : 'holder not named');
  const licBrief = l => `${l.no} (${holderName(l)}, ${kindWord(l)}, ${freqText(l)})`;

  // The one-line verdict, in words that claim no more than the register copy can.
  function verdictText(a) {
    const s = a.st, date = dateText(asAt());
    if (!a.located) return 'It has no position on record, so no licence can be matched to it.';
    if (!a.transmits) {
      return 'Not recorded as a transmitter — it has no ALERT address and is not a repeater — so there is nothing here to '
        + 'license. Receiving needs no licence.';
    }
    const offNote = a.off.length ? ` A licence here on another channel was left out: ${a.off[0].lic.no} (${freqText(a.off[0].lic)}).` : '';
    const lapsedNote = a.lapsed.length ? ` Not in force here: ${a.lapsed.slice(0, 2).map(m => `${m.lic.no} (${m.lic.status.toLowerCase()}${m.lic.expiry ? `, expiry ${dateText(m.lic.expiry)}` : ''})`).join(', ')}.` : '';
    if (a.state === 'site') {
      const m = a.site[0], l = m.lic, st = standing(l);
      return `Licensed at this site: ${licBrief(l)}, its transmitter ${fmtKm(m.txKm)} from the pin`
        + `${st === 'soon' ? ` — expires ${dateText(l.expiry)}, within ${SOON_DAYS} days` : `, in force to ${dateText(l.expiry)}`}.`
        + `${a.site.length > 1 ? ` ${a.site.length - 1} more at this site.` : ''}${lapsedNote}`;
    }
    if (a.state === 'area') {
      const m = a.area[0], l = m.lic, R = radiusOf(l);
      const reach = l.statedKm != null ? `the ${R} km service area written on that licence` : `the ${R} km reach ACMA assumes for such a licence`;
      const via = m.via ? ` That base is at ${m.via.name}, a repeater that carries this station.`
        : a.carried ? ' None of the repeaters that carry this station stands at that base, so check it is the base it talks to.' : '';
      return `No licence names this site. It is ${fmtKm(m.txKm)} from the base of point-to-multipoint licence ${l.no} `
        + `(${holderName(l)}, ${freqText(l)}) — inside ${reach}. A licence of that kind covers the remote stations that talk `
        + `to its base without listing them.${via}${offNote}${lapsedNote}`;
    }
    const n = a.nearestPmp;
    const nearest = n ? ` The nearest point-to-multipoint base on its channel is ${n.lic.no} (${holderName(n.lic)}), ${fmtKm(n.txKm)} away — `
      + `${fmtKm(Math.max(0, n.gap))} beyond its ${n.radius} km circle.` : '';
    return `No licence found for this site in the register copy of ${date}, among the holders ticked.${nearest} That is not the `
      + `same as unlicensed: the copy can lag, the licence may be held by somebody not in the list, or a transmitter of 100 mW `
      + `EIRP or less may run under the low-power class licence.${offNote}${lapsedNote}`;
  }

  // What the licence allows against what the station's record says, where both are known.
  function powerNote(a) {
    const s = a.st;
    const sys = typeof rmSystemOf === 'function' ? rmSystemOf(s) : null;
    const w = sys && fin(sys.tx_power_w);
    if (a.state === 'site') {
      const d = a.site[0].lic.devs.find(x => x.tr === 'T' && x.site === a.site[0].txSite) || {};
      if (d.txW == null && d.eirpW == null) return '';
      const over = w != null && d.txW != null && w > d.txW + 1e-6;
      return `The licence allows ${watt(d.txW)} into the antenna and ${watt(d.eirpW)} EIRP here`
        + `${w != null ? `; the radio on this station’s record is ${watt(w)} (${sys.name})${over ? ' — more than the licence allows, worth checking' : ''}` : ''}.`;
    }
    if (a.state === 'area') {
      return `As a remote station of that licence it may send data for no more than 2 seconds at a time, no more often than `
        + `every 10 seconds, at up to 1 W into the antenna unless the licence itself says otherwise`
        + `${w != null ? ` — the radio on this station’s record is ${watt(w)} (${sys.name})${w > 1 + 1e-6 ? ', worth checking against the licence' : ''}` : ''}.`;
    }
    return '';
  }

  // ── The station card's section ──────────────────────────────────────────────

  function nearRowHtml(a, m) {
    const l = m.lic, st = standing(l);
    const where = m.atSite ? chip('site', 'at this site', 'lic-in')
      : m.inside ? chip('area', `inside its ${radiusOf(l)} km area`, 'lic-in')
      : m.rxOnly ? '<span class="lic-chip">its receiving end is here</span>'
      : l.kind === 'pmp' ? chip('gap', `${fmtKm(Math.max(0, m.txKm - radiusOf(l)))} outside its area`, 'lic-out')
      : '<span class="lic-chip lic-out">covers its two ends only</span>';
    const stand = st === 'lapsed' ? chip('lapsed', l.status && !/^granted/i.test(l.status) ? l.status : 'expired', 'lic-bad')
      : st === 'soon' ? chip('soon', `expires ${dateText(l.expiry)}`, 'lic-warn')
      : `<span class="lic-muted">to ${esc(dateText(l.expiry))}</span>`;
    const chan = m.ok === false ? ' <span class="lic-chip lic-out" title="The station is on record as transmitting on another channel, so this licence does not count for it.">another channel</span>' : '';
    const pdf = pdfUrl(l.no);
    return `<li class="lic-near" data-lic="${escAttr(l.no)}">
        <span class="lic-near-h"><span class="lic-dot" style="--dot:${classColour(l.holder ? l.holder.cls : 'other')}" aria-hidden="true"></span>
          <button type="button" class="link-btn lic-no" onclick="MapAcma.showLicence('${escAttr(l.no)}')"
                  title="Show this licence and what it covers on the map">${esc(l.no)}</button>
          <span class="lic-km">${esc(fmtKm(m.km))} ${esc(dirOf(a.st, m.site))}</span></span>
        <span class="lic-near-b">${esc(holderName(l))} · ${chip(l.kind, kindShort(l))} · ${esc(freqText(l))}${chan} · ${stand}</span>
        <span class="lic-near-b">${where} <span class="lic-muted">${esc(m.site.name)}</span></span>
        <span class="lic-near-b lic-links">${pdf ? out('Licence document (PDF)', pdf, `ACMA’s licence document for ${l.no}`) : ''}</span>
      </li>`;
  }

  function recordedHtml(a) {
    if (!a.recorded.length) return '';
    return a.recorded.map(r => {
      if (!r.lic) {
        return `<p class="lic-rec">${term('recorded', 'On the station’s record')}: licence ${esc(r.typed)} —
          <span class="txt-warn">not in this register copy</span>, which holds only the fixed licences of the holders listed.
          ${pdfUrl(r.typed.includes('/') ? r.typed : `${r.typed}/1`) ? out('Try its licence document', pdfUrl(r.typed.includes('/') ? r.typed : `${r.typed}/1`), `ACMA’s licence document for ${r.typed}`) : ''}</p>`;
      }
      const far = r.km != null && r.km > SITE_KM;
      return `<p class="lic-rec">${term('recorded', 'On the station’s record')}: licence ${esc(r.typed)} — in the register as
        ${esc(licBrief(r.lic))}, ${esc(r.lic.status.toLowerCase())}${far ? `, <span class="txt-warn">but its nearest site is ${esc(fmtKm(r.km))} from this pin</span>` : ''}.</p>`;
    }).join('');
  }

  function cardKey(s) { return located(s) ? `${s.id}|${Number(s.lat).toFixed(5)},${Number(s.lon).toFixed(5)}` : null; }

  // The section's inside, from whatever is on hand now.
  function sectionHtml(s) {
    const headId = `mn-lic-head-${s.id}`;
    const head = `<span class="small txt-muted stn-card-rhs-head" id="${escAttr(headId)}"
        title="${escAttr(meaning('register'))}">ACMA licences near here</span>
      <span class="stn-card-rhs-snap mn-pop-note">${D ? `register copy of ${esc(dateText(asAt()))}` : 'from ACMA’s register'}</span>`;
    let inner;
    if (!D) {
      inner = loadErr
        ? `<p class="lic-verdict"><span class="txt-warn">The licence list could not be read</span> (${esc(loadErr)}).
            <button type="button" class="pill" onclick="MapAcma.cardRetry(this)">Try again</button></p>`
        : '<p class="lic-verdict mn-pop-note">reading the register copy…</p>';
    } else {
      const a = assess(s);
      const rows = a.near.slice(0, CARD_ROWS).map(m => nearRowHtml(a, m)).join('');
      const more = a.near.slice(CARD_ROWS, CARD_MORE);
      const power = powerNote(a);
      inner = `
        <p class="lic-verdict" data-lic-state="${a.state}">${stateChip(a.state)} ${esc(verdictText(a))}</p>
        ${power ? `<p class="lic-rec lic-power">${esc(power)}</p>` : ''}
        ${recordedHtml(a)}
        ${rows ? `<ul class="lic-near-list" aria-label="The nearest licences, nearest first">${rows}</ul>` : '<p class="lic-rec">No licence of the listed holders is in the register copy.</p>'}
        ${more.length ? `<details class="lic-more"><summary>${more.length} more, further away</summary>
            <ul class="lic-near-list">${more.map(m => nearRowHtml(a, m)).join('')}</ul></details>` : ''}
        <p class="lic-foot">
          <button type="button" class="pill" onclick="MapAcma.showFor('${escAttr(s.id)}')"
                  title="Open the ACMA licences tool on this station: the licences round it drawn on the map with the areas they cover"
                  ><span aria-hidden="true">📜</span> Show on the map</button>
          ${out('ACMA’s register', REGISTER_URL, 'ACMA’s Register of Radiocommunications Licences')}
        </p>
        <details class="bestrep-words lic-words"><summary>What the words in this section mean</summary>
          <dl>${['register', 'holder', 'pmp', 'ptp', 'area', 'site', 'inarea', 'none', 'na', 'gap', 'soon', 'lapsed', 'recorded']
            .map(k => `<dt>${esc((GLOSSARY.find(g => g[0] === k) || [k, k])[1])}</dt><dd>${esc(meaning(k))}</dd>`).join('')}</dl>
          <p class="mn-pop-note">A guide from a weekly copy of the public register, not legal advice — check with ACMA before relying on it.</p>
        </details>`;
    }
    return `<div class="stn-card-lic" role="group" aria-labelledby="${escAttr(headId)}" tabindex="-1"${!D && !loadErr ? ' aria-busy="true"' : ''}>
        ${head}${inner}
      </div>`;
  }

  // The section itself, for the card's 📻 Radio group. Nothing for a station
  // with no position: there is nothing to measure a distance from.
  function cardHtml(s) {
    const k = cardKey(s);
    if (!k) return '';
    return `<div class="acma-sect stn-card-licences" id="mn-lic-card-${escAttr(String(s.id))}" data-tour="card-licences"
        data-mn-lic="${escAttr(k)}">${sectionHtml(s)}</div>`;
  }

  const asked = new Map();      // element id → the station last asked about there
  function paintCard(elId) {
    const el = document.getElementById(elId), s = asked.get(elId);
    if (!el || !s) { asked.delete(elId); return; }
    if (el.dataset.mnLic !== cardKey(s)) return;
    const had = el.contains(document.activeElement);
    const open = [...el.querySelectorAll('details[open]')].map(d => d.className);
    el.innerHTML = sectionHtml(s);
    for (const c of open) { const d = el.querySelector(`details.${c.split(' ').join('.')}`); if (d) d.open = true; }
    if (had) { const g = el.querySelector('.stn-card-lic'); if (g) g.focus({ preventScroll: true }); }
  }
  function repaintCards() { for (const id of [...asked.keys()]) paintCard(id); }
  function cardAsk(elId, s) {
    if (!cardKey(s)) return;
    asked.set(elId, s);
    if (D) return;
    ensure().then(() => repaintCards(), () => repaintCards());
  }

  // ── Coverage: every transmitting station's state ────────────────────────────

  function coverKey() {
    return [stations().length, F.radius, JSON.stringify(F.cls), F.off.join(','), state.mapMaxLinkKm].map(String).join('|');
  }
  function coverage() {
    if (!D) return null;
    const key = coverKey();
    if (cover && cover.key === key && cover.ref === (state.data && state.data.stations)) return cover;
    const rows = [];
    const counts = { site: 0, area: 0, none: 0, na: 0, nopos: 0 };
    const under = new Map();    // licence → { site: n, area: n }
    for (const s of stations()) {
      if (!located(s)) { counts.nopos++; continue; }
      if (!transmits(s)) { counts.na++; continue; }
      const a = assess(s, { light: true });
      counts[a.state]++;
      for (const m of a.site) { const u = under.get(m.lic) || { site: 0, area: 0 }; u.site++; under.set(m.lic, u); }
      for (const m of a.area) { const u = under.get(m.lic) || { site: 0, area: 0 }; u.area++; under.set(m.lic, u); }
      rows.push(a);
    }
    const holders = D.holders.filter(holderOn).map(h => {
      const ls = D.lics.filter(l => l.holder === h);
      return { h, n: ls.length, pmp: ls.filter(l => l.kind === 'pmp').length, ptp: ls.filter(l => l.kind === 'ptp').length,
        soon: ls.filter(l => standing(l) === 'soon').length, lapsed: ls.filter(l => standing(l) === 'lapsed').length,
        atSite: ls.reduce((n, l) => n + ((under.get(l) || {}).site || 0), 0),
        inArea: ls.reduce((n, l) => n + ((under.get(l) || {}).area || 0), 0),
        empty: ls.filter(l => current(l) && !under.has(l)).length };
    }).filter(x => x.n).sort((x, y) => y.n - x.n);
    cover = { key, ref: state.data && state.data.stations, rows, counts, under, holders };
    return cover;
  }

  function ownerText(s) {
    try { const o = typeof stationOwner === 'function' ? stationOwner(s) : null; return o ? o.name : (s.owner ? String(s.owner) : ''); }
    catch (_) { return s.owner ? String(s.owner) : ''; }
  }

  // The none-found stations by who owns them, split by how likely each is a
  // real gap: just past a circle (a base is close — probably covered, only
  // further out than ACMA assumes), well outside every circle, or no
  // point-to-multipoint base on its channel at all among the ticked holders.
  const NO_OWNER = '(no owner on record)';
  function noneByOwner() {
    const C = coverage();
    if (!C) return [];
    const by = new Map();
    for (const a of C.rows) {
      if (a.state !== 'none') continue;
      const k = ownerText(a.st) || NO_OWNER;
      let o = by.get(k);
      if (!o) by.set(k, o = { owner: k, n: 0, near: 0, far: 0, nochan: 0, holders: new Map() });
      o.n++;
      if (!a.nearestPmp) o.nochan++;
      else {
        if (Math.max(0, a.nearestPmp.gap) <= NEAR_MISS_KM) o.near++; else o.far++;
        const h = holderName(a.nearestPmp.lic);
        o.holders.set(h, (o.holders.get(h) || 0) + 1);
      }
    }
    return [...by.values()].map(o => ({ ...o, holder: ([...o.holders].sort((x, y) => y[1] - x[1])[0] || [''])[0] }))
      .sort((x, y) => (y.far + y.nochan) - (x.far + x.nochan) || y.n - x.n);
  }

  function noneRows() {
    const C = coverage();
    if (!C) return [];
    const rows = C.rows.filter(a => a.state === 'none' && (!noneOwner || (ownerText(a.st) || NO_OWNER) === noneOwner));
    const gap = a => (a.nearestPmp ? Math.max(0, a.nearestPmp.gap) : Infinity);
    if (noneSort === 'name') rows.sort((x, y) => String(x.st.name).localeCompare(String(y.st.name)));
    else if (noneSort === 'owner') rows.sort((x, y) => ownerText(x.st).localeCompare(ownerText(y.st)) || String(x.st.name).localeCompare(String(y.st.name)));
    else if (noneSort === 'near') rows.sort((x, y) => gap(x) - gap(y));
    else rows.sort((x, y) => gap(y) - gap(x));
    return rows;
  }

  function stationsCsv() {
    const C = coverage();
    if (!C) return '';
    const q = csvEscape;
    const lines = [
      '# Flood-Net — ACMA licensing state of every transmitting station',
      `# register copy,${asAt()},holders ticked,${D.holders.filter(holderOn).length},point-to-multipoint radius km,${F.radius}`,
      '# none found is not the same as unlicensed: the register copy can lag; a holder may not be in the list; a class licence may apply',
      ['station_id', 'station', 'station_number', 'lat', 'lon', 'owner', 'roles', 'tx_channels_mhz', 'state', 'licence', 'licence_holder',
       'licence_type', 'licence_mhz', 'licence_expiry', 'distance_km', 'nearest_pmp_licence', 'nearest_pmp_km', 'gap_km', 'note'].join(','),
    ];
    for (const a of C.rows) {
      const s = a.st, m = a.site[0] || a.area[0] || null, n = a.nearestPmp;
      const note = [a.off.length ? `licence on another channel here: ${a.off[0].lic.no}` : '', a.lapsed.length ? `not in force here: ${a.lapsed[0].lic.no}` : '']
        .filter(Boolean).join('; ');
      lines.push([q(s.id), q(s.name), q(s.station_number || ''), s.lat, s.lon, q(ownerText(s)), q((s.roles || []).join(' ')),
        q(a.chans.map(mhz).join(' ')), q(stateLabel(a.state)), m ? q(m.lic.no) : '', m ? q(holderName(m.lic)) : '',
        m ? q(kindWord(m.lic)) : '', m ? q(m.lic.f.map(mhz).join(' ')) : '', m ? m.lic.expiry : '', m ? m.txKm.toFixed(2) : '',
        n ? q(n.lic.no) : '', n ? n.txKm.toFixed(2) : '', n && a.state === 'none' ? Math.max(0, n.gap).toFixed(2) : '', q(note)].join(','));
    }
    return lines.join('\n') + '\n';
  }

  function licencesCsv() {
    const C = coverage();
    if (!C) return '';
    const q = csvEscape;
    const lines = [
      '# Flood-Net — the ACMA licences of the ticked holders, and the stations under each',
      `# register copy,${asAt()},point-to-multipoint radius km,${F.radius}`,
      ['licence', 'holder', 'holder_class', 'type', 'status', 'issued', 'expiry', 'days_left', 'callsign', 'tx_mhz', 'tx_power_w', 'eirp_w',
       'site_ids', 'sites', 'lat', 'lon', 'radius_km', 'radius_from', 'stations_at_site', 'stations_in_area', 'special_conditions', 'licence_document'].join(','),
    ];
    for (const l of counted()) {
      const u = C.under.get(l) || { site: 0, area: 0 }, t = l.devs.find(d => d.tr === 'T') || {}, s0 = l.txSites[0] || l.sites[0] || {};
      lines.push([q(l.no), q(holderName(l)), l.holder ? l.holder.cls : '', q(l.cat), q(l.status), l.issued, l.expiry, daysLeft(l) ?? '',
        q(l.callsign), q(l.f.map(mhz).join(' ')), t.txW ?? '', t.eirpW ?? '', q(l.sites.map(s => s.id).join(' ')), q(l.sites.map(s => s.name).join(' | ')),
        s0.lat ?? '', s0.lon ?? '', l.kind === 'pmp' ? radiusOf(l) : '', l.kind === 'pmp' ? (l.statedKm != null ? 'the licence' : 'assumed reach') : '',
        u.site, u.area, q(l.conds.join(' | ')), q(pdfUrl(l.no))].join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  function hits() {
    const q = hitQ.trim().toLowerCase();
    if (!q || !D) return { st: [], lic: [] };
    const num = /^\d+(\.\d+)?$/.test(q) ? Number(q) : null;
    const st = [];
    for (const s of stations()) {
      const name = String(s.name || '').toLowerCase(), no = String(s.station_number || '');
      const hit = name.includes(q) || (no && no.startsWith(q)) || String(s.id).toLowerCase() === q
        || (num != null && Number.isInteger(num) && alertIds(s).some(id => Number(id) === num));
      if (hit) { st.push(s); if (st.length >= HIT_CAP * 3) break; }
    }
    st.sort((a, b) => (String(a.name).toLowerCase().startsWith(q) ? 0 : 1) - (String(b.name).toLowerCase().startsWith(q) ? 0 : 1));
    const lic = [];
    const isFreq = num != null && q.includes('.');
    for (const l of D.lics) {
      const hit = isFreq ? l.f.some(f => Math.abs(f - num) < 0.0005 || mhz(f).startsWith(q))
        : l.search.includes(q) || (l.holder && l.holder.no === q);
      if (hit) lic.push(l);
    }
    lic.sort((a, b) => (a.no.startsWith(q) ? 0 : 1) - (b.no.startsWith(q) ? 0 : 1) || (holderOn(b.holder) ? 1 : 0) - (holderOn(a.holder) ? 1 : 0));
    return { st: st.slice(0, HIT_CAP), lic: lic.slice(0, HIT_CAP), moreLic: Math.max(0, lic.length - HIT_CAP) };
  }

  function hitsHtml() {
    if (!hitQ.trim()) return '';
    if (!D) return '<p class="small txt-muted">The register copy is still loading.</p>';
    const h = hits();
    if (!h.st.length && !h.lic.length) return '<p class="small txt-muted">Nothing matches — try a station name or number, an ALERT address, a licence number, a holder, a site or a frequency such as 151.5.</p>';
    const stRows = h.st.map(s => {
      const a = assess(s, { light: true });
      return `<button type="button" class="polar-hit lic-hit" onclick="MapAcma.pickStation('${escAttr(s.id)}')">
          <span>${esc(s.name)}${s.station_number ? ` <span class="lic-muted">#${esc(s.station_number)}</span>` : ''}</span>
          ${stateChip(a.state)}</button>`;
    }).join('');
    const licRows = h.lic.map(l => `<button type="button" class="polar-hit lic-hit" onclick="MapAcma.pickLicence('${escAttr(l.no)}')">
        <span><span class="lic-dot" style="--dot:${classColour(l.holder ? l.holder.cls : 'other')}" aria-hidden="true"></span>${esc(l.no)}
          <span class="lic-muted">${esc(holderName(l))} · ${esc(kindShort(l))} · ${esc(freqText(l))} · ${esc((l.txSites[0] || l.sites[0] || { name: '' }).name)}</span></span>
        ${standing(l) === 'lapsed' ? chip('lapsed', 'not in force', 'lic-bad') : standing(l) === 'soon' ? chip('soon', 'expires soon', 'lic-warn') : ''}
      </button>`).join('');
    return `${stRows ? `<p class="lic-hit-h">Stations</p>${stRows}` : ''}
      ${licRows ? `<p class="lic-hit-h">Licences</p>${licRows}${h.moreLic ? `<p class="small txt-muted">…and ${h.moreLic} more — type more of it.</p>` : ''}` : ''}`;
  }

  // ── The picked thing ────────────────────────────────────────────────────────

  function licenceDetailHtml(l) {
    const C = cover && cover.key === coverKey() ? cover : null;
    const st = standing(l), d = daysLeft(l);
    const u = C ? (C.under.get(l) || { site: 0, area: 0 }) : null;
    const devRows = l.devs.slice().sort((a, b) => (a.tr === b.tr ? 0 : a.tr === 'T' ? -1 : 1)).slice(0, 12).map(x => `<li>
        <strong>${x.tr === 'T' ? 'Transmits' : 'Receives'}</strong> at ${esc(x.site.name)} <span class="lic-muted">(ACMA site ${esc(x.site.id)})</span><br>
        ${esc(mhz(x.f))} MHz${x.bw != null ? `, ${esc(String(x.bw))} kHz wide` : ''}${x.em ? ` · ${term('emission', 'emission')} ${esc(x.em)}` : ''}${x.tr === 'T'
          ? ` · ${term('txpower', 'TX power')} ${esc(watt(x.txW))} · ${term('eirp', 'EIRP')} ${esc(watt(x.eirpW))}` : ''}${x.antM != null ? ` · antenna ${esc(String(x.antM))} m up` : ''}</li>`).join('');
    const reach = l.kind === 'pmp'
      ? `Its circle is ${radiusOf(l)} km — ${l.statedKm != null ? 'the service area written in its special conditions' : 'the reach ACMA assumes when it hands out the channel (set above); the licence states no distance'}.`
      : l.links.length ? `A link between ${l.links.map(([a, b]) => `${a.name} and ${b.name} (${fmtKm(acmaHaversineKm(a.lat, a.lon, b.lat, b.lon))})`).join('; ')}. It covers those ends and nothing between.`
      : 'The register copy holds one end of this link only.';
    return `<div class="lic-picked" id="acmalic-picked" data-lic="${escAttr(l.no)}">
        <p class="lic-picked-h"><span class="lic-dot" style="--dot:${classColour(l.holder ? l.holder.cls : 'other')}" aria-hidden="true"></span>
          <strong>Licence ${esc(l.no)}</strong> — ${esc(holderName(l))}
          <button type="button" class="link-btn" onclick="MapAcma.unpick()">close</button></p>
        <p class="small">${chip(l.kind, l.cat || kindWord(l))}
          ${st === 'lapsed' ? chip('lapsed', l.status && !/^granted/i.test(l.status) ? l.status : 'expired', 'lic-bad') : st === 'soon' ? chip('soon', `expires in ${d} days`, 'lic-warn') : `<span class="lic-chip">${esc(l.status)}</span>`}
          issued ${esc(dateText(l.issued))}, expires ${esc(dateText(l.expiry))}${l.callsign ? ` · call sign ${esc(l.callsign)}` : ''}${l.holder ? ` · ACMA client ${esc(l.holder.no)}` : ''}</p>
        <p class="small">${esc(reach)}</p>
        <ul class="lic-devs" aria-label="What the licence lists">${devRows}</ul>
        ${l.devs.length > 12 ? `<p class="small txt-muted">${l.devs.length - 12} more entries on the licence document.</p>` : ''}
        ${l.conds.length ? `<p class="small"><strong>${term('cond', 'Special conditions')}</strong></p><ul class="lic-conds">${l.conds.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
          : '<p class="small txt-muted">No special conditions on this licence — the standard conditions for its type apply.</p>'}
        ${u ? `<p class="small">${term('under', 'Stations under it')}: ${u.site} at its site${u.site === 1 ? '' : 's'}${l.kind === 'pmp' ? `, ${u.area} more inside its circle` : ''}.</p>` : ''}
        <p class="small lic-links">${licLinks(l)}</p>
      </div>`;
  }

  function stationDetailHtml(s) {
    const a = assess(s);
    const power = powerNote(a);
    return `<div class="lic-picked" id="acmalic-picked" data-station="${escAttr(String(s.id))}">
        <p class="lic-picked-h"><strong>${esc(s.name)}</strong>${s.station_number ? ` <span class="lic-muted">#${esc(s.station_number)}</span>` : ''}
          <button type="button" class="link-btn" onclick="MapAcma.unpick()">close</button></p>
        <p class="lic-verdict" data-lic-state="${a.state}">${stateChip(a.state)} ${esc(verdictText(a))}</p>
        ${power ? `<p class="lic-rec">${esc(power)}</p>` : ''}
        ${recordedHtml(a)}
        ${a.chans.length ? `<p class="small txt-muted">Taken to transmit on ${esc(a.chans.map(mhz).join(', '))} MHz.</p>` : a.transmits ? '<p class="small txt-muted">Its transmit channel is not on record, so licences on any channel were counted.</p>' : ''}
        ${a.near.length ? `<ul class="lic-near-list">${a.near.slice(0, 6).map(m => nearRowHtml(a, m)).join('')}</ul>` : ''}
        <p class="lic-foot"><button type="button" class="pill" onclick="MapAcma.openCard('${escAttr(s.id)}')">Open its card</button></p>
      </div>`;
  }

  function pickedHtml() {
    if (!picked || !D) return '';
    if (picked.type === 'licence') { const l = D.lics.find(x => x.no === picked.id); return l ? licenceDetailHtml(l) : ''; }
    const s = stationById(picked.id);
    return s ? stationDetailHtml(s) : '';
  }

  // ── The guide ───────────────────────────────────────────────────────────────
  // Every rule here was read in the instrument it cites, on the date beside
  // it. Where the instrument could not be opened from the build (ACMA's own
  // site), the line says "ACMA's guidance" and links the page to read.

  const SRC = {
    act: ['Radiocommunications Act 1992', 'https://www.legislation.gov.au/C2004A04465/latest/text', 'compilation of 1 July 2025'],
    fixed: ['Radiocommunications Licence Conditions (Fixed Licence) Determination 2025', 'https://www.legislation.gov.au/F2025L00388/asmade/text', 'made 20 March 2025'],
    interp: ['Radiocommunications (Interpretation) Determination 2025', 'https://www.legislation.gov.au/F2025L00362/latest/text', 'made 13 March 2025'],
    lm: ['Radiocommunications Licence Conditions (Land Mobile Licence) Determination 2025', 'https://www.legislation.gov.au/F2025L01132/asmade/text', 'made 18 September 2025'],
    lipd: ['Radiocommunications (Low Interference Potential Devices) Class Licence 2025', 'https://www.legislation.gov.au/F2025L01047/asmade/text', 'made 4 September 2025'],
    auth: ['Radiocommunications (Apparatus Licences – Authorisations and Transfers) Determination 2025', 'https://www.legislation.gov.au/F2025L00844/asmade/text', 'made 10 July 2025'],
    sci: ['Radiocommunications Licence Conditions (Scientific Licence) Determination 2023', 'https://www.legislation.gov.au/F2023L01123/latest/text', 'made 28 August 2023'],
    fx16: ['RALI FX16 — point-to-multipoint services in the VHF high, 400 MHz and 800 MHz bands', 'https://www.acma.gov.au/sites/default/files/2025-11/rali_fx16.pdf', 'in effect from 25 March 2025'],
    lm08: ['RALI LM08 — frequency assignment for the land mobile service', 'https://www.acma.gov.au/sites/default/files/2025-12/rali_lm08_-_may_2024_update_1.pdf', 'in effect from 17 May 2024'],
    ralis: ['ACMA — RALIs to coordinate frequencies', 'https://www.acma.gov.au/ralis-frequency-coordination', 'page as read November 2026'],
    options: ['ACMA — Options for fixed licences', 'https://www.acma.gov.au/options-fixed-licences', 'page as read November 2026'],
    fees: ['ACMA — Fees for apparatus licences', 'https://www.acma.gov.au/fees-apparatus-licences', 'fee schedule of July 2026'],
    lipdPage: ['ACMA — Low interference potential devices (LIPD) class licence', 'https://www.acma.gov.au/licences/low-interference-potential-devices-lipd-class-licence', 'page as read November 2026'],
    rrl: ['ACMA — Register of Radiocommunications Licences', 'https://www.acma.gov.au/register-radiocommunication-licences-rrl', 'new register site from 10 June 2026'],
    data: ['ACMA — Radiocomms licence data (the download Flood-Net reads)', 'https://www.acma.gov.au/radiocomms-licence-data', 'refreshed daily by ACMA; page as read November 2026'],
  };
  const src = (k, part) => `<a class="lic-src" href="${escAttr(SRC[k][1])}" target="_blank" rel="noopener"
      title="${escAttr(`${SRC[k][0]} — ${SRC[k][2]}`)}" aria-label="${escAttr(`Source: ${SRC[k][0]}${part ? `, ${part}` : ''} — in a new tab`)}"
      >${esc(part || 'source')}<span aria-hidden="true"> ↗</span></a>`;

  function guideHtml() {
    const n = D ? { pmp: D.lics.filter(l => l.holder && l.holder.cls === 'bureau' && l.kind === 'pmp').length,
      ptp: D.lics.filter(l => l.holder && l.holder.cls === 'bureau' && l.kind === 'ptp').length } : null;
    const fold = (id, title, html) => `<details class="lic-guide-sec" data-guide="${id}"><summary>${esc(title)}</summary>${html}</details>`;
    return `<details class="lic-guide" id="acmalic-guide" data-tour="acma-guide">
      <summary>Guide — licence types, power, and what a site should hold</summary>
      <p class="filter-note lic-disclaimer"><strong>This is a guide, not legal advice.</strong> It was written in November 2026 from the
        instruments linked beside each point. Rules change and every licence can carry its own conditions: read the licence
        document, and check with ACMA (1300 850 115, info@acma.gov.au) before relying on any of it.</p>
      ${fold('why', 'Why a transmitter needs a licence', `
        <p>Operating a radio transmitter without a licence is an offence (${src('act', 'Act, s 46')}). There are three kinds of
          licence: an <strong>apparatus licence</strong>, issued to one holder for a transmitter at a named site or a system
          round one — the kind the register lists and this tool draws; a <strong>spectrum licence</strong>, a block of
          frequencies over a region, which telemetry at these frequencies does not use; and a <strong>class licence</strong>,
          a standing permission nobody applies for, for low-power devices that keep to its limits.</p>
        <p>A station that only <em>receives</em> needs no licence to do so: a fixed licence “does not authorise the operation of,
          but may refer to, a radiocommunications receiver” (${src('fixed', 'Fixed Licence determination, s 13 note')}).</p>`)}
      ${fold('types', 'The licence types you will meet', `
        <dl class="lic-dl">
          <dt>Fixed — point to multipoint</dt>
          <dd>One base station “at a fixed location specified in the licence”, and remote stations whose “locations … are not
            specified in the licence” (${src('fixed', 's 5(2) and its note')}; the definition is in the ${src('interp', 'Interpretation determination')}).
            ${n ? `${n.pmp} of the Bureau’s licences in this register copy are of this type` : 'Most of the Bureau’s ALERT licences are of this type'} — a repeater
            or base listening for many gauges on one channel. In the register a variant reads <em>Point to Multipoint – Land Mobile
            Spec</em>: the same kind of licence on channels otherwise set aside for land mobile radio.</dd>
          <dt>Fixed — point to point</dt>
          <dd>A link “principally for communication with one other fixed station” (${src('interp', 'Interpretation determination')}).
            Both ends are written on the licence. ${n ? `The Bureau holds ${n.ptp} here` : 'The Bureau holds some'}, mostly links that carry
            data from a repeater or radar site to an office. Where the licence names no antenna, a link in 148–174 MHz must use
            one at least as directional as a 6-element Yagi — 12 dBi, a beam of 44° or less (${src('fixed', 's 11, Table 1')}).</dd>
          <dt>Land mobile (land mobile system)</dt>
          <dd>A base and the vehicles or handhelds that talk to it, “operated principally for two-way communications”
            (${src('interp', 'Interpretation determination')}; conditions in the ${src('lm', 'Land Mobile Licence determination')}).
            It is the licence for a voice network, not for a gauge bolted to a pole: a fixed telemetry station is not a mobile.</dd>
          <dt>Scientific</dt>
          <dd>For research, trials and demonstrations rather than a working service (${src('sci', 'Scientific Licence determination')}).
            A gauge on trial might run under one for a while; a permanent station should not.</dd>
          <dt>Area-wide licence</dt>
          <dd>A licence for an area rather than a site. ACMA issues these at 3.4–4.0 GHz and 26/28 GHz, not in the bands
            ALERT uses, so none appears here (${src('ralis', 'ACMA’s list of RALIs — see MS47')}).</dd>
          <dt>Class licence — low-power devices</dt>
          <dd>Any transmitter on 150.7875–152.49375 MHz may run without an individual licence if it radiates no more than
            <strong>100 mW EIRP</strong> (${src('lipd', 'LIPD class licence, Schedule 1, Table 1, item 17')}; ACMA’s ${src('lipdPage', 'plain-words page')}).
            An ALERT gauge of a watt or more is ten times over that limit, so the class licence does not cover it.</dd>
        </dl>`)}
      ${fold('reach', 'How far a point-to-multipoint licence reaches — the 30 km question', `
        <p><strong>The licence states no distance.</strong> It names the base station’s site and nothing else; the remote stations are
          not listed on it or in the register (${src('fixed', 's 5(2) note')}; ${src('options', 'ACMA’s guidance')}). What the rules
          require is that a remote station talks to that base, on the base’s own frequencies (${src('fixed', 'ss 13, 15(2) and 23(2)')}).</p>
        <p><strong>30 km is ACMA’s planning figure.</strong> In plain words: it is the distance ACMA assumes, not a limit it sets. When ACMA assigns a channel for a point-to-multipoint service it plans on a
          service area of 30 km radius for a high-power system and 2 km for a low-power one, expects every station of the system to
          be inside it, and protects nothing beyond it (${src('fx16', 'RALI FX16')}). So 30 km is the right circle to draw as a first
          look — and this tool draws it — but it is an assumed reach, not a boundary written into the licence. A station beyond it is not unlicensed
          for that reason alone; it is further from its base than ACMA allowed for, so nobody is kept off its channel out there. Change it with
          <em>Assumed reach</em> above.</p>
        <p><strong>Some licences say more.</strong> A special condition can state a service area (one in this register copy reads “a
          service area of 20 km”) or authorise “remote transmitters … within range of the specified site”. Where a figure is given
          the tool draws that instead. A second transmitter added to fill a gap may not be used to stretch the area
          (${src('fixed', 's 14(4)')}).</p>
        <p>For comparison, a land mobile licence defines its service area as 40 km from the base
          (${src('lm', 'Land Mobile Licence determination')}).</p>`)}
      ${fold('power', 'Transmitter power', `
        <ul>
          <li><strong>The named station</strong> — the base, or either end of a link — may run what its licence lists: a
            ${term('txpower', 'transmitter power')} into the antenna and an ${term('eirp', 'EIRP')} out of it. Pick a licence here to see both.</li>
          <li><strong>A remote station</strong> of a point-to-multipoint licence, sending data or telemetry, may transmit for no more than
            2 seconds at a time, no more often than every 10 seconds, for no more than one-thirtieth of the time, and at no more
            than <strong>1 W</strong> into the antenna — 5 W only in 451.5–452.5 MHz and 805.5–806 MHz (${src('fixed', 's 15(3)–(4), Table 2')}).</li>
          <li><strong>A condition written on the licence wins</strong> where it differs from those (${src('fixed', 's 12(2)')}). A gauge that
            runs more than 1 W as a remote station is worth checking against its base’s licence document.</li>
          <li><strong>Channels shared with land mobile</strong> are planned at 83 W EIRP for a high-power system and 8.3 W for a low-power
            one (${src('lm08', 'RALI LM08')}), which is why those two figures recur on licences.</li>
          <li><strong>No licence at all</strong>: 100 mW EIRP on 150.7875–152.49375 MHz (${src('lipd', 'LIPD class licence')}).</li>
        </ul>`)}
      ${fold('site', 'What should be held for a site', `
        <ul>
          <li><strong>A repeater, or a base that transmits</strong>: a licence naming its site — point to multipoint if it serves many
            gauges, point to point if it is one end of a link. It is the “base station at a fixed location specified in the licence”.</li>
          <li><strong>A field gauge</strong>: one of three. It is a remote station of the point-to-multipoint licence of the repeater or
            base it transmits to — on that licence’s channel, inside its service area and within the remote-station limits; or it
            has its own licence at its own site; or it radiates 100 mW EIRP or less and runs under the class licence.</li>
          <li><strong>Protection</strong>: a remote station is covered but not individually protected from interference. ACMA’s guidance is that
            protecting one takes its own point-to-point licence as well (${src('options', 'ACMA’s guidance')}).</li>
          <li><strong>A base that only listens</strong>: nothing is required.</li>
          <li><strong>Who holds it</strong>: the licence belongs to its holder — the Bureau, a council, a water authority. Anybody else
            operating a transmitter under it needs the holder’s written authorisation (${src('act', 'Act, s 114')}), which the holder may
            not give in some cases (${src('auth', 'Authorisations and Transfers determination')}). A council’s gauge on a Bureau channel,
            or the Bureau’s equipment on a council’s licence, is that case.</li>
        </ul>`)}
      ${fold('renew', 'Renewal, expiry and fees', `
        <p>Every licence carries an expiry date; the ones in this register copy are issued a year at a time. An expired licence
          authorises nothing until it is renewed. This tool flags a licence within ${SOON_DAYS} days of expiry and one the register
          shows as no longer in force. Fees are a yearly tax by band, bandwidth, area and power, plus a charge for issue or renewal
          (${src('fees', 'ACMA’s fees page and schedule')}).</p>`)}
      ${fold('read', 'How to read the register', `
        <ul>
          <li><strong>Licence number</strong> — the number and its issue, such as 1463975/1. The licence document link opens ACMA’s own PDF.</li>
          <li><strong>Client</strong> — the holder’s number in ACMA’s books. <strong>Site</strong> — ACMA’s number for a place; its
            position is as accurate as the register says (often “within 10 metres”, sometimes “unknown”).</li>
          <li><strong>Transmits / Receives</strong> — each licence lists its transmitters and the receivers it refers to. For a
            point-to-multipoint licence both are at the base.</li>
          <li><strong>${term('emission', 'Emission')}</strong>, <strong>${term('txpower', 'TX power')}</strong> and <strong>${term('eirp', 'EIRP')}</strong> — what may be sent and how strongly.</li>
          <li><strong>The copy</strong> — Flood-Net reads ACMA’s daily download once a week (${src('data', 'the download')}); the live
            register is at ${src('rrl', 'ACMA’s register')}. A licence changed since the copy shows here as it was.</li>
        </ul>`)}
      <details class="lic-guide-sec" data-guide="sources"><summary>Every source, with its date</summary>
        <ul class="lic-sources">${Object.values(SRC).map(([name, url, when]) => `<li>${out(name, url)} <span class="lic-muted">— ${esc(when)}</span></li>`).join('')}</ul>
      </details>
    </details>`;
  }

  // ── The panel ───────────────────────────────────────────────────────────────

  function holdersHtml() {
    if (!D) return '';
    const byCls = k => D.holders.filter(h => h.cls === k);
    const n = h => D.lics.filter(l => l.holder === h).length;
    const classes = CLASSES.map(([k, label]) => {
      const hs = byCls(k);
      if (!hs.length) return '';
      const total = hs.reduce((t, h) => t + n(h), 0);
      return `<label class="lic-check"><input type="checkbox" ${F.cls[k] !== false ? 'checked' : ''}
          onchange="MapAcma.set('cls:${k}', this.checked)">
          <span class="lic-dot" style="--dot:${classColour(k)}" aria-hidden="true"></span>${esc(label)} <span class="lic-muted">${total}</span></label>`;
    }).join('');
    const each = CLASSES.map(([k, label]) => {
      const hs = byCls(k);
      if (hs.length < 2) return '';
      return `<p class="lic-hit-h">${esc(label)}</p>${hs.map(h => `<label class="lic-check lic-check-sub"
          title="${escAttr(`${h.type}${h.trading && h.trading.toLowerCase() !== h.name.toLowerCase() ? ` · ${h.trading}` : ''} · ACMA client ${h.no}${h.net ? ' · holds a licence on a channel this network uses' : ''}`)}">
          <input type="checkbox" ${!F.off.includes(h.no) ? 'checked' : ''} ${F.cls[k] === false ? 'disabled' : ''}
                 onchange="MapAcma.set('holder:${escAttr(h.no)}', this.checked)">${esc(h.name)} <span class="lic-muted">${n(h)}</span></label>`).join('')}`;
    }).join('');
    return `<div class="lic-checks" id="acmalic-classes">${classes}</div>
      <details class="lic-more" id="acmalic-holders"><summary>Each ${term('holder', 'holder')} — ${D.holders.filter(holderOn).length} of ${D.holders.length} ticked</summary>
        <p class="small txt-muted">Who is in the list: the Bureau; anybody else with a fixed licence on a channel this network’s
          stations use; and councils with a point-to-multipoint licence in 148–174 MHz. Untick one to leave its licences out of
          the map, the search and every verdict.</p>
        ${each}</details>`;
  }

  function showHtml() {
    const nShown = D ? D.lics.filter(shown).length : 0;
    return `<fieldset class="sites-fs" data-tour="acma-show">
        <legend>Licences on the map</legend>
        <label class="lic-check lic-master"><input type="checkbox" id="acmalic-show" ${F.show ? 'checked' : ''}
            onchange="MapAcma.set('show', this.checked)"> Draw the licences and the ${term('area', 'area each covers')}</label>
        ${holdersHtml()}
        <div class="lic-checks">
          <label class="lic-check"><input type="checkbox" ${F.types.pmp !== false ? 'checked' : ''} onchange="MapAcma.set('type:pmp', this.checked)">
            ${term('pmp', 'Point to multipoint')} <span class="lic-muted">circle</span></label>
          <label class="lic-check"><input type="checkbox" ${F.types.ptp !== false ? 'checked' : ''} onchange="MapAcma.set('type:ptp', this.checked)">
            ${term('ptp', 'Point to point')} <span class="lic-muted">line</span></label>
        </div>
        <div class="sites-row lic-selects">
          <label>Status <select id="acmalic-standing" onchange="MapAcma.set('status', this.value)">
            ${[['all', 'Any'], ['current', 'In force'], ['soon', `Expiring within ${SOON_DAYS} days`], ['lapsed', 'Not in force']]
              .map(([v, t]) => `<option value="${v}" ${F.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Band <select id="acmalic-band" onchange="MapAcma.set('band', this.value)">
            ${[['all', 'Any'], ['vhf', '148–174 MHz'], ['uhf', '400–520 MHz']]
              .map(([v, t]) => `<option value="${v}" ${F.band === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label title="${escAttr(meaning('area'))}">Assumed reach <input type="number" id="acmalic-radius" min="1" max="150" step="1" value="${escAttr(String(F.radius))}"
            onchange="MapAcma.set('radius', this.value)"> km</label>
        </div>
        <p class="small txt-muted" id="acmalic-shown">${D ? `${nShown} of ${D.lics.length} licences match${F.show ? ' and are drawn' : ''}. A circle is a point-to-multipoint
          licence’s assumed reach — how far ACMA assumes its stations are from the base — not a legal boundary — the guide below says why.` : ''}</p>
      </fieldset>`;
  }

  function coverHtml() {
    const C = F.cover || (cover && cover.key === coverKey()) ? coverage() : null;
    let inner = '';
    if (C) {
      const c = C.counts, tx = c.site + c.area + c.none;
      const pct = n => (tx ? `${Math.round(100 * n / tx)}%` : '—');
      const rows = noneRows();
      inner = `
        <ul class="lic-counts" id="acmalic-counts">
          ${['site', 'area', 'none'].map(k => `<li data-state="${k}"><span class="lic-dot" style="--dot:${stateColour(k)}" aria-hidden="true"></span>
            <strong>${c[k]}</strong> ${term(k === 'area' ? 'inarea' : k, stateLabel(k))} <span class="lic-muted">${pct(c[k])}</span></li>`).join('')}
          <li data-state="na"><span class="lic-dot" style="--dot:${stateColour('na')}" aria-hidden="true"></span>
            <strong>${c.na}</strong> ${term('na', 'Not a transmitter')}${c.nopos ? ` <span class="lic-muted">+ ${c.nopos} with no position</span>` : ''}</li>
        </ul>
        <p class="small txt-muted">Of ${tx} stations that transmit. Read from the register copy of ${esc(dateText(asAt()))} with a ${F.radius} km
          radius; “none found” is a prompt to look, not a finding that a station is unlicensed.</p>
        <details class="lic-more" id="acmalic-none" ${rows.length && (rows.length <= 40 || noneOwner) ? 'open' : ''}>
          <summary>${rows.length} station${rows.length === 1 ? '' : 's'} with ${term('none', 'none found')}${noneOwner ? ` — ${esc(noneOwner)} only` : ''}</summary>
          <div class="sites-row lic-selects"><label>Sort by <select id="acmalic-none-sort" onchange="MapAcma.set('noneSort', this.value)">
            ${[['gap', 'Furthest from any licence first'], ['near', 'Nearest to a licence first'], ['name', 'Name'], ['owner', 'Owner']]
              .map(([v, t]) => `<option value="${v}" ${noneSort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
          <div class="lic-scroll"><table class="sites-table lic-table" id="acmalic-none-table">
            <thead><tr><th scope="col">Station</th><th scope="col">Owner</th><th scope="col" title="The nearest point-to-multipoint base on its channel, among the ticked holders — the licence that would cover it if its circle reached.">What would cover it</th>
              <th scope="col">${term('gap', 'Gap')}</th></tr></thead>
            <tbody>${rows.slice(0, NONE_CAP).map(a => `<tr class="sites-row-go" onclick="MapAcma.pickStation('${escAttr(a.st.id)}')">
              <td>${esc(a.st.name)}${a.st.station_number ? ` <span class="lic-muted">#${esc(a.st.station_number)}</span>` : ''}</td>
              <td>${esc(ownerText(a.st)) || '<span class="lic-muted">—</span>'}</td>
              <td>${a.nearestPmp ? `${esc(a.nearestPmp.lic.no)} <span class="lic-muted">${esc(holderName(a.nearestPmp.lic))}, ${esc(fmtKm(a.nearestPmp.txKm))} away</span>` : '<span class="lic-muted">none on its channel</span>'}</td>
              <td class="num">${a.nearestPmp ? esc(fmtKm(Math.max(0, a.nearestPmp.gap))) : '—'}</td></tr>`).join('')}</tbody></table></div>
          ${rows.length > NONE_CAP ? `<p class="small txt-muted">The first ${NONE_CAP} of ${rows.length}; the CSV has them all.</p>` : ''}
        </details>
        <details class="lic-more" id="acmalic-none-owners">
          <summary>None found, by owner — where the real gaps are</summary>
          <p class="small txt-muted">A station ${NEAR_MISS_KM} km or less past a circle most likely talks to that base and is only further out than ACMA
            assumes. The ones to look at first are well outside every circle, or have no base on their channel at all. Click an owner to
            list its stations above.</p>
          <div class="lic-scroll"><table class="sites-table lic-table" id="acmalic-none-owner-table">
            <thead><tr><th scope="col">Owner</th><th scope="col">${term('none', 'None found')}</th>
              <th scope="col">${term('nearmiss', 'Just past a circle')}</th><th scope="col">${term('farout', 'Well outside')}</th>
              <th scope="col">${term('nochan', 'No base on its channel')}</th>
              <th scope="col" title="The holder whose point-to-multipoint base is nearest to most of this owner’s none-found stations.">Nearest holder</th></tr></thead>
            <tbody>${noneByOwner().map(o => `<tr class="sites-row-go${noneOwner === o.owner ? ' is-lit' : ''}" onclick="MapAcma.set('noneOwner', ${escAttr(JSON.stringify(o.owner))})">
              <td><button type="button" class="link-btn">${esc(o.owner)}</button></td><td class="num">${o.n}</td><td class="num">${o.near || '—'}</td>
              <td class="num">${o.far || '—'}</td><td class="num">${o.nochan || '—'}</td><td>${esc(o.holder) || '<span class="lic-muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>
          ${noneOwner ? `<p class="small">Listing only <strong>${esc(noneOwner)}</strong> above. <button type="button" class="link-btn" onclick="MapAcma.set('noneOwner', '')">Show every owner</button></p>` : ''}
        </details>
        <details class="lic-more" id="acmalic-owners"><summary>By holder — licences, expiries and the stations under each</summary>
          <div class="lic-scroll"><table class="sites-table lic-table">
            <thead><tr><th scope="col">${term('holder', 'Holder')}</th><th scope="col">Licences</th><th scope="col">${term('pmp', 'PMP')}</th><th scope="col">${term('ptp', 'PTP')}</th>
              <th scope="col">${term('soon', 'Expiring')}</th><th scope="col">${term('lapsed', 'Not in force')}</th>
              <th scope="col" title="Transmitting stations standing at one of its licensed sites.">Stations at its sites</th>
              <th scope="col" title="Transmitting stations inside one of its point-to-multipoint circles, with no licence at their own site.">In its areas</th>
              <th scope="col" title="${escAttr(meaning('under'))}">Licences with no station</th></tr></thead>
            <tbody>${C.holders.map(x => `<tr><td><span class="lic-dot" style="--dot:${classColour(x.h.cls)}" aria-hidden="true"></span>${esc(x.h.name)}</td>
              <td class="num">${x.n}</td><td class="num">${x.pmp}</td><td class="num">${x.ptp}</td><td class="num">${x.soon || '—'}</td>
              <td class="num">${x.lapsed || '—'}</td><td class="num">${x.atSite}</td><td class="num">${x.inArea}</td><td class="num">${x.empty}</td></tr>`).join('')}</tbody></table></div>
          <p class="small txt-muted">A station inside two holders’ circles is counted under each.</p>
        </details>`;
    }
    const soon = D ? counted().filter(l => standing(l) === 'soon').sort((a, b) => daysLeft(a) - daysLeft(b)) : [];
    const lapsed = D ? counted().filter(l => standing(l) === 'lapsed') : [];
    const expiry = D ? `<details class="lic-more" id="acmalic-expiry">
        <summary>${soon.length} ${term('soon', 'expiring soon')}, ${lapsed.length} ${term('lapsed', 'not in force')}</summary>
        ${soon.length || lapsed.length ? `<ul class="lic-exp">${[...lapsed, ...soon].slice(0, 60).map(l => `<li>
            <button type="button" class="link-btn" onclick="MapAcma.pickLicence('${escAttr(l.no)}')">${esc(l.no)}</button>
            ${esc(holderName(l))} — ${standing(l) === 'lapsed' ? `<span class="txt-warn">${esc(/^granted/i.test(l.status) ? 'expired' : l.status.toLowerCase())} ${esc(dateText(l.expiry))}</span>`
              : `expires ${esc(dateText(l.expiry))}, ${daysLeft(l)} days`} <span class="lic-muted">${esc((l.txSites[0] || l.sites[0] || { name: '' }).name)}</span></li>`).join('')}</ul>`
          : `<p class="small txt-muted">Every licence of the ticked holders is in force for more than ${SOON_DAYS} days. The next to expire:
              ${esc((() => { const next = counted().filter(l => daysLeft(l) != null).sort((a, b) => daysLeft(a) - daysLeft(b))[0]; return next ? `${next.no}, ${dateText(next.expiry)}` : '—'; })())}.</p>`}
      </details>` : '';
    return `<fieldset class="sites-fs" data-tour="acma-cover">
        <legend>Which stations are licensed</legend>
        <label class="lic-check lic-master"><input type="checkbox" id="acmalic-cover" ${F.cover ? 'checked' : ''}
            onchange="MapAcma.set('cover', this.checked)"> Ring every transmitting station by its licensing state</label>
        ${inner}
        ${expiry}
        <div class="sites-actions">
          <button type="button" id="acmalic-save" onclick="MapAcma.save()" ${D ? '' : 'disabled'}
                  title="Every transmitting station with its licensing state, the licence it rests on, and the nearest licence and gap where none was found">Save stations CSV</button>
          <button type="button" id="acmalic-save-lic" onclick="MapAcma.saveLicences()" ${D ? '' : 'disabled'}
                  title="Every licence of the ticked holders with its site, frequency, power, expiry, conditions and how many stations stand under it">Save licences CSV</button>
        </div>
      </fieldset>`;
  }

  function panelHtml() {
    if (!state.data) return '<p class="filter-note">No stations are loaded yet.</p>';
    const status = D ? `${D.lics.length} licences of ${D.holders.length} holders, from ${term('register', 'ACMA’s register')} as it stood on ${esc(dateText(asAt()))}.`
      : loadErr ? `<span class="txt-warn">The licence list could not be read (${esc(loadErr)}).</span> <button type="button" class="link-btn" onclick="MapAcma.reload()">Try again</button>`
      : 'Reading the register copy…';
    return `
      <div class="sites-panel bestrep-panel lic-panel">
        <p class="filter-note" id="acmalic-status">${status}</p>
        <fieldset class="sites-fs" data-tour="acma-search">
          <legend>Find a station or a licence</legend>
          <input type="search" id="acmalic-find" class="polar-find" autocomplete="off" spellcheck="false" value="${escAttr(hitQ)}"
                 placeholder="Station, number, ALERT address, licence, holder, site or MHz"
                 aria-label="Find a station or a licence" oninput="MapAcma.setSearch(this.value)">
          <div class="polar-hits" id="acmalic-hits">${hitsHtml()}</div>
          <div class="sites-row">
            <button type="button" onclick="MapAcma.pickSelected()"
                    title="The station whose card is open on the map, or the one selected in the list or picked on the map">Check the selected station</button>
            <button type="button" onclick="MapAcma.clear()" ${F.show || F.cover || picked || hitQ ? '' : 'disabled'}>Clear</button>
          </div>
          ${pickedHtml()}
        </fieldset>
        ${showHtml()}
        ${coverHtml()}
        ${guideHtml()}
        ${glossaryHtml()}
        <p class="filter-note">${esc(CAVEAT)}</p>
      </div>`;
  }

  const CAVEAT = 'Indicative. A weekly copy of ACMA’s public register, matched to stations by position and channel; a '
    + 'point-to-multipoint circle is the reach ACMA assumes, not a legal boundary. Read the licence document and check with ACMA before acting on it. '
    + 'Contains data from the Australian Communications and Media Authority (CC BY 4.0).';

  function render() {
    if (!body) return;
    const active = document.activeElement && body.contains(document.activeElement) ? document.activeElement : null;
    const focusId = active ? active.id : null;
    const caret = active && focusId === 'acmalic-find' ? active.selectionStart : null;
    const open = new Set([...body.querySelectorAll('details[open]')].map(d => d.id || d.dataset.guide).filter(Boolean));
    const top = body.scrollTop;
    body.innerHTML = panelHtml();
    for (const d of body.querySelectorAll('details')) { const k = d.id || d.dataset.guide; if (k && open.has(k)) d.open = true; }
    body.scrollTop = top;
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus({ preventScroll: true }); if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch (_) { /* not a text box */ } }
    }
  }

  function legendHtml() {
    const bits = [];
    if (F.show || (picked && picked.type === 'licence')) {
      bits.push(`ACMA licences — a circle is a point-to-multipoint licence’s ${F.radius} km assumed reach round its base (not a legal
        boundary), a line a point-to-point link between its two ends; ${CLASSES.map(([k, label]) =>
          `<span class="lic-dot" style="--dot:${classColour(k)}" aria-hidden="true"></span>${esc(label)}`).join(' ')};
        dashed where the licence is not in force, amber where it expires within ${SOON_DAYS} days.`);
    }
    if (F.cover) {
      bits.push(`Licensing state — a ring on every transmitting station: ${STATES.slice(0, 3).map(([k, label]) =>
        `<span class="lic-dot" style="--dot:${stateColour(k)}" aria-hidden="true"></span>${esc(label.toLowerCase())}`).join(' ')}.`);
    }
    if (!bits.length) return '';
    return `<span class="legend-item"><span class="legend-site" aria-hidden="true">📜</span>
        <span class="small">${bits.join(' ')}</span></span>`;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    for (const l of [areaLayer, siteLayer, coverLayer]) if (l) l.remove();
    areaLayer = siteLayer = coverLayer = null;
  }

  function tipHtml(ls) {
    return ls.slice(0, 4).map(l => `<strong>${esc(l.no)}</strong> ${esc(holderName(l))}<br>${esc(l.cat)} · ${esc(freqText(l))}`
      + `<br>${standing(l) === 'lapsed' ? 'not in force' : `in force to ${esc(dateText(l.expiry))}`}`).join('<hr>')
      + (ls.length > 4 ? `<hr>+ ${ls.length - 4} more at this site` : '') + '<br><em>click for the licence</em>';
  }

  function drawLicences(ls, heavyNo) {
    const bySite = new Map();
    for (const l of ls) {
      const colour = classColour(l.holder ? l.holder.cls : 'other');
      const st = standing(l), heavy = l.no === heavyNo;
      const stroke = st === 'soon' ? cssVar('--lic-warn', '#f9a825') : colour;
      const dash = st === 'lapsed' ? '6 6' : null;
      if (l.kind === 'pmp') {
        for (const site of l.txSites) {
          L.circle([site.lat, site.lon], { pane: AREA_PANE, radius: radiusOf(l) * 1000, color: stroke, weight: heavy ? 3 : 1,
            opacity: heavy ? 1 : 0.55, dashArray: dash, fillColor: colour, fillOpacity: st === 'lapsed' ? 0.02 : heavy ? 0.16 : 0.06,
            interactive: false }).addTo(areaLayer);
        }
      } else {
        for (const [a, b] of l.links) {
          const pts = [[a.lat, a.lon], [b.lat, b.lon]];
          L.polyline(pts, { pane: AREA_PANE, color: colour, weight: heavy ? 14 : 9, opacity: st === 'lapsed' ? 0.08 : 0.2, lineCap: 'round', interactive: false }).addTo(areaLayer);
          L.polyline(pts, { pane: AREA_PANE, color: stroke, weight: heavy ? 3 : 1.5, opacity: 0.9, dashArray: dash, interactive: false }).addTo(areaLayer);
        }
      }
      for (const site of l.sites) { const at = bySite.get(site) || []; at.push(l); bySite.set(site, at); }
    }
    for (const [site, at] of bySite) {
      const l0 = at[0], heavy = at.some(l => l.no === heavyNo);
      const m = L.circleMarker([site.lat, site.lon], { pane: SITE_PANE, radius: heavy ? 11 : 8, weight: heavy ? 4 : 2.5,
        color: classColour(l0.holder ? l0.holder.cls : 'other'), fillColor: '#fff', fillOpacity: 0.01,
        dashArray: at.every(l => standing(l) === 'lapsed') ? '3 3' : null, bubblingMouseEvents: false });
      m.bindTooltip(() => `<div class="lic-tip"><span class="lic-muted">${esc(site.name)}</span><br>${tipHtml(at)}</div>`, { direction: 'top', sticky: true });
      m.on('click', () => MapAcma.pickLicence((at.find(l => l.no === heavyNo) || l0).no, { stay: true }));
      m.addTo(siteLayer);
    }
  }

  function draw() {
    clearLayers();
    if (!map || !D) return;
    areaLayer = L.layerGroup([], { pane: AREA_PANE }).addTo(map);
    siteLayer = L.layerGroup([], { pane: SITE_PANE }).addTo(map);
    coverLayer = L.layerGroup([], { pane: COVER_PANE }).addTo(map);
    const heavyNo = picked && picked.type === 'licence' ? picked.id : null;
    let ls = F.show ? D.lics.filter(shown) : [];
    // The picked licence, and the licences a picked station rests on, are
    // drawn whether or not the rest are.
    const extra = [];
    if (heavyNo) { const l = D.lics.find(x => x.no === heavyNo); if (l) extra.push(l); }
    let pickedSt = null, pa = null;
    if (picked && picked.type === 'station') {
      pickedSt = stationById(picked.id);
      if (pickedSt && located(pickedSt)) {
        pa = assess(pickedSt);
        const rest = [...pa.site, ...pa.area].map(m => m.lic);
        if (!rest.length && pa.nearestPmp) rest.push(pa.nearestPmp.lic);
        extra.push(...rest.slice(0, 6));
      }
    }
    ls = [...new Set([...ls, ...extra])];
    drawLicences(ls, heavyNo);
    if (F.cover) {
      const C = coverage();
      coverRenderer = coverRenderer || L.canvas({ pane: COVER_PANE });
      for (const a of C.rows) {
        L.circleMarker([Number(a.st.lat), Number(a.st.lon)], { pane: COVER_PANE, renderer: coverRenderer, radius: 9, weight: 3,
          color: stateColour(a.state), opacity: 0.95, fill: false, interactive: false }).addTo(coverLayer);
      }
    }
    if (pickedSt && pa) {
      const here = [Number(pickedSt.lat), Number(pickedSt.lon)];
      L.circleMarker(here, { pane: COVER_PANE, radius: 14, weight: 4, color: stateColour(pa.state), fill: false, interactive: false }).addTo(coverLayer);
      const to = pa.site[0] || pa.area[0] || pa.nearestPmp;
      if (to && to.txSite) {
        L.polyline([here, [to.txSite.lat, to.txSite.lon]], { pane: COVER_PANE, color: stateColour(pa.state), weight: 2,
          dashArray: pa.state === 'none' ? '4 6' : null, interactive: false }).addTo(coverLayer);
      }
    }
  }

  function boundsOf(l) {
    const pts = [];
    for (const site of l.sites) pts.push([site.lat, site.lon]);
    if (l.kind === 'pmp') {
      const R = radiusOf(l);
      for (const site of l.txSites) {
        const dLat = R / 110.574, dLon = R / (111.32 * Math.cos(site.lat * Math.PI / 180));
        pts.push([site.lat - dLat, site.lon - dLon], [site.lat + dLat, site.lon + dLon]);
      }
    }
    return pts.length ? L.latLngBounds(pts) : null;
  }

  function after() {
    savePrefs();
    draw();
    render();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  function openPanel() {
    const wrap = document.querySelector('.mn-mapctl[data-panel="acma"]');
    if (!wrap) return false;
    if (wrap.classList.contains('is-docked')) {
      if (typeof setDockTab === 'function') setDockTab('map-acma');
    } else if (!wrap.classList.contains('is-open') && !(state.mapPanelsPinned && state.mapPanelsPinned.has('acma'))) {
      const btn = wrap.querySelector('.mn-mapctl-btn');
      if (btn) btn.click();
    }
    return true;
  }

  function whenLoaded(fn) {
    ensure().then(() => fn(), () => { render(); repaintCards(); });
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    attach(m) {
      map = m;
      const pane = (name, z, events) => { if (!m.getPane(name)) { const p = m.createPane(name); p.style.zIndex = z; if (!events) p.style.pointerEvents = 'none'; } };
      pane(AREA_PANE, AREA_Z, false);
      pane(SITE_PANE, SITE_Z, true);
      pane(COVER_PANE, COVER_Z, false);
      coverRenderer = null;
      // After ⚖️ Repeater comparison: the last of the tools that read the
      // network rather than change it.
      MapChrome.panel(m, {
        id: 'acma', icon: '📜', dockIcon: Glyphs.rail('acma'), title: 'ACMA licences',
        btnLabel: 'ACMA licences — the radio licences these stations run under, the area each covers, and which stations have one',
        group: 'tools', order: 29,
        html: () => panelHtml(),
        onMount(el) { body = el; },
        live: () => MapAcma.live(),
        clear: () => MapAcma.clear(),
      });
      // The file is small (under 200 KB) and the station cards ask for it
      // too: fetched once the map has settled, at once when something of
      // this tool's is already on.
      const go = () => whenLoaded(() => { draw(); render(); if (typeof rerenderMapLegend === 'function') rerenderMapLegend(); });
      if (D) draw();
      else if (F.show || F.cover || picked) go();
      else setTimeout(() => { if (map === m && !D) go(); }, 1200);
    },

    detach() {
      clearLayers();
      coverRenderer = null;
      body = null;
      map = null;
    },

    // Something of this tool's on the map, for the legend; and for the rail's
    // gold ring.
    active() { return !!D && (F.show || F.cover || !!picked); },
    live() { return F.show || F.cover || !!picked; },
    legendHtml,

    // Reset's half and the panel's Clear: everything off the map, the search
    // emptied. The holders, types and radius stay as set — they are settings.
    clear() {
      F.show = false;
      F.cover = false;
      picked = null;
      hitQ = '';
      after();
    },

    set(key, value) {
      const [k, arg] = String(key).split(':');
      if (k === 'show') F.show = !!value;
      else if (k === 'cover') F.cover = !!value;
      else if (k === 'cls' && F.cls[arg] !== undefined) F.cls[arg] = !!value;
      else if (k === 'holder') { F.off = F.off.filter(n => n !== arg); if (!value) F.off.push(arg); }
      else if (k === 'type' && F.types[arg] !== undefined) F.types[arg] = !!value;
      else if (k === 'status') F.status = ['all', 'current', 'soon', 'lapsed'].includes(value) ? value : 'all';
      else if (k === 'band') F.band = ['all', 'vhf', 'uhf'].includes(value) ? value : 'all';
      else if (k === 'radius') { const n = Math.round(Number(value)); F.radius = n >= 1 && n <= 150 ? n : PLAN_KM; }
      else if (k === 'noneOwner') { noneOwner = noneOwner === String(value || '') ? '' : String(value || ''); render(); return; }
      else if (k === 'noneSort') { noneSort = ['gap', 'near', 'name', 'owner'].includes(value) ? value : 'gap'; render(); return; }
      else return;
      if (!D) { savePrefs(); render(); whenLoaded(() => { after(); repaintCards(); }); return; }
      after();
      if (k === 'radius' || k === 'cls' || k === 'holder') repaintCards();
    },

    setSearch(v) {
      hitQ = String(v || '');
      const paint = () => { const el = document.getElementById('acmalic-hits'); if (el) el.innerHTML = hitsHtml(); };
      paint();
      if (!D) whenLoaded(paint);
    },

    // A station's licensing state in the panel, the licences it rests on drawn.
    pickStation(id, opts) {
      const s = stationById(id);
      if (!s) return;
      whenLoaded(() => {
        picked = { type: 'station', id: s.id };
        hitQ = '';
        after();
        if (map && located(s) && !(opts && opts.stay)) {
          const a = assess(s, { light: true });
          const to = a.site[0] || a.area[0] || a.nearestPmp;
          if (to && to.txSite) map.fitBounds(L.latLngBounds([[Number(s.lat), Number(s.lon)], [to.txSite.lat, to.txSite.lon]]).pad(0.35), { maxZoom: 13 });
          else map.panTo([Number(s.lat), Number(s.lon)]);
          if (typeof mapNote === 'function') mapNote(`${s.name} — ${stateLabel(a.state).toLowerCase()}.`, 6000);
        }
        const el = document.getElementById('acmalic-picked');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      });
    },

    // A licence: zoomed to, drawn heavy, its entries in the panel.
    pickLicence(no, opts) {
      whenLoaded(() => {
        const l = D.lics.find(x => x.no === String(no));
        if (!l) return;
        picked = { type: 'licence', id: l.no };
        hitQ = '';
        coverage();
        after();
        const b = boundsOf(l);
        if (map && b && !(opts && opts.stay)) map.fitBounds(b.pad(0.15), { maxZoom: 13 });
        if (typeof mapNote === 'function') mapNote(`Licence ${l.no} — ${holderName(l)}, ${kindWord(l)}.`, 6000);
        const el = document.getElementById('acmalic-picked');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      });
    },

    pickSelected() {
      const id = typeof selectedStationId === 'function' ? selectedStationId() : null;
      if (id == null) {
        if (typeof mapNote === 'function') mapNote('Select a station first — open its card, pick its row, or click its pin — then press this.', 5000);
        return;
      }
      MapAcma.pickStation(id);
    },

    unpick() { picked = null; after(); },

    // From a station's card: the tool open on that station, the licences on.
    showFor(id) {
      openPanel();
      MapAcma.pickStation(id);
    },
    // From a card's licence number: the tool open on that licence.
    showLicence(no) {
      openPanel();
      MapAcma.pickLicence(no);
    },

    openCard(id) {
      if (typeof showStationCard === 'function') showStationCard(id);
      else if (typeof selectStation === 'function') selectStation(id);
    },

    save() {
      whenLoaded(() => { const t = stationsCsv(); if (t) dlText(`floodnet-acma-licensing-stations-${asAt() || 'undated'}.csv`, t); render(); });
    },
    saveLicences() {
      whenLoaded(() => { const t = licencesCsv(); if (t) dlText(`floodnet-acma-licences-${asAt() || 'undated'}.csv`, t); render(); });
    },

    reload() { loadErr = ''; render(); whenLoaded(() => { draw(); render(); repaintCards(); }); },

    // The station card's section (app.js stationCardHtml and its ask).
    cardHtml,
    cardAsk,
    cardRetry(btn) {
      const el = btn && btn.closest ? btn.closest('[data-mn-lic]') : null;
      if (!el) return;
      loadErr = '';
      paintCard(el.id);
      ensure().then(() => repaintCards(), () => repaintCards());
    },

    // The stations changed under it (an edit, a reload): the coverage answer
    // and the drawing are stale.
    invalidate() { cover = null; if (map && D) { draw(); render(); } },

    // For other modules — the Stations list's column, an export line — and the checks.
    load: ensure,
    loaded() { return !!D; },
    stateOf(s) {
      if (!D || !s) return null;
      const a = assess(s, { light: true });
      const m = a.site[0] || a.area[0] || null;
      return { state: a.state, label: stateLabel(a.state), licence: m ? m.lic.no : null, holder: m ? holderName(m.lic) : null,
        km: m ? m.txKm : null, nearest: a.nearestPmp ? a.nearestPmp.lic.no : null, gapKm: a.nearestPmp ? Math.max(0, a.nearestPmp.gap) : null };
    },
    stateLabel,
    verdict(id) { const s = stationById(id); return s && D ? verdictText(assess(s)) : ''; },
    assess(id) {
      const s = stationById(id);
      if (!s || !D) return null;
      const a = assess(s);
      const brief = m => ({ no: m.lic.no, kind: m.lic.kind, km: m.km, txKm: m.txKm, atSite: m.atSite, inside: m.inside, ok: m.ok, via: m.via ? m.via.id : null });
      return { state: a.state, transmits: a.transmits, chans: a.chans, site: a.site.map(brief), area: a.area.map(brief), off: a.off.map(brief),
        lapsed: a.lapsed.map(brief), near: a.near.map(brief), nearest: a.nearestPmp ? { ...brief(a.nearestPmp), gap: a.nearestPmp.gap, radius: a.nearestPmp.radius } : null };
    },
    counts() { const C = coverage(); return C ? { ...C.counts } : null; },
    summary() {
      if (!D) return null;
      return { asAt: asAt(), licences: D.lics.length, holders: D.holders.map(h => ({ no: h.no, name: h.name, cls: h.cls, on: holderOn(h) })),
        shown: D.lics.filter(shown).length, radius: F.radius, show: F.show, cover: F.cover, picked: picked ? { ...picked } : null,
        soon: counted().filter(l => standing(l) === 'soon').length, lapsed: counted().filter(l => standing(l) === 'lapsed').length };
    },
    licence(no) {
      const l = D && D.lics.find(x => x.no === String(no));
      return l ? { no: l.no, kind: l.kind, cat: l.cat, status: l.status, expiry: l.expiry, holder: holderName(l), cls: l.holder ? l.holder.cls : null,
        f: l.f.slice(), sites: l.sites.map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })), txSites: l.txSites.map(s => s.id),
        links: l.links.map(([a, b]) => [a.id, b.id]), radius: l.kind === 'pmp' ? radiusOf(l) : null, statedKm: l.statedKm, conds: l.conds.slice(),
        standing: standing(l) } : null;
    },
    licences() { return D ? D.lics.map(l => l.no) : []; },
    drawn() {
      const n = g => { let c = 0; if (g) g.eachLayer(() => { c++; }); return c; };
      return { areas: n(areaLayer), sites: n(siteLayer), rings: n(coverLayer) };
    },
    pdfUrl,
    stationsCsv,
    licencesCsv,
    // For a check that stands a register copy of its own in.
    _use(raw) { D = index(raw); loading = Promise.resolve(D); loadErr = ''; cover = null; if (map) { draw(); render(); } repaintCards(); },
  };
})();
if (typeof window !== 'undefined') window.MapAcma = MapAcma;
