import json

import pytest

from guidemate_msgs.messages import Command, cmd_topic, status_topic

from guide_mate_bridge.bridge import Bridge, main
from guide_mate_bridge.iot_client import IotClient


class FakeFuture:
    def result(self, timeout=None):
        return None


class FakeConnection:
    """Mimics an awscrt mqtt connection: connect()->future, subscribe/publish->(future, id)."""

    def __init__(self):
        self.published = []          # list[(topic, payload_str)]
        self.subscriptions = {}      # topic -> callback

    def connect(self):
        return FakeFuture()

    def disconnect(self):
        return FakeFuture()

    def publish(self, topic, payload, qos, **kwargs):
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        self.published.append((topic, text))
        return FakeFuture(), 1

    def subscribe(self, topic, qos, callback):
        self.subscriptions[topic] = callback
        return FakeFuture(), 1


def _bridge(robot_id="devtest"):
    fake = FakeConnection()
    client = IotClient(
        endpoint="x",
        cert_filepath="x",
        pri_key_filepath="x",
        client_id="guidemate-bridge-test",
        robot_id=robot_id,
        connection=fake,
    )
    return Bridge(client=client, robot_id=robot_id, dry_run=True), fake


def test_connect_publishes_online_and_subscribes():
    bridge, fake = _bridge()
    bridge.start()
    assert (status_topic("devtest"), json.dumps({"event": "online", "robot_id": "devtest"})) in fake.published
    assert cmd_topic("devtest") in fake.subscriptions


def test_command_produces_ack_sequence():
    bridge, fake = _bridge()
    bridge.start()
    cmd = Command(type="emote", name="happy")
    bridge.on_message(cmd_topic("devtest"), cmd.model_dump_json())
    bridge._queue.join()
    states = [json.loads(p)["state"] for t, p in fake.published if "state" in p]
    assert states == ["received", "running", "done"]


def test_duplicate_cmd_id_is_ignored():
    bridge, _ = _bridge()
    bridge.start()
    cmd = Command(type="emote", name="yes")
    bridge.on_message(cmd_topic("devtest"), cmd.model_dump_json())
    bridge.on_message(cmd_topic("devtest"), cmd.model_dump_json())  # same cmd_id
    bridge._queue.join()
    assert bridge._queue.qsize() == 0
    # Only one execution -> exactly one "done" ack.
    assert bridge._seen_count(cmd.cmd_id) == 1


def test_invalid_payload_is_ignored():
    bridge, _ = _bridge()
    bridge.start()
    bridge.on_message(cmd_topic("devtest"), "{not json")
    bridge.on_message(cmd_topic("devtest"), json.dumps({"type": "emote"}))  # missing name
    bridge._queue.join()
    assert bridge._queue.qsize() == 0


def test_main_refuses_without_dry_run(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_DRY_RUN", "0")
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "x")
    monkeypatch.setenv("GUIDEMATE_CERT", "x")
    monkeypatch.setenv("GUIDEMATE_KEY", "x")
    with pytest.raises(SystemExit):
        main()
