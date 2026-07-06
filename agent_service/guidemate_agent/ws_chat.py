"""WebSocket chat: /ws/chat/{session_id}. Audio -> Transcribe -> agent -> emote-sync
-> reply + Polly audio, released together. Text messages use the same pipeline.

Emote ownership: the WS-path DogAgent is backed by CaptureRegistry so its send_emote
tool 'succeeds' virtually (reply text stays clean) but publishes NOTHING. The real
physical publish + the order-independent release gate live HERE, after the agent turn,
per the Phase-5 emote-sync decision.

The gate is order-independent AND time-bounded: emote_sync publishes the emote and
waits up to `timeout_s` for ANY running/done ack (AWS IoT QoS1 does not preserve ack
order). If none arrives, it releases anyway (gate_released=False) so a dropped ack can
never wedge the turn — the reply text + audio still ship together.
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
from guidemate_agent.speech import TranscribeSession, downsample_pcm16, synthesize_mp3

log = logging.getLogger(__name__)

# Time-bounded release: if no running/done ack lands within this window the turn
# releases anyway (the dropped-ack fallback). Kept short so voice never hangs.
GATE_TIMEOUT_S = 2.0


class CaptureRegistry:
    """Registry stand-in for the WS-path agent: acks 'done' (simulated), never publishes.

    The WS-path DogAgent uses this so its send_emote tool reports success (keeping the
    generated reply text clean) without doing the physical publish — the WS layer owns
    the real publish + the release gate.
    """

    def send_command(self, robot_id, cmd, timeout_s: float = 5.0, collect_all: bool = False):
        from guidemate_msgs.messages import Ack

        return [Ack(cmd_id=cmd.cmd_id, state="done", simulated=True)]

    def get_status(self, robot_id) -> dict:
        return {"robot_id": robot_id, "presence": "unknown"}


def _physical_target(app: FastAPI, session_id: str) -> Optional[str]:
    """Resolve the physical robot bound to this session, or None (virtual/free user).

    Uses the `app.state.robot_target_resolver` seam (Phase 4 installs a real
    session->robot resolver; the default is virtual-only). A broken/raising
    resolver degrades to virtual rather than breaking chat.
    """
    resolver = getattr(app.state, "robot_target_resolver", None)
    if resolver is None:
        return None
    try:
        return resolver(session_id)
    except Exception:  # noqa: BLE001 — a broken resolver must not break chat
        log.exception("robot_target_resolver raised; falling back to virtual")
        return None


def _persist(session_id: str, user_text: Optional[str], reply_text: str,
             obs, turn_id: str) -> None:
    """Best-effort persist of the user utterance + assistant reply.

    Never load-bearing: a DynamoDB hiccup (or the offline unit-test fake raising)
    must not kill the turn — the reply + audio have already been produced.
    """
    try:
        if user_text:
            sessions.append_message(session_id, "user", user_text)
        sessions.append_message(session_id, "dog", reply_text)
    except Exception as exc:  # noqa: BLE001 — persistence is best-effort
        log.exception("message persist failed")
        if obs is not None:
            obs.record_error("persist", str(exc), turn_id)


async def _run_pipeline(ws: WebSocket, app: FastAPI, session_id: str, text: str) -> None:
    obs = getattr(app.state, "observability", None)
    agent = app.state.ws_agent
    registry = app.state.registry
    region = getattr(app.state.config, "region", "us-west-2")
    turn_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()

    try:
        target = _physical_target(app, session_id)
        t0 = time.monotonic()
        # Agent turn runs in a worker thread — DogAgent.chat() is sync/blocking
        # (Bedrock + tool calls) and must not stall the event loop.
        result = await loop.run_in_executor(None, lambda: agent.chat(text, robot_id=target))
        turn_ms = (time.monotonic() - t0) * 1000.0
        if obs is not None:
            obs.record_latency(turn_id, turn_ms, session_id)
        # Best-effort CloudWatch turn metric (EMF log line); never crashes the turn.
        try:
            emit_metric("WsTurnLatencyMs", turn_ms, "Milliseconds")
        except Exception:  # noqa: BLE001 — telemetry is best-effort
            log.exception("emit_metric failed")

        # Persist both messages (best-effort). Done regardless of robot binding —
        # every WS session has a session_id, virtual or robot-bound.
        _persist(session_id, text, result["reply_text"], obs, turn_id)

        emote = result.get("emote")
        released = True
        if emote:
            cmd = Command(type="emote", name=emote)
            sent = time.monotonic()
            # Order-independent, time-bounded release gate. target is None for a
            # virtual session -> emote_sync returns (True, []) and publishes nothing.
            released, acks = await loop.run_in_executor(
                None, lambda: emote_sync(registry, target, cmd, GATE_TIMEOUT_S)
            )
            if obs is not None and target is not None:
                obs.record_command(turn_id, target, cmd.cmd_id, sent, acks)

        # Release reply text + audio TOGETHER, once the gate is satisfied (or timed out).
        await ws.send_json({
            "type": "reply",
            "text": result["reply_text"],
            "emote": emote,
            "gate_released": released,
            "turn_id": turn_id,
        })
        try:
            mp3 = await loop.run_in_executor(
                None, lambda: synthesize_mp3(result["reply_text"], region=region)
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
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("text") is not None:
                    data = json.loads(msg["text"])
                    mtype = data.get("type")
                    if mtype == "start_audio":
                        declared_rate = int(data.get("sample_rate", 16000))
                        transcribe = TranscribeSession(region=region, sample_rate=16000)
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
                elif msg.get("bytes") is not None and transcribe is not None:
                    pcm = msg["bytes"]
                    if declared_rate != 16000:
                        pcm = downsample_pcm16(pcm, declared_rate, 16000)
                    await transcribe.feed(pcm)
        except WebSocketDisconnect:
            pass
        finally:
            if transcribe is not None:
                try:
                    await transcribe.finish()
                except Exception:  # noqa: BLE001
                    pass
