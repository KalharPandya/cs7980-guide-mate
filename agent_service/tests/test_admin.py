import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin
from guidemate_agent.store import DEFAULT_FLAGS


class FakeStore:
    def __init__(self):
        self._flags = dict(DEFAULT_FLAGS)
        self._prompt = None

    def get_flags(self):
        return dict(self._flags)

    def set_flag(self, name, value):
        if name not in DEFAULT_FLAGS:
            raise ValueError(name)
        self._flags[name] = bool(value)

    def get_prompt(self):
        return self._prompt

    def set_prompt(self, value):
        self._prompt = value if (value and value.strip()) else None


class FakeRegistry:
    def get_status(self, robot_id):
        return {"robot_id": robot_id, "presence": "online", "battery": 0.9}


class FakeKB:
    """Mirrors the post-merge KBManager return shapes:
    upload/delete -> {"ok": bool, "error"?: str}
    start_ingestion -> {"ok": bool, "job_id"?: str, "error"?: str}
    latest_job_status -> {"status": "...", ...}  ("NONE"/"ERROR"/"COMPLETE"/...)
    list_docs -> list (or [] on error)
    """

    def __init__(self):
        self.docs = []
        self.synced = False

    def list_docs(self):
        return self.docs

    def upload(self, key, data):
        self.docs.append({"key": key, "size": len(data), "modified": "now"})
        return {"ok": True}

    def delete(self, key):
        self.docs = [d for d in self.docs if d["key"] != key]
        return {"ok": True}

    def start_ingestion(self):
        self.synced = True
        return {"ok": True, "job_id": "job-1"}

    def latest_job_status(self):
        return (
            {"job_id": "job-1", "status": "COMPLETE"}
            if self.synced
            else {"status": "NONE"}
        )


class FakeIotData:
    """Captures the last update_thing_shadow payload."""

    last_payload = None
    last_thing = None

    def update_thing_shadow(self, thingName, payload):
        FakeIotData.last_thing = thingName
        FakeIotData.last_payload = json.loads(payload.decode("utf-8"))
        return {"payload": payload}


def _make_app(monkeypatch, password="secret"):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", password)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    app.state.store = FakeStore()
    app.state.registry = FakeRegistry()
    app.state.kb = FakeKB()
    app.state.config = SimpleNamespace(
        robot_ids=["turtlebot468"],
        thing_names={"turtlebot468": "Turtlebot-468"},
        iot_endpoint="abc123-ats.iot.us-west-2.amazonaws.com",
        region="us-west-2",
    )
    return app


def _auth_header(password="secret"):
    # Pre-sign the cookie and inject it via a raw header — httpx would not send a
    # Secure cookie over http, but a raw Cookie header bypasses the jar filter.
    value = TimestampSigner(password).sign(admin.TOKEN).decode()
    return {"Cookie": f"{admin.COOKIE_NAME}={value}"}


