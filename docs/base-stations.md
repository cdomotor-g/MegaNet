# Base stations — checking in, being asked, and the team keys

The **Base Stations** tab (in the Admin group, administrators only) lists every
ingest point Flood-Net has issued a token to, and for the base stations whose
software checks in, how each one is: whether it is checking in, its receivers
and what they have decoded, its uplink and queue, its power, temperature, disk
and clock, its software — beside the latest
[RPi ALERT release](https://github.com/cdomotor-g/RPi_ALERT/releases/latest),
in amber when it is behind — and its settings. Open one and you can ask it to change
a setting, restart a receiver or itself, look for receivers, install an update,
fetch its SSH keys again, or show its log — without going to site.

Below the list are the team's **SSH public keys**, which a base station whose
owner allows it installs for its maintenance login.

This page is for an administrator using the tab, and for whoever writes a base
station's software. The database side is
[`db/migrations/0049_base_stations.sql`](../db/migrations/0049_base_stations.sql)
(and [`0068_base_station_spectrum.sql`](../db/migrations/0068_base_station_spectrum.sql),
the waterfall) and [`db/README.md`](../db/README.md); `tools/check_base_stations.sql` holds the
functions to the contract described here.

## Flood-Net never connects to a base station

```
 base station ──HTTPS, X-Ingest-Token──▶ meganet.base_station_checkin()  ◀── the Base Stations tab
              ◀── "next in 60 s" + anything asked                         (an administrator, signed in)
```

**A base station checks in; nothing reaches it.** About once a minute it calls
`base_station_checkin()` over the same HTTPS door, with the same ingest token, as
its readings — so it works wherever readings get out, behind any NAT, firewall or
cellular modem, and there is no port to open, no tunnel, and nothing listening on
the station for anybody to find. What an administrator asks waits in the
database until that check-in collects it, and the answer comes back with the one
after.

So the tab never shows a request as done until the station has said so. Opening
a station tells it — in the answer to its next check-in — to check in every five
seconds for the next three minutes, renewed while the panel stays open; that is
what makes the second request quick even when the first waits out the station's
minute.

## What a base station may be asked

Only these. The database refuses anything else (`base_station_verb_check()`),
and the station's software is expected to hold itself to the same list again —
the reference agent does.

| Request | Arguments | |
|---|---|---|
| `status` | — | send the whole status with the next check-in |
| `log` | `lines` 1–400 | the last lines of its own log |
| `config.set` | `patch` (an object) | change settings, through the station's own checks |
| `device.restart`, `device.forget` | `key` | restart a receiver; forget an unplugged one |
| `device.rescan` | — | look for receivers |
| `send-now`, `stations.refresh` | — | send what is queued now; download the station register again |
| `agent.restart`, `reboot` | — | done once the answer has been delivered |
| `update.check`, `update.install` | — | check for, and install, the latest release |
| `update.auto` | `on` true/false | install new releases by itself, or not |
| `access.sync` | — | fetch its SSH key lists again |

**Never a shell, a file, a key, or a secret.** `config.set` may not touch the
station's ingest token or where its readings go (of `meganet.*`, only `enabled`
and `receptions`), its web page's password or port (`web.*`), or how much it
lets Flood-Net do (`remote.*`) — the database refuses such a patch, and so does the
station. Flood-Net cannot widen its own reach, and there is no power-off: a station
on a hill that was told to shut down needs somebody to drive there.

**A stick's frequency correction changes only when a patch says so.** A
patch's `receivers.sdrDevices` replaces the station's list whole. From RPi
ALERT 0.15.2 the station works out each stick's correction before and after —
as it finds them: the stick's entry by key, else an RPi ALERT 0.4 entry by its
serial, else the shared one — and refuses a patch that would change one
without giving that stick a `ppm` (or changing the shared one it already
followed), naming the stick and what it would have lost. A stick without its
correction goes on decoding, so nothing else would show it, but every carrier
it measures is off by that much, and with them the fingerprints Station Health
tells transmitters apart by. The form here keeps each stick's correction as
the station sent it, and carries a 0.4 entry's into the stick's own when the
stick is changed; a patch written by hand is where this bites — give `ppm` in
the entry of every stick with a correction of its own.

**Each request is done once.** The check-in hands a request over once (it is
`sent` from then on, and never handed over again), at most ten a check-in. A
request not collected within **ten minutes expires** rather than running hours
later when a station that was offline comes back; at most **20 wait** for any one
station (`PT429` beyond); a request still waiting can be cancelled. One already
handed over cannot be called back.

## The station decides how much

The station's owner sets, on the station and never from here, what Flood-Net may
do (`remote.mode` in the reference agent):

