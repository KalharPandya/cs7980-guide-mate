#!/usr/bin/env python3
"""Stage 3 — sensor inflow health on a live sim topic.

Measures actual delivery rate, inter-arrival jitter, worst-case gap, and (via
header.stamp when present) sim-time staleness, for the topics AMCL/Nav2 consume.
No sequence numbers on sim topics, so "loss" is inferred as (expected-actual)/expected.

Usage: comm_probe.py --topic /robot_1/scan --type scan --expect 10 --secs 10
  types: scan | odom | tf | clock
"""
import argparse, time, statistics
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data, QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import Odometry
from tf2_msgs.msg import TFMessage
from rosgraph_msgs.msg import Clock

ap = argparse.ArgumentParser()
ap.add_argument('--topic', required=True)
ap.add_argument('--type', choices=['scan', 'odom', 'tf', 'clock'], required=True)
ap.add_argument('--expect', type=float, default=0, help='expected Hz (0=unknown)')
ap.add_argument('--secs', type=float, default=10)
a = ap.parse_args()

TYPES = {'scan': LaserScan, 'odom': Odometry, 'tf': TFMessage, 'clock': Clock}
rclpy.init()
n = Node('comm_probe')
arr = {'t': [], 'stamp': []}

def stamp_of(m):
    if a.type == 'clock':
        return m.clock.sec + m.clock.nanosec * 1e-9
    if a.type == 'tf':
        return (m.transforms[0].header.stamp.sec +
                m.transforms[0].header.stamp.nanosec * 1e-9) if m.transforms else None
    return m.header.stamp.sec + m.header.stamp.nanosec * 1e-9

def cb(m):
    arr['t'].append(time.monotonic())
    s = stamp_of(m)
    if s is not None:
        arr['stamp'].append(s)

qos = qos_profile_sensor_data if a.type != 'clock' else \
    QoSProfile(depth=10, reliability=QoSReliabilityPolicy.BEST_EFFORT)
n.create_subscription(TYPES[a.type], a.topic, cb, qos)

e = time.monotonic() + a.secs
while time.monotonic() < e:
    rclpy.spin_once(n, timeout_sec=0.002)

t = arr['t']
if len(t) < 2:
    print(f"{a.topic:<30s} : only {len(t)} msgs in {a.secs}s — DEAD or starved")
    rclpy.shutdown(); exit()
gaps = [t[i+1] - t[i] for i in range(len(t)-1)]
dur = t[-1] - t[0]
rate = (len(t) - 1) / dur
jit = statistics.pstdev(gaps) * 1000
worst = max(gaps) * 1000
loss = (100 * (1 - rate / a.expect)) if a.expect > 0 else float('nan')
line = (f"{a.topic:<30s} rate={rate:6.1f}Hz (exp {a.expect:g}) "
        f"jitter={jit:6.1f}ms worst_gap={worst:7.1f}ms")
if a.expect > 0:
    line += f" inferred_loss={loss:5.1f}%"
print(line)
rclpy.shutdown()
