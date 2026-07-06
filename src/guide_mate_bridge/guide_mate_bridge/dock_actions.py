"""Create 3 undock/dock as rclpy ACTION clients — the only non-twist motion path.

Assumes the process's rclpy node is being spun by an executor elsewhere (Phase 2's
telemetry thread spins it), so the goal/result futures resolve while we poll here.
`client_factory` is injectable so unit tests never import rclpy/irobot_create_msgs.
"""
from __future__ import annotations

import logging
import time
from typing import Tuple

log = logging.getLogger(__name__)

_NAMES = ("undock", "dock")


class DockActions:
    def __init__(
        self,
        node,
        undock_action: str = "/undock",
        dock_action: str = "/dock",
        client_factory=None,
        timeout_s: float = 60.0,
    ) -> None:
        if client_factory is None:
            from rclpy.action import ActionClient
            from irobot_create_msgs.action import Dock, Undock  # lazy: no ROS in unit tests

            def client_factory(name):
                if name == "undock":
                    return ActionClient(node, Undock, undock_action), Undock
                return ActionClient(node, Dock, dock_action), Dock

        self._factory = client_factory
        self._timeout_s = timeout_s
        self._clients: dict = {}

    def run(self, name: str) -> "Tuple[bool, str]":
        if name not in _NAMES:
            return False, f"unknown action {name!r}"
        if name not in self._clients:
            self._clients[name] = self._factory(name)
        client, action_cls = self._clients[name]
        if not client.wait_for_server(timeout_sec=10.0):
            return False, f"{name} action server unavailable"
        goal_future = client.send_goal_async(action_cls.Goal())
        deadline = time.time() + self._timeout_s
        while not goal_future.done():
            if time.time() > deadline:
                return False, f"{name} goal not accepted in time"
            time.sleep(0.1)
        handle = goal_future.result()
        if not handle.accepted:
            return False, f"{name} goal rejected"
        result_future = handle.get_result_async()
        while not result_future.done():
            if time.time() > deadline:
                return False, f"{name} result timeout"
            time.sleep(0.1)
        log.info("%s action completed", name)
        return True, ""
