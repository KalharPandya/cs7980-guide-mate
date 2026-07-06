"""FastAPI app: chat API + static chat page + admin API/UI."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from guidemate_msgs.jsonlog import setup

from guidemate_agent import admin
from guidemate_agent.config import Config
from guidemate_agent.dog_agent import DogAgent
from guidemate_agent.fakes import FakeRobotRegistry
from guidemate_agent.kb import KBManager
from guidemate_agent.mqtt_link import RobotRegistry
from guidemate_agent.store import ConfigStore

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class ChatRequest(BaseModel):
    message: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup("agent-service")
    cfg = Config.from_env()
    if os.environ.get("GUIDEMATE_FAKE_ROBOT") == "1":
        # In-memory registry (no MQTT / no robot) for tests and offline demos.
        registry = FakeRobotRegistry(cfg.robot_ids)
        registry.connect()
    else:
        registry = RobotRegistry(
            endpoint=cfg.iot_endpoint, region=cfg.region, robot_ids=cfg.robot_ids
        )
        try:
            registry.connect()
        except Exception:  # noqa: BLE001 — chat still works if robots are unreachable
            log.exception("registry connect failed — robots unreachable, chat still works")
    app.state.registry = registry
    # ConfigStore is read fresh each turn inside DogAgent.chat() so admin flag
    # flips (mute / tool gating / persona) take effect on the very next message.
    store = ConfigStore(region=cfg.region)
    app.state.store = store
    # Config + KB manager are read by the admin API (status / kill-switch / KB).
    app.state.config = cfg
    app.state.kb = KBManager(
        bucket=cfg.kb_bucket,
        kb_id=cfg.kb_id,
        data_source_id=cfg.kb_data_source,
        region=cfg.region,
    )
    app.state.agent = DogAgent(
        registry=registry,
        model_id=cfg.model_id,
        robot_ids=cfg.robot_ids,
        region=cfg.region,
        store=store,
    )
    yield


app = FastAPI(lifespan=lifespan)
app.include_router(admin.router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    return JSONResponse(app.state.agent.chat(req.message))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Admin UI (index.html + admin.js + admin.css). Mounted AFTER the API routes so
# /api/admin/* is handled by the router, not the static files.
app.mount(
    "/admin",
    StaticFiles(directory=STATIC_DIR / "admin", html=True),
    name="admin",
)
