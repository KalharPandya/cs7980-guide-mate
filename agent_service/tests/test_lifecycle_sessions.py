"""Sessions-layer wiring of the dock lifecycle (assign nudge, end→dock, idle sweep)."""
from __future__ import annotations

from guidemate_msgs.messages import Ack

from guidemate_agent import sessions


class SuccessRegistry:
    """Armed-robot stand-in: every command reaches a `done` terminal ack."""

    def __init__(self):
        self.sent = []

    def send_command(self, robot_id, cmd, timeout_s=5.0):
        self.sent.append((robot_id, cmd.type, cmd.name))
        return [Ack(cmd_id=cmd.cmd_id, state=s) for s in ("received", "running", "done")]


def test_approve_undocks_then_nudges_forward_when_armed(ddb):
    reg = SuccessRegistry()
    sid = sessions.create_session("Ada", True)
    sessions.approve_request(sessions.create_request(sid), "turtlebot468", registry=reg)
    # Undock succeeded (armed) -> a forward nudge clears the dock.
    assert reg.sent == [
        ("turtlebot468", "motion", "undock"),
        ("turtlebot468", "motion", "forward"),
    ]
    actions = [e["action"] for e in sessions.get_assign_events("turtlebot468")]
    assert actions == ["undock", "forward"]


def test_approve_uses_long_ack_window(ddb):
    seen = {}
    sid = sessions.create_session("Ada", True)

    class T:
        def send_command(self, robot_id, cmd, timeout_s=5.0):
            seen[cmd.name] = timeout_s
            return [Ack(cmd_id=cmd.cmd_id, state="received")]

    sessions.approve_request(sessions.create_request(sid), "turtlebot468", registry=T())
    assert seen["undock"] >= 60.0  # dock/undock actions take 10-60 s


def test_end_session_releases_lock_and_docks(ddb):
    reg = SuccessRegistry()
    sid = sessions.create_session("Ada", True)
    sessions.approve_request(sessions.create_request(sid), "turtlebot468", registry=reg)
    reg.sent.clear()

    freed = sessions.end_session(sid, registry=reg)

    assert freed == "turtlebot468"
    assert sessions.get_lock_holder("turtlebot468") is None
    assert sessions.robot_for_session(sid) is None
    assert reg.sent == [("turtlebot468", "motion", "dock")]
    assert sessions.get_assign_events("turtlebot468")[-1]["action"] == "dock"


def test_end_session_without_robot_is_noop(ddb):
    reg = SuccessRegistry()
    sid = sessions.create_session("Ada", True)  # never assigned a robot
    assert sessions.end_session(sid, registry=reg) is None
    assert reg.sent == []


def test_touch_session_and_idle_sweep_ends_stale_holder(ddb):
    reg = SuccessRegistry()
    sid = sessions.create_session("Ada", True)
    sessions.approve_request(sessions.create_request(sid), "turtlebot468", registry=reg)
    reg.sent.clear()

    # Fresh activity -> not swept.
    sessions.touch_session(sid)
    assert sessions.sweep_idle_sessions(idle_timeout_s=600, registry=reg) == []
    assert sessions.get_lock_holder("turtlebot468") == sid

    # Force the last-active stamp far into the past -> swept + docked.
    sessions._update_session(sid, last_active_ts="2000-01-01T00:00:00+00:00")
    swept = sessions.sweep_idle_sessions(idle_timeout_s=600, registry=reg)
    assert swept == [sid]
    assert sessions.get_lock_holder("turtlebot468") is None
    assert reg.sent[-1] == ("turtlebot468", "motion", "dock")
