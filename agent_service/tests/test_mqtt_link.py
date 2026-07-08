import json
import threading

from guidemate_msgs.messages import Ack, Command, cmd_topic, status_topic

from guidemate_agent.mqtt_link import RobotRegistry


class FakeFuture:
    def result(self, timeout=None):
        return None


class FakeConnection:
    def __init__(self):
        self.published = []
        self.status_cb = None

    def connect(self):
        return FakeFuture()

    def subscribe(self, topic, qos, callback):
        self.status_cb = callback
        return FakeFuture(), 1

    def publish(self, topic, payload, qos, **kwargs):
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        self.published.append((topic, text))
        return FakeFuture(), 1

    def feed_status(self, robot_id, ack: Ack):
        self.status_cb(
            topic=status_topic(robot_id),
            payload=ack.model_dump_json().encode("utf-8"),
            dup=False,
            qos=1,
            retain=False,
        )


def _registry():
    fake = FakeConnection()
    reg = RobotRegistry(
        endpoint="x", region="us-west-2", robot_ids=["turtlebot468"], connection=fake
    )
    reg.connect()
    return reg, fake


def test_send_command_collects_acks_until_done():
    reg, fake = _registry()
    cmd = Command(type="emote", name="happy")
    acks_out = {}

    def worker():
        acks_out["acks"] = reg.send_command("turtlebot468", cmd, timeout_s=2.0)

    t = threading.Thread(target=worker)
    t.start()
    # Give the worker a moment to register its waiter, then feed the robot's acks.
    for state in ("received", "running", "done"):
        fake.feed_status("turtlebot468", Ack(cmd_id=cmd.cmd_id, state=state, simulated=True))
    t.join(timeout=3.0)

    acks = acks_out["acks"]
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is True
    assert (cmd_topic("turtlebot468"), cmd.model_dump_json()) in fake.published


def test_send_command_timeout_returns_empty():
    reg, _ = _registry()
    cmd = Command(type="emote", name="no")
    acks = reg.send_command("turtlebot468", cmd, timeout_s=0.2)
    assert acks == []


def test_send_command_returns_empty_when_never_connected():
    reg = RobotRegistry(endpoint="x", region="us-west-2", robot_ids=["turtlebot468"])
    cmd = Command(type="emote", name="happy")
    assert reg.send_command("turtlebot468", cmd, timeout_s=0.1) == []


def test_get_status_sane_when_never_connected():
    reg = RobotRegistry(endpoint="x", region="us-west-2", robot_ids=["turtlebot468"])
    status = reg.get_status("turtlebot468")
    assert status["robot_id"] == "turtlebot468"
    assert status["presence"] == "unknown"
    assert status["last_ack"] is None
    assert status["last_status"] is None


def test_presence_tracked_from_events():
    reg, fake = _registry()
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=json.dumps({"event": "online", "robot_id": "turtlebot468"}).encode("utf-8"),
        dup=False,
        qos=1,
        retain=False,
    )
    assert reg.get_status("turtlebot468")["presence"] == "online"


def test_heartbeat_updates_robot_truth_and_presence():
    reg, fake = _registry()
    hb = {
        "event": "heartbeat", "robot_id": "turtlebot468", "battery": 0.92,
        "docked": True, "uptime_s": 42.0,
        "gates": {"docked": True, "motion_enabled": False, "dry_run": True},
        "ts": "t",
    }
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=json.dumps(hb).encode("utf-8"),
        dup=False, qos=1, retain=False,
    )
    status = reg.get_status("turtlebot468")
    assert status["presence"] == "online"  # a heartbeat proves liveness
    assert status["battery"] == 0.92
    assert status["docked"] is True
    assert status["gates"]["motion_enabled"] is False
    assert status["last_heartbeat"]["uptime_s"] == 42.0
    assert status["last_ack"] is None  # heartbeats are not acks


def test_get_status_robot_truth_keys_default_none():
    reg, _ = _registry()
    status = reg.get_status("turtlebot468")
    for key in ("last_heartbeat", "battery", "docked", "gates"):
        assert status[key] is None


def test_collect_all_waits_full_timeout_and_keeps_out_of_order_acks():
    reg, fake = _registry()
    cmd = Command(type="motion", name="spin")
    out = {}

    def worker():
        out["acks"] = reg.send_command("turtlebot468", cmd, timeout_s=0.5,
                                       collect_all=True)

    t = threading.Thread(target=worker)
    t.start()
    # QoS1 reordering: 'done' lands BEFORE 'running' — collect_all must not
    # return early on the terminal ack.
    fake.feed_status("turtlebot468", Ack(cmd_id=cmd.cmd_id, state="done", simulated=True))
    fake.feed_status("turtlebot468", Ack(cmd_id=cmd.cmd_id, state="running", simulated=True))
    t.join(timeout=2.0)
    assert sorted(a.state for a in out["acks"]) == ["done", "running"]


def test_on_event_callback_receives_parsed_status():
    reg, fake = _registry()
    seen = []
    reg.on_event(seen.append)
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=b'{"battery": 0.12, "docked": true}',
        dup=False,
        qos=1,
        retain=False,
    )
    assert seen == [{"robot_id": "turtlebot468", "data": {"battery": 0.12, "docked": True}}]


def test_on_event_callback_error_is_swallowed():
    reg, fake = _registry()

    def boom(event):
        raise RuntimeError("callback boom")

    reg.on_event(boom)
    # Must not raise out of the MQTT status callback.
    fake.status_cb(
        topic=status_topic("turtlebot468"),
        payload=b'{"event": "offline", "robot_id": "turtlebot468"}',
        dup=False,
        qos=1,
        retain=False,
    )
