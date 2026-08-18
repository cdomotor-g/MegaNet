# MQTT ingest — the topic scheme, the broker, and the bridge

This page is for whoever is configuring a logger to publish readings over MQTT,
and for whoever has to decide where the broker lives. If you are changing how the
bridge itself works, that is [`bridge/README.md`](../bridge/README.md); the
database side is `db/migrations/0008_mqtt_bridge.sql` and `db/README.md`.

If your device speaks plain HTTP, use [`ingest-http.md`](ingest-http.md) instead
— it needs no broker and no bridge, and it posts the same reading object to the
same contract. MQTT earns its extra moving parts on links where a device cannot
hold a TCP connection open long enough for a request/response, on radios where
1 byte of overhead matters, and — the real reason — because of what it gives back
in return: **you find out when a station stops talking**, for free.

---

## The thing to know up front

**Postgres cannot subscribe to MQTT, and Supabase does not host a broker.** So
MQTT ingest is two components, not one:

1. A **broker** the field stations publish to.
2. A **bridge** — a subscriber that receives, validates and calls
   `meganet.ingest()`.

The bridge is the first piece of MegaNet that has to run somewhere permanently.
Until this, everything was a static page plus a database. That is a real change
in the project's shape and it is worth being deliberate about, which is what this
page and `bridge/README.md` are for.

---

## The topic scheme

Design it once. Topics get burned into logger firmware, and changing one means
visiting sites.

```
meganet/v1/<station>/<device>/reading      device → us, QoS 1
meganet/v1/<station>/status                retained, and the LWT topic
```

`<station>` is the **stations.json slug** — `loudoun_br_al`, `abercorn_al` — the
same identity the station has in the app, in URLs and in the database. Using
anything else would create a second identifier for the same site and a mapping
table somebody has to keep in step.

`<device>` is **which box at the site is talking**: `logger` for the usual case
of one, `logger_backup` or `rain` where a site has more than one. It is a topic
segment rather than a payload field because it says *who published*, not what was
measured — the reading carries its own address (`alert_id`, or `station_number`
and `channel`), and that is what MegaNet stores against.

Both segments must start with a letter or digit, then accept letters,
digits, dot, dash and underscore, up to 64
characters. No spaces, no `+`, no `#`, nothing starting with `$`.

**Why the version is in the topic.** `v1` costs nothing today and is the only way
to change the payload later without a field trip: a v2 bridge can subscribe
alongside the v1 one and stations can move across a few at a time, rather than in
a flag day nobody can schedule.

**QoS 1, not 2.** QoS 1 is at-least-once, which means duplicates are guaranteed
— and `meganet.reading`'s primary key (address, instant, value) already eats
them and counts them. Exactly-once costs two extra round trips per message over a
marginal radio link and buys nothing that the primary key does not already give.

---

## Publishing a reading

```
topic:   meganet/v1/loudoun_br_al/logger/reading
qos:     1
retain:  false
payload: {"alert_id": 6128, "reading_ts": "2026-08-12T04:15:00Z", "value_raw": 301}
```

**The payload is the same reading object the HTTP endpoint takes** — that is the
entire point of having one ingest contract. One reading, an array of them, or an
object with a `readings` array plus shared defaults:

```json
{
  "path": "MT_STUART",
  "readings": [
    {"alert_id": 6128, "reading_ts": "2026-08-12T04:15:00Z", "value_raw": 301},
    {"station_number": "541155", "channel": "level",
     "reading_ts": 1786000500, "value_raw": 1.842, "unit": "m"}
  ]
}
```

