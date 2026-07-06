"""Autonomy: data-driven rules + a debounced low-battery detector.

Phase 6, part 1 — pure logic only (no agent/registry coupling; that arrives in the
EventEngine below in Task 2). Rules are DATA, not code.
"""
from __future__ import annotations

FIRE_BELOW = 0.15
RESET_ABOVE = 0.25
AUTONOMY_SESSION_ID = "system-autonomy"
AUTONOMY_SESSION_NAME = "System (autonomy)"

# Rules expressed as data so thresholds/events are tunable without touching dispatch code.
RULES = (
    {
        "name": "low_battery",
        "kind": "threshold",
        "field": "battery",
        "fire_below": FIRE_BELOW,
        "reset_above": RESET_ABOVE,
    },
    {
        "name": "robot_offline",
        "kind": "event",
        "event": "offline",
    },
)


class LowBatteryDebouncer:
    """Fire once per crossing below `fire_below`; re-arm only after recovery above `reset_above`."""

    def __init__(self, fire_below: float = FIRE_BELOW, reset_above: float = RESET_ABOVE) -> None:
        self._fire_below = fire_below
        self._reset_above = reset_above
        self._armed = True

    def update(self, battery: float) -> bool:
        if self._armed and battery < self._fire_below:
            self._armed = False
            return True
        if not self._armed and battery > self._reset_above:
            self._armed = True
        return False
