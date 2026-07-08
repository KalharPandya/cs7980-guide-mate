"""Order-independent emote-sync gate.

AWS IoT QoS1 does NOT preserve publish order — the received/running/done acks for
one command arrive in any order (verified: received -> done -> running). So the gate
that decides "may I release the reply text + audio now?" must be order-independent:
it releases as soon as ANY ack reports running or done. If neither shows up within the
timeout, the caller releases anyway (the 2.0 s fallback) so voice never hangs.
"""
from __future__ import annotations

from typing import Optional

from guidemate_msgs.messages import Ack, Command

GATE_STATES = ("running", "done")


def gate_released(acks: list[Ack]) -> bool:
    """True iff any ack reports the emote has started (running) or finished (done)."""
    return any(a.state in GATE_STATES for a in acks)


def emote_sync(
    registry,
    robot_id: Optional[str],
    cmd: Command,
    timeout_s: float = 2.0,
) -> tuple[bool, list[Ack]]:
    """Publish an emote and gate on the order-independent release predicate.

    robot_id is None  -> virtual session: no physical publish; released immediately.
    robot_id is set   -> physical session: publish via the registry and wait up to
                          timeout_s for a running/done ack (in any order).

    Returns (released, acks). released=False means the timeout fell through with no
    confirming ack — the caller still sends the reply (the 2.0 s fallback).
    """
    if robot_id is None:
        return True, []
    acks = registry.send_command(robot_id, cmd, timeout_s=timeout_s)
    return gate_released(acks), acks
