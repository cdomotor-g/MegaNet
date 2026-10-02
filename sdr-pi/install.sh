#!/usr/bin/env bash
# MegaNet — sdr-pi/install.sh
#
#   Sets a Raspberry Pi up as MegaNet's SDR receiver (docs/sdr-pi.md): Node and
#   the usb package; a udev rule so the service may open the stick; the DVB-T
#   TV driver kept off it; the serial link to the PC — the USB-C port as a USB
#   serial device on a Pi 4 or 5, the GPIO UART (for a USB-serial cable) on
#   anything else; and meganet-sdr.service, which runs relay.js from boot.
#
#   On the Pi, with its network up:
#     curl -fsSL https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/sdr-pi/install.sh | sudo bash
#   or from a copy of the repository:
#     sudo bash sdr-pi/install.sh
#
#   --link usb|uart|both|none  how the PC reaches it (default: usb on a Pi 4 or 5, uart otherwise)
#   --tcp PORT                 also listen on TCP, for PuTTY over a network (Raw or Telnet)
#   --dir PATH                 where the repository goes (default /opt/meganet)
#   --update                   fetch the latest MegaNet and restart the service
#   --uninstall                take everything this added off again (the repository stays)
#   --dry-run                  say what it would do and change nothing
#   --model "Raspberry Pi 4…"  (testing) act as if on this model

set -euo pipefail

REPO_URL="https://github.com/cdomotor-g/MegaNet.git"
DIR=/opt/meganet
LINK=auto
TCP=""
MODE=install
DRY=0
MODEL=""
DIR_SET=0
SVC_USER=meganet-sdr
UNIT=/etc/systemd/system/meganet-sdr.service
GADGET_UNIT=/etc/systemd/system/meganet-sdr-gadget.service
UDEV=/etc/udev/rules.d/60-meganet-rtlsdr.rules
BLACKLIST=/etc/modprobe.d/meganet-rtlsdr-blacklist.conf
MARK_BEGIN="# >>> MegaNet SDR Pi (sdr-pi/install.sh)"
MARK_END="# <<< MegaNet SDR Pi"
REBOOT=0

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# A command, or in --dry-run what the command would be.
run() {
  if [ "$DRY" = 1 ]; then printf '    would run: %s\n' "$*"; else "$@"; fi
}
# A file's contents from stdin, or in --dry-run the contents it would get.
put() {
  local file=$1 body
  body=$(cat)
  if [ "$DRY" = 1 ]; then printf '    would write %s:\n%s\n' "$file" "$(printf '%s\n' "$body" | sed 's/^/      | /')"; return; fi
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$body" > "$file"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --link) LINK=${2:?--link needs usb, uart, both or none}; shift 2 ;;
    --tcp) TCP=${2:?--tcp needs a port}; shift 2 ;;
    --dir) DIR=${2:?--dir needs a path}; DIR_SET=1; shift 2 ;;
    --update) MODE=update; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --dry-run) DRY=1; shift ;;
    --model) MODEL=${2:?--model needs a name}; shift 2 ;;
    -h|--help)
      if [ -f "${BASH_SOURCE[0]:-}" ]; then sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      else echo "See https://github.com/cdomotor-g/MegaNet/blob/main/sdr-pi/install.sh"; fi
      exit 0 ;;
    *) die "Unknown option $1 (--help lists them)" ;;
  esac
done

case "$LINK" in auto|usb|uart|both|none) ;; *) die "--link is usb, uart, both or none" ;; esac
if [ -n "$TCP" ] && ! [[ "$TCP" =~ ^[0-9]+$ ]]; then die "--tcp needs a port number"; fi
if [ "$DRY" = 0 ] && [ "$(id -u)" -ne 0 ]; then die "Run it as root: sudo bash $0 $*"; fi

[ -n "$MODEL" ] || MODEL=$( { tr -d '\000' < /proc/device-tree/model; } 2>/dev/null || echo "not a Raspberry Pi")
BOOT=/boot/firmware
[ -d "$BOOT" ] || BOOT=/boot
CONFIG=$BOOT/config.txt
CMDLINE=$BOOT/cmdline.txt

# Where this script sits in a copy of the repository, that copy is used as it
# is; piped from curl, it has no copy, and makes one.
HERE=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  [ -f "$HERE/rtlsdr.js" ] && [ -f "$HERE/sdr-pi/relay.js" ] || HERE=""
fi
# --dir given: that place, fetched afresh, even when run from a copy.
[ "$DIR_SET" = 1 ] && HERE=""
[ -z "$HERE" ] || DIR=$HERE

strip_block() {     # our block out of config.txt, for re-installing and uninstalling
  [ -f "$CONFIG" ] || return 0
  if grep -qF "$MARK_BEGIN" "$CONFIG"; then
    run sed -i "/^# >>> MegaNet SDR Pi/,/^# <<< MegaNet SDR Pi/d" "$CONFIG"
  fi
}

