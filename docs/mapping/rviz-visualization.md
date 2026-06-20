# Viewing live mapping in RViz (from the laptop)

How to watch robot **468**'s ongoing SLAM — the occupancy **map**, **lidar** returns, the
**depth-derived scan**, the **OAK-D point cloud**, and the robot model — in RViz on a laptop
that is a Discovery-Server super-client (see [ros2-over-nuwave.md](../network/ros2-over-nuwave.md)).

**TL;DR:** Run [`rviz/launch_rviz.sh`](../../rviz/launch_rviz.sh). It loads
[`rviz/turtlebot468_mapping.rviz`](../../rviz/turtlebot468_mapping.rviz) and — critically —
**remaps `/tf` and `/tf_static` into the `/turtlebot468/` namespace**, without which every
display shows "No transform" and the view is empty.

```bash
./rviz/launch_rviz.sh            # sources ROS, sets the super-client env, remaps tf, opens RViz
```

Fixed frame is **`map`**. The robot drives ~metres from the map origin, so the offset is normal.

---

## What you see

| Display | Topic | Notes |
|---|---|---|
| **Map** | `/turtlebot468/map` | SLAM Toolbox occupancy grid. **Transient-Local** QoS (latched). |
| **scan / RPLidar (red)** | `/turtlebot468/scan` | small **red** points, frame `rplidar_link` (~8 Hz). |
| **scan_fused (green)** | `/turtlebot468/scan_fused` | larger **green** squares — raw lidar with depth min-injected. Drawn behind `scan` so a **lone green** point (no red) marks where depth added a closer return; see comparison note below. |
| **LaserScan (Depth)** | `/turtlebot468/oakd/scan` | blue points — the height-filtered depth scan that catches glass. |
| **PointCloud2 (OAK-D)** | `/turtlebot468/oakd/points` | depth cloud, coloured by height (Z). |
| **OAK-D Stereo Image** | `/turtlebot468/oakd/stereo/image_raw` | raw depth/stereo image panel. |
| **RobotModel (Lite)** | `/lite_description` | the TB4 **Lite** URDF — see the model gotcha below. |
| **TF** | `/turtlebot468/tf(_static)` | frame axes; chain is `map → odom → base_link → …`. |

### Comparing `scan` vs `scan_fused`
Both are in frame `rplidar_link`, so they overlay directly. `scan_fused` is the raw lidar with
the depth scan **min-injected** (only ever *lowers* a beam toward a closer obstacle — see
[depth-perception.md](depth-perception.md)). To tell them apart the config uses **colour + size**:
raw `scan` is small **red** points, `scan_fused` is larger **green** squares drawn behind it.

- **Red dot inside a green halo** → unchanged: fusion kept the lidar return.
- **Lone green square (no red)** → fusion injected a **closer** point here — i.e. depth caught
  something the lidar missed (glass frame / low object). This is the signal you're looking for.

> **QoS:** `scan_fused`'s publisher is **Best Effort** (despite being a derived scan), so its
> display must be **Best Effort** — a Reliable subscriber gets *nothing* and logs
> "incompatible QoS". All raw sensor scans here are Best Effort too.

---

## Hard-won constraints (read before debugging an empty/odd view)

1. **Namespaced TF must be remapped.** TF is published on `/turtlebot468/tf` and
   `/turtlebot468/tf_static`, but RViz subscribes to the bare `/tf` / `/tf_static`. Launch
   with `--ros-args -r /tf:=/turtlebot468/tf -r /tf_static:=/turtlebot468/tf_static`
   (the launcher does this). Same constraint as the mapping nodes — see
   [mapping/README.md](README.md#hard-won-constraints-read-before-debugging).

2. **Sensor topics need Best-Effort QoS.** `scan`, `oakd/scan`, `oakd/points`, and the stereo
   image are published Best Effort; a Reliable RViz subscriber silently receives **nothing**
   ("incompatible QoS" warning in the log). The config sets these displays to Best Effort and
   the **Map** to Reliable + **Transient Local** (otherwise the latched map never arrives).

3. **The robot publishes the wrong robot model — it advertises the Standard URDF, but 468 is a
   Lite.** Pointing RViz at `/turtlebot468/robot_description` renders the tall two-tier
   "tower" Standard chassis (looks like *two* robots / a two-floor robot), not the flat,
   Roomba-like Lite. Fix **without touching the robot** (keeps the live SLAM session): publish
   the Lite URDF locally on a side topic and point RViz there.

   ```bash
   # generate the Lite URDF (frame names match the robot's TF: base_link, rplidar_link, oakd_*, wheels)
   xacro /opt/ros/humble/share/turtlebot4_description/urdf/lite/turtlebot4.urdf.xacro > /tmp/tb4_lite.urdf

   # publish ONLY the geometry on /lite_description; send its own TF to dead topics so it
   # can never collide with the robot's /turtlebot468/tf (RViz places links from the robot's TF)
   ros2 run robot_state_publisher robot_state_publisher /tmp/tb4_lite.urdf --ros-args \
     -r __node:=lite_description_publisher \
     -r robot_description:=/lite_description \
     -r /tf:=/lite_rsp_unused/tf -r /tf_static:=/lite_rsp_unused/tf_static
   ```
   The RViz config's RobotModel already points at `/lite_description`.
   **Permanent fix (robot-side, disruptive):** relaunch the robot's bringup with `model:=lite`
   so it advertises the correct description and TF — but that restarts the stack (~30 s) and
   **resets the current map**, so only do it between mapping runs.

---

## Benign log lines (not errors)
- `GLSL link result : active samplers ... same texture image unit` — RViz shader warning, cosmetic.
- `Lookup would require extrapolation into the future ... rplidar_link → map` — sub-millisecond
  laptop↔robot clock skew; the next scan resolves. Persistent floods mean real clock drift
  (see the time-sync note in the [network README](../network/README.md)).
- `Message Filter dropping message ... queue is full` — transient during discovery/startup.

## If RViz won't stay open when launched in the background
Launching detached can get the process reaped. Use `setsid` so it lives in its own session:
```bash
setsid ./rviz/launch_rviz.sh </dev/null >/tmp/rviz2.log 2>&1 &
```
