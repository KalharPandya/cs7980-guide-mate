#!/usr/bin/env python3
"""Step A validation: drive a short path and confirm AMCL tracks ground truth.

At spawn map->odom is identity (odom==world origin), which proves nothing about
scan matching. This drives the robot ~0.6m forward + a small turn, then compares
AMCL's map->base_link estimate against /robot_1/sim_ground_truth_pose. If they
agree within a few cm / few deg, live lidar scan-matching against maze_truth works.
"""
import math, time
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
import tf2_ros

rclpy.init()
n = Node('loc_drive_check')
# tf buffer listening on the namespaced tf topics
buf = tf2_ros.Buffer()
tf2_ros.TransformListener(buf, n, spin_thread=False)
# remap handled below via subscription to /robot_1/tf(_static)
from tf2_msgs.msg import TFMessage
def on_tf(msg):
    for t in msg.transforms:
        buf.set_transform(t, 'sim')
def on_tf_static(msg):
    for t in msg.transforms:
        buf.set_transform_static(t, 'sim')
n.create_subscription(TFMessage, '/robot_1/tf', on_tf, 10)
n.create_subscription(TFMessage, '/robot_1/tf_static', on_tf_static, qos_profile_sensor_data)

gt = {}
def on_gt(m): gt['p'] = m.pose.pose
n.create_subscription(Odometry, '/robot_1/sim_ground_truth_pose', on_gt, qos_profile_sensor_data)

pub = n.create_publisher(Twist, '/robot_1/cmd_vel_unstamped', 10)

def yaw_of(q):
    return math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))

def amcl_pose():
    """map->base_link from tf buffer -> (x,y,yaw) or None."""
    try:
        from rclpy.time import Time
        tr = buf.lookup_transform('map', 'robot_1/base_link', Time())
        t = tr.transform.translation; r = tr.transform.rotation
        return t.x, t.y, yaw_of(r)
    except Exception:
        return None

# wait (wall-clock) for ground truth + a first AMCL tf. TF floods spin_once, so
# gate on real time, not iteration count.
t_end = time.monotonic() + 30.0
while (('p' not in gt) or (amcl_pose() is None)) and time.monotonic() < t_end:
    rclpy.spin_once(n, timeout_sec=0.05)
if 'p' not in gt:
    print('NO ground truth pose (30s)'); rclpy.shutdown(); exit()
if amcl_pose() is None:
    print('NO map->base_link tf (30s) — AMCL not publishing'); rclpy.shutdown(); exit()
p0 = gt['p']
print(f"start  GT: x={p0.position.x:.3f} y={p0.position.y:.3f} yaw={math.degrees(yaw_of(p0.orientation)):.1f}")
a0 = amcl_pose()
print(f"start AMCL: x={a0[0]:.3f} y={a0[1]:.3f} yaw={math.degrees(a0[2]):.1f}" if a0 else "start AMCL: (none)")

# drive forward until GT advances ~0.6 m (wall-clock budget; RTF ~0.02 => slow)
tw = Twist(); tw.linear.x = 0.30
start_x, start_y = p0.position.x, p0.position.y
t_end = time.monotonic() + 180.0
while time.monotonic() < t_end:
    pub.publish(tw)
    rclpy.spin_once(n, timeout_sec=0.02)
    p = gt.get('p')
    if p and math.hypot(p.position.x-start_x, p.position.y-start_y) >= 0.60:
        break
# small turn to exercise rotation
tw.linear.x = 0.0; tw.angular.z = 0.5
t_end = time.monotonic() + 60.0
while time.monotonic() < t_end:
    pub.publish(tw); rclpy.spin_once(n, timeout_sec=0.02)
    p = gt.get('p')
    if p and abs(yaw_of(p.orientation)-yaw_of(p0.orientation)) > 0.5: break
# stop
tw = Twist()
t_end = time.monotonic() + 2.0
while time.monotonic() < t_end:
    pub.publish(tw); rclpy.spin_once(n, timeout_sec=0.02)
# let AMCL settle on the new scans
t_end = time.monotonic() + 5.0
while time.monotonic() < t_end:
    rclpy.spin_once(n, timeout_sec=0.05)

pf = gt['p']; af = amcl_pose()
gx, gy, gyaw = pf.position.x, pf.position.y, yaw_of(pf.orientation)
print(f"end    GT: x={gx:.3f} y={gy:.3f} yaw={math.degrees(gyaw):.1f}")
if af is None:
    print("end AMCL: (no tf) — localization FAILED to track"); rclpy.shutdown(); exit()
ax, ay, ayaw = af
print(f"end  AMCL: x={ax:.3f} y={ay:.3f} yaw={math.degrees(ayaw):.1f}")
derr = math.hypot(ax-gx, ay-gy)
yerr = abs((math.degrees(ayaw-gyaw)+180) % 360 - 180)
print(f"--> position error = {derr*100:.1f} cm,  yaw error = {yerr:.1f} deg")
print("LOCALIZATION OK — AMCL tracks ground truth" if derr < 0.20 and yerr < 10
      else "LOCALIZATION DRIFT — check scan/map alignment")
rclpy.shutdown()
