# The Serial Monitor's RTL-SDR card

An RTL-SDR Blog V2, V3 or V4 stick on a USB port, tuned to an ALERT channel and
decoding it off the air — in the browser, with no other software. Add one with
**+ RTL-SDR** on the Serial Monitor tab, or press **Demo RTL-SDR** to see the
whole card with nothing plugged in.

**A computer that cannot reach USB** — no WebUSB, no administrator for the WinUSB
driver — can still have one: the stick goes on a **Raspberry Pi** that runs this
same driver and decoder and prints what it hears on a serial port, PuTTY logs the
port, and this card follows the log (*Where is the stick?* → *on a Raspberry Pi*).
[`sdr-pi.md`](sdr-pi.md) is that guide. A stick on a Pi can also decode several
channels at once — the card's **Channels** box, [`sdr-pi.md`](sdr-pi.md#several-channels-from-one-stick).

| File | What it is |
|---|---|
| `rtlsdr.js` | The WebUSB driver: RTL2832U + Rafael R820T/R820T2/R828D, with the RTL-SDR Blog V3 and V4 behaviours, or + Fitipower FC0012/FC0013 (the V2), as librtlsdr drives them |
| `alert-dsp.js` | The off-air decoder, run in a Web Worker built from its own source: channeliser, burst gate, ALERT Binary / Enhanced iFLOWS / ASCII decode, spectrum, FM audio |
| `serial-sdr.js` | The card: controls, graphics, the readings table |
| `serial-viz.js` | Canvas helpers shared with the Quansheng card |
| `tools/install-rtlsdr-driver.cmd` | Windows: puts Windows' own WinUSB driver on every stick plugged in that lacks it — double-click it |
| `test/alertdsp.mjs`, `test/rtlsdr.mjs` | The checks — a real off-air burst, and a simulated V2/V3/V4 |

## Where it comes from

