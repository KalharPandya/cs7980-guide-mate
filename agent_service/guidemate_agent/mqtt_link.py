"""Service-side MQTT-over-WebSocket link + first-class multi-robot registry."""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

import boto3
from awscrt import auth, mqtt
from awsiot import mqtt_connection_builder

from guidemate_msgs.messages import Ack, Command, cmd_topic, fleet_cmd_topic

log = logging.getLogger(__name__)


@dataclass
class RobotState:
    robot_id: str
    presence: str = "unknown"          # online | offline | unknown
    last_status: Optional[dict] = None
    last_ack: Optional[dict] = None
    last_heartbeat: Optional[dict] = None


def _credentials_provider(region: str):
    """AwsCredentialsProvider that refetches frozen boto3 creds on each signing call."""
    boto_creds = boto3.Session().get_credentials()
    if boto_creds is None:
        raise RuntimeError("no AWS credentials available for IoT WebSocket signing")

    def _fetch():
        frozen = boto_creds.get_frozen_credentials()
        return auth.AwsCredentials(frozen.access_key, frozen.secret_key, frozen.token)

    if hasattr(auth.AwsCredentialsProvider, "new_delegate"):
        return auth.AwsCredentialsProvider.new_delegate(_fetch)
    # Fallback: static provider from a one-shot freeze (documented in the plan).
    frozen = boto_creds.get_frozen_credentials()
    return auth.AwsCredentialsProvider.new_static(
        access_key_id=frozen.access_key,
        secret_access_key=frozen.secret_key,
        session_token=frozen.token,
    )


