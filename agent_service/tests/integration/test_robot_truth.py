"""Phase 2 evidence vs the REAL robot 468 (docked, dry-run — zero motion).

Gated: set GUIDEMATE_INTEGRATION=1. Requires the Phase-2 bridge deployed and
running on the Pi (Task 6 Step 4).
"""
import subprocess
import time

import pytest

from guidemate_msgs.messages import Command

from guidemate_agent.mqtt_link import RobotRegistry


def _discover_endpoint() -> str:
    out = subprocess.check_output(
        ["aws", "iot", "describe-endpoint", "--endpoint-type", "iot:Data-ATS",
         "--query", "endpointAddress", "--output", "text"],
        text=True,
    )
    return out.strip()


@pytest.fixture(scope="module")
def registry():
    reg = RobotRegistry(
        endpoint=_discover_endpoint(), region="us-west-2",
        robot_ids=["turtlebot468"],
    )
    reg.connect()
    return reg


@pytest.mark.integration
def test_heartbeat_arrives_within_35s(registry):
    # Heartbeats are every 30 s (plus one immediately on bridge start).
    deadline = time.time() + 35.0
    status = {}
    while time.time() < deadline:
        status = registry.get_status("turtlebot468")
        if status.get("last_heartbeat"):
            break
        time.sleep(1.0)
    assert status.get("last_heartbeat"), "no heartbeat from turtlebot468 within 35 s"
    assert status["presence"] == "online"
    gates = status["gates"]
    assert gates["dry_run"] is True          # env=1 on the Pi — locked
    assert gates["motion_enabled"] is False  # shadow desired — locked
    # battery/docked are floats/bools when the rclpy layer sees the topics,
    # None under the documented Discovery-Server fallback — both are valid here;
    # the strong assertion lives in the journal check (Task 6 Step 5).
    assert "battery" in status and "docked" in status


@pytest.mark.integration
def test_motion_command_dry_run_ack_carries_gate_state(registry):
    # Spec item 4 evidence WITHOUT disabling dry-run on the real robot: the ack's
    # gates field shows exactly which locks would have refused the motion.
    cmd = Command(type="motion", name="spin")
    acks = registry.send_command("turtlebot468", cmd, timeout_s=10.0, collect_all=True)
    assert acks, "no acks — robot unreachable"
    states = {a.state for a in acks}
    assert "done" in states  # dry-run executes simulated (DRY-RUN twists in the journal)
    last = [a for a in acks if a.state == "done"][0]
    assert last.simulated is True
    assert last.gates is not None
    assert last.gates["dry_run"] is True
    assert last.gates["motion_enabled"] is False
    assert "docked" in last.gates  # True when telemetry sees the dock, None on fallback
