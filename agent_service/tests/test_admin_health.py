import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin
from guidemate_agent.observability import Observability
from guidemate_msgs.messages import Ack


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
