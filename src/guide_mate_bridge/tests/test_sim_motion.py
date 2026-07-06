"""GUIDEMATE_SIM=1 motion validation against the running Gazebo sim + real IoT Core.

PRECONDITION: in another terminal run ``./sim/launch_sim.sh`` (Ignition up + bridge
connected) on a FRESHLY launched sim (the robot must be docked at sim start — see the
re-dock note below). This test flips the *sim* shadow (Turtlebot-Sim) ONLY, drives via
IoT commands, reads ``/odom`` + ``/dock_status`` via rclpy, and always resets the sim
shadow to locked in teardown. Robot 468 is NEVER referenced.

Adaptations vs the P8-Task-6 brief (reality wins over the brief — see p8-task-6-report.md):
* Shadow writes go through boto3 ``iot-data`` in-process (not a spawned ``aws`` CLI): no
  subprocess startup, so the kill-switch latency we measure is the robot's reaction.
* ``/dock_status`` is subscribed with BEST_EFFORT (sensor) QoS — the sim publishes it
  BEST_EFFORT and a default RELIABLE sub silently never matches.
* Yaw is accumulated only over the odom captured DURING the circle.
* UPSTREAM SIM BUG: the irobot_create Ignition ``motion_control`` node's undock behavior
  never releases its single docking-behavior slot (a BACKUP_LIMIT reflex "Exceeded Runtime
  without clearing hazard"), so once the robot undocks it can NEVER re-dock in that sim
  session — every subsequent ``Dock`` goal is rejected ("A docking behavior is already
  running"). This is not a bridge/executor/launch bug (verified: the bridge forwards the
  Dock action faithfully and acks the sim's rejection). Consequences:
    - the robot is genuinely docked only ONCE (fresh sim), so ALL docked-start checks are
      consolidated into the first test;
    - the unassign->re-dock half of the lifecycle is a documented ``xfail`` (strict) rather
      than a faked pass.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time

import boto3
import pytest

pytestmark = pytest.mark.sim

REGION = os.environ.get("AWS_REGION", "us-west-2")
THING = "Turtlebot-Sim"
ROBOT_ID = "turtlebotsim"


# ---------- sim facts ----------
def _facts() -> dict:
    facts = {}
    here = os.path.dirname(__file__)
    path = os.path.abspath(os.path.join(here, "..", "..", "..", "sim", "sim_facts.env"))
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                facts[k] = v
    return facts


# ---------- shadow helpers (SIM thing ONLY, via boto3 iot-data) ----------
def _iot_data():
    endpoint = boto3.client("iot", region_name=REGION).describe_endpoint(
        endpointType="iot:Data-ATS"
    )["endpointAddress"]
    return boto3.client("iot-data", region_name=REGION, endpoint_url=f"https://{endpoint}")


def _update_shadow(iot_data, motion_enabled: bool, dry_run: bool) -> None:
    payload = json.dumps(
        {"state": {"desired": {
            "motion_enabled": motion_enabled, "dry_run": dry_run, "max_speed": 0.15,
        }}}
    )
    iot_data.update_thing_shadow(thingName=THING, payload=payload.encode("utf-8"))


def _set_shadow(iot_data, motion_enabled: bool, dry_run: bool, reconcile_s: float = 3.0) -> None:
    _update_shadow(iot_data, motion_enabled, dry_run)
    time.sleep(reconcile_s)  # let the bridge's shadow delta reconcile land


def _wait_for(predicate, timeout_s, desc=""):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.25)
    raise AssertionError(f"timeout waiting for {desc}")


def _terminal(acks):
    """The done/failed ack (QoS1 can reorder received/running; the terminal one is truth)."""
    for a in reversed(acks):
        if a.state in ("done", "failed"):
            return a
    return acks[-1] if acks else None


# ---------- rclpy odom + cmd_vel + dock listeners ----------
class _RosSpy:
    """Subscribes /odom + /cmd_vel + /dock_status and can drive /undock directly
    (a test precondition helper), on its own rclpy context."""

    def __init__(self, facts):
        import rclpy
        from geometry_msgs.msg import Twist
        from irobot_create_msgs.msg import DockStatus
        from nav_msgs.msg import Odometry
        from rclpy.node import Node
        from rclpy.qos import qos_profile_sensor_data
        from rosgraph_msgs.msg import Clock

        rclpy.init(args=None)
        self._rclpy = rclpy
        self.node = Node("sim_motion_spy")
        self.odom = []           # list[(x, y, yaw)]
        self.cmd_vel = []        # list[(t, vx, wz)]
        self.docked = None       # latest /dock_status .is_docked (None until first msg)
        self.sim_clock = None    # latest /clock in sim seconds (for the RTF precheck)
        self.node.create_subscription(Odometry, facts["SIM_ODOM_TOPIC"], self._on_odom, 10)
        self.node.create_subscription(Twist, facts["SIM_CMD_VEL_TOPIC"], self._on_cmd, 10)
        # /dock_status is published BEST_EFFORT (sensor QoS) by the sim; a default
        # RELIABLE subscription silently never matches (the bridge telemetry uses
        # qos_profile_sensor_data for the same reason).
        self.node.create_subscription(
            DockStatus, facts["SIM_DOCK_STATUS_TOPIC"], self._on_dock, qos_profile_sensor_data
        )
        self.node.create_subscription(Clock, "/clock", self._on_clock, qos_profile_sensor_data)
        self._facts = facts
        self._stop = threading.Event()
        self._spin = threading.Thread(target=self._spin_loop, daemon=True)
        self._spin.start()

    def _spin_loop(self):
        while not self._stop.is_set():
            self._rclpy.spin_once(self.node, timeout_sec=0.1)

    @staticmethod
    def _yaw(q):
        return math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))

    def _on_odom(self, msg):
        p = msg.pose.pose
        self.odom.append((p.position.x, p.position.y, self._yaw(p.orientation)))

    def _on_cmd(self, msg):
        self.cmd_vel.append((time.time(), msg.linear.x, msg.angular.z))

    def _on_dock(self, msg):
        self.docked = bool(msg.is_docked)

    def _on_clock(self, msg):
        self.sim_clock = msg.clock.sec + msg.clock.nanosec * 1e-9

    def measure_rtf(self, window_s: float = 3.0) -> float:
        """Sim-time/wall-time real-time factor over a short window."""
        _wait_for(lambda: self.sim_clock is not None, 15, "first /clock message")
        w0, s0 = time.time(), self.sim_clock
        time.sleep(window_s)
        w1, s1 = time.time(), self.sim_clock
        return (s1 - s0) / (w1 - w0)

    def close(self):
        self._stop.set()
        self._spin.join(timeout=2.0)
        self.node.destroy_node()
        self._rclpy.shutdown()


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def iot_data():
    return _iot_data()


@pytest.fixture
def registry():
    from guidemate_agent.mqtt_link import RobotRegistry

    endpoint = boto3.client("iot", region_name=REGION).describe_endpoint(
        endpointType="iot:Data-ATS"
    )["endpointAddress"]
    reg = RobotRegistry(endpoint=endpoint, region=REGION, robot_ids=[ROBOT_ID])
    reg.connect()
    yield reg


@pytest.fixture
def spy():
    s = _RosSpy(_facts())
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _always_lock_shadow_after(iot_data):
    yield
    _set_shadow(iot_data, motion_enabled=False, dry_run=True, reconcile_s=1.0)


def _send(registry, type_, name, timeout_s):
    from guidemate_msgs.messages import Command

    acks = registry.send_command(ROBOT_ID, Command(type=type_, name=name), timeout_s=timeout_s)
    return acks, _terminal(acks)


def _confirm_undocked(spy):
    """Wait for /dock_status to report is_docked == False + at least one /odom sample."""
    _wait_for(lambda: spy.docked is False, 45, "/dock_status is_docked -> False")
    _wait_for(lambda: len(spy.odom) > 0, 15, "first /odom sample")


# ================================================================================
# 1. Dock-guard exemption matrix + IoT undock lifecycle  (needs a genuinely DOCKED
#    robot -> must run first on a freshly launched sim; the robot can only be docked
#    once, see the module docstring's upstream-sim-bug note).
# ================================================================================
def test_dock_guard_and_undock_lifecycle_over_iot(registry, spy, iot_data):
    _wait_for(lambda: spy.docked is not None, 30, "first /dock_status message")
    if spy.docked is not True:
        pytest.skip(
            "robot not docked — this test needs a freshly launched sim (the sim's undock "
            "behavior wedges re-dock, so the robot is docked only once; restart the sim)"
        )

    _set_shadow(iot_data, motion_enabled=True, dry_run=False)

    # (a) DOCKED -> a twist choreography is refused by the dock guard, reason "docked".
    _, term = _send(registry, "motion", "circle", timeout_s=15.0)
    assert term is not None and term.state == "failed", term
    assert term.reason == "docked", term.reason
    print(f"\n[evidence] dock-guard: docked circle refused state={term.state} "
          f"reason={term.reason}")

    # (b) DOCKED -> "stop" is exempt (always safe) -> done.
    _, term = _send(registry, "stop", "stop", timeout_s=15.0)
    assert term is not None and term.state == "done", term

    # (c) DOCKED -> "undock" is exempt (leave-the-dock) -> done; is_docked flips False.
    #     This is the Phase-4 approve-hook path over IoT (assignment -> undock -> usable).
    _, term = _send(registry, "motion", "undock", timeout_s=60.0)
    assert term is not None and term.state == "done", term
    _wait_for(lambda: spy.docked is False, 45, "IoT undock -> is_docked False")
    print(f"[evidence] undock over IoT: ack state={term.state}, "
          f"/dock_status is_docked True->False")

    # (d) UNDOCKED -> the same class of twist is now permitted -> done.
    _, term = _send(registry, "motion", "spin", timeout_s=40.0)
    assert term is not None and term.state == "done", term


# ================================================================================
# 2. Circle closes + full turn  (the GOAL-CRITICAL "the sim ACTUALLY MOVES" proof).
# ================================================================================
def test_circle_closes_and_turns_full(registry, spy, iot_data):
    _confirm_undocked(spy)  # undocked by test 1 (or an earlier run); circle needs undocked

    # PRECONDITION — real-time factor. The bridge executor times choreography in
    # WALL-clock while the robot integrates velocity in SIM time, so a degraded RTF
    # under-delivers the arc: at RTF~0.5 (measured with orphaned duplicate Gazebo
    # instances loading the box) a circle nets only half a loop and "closure" lands
    # at the DIAMETER (the P8-T6 0.998 m failure). Fail loud + early with the real
    # cause instead of a misleading closure number. Clean single-sim RTF here: ~0.94.
    rtf = spy.measure_rtf()
    assert rtf >= 0.85, (
        f"sim real-time factor {rtf:.2f} < 0.85 — the wall-clock-timed choreography "
        "cannot deliver a full circle in sim time. Check for orphaned Gazebo/sim "
        "processes (kill by PID, never pkill -f) and relaunch ./sim/launch_sim.sh"
    )

    _set_shadow(iot_data, motion_enabled=True, dry_run=False)

    # Warm-up: the sim's diff-drive controller under-tracks the FIRST commanded rotation
    # after a cold/idle start (measured: a cold circle can net only ~3.5 rad and not close,
    # while every subsequent one nets ~6.0 rad and closes < 0.02 m). A throwaway spin warms
    # the controller so the measured circle tracks — it does NOT relax the closure threshold.
    _send(registry, "motion", "spin", timeout_s=40.0)

    i0 = len(spy.odom)
    start = spy.odom[-1]
    _, term = _send(registry, "motion", "circle", timeout_s=40.0)
    assert term is not None and term.state == "done", term

    time.sleep(0.5)  # let trailing /odom land
    end = spy.odom[-1]
    closure = math.hypot(end[0] - start[0], end[1] - start[1])
    print(f"\n[evidence] rtf={rtf:.3f} circle closure={closure:.3f} m "
          f"start=({start[0]:.3f},{start[1]:.3f}) end=({end[0]:.3f},{end[1]:.3f})")
    assert closure < 0.15, f"circle did not close: {closure:.3f} m"

    yaws = [o[2] for o in spy.odom[i0:]]
    net = 0.0
    for a, b in zip(yaws, yaws[1:]):
        d = b - a
        while d > math.pi:
            d -= 2 * math.pi
        while d < -math.pi:
            d += 2 * math.pi
        net += d
    print(f"[evidence] circle net_yaw={net:.3f} rad over {len(yaws)} odom samples")
    assert abs(net) >= 5.5, f"net yaw only {net:.2f} rad (want >= 5.5)"


# ================================================================================
# 3. Kill-switch: flip motion_enabled:false mid-circle -> /cmd_vel zeros within 1 s
#    + the in-flight command acks failed.
# ================================================================================
def test_kill_switch_zeros_cmd_vel_within_1s(registry, spy, iot_data):
    from guidemate_msgs.messages import Command

    _confirm_undocked(spy)
    _set_shadow(iot_data, motion_enabled=True, dry_run=False)

    acks_out = {}

    def worker():
        acks_out["acks"] = registry.send_command(
            ROBOT_ID, Command(type="motion", name="circle"), timeout_s=40.0
        )

    t = threading.Thread(target=worker)
    t.start()

    time.sleep(4.0)  # let it actually drive
    moving = [c for c in spy.cmd_vel if abs(c[2]) > 1e-3]
    assert moving, "robot never published a non-zero cmd_vel before the kill"

    kill_t = time.time()
    _update_shadow(iot_data, motion_enabled=False, dry_run=True)  # KILL (no reconcile sleep)
    t.join(timeout=15.0)

    after = [(ct, vx, wz) for (ct, vx, wz) in spy.cmd_vel if ct >= kill_t]
    zero_t = next(
        (ct for (ct, vx, wz) in after if abs(vx) < 1e-3 and abs(wz) < 1e-3), None
    )
    assert zero_t is not None, f"no zero cmd_vel after kill; samples={after[:8]}"
    latency = zero_t - kill_t
    print(f"\n[evidence] kill-switch cmd_vel zeroed {latency:.3f}s after shadow flip")
    assert latency <= 1.0, f"kill-switch zeroed cmd_vel in {latency:.3f}s (> 1.0s)"

    term = _terminal(acks_out.get("acks") or [])
    assert term is not None and term.state == "failed", acks_out.get("acks")


# ================================================================================
# 4. Unassign -> re-dock over IoT. The bridge dispatches the Create 3 Dock action
#    correctly; the SIM rejects it forever after an undock (upstream motion_control
#    slot-wedge — see module docstring). Marked xfail(strict) so this flips to a
#    failure the day the sim is fixed (prompting removal of the marker).
# ================================================================================
@pytest.mark.xfail(
    strict=True,
    reason="upstream irobot_create Ignition sim: undock never releases motion_control's "
    "docking slot, so Dock is permanently rejected -> the robot cannot re-dock in-session",
)
def test_redock_via_iot_unassign(registry, spy, iot_data):
    _confirm_undocked(spy)
    _set_shadow(iot_data, motion_enabled=True, dry_run=False)

    # dock via IoT (a normal allowed action while undocked) -> expect done + re-dock.
    _, term = _send(registry, "motion", "dock", timeout_s=120.0)
    assert term is not None and term.state == "done", term
    _wait_for(lambda: spy.docked is True, 90, "robot to re-dock")
