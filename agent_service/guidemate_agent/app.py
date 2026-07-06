"""FastAPI app: plain chat API + static chat page."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from guidemate_msgs.jsonlog import setup

from guidemate_agent.config import Config
from guidemate_agent.dog_agent import DogAgent
from guidemate_agent.mqtt_link import RobotRegistry

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class ChatRequest(BaseModel):
    message: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup("agent-service")
    cfg = Config.from_env()
    registry = RobotRegistry(
        endpoint=cfg.iot_endpoint, region=cfg.region, robot_ids=cfg.robot_ids
    )
    try:
        registry.connect()
    except Exception:  # noqa: BLE001 — chat still works if robots are unreachable
        log.exception("registry connect failed — robots unreachable, chat still works")
    app.state.registry = registry
    app.state.agent = DogAgent(
        registry=registry, model_id=cfg.model_id, robot_ids=cfg.robot_ids
    )
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    return JSONResponse(app.state.agent.chat(req.message))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