The decoder is a port of [agmurf/sdr-alert-decoder](https://github.com/agmurf/sdr-alert-decoder)
(MIT) — its Android `AlertDsp.kt` and `Alert1Formats.kt`, themselves a line-for-line
port of that project's proven desktop chain. Read its `HANDOVER.md` before changing
any DSP; the short version is in `alert-dsp.js`'s header. Its real off-air capture
of the 4078 ERT-A2 test rig is the regression vector here too
(`test/fixtures/sdr/testrig_burst_240k.iq8`), and the port decodes it as the original
does: **4079 = 420, 4080 = 121 (12.1 V)** under Enhanced iFLOWS, 25 votes each, in
about 0.4 s for a 3 s window.

Where the port departs from the Kotlin, the code says so at the spot:

- **Carrier search over the whole window.** The Kotlin FFTs only the first 8192
  samples, which finds nothing when a burst starts later in the window. This reads
  every 8192-sample segment, keeps the ones with a signal in them, and picks
  carriers from those — and does not decode a window that is only noise.
- **Sliding-DFT tone filter.** The same correlation, a fortieth of the arithmetic.
- **Bit-flip shadows.** ALERT Binary has no checksum, so a strong burst can hand
  the vote a frame one or two bits from the real one (the demo band produces
  `2080 = 143` at 4 votes beside `2088 = 143` at 26). A reading within two bits of
  one with three times its votes is reported as a *shadow* in the card's notes,
  not as a station.
- **A burst gate.** The live pipeline decodes a window around each burst (the
  channel's power over its own ~30 s floor), rather than every 3 s window. Untick
  *decode bursts only* to go back to the desktop's every-1.5 s cadence.
- **Filtering only around bursts** (#259 part 2, `BurstWatch`). Between bursts a
  `Pipeline` still filters every sample of the stick's window down to its channel:
  nearly all of a base station's work, and more the wider the window. A
  `BurstWatch` stands in front of one: `new BurstWatch(pipe)`, then `w.feed(u8)`
  in place of `pipe.feed(u8)`. It keeps the last 1.4 s of the window as bytes and
  25 times a second takes a look at the channel (2,048 samples at 240k, mixed to
  the channel and summed down from the window's rate, an FFT, the power within
  6 kHz). While that stays near the channel's floor the pipeline sleeps. When it
  comes within 3 dB of the squelch, the pipeline is moved on to 0.8 s before
  (`Pipeline.skip()`: its clocks and the gate's block phase carried on, its filter
  history let go, nothing before the skip read into a decode window) and the kept
  bytes are put through it; from there it is the pipeline as always. It sleeps
  again once the channel has been quiet half a second, the squelch shut and every
  burst decoded (a decode window reaches 0.6 s before the squelch opened at most,
  so 0.8 s is enough). Asleep, the squelch's floor follows the watch's own (the difference
  learned each time both ran, applied as of where a replay starts so a replay
  never moves it twice), the level reports carry the watch's looks, and the
  spectrum takes the end of each chunk. Ungated, or with a carrier that stays up,
  it stays awake and costs what the pipeline does. Measured on a quiet channel,
  per second of signal: 2.6 ms against the pipeline's 6–8 ms at 240 ksps, 3.0
  against 39 at 960 ksps, 4.4 against 94 at 2.4 Msps. `npm run alertdsp` runs the
  same stream through both: bursts from 6 dB under the noise to 30 over at 240k,
  960k off centre with a neighbour loud enough to clip the stick's bytes, and the
  rig's and a Binary station's real bursts in their own quiet: the same readings
  and the same bursts, each the same length. Nothing on the website uses it yet;
  RPi ALERT 0.18 does, behind its *Between bursts* setting.
- **Light decoding** (#259, `decodeWindow(…, { lean: 2 })`, `Pipeline` `lean: 2`).
  Every carrier guess lies within ±10 kHz, and with a tone either side and the
  signal's own ±5 kHz, nothing a guess reads is more than 16.5 kHz out. So light
  filters the window to 48 kHz once (55 taps, flat to 16.5 kHz, stopped by 31.5),
  runs the carrier search there (2,048-point FFTs, 23 Hz bins against 29), and
  makes each of the nine guesses from 48 kHz (÷4, a 25-tap 5 kHz low-pass as wide
  as the 121-tap one at 240k). A burst's decode takes about half of lean's time
  (65 ms against 122 over synthesised windows; 61 against 128 on the rig). It is
  another filter, so not bit for bit lean: over 600 synthesised windows from 4 to
  30 dB both found 642 true readings, with 24.0 votes each against 24.2, and 573
  ghosts against 568; the rig, both real Binary bursts and the demo band read the
  same. `compare: true, compareLean: 2` on a lean pipeline checks light against
  it, the decode's `compare.pair` saying which two (0 full, 1 lean, 2 light).
- **RPi ALERT's pipeline** passes `ringS: 5` (5 s of decode ring rather than 8: a
  3 s burst and its margins need 3.8) and `capture: false` (no bytes kept for the
  card's *capture IQ*, which the Pi never asks for): the same messages, 10 MB less
  a channel, and the work of re-quantising every sample gone.
- **Lean decoding** (#259). A burst is decoded with 45 guesses: 3 carrier
  candidates × 3 tone hypotheses × 5 nudges of ±75 and ±150 Hz. Each guess used to
  filter the whole window again, which was two thirds of the decode. Lean filters
  once per hypothesis and makes the nudges afterwards on the 12 kHz baseband, where
  they cost almost nothing. **The live pipeline decodes lean by default** since
  2026-11-03. The first base station to run both read 11,628 live bursts with
  them, and 14 (0.12%) read differently; lean took a third of the time.
  `Pipeline.configure({ lean: false })` goes back to the full decoder, and
  `decodeWindow` is full unless given `lean: true`. `npm run alertdsp` holds lean
  to the full decoder: the rig, both real Binary bursts, 24 synthesised bursts from
  3 to 25 dB and the demo band all read the same. `compare: true` decodes each
  burst the other way too and reports whether the two agree, in the decode's
  `compare`; the readings posted stay the pipeline's own, and the comparison is
  skipped while bursts are waiting.
- **Between bursts, block copies.** The samples go into the decode, capture and
  spectrum rings a block at a time rather than a sample at a time, with the same
  contents, message for message. That's about a quarter of a 240 ksps channel's
  work between bursts. `specHz: 0` turns the spectrum off for a pipeline that
  doesn't need one: RPi ALERT's second and later channels on a stick, whose slice
  the first channel draws. That's another sixth.

## Getting the stick to the browser

WebUSB needs Chrome or Edge, served over https or from localhost. The operating
system has to let go of the stick first, exactly as for `rtl_sdr`, SDR# or rtl_tcp:

- **Windows** — the stick needs the **WinUSB** driver, and until it has it, it is not
  in the browser's chooser at all: Windows offers the browser only devices it can hand
  over. Run [`tools/install-rtlsdr-driver.cmd`](../tools/install-rtlsdr-driver.cmd)
  (the card's *Getting the stick to the browser* links it as a download): double-click
  it, say Yes to the admin prompt, and it lists every stick plugged in and gives WinUSB
  to the ones that lack it — Windows' own `winusb.inf`, signed by Microsoft, so nothing
  is downloaded and no certificate is added. `install-rtlsdr-driver.cmd -List` only
  reports. The browser does not need restarting; re-plug the stick if it is still
  missing from the list. If SDR# already works with the stick, this is done.

  By hand, [Zadig](https://zadig.akeo.ie/) does the same: *Options → List All Devices*,
  pick the stick, WinUSB, *Replace Driver*. Which entry is the stick depends on how many
  USB interfaces it has:

  | Stick | USB ID | Zadig lists it as | WinUSB goes on |
  |---|---|---|---|
  | Blog V3, V4 and most `RTL2838UHIDIR` sticks | `0bda:2838` | "Bulk-In, Interface (Interface 0)" | interface 0 (interface 1 is the IR receiver) |
  | V2-era and generic sticks that name themselves "RTL2832U" | `0bda:2832` | "RTL2832U" | the whole device — these usually have one interface, so there is no "Interface 0" entry |

  To undo it: Device Manager → *Universal Serial Bus devices* → the stick →
  *Uninstall device*, then re-plug it.
- **Linux** — the kernel's DVB-T TV driver claims the stick on plug-in:
  `sudo rmmod dvb_usb_rtl28xxu` (or blacklist it in `/etc/modprobe.d/`), and give
  your user access with a udev rule for `0bda:2838` and `0bda:2832`
  (e.g. `SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666"`,
  and the same line with `2832`).
- **macOS** — nothing to do.
- **Anywhere** — close whatever else holds it: rtl_tcp, SDR#, SDR++, GQRX, or this
  card in another tab. Only one program can hold the stick.

The card's error messages say which of these it looks like.

If none of this is possible on a computer — WebUSB switched off by policy, or no
administrator to install the driver — put the stick on a Raspberry Pi instead:
[`sdr-pi.md`](sdr-pi.md).

## What each model does

| Model | Tuner | Range | Extras |
|---|---|---|---|
| **V2** | Fitipower FC0013 (or FC0012) | about 22–1100 MHz (948 on an FC0012) | zero-IF — tuned 0.85 × the sample rate below the frequency, so the tuner's DC spike stays out of the band (the *Tuned* chip says `offset`); 23 gain steps, −9.9 to 19.7 dB; bias tee (GPIO 0) |
| **V3** | R820T2 | about 25–1766 MHz; **0.5–24 MHz by direct sampling** on the Q-branch | bias tee (GPIO 0) |
| **V4** | R828D, 28.8 MHz crystal | **0.5–1766 MHz** — below 28.8 MHz through its built-in upconverter | bias tee (GPIO 0); three inputs switched by band; FM/DAB notch filters switched off when tuned inside those bands; upconverter path switch on GPIO 5 |
| generic R820T | R820T or R820T2 | about 25–1766 MHz | none |
| other R828D | R828D, 16 MHz crystal | about 25–1766 MHz | cable 1 below 345 MHz, air input above |
| generic FC0013 / FC0012 | FC0013 or FC0012 | as the V2 | as the V2 without its bias tee; an FC0012 has 5 gain steps, no AGC of its own, and its VHF/UHF filter on GPIO 6 |

A V4 is recognised by its USB strings (`RTLSDRBlog` / `Blog V4`). A V2 is not — the one
this was brought up on reports `Generic` / `RTL2832U` — so it opens as *Generic FC0013*;
pick *V2* in the setup form for its bias tee. A V3 that does not name itself opens as a
generic R820T; pick *V3* to get direct sampling and the bias tee. Bias tee puts 4.5 V on
the antenna socket — the card asks before turning it on. The Blog's EEPROM switch for
forcing the bias tee on (byte 7, bit 1 clear) is honoured on a V3 or V4 only: on any
other stick that bit just turns its IR interface off, and a one-interface stick has it
clear.

## Using it

- **Frequency** is the stick's centre. The **decoder's channel** is the green band in
  the spectrum: click the spectrum to move it (or type a *Channel offset*), shift-click
  to retune the stick there. At 240 ksps the channel is the centre; at higher rates the
  worker mixes and decimates it down to 240 ksps (40 samples a 300-baud symbol).
- **Gain** buys ADC headroom, not SNR (the original's measurement: 40, 44.5 and
  49.6 dB of gain gave 17.5, 16.7 and 17.8 dB of SNR on one signal). Set it so the
  **ADC histogram**'s end bins stay empty; red end bins are clipping, and clipping
  corrupts bit decisions while the tones still look clean.
- **Frame format** — one at a time, on purpose. NSW's network is called "iFLOWS"
  but sends **ALERT Binary**; **Enhanced iFLOWS** is what an ERT-A2 set to it sends.
  Running both makes CRC-valid ghosts no vote threshold removes.
- **Votes** — in how many of the decoder's 45 carrier/timing combinations a frame
  turned up. 4 is the bar (the phone's — the desktop's 35 does not transfer).
- **Capture 3 s / 10 s** saves the channel as 240 ksps u8 IQ, the same format as the
  regression vector. **Replay a recording** plays one back through the same pipeline.
- **Listen** plays the FM audio, by default only while the gate is open.

The graphics: spectrum with noise floor and peak hold; waterfall; the channel's power
and every burst over ten minutes; the FM audio as a waveform; the audio's spectrum with
the mark (1300.8 Hz) and space (2109.4 Hz) tones marked; the symbols the last decode
read its frames from, each frame boxed; and the ADC histogram.

## Hardware bring-up checklist (for whoever has the sticks)

Where it stands: the **V4** opens and streams in the card. The **V2** (FC0013) was
checked on 2026-10-01 against librtlsdr on the same stick, driven from Node through
node-usb's WebUSB with this same `rtlsdr.js`: it opens, streams 240 k, 960 k and
2.4 Msps without loss, tunes 25–1090 MHz within 200 Hz, puts a carrier at the frequency
librtlsdr's own capture puts it, and matches librtlsdr's noise level at −9.9, 7.1 and
19.7 dB of gain. Not yet seen on either: an off-air ALERT decode (step 7). The **V3**
has run only against `test/rtlsdr.mjs`'s simulated dongle; the decoder has run against
a real capture. What needs real hardware, in order:

1. **Open.** *+ RTL-SDR → Choose USB stick → Open* (on Windows, a stick missing from
   the chooser has no WinUSB driver yet — run `tools/install-rtlsdr-driver.cmd` first). Expect the card's notes to say
   `Opened … tuner FC0013` (V2), `R820T` (V3) or `R828D` (V4) and the *Device* chip to name the
   model. If the V4 shows as *Generic R828D*, its USB strings differ from
   `RTLSDRBlog` / `Blog V4` — read them from `chrome://usb-internals` and fix
   `pickModel()` in `rtlsdr.js`.
2. **Samples arrive.** The *Rate* chip shows `…k/s in` within a few percent of the
   sample rate at 240 k, 960 k and 2.4 Msps. Short means dropped transfers: try
   `bufferSize` / `inflight` in `Device.start()`.
3. **Tuning is right.** Tune a known carrier (a local FM station on the V2; a known
   VHF/UHF carrier, then a HF broadcast station on the V4). It should sit on the
   spectrum's centre within a few hundred Hz plus the stick's ppm error. If it is
   mirrored (low and high swapped), the spectrum-inversion setting
   (`demod 1/0x15`) is wrong for that path. If it is off by a fixed amount, compare the
   IF the driver programs (`ifFreq` from `tunerSetBandwidth`) with what librtlsdr uses at
   that rate.
4. **V4 HF.** Tune 5–28 MHz: the *Tuned* chip should say `upconverter`, and signals
   should appear. Check the band switching by tuning 7 → 151.5 → 433.92 MHz and back.
5. **Gain.** Sweep the slider with a steady signal: the level should rise in steps; the
   histogram should widen. *tuner AGC* should settle by itself.
6. **Bias tee** (V3/V4) with a meter on the SMA, never with an antenna that shorts DC.
7. **ALERT.** Tune 151.500 MHz with an antenna, *ALERT Binary*, gain ~30 dB. Bursts should
   show on the timeline; readings should match what the network's own feed (or a
   Quansheng radio on the same channel, in the next card) reports. Two Binary bursts
   recorded at 18 Bateson are already regression vectors beside the 4078 rig's
   (`test/fixtures/sdr/binary_151.500_*.iq8`, `npm run alertdsp`); a capture from another
   stick or site is still worth adding.
8. **ppm.** Measure the stick's error on a known carrier and set it; the decoder searches
   ±10 kHz, so this matters more for the display than for decoding.

Report what differs, and fix it in `rtlsdr.js` with a matching change to the simulated
dongle in `test/rtlsdr.mjs`, so the check keeps holding the corrected behaviour.
