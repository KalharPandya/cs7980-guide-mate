"""Bridge main — subscribe cmd topic, validate, dedupe, serialize execution, ack."""
from __future__ import annotations

import collections
import logging
import os
import queue
import threading

from guidemate_msgs.jsonlog import log_extra, setup
from guidemate_msgs.messages import Ack, Command, cmd_topic, status_topic
from pydantic import ValidationError

from guide_mate_bridge.executor import ChoreographyRunner
from guide_mate_bridge.iot_client import IotClient
from guide_mate_bridge.safety import SafetyState

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


def main() -> None:
    setup("bridge")
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    if not _truthy(os.environ.get("GUIDEMATE_DRY_RUN", "1")):
        raise SystemExit(
            "GUIDEMATE_DRY_RUN must be truthy in Phase 1 — motion paths do not exist yet"
        )
    endpoint = os.environ["GUIDEMATE_IOT_ENDPOINT"]
    cert = os.environ["GUIDEMATE_CERT"]
    key = os.environ["GUIDEMATE_KEY"]
    ca = os.environ.get("GUIDEMATE_CA")
    client = IotClient(
        endpoint=endpoint,
        cert_filepath=cert,
        pri_key_filepath=key,
        client_id=f"guidemate-bridge-{robot_id}",
        robot_id=robot_id,
        ca_filepath=ca,
    )
    safety = SafetyState(env_dry_run=True)  # main() already exited above if env != truthy
    bridge = Bridge(client=client, robot_id=robot_id, safety=safety)
    bridge.start()
    log.info("bridge connected", extra=log_extra(robot_id=robot_id))
    threading.Event().wait()  # block forever


if __name__ == "__main__":
    main()
