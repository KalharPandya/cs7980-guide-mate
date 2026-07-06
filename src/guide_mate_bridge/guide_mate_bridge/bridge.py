"""Bridge main — subscribe cmd topic, validate, dedupe, serialize execution, ack."""
from __future__ import annotations

import collections
import json
import logging
import os
import queue
import signal
import threading
from typing import Mapping

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


def resolve_motion_enabled(
    env: "Mapping[str, str]", effective_dry_run: bool, shadow_motion_enabled: bool
) -> bool:
    """Build the real cmd_vel sink ONLY when the operator opted in via env AND the shadow
    allows motion AND we are not in effective dry-run. Any single lock closed -> no motion."""
    if not _truthy(env.get("GUIDEMATE_ENABLE_MOTION", "0")):
        return False
    return bool(shadow_motion_enabled) and not effective_dry_run


# While docked, only these commands are permitted (spec delta 91d9bcb):
# undock (leave the dock), dock (no-op-ish -> the Create 3 Dock action succeeds
# immediately when already docked -> done ack), and stop (always safe).
_DOCKED_EXEMPT = {("motion", "undock"), ("motion", "dock"), ("stop", "stop")}


def command_permitted(
    cmd_type: str, cmd_name: str, motion_enabled: bool, docked: bool
) -> "tuple[bool, str]":
    """Dock-guard exemption matrix. Shadow lock is supreme: nothing runs while
    motion_enabled is false. While docked, refuse all motion EXCEPT undock/dock/stop.
    While undocked, everything is allowed (dock is a normal action)."""
    if not motion_enabled:
        return False, "motion_disabled"
    if docked and (cmd_type, cmd_name) not in _DOCKED_EXEMPT:
        return False, "docked"
    return True, ""


def assert_motion_identity_safe(env: "Mapping[str, str]") -> None:
    """Hard robot-id guard (belt + braces): GUIDEMATE_ENABLE_MOTION must NEVER be honored for
    robot 468. The Pi installer never sets it; this refuses even if someone does by hand.
    The robot id defaults to turtlebot468 when unset, so an unset id is also refused."""
    if _truthy(env.get("GUIDEMATE_ENABLE_MOTION", "0")):
        robot_id = env.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
        if robot_id == "turtlebot468":
            raise SystemExit(
                "refusing GUIDEMATE_ENABLE_MOTION on turtlebot468 — motion is sim/436 only"
            )


class Bridge:
    def __init__(
        self,
        client: IotClient,
        robot_id: str,
        dry_run=True,
        publish_twist=None,
        publish_hz: float = 10.0,
        motion_gate=None,
        run_action=None,
        max_speed=None,
    ) -> None:
        # Task 4 migrates the bridge fully onto the executor's REALDRIVE path (no
        # SafetyState passed to the runner — passing both `safety=` and the v8 params
        # is a footgun). `dry_run` may be a live callable so a shadow flip is honored.
        self._client = client
        self._robot_id = robot_id
        self._seen = collections.deque(maxlen=256)
        self._seen_set: set[str] = set()
        # awscrt dispatches callbacks single-threaded per connection today, but that's
        # not a documented contract — guard the check-evict-insert sequence explicitly.
        self._dedupe_lock = threading.Lock()
        self._queue: "queue.Queue[Command]" = queue.Queue()
        self._runner = ChoreographyRunner(
            publish_ack=self._publish_ack,
            dry_run=dry_run,
            publish_twist=publish_twist,
            publish_hz=publish_hz,
            motion_gate=motion_gate,
            run_action=run_action,
            max_speed=max_speed,
        )
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
        if cmd.type == "stop":
            # KILL-SWITCH (stop path): interrupt any in-flight choreography immediately,
            # off the worker thread, so the wheels zero within one publish period. The
            # stop command is still enqueued below so it acks normally.
            self._runner.abort(reason="stopped")
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

    def abort(self, reason: str = "aborted") -> None:
        """Delegate to the runner — wired to the shadow kill-switch in main()."""
        self._runner.abort(reason=reason)

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


def _build_motion_sinks(env: "Mapping[str, str]"):
    """Construct the ONLY real cmd_vel sink + dock/undock action clients. Called only
    on the env opt-in (GUIDEMATE_ENABLE_MOTION), which assert_motion_identity_safe()
    hard-guards to sim/436, so this is never reached on robot 468. The runtime shadow
    lock (default-deny) still gates every real publish LIVE in the executor.
    Requires GUIDEMATE_ROS=1 (an rclpy node to publish/act on).
    Returns (publish_twist, run_action). Lazily imports rclpy so the bridge still runs
    on ROS-less machines when motion is off."""
    if not _truthy(env.get("GUIDEMATE_ROS", "0")):
        raise SystemExit(
            "motion requires GUIDEMATE_ROS=1 (rclpy node for cmd_vel + dock actions)"
        )
    import rclpy  # lazy: only when motion is actually enabled
    from rclpy.executors import SingleThreadedExecutor

    from guide_mate_bridge.cmd_vel_publisher import CmdVelPublisher
    from guide_mate_bridge.dock_actions import DockActions

    if not rclpy.ok():
        rclpy.init(args=None)
    namespace = env.get("GUIDEMATE_ROS_NAMESPACE", env.get("GUIDEMATE_ROBOT_ID", ""))
    node = rclpy.create_node(
        "guidemate_bridge_motion",
        namespace=(namespace if namespace.startswith("/") else f"/{namespace}") if namespace else "/",
    )
    # Spin the motion node so the dock/undock goal + result futures resolve while
    # DockActions.run polls them.
    executor = SingleThreadedExecutor()
    executor.add_node(node)
    threading.Thread(target=executor.spin, daemon=True).start()

    topic = env.get("GUIDEMATE_CMD_VEL_TOPIC", "/cmd_vel")
    publish_twist = CmdVelPublisher(node, topic=topic)
    run_action = DockActions(
        node,
        undock_action=env.get("GUIDEMATE_UNDOCK_ACTION", "/undock"),
        dock_action=env.get("GUIDEMATE_DOCK_ACTION", "/dock"),
    ).run
    log.info("MOTION ENABLED", extra=log_extra(cmd_vel_topic=topic))
    return publish_twist, run_action


