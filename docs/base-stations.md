# Base stations — checking in, being asked, and the team keys

The **Base Stations** tab (in the Admin group, administrators only) lists every
ingest point MegaNet has issued a token to, and for the base stations whose
software checks in, how each one is: whether it is checking in, its receivers
and what they have decoded, its uplink and queue, its power, temperature, disk
and clock, its software and its settings. Open one and you can ask it to change
a setting, restart a receiver or itself, look for receivers, install an update,
fetch its SSH keys again, or show its log — without going to site.

Below the list are the team's **SSH public keys**, which a base station whose
owner allows it installs for its maintenance login.

This page is for an administrator using the tab, and for whoever writes a base
station's software. The database side is
[`db/migrations/0049_base_stations.sql`](../db/migrations/0049_base_stations.sql)
and [`db/README.md`](../db/README.md); `tools/check_base_stations.sql` holds the
functions to the contract described here.

## MegaNet never connects to a base station

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
lets MegaNet do (`remote.*`) — the database refuses such a patch, and so does the
station. MegaNet cannot widen its own reach, and there is no power-off: a station
on a hill that was told to shut down needs somebody to drive there.

**Each request is done once.** The check-in hands a request over once (it is
`sent` from then on, and never handed over again), at most ten a check-in. A
request not collected within **ten minutes expires** rather than running hours
later when a station that was offline comes back; at most **20 wait** for any one
station (`PT429` beyond); a request still waiting can be cancelled. One already
handed over cannot be called back.

## The station decides how much

The station's owner sets, on the station and never from here, what MegaNet may
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
laptop whose clock is five minutes out does not call every station quiet.

**Needs a look** says, worst first: a refused token, under-voltage now or since
boot (a weak supply drops USB receivers), a temperature of 65 °C or more (75 is
red), throttling, a clock not set yet (readings are held until it is), under
500 MB of disk, over 500 readings waiting to be sent, and receivers that are not
receiving.

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
  "keys_hash": "…"                         // the team-key list it holds, if it takes it
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
Keep the last good copy through a network outage; drop the list when MegaNet
refuses the token. Restrict the keys yourself (`from="10.0.0.0/8,…"` in
`authorized_keys`) — the list carries none, since only the station knows what
"local" means where it is.

A `404` from either function is a MegaNet without `0049`: check in again an hour
later. A `401` (`PT401`) is a token MegaNet does not accept: back off, and keep
sending nothing else on it.

## Security, in one place

- Nothing listens on a base station for MegaNet, and nothing MegaNet sends is
  run as a command: requests are one of a fixed list, checked twice.
- The ingest token authenticates the station to MegaNet, as for its readings;
  TLS authenticates MegaNet to the station. Only an administrator can ask
  (`meganet.admin_require()`, first thing in every function the tab calls), and
  every request records who asked.
- Someone who got into MegaNet as an administrator could do what administrators
  can: the requests above, of stations set to `manage`. They could not read a
  station's token or passwords, redirect its readings, set its web page's
  password, add a key to it, turn its management back on, or run a command; and
  team keys work only from a private network unless the station says otherwise.
  `report` or `off`, on the station, takes even that away.
- What the tables hold is reachable only through the functions above: row level
  security on, no policy, no grant.
