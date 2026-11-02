const test = require('node:test');
const assert = require('node:assert/strict');

const { createResendFilter } = require('../src/resends');

// The live legacy ALERT feed from the bench gateway, 23:38–00:42 UTC on
// 1–2 November 2026: every message published to …/reading/elpro/Alert1 in that
// hour, in order, as address:value — read back out of meganet.reading_raw. The
// gateway writes a fresh report first and, when that report is from an address
// its table has not got yet, the whole table after it (resends.js).
const LIVE = [
  '712:27',
  '759:133 712:27',
  '710:89 759:133 712:27',
  '712:28',
  '760:1053 710:89 759:133 712:28',
  '761:135 760:1053 710:89 759:133 712:28',
  '713:143 761:135 760:1053 710:89 759:133 712:28',
  '746:451 713:143 761:135 760:1053 710:89 759:133 712:28',
  '747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:28',
  '724:905 747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:28',
  '712:29',
  '636:1153 724:905 747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:29',
  '637:179 636:1153 724:905 747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:29',
  '638:143 637:179 636:1153 724:905 747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:29',
  '706:9 638:143 637:179 636:1153 724:905 747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:29',
  '707:136 706:9 638:143 637:179 636:1153 724:905 747:136 746:451 713:143 761:135 760:1053 710:89 759:133 712:29',
  '712:31', // the gateway's table emptied before this one
  '762:120 712:31',
  '763:141 762:120 712:31',
  '741:130', // and again
  '748:886 741:130',
  '749:132 748:886 741:130',
  '712:32 749:132 748:886 741:130',
  '715:141 712:32 749:132 748:886 741:130',
  '710:90 715:141 712:32 749:132 748:886 741:130',
  '712:33',
  '702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '702:838', // the same burst again, a second later — a relayed copy
  '703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '703:136',
  '754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '710:90',
  '711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '752:1504 711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '753:139 752:1504 711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '765:89 753:139 752:1504 711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '768:136 765:89 753:139 752:1504 711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:33 749:132 748:886 741:130',
  '712:34',
  // Three new addresses heard in the same moment go on the front together.
  '614:1498 616:136 615:14 768:136 765:89 753:139 752:1504 711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:90 715:141 712:34 749:132 748:886 741:130',
  '712:35',
  '710:91',
  '712:37',
  '712:39',
  // 759 again: in the table an hour ago, not since it emptied — so it is a new
  // report, with the same value it had then.
  '759:133 614:1498 616:136 615:14 768:136 765:89 753:139 752:1504 711:140 745:136 744:1279 717:138 716:1 701:139 700:1047 757:138 756:853 751:140 750:1007 755:135 754:1479 703:136 702:838 710:91 715:141 712:39 749:132 748:886 741:130',
];

const TOPIC = 'meganet/v1/elpro_test/logger/reading/elpro/Alert1';

function frame(line, ts = 1) {
  return line.split(' ').map((pair) => {
    const [a, v] = pair.split(':').map(Number);
    return { alert_id: a, reading_ts: ts, value_raw: v };
  });
}
const label = (rs) => rs.map((r) => `${r.alert_id}:${r.value_raw}`).join(' ');

test('the live hour: every fresh report kept, every re-sent entry taken out', () => {
  const filter = createResendFilter();
  const kept = LIVE.map((line, i) => label(filter.fresh(TOPIC, frame(line, i)).readings));

  // Every message's first entry is the report that made the gateway publish.
  LIVE.forEach((line, i) => {
    assert.ok(kept[i].startsWith(line.split(' ')[0]), `message ${i} keeps its first entry`);
  });
  // The one message with three new addresses at its front keeps all three, and
  // nothing of the table behind them.
  assert.equal(kept[LIVE.findIndex((l) => l.startsWith('614:'))], '614:1498 616:136 615:14');
  // 55 messages, 57 fresh reports — out of 504 entries.
  const entries = LIVE.reduce((n, line) => n + line.split(' ').length, 0);
  const total = kept.reduce((n, k) => n + k.split(' ').length, 0);
  assert.equal(LIVE.length, 55);
  assert.equal(entries, 504);
  assert.equal(total, 57);
  // And every other message keeps exactly its first entry — nothing the table
  // re-sent got through.
  kept.forEach((k, i) => {
    if (LIVE[i].startsWith('614:')) return;
    assert.equal(k, LIVE[i].split(' ')[0], `message ${i}: ${LIVE[i]}`);
  });
});

