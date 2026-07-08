"""Tests for the assignment→movement→disassignment dock lifecycle sequences.

Assign = undock then a forward nudge ONLY if the undock reached a `done` terminal
ack; end = dock. Tested against a recording fake `send`.
"""
from __future__ import annotations

from guidemate_msgs.messages import Ack, Command

from guidemate_agent.robot_lifecycle import assign_actions, end_actions


def _acks(*states, reason=None):
    return [
        Ack(cmd_id="c", state=s, simulated=True,
            reason=reason if s == "failed" else None)
        for s in states
    ]


class _Recorder:
    """Captures (robot_id, type, name) per send and returns a scripted ack list."""

    def __init__(self, script):
        self.sent = []
        self.cmds = []
        self._script = script  # dict: name -> ack list

    def __call__(self, robot_id, cmd: Command, timeout_s):
        self.sent.append((robot_id, cmd.type, cmd.name, timeout_s))
        self.cmds.append(cmd)
        return self._script.get(cmd.name, _acks("received", "running", "done"))


# ---- assign sequence ---------------------------------------------------------
def test_assign_undocks_then_nudges_forward_when_undock_succeeds():
    send = _Recorder({"undock": _acks("received", "running", "done")})
    results = assign_actions(send, "turtlebot468", timeout_s=75.0)
    assert [r[0] for r in results] == ["undock", "forward"]
    names = [(t, n) for (_r, t, n, _to) in send.sent]
    assert names == [("motion", "undock"), ("motion", "forward")]


def test_assign_skips_nudge_when_undock_refused():
    send = _Recorder({"undock": _acks("received", "failed", reason="motion_disabled")})
    results = assign_actions(send, "turtlebot468", timeout_s=75.0)
    assert [r[0] for r in results] == ["undock"]          # no forward recorded
    assert [(t, n) for (_r, t, n, _to) in send.sent] == [("motion", "undock")]


def test_assign_skips_nudge_when_undock_times_out_no_terminal_ack():
    send = _Recorder({"undock": _acks("received", "running")})  # never done
    results = assign_actions(send, "turtlebot468", timeout_s=75.0)
    assert [r[0] for r in results] == ["undock"]


def test_assign_nudge_is_bounded_forward_twist():
    send = _Recorder({"undock": _acks("received", "running", "done")})
    assign_actions(send, "turtlebot468", timeout_s=75.0)
    # The forward nudge carries bounded params (speed/duration), never navigation.
    forward = [c for c in send.cmds if c.name == "forward"]
    assert len(forward) == 1
    assert forward[0].params["speed"] > 0.0
    assert forward[0].params["duration"] > 0.0


def test_assign_uses_long_ack_window():
    send = _Recorder({})
    assign_actions(send, "turtlebot468", timeout_s=75.0)
    assert all(call[3] == 75.0 for call in send.sent)


# ---- end sequence ------------------------------------------------------------
def test_end_sends_dock():
    send = _Recorder({})
    results = end_actions(send, "turtlebot468", timeout_s=75.0)
    assert [r[0] for r in results] == ["dock"]
    assert [(t, n) for (_r, t, n, _to) in send.sent] == [("motion", "dock")]
