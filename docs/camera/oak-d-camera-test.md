# OAK-D-LITE camera — test, findings, fixes, pending issues

Bench test of the robot's depth/RGB camera on **robot 468** (`turtlebot-van-468`),
Raspberry Pi 4 Model B Rev 1.5, Ubuntu 22.04 + ROS 2 Humble. Tested 2026-06-19.

**TL;DR:** Both the RGB ("webcam") and the depth camera **work**, but only after forcing
the device to **USB 2.0**. On default settings the camera enters a USB 3 boot/disconnect
loop. The root cause is **power**, not the cable or the camera. The USB 2 workaround is
stable but **bandwidth-limited**, dropping ~80 % of frames. The proper fix
(independent power for the camera) is still **pending**.

---

## What the camera is

The TurtleBot 4's depth camera is a **Luxonis OAK-D-LITE** (MXID `18443010B112591200`),
plugged into the Pi over USB. It provides **both** streams:

- the **RGB "webcam"** (`/camera/rgb/image_raw`), and
- the **stereo depth** camera (`/camera/stereo/image_raw`).

There is **no separate USB webcam**. The many `/dev/video*` nodes on the Pi are its
internal codec/ISP devices, not a camera — there is no `/dev/video0`. The OAK is **not**
a UVC device; it speaks XLink over USB and is driven through ROS 2.

| Item | Value |
|---|---|
| Device | OAK-D-LITE, MXID `18443010B112591200` |
| USB ID (bootloader / booted) | `03e7:2485` / `03e7:f63b` |
| Driver | `depthai_ros_driver` (`ros-humble-depthai` **2.29.0**) |
| Core lib | `/opt/ros/humble/lib/aarch64-linux-gnu/libdepthai-core.so` |
| Node / topics | `/camera` → `/camera/rgb/...`, `/camera/stereo/...` |
| Python `depthai` | **not** installed (use the ROS driver) |

---

## How to bring it up (working command)

Force USB 2.0 (`HIGH`) speed — see the issues below for why:

```bash
source /opt/ros/humble/setup.bash
ros2 run depthai_ros_driver camera_node --ros-args \
  -p camera.i_usb_speed:=HIGH
```

A healthy start logs `USB SPEED: HIGH`, `Device type: OAK-D-LITE`, `Camera ready!`, and
**no** `X_LINK_ERROR` lines.

### QoS gotcha (important)
The image topics publish with **`BEST_EFFORT` (sensor) QoS**. `ros2 topic hz` / `echo`
default to **`RELIABLE`**, so they silently receive **nothing** and look broken. Always
match QoS:

```bash
ros2 topic echo /camera/rgb/image_raw    --qos-reliability best_effort --field header
ros2 topic echo /camera/stereo/image_raw --qos-reliability best_effort --field header
```

---

## Findings (verified)

Both streams deliver frames in USB 2 mode:

| Stream | Topic | Format | Notes |
|---|---|---|---|
| RGB (webcam) | `/camera/rgb/image_raw` | `bgr8`, 1280×720 | ✅ live frames |
| Depth (stereo) | `/camera/stereo/image_raw` | `16UC1`, 1280×720 | ✅ live frames |

---

## Issue 1 — USB 3 boot/disconnect loop  (root cause: POWER)

**Symptom.** On default settings the driver reports `USB SPEED: SUPER`, then floods:

```
Camera diagnostics error: Communication exception ... 'sys_logger_queue' (X_LINK_ERROR)
No data on logger queue!
```

…and **no image frames** ever arrive. The kernel log shows the device cycling:

```
usb 2-2: new SuperSpeed USB device ... idProduct=f63b   <- boots to USB3
usb 2-2: USB disconnect                                  <- drops within seconds
usb 1-1.2: new high-speed USB device ... idProduct=2485  <- falls back to bootloader
... repeats (22 cycles observed)
```

**Diagnosis — it is power, not cable/port/camera:**

| Evidence | Meaning |
|---|---|
| `vcgencmd get_throttled` = `0x50000` | Under-voltage **has occurred** (`0x10000`) + throttling **has occurred** (`0x40000`) |
| `max_usb_current` not set in `config.txt` | Pi 4 caps USB at **~600 mA shared** across all ports |
| OAK `bMaxPower` = 500 mA (USB2), up to 900 mA on USB3 | Peak draw on camera+MyriadX spin-up **exceeds** the Pi's budget |
| Link reaches **SuperSpeed every cycle** before dropping | Cable's USB3 data lanes are fine — a bad cable would never reach SS |
| Streams are **flawless on USB2** | The camera itself is healthy |

