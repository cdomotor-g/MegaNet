// The agent API and MCP server (worker/api.js), end to end, offline.
//
// worker/api.js is a public door onto the database with no identity in front
// of it, so the properties that matter most are the ones that fail silently:
//
//   * that it only ever READS — every upstream request a GET, to PostgREST, of
//     a relation on the public list, with the publishable key and nothing of
//     the caller's. A door that forwarded a caller's token, or reached an RPC,
//     would still answer every question correctly;
//   * that its limits hold — a list cap, a reading window or a rate limit that
//     stopped holding breaks nothing anyone would see until the database is
//     paused for egress or the Worker's allowance is gone;
//   * that its queries are ones PostgREST accepts. The stub it runs against
//     (test/lib/postgrest-stub.mjs) is strict the way the real server is —
//     unknown column, unknown relation, private relation, bad logic tree are
//     all errors — and its tables are built out of the real stations.json and
//     data/sls-locations.json, so the answers have the real shapes.
//
// Also: every route's shape, both MCP eras (the 2025 handshake and the
// 2026-07-28 stateless revision), the Origin rule, batching, errors, the edge
// cache, and that /api/db and /api/session behave exactly as before.
//
// Run:  npm run agentapi        (node agent-api.mjs; -v lists what passed)

import fs from 'node:fs';
import { repo } from './lib/paths.mjs';
import { PostgrestStub } from './lib/postgrest-stub.mjs';
import worker, { dbProxyTarget } from '../worker/index.js';
import * as api from '../worker/api.js';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) { if (VERBOSE) console.log(`\n${title}`); }

// ── The tables, out of the real files ────────────────────────────────────────

const DOC = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8'));
const SLS = JSON.parse(fs.readFileSync(repo('data/sls-locations.json'), 'utf8'));
const NOW = Date.now();
const iso = t => new Date(t).toISOString();
const day = t => iso(t).slice(0, 10);

const COLUMNS = Object.fromEntries(Object.entries({
  station: 'id ord name station_number lat lon elevation_ahd elevation_source roles radio_network_ids catchment_ids alert_ids satcom rm_system_id enabled notes legacy_unit_id site lga basin location_types hub_id owner awrc_number stream urbs_label tbrg_bucket_size inspection_config_key alert2_station_id proposed station_type proposed_year deleted_at updated_at updated_by',
  station_json: 'id ord updated_at doc',
  sensor: 'station_id sensor_id type ord alert_id device_id alert2_sensor_id updated_at updated_by',
  repeater: 'station_id acma_licence rx_mhz tx_mhz notes delay_ms updated_at updated_by',
  pass_range: 'repeater_id kind lo hi ord span updated_at updated_by',
  station_flood_class: 'station_id ord as_at first_report_m crossing_height_m crossing_type minor_m crops_grazing_m moderate_m towns_m major_m note updated_at updated_by',
  station_crossing: 'station_id ord as_at stream name height_m crossing_type note updated_at updated_by',
  station_gauge_survey: 'station_id ord valid_from valid_to gauge_zero_m datum amtd_km catchment_area_km2 note updated_at updated_by',
  station_bureau_listing: 'station_id ord section as_at note updated_at updated_by',
  station_flood_effect: 'station_id ord as_at height_m effect detail note updated_at updated_by',
  station_aep_level: 'station_id ord as_at source point_lat point_lon ground_m aep_1_m aep_0_5_m aep_0_2_m aep_0_066_m data_quality level_difference confidence setting slope slope_basis manning_n note updated_at updated_by',
  station_frequency: 'station_id ord rx_mhz tx_mhz label acma_licence updated_at updated_by',
  catchment: 'id ord name basin_no area_sqkm region border division division_no updated_at updated_by',
  hub: 'id ord name area_sqkm updated_at updated_by',
  radio_network: 'id ord name description updated_at updated_by',
  rm_system: 'id ord name tx_power_w line_loss_db supp_loss_db_m antenna_type antenna_gain_dbi antenna_height_m rx_threshold_dbm updated_at updated_by',
  crossing_type: 'code label meaning ord updated_at updated_by',
  gauge_datum: 'code label ord updated_at updated_by',
  bureau_index: 'code label title ord updated_at updated_by',
  sls_location: 'bureau_number name owner gauge_type data_type basin_no catchment_name class_minor class_moderate class_major prediction_type lead_time lead_time_hours trigger_height peak_accuracy priority schedules forecast_location information_location river_data_location bureau_owned bureau_assists bureau_colocated multi_schedule source_note station_id station_name catchment_id jurisdiction awrc_number gauge_datum classes_undefined fast_response interim_service',
  sls_doc: 'jurisdiction title version source place published url schedules loaded_at updated_by',
  station_health: 'station_key station_id station_name online since last_seen_at last_reading_at minutes_since_seen minutes_since_reading last_status reported_by updated_at',
  reading: 'alert_id station_number channel addr station_id reading_ts received_at value_raw value unit conversion quality protocol source path dup_count dup_paths last_dup_at raw_id ingest_token_id',
  reading_hourly: 'addr bucket alert_id station_number channel station_id unit n n_dup n_val raw_min raw_max raw_sum raw_last raw_mean val_min val_max val_sum val_last val_mean first_ts last_ts rolled_at',
  reading_daily: 'addr bucket alert_id station_number channel station_id unit n n_dup n_val raw_min raw_max raw_sum raw_last raw_mean val_min val_max val_sum val_last val_mean first_ts last_ts rolled_at',
  // The view 0057 makes: the reading's own columns, none of its bookkeeping.
  reading_latest: 'addr alert_id a2_station a2_sensor station_number channel station_id reading_ts received_at value_raw value unit conversion quality protocol source path dup_count freq_mhz rssi_dbm level_dbfs snr_db',
  inspection_chart_visit: 'id station_id inspected_on date_precision origin',
  inspection_chart_power: 'inspection_id battery_existing_v battery_existing_v_under_load lithium_battery_v dp_existing_v consumption_standby_ma consumption_transmit_ma consumption_sleep_ma consumption_operating_ma consumption_interrogation_ma telephone_socket_v solar_output_v solar_short_circuit_ma solar_regulator_v solar_charge_current_ma solar_step_up_v mains_charge_current_ma mains_regulated_v',
  inspection_chart_radio: 'inspection_id tx_size_w tx_deviation_khz existing_frequency_mhz existing_forward_w existing_reflected_w existing_swr replacement_forward_w replacement_reflected_w replacement_swr',
  inspection_chart_gas: 'inspection_id existing_cylinder_pressure_kpa replacement_cylinder_pressure_kpa existing_feed_pressure_kpa existing_bubble_rate_bpm compressor_pump_cycle_from_kpa consumption_kpa_per_month',
  inspection_chart_water_level: 'inspection_id shaft_encoder_increments_per_rev',
  inspection_chart_data: 'inspection_id phase rssi_dbm gas_pressure_kpa dp_counter',
  inspection_chart_fade_margin: 'inspection_id phase load_db',
  link_fade_margin: 'station_a_id station_b_id kind margin_db margin_ab_db margin_ba_db distance_km freq_mhz verdict signature model good_db ok_db band computed_at computed_by',
  app_meta: 'key value updated_at',
}).map(([k, v]) => [k, new Set(v.split(' '))]));

const T = Object.fromEntries(Object.keys(COLUMNS).map(k => [k, []]));
const LISTS = {
  flood_classes: 'station_flood_class', crossings: 'station_crossing', gauge_survey: 'station_gauge_survey',
  bureau_listings: 'station_bureau_listing', flood_effects: 'station_flood_effect',
  aep_levels: 'station_aep_level', frequencies: 'station_frequency',
};
const stationUpdated = '2026-09-26T04:00:00+00:00';

DOC.stations.forEach((s, ord) => {
  T.station.push({
    id: s.id, ord, name: s.name, station_number: s.station_number ?? '', lat: s.lat ?? null, lon: s.lon ?? null,
    elevation_ahd: s.elevation_ahd ?? null, elevation_source: s.elevation_source ?? null, roles: s.roles || [],
    radio_network_ids: s.radio_network_ids || [], catchment_ids: s.catchment_ids || [], alert_ids: s.alert_ids || {},
    satcom: s.satcom || {}, rm_system_id: s.rm_system_id, enabled: s.enabled !== false, notes: s.notes || '',
    legacy_unit_id: s.legacy_unit_id ?? null, site: s.site ?? null, lga: s.lga ?? null, basin: s.basin ?? null,
    location_types: s.location_types ?? null, hub_id: s.hub_id ?? null, owner: s.owner ?? null,
    awrc_number: s.awrc_number ?? null, stream: s.stream ?? null, urbs_label: s.urbs_label ?? null,
    tbrg_bucket_size: s.TBRGbucketSize ?? null, inspection_config_key: s.inspection_config_key ?? null,
    alert2_station_id: s.alert2_station_id ?? null, proposed: s.proposed === true, station_type: s.station_type ?? null,
    proposed_year: s.proposed_year ?? null, deleted_at: null, updated_at: stationUpdated, updated_by: null,
  });
  T.station_json.push({ id: s.id, ord, updated_at: stationUpdated, doc: s });
  (s.sensors || []).forEach((x, i) => T.sensor.push({ station_id: s.id, sensor_id: x.sensor_id, type: x.type, ord: i,
    alert_id: x.alert_id ?? null, device_id: x.device_id ?? null, alert2_sensor_id: x.alert2_sensor_id ?? null }));
  for (const [key, rel] of Object.entries(LISTS)) {
    (s[key] || []).forEach((row, i) => T[rel].push({ station_id: s.id, ord: i, ...row }));
  }
  if (s.repeater) {
    T.repeater.push({ station_id: s.id, acma_licence: s.repeater.acma_licence, rx_mhz: s.repeater.rx_mhz,
      tx_mhz: s.repeater.tx_mhz, notes: s.repeater.notes, delay_ms: s.repeater.delay_ms ?? null });
    (s.repeater.pass_ranges || []).forEach((p, i) => T.pass_range.push({ repeater_id: s.id, kind: 'pass', lo: p.low, hi: p.high, ord: i }));
    (s.repeater.exclusions || []).forEach((p, i) => T.pass_range.push({ repeater_id: s.id, kind: 'exclusion', lo: p.low, hi: p.high, ord: i }));
  }
});
DOC.catchments.forEach((c, ord) => T.catchment.push({ ord, border: null, region: null, ...c }));
DOC.hubs.forEach((h, ord) => T.hub.push({ ord, ...h }));
DOC.radio_networks.forEach((n, ord) => T.radio_network.push({ ord, ...n }));
DOC.rm_systems.forEach((r, ord) => T.rm_system.push({ ord, ...r }));
T.crossing_type.push(...[['B', 'Bridge', 'the height at which the bridge goes under'], ['C', 'Causeway', 'the height at which the causeway goes under'],
  ['A', 'Approaches', 'the height at which the approaches to the crossing go under'], ['X', 'Crossing', 'the height at which the crossing goes under'],
  ['R', 'Road', 'the height at which the road goes under'], ['O', 'Old Bridge', 'the height at which the old bridge goes under'],
  ['H', 'Highway', 'the height at which the highway goes under'], ['F', 'Full Supply', 'the storage\'s full supply level'],
  ['W', 'Weir', 'the height of the weir'], ['S', 'Spillway', 'the height of the spillway'], ['T', 'Highest Astronomical Tide', 'the highest astronomical tide']]
  .map(([code, label, meaning], ord) => ({ code, label, meaning, ord })));
T.gauge_datum.push(...[['AHD', 'Australian Height Datum'], ['ASSUM', 'Assumed datum'], ['STATE', 'State datum'], ['UNKNOWN', 'Datum unknown']]
  .map(([code, label], ord) => ({ code, label, ord })));
T.bureau_index.push(...[['1', 'FloodWarn rainfall', 'Index of Queensland FloodWarn rainfall stations'], ['2', 'Daily rainfall', 'Index of Queensland daily reporting rainfall stations'],
  ['3', 'River height', 'Index of Queensland river height stations']].map(([code, label, title], ord) => ({ code, label, title, ord })));
T.app_meta.push({ key: 'schema_version', value: '39' });

// A soft-deleted station: in `station` with deleted_at set, absent from station_json.
const deletedTwin = { ...T.station[0], id: 'zz_deleted_twin', name: `${T.station[0].name} (deleted)`, deleted_at: '2026-01-01T00:00:00+00:00' };
T.station.push(deletedTwin);

// A proposed station (0039): where one is meant to go, with no number yet. Its
// record says so, and so do its columns, which the compact rows and a
// dossier's nearby list read.
const PROPOSED = { id: 'zz_proposed_gauge', name: 'Proposed Creek Gauge', station_number: '', lat: -27.57, lon: 152.39,
  elevation_ahd: null, roles: ['field'], radio_network_ids: [], catchment_ids: [], alert_ids: {},
  satcom: { enabled: false, provider: '', terminal_id: '' }, rm_system_id: 1, enabled: true, notes: '',
  proposed: true, station_type: 'auto_rain_gauge', proposed_year: 2027 };
T.station.push({ ...T.station[0], id: PROPOSED.id, name: PROPOSED.name, station_number: '', lat: PROPOSED.lat, lon: PROPOSED.lon,
  catchment_ids: [], alert_ids: {}, site: null, lga: null, basin: null, location_types: null, hub_id: null, owner: null,
  awrc_number: null, stream: null, urbs_label: null, legacy_unit_id: null, elevation_ahd: null, elevation_source: null,
  proposed: true, station_type: PROPOSED.station_type, proposed_year: PROPOSED.proposed_year });
T.station_json.push({ id: PROPOSED.id, ord: T.station_json.length, updated_at: stationUpdated, doc: PROPOSED });

// The SLS, merged per (document, bureau number) and joined to the live stations
// as the view does (0038): a station both documents list is two rows.
const bureauKey = n => ((n || '').trim().replace(/^0+/, '') || null);
const stationByKey = new Map();
for (const s of T.station) if (!s.deleted_at && bureauKey(s.station_number)) stationByKey.set(bureauKey(s.station_number), s);
for (const r of SLS.locations) {
  const st = stationByKey.get(bureauKey(r.bureau_number));
  const cat = T.catchment.find(c => c.basin_no === r.basin_no);
  T.sls_location.push({
    bureau_number: r.bureau_number, name: r.name, owner: r.owner ?? null, gauge_type: r.gauge_type ?? null,
    data_type: r.data_type ?? null, basin_no: r.basin_no ?? null, catchment_name: r.catchment_name ?? null,
    class_minor: r.class_minor ?? null, class_moderate: r.class_moderate ?? null, class_major: r.class_major ?? null,
    prediction_type: r.prediction_type ?? null, lead_time: r.lead_time ?? null, lead_time_hours: r.lead_time_hours ?? null,
    trigger_height: r.trigger ?? null, peak_accuracy: r.peak_accuracy ?? null, priority: r.priority ?? null,
    schedules: r.schedules || [], forecast_location: !!r.forecast_location, information_location: !!r.information_location,
    river_data_location: !!r.river_data_location, bureau_owned: !!r.bureau_owned, bureau_assists: !!r.bureau_assists,
    bureau_colocated: !!r.bureau_colocated, multi_schedule: (r.schedules || []).length > 1, source_note: r.source_note ?? null,
    station_id: st ? st.id : null, station_name: st ? st.name : null, catchment_id: cat ? cat.id : null,
    jurisdiction: r.jurisdiction, awrc_number: r.awrc_number ?? null, gauge_datum: r.gauge_datum ?? null,
    classes_undefined: r.classes_undefined ?? null, fast_response: !!r.fast_response, interim_service: !!r.interim_service,
  });
}
// One row per document, as load_sls_doc() writes it — its schedules read off
// the rows file, as the loader reads them.
for (const [j, file] of [['QLD', 'data/sls-qld.json'], ['NSW', 'data/sls-nsw.json']]) {
  const rows = JSON.parse(fs.readFileSync(repo(file), 'utf8'));
  const m = SLS.documents[j];
  T.sls_doc.push({ jurisdiction: j, title: m.title, version: m.version, source: m.source, place: m.place,
    published: m.published, url: m.url, loaded_at: '2026-09-28T00:00:00+00:00', updated_by: 'load_sls_doc',
    schedules: Object.fromEntries(Object.entries(rows.schedules).map(([k, v]) =>
      [k, { label: v.label, title: v.title, role: v.role, pages: v.pages, rows: v.rows.length }])) });
}

