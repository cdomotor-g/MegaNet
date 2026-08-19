# HFEM ingest — the BoM field-event format, over MQTT and HTTP

This page is for whoever is configuring a logger that speaks **HFEM** — the
Bureau of Meteorology's Hydro Field Event Message format (`BoM HFEM v1.0.pdf`,
R. Thompson, August 2010; the spec is in `archive/`). If your device can emit
JSON, you do not need this page: post the ordinary reading object described in
[`ingest-http.md`](ingest-http.md) or publish it per
[`ingest-mqtt.md`](ingest-mqtt.md), and nothing here applies. HFEM support
exists for the devices that cannot.

> **Keeping this page true.** The HFEM line, the topic and the decoded shape
> below are the exact strings `bridge/test/` publishes through a real
> in-process broker on every CI run, the mapping table is asserted
> field-by-field by `bridge/test/messages.test.js` and `test/hfem.mjs`, and
> the HTTP example is the payload `tools/check_mqtt.sql` executes against a
> real database. If you change an example here, change the test that runs it
> — prose alone let #99's wrong `curl` survive review.

---

## What an HFEM message is

One ASCII line a logger pushes when a sensor trips or an inactivity timer
expires. `:` at both ends, `|` between sections; a header, an optional
maintenance flag, a site identifier, an optional timestamp, one or more
sensor measurements, and an `NN` footer that is the format's entire
integrity story:

```
:HS=1|M=1|I1=123456|T3=20100727130000-10|R_1-0=1055|B_1-16=13.9|NN:
```

That says: message type HS version 1, the site is in maintenance mode, site
123456, observed 27 Jul 2010 13:00 *local standard time* at a site whose UTC
offset is +10 (see the timestamp trap below), Rainfall sensor 1 read 1055 raw
counts, Battery 1 read 13.9 engineering volts.

One decoder reads it everywhere: `hfem.js` at the repo root is required by the
bridge and read by the browser, so there is never a second opinion about what
`T3` means. Its header documents the format in full, including the four cells
of the spec's own Table 4 that contradict their descriptions.

---

## Two ways in (and the one that was not built)

**MQTT — publish the raw line.** The topic scheme carries the payload format
as a segment (the same argument as the `v1`: it is burned into firmware, and
it is ACL-able, which content-sniffing never is):

```
meganet/v1/<station>/<device>/reading/hfem      the raw HFEM line, QoS 1
```

`<station>` and `<device>` mean exactly what they mean in
[`ingest-mqtt.md`](ingest-mqtt.md) — the bureau station number, and which box is
talking. Publish the line as the payload, nothing around it:

```
topic:    meganet/v1/541155/logger/reading/hfem
payload:  :HS=1|M=1|I1=123456|T3=20100727130000-10|R_1-0=1055|B_1-16=13.9|NN:
```

The bridge decodes it, maps it by the table below, and posts it through
`meganet.ingest()` like every other reading. Everything the MQTT page says
about QoS 1, acknowledgement and the no-loss promise applies unchanged —
the message is not acked until the readings are stored.

**A line published to the plain `…/reading` topic does not land.** That topic
is JSON, and a payload starting with `:` is refused as unparseable — acked,
counted, and logged as *looks like an HFEM line on the JSON reading topic*,
which is the log line to search for when a logger seems configured and
nothing arrives. The fix is one topic segment.

**HTTP — decode at the edge, post JSON.** `meganet.ingest_http()` takes JSON
and only JSON; there is no Edge Function in front of it to decode HFEM on the
server (`0007` records why), and a PL/pgSQL HFEM parser would be a second
implementation of the decoder in a language this repo cannot test. So a
device or gateway posting over HTTP sends the *decoded* readings, with two
envelope keys that keep the wire line beside them:

```json
{ "source": "http", "protocol": "hfem",
  "frame": ":HS=1|M=1|I1=123456|T3=20100727130000-10|R_1-0=1055|B_1-16=13.9|NN:",
  "readings": [
    { "station_number": "123456", "channel": "R_1",
      "reading_ts": "2010-07-27T03:00:00Z", "value_raw": 1055,
      "unit": "count", "quality": "maintenance" },
    { "station_number": "123456", "channel": "B_1",
      "reading_ts": "2010-07-27T03:00:00Z", "value": 13.9, "value_raw": 13.9,
      "unit": "V", "quality": "maintenance" }
  ] }
```

