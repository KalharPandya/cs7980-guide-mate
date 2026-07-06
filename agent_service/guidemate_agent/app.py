"""FastAPI app: chat API + static chat page + admin API/UI."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from guidemate_msgs.jsonlog import setup

from guidemate_agent import admin, sessions
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
    # Optional session id. When present the turn is session-aware (DogAgent
    # resolves name / last-10 history / bound robot and persists both messages
    # internally). Absent => the legacy message-only path (Phase 0-1 callers).
    session_id: Optional[str] = None


class SessionRequest(BaseModel):
    name: str
    comfortable: bool = False


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


@app.post("/api/session")
def create_session(req: SessionRequest) -> dict:
    return {"session_id": sessions.create_session(req.name, req.comfortable)}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    # Legacy message-only path unchanged. With a session_id, DogAgent.chat
    # resolves name/history/robot binding and persists both messages itself;
    # app.py only threads the id through (validating it first).
    if req.session_id is None:
        return JSONResponse(app.state.agent.chat(req.message))
    if sessions.get_session(req.session_id) is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return JSONResponse(app.state.agent.chat(req.message, session_id=req.session_id))


@app.post("/api/session/{session_id}/request-companion")
def request_companion(session_id: str) -> dict:
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return {"request_id": sessions.create_request(session_id), "status": "pending"}


@app.get("/api/session/{session_id}/state")
def session_state(session_id: str) -> dict:
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="unknown session")
    return sessions.get_session_state(session_id)


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
