"""In-memory robot registry for tests / demos (GUIDEMATE_FAKE_ROBOT=1).

No MQTT, no robot: get_status reports a healthy docked robot and send_command
returns the same simulated ack sequence the real dry-run bridge would. The
status dict mirrors the real RobotRegistry.get_status() shape (adds battery /
docked / gates) so the admin Robot tab renders identically against the fake.

Every command is recorded in ``self.sent`` (list of ``(robot_id, type, name)``)
— the e2e/demo's evidence that a command (e.g. an assignment-triggered undock)
was actually published. dock/undock return the bridge's motion-locked refusal
(``received`` then ``failed(reason="motion_disabled …")``) so both the admin
'dock' control and the assignment undock/dock exercise their refusal path,
matching robot 468's motion-locked state; everything else acks
received -> running -> done (simulated)."""
from __future__ import annotations

from guidemate_msgs.messages import Ack, Command


class FakeRobotRegistry:
    def __init__(self, robot_ids: list) -> None:
        self._robot_ids = list(robot_ids)
        self.sent: list[tuple] = []      # (robot_id, cmd.type, cmd.name)

    def connect(self) -> None:
        return None

    def on_event(self, callback) -> None:
        """No-op registration: the fake registry has no MQTT status stream to
        drive callbacks from, but app.py's lifespan wires
        registry.on_event(engine.on_status_event) unconditionally, so this
        keeps GUIDEMATE_FAKE_ROBOT=1 startup working. Stashed for tests that
        want to fire it manually via app.state.registry._event_callbacks.
        """
        self._event_callbacks = getattr(self, "_event_callbacks", [])
        self._event_callbacks.append(callback)

    @property
    def is_connected(self) -> bool:
        # No real MQTT link, but the fake registry is always "up" for demos/tests.
        return True

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
        self.sent.append((robot_id, cmd.type, cmd.name))
        if cmd.type == "motion" and cmd.name in ("dock", "undock"):
            # Robot 468 is motion-locked: docking is refused, not executed.
            return [
                Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
                Ack(cmd_id=cmd.cmd_id, state="failed", simulated=True,
                    reason="motion_disabled (docking blocked while motion is locked)"),
            ]
        return [
            Ack(cmd_id=cmd.cmd_id, state=state, simulated=True)
            for state in ("received", "running", "done")
        ]

    def send_fleet_command(self, cmd: Command, timeout_s: float = 5.0) -> list:
        """Fake mirror of RobotRegistry.send_fleet_command (Task 4.2's guide_to_room
        tool calls this in GUIDEMATE_FAKE_ROBOT=1 demo mode too -- there is no real
        virtual-world bridge to assign a robot, so this always simulates success with
        a made-up robot id rather than crashing the tool for lack of the method)."""
        self.sent.append(("(fleet)", cmd.type, cmd.name))
        if cmd.type != "assign":
            return [Ack(cmd_id=cmd.cmd_id, state="failed", simulated=True,
                        reason="unsupported_command_type")]
        return [
            Ack(cmd_id=cmd.cmd_id, state="received", simulated=True),
            Ack(cmd_id=cmd.cmd_id, state="done", simulated=True,
                assigned_robot_id="virtual/demo-1"),
        ]
