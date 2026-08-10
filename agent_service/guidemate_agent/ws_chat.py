"""WebSocket chat: /ws/chat/{session_id}. Audio -> Transcribe -> agent -> emote-sync
-> reply + Polly audio, released together. Text messages use the same pipeline.

Session awareness: the turn is run through DogAgent's SESSION-AWARE path
(``chat(text, session_id=...)``), so it gets conversation memory + name greeting,
correct virtual-vs-physical wording, the per-session bound robot (never a hardcoded
id), AND single-owner persistence of both the user + assistant messages. The WS
layer does NOT persist — DogAgent owns it — so there is exactly one user row + one
dog row per turn.

Emote ownership: the WS-path DogAgent is backed by CaptureRegistry so its send_emote
tool 'succeeds' virtually (reply text stays clean) but publishes NOTHING. The real
physical publish + the order-independent release gate live HERE, after the agent turn.
The gate is order-independent AND time-bounded: emote_sync publishes the emote and
waits up to GATE_TIMEOUT_S for ANY running/done ack (AWS IoT QoS1 does not preserve
ack order). If none arrives, it releases anyway (gate_released=False) so a dropped ack
can never wedge the turn — the reply text + audio still ship together. A virtual
(no-robot) session never publishes and never names a robot it isn't bound to.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from guidemate_msgs.messages import Command
from guidemate_msgs.metrics import emit_metric

from guidemate_agent import sessions
from guidemate_agent.emote_sync import emote_sync
from guidemate_agent.speech import (
    TranscribeSession, downsample_pcm16, make_transcribe_session, synthesize_mp3,
)

log = logging.getLogger(__name__)

# Time-bounded release: if no running/done ack lands within this window the turn
# releases anyway (the dropped-ack fallback). Kept short so voice never hangs.
GATE_TIMEOUT_S = 2.0


def _tts_kwargs(config) -> dict:
    """synthesize_mp3 backend kwargs derived from Config (defaults keep Polly)."""
    return {
        "backend": getattr(config, "tts_backend", "polly"),
        "el_voice_id": getattr(config, "elevenlabs_voice_id", ""),
        "el_model": getattr(config, "elevenlabs_tts_model", "eleven_flash_v2_5"),
    }


class CaptureRegistry:
    """Registry stand-in for the WS-path agent: acks 'done' (simulated), never publishes.

    The WS-path DogAgent uses this so its send_emote tool reports success (keeping the
    generated reply text clean) without doing the physical publish — the WS layer owns
    the real publish + the release gate.

    send_fleet_command is different: it backs the guide_to_room tool (Task 4.2),
    which is virtual-fleet-only and has NO separate real-publish step anywhere in
    ws_chat.py the way emote/motion do (there is no post-turn "release gate" for a
    fleet assign). The ack it returns is what tells the visitor which virtual robot
    is coming and is quoted straight into the reply text, so faking it here would
    silently stop the WS chat path from ever dispatching a real virtual robot while
    still sounding like it worked. So this delegates to the real registry (whichever
    one backs app.state.registry — RobotRegistry over real MQTT, or FakeRobotRegistry
    under GUIDEMATE_FAKE_ROBOT=1) when one is wired in via `fleet_registry`, and only
    falls back to a virtual ack (matching send_command's simulated-ack style) when
    none is available, e.g. CaptureRegistry() used bare in a test.
    """

    def __init__(self, fleet_registry=None) -> None:
        self._fleet_registry = fleet_registry

    def send_command(self, robot_id, cmd, timeout_s: float = 5.0, collect_all: bool = False):
        from guidemate_msgs.messages import Ack

        # simulated=False: the WS layer REALLY dispatches captured commands right
        # after the turn, so the model must not narrate "simulation mode" to the
        # user while the robot physically moves (observed live on prod).
        return [Ack(cmd_id=cmd.cmd_id, state="done", simulated=False)]

    def get_status(self, robot_id) -> dict:
        return {"robot_id": robot_id, "presence": "unknown"}

    def send_fleet_command(self, cmd, timeout_s: float = 5.0, collect_all: bool = False):
        if self._fleet_registry is not None:
            return self._fleet_registry.send_fleet_command(
                cmd, timeout_s=timeout_s, collect_all=collect_all
            )
        from guidemate_msgs.messages import Ack

        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True,
                assigned_robot_id="virtual/capture-fallback"),
        ]


def _physical_target(app: FastAPI, session_id: str) -> Optional[str]:
    """Resolve the physical robot bound to this session, or None (virtual/free user).

    Uses the ``app.state.robot_target_resolver`` seam (defaults to the authoritative
    session->robot binding, ``sessions.robot_for_session``; Phase 4 may override it).
    A broken/raising resolver degrades to virtual rather than breaking chat.
    """
    resolver = getattr(app.state, "robot_target_resolver", None)
    if resolver is None:
        return None
    try:
        return resolver(session_id)
    except Exception:  # noqa: BLE001 — a broken resolver must not break chat
        log.exception("robot_target_resolver raised; falling back to virtual")
        return None


async def _send_stop(ws: WebSocket, app: FastAPI, session_id: str) -> None:
    """User-facing persistent Stop: forward a real stop Command to the session's
    bound robot. This is the SAME mechanism the agent's ``stop`` tool uses
    (``Command(type="stop", name="stop")`` through the registry). A virtual /
    unbound session has no robot to stop, so we ack ``sent=False`` rather than
    naming or touching a robot the user isn't bound to.
    """
    target = _physical_target(app, session_id)
    if target is None:
        await ws.send_json({"type": "stopped", "sent": False})
        return
    registry = app.state.registry
    loop = asyncio.get_running_loop()
    try:
        cmd = Command(type="stop", name="stop")
        await loop.run_in_executor(None, lambda: registry.send_command(target, cmd))
        await ws.send_json({"type": "stopped", "sent": True, "robot_id": target})
    except Exception:  # noqa: BLE001 — a failed stop must not kill the socket
        log.exception("stop command failed")
        await ws.send_json({"type": "error", "message": "couldn't send the stop — try again"})


async def _safe_finish(transcribe: TranscribeSession) -> None:
    """Close a Transcribe stream without letting a teardown error escape."""
    try:
        await transcribe.finish()
    except Exception:  # noqa: BLE001 — teardown is best-effort
        log.exception("transcribe finish failed")


async def _run_pipeline(ws: WebSocket, app: FastAPI, session_id: str, text: str) -> None:
    obs = getattr(app.state, "observability", None)
    agent = app.state.ws_agent
    registry = app.state.registry
    region = getattr(app.state.config, "region", "us-west-2")
    turn_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()

    try:
        target = _physical_target(app, session_id)
        # Keep this session's virtual-world avatar alive while the chat is active
        # (best-effort, no-op unless a visitor is bound; never raises). Same shared
        # sessions.keepalive_visitor the HTTP /api/chat path calls, so both paths refresh it.
        sessions.keepalive_visitor(session_id, registry)
        t0 = time.monotonic()
        # Session-aware turn: DogAgent resolves name/history + virtual-vs-physical
        # framing + the per-session bound robot (never a hardcoded id), and persists
        # BOTH the user + assistant messages itself (single persistence owner — the
        # WS layer deliberately does not persist, so there is one user + one dog row).
        result = await loop.run_in_executor(
            None, lambda: agent.chat(text, session_id=session_id)
        )
        turn_ms = (time.monotonic() - t0) * 1000.0
        if obs is not None:
            obs.record_latency(turn_id, turn_ms, session_id)
        # Best-effort CloudWatch turn metric (EMF log line); never crashes the turn.
        try:
            emit_metric("WsTurnLatencyMs", turn_ms, "Milliseconds")
        except Exception:  # noqa: BLE001 — telemetry is best-effort
            log.exception("emit_metric failed")

        emote = result.get("emote")
        released = True
        if emote:
            cmd = Command(type="emote", name=emote)
            sent = time.monotonic()
            # When the turn ALSO ran a motion trick, the emote animates the avatar
            # only — publishing it would make the robot wiggle before/over the
            # requested trick (observed live: "spin" -> wiggle then spin). Passing
            # target=None keeps the release gate semantics but publishes nothing.
            ran_motion = any(
                s.get("type") == "motion" for s in result.get("commands") or []
            )
            emote_target = None if ran_motion else target
            # Order-independent, time-bounded release gate. target is None for a
            # virtual session -> emote_sync returns (True, []) and publishes nothing.
            released, acks = await loop.run_in_executor(
                None, lambda: emote_sync(registry, emote_target, cmd, GATE_TIMEOUT_S)
            )
            if obs is not None and emote_target is not None:
                obs.record_command(turn_id, emote_target, cmd.cmd_id, sent, acks)

        # Release reply text + audio TOGETHER, once the gate is satisfied (or timed out).
        # `sources` carries the KB citations for a grounded turn (title = the KB doc
        # key, e.g. "moses-facts.md"; url is null unless a real link exists). It is
        # an empty list for a turn that used no KB, so the frontend can rely on the
        # field always being present. Does not disturb the existing reply fields.
        await ws.send_json({
            "type": "reply",
            "text": result["reply_text"],
            "emote": emote,
            "gate_released": released,
            "turn_id": turn_id,
            "sources": result.get("sources", []),
        })
        # SINGLE physical-command dispatch: every command the agent ran this turn
        # (tricks, stop, future tools) is captured on result["commands"] and
        # forwarded to the real robot HERE, in order — the WS-path agent runs on
        # a non-publishing CaptureRegistry, so this loop is the one place chat
        # motion reaches hardware. (Emote is separate: its release gate above.)
        # Runs AFTER the reply frame (user sees the response first) but BEFORE
        # TTS: the robot reacts promptly, and an early socket close can no longer
        # cancel the dispatch mid-sequence. Short ack wait keeps voice latency low.
        if target is not None:
            for spec in result.get("commands") or []:
                try:
                    phys_cmd = Command(type=spec["type"], name=spec["name"],
                                       params=spec.get("params") or {})
                    acks = await loop.run_in_executor(
                        None,
                        lambda c=phys_cmd: registry.send_command(target, c, timeout_s=1.0),
                    )
                    if obs is not None:
                        obs.record_command(turn_id, target, phys_cmd.cmd_id, time.monotonic(), acks)
                except Exception as exc:  # noqa: BLE001 — one failed command must not kill the socket
                    log.exception("physical command publish failed: %s", spec)
                    if obs is not None:
                        obs.record_error("motion", str(exc), turn_id)

        try:
            mp3 = await loop.run_in_executor(
                None,
                lambda: synthesize_mp3(
                    result["reply_text"], region=region,
                    el_client=getattr(app.state, "el_client", None),
                    **_tts_kwargs(app.state.config),
                ),
            )
            await ws.send_json({
                "type": "audio",
                "format": "mp3",
                "b64": base64.b64encode(mp3).decode("ascii"),
            })
        except Exception as exc:  # noqa: BLE001 — audio is best-effort
            log.exception("tts failed")
            if obs is not None:
                obs.record_error("tts", str(exc), turn_id)

    except Exception as exc:  # noqa: BLE001 — never kill the socket on one bad turn
        log.exception("chat pipeline failed")
        if obs is not None:
            obs.record_error("pipeline", str(exc), turn_id)
        await ws.send_json({"type": "error", "message": "sorry, I got a little confused"})


def register(app: FastAPI) -> None:
    @app.websocket("/ws/chat/{session_id}")
    async def chat_ws(ws: WebSocket, session_id: str) -> None:  # noqa: WPS430
        await ws.accept()
        region = getattr(app.state.config, "region", "us-west-2")
        transcribe: Optional[TranscribeSession] = None
        declared_rate = 16000
        try:
            while True:
                try:
                    msg = await ws.receive()
                except WebSocketDisconnect:
                    break
                if msg["type"] == "websocket.disconnect":
                    break
                # Per-message guard: a malformed JSON frame, a bad declared
                # sample_rate (downsample_pcm16 raises), or any other one-off
                # error must NOT kill the socket — reply with an error frame,
                # log it, and keep serving the next message.
                try:
                    if msg.get("text") is not None:
                        data = json.loads(msg["text"])
                        mtype = data.get("type")
                        if mtype == "start_audio":
                            # Guard: a second start_audio without an intervening
                            # stop_audio would leak the prior Transcribe stream.
                            if transcribe is not None:
                                await _safe_finish(transcribe)
                                transcribe = None
                            declared_rate = int(data.get("sample_rate", 16000))
                            cfg = app.state.config
                            transcribe = make_transcribe_session(
                                backend=getattr(cfg, "stt_backend", "transcribe"),
                                region=region, sample_rate=16000,
                                api_key=getattr(cfg, "elevenlabs_api_key", ""),
                                model_id=getattr(
                                    cfg, "elevenlabs_stt_model", "scribe_v2_realtime"
                                ),
                            )
                            await transcribe.start()
                        elif mtype == "stop_audio":
                            text = await transcribe.finish() if transcribe else ""
                            transcribe = None
                            await ws.send_json({"type": "transcript", "text": text})
                            if text.strip():
                                await _run_pipeline(ws, app, session_id, text)
                        elif mtype == "text":
                            text = (data.get("message") or "").strip()
                            if text:
                                await _run_pipeline(ws, app, session_id, text)
                        elif mtype == "stop":
                            # Persistent user-facing Stop -> real stop Command to
                            # the bound robot (no agent turn / no Bedrock).
                            await _send_stop(ws, app, session_id)
                    elif msg.get("bytes") is not None and transcribe is not None:
                        pcm = msg["bytes"]
                        if declared_rate != 16000:
                            pcm = downsample_pcm16(pcm, declared_rate, 16000)
                        await transcribe.feed(pcm)
                except WebSocketDisconnect:
                    break
                except Exception:  # noqa: BLE001 — one bad frame must not kill the socket
                    log.exception("ws message handling failed")
                    try:
                        await ws.send_json(
                            {"type": "error", "message": "sorry, I couldn't handle that"}
                        )
                    except Exception:  # noqa: BLE001 — socket is already gone
                        break
        finally:
            if transcribe is not None:
                await _safe_finish(transcribe)
