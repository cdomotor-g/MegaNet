// worker/acma.js — the ACMA's Register of Radiocommunications Licences, for the
// agent API (worker/api.js): which licences are at a station's site, or at a
// point where one might go.
//
// Asked for by the owner's SoRT scope builder, which gives each site an "ACMA
// licence" row: the licence number when the site already has one that can be
// reused, or a flag that a council's licence has to be transferred to the
// Bureau, or that a new licence and a network assessment are needed. Answered
// in two halves, kept apart because they are different kinds of fact:
//
//   recorded   the licences Flood-Net's register records for the station —
//              repeater.acma_licence and frequencies[].acma_licence — each
//              looked up in the register: its status, licensee and where its
//              transmitters are;
//   register   every licence the register has at a site within radius_m of
//              the station (or the point), grouped by licence and site, each
//              saying whether one of its transmitters is on a frequency the
//              station records — on the same channel, within MATCH_KHZ, which
//              is tools/acma_fetch.py's co-channel rule (its licence
//              suggestions accept up to 12.5 kHz, which takes in the next
//              12.5 kHz channel too).
//
// ── Where the register comes from ────────────────────────────────────────────
// The files the app's map already reads, as public static assets: ACMA's daily
// extract, cut by tools/acma_prefilter.py to the sites within 60 km of a
// Flood-Net repeater, and turned by tools/acma_fetch.py into data/acma-*.json —
// refreshed weekly by .github/workflows/acma-refresh.yml. This module reads one
// of them, data/acma-licensing.json, through the Worker's static-assets binding
// (wrangler.toml's [assets] binding = "ASSETS"), as worker/cameras.js reads its
// catalog: once per isolate, then indexed, so a request does a few hundred
// microseconds of arithmetic.
//
// Why that file and not acma-devices.json, which holds the same transmitters:
// parsing the devices file's 4.6 MB of objects is about 50 ms of CPU, five times
// what a Workers Free request may spend in all. acma-licensing.json is the part
// of it this needs, in columns (built beside it by acma_fetch.py, and held to it
// by test/agent-api.mjs), and parses in a few milliseconds.
//
// Read-only and public-only by construction, like the rest of the API: one GET
// of one file any visitor can download, never a request built from what the
// caller sent. A licensee registered as a private individual is never named.
//
// What the extract cannot say: it is a subset — transmitters only, at sites
// within 60 km of a Flood-Net repeater; of those, every one in 148–174 MHz,
// those whose harmonics could land on a repeater's receive channel, and any
// frequency within 250 m of a repeater — and it is as old as its source_date.
// Nothing here makes an absence into a fact about the register itself.

export const LICENSING_PATH = '/data/acma-licensing.json';
export const REGISTER_NAME = 'ACMA Register of Radiocommunications Licences';
export const REGISTER_URL = 'https://www.acma.gov.au/register-radiocommunication-licences-rrl';
export const MATCH_KHZ = 6.25;
// The ALERT telemetry band, and the band the subset keeps everything in.
export const VHF_HIGH_MHZ = Object.freeze([148, 174]);
// A register older than this is said to be, with what that means.
export const STALE_DAYS = 14;

const BUREAU_RE = /bureau of meteorology/i;

// ── Loading ──────────────────────────────────────────────────────────────────

// Settled values only, never an in-flight promise: a Worker may not finish I/O
// on behalf of another request (the rule worker/api.js's memo keeps). Two cold
// requests at once each read the file; the second's copy replaces the first's.
let HELD = null;

export function licenceBase(no) {
  return String(no == null ? '' : no).split('/')[0].trim();
}

