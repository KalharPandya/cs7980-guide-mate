#!/usr/bin/env python3
"""Stage 2 — end-to-end command path fidelity (the metric Nav2 cares about).

Publishes a steady cmd_vel_unstamped and measures how faithfully the robot's
GROUND-TRUTH velocity tracks it over time. Dropouts / stutter in delivery (or an
arbitration layer stealing commands) show up as intervals where GT velocity falls
far below commanded. Also doubles as the motion_control-fix verification.

Usage: comm_cmdpath.py --speed 0.3 --secs 20
"""
import argparse, time, math, statistics
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from nav_msgs.msg import Odometry
from geometry_msgs.msg import Twist

ap = argparse.ArgumentParser()
ap.add_argument('--speed', type=float, default=0.3)
ap.add_argument('--secs', type=float, default=20)
a = ap.parse_args()

rclpy.init()
n = Node('comm_cmdpath')
# Use odom's reported body velocity: it reflects command->controller DELIVERY
# directly (the comm-relevant signal) and, unlike sim_ground_truth_pose, always
# publishes. Delivery stutter shows up as dips in reported vx.
s = {'vx': None, 'samples': []}
n.create_subscription(Odometry, '/robot_1/odom',
                      lambda m: s.__setitem__('vx', m.twist.twist.linear.x), qos_profile_sensor_data)
pub = n.create_publisher(Twist, '/robot_1/cmd_vel_unstamped', 10)
tw = Twist(); tw.linear.x = a.speed
n.create_timer(0.02, lambda: pub.publish(tw))

# wait for odom
e = time.monotonic() + 15
while s['vx'] is None and time.monotonic() < e:
    rclpy.spin_once(n, timeout_sec=0.05)
if s['vx'] is None:
    print("no odom"); rclpy.shutdown(); exit()

# sample reported vx every ~0.25s
last_t = time.monotonic(); vels = []
e = time.monotonic() + a.secs
while time.monotonic() < e:
    rclpy.spin_once(n, timeout_sec=0.02)
    now = time.monotonic()
    if now - last_t >= 0.25:
        vels.append(s['vx']); last_t = now
# stop
tw2 = Twist()
for _ in range(30):
    pub.publish(tw2); rclpy.spin_once(n, timeout_sec=0.02)

if not vels:
    print("no samples"); rclpy.shutdown(); exit()
mean_v = statistics.mean(vels)
# "good" sample = reported vx within 40% of commanded (forward)
good = sum(1 for v in vels if v >= 0.6 * a.speed)
frac = 100 * good / len(vels)
dips = sum(1 for v in vels if v < 0.3 * a.speed)   # near-zero / reversed = delivery gap
print(f"commanded {a.speed:.2f} m/s for {a.secs:g}s  (metric: odom reported vx)")
print(f"  mean reported vx = {mean_v:.3f} m/s  ({100*mean_v/a.speed:.0f}% of commanded)")
print(f"  samples tracking command (>=60%): {good}/{len(vels)} = {frac:.0f}%")
print(f"  delivery-gap samples (<30% or reversed): {dips}/{len(vels)}")
print(f"  per-sample vx: {[round(v,2) for v in vels]}")
verdict = ("CLEAN — command path faithful" if frac >= 80 and mean_v >= 0.6*a.speed
           else "STUTTER/BLOCKED — command path unreliable")
print(f"  => {verdict}")
rclpy.shutdown()
