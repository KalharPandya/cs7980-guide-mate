"""Simple env-based config (no pydantic dependency)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

# The ElevenLabs voice for Moses (a library voice id — NOT a secret; the API key
# gates access). Used only when tts_backend='elevenlabs'; env-overridable.
MOSES_VOICE_ID = "vBKc2FfBKJfcZNyEt1n6"


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
    tts_backend: str = "polly"
    stt_backend: str = "transcribe"
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = MOSES_VOICE_ID
    elevenlabs_tts_model: str = "eleven_flash_v2_5"
    elevenlabs_stt_model: str = "scribe_v2_realtime"

    @classmethod
    def from_env(cls) -> "Config":
        # turtlebotsim (the Ignition sim) is grantable out of the box alongside
        # the physical turtlebot468 -- Phase 8 Task 7 "virtual-pet grant". Still
        # fully env-overridable (GUIDEMATE_ROBOTS=turtlebot468 restores the old
        # physical-only default).
        robots = os.environ.get("GUIDEMATE_ROBOTS", "turtlebot468,turtlebotsim")
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
            tts_backend=os.environ.get("GUIDEMATE_TTS_BACKEND", "polly"),
            stt_backend=os.environ.get("GUIDEMATE_STT_BACKEND", "transcribe"),
            # Intentionally unprefixed — matches the ElevenLabs SDK's own env-var name.
            elevenlabs_api_key=os.environ.get("ELEVENLABS_API_KEY", ""),
            # Intentionally unprefixed (matches vendor convention). `or` (not a
            # get-default) so an env var present-but-EMPTY — which docker compose's
            # `${ELEVENLABS_VOICE_ID:-}` produces — still falls back to the Moses
            # voice instead of sending an empty voice_id to ElevenLabs.
            elevenlabs_voice_id=os.environ.get("ELEVENLABS_VOICE_ID") or MOSES_VOICE_ID,
            elevenlabs_tts_model=os.environ.get(
                "GUIDEMATE_ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5"
            ),
            elevenlabs_stt_model=os.environ.get(
                "GUIDEMATE_ELEVENLABS_STT_MODEL", "scribe_v2_realtime"
            ),
        )
