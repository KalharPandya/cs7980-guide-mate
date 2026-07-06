import time

from guidemate_msgs.messages import Ack

from guidemate_agent.observability import Observability


def _acks(*states):
    return [Ack(cmd_id="c1", state=s, simulated=True) for s in states]


def test_record_command_captures_states_and_timing():
    obs = Observability()
    sent = time.monotonic() - 0.05
    obs.record_command("t1", "turtlebot468", "c1", sent, _acks("received", "running", "done"))
    cmds = obs.snapshot()["commands"]
    assert len(cmds) == 1
    rec = cmds[0]
    assert rec["robot_id"] == "turtlebot468"
    assert rec["cmd_id"] == "c1"
    assert rec["states"] == ["received", "running", "done"]
    assert rec["simulated"] is True
    assert rec["total_ms"] >= 40.0


def test_commands_ring_keeps_only_last_10_newest_first():
    obs = Observability(max_commands=10)
    for i in range(13):
        obs.record_command(f"t{i}", "r", f"c{i}", time.monotonic(), _acks("done"))
    cmds = obs.snapshot()["commands"]
    assert len(cmds) == 10
    assert cmds[0]["cmd_id"] == "c12"      # newest first
    assert cmds[-1]["cmd_id"] == "c3"      # c0,c1,c2 evicted


def test_record_latency_and_errors():
    obs = Observability()
    obs.record_latency("t1", 812.5, "sess-1")
    obs.record_error("tts", "polly blew up", turn_id="t1")
    snap = obs.snapshot()
    assert snap["latencies"][0]["bedrock_ms"] == 812.5
    assert snap["latencies"][0]["session_id"] == "sess-1"
    assert snap["errors"][0]["where"] == "tts"
    assert "polly" in snap["errors"][0]["message"]


def test_gates_key_present_and_defensive_on_phase01_ack():
    # Phase 0-1 Ack has no `gates` field. record_command must not crash and must
    # still emit a "gates" key (None) — it picks up the real dict once Phase 2 lands.
    obs = Observability()
    obs.record_command("t1", "r", "c1", time.monotonic(), _acks("received", "done"))
    rec = obs.snapshot()["commands"][0]
    assert "gates" in rec
    assert rec["gates"] is None


def test_gates_captured_when_ack_is_a_dict_with_gates():
    # A dict-shaped ack that carries gates (mirrors a Phase-2 Ack.model_dump()).
    obs = Observability()
    ack = {"cmd_id": "c1", "state": "done", "simulated": True,
           "gates": {"motion_enabled": False, "docked": True}}
    obs.record_command("t1", "r", "c1", time.monotonic(), [ack])
    rec = obs.snapshot()["commands"][0]
    assert rec["gates"] == {"motion_enabled": False, "docked": True}