class RobotRegistry:
    def __init__(
        self,
        endpoint: str,
        region: str,
        robot_ids: list[str],
        client_id_prefix: str = "guidemate-svc",
        connection=None,
    ) -> None:
        self._endpoint = endpoint
        self._region = region
        self._robots = {rid: RobotState(robot_id=rid) for rid in robot_ids}
        self._client_id = f"{client_id_prefix}-{uuid.uuid4().hex[:8]}"
        self._lock = threading.Lock()
        self._waiters: dict[str, tuple[threading.Event, list[Ack]]] = {}
        self._conn = connection
        self._event_callbacks: list[Callable[[dict], None]] = []

    def on_event(self, callback: Callable[[dict], None]) -> None:
        """Register a callback fired once per parsed status message: {"robot_id", "data"}."""
        with self._lock:
            self._event_callbacks.append(callback)

    def _dispatch_event(self, event: dict) -> None:
        with self._lock:
            callbacks = list(self._event_callbacks)
        for cb in callbacks:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 — one bad callback must not stall the MQTT thread
                log.exception("on_event callback failed")

    @property
    def is_connected(self) -> bool:
        """Cheap readiness signal for /readyz: True once connect() has built
        (and not torn down) the underlying MQTT connection. Doesn't ping the
        broker — just reflects whether connect() succeeded."""
        return self._conn is not None

    def _build_connection(self):
        return mqtt_connection_builder.websockets_with_default_aws_signing(
            endpoint=self._endpoint,
            region=self._region,
            credentials_provider=_credentials_provider(self._region),
            client_id=self._client_id,
        )

    def connect(self) -> None:
        if self._conn is None:
            self._conn = self._build_connection()
        self._conn.connect().result()
        future, _ = self._conn.subscribe(
            topic="guidemate/+/status",
            qos=mqtt.QoS.AT_LEAST_ONCE,
            callback=self._on_status,
        )
        future.result()
        # Virtual-fleet robot ids are namespaced "virtual/<n>" (two path segments), so
        # "guidemate/+/status" (a single-level wildcard) never matches them --
        # "guidemate/virtual/<n>/status" is a 4-segment topic. This second subscription
        # covers both per-virtual-robot status AND the fleet-scoped pseudo-robot status
        # (guidemate/virtual/fleet/status, Task 4.2's "assign" acks), routed through the
        # same _on_status handler (see its updated robot_id parsing below).
        future2, _ = self._conn.subscribe(
            topic="guidemate/virtual/+/status",
            qos=mqtt.QoS.AT_LEAST_ONCE,
            callback=self._on_status,
        )
        future2.result()

    def _on_status(self, topic, payload, dup, qos, retain, **kwargs):
        try:
            data = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log.warning("undecodable status payload on %s", topic)
            return
        parts = topic.split("/")
        # robot_id is everything between the leading "guidemate" segment and the
        # trailing "status" segment: a single segment for a physical robot
        # ("turtlebot468"), two for a virtual one ("virtual/1") or the fleet
        # pseudo-robot ("virtual/fleet"). Joining (not indexing parts[1]) is what makes
        # this correct for both without a virtual-specific special case.
        robot_id = "/".join(parts[1:-1]) if len(parts) >= 3 else "?"
        self._dispatch_event({"robot_id": robot_id, "data": data})
        with self._lock:
            state = self._robots.setdefault(robot_id, RobotState(robot_id=robot_id))
            event = data.get("event")
            if event in ("online", "offline"):
                state.presence = event
                state.last_status = data
                return
            if event == "heartbeat":
                state.presence = "online"  # a heartbeat proves liveness
                state.last_heartbeat = data
                state.last_status = data
                return
            state.last_ack = data
            state.last_status = data
            cmd_id = data.get("cmd_id")
            waiter = self._waiters.get(cmd_id) if cmd_id else None
        if waiter is None:
            return
        event, acks = waiter
        try:
            acks.append(Ack.model_validate(data))
        except Exception:  # noqa: BLE001
            return
        if data.get("state") in ("done", "failed"):
            event.set()

    def send_command(
        self,
        robot_id: str,
        cmd: Command,
        timeout_s: float = 5.0,
        collect_all: bool = False,
    ) -> list[Ack]:
        """Publish a command and collect its acks.

        collect_all=False: return as soon as a terminal (done/failed) ack lands,
        or at timeout. collect_all=True: wait the FULL timeout and return every
        ack collected — AWS IoT QoS1 acks can arrive out of order ('done' before
        'running'), so early return can drop trailing acks (Phase-5 groundwork).
        """
        if self._conn is None:
            log.warning("send_command(%s) with no MQTT connection — robot unreachable", robot_id)
            return []
        event = threading.Event()
        acks: list[Ack] = []
        with self._lock:
            self._waiters[cmd.cmd_id] = (event, acks)
        try:
            self._conn.publish(
                topic=cmd_topic(robot_id),
                payload=cmd.model_dump_json().encode("utf-8"),
                qos=mqtt.QoS.AT_LEAST_ONCE,
            )
            if collect_all:
                time.sleep(timeout_s)
            else:
                event.wait(timeout_s)
        finally:
            with self._lock:
                self._waiters.pop(cmd.cmd_id, None)
        return list(acks)

    def send_fleet_command(
        self,
        cmd: Command,
        timeout_s: float = 5.0,
        collect_all: bool = False,
    ) -> list[Ack]:
        """Publish a fleet-scoped command (e.g. "assign") to `fleet_cmd_topic()` and
        collect its acks from `fleet_status_topic()` -- the fleet-command mirror of
        `send_command`, sharing the same connection, `_waiters` dict, and `_on_status`
        callback (registered on `guidemate/virtual/+/status` in `connect()`, which
        covers the fleet pseudo-robot "virtual/fleet") instead of duplicating any of
        that MQTT plumbing. Unlike a per-robot command, there is no `robot_id` to
        address -- nobody knows which robot will be picked until the ack comes back.
        """
        if self._conn is None:
            log.warning("send_fleet_command(%s) with no MQTT connection", cmd.type)
            return []
        event = threading.Event()
        acks: list[Ack] = []
        with self._lock:
            self._waiters[cmd.cmd_id] = (event, acks)
        try:
            self._conn.publish(
                topic=fleet_cmd_topic(),
                payload=cmd.model_dump_json().encode("utf-8"),
                qos=mqtt.QoS.AT_LEAST_ONCE,
            )
            if collect_all:
                time.sleep(timeout_s)
            else:
                event.wait(timeout_s)
        finally:
            with self._lock:
                self._waiters.pop(cmd.cmd_id, None)
        return list(acks)

    def get_status(self, robot_id: str) -> dict:
        with self._lock:
            state = self._robots.get(robot_id)
            if state is None:
                state = RobotState(robot_id=robot_id)
            hb = state.last_heartbeat or {}
            return {
                "robot_id": robot_id,
                "presence": state.presence,
                "last_ack": state.last_ack,
                "last_status": state.last_status,
                "last_heartbeat": state.last_heartbeat,
                "battery": hb.get("battery"),
                "docked": hb.get("docked"),
                "gates": hb.get("gates"),
            }
