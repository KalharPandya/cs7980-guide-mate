"""Command / Ack schema — single source of truth for service and bridge."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

_EMOTE_NAMES = ("happy", "yes", "no")
# "dock"/"undock" added for the assignment-triggered dock/undock flow (spec delta,
# commit 91d9bcb). The choreography library has NO dock/undock sequence — the bridge
# executor's build() raises ValueError for them, acking `failed` ("unknown
# choreography"), and the Phase 2 safety layer refuses them as motion while locked.
# Bridge-side EXECUTION (Create 3 dock actions + dock-guard exemption) is Phase 8.
_MOTION_NAMES = ("circle", "spin", "dock", "undock", "forward")
# "navigate" targets are open-ended (room numbers/labels/coordinates), not a fixed
# short enum like emotes/motions, so `name` is a stable constant (mirrors `stop`'s
# name always being "stop") and the *destination* is validated via `params` instead:
# either a `room` string key or both `x`/`z` numeric keys must be present.
_NAVIGATE_NAMES = ("goto",)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_number(value: object) -> bool:
    """int/float, excluding bool (bool is technically an int subclass)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_string(value: object) -> bool:
    return isinstance(value, str)


def new_cmd_id() -> str:
    return str(uuid.uuid4())


class Command(BaseModel):
    cmd_id: str = Field(default_factory=new_cmd_id)
    type: Literal["emote", "motion", "stop", "navigate", "assign"]
    name: str
    params: dict = Field(default_factory=dict)
    ts: str = Field(default_factory=_utc_now_iso)

    @model_validator(mode="after")
    def _check_name(self) -> "Command":
        if self.type == "emote" and self.name not in _EMOTE_NAMES:
            raise ValueError(f"emote name must be one of {_EMOTE_NAMES}, got {self.name!r}")
        if self.type == "motion" and self.name not in _MOTION_NAMES:
            raise ValueError(f"motion name must be one of {_MOTION_NAMES}, got {self.name!r}")
        if self.type == "stop" and self.name != "stop":
            raise ValueError(f"stop command name must be 'stop', got {self.name!r}")
        if self.type == "navigate":
            if self.name not in _NAVIGATE_NAMES:
                raise ValueError(f"navigate name must be one of {_NAVIGATE_NAMES}, got {self.name!r}")
            has_room = isinstance(self.params.get("room"), str)
            has_xz = _is_number(self.params.get("x")) and _is_number(self.params.get("z"))
            if not (has_room or has_xz):
                raise ValueError(
                    "navigate params must contain a 'room' string or both 'x' and 'z' "
                    f"numeric keys, got {self.params!r}"
                )
        if self.type == "assign":
            # "assign" is fleet-scoped (not robot-addressed -- see fleet_cmd_topic()):
            # nobody knows which robot will be picked yet, so unlike navigate/motion/
            # emote there is no target robot id anywhere on this command. `name` is a
            # stable constant exactly like `stop`'s name is always "stop"; the payload
            # instead carries WHO to assign (visitor_id) and WHERE to guide them (room).
            if self.name != "assign":
                raise ValueError(f"assign command name must be 'assign', got {self.name!r}")
            if not _is_string(self.params.get("visitor_id")):
                raise ValueError(
                    f"assign params must contain a 'visitor_id' string key, got {self.params!r}"
                )
            if not _is_string(self.params.get("room")):
                raise ValueError(
                    f"assign params must contain a 'room' string key, got {self.params!r}"
                )
        return self


class Ack(BaseModel):
    cmd_id: str
    state: Literal["received", "running", "done", "failed"]
    reason: Optional[str] = None
    simulated: bool = False
    battery: Optional[float] = None
    # Gate snapshot at ack time, e.g. {"docked": true, "motion_enabled": false,
    # "dry_run": true}. None on acks from pre-Phase-2 bridges.
    gates: Optional[dict] = None
    # The robot picked for an "assign" command (e.g. "virtual/3"). Only ever set on
    # the `done` ack of an assign; None for every other command type and for a
    # `failed` assign (no robot was picked). Optional the same way battery/gates
    # are optional, so pre-Phase-4 acks (and physical-robot acks, which never
    # assign) round-trip unchanged.
    assigned_robot_id: Optional[str] = None
    ts: str = Field(default_factory=_utc_now_iso)


class Heartbeat(BaseModel):
    """Periodic bridge liveness + robot truth: published to status_topic every 30 s."""

    event: Literal["heartbeat"] = "heartbeat"
    robot_id: str
    battery: Optional[float] = None      # Create 3 charge fraction 0..1; None if unreadable
    docked: Optional[bool] = None        # None = dock state unknown (telemetry not up)
    uptime_s: float
    gates: dict = Field(default_factory=dict)
    ts: str = Field(default_factory=_utc_now_iso)


def cmd_topic(robot_id: str) -> str:
    return f"guidemate/{robot_id}/cmd"


def status_topic(robot_id: str) -> str:
    return f"guidemate/{robot_id}/status"


# Fleet-scoped topics (not per-robot): "assign" a visitor to a robot before any robot
# id is known. Deliberately NOT built from cmd_topic/status_topic with a fake robot id
# like "fleet" -- a named helper is clearer than a magic string that happens to also
# satisfy the virtual fleet's `guidemate/virtual/*` IAM scope.
def fleet_cmd_topic() -> str:
    return "guidemate/virtual/fleet/cmd"


def fleet_status_topic() -> str:
    return "guidemate/virtual/fleet/status"