| | |
|---|---|
| `manage` (the default) | its health here, and the requests above |
| `report` | its health only; the tab offers nothing to ask, the database refuses any request, and anything that was waiting fails saying why |
| `off` | no check-ins at all. Switched off while running, it says so once, so the tab shows *turned off on the station* rather than a station that went quiet |

A station that posts readings but whose software does not check in is listed as
**not managed**, with when it last posted and the receivers its reports name
(`0045`). Its token is under **Admin → Ingest tokens**, as before.

## Reading the list

| State | |
|---|---|
| **online** | checked in within three of its own intervals (at least three minutes) |
| **quiet** | not for longer than that, but within the hour |
| **offline** | not for over an hour |
| **turned off on the station** | it said it is not checking in any more |
| **not managed** | it has never checked in |

Ages are worked out on the database's clock, which every answer carries, so a
laptop whose clock is five minutes out does not call every station quiet. Since
`0059` the database says which state a station is in
(`meganet.base_station_state()`), and the tab shows that — the same definition
its findings below are opened on, so the tab and an alert cannot disagree.

**Needs a look** says, worst first: a refused token, under-voltage now or since
boot (a weak supply drops USB receivers), a temperature of 65 °C or more (75 is
red), throttling, a clock not set yet (readings are held until it is), under
500 MB of disk, over 500 readings waiting to be sent, receivers that are not
receiving, and a receiver that has **decoded nothing for hours** — which the
receiver's own row says too, beside its count.

## What its radios hear

Under an open base station's panel is a **waterfall** of what its SDR sticks
hear (`0068`): every stick on one picture, frequency across and time down,
newest at the top, each stick's span and channel labels in its own colour. The
last hour comes in ten-second slices, six hours in minutes, a day in four-minute
slices; bright is strong, against each stick's own noise floor (0–40 dB). The
bursts the station heard are marked on their channels — decoded, and heard but
not decoded — since the spectrum is a few short looks a second and can miss one,
and under the picture the busiest channels are listed in words. Point at it for
the frequency, the level over the floor, and what was heard on the channel there.

A stick's outer tenth either side is the **edge of its window**: the RTL2832U's
filter rolls off there, and a signal just past one edge folds back in at the
other, which is why the station keeps its channels out of it. Where another
stick hears the same frequency in the middle of its own window, that is what is
drawn; where only an edge reaches, the picture is darkened and hatched, and the
tip says so. At 18 Bateson in October 2026, 151.575 just past the top of a
240 kHz window showed as "packets" on 151.337 at its bottom edge — the same
bursts, minute for minute, and no station of its own.

It costs the station nothing new. Its decoders work the spectrum out anyway;
each stick keeps the strongest every slice of its band has been since the last
check-in and sends that row with it, 256 bytes. So the picture is a check-in
behind — a minute normally, five seconds while the station is open, which is
also how often its rows come — and a gap in it is a time the station was not
checking in. Two days of rows are kept. It needs RPi ALERT 0.13.5 or later on
the station; an older one, or a station with no SDR stick, has no waterfall.

## Channel by channel

Under the waterfall, **Channel by channel** (`0081`) takes the last day, week or
month of what the station heard and sets each frequency beside two other
sources: what Flood-Net's register puts there — the TX and RX of repeaters
within 250 km and the other frequencies stations list — and what the ACMA has
licensed within 100 km (the RRL extract in `data/acma-devices.json`). Each
frequency gets a word:

| | |
|---|---|
| **Expected** | it decoded something there, and the register has it |
| **Licensed to …, not in the register** | decoded, the ACMA licenses it (to the licensee named), the register has nothing — a gap in the register, often another agency's network |
| **Not expected, and no licence found** | decoded, and neither has it — unlicensed, a licence outside the extract, a mirror image or intermodulation; look into it |
| **Bursts, but none decode** | heard, never read |
| **Expected here, not listened to** | the register has it nearby and no stick is on it |
| **Listened to, nothing heard** | a stick is on it and nothing came |
| **Listed on a stick, outside its window** / **…which is not receiving** | set, but not decoded |

and notes under it: IDs that are the register's stations more than 400 km away
(another network using the same IDs — 18 Bateson hears IDs the register gives to
Victorian gauges), IDs the register does not have, ALERT2 sources none of which
are in the register, legacy ALERT on an ALERT2 link (each burst a wasted decode
attempt), a channel heard earlier that no stick listens to now. Beside them:
what was heard and decoded per protocol and on how many days, the stations
decoded most, the register's entries, the licensees, and which stick listens
now. Licences on frequencies the station neither hears nor lists are folded
away beneath. It reads the hourly rollups, so the last hour may not be in yet,
and a month comes by the day.

## Noticed with the tab closed

