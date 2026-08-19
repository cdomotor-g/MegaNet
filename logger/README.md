# logger/ — the base station's side of ingest, over both paths

A CRBasic program for a Campbell Scientific datalogger sitting at a radio base
station. It reads what the ALERT2 receiver hears off RS-232 and sends it to
MegaNet **twice**: a POST to the ingest endpoint, and a publish to the MQTT
broker that [`bridge/`](../bridge/README.md) subscribes to.

```
field stations ──radio──▶ ERT-A2 receiver ──RS-232──▶ CR300 running this program
                                                                   │
                                            ┌──────────────────────┴───────────┐
                                          HTTPS                          MQTT QoS 1
                                            │                                  │
                                            ▼                                  ▼
                                   meganet.ingest_http()                     broker
                                            │                                  │
                                            │                               bridge/
                                            │                                  │
                                            └──────────────────────┬───────────┘
                                                                   ▼
                                                          meganet.ingest()
```

**Sending everything twice is the design, not a mistake.** `meganet.reading`'s
primary key is (address, instant, value), so the second copy of a reading is
stored zero times and counted as a duplicate — both contracts say so in as many
words. Whichever copy lands first sets the row's `source` (`http` or `mqtt`);
the other is counted and discarded. So the cost of a path being down is its own
duplicates and nothing else, and there is no acknowledgement protocol between
the two halves to get wrong.

What each path is *for* is different, and that is why a base station runs both:

| | HTTP | MQTT |
| --- | --- | --- |
| Needs a process running somewhere | no | yes — a broker, and `bridge/` |
| Needs a credential on the logger | the token file | broker username/password, in the settings |
| Tells you the station stopped talking | no | **yes — the broker's Last Will, for free** |
| Survives the database being down | retries from the queue | the broker holds the message |
| Overhead per reading | an HTTPS request | a publish on a held connection |

The last-but-one row is the reason MQTT is worth its moving parts. *Which sites
stopped talking overnight* is the morning question, and HTTP has no way to
answer it: a base station that has died posts nothing, and so does a base
station with nothing to report. The broker knows the difference because it
holds the connection, and it says so on this station's behalf when the
connection drops.

- The **endpoint, the payload shape, and how to mint and revoke a token** are in
  [`docs/ingest-http.md`](../docs/ingest-http.md) — read that first; this page
  assumes it.
- The **topic scheme, the status message and the broker** are in
  [`docs/ingest-mqtt.md`](../docs/ingest-mqtt.md), and the click-by-click
  provisioning is [`docs/mqtt-provisioning.md`](../docs/mqtt-provisioning.md).
