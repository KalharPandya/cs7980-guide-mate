"""Assignment → movement → disassignment dock lifecycle sequences.

Teleop twist + Create 3 dock actions only — NO navigation, no waypoints.

* **Assign** ("robot comes back"): `undock`, wait for its terminal ack, then — only
  if the undock reached `done` — a short bounded `forward` twist (~0.2 m) to clear
  the dock. If the undock is refused (e.g. motion-locked / dry-run) or never reaches
  a `done` terminal ack, the nudge is skipped (fail-closed: never nudge a robot still
  on its dock).
* **End** (all end paths: guest end, idle timeout, admin abort/reassign): `dock`.

These are pure sequencing helpers over an injected ``send(robot_id, cmd, timeout_s)
-> [Ack]`` so they are unit-testable without ROS/MQTT. ``sessions`` drives them with
a long ack window because the Create 3 dock/undock actions take 10–60 s (the registry
returns as soon as a terminal ack lands, so a fast completion returns fast).
"""
from __future__ import annotations

from typing import Callable, List, Tuple

from guidemate_msgs.messages import Ack, Command

# Bounded forward nudge to clear the dock after undock (matches choreography._forward
# defaults: ~0.1 m/s for 2 s ≈ 0.2 m; the bridge hard-caps both).
NUDGE_SPEED_MPS = 0.1
NUDGE_DURATION_S = 2.0

SendFn = Callable[[str, Command, float], List[Ack]]
ActionResult = Tuple[str, List[Ack]]


def _reached_done(acks: List[Ack]) -> bool:
    return bool(acks) and acks[-1].state == "done"


def forward_nudge() -> Command:
    return Command(
        type="motion",
        name="forward",
        params={"speed": NUDGE_SPEED_MPS, "duration": NUDGE_DURATION_S},
    )


def assign_actions(
    send: SendFn, robot_id: str, timeout_s: float, docked=None
) -> List[ActionResult]:
    """Undock, then a forward nudge iff the undock reached a `done` terminal ack.

    ``docked`` is the robot's live dock state when the caller knows it:
    **False** (already undocked) makes assignment a pure handover — no undock
    (the Create 3 Undock goal HANGS on an undocked robot: result timeout after
    the full window), no nudge. True/None (docked or unknown) attempts the
    normal sequence; the bridge's dock-guard covers the unknown case.
    """
    if docked is False:
        return []
    results: List[ActionResult] = []
    undock_acks = send(robot_id, Command(type="motion", name="undock"), timeout_s)
    results.append(("undock", undock_acks))
    if _reached_done(undock_acks):
        results.append(("forward", send(robot_id, forward_nudge(), timeout_s)))
    return results


def end_actions(send: SendFn, robot_id: str, timeout_s: float) -> List[ActionResult]:
    """Dock the robot at end of assignment."""
    return [("dock", send(robot_id, Command(type="motion", name="dock"), timeout_s))]
