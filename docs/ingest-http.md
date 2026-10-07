# HTTP ingest — posting readings from a base station

This page is for whoever is configuring a base station to send readings to
Flood-Net. It assumes you have a serial cable and a datasheet for your device, not
that you have read this repository. If you are changing how the endpoint itself
works, the database side is `db/migrations/0007_ingest_http.sql`,
`db/migrations/0012_base_station_tokens.sql` and `db/README.md`.

> **Keeping this page true.** Every example here has been run against the live
> project (the #102 audit re-ran them all after its fixes). If you change an
> example, run it first — #99 existed because a wrong `curl` could survive
> review, and nothing forced anyone to execute it. The database checks CI runs
> on every push (`tools/check_ingest.sql`) hold the *contract*; only running
> the examples holds the *page*.

## The whole picture

Two ways in, one contract, one place where duplicates die. Whatever the
transport, every reading ends up as the same call:

```mermaid
flowchart LR
    FS[Field station<br/>radio / satellite / serial] --> BS[Base station or gateway<br/>where it becomes TCP/IP]
    BS -- "HTTPS POST + token<br/>(this page)" --> IH["meganet.ingest_http()"]
    BS -- "MQTT publish, QoS 1<br/>(ingest-mqtt.md)" --> BR[broker]
    BR -- "subscribe" --> BG[bridge<br/>bridge/README.md]
    BG -- "the same HTTPS POST,<br/>with the bridge's token" --> IH
    IH --> ING["meganet.ingest()<br/>0006 — the shared contract"]
    ING --> DB[(readings<br/>dedup on station + timestamp + raw value<br/>then roll-up and retention)]
```

What the two paths share is everything that matters: the payload shape, the
1,000-reading batch limit, the unit vocabulary, the rejection reasons, and the
token model — the bridge is just another ingest point holding another token.
**Deduplication happens in one place**, inside `meganet.ingest()`: the same
reading arriving twice — same address, same `reading_ts`, same `value_raw` —
is stored once, whichever door it came through, which is why retrying is safe
on both paths and why the two can even run side by side during a migration.
What the MQTT path adds is presence: a broker knows when a station stops
talking, and the HTTP path has no way to say so.

A device that speaks **HFEM** — the BoM field-event line format — enters by
either door too: the raw line publishes to its own MQTT topic segment and the
bridge decodes it, or a gateway decodes it and posts the JSON over HTTP with
`protocol: "hfem"` and the line kept in `frame`. Either way it converges on
the same `meganet.ingest()` call as everything above —
[`ingest-hfem.md`](ingest-hfem.md) is that page.

What is automated versus manual today, honestly: CI applies every migration
from zero and runs the ingest and MQTT check suites on every relevant push,
and the bridge's own tests run the same way — but `meganet.retain()` (the
retention sweep) is still run by hand, and the bridge itself is
complete-and-tested but not yet deployed anywhere. The readings you POST are
kept raw as well as resolved either way.

## One token per ingest point

**A token belongs to the base station, not to a field station.** Mint one token
for each place where radio, satellite or serial becomes TCP/IP — a base station
and its data logger, a PC on the end of a serial cable, a satellite gateway — and
that one token posts readings for **every station that ingest point can hear**.

You do not need a token per field station, and you should not mint one. Each
reading in a batch carries its own address — an ALERT ID, or a station number —
and Flood-Net works out which station it belongs to from that. A base station
hearing forty sites sends one POST with forty readings in it and one token in the
header.

The trade to understand before you go further: a base station's token is worth
forty stations, not one. Revoking it silences all of them, and a leaked one can
write for all of them. Two things follow from that — every reading records which
ingest point wrote it, and revoking is instant — and both are covered below.

## The endpoint

```
POST https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/ingest_http
```

Every request needs four headers, and a JSON body with everything nested one
level under a `payload` key — PostgREST maps an RPC body's top-level keys to
the function's named arguments, and `ingest_http` takes exactly one argument,
called `payload`:

| Header | Value |
| --- | --- |
| `apikey` | `sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY` — identifies the project. Not a secret; it is committed to this repo and cannot read or write anything on its own. |
| `X-Ingest-Token` | Your base station's token — see **Getting a token**, below. This is the secret. |
| `Content-Type` | `application/json` |
| `Content-Profile` | `meganet` — Flood-Net's tables live in their own schema, not `public`. Without this, PostgREST looks in `public`, finds no `ingest_http` there, and the request never reaches the database ([`db/README.md`](../db/README.md)). |