Every five minutes the database works out, by itself (`pg_cron`,
`meganet.refresh_base_station_findings()`, `0059`):

- **A base station not heard from** — quiet is a warning, offline is critical,
  by the states above. A station turned off on the station is not a fault, and
  a revoked token is forgotten.
- **A receiver that runs and hears nothing.** A heartbeat carries each
  receiver's count of decoded frames but not when the last one was — an SDR's
  "seconds since data" is empty — so a stick running with its antenna off passed
  every test there was. The database now remembers each count and when it last
  moved: an SDR or an ERT-A2 whose count has not moved for **6 hours** is a
  warning (a busy channel decodes something every few minutes), any other
  receiver after 12, and a day is critical. A restart resets the count, which
  counts as a move. A GPS, and a receiver set aside on the station, are not
  judged; one the station stops naming is forgotten.

Each is a row in `meganet.health_finding` that opens on the run it is first
true, is kept up to date while it stays true, and clears on the run it stops —
what #216's alerts act on. While a base station is away, nothing new is known
about its receivers: what was found about them stands, and nothing is added.
These findings are about equipment only administrators see, so only
administrators can read them.

`tools/check_health_findings.sql` proves each — opening, getting worse, held,
cleared — against Postgres.

## Its connection over time

The Admin tab's **Base station connections** (`admin-links.js`, `0080`) is the
record the findings above do not keep: when each station stopped checking in,
when it came back, and what changed. A trigger on `base_station` compares each
check-in with the one before it:

- **A gap** — more than three idle periods and at least three minutes, the same
  line as *quiet* above — is a **dropout** when the heartbeat's uptime (`up`)
  spans it (the computer stayed up: the connection), a **restart** when the
  computer started again inside it (power, or a reboot), and a **software
  restart** when only the agent did (`agent_up`). A station that said `off` is
  not gapped.
- **A new address** — the network it calls from, kept only as its block
  (`168.140.x.x`, `2406:2d40::/32`) with a fingerprint keyed with the token's
  hash, so a new address in the same block is seen too. IPv4 and IPv6 are
  followed apart, and an IPv6 address by its /64, whose host half a computer
  changes daily.
- **A new route** — through floodwarning.net's Worker, or straight to Supabase.

Before `0080` the record comes from the readings: an arrival gap of five
minutes or more with readings heard inside it, held and sent on the station's
return, is a dropout; with none, *no readings* — nothing heard and nothing
sent, cause unknown, and not counted against uptime.

The card shows each station's uptime since it was first seen, its dropouts
and restarts, the longest gap, how long it has been connected and its network;
a row a day, midnight to midnight in the browser's time zone, with each gap
where it fell; and the gaps by hour of the day, which says so in words when
they cluster — 18 Bateson's three nine-minute dropouts at about 3 am on 17, 21
and 24 Oct 2026 look like its Starlink dish's overnight update. The **Connection
log** under it lists every event with when it was lost and when it came back.
`tools/check_base_station_links.sql` proves the record against Postgres and
`npm run adminlinks` the card.

## The team SSH keys

Every base station running the reference agent has the same maintenance login,
`alert`, with no password: SSH keys open it, one per person. Whoever sets a
station up can put keys on it from its SD card, and its owner can tell it to
follow a list kept somewhere else — a team's GitHub accounts, or **this list**.

- **Public keys only.** Nothing here can log in to anything by itself, and the
  list is never pushed: a station fetches it, with its own ingest token, only if
  its owner turned that on. The tab shows which stations take it.
- **They work only from a private network** (the site's LAN, a VPN, carrier-grade
  NAT as Tailscale uses) unless the station's owner says otherwise — so a station
  that ends up with a public address is not opened to the internet by a list
  somebody else keeps.
- **One key per person, with whose it is.** When somebody moves on, take their
  key off: stations that take the list drop it at their next fetch — within a
  minute for one checking in (the check-in answers with the list's hash, and a
  station whose copy differs fetches again), and within the hour otherwise.
  Taken-off keys stay on the record for 90 days, with who took them off.
- **Checked before it is listed.** Ed25519, ECDSA and security keys, and RSA of
  2048 bits or more; the fingerprint shown is the one `ssh-keygen -l` prints. A
  key already on the list is refused.

Making a key, if you have none: `ssh-keygen -t ed25519` (Windows 10 and later
have it too, in PowerShell). The public half is `~/.ssh/id_ed25519.pub` — that
one line is what goes in the box.

## For whoever writes a base station's software

Any software holding an ingest token can be a base station here; nothing in the
tab is specific to one device. The station calls two functions, both with the
headers its readings use:

