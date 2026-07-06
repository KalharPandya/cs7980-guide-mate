"""WebSocket chat endpoint tests: /ws/chat/{session_id}.

Exercises the full transcript -> agent turn -> emote-sync -> reply+audio pipeline
with fakes (no Bedrock / no MQTT / no Polly / no DynamoDB). The emote publish +
order-independent release gate live in the WS layer (ws_chat), so these tests
assert the virtual (no-robot) and robot-bound paths from the WS side directly.
"""
import base64

from fastapi import FastAPI
from fastapi.testclient import TestClient

import guidemate_agent.ws_chat as ws_chat
from guidemate_agent.observability import Observability


class _FakeAgent:
    """Stand-in for the WS-path DogAgent: picks 'happy', no Bedrock/MQTT."""

    def __init__(self):
        self.seen = []

    def chat(self, message, robot_id=None):
        self.seen.append((message, robot_id))
        return {"reply_text": "woof! happy to help", "emote": "happy",
                "robot": [], "turn_id": "turn-x"}


class _FakeRegistry:
    def __init__(self):
        self.published = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        from guidemate_msgs.messages import Ack
        self.published.append((robot_id, cmd.name))
        return [Ack(cmd_id=cmd.cmd_id, state="done", simulated=True)]

    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "online"}


def _app(monkeypatch, resolver):
    monkeypatch.setattr(ws_chat, "synthesize_mp3", lambda text, **kw: b"MP3BYTES")
    # Persistence exercised via a fake so the unit test never touches real AWS.
    persisted: list = []
    monkeypatch.setattr(
        ws_chat.sessions, "append_message",
        lambda session_id, role, text: persisted.append((session_id, role, text)),
    )
    app = FastAPI()
    app.state.registry = _FakeRegistry()
    app.state.observability = Observability()
    app.state.ws_agent = _FakeAgent()
    app.state.robot_target_resolver = resolver
    app.state._persisted = persisted

    class _Cfg:
        region = "us-west-2"
    app.state.config = _Cfg()
    ws_chat.register(app)
    return app


def test_text_message_virtual_session_returns_reply_and_audio(monkeypatch):
    app = _app(monkeypatch, resolver=lambda sid: None)  # virtual
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-1") as ws:
            ws.send_json({"type": "text", "message": "hi robert"})
            reply = ws.receive_json()
            audio = ws.receive_json()
    assert reply["type"] == "reply"
    assert reply["emote"] == "happy"
    assert reply["gate_released"] is True
    assert audio["type"] == "audio"
    assert base64.b64decode(audio["b64"]) == b"MP3BYTES"
    # Virtual session: the WS layer must NOT publish to the robot.
    assert app.state.registry.published == []


def test_text_message_physical_session_publishes_and_records(monkeypatch):
    app = _app(monkeypatch, resolver=lambda sid: "turtlebot468")  # physical
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-2") as ws:
            ws.send_json({"type": "text", "message": "sit"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    assert reply["gate_released"] is True
    assert app.state.registry.published == [("turtlebot468", "happy")]
    cmds = app.state.observability.snapshot()["commands"]
    assert cmds and cmds[0]["robot_id"] == "turtlebot468"
    lat = app.state.observability.snapshot()["latencies"]
    assert lat and lat[0]["turn_id"]


def test_text_message_persists_user_and_assistant(monkeypatch):
    """Both the user utterance and the assistant reply are persisted, in order,
    regardless of robot binding (virtual session shown here)."""
    app = _app(monkeypatch, resolver=lambda sid: None)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-3") as ws:
            ws.send_json({"type": "text", "message": "hello robert"})
            ws.receive_json()  # reply
            ws.receive_json()  # audio
    assert app.state._persisted == [
        ("sess-3", "user", "hello robert"),
        ("sess-3", "dog", "woof! happy to help"),
    ]


def test_blank_text_message_is_ignored(monkeypatch):
    """An empty/whitespace message runs no turn (no reply frame, no publish)."""
    app = _app(monkeypatch, resolver=lambda sid: "turtlebot468")
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-4") as ws:
            ws.send_json({"type": "text", "message": "   "})
            # A follow-up real message must still be answered on the same socket.
            ws.send_json({"type": "text", "message": "sit"})
            reply = ws.receive_json()
    assert reply["type"] == "reply"
    # Only the real message produced a publish.
    assert app.state.registry.published == [("turtlebot468", "happy")]


def test_dropped_ack_still_releases_reply(monkeypatch):
    """Timeout fallback: a robot that never confirms (no running/done ack) must
    NOT wedge the turn — gate_released is False but the reply+audio still ship."""
    app = _app(monkeypatch, resolver=lambda sid: "turtlebot468")

    class _SilentRegistry:
        def __init__(self):
            self.published = []

        def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
            self.published.append((robot_id, cmd.name))
            return []  # no ack arrived within the timeout

        def get_status(self, robot_id):
            return {"robot_id": robot_id}

    app.state.registry = _SilentRegistry()
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-5") as ws:
            ws.send_json({"type": "text", "message": "sit"})
            reply = ws.receive_json()
            audio = ws.receive_json()
    assert reply["type"] == "reply"
    assert reply["gate_released"] is False
    assert audio["type"] == "audio"
    assert app.state.registry.published == [("turtlebot468", "happy")]