Every field, and what happens to a bad one, is in
[`ingest-http.md`](ingest-http.md#payload-shape). The limits the bridge adds: at
most **1,000 readings** per message, matching the HTTP endpoint's own batch
limit, and **256 KiB** per message — the bridge's own bound, chosen here; the
HTTP path enforces no byte limit of its own.

**Retrying is safe.** The same reading published twice — same address, same
`reading_ts`, same `value_raw` — is stored once, and the second copy is counted
on the first. Do not build an acknowledgement protocol on top of QoS 1; you
already have an idempotent retry.

**There is no reply.** MQTT gives a device no response channel, so a station
cannot be told its reading was stored. The QoS 1 PUBACK it gets back is from the
*broker*, and means the broker has the message — not that MegaNet has it. That is
the honest picture, and it is why the bridge never acknowledges a *storable*
message to the broker until the database has actually stored it: if the bridge
or the database is down, the broker keeps the message and hands it back when
things recover. The deliberate exceptions are messages that can never be
stored — an unparseable, oversized or empty payload, a topic outside the
scheme, or a batch the database refuses outright (400/422) — which are acked,
logged and counted as rejected, because an unacked poison message is
redelivered forever with the whole backlog stuck behind it. A station that
publishes and gets its PUBACK has done its job and can sleep.

---

## Saying whether you are alive

This is the part that is arguably worth more day to day than the readings.
"Which sites stopped talking overnight" is the morning question, and MQTT answers
it with two features that cost a logger almost nothing.

**A retained status message**, published on connect:

```
topic:   meganet/v1/loudoun_br_al/status
qos:     1
retain:  true
payload: {"online": true, "battery_v": 12.9, "fw": "2.1"}
```

`retain: true` means the broker keeps the last one and replays it to the bridge
whenever it reconnects, so a bridge restart does not lose the picture. Anything
beyond `online` is kept verbatim in `meganet.station_status.last_status` — a
logger can start reporting a new field without a migration or a bridge release.

**A Last Will and Testament**, set in the CONNECT packet:

```
will topic:   meganet/v1/loudoun_br_al/status
will qos:     1
will retain:  true
will payload: {"online": false}
```

The broker publishes that *on your behalf* when your connection drops without a
clean disconnect — which is exactly the case a station cannot report itself. That
is station-offline detection with no polling, no timeout table, and no code in
the station beyond one field at connect time.

For firmware that cannot build JSON, the status payload may also be the plain
text `online` / `offline` (or `up` / `down`, or `1` / `0`). An empty payload
clears the retained message and means "forget what I said", not "I am down".

Both appear in `meganet.station_health`:

```sql
select station_key, station_name, online, since,
       round(minutes_since_seen) as quiet_for_minutes
  from meganet.station_health
 where minutes_since_seen > 180
 order by minutes_since_seen desc;
```

Note that `online` is *what the broker last told us*, not a health verdict: a
logger that publishes hourly is offline between transmissions and perfectly well.
The view deliberately applies no staleness threshold, because every station's
reporting interval is different — you pick, per station.

---

## Credentials

**One credential per station, ACL'd to that station's own topic prefix.** Same
reasoning as #B5's per-station HTTP tokens: a logger's credentials live in a box
on a pole, reachable by anyone with a screwdriver and a serial cable, and a
credential that can publish as any station is a credential that can rewrite the
network's record.

```
user station-loudoun_br_al
topic write meganet/v1/loudoun_br_al/#
```

`write`, not `readwrite` — a logger has nothing to read here. A worked example
for a self-hosted broker is `bridge/deploy/mosquitto.acl.example`; managed
brokers express the same three lines in their console.

The bridge gets its own credential, which can **read everything under the scheme
and write nothing**. A bridge that can publish is a bridge that can fabricate a
reading, and it has no reason to.

Use TLS. `mqtts://` on 8883, or `wss://` — the credentials travel in the CONNECT
packet, and on a plain listener they travel in clear text.

### What the bridge is trusted with

It holds one `meganet.ingest_token` — the same kind of token an HTTP logger has —
and no service key, no database password. That token opens exactly three doors:
post readings, record a station's status, update the bridge's own health row. It
cannot read a reading back, edit a station, or see the token table. A bridge host
that somebody else gets into is worth one revoked token:

```sql
update meganet.ingest_token set revoked_at = now() where label = 'mqtt bridge';
```

which takes effect on the very next call — there is no cache or token lifetime to
wait out.

---

## The broker

The bridge has to exist either way, so the question is only whether you also run
the broker. **For the pilot: a managed free tier**, because running one process
beats running two.

| Option | Notes |
| --- | --- |
| **HiveMQ Cloud free** | ~100 connections, TLS, managed, per-credential topic permissions. Zero ops. |
| **EMQX Serverless free** | Similar shape, generous free allowance. |
| **Mosquitto on a small VPS / Fly.io** | ~$5/mo, total control, about an afternoon including TLS via Let's Encrypt. `bridge/deploy/mosquitto.conf.example`. |
| **The employer's broker** | If one exists, ask. Best answer if the corporate move happens. |

Free-tier limits move — check them at the time, and check the connection count
against the number of stations plus one for the bridge.

**Mosquitto is the destination if this goes inside.** Brokers are the *easy* part
to run on-prem: one package, one config file, one certificate. So choosing a
managed one now creates no lock-in in either direction — the topic scheme, the
station credentials and the bridge are all unchanged by a broker swap, and the
config that would replace it is already in this repository.

The two broker settings that matter to MegaNet, whichever you pick:

- **Persistent sessions must be allowed**, and their queues kept for at least as
  long as you would tolerate the bridge being down. The bridge connects with
  `clean_session: false` and a stable client id; that is what makes "a bridge
  that was down for an hour loses nothing" true. Mosquitto:
  `persistent_client_expiration` and `max_queued_messages`.
- **QoS 1 must actually be granted.** A broker that downgrades a subscription to
  QoS 0 has turned off at-least-once delivery, and the bridge's careful
  acknowledgement stops meaning anything. The bridge logs
  `subscribe_downgraded` at error level if this happens.

---

## Proving it end to end

With the *station's* credentials — publishing successfully with them is the proof
that the ACL is right:

```sh
cd bridge && npm install
MQTT_URL=mqtts://your-broker:8883 \
MQTT_USERNAME=station-loudoun_br_al MQTT_PASSWORD=… \
  npm run publish-sample -- --station loudoun_br_al --alert-id 6128 --value 42
```

Then, within seconds:

```sql
select addr, reading_ts, value_raw, source from meganet.reading
 order by received_at desc limit 5;

select station_key, online, since, last_reading_at
  from meganet.station_health where station_key = 'loudoun_br_al';
```

Kill the sample publisher with `SIGKILL` rather than Ctrl-C and the station
should show `online = false` within seconds — that is the Last Will working, and
it is the single thing most worth testing before a station goes in the field.

The database half of all of this is `tools/check_mqtt.sql` (39 checks, in a
transaction that rolls back); the client half is `bridge/test/integration.test.js`
(a real broker, a real client, and a database that fails on demand).
