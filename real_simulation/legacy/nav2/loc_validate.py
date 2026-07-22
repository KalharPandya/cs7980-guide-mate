#!/usr/bin/env python3
"""Step A validation (GT-free): drive, then check AMCL localizes in the world frame.

Method: drive ~0.6 m forward + a small turn (paced by /robot_1/odom, which is
live). Once the robot has actually moved (so map->odom is no longer identity),
project the live /robot_1/scan through AMCL's map->lidar transform onto the
maze_truth map and measure the fraction of beam endpoints landing on a wall.
This is scan_check.py's 98% metric, but driven by AMCL's estimate rather than
ground truth -> a direct test that AMCL scan-matching is correct in world coords.
"""
import math, time, numpy as np, yaml
import rclpy
from rclpy.node import Node
from rclpy.time import Time
from rclpy.qos import qos_profile_sensor_data, QoSProfile, QoSDurabilityPolicy, QoSHistoryPolicy
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from tf2_msgs.msg import TFMessage
from PIL import Image
import tf2_ros

BASE = '/home/baishibo123/robotics/maps/maze_truth'
y = yaml.safe_load(open(BASE + '.yaml'))
res = y['resolution']; ox, oy = y['origin'][0], y['origin'][1]
gray = np.array(Image.open(BASE + '.pgm').convert('L'))
H, W = gray.shape

rclpy.init()
n = Node('loc_validate')
buf = tf2_ros.Buffer()
def on_tf(m):
    for t in m.transforms: buf.set_transform(t, 'sim')
def on_tf_static(m):
    for t in m.transforms: buf.set_transform_static(t, 'sim')
n.create_subscription(TFMessage, '/robot_1/tf', on_tf, 10)
# tf_static is latched (transient_local) and published once at startup — a
# volatile late-joiner gets nothing, so match transient_local durability.
static_qos = QoSProfile(depth=100, durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
                        history=QoSHistoryPolicy.KEEP_LAST)
n.create_subscription(TFMessage, '/robot_1/tf_static', on_tf_static, static_qos)

state = {}
def on_odom(m): state['odom'] = m.pose.pose
def on_scan(m): state['scan'] = m
n.create_subscription(Odometry, '/robot_1/odom', on_odom, qos_profile_sensor_data)
n.create_subscription(LaserScan, '/robot_1/scan', on_scan, qos_profile_sensor_data)
from geometry_msgs.msg import Twist
pub = n.create_publisher(Twist, '/robot_1/cmd_vel_unstamped', 10)

def spin(dt):
    t = time.monotonic() + dt
    while time.monotonic() < t: rclpy.spin_once(n, timeout_sec=0.02)

def map_to_lidar():
    """(x,y,yaw) of the lidar frame in map, from TF, or None."""
    try:
        fr = state['scan'].header.frame_id
        tr = buf.lookup_transform('map', fr, Time())
        t = tr.transform.translation; q = tr.transform.rotation
        yaw = math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))
        return t.x, t.y, yaw
    except Exception as e:
        return None

# wait for odom + scan + a first AMCL transform
t_end = time.monotonic() + 30.0
while (('odom' not in state) or ('scan' not in state) or (map_to_lidar() is None)) \
        and time.monotonic() < t_end:
    rclpy.spin_once(n, timeout_sec=0.05)
for k in ('odom', 'scan'):
    if k not in state:
        print(f'NO {k} in 30s'); rclpy.shutdown(); exit()
if map_to_lidar() is None:
    print('NO map->lidar TF (AMCL not localizing)'); rclpy.shutdown(); exit()

o0 = state['odom']
print(f"odom start: x={o0.position.x:.3f} y={o0.position.y:.3f}")

# drive forward until odom advances ~0.6 m
tw = Twist(); tw.linear.x = 0.30
t_end = time.monotonic() + 180.0
while time.monotonic() < t_end:
    pub.publish(tw); rclpy.spin_once(n, timeout_sec=0.02)
    o = state.get('odom')
    if o and math.hypot(o.position.x-o0.position.x, o.position.y-o0.position.y) >= 0.60:
        break
# small turn
tw.linear.x = 0.0; tw.angular.z = 0.5
spin_end = time.monotonic() + 40.0
o_start_yaw = math.atan2(2*(o0.orientation.w*o0.orientation.z),
                         1-2*(o0.orientation.z**2))
while time.monotonic() < spin_end:
    pub.publish(tw); rclpy.spin_once(n, timeout_sec=0.02)
# stop and settle
tw = Twist()
for _ in range(30): pub.publish(tw); rclpy.spin_once(n, timeout_sec=0.02)
spin(6.0)

o1 = state['odom']
moved = math.hypot(o1.position.x-o0.position.x, o1.position.y-o0.position.y)
print(f"odom end:   x={o1.position.x:.3f} y={o1.position.y:.3f}  (moved {moved:.2f} m)")

# project the latest scan through AMCL's map->lidar transform
L = map_to_lidar()
if L is None:
    print("map->lidar TF lost after driving — AMCL FAILED"); rclpy.shutdown(); exit()
lx, ly, lyaw = L
print(f"AMCL lidar-in-map: x={lx:.3f} y={ly:.3f} yaw={math.degrees(lyaw):.1f}")
s = state['scan']
rgb = np.stack([gray, gray, gray], axis=-1)
hit = tot = 0
for i, r in enumerate(s.ranges):
    if not math.isfinite(r) or r <= s.range_min or r >= s.range_max: continue
    a = lyaw + s.angle_min + i*s.angle_increment
    wx = lx + r*math.cos(a); wy = ly + r*math.sin(a)
    c = int((wx-ox)/res); row = int(H-(wy-oy)/res)
    if 0 <= row < H and 0 <= c < W:
        tot += 1; rgb[row, c] = [255, 0, 0]
        if (gray[max(0,row-2):row+3, max(0,c-2):c+3] < 50).any(): hit += 1
rr = int(H-(ly-oy)/res); rc = int((lx-ox)/res)
if 0 <= rr < H and 0 <= rc < W: rgb[max(0,rr-2):rr+3, max(0,rc-2):rc+3] = [0,180,0]
out = BASE + '_amcl_scancheck.png'
Image.fromarray(rgb, 'RGB').resize((W*2, H*2), Image.NEAREST).save(out)
pct = 100*hit/max(tot,1)
print(f"scan-on-wall via AMCL transform: {hit}/{tot} = {pct:.0f}%")
print(f"overlay: {out}")
print("LOCALIZATION OK — AMCL scan-matching aligns to maze_truth after driving"
      if pct >= 85 else "LOCALIZATION SUSPECT — scans miss walls, AMCL may be off")
rclpy.shutdown()
