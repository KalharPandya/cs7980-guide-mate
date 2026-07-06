"""In-memory robot registry for tests / demos (GUIDEMATE_FAKE_ROBOT=1).

No MQTT, no robot: get_status reports a healthy docked robot and send_command
returns the same simulated ack sequence the real dry-run bridge would. The
status dict mirrors the real RobotRegistry.get_status() shape (adds battery /
docked / gates) so the admin Robot tab renders identically against the fake."""
from __future__ import annotations

from guidemate_msgs.messages import Ack, Command


class FakeRobotRegistry:
    def __init__(self, robot_ids: list) -> None:
        self._robot_ids = list(robot_ids)

    def connect(self) -> None:
        return None

    def get_status(self, robot_id: str) -> dict:
        return {
            "robot_id": robot_id,
            "presence": "online",
            "battery": 0.87,
            "docked": True,
            "gates": {"motion_enabled": False, "dry_run": True},
            "last_ack": None,
            "last_status": {"event": "online", "robot_id": robot_id},
            "last_heartbeat": {"battery": 0.87, "docked": True},
        }

    def send_command(self, robot_id: str, cmd: Command, timeout_s: float = 5.0) -> list:
        return [
            Ack(cmd_id=cmd.cmd_id, state=state, simulated=True)
            for state in ("received", "running", "done")
        ]
