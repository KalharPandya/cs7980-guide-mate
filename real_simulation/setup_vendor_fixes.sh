#!/usr/bin/env bash
# GuideMate real_simulation — apply the scriptable /opt vendor fixes (needs sudo).
# Idempotent: each edit is detected and skipped if already present; originals are backed up.
# See SETUP.md for the full list (including the two MANUAL steps this does NOT do:
# the OAK-D camera disable, and WSL NAT networking).
#
#   sudo python3 real_simulation/setup_vendor_fixes.sh     # (this file is run via bash, but
#   sudo bash   real_simulation/setup_vendor_fixes.sh      #  either works)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" != "0" ]; then
  echo "This edits files under /opt/ros — re-run with sudo:"
  echo "   sudo bash $DIR/setup_vendor_fixes.sh"
  exit 1
fi

echo "=== [1/3] driving fix: safety_override='full' + reflexes_enabled=False ==="
python3 - <<'PY'
import os
p = "/opt/ros/jazzy/share/irobot_create_common_bringup/launch/create3_nodes.launch.py"
if not os.path.exists(p):
    print("  [WARN] file not found — is turtlebot4/create3 installed?"); raise SystemExit
s = open(p).read()
if "'safety_override': 'full'" in s:
    print("  [skip] already applied")
elif "'safety_override': 'backup_only'" in s:
    bak = p + ".stock.bak"
    if not os.path.exists(bak):
        open(bak, "w").write(s)
    s = s.replace("'safety_override': 'backup_only'", "'safety_override': 'full'")
    if "reflexes_enabled" not in s:
        # add the reflexes line right after the safety_override line, matching its indent
        import re
        s = re.sub(r"([ \t]*)'safety_override': 'full',",
                   r"\1'safety_override': 'full',\n\1'reflexes_enabled': False,", s, count=1)
    open(p, "w").write(s)
    print("  [applied] safety_override -> full, reflexes_enabled -> False (backup: .stock.bak)")
else:
    print("  [WARN] 'safety_override' not found in the expected form — apply manually (see SETUP.md #1)")
PY

echo "=== [2/3] cmd_vel_timeout -> 5.0 ==="
python3 "$DIR/set_cmdvel_timeout.py" 5.0

echo "=== [3/3] OAK-D camera disable is MANUAL (multi-line xacro edit) ==="
CAM=/opt/ros/jazzy/share/turtlebot4_description/urdf/sensors/oakd.urdf.xacro
if grep -q "rgbd_camera sensor DISABLED\|<!--\s*$" "$CAM" 2>/dev/null && ! grep -qE "^\s*<sensor name=\"rgbd_camera\"" "$CAM" 2>/dev/null; then
  echo "  [ok] camera sensor appears already commented out"
else
  echo "  [ACTION NEEDED] comment out the <sensor name=\"rgbd_camera\"> block in:"
  echo "                  $CAM   (see SETUP.md #1, item 3)"
fi

echo
echo "Done. Remaining manual steps (once per machine): OAK-D camera (above) + WSL NAT (SETUP.md #3)."
echo "Relaunch any running sim for changes to take effect."
