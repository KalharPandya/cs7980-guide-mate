#!/usr/bin/env python3
"""GuideMate SLAM driver: reactive left-hand wall-follower (lidar-only).

Drives the namespaced TB4 around a maze to build a slam_toolbox map, hands-off.
- Subscribes /robot_1/scan (SensorDataQoS = BEST_EFFORT, matches the gz lidar).
- Publishes geometry_msgs/Twist to /robot_1/cmd_vel_unstamped (no stamp check).
Left-hand rule: keep the wall on the LEFT at ~target distance; turn right when the
front is blocked; curve left to reacquire when the left opens up. Speeds kept modest
so SLAM scan-matching stays clean (fast rotation smears loop closure).
"""
import math
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan
from geometry_msgs.msg import Twist

NS = '/robot_1'

# tunables
TARGET_LEFT = 0.6      # desired distance to left wall (m)
WALL_DETECT = 1.5      # left reading below this => a wall is present to follow
FRONT_STOP = 0.7       # if anything closer than this ahead, turn away
LIN_SPEED = 0.30       # forward speed (m/s); TB4 max ~0.31 (speed = key lever at low RTF)
TURN = 0.8             # base angular speed (rad/s)
HYST = 0.15            # deadband around TARGET_LEFT (m)
SECTOR = math.radians(25)  # half-width of each sampling sector


class WallFollower(Node):
    def __init__(self):
        super().__init__('wall_follower')
        self.pub = self.create_publisher(Twist, f'{NS}/cmd_vel_unstamped', 10)
        self.sub = self.create_subscription(
            LaserScan, f'{NS}/scan', self.on_scan, qos_profile_sensor_data)
        self.timer = self.create_timer(0.1, self.tick)   # 10 Hz control
        self.front = self.left = self.right = float('inf')
        self.have_scan = False
        self.n = 0
        self.get_logger().info('wall_follower up; waiting for scan...')

    def sector_min(self, msg, center):
        """Min valid range in a sector centered at angle `center` (rad)."""
        best = float('inf')
        for i, r in enumerate(msg.ranges):
            if not math.isfinite(r) or r <= msg.range_min:
                continue
            a = msg.angle_min + i * msg.angle_increment
            # wrap difference into [-pi, pi]
            d = math.atan2(math.sin(a - center), math.cos(a - center))
            if abs(d) <= SECTOR and r < best:
                best = r
        return best

    def on_scan(self, msg):
        self.front = self.sector_min(msg, 0.0)
        self.left = self.sector_min(msg, math.pi / 2)
        self.right = self.sector_min(msg, -math.pi / 2)
        self.have_scan = True

    def tick(self):
        if not self.have_scan:
            return
        t = Twist()
        if self.front < FRONT_STOP:
            # blocked ahead -> rotate right in place (away from left wall)
            t.linear.x = 0.0
            t.angular.z = -TURN
        elif self.left > WALL_DETECT:
            # NO left wall nearby (open space) -> drive forward to FIND one,
            # only a gentle left bias so we spiral out instead of circling in place.
            t.linear.x = LIN_SPEED
            t.angular.z = TURN * 0.25
        elif self.left > TARGET_LEFT + HYST:
            # wall present but drifting away -> curve left to close the gap
            t.linear.x = LIN_SPEED
            t.angular.z = TURN * 0.4
        elif self.left < TARGET_LEFT - HYST:
            # too close to left wall -> ease right
            t.linear.x = LIN_SPEED
            t.angular.z = -TURN * 0.4
        else:
            # good corridor, wall at target distance -> straight
            t.linear.x = LIN_SPEED
            t.angular.z = 0.0
        self.pub.publish(t)
        self.n += 1
        if self.n % 20 == 0:  # ~every 2s
            self.get_logger().info(
                f'front={self.front:.2f} left={self.left:.2f} right={self.right:.2f} '
                f'-> v={t.linear.x:.2f} w={t.angular.z:.2f}')


def main():
    rclpy.init()
    node = WallFollower()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.pub.publish(Twist())  # stop the robot on exit
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
