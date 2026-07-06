import json

from guidemate_msgs.messages import Command, cmd_topic, status_topic

from guide_mate_bridge.bridge import Bridge, _graceful_shutdown
from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState
from guide_mate_bridge.shadow import ShadowSync, shadow_topic


class FakeFuture:
    def result(self, timeout=None):
        return None

    def add_done_callback(self, fn):
        fn(self)


class FakeConnection:
    """Mimics an awscrt mqtt connection: connect()->future, subscribe/publish->(future, id)."""

    def __init__(self):
        self.published = []          # list[(topic, payload_str)]
        self.subscriptions = {}      # topic -> callback
        self.disconnected = False

    def connect(self):
        return FakeFuture()

    def disconnect(self):
        self.disconnected = True
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
    safety = SafetyState(env_dry_run=True)
    return Bridge(client=client, robot_id=robot_id, safety=safety), fake


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


def test_graceful_shutdown_publishes_offline_then_reported_then_disconnects():
    bridge, fake = _bridge()
    safety = SafetyState(env_dry_run=True)
    shadow = ShadowSync(client=bridge._client, thing_name="Turtlebot-468",
                        safety=safety, get_timeout_s=0.05)
    # Simulate an already-reconciled shadow layer (subscriptions succeeded earlier).
    shadow._subscribed = True

    _graceful_shutdown(client=bridge._client, shadow=shadow, robot_id="devtest")

    offline = [json.loads(p) for t, p in fake.published if t == status_topic("devtest")]
    assert {"event": "offline", "robot_id": "devtest", "graceful": True} in offline
    assert any(t == shadow_topic("Turtlebot-468", "update") for t, _ in fake.published)
    assert fake.disconnected is True


def test_graceful_shutdown_flushes_publishes_before_disconnect():
    # Finding 2: a clean disconnect suppresses the LWT, so the final offline event +
    # reported must actually reach the broker before disconnect. _graceful_shutdown
    # publishes them synchronously (blocks on puback) THEN disconnects.
    events = []

    class RecordingFuture:
        def result(self, timeout=None):
            # Only a blocking wait (publish_sync / disconnect) records a flush.
            events.append("flushed")
            return None

        def add_done_callback(self, fn):
            # Deferred like the real IO thread: does NOT resolve synchronously, so the
            # async publish() path records no flush before disconnect (that is the bug).
            pass

    class RecordingConnection:
        def __init__(self):
            self.published = []
            self.subscriptions = {}
            self.disconnected = False

        def connect(self):
            return RecordingFuture()

        def disconnect(self):
            self.disconnected = True
            events.append("disconnect")
            return RecordingFuture()

        def publish(self, topic, payload, qos, **kwargs):
            text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
            self.published.append((topic, text))
            return RecordingFuture(), 1

        def subscribe(self, topic, qos, callback):
            self.subscriptions[topic] = callback
            return RecordingFuture(), 1

    fake = RecordingConnection()
    client = IotClient(
        endpoint="x", cert_filepath="x", pri_key_filepath="x",
        client_id="guidemate-bridge-test", robot_id="devtest", connection=fake,
    )
    safety = SafetyState(env_dry_run=True)
    shadow = ShadowSync(client=client, thing_name="Turtlebot-468",
                        safety=safety, get_timeout_s=0.05)
    shadow._subscribed = True  # pretend reconcile already succeeded

    _graceful_shutdown(client=client, shadow=shadow, robot_id="devtest")

    # Both final publishes flushed (puback awaited) BEFORE the disconnect.
    disconnect_pos = events.index("disconnect")
    flush_before = [e for e in events[:disconnect_pos] if e == "flushed"]
    assert len(flush_before) >= 2, f"final publishes not flushed before disconnect: {events}"
    assert fake.disconnected is True
