"""Command / Ack schema — single source of truth for service and bridge."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

_EMOTE_NAMES = ("happy", "yes", "no")
_MOTION_NAMES = ("circle", "spin")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_cmd_id() -> str:
    return str(uuid.uuid4())


class Command(BaseModel):
    cmd_id: str = Field(default_factory=new_cmd_id)
    type: Literal["emote", "motion", "stop"]
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
        return self


class Ack(BaseModel):
    cmd_id: str
    state: Literal["received", "running", "done", "failed"]
    reason: Optional[str] = None
    simulated: bool = False
    battery: Optional[float] = None
    ts: str = Field(default_factory=_utc_now_iso)


def cmd_topic(robot_id: str) -> str:
    return f"guidemate/{robot_id}/cmd"


def status_topic(robot_id: str) -> str:
    return f"guidemate/{robot_id}/status"
