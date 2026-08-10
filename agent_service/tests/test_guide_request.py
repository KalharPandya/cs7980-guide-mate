"""Tests for the operator-approved VIRTUAL guide flow:

- sessions.create_request(kind="guide", ...) stores the guide fields.
- sessions.approve_guide_request fires the named fleet assign, records the
  assigned robot on the session, and marks the request approved.
- dog_agent's guide_to_room tool now CREATES a pending guide request instead of
  dispatching a robot directly (the assign moved to approval time).
- admin route POST /api/admin/requests/{id}/approve-guide triggers approval.

Reuses the existing moto `ddb` fixture (tests/conftest.py) and the pre-signed
raw Cookie admin-auth pattern from tests/test_admin_assign.py (httpx will not
resend a Secure cookie over http, so the signed cookie is injected directly).
"""
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from guidemate_msgs.messages import Ack

from guidemate_agent import admin, sessions
from guidemate_agent.dog_agent import DogAgent


# ---- helpers ------------------------------------------------------------
class _FleetReg:
    """Registry stand-in: records fleet commands, returns a scripted ack list."""

    def __init__(self, acks=None):
        self._acks = acks if acks is not None else []
        self.fleet_sent = []

    def send_fleet_command(self, cmd, timeout_s=5.0, collect_all=False):
        self.fleet_sent.append(cmd)
        return list(self._acks)

    # guide_to_room never targets a robot; defined for completeness.
    def send_command(self, robot_id, cmd, timeout_s=5.0, collect_all=False):
        return []


def _agent(registry):
    return DogAgent(
        registry=registry,
        model_id="us.anthropic.claude-sonnet-4-6",
        robot_ids=["turtlebot468"],
    )


def _captured():
    return {"emote": None, "acks": []}


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
    assert resp.status_code == 200
    client.headers.update(_auth_header(password))
    return appmod, client


# ---- create_request(kind="guide") --------------------------------------
def test_create_request_guide_stores_kind_and_rooms(ddb):
    sid = sessions.create_session("Ada", True)

    rid = sessions.create_request(
        sid, kind="guide", from_room="Classroom 1425", to_room="Kitchen"
    )

    req = sessions.get_request(rid)
    assert req["kind"] == "guide"
    assert req["from_room"] == "Classroom 1425"
    assert req["to_room"] == "Kitchen"
    assert req["status"] == "pending"
    assert sessions.get_session(sid)["request_status"] == "pending"


def test_create_request_guide_clears_stale_guide_fields(ddb):
    """A new guide request must wipe the guide_robot_id/from_room/to_room left
    on the session by a PRIOR, already-approved guide, so get_guide_status returns
    all-None until the new request is approved. Otherwise the stale from_room leaks
    into Moses's awareness line and it stops asking where the visitor is."""
    sid = sessions.create_session("Ada", True)
    # Simulate a previously approved guide having stamped these fields.
    sessions._update_session(
        sid,
        guide_robot_id="virtual/7",
        guide_from_room="Wellness Room",
        guide_to_room="Kitchen",
    )
    assert sessions.get_guide_status(sid)["guide_from_room"] == "Wellness Room"

    sessions.create_request(sid, kind="guide", to_room="Library")

    assert sessions.get_guide_status(sid) == {
        "guide_robot_id": None, "guide_from_room": None, "guide_to_room": None,
    }


def test_create_request_companion_does_not_clear_guide_fields(ddb):
    """A companion request must NOT touch the virtual-fleet guide fields."""
    sid = sessions.create_session("Ada", True)
    sessions._update_session(
        sid,
        guide_robot_id="virtual/7",
        guide_from_room="Wellness Room",
        guide_to_room="Kitchen",
    )

    sessions.create_request(sid, kind="companion")

    assert sessions.get_guide_status(sid) == {
        "guide_robot_id": "virtual/7",
        "guide_from_room": "Wellness Room",
        "guide_to_room": "Kitchen",
    }


def test_create_request_companion_default_kind_and_no_rooms(ddb):
    """The existing companion callers keep their exact shape: kind defaults to
    'companion' and no from_room/to_room attributes are added."""
    sid = sessions.create_session("Bob", False)

    rid = sessions.create_request(sid)

    req = sessions.get_request(rid)
    assert req["kind"] == "companion"
    assert "from_room" not in req
    assert "to_room" not in req


