"""Thin rclpy cmd_vel sink. The ONLY place a geometry_msgs/Twist is ever published."""
from __future__ import annotations

from guidemate_msgs.choreography import TwistStep


class CmdVelPublisher:
    def __init__(self, node, topic: str = "/cmd_vel", twist_cls=None) -> None:
        if twist_cls is None:
            from geometry_msgs.msg import Twist as twist_cls  # lazy: no ROS import in unit tests
        self._twist_cls = twist_cls
        self._pub = node.create_publisher(twist_cls, topic, 10)

    def __call__(self, step: TwistStep) -> None:
        msg = self._twist_cls()
        msg.linear.x = float(step.vx)
        msg.angular.z = float(step.wz)
        self._pub.publish(msg)
