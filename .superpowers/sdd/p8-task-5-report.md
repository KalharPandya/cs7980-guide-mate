# P8-T5 report — `sim/launch_sim.sh`

## What was done

- `sim/launch_sim.sh` (new, `chmod +x`): brings up the TB4 Ignition sim under the
  `turtlebotsim` identity with motion armed but still shadow-gated, then runs the
  bridge in-process (foreground, not `exec`'d, so the `EXIT` trap can still kill the
  sim once the bridge exits).
- `src/guide_mate_bridge/tests/test_installer_guard.py` (new): the brief-mandated
  simple installer-guard smoke test (installer text never assigns
  `GUIDEMATE_ENABLE_MOTION=1/true` outside a comment; documents the ban and mentions
  "sim"). Passed immediately — P8-T4 already added the ban comment to
  `install_bridge_on_pi.sh`, and P8-T4's own `test_install_motion_ban.py` already
  covers the rendered-systemd-unit path exhaustively. No changes to
  `install_bridge_on_pi.sh` were needed.
- `src/guide_mate_bridge/tests/test_launch_sim.py` (new): side-effect-free smoke
  tests for the launch script — `bash -n` syntax check, sim-identity-only assertions
  (never references robot 468 except in an explanatory comment), motion-armed +
  shadow-gated env assertions, `ROS_DISCOVERY_SERVER` unset + daemon-restart
  assertion, empty-namespace assertion, and a check that the bridge process isn't
  `exec`'d (so the sim-cleanup trap survives).

All 9 new tests pass; full `guide_mate_bridge` suite: **102 passed**.

## Exact command to run it

```bash
cd ~/cs7980-guide-mate
./sim/launch_sim.sh          # headless (default)
./sim/launch_sim.sh --gui    # windowed, DISPLAY=:0
```

Test-only (no sim/Gazebo launched):
```bash
.venv/bin/python -m pytest src/guide_mate_bridge/tests/test_launch_sim.py src/guide_mate_bridge/tests/test_installer_guard.py -q
```

## Env the script sets

