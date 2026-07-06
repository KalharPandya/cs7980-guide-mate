"""FastAPI app: chat API + static chat page + admin API/UI."""
from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import boto3
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from guidemate_msgs.jsonlog import setup
from guidemate_msgs.metrics import emit_metric

from guidemate_agent import admin, sessions
from guidemate_agent.autonomy import AUTONOMY_SESSION_ID, EventEngine
from guidemate_agent.config import Config
from guidemate_agent.dog_agent import DogAgent
from guidemate_agent.fakes import FakeRobotRegistry
from guidemate_agent.kb import KBManager
from guidemate_agent.mqtt_link import RobotRegistry
from guidemate_agent.observability import Observability
from guidemate_agent.store import ConfigStore
from guidemate_agent.ws_chat import CaptureRegistry, register as register_ws

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
    # Admin Maps tab: streams map PNGs from the (public-access-blocked) maps
    # bucket through the app's own IAM role -- see guidemate_agent.maps +
    # admin.get_map/get_map_meta.
    app.state.s3 = boto3.client("s3", region_name=cfg.region)
    app.state.agent = DogAgent(
        registry=registry,
        model_id=cfg.model_id,
        robot_ids=cfg.robot_ids,
        region=cfg.region,
        store=store,
    )

    # WS chat path (/ws/chat/{session_id}): in-process telemetry ring buffers, a
    # WS-path agent whose emote is picked here but whose physical publish is owned
    # by ws_chat (hence CaptureRegistry — the agent's send_emote succeeds virtually
    # and publishes nothing; ws_chat does the real publish + release gate), and a
    # virtual-only session->robot resolver (Phase 4 overrides it with a real one).
    app.state.observability = Observability()
    app.state.ws_agent = DogAgent(
        registry=CaptureRegistry(),
        model_id=cfg.model_id,
        robot_ids=cfg.robot_ids,
        region=cfg.region,
        store=store,
    )
    if not hasattr(app.state, "robot_target_resolver"):
        app.state.robot_target_resolver = lambda session_id: None

    # Autonomy: unprompted, motion-free turns driven by robot status events
    # (via registry.on_event) and a daily scheduled job (morning stretch).
    # NOTE (adaptation): EventEngine's `store` only needs `.ensure_session(id,
    # name)` to keep the system session visible in the admin Sessions tab —
    # that's a *sessions*-table concern (guidemate-sessions), not a
    # ConfigStore (guidemate-config flags/prompt) concern, so the `sessions`
    # module (which now exposes ensure_session) is passed here, not
    # `app.state.store`.
    default_robot_id = cfg.robot_ids[0] if cfg.robot_ids else None
    engine = EventEngine(
        agent=app.state.agent,
        store=sessions,
        default_robot_id=default_robot_id,
        session_id=os.environ.get("GUIDEMATE_AUTONOMY_SESSION_ID", AUTONOMY_SESSION_ID),
    )
    app.state.engine = engine
    registry.on_event(engine.on_status_event)

    scheduler = BackgroundScheduler(timezone="America/New_York")
    scheduler.add_job(engine.morning_stretch, "cron", hour=9, minute=0, id="morning_stretch")
    scheduler.start()
    app.state.scheduler = scheduler
    log.info("autonomy engine + scheduler started (morning stretch daily 09:00)")

    try:
        yield
    finally:
        app.state.scheduler.shutdown(wait=False)


app = FastAPI(lifespan=lifespan)
app.include_router(admin.router)
register_ws(app)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> JSONResponse:
    """Readiness probe: mqtt (RobotRegistry link) + dynamo (ConfigStore reachable).

    Both checks are best-effort and never raise — an unreachable dependency
    just flips its check to False rather than 500ing the probe.
    """
    registry = getattr(app.state, "registry", None)
    try:
        mqtt_ok = bool(registry is not None and registry.is_connected)
    except Exception:  # noqa: BLE001 — readiness must never raise
        mqtt_ok = False
    try:
        store = getattr(app.state, "store", None)
        dynamo_ok = store is not None and store.get_flags() is not None
    except Exception:  # noqa: BLE001 — readiness must never raise
        dynamo_ok = False
    checks = {"mqtt": mqtt_ok, "dynamo": dynamo_ok}
    ready = all(checks.values())
    return JSONResponse({"ready": ready, "checks": checks}, status_code=200 if ready else 503)


@app.post("/api/session")
def create_session(req: SessionRequest) -> dict:
    return {"session_id": sessions.create_session(req.name, req.comfortable)}


@app.post("/api/chat")
def chat(req: ChatRequest) -> JSONResponse:
    # Legacy message-only path unchanged. With a session_id, DogAgent.chat
    # resolves name/history/robot binding and persists both messages itself;
    # app.py only threads the id through (validating it first).
    t0 = time.perf_counter()
    try:
        if req.session_id is None:
            result = app.state.agent.chat(req.message)
        else:
            if sessions.get_session(req.session_id) is None:
                raise HTTPException(status_code=404, detail="unknown session")
            result = app.state.agent.chat(req.message, session_id=req.session_id)
    except HTTPException:
        raise
    except Exception:
        emit_metric("ErrorCount", 1)
        raise
    finally:
        emit_metric("TurnLatencyMs", (time.perf_counter() - t0) * 1000.0, "Milliseconds")
    return JSONResponse(result)


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
