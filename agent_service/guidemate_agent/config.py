"""Simple env-based config (no pydantic dependency)."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    robot_ids: list[str]
    iot_endpoint: str
    model_id: str
    region: str

    @classmethod
    def from_env(cls) -> "Config":
        robots = os.environ.get("GUIDEMATE_ROBOTS", "turtlebot468")
        robot_ids = [r.strip() for r in robots.split(",") if r.strip()]
        return cls(
            robot_ids=robot_ids,
            iot_endpoint=os.environ.get("GUIDEMATE_IOT_ENDPOINT", ""),
            model_id=os.environ.get("GUIDEMATE_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
            region=os.environ.get("AWS_REGION", "us-west-2"),
        )
