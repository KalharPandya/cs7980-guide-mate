# Depth camera for mapping — glass detection, FOV, pipeline, plan

How we use the **OAK-D-LITE depth camera** to see what the 2D lidar can't (glass doors,
low objects, overhangs), and turn it into obstacles for mapping/navigation on robot **468**.

**TL;DR:** Depth → 3D pointcloud → **height-filtered** 2D scan keeps the glass doors' metal
base (~5–30 cm) while dropping the floor. Validated: it sees the base at ~0.32 m. The full
pointcloud path is slow on the Pi (~0.9 Hz), so the `depth_lidar_fusion` node does a cheap
**vertical-collapse** (~16 ms/frame) and **injects into the lidar scan** (`scan_fused`) so
glass enters the SLAM map. `scan_fused` is now the **single fused obstacle source for both
Nav2 and SLAM** (the separate pointcloud→`oakd/scan` costmap path is now legacy). Fusion is
**hardware-validated on robot 468** (facing the glass wall: depth saw the base on **205 beams
0.37–1.63 m** where the lidar was blind/saw through; fusion **injected 195**); a C++ rclcpp
port (`guide_mate_perception`) mirrors the Python numerics ~10× cheaper on the Pi-4. The
on-robot SLAM-map localization sanity check is still pending.

---

## Why depth (and what it can/can't see)
The RPLIDAR sees one horizontal plane at ~0.19 m and is **blind to glass**. The glass doors,
though, have a **metal base/frame below the lidar plane** — and the depth camera's vertical
FOV catches it. The **clear pane itself is invisible to depth too** (IR passes through / no
texture), so depth detects the door *by its frame*; the bumper (`glass_guard`) backstops the
fully-transparent gaps.

## Camera bring-up
- Driver: `depthai_ros_driver` (standard). The camera does **not** start by default; the
  daily wedge is the kernel `usbfs_memory_mb=16` default (fix: 256 — **not** power). Run
  depth-only (`i_usb_speed:=HIGH`, no NN, no RGB/IMU): lightest + stable on either bus. Use
  [`scripts/oak_bringup.sh`](../../scripts/README.md). Full analysis: [`../camera.md`](../camera.md).
- Output: `/turtlebot468/oakd/stereo/image_raw` — 16UC1 (mm) depth, **640×480**, frame
  `oakd_rgb_camera_optical_frame`, ~4–22 Hz depending on the fps params.
- **QoS gotcha:** depth is BEST_EFFORT — `ros2 topic hz/echo` need `--qos-reliability best_effort`.

## Field of view (measured geometry)
Vertical **FOV ≈ 58°** (±29° from the optical axis), horizontal ≈ 73° — a **forward wedge**
(the lidar covers 360°). Camera is mounted **horizontal at 0.244 m** (confirmed from TF; the
TB4 OAK has **no tilt**). What that covers in height vs distance:

| Distance ahead | Lowest height seen | Highest height seen | Note |
|---:|---:|---:|---|
| 0.30 m | 0.08 m | 0.41 m | blind below ~8 cm |
| 0.44 m | floor | 0.49 m | floor just enters view |
| 0.50 m | floor | 0.52 m | |
| 1.0 m | floor | 0.80 m | |
| 2.0 m | floor | 1.35 m | |
| 3.0 m | floor | 1.91 m | |

Consequences: a **near blind zone** (<~0.3 m, only things taller than ~8 cm; stereo also has
no depth under ~0.2 m) → the bumper covers this. The **floor enters view at ~0.44 m**, which
is why we height-filter. The glass metal base is fully visible once it's ~0.45 m+ ahead.

