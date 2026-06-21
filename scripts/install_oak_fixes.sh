#!/usr/bin/env bash
# install_oak_fixes.sh — apply the permanent OAK-D-LITE reliability fixes on robot 468.
#
#   sudo bash scripts/install_oak_fixes.sh
#
# Idempotent. Backs up cmdline.txt. Does NOT reboot and does NOT enable the watchdog
# (that needs a deployment decision — see scripts/README.md). Review before running.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo bash $0"; exit 1; }
WS=/home/ubuntu/cs7980-guide-mate

echo "== 1/4  Persist usbfs_memory_mb=256 + usbcore.autosuspend=-1 (the bring-up-crash fix) =="
F=/boot/firmware/cmdline.txt
if grep -q usbfs_memory_mb "$F"; then
  echo "   cmdline.txt already patched"
else
  cp -a "$F" "${F}.bak-$(date +%Y%m%d-%H%M%S)"
  new="$(cat "$F") usbcore.usbfs_memory_mb=256 usbcore.autosuspend=-1"
  printf '%s\n' "$new" > "${F}.tmp"
  if [ "$(wc -l < "${F}.tmp")" = 1 ] && grep -q 'root=' "${F}.tmp"; then
    mv "${F}.tmp" "$F"; echo "   patched (backup saved); effective on next reboot"
  else
    rm -f "${F}.tmp"; echo "   SANITY CHECK FAILED — not modified"; exit 1
  fi
fi
echo 256 > /sys/module/usbcore/parameters/usbfs_memory_mb
echo "   runtime usbfs_memory_mb = $(cat /sys/module/usbcore/parameters/usbfs_memory_mb)"

echo "== 2/4  Passwordless sudo for the watchdog's reset primitives =="
cat > /etc/sudoers.d/oak-watchdog <<'EOF'
ubuntu ALL=(root) NOPASSWD: /usr/bin/usbreset, /usr/bin/tee /sys/module/usbcore/parameters/usbfs_memory_mb
EOF
chmod 440 /etc/sudoers.d/oak-watchdog
visudo -cf /etc/sudoers.d/oak-watchdog >/dev/null && echo "   installed /etc/sudoers.d/oak-watchdog"

echo "== 3/4  Install the watchdog systemd unit (NOT enabled) =="
install -m644 "$WS/scripts/oak-watchdog.service" /etc/systemd/system/oak-watchdog.service
systemctl daemon-reload
echo "   installed /etc/systemd/system/oak-watchdog.service"

echo "== 4/4  Done =="
cat <<EOF

Next steps (your call):
  * Reboot when convenient to lock in the cmdline change (runtime usbfs is already 256).
  * To run the supervised standalone camera + watchdog:
       sudo systemctl enable --now oak-watchdog.service
    FIRST disable the oakd node inside turtlebot4.service (or you'll have two drivers
    fighting for the one device). See scripts/README.md "Deployment".
EOF
