"""Simple env-based config (no pydantic dependency)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _parse_things(raw: str) -> dict:
    """Parse GUIDEMATE_THING_NAMES='robot_id=ThingName,robot2=Thing2' -> dict."""
    mapping = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        robot_id, thing = pair.split("=", 1)
        mapping[robot_id.strip()] = thing.strip()
    return mapping


@dataclass
class Config:
    robot_ids: list[str]
    iot_endpoint: str
    model_id: str
    region: str
    kb_id: str = "A1NIQYZ0KQ"
    kb_bucket: str = "guidemate-kb-docs-852373397000"
    kb_data_source: str = "OT8JLH57TE"
    thing_names: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Config":
        robots = os.environ.get("GUIDEMATE_ROBOTS", "turtlebot468")
        robot_ids = [r.strip() for r in robots.split(",") if r.strip()]
        return cls(
            robot_ids=robot_ids,
            iot_endpoint=os.environ.get("GUIDEMATE_IOT_ENDPOINT", ""),
            model_id=os.environ.get("GUIDEMATE_MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
            region=os.environ.get("AWS_REGION", "us-west-2"),
            kb_id=os.environ.get("GUIDEMATE_KB_ID", "A1NIQYZ0KQ"),
            kb_bucket=os.environ.get(
                "GUIDEMATE_KB_BUCKET", "guidemate-kb-docs-852373397000"
            ),
            kb_data_source=os.environ.get("GUIDEMATE_KB_DATA_SOURCE", "OT8JLH57TE"),
            thing_names=_parse_things(
                os.environ.get("GUIDEMATE_THING_NAMES", "turtlebot468=Turtlebot-468")
            ),
        )
