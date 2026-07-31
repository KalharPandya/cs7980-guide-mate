from fastapi.testclient import TestClient

from guidemate_agent.config import Config
from guidemate_agent.dog_agent import PERSONA


def test_config_defaults(monkeypatch):
    for var in ("GUIDEMATE_ROBOTS", "GUIDEMATE_IOT_ENDPOINT", "GUIDEMATE_MODEL_ID", "AWS_REGION"):
        monkeypatch.delenv(var, raising=False)
    cfg = Config.from_env()
    # Phase 8 Task 7 (virtual-pet grant): turtlebotsim is grantable out of the
    # box alongside the physical turtlebot468.
    assert cfg.robot_ids == ["turtlebot468", "turtlebotsim"]
    assert cfg.model_id == "us.anthropic.claude-sonnet-4-6"
    assert cfg.region == "us-west-2"


def test_config_parses_multiple_robots(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ROBOTS", "turtlebot468, turtlebotsim")
    assert Config.from_env().robot_ids == ["turtlebot468", "turtlebotsim"]


def test_persona_mentions_robert_and_emote_rule():
    assert "Robert" in PERSONA
    assert "send_emote" in PERSONA


def _no_connect(monkeypatch):
    # Lifespan tolerates connect failure; force it to fail fast (no real DNS/MQTT).
    monkeypatch.setenv("GUIDEMATE_IOT_ENDPOINT", "invalid.example.com")
    import guidemate_agent.app as appmod

    def _boom(self):
        raise RuntimeError("no MQTT in unit test")

    monkeypatch.setattr(appmod.RobotRegistry, "connect", _boom)
    return appmod.app


def test_healthz(monkeypatch):
    app = _no_connect(monkeypatch)
    with TestClient(app) as client:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}


