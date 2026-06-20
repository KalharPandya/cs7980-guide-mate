# Power consumption & saving — robot 468

Robot 468 is battery-powered, and the full perception/SLAM stack runs **continuously whether or not the robot is moving**. Nothing in the stack gates on motion. This doc records what we measured, what's always running and why, and the one verified way to actually cut power when parked.

> All commands assume the `turtlebot468` namespace. Source ROS first: `source /opt/ros/humble/setup.bash`.

---

## 1. Measuring power

There is **no per-component power metering** on a stock TurtleBot 4 — no per-rail shunts, and the Pi 4 has no PMIC ADC (that's a Pi 5 feature). The **only** power sensor is the Create 3 base battery:

```bash
ros2 topic echo /turtlebot468/battery_state --once
```

Key fields:
- `current` — **net** battery current. **Negative = discharging** (the real system load), **positive = charging**.
- `voltage`, `percentage`, `charge`, `capacity`, `temperature`.
- `power_supply_status` is unreliable on this base (reports `0`/UNKNOWN even while charging). **Use the sign of `current`** to tell charge vs discharge.

### ⚠️ You can only measure consumption *undocked*
While docked, the dock feeds the running electronics **and** the battery simultaneously:

```
P_dock_input  =  P_consumption  +  P_into_battery
```

`battery_state` only exposes the net battery term, so consumption is hidden on the dock. To measure real draw, **undock**, then read `current` (it goes negative and *is* the load):

```bash
ros2 action send_goal /turtlebot468/undock irobot_create_msgs/action/Undock "{}"
# ... sample battery_state ...
ros2 action send_goal /turtlebot468/dock   irobot_create_msgs/action/Dock   "{}"
```

### Measured baseline (2026-06-19)
| State | current | voltage | power |
|---|---|---|---|
| Docked (charging, 24%) | +0.46 A | 14.50 V | ~6.7 W *into battery* (not consumption) |
| **Undocked, stationary, full stack** | **−1.00 A** (steady) | ~14.15 V | **≈ 14 W consumption** |
| **Undocked, full park** (SLAM + lidar motor + camera/depth off) | **−0.85 A** | ~14.39 V | **≈ 12.2 W** |

Pack ≈ 1.968 Ah × ~14.4 V ≈ **28 Wh** → ~**2 h** idle runtime from full, before driving load.

**Park saving ≈ 0.15 A / ~1.9 W (~14%)** — real but modest. The always-on floor dominates: a single Pi 4 core at full tilt is only ~1–1.5 W, and the Create 3 base firmware + motors-holding + Pi/TB4 baseline can't be switched off. **~12 W is roughly the practical powered-on floor.** Idle endurance: ~2.0 h → ~2.3 h. (Compare the *current* draw −1.00 vs −0.85 A; the two rows were at different charge levels so voltage/power aren't apples-to-apples.)

---

## 2. What's always running (and why)

Even parked, these run continuously. Source: `ros2 node list` + `ps`.

| Group | Nodes | Why always on | Can stop? |
|---|---|---|---|
| **Create 3 base firmware** | `_do_not_use/*` (motion_control, mobility, hazards, stasis, robot_state, …), `create3_repub` | Onboard firmware: motor hold, IMU/cliff/bumper safety, odom, battery reporting. No idle mode. | ❌ Mandatory |
| **TB4 core** | `turtlebot4_node`, `robot_state_publisher`, `joint_state_publisher`, `analyzers` | HMI/buttons/base comms + continuous TF tree | ⚠️ Not advisable |
| **Lidar** | `rplidar_composition` | Motor spins + publishes `/scan` at ~8 Hz | ✅ See §3 |
| **Camera + depth** | `oakd`, `depth_pc_container`, `point_cloud_xyz`, `depth_to_scan` | OAK streams depth nonstop; Pi converts depth→pointcloud→scan | ✅ `stop_camera` |
| **SLAM** | `slam_toolbox` (`sync_slam_toolbox_node`) | Processes every scan to maintain map/pose. **Pins ~95% of one Pi core — the single biggest draw.** | ✅ See §3 |

> Not robot-functional: `dwagent` (DWService remote access) and any `claude` processes (this agent) also show up — ignore them in the baseline.

---

## 3. Saving power when parked

### ❌ What does NOT work — the soft runtime services
These return success but **do not cut power**:

