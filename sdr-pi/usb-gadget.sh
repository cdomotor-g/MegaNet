#!/bin/sh
# MegaNet — sdr-pi/usb-gadget.sh
#
#   Makes a Raspberry Pi 4 or 5's USB-C port a USB serial device — CDC ACM, the
#   class Windows 10 and 11, macOS and Linux all drive with a driver of their
#   own — so the PC it is plugged into gets a COM port, nothing installed, and
#   the Pi gets /dev/ttyGS0 for relay.js to talk on.
#
#   Run at boot by meganet-sdr-gadget.service (install.sh puts it in place),
#   after config.txt's dtoverlay=dwc2,dr_mode=peripheral has put the port in
#   device mode. The same cable powers the Pi.
#
#   usb-gadget.sh up | down | status

set -eu

G=/sys/kernel/config/usb_gadget/meganet-sdr

# The Pi's own serial number, so Windows keys the COM port to this Pi and gives
# it the same number every time it is plugged in.
serial() {
  s=$( { tr -d '\000' < /proc/device-tree/serial-number; } 2>/dev/null || true)
  [ -n "$s" ] || s=$(cut -c1-16 /etc/machine-id 2>/dev/null || true)
  echo "${s:-0000000000000001}"
}

up() {
  modprobe libcomposite
  [ -d /sys/kernel/config/usb_gadget ] || mount -t configfs none /sys/kernel/config
  if [ -d "$G" ] && [ -n "$(cat "$G/UDC" 2>/dev/null || true)" ]; then echo "meganet-sdr gadget: already up"; return 0; fi
  mkdir -p "$G"
  cd "$G"
  echo 0x1d6b > idVendor          # Linux Foundation
  echo 0x0104 > idProduct         # Multifunction Composite Gadget
  echo 0x0100 > bcdDevice
  echo 0x0200 > bcdUSB
  # Miscellaneous / Common Class / Interface Association: Windows reads the ACM
  # function's interface association and loads its own usbser.sys for it.
  echo 0xEF > bDeviceClass
  echo 0x02 > bDeviceSubClass
  echo 0x01 > bDeviceProtocol
  mkdir -p strings/0x409
  serial > strings/0x409/serialnumber
  echo "MegaNet" > strings/0x409/manufacturer
  echo "MegaNet SDR Pi" > strings/0x409/product
  mkdir -p configs/c.1/strings/0x409
  echo "Serial" > configs/c.1/strings/0x409/configuration
  echo 500 > configs/c.1/MaxPower
  mkdir -p functions/acm.usb0
  [ -e configs/c.1/acm.usb0 ] || ln -s functions/acm.usb0 configs/c.1/
  udc=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    udc=$(ls /sys/class/udc 2>/dev/null | head -n 1)
    [ -n "$udc" ] && break
    sleep 0.5
  done
  if [ -z "$udc" ]; then
    echo "meganet-sdr gadget: no USB device controller. Is dtoverlay=dwc2,dr_mode=peripheral in config.txt, and has the Pi been restarted since?" >&2
    exit 1
  fi
  echo "$udc" > UDC
  echo "meganet-sdr gadget: up on $udc - the PC sees a USB serial device (a COM port)"
}

down() {
  [ -d "$G" ] || return 0
  cd "$G"
  echo "" > UDC 2>/dev/null || true
  rm -f configs/c.1/acm.usb0
  rmdir configs/c.1/strings/0x409 configs/c.1 functions/acm.usb0 strings/0x409 2>/dev/null || true
  cd /
  rmdir "$G" 2>/dev/null || true
  echo "meganet-sdr gadget: down"
}

status() {
  if [ -d "$G" ] && [ -n "$(cat "$G/UDC" 2>/dev/null || true)" ]; then
    echo "meganet-sdr gadget: up on $(cat "$G/UDC"); /dev/ttyGS0 $( [ -e /dev/ttyGS0 ] && echo present || echo missing )"
  else
    echo "meganet-sdr gadget: down"
  fi
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
