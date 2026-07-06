import json

from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState
from guide_mate_bridge.shadow import ShadowSync, shadow_topic


class FakeFuture:
    def result(self, timeout=None):
        return None

    def add_done_callback(self, fn):
        fn(self)


class FakeConnection:
    """awscrt-shaped fake. Can auto-answer a shadow get, or reject subscribes."""

    def __init__(self, deny_subscribe=False):
        self.published = []          # list[(topic, payload_str)]
        self.subscriptions = {}      # topic -> wrapped callback
        self.deny_subscribe = deny_subscribe
        self.auto_get_response = None    # (suffix, payload_str) delivered on shadow get
        self.disconnected = False

    def connect(self):
        return FakeFuture()

    def disconnect(self):
        self.disconnected = True
        return FakeFuture()

    def subscribe(self, topic, qos, callback):
        if self.deny_subscribe:
            raise RuntimeError("SUBACK failure (policy denied)")
        self.subscriptions[topic] = callback
        return FakeFuture(), 1

    def publish(self, topic, payload, qos, **kwargs):
        text = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        self.published.append((topic, text))
        if topic.endswith("/shadow/get") and self.auto_get_response is not None:
            suffix, response = self.auto_get_response
            cb = self.subscriptions[topic + "/" + suffix]
            cb(topic=topic + "/" + suffix, payload=response.encode("utf-8"),
               dup=False, qos=1, retain=False)
        return FakeFuture(), 1

    def deliver(self, topic, payload_str):
        self.subscriptions[topic](topic=topic, payload=payload_str.encode("utf-8"),
                                  dup=False, qos=1, retain=False)


def _client(fake):
    return IotClient(
        endpoint="x", cert_filepath="x", pri_key_filepath="x",
        client_id="guidemate-bridge-test", robot_id="devtest", connection=fake,
    )


def _sync(fake, safety, timeout=0.05):
    return ShadowSync(client=_client(fake), thing_name="Turtlebot-468",
                      safety=safety, get_timeout_s=timeout)


def _reported_payloads(fake):
    topic = shadow_topic("Turtlebot-468", "update")
    return [json.loads(p)["state"]["reported"] for t, p in fake.published if t == topic]


def test_shadow_topic_helper():
    assert shadow_topic("Turtlebot-468", "get") == "$aws/things/Turtlebot-468/shadow/get"


def test_get_accepted_applies_desired_and_publishes_reported():
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps(
        {"state": {"desired": {"motion_enabled": False, "max_speed": 0.10,
                               "dry_run": True}}, "version": 7}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    assert safety.max_speed == 0.10
    reported = _reported_payloads(fake)
    assert reported, "no reported state published"
    rep = reported[-1]
    assert rep["max_speed"] == 0.10
    assert rep["motion_enabled"] is False
    assert rep["dry_run"] is True
    assert "bridge_version" in rep and "uptime_s" in rep


def test_get_rejected_locks_defaults_and_still_reports():
    fake = FakeConnection()
    fake.auto_get_response = ("rejected", json.dumps(
        {"code": 404, "message": "No shadow exists with name"}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    assert safety.gates() == {"docked": None, "motion_enabled": False, "dry_run": True}
    assert safety.max_speed == 0.15
    assert _reported_payloads(fake)  # bridge announces its (locked) state anyway


def test_get_timeout_locks_defaults():
    fake = FakeConnection()  # no auto response -> get goes unanswered
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=0.05).start()
    assert safety.gates()["motion_enabled"] is False
    assert safety.effective_dry_run is True
    assert _reported_payloads(fake)


def test_delta_applies_live_and_republishes_reported():
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps({"state": {"desired": {}}}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    before = len(_reported_payloads(fake))
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"max_speed": 0.08}, "version": 9}))
    assert safety.max_speed == 0.08
    reported = _reported_payloads(fake)
    assert len(reported) == before + 1
    assert reported[-1]["max_speed"] == 0.08


