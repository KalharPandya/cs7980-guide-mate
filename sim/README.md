# TurtleBot 4 Ignition sim — bring-up & probe notes (Phase-8 Task 2)

Verified facts live in [`sim_facts.env`](sim_facts.env). This file records **how** to bring
the sim up on this box and the gotchas that cost real time.

## TL;DR
- Box: ROS 2 Humble + **Ignition Fortress** (Gazebo Sim v6) + `turtlebot4_ignition_bringup` + NVIDIA GPU + real X display `:0`.
- Bring-up (probe config — SLAM/Nav2/RViz OFF):
  ```bash
  source /opt/ros/humble/setup.bash
  unset ROS_DISCOVERY_SERVER          # <-- REQUIRED on this box, see gotcha #1
  export DISPLAY=:0                    # GUI renders on the physical monitor via the GPU
  ros2 launch turtlebot4_ignition_bringup turtlebot4_ignition.launch.py \
      slam:=false nav2:=false localization:=false rviz:=false model:=standard
  ```
- **Bring-up time:** ~40 s to a fully activated graph **when the warehouse Gazebo models are
  already cached**. A truly first-ever run fetches models from Fuel and can take **2–4 min**
  (allow internet). Controllers (`joint_state_broadcaster`, `diffdrive_controller`) activate
  ~16 s in; `turtlebot4_node` services settle a few seconds later.
- Robot spawns **docked** in the `warehouse` world at the origin.

## Everything is UN-namespaced (important)
The launch's default `namespace` is `''`. Topics/actions are at the **root**: `/cmd_vel`,
`/odom`, `/dock_status`, `/battery_state`, `/undock`, `/dock`. This is **different from the
real robot 468**, where everything is under `/turtlebot468/...`. Bridge code that targets the
sim must NOT assume a namespace prefix (or must pass `namespace:=turtlebot4` to add one).

## Key verified interfaces (see sim_facts.env for the full list)
| Role | Topic/Action | Type |
|------|--------------|------|
| Velocity cmd | `/cmd_vel` | `geometry_msgs/msg/Twist` |
| Odometry | `/odom` | `nav_msgs/msg/Odometry` (~40 Hz) |
| Dock status | `/dock_status` | `irobot_create_msgs/msg/DockStatus` (`is_docked` bool, `dock_visible` bool) |
| Battery | `/battery_state` | `sensor_msgs/msg/BatteryState` |
| Undock | `/undock` (action) | `irobot_create_msgs/action/Undock` |
| Dock | `/dock` (action) | `irobot_create_msgs/action/Dock` |
| Lidar | `/scan` | `sensor_msgs/msg/LaserScan` |

At probe time `/dock_status` reported `is_docked: true`, `dock_visible: true`; `/battery_state`
`percentage: 1.0`, `voltage: 16.47`. The brief's expected action names/types
(`/undock` → `irobot_create_msgs/action/Undock`, `/dock` → `.../Dock`) are **confirmed**.
Also present: full create-3 action set (`/drive_arc`, `/drive_distance`, `/rotate_angle`,
`/navigate_to_position`, `/wall_follow`, `/led_animation`, `/audio_note_sequence`) and an
OAK-D depth camera under `/oakd/rgb/preview/...`.

## Gotchas (each cost debugging time)

1. **`ROS_DISCOVERY_SERVER` in the login profile breaks the sim.** This box's profile exports
   `ROS_DISCOVERY_SERVER=10.247.204.21:11811` (the Pi's FastDDS Discovery Server). With it set,
   the sim's own nodes can't discover each other (the `create` spawner hangs forever on
   `Waiting messages on topic [robot_description]`, `controller_manager` services never appear)
   **and** `ros2 node list` from a probe shell returns empty. **Fix: `unset ROS_DISCOVERY_SERVER`**
   in both the launch shell and every probe shell — the sim is all-local, default multicast
   discovery is correct here.

2. **`ros2 daemon` caches the old discovery env.** Even after unsetting the var, an already-running
   `ros2` daemon (started earlier with the server set) keeps returning an empty graph. Run
   `ros2 daemon stop && ros2 daemon start` (with the var unset) once, then the CLI sees all nodes.

3. **Do NOT run the GUI with `QT_QPA_PLATFORM=offscreen`.** This launch always starts the
   Ignition GUI (`ign gazebo -r`, no `-s`/headless flag exists). Forcing the Qt offscreen
   platform makes the **Ogre2 render engine segfault** on init, killing the whole sim. There is
   no `headless` launch arg and `xvfb-run` is not installed on this box. The reliable path is
   `DISPLAY=:0` so the GUI renders on the physical monitor through the NVIDIA GPU (no perf issue;
   ROS graph is identical with or without a visible GUI). The QML `control is not defined`
   warnings from `Turtlebot4Hmi.qml` are harmless.

4. **`Desired controller update period (0.001 s) is faster than the gazebo simulation period
   (0.003 s)`** and a few early `diffdrive_controller: Can't accept new commands. subscriber is
   inactive` / `turtlebot4_node: Service oakd/stop_camera unavailable` messages appear during
   start-up. These are benign start-up ordering noise; the controllers activate normally.

## Clean shutdown
The launch is started in its own process group (`setsid`). Shut down by **killing the process
group by PID**, never `pkill -f`:
```bash
kill -TERM -<PGID>   # PGID = the ros2 launch PID
sleep 3; kill -KILL -<PGID> 2>/dev/null
# verify: ps -eo pid,args | grep -iE 'ign gazebo|ros_gz|parameter_bridge|turtlebot4' | grep -v grep
```