Sourced first: `/opt/ros/humble/setup.bash`, the repo's `install/setup.bash` (if
built), and `sim/sim_facts.env` (Task 2's verified topic/action names).

Sim-gotcha handling before launch:
- `unset ROS_DISCOVERY_SERVER` (the login profile sets it to the Pi's discovery
  server, which silently breaks sim DDS discovery) + `ros2 daemon stop`/`start` so
  the daemon forgets the cached value.
- `DISPLAY=${DISPLAY:-:0}` for `--gui` (offscreen Qt segfaults; this box has a real
  display).

Sim launch: `ros2 launch turtlebot4_ignition_bringup turtlebot4_ignition.launch.py
slam:=false nav2:=false localization:=false rviz:=false model:=standard
headless:=$HEADLESS`, backgrounded, polling `ros2 topic list` for `/odom` (240 s
deadline — sim_facts.env: cold cache 120–240 s) and checking the sim PID is still
alive each iteration (fails fast on a dead process instead of timing out blind).

Bridge env exported for the sim run:
```
GUIDEMATE_ROBOT_ID=turtlebotsim
GUIDEMATE_THING_NAME=Turtlebot-Sim
GUIDEMATE_IOT_ENDPOINT=<discovered via aws iot describe-endpoint>
GUIDEMATE_CERT=~/.aws/guidemate-sim.cert.pem
GUIDEMATE_KEY=~/.aws/guidemate-sim.key.pem
GUIDEMATE_CMD_VEL_TOPIC=/cmd_vel
GUIDEMATE_UNDOCK_ACTION=/undock
GUIDEMATE_DOCK_ACTION=/dock
GUIDEMATE_BATTERY_TOPIC=battery_state   # relative — see adaptation below
GUIDEMATE_DOCK_TOPIC=dock_status        # relative — see adaptation below
GUIDEMATE_ROS_NAMESPACE=""              # REQUIRED — see adaptation below
GUIDEMATE_ROS=1
GUIDEMATE_SHADOW=1                      # REQUIRED — see adaptation below
GUIDEMATE_ENABLE_MOTION=1               # safe only because robot_id=turtlebotsim
GUIDEMATE_DRY_RUN=0                     # env dry-run off; shadow's own lock still holds
```

Then runs `"$REPO/.venv/bin/python" -m guide_mate_bridge.bridge` in the foreground
under a `trap cleanup EXIT` that kills the sim by PID (never `pkill -f`, per
CLAUDE.md gotcha #6).

## Expected result of a real run (not executed here — no Gazebo/network in this
sandbox; deferred to Task 6 per the brief)

`bridge connected` should appear in the log. `MOTION ENABLED` should **NOT** appear:
the `Turtlebot-Sim` classic shadow ships default-deny (`motion_enabled:false,
dry_run:true`, per `access-ground-truth.md` §"Sim identity"), so
`resolve_motion_enabled()` in `bridge.py` returns `False` even with
`GUIDEMATE_ENABLE_MOTION=1` armed, and the bridge never calls `_build_motion_sinks`.
Every command still acks (as `simulated: true`), proving default-deny holds with the
motion env armed — Task 6's job is to flip the shadow's `desired.motion_enabled=true`
+ `desired.dry_run=false` and observe the sim robot actually move.

## How a human runs T6 motion validation next

1. `./sim/launch_sim.sh --gui` (or headless) and confirm the log shows `bridge
   connected` and no `MOTION ENABLED`.
2. Flip the `Turtlebot-Sim` shadow desired state to arm motion, e.g.:
   ```bash
   aws iot-data update-thing-shadow --thing-name Turtlebot-Sim \
     --cli-binary-format raw-in-base64-out \
     --payload '{"state":{"desired":{"motion_enabled":true,"dry_run":false}}}' /tmp/shadow_out.json
   ```
3. Confirm the bridge log now logs `MOTION ENABLED` (cmd_vel publisher + dock/undock
   action clients constructed) and that `reported` converges (`motion_enabled: true`,
   `dry_run: false`, docked state tracks `/dock_status`).
4. Publish a `guidemate/turtlebotsim/cmd` command (undock is the only motion command
   permitted while docked — the dock-guard exemption matrix) and confirm the sim
   robot in Gazebo actually undocks/moves.
5. Re-lock the shadow (`motion_enabled:false, dry_run:true`) afterward so the sim
   identity returns to the same default-deny posture as robot 468.

## Brief-vs-reality adaptations

The brief's Step 5 draft predates the merged P8-T4 motion code and had several stale
details corrected against the real `bridge.py`/`safety.py`/`telemetry.py`:

1. **`GUIDEMATE_THING` → `GUIDEMATE_THING_NAME`.** `bridge.main()` reads
   `GUIDEMATE_THING_NAME` (default `Turtlebot-468`); the brief's var name was wrong
   and would have silently fallen back to the 468 default (harmless here since the
   thing name only affects the shadow topic name, but still wrong).
2. **Added `GUIDEMATE_SHADOW=1` (missing from the brief entirely).**
   `SafetyState` defaults `motion_enabled=False` and `shadow_dry_run=True` and only
   `ShadowSync` (opt-in via `GUIDEMATE_SHADOW`) can ever change them. Without this,
   the sim shadow could never be reconciled or observed — Task 6 flipping the AWS
   shadow desired state would have no effect on the running bridge at all. Verified
   safe: `access-ground-truth.md` confirms the sim cert/policy is authorized for
   `$aws/things/Turtlebot-Sim/shadow/*`.
3. **Added `GUIDEMATE_ROS_NAMESPACE=""` (missing from the brief entirely) +
   `GUIDEMATE_BATTERY_TOPIC`/`GUIDEMATE_DOCK_TOPIC`.** `Telemetry`'s ROS node
   namespace defaults to `GUIDEMATE_ROBOT_ID` (`turtlebotsim`) when
   `GUIDEMATE_ROS_NAMESPACE` is unset, and its battery/dock subscriptions are
   *relative* topic names resolved under that namespace. The sim graph is
   UN-namespaced (root `/battery_state`, `/dock_status`), so left at the default the
   bridge would subscribe to nonexistent `/turtlebotsim/battery_state` +
   `/turtlebotsim/dock_status`, dock state would stay permanently unknown, and the
   dock-guard exemption matrix would never see `docked=False` to unlock non-exempt
   motion commands post-undock. `GUIDEMATE_CMD_VEL_TOPIC`/`UNDOCK_ACTION`/
   `DOCK_ACTION` did NOT need this fix — those are absolute (`/cmd_vel`-style) topic
   strings passed straight to `create_publisher`/`ActionClient`, independent of node
   namespace.
4. **`exec` removed before the bridge invocation.** The brief's draft used `exec
   "$REPO/.venv/bin/python" -m guide_mate_bridge.bridge` as the last line under a
   `trap ... EXIT`. `exec` replaces the shell process image, which would also
   discard its installed EXIT trap, orphaning the backgrounded Gazebo process when
   the bridge exits. Fixed by running the bridge as a normal (non-`exec`'d)
   foreground command so the trap fires on the script's own exit.
5. **Added a sim-process liveness check inside the odom-wait poll loop** (`kill -0
   "$SIM_PID"`) so a sim crash during bring-up fails fast with the log path instead
   of silently waiting out the full 240 s deadline.
6. Pulled the launch package/file/args and the odom-wait deadline straight from
   `sim/sim_facts.env` (`SIM_LAUNCH_PKG`, `SIM_LAUNCH_FILE`, `SIM_LAUNCH_ARGS`,
   `SIM_ODOM_TOPIC`, `SIM_BRINGUP_SECONDS_FIRST_RUN`) rather than hardcoding them, so
   the script stays correct if those verified facts are ever revised.

Everything else (cert paths, cmd_vel/dock/undock topic+action names, headless
default with `--gui` opt-in, PID-based kill, `aws iot describe-endpoint` discovery)
matched the brief as written.