- The **serial format** the program decodes is the ELPRO ERT-A2's ALERT2 ASCII
  protocol, documented field by field in `alert2.js` and in the README's
  [ALERT2 / ERT-A2 Serial Decoder](../README.md#19-alert2--ert-a2-serial-decoder)
  section. This program reads the same lines that tab reads.
- This page is for whoever is **loading it onto a logger**.

---

## The files

| File | What it is |
| --- | --- |
| `base-station-http.CR300` | The program — both paths, despite the name, which is kept because it is the name loaded on every logger already running it. Written for a CR300-series; the foot of the file says what to change for a CR1000X or CR6. |
| `meganet_token.example.txt` | The shape of the token file. One line, the token, nothing else. |

---

## Four things to change, and only four

Everything else in the program has a working default.

**1 · `BASE_NAME`.** At the top of the diagnostics block:

```crbasic
Public BASE_NAME As String * 20 = "18 Bateson"
```

This lands in every reading's `path` column and is what the Message Log tab
shows as *which base heard it*. Name it for the ingest point — the place a
person standing there would recognise — not for a field station it relays. A
base hears forty of those, and "Durikai rainfall" will be wrong within a month.

It is `Public`, so it can be corrected at the logger without a recompile, and
the batch envelope is rebuilt on every POST so a change takes effect on the next
one rather than at the next restart. **The value in the file is the default at
every program start, not a saved setting** — the permanent home for a site's
name is still that line. Quotes and backslashes typed into the field are
replaced with `_` on the way into the JSON, so a stray keystroke cannot turn
every batch into a `400`.

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

**3 · `MQTT_STATION` — who this base station is on the wire.**

```crbasic
Const MQTT_STATION = "18_bateson"
Const MQTT_DEVICE  = "logger"
```

This is the `<station>` segment of the topic, and it is the **bureau station
number** — `541155`, exactly as `meganet.station.station_number` holds it, not
`0541155`. Sites that have no bureau number publish under their **station id**
instead. That is one rule rather than two identifiers: a site has a number or it
has not, and the database resolves either without a mapping table.

A base station never has a bureau number — it is an ingest point, not a gauging
station — so it is always the id here. `18 Bateson` is `18_bateson` in
`stations.json`, which is what the shipped default says.

**Change this and the broker's ACL together.** The ACL is generated from that
same column, so a credential may only write the topic its own identifier spells,
and a mistyped segment is refused by the broker rather than quietly filed under
an identity nobody claims. That is the scheme working, but only if the two
agree — check `MqttTopic` in the Public table against the ACL line before you
leave site.

Set `MQTT_ENABLE = False` on a base station with no broker credential; the HTTP
half is unaffected. It does **not** help on a logger whose operating system
predates `MQTTPublish()` — see *Compiling it*.

**4 · `PROTOCOL`, if your receiver is not an ERT-A2.**

```crbasic
Const PROTOCOL = "alert2"      '"alert" for legacy ALERT, "unknown" to not claim
```

---

## Before it can post: two HTTP settings outside the program

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

## Before it can publish: the MQTT settings

**The broker connection is not in the program.** There is no CRBasic instruction
that opens it: the operating system holds the session, and everything about it —
address, port, TLS, credentials, session type, and the Last Will — is a block of
settings in Device Configuration Utility → **Settings Editor** → *MQTT*. The
program only chooses topics and decides when to publish.

That split is worth knowing before you debug anything: a wrong topic is the
program's fault and visible in `MqttTopic`, and **everything else is a setting**.
`MqttState` saying `broker refused or unreachable` with a plausible `MqttTopic`
is almost always this page, not the program.

Get the credentials from [`docs/mqtt-provisioning.md`](../docs/mqtt-provisioning.md)
first — it walks through the broker signup, the two credentials and the ACL. A
station's credential is `station-<publisher>` with **Publish** permission on
`meganet/v1/<publisher>/#`; for this base station that is `station-18_bateson`
and `meganet/v1/18_bateson/#`.

**TLS first.** MQTT on 8883 is a TLS client connection, and the CR300 manual
lists `MQTTConnect()` and the publish instructions among the TLS client
applications (§7.1.6, printed p. 92). So **Max TLS Server Connections** has to be
non-zero — the same counter-intuitively named setting the HTTP section above
already asks for, and if you set it there you have already done this.

> **Where these setting names come from, since the manual does not have them.**
> `archive/cr300.pdf` is the CR300 product manual and it does **not** document
> the MQTT settings: §16.3 points at *"MQTT settings (p. 1)"*, which is a broken
> cross-reference to a section the PDF does not contain, and none of its 323
> pages mentions a broker, client id, clean session, base topic, or a will. The
> names below are Campbell's published MQTT settings documentation. **Expect the
> labels in your Device Configuration Utility to differ slightly by OS version;
> what each one is for is what matters.**

| Setting | What to put in it |
| --- | --- |
| **MQTT Enable** | On. Off by default. |
| **Broker / endpoint URL** | Your cluster host, e.g. `<something>.s1.eu.hivemq.cloud`. |
| **Port** | `8883` — MQTT over TLS. Not 8884, which is the WebSocket port a browser uses and a logger cannot. |
| **Client ID** | Unique across the whole network. `18_bateson-base` does. **Two clients sharing one id knock each other off the broker in a loop**, which on a cellular link is an expensive way to send nothing. |
| **Username / Password** | The station's credential, not the bridge's. The bridge's can read everything and must never be on a pole. |
| **Clean Session** | Off (a persistent session), so messages queued for this station survive a reconnect. |
| **Keep Alive** | The default is fine. It is how quickly the broker notices a dead connection, and therefore how quickly the Last Will fires. |
| **Base Topic** | **Unused — leave it.** `MQTTPublish()` takes a whole topic and does not inherit it. |
| **Automatic publishing / publish tables** | **Off.** It emits CSIJSON on the base topic, which is neither the scheme nor the payload the bridge accepts — every message it sends is one the bridge logs as unparseable and counts as rejected. |

### The Last Will, which is most of the point

Four more settings, and they are the ones worth checking twice, because
**getting them wrong costs nothing visible until the day the station dies** —
which is the day they exist for.

| Setting | What to put in it | Default |
| --- | --- | --- |
| **Last Will Topic** | `meganet/v1/18_bateson/status` — exactly what `MqttStatusTopic` shows in the Public table | empty |
| **Last Will Message** | `{"online": false}` | empty |
| **Last Will QoS** | `1` | `0` |
| **Last Will Retained** | **Retain** | *Do Not Retain* |

The broker publishes that message *on this station's behalf* when the connection
drops without a clean disconnect — the one event a station cannot report itself.
The program publishes the other half, `{"online": true, …}`, retained, at
startup, every fifteen minutes, and immediately after any failure.

**Both of the defaults are wrong for us, and quietly.** A will at QoS 0 can be
lost on the hop that matters; a will left *Do Not Retain* is discarded the moment
the bridge reconnects, so a bridge restart silently resurrects every dead
station. Retained is what makes the broker replay the picture to a bridge that
has just come back.

To prove it works, do the thing that feels wrong: **pull the power, or kill the
link, without stopping the program.** A clean shutdown sends a DISCONNECT and no
will. Then:

```sql
select station_key, online, since, round(minutes_since_seen) as quiet_for
  from meganet.station_health where station_key = '18_bateson';
```

`online` should go `false` within a keep-alive or two. This is the single thing
most worth testing before a station goes in the field, and the only one that
cannot be tested by watching it work.

---

## Loading it

The receiver occupies the RS-232 port, so **talk to the logger over USB**, not
over RS-232 — plugging DevConfig into RS-232 means unplugging the receiver.

1. Open `base-station-http.CR300` in CRBasic Editor and **Compile**. Fix
   anything it flags before going to site — see *Compiling it* below.
2. Send the program with Device Configuration Utility (**File Control**), or
   LoggerNet's Connect screen.
3. Send `meganet_token.txt` the same way.
4. **The clock must be UTC, and the program now insists on it.** It syncs
   against `NTP_SERVER` on its first pass and every six hours after, with an NTP
   offset of 0 — which is what UTC means — and **will not stamp a single reading
   until one sync has succeeded** (`REQUIRE_NTP`). `ClockState` says which of
   those it is doing.

   This is not caution for its own sake. A logger left on local time posts
   readings with the right digits and the wrong instant: they are accepted (the
   endpoint's ceiling is a day), they are stored, and they are **invisible in
   the Message Log**, because every window there ends at *now* and the readings
   are ten hours in the future. Nothing downstream can detect that and nothing
   can undo it. See *When readings arrive but the Message Log is empty* below.

   If this logger genuinely cannot reach an NTP server, blank `NTP_SERVER` or
   set `REQUIRE_NTP` to `False`, set the clock to UTC from LoggerNet, and accept
   that nothing is checking it.
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
| `QDepthHttp` / `QDepthMqtt` | `1` and `1` — both paths owe it |
| `PostState` | `posting`, then `accepted` |
| `Accepted` | `1` |
| `MqttState` | `publishing`, then `published` |
| `MqttPublished` | `1` |
| `QDepth` | back to `0` — **only once both have sent it** |

Then find it in MegaNet: the **Message Log** tab, filtered to your `path`. A
reading that got as far as `Accepted` is in the database.

Type the same line again and `Duplicates` goes to `1` while `Accepted` stays at
`1` — that is the endpoint's idempotency, and it is what makes both the retry
behaviour below and the whole dual-path arrangement safe rather than merely
optimistic.

**Which path won the race is visible, and either answer is correct:**

```sql
select addr, reading_ts, value_raw, source, received_at
  from meganet.reading order by received_at desc limit 5;
```

`source` is `http` or `mqtt` depending on which copy landed first; the other was
counted as a duplicate and discarded. If you only ever see one of the two over
many readings, the other path is not working — check `PostState` and `MqttState`
against each other, and the two queue depths, which is the fastest read on the
table for *which half is broken*.

The two depths are also how you test each path in isolation without touching the
program: pull the credential for one and watch its depth climb while the other
keeps sawtoothing.

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
| `ClockVerified` | NTP has succeeded at least once since startup. **Until this is true nothing is stamped or queued** — see `REQUIRE_NTP`. |
| `ClockState` | Plain English: `ok`, `waiting for the first NTP sync - not stamping yet`, `NTP sync failed - see NTP_SERVER`, or `clock is before 2020 - check the RTC battery`. |
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
| **3 · byte buffer** | `RxBufLen` / `RxBufHex` / `RxBufText` | What is waiting to be framed, and how much. Near zero between transmissions, briefly non-zero when a frame straddles two scans. |
| | `RxLines` / `RxNonText` | Text lines cut out, and runs discarded as not-text. |
| | `RxBufDrops` | Times the buffer filled with nothing framable in it. |
| **3b · the frame** | `RxFrameMode` | `binary` or `ascii`, decided per frame. |
| | `FrLenByte` / `FrTotal` / `FrLeftover` | Byte 7, the frame length it implies, and what was left over afterwards. **`FrLeftover` near zero confirms the `6 + byte 7` rule frame by frame.** |
| | `FrPre` | Bytes discarded in front of the signature — noise, or the tail of a frame that was missed. |
| | `FrHex` | The entire frame in hex. |
| | `FrElemVia` | How the readings element was found: `1` the `84 01 <len> 74` anchor, `2` a loose scan, **`0` not found at all** — the first thing to read when a frame yields nothing. |
| | `FrElemOff` / `FrElemLen` / `FrElemHex` | Where it starts within the frame, its length, and its bytes. |
| | `FrTimeSecs` / `FrRecords` / `FrGood` / `FrBad` | The frame's own clock, and how many records it carried, decoded and rejected. |
| **3c · one reading** | `RdIndex` `RdB0` `RdB1` `RdB2` `RdB3` `RdRecHex` `RdQueued` | The four bytes as numbers, so the unpacking can be recomputed by hand: `id = (B1 MOD 32) * 256 + B0`, `value = INT(B1 / 32) * 256 + B2`. |
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

### The capture tables

Four of them, and they are meant to be read together — every row in the later
ones is derived from bytes recorded in the first.

| Table | One record per | Holds |
| --- | --- | --- |
| **`RawLog`** | serial read that returned bytes | `RxBlockSeq`, bytes available, bytes read, buffer occupancy before and after, cumulative NULs, and **the whole block in hex, untruncated**. This is the ground truth; if a decode looks wrong, *what actually arrived* is answered here and nowhere else. |
| **`FrameLog`** | binary frame found, **including ones that did not decode** | Everything under *3b* above plus `whyCode`. A table holding only successes cannot answer the question these tables exist for. |
| **`ReadingLog`** | four-byte record, decoded or not | Everything under *3c*, plus the resulting `RxLastId` / `RxLastValue` and whether it was queued. |
| **`LineLog`** | complete text line | The text path's own forensics, below. |

`RxBlockSeq` and `RxFrameSeq` appear in more than one of them so rows can be
lined up across tables without relying on timestamps alone.

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

One ring buffer, two readers, and a slot is only reused once **both** have
passed it.

| Variable | Means |
| --- | --- |
| `QDepthHttp` | Readings waiting to POST. Sawtooth is healthy; a rising line is not. |
| `QDepthMqtt` | Readings waiting to publish. Same reading. |
| `QDepth` | The greater of the two — what the buffer is actually still holding, and therefore the only one of the three to read `QPeak` and `Q_SIZE` against. |
| `QPeak` | The deepest it has been. Sets how much outage the current `Q_SIZE` actually buys. |
| `QDropped` | Readings lost because the queue filled. **Non-zero means a link has been down longer than the buffer holds** — raise `Q_SIZE` or fix the link. |

**The pair diverging is the diagnostic.** `QDepthHttp` at 0 and `QDepthMqtt`
climbing says the broker is the problem and the readings are safe; the reverse
says the endpoint is. Neither can pin the other: the two positions are
independent, so a path that is down does not stop the other from draining, and
a reading dropped from a stalled path was already delivered by the healthy one
if the healthy one had reached it.

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

### Did the last PUBLISH work

The same questions asked of the other path, deliberately in the same order and
the same words so the two blocks can be read side by side.

| Variable | Means |
| --- | --- |
| `MqttState` | Plain English. `idle - nothing to send`, `publishing`, `published`, `broker refused or unreachable - code <n>`, `clock not set`, `disabled - see MQTT_ENABLE`. |
| `MqttTopic` | The reading topic this station publishes on, built from `MQTT_STATION` and `MQTT_DEVICE`. **Check this against the broker's ACL line at commissioning** — it is the whole of the topic check. |
| `MqttStatusTopic` | The status topic, which is also what the **Last Will Topic** setting has to be set to. |
| `MqttResult` | `MQTTPublish()`'s own return: `0` is success, anything else is its error code. Non-zero with a plausible `MqttTopic` is almost always the broker connection — the MQTT settings, not the program. |
| `MqttOK` / `MqttFail` / `MqttAttempts` | Messages accepted, refused, and tried. |
| `MqttPublished` | Readings handed to the broker, cumulative. **Not readings stored** — see below. |
| `MqttLastBatch` | How many were in the last published message. |
| `MqttLastPayload` | The first 200 characters of it, verbatim. |
| `SecsSinceMqtt` | Seconds since the last **successful** publish. |
| `SecsSinceTry` | Seconds since the last **attempt** of any kind. The two diverging is a broker being knocked on and not answering. |
| `MqttConsecFail` / `MqttBackoff` | Consecutive failures, and how long until the next try. Doubles from 30 s to 15 min. |
| `SecsSinceStatus` / `MqttStatusBody` / `MqttStatusResult` | The retained status message: how long since it went out, what it said, and how that went. |

**There is no accepted / duplicates / rejected row here, and that absence is the
honest one.** MQTT gives a publisher no response channel at all. The PUBACK
behind `MqttResult = 0` is from the *broker*, and means the broker has the
message — not that MegaNet has it. Anything more would be the program inventing
a confirmation nobody sent it.

Where the readings actually went is answerable, just not from the logger: the
bridge logs every message it acks, and it deliberately does not ack a storable
message until the database has stored it, so a bridge or database outage leaves
messages queued at the broker rather than losing them.
[`docs/ingest-mqtt.md`](../docs/ingest-mqtt.md) § *Proving it end to end* walks
through checking it from the database side.

Two tables are logged as well: `Readings` (every reading, whether or not it ever
left the logger) and `Diag` (a five-minute heartbeat). `Diag` carries **both**
paths' results — `LastStatus` and `PostState`, `MqttResult` and `MqttState` —
alongside the counters and both queue depths, so *when did it stop working, and
which half of it* is answered from one table rather than by lining two up
against each other.

---

## The receiver speaks binary, not ASCII

**This is the thing to understand before anything else on this page.** The
ERT-A2 at this base station does not emit the ALERT2 ASCII lines that
`alert2.js` documents. It emits a binary frame:

```
41 4C 45 52 54 32 | 56 | 9C 2C 02 00 01 75 ... 84 01 0B 74 5C 9E 87 09 8C 00 ...
|____ "ALERT2" ___|  ^                         |_ anchor _||___ element _____|
                     byte 7 is a LENGTH, not the "A" of ALERT2A
```

| Rule | Evidence |
| --- | --- |
| Total frame = `6 + byte 7` | `0x56` → 92 bytes, `0x52` → 88 bytes. Exact on every reference frame. |
| Byte 7 read as text is `V`, `R`, … | Which is why a terminal shows `ALERT2V` / `ALERT2R`, and why looking for the literal text `ALERT2A` never matched one. |
| The readings sit behind `84 01 <len> 74` | Same offset in every reference frame, and `(len-3) MOD 4 = 0` on all of them. |
| The records are unchanged | Same four-byte shape the ASCII path decodes — so the table at `ParseAlert2` still applies. |

Decoded, the reference frames give `alert_id 2439 = 140`, `2438 = 352` and
`4134 = 140`. Real readings that were there the whole time.

**Three things in the first version destroyed them**, and each was fatal on its
own:

1. **NUL bytes were stripped.** A CRBasic string ends at the first NUL, so the
   bytes were being filtered to fit one. These frames carry **nine to eleven
   NULs each**.
2. **Lines were cut on CR and LF.** `0x0D` occurs *inside* a frame as ordinary
   data — twice in the 88-byte reference frame — so one good frame became two
   fragments of nonsense.
3. **The text `ALERT2A` was the trigger.** Byte 7 is a length.

The symptom was a `LineLog` full of 75-character "lines" with exactly one comma
in them. That comma was byte 9 of the frame, `0x2C`, which is data.

**Both forms are now handled.** The signature test looks at the two bytes after
`ALERT2`: a letter `A` followed by a comma is the ASCII form and goes to the
text parser; anything else is a length byte and goes to the binary decoder.

---

## How the serial port is read

Bytes go into a **numeric array**, not a string, and nothing is removed from
them — a byte is a number and `0` is a number. That single decision is what
makes the two problems above impossible rather than merely fixed.

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
| 4 | append every byte to the numeric buffer, raw |
| 5 | take binary frames out of it by signature and length; take text lines only from runs that are entirely printable |

Three consequences worth knowing at the bench:

- **Every step is a `Public` variable**, which is the table above. Nothing about
  the read depends on an option code whose meaning has to be looked up.
- **A transmission that straddles two scans is one frame, not two broken ones.**
  The leftover stays in the buffer until the rest of it arrives. `RxBufLen` is
  that leftover, and watching it go non-zero and back to zero is watching the
  reassembly work.
- **A text line must be entirely printable to count as one.** On a binary feed
  some byte is eventually `0x0D`; treating it as a line end is exactly how good
  frames became bad lines. A run that reaches a terminator carrying bytes no
  text line can hold is counted at `RxNonText` and dropped, so an unframed
  binary frame is reported *as binary* rather than as a malformed line.
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

## When readings arrive but the Message Log is empty

Two faults produced exactly this, and both are worth knowing because neither
announces itself.

**The clock was on local time.** The logger stamped `…Z` on a timestamp that was
really AEST, so every reading landed **ten hours in the future**. The endpoint
accepted them — its ceiling is a day, and ten hours is a normal amount for a
field clock to be out — and they went into the database correctly. But the
Message Log filters `reading_ts` between the start of the chosen window and
`Date.now()`, so a reading stamped ten hours ahead is outside **every** preset
window. The data was there the whole time and nothing in the app would ever show
it. `REQUIRE_NTP` now stops this at the source; if you are chasing it on a logger
that has already posted, compare `reading_ts` against `received_at` on any row.

**The response parser reported every reading rejected.** Postgres renders `jsonb`
with a space after each colon:

```json
{"accepted": 2, "duplicates": 0, "rejected": [], "raw_id": 4821}
```

The parser started reading digits at the character straight after the colon, hit
that space, stopped, and kept the zero it had already stored. So `Accepted` sat
at 0, `Rejected` was derived by subtraction and equalled the whole batch, and the
`Diag` table said nothing was getting through while `PostOK` climbed and the data
landed. **`PostOK` rising with `Accepted` at zero is the signature** — the queue
advances in the same branch that parses the count, so the readings were always
being released correctly. Only the counters lied.

Both are fixed. The lesson worth keeping: a diagnostic that under-reports success
is more expensive than no diagnostic, because it sends you looking in the wrong
half of the system.

---

## What it does when things break

**The link goes down.** Readings queue. Both paths retry with a backoff that
doubles from 30 seconds to 15 minutes, so a base station does not spend an
outage hammering a dead endpoint or a dead broker. Nothing leaves the queue
until it has been delivered.

**One path goes down and the other does not.** The healthy one carries on
untouched — that is what the two independent positions in the queue are for.
Its depth stays a sawtooth while the broken one's climbs, which is the fastest
read on the table for *which half is broken*. Every reading the healthy path
delivered is in the database, so a long single-path outage costs the duplicates
that were never sent and nothing else.

**A POST times out after the request was sent**, or a publish does. The same
batch is sent again and it is stored once — both contracts guarantee that same
address + same `reading_ts` + same `value_raw` deduplicates. You will see
`Duplicates` climb, which is the system working, not a fault. **Do not build an
acknowledgement protocol on top of this**, between the logger and either
endpoint or between the two paths.

**The queue fills.** The oldest reading is dropped and `QDropped` counts it. For
flood warning the current river level matters more than the one before it, so
the newest reading always gets a slot. A slot is only reused once **both** paths
have passed it, so what fills the buffer is the slower of the two — and what is
dropped from a stalled path has usually already been delivered by the healthy
one.

**The broker connection drops without a clean disconnect** — power cut, aerial
off, cellular gone. The broker publishes the Last Will on this station's behalf
and `meganet.station_health` shows it offline within a keep-alive or two. This
is the one failure the station cannot report itself, and the reason MQTT is
here. When it comes back, the program republishes its retained `online: true`
on the first successful publish rather than waiting for the backlog to drain.

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
- `MQTTPublish()` likewise — `MQTTPublish(topic, payload, qos, retain)`, all
  four, no optional tail, and its result taken as a return value rather than
  through a destination parameter,
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
| `MQTTPublish` — *unknown instruction* | The operating system predates MQTT. **`MQTT_ENABLE = False` does not help — the compiler reads the whole program.** Delete `PublishBatch`, `PublishStatus`, `MqttFailed`, `MqttWorked` and the *path 2* block in the slow sequence; what is left is the HTTP-only program. Then update the OS: MQTT is the reason to. |
| `MQTTPublish` — *wrong number of arguments* | Check the argument order against **CRBasic Editor's own help for your OS** and fix the two call sites (`PublishBatch`, `PublishStatus`). See the note below. |

> **The one instruction in this file whose signature is not settled, and what
> the manual does and does not settle about it.** Every other instruction here
> has been in this program since it was written and has run on the bench.
> `MQTTPublish()` is new. `archive/cr300.pdf` — the CR300 product manual — was
> checked against it, page by page, and the result is worth stating precisely:
>
> - **It confirms the instruction exists on this hardware.** §13.3 lists
>   `MQTTPublish()` among the CR300's internet-communications instructions
>   (printed p. 149), alongside `MQTTConnect()`, `MQTTPublishTable()`,
>   `MQTTPublishConstTable()` and `MQTTPublishMeta()`. So the program is not
>   calling something the CR300 does not have.
> - **It confirms MQTT is a TLS client**, which is the *Max TLS Server
>   Connections* requirement above (§7.1.6, printed p. 92).
> - **It does not contain the instruction reference at all.** §13.3 defers to
>   *"the CRBasic help"* and to Campbell's *Using MQTT with Campbell Scientific
>   Data Loggers* technical paper, and neither is reachable from the environment
>   this was written in — the toolchain constraint #157 has named since it was
>   opened. So the signature used here,
>   `Result = MQTTPublish(topic, payload, qos, retain)` returning `0` on success,
>   comes from Campbell's published documentation as indexed rather than from a
>   page anyone has read.
>
> It is one line in each of two subroutines. **Open CRBasic Editor's help on
> `MQTTPublish`, check the four parameters and their order, and compile before
> going to site** — which is what this whole section asks you to do anyway. If
> the order differs, only those two lines change; nothing else in the program
> depends on it.

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

**The MQTT half was checked the same way, and against the bridge itself.** The
message the program builds was transcribed out of `BuildBatch` and `MakeRec`
character for character and fed to `bridge/src/messages.js` and
`bridge/src/topics.js` — the real parsers, not a description of them. They
accept it: the topic parses as a v1 reading topic for `18_bateson`/`logger`, the
readings arrive with their `alert_id`, `reading_ts`, numeric `value_raw` and the
`suspect` flag intact, and the envelope carries `path` and `protocol` and
nothing else. The HTTP body was checked to still be byte-identical to what it
was before, with the MQTT message exactly the same object minus the twelve
characters of `payload` wrapper. The retained status message parses to
`online = true` with `battery_v` and `fw` surviving into `last_status`, the will
payload parses to `online = false`, and a battery reading of `NAN` drops the
field rather than putting the word `NAN` inside a JSON number.

**The two-tail ring buffer was the part most worth proving, so it was.** The
arithmetic from `QueuePush`, `BuildBatch`, `PostBatch` and `PublishBatch` was
run over 200,000 randomised steps with both paths failing independently: no path
ever handed out a slot twice, went backwards, or read a slot the scan had
overwritten; both tails stayed inside the ring; and with either path stalled for
400 consecutive readings the other still delivered **all 400** — which is the
failure a single shared position would have caused, and the reason there are
two. The publisher's backoff was run against a broker down for an hour with an
empty queue: 8 attempts rather than 360, doubling 30 s → 15 min, recovering on
the first attempt after the broker returns, and republishing the retained status
on the first successful batch rather than after the backlog drains.

Those are simulations of the algorithm in another language, and they are worth
exactly what that is worth: they cannot tell you the CRBasic compiles, only that
what it is trying to do is right.

---

## What it deliberately does not do

**It does not convert counts to millimetres.** `value_raw` is the 11-bit number
that came off the air. A base station hearing forty sites does not know which is
a rain gauge and which is a level sensor, and a wrong bucket size is worse than
no bucket size — MegaNet does the conversion where it knows the sensor.

**It does not decode HFEM.** An HFEM line (`:HS=1|I1=…|NN:`) is a different
format from a different kind of station, and [`hfem.js`](../hfem.js) is the
decoder for it — one decoder, so there is never a second opinion about what `T3`
means. A base station relaying HFEM publishes the raw line to the bridge's own
`…/reading/hfem` topic and lets `hfem.js` decode it there.

**It does not stream a DataTable through `HTTPPost()`'s optional parameters.**
Those produce TOB1, TOA5, CSIXML or CSIJSON, and `ingest_http()` accepts none of
them — it wants one JSON object with a `payload` key.

**It does not use `MQTTPublishTable()` or the logger's automatic publishing.**
Those emit CSIJSON or GeoJSON on the `MQTTBaseTopic`, and the bridge subscribes
to a topic scheme and a payload contract that is neither. Leave the automatic
publishing off: everything it would send is a message the bridge acks, logs as
unparseable and counts as rejected. `MQTTPublish()`, which this program uses,
takes a whole topic of its own and does not inherit the base topic.

**It does not set the Last Will.** There is no CRBasic instruction for it — the
will is sent in the CONNECT packet, which the operating system builds from the
MQTT settings. All the program can do is publish the other half of the pair, and
say loudly (above, and in the file) that a base station whose will is unset or
left un-retained has no offline detection at all, which is most of what MQTT was
added for.

**It does not subscribe to anything.** The station's broker credential is
*Publish* and not *Publish & Subscribe*, so there is nothing to read. Commands to
stations would be a second topic branch and an explicit widening of that rule,
not a quiet one.

**It does not call `MQTTConnect()`.** The operating system opens and holds the
session on its own once MQTT is enabled in the settings, and reconnects it. That
instruction exists to *force* an attempt, which is what a program that powers a
modem down between transmissions needs. This base station is mains-powered and
listening continuously, so there is nothing to force — a logger that switches its
modem on the hour wants `PingIP()` and then `MQTTConnect()`, and that is a
different program rather than a setting on this one.

**It does not enforce which addresses this base may post for.** Neither does the
endpoint: `alert_low`/`alert_high` on the token record are a note, not a rule
(`db/migrations/0007_ingest_http.sql`, decision 3).
