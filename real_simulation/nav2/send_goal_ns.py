#!/usr/bin/env python3
"""GuideMate — send ONE NavigateToPose goal to a chosen robot (M1 sanity check).

Namespaced version of send_goal.py: pick the robot with --ns. Streams
distance-remaining feedback and reports the ground-truth-vs-goal error.

Usage:
  python3 send_goal_ns.py --ns robot_1            # auto-pick a free goal ~3 m away
  python3 send_goal_ns.py --ns robot_2 6.0 -5.0   # explicit world (map-frame) goal
"""
import os, sys, math, time, argparse, yaml, numpy as np
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from rclpy.qos import qos_profile_sensor_data
from nav_msgs.msg import Odometry
from nav2_msgs.action import NavigateToPose
from PIL import Image

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'maps', 'maze_truth')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ns', default='robot_1', help='robot namespace (robot_1|robot_2)')
    ap.add_argument('coords', nargs='*', type=float, help='optional explicit gx gy')
    args = ap.parse_args()
    ns = args.ns.strip('/')

    y = yaml.safe_load(open(BASE + '.yaml'))
    res = y['resolution']; ox, oy = y['origin'][0], y['origin'][1]
    gray = np.array(Image.open(BASE + '.pgm').convert('L')); H, W = gray.shape

    def free(wx, wy):
        c = int((wx - ox) / res); r = int(H - (wy - oy) / res)
        if not (2 <= r < H - 2 and 2 <= c < W - 2):
            return False
        return bool((gray[r - 4:r + 5, c - 4:c + 5] > 250).all())  # 0.2 m clear box

    rclpy.init(); n = Node('send_goal_ns')
    s = {'g': None}
    n.create_subscription(Odometry, f'/{ns}/sim_ground_truth_pose',
                          lambda m: s.__setitem__('g', m.pose.pose), qos_profile_sensor_data)
    e = time.monotonic() + 10
    while s['g'] is None and time.monotonic() < e:
        rclpy.spin_once(n, timeout_sec=0.05)
    if s['g'] is None:
        print(f"[{ns}] no ground-truth pose on /{ns}/sim_ground_truth_pose"); rclpy.shutdown(); return
    rx, ry = s['g'].position.x, s['g'].position.y
    print(f"[{ns}] robot at ({rx:.2f},{ry:.2f})")

    if len(args.coords) >= 2:
        gx, gy = args.coords[0], args.coords[1]
    else:
        gx = gy = None
        for dist in (3.0, 2.5, 2.0, 3.5, 1.5):
            for ang in range(0, 360, 15):
                a = math.radians(ang); cx, cy = rx + dist * math.cos(a), ry + dist * math.sin(a)
                if free(cx, cy):
                    gx, gy = cx, cy; break
            if gx is not None:
                break
        if gx is None:
            print(f"[{ns}] no free goal found near robot"); rclpy.shutdown(); return
    print(f"[{ns}] goal ({gx:.2f},{gy:.2f}) free_on_map={free(gx,gy)} dist={math.hypot(gx-rx,gy-ry):.2f}m")

    ac = ActionClient(n, NavigateToPose, f'/{ns}/navigate_to_pose')
    if not ac.wait_for_server(timeout_sec=15):
        print(f"[{ns}] navigate_to_pose action server not available"); rclpy.shutdown(); return

    goal = NavigateToPose.Goal()
    goal.pose.header.frame_id = 'map'
    goal.pose.pose.position.x = gx; goal.pose.pose.position.y = gy
    yaw = math.atan2(gy - ry, gx - rx)
    goal.pose.pose.orientation.z = math.sin(yaw / 2); goal.pose.pose.orientation.w = math.cos(yaw / 2)

    fb = {'d': None}
    gh_future = ac.send_goal_async(
        goal, feedback_callback=lambda f: fb.__setitem__('d', f.feedback.distance_remaining))
    rclpy.spin_until_future_complete(n, gh_future)
    gh = gh_future.result()
    if not gh.accepted:
        print(f"[{ns}] goal REJECTED"); rclpy.shutdown(); return
    print(f"[{ns}] goal accepted; navigating...")

    res_future = gh.get_result_async()
    last = time.monotonic()
    while not res_future.done():
        rclpy.spin_once(n, timeout_sec=0.1)
        if fb['d'] is not None and time.monotonic() - last > 1.0:
            print(f"[{ns}]   dist_remaining={fb['d']:.2f} m"); last = time.monotonic()

    status = res_future.result().status  # 4 = SUCCEEDED
    s2 = {'g': None}
    n.create_subscription(Odometry, f'/{ns}/sim_ground_truth_pose',
                          lambda m: s2.__setitem__('g', m.pose.pose), qos_profile_sensor_data)
    e = time.monotonic() + 3
    while s2['g'] is None and time.monotonic() < e:
        rclpy.spin_once(n, timeout_sec=0.05)
    if s2['g'] is not None:
        ex = math.hypot(s2['g'].position.x - gx, s2['g'].position.y - gy)
        print(f"[{ns}] RESULT status={status} ({'SUCCEEDED' if status==4 else 'not-succeeded'}), "
              f"final GT error={ex:.2f} m")
    else:
        print(f"[{ns}] RESULT status={status}")
    rclpy.shutdown()


if __name__ == '__main__':
    main()
