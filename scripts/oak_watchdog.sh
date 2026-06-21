#!/usr/bin/env bash
# oak_watchdog.sh — external supervisor for the OAK-D-LITE on robot 468.
#
# WHY: depthai_ros_driver has no USB-disconnect callback. When the device drops to its
# ROM bootloader (03e7:2485) under load/XLink death, the driver either aborts (process
# dies) or sits logging "X_LINK_ERROR" forever (process alive, 0 frames) — the silent
# wedge that leaves the robot depth-blind. `i_restart_on_diagnostics_error` self-heals
# many cases but not a dead process or a hard wedge. This watchdog is the final backstop.
#
# HEALTH SIGNAL: ad-hoc ROS subscribers cannot receive data on this Discovery-Server box
# (proven on 2026-06-20: even /scan reads 0 frames from a fresh node), so frame-probing
# is useless here. Health is read from the USB layer instead: the device must enumerate
# as 03e7:f63b (booted firmware) AND a camera_node process must be alive.
#
# Grace + backoff so it never fights the driver's own self-heal and never thrashes.
set -o pipefail

WS=/home/ubuntu/cs7980-guide-mate
BRINGUP="${OAK_BRINGUP:-$WS/scripts/oak_bringup.sh}"
LOG="${OAK_WD_LOG:-/home/ubuntu/cam-investigation/oak_watchdog.log}"
PAUSE=/tmp/oak_watchdog.pause     # `touch` this to suspend recovery during maintenance
CHECK_PERIOD=5      # s between health checks
STALL_GRACE=30      # s the device must be unhealthy before we act (lets the driver self-heal first)
COOLDOWN=25         # s to let a relaunch settle before re-checking
BURST_MAX=4         # this many recoveries within BURST_WINDOW ...
BURST_WINDOW=300    # ...
BACKOFF=120         # ... triggers this long a back-off (the root trigger is persistent)

mkdir -p "$(dirname "$LOG")"
log(){ echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

oak_id(){ lsusb -d 03e7: | awk '{print $6}' | head -1; }   # 03e7:f63b | 03e7:2485 | (empty=absent)
cam_alive(){ pgrep -x camera_node >/dev/null; }
healthy(){ [ "$(oak_id)" = "03e7:f63b" ] && cam_alive; }
ensure_usbfs(){ local v; v=$(cat /sys/module/usbcore/parameters/usbfs_memory_mb 2>/dev/null || echo 0)
  [ "${v:-0}" -lt 256 ] && echo 256 | sudo tee /sys/module/usbcore/parameters/usbfs_memory_mb >/dev/null; }

recover(){
  ensure_usbfs
  log "recover: kill camera_node"
  pkill -x camera_node 2>/dev/null; sleep 3; pkill -9 -x camera_node 2>/dev/null
  local id; id=$(oak_id)
  [ -n "$id" ] && { log "recover: usbreset $id"; sudo usbreset "$id" >/dev/null 2>&1 || true; }
  sleep 2
  log "recover: relaunch $BRINGUP"
  nohup "$BRINGUP" > /tmp/oak_camera.log 2>&1 &
}

log "watchdog start (bringup=$BRINGUP grace=${STALL_GRACE}s)"
bad=0; hist=()
while true; do
  if [ -f "$PAUSE" ]; then sleep "$CHECK_PERIOD"; continue; fi
  if healthy; then
    [ "$bad" -gt 0 ] && log "healthy again (id=$(oak_id))"
    bad=0
  else
    bad=$((bad + CHECK_PERIOD))
    log "unhealthy id=$(oak_id) cam=$(cam_alive && echo up || echo down) (${bad}/${STALL_GRACE}s)"
    if [ "$bad" -ge "$STALL_GRACE" ]; then
      now=$(date +%s); hist+=("$now")
      kept=(); for t in "${hist[@]}"; do [ $((now - t)) -le "$BURST_WINDOW" ] && kept+=("$t"); done; hist=("${kept[@]}")
      log "WEDGE confirmed -> recovery #${#hist[@]} in ${BURST_WINDOW}s window"
      recover
      sleep "$COOLDOWN"; bad=0
      if [ "${#hist[@]}" -ge "$BURST_MAX" ]; then
        log "BURST (${#hist[@]} recoveries) -> backing off ${BACKOFF}s; persistent trigger — likely heavy-RGBD+USB3 draw brownout (switch to depth-only/USB2, check cable/power). See docs/camera.md"
        sleep "$BACKOFF"; hist=()
      fi
    fi
  fi
  sleep "$CHECK_PERIOD"
done
