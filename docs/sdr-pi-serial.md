# The SDR Pi's serial interface

What MegaNet's SDR receiver on a Raspberry Pi (`sdr-pi/relay.js`,
[`sdr-pi.md`](sdr-pi.md)) sends on its serial port, and what it accepts. Written
for people and for software agents: a client built from this page alone should
work. `sdr-pi.js` is both ends of it in code — the relay writes with it, the
Serial Monitor's RTL-SDR card reads with it — and `test/sdrpi.mjs` holds the two
to each other.

The conventions are the Quansheng ALERT receiver's
([`ALERT_SERIAL.md`](https://github.com/cdomotor-g/quansheng_alert_v3/blob/main/docs/ALERT_SERIAL.md)),
kept on purpose so the two receivers read alike. **Schema 1.**

## 1. Connecting

| | |
|---|---|
| Pi 4 / Pi 5, USB-C | a USB CDC ACM device (VID `0x1d6b`, PID `0x0104`, product "MegaNet SDR Pi"). Windows: *USB Serial Device (COMn)*, its own driver. The Pi's end is `/dev/ttyGS0`. Any speed. |
| any Pi, GPIO UART | pins 8 (Pi TX) and 10 (Pi RX), ground on 6, 3.3 V. **115200 8N1**, no flow control. The Pi's end is `/dev/serial0`. |
| TCP (`--tcp PORT`) | Raw or Telnet. A Telnet client is answered `IAC WILL ECHO`, `IAC WILL SUPPRESS-GO-AHEAD`, and the Pi echoes; a Raw one is not echoed. |

No DTR is needed: the Pi writes whenever it has something, and what nobody reads
is dropped once 64 kB (hidden records) or 1 MB (everything) is waiting. When the
PC opens the port it may first receive what was waiting — section 5 says how a
client times that correctly.

## 2. Line format

Every record line:

- is ASCII, ends in CR LF, and is split into fields by commas;
- has the record type as its first field;
- uses an empty field for unknown or not applicable;
- has no commas inside a field (a station name's are spaces);
- is shown in a terminal, unless it is **hidden** (below).

**Hidden records.** The level, the spectrum, decode traces, periodic `STAT`
lines and periodic schema repeats are sent inside an operating-system-command
escape that terminals swallow:

```
ESC ] 7355 ; <record line> BEL          (bytes 1B 5D '7355;' … 07)
```

PuTTY, xterm, Windows Terminal and Tera Term print nothing for it; a log of the
raw bytes (PuTTY's *All session output*) keeps it. A client takes the text between
`7355;` and `BEL` (or `ESC \`) as a record line like any other. `ESC ] 0 ; … BEL`
is the window title the Pi sets every 10 s; a client may ignore it.

**Echo.** On a serial line the Pi echoes what it is sent, so a person in PuTTY
sees their typing. A record printed while a command is half-typed is preceded by
`CR ESC [ K` and followed by the half-typed text again. A client strips CSI
sequences (`ESC [ … final byte`), applies backspaces (`BS` deletes the character
before it), and treats a line whose first field is not a record type as text.

### Classes of line

| Class | Test | |
|---|---|---|
| final | first field `OK` or `ERR` | the end of one console command: `OK`, `OK,<detail>`, `ERR,<reason>` |
| record | first field one of `SDRPI FIELDS CFG RX BURST STAT NOTE LVL SPEC TRACE` | the stream |
| text | anything else | the banner, `HELP,` and `TIME,` replies, the status line Enter gets, echoed typing |

## 3. Versioning

`SDRPI,version,<v>,schema,1,…` names the schema. Then one
`FIELDS,<TYPE>,<field>,<field>,…` line per record type. Within schema 1 fields
are only ever **appended**; a client maps fields **by name** from the latest
`FIELDS` line, keeps fields it does not know, and uses the lists below until a
`FIELDS` line arrives. Both are sent when the relay starts, when a port opens, on
`HELLO`/`INFO`, and hidden every 10 minutes, so a log joined late learns them.

## 4. Records

Common fields: `run` — a random 8-hex-digit id for this start of the relay (a new
one means it restarted); `up` — milliseconds since that start, from a monotonic
clock; `epoch_ms` — Unix time in milliseconds, **only** when the Pi's clock is
trustworthy (NTP synchronised, or set by `TIME`), else empty.

### SDRPI — who is talking (key, value pairs)

`SDRPI,version,1.0.0,schema,1,run,742054db,host,meganet-pi,source,usb,stick,RTLSDRBlog Blog V4 s/n 00000001,model,RTL-SDR Blog V4 (R828D),tuner,R828D,min_hz,500000,max_hz,1766000000,gains,0;9;14;…;496,bias_tee,1,direct,0,upconverter,1,node,v18.19.0`

`gains` are the tuner's steps in tenths of a dB, `;`-separated. `source` is `usb`,
`rtl_sdr` or `file`. Keys may be added.

### CFG — the settings (key, value pairs)

`CFG,freq,151.500000,rate,240000,gain,29.7,agc,0,ppm,0,fmt,ABF,gate,1,squelch,8,offset,0,bias,0,direct,auto,model,auto,spec,5,lvl,2`

Sent after every change and on `CFG`. **The same keys in the same units as the
`CFG` command**, so a CFG line turned into `CFG key=value …` sets the same state
again. `freq` MHz; `offset` kHz; `gain` dB or `auto`; the rest as section 6.

### RX — one accepted reading (shown)

| Field | | |
|---|---|---|
| seq | int | readings since this start |
| run, up, epoch_ms | | when the burst it came from ended |
| id | 0–8191 | ALERT address |
| value | int | the raw value as sent (0–2047; 0–99 for ASCII) |
| fmt | `ABF` `EIF` `ASC` | ALERT Binary, Enhanced iFLOWS, ALERT ASCII |
| votes | int | in how many of the decoder's 45 carrier/timing combinations the frame turned up; 4 is the bar |
| pol | `STD` `NEG` | framing polarity |
| crc | 1, 0, empty | Enhanced iFLOWS' CRC-6; empty for the other formats |
| hex | 8 hex digits | the frame's four data bytes as received |
| carrier_hz | int | the carrier's offset from the channel centre |
| burst | int | the `BURST` it came from (its `seq`); empty when decoding is not gated |
| peak_dbfs, nf_dbfs, burst_ms | | that burst's peak, the channel floor, its length |
| freq_hz | int | the channel: the stick's frequency plus the offset |
| name, kind | | MegaNet's name for the address, as the Quansheng radio's table names it (`stations.json`), and `RAIN` `LVL` `BATT` `REP` `SNSR` `CHK`; empty when unknown |

Bit-flip shadows (a frame within two bits of one with three times its votes) are
never sent as `RX`; they are in the decode's `TRACE`.

### BURST — the channel rose over its floor and fell again (shown)

`seq, run, up, epoch_ms, ms, peak_dbfs, nf_dbfs, freq_hz` — sent when the gate
closes; its readings follow in `RX` lines naming its `seq`, and its `TRACE` after
them. A burst with no `RX` and a `TRACE` whose `all` is 0 was heard and not decoded.

### TRACE — one decode (hidden)

`run, up, burst, ms, combos, seconds, all, carrier_hz, start, frames, shadows, symbols`

`ms` decode time; `combos` combinations tried; `seconds` window length; `all`
frames accepted (including ones already reported in the last 10 s); `symbols` the
soft symbols from 30 before the first frame to 70 after the last (the first 1200
when no frame was found), one character each — the index of the character in
`A–Z a–z 0–9 + /` is `(s + 3) / 6 × 63`, `s` clamped to ±3; `start` the index of
the first one sent; `frames` `pos:id:value:inv;…` with `pos` counted from the
window's first symbol (so `pos − start` in the slice); `shadows`
`id:value:votes:ofId:ofValue;…`.

### STAT — status (hidden every 10 s, shown every 5 min and on `STATUS`)

`run, up, epoch_ms, clock, state, freq_hz, offset_hz, rate, in_rate, gain, agc, ppm, fmt, gate, squelch, nf_dbfs, ch_dbfs, open, dbfs, clip_pct, bursts, readings, drops, cpu_pct, temp_c, model, tuner, source`

`clock` `ntp`, `set` or empty (no time of day to trust). `state` `streaming`,
`no-stick`, `starting` or `stopped`. `in_rate` samples a second actually arriving.
`ch_dbfs` the channel's strongest level in the last 10 s (its 10 ms power,
sampled ten times a second); `nf_dbfs` its floor; `open` the gate now; `dbfs`, `clip_pct` the ADC's mean level and clipping.
`drops` lost USB transfers and samples dropped because the decoder fell behind.
`cpu_pct` the relay's share of one core (it can pass 100 on a multi-core Pi);
`temp_c` the SoC.

### LVL — the level (hidden, every `lvl` seconds)

`run, up, ch_dbfs, nf_dbfs, open, dbfs, clip_pct, hist` — over the interval: the
channel's strongest level (as in `STAT`), its floor, whether the gate opened, the ADC's mean
level and clipping, and `hist`, the ADC's 32-bin histogram as 32 characters on a
square-root scale against the fullest bin (`(i / 63)²` of it), where a bin with
anything in it is never `A`.

### SPEC — the spectrum (hidden, every `spec` seconds)

`run, up, rate, freq_hz, offset_hz, lo_dbfs, step_db, agg, bins` — `bins`
characters across the band, negative frequencies first: each the strongest of its
group of FFT bins (`agg` `max`) over the interval, at `lo_dbfs + index × step_db`.

### NOTE — something happened (shown)

`run, up, epoch_ms, level, text` — `level` `info`, `warn` or `bad`; `text` runs to
the end of the line and may hold commas. For people: log it, do not parse it.

## 5. Timing a reading

A reading's time is `epoch_ms` when there is one. Otherwise, from a live stream,
it is the reader's own clock: every record's `up` against the moment it arrived
gives an offset that is the truth plus however late it arrived, never minus, so
the **smallest** `arrival − up` seen for the current `run` is the best estimate,
and `offset + up` times the reading. Wait until two seconds of records have
settled that before timing anything: the first lines after a port is opened may
have been queued long before. A record from a log's history — written before the
reader started following it — has no arrival time: with no `epoch_ms` it has no
time at all.

## 6. Console

A line-based command interface on the same port. One command at a time; each ends
in exactly one `OK[,<detail>]` or `ERR,<reason>`, and records may arrive between a
command and its final line. Words are case-insensitive. Enter on its own answers a
one-line status (text, not a record).

| Command | | Answers |
|---|---|---|
| `HELP` | | `HELP,` lines, `OK` |
| `HELLO`, `INFO` | | banner, `SDRPI`, `FIELDS`, `CFG`, `STAT`, `OK` |
| `STATUS` | | `STAT`, `OK` |
| `CFG` | | `CFG`, `OK` |
| `CFG key=value …` | several settings, all checked before any is made | `CFG`, `OK` |
| `SET key value` | one | `CFG`, `OK` |
| `FREQ v`, `RATE v`, `GAIN v`, `PPM v`, `FORMAT v` (`FMT`), `OFFSET v`, `GATE v`, `SQUELCH v` (`SQ`), `AGC v`, `DIRECT v`, `MODEL v`, `SPEC v`, `LVL v` (`LEVEL`) | one setting; on its own, asks for it | `CFG`, `OK` |
| `BIAS ON YES`, `BIAS OFF` | the bias tee | `CFG`, `OK` |
| `TIME <unix seconds>` | sets the clock (ignored when NTP keeps it) | `NOTE`, `OK` |
| `TIME` | | `TIME,<unix seconds or empty>`, `OK,<ntp\|set\|unset>` |
| `DECODE [1–8]` | decode the last seconds now | `OK`, then `TRACE`/`RX` |
| `RESTART` | open the stick again | `OK` |
| `DEFAULTS YES` | every setting back | `CFG`, `OK` |

Settings and their units:

| Key | Value |
|---|---|
| `freq` | MHz (`151.5`), or with a unit: `151.5M`, `151500k`, `151500000` (a bare number over 100000 is Hz; between 2000 and 100000 is refused). 0.5–1766 MHz, and inside the stick's own range. |
| `rate` | `240000` `960000` `1200000` `1920000` `2400000` (each decimates to the decoder's 240 ksps exactly); `240k`, `2.4M` |
| `gain` | dB, −10 to 50, or `auto` (the tuner's AGC). The tuner takes the nearest step at or above. |
| `agc` | the RTL2832U's own AGC: `on`/`off` (`1`/`0`, `yes`/`no`) |
| `ppm` | −200 to 200 |
| `fmt` | `ABF` (`BINARY`), `EIF` (`ENHANCED`), `ASC` (`ASCII`). Never `IFLOWS`: NSW's network is called iFLOWS and sends ALERT Binary. |
| `gate` | decode bursts only: `on`/`off` |
| `squelch` | dB over the channel floor a burst must rise, 2–40 |
| `offset` | the decoder's channel from the centre, kHz; within `rate/2 − 12` kHz |
| `bias` | `on`/`off` — in `CFG` with no confirmation (MegaNet's card asks before it sends one) |
| `direct` | `auto` `off` `i` `q` (V3 HF direct sampling) |
| `model` | `auto` `v2` `v3` `v4` `r820t` `r828d` `fc0013` `fc0012` — reopens the stick |
| `spec`, `lvl` | seconds between `SPEC` / `LVL` records, 0 for none |

Reasons in `ERR`: `UNKNOWN` (no such command), `ARG …` (a value it cannot read),
`RANGE …` (outside the stick's range, or an offset outside the band), `CONFIRM …`
(`BIAS ON` without `YES`, `DEFAULTS` without `YES`), `NOSUPPORT …` (no bias tee on
this stick), `USB …` (the stick refused), `NODECODER`.

## 7. Writing a client

1. Read bytes; keep the partial line and any partial escape sequence for the next
   read. Pull out `ESC ] 7355 ; … BEL` records; drop other escape sequences; apply
   backspaces; split the rest on CR or LF.
2. Classify each line (section 2). Map record fields by name (section 3).
3. Time readings as section 5 says. Never time a history line "now".
4. To change a setting, send `CFG key=value …` and wait for the `CFG` line — it is
   what the Pi is now set to — and the `OK`.

`sdr-pi.js`'s `Reader` is steps 1 and 2 in code; `serial-sdr.js` is a whole client.