## The pipeline (legacy alternative)
> **Heads-up:** this pointcloud→`oakd/scan` path is now the **LEGACY/alternative** route. The
> **active** path is `depth_lidar_fusion` → `scan_fused`, which is the **single** fused source
> wired into both Nav2 and SLAM (see [Wiring: `scan_fused` is the single source](#built-inject-depth-into-the-lidar-scan-depth_lidar_fusion)).
> Keep this section for the standalone `oakd/scan` costmap-only option (`depth_perception.launch.py`).

All standard packages:

```
OAK-D depth image (640×480, 16UC1)
   │  depth_image_proc::PointCloudXyzNode
   ▼
/turtlebot468/oakd/points  (3D PointCloud2)
   │  pointcloud_to_laserscan  —  HEIGHT FILTER: keep 0.06–0.50 m, drop floor
   ▼
/turtlebot468/oakd/scan  (2D LaserScan in base_link)
   │  added as 2nd obstacle source in nav2_glass.yaml
   ▼
Nav2 costmaps  →  planner avoids the glass door
```

**The key trick — height filtering.** The metal base sits *below* the camera's optical axis.
A flat single-height scan (the lidar, or stock `depthimage_to_laserscan` which takes a row
band) would either miss the low base or — if widened — read the **floor** as obstacles
everywhere. Going through a **3D cloud and keeping only points 0.06–0.50 m above the floor**
keeps the base and drops the floor.

**Validation** (robot facing the glass wall): `oakd/scan` showed **65 returns clustered at
0.32–0.35 m** ahead (the metal base) and **zero floor false-positives**. ✅

## Compute: the bottleneck and the fix
- **Current path is slow:** the full 640×480 (~307k-point) `PointCloud2` is built, serialized
  (~5 MB) over DDS, then deserialized + transformed by the next node → caps at **~0.9 Hz**.
  The cost is the giant message round-trip, not the math. That's why robot speed is capped to
  0.15 m/s.
- **Planned fix — vertical collapse (benchmarked on this Pi: ~16 ms/frame):** collapse each
  depth **column** to its nearest non-floor point in one numpy pass, straight to a 640-beam
  scan — no intermediate cloud. For a horizontal camera each column = one fixed bearing, so:
  - per-pixel height `= h_cam − (v−cy)·depth/fy`,
  - mask `0.06 < height < 0.5` and `0.25 < depth < 5` (floor + range),
  - horizontal range `= depth · k_u` (`k_u` precomputed per column),
  - **min over each column** → the scan.
  - Cost: ~8% of a core at 5 Hz, ~16% at 10 Hz (ceiling ~62 Hz). ~10× the rate of the
    pointcloud path at similar CPU.

It's a small **custom node** (no stock node does height-filtered collapse — it's a
"height-aware `depthimage_to_laserscan`").

## Built: inject depth into the lidar scan (`depth_lidar_fusion`)
Instead of a separate `oakd/scan` costmap source, the `depth_lidar_fusion` node **folds the
depth obstacles into the lidar scan**. The fused scan then flows to *everything that uses the
scan* — slam_toolbox **and** the costmaps — so the glass also lands in the **SLAM map** (the
original "depth in the mapping" goal).

**What it does, per frame:**
1. **Collapse** the depth image per column to the nearest pixel inside the height band
   (`height ∈ [0.06, 0.50] m`) — drops the floor, keeps the metal base. The floor reference is
   **data-driven** (see below), not assumed. One vectorised numpy pass over 640 columns.
2. **Back-project** those ≤640 points and transform them into the **lidar frame** with a
   one-time static TF lookup (`scan_frame ← optical_frame`). Working in x/y rather than bearing
   is what accounts for the ~2 cm lidar↔camera offset.
3. **Min-inject** onto the lidar beam grid: `range[beam] = min(lidar, depth)` over the forward
   wedge. Where the lidar sees *through* glass to a far wall, the depth injects the near base.
   Injection **only ever lowers a beam** (or fills an empty one) — it never erases a real lidar
   return.

**Wiring / toggle — `scan_fused` is now the single source.** The raw lidar stays untouched on
`scan`; the node publishes the fused scan on `scan_fused` (both topic names are params).
`scan_fused` is now the **single fused obstacle source for both Nav2 and SLAM** — this is
already wired in the configs (the old "separate `oakd/scan` as a 2nd costmap source" design is
**retired**):

| Config | Setting | Effect | Revert to raw lidar |
|---|---|---|---|
| `nav2_glass.yaml` | local **and** global costmaps `observation_sources: scan` → `topic: scan_fused` | glass enters the live costmap | set `topic: scan` |
| `slam_fused.yaml` | `scan_topic: scan_fused` | glass enters the **SLAM map**, not just the runtime costmap | set `scan_topic: scan` |

If depth goes **stale** (older than `max_depth_age`, default 0.4 s) the node passes the raw
lidar straight through, so a camera dropout is graceful. `autonomous_mapping.launch.py`
self-starts the full producer chain staggered by `TimerAction`s (OAK-D `camera_node` →
`depth_lidar_fusion` → SLAM `slam_fused.yaml` + Nav2 `nav2_glass.yaml` → `glass_guard` →
`bfs_explorer`), so you do **not** run `depth_perception.launch.py` first; pass
`start_camera:=false` if the camera is already up (e.g. the manual USB2 bring-up).

**Offline validation** (synthetic wall 1.0 m ahead, no robot needed): the collapse produced
one point per column over a **±38° wedge** (= the camera HFOV), ranges 1.02–1.30 m (nearest
straight ahead, farther at oblique edges); injection lowered exactly the forward-wedge beams,
left the rest at the lidar range, **raised no beam**, and stale depth fell back to the raw
lidar. ✅ Geometry and min-combine logic confirmed before any on-robot run.

**Hardware-validated on robot 468** (facing the glass wall): depth saw the metal base on
**205 beams over 0.37–1.63 m** where the lidar was blind or saw straight through, and fusion
**injected 195** of them (raised 0). ✅ So the fusion node itself is confirmed on real
hardware. **Still pending on-robot:** the SLAM-map localization sanity check (map stays crisp,
no double-walls) and a full autonomous mapping run — `scan_fused` is now wired into the SLAM +
Nav2 configs (that part is **done**), but the localization behaviour hasn't been checked live.

**Tradeoff (why this was initially avoided, and what changed):** a *slow, held* depth scan
would smear the map and could degrade slam_toolbox's scan-matching, so we first kept depth in
the costmap only. With the **fast collapse** (fresh ~10 Hz) and **min-combine of only the
confident static base**, injecting becomes reasonable — but it now touches **localization**,
so the remaining step is an on-robot sanity check (map stays crisp, no double-walls). The
`scan`/`scan_fused` split keeps it instantly revertible.

## C++ port (`guide_mate_perception`)
**Motivation.** The Pi-4 is compute-bound (≈1 core for `slam_toolbox` alone; it can't
comfortably run SLAM + Nav2 + depth together). The Python `depth_lidar_fusion` node is
GIL/CPU-bound — its per-frame work (TF lookups, depth-image indexing, the numpy collapse) all
contends for the interpreter — so it needs its own core. `guide_mate_perception` is a faithful
**rclcpp port** of the fusion node that is roughly **~10× cheaper on TF/image handling** on the
Pi-4. It **mirrors the Python numerics** (same ground-plane fit, per-column collapse,
min-inject, FOV-vs-`camera_info` selection, drop detection) and produces the **same
`scan_fused`** output with the same node behaviour, so it drops straight into the existing
SLAM + Nav2 wiring above.

```bash
# C++ fusion (alternative to the Python depth_lidar_fusion)
ros2 launch guide_mate_perception depth_lidar_fusion_cpp.launch.py namespace:=turtlebot468
```

**Run the Python OR the C++ fusion node — never both** (they publish the same `scan_fused`).
This is also why the **combined runner** keeps fusion separate: `guide_mate_explorer`'s
`combined_node.py` (entry point `guide_mate_bringup`, plus `combined.launch.py`) runs
`glass_guard` + `bfs_explorer` in **one process under one executor** — paying the
rclpy/DDS per-node overhead once — but **deliberately excludes** `depth_lidar_fusion`, because
the fusion node is CPU/GIL-bound and should keep its **own core** (which is exactly what the
C++ port is for). The individual `ros2 run` entry points still work.

> **Two colcon packages now live in `src/`:**
> - `guide_mate_explorer` (Python): `bfs_explorer`, `glass_guard`, `depth_lidar_fusion`.
> - `guide_mate_perception` (C++): rclcpp ports of **all three** nodes **plus a shared-TF
>   `guide_mate_container`** (one `/tf` listener for all). ~10–17× cheaper; benchmarks +
>   details in [`src/guide_mate_perception/README.md`](../../src/guide_mate_perception/README.md).

The C++ effort grew beyond fusion: `bfs_explorer` and `glass_guard` were ported too, and the
**shared-TF container** removes the real Pi-4 tax — each node's own `TransformListener`
deserializing the ~31 Hz `/tf` stream (~16% of a core *per node*). One injected
`tf2_ros::Buffer` parses `/tf` once; the GIL-free `MultiThreadedExecutor` spreads callbacks
across cores. Bundling the *Python* nodes did **not** help — the cost is per-listener, not
per-process — which is what makes the C++ container the actual fix.

## Ground (floor) detection — data-driven
Removing the floor is the make-or-break step: leak it and the robot treats clear floor as a
wall; over-cut it and you lose the low glass base. A *fixed* height band assumes the camera is
perfectly level at an **exactly** known height over a flat floor — and the OAK intrinsics here
are only approximate (the camera_info mismatch above), so that assumption is shaky.

Instead `depth_lidar_fusion` fits the floor **from each frame**. For a level camera every floor
pixel obeys a straight line in (inverse-depth, row) space:

```
v = A·(1/z) + B          with  A = camera_height·fy,  B ≈ cy
```

independent of column. We take the **per-row median inverse-depth** of the lower image (the
median rejects the minority of obstacle pixels in each row), robustly fit that line (least
squares + MAD outlier rejection), EMA-smooth it across frames, and compute height above the
**fitted** floor: `height = (A + (B − v)·z)/fy`. This self-calibrates camera **height and
pitch** every frame. A sanity bound on `A` (camera height ∈ [0.10, 0.45] m) plus a frame
counter make it **fall back** to the assumed model when the floor isn't reliably in view, so it
never locks onto a near wall as if it were the floor.

**Offline-validated:** with a deliberately wrong assumed height (0.35 m vs a true 0.244 m
floor), the fixed band leaked the **entire floor** (134k px) as fake obstacles, while the
data-driven fit recovered the true 0.244 m → **zero floor leak**, base kept. It also tracked a
pitched floor (recovered the shifted intercept) and fell back correctly facing a wall.
Cost ≈ +2–4 ms/frame. Toggle with `ground_estimation`; tune via the `ground_*` params.

## Drops (negative obstacles)
A guide robot must also not drive off a ledge or down stairs — the mirror image of a positive
obstacle. Two depth layers ride on the same fitted floor, plus a hardware backstop:

1. **Below-floor returns ("convert negatives to positives").** A return whose height is
   `−0.50 … −0.06 m` (below the plane) is flagged like a positive one. One line; catches a
   *visible* step-down.
2. **Missing-floor edge (`_drop_edges`).** The important one. Because the camera is mounted
   **level**, a drop's bottom is **occluded behind its lip** — so a real ledge gives **no
   return where the floor should be**, not a below-plane return. So we walk each column near→far
   along the expected floor `z = A/(v−B)`; if it goes missing (no return / falls away) for
   several consecutive rows *before* any nearer surface occludes it, we flag the **near edge**
   as an obstacle (the cliff thus becomes a positive in the costmap, detected at the right
   place). `abs()` alone would silently miss exactly these stairs/cliffs.
3. **Create 3 cliff sensors (pending).** The level camera only sees the floor from ~0.44 m out,
   so a foot-level drop is in its blind zone — the base's hardware cliff IR (the `CLIFF` hazard,
   same channel `glass_guard` reads for `BUMP`) must backstop that. *(TODO, needs the robot.)*

**Offline-validated:** a cliff (void) is flagged at the correct near-edge range (~1.5 m), a
partial cliff is localized to the right columns, flat floor and walls produce **zero** false
drops, and `_depth_cb` emits positive + drop obstacles together end-to-end. Toggle
`drop_detection`; tune `drop_*`.

## Parameters worth knowing
| Where | Param | Value | Why |
|---|---|---|---|
| camera | `i_usb_speed` | `HIGH` | depth-only is stable on either bus; USB2 lowest draw (only heavy-RGBD+USB3 brownouts) |
| camera | `i_nn_type` | `none` | drop the mobilenet NN (load + crash) |
| camera | `left/right.i_fps` | `6.0` | depth fps follows the mono cams; keep light |
| camera | `stereo.i_align_depth` | `false` | use mono 640×480, fewer points than RGB-aligned 720p |
| pipeline | height band | `0.06–0.50 m` | keep metal base, drop floor; cap below robot height |
| Nav2 | `max_vel_x` | `0.15` | slow while depth scan is low-rate |