Post it exactly as `ingest-http.md` describes — same endpoint, same token,
same response shape. If you are writing the decode yourself, don't: run the
line through `HFEM.decode()` + `HFEM.toReadings()` from `hfem.js` and post
what comes out. That pair is what produced the JSON above.

**TCP — deliberately not built.** A bare socket listener is a new transport,
not a new protocol, and whether any real logger needs one is #152's open
question 1. If the answer comes back yes, the natural home is a second
listener inside the bridge; until then a socket-only device goes through a
gateway that can speak MQTT or HTTP.

---

## The mapping — what each HFEM field becomes

Written once, in `hfem.js` (`toReadings`), used by the bridge and printed
here for HTTP posters:

| HFEM | `meganet.reading` |
|---|---|
| `I1` / `I2` value (as written on the wire) | `station_number` — `alert_id` stays null |
| sensor class + instance, `R_1-0` | `channel` = `R_1` — the scheme digit is representation, not identity |
| — | `addr` generates as `s:123456/R_1` |
| `T1` / `T2` / `T3`, resolved | `reading_ts`, always UTC |
| *no timestamp at all* | the adapter's arrival time stands in — an event push that omits `T` means "now" |
| raw scheme (`0–4`, `10–14`, `20–24`) | `value_raw`, `unit = 'count'` |
| translated scheme (`6`, `16`, `26`) | `value` **and** `value_raw`, `unit` from the class — a translated scheme still transmitted something, and that something is `value_raw` |
| `DO_…` dissolved oxygen | `unit = 'mg/L'`, not ppm — numerically equivalent in fresh water; `0018` records the equivalence |
| `M=1` | `quality = 'maintenance'` on every reading in the message |
| the whole line | envelope `frame`, kept verbatim in `meganet.reading_raw` |

**The timestamp trap**, because it is the one that corrupts data silently
(#152 trap 1): `T1=20100727030000` is UTC as written. `T2=20100727030000+10`
is *also* UTC as written — the suffix exists so a reader can compute local
time, and must be ignored. `T3=20100727130000-10` is **local standard time
with an inverted offset**: UTC = stamp + offset, so a Victorian site
(UTC+10) writes `-10`, and all three examples in this paragraph name the
same instant, `2010-07-27T03:00:00Z`. Nothing in this repo puts an HFEM
timestamp near an ISO parser, and neither should your gateway.

**`M=1` is a quality, not a log line.** A technician pouring a calibration
bucket through a rain gauge produces real readings of a deliberately
disturbed instrument — not weather, and not `suspect` either. They land
under `quality = 'maintenance'` (code 6, `0018`), so excluding them is one
predicate rather than a guess at step changes:

```sql
select r.addr, r.reading_ts, r.value_raw
  from meganet.reading r
  join meganet.quality q on q.code = r.quality
 where q.key = 'maintenance'
 order by r.reading_ts desc limit 20;
```

---

## When a line is malformed

A malformed HFEM line will never parse, however many times it is redelivered
— so on MQTT it is **poison**: acked, counted in the bridge's health
snapshot, and logged as `message_unparseable` with a reason that names the
offending token (`R_1-5: measurement scheme 5 is not defined by HFEM v1.0`,
not "bad message"). The decoder never produces a partial decode — a
truncated line with three of five sensors intact lands zero readings, loudly,
rather than three quietly. That rule is #152's acceptance, and the reasons
live in `hfem.js`'s header.

Two failure shapes worth knowing apart: a line the *decoder* refuses never
reaches the database and shows up only in the bridge log; a line that decodes
but whose readings the *database* refuses (a dead clock, an unknown unit)
comes back per-reading in `rejected` with the database's reason, exactly as
for JSON readings — `ingest-http.md`'s table of reasons applies unchanged.
