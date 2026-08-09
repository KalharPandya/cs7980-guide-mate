"""WebSocket chat endpoint tests: /ws/chat/{session_id}.

Two layers:
  * lightweight protocol tests over a minimal FastAPI app with a fake WS-path
    agent (no Bedrock / MQTT / Polly / DynamoDB) — assert the reply+audio shapes,
    the order-independent release gate + timeout fallback, and the hardened
    receive loop (malformed frames don't kill the socket);
  * integration tests over the REAL app (fake robot registry + moto DynamoDB +
    faked Bedrock) — assert the WS turn is session-aware, persists EXACTLY one
    user + one dog row (single persistence owner = DogAgent, no double-persist),
    is virtual-honest (no publish / no robot named when unbound), and publishes to
    the per-session bound robot (never a hardcoded id) when bound.
"""
import base64

from fastapi import FastAPI
from fastapi.testclient import TestClient

import guidemate_agent.app as appmod
import guidemate_agent.ws_chat as ws_chat
from guidemate_agent import dog_agent, kb, sessions
from guidemate_agent.observability import Observability


# ===================================================================== fakes ==
class _FakeAgent:
    """Stand-in for the WS-path DogAgent: session-aware signature, picks 'happy'."""

    def __init__(self):
        self.seen = []

    def chat(self, message, session_id=None, robot_id=None):
        self.seen.append({"message": message, "session_id": session_id, "robot_id": robot_id})
        return {"reply_text": "woof! happy to help", "emote": "happy",
                "robot": [], "turn_id": "turn-x", "session_id": session_id}


class _FakeRegistry:
    def __init__(self):
        self.published = []

    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        from guidemate_msgs.messages import Ack
        self.published.append((robot_id, cmd.name))
        return [Ack(cmd_id=cmd.cmd_id, state="done", simulated=True)]

    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "online"}


class _FakeTranscribe:
    """No-op Transcribe session so the audio-frame paths never touch AWS."""

    def __init__(self, **kw):
        pass

    async def start(self):
        return None

    async def feed(self, pcm):
        return None

    async def finish(self):
        return ""


def _app(monkeypatch, resolver):
    monkeypatch.setattr(ws_chat, "synthesize_mp3", lambda text, **kw: b"MP3BYTES")
    monkeypatch.setattr(ws_chat, "TranscribeSession", _FakeTranscribe)
    app = FastAPI()
    app.state.registry = _FakeRegistry()
    app.state.observability = Observability()
    app.state.ws_agent = _FakeAgent()
    app.state.robot_target_resolver = resolver

    class _Cfg:
        region = "us-west-2"
    app.state.config = _Cfg()
    ws_chat.register(app)
    return app


# ======================================================= protocol (fake app) ==
def test_text_message_virtual_session_returns_reply_and_audio(monkeypatch):
    app = _app(monkeypatch, resolver=lambda sid: None)  # virtual
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-1") as ws:
            ws.send_json({"type": "text", "message": "hi moses"})
            reply = ws.receive_json()
            audio = ws.receive_json()
    assert reply["type"] == "reply"
    assert reply["emote"] == "happy"
    assert reply["gate_released"] is True
    assert audio["type"] == "audio"
    assert base64.b64decode(audio["b64"]) == b"MP3BYTES"
    # Virtual session: the WS layer must NOT publish to the robot.
    assert app.state.registry.published == []
    # The turn is routed through the SESSION-AWARE path (session_id threaded).
    assert app.state.ws_agent.seen[0]["session_id"] == "sess-1"


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


class _MotionAgent:
    """WS-path agent stand-in that ran a trick + a stop, plus the mandatory emote."""

    def __init__(self):
        self.seen = []

    def chat(self, message, session_id=None, robot_id=None):
        self.seen.append({"message": message, "session_id": session_id})
        return {"reply_text": "spinning!", "emote": "happy",
                "commands": [{"type": "motion", "name": "spin"},
                             {"type": "stop", "name": "stop"}],
                "robot": [], "turn_id": "turn-m", "session_id": session_id}