```sh
curl -sS -X POST \
  'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/ingest_http' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'X-Ingest-Token: mgn_your-token-here' \
  -H 'Content-Type: application/json' \
  -H 'Content-Profile: meganet' \
  -d '{
        "payload": {
          "path": "MT_STUART",
          "readings": [
            {"alert_id": 6128, "reading_ts": "2026-08-11T04:15:00Z", "value_raw": 301}
          ]
        }
      }'
```

A working request answers `200` with a body that says what happened:

```json
{"accepted": 1, "duplicates": 0, "rejected": [], "raw_id": 4821}
```

There is no `204`. If the response body does not say `"accepted"`, the reading
was not stored — a logger that cannot tell "stored" from "silently dropped"
produces gaps nobody notices for a month, so this endpoint never answers that way.

### Why `X-Ingest-Token` and not `Authorization: Bearer`

If you have used a Supabase project before, you may expect the token to go in
`Authorization: Bearer <token>`. It cannot go there: Supabase's API gateway reads
that header as a login token and rejects anything that is not one, before your
request reaches the database at all — an ingest token sent that way is refused
every time, whether or not it is valid. `X-Ingest-Token` is an ordinary header
that passes straight through, which is where Flood-Net actually checks it.

## Payload shape

`payload` — the value nested under the top-level `"payload"` key, not the POST
body itself — is one reading, an array of readings, or an object with a
`readings` array plus shared defaults for the batch:

```json
{
  "source": "http",
  "path": "MT_STUART",
  "readings": [
    {"alert_id": 6128, "reading_ts": "2026-08-11T04:15:00Z", "value_raw": 301},
    {"alert_id": 6129, "reading_ts": "2026-08-11T04:16:00Z", "value_raw": 12},
    {"station_number": "541155", "channel": "level",
     "reading_ts": 1786000500, "value_raw": 1.842, "unit": "m"}
  ]
}
```

**Those are three different stations, in one POST, under one token** — which is
the normal case for a base station, not a special one. Nothing in the batch names
a station: each reading's `alert_id` or `station_number` is the address, and
Flood-Net resolves it. Send everything your base station heard since the last POST
and let the addresses sort it out.

The two shapes travel together on purpose, and the base station at 18 Bateson is
where that is exercised live: it relays ALERT2 addresses off the air *and*
reports four sensors wired to the logger's own terminals, which have no ALERT
address because there is no packet — so they report as `station_number` 999998
with a channel, in the same batches. See
[`live-end-to-end-test.md`](live-end-to-end-test.md) and
`db/migrations/0026_bateson_test_rig.sql`.

| Field | Required | Notes |
| --- | --- | --- |
| `alert_id` | one of `alert_id` or `station_number` | Your ALERT/ALERT2 address, 1–65535. A radio logger has this and no `channel`. |
| `station_number` | one of `alert_id` or `station_number` | A satellite or cellular station's number, if it has no ALERT address. |
| `channel` | with `station_number` | Which sensor at that station number — e.g. `"rain"`, `"level"`. Not used alongside `alert_id`. |
| `reading_ts` | yes | When the device took the reading. ISO 8601 (`"2026-08-11T04:15:00Z"`), or epoch seconds/milliseconds as a number. |
| `value_raw` | yes* | The value as your device measured it — a raw count, or an engineering value if that is all your device has. *A reading carrying only `value` is accepted — `value` stands in as the raw record — but send `value_raw` where the device has one; a row with neither is rejected. |
| `value`, `unit` | no | The converted engineering value and its unit, if your device (or you) already did the conversion. Units are from a fixed list — `mm`, `m`, `V`, `degC`, `NTU`, and others; an unrecognised one is a rejected row, not a silent guess. |
| `quality` | no | `good`, `suspect`, `estimated`, `bad`, or `missing`. Defaults to unstated. What the source asserts about the *value* — not the signal; that is the next four. |
| `freq_mhz` | no | The frequency your receiver heard it on, in MHz — `151.525`, not `151525000`. |
| `rssi_dbm` | no | Received signal strength in dBm, from a receiver that measures it in dBm (a radio, an ERT-A2). |
| `level_dbfs` | no | The burst's level against the receiver's full scale, in dBFS — what an RTL-SDR has instead of dBm. |
| `snr_db` | no | Signal over the receiver's noise floor, in dB. The figure that compares across receivers; send it whenever you know the noise floor. |