// The document's columns as objects, with each site's and each licence's
// transmitters, and the licences by number and by base number.
export function indexLicensing(body) {
  const meta = (body && body.meta) || {};
  const kinds = Array.isArray(body && body.kinds) ? body.kinds : [];
  const clients = (Array.isArray(body && body.clients) ? body.clients : [])
    .map(([client_no, name, trading_name, type]) => ({ client_no, name: name || null, trading_name: trading_name || null, type: type || null }));
  const licences = (Array.isArray(body && body.licences) ? body.licences : []).map(([number, status, kind, issued, expiry, client]) => {
    const k = kinds[kind] || [];
    return { number: String(number), base: licenceBase(number), status: status || null,
      type: k[0] || null, category: k[1] || null, service: k[2] || null, subservice: k[3] || null,
      issued: issued || null, expiry: expiry || null, client: clients[client] || null, tx: [] };
  });
  const sites = (Array.isArray(body && body.sites) ? body.sites : []).map(([id, name, lat, lon, state, precision]) =>
    ({ id: String(id), name: name || null, lat: Number(lat), lon: Number(lon), state: state || null, precision: precision || null, tx: [] }));
  let transmitters = 0;
  for (const row of Array.isArray(body && body.transmitters) ? body.transmitters : []) {
    const [si, li, f_mhz, bw_khz, emission, tx_w, eirp_w, authorised, count] = row;
    const site = sites[si], licence = licences[li];
    if (!site || !licence || !Number.isFinite(site.lat) || !Number.isFinite(site.lon)) continue;
    const t = { site, licence, f_mhz: num(f_mhz), bw_khz: num(bw_khz), emission: emission || null,
      tx_w: num(tx_w), eirp_w: num(eirp_w), authorised: authorised || null, count: Number(count) || 1 };
    site.tx.push(t);
    licence.tx.push(t);
    transmitters += t.count;
  }
  const byNumber = new Map(licences.map(l => [l.number, l]));
  const byBase = new Map();
  for (const l of licences) {
    if (!byBase.has(l.base)) byBase.set(l.base, []);
    byBase.get(l.base).push(l);
  }
  return { meta, sites: sites.filter(s => s.tx.length), licences, byNumber, byBase, transmitters };
}

// The register, read and indexed the first time this isolate needs it.
// Throws with `unbound` when the binding is missing, so a caller can say so.
export async function acmaRegister(env, origin) {
  if (HELD) return HELD;
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    throw Object.assign(new Error('the static assets binding (ASSETS) is not set'), { unbound: true });
  }
  const res = await env.ASSETS.fetch(new Request(`${origin}${LICENSING_PATH}`, { method: 'GET' }));
  if (!res.ok) throw new Error(`the ACMA register file (${LICENSING_PATH}) answered HTTP ${res.status}`);
  const reg = indexLicensing(await res.json());
  if (!reg.sites.length) throw new Error(`the ACMA register file (${LICENSING_PATH}) holds no sites`);
  HELD = reg;
  return reg;
}

// For the tests: a fresh isolate, as far as this module goes.
export function resetAcma() { HELD = null; }

// ── Small helpers ────────────────────────────────────────────────────────────

