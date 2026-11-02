// resends.js — Taking the ELPRO gateway's re-sent table back out of its legacy
// ALERT messages, so a value it has already published once is not stored again
// as a reading nobody sent.
//
// What the gateway does (measured on the live feed, 2 November 2026: 55
// messages on `…/reading/elpro/Alert1` in an hour, 57 fresh reports in them
// and 504 entries in all). It keeps a table of every ALERT address it
// has heard and that address's last value, newest address first:
//
//   - A report from an address already in the table updates the value in
//     place, and the message carries that one report:
//       [712:28]
//   - A report from an address not yet in the table goes on the front, and the
//     message carries the WHOLE table, every entry stamped with this publish's
//     time:
//       [760:1053  710:89  759:133  712:28]
//        ^ fresh   ^ re-sent, already published, restamped
//     Several new addresses heard together go on the front together:
//       [614:1498  616:136  615:14  768:136 …]
//   - Every so often the table empties and starts again (twice in that hour).
//
// Stored as they arrive, the re-sent entries would say every address in the
// table reported again each time any new one did — a station that went quiet
// an hour ago would keep looking heard, which is the one thing a flood-warning
// network must not be told. The database's own dedupe cannot catch them: it
// merges copies of one value within seconds of each other (0096), and these
// come minutes later under a new time. Nor can the parser, because the entries
// carry nothing that marks them: the only way to tell a re-send is to remember
// what was sent before. So this module remembers, per topic, the last value
// seen for each address, and keeps from each message:
//
//   1. its first entry, always — the report that made the gateway publish;
//   2. the entries straight after it that are not a value already seen — new
//      addresses heard in the same moment — up to the first that is;
//   3. after that, only an entry whose value differs from the one remembered —
//      a change this process somehow missed, which is a value never stored.
//
// A message of one entry is always one fresh report and is kept whole. A
// second copy of a burst (via a repeater, a second or two later) is kept too;
// the database's copy window takes it as the same reading, which is its job.
//
// **A cold start keeps less, never more.** Just after the bridge starts it
// knows no table, and a whole-table message cannot be split by anything in it.
// So until it has seen one whole-table message for a topic it keeps only that
// message's first entry and learns the rest. The cost is a new address that
// happened to arrive alongside the first one in that one message — still in
// the raw row, every byte, because the envelope's `frame` is untouched. The
// alternative, keeping everything, is a burst of readings that never happened.
//
// The memory is a Map per topic and lives only as long as the process; it is
// small (one number per ALERT address) and bounded in topics.

const DEFAULT_MAX_TABLES = 256;

function createResendFilter({ maxTables = DEFAULT_MAX_TABLES } = {}) {
  // topic → { values: Map<alert_id, value_raw>, warm: boolean }
  const tables = new Map();

  function tableFor(key) {
    let table = tables.get(key);
    if (table) {
      // Most recently used last, so the first key is the one to evict.
      tables.delete(key);
      tables.set(key, table);
      return table;
    }
    table = { values: new Map(), warm: false };
    tables.set(key, table);
    while (tables.size > maxTables) tables.delete(tables.keys().next().value);
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
   * were taken out as already sent (or, on a cold start, as not knowable).
   */
  function fresh(key, readings) {
    const table = tableFor(key);
    const known = table.values;
    const isAlert = (r) => r && Number.isInteger(r.alert_id);
    const seen = (r) => known.has(r.alert_id) && known.get(r.alert_id) === r.value_raw;

    const alerts = readings.filter(isAlert);
    let kept;
    if (alerts.length <= 1) {
      kept = alerts;
    } else if (!table.warm) {
      kept = [alerts[0]];
    } else {
      kept = [alerts[0]];
      let i = 1;
      for (; i < alerts.length && !seen(alerts[i]); i += 1) kept.push(alerts[i]);
      for (; i < alerts.length; i += 1) {
        const r = alerts[i];
        if (known.has(r.alert_id) && known.get(r.alert_id) !== r.value_raw) kept.push(r);
      }
    }

    // Learn after deciding, so a message is judged against what came before it
    // and never against itself.
    for (const r of alerts) known.set(r.alert_id, r.value_raw);
    if (alerts.length > 1) table.warm = true;

    const keep = new Set(kept);
    return {
      readings: readings.filter((r) => !isAlert(r) || keep.has(r)),
      resent: alerts.length - kept.length,
    };
  }

  return { fresh, size: () => tables.size };
}

module.exports = { createResendFilter, DEFAULT_MAX_TABLES };