| Service | Reported | Reality |
|---|---|---|
| `stop_motor` (`std_srvs/Empty`) | no error | Lidar **keeps spinning** while anything subscribes to `/scan` (see below) |
| `slam_toolbox/pause_new_measurements` (`slam_toolbox/Pause`) | `status=True` | Pauses *mapping logic* but node **stays at ~95% CPU**. No power benefit. |
| `oakd/stop_camera` (`std_srvs/Trigger`) | `success=True` | ✅ **Actually stops** the depth pipeline (but camera is the smallest consumer, ~3% CPU; bus-powered, so some idle USB draw remains) |

These nodes are **not lifecycle-managed** (no `change_state` services), so a soft pause never frees the OS process.

### ✅ What WORKS — stop SLAM, and the lidar idles itself

The lidar has **`auto_standby = True`** and is slaved to `/scan` subscriber count — it only idles the motor when subscribers reach **zero**. `slam_toolbox` is the (only) subscriber, and a soft pause does **not** drop the subscription. So the fix is to **stop the SLAM process**:

1. **Save the map first** (killing SLAM loses the in-progress map):
   ```bash
   ros2 service call /turtlebot468/slam_toolbox/serialize_map \
     slam_toolbox/srv/SerializePoseGraph "{filename: '/tmp/robot468_map'}"
   # writes /tmp/robot468_map.data + .posegraph
   ```
2. **Stop slam_toolbox** (SIGINT; it's busy, give it up to ~10 s to exit gracefully):
   ```bash
   kill -INT <slam_toolbox_pid>     # pid from: pgrep -f sync_slam_toolbox
   ```
3. **Result — two wins:**
   - `/scan` subscribers drop to **0** → after **~15–20 s** `auto_standby` **idles the lidar motor** (verified physically — the motor stops spinning).
   - The **~95% SLAM CPU core is freed** immediately.

**Measured effect (2026-06-19, full park = SLAM + lidar motor + camera/depth all off):** draw dropped from **−1.00 A (~14 W)** to **−0.85 A (~12.2 W)** — a saving of **~0.15 A / ~1.9 W (~14%)**, extending idle endurance from ~2.0 h to ~2.3 h. Real but modest: the always-on floor dominates. A single Pi 4 core at full tilt is only ~1–1.5 W, and the Create 3 base firmware + motors-holding + Pi/TB4 baseline cannot be switched off, so **~12 W is roughly the practical powered-on floor.** Don't expect parking to dramatically extend runtime — the CPU graph (95% core) overstates the electrical win.

### ⚠️ Gotcha: `ros2 topic hz /scan` lies about motor state
After standby, the driver **idles the motor but keeps publishing `/scan`** (empty/invalid scans) at ~8 Hz. So `topic hz` still reads ~8 Hz even though the motor is physically stopped. **Don't use `topic hz` to judge motor state** — confirm visually, or by power draw.

### Restoring after a park
- **Lidar:** comes back on its own once a subscriber appears; motor needs ~2 s spin-up before scans are valid — don't drive immediately.
- **Camera:** `ros2 service call /turtlebot468/oakd/start_camera std_srvs/srv/Trigger "{}"`
- **SLAM:** relaunch the node with its original params, then reload the map:
  ```bash
  ros2 service call /turtlebot468/slam_toolbox/deserialize_map \
    slam_toolbox/srv/DeserializePoseGraph "{filename: '/tmp/robot468_map', ...}"
  ```

---

## 4. Safety

A parked/low-power robot is **blind**: no obstacle perception, no mapping, no localization updates. Only do this when the robot is genuinely stationary, and **fully restore (and let the lidar spin up) before any motion.** The Create 3 base safety (hazards/stasis) stays active — it's the one thing that can't be turned off.

## 5. Open / next
- [x] Quantify the park saving — done 2026-06-19: full park = **~14% (~2 W)**, see §1/§3. Whole-park measured; per-step deltas (−camera alone vs −SLAM/lidar alone) not yet isolated.
- [ ] Decide if it's worth it: ~2 W for a blind robot. Likely only for long *known-stationary* periods (e.g. waiting/charging-adjacent idle), not routine stops.
- [ ] If pursued, automate: a node that watches `cmd_vel`/`odom`, parks (stop SLAM + camera) after N s stationary, and restores + waits for lidar spin-up on the next motion/wake.
- [ ] Bigger lever is elsewhere: the always-on floor (~12 W) dominates. Reducing it would mean offloading SLAM/perception to the laptop rather than parking on-robot.
- [ ] Camera is bus-powered with no per-port control on the Pi 4 — full camera power-down would need a hardware change (see [camera test doc](../camera/oak-d-camera-test.md)).
