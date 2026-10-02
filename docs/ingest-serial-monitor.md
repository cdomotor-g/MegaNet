# The Serial Monitor as a base station

A receiver card on the Serial Monitor — a **Quansheng radio** on the ALERT receiver
firmware, an **ELPRO ERT-A2**, an **RTL-SDR** stick (on this computer, or on a
Raspberry Pi whose log the card follows — [`sdr-pi.md`](sdr-pi.md)) — can post every
reading it decodes into MegaNet's database. The computer it runs on becomes an ingest point,
exactly as [`ingest-http.md`](ingest-http.md) describes one ("a PC on the end of a
serial cable"): it holds an ingest token, posts through `meganet.ingest_http()`, and
every reading it stores is deduplicated, validated and attributed like any base
station's.

It works the same whether the card reads a COM port, a USB stick, or the log file
PuTTY writes (see [`serial-help.html#putty`](serial-help.html#putty)).

## Setting one up

1. **Get a token for the computer** — one per computer, not per card or station.
   An administrator does it on the **Admin** tab, under **Ingest tokens**: give it a
   label someone would recognise (*Cameron work laptop*) and press **Create token**.
   It is shown once — only its hash is kept.
   - Setting up **this** computer? Press **Use in this browser** and every Serial
     Monitor card here has it; nothing to copy.
   - Setting up another one? **Copy** it, and paste it into a card's **Send to
     MegaNet** panel on that computer.

   (The SQL route still works: `select meganet.create_ingest_token('label');`.)

2. On the card, open **Send to MegaNet** — the token is already there if you used
   it in this browser; otherwise paste it. It is kept in this browser only
   (localStorage), and the same token serves every card on this computer.

3. Give the receiver a **name** (it starts as e.g. *Quansheng radio on a Windows
   PC*) and say **where it is** — see below.

4. Tick **send this card's readings to MegaNet**. The status line names the ingest
   point the token belongs to and counts what is stored, already there, refused and
   waiting.

It stays on: after a reload, a new card of the same kind on the same computer picks
up the same receiver and carries on sending.

## Telling ingest points apart

Two things identify where a reading came from:

- **The token** — the computer. Every stored reading carries `ingest_token_id`.
- **The receiver** — each card makes itself an id once (`qs-1a2b3c4d`, `ert-…`,
  `sdr-…`, and `sdrpi-…` for an RTL-SDR on a Raspberry Pi, which the database is told
  is an `rtl-sdr`) and keeps it in this browser. Every reading it posts carries the
  path **`serial-monitor/<receiver id>`**, and the source `serial`. When two
  receivers hear the same reading, `ingest()` stores it once and records the second
  receiver's path in `dup_paths` — so it is on record that both heard it.

The receiver describes itself through `meganet.report_ingest_point()` (migration
`0045`) when it starts sending, whenever its name or location changes, and every 15
minutes: its name, what kind of receiver it is, and device details (firmware hash,
ERT-A2 decoder address and format, SDR frequency and tuner, whether it reads a port
or a log file, the browser). A report that changes anything is a new row in
`meganet.ingest_point_report`; one that repeats the last moves its `last_seen_at`.

```sql
-- What is behind each token now
select token_label, point_id, name, receiver, lat, lon, accuracy_m,
       location_source, location_approx, location_note, last_seen_at
  from meganet.ingest_point_latest
 order by last_seen_at desc;

-- Which receiver heard a station's readings, and where it said it was
select r.reading_ts, r.addr, r.value_raw, r.path, r.dup_paths,
       p.name, p.location_source, p.location_approx, p.location_note
  from meganet.reading r
  left join lateral (
    select * from meganet.ingest_point_report p
     where p.ingest_token_id = r.ingest_token_id
       and r.path = 'serial-monitor/' || p.point_id
       and p.reported_at <= r.received_at
     order by p.reported_at desc limit 1) p on true
 where r.station_id = 'marburg_al'
 order by r.reading_ts desc limit 50;
```

The reports are **readable by editors only**: a receiver on a laptop reports where
the laptop is, which may be somebody's house. The readings stay public as they always
were — their path names a receiver id, not a place.

## Location — approximate until there is a GPS

None of these receivers has a GPS, so every location is approximate, and the database
records it that way: `location_approx` is true, `location_source` says how it was
got, and `location_note` says it in words ("Approximate: … No GPS."). A constraint
refuses to store anything but a GPS fix as exact — so a mistake in the app cannot
turn a guess into a survey point.

| Choice on the card | `location_source` | Where it comes from |
| --- | --- | --- |
| this computer's location, as the browser gives it | `browser` | The browser's geolocation — Wi-Fi or IP — with the accuracy it states (often a kilometre or more on a desktop). IT policy may block it; the card says so. |
| at a station | `station` | The station you name (by number or name), its coordinates, and `host_station_id`. |
| coordinates typed in | `manual` | `latitude, longitude` as typed (longitude-first is turned round). |
| the middle of the stations it hears | `heard` | The median of the stations whose addresses only one station carries, with the median distance to them as the radius — the ALERT2 tab's own way of placing a capture. |
| not given | `none` | No coordinates at all. |

When GPS hardware arrives, it reports `location_source = 'gps'` and may be exact.
Nothing in the database has to change for that; the app needs a way to read the fix.

## What is sent, and when

- **Quansheng** — each DEC: its ALERT address and raw value, protocol `alert`.
- **ERT-A2** — each clean reading of each frame the receiver called clean, protocol
  `alert2`.
- **RTL-SDR** — each reading the decoder accepts (shadows never), protocol `alert`.
- **RTL-SDR on a Raspberry Pi** — each `RX` line the Pi printed, protocol `alert`. Timed
  by the Pi's clock where it has one (NTP, or the card's *Copy clock command*), else by
  the Pi's uptime against this computer's clock — so a reading the Pi queued before
  PuTTY opened the port goes with the time it was heard, not the time it arrived. From
  the log's history, only with the Pi's clock; otherwise counted and skipped.

**Times.** A reading off a live port or stick is timed by when it arrived. An ERT-A2
frame carries its own time of day (the network's clock), and that is used — on the
day nearest arrival — which is what lets two receivers hearing one frame agree on it;
if the frame time is more than ten minutes from this computer's clock (a timezone, a
drifting network clock) the card falls back to arrival time and says so.

**History.** A followed log's existing contents arrive all at once, so a reading from
them goes only if it carries a time of its own: the radio's clock (where it was set),
or an ERT-A2 ASCII line's frame time on the receiver's date. Anything else is counted
and skipped — never stamped "now". An RTL-SDR replaying an IQ capture, and every demo
card, never send at all.

Batches go every few seconds (sooner when 500 are waiting), at most 1,000 at a time.
A failed post is retried with a growing pause; what is waiting survives a reload (the
newest 5,000). A **refused token** (revoked or mistyped) stops sending and says so,
keeping what was waiting for when a working token is in. Retrying is always safe:
the same reading is stored once.

## Network

On `floodwarning.net` the post goes through the site's own `/api/db` route
(`worker/index.js`, which forwards `X-Ingest-Token` for this), so a network that
blocks the Supabase hostname does not stop it. Anywhere else it goes to the project
directly.

## Revoking

On the Admin tab, **Revoke…** beside the token (or
`update meganet.ingest_token set revoked_at = now() where label = '…';`).

Immediate, as for any ingest point — and every card on that computer stops, says the
token was refused, and keeps what it had to send.