def test_routes_503_when_password_unset(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ADMIN_PASSWORD", raising=False)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    with TestClient(app) as client:
        assert client.post("/api/admin/login", json={"password": "x"}).status_code == 503
        assert client.get("/api/admin/flags").status_code == 503


def test_login_wrong_password_401_then_rate_limited_429(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        for _ in range(5):
            assert client.post("/api/admin/login", json={"password": "nope"}).status_code == 401
        # 6th attempt within the window is rate-limited
        assert client.post("/api/admin/login", json={"password": "nope"}).status_code == 429


def test_login_success_sets_hardened_cookie(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.post("/api/admin/login", json={"password": "secret"})
        assert resp.status_code == 200
        set_cookie = resp.headers["set-cookie"]
        assert admin.COOKIE_NAME in set_cookie
        assert "HttpOnly" in set_cookie
        assert "Secure" in set_cookie
        # Starlette lower-cases the SameSite value in the header; match case-insensitively.
        assert "samesite=strict" in set_cookie.lower()


def test_flags_require_auth(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        assert client.get("/api/admin/flags").status_code == 401


def test_bad_cookie_rejected_401(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.get(
            "/api/admin/flags",
            headers={"Cookie": f"{admin.COOKIE_NAME}=tampered.value"},
        )
        assert resp.status_code == 401


def test_get_and_put_flag(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        assert client.get("/api/admin/flags", headers=h).json()["dog_muted"] is False
        resp = client.put(
            "/api/admin/flags", json={"name": "dog_muted", "value": True}, headers=h
        )
        assert resp.status_code == 200
        assert resp.json()["dog_muted"] is True


def test_put_unknown_flag_400(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        resp = client.put(
            "/api/admin/flags", json={"name": "bogus", "value": True}, headers=_auth_header()
        )
        assert resp.status_code == 400


def test_get_and_put_prompt(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        assert client.get("/api/admin/prompt", headers=h).json()["system_prompt"] is None
        client.put("/api/admin/prompt", json={"system_prompt": "be terse"}, headers=h)
        assert client.get("/api/admin/prompt", headers=h).json()["system_prompt"] == "be terse"


def test_status_lists_robots(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        data = client.get("/api/admin/status", headers=_auth_header()).json()
        assert data["robots"][0]["robot_id"] == "turtlebot468"
        assert data["robots"][0]["presence"] == "online"


def test_kill_switch_writes_only_safe_shadow(monkeypatch):
    app = _make_app(monkeypatch)
    monkeypatch.setattr(admin.boto3, "client", lambda *a, **k: FakeIotData())
    with TestClient(app) as client:
        resp = client.post(
            "/api/admin/kill-switch", json={"robot_id": "turtlebot468"}, headers=_auth_header()
        )
        assert resp.status_code == 200
        desired = FakeIotData.last_payload["state"]["desired"]
        assert desired["dry_run"] is True
        assert desired["motion_enabled"] is False
        # SAFETY INVARIANT: the kill switch never re-enables motion.
        assert desired.get("motion_enabled") is not True
        assert desired.get("dry_run") is not False
        assert FakeIotData.last_thing == "Turtlebot-468"


def test_kill_switch_unknown_robot_400(monkeypatch):
    app = _make_app(monkeypatch)
    monkeypatch.setattr(admin.boto3, "client", lambda *a, **k: FakeIotData())
    with TestClient(app) as client:
        resp = client.post(
            "/api/admin/kill-switch", json={"robot_id": "ghost"}, headers=_auth_header()
        )
        assert resp.status_code == 400


def test_kill_switch_refuses_to_enable_motion_even_when_authed(monkeypatch):
    # SAFETY: motion_enabled:true (or dry_run:false) MUST be rejected with 400
    # regardless of auth — the kill switch is one-way-to-safe only.
    app = _make_app(monkeypatch)
    FakeIotData.last_payload = None
    FakeIotData.last_thing = None
    monkeypatch.setattr(admin.boto3, "client", lambda *a, **k: FakeIotData())
    with TestClient(app) as client:
        h = _auth_header()
        r1 = client.post(
            "/api/admin/kill-switch",
            json={"robot_id": "turtlebot468", "motion_enabled": True},
            headers=h,
        )
        assert r1.status_code == 400
        r2 = client.post(
            "/api/admin/kill-switch",
            json={"robot_id": "turtlebot468", "dry_run": False},
            headers=h,
        )
        assert r2.status_code == 400
        # Nothing was ever written to the shadow.
        assert FakeIotData.last_payload is None


def test_kb_upload_list_sync(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        assert client.get("/api/admin/kb", headers=h).json()["docs"] == []
        up = client.post(
            "/api/admin/kb",
            files={"file": ("notes.md", b"hello", "text/markdown")},
            headers=h,
        )
        assert up.status_code == 200
        assert up.json()["ok"] is True
        assert client.get("/api/admin/kb", headers=h).json()["docs"][0]["key"] == "notes.md"
        assert client.post("/api/admin/kb/sync", headers=h).json()["job_id"] == "job-1"
        assert client.get("/api/admin/kb/sync-status", headers=h).json()["status"] == "COMPLETE"


def test_kb_delete(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        client.post(
            "/api/admin/kb",
            files={"file": ("notes.md", b"hello", "text/markdown")},
            headers=h,
        )
        resp = client.delete("/api/admin/kb", params={"key": "notes.md"}, headers=h)
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
        assert client.get("/api/admin/kb", headers=h).json()["docs"] == []


def test_kb_upload_sanitizes_path_traversal_filename(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        up = client.post(
            "/api/admin/kb",
            files={"file": ("../../etc/passwd", b"pwned", "text/plain")},
            headers=h,
        )
        assert up.status_code == 200
        assert up.json()["key"] == "passwd"
        assert client.get("/api/admin/kb", headers=h).json()["docs"][0]["key"] == "passwd"


def test_safe_key_rejects_none_and_empty():
    # A multipart part with filename="" never reaches our handler as an
    # UploadFile (python-multipart treats it as a plain form field and
    # FastAPI 422s first), so exercise the None/empty guard directly.
    with pytest.raises(admin.HTTPException) as exc_info:
        admin._safe_key(None)
    assert exc_info.value.status_code == 400
    with pytest.raises(admin.HTTPException) as exc_info:
        admin._safe_key("")
    assert exc_info.value.status_code == 400


def test_kb_upload_rejects_dotdot_only_filename(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        resp = client.post(
            "/api/admin/kb",
            files={"file": ("..", b"data", "text/plain")},
            headers=h,
        )
        assert resp.status_code == 400


def test_kb_delete_normalizes_nested_key(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        client.post(
            "/api/admin/kb",
            files={"file": ("b", b"hello", "text/plain")},
            headers=h,
        )
        resp = client.delete("/api/admin/kb", params={"key": "a/../b"}, headers=h)
        assert resp.status_code == 200
        assert resp.json()["key"] == "b"
        assert client.get("/api/admin/kb", headers=h).json()["docs"] == []


def test_kb_delete_rejects_empty_after_normalization(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        h = _auth_header()
        resp = client.delete("/api/admin/kb", params={"key": "../"}, headers=h)
        assert resp.status_code == 400
