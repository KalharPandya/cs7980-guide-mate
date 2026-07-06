"""Admin Maps tab: GET /api/admin/map/{robot_id} (+ /meta.json) stream the
latest map PNG/metadata from S3 through the app's own boto3 client
(app.state.s3, created in app.py's lifespan) -- no presigned/public URL,
since the maps bucket blocks public access.

Follows the same isolated-router-app + pre-signed-cookie pattern as
test_admin.py's `_make_app`/`_auth_header` (a Secure cookie set via
`response.set_cookie` is not resent by httpx over http, so tests inject the
signed cookie directly via a raw `Cookie` header).
"""
import json as _json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_agent import admin
from guidemate_agent.maps import MAPS_BUCKET, map_key, meta_key


class FakeBody:
    def __init__(self, data: bytes):
        self._data = data

    def read(self):
        return self._data


class FakeS3:
    """Minimal boto3-s3 stand-in: returns preset objects or raises for missing keys."""

    def __init__(self, objects):
        self._objects = objects  # {(bucket, key): bytes}

    def get_object(self, Bucket, Key):  # noqa: N803 -- mirrors the boto3 signature
        try:
            data = self._objects[(Bucket, Key)]
        except KeyError:
            raise KeyError(Key)
        return {"Body": FakeBody(data)}


_PNG_BYTES = b"\x89PNG\r\n\x1a\nFAKEPNGBYTES"
_META = {"captured_ts": "2026-07-05T18:00:00+00:00", "source": "/home/ubuntu/maps/map.pgm"}


def _make_app(monkeypatch, password="secret", with_map=True):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", password)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    objects = {}
    if with_map:
        objects[(MAPS_BUCKET, map_key("turtlebot468"))] = _PNG_BYTES
        objects[(MAPS_BUCKET, meta_key("turtlebot468"))] = _json.dumps(_META).encode()
    app.state.s3 = FakeS3(objects)
    return app


def _auth_header(password="secret"):
    value = TimestampSigner(password).sign(admin.TOKEN).decode()
    return {"Cookie": f"{admin.COOKIE_NAME}={value}"}


def test_get_map_streams_png(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        res = client.get("/api/admin/map/turtlebot468", headers=_auth_header())
        assert res.status_code == 200
        assert res.headers["content-type"] == "image/png"
        assert res.content == _PNG_BYTES
        assert res.content.startswith(b"\x89PNG")


def test_get_map_meta(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        res = client.get("/api/admin/map/turtlebot468/meta.json", headers=_auth_header())
        assert res.status_code == 200
        assert res.json() == _META
        assert res.json()["source"].endswith("map.pgm")


def test_get_map_missing_is_404(monkeypatch):
    app = _make_app(monkeypatch, with_map=False)
    with TestClient(app) as client:
        res = client.get("/api/admin/map/turtlebotsim", headers=_auth_header())
        assert res.status_code == 404


def test_get_map_meta_missing_is_404(monkeypatch):
    app = _make_app(monkeypatch, with_map=False)
    with TestClient(app) as client:
        res = client.get("/api/admin/map/turtlebotsim/meta.json", headers=_auth_header())
        assert res.status_code == 404


def test_get_map_requires_admin(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        # No auth cookie at all.
        res = client.get("/api/admin/map/turtlebot468")
        assert res.status_code in (401, 403)


def test_get_map_rejects_bad_cookie(monkeypatch):
    app = _make_app(monkeypatch)
    with TestClient(app) as client:
        res = client.get(
            "/api/admin/map/turtlebot468",
            headers={"Cookie": f"{admin.COOKIE_NAME}=tampered.value"},
        )
        assert res.status_code == 401


def test_get_map_503_when_admin_unconfigured(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ADMIN_PASSWORD", raising=False)
    admin._failures.clear()
    app = FastAPI()
    app.include_router(admin.router)
    app.state.s3 = FakeS3({})
    with TestClient(app) as client:
        res = client.get("/api/admin/map/turtlebot468")
        assert res.status_code == 503
