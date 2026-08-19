# bridge/ — the MQTT → MegaNet bridge

A small, permanently-running process that subscribes to `meganet/v1/…` on an
MQTT broker, validates what arrives, and posts it to MegaNet's ingest endpoint.

**This is the first piece of MegaNet that needs a process running somewhere all
the time.** Everything else in this repository is a static page plus a database.
That is a real change in the project's shape, and it is worth being deliberate
about: the reason it is unavoidable is that **Postgres cannot subscribe to
MQTT**, and Supabase does not host a broker. Something has to hold the
subscription. This is that something, and it is kept as small and as boring as
that job allows.

- The **topic scheme, the broker choice, and how to point a station at it** are
  in [`docs/ingest-mqtt.md`](../docs/ingest-mqtt.md) — that is the page for
  whoever is configuring a logger.
- **Standing the broker and this process up from nothing** — the signup, the
  credentials, the secrets, the first reading — is
  [`docs/mqtt-provisioning.md`](../docs/mqtt-provisioning.md).
- The **tables it writes** are in
  [`db/migrations/0008_mqtt_bridge.sql`](../db/migrations/0008_mqtt_bridge.sql).
- This page is for whoever is **running** it.

---

## What it does

```
station ──MQTT/TLS──▶ broker ──MQTT/TLS──▶ bridge ──HTTPS──▶ meganet.ingest_http()
                                             │                        │
                                             │                        └─▶ meganet.ingest()
                                             └─▶ meganet.mqtt_status()  (LWT, retained status)
                                                 meganet.bridge_heartbeat()
```

Readings go through `ingest_http()` — the same door an HTTP logger uses, with
the same token type — so there is exactly one write path for a reading and one
validator behind it. The bridge adds no second opinion about what a timestamp
is; it decides only what to relay, when to acknowledge it, and what to say in
the log.

Three subscriptions, all QoS 1:

