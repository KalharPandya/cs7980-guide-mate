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

HEADLESS=true
[[ "$GUI" == "--gui" ]] && HEADLESS=false

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

echo "   robot_id=$GUIDEMATE_ROBOT_ID thing=$GUIDEMATE_THING_NAME cmd_vel=$GUIDEMATE_CMD_VEL_TOPIC"
echo "   (motion sinks build only if the Turtlebot-Sim shadow's desired.motion_enabled=true"
echo "    AND desired.dry_run=false — Task 6 flips that; until then every ack is simulated)"

# NOT exec'd: the EXIT trap above must still fire (to kill the sim) once the bridge
# process ends, whether that's SIGINT/SIGTERM from the operator or a bridge crash.
"$REPO/.venv/bin/python" -m guide_mate_bridge.bridge