// ── The stations the checks are about ────────────────────────────────────────

const live = DOC.stations;
const RICH = live.find(s => s.flood_classes && s.aep_levels && s.crossings && s.flood_effects
  && (s.gauge_survey || []).some(g => g.datum === 'AHD' && !g.valid_to) && (s.sensors || []).some(x => x.alert_id != null)
  && s.catchment_ids && s.catchment_ids.length && s.station_number && s.lat != null);
const slsById = new Map(T.sls_location.filter(r => r.station_id).map(r => [r.station_id, r]));
const MANUAL = live.find(s => slsById.get(s.id)?.gauge_type === 'Manual');
const SPARSE = live.find(s => !s.flood_classes && !s.aep_levels && !s.gauge_survey && !s.crossings && !s.flood_effects
  && !s.bureau_listings && !slsById.has(s.id) && !(s.sensors || []).length && s.lat != null && !s.repeater);
const LIST_WL = live.find(s => Array.isArray(s.alert_ids && s.alert_ids.water_level));
check('the fixtures exist in stations.json', RICH && MANUAL && SPARSE && LIST_WL,
  `rich ${RICH && RICH.id}, manual ${MANUAL && MANUAL.id}, sparse ${SPARSE && SPARSE.id}, list water_level ${LIST_WL && LIST_WL.id}`);
if (!(RICH && MANUAL && SPARSE && LIST_WL)) {
  console.log('\nFAIL — stations.json no longer has a station of every kind these checks are about; see the predicates above.\n');
  process.exit(1);
}

const RICH_ADDRS = [...new Set((RICH.sensors || []).map(x => x.alert_id).filter(x => x != null))];
const WL_SENSOR = RICH.sensors.find(x => /^Water Level/.test(x.type) && x.alert_id != null) || RICH.sensors.find(x => x.alert_id != null);
const WL_ADDR = `a:${WL_SENSOR.alert_id}`;
const OTHER_ADDR = `a:${RICH_ADDRS.find(a => a !== WL_SENSOR.alert_id) ?? WL_SENSOR.alert_id}`;

// A repeater that passes one of RICH's addresses: an existing one if the data
// has it, else the first repeater given a range that covers it.
const passes = (rep, a) => T.pass_range.some(p => p.repeater_id === rep && p.kind === 'pass' && p.lo <= a && a <= p.hi)
  && !T.pass_range.some(p => p.repeater_id === rep && p.kind === 'exclusion' && p.lo <= a && a <= p.hi);
let REPEATER = live.find(s => s.repeater && s.id !== RICH.id && RICH_ADDRS.some(a => passes(s.id, a)));
if (!REPEATER) {
  REPEATER = live.find(s => s.repeater && s.id !== RICH.id);
  T.pass_range.push({ repeater_id: REPEATER.id, kind: 'pass', lo: RICH_ADDRS[0], hi: RICH_ADDRS[0], ord: 99 });
}
// …and one whose pass range covers RICH's address but whose exclusion takes it
// back: it must not be listed.
const EXCLUDER = live.find(s => s.repeater && s.id !== RICH.id && s.id !== REPEATER.id && !RICH_ADDRS.some(a => passes(s.id, a)));
T.pass_range.push({ repeater_id: EXCLUDER.id, kind: 'pass', lo: RICH_ADDRS[0], hi: RICH_ADDRS[0], ord: 98 },
  { repeater_id: EXCLUDER.id, kind: 'exclusion', lo: RICH_ADDRS[0], hi: RICH_ADDRS[0], ord: 98 });

// Telemetry, health, visits and a link for RICH — synthetic, in the real shapes.
const hour = 3600000;
T.station_health.push({ station_key: RICH.id, station_id: RICH.id, station_name: RICH.name, online: true,
  since: iso(NOW - 30 * hour), last_seen_at: iso(NOW - 5 * 60000), last_reading_at: iso(NOW - 15 * 60000),
  minutes_since_seen: 5.2, minutes_since_reading: 15.1, last_status: { battery_v: 12.9 }, reported_by: 'bridge-test', updated_at: iso(NOW) });
for (let t = NOW - 2 * 24 * hour; t < NOW; t += 15 * 60000) {
  for (const addr of [WL_ADDR, OTHER_ADDR]) {
    const alert = Number(addr.slice(2));
    T.reading.push({ alert_id: alert, station_number: null, channel: '', addr, station_id: RICH.id, reading_ts: iso(t),
      received_at: iso(t + 20000), value_raw: 1000 + ((t / 60000) % 500), value: null, unit: null, quality: 0, protocol: 0,
      source: 0, path: null, dup_count: 0, dup_paths: [] });
  }
}
for (let t = Math.floor((NOW - 12 * 24 * hour) / hour) * hour; t < NOW; t += hour) {
  for (const addr of [WL_ADDR, OTHER_ADDR]) {
    T.reading_hourly.push({ addr, bucket: iso(t), alert_id: Number(addr.slice(2)), station_number: null, channel: '',
      station_id: RICH.id, unit: null, n: 4, n_dup: 1, n_val: 0, raw_min: 1000, raw_max: 1010, raw_sum: 4020, raw_last: 1010,
      raw_mean: 1005, val_min: null, val_max: null, val_sum: null, val_last: null, val_mean: null, first_ts: iso(t), last_ts: iso(t + 45 * 60000) });
  }
}
for (let d = 40; d >= 0; d--) {
  const t = NOW - d * 24 * hour;
  for (const addr of [WL_ADDR, OTHER_ADDR]) {
    T.reading_daily.push({ addr, bucket: day(t), alert_id: Number(addr.slice(2)), station_number: null, channel: '',
      station_id: RICH.id, unit: null, n: 96, n_dup: 12, n_val: 0, raw_min: 990 + d, raw_max: 1100 + d, raw_sum: 100000,
      raw_last: 1050 + d, raw_mean: 1041, val_min: null, val_max: null, val_sum: null, val_last: null, val_mean: null,
      first_ts: iso(t), last_ts: iso(t + 23 * hour) });
  }
}
const VISITS = [['v-2024', '2024-05-01'], ['v-2025', '2025-06-10'], ['v-2026', '2026-03-15']];
VISITS.forEach(([id, date]) => T.inspection_chart_visit.push({ id, station_id: RICH.id, inspected_on: date, date_precision: 'day', origin: 'typed' }));
T.inspection_chart_visit.push({ id: 'v-undated', station_id: RICH.id, inspected_on: null, date_precision: null, origin: 'imported' });
T.inspection_chart_power.push({ inspection_id: 'v-2026', battery_existing_v: 12.7, solar_output_v: 19.1, battery_existing_v_under_load: null });
T.inspection_chart_radio.push({ inspection_id: 'v-2026', existing_forward_w: 4.8, existing_reflected_w: 0.1, existing_swr: 1.2 });
T.inspection_chart_data.push({ inspection_id: 'v-2026', phase: 'initial', rssi_dbm: -96, gas_pressure_kpa: null, dp_counter: 12 });
T.inspection_chart_fade_margin.push({ inspection_id: 'v-2026', phase: 'this_visit', load_db: 18 },
  { inspection_id: 'v-2026', phase: 'this_visit', load_db: 22 }, { inspection_id: 'v-2025', phase: 'original', load_db: 16 });
T.inspection_chart_gas.push({ inspection_id: 'v-2025', existing_cylinder_pressure_kpa: 9000 });
const [la, lb] = [RICH.id, REPEATER.id].sort();
T.link_fade_margin.push({ station_a_id: la, station_b_id: lb, kind: 'field', margin_db: 17.5, margin_ab_db: 17.5, margin_ba_db: 19,
  distance_km: 21.4, freq_mhz: 170.2, verdict: 'clear', signature: 'sig', model: 'itm-v1', good_db: 15, ok_db: 6, band: 'good',
  computed_at: '2026-09-01T00:00:00+00:00', computed_by: null });

// Latest readings (#230): besides RICH, a station in a radio network RICH is
// not in, a rain gauge whose clock runs half an hour fast, the two test rigs —
// placed nowhere, one reporting by satellite address — two addresses no
// station can be named for, and the deleted twin, whose readings must not
// bring it back.
const firstAlert = s => (s.sensors || []).find(x => x.alert_id != null);
const NETWORKED = live.find(s => (s.radio_network_ids || []).length && s.basin && s.basin !== RICH.basin && s.lat != null
  && firstAlert(s) && !(RICH.radio_network_ids || []).some(n => s.radio_network_ids.includes(n)));
const RAINY = NETWORKED && live.find(s => JSON.stringify(api.stationKinds(s)) === '["rain"]' && s.lat != null && firstAlert(s)
  && s.basin !== RICH.basin && s.basin !== NETWORKED.basin && !(s.radio_network_ids || []).includes(NETWORKED.radio_network_ids[0]));
const ELPRO = live.find(s => s.id === 'elpro_test');
const BATESON = live.find(s => s.id === 'bateson_test');
// …and a second ELPRO channel, last heard hours before the first: a station's
// latest_at is the newest of its channels, which only differing channels show.
const ELPRO_SECOND = ELPRO && firstAlert(ELPRO)
  && (ELPRO.sensors || []).filter(x => x.alert_id != null && x.alert_id !== firstAlert(ELPRO).alert_id)[0];
const latestFixtures = NETWORKED && RAINY && ELPRO && BATESON && ELPRO_SECOND && ELPRO.lat == null && BATESON.lat == null;
check('the latest-readings fixtures exist in stations.json', latestFixtures,
  `networked ${NETWORKED && NETWORKED.id}, rain-only ${RAINY && RAINY.id}, rigs ${ELPRO && ELPRO.id} ${BATESON && BATESON.id}`);
if (!latestFixtures) {
  console.log('\nFAIL — stations.json no longer has a station of every kind the latest-readings checks are about; see the predicates above.\n');
  process.exit(1);
}
const plainReading = (addr, stationId, t, valueRaw, extra = {}) => ({ alert_id: /^a:/.test(addr) ? Number(addr.slice(2)) : null,
  station_number: null, channel: '', addr, station_id: stationId, reading_ts: iso(t), received_at: iso(t + 20000),
  value_raw: valueRaw, value: null, unit: null, quality: 0, protocol: 0, source: 0, path: null, dup_count: 0, dup_paths: [], ...extra });
const NETWORKED_ADDR = `a:${firstAlert(NETWORKED).alert_id}`;
const RAINY_ADDR = `a:${firstAlert(RAINY).alert_id}`;
const ELPRO_ADDR = `a:${firstAlert(ELPRO).alert_id}`;
const BATESON_ADDR = 's:999998/level_1';
T.reading.push(
  plainReading(`a:${ELPRO_SECOND.alert_id}`, ELPRO.id, NOW - 3 * hour, 17),
  plainReading(NETWORKED_ADDR, NETWORKED.id, NOW - 3 * hour, 640), plainReading(NETWORKED_ADDR, NETWORKED.id, NOW - 2 * hour, 650),
  plainReading(RAINY_ADDR, RAINY.id, NOW - 26 * hour, 11), plainReading(RAINY_ADDR, RAINY.id, NOW + 30 * 60000, 12),
  plainReading(ELPRO_ADDR, ELPRO.id, NOW - 9 * 60000, 248, { path: 'meganet/v1/elpro_test/logger' }),
  plainReading(BATESON_ADDR, BATESON.id, NOW - 70 * 60000, 1.21, { alert_id: null, station_number: '999998', channel: 'level_1', unit: 'm', value: 1.21 }),
  plainReading(BATESON_ADDR, BATESON.id, NOW - 10 * 60000, 1.234, { alert_id: null, station_number: '999998', channel: 'level_1', unit: 'm', value: 1.234 }),
  plainReading('a:7', null, NOW - 40 * 60000, 3),
  plainReading('a2:1001/0', null, NOW - 5 * 60000, 248, { alert_id: null }),
  plainReading('a:65000', deletedTwin.id, NOW - 60000, 1));
// The view, by its own rule: per address, the newest reading_ts, then the
// later received, then the larger value (tools/check_reading_latest.sql
// proves the SQL keeps that rule; this only has to keep it too).
function latestOf(readings) {
  const best = new Map();
  const later = (a, b) => (a.reading_ts !== b.reading_ts ? Date.parse(a.reading_ts) > Date.parse(b.reading_ts)
    : a.received_at !== b.received_at ? Date.parse(a.received_at) > Date.parse(b.received_at) : a.value_raw > b.value_raw);
  for (const r of readings) if (!best.has(r.addr) || later(r, best.get(r.addr))) best.set(r.addr, r);
  return [...best.values()].map(r => Object.fromEntries([...COLUMNS.reading_latest].map(c => [c, r[c] ?? null])));
}
T.reading_latest = latestOf(T.reading);

// ── The stub, the worker and a few ways to call it ───────────────────────────

const stub = new PostgrestStub({ base: api.SUPABASE_REST_URL, columns: COLUMNS, tables: T });
globalThis.fetch = (input, init) => stub.fetch(input, init);

let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;
const ctx = { waitUntil: () => {} };

async function send(path, { method = 'GET', headers = {}, body, env = {}, ip } = {}) {
  const h = new Headers(headers);
  if (!h.has('CF-Connecting-IP')) h.set('CF-Connecting-IP', ip || freshIp());
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await worker.fetch(new Request(`https://floodwarning.net${path}`, init), env, ctx);
  const text = res.status === 204 || res.status === 304 || method === 'HEAD' ? '' : await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  return { res, status: res.status, text, json, headers: res.headers };
}

const get = (path, opts) => send(path, opts);
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const mcp = (body, { headers = {}, ...rest } = {}) => send('/api/mcp', { method: 'POST', body, headers: { ...MCP_HEADERS, ...headers }, ...rest });
let rpcId = 1;
const rpc = (method, params, opts) => mcp({ jsonrpc: '2.0', id: rpcId++, method, ...(params !== undefined ? { params } : {}) }, opts);

// ── Index and OpenAPI ────────────────────────────────────────────────────────
section('Index and OpenAPI');