uninstall() {
  say "Taking MegaNet SDR Pi off this computer"
  run systemctl disable --now meganet-sdr.service 2>/dev/null || true
  run systemctl disable --now meganet-sdr-gadget.service 2>/dev/null || true
  run rm -f "$UNIT" "$GADGET_UNIT" "$UDEV" "$BLACKLIST"
  run systemctl daemon-reload
  strip_block
  if id "$SVC_USER" >/dev/null 2>&1; then run userdel "$SVC_USER" || true; fi
  say "Done. $DIR is left where it is - delete it if you want it gone. Restart the Pi to put the USB-C port back as it was."
  exit 0
}
[ "$MODE" = uninstall ] && uninstall

say "MegaNet SDR Pi on: $MODEL"
case "$MODEL" in
  *"Pi 4"*|*"Pi 5"*|*"Compute Module 4"*|*"Compute Module 5"*) AUTO=usb ;;
  *"Pi Zero 2"*|*"Pi 3"*) AUTO=uart ;;
  *"Pi Zero"*|*"Pi Model"*|*"Pi 2"*) AUTO=uart; warn "A $MODEL is too slow for the decoder to keep up - a Pi Zero 2 W, 3, 4 or 5 is." ;;
  *) AUTO=none; warn "Not a Raspberry Pi, as far as this can tell: no serial link is set up. Give --tcp PORT to reach it over the network, or run relay.js --serial yourself." ;;
esac
[ "$LINK" = auto ] && LINK=$AUTO
say "Link to the PC: $LINK$( [ -n "$TCP" ] && echo " and TCP port $TCP")"

