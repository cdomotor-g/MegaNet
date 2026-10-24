// The Base Stations tab (base-stations.js, 0049): what an administrator sees
// of the base stations that check in, and what the tab sends when they ask
// one of them for something.
//
// The database is stood in for by routes answering the nine functions as the
// real ones answer (tools/check_base_stations.sql holds the real functions to
// the same contract against Postgres): a list of four — one checking in and
// managed, one that only reports, one gone quiet, one that posts but never
// checks in — one station's whole status and its requests, and the team keys.
//
//   * signed out, and signed in without being an administrator, the tab says
//     what it is for and asks the database nothing
//   * the list: each station's state worked out on the database's clock — or,
//     since 0059, the state the database says — what needs a look, a receiver
//     the database found deaf among it, and "not managed" for one that only posts
//   * opening a station asks it for its whole status and starts the fast
//     check-ins; its health, receivers, uplink, software, SSH access, settings,
//     log and requests are drawn from what it sent
//   * every button sends exactly its request — a receiver's key and a
//     confirmation with quotes in them included — and a confirmation said no
//     to sends nothing
//   * the settings form sends the smallest patch that says what changed, and
//     refuses a frequency out of range without sending anything
//   * typing in the form, and the keyboard's place, survive the poll
//   * a station that only reports offers nothing to ask
//   * a queued request can be cancelled; team keys added and taken off
//   * a database without 0049 is told so, rather than shown as an error
//   * the latest RPi ALERT release (GitHub, stood in for too) beside the
//     station's version, in the list and the panel, asked for once
//   * a last update run that found nothing says when, not the release it saw
//   * what an open station's radios hear (0068): one waterfall for its sticks,
//     a stick's span and channels in its colour, the bursts it heard in words,
//     a tip under the pointer, the window's buttons, and a poll asking for the
//     last few minutes rather than the hour
//
// Run:  npm run basestations
//       npm run basestations -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { answer } from './lib/ask.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const WAIT = 10_000;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

// ── What the database holds ───────────────────────────────────────────────────

// The database's clock runs ten minutes ahead of the browser's here, which is
// the case the tab works its ages out on the database's clock for: on the
// browser's, the station that checked in 20 s ago would be "in the future".
const SKEW = 10 * 60_000;
const dbNow = () => Date.now() + SKEW;
const ago = s => new Date(dbNow() - s * 1000).toISOString();

// A receiver key with both kinds of quote in it: nothing a real one has, and
// exactly what would break a key carried as a JS string inside an attribute.
const ODD_KEY = 'sdr:it\'s "2"';
const STICK_1 = 'sdr:00000001';

const CONFIG = {
  version: 1, name: 'Mt Stuart base',
  meganet: { enabled: true, receptions: true, tokenSet: true, autoRequest: false },
  location: { source: 'station', lat: -19.35, lon: 146.78, accuracy_m: null, station: '533000', stationName: 'Mt Stuart', useGps: true },
  receivers: {
    autoDetect: true, ports: [], extraPorts: [],
    sdr: { enabled: true, freqHz: 151500000, sampleRate: 0, offsetHz: 0, gainDb: 29.7, ppm: 0, format: 'BINARY', biasTee: false,
      gate: true, squelchDb: 8, minVotes: 4, minVotesCrc: 4 },
    sdrDevices: [{ key: ODD_KEY, name: 'Second stick', freqHz: 160250000, ppm: 3 }],
  },
  audio: { enabled: true, mode: 'auto', device: 'default', volume: 80 },
  web: { port: 80, passwordSet: true },
  kiosk: { mode: 'auto' },
  system: { timezone: 'Australia/Brisbane' },
  remote: { mode: 'manage', idleS: 60 },
};

const STATUS = {
  name: 'Mt Stuart base',
  host: { hostname: 'mt-stuart', model: 'Model B Rev 1.5', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'arm64',
    node: 'v20.18.0', cores: 4, mem_mb: 3796, disk_mb: 29000, addresses: [{ iface: 'eth0', address: '192.168.1.40' }] },
  clock: { trusted: true, source: 'ntp', timezone: 'Australia/Brisbane' },
  location: { source: 'station', lat: -19.35, lon: 146.78, accuracy_m: null, station: '533000' },
  meganet: { enabled: true, receptions: true, label: 'Mt Stuart base', endpoint: 'https://floodwarning.net/api/db/rest/v1',
    token_refused: false, error: null, rx_error: null, report_error: null },
  receivers: [
    { key: STICK_1, name: 'RTL-SDR 1', kind: 'sdr', state: 'running', protocol: 'ALERT', error: null, point: 'rx-1', enabled: true,
      freq_hz: 151500000, format: 'BINARY', gain_db: 29.7, ppm: 0, squelch_db: 8, bias_tee: false, sample_rate: 960000,
      model: 'RTL-SDR Blog V4', serial: '00000001', usb_port: '1-1.3', own: false,
      // One stick, two channels (the station's moreChannels).
      channels: [{ freq_hz: 151500000, format: 'BINARY', in_band: true, decoded: 410, point: 'rx-1' },
                 { freq_hz: 151625000, format: 'ENHANCED_IFLOWS', in_band: true, decoded: 2, point: 'rx-1-151.625' }] },
    { key: ODD_KEY, name: 'Second stick', kind: 'sdr', state: 'error', protocol: 'ALERT', error: 'usb_claim_interface error -6', point: 'rx-2',
      enabled: true, freq_hz: 160250000, format: 'BINARY', gain_db: 29.7, ppm: 3, squelch_db: 8, bias_tee: false, sample_rate: 960000,
      model: 'RTL-SDR Blog V3', serial: '00000002', usb_port: '1-1.4', own: true },
    { key: 'ert:usb-FTDI_A10K', name: 'ERT-A2', kind: 'ert-a2', state: 'unplugged', protocol: 'ALERT2', error: null, point: 'rx-3',
      port: '/dev/serial/by-id/usb-FTDI_A10K-if00-port0', baud: 115200, how: 'auto', firmware: '2.1', battery_pct: null },
  ],
  kiosk: { mode: 'auto', running: true, display: true },
  audio: { mode: 'auto', device: 'default' },
  update: { available: true, auto: false, running: false,
    last: { state: 'ok', from: '0.5.2', to: '0.6.0', startedAt: Math.round(dbNow() / 1000) - 86400, at: Math.round(dbNow() / 1000) - 86340, message: 'Version 0.6.0 installed.' } },
  access: {
    available: true,
    account: { name: 'alert', exists: true, password: 'none', sudo: true, keys: 2 },
    ssh: { enabled: true, active: true, passwordLogin: true, keys: true, port: 22, managed: true },
    policy: { meganetKeys: true, github: ['jo-bloggs'], from: 'private', passwordLogin: 'unchanged' },
    logins: [{ user: 'pi', password: 'set', keys: 0 }, { user: 'alert', password: 'none', keys: 2 }],
    keys: [
      { fingerprint: 'SHA256:VeBIQNSQYe0Ge+JIoXnjKbfB0gSWAJChLuItuhNNFew', type: 'ssh-ed25519', comment: 'jo@laptop', source: 'local', restricted: false },
      { fingerprint: 'SHA256:RknIRqux7NWt85Wr0wnUI0GZOtVaVIIGAxKdQwI8OEU', type: 'ecdsa-sha2-nistp256', comment: 'Sam Field', source: 'meganet', restricted: true },
    ],
    last_sync: { at: ago(600), ok: true, notes: [] },
  },
  remote: { mode: 'manage', idle_s: 60 },
  config: CONFIG,
};

const BEAT = {
  up: 400000, agent_up: 3600, temp: 58.4, load: 0.42, mem_free: 2900, disk_free: 21000,
  uv: false, uv_boot: true, throttled: false, clock: true,
  q: 3, hold: 0, rxq: 12, stored: 18233, refused: 2, last_ok: ago(20), readings: 18240,
  rx: [[STICK_1, 'running', 412, 15], [ODD_KEY, 'error', 0, null], ['ert:usb-FTDI_A10K', 'unplugged', 0, null]],
};

