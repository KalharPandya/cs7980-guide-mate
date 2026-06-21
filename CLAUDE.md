# CLAUDE.md

Guidance for working in the **cs7980-guide-mate** repo.

## What this is
CS7980 project: a **TurtleBot 4 "guide robot"** that autonomously maps and navigates an
indoor space. This repo holds **both** the project documentation (`docs/`) and the ROS 2
code (two packages under `src/`: **`guide_mate_explorer`** (Python) and
**`guide_mate_perception`** (C++)).

## Repo = colcon workspace
This repository **is** a ROS 2 colcon workspace.

```
cs7980-guide-mate/
├── CLAUDE.md              # this file
├── README.md
├── docs/                  # working docs (aws-iot/, camera.md, mapping/, network/, power.md)
├── src/
│   ├── guide_mate_explorer/    # Python pkg: bfs_explorer, glass_guard, depth_lidar_fusion, combined runner
│   └── guide_mate_perception/  # C++ pkg: rclcpp port of depth_lidar_fusion (~10x cheaper on the Pi-4)
└── build/ install/ log/   # colcon output (gitignored)
```

- **Build:** `cd ~/cs7980-guide-mate && colcon build --symlink-install`
- **Source:** `source /opt/ros/humble/setup.bash && source ~/cs7980-guide-mate/install/setup.bash`
- The old `~/turtlebot4_ws` is **no longer used** for our package (migrated here 2026-06-19).

## The robots
- Two TB4 units: **`turtlebot468`** (room 468) and **`turtlebot436`** (room 436). All work so far is on **468**.
- **Everything is namespaced** under the robot name, e.g. `/turtlebot468/scan`, `/turtlebot468/odom`.
- Each robot = **Raspberry Pi 4** (Ubuntu 22.04, ROS 2 Humble — the box you SSH into) **+ iRobot Create 3 base** (USB-C carries power *and* a wired ethernet link). FastDDS **Discovery Server** runs on the Pi.
- ROS 2 **Humble**, `ROS_DOMAIN_ID=0`, `rmw_fastrtps_cpp`.

## The packages

