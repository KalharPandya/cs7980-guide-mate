# No-motion full-stack bring-up (integration test)

How to bring up the **entire** mapping stack — camera → depth fusion (`scan_fused`) → SLAM →
Nav2 → `glass_guard` → `bfs_explorer` — on a **docked robot that must not move**, so the whole
pipeline can be exercised (including `bfs_explorer` sending real goals and Nav2 planning)
without driving anywhere.

## The no-motion guarantee is engineering, not monitoring
`bfs_explorer` is **goal-level only**: it sends a `NavigateToPose` goal and waits for the
result — it **never** publishes `cmd_vel`. All velocity comes from **Nav2**
(`controller_server` → `velocity_smoother` → `/<ns>/cmd_vel` → `create3_repub` → base; there is
**no** `twist_mux`). So motion is prevented by **zeroing Nav2's velocity output**, captured in
[`../../src/guide_mate_explorer/config/nav2_no_motion.yaml`](../../src/guide_mate_explorer/config/nav2_no_motion.yaml):

- `velocity_smoother` `max_velocity` / `min_velocity` = `[0,0,0]` — the **final gate**; clamps
  any controller output to zero.
- `FollowPath` `max_vel_x/y/theta`, `max_speed_xy`, `min_*` = `0.0`.
- `behavior_server` `max/min_rotational_vel`, `rotational_acc_lim` = `0.0`, and
  `behavior_plugins` cut to `[spin, wait]` — **BackUp / DriveOnHeading removed** so a stalled
  goal's recovery (which takes its speed from the BT goal, *not* the zeroed params) can't drive
  the robot backward off the dock.

`glass_guard`'s `reactive_backup` stays **false** (its only `cmd_vel` path). With these, the
base physically cannot move regardless of what the planner/explorer do. A stalled goal just
fails progress → aborts → `bfs_explorer` blacklists it → replans (harmless churn).

## Bring-up (run from the robot's own terminal — see the DDS note below)
```bash
source /opt/ros/humble/setup.bash && source ~/cs7980-guide-mate/install/setup.bash
NS=turtlebot468

# 1. Camera (depth-only, hardened) — skip if already up. See docs/camera.md / scripts/.
scripts/oak_bringup.sh

# 2. C++ shared-TF container: depth_lidar_fusion + glass_guard + bfs_explorer (one process)
ros2 launch guide_mate_perception guide_mate_container.launch.py namespace:=$NS

# 3. SLAM on the fused scan
ros2 launch turtlebot4_navigation slam.launch.py namespace:=$NS \
  params:=src/guide_mate_explorer/config/slam_fused.yaml

# 4. Nav2 with the NO-MOTION params (all velocities zeroed)
ros2 launch turtlebot4_navigation nav2.launch.py namespace:=$NS \
  params_file:=src/guide_mate_explorer/config/nav2_no_motion.yaml

# Watch the base command stay ~0 the whole time:
ros2 topic echo /$NS/cmd_vel        # should never show non-zero linear.x / angular.z
```

## Gotchas hit while validating this
- **`use_sim_time`** — `nav2_no_motion.yaml` sets it `false` (real robot). With `true` and no
  `/clock`, every Nav2 node hangs in activation. `slam.launch.py`/`nav2.launch.py` also rewrite
  it from the `use_sim_time:=` arg (default `false`).
- **RPLIDAR `auto_standby`** — when nothing consumes `/scan` the lidar **parks (motor off)** and
  publishes nothing; in this mode it **ignores `start_motor`/`stop_motor`** and only spins up
  when a subscriber's DDS reader **matches** its `/scan` writer. `depth_lidar_fusion` subscribing
  to `/scan` is what wakes it — so fusion must be up (step 2) before SLAM is useful.

## ⚠ Do NOT run this from the Claude Code Bash tool
Nodes spawned from the **Claude Code Bash environment** on robot 468 can see the ROS graph
(`ros2 node/topic list`) but are **not reliably cross-discovered by the robot's boot-time
systemd nodes** over the FastDDS Discovery Server. Consequences, verified exhaustively:

- a `depth_lidar_fusion` launched from the Claude shell **never wakes the `auto_standby`
  lidar** (the rplidar logs no "Start", stays at 0 CPU) across every transport
  (`FASTDDS_BUILTIN_TRANSPORTS=UDPv4` vs default SHM), client mode (`ROS_SUPER_CLIENT` true/false),
  and even the robot's exact node env — so **no `/scan`** → no `scan_fused` → SLAM has no input;
- `/scan` and `/odom` from the boot nodes never arrive; `/tf` arrives only intermittently over
  UDP; robot-node param/service calls time out (can't disable `auto_standby` from here either);
- it is **not** a perms/namespace issue (all nodes run as `ubuntu`, no service isolation) and
  Claude-shell↔Claude-shell DDS works fine (the Bash-launched OAK camera streams depth to
  Claude-shell probes) — the break is specifically **boot-systemd-node ↔ Claude-shell-node**.

So launch the stack from the **robot's normal interactive terminal** (where subscribers do
wake the lidar — that's how mapping works), or disable `auto_standby` so the lidar always
spins. The no-motion guarantee above holds no matter who launches it.