# ---- approve_guide_request ---------------------------------------------
def test_approve_guide_request_dispatches_and_records(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(
        sid, kind="guide", from_room="Classroom 1425", to_room="Kitchen"
    )
    acks = [
        Ack(cmd_id="c", state="received", simulated=True),
        Ack(cmd_id="c", state="done", simulated=True, assigned_robot_id="virtual/3"),
    ]
    reg = _FleetReg(acks=acks)

    out = sessions.approve_guide_request(rid, registry=reg)

    # The named assign was published to the fleet.
    assert len(reg.fleet_sent) == 1
    cmd = reg.fleet_sent[0]
    assert cmd.type == "assign" and cmd.name == "assign"
    assert cmd.params["visitor_id"]
    assert cmd.params["room"] == "Kitchen"
    assert cmd.params["from_room"] == "Classroom 1425"
    assert cmd.params["name"] == "Ada"

    # The visitor was minted + bound.
    assert sessions.visitor_for_session(sid) == cmd.params["visitor_id"]

    # The request is approved and the robot recorded on the session.
    assert sessions.get_request(rid)["status"] == "approved"
    session = sessions.get_session(sid)
    assert session["request_status"] == "approved"
    assert session["guide_robot_id"] == "virtual/3"
    assert session["guide_from_room"] == "Classroom 1425"
    assert session["guide_to_room"] == "Kitchen"

    # Return dict + get_guide_status agree.
    assert out["session_id"] == sid
    assert out["assigned_robot_id"] == "virtual/3"
    status = sessions.get_guide_status(sid)
    assert status == {
        "guide_robot_id": "virtual/3",
        "guide_from_room": "Classroom 1425",
        "guide_to_room": "Kitchen",
    }


def test_approve_guide_request_reuses_existing_visitor(ddb):
    sid = sessions.create_session("Ada", True)
    sessions.bind_visitor(sid, "visitor-existing")
    rid = sessions.create_request(sid, kind="guide", to_room="Kitchen")
    reg = _FleetReg(acks=[Ack(cmd_id="c", state="done", simulated=True,
                              assigned_robot_id="virtual/1")])

    sessions.approve_guide_request(rid, registry=reg)

    assert reg.fleet_sent[0].params["visitor_id"] == "visitor-existing"
    # from_room omitted when the request had none.
    assert "from_room" not in reg.fleet_sent[0].params


def test_approve_guide_request_no_registry_no_publish(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid, kind="guide", to_room="Kitchen")

    out = sessions.approve_guide_request(rid)  # registry=None -> best-effort no-op

    assert out["assigned_robot_id"] is None
    assert out["acks"] == []
    assert sessions.get_request(rid)["status"] == "approved"


def test_approve_guide_request_unknown_id_raises(ddb):
    import pytest
    with pytest.raises(KeyError):
        sessions.approve_guide_request("nope")


def test_get_guide_status_empty_by_default(ddb):
    sid = sessions.create_session("Ada", True)
    assert sessions.get_guide_status(sid) == {
        "guide_robot_id": None, "guide_from_room": None, "guide_to_room": None,
    }


# ---- dog_agent guide tool now creates a request (no direct publish) ------
def test_guide_tool_creates_request_instead_of_dispatching(ddb):
    sid = sessions.create_session("Ada", True)
    reg = _FleetReg(acks=[Ack(cmd_id="c", state="done", simulated=True,
                              assigned_robot_id="virtual/9")])

    result = _agent(reg)._guide_impl("Kitchen", sid, _captured(), "Classroom 1425")

    # No robot dispatched at tool-call time -- that moved to approval.
    assert reg.fleet_sent == []
    # A pending guide request now exists carrying origin + destination.
    pending = sessions.list_pending_requests()
    assert len(pending) == 1
    assert pending[0]["session_id"] == sid
    assert pending[0]["kind"] == "guide"
    assert pending[0]["from_room"] == "Classroom 1425"
    assert pending[0]["to_room"] == "Kitchen"
    # The visitor is told the operator will send a guide, not "robot on its way".
    assert "front desk" in result.lower()


# ---- admin route --------------------------------------------------------
def test_route_approve_guide_returns_200_and_approves(monkeypatch, ddb):
    appmod, client = _admin_client(monkeypatch)
    with client:
        sid = sessions.create_session("Ada", True)
        rid = sessions.create_request(
            sid, kind="guide", from_room="Classroom 1425", to_room="Kitchen"
        )

        resp = client.post(f"/api/admin/requests/{rid}/approve-guide")

        assert resp.status_code == 200
        out = resp.json()
        assert out["session_id"] == sid
        # The app runs on FakeRobotRegistry (GUIDEMATE_FAKE_ROBOT=1), which acks a
        # simulated assign with a virtual robot id -> recorded on the session.
        assert out["assigned_robot_id"]
        assert sessions.get_request(rid)["status"] == "approved"
        assert sessions.get_session(sid)["guide_robot_id"] == out["assigned_robot_id"]


def test_route_approve_guide_requires_auth(monkeypatch, ddb):
    monkeypatch.setenv("GUIDEMATE_FAKE_ROBOT", "1")
    monkeypatch.setenv("GUIDEMATE_ADMIN_PASSWORD", "letmein")
    admin._failures.clear()
    import guidemate_agent.app as appmod
    with TestClient(appmod.app) as client:
        assert client.post(
            "/api/admin/requests/x/approve-guide"
        ).status_code == 401