| Topic | What it carries |
| --- | --- |
| `meganet/v1/+/+/reading` | JSON readings — one, an array, or `{readings: […]}` |
| `meganet/v1/+/+/reading/hfem` | A raw HFEM line, `:HS=1\|…\|NN:` — decoded by `hfem.js`, mapped to the same contract (#155; docs/ingest-hfem.md) |
| `meganet/v1/+/status` | A station's retained status, and its Last Will |

---

## Running it

Node 20 or newer, one dependency.

```sh
cd bridge
npm install
cp .env.example .env      # then fill in MQTT_PASSWORD and MEGANET_INGEST_TOKEN
node --env-file=.env index.js
```

Or in a container — **from the repo root**, because the image carries the HFEM
decoder (`hfem.js`, which lives at the root so the browser reads the same file
— see the Dockerfile's header):

```sh
docker build -t meganet-bridge -f bridge/Dockerfile .
docker run --env-file bridge/.env meganet-bridge
```

On Fly, which is the cheapest way to get a always-on process with a TLS-capable
outbound and no server to patch — again from the repo root, with the config
telling Fly where the Dockerfile is:

```sh
fly launch --no-deploy --dockerfile bridge/Dockerfile   # one machine, no public services
fly secrets set MQTT_PASSWORD=… MEGANET_INGEST_TOKEN=…
fly deploy --dockerfile bridge/Dockerfile
```

It needs no inbound network access at all — it makes two outbound connections
and listens for nothing, unless you turn the health endpoint on.

### The token it needs

```sql
select meganet.create_ingest_token('mqtt bridge');
-- {"id": 3, "label": "mqtt bridge", "token": "mgn_…"}
```

Shown once, stored only as a hash. Put it in `MEGANET_INGEST_TOKEN`. If it is
ever exposed, `update meganet.ingest_token set revoked_at = now() where label =
'mqtt bridge'` takes effect on the very next call — and then mint a new one.

**The bridge holds an ingest token and nothing else.** No service key, no
database password. A host running this process that somebody else gets into is
worth exactly one revoked token: the token can post readings, record a station's
status and update this bridge's health row, and cannot read a reading back, edit
a station, or see the token table.

The bridge is an ingest point in the sense `docs/ingest-http.md` means it — one
token covering every station it relays for, not one per station. Its token is
worth the whole network it bridges, and revoking it stops all of them at once.
Every reading it posts records that it came in through this token, so
`meganet.reading.ingest_token_id` tells you what the bridge wrote if you ever
need to find out.

---

## Configuration

Every setting, with its default, is in [`.env.example`](.env.example). The four
that must be set: `MQTT_URL`, `MEGANET_API_URL`, `MEGANET_API_KEY`,
`MEGANET_INGEST_TOKEN` (plus `MQTT_USERNAME`/`MQTT_PASSWORD` for any broker
worth using). Everything is validated before anything connects, and *all*
problems are reported at once — three typos should cost one restart, not three.

Two are worth understanding rather than copying:

**`MQTT_CLIENT_ID` must be stable across restarts.** It is the name of the
broker-side session, and the session is what holds messages the bridge has not
yet acknowledged. A random client id per boot means a new, empty session every
time and the previous one's queue orphaned on the broker. The default derives it
from the hostname, which is stable on a VM and is *not* stable on some container
platforms — set it explicitly there.

**`MQTT_URL` must be `mqtts://` or `wss://`.** The broker password travels in
the CONNECT packet. `MQTT_ALLOW_INSECURE=1` exists for a broker on localhost and
is named so that finding it set in production is finding a decision.

---

## Is it alive?

Three ways, in increasing order of how much you should trust them.

**`meganet.bridge_health`** — pushed every minute, and the only one visible from
somewhere other than the host:

```sql
select bridge_id, connected, last_message_at, last_insert_at, pending,
       now() - last_seen_at as silent_for
  from meganet.bridge_health;
```

`silent_for` growing past a couple of minutes means the process is gone —
that is the row's whole purpose. `last_message_at` old but `last_seen_at` fresh
means the bridge is fine and the *field* has gone quiet, which is a different
problem with different people to wake. Getting those two confused is the failure
this table exists to prevent.

**`GET /healthz`** — off unless `BRIDGE_HEALTH_PORT` is set. Answers 200 when the
bridge is connected to the broker and not sitting on a backlog it cannot
deliver, 503 otherwise, with the same counters as a body. Point a platform health
check at this. It deliberately does *not* fail on "no messages recently": a quiet
night on a small network is not a fault, and a health check that restarts the
process every time the field goes quiet causes outages rather than finding them.

**The log.** One JSON object per line on stdout.

---

## What its logs mean

Every line has `event`, which is the stable part — the messages get reworded,
`event` is what a search or an alert matches on. Ordinary running is a handful
of lines a minute at `info`.

| `event` | Level | What it means, and what to do |
| --- | --- | --- |
| `bridge_started` | info | The process is up. Not yet connected to anything. |
| `broker_connected` | info | Connected. `session_present: false` after a *restart of the bridge* means the broker had no session for this client id — a new client id, an expired session, or a broker that lost its state. Anything it was holding for us is gone; that is the one case where the broker can lose a reading. |
| `subscribed` | info | All three topics granted. Nothing arrives before this. |
| `batch_stored` | info | A batch landed. `accepted`/`duplicates`/`rejected` are `ingest()`'s own counts — a batch of 60 that is all duplicates is a station resending, not a fault. |
| `station_status` | info | A station's status or LWT was recorded. `online: false` is a station that dropped. |
| `reading_rejected` | warn | The database refused a reading, with its reason. A dead clock or an unknown unit — a *station* problem, not a bridge problem. See docs/ingest-http.md's table of reasons. |
| `batch_retrying` | warn | An insert failed and will be tried again. One or two of these is a database blinking. |
| `sink_unavailable` | **error** | Inserts have failed five times running, and are still being retried. This is the one to alert on: readings are piling up in memory and nothing has been acked. If `credential: true`, the ingest token was refused — it will not clear on its own, so check `revoked_at` and mint a new one. |
| `message_refused` | **error** | One message will never be accepted (a 400 from PostgREST). It has been acked and dropped so the queue behind it can move. The message is named by station and topic; it is the only case where the bridge discards data, and it does so loudly. |
| `message_unparseable` | **error** | The payload was not JSON, not a readings shape, or (on the HFEM topic) not a well-formed HFEM line — the reason names the offending token. Acked, for the same reason. Almost always a firmware change nobody mentioned. One reason to know by name: *looks like an HFEM line on the JSON reading topic* means a logger is publishing HFEM one topic segment short of where it lands — point it at `…/reading/hfem`. |
| `topic_ignored` | warn | Something published outside the scheme. Harmless; if it is constant, a station has a typo in its topic. |
| `subscribe_downgraded` | **error** | The broker granted QoS 0 where QoS 1 was asked for. At-least-once delivery is off and acknowledgement means nothing — fix the broker's configuration. |
| `broker_reconnecting` | warn | Lost the broker; backing off and retrying. Expect these on any link. |
| `unacked_returned_to_broker` | **error** | The process is shutting down while holding messages it could not store. They were never acked, so the broker still has them and hands them back on the next start. No data was lost; the line is here so that a pile of "duplicates" in the next start's log has an explanation. |
| `heartbeat_failed` | warn | Could not update `bridge_health`. Not fatal — the next one is a minute away, and the gap is itself the signal. |

---

## The rule about what may be acknowledged

This is the part to read before changing anything in `src/batcher.js`.

**Nothing is acknowledged until the database has stored it.** MQTT.js sends the
PUBACK when the callback handed to `handleMessage` runs; the bridge holds that
callback until `ingest_http` has answered 200 for the batch the message is in.
Until then the message is still the broker's, and a bridge that dies, or a
container that is rescheduled mid-flight, costs nothing: the broker hands it back
on the next connect. `clean: false` and a stable client id are what make that
true, which is why both are load-bearing rather than tuning.

**A batch that cannot be delivered is retried forever, with capped backoff, and
is never acked.** There is no attempt limit, because there is no number of
failures after which discarding a reading becomes the right answer. A long
database outage therefore costs memory — every message received during it stays
in this process — and that is affordable *precisely because* nothing has been
acked: if the queue grows until the process dies, the broker still holds every
message. The failure mode of the simple design is a restart, not a gap.

**A batch the database refuses on its merits is bisected.** A 400 will be a 400
every time, but a batch is many stations' messages and one bad envelope must not
block the other twenty. The batch is split in half, each half tried on its own,
until the poison message is alone — then it is acked, logged as
`message_refused`, and counted. That costs log₂(n) extra requests in a case that
should be rare; the alternatives are losing good readings or never making
progress.

**Duplicates are not the bridge's problem.** QoS 1 guarantees at-least-once, and
a repeater network delivers most readings more than once anyway.
`meganet.reading`'s primary key — address, instant, value — eats them and counts
them. The bridge relays both copies unchanged, because a bridge that
deduplicates is a second, worse copy of that rule.

---

## Tests

```sh
npm test
```

Unit tests for the topic scheme, the payload rules, the backoff and — most
importantly — the acknowledgement rules above. Then `test/integration.test.js`,
which runs a real MQTT broker (aedes) in-process against the real client and a
stub for PostgREST, and proves each line of #B6's acceptance: a published reading
becomes an insert, an LWT becomes an offline station, a database outage acks
nothing and lands the reading when it clears, a duplicate is relayed unchanged,
a stray topic does not wedge the queue, and a broker restart is survived without
an operator.

What the tests do *not* cover is the database side of the contract — that is
`tools/check_mqtt.sql`, which proves the same acceptance against a real Postgres:

```sh
psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 -f ../tools/check_mqtt.sql
```

## Proving it by hand

With the station's own credentials, not the bridge's — publishing successfully
with them is the proof that the broker's ACL is right:

```sh
MQTT_URL=mqtts://…  MQTT_USERNAME=station-541155  MQTT_PASSWORD=… \
  npm run publish-sample -- --station 541155 --alert-id 6128 --value 42
```

It publishes a retained status and one reading, with a Last Will set, and prints
the two queries that show them. Kill it with `SIGKILL` rather than Ctrl-C and the
station should appear offline within seconds — that is the LWT working.
