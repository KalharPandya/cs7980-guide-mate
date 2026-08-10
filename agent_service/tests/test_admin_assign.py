"""Tests for the explicit VIRTUAL-mode assignment: sessions.assign_virtual and
the admin route POST /api/admin/session/{id}/assign-virtual.

Reuses the existing session/admin test setup: the `ddb` moto fixture
(tests/conftest.py) for DynamoDB, and the pre-signed raw Cookie header for admin
auth (the same _auth_header pattern tests/test_admin.py uses -- httpx will not
resend a Secure cookie over http, so the signed cookie is injected directly).
"""
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin, sessions


def _auth_header(password="letmein"):
    value = TimestampSigner(password).sign(admin.TOKEN).decode()
    return {"Cookie": f"{admin.COOKIE_NAME}={value}"}


def _admin_client(monkeypatch, password="letmein"):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", password)
    admin._failures.clear()
    import guidemate_agent.app as appmod
    client = TestClient(appmod.app)
    resp = client.post("/api/admin/login", json={"password": password})
    assert resp.status_code == 200, "align with Phase 3's /api/admin/login route"
    client.headers.update(_auth_header(password))
    return appmod, client


# ---- sessions.assign_virtual unit tests ---------------------------------
def test_assign_virtual_releases_held_physical_robot(ddb):
    sid = sessions.create_session("Ada", True)
    # Give the session a physical robot (acquires the per-robot lock).
    sessions.approve_request(sessions.create_request(sid), "turtlebot468")
    assert sessions.get_lock_holder("turtlebot468") == sid
    assert sessions.robot_for_session(sid) == "turtlebot468"

    freed = sessions.assign_virtual(sid)

    assert freed == "turtlebot468"
    assert sessions.get_lock_holder("turtlebot468") is None
    assert sessions.robot_for_session(sid) is None
    # Mode switch, not an end/abort: the session is still active.
    assert sessions.get_session(sid)["status"] == "active"


def test_assign_virtual_noop_when_no_robot_held(ddb):
    sid = sessions.create_session("Ada", True)
    assert sessions.robot_for_session(sid) is None

    freed = sessions.assign_virtual(sid)  # must not raise

    assert freed is None
    assert sessions.robot_for_session(sid) is None


# ---- admin route tests --------------------------------------------------
def test_route_assign_virtual_frees_robot(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch)
    with client:
        sid = sessions.create_session("Ada", True)
        sessions.approve_request(sessions.create_request(sid), "turtlebot468")
        assert sessions.get_lock_holder("turtlebot468") == sid

        out = client.post(f"/api/admin/session/{sid}/assign-virtual").json()

        assert out["session_id"] == sid
        assert out["freed_robot_id"] == "turtlebot468"
        assert sessions.get_lock_holder("turtlebot468") is None
        assert sessions.robot_for_session(sid) is None


def test_route_assign_virtual_calls_into_sessions(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch)
    captured = {}

    def _fake_assign_virtual(session_id, registry=None):
        captured["session_id"] = session_id
        captured["registry"] = registry
        return "turtlebot468"

    monkeypatch.setattr(sessions, "assign_virtual", _fake_assign_virtual)
    with client:
        out = client.post("/api/admin/session/sess-123/assign-virtual").json()

        assert out == {"session_id": "sess-123", "freed_robot_id": "turtlebot468"}
        assert captured["session_id"] == "sess-123"
        # The route threads the app's registry through, like reassign/abort do.
        assert captured["registry"] is client.app.state.registry


def test_route_assign_virtual_requires_auth(monkeypatch, ddb):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "letmein")
    admin._failures.clear()
    import guidemate_agent.app as appmod
    with TestClient(appmod.app) as client:
        # No cookie -> gated by admin_required.
        assert client.post("/api/admin/session/x/assign-virtual").status_code == 401