{
  const r = await get('/api/v1/');
  check('GET /api/v1/ answers 200 JSON', r.status === 200 && r.json && r.json.read_only === true, `status ${r.status}`);
  check('the index lists every endpoint', api.ENDPOINTS.every(e => r.json.endpoints.some(x => x.path === e.path)),
    `${r.json.endpoints.length} endpoints`);
  check('the index names the MCP server, the OpenAPI document and the docs',
    r.json.mcp.url === 'https://floodwarning.net/api/mcp' && r.json.openapi.endsWith('/api/v1/openapi.json') && r.json.docs === api.DOCS_URL);
  check('the index carries the disclaimer from about.html', /not a flood warning service/.test(r.json.disclaimer));
  check('CORS is open for GET', r.headers.get('access-control-allow-origin') === '*');
  check('a 200 is cacheable for 60 s and has an ETag',
    r.headers.get('cache-control') === 'public, max-age=60' && /^W\/"[0-9a-f]+"$/.test(r.headers.get('etag') || ''), r.headers.get('etag'));
  check('without the binding the isolate limiter answers, and says so', r.headers.get('x-ratelimit-limiter') === 'isolate');
  check('the rate policy header states the three rules', r.headers.get('x-ratelimit-policy') === api.RATE_LIMIT_POLICY, r.headers.get('x-ratelimit-policy'));
  check('the API asks not to be indexed', r.headers.get('x-robots-tag') === 'noindex');
  const bare = await get('/api/v1');
  check('/api/v1 without the slash is the index too', bare.status === 200 && bare.json.name === r.json.name);
  const unknown = await get('/api/v1/nothing-here');
  check('an unknown endpoint is a JSON 404', unknown.status === 404 && unknown.json.error === 'not found', unknown.json && unknown.json.detail);
}

{
  const r = await get('/api/v1/openapi.json');
  const doc = r.json;
  check('the OpenAPI document is valid JSON, version 3.1', r.status === 200 && doc && doc.openapi === '3.1.0');
  check('it describes every endpoint', api.ENDPOINTS.every(e => doc.paths[e.path] && doc.paths[e.path].get),
    Object.keys(doc.paths).join(' '));
  check('every operation has a unique operationId',
    new Set(Object.values(doc.paths).map(p => p.get.operationId)).size === Object.keys(doc.paths).length);
  const longDesc = Object.values(doc.paths).filter(p => (p.get.description || '').length > 300 || (p.get.summary || '').length > 300);
  check('no operation description is over 300 characters (GPT Actions\' limit)', longDesc.length === 0, longDesc.map(p => p.get.operationId).join(', '));
  const params = Object.values(doc.paths).flatMap(p => p.get.parameters || []).filter(p => p.description);
  check('no parameter description is over 700 characters', params.every(p => p.description.length <= 700));
  const refs = JSON.stringify(doc).match(/"#\/components\/[^"]+"/g) || [];
  const dangling = refs.map(x => x.slice(2, -1).split('/').slice(1)).filter(pathParts => {
    let node = doc; for (const p of pathParts) node = node && node[p]; return !node;
  });
  check('every $ref resolves', dangling.length === 0, dangling.map(d => d.join('/')).join(', '));
  check('the server is this origin', doc.servers[0].url === 'https://floodwarning.net');
  check('the document is under GPT Actions\' size limit', r.text.length < 100000, `${r.text.length} bytes`);
}

// ── /api/v1/stations ─────────────────────────────────────────────────────────
section('Station search');

// Every live row of the station table — the file's stations and the proposal above.
const liveCount = T.station.filter(s => !s.deleted_at).length;
{
  const r = await get('/api/v1/stations');
  const s = r.json && r.json.stations;
  check('the default page is 25 compact rows', r.status === 200 && s.length === 25 && r.json.limit === 25, `${s && s.length}`);
  check('the total is the live station count, soft deletes excluded', r.json.total === liveCount, `${r.json.total} vs ${liveCount}`);
  check('there is a next page link', typeof r.json.next === 'string' && r.json.next.includes('offset=25'), r.json.next);
  const keys = ['id', 'name', 'station_number', 'lat', 'lon', 'elevation_ahd_m', 'elevation_source', 'roles', 'kinds', 'catchments',
    'basin', 'stream', 'lga', 'hub_id', 'radio_network_ids', 'telemetry', 'sls', 'has'];
  check('a row has the compact shape', s.every(x => keys.every(k => k in x)), keys.filter(k => !(k in s[0])).join(', '));
  check('the deleted twin never appears', !(await get('/api/v1/stations?q=deleted')).json.stations.some(x => x.id === 'zz_deleted_twin'));
}

{
  const word = RICH.name.split(' ')[0];
  const r = await get(`/api/v1/stations?q=${encodeURIComponent(RICH.name)}`);
  check('q by full name puts the station first', r.status === 200 && r.json.stations[0] && r.json.stations[0].id === RICH.id,
    r.json.stations[0] && r.json.stations[0].id);
  const w = await get(`/api/v1/stations?q=${encodeURIComponent(word)}`);
  check('q by one word of the name finds it', w.json.stations.some(x => x.id === RICH.id) || w.json.total > w.json.count, `${w.json.total} matches`);
  const n = await get(`/api/v1/stations?q=${RICH.station_number}`);
  check('q by Bureau number puts the station first', n.json.stations[0] && n.json.stations[0].id === RICH.id, n.json.stations[0] && n.json.stations[0].id);
  const padded = await get(`/api/v1/stations?q=0${RICH.station_number}`);
  check('a zero-padded Bureau number (as the SLS writes it) still finds it', padded.json.stations.some(x => x.id === RICH.id));
  const a = await get(`/api/v1/stations?q=${WL_SENSOR.alert_id}`);
  check('q by ALERT address finds the station that carries it', a.json.stations.some(x => x.id === RICH.id), `${a.json.total} matches`);
  const row = n.json.stations[0];
  check('the row carries its SLS words, flood-level flags and kinds',
    row.has.flood_classes && row.has.aep_levels && row.has.crossings && row.has.gauge_survey && Array.isArray(row.kinds),
    JSON.stringify(row.has));
  check('the row names its catchment', row.catchments.length && row.catchments[0].name, JSON.stringify(row.catchments));
  const quoted = await get(`/api/v1/stations?q=${encodeURIComponent('St. George, "x" (y)')}`);
  check('punctuation in q cannot break the query', quoted.status === 200, `${quoted.status} ${quoted.json && quoted.json.detail}`);
  const short = await get('/api/v1/stations?q=a');
  check('a one-letter q is refused', short.status === 400, short.json && short.json.detail);
}