def test_physical_session_publishes_all_captured_commands(monkeypatch):
    # Every physical command the agent ran (trick, stop, ...) must reach the real
    # robot through the SINGLE dispatch loop — the CaptureRegistry-backed agent
    # never publishes; the WS layer forwards, like it does the emote.
    app = _app(monkeypatch, resolver=lambda sid: "turtlebot468")  # physical
    app.state.ws_agent = _MotionAgent()
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-motion") as ws:
            ws.send_json({"type": "text", "message": "do a spin then stop"})
            ws.receive_json()  # reply
            ws.receive_json()  # audio
    names = [n for (_r, n) in app.state.registry.published]
    assert "spin" in names           # trick forwarded
    assert "stop" in names           # stop tool forwarded (was silently dead)
    assert names.index("spin") < names.index("stop")  # captured order preserved
    # The turn ran a motion trick -> the emote animates the AVATAR only; the
    # robot must not wiggle before/over the requested trick.
    assert "happy" not in names


def test_virtual_session_never_publishes_motion(monkeypatch):
    app = _app(monkeypatch, resolver=lambda sid: None)  # virtual/unbound
    app.state.ws_agent = _MotionAgent()
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-motion-v") as ws:
            ws.send_json({"type": "text", "message": "do a spin"})
            ws.receive_json(); ws.receive_json()
    assert app.state.registry.published == []  # no robot bound -> nothing published


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
    assert app.state.registry.published == [("turtlebot468", "happy")]


def test_stop_message_physical_session_forwards_stop_command(monkeypatch):
    """The persistent user-facing Stop sends a real stop Command to the bound
    robot via the registry (same mechanism as the agent's stop tool)."""
    app = _app(monkeypatch, resolver=lambda sid: "turtlebot468")  # physical
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-stop") as ws:
            ws.send_json({"type": "stop"})
            ack = ws.receive_json()
    assert ack["type"] == "stopped"
    assert ack["sent"] is True
    assert ack["robot_id"] == "turtlebot468"
    assert app.state.registry.published == [("turtlebot468", "stop")]


def test_stop_message_virtual_session_publishes_nothing(monkeypatch):
    """A virtual/unbound session has no robot to stop: ack sent=False, no publish,
    and the socket keeps serving."""
    app = _app(monkeypatch, resolver=lambda sid: None)  # virtual
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-stop-v") as ws:
            ws.send_json({"type": "stop"})
            ack = ws.receive_json()
            # socket still alive for the next message
            ws.send_json({"type": "text", "message": "hi"})
            reply = ws.receive_json()
    assert ack["type"] == "stopped"
    assert ack["sent"] is False
    assert app.state.registry.published == []
    assert reply["type"] == "reply"


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


