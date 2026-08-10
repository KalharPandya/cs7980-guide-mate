"""Admin API: password login -> signed HttpOnly Secure SameSite=Strict cookie,
then flags / prompt / robot-status / kill-switch / KB management endpoints.

Absent GUIDEMATE_ADMIN_PASSWORD => every route returns 503 (admin disabled).
The kill switch may ONLY ever write the stricter dry_run=true / motion_enabled=false;
a request that tries to enable motion (or disable dry_run) is refused with 400
regardless of authentication.
"""
from __future__ import annotations

import collections
import hmac
import json
import logging
import os
import re
import time
from typing import Optional

import boto3
from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from pydantic import BaseModel, ValidationError

from guidemate_msgs.messages import Command, new_cmd_id

from guidemate_agent import sessions
from guidemate_agent.maps import fetch_map_meta, fetch_map_png
from guidemate_agent.store import DEFAULT_FLAGS

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin")

COOKIE_NAME = "guidemate_admin"
TOKEN = "admin"
MAX_AGE = 12 * 3600  # 12 hours
_RATE_WINDOW_S = 60
_RATE_MAX_FAILURES = 5

# In-process failure timestamps (single credential => one global counter).
_failures: collections.deque = collections.deque()


def _password() -> Optional[str]:
    return os.environ.get("GUIDEMATE_ADMIN_PASSWORD")


def _signer() -> Optional[TimestampSigner]:
    pw = _password()
    return TimestampSigner(pw) if pw else None


def _require_configured() -> None:
    if not _password():
        raise HTTPException(status_code=503, detail="admin not configured")


def _rate_limited() -> bool:
    now = time.time()
    while _failures and now - _failures[0] > _RATE_WINDOW_S:
        _failures.popleft()
    return len(_failures) >= _RATE_MAX_FAILURES


def admin_required(request: Request) -> bool:
    _require_configured()
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        value = _signer().unsign(raw, max_age=MAX_AGE).decode("utf-8")
    except (BadSignature, SignatureExpired):
        raise HTTPException(status_code=401, detail="invalid session")
    if value != TOKEN:
        raise HTTPException(status_code=401, detail="invalid session")
    return True


# --- auth ----------------------------------------------------------------
class LoginBody(BaseModel):
    password: str


@router.post("/login")
def login(body: LoginBody, response: Response) -> dict:
    _require_configured()
    if _rate_limited():
        raise HTTPException(status_code=429, detail="too many attempts, wait a minute")
    if not hmac.compare_digest(body.password, _password()):
        _failures.append(time.time())
        raise HTTPException(status_code=401, detail="invalid password")
    token = _signer().sign(TOKEN).decode("utf-8")
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=MAX_AGE,
        httponly=True,
        secure=True,
        samesite="strict",
    )
    return {"ok": True}


# --- flags ---------------------------------------------------------------
class FlagBody(BaseModel):
    name: str
    value: bool


@router.get("/flags")
def get_flags(request: Request, _: bool = Depends(admin_required)) -> dict:
    return request.app.state.store.get_flags()


