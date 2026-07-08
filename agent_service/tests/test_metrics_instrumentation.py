"""Phase-7 Task 2: EMF metrics instrumentation + /readyz.

ADAPTATIONS from the brief (merged reality wins — see report for detail):
- `/readyz` reports `{"ready": bool, "checks": {"mqtt": bool, "dynamo": bool}}`,
  not the brief's `{"creds", "registry"}` shape. Reality: `app.state.registry`
  is always set once lifespan runs (even when MQTT connect failed), so a
  "registry is not None" check is never useful; the real signal is whether the
  registry's MQTT link came up. `RobotRegistry.is_connected` (new, cheap
  property) and `FakeRobotRegistry.is_connected` (new, always True) supply
  that. "creds" is dropped since AWS creds are also required to reach Dynamo,
  so it's folded into (and superseded by) the `dynamo` check via
  `ConfigStore.get_flags()` (already TTL-cached, so /readyz doesn't hammer
  DynamoDB).
- `_emote_impl`/`_motion_impl` in the merged tree already differ from the
  brief's drafted bodies (physical/virtual gating, `captured["acks"].extend`
  not `=`); the AckRoundTripMs timer was added around the existing
  `send_command` calls in both, wrapping the merged bodies rather than
  replacing them with the brief's snapshot.
- `chat()`'s BedrockInputTokens/OutputTokens block was added right after the
  existing `result = agent(message)` / `reply_text = str(result)` lines
  (session-aware chat() didn't exist in the brief's snapshot).
- `/api/chat` also emits `ErrorCount` on any caught (non-HTTPException)
  exception, per the task brief's explicit instrumentation list (not present
  in the Task-2 doc's own drafted route, which predates session-aware chat).
"""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from guidemate_agent.dog_agent import DogAgent, _usage_from_result


def _metrics(capsys, name):
    out = capsys.readouterr().out
    hits = []
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if name in data and "_aws" in data:
            hits.append(data)
    return hits


def _last_metric(capsys, name):
    hits = _metrics(capsys, name)
    return hits[-1] if hits else None


def test_usage_from_result_reads_accumulated_usage():
    result = SimpleNamespace(
        metrics=SimpleNamespace(accumulated_usage={"inputTokens": 12, "outputTokens": 34})
    )
    assert _usage_from_result(result) == (12, 34)


def test_usage_from_result_missing_is_none():
    assert _usage_from_result(SimpleNamespace()) is None
    assert _usage_from_result(SimpleNamespace(metrics=None)) is None
    assert _usage_from_result(SimpleNamespace(metrics=SimpleNamespace())) is None
    assert _usage_from_result("plain string result") is None


class _FakeRegistry:
    def send_command(self, robot_id, cmd, timeout_s=5.0):
        # Needs both .simulated (read by the merged _emote_impl's ack-message
        # branch) and .model_dump() (read into captured["acks"]) — the brief's
        # drafted fake only had model_dump(), which the merged _emote_impl body
        # (unlike the brief's snapshot) doesn't fully cover.
        return [SimpleNamespace(simulated=True, model_dump=lambda: {"state": "done", "simulated": True})]


def test_emote_impl_emits_ack_roundtrip(capsys):
    agent = DogAgent(registry=_FakeRegistry(), model_id="x", robot_ids=["turtlebot468"])
    captured = {"emote": None, "acks": []}
    agent._emote_impl("happy", "turtlebot468", captured)
    metric = _last_metric(capsys, "AckRoundTripMs")
    assert metric is not None
    assert metric["robot_id"] == "turtlebot468"
    assert metric["AckRoundTripMs"] >= 0.0


def test_motion_impl_emits_ack_roundtrip(capsys):
    from guidemate_msgs.messages import Ack

    class _MotionRegistry:
        def send_command(self, robot_id, cmd, timeout_s=5.0):
            return [Ack(cmd_id="c", state="done", simulated=True)]

    agent = DogAgent(registry=_MotionRegistry(), model_id="x", robot_ids=["turtlebot468"])
    captured = {"emote": None, "acks": []}
    agent._motion_impl("spin", "turtlebot468", captured)
    metric = _last_metric(capsys, "AckRoundTripMs")
    assert metric is not None
    assert metric["robot_id"] == "turtlebot468"
    assert metric["AckRoundTripMs"] >= 0.0


class _StubAgent:
    def chat(self, message, session_id=None, robot_id=None):
        return {"reply_text": "woof", "emote": "happy", "robot": [], "turn_id": "t1"}


class _BoomAgent:
    def chat(self, message, session_id=None, robot_id=None):
        raise RuntimeError("boom")


def _app_with_stub(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "invalid.example.com")
    import guidemate_agent.app as appmod

    def _boom(self):
        raise RuntimeError("no MQTT in unit test")

    monkeypatch.setattr(appmod.RobotRegistry, "connect", _boom)
    return appmod.app


def test_chat_endpoint_emits_turn_latency(monkeypatch, capsys):
    app = _app_with_stub(monkeypatch)
    with TestClient(app) as client:
        client.app.state.agent = _StubAgent()
        resp = client.post("/api/chat", json={"message": "hi"})
        assert resp.status_code == 200
    metric = _last_metric(capsys, "TurnLatencyMs")
    assert metric is not None
    assert metric["TurnLatencyMs"] >= 0.0


def test_chat_endpoint_emits_error_count_on_exception(monkeypatch, capsys):
    app = _app_with_stub(monkeypatch)
    with TestClient(app, raise_server_exceptions=False) as client:
        client.app.state.agent = _BoomAgent()
        resp = client.post("/api/chat", json={"message": "hi"})
        assert resp.status_code == 500
    out = capsys.readouterr().out
    lines = [json.loads(l) for l in out.splitlines() if l.strip().startswith("{")]
    error_metrics = [d for d in lines if "ErrorCount" in d and "_aws" in d]
    latency_metrics = [d for d in lines if "TurnLatencyMs" in d and "_aws" in d]
    assert error_metrics and error_metrics[-1]["ErrorCount"] == 1
    # latency is still recorded even on failure (finally-block instrumentation)
    assert latency_metrics


def test_readyz_not_ready_when_mqtt_and_dynamo_down(monkeypatch):
    app = _app_with_stub(monkeypatch)
    with TestClient(app) as client:
        # lifespan's connect() raised, so registry.is_connected is False; and
        # no `ddb` fixture is active, so ConfigStore.get_flags() will fail to
        # reach a live table too — both checks land False without mocking.
        resp = client.get("/readyz")
    assert resp.status_code == 503
    body = resp.json()
    assert "checks" in body and "mqtt" in body["checks"] and "dynamo" in body["checks"]
    assert body["checks"]["mqtt"] is False
    assert body["ready"] == all(body["checks"].values())


def test_readyz_ready_when_mqtt_and_dynamo_up(monkeypatch, ddb):
    app = _app_with_stub(monkeypatch)
    import guidemate_agent.app as appmod

    # is_connected is a read-only property on the real RobotRegistry (reflects
    # whether connect() built a live MQTT connection); override at the class
    # level to simulate the "MQTT is up" branch without a real broker.
    monkeypatch.setattr(appmod.RobotRegistry, "is_connected", True)
    with TestClient(app) as client:
        resp = client.get("/readyz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["checks"] == {"mqtt": True, "dynamo": True}
    assert body["ready"] is True
