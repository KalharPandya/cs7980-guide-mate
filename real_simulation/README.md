# real_simulation — two-robot guide relay (Gazebo)

A **two-robot "guide relay"** simulation: you type a request in a chat box
("lead me from the kitchen to the bathroom") and two TurtleBot 4s hand a person across a
logical wall — **robot_1** leads to the door and stops, **robot_2** takes over and leads to
the destination. Built on **ROS 2 Jazzy + Gazebo (`gz sim`)**, validated on WSL2.

> This is the **navigation** simulation track (Bai's capstone part). It is **separate from**
> the repo's other `sim/` folder (Kalhar's TurtleBot 4 **Ignition/Humble** motion-over-IoT
> probe) and from the `agent_service/` cloud stack. Nothing here depends on AWS — it is fully
> local ROS 2. The one clean seam to the rest of the project: the dispatcher's input is a
> mission `{origin, destination}`, which a chat box (here) or a cloud agent (later) can produce.

Full design + validation log: [`DESIGN.md`](DESIGN.md). Required host setup: [`SETUP.md`](SETUP.md).

---

## Prerequisites (read `SETUP.md` first)

The stack needs a few **host-level modifications that do NOT travel with git** (software
rendering, a WSL networking mode, and three vendor `/opt/ros/...` edits — the driving fix,
the `cmd_vel_timeout` bump, and the disabled OAK-D camera). A fresh clone will **not drive**
until these are applied. See [`SETUP.md`](SETUP.md) — most are one command:
```bash
sudo python3 real_simulation/setup_vendor_fixes.sh     # applies the scriptable /opt fixes
```

Also required: ROS 2 Jazzy + `turtlebot4_gz` / `turtlebot4_navigation` / `ros_gz` installed,
and the `maze` world available (it ships with `turtlebot4_gz_bringup`).

---

## Quick start (verify the demo in RViz)

Run each command **in its own terminal**, in order. Scripts are self-locating, so run them
from the repo root as shown.

```bash
# 0) Preflight — kill stale procs, wait for load to settle (do this every time)
bash real_simulation/clean.sh

# 1) Sim: robot_1 in its own gz partition, spawned at the kitchen
bash real_simulation/sim_r1.sh
#    wait for:  "Configured and activated diffdrive_controller"

# 2) Localization + Nav2 for robot_1
bash real_simulation/nav2/nav_r1.sh
#    wait for:  "lifecycle_manager_navigation ... Managed nodes are active"

# 3) TF merge (REQUIRED for RViz — robot TF is private on /robot_1/tf)
python3 real_simulation/nav2/tf_relay.py

# 4) RViz (map + robot + laser scan + planned path)
bash real_simulation/rviz.sh

# 5) Chat front-end
python3 real_simulation/chat_server.py
#    open http://127.0.0.1:8080, set the dropdown to "Leg 1",
#    type: lead me from the kitchen to the bathroom
```

**What success looks like:** in RViz, robot_1 plans a path and drives from the kitchen to the
door, then stops; the chat replies `✅ mission complete`. (Motion is slow — the sim runs
below real-time under RViz load; fine for a recording.)

### Leg 2 (robot_2: door → bathroom)
Tear down and swap robots — **one robot's sim runs at a time** (see Gotchas):
```bash
bash real_simulation/clean.sh
bash real_simulation/sim_r2.sh          # robot_2 spawned at the door
bash real_simulation/nav2/nav_r2.sh
python3 real_simulation/nav2/tf_relay.py
bash real_simulation/rviz.sh
python3 real_simulation/chat_server.py  # pick "Leg 2"
```

### Skip the web UI (drive directly)
```bash
source /opt/ros/jazzy/setup.bash
python3 real_simulation/dispatcher.py --origin kitchen --dest bathroom --only leg1
```

---

## Architecture (one paragraph)

```
chat box ──► chat_intent.py ──► dispatcher.py ──► Nav2 (per robot) ──► gz sim
 (text)      {origin,dest}      mission FSM        NavigateToPose      (1 partition/robot)
```
`chat_intent.py` turns free text into a mission `{origin, destination}` — **LLM-first**
(Anthropic Claude, constrained to emit that JSON) with a **zero-dependency keyword fallback**
so it runs with no API key. `dispatcher.py` is a sequential **finite-state machine on top of
Nav2**: it holds one `NavigateToPose` client per robot and sequences LEG1 (lead robot → door,
stop) → hand-off → LEG2 (follow robot → destination). The "wall" is **logical** — the
dispatcher simply never routes a robot past the midline. Each robot runs in its **own gz
partition** (`GZ_PARTITION`) sharing one ROS graph, so one dispatcher + one RViz see both.
Details, coordinates, and the validation log are in [`DESIGN.md`](DESIGN.md).

---

## Gotchas (the ones that cost real time)

- **One robot's sim at a time.** Two full software-rendered gz sims + two Nav2 stacks
  overwhelm a laptop/WSL box. The relay is sequential, so this is fine — record LEG1, then
  LEG2. (True simultaneous needs a beefier host.)
- **`cmd_vel_timeout` / low RTF.** Under RViz load the sim runs slow, and Nav2's velocity
  commands arrive "stale" in sim-time; the controller drops them and the robot won't move.
  Fixed by raising `cmd_vel_timeout` to 5.0 (`SETUP.md` / `setup_vendor_fixes.sh`).
- **Global `/clock`, one sim.** The in-gz controller needs the global `/clock`; do not
  namespace it (freezes odometry). Running one sim at a time keeps a single `/clock` publisher.
- **Startup flakiness.** `gz_ros2_control` occasionally stalls ("Waiting for data on
  robot_description") and Nav2 lifecycle can time out under load. **Always** `clean.sh` first;
  a clean relaunch works. Stale processes accumulate — `clean.sh` clears them.
- **Software rendering is mandatory** (GPU/d3d12 breaks gz lidar). Baked into the scripts.

---

## File map

| Path | Role |
|---|---|
| `chat_intent.py` | free text → mission JSON (LLM + keyword fallback) |
| `chat_server.py` | stdlib chat web page + `/api/chat` + `/api/run` → dispatcher |
| `dispatcher.py` | mission FSM over Nav2 (`--origin/--dest/--only leg1\|leg2\|full`) |
| `sim_partition.launch.py`, `sim_r1.sh`, `sim_r2.sh` | per-robot partitioned gz sim |
| `nav2/nav_bringup_ns.launch.py`, `nav_r1.sh`, `nav_r2.sh` | per-robot AMCL + Nav2 |
| `nav2/*_maze*.yaml` | AMCL + Nav2 params (robot_1 / robot_2 frames) |
| `nav2/tf_relay.py` | merge private per-robot TF → global `/tf` for RViz |
| `nav2/two_robot.rviz` | RViz config (map + scans + paths) |
| `nav2/send_goal_ns.py` | send one NavigateToPose goal to a chosen robot (debug) |
| `maps/maze_truth.*` | ground-truth world-frame map |
| `clean.sh`, `rviz.sh` | preflight cleanup / launch RViz |
| `set_cmdvel_timeout.py`, `strip_sensors.py`, `setup_vendor_fixes.sh` | host `/opt` fixes |
| `tools/` | `sdf_to_map.py` (world→map), `scan_check.py` (map validation) |
| `legacy/` | superseded attempts (one-world sim, old single-robot scripts) — reference only |