test('resent counts what was taken out', () => {
  const filter = createResendFilter();
  filter.fresh(TOPIC, frame('759:133 712:27'));
  assert.deepEqual(filter.fresh(TOPIC, frame('710:89 759:133 712:27')).resent, 2);
  assert.deepEqual(filter.fresh(TOPIC, frame('712:28')).resent, 0);
});

test('a cold start keeps the first entry of a whole-table message, and learns the rest', () => {
  // Just after the bridge starts it knows no table, and nothing in the message
  // says which entries are fresh. Keeping only the first is the side that
  // cannot invent a reading; the raw row keeps every byte regardless.
  const filter = createResendFilter();
  const first = filter.fresh(TOPIC, frame('614:1498 616:136 615:14 768:136 712:34'));
  assert.equal(label(first.readings), '614:1498');
  assert.equal(first.resent, 4);

  // Warm from here on: the next whole-table message is judged properly.
  assert.equal(label(filter.fresh(TOPIC, frame('712:35')).readings), '712:35');
  assert.equal(label(filter.fresh(TOPIC, frame('759:133 614:1498 616:136 615:14 768:136 712:35')).readings),
    '759:133');
});

test('a single-entry message on a cold start is kept, and does not warm the table', () => {
  const filter = createResendFilter();
  assert.equal(label(filter.fresh(TOPIC, frame('712:39')).readings), '712:39');
  // Knowing one address is not knowing the table, so the next whole-table
  // message is still a cold one.
  assert.equal(label(filter.fresh(TOPIC, frame('759:133 614:1498 712:39')).readings), '759:133');
});

test('a value that changed without a message of its own is kept', () => {
  // Should not happen — the gateway publishes the change on its own first —
  // but if this process missed it, the table entry is a value never stored.
  const filter = createResendFilter();
  filter.fresh(TOPIC, frame('759:133 712:27'));
  assert.equal(label(filter.fresh(TOPIC, frame('710:89 759:133 712:28')).readings), '710:89 712:28');
});

test('each topic keeps its own table', () => {
  const filter = createResendFilter();
  const other = 'meganet/v1/other_site/logger/reading/elpro/Alert1';
  filter.fresh(TOPIC, frame('759:133 712:27'));
  // The same addresses from a second gateway are not this one's re-sends — and
  // that gateway is cold, so its first whole-table message keeps its head.
  assert.equal(label(filter.fresh(other, frame('710:89 759:133 712:27')).readings), '710:89');
  assert.equal(label(filter.fresh(other, frame('760:1 710:89 759:133 712:27')).readings), '760:1');
});

test('anything that is not an ALERT reading passes through untouched', () => {
  const filter = createResendFilter();
  const odd = { station_number: '541155', channel: 'level', reading_ts: 1, value_raw: 2 };
  const out = filter.fresh(TOPIC, [{ alert_id: 712, reading_ts: 1, value_raw: 1 }, odd]);
  assert.deepEqual(out.readings, [{ alert_id: 712, reading_ts: 1, value_raw: 1 }, odd]);
  assert.equal(out.resent, 0);
});

test('the memory is bounded in topics', () => {
  const filter = createResendFilter({ maxTables: 3 });
  for (let i = 0; i < 10; i += 1) filter.fresh(`t${i}`, frame('712:1'));
  assert.equal(filter.size(), 3);
});
