# sdr-pi — an RTL-SDR on a Raspberry Pi, for a PC that cannot reach USB

The Pi drives the stick with MegaNet's own driver (`../rtlsdr.js`) and decoder
(`../alert-dsp.js`) and prints what it hears on a serial port — the USB-C port of a
Pi 4 or 5 made into a USB serial device, or the GPIO UART with a USB-serial cable.
PuTTY on the PC logs that port; the Serial Monitor's RTL-SDR card follows the log.

On the Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/sdr-pi/install.sh | sudo bash
sudo reboot
```

| File | |
|---|---|
| `relay.js` | the program — `node relay.js --help` |
| `dsp-worker.js` | the decoder's thread |
| `install.sh` | sets the Pi up (`--link usb\|uart\|both`, `--tcp PORT`, `--update`, `--uninstall`, `--dry-run`) |
| `usb-gadget.sh` | the USB-C port as a USB serial device |

The guide — what to buy, PuTTY step by step, the commands, what goes wrong — is
[`../docs/sdr-pi.md`](../docs/sdr-pi.md); the protocol is
[`../docs/sdr-pi-serial.md`](../docs/sdr-pi-serial.md). `npm run sdrpi` in `../test`
holds both.
