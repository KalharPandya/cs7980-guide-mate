"""Synthetic-event admin endpoint + engine wiring (no AWS, no Bedrock)."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin
from guidemate_agent.admin import router
from guidemate_agent.autonomy import EventEngine


class FakeAgent:
    def __init__(self):
        self.calls = []

    def chat(self, message=None, session_id=None, robot_id=None,
             system_event=None, allow_motion=True):
        self.calls.append({"robot_id": robot_id, "allow_motion": allow_motion})
        return {"reply_text": "woof"}


class FakeStore:
    def ensure_session(self, session_id, name):
        pass


@pytest.fixture()
def client():
    app = FastAPI()
    # NOTE (adaptation): admin.router already carries prefix="/api/admin" (Phase 3);
    # the brief's draft passed an extra prefix= here, which would double it up
    # (/api/admin/api/admin/...) and 404 every route.
    app.include_router(router)
    agent = FakeAgent()
    app.state.agent = agent
    app.state.engine = EventEngine(agent=agent, store=FakeStore(), default_robot_id="turtlebot468")
    with TestClient(app) as c:
        c.app_agent = agent  # stash for assertions
        yield c


def _auth_header(password="test-admin-pw"):
    # NOTE (adaptation): the brief's draft logged in via the client's cookie
    # jar and relied on it resending the cookie on the next request. Phase 3's
    # login cookie is Secure, and httpx's TestClient (plain http://testserver)
    # will not resend a Secure cookie — this repo's own test_admin.py hits the
    # same thing and works around it by pre-signing the cookie and injecting
    # it as a raw `Cookie` header (bypasses the jar's Secure filter). Reused
    # here rather than re-deriving it.
    value = TimestampSigner(password).sign(admin.TOKEN).decode()
    return {"Cookie": f"{admin.COOKIE_NAME}={value}"}


def _login(client, password="test-admin-pw"):
    # Still exercises the real /login route (JSON body, per Phase 3's
    # LoginBody) so the endpoint itself is proven reachable/working, even
    # though the actual authenticated calls below use _auth_header().
    resp = client.post("/api/admin/login", json={"password": password})
    assert resp.status_code == 200


def test_synthetic_low_battery_fires_rule(client, monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    _login(client)
    res = client.post(
        "/api/admin/synthetic-event",
        json={"type": "low_battery", "battery": 0.12},
        headers=_auth_header(),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["fired"] == "low_battery"
    assert body["session_id"] == "system-autonomy"
    assert client.app_agent.calls[-1]["allow_motion"] is False


def test_synthetic_offline_fires_rule(client, monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    _login(client)
    res = client.post(
        "/api/admin/synthetic-event",
        json={"type": "robot_offline"},
        headers=_auth_header(),
    )
    assert res.json()["fired"] == "robot_offline"


def test_synthetic_unknown_type_is_400(client, monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    _login(client)
    res = client.post(
        "/api/admin/synthetic-event", json={"type": "nonsense"}, headers=_auth_header()
    )
    assert res.status_code == 400


def test_synthetic_event_requires_admin(client, monkeypatch):
    # NOTE (adaptation): admin must be configured (GUIDEMATE_ADMIN_PASSWORD set)
    # or admin_required 503s before it even checks the cookie — set it so this
    # test actually exercises the "not authenticated" (401) path, not "admin
    # disabled" (503).
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    # No login -> admin_required rejects.
    res = client.post("/api/admin/synthetic-event", json={"type": "low_battery", "battery": 0.12})
    assert res.status_code in (401, 403)
