# CLAUDE.md

Guidance for working in the **cs7980-guide-mate** repo.

## What this is
CS7980 project: a **TurtleBot 4 "guide robot"** that autonomously maps and navigates an
indoor space. This repo holds **both** the project documentation (`docs/`) and the ROS 2
code (`src/guide_mate_explorer/`).

## Repo = colcon workspace
This repository **is** a ROS 2 colcon workspace.

```
cs7980-guide-mate/
├── CLAUDE.md              # this file
├── README.md
├── docs/                  # working docs (network, camera, mapping)
├── src/
│   └── guide_mate_explorer/   # our ROS 2 package
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

## The package: `guide_mate_explorer`
**Nodes**
- `bfs_explorer` — autonomous ("self-driven") mapping. Runs BFS over the SLAM occupancy grid from the robot's cell through free space to the nearest **frontier** (free cell touching unknown), sends it to Nav2 `navigate_to_pose`, replans on arrival/failure. Auto-saves the map, blacklists unreachable/bumped frontiers, declares done when no frontiers remain.
- `glass_guard` — glass/transparent-obstacle backstop. The lidar can't see glass; on a Create 3 **BUMP** it marks a **persistent (non-clearing)** costmap obstacle and tells the explorer to blacklist that spot.
- `depth_lidar_fusion` — folds OAK-D depth into the lidar scan. Per-column vertical **collapse** (nearest non-floor pixel) → transform to the lidar frame via a one-time static TF (this accounts for the ~2 cm lidar↔camera offset) → **min-inject** into a copy of `/scan` → publishes `scan_fused`. Floor removed by a **data-driven ground-plane fit** (fits the floor line `v = A·(1/z)+B` per frame, self-calibrating camera height + pitch; sanity-bounded fallback to the assumed model). Also flags **drops/negative obstacles**: below-floor returns are flagged like positives, plus a missing-floor edge check marks the near edge of a ledge/stairs where the floor that should be in view returns nothing (Create 3 cliff sensors should cover the <0.4 m camera blind zone — pending). Only ever lowers a beam (never erases lidar); falls back to raw lidar if depth goes stale. So glass enters the **SLAM map**, not just the costmap.

**Launch files** (`src/guide_mate_explorer/launch/`)
- `explore.launch.py` — explorer only (assumes SLAM + Nav2 already up).
- `autonomous_mapping.launch.py` — **full stack** (SLAM + glass-aware Nav2 + glass_guard + explorer). **This starts autonomous MOTION.**
- `depth_perception.launch.py` — OAK depth → pointcloud → height-filtered scan (`oakd/scan`, a *separate* costmap source).
- `depth_lidar_fusion.launch.py` — OAK depth folded into the lidar scan → `scan_fused` (the *alternative* to depth_perception; point SLAM + Nav2 at `scan_fused`).

**Config** (`src/guide_mate_explorer/config/`)
- `nav2_glass.yaml` — Nav2 with the depth scan (`oakd/scan`) added as a 2nd costmap obstacle source, the non-clearing bump layer, and speed capped to 0.15 m/s.
- `oakd_mapping.yaml` — OAK config (USB2 / no-NN / depth). In practice we launch the camera with `-p` flags (see below) because the composable launch didn't apply the YAML.

## Mapping stack architecture
- **SLAM:** `slam_toolbox` (sync), **lidar-only**, publishes `/turtlebot468/map` + `map→odom`.
- **Nav2:** planner / controller / costmaps from `nav2_glass.yaml`.
- **Sensors:** RPLIDAR (360°, ~8 Hz) drives SLAM + nav; **OAK-D depth** adds the obstacles the lidar misses — the low **metal bases of glass doors**, low objects, overhangs.
- **Glass handling, in layers:** depth-detected obstacles in the costmap → `glass_guard` bump backstop (persistent marks) → `depth_lidar_fusion` injects depth into the lidar scan (`scan_fused`) so glass also enters the **SLAM map** *(built + offline-validated; on-robot localization check pending)*.

See `docs/mapping/` for the full write-up.

## CRITICAL gotchas (each cost real debugging time)
1. **Namespaced TF:** `tf2_ros.TransformListener` subscribes to the **global** `/tf`. A namespaced node **must** remap `('/tf','tf'), ('/tf_static','tf_static')` or every lookup fails silently with `LookupException`. (This is what nav2_bringup does.)
2. **OAK-D USB:** the camera **boot-loops on USB3** (power-limited). Bring it up forced to **USB2**. Depth images are **BEST_EFFORT** QoS — `ros2 topic hz/echo` show nothing unless you pass `--qos-reliability best_effort`.
3. **Create 3 hazards:** `hazard_detection` is **event-only** (publishes only *during* a hazard) and only on the **raw** `/turtlebot468/_do_not_use/hazard_detection` (NOT republished to the clean namespace). Create 3 webserver: **192.168.186.2** (Pi is .3 over usb0), firmware H.2.6.
4. **Pi 4 is compute-bound:** `slam_toolbox` ≈ 1 core; the Pi can't comfortably run SLAM + full depth pointcloud + Nav2 together. We freed ~25% by killing `diagnostics`/`joy`/`teleop`. Long term: offload heavy nodes to a laptop (the two-computer architecture in `docs/network/`).
5. **Power / "park":** soft park services (`stop_motor`, slam pause) report success but **don't cut power** — kill the *processes* instead. Only `oakd/stop_camera` actually works. ~14 W idle undocked.
6. **kill scripts:** `pkill -f camera_node` matches *your own shell command* — kill by **PID** or match on `ps comm`, not `-f`.
7. **OAK camera_info ≠ depth size, and lidar frame is yawed:** depthai publishes `oakd/stereo/camera_info` as **1280×720** but the actual depth image is **640×480** — using that K unscaled skews the projection (e.g. the whole depth wedge swings to −90°). `depth_lidar_fusion` therefore uses camera_info **only if its w/h match the image**, else a FOV pinhole model (`hfov_deg`/`vfov_deg`). Separately, **`rplidar_link` is yawed ~90°** (lidar bearing 0 ≠ robot-forward), so the depth wedge sits near −90°; this is fine because the lidar's own returns share that frame, so depth+lidar overlay correctly.
8. **OAK depth stalls (X_LINK):** the camera_node stays alive but stops publishing (0 Hz). Fusion degrades gracefully (passes raw lidar through); recover with SIGTERM-by-PID + relaunch.

## Bring-up commands
```bash
# Always source first
source /opt/ros/humble/setup.bash
source ~/cs7980-guide-mate/install/setup.bash