`source` and `path` may be set once at the top level and apply to every reading
in the batch, or set per-reading to override it. `source` defaults to `"http"`
if you leave it out entirely. `freq_mhz` may sit at the top level too, for a
batch from one receiver channel.

**The last four never cost a reading** (`0050`). They describe how your copy
was heard, not what was measured, so one that is missing, not a number or out of
range (a frequency outside 0.001–100,000 MHz, an RSSI outside −200…+50 dBm, a
level outside −200…+20 dBFS, an SNR outside −100…+200 dB) is stored as null and
the reading is kept — never a rejected row. They are stored for the copy Flood-Net
keeps: the first to arrive. A later copy of the same reading is counted and its
`path` recorded, but its frequency and signal are not; every copy, with its level,
is what [`report_receptions()`](reception-map.md) keeps for the Reception
Map.

**A batch is at most 1,000 readings.** A larger one is refused outright — split
it into more than one `POST`.

**Retrying is safe.** The same reading posted twice — same address, same
`reading_ts`, same `value_raw` — is stored once. If your logger's connection
drops after it sent the request but before the response arrived, resend the same
batch; you will not get a duplicate. Do not build your own acknowledgement
protocol on top of this — the endpoint already gives you an idempotent retry.

## Errors

**One bad reading does not lose the rest of the batch.** Every reading is
checked on its own; a bad one comes back in `rejected` and the others are still
stored:

```json
{
  "accepted": 99,
  "duplicates": 0,
  "rejected": [
    {"i": 47, "why": "reading_ts 1970-01-01T00:03:00+00:00 is before 1990 — a dead clock, not a reading"}
  ],
  "raw_id": 4822
}
```

`i` is the reading's position in your `readings` array, counting from zero. The
most common `why` you will see in the field:

| Reason | Usually means |
| --- | --- |
| `reading_ts … is before 1990 — a dead clock, not a reading` | The logger's real-time clock has lost power and reset to 1970 (or similar). Check the battery backing the RTC, not the network. |
| `reading_ts … is more than a day in the future` | The clock is fast, or set to the wrong year. |
| `unknown unit: …` | A `unit` value that is not on Flood-Net's list. Send `value_raw` without `unit`/`value` if you are not doing the conversion yourself. |
| `no address: a reading needs an alert_id, or a station_number for a station that has none` | Neither field was set. |
| `alert_id % is outside 1-65535` | Typo, or a value read from the wrong register. |

**A malformed request is a `400`, not a partial accept** — this is the caller
misunderstanding the contract, a different thing from a device sending one bad
reading. This assumes a **valid** token: `ingest_http` checks `X-Ingest-Token`
before it looks at the body at all, so an invalid token reports `401`
regardless of what the body says — swap in a real one to see this response.

```sh
curl -o /dev/null -w '%{http_code}\n' -X POST \
  'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/ingest_http' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'X-Ingest-Token: mgn_your-token-here' \
  -H 'Content-Type: application/json' \
  -H 'Content-Profile: meganet' \
  -d '{"payload": {"readings": "not an array"}}'
# => 400 (with a valid token; an invalid one reports 401 first)
```

**No token, or a bad one, is `401`:**

```sh
curl -o /dev/null -w '%{http_code}\n' -X POST \
  'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/ingest_http' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'Content-Type: application/json' \
  -H 'Content-Profile: meganet' \
  -d '{"payload": {"readings": []}}'
# => 401, no X-Ingest-Token header at all

curl -o /dev/null -w '%{http_code}\n' -X POST \
  'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1/rpc/ingest_http' \
  -H 'apikey: sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY' \
  -H 'X-Ingest-Token: mgn_made-up-and-invalid' \
  -H 'Content-Type: application/json' \
  -H 'Content-Profile: meganet' \
  -d '{"payload": {"readings": []}}'
# => 401, token does not match anything live
```

A token stops working **immediately** once it is revoked — there is nothing
cached and no lifetime to wait out. The next request with that token gets the
same 401 as one that never existed.

## What a token can and cannot do

A token unlocks exactly one thing: calling this endpoint. It cannot read
`meganet.reading`, `meganet.station`, or anything else — there is no path from
`X-Ingest-Token` to a `select` on anything. (The station list and the readings
themselves are separately public, reachable with the `apikey` above and no token
at all — that is a deliberate, pre-existing decision recorded in
[`db/README.md`](../db/README.md) and has nothing to do with this endpoint. A
compromised token adds no read access beyond what was already public.)

