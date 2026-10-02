# An RTL-SDR on a Raspberry Pi, read through PuTTY

For a computer that cannot reach an RTL-SDR stick: a managed Windows PC whose
browser has no WebUSB, and no administrator to give the stick the WinUSB driver
it needs. What that PC *can* do is what the Quansheng radio already relies on —
PuTTY opens a COM port and logs it, and the Serial Monitor follows the log.

So the stick goes on a Raspberry Pi, and the Pi is made to look like the radio:
it runs MegaNet's own RTL-SDR driver and ALERT decoder (the same `rtlsdr.js` and
`alert-dsp.js` the browser card runs), and prints what it hears on a serial port.

```
antenna ── RTL-SDR ──USB── Raspberry Pi ──USB serial── work PC: PuTTY ──log file──▶ MegaNet, Serial Monitor
                           decodes ALERT               (a COM port)    "All session      (an RTL-SDR card
                           with MegaNet's code                          output"          following the log)
```

On the PC nothing is installed and no browser permission is needed: PuTTY and
dragging a file onto a web page. Commands go the other way by pasting into PuTTY
— the card copies them for you, several changes as one line.

| File | What it is |
|---|---|
| `sdr-pi/relay.js` | The Pi's program: the stick through `rtlsdr.js` (node-usb's WebUSB), `alert-dsp.js` in a worker thread, records out and commands in on the serial port |
| `sdr-pi/install.sh` | One command on the Pi: Node and the `usb` package, a udev rule, the DVB-T driver kept off the stick, the serial link, the service |
| `sdr-pi/usb-gadget.sh` | A Pi 4 or 5's USB-C port as a USB serial device |
| `sdr-pi.js` | The protocol, both ends of it — [`sdr-pi-serial.md`](sdr-pi-serial.md) states it |
| `serial-sdr.js` | The RTL-SDR card, which follows a Pi's log as its fourth source |
| `test/sdrpi.mjs`, `test/logfollow.mjs` | The checks — the relay on the demo band and the 4078 rig's real burst, its console, its USB path on a simulated stick, and the card following its log in Chromium |

## What you need

Two ways to build it. Both give the PC an ordinary COM port.

### A. One cable — a Raspberry Pi 4 (or 5)

- A **Raspberry Pi 4 Model B** (1 GB is plenty) or a Pi 5, a microSD card (8 GB or
  more), the RTL-SDR stick (Blog V3 or V4; a V2 works), an antenna for 151.5 MHz.
- A **USB-C cable that carries data** (many charging cables do not).
- The Pi's USB-C port becomes the serial port **and** powers the Pi. Plug it into a
  laptop's **USB-C** port, which supplies 1.5–3 A. A USB-A port gives 0.5–0.9 A,
  which may not hold a Pi 4 and a stick up: if the Pi resets, or
  `vcgencmd get_throttled` on the Pi says anything but `throttled=0x0`, use a USB-C
  port or recipe B.
- Windows shows it as **USB Serial Device (COMn)** with its own built-in driver —
  the same kind of device as a Quansheng UV-K5 V3 radio.

### B. Smallest — a Raspberry Pi Zero 2 W and a USB-serial cable

- A **Raspberry Pi Zero 2 W**, a microSD card, the stick and antenna.
- A **micro-USB OTG adapter** (micro-B plug to USB-A socket) for the stick, in the
  Pi's port marked **USB** (not PWR).
- A **3.3 V USB-serial adapter** — CP2102, CH340, FTDI or PL2303. Pick the same chip
  as your Quansheng programming cable, if you have one: this PC already has its
  driver. Three jumper wires.
