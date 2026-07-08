# P8 Task 2 report — TurtleBot 4 Ignition sim bring-up + ROS-graph probe

**Status:** DONE. Sim brought up headless-equivalent, graph probed, facts recorded, clean shutdown verified.

## Deliverables
- `sim/sim_facts.env` — verified KEY=value facts.
- `sim/README.md` — bring-up command, timing, and gotchas.

## Environment note
The brief file `.superpowers/sdd/p8-task-2-brief.md` does **not exist** anywhere in the repo
(only `p8-task-1-brief.md` is present). Proceeded from the controller's task description, which
specified the schema and every verification target. Flagging so the brief can be added if the
schema needs to match something exact.

## Bring-up
- Launch: `ros2 launch turtlebot4_ignition_bringup turtlebot4_ignition.launch.py slam:=false nav2:=false localization:=false rviz:=false model:=standard`
- World `warehouse`, model `standard`, robot spawns **docked**.
- No `headless` arg exists in this launch and `xvfb-run` is not installed; `QT_QPA_PLATFORM=offscreen`
  **segfaults the Ogre2 render engine**. Ran with `DISPLAY=:0` (GUI on the physical monitor, GPU-backed) —
  ROS graph is identical and load is fine on the NVIDIA GPU.
- Bring-up time: **~40 s** to a fully activated graph (Gazebo models already cached from earlier attempts).
  First-ever run fetches Fuel models → **2–4 min** (allow internet). Controllers activate ~16 s in.

## Key verified facts (all UN-namespaced — namespace is empty '')
| Role | Name | Type |
|------|------|------|
| cmd_vel | `/cmd_vel` | `geometry_msgs/msg/Twist` |
| odom | `/odom` | `nav_msgs/msg/Odometry` (~40 Hz) |
| dock status | `/dock_status` | `irobot_create_msgs/msg/DockStatus`, field `is_docked` (bool), `dock_visible` (bool); at start `is_docked: true` |
| battery | `/battery_state` | `sensor_msgs/msg/BatteryState` (percentage 1.0) |
| undock | `/undock` (action) | `irobot_create_msgs/action/Undock` — matches brief expectation |
| dock | `/dock` (action) | `irobot_create_msgs/action/Dock` — matches brief expectation |
| lidar | `/scan` | `sensor_msgs/msg/LaserScan` |

Full create-3 action set also present (`/drive_arc`, `/drive_distance`, `/rotate_angle`,
`/navigate_to_position`, `/wall_follow`, etc.) and an OAK-D RGBD camera under `/oakd/rgb/preview/...`.

## Gotchas found (documented in sim/README.md)
1. **`ROS_DISCOVERY_SERVER=10.247.204.21:11811` is set by the login profile** (the Pi's server).
   It breaks the sim's internal discovery (create spawner hangs on `robot_description`,
   controller_manager services never appear) AND probe shells see zero nodes. **Must `unset`** it.
2. **`ros2 daemon` caches the stale discovery env** — must `ros2 daemon stop && start` after unsetting.
3. **Offscreen Qt platform segfaults Ogre2** — do not use; use `DISPLAY=:0`.
4. `ign gazebo` forks its **server and GUI into separate process groups** — clean shutdown must kill
   all three PGIDs (launch group + `ign gazebo server` + `ign gazebo gui`), not just the launch group.

## Shutdown
Killed all three process groups by PID (TERM then KILL); `ros2 daemon stop`. Verified: **zero**
leftover ign/gazebo/ros_gz/turtlebot4 processes.

## Concerns
- Missing brief (above) — schema is my best-effort per the task description.
- "Headless" not literally achievable on this box (no arg, no xvfb, offscreen crashes); ran GUI on `:0`.
  Load was fine; note if a truly windowless run is required (would need installing xvfb or patching the launch to add `-s`).
