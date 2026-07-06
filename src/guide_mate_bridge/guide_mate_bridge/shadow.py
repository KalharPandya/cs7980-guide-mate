"""Classic Device Shadow reconcile over the existing IotClient connection.

Plain MQTT on the reserved $aws shadow topics — no extra SDK layer. Missing
shadow, rejected get, timeout, or denied subscription all leave the defaults
LOCKED (motion_enabled=False, max_speed=0.15, dry_run=True).
"""
from __future__ import annotations

import json
import logging
import threading

from guide_mate_bridge import BRIDGE_VERSION
from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)

_LOCKED_MSG = "DEFAULTS LOCKED (motion_enabled=False, max_speed=0.15, dry_run=True)"


def shadow_topic(thing_name: str, suffix: str) -> str:
    return f"$aws/things/{thing_name}/shadow/{suffix}"


class ShadowSync:
    def __init__(
        self,
        client: IotClient,
        thing_name: str,
        safety: SafetyState,
        get_timeout_s: float = 5.0,
    ) -> None:
        self._client = client
        self._thing = thing_name
        self._safety = safety
        self._get_timeout_s = get_timeout_s
        self._got = threading.Event()
        self._subscribed = False

    def start(self) -> None:
        try:
            self._client.subscribe(shadow_topic(self._thing, "get/accepted"), self._on_get_accepted)
            self._client.subscribe(shadow_topic(self._thing, "get/rejected"), self._on_get_rejected)
            self._client.subscribe(shadow_topic(self._thing, "update/delta"), self._on_delta)
            self._client.subscribe(shadow_topic(self._thing, "update/accepted"), self._on_update_accepted)
        except Exception as exc:  # noqa: BLE001 — e.g. policy-denied SUBACK (dev cert)
            # Do NOT publish to shadow topics after a denial: AWS IoT drops the whole
            # connection on an unauthorized publish, which would wedge the bridge.
            log.warning("shadow topics unavailable (%s) — %s", exc, _LOCKED_MSG)
            return
        self._subscribed = True
        self._client.publish(shadow_topic(self._thing, "get"), "")
        if not self._got.wait(self._get_timeout_s):
            log.warning("shadow get timed out — %s", _LOCKED_MSG)
        self.publish_reported()

    def _on_get_accepted(self, topic: str, payload: str) -> None:
        try:
            desired = json.loads(payload).get("state", {}).get("desired") or {}
        except json.JSONDecodeError:
            log.warning("unparseable shadow get/accepted — %s", _LOCKED_MSG)
            self._got.set()
            return
        self._safety.apply_shadow(desired)
        log.info("shadow reconciled: desired keys %s -> gates %s",
                 sorted(desired.keys()), self._safety.gates())
        self._got.set()

    def _on_get_rejected(self, topic: str, payload: str) -> None:
        log.warning("shadow get rejected (%s) — %s", payload, _LOCKED_MSG)
        self._got.set()

    def _on_delta(self, topic: str, payload: str) -> None:
        try:
            delta = json.loads(payload).get("state") or {}
        except json.JSONDecodeError:
            log.warning("unparseable shadow delta ignored")
            return
        self._safety.apply_shadow(delta)
        log.info("shadow delta applied: %s -> gates %s",
                 sorted(delta.keys()), self._safety.gates())
        self.publish_reported()

    def _on_update_accepted(self, topic: str, payload: str) -> None:
        log.debug("shadow update accepted")

    def publish_reported(self) -> None:
        if not self._subscribed:
            return  # never touch shadow topics if we couldn't subscribe (see start())
        reported = dict(self._safety.reported())
        reported["bridge_version"] = BRIDGE_VERSION
        reported["uptime_s"] = round(self._safety.uptime_s(), 1)
        self._client.publish(
            shadow_topic(self._thing, "update"),
            json.dumps({"state": {"reported": reported}}),
        )
