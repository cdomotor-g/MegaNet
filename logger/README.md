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
| `RxBlockBytes` | `9` — bytes came off the port |
| `RxBlockHex` | `36 32 37 30 2C 32 31 0D 0A ` — those bytes, exactly |
| `RxLines` | `1` — a complete line was cut out of them |
| `RxLastSep` | `comma=1 space=0 tab=0 …` — what it was split on |
| `RxLastLine` | `6270,21` — verbatim, so you can see what the port actually received |
| `RxLastShape` | `plain` |
| `RxLastId` / `RxLastValue` | `6270` / `21` |
| `RxLastJson` | `{"alert_id":6270,…}` — what will be posted |
| `RxStep` | `7 queued` |
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

### Is the receiver talking — the serial pipeline, step by step

This is the part to read first when a feed is not doing what you expect. The
program shows the **same data in every form it passes through**, from bytes in
the port buffer to the JSON that will be posted. Read down the list: the step
where the display stops being what you expected is the step that is broken.

| Step | Variable | Means |
| --- | --- | --- |
| **1 · the port** | `SecsSinceRx` | Seconds since the last *byte*. **The single most useful number here** — a base station that has gone deaf shows up here and nowhere else, because a deaf base station is not an error, it is a silence. |
| | `RxAvail` | Bytes sitting in the port buffer, read *before* this scan took them. Should sit near zero. Parked near `RX_BUFFER` means the scan is not keeping up. |
| | `RxBlockBytes` / `RxBytesTotal` | Bytes taken this scan, and since startup. **`RxBytesTotal` climbing while `RxLines` stays at 0 is the signature of a feed that sends no line terminator** — check `RxAccumLen`. |
| | `RxNulls` | NUL bytes seen and skipped. Non-zero on an ASCII feed means line noise or a baud mismatch, and is the first thing to suspect when `RxBadFrames` climbs for no obvious reason. |
| **2 · the block** | `RxBlockHex` | Every byte of this scan's read as padded hex — `41 4C 45 52 54 32 41 2C …`. This is the raw truth and it is the display to trust. |
| | `RxBlockText` | The same bytes as text, with every control character shown as `-`, so nothing in the data can scramble the display. |
| **3 · line assembly** | `RxAccumLen` / `RxAccumText` | What is being held while it waits for a CR or LF, and how much. Normal is near zero between transmissions and briefly non-zero when one straddles two scans. **A number that grows and never comes back is a feed with no line terminator.** |
| | `RxLines` | Complete lines cut out since startup. |
| | `RxOverruns` | Times the assembly buffer filled with no terminator anywhere in it and had to be discarded. |
| **4 · the line** | `RxLastLine` / `RxLastLineHex` / `RxLastLineLen` | The last complete line verbatim, the same line in hex, and its length. Worth more than any counter when the format is not what you expected. |
| | `RxLastSep` | **What separator characters the line actually contained, counted**, ending with `top=<byte> x<count>` — the most common non-alphanumeric byte in the line, whatever it is. The first thing to read when a feed will not parse. |
| | `RxLastHead` / `RxLastTail` | The first 40 and last 16 characters, printable-safe. The tail is where checksums and record terminators live. |
| | `RxLastDelim` | Which separator the splitter chose: `comma`, `semicolon`, `tab`, `pipe`, `space` or `none`. |
| | `RxLastShape` | What it was taken to be: `ALERT2A`, `plain`, or `unrecognised`. |
| | `RxLastFields` | Fields the splitter found. An `ALERT2A` line with a 7-byte payload has 31. |
| | `RxLastPrefix` | Bytes discarded from the front of the line to reach `ALERT2A`. Non-zero means the receiver prefixes its output with something. |
| **5 · the payload** | `RxLastPayLen` / `RxLastPayHex` | The payload length from field 23, and the payload bytes after the hex fields were converted back to numbers. **If `RxLastPayHex` does not match the tail of `RxLastLineHex`, the hex decode is what is wrong** — nothing further along needs looking at. |
| **6 · the reading** | `RxLastRecHex` | The four payload bytes this reading came out of, so the bit-unpacking can be checked by hand against the table in the program at `ParseAlert2`. |
| | `RxLastId` / `RxLastValue` / `RxLastSuspect` | The ALERT id and 11-bit value decoded from them, and whether the value was full scale. |
| | `RxLastStamp` | The timestamp actually attached to it. |
| **7 · the JSON** | `RxLastJson` | That reading as it will appear in the batch, byte for byte. Built by the same code that builds the POST body, so it cannot drift from what is sent. |

