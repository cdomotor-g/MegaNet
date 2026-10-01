# The Serial Monitor's RTL-SDR card

An RTL-SDR Blog V2, V3 or V4 stick on a USB port, tuned to an ALERT channel and
decoding it off the air — in the browser, with no other software. Add one with
**+ RTL-SDR** on the Serial Monitor tab, or press **Demo RTL-SDR** to see the
whole card with nothing plugged in.

| File | What it is |
|---|---|
| `rtlsdr.js` | The WebUSB driver: RTL2832U + Rafael R820T/R820T2/R828D, with the RTL-SDR Blog V3 and V4 behaviours |
| `alert-dsp.js` | The off-air decoder, run in a Web Worker built from its own source: channeliser, burst gate, ALERT Binary / Enhanced iFLOWS / ASCII decode, spectrum, FM audio |
| `serial-sdr.js` | The card: controls, graphics, the readings table |
| `serial-viz.js` | Canvas helpers shared with the Quansheng card |
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

## Getting the stick to the browser

WebUSB needs Chrome or Edge, served over https or from localhost. The operating
system has to let go of the stick first, exactly as for `rtl_sdr`, SDR# or rtl_tcp:

- **Windows** — install the **WinUSB** driver on the stick's *interface 0* with
  [Zadig](https://zadig.akeo.ie/). If SDR# already works on the machine, this is done.
- **Linux** — the kernel's DVB-T TV driver claims the stick on plug-in:
  `sudo rmmod dvb_usb_rtl28xxu` (or blacklist it in `/etc/modprobe.d/`), and give
  your user access with a udev rule for `0bda:2838`
  (e.g. `SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666"`).
- **macOS** — nothing to do.
- **Anywhere** — close whatever else holds it: rtl_tcp, SDR#, SDR++, GQRX, or this
  card in another tab. Only one program can hold the stick.

The card's error messages say which of these it looks like.

## What each model does

| Model | Tuner | Range | Extras |
|---|---|---|---|
| **V2** / generic | R820T or R820T2 | about 25–1766 MHz | none |
| **V3** | R820T2 | about 25–1766 MHz; **0.5–24 MHz by direct sampling** on the Q-branch | bias tee (GPIO 0) |
| **V4** | R828D, 28.8 MHz crystal | **0.5–1766 MHz** — below 28.8 MHz through its built-in upconverter | bias tee (GPIO 0); three inputs switched by band; FM/DAB notch filters switched off when tuned inside those bands; upconverter path switch on GPIO 5 |
| other R828D | R828D, 16 MHz crystal | about 25–1766 MHz | cable 1 below 345 MHz, air input above |

A V4 is recognised by its USB strings (`RTLSDRBlog` / `Blog V4`). A V3 that does not
name itself looks like a V2 to the driver; pick *V3* in the setup form to get direct
sampling and the bias tee. Bias tee puts 4.5 V on the antenna socket — the card asks
before turning it on.

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

The driver has only ever run against `test/rtlsdr.mjs`'s simulated dongle; the decoder
has run against a real capture. What needs a real V2 and V4, in order:

1. **Open.** *+ RTL-SDR → Choose USB stick → Open*. Expect the card's notes to say
   `Opened … tuner R820T` (V2/V3) or `R828D` (V4) and the *Device* chip to name the
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
   Quansheng radio on the same channel, in the next card) reports. Save a capture of a
   good burst — it can become a second regression vector beside the 4078 rig's.
8. **ppm.** Measure the stick's error on a known carrier and set it; the decoder searches
   ±10 kHz, so this matters more for the display than for decoding.

Report what differs, and fix it in `rtlsdr.js` with a matching change to the simulated
dongle in `test/rtlsdr.mjs`, so the check keeps holding the corrected behaviour.