const row = (o) => Object.assign({
  host_station_id: null, host_station: null, created_at: ago(86400 * 30), last_used_at: ago(30), revoked_at: null,
  managed: true, app: 'base station agent', version: '0.6.0', mode: 'manage', idle_s: 60, first_seen_at: ago(86400 * 20),
  last_seen_at: ago(20), checkins: 28000, status_at: ago(300), access: null, beat_at: ago(20), watch_until: null,
  keys_hash: 'h1', waiting: 0, receivers: [],
}, o);

const { config: _c, access: _a, ...LIST_STATUS } = STATUS;
const db = {
  keysHash: 'h1',
  stations: [
    row({ id: 11, label: 'Mt Stuart base', host_station_id: '533000', host_station: 'Mt Stuart', status: LIST_STATUS, beat: BEAT,
      access: { available: true, meganet_keys: true, keys: 2, ssh: true }, state: 'online',
      // 0059: its first stick runs, and has decoded nothing for seven hours.
      findings: [{ id: 501, kind: 'receiver-deaf', rx_key: STICK_1.slice(-80), severity: 'warn',
        title: 'Mt Stuart base — North stick: nothing decoded for 7 h', detail: 'It is running…',
        evidence: { name: 'North stick', state: 'running', decoded: 412, changed_at: ago(7 * 3600) },
        first_seen: ago(3600), last_seen: ago(60) }] }),
    row({ id: 12, label: 'Hut reporter', mode: 'report', last_seen_at: ago(70), status: { name: 'Hut reporter', receivers: [] },
      beat: { up: 1000, temp: 41, uv: false, uv_boot: false, clock: true, q: 0, hold: 0, rx: [] } }),
    row({ id: 14, label: 'Creek gauge base', last_seen_at: ago(3 * 3600), status: { name: 'Creek gauge base', receivers: [] },
      beat: { up: 1000, temp: 77, uv: true, clock: false, q: 900, hold: 4, rx: [] } }),
    row({ id: 13, label: 'Serial laptop', managed: false, app: null, version: null, mode: null, idle_s: null, first_seen_at: null,
      last_seen_at: null, checkins: null, status: null, status_at: null, beat: null, beat_at: null, keys_hash: null,
      last_used_at: ago(300), receivers: [{ point_id: 'sm-1', name: 'Quansheng radio', receiver: 'quansheng', last_seen_at: ago(300) }] }),
  ],
  commands: [
    { id: 104, verb: 'update.install', args: {}, status: 'failed', created_at: ago(7200), created_by: 'admin@example.test',
      expires_at: ago(6600), sent_at: ago(7190), done_at: ago(7180), result: null, error: 'no published release found (or no internet)' },
    { id: 103, verb: 'reboot', args: {}, status: 'queued', created_at: ago(5), created_by: 'admin@example.test',
      expires_at: new Date(dbNow() + 595_000).toISOString(), sent_at: null, done_at: null, result: null, error: null },
    { id: 102, verb: 'config.set', args: { patch: { audio: { volume: 60 } } }, status: 'done', created_at: ago(3600), created_by: 'admin@example.test',
      expires_at: ago(3000), sent_at: ago(3590), done_at: ago(3589), result: { changed: ['audio.volume'] }, error: null },
    { id: 101, verb: 'log', args: { lines: 200 }, status: 'done', created_at: ago(4000), created_by: 'admin@example.test',
      expires_at: ago(3400), sent_at: ago(3990), done_at: ago(3989),
      result: { lines: [{ t: dbNow() - 4e6, level: 'info', tag: 'agent', msg: 'agent 0.6.0 started' },
                        { t: dbNow() - 4e6 + 1000, level: 'warn', tag: 'sdr', msg: 'Second stick: usb_claim_interface error -6' }] }, error: null },
  ],
  keys: [
    { id: 5, key_type: 'ssh-ed25519', fingerprint: 'SHA256:VeBIQNSQYe0Ge+JIoXnjKbfB0gSWAJChLuItuhNNFew', owner: 'Jo Bloggs', comment: 'jo@laptop',
      added_at: ago(86400 * 40), added_by: 'admin@example.test', removed_at: null, removed_by: null },
    { id: 4, key_type: 'ssh-ed25519', fingerprint: 'SHA256:ST5vehZy5UfLDnjvsU9mbYVfaSPQlCgvu9WdYYqm760', owner: 'Former Staff', comment: null,
      added_at: ago(86400 * 80), added_by: 'admin@example.test', removed_at: ago(86400 * 10), removed_by: 'admin@example.test' },
  ],
};

// What station 11's first stick sent (0068): a row a minute for the last
// hour, 64 bins over 151.22–152.18 MHz, its floor and a carrier on 151.5000;
// and the bursts it heard — two a minute on 151.5000, both decoded, and one
// every five minutes on 151.6250 that did not decode.
const WF_BUCKET = 10, WF_LO = 151.22e6, WF_RATE = 960000;
const wfRows = [], wfBursts = [];
{
  const top = Math.floor(dbNow() / 1000 / WF_BUCKET) * WF_BUCKET;
  for (let m = 0; m < 60; m++) {
    const t = top - m * 60, bins = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bins[i] = (i * 7 + m * 3) % 7;
    bins[Math.floor((151.5e6 - WF_LO) / WF_RATE * 64)] = 60;
    wfRows.push({ t, key: STICK_1, center_hz: WF_LO + WF_RATE / 2, rate: WF_RATE, floor_db: -45.5, span_s: 60, n: 1, bins: Buffer.from(bins).toString('base64') });
    wfBursts.push([t, 151.5, 2, 2, 0, 24.5]);
    if (m % 5 === 0) wfBursts.push([t, 151.625, 1, 0, 0, 8.1]);
  }
}

// What station 11 heard over a week, channel by channel (0081), modelled on
// what 18 Bateson heard in October 2026 and moved to Mt Stuart: a busy ALERT
// channel the register expects, with an ALERT2 network beside it and IDs that
// are the register's stations 2,200 km away; an ALERT2 link whose bursts the
// legacy decoder also tries; a council's channel the register lacks but the
// ACMA licenses; and a frequency nobody is licensed for. Then the register's
// pairs around it, one 400 km off (beyond the panel's 250).
const CH_LAST = ago(120);
const chDaysOf = (n, ok) => Array.from({ length: 7 }, (_, i) => [new Date(dbNow() - (6 - i) * 86400_000).toISOString().slice(0, 10), Math.round(n / 7), Math.round(ok / 7)]);
const chan = o => Object.assign({ undecoded: 0, snr: 11.0, snr_max: 20, first: ago(6 * 86400), last: CH_LAST, buckets: 100, points: ['rx-1'],
  ids: { any: 0, counted: 0, near: 0, far: 0, unknown: 0, near_ok: 0, far_ok: 0, unknown_ok: 0 }, top: [], far: [], unknown: [], days: [] }, o);