def main() -> None:
    setup("bridge")
    robot_id = os.environ.get("GUIDEMATE_ROBOT_ID", "turtlebot468")
    thing_name = os.environ.get("GUIDEMATE_THING_NAME", "Turtlebot-468")

    # HARD GUARD (belt + braces): GUIDEMATE_ENABLE_MOTION is NEVER honored for robot
    # 468 (nor when the robot id is unset -> defaults to 468). The Pi installer never
    # sets it; this refuses even if someone exports it by hand.
    assert_motion_identity_safe(os.environ)

    env_dry_run = _truthy(os.environ.get("GUIDEMATE_DRY_RUN", "1"))
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

    # Telemetry first so dock state (safety.set_docked) starts flowing before we gate.
    telemetry = Telemetry(
        safety=safety,
        namespace=os.environ.get("GUIDEMATE_ROS_NAMESPACE", robot_id),
        enabled=_truthy(os.environ.get("GUIDEMATE_ROS", "0")),
    )
    telemetry.start()

    # Shadow sync is opt-in (GUIDEMATE_SHADOW, default off). It must ONLY run where
    # the cert is authorized for the thing's shadow: a policy-denied shadow SUBSCRIBE
    # makes AWS IoT drop the whole connection, which permanently poisons the shared
    # command subscription (awscrt replays the pending subscribe on every reconnect).
    # Production enables it via systemd with the authorized robot cert; the dev cert
    # (integration test) leaves it off, so defaults stay locked = fail-safe.
    # Connect BEFORE shadow.start(): the shadow reconcile SUBSCRIBEs to the reserved
    # $aws shadow topics and blocks on the SUBACK, which never arrives on an unconnected
    # socket. connect() is idempotent, so bridge.start()'s own connect() below is a no-op.
    client.connect()

    shadow = ShadowSync(
        client=client, thing_name=thing_name, safety=safety,
        enabled=_truthy(os.environ.get("GUIDEMATE_SHADOW", "0")),
    )
    shadow.start()  # reconcile motion_enabled/dry_run/max_speed from desired

    # ---- Build the real motion sinks on the ENV opt-in (guarded to sim/436) ----
    # Build the cmd_vel publisher + dock/undock action clients whenever the operator
    # opted in via env (GUIDEMATE_ENABLE_MOTION). This is hard-guarded to sim/436 by
    # assert_motion_identity_safe() above (robot 468 exits before here) and requires
    # GUIDEMATE_ROS=1.
    #
    # The sinks are built EAGERLY, NOT gated on the current shadow snapshot: the shadow
    # is default-deny (motion_enabled=false, dry_run=true) at bridge boot, and a runtime
    # shadow flip (Task 6 / the assignment-approve hook) must actually reach a REAL sink
    # instead of a None one frozen at boot. The default-deny lock stays fully in force —
    # it is enforced LIVE downstream by the executor's _is_dry_run() + _motion_gate
    # (see resolve_motion_enabled's triple-gate semantics), so until the shadow is
    # unlocked every command still takes the dry-run/refusal path and never moves a wheel.
    publish_twist = None
    run_action = None
    if _truthy(os.environ.get("GUIDEMATE_ENABLE_MOTION", "0")):
        publish_twist, run_action = _build_motion_sinks(os.environ)
        log.info(
            "motion sinks built (env opt-in) — real drive gated LIVE by shadow "
            "dry_run + motion_gate; locked shadow still acks simulated",
            extra=log_extra(robot_id=robot_id),
        )
    else:
        log.info(
            "motion sinks NOT built (env not opted in) — commands ack but never move",
            extra=log_extra(robot_id=robot_id),
        )

    def _motion_gate(cmd):
        # Command-aware gate, evaluated LIVE at dispatch: shadow lock is supreme, and
        # the dock-guard exemption matrix lets undock/dock/stop through while docked.
        gates = safety.gates()
        return command_permitted(
            cmd.type, cmd.name, gates["motion_enabled"], gates["docked"] is not False
        )

    bridge = Bridge(
        client=client,
        robot_id=robot_id,
        dry_run=lambda: safety.effective_dry_run,   # LIVE: a shadow flip is honored
        publish_twist=publish_twist,
        motion_gate=_motion_gate,
        run_action=run_action,
        max_speed=lambda: safety.max_speed,          # LIVE: dynamic shadow clamp
    )
    # KILL-SWITCH: a shadow delta motion_enabled:false aborts the in-flight choreography.
    shadow.set_motion_disabled_callback(lambda: bridge.abort(reason="motion_disabled"))
    bridge.start()

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