### When every line comes back `unrecognised`

**Read `RxLastSep` first.** `unrecognised line` has exactly one meaning — the
splitter found fewer than two fields — and that variable says why:

```
comma=0 space=0 tab=30 semi=0 colon=0 pipe=0 eq=0 hi=0 ctl=0
```

| What you see | What it means |
| --- | --- |
| One count is high (`tab=30`, `semi=30`) | The feed uses a separator the parser can now find on its own — `RxLastDelim` should already say `tab` or `semicolon` and the line should parse. If it still doesn't, the field *layout* differs, not just the separator. |
| Named counts near zero but **`top=` shows a high count** | The feed is delimited by something the named list does not test for — a slash, a dash, an asterisk. `top=45 x7` is byte 45, `-`, seven times. The named counters test a list guessed in advance; `top=` tests nothing and reports what is there, which is why it is the one to read when the others all say zero. |
| **Every count zero including `top=`**, `RxLastLineLen` large | The line is one unbroken alphanumeric token. Not a delimiter problem — a different output mode on the receiver. Send the capture. |
| `hi` non-zero | Bytes above 126. **This is not ASCII**, so no parser setting will help: either the receiver is in a binary output mode, or the baud rate is wrong. Check `RxByteClass()` — a real baud mismatch scatters bytes across every class roughly evenly. |
| `ctl` non-zero | Control characters inside the line, which usually means the terminator is not what the line assembler thinks it is. |
| `eq` and `pipe` non-zero | That is HFEM framing (`:HS=1|I1=…|NN:`), not ALERT2 — a different protocol from a different kind of station. This program does not decode it; see *What it deliberately does not do*. |

Then `RxByteClass()` over a few minutes, which is the whole feed rather than one
line: `printable` + `CR` + `LF` and nothing else is ASCII. Anything landing in
`high >126` or `ctrl-other` is not, and no amount of parser work will make it so.

`RxWhyCount()` says whether every line fails the same way (one consistent shape
this program does not know) or fails differently each time (corruption rather
than misunderstanding). `RxFirstLine` keeps the very first line seen, which is
often a banner naming the receiver's mode and is gone from the last-line display
within a second.

### Taking a capture to send

`CPU:rxcapture.txt` is every byte the port delivered, one text line per read,
before any parsing:

```
# MegaNet base-station serial capture -- baud 9600 format 3
# started 2026-08-17T04:15:00Z (logger clock, UTC)
# one record per read: hh:mm:ss n=<bytes> <hex>
04:15:07 n=31 41 4C 45 52 54 32 41 2C 31 2C 39 39 39 39 2C ...
```

It starts itself on every program start, so a logger that was power-cycled comes
back capturing. To take one:

1. `CaptureReset` → **true** in the Public table. It erases the file, writes a
   fresh header, and clears itself back to false.
2. Leave it running. `CaptureState` says `capturing`; `CaptureBytes` climbs.
   It stops on its own at `CAPTURE_MAX` (200 KB, about nine hours of a busy
   40-station base) and says `full — retrieve …`. Set `CaptureNow` **false** to
   stop it earlier; the file is kept either way.
3. Device Configuration Utility → **File Control** → select `rxcapture.txt` →
   **Retrieve**. Same route the token file goes out on.
