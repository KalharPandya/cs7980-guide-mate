"""Optional rclpy telemetry (battery + dock) and the 30 s heartbeat publisher.

The ROS layer is strictly optional: if GUIDEMATE_ROS is not truthy, rclpy is not
importable, or the graph is unreadable, heartbeats still flow with
battery/docked = null. rclpy is imported lazily so this module (and the whole
bridge) works on machines without ROS.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Optional

from guidemate_msgs.jsonlog import log_extra
from guidemate_msgs.messages import Heartbeat, status_topic

from guide_mate_bridge.safety import SafetyState

log = logging.getLogger(__name__)

# Create 3 base topics (relative names — resolved under the node namespace).
# The Task 4 Step 1 systemd-run probe could NOT surface the Create 3 base
# participant from the ephemeral super-client (no battery/dock/odom/scan in the
# ephemeral graph — a known Discovery-Server limitation, CLAUDE.md gotcha #2).
# These defaults are the firmware-H.2.6 standard names (CLAUDE.md gotcha #3
# records firmware H.2.6; Create 3 H.2.x publishes dock_status/DockStatus, not
# the older dock/Dock — Fallback B does not apply). Overridable at runtime via
# GUIDEMATE_BATTERY_TOPIC / GUIDEMATE_DOCK_TOPIC without a code change:
#   /turtlebot468/battery_state [sensor_msgs/msg/BatteryState]
#   /turtlebot468/dock_status   [irobot_create_msgs/msg/DockStatus]
BATTERY_TOPIC = "battery_state"
DOCK_TOPIC = "dock_status"


def _battery_topic() -> str:
    return os.environ.get("GUIDEMATE_BATTERY_TOPIC", BATTERY_TOPIC)


def _dock_topic() -> str:
    return os.environ.get("GUIDEMATE_DOCK_TOPIC", DOCK_TOPIC)


class Telemetry:
    """Background rclpy node; degrades to None readings when ROS is off/unavailable."""

    def __init__(self, safety: SafetyState, namespace: str, enabled: bool) -> None:
        self._safety = safety
        self._namespace = namespace if namespace.startswith("/") else f"/{namespace}"
        self._enabled = enabled
        self._battery: Optional[float] = None
        self._docked: Optional[bool] = None
        self._lock = threading.Lock()
        self._ros_shutdown = None  # set to rclpy.shutdown once the node is up

    def start(self) -> bool:
        if not self._enabled:
            log.info("telemetry ROS layer disabled (GUIDEMATE_ROS not truthy)")
            return False
        try:
            import rclpy  # noqa: F401
        except ImportError:
            log.warning("rclpy not importable — heartbeats will carry battery/docked=null")
            return False
        threading.Thread(target=self._ros_main, daemon=True).start()
        return True

    def _ros_main(self) -> None:
        import rclpy
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import BatteryState

        rclpy.init(args=None)
        node = rclpy.create_node("guidemate_bridge_telemetry", namespace=self._namespace)
        # Sensor-data QoS (BEST_EFFORT) matches both best-effort and reliable publishers.
        battery_topic = _battery_topic()
        dock_topic = _dock_topic()
        node.create_subscription(
            BatteryState, battery_topic, self._on_battery, qos_profile_sensor_data
        )
        try:
            from irobot_create_msgs.msg import DockStatus

            node.create_subscription(
                DockStatus, dock_topic, self._on_dock, qos_profile_sensor_data
            )
        except ImportError:
            log.warning("irobot_create_msgs unavailable — dock state stays unknown")
        self._ros_shutdown = rclpy.shutdown
        log.info(
            "telemetry ROS node up",
            extra=log_extra(
                namespace=self._namespace,
                battery_topic=battery_topic,
                dock_topic=dock_topic,
            ),
        )
        try:
            rclpy.spin(node)
        except Exception:  # noqa: BLE001 — rclpy.shutdown() from stop() ends the spin
            pass

    def _on_battery(self, msg) -> None:
        with self._lock:
            self._battery = float(msg.percentage)

    def _on_dock(self, msg) -> None:
        docked = bool(msg.is_docked)
        with self._lock:
            self._docked = docked
        self._safety.set_docked(docked)

    def battery(self) -> Optional[float]:
        with self._lock:
            return self._battery

    def docked(self) -> Optional[bool]:
        with self._lock:
            return self._docked

    def stop(self) -> None:
        if self._ros_shutdown is not None:
            try:
                self._ros_shutdown()
            except Exception:  # noqa: BLE001
                pass


class HeartbeatPublisher:
    """Publishes a Heartbeat to status_topic immediately and then every interval_s."""

    def __init__(
        self,
        client,
        robot_id: str,
        safety: SafetyState,
        telemetry: Telemetry,
        interval_s: float = 30.0,
    ) -> None:
        self._client = client
        self._robot_id = robot_id
        self._safety = safety
        self._telemetry = telemetry
        self._interval_s = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def publish_once(self) -> None:
        hb = Heartbeat(
            robot_id=self._robot_id,
            battery=self._telemetry.battery(),
            docked=self._telemetry.docked(),
            uptime_s=round(self._safety.uptime_s(), 1),
            gates=self._safety.gates(),
        )
        self._client.publish(status_topic(self._robot_id), hb.model_dump_json())
        # Journal evidence for on-Pi verification (log_extra drops None values).
        log.info(
            "heartbeat",
            extra=log_extra(
                robot_id=self._robot_id,
                battery=hb.battery,
                docked=hb.docked,
                uptime_s=hb.uptime_s,
            ),
        )

    def _loop(self) -> None:
        while True:
            try:
                self.publish_once()
            except Exception:  # noqa: BLE001 — the heartbeat thread must never die
                log.exception("heartbeat publish failed")
            if self._stop.wait(self._interval_s):
                return

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
