# The Serial Monitor's Quansheng ALERT radio card

A Quansheng **UV-K5 V3** or **UV-K1** running the ALERT receiver firmware
([cdomotor-g/quansheng_alert_v3](https://github.com/cdomotor-g/quansheng_alert_v3)),
plugged in by USB-C, becomes a dashboard: its readings, bursts, noise floor and
battery as they arrive, and every control the firmware's console offers. Add one with
**+ Quansheng radio**, or add a **serial device** and choose the radio's port — a port
with the firmware's USB vendor ID (`0x36B7`) becomes a Quansheng card by itself. Press
**Demo Quansheng radio** to see it with nothing plugged in.

| File | What it is |
|---|---|
| `quansheng.js` | The codec: line classes, the HDR schema, DEC/BST/STA/EVT records, console replies, payload and burst re-decoding, the screen, binary 0xABCD frames, and the station-table blob |
| `serial-radio.js` | The dashboard and the console queue |
| `serial.js` | Opens the port, reads it, keeps the raw log |
| `test/quansheng.mjs` | Every example line in the firmware's `docs/ALERT_SERIAL.md`, and the station table against the firmware's own lookup |

The firmware's [`docs/ALERT_SERIAL.md`](https://github.com/cdomotor-g/quansheng_alert_v3/blob/main/docs/ALERT_SERIAL.md)
is the source of truth (schema 2); `quansheng.js`'s header summarises the rules a client
gets wrong.

## The dashboard

- **Status** — firmware hash and schema, the radio's clock, battery (with its
  percentage bar), squelch, noise floor and instantaneous RSSI, the flash log's state
  and fill, the station table in use, bursts and decodes since boot, and the link.
- **Signal** — the noise floor (STA, every 10 s), the sensitivity it implies (floor +
  `SNR_REQ`, dashed), RSSI dots, and every burst as a stem from the floor to its peak:
  green when the radio decoded it, amber when it heard it and could not. 5 minutes to 3 hours.
- **Burst bits** — each burst's demodulated 300-baud bits (BST `bits_hex`), newest on
  top. The dashboard re-decodes them (alertmon.py's UART scan, ported) and boxes each
  frame: green for frames the radio reported, amber for frames in the bits it did not.
- **Readings** — every DEC: time, address, station (MegaNet's name, else the radio's),
  value in engineering units, format, RSSI and a fade-margin bar on the RSSI scale.
  Pick a time to see its 32 payload bits coloured by role, and open it in ALERT Packets.
- **Stations heard** — per address: last value, how often heard, mean and worst fade
  margin, and an RSSI trend.

## The controls

All go through the console, one command at a time, each ending on its `OK` or `ERR`
(whose reason the card shows in words).

- **Sync clock** — reads the radio's clock, reports how far off it was, and sets it.
  The clock lives in RAM and is lost on every reboot; the card sets it on connect.
- **Radio settings** — every `SET`/`GET` setting: voice, speaker, CSV out, logging,
  unknown addresses, confirm, squelch gate, `SNR_REQ`, debug, frequency, squelch level,
  the audio census. Each change is checked as the firmware checks it, sent, and read
  back. Frequency, squelch level and census only answer while the ALERT app runs.
- **Flash log** — state, download (all or the newest *n*) as CSV with the DEC field
  names as the header, erase, and format (only when the region holds foreign data).
- **Station table** — state, look up an address (the radio's name beside MegaNet's),
  and **build MegaNet's table and upload it**: the same structure `gen_stations.py`
  builds for the firmware — stations.json first, the legacy address file as fallback,
  names to 40 characters — checked against every rule the firmware relies on before it
  is offered for upload. Upload is `STN BEGIN`, 64-byte `STN W` lines, `STN END`, and
  starts over at 32-byte chunks if the radio refuses one. *Save .bin* writes the blob.
- **Screen** — captures the radio's 128 × 64 display, or mirrors it every 2.5 s while
  the console is idle; *Save PNG*.
- **Reboot**, **Events** (BOOT, CENSUS, SET, LOG, STN, CLOCK), and a **console** with
  quick buttons and the raw stream, every line classed as the firmware's document does.

## Things to know

- **DTR.** The radio sends only while the host holds DTR, and goes silent for good if a
  send is not collected. The card toggles DTR on open, and again after 25 s with no byte.
- **The baud rate does not matter** — it is a USB CDC port.
- **The K1 jack's UART** carries the same records at **38400 8N1** through a
  USB-serial cable, but not the console. Set the card's baud rate to 38400: the
  dashboard fills as records arrive, and the controls say the radio has not answered.
- **One program per port.** Close `alertterm.py`, CHIRP or any terminal first.
- **DFU.** If the stock bootloader's beacons arrive, the card says the radio is waiting
  to be flashed rather than receiving.