@router.put("/flags")
def put_flag(body: FlagBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    if body.name not in DEFAULT_FLAGS:
        raise HTTPException(status_code=400, detail=f"unknown flag {body.name!r}")
    request.app.state.store.set_flag(body.name, body.value)
    return request.app.state.store.get_flags()


# --- admin-set prompt ----------------------------------------------------
class PromptBody(BaseModel):
    system_prompt: Optional[str] = None


@router.get("/prompt")
def get_prompt(request: Request, _: bool = Depends(admin_required)) -> dict:
    return {"system_prompt": request.app.state.store.get_prompt()}


@router.put("/prompt")
def put_prompt(body: PromptBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    request.app.state.store.set_prompt(body.system_prompt)
    return {"system_prompt": request.app.state.store.get_prompt()}


# --- robot status --------------------------------------------------------
@router.get("/status")
def status(request: Request, _: bool = Depends(admin_required)) -> dict:
    reg = request.app.state.registry
    cfg = request.app.state.config
    return {"robots": [reg.get_status(rid) for rid in cfg.robot_ids]}


# --- health (Task 6: admin Health tab) ------------------------------------
# Merges the in-process observability ring buffers (Observability.snapshot():
# {commands, latencies, errors} — Phase 5 Task 3) with the same per-robot
# get_status() the /status route above already uses, over the real
# cfg.robot_ids list (never hardcoded to turtlebot468).
@router.get("/health")
def health(request: Request, _: bool = Depends(admin_required)) -> dict:
    obs = getattr(request.app.state, "observability", None)
    snap = obs.snapshot() if obs is not None else {"commands": [], "latencies": [], "errors": []}
    reg = request.app.state.registry
    cfg = request.app.state.config
    snap["robots"] = [reg.get_status(rid) for rid in cfg.robot_ids]
    return snap


# --- kill switch (one-way-to-safe) --------------------------------------
class KillBody(BaseModel):
    robot_id: str
    # Optional overrides are accepted ONLY so we can hard-refuse an unsafe
    # request. The endpoint never writes a caller-supplied value; see below.
    motion_enabled: Optional[bool] = None
    dry_run: Optional[bool] = None


def _assert_kill_is_safe(body: "KillBody") -> None:
    """The kill switch is one-way-to-safe: it may only ever drive the shadow to
    dry_run=true / motion_enabled=false. Refuse (400) any attempt to enable
    motion or disable dry_run BEFORE anything is written to the shadow."""
    if body.motion_enabled is True:
        raise HTTPException(
            status_code=400, detail="kill switch may never enable motion"
        )
    if body.dry_run is False:
        raise HTTPException(
            status_code=400, detail="kill switch may never disable dry_run"
        )


@router.post("/kill-switch")
def kill_switch(body: KillBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    _assert_kill_is_safe(body)
    cfg = request.app.state.config
    thing = cfg.thing_names.get(body.robot_id)
    if not thing:
        raise HTTPException(status_code=400, detail=f"unknown robot {body.robot_id!r}")
    # HARD INVARIANT: only ever the stricter values. Never motion_enabled=true /
    # dry_run=false — the desired dict is hardcoded, never taken from the body.
    desired = {"dry_run": True, "motion_enabled": False}
    payload = json.dumps({"state": {"desired": desired}}).encode("utf-8")
    client = boto3.client(
        "iot-data",
        region_name=cfg.region,
        endpoint_url=f"https://{cfg.iot_endpoint}",
    )
    client.update_thing_shadow(thingName=thing, payload=payload)
    log.warning("kill switch fired", extra={"robot_id": body.robot_id, "thing": thing})
    return {"ok": True, "thing": thing, "desired": desired}


# --- revive (one-way-to-enable) -----------------------------------------
class ReviveBody(BaseModel):
    robot_id: str


@router.post("/revive")
def revive(body: ReviveBody, request: Request, _: bool = Depends(admin_required)) -> dict:
    """Revive re-enables physical motion on a robot: it is the intentional inverse
    of the one-way-to-safe kill switch above.

    HARD INVARIANT: the desired dict is hardcoded (never taken from the body).
    max_speed stays at the project's safe 0.15 m/s cap. Because this re-enables
    real motion it must only be used with a human observer present (project
    safety policy: an unobserved robot = no motion)."""
    cfg = request.app.state.config
    thing = cfg.thing_names.get(body.robot_id)
    if not thing:
        raise HTTPException(status_code=400, detail=f"unknown robot {body.robot_id!r}")
    desired = {"dry_run": False, "motion_enabled": True, "max_speed": 0.15}
    payload = json.dumps({"state": {"desired": desired}}).encode("utf-8")
    client = boto3.client(
        "iot-data",
        region_name=cfg.region,
        endpoint_url=f"https://{cfg.iot_endpoint}",
    )
    client.update_thing_shadow(thingName=thing, payload=payload)
    log.warning("motion revived", extra={"robot_id": body.robot_id, "thing": thing})
    return {"ok": True, "thing": thing, "desired": desired}


# --- virtual-world fleet-wide kill switch (Task 5.2) ----------------------
# Distinct from the per-robot kill switch above (a PHYSICAL robot's IoT device
# shadow desired-state) and from /robot/{robot_id}/command's per-robot `stop`
# (unsupported for a virtual agent -- see world/src/iot/bridge.ts's
# handleCommand, unchanged by this task): this pair freezes/un-freezes the
# WHOLE simulated virtual world (every virtual robot AND the simulated-visitor
# spawner) at once.
#
# Reuses the EXISTING `stop` Command (type="stop", name="stop" -- already
# valid per guidemate_msgs.messages.Command, no schema change) published to
# the FLEET topic via RobotRegistry.send_fleet_command (Task 4.2's fleet
# publish path -- already directly reusable, no plumbing added here). The
# Node world-server's IoT bridge (world/src/iot/bridge.ts's handleFleetStop)
# is what actually calls WorldRoom.pause()/resume() on receipt.
#
# Resume-signal design decision: there is no separate generic "resume"/"go"
# Command type in the shared wire schema (shared/guidemate_msgs), and adding
# one just for this single boolean bit would mean extending the Literal
# unions on both the Python and TypeScript sides. Instead this overloads the
# SAME `type="stop"`/`name="stop"` command's already-free-form `params` dict:
# no `resume` key (see /world/stop) = PAUSE; `params={"resume": True}` (see
# /world/resume) = RESUME. See bridge.ts's handleFleetStop for the receiving
# side of this decision.
#
# One-way-to-safe like /kill-switch: pausing is the default/always-safe
# action any caller can fire; resuming is a SEPARATE explicit route that is
# never triggered as a side effect of any other call.
@router.post("/world/stop")
def world_stop(request: Request, _: bool = Depends(admin_required)) -> dict:
    cmd = Command(type="stop", name="stop")
    acks = request.app.state.registry.send_fleet_command(cmd)
    log.warning("virtual-world fleet stop (pause) fired")
    return {"ok": True, "acks": [a.model_dump() for a in acks]}


@router.post("/world/resume")
def world_resume(request: Request, _: bool = Depends(admin_required)) -> dict:
    cmd = Command(type="stop", name="stop", params={"resume": True})
    acks = request.app.state.registry.send_fleet_command(cmd)
    log.warning("virtual-world fleet resume fired")
    return {"ok": True, "acks": [a.model_dump() for a in acks]}


# SCOPED sim-stop / sim-resume: pause ONLY the ambient simulated visitors (the
# ones that autonomously book guide robots) without freezing the whole world.
# Same `type="stop"`/`name="stop"` command overload as /world/stop above, but
# carrying `params={"scope": "simulated"}` so the world-server's bridge only
# halts the sim spawner and leaves operator-driven guide robots running.
# Resume reuses the same `resume` boolean bit as /world/resume.
@router.post("/world/sim-stop")
def world_sim_stop(request: Request, _: bool = Depends(admin_required)) -> dict:
    cmd = Command(type="stop", name="stop", params={"scope": "simulated"})
    acks = request.app.state.registry.send_fleet_command(cmd)
    log.warning("virtual-world simulated-visitor stop fired")
    return {"ok": True, "acks": [a.model_dump() for a in acks]}


@router.post("/world/sim-resume")
def world_sim_resume(request: Request, _: bool = Depends(admin_required)) -> dict:
    cmd = Command(type="stop", name="stop",
                  params={"scope": "simulated", "resume": True})
    acks = request.app.state.registry.send_fleet_command(cmd)
    log.warning("virtual-world simulated-visitor resume fired")
    return {"ok": True, "acks": [a.model_dump() for a in acks]}


# SCOPED clear-real-visitors: immediately REMOVE every real (guide) visitor
# from the 3D world. Same `type="stop"`/`name="stop"` command overload as the
# sim-stop routes above, but carrying `params={"scope": "clear-real-visitors"}`
# so the world-server clears the operator-driven guide visitors on receipt. This
# is a one-shot bulk removal, not a pause, so there is no paired resume route.
@router.post("/world/clear-visitors")
def world_clear_visitors(request: Request, _: bool = Depends(admin_required)) -> dict:
    cmd = Command(type="stop", name="stop",
                  params={"scope": "clear-real-visitors"})
    acks = request.app.state.registry.send_fleet_command(cmd)
    log.warning("virtual-world clear real (guide) visitors fired")
    return {"ok": True, "acks": [a.model_dump() for a in acks]}


_UNSAFE_KEY_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def _safe_key(filename: Optional[str]) -> str:
    """Reduce a caller-supplied filename/key to a flat, safe S3 key.

    Takes the basename (drops any directory components / traversal), strips
    leading dots and whitespace, and replaces anything outside
    [A-Za-z0-9._-] with "_". Raises HTTP 400 if the input was missing/empty
    or nothing safe remains after normalization.
    """
    if not filename:
        raise HTTPException(status_code=400, detail="invalid filename")
    base = os.path.basename(filename)
    base = base.lstrip(". \t\r\n")
    base = _UNSAFE_KEY_CHARS.sub("_", base)
    if not base:
        raise HTTPException(status_code=400, detail="invalid filename")
    return base


# --- KB management -------------------------------------------------------
# KBManager methods now return dicts ({"ok": bool, "error"?: str}, plus
# "job_id" from start_ingestion; latest_job_status -> {"status": ...}); these
# endpoints consume/passthrough those shapes.
@router.get("/kb")
def kb_list(request: Request, _: bool = Depends(admin_required)) -> dict:
    return {"docs": request.app.state.kb.list_docs()}


@router.post("/kb")
async def kb_upload(
    request: Request,
    file: UploadFile = File(...),
    _: bool = Depends(admin_required),
) -> dict:
    key = _safe_key(file.filename)
    data = await file.read()
    result = request.app.state.kb.upload(key, data)
    return {"key": key, **result}


@router.delete("/kb")
def kb_delete(key: str, request: Request, _: bool = Depends(admin_required)) -> dict:
    safe = _safe_key(key)
    result = request.app.state.kb.delete(safe)
    return {"key": safe, **result}


@router.post("/kb/sync")
def kb_sync(request: Request, _: bool = Depends(admin_required)) -> dict:
    return request.app.state.kb.start_ingestion()


@router.get("/kb/sync-status")
def kb_sync_status(request: Request, _: bool = Depends(admin_required)) -> dict:
    return request.app.state.kb.latest_job_status()


# --- companion requests / sessions / robot-session controls (Task 6) -----
# Paths are RELATIVE to the router's /api/admin prefix (Phase 3). The Phase 4
# brief drafted them under /admin/api/...; the real router already carries the
# prefix, so they resolve as /api/admin/requests, /api/admin/robot/<id>/...,
# etc. All orchestration lives in sessions.*; these routes are thin adapters
# that thread request.app.state.registry through so binds/unbinds fire the
# best-effort assignment undock/dock (whose refusal ack is the Phase 4 evidence).
class _ApproveBody(BaseModel):
    robot_id: str


class _ReassignBody(BaseModel):
    session_id: str


class _RobotCommandBody(BaseModel):
    type: str
    name: str


@router.get("/requests")
def admin_list_requests(_: bool = Depends(admin_required)) -> list:
    return sessions.list_pending_requests()


@router.post("/requests/{request_id}/approve")
def admin_approve(
    request_id: str, body: _ApproveBody, request: Request,
    _: bool = Depends(admin_required),
) -> dict:
    # Binding fires the assignment undock (best-effort; refusal recorded and
    # surfaced by the assign-events route below).
    return sessions.approve_request(
        request_id, body.robot_id, registry=request.app.state.registry
    )


@router.post("/requests/{request_id}/approve-guide")
def admin_approve_guide(
    request_id: str, request: Request, _: bool = Depends(admin_required),
) -> dict:
    # VIRTUAL guide approval: fires the named fleet assign that spawns the visitor
    # and dispatches a guide robot (no physical-robot dropdown -- the world picks
    # the robot). Records the assigned robot on the session for Moses's awareness.
    return sessions.approve_guide_request(
        request_id, registry=request.app.state.registry
    )


@router.post("/requests/{request_id}/deny")
def admin_deny(request_id: str, _: bool = Depends(admin_required)) -> dict:
    sessions.deny_request(request_id)
    return {"ok": True}


@router.get("/sessions")
def admin_list_sessions(_: bool = Depends(admin_required)) -> list:
    return sessions.list_sessions()


@router.get("/sessions/{session_id}/messages")
def admin_session_messages(session_id: str, _: bool = Depends(admin_required)) -> list:
    return sessions.get_messages(session_id)


@router.post("/robot/{robot_id}/abort")
def admin_abort_robot(
    robot_id: str, request: Request, _: bool = Depends(admin_required),
) -> dict:
    # Unassign fires a best-effort dock (refusal recorded).
    return {"freed_session_id": sessions.abort_robot(
        robot_id, registry=request.app.state.registry)}


@router.post("/robot/{robot_id}/reassign")
def admin_reassign_robot(
    robot_id: str, body: _ReassignBody, request: Request,
    _: bool = Depends(admin_required),
) -> dict:
    # Fires dock (old holder) then undock (new holder), both best-effort.
    return {"aborted_session_id": sessions.reassign_robot(
        robot_id, body.session_id, registry=request.app.state.registry)}


@router.post("/session/{session_id}/assign-virtual")
def admin_assign_virtual(
    session_id: str, request: Request, _: bool = Depends(admin_required),
) -> dict:
    # Switch a session to VIRTUAL / navigation mode: release any physical robot
    # it holds (best-effort dock, refusal recorded) and clear the binding. No
    # request body -- the session id is the only input; the session stays active.
    return {"session_id": session_id, "freed_robot_id": sessions.assign_virtual(
        session_id, registry=request.app.state.registry)}


@router.get("/robot/{robot_id}/assign-events")
def admin_assign_events(robot_id: str, _: bool = Depends(admin_required)) -> list:
    """Assignment-triggered undock/dock attempts + their acks/refusals."""
    return sessions.get_assign_events(robot_id)


# --- synthetic autonomy event (Task 6 evidence) ---------------------------
class SyntheticEvent(BaseModel):
    type: str
    battery: Optional[float] = None
    robot_id: Optional[str] = None


@router.post("/synthetic-event")
def synthetic_event(
    payload: SyntheticEvent, request: Request, _: bool = Depends(admin_required)
) -> dict:
    """Inject a fake robot status through the real autonomy path (checklist item 6):
    same `engine.on_status_event` a real heartbeat/offline notification takes."""
    engine = request.app.state.engine
    robot_id = payload.robot_id or engine.default_robot_id or "turtlebot468"
    if payload.type == "low_battery":
        data = {"battery": payload.battery if payload.battery is not None else 0.10}
    elif payload.type == "robot_offline":
        data = {"event": "offline", "robot_id": robot_id}
    else:
        raise HTTPException(status_code=400, detail=f"unknown synthetic event type {payload.type!r}")
    fired = engine.on_status_event({"robot_id": robot_id, "data": data})
    return {"fired": fired, "session_id": engine.session_id}


# --- maps (Task 5: admin Maps tab) ----------------------------------------
# Bytes are streamed through boto3 (app.state.s3, created in app.py's
# lifespan) using the app's own IAM role -- the maps bucket blocks public
# access, so there is no presigned/public URL for the page to fetch instead.
@router.get("/map/{robot_id}")
def get_map(robot_id: str, request: Request, _: bool = Depends(admin_required)) -> Response:
    try:
        png = fetch_map_png(request.app.state.s3, robot_id)
    except Exception:  # noqa: BLE001 -- missing key (or any read failure) -> no map yet
        raise HTTPException(status_code=404, detail="no map uploaded for this robot yet")
    return Response(content=png, media_type="image/png")


@router.get("/map/{robot_id}/meta.json")
def get_map_meta(robot_id: str, request: Request, _: bool = Depends(admin_required)) -> JSONResponse:
    try:
        meta = fetch_map_meta(request.app.state.s3, robot_id)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=404, detail="no map metadata for this robot yet")
    return JSONResponse(meta)


@router.post("/robot/{robot_id}/command")
def admin_robot_command(
    robot_id: str, body: _RobotCommandBody, request: Request,
    _: bool = Depends(admin_required),
) -> dict:
    try:
        cmd = Command(type=body.type, name=body.name)
    except ValidationError:
        # Unknown command shape — synthesize a refusal WITHOUT publishing.
        # (dock/undock DO validate since Task 3's schema change; they are
        # published below and the robot/fake returns the real refusal ack.)
        return {
            "refused": True,
            "acks": [{
                "cmd_id": new_cmd_id(),
                "state": "failed",
                "reason": (f"blocked: {body.type}/{body.name} is not a valid "
                           "command; nothing published"),
            }],
        }
    # dock/undock are Create 3 ROS actions that take 10-60 s; the default 5 s
    # ack window returns mid-action with no terminal ack, so the panel reads a
    # still-docking robot as "nothing happened". Give the slow actions a long
    # window (matches the assignment lifecycle); quick commands keep the short one.
    slow = cmd.type == "motion" and cmd.name in ("undock", "dock")
    acks = request.app.state.registry.send_command(
        robot_id, cmd, timeout_s=75.0 if slow else 5.0
    )
    refused = bool(acks) and acks[-1].state == "failed"
    return {"refused": refused, "acks": [a.model_dump() for a in acks]}
