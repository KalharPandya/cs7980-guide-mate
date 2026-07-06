"""Autonomy: data-driven rules + a debounced low-battery detector.

Phase 6, part 1 — pure logic only (no agent/registry coupling; that arrives in the
EventEngine below in Task 2). Rules are DATA, not code.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

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


class EventEngine:
    """Turns robot status events + scheduled jobs into unprompted, motion-free agent turns."""

    def __init__(
        self,
        agent,
        store,
        default_robot_id: Optional[str],
        session_id: str = AUTONOMY_SESSION_ID,
        fire_below: float = FIRE_BELOW,
        reset_above: float = RESET_ABOVE,
    ) -> None:
        self._agent = agent
        self._store = store
        self.default_robot_id = default_robot_id
        self.session_id = session_id
        self._fire_below = fire_below
        self._reset_above = reset_above
        self._debouncers: dict[str, LowBatteryDebouncer] = {}

    def _debouncer(self, robot_id: str) -> LowBatteryDebouncer:
        return self._debouncers.setdefault(
            robot_id, LowBatteryDebouncer(self._fire_below, self._reset_above)
        )

    def on_status_event(self, event: dict) -> Optional[str]:
        robot_id = event.get("robot_id") or self.default_robot_id or "?"
        data = event.get("data") or {}

        if data.get("event") == "offline":
            self._fire(
                "robot_offline",
                robot_id,
                f"Robot {robot_id} just went offline — it dropped its connection.",
            )
            return "robot_offline"

        battery = data.get("battery")
        if isinstance(battery, (int, float)) and self._debouncer(robot_id).update(float(battery)):
            self._fire(
                "low_battery",
                robot_id,
                f"Robot {robot_id}'s battery is low ({float(battery) * 100:.0f}%). "
                "It should return to its dock soon.",
            )
            return "low_battery"
        return None

    def morning_stretch(self) -> str:
        robot_id = self.default_robot_id or "?"
        self._fire(
            "morning_stretch",
            robot_id,
            "Good morning! It's time for your daily morning stretch — "
            "greet everyone warmly and do a happy wiggle emote.",
        )
        return "morning_stretch"

    def _fire(self, rule_name: str, robot_id: str, system_event: str) -> None:
        log.info(
            "autonomy rule fired: %s (robot=%s)",
            rule_name,
            robot_id,
            extra={"robot_id": robot_id, "session_id": self.session_id, "rule": rule_name},
        )
        try:
            # Idempotent — keeps the system session visible in the admin Sessions tab.
            self._store.ensure_session(self.session_id, AUTONOMY_SESSION_NAME)
            # Motion tools are excluded from autonomy turns (allow_motion=False) — safety.
            self._agent.chat(
                message=None,
                session_id=self.session_id,
                robot_id=robot_id,
                system_event=system_event,
                allow_motion=False,
            )
        except Exception:  # noqa: BLE001 — must never break the MQTT callback thread / scheduler
            log.exception("autonomy turn failed for rule %s", rule_name)
