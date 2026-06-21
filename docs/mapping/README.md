# Autonomous mapping — overview

How robot **468** maps an indoor space on its own, and how we handle obstacles the 2D
lidar can't see (glass). Code lives in [`src/guide_mate_explorer`](../../src/guide_mate_explorer).

**TL;DR:** A custom **BFS frontier explorer** drives the robot to unexplored areas while
`slam_toolbox` builds the map and Nav2 plans/avoids. Because the 2D lidar is blind to
**glass**, we fold the **OAK-D-LITE depth camera** (which sees the glass doors' metal base)
**into the lidar scan** → a single fused scan, `scan_fused`, that feeds **both** Nav2's
costmaps **and** SLAM — so glass enters the **SLAM map**, not just the runtime costmap. The
**Create 3 bumper** is the last-resort backstop.

---

## The stack

```
                 ┌────────────── sensors ──────────────┐
   RPLIDAR (360°, ~8 Hz) ──► /scan ──┐         OAK-D-LITE depth ──► (see depth-perception.md)
   Create 3 base ──► /odom, /tf      │                       │
                                     ▼                       ▼
                                 depth_lidar_fusion: collapse depth per column to nearest
                                 non-floor point, min-inject into a copy of /scan
                                     │
                                     ▼
                              ┌── scan_fused ──┐   (the SINGLE fused obstacle source)
                              ▼                ▼
                       slam_toolbox          Nav2 costmaps
                   (maps on scan_fused →     (local + global, observation
                    glass in the SLAM map)    source = scan_fused, + bump layer)
                              │                ▲
                     map + map→odom            │ navigate_to_pose
                              └──────► Nav2 ◄───┘
                                        ▲
                              bfs_explorer ──► picks nearest frontier, drives there, repeats
                                        ▲
                              glass_guard  ──► on bump: persistent costmap mark + blacklist
```

The separate `oakd/scan` height-filtered pipeline (depth → 3D pointcloud → 2D scan as a
distinct 2nd costmap source) is now the **legacy/alternative** path — see
[depth-perception.md](depth-perception.md). The active design is the single fused scan above.

## Components

The two ROS 2 packages under `src/`:

- **`guide_mate_explorer`** (Python) — `bfs_explorer`, `glass_guard`, `depth_lidar_fusion` nodes, plus the `guide_mate_bringup` combined runner.
- **`guide_mate_perception`** (C++) — faithful `rclcpp` ports of **all three** nodes (`depth_lidar_fusion`, `bfs_explorer`, `glass_guard`) **plus a shared-TF component container** that runs them in one process. ~10–17× cheaper than the Python originals. See [`src/guide_mate_perception/README.md`](../../src/guide_mate_perception/README.md).

| Piece | Package | What it does |
|---|---|---|
| `bfs_explorer` | explorer | BFS from the robot's cell through free space to the **nearest frontier** (free cell touching unknown). Sends it to Nav2, replans on arrival/failure, auto-saves the map, blacklists dead ends, stops when no frontiers remain. "BFS manner" = nearest-frontier-first. |
| `glass_guard` | explorer | Subscribes to the Create 3 bumper; on **BUMP**, projects the bumper into `map`, republishes a **non-clearing** `PointCloud2` (so the lidar can't erase it), and publishes the hit so the explorer blacklists it. |
| `depth_lidar_fusion` | explorer | The active glass path: **collapses** depth per column to the nearest non-floor point and **min-injects** it into a copy of the lidar scan → **`scan_fused`**, the single fused source consumed by both SLAM and Nav2 (so glass lands in the **SLAM map**). Only lowers beams, never erases lidar; falls back to raw lidar if depth goes stale. See [depth-perception.md](depth-perception.md). |
| C++ ports + container | perception | Faithful `rclcpp` ports of **all three** nodes above (same numerics, topics, frames) at **~10–17× less CPU**, plus a **shared-TF `guide_mate_container`** that runs fusion + glass_guard + bfs in ONE process with a **single** `/tf` listener. The answer to Pi-4 compute saturation. Aggregate Python ~166% → C++ ~11% of a core. Launches: `depth_lidar_fusion_cpp.launch.py`, `guide_mate_container.launch.py`. **Run the Python OR the C++ node for a role, not both.** See [`src/guide_mate_perception/README.md`](../../src/guide_mate_perception/README.md). |
| `guide_mate_bringup` | explorer | Combined single-process runner (`combined_node.py` / `combined.launch.py`): runs **`glass_guard` + `bfs_explorer` in ONE process** under one executor, so the per-node rclpy/DDS overhead is paid once. `depth_lidar_fusion` is **deliberately excluded** (CPU/GIL-bound → keeps its own core; that's why the C++ port exists). Individual `ros2 run` entry points still work. |
| depth pipeline (legacy) | explorer | OAK-D depth → 3D pointcloud → **height-filtered** 2D scan (`oakd/scan`) as a *separate* 2nd costmap source. **Retired** in favor of `scan_fused`; kept as the alternative path. See [depth-perception.md](depth-perception.md). |

### Config (`src/guide_mate_explorer/config/`)

| File | What it does |
|---|---|
| `nav2_glass.yaml` | Nav2 config. Both **local & global** costmaps use `observation_sources: scan` → **`topic: scan_fused`** (the old "`oakd/scan` as a separate 2nd source" design is **retired**), plus the non-clearing bump layer. Speed capped to **0.15 m/s** (FollowPath `max_vel_x` / `max_speed_xy`). |
| `slam_fused.yaml` | `slam_toolbox` config with **`scan_topic: scan_fused`** — SLAM maps on the fused scan so glass enters the SLAM map. Revert to `scan` for raw-lidar-only. |
| `oakd_mapping.yaml` | OAK-D-LITE camera config (USB2 / no-NN / depth). |

## Why glass is the hard part
The RPLIDAR scans a single horizontal plane (~0.19 m). **Glass is transparent to it**, so to
Nav2 a glass wall looks like open space — and the robot drove into one. The fix is layered:

1. **Depth camera** sees the glass doors' **metal base/frame** (below the lidar plane). `depth_lidar_fusion` injects it into the lidar scan → **`scan_fused`**, which feeds **both** Nav2's costmaps (planner routes around it) **and** SLAM (glass lands in the **SLAM map**, not just the runtime costmap). *Proactive, but only where a frame is visible.*
2. **`glass_guard` / bumper** catches fully-transparent sections with no visible frame and marks them **permanently**. *Reactive last resort.*

`depth_lidar_fusion` is **hardware-validated** on robot 468 and `scan_fused` is **wired into the SLAM + Nav2 configs**; the on-robot SLAM-map localization sanity check is still pending (see Status).

> Industry-standard alternatives for known glass: pre-drawn **keepout-zone** map masks and **ultrasonic** sensors (sonar reflects off glass). The TB4 has no ultrasonics; keepout zones are a possible future add.

## How to run

`autonomous_mapping.launch.py` self-starts the **full producer chain**, staggered by
`TimerAction`s: **OAK-D-LITE `camera_node` → `depth_lidar_fusion` (publishes `scan_fused`) →
SLAM (`slam_fused.yaml`) + Nav2 (`nav2_glass.yaml`) → `glass_guard` → `bfs_explorer`**. So you
do **not** manually run `depth_perception` first.

```bash
source /opt/ros/humble/setup.bash
source ~/cs7980-guide-mate/install/setup.bash

# Full autonomous mapping — STARTS MOTION; make sure the area is clear.
# Brings up the camera, fusion, SLAM, Nav2, glass_guard, and the explorer.
ros2 launch guide_mate_explorer autonomous_mapping.launch.py namespace:=turtlebot468

# watch completion / saved map
ros2 topic echo /turtlebot468/exploration_complete
ls -la ~/maps/
```

If the OAK-D-LITE is **already up** (e.g. the manual USB2 bring-up below), skip the camera
start with `start_camera:=false`:

```bash
ros2 launch guide_mate_explorer autonomous_mapping.launch.py \
  namespace:=turtlebot468 start_camera:=false
```

Manual OAK-D-LITE USB2 bring-up (see [../camera.md](../camera.md) for why USB2):

```bash
ros2 run depthai_ros_driver camera_node --ros-args \
  -r __ns:=/turtlebot468 -r __node:=oakd \
  -p camera.i_pipeline_type:=RGBD -p camera.i_usb_speed:=HIGH -p camera.i_nn_type:=none \
  -p camera.i_enable_imu:=false -p rgb.i_publish_topic:=false -p rgb.i_enable_preview:=false \
  -p left.i_fps:=6.0 -p right.i_fps:=6.0 \
  -p stereo.i_publish_topic:=true -p stereo.i_align_depth:=false -p stereo.i_resolution:=400
```

To save Pi-4 CPU, run the **C++** fusion node instead of the Python one (run one, not both):

```bash
ros2 launch guide_mate_perception depth_lidar_fusion_cpp.launch.py namespace:=turtlebot468
```

To **watch** the map, lidar, depth scan and cloud build live from a laptop, see
[Viewing live mapping in RViz](rviz-visualization.md).

To bring the **whole stack up on a docked robot that must not move** (integration test:
zeroed-velocity Nav2 + the C++ shared-TF container + SLAM), see
[No-motion full-stack bring-up](bringup-no-motion.md).

## Hard-won constraints (read before debugging)
- **Namespaced TF** needs `('/tf','tf'),('/tf_static','tf_static')` remaps or lookups fail silently. See [`turtlebot4-namespaced-tf-remap`](../../CLAUDE.md).
- **Pi 4 is compute-bound** — SLAM ≈ 1 core; running SLAM + full depth pointcloud + Nav2 together saturates it. We freed ~25% by killing diagnostics/joy/teleop. The on-robot answers: the fast depth-collapse fusion (see depth doc), the **C++ fusion port** (`guide_mate_perception`, ~10× cheaper), and the **`guide_mate_bringup`** combined runner (glass_guard + bfs_explorer in one process). Offloading to a laptop is the long-term one.
- **Create 3 hazards** are event-only on the raw `_do_not_use` topic.
- Robot speed is capped to **0.15 m/s** during mapping because the depth scan is currently slow.

## Status / roadmap
- ✅ Explorer, glass_guard, depth pipeline built; depth **validated to detect the glass metal base**; migrated into this repo.
- ✅ `depth_lidar_fusion` (fast collapse + inject into lidar scan → glass in the SLAM map) **built, offline-validated** (synthetic wall: per-column collapse, ±38° wedge, min-inject only lowers beams, graceful stale-depth fallback) **and HARDWARE-VALIDATED on robot 468** facing the glass wall: depth saw the base on **205 beams 0.37–1.63 m** where the lidar was blind/saw through; fusion injected **195**.
- ✅ **`scan_fused` wired into the active configs** — `nav2_glass.yaml` (both costmaps) and `slam_fused.yaml` (SLAM `scan_topic`) consume it; the separate `oakd/scan` source is retired.
- ✅ **C++ ports of all three nodes + a shared-TF container** (`guide_mate_perception`) — benchmarked ~10–17× cheaper (aggregate Python ~166% → C++ ~11% of a core); plus the Python **`guide_mate_bringup`** combined runner.
- ✅ **No-motion full-stack bring-up** documented + `nav2_no_motion.yaml` (all velocities zeroed) for docked integration testing.
- ⚠ The integrated stack can't be driven from the **Claude Code Bash shell** (its nodes aren't cross-discovered by the boot-time systemd nodes → can't wake the `auto_standby` lidar); run from the robot's own terminal. See [bringup-no-motion.md](bringup-no-motion.md).
- ⏳ On robot: SLAM-map **localization sanity check** (map stays crisp, no double-walls) → full autonomous mapping run.
- ⏳ Not yet: keepout-zone masks; offload heavy nodes to a laptop; repeat on robot 436.