const CHANNELS = {
  days: 7, by: 'hour', far_km: 400, min_decodes: 3, site: { lat: -19.35, lon: 146.78 },
  channels: [
    chan({ f: 151.335, protocol: 'alert', n: 14, ok: 12, snr: 9.1, ids: { any: 2, counted: 2, near: 0, far: 0, unknown: 2, near_ok: 0, far_ok: 0, unknown_ok: 12 },
      top: [[777, 9, 9, CH_LAST, null, null, null, null, 0], [778, 3, 3, CH_LAST, null, null, null, null, 0]], unknown: [[777, 9, 9, CH_LAST], [778, 3, 3, CH_LAST]],
      days: chDaysOf(14, 12).slice(-1) }),
    chan({ f: 151.5, protocol: 'alert', n: 4000, ok: 3500, undecoded: 400, snr: 12.1, ids: { any: 120, counted: 90, near: 80, far: 3, unknown: 7, near_ok: 3000, far_ok: 400, unknown_ok: 100 },
      top: [[2001, 900, 950, CH_LAST, 'mt_stuart_al', 'Mt Stuart AL', null, 1, 1],
            [4846, 300, 310, CH_LAST, 'wonnangatta_river_at_crooked_river', 'Wonnangatta River at Crooked River', null, 2200, 1],
            [2002, 250, 260, CH_LAST, 'paluma_al', 'Paluma AL', null, 60, 1]],
      far: [[4846, 300, 310, CH_LAST, 'wonnangatta_river_at_crooked_river', 'Wonnangatta River at Crooked River', null, 2200, 1]],
      unknown: [[357, 19, 23, CH_LAST]], days: chDaysOf(4000, 3500) }),
    chan({ f: 151.5, protocol: 'alert2', n: 640, ok: 600, ids: { any: 5, counted: 4, near: 0, far: 0, unknown: 4, near_ok: 0, far_ok: 0, unknown_ok: 600 },
      top: [[62726, 300, 300, CH_LAST, null, null, null, null, 0]], unknown: [[62726, 300, 300, CH_LAST]], days: chDaysOf(640, 600) }),
    chan({ f: 151.5375, protocol: 'alert', n: 1131, ok: 96, undecoded: 1034, points: ['rx-1-151.5375'], ids: { any: 49, counted: 10, near: 7, far: 0, unknown: 3, near_ok: 70, far_ok: 0, unknown_ok: 26 },
      top: [[2003, 8, 8, CH_LAST, 'mt_stuart_al', 'Mt Stuart AL', null, 1, 1]], days: chDaysOf(1131, 96) }),
    chan({ f: 151.5375, protocol: 'alert2', n: 266823, ok: 265691, snr: 18.9, points: ['rx-1-151.5375'], ids: { any: 27, counted: 27, near: 0, far: 0, unknown: 27, near_ok: 0, far_ok: 0, unknown_ok: 265691 },
      top: [[11762, 118367, 118367, CH_LAST, null, null, null, null, 0], [33300, 110768, 110768, CH_LAST, null, null, null, null, 0]], days: chDaysOf(266823, 265691) }),
    chan({ f: 151.575, protocol: 'alert', n: 1041, ok: 918, undecoded: 18, snr: 10.4, points: ['rx-2'], ids: { any: 69, counted: 43, near: 30, far: 1, unknown: 12, near_ok: 284, far_ok: 19, unknown_ok: 615 },
      top: [[1782, 302, 313, CH_LAST, null, null, null, null, 0], [1707, 21, 21, CH_LAST, 'kelso_al', 'Kelso AL', null, 8, 1]], days: chDaysOf(1041, 918) }),
  ],
  register: [
    { f: 151.5, dir: 'rx', kind: 'repeater', station_id: 'mt_stuart_al', name: 'Mt Stuart AL', owner: null, label: null, licence: '433892', km: 1 },
    { f: 151.5, dir: 'tx', kind: 'repeater', station_id: 'mt_stuart_al', name: 'Mt Stuart AL', owner: null, label: null, licence: '433892', km: 1 },
    { f: 151.5375, dir: 'tx', kind: 'listed', station_id: 'mt_stuart_al', name: 'Mt Stuart AL', owner: null, label: 'Link to the coast', licence: null, km: 1 },
    { f: 151.95, dir: 'tx', kind: 'repeater', station_id: 'far_rptr', name: 'Far Repeater', owner: null, label: null, licence: null, km: 400 },
    { f: 152.4, dir: 'tx', kind: 'repeater', station_id: 'paluma_al', name: 'Paluma AL', owner: null, label: null, licence: '433892/1', km: 60 },
  ],
};
// The ACMA's licences around Mt Stuart, as data/acma-*.json hold them: the
// Bureau's on 151.5 and 152.4 there, a council's 151.575 at Kelso, Defence's
// 151.2125 nearby, and one 220 km off (beyond the panel's 100).
const ACMA_SITES = { meta: { source_date: '2026-07-23' }, sites: [
  { id: 's1', name: 'Met Tower Mt Stuart', lat: -19.348, lon: 146.78 },
  { id: 's2', name: 'Broadcast Site Kelso', lat: -19.39, lon: 146.72 },
  { id: 's3', name: 'Lavarack Barracks', lat: -19.33, lon: 146.75 },
  { id: 's4', name: 'Far Hill', lat: -20.5, lon: 148.5 } ] };
const ACMA_DEVICES = { meta: { source_date: '2026-07-23' }, antennas: {}, texts: [],
  devices: [
    { id: 'd1', site_id: 's1', lic: 'L1', f_mhz: 151.5, emission: '7K50F2D' },
    { id: 'd2', site_id: 's1', lic: 'L2', f_mhz: 152.4, emission: '7K50F2D' },
    { id: 'd3', site_id: 's2', lic: 'L3', f_mhz: 151.575, emission: '10K1F2D' },
    { id: 'd4', site_id: 's3', lic: 'L4', f_mhz: 151.2125, emission: '10K1F9W' },
    { id: 'd5', site_id: 's4', lic: 'L1', f_mhz: 151.95, emission: '7K50F2D' } ],
  licences: { L1: { client_no: 'c1', status: 'Granted' }, L2: { client_no: 'c1', status: 'Granted' }, L3: { client_no: 'c2', status: 'Granted' }, L4: { client_no: 'c3', status: 'Granted' } },
  clients: { c1: { name: 'BUREAU OF METEOROLOGY' }, c2: { name: 'TOWNSVILLE CITY COUNCIL' }, c3: { name: 'Department of Defence' } } };

const calls = [];        // every call: { fn, args }
const sent = fn => calls.filter(c => c.fn === fn).map(c => c.args);
let missing = false;     // answer as a database without 0049
let fail = null;         // { fn, status, body } — the next call to fn fails so

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const FNS = {
  admin_base_stations: () => ({ now: new Date(dbNow()).toISOString(), keys_hash: db.keysHash, stations: db.stations }),
  admin_base_station: a => {
    const s = db.stations.find(x => x.id === a.p_id);
    if (!s) return [400, { code: '22023', message: 'no ingest token ' + a.p_id }];
    return { now: new Date(dbNow()).toISOString(), keys_hash: db.keysHash,
      station: Object.assign({}, s, s.id === 11 ? { status: STATUS, want_status: false } : {}), commands: s.id === 11 ? db.commands : [] };
  },
  admin_base_station_watch: a => ({ id: a.p_id, watch_until: new Date(dbNow() + 180_000).toISOString(), want_status: !!a.p_status }),
  admin_base_station_command: a => {
    const id = 200 + calls.length;
    db.commands.unshift({ id, verb: a.p_verb, args: a.p_args, status: 'queued', created_at: ago(0), created_by: 'admin@example.test',
      expires_at: new Date(dbNow() + 600_000).toISOString(), sent_at: null, done_at: null, result: null, error: null });
    return { id, verb: a.p_verb, args: a.p_args, status: 'queued' };
  },
  admin_base_station_cancel: a => {
    const c = db.commands.find(x => x.id === a.p_command_id);
    c.status = 'cancelled';
    return { id: c.id, status: 'cancelled' };
  },
  admin_base_station_keys: () => ({ hash: db.keysHash, keys: db.keys }),
  admin_base_station_spectrum: a => {
    const bucket = a.p_hours * 10, nowS = dbNow() / 1000;
    let from = nowS - a.p_hours * 3600;
    if (a.p_since && Date.parse(a.p_since) / 1000 > from) from = Math.floor(Date.parse(a.p_since) / 1000 / bucket) * bucket;
    const mine = a.p_id === 11;
    return { now: new Date(dbNow()).toISOString(), hours: a.p_hours, bucket_s: bucket, from: new Date(from * 1000).toISOString(),
      rows: mine ? wfRows.filter(r => r.t >= from).map(r => Object.assign({}, r, { t: Math.floor(r.t / bucket) * bucket })) : [],
      bursts: mine ? wfBursts.filter(b => b[0] >= from).map(b => [Math.floor(b[0] / bucket) * bucket].concat(b.slice(1))) : [] };
  },
  admin_base_station_channels: a => Object.assign({ now: new Date(dbNow()).toISOString(), from: ago(a.p_days * 86400), to: ago(600) },
    a.p_id === 11 ? CHANNELS : { site: null, channels: [], register: [] }, { days: a.p_days, by: a.p_days <= 14 ? 'hour' : 'day' }),
  admin_base_station_key_add: a => {
    db.keys.unshift({ id: 6, key_type: 'ssh-ed25519', fingerprint: 'SHA256:newkeynewkeynewkeynewkeynewkeynewkeynewkeyA', owner: a.p_owner,
      comment: 'sam@desk', added_at: ago(0), added_by: 'admin@example.test', removed_at: null, removed_by: null });
    db.keysHash = 'h2';
    return { id: 6, fingerprint: db.keys[0].fingerprint, key_type: 'ssh-ed25519', owner: a.p_owner, hash: 'h2' };
  },
  admin_base_station_key_remove: a => {
    const k = db.keys.find(x => x.id === a.p_id);
    Object.assign(k, { removed_at: ago(0), removed_by: 'admin@example.test' });
    db.keysHash = 'h3';
    return { id: k.id, fingerprint: k.fingerprint, owner: k.owner, removed_at: k.removed_at, hash: 'h3' };
  },
};

