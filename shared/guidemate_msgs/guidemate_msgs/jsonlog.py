"""Shared structured JSON logging + correlation IDs (used by service AND bridge)."""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

# LogRecord attributes we never copy into the JSON payload.
_RESERVED = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "taskName", "message",
}


class JsonFormatter(logging.Formatter):
    def __init__(self, component: str) -> None:
        super().__init__()
        self._component = component

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "component": self._component,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup(component: str, level: int = logging.INFO) -> logging.Logger:
    """Install a single JSON handler on the root logger (idempotent)."""
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(component))
    root.addHandler(handler)
    return root


def log_extra(**ids) -> dict:
    """Return a dict for logging's `extra=` kwarg, dropping None values."""
    return {key: value for key, value in ids.items() if value is not None}