def test_reported_dry_run_converges_no_delta_storm():
    # Finding 1: reported.dry_run must echo the SHADOW-level value so the shadow
    # converges (desired.dry_run == reported.dry_run) and AWS stops re-emitting a
    # delta on every reported publish. The effective (env OR shadow) value is exposed
    # separately as effective_dry_run, which is NOT a desired key so it never deltas.
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps({"state": {"desired": {}}}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    # Operator sets desired.dry_run=False while env dry-run stays ON.
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"dry_run": False}}))
    rep = _reported_payloads(fake)[-1]
    assert rep["dry_run"] is False           # echoes shadow desired -> converges
    assert rep["effective_dry_run"] is True  # informational; env dry-run still wins
    assert safety.gates()["dry_run"] is True  # enforcement surface uses effective


def test_shadow_delta_cannot_loosen_env_dry_run():
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps({"state": {"desired": {}}}))
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=1.0).start()
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"dry_run": False, "motion_enabled": True}}))
    assert safety.effective_dry_run is True  # env=1 wins; STRICTER-only invariant


def test_delta_disabling_motion_fires_killswitch():
    # KILL-SWITCH (Task 4): a shadow delta that flips motion_enabled -> false must fire
    # the registered callback (main() wires it to bridge.abort) so an in-flight
    # choreography is interrupted mid-run.
    fake = FakeConnection()
    fake.auto_get_response = ("accepted", json.dumps(
        {"state": {"desired": {"motion_enabled": True}}}))
    safety = SafetyState(env_dry_run=False)
    sync = _sync(fake, safety, timeout=1.0)
    fired = {"n": 0}
    sync.set_motion_disabled_callback(lambda: fired.__setitem__("n", fired["n"] + 1))
    sync.start()
    # Enabling deltas must NOT fire the kill-switch.
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"motion_enabled": True}}))
    assert fired["n"] == 0
    # Disabling motion fires it exactly once.
    fake.deliver(shadow_topic("Turtlebot-468", "update/delta"),
                 json.dumps({"state": {"motion_enabled": False}}))
    assert fired["n"] == 1


def test_subscribe_denied_locks_defaults_and_never_publishes_shadow_topics():
    # Defensive raise-path only. In reality AWS IoT does NOT raise on a policy-denied
    # subscribe — it drops the whole connection, which cannot be recovered (see the
    # module docstring); that fatal case is prevented a-priori by keeping shadow
    # DISABLED on unauthorized certs (test_shadow_disabled_makes_no_io below). This
    # still covers the belt-and-suspenders except in start(): if subscribe ever does
    # raise, we go silent and lock defaults.
    fake = FakeConnection(deny_subscribe=True)
    safety = SafetyState(env_dry_run=True)
    _sync(fake, safety, timeout=0.05).start()
    assert safety.gates()["motion_enabled"] is False
    assert fake.published == []  # no get, no reported — nothing touched shadow topics


def test_shadow_disabled_makes_no_io_and_locks_defaults():
    # Regression guard: with shadow disabled (unauthorized cert, e.g. the dev cert
    # in the integration roundtrip), start() must NOT subscribe or publish anything.
    # Attempting a denied shadow subscribe drops the connection and poisons the
    # mandatory command subscription ("missing acks; got []"). Enforcement stays at
    # the locked default-deny state, and publish_reported() is also a no-op.
    fake = FakeConnection()
    safety = SafetyState(env_dry_run=True)
    sync = ShadowSync(client=_client(fake), thing_name="Turtlebot-468",
                      safety=safety, get_timeout_s=0.05, enabled=False)
    sync.start()
    assert fake.subscriptions == {}  # never subscribed to any shadow topic
    assert fake.published == []       # never published get or reported
    sync.publish_reported(sync=True)  # shutdown path stays silent too
    assert fake.published == []
    assert safety.gates() == {"docked": None, "motion_enabled": False, "dry_run": True}
