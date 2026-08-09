"""Bridge main — subscribe cmd topic, validate, dedupe, serialize execution, ack."""
from __future__ import annotations

import collections
import json
import logging
import os
import queue
import signal
import threading
import time
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
        sleep=time.sleep,
    ) -> None:
        # Task 4 migrates the bridge fully onto the executor's REALDRIVE path (no
        # SafetyState passed to the runner — passing both `safety=` and the v8 params
        # is a footgun). `dry_run` may be a live callable so a shadow flip is honored.
        # `sleep` paces the choreography ticks: wall-clock (time.sleep) on the real
        # robot; a SIM-time sleep in the Gazebo sim (see _build_sim_time_sleep) so a
        # real-time factor < 1 doesn't under-deliver the arc.
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
            sleep=sleep,
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


def _build_sim_time_sleep(node):
    """SIM-time choreography pacing (opt-in via GUIDEMATE_SIM_TIME_CHOREO=1, set by
    sim/launch_sim.sh — NEVER set on a real robot, where wall time == robot time).

    WHY (P8-T6 root-cause evidence, 2026-07-06): the executor times each TwistStep in
    WALL-clock (`time.sleep`) while the sim robot integrates the commanded velocity in
    SIM time, so the delivered arc scales by the real-time factor: at a healthy-looking
    RTF the closure error of a radius-R circle is the chord 2*R*sin(pi*(1-RTF)) —
    deterministically, with PERFECT velocity tracking (measured odom wz 0.2400 vs cmd
    0.24). Measured on this box (Ignition Fortress, warehouse world, headless):
      * RTF 0.49 (orphaned duplicate Gazebo)  -> closure 0.998 m ~= the diameter
      * RTF 0.904-0.941 (single sim, loaded)  -> closure 0.528 / 0.479 / 0.171 m
      * closure < 0.15 m needs RTF >= 0.952 — NOT reliably reachable on a shared box.
    Pacing the ticks by /clock makes the delivered arc exact at ANY RTF, so the sim
    proves the *bridge's* choreography rather than the box's momentary load.

    The sleep falls back to wall-clock if /clock never arrives, and caps the wait at
    max(4x, +2 s) wall so a dying sim can't hang the executor (the abort/kill-switch
    check runs between ticks and must stay responsive)."""
    from rclpy.qos import qos_profile_sensor_data
    from rosgraph_msgs.msg import Clock

    state = {"sim": None}
    cond = threading.Condition()

    def _on_clock(msg) -> None:
        with cond:
            state["sim"] = msg.clock.sec + msg.clock.nanosec * 1e-9
            cond.notify_all()

    node.create_subscription(Clock, "/clock", _on_clock, qos_profile_sensor_data)

    def sim_sleep(duration: float) -> None:
        deadline_wall = time.time() + max(4.0 * duration, duration + 2.0)
        with cond:
            if state["sim"] is None:        # no /clock (yet): wall-clock fallback
                time.sleep(duration)
                return
            target = state["sim"] + duration
            while state["sim"] < target and time.time() < deadline_wall:
                cond.wait(timeout=0.1)

    return sim_sleep


def _build_motion_sinks(env: "Mapping[str, str]"):
    """Construct the ONLY real cmd_vel sink + dock/undock action clients. Called only
    on the env opt-in (GUIDEMATE_ENABLE_MOTION), which assert_motion_identity_safe()
    hard-guards to sim/436, so this is never reached on robot 468. The runtime shadow
    lock (default-deny) still gates every real publish LIVE in the executor.
    Requires GUIDEMATE_ROS=1 (an rclpy node to publish/act on).
    Returns (publish_twist, run_action, choreo_sleep); choreo_sleep is None (-> wall
    clock) unless GUIDEMATE_SIM_TIME_CHOREO opts into /clock pacing (sim only).
    Lazily imports rclpy so the bridge still runs on ROS-less machines when motion
    is off."""
    if not _truthy(env.get("GUIDEMATE_ROS", "0")):
        raise SystemExit(
            "motion requires GUIDEMATE_ROS=1 (rclpy node for cmd_vel + dock actions)"
        )
    import rclpy  # lazy: only when motion is actually enabled
    from rclpy.executors import SingleThreadedExecutor

    from guide_mate_bridge.cmd_vel_publisher import CmdVelPublisher
    from guide_mate_bridge.dock_actions import DockActions

    from guide_mate_bridge.ros_init import ensure_rclpy_init

    ensure_rclpy_init()
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
    choreo_sleep = None
    if _truthy(env.get("GUIDEMATE_SIM_TIME_CHOREO", "0")):
        choreo_sleep = _build_sim_time_sleep(node)
        log.info("choreography paced by SIM time (/clock)")
    log.info("MOTION ENABLED", extra=log_extra(cmd_vel_topic=topic))
    return publish_twist, run_action, choreo_sleep


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
    choreo_sleep = None
    if _truthy(os.environ.get("GUIDEMATE_ENABLE_MOTION", "0")):
        publish_twist, run_action, choreo_sleep = _build_motion_sinks(os.environ)
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
        sleep=choreo_sleep or time.sleep,            # sim: /clock-paced; robot: wall
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
