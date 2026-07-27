#!/usr/bin/env python3
"""GuideMate — raise the Create 3 diffdrive_controller cmd_vel_timeout.

WHY: under low RTF (e.g. with RViz running) the Nav2 -> controller pipeline latency exceeds
the default 0.5 s cmd_vel_timeout in sim-time, so the diffdrive_controller rejects every
velocity command as "older than current time ... exceeds the allowed timeout" and the robot
never moves. Raising the timeout lets it accept commands that are stale only because sim
time is running slow. Harmless for the demo (Nav2 publishes continuously while navigating
and zeros on arrival).

Edits the vendor config in /opt (needs sudo). Backs up once to control.yaml.cmdvel.bak.
    sudo python3 real_simulation/set_cmdvel_timeout.py            # set to 5.0
    sudo python3 real_simulation/set_cmdvel_timeout.py 10         # set to a custom value
    sudo python3 real_simulation/set_cmdvel_timeout.py --restore  # revert to backup
Relaunch the sim afterward for it to take effect.
"""
import sys, os, re

PATH = "/opt/ros/jazzy/share/irobot_create_control/config/control.yaml"
BAK = PATH + ".cmdvel.bak"


def main():
    if not os.path.exists(PATH):
        print(f"missing: {PATH}"); return
    if "--restore" in sys.argv:
        if os.path.exists(BAK):
            open(PATH, "w").write(open(BAK).read()); print(f"[restored] {PATH}")
        else:
            print("no backup to restore")
        return
    val = "5.0"
    for a in sys.argv[1:]:
        if re.fullmatch(r"[0-9.]+", a):
            val = a
    s = open(PATH).read()
    if not os.path.exists(BAK):
        open(BAK, "w").write(s)
    new, n = re.subn(r"cmd_vel_timeout:\s*[0-9.]+", f"cmd_vel_timeout: {val}", s)
    if n == 0:
        print("cmd_vel_timeout not found — is this the right file?"); return
    open(PATH, "w").write(new)
    print(f"[set] cmd_vel_timeout: {val}  ({n} occurrence). Relaunch the sim to apply.")


if __name__ == "__main__":
    main()