### `guide_mate_explorer` (Python)
**Nodes**
- `bfs_explorer` — autonomous ("self-driven") mapping. Runs BFS over the SLAM occupancy grid from the robot's cell through free space to the nearest **frontier** (free cell touching unknown), sends it to Nav2 `navigate_to_pose`, replans on arrival/failure. Auto-saves the map, blacklists unreachable/bumped frontiers, declares done when no frontiers remain.
- `glass_guard` — glass/transparent-obstacle backstop. The lidar can't see glass; on a Create 3 **BUMP** it marks a **persistent (non-clearing)** costmap obstacle and tells the explorer to blacklist that spot.
- `depth_lidar_fusion` — folds OAK-D-LITE depth into the lidar scan. Per-column vertical **collapse** (nearest non-floor pixel) → transform to the lidar frame via a one-time static TF (this accounts for the ~2 cm lidar↔camera offset) → **min-inject** into a copy of `/scan` → publishes `scan_fused`. Floor removed by a **data-driven ground-plane fit** (fits the floor line `v = A·(1/z)+B` per frame, self-calibrating camera height + pitch; sanity-bounded fallback to the assumed model). Also flags **drops/negative obstacles**: below-floor returns are flagged like positives, plus a missing-floor edge check marks the near edge of a ledge/stairs where the floor that should be in view returns nothing (Create 3 cliff sensors should cover the <0.4 m camera blind zone — pending). Only ever lowers a beam (never erases lidar); falls back to raw lidar if depth goes stale. `scan_fused` is the **single fused obstacle source** that both Nav2 and SLAM consume, so glass enters the **SLAM map**, not just the costmap.
- `combined_node.py` — **combined runner** (entry point `guide_mate_bringup`): runs `glass_guard` **+** `bfs_explorer` in **one process** under a single executor, so the per-node rclpy/DDS overhead is paid once. `depth_lidar_fusion` is **deliberately excluded** (CPU/GIL-bound → it keeps its own core; that's why the C++ port exists). The individual `ros2 run` entry points still work.

**Launch files** (`src/guide_mate_explorer/launch/`)
- `explore.launch.py` — explorer only (assumes SLAM + Nav2 already up).
- `autonomous_mapping.launch.py` — **full stack**, self-starts the entire producer chain staggered by `TimerAction`s: OAK-D-LITE `camera_node` → `depth_lidar_fusion` (publishes `scan_fused`) → SLAM (`slam_fused.yaml`) + glass-aware Nav2 (`nav2_glass.yaml`) → `glass_guard` → `bfs_explorer`. You do **not** manually run `depth_perception` first. Pass `start_camera:=false` if the camera is already up (e.g. the manual USB2 bring-up). **This starts autonomous MOTION** (speed capped to 0.15 m/s).
- `combined.launch.py` — launches the combined runner (`guide_mate_bringup`: glass_guard + bfs_explorer in one process).
- `depth_lidar_fusion.launch.py` — OAK-D-LITE depth folded into the lidar scan → `scan_fused` (the active fusion path; point SLAM + Nav2 at `scan_fused`).
- `depth_perception.launch.py` — **LEGACY/alternative**: OAK depth → pointcloud → height-filtered scan (`oakd/scan`). This separate-costmap-source pipeline is **no longer the active path**.

**Config** (`src/guide_mate_explorer/config/`)
- `nav2_glass.yaml` — Nav2 with both local & global costmaps' `observation_sources: scan` pointed at **`topic: scan_fused`** (the single fused source; the old "oakd/scan as a 2nd costmap source" design is retired), the non-clearing bump layer, and speed capped to 0.15 m/s (`FollowPath` `max_vel_x`/`max_speed_xy`).
- `slam_fused.yaml` — slam_toolbox with **`scan_topic: scan_fused`**, so SLAM maps on the fused scan and glass enters the **SLAM map** (not just the runtime costmap). Revert to `scan` for raw-lidar-only.
- `oakd_mapping.yaml` — OAK-D-LITE config (USB2 / no-NN / depth). In practice we launch the camera with `-p` flags (see below) because the composable launch didn't apply the YAML.

### `guide_mate_perception` (C++)
Faithful **rclcpp ports of all three** Python nodes + a **shared-TF container**. The answer to Pi-4 compute saturation: ~10–17× cheaper, aggregate Python ~166% → C++ ~11% of a core. Run the **Python OR the C++** node for a role, **not both**. Full write-up + benchmarks: [`src/guide_mate_perception/README.md`](src/guide_mate_perception/README.md).
- `depth_lidar_fusion` — port of the fusion node; mirrors the numpy numerics (float32 decision path, round-half-even, median, argmin tie-break), same `scan_fused` output. Benchmark **3.7%** vs Python 52.4%.
- `bfs_explorer` — port of the explorer; **goal-level only, never publishes `cmd_vel`** (sends a `NavigateToPose` goal, waits for the result, replans). Benchmark **5.7%** vs Python 95.8%.
- `glass_guard` — port of the bump backstop; `reactive_backup` defaults **false**. Benchmark **1.8%** vs Python 17.8%.
- `guide_mate_container` (`guide_mate_container.launch.py`) — runs all three in ONE process with **one** `tf2_ros::Buffer` + **one** `TransformListener` (the busy `/tf` is parsed once, not per node — the real Pi-4 tax; ~16%/core per listener) on a GIL-free `MultiThreadedExecutor`. Validated: `/tf` Subscription count = 1, behavior nodes own 0 TF subs.
- **Launches:** `depth_lidar_fusion_cpp.launch.py`, `guide_mate_container.launch.py`.
- **No-motion bring-up:** `config/nav2_no_motion.yaml` (in the explorer pkg) + [`docs/mapping/bringup-no-motion.md`](docs/mapping/bringup-no-motion.md) — full stack on a docked robot with every Nav2 velocity zeroed. **Note:** can't be driven from the Claude Bash shell (its nodes aren't cross-discovered by the boot systemd nodes → can't wake the `auto_standby` lidar); run from the robot's terminal.

## Mapping stack architecture
- **SLAM:** `slam_toolbox` (sync), now consuming **`scan_fused`** (`slam_fused.yaml`) instead of raw lidar, so glass enters the SLAM map; publishes `/turtlebot468/map` + `map→odom`.
- **Nav2:** planner / controller / costmaps from `nav2_glass.yaml`, costmap obstacle source = `scan_fused`.
- **Sensors:** RPLIDAR (360°, ~8 Hz) drives SLAM + nav; **OAK-D-LITE depth** adds the obstacles the lidar misses — the low **metal bases of glass doors**, low objects, overhangs.
- **Glass handling, in layers:** `depth_lidar_fusion` injects depth into the lidar scan → publishes `scan_fused`, the **single fused obstacle source** for both Nav2 (`nav2_glass.yaml`) and SLAM (`slam_fused.yaml`) so glass enters both the costmap **and** the **SLAM map** → `glass_guard` bump backstop (persistent non-clearing marks) as the last-resort backstop *(fusion HARDWARE-VALIDATED; scan_fused now wired into SLAM + Nav2; on-robot localization sanity check pending)*.

See `docs/mapping/` for the full write-up.

## CRITICAL gotchas (each cost real debugging time)
1. **Namespaced TF:** `tf2_ros.TransformListener` subscribes to the **global** `/tf`. A namespaced node **must** remap `('/tf','tf'), ('/tf_static','tf_static')` or every lookup fails silently with `LookupException`. (This is what nav2_bringup does.)
2. **OAK-D USB wedge — root cause is `usbfs_memory_mb=16`, NOT power** *(corrected 2026-06-20; the old "boot-loops on USB3, power-limited, force USB2" claim was wrong)*. The default config reaches "Camera ready" then **aborts ~5 s later** with `X_LINK_ERROR` on the stereo stream. Fix: **`usbcore.usbfs_memory_mb=256`** (in `cmdline.txt`) → the same USB3/SUPER config then runs full-rate indefinitely. `vcgencmd get_throttled` stays **`0x0`** — under-voltage was never the cause. Depth publisher QoS is **RELIABLE** (not BEST_EFFORT); and on this Discovery-Server box a fresh ad-hoc `ros2 topic hz/echo` gets **0 frames for *any* topic** (even `/scan`) — health-check via USB id (`f63b`=up / `2485`=bootloader), not frames. Full write-up: `docs/camera.md`; fixes: `scripts/`.
3. **Create 3 hazards:** `hazard_detection` is **event-only** (publishes only *during* a hazard) and only on the **raw** `/turtlebot468/_do_not_use/hazard_detection` (NOT republished to the clean namespace). Create 3 webserver: **192.168.186.2** (Pi is .3 over usb0), firmware H.2.6.
4. **Pi 4 is compute-bound:** `slam_toolbox` ≈ 1 core; the Pi can't comfortably run SLAM + full depth pointcloud + Nav2 together. We freed ~25% by killing `diagnostics`/`joy`/`teleop`. On-Pi mitigations: the **C++ fusion port** (`guide_mate_perception`, ~10x cheaper) and the **combined `guide_mate_bringup` runner** (glass_guard + bfs_explorer in one process). Long term: offload heavy nodes to a laptop (the two-computer architecture in `docs/network/`).
5. **Power / "park":** soft park services (`stop_motor`, slam pause) report success but **don't cut power** — kill the *processes* instead. Only `oakd/stop_camera` actually works. ~14 W idle undocked.
6. **kill scripts:** `pkill -f camera_node` matches *your own shell command* — kill by **PID** or match on `ps comm`, not `-f`.
7. **OAK camera_info ≠ depth size, and lidar frame is yawed:** depthai publishes `oakd/stereo/camera_info` as **1280×720** but the actual depth image is **640×480** — using that K unscaled skews the projection (e.g. the whole depth wedge swings to −90°). `depth_lidar_fusion` therefore uses camera_info **only if its w/h match the image**, else a FOV pinhole model (`hfov_deg`/`vfov_deg`). Separately, **`rplidar_link` is yawed ~90°** (lidar bearing 0 ≠ robot-forward), so the depth wedge sits near −90°; this is fine because the lidar's own returns share that frame, so depth+lidar overlay correctly.
8. **OAK depth runtime drop (X_LINK disconnect → wedge):** the device abruptly drops to bootloader (`2485`) and the **stock driver wedges forever** (process alive, 0 Hz, spamming `No data on logger queue! … sys_logger_queue (X_LINK_ERROR)`; the TB4 `oakd_container` has no respawn). Cause is a **camera-rail current brownout, specific to the heavy-RGBD+USB3 mode** — **NOT CPU and NOT temperature** (2026-06-20 mode-matrix + load-sweep: depth-only survived full Pi saturation + active thermal-throttling with 0 drops; only heavy+USB3 drops, ~30 s MTTD; under-voltage never set). So **run depth-only** (mapping needs neither RGB nor the OAK IMU) and drops are rare. Fusion degrades gracefully (raw lidar passthrough). Recover: `pkill -x camera_node` (**never `-f`** — self-matches the shell → exit 144) + relaunch with usbfs≥256. Prevent: `i_restart_on_diagnostics_error:=true` (self-heal, thrashes without backoff) + `scripts/oak_watchdog.sh` (validated backstop); true fix is hardware power delivery (cable/powered-hub/Y-adapter). See `docs/camera.md`.

## Bring-up commands
```bash
# Always source first
source /opt/ros/humble/setup.bash
source ~/cs7980-guide-mate/install/setup.bash

# OAK-D-LITE depth on USB2 (does NOT auto-start; daily wedge = usbfs_memory_mb=16 → set 256, not power; depth-only is stable on either bus). Prefer scripts/oak_bringup.sh
ros2 run depthai_ros_driver camera_node --ros-args \
  -r __ns:=/turtlebot468 -r __node:=oakd \
  -p camera.i_pipeline_type:=RGBD -p camera.i_usb_speed:=HIGH -p camera.i_nn_type:=none \
  -p camera.i_enable_imu:=false -p rgb.i_publish_topic:=false -p rgb.i_enable_preview:=false \
  -p left.i_fps:=6.0 -p right.i_fps:=6.0 \
  -p stereo.i_publish_topic:=true -p stereo.i_align_depth:=false -p stereo.i_resolution:=400

# Fold depth into the lidar scan -> scan_fused (the active path; so glass enters the SLAM map)
ros2 launch guide_mate_explorer depth_lidar_fusion.launch.py namespace:=turtlebot468
# ...or the ~10x cheaper C++ port (run ONE of these, not both):
ros2 launch guide_mate_perception depth_lidar_fusion_cpp.launch.py namespace:=turtlebot468
# compare in RViz: raw /turtlebot468/scan vs fused /turtlebot468/scan_fused (best_effort QoS)

# LEGACY/alternative: depth perception (pointcloud + height-filtered oakd/scan source)
ros2 launch guide_mate_explorer depth_perception.launch.py namespace:=turtlebot468

# Full autonomous mapping — self-starts camera -> fusion -> SLAM + Nav2 -> glass_guard -> explorer.
# STARTS MOTION. Pass start_camera:=false if the camera is already up.
ros2 launch guide_mate_explorer autonomous_mapping.launch.py namespace:=turtlebot468

# Combined runner: glass_guard + bfs_explorer in one process (fusion stays separate)
ros2 launch guide_mate_explorer combined.launch.py namespace:=turtlebot468
```

## Status / roadmap
- **Done:** BFS explorer; glass_guard + bump costmap layer; OAK-D-LITE depth brought up on USB2 and **validated to detect the glass metal base** (~0.32 m, floor rejected); depth → costmap pipeline; `depth_lidar_fusion` node built, offline-validated, and **HARDWARE-VALIDATED on robot 468 facing the glass wall** (depth saw the base on 205 beams 0.37–1.63 m where the lidar was blind/saw through; fusion injected 195 beams, raised 0); **`scan_fused` now wired into both SLAM (`slam_fused.yaml`) and Nav2 (`nav2_glass.yaml`) as the single fused obstacle source**; SLAM verified running (6.8 Hz lidar, map + map→odom); C++ port of the fusion node (`guide_mate_perception`, ~10x cheaper) and the combined `guide_mate_bringup` runner built; migrated into this repo as a colcon workspace.
- **Next (on robot):** run the **SLAM-map localization sanity check** (map stays crisp, no double-walls) now that SLAM consumes `scan_fused`, then a full autonomous mapping run.
- **Later:** keepout-zone masks; offload heavy nodes to a laptop; repeat on robot 436.

## Conventions
- **No credentials in the repo** (see the security note in `docs/README.md`).
- Match the existing detailed docs style in `docs/` (TL;DR, tables, "what works / what doesn't", pending issues).
- Robot-specific findings that aren't derivable from code live in Claude memory (`MEMORY.md` index).
