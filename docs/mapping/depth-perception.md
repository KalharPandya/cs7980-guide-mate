# Depth camera for mapping — glass detection, FOV, pipeline, plan

How we use the **OAK-D-LITE depth camera** to see what the 2D lidar can't (glass doors,
low objects, overhangs), and turn it into obstacles for mapping/navigation on robot **468**.

**TL;DR:** Depth → 3D pointcloud → **height-filtered** 2D scan keeps the glass doors' metal
base (~5–30 cm) while dropping the floor. Validated: it sees the base at ~0.32 m. The full
pointcloud path is slow on the Pi (~0.9 Hz), so the `depth_lidar_fusion` node does a cheap
**vertical-collapse** (~16 ms/frame) and **injects into the lidar scan** (`scan_fused`) so
glass enters the SLAM map. Built and offline-validated; on-robot localization check pending.

---

## Why depth (and what it can/can't see)
The RPLIDAR sees one horizontal plane at ~0.19 m and is **blind to glass**. The glass doors,
though, have a **metal base/frame below the lidar plane** — and the depth camera's vertical
FOV catches it. The **clear pane itself is invisible to depth too** (IR passes through / no
texture), so depth detects the door *by its frame*; the bumper (`glass_guard`) backstops the
fully-transparent gaps.

## Camera bring-up
- Driver: `depthai_ros_driver` (standard). The camera does **not** start by default and
  **boot-loops on USB3** (power) — bring it up forced to **USB2** (`i_usb_speed:=HIGH`),
  no NN (`i_nn_type:=none`), depth only. See [`../camera/oak-d-camera-test.md`](../camera/oak-d-camera-test.md).
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

## The pipeline (current)
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

**Wiring / toggle.** The raw lidar stays untouched on `scan`; the node publishes the fused
scan on `scan_fused` (both topic names are params). To enable fusion, point slam_toolbox's
`scan_topic` and the Nav2 costmap observation source at `scan_fused`; to revert, point them
back at `scan`. If depth goes **stale** (older than `max_depth_age`, default 0.4 s) the node
passes the raw lidar straight through, so a camera dropout is graceful.

**Offline validation** (synthetic wall 1.0 m ahead, no robot needed): the collapse produced
one point per column over a **±38° wedge** (= the camera HFOV), ranges 1.02–1.30 m (nearest
straight ahead, farther at oblique edges); injection lowered exactly the forward-wedge beams,
left the rest at the lidar range, **raised no beam**, and stale depth fell back to the raw
lidar. ✅ Geometry and min-combine logic confirmed before any on-robot run.

**Tradeoff (why this was initially avoided, and what changed):** a *slow, held* depth scan
would smear the map and could degrade slam_toolbox's scan-matching, so we first kept depth in
the costmap only. With the **fast collapse** (fresh ~10 Hz) and **min-combine of only the
confident static base**, injecting becomes reasonable — but it now touches **localization**,
so the remaining step is an on-robot sanity check (map stays crisp, no double-walls). The
`scan`/`scan_fused` split keeps it instantly revertible.

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
| camera | `i_usb_speed` | `HIGH` | USB3 boot-loops (power) |
| camera | `i_nn_type` | `none` | drop the mobilenet NN (load + crash) |
| camera | `left/right.i_fps` | `6.0` | depth fps follows the mono cams; keep light |
| camera | `stereo.i_align_depth` | `false` | use mono 640×480, fewer points than RGB-aligned 720p |
| pipeline | height band | `0.06–0.50 m` | keep metal base, drop floor; cap below robot height |
| Nav2 | `max_vel_x` | `0.15` | slow while depth scan is low-rate |
