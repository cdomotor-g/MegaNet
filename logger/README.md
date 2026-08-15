# logger/ — the base station's side of HTTP ingest

A CRBasic program for a Campbell Scientific datalogger sitting at a radio base
station. It reads what the ALERT2 receiver hears off RS-232 and posts it to
MegaNet's ingest endpoint.

**This is the inbound path that needs no process running anywhere.**
[`bridge/`](../bridge/README.md) is the other one, and it exists because
Postgres cannot subscribe to MQTT so *something* has to hold the subscription.
Nothing has to hold this: the datalogger is already at the site, already
powered, already on a network, and `HTTPPost()` is an instruction it has had
since OS 4. If a base station can reach the internet, this program is the whole
integration.

```
field stations ──radio──▶ ERT-A2 receiver ──RS-232──▶ CR300 running this program
                                                                   │
                                                                 HTTPS
                                                                   ▼
                                                        meganet.ingest_http()
                                                                   │
                                                          meganet.ingest()
```

- The **endpoint, the payload shape, and how to mint and revoke a token** are in
  [`docs/ingest-http.md`](../docs/ingest-http.md) — read that first; this page
  assumes it.
- The **serial format** the program decodes is the ELPRO ERT-A2's ALERT2 ASCII
  protocol, documented field by field in `alert2.js` and in the README's
  [ALERT2 / ERT-A2 Serial Decoder](../README.md#19-alert2--ert-a2-serial-decoder)
  section. This program reads the same lines that tab reads.
- This page is for whoever is **loading it onto a logger**.

---

## The files

| File | What it is |
| --- | --- |
| `base-station-http.CR300` | The program. Written for a CR300-series; the foot of the file says what to change for a CR1000X or CR6. |
| `meganet_token.example.txt` | The shape of the token file. One line, the token, nothing else. |

---

## Three things to change, and only three

Everything else in the program has a working default.

**1 · `BASE_NAME`.** Near the top, under *SITE CONFIGURATION*:

```crbasic
Const BASE_NAME = "MT_STUART"
```

This lands in every reading's `path` column and is what the Message Log tab
shows as *which base heard it*. Name it for the ingest point — the place a
person standing there would recognise — not for a field station it relays. A
base hears forty of those, and "Durikai rainfall" will be wrong within a month.

**2 · The token file.** Mint one (`docs/ingest-http.md` § Getting a token):

```sql
select meganet.create_ingest_token('Mt Stuart base');
-- {"id": 3, "label": "Mt Stuart base", "token": "mgn_a1b2c3…"}
```

Put the `token` value on the first line of a plain text file and load it onto
the logger as `CPU:meganet_token.txt` — Device Configuration Utility → **File
Control** → *Send*, or LoggerNet's File Control. Nothing else goes in the file.

The token is deliberately **not** in the program, which is why this directory
can live in a public repository: the `.CR300` file carries no credential, so it
can be emailed, reviewed in a diff, and loaded onto a second base station
without anything being rotated. `docs/ingest-http.md` asks for exactly this —
*keep it in a config file the logger reads rather than typed into a script*.

If the file is missing the program still runs: it still hears the network, still
fills its `Readings` table, and says `no token — see TOKEN_FILE` in `PostState`.
Dropping the file in is enough — it retries the load every slow scan, so there
is no need to restart the program.

**3 · `PROTOCOL`, if your receiver is not an ERT-A2.**

```crbasic
Const PROTOCOL = "alert2"      '"alert" for legacy ALERT, "unknown" to not claim
```

---

## Before it can post: two settings outside the program

Both are one-time, both are in Device Configuration Utility, and **neither is
visible from inside CRBasic** — a program that is otherwise perfect will fail
every post until they are right.

**TLS has to be switched on.** Set **Max TLS Server Connections** to a non-zero
value (Deployment → Datalogger → TLS). The name says *server*, and the setting
gates outbound client connections too — this is counter-intuitive and it is the
usual reason a first `https://` post returns socket `0`. Each connection costs
roughly 20 KB of memory.

**The operating system has to be recent enough.** CR300 OS 7.0 replaced the old
axTLS library with mbedTLS, which is what lets the logger negotiate with a
modern server. Earlier than that and TLS may simply never complete. `HTTPPost()`
itself is not supported at all on OS 3 or earlier.

If a post still fails after both, turn on **IP Trace Code** in the Settings
Editor tab — `IPTrace()` writes nothing until that setting is enabled, and TLS
negotiation failures are exactly what it is for.

---

## Loading it

The receiver occupies the RS-232 port, so **talk to the logger over USB**, not
over RS-232 — plugging DevConfig into RS-232 means unplugging the receiver.

1. Open `base-station-http.CR300` in CRBasic Editor and **Compile**. Fix
   anything it flags before going to site — see *Compiling it* below.
2. Send the program with Device Configuration Utility (**File Control**), or
   LoggerNet's Connect screen.
3. Send `meganet_token.txt` the same way.
4. Set the clock **to UTC**. The program keeps it there itself — it syncs against
   `NTP_SERVER` every six hours with an NTP offset of 0, which is what UTC means
   — but it needs to start close enough to be believed, and it will not stamp
   anything at all until the year is at least `MIN_YEAR`. The program stamps
   readings `…Z` and means it: a logger left on local time posts readings with
   the right digits and the wrong instant, which nothing downstream can detect
   or undo. Blank `NTP_SERVER` if this logger cannot reach an NTP server, and
   set the clock from LoggerNet instead.
5. Watch the Public table.

---

## Proving it works, without waiting for a transmission

The program accepts a second, deliberately trivial line format so that the whole
path can be tested by hand:

```
6270,21
```

Address and value, comma or space separated, terminated with Enter. Unplug the
receiver, put a terminal on the RS-232 port at 9600-8-N-1, and type it.

Then read the Public table, in this order:

| Watch | Should become |
| --- | --- |
| `RxLines` | `1` — the line arrived |
| `RxLastLine` | `6270,21` — verbatim, so you can see what the port actually received |
| `RxReadings` | `1` — it parsed |
| `QDepth` | `1` — it is queued |
| `PostState` | `posting`, then `accepted` |
| `Accepted` | `1` |
| `QDepth` | back to `0` |

Then find it in MegaNet: the **Message Log** tab, filtered to your `path`. A
reading that got as far as `Accepted` is in the database.

Type the same line again and `Duplicates` goes to `1` while `Accepted` stays at
`1` — that is the endpoint's idempotency, and it is what makes the retry
behaviour below safe rather than merely optimistic.

---

## Reading the diagnostics

Everything the program knows is a `Public` variable, readable in LoggerNet,
PC400 or Device Configuration Utility without collecting a table. They are
declared in the order you actually read them when something is wrong.

### Is the logger alive

| Variable | Means |
| --- | --- |
| `Batt_volt`, `PTemp` | Supply volts and panel temperature. |
| `ClockOK` | `false` = the clock failed its sanity check and **nothing is being stamped or queued**. Check the RTC's backup battery. |
| `NowISO` | The clock, formatted exactly as it is posted. If this looks wrong, everything downstream is wrong. |
| `NTPErrMs` | How far out the clock was when NTP last corrected it, in milliseconds. Growing steadily between syncs is drift; a big jump is an RTC going. |
| `NTPLastOK`, `SecsSinceNTP` | Whether the last sync worked, and how long ago. |
| `WatchdogErrs` | Non-zero means the logger has been resetting itself. |
| `SkippedScans` | The 1-second scan overrunning. A few at startup is normal; a rising count is not. |
| `VarOutOfBound` | An array index that went past its dimension. Worth watching here specifically: CRBasic does not bounds-check a variable index, and this program indexes arrays from data that arrived over a serial cable. |

Free memory is deliberately absent: `Status.MemoryFree` is a CR1000X/CR6 field
and is not on the CR300's own Status table, so reading it would not compile.
Device Configuration Utility's Status tab shows it.

### Is the receiver talking

| Variable | Means |
| --- | --- |
| `SecsSinceRx` | Seconds since the last serial line. **The single most useful number here** — a base station that has gone deaf shows up here and nowhere else, because a deaf base station is not an error, it is a silence. |
| `RxLines` | Lines read off the port since startup. |
| `RxFrames` / `RxReadings` | Frames decoded, and readings extracted from them. One ALERT2 frame can carry several readings. |
| `RxBadFrames` | Frames that would not decode. `RxLastBad` and `RxLastWhy` are the last one and the reason. |
| `RxBadRecords` | Records inside otherwise-good frames whose status byte was non-zero. In the reference capture those also carried addresses matching no station, so they are counted and dropped. |
| `RxLastLine` | The last line verbatim. Worth more than any counter when the format is not what you expected. |
| `RxFrameSkew` | Seconds between the frame's own ALERT2 time and this logger's clock — see *Which clock stamps the reading*, below. |

### Is the queue draining

| Variable | Means |
| --- | --- |
| `QDepth` | Readings waiting to post. Sawtooth is healthy; a rising line is not. |
| `QPeak` | The deepest it has been. Sets how much outage the current `Q_SIZE` actually buys. |
| `QDropped` | Readings lost because the queue filled. **Non-zero means the link has been down longer than the buffer holds** — raise `Q_SIZE` or fix the link. |

### Did the last POST work

| Variable | Means |
| --- | --- |
| `PostState` | Plain English. `idle - nothing to send`, `posting`, `accepted`, `refused - token`, `no answer - check link and TLS`, `clock not set`, `no token`. |
| `TokenOK`, `TokenLen` | Whether the token file loaded, and how many characters it held. The length is there so a truncated paste is visible without the token itself ever being on screen. |
| `LastStatus` | The HTTP status code, parsed out of the response headers. `200` good, `401` token, `400` malformed body. |
| `LastSocket` | `HTTPPost()`'s own return: ≥100 is the TCP socket it used, `0` means the request never got out, `-2` means the instruction did not execute. |
| `Accepted` / `Duplicates` / `Rejected` | Cumulative, from the endpoint's own answer rather than from anything this program assumes. |
| `LastAccepted` / `LastDuplicates` / `LastRejected` | The same three for the last POST alone. |
| `LastReject` | The first `why` out of the last rejected array. `docs/ingest-http.md` § Errors tabulates what each one usually means. |
| `HTTPResponse` | The response body, verbatim. |
| `SentHeader` | The request headers as built, **with the token replaced by its length** — kept separately because `HTTPPost()` overwrites the header variable it is given, and redacted because a Public variable is readable by anyone who can reach the logger. |
| `RespHeader` | What came back in its place: the status line and the server's response headers. |
| `SecsSincePost` | Seconds since the last **accepted** post, not since the last attempt. |
| `ConsecFail` / `Backoff` | Consecutive failures, and how long until the next try. |

Three tables are logged as well: `Readings` (every reading, whether or not it
ever posted), `Diag` (a five-minute heartbeat) and `PostLog` (one record per
POST attempt — which is what answers *when did it stop working*, a question the
five-minute averages in `Diag` erase).

---

## What it does when things break

**The link goes down.** Readings queue. The POST retries with a backoff that
doubles from 30 seconds to 15 minutes, so a base station does not spend an
outage hammering a dead endpoint. Nothing leaves the queue until the endpoint
says it stored it.

**A POST times out after the request was sent.** The same batch is sent again
and the endpoint stores it once — `docs/ingest-http.md` guarantees that same
address + same `reading_ts` + same `value_raw` deduplicates. You will see
`Duplicates` climb, which is the system working, not a fault. **Do not build an
acknowledgement protocol on top of this.**

**The queue fills.** The oldest reading is dropped and `QDropped` counts it. For
flood warning the current river level matters more than the one before it, so
the newest reading always gets a slot.

**The RTC loses power.** `ClockOK` goes false and the program stops queueing
rather than posting a thousand readings stamped 1970 — which the endpoint would
reject anyway, and which would make a battery fault look like a network fault.

**The token is revoked.** `LastStatus` 401 and `PostState` = `refused — token`.
Readings keep queueing and keep landing in the `Readings` table, so loading a
new token file recovers everything still in the buffer.

**A single reading is bad.** It comes back in `rejected` and the rest of the
batch is still stored. `LastReject` says why.

---

## Which clock stamps the reading

The base station's own, and this is a decision rather than a default.

There are three clocks in play: this logger's, the ERT-A2's real-time clock
(fields 7–12 of every ASCII line), and the ALERT2 frame time carried in the
payload as seconds since midnight. The receiver's RTC is demonstrably not
reliable — the 444-frame reference capture behind `alert2.js` has it twelve
hours out, an AM/PM error on the unit. The frame time comes from the
transmitting network and is the better of the two, but **nothing in the frame or
in ELPRO's documentation says which zone it counts from**, and a base station
that guessed wrong would silently shift every reading it ever posted by a whole
number of hours.

So the reading is stamped with this logger's NTP-disciplined UTC clock at the
moment the line arrives — receive latency at a base station is seconds — and the
disagreement is reported rather than resolved. `RxFrameSkew` is the frame time
minus this logger's time of day:

- **near zero** — the two clocks agree, and the frame time is UTC.
- **a whole number of hours** — that is the answer to the question above, and
  worth telling MegaNet about: it would let a future version use the frame time,
  which is the more accurate of the two.
- **drifting** — the receiver, or this logger, is losing time.

---

## Compiling it

There is no CRBasic compiler in this repository and none in CI, so **this
program has not been compiled** — CRBasic Editor is Windows-only and Campbell's,
and a datalogger program cannot be checked by anything else. Compile it before
it goes to site. It is written to make that first compile as boring as possible:

- every subroutine is declared before `BeginProg` and before anything calls it,
- the ALERT2 decode is built from `ASCII()`, `Mid()` and `Len()` rather than a
  hex-conversion helper, so it does not depend on which OS added what,
- the line splitter and the substring search are written out by hand instead of
  calling `SplitStr()` and `InStr()`. Both of those take an option code, and a
  wrong option code does not fail to compile — it silently parses the wrong
  thing, which for a program whose whole job is parsing is the worst failure
  mode available,
- only Status fields that are on the **CR300's own** Status table are read
  (`WatchdogErrors`, `SkippedScan`, `VarOutofBound`),
- and every number that goes into the JSON goes through `Sprintf` with `%d`,
  because implicit numeric-to-string conversion is free to pad, round, or reach
  for scientific notation, and any of the three inside a JSON literal is a
  rejected batch.

Three things are the most likely to need a local edit, and each carries a
comment saying exactly what to change:

| If the compiler objects to | Do this |
| --- | --- |
| the empty commas in `HTTPPost(...,,,,,POST_TIMEOUT)` | Delete `,,,,POST_TIMEOUT` and accept the 75-second default. `TimeOut` is the ninth parameter and the commas are placeholders for the four table-streaming ones. |
| `NetworkTimeProtocol` | Delete the whole clock-discipline `SlowSequence` and set the clock from LoggerNet. Nothing else depends on it. |
| a `Status.` field name | Delete that line and its `Sample()` in the `Diag` table. |

**What has been checked, since the compiler has not.** The ALERT2 decode was run
against the reference line in
[README §19](../README.md#19-alert2--ert-a2-serial-decoder) and returns
`alert_id 6270, value 21` — the same answer `alert2.js` gives — along with the
12 h 00 m 01 s receiver-clock skew that capture is known for. Every rejection
path was exercised (wrapped line, invalid-frame flag, payload-length
disagreement, non-hex byte, wrong element type, non-zero record status), the
generated JSON was parsed and checked against the `ingest_http()` contract, and
the batch sizing was checked to keep the worst-case body inside the buffer with
a full record's headroom to spare. That is the algorithm, not the CRBasic.

---

## What it deliberately does not do

**It does not convert counts to millimetres.** `value_raw` is the 11-bit number
that came off the air. A base station hearing forty sites does not know which is
a rain gauge and which is a level sensor, and a wrong bucket size is worse than
no bucket size — MegaNet does the conversion where it knows the sensor.

**It does not decode HFEM.** An HFEM line (`:HS=1|I1=…|NN:`) is a different
format from a different kind of station, and [`hfem.js`](../hfem.js) is the
decoder for it — one decoder, so there is never a second opinion about what `T3`
means. A base station relaying HFEM should publish to the MQTT bridge instead.

**It does not stream a DataTable through `HTTPPost()`'s optional parameters.**
Those produce TOB1, TOA5, CSIXML or CSIJSON, and `ingest_http()` accepts none of
them — it wants one JSON object with a `payload` key.

**It does not enforce which addresses this base may post for.** Neither does the
endpoint: `alert_low`/`alert_high` on the token record are a note, not a rule
(`db/migrations/0007_ingest_http.sql`, decision 3).