def test_index_served(monkeypatch):
    app = _no_connect(monkeypatch)
    with TestClient(app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        assert "Moses" in resp.text
        # Task 5 polished chat UI: intake gate + chat shell DOM hooks that
        # both chat.js and the gated Playwright e2e (test_companion_flow.py)
        # depend on by id.
        for hook in (
            'id="intake"', 'id="name"', 'id="comfortable"', 'id="start"',
            'id="chat"', 'id="avatar"', 'id="companion-status"',
            'id="request-companion"', 'id="messages"', 'id="chat-form"',
            'id="message"', 'id="mic"', 'id="status-chip"',
            # Task 4.3: the visitor-bound banner hook the state poll drives.
            'id="visitor-banner"',
            'chat.css', 'chat.js',
        ):
            assert hook in resp.text, f"missing {hook}"


def test_chat_static_assets_served(monkeypatch):
    """chat.js/chat.css are served as real routes (not just referenced) and
    the JS is well-formed enough to at least balance braces/parens -- a cheap
    proxy for "no syntax errors" without a JS runtime in this environment."""
    app = _no_connect(monkeypatch)
    with TestClient(app) as client:
        js = client.get("/chat.js")
        assert js.status_code == 200
        assert "javascript" in js.headers["content-type"]
        body = js.text
        assert body.count("{") == body.count("}")
        assert body.count("(") == body.count(")")
        # Emote<->audio sync contract: the emote is armed on "reply" and only
        # released on the audio element's own "play" event, not on arrival.
        assert 'armPendingEmote(msg.emote)' in body
        assert 'player.addEventListener("play"' in body
        assert "/ws/chat/" in body

        css = client.get("/chat.css")
        assert css.status_code == 200
        assert "text/css" in css.headers["content-type"]
        assert "emote-happy" in css.text


# ---------------------------------------- Task 4.3: join QR -------------------
def test_join_qr_returns_svg_encoding_the_chat_page_url(monkeypatch):
    """GET /api/join-qr -- for the big-screen/admin display, not the phone.
    Real ``qrcode`` library encoding (no hand-rolled QR math): this test spies on
    the library's own ``qrcode.make`` entry point to assert OUR code hands it
    exactly this server's own root URL (the same page a phone lands on after
    scanning) -- correctness of the QR encoding itself is the library's job."""
    app = _no_connect(monkeypatch)
    import guidemate_agent.app as appmod

    captured = {}
    real_make = appmod.qrcode.make

    def spy_make(data, **kw):
        captured["data"] = data
        return real_make(data, **kw)

    monkeypatch.setattr(appmod.qrcode, "make", spy_make)
    with TestClient(app) as client:
        resp = client.get("/api/join-qr")
        assert resp.status_code == 200
        assert "svg" in resp.headers["content-type"]
        assert "<svg" in resp.text
        assert captured["data"] == str(client.base_url) + "/"


def test_fake_robot_registry_status_and_acks():
    from guidemate_agent.fakes import FakeRobotRegistry

    reg = FakeRobotRegistry(["turtlebot468"])
    reg.connect()
    st = reg.get_status("turtlebot468")
    assert st["robot_id"] == "turtlebot468"
    assert st["presence"] == "online"
    from guidemate_msgs.messages import Command

    acks = reg.send_command("turtlebot468", Command(type="emote", name="happy"))
    assert [a.state for a in acks] == ["received", "running", "done"]
    assert acks[-1].simulated is True


def test_fake_robot_registry_send_fleet_command_simulates_assign():
    from guidemate_agent.fakes import FakeRobotRegistry
    from guidemate_msgs.messages import Command

    reg = FakeRobotRegistry(["turtlebot468"])
    cmd = Command(type="assign", name="assign", params={"visitor_id": "v", "room": "Kitchen"})

    acks = reg.send_fleet_command(cmd)

    assert [a.state for a in acks] == ["received", "done"]
    assert acks[-1].assigned_robot_id
    assert ("(fleet)", "assign", "assign") in reg.sent


def test_fake_robot_registry_send_fleet_command_simulates_stop_and_resume():
    """Task 5.2's fleet-wide kill switch (admin.py's /world/stop and
    /world/resume) publishes type="stop"/name="stop" via send_fleet_command --
    before this, FakeRobotRegistry only knew "assign" and would ack
    failed/unsupported_command_type for a stop, so the kill switch couldn't be
    demoed under GUIDEMATE_FAKE_ROBOT=1."""
    from guidemate_agent.fakes import FakeRobotRegistry
    from guidemate_msgs.messages import Command

    reg = FakeRobotRegistry(["turtlebot468"])

    stop_cmd = Command(type="stop", name="stop")
    stop_acks = reg.send_fleet_command(stop_cmd)
    assert [a.state for a in stop_acks] == ["received", "done"]
    assert all(a.simulated for a in stop_acks)
    assert ("(fleet)", "stop", "stop") in reg.sent

    resume_cmd = Command(type="stop", name="stop", params={"resume": True})
    resume_acks = reg.send_fleet_command(resume_cmd)
    assert [a.state for a in resume_acks] == ["received", "done"]
    assert ("(fleet)", "stop", "stop") in reg.sent


def test_admin_ui_served_and_router_mounted(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "secret")
    import importlib

    import guidemate_agent.app as appmod

    importlib.reload(appmod)
    try:
        with TestClient(appmod.app) as client:
            # admin static page
            page = client.get("/admin/")
            assert page.status_code == 200
            assert "Admin" in page.text
            # admin API mounted (401 without a cookie, NOT 404)
            assert client.get("/api/admin/flags").status_code == 401
    finally:
        monkeypatch.delenv("GUIDEMATE_FAKE_ROBOT", raising=False)
        monkeypatch.delenv("GUIDEMATE_ADMIN_PASSWORD", raising=False)
        importlib.reload(appmod)


# =====================================================================
# Phase-4 Task 5: session + companion HTTP API + GUIDEMATE_FAKE_ROBOT wiring.
#
# ADAPTATION (merged reality wins over the brief): the brief's /api/chat drafts
# app.py loading history / appending messages / passing user_name+history+
# robot_id to the agent. In the merged tree DogAgent.chat(message, session_id=,
# robot_id=) resolves name/history/robot binding AND persists both messages
# INTERNALLY (Task 4). So app.py just threads session_id through, and these
# tests exercise the real DogAgent with Bedrock faked (the _FakeStrands pattern
# from test_dog_agent) rather than the brief's user_name-passing _FakeAgent.
# =====================================================================
import guidemate_agent.app as appmod
from guidemate_agent import dog_agent, sessions


class _RecordingAgent:
    """Records chat() calls; matches the merged DogAgent.chat signature exactly.

    Used for the pure pass-through tests (no Bedrock, no session resolution)."""

    def __init__(self):
        self.calls = []

    def chat(self, message, session_id=None, robot_id=None):
        self.calls.append(
            {"message": message, "session_id": session_id, "robot_id": robot_id}
        )
        reply = {"reply_text": "woof", "emote": "happy", "robot": [], "turn_id": "t"}
        if session_id is not None:
            reply["session_id"] = session_id
        return reply


class _FakeStrands:
    """strands.Agent stand-in: records how it was built and invokes send_emote
    when called, so publish / no-publish is observable through the registry."""

    last = None

    def __init__(self, model=None, system_prompt=None, tools=None):
        self.system_prompt = system_prompt
        self.tools = list(tools or [])
        self.tool_names = [t.tool_name for t in self.tools]
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
    """TestClient over the real app with the in-memory fake robot registry."""
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    return TestClient(appmod.app)


def test_create_session_returns_id_and_initial_state(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        assert sid
        state = client.get(f"/api/session/{sid}/state").json()
        assert state["request_status"] == "none"
        assert state["robot_id"] is None


def test_chat_threads_session_id_through(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        fake = _RecordingAgent()
        client.app.state.agent = fake
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        resp = client.post("/api/chat", json={"session_id": sid, "message": "hello"})
        assert resp.status_code == 200
        assert resp.json()["reply_text"] == "woof"
        assert fake.calls[0]["session_id"] == sid       # session threaded through
        # legacy no-session call still works and passes session_id=None
        legacy = client.post("/api/chat", json={"message": "hi"})
        assert legacy.status_code == 200
        assert fake.calls[-1]["session_id"] is None


def test_chat_unknown_session_is_404(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        client.app.state.agent = _RecordingAgent()
        resp = client.post("/api/chat", json={"session_id": "nope", "message": "hi"})
        assert resp.status_code == 404


def test_chat_virtual_session_records_messages_no_publish(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        resp = client.post("/api/chat", json={"session_id": sid, "message": "hello"})
        assert resp.status_code == 200
        assert resp.json()["reply_text"] == "woof woof"
        # both user + dog messages persisted by the real DogAgent
        msgs = sessions.get_messages(sid)
        assert [m["role"] for m in msgs] == ["user", "dog"]
        # no robot bound -> virtual: nothing published, motion + get_status withheld
        assert client.app.state.registry.sent == []
        assert "run_motion" not in _FakeStrands.last.tool_names
        assert "get_status" not in _FakeStrands.last.tool_names


def test_chat_physical_session_publishes_to_bound_robot(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        sessions.approve_request(sessions.create_request(sid), "turtlebot468")
        resp = client.post("/api/chat", json={"session_id": sid, "message": "wiggle"})
        assert resp.status_code == 200
        # physical path: emote published to the bound robot, get_status offered
        assert ("turtlebot468", "emote", "happy") in client.app.state.registry.sent
        assert "get_status" in _FakeStrands.last.tool_names


def test_request_companion_sets_pending_state(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        client.app.state.agent = _RecordingAgent()
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        r = client.post(f"/api/session/{sid}/request-companion")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "pending"
        assert body["request_id"]
        state = client.get(f"/api/session/{sid}/state").json()
        assert state["request_status"] == "pending"
        assert state["robot_id"] is None


def test_request_companion_unknown_session_is_404(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        client.app.state.agent = _RecordingAgent()
        assert client.post("/api/session/nope/request-companion").status_code == 404


def test_state_unknown_session_is_404(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        client.app.state.agent = _RecordingAgent()
        assert client.get("/api/session/nope/state").status_code == 404


def test_request_companion_twice_is_idempotent(monkeypatch, ddb):
    with _fake_client(monkeypatch) as client:
        client.app.state.agent = _RecordingAgent()
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        first = client.post(f"/api/session/{sid}/request-companion").json()
        second = client.post(f"/api/session/{sid}/request-companion").json()
        assert first["request_id"] == second["request_id"]
        assert second["status"] == "pending"
        pending = [r for r in sessions.list_pending_requests() if r["session_id"] == sid]
        assert len(pending) == 1


def test_fake_registry_records_sent_and_refuses_motion():
    from guidemate_agent.fakes import FakeRobotRegistry
    from guidemate_msgs.messages import Command

    reg = FakeRobotRegistry(["turtlebot468"])
    # emote -> simulated success, recorded in .sent
    reg.send_command("turtlebot468", Command(type="emote", name="happy"))
    assert reg.sent[-1] == ("turtlebot468", "emote", "happy")
    # undock -> motion-locked refusal (received then failed), still recorded
    acks = reg.send_command("turtlebot468", Command(type="motion", name="undock"))
    assert reg.sent[-1] == ("turtlebot468", "motion", "undock")
    assert [a.state for a in acks] == ["received", "failed"]
    assert "motion_disabled" in acks[-1].reason


# =====================================================================
# Wave-2 (no-motion): user-facing session map + arsenal routes.
#
# These are the caller's OWN session (NOT admin-gated). They resolve the robot
# via sessions.robot_for_session and stream the map through app.state.s3 (the
# app's IAM role); every failure path degrades to 404 / false-null, never 500.
# =====================================================================
import json as _json

from guidemate_agent.maps import MAPS_BUCKET, map_key, meta_key


class _FakeBody:
    def __init__(self, data: bytes):
        self._data = data

    def read(self):
        return self._data


class _FakeS3:
    """Minimal boto3-s3 stand-in: returns preset objects or raises for missing keys."""

    def __init__(self, objects):
        self._objects = objects  # {(bucket, key): bytes}

    def get_object(self, Bucket, Key):  # noqa: N803 -- mirrors the boto3 signature
        try:
            data = self._objects[(Bucket, Key)]
        except KeyError:
            raise KeyError(Key)
        return {"Body": _FakeBody(data)}


_MAP_PNG = b"\x89PNG\r\n\x1a\nFAKEPNGBYTES"
_MAP_META = {"captured_ts": "2026-07-06T12:00:00+00:00", "source": "/home/ubuntu/map.pgm"}


def _bind(sid, robot_id="turtlebot468"):
    sessions.approve_request(sessions.create_request(sid), robot_id)


def test_session_map_bound_streams_png(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        _bind(sid)
        client.app.state.s3 = _FakeS3({(MAPS_BUCKET, map_key("turtlebot468")): _MAP_PNG})
        res = client.get(f"/api/session/{sid}/map")
        assert res.status_code == 200
        assert res.headers["content-type"] == "image/png"
        assert res.content == _MAP_PNG


def test_session_map_no_robot_is_404(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        # session created but never bound -> no robot -> clean 404 JSON
        client.app.state.s3 = _FakeS3({(MAPS_BUCKET, map_key("turtlebot468")): _MAP_PNG})
        res = client.get(f"/api/session/{sid}/map")
        assert res.status_code == 404
        assert "detail" in res.json()


def test_session_map_missing_key_is_404(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        _bind(sid)
        client.app.state.s3 = _FakeS3({})  # bound, but no map object in S3
        res = client.get(f"/api/session/{sid}/map")
        assert res.status_code == 404
        assert "detail" in res.json()


def test_session_map_meta_bound_returns_json(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        _bind(sid)
        client.app.state.s3 = _FakeS3(
            {(MAPS_BUCKET, meta_key("turtlebot468")): _json.dumps(_MAP_META).encode()}
        )
        res = client.get(f"/api/session/{sid}/map/meta")
        assert res.status_code == 200
        assert res.json() == _MAP_META


def test_session_map_meta_no_robot_is_404(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        res = client.get(f"/api/session/{sid}/map/meta")
        assert res.status_code == 404


def test_session_arsenal_unbound(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        client.app.state.s3 = _FakeS3({})
        body = client.get(f"/api/session/{sid}/arsenal").json()
        assert body["knowledge"]["available"] is True   # cfg has a kb_id
        assert body["maps"]["available"] is False        # no bound robot -> no map
        assert body["human_handoff"]["available"] is True
        assert body["robot"] == {
            "bound": False, "robot_id": None, "dry_run": None, "motion_enabled": None
        }
        # unbound is dry-run by construction (can never move a robot)
        assert body["safety"]["dry_run"] is True


def test_session_arsenal_bound(monkeypatch, ddb):
    _fake_bedrock(monkeypatch)
    with _fake_client(monkeypatch) as client:
        sid = client.post(
            "/api/session", json={"name": "Ada", "comfortable": True}
        ).json()["session_id"]
        _bind(sid)
        client.app.state.s3 = _FakeS3({(MAPS_BUCKET, map_key("turtlebot468")): _MAP_PNG})
        body = client.get(f"/api/session/{sid}/arsenal").json()
        assert body["knowledge"]["available"] is True
        assert body["maps"]["available"] is True         # bound robot + map in S3
        assert body["human_handoff"]["available"] is True
        # FakeRobotRegistry reports the motion-locked / dry-run gate
        assert body["robot"]["bound"] is True
        assert body["robot"]["robot_id"] == "turtlebot468"
        assert body["robot"]["motion_enabled"] is False
        assert body["robot"]["dry_run"] is True
        assert body["safety"]["dry_run"] is True
