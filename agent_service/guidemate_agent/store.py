"""DynamoDB-backed config store for the dog agent (guidemate-config table).

Phase 3 uses ONLY guidemate-config, holding two items:
  {pk: "flags", <flag booleans>}   — agent-tier feature flags
  {pk: "prompt", system_prompt: str}  — admin-set system prompt (absent => built-in persona)
A short in-process TTL cache keeps per-turn flag reads from hammering DynamoDB.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

import boto3

# Canonical flag set. All permissive except dog_muted. Single source of truth
# for the agent (tool/persona gating) and the admin API (validation).
DEFAULT_FLAGS = {
    "dog_muted": False,
    "emotes_enabled": True,
    "motion_tools_enabled": True,
    "persona_enabled": True,
    "kb_enabled": True,
}


class ConfigStore:
    def __init__(
        self,
        table=None,
        table_name: str = "guidemate-config",
        ttl_s: float = 5.0,
        region: Optional[str] = None,
    ) -> None:
        if table is None:
            region = region or os.environ.get("AWS_REGION", "us-west-2")
            table = boto3.resource("dynamodb", region_name=region).Table(table_name)
        self._table = table
        self._ttl_s = ttl_s
        self._cache: dict[str, tuple[float, Optional[dict]]] = {}
        self._lock = threading.Lock()

    # --- low-level item access -------------------------------------------
    def _read_item(self, pk: str) -> Optional[dict]:
        resp = self._table.get_item(Key={"pk": pk})
        return resp.get("Item")

    def _get_cached(self, pk: str) -> Optional[dict]:
        now = time.monotonic()
        with self._lock:
            entry = self._cache.get(pk)
            if entry is not None and entry[0] > now:
                return entry[1]
        item = self._read_item(pk)
        with self._lock:
            self._cache[pk] = (now + self._ttl_s, item)
        return item

    def _invalidate(self, pk: str) -> None:
        with self._lock:
            self._cache.pop(pk, None)

    # --- flags ------------------------------------------------------------
    def get_flags(self) -> dict:
        item = self._get_cached("flags") or {}
        flags = dict(DEFAULT_FLAGS)
        for key in DEFAULT_FLAGS:
            if key in item and isinstance(item[key], bool):
                flags[key] = item[key]
        return flags

    def set_flag(self, name: str, value: bool) -> None:
        if name not in DEFAULT_FLAGS:
            raise ValueError(f"unknown flag {name!r}; valid flags: {sorted(DEFAULT_FLAGS)}")
        item = self._read_item("flags") or {}
        item["pk"] = "flags"
        item[name] = bool(value)
        self._table.put_item(Item=item)
        self._invalidate("flags")

    # --- admin-set prompt -------------------------------------------------
    def get_prompt(self) -> Optional[str]:
        item = self._get_cached("prompt") or {}
        value = item.get("system_prompt")
        return value if value else None

    def set_prompt(self, value: Optional[str]) -> None:
        item = {"pk": "prompt"}
        if value and value.strip():
            item["system_prompt"] = value
        self._table.put_item(Item=item)
        self._invalidate("prompt")