def test_malformed_json_frame_yields_error_and_socket_survives(monkeypatch):
    """A non-JSON text frame -> {'type':'error'} frame, socket stays open for a
    subsequent good turn (the receive loop swallows the parse error)."""
    app = _app(monkeypatch, resolver=lambda sid: None)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-6") as ws:
            ws.send_text("this is not json {{{")
            err = ws.receive_json()
            assert err["type"] == "error"
            # socket still usable
            ws.send_json({"type": "text", "message": "hi"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    assert reply["type"] == "reply"


def test_bad_sample_rate_yields_error_and_socket_survives(monkeypatch):
    """A client-declared sample_rate < 16000 makes downsample_pcm16 raise; the
    guarded loop replies with an error frame and keeps the socket open."""
    app = _app(monkeypatch, resolver=lambda sid: None)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/sess-7") as ws:
            ws.send_json({"type": "start_audio", "sample_rate": 8000})
            ws.send_bytes(b"\x01\x00\x02\x00\x03\x00\x04\x00")  # PCM16 chunk
            err = ws.receive_json()
            assert err["type"] == "error"
            ws.send_json({"type": "text", "message": "hi"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    assert reply["type"] == "reply"


# ================================================ integration (real DogAgent) ==
class _FakeStrands:
    """strands.Agent stand-in: records how it was built and invokes send_emote
    when called, so publish / no-publish is observable through the registry."""

    last = None

    def __init__(self, model=None, system_prompt=None, tools=None, callback_handler=None):
        self.system_prompt = system_prompt
        self.tools = list(tools or [])
        self.tool_names = [t.tool_name for t in self.tools]
        self.callback_handler = callback_handler
        type(self).last = self

    def __call__(self, message):
        self.message = message
        for t in self.tools:
            if t.tool_name == "send_emote":
                t("happy")
        return "woof woof"


def _fake_bedrock(monkeypatch):
    monkeypatch.setattr(dog_agent, "Agent", _FakeStrands)
    monkeypatch.setattr(dog_agent, "BedrockModel", lambda **kw: None)


def _fake_client(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setattr(ws_chat, "synthesize_mp3", lambda text, **kw: b"MP3")
    return TestClient(appmod.app)


def test_ws_virtual_turn_is_session_aware_and_single_persist(monkeypatch, ddb):
    """Virtual (no-robot) WS turn: memory-capable session path + virtual framing,
    NO MQTT publish, no robot named (get_status withheld), and EXACTLY one user +
    one dog message persisted (single owner = DogAgent, no double-persist)."""
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        with client.websocket_connect(f"/ws/chat/{sid}") as ws:
            ws.send_json({"type": "text", "message": "hello"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
        assert reply["type"] == "reply"
        assert reply["emote"] == "happy"
        assert reply["gate_released"] is True
        # single persistence: exactly one user + one dog row, in order
        msgs = sessions.get_messages(sid)
        assert [m["role"] for m in msgs] == ["user", "dog"]
        # virtual-honest: nothing published, and no robot named (get_status/motion
        # tools withheld because the session holds no robot lock)
        assert client.app.state.registry.sent == []
        assert "get_status" not in _FakeStrands.last.tool_names
        assert "run_motion" not in _FakeStrands.last.tool_names


def test_ws_physical_turn_publishes_to_bound_robot(monkeypatch, ddb):
    """Robot-bound WS turn: emote published to the PER-SESSION bound robot (never a
    hardcoded id), physical framing (get_status offered), single persistence."""
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        sessions.approve_request(sessions.create_request(sid), "turtlebot468")
        with client.websocket_connect(f"/ws/chat/{sid}") as ws:
            ws.send_json({"type": "text", "message": "wiggle"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
        assert reply["gate_released"] is True
        # real emote publish went to the bound robot via the WS layer
        assert ("turtlebot468", "emote", "happy") in client.app.state.registry.sent
        # physical framing: get_status offered this turn
        assert "get_status" in _FakeStrands.last.tool_names
        # single persistence still holds on the physical path
        assert [m["role"] for m in sessions.get_messages(sid)] == ["user", "dog"]


# ============================================ KB citation sources on the reply ==
class _FakeStrandsKB:
    """strands.Agent stand-in that GROUNDS: it calls retrieve_kb (so the turn's
    KB citations are captured) and then send_emote."""

    last = None

    def __init__(self, model=None, system_prompt=None, tools=None, callback_handler=None):
        self.system_prompt = system_prompt
        self.tools = list(tools or [])
        self.tool_names = [t.tool_name for t in self.tools]
        self.callback_handler = callback_handler
        type(self).last = self

    def __call__(self, message):
        self.message = message
        for t in self.tools:
            if t.tool_name == "retrieve_kb":
                t("who is moses")
        for t in self.tools:
            if t.tool_name == "send_emote":
                t("happy")
        return "woof! moses is a turtlebot 4"


def test_ws_kb_grounded_reply_frame_includes_sources(monkeypatch, ddb):
    """A turn that used KB retrieval carries its citations on the reply frame as
    ``sources`` = [{"title", "url"}] (title = the KB doc key)."""
    monkeypatch.setattr(dog_agent, "Agent", _FakeStrandsKB)
    monkeypatch.setattr(dog_agent, "BedrockModel", lambda **kw: None)
    monkeypatch.setattr(
        kb,
        "retrieve_passages_with_sources",
        lambda *a, **k: (
            "[s3://guidemate-kb-docs/moses-facts.md] moses is a turtlebot 4",
            [{"title": "moses-facts.md", "url": None}],
        ),
    )
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        with client.websocket_connect(f"/ws/chat/{sid}") as ws:
            ws.send_json({"type": "text", "message": "who is moses?"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    assert reply["type"] == "reply"
    assert reply["sources"] == [{"title": "moses-facts.md", "url": None}]
    # existing reply-frame fields + emote-sync are untouched
    assert reply["emote"] == "happy"
    assert reply["gate_released"] is True
    assert reply["turn_id"]


# ======================================= guide_to_room on the REAL WS chat path ==
class _FakeStrandsGuide:
    """strands.Agent stand-in that exercises guide_to_room (Task 4.2) through the
    REAL WS chat path. This is the exact reproduction for the bug found live during
    Task 4.3's e2e testing: the WS-path DogAgent is backed by CaptureRegistry (see
    ws_chat.py), which had no send_fleet_command -- so guide_to_room raised
    AttributeError inside _guide_impl, swallowed by _run_pipeline's top-level
    except, and every real "take me to room X" request silently got the generic
    "sorry, I got a little confused" apology instead of a guide confirmation.
    Task 4.2's own tests never caught this because they used a purpose-built
    FleetRegistry fake (test_dog_agent.py), never CaptureRegistry."""

    last = None

    # callback_handler is accepted (and ignored) like the sibling fakes above:
    # DogAgent.chat builds the real Agent with callback_handler=None, so a fake
    # without it raises TypeError inside the pipeline and the turn degrades to
    # the generic apology with no audio frame.
    def __init__(self, model=None, system_prompt=None, tools=None, callback_handler=None):
        self.system_prompt = system_prompt
        self.tools = list(tools or [])
        self.tool_names = [t.tool_name for t in self.tools]
        type(self).last = self

    def __call__(self, message):
        self.message = message
        guide_reply = None
        for t in self.tools:
            if t.tool_name == "guide_to_room":
                guide_reply = t("Kitchen")
        for t in self.tools:
            if t.tool_name == "send_emote":
                t("happy")
        return f"woof! {guide_reply}"


def test_ws_virtual_turn_guide_to_room_does_not_raise_and_dispatches_real_fleet_command(
    monkeypatch, ddb
):
    """Regression for the CaptureRegistry.send_fleet_command gap on the REAL WS chat
    path (app.state.ws_agent, not a Task-4.2 fake registry). A virtual (no-robot)
    session asking to be guided must NOT crash the turn -- no AttributeError, no
    generic apology -- and the fleet "assign" command must actually reach the real
    registry backing app.state.registry (FakeRobotRegistry under
    GUIDEMATE_FAKE_ROBOT=1), not just a fake ack that sounds right but dispatches
    nothing."""
    monkeypatch.setattr(dog_agent, "Agent", _FakeStrandsGuide)
    monkeypatch.setattr(dog_agent, "BedrockModel", lambda **kw: None)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        with client.websocket_connect(f"/ws/chat/{sid}") as ws:
            ws.send_json({"type": "text", "message": "can you guide me to the kitchen?"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    # The turn completed normally -- did NOT hit the pipeline-exception apology.
    assert reply["type"] == "reply"
    assert reply["text"] != "sorry, I got a little confused"
    assert "heading" in reply["text"].lower()
    assert "virtual/demo-1" in reply["text"]
    # guide_to_room was offered (virtual session -- no bound robot).
    assert "guide_to_room" in _FakeStrandsGuide.last.tool_names
    # The fleet assign command reached the REAL registry (delegated through
    # CaptureRegistry(fleet_registry=...) in app.py), proving this is a real
    # dispatch, not an isolated fake ack.
    assert ("(fleet)", "assign", "assign") in client.app.state.registry.sent


def test_ws_non_kb_reply_frame_has_no_sources(monkeypatch, ddb):
    """A turn that did NOT ground on the KB ships an empty ``sources`` list."""
    _fake_bedrock(monkeypatch)  # _FakeStrands: only calls send_emote, never retrieve_kb
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        with client.websocket_connect(f"/ws/chat/{sid}") as ws:
            ws.send_json({"type": "text", "message": "hi"})
            reply = ws.receive_json()
            ws.receive_json()  # audio
    assert reply["type"] == "reply"
    assert reply["sources"] == []
    assert reply["emote"] == "happy"