function num(v) { return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
const uniq = a => [...new Set(a)];
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function metresBetween(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

const inVhfHigh = f => f != null && f >= VHF_HIGH_MHZ[0] && f <= VHF_HIGH_MHZ[1];

// The station frequencies (MHz) a transmitter at f is within MATCH_KHZ of.
export function matchFrequencies(f, freqs) {
  if (f == null) return [];
  return uniq((freqs || []).filter(g => Math.abs(f - g) * 1000 <= MATCH_KHZ + 1e-9));
}

// Licence numbers in what an editor typed: "1441013", "1441013/1", even two.
export function licenceNumbersIn(text) {
  return uniq((String(text == null ? '' : text).match(/\d{3,10}(?:\/\d{1,3})?/g) || []));
}

// Who holds it, as the register says — and nobody's name if a person does.
// `full` adds the ACMA's client number, for the few licences a station records.
export function licensee(client, full = false) {
  if (!client) return { name: null, trading_name: null, type: null, is_bureau: false };
  if (client.type === 'Person') return { name: null, trading_name: null, type: 'Person', is_bureau: false };
  return {
    name: client.name,
    trading_name: client.trading_name && client.trading_name !== client.name ? client.trading_name : null,
    type: client.type,
    ...(full ? { client_no: client.client_no } : {}),
    is_bureau: BUREAU_RE.test(client.name || '') || BUREAU_RE.test(client.trading_name || ''),
  };
}

const shortName = l => (l.licensee.trading_name || l.licensee.name || (l.licensee.type === 'Person' ? 'a private individual' : 'an unnamed licensee'));

// ── The extract's age and provenance ─────────────────────────────────────────

export function extractInfo(reg, now = Date.now()) {
  const m = reg.meta || {};
  const day = /^\d{4}-\d{2}-\d{2}$/.test(m.source_date || '') ? m.source_date : null;
  const age = day ? Math.max(0, Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / 86400000)) : null;
  const out = { source_date: day, refreshed_at: m.generated || null, age_days: age, stale: age != null && age > STALE_DAYS };
  if (out.stale) {
    out.note = `The register extract is from ${day}, ${age} days ago: a licence granted, renewed, moved or cancelled since then is `
      + `not reflected here. Check the current entry on the ACMA's register (${REGISTER_URL}) before relying on one.`;
  }
  return out;
}

export function subsetWords(reg) {
  const s = (reg.meta && reg.meta.subset) || {};
  const km = s.radius_km ?? 60, m = s.cosite_m ?? 250;
  const band = Array.isArray(s.band_mhz) && s.band_mhz.length === 2 ? s.band_mhz : VHF_HIGH_MHZ;
  return `The register here is a subset of the ACMA's: transmitters only, at sites within ${km} km of a Flood-Net repeater — `
    + `every one in ${band[0]}–${band[1]} MHz, those whose harmonics could land on a repeater's receive channel, and any frequency `
    + `within ${m} m of a repeater. A licence that is not here may still be on the ACMA's register (${REGISTER_URL}).`;
}

export function registerSource(reg) {
  const m = reg.meta || {};
  return {
    name: REGISTER_NAME,
    publisher: 'Australian Communications and Media Authority',
    url: REGISTER_URL,
    licence: 'CC BY 4.0',
    attribution: m.attribution || 'Contains data from the Australian Communications and Media Authority, Register of Radiocommunications Licences (CC BY 4.0).',
    extract: m.source || null,
    source_date: m.source_date || null,
    refreshed_at: m.generated || null,
    file: LICENSING_PATH,
    derived_from: Array.isArray(m.derived_from) ? m.derived_from.map(f => `/${String(f).replace(/^\/+/, '')}`) : [],
    refreshed_by: 'tools/acma_fetch.py, weekly (.github/workflows/acma-refresh.yml)',
    conditions: 'Licensee details must not be used for unsolicited messaging (Spam Act 2003, Do Not Call Register Act 2006).',
  };
}

// ── What is near a point ─────────────────────────────────────────────────────

// Sites within radiusM, nearest first: [{ site, m, bearing }].
export function sitesWithin(reg, lat, lon, radiusM) {
  const dLat = radiusM / 111000 + 0.001;
  const out = [];
  for (const site of reg.sites) {
    if (Math.abs(site.lat - lat) > dLat) continue;
    const m = metresBetween(lat, lon, site.lat, site.lon);
    if (m <= radiusM) out.push({ site, m, bearing: bearing(lat, lon, site.lat, site.lon) });
  }
  return out.sort((a, b) => a.m - b.m || (a.site.id < b.site.id ? -1 : 1));
}

export function nearestSite(reg, lat, lon) {
  let best = null;
  for (const site of reg.sites) {
    const m = metresBetween(lat, lon, site.lat, site.lon);
    if (!best || m < best.m) best = { site, m };
  }
  return best ? siteOut(best.site, best.m, bearing(lat, lon, best.site.lat, best.site.lon)) : null;
}

// A site in full, once: where it is, how precisely, how far and which way.
export function siteOut(site, m, b) {
  return { id: site.id, name: site.name, lat: site.lat, lon: site.lon, state: site.state, precision: site.precision,
    distance_m: Math.round(m), bearing_deg: Math.round(b) % 360, direction: COMPASS[Math.round(b / 22.5) % 16] };
}

function expiryPassed(l, now) {
  return l.expiry ? Date.parse(`${l.expiry}T23:59:59Z`) < now : false;
}

// What the register says of a licence. A licence's type and category are its
// service and subservice in every row of the extract, so they are said once.
function licenceFields(l, now, full = false) {
  return {
    status: l.status,
    service: l.service,
    subservice: l.subservice,
    ...(full ? { issued: l.issued } : {}),
    expiry: l.expiry,
    expiry_passed: expiryPassed(l, now),
    licensee: licensee(l.client, full),
  };
}

// The order a licence is listed in: the station's own, then those on its
// frequencies, the Bureau's, the rest of the ALERT band, then everything else.
const rankOf = r => (r.recorded_by_floodnet ? 0 : r.matches_station_frequency ? 1 : r.licensee.is_bureau ? 2 : r.vhf_high_band ? 3 : 4);

// Every licence at every site in `hits`, one row per licence and site.
export function registerRows(hits, { freqs = [], recordedBases = new Set(), now = Date.now() } = {}) {
  const rows = [];
  for (const h of hits) {
    const byLicence = new Map();
    for (const t of h.site.tx) {
      if (!byLicence.has(t.licence)) byLicence.set(t.licence, []);
      byLicence.get(t.licence).push(t);
    }
    for (const [l, txs] of byLicence) {
      const fs = uniq(txs.map(t => t.f_mhz).filter(f => f != null)).sort((a, b) => a - b);
      const matched = uniq(fs.flatMap(f => matchFrequencies(f, freqs))).sort((a, b) => a - b);
      const powers = txs.map(t => t.tx_w).filter(x => x != null);
      const eirps = txs.map(t => t.eirp_w).filter(x => x != null);
      const dates = txs.map(t => t.authorised).filter(Boolean).sort();
      rows.push({
        licence: l.number,
        ...licenceFields(l, now),
        site: { id: h.site.id, name: h.site.name, distance_m: Math.round(h.m), precision: h.site.precision },
        frequencies_mhz: fs,
        emissions: uniq(txs.map(t => t.emission).filter(Boolean)),
        tx_power_w: powers.length ? Math.max(...powers) : null,
        eirp_w: eirps.length ? Math.max(...eirps) : null,
        authorised: dates[0] || null,
        transmitters: txs.reduce((n, t) => n + t.count, 0),
        vhf_high_band: fs.some(inVhfHigh),
        recorded_by_floodnet: recordedBases.has(l.base),
        matches_station_frequency: freqs.length ? matched.length > 0 : null,
        matched_frequencies_mhz: matched,
      });
    }
  }
  return rows.sort((a, b) => rankOf(a) - rankOf(b) || a.site.distance_m - b.site.distance_m
    || (a.licence < b.licence ? -1 : a.licence > b.licence ? 1 : 0));
}

// The rows a telemetry site's licensing is about, listed unless all=true: the
// station's own, the ones on its frequencies, the Bureau's, and the rest of
// the band ALERT telemetry is in.
export const relevantRow = r => r.recorded_by_floodnet || r.matches_station_frequency === true
  || r.licensee.is_bureau || r.vhf_high_band;

// A licence Flood-Net records, as the register has it: by number, else by its
// base number ("1441013" is "1441013/1" in the register).
export function lookUpLicence(reg, typed) {
  const exact = reg.byNumber.get(typed);
  if (exact) return { licence: exact, by: 'number' };
  const base = reg.byBase.get(licenceBase(typed)) || [];
  if (!base.length) return null;
  // More than one issue of a base number: the granted one, then the latest.
  const pick = base.slice().sort((a, b) => (a.status === 'Granted' ? 0 : 1) - (b.status === 'Granted' ? 0 : 1)
    || String(b.number).localeCompare(String(a.number)))[0];
  return { licence: pick, by: 'base number' };
}

// One recorded licence, looked up: where its transmitters are, from (lat, lon).
// `brief`: its status, licensee and nearest site only — for a relaying
// repeater's licences, which are context rather than the subject.
export function recordedEntry(reg, entry, lat, lon, now = Date.now(), brief = false) {
  const out = { licence: entry.licence, recorded_on: entry.recorded_on, label: entry.label || null,
    rx_mhz: entry.rx_mhz ?? null, tx_mhz: entry.tx_mhz ?? null };
  const hit = lookUpLicence(reg, entry.licence);
  if (!hit) {
    return { ...out, in_register: false,
      detail: 'Not in the register extract Flood-Net holds — a licence for a site outside it, one newer than the extract, or a number recorded wrongly. Check it on the ACMA\'s register.' };
  }
  const l = hit.licence;
  const bySite = new Map();
  for (const t of l.tx) {
    if (!bySite.has(t.site)) bySite.set(t.site, []);
    bySite.get(t.site).push(t.f_mhz);
  }
  const located = lat != null && lon != null;
  const sites = [...bySite.entries()].map(([s, fs]) => {
    const o = { id: s.id, name: s.name, state: s.state, precision: s.precision,
      frequencies_mhz: uniq(fs.filter(f => f != null)).sort((a, b) => a - b) };
    if (located) o.distance_m = Math.round(metresBetween(lat, lon, s.lat, s.lon));
    return o;
  }).sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0) || (a.id < b.id ? -1 : 1));
  if (brief) {
    const f = licenceFields(l, now);
    return { ...out, in_register: true, register_licence: l.number, status: f.status, subservice: f.subservice, expiry: f.expiry,
      expiry_passed: f.expiry_passed, licensee: f.licensee,
      nearest_site: sites[0] ? { id: sites[0].id, name: sites[0].name, distance_m: sites[0].distance_m ?? null } : null };
  }
  return { ...out, in_register: true, register_licence: l.number, matched_by: hit.by, ...licenceFields(l, now, true),
    sites: sites.slice(0, 10), sites_total: sites.length };
}

