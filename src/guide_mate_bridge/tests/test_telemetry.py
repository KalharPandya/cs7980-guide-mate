import json
import time

from guidemate_msgs.messages import status_topic

from guide_mate_bridge.safety import SafetyState
from guide_mate_bridge.telemetry import HeartbeatPublisher, Telemetry


class FakeClient:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload_str):
        self.published.append((topic, payload_str))


def _telemetry(safety=None):
    return Telemetry(safety=safety or SafetyState(), namespace="turtlebot468",
                     enabled=False)


def test_disabled_telemetry_reports_unknowns():
    t = _telemetry()
    assert t.start() is False
    assert t.battery() is None
    assert t.docked() is None


def test_battery_callback_updates_reading():
    t = _telemetry()

    class Msg:
        percentage = 0.87

    t._on_battery(Msg())
    assert t.battery() == 0.87


def test_dock_callback_updates_reading_and_safety_gates():
    safety = SafetyState()
    t = _telemetry(safety)

    class Msg:
        is_docked = True

    t._on_dock(Msg())
    assert t.docked() is True
    assert safety.gates()["docked"] is True


def test_heartbeat_payload_shape():
    safety = SafetyState(env_dry_run=True)
    t = _telemetry(safety)
    client = FakeClient()
    hb = HeartbeatPublisher(client=client, robot_id="turtlebot468",
                            safety=safety, telemetry=t)
    hb.publish_once()
    topic, payload = client.published[0]
    assert topic == status_topic("turtlebot468")
    data = json.loads(payload)
    assert data["event"] == "heartbeat"
    assert data["robot_id"] == "turtlebot468"
    assert data["battery"] is None
    assert data["docked"] is None
    assert data["uptime_s"] >= 0
    assert data["gates"] == {"docked": None, "motion_enabled": False, "dry_run": True}


def test_heartbeat_loop_publishes_immediately_and_repeats_until_stop():
    safety = SafetyState()
    client = FakeClient()
    hb = HeartbeatPublisher(client=client, robot_id="turtlebot468",
                            safety=safety, telemetry=_telemetry(safety),
                            interval_s=0.05)
    hb.start()
    time.sleep(0.13)
    hb.stop()
    count = len(client.published)
    assert count >= 2  # immediate publish + at least one interval tick
    time.sleep(0.12)
    assert len(client.published) == count  # stopped means stopped


def test_topic_names_are_env_overridable(monkeypatch):
    # Probe (Task 4 Step 1) couldn't surface the Create 3 base topics from the
    # ephemeral super-client; the defaults are firmware-H.2.6 standard names, but
    # they must stay overridable without a code change if a robot differs.
    from guide_mate_bridge import telemetry as tmod

    monkeypatch.setenv("GUIDEMATE_BATTERY_TOPIC", "custom_batt")
    monkeypatch.setenv("GUIDEMATE_DOCK_TOPIC", "custom_dock")
    assert tmod._battery_topic() == "custom_batt"
    assert tmod._dock_topic() == "custom_dock"

    monkeypatch.delenv("GUIDEMATE_BATTERY_TOPIC", raising=False)
    monkeypatch.delenv("GUIDEMATE_DOCK_TOPIC", raising=False)
    assert tmod._battery_topic() == tmod.BATTERY_TOPIC
    assert tmod._dock_topic() == tmod.DOCK_TOPIC