What it *can* do is write readings for any address, including addresses your base
station has never heard. Coverage is not enforced — there is no list of "the
stations this base is allowed to post for", and `alert_low`/`alert_high` on the
token record are a note, not a rule. Treat a base station's token as a credential
worth the whole network's write access, because that is what it is: keep it in a
config file the logger reads rather than typed into a script, and revoke it the
day the hardware leaves your control.

## Which base station wrote a reading

Every reading records the ingest point it arrived through, which is what makes a
shared token safe to run. If a base station is misconfigured, or its token leaks,
this is the query that says what it touched:

```sql
select t.label, r.station_id, count(*) as readings, max(r.received_at) as latest
  from meganet.reading r
  join meganet.ingest_token t on t.id = r.ingest_token_id
 where t.label = 'Mt Stuart base'
 group by t.label, r.station_id
 order by readings desc;
```

A null `ingest_token_id` means the reading did not come through this endpoint — a
backfill, or a manual entry by an editor. Readings stored before this was added
are null too.

## A browser as an ingest point

The Serial Monitor's receiver cards — a Quansheng radio, an ERT-A2, an RTL-SDR —
can post what they decode through this same endpoint, holding a token minted for
the computer they run on, with `source: "serial"` and a per-receiver `path`. Each
receiver also says what and roughly where it is through
`meganet.report_ingest_point()` (`0045`), its location always marked approximate
unless it came from a GPS. That page is [`ingest-serial-monitor.md`](ingest-serial-monitor.md).

## Getting a token

Two ways round. **The base station asks** — the easy one for a Raspberry Pi or
any device nobody wants to sign in on — or **an administrator mints one** and it
is carried to the device.

### A base station that asks for its token

`0048`. The device makes its own token, asks Flood-Net to approve it, and shows a
short code; an administrator signed in anywhere — a phone, a work computer —
approves it on the **Admin** tab, and the device starts posting by itself. Nothing
is copied, typed or carried, and nobody signs in on the device. It is the device
authorisation grant of RFC 8628, the way a television signs in to a streaming
service.

1. **On the device**, press **Request a token**: RPi ALERT's **Settings →
   Flood-Net** (or the banner on its dashboard, on the Pi's own screen or at
   `http://rpi-alert.local/`), `rpi-alert request-token` over SSH, or **Ask an
   administrator** in a Serial Monitor card. It shows a code such as `WDJB-MJHT`,
   and on RPi ALERT a QR code.
2. **On a phone or computer signed in to Flood-Net as an administrator**, open
   **Admin → Ingest tokens**. The request is under **Waiting for approval** within
   a few seconds — or scan the QR code, which opens it directly
   (`https://floodwarning.net/#pair=WDJB-MJHT`).
3. **Check the code matches what the device shows**, change the label if you like,
   and press **Approve**. The device notices within five seconds and starts
   sending. **Deny** turns it down.

**Check the code.** Anyone can ask (that is what makes it work without a sign-in),
so the code is how you know the request you approve is the device in front of
you and not somebody else's with a copied name. Two waiting requests never share
a code. A request lasts **30 minutes**; at most **20** wait at once.

**A reflashed Pi** asks under the name its old token still holds. The approve form
says a live token already has that label and offers **Replace it**, which revokes
the old token in the same step.

What travels: the device draws `mgn_` and 64 hex characters from its own random
number generator and sends them in `X-Ingest-Token`, exactly as it will to
`ingest_http()` afterwards. Flood-Net keeps only their hash; approving turns that
hash into an ordinary ingest token, revoked from the same panel the same way. So
there is no token sitting in the database waiting to be collected, and a dropped
connection cannot lose it. For a device of your own:

```sh
TOKEN="mgn_$(openssl rand -hex 32)"           # keep this — it is the device's token
curl -sS "$URL/rest/v1/rpc/request_ingest_token" \
  -H "apikey: $KEY" -H "X-Ingest-Token: $TOKEN" \
  -H 'Content-Type: application/json' -H 'Content-Profile: meganet' \
  -d '{"payload":{"label":"Mt Stuart base","detail":{"app":"my logger"}}}'
# => {"status":"pending","code":"WDJB-MJHT","expires_in":1800,"poll_s":5,…}

# Every five seconds until it is not pending:
curl -sS "$URL/rest/v1/rpc/ingest_token_request_status" \
  -H "apikey: $KEY" -H "X-Ingest-Token: $TOKEN" \
  -H 'Content-Type: application/json' -H 'Content-Profile: meganet' -d '{}'
# => {"status":"approved","label":"Mt Stuart base"} — now post readings with $TOKEN
```

