import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin
from guidemate_agent.observability import Observability
from guidemate_msgs.messages import Ack

_HEALTH_JS = (
    Path(__file__).resolve().parent.parent / "static" / "admin" / "health.js"
)


class FakeRegistry:
    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "online", "battery": 0.9}


def _make_app(monkeypatch, password="secret", robot_ids=("turtlebot468",)):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", password)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    app.state.registry = FakeRegistry()
    app.state.config = SimpleNamespace(robot_ids=list(robot_ids))
    app.state.observability = Observability()
    return app


def _auth_header(password="secret"):
    value = TimestampSigner(password).sign(admin.TOKEN).decode()
    return {"Cookie": f"{admin.COOKIE_NAME}={value}"}


def test_health_requires_admin_cookie(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.get("/api/admin/health")
        assert resp.status_code == 401


def test_health_tampered_cookie_401(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.get(
            "/api/admin/health", headers={"Cookie": f"{admin.COOKIE_NAME}=garbage"}
        )
        assert resp.status_code == 401


def test_health_503_when_admin_not_configured(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ADMIN_PASSWORD", raising=False)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    app.state.registry = FakeRegistry()
    app.state.config = SimpleNamespace(robot_ids=["turtlebot468"])
    app.state.observability = Observability()
    with TestClient(app) as client:
        resp = client.get("/api/admin/health")
        assert resp.status_code == 503


def test_health_returns_rings_and_robots(monkeypatch):
    app = _make_app(monkeypatch, robot_ids=("turtlebot468", "turtlebot436"))
    with TestClient(app) as client:
        obs: Observability = app.state.observability
        obs.record_command(
            "t1", "turtlebot468", "c1", time.monotonic(),
            [Ack(cmd_id="c1", state="done", simulated=True)],
        )
        obs.record_latency("t1", 700.0, "sess-1")
        obs.record_error("chat", "boom", "t1")

        resp = client.get("/api/admin/health", headers=_auth_header())
        assert resp.status_code == 200
        body = resp.json()

        assert body["commands"][0]["robot_id"] == "turtlebot468"
        assert body["commands"][0]["cmd_id"] == "c1"
        assert body["latencies"][0]["bedrock_ms"] == 700.0
        assert body["errors"][0]["where"] == "chat"
        assert isinstance(body["robots"], list)
        robot_ids = [r["robot_id"] for r in body["robots"]]
        assert robot_ids == ["turtlebot468", "turtlebot436"]
        assert body["robots"][0]["presence"] == "online"


# --- XSS regression guard -------------------------------------------------
# errors[].message is str(exc) and can echo the UNAUTHENTICATED /ws/chat user's
# raw input; robot gates come from a spoofable MQTT heartbeat. health.js renders
# them into innerHTML, so every untrusted field MUST pass through esc() before
# interpolation. Assert-at-source (grepping the JS) rather than at-render because
# there is no JS runtime in the pytest env; this fails loudly if a future edit
# reintroduces a raw `${untrusted}` in an innerHTML string.
def test_health_js_escapes_untrusted_fields():
    src = _HEALTH_JS.read_text(encoding="utf-8")
    assert "function esc(" in src, "esc() helper must exist"
    # The highest-risk field (error message) must be esc()-wrapped, never raw.
    assert "esc(e.message)" in src
    assert "${e.message}" not in src
    assert "${e.where}" not in src
    # Robot/command identifiers and gates text likewise go through esc().
    assert "esc(r.robot_id)" in src
    assert "${r.robot_id}" not in src
    assert "esc(gatesTextHealth(r.gates))" in src
    assert "${gatesTextHealth(" not in src


def test_health_js_stops_polling_on_tab_away():
    # The 3s interval must be clearable so it only runs while the tab is visible.
    src = _HEALTH_JS.read_text(encoding="utf-8")
    assert "stopHealthPolling" in src
    assert "clearInterval" in src
