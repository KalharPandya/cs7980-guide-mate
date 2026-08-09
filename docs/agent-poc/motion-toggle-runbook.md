# Runbook: arm / disarm supervised motion on robot 468

**TL;DR** — Robot 468 motion is default-deny in three independent places. A git change alone
never moves the robot; a git revert alone never stops it. To **arm** for a supervised on-robot
test you flip all three ON; to **disarm** you flip all three back. Only ever arm with a **human
observer physically at the robot + kill-switch in hand** (468 is normally docked and unobserved).

Validated end-to-end on 2026-07-07 (disarm) — this runbook is the exact sequence that was run.

## The three switches

| # | Switch | Where | Armed value | Safe (disarmed) value |
|---|--------|-------|-------------|-----------------------|
| 1 | Code escape-hatch | git: `src/guide_mate_bridge/guide_mate_bridge/bridge.py` (`assert_motion_identity_safe`, token `GUIDEMATE_SUPERVISED_468_MOTION == "observer-present"`) | commit **present** | **reverted** (default-deny, no escape hatch) |
| 2 | Pi systemd drop-in | Pi `/etc/systemd/system/guidemate-bridge.service.d/motion-supervised.conf` (**not** in git) | file present | file removed |
| 3 | AWS device shadow | classic shadow, thing `Turtlebot-468` | `{motion_enabled:true, dry_run:false}` | `{motion_enabled:false, dry_run:true}` |

Base unit default is `GUIDEMATE_DRY_RUN=1` (safe) — the drop-in is what overrides it to `0`.

## Access
- **Pi:** `ssh guidemate` (host = `turtlebot-van-468`; Pi user). The dev laptop (Alienware) is
  NOT the robot — the bridge is editable-installed there but not running.
- **AWS:** creds already present (assumed-role `guidemate-agent-role`, acct `852373397000`).
  Thing name is **`Turtlebot-468`** (capitalized); robot-id env is `turtlebot468` (lowercase).
- Bridge is editable-installed on the Pi, so `git pull` + `systemctl restart` = new code live.

---

## ARM (before a supervised test — observer must be present)

**1. Code escape-hatch** — restore the token opt-in in `bridge.py` (re-apply the reverted commit
   or re-add the `GUIDEMATE_SUPERVISED_468_MOTION == "observer-present"` branch), commit, push,
   then on the Pi `cd ~/cs7980-guide-mate && git pull`.

   **Variant (used 2026-07-08, keeps the repo default-deny):** patch the token branch into
   `bridge.py` as a **transient UNCOMMITTED edit directly on the Pi** (insert
   `if env.get("GUIDEMATE_SUPERVISED_468_MOTION") == "observer-present": return` before the
   `raise SystemExit` in `assert_motion_identity_safe`). Nothing armed lands in git; the Pi's
   `git status` shows the dirty file as the tell. Disarm then includes
   `git checkout -- src/guide_mate_bridge/guide_mate_bridge/bridge.py` on the Pi.

**2. Pi drop-in** — create `/etc/systemd/system/guidemate-bridge.service.d/motion-supervised.conf`:

```ini
[Service]
# TRANSIENT supervised on-robot motion test. REMOVE after the test.
Environment=GUIDEMATE_ENABLE_MOTION=1
Environment=GUIDEMATE_SUPERVISED_468_MOTION=observer-present
Environment=GUIDEMATE_DRY_RUN=0
# 468 is namespaced; sink defaults (/cmd_vel,/undock,/dock) are GLOBAL and miss the base.
Environment=GUIDEMATE_CMD_VEL_TOPIC=/turtlebot468/cmd_vel
Environment=GUIDEMATE_UNDOCK_ACTION=/turtlebot468/undock
Environment=GUIDEMATE_DOCK_ACTION=/turtlebot468/dock
```

then `sudo systemctl daemon-reload && sudo systemctl restart guidemate-bridge.service`.

**3. AWS shadow** — arm desired state:

```bash
aws iot-data update-thing-shadow --thing-name Turtlebot-468 \
  --payload '{"state":{"desired":{"motion_enabled":true,"dry_run":false,"max_speed":0.15}}}' \
  /dev/stdout
```

**Verify armed:**
```bash
ssh guidemate 'systemctl show guidemate-bridge.service -p Environment | tr " " "\n" \
  | grep -iE "MOTION|DRY_RUN"'   # expect ENABLE_MOTION=1, token, DRY_RUN=0
aws iot-data get-thing-shadow --thing-name Turtlebot-468 /dev/stdout | python3 -m json.tool
  # expect reported.motion_enabled:true, effective_dry_run:false
```

---

## DISARM (after the test — this is the safe resting state)

Do AWS **first** (a delta disarms the live bridge immediately), then the Pi.

**1. AWS shadow → locked:**
```bash
aws iot-data update-thing-shadow --thing-name Turtlebot-468 \
  --payload '{"state":{"desired":{"motion_enabled":false,"dry_run":true,"max_speed":0.15}}}' \
  /dev/stdout
```

**2. Pi — pull the revert, remove the drop-in, restart:**
```bash
ssh guidemate 'set -e
  cd ~/cs7980-guide-mate && git pull --ff-only          # gets the code revert (switch 1)
  sudo rm -f /etc/systemd/system/guidemate-bridge.service.d/motion-supervised.conf
  sudo systemctl daemon-reload
  sudo systemctl restart guidemate-bridge.service'
```

**3. Verify disarmed:**
```bash
ssh guidemate 'systemctl show guidemate-bridge.service -p Environment | tr " " "\n" \
  | grep -iE "MOTION|DRY_RUN"'    # expect ONLY DRY_RUN=1, no ENABLE_MOTION / no token
aws iot-data get-thing-shadow --thing-name Turtlebot-468 /dev/stdout | python3 -m json.tool
  # expect reported: motion_enabled:false, dry_run:true, effective_dry_run:true
```

## If dock/undock fail `action server unavailable` after ANY ROS restart
The bridge must be restarted **LAST** (a bridge older than discovery is a stale FastDDS
participant — this exact failure recurred twice on 2026-07-08):
```bash
ssh guidemate 'sudo systemctl restart discovery.service && sleep 3 && \
  sudo systemctl restart turtlebot4.service && sleep 5 && \
  sudo systemctl restart guidemate-bridge.service && \
  source /opt/ros/humble/setup.bash && ros2 daemon stop && ros2 daemon start'
```
Then check a heartbeat: if `gates.docked` is **null**, the dock telemetry didn't latch —
bounce `guidemate-bridge` once more after ~30 s (unknown dock state default-denies ALL
motion, not just docking). Findings: `2026-07-08-prod-motion-findings.md`.

## Notes / gotchas
- **Order for disarm matters:** lock the shadow before touching the Pi so no armed motion
  command can land during the restart window.
- Removing the drop-in is enough to disarm even if switch 1 (code) is still armed — with no
  `GUIDEMATE_SUPERVISED_468_MOTION` token the guard refuses. Pull the revert anyway to close the
  escape hatch fully.
- `telemetry-topics.conf` is a *separate* drop-in in the same `.d/` dir — leave it; only remove
  `motion-supervised.conf`.
- Never `pkill -f` the bridge (self-matches the shell) — use `systemctl`.
- Related: [access-ground-truth.md](access-ground-truth.md) (thing/policy/shadow IDs),
  Claude memory `motion-arming-lives-in-three-places`.