// ── Plain words ──────────────────────────────────────────────────────────────

const mhz = f => `${Number(f).toFixed(4).replace(/0{1,3}$/, '').replace(/\.$/, '')} MHz`;
const metres = m => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${m} m`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = (items, max = 4) => (items.length <= max ? items.join(', ')
  : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);
const isAre = n => (n === 1 ? 'is' : 'are');

function dateWords(day) {
  if (!day) return 'an undated extract';
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// A few sentences from the parts: `who` the station's name (null for a point).
export function summaryLines({ who, proposed, recorded, register, relayed, extract, radiusM }) {
  const lines = [];
  const when = `the register extract of ${dateWords(extract.source_date)}`;
  if (who && proposed) lines.push(`${who} is proposed, not yet built: the register below is what is licensed where it is meant to go.`);
  if (recorded) {
    const list = recorded.licences || [];
    if (!list.length) {
      lines.push(`Flood-Net records no ACMA licence for ${who}.`);
    } else {
      lines.push(`Flood-Net records ${plural(list.length, 'ACMA licence')} for ${who}: ${listWords(list.map(r =>
        `${r.licence} (${r.recorded_on === 'repeater' ? 'its repeater pair' : (r.label || 'a listed frequency')}${r.rx_mhz != null ? `, ${mhz(r.rx_mhz)}` : ''})`), 6)}.`);
      const found = list.filter(r => r.in_register);
      const missing = list.length - found.length;
      if (found.length) {
        const statuses = uniq(found.map(r => String(r.status || 'of no stated status').toLowerCase()));
        const holders = uniq(found.map(shortName));
        const near = found.map(r => (r.sites && r.sites[0] && r.sites[0].distance_m != null ? r.sites[0].distance_m : null)).filter(x => x != null);
        const lead = found.length === list.length ? (list.length === 1 ? 'It is' : `All ${list.length} are`) : `${found.length} of them ${isAre(found.length)}`;
        lines.push(`${lead} in ${when}, ${statuses.join(' or ')}, held by ${listWords(holders, 3)}`
          + `${near.length ? `, with transmitters as near as ${metres(Math.min(...near))}` : ''}.`);
        const lapsed = found.filter(r => r.expiry_passed).map(r => r.licence);
        if (lapsed.length) lines.push(`${listWords(lapsed, 4)} had an expiry date that has passed since the extract — check whether ${lapsed.length === 1 ? 'it was' : 'they were'} renewed.`);
      }
      if (missing) {
        lines.push(`${missing === list.length ? (list.length === 1 ? 'It is' : 'None of them is') : `${missing} ${isAre(missing)}`} not in ${when}`
          + ' — see recorded.licences for which, and check the ACMA\'s register.');
      }
    }
  }
  if (register.status === 'ok') {
    const c = register.counts;
    let s = `Within ${metres(radiusM)}, ${when} has ${plural(register.licences_total, 'licence')} at ${plural(register.site_count, 'site')}`;
    if (c.matching_frequency != null) {
      s += `; ${c.matching_frequency} ${c.matching_frequency === 1 ? 'is' : 'are'} on a frequency ${who ? 'Flood-Net records for the station' : 'asked about'}`;
    }
    s += `; ${c.vhf_high_band} ${isAre(c.vhf_high_band)} in the VHF high band (${VHF_HIGH_MHZ[0]}–${VHF_HIGH_MHZ[1]} MHz)`;
    s += c.bureau ? `; ${c.bureau} ${isAre(c.bureau)} the Bureau of Meteorology's.` : '; none is the Bureau of Meteorology\'s.';
    lines.push(s);
    const holders = uniq(register.licences
      .map(r => `${shortName(r)}${r.licensee.type && r.licensee.type !== 'Person' ? ` (${r.licensee.type})` : ''}`));
    if (holders.length) {
      lines.push(`The ${plural(register.licences.length, 'licence')} listed ${register.licences.length === 1 ? 'is' : 'are'} held by ${listWords(holders, 5)}.`);
    }
  } else if (register.status === 'not recorded') {
    const n = register.nearest_site;
    lines.push(`In ${when} there is no transmitter within ${metres(radiusM)}`
      + `${n ? `; the nearest registered site is ${n.name || n.id}, ${metres(n.distance_m)} ${n.direction}` : ''}.`);
  }
  if (relayed && relayed.status === 'ok' && relayed.repeaters.length) {
    lines.push(`It is relayed by ${listWords(relayed.repeaters.map(r => `${r.name || r.id} (${r.distance_km} km`
      + `${r.rx_mhz != null ? `, receiving on ${mhz(r.rx_mhz)}` : ''}${r.licences.length ? `, licence ${r.licences.map(x => x.licence).join(', ')}` : ', no licence recorded'})`), 3)}.`);
  }
  if (extract.stale) lines.push(`The register extract is ${extract.age_days} days old; anything licensed or changed since ${dateWords(extract.source_date)} is not in it.`);
  return lines;
}

// `hasFreqs`: whether there was any frequency to match — without one the
// count is null, not zero.
export function registerCounts(rows, hasFreqs) {
  return {
    matching_frequency: hasFreqs ? rows.filter(r => r.matches_station_frequency === true).length : null,
    vhf_high_band: rows.filter(r => r.vhf_high_band).length,
    recorded_by_floodnet: rows.filter(r => r.recorded_by_floodnet).length,
    bureau: rows.filter(r => r.licensee.is_bureau).length,
  };
}
