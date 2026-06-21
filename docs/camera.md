# OAK-D-LITE Camera

Robot 468's depth/RGB camera (Luxonis **OAK-D-LITE**) — how it fails, how to recover, how it's
fixed. From the root-cause investigation on `turtlebot-van-468` (Pi 4, ROS 2 Humble), 2026-06-20.

## TL;DR
Two distinct failures, both now understood. *(Both an earlier "power starvation → force USB2 →
need a Y-adapter" write-up and a later "CPU saturation" draft were wrong; the evidence below
supersedes them.)*

1. **Daily wedge** — camera reaches "Camera ready" then **aborts ~5 s later** (`X_LINK_ERROR` on
   the stereo stream); the TB4 container has no respawn, so it sits dead at bootloader.
   **Cause: kernel `usbfs_memory_mb=16` is too small for the OAK's USB transfers. Fix: set it to
   256** (one line, permanent via `cmdline.txt`).
2. **Residual intermittent drop** — *only* the **heavy RGB+depth pipeline on USB3** drops (~30 s);
   everything lighter is stable. **Cause: a current-draw brownout on the camera's own 5 V rail**
   (USB cable/connector IR-drop under USB3 peak draw) — **not** CPU, **not** temperature, **not**
   Pi under-voltage (that flag never set in any test). Avoid by running depth-only / USB2; the
   true fix is better power delivery (hardware).

**Stable operating config = depth-only, USB2, `usbfs=256`** → [`scripts/oak_bringup.sh`](../scripts/README.md).
It survives a fully-saturated, thermally-throttling Pi without dropping.

## What the camera is
| Item | Value |
|---|---|
| Device | OAK-D-LITE, MXID `18443010B112591200` |
| USB id | `03e7:2485` = ROM bootloader (no driver / crashed) · `03e7:f63b` = firmware running (streaming) |
| Driver | `depthai_ros_driver` 2.29.0 (no standalone python `depthai`) |
| Node / depth topic | `/turtlebot468/oakd` → `/turtlebot468/oakd/stereo/image_raw` |
| USB | bus-powered, behind a VIA hub **shared with the RPLIDAR**; max speed SUPER (USB3, 5 Gbps) |

Firmware runs from RAM, so any reset drops the device to bootloader (`2485`). **Health = USB
product-id (`f63b` vs `2485`) + `camera_node` alive** — *not* frame-probing: on this FastDDS
Discovery-Server box a freshly-spawned `ros2 topic echo/hz` subscriber gets 0 frames for *any*
topic (even `/scan`) — a transport artifact, not a dead publisher. (`ros2 topic hz` here also
rejects `--qos-reliability`; the depth publisher QoS is `RELIABLE`.)

## What works / what doesn't (mode matrix)
5 min/mode, auto-recover-and-retry (reliable drop *rate*, not one sample), all with `usbfs=256`:

| Config | USB2 (HIGH) | USB3 (SUPER) |
|---|---|---|
| **depth-only** (no RGB, no IMU, 6 fps) | ✅ 0 drops / 287 s | ✅ 0 drops / 286 s |
| **RGB+depth+IMU** (heavy = TB4 default) | ✅ 0 drops / 284 s | ❌ ~30 s mean-time-to-drop |

→ **Exactly one mode fails: heavy + USB3.**

## Why USB3 fails but USB2 doesn't
USB3 makes the camera draw **more peak current** — it negotiates the 900 mA power class (vs
500 mA on USB2), the SuperSpeed PHY itself burns more, and the heavy pipeline runs RGB at full
bandwidth. That current, across the cable/connector resistance, sags the voltage *at the camera*
below its regulator's dropout → the MyriadX resets. USB2 caps the current low enough to stay
above it. Depth-only draws little, so it's under the threshold on either bus.

## Power vs CPU vs temperature → **power (draw)**
Load sweep, depth-only + USB2, 3 min/level:

| Extra CPU load | Drops | SoC | VPU | Throttle |
|---|---|---|---|---|
| 0 / 1 / 2 cores | 0 | 73 → 81 °C | ~45 °C | — |
| 3 cores (Pi saturated) | 0 | 82.7 °C | 45.6 °C | `0x80008` = Pi thermal-throttling |

- **CPU — ruled out:** depth-only survived full saturation (~3.85 of 4 cores), 0 drops. (The
  `camera_node` ~100 %-of-a-core cost hurts framerate, not stability.)
- **Temperature — ruled out:** the VPU (the chip that would overheat) stayed 45 °C; the Pi SoC
  got hot and throttled its *own* CPU, but never dropped the camera.
- **Power (draw) — confirmed:** only heavy+USB3 drops, at idle, load-independent. Signature =
  abrupt whole-device USB disconnect (the depthai `__watchdog` thread itself dies) → a rail
  brownout, not a comms timeout.
- **Real-stack check:** camera + `depth_lidar_fusion` + `slam_toolbox` (`scan_fused` + `/map`
  live, no motion) held steady → **the full mapping stack alongside depth-only is safe.**

## Root-cause evidence (the usbfs fix)
Single-variable flip, same TB4-default config:

| `usbfs_memory_mb` | Result |
|---|---|
| **16** (kernel default) | "Camera ready" → `X_LINK_ERROR` on stereo → **aborts in ~5 s** → device `2485` |
| **256** | "Camera ready" → **200 s+ continuous, 0 disconnects** (`throttled=0x0`) |

Only `usbfs` changed. Forcing USB2 only *delayed* the crash (lower bandwidth drains the 16 MB
buffer slower) — which is why "USB2 felt stable" but still dropped after minutes.

## Do we need RGB or the IMU? No.
- **IMU:** `slam_toolbox` uses `scan_fused` + Create3 wheel odometry (no IMU params in
  `slam_fused.yaml`). The Create3 has its own IMU if ever needed. Keep `i_enable_imu:=false`.
- **RGB:** `depth_lidar_fusion` consumes the **depth** stream only. RGB+depth *can* run together
  (stable on USB2) but mapping doesn't need RGB → depth-only is lighter and recommended.

## Bring-up, recovery, prevention
- **Bring-up:** `scripts/oak_bringup.sh` (depth-only / USB2 / `usbfs` ensured; `OAK_USB_SPEED=SUPER`
  for USB3). Healthy start = `Camera ready!`, no `X_LINK_ERROR`, no `Aborted`.
- **Recover a wedge** — never `pkill -f camera_node` (matches your own shell → exit 144); use `-x`:
  ```bash
  pkill -x camera_node                                   # device → 2485
  sudo usbreset "$(lsusb -d 03e7: | awk '{print $6}')"   # if a plain relaunch won't take (vid:pid form)
  scripts/oak_bringup.sh                                  # recovers from 2485 in ~9 s (needs usbfs>=256)
  ```
  Or let `scripts/oak_watchdog.sh` do it automatically (USB-id health, 30 s grace, kill→usbreset→
  relaunch, with backoff — validated end-to-end).
- **Prevent permanently** — `sudo bash scripts/install_oak_fixes.sh`, then reboot:
  1. `usbcore.usbfs_memory_mb=256` (+ `autosuspend=-1`) in `cmdline.txt` — **the** fix for the daily wedge.
  2. *(opt-in, off by default — `OAK_SELFHEAL=1`)* driver self-heal on a drop. Off because it restart-loops without backoff; the watchdog (grace + backoff) is the preferred backstop.
  3. `oak_watchdog.service` — external backstop.
  4. For the heavy+USB3 brownout specifically: **hardware power** (short/thick cable, powered USB hub, or Luxonis Y-adapter) — or just run depth-only.

## Quick diagnostics
```bash
lsusb -d 03e7:                                       # f63b=streaming · 2485=bootloader · empty=gone
cat /sys/module/usbcore/parameters/usbfs_memory_mb   # must be >=256
vcgencmd get_throttled                               # under-voltage bit (0x1/0x10000) never sets here
sudo dmesg -T | grep -iE '03e7|disconnect'           # USB enumerate/disconnect history
```