The status is one of `pending`, `approved`, `denied`, `expired`, `withdrawn` (the
device called `withdraw_ingest_token_request` to stop waiting), `revoked` or
`unknown`. A token asks once: after a denial or an expiry, make a new one and ask
again. `429` means 20 requests are already waiting — try again in a few minutes.
`payload.host_station_id` may name the station the device sits at; the
administrator sees it as a suggestion.

**Once it posts, it can check in too** (`0049`): with the same token, a base
station whose software supports it reports its health to the **Base Stations**
tab about once a minute and collects what an administrator asks of it there —
Flood-Net never connects to it. [`base-stations.md`](base-stations.md) is the tab
and the protocol.

### An administrator mints one

**From the app:** an administrator mints, lists and revokes tokens on the
**Admin** tab, under **Ingest tokens** (`0046`). The token is shown once, with a
copy button. **From SQL**, which still works — run this from the Supabase SQL
editor or `psql`, as a role that can reach `meganet` directly (the service key,
or a direct connection — see `db/README.md`):

```sql
select meganet.create_ingest_token('Mt Stuart base');
-- {"id": 3, "label": "Mt Stuart base", "token": "mgn_a1b2c3…"}
```

**Name it for the ingest point, not for a station it relays.** "Mt Stuart base"
is a label someone standing at the site would recognise; "Durikai rainfall" is
the name of one of the forty things behind it and will be wrong within a month.

**Copy the `token` value now.** Only its hash is stored; there is no way to look
it up again. If you lose it, mint a new one and update the base station.

Optionally record which station the ingest point *lives* at — a location, purely
so a future map can draw it. It does not restrict anything:

```sql
select meganet.create_ingest_token('Mt Stuart base', 'mt_stuart');
```

## Revoking a token

One `update`, from the same place you minted it:

```sql
update meganet.ingest_token set revoked_at = now()
 where label = 'Mt Stuart base';
```

It takes effect on the token's very next request — nothing is cached and there is
no lifetime to wait out.

**Revoking a base station's token stops every station behind it.** That is the
right thing to do the day the hardware is lost, sold, or handed to a contractor,
but do it knowing the reach: have the replacement token ready to load, because
between the two the whole site is off the air.

## Which stations have gone quiet

**Do not use `ingest_token.last_used_at` for this.** It tells you the base station
is alive, and it moves identically whether one of its forty stations stopped
transmitting or none did. It answers "is Mt Stuart base still calling home", which
is a real question but a different one:

```sql
select label, last_used_at, revoked_at
  from meganet.ingest_token
 order by last_used_at nulls first;
```

Per-station silence is `meganet.station_health`, which HTTP ingest and the MQTT
bridge both feed:

```sql
select station_key, station_name, minutes_since_seen, minutes_since_reading
  from meganet.station_health
 where minutes_since_seen > 180
 order by minutes_since_seen desc;
```

`minutes_since_seen` is time since that station was last heard, **including
through a reading that was rejected** — a logger whose clock has died is still
transmitting. *Heard* is the reading's own time (never later than its arrival),
so a base station posting a backlog days late fills in history without making
its stations look heard today; a time from a dead clock — none, before 1990,
more than a day ahead, or over 90 days old in a batch not marked
`"source": "backfill"` — counts as heard on arrival (`0052`). `minutes_since_reading` is time since one was actually
stored. The two diverging is the signature of a station that is on the air and
sending something Flood-Net will not accept: check `rejected` in your POST
responses, not the radio path.

A `station_key` that looks like `a:6128` or `s:541155` rather than a station name
is an address Flood-Net could not resolve to exactly one station — 604 ALERT
addresses in the current data are carried by more than one station, so it records
the address it has rather than guessing.

## Rate limiting

There isn't any, at the HTTP layer — PostgREST does not do it, and this project
does not run anything in front of it that could, yet. For a pilot's worth of base
stations this is an accepted trade, and a smaller one than it was per-station:
there are far fewer tokens now, each one is loaded by someone commissioning
hardware rather than handed out per site, and every reading carries the token
that wrote it, so an ingest point behaving badly is a query rather than a
guess. If it becomes a real problem, the fix is Cloudflare in front of the
endpoint, not application code — the same infrastructure already planned for the
app itself.
