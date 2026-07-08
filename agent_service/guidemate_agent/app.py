"""FastAPI app: chat API + static chat page + admin API/UI."""
from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import boto3
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Request, Response
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
from guidemate_agent.maps import fetch_map_meta, fetch_map_png
from guidemate_agent.mqtt_link import RobotRegistry
from guidemate_agent.observability import Observability
from guidemate_agent.store import ConfigStore
from guidemate_agent.ws_chat import CaptureRegistry, register as register_ws

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def _force_utf8_stdio() -> None:
    """Make stdout/stderr carry non-ASCII on any platform/console.

    Agent replies and logs contain emoji (the persona emits a paw print). Linux
    and the Docker image already use UTF-8, but a Windows dev console defaults to
    cp1252 and raises UnicodeEncodeError on the first emoji — which otherwise
    kills the request pipeline. errors="replace" guarantees a write never raises;
    the try/except covers pytest's captured streams (no reconfigure attribute)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


_force_utf8_stdio()


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
    # Shared ElevenLabs client (built once) when a voice backend uses it; None
    # otherwise. A configured-but-keyless backend logs a warning and leaves the AWS
    # default in force (speech.py falls back when el_client is None/errors), so a
    # missing key can never break startup or a chat turn.
    app.state.el_client = None
    if cfg.tts_backend == "elevenlabs" or cfg.stt_backend == "elevenlabs":
        if cfg.elevenlabs_api_key:
            try:
                from elevenlabs import ElevenLabs
                app.state.el_client = ElevenLabs(api_key=cfg.elevenlabs_api_key)
            except Exception:  # noqa: BLE001 — never block startup on the SDK
                log.exception("ElevenLabs client init failed; using AWS voice")
        else:
            log.warning(
                "voice backend set to elevenlabs but ELEVENLABS_API_KEY is empty; "
                "falling back to AWS (Polly/Transcribe)"
            )
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
    # and publishes nothing; ws_chat does the real publish + release gate), and the
    # session->robot resolver for the WS real-publish target. Default is the
    # AUTHORITATIVE binding (sessions.robot_for_session): it returns a robot id only
    # when the session both binds that robot AND holds its lock, else None (virtual)
    # — so a free/no-robot session never publishes and is never told a robot id.
    # Phase 4 may override the seam.
    app.state.observability = Observability()
    app.state.ws_agent = DogAgent(
        registry=CaptureRegistry(),
        model_id=cfg.model_id,
        robot_ids=cfg.robot_ids,
        region=cfg.region,
        store=store,
    )
    if not hasattr(app.state, "robot_target_resolver"):
        app.state.robot_target_resolver = sessions.robot_for_session

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
    # Idle cleanup: end (and dock) any session that has held a robot but been idle
    # longer than IDLE_TIMEOUT_S, so an abandoned session never parks the robot
    # undocked forever. Best-effort — sessions.sweep_idle_sessions never raises.
    idle_timeout_s = float(os.environ.get("GUIDEMATE_IDLE_TIMEOUT_S", "600"))
    scheduler.add_job(
        lambda: sessions.sweep_idle_sessions(idle_timeout_s, registry=registry),
        "interval", minutes=1, id="idle_dock_sweep",
    )
    scheduler.start()
    app.state.scheduler = scheduler
    log.info(
        "autonomy engine + scheduler started (morning stretch 09:00; "
        "idle dock sweep every 60s, timeout=%.0fs)", idle_timeout_s,
    )

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
            sessions.touch_session(req.session_id)  # keep the idle sweeper at bay
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


@app.post("/api/session/{session_id}/end")
def end_session(session_id: str, request: Request) -> dict:
    """Guest ends the assignment: release the robot lock and dock it (best-effort).
    A session holding no robot ends cleanly with freed_robot_id=null."""
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="unknown session")
    freed = sessions.end_session(session_id, registry=request.app.state.registry)
    return {"freed_robot_id": freed}


# --- user-facing session capabilities (Wave-2, NOT admin-gated) --------------
# These are the caller's OWN session: they only ever read the session's bound
# robot (sessions.robot_for_session requires both a binding AND the live lock),
# never another session's data. Every branch is best-effort — a lookup/S3/registry
# failure degrades to 404 (maps) or false/null (arsenal), never a 500/traceback.
def _session_robot(session_id: str) -> Optional[str]:
    """The robot bound to (and locked by) this session, or None. Never raises."""
    try:
        return sessions.robot_for_session(session_id)
    except Exception:  # noqa: BLE001 — a lookup failure degrades to "no robot"
        log.exception("robot_for_session lookup failed for %s", session_id)
        return None


@app.get("/api/session/{session_id}/map")
def session_map(session_id: str) -> Response:
    """Stream the PNG of this session's bound robot's latest SLAM map (through the
    app's own IAM role via app.state.s3). 404 (clean JSON) when the session has no
    bound robot, no map exists yet, or any S3 read fails — never a 500."""
    robot_id = _session_robot(session_id)
    if robot_id is None:
        raise HTTPException(status_code=404, detail="no robot bound to this session")
    try:
        png = fetch_map_png(app.state.s3, robot_id)
    except Exception:  # noqa: BLE001 — missing key / any S3 error -> no map yet
        raise HTTPException(status_code=404, detail="no map available for this session")
    return Response(content=png, media_type="image/png")


@app.get("/api/session/{session_id}/map/meta")
def session_map_meta(session_id: str) -> JSONResponse:
    """meta.json ({captured_ts, source}) for this session's bound robot's map.
    Same 404-not-500 contract as the map route above."""
    robot_id = _session_robot(session_id)
    if robot_id is None:
        raise HTTPException(status_code=404, detail="no robot bound to this session")
    try:
        meta = fetch_map_meta(app.state.s3, robot_id)
    except Exception:  # noqa: BLE001 — missing key / any S3 error -> no map yet
        raise HTTPException(status_code=404, detail="no map metadata for this session")
    return JSONResponse(meta)


@app.get("/api/session/{session_id}/arsenal")
def session_arsenal(session_id: str) -> JSONResponse:
    """Moses's capability/tool status for THIS session (user's own session, not
    admin-gated). Every field is best-effort: any lookup error degrades that field
    to false/null rather than 500ing the route."""
    cfg = getattr(app.state, "config", None)
    try:
        kb_available = bool(getattr(cfg, "kb_id", None))
    except Exception:  # noqa: BLE001
        kb_available = False

    robot_id = _session_robot(session_id)
    bound = robot_id is not None

    # A map is "available" only for a bound robot with an object actually in S3.
    maps_available = False
    if bound:
        try:
            fetch_map_png(app.state.s3, robot_id)
            maps_available = True
        except Exception:  # noqa: BLE001 — no map yet / S3 error -> not available
            maps_available = False

    # Safety gates come from the robot's live status (motion_enabled / dry_run).
    motion_enabled: Optional[bool] = None
    dry_run: Optional[bool] = None
    if bound:
        try:
            gates = (app.state.registry.get_status(robot_id) or {}).get("gates") or {}
            motion_enabled = gates.get("motion_enabled")
            dry_run = gates.get("dry_run")
        except Exception:  # noqa: BLE001 — status unreachable -> leave gates null
            log.exception("arsenal get_status failed for %s", robot_id)

    # Effective safety posture: an unbound session can never move a robot (dry-run
    # by construction); a bound session is dry-run when its robot reports dry_run.
    safety_dry_run = (not bound) or bool(dry_run)

    return JSONResponse({
        "knowledge": {"available": kb_available},
        "maps": {"available": maps_available},
        "human_handoff": {"available": True},
        "robot": {
            "bound": bound,
            "robot_id": robot_id,
            "dry_run": dry_run,
            "motion_enabled": motion_enabled,
        },
        "safety": {"dry_run": safety_dry_run},
    })


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Task 5 chat UI assets. Explicit routes (not a root StaticFiles mount) so they
# can't shadow /api/* or /admin -- same pattern as `index()` above.
@app.get("/chat.js")
def chat_js() -> FileResponse:
    return FileResponse(STATIC_DIR / "chat.js", media_type="application/javascript")


@app.get("/chat.css")
def chat_css() -> FileResponse:
    return FileResponse(STATIC_DIR / "chat.css", media_type="text/css")


# Moses brand assets (Husky head mark + Northeastern Vancouver affiliation
# lockup). Explicit routes -- same pattern as `chat_css()` above -- so the chat
# page never references docs/ paths at runtime.
@app.get("/brand/moses-husky-head.svg")
def brand_husky() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "brand" / "moses-husky-head.svg", media_type="image/svg+xml"
    )


@app.get("/brand/northeastern-vancouver-lockup.png")
def brand_campus_lockup() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "brand" / "northeastern-vancouver-lockup.png",
        media_type="image/png",
    )


# Admin UI (index.html + admin.js + admin.css). Mounted AFTER the API routes so
# /api/admin/* is handled by the router, not the static files.
app.mount(
    "/admin",
    StaticFiles(directory=STATIC_DIR / "admin", html=True),
    name="admin",
)
