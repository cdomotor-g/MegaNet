# The live end-to-end test — proving the whole path, on demand

This page is for whoever wants to answer *does a reading actually get from a
base station into MegaNet, right now* — without waiting for a field station to
transmit, without a radio, and without unplugging anything.

It exists because that question had no answer. Every other check in this
repository stops at a boundary: `tools/check_ingest.sql` proves the database's
contract against a database, `npm run logger` proves the logger program and the
migration name the same rig, the bridge has its own tests. **None of them puts a
reading on the wire.** The one part of the system that carries every reading in
it — receiver → decoder → queue → POST → endpoint → database → screen — was the
part nobody could exercise on demand.

Two things make it possible now, and they are independent. Use either, or both.

| | What it proves | What it needs |
| --- | --- | --- |
| **The ALERT2 self-test** | The whole radio path: framing, the ALERT2 decoder, the bit unpacking, the clock gate, the queue, the batch, the POST, the endpoint, the database, the app. | A base station running `base-station-http.CR300` v2.1 and a way to set a `Public` variable. Nothing wired, no radio, no terminal on the RS-232 port. |
| **The 18 Bateson workshop rig** | The same path *plus* real sensors on real terminals, continuously, unattended — and the `station_number` + `channel` address shape, which nothing in the live system used before it. | The workshop station. |

---

## Before you start

- The base station is running **`logger/base-station-http.CR300` v2.1 or later**
  (`FW_VERSION` in the file, and in the MQTT status message). Earlier versions
  have neither half of this.
- **`db/migrations/0026_bateson_test_rig.sql` has been applied.** Check it in one
  line — if this returns nothing, stop and apply it:

  ```sql
  select id, station_number from meganet.station where id = 'bateson_test';
  -- bateson_test | 999998
  ```

  The self-test half works without it, but the reading resolves to nobody and
  the app shows a bare `a:8101` where a station name should be. The local-sensor
  half fails *loudly* without it: every local reading comes back in `rejected`
  saying `unknown protocol: wired`, because `code_for()` raises on a protocol key
  the database does not know. See **If it does not work**, below.
- The logger has a **token** (`PostState` is not `no token`) and a **clock**
  (`ClockOK` is true, `ClockState` is `ok`). Neither is specific to this test —
  [`logger/README.md`](../logger/README.md) covers both — but both stop it dead.

---

## 1 · Fire one ALERT2 frame

In LoggerNet, PC400 or Device Configuration Utility, on the base station's
`Public` table:

1. Set **`TestValue`** to something you will recognise and have not used before —
   the time of day works: `1421` at 14:21. It must be **0–2047**.

   *This matters.* The endpoint deduplicates on address + timestamp + value, so
   firing twice in the same second with the same value stores one reading and
   counts the second as a duplicate. That is the contract working, and it is
   indistinguishable from a shot that never left if you were not expecting it.

2. Leave **`TestId`** at **8101** unless you have a reason. It is the address
   `0026` reserves for this, in a block (8100–8109) no station in the registry
   uses, and it is inside the **13 bits** an ALERT2 record carries — which is why
   it is not a 9000-series address like the ELPRO bench unit's. An address above
   8191 wraps into the value field and decodes as a *different reading* rather
   than failing; the program refuses one rather than sending it.

3. Set **`TestFire`** to **true**.

It clears itself within a second. `TestState` then says one of:

| `TestState` | Means |
| --- | --- |
| `fired - watch RxLastLine, RxLastId, RxStep, then QDepth` | It went. Go to step 2. |
| `waiting for a gap - the byte buffer is not empty` | A real frame is mid-arrival. `TestFire` stays armed and it fires on the next quiet scan — this is a base station that is hearing traffic, which is good news. |
| `clock not set - nothing to stamp the frame with` | The RTC has not been disciplined yet. `ClockState` says why. |
| `TestId must be 1-8191 - 13 bits on the wire` | See step 2. |
| `TestValue must be 0-2047 - 11 bits on the wire` | Same, for the value. |

---

## 2 · Watch it go through, one step at a time

This is the reason the test is worth more than a `curl`: every stage of the
production path is a `Public` variable, and **the step where the display stops
being what you expect is the step that is broken.**

Read them in this order:

