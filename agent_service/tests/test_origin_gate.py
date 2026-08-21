"""Tests for the L0a network-origin gate (guidemate_agent.origin_gate).

The gate is exercised on a purpose-built mini app (same pattern as
test_admin_health.py) so the tests need no registry/boto3 state. Client IPs are
delivered via X-Forwarded-For exactly as Caddy delivers them in production —
the gate must only ever trust the LAST entry (the one the proxy appended).
"""
import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from guidemate_agent.origin_gate import OriginGate

CAMPUS = "208.98.212.98"  # inside the default 208.98.212.96/29 (the measured egress)
INTERNET = "203.0.113.9"  # TEST-NET-3, never allowlisted


def _make_app(**gate_kwargs) -> FastAPI:
    app = FastAPI()

    @app.get("/api/ping")
    def ping() -> dict:
        return {"ok": True}

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.get("/api/admin/ping")
    def admin_ping() -> dict:
        return {"ok": True}

    @app.websocket("/ws/echo")
    async def ws_echo(ws: WebSocket) -> None:
        await ws.accept()
        await ws.send_text("hi")
        await ws.close()

    app.add_middleware(OriginGate, **gate_kwargs)
    return app


def _xff(ip: str) -> dict:
    return {"X-Forwarded-For": ip}


# --- default: off ------------------------------------------------------------


def test_default_mode_is_off_and_passes_everything(monkeypatch):
    monkeypatch.delenv("GUIDEMATE_ORIGIN_MODE", raising=False)
    client = TestClient(_make_app())
    assert client.get("/api/ping", headers=_xff(INTERNET)).status_code == 200
    assert client.get("/api/ping").status_code == 200  # no XFF at all


# --- enforce -----------------------------------------------------------------


def test_enforce_allows_campus_ip():
    client = TestClient(_make_app(mode="enforce"))
    assert client.get("/api/ping", headers=_xff(CAMPUS)).status_code == 200


def test_enforce_blocks_internet_ip_with_403_json():
    client = TestClient(_make_app(mode="enforce"))
    r = client.get("/api/ping", headers=_xff(INTERNET))
    assert r.status_code == 403
    assert r.json()["error"] == "NOT_ON_CAMPUS"


def test_enforce_blocks_when_no_client_ip_at_all():
    # TestClient's ASGI peer is the non-IP string "testclient": unattributable
    # requests must not pass an allowlist.
    client = TestClient(_make_app(mode="enforce"))
    assert client.get("/api/ping").status_code == 403


def test_spoofed_first_xff_entry_is_ignored():
    # Attacker sends "X-Forwarded-For: <campus>"; Caddy appends the real peer.
    # Only the LAST entry may be trusted -> blocked.
    client = TestClient(_make_app(mode="enforce"))
    r = client.get("/api/ping", headers=_xff(f"{CAMPUS}, {INTERNET}"))
    assert r.status_code == 403


def test_trusted_last_xff_entry_wins():
    r = TestClient(_make_app(mode="enforce")).get(
        "/api/ping", headers=_xff(f"{INTERNET}, {CAMPUS}")
    )
    assert r.status_code == 200


def test_malformed_xff_is_blocked():
    client = TestClient(_make_app(mode="enforce"))
    assert client.get("/api/ping", headers=_xff("not-an-ip")).status_code == 403


# --- exemptions --------------------------------------------------------------


def test_probes_and_admin_are_exempt_by_default():
    client = TestClient(_make_app(mode="enforce"))
    assert client.get("/healthz", headers=_xff(INTERNET)).status_code == 200
    assert client.get("/api/admin/ping", headers=_xff(INTERNET)).status_code == 200


# --- log mode ----------------------------------------------------------------


def test_log_mode_never_blocks(caplog):
    client = TestClient(_make_app(mode="log"))
    with caplog.at_level("WARNING", logger="guidemate_agent.origin_gate"):
        r = client.get("/api/ping", headers=_xff(INTERNET))
    assert r.status_code == 200
    assert any("would block" in rec.message for rec in caplog.records)


# --- configuration -----------------------------------------------------------


def test_custom_allowlist_and_invalid_cidr_skipped():
    app = _make_app(mode="enforce", allowlist="banana, 10.0.0.0/8")
    client = TestClient(app)
    assert client.get("/api/ping", headers=_xff("10.1.2.3")).status_code == 200
    assert client.get("/api/ping", headers=_xff(CAMPUS)).status_code == 403


def test_enforce_with_empty_allowlist_fails_closed():
    client = TestClient(_make_app(mode="enforce", allowlist=""))
    assert client.get("/api/ping", headers=_xff(CAMPUS)).status_code == 403
    # exemptions still work — probes stay reachable even in the failure mode
    assert client.get("/healthz", headers=_xff(CAMPUS)).status_code == 200


def test_env_config_used_when_no_kwargs(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ORIGIN_MODE", "enforce")
    monkeypatch.setenv("GUIDEMATE_ORIGIN_ALLOWLIST", "192.0.2.0/24")
    client = TestClient(_make_app())
    assert client.get("/api/ping", headers=_xff("192.0.2.7")).status_code == 200
    assert client.get("/api/ping", headers=_xff(CAMPUS)).status_code == 403


# --- websocket ---------------------------------------------------------------


def test_websocket_allowed_from_campus():
    client = TestClient(_make_app(mode="enforce"))
    with client.websocket_connect("/ws/echo", headers=_xff(CAMPUS)) as ws:
        assert ws.receive_text() == "hi"


def test_websocket_blocked_from_internet():
    client = TestClient(_make_app(mode="enforce"))
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/echo", headers=_xff(INTERNET)):
            pass
