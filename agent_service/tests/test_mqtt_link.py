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