4. Send that file. It is plain text and carries no credential.

Writes are batched — bytes accumulate in RAM and go to flash when the buffer is
nearly full or every 60 seconds — because flash on a CR300 is not infinite and a
capture left running for a week at one write a second is a real cost. A power
cut loses at most the last minute.

### The `LineLog` table

The same evidence in a form you can collect with LoggerNet or PC400 instead of
pulling a file — one record per complete line, 2,000 of them:

| Column | Means |
| --- | --- |
| `RxLastLineLen` | Line length after the terminator is stripped |
| `RxLastFields` | Fields the splitter found |
| `RxLastDelimCode` | 0 none · 1 comma · 2 semicolon · 3 tab · 4 pipe · 5 space |
| `RxLastShapeCode` | 1 ALERT2A · 2 plain · 3 unrecognised |
| `whyCode` | 0 accepted, otherwise the `RxWhyName()` index |
| `RxLastPrefix` | Bytes skipped to reach `ALERT2A` |
| `RxSepComma` `RxSepSpace` `RxSepColon` `RxSepEq` `RxSepHi` `RxSepCtl` | The census, per line |
| `RxTopSepDec` / `RxTopSepN` | The most common non-alphanumeric byte and its count |
| `RxLastHead` / `RxLastTail` | The first 40 and last 16 characters |

**The first version of this table carried numbers only** — cheap enough to leave
running for hours, and it established that a feed had a consistent shape without
ever saying what the shape *was*. The two text samples cost about 56 bytes a
record and settle it. If memory is tight, lower the 2,000 rather than dropping
them.

And the counters that say how it went:

| Variable | Means |
| --- | --- |
| `RxStep` | The last step the pipeline completed, in words — `3 appended to line buffer`, `5 payload decoded`, `7 queued`, `rejected: …`. **Where this stops is where to look.** |
| `RxFrames` / `RxReadings` | Frames decoded, and readings extracted from them. One ALERT2 frame can carry several readings. |
| `RxBadFrames` | Lines that would not decode. `RxLastBad`, `RxLastBadHex` and `RxLastWhy` are the last one, the same line in hex, and the reason. The hex copy matters: a line that will not parse is often a line whose text is not readable. |
| `RxWhyCount()` / `RxWhyName()` | Every rejection since startup, by reason, self-labelled. All on one counter = one consistent shape this program does not know. Spread across several = corruption. |
| `RxByteClass()` / `RxByteClassName()` | Every byte received, in eight classes — NUL, ctrl-other, CR, LF, TAB, space, printable, high >126. **The fastest read on the table for "is this ASCII at all".** |
| `RxLenMin` / `RxLenMax` | Shortest and longest complete line seen. Equal means fixed-length records. |
| `RxTermCR` / `RxTermLF` | Which terminator the feed uses. |
| `RxFirstLine` / `RxFirstLineHex` | The first line ever seen, kept and never overwritten — startup banners appear once and are gone a second later. |
| `RxBadRecords` | Records inside otherwise-good frames whose status byte was non-zero. In the reference capture those also carried addresses matching no station, so they are counted and dropped. |
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

Two tables are logged as well: `Readings` (every reading, whether or not it ever
posted) and `Diag` (a five-minute heartbeat). `Diag` carries the POST result —
`LastStatus` and `PostState` — alongside the counters, so *when did it stop
working* is answered from one table rather than by lining two up against each
other.

---

## How the serial port is read

Worth knowing before you debug a feed, because the first version of this program
got it wrong and read nothing at all.

That version called `SerialInRecord()` once per scan in a drain loop. Its last
parameter is **`RecordsBackFromNewest`** — how many records back from the most
recent one to hand over — and it was being passed `1`, which asks for the record
*before* the newest and returns nothing when only one has arrived. It is also
the wrong shape for draining a buffer: one call is meant to yield one record,
so looping on it does not empty a port that filled between scans.

