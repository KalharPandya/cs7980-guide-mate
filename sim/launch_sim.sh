#!/usr/bin/env bash
# Bring up the TB4 Ignition sim + the bridge under the sim identity, with motion ARMED
# (still shadow-gated — the classic shadow for Turtlebot-Sim ships locked
# {motion_enabled:false, dry_run:true} until Task 6 flips it). Robot 468 is never
# referenced by this script — it targets thing Turtlebot-Sim / robot_id turtlebotsim
# only, so the bridge's assert_motion_identity_safe() hard guard is a structural no-op
# here (it only fires for robot_id==turtlebot468). Kill by PID (never pkill -f — see
# CLAUDE.md gotcha #6).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS="${AWS:-$(command -v aws || echo "$HOME/.local/bin/aws")}"
GUI="${1:-}"   # pass --gui for a window; default headless.

echo "== sourcing ROS 2 Humble + repo overlay =="
# ROS/ament setup scripts are NOT `set -u`-clean (they reference AMENT_* vars before
# defining them), so nounset must be relaxed across the sourcing or the whole script
# aborts on the first unbound ament var when launched from a non-interactive shell.
set +u
# shellcheck disable=SC1091
source /opt/ros/humble/setup.bash
if [[ -f "$REPO/install/setup.bash" ]]; then
  # shellcheck disable=SC1091
  source "$REPO/install/setup.bash"
fi
set -u
# shellcheck disable=SC1091
source "$REPO/sim/sim_facts.env"     # SIM_CMD_VEL_TOPIC etc. (Task 2, verified)

# GOTCHA (sim/README.md, CLAUDE.md P8): the login profile sets ROS_DISCOVERY_SERVER to
# the Pi's discovery server, which silently breaks DDS discovery for anything on this
# box, including the sim. It MUST be unset, and any already-running ros2 daemon (which
# cached the old ROS_DISCOVERY_SERVER at first contact) must be restarted so it forgets.
if [[ -n "${ROS_DISCOVERY_SERVER:-}" ]]; then
  echo "== unsetting ROS_DISCOVERY_SERVER (was: ${ROS_DISCOVERY_SERVER}) — sim gotcha =="
fi
unset ROS_DISCOVERY_SERVER
ros2 daemon stop >/dev/null 2>&1 || true
ros2 daemon start >/dev/null 2>&1 || true

# Offscreen Qt segfaults in this sim's RViz/GUI bits; this box has a real display, so
# the GUI (when requested) runs on :0 rather than any headless/offscreen platform.
export DISPLAY="${DISPLAY:-:0}"

# Pin ign-transport to loopback. Left to its own devices it sometimes binds its ZeroMQ
# sockets to the DOCKER bridge interface (seen 2026-07-06: `ss -tlnp` showed the ruby
# server listening on 172.17.0.1) and discovery between the Gazebo server and every
# client silently fails — the launch then wedges forever at "Requesting list of world
# names" with zero errors in the log (ros_gz_sim create + the GUI + spawners all spin).
# The tell: bridge heartbeats missing "docked"/"battery" fields (no sim publishers).
export IGN_IP=127.0.0.1

HEADLESS=true
[[ "$GUI" == "--gui" ]] && HEADLESS=false

# Refuse to launch over a stale/orphaned sim. A duplicate Gazebo instance tanks the
# real-time factor (measured RTF 0.49 with orphans vs 0.94 clean), and the bridge's
# wall-clock-timed choreography then under-delivers sim time — a "circle" becomes a
# half-loop (P8-T6 root cause: closure 0.998 m ~= the diameter). Kill the old sim by
# PID first (never pkill -f). NOTE: 'parameter_bridge' exceeds the kernel's 15-char
# comm limit, so match the truncated name.
STALE="$(pgrep -x ruby; pgrep -x parameter_bridg)" || true
if [[ -n "$STALE" ]]; then
  echo "FATAL: a Gazebo/sim instance is already running (pids: ${STALE//$'\n'/ })." >&2
  echo "Orphaned sims halve the real-time factor and break timed choreography." >&2
  echo "Kill them by PID (never pkill -f), then relaunch." >&2
  exit 1
fi

# ALSO refuse a stale guide-mate bridge (second orphan class, found 2026-07-06): a
# leftover bridge from an earlier session shares robot_id turtlebotsim, races this
# launch's bridge on the IoT command topic, and acks motion "done simulated=True"
# while its sinks are dead — masking the live bridge's real acks (a docked circle
# looked *permitted* when the live bridge had correctly refused it reason=docked).
# pgrep -f is safe HERE (this script's own cmdline never contains the pattern);
# still kill by PID, never pkill -f.
STALE_BRIDGE="$(pgrep -f 'guide_mate_bridge[.]bridge')" || true
if [[ -n "$STALE_BRIDGE" ]]; then
  echo "FATAL: a guide-mate bridge is already running (pids: ${STALE_BRIDGE//$'\n'/ })." >&2
  echo "Duplicate bridges race command acks under the same robot_id. Kill by PID." >&2
  exit 1
fi

