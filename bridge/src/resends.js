// resends.js — Taking the ELPRO gateway's re-sent table back out of its legacy
// ALERT messages, so a value it has already published once is not stored again
// as a reading nobody sent.
//
// What the gateway does (measured on the live feed, 2 November 2026: every
// message on `…/reading/elpro/Alert1` from 23:38 to 03:05 UTC, 85 of them with
// more than one entry). It keeps a table of every ALERT address it has heard and
// that address's last value, newest address first, and publishes the reports
// that arrive together as one message:
//
//   - If every report in it is from an address already in the table, the values
//     are updated in place and the message is just those reports — usually one,
//     sometimes a station's sensors heard in the same instant:
//       [712:28]          [614:1498  616:136  615:14]
//   - If any is from an address not yet in the table, it goes on the front and
//     the message carries the WHOLE table after it, every entry restamped with
//     this publish's time:
//       [760:1053  710:89  759:133  712:28]
//        ^ fresh   ^ re-sent, already published, restamped
//   - Every so often the table empties (three times in the first 70 minutes),
//     and it fills again from scratch: the first report alone, then each new
//     address on the front of a growing table.
//
// Stored as they arrive, the re-sent entries would say every address in the
// table reported again each time any new one did — a station that went quiet
// an hour ago would keep looking heard, which is the one thing a flood-warning
// network must not be told. The database's own dedupe cannot catch them: it
// merges copies of one value within seconds of each other (0096), and these
// come minutes later under a new time.
//
// The re-sent part has a shape, though, and it held for all 85 messages: it is
// the previous table, address for address, in the same order, at the end of the
// message. So this module remembers, per topic, the last table it saw (and the
// message before, for a table that has just emptied and is growing again) and:
//
//   1. A message of one entry is one fresh report, kept. (A second copy of a
//      burst a second later is kept too; the database's copy window takes it as
//      the same reading, which is its job.)
//   2. A message that ends with the last table is a table: the entries in front
//      of it are fresh, the rest re-sent. An entry in the re-sent part whose
//      value differs from the one remembered is kept as well — a change this
//      process missed is a value never stored. More than BATCH_MAX in front is
//      not a moment's reports but messages this process missed, and falls to
//      rule 5.
//   3. A message that ends only with the previous message is a table growing
//      again after it emptied; the evidence is weaker (a table that happens to
//      end with the address of the single report before it looks the same), so
//      only its first entry is taken as fresh.
//   4. A short message that ends with neither — at most BATCH_MAX entries — is
//      reports that arrived together, all kept. An ALERT station's sensors are a
//      handful; the largest batch seen was three, against tables of forty-odd.
//   5. Anything else — a long message the table does not explain, or any
//      message before a table has been seen — keeps its first entry only, and
//      becomes the table if it is long enough to be one.
//
// **Not knowing keeps less, never more.** Just after the bridge starts it knows
// no table, so a message with more than one entry cannot be split by anything in
// it; rule 5 keeps the first entry, the report that made the gateway publish.
// The cost is a report that arrived alongside it — still in the raw row, every
// byte, because the envelope's `frame` is untouched. The alternative, keeping
// everything, is a burst of readings that never happened. The gateway's
// retained message, delivered as the bridge subscribes, is usually a table and
// sets the shape straight away.
//
// The memory is a Map per topic and lives only as long as the process; it is
// small (one number per ALERT address) and bounded in topics.
//
// ── The ALERT2 relay path (`…/elpro/Station NNNN`): copies only ─────────────
//
// The gateway does NOT republish ALERT2. Every set carries the relayed
// station's own `AlertTimestamp` (messages.js keeps it beside the reading), and
// on 2 November 2026 this file took a set with the same stamp and value as the
// slot's last one, minutes or hours later, as the gateway repeating itself.
// That was wrong, and was taken back the next day (0098): each bench station
// has its own rhythm — Station 1000 every 15 minutes, 1001-1003 about hourly —
// and their values change between messages while the bench units' stamps stay
// put for hours. So a repeated stamp there is a clock that has not moved, not a
// publish nobody asked for. (Real ALERT2 stations do move it every time: all
// 201,754 bursts the network heard in the three days before carried one, and a
// station's stamp only ever came back within two minutes, relayed.)
//
// What does repeat is the same burst published twice in quick succession —
// about half of 1001-1003's messages have a twin within 10 s, the same stamp
// and values. So per topic each sensor slot's last set is remembered as stamp,
// value and time, and a set with the same stamp and value within A2_COPY_MS of
// that first sighting is a copy: posted under the first sighting's time, so the
// database counts it on that reading (dup_count), as it counts any copy.
// Everything else is a reading. A set with no AlertTimestamp (Station 1003's
// frames carry none) is passed through untouched: there is nothing to tell a
// copy by.

const { alertStampOf } = require('./messages');