// ── The page ──────────────────────────────────────────────────────────────────

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const until = async (fn, name, timeout = WAIT) => {
  const t0 = Date.now();
  let last = false;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); } catch (_) { last = false; }
    if (last) break;
    await new Promise(r => setTimeout(r, 100));
  }
  ok(name, !!last);
  return !!last;
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await page.route('**/rest/v1/rpc/*base_station*', route => {
    const fn = new URL(route.request().url()).pathname.split('/').pop();
    const args = JSON.parse(route.request().postData() || '{}');
    calls.push({ fn, args });
    if (missing) return json(route, { code: 'PGRST202', message: 'Could not find the function meganet.' + fn }, 404);
    if (fail && fail.fn === fn) { const f = fail; fail = null; return json(route, f.body, f.status); }
    const h = FNS[fn];
    if (!h) return json(route, { message: 'no such function ' + fn }, 404);
    const out = h(args);
    return Array.isArray(out) ? json(route, out[1], out[0]) : json(route, out);
  });
  // GitHub's latest RPi ALERT release, a step ahead of the station's 0.6.0.
  let releaseAsks = 0;
  await page.route('https://api.github.com/repos/cdomotor-g/RPi_ALERT/releases/latest', route => {
    releaseAsks++;
    return json(route, { tag_name: 'v0.7.0', html_url: 'https://github.com/cdomotor-g/RPi_ALERT/releases/tag/v0.7.0' });
  });
  // The ACMA's files, small: the panel reads licences near the station from them.
  const ACMA_FILES = { 'acma-threats.json': { meta: { source_date: '2026-07-23' }, anchors: [] }, 'acma-sites.json': ACMA_SITES,
    'acma-dictionaries.json': {}, 'acma-devices.json': ACMA_DEVICES };
  await page.route('**/data/acma-*.json', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    return ACMA_FILES[name] ? json(route, ACMA_FILES[name]) : route.fulfill({ status: 404, body: '' });
  });
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // As it reads: innerText, so a <dt> and its <dd> are two lines, not one word.
  const text = sel => page.evaluate(s => (document.querySelector(s) || {}).innerText || '', sel);

  // ── The pure parts ───────────────────────────────────────────────────────────
  const pure = await page.evaluate(([cfg, stick1, odd]) => {
    const B = BaseStations;
    const t = s => new Date(Date.now() - s * 1000).toISOString();
    const rx = [{ key: stick1, kind: 'sdr', name: 'RTL-SDR 1' }, { key: odd, kind: 'sdr', name: 'Second stick' }];
    const f = B._formFrom(cfg, rx);
    const same = B._patchFrom(cfg, f, rx);
    const g = JSON.parse(JSON.stringify(f));
    g.name = 'Mt Stuart'; g.freq = '151.6250'; g.gain = 'auto';
    g['s:' + stick1] = { name: 'North stick', freq: '', format: '', gain: '', on: true };
    g['s:' + odd] = Object.assign({}, g['s:' + odd], { freq: '', rate: '240000' });
    const changed = B._patchFrom(cfg, g, rx);
    const bad = B._patchFrom(cfg, Object.assign({}, f, { freq: '2000' }), rx);
    // A stick still held by an RPi ALERT 0.4 entry by its serial (its −19 ppm with it).
    const old = JSON.parse(JSON.stringify(cfg));
    old.receivers.sdrDevices = [{ serial: '00000001', ppm: -19, gainDb: 40 }].concat(old.receivers.sdrDevices);
    const rx4 = [{ key: stick1, kind: 'sdr', name: 'RTL-SDR 1', serial: '00000001' }, { key: odd, kind: 'sdr', name: 'Second stick' }];
    const f4 = B._formFrom(old, rx4);
    const g4 = JSON.parse(JSON.stringify(f4));
    g4['s:' + stick1] = Object.assign({}, g4['s:' + stick1], { name: 'North stick' });
    const serialSame = B._patchFrom(old, f4, rx4), serialRenamed = B._patchFrom(old, g4, rx4);
    return {
      serialShown: f4['s:' + stick1].gain, serialSame, serialRenamed,
      liveness: [
        B._liveness({ managed: true, mode: 'manage', idle_s: 60, last_seen_at: t(20) }).k,
        B._liveness({ managed: true, mode: 'manage', idle_s: 60, last_seen_at: t(600) }).k,
        B._liveness({ managed: true, mode: 'manage', idle_s: 60, last_seen_at: t(7200) }).k,
        B._liveness({ managed: true, mode: 'off', last_seen_at: t(20) }).k,
        B._liveness({ managed: false }).k,
        // A station that checks in every 15 minutes is not quiet at 20 of them.
        B._liveness({ managed: true, mode: 'manage', idle_s: 900, last_seen_at: t(1200) }).k,
      ],
      // The database's word (0059) over this tab's own reckoning.
      told: [
        B._liveness({ managed: true, mode: 'manage', idle_s: 60, last_seen_at: t(20), state: 'quiet' }).k,
        B._liveness({ managed: true, mode: 'manage', idle_s: 60, last_seen_at: t(7200), state: 'online' }).k,
        B._liveness({ managed: false, state: 'unmanaged' }).k,
      ],
      deaf: B._flags({ beat: { rx: [['a', 'running', 5, null]] }, status: { receivers: [{ key: 'a', kind: 'sdr', name: 'Stick A' }] },
        findings: [{ kind: 'receiver-deaf', rx_key: 'a', severity: 'critical', evidence: { name: 'Stick A', changed_at: t(26 * 3600) } },
                   { kind: 'base-station-quiet', severity: 'warn', evidence: {} }] }),
      flags: B._flags({ beat: { uv: true, temp: 77, clock: false, q: 600, rx: [['a', 'error', 0, null]] },
        status: { meganet: { token_refused: true }, receivers: [{ key: 'a', kind: 'sdr', name: 'x' }, { key: 'g', kind: 'gps', state: 'error' }] } }).map(x => x[1]),
      same, changed, bad,
      lastInstall: [
        B._lastInstall({ last: { state: 'current', at: Date.now() / 1000 - 9 * 3600, message: 'RPi ALERT 0.9.0 is the latest release.' } }),
        B._lastInstall({ last: { state: 'ok', at: Date.now() / 1000 - 3600, message: 'Version 0.10.0 installed.' } }),
        B._lastInstall({}),
      ],
      versions: [B._cmpVersion('0.9.0', '0.10.0'), B._cmpVersion('v0.9.0', '0.9.0'), B._cmpVersion('1.0.0', '0.9.9'), B._cmpVersion('0.9', '0.9.0')],
    };
  }, [CONFIG, STICK_1, ODD_KEY]);
  ok('a station is online, quiet, offline, turned off or not managed by when it last checked in',
    pure.liveness.join() === 'online,quiet,offline,off,unmanaged,online', pure.liveness.join());
  ok('the database says which state a station is in, where it says (0059)', pure.told.join() === 'quiet,online,unmanaged', pure.told.join());
  ok('a receiver the database found deaf is something to look at, as bad as it found it — and a quiet station is its state, not a flag',
    pure.deaf.length === 1 && pure.deaf[0][0] === 'txt-bad' && pure.deaf[0][1] === 'Stick A has decoded nothing for 26 h', JSON.stringify(pure.deaf));
  ok('what needs a look: a refused token, power, heat, the clock, the queue, a receiver down — and not the GPS',
    pure.flags.join('|') === 'token refused|under-voltage now|77 °C|clock not set|600 readings waiting|1 receiver not receiving', pure.flags.join('|'));
  ok('the settings form untouched is no change at all', pure.same.patch && Object.keys(pure.same.patch).length === 0, JSON.stringify(pure.same));
  const p = (pure.changed || {}).patch || {};
  ok('a changed form is the smallest patch that says so',
    p.name === 'Mt Stuart' && p.receivers && p.receivers.sdr && p.receivers.sdr.freqHz === 151625000 && p.receivers.sdr.gainDb === null
      && Object.keys(p).sort().join() === 'name,receivers' && Object.keys(p.receivers.sdr).sort().join() === 'freqHz,gainDb',
    JSON.stringify(p));
  const devs = (p.receivers || {}).sdrDevices || [];
  ok('…each stick\'s own settings rebuilt as the station builds them, keeping what the form does not show — its window too',
    devs.length === 2 && devs.some(d => d.key === STICK_1 && d.name === 'North stick' && Object.keys(d).length === 2)
      && devs.some(d => d.key === ODD_KEY && d.name === 'Second stick' && d.ppm === 3 && d.freqHz === undefined && d.sampleRate === 240000),
    JSON.stringify(devs));
  const sp = (((pure.serialRenamed || {}).patch || {}).receivers || {}).sdrDevices || [];
  ok('a stick held by a 0.4 entry by its serial is shown with it, and an untouched form sends nothing',
    pure.serialShown === '40' && pure.serialSame.patch && Object.keys(pure.serialSame.patch).length === 0, JSON.stringify(pure.serialSame));
  ok('…and changed, gets an entry by key that carries the serial entry\'s correction — RPi ALERT 0.15.2 refuses one that would hide it',
    sp.some(d => d.key === STICK_1 && d.name === 'North stick' && d.ppm === -19 && d.gainDb === 40 && d.serial === undefined)
      && sp.some(d => !d.key && d.serial === '00000001' && d.ppm === -19), JSON.stringify(sp));
  ok('a last update run that found nothing to install says when, not the release the station saw then',
    /^nothing newer when it checked \d+ (h|min) ago$/.test(pure.lastInstall[0]) && !/0\.9\.0/.test(pure.lastInstall[0]), pure.lastInstall[0]);
  ok('…one that installed something, or failed, keeps what the station said', /^ok .* ago: Version 0\.10\.0 installed\.$/.test(pure.lastInstall[1])
    && pure.lastInstall[2] === 'no install from here yet', pure.lastInstall.slice(1).join(' | '));
  ok('versions compare part by part as numbers, a "v" ignored', pure.versions.join() === '-1,0,1,0', pure.versions.join());
  ok('a frequency out of range is refused with the reason, not sent', !!pure.bad.error && /24–1766 MHz/.test(pure.bad.error), JSON.stringify(pure.bad));

  // ── Signed out, and not an administrator ─────────────────────────────────────
  await page.evaluate(() => { Auth.isSignedIn = () => false; Auth.isAdmin = () => false; Auth.role = () => null; switchTab('basestations'); });
  await page.waitForTimeout(300);
  const out = await text('#main-content');
  ok('signed out, the tab says what it is for and offers to sign in',
    /checks in with Flood-Net/.test(out) && await page.evaluate(() => !!document.querySelector('#main-content button[onclick="Auth.open()"]')), out.slice(0, 200));
  await page.evaluate(() => { Auth.isSignedIn = () => true; Auth.role = () => 'editor'; BaseStations.authChanged(); });
  await page.waitForTimeout(300);
  ok('signed in without being an administrator, it says this needs one', /needs an administrator/.test(await text('#main-content')));
  ok('…and neither asked the database anything', calls.length === 0, calls.map(c => c.fn).join(','));
  ok('…nor GitHub', releaseAsks === 0, String(releaseAsks));

  // ── An administrator: the list ───────────────────────────────────────────────
  await page.evaluate(() => { Auth.isAdmin = () => true; Auth.role = () => 'admin'; BaseStations.authChanged(); });
  await until(() => page.evaluate(() => document.querySelectorAll('#bs-list tbody tr').length === 4), 'an administrator gets the list, one row per ingest point');
  await until(() => page.evaluate(() => /0\.7\.0 is out/.test(document.querySelector('#bs-list tbody tr')?.textContent || '')),
    'a station behind the latest release says so in the list');
  const list = await page.evaluate(() => [...document.querySelectorAll('#bs-list tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()));
  ok('…and one that does not check in, with no version, does not', !/is out/.test(list[3]), list[3]);
  ok('…the one checking in online, on the database\'s clock, with its host station and receivers',
    /Mt Stuart base/.test(list[0]) && /online/.test(list[0]) && /checked in (just now|\d+ s ago)/.test(list[0]) && /at Mt Stuart/.test(list[0]) && /1 of 3 receiving/.test(list[0]), list[0]);
  ok('…and what needs a look on it', /under-voltage since boot/.test(list[0]) && /2 receivers not receiving/.test(list[0]), list[0]);
  ok('…a stick that runs and hears nothing among it, as the database found it', /North stick has decoded nothing for 7 h/.test(list[0]), list[0]);
  ok('…the one that only reports, said so', /Hut reporter/.test(list[1]) && /reports only/.test(list[1]), list[1]);
  ok('…the one gone quiet, offline, with its heat, power and clock', /offline/.test(list[2]) && /77 °C/.test(list[2]) && /under-voltage now/.test(list[2]) && /clock not set/.test(list[2]), list[2]);
  ok('…and the one that only posts, not managed, with its receiver', /not managed/.test(list[3]) && /last posted 5 min ago/.test(list[3]) && /Quansheng radio/.test(list[3]), list[3]);
  const kpis = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#bs-kpis .adm-kpi')]
    .map(t => [t.querySelector('.adm-kpi-label').textContent.trim(), t.querySelector('.adm-kpi-value').textContent.trim()])));
  ok('the tiles count them', kpis['Online'] === '2' && kpis['Quiet or offline'] === '1' && kpis['Need a look'] === '2' && kpis['Not managed'] === '1',
    JSON.stringify(kpis));
  ok('the team keys are listed, live and taken off', /Jo Bloggs/.test(await text('#bs-keys')) && /Taken off in the last 90 days \(1\)/.test(await text('#bs-keys')));

  // ── Opening one ──────────────────────────────────────────────────────────────
  await page.click('#bs-list button[aria-label="Open Mt Stuart base"]');
  await until(() => page.evaluate(() => /Restart its software/.test((document.getElementById('bs-detail') || {}).textContent || '')), 'Open shows the station');
  ok('…and asks it for its whole status, starting the fast check-ins',
    sent('admin_base_station_watch').some(a => a.p_id === 11 && a.p_status === true), JSON.stringify(sent('admin_base_station_watch')));
  await until(() => page.evaluate(() => !!document.querySelector('#bs-settings #bs-f-name')), 'its settings arrive with its whole status');

  // ── What its radios hear (0068) ──────────────────────────────────────────────
  const spectra = () => sent('admin_base_station_spectrum');
  ok('opening it asks for the last hour of what its radios hear', spectra().some(a => a.p_id === 11 && a.p_hours === 1 && a.p_since === null),
    JSON.stringify(spectra()));
  await until(() => page.evaluate(() => /Heard in the last 1 h/.test((document.getElementById('bs-wf-sum') || {}).textContent || '')),
    'the waterfall arrives, with what was heard in words');
  ok('…under its own heading', /What Mt Stuart base hears/.test(await text('#bs-wf h2')), await text('#bs-wf h2'));
  const legend = (await text('#bs-wf-legend')).replace(/\s+/g, ' ');
  ok('…each stick named with the span its rows cover, one that sent none saying so', /RTL-SDR 1 151\.22–152\.18 MHz/.test(legend) && /Second stick no row yet/.test(legend), legend);
  const sum = (await text('#bs-wf-sum')).replace(/\s+/g, ' ');
  ok('…the busiest channel first: every burst on it, how many decoded, the best signal', /^Heard in the last 1 h: 151\.50 MHz 120 bursts, 120 decoded, best 24\.5 dB · 151\.625 MHz 12 bursts, 0 decoded, best 8\.1 dB$/.test(sum), sum);
  const pic = await page.evaluate(() => {
    const cv = document.getElementById('bs-wf-c'), x = cv.getContext('2d'), w = cv.width, h = cv.height;
    const d = x.getImageData(0, 0, w, h).data, seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 37) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
    return { colours: seen.size, label: cv.getAttribute('aria-label') };
  });
  ok('…drawn: a picture of many colours, and said in words for a screen reader',
    pic.colours > 12 && /^Waterfall of the last 1 h, 151\.22–152\.18 MHz from 1 stick, newest at the top: 132 bursts heard, 120 decoded\.$/.test(pic.label), JSON.stringify(pic));
  await page.locator('#bs-wf-c').scrollIntoViewIfNeeded();
  const box = await page.evaluate(() => { const b = document.getElementById('bs-wf-c').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; });
  await page.mouse.move(box.x + 52 + (151.5e6 - WF_LO) / WF_RATE * (box.w - 60) + 2, box.y + 34 + 20);
  await until(() => page.evaluate(() => !document.getElementById('bs-wf-tip').hidden), 'pointing at it shows a tip');
  const tip = (await text('#bs-wf-tip')).replace(/\s+/g, ' ');
  ok('…the frequency, the few seconds under it, the stick\'s level over its floor, and what was heard on the channel then',
    /^151\.5\d* MHz/.test(tip) && /RTL-SDR 1: \+\d+\.\d dB over its floor \(-\d+\.\d dB\)/.test(tip)
      && /^151\.5\d* MHz \d\d:\d\d:\d\d–\d\d:\d\d:\d\d /.test(tip)
      && /Channel 151\.50 MHz \(ALERT Binary\): (\d+) bursts, \1 decoded, best 24\.5 dB/.test(tip), tip);
  await page.mouse.move(box.x + 5, box.y + 5);
  await until(() => page.evaluate(() => document.getElementById('bs-wf-tip').hidden), '…and hides it off the picture');
  const asked = spectra().length;
  await page.evaluate(() => BaseStations._wfLoad(false));
  const poll = spectra()[asked] || {};
  ok('a poll asks only for the last few minutes, not the hour again',
    poll.p_id === 11 && poll.p_hours === 1 && !!poll.p_since && Date.now() + SKEW - Date.parse(poll.p_since) < 7 * 60_000 && Date.now() + SKEW - Date.parse(poll.p_since) > 4 * 60_000,
    JSON.stringify(poll));
  ok('…and what it held stays drawn', /120 bursts/.test(await text('#bs-wf-sum')), await text('#bs-wf-sum'));
  await page.click('#bs-wf button:has-text("6 h")');
  await until(() => spectra().some(a => a.p_hours === 6 && a.p_since === null), 'the 6 h button asks for six hours');
  ok('…and says it is the one on', await page.evaluate(() => document.querySelector('#bs-wf button[aria-pressed="true"]').textContent.trim() === '6 h'));
  await until(() => page.evaluate(() => /Heard in the last 6 h/.test(document.getElementById('bs-wf-sum').textContent)), '…and draws it');

  // ── Channel by channel (0081) ────────────────────────────────────────────────
  const chAsked = () => sent('admin_base_station_channels');
  ok('opening it asks for a week of its channels', chAsked().some(a => a.p_id === 11 && a.p_days === 7), JSON.stringify(chAsked()));
  await until(() => page.evaluate(() => document.querySelectorAll('#bs-ch tbody tr').length === 7), 'the channels arrive, a row a frequency');
  await until(() => page.evaluate(() => /TOWNSVILLE CITY COUNCIL/.test((document.getElementById('bs-ch') || {}).textContent || '')), '…and the ACMA\'s licences near it after them');
  const chRow = f => page.evaluate(f => {
    const tr = [...document.querySelectorAll('#bs-ch tbody tr')].find(t => t.querySelector('th').textContent.replace(/\s+/g, ' ').trim() === f + ' MHz');
    return tr ? [...tr.children].map(c => c.innerText.replace(/\s+/g, ' ').trim()) : null;
  }, f);
  const chSum = (await text('#bs-ch-sum')).replace(/\s+/g, ' ');
  ok('a line says it all: decoded on four, two expected, one licensed to others, one licensed to nobody — and what is quiet',
    /^In the last 7 days it decoded something on 4 frequencies: 2 expected, 1 licensed to others but not in the register, 1 with no licence found\. 1 expected but not listened to; 1 listened to and silent; 1 on a stick that is not receiving\./.test(chSum), chSum);
  const c1500 = await chRow('151.50');
  ok('151.50: expected, the register\'s repeater on it — ALERT and ALERT2 each with what decoded',
    /^Expected — the register has it here/.test(c1500[1]) && /ALERT 3,500 decoded of 4,000/.test(c1500[2]) && /ALERT2 600 decoded of 640/.test(c1500[2])
      && /on 7 of 7 days/.test(c1500[2]) && /TX of repeater Mt Stuart AL, 1 km/.test(c1500[4]) && /RTL-SDR 1/.test(c1500[6]), JSON.stringify(c1500));
  ok('…who: the stations decoded most, and one 2,200 km away marked',
    /Mt Stuart AL 900/.test(c1500[3]) && /Wonnangatta River at Crooked River \(2,200 km\) 300/.test(c1500[3]) && /90 IDs: 80 in the register here, 3 far away, 7 unknown/.test(c1500[3]), c1500[3]);
  ok('…the IDs that are another network\'s, the ones the register lacks, and the ALERT2 sources it does not know',
    /3 IDs belong to register stations over 400 km away — 4846 is Wonnangatta River at Crooked River, 2,200 km off, decoded 300 times: another network using the same IDs\./.test(c1500[1])
      && /7 IDs the register does not have — most decoded 357 \(19\)\./.test(c1500[1]) && /ALERT2 from 4 sources, none of them in the register\./.test(c1500[1]), c1500[1]);
  ok('…and the Bureau\'s licence beside it', /BUREAU OF METEOROLOGY/.test(c1500[5]) && /0 km/.test(c1500[5]), c1500[5]);
  const c15375 = await chRow('151.5375');
  ok('151.5375: expected (a listed link), the ALERT2 link\'s bursts read as legacy ALERT said, and not listened to now',
    /^Expected/.test(c15375[1]) && /mostly the ALERT2 traffic read as legacy ALERT \(96 of 1,131 decode\)/.test(c15375[1]) && /Not listened to now\./.test(c15375[1])
      && /TX of station Mt Stuart AL, 1 km · Link to the coast/.test(c15375[4]) && c15375[6] === 'no', JSON.stringify(c15375));
  const c1575 = await chRow('151.575');
  ok('151.575: licensed to a council the register does not have, its unknown IDs named',
    /^Licensed to TOWNSVILLE CITY COUNCIL, not in the register/.test(c1575[1]) && /TOWNSVILLE CITY COUNCIL \d+ km/.test(c1575[5]) && /ID 1782 302/.test(c1575[3])
      && /nothing within 250 km/.test(c1575[4]), JSON.stringify(c1575));
  const c1335 = await chRow('151.335');
  ok('151.335: decoded, and neither the register nor the ACMA has anything there', /^Not expected, and no licence found near here/.test(c1335[1])
    && /none within 100 km/.test(c1335[5]), JSON.stringify(c1335));
  ok('151.625: listened to and silent, nothing expected', /^Listened to, nothing heard — nothing expected here/.test((await chRow('151.625'))[1]));
  const c1524 = await chRow('152.40');
  ok('152.40: the register\'s repeater 60 km off and the Bureau\'s licence, and no stick on it', /^Expected here, not listened to/.test(c1524[1])
    && /TX of repeater Paluma AL, 60 km/.test(c1524[4]) && /BUREAU OF METEOROLOGY/.test(c1524[5]), JSON.stringify(c1524));
  const c16025 = await chRow('160.25');
  ok('160.25: listed on a stick that is not receiving', /^Listed on Second stick, which is not receiving/.test(c16025[1]) && /Second stick — not receiving/.test(c16025[6]), JSON.stringify(c16025));
  ok('…and nothing from the register beyond 250 km', !(await chRow('151.95')));
  const more = (await text('#bs-ch details')).replace(/\s+/g, ' ');
  ok('the licences on frequencies it does not use, folded away: Defence\'s 151.2125 and not the one 220 km off',
    /^1 more licensed frequency near here/.test(more) && await page.evaluate(() => /151\.2125 MHz — Department of Defence/.test(document.querySelector('#bs-ch details ul').textContent)), more);
  await page.click('#bs-ch button:has-text("30 days")');
  await until(() => chAsked().some(a => a.p_id === 11 && a.p_days === 30), 'the 30 days button asks for thirty');
  await until(() => page.evaluate(() => /In the last 30 days/.test(document.getElementById('bs-ch-sum').textContent)), '…and says so');
  fail = { fn: 'admin_base_station_channels', status: 404, body: { code: 'PGRST202', message: 'Could not find the function meganet.admin_base_station_channels' } };
  await page.click('#bs-ch button:has-text("1 day")');
  await until(async () => /apply db\/migrations\/0081_base_station_channels\.sql/.test(await text('#bs-ch-sum')), 'a database without 0081 is told which file to apply');
  await page.click('#bs-ch button:has-text("7 days")');
  await until(() => page.evaluate(() => document.querySelectorAll('#bs-ch tbody tr').length === 7), '…and the week comes back when it can');

  const detail = (await text('#bs-detail')).replace(/\s+/g, ' ');
  ok('its health', /mt-stuart/.test(detail) && /192\.168\.1\.40/.test(detail) && /58\.4 °C/.test(detail) && /under-voltage since boot/.test(detail), detail.slice(0, 400));
  ok('a stick hearing two channels says each, with what each decoded', /151\.5000 MHz ALERT Binary \(410 decoded\), 151\.6250 MHz Enhanced iFLOWS \(2 decoded\)/.test(detail)
    && /its other channel is set on the station/.test(detail), detail.slice(detail.indexOf('Receivers'), detail.indexOf('Receivers') + 400));
  ok('its receivers, with the heartbeat\'s state over the status\'s', /RTL-SDR 1/.test(detail) && /receiving/.test(detail) && /151\.5000 MHz/.test(detail)
    && /usb_claim_interface error -6/.test(detail) && /412 decoded/.test(detail), detail.slice(0, 600));
  ok('…the one the database found deaf saying so beside what it has decoded',
    /412 decoded\s*(data [^ ]+ [^ ]+\s*)?nothing new for 7 h/.test(detail), (detail.match(/412 decoded.{0,60}/) || [''])[0]);
  ok('its uplink', /Waiting to send 3 · 12 receptions/.test(detail) && /floodwarning\.net/.test(detail));
  ok('its software', /0\.6\.0/.test(detail) && /installed when asked/.test(detail) && /Version 0\.6\.0 installed/.test(detail));
  ok('…with the latest release beside its version, linked to it', /Version 0\.6\.0 · latest release 0\.7\.0/.test(detail)
    && await page.evaluate(() => !!document.querySelector('#bs-detail .txt-warn a[href="https://github.com/cdomotor-g/RPi_ALERT/releases/tag/v0.7.0"]')),
    detail.slice(detail.indexOf('Software'), detail.indexOf('Software') + 200));
  ok('who may log in over SSH, by fingerprint and whose — never a key',
    /SHA256:VeBIQNSQYe0Ge\+JIo/.test(detail) && /jo@laptop/.test(detail) && /team keys/.test(detail) && /private networks/.test(detail)
      && /ssh alert@192\.168\.1\.40/.test(detail) && /passwords accepted/.test(detail), detail.slice(detail.indexOf('SSH access'), detail.indexOf('SSH access') + 900));
  ok('the log it sent back', /agent 0\.6\.0 started/.test(await text('#bs-log pre.bs-log')));
  const reqs = (await text('#bs-requests')).replace(/\s+/g, ' ');
  ok('what was asked of it, and what became of each',
    /change settings \(audio\.volume\)/.test(reqs) && /changed audio\.volume/.test(reqs) && /no published release found/.test(reqs) && /waiting for it/.test(reqs), reqs.slice(0, 400));

  // ── Asking ───────────────────────────────────────────────────────────────────
  const commands = () => sent('admin_base_station_command');
  // The app's own questions (#223): what is asked is read off the dialog, and
  // the button pressed is the one a person would press.
  await page.click('#bs-detail button:has-text("Restart its software")');
  let q = await answer(page, false);
  let dialog = q.message;
  await page.waitForTimeout(300);
  ok('a restart asks first, in words with an apostrophe in them', /base station's software/.test(dialog), dialog);
  ok('…its question the title, and the button that acts named for what it does', q.title === 'Restart the base station\'s software?'
    && q.yes === 'Restart its software' && !q.danger, JSON.stringify(q));
  ok('…and a "no" sends nothing', commands().length === 0, JSON.stringify(commands()));
  await page.click('#bs-detail button:has-text("Restart its software")');
  await answer(page, true);
  await until(() => commands().length === 1, 'a "yes" sends it');
  ok('…as exactly that request, of that station', commands()[0].p_id === 11 && commands()[0].p_verb === 'agent.restart' && JSON.stringify(commands()[0].p_args) === '{}', JSON.stringify(commands()[0]));

  await page.click(`#bs-detail button[aria-label="Restart Second stick"]`);
  await until(() => commands().length === 2, 'a receiver\'s Restart sends a request');
  ok('…carrying that receiver\'s key exactly, quotes and all', commands()[1].p_verb === 'device.restart' && commands()[1].p_args.key === ODD_KEY, JSON.stringify(commands()[1]));
  await page.click(`#bs-detail button[aria-label="Remove ERT-A2"]`);
  q = await answer(page, true);
  dialog = q.message;
  await until(() => commands().length === 3, 'an unplugged receiver can be removed, after asking');
  ok('…by its key', commands()[2].p_verb === 'device.forget' && commands()[2].p_args.key === 'ert:usb-FTDI_A10K' && /Remove ERT-A2\?/.test(dialog), JSON.stringify(commands()[2]));
  ok('…a button drawn as dangerous asking as one, its answer "Remove" without the …', q.danger && q.yes === 'Remove', JSON.stringify(q));
  await page.click('#bs-detail button:has-text("Show its last 200 lines")');
  await until(() => commands().length === 4, 'Show its log asks for it');
  ok('…for 200 lines', commands()[3].p_verb === 'log' && commands()[3].p_args.lines === 200, JSON.stringify(commands()[3]));
  await page.click('#bs-detail button:has-text("Install new releases by itself")');
  await until(() => commands().length === 5, 'automatic updates can be turned on');
  ok('…as update.auto on', commands()[4].p_verb === 'update.auto' && commands()[4].p_args.on === true, JSON.stringify(commands()[4]));

  // ── Settings ─────────────────────────────────────────────────────────────────
  await page.fill('#bs-f-freq', '2000');
  await page.click('#bs-settings button:has-text("Send the changes")');
  await page.waitForTimeout(200);
  ok('a frequency out of range is refused on the form, with nothing sent',
    /24–1766 MHz/.test(await text('#bs-form-note')) && commands().length === 5, await text('#bs-form-note'));
  await page.fill('#bs-f-freq', '151.6250');
  await page.fill('#bs-f-name', 'Mt Stuart');
  // The poll, with the form typed in and the keyboard in the name box: both survive.
  await page.focus('#bs-f-name');
  await page.evaluate(() => BaseStations.load());
  await page.waitForTimeout(300);
  ok('typing survives a poll of the list and the panel', await page.evaluate(() =>
    document.getElementById('bs-f-name').value === 'Mt Stuart' && document.getElementById('bs-f-freq').value === '151.6250'
      && document.activeElement && document.activeElement.id === 'bs-f-name'));
  await page.click('#bs-settings button:has-text("Send the changes")');
  await until(() => commands().length === 6, 'Send the changes sends them as one request');
  const patch = commands()[5].p_args.patch || {};
  ok('…the smallest patch that says what changed', commands()[5].p_verb === 'config.set' && patch.name === 'Mt Stuart'
    && patch.receivers && patch.receivers.sdr && patch.receivers.sdr.freqHz === 151625000 && Object.keys(patch).sort().join() === 'name,receivers'
    && Object.keys(patch.receivers).join() === 'sdr', JSON.stringify(patch));
  ok('…and says so, in a note a repaint does not wipe', await (async () => {
    await page.evaluate(() => BaseStations.load());
    await page.waitForTimeout(300);
    return /Sent 2 changes to Mt Stuart base/.test(await text('#bs-form-note'));
  })(), await text('#bs-form-note'));

  // The keyboard's place, on a button the poll redraws.
  await page.focus('#bs-detail button:has-text("Check for updates")');
  await page.evaluate(() => BaseStations.load());
  await page.waitForTimeout(400);
  ok('a button with the keyboard on it keeps it through the poll', await page.evaluate(() =>
    document.activeElement && document.activeElement.textContent.trim() === 'Check for updates'));

  // ── Cancelling, and a station that only reports ──────────────────────────────
  await page.click('#bs-requests button[aria-label="Cancel reboot"]');
  await until(() => sent('admin_base_station_cancel').length === 1, 'a queued request can be cancelled');
  ok('…by its id', sent('admin_base_station_cancel')[0].p_command_id === 103);

  await page.click('#bs-list button[aria-label="Open Hut reporter"]');
  await until(() => page.evaluate(() => /Hut reporter/.test((document.getElementById('bs-detail-h') || {}).textContent || '')), 'opening another station swaps the panel');
  const hut = (await text('#bs-detail')).replace(/\s+/g, ' ');
  ok('a station that only reports offers nothing to ask, and says why',
    /set it to report only/.test(hut) && await page.evaluate(() => !document.querySelector('#bs-detail [data-verb]')), hut.slice(0, 300));
  await page.click('#bs-list button[aria-label="Open Serial laptop"]');
  await until(() => page.evaluate(() => /Serial laptop/.test((document.getElementById('bs-detail-h') || {}).textContent || '')), 'a station that only posts opens too');
  ok('…saying it cannot be asked anything, and naming its receivers', /does not check in/.test(await text('#bs-detail')) && /Quansheng radio/.test(await text('#bs-detail')));
  ok('…and nothing is watched that never checks in', !sent('admin_base_station_watch').some(a => a.p_id === 13));
  ok('…nor a waterfall drawn for either, with no SDR stick between them', await page.evaluate(() => !document.querySelector('#bs-wf canvas'))
    && !spectra().some(a => a.p_id === 13));

  // A refusal from the database is shown, not swallowed.
  await page.click('#bs-list button[aria-label="Open Mt Stuart base"]');
  await until(() => page.evaluate(() => !!document.querySelector('#bs-detail [data-verb="status"]')), 'back to the first station');
  fail = { fn: 'admin_base_station_command', status: 429, body: { code: 'PT429', message: '20 requests are already waiting for this base station — let it catch up' } };
  await page.click('#bs-detail [data-verb="status"]');
  await until(async () => /Not asked: 20 requests are already waiting/.test(await text('#bs-detail')), 'a request the database refuses says why');

  // ── Team keys ────────────────────────────────────────────────────────────────
  await page.fill('#bs-key-owner', 'Sam Field');
  await page.fill('#bs-key-text', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl sam@desk');
  await page.click('#bs-keys button:has-text("Add the key")');
  await until(() => sent('admin_base_station_key_add').length === 1, 'Add the key sends it');
  ok('…the whole line, and whose it is', sent('admin_base_station_key_add')[0].p_owner === 'Sam Field'
    && /^ssh-ed25519 AAAA.+ sam@desk$/.test(sent('admin_base_station_key_add')[0].p_public_key));
  await until(async () => /Sam Field/.test(await text('#bs-keys table')), '…and it is listed');
  ok('…and the form is cleared for the next', await page.evaluate(() => document.getElementById('bs-key-owner').value === '' && document.getElementById('bs-key-text').value === ''));
  ok('the open station, on the old list, says it fetches the new one', await (async () => {
    await page.evaluate(() => BaseStations.load());
    await page.waitForTimeout(400);
    return /an older list/.test(await text('#bs-detail'));
  })());
  await page.click('#bs-keys button[aria-label="Take Jo Bloggs\'s key off"]');
  dialog = (await answer(page, true)).message;
  await until(() => sent('admin_base_station_key_remove').length === 1, 'Take off… takes a key off, after asking');
  ok('…naming whose, and its fingerprint', /Jo Bloggs/.test(dialog) && /SHA256:VeBIQNSQ/.test(dialog) && sent('admin_base_station_key_remove')[0].p_id === 5, dialog);

  // ── Leaving the tab stops the polling ────────────────────────────────────────
  await page.evaluate(() => switchTab('admin'));
  await page.waitForTimeout(200);
  const before = calls.length;
  await page.waitForTimeout(3500);
  ok('leaving the tab stops asking the database', calls.filter((c, i) => i >= before && /^admin_base_station/.test(c.fn)).length === 0,
    calls.slice(before).map(c => c.fn).join(','));

  // ── A database without 0049 ──────────────────────────────────────────────────
  missing = true;
  await page.evaluate(() => { BaseStations.authChanged(); switchTab('basestations'); });
  await until(async () => /apply db\/migrations\/0049_base_stations\.sql/.test(await text('#main-content')), 'a database without 0049 is told so');

  ok('GitHub was asked for the latest release once, however often the tab started', releaseAsks === 1, String(releaseAsks));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — the Base Stations tab shows each station as it reported itself, and sends exactly what an administrator asked, of the station they asked.');
