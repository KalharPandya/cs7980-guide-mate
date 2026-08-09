"""Live-avatar POC backend (Option A).

One FastAPI service that turns text into what the browser dog needs to talk:
Amazon Polly audio (base64 mp3) plus viseme speech-marks (mouth-shape timing).
It also echoes the requested emote so the frontend can play the same emote
vocabulary the physical robot uses.

Deliberately standalone: no robot, no IoT, no Bedrock. It proves the one novel
piece of the live-avatar design — viseme-driven lip-sync + emotes in the browser.

AWS creds come from the default profile (the cert-based guidemate-agent-role via
credential_process — see docs/agent-poc/access-ground-truth.md). Region us-west-2.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

REGION = os.environ.get("AWS_REGION", "us-west-2")
STATIC_DIR = Path(__file__).parent / "static"

# The single emote vocabulary — the SAME set the robot bridge node plays.
# Source of truth mirrored from the design spec; the on-screen avatar and the
# physical robot must stay in lockstep on these names.
EMOTES = ["idle", "happy", "yes", "no", "circle", "spin"]

app = FastAPI(title="guide-mate live avatar POC")
_polly = boto3.client("polly", region_name=REGION)


class SayRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=600)
    emote: str = "idle"
    voice: str = "Ivy"          # playful child voice; any neural en-US voice works
    engine: str = "neural"      # neural supports BOTH audio and viseme marks


class SayResponse(BaseModel):
    text: str
    emote: str
    voice: str
    engine: str
    content_type: str
    audio_b64: str
    visemes: list[dict]


def _synth(text: str, voice: str, engine: str, output_format: str, mark: bool):
    kwargs = dict(Text=text, VoiceId=voice, Engine=engine, OutputFormat=output_format)
    if mark:
        kwargs["SpeechMarkTypes"] = ["viseme"]
    resp = _polly.synthesize_speech(**kwargs)
    return resp["AudioStream"].read()


@app.post("/api/say", response_model=SayResponse)
def say(req: SayRequest) -> SayResponse:
    emote = req.emote if req.emote in EMOTES else "idle"
    try:
        audio = _synth(req.text, req.voice, req.engine, "mp3", mark=False)
        marks_raw = _synth(req.text, req.voice, req.engine, "json", mark=True)
    except (BotoCoreError, ClientError) as exc:
        raise HTTPException(status_code=502, detail=f"Polly error: {exc}") from exc

    visemes = [
        json.loads(line) for line in marks_raw.decode("utf-8").splitlines() if line.strip()
    ]
    return SayResponse(
        text=req.text,
        emote=emote,
        voice=req.voice,
        engine=req.engine,
        content_type="audio/mpeg",
        audio_b64=base64.b64encode(audio).decode("ascii"),
        visemes=visemes,
    )


@app.get("/api/health")
def health() -> dict:
    """Confirm the process is up and whether Polly is reachable with our creds."""
    try:
        _polly.describe_voices(Engine="neural", LanguageCode="en-US")
        polly_ok = True
    except (BotoCoreError, ClientError):
        polly_ok = False
    return {"status": "ok", "region": REGION, "polly": polly_ok, "emotes": EMOTES}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
