"""Classic Device Shadow reconcile over the existing IotClient connection.

Plain MQTT on the reserved $aws shadow topics — no extra SDK layer. Missing
shadow, rejected get, or timeout all leave the defaults LOCKED
(motion_enabled=False, max_speed=0.15, dry_run=True).

Shadow sync is OPT-IN (``enabled``, wired to GUIDEMATE_SHADOW in the bridge).
A policy-DENIED shadow SUBSCRIBE is NOT a catchable SUBACK error: AWS IoT
responds to an unauthorized subscribe by dropping the whole MQTT connection
(UNEXPECTED_HANGUP), the SUBACK never arrives, and awscrt then replays the
pending subscribe on every auto-reconnect — permanently poisoning the shared
connection and taking the mandatory command subscription down with it. There is
no post-hoc recovery: the attempt itself is fatal. So shadow must only ever be
attempted where the cert is authorized for it (production). Where it is not
(the dev cert / integration test), leave it disabled; defaults stay locked,
which is the fail-safe state anyway.
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
_DISABLED_MSG = "shadow sync disabled (GUIDEMATE_SHADOW not truthy) — " + _LOCKED_MSG


def shadow_topic(thing_name: str, suffix: str) -> str:
    return f"$aws/things/{thing_name}/shadow/{suffix}"


class ShadowSync:
    def __init__(
        self,
        client: IotClient,
        thing_name: str,
        safety: SafetyState,
        get_timeout_s: float = 5.0,
        enabled: bool = True,
    ) -> None:
        self._client = client
        self._thing = thing_name
        self._safety = safety
        self._get_timeout_s = get_timeout_s
        self._enabled = enabled
        self._got = threading.Event()
        self._subscribed = False

    def start(self) -> None:
        if not self._enabled:
            # Never touch shadow topics when disabled: a denied subscribe drops the
            # whole connection (see module docstring), so this is the ONLY safe path
            # for a cert that isn't authorized for the thing's shadow. Defaults stay
            # locked, which is the fail-safe state.
            log.info(_DISABLED_MSG)
            return
        try:
            self._client.subscribe(shadow_topic(self._thing, "get/accepted"), self._on_get_accepted)
            self._client.subscribe(shadow_topic(self._thing, "get/rejected"), self._on_get_rejected)
            self._client.subscribe(shadow_topic(self._thing, "update/delta"), self._on_delta)
            self._client.subscribe(shadow_topic(self._thing, "update/accepted"), self._on_update_accepted)
            # FUTURE OBSERVABILITY: we deliberately do NOT subscribe to update/rejected.
            # A rejected reported update is currently only visible via the async publish()
            # puback warn-log; wiring update/rejected would surface the AWS reason string.
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
        except (json.JSONDecodeError, AttributeError, TypeError):
            # Bad JSON, or valid-but-non-object JSON (null/number/list -> no .get).
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
        except (json.JSONDecodeError, AttributeError, TypeError):
            # Bad JSON, or valid-but-non-object JSON (null/number/list -> no .get).
            log.warning("unparseable shadow delta ignored")
            return
        self._safety.apply_shadow(delta)
        log.info("shadow delta applied: %s -> gates %s",
                 sorted(delta.keys()), self._safety.gates())
        self.publish_reported()

    def _on_update_accepted(self, topic: str, payload: str) -> None:
        log.debug("shadow update accepted")

    def publish_reported(self, sync: bool = False) -> None:
        if not self._subscribed:
            return  # never touch shadow topics if we couldn't subscribe (see start())
        reported = self._safety.reported()  # already a fresh dict — no copy needed
        reported["bridge_version"] = BRIDGE_VERSION
        reported["uptime_s"] = round(self._safety.uptime_s(), 1)
        topic = shadow_topic(self._thing, "update")
        payload = json.dumps({"state": {"reported": reported}})
        if sync:
            # Shutdown path (main thread): block on the puback so the final reported
            # lands before a clean disconnect. Never set sync=True from a callback.
            self._client.publish_sync(topic, payload)
        else:
            self._client.publish(topic, payload)