| Watch | Should become |
| --- | --- |
| `TestLine` | `ALERT2A,1,9999,MEGANET,N,1,2026,9,7,4,15,07.000,0,0,0,0,0,1,0,0,0,7,7,9999,74,3B,CB,A5,1F,15,00` — the frame it built |
| `RxLastLine` | **the same string.** Not similar — the same. It went into the byte buffer and came back out of the framer |
| `RxLastShape` | `ALERT2A` |
| `RxLastFields` | `31` — 24 fixed fields and 7 payload bytes |
| `RxLastPayHex` | `74 3B CB A5 1F 15 00 ` — the payload, decoded from hex |
| `RxLastRecHex` | `A5 1F 15 00` — the four bytes this reading came out of |
| `RxLastId` / `RxLastValue` | `8101` / whatever you set. **This is the assertion**: the packing and the unpacking are inverse |
| `RxFrameSkew` | `0` — the frame carries this logger's own time of day |
| `RxStep` | `7 queued` |
| `RxLastJson` | `{"alert_id":8101,"reading_ts":"…","value_raw":…}` — byte for byte what will be posted |
| `QDepthHttp` | `1` |
| `PostState` | `posting`, then `accepted` within `POST_EVERY` seconds (30) |
| `LastAccepted` | `1` |
| `QDepthHttp` | back to `0` |

If `MQTT_ENABLE` is true, `MqttState` and `MqttPublished` do the same on their
own timer and `QDepth` only returns to zero once **both** paths have sent it.

Fire a second shot **with the same `TestValue`** and `LastDuplicates` goes to 1
while `LastAccepted` stays 0. That is the endpoint's idempotency demonstrated on
live hardware, and it is what makes the retry behaviour and the dual-path
arrangement safe rather than merely optimistic.

---

## 3 · Confirm it landed

**In the database:**

```sql
select r.addr, r.reading_ts, r.value_raw, r.value, r.unit,
       p.key as protocol, s.key as source, r.path, r.received_at
  from meganet.reading r
  join meganet.protocol p on p.code = r.protocol
  join meganet.ingest_source s on s.code = r.source
 where r.station_id = 'bateson_test'
 order by r.received_at desc
 limit 20;
```

The self-test appears as `a:8101`, protocol `alert2`, source `http` (or `mqtt`,
if that copy won the race — either answer is correct).

**In the app:** the **Message Log** tab, filtered to the base station's `path`.
A reading that reached `Accepted` is in the database and is on that screen.

**Round trip, end to end, in seconds:** `received_at - reading_ts` is the whole
journey — the logger stamped one and the database stamped the other.

---

## 4 · The workshop rig, running continuously

`18 Bateson` is a base station in a home workshop. It is **not** a gauging
station and its readings are **not** network data — which is the point: it is
where the ingest path is exercised live, with real sensors, unattended, without
touching anything anybody depends on.

It has four channels wired to the logger's own terminals. They have no ALERT
address — there is no packet and no transmitting node, only a cable — so they use
the ingest contract's other address shape, a station number plus a channel:

| Channel | Address in the database | Sensor | `value_raw` | `value`, `unit` |
| --- | --- | --- | --- | --- |
| `rain` | `s:999998/rain` | Tipping bucket, pulse terminal | tips this interval | mm, with `conversion` recording the bucket size |
| `level_1` | `s:999998/level_1` | SDI-12 address 1, on C1 | metres | metres |
| `level_2` | `s:999998/level_2` | SDI-12 address 0, on C1 | metres | metres |
| `battery` | `s:999998/battery` | The logger's own supply | volts | volts |

All four report every `LOCAL_EVERY` minutes (5 by default) and carry
`protocol: "wired"` — a sensor on a terminal strip has no radio protocol, and
saying so is what stops a rain gauge on a cable being read as one on the air.

**`battery` is the channel to watch first.** It needs nothing wired to it, so a
rig with every sensor unplugged still answers *is this station reaching MegaNet*.

What to read at the logger:

