# SETUP — required host modifications

⚠️ **These changes live OUTSIDE this folder (in `/opt/ros/...` and Windows/WSL config) and do
NOT travel with `git clone`.** A fresh checkout will spawn robots but they will **not drive**
(or the sim will be too slow to drive) until you reproduce them. This mirrors the "required
system modifications" section every hardware runbook in this repo carries.

Everything here was validated on **WSL2 (Ubuntu) + ROS 2 Jazzy + Gazebo `gz sim`**.

## TL;DR

```bash
# scriptable /opt fixes (driving fix + cmd_vel_timeout) — idempotent, backs up originals
sudo python3 real_simulation/setup_vendor_fixes.sh
```
Then do the **two manual steps** below (OAK-D camera off; WSL NAT networking) once per machine.

---

## 1. Vendor edits in `/opt/ros/jazzy` (needs sudo)

| # | What | File | Why |
|---|------|------|-----|
| 1 | `safety_override: 'full'` + `reflexes_enabled: False` in the `motion_control` node params | `irobot_create_common_bringup/launch/create3_nodes.launch.py` | **The driving fix.** Without it the Create 3 refuses Nav2 velocities ("Ignoring velocities commanded while an autonomous behavior is running"). |
| 2 | `cmd_vel_timeout: 5.0` (was `0.5`) | `irobot_create_control/config/control.yaml` | Under low RTF (e.g. RViz running) Nav2's velocities arrive "stale" in sim-time and the diffdrive controller drops them → robot won't move. Raising the timeout accepts them. |
| 3 | Comment out the `rgbd_camera` gz `<sensor>` block | `turtlebot4_description/urdf/sensors/oakd.urdf.xacro` | **The big RTF win.** The OAK-D depth camera render under software GL is the dominant cost; the nav demo only needs lidar. |
| 4 | *(optional perf)* cliff/IR ray-sensor rates lowered, or sensors stripped | create3 `sensors/*.urdf.xacro` | Minor RTF gain; not required. `strip_sensors.py` disables cliff/IR entirely. |

**#1 and #2 are applied by `setup_vendor_fixes.sh`** (idempotent; each backs up to `*.stock.bak`
/ `*.cmdvel.bak` first). **#3 is manual** (a multi-line block edit — safer by hand):

```xml
<!-- in oakd.urdf.xacro, wrap the sensor block in a comment -->
<gazebo reference="${name}_rgb_camera_frame">
  <!--
  <sensor name="rgbd_camera" type="rgbd_camera"> ... </sensor>
  -->
  <xacro:material_darkgray/>
</gazebo>
```

Revert anything: `create3_nodes.launch.py.stock.bak`, `control.yaml.cmdvel.bak`, or
`python3 real_simulation/set_cmdvel_timeout.py --restore` / `strip_sensors.py --restore`.

## 2. Software rendering (mandatory)

GPU/d3d12 rendering silently breaks gz sensors (lidar reads all `range_min`). Every launch
script here exports `LIBGL_ALWAYS_SOFTWARE=1` already, so no action is needed for the demo.
For ad-hoc `ros2`/`rviz2` commands, add to `~/.bashrc`:
```bash
export LIBGL_ALWAYS_SOFTWARE=1
```

## 3. WSL networking = NAT (Windows side, once)

Mirrored-mode WSL networking breaks ROS 2 DDS on this box. In `C:\Users\<you>\.wslconfig`:
```ini
[wsl2]
networkingMode=NAT
```
Then `wsl --shutdown` from Windows to apply.

## 4. Packages

ROS 2 **Jazzy** plus `turtlebot4_gz_bringup`, `turtlebot4_navigation`, `turtlebot4_description`,
`irobot_create_*`, and `ros_gz_*`. The `maze` world ships with `turtlebot4_gz_bringup`.
*(Optional)* the chat LLM path: `pip install anthropic` + `export ANTHROPIC_API_KEY=sk-...`
— without it, `chat_intent.py` uses its built-in keyword parser (no install needed).

---

## Verify the vendor edits are applied
```bash
grep -n "safety_override\|reflexes_enabled" /opt/ros/jazzy/share/irobot_create_common_bringup/launch/create3_nodes.launch.py
grep -n "cmd_vel_timeout" /opt/ros/jazzy/share/irobot_create_control/config/control.yaml
grep -n "rgbd_camera sensor DISABLED\|<!--" /opt/ros/jazzy/share/turtlebot4_description/urdf/sensors/oakd.urdf.xacro | head
```
Expect: `safety_override: 'full'`, `reflexes_enabled: False`, `cmd_vel_timeout: 5.0`, and the
camera sensor block commented out.