# OAK-D depth on USB2 (the camera does NOT come up by default; boot-loops on USB3)
ros2 run depthai_ros_driver camera_node --ros-args \
  -r __ns:=/turtlebot468 -r __node:=oakd \
  -p camera.i_pipeline_type:=RGBD -p camera.i_usb_speed:=HIGH -p camera.i_nn_type:=none \
  -p camera.i_enable_imu:=false -p rgb.i_publish_topic:=false -p rgb.i_enable_preview:=false \
  -p left.i_fps:=6.0 -p right.i_fps:=6.0 \
  -p stereo.i_publish_topic:=true -p stereo.i_align_depth:=false -p stereo.i_resolution:=400

# Depth perception (pointcloud + height-filtered scan) — separate oakd/scan source
ros2 launch guide_mate_explorer depth_perception.launch.py namespace:=turtlebot468

# OR: fold depth into the lidar scan -> scan_fused (so glass enters the SLAM map)
ros2 launch guide_mate_explorer depth_lidar_fusion.launch.py namespace:=turtlebot468
# compare in RViz: raw /turtlebot468/scan vs fused /turtlebot468/scan_fused (best_effort QoS)

# Full autonomous mapping (SLAM + Nav2 + glass_guard + explorer) — STARTS MOTION
ros2 launch guide_mate_explorer autonomous_mapping.launch.py namespace:=turtlebot468
```

## Status / roadmap
- **Done:** BFS explorer; glass_guard + bump costmap layer; OAK-D depth brought up on USB2 and **validated to detect the glass metal base** (~0.32 m, floor rejected); depth → costmap pipeline; `depth_lidar_fusion` node built, offline-validated, and **HARDWARE-VALIDATED on robot 468 facing the glass wall** (depth saw the base on 205 beams 0.37–1.63 m where the lidar was blind/saw through; fusion injected 195 beams, raised 0); SLAM verified running (6.8 Hz lidar, map + map→odom); migrated into this repo as a colcon workspace.
- **Next (on robot):** point slam_toolbox `scan_topic` + Nav2 costmap source at `scan_fused` so the glass enters the **SLAM map** (not just the live topic), run a **localization sanity check** (map stays crisp, no double-walls), then a full autonomous mapping run.
- **Later:** keepout-zone masks; offload heavy nodes to a laptop; repeat on robot 436.

## Conventions
- **No credentials in the repo** (see the security note in `docs/README.md`).
- Match the existing detailed docs style in `docs/` (TL;DR, tables, "what works / what doesn't", pending issues).
- Robot-specific findings that aren't derivable from code live in Claude memory (`MEMORY.md` index).
