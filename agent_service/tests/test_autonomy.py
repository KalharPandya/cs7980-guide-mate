from guidemate_agent.autonomy import (
    AUTONOMY_SESSION_ID,
    AUTONOMY_SESSION_NAME,
    FIRE_BELOW,
    RESET_ABOVE,
    RULES,
    EventEngine,
    LowBatteryDebouncer,
)


def test_constants():
    assert FIRE_BELOW == 0.15
    assert RESET_ABOVE == 0.25
    assert AUTONOMY_SESSION_ID == "system-autonomy"


def test_rules_are_data_with_expected_names():
    names = {rule["name"] for rule in RULES}
    assert names == {"low_battery", "robot_offline"}


def test_fires_once_on_crossing_below():
    d = LowBatteryDebouncer()
    assert d.update(0.30) is False   # armed, above threshold -> nothing
    assert d.update(0.12) is True    # crosses below -> fire
    assert d.update(0.10) is False   # still low, already fired -> no repeat
    assert d.update(0.14) is False   # still below -> no repeat


def test_rearms_only_after_recovery_above_reset():
    d = LowBatteryDebouncer()
    assert d.update(0.12) is True    # fire
    assert d.update(0.20) is False   # above fire_below but NOT above reset_above -> stay disarmed
    assert d.update(0.12) is False   # dipped again while disarmed -> no fire
    assert d.update(0.30) is False   # recovers above reset_above -> re-arm (no fire on the way up)
    assert d.update(0.12) is True    # next crossing fires again


def test_exactly_at_boundaries():
    d = LowBatteryDebouncer()
    assert d.update(0.15) is False   # not strictly below fire_below
    assert d.update(0.149) is True   # strictly below -> fire
    assert d.update(0.25) is False   # not strictly above reset_above -> stay disarmed
    assert d.update(0.2501) is False # re-arms, no fire on recovery
    assert d.update(0.149) is True   # fires again


class FakeAgent:
    def __init__(self):
        self.calls = []

    def chat(self, message=None, session_id=None, robot_id=None,
             system_event=None, allow_motion=True):
        self.calls.append(
            {
                "message": message,
                "session_id": session_id,
                "robot_id": robot_id,
                "system_event": system_event,
                "allow_motion": allow_motion,
            }
        )
        return {"reply_text": "woof", "emote": "happy"}


class FakeStore:
    def __init__(self):
        self.ensured = []

    def ensure_session(self, session_id, name):
        self.ensured.append((session_id, name))


def _engine():
    agent, store = FakeAgent(), FakeStore()
    return EventEngine(agent=agent, store=store, default_robot_id="turtlebot468"), agent, store


def test_low_battery_event_fires_motion_free_turn():
    engine, agent, store = _engine()
    fired = engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}})
    assert fired == "low_battery"
    assert len(agent.calls) == 1
    call = agent.calls[0]
    assert call["message"] is None
    assert call["session_id"] == "system-autonomy"
    assert call["robot_id"] == "turtlebot468"
    assert call["allow_motion"] is False           # motion tools excluded from autonomy turns
    assert "battery" in call["system_event"].lower()
    assert store.ensured == [("system-autonomy", AUTONOMY_SESSION_NAME)]


def test_low_battery_debounced_across_heartbeats():
    engine, agent, _ = _engine()
    engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}})
    engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.11}})  # still low
    assert len(agent.calls) == 1  # only the crossing fired


def test_low_battery_is_per_robot():
    engine, agent, _ = _engine()
    engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}})
    engine.on_status_event({"robot_id": "turtlebotsim", "data": {"battery": 0.12}})
    assert {c["robot_id"] for c in agent.calls} == {"turtlebot468", "turtlebotsim"}


def test_offline_event_fires():
    engine, agent, _ = _engine()
    fired = engine.on_status_event(
        {"robot_id": "turtlebot468", "data": {"event": "offline", "robot_id": "turtlebot468"}}
    )
    assert fired == "robot_offline"
    assert "offline" in agent.calls[0]["system_event"].lower()
    assert agent.calls[0]["allow_motion"] is False


def test_heartbeat_without_battery_does_nothing():
    engine, agent, _ = _engine()
    fired = engine.on_status_event({"robot_id": "turtlebot468", "data": {"docked": True}})
    assert fired is None
    assert agent.calls == []


def test_online_event_is_not_a_rule():
    engine, agent, _ = _engine()
    fired = engine.on_status_event(
        {"robot_id": "turtlebot468", "data": {"event": "online", "robot_id": "turtlebot468"}}
    )
    assert fired is None
    assert agent.calls == []


def test_morning_stretch_fires_motion_free_emote_turn():
    engine, agent, _ = _engine()
    assert engine.morning_stretch() == "morning_stretch"
    assert agent.calls[0]["allow_motion"] is False
    assert agent.calls[0]["session_id"] == "system-autonomy"
    assert "stretch" in agent.calls[0]["system_event"].lower()


def test_engine_survives_agent_exception():
    class BoomAgent(FakeAgent):
        def chat(self, **kwargs):
            raise RuntimeError("bedrock down")

    engine = EventEngine(agent=BoomAgent(), store=FakeStore(), default_robot_id="turtlebot468")
    # A firing rule must not propagate the agent error to the MQTT callback thread.
    assert engine.on_status_event({"robot_id": "turtlebot468", "data": {"battery": 0.12}}) == "low_battery"
