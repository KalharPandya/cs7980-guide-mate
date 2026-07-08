from guidemate_msgs.messages import Ack

from guidemate_agent import sessions


class RecordingRegistry:
    """Registry stand-in that records every command and refuses them all
    (matching robot 468's motion-locked reality for dock/undock)."""

    def __init__(self):
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0):
        self.sent.append((robot_id, cmd.type, cmd.name))
        return [
            Ack(cmd_id=cmd.cmd_id, state="received"),
            Ack(cmd_id=cmd.cmd_id, state="failed", reason="motion_disabled (docked)"),
        ]


def test_approve_binds_session_and_lock(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    out = sessions.approve_request(rid, "turtlebot468")
    assert out["session_id"] == sid
    assert out["aborted_session_id"] is None
    assert sessions.get_lock_holder("turtlebot468") == sid
    assert sessions.robot_for_session(sid) == "turtlebot468"
    assert sessions.get_request(rid)["status"] == "approved"
    state = sessions.get_session_state(sid)
    assert state == {"request_status": "approved", "robot_id": "turtlebot468"}


def test_approve_second_request_aborts_first(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    ra = sessions.create_request(a)
    rb = sessions.create_request(b)
    sessions.approve_request(ra, "turtlebot468")
    out = sessions.approve_request(rb, "turtlebot468")
    assert out["aborted_session_id"] == a
    assert sessions.get_lock_holder("turtlebot468") == b
    assert sessions.get_session_state(a) == {"request_status": "aborted", "robot_id": None}
    assert sessions.robot_for_session(b) == "turtlebot468"


def test_deny_request(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    sessions.deny_request(rid)
    assert sessions.get_request(rid)["status"] == "denied"
    assert sessions.get_session_state(sid) == {"request_status": "denied", "robot_id": None}


def test_abort_robot_frees_lock(ddb):
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    sessions.approve_request(rid, "turtlebot468")
    freed = sessions.abort_robot("turtlebot468")
    assert freed == sid
    assert sessions.get_lock_holder("turtlebot468") is None
    assert sessions.get_session_state(sid) == {"request_status": "aborted", "robot_id": None}


def test_reassign_without_prior_request(ddb):
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)  # never filed a request
    sessions.approve_request(sessions.create_request(a), "turtlebot468")
    aborted = sessions.reassign_robot("turtlebot468", b)
    assert aborted == a
    assert sessions.robot_for_session(b) == "turtlebot468"
    assert sessions.get_session_state(a) == {"request_status": "aborted", "robot_id": None}


# ------- assignment-triggered undock/dock (spec delta, commit 91d9bcb) -------
def test_approve_publishes_undock_and_records_refusal(ddb):
    reg = RecordingRegistry()
    sid = sessions.create_session("Ada", True)
    rid = sessions.create_request(sid)
    sessions.approve_request(rid, "turtlebot468", registry=reg)
    assert reg.sent == [("turtlebot468", "motion", "undock")]
    events = sessions.get_assign_events("turtlebot468")
    assert events[-1]["action"] == "undock"
    assert events[-1]["refused"] is True
    assert events[-1]["acks"][-1]["reason"] == "motion_disabled (docked)"


def test_abort_publishes_dock(ddb):
    reg = RecordingRegistry()
    sid = sessions.create_session("Ada", True)
    sessions.approve_request(sessions.create_request(sid), "turtlebot468", registry=reg)
    sessions.abort_robot("turtlebot468", registry=reg)
    assert reg.sent[-1] == ("turtlebot468", "motion", "dock")
    assert [e["action"] for e in sessions.get_assign_events("turtlebot468")] == [
        "undock", "dock"
    ]


def test_reassign_publishes_dock_then_undock(ddb):
    reg = RecordingRegistry()
    a = sessions.create_session("A", True)
    b = sessions.create_session("B", True)
    sessions.approve_request(sessions.create_request(a), "turtlebot468", registry=reg)
    reg.sent.clear()
    sessions.reassign_robot("turtlebot468", b, registry=reg)
    assert reg.sent == [
        ("turtlebot468", "motion", "dock"),      # unassign the old holder
        ("turtlebot468", "motion", "undock"),    # assign the new one
    ]


def test_no_registry_records_undelivered_event(ddb):
    # Best-effort: orchestration must work (and record) even with no registry.
    sid = sessions.create_session("Ada", True)
    sessions.approve_request(sessions.create_request(sid), "turtlebot468")
    events = sessions.get_assign_events("turtlebot468")
    assert events[-1]["action"] == "undock"
    assert events[-1]["acks"] == []
    assert events[-1]["refused"] is False
    assert sessions.robot_for_session(sid) == "turtlebot468"
