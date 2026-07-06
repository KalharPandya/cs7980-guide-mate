"""Gated end-to-end: a synthetic low-battery event records a real turn in DynamoDB.

Requires GUIDEMATE_INTEGRATION=1 (real DynamoDB) and live Bedrock creds (the agent turn
calls the model). Run:
    GUIDEMATE_INTEGRATION=1 GUIDEMATE_LIVE=1 .venv/bin/python -m pytest \
      agent_service/tests/integration/test_autonomy_roundtrip.py -q -s

Adaptation note: the brief's draft asserted via `app.state.store.list_messages(...)`.
Merged reality (Phase 3/4) keeps session/message rows in the `sessions` module
(DynamoDB guidemate-messages table via sessions.get_messages), not on ConfigStore
(app.state.store, which only holds flags/prompt in guidemate-config) — this test's
final assertion is adapted to sessions.get_messages accordingly, per the brief's own
note that this is expected to need adapting.
"""
import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("GUIDEMATE_INTEGRATION") != "1",
    reason="requires GUIDEMATE_INTEGRATION=1 (real DynamoDB + live Bedrock creds)",
)


@pytest.mark.integration
def test_synthetic_event_records_message_in_dynamodb(monkeypatch):
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "test-admin-pw")
    # Isolate this run's system session so the assertion is unambiguous.
    session_id = f"system-autonomy-itest-{uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("GUIDEMATE_AUTONOMY_SESSION_ID", session_id)

    from fastapi.testclient import TestClient

    from guidemate_agent import sessions
    from guidemate_agent.app import app

    with TestClient(app) as client:
        login = client.post("/api/admin/login", json={"password": "test-admin-pw"})
        assert login.status_code == 200, login.text
        # The auth cookie is set Secure; TestClient uses http://testserver, so httpx
        # will not auto-resend it. Re-set it (without the Secure attr) so the signed
        # session carries — the token itself is unchanged, this only bridges the
        # http test transport. (In prod the cookie rides HTTPS normally.)
        client.cookies.set("guidemate_admin", login.cookies["guidemate_admin"])
        res = client.post(
            "/api/admin/synthetic-event", json={"type": "low_battery", "battery": 0.11}
        )
        assert res.status_code == 200
        assert res.json()["fired"] == "low_battery"

        messages = sessions.get_messages(app.state.engine.session_id)
        assert messages, "expected the autonomy turn to be persisted to guidemate-messages"