echo "== launching ${SIM_LAUNCH_PKG} ${SIM_LAUNCH_FILE} (headless=$HEADLESS) =="
# shellcheck disable=SC2086
ros2 launch "$SIM_LAUNCH_PKG" "$SIM_LAUNCH_FILE" \
    $SIM_LAUNCH_ARGS headless:=$HEADLESS >/tmp/sim_run.log 2>&1 &
SIM_PID=$!
echo "sim pid=$SIM_PID — log: /tmp/sim_run.log — waiting for $SIM_ODOM_TOPIC"

cleanup() {
  echo "stopping sim (pid $SIM_PID)"
  kill "$SIM_PID" 2>/dev/null || true
}
trap cleanup EXIT

deadline=$((SECONDS + 240))   # cold-cache first run can take 120-240 s (sim_facts.env)
until ros2 topic list 2>/dev/null | grep -qx "$SIM_ODOM_TOPIC"; do
  if ! kill -0 "$SIM_PID" 2>/dev/null; then
    echo "FATAL: sim process (pid $SIM_PID) died — see /tmp/sim_run.log" >&2
    exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "TIMEOUT: no $SIM_ODOM_TOPIC after $((deadline - SECONDS + 240))s — see /tmp/sim_run.log" >&2
    exit 1
  fi
  sleep 3
done
echo "sim up ($SIM_ODOM_TOPIC present)."

echo "== discovering IoT endpoint =="
ENDPOINT="$("$AWS" iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
echo "   endpoint: ${ENDPOINT}"

echo "== starting bridge (sim identity; motion armed but shadow-gated) =="
export GUIDEMATE_ROBOT_ID=turtlebotsim
export GUIDEMATE_THING_NAME=Turtlebot-Sim
export GUIDEMATE_IOT_ENDPOINT="$ENDPOINT"
export GUIDEMATE_CERT="$HOME/.aws/guidemate-sim.cert.pem"
export GUIDEMATE_KEY="$HOME/.aws/guidemate-sim.key.pem"
export GUIDEMATE_CMD_VEL_TOPIC="$SIM_CMD_VEL_TOPIC"
export GUIDEMATE_UNDOCK_ACTION="$SIM_UNDOCK_ACTION"
export GUIDEMATE_DOCK_ACTION="$SIM_DOCK_ACTION"
export GUIDEMATE_BATTERY_TOPIC="${SIM_BATTERY_TOPIC#/}"   # telemetry topics are relative
export GUIDEMATE_DOCK_TOPIC="${SIM_DOCK_STATUS_TOPIC#/}"  # to the node namespace
export GUIDEMATE_ROS_NAMESPACE=""     # REQUIRED: sim is UN-namespaced (root topics).
                                       # Left unset, the bridge defaults telemetry's
                                       # namespace to GUIDEMATE_ROBOT_ID (turtlebotsim),
                                       # which would subscribe to /turtlebotsim/battery_state
                                       # + /turtlebotsim/dock_status — neither exists in
                                       # the sim graph, so dock state would stay "unknown"
                                       # forever and the dock-guard would never open.
export GUIDEMATE_ROS=1
export GUIDEMATE_SHADOW=1             # REQUIRED: the sim policy is authorized for
                                       # $aws/things/Turtlebot-Sim/shadow/* (access-ground-
                                       # truth.md). Without this, SafetyState's
                                       # shadow_dry_run default (True, locked) never gets
                                       # a chance to be flipped by Task 6 at all.
export GUIDEMATE_ENABLE_MOTION=1      # OK: robot_id=turtlebotsim (hard guard passes,
                                       # see assert_motion_identity_safe); the shadow
                                       # (default-deny) still gates the real sink.
export GUIDEMATE_DRY_RUN=0            # OK: env dry-run off does NOT loosen the shadow's
                                       # own dry_run=true default (effective_dry_run =
                                       # env OR shadow — either locked side wins).
export GUIDEMATE_SIM_TIME_CHOREO=1    # SIM ONLY: pace choreography ticks by /clock.
                                       # Wall-clock pacing under-delivers the arc by the
                                       # real-time factor (closure error of a radius-R
                                       # circle = 2*R*sin(pi*(1-RTF)); measured: RTF 0.49
                                       # orphan -> 0.998 m, RTF 0.90-0.96 single sim ->
                                       # 0.528/0.479/0.171 m; <0.15 m needs RTF>=0.952).
                                       # NEVER set on a real robot (wall == robot time).

echo "   robot_id=$GUIDEMATE_ROBOT_ID thing=$GUIDEMATE_THING_NAME cmd_vel=$GUIDEMATE_CMD_VEL_TOPIC"
echo "   (motion sinks build only if the Turtlebot-Sim shadow's desired.motion_enabled=true"
echo "    AND desired.dry_run=false — Task 6 flips that; until then every ack is simulated)"

# NOT exec'd: the EXIT trap above must still fire (to kill the sim) once the bridge
# process ends, whether that's SIGINT/SIGTERM from the operator or a bridge crash.
"$REPO/.venv/bin/python" -m guide_mate_bridge.bridge