- Power for the Pi's **PWR** port: a phone charger or a power bank.
- Wiring, Pi header pins counted from the SD-card end:

  | Adapter | Pi |
  |---|---|
  | GND | pin 6 (GND) |
  | RX | pin 8 (GPIO 14, the Pi's TX) |
  | TX | pin 10 (GPIO 15, the Pi's RX) |

  Leave the adapter's 5 V and 3.3 V pins unconnected.
- Any Pi 3, 4 or 5 can be set up this way too (`--link uart`, below).

**IT.** A USB serial device is what the Quansheng radio is, so a PC that takes the
radio takes the Pi. If your organisation blocks or allow-lists USB devices, ask
before plugging anything in.

## Setting the Pi up — once, at home

1. On your own computer, **Raspberry Pi Imager**
   ([raspberrypi.com/software](https://www.raspberrypi.com/software/)):
   *Choose Device* (Raspberry Pi 4 / Zero 2 W) → *Choose OS* → *Raspberry Pi OS
   (other)* → **Raspberry Pi OS Lite (64-bit)** → *Choose Storage* (the microSD) →
   *Next* → **Edit settings**:
   - *General*: hostname `meganet-pi`; a username and password; your home Wi-Fi.
   - *Services*: **Enable SSH**, use password authentication.
   - *Save*, *Yes*, *Yes*.
2. Put the card in the Pi and power it. After about two minutes, from your computer:
   `ssh you@meganet-pi.local` (Windows: PowerShell, or PuTTY → *SSH* →
   `meganet-pi.local`).
3. On the Pi, one command:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/sdr-pi/install.sh | sudo bash
   ```

   It sets up the USB-C port on a Pi 4 or 5 and the GPIO UART on anything else. To
   choose: `… | sudo bash -s -- --link uart` (or `usb`, or `both`). It says what it
   did and what is next.
4. `sudo reboot`.
5. Optional, still at home: plug the stick and antenna in, then
   `journalctl -u meganet-sdr -f` shows `Opened … RTL-SDR Blog V4 …` and each reading
   as it is heard.

Updating later: `sudo bash /opt/meganet/sdr-pi/install.sh --update`. Taking it all
off: `--uninstall`.

## At work — PuTTY, then MegaNet

1. **Plug in**: stick and antenna into the Pi; the Pi into the PC (recipe A: USB-C;
   recipe B: the USB-serial adapter, and the Pi's own power). It is ready about 40 s
   after power.
2. **Find the COM port**: *Device Manager* → *Ports (COM & LPT)* — **USB Serial
   Device (COM7)** for recipe A, the adapter's name for B. Windows gives the same
   Pi the same number every time.
3. **PuTTY** — once, then it is a saved session:
   - *Session*: *Connection type* **Serial**; *Serial line* **COM7**; *Speed*
     **115200** (recipe A ignores it; recipe B needs it).
   - *Session → Logging*: **All session output**; *Log file name*
     `C:\Users\you\Documents\serial-logs\sdr-&Y&M&D-&T.log`; leave *Flush log file
     frequently* ticked.
   - *Session*: under *Saved Sessions* type `MegaNet SDR` and press **Save**. Next
     time, double-click it.
   - **Open**. The window shows the Pi's greeting, then a line for each burst and
     each reading as they are heard; the title bar shows the frequency, the noise
     floor and the counts. Press **Enter** on its own for a one-line status, or type
     **HELP**.
4. **MegaNet** → *Serial Monitor* → **drag the log file** (or the whole
   `serial-logs` folder, to follow the newest log in it) anywhere onto the tab. It is
   recognised and becomes an RTL-SDR card following the Pi. (Or *+ RTL-SDR* → *on a
   Raspberry Pi, read through PuTTY's log* → drop it on the card.)
5. **The clock** — worth a paste: the card's **Copy clock command**, right-click in
   PuTTY, Enter. A Pi has no clock of its own and no network at work; with the time
   set, every record carries it until the Pi is unplugged. Live readings are timed
   correctly either way; it is the log's history that needs it.
6. **Send to MegaNet** works as on any receiver card —
   [`ingest-serial-monitor.md`](ingest-serial-monitor.md). The Pi is a receiver of
   its own (`sdrpi-…`), reported to the database as an `rtl-sdr`.

## Settings

Out of the box: **151.500 MHz, ALERT Binary, gain 29.7 dB, 240 ksps, decode bursts
only at 8 dB** — the MegaNet networks' channel. Nothing to set for those.

- **On the card**: change a control and its command is copied — right-click in PuTTY,
  Enter. Change several before pasting and they wait together and copy as one
  `CFG …` line; the card shows *Waiting for the Pi* until the Pi's answer comes back
  through the log. **Copy all settings** copies the whole card as one line — to set a
  second Pi up the same way.
- **In PuTTY**, by hand: each command ends in `OK` or `ERR`, and settings are kept on
  the Pi across restarts.

  | Command | Does |
  |---|---|
  | `HELP` | lists these |
  | `CFG` | every setting, as one line |
  | `CFG freq=151.5 gain=29.7 fmt=ABF` | several at once |
  | `FREQ 151.5` | tune, MHz |
  | `OFFSET 12.5` | the decoder's channel, kHz from the centre |
  | `RATE 240000` | 240000, 960000, 1200000, 1920000 or 2400000 sample/s |
  | `GAIN 29.7`, `GAIN AUTO` | tuner gain |
  | `PPM -3` | the stick's frequency error |
  | `FORMAT ABF` / `EIF` / `ASC` | ALERT Binary, Enhanced iFLOWS, ALERT ASCII — one at a time |
  | `GATE ON`, `SQUELCH 8` | decode bursts only, and how far over the floor one must be |
  | `BIAS ON YES`, `BIAS OFF` | 4.5 V on the antenna socket, for an LNA (V2, V3, V4) |
  | `MODEL V4` | when the stick does not say what it is |
  | `SPEC 5`, `LVL 2` | seconds between spectrum / level records, 0 for none |
  | `TIME 1790843760` | set the clock (Unix seconds) |
  | `STATUS`, `INFO`, `DECODE 3`, `RESTART`, `DEFAULTS YES` | |

A higher sample rate shows more of the band on the card and costs the Pi more: a
Pi 4 manages any of them; a Pi Zero 2 W is comfortable at 240k and 960k. If the Pi
falls behind it says so (`The decoder is … behind`) and drops samples rather than
queueing them.

## What the Pi sends, and why PuTTY's window stays readable

Readings, bursts and notes are plain lines a person can read in PuTTY:

```
MegaNet SDR Pi 1.0.0 on meganet-pi - RTL-SDR Blog V4 R828D - 151.5000 MHz ALERT Binary - type HELP and press Enter
BURST,1,742054db,767,,320,-15.8,-48.1,151500000
RX,1,742054db,767,,2088,143,ABF,26,STD,,6860DEC4,190,1,-15.8,-48.1,320,151500000,MARBURG,BATT
```

The level twice a second, the spectrum every few, and each decode's symbols ride
inside an escape sequence terminals do not print (`ESC ] 7355 ; … BEL`). PuTTY
swallows them; its log, set to keep **All session output**, has every byte, and the
card reads them from there. That is also why the log must be *All session output*,
not *Printable output*. The full record set is
[`sdr-pi-serial.md`](sdr-pi-serial.md).

**Times.** Every record carries the Pi's uptime; the time of day only once NTP or a
`TIME` command has set the Pi's clock. The card times a reading by the Pi's uptime
against this computer's clock — so a reading the Pi had queued before PuTTY opened
the port is timed when it was heard, not when it arrived — and never times a
reading out of the log's history "now": with no clock, those show `—` and are not
sent to MegaNet.

## When it does not work

| What you see | What it means |
|---|---|
| No new COM port (recipe A) | The gadget is not up. Restarted since installing? A charge-only cable? On the Pi: `systemctl status meganet-sdr-gadget`. |
| A COM port, but PuTTY stays blank | The Pi may still be starting (40 s). Press Enter — the Pi answers with a status line. Recipe B: RX and TX swapped, or the speed is not 115200. |
| `No RTL-SDR stick found` | The stick is not on the Pi — on a Zero, in the PWR port instead of USB. |
| `The stick is there but this user may not open it` | Unplug the stick and plug it back in once after installing (the udev rule applies to new plug-ins). |
| `Something else has the stick` | The DVB-T TV driver (restart after installing), or `rtl_tcp` running. |
| The card: *Nothing new for a while* | PuTTY closed, or not logging this session. |
| The card: readings with `—` for a time | From the log's history, with the Pi's clock unset — *Copy clock command*. |
| `The decoder is … behind` | Too high a `RATE` for this Pi — `RATE 240000`. |
| The Pi restarts, or PuTTY drops the port | Not enough power — recipe A from a USB-A port. A USB-C port, or recipe B. |
| Settings changed on the card do not happen | The copied command was not pasted — *Waiting for the Pi* says what is waiting; *Copy again*. |

On the Pi, `journalctl -u meganet-sdr -f` is the running commentary.

## Without a Pi, or without a cable

`relay.js` runs on any Linux computer with Node 16 or later:

- `node sdr-pi/relay.js --serial /dev/ttyUSB0` — any serial port;
- `node sdr-pi/relay.js --tcp 7355` — PuTTY's *Raw* or *Telnet* connection type to
  that computer's address and port instead of a COM port (a Telnet session is asked to
  leave the echo to the Pi); log it the same way;
- `node sdr-pi/relay.js --stdio` — this terminal;
- `--source rtl_sdr` — librtlsdr's own `rtl_sdr` instead of MegaNet's driver;
- `--file capture_240k.iq8` — a recording, through the same decoder.

`node sdr-pi/relay.js --help` lists the rest. The console takes only the commands
above — there is no shell behind it — and TCP is off unless `--tcp` is given.

## Hardware bring-up — for whoever has a Pi and a stick

What the checks cannot reach, in order:

1. **Install** on a Pi 4 (and a Zero 2 W): the summary at the end; after the restart
   `systemctl status meganet-sdr meganet-sdr-gadget` both active.
2. **COM port**: on Windows 10 and 11 it appears with no driver install, and keeps
   its number after a re-plug.
3. **PuTTY**: the greeting; Enter answers the status line; `HELP`; `FREQ 151.5`
   answers `CFG,…` and `OK`; the title bar updates every 10 s.
4. **Off the air**: with an antenna on 151.500 MHz, readings that match the network's
   own feed or a Quansheng radio beside it.
5. **The card**: the log dropped on the tab is recognised; readings, spectrum and
   bursts appear; *Copy clock command* pasted turns the *Pi clock* chip to `set`; a
   control's copied command, pasted, clears *Waiting for the Pi*.
6. **Unplug and re-plug the stick**: `NOTE` lines say so, and streaming resumes by
   itself.
7. **Power**: a Pi 4 on a laptop's USB-C port for an hour, `vcgencmd get_throttled`
   still `throttled=0x0`.
8. **Load**: a Zero 2 W at 240k and 960k — the `STAT` line's `cpu_pct`, and no
   *behind* notes.

Report what differs. The relay's own behaviour is held by `npm run sdrpi`; a fix
there should come with an assertion there.
