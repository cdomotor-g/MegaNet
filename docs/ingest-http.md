# HTTP ingest — posting readings from a field station

This page is for whoever is configuring a logger to send readings to MegaNet. It
assumes you have a serial cable and a datasheet for your device, not that you have
read this repository. If you are changing how the endpoint itself works, the
database side is `db/migrations/0007_ingest_http.sql` and `db/README.md`.

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
| `X-Ingest-Token` | Your device token — see **Getting a token**, below. This is the secret. |
| `Content-Type` | `application/json` |
| `Content-Profile` | `meganet` — MegaNet's tables live in their own schema, not `public`. Without this, PostgREST looks in `public`, finds no `ingest_http` there, and the request never reaches the database ([`db/README.md`](../db/README.md)). |

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
request reaches the database at all — a device token sent that way is refused
every time, whether or not it is valid. `X-Ingest-Token` is an ordinary header
that passes straight through, which is where MegaNet actually checks it.

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
    {"station_number": "541155", "channel": "level",
     "reading_ts": 1786000500, "value_raw": 1.842, "unit": "m"}
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `alert_id` | one of `alert_id` or `station_number` | Your ALERT/ALERT2 address, 1–65535. A radio logger has this and no `channel`. |
| `station_number` | one of `alert_id` or `station_number` | A satellite or cellular station's number, if it has no ALERT address. |
| `channel` | with `station_number` | Which sensor at that station number — e.g. `"rain"`, `"level"`. Not used alongside `alert_id`. |
| `reading_ts` | yes | When the device took the reading. ISO 8601 (`"2026-08-11T04:15:00Z"`), or epoch seconds/milliseconds as a number. |
| `value_raw` | yes | The value as your device measured it — a raw count, or an engineering value if that is all your device has. |
| `value`, `unit` | no | The converted engineering value and its unit, if your device (or you) already did the conversion. Units are from a fixed list — `mm`, `m`, `V`, `degC`, `NTU`, and others; an unrecognised one is a rejected row, not a silent guess. |
| `quality` | no | `good`, `suspect`, `estimated`, `bad`, or `missing`. Defaults to unstated. |

`source` and `path` may be set once at the top level and apply to every reading
in the batch, or set per-reading to override it. `source` defaults to `"http"`
if you leave it out entirely.

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
| `unknown unit: …` | A `unit` value that is not on MegaNet's list. Send `value_raw` without `unit`/`value` if you are not doing the conversion yourself. |
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

A device token unlocks exactly one thing: calling this endpoint. It cannot read
`meganet.reading`, `meganet.station`, or anything else — there is no path from
`X-Ingest-Token` to a `select` on anything. (The station list and the readings
themselves are separately public, reachable with the `apikey` above and no token
at all — that is a deliberate, pre-existing decision recorded in
[`db/README.md`](../db/README.md) and has nothing to do with this endpoint. A
compromised device token adds no read access beyond what was already public.)

## Getting a token

Token issuing is a database operation for now — there is no page in the app for
it, on the reasoning that a UI can wait until it is actually needed for a pilot
this size. Run this once, from the Supabase SQL editor or `psql`, as a role that
can reach `meganet` directly (the service key, or a direct connection — see
`db/README.md`):

```sql
select meganet.create_ingest_token('Mount Stuart logger');
-- {"id": 3, "label": "Mount Stuart logger", "token": "mgn_a1b2c3…"}
```

**Copy the `token` value now.** Only its hash is stored; there is no way to look
it up again. If you lose it, mint a new one and update the logger.

To scope a token to one station (recorded for now, not yet enforced — see
`db/README.md`), pass the station's id and/or an ALERT address range:

```sql
select meganet.create_ingest_token('Mount Stuart logger', 'mount_stuart', 6100, 6199);
```

## Revoking a token

One `update`, from the same place you minted it:

```sql
update meganet.ingest_token set revoked_at = now()
 where label = 'Mount Stuart logger';
```

Do this the day a logger is lost, sold, or handed to a contractor. It takes
effect on the token's very next request.

To see which loggers have gone quiet — the question `last_used_at` exists to
answer:

```sql
select label, last_used_at, revoked_at
  from meganet.ingest_token
 order by last_used_at nulls first;
```

## Rate limiting

There isn't any, at the HTTP layer — PostgREST does not do it, and this project
does not run anything in front of it that could, yet. For a pilot's worth of
loggers this is an accepted trade; watch `last_used_at` above. If it becomes a
real problem, the fix is Cloudflare in front of the endpoint, not application
code — the same infrastructure already planned for the app itself.
