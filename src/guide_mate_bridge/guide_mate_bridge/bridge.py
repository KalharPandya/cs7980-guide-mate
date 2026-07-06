"""Bridge main — subscribe cmd topic, validate, dedupe, serialize execution, ack."""
from __future__ import annotations

import collections
import json
import logging
import os
import queue
import signal
import threading

from guidemate_msgs.jsonlog import log_extra, setup
from guidemate_msgs.messages import Ack, Command, cmd_topic, status_topic
from pydantic import ValidationError

from guide_mate_bridge.executor import ChoreographyRunner
from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState
from guide_mate_bridge.shadow import ShadowSync
from guide_mate_bridge.telemetry import HeartbeatPublisher, Telemetry

log = logging.getLogger(__name__)


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


class Bridge:
    def __init__(self, client: IotClient, robot_id: str, safety: SafetyState) -> None:
        self._client = client
        self._robot_id = robot_id
        self._safety = safety
        self._seen = collections.deque(maxlen=256)
        self._seen_set: set[str] = set()
        # awscrt dispatches callbacks single-threaded per connection today, but that's
        # not a documented contract — guard the check-evict-insert sequence explicitly.
        self._dedupe_lock = threading.Lock()
        self._queue: "queue.Queue[Command]" = queue.Queue()
        self._runner = ChoreographyRunner(publish_ack=self._publish_ack, safety=safety)
        self._worker = threading.Thread(target=self._run, daemon=True)

    def _publish_ack(self, ack: Ack) -> None:
        self._client.publish(status_topic(self._robot_id), ack.model_dump_json())

    def _seen_count(self, cmd_id: str) -> int:
        return sum(1 for c in self._seen if c == cmd_id)

    def on_message(self, topic: str, payload: str) -> None:
        try:
            cmd = Command.model_validate_json(payload)
        except (ValidationError, ValueError) as exc:
            log.warning("ignoring invalid command: %s", exc)
            return
        with self._dedupe_lock:
            if cmd.cmd_id in self._seen_set:
                log.info("duplicate cmd_id ignored", extra=log_extra(cmd_id=cmd.cmd_id))
                return
            if len(self._seen) == self._seen.maxlen:
                self._seen_set.discard(self._seen[0])  # oldest, about to be evicted
            self._seen.append(cmd.cmd_id)
            self._seen_set.add(cmd.cmd_id)
        self._queue.put(cmd)

    def _run(self) -> None:
        while True:
            cmd = self._queue.get()
            try:
                self._runner.handle(cmd)
            except Exception:  # noqa: BLE001 — never let the worker thread die
                log.exception("runner failed", extra=log_extra(cmd_id=cmd.cmd_id))
            finally:
                self._queue.task_done()

    def start(self) -> None:
        self._worker.start()
        self._client.connect()
        self._client.subscribe(cmd_topic(self._robot_id), self.on_message)


def _graceful_shutdown(client, shadow, robot_id, telemetry=None, heartbeat=None) -> None:
    """SIGTERM path: offline(graceful) -> final reported -> disconnect -> stop rclpy."""
    if heartbeat is not None:
        heartbeat.stop()  # no more publishes racing the teardown
    # Main thread here (SIGTERM set stop_event, main() called us) — blocking on the
    # puback IS safe, unlike the awscrt callback threads that must use async publish().
    # A clean disconnect suppresses the LWT, so these final messages must actually land
    # before we disconnect; publish_sync blocks (and warns on timeout) to guarantee it.
    client.publish_sync(
        status_topic(robot_id),
        json.dumps({"event": "offline", "robot_id": robot_id, "graceful": True}),
    )
    shadow.publish_reported(sync=True)
    client.disconnect()
    if telemetry is not None:
        telemetry.stop()


def main() -> None:
    setup("bridge")
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    thing_name = os.environ.get("GUIDEMATE_THING_NAME", "Turtlebot-468")
    env_dry_run = _truthy(os.environ.get("GUIDEMATE_DRY_RUN", "1"))
    if not env_dry_run:
        log.warning(
            "env dry-run is OFF — effective dry-run now follows the shadow "
            "(which also defaults to locked). No cmd_vel publisher exists in "
            "this phase, so nothing can move either way."
        )
    endpoint = os.environ["GUIDEMATE_IOT_ENDPOINT"]
    cert = os.environ["GUIDEMATE_CERT"]
    key = os.environ["GUIDEMATE_KEY"]
    ca = os.environ.get("GUIDEMATE_CA")

    safety = SafetyState(env_dry_run=env_dry_run)
    client = IotClient(
        endpoint=endpoint,
        cert_filepath=cert,
        pri_key_filepath=key,
        client_id=f"guidemate-bridge-{robot_id}",
        robot_id=robot_id,
        ca_filepath=ca,
    )
    bridge = Bridge(client=client, robot_id=robot_id, safety=safety)
    bridge.start()
    shadow = ShadowSync(client=client, thing_name=thing_name, safety=safety)
    shadow.start()

    telemetry = Telemetry(
        safety=safety,
        namespace=os.environ.get("GUIDEMATE_ROS_NAMESPACE", robot_id),
        enabled=_truthy(os.environ.get("GUIDEMATE_ROS", "0")),
    )
    telemetry.start()
    heartbeat = HeartbeatPublisher(
        client=client, robot_id=robot_id, safety=safety, telemetry=telemetry
    )
    heartbeat.start()

    stop_event = threading.Event()

    def _on_signal(signum, frame):
        stop_event.set()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    log.info("bridge connected", extra=log_extra(robot_id=robot_id))
    stop_event.wait()
    log.info("shutting down gracefully", extra=log_extra(robot_id=robot_id))
    _graceful_shutdown(
        client=client, shadow=shadow, robot_id=robot_id,
        telemetry=telemetry, heartbeat=heartbeat,
    )


if __name__ == "__main__":
    main()