{
  const r = await get(`/api/v1/stations?near=${RICH.lat},${RICH.lon}&radius_km=20`);
  const s = r.json.stations;
  const sorted = s.every((x, i) => i === 0 || x.distance_km >= s[i - 1].distance_km);
  check('near puts the station at the point first, at 0 km', s[0] && s[0].distance_km === 0 && s.some(x => x.id === RICH.id && x.distance_km === 0),
    s[0] && `${s[0].id} ${s[0].distance_km}`);
  check('near sorts by distance and stays inside the radius', sorted && s.every(x => x.distance_km <= 20), s.map(x => x.distance_km).slice(0, 6).join(', '));
  check('near rows carry a bearing and a compass direction', s.slice(1).every(x => Number.isInteger(x.bearing_deg) && /^[NSEW]{1,3}$/.test(x.direction)));
  const expected = live.filter(x => x.lat != null && x.lon != null)
    .filter(x => haversine(RICH.lat, RICH.lon, x.lat, x.lon) <= 20).length;
  check('near counts what is really inside the radius', r.json.total === expected, `${r.json.total} vs ${expected}`);
  const big = await get(`/api/v1/stations?near=${RICH.lat},${RICH.lon}&radius_km=251`);
  check('a radius over 250 km is refused', big.status === 400, big.json.detail);
  const orphan = await get('/api/v1/stations?radius_km=5');
  check('radius_km without near is refused', orphan.status === 400);
  const badNear = await get('/api/v1/stations?near=brisbane');
  check('a malformed near is refused with the format', badNear.status === 400 && /lat,lon/.test(badNear.json.detail));
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

{
  const cid = RICH.catchment_ids[0];
  const inCat = live.filter(s => (s.catchment_ids || []).includes(cid)).length;
  const r = await get(`/api/v1/stations?catchment=${cid}&limit=100`);
  check('catchment by id filters to that basin', r.json.total === inCat && r.json.stations.every(s => s.catchments.some(c => c.id === cid)),
    `${r.json.total} vs ${inCat}`);
  const name = DOC.catchments.find(c => c.id === cid).name;
  const byName = await get(`/api/v1/stations?catchment=${encodeURIComponent(name)}`);
  check('catchment by name does the same', byName.json.total === inCat, `${byName.json.total}`);
  const none = await get('/api/v1/stations?catchment=atlantis');
  check('an unknown catchment is an empty answer that says why', none.status === 200 && none.json.count === 0 && /No catchment/.test(none.json.notes.join(' ')));

  const river = await get(`/api/v1/stations?catchment=${cid}&type=river&limit=100`);
  const riverExpected = live.filter(s => (s.catchment_ids || []).includes(cid) && api.stationKinds(s).includes('river')).length;
  check('type=river keeps exactly the river stations', river.json.total === riverExpected && river.json.stations.every(s => s.kinds.includes('river')),
    `${river.json.total} vs ${riverExpected}`);
  const rain = await get('/api/v1/stations?type=rain&limit=100');
  const rainExpected = live.filter(s => api.stationKinds(s).includes('rain')).length;
  check('type=rain keeps exactly the rain stations', rain.json.total === rainExpected && rain.json.stations.every(s => s.kinds.includes('rain')),
    `${rain.json.total} vs ${rainExpected}`);
  const reps = await get('/api/v1/stations?type=repeater&limit=100');
  check('type=repeater is the repeaters', reps.json.total === live.filter(s => (s.roles || []).includes('repeater')).length
    && reps.json.stations.every(s => s.roles.includes('repeater')));
  const base = await get('/api/v1/stations?role=base');
  check('role=base is the base stations', base.json.total === live.filter(s => (s.roles || []).includes('base')).length);
  const both = await get(`/api/v1/stations?q=${encodeURIComponent(RICH.name.split(' ')[0])}&type=river`);
  check('q and type together (two logic groups) are accepted', both.status === 200, both.json && both.json.detail);
}

{
  const manualExpected = live.filter(s => slsById.get(s.id)?.gauge_type === 'Manual').length;
  const r = await get('/api/v1/stations?manual=true&limit=100');
  check('manual=true keeps what the SLS calls Manual, all of it', r.json.total === manualExpected
    && r.json.stations.every(s => s.sls && s.sls.gauge_type === 'Manual'), `${r.json.total} vs ${manualExpected}`);
  const autoExpected = live.filter(s => slsById.get(s.id)?.gauge_type === 'Automatic').length;
  const a = await get('/api/v1/stations?manual=false&limit=5');
  check('manual=false keeps what it calls Automatic', a.json.total === autoExpected, `${a.json.total} vs ${autoExpected}`);
  const m = await get(`/api/v1/stations?q=${MANUAL.station_number}&manual=true`);
  check('a manual station is found with manual=true', m.json.stations.some(s => s.id === MANUAL.id));
  api.resetApiState();
  stub.maxRows = 300;      // a server cap below the page size: paging must trust the count, not a short page
  const capped = await get('/api/v1/stations?manual=true&limit=5');
  stub.maxRows = 1000;
  check('the candidate and SLS reads page past a server max-rows below the page size', capped.json.total === manualExpected,
    `${capped.json.total} vs ${manualExpected}`);
  const bad = await get('/api/v1/stations?manual=maybe');
  check('manual must be true or false', bad.status === 400);
}

{
  const r = await get('/api/v1/stations?limit=500');
  check('a limit over 100 is clamped, with a note', r.status === 200 && r.json.limit === 100 && r.json.count === 100
    && r.json.notes.some(n => /maximum of 100/.test(n)), r.json.notes.join(' '));
  check('a zero limit is refused', (await get('/api/v1/stations?limit=0')).status === 400);
  check('a non-numeric limit is refused', (await get('/api/v1/stations?limit=ten')).status === 400);
  const past = await get(`/api/v1/stations?offset=${liveCount + 10}`);
  check('an offset past the end is an empty last page, not an error', past.status === 200 && past.json.count === 0 && past.json.next === null,
    `${past.status}`);
  const unk = await get('/api/v1/stations?name=x');
  check('an unknown parameter is refused, naming the accepted ones', unk.status === 400 && /Accepted: q, near/.test(unk.json.detail), unk.json.detail);
  const dup = await get('/api/v1/stations?q=ab&q=cd');
  check('a repeated parameter is refused', dup.status === 400);
  const all = [];
  let next = '/api/v1/stations?type=base&limit=2';
  for (let i = 0; i < 10 && next; i++) {
    const p = await get(next.replace('https://floodwarning.net', ''));
    all.push(...p.json.stations.map(s => s.id));
    next = p.json.next;
  }
  check('following next pages through without repeats', new Set(all).size === all.length
    && all.length === live.filter(s => (s.roles || []).includes('base')).length, `${all.length} rows`);
}

// ── One station ──────────────────────────────────────────────────────────────
section('One station');

{
  const r = await get(`/api/v1/stations/${RICH.id}`);
  check('GET /stations/{id} returns the register record as it is', r.status === 200
    && JSON.stringify(r.json.station) === JSON.stringify(RICH), `status ${r.status}`);
  check('…with its SLS rows and health row', Array.isArray(r.json.sls) && r.json.health && r.json.health.online === true);
  check('…and links to its other routes', r.json.links.dossier.endsWith(`/stations/${RICH.id}/dossier`));
  const upper = await get(`/api/v1/stations/${RICH.id.toUpperCase()}`);
  check('an id is not case-sensitive', upper.status === 200 && upper.json.id === RICH.id);
  const byNum = await get(`/api/v1/stations/${RICH.station_number}`);
  check('a Bureau number stands in for the id, and says so', byNum.status === 200 && byNum.json.id === RICH.id
    && /station number/.test(byNum.json.resolved_from || ''), byNum.json && (byNum.json.resolved_from || byNum.json.detail));
  const missing = await get('/api/v1/stations/no_such_station_here');
  check('an unknown id is 404 with advice', missing.status === 404 && /stations\?q=/.test(missing.json.detail));
  const badId = await get('/api/v1/stations/%3Cscript%3E');
  check('a malformed id is 400', badId.status === 400, badId.json && badId.json.detail);
  const deleted = await get('/api/v1/stations/zz_deleted_twin');
  check('a soft-deleted station is not found', deleted.status === 404);
}

// ── The dossier ──────────────────────────────────────────────────────────────
section('Dossier');

let dossier;
{
  stub.requests = [];
  const r = await get(`/api/v1/stations/${RICH.id}/dossier`);
  dossier = r.json;
  const calls = stub.requests.length;
  check('the dossier answers 200', r.status === 200, `status ${r.status} ${r.json && r.json.detail}`);
  check(`it stays inside the fan-out cap (${api.LIMITS.upstreamPerRequest} reads)`, calls <= api.LIMITS.upstreamPerRequest, `${calls} reads`);
  const sections = ['identity', 'location', 'networks_and_radio', 'telemetry', 'service_level', 'bureau_listings', 'flood_levels',
    'inspections', 'nearby_stations'];
  check('every section is there, each with a status', sections.every(k => dossier[k] && typeof dossier[k].status === 'string'),
    sections.filter(k => !dossier[k]).join(', '));
  check('it has sources, a generated_at, links and the disclaimer', dossier.sources.length >= 5 && dossier.generated_at
    && dossier.links.readings && /not a flood warning service/.test(dossier.disclaimer));
  check('the summary is plain sentences', Array.isArray(dossier.summary) && dossier.summary.length >= 3 && dossier.summary[0].includes(RICH.name),
    dossier.summary[0]);
  const loc = dossier.location;
  check('location carries the height and where it came from', loc.elevation_ahd_m === (RICH.elevation_ahd ?? null)
    && (loc.elevation_ahd_m == null || /surveyed|modelled/.test(loc.elevation_source)), `${loc.elevation_ahd_m} ${loc.elevation_source}`);
  check('location names the catchment and hub', loc.catchments[0].name && (!RICH.hub_id || loc.hub.name), JSON.stringify(loc.hub));

  const fl = dossier.flood_levels;
  const zero = RICH.gauge_survey.find(g => g.datum === 'AHD' && !g.valid_to);
  const cur = [...RICH.flood_classes].sort((a, b) => (b.as_at || '').localeCompare(a.as_at || ''))[0];
  check('the current flood classes are the newest edition', fl.flood_classes.status === 'ok' && fl.flood_classes.current.as_at === cur.as_at);
  const minorAhd = cur.minor_m != null ? Math.round((zero.gauge_zero_m + cur.minor_m) * 1000) / 1000 : null;
  check('a class is put in AHD by the AHD gauge zero in force', minorAhd == null || fl.flood_classes.current_m_ahd.minor === minorAhd,
    `${fl.flood_classes.current_m_ahd && fl.flood_classes.current_m_ahd.minor} vs ${minorAhd}`);
  check('the AEP levels are flagged indicative, in m AHD', fl.aep_levels.status === 'ok' && fl.aep_levels.indicative === true && fl.aep_levels.unit === 'm AHD');
  check('the ladder is in m AHD, lowest first', fl.ladder_m_ahd.levels.length > 0
    && fl.ladder_m_ahd.levels.every((l, i, a) => i === 0 || l.m_ahd >= a[i - 1].m_ahd));
  check('the datum caveats are stated', fl.caveats.some(c => /on the station's gauge/.test(c)) && fl.caveats.some(c => /indicative/.test(c)));
  const aepRow = fl.aep_levels.selected;
  const apart = aepRow.ground_m != null && Math.abs(aepRow.ground_m - zero.gauge_zero_m) > 10;
  check('the ladder warns when the AEP sheet\'s ground is far from the gauge zero, and only then',
    apart === /Compare the two sets with care/.test(fl.ladder_m_ahd.note), `ground ${aepRow.ground_m}, zero ${zero.gauge_zero_m}`);
  check('crossings carry the legend\'s words', fl.crossings.status === 'ok' && fl.crossings.items.every(c => !c.crossing_type || c.crossing_type_label));

  const tel = dossier.telemetry;
  check('health says when Flood-Net last heard it', tel.health.status === 'ok' && tel.health.last_seen_at && tel.health.minutes_since_seen === 5);
  const ch = tel.recent_daily.channels || [];
  check('recent daily rollups are summarised per channel over exactly 30 UTC days', tel.recent_daily.status === 'ok' && ch.length === 2
    && ch.every(c => c.days_with_data === 30), ch.map(c => `${c.addr}:${c.days_with_data}`).join(' '));
  check('a channel is labelled with its sensor type', ch.some(c => Array.isArray(c.sensor_types) && c.sensor_types.length));

  const insp = dossier.inspections;
  check('inspections: the count, the last visit, and its numbers', insp.status === 'ok' && insp.visits_recorded === 4
    && insp.last_visit.date === '2026-03-15' && insp.recent_visits[0].power.battery_existing_v === 12.7, JSON.stringify(insp.last_visit));
  check('fade margins fold to the best reading per phase', insp.recent_visits[0].fade_margin_db_by_phase.this_visit === 22);
  check('no null leaks into the visit numbers', !JSON.stringify(insp.recent_visits).includes('null'));

  const near = dossier.nearby_stations;
  check('the five nearest stations, nearest first, not itself', near.status === 'ok' && near.stations.length === 5
    && near.stations.every((s, i, a) => s.id !== RICH.id && (i === 0 || s.distance_km >= a[i - 1].distance_km)));

  const radio = dossier.networks_and_radio;
  check('repeaters listening includes the repeater that passes its address',
    radio.repeaters_listening.status === 'ok' && radio.repeaters_listening.repeaters.some(x => x.id === REPEATER.id),
    JSON.stringify(radio.repeaters_listening.repeaters && radio.repeaters_listening.repeaters.map(x => x.id)));
  check('…and not one whose exclusion takes the address back', !radio.repeaters_listening.repeaters.some(x => x.id === EXCLUDER.id), EXCLUDER.id);
  check('the saved link margin is there, with the other end named', radio.link_margins.status === 'ok'
    && radio.link_margins.links[0].other_station.id === REPEATER.id && radio.link_margins.links[0].other_station.name === REPEATER.name);
  check('the Radio Mobile system is named', radio.rm_system && radio.rm_system.name);

  check('the Bureau listings name their index, not just its number', !RICH.bureau_listings
    || (dossier.bureau_listings.status === 'ok' && dossier.bureau_listings.items.every(i => /^Index of Queensland/.test(i.index))),
    JSON.stringify(dossier.bureau_listings.items && dossier.bureau_listings.items[0]));
  const sl = dossier.service_level;
  check('the SLS section is present either way and names every document\'s edition', ['ok', 'not recorded'].includes(sl.status)
    && sl.editions.length === 2 && sl.editions.every(e => e.version === SLS.documents[e.jurisdiction].version
      && e.current_edition_url === SLS.documents[e.jurisdiction].url) && sl.edition && sl.edition.version,
    JSON.stringify(sl.editions));
  check('the dossier stays well inside an MCP client\'s output budget', r.text.length < 60000, `${r.text.length} bytes`);
}

{
  const r = await get(`/api/v1/stations/${SPARSE.id}/dossier`);
  const d = r.json;
  const empties = ['service_level', 'bureau_listings', 'inspections'];
  check('a sparse station\'s dossier still has every section', r.status === 200 && empties.every(k => d[k].status === 'not recorded' && d[k].detail),
    empties.map(k => `${k}:${d[k] && d[k].status}`).join(' '));
  check('…and says "not recorded" for each flood list rather than leaving it out',
    ['gauge_zero', 'flood_classes', 'crossings', 'flood_effects', 'aep_levels'].every(k => d.flood_levels[k].status === 'not recorded' && d.flood_levels[k].detail));
  check('no telemetry is "not recorded" with the reason', d.telemetry.health.status === 'not recorded' && /Bureau/.test(d.telemetry.health.detail)
    && d.telemetry.recent_daily.status === 'not recorded');
}

{
  // A proposal is one in its identity, and said to be one before anything else.
  const r = await get(`/api/v1/stations/${PROPOSED.id}/dossier`);
  const id = r.json && r.json.identity;
  check('a proposed station\'s identity says so, with its type and its year', r.status === 200 && id.proposed === true
    && id.station_type === 'auto_rain_gauge' && id.proposed_year === 2027, JSON.stringify(id));
  check('…and its summary says it next after its name, in words',
    /^It is proposed, not yet established: an automatic rain gauge, proposed for 2027/.test(r.json.summary[1] || ''),
    JSON.stringify(r.json.summary.slice(0, 2)));
  const st = await get(`/api/v1/stations/${PROPOSED.id}`);
  check('…and its record carries the three keys', st.status === 200 && st.json.station.proposed === true
    && st.json.station.proposed_year === 2027);
  const est = dossier.identity;
  check('an established station is not proposed and has neither', est.proposed === false && est.station_type === null
    && est.proposed_year === null, JSON.stringify({ proposed: est.proposed, station_type: est.station_type }));

  // The compact rows carry it too, now the columns are there (0039 is live):
  // found by a search, a proposal says what it is; an established row says not.
  const found = await get(`/api/v1/stations?q=${encodeURIComponent('Proposed Creek')}`);
  const row = found.json && (found.json.stations || []).find(x => x.id === PROPOSED.id);
  check('a search row for a proposal says so, with its type and its year', found.status === 200 && row
    && row.proposed === true && row.station_type === 'auto_rain_gauge' && row.proposed_year === 2027, JSON.stringify(row));
  const plain = await get(`/api/v1/stations?q=${encodeURIComponent(RICH.name)}`);
  const prow = plain.json && (plain.json.stations || []).find(x => x.id === RICH.id);
  check('…and an established station\'s row is not proposed and has neither', plain.status === 200 && prow
    && prow.proposed === false && prow.station_type === null && prow.proposed_year === null, JSON.stringify(prow && {
      proposed: prow.proposed, station_type: prow.station_type, proposed_year: prow.proposed_year }));

  // A dossier's nearby list marks a proposed neighbour: a station with the
  // proposal among its nearest (within four, for a margin on ties).
  const placed = T.station.filter(x => !x.deleted_at && x.lat != null && x.lon != null);
  const nearestTo = (lat, lon, not) => placed.filter(x => x.id !== not)
    .map(x => ({ id: x.id, d: haversine(lat, lon, x.lat, x.lon) })).sort((a, b) => a.d - b.d);
  const host = nearestTo(PROPOSED.lat, PROPOSED.lon, PROPOSED.id).slice(0, 20).map(c => placed.find(x => x.id === c.id))
    .find(x => nearestTo(x.lat, x.lon, x.id).slice(0, 4).some(c => c.id === PROPOSED.id));
  const near = host && await get(`/api/v1/stations/${host.id}/dossier`);
  const hood = (near && near.json && near.json.nearby_stations && near.json.nearby_stations.stations) || [];
  const mark = hood.find(x => x.id === PROPOSED.id);
  check('a dossier\'s nearby list marks a proposed neighbour, and only that one', !!host && mark && mark.proposed === true
    && hood.filter(x => x.id !== PROPOSED.id).every(x => x.proposed === false), JSON.stringify({ host: host && host.id, hood }));
}

{
  const r = await get(`/api/v1/stations/${LIST_WL.id}/dossier`);
  check('a station whose water_level address is a list is handled', r.status === 200
    && Array.isArray(r.json.networks_and_radio.repeaters_listening.addresses || []), `status ${r.status}`);
}

{
  stub.fault = rel => (rel === 'station_health' ? new Response('{"message":"boom"}', { status: 500 }) : null);
  const r = await get(`/api/v1/stations/${RICH.id}/dossier`);
  stub.fault = null;
  check('one failed read degrades its section to "unavailable", not the dossier',
    r.status === 200 && r.json.telemetry.health.status === 'unavailable' && /paused/.test(r.json.telemetry.health.detail),
    r.json && r.json.telemetry && r.json.telemetry.health.status);
}

// ── Flood levels, service level, readings ────────────────────────────────────
section('Flood levels, SLS, readings');

{
  const r = await get(`/api/v1/stations/${RICH.id}/flood-levels`);
  check('flood-levels answers with the same builder as the dossier', r.status === 200
    && JSON.stringify(r.json.flood_classes) === JSON.stringify(dossier.flood_levels.flood_classes));
  const s = await get(`/api/v1/stations/${MANUAL.id}/service-level`);
  const e = s.json.service_level;
  check('service-level for a manual station says Manual, with its document and edition', s.status === 200 && e.status === 'ok'
    && e.entries[0].gauge_type === 'Manual' && e.entries[0].edition === SLS.documents[e.entries[0].jurisdiction].version
    && e.edition.version === e.entries[0].edition, e.status);
  const n = await get(`/api/v1/stations/${SPARSE.id}/service-level`);
  check('a station outside the SLS is "not recorded", with the reason, and both editions', n.json.service_level.status === 'not recorded'
    && n.json.service_level.detail && n.json.service_level.editions.length === 2, n.json.service_level.detail);
  const numbered = live.find(s => s.station_number && !T.sls_location.some(r => r.station_id === s.id));
  const nn = await get(`/api/v1/stations/${numbered.id}/service-level`);
  check('…and a numbered one is told it is in neither document, each named with its version',
    nn.json.service_level.status === 'not recorded' && /Queensland, version /.test(nn.json.service_level.detail)
      && /New South Wales and the Australian Capital Territory, version /.test(nn.json.service_level.detail),
    nn.json.service_level.detail);
}

// Two documents (0038). GOONDIWINDI is a forecast location in both, and they
// disagree about its levels; each entry is its own document's, QLD's first.
{
  const locOf = (j, n) => SLS.locations.find(l => l.jurisdiction === j && l.bureau_number === n);
  const GQ = locOf('QLD', '041500'), GN = locOf('NSW', '041500');
  const s = await get('/api/v1/stations/goondiwindi_tm/service-level');
  const e = s.json.service_level;
  check('a station both documents list has an entry from each, Queensland\'s first', s.status === 200 && e.status === 'ok'
    && e.entries.length === 2 && e.entries[0].jurisdiction === 'QLD' && e.entries[1].jurisdiction === 'NSW',
    JSON.stringify(e.entries && e.entries.map(x => x.jurisdiction)));
  check('…each with its own document\'s figures and edition, neither overwritten',
    e.entries[0].flood_classes_m_on_gauge.major === GQ.class_major && e.entries[1].flood_classes_m_on_gauge.major === GN.class_major
      && GQ.class_major !== GN.class_major && e.entries[0].edition === SLS.documents.QLD.version
      && e.entries[1].edition === SLS.documents.NSW.version,
    JSON.stringify(e.entries.map(x => [x.jurisdiction, x.flood_classes_m_on_gauge, x.edition])));
  check('…and the NSW entry carries what only that document gives: the datum and the AWRC number',
    e.entries[1].gauge_datum === GN.gauge_datum && e.entries[1].awrc_number === GN.awrc_number && !('gauge_datum' in e.entries[0]),
    JSON.stringify(e.entries[1]));
  const f = await get('/api/v1/stations/goondiwindi_tm/flood-levels');
  const rows = f.json.sls_flood_classes.rows;
  check('flood-levels gives both documents\' SLS classes, each naming its document',
    f.status === 200 && rows.length === 2 && rows[0].jurisdiction === 'QLD' && rows[1].jurisdiction === 'NSW'
      && rows[1].major_m === GN.class_major && rows[1].gauge_datum === GN.gauge_datum, JSON.stringify(rows));
  const d = await get('/api/v1/stations/goondiwindi_tm/dossier');
  check('the dossier\'s summary says what each document says, and whose it is',
    d.json.summary.filter(l => /^Service Level Specification \((QLD|NSW) v/.test(l)).length === 2, JSON.stringify(d.json.summary));
  const q = await get('/api/v1/stations?q=goondiwindi&limit=50');
  const row = q.json.stations.find(x => x.id === 'goondiwindi_tm');
  check('a compact row\'s sls is the entry the card quotes first, and says whose', !!row && row.sls && row.sls.jurisdiction === 'QLD'
    && row.sls.priority === GQ.priority, JSON.stringify(row && row.sls));

  // The NSW document's own numbering, and what it says that Queensland's does not.
  const c = await get('/api/v1/stations/chinderah_tweed_riv/service-level');
  const ce = c.json.service_level.entries || [];
  check('roles are labelled in the entry\'s own document\'s numbering (NSW: Bureau-owned is Schedule 6)',
    ce.length === 1 && ce[0].jurisdiction === 'NSW'
      && JSON.stringify(ce[0].roles) === JSON.stringify(['forecast location (Schedule 2)', 'Bureau-owned (Schedule 6)']),
    JSON.stringify(ce[0] && ce[0].roles));
  const rp = await get('/api/v1/stations/repton_bellinger_ri/flood-levels');
  const rr = (rp.json.sls_flood_classes.rows || [])[0] || {};
  check('a class the NSW SES has not defined is listed as not yet defined, not left out',
    JSON.stringify(rr.not_yet_defined) === '["moderate"]' && rr.gauge_datum === 'AHD' && rr.moderate_m === undefined,
    JSON.stringify(rr));
  const bp = await get('/api/v1/stations/byrnes_point/service-level');
  const be = (bp.json.service_level.entries || [])[0] || {};
  check('an interim service (the page\'s *) says so', be.prediction && be.prediction.interim_service === true
    && be.prediction.lead_time === 'TBC', JSON.stringify(be.prediction));
}

// Before 0038 reaches the database the Worker is already live — Cloudflare
// deploys it on push — so it must answer from 0028's shape too: one document,
// no jurisdiction column, sls_doc keyed by its one-row flag.
{
  const OLD = {
    sls_location: COLUMNS.sls_location && [...COLUMNS.sls_location].filter(c =>
      !['jurisdiction', 'awrc_number', 'gauge_datum', 'classes_undefined', 'fast_response', 'interim_service'].includes(c)),
    sls_doc: ['only_row', 'title', 'version', 'source', 'loaded_at', 'updated_by'],
  };
  const oldTables = { ...T,
    sls_location: T.sls_location.filter(r => r.jurisdiction === 'QLD').map(r => Object.fromEntries(
      Object.entries(r).filter(([k]) => OLD.sls_location.includes(k)))),
    sls_doc: [{ only_row: true, title: SLS.documents.QLD.title, version: SLS.documents.QLD.version,
      source: SLS.documents.QLD.source, loaded_at: '2026-09-20T00:00:00+00:00', updated_by: 'load_sls_doc' }] };
  const oldStub = new PostgrestStub({ base: api.SUPABASE_REST_URL,
    columns: { ...COLUMNS, sls_location: new Set(OLD.sls_location), sls_doc: new Set(OLD.sls_doc) }, tables: oldTables });
  api.resetApiState();
  globalThis.fetch = (input, init) => oldStub.fetch(input, init);
  try {
    const s = await get('/api/v1/stations/goondiwindi_tm/service-level');
    const e = s.json && s.json.service_level;
    check('before 0038 is applied, service-level still answers from the one document there is',
      s.status === 200 && e && e.status === 'ok' && e.entries.length === 1 && e.entries[0].jurisdiction === 'QLD'
        && e.editions.length === 1 && e.editions[0].version === SLS.documents.QLD.version,
      JSON.stringify(e && { status: e.status, entries: e.entries && e.entries.length, editions: e.editions }));
    const q = await get('/api/v1/stations?q=goondiwindi&limit=50');
    const row = q.json && q.json.stations && q.json.stations.find(x => x.id === 'goondiwindi_tm');
    check('…and a compact row still carries its SLS words', q.status === 200 && row && row.sls && row.sls.jurisdiction === 'QLD'
      && !(q.json.notes || []).some(n => /SLS could not be read/.test(n)), JSON.stringify(row && row.sls));
  } finally {
    globalThis.fetch = (input, init) => stub.fetch(input, init);
    api.resetApiState();
  }
}

{
  const r = await get(`/api/v1/stations/${RICH.id}/readings`);
  check('readings default to hourly over 7 days', r.status === 200 && r.json.resolution === 'hourly' && r.json.count === 2 * 7 * 24
    && r.json.total === 2 * 7 * 24, `${r.json.count} rows, total ${r.json.total}`);
  check('readings rows are in time order and label their channels', r.json.rows.every((x, i, a) => i === 0 || x.t >= a[i - 1].t)
    && r.json.channels[WL_ADDR] && r.json.channels[WL_ADDR].sensor_types);
  const raw = await get(`/api/v1/stations/${RICH.id}/readings?resolution=raw&from=${encodeURIComponent(iso(NOW - 24 * hour))}`);
  check('raw readings over a day', raw.status === 200 && raw.json.count > 150 && raw.json.rows[0].value_raw != null, `${raw.json.count}`);
  const tooLongRaw = await get(`/api/v1/stations/${RICH.id}/readings?resolution=raw&from=${day(NOW - 8 * 24 * hour)}`);
  check('a raw window over 7 days is refused, pointing at hourly', tooLongRaw.status === 400 && /hourly/.test(tooLongRaw.json.detail));
  const tooLongHourly = await get(`/api/v1/stations/${RICH.id}/readings?resolution=hourly&from=${day(NOW - 32 * 24 * hour)}`);
  check('an hourly window over 31 days is refused', tooLongHourly.status === 400);
  const tooLongDaily = await get(`/api/v1/stations/${RICH.id}/readings?resolution=daily&from=${day(NOW - 800 * 24 * hour)}`);
  check('a daily window over two years is refused', tooLongDaily.status === 400);
  const daily = await get(`/api/v1/stations/${RICH.id}/readings?resolution=daily&from=${day(NOW - 60 * 24 * hour)}&channel=${WL_SENSOR.alert_id}`);
  check('daily rollups for one channel, by ALERT address', daily.status === 200 && daily.json.rows.length === 41
    && daily.json.rows.every(x => x.addr === WL_ADDR), `${daily.json.rows && daily.json.rows.length}`);
  const byType = await get(`/api/v1/stations/${RICH.id}/readings?channel=${encodeURIComponent(WL_SENSOR.type)}`);
  check('a channel can be named by sensor type', byType.status === 200 && byType.json.rows.length && byType.json.rows.every(x => x.addr === WL_ADDR));
  const badCh = await get(`/api/v1/stations/${RICH.id}/readings?channel=teapot`);
  check('an unknown channel is refused, listing the station\'s types', badCh.status === 400 && badCh.json.detail.includes(WL_SENSOR.type));
  const paged = await get(`/api/v1/stations/${RICH.id}/readings?resolution=raw&from=${encodeURIComponent(iso(NOW - 2 * 24 * hour))}&limit=100`);
  const second = paged.json.next ? await get(paged.json.next.replace('https://floodwarning.net', '')) : null;
  check('readings page with next, without overlap', paged.json.count === 100 && second && second.json.count === 100
    && second.json.rows[0].t >= paged.json.rows[99].t && second.json.offset === 100);
  stub.maxRows = 100;       // a server cap below the page size the API asks for
  const big = await get(`/api/v1/stations/${RICH.id}/readings?resolution=raw&from=${encodeURIComponent(iso(NOW - 2 * 24 * hour))}&limit=9000`);
  stub.maxRows = 1000;
  check('a readings limit over 5,000 is clamped, and rows are paged upstream past the server\'s max-rows',
    big.json.limit === 5000 && big.json.count === T.reading.filter(x => x.station_id === RICH.id && Date.parse(x.reading_ts) >= NOW - 2 * 24 * hour).length
    && big.json.count > 100, `${big.json.count} rows`);
  const future = await get(`/api/v1/stations/${RICH.id}/readings?to=2099-01-01`);
  check('a window ending years ahead is refused', future.status === 400);
  const backwards = await get(`/api/v1/stations/${RICH.id}/readings?from=2026-09-10&to=2026-09-01`);
  check('from after to is refused', backwards.status === 400);
  const badDate = await get(`/api/v1/stations/${RICH.id}/readings?from=yesterday`);
  check('a date that is not ISO 8601 is refused with an example', badDate.status === 400 && /2026-09-01/.test(badDate.json.detail));
  const empty = await get(`/api/v1/stations/${SPARSE.id}/readings`);
  check('no readings is an empty answer that explains itself', empty.status === 200 && empty.json.count === 0
    && empty.json.notes.some(n => /ingested/.test(n)));
}

// ── Latest readings (#230) ───────────────────────────────────────────────────
section('Latest readings');

// What the route should answer, worked out from the fixtures rather than read
// back from it: every live station with an address in the view, in id order,
// kept by the same rules /stations filters with.
const liveById = new Map(T.station.filter(s => !s.deleted_at).map(s => [s.id, s]));
const heardIds = [...new Set(T.reading_latest.map(r => r.station_id).filter(id => id && liveById.has(id)))].sort();
const expectLatest = (keep = () => true) => heardIds.filter(id => keep(liveById.get(id)));
const inBox = ([w, s, e, n]) => st => st.lat != null && st.lon != null && st.lat >= s && st.lat <= n && st.lon >= w && st.lon <= e;
const idsOf = r => ((r.json && (r.json.stations || (r.json.features || []).map(f => f.properties))) || []).map(s => s.id);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A row with its ages taken out, for comparing two answers a minute could fall between.
const ageless = row => JSON.parse(JSON.stringify(row, (k, v) => (/^minutes_since/.test(k) ? undefined : v)));

{
  stub.requests = [];
  const r = await get('/api/v1/readings/latest');
  const reads = stub.requests.length;
  const j = r.json || {};
  check('GET /api/v1/readings/latest answers every live station with a reading, in id order, in one call', r.status === 200
    && sameList(idsOf(r), heardIds) && j.total === heardIds.length && j.count === heardIds.length && j.total_exact === true
    && heardIds.length >= 5, `${r.status} ${idsOf(r).join(' ')} ${j.detail || ''}`);
  check('…in two database reads at this size: the view, and those stations by id', reads === 2, `${reads} reads`);
  check('…never the deleted twin, though its address has the newest reading of all', !idsOf(r).includes(deletedTwin.id));
  const unattributed = T.reading_latest.filter(x => !x.station_id).length;
  check('…and counts the addresses no single station can be named for, rather than guessing',
    unattributed === 2 && j.unattributed_addresses === unattributed && j.notes.some(n => /no single live station/.test(n)),
    `${j.unattributed_addresses}`);
  const keys = ['id', 'name', 'station_number', 'lat', 'lon', 'kinds', 'basin', 'stream', 'radio_network_ids', 'latest_at',
    'minutes_since_latest', 'channels'];
  check('a row has the latest-reading shape', (j.stations || []).every(s => keys.every(k => k in s)),
    keys.filter(k => !(k in ((j.stations || [])[0] || {}))).join(', '));

  const row = id => (j.stations || []).find(s => s.id === id);
  const newestOf = addr => T.reading.filter(x => x.addr === addr).map(x => x.reading_ts).sort().pop();
  const rich = row(RICH.id);
  check('a station\'s row has each channel\'s newest reading, labelled with its sensor types', rich && rich.channels.length === 2
    && rich.channels.every(c => c.t === newestOf(c.addr) && Array.isArray(c.sensor_types) && c.sensor_types.length)
    && rich.channels.some(c => c.addr === WL_ADDR && c.sensor_types.includes(WL_SENSOR.type)), JSON.stringify(rich && rich.channels));
  check('…latest_at is the newest of its channels, and the minutes since it count from now',
    rich && rich.latest_at === [WL_ADDR, OTHER_ADDR].map(newestOf).sort().pop()
      && Math.abs(rich.minutes_since_latest - (Date.now() - Date.parse(rich.latest_at)) / 60000) <= 1
      && rich.channels.every(c => Math.abs(c.minutes_since - (Date.now() - Date.parse(c.t)) / 60000) <= 1),
    rich && `${rich.latest_at} ${rich.minutes_since_latest}`);
  const rainy = row(RAINY.id);
  check('a clock running ahead is the newest reading still, and its minutes since are negative', rainy
    && rainy.channels[0].value_raw === 12 && rainy.channels[0].minutes_since < 0 && rainy.minutes_since_latest < 0,
    JSON.stringify(rainy && rainy.channels));
  const bateson = row(BATESON.id);
  const bc = bateson && bateson.channels[0];
  check('a satellite address is a channel like any other: its channel name, value and unit', bc && bateson.channels.length === 1
    && bc.addr === BATESON_ADDR && bc.channel === 'level_1' && bc.value_raw === 1.234 && bc.value === 1.234 && bc.unit === 'm'
    && !('sensor_types' in bc) && bateson.lat === null, JSON.stringify(bateson));
  const elpro = row(ELPRO.id);
  check('…and a rig with no position is still a row, its ALERT address named by its sensor', elpro && elpro.lat === null
    && JSON.stringify(elpro.channels[0].sensor_types) === JSON.stringify([firstAlert(ELPRO).type])
    && elpro.channels[0].path === 'meganet/v1/elpro_test/logger', JSON.stringify(elpro));
  check('a station\'s latest_at is the newest of its channels when they differ', elpro && elpro.channels.length === 2
    && elpro.latest_at === newestOf(ELPRO_ADDR) && elpro.latest_at > elpro.channels[1].t
    && JSON.stringify(elpro.channels[1].sensor_types) === JSON.stringify([ELPRO_SECOND.type])
    && Math.abs(elpro.minutes_since_latest - 9) <= 1, elpro && `${elpro.latest_at} ${elpro.minutes_since_latest}`);
  check('…and what the readings are, and are not, is said', j.notes.some(n => /Bureau/.test(n)) && /reading_latest/.test(j.source));
}

{
  const net = NETWORKED.radio_network_ids[0];
  const byNet = await get(`/api/v1/readings/latest?network=${net}`);
  const wantNet = expectLatest(s => (s.radio_network_ids || []).includes(net));
  check('network= keeps the stations in that radio network', byNet.status === 200 && sameList(idsOf(byNet), wantNet)
    && wantNet.includes(NETWORKED.id) && wantNet.length < heardIds.length, `${idsOf(byNet).join(' ')} vs ${wantNet.join(' ')}`);
  const word = NETWORKED.basin.split(' ')[0];
  const byBasin = await get(`/api/v1/readings/latest?basin=${encodeURIComponent(word.toUpperCase())}`);
  const wantBasin = expectLatest(s => (s.basin || '').toLowerCase().includes(word.toLowerCase()));
  check('basin= keeps the stations whose basin names it, in any case', byBasin.status === 200 && sameList(idsOf(byBasin), wantBasin)
    && wantBasin.includes(NETWORKED.id) && wantBasin.length < heardIds.length, `${idsOf(byBasin).join(' ')} vs ${wantBasin.join(' ')}`);
  for (const type of ['rain', 'river', 'base']) {
    const t = await get(`/api/v1/readings/latest?type=${type}`);
    const want = expectLatest(s => api.stationKinds(s).includes(type));
    check(`type=${type} keeps exactly the ${type} stations, by /stations' own rule`, t.status === 200 && sameList(idsOf(t), want)
      && want.length > 0 && want.length < heardIds.length && t.json.stations.every(s => s.kinds.includes(type)),
      `${idsOf(t).join(' ')} vs ${want.join(' ')}`);
  }
  const box = [RICH.lon - 0.05, RICH.lat - 0.05, RICH.lon + 0.05, RICH.lat + 0.05].map(x => Math.round(x * 1e4) / 1e4);
  const inside = await get(`/api/v1/readings/latest?bbox=${box.join(',')}`);
  check('bbox=west,south,east,north keeps the stations inside it, and none without a position', inside.status === 200
    && sameList(idsOf(inside), expectLatest(inBox(box))) && idsOf(inside).includes(RICH.id) && !idsOf(inside).includes(BATESON.id),
    `${inside.status} ${idsOf(inside).join(' ')} ${inside.json && inside.json.detail}`);
  const both = await get(`/api/v1/readings/latest?type=rain&bbox=${box.join(',')}&network=${net}`);
  check('filters combine', both.status === 200 && sameList(idsOf(both),
    expectLatest(s => inBox(box)(s) && api.stationKinds(s).includes('rain') && (s.radio_network_ids || []).includes(net))));
  const latFirst = await get(`/api/v1/readings/latest?bbox=${[box[1], box[0], box[3], box[2]].join(',')}`);
  check('a box written lat-first is refused, saying longitude comes first', latFirst.status === 400
    && /longitude first|latitudes/.test(latFirst.json.detail), latFirst.json && latFirst.json.detail);
  for (const [b, why] of [['1,2,3', 'three numbers'], ['153,-27,152,-28', 'west east of east'], ['152,-28,153,-27,1', 'five numbers'],
    ['x,y,z,w', 'words']]) {
    const r = await get(`/api/v1/readings/latest?bbox=${b}`);
    check(`a malformed bbox (${why}) is refused`, r.status === 400 && /bbox/.test(r.json.detail), r.json && r.json.detail);
  }
  const unknown = await get('/api/v1/readings/latest?station=x');
  check('an unknown parameter is refused, naming the accepted ones', unknown.status === 400
    && /Accepted: network, basin, type, bbox, format, limit, offset/.test(unknown.json.detail), unknown.json.detail);
  const badType = await get('/api/v1/readings/latest?type=wind');
  check('a kind there is no rule for is refused', badType.status === 400);
}

{
  const all = [];
  let next = '/api/v1/readings/latest?limit=2';
  let pages = 0;
  for (; pages < 10 && next; pages++) {
    const p = await get(next.replace('https://floodwarning.net', ''));
    all.push(...idsOf(p));
    next = p.json.next;
  }
  check('following next pages through gives every station once, in order', sameList(all, heardIds) && pages === Math.ceil(heardIds.length / 2),
    `${all.length} rows in ${pages} pages`);
  const big = await get('/api/v1/readings/latest?limit=5000');
  check(`a limit over ${api.LIMITS.latestMax} is clamped to it, with a note`, big.status === 200 && big.json.limit === api.LIMITS.latestMax
    && big.json.notes.some(n => /maximum of 1000/.test(n)), big.json && big.json.notes.join(' '));
  const past = await get('/api/v1/readings/latest?offset=50');
  check('an offset past the end is an empty last page with the total', past.status === 200 && past.json.count === 0
    && past.json.next === null && past.json.total === heardIds.length);
}

{
  // Past a few hundred stations the second path: the filtered station table's
  // ids read whole, then the page's stations by id, a hundred to a read.
  const many = T.station.filter(s => !s.deleted_at && s.lat != null).slice(0, 350);
  const manyReadings = [...many.map((s, i) => plainReading(`a:${20000 + i}`, s.id, NOW - (i + 1) * 60000, i)),
    plainReading('a:19999', deletedTwin.id, NOW - 1000, 1), plainReading('a:19998', null, NOW - 1000, 1)];
  const manyStub = new PostgrestStub({ base: api.SUPABASE_REST_URL, columns: COLUMNS, tables: { ...T, reading_latest: latestOf(manyReadings) } });
  globalThis.fetch = (input, init) => manyStub.fetch(input, init);
  try {
    api.resetApiState();
    const wantIds = many.map(s => s.id).sort();
    const r = await get('/api/v1/readings/latest?limit=1000');
    const reads = manyStub.requests.length;
    check('past a few hundred stations, the same answer by the second path', r.status === 200 && sameList(idsOf(r), wantIds)
      && r.json.total === wantIds.length && r.json.unattributed_addresses === 1 && r.json.total_exact === true,
      `${r.status} ${r.json && (r.json.total ?? r.json.detail)}`);
    const bound = 1 + Math.ceil(liveById.size / 1000) + Math.ceil(wantIds.length / api.LIMITS.idsPerRead);
    check('…in a bounded number of reads, however many stations there are', reads <= bound && reads <= api.LIMITS.upstreamPerRequest,
      `${reads} reads, bound ${bound}`);
    const longest = Math.max(...manyStub.requests.map(q => ((new URL(q.url).searchParams.get('id') || '').match(/","/g) || []).length + 1));
    check(`…and no id list longer than ${api.LIMITS.idsPerRead}`, longest <= api.LIMITS.idsPerRead, `${longest}`);
    const rain = await get('/api/v1/readings/latest?type=rain&limit=1000');
    check('…filtering by the same rule', rain.status === 200
      && sameList(idsOf(rain), wantIds.filter(id => api.stationKinds(liveById.get(id)).includes('rain'))));
    const page = await get('/api/v1/readings/latest?limit=100&offset=100');
    check('…and paging', page.status === 200 && sameList(idsOf(page), wantIds.slice(100, 200)) && /offset=200/.test(page.json.next));
  } finally {
    globalThis.fetch = (input, init) => stub.fetch(input, init);
    api.resetApiState();
  }
}

{
  // Nothing heard at all — the bridge down, say — is an empty answer, not an error.
  const quietStub = new PostgrestStub({ base: api.SUPABASE_REST_URL, columns: COLUMNS, tables: { ...T, reading_latest: [] } });
  globalThis.fetch = (input, init) => quietStub.fetch(input, init);
  try {
    api.resetApiState();
    const r = await get('/api/v1/readings/latest?format=geojson');
    check('no readings anywhere is an empty answer in one read, not an error', r.status === 200 && r.json.total === 0
      && r.json.count === 0 && r.json.features.length === 0 && r.json.next === null && quietStub.requests.length === 1
      && r.json.unattributed_addresses === 0, `${r.status} ${quietStub.requests.length} reads`);
  } finally {
    globalThis.fetch = (input, init) => stub.fetch(input, init);
    api.resetApiState();
  }
}

{
  // The Worker deploys on push; 0057 lands when somebody applies it. Until
  // then the route must say so — not 500, and not a 502 calling it a bug.
  const { reading_latest: _notYet, ...before } = COLUMNS;
  const beforeStub = new PostgrestStub({ base: api.SUPABASE_REST_URL, columns: before, tables: T });
  globalThis.fetch = (input, init) => beforeStub.fetch(input, init);
  try {
    api.resetApiState();
    const r = await get('/api/v1/readings/latest');
    check('before 0057 is applied: a 503 naming the missing relation and the migration', r.status === 503
      && r.json.error === 'not available yet' && r.json.missing_relation === 'meganet.reading_latest'
      && r.json.migration === 'db/migrations/0057_reading_latest.sql' && /has not been applied/.test(r.json.detail),
      `${r.status} ${r.json && JSON.stringify(r.json)}`);
    check('…with no Retry-After, since a minute will not apply a migration', r.headers.get('retry-after') === null, r.headers.get('retry-after'));
    const tool = await rpc('tools/call', { name: 'get_latest_readings', arguments: {} });
    const text = (tool.json.result && tool.json.result.content[0].text) || '';
    check('…and the tool says the same, without suggesting a retry', tool.json.result && tool.json.result.isError === true
      && /not available yet/.test(text) && /0057_reading_latest/.test(text) && !/retrying/.test(text), text.slice(0, 200));
    const other = await get(`/api/v1/stations/${RICH.id}/readings`);
    check('…while every other route answers as before', other.status === 200);
  } finally {
    globalThis.fetch = (input, init) => stub.fetch(input, init);
    api.resetApiState();
  }
  stub.fault = rel => (rel === 'catchment' ? new Response('{"code":"PGRST205","message":"Could not find the table"}', { status: 404 }) : null);
  const vanished = await get('/api/v1/catchments');
  stub.fault = null;
  api.resetApiState();
  check('a relation that should be there and is not is still the 502 it was', vanished.status === 502
    && vanished.json.error === 'database refused the query', `${vanished.status}`);
}

// ── GeoJSON (#230) ───────────────────────────────────────────────────────────
section('GeoJSON');

const GEO = /^application\/geo\+json/;
{
  const plain = await get('/api/v1/stations?q=tide&limit=100');
  const geo = await get('/api/v1/stations?q=tide&limit=100&format=geojson');
  const rows = plain.json.stations;
  const placed = rows.filter(s => s.lat != null && s.lon != null);
  const unplaced = rows.filter(s => s.lat == null || s.lon == null);
  const fc = geo.json || {};
  check('stations with format=geojson: a FeatureCollection under application/geo+json; JSON stays the default',
    geo.status === 200 && fc.type === 'FeatureCollection' && GEO.test(geo.headers.get('content-type'))
      && /^application\/json/.test(plain.headers.get('content-type')) && !('type' in plain.json), geo.headers.get('content-type'));
  const feats = fc.features || [];
  check('…a Point per placed station, at [lon, lat] — longitude first — with the JSON row as its properties',
    placed.length > 5 && feats.length === placed.length && feats.every((f, i) => f.type === 'Feature' && f.id === placed[i].id
      && f.geometry.type === 'Point' && f.geometry.coordinates.length === 2
      && f.geometry.coordinates[0] === placed[i].lon && f.geometry.coordinates[1] === placed[i].lat
      && JSON.stringify(f.properties) === JSON.stringify(placed[i])), `${feats.length} features for ${placed.length} placed`);
  check('…which in Queensland is east of 100° and south of the equator', feats.every(f => f.geometry.coordinates[0] > 100
    && f.geometry.coordinates[1] < 0), JSON.stringify(feats[0] && feats[0].geometry));
  check('…a station with no position left out, counted, named and said', unplaced.length > 0
    && fc.omitted_without_position.count === unplaced.length
    && sameList(fc.omitted_without_position.ids, unplaced.map(s => s.id)) && fc.notes.some(n => /no recorded position/.test(n)),
    JSON.stringify(fc.omitted_without_position));
  const lons = placed.map(s => s.lon), lats = placed.map(s => s.lat);
  check('…the bbox the features\' own, west, south, east, north', sameList(fc.bbox,
    [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]), JSON.stringify(fc.bbox));
  check('…and the paging and query of the JSON answer', fc.count === plain.json.count && fc.total === plain.json.total
    && fc.next === plain.json.next && fc.query.format === 'geojson');

  const near = await get(`/api/v1/stations?near=${RICH.lat},${RICH.lon}&radius_km=20&format=geojson`);
  const nf = (near.json && near.json.features) || [];
  check('near with format=geojson: nearest first, each feature carrying its distance and bearing', near.status === 200
    && nf.length > 1 && nf[0].properties.distance_km === 0 && nf.some(f => f.id === RICH.id)
    && nf.every((f, i) => i === 0 || f.properties.distance_km >= nf[i - 1].properties.distance_km)
    && nf.every(f => typeof f.properties.bearing_deg === 'number') && near.json.omitted_without_position.count === 0);

  const p1 = await get('/api/v1/stations?type=base&limit=2&format=geojson');
  const p2 = p1.json.next ? await get(p1.json.next.replace('https://floodwarning.net', '')) : null;
  check('…and a next link that asks for GeoJSON again', /format=geojson/.test(p1.json.next || '') && p2 && p2.json.type === 'FeatureCollection'
    && GEO.test(p2.headers.get('content-type')), p1.json.next);
  const empty = await get('/api/v1/stations?catchment=atlantis&format=geojson');
  check('an empty answer is an empty FeatureCollection that still says why', empty.status === 200 && empty.json.type === 'FeatureCollection'
    && empty.json.features.length === 0 && /No catchment/.test(empty.json.notes.join(' ')));
  const kml = await get('/api/v1/stations?format=kml');
  check('a format other than json or geojson is refused', kml.status === 400 && /json, geojson/.test(kml.json.detail), kml.json.detail);
  const head = await send('/api/v1/stations?q=tide&format=geojson', { method: 'HEAD' });
  check('HEAD says application/geo+json too', head.status === 200 && GEO.test(head.headers.get('content-type')));
  const tool = await rpc('tools/call', { name: 'stations_near', arguments: { lat: RICH.lat, lon: RICH.lon, radius_km: 10, format: 'geojson' } });
  check('the MCP tools take format too: stations_near answers a FeatureCollection', tool.json.result.isError === false
    && tool.json.result.structuredContent.type === 'FeatureCollection' && tool.json.result.structuredContent.features.length > 0);
}

{
  const plain = await get('/api/v1/readings/latest');
  const geo = await get('/api/v1/readings/latest?format=geojson');
  const rows = plain.json.stations;
  const placed = rows.filter(s => s.lat != null && s.lon != null);
  const fc = geo.json || {};
  check('latest readings with format=geojson: a Point per placed station at [lon, lat], its row as properties',
    geo.status === 200 && fc.type === 'FeatureCollection' && GEO.test(geo.headers.get('content-type'))
      && fc.features.length === placed.length && fc.features.every((f, i) => f.id === placed[i].id
        && f.geometry.coordinates[0] === placed[i].lon && f.geometry.coordinates[1] === placed[i].lat
        && JSON.stringify(ageless(f.properties)) === JSON.stringify(ageless(placed[i]))), `${fc.features && fc.features.length} features`);
  check('…the rigs with no position named in omitted_without_position, the total unchanged',
    sameList([...fc.omitted_without_position.ids].sort(), [BATESON.id, ELPRO.id].sort()) && fc.total === heardIds.length
      && fc.unattributed_addresses === plain.json.unattributed_addresses, JSON.stringify(fc.omitted_without_position));
  const first = await get('/api/v1/readings/latest?format=geojson&limit=2');
  const second = first.json.next ? await get(first.json.next.replace('https://floodwarning.net', '')) : null;
  check('…its next link asking for GeoJSON again', /format=geojson/.test(first.json.next || '') && second
    && second.json.type === 'FeatureCollection' && second.json.offset === 2, first.json.next);
  const tool = await rpc('tools/call', { name: 'get_latest_readings', arguments: { type: 'river', format: 'geojson' } });
  check('…and the tool answers GeoJSON with format "geojson"', tool.json.result.isError === false
    && tool.json.result.structuredContent.type === 'FeatureCollection');
}

// ── Catchments and networks ──────────────────────────────────────────────────
section('Catchments and networks');

{
  const r = await get('/api/v1/catchments');
  check('the catchment list is the 77 basins', r.status === 200 && r.json.count === DOC.catchments.length, `${r.json.count}`);
  const cid = RICH.catchment_ids[0];
  const one = await get(`/api/v1/catchments/${cid}?limit=5`);
  check('one catchment, with a page of its stations', one.status === 200 && one.json.catchment.id === cid && one.json.stations.length === 5
    && one.json.next && one.json.next.includes(`/catchments/${cid}`));
  const miss = await get('/api/v1/catchments/her');
  check('an unknown catchment is 404 with candidates', miss.status === 404 && Array.isArray(miss.json.candidates) && miss.json.candidates.length);
  const n = await get('/api/v1/networks');
  check('networks lists radio networks, hubs and RM systems', n.status === 200 && n.json.radio_networks.length === DOC.radio_networks.length
    && n.json.hubs.length === DOC.hubs.length && n.json.rm_systems.length === DOC.rm_systems.length);
  const extra = await get('/api/v1/networks?x=1');
  check('an endpoint without parameters refuses one', extra.status === 400);
}

// ── Read-only by construction ────────────────────────────────────────────────
section('Read-only');

{
  stub.requests = [];
  const hostile = { Authorization: 'Bearer the-callers-own-token', Cookie: 'CF_Authorization=an-access-session',
    'Cf-Access-Jwt-Assertion': 'the-access-identity', apikey: 'someone-elses-key', Prefer: 'return=representation' };
  await get(`/api/v1/stations/${RICH.id}/dossier`, { headers: hostile });
  await get('/api/v1/stations?q=creek', { headers: hostile });
  await rpc('tools/call', { name: 'get_station', arguments: { id: RICH.id } }, { headers: hostile });
  const leaked = stub.requests.filter(q => q.headers.authorization || q.headers.cookie || q.headers['cf-access-jwt-assertion']
    || JSON.stringify(q.headers).includes('the-callers-own-token'));
  check('a caller\'s Authorization, cookie and Access identity never reach the database', stub.requests.length > 0 && leaked.length === 0,
    `${stub.requests.length} upstream reads, ${leaked.length} leaked`);
  check('the caller\'s apikey and Prefer are not forwarded either', stub.requests.every(q => q.headers.apikey === api.PUBLISHABLE_KEY
    && q.headers.prefer !== 'return=representation'));
}

// A broad sweep over every route and every tool, cold each time, and then
// everything it sent upstream is held to the read-only rules.
stub.requests = [];
for (const p of ['/api/v1/', '/api/v1/stations?q=river&type=river', `/api/v1/stations?near=${RICH.lat},${RICH.lon}&manual=true`,
  `/api/v1/stations/${RICH.id}`, `/api/v1/stations/${RICH.id}/dossier`, `/api/v1/stations/${RICH.id}/readings?resolution=raw`,
  `/api/v1/stations/${RICH.id}/flood-levels`, `/api/v1/stations/${MANUAL.id}/service-level`, '/api/v1/catchments',
  `/api/v1/catchments/${RICH.catchment_ids[0]}`, '/api/v1/networks', `/api/v1/stations/${RICH.station_number}/readings`,
  '/api/v1/readings/latest', `/api/v1/readings/latest?type=river&network=${NETWORKED.radio_network_ids[0]}&basin=river&format=geojson`,
  `/api/v1/readings/latest?bbox=${RICH.lon - 1},${RICH.lat - 1},${RICH.lon + 1},${RICH.lat + 1}`, '/api/v1/stations?q=tide&format=geojson']) {
  api.resetApiState();
  await get(p);
}
for (const t of api.MCP_TOOLS) {
  api.resetApiState();
  await rpc('tools/call', { name: t.name, arguments: toolArgs(t.name) });
}

function toolArgs(name) {
  switch (name) {
    case 'search_stations': return { q: RICH.name, limit: 3 };
    case 'stations_near': return { lat: RICH.lat, lon: RICH.lon, radius_km: 15, limit: 3 };
    case 'get_readings': return { id: RICH.id, resolution: 'daily', from: day(NOW - 10 * 24 * hour) };
    case 'get_latest_readings': return { type: 'river', limit: 3 };
    case 'list_catchments': case 'list_networks': return {};
    case 'get_catchment': return { id: RICH.catchment_ids[0], limit: 3 };
    default: return { id: RICH.id };
  }
}

const everything = stub.requests.slice();
{
  const base = `${api.SUPABASE_REST_URL}/`;
  const bad = everything.filter(q => q.method !== 'GET');
  check('every upstream request of the sweep is a GET', everything.length > 40 && bad.length === 0, `${everything.length} reads, ${bad.length} not GET`);
  const rel = q => decodeURIComponent(new URL(q.url).pathname.split('/rest/v1/')[1] || '');
  const off = everything.filter(q => !q.url.startsWith(base) || !api.READABLE_RELATIONS.has(rel(q)));
  check('…to /rest/v1/ on the public relation list, never an RPC', off.length === 0, off.map(q => q.url).slice(0, 3).join(' '));
  const embeds = everything.flatMap(q => [...(new URL(q.url).searchParams.get('select') || '').matchAll(/([a-z_]+)\(/g)].map(m => m[1]));
  check('…whose embedded relations are on the list too', embeds.length > 0 && embeds.every(e => api.READABLE_RELATIONS.has(e)), [...new Set(embeds)].join(', '));
  check('…each with the publishable key, the meganet profile and no Authorization', everything.every(q => q.headers.apikey === api.PUBLISHABLE_KEY
    && q.headers['accept-profile'] === 'meganet' && !q.headers.authorization));
  const coreJs = fs.readFileSync(repo('core.js'), 'utf8');
  const coreKey = (/const DB_ANON_KEY\s*=\s*'([^']+)'/.exec(coreJs) || [])[1];
  const coreOrigin = (/const DB_ORIGIN\s*=\s*'([^']+)'/.exec(coreJs) || [])[1];
  check('the key is the one core.js publishes, for the same project', coreKey === api.PUBLISHABLE_KEY && api.SUPABASE_REST_URL === `${coreOrigin}/rest/v1`,
    `${coreKey} ${coreOrigin}`);
  const privateRels = ['reading_raw', 'app_user', 'editor_allow', 'ingest_token', 'inspection', 'field_photo', 'stations_json'];
  check('none of the private relations is on the read list', privateRels.every(r => !api.READABLE_RELATIONS.has(r)));

  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    stub.requests = [];
    const r = await send('/api/v1/stations', { method: m, body: m === 'DELETE' ? undefined : '{}', headers: { 'Content-Type': 'application/json' } });
    check(`${m} to the REST API is 405 and reaches nothing`, r.status === 405 && /GET/.test(r.headers.get('allow') || '') && stub.requests.length === 0,
      `${r.status} ${r.headers.get('allow')}`);
  }
}

// ── CORS, HEAD, ETag ─────────────────────────────────────────────────────────
section('CORS, HEAD, ETag');

{
  const pre = await send('/api/v1/stations', { method: 'OPTIONS', headers: { Origin: 'https://example.org',
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-floodnet-client' } });
  check('a preflight is 204 with open CORS for GET', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*'
    && pre.headers.get('access-control-allow-methods') === 'GET, HEAD, OPTIONS' && /x-floodnet-client/i.test(pre.headers.get('access-control-allow-headers')));
  const mpre = await send('/api/mcp', { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type, mcp-protocol-version' } });
  check('the MCP preflight allows POST', mpre.status === 204 && mpre.headers.get('access-control-allow-methods') === 'POST, OPTIONS');
  const badPre = await send('/api/mcp', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } });
  check('an MCP preflight from an opaque origin is refused', badPre.status === 403);

  const g = await get(`/api/v1/stations/${RICH.id}`);
  const h = await send(`/api/v1/stations/${RICH.id}`, { method: 'HEAD' });
  check('HEAD answers the headers of GET with no body', h.status === 200 && h.text === '' && h.headers.get('content-type').startsWith('application/json'));
  const etag = g.headers.get('etag');
  const again = await get('/api/v1/', { headers: {} });
  const same = await get('/api/v1/networks');
  await new Promise(resolve => setTimeout(resolve, 5));   // so the two answers' generated_at differ
  const cond = await get('/api/v1/networks', { headers: { 'If-None-Match': same.headers.get('etag') } });
  check('If-None-Match with the current ETag is 304', cond.status === 304 && cond.text === '' && etag && again.status === 200, `${cond.status}`);
}

// ── Throttling ───────────────────────────────────────────────────────────────
section('Throttling');

{
  api.resetApiState();
  const ip = '203.0.113.9';
  let first429 = null;
  for (let i = 1; i <= 21; i++) {
    const r = await get('/api/v1/', { ip });
    if (r.status === 429 && !first429) first429 = { i, r };
  }
  const burst = api.RATE_LIMITS.find(r => r.name === 'burst');
  check(`the isolate limiter lets ${burst.limit} through in ${burst.period} s and stops the next`, first429 && first429.i === burst.limit + 1, first429 && `#${first429.i}`);
  const r = first429.r;
  check('a 429 carries Retry-After and a JSON body saying how long', /^\d+$/.test(r.headers.get('retry-after') || '')
    && Number(r.headers.get('retry-after')) >= 1 && r.json.retry_after === Number(r.headers.get('retry-after')) && r.json.error === 'rate limited',
    `${r.headers.get('retry-after')} ${r.json && r.json.detail}`);
  check('…names the limiter that answered', r.headers.get('x-ratelimit-limiter') === 'isolate');
  const other = await get('/api/v1/', { ip, headers: { 'X-FloodNet-Client': 'report-bot' } });
  check('a named client behind the same address has its own allowance', other.status === 200 && other.headers.get('x-floodnet-client') === 'report-bot');
  const viaQuery = await get('/api/v1/?client=second-bot', { ip });
  check('…and so does one named with ?client=', viaQuery.status === 200 && viaQuery.headers.get('x-floodnet-client') === 'second-bot');
  const legacy = await get('/api/v1/', { ip, headers: { 'X-MegaNet-Client': 'old-bot' } });
  check('…and one still naming itself with the header\'s old name, X-MegaNet-Client', legacy.status === 200 && legacy.headers.get('x-floodnet-client') === 'old-bot');

  api.resetApiState();
  const addr = api.RATE_LIMITS.find(x => x.name === 'address');
  let tripped = null, n = 0;
  for (let c = 0; c < 20 && !tripped; c++) {
    for (let i = 0; i < 19 && !tripped; i++) {
      n++;
      const x = await get('/api/v1/', { ip: '203.0.113.10', headers: { 'X-FloodNet-Client': `bot-${c}` } });
      if (x.status === 429) tripped = { n, x };
    }
  }
  check(`the address ceiling (${addr.limit} / ${addr.period} s) holds against a caller minting client names`, tripped && tripped.n === addr.limit + 1
    && /address limit/.test(tripped.x.json.detail), tripped && `#${tripped.n}`);
}

{
  api.resetApiState();
  const counts = new Map();
  const binding = limit => ({ async limit({ key }) { const k = `${limit}|${key}`; counts.set(k, (counts.get(k) || 0) + 1); return { success: counts.get(k) <= limit }; } });
  const env = { API_RATE_LIMIT: binding(60), API_BURST_LIMIT: binding(20), API_IP_LIMIT: binding(240) };
  let first429 = null;
  for (let i = 1; i <= 21 && !first429; i++) {
    const r = await get('/api/v1/', { ip: '203.0.113.11', env });
    if (r.status === 429) first429 = { i, r };
  }
  check('with the bindings present, Cloudflare\'s limiter answers', first429 && first429.i === 21 && first429.r.headers.get('x-ratelimit-limiter') === 'cloudflare'
    && first429.r.headers.get('retry-after') === '10', first429 && `#${first429.i} ${first429.r.headers.get('retry-after')}`);
  const keys = [...counts.keys()].map(k => k.split('|')[1]);
  check('the limiter keys are hashes, not addresses', keys.every(k => /^[ca]:[0-9a-f]{32}$/.test(k)) && !keys.some(k => k.includes('203.0.113')));

  const throwing = { API_RATE_LIMIT: { limit: async () => { throw new Error('binding down'); } }, API_BURST_LIMIT: binding(20), API_IP_LIMIT: binding(240) };
  const t = await get('/api/v1/', { ip: '203.0.113.12', env: throwing });
  check('a binding that errors falls back to the isolate for its rule', t.status === 200 && t.headers.get('x-ratelimit-limiter') === 'mixed');

  api.resetApiState();
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await rpc('ping', undefined, { ip: '203.0.113.13' });
    if (r.status === 429) limited = r;
  }
  check('MCP is limited too: 429 with a JSON-RPC -32000 error carrying retry_after', limited && limited.json.error.code === -32000
    && limited.json.error.data.retry_after >= 1 && limited.headers.get('retry-after'), limited && JSON.stringify(limited.json.error.data));
  api.resetApiState();
  const batch = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
  await mcp(batch, { ip: '203.0.113.14' });
  await mcp(batch, { ip: '203.0.113.14' });
  const third = await mcp(batch, { ip: '203.0.113.14' });
  check('every message in a batch counts against the limit', third.status === 429 && Array.isArray(third.json) && third.json.every(e => e.error.code === -32000),
    `${third.status}`);
  api.resetApiState();
}

// ── MCP ──────────────────────────────────────────────────────────────────────
section('MCP');

{
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const res = init.json.result;
  check('initialize echoes a supported protocol version', init.status === 200 && res.protocolVersion === '2025-06-18', res && res.protocolVersion);
  check('…declares tools and no list-change notifications', res.capabilities.tools && res.capabilities.tools.listChanged === false);
  check('…names the server and gives instructions', res.serverInfo.name === 'floodnet' && /READ-ONLY/.test(res.instructions) && /dossier/.test(res.instructions));
  check('…and mints no session', !init.headers.get('mcp-session-id'));
  const future = await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('an unknown version in initialize is answered with the latest legacy one', future.json.result.protocolVersion === '2025-11-25');
  const old = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
  check('2025-03-26 is accepted', old.json.result.protocolVersion === '2025-03-26');

  const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('a notification is 202 with no body', note.status === 202 && note.text === '');
  const ping = await rpc('ping');
  check('ping answers an empty result', ping.status === 200 && ping.json.result && ping.json.result.resultType === 'complete');

  const list = await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-06-18' } });
  const tools = list.json.result.tools;
  const expected = ['search_stations', 'get_station', 'get_station_dossier', 'stations_near', 'get_readings', 'get_latest_readings',
    'list_catchments', 'get_catchment', 'get_flood_levels', 'get_service_level', 'list_networks'];
  check('tools/list has every tool', expected.every(n => tools.some(t => t.name === n)) && tools.length === expected.length, tools.map(t => t.name).join(', '));
  check('every tool is annotated read-only and has an object input schema', tools.every(t => t.annotations.readOnlyHint === true
    && t.annotations.destructiveHint === false && t.inputSchema.type === 'object' && t.description.length > 40));
  check('tool names follow the spec\'s character rule', tools.every(t => /^[A-Za-z0-9_.-]{1,128}$/.test(t.name)));

  for (const t of api.MCP_TOOLS) {
    const r = await rpc('tools/call', { name: t.name, arguments: toolArgs(t.name) });
    const out = r.json && r.json.result;
    let parsed = null;
    try { parsed = JSON.parse(out.content[0].text); } catch (_) { /* below */ }
    check(`tools/call ${t.name} answers text and matching structuredContent`, r.status === 200 && out && out.isError === false
      && out.content[0].type === 'text' && JSON.stringify(parsed) === JSON.stringify(out.structuredContent),
      out && out.isError ? out.content[0].text.slice(0, 160) : `status ${r.status}`);
  }
  const dossierTool = await rpc('tools/call', { name: 'get_station_dossier', arguments: { id: RICH.station_number } });
  check('the dossier tool takes a Bureau number too', dossierTool.json.result.structuredContent.id === RICH.id);

  const missing = await rpc('tools/call', { name: 'get_station', arguments: {} });
  check('a missing required argument is a tool error the model can read', missing.json.result.isError === true && /Missing required argument "id"/.test(missing.json.result.content[0].text));
  const extra = await rpc('tools/call', { name: 'get_station', arguments: { id: RICH.id, verbose: true } });
  check('an unknown argument is a tool error naming the accepted ones', extra.json.result.isError === true && /Accepted: id/.test(extra.json.result.content[0].text));
  const range = await rpc('tools/call', { name: 'stations_near', arguments: { lat: 123, lon: 150 } });
  check('an out-of-range argument is a tool error', range.json.result.isError === true);
  const notFound = await rpc('tools/call', { name: 'get_station', arguments: { id: 'no_such_station_here' } });
  check('a station that does not exist is a tool error with advice', notFound.json.result.isError === true && /404/.test(notFound.json.result.content[0].text));
  const window = await rpc('tools/call', { name: 'get_readings', arguments: { id: RICH.id, resolution: 'raw', from: day(NOW - 9 * 24 * hour) } });
  check('a reading window over the cap is a tool error', window.json.result.isError === true && /7 days/.test(window.json.result.content[0].text));
  const coerced = await rpc('tools/call', { name: 'search_stations', arguments: { q: RICH.station_number, limit: '2' } });
  check('a number sent as a string is accepted', coerced.json.result.isError === false && coerced.json.result.structuredContent.limit === 2);

  const unknownTool = await rpc('tools/call', { name: 'drop_tables', arguments: {} });
  check('an unknown tool is JSON-RPC -32602', unknownTool.json.error && unknownTool.json.error.code === -32602 && /Unknown tool/.test(unknownTool.json.error.message));
  const noName = await rpc('tools/call', { arguments: {} });
  check('tools/call without a name is -32602', noName.json.error && noName.json.error.code === -32602);
  const badArgs = await rpc('tools/call', { name: 'get_station', arguments: 'gympie' });
  check('arguments that are not an object is -32602', badArgs.json.error && badArgs.json.error.code === -32602);
  const badParams = await mcp({ jsonrpc: '2.0', id: 77, method: 'tools/list', params: [1, 2] });
  check('params that are not an object is -32602', badParams.json.error && badParams.json.error.code === -32602);
  const unknownMethod = await rpc('resources/list');
  check('an unknown method is -32601', unknownMethod.status === 200 && unknownMethod.json.error.code === -32601);

  const batch = await mcp([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]);
  check('a batch answers each request and not the notification', batch.status === 200 && Array.isArray(batch.json) && batch.json.length === 2
    && batch.json[0].id === 'a' && batch.json[1].id === 'b');
  const notes = await mcp([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }]);
  check('a batch of notifications is 202', notes.status === 202);
  const emptyBatch = await mcp([]);
  check('an empty batch is -32600', emptyBatch.status === 400 && emptyBatch.json.error.code === -32600);
  const huge = await mcp(Array.from({ length: 11 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })));
  check('a batch over 10 is refused', huge.status === 400 && huge.json.error.code === -32600);
  const parse = await mcp('{"jsonrpc": "2.0", "id": 1, "method": ');
  check('a body that is not JSON is -32700', parse.status === 400 && parse.json.error.code === -32700);
  const notRpc = await mcp({ hello: 'world' });
  check('JSON that is not JSON-RPC is -32600', notRpc.status === 400 && notRpc.json.error.code === -32600);
  const nullId = await mcp({ jsonrpc: '2.0', id: null, method: 'ping' });
  check('a null id is refused', nullId.status === 400 && nullId.json.error.code === -32600);

  const getMcp = await send('/api/mcp');
  check('GET /api/mcp is 405 with Allow: POST', getMcp.status === 405 && /POST/.test(getMcp.headers.get('allow')), getMcp.headers.get('allow'));
  const del = await send('/api/mcp', { method: 'DELETE' });
  check('DELETE /api/mcp is 405 (no sessions to end)', del.status === 405);
  const plain = await send('/api/mcp', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } });
  check('a body that is not application/json is 415', plain.status === 415);
  const bigBody = await send('/api/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70000) } }),
    headers: MCP_HEADERS });
  check('a body over 64 KB is 413', bigBody.status === 413);
  const chunks = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(8192))); c.close(); } });
  const chunked = await worker.fetch(new Request('https://floodwarning.net/api/mcp', { method: 'POST', body: chunks, duplex: 'half',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': freshIp() } }), {}, ctx);
  check('a chunked body over 64 KB with no Content-Length is refused without being buffered', chunked.status === 413, `${chunked.status}`);

  const https = await rpc('ping', undefined, { headers: { Origin: 'https://claude.ai' } });
  const local = await rpc('ping', undefined, { headers: { Origin: 'http://localhost:6274' } });
  const evil = await rpc('ping', undefined, { headers: { Origin: 'http://evil.example' } });
  const opaque = await rpc('ping', undefined, { headers: { Origin: 'null' } });
  check('Origin: https and localhost are fine, plain http from elsewhere and "null" are 403',
    https.status === 200 && local.status === 200 && evil.status === 403 && opaque.status === 403, `${https.status} ${local.status} ${evil.status} ${opaque.status}`);

  const unsupported = await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2099-01-01' } });
  check('an unsupported MCP-Protocol-Version header is 400 with the supported list', unsupported.status === 400
    && unsupported.json.error.code === -32022 && unsupported.json.error.data.supported.includes('2025-06-18'), JSON.stringify(unsupported.json.error));
  const noHeader = await rpc('tools/list', {});
  check('no MCP-Protocol-Version header is taken as 2025-03-26 and served', noHeader.status === 200
    && noHeader.json.result.tools.length === api.MCP_TOOLS.length);
}

{
  // The 2026-07-28 revision: no handshake, metadata on every request, mirrored in headers.
  const V = '2026-07-28';
  const meta = { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1' } };
  const modern = (method, params = {}, extraHeaders = {}) => rpc(method, { ...params, _meta: meta },
    { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': method, ...extraHeaders } });

  const disc = await modern('server/discover');
  const d = disc.json.result;
  check('2026-07-28: server/discover lists the versions, capabilities and instructions', disc.status === 200 && d.supportedVersions.includes(V)
    && d.supportedVersions.includes('2025-06-18') && d.capabilities.tools && d.instructions && d.resultType === 'complete', JSON.stringify(d.supportedVersions));
  check('…and names the server in _meta', d._meta['io.modelcontextprotocol/serverInfo'].name === 'floodnet');
  const tl = await modern('tools/list');
  check('2026-07-28: tools/list is cacheable (ttlMs, cacheScope)', tl.status === 200 && tl.json.result.ttlMs > 0 && tl.json.result.cacheScope === 'public'
    && tl.json.result.resultType === 'complete');
  const call = await modern('tools/call', { name: 'get_station', arguments: { id: RICH.id } }, { 'Mcp-Name': 'get_station' });
  check('2026-07-28: tools/call with matching Mcp-Name works', call.status === 200 && call.json.result.isError === false);
  const b64 = await modern('tools/call', { name: 'get_station', arguments: { id: RICH.id } },
    { 'Mcp-Name': `=?base64?${Buffer.from('get_station').toString('base64')}?=` });
  check('2026-07-28: a Base64-sentinel Mcp-Name is decoded before comparing', b64.status === 200 && b64.json.result.isError === false);
  const noMethod = await rpc('tools/list', { _meta: meta }, { headers: { 'MCP-Protocol-Version': V } });
  check('2026-07-28: a missing Mcp-Method header is 400 HeaderMismatch (-32020)', noMethod.status === 400 && noMethod.json.error.code === -32020);
  const wrongName = await modern('tools/call', { name: 'get_station', arguments: { id: RICH.id } }, { 'Mcp-Name': 'get_station_dossier' });
  check('2026-07-28: an Mcp-Name that disagrees with the body is 400 -32020', wrongName.status === 400 && wrongName.json.error.code === -32020);
  const noName = await modern('tools/call', { name: 'get_station', arguments: { id: RICH.id } });
  check('2026-07-28: a tools/call without Mcp-Name is 400 -32020', noName.status === 400 && noName.json.error.code === -32020);
  const hdrMismatch = await rpc('tools/list', { _meta: meta }, { headers: { 'MCP-Protocol-Version': '2025-06-18', 'Mcp-Method': 'tools/list' } });
  check('2026-07-28: a version header that disagrees with _meta is 400 -32020', hdrMismatch.status === 400 && hdrMismatch.json.error.code === -32020);
  const noCaps = await rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': V } },
    { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' } });
  check('2026-07-28: missing clientCapabilities is 400 -32602', noCaps.status === 400 && noCaps.json.error.code === -32602);
  const noMeta = await rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' } });
  check('2026-07-28: a modern header with no _meta is 400 -32602', noMeta.status === 400 && noMeta.json.error.code === -32602);
  const future = await rpc('tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' } },
    { headers: { 'MCP-Protocol-Version': '2027-01-01', 'Mcp-Method': 'tools/list' } });
  check('2026-07-28: an unknown future version is 400 UnsupportedProtocolVersion (-32022) listing ours', future.status === 400
    && future.json.error.code === -32022 && future.json.error.data.requested === '2027-01-01');
  const unknownMethod = await modern('resources/list');
  check('2026-07-28: an unknown method is HTTP 404 with -32601', unknownMethod.status === 404 && unknownMethod.json.error.code === -32601);
}

// ── Upstream failures ────────────────────────────────────────────────────────
section('Upstream failures');

{
  // Cold each time: a vocabulary remembered from earlier would answer without asking.
  const failing = (make) => { api.resetApiState(); stub.fault = make; };
  failing(() => new TypeError('fetch failed'));
  const down = await get(`/api/v1/stations/${RICH.id}`);
  check('an unreachable database is 502, and says a paused project is the usual cause', down.status === 502 && /pauses after 7 days/.test(down.json.detail));
  failing(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  const slow = await get('/api/v1/stations?q=creek');
  check('a timed-out read is 504', slow.status === 504 && /10 s/.test(slow.json.detail));
  failing(() => new Response('{"message":"upstream exploded"}', { status: 503 }));
  const five = await get('/api/v1/networks?');
  check('a 5xx from the database is 503 with Retry-After', five.status === 503 && five.headers.get('retry-after') === '30' && /exploded/.test(five.json.detail));
  failing(() => new Response('{"code":"42703","message":"column station.nope does not exist"}', { status: 400 }));
  const refused = await get(`/api/v1/stations/${SPARSE.id}`);
  check('a query the database refuses is 502 asking for an issue', refused.status === 502 && /issue/.test(refused.json.detail));
  failing(() => new TypeError('fetch failed'));
  const tool = await rpc('tools/call', { name: 'get_station_dossier', arguments: { id: RICH.id } });
  check('a tool call during an outage is a tool error, not a protocol error', tool.json.result && tool.json.result.isError === true
    && /paused|reached/.test(tool.json.result.content[0].text));
  stub.fault = null;
  const errorsNotCached = await get(`/api/v1/stations/${RICH.id}`);
  check('errors are not cached: the next read succeeds', errorsNotCached.status === 200);
}

// ── The edge cache ───────────────────────────────────────────────────────────
section('Edge cache');

{
  class FakeCache {
    constructor() { this.store = new Map(); }
    async match(req) { const k = typeof req === 'string' ? req : req.url; const v = this.store.get(k); return v ? new Response(v.body, { headers: v.headers }) : undefined; }
    async put(req, res) { const k = typeof req === 'string' ? req : req.url; this.store.set(k, { body: await res.text(), headers: Object.fromEntries(res.headers) }); }
  }
  const cache = new FakeCache();
  globalThis.caches = { default: cache };
  api.resetApiState();
  const waits = [];
  const ctxWait = { waitUntil: p => waits.push(p) };
  const call = async p => { const r = await worker.fetch(new Request(`https://floodwarning.net${p}`, { headers: { 'CF-Connecting-IP': freshIp() } }), {}, ctxWait); await Promise.all(waits); return r; };
  stub.requests = [];
  const first = await call(`/api/v1/stations/${RICH.id}/dossier`);
  const readsFirst = stub.requests.length;
  stub.requests = [];
  const second = await call(`/api/v1/stations/${RICH.id}/dossier`);
  check('a repeated question is answered from the edge cache without the database', first.headers.get('x-floodnet-cache') === 'miss'
    && second.headers.get('x-floodnet-cache') === 'hit' && stub.requests.length === 0 && readsFirst > 0, `${readsFirst} then ${stub.requests.length}`);
  const toolCall = await rpc('tools/call', { name: 'get_station_dossier', arguments: { id: RICH.id } });
  check('an MCP tool call shares the REST answer\'s cache entry', toolCall.json.result.isError === false && stub.requests.length === 0);
  const vocabCached = [...cache.store.keys()].some(k => k.startsWith(`${api.SUPABASE_REST_URL}/catchment?`));
  check('the vocabularies are cached at the edge too, by their upstream URL', vocabCached);
  const withClient = await call(`/api/v1/stations/${RICH.id}/dossier?client=someone`);
  check('?client= is not part of the cache key', withClient.headers.get('x-floodnet-cache') === 'hit');
  const geoMiss = await call('/api/v1/readings/latest?format=geojson');
  const geoHit = await call('/api/v1/readings/latest?format=geojson');
  const jsonHit = await call('/api/v1/readings/latest');
  check('a GeoJSON answer from the edge cache is application/geo+json still, and the JSON one its own entry',
    geoMiss.headers.get('x-floodnet-cache') === 'miss' && geoHit.headers.get('x-floodnet-cache') === 'hit'
      && /^application\/geo\+json/.test(geoHit.headers.get('content-type'))
      && jsonHit.headers.get('x-floodnet-cache') === 'miss' && /^application\/json/.test(jsonHit.headers.get('content-type')),
    `${geoHit.headers.get('x-floodnet-cache')} ${geoHit.headers.get('content-type')}`);
  stub.fault = () => new TypeError('fetch failed');
  const failed = await call(`/api/v1/stations/${SPARSE.id}`);
  stub.fault = null;
  const after = await call(`/api/v1/stations/${SPARSE.id}`);
  check('an error is never cached: the next ask goes to the database and succeeds', failed.status === 502 && after.status === 200
    && after.headers.get('x-floodnet-cache') === 'miss', `${failed.status} then ${after.status} ${after.headers.get('x-floodnet-cache')}`);
  delete globalThis.caches;
}

// ── The routes that were here before ─────────────────────────────────────────
section('The existing routes');

{
  check('the database proxy still maps its paths', dbProxyTarget('/api/db/rest/v1/app_meta', '?select=value')
    === 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/app_meta?select=value');
  const session = await send('/api/session');
  check('GET /api/session is still 405 "POST only"', session.status === 405 && session.json.error === 'POST only');
  const sessionPost = await send('/api/session', { method: 'POST' });
  check('POST /api/session without its secrets is still 503', sessionPost.status === 503 && /SUPABASE_SECRET_KEY/.test(sessionPost.json.error));
  const nothing = await send('/api/elsewhere');
  check('any other path is still a plain 404', nothing.status === 404 && nothing.text === 'Not found');
  check('the API only claims its own paths', api.isApiPath('/api/v1') && api.isApiPath('/api/v1/stations') && api.isApiPath('/api/mcp')
    && !api.isApiPath('/api/v10') && !api.isApiPath('/api/mcpx') && !api.isApiPath('/api/db/rest/v1') && !api.isApiPath('/api/session'));
  stub.requests = [];
  const proxied = await send('/api/db/rest/v1/app_meta?select=value', { headers: { apikey: 'k', 'Accept-Profile': 'meganet', Authorization: 'Bearer user-token' } });
  check('the proxy still forwards the caller\'s own token (that is its job, and not the API\'s)', proxied.status === 200
    && stub.requests[0] && stub.requests[0].headers.authorization === 'Bearer user-token');
}

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log('');
const bad = results.filter(r => !r.ok);
if (VERBOSE) console.log('');
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} check(s) failed.\n`);
  console.log('  The agent API is a public door with no identity in front of it: a check that');
  console.log('  fails here is either a query the database will refuse, a limit that no longer');
  console.log('  holds, or — worst — something read or forwarded that should not be.\n');
  process.exit(1);
}
console.log(`PASS — ${results.length} checks: every route and tool answers in shape, reads only public relations with the publishable key, and holds its limits.`);
