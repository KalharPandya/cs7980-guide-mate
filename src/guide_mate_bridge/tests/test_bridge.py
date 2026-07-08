import json

import pytest
from guidemate_msgs.messages import Command, cmd_topic, status_topic

from guide_mate_bridge.bridge import (
    Bridge,
    _graceful_shutdown,
    assert_motion_identity_safe,
    command_permitted,
    resolve_motion_enabled,
)
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
    # Task 4: the bridge is fully on the executor REALDRIVE path now (dry-run keeps the
    # sim/test identity from moving). A permissive gate is wired so the fail-closed guard
    # is satisfied, though dry-run returns before the gate is ever consulted.
    return (
        Bridge(
            client=client,
            robot_id=robot_id,
            dry_run=True,
            motion_gate=lambda cmd: (True, ""),
        ),
        fake,
    )


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


# ---- dock-guard exemption matrix (spec delta 91d9bcb) ----
@pytest.mark.parametrize(
    "cmd_type,cmd_name,motion_enabled,docked,expect_ok,expect_reason",
    [
        # Shadow lock is supreme — nothing passes while motion_enabled is false.
        ("motion", "circle", False, False, False, "motion_disabled"),
        ("motion", "undock", False, True, False, "motion_disabled"),
        ("stop", "stop", False, True, False, "motion_disabled"),
        # Docked: refuse all motion EXCEPT undock, dock, stop.
        ("motion", "circle", True, True, False, "docked"),
        ("motion", "spin", True, True, False, "docked"),
        ("emote", "happy", True, True, False, "docked"),
        ("emote", "yes", True, True, False, "docked"),
        ("motion", "undock", True, True, True, ""),
        ("motion", "dock", True, True, True, ""),  # no-op-ish -> Dock action succeeds -> done
        ("stop", "stop", True, True, True, ""),
        # Undocked: everything allowed; dock is a normal action.
        ("motion", "circle", True, False, True, ""),
        ("motion", "dock", True, False, True, ""),
        ("motion", "undock", True, False, True, ""),
        ("emote", "happy", True, False, True, ""),
        ("stop", "stop", True, False, True, ""),  # stop always safe, undocked
    ],
)
def test_dock_guard_exemption_matrix(
    cmd_type, cmd_name, motion_enabled, docked, expect_ok, expect_reason
):
    ok, reason = command_permitted(cmd_type, cmd_name, motion_enabled, docked)
    assert ok is expect_ok
    assert reason == expect_reason


# ---- pure gating truth table ----
def test_resolve_motion_disabled_when_env_off():
    assert resolve_motion_enabled({}, effective_dry_run=False, shadow_motion_enabled=True) is False


def test_resolve_motion_disabled_when_dry_run():
    env = {"GUIDEMATE_ENABLE_MOTION": "1"}
    assert resolve_motion_enabled(env, effective_dry_run=True, shadow_motion_enabled=True) is False


def test_resolve_motion_disabled_when_shadow_locked():
    env = {"GUIDEMATE_ENABLE_MOTION": "1"}
    assert resolve_motion_enabled(env, effective_dry_run=False, shadow_motion_enabled=False) is False


def test_resolve_motion_enabled_all_gates_pass():
    env = {"GUIDEMATE_ENABLE_MOTION": "1"}
    assert resolve_motion_enabled(env, effective_dry_run=False, shadow_motion_enabled=True) is True


# ---- hard robot-id guard (belt + braces) ----
def test_identity_guard_refuses_motion_on_468():
    with pytest.raises(SystemExit):
        assert_motion_identity_safe(
            {"GUIDEMATE_ENABLE_MOTION": "1", "GUIDEMATE_ROBOT_ID": "turtlebot468"}
        )


def test_identity_guard_refuses_motion_when_robot_id_unset_defaults_468():
    with pytest.raises(SystemExit):
        assert_motion_identity_safe({"GUIDEMATE_ENABLE_MOTION": "1"})  # default robot id is 468


def test_identity_guard_allows_motion_on_sim():
    # Must NOT raise.
    assert_motion_identity_safe(
        {"GUIDEMATE_ENABLE_MOTION": "1", "GUIDEMATE_ROBOT_ID": "turtlebotsim"}
    )


def test_identity_guard_noop_when_motion_off():
    assert_motion_identity_safe({"GUIDEMATE_ROBOT_ID": "turtlebot468"})  # no motion env -> fine


def test_identity_guard_allows_468_with_supervised_token():
    # TEMPORARY supervised opt-in: ENABLE_MOTION + the deliberate token must NOT raise on 468.
    assert_motion_identity_safe(
        {
            "GUIDEMATE_ENABLE_MOTION": "1",
            "GUIDEMATE_ROBOT_ID": "turtlebot468",
            "GUIDEMATE_SUPERVISED_468_MOTION": "observer-present",
        }
    )


def test_identity_guard_refuses_468_with_wrong_token():
    # A malformed/typo token must still refuse (default-deny preserved).
    with pytest.raises(SystemExit):
        assert_motion_identity_safe(
            {
                "GUIDEMATE_ENABLE_MOTION": "1",
                "GUIDEMATE_ROBOT_ID": "turtlebot468",
                "GUIDEMATE_SUPERVISED_468_MOTION": "yes",
            }
        )


# ---- stop command interrupts an in-flight choreography ----
def test_stop_command_aborts_runner():
    bridge, _ = _bridge()
    bridge.start()
    aborted = {"reason": None}
    bridge._runner.abort = lambda reason="aborted": aborted.__setitem__("reason", reason)
    bridge.on_message(cmd_topic("devtest"), Command(type="stop", name="stop").model_dump_json())
    assert aborted["reason"] == "stopped"


# ---- kill-switch: a shadow delta motion_enabled:false aborts the in-flight run ----
def test_shadow_motion_disabled_delta_aborts_bridge():
    from guide_mate_bridge.shadow import ShadowSync as _ShadowSync

    fired = {"reason": None}

    class _FakeSafety:
        def apply_shadow(self, desired):
            pass

        def gates(self):
            return {"docked": None, "motion_enabled": False, "dry_run": True}

    sync = _ShadowSync(
        client=None, thing_name="Turtlebot-468", safety=_FakeSafety(), enabled=False
    )
    sync._subscribed = False  # publish_reported() early-returns (no client needed)
    sync.set_motion_disabled_callback(
        lambda: fired.__setitem__("reason", "motion_disabled")
    )
    # Deliver a delta that disables motion.
    sync._on_delta(
        shadow_topic("Turtlebot-468", "update/delta"),
        json.dumps({"state": {"motion_enabled": False}}),
    )
    assert fired["reason"] == "motion_disabled"


def test_shadow_delta_without_motion_disable_does_not_abort():
    from guide_mate_bridge.shadow import ShadowSync as _ShadowSync

    fired = {"n": 0}

    class _FakeSafety:
        def apply_shadow(self, desired):
            pass

        def gates(self):
            return {"docked": None, "motion_enabled": True, "dry_run": False}

    sync = _ShadowSync(
        client=None, thing_name="Turtlebot-468", safety=_FakeSafety(), enabled=False
    )
    sync._subscribed = False
    sync.set_motion_disabled_callback(lambda: fired.__setitem__("n", fired["n"] + 1))
    sync._on_delta(
        shadow_topic("Turtlebot-468", "update/delta"),
        json.dumps({"state": {"motion_enabled": True}}),  # enabling must NOT abort
    )
    assert fired["n"] == 0
