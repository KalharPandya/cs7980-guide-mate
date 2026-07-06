"""In-process observability ring buffers for the admin Health tab. No CloudWatch
dependency — these are log-derived, bounded deques readable via /admin/api/health."""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ack_field(ack, key, default=None):
    """Read a field off an Ack whether or not Phase 2 has added it yet."""
    if hasattr(ack, "model_dump"):
        return ack.model_dump().get(key, default)
    if isinstance(ack, dict):
        return ack.get(key, default)
    return getattr(ack, key, default)


class Observability:
    def __init__(self, max_commands: int = 10, max_latency: int = 50, max_errors: int = 50) -> None:
        self._lock = threading.Lock()
        self._commands: deque = deque(maxlen=max_commands)
        self._latencies: deque = deque(maxlen=max_latency)
        self._errors: deque = deque(maxlen=max_errors)

    def record_command(self, turn_id, robot_id, cmd_id, sent_monotonic: float, acks) -> None:
        elapsed_ms = round((time.monotonic() - sent_monotonic) * 1000.0, 1)
        gates = _ack_field(acks[-1], "gates") if acks else None
        rec = {
            "turn_id": turn_id,
            "robot_id": robot_id,
            "cmd_id": cmd_id,
            "ts": _now_iso(),
            "total_ms": elapsed_ms,
            "states": [_ack_field(a, "state") for a in acks],
            "gates": gates,
            "simulated": any(bool(_ack_field(a, "simulated")) for a in acks),
        }
        with self._lock:
            self._commands.appendleft(rec)

    def record_latency(self, turn_id, bedrock_ms: float, session_id: Optional[str]) -> None:
        with self._lock:
            self._latencies.appendleft({
                "turn_id": turn_id,
                "bedrock_ms": round(bedrock_ms, 1),
                "session_id": session_id,
                "ts": _now_iso(),
            })

    def record_error(self, where: str, message: str, turn_id: Optional[str] = None) -> None:
        with self._lock:
            self._errors.appendleft({
                "where": where,
                "message": str(message)[:500],
                "turn_id": turn_id,
                "ts": _now_iso(),
            })

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "commands": list(self._commands),
                "latencies": list(self._latencies),
                "errors": list(self._errors),
            }
