"""Thread-safe safety gate truth — default-deny; the shadow can only tighten dry-run."""
from __future__ import annotations

import threading
import time
from typing import Optional

from guidemate_msgs.choreography import MAX_LINEAR


class SafetyState:
    """Single source of gate truth shared by executor, shadow sync, and telemetry.

    Defaults are LOCKED (motion_enabled=False, max_speed=MAX_LINEAR, dry_run=True,
    dock unknown). SAFETY INVARIANT: effective dry_run = env dry_run OR shadow
    dry_run — an env value of True can never be loosened by the shadow.
    """

    def __init__(self, env_dry_run: bool = True) -> None:
        self._lock = threading.Lock()
        self._env_dry_run = env_dry_run
        self._shadow_dry_run = True      # default-deny until the shadow says otherwise
        self._motion_enabled = False     # default-deny
        self._max_speed = MAX_LINEAR
        self._docked: Optional[bool] = None  # None = unknown (telemetry not reporting)
        self._started = time.monotonic()

    @property
    def effective_dry_run(self) -> bool:
        with self._lock:
            return self._env_dry_run or self._shadow_dry_run

    @property
    def max_speed(self) -> float:
        with self._lock:
            return self._max_speed

    def set_docked(self, docked: Optional[bool]) -> None:
        with self._lock:
            self._docked = docked

    def apply_shadow(self, desired: dict) -> None:
        """Apply desired shadow keys. Unknown keys ignored; malformed values ignored;
        max_speed clamped to [0.0, MAX_LINEAR] so the shadow can never exceed the cap."""
        with self._lock:
            if "motion_enabled" in desired:
                self._motion_enabled = bool(desired["motion_enabled"])
            if "max_speed" in desired:
                try:
                    self._max_speed = max(0.0, min(float(desired["max_speed"]), MAX_LINEAR))
                except (TypeError, ValueError):
                    pass  # malformed shadow value cannot change anything
            if "dry_run" in desired:
                self._shadow_dry_run = bool(desired["dry_run"])

    def gates(self) -> dict:
        """Snapshot for acks/heartbeats. dry_run here is the EFFECTIVE value."""
        with self._lock:
            return {
                "docked": self._docked,
                "motion_enabled": self._motion_enabled,
                "dry_run": self._env_dry_run or self._shadow_dry_run,
            }

    def reported(self) -> dict:
        """Shadow 'reported' payload: same keys as desired; dry_run is EFFECTIVE."""
        with self._lock:
            return {
                "motion_enabled": self._motion_enabled,
                "max_speed": self._max_speed,
                "dry_run": self._env_dry_run or self._shadow_dry_run,
            }

    def uptime_s(self) -> float:
        return time.monotonic() - self._started