const DEFAULT_MAX_TABLES = 256;
// The most reports a message can carry and still be read as reports that
// arrived together rather than a table this process has lost track of (rule 4).
const BATCH_MAX = 8;
const A2_COPY_MS = 10 * 1000;

function createResendFilter({ maxTables = DEFAULT_MAX_TABLES } = {}) {
  // Legacy: topic → { values: Map<alert_id, value_raw>, order: alert_id[] | null,
  //                    prev: alert_id[] | null } — the last table, the last message
  // ALERT2: topic → { values: Map<a2_sensor, {stamp, value, ts, at}> }
  const tables = new Map();
  const a2Tables = new Map();

  function tableFor(key, map = tables) {
    let table = map.get(key);
    if (table) {
      // Most recently used last, so the first key is the one to evict.
      map.delete(key);
      map.set(key, table);
      return table;
    }
    table = { values: new Map(), order: null, prev: null };
    map.set(key, table);
    while (map.size > maxTables) map.delete(map.keys().next().value);
    return table;
  }

  /**
   * The readings in one message that are fresh reports, in their own order.
   *
   * `readings` are what parseElpro() made of one legacy ALERT message, in the
   * order the gateway wrote them. Anything without an `alert_id` is passed
   * through untouched — this only knows about the ALERT table.
   *
   * Returns `{readings, resent}`: the readings to store, and how many entries
   * were taken out as already sent (or, not knowing the table, as not knowable).
   */
  function fresh(key, readings) {
    const table = tableFor(key);
    const known = table.values;
    const isAlert = (r) => r && Number.isInteger(r.alert_id);

    const alerts = readings.filter(isAlert);
    const addrs = alerts.map((r) => r.alert_id);
    const n = alerts.length;

    // How many leading entries are fresh; the rest are the re-sent table.
    let lead = n;
    if (n > 1) {
      if (endsWith(addrs, table.order) && n - table.order.length <= BATCH_MAX) {
        lead = n - table.order.length;                 // rule 2
        table.order = addrs;
      } else if (endsWith(addrs, table.prev)) {
        lead = 1;                                      // rule 3
        table.order = addrs;
      } else if (table.order !== null && n <= BATCH_MAX) {
        lead = n;                                      // rule 4
      } else {
        lead = 1;                                      // rule 5
        if (n > BATCH_MAX) table.order = addrs;
      }
    }

    const kept = alerts.slice(0, lead);
    for (const r of alerts.slice(lead)) {
      if (known.has(r.alert_id) && known.get(r.alert_id) !== r.value_raw) kept.push(r);
    }

    // Learn after deciding, so a message is judged against what came before it
    // and never against itself.
    for (const r of alerts) known.set(r.alert_id, r.value_raw);
    if (n > 0) table.prev = addrs;

    const keep = new Set(kept);
    return {
      readings: readings.filter((r) => !isAlert(r) || keep.has(r)),
      resent: n - kept.length,
    };
  }

  /**
   * One ALERT2 relay message's readings, with any copy of a set just seen
   * moved onto that set's time (see the header).
   *
   * `readings` are what parseElpro() made of the message, each with its
   * AlertTimestamp beside it. Returns `{readings, resent, copies}`: the
   * readings to post (all of them), none taken out (`resent` is always 0 here,
   * kept so the caller treats both paths alike), and how many were posted as
   * copies under their first sighting's time.
   */
  function freshA2(key, readings) {
    const known = tableFor(key, a2Tables).values;
    const out = [];
    let copies = 0;
    for (const r of readings) {
      const stamp = alertStampOf(r);
      if (stamp === null || !Number.isInteger(r.a2_sensor)) {
        out.push(r);
        continue;
      }
      // When, by the gateway's clock — its publish time, which is what the
      // reading carries; the receipt time stands in if it carried none.
      const at = msOf(r.reading_ts);
      const last = known.get(r.a2_sensor);
      if (last && last.stamp === stamp && last.value === r.value_raw
          && at >= last.at && at - last.at <= A2_COPY_MS) {
        out.push({ ...r, reading_ts: last.ts });
        copies += 1;
        continue;
      }
      known.set(r.a2_sensor, { stamp, value: r.value_raw, ts: r.reading_ts, at });
      out.push(r);
    }
    return { readings: out, resent: 0, copies };
  }

  return { fresh, freshA2, size: () => tables.size + a2Tables.size };
}

/** Does `list` end with all of `tail`, and have something in front of it? */
function endsWith(list, tail) {
  if (!tail || tail.length === 0 || list.length <= tail.length) return false;
  const at = list.length - tail.length;
  return tail.every((v, i) => list[at + i] === v);
}

function msOf(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Date.now();
}

module.exports = { createResendFilter, DEFAULT_MAX_TABLES, BATCH_MAX, A2_COPY_MS };
