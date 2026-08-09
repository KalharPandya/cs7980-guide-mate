"""Single-owner rclpy context init.

The bridge has TWO rclpy users that may start concurrently: the telemetry
daemon thread and (armed mode only) the motion-sink builder. rclpy.init() on
an already-initialized context raises ``Context.init() must only be called
once`` — and when the loser was the telemetry thread it died SILENTLY, leaving
docked/battery=None forever (dock-guard default-denies, action results lost).
Every rclpy user must go through ensure_rclpy_init(); never call rclpy.init
directly.
"""
from __future__ import annotations

import threading

_lock = threading.Lock()


def ensure_rclpy_init() -> None:
    import rclpy  # lazy: the bridge must still run on ROS-less machines

    with _lock:
        if not rclpy.ok():
            rclpy.init(args=None)