| Watch | Should be |
| --- | --- |
| `LocalState` | `queued battery`, `queued rain`, … — the last channel that went in |
| `SecsSinceLocal` | under `LOCAL_EVERY × 60` |
| `LocalQueued` | climbing by 4 every interval |
| `LocalRejected` | **0.** Non-zero means a sensor returned NAN or something past `LOCAL_MAX` — see below |
| `LocalJson` | the last local reading, byte for byte as it will be posted |
| `Rain_tips_int` / `Rain_mm` | this interval's tips so far, and them in mm |
| `Level1_m` / `Level2_m` | metres, or `NAN` if that sensor did not answer |

`LocalRejected` climbing is the one to act on. A level sensor that has been
unplugged returns NAN, and the program refuses to queue it — **deliberately**,
because the alternative is worse than a gap: `FormatFloat(NAN)` renders the word
`nan`, which is not JSON, and one of those in a batch is a `400` for every
reading in it including the radio readings that were fine. A sensor that is
merely mis-scaled returns a *number*, and a number is what gets stored and later
believed, which is what `LOCAL_MAX` is for.

---

## 5 · Running this at a real base station

The self-test is not specific to the workshop. It works at any base station
running this program, and at a live site it answers a question the workshop
cannot: *is the path from THIS site working, today, over THIS link.*

Two things to know before firing one at a real site:

- **The reading is real.** It is stored, it is on the Message Log, and it stays
  there. It is addressed `a:8101` and resolves to `bateson_test`, so it is
  distinguishable from network data by a query and never mixed in with a site's
  own readings — but it is not a dry run and there is no undo. That is
  deliberate: a path that knows it is being tested is not the path under test.
- **Leave `TestEvery` at 0.** It is the interval, in minutes, for firing shots
  automatically, and it ships off. It is genuinely useful during a commissioning
  window — a shot every 15 minutes while somebody watches the other end — and
  it is a synthetic reading written into the live database forever if it is left
  on. Set it back before you leave site.

To take the rig out of service entirely, without deleting the readings it
explains:

```sql
update meganet.station set deleted_at = now() where id = 'bateson_test';
```

---

## If it does not work

Read `PostState`, `LastStatus` and `LastReject` in that order — between them they
name almost every failure.

| What you see | What it is |
| --- | --- |
| `LastReject` says `unknown protocol: wired` | `0026` has not been applied to the database this logger posts to. The radio readings in the same batch were stored; the local ones were not. Apply it — nothing on the logger needs to change |
| `LastReject` says `no address: a reading needs an alert_id, or a station_number…` | A local reading was built without `LOCAL_NUMBER`. Check the Const is not empty |
| `LastReject` says `unknown unit: …` | A `LocUnit()` entry is not in `meganet.unit`. `npm run logger` catches this before it ships |
| Readings accepted, but the app shows `s:999998/rain` rather than a station name | The station row is missing or its number is not 999998. `select meganet.resolve_station(null, '999998');` should answer `bateson_test` |
| Readings accepted, but the Message Log is empty | Almost always the clock. See *When readings arrive but the Message Log is empty* in [`logger/README.md`](../logger/README.md) — a logger on local time posts readings ten hours in the future, which are accepted and invisible |
| `LastStatus` is `401` | The token. Mint and load a new one — [`ingest-http.md`](ingest-http.md) § Getting a token |
| `LastStatus` is `404` | The `Content-Profile: meganet` header, or the URL. Neither changes per site |
| `TestFired` climbs but `RxLastLine` never changes | The injected bytes were framed as something else. `RxFrameMode` says which; `RawLog` has the bytes |
| `RxLastId` is not `TestId` | The packing and the unpacking disagree, which `npm run logger` asserts they do not. Send `TestLine` and `RxLastRecHex` with the report |

---

## What holds this page true

`npm run logger` (`test/logger.mjs`, run by CI on every push touching `logger/`
or `db/migrations/`) asserts the parts of this page that are claims about code
rather than instructions to a person: that the program and `0026` name the same
station number, protocol key, channel names and self-test address; that the
self-test frame decodes back to the address it was built for across the whole
13-bit range; that an address above 8191 would wrap, which is why the guard is
there; that every unit the program sends is in `meganet.unit`; and that both
reading shapes render as valid JSON.

`0026` asserts the rest at apply time — that both addresses resolve to
`bateson_test` — and CI applies every migration from zero on every push. A rig
that half exists fails the migration rather than sending somebody to look at the
logger.