# ── Node, npm, git ──────────────────────────────────────────────────────────────
need=()
command -v node >/dev/null 2>&1 || need+=(nodejs)
command -v npm  >/dev/null 2>&1 || need+=(npm)
command -v git  >/dev/null 2>&1 || need+=(git)
if [ ${#need[@]} -gt 0 ]; then
  say "Installing ${need[*]}"
  run apt-get update
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${need[@]}"
fi
if [ "$DRY" = 0 ]; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  [ "$NODE_MAJOR" -ge 16 ] || die "Node $NODE_MAJOR is too old (16 or later). Raspberry Pi OS Bookworm's own is 18."
fi
NODE_BIN=$(command -v node || echo /usr/bin/node)

# ── MegaNet ──────────────────────────────────────────────────────────────────────
# Only what the Pi needs: the relay, the driver, the decoder, the protocol, the
# station names. The rest of the repository (maps, data) stays on GitHub.
if [ -n "$HERE" ]; then
  say "Using the copy of MegaNet at $DIR"
  [ "$MODE" = update ] && run git -C "$DIR" pull --ff-only
elif [ -d "$DIR/.git" ]; then
  say "Updating MegaNet in $DIR"
  run git -C "$DIR" pull --ff-only
else
  say "Fetching MegaNet into $DIR"
  run git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$DIR"
  run git -C "$DIR" sparse-checkout set --no-cone /sdr-pi/ /sdr-pi.js /rtlsdr.js /alert-dsp.js /quansheng.js /stations.json /LICENSE
fi
say "Installing the usb package"
run bash -c "cd '$DIR/sdr-pi' && npm install --omit=dev --no-audit --no-fund"

if [ "$MODE" = update ]; then
  run systemctl restart meganet-sdr.service
  say "Updated and restarted. journalctl -u meganet-sdr -f shows what it is doing."
  exit 0
fi

# ── the service's user, and the stick ──────────────────────────────────────────
if ! id "$SVC_USER" >/dev/null 2>&1; then
  say "Adding the system user $SVC_USER"
  run useradd --system --user-group --no-create-home --shell /usr/sbin/nologin --groups dialout,plugdev "$SVC_USER"
else
  run usermod -a -G dialout,plugdev "$SVC_USER"
fi
# A copy of the repository in someone's home directory is often closed to
# other users (Bookworm makes homes private), and the service runs as its own.
if [ "$DRY" = 0 ] && ! runuser -u "$SVC_USER" -- test -r "$DIR/sdr-pi/relay.js"; then
  die "$SVC_USER cannot read $DIR. Install with the curl line instead (it puts MegaNet in /opt/meganet), or: sudo bash $0 --dir /opt/meganet"
fi

say "Letting $SVC_USER open RTL-SDR sticks (udev)"
put "$UDEV" <<'EOF'
# MegaNet SDR Pi (sdr-pi/install.sh): RTL2832U sticks open to the plugdev group,
# which the meganet-sdr service's user is in. The same two IDs rtlsdr.js asks for.
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0660"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0660"
EOF
run udevadm control --reload-rules
run udevadm trigger --subsystem-match=usb

say "Keeping the DVB-T TV driver off the stick"
put "$BLACKLIST" <<'EOF'
# MegaNet SDR Pi (sdr-pi/install.sh): the kernel's DVB-T driver would claim the
# stick as a TV tuner on plug-in. relay.js drives it itself.
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2832_sdr
blacklist rtl2830
EOF
run modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

# ── the link to the PC ─────────────────────────────────────────────────────────
strip_block
block=""
if [ "$LINK" = usb ] || [ "$LINK" = both ]; then
  if [ -f "$CONFIG" ] && grep -Eq '^[[:space:]]*dtoverlay=dwc2' "$CONFIG"; then
    warn "$CONFIG already has a dtoverlay=dwc2 line - left as it is. The USB-C port needs it to say dr_mode=peripheral."
  else
    block+=$'dtoverlay=dwc2,dr_mode=peripheral\n'
  fi
  say "The USB-C port as a USB serial device (meganet-sdr-gadget.service)"
  run chmod +x "$DIR/sdr-pi/usb-gadget.sh"
  put "$GADGET_UNIT" <<EOF
[Unit]
Description=MegaNet SDR Pi - the USB-C port as a USB serial device for PuTTY
Documentation=https://github.com/cdomotor-g/MegaNet/blob/main/docs/sdr-pi.md
After=sys-kernel-config.mount
Before=meganet-sdr.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$DIR/sdr-pi/usb-gadget.sh up
ExecStop=$DIR/sdr-pi/usb-gadget.sh down

[Install]
WantedBy=multi-user.target
EOF
  run systemctl daemon-reload
  run systemctl enable meganet-sdr-gadget.service
  REBOOT=1
fi
if [ "$LINK" = uart ] || [ "$LINK" = both ]; then
  say "The GPIO UART for a USB-serial cable (pins 8 and 10, ground on 6), its login console moved off"
  if command -v raspi-config >/dev/null 2>&1; then
    run raspi-config nonint do_serial_cons 1
    run raspi-config nonint do_serial_hw 0
  else
    block+=$'enable_uart=1\n'
    [ -f "$CMDLINE" ] && run sed -i -E 's/console=(serial0|ttyS0|ttyAMA0),[0-9]+ ?//' "$CMDLINE"
    run systemctl disable --now serial-getty@ttyS0.service serial-getty@ttyAMA0.service 2>/dev/null || true
  fi
  REBOOT=1
fi
if [ -n "$block" ]; then
  text=$(printf '%s\n[all]\n%s%s' "$MARK_BEGIN" "$block" "$MARK_END")
  if [ "$DRY" = 1 ]; then
    printf '    would add to %s:\n%s\n' "$CONFIG" "$(printf '%s\n' "$text" | sed 's/^/      | /')"
  elif [ -f "$CONFIG" ]; then
    say "Adding to $CONFIG: $(printf '%s' "$block" | tr '\n' ' ')"
    printf '%s\n' "$text" >> "$CONFIG"
  else
    warn "No $CONFIG here - add these lines to the Pi's config.txt yourself: $(printf '%s' "$block" | tr '\n' ' ')"
  fi
fi

# ── the service ─────────────────────────────────────────────────────────────────
ARGS="--serial auto"
[ -n "$TCP" ] && ARGS="$ARGS --tcp $TCP"
[ "$LINK" = none ] && [ -z "$TCP" ] && warn "No link and no --tcp: the service will run with nowhere to talk. Re-run with --link or --tcp."
say "The service (meganet-sdr.service), from boot"
put "$UNIT" <<EOF
[Unit]
Description=MegaNet SDR Pi - an RTL-SDR decoding ALERT, on a serial port for PuTTY
Documentation=https://github.com/cdomotor-g/MegaNet/blob/main/docs/sdr-pi.md
After=network.target meganet-sdr-gadget.service

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
SupplementaryGroups=dialout plugdev
StateDirectory=meganet-sdr
ExecStart=$NODE_BIN $DIR/sdr-pi/relay.js $ARGS
Restart=always
RestartSec=3
Nice=-5

[Install]
WantedBy=multi-user.target
EOF
run systemctl daemon-reload
run systemctl enable meganet-sdr.service
run systemctl restart meganet-sdr.service

echo
say "Installed."
if [ "$REBOOT" = 1 ]; then
  echo "    Restart the Pi once (sudo reboot) for the serial link to come up."
fi
case "$LINK" in
  usb|both) echo "    Then plug its USB-C port into the PC (a USB-C port on a laptop gives it the most power)." ;;
esac
case "$LINK" in
  uart|both) echo "    Then wire a 3.3 V USB-serial cable: its RX to GPIO 14 (pin 8), its TX to GPIO 15 (pin 10), ground to pin 6." ;;
esac
echo "    On the PC, PuTTY: Connection type Serial, the new COM port, speed 115200, and"
echo "    Session > Logging > All session output. Drop the log on MegaNet's Serial Monitor."
echo "    Here: journalctl -u meganet-sdr -f shows what the Pi is doing."
