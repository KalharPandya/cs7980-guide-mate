#!/usr/bin/env bash
# oak_bringup.sh — hardened OAK-D-LITE bring-up for robot 468.
# Single source of truth for the "good" camera config discovered 2026-06-20.
#
# Fixes baked in (see docs/camera.md "Root cause" for the evidence):
#   1. usbfs_memory_mb >= 256  -> prevents the stereo-stream X_LINK_ERROR that
#      otherwise ABORTS the driver ~5 s after "Camera ready" (the daily wedge).
#      Set at runtime here; make it permanent via scripts/install_oak_fixes.sh.
#   2. (opt-in, OFF by default) i_restart_on_diagnostics_error -> driver self-heals a
#      runtime XLink death. Off because it can restart-loop/thrash if the trigger
#      persists; the oak_watchdog (grace + backoff) is the safer backstop. OAK_SELFHEAL=1.
#   3. DEPTHAI_WATCHDOG headroom -> more slack before the device gives up on a
#      momentarily CPU-starved host (Pi-4 compute saturation, H2).
#   4. shallow queues -> bound latency / degrade gracefully under load.
#
# Depth-only, USB2 (HIGH), 6 fps: the low-bandwidth mapping config. usbfs=256 also
# makes USB3 (SUPER) stable + full-rate if you ever want it (set OAK_USB_SPEED=SUPER).
set -o pipefail
NS="${OAK_NS:-turtlebot468}"
USB_SPEED="${OAK_USB_SPEED:-HIGH}"   # HIGH=USB2 (default, low power), SUPER=USB3 (full rate)

# ROS setup scripts reference unbound vars, so don't use `set -u` around them.
source /opt/ros/humble/setup.bash
[ -f /home/ubuntu/cs7980-guide-mate/install/setup.bash ] && source /home/ubuntu/cs7980-guide-mate/install/setup.bash

# Fix #1 (runtime). If <256, raise it (needs root; passwordless sudo for the watchdog).
cur=$(cat /sys/module/usbcore/parameters/usbfs_memory_mb 2>/dev/null || echo 0)
if [ "${cur:-0}" -lt 256 ]; then echo 256 | sudo tee /sys/module/usbcore/parameters/usbfs_memory_mb >/dev/null; fi

# Fix #3
export DEPTHAI_WATCHDOG="${DEPTHAI_WATCHDOG:-10000}"
export DEPTHAI_WATCHDOG_INITIAL_DELAY="${DEPTHAI_WATCHDOG_INITIAL_DELAY:-12000}"

# Fix #2 (opt-in, OFF by default — see header). Prefer the oak_watchdog over driver self-heal.
SELFHEAL=""
[ "${OAK_SELFHEAL:-0}" = "1" ] && SELFHEAL="-p camera.i_enable_diagnostics:=true -p camera.i_restart_on_diagnostics_error:=true"

echo "[oak_bringup] ns=$NS usb_speed=$USB_SPEED usbfs=$(cat /sys/module/usbcore/parameters/usbfs_memory_mb) watchdog=$DEPTHAI_WATCHDOG selfheal=${OAK_SELFHEAL:-0}"

exec ros2 run depthai_ros_driver camera_node --ros-args \
  -r __ns:=/"$NS" -r __node:=oakd \
  -r /tf:=tf -r /tf_static:=tf_static \
  -p camera.i_pipeline_type:=RGBD -p camera.i_usb_speed:="$USB_SPEED" -p camera.i_nn_type:=none \
  -p camera.i_enable_imu:=false \
  $SELFHEAL \
  -p rgb.i_publish_topic:=false -p rgb.i_enable_preview:=false \
  -p left.i_fps:=6.0 -p right.i_fps:=6.0 \
  -p left.i_max_q_size:=2 -p right.i_max_q_size:=2 -p stereo.i_max_q_size:=2 \
  -p stereo.i_publish_topic:=true -p stereo.i_align_depth:=false -p stereo.i_resolution:=400