This version reads the port the way the **KDO doppler driver** on our other
loggers reads its sensor — the pattern that is known to work on this hardware:

| | |
| --- | --- |
| 1 | `SerialInChk()` — how many bytes are sitting in the port buffer |
| 2 | `SerialInBlock()` — take all of them, raw; it returns the byte count |
| 3 | walk the block byte by byte with `ASCII()`, building a padded hex dump and a printable copy with control characters as `-` |
| 4 | append to an assembly buffer and cut complete lines out of it on CR or LF |

Three consequences worth knowing at the bench:

- **Every step is a `Public` variable**, which is the table above. Nothing about
  the read depends on an option code whose meaning has to be looked up.
- **A transmission that straddles two scans is one line, not two broken ones.**
  Step 4 is why: the leftover stays in the buffer until its terminator arrives.
  `RxAccumLen` is that leftover, and watching it go non-zero and back to zero is
  watching the reassembly work.
- **The separator is found, not assumed.** The splitter counts commas,
  semicolons, tabs, pipes and spaces in the line and uses whichever is most
  common, reporting the choice in `RxLastDelim` and the counts in `RxLastSep`.
  A feed that is tab- or semicolon-separated therefore parses without an edit.
  When none of them appears the line is **not split at all** — an earlier draft
  split on a character assumed not to occur, and a binary feed containing that
  byte then produced a plausible reading for a station that never sent one.
- **`ALERT2A` is found anywhere in the line, not only at the front**, so a
  receiver that prefixes its output stays readable; `RxLastPrefix` counts the
  bytes stepped over rather than hiding them.
- **A `plain` line must be two actual numbers.** CRBasic reads an unconvertible
  string as `0`, so without that check an HFEM line or a banner becomes alert id
  0 silently. It is rejection 12 instead.
- **The port is never flushed.** The KDO driver flushes because it owns a
  request/response conversation and anything left over is stale by definition.
  This program is a listener on a feed it does not drive, so a flush would throw
  away the bytes that arrived while the scan was working. The only `SerialFlush`
  is the one in `BeginProg`, which clears whatever accumulated before the
  program started.

The byte count from `SerialInBlock()` — not `Len()` — bounds every loop, and the
block is copied with `MoveBytes()` rather than assigned. Both for the same
reason: the port is open in **transparent mode** (format 3), where a NUL is an
ordinary byte, and a CRBasic string ends at the first one. A plain assignment
would truncate exactly the block you most need to see, and `RxNulls` would never
count the byte that caused it.

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
- bit fields are pulled out with `MOD` and `INT()` rather than with shift
  operators — CRBasic has no `<<` or `>>`, and the arithmetic form is exact on
  integers this small,
- the serial instructions are the four the KDO driver already runs on our own
  loggers (`SerialOpen`, `SerialInChk`, `SerialInBlock`, `MoveBytes`), passed
  the same parameters in the same order,
- `HTTPPost()` is called with its four required parameters and nothing else, so
  there are no empty placeholder commas to argue with,
- and every number that goes into the JSON goes through `Sprintf` with `%d`,
  because implicit numeric-to-string conversion is free to pad, round, or reach
  for scientific notation, and any of the three inside a JSON literal is a
  rejected batch.

Two things are the most likely to need a local edit, and each carries a comment
saying exactly what to change:

| If the compiler objects to | Do this |
| --- | --- |
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
a full record's headroom to spare.

The serial rewrite was checked the same way and against the cases that motivated
it: **a line delivered in two blocks reassembles into one line** (nothing is
dropped and nothing is doubled), several frames plus a plain line arriving in a
single block yield three lines and three readings, NUL bytes are counted and
skipped rather than truncating the line around them, and a feed that sends no
terminator at all is discarded and counted at `RxOverruns` instead of wedging
the buffer — with the assembly buffer never exceeding `RX_ACCUM` in any of them.
That is the algorithm, not the CRBasic.

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
