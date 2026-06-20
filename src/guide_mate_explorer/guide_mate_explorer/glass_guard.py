#!/usr/bin/env python3
"""Glass guard: turn Create 3 bumper hits into persistent costmap obstacles.

The 2D lidar cannot see glass, so Nav2 treats the area behind a glass wall as
free space and drives into it. The Create 3's front bumper *can* feel the glass.
This node listens for BUMP hazards, projects the triggered bumper into the global
frame, and continuously republishes the accumulated hit points as a PointCloud2.
Nav2's costmap consumes that cloud in a dedicated, **non-clearing** obstacle layer
(so the lidar -- which sees "free" space through the glass -- cannot erase it),
after which the planner routes around the glass.

It also publishes each fresh hit on `bump_points` so the BFS explorer can
blacklist that frontier, and (optionally) emits a short reverse pulse to break
contact.

Note: the TurtleBot 4 does NOT republish hazards to the clean namespace, so by
default we subscribe to the raw Create 3 topic `_do_not_use/hazard_detection`.
"""

import math

import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import (QoSDurabilityPolicy, QoSHistoryPolicy, QoSProfile,
                       QoSReliabilityPolicy, qos_profile_sensor_data)

from geometry_msgs.msg import PointStamped, Twist
from irobot_create_msgs.msg import HazardDetectionVector
from sensor_msgs.msg import PointCloud2
from sensor_msgs_py import point_cloud2
from std_msgs.msg import Header
from visualization_msgs.msg import Marker, MarkerArray

import tf2_ros

BUMP = 1  # irobot_create_msgs/HazardDetection.BUMP


class GlassGuard(Node):
    def __init__(self):
        super().__init__('glass_guard')

        self.declare_parameter('hazard_topic',
                               '/turtlebot468/_do_not_use/hazard_detection')
        self.declare_parameter('global_frame', 'map')
        self.declare_parameter('cloud_topic', 'bump_obstacles')
        self.declare_parameter('points_topic', 'bump_points')
        # Snap hits to this grid (m) so we don't accumulate duplicates.
        self.declare_parameter('dedup_resolution', 0.05)
        # Push the marked point this far ahead of the bumper frame (m).
        self.declare_parameter('forward_offset', 0.03)
        self.declare_parameter('publish_rate', 5.0)
        # Optional reverse pulse to break contact on bump.
        self.declare_parameter('reactive_backup', False)
        self.declare_parameter('backup_speed', 0.05)     # m/s (reverse)
        self.declare_parameter('backup_duration', 0.8)   # s
        self.declare_parameter('cmd_vel_topic', '/turtlebot468/cmd_vel')

        gp = self.get_parameter
        self.hazard_topic = gp('hazard_topic').value
        self.global_frame = gp('global_frame').value
        self.dedup = float(gp('dedup_resolution').value)
        self.fwd = float(gp('forward_offset').value)
        self.reactive_backup = bool(gp('reactive_backup').value)
        self.backup_speed = float(gp('backup_speed').value)
        self.backup_duration = float(gp('backup_duration').value)

        self.points = {}          # (ix, iy) -> (x, y) in global frame
        self._backup_until = None

        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        latched = QoSProfile(durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                             reliability=QoSReliabilityPolicy.RELIABLE,
                             history=QoSHistoryPolicy.KEEP_LAST, depth=1)
        self.cloud_pub = self.create_publisher(
            PointCloud2, gp('cloud_topic').value, latched)
        self.points_pub = self.create_publisher(
            PointStamped, gp('points_topic').value, 10)
        self.marker_pub = self.create_publisher(MarkerArray, 'bump_markers', 1)
        self.cmd_pub = self.create_publisher(Twist, gp('cmd_vel_topic').value, 10)

        self.create_subscription(HazardDetectionVector, self.hazard_topic,
                                 self._hazard_cb, qos_profile_sensor_data)
        self.create_timer(1.0 / float(gp('publish_rate').value), self._publish)
        if self.reactive_backup:
            self.create_timer(0.05, self._backup_tick)

        self.get_logger().info(
            f"glass_guard up. hazards='{self.hazard_topic}' -> obstacles in "
            f"'{self.global_frame}'. reactive_backup={self.reactive_backup}")

    def _hazard_cb(self, msg):
        for d in msg.detections:
            if d.type != BUMP:
                continue
            self._mark(d.header.frame_id)

    def _mark(self, bumper_frame):
        try:
            tf = self.tf_buffer.lookup_transform(
                self.global_frame, bumper_frame, rclpy.time.Time(),
                timeout=Duration(seconds=0.3))
        except tf2_ros.TransformException as e:
            self.get_logger().warn(f"no TF {self.global_frame}<-{bumper_frame}: {e}")
            return
        # The bumper frame's x axis points outward; offset slightly forward to
        # land the obstacle on the surface that was actually touched.
        q = tf.transform.rotation
        yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y),
                         1.0 - 2.0 * (q.y * q.y + q.z * q.z))
        x = tf.transform.translation.x + self.fwd * math.cos(yaw)
        y = tf.transform.translation.y + self.fwd * math.sin(yaw)
        key = (round(x / self.dedup), round(y / self.dedup))
        if key not in self.points:
            self.points[key] = (x, y)
            self.get_logger().info(
                f"BUMP on {bumper_frame} -> obstacle ({x:.2f}, {y:.2f}). "
                f"{len(self.points)} glass points total.")
        # tell the explorer to blacklist this spot
        ps = PointStamped()
        ps.header.frame_id = self.global_frame
        ps.header.stamp = self.get_clock().now().to_msg()
        ps.point.x, ps.point.y = x, y
        self.points_pub.publish(ps)
        if self.reactive_backup:
            self._backup_until = self.get_clock().now() + \
                Duration(seconds=self.backup_duration)

    def _publish(self):
        header = Header()
        header.frame_id = self.global_frame
        header.stamp = self.get_clock().now().to_msg()
        pts = [(x, y, 0.05) for (x, y) in self.points.values()]
        cloud = point_cloud2.create_cloud_xyz32(header, pts)
        self.cloud_pub.publish(cloud)

        arr = MarkerArray()
        m = Marker()
        m.header = header
        m.ns = 'glass'
        m.id = 0
        m.type = Marker.CUBE_LIST
        m.action = Marker.ADD
        m.scale.x = m.scale.y = m.scale.z = max(self.dedup, 0.05)
        m.color.r, m.color.g, m.color.b, m.color.a = 1.0, 0.0, 0.0, 0.9
        m.pose.orientation.w = 1.0
        from geometry_msgs.msg import Point
        m.points = [Point(x=x, y=y, z=0.05) for (x, y) in self.points.values()]
        arr.markers.append(m)
        self.marker_pub.publish(arr)

    def _backup_tick(self):
        if self._backup_until is None:
            return
        if self.get_clock().now() >= self._backup_until:
            self._backup_until = None
            self.cmd_pub.publish(Twist())  # stop
            return
        t = Twist()
        t.linear.x = -abs(self.backup_speed)
        self.cmd_pub.publish(t)


def main():
    rclpy.init()
    node = GlassGuard()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