```
POST <project>/rest/v1/rpc/base_station_checkin
apikey: <publishable key>
X-Ingest-Token: mgn_…
Content-Profile: meganet
Content-Type: application/json

{"payload": {
  "v": 1,
  "agent":  {"app": "…", "version": "0.6.0"},
  "mode":   "manage",                      // manage | report | off
  "idle_s": 60,                            // how often it checks in unwatched, 30–900
  "beat":   {…},                           // every check-in, ≤ 2 KB
  "status": {…},                           // when it changed, ≤ 16 KB
  "results": [{"id": 17, "ok": true, "result": …}, {"id": 18, "ok": false, "error": "…"}],
  "keys_hash": "…",                        // the team-key list it holds, if it takes it
  "spectra": [{"key": "sdr-serial:00000001", "center_hz": 151935000, "rate": 1200000,
               "span_s": 60, "floor_db": -45.5, "bins": "AAIE…"}]   // since 0068, optional
}}
```

and is answered

```json
{"next_s": 60, "watch": false, "want_status": false,
 "commands": [{"id": 19, "verb": "log", "args": {"lines": 200}}],
 "keys_hash": "…", "label": "Mt Stuart base", "at": "2026-10-05T04:12:00Z"}
```

- **`next_s`** is when to check in next: the station's own `idle_s` normally,
  **5** while an administrator has it open, **2** while more requests wait than
  one check-in carries, and `null` when it said `off`. Spread a fleet out with a
  little jitter; check in again at once after doing something, to deliver the
  answer.
- **`results`** answers requests by id — at most 20 a check-in, each a `result`
  of up to 64 KB (a larger one is kept as `{"truncated": true}`) or an `error`,
  of which the first 1,000 characters are kept. A station can only answer its own
  requests, and only ones handed over or still waiting.
- **`want_status`** asks for the whole status with the next check-in.
- **`spectra`** (since `0068`) is a row per SDR stick for the waterfall: the
  strongest each bin of the stick's spectrum was since the last check-in, a
  byte a bin (16–1,024 of them, lowest frequency first) in half-dB steps over
  `floor_db`, base64; `key` is the stick's key in the status's `receivers`,
  `center_hz` and `rate` what it was tuned to, `span_s` how long the row covers.
  At most eight a check-in and one a stick in four seconds; a row that does not
  fit is left out without failing the check-in.
- **`beat`** and **`status`** are what the tab draws. The beat keeps the last
  status, so a check-in carrying only a beat costs a few hundred bytes. The
  fields the tab reads are those of the reference agent: in the beat, `up`,
  `agent_up`, `temp`, `load`, `mem_free`, `disk_free`, `uv`, `uv_boot`,
  `throttled`, `clock`, `q`, `hold`, `rxq`, `stored`, `refused`, `last_ok`, and `rx`
  — one `[key, state, decoded, seconds since data]` per receiver; in the status,
  `name`, `host`, `clock`, `location`, `meganet`, `receivers`, `update`, `access`,
  `remote` and `config`. **Never put a secret in either**: no token, no
  password hash, no private key. Fingerprints and key comments are what the
  `access` part is for.

The team keys, if its owner allows it:

```
POST <project>/rest/v1/rpc/base_station_keys        (the same headers; body {"payload": {}})
→ {"hash": "…", "keys": [{"key": "ssh-ed25519 AAAA…", "comment": "Jo Bloggs", "fingerprint": "SHA256:…"}]}
```

Fetch it hourly and whenever a check-in's `keys_hash` differs from the copy held.
Keep the last good copy through a network outage; drop the list when Flood-Net
refuses the token. Restrict the keys yourself (`from="10.0.0.0/8,…"` in
`authorized_keys`) — the list carries none, since only the station knows what
"local" means where it is.

A `404` from either function is a Flood-Net without `0049`: check in again an hour
later. A `401` (`PT401`) is a token Flood-Net does not accept: back off, and keep
sending nothing else on it.

## Security, in one place

- Nothing listens on a base station for Flood-Net, and nothing Flood-Net sends is
  run as a command: requests are one of a fixed list, checked twice.
- The ingest token authenticates the station to Flood-Net, as for its readings;
  TLS authenticates Flood-Net to the station. Only an administrator can ask
  (`meganet.admin_require()`, first thing in every function the tab calls), and
  every request records who asked.
- Someone who got into Flood-Net as an administrator could do what administrators
  can: the requests above, of stations set to `manage`. They could not read a
  station's token or passwords, redirect its readings, set its web page's
  password, add a key to it, turn its management back on, or run a command; and
  team keys work only from a private network unless the station says otherwise.
  `report` or `off`, on the station, takes even that away.
- What the tables hold is reachable only through the functions above: row level
  security on, no policy, no grant.
