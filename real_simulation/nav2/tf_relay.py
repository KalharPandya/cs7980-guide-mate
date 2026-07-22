#!/usr/bin/env python3
"""GuideMate — TF merge relay for the two-robot demo (Strategy B).

Each robot keeps its TF on its PRIVATE /robot_N/tf (the TB4 wrapper's /tf->tf
remap). RViz (and any tool that wants to see both robots at once) reads the
GLOBAL /tf. This node republishes /robot_1/tf + /robot_2/tf -> /tf and the
static trees -> /tf_static, so one RViz shows the whole fleet. Frames are
already prefixed (robot_1/base_link, robot_2/base_link, ...) so nothing
collides and `map` is shared.

Nav2/AMCL do NOT read /tf here (they use their private trees), so this relay is
visualization-only and safe to omit for headless runs.

Usage (its own terminal, after the sim is up):  python3 real_simulation/nav2/tf_relay.py
"""
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSDurabilityPolicy, QoSReliabilityPolicy
from tf2_msgs.msg import TFMessage

NAMESPACES = ('robot_1', 'robot_2')


class TfRelay(Node):
    def __init__(self):
        super().__init__('tf_relay')

        dyn_qos = QoSProfile(depth=100)
        dyn_qos.reliability = QoSReliabilityPolicy.RELIABLE
        dyn_qos.durability = QoSDurabilityPolicy.VOLATILE

        static_qos = QoSProfile(depth=100)
        static_qos.reliability = QoSReliabilityPolicy.RELIABLE
        static_qos.durability = QoSDurabilityPolicy.TRANSIENT_LOCAL  # latched

        self.pub_tf = self.create_publisher(TFMessage, '/tf', dyn_qos)
        self.pub_tf_static = self.create_publisher(TFMessage, '/tf_static', static_qos)

        for ns in NAMESPACES:
            self.create_subscription(
                TFMessage, f'/{ns}/tf',
                lambda m: self.pub_tf.publish(m), dyn_qos)
            self.create_subscription(
                TFMessage, f'/{ns}/tf_static',
                lambda m: self.pub_tf_static.publish(m), static_qos)
        self.get_logger().info(
            f'relaying { {n: (f"/{n}/tf", f"/{n}/tf_static") for n in NAMESPACES} } -> /tf, /tf_static')


def main():
    rclpy.init()
    node = TfRelay()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