Chain of failure: boot to USB3 → cameras + MyriadX current spike → exceeds Pi 4's
~600 mA budget → 5 V rail browns out (under-voltage flag) → SuperSpeed link collapses →
re-enumerate → loop. The OAK-D-LITE is **not designed to be bus-powered off a Pi 4** at
full USB 3 load.

- ❌ Wrong camera? No — streams cleanly on USB 2.
- ❌ Wrong cable? Not the root — it negotiates SuperSpeed every time (data lanes OK).
- ⚠️ Wrong port? It *is* a real USB 3 port; the problem is the **power it can supply**, not data.
- ✅ **Root cause: power starvation.**

**Workaround applied (this is why the bring-up command forces `HIGH`).** Forcing USB 2.0
keeps the device on the stable high-speed link; it draws/runs lighter and stays
connected. Result: `USB SPEED: HIGH`, `Camera ready!`, **0** `X_LINK_ERROR`.

---

## Issue 2 — frame drops from bandwidth limit  (consequence of the USB 2 workaround)

The device is configured for **30 fps** on each stream, but USB 2 cannot carry it.
Measured over 20 s, both streams running:

| Stream | Format | Frame size | **Actual rate** | Data rate |
|---|---|---|---|---|
| RGB | 1280×720 `bgr8` | 2,700 KB | **5.9 fps** (of 30) | 16.4 MB/s |
| Depth | 1280×720 `16UC1` | 1,800 KB | **5.6 fps** (of 30) | 10.4 MB/s |
| **Total** | | | | **~27 MB/s (214 Mbit/s)** |

**Why frames drop.** The streams are **uncompressed**. Running both at 30 fps needs
≈ **135 MB/s** (RGB 81 + depth 54). The USB 2/XLink link on this Pi delivers only
**~27 MB/s**, so the OAK discards the oldest frames on-device (bounded by `i_max_q_size`)
to keep latency low. The numbers are internally consistent:

```
delivered / demand = 27 / 135 = 20%   ==   received fps = 6 / 30 = 20%
```

So **yes, ~80 % of frames are dropped**, and it is purely a transport-bandwidth limit.

---

## Pending / proper fix

The real fix is to **stop powering the camera from the Pi's USB budget**, which removes
both issues (stable USB 3 → full 30 fps, no drops):

1. **Power the OAK independently** — Luxonis **Y-adapter** (data leg to the Pi, 5 V power
   leg to a separate supply) **or** a **powered USB 3 hub** between Pi and camera. *(Not
   yet done — need to confirm whether robot 468 shipped with the Y-adapter.)*
2. **Proper Pi PSU** — the under-voltage flag suggests the Pi's own 5 V/3 A supply may
   also be marginal; use the official 15 W (or better) supply.
3. *(Minor / stopgap)* add `max_usb_current=1` to `config.txt` to raise the budget toward
   1.2 A — helps but does not replace #1.

**Stopgaps that work within USB 2 today** (pick by need):
- Match fps to the link: `-p rgb.i_fps:=5 -p stereo.i_fps:=5` → ~100 % of frames, 0 drops, at 5 fps.
- On-device compression: `-p rgb.i_low_bandwidth:=true` (H.264/MJPEG on the OAK; RGB 2,700 KB → ~50–100 KB/frame) → much higher RGB fps.
- Lower resolution: `-p stereo.i_resolution:=400P` and/or smaller RGB output → fewer bytes/frame.

### Not yet verified
- [ ] Does robot 468 have the Luxonis Y-adapter? Re-cable with independent power and confirm a stable USB 3 run at 30 fps.
- [ ] Measure drop-free fps with `i_low_bandwidth:=true` (and whether the Pi can decode H.264 fast enough).
- [ ] Repeat the whole test on **robot 436** (not yet checked).

---

## Quick reference — diagnostic commands

```bash
# Is the device present? (03e7 = Luxonis/Movidius)
lsusb | grep -i movidius
lsusb -t                                  # shows USB2 (480M) vs USB3 (5000M) path

# Power health on the Pi (0x...0000 high bits = it HAS happened since boot)
vcgencmd get_throttled                    # 0x10000 under-volt, 0x40000 throttle

# Watch the USB boot/disconnect loop
dmesg | grep -iE 'usb (1-1.2|2-2)|f63b|2485|disconnect'

# Bring up + verify (note best_effort QoS)
ros2 run depthai_ros_driver camera_node --ros-args -p camera.i_usb_speed:=HIGH
ros2 topic echo /camera/rgb/image_raw    --qos-reliability best_effort --field header
ros2 topic echo /camera/stereo/image_raw --qos-reliability best_effort --field header
```
