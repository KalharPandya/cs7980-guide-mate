#!/usr/bin/env python3
"""GuideMate — strip create3 ray sensors (cliff + IR intensity) to lidar-only.

WHY: the two-robot partitioned sim is CPU-bound under mandatory software rendering.
The 4 cliff + 7 IR-intensity gz RAY sensors per robot (22 across both robots) are the
remaining raycasting cost after the OAK-D camera was already disabled. AMCL localizes on
the rplidar and odom comes from the wheel controller, so these are safe to remove for the
nav demo. The rplidar is left untouched.

Edits the ACTIVE vendor xacros in /opt (needs sudo). Idempotent. Backs each file up to
<file>.prestrip.bak on first run. Reverse with:  sudo python3 strip_sensors.py --restore

    sudo python3 real_simulation/strip_sensors.py            # strip
    sudo python3 real_simulation/strip_sensors.py --restore  # undo
"""
import sys, os

CD = "/opt/ros/jazzy/share/irobot_create_description/urdf/sensors"
MARK_OPEN = "<!-- GuideMate lidar-only: gz ray_sensor DISABLED (two-robot perf). Undo: strip_sensors.py --restore\n"
MARK_CLOSE = "\nGuideMate end -->"

TARGETS = [
    (f"{CD}/cliff_sensor.urdf.xacro", "<xacro:ray_sensor", "</xacro:ray_sensor>"),
    (f"{CD}/ir_intensity.urdf.xacro", "<xacro:ray_sensor", "</xacro:ray_sensor>"),
]


def strip(path, start_tag, end_tag):
    with open(path) as f:
        s = f.read()
    if MARK_OPEN in s:
        print(f"  [skip] already stripped: {path}")
        return
    i = s.find(start_tag)
    j = s.find(end_tag)
    if i == -1 or j == -1:
        print(f"  [WARN] tags not found, untouched: {path}")
        return
    j += len(end_tag)
    if not os.path.exists(path + ".prestrip.bak"):
        with open(path + ".prestrip.bak", "w") as f:
            f.write(s)
    new = s[:i] + MARK_OPEN + s[i:j] + MARK_CLOSE + s[j:]
    with open(path, "w") as f:
        f.write(new)
    print(f"  [stripped] {path}")


def restore(path):
    bak = path + ".prestrip.bak"
    if os.path.exists(bak):
        with open(bak) as f:
            s = f.read()
        with open(path, "w") as f:
            f.write(s)
        print(f"  [restored] {path}")
    else:
        print(f"  [WARN] no .prestrip.bak for {path}")


def main():
    restore_mode = "--restore" in sys.argv
    print("RESTORE" if restore_mode else "STRIP", "create3 ray sensors (cliff + IR)")
    for path, st, en in TARGETS:
        if not os.path.exists(path):
            print(f"  [WARN] missing: {path}"); continue
        restore(path) if restore_mode else strip(path, st, en)
    print("Done. Relaunch the sims for changes to take effect.")


if __name__ == "__main__":
    main()
