#!/usr/bin/env python3
"""GuideMate — send one NavigateToPose goal and monitor it end-to-end.

Picks a goal ~GOAL_DIST m from the robot's current pose that is FREE on
maze_truth (checked against the map), sends it to /robot_1/navigate_to_pose,
streams distance-remaining feedback, and reports the final GT vs goal error.
Usage: send_goal.py [gx gy]   (explicit world goal, else auto-pick a free one)
"""
import sys, math, time, yaml, numpy as np
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from rclpy.qos import qos_profile_sensor_data
from nav_msgs.msg import Odometry
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose
from PIL import Image

BASE = '/home/baishibo123/robotics/maps/maze_truth'
y = yaml.safe_load(open(BASE + '.yaml'))
res = y['resolution']; ox, oy = y['origin'][0], y['origin'][1]
gray = np.array(Image.open(BASE + '.pgm').convert('L')); H, W = gray.shape

def free(wx, wy):
    """True if world point is free (light) on the map, with margin."""
    c = int((wx-ox)/res); r = int(H-(wy-oy)/res)
    if not (2 <= r < H-2 and 2 <= c < W-2): return False
    return bool((gray[r-4:r+5, c-4:c+5] > 250).all())  # 0.2m clear box

rclpy.init(); n = Node('send_goal')
s = {'g': None}
n.create_subscription(Odometry, '/robot_1/sim_ground_truth_pose',
                      lambda m: s.__setitem__('g', m.pose.pose), qos_profile_sensor_data)
e = time.monotonic()+10
while s['g'] is None and time.monotonic() < e: rclpy.spin_once(n, timeout_sec=0.05)
rx, ry = s['g'].position.x, s['g'].position.y
print(f"robot at ({rx:.2f},{ry:.2f})")

if len(sys.argv) >= 3:
    gx, gy = float(sys.argv[1]), float(sys.argv[2])
else:
    # auto-pick: scan rings/angles for a free point ~3m away
    gx = gy = None
    for dist in (3.0, 2.5, 2.0, 3.5, 1.5):
        for ang in range(0, 360, 15):
            a = math.radians(ang); cx, cy = rx+dist*math.cos(a), ry+dist*math.sin(a)
            if free(cx, cy): gx, gy = cx, cy; break
        if gx is not None: break
    if gx is None: print("no free goal found near robot"); rclpy.shutdown(); exit()
print(f"goal ({gx:.2f},{gy:.2f})  free_on_map={free(gx,gy)}  dist={math.hypot(gx-rx,gy-ry):.2f}m")

ac = ActionClient(n, NavigateToPose, '/robot_1/navigate_to_pose')
if not ac.wait_for_server(timeout_sec=15):
    print("navigate_to_pose action server not available"); rclpy.shutdown(); exit()

goal = NavigateToPose.Goal()
goal.pose.header.frame_id = 'map'
goal.pose.pose.position.x = gx; goal.pose.pose.position.y = gy
yaw = math.atan2(gy-ry, gx-rx)
goal.pose.pose.orientation.z = math.sin(yaw/2); goal.pose.pose.orientation.w = math.cos(yaw/2)

fb = {'last': None}
def on_fb(f): fb['last'] = f.feedback.distance_remaining
sgf = ac.send_goal_async(goal, feedback_callback=on_fb)
rclpy.spin_until_future_complete(n, sgf, timeout_sec=10)
gh = sgf.result()
if not gh or not gh.accepted:
    print("GOAL REJECTED"); rclpy.shutdown(); exit()
print("goal accepted — navigating...")
rf = gh.get_result_async()
t0 = time.monotonic(); last_print = 0
while not rf.done() and time.monotonic()-t0 < 180:
    rclpy.spin_once(n, timeout_sec=0.2)
    if time.monotonic()-last_print > 3 and fb['last'] is not None:
        g = s['g']
        print(f"  t={time.monotonic()-t0:5.0f}s  dist_remaining={fb['last']:.2f}m  "
              f"GT=({g.position.x:.2f},{g.position.y:.2f})")
        last_print = time.monotonic()
status = rf.result().status if rf.done() else None
g = s['g']; err = math.hypot(g.position.x-gx, g.position.y-gy)
# 4 = SUCCEEDED, 5 = CANCELED, 6 = ABORTED
names = {4: 'SUCCEEDED', 5: 'CANCELED', 6: 'ABORTED'}
print(f"RESULT: {names.get(status, status)}  final GT=({g.position.x:.2f},{g.position.y:.2f})  "
      f"error_to_goal={err:.2f}m")
rclpy.shutdown()
