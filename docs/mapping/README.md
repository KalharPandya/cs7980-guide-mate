# Autonomous mapping — overview

How robot **468** maps an indoor space on its own, and how we handle obstacles the 2D
lidar can't see (glass). Code lives in [`src/guide_mate_explorer`](../../src/guide_mate_explorer).

**TL;DR:** A custom **BFS frontier explorer** drives the robot to unexplored areas while
`slam_toolbox` builds the map and Nav2 plans/avoids. Because the 2D lidar is blind to
**glass**, we add the **OAK-D depth camera** (which sees the glass doors' metal base) as a
costmap obstacle source, with the **Create 3 bumper** as a last-resort backstop.

---

## The stack

```
                 ┌────────────── sensors ──────────────┐
   RPLIDAR (360°, ~8 Hz) ──► /scan ──┐                  OAK-D depth ──► (see depth-perception.md)
   Create 3 base ──► /odom, /tf      │                       │
                                     ▼                       ▼
                              slam_toolbox            depth obstacles
                          (lidar, builds /map)        (glass metal base,
                                     │                  low objects, overhangs)
                        map + map→odom                       │
                                     ▼                       ▼
                                   Nav2  ◄── costmaps (lidar scan + depth scan + bump layer)
                                     │
                            navigate_to_pose
                                     ▲
                              bfs_explorer ──► picks nearest frontier, drives there, repeats
                                     ▲
                              glass_guard  ──► on bump: persistent costmap mark + blacklist
```

## Components (all in `guide_mate_explorer`)

| Piece | What it does |
|---|---|
| `bfs_explorer` | BFS from the robot's cell through free space to the **nearest frontier** (free cell touching unknown). Sends it to Nav2, replans on arrival/failure, auto-saves the map, blacklists dead ends, stops when no frontiers remain. "BFS manner" = nearest-frontier-first. |
| `glass_guard` | Subscribes to the Create 3 bumper; on **BUMP**, projects the bumper into `map`, republishes a **non-clearing** `PointCloud2` (so the lidar can't erase it), and publishes the hit so the explorer blacklists it. |
| depth pipeline | OAK-D depth → 3D pointcloud → **height-filtered** 2D scan (`oakd/scan`) → 2nd costmap obstacle source. Catches the glass doors' metal base. See [depth-perception.md](depth-perception.md). |
| `depth_lidar_fusion` | The alternative to the separate `oakd/scan` source: **collapses** depth per column to the nearest non-floor point and **min-injects** it into the lidar scan → `scan_fused`. Point SLAM + Nav2 at `scan_fused` and the glass also lands in the **SLAM map**. Only lowers beams, never erases lidar; falls back to raw lidar if depth goes stale. Built + offline-validated. See [depth-perception.md](depth-perception.md). |
| `nav2_glass.yaml` | Nav2 config: `oakd/scan` as a 2nd obstacle source in both costmaps, the non-clearing bump layer, speed capped to 0.15 m/s. |

## Why glass is the hard part
The RPLIDAR scans a single horizontal plane (~0.19 m). **Glass is transparent to it**, so to
Nav2 a glass wall looks like open space — and the robot drove into one. The fix is layered:

1. **Depth camera** sees the glass doors' **metal base/frame** (below the lidar plane) → costmap obstacle → planner routes around it. *Proactive, but only where a frame is visible.*
2. **`glass_guard` / bumper** catches fully-transparent sections with no visible frame and marks them **permanently**. *Reactive last resort.*
3. **`depth_lidar_fusion`** injects the depth scan into the lidar scan (`scan_fused`) so glass also lands in the **SLAM map**, not just the runtime costmap. *Built + offline-validated; on-robot localization check pending.*

> Industry-standard alternatives for known glass: pre-drawn **keepout-zone** map masks and **ultrasonic** sensors (sonar reflects off glass). The TB4 has no ultrasonics; keepout zones are a possible future add.

## How to run

```bash
source /opt/ros/humble/setup.bash
source ~/cs7980-guide-mate/install/setup.bash

# 1) OAK-D depth on USB2 (see ../camera/oak-d-camera-test.md for why USB2)
ros2 run depthai_ros_driver camera_node --ros-args \
  -r __ns:=/turtlebot468 -r __node:=oakd \
  -p camera.i_pipeline_type:=RGBD -p camera.i_usb_speed:=HIGH -p camera.i_nn_type:=none \
  -p camera.i_enable_imu:=false -p rgb.i_publish_topic:=false -p rgb.i_enable_preview:=false \
  -p left.i_fps:=6.0 -p right.i_fps:=6.0 \
  -p stereo.i_publish_topic:=true -p stereo.i_align_depth:=false -p stereo.i_resolution:=400

# 2) Depth perception (pointcloud + height-filtered scan)
ros2 launch guide_mate_explorer depth_perception.launch.py namespace:=turtlebot468

# 3) Full autonomous mapping — STARTS MOTION; make sure the area is clear
ros2 launch guide_mate_explorer autonomous_mapping.launch.py namespace:=turtlebot468

# watch progress / completion / saved map
tail -f /tmp/explore.log
ros2 topic echo /turtlebot468/exploration_complete
ls -la ~/maps/
```

## Hard-won constraints (read before debugging)
- **Namespaced TF** needs `('/tf','tf'),('/tf_static','tf_static')` remaps or lookups fail silently. See [`turtlebot4-namespaced-tf-remap`](../../CLAUDE.md).
- **Pi 4 is compute-bound** — SLAM ≈ 1 core; running SLAM + full depth pointcloud + Nav2 together saturates it. We freed ~25% by killing diagnostics/joy/teleop. The fast depth-collapse (see depth doc) is the on-robot answer; offloading to a laptop is the long-term one.
- **Create 3 hazards** are event-only on the raw `_do_not_use` topic.
- Robot speed is capped to **0.15 m/s** during mapping because the depth scan is currently slow.

## Status / roadmap
- ✅ Explorer, glass_guard, depth pipeline built; depth **validated to detect the glass metal base**; migrated into this repo.
- ✅ `depth_lidar_fusion` (fast collapse + inject into lidar scan → glass in the SLAM map) **built + offline-validated** (synthetic wall: per-column collapse, ±38° wedge, min-inject only lowers beams, graceful stale-depth fallback).
- ⏭️ On robot: eyeball `scan` vs `scan_fused` in RViz → point SLAM + Nav2 at `scan_fused` → localization sanity check → full mapping run.
- ⏳ Not yet: keepout-zone masks; offload heavy nodes to a laptop; repeat on robot 436.
